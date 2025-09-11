// vault_listener.js
require("dotenv").config();

const { Connection, PublicKey } = require("@solana/web3.js");
const bs58 = require("bs58");

// ---------- ENV ----------
const RPC_HTTP = process.env.CLUSTER || "https://api.devnet.solana.com";
const RPC_WS =
  process.env.WS_CLUSTER ||
  (RPC_HTTP.startsWith("https://")
    ? RPC_HTTP.replace("https://", "wss://")
    : RPC_HTTP.replace("http://", "ws://"));

if (!process.env.PROGRAM_ID) throw new Error("PROGRAM_ID missing in .env");
const PROGRAM_ID = new PublicKey(process.env.PROGRAM_ID);

// Where your Express API is running (for /promo/welcome/credit-on-deposit)
const API_BASE = process.env.API_BASE || "https://backendgame-1c3u.onrender.com";

const SOL_PER_LAMPORT = 1e-9;

// ---------- DB ----------
const db = require("./db");

// ---------- fetch helper (Node 18+ has global fetch; fallback to node-fetch) ----------
const _fetch = (...args) =>
  (globalThis.fetch ? globalThis.fetch(...args) : import("node-fetch").then(({ default: f }) => f(...args)));

// ---------- Live SOL/USD price (cached) ----------
const USD_PER_SOL_FALLBACK = Number(process.env.USD_PER_SOL || 200);
const PRICE_TTL_MS = Number(process.env.PRICE_TTL_MS || 60_000);
let _priceCache = { usd: null, ts: 0 };

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
  for (const fn of [fetchSolUsdFromCoingecko, fetchSolUsdFromCoinbase, fetchSolUsdFromBinance]) {
    try {
      usd = await fn();
      break;
    } catch { /* try next */ }
  }
  if (!usd) usd = USD_PER_SOL_FALLBACK;
  _priceCache = { usd, ts: now };
  return usd;
}

