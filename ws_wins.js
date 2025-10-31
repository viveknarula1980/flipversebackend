// ws_wins.js
const { LAMPORTS_PER_SOL } = require("@solana/web3.js");
const https = require("https");

let ioRef = null;
const recentEvents = [];
const MAX_EVENTS = 100;

// --- Default fallback SOL price (in USD) ---
let solPriceUsd = 175;

// --- Periodically refresh SOL price from CoinGecko ---
async function refreshSolPrice() {
  try {
    https
      .get(
        "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd",
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => {
            try {
              const json = JSON.parse(data);
              const price = Number(json?.solana?.usd || 0);
              if (price > 0) {
                solPriceUsd = price;
                console.log(`[ws_wins] ✅ Updated SOL price: $${solPriceUsd}`);
              }
            } catch (e) {
              console.warn("[ws_wins] ⚠️ Failed to parse price:", e?.message || e);
            }
          });
        }
      )
      .on("error", (err) => {
        console.warn("[ws_wins] ⚠️ SOL price fetch error:", err?.message || err);
      });
  } catch (e) {
    console.warn("[ws_wins] ⚠️ Error refreshing SOL price:", e?.message || e);
  }
}

// refresh price every 60s
refreshSolPrice();
setInterval(refreshSolPrice, 60 * 1000);

// --- Broadcast a win/loss event to all clients ---
function broadcastWinEvent(io, data) {
  const amountSolRaw = Number(data.amountSol || 0);
  const payoutSolRaw = Number(data.payoutSol || 0);

  // Convert SOL → USD (round to 2 decimals)
  const amountSol = Number((amountSolRaw * solPriceUsd).toFixed(2));
  const payoutSol = Number((payoutSolRaw * solPriceUsd).toFixed(2));

  // Compute multiplier precisely to 2 decimals
  const multiplier =
    data.multiplier !== undefined
      ? Number(data.multiplier)
      : amountSolRaw > 0
      ? payoutSolRaw / amountSolRaw
      : 0;

  const roundedMult = Number(multiplier.toFixed(2));

  const event = {
    simulated: false,
    ts: Date.now(),
    user: data.user || data.username || "Unknown",
    game: data.game || "unknown",
    amountSol, // now represents USD value
    payoutSol, // now represents USD value
    result: data.result || (payoutSolRaw > amountSolRaw ? "win" : "loss"),
    multiplier: roundedMult,
    bigwin: payoutSolRaw >= amountSolRaw * 10,
    jackpot: !!data.jackpot,
    stats: computeStats(),
  };

  recentEvents.unshift(event);
  if (recentEvents.length > MAX_EVENTS) recentEvents.pop();

  io.emit("wins:push", event);
}

// --- Compute rolling stats for dashboard ---
function computeStats() {
  const now = Date.now();
  const activeUsers = new Set();
  let wins = 0,
    losses = 0,
    total = 0;

  for (const e of recentEvents) {
    total++;
    if (e.result === "win") wins++;
    else if (e.result === "loss") losses++;
    activeUsers.add(e.user);
  }

  return {
    startedAt: recentEvents[recentEvents.length - 1]?.ts || now,
    lastActivityTs: recentEvents[0]?.ts || now,
    activeUsers: activeUsers.size,
    totalEvents: total,
    wins,
    losses,
    winRate: total ? (wins / total) * 100 : 0,
  };
}

// --- Attach WebSocket feed ---
function attachWinsFeed(io) {
  const winsNamespace = io.of("/wins");
  ioRef = winsNamespace;

  winsNamespace.on("connection", (socket) => {
    socket.emit("wins:recent", recentEvents);
  });

  console.log("✅ Wins WebSocket feed attached at /wins (values in USDT)");
}


// --- Export functions ---
module.exports = {
  attachWinsFeed,
  pushWinEvent: (data) => {
    if (ioRef) broadcastWinEvent(ioRef, data);
  },
};
