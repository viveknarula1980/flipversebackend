// bot_engine.js
// Simulated activity feed + admin endpoints.
// Socket namespace: /fake-feed   |  Event: 'activity'
// REST: /admin/bot/config (GET/POST), /admin/bot/enable (POST), /admin/bot/stats (GET)

const DEFAULT_CONFIG = {
  enabled: process.env.DEMO_FEED_ENABLED === "true",
  minMs: 2000,
  maxMs: 7000,
  winRate: 0.45, // 0..1
  minSol: 0.05,
  maxSol: 1.5,
  players: [
    "CryptoWolf92","WojakGains","ElmoX","SolSailor","DeGenKitty",
    "MoonVibes","PlebTony","0xShadow","GreenCandle","ZoggyBot"
  ],
  // Weighted distribution by repetition (client builds repetition)
  games: ["memeslot","crash","plinko","mines","dice","coinflip"],
  multipliers: [1.2,1.3,1.5,2,3,4,5,10,20,50,100],
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

function rand(min, max) { return Math.random() * (max - min) + min; }
function randInt(min, max) { return Math.floor(rand(min, max + 1)); }
function pick(arr) { return arr[randInt(0, arr.length - 1)]; }
function nextDelay() { return Math.round(rand(CONFIG.minMs, CONFIG.maxMs)); }

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

function generateEvent() {
  const user = pick(CONFIG.players);
  const game = pick(CONFIG.games);
  const amount = Number(rand(CONFIG.minSol, CONFIG.maxSol)).toFixed(2);
  const isWin = Math.random() < CONFIG.winRate;
  const mult = isWin ? pick(CONFIG.multipliers) : pick([1, 1.1, 1.15]);
  const payout = isWin ? (Number(amount) * Number(mult)).toFixed(2) : "0.00";

  return {
    simulated: true,
    ts: Date.now(),
    user,
    game,
    amountSol: Number(amount),
    result: isWin ? "win" : "loss",
    multiplier: Number(mult),
    payoutSol: Number(payout),
  };
}

function _loopOnce() {
  if (!CONFIG.enabled || !IO) return;
  const feed = IO.of(FEED_NS);
  const ev = generateEvent();
  _updateStats(ev);
  feed.emit("activity", ev);
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
  io.of(FEED_NS).on("connection", (socket) => {
    socket.emit("hello", { simulated: true, message: "Simulated activity feed (demo mode)" });
  });
  if (CONFIG.enabled) startLoop();
}

// ---- Admin REST glue ----
function _toBool(x, fallback) {
  if (typeof x === "boolean") return x;
  if (x === "true" || x === "1" || x === 1) return true;
  if (x === "false" || x === "0" || x === 0) return false;
  return fallback;
}
function _num(x, fallback) { const n = Number(x); return Number.isFinite(n) ? n : fallback; }
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
    winRate: partial.winRate != null ? Math.max(0, Math.min(1, _num(partial.winRate, CONFIG.winRate))) : CONFIG.winRate,
    minSol: partial.minSol != null ? Math.max(0, _num(partial.minSol, CONFIG.minSol)) : CONFIG.minSol,
    maxSol: partial.maxSol != null ? Math.max(CONFIG.minSol, _num(partial.maxSol, CONFIG.maxSol)) : CONFIG.maxSol,
    players: partial.players ? _arrStrings(partial.players, CONFIG.players) : CONFIG.players,
    games: partial.games ? _arrStrings(partial.games, CONFIG.games) : CONFIG.games,
    multipliers: partial.multipliers ? _arrNumbers(partial.multipliers, CONFIG.multipliers) : CONFIG.multipliers,
  };
  if (CONFIG.minMs > CONFIG.maxMs) [CONFIG.minMs, CONFIG.maxMs] = [CONFIG.maxMs, CONFIG.minMs];
  if (CONFIG.minSol > CONFIG.maxSol) [CONFIG.minSol, CONFIG.maxSol] = [CONFIG.maxSol, CONFIG.minSol];

  if (CONFIG.enabled && !prevEnabled) startLoop();
  else if (!CONFIG.enabled && prevEnabled) stopLoop();
}

function getConfig() { return { ...CONFIG }; }

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
  };
}

function attachBotAdmin(app) {
  app.get("/admin/bot/config", (_req, res) => res.json(getConfig()));
  app.post("/admin/bot/config", (req, res) => {
    try { setConfig(req.body || {}); res.json(getConfig()); }
    catch (e) { res.status(400).json({ error: String(e?.message || e) }); }
  });
  app.post("/admin/bot/enable", (req, res) => {
    try { const { enabled } = req.body || {}; setConfig({ enabled: _toBool(enabled, CONFIG.enabled) }); res.json({ enabled: CONFIG.enabled }); }
    catch (e) { res.status(400).json({ error: String(e?.message || e) }); }
  });
  app.get("/admin/bot/stats", (_req, res) => res.json(getStats()));
}

module.exports = { attachBotFeed, attachBotAdmin, setConfig, getConfig, getStats };
