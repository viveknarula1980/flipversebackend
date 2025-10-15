// backend/promos_router.js
const express = require("express");
const router = express.Router();
const db = require("./db");
const affiliateService = require("./affiliate_service")(db.pool);


// ---------- config & utils ----------
const big = (v) => (v == null ? null : String(v));

const USD_PER_SOL = Number(process.env.USD_PER_SOL || 200);

// Referral / Affiliate knobs
const REFERRAL_RAKEBACK_BOOST_BPS = Number(process.env.AFF_REFERRAL_RAKEBACK_BOOST_BPS || 1000); // +10%
const REFERRAL_RAKEBACK_BOOST_DAYS = Number(process.env.AFF_RAKEBACK_DAYS || 7);

const QUICK_UNLOCK_BONUS_USD = Number(process.env.AFF_QUICK_BONUS_USD || 5);
const QUICK_UNLOCK_MIN_FIRST_DEPOSIT_USD = Number(process.env.AFF_FIRST_DEPOSIT_MIN_USD || 20);
const QUICK_UNLOCK_DAILY_CAP_USD = Number(process.env.AFF_QUICK_BONUS_DAILY_CAP_USD || 100);

// Bonus tracker knobs
const AFF_DAILY_REFERRAL_TARGET = Number(process.env.AFF_DAILY_REFERRAL_TARGET || 5);
const AFF_NEXT_MILESTONE_USD = Number(process.env.AFF_NEXT_MILESTONE_USD || 10);

// one-code-per-user hard rule
const ENFORCE_SINGLE_CODE = true;

// Welcome bonus config
const WELCOME_NAME = "ZOGGY_WELCOME_400";
const WELCOME_DEPOSIT_MULT = 4.0;
const WELCOME_BONUS_CAP_USD = 2000;
const WELCOME_WR_MULT = 40;
const WELCOME_COEFF = 0.2;
const WELCOME_EXPIRES_DAYS = 14;
const WELCOME_MAXBET_PERCENT_OF_BONUS = 0.10;
const WELCOME_MAXBET_HARDCAP_USD = 5.0;
const WELCOME_FS = { count: 30, game_id: "memeslot", value_usd: 0.25, max_win_usd: 30 };

// ---- Game key normalization (aliases) ----
const KEY_ALIASES = {
  slot: "memeslot",
  slots: "memeslot",
  slots_spins: "memeslot",
  memeslot: "memeslot",
  meme: "memeslot",
  mine: "mines",
  mines: "mines",
  crash: "crash",
  plinko: "plinko",
  dice: "dice",
  coinflip: "coinflip_pvp",
  coinflip_pvp: "coinflip_pvp",
};
const normalizeGameKey = (raw) => {
  const k = String(raw || "").trim().toLowerCase();
  return KEY_ALIASES[k] || k;
};

// WR eligible contribution rates per game
const CONTRIBUTION_RATES = {
  memeslot: 1.0,
  crash: 0.6,
  plinko: 0.6,
  mines: 0.6,
  dice: 0.6,
  coinflip_pvp: 0.10,
};

const COINFLIP_UNIQUE_OPP_REQ = Number(process.env.BONUS_COINFLIP_MIN_UNIQUE_OPPONENTS || 5);
const COINFLIP_DAILY_WR_CAP_USD = Number(process.env.BONUS_COINFLIP_DAILY_WR_CAP_USD || 200);

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || process.env.SITE_URL || "https://api.zoggy.io";
// where the API is hosted (used to build the /r/:code tracker link we show to users)
const API_BASE =
  process.env.API_BASE_URL ||
  process.env.NEXT_PUBLIC_API_URL ||
  `http://localhost:${process.env.PORT || 4000}`;

// ---- Bonus Milestones (configurable) ----
// You can override with JSON via AFF_BONUS_MILESTONES_JSON
let BONUS_MILESTONES = [];
try {
  BONUS_MILESTONES = JSON.parse(process.env.AFF_BONUS_MILESTONES_JSON || "[]");
} catch (_) {
  BONUS_MILESTONES = [];
}
if (!Array.isArray(BONUS_MILESTONES) || BONUS_MILESTONES.length === 0) {
  BONUS_MILESTONES = [
    { id: "daily-achiever",   title: "Daily Achiever",   minReferrals: 5,  rewardUsd: 25,  icon: "🎯" },
    { id: "super-recruiter",  title: "Super Recruiter",  minReferrals: 10, rewardUsd: 50,  icon: "🚀" },
    { id: "elite-affiliate",  title: "Elite Affiliate",  minReferrals: 20, rewardUsd: 100, icon: "👑" },
  ];
}

// ---------- Chest prize pools (as per requirement) ----------
// Daily Chest prizes & probabilities:
// 35%  2× Deposit Booster (max 3 SOL)
// 45%  +50% Deposit Booster (no cap specified)
// 7.5% 20 Free Spins (20 × $0.10)
// 7.5% 10 Free Spins (10 × $0.15)
// 5%   $10 Direct Bonus
const DAILY_PRIZES = [
  { key: "deposit_booster_2x_cap_3SOL", weight: 35 },
  { key: "deposit_booster_+50pct_uncapped", weight: 45 },
  { key: "freespins_20_x_0.10", weight: 7.5 },
  { key: "freespins_10_x_0.15", weight: 7.5 },
  { key: "direct_bonus_usd_10", weight: 5 },
];

// Weekly Chest (claim condition: 7 daily chests in a row):
// 30%  2× Deposit Booster (max 1 SOL)
// 10%  +50% Deposit Booster (max 10 SOL)
// 10%  +30% Deposit Booster (max 50 SOL)
// 10%  30 Free Spins (30 × $0.20)
// 40%  50 Free Spins (50 × $0.10)
const WEEKLY_PRIZES = [
  { key: "deposit_booster_2x_cap_1SOL", weight: 30 },
  { key: "deposit_booster_+50pct_cap_10SOL", weight: 10 },
  { key: "deposit_booster_+30pct_cap_50SOL", weight: 10 },
  { key: "freespins_30_x_0.20", weight: 10 },
  { key: "freespins_50_x_0.10", weight: 40 },
];

// ---------- small utils ----------
function toLamports(sol) {
  const n = Number(sol);
  return (!isFinite(n) || n < 0) ? 0n : BigInt(Math.round(n * 1e9));
}
function lamportsToUsd(l) { return (Number(l) / 1e9) * USD_PER_SOL; }
function solToUsd(sol) { return Number(sol) * USD_PER_SOL; }

function pickWeighted(prizes) {
  const total = prizes.reduce((s, p) => s + p.weight, 0);
  let r = Math.random() * total;
  for (const p of prizes) {
    r -= p.weight;
    if (r <= 0) return p.key;
  }
  return prizes[prizes.length - 1].key;
}

function utcDate(d = new Date()) { return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); }
function dateToYMD(d) {
  const y = d.getUTCFullYear(), m = String(d.getUTCMonth()+1).padStart(2,"0"), da = String(d.getUTCDate()).padStart(2,"0");
  return `${y}-${m}-${da}`;
}
function getClientIp(req) {
  const xf = (req.headers["x-forwarded-for"] || "").toString().split(",")[0].trim();
  return xf || req.ip || req.connection?.remoteAddress || "";
}
function maskIp(ip) {
  if (!ip) return null;
  const s = String(ip);
  if (s.includes(":")) return s.split(":").slice(0,4).join(":") + ":****";
  const parts = s.split(".");
  if (parts.length !== 4) return s;
  return `${parts[0]}.${parts[1]}.***.***`;
}
const mask = (w) => w ? `${String(w).slice(0,4)}****${String(w).slice(-2)}` : "user";

// wallet normalizer (treats "undefined"/"null" as empty)
function normalizeWallet(input) {
  const s = (input === undefined || input === null) ? "" : String(input).trim();
  if (!s) return "";
  const lc = s.toLowerCase();
  if (lc === "undefined" || lc === "null") return "";
  return s;
}

