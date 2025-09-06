// backend/mines_ws.js
// Server-driven Mines. Server pays winners, then resolve(payout=0) to close PDA.

// const crypto = require("crypto");
// const {
//   Connection,
//   PublicKey,
//   VersionedTransaction,
//   TransactionMessage,
//   SystemProgram,
//   ComputeBudgetProgram,
//   Ed25519Program,
// } = require("@solana/web3.js");

// const { ADMIN_PK, signMessageEd25519, getServerKeypair } = require("./signer");
// const DB = global.db || require("./db");

// // ---- ENV / RPC / Program ----
// const RPC_URL = process.env.CLUSTER || "https://api.devnet.solana.com";
// const connection = new Connection(RPC_URL, "confirmed");

// if (!process.env.MINES_PROGRAM_ID) throw new Error("MINES_PROGRAM_ID missing in .env");
// const PROGRAM_ID = new PublicKey(process.env.MINES_PROGRAM_ID);

// const SYSVAR_INSTR = new PublicKey("Sysvar1nstructions1111111111111111111111111");

// const ADMIN_PUBKEY = new PublicKey(ADMIN_PK);

// // PDAs & utils
// function pdaVault() { return PublicKey.findProgramAddressSync([Buffer.from("vault")], PROGRAM_ID)[0]; }
// function pdaPending(playerPk, nonce) {
//   const nb = Buffer.alloc(8);
//   nb.writeBigUInt64LE(BigInt(nonce));
//   return PublicKey.findProgramAddressSync([Buffer.from("round"), playerPk.toBuffer(), nb], PROGRAM_ID)[0];
// }
// function anchorDisc(name) { return crypto.createHash("sha256").update(`global:${name}`).digest().slice(0, 8); }
// function encLock({ betLamports, rows, cols, mines, nonce, expiryUnix }) {
//   const d = anchorDisc("lock");
//   const b = Buffer.alloc(8 + 8 + 1 + 1 + 1 + 8 + 8);
//   let o = 0;
//   d.copy(b, o); o += 8;
//   b.writeBigUInt64LE(BigInt(betLamports), o); o += 8;
//   b.writeUInt8(rows & 0xff, o++); b.writeUInt8(cols & 0xff, o++); b.writeUInt8(mines & 0xff, o++);
//   b.writeBigUInt64LE(BigInt(nonce), o); o += 8;
//   b.writeBigInt64LE(BigInt(expiryUnix), o); o += 8;
//   return b;
// }
// function encResolve({ checksum, payout, edIndex }) {
//   const d = anchorDisc("resolve");
//   const b = Buffer.alloc(8 + 1 + 8 + 1);
//   let o = 0;
//   d.copy(b, o); o += 8;
//   b.writeUInt8(checksum & 0xff, o++); b.writeBigUInt64LE(BigInt(payout), o); o += 8; b.writeUInt8(edIndex & 0xff, o++);
//   return b;
// }
// function keysLock({ player, vault, pending }) {
//   return [
//     { pubkey: player, isSigner: true, isWritable: true },
//     { pubkey: vault, isSigner: false, isWritable: true },
//     { pubkey: pending, isSigner: false, isWritable: true },
//     { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
//   ];
// }
// function keysResolve({ player, vault, admin, pending }) {
//   return [
//     { pubkey: player, isSigner: false, isWritable: true },
//     { pubkey: vault, isSigner: false, isWritable: true },
//     { pubkey: admin, isSigner: false, isWritable: false },
//     { pubkey: pending, isSigner: false, isWritable: true },
//     { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
//     { pubkey: SYSVAR_INSTR, isSigner: false, isWritable: false },
//   ];
// }

// // math
// function multiplierFor(safeOpened, totalTiles, mines, rtpBps = 10000) {
//   if (safeOpened <= 0) return 1;
//   let m = 1;
//   for (let i = 0; i < safeOpened; i++) {
//     const totalLeft = totalTiles - i;
//     const safeLeft = (totalTiles - mines) - i;
//     m *= totalLeft / safeLeft;
//   }
//   m *= (rtpBps / 10000);
//   return Math.max(1, m);
// }

