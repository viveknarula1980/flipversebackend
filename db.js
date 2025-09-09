// db.js
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : undefined,
});

// -------------------- bootstrap --------------------
async function ensureSchema() {
  const fs = require("fs");
  const path = require("path");
  const sql = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  await pool.query(sql);
}

// Extend existing tables to carry SOL and USD-at-time info where useful
async function ensureAccountingExtensions() {
  // helper to add a column if missing
  async function ensureColumn(table, column, typeSql) {
    await pool.query(
      `
      do $$
      begin
        if not exists (
          select 1 from information_schema.columns
          where table_schema = 'public' and table_name = $1 and column_name = $2
        ) then
          execute format('alter table public.%I add column %I ${typeSql}', $1, $2);
        end if;
      end$$;
    `,
      [table, column]
    );
  }

  // deposits: add amount_sol, usd_at_tx, price_usd_per_sol (if not present)
  const hasDeposits = await tableExists("deposits");
  if (hasDeposits) {
    await ensureColumn("deposits", "amount_sol", "double precision");
    await ensureColumn("deposits", "usd_at_tx", "double precision");
    await ensureColumn("deposits", "price_usd_per_sol", "double precision");
  }

  // activities: add amount_usd, price_usd_per_sol (optional)
  const hasAct = await tableExists("activities");
  if (hasAct) {
    await ensureColumn("activities", "amount_usd", "double precision");
    await ensureColumn("activities", "price_usd_per_sol", "double precision");
  }
}

// Helper: always send bigint-ish params as strings to pg
const big = (v) => (v == null ? null : String(v));

// Small helper to check if a relation exists (schema-qualified or not)
async function tableExists(name) {
  const { rows } = await pool.query(`select to_regclass($1) as r`, [
    name.includes(".") ? name : `public.${name}`,
  ]);
  return !!rows[0]?.r;
}

// intentionally exported (used by server metrics)
async function _tableExistsUnsafe(name) {
  return tableExists(name);
}

// -------------------- rules (global RTP/min/max fallback) --------------------
async function getRules() {
  const { rows } = await pool.query(
    "select * from game_rules order by id desc limit 1"
  );
  return (
    rows[0] || {
      rtp_bps: 9900,
      min_bet_lamports: 50000,
      max_bet_lamports: 5_000_000_000,
    }
  );
}

// -------------------- game configs --------------------
async function listGameConfigs() {
  const { rows } = await pool.query(
    `select game_key, enabled, running, fee_bps, rtp_bps, min_bet_lamports, max_bet_lamports
     from game_configs order by game_key asc`
  );
  return rows;
}

async function getGameConfig(game_key) {
  const { rows } = await pool.query(
    `select game_key, enabled, running, fee_bps, rtp_bps, min_bet_lamports, max_bet_lamports
     from game_configs where game_key=$1 limit 1`,
    [game_key]
  );
  if (rows[0]) return rows[0];

  // fallback to rules for min/max/rtp; defaults enabled/running
  const r = await getRules();
  return {
    game_key,
    enabled: true,
    running: true,
    fee_bps: 0,
    rtp_bps: r?.rtp_bps ?? 9900,
    min_bet_lamports: r?.min_bet_lamports ?? 50000,
    max_bet_lamports: r?.max_bet_lamports ?? 5_000_000_000,
  };
}

function pctToBps(x) {
  const n = Math.max(0, Math.min(100, Number(x)));
  return Math.round(n * 100);
}

async function upsertGameConfig(game_key, patch = {}) {
  // accept both snake_case and camelCase from the frontend
  const normalized = {
    enabled: typeof patch.enabled === "boolean" ? patch.enabled : undefined,
    running: typeof patch.running === "boolean" ? patch.running : undefined,
    fee_bps: patch.fee_bps ?? patch.feeBps,
    rtp_bps: patch.rtp_bps ?? patch.rtpBps,
    min_bet_lamports: patch.min_bet_lamports ?? patch.minBetLamports,
    max_bet_lamports: patch.max_bet_lamports ?? patch.maxBetLamports,
  };

  // Derive from houseEdge if given
  const he =
    patch.houseEdgePct ??
    patch.house_edge_pct ??
    patch.houseEdge ??
    patch.house_edge ??
    undefined;

  if (he != null && he !== "") {
    const fee = pctToBps(he);
    const rtp = Math.max(0, 10000 - fee);
    normalized.fee_bps = fee;
    normalized.rtp_bps = rtp;
  }

  Object.keys(normalized).forEach(
    (k) => normalized[k] === undefined && delete normalized[k]
  );

  if (Object.keys(normalized).length === 0) {
    return getGameConfig(game_key);
  }

  const set = [];
  const vals = [game_key];
  let i = 1;
  for (const [k, v] of Object.entries(normalized)) {
    set.push(`${k}=$${++i}`);
    vals.push(v);
  }

  await pool.query(
    `insert into game_configs (game_key) values ($1)
     on conflict (game_key) do update set ${set.join(", ")}, updated_at=now()`,
    vals
  );
  return getGameConfig(game_key);
}

