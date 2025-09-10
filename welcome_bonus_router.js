// welcome_bonus_router.js — ZOGGY Welcome Bonus (400% + 30 FS)
// Mount at: app.use("/promo/welcome", require("./welcome_bonus_router"));

const express = require("express");
const router = express.Router();
const db = require("./db");

// ⬇️ REAL TRANSFER helper (uses HOUSE_SECRET_KEY & PROGRAM_ID)
const { depositBonusToVault } = require("./bonus_transfer");

const ROUTER_VERSION = "wb-3.2.1-transfer-first-txsig";

// -------------------- Config --------------------
const USD_PER_SOL_FALLBACK = Number(process.env.USD_PER_SOL || 200);
const PROMO_BACKEND_SECRET = process.env.PROMO_BACKEND_SECRET || null;

const WELCOME_CFG = {
  name:               process.env.WELCOME_NAME || "ZOGGY_WELCOME_400",
  deposit_multiplier: Number(process.env.WELCOME_DEPOSIT_MULT || 4.0),
  bonus_cap_usd:      Number(process.env.WELCOME_BONUS_CAP_USD || 2000),
  claim_window_days:  Number(process.env.WELCOME_CLAIM_DAYS || 14),
  wagering: {
    multiplier:   Number(process.env.WELCOME_WR_MULT || 40),
    coefficient:  Number(process.env.WELCOME_COEFF || 0.2),
    expires_days: Number(process.env.WELCOME_EXPIRES_DAYS || 14),
    maxBet: {
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

// -------------------- Utils --------------------
const toLamports    = (sol) => Math.round(Number(sol || 0) * 1e9);
const lamportsToSol = (lam) => Number(lam || 0) / 1e9;
const normalizeWallet = (s) => {
  const x = (s == null) ? "" : String(s).trim();
  return (!x || x === "null" || x === "undefined") ? "" : x;
};
const getClientIp = (req) => (req.headers["x-forwarded-for"] || "").toString().split(",")[0].trim() || req.ip || "";
const maskIp = (ip) => {
  if (!ip) return "";
  if (ip.includes(":")) return ip.split(":").slice(0,4).join(":") + ":****";
  const p = ip.split(".");
  return p.length === 4 ? `${p[0]}.${p[1]}.***.***` : ip;
};
const assertBackendAuth = (req) => {
  if (!PROMO_BACKEND_SECRET) return true;
  const got = req.headers["x-promo-auth"];
  return got && String(got) === String(PROMO_BACKEND_SECRET);
};

// -------------------- Schema guard (auto-patch) --------------------
let _schemaEnsured = false;
async function ensureSchema() {
  if (_schemaEnsured) return;
  await db.pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_name='welcome_bonus_states' AND column_name='updated_at') THEN
        ALTER TABLE welcome_bonus_states ADD COLUMN updated_at TIMESTAMPTZ DEFAULT now();
      END IF;

      IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_name='welcome_bonus_states' AND column_name='created_at') THEN
        ALTER TABLE welcome_bonus_states ADD COLUMN created_at TIMESTAMPTZ DEFAULT now();
      END IF;

      IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_name='welcome_bonuses' AND column_name='first_deposit_at') THEN
        ALTER TABLE welcome_bonuses ADD COLUMN first_deposit_at TIMESTAMPTZ;
      END IF;

      IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_name='welcome_bonuses' AND column_name='first_deposit_lamports') THEN
        ALTER TABLE welcome_bonuses ADD COLUMN first_deposit_lamports BIGINT DEFAULT 0;
      END IF;

      IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_name='welcome_bonuses' AND column_name='claimed') THEN
        ALTER TABLE welcome_bonuses ADD COLUMN claimed BOOLEAN DEFAULT FALSE;
      END IF;

      IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_name='welcome_bonuses' AND column_name='claimed_at') THEN
        ALTER TABLE welcome_bonuses ADD COLUMN claimed_at TIMESTAMPTZ;
      END IF;

      IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_name='welcome_bonuses' AND column_name='claimed_tx_sig') THEN
        ALTER TABLE welcome_bonuses ADD COLUMN claimed_tx_sig TEXT;
      END IF;

      IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_name='deposits' AND column_name='created_at') THEN
        ALTER TABLE deposits ADD COLUMN created_at TIMESTAMPTZ DEFAULT now();
      END IF;
    END
    $$ LANGUAGE plpgsql;
  `);
  _schemaEnsured = true;
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
  } finally { clearTimeout(id); }
}
async function priceCoingecko() { const j = await fetchJsonWithTimeout("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd"); const v = Number(j?.solana?.usd); if (!(v > 0)) throw 0; return v; }
async function priceCoinbase()  { const j = await fetchJsonWithTimeout("https://api.coinbase.com/v2/prices/SOL-USD/spot"); const v = Number(j?.data?.amount); if (!(v > 0)) throw 0; return v; }
async function priceBinance()   { const j = await fetchJsonWithTimeout("https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT"); const v = Number(j?.price); if (!(v > 0)) throw 0; return v; }

async function getSolUsdPrice() {
  const now = Date.now();
  if (_priceCache.usd && now - _priceCache.ts < PRICE_TTL_MS) return _priceCache.usd;
  let usd = null;
  for (const fn of [priceCoingecko, priceCoinbase, priceBinance]) {
    try { usd = await fn(); break; } catch {}
  }
  if (!usd) usd = USD_PER_SOL_FALLBACK;
  _priceCache = { usd, ts: now };
  return usd;
}
async function lamportsToUsdDynamic(lamports) {
  const price = await getSolUsdPrice();
  return lamportsToSol(lamports) * price;
}
async function usdToLamports(usd) {
  const price = await getSolUsdPrice();
  const sol = Number(usd || 0) / price;
  return toLamports(sol);
}

// -------------------- Core calculators --------------------
const calcBonusUsd = (depUsd) => Math.min(Number(depUsd || 0) * WELCOME_CFG.deposit_multiplier, WELCOME_CFG.bonus_cap_usd);
const calcWrRequiredUnits = (bonusUsd) => Number(bonusUsd || 0) * WELCOME_CFG.wagering.multiplier;
const calcMaxBetUsd       = (bonusUsd) => Math.min(Number(bonusUsd || 0) * WELCOME_CFG.wagering.maxBet.percent_bonus, WELCOME_CFG.wagering.maxBet.hard_cap);
const expiresAtDate = () => { const d = new Date(); d.setUTCDate(d.getUTCDate() + WELCOME_CFG.wagering.expires_days); return d; };
const getContributionRate = (key) => Number(WELCOME_CFG.eligibility.games[key]?.contribution_rate || 0);

// -------------------- DB/state helpers --------------------
async function getWelcomeMeta(userWallet) {
  const { rows } = await db.pool.query(
    `select user_wallet, first_deposit_lamports, first_deposit_at, claimed, claimed_at, claimed_tx_sig
       from welcome_bonuses where user_wallet=$1 limit 1`,
    [String(userWallet)]
  );
  return rows[0] || null;
}

async function getActiveState(userWallet) {
  const { rows } = await db.pool.query(
    `select * from welcome_bonus_states where user_wallet=$1 and name=$2 and status='active' limit 1`,
    [String(userWallet), String(WELCOME_CFG.name)]
  );
  return rows[0] || null;
}

async function upsertActiveStateWithClient(client, userWallet, { bonusUsd, wrRequired, maxBetUsd }) {
  const expiresAt = expiresAtDate();
  await client.query(
    `insert into welcome_bonus_states
      (user_wallet,name,bonus_amount_usd,wr_required_units,wr_progress_units,coefficient,expires_at,max_bet_usd,status,fs_count,fs_value_usd,fs_max_win_usd,created_at,updated_at)
     values ($1,$2,$3,$4,0,$5,$6,$7,'active',$8,$9,$10,now(),now())
     on conflict (user_wallet,name) do update set
       bonus_amount_usd = EXCLUDED.bonus_amount_usd,
       wr_required_units= EXCLUDED.wr_required_units,
       coefficient      = EXCLUDED.coefficient,
       expires_at       = EXCLUDED.expires_at,
       max_bet_usd      = EXCLUDED.max_bet_usd,
       fs_count         = EXCLUDED.fs_count,
       fs_value_usd     = EXCLUDED.fs_value_usd,
       fs_max_win_usd   = EXCLUDED.fs_max_win_usd,
       status           = 'active',
       updated_at       = now()`,
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
async function setStateCleared(userWallet) {
  await db.pool.query(
    `update welcome_bonus_states set status='cleared', updated_at=now()
      where user_wallet=$1 and name=$2 and status='active'`,
    [String(userWallet), String(WELCOME_CFG.name)]
  );
}
async function expireIfNeeded(userWallet) {
  await db.pool.query(
    `update welcome_bonus_states
        set status='expired', updated_at=now()
      where user_wallet=$1 and name=$2 and status='active' and now()>expires_at`,
    [String(userWallet), String(WELCOME_CFG.name)]
  );
}
async function forfeitBonus(userWallet) {
  await db.pool.query(
    `update welcome_bonus_states set status='forfeited', updated_at=now()
     where user_wallet=$1 and name=$2 and status='active'`,
    [String(userWallet), String(WELCOME_CFG.name)]
  );
}

// ---- Eligibility helpers ----
async function sumDeposits(userWallet, withinDays = null) {
  if (withinDays && Number(withinDays) > 0) {
    try {
      const { rows } = await db.pool.query(
        `select coalesce(sum(amount_lamports),0)::bigint as s,
                min(created_at) as first_at
           from deposits
          where user_wallet=$1
            and created_at >= now() - $2::interval`,
        [String(userWallet), `${Number(withinDays)} days`]
      );
      const s = BigInt(rows[0]?.s || 0n);
      return { totalLamports: s, firstAt: rows[0]?.first_at || null };
    } catch {}
  }
  const { rows } = await db.pool.query(
    `select coalesce(sum(amount_lamports),0)::bigint as s,
            null::timestamp as first_at
       from deposits
      where user_wallet=$1`,
    [String(userWallet)]
  );
  const s = BigInt(rows[0]?.s || 0n);
  return { totalLamports: s, firstAt: null };
}
const computeBonusFromUsd = (depUsd) => {
  const bonusUsd = calcBonusUsd(depUsd);
  const wrRequired = calcWrRequiredUnits(bonusUsd);
  const maxBetUsd  = calcMaxBetUsd(bonusUsd);
  return { bonusUsd, wrRequired, maxBetUsd };
};

// -------------------- Anti-collusion (CoinFlip PvP) --------------------
async function coinflipAntiCollusionOk({ userWallet, opponentWallet, ipA, ipB, deviceA, deviceB }) {
  if (!userWallet || !opponentWallet) return false;
  if (WELCOME_CFG.eligibility.games.coinflip_pvp?.anti_collusion?.disallow_same_ip) {
    if (ipA && ipB && String(ipA) === String(ipB)) return false;
  }
  if (deviceA && deviceB && String(deviceA) === String(deviceB)) return false;

  const { rows: cap } = await db.pool.query(
    `select coalesce(sum(stake_usd),0)::float8 as s
       from welcome_wr_events
      where user_wallet=$1 and game_key='coinflip_pvp' and created_at::date=now()::date`,
    [String(userWallet)]
  );
  const todayStake = Number(cap[0]?.s || 0);
  const capUsd = Number(WELCOME_CFG.eligibility.games.coinflip_pvp.anti_collusion.daily_wr_volume_cap_usd || 200);

  if (todayStake >= capUsd) return false;
  return true;
}

// -------------------- WR accumulation --------------------
async function applyWagerContribution({ userWallet, game_key, stakeUsd, aux }) {
  await ensureSchema();
  await expireIfNeeded(userWallet);
  const st = await getActiveState(userWallet);
  if (!st) return { ok:true, counted:false, reason:"no-active" };
  if (new Date(st.expires_at) < new Date()) return { ok:true, counted:false, reason:"expired" };

  const maxBetUsd = calcMaxBetUsd(st.bonus_amount_usd);
  if (Number(stakeUsd) > maxBetUsd + 1e-9) {
    return { ok:false, counted:false, reason:"max-bet-exceeded", maxBetUsd, stakeUsd };
  }

  const key = String(game_key || "").toLowerCase();
  let rate = getContributionRate(key);
  if (rate <= 0) return { ok:true, counted:false, reason:"not-eligible" };

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
    });
    if (!ok) rate = 0;
  }

  const coef = Number(st.coefficient || WELCOME_CFG.wagering.coefficient);
  const contribution = Number(stakeUsd) * coef * Number(rate);

  await db.pool.query(
    `insert into welcome_wr_events (user_wallet, game_key, stake_usd, contribution_usd, aux_json, created_at)
     values ($1,$2,$3,$4,$5, now())`,
    [String(userWallet), key, Number(stakeUsd), Number(contribution), aux ? JSON.stringify(aux) : null]
  );

  const { rows } = await db.pool.query(
    `update welcome_bonus_states
        set wr_progress_units = LEAST(wr_required_units, wr_progress_units + $1),
            updated_at = now()
      where user_wallet=$2 and name=$3 and status in ('active','cleared')
      returning wr_progress_units, wr_required_units`,
    [Number(contribution), String(userWallet), String(WELCOME_CFG.name)]
  );

  const cur = rows[0];
  if (!cur) return { ok:false, error:"state-update-failed" };

  if (cur.wr_progress_units + 1e-9 >= cur.wr_required_units) {
    await setStateCleared(userWallet);
    return { ok:true, counted: contribution>0, cleared:true, wr_progress_units: cur.wr_progress_units, wr_required_units: cur.wr_required_units };
  }

  return { ok:true, counted: contribution>0, cleared:false, wr_progress_units: cur.wr_progress_units, wr_required_units: cur.wr_required_units };
}

// -------------------- Free Spins --------------------
async function settleFreeSpins({ userWallet, fs_winnings_raw_usd }) {
  await ensureSchema();
  const st = await getActiveState(userWallet);
  if (!st) return { ok:false, reason:"no-active" };

  const capped = Math.min(Number(fs_winnings_raw_usd || 0), Number(WELCOME_CFG.free_spins.max_win || 0));
  if (Number(st.fs_count || 0) <= 0) return { ok:false, reason:"no-fs-left" };

  const addWr = capped * Number(WELCOME_CFG.wagering.multiplier || 40);
  const newReq = Number(st.wr_required_units || 0) + Number(addWr);

  await db.pool.query(
    `update welcome_bonus_states set fs_count=0, wr_required_units=$2, updated_at=now() where id=$1`,
    [st.id, Number(newReq)]
  );

  await db.pool.query(
    `insert into welcome_wr_events (user_wallet, game_key, stake_usd, contribution_usd, aux_json, created_at)
     values ($1,$2,$3,$4,$5, now())`,
    [String(st.user_wallet), "fs_settle", 0, 0, JSON.stringify({ fs_winnings_raw_usd, fs_winnings_capped_usd: capped })]
  );

  return { ok:true, fs_winnings_capped_usd: capped, wr_added_units: addWr, new_wr_required_units: newReq };
}

// -------------------- Routes --------------------

// Credit on deposit — NO activation; only record deposit & remember FIRST deposit time.
router.post("/credit-on-deposit", async (req, res) => {
  try {
    await ensureSchema();

    const userWallet = normalizeWallet(req.body?.userWallet);
    const amountSol  = Number(req.body?.amountSol ?? 0);
    const txSig      = req.body?.txSig || null;
    if (!userWallet) return res.status(400).json({ error:"userWallet required", routerVersion: ROUTER_VERSION });
    if (amountSol <= 0) return res.status(400).json({ error:"amountSol must be > 0", routerVersion: ROUTER_VERSION });

    const lam = toLamports(amountSol);

    await db.pool.query(
      `insert into deposits(user_wallet, amount_lamports, tx_sig) values ($1,$2,$3)`,
      [String(userWallet), String(lam), txSig]
    );

    await db.pool.query(
      `insert into welcome_bonuses(user_wallet, first_deposit_lamports, first_deposit_at, claimed, claimed_at, claimed_tx_sig)
       values ($1, $2, now(), false, null, null)
       on conflict (user_wallet) do update
         set first_deposit_lamports = greatest(welcome_bonuses.first_deposit_lamports, excluded.first_deposit_lamports),
             first_deposit_at      = coalesce(welcome_bonuses.first_deposit_at, excluded.first_deposit_at)`,
      [String(userWallet), String(lam)]
    );

    res.json({ ok:true, depositedLamports: lam.toString(), routerVersion: ROUTER_VERSION });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e), routerVersion: ROUTER_VERSION });
  }
});

// Claim — transfer FIRST, then activate + mark claimed in a single transaction.
router.post("/claim", async (req, res) => {
  const userWallet = normalizeWallet(req.body?.userWallet);
  if (!userWallet) return res.status(400).json({ error:"userWallet required", routerVersion: ROUTER_VERSION });

  const client = await db.pool.connect();
  try {
    await ensureSchema();
    await client.query("BEGIN");

    // Lock row
    const wbSel = await client.query(
      `select user_wallet, first_deposit_lamports, first_deposit_at, claimed, claimed_tx_sig
         from welcome_bonuses where user_wallet=$1 for update`,
      [String(userWallet)]
    );
    let wb = wbSel.rows[0] || null;

    // If previously claimed WITH proof, do not re-claim
    if (wb && wb.claimed && wb.claimed_tx_sig) {
      await client.query("ROLLBACK");
      return res.json({ ok:true, alreadyClaimed:true, txSig: wb.claimed_tx_sig, routerVersion: ROUTER_VERSION });
    }

    // Establish claim window
    let firstAt = wb?.first_deposit_at ? new Date(wb.first_deposit_at) : null;
    if (!firstAt) {
      const d = await client.query(
        `select min(created_at) as first_at from deposits where user_wallet=$1`,
        [String(userWallet)]
      );
      if (d.rows[0]?.first_at) firstAt = new Date(d.rows[0].first_at);
    }

    if (!firstAt) {
      const dep = await client.query(
        `select coalesce(sum(amount_lamports),0)::bigint as s from deposits where user_wallet=$1`,
        [String(userWallet)]
      );
      const totalLamports = BigInt(dep.rows[0]?.s || 0n);
      if (totalLamports <= 0n) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Not eligible: make a deposit first", routerVersion: ROUTER_VERSION });
      }
      await client.query(
        `insert into welcome_bonuses(user_wallet, first_deposit_lamports, first_deposit_at, claimed, claimed_at, claimed_tx_sig)
         values ($1, $2, now(), false, null, null)
         on conflict (user_wallet) do update
           set first_deposit_lamports = greatest(welcome_bonuses.first_deposit_lamports, excluded.first_deposit_lamports),
               first_deposit_at      = coalesce(welcome_bonuses.first_deposit_at, excluded.first_deposit_at)`,
        [String(userWallet), String(totalLamports)]
      );
      firstAt = new Date();
    }

    // Window check
    const deadline = new Date(firstAt.getTime());
    deadline.setUTCDate(deadline.getUTCDate() + Number(WELCOME_CFG.claim_window_days || 14));
    if (new Date() > deadline) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Claim window expired", routerVersion: ROUTER_VERSION });
    }

    // Calculate bonus from all deposits
    const dep = await client.query(
      `select coalesce(sum(amount_lamports),0)::bigint as s from deposits where user_wallet=$1`,
      [String(userWallet)]
    );
    const totalLamports = BigInt(dep.rows[0]?.s || 0n);
    if (totalLamports <= 0n) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Not eligible: make a deposit first", routerVersion: ROUTER_VERSION });
    }

    const depUsd = await lamportsToUsdDynamic(totalLamports);
    const { bonusUsd, wrRequired, maxBetUsd } = computeBonusFromUsd(depUsd);
    if (!(bonusUsd > 0)) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Bonus amount not available", routerVersion: ROUTER_VERSION });
    }

    // ---- Do the transfer FIRST ----
    const bonusLamports = await usdToLamports(bonusUsd);
    let transferRes;
    try {
      transferRes = await depositBonusToVault({
        userWallet,
        lamports: Number(Math.floor(bonusLamports)),
      });
    } catch (err) {
      await client.query("ROLLBACK");
      if (err && err.code === "VAULT_NOT_ACTIVATED") {
        return res.status(400).json({
          error: "Vault not activated. Ask the user to open the app once to initialize their vault (create PDA) and try again.",
          details: err.details || null,
          routerVersion: ROUTER_VERSION,
        });
      }
      if (err && err.code === "HOUSE_FUNDS_INSUFFICIENT") {
        return res.status(503).json({ error: "House funds insufficient for transfer", routerVersion: ROUTER_VERSION });
      }
      return res.status(500).json({ error: `Bonus transfer failed: ${err?.message || String(err)}`, routerVersion: ROUTER_VERSION });
    }

    const txSig = typeof transferRes === "string" ? transferRes : (transferRes?.txSig || transferRes?.signature);
    const toVault = typeof transferRes === "object" ? (transferRes?.toVault || transferRes?.vault || transferRes?.pda) : undefined;
    if (!txSig) {
      await client.query("ROLLBACK");
      return res.status(500).json({ error: "Bonus transfer failed: empty txSig", routerVersion: ROUTER_VERSION });
    }

    // ---- Now: activate state & mark claimed WITH txSig (atomic) ----
    await upsertActiveStateWithClient(client, userWallet, { bonusUsd, wrRequired, maxBetUsd });

    await client.query(
      `insert into welcome_bonuses(user_wallet, first_deposit_lamports, first_deposit_at, claimed, claimed_at, claimed_tx_sig)
       values ($1, $2, $3, true, now(), $4)
       on conflict (user_wallet) do update set
         claimed=true,
         claimed_at=now(),
         claimed_tx_sig=$4,
         first_deposit_lamports = greatest(welcome_bonuses.first_deposit_lamports, excluded.first_deposit_lamports),
         first_deposit_at = coalesce(welcome_bonuses.first_deposit_at, excluded.first_deposit_at)`,
      [String(userWallet), String(totalLamports), firstAt.toISOString(), String(txSig)]
    );

    await client.query("COMMIT");

    // Optional: record activity
    try {
      if (typeof db.recordActivity === "function") {
        await db.recordActivity({
          user: userWallet,
          action: "Welcome bonus claimed",
          amount: (Number(bonusLamports) / 1e9).toFixed(4),
          txSig,
        });
      }
    } catch {}

    return res.json({
      ok: true,
      txSig,
      toVault,
      bonusLamports: Number(bonusLamports),
      bonusUsd: Number(bonusUsd),
      expiresAt: expiresAtDate().toISOString(),
      routerVersion: ROUTER_VERSION,
    });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    const msg = e?.message || String(e);
    return res.status(500).json({ error: msg, routerVersion: ROUTER_VERSION });
  } finally {
    client.release();
  }
});

// Read state (+ claimed/claimable flags for UI)
router.get("/state", async (req, res) => {
  try {
    await ensureSchema();

    const wallet = normalizeWallet(req.query.userWallet || req.query.wallet);
    if (!wallet) return res.status(400).json({ error:"userWallet required", routerVersion: ROUTER_VERSION });

    await expireIfNeeded(wallet);

    const [usdPerSol, stRows, wb] = await Promise.all([
      getSolUsdPrice(),
      db.pool.query(
        `select id,user_wallet,name,bonus_amount_usd,wr_required_units,wr_progress_units,coefficient,expires_at,max_bet_usd,status,fs_count,fs_value_usd,fs_max_win_usd,
                to_char(expires_at,'YYYY-MM-DD"T"HH24:MI:SS"Z"') as expires_at_iso
           from welcome_bonus_states
          where user_wallet=$1 and name=$2
          order by created_at desc limit 1`,
        [String(wallet), String(WELCOME_CFG.name)]
      ),
      getWelcomeMeta(wallet)
    ]);

    const st = stRows.rows[0] || null;

    // Only consider claimed if we have proof (tx sig)
    const claimed = Boolean(wb?.claimed && wb?.claimed_tx_sig);

    if (st) {
      const claimable = st.status === "active" && !claimed && new Date(st.expires_at) > new Date();
      return res.json({ ...st, usd_per_sol: usdPerSol, claimed, claimable, status: st.status, routerVersion: ROUTER_VERSION });
    }

    // No active state: check pre-claim eligibility
    if (!claimed) {
      let firstAt = wb?.first_deposit_at ? new Date(wb.first_deposit_at) : null;
      if (!firstAt) {
        try {
          const { rows } = await db.pool.query(
            `select min(created_at) as first_at from deposits where user_wallet=$1`,
            [String(wallet)]
          );
          if (rows[0]?.first_at) firstAt = new Date(rows[0].first_at);
        } catch {}
      }

      if (firstAt) {
        const deadline = new Date(firstAt.getTime());
        deadline.setUTCDate(deadline.getUTCDate() + Number(WELCOME_CFG.claim_window_days || 14));
        const withinWindow = new Date() <= deadline;

        const { totalLamports } = await sumDeposits(wallet, null);
        const depUsd = await lamportsToUsdDynamic(totalLamports);
        const { bonusUsd } = computeBonusFromUsd(depUsd);

        if (withinWindow && bonusUsd > 0) {
          return res.json({
            status: "eligible",
            usd_per_sol: usdPerSol,
            claimed: false,
            claimable: true,
            eligible_bonus_usd: Number(bonusUsd),
            claim_deadline_iso: deadline.toISOString(),
            routerVersion: ROUTER_VERSION,
          });
        }

        return res.json({
          status: "none",
          usd_per_sol: usdPerSol,
          claimed: false,
          claimable: false,
          claim_deadline_iso: deadline.toISOString(),
          routerVersion: ROUTER_VERSION,
        });
      }
    }

    return res.json({ status:"none", usd_per_sol: usdPerSol, claimed:Boolean(claimed), claimable:false, routerVersion: ROUTER_VERSION });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e), routerVersion: ROUTER_VERSION });
  }
});

// Forfeit (unlock withdrawals by dropping bonus)
router.post("/forfeit", async (req, res) => {
  try {
    await ensureSchema();
    const wallet = normalizeWallet(req.body?.userWallet);
    if (!wallet) return res.status(400).json({ error:"userWallet required", routerVersion: ROUTER_VERSION });
    if (!WELCOME_CFG.allow_forfeit_to_withdraw) return res.status(400).json({ error:"forfeit is disabled", routerVersion: ROUTER_VERSION });
    await forfeitBonus(wallet);
    res.json({ ok:true, forfeited:true, routerVersion: ROUTER_VERSION });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e), routerVersion: ROUTER_VERSION });
  }
});

// Can I bet? (accepts USD or Lamports; enforces max bet ONLY when active)
router.get("/can-bet", async (req, res) => {
  try {
    await ensureSchema();
    const wallet  = normalizeWallet(req.query?.userWallet || req.query?.wallet);
    const gameKey = String(req.query?.game || "").toLowerCase();

    let stakeUsd  = Number(req.query?.stakeUsd || 0);
    const stakeLam= req.query?.stakeLamports != null ? BigInt(String(req.query?.stakeLamports)) : null;

    if (!wallet)  return res.status(400).json({ error:"userWallet required", routerVersion: ROUTER_VERSION });
    if (!gameKey) return res.status(400).json({ error:"game required", routerVersion: ROUTER_VERSION });

    if (!stakeUsd && stakeLam !== null) stakeUsd = await lamportsToUsdDynamic(stakeLam);
    if (!(stakeUsd > 0)) return res.status(400).json({ error:"stake required", routerVersion: ROUTER_VERSION });

    const st = await getActiveState(wallet);
    if (!st) return res.json({ ok:true, allowed:true, reason:"no-active", routerVersion: ROUTER_VERSION });

    if (new Date(st.expires_at) < new Date()) return res.json({ ok:false, allowed:false, reason:"expired", routerVersion: ROUTER_VERSION });

    const maxBetUsd = calcMaxBetUsd(st.bonus_amount_usd); // min(10% of bonus, $5)
    if (stakeUsd > maxBetUsd + 1e-9) {
      return res.json({ ok:true, allowed:false, reason:"max-bet-exceeded", maxBetUsd, stakeUsd, routerVersion: ROUTER_VERSION });
    }

    const rate = getContributionRate(gameKey);
    return res.json({ ok:true, allowed:true, maxBetUsd, contributionRate: rate, coefficient: Number(st.coefficient || 0.2), routerVersion: ROUTER_VERSION });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e), routerVersion: ROUTER_VERSION });
  }
});

// Server-to-server bet settle → WR
router.post("/report_bet", async (req, res) => {
  try {
    await ensureSchema();
    if (!assertBackendAuth(req)) return res.status(401).json({ error:"unauthorized", routerVersion: ROUTER_VERSION });

    const userWallet = normalizeWallet(req.body?.userWallet);
    const gameKey    = String(req.body?.gameKey || req.body?.game || "").toLowerCase();
    let   stakeUsd   = Number(req.body?.stakeUsd || 0);
    const stakeLam   = req.body?.stakeLamports != null ? BigInt(String(req.body?.stakeLamports)) : null;
    const aux        = req.body?.aux || {};

    if (!userWallet) return res.status(400).json({ error:"userWallet required", routerVersion: ROUTER_VERSION });
    if (!gameKey)    return res.status(400).json({ error:"gameKey required", routerVersion: ROUTER_VERSION });

    if (!stakeUsd && (stakeLam !== null)) stakeUsd = await lamportsToUsdDynamic(stakeLam);
    if (stakeUsd <= 0) return res.status(400).json({ error:"stake must be > 0", routerVersion: ROUTER_VERSION });

    if (!aux.ip_masked_a) aux.ip_masked_a = maskIp(getClientIp(req));

    const out = await applyWagerContribution({ userWallet, game_key: gameKey, stakeUsd, aux });
    res.json({ ...out, routerVersion: ROUTER_VERSION });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e), routerVersion: ROUTER_VERSION });
  }
});

module.exports = router;
