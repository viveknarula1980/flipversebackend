// backend/mines_ws.js
// Server-driven Mines. Server pays winners, then resolve(payout=0) to close PDA.
// Server-driven Mines (no auto-open). User signs LOCK; every click sends `mines:open`.
// Resolve is server-paid (no 2nd wallet popup). Server will transfer payout directly
// from its fee payer wallet, then call resolve(payout=0) to close the pending PDA.

const crypto = require("crypto");
const {
  Connection,
  PublicKey,
  VersionedTransaction,
  TransactionMessage,
  SystemProgram,
  ComputeBudgetProgram,
  Ed25519Program,
} = require("@solana/web3.js");

const { ADMIN_PK, signMessageEd25519, getServerKeypair } = require("./signer");
const DB = global.db || require("./db");

// ---- ENV / RPC / Program ----
const RPC_URL = process.env.CLUSTER || "https://api.devnet.solana.com";
const connection = new Connection(RPC_URL, "confirmed");

if (!process.env.MINES_PROGRAM_ID) throw new Error("MINES_PROGRAM_ID missing in .env");
const PROGRAM_ID = new PublicKey(process.env.MINES_PROGRAM_ID);

const SYSVAR_INSTR = new PublicKey("Sysvar1nstructions1111111111111111111111111");

const ADMIN_PUBKEY = new PublicKey(ADMIN_PK);

// PDAs & utils
function pdaVault() { return PublicKey.findProgramAddressSync([Buffer.from("vault")], PROGRAM_ID)[0]; }
function pdaPending(playerPk, nonce) {
  const nb = Buffer.alloc(8);
  nb.writeBigUInt64LE(BigInt(nonce));
  return PublicKey.findProgramAddressSync([Buffer.from("round"), playerPk.toBuffer(), nb], PROGRAM_ID)[0];
}
function anchorDisc(name) { return crypto.createHash("sha256").update(`global:${name}`).digest().slice(0, 8); }
if (!process.env.MINES_PROGRAM_ID) {
  throw new Error("MINES_PROGRAM_ID missing in .env");
}
// const PROGRAM_ID = new PublicKey(process.env.MINES_PROGRAM_ID);

const SYSVAR_INSTR = new PublicKey(
  "Sysvar1nstructions1111111111111111111111111"
);

// Wrap ADMIN_PK (Uint8Array exported from signer.js) into a PublicKey locally
// (user asked not to change signer.js)
const ADMIN_PUBKEY = (() => {
  if (!ADMIN_PK) throw new Error("ADMIN_PK missing from signer.js");
  try {
    return new PublicKey(ADMIN_PK);
  } catch (e) {
    throw new Error("Failed to convert ADMIN_PK -> PublicKey: " + String(e));
  }
})();

// Vault PDA and pending PDA (must match your lib.rs seeds)
function pdaVault() {
  return PublicKey.findProgramAddressSync([Buffer.from("vault")], PROGRAM_ID)[0];
}
function pdaPending(playerPk, nonce) {
  const nb = Buffer.alloc(8);
  nb.writeBigUInt64LE(BigInt(nonce));
  return PublicKey.findProgramAddressSync(
    [Buffer.from("round"), playerPk.toBuffer(), nb],
    PROGRAM_ID
  )[0];
}
function anchorDisc(name) {
  return crypto.createHash("sha256").update(`global:${name}`).digest().slice(0, 8);
}

// ---- arg encoders matching lib.rs ----
// lock(bet_lamports:u64, rows:u8, cols:u8, mines:u8, nonce:u64, expiry:i64)
function encLock({ betLamports, rows, cols, mines, nonce, expiryUnix }) {
  const d = anchorDisc("lock");
  const b = Buffer.alloc(8 + 8 + 1 + 1 + 1 + 8 + 8);
  let o = 0;
  d.copy(b, o); o += 8;
  b.writeBigUInt64LE(BigInt(betLamports), o); o += 8;
  b.writeUInt8(rows & 0xff, o++); b.writeUInt8(cols & 0xff, o++); b.writeUInt8(mines & 0xff, o++);
  b.writeUInt8(rows & 0xff, o++);
  b.writeUInt8(cols & 0xff, o++);
  b.writeUInt8(mines & 0xff, o++);
  b.writeBigUInt64LE(BigInt(nonce), o); o += 8;
  b.writeBigInt64LE(BigInt(expiryUnix), o); o += 8;
  return b;
}
// resolve(checksum:u8, payout:u64, ed_index:u8)
function encResolve({ checksum, payout, edIndex }) {
  const d = anchorDisc("resolve");
  const b = Buffer.alloc(8 + 1 + 8 + 1);
  let o = 0;
  d.copy(b, o); o += 8;
  b.writeUInt8(checksum & 0xff, o++); b.writeBigUInt64LE(BigInt(payout), o); o += 8; b.writeUInt8(edIndex & 0xff, o++);
  return b;
}
  b.writeUInt8(checksum & 0xff, o++);
  b.writeBigUInt64LE(BigInt(payout), o); o += 8;
  b.writeUInt8(edIndex & 0xff, o++);
  return b;
}

