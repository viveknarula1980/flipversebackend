// backend/crash_ws.js — server-sent resolve + DB gating/persistence
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  Connection,
  PublicKey,
  VersionedTransaction,
  TransactionMessage,
  SystemProgram,
  ComputeBudgetProgram,
  Ed25519Program,
  Keypair,
} = require("@solana/web3.js");

const DB = global.db || require("./db");

// ---- env / rpc ----
const RPC_URL = process.env.CLUSTER || "https://api.devnet.solana.com";
if (!process.env.CRASH_PROGRAM_ID) throw new Error("CRASH_PROGRAM_ID missing in .env");
const CRASH_PROGRAM_ID = new PublicKey(process.env.CRASH_PROGRAM_ID);
const connection = new Connection(RPC_URL, "confirmed");

const { ADMIN_PK, signMessageEd25519 } = require("./signer");

function deriveVaultPda(programId = CRASH_PROGRAM_ID) {
  return PublicKey.findProgramAddressSync([Buffer.from("vault")], programId)[0];
}
function deriveAdminPda(programId = CRASH_PROGRAM_ID) {
  return PublicKey.findProgramAddressSync([Buffer.from("admin")], programId)[0];
}
const SYSVAR_INSTRUCTIONS_PUBKEY = new PublicKey("Sysvar1nstructions1111111111111111111111111");

function buildEd25519VerifyIx({ message, signature, publicKey }) {
  return Ed25519Program.createInstructionWithPublicKey({ publicKey, message, signature });
}

