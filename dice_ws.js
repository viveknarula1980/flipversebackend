// // backend/dice_ws.js — Dice WS (single-popup, server fee-payer resolve)

// const crypto = require("crypto");
// const {
//   PublicKey,
//   VersionedTransaction,
//   TransactionMessage,
//   SystemProgram,
//   ComputeBudgetProgram,
// } = require("@solana/web3.js");

// const {
//   connection,
//   PROGRAM_ID,                // Dice program id (same one used in your HTTP dice endpoints)
//   deriveVaultPda,
//   deriveAdminPda,
//   buildEd25519VerifyIx,
// } = require("./solana");

// const { roll1to100 } = require("./rng");
// const {
//   ADMIN_PK,
//   buildMessageBytes,
//   signMessageEd25519,
//   getServerKeypair,
// } = require("./signer");

// const DB = global.db || require("./db");

// const SYSVAR_INSTRUCTIONS_PUBKEY = new PublicKey(
//   "Sysvar1nstructions1111111111111111111111111"
// );

// // ---------- Helpers ----------
// function anchorDisc(globalSnakeName) {
//   return crypto.createHash("sha256").update(`global:${globalSnakeName}`).digest().slice(0, 8);
// }
// function encodePlaceBetLockArgs({ betAmount, betType, target, nonce, expiryUnix }) {
//   // [disc:8][u64 bet_amount][u8 bet_type][u8 target][u64 nonce][i64 expiry]
//   const disc = anchorDisc("place_bet_lock");
//   const buf = Buffer.alloc(8 + 8 + 1 + 1 + 8 + 8);
//   let o = 0;
//   disc.copy(buf, o); o += 8;
//   buf.writeBigUInt64LE(BigInt(betAmount), o); o += 8;
//   buf.writeUInt8(betType & 0xff, o++); buf.writeUInt8(target & 0xff, o++);
//   buf.writeBigUInt64LE(BigInt(nonce), o); o += 8;
//   buf.writeBigInt64LE(BigInt(expiryUnix), o); o += 8;
//   return buf;
// }
// function encodeResolveBetArgs({ roll, payout, ed25519InstrIndex }) {
//   // [disc:8][u8 roll][u64 payout][u8 ed_index]
//   const disc = anchorDisc("resolve_bet");
//   const buf = Buffer.alloc(8 + 1 + 8 + 1);
//   let o = 0;
//   disc.copy(buf, o); o += 8;
//   buf.writeUInt8(roll & 0xff, o++); buf.writeBigUInt64LE(BigInt(payout), o); o += 8;
//   buf.writeUInt8(ed25519InstrIndex & 0xff, o++);
//   return buf;
// }
// function placeBetLockKeys({ player, vaultPda, pendingBetPda }) {
//   return [
//     { pubkey: player, isSigner: true, isWritable: true },
//     { pubkey: vaultPda, isSigner: false, isWritable: true },
//     { pubkey: pendingBetPda, isSigner: false, isWritable: true },
//     { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
//   ];
// }
// function resolveBetKeys({ player, vaultPda, adminPda, pendingBetPda }) {
//   return [
//     { pubkey: player, isSigner: false, isWritable: true },
//     { pubkey: vaultPda, isSigner: false, isWritable: true },
//     { pubkey: adminPda, isSigner: false, isWritable: false },
//     { pubkey: pendingBetPda, isSigner: false, isWritable: true },
//     { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
//     { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
//   ];
// }
// function toBetTypeNum(x) {
//   if (typeof x === "string") return x.toLowerCase() === "over" ? 1 : 0; // over=1, under=0
//   return Number(x) ? 1 : 0;
// }

// // Payout: RTP-basis * bet / odds
// function computePayoutLamports({ betLamports, rtp_bps, win_odds }) {
//   if (win_odds < 1 || win_odds > 99) return 0n;
//   const bet = BigInt(betLamports);
//   const rtp = BigInt(rtp_bps);
//   const denom = 100n * BigInt(win_odds);
//   return (bet * rtp) / denom;
// }

