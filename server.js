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

const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL || process.env.SITE_URL || "http://flipverse-web.vercel.app";
const PORT = Number(process.env.PORT || 4000);

// ---------- Price helper (SOL→USDT) ----------
const USD_PER_SOL_FALLBACK = Number(process.env.USD_PER_SOL || 200);
let _priceCache = { t: 0, v: USD_PER_SOL_FALLBACK };
async function getSolUsd() {
  try {
    // cache for 30s to avoid hammering
    if (Date.now() - _priceCache.t < 30_000 && _priceCache.v > 0) return _priceCache.v;

    const [cbRes, binRes] = await Promise.allSettled([
      fetch("https://api.coinbase.com/v2/prices/SOL-USD/spot", { timeout: 4000 }),
      fetch("https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT", {
        timeout: 4000,
      }),
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

// ---------- PDA helpers (live balance) ----------
function deriveUserVaultPda(playerPk) {
  // must match the program's PDA seeds used in your on-chain program
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
  } catch (e) {
    // swallow and let caller fall back to DB value
    return null;
  }
}

// ---------- PDA balance updaters (DB) ----------
async function setAbsolutePdaBalance(wallet, sol) {
  const val = Number(sol) || 0;
  await db.pool.query(
    `insert into app_users (user_id, username, pda_balance, last_active)
       values ($1, $1, $2, now())
     on conflict (user_id)
       do update set pda_balance = excluded.pda_balance, last_active = now()`,
    [String(wallet), val]
  );
}
async function adjustPdaBalance(wallet, deltaSol) {
  const delta = Number(deltaSol) || 0;
  await db.pool.query(
    `insert into app_users (user_id, username, pda_balance, last_active)
       values ($1, $1, GREATEST(0, $2), now())
     on conflict (user_id)
       do update set pda_balance = GREATEST(0, app_users.pda_balance + $2), last_active = now()`,
    [String(wallet), delta]
  );
}

async function main() {
  try {
    if (db.ensureSchema) await db.ensureSchema();
  } catch (e) {
    console.warn("[ensureSchema] failed:", e?.message || e);
  }

  const app = express();
  app.set("trust proxy", true);

  // ---------- CORS (Frontend: localhost + Vercel) ----------
  const defaultAllowed = ["http://flipverse-web.vercel.app","http://51.20.249.35:3000", "http://localhost:3000"];
  const ALLOW_ORIGINS = (process.env.ALLOW_ORIGINS || defaultAllowed.join(","))
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const corsOptions = {
    origin(origin, cb) {
      if (!origin) return cb(null, true); // allow server-to-server / curl
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
  app.options("*", cors(corsOptions)); // preflight
  app.use(bodyParser.json({ limit: "1mb" }));

  // Optional small error handler for CORS errors → JSON (not HTML)
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

      // Build landing url (always frontend site with ?ref=CODE)
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
        } catch (_) {} // ignore dedupe
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
      const gr = await db.pool.query(
        `select game_key,
                coalesce(sum(stake_lamports - payout_lamports),0)::text as rev,
                count(*)::int as plays
         from game_rounds
         group by game_key`
      );
      for (const r of gr.rows) {
        out[r.game_key] = out[r.game_key] || { revenue: 0, plays: 0 };
        out[r.game_key].revenue +=
          (Number(r.rev) / 1e9) * Number(process.env.USD_PER_SOL || 200);
        out[r.game_key].plays += Number(r.plays || 0);
      }

      if (await db._tableExistsUnsafe?.("coinflip_matches")) {
        const cf = await db.pool.query(
          `select coalesce(sum((bet_lamports*2) - payout_lamports),0)::text as rev,
                  count(*)::int as plays
           from coinflip_matches`
        );
        out["coinflip"] = out["coinflip"] || { revenue: 0, plays: 0 };
        out["coinflip"].revenue +=
          (Number(cf.rows[0].rev || 0) / 1e9) * Number(process.env.USD_PER_SOL || 200);
        out["coinflip"].plays += Number(cf.rows[0].plays || 0);
      }

     if (await db._tableExistsUnsafe?.("slots_spins")) {
  // rev_lamports is the net in LAMPORTS (bet - payout). Convert to SOL by dividing by 1e9.
  const ss = await db.pool.query(
    `select coalesce(sum(bet_amount - payout),0)::numeric as rev_lamports,
            count(*)::int as plays
     from slots_spins`
  );

  // Convert lamports -> SOL
  const revLamports = Number(ss.rows[0].rev_lamports || 0);
  const revSol = revLamports / 1e9;

  // Convert SOL -> USD
  const usd = revSol * Number(process.env.USD_PER_SOL || 200);

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

  app.get("/admin/stats", async (_req, res) => {
    try {
      const stats = await db.getAdminStats();
      res.json(stats);
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

      // augment with live PDA balances (lamports & USDT)
      const price = await getSolUsd();
      const users = await Promise.all(
        data.users.map(async (u) => {
          const liveLamports = await fetchLivePdaLamports(u.walletAddress);
          const lam = liveLamports != null ? liveLamports : Number(u.pdaBalance || 0);
          const usdt = (lam / 1e9) * price;

          return {
            ...u, // keep original fields for compatibility
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

  app.get("/admin/users/:id/activities", async (req, res) => {
    try {
      const id = String(req.params.id);
      const rows = await db.listUserActivities(id, Number(req.query.limit || 50));
      res.json(rows);
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

  // ---------------- Admin APIs (Transactions) ----------------
  app.get("/admin/transactions", async (req, res) => {
    try {
      const {
        page = "1",
        limit = "5",
        type = "all",
        status = "all",
        game = "all",
        search = "",
      } = req.query || {};

      const data = await db.listTransactions({
        page: Number(page),
        limit: Number(limit),
        type: String(type),
        status: String(status),
        game: String(game),
        search: String(search),
      });
      res.json(data);
    } catch (e) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  app.get("/admin/transactions/stats", async (_req, res) => {
    try {
      const stats = await db.getTransactionStats();
      res.json(stats);
    } catch (e) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  app.get("/admin/transactions/export", async (req, res) => {
    try {
      const { type = "all", status = "all", game = "all", search = "" } = req.query || {};

      const data = await db.listTransactions({
        page: 1,
        limit: 1000000,
        type: String(type),
        status: String(status),
        game: String(game),
        search: String(search),
      });

      const header = [
        "id",
        "username",
        "walletAddress",
        "type",
        "game",
        "amount",
        "currency",
        "status",
        "timestamp",
        "payout",
      ].join(",");
      const lines = data.transactions.map((t) =>
        [
          t.id,
          JSON.stringify(t.username || ""),
          JSON.stringify(t.walletAddress || ""),
          t.type || "",
          t.game || "",
          t.amount ?? 0,
          t.currency || "SOL",
          t.status || "",
          t.timestamp || "",
          t.payout ?? 0,
        ].join(",")
      );
      const csv = [header].concat(lines).join("\n");

      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="transactions_export.csv"`
      );
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

  // ---------- Wallet activity endpoints ----------
  app.post("/wallets/:id/deposit", async (req, res) => {
    try {
      const id = String(req.params.id);
      const { amountSol, amountLamports, pdaSol, pdaLamports, txHash } = req.body || {};

      const deltaSol =
        amountSol != null ? Number(amountSol) : Number(amountLamports || 0) / 1e9;
      if (!isFinite(deltaSol) || deltaSol <= 0) {
        return res
          .status(400)
          .json({ error: "amountSol or amountLamports required (> 0)" });
      }

      await db.recordActivity({ user: id, action: "deposit", amount: deltaSol, tx_hash: txHash });

      if (pdaSol != null || pdaLamports != null) {
        const absSol = pdaSol != null ? Number(pdaSol) : Number(pdaLamports || 0) / 1e9;
        await setAbsolutePdaBalance(id, absSol);
      } else {
        await adjustPdaBalance(id, deltaSol);
      }

      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: e?.message || String(e) });
    }
  });

  app.post("/wallets/:id/withdraw", async (req, res) => {
    try {
      const id = String(req.params.id);
      const { amountSol, amountLamports, pdaSol, pdaLamports, txHash } = req.body || {};

      const deltaSol =
        amountSol != null ? Number(amountSol) : Number(amountLamports || 0) / 1e9;
      if (!isFinite(deltaSol) || deltaSol <= 0) {
        return res
          .status(400)
          .json({ error: "amountSol or amountLamports required (> 0)" });
      }

      await db.recordActivity({ user: id, action: "withdraw", amount: deltaSol, tx_hash: txHash });

      if (pdaSol != null || pdaLamports != null) {
        const absSol = pdaSol != null ? Number(pdaSol) : Number(pdaLamports || 0) / 1e9;
        await setAbsolutePdaBalance(id, absSol);
      } else {
        await adjustPdaBalance(id, -deltaSol);
      }

      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: e?.message || String(e) });
    }
  });

  app.get("/wallets/:id/activities", async (req, res) => {
    try {
      const id = String(req.params.id);
      const limit = Number(req.query.limit || 100);
      const rows = await db.listUserActivities(id, limit);
      res.json(rows);
    } catch (e) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  // Serve uploaded reward icons
  app.use("/uploads", express.static(path.join(__dirname, "uploads")));

  // ---------- Admin Bot (REST + WS feed) ----------
  try {
    const { attachBotFeed, attachBotAdmin } = require("./bot_engine");
    attachBotAdmin?.(app); // mounts /admin/bot/* endpoints
    attachBotFeed?.(ioPlaceholder()); // placeholder; reattached with real io below
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
  // PERSISTENT ADMIN SETTINGS
  // -------------------------
  //
  // NOTE: This block requires `bcrypt` in your dependencies:
  //   npm i bcrypt
  //
  // It persists admin profile, admin credentials (bcrypt hashed), and maintenance
  // configuration into a small `admin_settings` key/value table (jsonb).
  //
  // Protection: set ADMIN_API_KEY in your .env and call endpoints with:
  //   Authorization: Bearer <ADMIN_API_KEY>
  //
  // If ADMIN_API_KEY is not set, requireAdmin will allow (dev mode) but log a warning.
  //
  // Insert this block here so `io` exists for socket emits.

  try {
    const bcrypt = require("bcrypt");
    const SALT_ROUNDS = Number(process.env.PASSWORD_SALT_ROUNDS || 10);
    // Ensure admin_settings table exists
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

    // Admin auth middleware
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
        return res.status(500).json({ error: "internal" });
      }
    }

    // Admin profile helpers
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

    // Maintenance helpers
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

    // --- Endpoints: admin profile / credentials / maintenance ---
    app.get("/admin/me", requireAdmin, async (req, res) => {
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

    // Change password
    // body: { currentPassword, newPassword }
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
        } else {
          // no stored password yet - allow set (protected by ADMIN_API_KEY via requireAdmin)
        }

        const hash = await bcrypt.hash(String(newPassword), SALT_ROUNDS);
        await writeAdminSetting("admin_credentials", { passwordHash: hash });
        return res.json({ ok: true });
      } catch (e) {
        return res.status(500).json({ error: String(e?.message || e) });
      }
    });

    // Maintenance endpoints
    app.get("/admin/maintenance", requireAdmin, async (req, res) => {
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

    app.post("/admin/maintenance/toggle", requireAdmin, async (req, res) => {
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

  // ----- BAN GATE -----
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

  // Load solana instruction helper (you already uploaded `solana_anchor_ix.js`)
  // This module should export a function to build the withdraw instruction, e.g.:
  //    ixWithdraw({ programId, player, userVault, amountLamports }) -> TransactionInstruction
  let solanaAnchorIx = null;
  try {
    solanaAnchorIx = require("./solana_anchor_ix");
  } catch (e) {
    console.warn("[server] solana_anchor_ix helper not found. Ensure ./solana_anchor_ix.js exists and exports ixWithdraw().");
  }

  io.on("connection", (socket) => {
    socket.onAny(async (_event, ...args) => {
      try {
        const w = socket.handshake?.auth?.wallet || extractWalletFromArgs(args);
        if (isMaybeBase58(w) && (await db.isUserBanned(w))) {
          socket.emit("error", { error: "User is banned" });
          socket.disconnect(true);
        }
      } catch {}
    });

    //
    // NEW: handle withdraw prepare requests
    //
    // Client emits: socket.emit("vault:withdraw_prepare", { player, amountLamports, withdrawAddress })
    // Server replies with:
    //   - socket.emit("vault:withdraw_tx", { transactionBase64 })  // unsigned versioned tx (client signs & sends)
    //   - or socket.emit("vault:error", { message })
    //
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
        if (!Number.isFinite(amountLamports) || amountLamports <= 0) {
          socket.emit("vault:error", { message: "invalid amountLamports" });
          return;
        }

        // derive the user_vault PDA & check balance
        let userVault;
        try {
          userVault = deriveUserVaultPda(player);
        } catch (e) {
          socket.emit("vault:error", { message: "bad player pubkey" });
          return;
        }

        const pdaBalance = await connection.getBalance(userVault, "confirmed");
        if (pdaBalance < amountLamports) {
          socket.emit("vault:error", { message: "insufficient vault balance" });
          return;
        }

        // Build withdraw instruction. This code assumes solana_anchor_ix.ixWithdraw exists and returns a TransactionInstruction.
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

        // create a versioned message where the fee payer is the player's wallet
        const { blockhash } = await connection.getLatestBlockhash("confirmed");

        const messageV0 = new TransactionMessage({
          payerKey: new PublicKey(player),
          recentBlockhash: blockhash,
          instructions: [ix],
        }).compileToV0Message();

        const vtx = new VersionedTransaction(messageV0);

        // serialize unsigned vtx to send to client for signing
        const txBase64 = Buffer.from(vtx.serialize()).toString("base64");

        // optional: record prepare activity
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

        // send back tx
        socket.emit("vault:withdraw_tx", { transactionBase64: txBase64 });
      } catch (err) {
        console.error("[vault:withdraw_prepare] error:", err?.message || err);
        try {
          socket.emit("vault:error", { message: String(err?.message || err) });
        } catch {}
      }
    }); // end vault:withdraw_prepare
  });

  // WS mounts (if present)
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
  mountWs("./dice_ws", "Dice", "attachDice");
  mountWs("./slots_ws", "Slots", "attachSlots");
  mountWs("./crash_ws", "Crash", "attachCrash");
  mountWs("./plinko_ws", "Plinko", "attachPlinko");
  mountWs("./coinflip_ws", "Coinflip", "attachCoinflip");
  try {
    require("./mines_ws").attachMines(io);
    console.log("Mines WS mounted");
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

  // mount promos admin router (add this)
  try {
    const promosAdminRouter = require("./admin_promotion_router"); // <-- adjust path if needed
    app.use("/promo", promosAdminRouter); // admin routes are defined as "/admin/..." inside that router
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

    // mount dev admin login route (returns ADMIN_API_KEY on success)
  try {
    const adminAuthRouter = require('./admin_auth_router'); // path relative to server.js
    // mount it under /admin so that router's /login maps to /admin/login
    app.use('/admin', adminAuthRouter);
    console.log('admin_auth_router mounted at /admin');
  } catch (e) {
    console.warn('admin_auth_router not mounted:', e?.message || e);
  }


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