// Accounts (must match #[derive(Accounts)] in lib.rs)
function keysLock({ player, vault, pending }) {
  return [
    { pubkey: player, isSigner: true, isWritable: true },
    { pubkey: vault, isSigner: false, isWritable: true },
    { pubkey: pending, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];
}
function keysResolve({ player, vault, admin, pending }) {
  return [
    { pubkey: player, isSigner: false, isWritable: true },
    { pubkey: vault, isSigner: false, isWritable: true },
    { pubkey: admin, isSigner: false, isWritable: false },
    { pubkey: pending, isSigner: false, isWritable: true },
  // Order must match your Resolve<'info> layout in lib.rs:
  // player, vault, admin, pending, system_program, instructions
  return [
    { pubkey: player, isSigner: false, isWritable: true },   // SystemAccount (receiver)
    { pubkey: vault, isSigner: false, isWritable: true },    // vault PDA (signer by seeds)
    { pubkey: admin, isSigner: false, isWritable: false },   // admin filler
    { pubkey: pending, isSigner: false, isWritable: true },  // pending PDA (close = player)
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_INSTR, isSigner: false, isWritable: false },
  ];
}

// math
// Simple binomial multiplier (gross) with optional RTP
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

// Deterministic bombs set (first click safe)
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
    const rng = crypto.createHmac("sha256", seedKey)
      .update(Buffer.from(String(i++)))
      .digest();
    const n = ((rng[0] << 24) | (rng[1] << 16) | (rng[2] << 8) | rng[3]) >>> 0;
    const idx = n % total;
    if (idx === firstSafeIndex) continue;
    picked.add(idx);
  }
  return picked;
}

// store
// rounds store
const rounds = new Map();

async function buildLockTx({ playerPk, betLamports, rows, cols, mines, nonce, expiryUnix }) {
  const vault = pdaVault();
  const pending = pdaPending(playerPk, nonce);
  const ix = { programId: PROGRAM_ID, keys: keysLock({ player: playerPk, vault, pending }), data: encLock({ betLamports, rows, cols, mines, nonce, expiryUnix }) };
  const cu = ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 });
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({ payerKey: playerPk, recentBlockhash: blockhash, instructions: [cu, ix] }).compileToV0Message();
  const ix = {
    programId: PROGRAM_ID,
    keys: keysLock({ player: playerPk, vault, pending }),
    data: encLock({ betLamports, rows, cols, mines, nonce, expiryUnix }),
  };
  const cu = ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 });
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({
    payerKey: playerPk,
    recentBlockhash: blockhash,
    instructions: [cu, ix],
  }).compileToV0Message();
  const vtx = new VersionedTransaction(msg);

  const sim = await connection.simulateTransaction(vtx, { sigVerify: false });
  if (sim.value.err) {
    const logs = (sim.value.logs || []).join("\n");
    const e = JSON.stringify(sim.value.err);
    const abiErr = logs.includes("InstructionFallbackNotFound") || logs.includes("Fallback functions are not supported");
    if (abiErr) throw new Error(`LOCK discriminator mismatch: ${logs}`);
    const fundsErr = logs.includes("Transfer: insufficient lamports") || e.includes('"Custom":1');
    if (!fundsErr) throw new Error(`LOCK simulate failed: ${e}\n${logs}`);
  }
  return Buffer.from(vtx.serialize()).toString("base64");
}