async function postCreditOnDeposit({ userWallet, amountSol, txSig }) {
  try {
    const r = await _fetch(`${API_BASE}/promo/welcome/credit-on-deposit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userWallet, amountSol, txSig }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.warn("[listener] credit-on-deposit failed:", r.status, j);
    } else {
      console.log("[listener] credit-on-deposit ok:", j);
    }
  } catch (e) {
    console.warn("[listener] credit-on-deposit error:", e?.message || e);
  }
}

// ---------- Discriminators from IDL ----------
const DISC = {
  deposit_to_vault: Buffer.from([18, 62, 110, 8, 26, 106, 248, 151]),
  withdraw_from_vault: Buffer.from([180, 34, 37, 46, 156, 0, 211, 238]),
  activate_user_vault: Buffer.from([206, 42, 182, 219, 174, 102, 115, 64]),
};

// Account order (from your IDL)
const ACCOUNT_INDEX = {
  player: 0,
  user_vault: 1,
};

// ---------- Helpers ----------
function bufEq(a, b) {
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** read u64 little-endian from buffer as BigInt */
function readU64LE(buf, offset = 0) {
  const lo = buf.readUInt32LE(offset);
  const hi = buf.readUInt32LE(offset + 4);
  return (BigInt(hi) << 32n) | BigInt(lo);
}

function lamportsToNumberSol(l) {
  return Number(l) * SOL_PER_LAMPORT;
}

/** Derive user_vault PDA from player pubkey */
function userVaultPda(player) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("user_vault"), new PublicKey(player).toBuffer()],
    PROGRAM_ID
  )[0];
}

/**
 * Resolve an instruction account (which might be an index) to a base58 pubkey string.
 * Works for both top-level and inner instructions from getParsedTransaction().
 */
function accountIndexToBase58(tx, ixAccount) {
  // Already a PublicKey-like?
  if (ixAccount && typeof ixAccount === "object") {
    if (typeof ixAccount.toBase58 === "function") return ixAccount.toBase58();
    if (ixAccount.pubkey) {
      const pk = ixAccount.pubkey;
      return typeof pk.toBase58 === "function" ? pk.toBase58() : String(pk);
    }
  }
  // If it's a string, assume it's already base58
  if (typeof ixAccount === "string") return ixAccount;

  // Number index -> look up in message.accountKeys
  if (typeof ixAccount === "number") {
    const keys = tx?.transaction?.message?.accountKeys || [];
    const entry = keys[ixAccount];
    if (!entry) return "";
    const pk = entry.pubkey ?? entry; // ParsedMessageAccount or PublicKey
    return typeof pk.toBase58 === "function" ? pk.toBase58() : String(pk);
  }

  return String(ixAccount || "");
}

/** Best-effort extraction of all program-owned instructions (top-level + inner) */
function collectProgramInstructions(tx, programIdStr) {
  const out = [];

  const top = tx?.transaction?.message?.instructions || [];
  for (const ix of top) {
    if (ix?.programId && ix.programId.toBase58 && ix.programId.toBase58() === programIdStr) {
      out.push(ix);
    }
  }

  const inner = tx?.meta?.innerInstructions || [];
  for (const group of inner) {
    for (const ix of group.instructions || []) {
      if (ix?.programId && ix.programId.toBase58 && ix.programId.toBase58() === programIdStr) {
        out.push(ix);
      }
    }
  }

  return out;
}

/** Decode our Anchor instruction name + amount (if present) from data b58 */
function decodeIxDataBase58(dataB58) {
  const raw = Buffer.from(bs58.decode(String(dataB58 || "")));
  if (raw.length < 8) return null;

  const head = raw.subarray(0, 8);

  if (bufEq(head, DISC.deposit_to_vault)) {
    const amountLamports = readU64LE(raw, 8);
    return { name: "deposit_to_vault", amountLamports };
  }

  if (bufEq(head, DISC.withdraw_from_vault)) {
    const amountLamports = readU64LE(raw, 8);
    return { name: "withdraw_from_vault", amountLamports };
  }

  if (bufEq(head, DISC.activate_user_vault)) {
    // Some programs pass amount here, some don't — be defensive
    const amountLamports = raw.length >= 16 ? readU64LE(raw, 8) : 0n;
    return { name: "activate_user_vault", amountLamports };
  }

  return null;
}

// ---------- Seen Signatures ----------
const seen = new Set();
// optional: cleanup to avoid unbounded memory growth
setInterval(() => {
  if (seen.size > 5000) {
    console.log(`[listener] clearing seen set (size=${seen.size})`);
    seen.clear();
  }
}, 60 * 60 * 1000); // every 1h

// ---------- Core handler ----------
async function handleSignature(sig, connection) {
  try {
    const tx = await connection.getParsedTransaction(sig, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    if (!tx) return;

    const programIdStr = PROGRAM_ID.toBase58();
    const ixs = collectProgramInstructions(tx, programIdStr);
    if (!ixs.length) return;

    let creditedOnce = false;

    for (const ix of ixs) {
      const accs = ix.accounts || [];
      const dataB58 = ix.data;

      const decoded = decodeIxDataBase58(dataB58);
      if (!decoded) continue;

      // FIX: resolve account index -> base58 wallet
      const playerStr = accountIndexToBase58(tx, accs[ACCOUNT_INDEX.player]);
      if (!playerStr) continue;

      const pda = userVaultPda(playerStr);
      const pdaLamports = await connection.getBalance(pda, "confirmed");

      const lamports = BigInt(decoded.amountLamports || 0n);
      const amountSol = lamportsToNumberSol(lamports);

      if (decoded.name === "deposit_to_vault" || decoded.name === "activate_user_vault") {
        // Live USD at time
        const price = await getSolUsdPrice();
        const usdAtTx = amountSol * price;

        // Record activity (both SOL and USD)
        await db.recordActivity({
          user: playerStr,
          action: "deposit",
          amount: amountSol,
          amount_usd: usdAtTx,
          price_usd_per_sol: price,
        });

        // Keep the PDA balance
        await db.updatePdaBalance(playerStr, pdaLamports);

        console.log(
          `[listener] deposit ${amountSol.toFixed(9)} SOL (~$${usdAtTx.toFixed(2)}) -> ${playerStr} (pda=${pda.toBase58()}) sig=${sig}`
        );

        // Trigger Welcome Bonus credit ONCE per signature if amount > 0
        if (!creditedOnce && lamports > 0n) {
          creditedOnce = true;
          postCreditOnDeposit({
            userWallet: playerStr,
            amountSol,
            txSig: sig,
          }).finally(async () => {
            // annotate (or insert) the deposits row with SOL + USD
            try {
              await db.annotateDepositBySig({
                tx_sig: sig,
                user_wallet: playerStr,
                amount_lamports: lamports,
                amount_sol: amountSol,
                usd_at_tx: usdAtTx,
                price_usd_per_sol: price,
              });
            } catch (e) {
              console.warn("[listener] annotateDepositBySig failed:", e?.message || e);
            }
          });
        }
      } else if (decoded.name === "withdraw_from_vault") {
        const price = await getSolUsdPrice();
        const usdAtTx = amountSol * price;

        await db.recordActivity({
          user: playerStr,
          action: "withdraw",
          amount: amountSol,
          amount_usd: usdAtTx,
          price_usd_per_sol: price,
        });
        await db.updatePdaBalance(playerStr, pdaLamports);

        console.log(
          `[listener] withdraw ${amountSol.toFixed(9)} SOL (~$${usdAtTx.toFixed(2)}) <- ${playerStr} (pda=${pda.toBase58()}) sig=${sig}`
        );
      }
    }
  } catch (e) {
    console.warn("[vault_listener] handleSignature failed:", e?.message || e);
  }
}

// ---------- Main ----------
async function main() {
  try {
    if (db.ensureSchema) await db.ensureSchema();
    if (db.ensureAccountingExtensions) await db.ensureAccountingExtensions();
  } catch (e) {
    console.warn("[listener] ensure* skipped/failed:", e?.message || e);
  }

  const connection = new Connection(RPC_HTTP, {
    wsEndpoint: RPC_WS,
    commitment: "confirmed",
  });

  console.log(
    `[listener] watching program ${PROGRAM_ID.toBase58()} on ${RPC_HTTP} (ws: ${RPC_WS})`
  );

  connection.onLogs(
    PROGRAM_ID,
    async (logInfo) => {
      const sig = logInfo.signature;
      if (!sig) return;
      if (seen.has(sig)) return;
      seen.add(sig);

      setTimeout(() => handleSignature(sig, connection), 400);
    },
    "confirmed"
  );
}

// ---------- Exported Start Function ----------
async function start() {
  await main();
}

module.exports = { start };