// ---------- ensure needed tables (idempotent, types chosen to match schema.sql) ----------
(async () => {
  try {
    // click tracking
    await db.pool.query(`
      create table if not exists affiliate_link_clicks (
        id bigserial primary key,
        code text not null,
        affiliate_wallet text not null,
        clicked_wallet text null,
        device_id text null,
        ip inet null,
        user_agent text null,
        referer text null,
        landing_url text null,
        created_at timestamptz not null default now()
      );
      create index if not exists idx_aff_clicks_aff on affiliate_link_clicks(affiliate_wallet);
      create index if not exists idx_aff_clicks_code on affiliate_link_clicks(code);
      create index if not exists idx_aff_clicks_created on affiliate_link_clicks(created_at);
    `);
    await db.pool.query(`
      create unique index if not exists uniq_click_aff_device_day
      on affiliate_link_clicks (affiliate_wallet, coalesce(device_id, ''), (created_at::date));
    `);
    await db.pool.query(`
      create unique index if not exists uniq_click_aff_clicked_wallet_day
      on affiliate_link_clicks (affiliate_wallet, clicked_wallet, (created_at::date))
      where clicked_wallet is not null;
    `);
    await db.pool.query(`
      create unique index if not exists uniq_click_aff_ipua_day
      on affiliate_link_clicks (
        affiliate_wallet,
        (case when family(ip)=4 then set_masklen(ip::cidr,24) else set_masklen(ip::cidr,48) end),
        left(coalesce(user_agent,''),64),
        (created_at::date)
      )
      where ip is not null;
    `);

    // ensure created_at on referrals (for analytics)
    await db.pool.query(`alter table if exists referrals add column if not exists created_at timestamptz not null default now();`);

    // promos_claims / device_fingerprints (types aligned with schema.sql)
    await db.pool.query(`
      create table if not exists promos_claims (
        id bigserial primary key,
        type       text not null check (type in ('daily','weekly')),
        user_wallet text not null,
        date_utc   text not null,
        ip         text,
        device_id  text,
        prize_key  text not null,
        details    jsonb not null default '{}'::jsonb,
        week_key   text,
        created_at timestamptz not null default now()
      );
      create index if not exists idx_promos_claims_user on promos_claims(user_wallet);
      create index if not exists idx_promos_claims_type on promos_claims(type);
      create index if not exists idx_promos_claims_date on promos_claims(date_utc);
      create index if not exists idx_promos_claims_created on promos_claims(created_at);
    `);
    await db.pool.query(`
      do $$
      begin
        if not exists (select 1 from pg_indexes where schemaname='public' and indexname='uniq_daily_claim') then
          execute 'create unique index uniq_daily_claim on promos_claims(user_wallet, date_utc) where type = ''daily''';
        end if;
        if not exists (select 1 from pg_indexes where schemaname='public' and indexname='uniq_weekly_claim') then
          execute 'create unique index uniq_weekly_claim on promos_claims(user_wallet, week_key) where type = ''weekly''';
        end if;
      end$$;
    `);

    await db.pool.query(`
      create table if not exists device_fingerprints (
        device_id   text primary key,
        user_wallet text,
        bound_at    timestamptz not null default now()
      );
      create index if not exists idx_device_fps_user on device_fingerprints(user_wallet);
    `);

    // minimal tables used by other sections (safe no-ops if exist)
    await db.pool.query(`
      create table if not exists deposits (
        id bigserial primary key,
        user_wallet text not null,
        amount_lamports bigint not null,
        tx_sig text null,
        created_at timestamptz not null default now()
      );
      create table if not exists user_xp (
        user_wallet text primary key,
        xp bigint not null default 0,
        lvl int not null default 1,
        updated_at timestamptz not null default now()
      );
      create table if not exists xp_levels (
        lvl int primary key,
        xp_required bigint not null
      );
      create table if not exists xp_rewards_claims (
        id bigserial primary key,
        user_wallet text not null,
        lvl int not null,
        created_at timestamptz not null default now(),
        unique(user_wallet, lvl)
      );
    `);
  } catch (e) {
    console.warn("[bootstrap ensure] failed:", e?.message || e);
  }
})();

// ---------- helper: prize details payloads ----------
function prizeDetailsFromKey(key) {
  switch (key) {
    case "deposit_booster_2x_cap_3SOL":
      return { type: "deposit_booster", multiplier: 2.0, capLamports: BigInt(3e9).toString(), note: "Daily" };
    case "deposit_booster_+50pct_uncapped":
      return { type: "deposit_booster", multiplier: 1.5, capLamports: null, note: "Daily" };
    case "freespins_20_x_0.10":
      return { type: "free_spins", count: 20, gameId: "memeslot", valueUsd: 0.10, maxWinUsd: 20 * 0.10 * 10 };
    case "freespins_10_x_0.15":
      return { type: "free_spins", count: 10, gameId: "memeslot", valueUsd: 0.15, maxWinUsd: 10 * 0.15 * 10 };
    case "direct_bonus_usd_10":
      return { type: "direct_usd", usd: 10, lamports: toLamports(10 / USD_PER_SOL).toString() };

    case "deposit_booster_2x_cap_1SOL":
      return { type: "deposit_booster", multiplier: 2.0, capLamports: BigInt(1e9).toString(), note: "Weekly" };
    case "deposit_booster_+50pct_cap_10SOL":
      return { type: "deposit_booster", multiplier: 1.5, capLamports: BigInt(10e9).toString(), note: "Weekly" };
    case "deposit_booster_+30pct_cap_50SOL":
      return { type: "deposit_booster", multiplier: 1.3, capLamports: BigInt(50e9).toString(), note: "Weekly" };
    case "freespins_30_x_0.20":
      return { type: "free_spins", count: 30, gameId: "memeslot", valueUsd: 0.20, maxWinUsd: 30 * 0.20 * 10 };
    case "freespins_50_x_0.10":
      return { type: "free_spins", count: 50, gameId: "memeslot", valueUsd: 0.10, maxWinUsd: 50 * 0.10 * 10 };
  }
  return { type: "mystery" };
}

// ---------- Daily / Weekly chest helpers ----------
async function didWagerOnDate(wallet, ymd) {
  // game_rounds
  if (await db._tableExistsUnsafe?.("game_rounds")) {
    const { rows } = await db.pool.query(
      `select 1 from game_rounds where player=$1 and created_at::date = $2::date limit 1`,
      [String(wallet), ymd]
    );
    if (rows.length) return true;
  }
  // coinflip
  if (await db._tableExistsUnsafe?.("coinflip_matches")) {
    const { rows } = await db.pool.query(
      `select 1
         from coinflip_matches
        where (player_a=$1 or player_b=$1) and created_at::date = $2::date
        limit 1`,
      [String(wallet), ymd]
    );
    if (rows.length) return true;
  }
  // slots
  if (await db._tableExistsUnsafe?.("slots_spins")) {
    const { rows } = await db.pool.query(
      `select 1 from slots_spins where player=$1 and created_at::date = $2::date limit 1`,
      [String(wallet), ymd]
    );
    if (rows.length) return true;
  }
  return false;
}

// consecutive days with both "wagered" and "daily chest claimed"
async function dailyStreak(wallet, upToUtc = utcDate()) {
  let streak = 0;
  for (let i = 0; i < 365; i++) {
    const d = new Date(upToUtc);
    d.setUTCDate(d.getUTCDate() - i);
    const ymd = dateToYMD(d);

    const w = await didWagerOnDate(wallet, ymd);
    if (!w) break;

    const { rows } = await db.pool.query(
      `select 1 from promos_claims where type='daily' and user_wallet=$1 and date_utc=$2 limit 1`,
      [String(wallet), ymd]
    );
    if (!rows.length) break;

    streak += 1;
  }
  return streak;
}

