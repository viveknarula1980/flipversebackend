// Simulated activity feed + admin endpoints.
// Socket namespace: /fake-feed
// Events:
//   - 'activity'  : all events
//   - 'bigwin'    : only big-win events
//   - 'jackpot'   : only jackpot events
//   - 'live'      : live stats after each event
// REST:
//   /admin/bot/config (GET/POST)
//   /admin/bot/enable (POST)
//   /admin/bot/stats (GET)
//   /admin/bot/recent (GET?limit=..&type=all|bigwin|jackpot)
//   /admin/bot/bigwin (POST)
//   /admin/bot/reset-stats (POST)

const DEFAULT_CONFIG = {
  enabled: process.env.DEMO_FEED_ENABLED === "true",
  minMs: 2000,
  maxMs: 7000,
  winRate: 0.45, // 0..1
  minSol: 0.05,
  maxSol: 1.5,
  players: [
    "CryptoWolf92",
    "WojakGains",
    "ElmoX",
    "SolSailor",
    "DeGenKitty",
    "MoonVibes",
    "PlebTony",
    "0xShadow",
    "GreenCandle",
    "ZoggyBot",
  ],
  // Weighted distribution by repetition (client builds repetition)
  games: ["memeslot", "crash", "plinko", "mines", "dice", "coinflip"],
  multipliers: [1.2, 1.3, 1.5, 2, 3, 4, 5, 10, 20, 50, 100],

  // ---- thresholds for filtered streams ----
  bigWinMinMult: Number(process.env.BIGWIN_MULT || 10),
  bigWinMinPayout: Number(process.env.BIGWIN_PAYOUT || 5), // SOL
  jackpotMinMult: Number(process.env.JACKPOT_MULT || 50),
  jackpotMinPayout: Number(process.env.JACKPOT_PAYOUT || 50), // SOL
};

let CONFIG = { ...DEFAULT_CONFIG };

// Loop state
let IO = null;
const FEED_NS = "/fake-feed";
let TIMER = null;

// Live stats
const STATS = {
  startedAt: Date.now(),
  lastActivityTs: null,
  eventCount: 0,
  winCount: 0,
  lossCount: 0,
  volumeSol: 0,
  payoutSol: 0,
  usersSeen: new Map(),
};

// Recent buffer (server-side) — so first-time visitors get previous events
const MAX_RECENT = 200;
const RECENT = []; // keep newest at end

function pushRecent(a) {
  RECENT.push(a);
  if (RECENT.length > MAX_RECENT) RECENT.shift();
}

function _filterType(ev, type) {
  if (type === "bigwin") return isBigWin(ev);
  if (type === "jackpot") return isJackpot(ev);
  return true; // 'all'
}

function getRecentActivities(limit = 50, type = "all") {
  const pool = RECENT.filter((e) => _filterType(e, type));
  const slice = pool.slice(-Math.max(0, Math.min(limit, pool.length)));
  // return newest-first to match client expectation
  return slice.slice().reverse();
}

function rand(min, max) {
  return Math.random() * (max - min) + min;
}
function randInt(min, max) {
  return Math.floor(rand(min, max + 1));
}
function pick(arr) {
  return arr[randInt(0, arr.length - 1)];
}
function nextDelay() {
  return Math.round(rand(CONFIG.minMs, CONFIG.maxMs));
}

function _updateStats(ev) {
  STATS.eventCount += 1;
  STATS.lastActivityTs = ev.ts;
  STATS.usersSeen.set(ev.user, ev.ts);
  STATS.volumeSol += Number(ev.amountSol || 0);
  if (String(ev.result) === "win") {
    STATS.winCount += 1;
    STATS.payoutSol += Number(ev.payoutSol || 0);
  } else {
    STATS.lossCount += 1;
  }
}

function isBigWin(ev) {
  const payout = Number(ev.payoutSol || 0);
  // Since payoutSol is already USD, mark as bigwin if payout between 100–1500 USD
  return (
    String(ev.result) === "win" &&
    payout >= 100 &&
    payout <= 1500
  );
}

function isJackpot(ev) {
  const mult = Number(ev.multiplier || 0);
  const payout = Number(ev.payoutSol || 0);
  return (
    String(ev.result) === "win" &&
    (mult >= Number(CONFIG.jackpotMinMult) || payout >= Number(CONFIG.jackpotMinPayout))
  );
}

function _decorateFlags(ev) {
  if (String(ev.result) === "win") {
    ev.bigwin = isBigWin(ev);
    ev.jackpot = isJackpot(ev);
  } else {
    ev.bigwin = false;
    ev.jackpot = false;
  }
  return ev;
}

