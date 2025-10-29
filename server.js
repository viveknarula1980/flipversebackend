// server.js
require("dotenv").config();

const http = require("http");
const { Server } = require("socket.io");
const express = require("express");
const cors = require("cors");

const bodyParser = require("body-parser");
const {
  PublicKey,
  Connection,
  TransactionMessage,
  VersionedTransaction,
} = require("@solana/web3.js");
const path = require("path");
const { getMessage } = require("./messageUtil");

// small fetch shim (Node 18+ has global fetch)
const fetch =
  global.fetch ||
  ((...args) => import("node-fetch").then(({ default: f }) => f(...args)));

// ---------- RPC / Program IDs ----------
const CLUSTER = process.env.CLUSTER || "https://api.devnet.solana.com";
if (!process.env.PROGRAM_ID) throw new Error("PROGRAM_ID missing in .env");
const PROGRAM_ID = new PublicKey(process.env.PROGRAM_ID);

// shared connection for live PDA lookups
const connection = new Connection(CLUSTER, "confirmed");

const CRASH_PROGRAM_ID =
  process.env.CRASH_PROGRAM_ID ||
  process.env.Crash_PROGRAM_ID ||
  process.env.NEXT_PUBLIC_CRASH_PROGRAM_ID ||
  null;
const PLINKO_PROGRAM_ID =
  process.env.PLINKO_PROGRAM_ID || process.env.NEXT_PUBLIC_PLINKO_PROGRAM_ID || null;
const COINFLIP_PROGRAM_ID =
  process.env.COINFLIP_PROGRAM_ID || process.env.NEXT_PUBLIC_COINFLIP_PROGRAM_ID || null;

const LAMPORTS_PER_SOL = 1e9;

// ---------- DB ----------
let db = require("./db");
global.db = db;

// ---------- Helpers ----------
function pctToBps(x) {
  const n = Math.max(0, Math.min(100, Number(x)));
  return Math.round(n * 100);
}
function normalizeHouseEdgePatch(patch) {
  const he =
    patch?.houseEdgePct ??
    patch?.house_edge_pct ??
    patch?.houseEdge ??
    patch?.house_edge ??
    undefined;
  if (he == null || he === "") return null;
  const fee_bps = pctToBps(he);
  const rtp_bps = Math.max(0, 10000 - fee_bps);
  return { fee_bps, rtp_bps };
}
function isMaybeBase58(s) {
  return typeof s === "string" && s.length >= 32 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(s);
}
function extractWalletFromArgs(args) {
  const a = args?.[0];
  if (a && typeof a === "object") {
    for (const k of [
      "wallet",
      "user",
      "player",
      "address",
      "publicKey",
      "user_id",
      "userId",
    ]) {
      const v = a[k];
      if (isMaybeBase58(v)) return v;
      if (v && typeof v === "object" && isMaybeBase58(v?.toString?.()))
        return v.toString();
    }
  }
  return null;
}
function getClientIp(req) {
  const xf = (req.headers["x-forwarded-for"] || "").toString().split(",")[0].trim();
  return xf || req.ip || req.connection?.remoteAddress || "";
}

// ---------- USDT conversion helpers ----------
const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL || process.env.SITE_URL || "https://api.zoggy.io";
const PORT = Number(process.env.PORT || 4000);

// Build absolute /maintenance URL for redirects
function buildMaintenanceUrl(redirectUrl) {
  const r = String(redirectUrl || "/maintenance");
  if (/^https?:\/\//i.test(r)) return r;
  const base = SITE_URL.replace(/\/$/, "");
  return base + (r.startsWith("/") ? r : "/" + r);
}

const USD_PER_SOL_FALLBACK = Number(process.env.USD_PER_SOL || 200);
let _priceCache = { t: 0, v: USD_PER_SOL_FALLBACK };

async function getSolUsd() {
  try {
    if (Date.now() - _priceCache.t < 30_000 && _priceCache.v > 0) return _priceCache.v;

    const [cbRes, binRes] = await Promise.allSettled([
      fetch("https://api.coinbase.com/v2/prices/SOL-USD/spot", { timeout: 4000 }),
      fetch("https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT", { timeout: 4000 }),
    ]);

    const vals = [];
    if (cbRes.status === "fulfilled") {
      const j = await cbRes.value.json().catch(() => ({}));
      const p = Number(j?.data?.amount);
      if (p > 0) vals.push(p);
    }
    if (binRes.status === "fulfilled") {
      const j = await binRes.value.json().catch(() => ({}));
      const p = Number(j?.price);
      if (p > 0) vals.push(p);
    }
    const price =
      vals.length > 0
        ? vals.reduce((a, b) => a + b, 0) / vals.length
        : USD_PER_SOL_FALLBACK;

    _priceCache = { t: Date.now(), v: price };
    return price;
  } catch {
    return USD_PER_SOL_FALLBACK;
  }
}

const round2 = (x) => Math.round((Number(x) + Number.EPSILON) * 100) / 100;
const solToUsd = (sol, price) => round2(Number(sol) * Number(price || USD_PER_SOL_FALLBACK));
const lamportsToUsd = (lamports, price) =>
  round2((Number(lamports) / LAMPORTS_PER_SOL) * Number(price || USD_PER_SOL_FALLBACK));

// ---------- Classifiers (result buckets) ----------
function classifyTxn(row) {
  const t = String(row.type || "").toLowerCase();
  const status = String(row.status || "").toLowerCase();

  if (t === "deposit") return "deposit";
  if (t === "withdraw") return "withdraw";
  if (status === "refunded" || status === "cancelled") return "refund";
  if (t === "bet") return "bet";

  const amount = Number(row.amount || 0); // stake (SOL)
  const payout = Number(row.payout || 0); // payout (SOL)
  const net = payout - amount;
  if (net > 0) return "win";
  if (net < 0) return "loss";
  return "push";
}
function classifyActivity(r) {
  const a = String(r.action || "").toLowerCase();
  const amt = Number(r.amount || 0); // often SOL, may be signed
  if (a.includes("deposit")) return "deposit";
  if (a.includes("withdraw")) return "withdraw";
  if (a.includes("win")) return "win";
  if (a.includes("freeze") || a.includes("bet")) return "bet";
  if (a.includes("settle")) return amt > 0 ? "win" : "loss";
  if (amt > 0) return "credit";
  if (amt < 0) return "debit";
  return "other";
}

// ---------- PDA helpers (live balance) ----------
function deriveUserVaultPda(playerPk) {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("user_vault"), new PublicKey(playerPk).toBuffer()],
    PROGRAM_ID
  );
  return pda;
}

async function fetchLivePdaLamports(wallet) {
  try {
    const pda = deriveUserVaultPda(wallet);
    const lamports = await connection.getBalance(pda, "confirmed");
    return lamports; // number
  } catch {
    return null;
  }
}

// ---------- PDA balance updaters (DB, **lamports** exact) ----------
async function setAbsolutePdaBalanceLamports(wallet, lamports) {
  const val = Math.max(0, Math.round(Number(lamports) || 0));
  await db.pool.query(
    `insert into app_users (user_id, username, pda_balance, last_active)
       values ($1, $1, $2, now())
     on conflict (user_id)
       do update set pda_balance = excluded.pda_balance, last_active = now()`,
    [String(wallet), val]
  );
}
async function adjustPdaBalanceLamports(wallet, deltaLamports) {
  const delta = Math.round(Number(deltaLamports) || 0);
  await db.pool.query(
    `insert into app_users (user_id, username, pda_balance, last_active)
       values ($1, $1, GREATEST(0, $2), now())
     on conflict (user_id)
       do update set pda_balance = GREATEST(0, app_users.pda_balance + $2), last_active = now()`,
    [String(wallet), delta]
  );
}