function isoWeekKey(d = utcDate()) {
  const dt = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  // Monday as first day of week
  const day = (dt.getUTCDay() || 7);
  dt.setUTCDate(dt.getUTCDate() - (day - 1));
  const jan4 = new Date(Date.UTC(dt.getUTCFullYear(), 0, 4));
  const weekStart = new Date(jan4);
  const jan4Day = (jan4.getUTCDay() || 7);
  weekStart.setUTCDate(jan4.getUTCDate() - (jan4Day - 1));
  const diff = Math.round((dt - weekStart) / (24 * 3600 * 1000));
  const week = Math.floor(diff / 7) + 1;
  return `${dt.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

// anti-farm: one chest per IP/device per day per type
async function antiFarmGate({ type, ymd, ip, deviceId }) {
  const { rows } = await db.pool.query(
    `select 1
       from promos_claims
      where type=$1 and date_utc=$2
        and (
          ($3::text is not null and ip = $3::text)
          or ($4::text is not null and device_id = $4::text)
        )
      limit 1`,
    [String(type), ymd, ip || null, deviceId || null]
  );
  return rows.length === 0;
}

// ---------- Chest routes ----------
router.get("/chest/daily/eligibility", async (req, res) => {
  try {
    const wallet = normalizeWallet(req.query.wallet);
    const deviceId = req.query.deviceId ? String(req.query.deviceId) : null;
    if (!wallet) return res.status(400).json({ error: "wallet is required" });

    const today = utcDate();
    const ymd = dateToYMD(today);
    const wageredToday = await didWagerOnDate(wallet, ymd);
    if (!wageredToday) {
      return res.json({ eligible: false, reason: "no wager today", streak: 0 });
    }

    const already = await db.pool.query(
      `select 1 from promos_claims where type='daily' and user_wallet=$1 and date_utc=$2 limit 1`,
      [String(wallet), ymd]
    );
    const streak = await dailyStreak(wallet, today);
    if (already.rows.length) {
      return res.json({ eligible: false, reason: "already claimed today", streak });
    }

    // IP/device gate preview
    const ip = getClientIp(req);
    const ok = await antiFarmGate({ type: "daily", ymd, ip, deviceId });
    if (!ok) return res.json({ eligible: false, reason: "limit: one chest per IP/device per day", streak });

    res.json({ eligible: true, reason: null, streak });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

router.post("/chest/daily/claim", async (req, res) => {
  try {
    const userWallet = normalizeWallet(req.body?.userWallet);
    const deviceId = req.body?.deviceId ? String(req.body.deviceId) : null;
    if (!userWallet) return res.status(400).json({ error: "userWallet is required" });

    const today = utcDate();
    const ymd = dateToYMD(today);
    if (!(await didWagerOnDate(userWallet, ymd))) {
      return res.status(400).json({ error: "must wager at least once today to unlock daily chest" });
    }

    const dupe = await db.pool.query(
      `select 1 from promos_claims where type='daily' and user_wallet=$1 and date_utc=$2 limit 1`,
      [String(userWallet), ymd]
    );
    if (dupe.rows.length) return res.status(409).json({ error: "already claimed today" });

    const ip = String(getClientIp(req) || "");
    const ok = await antiFarmGate({ type: "daily", ymd, ip, deviceId });
    if (!ok) return res.status(429).json({ error: "limit: one chest per IP/device per day" });

    const prize_key = pickWeighted(DAILY_PRIZES);
    const details = prizeDetailsFromKey(prize_key);

    const ins = await db.pool.query(
      `insert into promos_claims(type, user_wallet, date_utc, ip, device_id, prize_key, details)
       values ('daily', $1, $2, $3, $4, $5, $6)
       returning id, created_at`,
      [String(userWallet), ymd, ip, deviceId, prize_key, JSON.stringify(details)]
    );

    res.json({
      ok: true,
      prize: prize_key,
      details,
      claimId: String(ins.rows[0].id),
      claimedAt: new Date(ins.rows[0].created_at).toISOString(),
    });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});
router.get("/chest/weekly/eligibility", async (req, res) => {
  try {
    const wallet = normalizeWallet(req.query.wallet);
    if (!wallet) return res.status(400).json({ error: "wallet is required" });

    // must have 7 consecutive daily chest claims (each daily claim itself required wagers)
    let ok = true;
    let message = null;

    for (let i = 0; i < 7; i++) {
      const d = utcDate(); d.setUTCDate(d.getUTCDate() - i);
      const ymd = dateToYMD(d);
      const { rows } = await db.pool.query(
        `select 1 from promos_claims where type='daily' and user_wallet=$1 and date_utc=$2 limit 1`,
        [String(wallet), ymd]
      );
      if (!rows.length) {
        ok = false;
        message = "Requires 7 consecutive daily chest claims.";
        break;
      }
    }

    // also, not already claimed this ISO week
    if (ok) {
      const wk = isoWeekKey(utcDate());
      const { rows } = await db.pool.query(
        `select 1 from promos_claims where type='weekly' and user_wallet=$1 and week_key=$2 limit 1`,
        [String(wallet), wk]
      );
      if (rows.length) {
        ok = false;
        message = "Already claimed this week.";
      }
    }

    res.json({ eligible: ok, message });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});


router.post("/chest/weekly/claim", async (req, res) => {
  try {
    const userWallet = normalizeWallet(req.body?.userWallet);
    const deviceId = req.body?.deviceId ? String(req.body.deviceId) : null;
    if (!userWallet) return res.status(400).json({ error: "userWallet is required" });

    // require 7 consecutive daily chests
    for (let i = 0; i < 7; i++) {
      const d = utcDate(); d.setUTCDate(d.getUTCDate() - i);
      const ymd = dateToYMD(d);
      const { rows } = await db.pool.query(
        `select 1 from promos_claims where type='daily' and user_wallet=$1 and date_utc=$2 limit 1`,
        [String(userWallet), ymd]
      );
      if (!rows.length) return res.status(400).json({ error: "requires 7 daily chests in a row" });
    }

    const today = utcDate();
    const ymd = dateToYMD(today);
    const week_key = isoWeekKey(today);

    const already = await db.pool.query(
      `select 1 from promos_claims where type='weekly' and user_wallet=$1 and week_key=$2 limit 1`,
      [String(userWallet), week_key]
    );
    if (already.rows.length) return res.status(409).json({ error: "already claimed this week" });

    // anti-farm (per day still applies)
    const ip = String(getClientIp(req) || "");
    const ok = await antiFarmGate({ type: "weekly", ymd, ip, deviceId });
    if (!ok) return res.status(429).json({ error: "limit: one chest per IP/device per day" });

    const prize_key = pickWeighted(WEEKLY_PRIZES);
    const details = prizeDetailsFromKey(prize_key);

    const ins = await db.pool.query(
      `insert into promos_claims(type, user_wallet, date_utc, ip, device_id, prize_key, details, week_key)
       values ('weekly', $1, $2, $3, $4, $5, $6, $7)
       returning id, created_at`,
      [String(userWallet), ymd, ip, deviceId, prize_key, JSON.stringify(details), week_key]
    );

    res.json({
      ok: true,
      prize: prize_key,
      details,
      claimId: String(ins.rows[0].id),
      claimedAt: new Date(ins.rows[0].created_at).toISOString(),
    });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// ---------- Admin: Chests ----------
router.get("/admin/chests", async (req, res) => {
  try {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit || 200)));
    const { rows } = await db.pool.query(
      `select id, user_wallet, type, date_utc, week_key, prize_key, details, created_at
         from promos_claims
        order by created_at desc
        limit $1`,
      [limit]
    );

    const out = rows.map((r) => {
      let rewardValue = 0;
      let rewardType = "Other";
      const d = r.details || {};
      try {
        if (d.type === "direct_usd") {
          rewardValue = Number(d.usd || 0);
          rewardType = "USD";
        } else if (d.type === "free_spins") {
          rewardValue = Number(d.count || 0);
          rewardType = `FS@$${Number(d.valueUsd || 0).toFixed(2)}`;
        } else if (d.type === "deposit_booster") {
          rewardValue = Number(d.multiplier || 0);
          rewardType = d.capLamports ? `Booster (cap ${(Number(d.capLamports)/1e9).toFixed(2)} SOL)` : "Booster (uncapped)";
        }
      } catch (_) {}

      // daily expires end of that UTC day
      const dt = new Date(`${r.date_utc || dateToYMD(utcDate())}T00:00:00Z`);
      const expiresAt = r.type === "daily" ? new Date(dt.getTime() + (24 * 3600 * 1000) - 1).toISOString() : null;

      return {
        id: String(r.id),
        walletAddress: r.user_wallet,
        chestType: r.type,
        status: "claimed",
        claimedAt: (r.created_at?.toISOString?.()) || r.created_at,
        expiresAt,
        rewardValue,
        rewardType,
      };
    });

    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

router.get("/admin/chests/stats", async (_req, res) => {
  try {
    const { rows: tot } = await db.pool.query(`select count(*)::int as c from promos_claims`);
    const { rows: d } = await db.pool.query(`select count(*)::int as c from promos_claims where type='daily'`);
    const { rows: w } = await db.pool.query(`select count(*)::int as c from promos_claims where type='weekly'`);
    const { rows: act } = await db.pool.query(
      `select count(distinct user_wallet)::int as c
         from promos_claims
        where created_at >= now() - interval '30 days'`
    );
    const { rows: direct } = await db.pool.query(
      `select coalesce(sum((details->>'usd')::numeric),0)::numeric as s
         from promos_claims
        where details->>'type' = 'direct_usd'`
    );

    // naive claim-rate: last 7d daily claims / unique wagerers last 7d
    const { rows: daily7 } = await db.pool.query(
      `select count(*)::int as c
         from promos_claims
        where type='daily' and created_at >= now() - interval '7 days'`
    );
    // unique wagerers last 7 days (from available tables)
    const { rows: wagers7 } = await db.pool.query(`
      with u as (
        select distinct player as w from game_rounds where created_at >= now() - interval '7 days'
        union
        select distinct player_a as w from coinflip_matches where created_at >= now() - interval '7 days'
        union
        select distinct player_b as w from coinflip_matches where created_at >= now() - interval '7 days'
      )
      select count(*)::int as c from u
    `);

    const claimRate =
      Number(wagers7[0]?.c || 0) > 0
        ? (Number(daily7[0]?.c || 0) / Number(wagers7[0]?.c || 0)) * 100
        : 0;

    res.json({
      totalChests: Number(tot[0]?.c || 0),
      dailyChests: Number(d[0]?.c || 0),
      weeklyChests: Number(w[0]?.c || 0),
      premiumChests: 0,
      totalClaimed: Number(tot[0]?.c || 0),
      totalValue: Number(direct[0]?.s || 0),
      activeUsers: Number(act[0]?.c || 0),
      claimRate: Number(claimRate.toFixed(1)),
    });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// ---------- XP ----------
const fs = require("fs");
const path = require("path");
const XP_JSON_PATH = path.join(process.cwd(), "xp_table.json");

router.get("/xp/table", async (_req,res) => {
  try {
    const txt = fs.readFileSync(XP_JSON_PATH, "utf8");
    res.json(JSON.parse(txt));
  } catch (e) {
    res.status(500).json({ error: "xp_table.json missing or invalid JSON", detail: e?.message || String(e) });
  }
});

router.post("/xp/add", async (req, res) => {
  try {
    const userWallet = normalizeWallet(req.body?.userWallet);
    const amount = Number(req.body?.amount);
    if (!userWallet || !Number.isFinite(amount)) return res.status(400).json({ error: "userWallet and numeric amount required" });
    const delta = BigInt(Math.max(0, Math.floor(amount)));

    const cur = await db.pool.query(`select xp from user_xp where user_wallet=$1`, [String(userWallet)]);
    const currentXp = BigInt(cur.rows[0]?.xp || 0);
    const newXp = currentXp + delta;

    const { rows: lvls } = await db.pool.query(`select lvl, xp_required from xp_levels order by lvl asc`);
    let newLvl = 1; for (const r of lvls) if (newXp >= BigInt(r.xp_required)) newLvl = Math.max(newLvl, Number(r.lvl));

    await db.pool.query(
      `insert into user_xp(user_wallet, xp, lvl, updated_at)
       values ($1,$2,$3,now())
       on conflict (user_wallet) do update set xp=$2, lvl=$3, updated_at=now()`,
      [String(userWallet), big(newXp.toString()), Number(newLvl)]
    );
    res.json({ ok: true, xp: newXp.toString(), lvl: newLvl });
  } catch (e) { res.status(500).json({ error: e?.message || String(e) }); }
});

router.post("/xp/claim", async (req, res) => {
  try {
    const userWallet = normalizeWallet(req.body?.userWallet);
    const level = Number(req.body?.level);
    if (!userWallet || !Number.isFinite(level)) return res.status(400).json({ error: "userWallet and level required" });

    const { rows: ux } = await db.pool.query(`select lvl from user_xp where user_wallet=$1`, [String(userWallet)]);
    const curLvl = Number(ux[0]?.lvl || 1);
    if (curLvl < level) return res.status(400).json({ error: "level not reached" });

    await db.pool.query(
      `insert into xp_rewards_claims(user_wallet, lvl) values ($1,$2) on conflict do nothing`,
      [String(userWallet), level]
    );
    res.json({ ok: true, claimed: true, lvl: level });
  } catch (e) { res.status(500).json({ error: e?.message || String(e) }); }
});

// ---------- Affiliates ----------

// affiliate code helpers
async function generateUniqueCode(base) {
  let final = base, suffix = 0;
  while (true) {
    const { rows } = await db.pool.query(`select 1 from affiliates where code=$1`, [final]);
    if (rows.length === 0) break;
    suffix += 1; final = `${base}${suffix}`;
  }
  return final;
}
function baseFromWallet(wallet) {
  return (String(wallet).slice(0, 6)).replace(/[^a-z0-9]/gi, "").toUpperCase() || "AFF" + Math.random().toString(36).slice(2, 8).toUpperCase();
}
/** One immutable code per wallet (creates if missing). */
async function ensureAffiliateCodeForWallet(wallet) {
  const w = String(wallet);
  const ex = await db.pool.query(`select code from affiliates where owner_wallet=$1 limit 1`, [w]);
  if (ex.rows[0]?.code) return ex.rows[0].code;

  const base = baseFromWallet(w);
  const final = await generateUniqueCode(base);

  await db.pool.query(
    `insert into affiliates(code, owner_wallet, rakeback_bps, revshare_bps)
     values ($1,$2,$3,$4)
     on conflict (owner_wallet) do nothing`,
    [final, w, 100, 500]
  );

  const again = await db.pool.query(`select code from affiliates where owner_wallet=$1 limit 1`, [w]);
  return again.rows[0]?.code || final;
}

// CORE: Affiliate revshare + rakeback credit
async function creditAffiliateAndRakeback({ player, game_key, round_id, stakeLamports, payoutLamports }) {
  const ply = String(player);
  const stake = BigInt(stakeLamports ?? 0);
  const payout = BigInt(payoutLamports ?? 0);
  const ngr = stake - payout;

  if (ngr <= 0n) return { ngr: ngr.toString(), rakebackLamports: "0", affiliateCommissionLamports: "0" };

  const { rows: refRows } = await db.pool.query(
    `select r.affiliate_code, r.referrer_wallet, r.bound_at, a.rakeback_bps, a.revshare_bps
     from referrals r
     join affiliates a on a.code = r.affiliate_code
     where r.referred_wallet = $1
     limit 1`, [ply]
  );
  if (refRows.length === 0) {
    return { ngr: ngr.toString(), rakebackLamports: "0", affiliateCommissionLamports: "0" };
  }

  const { affiliate_code, referrer_wallet, bound_at, rakeback_bps, revshare_bps } = refRows[0];
  let rbBps = Number(rakeback_bps || 0);
  if (bound_at) {
    const diffDays = Math.floor((Date.now() - new Date(bound_at).getTime()) / (24*3600*1000));
    if (diffDays <= REFERRAL_RAKEBACK_BOOST_DAYS) rbBps += REFERRAL_RAKEBACK_BOOST_BPS;
  }

  const rakeback = (ngr * BigInt(rbBps)) / 10000n;
  const affiliateCut = (ngr * BigInt(Number(revshare_bps || 0))) / 10000n;

  const normalizedGameKey = normalizeGameKey(game_key);

  await db.pool.query(
    `insert into affiliate_commissions
      (affiliate_code, referrer_wallet, referred_wallet, game_key, round_id, ngr_lamports, rakeback_lamports, affiliate_commission_lamports)
     values ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [ affiliate_code, referrer_wallet, ply, String(normalizedGameKey||""), round_id==null?null:Number(round_id),
      big(ngr.toString()), big(rakeback.toString()), big(affiliateCut.toString()) ]
  );

  return {
    ngr: ngr.toString(),
    rakebackLamports: rakeback.toString(),
    affiliateCommissionLamports: affiliateCut.toString(),
  };
}