// // ---------- State ----------
// const dicePending = new Map(); // nonce -> { player, betLamports, betTypeNum, target }

// // ---------- WS ----------
// function attachDice(io) {
//   io.on("connection", (socket) => {
//     socket.on("register", ({ player }) => {
//       socket.data.player = String(player || "guest");
//     });

//     // STEP 1 — client asks for lock (deposit) tx to sign
//     socket.on("dice:prepare_lock", async ({ player, betAmountLamports, betType, targetNumber }) => {
//       try {
//         if (!player) return socket.emit("dice:error", { code: "NO_PLAYER", message: "player required" });

//         const playerPk = new PublicKey(player);
//         const betTypeNum = toBetTypeNum(betType);
//         const target = Number(targetNumber);

//         // admin gate + min/max
//         const cfg = await DB.getGameConfig?.("dice");
//         if (cfg && (!cfg.enabled || !cfg.running)) {
//           return socket.emit("dice:error", { code: "DISABLED", message: "Dice disabled by admin" });
//         }
//         const min = BigInt(cfg?.min_bet_lamports ?? 50000);
//         const max = BigInt(cfg?.max_bet_lamports ?? 5_000_000_000n);

//         const betLamports = BigInt(betAmountLamports || 0);
//         if (betLamports < min || betLamports > max) {
//           return socket.emit("dice:error", { code: "BET_RANGE", message: "Bet outside allowed range" });
//         }
//         if (!(target >= 2 && target <= 98)) {
//           return socket.emit("dice:error", { code: "BAD_TARGET", message: "Target must be 2..98" });
//         }

//         const vaultPda = deriveVaultPda();
//         const nonce = Date.now();
//         const expiryUnix = Math.floor(Date.now() / 1000) + Number(process.env.NONCE_TTL_SECONDS || 300);

//         const nb = Buffer.alloc(8); nb.writeBigUInt64LE(BigInt(nonce));
//         const pendingBetPda = PublicKey.findProgramAddressSync(
//           [Buffer.from("bet"), playerPk.toBuffer(), nb],
//           PROGRAM_ID
//         )[0];

//         const data = encodePlaceBetLockArgs({
//           betAmount: betLamports,
//           betType: betTypeNum,
//           target,
//           nonce,
//           expiryUnix,
//         });
//         const keys = placeBetLockKeys({ player: playerPk, vaultPda, pendingBetPda });
//         const ix = { programId: PROGRAM_ID, keys, data };

//         const cuPriceIx = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 });
//         const cuLimitIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 });

//         const { blockhash } = await connection.getLatestBlockhash("confirmed");
//         const msgV0 = new TransactionMessage({
//           payerKey: playerPk,
//           recentBlockhash: blockhash,
//           instructions: [cuPriceIx, cuLimitIx, ix],
//         }).compileToV0Message();
//         const vtx = new VersionedTransaction(msgV0);
//         const txBase64 = Buffer.from(vtx.serialize()).toString("base64");

//         // persist pending context (memory and/or DB)
//         dicePending.set(nonce, {
//           player,
//           betLamports,
//           betTypeNum,
//           target,
//         });

//         try {
//           await DB.recordBet?.({
//             player: playerPk.toBase58(),
//             amount: String(betLamports),
//             betType: betTypeNum,
//             target,
//             roll: 0,
//             payout: 0,
//             nonce,
//             expiry: expiryUnix,
//             signature_base58: "",
//           });
//         } catch (e) {
//           console.warn("[dice] recordBet warn:", e?.message || e);
//         }

//         socket.emit("dice:lock_tx", {
//           nonce: String(nonce),
//           expiryUnix,
//           transactionBase64: txBase64,
//         });
//       } catch (e) {
//         console.error("dice:prepare_lock error:", e);
//         socket.emit("dice:error", { code: "PREPARE_FAIL", message: String(e.message || e) });
//       }
//     });

