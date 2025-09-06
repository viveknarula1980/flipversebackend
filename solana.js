// solana.js
// const { Connection, PublicKey, Ed25519Program } = require("@solana/web3.js");

// const CLUSTER = process.env.CLUSTER || "https://api.devnet.solana.com";
// const PROGRAM_ID = new PublicKey(process.env.PROGRAM_ID);

// function deriveVaultPda() {
//   const [pda] = PublicKey.findProgramAddressSync([Buffer.from("vault")], PROGRAM_ID);
//   return pda;
// }
// function deriveAdminPda() {
//   const [pda] = PublicKey.findProgramAddressSync([Buffer.from("admin")], PROGRAM_ID);
//   return pda;
// }
// function derivePendingBetPda(playerPk, nonceBigInt) {
//   const nonceBuf = Buffer.from(new Uint8Array(new BigUint64Array([nonceBigInt]).buffer));
//   const [pda] = PublicKey.findProgramAddressSync([Buffer.from("bet"), playerPk.toBuffer(), nonceBuf], PROGRAM_ID);
//   return pda;
// }

// const connection = new Connection(CLUSTER, "confirmed");

// function buildEd25519VerifyIx({ message, signature, publicKey }) {
//   return Ed25519Program.createInstructionWithPublicKey({ publicKey, message, signature });
// }

// module.exports = {
//   connection,
//   PROGRAM_ID,
//   deriveVaultPda,
//   deriveAdminPda,
//   derivePendingBetPda,
//   buildEd25519VerifyIx,
// };

//vault //


// backend/solana.js
// backend/solana.js
// backend/solana.js
// backend/solana.js
// ./solana.js
// ./solana.js
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Connection, PublicKey, Ed25519Program } = require("@solana/web3.js");

const RPC_URL = process.env.RPC_URL || process.env.CLUSTER || "https://api.devnet.solana.com";
const connection = new Connection(RPC_URL, "confirmed");

if (!process.env.PROGRAM_ID) {
  throw new Error("Missing PROGRAM_ID in environment (.env)");
}
const PROGRAM_ID = new PublicKey(process.env.PROGRAM_ID);

// ---- helpers ----
const toPk = (x) => (x instanceof PublicKey ? x : new PublicKey(x));
const u64le = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};

// ---- PDAs (EXACTLY as in the Anchor program) ----
function deriveVaultPda(programId = PROGRAM_ID) {
  return PublicKey.findProgramAddressSync([Buffer.from("vault")], programId)[0];
}
function deriveAdminPda(programId = PROGRAM_ID) {
  return PublicKey.findProgramAddressSync([Buffer.from("admin")], programId)[0];
}
function deriveUserVaultPda(ownerPk, programId = PROGRAM_ID) {
  const pk = toPk(ownerPk);
  return PublicKey.findProgramAddressSync([Buffer.from("user_vault"), pk.toBuffer()], programId)[0];
}

// dice pending:    [b"bet", player, nonce_le]
function derivePendingBetPda(playerPk, nonce, programId = PROGRAM_ID) {
  const pk = toPk(playerPk);
  return PublicKey.findProgramAddressSync([Buffer.from("bet"), pk.toBuffer(), u64le(nonce)], programId)[0];
}
// mines pending:   [b"round", player, nonce_le]
function derivePendingRoundPda(playerPk, nonce, programId = PROGRAM_ID) {
  const pk = toPk(playerPk);
  return PublicKey.findProgramAddressSync([Buffer.from("round"), pk.toBuffer(), u64le(nonce)], programId)[0];
}
// flip pending:    [b"flip", player, nonce_le]
function derivePendingFlipPda(playerPk, nonce, programId = PROGRAM_ID) {
  const pk = toPk(playerPk);
  return PublicKey.findProgramAddressSync([Buffer.from("flip"), pk.toBuffer(), u64le(nonce)], programId)[0];
}
// crash pending:   [b"crash", player, nonce_le]
function derivePendingCrashPda(playerPk, nonce, programId = PROGRAM_ID) {
  const pk = toPk(playerPk);
  return PublicKey.findProgramAddressSync([Buffer.from("crash"), pk.toBuffer(), u64le(nonce)], programId)[0];
}
// plinko pending:  [b"plinkobet", player, nonce_le]
function derivePendingPlinkoPda(playerPk, nonce, programId = PROGRAM_ID) {
  const pk = toPk(playerPk);
  return PublicKey.findProgramAddressSync([Buffer.from("plinkobet"), pk.toBuffer(), u64le(nonce)], programId)[0];
}
// slots pending:   [b"spin", player, nonce_le]  <-- THIS fixes your 2006
function derivePendingSpinPda(playerPk, nonce, programId = PROGRAM_ID) {
  const pk = toPk(playerPk);
  return PublicKey.findProgramAddressSync([Buffer.from("spin"), pk.toBuffer(), u64le(nonce)], programId)[0];
}

// ---- Ed25519 verify ix helper ----
function buildEd25519VerifyIx({ message, signature, publicKey }) {
  const pubBytes =
    publicKey instanceof PublicKey ? publicKey.toBytes() : new PublicKey(publicKey).toBytes();
  const msgBuf = Buffer.isBuffer(message) ? message : Buffer.from(message);
  const sigBuf = Buffer.isBuffer(signature) ? signature : Buffer.from(signature);
  return Ed25519Program.createInstructionWithPublicKey({
    publicKey: pubBytes,
    message: msgBuf,
    signature: sigBuf,
  });
}

module.exports = {
  connection,
  PROGRAM_ID,

  deriveVaultPda,
  deriveAdminPda,
  deriveUserVaultPda,

  derivePendingBetPda,
  derivePendingRoundPda,
  derivePendingFlipPda,
  derivePendingCrashPda,
  derivePendingPlinkoPda,
  derivePendingSpinPda,

  buildEd25519VerifyIx,
};