// Welcome Bonus
async function activateWelcomeBonus(userWallet, firstDepositLamports) {
  const depUsd = lamportsToUsd(firstDepositLamports || 0);
  const bonusUsd = Math.min(depUsd * WELCOME_DEPOSIT_MULT, WELCOME_BONUS_CAP_USD);
  if (bonusUsd <= 0) return { ok:false, reason:"zero deposit" };

  const wrRequired = bonusUsd * WELCOME_WR_MULT;
  const maxBetUsd = Math.min(bonusUsd * WELCOME_MAXBET_PERCENT_OF_BONUS, WELCOME_MAXBET_HARDCAP_USD);
  const expiresAt = new Date(Date.now() + WELCOME_EXPIRES_DAYS*24*3600*1000);

  await db.pool.query(
    `insert into welcome_bonus_states
      (user_wallet, name, bonus_amount_usd, wr_required_units, wr_progress_units, coefficient, expires_at, max_bet_usd, status, fs_count, fs_value_usd, fs_max_win_usd)
     values ($1,$2,$3,$4,0,$5,$6,$7,'active',$8,$9,$10)
     on conflict (user_wallet, name) do nothing`,
    [
      String(userWallet), WELCOME_NAME, Number(bonusUsd), Number(wrRequired),
      Number(WELCOME_COEFF), expiresAt.toISOString(), Number(maxBetUsd),
      WELCOME_FS.count, WELCOME_FS.value_usd, WELCOME_FS.max_win_usd
    ]
  );
  return { ok:true, bonusUsd, wrRequired, maxBetUsd, expiresAt };
}

