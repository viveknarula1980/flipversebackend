// // backend/signer.js
// const bs58 = require("bs58");
// const nacl = require("tweetnacl");
// const fs = require("fs");
// const os = require("os");
// const path = require("path");
// const { Keypair } = require("@solana/web3.js");

// // --- Admin ed25519 keys (used for on-chain Ed25519Program pre-instruction) ---
// const ADMIN_PRIVKEY_BASE58 = process.env.ADMIN_PRIVKEY_BASE58 || "";
// const ADMIN_PUBKEY_BASE58  = process.env.ADMIN_PUBKEY_BASE58  || "";

// if (!ADMIN_PRIVKEY_BASE58) {
//   throw new Error("Missing ADMIN_PRIVKEY_BASE58 in env");
// }

// const skDecoded = bs58.decode(ADMIN_PRIVKEY_BASE58); // 32 (seed) or 64 (secret||pub)
// const pkDecoded = ADMIN_PUBKEY_BASE58 ? bs58.decode(ADMIN_PUBKEY_BASE58) : null;

// let SECRET64; // 64 bytes: secret(32) || public(32)
// let ADMIN_PK; // 32 bytes public key (Uint8Array)

// if (skDecoded.length === 64) {
//   SECRET64 = Uint8Array.from(skDecoded);
//   ADMIN_PK = Uint8Array.from(SECRET64.slice(32));
// } else if (skDecoded.length === 32) {
//   const kp = nacl.sign.keyPair.fromSeed(Uint8Array.from(skDecoded));
//   SECRET64 = Uint8Array.from(kp.secretKey); // 64
//   ADMIN_PK = Uint8Array.from(kp.publicKey); // 32
// } else {
//   throw new Error("ADMIN_PRIVKEY_BASE58 must decode to 32 (seed) or 64 (secret||pub) bytes");
// }

// if (pkDecoded && Buffer.compare(Buffer.from(pkDecoded), Buffer.from(ADMIN_PK)) !== 0) {
//   throw new Error("ADMIN_PUBKEY_BASE58 does not match the derived public key");
// }

// // ---- small LE helpers for DICE_V1 message ----
// function u64le(nBig) {
//   const b = Buffer.alloc(8);
//   b.writeBigUInt64LE(BigInt(nBig), 0);
//   return b;
// }
// function i64le(nBig) {
//   const b = Buffer.alloc(8);
//   b.writeBigInt64LE(BigInt(nBig), 0);
//   return b;
// }

// // ---- Canonical message for Dice resolve (your HTTP server uses this) ----
// function buildMessageBytes(params) {
//   // params: { programId(32), vault(32), player(32), betAmount, betType, target, roll, payout, nonce, expiryUnix }
//   const enc = new TextEncoder();
//   const parts = [];
//   parts.push(enc.encode("DICE_V1"));
//   parts.push(Buffer.from(params.programId)); // 32
//   parts.push(Buffer.from(params.vault));     // 32
//   parts.push(Buffer.from(params.player));    // 32
//   parts.push(u64le(params.betAmount));
//   parts.push(Buffer.from([params.betType & 0xff]));
//   parts.push(Buffer.from([params.target & 0xff]));
//   parts.push(Buffer.from([params.roll & 0xff]));
//   parts.push(u64le(params.payout));
//   parts.push(u64le(params.nonce));
//   parts.push(i64le(params.expiryUnix));
//   return Buffer.concat(parts);
// }

// // ---- Ed25519 signer (tweetnacl) ----
// async function signMessageEd25519(msg) {
//   const sig = nacl.sign.detached(Uint8Array.from(msg), SECRET64);
//   return Buffer.from(sig);
// }

// // -------------------- Fee payer (server) --------------------
// // Robust path normalization: expand "~", strip stray quotes and trailing backslashes/spaces.
// function normalizePath(pth) {
//   if (!pth) return "";
//   let s = String(pth).trim();
//   // strip surrounding quotes if present
//   if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
//     s = s.slice(1, -1);
//   }
//   // strip trailing backslashes or spaces that sometimes sneak in from shells
//   s = s.replace(/[\\\s]+$/g, "");
//   // expand ~
//   if (s.startsWith("~")) s = s.replace(/^~(?=\/|$)/, os.homedir());
//   return s;
// }

// function readKeypairFile(anyPath) {
//   const p = normalizePath(anyPath);
//   const raw = fs.readFileSync(p, "utf8").trim();

//   // 1) Try JSON array (Solana CLI format)
//   try {
//     const parsed = JSON.parse(raw);
//     if (Array.isArray(parsed)) {
//       const sk = Uint8Array.from(parsed);
//       if (sk.length !== 64) throw new Error(`unexpected key length ${sk.length}, want 64`);
//       return Keypair.fromSecretKey(sk);
//     }
//   } catch (_) {
//     // fall through
//   }