function generateEvent() {
  const user = pick(CONFIG.players);
  const game = pick(CONFIG.games);
  const amount = Number(rand(CONFIG.minSol, CONFIG.maxSol)).toFixed(2);
  const isWin = Math.random() < CONFIG.winRate;
  const mult = isWin ? pick(CONFIG.multipliers) : pick([1, 1.1, 1.15]);
  const payout = isWin ? (Number(amount) * Number(mult)).toFixed(2) : "0.00";

  return _decorateFlags({
    simulated: true,
    ts: Date.now(),
    user,
    game,
    amountSol: Number(amount),
    result: isWin ? "win" : "loss",
    multiplier: Number(mult),
    payoutSol: Number(payout),
  });
}

function _emitLive(feed, ev) {
  try {
    feed.emit("live", { stats: getStats(), last: ev });
  } catch (e) {
    // ignore
  }
}

function _broadcastEvent(ev) {
  const feed = IO.of(FEED_NS);
  // all activity stream
  feed.emit("activity", ev);
  // filtered streams
  if (ev.bigwin) feed.emit("bigwin", ev);
  if (ev.jackpot) feed.emit("jackpot", ev);
  // live stats snapshot
  _emitLive(feed, ev);
}

function _loopOnce() {
  if (!CONFIG.enabled || !IO) return;
  const ev = generateEvent();
  _updateStats(ev);
  pushRecent(ev);

  try {
    _broadcastEvent(ev);
  } catch (e) {
    // swallow errors so loop continues
    console.warn("[bot_engine] emit failed:", e?.message || e);
  }

  TIMER = setTimeout(_loopOnce, nextDelay());
}

function startLoop() {
  if (!CONFIG.enabled || !IO) return;
  if (TIMER) clearTimeout(TIMER);
  TIMER = setTimeout(_loopOnce, nextDelay());
}

function stopLoop() {
  if (TIMER) clearTimeout(TIMER);
  TIMER = null;
}

function attachBotFeed(io) {
  IO = io;
  const ns = io.of(FEED_NS);

  ns.on("connection", (socket) => {
    // client gets a hello + initial snapshot
    socket.emit("hello", {
      simulated: true,
      message: "Simulated activity feed (demo mode)",
      filters: {
        bigWinMinMult: CONFIG.bigWinMinMult,
        bigWinMinPayout: CONFIG.bigWinMinPayout,
        jackpotMinMult: CONFIG.jackpotMinMult,
        jackpotMinPayout: CONFIG.jackpotMinPayout,
      },
    });

    // send snapshot: stats + recent activities (+ filtered)
    try {
      socket.emit("snapshot", {
        stats: getStats(),
        recent: getRecentActivities(100, "all"),
        recentBig: getRecentActivities(50, "bigwin"),
        recentJackpot: getRecentActivities(20, "jackpot"),
      });
    } catch (e) {}

    // optional: client can request filtered recent
    socket.on("fetch_recent", (opts, cb) => {
      try {
        const limit =
          typeof opts === "object" && opts && Number.isFinite(Number(opts.limit))
            ? Math.max(1, Math.min(200, Number(opts.limit)))
            : 50;
        const type =
          typeof opts === "object" && opts && typeof opts.type === "string"
            ? opts.type
            : "all";
        const res = getRecentActivities(limit, type);
        if (typeof cb === "function") cb(null, res);
        else socket.emit("recent", res);
      } catch (err) {
        if (typeof cb === "function") cb(String(err));
      }
    });
  });

  // If enabled, start loop (server will run generative feed even if no clients connected)
  if (CONFIG.enabled) startLoop();
}