// ---------- Welcome-Bonus Lock (unchanged core) ----------
async function ensureWelcomeLockTable() {
  await db.pool.query(`
    create table if not exists welcome_lock_state (
      wallet text primary key,
      cash_exhausted boolean not null default false,
      updated_at timestamptz not null default now()
    );
  `);
}
async function getCashExhausted(wallet) {
  const { rows } = await db.pool.query(
    `select cash_exhausted from welcome_lock_state where wallet=$1`,
    [String(wallet)]
  );
  return Boolean(rows[0]?.cash_exhausted);
}
async function setCashExhausted(wallet, val) {
  await db.pool.query(
    `insert into welcome_lock_state (wallet, cash_exhausted)
     values ($1, $2)
     on conflict (wallet) do update set cash_exhausted=excluded.cash_exhausted, updated_at=now()`,
    [String(wallet), !!val]
  );
}

async function getWelcomeState(wallet) {
  try {
    const r = await fetch(
      `http://127.0.0.1:${PORT}/promo/welcome/state?wallet=${encodeURIComponent(wallet)}`,
      { timeout: 4000 }
    );
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

async function parseLockedBaselineLamports(json) {
  if (!json) return 0;
  const N = (v) => (v == null || v === "" ? NaN : Number(v));

  const directLamports = N(json.locked_remaining_lamports);
  if (Number.isFinite(directLamports) && directLamports >= 0) {
    return Math.round(directLamports);
  }

  const price = await getSolUsd();
  const directUsd = N(json.locked_remaining_usd);
  if (Number.isFinite(directUsd) && directUsd >= 0) {
    return Math.max(0, Math.round((directUsd / (price || 1)) * LAMPORTS_PER_SOL));
  }

  const creditedUsd =
    N(json.bonus_amount_usd) ??
    N(json.credited_usd) ??
    N(json.credited_amount_usd) ??
    N(json.credited) ??
    N(json.bonus_usd);

  const wrProgress =
    N(json.wr_progress) ?? N(json.wrPlayed) ?? N(json.wagered_usd) ?? N(json.wagered);
  const wrTarget =
    N(json.wr_target) ?? N(json.wr_required) ?? N(json.wrRequired) ?? N(json.wrTotal);

  if (
    Number.isFinite(creditedUsd) && creditedUsd >= 0 &&
    Number.isFinite(wrProgress) && wrProgress >= 0 &&
    Number.isFinite(wrTarget) && wrTarget > 0
  ) {
    const remainingUsd = creditedUsd * (1 - Math.max(0, Math.min(1, wrProgress / wrTarget)));
    return Math.max(0, Math.round((remainingUsd / (price || 1)) * LAMPORTS_PER_SOL));
  }
  if (Number.isFinite(creditedUsd) && creditedUsd >= 0) {
    return Math.max(0, Math.round((creditedUsd / (price || 1)) * LAMPORTS_PER_SOL));
  }
  return 0;
}

async function computeVaultLock(wallet) {
  const pda = deriveUserVaultPda(wallet);
  const pdaLamports = await connection.getBalance(pda, "confirmed");

  const welcome = await getWelcomeState(wallet);
  const baselineLockedLamports = await parseLockedBaselineLamports(welcome);

  let cashExhausted = await getCashExhausted(wallet);
  const EPS = 10_000; // ~0.00001 SOL

  if (!cashExhausted) {
    if (baselineLockedLamports > 0 && pdaLamports <= baselineLockedLamports + EPS) {
      cashExhausted = true;
      await setCashExhausted(wallet, true);
    }
  } else {
    if (baselineLockedLamports <= EPS) {
      cashExhausted = false;
      await setCashExhausted(wallet, false);
    }
  }

  const effectiveLockedLamports =
    baselineLockedLamports > EPS
      ? (cashExhausted ? pdaLamports : Math.min(pdaLamports, baselineLockedLamports))
      : 0;

  const withdrawableLamports = Math.max(0, pdaLamports - effectiveLockedLamports);

  return {
    wallet,
    pdaLamports,
    baselineLockedLamports,
    cashExhausted,
    effectiveLockedLamports,
    withdrawableLamports,
  };
}

// ---------- Withdraw fee config ----------
const WITHDRAWAL_FEE_SOL = Number(process.env.WITHDRAWAL_FEE_SOL || 0.001);
const WITHDRAWAL_FEE_LAMPORTS = Math.round(WITHDRAWAL_FEE_SOL * LAMPORTS_PER_SOL);

// ---------- Column helpers for dynamic projections ----------
const _colHas = new Map();
async function colExists(table, column) {
  const key = `${table}.${column}`;
  if (_colHas.has(key)) return _colHas.get(key);
  try {
    const { rows } = await db.pool.query(
      `select 1 from information_schema.columns where table_name=$1 and column_name=$2 limit 1`,
      [table, column]
    );
    const ok = rows.length > 0;
    _colHas.set(key, ok);
    return ok;
  } catch {
    _colHas.set(key, false);
    return false;
  }
}
async function selectProjectionCoinflip() {
  const has = (c) => colExists("coinflip_matches", c);
  return [
    "id",
    "nonce",
    "player_a",
    "player_b",
    "side_a",
    "side_b",
    "bet_lamports",
    "outcome",
    "winner",
    "payout_lamports",
    (await has("fee_bps")) ? "fee_bps" : "NULL::int as fee_bps",
    (await has("resolve_sig_winner")) ? "resolve_sig_winner" : "NULL::text as resolve_sig_winner",
    (await has("resolve_sig_loser")) ? "resolve_sig_loser" : "NULL::text as resolve_sig_loser",
    (await has("server_seed_hash")) ? "server_seed_hash" : "NULL::text as server_seed_hash",
    (await has("server_seed")) ? "server_seed as server_seed_hex" : "NULL::text as server_seed_hex",
    (await has("first_hmac_hex")) ? "first_hmac_hex" : "NULL::text as first_hmac_hex",
    (await has("client_seed_a")) ? "client_seed_a" : "''::text as client_seed_a",
    (await has("client_seed_b")) ? "client_seed_b" : "''::text as client_seed_b",
    (await has("status")) ? "status" : "'resolved'::text as status",
    (await has("created_at")) ? "created_at" : "NULL::timestamptz as created_at",
    (await has("resolved_at")) ? "resolved_at" : "NULL::timestamptz as resolved_at",
  ].join(", ");
}

// ---------- Maintenance helpers (global, cached) ----------
const _maintCache = { t: 0, cfg: null };
function baseMaintCfg() {
  return {
    isEnabled: false,
    message: "Site is undergoing scheduled maintenance. We'll be back shortly.",
    scheduledStart: null,
    scheduledEnd: null,
    allowAdminAccess: true,
    redirectUrl: "/maintenance",
    notifyUsers: true,
    notificationMinutes: 30,
  };
}
async function getMaintCached() {
  const now = Date.now();
  if (_maintCache.cfg && now - _maintCache.t < 3000) return _maintCache.cfg;
  try {
    const { rows } = await db.pool.query(
      `select value from admin_settings where key = 'maintenance' limit 1`
    );
    const stored = rows[0]?.value || {};
    _maintCache.cfg = Object.assign(baseMaintCfg(), stored);
    _maintCache.t = now;
    return _maintCache.cfg;
  } catch {
    _maintCache.cfg = baseMaintCfg();
    _maintCache.t = now;
    return _maintCache.cfg;
  }
}
function isWindowActive(cfg) {
  const now = Date.now();
  const st = cfg.scheduledStart ? Date.parse(cfg.scheduledStart) : NaN;
  const en = cfg.scheduledEnd ? Date.parse(cfg.scheduledEnd) : NaN;
  let active = Boolean(cfg.isEnabled);
  if (Number.isFinite(st) && now >= st && (!Number.isFinite(en) || now < en)) active = true;
  if (Number.isFinite(en) && now >= en && !cfg.isEnabled) active = false;
  return active;
}
function isAdminAuthorized(req) {
  if (!process.env.ADMIN_API_KEY) return false;
  const auth = String(req.headers["authorization"] || "");
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return !!(m && m[1] === process.env.ADMIN_API_KEY);
}
function wantsHtml(req) {
  const a = String(req.headers["accept"] || "");
  return a.includes("text/html");
}
function computeRetryAfterSeconds(cfg) {
  const now = Date.now();
  const en = cfg.scheduledEnd ? Date.parse(cfg.scheduledEnd) : NaN;
  if (Number.isFinite(en) && en > now) {
    return Math.max(1, Math.floor((en - now) / 1000));
  }
  return 300;
}

async function main() {
  try {
    if (db.ensureSchema) await db.ensureSchema();
  } catch (e) {
    console.warn("[ensureSchema] failed:", e?.message || e);
  }
  await ensureWelcomeLockTable();

  const app = express();
  app.set("trust proxy", true);

  // ---------- CORS ----------
  const defaultAllowed = ["https://api.zoggy.io","http://51.20.249.35:3000","http://localhost:3000"];
  const ALLOW_ORIGINS = (process.env.ALLOW_ORIGINS || defaultAllowed.join(","))
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const corsOptions = {
    origin(origin, cb) {
      if (!origin) return cb(null, true);
      const ok = ALLOW_ORIGINS.includes(origin);
      return cb(ok ? null : new Error("CORS: origin not allowed: " + origin), ok);
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    exposedHeaders: ["Content-Length"],
    optionsSuccessStatus: 204,
  };

  app.use(cors(corsOptions));
  app.options("*", cors(corsOptions));
  app.use(bodyParser.json({ limit: "1mb" }));

  app.use((err, _req, res, next) => {
    if (err && String(err.message || "").startsWith("CORS:")) {
      return res.status(403).json({ error: err.message });
    }
    return next(err);
  });

  console.log("[CORS] Allowed origins:", ALLOW_ORIGINS);

  // ---------- Health ----------
  app.get("/health", (_req, res) => {
    res.json({ ok: true, cluster: CLUSTER, programId: PROGRAM_ID.toBase58() });
  });
  app.get("/health/all", (_req, res) => {
    res.json({
      ok: true,
      cluster: CLUSTER,
      dice_program: PROGRAM_ID.toBase58(),
      crash_program: CRASH_PROGRAM_ID || null,
      plinko_program: PLINKO_PROGRAM_ID || null,
      coinflip_program: COINFLIP_PROGRAM_ID || null,
    });
  });

  // =======================
  // Maintenance Enforcement (global)
  // =======================
  app.use(async (req, res, next) => {
    try {
      const p = req.path || req.url || "";

      // Always allow these paths
      if (
        p.startsWith("/admin") ||            // admin endpoints will still be protected by their own middleware
        p.startsWith("/health") ||
        p.startsWith("/uploads") ||
        p.startsWith("/socket.io") ||        // Socket.IO HTTP transport; WS gate handles enforcement
        p.startsWith("/r/") ||
        p.startsWith("/maintenance/status")
      ) {
        return next();
      }

      const cfg = await getMaintCached();
      const active = isWindowActive(cfg);
      res.setHeader("x-maintenance-active", String(active));

      if (!active) return next();

      // Allow admin override by token even outside /admin (e.g., ad-hoc checks)
      if (cfg.allowAdminAccess && isAdminAuthorized(req)) return next();

      const retryAfter = String(computeRetryAfterSeconds(cfg));

      if (req.method === "GET" && wantsHtml(req)) {
        res.setHeader("Retry-After", retryAfter);
        return res.status(302).redirect(buildMaintenanceUrl(cfg.redirectUrl));
      }

      res.setHeader("Retry-After", retryAfter);
      return res.status(503).json({
        maintenance: true,
        message: cfg.message || "Site is under maintenance.",
        scheduledStart: cfg.scheduledStart || null,
        scheduledEnd: cfg.scheduledEnd || null,
      });
    } catch (e) {
      return next(e);
    }
  });

  // Small public status endpoint (frontend can poll)
  app.get("/maintenance/status", async (_req, res) => {
    try {
      const cfg = await getMaintCached();
      return res.json({
        active: isWindowActive(cfg),
        message: cfg.message || "",
        scheduledStart: cfg.scheduledStart || null,
        scheduledEnd: cfg.scheduledEnd || null,
        redirectUrl: buildMaintenanceUrl(cfg.redirectUrl),
      });
    } catch (e) {
      return res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // ---------- Public rules ----------
  app.get("/rules", async (_req, res) => {
    try {
      let rules = { rtp_bps: 9900, min_bet_lamports: 50000, max_bet_lamports: 5000000000 };
      if (db.getRules) rules = await db.getRules();
      res.json({
        rtp: Number(rules.rtp_bps) / 100,
        minBetSol: Number(rules.min_bet_lamports) / 1e9,
        maxBetSol: Number(rules.max_bet_lamports) / 1e9,
      });
    } catch (e) {
      res.status(500).json({ error: String(e.message || e) });
    }
  });

  // ---------------- PROMOS ----------------
  try {
    const promosRouter = require("./promos_router");
    app.use("/promo", promosRouter);
    console.log("Promos router mounted at /promo");
  } catch (e) {
    console.warn("promos_router not found / failed to mount:", e?.message || e);
  }

  // ---------- Click-redirect route ----------
  app.get("/r/:code", async (req, res) => {
    try {
      const codeUp = String(req.params.code || "").toUpperCase();
      if (!codeUp) return res.redirect(SITE_URL);

      const { rows: aff } = await db.pool.query(
        `select owner_wallet from affiliates where code=$1 limit 1`,
        [codeUp]
      );
      const affiliateWallet = aff[0]?.owner_wallet || null;

      const landing = `${SITE_URL.replace(/\/$/, "")}/?ref=${encodeURIComponent(codeUp)}`;

      if (affiliateWallet) {
        const ip = getClientIp(req);
        const ua = req.headers["user-agent"] ? String(req.headers["user-agent"]).slice(0, 1024) : null;
        const ref = req.get("referer") || null;
        try {
          await db.pool.query(
            `insert into affiliate_link_clicks (code, affiliate_wallet, clicked_wallet, device_id, ip, user_agent, referer, landing_url)
             values ($1,$2,NULL,NULL,$3,$4,$5,$6)`,
            [codeUp, String(affiliateWallet), ip || null, ua, ref, landing]
          );
        } catch (_) {}
        return res.redirect(302, landing);
      } else {
        return res.redirect(SITE_URL);
      }
    } catch (e) {
      console.warn("[/r/:code]", e?.message || e);
      return res.redirect(SITE_URL);
    }
  });

  // ---------------- Admin APIs (Games + Dashboard) ----------------
  app.get("/admin/games", async (_req, res) => {
    try {
      const rows = await db.listGameConfigs();
      const metrics = await computeGameMetrics();
      const mapName = (k) => k[0].toUpperCase() + k.slice(1);
      const list = rows.map((r) => {
        const m = metrics[r.game_key] || {};
        return {
          id: r.game_key,
          name: mapName(r.game_key),
          enabled: r.enabled,
          running: r.running,
          minBetLamports: String(r.min_bet_lamports),
          maxBetLamports: String(r.max_bet_lamports),
          feeBps: r.fee_bps,
          rtpBps: r.rtp_bps,
          revenue: Number(m.revenue ?? 0),
          plays: Number(m.plays ?? 0),
        };
      });
      res.json(list);
    } catch (e) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  async function computeGameMetrics() {
    const out = Object.create(null);
    try {
      const livePx = await getSolUsd();

      const gr = await db.pool.query(
        `select game_key,
                coalesce(sum(stake_lamports - payout_lamports),0)::text as rev,
                count(*)::int as plays
         from game_rounds
         group by game_key`
      );
      for (const r of gr.rows) {
        out[r.game_key] = out[r.game_key] || { revenue: 0, plays: 0 };
        out[r.game_key].revenue += (Number(r.rev) / 1e9) * livePx;
        out[r.game_key].plays += Number(r.plays || 0);
      }

      if (await db._tableExistsUnsafe?.("coinflip_matches")) {
        const cf = await db.pool.query(
          `select coalesce(sum((bet_lamports*2) - payout_lamports),0)::text as rev,
                  count(*)::int as plays
           from coinflip_matches`
        );
        out["coinflip"] = out["coinflip"] || { revenue: 0, plays: 0 };
        out["coinflip"].revenue += (Number(cf.rows[0].rev || 0) / 1e9) * livePx;
        out["coinflip"].plays += Number(cf.rows[0].plays || 0);
      }

      if (await db._tableExistsUnsafe?.("slots_spins")) {
        const ss = await db.pool.query(
          `select coalesce(sum(bet_amount - payout),0)::numeric as rev_lamports,
                  count(*)::int as plays
           from slots_spins`
        );
        const revLamports = Number(ss.rows[0].rev_lamports || 0);
        const usd = (revLamports / 1e9) * livePx;
        out["slots"] = out["slots"] || { revenue: 0, plays: 0 };
        out["slots"].revenue += usd;
        out["slots"].plays += Number(ss.rows[0].plays || 0);
      }
    } catch (err) {
      console.error("[computeGameMetrics] error:", err.message);
    }
    return out;
  }

  app.put("/admin/games/:id", async (req, res) => {
    try {
      const id = String(req.params.id);
      const patch = req.body || {};
      const derived = normalizeHouseEdgePatch(patch);
      const finalPatch = { ...patch };
      if (derived) {
        finalPatch.fee_bps = derived.fee_bps;
        finalPatch.rtp_bps = derived.rtp_bps;
        delete finalPatch.houseEdgePct;
        delete finalPatch.house_edge_pct;
        delete finalPatch.houseEdge;
        delete finalPatch.house_edge;
      }
      const updated = await db.upsertGameConfig(id, finalPatch);
      res.json({
        id: updated.game_key,
        enabled: updated.enabled,
        running: updated.running,
        minBetLamports: String(updated.min_bet_lamports),
        maxBetLamports: String(updated.max_bet_lamports),
        feeBps: updated.fee_bps,
        rtpBps: updated.rtp_bps,
      });
    } catch (e) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  app.put("/admin/games/:id/house-edge", async (req, res) => {
    try {
      const id = String(req.params.id);
      const { houseEdgePct } = req.body || {};
      if (houseEdgePct == null || houseEdgePct === "" || isNaN(Number(houseEdgePct))) {
        return res.status(400).json({ error: "houseEdgePct required (number)" });
      }
      const fee_bps = Math.round(Math.max(0, Math.min(100, Number(houseEdgePct))) * 100);
      const rtp_bps = Math.max(0, 10000 - fee_bps);
      const updated = await db.upsertGameConfig(id, { fee_bps, rtp_bps });
      res.json({
        id: updated.game_key,
        enabled: updated.enabled,
        running: updated.running,
        minBetLamports: String(updated.min_bet_lamports),
        maxBetLamports: String(updated.max_bet_lamports),
        feeBps: updated.fee_bps,
        rtpBps: updated.rtp_bps,
      });
    } catch (e) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  app.post("/admin/games/:id/toggle-enabled", async (req, res) => {
    try {
      const id = String(req.params.id);
      const cur = await db.getGameConfig(id);
      const updated = await db.upsertGameConfig(id, { enabled: !cur.enabled });
      res.json({ id: updated.game_key, enabled: updated.enabled });
    } catch (e) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });
  app.post("/admin/games/:id/toggle-running", async (req, res) => {
    try {
      const id = String(req.params.id);
      const cur = await db.getGameConfig(id);
      const updated = await db.upsertGameConfig(id, { running: !cur.running });
      res.json({ id: updated.game_key, running: updated.running });
    } catch (e) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  // ---------- Admin stats (recentActivity amounts -> USDT) ----------
  app.get("/admin/stats", async (_req, res) => {
    try {
      const stats = await db.getAdminStats();
      const px = await getSolUsd();

      const recent = Array.isArray(stats.recentActivity)
        ? stats.recentActivity.map((a) => {
            const amountSol = Number(a.amount || 0);
            return {
              ...a,
              result: classifyActivity({ action: a.action, amount: amountSol }),
              amount: solToUsd(amountSol, px),
              currency: "USDT",
              priceUsdPerSol: px,
            };
          })
        : [];

      res.json({ ...stats, recentActivity: recent });
    } catch (e) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  // ---------------- Admin APIs (Users) ----------------
  app.get("/admin/users", async (req, res) => {
    try {
      const { page = "1", limit = "20", status = "all", search = "" } = req.query || {};
      const data = await db.listUsers({
        page: Number(page),
        limit: Number(limit),
        status: String(status),
        search: String(search),
      });

      const price = await getSolUsd();
      const users = await Promise.all(
        data.users.map(async (u) => {
          const liveLamports = await fetchLivePdaLamports(u.walletAddress);
          const lam = liveLamports != null ? liveLamports : Number(u.pdaBalance || 0);
          const usdt = (lam / 1e9) * price;

          return {
            ...u,
            pdaBalanceLamports: lam,
            pdaBalanceUsdt: Number(usdt.toFixed(2)),
          };
        })
      );

      res.json({ ...data, users });
    } catch (e) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  app.get("/admin/users/:id", async (req, res) => {
    try {
      const id = String(req.params.id);
      const u = await db.getUserDetails(id);
      if (!u) return res.status(404).json({ error: "User not found" });

      const price = await getSolUsd();
      const liveLamports = await fetchLivePdaLamports(u.walletAddress);
      const lam = liveLamports != null ? liveLamports : Number(u.pdaBalance || 0);
      const usdt = (lam / 1e9) * price;

      res.json({
        ...u,
        pdaBalanceLamports: lam,
        pdaBalanceUsdt: Number(usdt.toFixed(2)),
      });
    } catch (e) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  // Admin view: user's activities (USDT + classification)
  app.get("/admin/users/:id/activities", async (req, res) => {
    try {
      const id = String(req.params.id);
      const limit = Number(req.query.limit || 50);
      const rows = await db.listUserActivities(id, limit);
      const px = await getSolUsd();

      const out = rows.map((r) => {
        const amountSol = Number(r.amount || 0);
        return {
          ...r,
          result: classifyActivity(r),
          amount: solToUsd(amountSol, px),
          currency: "USDT",
          priceUsdPerSol: px,
        };
      });

      res.json(out);
    } catch (e) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  app.put("/admin/users/:id/status", async (req, res) => {
    try {
      const id = String(req.params.id);
      const { status } = req.body || {};
      const updated = await db.updateUserStatus(id, status);
      res.json(updated);
    } catch (e) {
      res.status(400).json({ error: e?.message || String(e) });
    }
  });

  // NEW: Admin adjust user balance in **USD** (converted to lamports, stored in DB)
  app.put("/admin/users/:id/balance", async (req, res) => {
    try {
      const id = String(req.params.id);
      const { amount, type, reason } = req.body || {};
      const amtUsd = Number(amount);
      if (!isFinite(amtUsd) || amtUsd <= 0) {
        return res.status(400).json({ error: "amount (USD) required (> 0)" });
      }
      const t = String(type || "").toLowerCase();
      if (t !== "add" && t !== "subtract") {
        return res.status(400).json({ error: "type must be 'add' or 'subtract'" });
      }
      const price = await getSolUsd();
      const deltaLamports = Math.round((amtUsd / (price || USD_PER_SOL_FALLBACK)) * LAMPORTS_PER_SOL);
      const signedDelta = t === "add" ? deltaLamports : -deltaLamports;

      await adjustPdaBalanceLamports(id, signedDelta);

      try {
        await db.recordActivity({
          user: id,
          action: `admin_balance_${t}${reason ? `: ${String(reason).slice(0, 200)}` : ""}`,
          amount: signedDelta / 1e9,
          amount_usd: t === "add" ? amtUsd : -amtUsd,
          price_usd_per_sol: price,
        });
      } catch (_) {}

      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  // NEW: Admin toggle withdrawals permission
  app.put("/admin/users/:id/withdrawals", async (req, res) => {
    try {
      const id = String(req.params.id);
      const { withdrawalsEnabled, reason } = req.body || {};
      const val = Boolean(withdrawalsEnabled);
      await db.updateWithdrawalPermissions(id, val);

      try {
        await db.recordActivity({
          user: id,
          action: `admin_withdrawals_${val ? "enabled" : "disabled"}${reason ? `: ${String(reason).slice(0, 200)}` : ""}`,
          amount: 0,
        });
      } catch (_) {}

      res.json({ ok: true, withdrawalsEnabled: val });
    } catch (e) {
      res.status(400).json({ error: e?.message || String(e) });
    }
  });

  // ---------------- Admin APIs (Transactions) ----------------
  // List (USDT + result filter)
  app.get("/admin/transactions", async (req, res) => {
    try {
      const {
        page = "1",
        limit = "5",
        type = "all",
        status = "all",
        game = "all",
        search = "",
        result = "all",
      } = req.query || {};

      const data = await db.listTransactions({
        page: Number(page),
        limit: Number(limit),
        type: String(type),
        status: String(status),
        game: String(game),
        search: String(search),
      });

      const livePx = await getSolUsd();
      const want = String(result).toLowerCase().split(",").filter(Boolean);

      let txs = (data.transactions || []).map((t) => {
        const cls = classifyTxn(t);
        const px = Number(t.price_usd_per_sol || livePx);
        const amountUsdt = solToUsd(t.amount || 0, px);
        const payoutUsdt = solToUsd(t.payout || 0, px);
        return {
          ...t,
          result: cls,
          amount: amountUsdt,
          payout: payoutUsdt,
          netUsdt: round2(payoutUsdt - amountUsdt),
          currency: "USDT",
          priceUsdPerSol: px,
        };
      });

      if (want.length && !want.includes("all")) {
        txs = txs.filter((t) => want.includes(t.result));
      }

      res.json({ ...data, transactions: txs });
    } catch (e) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  // Aggregate stats (unchanged)
  app.get("/admin/transactions/stats", async (_req, res) => {
    try {
      const stats = await db.getTransactionStats();
      res.json(stats);
    } catch (e) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  // Export CSV (USDT + result column)
  app.get("/admin/transactions/export", async (req, res) => {
    try {
      const { type = "all", status = "all", game = "all", search = "", result = "all" } = req.query || {};

    const data = await db.listTransactions({
        page: 1,
        limit: 1_000_000,
        type: String(type),
        status: String(status),
        game: String(game),
        search: String(search),
      });

      const livePx = await getSolUsd();
      const want = String(result).toLowerCase().split(",").filter(Boolean);

      let rows = (data.transactions || []).map((t) => {
        const cls = classifyTxn(t);
        const px = Number(t.price_usd_per_sol || livePx);
        const amountUsdt = solToUsd(t.amount || 0, px);
        const payoutUsdt = solToUsd(t.payout || 0, px);
        return {
          ...t,
          result: cls,
          amountUsdt,
          payoutUsdt,
          priceUsdPerSol: px,
        };
      });

      if (want.length && !want.includes("all")) {
        rows = rows.filter((t) => want.includes(t.result));
      }

      const header = [
        "id",
        "username",
        "walletAddress",
        "type",
        "game",
        "amount_usdt",
        "currency",
        "status",
        "timestamp",
        "payout_usdt",
        "result",
        "price_usd_per_sol",
      ].join(",");

      const lines = rows.map((t) =>
        [
          t.id,
          JSON.stringify(t.username || ""),
          JSON.stringify(t.walletAddress || ""),
          t.type || "",
          t.game || "",
          Number.isFinite(t.amountUsdt) ? t.amountUsdt : 0,
          "USDT",
          t.status || "",
          t.timestamp || "",
          Number.isFinite(t.payoutUsdt) ? t.payoutUsdt : 0,
          t.result || "",
          t.priceUsdPerSol || livePx,
        ].join(",")
      );

      const csv = [header].concat(lines).join("\n");
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="transactions_export.csv"`);
      res.send(csv);
    } catch (e) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  app.patch("/admin/transactions/:id/status", async (req, res) => {
    try {
      const id = String(req.params.id);
      const { status } = req.body || {};
      const out = await db.updateTransactionStatusComposite(id, status);
      res.json(out);
    } catch (e) {
      res.status(400).json({ error: e?.message || String(e) });
    }
  });

  // ---------- Vault config + lock ----------
  app.get("/vault/config", (_req, res) => {
    res.json({ withdrawalFeeSol: WITHDRAWAL_FEE_SOL, withdrawalFeeLamports: WITHDRAWAL_FEE_LAMPORTS });
  });

  app.get("/vault/locked", async (req, res) => {
    try {
      const wallet = String(req.query.wallet || "");
      if (!isMaybeBase58(wallet)) return res.status(400).json({ error: "bad wallet" });
      const summary = await computeVaultLock(wallet);
      res.json(summary);
    } catch (e) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // ---------- Wallet activity endpoints ----------
  app.post("/wallets/:id/deposit", async (req, res) => {
    try {
      const id = String(req.params.id);
      const { amountSol, amountLamports, pdaSol, pdaLamports, txHash } = req.body || {};

      const deltaLamports =
        amountLamports != null
          ? Math.round(Number(amountLamports))
          : Math.round(Number(amountSol || 0) * LAMPORTS_PER_SOL);

      if (!isFinite(deltaLamports) || deltaLamports <= 0) {
        return res
          .status(400)
          .json({ error: "amountSol or amountLamports required (> 0)" });
      }

      await db.recordActivity({ user: id, action: "deposit", amount: deltaLamports / 1e9, tx_hash: txHash });

      if (pdaSol != null || pdaLamports != null) {
        const absLamports =
          pdaLamports != null
            ? Math.round(Number(pdaLamports))
            : Math.round(Number(pdaSol || 0) * LAMPORTS_PER_SOL);
        await setAbsolutePdaBalanceLamports(id, absLamports);
      } else {
        await adjustPdaBalanceLamports(id, deltaLamports);
      }

      await setCashExhausted(id, false);

      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: e?.message || String(e) });
    }
  });

  app.post("/wallets/:id/withdraw", async (req, res) => {
    try {
      const id = String(req.params.id);
      const { amountSol, amountLamports, pdaSol, pdaLamports, txHash } = req.body || {};

      const deltaLamports =
        amountLamports != null
          ? Math.round(Number(amountLamports))
          : Math.round(Number(amountSol || 0) * LAMPORTS_PER_SOL);

      if (!isFinite(deltaLamports) || deltaLamports <= 0) {
        return res
          .status(400)
          .json({ error: "amountSol or amountLamports required (> 0)" });
      }

      await db.recordActivity({ user: id, action: "withdraw", amount: deltaLamports / 1e9, tx_hash: txHash });

      if (pdaSol != null || pdaLamports != null) {
        const absLamports =
          pdaLamports != null
            ? Math.round(Number(pdaLamports))
            : Math.round(Number(pdaSol || 0) * LAMPORTS_PER_SOL);
        await setAbsolutePdaBalanceLamports(id, absLamports);
      } else {
        await adjustPdaBalanceLamports(id, -deltaLamports);
      }

      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: e?.message || String(e) });
    }
  });

  // Public wallet activities (USDT view)
  app.get("/wallets/:id/activities", async (req, res) => {
    try {
      const id = String(req.params.id);
      const limit = Number(req.query.limit || 100);
      const rows = await db.listUserActivities(id, limit);
      const px = await getSolUsd();

      const out = rows.map((r) => {
        const amountSol = Number(r.amount || 0);
        return {
          ...r,
          result: classifyActivity(r),
          amount: solToUsd(amountSol, px),
          currency: "USDT",
          priceUsdPerSol: px,
        };
      });

      res.json(out);
    } catch (e) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  // Serve uploaded reward icons
  app.use("/uploads", express.static(path.join(__dirname, "uploads")));

  // ---------- Admin Bot (REST + WS feed) ----------
  try {
    const { attachBotFeed, attachBotAdmin } = require("./bot_engine");
    attachBotAdmin?.(app);
    attachBotFeed?.(ioPlaceholder());
  } catch (e) {
    console.warn("bot_engine not found / failed to mount:", e?.message || e);
  }

  // ---------- HTTP server + Socket.IO ----------
  const server = http.createServer(app);

  const io = new Server(server, {
    cors: {
      origin(origin, cb) {
        if (!origin) return cb(null, true);
        const ok = ALLOW_ORIGINS.includes(origin);
        cb(ok ? null : new Error("CORS: origin not allowed: " + origin), ok);
      },
      credentials: true,
      methods: ["GET", "POST"],
    },
  });

  try {
    const { attachBotFeed } = require("./bot_engine");
    attachBotFeed?.(io);
  } catch {}

  // -------------------------
  // PERSISTENT ADMIN SETTINGS (unchanged except mounts)
  // -------------------------
  try {
    const bcrypt = require("bcrypt");
    const SALT_ROUNDS = Number(process.env.PASSWORD_SALT_ROUNDS || 10);
    async function ensureAdminSettingsTable() {
      try {
        await db.pool.query(`
          create table if not exists admin_settings (
            key text primary key,
            value jsonb not null,
            updated_at timestamptz not null default now()
          );
        `);
      } catch (err) {
        console.warn("[ensureAdminSettingsTable] failed:", err?.message || err);
      }
    }
    ensureAdminSettingsTable().catch((e) => console.warn("[admin_settings init] error:", e?.message || e));

    async function readAdminSetting(key) {
      const { rows } = await db.pool.query(
        `select value from admin_settings where key = $1 limit 1`,
        [String(key)]
      );
      return rows[0] ? rows[0].value : null;
    }

    async function writeAdminSetting(key, obj) {
      await db.pool.query(
        `insert into admin_settings (key, value) values ($1, $2)
         on conflict (key) do update set value = EXCLUDED.value, updated_at = now()`,
        [String(key), obj]
      );
      return obj;
    }

    function requireAdmin(req, res, next) {
      try {
        if (!process.env.ADMIN_API_KEY) {
          console.warn("[requireAdmin] WARNING: ADMIN_API_KEY not set — admin endpoints are open (dev mode)");
          return next();
        }
        const auth = (req.headers["authorization"] || "");
        const m = String(auth).match(/^Bearer\s+(.+)$/i);
        if (!m) return res.status(401).json({ error: "missing authorization" });
        const token = m[1];
        if (token !== process.env.ADMIN_API_KEY) return res.status(403).json({ error: "forbidden" });
        return next();
      } catch (e) {
        return next(e);
      }
    }

    async function getAdminProfile() {
      const profile = await readAdminSetting("admin_profile");
      if (profile) return profile;
      const defaultProfile = {
        id: "admin",
        name: process.env.ADMIN_NAME || "Admin User",
        email: process.env.ADMIN_EMAIL || "admin@flipverse.comm",
        phone: process.env.ADMIN_PHONE || "+1 (555) 123-4567",
        role: process.env.ADMIN_ROLE || "Super Admin",
        joinDate: process.env.ADMIN_JOIN_DATE || new Date().toISOString(),
      };
      await writeAdminSetting("admin_profile", defaultProfile);
      return defaultProfile;
    }

    async function getAdminCredentials() {
      const cred = await readAdminSetting("admin_credentials");
      if (cred && cred.passwordHash) return cred;
      if (process.env.ADMIN_PASSWORD_HASH) {
        const c = { passwordHash: process.env.ADMIN_PASSWORD_HASH };
        await writeAdminSetting("admin_credentials", c);
        return c;
      }
      const c = { passwordHash: null };
      await writeAdminSetting("admin_credentials", c);
      return c;
    }

    const MAINT_KEY = "maintenance";
    async function getMaintenanceConfig() {
      const stored = await readAdminSetting(MAINT_KEY);
      const base = {
        isEnabled: false,
        message: "Site is undergoing scheduled maintenance. We'll be back shortly.",
        scheduledStart: null,
        scheduledEnd: null,
        allowAdminAccess: true,
        redirectUrl: "/maintenance",
        notifyUsers: true,
        notificationMinutes: 30,
      };
      if (!stored) {
        await writeAdminSetting(MAINT_KEY, base);
        return base;
      }
      return Object.assign(base, stored);
    }

    app.get("/admin/me", requireAdmin, async (_req, res) => {
      try {
        const p = await getAdminProfile();
        return res.json(p);
      } catch (e) {
        return res.status(500).json({ error: String(e?.message || e) });
      }
    });

    app.put("/admin/users/:id", requireAdmin, async (req, res) => {
      try {
        const patch = req.body || {};
        const allowed = ["name", "email", "phone", "role", "joinDate"];
        const cur = await getAdminProfile();
        for (const k of allowed) {
          if (Object.prototype.hasOwnProperty.call(patch, k)) cur[k] = patch[k];
        }
        await writeAdminSetting("admin_profile", cur);
        try { io.emit("admin.user.updated", cur); } catch (e) {}
        return res.json(cur);
      } catch (e) {
        return res.status(500).json({ error: String(e?.message || e) });
      }
    });

    app.put("/admin/users/:id/password", requireAdmin, async (req, res) => {
      try {
        const { currentPassword, newPassword } = req.body || {};
        if (!newPassword || typeof newPassword !== "string" || newPassword.length < 8) {
          return res.status(400).json({ error: "newPassword required (min 8 chars)" });
        }

        const creds = await getAdminCredentials();
        if (creds.passwordHash) {
          if (!currentPassword) return res.status(400).json({ error: "currentPassword required" });
          const ok = await bcrypt.compare(String(currentPassword), String(creds.passwordHash));
          if (!ok) return res.status(403).json({ error: "currentPassword incorrect" });
        }

        const hash = await bcrypt.hash(String(newPassword), SALT_ROUNDS);
        await writeAdminSetting("admin_credentials", { passwordHash: hash });
        return res.json({ ok: true });
      } catch (e) {
        return res.status(500).json({ error: String(e?.message || e) });
      }
    });

    app.get("/admin/maintenance", requireAdmin, async (_req, res) => {
      try {
        const cfg = await getMaintenanceConfig();
        return res.json(cfg);
      } catch (e) {
        return res.status(500).json({ error: String(e?.message || e) });
      }
    });

    app.put("/admin/maintenance", requireAdmin, async (req, res) => {
      try {
        const patch = req.body || {};
        const cur = await getMaintenanceConfig();

        const allowed = {
          isEnabled: "boolean",
          message: "string",
          scheduledStart: "string",
          scheduledEnd: "string",
          allowAdminAccess: "boolean",
          redirectUrl: "string",
          notifyUsers: "boolean",
          notificationMinutes: "number",
        };

        for (const k of Object.keys(allowed)) {
          if (Object.prototype.hasOwnProperty.call(patch, k)) {
            const t = allowed[k];
            let v = patch[k];
            if (v == null || v === "") {
              cur[k] = null;
              continue;
            }
            if (t === "boolean") cur[k] = Boolean(v);
            else if (t === "number") cur[k] = Number(v);
            else cur[k] = String(v);
          }
        }

        await writeAdminSetting(MAINT_KEY, cur);
        try { io.emit("admin.maintenance.updated", cur); } catch (e) {}
        return res.json(cur);
      } catch (e) {
        return res.status(500).json({ error: String(e?.message || e) });
      }
    });

    app.post("/admin/maintenance/toggle", requireAdmin, async (_req, res) => {
      try {
        const cur = await getMaintenanceConfig();
        cur.isEnabled = !Boolean(cur.isEnabled);
        await writeAdminSetting(MAINT_KEY, cur);
        try { io.emit("admin.maintenance.updated", cur); } catch (e) {}
        return res.json(cur);
      } catch (e) {
        return res.status(500).json({ error: String(e?.message || e) });
      }
    });
  } catch (err) {
    console.warn("[admin settings block] failed to init:", err?.message || err);
  }

  // ---------- Socket.IO gates and withdraw flow ----------
  // BAN GATE
  io.use(async (socket, next) => {
    try {
      const w = socket.handshake?.auth?.wallet;
      if (isMaybeBase58(w) && (await db.isUserBanned(w))) {
        return next(new Error("User is banned"));
      }
      return next();
    } catch (e) {
      return next(e);
    }
  });

  // MAINTENANCE GATE (block sockets unless admin)
  io.use(async (socket, next) => {
    try {
      const cfg = await getMaintCached();
      const active = isWindowActive(cfg);
      if (!active) return next();

      // Admin bypass via Authorization header or handshake auth
      const hdrToken = String(socket.handshake?.headers?.authorization || "").replace(/^Bearer\s+/i, "");
      const authToken = socket.handshake?.auth?.adminToken || hdrToken || "";
      if (cfg.allowAdminAccess && process.env.ADMIN_API_KEY && authToken === process.env.ADMIN_API_KEY) {
        return next();
      }
      return next(new Error("MAINTENANCE_MODE"));
    } catch (e) {
      return next(e);
    }
  });

  let solanaAnchorIx = null;
  try {
    solanaAnchorIx = require("./solana_anchor_ix");
  } catch (e) {
    console.warn("[server] solana_anchor_ix helper not found. Ensure ./solana_anchor_ix.js exists and exports ixWithdraw().");
  }

  io.on("connection", (socket) => {
    try {
      socket.emit("vault:config", { withdrawalFeeSol: WITHDRAWAL_FEE_SOL, withdrawalFeeLamports: WITHDRAWAL_FEE_LAMPORTS });
    } catch {}

    socket.onAny(async (_event, ...args) => {
      try {
        const w = socket.handshake?.auth?.wallet || extractWalletFromArgs(args);
        if (isMaybeBase58(w) && (await db.isUserBanned(w))) {
          socket.emit("error", { error: "User is banned" });
          socket.disconnect(true);
        }
      } catch {}
    });

    // Prepare withdraw (server enforces permissions + lock + live PDA)
    socket.on("vault:withdraw_prepare", async (data) => {
      try {
        if (!data || typeof data !== "object") {
          socket.emit("vault:error", { message: "invalid request" });
          return;
        }

        const player = String(data.player || data.wallet || data.address || "");
        const amountLamports = Number(data.amountLamports || 0);
        const withdrawAddress = String(data.withdrawAddress || player);

        if (!isMaybeBase58(player) || !isMaybeBase58(withdrawAddress)) {
          socket.emit("vault:error", { message: "invalid player / withdraw address" });
          return;
        }
        // must withdraw to self
        if (withdrawAddress !== player) {
          socket.emit("vault:error", { message: "withdraw address must equal player wallet" });
          return;
        }
        if (!Number.isFinite(amountLamports) || amountLamports <= 0) {
          socket.emit("vault:error", { message: "invalid amountLamports" });
          return;
        }

        // NEW: check withdrawals permission
        if (!(await db.isUserWithdrawalsEnabled(player))) {
          socket.emit("vault:error", { message: "withdrawals disabled by admin" });
          return;
        }

        // Server-side allowance (locked + latch)
        const lock = await computeVaultLock(player);
        const allowedLamports = Math.max(0, lock.withdrawableLamports);
        if (amountLamports > allowedLamports) {
          socket.emit("vault:error", { message: "requested amount exceeds withdrawable balance" });
          return;
        }

        // Ensure PDA actually has at least this much now
        const userVault = deriveUserVaultPda(player);
        const pdaBalance = await connection.getBalance(userVault, "confirmed");
        if (pdaBalance < amountLamports) {
          socket.emit("vault:error", { message: "insufficient vault balance" });
          return;
        }

        if (!solanaAnchorIx || typeof solanaAnchorIx.ixWithdraw !== "function") {
          socket.emit("vault:error", { message: "server missing withdraw instruction builder (solana_anchor_ix.ixWithdraw)" });
          return;
        }

        const ix = solanaAnchorIx.ixWithdraw({
          programId: PROGRAM_ID.toBase58(),
          player: new PublicKey(player),
          userVault: userVault,
          amount: amountLamports,
        });

        const { blockhash } = await connection.getLatestBlockhash("confirmed");
        const messageV0 = new TransactionMessage({
          payerKey: new PublicKey(player),
          recentBlockhash: blockhash,
          instructions: [ix],
        }).compileToV0Message();

        const vtx = new VersionedTransaction(messageV0);
        const txBase64 = Buffer.from(vtx.serialize()).toString("base64");

        try {
          await db.recordActivity({
            user: player,
            action: "withdraw_prepare",
            amount: Number(amountLamports) / 1e9,
            tx_hash: null,
          });
        } catch (e) {
          console.warn("[db.recordActivity] withdraw_prepare failed:", e?.message || e);
        }

        socket.emit("vault:withdraw_tx", { transactionBase64: txBase64, requestId: data?.clientRequestId || null });
      } catch (err) {
        console.error("[vault:withdraw_prepare] error:", err?.message || err);
        try {
          socket.emit("vault:error", { message: String(err?.message || err) });
        } catch {}
      }
    });
  });

  // WS mounts
  function mountWs(modulePath, name, attachName) {
    try {
      const mod = require(modulePath);
      const fn =
        typeof mod === "function"
          ? mod
          : typeof mod?.[attachName] === "function"
          ? mod[attachName]
          : null;

      if (fn) {
        fn(io);
        console.log(`${name} WS mounted`);
      } else {
        console.warn(`${name} WS not found / failed to mount: ${attachName} is not a function`);
      }
    } catch (e) {
      console.warn(`${name} WS not found / failed to mount:`, e?.message || e);
    }
  }
  try { require("./dice_ws").attachDiceRoutes?.(app); } catch (e) { console.warn("dice routes not mounted:", e?.message || e); }

  // New: pass both io and app so the /dice/* REST routes are mounted
  try {
    const dice = require("./dice_ws");
    await dice.ensureDiceSchema?.().catch(() => {}); // make sure columns exist
    dice.attachDice?.(io, app);
    console.log("Dice WS + routes mounted");
  } catch (e) {
    console.warn("Dice mount failed:", e?.message || e);
  }

  // ---------- COINFLIP REST (/coinflip/resolved) ----------
  app.get("/coinflip/resolved", async (req, res) => {
    try {
      const wallet = String(req.query.wallet || "");
      const limit = Math.max(1, Math.min(200, Number(req.query.limit || 50)));
      const cursor = req.query.cursor ? Number(req.query.cursor) : null;

      if (!isMaybeBase58(wallet)) {
        return res.status(400).json({ error: "bad wallet" });
      }

      const proj = await selectProjectionCoinflip();

      if (cursor) {
        const { rows } = await db.pool.query(
          `
          select ${proj}
            from coinflip_matches
           where status = 'resolved'
             and (player_a = $1 or player_b = $1)
             and id < $2
           order by id desc
           limit $3
          `,
          [wallet, cursor, limit]
        );
        const nextCursor = rows.length ? rows[rows.length - 1].id : null;
        return res.json({
          items: rows,
          nextCursor,
          verify: {
            algorithm:
              "HMAC_SHA256(serverSeed, clientSeedA + '|' + clientSeedB + '|' + nonce) -> first byte & 1",
          },
        });
      } else {
        const { rows } = await db.pool.query(
          `
          select ${proj}
            from coinflip_matches
           where status = 'resolved'
             and (player_a = $1 or player_b = $1)
           order by id desc
           limit $2
          `,
          [wallet, limit]
        );
        const nextCursor = rows.length ? rows[rows.length - 1].id : null;
        return res.json({
          items: rows,
          nextCursor,
          verify: {
            algorithm:
              "HMAC_SHA256(serverSeed, clientSeedA + '|' + clientSeedB + '|' + nonce) -> first byte & 1",
          },
        });
      }
    } catch (e) {
      console.error("[/coinflip/resolved] error:", e?.message || e);
      return res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // Other WS modules
  try {
    const slots = require("./slots_ws");
    slots.attachSlots(io);           // WS
    slots.attachSlotsRoutes(app);    // HTTP: /slots and /api/slots
    console.log("Slots WS + HTTP mounted");
  } catch (e) {
    console.warn("slots_ws not found / failed to mount:", e?.message || e);
  }

  try {
    const crash = require("./crash_ws");
    await crash.ensureCrashSchema?.().catch(() => {});
    crash.attachCrash?.(io, app);
    console.log("Crash WS + routes mounted");
  } catch (e) {
    console.warn("Crash mount failed:", e?.message || e);
  }
  try {
    const plinko = require("./plinko_ws");
    await plinko.ensurePlinkoSchema?.().catch(() => {});
    plinko.attachPlinko?.(io, app);   // mounts WS + REST (/plinko/resolved)
    console.log("Plinko WS + routes mounted");
  } catch (e) {
    console.warn("Plinko mount failed:", e?.message || e);
  }
  // Dice: already mounted above with io + app

  // Coinflip: mount WS + REST and ensure schema
  try {
    const coinflip = require("./coinflip_ws");
    await coinflip.ensureCoinflipSchema?.().catch(() => {});
    coinflip.attachCoinflip?.(io, app);
    console.log("Coinflip WS + routes mounted");
  } catch (e) {
    console.warn("Coinflip mount failed:", e?.message || e);
  }

  try {
    const mines = require("./mines_ws");
    mines.attachMines(io);
    console.log("Mines WS mounted");
    if (typeof mines.attachMinesRoutes === "function") {
      mines.attachMinesRoutes(app);
    }
  } catch (e) {
    console.warn("mines_ws not found / failed to mount:", e?.message || e);
  }

  console.log("DATABASE_URL =", process.env.DATABASE_URL);

  try {
    const adminReferrals = require("./admin_referrals_router");
    app.use("/api/admin/referrals", adminReferrals);
  } catch (e) {
    console.warn("admin_referrals_router not found / failed to mount:", e?.message || e);
  }

  try {
    const rewardsRouter = require("./rewards_router");
    app.use("/", rewardsRouter);
    console.log("Rewards router mounted");
  } catch (e) {
    console.warn("rewards_router not found / failed to mount:", e?.message || e);
  }

  try {
    require("./vault_listener").start();
  } catch (e) {
    console.warn(e);
  }

  try {
    const promosAdminRouter = require("./admin_promotion_router");
    app.use("/promo", promosAdminRouter);
    console.log("Promos ADMIN router mounted at /promo/admin");
  } catch (e) {
    console.warn("promos_admin_router not found / failed to mount:", e?.message || e);
  }

  try {
    const welcomeBonusRouter = require("./welcome_bonus_router");
    app.use("/promo/welcome", welcomeBonusRouter);
  } catch (e) {
    console.warn("welcome_bonus_router not found / failed to mount:", e?.message || e);
  }

  try {
    const adminAuthRouter = require("./admin_auth_router");
    app.use("/admin", adminAuthRouter);
    console.log("admin_auth_router mounted at /admin");
  } catch (e) {
    console.warn("admin_auth_router not mounted:", e?.message || e);
  }

  app.use("/admin/fake", require("./admin_fake_balance_router"));

  server.listen(PORT, () => {
    console.log(
      `api up on :${PORT} (cluster=${CLUSTER}, dice_program=${PROGRAM_ID.toBase58()}, crash_program=${
        CRASH_PROGRAM_ID || "—"
      }, plinko_program=${PLINKO_PROGRAM_ID || "—"}, coinflip_program=${COINFLIP_PROGRAM_ID || "—"})`
    );
  });

  function ioPlaceholder() {
    return { of() { return this; }, on() {}, emit() {}, use() {} };
  }
}

main().catch((e) => {
  console.error("Fatal on boot:", e);
  process.exit(1);
});