//     // STEP 2 — server resolves on-chain as fee payer; client does NOT sign again
//     socket.on("dice:prepare_resolve", async ({ player, nonce }) => {
//       try {
//         if (!player) return socket.emit("dice:error", { code: "NO_PLAYER", message: "player required" });
//         if (!nonce)  return socket.emit("dice:error", { code: "NO_NONCE",  message: "nonce required" });

//         const playerPk = new PublicKey(player);
//         let ctx = dicePending.get(Number(nonce));

//         // Load from DB if not in memory
//         if (!ctx && typeof DB.getBetByNonce === "function") {
//           const row = await DB.getBetByNonce(Number(nonce)).catch(() => null);
//           if (row) {
//             ctx = {
//               player,
//               betLamports: BigInt(row.bet_amount_lamports),
//               betTypeNum: Number(row.bet_type),
//               target: Number(row.target),
//             };
//           }
//         }
//         if (!ctx) {
//           return socket.emit("dice:error", { code: "NOT_FOUND", message: "no prepared dice bet for nonce" });
//         }

//         // RTP from rules (fallback 9900 bps)
//         let rtp_bps = 9900;
//         try {
//           const rules = await DB.getRules?.();
//           if (rules?.rtp_bps) rtp_bps = Number(rules.rtp_bps);
//         } catch {}

//         // Roll & payout
//         const roll = roll1to100();
//         const win_odds = ctx.betTypeNum === 0 ? ctx.target - 1 : 100 - ctx.target;
//         if (win_odds < 1 || win_odds > 99) throw new Error("Invalid win odds");
//         const win = ctx.betTypeNum === 0 ? roll < ctx.target : roll > ctx.target;

//         const payoutLamports = win
//           ? Number(computePayoutLamports({ betLamports: ctx.betLamports, rtp_bps, win_odds }))
//           : 0;

//         // Build resolve tx with server fee payer
//         const vaultPda = deriveVaultPda();
//         const adminPda = deriveAdminPda();

//         const expiryUnix = Math.floor(Date.now() / 1000) + Number(process.env.NONCE_TTL_SECONDS || 300);

//         const msg = buildMessageBytes({
//           programId: PROGRAM_ID.toBuffer(),
//           vault: vaultPda.toBuffer(),
//           player: playerPk.toBuffer(),
//           betAmount: Number(ctx.betLamports),
//           betType: Number(ctx.betTypeNum),
//           target: Number(ctx.target),
//           roll,
//           payout: payoutLamports,
//           nonce: Number(nonce),
//           expiryUnix: Number(expiryUnix),
//         });

//         const edSig = await signMessageEd25519(msg);
//         const edIx  = buildEd25519VerifyIx({ message: msg, signature: edSig, publicKey: ADMIN_PK });
//         const edIndex = 1; // [CU, edIx, resolve]

//         const nb = Buffer.alloc(8); nb.writeBigUInt64LE(BigInt(nonce));
//         const pendingBetPda = PublicKey.findProgramAddressSync(
//           [Buffer.from("bet"), playerPk.toBuffer(), nb],
//           PROGRAM_ID
//         )[0];

//         const data = encodeResolveBetArgs({
//           roll,
//           payout: payoutLamports,
//           ed25519InstrIndex: edIndex,
//         });
//         const keys = resolveBetKeys({ player: playerPk, vaultPda, adminPda, pendingBetPda });
//         const ixResolve = { programId: PROGRAM_ID, keys, data };

//         const feePayer = await getServerKeypair();
//         const cuPriceIx = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 });
//         const cuLimitIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });

//         const { blockhash } = await connection.getLatestBlockhash("confirmed");
//         const msgV0 = new TransactionMessage({
//           payerKey: feePayer.publicKey,
//           recentBlockhash: blockhash,
//           instructions: [cuPriceIx, cuLimitIx, edIx, ixResolve],
//         }).compileToV0Message();

//         const vtx = new VersionedTransaction(msgV0);