async function applyWagerContribution({ userWallet, game_key, stakeLamports }) {
  const { rows } = await db.pool.query(
    `select * from welcome_bonus_states where user_wallet=$1 and name=$2 and status='active' limit 1`,
    [String(userWallet), WELCOME_NAME]
  );
  const st = rows[0];
  if (!st) return { ok:false, reason:"no active welcome bonus" };

  if (st.expires_at && new Date(st.expires_at).getTime() < Date.now()) {
    await db.pool.query(`update welcome_bonus_states set status='expired' where user_wallet=$1 and name=$2`,
      [String(userWallet), WELCOME_NAME]);
    return { ok:false, reason:"bonus expired" };
  }

  const stakeUsd = lamportsToUsd(BigInt(stakeLamports || 0));
  if (stakeUsd > Number(st.max_bet_usd || 0)) {
    return { ok:true, counted:false, reason:"stake exceeds max-bet for active bonus" };
  }

  // normalize incoming key (aliases -> canonical)
  let key = normalizeGameKey(game_key);
  if (!CONTRIBUTION_RATES[key]) return { ok:true, counted:false, reason:"ineligible game" };
  let rate = CONTRIBUTION_RATES[key];

  if (key === "coinflip_pvp") {
    // anti-collusion / unique opponent checks
    const oppRows = await db.pool.query(`
      with m as (
        select player_a as a, player_b as b, created_at from coinflip_matches where player_a=$1
        union all
        select player_b as a, player_a as b, created_at from coinflip_matches where player_b=$1
      )
      select count(distinct b) as c
      from m
      where created_at >= now() - interval '14 days' and b is not null`, [String(userWallet)]);
    const uniqOpp = Number(oppRows.rows[0]?.c || 0);
    if (uniqOpp < COINFLIP_UNIQUE_OPP_REQ) {
      return { ok:true, counted:false, reason:`coinflip unique opponents < ${COINFLIP_UNIQUE_OPP_REQ}` };
    }

    const capRows = await db.pool.query(
      `select coalesce(sum(contribution_usd),0)::float8 as usd
       from welcome_wr_events
       where user_wallet=$1 and game_key in ('coinflip','coinflip_pvp') and created_at::date=now()::date`, [String(userWallet)]
    );
    const todayUsd = Number(capRows.rows[0]?.usd || 0);
    if (todayUsd >= COINFLIP_DAILY_WR_CAP_USD) {
      return { ok:true, counted:false, reason:"daily WR cap reached for coinflip" };
    }
  }

  const contribution = stakeUsd * Number(st.coefficient || WELCOME_COEFF) * rate;

  await db.pool.query(
    `insert into welcome_wr_events(user_wallet, game_key, stake_usd, contribution_usd)
     values ($1,$2,$3,$4)`,
    [String(userWallet), key, Number(stakeUsd), Number(contribution)]
  );

  const newProg = Math.min(Number(st.wr_progress_units || 0) + Number(contribution), Number(st.wr_required_units || 0));
  const cleared = newProg >= Number(st.wr_required_units || 0);

  await db.pool.query(
    `update welcome_bonus_states
       set wr_progress_units=$3, status=case when $3 >= wr_required_units then 'cleared' else status end
     where user_wallet=$1 and name=$2`,
    [String(userWallet), WELCOME_NAME, Number(newProg)]
  );

  return { ok:true, counted:true, contributionUsd: contribution, cleared };
}

// ---------- Affiliates API ----------

// Create or get immutable code
router.post("/affiliates/code", async (req, res) => {
  try {
    const wallet = normalizeWallet(req.body?.wallet);
    const rakebackBps = Number(req.body?.rakebackBps);
    const revshareBps = Number(req.body?.revshareBps);
    if (!wallet) return res.status(400).json({ error: "wallet is required" });

    // if exists, return it — never change (immutable policy)
    const existing = await db.pool.query(`select code, rakeback_bps, revshare_bps from affiliates where owner_wallet=$1 limit 1`, [String(wallet)]);
    if (existing.rows[0]?.code && ENFORCE_SINGLE_CODE) {
      return res.json({ code: existing.rows[0].code, rakebackBps: existing.rows[0].rakeback_bps ?? 100, revshareBps: existing.rows[0].revshare_bps ?? 500 });
    }

    const base = baseFromWallet(wallet);
    const final = await generateUniqueCode(base);
    const rb = Number.isFinite(rakebackBps) ? Math.max(0, Math.min(10000, rakebackBps)) : 100;
    const rs = Number.isFinite(revshareBps) ? Math.max(0, Math.min(10000, revshareBps)) : 500;

    // create only if missing
    await db.pool.query(
      `insert into affiliates(code, owner_wallet, rakeback_bps, revshare_bps)
       values ($1,$2,$3,$4)
       on conflict (owner_wallet) do nothing`,
      [final, String(wallet), rb, rs]
    );

    const { rows: out } = await db.pool.query(`select code, rakeback_bps, revshare_bps from affiliates where owner_wallet=$1`, [String(wallet)]);
    res.json({ code: out[0].code, rakebackBps: out[0].rakeback_bps, revshareBps: out[0].revshare_bps });
  } catch (e) { res.status(500).json({ error: e?.message || String(e) }); }
});

// ensure-code helper
router.get("/affiliates/me/ensure-code", async (req, res) => {
  try {
    const wallet = normalizeWallet(req.query.wallet);
    if (!wallet) return res.status(400).json({ error: "wallet is required" });
    const code = await ensureAffiliateCodeForWallet(wallet);
    res.json({ code });
  } catch (e) { res.status(500).json({ error: e?.message || String(e) }); }
});

router.get("/affiliates/:code", async (req, res) => {
  try {
    const code = String(req.params.code).toUpperCase();
    const { rows } = await db.pool.query(`select * from affiliates where code=$1`, [code]);
    if (!rows[0]) return res.status(404).json({ error: "code not found" });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e?.message || String(e) }); }
});

router.post("/referrals/bind", async (req, res) => {
  try {
    const code = String(req.body?.code || "").toUpperCase();
    const userWallet = normalizeWallet(req.body?.userWallet);
    const deviceId = req.body?.deviceId ? String(req.body.deviceId) : null;
if (!code || !userWallet) return res.status(400).json({ error: "Invalid input: code and userWallet required" });

    const { rows: aff } = await db.pool.query(`select owner_wallet from affiliates where code=$1`, [code]);
    if (!aff[0]) return res.status(400).json({ error: "invalid code" });
if (String(aff[0].owner_wallet) === String(userWallet)) return res.status(400).json({ error: "You cannot refer yourself." });

    const exists = await db.pool.query(`select 1 from referrals where referred_wallet=$1`, [String(userWallet)]);
if (exists.rows.length > 0) return res.status(200).json({ ok:true, alreadyBound:true });

    if (deviceId) {
      await db.pool.query(
        `insert into device_fingerprints(device_id, user_wallet)
         values ($1,$2)
         on conflict (device_id) do update set user_wallet=excluded.user_wallet, bound_at=now()`,
        [deviceId, String(userWallet)]
      );
    }

    await db.pool.query(
      `insert into referrals (affiliate_code, referrer_wallet, referred_wallet, device_id)
       select code, owner_wallet, $1, $2 from affiliates where code=$3`,
      [String(userWallet), deviceId, code]
    );

    res.json({ ok:true });
  } catch (e) { res.status(500).json({ error: e?.message || String(e) }); }
});

router.get("/referrals/me", async (req, res) => {
  try {
    const wallet = normalizeWallet(req.query.wallet);
    if (!wallet) return res.status(400).json({ error: "wallet is required" });
    const { rows } = await db.pool.query(
      `select r.*, a.owner_wallet, a.rakeback_bps, a.revshare_bps
         from referrals r join affiliates a on a.code = r.affiliate_code
        where r.referred_wallet=$1 limit 1`, [wallet]
    );
    res.json(rows[0] || null);
  } catch (e) { res.status(500).json({ error: e?.message || String(e) }); }
});