async function sendResolve({ playerPk, nonce, payoutLamports }) {
  const vault = pdaVault();
  const pending = pdaPending(playerPk, nonce);
  const admin = ADMIN_PUBKEY;
  const feePayer = await getServerKeypair();

  if (BigInt(payoutLamports) > 0n) {
    try {
      const transferIx = SystemProgram.transfer({ fromPubkey: feePayer.publicKey, toPubkey: playerPk, lamports: BigInt(payoutLamports) });
      const { blockhash: bh1 } = await connection.getLatestBlockhash("confirmed");
      const transferMsg = new TransactionMessage({ payerKey: feePayer.publicKey, recentBlockhash: bh1, instructions: [transferIx] }).compileToV0Message();
/**
 * sendResolve:
 * - If payoutLamports > 0: server (fee payer) transfers lamports to player in a separate tx.
 * - Then call on-chain resolve with payout=0 to close pending (program will not attempt a transfer).
 */
async function sendResolve({ playerPk, nonce, payoutLamports }) {
  const vault = pdaVault();
  const pending = pdaPending(playerPk, nonce);

  // admin as PublicKey (wrapped locally)
  const admin = ADMIN_PUBKEY;

  // server fee payer keypair (used to pay tx fees and do direct payouts)
  const feePayer = await getServerKeypair();

  // If we need to actually pay the player, do it from the server fee payer first.
  if (BigInt(payoutLamports) > 0n) {
    try {
      // Build a transfer tx: feePayer -> player
      const transferIx = SystemProgram.transfer({
        fromPubkey: feePayer.publicKey,
        toPubkey: playerPk,
        lamports: BigInt(payoutLamports),
      });
      const { blockhash: bh1 } = await connection.getLatestBlockhash("confirmed");
      const transferMsg = new TransactionMessage({
        payerKey: feePayer.publicKey,
        recentBlockhash: bh1,
        instructions: [transferIx],
      }).compileToV0Message();
      const transferVtx = new VersionedTransaction(transferMsg);
      transferVtx.sign([feePayer]);
      const transferSig = await connection.sendRawTransaction(transferVtx.serialize(), { skipPreflight: false });
      await connection.confirmTransaction(transferSig, "confirmed");
    } catch (e) {
      // After server-paid transfer succeeded, we will call resolve with payout=0 so program does not try to transfer from vault.
    } catch (e) {
      // If server-side transfer failed, abort and bubble error
      throw new Error("Server payout transfer failed: " + (e?.message || String(e)));
    }
  }

  const msg = Buffer.concat([ Buffer.from("MINES_V1"), PROGRAM_ID.toBuffer(), vault.toBuffer(), playerPk.toBuffer(), Buffer.from(String(nonce)) ]);
  const edSig = await signMessageEd25519(msg);
  const edIx = Ed25519Program.createInstructionWithPublicKey({ publicKey: admin.toBuffer(), message: msg, signature: edSig });
  const edIndex = 1;

  const checksum = ((Number(nonce) % 251) + 1) & 0xff;
  const data = encResolve({ checksum, payout: 0n, edIndex });
  const ix = { programId: PROGRAM_ID, keys: keysResolve({ player: playerPk, vault, admin, pending }), data };

  const cu = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const msgV0 = new TransactionMessage({ payerKey: feePayer.publicKey, recentBlockhash: blockhash, instructions: [cu, edIx, ix] }).compileToV0Message();
  const vtx = new VersionedTransaction(msgV0);

  // optional proof message (kept for off-chain proof)
  const msg = Buffer.concat([
    Buffer.from("MINES_V1"),
    PROGRAM_ID.toBuffer(),
    vault.toBuffer(),
    playerPk.toBuffer(),
    Buffer.from(String(nonce)),
  ]);

  const edSig = await signMessageEd25519(msg);

  // Ed25519Program.createInstructionWithPublicKey expects raw 32 bytes for publicKey param,
  // so use admin.toBuffer()
  const edIx = Ed25519Program.createInstructionWithPublicKey({
    publicKey: admin.toBuffer(), // raw 32 bytes
    message: msg,
    signature: edSig,
  });

  // ed instruction index in tx (cu, edIx, ix) => edIx index = 1
  const edIndex = 1;

  const checksum = ((Number(nonce) % 251) + 1) & 0xff;

  // We pass payout = 0 to the on-chain resolve because we already paid from server.
  const data = encResolve({ checksum, payout: 0n, edIndex });

  const ix = {
    programId: PROGRAM_ID,
    keys: keysResolve({ player: playerPk, vault, admin, pending }),
    data,
  };

  const cu = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const msgV0 = new TransactionMessage({
    payerKey: feePayer.publicKey,
    recentBlockhash: blockhash,
    instructions: [cu, edIx, ix],
  }).compileToV0Message();

  const vtx = new VersionedTransaction(msgV0);

  // simulate (no sigs attached yet)
  const sim = await connection.simulateTransaction(vtx, { sigVerify: false });
  if (sim.value.err) {
    const logs = (sim.value.logs || []).join("\n");
    throw new Error(`RESOLVE simulate failed: ${JSON.stringify(sim.value.err)}\n${logs}`);
  }
  vtx.sign([feePayer]);
  const sig = await connection.sendRawTransaction(vtx.serialize(), { skipPreflight: false, maxRetries: 5 });

  // sign and send resolve (feePayer pays fees)
  vtx.sign([feePayer]);
  const sig = await connection.sendRawTransaction(vtx.serialize(), {
    skipPreflight: false,
    maxRetries: 5,
  });
  await connection.confirmTransaction(sig, "confirmed");
  return sig;
}

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function i32(x) { const n = Number(x); return Number.isFinite(n) ? (n | 0) : 0; }

function attachMines(io) {
  io.on("connection", (socket) => {
    socket.on("register", ({ player }) => { socket.data.player = String(player || "guest"); });

    // prepare lock
    socket.on("mines:prepare_lock", async (p) => {
      try {
        const player = String(p?.player || "");
        if (!player) return socket.emit("mines:error", { code: "NO_PLAYER", message: "player required" });

        // admin gate + min/max
        const cfg = await DB.getGameConfig?.("mines");
        if (cfg && (!cfg.enabled || !cfg.running)) {
          return socket.emit("mines:error", { code: "DISABLED", message: "Mines disabled by admin" });
        }
        const min = BigInt(cfg?.min_bet_lamports ?? 50000);
        const max = BigInt(cfg?.max_bet_lamports ?? 5_000_000_000n);

        const betLamports = BigInt(p?.betAmountLamports || 0);
        if (!(betLamports > 0n)) return socket.emit("mines:error", { code:"BAD_BET", message:"betAmountLamports must be > 0" });
        if (betLamports < min || betLamports > max) {
          return socket.emit("mines:error", { code: "BET_RANGE", message: "Bet outside allowed range" });
        }
        const betLamports = BigInt(p?.betAmountLamports || 0);
        if (!(betLamports > 0n)) return socket.emit("mines:error", { code:"BAD_BET", message:"betAmountLamports must be > 0" });

        const rows = clamp(i32(p?.rows), 2, 8);
        const cols = clamp(i32(p?.cols), 2, 8);
        const mines = clamp(i32(p?.minesCount), 1, rows * cols - 1);

        const playerPk = new PublicKey(player);
        const nonce = Date.now();
        const expiryUnix = Math.floor(Date.now() / 1000) + Number(process.env.NONCE_TTL_SECONDS || 300);

        const txB64 = await buildLockTx({ playerPk, betLamports: Number(betLamports), rows, cols, mines, nonce, expiryUnix });

        let rtp_bps = cfg?.rtp_bps ?? 9800;
        rounds.set(nonce, { playerPk, betLamports: BigInt(betLamports), rows, cols, mines, opened: new Set(), bombs: null, rtpBps: rtp_bps, over: false });

        socket.emit("mines:lock_tx", { nonce: String(nonce), expiryUnix, transactionBase64: txB64 });
        const txB64 = await buildLockTx({
          playerPk, betLamports: Number(betLamports), rows, cols, mines, nonce, expiryUnix
        });

        let rtp_bps = 9800;
        try {
          if (typeof global.db?.getRules === "function") {
            const r = await global.db.getRules();
            if (r?.rtp_bps) rtp_bps = r.rtp_bps;
          }
        } catch {}

        rounds.set(nonce, {
          playerPk,
          betLamports: BigInt(betLamports),
          rows, cols, mines,
          opened: new Set(),
          bombs: null,
          rtpBps: rtp_bps,
          over: false,
        });

        socket.emit("mines:lock_tx", {
          nonce: String(nonce),
          expiryUnix,
          transactionBase64: txB64,
        });
      } catch (e) {
        console.error("mines:prepare_lock error:", e);
        socket.emit("mines:error", { code: "PREPARE_FAIL", message: e.message || String(e) });
      }
    });

    socket.on("mines:lock_confirmed", ({ nonce }) => {
      const ctx = rounds.get(Number(nonce));
      if (!ctx) return socket.emit("mines:error", { code: "NOT_FOUND", message: "no round" });
      socket.emit("mines:started", { nonce: String(nonce), rows: ctx.rows, cols: ctx.cols, mines: ctx.mines });
    });

    // lock confirmed
    socket.on("mines:lock_confirmed", ({ nonce }) => {
      const ctx = rounds.get(Number(nonce));
      if (!ctx) return socket.emit("mines:error", { code: "NOT_FOUND", message: "no round" });
      socket.emit("mines:started", {
        nonce: String(nonce),
        rows: ctx.rows,
        cols: ctx.cols,
        mines: ctx.mines,
      });
    });

    // open
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
          ctx.bombs = deriveBombs({ rows: ctx.rows, cols: ctx.cols, mines: ctx.mines, playerPk: ctx.playerPk, nonce: Number(nonce), firstSafeIndex: idx });
          ctx.bombs = deriveBombs({
            rows: ctx.rows,
            cols: ctx.cols,
            mines: ctx.mines,
            playerPk: ctx.playerPk,
            nonce: Number(nonce),
            firstSafeIndex: idx,
          });
        }

        if (ctx.bombs.has(idx)) {
          ctx.over = true;
          socket.emit("mines:boom", { nonce: String(nonce), atIndex: idx, atStep: ctx.opened.size });
          const sig = await sendResolve({ playerPk: ctx.playerPk, nonce: Number(nonce), payoutLamports: 0n });

          // persist loss
          try {
            await DB.recordGameRound?.({
              game_key: "mines",
              player: ctx.playerPk.toBase58(),
              nonce: Number(nonce),
              stake_lamports: Number(ctx.betLamports),
              payout_lamports: 0,
              result_json: { rows: ctx.rows, cols: ctx.cols, mines: ctx.mines, opened: [...ctx.opened], boomAt: idx },
            });
          } catch {}

          const payload = { nonce: String(nonce), payoutLamports: 0, safeSteps: ctx.opened.size, tx: sig };
          io.emit("mines:resolved", payload);
          const sig = await sendResolve({
            playerPk: ctx.playerPk,
            nonce: Number(nonce),
            payoutLamports: 0n,
          });
          io.emit("mines:resolved", {
            nonce: String(nonce),
            payoutLamports: 0,
            safeSteps: ctx.opened.size,
            tx: sig,
          });
          rounds.delete(Number(nonce));
          return;
        }

        ctx.opened.add(idx);
        const totalTiles = ctx.rows * ctx.cols;
        const mult = multiplierFor(ctx.opened.size, totalTiles, ctx.mines, ctx.rtpBps);
        socket.emit("mines:safe", { nonce: String(nonce), index: idx, safeCount: ctx.opened.size, multiplier: mult });
        socket.emit("mines:safe", {
          nonce: String(nonce),
          index: idx,
          safeCount: ctx.opened.size,
          multiplier: mult,
        });
      } catch (e) {
        console.error("mines:open error:", e);
        socket.emit("mines:error", { code: "OPEN_FAIL", message: e.message || String(e) });
      }
    });

    // cashout
    socket.on("mines:cashout", async ({ nonce }) => {
      try {
        const ctx = rounds.get(Number(nonce));
        if (!ctx) return socket.emit("mines:error", { code: "NOT_FOUND", message: "no round" });
        if (ctx.over) return;
        if (ctx.opened.size < 1) {
          return socket.emit("mines:error", { code: "TOO_SOON", message: "Open at least 1 tile before cashout" });
        }

        const totalTiles = ctx.rows * ctx.cols;
        const mult = multiplierFor(ctx.opened.size, totalTiles, ctx.mines, ctx.rtpBps);
        const payout = (ctx.betLamports * BigInt(Math.floor(mult * 10000))) / 10000n;

        ctx.over = true;
        const sig = await sendResolve({ playerPk: ctx.playerPk, nonce: Number(nonce), payoutLamports: payout });

        // persist win + activity
        try {
          await DB.recordGameRound?.({
            game_key: "mines",
            player: ctx.playerPk.toBase58(),
            nonce: Number(nonce),
            stake_lamports: Number(ctx.betLamports),
            payout_lamports: Number(payout),
            result_json: { rows: ctx.rows, cols: ctx.cols, mines: ctx.mines, opened: [...ctx.opened] },
          });
          await DB.recordActivity?.({
            user: ctx.playerPk.toBase58(),
            action: "Mines cashout",
            amount: (Number(payout)/1e9).toFixed(4),
          });
        } catch {}

        io.emit("mines:resolved", { nonce: String(nonce), payoutLamports: Number(payout), safeSteps: ctx.opened.size, tx: sig });
        const sig = await sendResolve({
          playerPk: ctx.playerPk,
          nonce: Number(nonce),
          payoutLamports: payout,
        });

        io.emit("mines:resolved", {
          nonce: String(nonce),
          payoutLamports: Number(payout),
          safeSteps: ctx.opened.size,
          tx: sig,
        });

        rounds.delete(Number(nonce));
      } catch (e) {
        console.error("mines:cashout error:", e);
        socket.emit("mines:error", { code: "CASHOUT_FAIL", message: e.message || String(e) });
      }
    });
  });
}

module.exports = { attachMines };