// ---- Manual Big Win trigger ----
// Ensures payout is randomized BETWEEN 100 and 1500 (inclusive-ish with 2dp),
// and keeps amountSol * multiplier === payoutSol.
function triggerBigWin(payload = {}) {
  if (!IO) throw new Error("Socket.io not initialized");

  // 1) Decide target payout in [100, 1500]
  let targetPayout = Number(rand(100, 1500).toFixed(2));

  // 2) Resolve amountSol
  let amountSol;
  if (payload.amountSol != null) {
    amountSol = Number(payload.amountSol);
  } else {
    // Try to back into a realistic amountSol using existing multiplier set
    const candidates = CONFIG.multipliers
      .filter((m) => Number.isFinite(m) && m > 1)
      .sort(() => Math.random() - 0.5); // shuffle

    let picked = null;
    for (const m of candidates) {
      const amt = Number((targetPayout / m).toFixed(2));
      if (amt >= CONFIG.minSol && amt <= CONFIG.maxSol) {
        picked = { amt, m };
        break;
      }
    }

    if (picked) {
      amountSol = picked.amt;
    } else {
      // Fallback: aim near the middle of allowed amounts
      const midMult = 10; // reasonable big-win multiplier baseline
      let guessAmt = targetPayout / midMult;
      // clamp into [minSol, maxSol]
      guessAmt = Math.max(CONFIG.minSol, Math.min(CONFIG.maxSol, guessAmt));
      amountSol = Number(guessAmt.toFixed(2));
    }
  }

  // Guard against zero/invalid amounts
  if (!Number.isFinite(amountSol) || amountSol <= 0) {
    amountSol = Math.max(CONFIG.minSol, 0.01);
    amountSol = Number(amountSol.toFixed(2));
  }

  // 3) Derive multiplier from payout & amount, then recompute payout for exact consistency
  let multiplier = Number((targetPayout / amountSol).toFixed(2));
  let payoutSol = Number((amountSol * multiplier).toFixed(2));

  // 4) Correct for rounding drifting outside [100, 1500]
  if (payoutSol < 100) {
    multiplier = Number(((100 / amountSol) + 0.01).toFixed(2));
    payoutSol = Number((amountSol * multiplier).toFixed(2));
  } else if (payoutSol > 1500) {
    multiplier = Number((1500 / amountSol).toFixed(2));
    payoutSol = Number((amountSol * multiplier).toFixed(2));
  }

  const ev = _decorateFlags({
    simulated: true,
    ts: Date.now(),
    user: payload.user || pick(CONFIG.players),
    game: payload.game || "memeslot",
    amountSol: Number(amountSol),
    result: "win",
    multiplier: Number(multiplier),
    payoutSol: Number(payoutSol),
  });

  _updateStats(ev);
  pushRecent(ev);

  try {
    _broadcastEvent(ev); // IMMEDIATE broadcast to all + filtered
  } catch (e) {
    console.warn("[bot_engine] bigwin emit failed:", e?.message || e);
  }

  return ev;
}

// ---- Stats reset (useful for admin dashboards) ----
function resetStats() {
  STATS.startedAt = Date.now();
  STATS.lastActivityTs = null;
  STATS.eventCount = 0;
  STATS.winCount = 0;
  STATS.lossCount = 0;
  STATS.volumeSol = 0;
  STATS.payoutSol = 0;
  STATS.usersSeen.clear();
}

//
// ---- Admin REST glue ----
function _toBool(x, fallback) {
  if (typeof x === "boolean") return x;
  if (x === "true" || x === "1" || x === 1) return true;
  if (x === "false" || x === "0" || x === 0) return false;
  return fallback;
}
function _num(x, fallback) {
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
}
function _arrStrings(x, fallback) {
  if (Array.isArray(x)) return x.map(String).filter(Boolean);
  return fallback;
}
function _arrNumbers(x, fallback) {
  if (Array.isArray(x)) {
    const out = x.map(Number).filter((n) => Number.isFinite(n));
    return out.length ? out : fallback;
  }
  return fallback;
}