// First deposit hook
router.post("/referrals/first-deposit", async (req, res) => {
  try {
    const userWallet = normalizeWallet(req.body?.userWallet);
    const amountSol = Number(req.body?.amountSol ?? 0);
    const txSig = req.body?.txSig || null;
    if (!userWallet) return res.status(400).json({ error: "userWallet is required" });

    const lam = toLamports(amountSol);
    await db.pool.query(
      `insert into deposits(user_wallet, amount_lamports, tx_sig) values ($1,$2,$3)`,
      [String(userWallet), String(lam), txSig]
    );

    const { rows:first } = await db.pool.query(
      `select sum(amount_lamports)::bigint as s from deposits where user_wallet=$1`, [String(userWallet)]
    );
    const total = BigInt(first[0]?.s || 0);
    await db.pool.query(
      `insert into welcome_bonuses(user_wallet, first_deposit_lamports, claimed)
       values ($1,$2,false)
       on conflict (user_wallet) do update set first_deposit_lamports = greatest(welcome_bonuses.first_deposit_lamports, excluded.first_deposit_lamports)`,
      [String(userWallet), String(total)]
    );

    await activateWelcomeBonus(String(userWallet), lam);

    const usd = solToUsd(amountSol);
    if (usd >= QUICK_UNLOCK_MIN_FIRST_DEPOSIT_USD) {
      const { rows: r } = await db.pool.query(
        `select r.affiliate_code, r.referrer_wallet, a.owner_wallet
           from referrals r join affiliates a on a.code=r.affiliate_code
          where r.referred_wallet=$1 limit 1`, [String(userWallet)]
      );
      if (r[0]) {
        const affWallet = r[0].referrer_wallet;
        if (String(affWallet) !== String(userWallet)) {
          const { rows: cap } = await db.pool.query(
            `select coalesce(sum(amount_usd),0)::float8 as s
               from affiliate_quick_bonuses
              where affiliate_wallet=$1 and created_at::date=now()::date`, [String(affWallet)]
          );
          const today = Number(cap[0]?.s || 0);
          if (today + QUICK_UNLOCK_BONUS_USD <= QUICK_UNLOCK_DAILY_CAP_USD) {
            await db.pool.query(
              `insert into affiliate_quick_bonuses(affiliate_wallet, referred_wallet, amount_usd)
               values ($1,$2,$3)`,
              [String(affWallet), String(userWallet), QUICK_UNLOCK_BONUS_USD]
            );
          }
        }
      }
    }

    res.json({ ok:true, depositedLamports: lam.toString() });
  } catch (e) { res.status(500).json({ error: e?.message || String(e) }); }
});

// // Welcome claim marker
// router.post("/welcome/claim", async (req, res) => {
//   try {
//     const userWallet = normalizeWallet(req.body?.userWallet);
//     if (!userWallet) return res.status(400).json({ error: "userWallet required" });

//     const { rows:w } = await db.pool.query(`select * from welcome_bonuses where user_wallet=$1`, [String(userWallet)]);
//     const row = w[0];
//     if (!row || BigInt(row.first_deposit_lamports) <= 0n) return res.status(400).json({ error:"no eligible deposit" });
//     if (row.claimed) return res.json({ ok:true, alreadyClaimed:true, claimedAt: row.claimed_at });

//     await db.pool.query(`update welcome_bonuses set claimed=true, claimed_at=now() where user_wallet=$1`, [String(userWallet)]);
//     res.json({ ok:true, message:"Welcome bonus marked claimed." });
//   } catch (e) { res.status(500).json({ error: e?.message || String(e) }); }
// });

// ---------- Admin: Affiliate overview ----------
router.get("/affiliates/admin/summary", async (_req, res) => {
  try {
    const { rows } = await db.pool.query(`
      with ngr as (
        select referrer_wallet, sum(ngr_lamports)::bigint as ngr
        from affiliate_commissions group by referrer_wallet
      ),
      comm as (
        select referrer_wallet, sum(affiliate_commission_lamports)::bigint as c
        from affiliate_commissions group by referrer_wallet
      ),
      refs as (
        select referrer_wallet, count(*)::int as cnt from referrals group by referrer_wallet
      ),
      active as (
        select referrer_wallet, count(distinct referred_wallet)::int as act
        from affiliate_commissions group by referrer_wallet
      )
      select a.owner_wallet as affiliate_wallet,
             coalesce(refs.cnt,0) as total_referrals,
             coalesce(active.act,0) as active_referrals,
             coalesce(ngr.ngr,0)::text as ngr_lamports,
             coalesce(comm.c,0)::text as commissions_lamports
      from affiliates a
      left join refs on refs.referrer_wallet=a.owner_wallet
      left join ngr  on ngr.referrer_wallet=a.owner_wallet
      left join comm on comm.referrer_wallet=a.owner_wallet
      left join active on active.referrer_wallet=a.owner_wallet
      order by commissions_lamports::numeric desc nulls last
    `);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e?.message || String(e) }); }
});

// ---------- Frontend dashboard helpers ----------

// Stats / summary
router.get("/affiliates/me/summary", async (req, res) => {
  try {
    const wallet = normalizeWallet(req.query.wallet);
    if (!wallet) return res.status(400).json({ error: "wallet is required" });

    await ensureAffiliateCodeForWallet(wallet);

    const { rows: refs } = await db.pool.query(
      `select count(*)::int as cnt from referrals where referrer_wallet=$1`, [wallet]
    );
    const { rows: active } = await db.pool.query(
      `select count(distinct referred_wallet)::int as act
         from affiliate_commissions where referrer_wallet=$1`,
      [wallet]
    );
    const { rows: comm } = await db.pool.query(
      `select coalesce(sum(affiliate_commission_lamports),0)::bigint as lam
         from affiliate_commissions where referrer_wallet=$1`,
      [wallet]
    );
    const { rows: pend } = await db.pool.query(
      `select coalesce(sum(amount_usd),0)::float8 as usd
         from affiliate_quick_bonuses
        where affiliate_wallet=$1 and created_at::date=now()::date`,
      [wallet]
    );
    const { rows: w } = await db.pool.query(
      `with t as (
        select
          case when created_at >= now() - interval '7 days' then 1 else 0 end as bucket,
          affiliate_commission_lamports::bigint as lam
        from affiliate_commissions
        where referrer_wallet=$1
          and created_at >= now() - interval '14 days'
      )
      select
        coalesce(sum(case when bucket=1 then lam end),0)::bigint as cur,
        coalesce(sum(case when bucket=0 then lam end),0)::bigint as prev
      from t`,
      [wallet]
    );
    const curLam = Number(w[0]?.cur || 0);
    const prevLam = Number(w[0]?.prev || 0);
    const weekChangePct = prevLam > 0 ? ((curLam - prevLam) / prevLam) * 100 : (curLam > 0 ? 100 : 0);
    const { rows: m } = await db.pool.query(
      `select coalesce(sum(affiliate_commission_lamports),0)::bigint as lam
         from affiliate_commissions
        where referrer_wallet=$1 and date_trunc('month',created_at)=date_trunc('month',now())`,
      [wallet]
    );

    const totalCommissionUsd = lamportsToUsd(BigInt(comm[0]?.lam || 0n));
    const monthlyCommissionUsd = lamportsToUsd(BigInt(m[0]?.lam || 0n));

    res.json({
      totalReferrals: Number(refs[0]?.cnt || 0),
      activeReferrals: Number(active[0]?.act || 0),
      totalCommission: +totalCommissionUsd.toFixed(2),
      pendingBonuses: Number(pend[0]?.usd || 0),
      weeklyGrowth: +weekChangePct.toFixed(2),
      monthlyCommission: +monthlyCommissionUsd.toFixed(2),
    });
  } catch (e) { res.status(500).json({ error: e?.message || String(e) }); }
});