//         // (optional) simulate
//         const sim = await connection.simulateTransaction(vtx, { sigVerify: false });
//         if (sim.value.err) {
//           const logs = (sim.value.logs || []).join("\n");
//           throw new Error(`Dice resolve simulate failed: ${JSON.stringify(sim.value.err)}\n${logs}`);
//         }

//         vtx.sign([feePayer]);
//         const sig = await connection.sendRawTransaction(vtx.serialize(), {
//           skipPreflight: false,
//           maxRetries: 5,
//         });
//         await connection.confirmTransaction(sig, "confirmed");

//         // persist unified stats
//         try {
//           await DB.recordGameRound?.({
//             game_key: "dice",
//             player,
//             nonce: Number(nonce),
//             stake_lamports: Number(ctx.betLamports),
//             payout_lamports: Number(payoutLamports),
//             result_json: {
//               roll,
//               betType: ctx.betTypeNum === 0 ? "under" : "over",
//               target: ctx.target,
//               win,
//             },
//           });
//           if (payoutLamports > 0) {
//             await DB.recordActivity?.({
//               user: player,
//               action: "Dice win",
//               amount: (Number(payoutLamports) / 1e9).toFixed(4),
//             });
//           }
//           if (typeof DB.updateBetPrepared === "function") {
//             await DB.updateBetPrepared({
//               nonce: Number(nonce),
//               roll,
//               payout: Number(payoutLamports),
//               resolve_sig: sig,
//             }).catch(()=>{});
//           }
//         } catch (e) {
//           console.warn("[dice] DB save warn:", e?.message || e);
//         }

//         // final message to client — NO SECOND POPUP
//         socket.emit("dice:resolved", {
//           nonce: String(nonce),
//           roll,
//           win,
//           payoutLamports: Number(payoutLamports),
//           txSig: sig,
//         });

//         dicePending.delete(Number(nonce));
//       } catch (e) {
//         console.error("dice:prepare_resolve error:", e);
//         socket.emit("dice:error", { code: "RESOLVE_PREP_FAIL", message: String(e.message || e) });
//       }
//     });
//   });
// }

// module.exports = { attachDice };


// user vault //


// backend/dice_ws.js
// backend/dice_ws.js
const {
  PublicKey,
  VersionedTransaction,
  TransactionMessage,
  ComputeBudgetProgram,
} = require("@solana/web3.js");

const {
  connection,
  PROGRAM_ID,
  deriveVaultPda,
  deriveUserVaultPda,
  deriveAdminPda,
  derivePendingBetPda,
  buildEd25519VerifyIx,
} = require("./solana");

const {
  ixActivateUserVault,
  ixDeposit,
  ixWithdraw,
  ixPlaceBetFromVault,
  ixResolve,
} = require("./solana_anchor_ix");

const { roll1to100 } = require("./rng");
const {
  ADMIN_PK,
  buildMessageBytes,
  signMessageEd25519,
  getServerKeypair,
} = require("./signer");

const DB = global.db || require("./db");
const { precheckOrThrow } = require("./bonus_guard");

function toBetTypeNum(x) {
  if (typeof x === "string") return x.toLowerCase() === "over" ? 1 : 0;
  return Number(x) ? 1 : 0;
}

function computePayoutLamports({ betLamports, rtp_bps, win_odds }) {
  if (win_odds < 1 || win_odds > 99) return 0n;
  const bet = BigInt(betLamports);
  const rtp = BigInt(rtp_bps);
  const denom = 100n * BigInt(win_odds);
  return (bet * rtp) / denom;
}

const dicePending = new Map();

