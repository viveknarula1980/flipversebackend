// server/rewards_router.js
const express = require("express");
const router = express.Router();
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const db = require("./db");

/* ------------ config ------------ */
const USD_PER_SOL = Number(process.env.USD_PER_SOL || 200);

/* ------------ utils ------------ */
const toBool = (x) => !!(x === true || x === "true" || x === 1 || x === "1");

/**
 * Ranges: keep ids as-is (db pk)
 */
function rowRangeToApi(r) {
  return {
    id: r.id,
    name: r.name,
    quote: r.quote,
    image: r.image || null,
    isActive: !!r.is_active,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

/**
 * Levels: expose sequential id = level_number for display,
 * and also expose row_id = real db pk for actions.
 */
function rowLevelToApi(l, withRange = false) {
  const base = {
    id: l.level_number, // display id is the sequential level number
    row_id: l.id, // real db primary key
    range_id: l.range_id,
    level_number: l.level_number,
    title: l.title,
    reward: l.reward,
    wagering: l.wagering,
    bonus: l.bonus,
    isActive: !!l.is_active,
    created_at: l.created_at,
    updated_at: l.updated_at,
    total_claimed: Number(l.total_claimed || 0),
    total_users: Number(l.total_users || 0),
  };
  if (withRange) {
    base.range = l.range_id
      ? {
          id: l.range_id,
          name: l.range_name,
          quote: l.range_quote,
          image: l.range_image,
          isActive: !!l.range_is_active,
          created_at: l.range_created_at,
          updated_at: l.range_updated_at,
        }
      : null;
  }
  return base;
}

/**
 * Accept either a DB id or a level_number and return the real DB id.
 * Returns null if nothing matches.
 */
async function resolveLevelPk(idOrNumber) {
  const n = Number(idOrNumber);
  if (!Number.isFinite(n)) return null;
  const { rows } = await db.pool.query(`select id from levels where id = $1 or level_number = $1 limit 1`, [n]);
  return rows[0]?.id ?? null;
}

// "$" requirement like "$1K", "$150.50", "1,200", "20000x1"
function parseUsdFromDollarString(s) {
  if (!s) return 0;
  const str = String(s).trim().replace(/,/g, "").toUpperCase();
  const m1 = str.match(/([0-9]*\.?[0-9]+)\s*([KMB])?/);
  if (!m1) return 0;
  let num = Number(m1[1] || 0);
  const suffix = m1[2] || "";
  if (suffix === "K") num *= 1_000;
  else if (suffix === "M") num *= 1_000_000;
  else if (suffix === "B") num *= 1_000_000_000;
  return Number.isFinite(num) ? num : 0;
}

function parseAmountFromReward(reward) {
  if (!reward) return 0;
  const eq = String(reward).match(/=\s*\$?([\d,]+(?:\.\d+)?)/i);
  if (eq) return Number(eq[1].replace(/,/g, ""));
  const sim = String(reward).match(/(?:\$|USDT)\s*([\d,]+(?:\.\d+)?)/i);
  if (sim) return Number(sim[1].replace(/,/g, ""));
  const any = String(reward).match(/([\d,]+(?:\.\d+)?)/);
  return any ? Number(any[1].replace(/,/g, "")) : 0;
}

/* ------------ wagering helpers (user progress) ------------ */
/**
 * Returns total wagered **lamports** (BigInt) for a user across all games.
 * Uses only integer columns:
 * - game_rounds.stake_lamports
 * - coinflip_matches.bet_lamports * 2  (attribute 2x bet per match to each player, matching your prior logic)
 * - slots_spins.bet_amount_lamports    (generated column)
 */
async function getUserWageredLamports(userId) {
  const out = { gr: 0n, cf: 0n, ss: 0n };

  // game_rounds stake
  if (await db._tableExistsUnsafe?.("game_rounds")) {
    const { rows } = await db.pool.query(
      `select coalesce(sum(stake_lamports),0)::text as s
         from game_rounds
        where player=$1`,
      [String(userId)]
    );
    out.gr = BigInt(rows[0]?.s || "0");
  }

  // coinflip: 2*bet per match (both players)
  if (await db._tableExistsUnsafe?.("coinflip_matches")) {
    const { rows } = await db.pool.query(
      `select coalesce(sum(bet_lamports)*2,0)::text as s
         from coinflip_matches
        where player_a=$1 or player_b=$1`,
      [String(userId)]
    );
    out.cf = BigInt(rows[0]?.s || "0");
  }

  // slots_spins: use **lamports** generated column
  if (await db._tableExistsUnsafe?.("slots_spins")) {
    // Prefer generated column; fallback to floor(bet_amount*1e9) if column missing
    let q;
    try {
      q = await db.pool.query(
        `select coalesce(sum(bet_amount_lamports),0)::text as s
           from slots_spins
          where player=$1`,
        [String(userId)]
      );
    } catch (_e) {
      // Backward-compat fallback
      q = await db.pool.query(
        `select coalesce(sum(floor(bet_amount*1e9)),0)::text as s
           from slots_spins
          where player=$1`,
        [String(userId)]
      );
    }
    out.ss = BigInt(q.rows[0]?.s || "0");
  }

  return out.gr + out.cf + out.ss;
}

function lamportsToUsd(lamports) {
  return (Number(lamports) / 1e9) * USD_PER_SOL;
}

/* ------------ uploads ------------ */
const UPLOAD_DIR = path.join(__dirname, "uploads", "rewards");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase() || ".png";
    cb(null, `reward_${Date.now()}${ext}`);
  },
});
const upload = multer({ storage });