//   // 2) Try base58 secret key (64 bytes)
//   try {
//     const sk58 = raw.replace(/\s+/g, "");
//     const sk = bs58.decode(sk58);
//     if (sk.length !== 64) throw new Error(`unexpected base58 key length ${sk.length}, want 64`);
//     return Keypair.fromSecretKey(Uint8Array.from(sk));
//   } catch (_) {
//     // fall through
//   }

//   throw new Error(`Unrecognized keypair format at ${p}`);
// }

// /**
//  * Returns a funded Keypair the backend will use as fee payer.
//  * Priority:
//  *  1) SOLANA_KEYPAIR or ANCHOR_WALLET or SERVER_KEYPAIR_PATH (JSON or base58)
//  *  2) ~/.config/solana/id.json
//  *  3) Derive from ADMIN seed (⚠️ likely unfunded; last resort)
//  */
// async function getServerKeypair() {
//   const envPath =
//     process.env.SOLANA_KEYPAIR ||
//     process.env.ANCHOR_WALLET ||
//     process.env.SERVER_KEYPAIR_PATH;

//   if (envPath) {
//     try {
//       const kp = readKeypairFile(envPath);
//       console.log("[signer] fee payer =", kp.publicKey.toBase58(), "(from env keypair)");
//       return kp;
//     } catch (e) {
//       throw new Error(`Failed to read keypair from env path (${envPath}): ${e.message}`);
//     }
//   }

//   // Default Solana CLI path
//   try {
//     const def = path.join(os.homedir(), ".config/solana/id.json");
//     const kp = readKeypairFile(def);
//     console.log("[signer] fee payer =", kp.publicKey.toBase58(), "(from ~/.config/solana/id.json)");
//     return kp;
//   } catch (e) {
//     // Last resort: derive from admin seed (32 bytes). This is convenient but usually unfunded.
//     console.warn("[signer] WARNING: falling back to ADMIN seed as fee payer (likely unfunded). Set SOLANA_KEYPAIR in .env.");
//     const seed32 = skDecoded.length === 64 ? skDecoded.slice(0, 32) : skDecoded;
//     const kp = Keypair.fromSeed(Uint8Array.from(seed32));
//     console.log("[signer] fee payer =", kp.publicKey.toBase58(), "(derived from ADMIN seed)");
//     return kp;
//   }
// }

// module.exports = {
//   ADMIN_PK,               // Uint8Array(32) — pass to Ed25519Program.createInstructionWithPublicKey
//   buildMessageBytes,      // DICE_V1 message builder
//   signMessageEd25519,     // ed25519 signer
//   getServerKeypair,       // server fee payer
// };


// backend/signer.js
const bs58 = require("bs58");
const nacl = require("tweetnacl");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Keypair } = require("@solana/web3.js");

// --- Admin ed25519 keys (used for on-chain Ed25519Program pre-instruction) ---
const ADMIN_PRIVKEY_BASE58 = process.env.ADMIN_PRIVKEY_BASE58 || "";
const ADMIN_PUBKEY_BASE58  = process.env.ADMIN_PUBKEY_BASE58  || "";

if (!ADMIN_PRIVKEY_BASE58) {
  throw new Error("Missing ADMIN_PRIVKEY_BASE58 in env");
}

const skDecoded = bs58.decode(ADMIN_PRIVKEY_BASE58); // 32 (seed) or 64 (secret||pub)
const pkDecoded = ADMIN_PUBKEY_BASE58 ? bs58.decode(ADMIN_PUBKEY_BASE58) : null;

let SECRET64; // 64 bytes: secret(32) || public(32)
let ADMIN_PK; // 32 bytes public key (Uint8Array)

if (skDecoded.length === 64) {
  SECRET64 = Uint8Array.from(skDecoded);
  ADMIN_PK = Uint8Array.from(SECRET64.slice(32));
} else if (skDecoded.length === 32) {
  const kp = nacl.sign.keyPair.fromSeed(Uint8Array.from(skDecoded));
  SECRET64 = Uint8Array.from(kp.secretKey); // 64
  ADMIN_PK = Uint8Array.from(kp.publicKey); // 32
} else {
  throw new Error("ADMIN_PRIVKEY_BASE58 must decode to 32 (seed) or 64 (secret||pub) bytes");
}

if (pkDecoded && Buffer.compare(Buffer.from(pkDecoded), Buffer.from(ADMIN_PK)) !== 0) {
  throw new Error("ADMIN_PUBKEY_BASE58 does not match the derived public key");
}