// function deriveBombs({ rows, cols, mines, playerPk, nonce, firstSafeIndex }) {
//   const total = rows * cols;
//   const seedKey = crypto.createHash("sha256")
//     .update(playerPk.toBuffer())
//     .update(Buffer.from(String(nonce)))
//     .digest();
//   const picked = new Set();
//   let i = 0;
//   while (picked.size < mines) {
//     const rng = crypto.createHmac("sha256", seedKey).update(Buffer.from(String(i++))).digest();
//     const n = ((rng[0] << 24) | (rng[1] << 16) | (rng[2] << 8) | rng[3]) >>> 0;
//     const idx = n % total;
//     if (idx === firstSafeIndex) continue;
//     picked.add(idx);
//   }
//   return picked;
// }

// // store
// const rounds = new Map();

// async function buildLockTx({ playerPk, betLamports, rows, cols, mines, nonce, expiryUnix }) {
//   const vault = pdaVault();
//   const pending = pdaPending(playerPk, nonce);
//   const ix = { programId: PROGRAM_ID, keys: keysLock({ player: playerPk, vault, pending }), data: encLock({ betLamports, rows, cols, mines, nonce, expiryUnix }) };
//   const cu = ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 });
//   const { blockhash } = await connection.getLatestBlockhash("confirmed");
//   const msg = new TransactionMessage({ payerKey: playerPk, recentBlockhash: blockhash, instructions: [cu, ix] }).compileToV0Message();
//   const vtx = new VersionedTransaction(msg);

//   const sim = await connection.simulateTransaction(vtx, { sigVerify: false });
//   if (sim.value.err) {
//     const logs = (sim.value.logs || []).join("\n");
//     const e = JSON.stringify(sim.value.err);
//     const abiErr = logs.includes("InstructionFallbackNotFound") || logs.includes("Fallback functions are not supported");
//     if (abiErr) throw new Error(`LOCK discriminator mismatch: ${logs}`);
//     const fundsErr = logs.includes("Transfer: insufficient lamports") || e.includes('"Custom":1');
//     if (!fundsErr) throw new Error(`LOCK simulate failed: ${e}\n${logs}`);
//   }
//   return Buffer.from(vtx.serialize()).toString("base64");
// }

// async function sendResolve({ playerPk, nonce, payoutLamports }) {
//   const vault = pdaVault();
//   const pending = pdaPending(playerPk, nonce);
//   const admin = ADMIN_PUBKEY;
//   const feePayer = await getServerKeypair();

//   if (BigInt(payoutLamports) > 0n) {
//     try {
//       const transferIx = SystemProgram.transfer({ fromPubkey: feePayer.publicKey, toPubkey: playerPk, lamports: BigInt(payoutLamports) });
//       const { blockhash: bh1 } = await connection.getLatestBlockhash("confirmed");
//       const transferMsg = new TransactionMessage({ payerKey: feePayer.publicKey, recentBlockhash: bh1, instructions: [transferIx] }).compileToV0Message();
//       const transferVtx = new VersionedTransaction(transferMsg);
//       transferVtx.sign([feePayer]);
//       const transferSig = await connection.sendRawTransaction(transferVtx.serialize(), { skipPreflight: false });
//       await connection.confirmTransaction(transferSig, "confirmed");
//     } catch (e) {
//       throw new Error("Server payout transfer failed: " + (e?.message || String(e)));
//     }
//   }

//   const msg = Buffer.concat([ Buffer.from("MINES_V1"), PROGRAM_ID.toBuffer(), vault.toBuffer(), playerPk.toBuffer(), Buffer.from(String(nonce)) ]);
//   const edSig = await signMessageEd25519(msg);
//   const edIx = Ed25519Program.createInstructionWithPublicKey({ publicKey: admin.toBuffer(), message: msg, signature: edSig });
//   const edIndex = 1;

//   const checksum = ((Number(nonce) % 251) + 1) & 0xff;
//   const data = encResolve({ checksum, payout: 0n, edIndex });
//   const ix = { programId: PROGRAM_ID, keys: keysResolve({ player: playerPk, vault, admin, pending }), data };

//   const cu = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });
//   const { blockhash } = await connection.getLatestBlockhash("confirmed");
//   const msgV0 = new TransactionMessage({ payerKey: feePayer.publicKey, recentBlockhash: blockhash, instructions: [cu, edIx, ix] }).compileToV0Message();
//   const vtx = new VersionedTransaction(msgV0);

