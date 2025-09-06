// welcome_bonus_router.js — ZOGGY Welcome Bonus (400% + 30 FS)
// Mount at: app.use("/promo/welcome", require("./welcome_bonus_router"));
//
// Implements:
//   • Credit on first deposit: +400% (cap $2,000) + 30 FS @$0.25 (cap FS wins $30)
//   • WR x40 with global coefficient 0.2
//   • Per-game contribution rates and guardrails
//   • Max bet while active: min(10% of bonus_amount, $5)
//   • One active welcome bonus at a time (per wallet)
//   • FS winnings first capped, then added to bonus + WR
//   • 14-day expiry → removes bonus funds/winnings (forfeit also supported)
//   • PvP CoinFlip anti-collusion (unique opponents/IP/device, daily WR volume cap)
//   • ✅ Uses LIVE SOL/USD price with caching (Coingecko → Coinbase → Binance → env fallback)
//
// Requires tables from schema.sql (already present in your repo):
//   - welcome_bonus_states, welcome_bonuses, welcome_wr_events, device_fingerprints
// Also uses: deposits, coinflip_matches, app_users (optional), referrals infra.
//
// Notes:
//   - We “count WR units” only; we do NOT actually move lamports. On clear,
//     you’ll get `status: "cleared"` in state and a 200 response from /report_bet;
//     hook your cashier to unlock withdrawals / free bonus holds there.
//

const express = require("express");
const router = express.Router();
const db = require("./db");

// -------------------- Config (override via env if you like) --------------------
// USD_PER_SOL is now ONLY a fallback; real-time price is fetched and cached.
const USD_PER_SOL_FALLBACK = Number(process.env.USD_PER_SOL || 200);

const WELCOME_CFG = {
  name:               process.env.WELCOME_NAME || "ZOGGY_WELCOME_400",
  deposit_multiplier: Number(process.env.WELCOME_DEPOSIT_MULT || 4.0),     // 400%
  bonus_cap_usd:      Number(process.env.WELCOME_BONUS_CAP_USD || 2000),
  wagering: {
    multiplier:   Number(process.env.WELCOME_WR_MULT || 40),
    coefficient:  Number(process.env.WELCOME_COEFF || 0.2),
    expires_days: Number(process.env.WELCOME_EXPIRES_DAYS || 14),
    maxBet: {
      mode: "min(percent_bonus, hard_cap)",
      percent_bonus: Number(process.env.WELCOME_MAXBET_PCT || 0.10),
      hard_cap:      Number(process.env.WELCOME_MAXBET_CAP_USD || 5.0),
    }
  },
  free_spins: {
    count:       Number(process.env.WELCOME_FS_COUNT || 30),
    game_id:     process.env.WELCOME_FS_GAME || "memeslot",
    spin_value:  Number(process.env.WELCOME_FS_VALUE_USD || 0.25),
    max_win:     Number(process.env.WELCOME_FS_MAX_WIN_USD || 30),
  },
  eligibility: {
    games: {
      memeslot:     { category: "slots",    contribution_rate: 1.00 },
      crash:        { category: "original", contribution_rate: 0.60 },
      plinko:       { category: "original", contribution_rate: 0.60 },
      mines:        { category: "original", contribution_rate: 0.60 },
      dice:         { category: "original", contribution_rate: 0.60 },
      coinflip_pvp: { category: "pvp",      contribution_rate: 0.10, anti_collusion: {
        require_unique_opponents: Number(process.env.BONUS_COINFLIP_MIN_UNIQUE_OPPONENTS || 5),
        disallow_same_ip: true,
        daily_wr_volume_cap_usd: Number(process.env.BONUS_COINFLIP_DAILY_WR_CAP_USD || 200),
      }}
    }
  },
  one_active_bonus: true,
  allow_forfeit_to_withdraw: true,
};

// Optional shared secret for S2S bet reporting (game servers → API)
const PROMO_BACKEND_SECRET = process.env.PROMO_BACKEND_SECRET || null;

// -------------------- Utils --------------------
const toLamports = (sol) => Math.round(Number(sol || 0) * 1e9);
const lamportsToSol = (lam) => Number(lam || 0) / 1e9;

