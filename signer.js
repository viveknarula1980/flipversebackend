const bs58 = require("bs58");
const nacl = require("tweetnacl");

const ADMIN_PRIVKEY_BASE58 = process.env.ADMIN_PRIVKEY_BASE58 || "";
const ADMIN_PUBKEY_BASE58  = process.env.ADMIN_PUBKEY_BASE58  || "";

// Decode
const skDecoded = bs58.decode(ADMIN_PRIVKEY_BASE58); // 32 or 64 bytes
const pkDecoded = ADMIN_PUBKEY_BASE58 ? bs58.decode(ADMIN_PUBKEY_BASE58) : null;

// Build 64-byte secretKey for tweetnacl: secret(32) || public(32)
let SECRET64;
let ADMIN_PK;

if (skDecoded.length === 64) {
  SECRET64 = Uint8Array.from(skDecoded);
  ADMIN_PK = Uint8Array.from(SECRET64.slice(32));
} else if (skDecoded.length === 32) {
  const kp = nacl.sign.keyPair.fromSeed(Uint8Array.from(skDecoded));
  SECRET64 = Uint8Array.from(new Uint8Array([...kp.secretKey])); // 64 bytes
  ADMIN_PK = kp.publicKey;
} else {
  throw new Error("ADMIN_PRIVKEY_BASE58 must decode to 32 or 64 bytes");
}

if (pkDecoded && Buffer.compare(Buffer.from(pkDecoded), Buffer.from(ADMIN_PK)) !== 0) {
  throw new Error("ADMIN_PUBKEY_BASE58 does not match derived public key from ADMIN_PRIVKEY_BASE58");
}

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

function buildMessageBytes(params) {
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

async function signMessageEd25519(msg) {
  const sig = nacl.sign.detached(Uint8Array.from(msg), SECRET64);
  return Buffer.from(sig); 
}

module.exports = {
  ADMIN_PK: Buffer.from(ADMIN_PK),      
  buildMessageBytes,
  signMessageEd25519
};