//   const sim = await connection.simulateTransaction(vtx, { sigVerify: false });
//   if (sim.value.err) {
//     const logs = (sim.value.logs || []).join("\n");
//     throw new Error(`RESOLVE simulate failed: ${JSON.stringify(sim.value.err)}\n${logs}`);
//   }
//   vtx.sign([feePayer]);
//   const sig = await connection.sendRawTransaction(vtx.serialize(), { skipPreflight: false, maxRetries: 5 });
//   await connection.confirmTransaction(sig, "confirmed");
//   return sig;
// }

// function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
// function i32(x) { const n = Number(x); return Number.isFinite(n) ? (n | 0) : 0; }

// function attachMines(io) {
//   io.on("connection", (socket) => {
//     socket.on("register", ({ player }) => { socket.data.player = String(player || "guest"); });

//     socket.on("mines:prepare_lock", async (p) => {
//       try {
//         const player = String(p?.player || "");
//         if (!player) return socket.emit("mines:error", { code: "NO_PLAYER", message: "player required" });

//         // admin gate + min/max
//         const cfg = await DB.getGameConfig?.("mines");
//         if (cfg && (!cfg.enabled || !cfg.running)) {
//           return socket.emit("mines:error", { code: "DISABLED", message: "Mines disabled by admin" });
//         }
//         const min = BigInt(cfg?.min_bet_lamports ?? 50000);
//         const max = BigInt(cfg?.max_bet_lamports ?? 5_000_000_000n);

//         const betLamports = BigInt(p?.betAmountLamports || 0);
//         if (!(betLamports > 0n)) return socket.emit("mines:error", { code:"BAD_BET", message:"betAmountLamports must be > 0" });
//         if (betLamports < min || betLamports > max) {
//           return socket.emit("mines:error", { code: "BET_RANGE", message: "Bet outside allowed range" });
//         }

//         const rows = clamp(i32(p?.rows), 2, 8);
//         const cols = clamp(i32(p?.cols), 2, 8);
//         const mines = clamp(i32(p?.minesCount), 1, rows * cols - 1);

//         const playerPk = new PublicKey(player);
//         const nonce = Date.now();
//         const expiryUnix = Math.floor(Date.now() / 1000) + Number(process.env.NONCE_TTL_SECONDS || 300);

//         const txB64 = await buildLockTx({ playerPk, betLamports: Number(betLamports), rows, cols, mines, nonce, expiryUnix });

//         let rtp_bps = cfg?.rtp_bps ?? 9800;
//         rounds.set(nonce, { playerPk, betLamports: BigInt(betLamports), rows, cols, mines, opened: new Set(), bombs: null, rtpBps: rtp_bps, over: false });

//         socket.emit("mines:lock_tx", { nonce: String(nonce), expiryUnix, transactionBase64: txB64 });
//       } catch (e) {
//         console.error("mines:prepare_lock error:", e);
//         socket.emit("mines:error", { code: "PREPARE_FAIL", message: e.message || String(e) });
//       }
//     });

//     socket.on("mines:lock_confirmed", ({ nonce }) => {
//       const ctx = rounds.get(Number(nonce));
//       if (!ctx) return socket.emit("mines:error", { code: "NOT_FOUND", message: "no round" });
//       socket.emit("mines:started", { nonce: String(nonce), rows: ctx.rows, cols: ctx.cols, mines: ctx.mines });
//     });

//     socket.on("mines:open", async ({ nonce, row, col }) => {
//       try {
//         const ctx = rounds.get(Number(nonce));
//         if (!ctx) return socket.emit("mines:error", { code: "NOT_FOUND", message: "no round" });
//         if (ctx.over) return;

//         const r = i32(row), c = i32(col);
//         if (r < 0 || c < 0 || r >= ctx.rows || c >= ctx.cols)
//           return socket.emit("mines:error", { code: "BAD_COORD", message: "row/col out of range" });

//         const idx = r * ctx.cols + c;
//         if (ctx.opened.has(idx)) return;

//         if (!ctx.bombs) {
//           ctx.bombs = deriveBombs({ rows: ctx.rows, cols: ctx.cols, mines: ctx.mines, playerPk: ctx.playerPk, nonce: Number(nonce), firstSafeIndex: idx });
//         }