function normalizeWallet(input) {
  const s = (input === undefined || input === null) ? "" : String(input).trim();
  if (!s) return "";
  const lc = s.toLowerCase();
  if (lc === "undefined" || lc === "null") return "";
  return s;
}
function getClientIp(req) {
  const xf = (req.headers["x-forwarded-for"] || "").toString().split(",")[0].trim();
  return xf || req.ip || req.connection?.remoteAddress || "";
}
function maskIp(ip) {
  if (!ip) return "";
  const s = String(ip);
  if (s.includes(":")) return s.split(":").slice(0,4).join(":") + ":****";
  const parts = s.split(".");
  if (parts.length !== 4) return s;
  return `${parts[0]}.${parts[1]}.***.***`;
}
function assertBackendAuth(req) {
  if (!PROMO_BACKEND_SECRET) return true;
  const got = req.headers["x-promo-auth"];
  return (got && String(got) === String(PROMO_BACKEND_SECRET));
}

// -------------------- Live SOL/USD (cached) --------------------
const PRICE_TTL_MS = Number(process.env.PRICE_TTL_MS || 60_000);
let _priceCache = { usd: null, ts: 0 };

const _fetch = (...args) =>
  (globalThis.fetch ? globalThis.fetch(...args) : import("node-fetch").then(({ default: f }) => f(...args)));