// -------------------- generic rounds & activities --------------------
async function recordGameRound({
  game_key,
  player,
  nonce,
  stake_lamports,
  payout_lamports,
  result_json,
}) {
  await pool.query(
    `insert into game_rounds (game_key, player, nonce, stake_lamports, payout_lamports, result_json)
     values ($1,$2,$3,$4,$5,$6)`,
    [
      String(game_key),
      String(player),
      big(nonce),
      big(stake_lamports || 0),
      big(payout_lamports || 0),
      result_json ? JSON.stringify(result_json) : JSON.stringify({}),
    ]
  );
  // keep app_users "active"
  await upsertAppUserLastActive(String(player));
}

/**
 * Record activity; amount is in SOL by convention.
 * Optionally carries amount_usd and price_usd_per_sol (columns added by ensureAccountingExtensions()).
 */
async function recordActivity({
  user,
  action,
  amount,
  amount_usd = null,
  price_usd_per_sol = null,
}) {
  // ensure optional columns exist (best effort, no throw)
  try {
    if (ensureAccountingExtensions) await ensureAccountingExtensions();
  } catch {}

  // figure out whether the optional columns exist
  const hasActUsd = await _hasActivityUsdCols();

  if (hasActUsd) {
    await pool.query(
      `insert into activities (user_addr, action, amount, amount_usd, price_usd_per_sol)
       values ($1,$2,$3,$4,$5)`,
      [
        String(user),
        String(action),
        Number(amount),
        amount_usd != null ? Number(amount_usd) : null,
        price_usd_per_sol != null ? Number(price_usd_per_sol) : null,
      ]
    );
  } else {
    await pool.query(
      `insert into activities (user_addr, action, amount)
       values ($1,$2,$3)`,
      [String(user), String(action), Number(amount)]
    );
  }

  // keep app_users "active"
  await upsertAppUserLastActive(String(user));
}

// memoize optional cols check
let _actColsChecked = false;
let _actHasUsdCols = false;
async function _hasActivityUsdCols() {
  if (_actColsChecked) return _actHasUsdCols;
  const { rows } = await pool.query(
    `select column_name from information_schema.columns where table_schema='public' and table_name='activities'`
  );
  const cols = rows.map((r) => r.column_name);
  _actHasUsdCols = cols.includes("amount_usd") && cols.includes("price_usd_per_sol");
  _actColsChecked = true;
  return _actHasUsdCols;
}

// -------------------- coinflip match detail --------------------
async function recordCoinflipMatch(row) {
  await pool.query(
    `insert into coinflip_matches
     (nonce, player_a, player_b, side_a, side_b, bet_lamports, outcome, winner, payout_lamports, fee_bps)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     on conflict (nonce) do nothing`,
    [
      big(row.nonce),
      row.player_a,
      row.player_b,
      Number(row.side_a),
      Number(row.side_b),
      big(row.bet_lamports),
      Number(row.outcome),
      row.winner,
      big(row.payout_lamports || 0),
      Number(row.fee_bps || 0),
    ]
  );
  await upsertAppUserLastActive(String(row.player_a));
  if (row.player_b) await upsertAppUserLastActive(String(row.player_b));
}

