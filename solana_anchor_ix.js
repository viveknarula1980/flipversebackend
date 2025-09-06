// solana.js

// const { Connection, PublicKey, Ed25519Program } = require("@solana/web3.js");

// const RPC_URL =
//   process.env.RPC_URL ||
//   process.env.CLUSTER || 
//   "https://api.devnet.solana.com";

// if (!process.env.PROGRAM_ID) {
//   throw new Error("Missing PROGRAM_ID in environment (.env)");
// }

// let PROGRAM_ID;
// try {
//   PROGRAM_ID = new PublicKey(process.env.PROGRAM_ID);
// } catch (e) {
//   throw new Error(`Invalid PROGRAM_ID: ${process.env.PROGRAM_ID}`);
// }

// // --- Connection ---
// const connection = new Connection(RPC_URL, "confirmed");

// // --- PDA derived
// function deriveVaultPda() {
//   const [pda] = PublicKey.findProgramAddressSync([Buffer.from("vault")], PROGRAM_ID);
//   return pda;
// }

// function deriveAdminPda() {
//   const [pda] = PublicKey.findProgramAddressSync([Buffer.from("admin")], PROGRAM_ID);
//   return pda;
// }


// function buildEd25519VerifyIx({ message, signature, publicKey }) {
//   if (!Buffer.isBuffer(message)) throw new Error("ed25519: message must be Buffer");
//   if (!Buffer.isBuffer(signature) || signature.length !== 64) {
//     throw new Error("ed25519: signature must be 64-byte Buffer");
//   }
//   if (!Buffer.isBuffer(publicKey) || publicKey.length !== 32) {
//     throw new Error("ed25519: publicKey must be 32-byte Buffer");
//   }

//   return Ed25519Program.createInstructionWithPublicKey({
//     publicKey,
//     message,
//     signature,
//   });
// }

// module.exports = {
//   connection,
//   RPC_URL,
//   PROGRAM_ID,
//   deriveVaultPda,
//   deriveAdminPda,
//   buildEd25519VerifyIx,
// };

// vault //

// backend/solana_anchor_ix.js
// backend/solana_anchor_ix.js
// backend/solana_anchor_ix.js
// backend/solana_anchor_ix.js
// ./solana_anchor_ix.js
// ./solana_anchor_ix.js
// backend/solana_anchor_ix.js
const crypto = require("crypto");
const {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} = require("@solana/web3.js");

const SYSVAR_INSTR = new PublicKey("Sysvar1nstructions1111111111111111111111111");

// ---- discriminators + encoders ----
const disc = (name) => crypto.createHash("sha256").update(`global:${name}`).digest().slice(0, 8);
const u8  = (n) => Buffer.from([Number(n) & 0xff]);
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(Number(n) & 0xffff); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(Number(n) >>> 0);  return b; };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n));     return b; };
const i64 = (n) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(n));      return b; };

// ---- base ix helper ----
function ix(keys, programId, name, data) {
  return new TransactionInstruction({
    programId: new PublicKey(programId),
    keys,
    data: Buffer.concat([disc(name), data]),
  });
}

