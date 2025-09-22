// bonus_guard.js
require("dotenv").config();

const API_BASE = process.env.API_BASE || "https://flipversebackend.onrender.com"; // where server.js runs

async function precheckOrThrow({ userWallet, stakeLamports, gameKey, autoCashoutX }) {
  const qs = new URLSearchParams({
    userWallet,
    game: gameKey,
    stakeLamports: String(stakeLamports || 0),
  });
  if (autoCashoutX != null) qs.set("autoCashoutX", String(autoCashoutX));

  const r = await fetch(`${API_BASE}/promo/welcome/can-bet?${qs.toString()}`);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error || `can-bet ${r.status}`);
  if (j.allowed === false) {
    const max = j.maxBetUsd != null ? ` (max $${j.maxBetUsd})` : "";
    throw new Error(`bonus-guard: ${j.reason}${max}`);
  }
  return j;
}

module.exports = { precheckOrThrow };
