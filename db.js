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

// Helper: always send bigint-ish params as strings to pg
const big = (v) => (v == null ? null : String(v));

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
     on conflict (game_key) do update set ${set.join(
       ", "
     )}, updated_at=now()`,
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

async function recordActivity({ user, action, amount }) {
  await pool.query(
    `insert into activities (user_addr, action, amount)
     values ($1,$2,$3)`,
    [String(user), String(action), Number(amount)]
  );
  // keep app_users "active"
  await upsertAppUserLastActive(String(user));
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
  // total volume = sum of stakes (game_rounds + 2*coinflip stake per match)
  const vol1 = await pool.query(
    `select coalesce(sum(stake_lamports),0)::text as v from game_rounds`
  );
  const vol2 = await pool.query(
    `select coalesce(sum(bet_lamports)*2,0)::text as v from coinflip_matches`
  );

  // revenue ~ stakes - payouts
  const rev1 = await pool.query(
    `select (coalesce(sum(stake_lamports - payout_lamports),0))::text as v from game_rounds`
  );
  // coinflip: pot(2*bet) - payout (winner gets pot - fee)
  const rev2 = await pool.query(
    `select (coalesce(sum((bet_lamports*2) - payout_lamports),0))::text as v
     from coinflip_matches`
  );

  // today revenue
  const today1 = await pool.query(
    `select (coalesce(sum(stake_lamports - payout_lamports),0))::text as v
     from game_rounds where created_at::date = now()::date`
  );
  const today2 = await pool.query(
    `select (coalesce(sum((bet_lamports*2) - payout_lamports),0))::text as v
     from coinflip_matches where created_at::date = now()::date`
  );

  // users (distinct addresses)
  const users1 = await pool.query(
    `select count(distinct player) as c from game_rounds`
  );
  const users2 = await pool.query(
    `select count(distinct player_a) + count(distinct player_b) as c from coinflip_matches`
  );

  const totalVolume = BigInt(vol1.rows[0].v) + BigInt(vol2.rows[0].v);
  const totalRevenue = BigInt(rev1.rows[0].v) + BigInt(rev2.rows[0].v);
  const todayRevenue = BigInt(today1.rows[0].v) + BigInt(today2.rows[0].v);
  const totalUsers = Number(users1.rows[0].c) + Number(users2.rows[0].c);

  // last 10 activities
  const act = await pool.query(
    `select user_addr as "user", action, amount::text, to_char(created_at,'YYYY-MM-DD HH24:MI') as time
     from activities order by id desc limit 10`
  );

  return {
    stats: {
      totalUsers,
      totalVolume: totalVolume.toString(),
      totalRevenue: totalRevenue.toString(),
      todayRevenue: todayRevenue.toString(),
    },
    recentActivity: act.rows.map((r) => ({
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
  // username defaults to the address if not known
  await pool.query(
    `insert into app_users (user_id, username, last_active)
     values ($1,$1,now())
     on conflict (user_id) do update set last_active = now()`,
    [String(user_id)]
  );
}

async function listUsers({ page = 1, limit = 20, status = "all", search = "" } = {}) {
  const off = Math.max(0, (Number(page) - 1) * Number(limit));
  const where = [];
  const vals = [];

  if (status && status !== "all") {
    vals.push(status);
    where.push(`u.status = $${vals.length}`);
  }
  if (search) {
    vals.push(`%${search}%`);
    where.push(`(u.username ilike $${vals.length} or u.user_id ilike $${vals.length})`);
  }
  const whereSql = where.length ? `where ${where.join(" and ")}` : "";

  const baseSql = `
    from app_users u
    left join (
      select player, count(*) as bets, sum( (payout_lamports > bet_amount_lamports)::int ) as wins
      from bets group by player
    ) b on b.player = u.user_id
    left join (
      select player, count(*) as bets, sum( (payout_lamports > stake_lamports)::int ) as wins
      from game_rounds group by player
    ) gr on gr.player = u.user_id
    left join (
      select player, count(*) as bets, sum( (winner = player)::int ) as wins
      from (
        select player_a as player, winner from coinflip_matches
        union all
        select player_b as player, winner from coinflip_matches
      ) x group by player
    ) cf on cf.player = u.user_id
    ${whereSql}
  `;

  const countRes = await pool.query(`select count(*)::int as c from app_users u ${whereSql}`, vals);
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
      const winRate = totalBets > 0 ? Number(((totalWins / totalBets) * 100).toFixed(1)) : 0;
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

// -------------------- ADMIN TRANSACTIONS (union) --------------------
function _transactionsCte() {
  // source: 1=bets, 2=game_rounds, 3=coinflip_matches, 4=slots_spins
  return `
    with t as (
      -- DICE bets
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

      union all

      -- Generic game rounds (mines/plinko/crash/etc when saved there)
      select
        2,
        gr.id::bigint,
        gr.created_at,
        gr.player as wallet,
        gr.game_key as game,
        'round'::text,
        (gr.stake_lamports::numeric  / 1e9),
        (gr.payout_lamports::numeric / 1e9),
        'settled'::text
      from game_rounds gr

      union all

      -- Coinflip: single row per match -> attribute to winner
      select
        3,
        cf.id::bigint,
        cf.created_at,
        cf.winner as wallet,
        'coinflip'::text,
        'match'::text,
        ((cf.bet_lamports::numeric * 2) / 1e9) as amount,  -- pot
        (cf.payout_lamports::numeric / 1e9) as payout,
        'settled'::text
      from coinflip_matches cf

      union all

      -- Slots spins (already numeric SOL)
      select
        4,
        ss.id::bigint,
        ss.created_at,
        ss.player as wallet,
        'slots'::text as game,
        'spin'::text  as type,
        ss.bet_amount::numeric as amount,
        ss.payout::numeric     as payout,
        ss.status::text        as status
      from slots_spins ss
    )
  `;
}

/**
 * List admin transactions with pagination + filters
 */
async function listTransactions({ page=1, limit=20, type='all', status='all', game='all', search='' } = {}) {
  const off  = Math.max(0, (Number(page)-1) * Number(limit));
  const vals = [];
  const where = [];

  if (type && type !== 'all')   { vals.push(type);   where.push(`t.type = $${vals.length}`); }
  if (status && status !== 'all'){ vals.push(status); where.push(`t.status = $${vals.length}`); }
  if (game && game !== 'all')   { vals.push(game);   where.push(`t.game = $${vals.length}`); }
  if (search) {
    vals.push(`%${search}%`);
    where.push(`(u.username ilike $${vals.length} or t.wallet ilike $${vals.length})`);
  }
  const whereSql = where.length ? `where ${where.join(' and ')}` : '';

  const base = `
    ${_transactionsCte()}
    select
      ((t.source::bigint * 1000000000::bigint) + t.real_id)::bigint as id,
      coalesce(u.username, t.wallet) as username,
      t.wallet as "walletAddress",
      t.type,
      t.game,
      t.amount::float8  as amount,
      'SOL'::text       as currency,
      t.status,
      to_char(t.created_at,'YYYY-MM-DD"T"HH24:MI:SS"Z"') as "timestamp",
      t.payout::float8  as payout
    from t
    left join app_users u on u.user_id = t.wallet
    ${whereSql}
  `;

  // total
  const cntRes = await pool.query(
    `${_transactionsCte()} select count(*)::int as c from t left join app_users u on u.user_id=t.wallet ${whereSql}`,
    vals
  );
  const total = Number(cntRes.rows[0]?.c || 0);

  // page
  const rows = await pool.query(
    `${base} order by t.created_at desc limit $${vals.length+1} offset $${vals.length+2}`,
    vals.concat([ Number(limit), off ])
  );

  return {
    transactions: rows.rows.map(r => ({
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
 * Stats summary for admin transactions
 */
async function getTransactionStats() {
  const rows = await pool.query(
    `
    ${_transactionsCte()}
    select
      count(*)::int                             as total,
      sum(t.amount)::float8                     as volume_sol,
      sum(t.payout)::float8                     as payouts_sol,
      (coalesce(sum(t.amount - t.payout),0))::float8 as net_revenue_sol
    from t
    `
  );
  const r = rows.rows[0] || {};
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
  const source  = Number(bigId / 1000000000n);
  const real_id = Number(bigId % 1000000000n);

  if (!['string','number'].includes(typeof newStatus) || String(newStatus).length === 0) {
    throw new Error('invalid status');
  }

  let table = null;
  if (source === 1) table = 'bets';
  else if (source === 4) table = 'slots_spins';
  else throw new Error('Status update not supported for this transaction type');

  const q = await pool.query(
    `update ${table} set status=$1 where id=$2`,
    [ String(newStatus), Number(real_id) ]
  );
  if (q.rowCount === 0) throw new Error('Transaction not found');
  return { ok: true };
}

module.exports = {
  pool,
  ensureSchema,
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

  // admin transactions
  listTransactions,
  getTransactionStats,
  updateTransactionStatusComposite,
};