//         if (ctx.bombs.has(idx)) {
//           ctx.over = true;
//           socket.emit("mines:boom", { nonce: String(nonce), atIndex: idx, atStep: ctx.opened.size });
//           const sig = await sendResolve({ playerPk: ctx.playerPk, nonce: Number(nonce), payoutLamports: 0n });

//           // persist loss
//           try {
//             await DB.recordGameRound?.({
//               game_key: "mines",
//               player: ctx.playerPk.toBase58(),
//               nonce: Number(nonce),
//               stake_lamports: Number(ctx.betLamports),
//               payout_lamports: 0,
//               result_json: { rows: ctx.rows, cols: ctx.cols, mines: ctx.mines, opened: [...ctx.opened], boomAt: idx },
//             });
//           } catch {}

//           const payload = { nonce: String(nonce), payoutLamports: 0, safeSteps: ctx.opened.size, tx: sig };
//           io.emit("mines:resolved", payload);
//           rounds.delete(Number(nonce));
//           return;
//         }

//         ctx.opened.add(idx);
//         const totalTiles = ctx.rows * ctx.cols;
//         const mult = multiplierFor(ctx.opened.size, totalTiles, ctx.mines, ctx.rtpBps);
//         socket.emit("mines:safe", { nonce: String(nonce), index: idx, safeCount: ctx.opened.size, multiplier: mult });
//       } catch (e) {
//         console.error("mines:open error:", e);
//         socket.emit("mines:error", { code: "OPEN_FAIL", message: e.message || String(e) });
//       }
//     });

//     socket.on("mines:cashout", async ({ nonce }) => {
//       try {
//         const ctx = rounds.get(Number(nonce));
//         if (!ctx) return socket.emit("mines:error", { code: "NOT_FOUND", message: "no round" });
//         if (ctx.over) return;
//         if (ctx.opened.size < 1) {
//           return socket.emit("mines:error", { code: "TOO_SOON", message: "Open at least 1 tile before cashout" });
//         }

//         const totalTiles = ctx.rows * ctx.cols;
//         const mult = multiplierFor(ctx.opened.size, totalTiles, ctx.mines, ctx.rtpBps);
//         const payout = (ctx.betLamports * BigInt(Math.floor(mult * 10000))) / 10000n;

//         ctx.over = true;
//         const sig = await sendResolve({ playerPk: ctx.playerPk, nonce: Number(nonce), payoutLamports: payout });

//         // persist win + activity
//         try {
//           await DB.recordGameRound?.({
//             game_key: "mines",
//             player: ctx.playerPk.toBase58(),
//             nonce: Number(nonce),
//             stake_lamports: Number(ctx.betLamports),
//             payout_lamports: Number(payout),
//             result_json: { rows: ctx.rows, cols: ctx.cols, mines: ctx.mines, opened: [...ctx.opened] },
//           });
//           await DB.recordActivity?.({
//             user: ctx.playerPk.toBase58(),
//             action: "Mines cashout",
//             amount: (Number(payout)/1e9).toFixed(4),
//           });
//         } catch {}

//         io.emit("mines:resolved", { nonce: String(nonce), payoutLamports: Number(payout), safeSteps: ctx.opened.size, tx: sig });
//         rounds.delete(Number(nonce));
//       } catch (e) {
//         console.error("mines:cashout error:", e);
//         socket.emit("mines:error", { code: "CASHOUT_FAIL", message: e.message || String(e) });
//       }
//     });
//   });
// }

// module.exports = { attachMines };




// backend/mines_ws.js
// Server drives the game. Lock moves user_vault → house_vault. Resolve pays house_vault → user_vault.

const crypto = require("crypto");
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
  deriveAdminPda,
  deriveUserVaultPda,
  derivePendingRoundPda,
  buildEd25519VerifyIx,
} = require("./solana");

const {
  ixMinesLock,
  ixMinesResolve,
} = require("./solana_anchor_ix");

const { signMessageEd25519 } = require("./signer");
const { getServerKeypair } = require("./signer");
const DB = global.db || require("./db");

// ----- helpers -----
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function i32(x) { const n = Number(x); return Number.isFinite(n) ? (n | 0) : 0; }
function minesChecksum(nonce) { return Number((BigInt(nonce) % 251n) + 1n) & 0xff; }

