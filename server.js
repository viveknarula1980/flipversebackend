// server.js
require("dotenv").config();

const http = require("http");
const { Server } = require("socket.io");
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const { PublicKey } = require("@solana/web3.js");

// ---------- RPC / Program IDs ----------
const CLUSTER = process.env.CLUSTER || "https://api.devnet.solana.com";

if (!process.env.PROGRAM_ID) throw new Error("PROGRAM_ID missing in .env"); // Dice program id (for health output/logging)
const PROGRAM_ID = new PublicKey(process.env.PROGRAM_ID);

const CRASH_PROGRAM_ID =
  process.env.Crash_PROGRAM_ID || process.env.NEXT_PUBLIC_CRASH_PROGRAM_ID || null;
const PLINKO_PROGRAM_ID =
  process.env.PLINKO_PROGRAM_ID || process.env.NEXT_PUBLIC_PLINKO_PROGRAM_ID || null;
const COINFLIP_PROGRAM_ID =
  process.env.COINFLIP_PROGRAM_ID || process.env.NEXT_PUBLIC_COINFLIP_PROGRAM_ID || null;

// ---------- DB ----------
let db = require("./db");
global.db = db;

// ensure schema on boot (safe to call repeatedly)
db.ensureSchema?.().catch((e) => {
  console.warn("[ensureSchema] failed:", e?.message || e);
});

// ---------- helpers ----------
function pctToBps(x) {
  // supports number or string like "6", "6.0", 6
  const n = Math.max(0, Math.min(100, Number(x)));
  return Math.round(n * 100); // 6% -> 600 bps
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
  // try common fields on first arg (object payloads used by your WS handlers)
  const a = args?.[0];
  if (a && typeof a === "object") {
    for (const k of ["wallet", "user", "player", "address", "publicKey", "user_id", "userId"]) {
      const v = a[k];
      if (isMaybeBase58(v)) return v;
      if (v && typeof v === "object" && isMaybeBase58(v?.toString?.())) return v.toString();
    }
  }
  return null;
}

// ---------- Express ----------
const app = express();

const ALLOW_ORIGINS = (process.env.ALLOW_ORIGINS || "*")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: ALLOW_ORIGINS.length === 1 && ALLOW_ORIGINS[0] === "*" ? "*" : ALLOW_ORIGINS,
    methods: ["GET", "POST", "PUT", "PATCH", "OPTIONS"],
    credentials: false,
  })
);
app.use(bodyParser.json());

// Health
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

// Public rules (fallbacks)
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

// ---------------- Admin APIs (Games + Dashboard) ----------------
app.get("/admin/games", async (_req, res) => {
  try {
    const rows = await db.listGameConfigs();
    const metrics = await computeGameMetrics(); // { [game_key]: { revenue, plays } }

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
    // Generic rounds (dice, crash, plinko, mines)
    const gr = await db.pool.query(
      `select game_key,
              coalesce(sum(stake_lamports - payout_lamports),0)::text as rev,
              count(*)::int as plays
       from game_rounds
       group by game_key`
    );
    for (const r of gr.rows) {
      out[r.game_key] = out[r.game_key] || { revenue: 0, plays: 0 };
      out[r.game_key].revenue += Number(r.rev) / 1e9;
      out[r.game_key].plays += Number(r.plays || 0);
    }

    // Coinflip
    if (await db._tableExistsUnsafe("coinflip_matches")) {
      const cf = await db.pool.query(
        `select coalesce(sum((bet_lamports*2) - payout_lamports),0)::text as rev,
                count(*)::int as plays
         from coinflip_matches`
      );
      out["coinflip"] = out["coinflip"] || { revenue: 0, plays: 0 };
      out["coinflip"].revenue += Number(cf.rows[0].rev || 0) / 1e9;
      out["coinflip"].plays += Number(cf.rows[0].plays || 0);
    }

    // Slots (FIXED: keep in SOL)
    if (await db._tableExistsUnsafe("slots_spins")) {
      const ss = await db.pool.query(
        `select coalesce(sum(bet_amount - payout),0)::text as rev_sol,
                count(*)::int as plays
         from slots_spins`
      );
      out["slots"] = out["slots"] || { revenue: 0, plays: 0 };
      out["slots"].revenue += Number(ss.rows[0].rev_sol || 0); // stays in SOL
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

    // Support houseEdgePct → fee_bps/rtp_bps
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

// convenience endpoint just for house edge changes
app.put("/admin/games/:id/house-edge", async (req, res) => {
  try {
    const id = String(req.params.id);
    const { houseEdgePct } = req.body || {};
    if (houseEdgePct == null || houseEdgePct === "" || isNaN(Number(houseEdgePct))) {
      return res.status(400).json({ error: "houseEdgePct required (number)" });
    }
    const fee_bps = pctToBps(houseEdgePct);
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
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

app.get("/admin/users/:id", async (req, res) => {
  try {
    const id = String(req.params.id);
    const u = await db.getUserDetails(id);
    if (!u) return res.status(404).json({ error: "User not found" });
    res.json(u);
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
      limit = "5", // UI default page size
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
      limit: 1000000, // effectively "all"
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

// ---------- HTTP server + Socket.IO ----------
const PORT = Number(process.env.PORT || 4000);
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: ALLOW_ORIGINS.length === 1 && ALLOW_ORIGINS[0] === "*" ? "*" : ALLOW_ORIGINS,
    methods: ["GET", "POST"],
  },
});

// ----- BAN GATE (global) -----
// On connect: if handshake.auth.wallet is banned, reject connection
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

// After connection: if *any* incoming event payload shows a banned wallet, disconnect.
io.on("connection", (socket) => {
  socket.onAny(async (event, ...args) => {
    try {
      const w =
        socket.handshake?.auth?.wallet ||
        extractWalletFromArgs(args);

      if (isMaybeBase58(w) && (await db.isUserBanned(w))) {
        socket.emit("error", { error: "User is banned" });
        socket.disconnect(true);
      }
    } catch {}
  });
});

// Helper: mount WS module defensively
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

// Dice (WebSocket; no HTTP endpoints here)
mountWs("./dice_ws", "Dice", "attachDice");

// Slots
mountWs("./slots_ws", "Slots", "attachSlots");
// Crash
mountWs("./crash_ws", "Crash", "attachCrash");
// Plinko
mountWs("./plinko_ws", "Plinko", "attachPlinko");
// Coinflip
mountWs("./coinflip_ws", "Coinflip", "attachCoinflip");
// Mines
try {
  require("./mines_ws").attachMines(io);
  console.log("Mines WS mounted");
} catch (e) {
  console.warn("mines_ws not found / failed to mount:", e?.message || e);
}

server.listen(PORT, () => {
  console.log(
    `api up on :${PORT} (cluster=${CLUSTER}, dice_program=${PROGRAM_ID.toBase58()}, crash_program=${CRASH_PROGRAM_ID || "—"}, plinko_program=${PLINKO_PROGRAM_ID || "—"}, coinflip_program=${COINFLIP_PROGRAM_ID || "—"})`
  );
});