// ---- vault ops ----
function ixActivateUserVault({ programId, player, userVault, initialDepositLamports }) {
  return ix(
    [
      { pubkey: player,     isSigner: true,  isWritable: true },
      { pubkey: userVault,  isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId,
    "activate_user_vault",
    u64(initialDepositLamports || 0)
  );
}
function ixDeposit({ programId, player, userVault, amount }) {
  return ix(
    [
      { pubkey: player,     isSigner: true,  isWritable: true },
      { pubkey: userVault,  isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId,
    "deposit_to_vault",
    u64(amount)
  );
}
function ixWithdraw({ programId, player, userVault, amount }) {
  return ix(
    [
      { pubkey: player,     isSigner: true,  isWritable: true },
      { pubkey: userVault,  isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId,
    "withdraw_from_vault",
    u64(amount)
  );
}

// ---- dice ----
function ixPlaceBetFromVault({
  programId, player, feePayer, userVault, houseVault, pendingBet,
  betAmount, betType, target, nonce, expiryUnix, edIndex
}) {
  const data = Buffer.concat([u64(betAmount), u8(betType), u8(target), u64(nonce), i64(expiryUnix), u8(edIndex || 0)]);
  return ix(
    [
      { pubkey: player,     isSigner: false, isWritable: false },
      { pubkey: feePayer,   isSigner: true,  isWritable: true  },
      { pubkey: userVault,  isSigner: false, isWritable: true  },
      { pubkey: houseVault, isSigner: false, isWritable: true  },
      { pubkey: pendingBet, isSigner: false, isWritable: true  },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_INSTR,            isSigner: false, isWritable: false },
    ],
    programId,
    "dice_lock",
    data
  );
}
function ixResolve({
  programId, player, houseVault, adminPda, userVault, pendingBet, roll, payout, edIndex
}) {
  const data = Buffer.concat([u8(roll), u64(payout), u8(edIndex || 0)]);
  return ix(
    [
      { pubkey: player,     isSigner: false, isWritable: true  },
      { pubkey: houseVault, isSigner: false, isWritable: true  },
      { pubkey: adminPda,   isSigner: false, isWritable: false },
      { pubkey: userVault,  isSigner: false, isWritable: true  },
      { pubkey: pendingBet, isSigner: false, isWritable: true  },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_INSTR,            isSigner: false, isWritable: false },
    ],
    programId,
    "dice_resolve",
    data
  );
}

// ---- mines ----
function ixMinesLock({
  programId, player, feePayer, userVault, houseVault, pendingRound,
  betAmount, rows, cols, mines, nonce, expiryUnix, edIndex
}) {
  const data = Buffer.concat([u64(betAmount), u8(rows), u8(cols), u8(mines), u64(nonce), i64(expiryUnix), u8(edIndex || 0)]);
  return ix(
    [
      { pubkey: player,       isSigner: false, isWritable: false },
      { pubkey: feePayer,     isSigner: true,  isWritable: true  },
      { pubkey: userVault,    isSigner: false, isWritable: true  },
      { pubkey: houseVault,   isSigner: false, isWritable: true  },
      { pubkey: pendingRound, isSigner: false, isWritable: true  },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_INSTR,            isSigner: false, isWritable: false },
    ],
    programId,
    "mines_lock",
    data
  );
}
function ixMinesResolve({
  programId, player, houseVault, adminPda, userVault, pendingRound, checksum, payout, edIndex
}) {
  const data = Buffer.concat([u8(checksum), u64(payout), u8(edIndex || 0)]);
  return ix(
    [
      { pubkey: player,       isSigner: false, isWritable: true  },
      { pubkey: houseVault,   isSigner: false, isWritable: true  },
      { pubkey: adminPda,     isSigner: false, isWritable: false },
      { pubkey: userVault,    isSigner: false, isWritable: true  },
      { pubkey: pendingRound, isSigner: false, isWritable: true  },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_INSTR,            isSigner: false, isWritable: false },
    ],
    programId,
    "mines_resolve",
    data
  );
}

// ---- coinflip ----
function ixFlipLock({
  programId, player, feePayer, userVault, houseVault, pendingFlip,
  betAmount, side, nonce, expiryUnix, edIndex
}) {
  const data = Buffer.concat([u64(betAmount), u8(side), u64(nonce), i64(expiryUnix), u8(edIndex || 0)]);
  return ix(
    [
      { pubkey: player,      isSigner: false, isWritable: false },
      { pubkey: feePayer,    isSigner: true,  isWritable: true  },
      { pubkey: userVault,   isSigner: false, isWritable: true  },
      { pubkey: houseVault,  isSigner: false, isWritable: true  },
      { pubkey: pendingFlip, isSigner: false, isWritable: true  },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_INSTR,            isSigner: false, isWritable: false },
    ],
    programId,
    "flip_lock",
    data
  );
}
function ixFlipResolve({
  programId, player, houseVault, adminPda, userVault, pendingFlip, winnerSide, payout, edIndex
}) {
  const data = Buffer.concat([u8(winnerSide), u64(payout), u8(edIndex || 0)]);
  return ix(
    [
      { pubkey: player,      isSigner: false, isWritable: true  },
      { pubkey: houseVault,  isSigner: false, isWritable: true  },
      { pubkey: adminPda,    isSigner: false, isWritable: false },
      { pubkey: userVault,   isSigner: false, isWritable: true  },
      { pubkey: pendingFlip, isSigner: false, isWritable: true  },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_INSTR,            isSigner: false, isWritable: false },
    ],
    programId,
    "flip_resolve",
    data
  );
}