function setConfig(partial = {}) {
  const prevEnabled = !!CONFIG.enabled;
  CONFIG = {
    ...CONFIG,
    enabled: partial.enabled != null ? _toBool(partial.enabled, prevEnabled) : prevEnabled,
    minMs: partial.minMs != null ? Math.max(100, _num(partial.minMs, CONFIG.minMs)) : CONFIG.minMs,
    maxMs: partial.maxMs != null ? Math.max(200, _num(partial.maxMs, CONFIG.maxMs)) : CONFIG.maxMs,
    winRate:
      partial.winRate != null ? Math.max(0, Math.min(1, _num(partial.winRate, CONFIG.winRate))) : CONFIG.winRate,
    minSol: partial.minSol != null ? Math.max(0, _num(partial.minSol, CONFIG.minSol)) : CONFIG.minSol,
    maxSol: partial.maxSol != null ? Math.max(CONFIG.minSol, _num(partial.maxSol, CONFIG.maxSol)) : CONFIG.maxSol,
    players: partial.players ? _arrStrings(partial.players, CONFIG.players) : CONFIG.players,
    games: partial.games ? _arrStrings(partial.games, CONFIG.games) : CONFIG.games,
    multipliers: partial.multipliers ? _arrNumbers(partial.multipliers, CONFIG.multipliers) : CONFIG.multipliers,

    // thresholds (optional overrides)
    bigWinMinMult:
      partial.bigWinMinMult != null ? Math.max(1, _num(partial.bigWinMinMult, CONFIG.bigWinMinMult)) : CONFIG.bigWinMinMult,
    bigWinMinPayout:
      partial.bigWinMinPayout != null ? Math.max(0, _num(partial.bigWinMinPayout, CONFIG.bigWinMinPayout)) : CONFIG.bigWinMinPayout,
    jackpotMinMult:
      partial.jackpotMinMult != null ? Math.max(1, _num(partial.jackpotMinMult, CONFIG.jackpotMinMult)) : CONFIG.jackpotMinMult,
    jackpotMinPayout:
      partial.jackpotMinPayout != null ? Math.max(0, _num(partial.jackpotMinPayout, CONFIG.jackpotMinPayout)) : CONFIG.jackpotMinPayout,
  };
  if (CONFIG.minMs > CONFIG.maxMs) [CONFIG.minMs, CONFIG.maxMs] = [CONFIG.maxMs, CONFIG.minMs];
  if (CONFIG.minSol > CONFIG.maxSol) [CONFIG.minSol, CONFIG.maxSol] = [CONFIG.maxSol, CONFIG.minSol];

  if (CONFIG.enabled && !prevEnabled) startLoop();
  else if (!CONFIG.enabled && prevEnabled) stopLoop();
}

function getConfig() {
  return { ...CONFIG };
}

function getStats() {
  const now = Date.now();
  const ACTIVE_TTL = 10 * 60 * 1000;
  let activeUsers = 0;
  for (const [, last] of STATS.usersSeen) if (now - last <= ACTIVE_TTL) activeUsers++;
  const winRatePct =
    STATS.winCount + STATS.lossCount > 0
      ? Math.round((STATS.winCount / (STATS.winCount + STATS.lossCount)) * 100)
      : Math.round(CONFIG.winRate * 100);
  return {
    startedAt: STATS.startedAt,
    lastActivityTs: STATS.lastActivityTs,
    activeUsers,
    totalEvents: STATS.eventCount,
    wins: STATS.winCount,
    losses: STATS.lossCount,
    dailyVolume: Number(STATS.volumeSol.toFixed(3)),
    totalPayout: Number(STATS.payoutSol.toFixed(3)),
    winRate: winRatePct,
    // expose thresholds so dashboard can show badges consistently
    thresholds: {
      bigWinMinMult: CONFIG.bigWinMinMult,
      bigWinMinPayout: CONFIG.bigWinMinPayout,
      jackpotMinMult: CONFIG.jackpotMinMult,
      jackpotMinPayout: CONFIG.jackpotMinPayout,
    },
  };
}

function attachBotAdmin(app) {
  app.get("/admin/bot/config", (_req, res) => res.json(getConfig()));

  app.post("/admin/bot/config", (req, res) => {
    try {
      setConfig(req.body || {});
      res.json(getConfig());
    } catch (e) {
      res.status(400).json({ error: String(e?.message || e) });
    }
  });

  app.post("/admin/bot/enable", (req, res) => {
    try {
      const { enabled } = req.body || {};
      setConfig({ enabled: _toBool(enabled, CONFIG.enabled) });
      res.json({ enabled: CONFIG.enabled });
    } catch (e) {
      res.status(400).json({ error: String(e?.message || e) });
    }
  });

  app.get("/admin/bot/stats", (_req, res) => res.json(getStats()));

  // Recent activities so clients can fetch initial history (with optional filter)
  app.get("/admin/bot/recent", (req, res) => {
    try {
      const limit = Math.max(1, Math.min(200, Number(req.query.limit || 50)));
      const type = (req.query.type || "all").toString(); // 'all' | 'bigwin' | 'jackpot'
      const recent = getRecentActivities(limit, type);
      res.json(recent);
    } catch (e) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // Trigger immediate BIG WIN
  app.post("/admin/bot/bigwin", (req, res) => {
    try {
      const ev = triggerBigWin(req.body || {});
      res.json({ ok: true, event: ev });
    } catch (e) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // Reset stats
  app.post("/admin/bot/reset-stats", (_req, res) => {
    try {
      resetStats();
      res.json({ ok: true, stats: getStats() });
    } catch (e) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });
}

module.exports = {
  attachBotFeed,
  attachBotAdmin,
  setConfig,
  getConfig,
  getStats,
  getRecentActivities,
  triggerBigWin, // export for programmatic triggers if needed
  resetStats,
};