function anchorDisc(globalSnakeName) {
  return crypto.createHash("sha256").update(`global:${globalSnakeName}`).digest().slice(0, 8);
}
function encodeLockArgs({ betAmount, nonce, expiryUnix }) {
  const disc = anchorDisc("lock");
  const buf = Buffer.alloc(8 + 8 + 8 + 8);
  let o = 0;
  disc.copy(buf, o); o += 8;
  buf.writeBigUInt64LE(BigInt(betAmount), o); o += 8;
  buf.writeBigUInt64LE(BigInt(nonce), o); o += 8;
  buf.writeBigInt64LE(BigInt(expiryUnix), o); o += 8;
  return buf;
}
function encodeResolveArgs({ checksum, multiplierBps, payout, ed25519InstrIndex }) {
  const disc = anchorDisc("resolve");
  const buf = Buffer.alloc(8 + 1 + 4 + 8 + 1);
  let o = 0;
  disc.copy(buf, o); o += 8;
  buf.writeUInt8(checksum & 0xff, o++); buf.writeUInt32LE(multiplierBps >>> 0, o); o += 4;
  buf.writeBigUInt64LE(BigInt(payout), o); o += 8; buf.writeUInt8(ed25519InstrIndex & 0xff, o++);
  return buf;
}
function lockKeys({ player, vaultPda, pendingPda }) {
  return [
    { pubkey: player, isSigner: true, isWritable: true },
    { pubkey: vaultPda, isSigner: false, isWritable: true },
    { pubkey: pendingPda, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];
}
function resolveKeys({ player, vaultPda, adminPda, pendingPda }) {
  return [
    { pubkey: player, isSigner: false, isWritable: true },
    { pubkey: vaultPda, isSigner: false, isWritable: true },
    { pubkey: adminPda, isSigner: false, isWritable: false },
    { pubkey: pendingPda, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
  ];
}

// RNG for crash
function u64From(buf) {
  return (BigInt(buf[0]) << 56n) |
         (BigInt(buf[1]) << 48n) |
         (BigInt(buf[2]) << 40n) |
         (BigInt(buf[3]) << 32n) |
         (BigInt(buf[4]) << 24n) |
         (BigInt(buf[5]) << 16n) |
         (BigInt(buf[6]) << 8n)  |
          BigInt(buf[7]);
}
function deriveCrashPoint({ serverSeed, clientSeed, nonce }) {
  const h = crypto.createHmac("sha256", serverSeed).update(String(clientSeed || "")).update(Buffer.from(String(nonce))).digest();
  const n64 = u64From(h.subarray(0, 8));
  const r = Number((n64 >> 11n)) / Math.pow(2, 53);
  const edge = 0.99;
  const m = Math.max(1.01, edge / (1 - Math.min(0.999999999999, r)));
  return Math.min(m, 10000);
}
function multiplierAt(startMs) {
  const speed = Number(process.env.CRASH_SPEED_MS || 3500);
  const elapsed = Math.max(0, Date.now() - startMs);
  return 1 + Math.pow(elapsed / speed, 1.35);
}
function toBps(m) { return Math.floor(m * 10000); }

function pendingPdaFor(playerPk, nonce) {
  const nb = Buffer.alloc(8); nb.writeBigUInt64LE(BigInt(nonce));
  return PublicKey.findProgramAddressSync([Buffer.from("round"), playerPk.toBuffer(), nb], CRASH_PROGRAM_ID)[0];
}

// // server fee payer
// function feePayer() {
//   let secret;
//   if (process.env.SOLANA_KEYPAIR) {
//     // if env variable is a path
//     const keyPath = process.env.SOLANA_KEYPAIR;
//     const fileContents = fs.readFileSync(keyPath, "utf8");
//     secret = Uint8Array.from(JSON.parse(fileContents));
//   } else {
//     // fallback to default solana key
//     const keyPath = process.env.ANCHOR_WALLET || path.join(os.homedir(), ".config/solana/id.json");
//     const fileContents = fs.readFileSync(keyPath, "utf8");
//     secret = Uint8Array.from(JSON.parse(fileContents));
//   }
//   return Keypair.fromSecretKey(secret);
// }

// server fee payer
function feePayer() {
  let secret;

  if (process.env.SOLANA_KEYPAIR) {
    const keyEnv = process.env.SOLANA_KEYPAIR.trim();

    try {
      if (keyEnv.startsWith("[") && keyEnv.endsWith("]")) {
        // ✅ case: env contains the JSON array directly
        secret = Uint8Array.from(JSON.parse(keyEnv));
      } else {
        // ✅ case: env contains a file path
        const fileContents = fs.readFileSync(keyEnv, "utf8");
        secret = Uint8Array.from(JSON.parse(fileContents));
      }
    } catch (err) {
      throw new Error("Invalid SOLANA_KEYPAIR format: " + err.message);
    }
  } else {
    // fallback to default solana key
    const keyPath =
      process.env.ANCHOR_WALLET ||
      path.join(os.homedir(), ".config/solana/id.json");
    const fileContents = fs.readFileSync(keyPath, "utf8");
    secret = Uint8Array.from(JSON.parse(fileContents));
  }

  return Keypair.fromSecretKey(secret);
}



// rounds per server
const rounds = new Map();

async function sendResolveTx({ ctx, nonce, cashoutMultiplier }) {
  const playerPk = ctx.playerPk;
  const vaultPda = deriveVaultPda();
  const adminPda = deriveAdminPda();
  const pendingPda = pendingPdaFor(playerPk, nonce);

  const win = cashoutMultiplier != null;
  const checksum = win ? 1 : 100;

  let payout = 0;
  let multBps = 10_000;
  if (win) {
    const m = Math.max(1, Number(cashoutMultiplier));
    multBps = toBps(m);
    const gross = (ctx.betLamports * BigInt(multBps)) / 10000n;
    const net = gross - ctx.betLamports; // net profit
    payout = Number(net > 0n ? net : 0n);
  }
  const expiryUnix = Math.floor(Date.now() / 1000) + Number(process.env.NONCE_TTL_SECONDS || 300);

  const msg = Buffer.concat([
    Buffer.from("CRASH_V1"),
    CRASH_PROGRAM_ID.toBuffer(),
    vaultPda.toBuffer(),
    playerPk.toBuffer(),
    (()=>{const b=Buffer.alloc(8); b.writeBigUInt64LE(BigInt(ctx.betLamports)); return b;})(),
    (()=>{const b=Buffer.alloc(4); b.writeUInt32LE(multBps>>>0); return b;})(),
    (()=>{const b=Buffer.alloc(8); b.writeBigUInt64LE(BigInt(payout)); return b;})(),
    (()=>{const b=Buffer.alloc(8); b.writeBigUInt64LE(BigInt(nonce)); return b;})(),
    (()=>{const b=Buffer.alloc(8); b.writeBigInt64LE(BigInt(expiryUnix)); return b;})(),
  ]);
  const edSig = await signMessageEd25519(msg);
  const edIx = buildEd25519VerifyIx({ message: msg, signature: edSig, publicKey: ADMIN_PK });
  const edIndex = 1;

  const dataResolve = encodeResolveArgs({ checksum, multiplierBps: multBps, payout, ed25519InstrIndex: edIndex });
  const keysResolve = resolveKeys({ player: playerPk, vaultPda, adminPda, pendingPda });
  const ixResolve = { programId: CRASH_PROGRAM_ID, keys: keysResolve, data: dataResolve };

  const payer = feePayer();
  const cuLimit = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const msgV0 = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: blockhash, instructions: [cuLimit, edIx, ixResolve] }).compileToV0Message();

  const vtx = new VersionedTransaction(msgV0);
  vtx.sign([payer]);
  const txSig = await connection.sendRawTransaction(vtx.serialize(), { skipPreflight: false, maxRetries: 5 });
  await connection.confirmTransaction(txSig, "confirmed");

  return { txSig, multBps, payout };
}