function attachDice(io) {
  io.on("connection", (socket) => {
    socket.on("register", ({ player }) => {
      socket.data.player = String(player || "guest");
    });

    // ---- Vault ops (single user vault across games) ----
    socket.on("vault:activate_prepare", async ({ player, initialDepositLamports = 0 }) => {
      try {
        if (!player) return socket.emit("vault:error", { code: "NO_PLAYER", message: "player required" });
        const playerPk = new PublicKey(player);
        const userVault = deriveUserVaultPda(playerPk);

        const ixs = [
          ComputeBudgetProgram.setComputeUnitLimit({ units: 250_000 }),
          ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
          ixActivateUserVault({
            programId: PROGRAM_ID,
            player: playerPk,
            userVault,
            initialDepositLamports: Number(initialDepositLamports || 0),
          }),
        ];

        const { blockhash } = await connection.getLatestBlockhash("confirmed");
        const msg = new TransactionMessage({ payerKey: playerPk, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message();
        const vtx = new VersionedTransaction(msg);
        const txBase64 = Buffer.from(vtx.serialize()).toString("base64");
        socket.emit("vault:activate_tx", { transactionBase64: txBase64 });
      } catch (e) {
        socket.emit("vault:error", { code: "ACTIVATE_FAIL", message: String(e.message || e) });
      }
    });

    socket.on("vault:deposit_prepare", async ({ player, amountLamports }) => {
      try {
        if (!player) return socket.emit("vault:error", { code: "NO_PLAYER", message: "player required" });
        if (!amountLamports || Number(amountLamports) <= 0)
          return socket.emit("vault:error", { code: "BAD_AMOUNT", message: "amount required" });
        const playerPk = new PublicKey(player);
        const userVault = deriveUserVaultPda(playerPk);

        const ixs = [
          ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
          ixDeposit({ programId: PROGRAM_ID, player: playerPk, userVault, amount: Number(amountLamports) }),
        ];

        const { blockhash } = await connection.getLatestBlockhash("confirmed");
        const msg = new TransactionMessage({ payerKey: playerPk, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message();
        const vtx = new VersionedTransaction(msg);
        const txBase64 = Buffer.from(vtx.serialize()).toString("base64");
        socket.emit("vault:deposit_tx", { transactionBase64: txBase64 });
      } catch (e) {
        socket.emit("vault:error", { code: "DEPOSIT_FAIL", message: String(e.message || e) });
      }
    });

    socket.on("vault:withdraw_prepare", async ({ player, amountLamports }) => {
      try {
        if (!player) return socket.emit("vault:error", { code: "NO_PLAYER", message: "player required" });
        if (!amountLamports || Number(amountLamports) <= 0)
          return socket.emit("vault:error", { code: "BAD_AMOUNT", message: "amount required" });

        const playerPk = new PublicKey(player);
        const userVault = deriveUserVaultPda(playerPk);

        const ixs = [
          ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
          ixWithdraw({ programId: PROGRAM_ID, player: playerPk, userVault, amount: Number(amountLamports) }),
        ];

        const { blockhash } = await connection.getLatestBlockhash("confirmed");
        const msg = new TransactionMessage({ payerKey: playerPk, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message();
        const vtx = new VersionedTransaction(msg);
        const txBase64 = Buffer.from(vtx.serialize()).toString("base64");
        socket.emit("vault:withdraw_tx", { transactionBase64: txBase64 });
      } catch (e) {
        socket.emit("vault:error", { code: "WITHDRAW_FAIL", message: String(e.message || e) });
      }
    });

    // ---- Dice place ----
    socket.on("dice:place", async ({ player, betAmountLamports, betType, targetNumber }) => {
      try {
        if (!player) return socket.emit("dice:error", { code: "NO_PLAYER", message: "player required" });

        const playerPk = new PublicKey(player);
        const betTypeNum = toBetTypeNum(betType);
        const target = Number(targetNumber);

        const cfg = await DB.getGameConfig?.("dice");
        const min = BigInt(cfg?.min_bet_lamports ?? 50000);
        const max = BigInt(cfg?.max_bet_lamports ?? 5_000_000_000n);
        const betLamports = BigInt(betAmountLamports || 0);
        if (betLamports < min || betLamports > max) return socket.emit("dice:error", { code: "BET_RANGE", message: "Bet outside allowed range" });
        if (!(target >= 2 && target <= 98)) return socket.emit("dice:error", { code: "BAD_TARGET", message: "Target must be 2..98" });

        const userVault = deriveUserVaultPda(playerPk);
        const houseVault = deriveVaultPda();
        const nonce = Date.now();
        const expiryUnix = Math.floor(Date.now() / 1000) + Number(process.env.NONCE_TTL_SECONDS || 300);
        const pendingBet = derivePendingBetPda(playerPk, nonce);

        // ed25519 presence
        const msg = buildMessageBytes({
          programId: PROGRAM_ID.toBuffer(),
          vault: houseVault.toBuffer(),
          player: playerPk.toBuffer(),
          betAmount: Number(betLamports),
          betType: Number(betTypeNum),
          target: Number(target),
          roll: 0,
          payout: 0,
          nonce: Number(nonce),
          expiryUnix: Number(expiryUnix),
        });
        const edSig = await signMessageEd25519(msg);
        const edIx = buildEd25519VerifyIx({ message: msg, signature: edSig, publicKey: ADMIN_PK });
        const edIndex = 1;

        const feePayer = await getServerKeypair();
        const cuPriceIx = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 });
        const cuLimitIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 350_000 });
        await precheckOrThrow({
  userWallet: player,
  stakeLamports: String(betLamports),
  gameKey: "dice",
});

        // before building lock/tx:
await precheckOrThrow({
  userWallet: player,                 // base58
  stakeLamports: betLamports,         // BigInt or Number
  gameKey: "dice",                    // "crash","plinko","mines","memeslot","coinflip_pvp"
  // autoCashoutX: 1.1                 // e.g. for crash guard hint, optional
});
        const lockIx = ixPlaceBetFromVault({
          programId: PROGRAM_ID,
          player: playerPk,
          feePayer: feePayer.publicKey,
          userVault,
          houseVault,
          pendingBet,
          betAmount: Number(betLamports),
          betType: betTypeNum,
          target,
          nonce,
          expiryUnix,
          edIndex,
        });

        const { blockhash } = await connection.getLatestBlockhash("confirmed");
        const msgV0 = new TransactionMessage({
          payerKey: feePayer.publicKey,
          recentBlockhash: blockhash,
          instructions: [cuPriceIx, cuLimitIx, edIx, lockIx],
        }).compileToV0Message();

        const vtx = new VersionedTransaction(msgV0);
        const sim = await connection.simulateTransaction(vtx, { sigVerify: false });
        if (sim.value.err) throw new Error(`Dice lock simulate failed: ${JSON.stringify(sim.value.err)}\n${(sim.value.logs || []).join("\n")}`);

        vtx.sign([feePayer]);
        const sig = await connection.sendRawTransaction(vtx.serialize(), { skipPreflight: false, maxRetries: 5 });
        await connection.confirmTransaction(sig, "confirmed");

        dicePending.set(nonce, { player, betLamports, betTypeNum, target });

        await DB.recordBet?.({
          player: playerPk.toBase58(),
          amount: String(betLamports),
          betType: betTypeNum,
          target,
          roll: 0,
          payout: 0,
          nonce,
          expiry: expiryUnix,
          signature_base58: sig,
        }).catch(() => {});

        socket.emit("dice:locked", { nonce: String(nonce), txSig: sig });
      } catch (e) {
        socket.emit("dice:error", { code: "PLACE_FAIL", message: String(e.message || e) });
      }
    });

    // ---- Dice resolve ----
    socket.on("dice:resolve", async ({ player, nonce }) => {
      try {
        if (!player) return socket.emit("dice:error", { code: "NO_PLAYER", message: "player required" });
        if (!nonce) return socket.emit("dice:error", { code: "NO_NONCE", message: "nonce required" });

        const playerPk = new PublicKey(player);
        let ctx = dicePending.get(Number(nonce));
        if (!ctx && typeof DB.getBetByNonce === "function") {
          const row = await DB.getBetByNonce(Number(nonce)).catch(() => null);
          if (row) ctx = { player, betLamports: BigInt(row.bet_amount_lamports), betTypeNum: Number(row.bet_type), target: Number(row.target) };
        }
        if (!ctx) return socket.emit("dice:error", { code: "NOT_FOUND", message: "no prepared dice bet for nonce" });

        let rtp_bps = 9900;
        try { const rules = await DB.getRules?.(); if (rules?.rtp_bps) rtp_bps = Number(rules.rtp_bps); } catch {}

        const roll = roll1to100();
        const win_odds = ctx.betTypeNum === 0 ? ctx.target - 1 : 100 - ctx.target;
        if (win_odds < 1 || win_odds > 99) throw new Error("Invalid win odds");
        const win = ctx.betTypeNum === 0 ? roll < ctx.target : roll > ctx.target;
        const payoutLamports = win
          ? Number(computePayoutLamports({ betLamports: ctx.betLamports, rtp_bps, win_odds }))
          : 0;

        const houseVault = deriveVaultPda();
        const adminPda   = deriveAdminPda();
        const userVault  = deriveUserVaultPda(playerPk);

        const expiryUnix = Math.floor(Date.now() / 1000) + Number(process.env.NONCE_TTL_SECONDS || 300);
        const msg = buildMessageBytes({
          programId: PROGRAM_ID.toBuffer(),
          vault: houseVault.toBuffer(),
          player: playerPk.toBuffer(),
          betAmount: Number(ctx.betLamports),
          betType: Number(ctx.betTypeNum),
          target: Number(ctx.target),
          roll,
          payout: payoutLamports,
          nonce: Number(nonce),
          expiryUnix: Number(expiryUnix),
        });
        const edSig = await signMessageEd25519(msg);
        const edIx  = buildEd25519VerifyIx({ message: msg, signature: edSig, publicKey: ADMIN_PK });
        const edIndex = 1;

        const pendingBet = derivePendingBetPda(playerPk, nonce);
        const ixRes = ixResolve({
          programId: PROGRAM_ID,
          player: playerPk,
          houseVault,
          adminPda,
          userVault,
          pendingBet,
          roll,
          payout: payoutLamports,
          edIndex,
        });

        const feePayer = await getServerKeypair();
        const cuPriceIx = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 });
        const cuLimitIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });

        const { blockhash } = await connection.getLatestBlockhash("confirmed");
        const msgV0 = new TransactionMessage({
          payerKey: feePayer.publicKey,
          recentBlockhash: blockhash,
          instructions: [cuPriceIx, cuLimitIx, edIx, ixRes],
        }).compileToV0Message();

        const vtx = new VersionedTransaction(msgV0);
        const sim = await connection.simulateTransaction(vtx, { sigVerify: false });
        if (sim.value.err) throw new Error(`Dice resolve simulate failed: ${JSON.stringify(sim.value.err)}\n${(sim.value.logs || []).join("\n")}`);

        vtx.sign([feePayer]);
        const sig = await connection.sendRawTransaction(vtx.serialize(), { skipPreflight: false, maxRetries: 5 });
        await connection.confirmTransaction(sig, "confirmed");

        await DB.recordGameRound?.({
          game_key: "dice",
          player,
          nonce: Number(nonce),
          stake_lamports: Number(ctx.betLamports),
          payout_lamports: Number(payoutLamports),
          result_json: { roll, betType: ctx.betTypeNum === 0 ? "under" : "over", target: ctx.target, win },
        }).catch(() => {});
        if (payoutLamports > 0) {
          await DB.recordActivity?.({ user: player, action: "Dice win", amount: (Number(payoutLamports) / 1e9).toFixed(4) }).catch(() => {});
        }
        if (typeof DB.updateBetPrepared === "function") {
          await DB.updateBetPrepared({ nonce: Number(nonce), roll, payout: Number(payoutLamports), resolve_sig: sig }).catch(() => {});
        }

        socket.emit("dice:resolved", { nonce: String(nonce), roll, win, payoutLamports: Number(payoutLamports), txSig: sig });
        dicePending.delete(Number(nonce));
      } catch (e) {
        socket.emit("dice:error", { code: "RESOLVE_FAIL", message: String(e.message || e) });
      }
    });
  });
}

module.exports = { attachDice };