// -------------------- bets table helpers (dice) --------------------
async function recordBet(b) {
  await pool.query(
    `insert into bets(
       player, bet_amount_lamports, bet_type, target, roll, payout_lamports,
       nonce, expiry_unix, signature_base58, status
     )
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      b.player,
      big(b.amount),
      Number(b.betType),
      Number(b.target),
      Number(b.roll || 0),
      big(b.payout || 0),
      big(b.nonce),
      big(b.expiry),
      b.signature_base58 || "",
      b.status || "prepared_lock",
    ]
  );
  await upsertAppUserLastActive(String(b.player));
}
async function getBetByNonce(nonce) {
  const { rows } = await pool.query(
    `select * from bets where nonce = $1 order by id desc limit 1`,
    [big(nonce)]
  );
  return rows[0] || null;
}
async function updateBetPrepared({ nonce, roll, payout }) {
  await pool.query(
    `update bets
       set roll = $2,
           payout_lamports = $3,
           status = 'prepared_resolve'
     where nonce = $1`,
    [big(nonce), Number(roll), big(payout)]
  );
}

// -------------------- admin stats --------------------
async function getAdminStats() {
  // tolerate missing tables
  const hasGR = await tableExists("game_rounds");
  const hasCF = await tableExists("coinflip_matches");

  // total volume = sum of stakes (game_rounds + 2*coinflip stake per match)
  const vol1 = hasGR
    ? (
        await pool.query(
          `select coalesce(sum(stake_lamports),0)::text as v from game_rounds`
        )
      ).rows[0].v
    : "0";
  const vol2 = hasCF
    ? (
        await pool.query(
          `select coalesce(sum(bet_lamports)*2,0)::text as v from coinflip_matches`
        )
      ).rows[0].v
    : "0";

  // revenue ~ stakes - payouts
  const rev1 = hasGR
    ? (
        await pool.query(
          `select coalesce(sum(stake_lamports - payout_lamports),0)::text as v from game_rounds`
        )
      ).rows[0].v
    : "0";
  const rev2 = hasCF
    ? (
        await pool.query(
          `select coalesce(sum((bet_lamports*2) - payout_lamports),0)::text as v from coinflip_matches`
        )
      ).rows[0].v
    : "0";

  // today revenue
  const today1 = hasGR
    ? (
        await pool.query(
          `select coalesce(sum(stake_lamports - payout_lamports),0)::text as v
           from game_rounds where created_at::date = now()::date`
        )
      ).rows[0].v
    : "0";
  const today2 = hasCF
    ? (
        await pool.query(
          `select coalesce(sum((bet_lamports*2) - payout_lamports),0)::text as v
           from coinflip_matches where created_at::date = now()::date`
        )
      ).rows[0].v
    : "0";

  const totalVolume = BigInt(vol1) + BigInt(vol2);
  const totalRevenue = BigInt(rev1) + BigInt(rev2);
  const todayRevenue = BigInt(today1) + BigInt(today2);

  // users (distinct addresses)
  const users1 = hasGR
    ? Number(
        (
          await pool.query(
            `select count(distinct player) as c from game_rounds`
          )
        ).rows[0].c
      )
    : 0;
  const users2 = hasCF
    ? Number(
        (
          await pool.query(
            `select count(distinct player_a) + count(distinct player_b) as c from coinflip_matches`
          )
        ).rows[0].c
      )
    : 0;

  const totalUsers = users1 + users2;

  // last 10 activities (optional table)
  const hasAct = await tableExists("activities");
  const actRows = hasAct
    ? (
        await pool.query(
          `select user_addr as "user", action, amount::text, to_char(created_at,'YYYY-MM-DD HH24:MI') as time
           from activities order by id desc limit 10`
        )
      ).rows
    : [];

  return {
    stats: {
      totalUsers,
      totalVolume: totalVolume.toString(),
      totalRevenue: totalRevenue.toString(),
      todayRevenue: todayRevenue.toString(),
    },
    recentActivity: actRows.map((r) => ({
      user: r.user,
      action: r.action,
      amount: r.amount,
      time: r.time,
    })),
  };
}

// (optional) plinko rules passthrough (single rtp_bps)
async function getPlinkoRules(/* rows, diff */) {
  const r = await getRules();
  return { rtp_bps: r?.rtp_bps ?? 9400 };
}

// -------------------- USERS: helpers for Admin --------------------
async function upsertAppUserLastActive(user_id) {
  const hasUsers = await tableExists("app_users");
  if (!hasUsers) return; // silently ignore if table missing
  // username defaults to the address if not known
  await pool.query(
    `insert into app_users (user_id, username, last_active)
     values ($1,$1,now())
     on conflict (user_id) do update set last_active = now()`,
    [String(user_id)]
  );
}

/**
 * Keep app_users.pda_balance in sync (lamports).
 * Creates the user row if it does not exist.
 */
async function updatePdaBalance(user_id, pda_balance_lamports) {
  const hasUsers = await tableExists("app_users");
  if (!hasUsers) return;
  await pool.query(
    `insert into app_users (user_id, username, pda_balance, last_active)
     values ($1,$1,$2,now())
     on conflict (user_id) do update set
       pda_balance = excluded.pda_balance,
       last_active = now()`,
    [String(user_id), Number(pda_balance_lamports)]
  );
}

async function listUsers({
  page = 1,
  limit = 20,
  status = "all",
  search = "",
} = {}) {
  const hasUsers = await tableExists("app_users");
  if (!hasUsers) {
    return { users: [], total: 0, pages: 1 };
  }

  const off = Math.max(0, (Number(page) - 1) * Number(limit));
  const where = [];
  const vals = [];

  if (status && status !== "all") {
    vals.push(status);
    where.push(`u.status = $${vals.length}`);
  }
  if (search) {
    vals.push(`%${search}%`);
    where.push(
      `(u.username ilike $${vals.length} or u.user_id ilike $${vals.length})`
    );
  }
  const whereSql = where.length ? `where ${where.join(" and ")}` : "";

  // check optional tables referenced in joins
  const hasBets = await tableExists("bets");
  const hasGR = await tableExists("game_rounds");
  const hasCF = await tableExists("coinflip_matches");

  const bJoin = hasBets
    ? `left join (select player, count(*) as bets, sum( (payout_lamports > bet_amount_lamports)::int ) as wins from bets group by player) b on b.player = u.user_id`
    : `left join (select ''::text as player, 0::int as bets, 0::int as wins) b on false`;

  const grJoin = hasGR
    ? `left join (select player, count(*) as bets, sum( (payout_lamports > stake_lamports)::int ) as wins from game_rounds group by player) gr on gr.player = u.user_id`
    : `left join (select ''::text as player, 0::int as bets, 0::int as wins) gr on false`;

  const cfJoin = hasCF
    ? `left join (select player, count(*) as bets, sum( (winner = player)::int ) as wins
                 from (select player_a as player, winner from coinflip_matches
                       union all
                       select player_b as player, winner from coinflip_matches) x
                 group by player) cf on cf.player = u.user_id`
    : `left join (select ''::text as player, 0::int as bets, 0::int as wins) cf on false`;

  const baseSql = `
    from app_users u
    ${bJoin}
    ${grJoin}
    ${cfJoin}
    ${whereSql}
  `;

  const countRes = await pool.query(
    `select count(*)::int as c from app_users u ${whereSql}`,
    vals
  );
  const total = Number(countRes.rows[0]?.c || 0);

  const rows = await pool.query(
    `
    select
      u.user_id, u.username, u.status, u.pda_balance, u.favorite_game,
      u.joined_at, u.last_active,
      coalesce(b.bets,0) + coalesce(gr.bets,0) + coalesce(cf.bets,0) as total_bets,
      coalesce(b.wins,0) + coalesce(gr.wins,0) + coalesce(cf.wins,0) as total_wins
    ${baseSql}
    order by u.last_active desc
    limit $${vals.length + 1} offset $${vals.length + 2}
    `,
    vals.concat([Number(limit), off])
  );

  return {
    users: rows.rows.map((r) => {
      const totalBets = Number(r.total_bets || 0);
      const totalWins = Number(r.total_wins || 0);
      const totalLosses = Math.max(0, totalBets - totalWins);
      const winRate =
        totalBets > 0
          ? Number(((totalWins / totalBets) * 100).toFixed(1))
          : 0;
      return {
        id: r.user_id,
        username: r.username,
        walletAddress: r.user_id,
        pdaBalance: Number(r.pda_balance || 0),
        status: r.status,
        joinedAt: r.joined_at,
        lastActive: r.last_active,
        totalBets,
        totalWins,
        totalLosses,
        winRate,
        favoriteGame: r.favorite_game || null,
      };
    }),
    total,
    pages: Math.max(1, Math.ceil(total / Number(limit))),
  };
}

async function getUserDetails(user_id) {
  const out = await listUsers({ page: 1, limit: 1, search: user_id, status: "all" });
  const u = out.users.find((x) => x.id === user_id) || null;
  return u;
}

async function updateUserStatus(user_id, status) {
  const hasUsers = await tableExists("app_users");
  if (!hasUsers) throw new Error("users table missing");
  if (!["active", "disabled", "banned"].includes(String(status))) {
    throw new Error("invalid status");
  }
  const { rowCount } = await pool.query(
    `update app_users set status=$2 where user_id=$1`,
    [String(user_id), String(status)]
  );
  if (rowCount === 0) {
    // create if missing
    await pool.query(
      `insert into app_users(user_id, username, status) values ($1,$1,$2)
       on conflict (user_id) do update set status=excluded.status`,
      [String(user_id), String(status)]
    );
  }
  return getUserDetails(String(user_id));
}

async function listUserActivities(user_id, limit = 50) {
  const hasAct = await tableExists("activities");
  if (!hasAct) return [];
  const { rows } = await pool.query(
    `select action, amount::text, created_at
     from activities
     where user_addr=$1
     order by id desc
     limit $2`,
    [String(user_id), Number(limit)]
  );
  // Map to your frontend's UserActivity
  return rows.map((r, i) => ({
    id: String(i + 1),
    userId: String(user_id),
    type: mapActionToType(r.action),
    game: extractGameFromAction(r.action),
    amount: Number(r.amount || 0),
    timestamp: r.created_at,
    details: r.action,
  }));
}

function mapActionToType(action) {
  const a = String(action || "").toLowerCase();
  if (a.includes("deposit")) return "deposit";
  if (a.includes("withdraw")) return "withdrawal";
  if (a.includes("win")) return "win";
  if (a.includes("loss") || a.includes("lose")) return "loss";
  if (a.includes("bet") || a.includes("play")) return "bet";
  return "login";
}
function extractGameFromAction(action) {
  const a = String(action || "").toLowerCase();
  if (a.includes("coinflip")) return "coinflip";
  if (a.includes("dice")) return "dice";
  if (a.includes("slots")) return "slots";
  if (a.includes("plinko")) return "plinko";
  if (a.includes("crash")) return "crash";
  if (a.includes("mines")) return "mines";
  return undefined;
}

// Quick checks for bans
async function isUserBanned(user_id) {
  if (!(await tableExists("app_users"))) return false;
  const { rows } = await pool.query(
    `select status from app_users where user_id=$1 limit 1`,
    [String(user_id)]
  );
  return (rows[0]?.status || "active") === "banned";
}
async function assertUserPlayable(user_id) {
  if (await isUserBanned(user_id)) throw new Error("User is banned");
  return true;
}

// -------------------- ADMIN TRANSACTIONS (dynamic union) --------------------
async function _transactionsCteDynamic() {
  // Build only from tables that exist to avoid 500s
  const pieces = [];

  if (await tableExists("bets")) {
    pieces.push(`
      select
        1 as source,
        b.id::bigint as real_id,
        b.created_at,
        b.player as wallet,
        'dice'::text as game,
        'bet'::text  as type,
        (b.bet_amount_lamports::numeric / 1e9) as amount,
        (b.payout_lamports::numeric   / 1e9) as payout,
        b.status::text as status
      from bets b
    `);
  }
  if (await tableExists("game_rounds")) {
    pieces.push(`
      select
        2 as source,
        gr.id::bigint as real_id,
        gr.created_at,
        gr.player as wallet,
        gr.game_key as game,
        'round'::text as type,
        (gr.stake_lamports::numeric  / 1e9) as amount,
        (gr.payout_lamports::numeric / 1e9) as payout,
        'settled'::text as status
      from game_rounds gr
    `);
  }
  if (await tableExists("coinflip_matches")) {
    pieces.push(`
      select
        3 as source,
        cf.id::bigint as real_id,
        cf.created_at,
        cf.winner as wallet,
        'coinflip'::text as game,
        'match'::text as type,
        ((cf.bet_lamports::numeric * 2) / 1e9) as amount,
        (cf.payout_lamports::numeric / 1e9) as payout,
        'settled'::text as status
      from coinflip_matches cf
    `);
  }
  if (await tableExists("slots_spins")) {
    pieces.push(`
      select
        4 as source,
        ss.id::bigint as real_id,
        ss.created_at,
        ss.player as wallet,
        'slots'::text as game,
        'spin'::text  as type,
        ss.bet_amount::numeric as amount,
        ss.payout::numeric     as payout,
        ss.status::text        as status
      from slots_spins ss
    `);
  }

  if (pieces.length === 0) {
    // Empty CTE that returns no rows but correct column types
    return `
      with t as (
        select
          0::int as source,
          0::bigint as real_id,
          now() as created_at,
          ''::text as wallet,
          ''::text as game,
          ''::text as type,
          0::numeric as amount,
          0::numeric as payout,
          'n/a'::text as status
        where false
      )
    `;
  }

  return `with t as (\n${pieces.join("\nunion all\n")}\n)`;
}

/**
 * List admin transactions with pagination + filters
 */
async function listTransactions({
  page = 1,
  limit = 20,
  type = "all",
  status = "all",
  game = "all",
  search = "",
} = {}) {
  const off = Math.max(0, (Number(page) - 1) * Number(limit));
  const vals = [];
  const where = [];

  if (type && type !== "all") {
    vals.push(type);
    where.push(`t.type = $${vals.length}`);
  }
  if (status && status !== "all") {
    vals.push(status);
    where.push(`t.status = $${vals.length}`);
  }
  if (game && game !== "all") {
    vals.push(game);
    where.push(`t.game = $${vals.length}`);
  }
  const hasUsers = await tableExists("app_users");
  if (search) {
    vals.push(`%${search}%`);
    if (hasUsers) {
      where.push(
        `(u.username ilike $${vals.length} or t.wallet ilike $${vals.length})`
      );
    } else {
      where.push(`(t.wallet ilike $${vals.length})`);
    }
  }
  const whereSql = where.length ? `where ${where.join(" and ")}` : "";

  const cte = await _transactionsCteDynamic();
  const joinUsers = hasUsers
    ? `left join app_users u on u.user_id = t.wallet`
    : `left join (select null) u on false`;

  const base = `
    ${cte}
    select
      ((t.source::bigint * 1000000000::bigint) + t.real_id)::bigint as id,
      ${hasUsers ? "coalesce(u.username, t.wallet)" : "t.wallet"} as username,
      t.wallet as "walletAddress",
      t.type,
      t.game,
      t.amount::float8  as amount,
      'SOL'::text       as currency,
      t.status,
      to_char(t.created_at,'YYYY-MM-DD"T"HH24:MI:SS"Z"') as "timestamp",
      t.payout::float8  as payout
    from t
    ${joinUsers}
    ${whereSql}
  `;
  // total
  const cntRes = await pool.query(
    `${cte} select count(*)::int as c from t ${joinUsers} ${whereSql}`,
    vals
  );
  const total = Number(cntRes.rows[0]?.c || 0);

  // page
  const rows = await pool.query(
    `${base} order by t.created_at desc limit $${vals.length + 1} offset $${vals.length + 2}`,
    vals.concat([Number(limit), off])
  );

  return {
    transactions: rows.rows.map((r) => ({
      id: Number(r.id),
      username: r.username,
      walletAddress: r.walletAddress,
      type: r.type,
      game: r.game,
      amount: Number(r.amount || 0),
      currency: r.currency,
      status: r.status,
      timestamp: r.timestamp,
      payout: Number(r.payout || 0),
    })),
    total,
    pages: Math.max(1, Math.ceil(total / Number(limit))),
  };
}

/**
 * Stats summary for admin transactions (dynamic)
 */
async function getTransactionStats() {
  const cte = await _transactionsCteDynamic();
  const { rows } = await pool.query(
    `
    ${cte}
    select
      count(*)::int                             as total,
      coalesce(sum(t.amount),0)::float8         as volume_sol,
      coalesce(sum(t.payout),0)::float8         as payouts_sol,
      coalesce(sum(t.amount - t.payout),0)::float8 as net_revenue_sol
    from t
    `
  );
  const r = rows[0] || {};
  return {
    total: Number(r.total || 0),
    volumeSol: Number(r.volume_sol || 0),
    payoutsSol: Number(r.payouts_sol || 0),
    netRevenueSol: Number(r.net_revenue_sol || 0),
  };
}

/**
 * Update status by composite id (only applies to sources that have a status column)
 */
async function updateTransactionStatusComposite(compositeId, newStatus) {
  const bigId = BigInt(compositeId);
  const source = Number(bigId / 1000000000n);
  const real_id = Number(bigId % 1000000000n);

  if (
    !["string", "number"].includes(typeof newStatus) ||
    String(newStatus).length === 0
  ) {
    throw new Error("invalid status");
  }

  if (source === 1) {
    if (!(await tableExists("bets"))) throw new Error("bets table missing");
    const q = await pool.query(`update bets set status=$1 where id=$2`, [
      String(newStatus),
      Number(real_id),
    ]);
    if (q.rowCount === 0) throw new Error("Transaction not found");
    return { ok: true };
  }
  if (source === 4) {
    if (!(await tableExists("slots_spins")))
      throw new Error("slots_spins table missing");
    const q = await pool.query(`update slots_spins set status=$1 where id=$2`, [
      String(newStatus),
      Number(real_id),
    ]);
    if (q.rowCount === 0) throw new Error("Transaction not found");
    return { ok: true };
  }
  throw new Error("Status update not supported for this transaction type");
}

/**
 * Insert a deposit row.
 * Accepts lamports and optional SOL/USD details.
 */
async function recordDeposit({
  user_wallet,
  amount_lamports,
  tx_sig = null,
  amount_sol = null,
  usd_at_tx = null,
  price_usd_per_sol = null,
}) {
  try {
    if (ensureAccountingExtensions) await ensureAccountingExtensions();
  } catch {}

  const sol =
    amount_sol == null
      ? Number(amount_lamports || 0) / 1e9
      : Number(amount_sol || 0);

  await pool.query(
    `insert into deposits (user_wallet, amount_lamports, amount_sol, usd_at_tx, price_usd_per_sol, tx_sig)
     values ($1,$2,$3,$4,$5,$6)`,
    [
      String(user_wallet),
      big(amount_lamports || 0),
      Number(sol || 0),
      usd_at_tx == null ? null : Number(usd_at_tx),
      price_usd_per_sol == null ? null : Number(price_usd_per_sol),
      tx_sig == null ? null : String(tx_sig),
    ]
  );
  // keep app_users active
  await upsertAppUserLastActive(String(user_wallet));
  return { ok: true };
}

/**
 * Annotate a deposit row (matched by tx_sig) with SOL + USD information.
 * If no row matches (e.g., API insert didn't happen), we insert a new row.
 */
async function annotateDepositBySig({
  tx_sig,
  user_wallet,
  amount_lamports,
  amount_sol,
  usd_at_tx,
  price_usd_per_sol,
}) {
  // ensure columns exist (best effort)
  try {
    if (ensureAccountingExtensions) await ensureAccountingExtensions();
  } catch {}

  // Try to update by tx_sig first
  const upd = await pool.query(
    `update deposits
       set amount_sol = $2,
           usd_at_tx = $3,
           price_usd_per_sol = $4
     where tx_sig = $1`,
    [
      String(tx_sig || ""),
      Number(amount_sol || 0),
      Number(usd_at_tx || 0),
      Number(price_usd_per_sol || 0),
    ]
  );

  if (upd.rowCount > 0) return { ok: true, updated: true };

  // If no row updated, insert (fallback)
  await pool.query(
    `insert into deposits (user_wallet, amount_lamports, amount_sol, usd_at_tx, price_usd_per_sol, tx_sig)
     values ($1,$2,$3,$4,$5,$6)`,
    [
      String(user_wallet),
      big(amount_lamports || 0),
      Number(amount_sol || 0),
      Number(usd_at_tx || 0),
      Number(price_usd_per_sol || 0),
      String(tx_sig || ""),
    ]
  );
  // keep app_users active
  await upsertAppUserLastActive(String(user_wallet));
  return { ok: true, inserted: true };
}

module.exports = {
  pool,
  ensureSchema,
  ensureAccountingExtensions,
  getRules,

  listGameConfigs,
  getGameConfig,
  upsertGameConfig,

  recordGameRound,
  recordActivity,
  recordCoinflipMatch,

  recordBet,
  getBetByNonce,
  updateBetPrepared,

  getAdminStats,
  getPlinkoRules,

  // users
  listUsers,
  getUserDetails,
  updateUserStatus,
  listUserActivities,
  upsertAppUserLastActive,
  updatePdaBalance,

  // bans
  isUserBanned,
  assertUserPlayable,

  // admin transactions
  listTransactions,
  getTransactionStats,
  updateTransactionStatusComposite,

  // deposits
  recordDeposit,
  annotateDepositBySig,

  // internal
  _tableExistsUnsafe,
  tableExists,
};