/* ===================== Admin: Ranges ===================== */
router.get("/admin/ranges", async (_req, res) => {
  try {
    const { rows } = await db.pool.query(
      `select id, name, quote, image, is_active, created_at, updated_at
         from ranges
        order by id asc`
    );
    res.json(rows.map(rowRangeToApi));
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

router.post("/admin/ranges", async (req, res) => {
  try {
    const { name, quote, image = null, isActive = true } = req.body || {};
    if (!name || !quote) return res.status(400).json({ error: "name and quote required" });
    const { rows } = await db.pool.query(
      `insert into ranges(name, quote, image, is_active)
       values ($1,$2,$3,$4)
       returning id, name, quote, image, is_active, created_at, updated_at`,
      [String(name), String(quote), image || null, toBool(isActive)]
    );
    res.json(rowRangeToApi(rows[0]));
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

router.put("/admin/ranges/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { name, quote, image = null, isActive } = req.body || {};
    const { rows } = await db.pool.query(
      `update ranges
          set name      = coalesce($2, name),
              quote     = coalesce($3, quote),
              image     = $4,
              is_active = coalesce($5, is_active),
              updated_at= now()
        where id = $1
      returning id, name, quote, image, is_active, created_at, updated_at`,
      [id, name ?? null, quote ?? null, image, isActive == null ? null : toBool(isActive)]
    );
    if (!rows.length) return res.status(404).json({ error: "range not found" });
    res.json(rowRangeToApi(rows[0]));
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

router.delete("/admin/ranges/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const q = await db.pool.query(`delete from ranges where id=$1`, [id]);
    if (q.rowCount === 0) return res.status(404).json({ error: "range not found" });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

/* ===================== Admin: Levels ===================== */
router.get("/admin/levels", async (_req, res) => {
  try {
    const { rows } = await db.pool.query(
      `select
         l.*,
         r.name as range_name, r.quote as range_quote, r.image as range_image,
         r.is_active as range_is_active, r.created_at as range_created_at, r.updated_at as range_updated_at,
         coalesce(rc.total_claimed,0)::int as total_claimed,
         coalesce(rc.total_users,0)::int   as total_users
       from levels l
       left join ranges r on r.id = l.range_id
       left join (
         select level_id,
                count(*)::int                as total_claimed,
                count(distinct user_id)::int as total_users
         from reward_claims
         group by level_id
       ) rc on rc.level_id = l.id
       order by l.level_number asc`
    );
    res.json(rows.map((r) => rowLevelToApi(r, true)));
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

router.get("/admin/ranges/:rangeId/levels", async (req, res) => {
  try {
    const rangeId = Number(req.params.rangeId);
    const { rows } = await db.pool.query(`select * from levels where range_id=$1 order by level_number asc`, [
      rangeId,
    ]);
    res.json(rows.map((r) => rowLevelToApi(r, false)));
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

router.post("/admin/levels", async (req, res) => {
  try {
    const { range_id, level_number, title, reward = null, wagering = null, bonus = null, isActive = true } =
      req.body || {};
    if (!range_id || !level_number || !title)
      return res.status(400).json({ error: "range_id, level_number, title required" });
    const { rows } = await db.pool.query(
      `insert into levels (range_id, level_number, title, reward, wagering, bonus, is_active)
       values ($1,$2,$3,$4,$5,$6,$7)
       returning *`,
      [Number(range_id), Number(level_number), String(title), reward, wagering, bonus, toBool(isActive)]
    );
    res.json(rowLevelToApi(rows[0]));
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

/**
 * Update: :id can be DB id OR level_number (sequential)
 */
router.put("/admin/levels/:id", async (req, res) => {
  try {
    const resolvedId = await resolveLevelPk(req.params.id);
    if (!resolvedId) return res.status(404).json({ error: "level not found" });

    const { range_id, level_number, title, reward, wagering, bonus, isActive } = req.body || {};
    const { rows } = await db.pool.query(
      `update levels set
         range_id     = coalesce($2, range_id),
         level_number = coalesce($3, level_number),
         title        = coalesce($4, title),
         reward       = $5,
         wagering     = $6,
         bonus        = $7,
         is_active    = coalesce($8, is_active),
         updated_at   = now()
       where id=$1
       returning *`,
      [
        resolvedId,
        range_id == null ? null : Number(range_id),
        level_number == null ? null : Number(level_number),
        title == null ? null : String(title),
        reward ?? null,
        wagering ?? null,
        bonus ?? null,
        isActive == null ? null : toBool(isActive),
      ]
    );
    res.json(rowLevelToApi(rows[0]));
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

/**
 * Delete: :id can be DB id OR level_number (sequential)
 */
router.delete("/admin/levels/:id", async (req, res) => {
  try {
    const resolvedId = await resolveLevelPk(req.params.id);
    if (!resolvedId) return res.status(404).json({ error: "level not found" });
  const q = await db.pool.query(`delete from levels where id=$1`, [resolvedId]);
    if (q.rowCount === 0) return res.status(404).json({ error: "level not found" });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

/* ===================== PUBLIC: Ranges & Levels ===================== */
router.get("/rewards/ranges", async (_req, res) => {
  try {
    const { rows } = await db.pool.query(
      `select id, name, quote, image, is_active, created_at, updated_at
         from ranges
        order by id asc`
    );
    res.json(rows.map(rowRangeToApi));
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

router.get("/rewards/levels", async (_req, res) => {
  try {
    const { rows } = await db.pool.query(
      `select
         l.*,
         r.name as range_name, r.quote as range_quote, r.image as range_image,
         r.is_active as range_is_active, r.created_at as range_created_at, r.updated_at as range_updated_at
       from levels l
       left join ranges r on r.id = l.range_id
       where l.is_active = true
       order by l.level_number asc`
    );
    res.json(rows.map((r) => rowLevelToApi(r, true)));
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

/* ===================== User progress + Claim ===================== */
router.get("/rewards/users/:userId/progress", async (req, res) => {
  try {
    const userId = String(req.params.userId);

    // claimed
    const { rows: claimed } = await db.pool.query(`select level_id from reward_claims where user_id=$1`, [userId]);
    const claimedSet = new Set(claimed.map((r) => Number(r.level_id)));

    // all levels
    const { rows: levels } = await db.pool.query(
      `select * from levels where is_active = true order by level_number asc`
    );

    // wagering so far in USD
    const lamports = await getUserWageredLamports(userId); // BigInt
    const currentWagered = lamportsToUsd(lamports);        // Number (display)

    // compute availability based on parsed $ requirement from levels.wagering
    const availableToClaim = [];
    let highestClaimedNum = 0;
    for (const l of levels) {
      const reqUsd = parseUsdFromDollarString(l.wagering);
      const canClaimByWager = currentWagered >= reqUsd;
      if (claimedSet.has(l.id)) {
        highestClaimedNum = Math.max(highestClaimedNum, l.level_number);
      } else if (canClaimByWager) {
        availableToClaim.push(l.level_number);
      }
    }

    const currentLevel = levels.find((l) => l.level_number === highestClaimedNum) || null;
    const nextLevel = levels.find((l) => l.level_number > (currentLevel?.level_number || 0)) || null;

    // current range = from currentLevel or nextLevel
    let currentRange = null;
    if (currentLevel) {
      const r = await db.pool.query(`select * from ranges where id=$1`, [currentLevel.range_id]);
      currentRange = r.rows[0] ? rowRangeToApi(r.rows[0]) : null;
    } else if (nextLevel) {
      const r = await db.pool.query(`select * from ranges where id=$1`, [nextLevel.range_id]);
      currentRange = r.rows[0] ? rowRangeToApi(r.rows[0]) : null;
    }

    // total paid
    const { rows: paid } = await db.pool.query(
      `select coalesce(sum(amount),0)::float8 as s from reward_claims where user_id=$1`,
      [userId]
    );

    res.json({
      userId,
      currentWagered: +currentWagered.toFixed(2),
      currentLevel: currentLevel ? rowLevelToApi(currentLevel) : null,
      nextLevel: nextLevel ? rowLevelToApi(nextLevel) : null,
      claimedLevels: levels.filter((l) => claimedSet.has(l.id)).map((l) => l.level_number),
      availableToClaim,
      currentRange,
      totalRewardsPaid: Number(paid[0].s || 0),
    });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

/**
 * Claim endpoint: accept DB id OR level_number in levelId
 */
router.post("/rewards/claim", async (req, res) => {
  try {
    const { userId, levelId } = req.body || {};
    if (!userId || !levelId) return res.status(400).json({ error: "userId and levelId required" });

    const resolvedId = await resolveLevelPk(levelId);
    if (!resolvedId) return res.status(404).json({ error: "level not found" });

    const { rows: lvRows } = await db.pool.query(`select * from levels where id=$1`, [resolvedId]);
    const lv = lvRows[0];
    if (!lv) return res.status(404).json({ error: "level not found" });

    // check not already claimed
    const dup = await db.pool.query(`select 1 from reward_claims where user_id=$1 and level_id=$2 limit 1`, [
      String(userId),
      resolvedId,
    ]);
    if (dup.rows.length) return res.status(400).json({ error: "already claimed" });

    // check wagering requirement
    const reqUsd = parseUsdFromDollarString(lv.wagering);
    const lamports = await getUserWageredLamports(String(userId));
    const wagerUsd = lamportsToUsd(lamports);
    if (wagerUsd < reqUsd) {
      return res
        .status(400)
        .json({ error: `requirement not met: need $${reqUsd}, have $${wagerUsd.toFixed(2)}` });
    }

    const amount = parseAmountFromReward(lv.reward || "");
    const { rows } = await db.pool.query(
      `insert into reward_claims(user_id, level_id, amount, transaction_id)
       values ($1,$2,$3,$4)
       returning id, user_id, level_id, amount::float8 as amount, transaction_id, claimed_at`,
      [String(userId), resolvedId, Number(amount), `tx_${Date.now()}`]
    );

    res.json({
      id: String(rows[0].id),
      userId: rows[0].user_id,
      levelId: rows[0].level_id,
      amount: Number(rows[0].amount),
      claimedAt: rows[0].claimed_at,
      transactionId: rows[0].transaction_id,
      level: {
        id: lv.level_number, // expose sequential id here too
        row_id: lv.id,
        level_number: lv.level_number,
        title: lv.title,
        reward: lv.reward,
      },
    });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

/* ===================== Admin: Claims list ===================== */
router.get("/admin/rewards/claims", async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.max(1, Math.min(100, Number(req.query.limit || 20)));
    const levelId = req.query.levelId ? Number(req.query.levelId) : null;
    const userId = req.query.userId ? String(req.query.userId) : null;

    const params = [];
    const where = [];
    if (levelId) {
      // accept DB id OR level_number filter
      where.push(
        `(rc.level_id = $${params.length + 1} or rc.level_id in (select id from levels where level_number=$${
          params.length + 1
        }))`
      );
      params.push(levelId);
    }
    if (userId) {
      params.push(`%${userId}%`);
      where.push(`rc.user_id ilike $${params.length}`);
    }
    const whereSql = where.length ? `where ${where.join(" and ")}` : "";

    const off = (page - 1) * limit;

    const cnt = await db.pool.query(`select count(*)::int as c from reward_claims rc ${whereSql}`, params);
    const total = Number(cnt.rows[0].c || 0);

    const rows = await db.pool.query(
      `select rc.id, rc.user_id, rc.level_id, rc.amount::float8 as amount, rc.transaction_id, rc.claimed_at,
              l.level_number, l.title, l.reward
         from reward_claims rc
         join levels l on l.id = rc.level_id
         ${whereSql}
         order by rc.claimed_at desc
         limit $${params.length + 1} offset $${params.length + 2}`,
      params.concat([limit, off])
    );

    res.json({
      claims: rows.rows.map((r) => ({
        id: String(r.id),
        userId: r.user_id,
        levelId: r.level_id,
        amount: r.amount,
        claimedAt: r.claimed_at,
        transactionId: r.transaction_id,
        level: {
          id: r.level_number, // show sequential id here too
          row_id: r.level_id,
          level_number: r.level_number,
          title: r.title,
          reward: r.reward,
        },
      })),
      total,
      pages: Math.max(1, Math.ceil(total / limit)),
    });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

/* ===================== Admin: Upload reward icon ===================== */
router.post("/admin/rewards/upload-icon", upload.single("icon"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "icon file required" });
    const rel = `/uploads/rewards/${req.file.filename}`;
    res.json({ iconUrl: rel });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

/* ===================== PUBLIC: Real Top Leaderboard ===================== */
async function aggregateWageredLamportsMap() {
  const map = new Map(); // wallet -> BigInt lamports

  function add(wallet, lam) {
    if (!wallet) return;
    const cur = map.get(wallet) || 0n;
    map.set(wallet, cur + BigInt(lam));
  }

  if (await db._tableExistsUnsafe?.("game_rounds")) {
    const { rows } = await db.pool.query(
      `select player as wallet, coalesce(sum(stake_lamports),0)::text as s
         from game_rounds group by player`
    );
    for (const r of rows) add(r.wallet, r.s || "0");
  }

  // coinflip: attribute 2*bet to both A and B (matches per-user calc)
  if (await db._tableExistsUnsafe?.("coinflip_matches")) {
    const aRows = await db.pool.query(
      `select player_a as wallet, coalesce(sum(bet_lamports*2),0)::text as s
         from coinflip_matches group by player_a`
    );
    for (const r of aRows.rows) add(r.wallet, r.s || "0");

    const bRows = await db.pool.query(
      `select player_b as wallet, coalesce(sum(bet_lamports*2),0)::text as s
         from coinflip_matches group by player_b`
    );
    for (const r of bRows.rows) add(r.wallet, r.s || "0");
  }

  if (await db._tableExistsUnsafe?.("slots_spins")) {
    // Use lamports (generated) for slots
    let rows;
    try {
      rows = await db.pool.query(
        `select player as wallet, coalesce(sum(bet_amount_lamports),0)::text as s
           from slots_spins group by player`
      );
    } catch (_e) {
      // Fallback if generated column doesn't exist in some env
      rows = await db.pool.query(
        `select player as wallet, coalesce(sum(floor(bet_amount*1e9)),0)::text as s
           from slots_spins group by player`
      );
    }
    for (const r of rows.rows) add(r.wallet, r.s || "0");
  }

  return map;
}

/** Windowed variant used for 7d ranks */
async function aggregateWageredLamportsMapWindow(start, end = null) {
  const map = new Map(); // wallet -> BigInt lamports
  const s = new Date(start);
  const e = end ? new Date(end) : new Date();

  function add(wallet, lam) {
    if (!wallet) return;
    const cur = map.get(wallet) || 0n;
    map.set(wallet, cur + BigInt(lam));
  }

  if (await db._tableExistsUnsafe?.("game_rounds")) {
    const { rows } = await db.pool.query(
      `select player as wallet, coalesce(sum(stake_lamports),0)::text as s
         from game_rounds
        where created_at >= $1 and created_at < $2
        group by player`,
      [s, e]
    );
    for (const r of rows) add(r.wallet, r.s || "0");
  }

  if (await db._tableExistsUnsafe?.("coinflip_matches")) {
    const aRows = await db.pool.query(
      `select player_a as wallet, coalesce(sum(bet_lamports*2),0)::text as s
         from coinflip_matches
        where created_at >= $1 and created_at < $2
        group by player_a`,
      [s, e]
    );
    for (const r of aRows.rows) add(r.wallet, r.s || "0");

    const bRows = await db.pool.query(
      `select player_b as wallet, coalesce(sum(bet_lamports*2),0)::text as s
         from coinflip_matches
        where created_at >= $1 and created_at < $2
        group by player_b`,
      [s, e]
    );
    for (const r of bRows.rows) add(r.wallet, r.s || "0");
  }

  if (await db._tableExistsUnsafe?.("slots_spins")) {
    let rows;
    try {
      rows = await db.pool.query(
        `select player as wallet, coalesce(sum(bet_amount_lamports),0)::text as s
           from slots_spins
          where created_at >= $1 and created_at < $2
          group by player`,
        [s, e]
      );
    } catch (_e) {
      rows = await db.pool.query(
        `select player as wallet, coalesce(sum(floor(bet_amount*1e9)),0)::text as s
           from slots_spins
          where created_at >= $1 and created_at < $2
          group by player`,
        [s, e]
      );
    }
    for (const r of rows.rows) add(r.wallet, r.s || "0");
  }

  return map;
}

function rankFromMap(map, wallet) {
  const all = Array.from(map.entries()).map(([w, lam]) => ({ w, lam: BigInt(lam) }));
  if (!all.length) return { rank: null, players: 0 };
  all.sort((a, b) => (a.lam < b.lam ? 1 : a.lam > b.lam ? -1 : 0));
  const idx = all.findIndex((r) => r.w === wallet);
  return { rank: idx === -1 ? null : idx + 1, players: all.length };
}

router.get("/leaderboard/top", async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(100, Number(req.query.limit || 10)));

    // 1) Aggregate wagering per wallet
    const map = await aggregateWageredLamportsMap();
    const all = Array.from(map.entries()).map(([wallet, lam]) => ({
      wallet,
      wager_lamports: BigInt(lam),
      total_wagered_usd: lamportsToUsd(BigInt(lam)),
    }));

    // sort by lamports desc (avoid BigInt subtraction)
    all.sort((a, b) => (a.wager_lamports < b.wager_lamports ? 1 : a.wager_lamports > b.wager_lamports ? -1 : 0));

    const top = all.slice(0, limit);
    if (!top.length) return res.json([]);

    const wallets = top.map((t) => t.wallet);

    // 2) usernames from app_users
    const { rows: users } = await db.pool.query(`select user_id, username from app_users where user_id = any($1)`, [
      wallets,
    ]);
    const nameByWallet = Object.fromEntries(users.map((u) => [u.user_id, u.username || u.user_id]));

    // 3) highest claimed level per wallet (+ range name)
    const { rows: levelRows } = await db.pool.query(
      `
      with curr as (
        select rc.user_id, max(l.level_number) as lvl
          from reward_claims rc
          join levels l on l.id = rc.level_id
         where rc.user_id = any($1)
         group by rc.user_id
      )
      select c.user_id,
             c.lvl as level_number,
             l2.title as level_title,
             l2.range_id,
             r.name as range_name
        from curr c
        join levels l2 on l2.level_number = c.lvl
        left join ranges r on r.id = l2.range_id
      `,
      [wallets]
    );
    const levelByWallet = Object.fromEntries(
      levelRows.map((r) => [
        r.user_id,
        {
          level_number: Number(r.level_number),
          level_title: r.level_title,
          range_name: r.range_name,
        },
      ])
    );

    // 4) Compose response
    const out = top.map((t, i) => {
      const lvl = levelByWallet[t.wallet] || null;
      return {
        rank: i + 1,
        wallet: t.wallet,
        username: nameByWallet[t.wallet] || t.wallet,
        total_wagered_usd: +t.total_wagered_usd.toFixed(2),
        current_level_number: lvl?.level_number ?? null,
        current_level_title: lvl?.level_title ?? null,
        current_range_name: lvl?.range_name ?? null,
        current_level_label: lvl?.range_name && lvl?.level_title ? `${lvl.range_name} - ${lvl.level_title}` : "Unranked",
      };
    });

    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

/* ===================== PUBLIC: Me (Best Rank / Change / Players) ===================== */
/**
 * GET /leaderboard/me?wallet=<pubkey>
 * Returns:
 * {
 *   wallet,
 *   bestRank,       // all-time global rank by total wagering
 *   currentRank7d,  // rank in last 7 days
 *   prevRank7d,     // rank in the prior 7-day window
 *   change,         // prevRank7d - currentRank7d (positive => improved)
 *   players,        // all-time distinct wallets with any wagering
 *   players7d       // distinct wallets in the last 7 days
 * }
 */
router.get("/leaderboard/me", async (req, res) => {
  try {
    const wallet = String(req.query.wallet || "").trim();
    if (!wallet) return res.status(400).json({ error: "wallet required" });

    // All-time
    const allMap = await aggregateWageredLamportsMap();
    const { rank: bestRank, players } = rankFromMap(allMap, wallet);

    // 7d windows
    const now = new Date();
    const start7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const start14d = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);

    const m7 = await aggregateWageredLamportsMapWindow(start7d, now);
    const mPrev7 = await aggregateWageredLamportsMapWindow(start14d, start7d);

    const { rank: currentRank7d, players: players7d } = rankFromMap(m7, wallet);
    const { rank: prevRank7d } = rankFromMap(mPrev7, wallet);

    let change = null;
    if (currentRank7d != null && prevRank7d != null) {
      change = prevRank7d - currentRank7d; // positive => moved up (e.g., +14)
    }

    res.json({
      wallet,
      bestRank,
      currentRank7d,
      prevRank7d,
      change,
      players,
      players7d,
    });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

module.exports = router;