// ---- crash ----
function ixCrashLock({
  programId, player, feePayer, userVault, houseVault, pendingCrash,
  betAmount, nonce, expiryUnix, edIndex
}) {
  const data = Buffer.concat([u64(betAmount), u64(nonce), i64(expiryUnix), u8(edIndex || 0)]);
  return ix(
    [
      { pubkey: player,        isSigner: false, isWritable: false },
      { pubkey: feePayer,      isSigner: true,  isWritable: true  },
      { pubkey: userVault,     isSigner: false, isWritable: true  },
      { pubkey: houseVault,    isSigner: false, isWritable: true  },
      { pubkey: pendingCrash,  isSigner: false, isWritable: true  },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_INSTR,            isSigner: false, isWritable: false },
    ],
    programId,
    "crash_lock",
    data
  );
}
function ixCrashResolve({
  programId, player, houseVault, adminPda, userVault, pendingCrash,
  multiplierBps, payout, edIndex
}) {
  const data = Buffer.concat([u32(multiplierBps), u64(payout), u8(edIndex || 0)]);
  return ix(
    [
      { pubkey: player,        isSigner: false, isWritable: true  },
      { pubkey: houseVault,    isSigner: false, isWritable: true  },
      { pubkey: adminPda,      isSigner: false, isWritable: false },
      { pubkey: userVault,     isSigner: false, isWritable: true  },
      { pubkey: pendingCrash,  isSigner: false, isWritable: true  },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_INSTR,            isSigner: false, isWritable: false },
    ],
    programId,
    "crash_resolve",
    data
  );
}

// ---- plinko ----
function ixPlinkoLock({
  programId, player, feePayer, userVault, houseVault, pendingPlinko,
  unitAmount, balls, rows, difficulty, nonce, expiryUnix, edIndex
}) {
  const data = Buffer.concat([
    u64(unitAmount), u16(balls), u8(rows), u8(difficulty), u64(nonce), i64(expiryUnix), u8(edIndex || 0)
  ]);
  return ix(
    [
      { pubkey: player,         isSigner: false, isWritable: false },
      { pubkey: feePayer,       isSigner: true,  isWritable: true  },
      { pubkey: userVault,      isSigner: false, isWritable: true  },
      { pubkey: houseVault,     isSigner: false, isWritable: true  },
      { pubkey: pendingPlinko,  isSigner: false, isWritable: true  },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_INSTR,            isSigner: false, isWritable: false },
    ],
    programId,
    "plinko_lock",
    data
  );
}
function ixPlinkoResolve({
  programId, player, houseVault, adminPda, userVault, pendingPlinko,
  checksum, totalPayout, edIndex
}) {
  const data = Buffer.concat([u8(checksum), u64(totalPayout), u8(edIndex || 0)]);
  return ix(
    [
      { pubkey: player,         isSigner: false, isWritable: true  },
      { pubkey: houseVault,     isSigner: false, isWritable: true  },
      { pubkey: adminPda,       isSigner: false, isWritable: false },
      { pubkey: userVault,      isSigner: false, isWritable: true  },
      { pubkey: pendingPlinko,  isSigner: false, isWritable: true  },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_INSTR,            isSigner: false, isWritable: false },
    ],
    programId,
    "plinko_resolve",
    data
  );
}

// ---- slots ----
function ixSlotsLock({
  programId, player, feePayer, userVault, houseVault, pendingSpin,
  betAmount, nonce, expiryUnix, edIndex
}) {
  const data = Buffer.concat([u64(betAmount), u64(nonce), i64(expiryUnix), u8(edIndex || 0)]);
  return ix(
    [
      { pubkey: player,       isSigner: false, isWritable: false },
      { pubkey: feePayer,     isSigner: true,  isWritable: true  },
      { pubkey: userVault,    isSigner: false, isWritable: true  },
      { pubkey: houseVault,   isSigner: false, isWritable: true  },
      { pubkey: pendingSpin,  isSigner: false, isWritable: true  },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_INSTR,            isSigner: false, isWritable: false },
    ],
    programId,
    "slots_lock",
    data
  );
}
function ixSlotsResolve({
  programId, player, houseVault, adminPda, userVault, pendingSpin, checksum, payout, edIndex
}) {
  const data = Buffer.concat([u8(checksum), u64(payout), u8(edIndex || 0)]);
  return ix(
    [
      { pubkey: player,       isSigner: false, isWritable: true  },
      { pubkey: houseVault,   isSigner: false, isWritable: true  },
      { pubkey: adminPda,     isSigner: false, isWritable: false },
      { pubkey: userVault,    isSigner: false, isWritable: true  },
      { pubkey: pendingSpin,  isSigner: false, isWritable: true  },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_INSTR,            isSigner: false, isWritable: false },
    ],
    programId,
    "slots_resolve",
    data
  );
}

module.exports = {
  // vault
  ixActivateUserVault,
  ixDeposit,
  ixWithdraw,

  // dice
  ixPlaceBetFromVault,
  ixResolve,

  // mines
  ixMinesLock,
  ixMinesResolve,

  // flip
  ixFlipLock,
  ixFlipResolve,

  // crash
  ixCrashLock,
  ixCrashResolve,

  // plinko
  ixPlinkoLock,
  ixPlinkoResolve,

  // slots
  ixSlotsLock,
  ixSlotsResolve,
};