// ---- small LE helpers for DICE_V1 message ----
function u64le(nBig) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(nBig), 0);
  return b;
}
function i64le(nBig) {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(BigInt(nBig), 0);
  return b;
}

// ---- Canonical message for Dice resolve (your HTTP server uses this) ----
function buildMessageBytes(params) {
  // params: { programId(32), vault(32), player(32), betAmount, betType, target, roll, payout, nonce, expiryUnix }
  const enc = new TextEncoder();
  const parts = [];
  parts.push(enc.encode("DICE_V1"));
  parts.push(Buffer.from(params.programId)); // 32
  parts.push(Buffer.from(params.vault));     // 32
  parts.push(Buffer.from(params.player));    // 32
  parts.push(u64le(params.betAmount));
  parts.push(Buffer.from([params.betType & 0xff]));
  parts.push(Buffer.from([params.target & 0xff]));
  parts.push(Buffer.from([params.roll & 0xff]));
  parts.push(u64le(params.payout));
  parts.push(u64le(params.nonce));
  parts.push(i64le(params.expiryUnix));
  return Buffer.concat(parts);
}

// ---- Ed25519 signer (tweetnacl) ----
async function signMessageEd25519(msg) {
  const sig = nacl.sign.detached(Uint8Array.from(msg), SECRET64);
  return Buffer.from(sig);
}

// -------------------- Fee payer (server) --------------------
function normalizePath(pth) {
  if (!pth) return "";
  let s = String(pth).trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1);
  }
  s = s.replace(/[\\\s]+$/g, "");
  if (s.startsWith("~")) s = s.replace(/^~(?=\/|$)/, os.homedir());
  return s;
}

function readKeypairFile(anyPath) {
  const p = normalizePath(anyPath);
  const raw = fs.readFileSync(p, "utf8").trim();

  // 1) Try JSON array (Solana CLI format)
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const sk = Uint8Array.from(parsed);
      if (sk.length !== 64) throw new Error(`unexpected key length ${sk.length}, want 64`);
      return Keypair.fromSecretKey(sk);
    }
  } catch (_) {}

  // 2) Try base58 secret key (64 bytes)
  try {
    const sk58 = raw.replace(/\s+/g, "");
    const sk = bs58.decode(sk58);
    if (sk.length !== 64) throw new Error(`unexpected base58 key length ${sk.length}, want 64`);
    return Keypair.fromSecretKey(Uint8Array.from(sk));
  } catch (_) {}

  throw new Error(`Unrecognized keypair format at ${p}`);
}

/**
 * Returns a funded Keypair the backend will use as fee payer.
 * Supports:
 * 1) JSON array in env variable
 * 2) File path in env variable
 * 3) Default ~/.config/solana/id.json
 * 4) Fallback from ADMIN seed
 */
async function getServerKeypair() {
  const envVal =
    process.env.SOLANA_KEYPAIR ||
    process.env.ANCHOR_WALLET ||
    process.env.SERVER_KEYPAIR_PATH;

  if (envVal) {
    try {
      // If JSON array directly in env
      const trimmed = envVal.trim();
      if (trimmed.startsWith("[")) {
        const secretArray = JSON.parse(trimmed);
        const kp = Keypair.fromSecretKey(Uint8Array.from(secretArray));
        console.log("[signer] fee payer =", kp.publicKey.toBase58(), "(from JSON array in env)");
        return kp;
      }

      // Otherwise treat as file path
      const kp = readKeypairFile(envVal);
      console.log("[signer] fee payer =", kp.publicKey.toBase58(), "(from file path in env)");
      return kp;
    } catch (e) {
      throw new Error(`Failed to read keypair from env (${envVal}): ${e.message}`);
    }
  }

  // Default Solana CLI path
  try {
    const def = path.join(os.homedir(), ".config/solana/id.json");
    const kp = readKeypairFile(def);
    console.log("[signer] fee payer =", kp.publicKey.toBase58(), "(from ~/.config/solana/id.json)");
    return kp;
  } catch (e) {}

  // Last resort: derive from admin seed
  console.warn("[signer] WARNING: falling back to ADMIN seed as fee payer (likely unfunded).");
  const seed32 = skDecoded.length === 64 ? skDecoded.slice(0, 32) : skDecoded;
  const kp = Keypair.fromSeed(Uint8Array.from(seed32));
  console.log("[signer] fee payer =", kp.publicKey.toBase58(), "(derived from ADMIN seed)");
  return kp;
}

module.exports = {
  ADMIN_PK,               // Uint8Array(32)
  buildMessageBytes,      // DICE_V1 message builder
  signMessageEd25519,     // Ed25519 signer
  getServerKeypair,       // server fee payer
};