// ---------- Attach WS ----------
function attachCrash(io) {
  io.on("connection", (socket) => {
    socket.on("register", ({ player }) => { socket.data.player = String(player || "guest"); });

    socket.on("crash:prepare_lock", async ({ player, betAmountLamports, clientSeed }) => {
      try {
        if (!player) return socket.emit("crash:error", { code: "NO_PLAYER", message: "player required" });

        // admin gate + min/max
        const cfg = await DB.getGameConfig?.("crash");
        if (cfg && (!cfg.enabled || !cfg.running)) {
          return socket.emit("crash:error", { code: "DISABLED", message: "Crash disabled by admin" });
        }
        const min = BigInt(cfg?.min_bet_lamports ?? 50000);
        const max = BigInt(cfg?.max_bet_lamports ?? 5_000_000_000n);

        const betLamports = BigInt(betAmountLamports || 0);
        if (betLamports <= 0n) return socket.emit("crash:error", { code: "BAD_BET", message: "betAmountLamports invalid" });
        if (betLamports < min || betLamports > max) {
          return socket.emit("crash:error", { code: "BET_RANGE", message: "Bet outside allowed range" });
        }

        const playerPk = new PublicKey(player);
        const vaultPda = deriveVaultPda();

        const nonce = Date.now();
        const expiryUnix = Math.floor(Date.now() / 1000) + Number(process.env.NONCE_TTL_SECONDS || 300);

        const nonceBuf = Buffer.alloc(8); nonceBuf.writeBigUInt64LE(BigInt(nonce));
        const pendingPda = PublicKey.findProgramAddressSync([Buffer.from("round"), playerPk.toBuffer(), nonceBuf], CRASH_PROGRAM_ID)[0];

        const dataLock = encodeLockArgs({ betAmount: betLamports, nonce, expiryUnix });
        const keysLock = lockKeys({ player: playerPk, vaultPda, pendingPda });
        const ixLock = { programId: CRASH_PROGRAM_ID, keys: keysLock, data: dataLock };
        const cuLimit = ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 });

        const { blockhash } = await connection.getLatestBlockhash("confirmed");
        const msgV0 = new TransactionMessage({ payerKey: playerPk, recentBlockhash: blockhash, instructions: [cuLimit, ixLock] }).compileToV0Message();
        const vtx = new VersionedTransaction(msgV0);
        const txBase64 = Buffer.from(vtx.serialize()).toString("base64");

        const serverSeed = crypto.randomBytes(32);
        rounds.set(nonce, {
          playerPk,
          betLamports,
          clientSeed: String(clientSeed || ""),
          serverSeed,
          startTs: 0,
          crashAtMul: 0,
          crashed: false,
          cashed: false,
          timer: null,
        });

        socket.emit("crash:lock_tx", { nonce: String(nonce), expiryUnix, transactionBase64: txBase64 });
      } catch (e) {
        console.error("crash:prepare_lock error:", e);
        socket.emit("crash:error", { code: "PREPARE_FAIL", message: String(e.message || e) });
      }
    });

    socket.on("crash:lock_confirmed", ({ player, nonce }) => {
      const ctx = rounds.get(Number(nonce));
      if (!ctx) return socket.emit("crash:error", { code: "NOT_FOUND", message: "no round" });

      ctx.startTs = Date.now();
      ctx.crashAtMul = deriveCrashPoint({ serverSeed: ctx.serverSeed, clientSeed: ctx.clientSeed, nonce: Number(nonce) });

      const tickMs = 75;
      ctx.timer = setInterval(() => {
        if (ctx.cashed || ctx.crashed) return;
        const m = multiplierAt(ctx.startTs);
        if (m >= ctx.crashAtMul) {
          ctx.crashed = true;
          clearInterval(ctx.timer);
          socket.emit("crash:crashed", { nonce: String(nonce), finalMultiplier: ctx.crashAtMul });

          sendResolveTx({ ctx, nonce: Number(nonce), cashoutMultiplier: null })
            .then(async ({ txSig, multBps, payout }) => {
              // persist loss
              try {
                await DB.recordGameRound?.({
                  game_key: "crash",
                  player: ctx.playerPk.toBase58(),
                  nonce: Number(nonce),
                  stake_lamports: Number(ctx.betLamports),
                  payout_lamports: 0,
                  result_json: { crashedAt: ctx.crashAtMul, cashout: null },
                });
              } catch {}
              io.emit("crash:resolved", { nonce: String(nonce), multiplierBps: multBps, payoutLamports: String(payout), tx: txSig });
            })
            .catch((e) => {
              console.error("resolve(loss) send error:", e);
              socket.emit("crash:error", { code: "RESOLVE_FAIL", message: String(e.message || e) });
            });

          return;
        }
        socket.emit("crash:tick", { nonce: String(nonce), multiplier: m });
      }, tickMs);
    });

    socket.on("crash:cashout", async ({ player, nonce, atMultiplier }) => {
      try {
        const ctx = rounds.get(Number(nonce));
        if (!ctx) return socket.emit("crash:error", { code: "NOT_FOUND", message: "no round" });
        if (ctx.crashed || ctx.cashed) return;

        const liveM = multiplierAt(ctx.startTs);
        const m = Math.max(1, Number(atMultiplier || liveM));
        if (m <= 1) return;

        ctx.cashed = true;
        if (ctx.timer) clearInterval(ctx.timer);

        const { txSig, multBps, payout } = await sendResolveTx({ ctx, nonce: Number(nonce), cashoutMultiplier: m });

        // persist + activity
        try {
          await DB.recordGameRound?.({
            game_key: "crash",
            player: ctx.playerPk.toBase58(),
            nonce: Number(nonce),
            stake_lamports: Number(ctx.betLamports),
            payout_lamports: Number(payout),
            result_json: { crashedAt: ctx.crashAtMul, cashout: m },
          });
          if (payout > 0) {
            await DB.recordActivity?.({
              user: ctx.playerPk.toBase58(),
              action: "Crash cashout",
              amount: (Number(payout)/1e9).toFixed(4),
            });
          }
        } catch {}

        io.emit("crash:resolved", { nonce: String(nonce), multiplierBps: multBps, payoutLamports: String(payout), tx: txSig });
      } catch (e) {
        console.error("crash:cashout error:", e);
        socket.emit("crash:error", { code: "CASHOUT_FAIL", message: String(e.message || e) });
      }
    });
  });
}

module.exports = { attachCrash };