// fair bombs (first click always safe)
function deriveBombs({ rows, cols, mines, playerPk, nonce, firstSafeIndex }) {
  const total = rows * cols;
  const seedKey = crypto.createHash("sha256")
    .update(playerPk.toBuffer())
    .update(Buffer.from(String(nonce)))
    .digest();
  const picked = new Set();
  let i = 0;
  while (picked.size < mines) {
    const rng = crypto.createHmac("sha256", seedKey).update(Buffer.from(String(i++))).digest();
    const n = ((rng[0] << 24) | (rng[1] << 16) | (rng[2] << 8) | rng[3]) >>> 0;
    const idx = n % total;
    if (idx === firstSafeIndex) continue;
    picked.add(idx);
  }
  return picked;
}

function multiplierFor(safeOpened, totalTiles, mines, rtpBps = 10000) {
  if (safeOpened <= 0) return 1;
  let m = 1;
  for (let i = 0; i < safeOpened; i++) {
    const totalLeft = totalTiles - i;
    const safeLeft = (totalTiles - mines) - i;
    m *= totalLeft / safeLeft;
  }
  m *= (rtpBps / 10000);
  return Math.max(1, m);
}

// in-memory rounds
const rounds = new Map();

// ----- namespace -----
function attachMines(io) {
  io.on("connection", (socket) => {
    socket.on("register", ({ player }) => { socket.data.player = String(player || "guest"); });

    // create lock (server submits TX; no client signature)
    socket.on("mines:place", async ({ player, betAmountLamports, rows, cols, minesCount }) => {
      try {
        if (!player) return socket.emit("mines:error", { code: "NO_PLAYER", message: "player required" });

        const cfg = await DB.getGameConfig?.("mines");
        if (cfg && (!cfg.enabled || !cfg.running)) return socket.emit("mines:error", { code: "DISABLED", message: "Mines disabled by admin" });

        const min = BigInt(cfg?.min_bet_lamports ?? 50000);
        const max = BigInt(cfg?.max_bet_lamports ?? 5_000_000_000n);
        const betLamports = BigInt(betAmountLamports || 0);
        if (!(betLamports > 0n)) return socket.emit("mines:error", { code:"BAD_BET", message:"betAmountLamports must be > 0" });
        if (betLamports < min || betLamports > max) return socket.emit("mines:error", { code:"BET_RANGE", message:"Bet outside allowed range" });

        const R = clamp(i32(rows), 2, 8);
        const C = clamp(i32(cols), 2, 8);
        const M = clamp(i32(minesCount), 1, R * C - 1);

        const playerPk   = new PublicKey(player);
        const userVault  = deriveUserVaultPda(playerPk);
        const houseVault = deriveVaultPda();
        const nonce      = Date.now();
        const expiryUnix = Math.floor(Date.now() / 1000) + Number(process.env.NONCE_TTL_SECONDS || 300);
        const pending    = derivePendingRoundPda(playerPk, nonce);

        // ed25519 presence pre-ix
        const msg = Buffer.from(`MINES|${player}|${Number(betLamports)}|${R}x${C}|${M}|${nonce}|${expiryUnix}`);
        const edSig = await signMessageEd25519(msg);
        const edIx  = buildEd25519VerifyIx({ message: msg, signature: edSig, publicKey: require("./signer").ADMIN_PK });
        const edIndex = 1;

        const feePayer = await getServerKeypair();
        const cuLimit  = ComputeBudgetProgram.setComputeUnitLimit({ units: 900_000 });
        const cuPrice  = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 });

        const lockIx = ixMinesLock({
          programId: PROGRAM_ID,
          player: playerPk,
          feePayer: feePayer.publicKey,
          userVault,
          houseVault,
          pendingRound: pending,
          betAmount: Number(betLamports),
          rows: R, cols: C, mines: M,
          nonce, expiryUnix, edIndex,
        });

        const { blockhash } = await connection.getLatestBlockhash("confirmed");
        const msgV0 = new TransactionMessage({
          payerKey: feePayer.publicKey,
          recentBlockhash: blockhash,
          instructions: [cuPrice, cuLimit, edIx, lockIx],
        }).compileToV0Message();
        const vtx = new VersionedTransaction(msgV0);

        const sim = await connection.simulateTransaction(vtx, { sigVerify: false });
        if (sim.value.err) throw new Error(`Mines lock simulate failed: ${JSON.stringify(sim.value.err)}\n${(sim.value.logs || []).join("\n")}`);

        vtx.sign([feePayer]);
        const sig = await connection.sendRawTransaction(vtx.serialize(), { skipPreflight: false, maxRetries: 5 });
        await connection.confirmTransaction(sig, "confirmed");

        const rtp_bps = cfg?.rtp_bps ?? 9800;
        rounds.set(nonce, {
          playerPk, betLamports: BigInt(betLamports),
          rows: R, cols: C, mines: M,
          opened: new Set(), bombs: null, rtpBps: rtp_bps, over: false,
        });

        await DB.recordBet?.({
          player: playerPk.toBase58(),
          amount: String(betLamports),
          betType: -1, // mines
          target:  -1,
          roll: 0,
          payout: 0,
          nonce, expiry: expiryUnix,
          signature_base58: sig,
        }).catch(() => {});

        socket.emit("mines:locked", { nonce: String(nonce), txSig: sig, rows: R, cols: C, mines: M });
      } catch (e) {
        socket.emit("mines:error", { code: "PLACE_FAIL", message: e.message || String(e) });
      }
    });

    // open a tile
    socket.on("mines:open", async ({ nonce, row, col }) => {
      try {
        const ctx = rounds.get(Number(nonce));
        if (!ctx) return socket.emit("mines:error", { code: "NOT_FOUND", message: "no round" });
        if (ctx.over) return;

        const r = i32(row), c = i32(col);
        if (r < 0 || c < 0 || r >= ctx.rows || c >= ctx.cols)
          return socket.emit("mines:error", { code: "BAD_COORD", message: "row/col out of range" });

        const idx = r * ctx.cols + c;
        if (ctx.opened.has(idx)) return;

        if (!ctx.bombs) {
          ctx.bombs = deriveBombs({
            rows: ctx.rows, cols: ctx.cols, mines: ctx.mines,
            playerPk: ctx.playerPk, nonce: Number(nonce),
            firstSafeIndex: idx
          });
        }

        if (ctx.bombs.has(idx)) {
          ctx.over = true;
          socket.emit("mines:boom", { nonce: String(nonce), atIndex: idx, atStep: ctx.opened.size });

          // resolve on-chain with payout = 0
          const feePayer   = await getServerKeypair();
          const playerPk   = ctx.playerPk;
          const houseVault = deriveVaultPda();
          const adminPda   = deriveAdminPda();
          const userVault  = deriveUserVaultPda(playerPk);
          const pending    = derivePendingRoundPda(playerPk, nonce);

          const checksum = minesChecksum(nonce);
          const msg = Buffer.from(`MINES_RESOLVE|${playerPk.toBase58()}|${nonce}|${checksum}|0`);
          const edSig = await signMessageEd25519(msg);
          const edIx  = buildEd25519VerifyIx({ message: msg, signature: edSig, publicKey: require("./signer").ADMIN_PK });
          const edIndex = 1;

          const ix = ixMinesResolve({
            programId: PROGRAM_ID,
            player: playerPk,
            houseVault,
            adminPda,
            userVault,
            pendingRound: pending,
            checksum,
            payout: 0,
            edIndex,
          });

          const cu = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });
          const { blockhash } = await connection.getLatestBlockhash("confirmed");
          const msgV0 = new TransactionMessage({
            payerKey: feePayer.publicKey,
            recentBlockhash: blockhash,
            instructions: [cu, edIx, ix],
          }).compileToV0Message();
          const vtx = new VersionedTransaction(msgV0);
          vtx.sign([feePayer]);
          const sig = await connection.sendRawTransaction(vtx.serialize(), { skipPreflight: false, maxRetries: 5 });
          await connection.confirmTransaction(sig, "confirmed");

          // persist
          try {
            await DB.recordGameRound?.({
              game_key: "mines",
              player: playerPk.toBase58(),
              nonce: Number(nonce),
              stake_lamports: Number(ctx.betLamports),
              payout_lamports: 0,
              result_json: { rows: ctx.rows, cols: ctx.cols, mines: ctx.mines, opened: [...ctx.opened], boomAt: idx },
            });
          } catch {}

          io.emit("mines:resolved", { nonce: String(nonce), payoutLamports: 0, safeSteps: ctx.opened.size, tx: sig });
          rounds.delete(Number(nonce));
          return;
        }

        ctx.opened.add(idx);
        const totalTiles = ctx.rows * ctx.cols;
        const mult = multiplierFor(ctx.opened.size, totalTiles, ctx.mines, ctx.rtpBps);
        socket.emit("mines:safe", { nonce: String(nonce), index: idx, safeCount: ctx.opened.size, multiplier: mult });
      } catch (e) {
        socket.emit("mines:error", { code: "OPEN_FAIL", message: e.message || String(e) });
      }
    });

    // cashout (compute payout, resolve on-chain paying from house_vault → user_vault)
    socket.on("mines:cashout", async ({ nonce }) => {
      try {
        const ctx = rounds.get(Number(nonce));
        if (!ctx) return socket.emit("mines:error", { code: "NOT_FOUND", message: "no round" });
        if (ctx.over) return;
        if (ctx.opened.size < 1) return socket.emit("mines:error", { code: "TOO_SOON", message: "Open at least 1 tile before cashout" });

        const totalTiles = ctx.rows * ctx.cols;
        const mult = multiplierFor(ctx.opened.size, totalTiles, ctx.mines, ctx.rtpBps);
        const payout = (ctx.betLamports * BigInt(Math.floor(mult * 10000))) / 10000n;

        ctx.over = true;

        const feePayer   = await getServerKeypair();
        const playerPk   = ctx.playerPk;
        const houseVault = deriveVaultPda();
        const adminPda   = deriveAdminPda();
        const userVault  = deriveUserVaultPda(playerPk);
        const pending    = derivePendingRoundPda(playerPk, nonce);

        const checksum = minesChecksum(nonce);
        const msg = Buffer.from(`MINES_RESOLVE|${playerPk.toBase58()}|${nonce}|${checksum}|${payout.toString()}`);
        const edSig = await signMessageEd25519(msg);
        const edIx  = buildEd25519VerifyIx({ message: msg, signature: edSig, publicKey: require("./signer").ADMIN_PK });
        const edIndex = 1;

        const ix = ixMinesResolve({
          programId: PROGRAM_ID,
          player: playerPk,
          houseVault,
          adminPda,
          userVault,
          pendingRound: pending,
          checksum,
          payout: Number(payout),
          edIndex,
        });

        const cu = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });
        const { blockhash } = await connection.getLatestBlockhash("confirmed");
        const msgV0 = new TransactionMessage({
          payerKey: feePayer.publicKey,
          recentBlockhash: blockhash,
          instructions: [cu, edIx, ix],
        }).compileToV0Message();
        const vtx = new VersionedTransaction(msgV0);
        const sim = await connection.simulateTransaction(vtx, { sigVerify: false });
        if (sim.value.err) throw new Error(`Mines resolve simulate failed: ${JSON.stringify(sim.value.err)}\n${(sim.value.logs || []).join("\n")}`);

        vtx.sign([feePayer]);
        const sig = await connection.sendRawTransaction(vtx.serialize(), { skipPreflight: false, maxRetries: 5 });
        await connection.confirmTransaction(sig, "confirmed");

        try {
          await DB.recordGameRound?.({
            game_key: "mines",
            player: playerPk.toBase58(),
            nonce: Number(nonce),
            stake_lamports: Number(ctx.betLamports),
            payout_lamports: Number(payout),
            result_json: { rows: ctx.rows, cols: ctx.cols, mines: ctx.mines, opened: [...ctx.opened] },
          });
          await DB.recordActivity?.({ user: playerPk.toBase58(), action: "Mines cashout", amount: (Number(payout)/1e9).toFixed(4) });
        } catch {}

        io.emit("mines:resolved", { nonce: String(nonce), payoutLamports: Number(payout), safeSteps: ctx.opened.size, tx: sig });
        rounds.delete(Number(nonce));
      } catch (e) {
        socket.emit("mines:error", { code: "CASHOUT_FAIL", message: e.message || String(e) });
      }
    });
  });
}

module.exports = { attachMines };