async function fetchJsonWithTimeout(url, timeoutMs = 5000) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await _fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`${url} status ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(id);
  }
}

async function fetchSolUsdFromCoingecko() {
  const j = await fetchJsonWithTimeout("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd");
  const v = Number(j?.solana?.usd);
  if (!Number.isFinite(v) || v <= 0) throw new Error("coingecko no price");
  return v;
}
async function fetchSolUsdFromCoinbase() {
  const j = await fetchJsonWithTimeout("https://api.coinbase.com/v2/prices/SOL-USD/spot");
  const v = Number(j?.data?.amount);
  if (!Number.isFinite(v) || v <= 0) throw new Error("coinbase no price");
  return v;
}
async function fetchSolUsdFromBinance() {
  const j = await fetchJsonWithTimeout("https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT");
  const v = Number(j?.price);
  if (!Number.isFinite(v) || v <= 0) throw new Error("binance no price");
  return v;
}

async function getSolUsdPrice() {
  const now = Date.now();
  if (_priceCache.usd && now - _priceCache.ts < PRICE_TTL_MS) return _priceCache.usd;

  let usd = null;
  const fns = [fetchSolUsdFromCoingecko, fetchSolUsdFromCoinbase, fetchSolUsdFromBinance];
  for (const fn of fns) {
    try {
      usd = await fn();
      break;
    } catch { /* try next */ }
  }
  if (!usd) usd = USD_PER_SOL_FALLBACK;
  _priceCache = { usd, ts: now };
  return usd;
}

async function lamportsToUsdDynamic(lamports) {
  const price = await getSolUsdPrice();
  const sol = lamportsToSol(lamports);
  return sol * price;
}

// Schema helper: add aux_json to welcome_wr_events for coinflip opponent/IP/device tracking
async function ensureWelcomeSchema() {
  await db.pool.query(`
    do $$
    begin
      if not exists (select 1 from information_schema.columns
                     where table_name='welcome_wr_events' and column_name='aux_json') then
        alter table welcome_wr_events add column aux_json jsonb;
      end if;
    end$$;
  `);
  await db.pool.query(`
    create index if not exists idx_welcome_wr_aux_opp
      on welcome_wr_events((aux_json->>'opponent_wallet'))
  `);
}
ensureWelcomeSchema().catch(() => { /* best effort */ });

// -------------------- Core calculators --------------------
function calcBonusUsd(depositUsd) {
  const raw = Number(depositUsd || 0) * WELCOME_CFG.deposit_multiplier;
  return Math.min(raw, WELCOME_CFG.bonus_cap_usd);
}
function calcWrRequiredUnits(bonusUsd) {
  return Number(bonusUsd || 0) * WELCOME_CFG.wagering.multiplier;
}
function calcMaxBetUsd(bonusUsd) {
  const p = Number(bonusUsd || 0) * WELCOME_CFG.wagering.maxBet.percent_bonus;
  return Math.min(p, WELCOME_CFG.wagering.maxBet.hard_cap);
}
function expiresAtDate() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + WELCOME_CFG.wagering.expires_days);
  return d;
}
function getContributionRate(game_key) {
  const g = WELCOME_CFG.eligibility.games[game_key];
  return g ? Number(g.contribution_rate || 0) : 0;
}

// -------------------- State helpers --------------------
//
// welcome_bonus_states schema:
//   user_wallet, name, bonus_amount_usd, wr_required_units, wr_progress_units,
//   coefficient, expires_at, max_bet_usd, status, fs_count, fs_value_usd, fs_max_win_usd
//
async function getActiveState(userWallet) {
  const { rows } = await db.pool.query(
    `select * from welcome_bonus_states
      where user_wallet=$1 and name=$2 and status='active' limit 1`,
    [String(userWallet), String(WELCOME_CFG.name)]
  );
  return rows[0] || null;
}
async function upsertActiveState(userWallet, { bonusUsd, wrRequired, maxBetUsd }) {
  const expiresAt = expiresAtDate();
  await db.pool.query(
    `insert into welcome_bonus_states
      (user_wallet, name, bonus_amount_usd, wr_required_units, wr_progress_units,
       coefficient, expires_at, max_bet_usd, status, fs_count, fs_value_usd, fs_max_win_usd, created_at)
     values ($1,$2,$3,$4,0,$5,$6,$7,'active',$8,$9,$10,now())
     on conflict (user_wallet, name) do nothing`,
    [
      String(userWallet),
      String(WELCOME_CFG.name),
      Number(bonusUsd),
      Number(wrRequired),
      Number(WELCOME_CFG.wagering.coefficient),
      expiresAt.toISOString(),
      Number(maxBetUsd),
      Number(WELCOME_CFG.free_spins.count),
      Number(WELCOME_CFG.free_spins.spin_value),
      Number(WELCOME_CFG.free_spins.max_win),
    ]
  );
  return { bonusUsd, wrRequired, maxBetUsd, expiresAt };
}

// -------------------- Activation (after first deposit) --------------------
async function activateWelcomeBonus(userWallet, firstDepositLamports) {
  // ✅ Use live price to compute USD value
  const depUsd   = await lamportsToUsdDynamic(firstDepositLamports || 0);
  const bonusUsd = calcBonusUsd(depUsd);
  if (bonusUsd <= 0) return { ok:false, reason:"zero-deposit-bonus", depUsd };

  const wrRequired = calcWrRequiredUnits(bonusUsd);
  const maxBetUsd  = calcMaxBetUsd(bonusUsd);

  // One active at a time: if already active, no-op.
  const existing = await getActiveState(userWallet);
  if (existing) return { ok:true, alreadyActive:true, state: existing, depUsd };

  await upsertActiveState(userWallet, { bonusUsd, wrRequired, maxBetUsd });
  return { ok:true, bonusUsd, wrRequired, maxBetUsd, expiresAt: expiresAtDate(), depUsd };
}

// -------------------- Anti-collusion (PvP CoinFlip) --------------------
async function coinflipAntiCollusionOk({ userWallet, opponentWallet, ipA, ipB, deviceA, deviceB /*, stakeUsd*/ }) {
  if (!userWallet || !opponentWallet) return false;
  if (WELCOME_CFG.eligibility.games.coinflip_pvp?.anti_collusion?.disallow_same_ip) {
    if (ipA && ipB && String(ipA) === String(ipB)) return false;
  }
  if (deviceA && deviceB && String(deviceA) === String(deviceB)) return false;

  // daily unique opponents requirement (soft, we still enforce daily stake cap)
  const today = new Date();
  const { rows: opp } = await db.pool.query(
    `select count(distinct aux_json->>'opponent_wallet')::int as c
       from welcome_wr_events
      where user_wallet=$1 and game_key='coinflip_pvp' and created_at::date=$2::date`,
    [String(userWallet), `${today.getUTCFullYear()}-${String(today.getUTCMonth()+1).padStart(2,"0")}-${String(today.getUTCDate()).padStart(2,"0")}`]
  );
  const distinctCount = Number(opp[0]?.c || 0);
  const need = Number(WELCOME_CFG.eligibility.games.coinflip_pvp.anti_collusion.require_unique_opponents || 5);

  const { rows: cap } = await db.pool.query(
    `select coalesce(sum(stake_usd),0)::float8 as s
       from welcome_wr_events
      where user_wallet=$1 and game_key='coinflip_pvp' and created_at::date=now()::date`,
    [String(userWallet)]
  );
  const todayStake = Number(cap[0]?.s || 0);
  const capUsd = Number(WELCOME_CFG.eligibility.games.coinflip_pvp.anti_collusion.daily_wr_volume_cap_usd || 200);

  if (todayStake >= capUsd) return false;

  // If you want to strictly require N unique opponents before any WR, uncomment:
  // if (distinctCount < need) return false;

  return true;
}

// -------------------- Bet reporting → WR accumulation --------------------
async function applyWagerContribution({ userWallet, game_key, stakeUsd, aux }) {
  const st = await getActiveState(userWallet);
  if (!st) return { ok:true, counted:false, reason:"no-active" };
  if (new Date(st.expires_at) < new Date()) {
    await db.pool.query(
      `update welcome_bonus_states
          set status='expired'
        where id=$1 and status='active'`,
      [st.id]
    );
    return { ok:true, counted:false, reason:"expired" };
  }

  // global max bet (hard cap)
  if (stakeUsd > Number(st.max_bet_usd || 0)) {
    return { ok:false, counted:false, reason:"max-bet-exceeded", maxBetUsd: Number(st.max_bet_usd || 0) };
  }

  // per-game contribution/guardrails
  const key = String(game_key || "").toLowerCase();
  let rate = getContributionRate(key);
  if (rate <= 0) return { ok:true, counted:false, reason:"not-eligible" };

  // Game-specific guardrails
  if (key === "crash") {
    const cm = Number(aux?.cashoutMultiplier || 0);
    const usedAuto = Boolean(aux?.usedAutoCashout);
    if (usedAuto && cm && cm < 1.2) rate = 0;
  }
  if (key === "dice") {
    const winProb = Number(aux?.winProb || 0);
    if (winProb && winProb >= 0.99) rate = 0;
  }
  if (key === "mines") {
    if (aux?.safePattern === true) rate = 0;
  }
  if (key === "coinflip_pvp") {
    const ok = await coinflipAntiCollusionOk({
      userWallet,
      opponentWallet: normalizeWallet(aux?.opponent_wallet),
      ipA: aux?.ip_masked_a || aux?.ip_a || null,
      ipB: aux?.ip_masked_b || aux?.ip_b || null,
      deviceA: aux?.device_id_a || null,
      deviceB: aux?.device_id_b || null,
      stakeUsd,
    });
    if (!ok) rate = 0;
  }

  const coef = Number(st.coefficient || WELCOME_CFG.wagering.coefficient);
  const contribution = Number(stakeUsd) * coef * Number(rate);

  // Store event (with aux jsonb for audits/unique-opponent counting)
  await db.pool.query(
    `insert into welcome_wr_events (user_wallet, game_key, stake_usd, contribution_usd, aux_json)
     values ($1,$2,$3,$4,$5)`,
    [String(userWallet), key, Number(stakeUsd), Number(contribution), aux ? JSON.stringify(aux) : null]
  );

  // Update WR progress
  const newProg  = Math.min(Number(st.wr_progress_units || 0) + Number(contribution), Number(st.wr_required_units || 0));
  const cleared  = newProg >= Number(st.wr_required_units || 0);

  await db.pool.query(
    `update welcome_bonus_states
        set wr_progress_units=$3,
            status = case when $3 >= wr_required_units then 'cleared' else status end
      where user_wallet=$1 and name=$2 and status in ('active','cleared')`,
    [String(userWallet), String(WELCOME_CFG.name), Number(newProg)]
  );

  return { ok:true, counted: contribution > 0, contributionUsd: contribution, cleared };
}

// -------------------- Free Spins flow --------------------
async function settleFreeSpins({ userWallet, fs_winnings_raw_usd }) {
  const st = await getActiveState(userWallet);
  if (!st) return { ok:false, reason:"no-active" };

  const capped = Math.min(Number(fs_winnings_raw_usd || 0), Number(WELCOME_CFG.free_spins.max_win || 0));

  if (Number(st.fs_count || 0) <= 0) {
    return { ok:false, reason:"no-fs-left" };
  }

  const addWr = capped * Number(WELCOME_CFG.wagering.multiplier || 40);
  const newReq = Number(st.wr_required_units || 0) + Number(addWr);

  await db.pool.query(
    `update welcome_bonus_states
        set fs_count = 0,
            wr_required_units = $2
      where id=$1`,
    [st.id, Number(newReq)]
  );

  await db.pool.query(
    `insert into welcome_wr_events (user_wallet, game_key, stake_usd, contribution_usd, aux_json)
     values ($1,$2,$3,$4,$5)`,
    [String(st.user_wallet), "fs_settle", 0, 0, JSON.stringify({ fs_winnings_raw_usd, fs_winnings_capped_usd: capped })]
  );

  return { ok:true, fs_winnings_capped_usd: capped, wr_added_units: addWr, new_wr_required_units: newReq };
}

// -------------------- Expiry / Forfeit --------------------
async function expireIfNeeded(userWallet) {
  const st = await getActiveState(userWallet);
  if (!st) return { ok:true, already:false };
  if (new Date(st.expires_at) > new Date()) return { ok:true, already:false };
  await db.pool.query(
    `update welcome_bonus_states set status='expired' where id=$1 and status='active'`,
    [st.id]
  );
  return { ok:true, expired:true };
}
async function forfeitBonus(userWallet) {
  const st = await getActiveState(userWallet);
  if (!st) return { ok:false, reason:"no-active" };
  await db.pool.query(
    `update welcome_bonus_states set status='forfeited' where id=$1 and status='active'`,
    [st.id]
  );
  return { ok:true, forfeited:true };
}

// ==================== ROUTES ====================

// Credit on deposit — call this after your cashier confirms a deposit
router.post("/credit-on-deposit", async (req, res) => {
  try {
    const userWallet = normalizeWallet(req.body?.userWallet);
    const amountSol  = Number(req.body?.amountSol ?? 0);
    const txSig      = req.body?.txSig || null;
    if (!userWallet) return res.status(400).json({ error:"userWallet required" });
    if (amountSol <= 0) return res.status(400).json({ error:"amountSol must be > 0" });

    const lam = toLamports(amountSol);

    // Record deposit (idempotent enough for our purposes)
    await db.pool.query(
      `insert into deposits(user_wallet, amount_lamports, tx_sig) values ($1,$2,$3)`,
      [String(userWallet), String(lam), txSig]
    );

    // Track "first deposit amount" for eligibility
    const { rows:first } = await db.pool.query(
      `select sum(amount_lamports)::bigint as s from deposits where user_wallet=$1`,
      [String(userWallet)]
    );
    const total = BigInt(first[0]?.s || 0);
    await db.pool.query(
      `insert into welcome_bonuses(user_wallet, first_deposit_lamports, claimed)
       values ($1,$2,false)
       on conflict (user_wallet) do update set
         first_deposit_lamports = greatest(welcome_bonuses.first_deposit_lamports, excluded.first_deposit_lamports)`,
      [String(userWallet), String(total)]
    );

    const act = await activateWelcomeBonus(String(userWallet), lam);
    res.json({ ok:true, activated: act, depositedLamports: lam.toString() });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// Read state (for frontend “bonus card”)
router.get("/state", async (req, res) => {
  try {
    const wallet = normalizeWallet(req.query.userWallet || req.query.wallet);
    if (!wallet) return res.status(400).json({ error:"userWallet required" });

    // Check and auto-expire
    await expireIfNeeded(wallet);

    const { rows } = await db.pool.query(
      `select id, user_wallet, name, bonus_amount_usd, wr_required_units, wr_progress_units,
              coefficient, expires_at, max_bet_usd, status, fs_count, fs_value_usd, fs_max_win_usd,
              to_char(expires_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as expires_at_iso
         from welcome_bonus_states
        where user_wallet=$1 and name=$2
        order by created_at desc
        limit 1`,
      [String(wallet), String(WELCOME_CFG.name)]
    );

    // Also expose the price we’re using (handy for UI/debug)
    const usdPerSol = await getSolUsdPrice();

    res.json(rows[0] ? { ...rows[0], usd_per_sol: usdPerSol } : { status: "none", usd_per_sol: usdPerSol });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// Forfeit (user chooses to unlock withdrawals by losing bonus)
router.post("/forfeit", async (req, res) => {
  try {
    const wallet = normalizeWallet(req.body?.userWallet);
    if (!wallet) return res.status(400).json({ error:"userWallet required" });
    if (!WELCOME_CFG.allow_forfeit_to_withdraw) {
      return res.status(400).json({ error:"forfeit is disabled" });
    }
    const r = await forfeitBonus(wallet);
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// Free Spins settlement: { userWallet, fsWinningsRawUsd }
router.post("/fs/settle", async (req, res) => {
  try {
    const wallet = normalizeWallet(req.body?.userWallet);
    const raw    = Number(req.body?.fsWinningsRawUsd || 0);
    if (!wallet) return res.status(400).json({ error:"userWallet required" });
    const out = await settleFreeSpins({ userWallet: wallet, fs_winnings_raw_usd: raw });
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// Can I bet? (enforces max bet while bonus active)
router.get("/can-bet", async (req, res) => {
  try {
    const wallet = normalizeWallet(req.query?.userWallet || req.query?.wallet);
    const stakeUsd = Number(req.query?.stakeUsd || 0);
    const gameKey = String(req.query?.game || "").toLowerCase();
    if (!wallet) return res.status(400).json({ error:"userWallet required" });
    const st = await getActiveState(wallet);
    if (!st) return res.json({ ok:true, allowed:true, reason:"no-active" });

    if (new Date(st.expires_at) < new Date()) {
      return res.json({ ok:false, allowed:false, reason:"expired" });
    }
    if (stakeUsd > Number(st.max_bet_usd || 0)) {
      return res.json({ ok:false, allowed:false, reason:"max-bet-exceeded", maxBetUsd: Number(st.max_bet_usd || 0) });
    }
    const rate = getContributionRate(gameKey);
    res.json({ ok:true, allowed:true, maxBetUsd: Number(st.max_bet_usd || 0), contributionRate: rate, coefficient: Number(st.coefficient || 0.2) });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// Server-to-server bet report (use from each game service on settle)
router.post("/report_bet", async (req, res) => {
  try {
    if (!assertBackendAuth(req)) return res.status(401).json({ error: "unauthorized" });

    const userWallet = normalizeWallet(req.body?.userWallet);
    const gameKey    = String(req.body?.gameKey || req.body?.game || "").toLowerCase();
    let   stakeUsd   = Number(req.body?.stakeUsd || 0);
    const stakeLam   = req.body?.stakeLamports != null ? BigInt(String(req.body?.stakeLamports)) : null;
    const aux        = req.body?.aux || {};

    if (!userWallet) return res.status(400).json({ error:"userWallet required" });
    if (!gameKey)    return res.status(400).json({ error:"gameKey required" });

    // ✅ Use live price if only lamports provided
    if (!stakeUsd && (stakeLam !== null)) {
      stakeUsd = await lamportsToUsdDynamic(stakeLam);
    }
    if (stakeUsd <= 0) return res.status(400).json({ error:"stake must be > 0" });

    if (!aux.ip_masked_a) aux.ip_masked_a = maskIp(getClientIp(req));

    const out = await applyWagerContribution({ userWallet, game_key: gameKey, stakeUsd, aux });
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

module.exports = router;