// Bonus tracker
router.get("/affiliates/me/bonus", async (req, res) => {
  try {
    const wallet = normalizeWallet(req.query.wallet);
    if (!wallet) return res.status(400).json({ error: "wallet is required" });

    // how many referred today
    const { rows: r0 } = await db.pool.query(
      `select count(*)::int as c
         from referrals
        where referrer_wallet=$1
          and coalesce(created_at, bound_at)::date = now()::date`,
      [String(wallet)]
    );
    const dailyReferrals = Number(r0[0]?.c || 0);

    // total quick unlock already granted
    const { rows: r1 } = await db.pool.query(
      `select coalesce(sum(amount_usd),0)::float8 as s
         from affiliate_quick_bonuses
        where affiliate_wallet=$1`,
      [String(wallet)]
    );
    const totalBonusEarned = Number(r1[0]?.s || 0);

    // unlocked bonus today
    const { rows: r2 } = await db.pool.query(
      `select coalesce(sum(amount_usd),0)::float8 as s
         from affiliate_quick_bonuses
        where affiliate_wallet=$1
          and created_at::date = now()::date`,
      [String(wallet)]
    );
    const unlockedBonus = Number(r2[0]?.s || 0);

    // simple activity streak (consecutive days with at least 1 referral)
    let streakDays = 0;
    for (let i = 0; i < 365; i++) {
      const { rows } = await db.pool.query(
        `select 1
           from referrals
          where referrer_wallet=$1
            and coalesce(created_at, bound_at)::date = (now()::date - $2::int)
          limit 1`,
        [String(wallet), i]
      );
      if (rows.length) streakDays += 1; else break;
    }

    res.json({
      dailyReferrals,
      dailyTarget: AFF_DAILY_REFERRAL_TARGET,
      unlockedBonus,
      nextMilestone: AFF_NEXT_MILESTONE_USD,
      streakDays,
      totalBonusEarned
    });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// Per-wallet Bonus Milestones (achieved true/false) + bonus summary
router.get("/affiliates/me/bonus-milestones", async (req, res) => {
  try {
    const wallet = normalizeWallet(req.query.wallet);
    if (!wallet) return res.status(400).json({ error: "wallet is required" });

    // daily referrals (today)
    const { rows: r0 } = await db.pool.query(
      `select count(*)::int as c
         from referrals
        where referrer_wallet=$1
          and coalesce(created_at, bound_at)::date = now()::date`,
      [String(wallet)]
    );
    const dailyReferrals = Number(r0[0]?.c || 0);

    // lifetime quick bonuses
    const { rows: r1 } = await db.pool.query(
      `select coalesce(sum(amount_usd),0)::float8 as s
         from affiliate_quick_bonuses
        where affiliate_wallet=$1`,
      [String(wallet)]
    );
    const totalBonusEarned = Number(r1[0]?.s || 0);

    // today's quick bonuses
    const { rows: r2 } = await db.pool.query(
      `select coalesce(sum(amount_usd),0)::float8 as s
         from affiliate_quick_bonuses
        where affiliate_wallet=$1
          and created_at::date = now()::date`,
      [String(wallet)]
    );
    const unlockedBonus = Number(r2[0]?.s || 0);

    // build user-specific milestones
    const milestones = BONUS_MILESTONES.map(m => ({
      id: String(m.id),
      title: String(m.title),
      requirement: `${Number(m.minReferrals)} referrals/day`,
      reward: `$${Number(m.rewardUsd)}`,
      achieved: dailyReferrals >= Number(m.minReferrals),
      icon: String(m.icon || "🎯"),
    }));

    res.json({
      milestones,
      dailyReferrals,
      totalBonusEarned,
      unlockedBonus,
      dailyTarget: AFF_DAILY_REFERRAL_TARGET,
      nextMilestone: AFF_NEXT_MILESTONE_USD,
    });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// Time series for charts
router.get("/affiliates/me/commissions", async (req, res) => {
  try {
    const wallet = normalizeWallet(req.query.wallet);
    if (!wallet) return res.status(400).json({ error: "wallet is required" });

    const { rows: best } = await db.pool.query(`
      with r as (
        select
          to_char(date_trunc('day', created_at), 'Dy') as day,
          date_trunc('day', created_at) as d,
          game_key,
          coalesce(sum(affiliate_commission_lamports),0)::bigint as lam
        from affiliate_commissions
        where referrer_wallet=$1
          and created_at >= now() - interval '7 days'
        group by 1,2,3
      )
      select distinct on (d) day, d, game_key, lam
      from r
      order by d asc, lam desc
    `, [wallet]);

    let week = best
      .sort((a,b)=> new Date(a.d).getTime() - new Date(b.d).getTime())
      .map(r => ({
        day: String(r.day),
        amount: +(lamportsToUsd(BigInt(r.lam || 0n)).toFixed(2)),
        game: String(r.game_key || "—"),
      }));

    if (!week.length) {
      const labels = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];
      week = labels.map(l => ({ day: l, amount: 0, game: "—" }));
    }

    const { rows: w } = await db.pool.query(`
      select
        to_char(date_trunc('week', created_at), '"W"IW') as period,
        min(date_trunc('week', created_at)) as wstart,
        coalesce(sum(affiliate_commission_lamports),0)::bigint as lam
      from affiliate_commissions
      where referrer_wallet=$1
        and created_at >= now() - interval '28 days'
      group by 1
      order by wstart asc
    `, [wallet]);

    let month = w.map(r => ({ period: String(r.period), amount: +(lamportsToUsd(BigInt(r.lam || 0n)).toFixed(2)) }));
    if (!month.length) month = [{ period: "W01", amount: 0 },{ period: "W02", amount: 0 },{ period: "W03", amount: 0 },{ period: "W04", amount: 0 }];

    res.json({ week, month });
  } catch (e) { res.status(500).json({ error: e?.message || String(e) }); }
});

// Game breakdown
router.get("/affiliates/me/games", async (req, res) => {
  try {
    const wallet = normalizeWallet(req.query.wallet);
    if (!wallet) return res.status(400).json({ error: "wallet is required" });
    const { rows } = await db.pool.query(`
      select game_key, coalesce(sum(affiliate_commission_lamports),0)::bigint as lam
      from affiliate_commissions
      where referrer_wallet=$1
      group by game_key
      order by lam desc nulls last
    `, [wallet]);

    const totalLam = rows.reduce((s, r) => s + Number(r.lam || 0), 0);
    const palette = ["bg-red-500","bg-blue-500","bg-green-500","bg-yellow-500","bg-purple-500","bg-pink-500"];
    let out = rows.map((r,i)=>{
      const usd = lamportsToUsd(BigInt(r.lam || 0n));
      const pct = totalLam>0 ? (Number(r.lam)*100/totalLam) : 0;
      return {
        game: String(r.game_key || "other"),
        amount: +usd.toFixed(2),
        percentage: +pct.toFixed(1),
        color: palette[i % palette.length],
      };
    });

    if (!out.length) out = [{ game: "—", amount: 0, percentage: 0, color: "bg-gray-500" }];

    res.json(out);
  } catch (e) { res.status(500).json({ error: e?.message || String(e) }); }
});

// ---- NEW: wager aggregation helper for Activity feed ----
async function _wageredCteForReferrals(db) {
  const parts = [];

  if (await db._tableExistsUnsafe?.("game_rounds")) {
    parts.push(`
      select player as wallet,
             sum(stake_lamports)::bigint as amount,
             max(created_at) as last_ts
      from game_rounds
      group by player
    `);
  }

  if (await db._tableExistsUnsafe?.("bets")) {
    parts.push(`
      select player as wallet,
             sum(bet_amount_lamports)::bigint as amount,
             max(created_at) as last_ts
      from bets
      group by player
    `);
  }

  if (await db._tableExistsUnsafe?.("coinflip_matches")) {
    parts.push(`
      select player_a as wallet,
             sum(bet_lamports*2)::bigint as amount,
             max(created_at) as last_ts
      from coinflip_matches
      group by player_a
      union all
      select player_b as wallet,
             sum(bet_lamports*2)::bigint as amount,
             max(created_at) as last_ts
      from coinflip_matches
      group by player_b
    `);
  }

  if (await db._tableExistsUnsafe?.("slots_spins")) {
    // slots bet_amount is in SOL; convert to lamports
    parts.push(`
      select player as wallet,
             sum( (bet_amount*1e9)::bigint ) as amount,
             max(created_at) as last_ts
      from slots_spins
      group by player
    `);
  }

  if (!parts.length) {
    return `
      w as (
        select ''::text as wallet, 0::bigint as wag, now() as last_wager_at
        where false
      )
    `;
  }

  return `
    w as (
      select wallet, sum(amount)::bigint as wag, max(last_ts) as last_wager_at
      from (
        ${parts.join("\n      union all\n")}
      ) _all
      group by wallet
    )
  `;
}

// Activity feed (fixed to show real wagered amounts & latest activity from wagers or commissions)
router.get("/affiliates/me/activity", async (req, res) => {
  try {
    const wallet = normalizeWallet(req.query.wallet);
    if (!wallet) return res.status(400).json({ error: "wallet is required" });

    const wCte = await _wageredCteForReferrals(db);

    const sql = `
      with r as (
        select referred_wallet, min(bound_at) as first_at
        from referrals where referrer_wallet=$1 group by referred_wallet
      ),
      d as (
        select user_wallet, min(created_at) as first_dep, count(*)::int as dep_cnt
        from deposits group by user_wallet
      ),
      c as (
        select referred_wallet, 
               coalesce(sum(affiliate_commission_lamports),0)::bigint as comm,
               coalesce(sum(ngr_lamports),0)::bigint as ngr,
               max(created_at) as last_comm_at
        from affiliate_commissions
        where referrer_wallet=$1
        group by referred_wallet
      ),
      ${wCte}
      select
        r.referred_wallet,
        r.first_at,
        d.first_dep,
        d.dep_cnt,
        c.comm,
        c.ngr,
        w.wag,
        greatest(coalesce(c.last_comm_at, to_timestamp(0)),
                 coalesce(w.last_wager_at,  to_timestamp(0))) as last_act
      from r
      left join d on d.user_wallet = r.referred_wallet
      left join c on c.referred_wallet = r.referred_wallet
      left join w on w.wallet = r.referred_wallet
      order by coalesce(greatest(w.last_wager_at, c.last_comm_at), r.first_at) desc
      limit 50
    `;

    const { rows } = await db.pool.query(sql, [wallet]);

    const out = rows.map((r, i) => {
      const wagerUsd = lamportsToUsd(BigInt(r.wag || 0n));
      const commUsd  = lamportsToUsd(BigInt(r.comm || 0n));
      const hasActivity = Boolean(r.last_act) || Number(r.dep_cnt || 0) > 0 || Number(r.wag || 0) > 0;
      return {
        id: i+1,
        username: mask(r.referred_wallet),
        firstDeposit: r.first_dep ? new Date(r.first_dep).toISOString().slice(0,10) : null,
        amountWagered: +wagerUsd.toFixed(2),      // true wagered, not NGR
        commissionEarned: +commUsd.toFixed(2),
        status: hasActivity ? 'active' : 'pending',
        lastActivity: r.last_act ? new Date(r.last_act).toISOString() : null,
        totalDeposits: Number(r.dep_cnt || 0),
      };
    });
    res.json(out);
  } catch (e) { res.status(500).json({ error: e?.message || String(e) }); }
});

// ---- Click tracking ----

// Track a click (SPA flow). Dedupe-safe via unique indexes.
router.post("/affiliates/link/click", async (req, res) => {
  try {
    const codeUp = String(req.body?.code || "").toUpperCase();
    const deviceId = req.body?.deviceId ? String(req.body.deviceId) : null;
    const userWallet = normalizeWallet(req.body?.userWallet) || null;
    const landingUrl = req.body?.landingUrl || null;
    const refererUrl = req.body?.refererUrl || null;

    if (!codeUp) return res.status(400).json({ error: "code is required" });

    const { rows: aff } = await db.pool.query(`select owner_wallet from affiliates where code=$1 limit 1`, [codeUp]);
    if (!aff[0]) return res.status(400).json({ error: "invalid code" });

    const affiliateWallet = aff[0].owner_wallet;
    const ip = getClientIp(req);
    const ua = req.headers["user-agent"] ? String(req.headers["user-agent"]).slice(0, 1024) : null;

    try {
      await db.pool.query(
        `insert into affiliate_link_clicks (code, affiliate_wallet, clicked_wallet, device_id, ip, user_agent, referer, landing_url)
         values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [codeUp, String(affiliateWallet), userWallet, deviceId, ip || null, ua, refererUrl || null, landingUrl || null]
      );
      return res.json({ ok: true });
    } catch (err) {
      if (err && err.code === "23505") {
        return res.json({ ok: true, deduped: true });
      }
      throw err;
    }
  } catch (e) { res.status(500).json({ error: e?.message || String(e) }); }
});

// GET tracker: /r/:code → logs click then redirects to SITE_URL with ?ref=CODE
router.get("/r/:code", async (req, res) => {
  try {
    const codeUp = String(req.params.code || "").toUpperCase();
    if (!codeUp) return res.redirect(302, SITE_URL);

    const { rows: aff } = await db.pool.query(`select owner_wallet from affiliates where code=$1 limit 1`, [codeUp]);
    if (!aff[0]) return res.redirect(302, SITE_URL);

    const affiliateWallet = aff[0].owner_wallet;
    const ip = getClientIp(req);
    const ua = req.headers["user-agent"] ? String(req.headers["user-agent"]).slice(0, 1024) : null;
    const clickedWallet = req.query.w ? normalizeWallet(req.query.w) : null;
    const deviceId = req.query.d ? String(req.query.d) : null;
    const refererUrl = req.headers.referer || null;
    const landingUrl = `${SITE_URL}/?ref=${encodeURIComponent(codeUp)}`;

    try {
      await db.pool.query(
        `insert into affiliate_link_clicks (code, affiliate_wallet, clicked_wallet, device_id, ip, user_agent, referer, landing_url)
         values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [codeUp, String(affiliateWallet), clickedWallet || null, deviceId || null, ip || null, ua, refererUrl, landingUrl]
      );
    } catch (err) {
      // ignore dedupe unique_violation
    }

    res.redirect(302, landingUrl);
  } catch (e) {
    res.redirect(302, SITE_URL);
  }
});

// View my clicks
router.get("/affiliates/me/clicks", async (req, res) => {
  try {
    const wallet = normalizeWallet(req.query.wallet);
    if (!wallet) return res.status(400).json({ error: "wallet is required" });

    const { rows } = await db.pool.query(
      `select id, code, clicked_wallet, device_id, ip::text as ip, user_agent, referer, landing_url, created_at
         from affiliate_link_clicks
        where affiliate_wallet=$1
        order by created_at desc
        limit 200`, [wallet]
    );
    const out = rows.map(r => ({
      id: Number(r.id),
      code: String(r.code),
      clickedWallet: r.clicked_wallet ? mask(r.clicked_wallet) : null,
      deviceId: r.device_id ? String(r.device_id) : null,
      ipMasked: maskIp(r.ip),
      userAgent: r.user_agent ? String(r.user_agent).slice(0, 120) : null,
      referer: r.referer || null,
      landingUrl: r.landing_url || null,
      createdAt: new Date(r.created_at).toISOString(),
    }));
    res.json(out);
  } catch (e) { res.status(500).json({ error: e?.message || String(e) }); }
});

// Link stats + code + link (also ensures code exists)
router.get("/affiliates/me/link", async (req,res) => {
  try {
    const wallet = normalizeWallet(req.query.wallet);
    if (!wallet) return res.status(400).json({ error: "wallet is required" });

    const referralCode = await ensureAffiliateCodeForWallet(wallet);

    const { rows: conv } = await db.pool.query(
      `select count(*)::int as c from referrals where referrer_wallet=$1`, [wallet]
    );
    const { rows: clicks } = await db.pool.query(
      `select count(*)::int as c from affiliate_link_clicks where affiliate_wallet=$1`, [wallet]
    );

    const totalClicks = Number(clicks[0]?.c || 0);
    const conversions = Number(conv[0]?.c || 0);
    const conversionRate = totalClicks > 0 ? +(conversions * 100 / totalClicks).toFixed(1) : 0;

    // give the UI a link that hits the API /r/:code tracker
    res.json({
      referralCode,
      referralLink: referralCode ? `${API_BASE}/r/${encodeURIComponent(referralCode)}` : null,
      totalClicks,
      conversions,
      conversionRate,
    });
  } catch (e) { res.status(500).json({ error: e?.message || String(e) }); }
});


// ---------- EXPORTS for WS handlers ----------
router.creditAffiliateAndRakeback = creditAffiliateAndRakeback;
router.applyWagerContribution = applyWagerContribution;
router.activateWelcomeBonus = activateWelcomeBonus;
// at bottom
router.creditAffiliateAndRakeback = async function(args) {
  return affiliateService.creditAffiliateAndRakeback(args);
};


module.exports = router;
