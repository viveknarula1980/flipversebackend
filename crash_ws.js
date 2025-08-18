// crash_ws.js (server-sent resolve; no second wallet popup)
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

// ---- env / rpc ----
const RPC_URL = process.env.CLUSTER || "https://api.devnet.solana.com";
if (!process.env.CRASH_PROGRAM_ID) throw new Error("CRASH_PROGRAM_ID missing in .env");
const CRASH_PROGRAM_ID = new PublicKey(process.env.CRASH_PROGRAM_ID);
const connection = new Connection(RPC_URL, "confirmed");

// Reuse your admin ed25519 keys (signs the message verified on-chain)
const { ADMIN_PK, signMessageEd25519 } = require("./signer");

// We keep Crash separate from dice PDAs (same seed strings but different program = different addresses)
function deriveVaultPda(programId = CRASH_PROGRAM_ID) {
  return PublicKey.findProgramAddressSync([Buffer.from("vault")], programId)[0];
}
function deriveAdminPda(programId = CRASH_PROGRAM_ID) {
  return PublicKey.findProgramAddressSync([Buffer.from("admin")], programId)[0];
}
const SYSVAR_INSTRUCTIONS_PUBKEY = new PublicKey(
  "Sysvar1nstructions1111111111111111111111111"
);

// Build ed25519 verify ix
function buildEd25519VerifyIx({ message, signature, publicKey }) {
  return Ed25519Program.createInstructionWithPublicKey({ publicKey, message, signature });
}

// ---------- Anchor discriminators & arg encoders (Crash program) ----------
function anchorDisc(globalSnakeName) {
  return crypto.createHash("sha256").update(`global:${globalSnakeName}`).digest().slice(0, 8);
}

// LockArgs { bet_amount:u64, nonce:u64, expiry_unix:i64 }
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

// ResolveArgs { checksum:u8, multiplier_bps:u32, payout:u64, ed25519_instr_index:u8 }
function encodeResolveArgs({ checksum, multiplierBps, payout, ed25519InstrIndex }) {
  const disc = anchorDisc("resolve");
  const buf = Buffer.alloc(8 + 1 + 4 + 8 + 1);
  let o = 0;
  disc.copy(buf, o); o += 8;
  buf.writeUInt8(checksum & 0xff, o++);                // u8  (1..100)
  buf.writeUInt32LE(multiplierBps >>> 0, o); o += 4;   // u32
  buf.writeBigUInt64LE(BigInt(payout), o); o += 8;     // u64
  buf.writeUInt8(ed25519InstrIndex & 0xff, o++);       // u8
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

// ---------- Provably-fair crash point (FIXED) ----------
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
  const h = crypto.createHmac("sha256", serverSeed)
    .update(String(clientSeed || ""))
    .update(Buffer.from(String(nonce)))
    .digest();

  // uniform in [0,1): take 53 random bits from the first 8 bytes
  const n64 = u64From(h.subarray(0, 8));
  const r = Number((n64 >> 11n)) / Math.pow(2, 53);  // 53-bit mantissa
  const edge = 0.99; // 1% house edge => typical median ~1.4-1.6x (looks like your earlier runs)
  const m = Math.max(1.01, edge / (1 - Math.min(0.999999999999, r)));
  return Math.min(m, 10000); // hard cap for sanity
}

function multiplierAt(startMs) {
  const speed = Number(process.env.CRASH_SPEED_MS || 3500);
  const elapsed = Math.max(0, Date.now() - startMs);
  return 1 + Math.pow(elapsed / speed, 1.35);
}
function toBps(m) { return Math.floor(m * 10000); }

// little number helpers
function u64le(n) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n), 0); return b; }
function i64le(n) { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(n), 0); return b; }
function u32le(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0, 0); return b; }

function pendingPdaFor(playerPk, nonce) {
  const nb = Buffer.alloc(8); nb.writeBigUInt64LE(BigInt(nonce));
  return PublicKey.findProgramAddressSync(
    [Buffer.from("round"), playerPk.toBuffer(), nb],
    CRASH_PROGRAM_ID
  )[0];
}

// server fee-payer (used only for resolve; lock remains user-paid)
function feePayer() {
  const keyPath =
    process.env.SOLANA_KEYPAIR ||
    process.env.ANCHOR_WALLET ||
    path.join(os.homedir(), ".config/solana/id.json");
  const sk = Uint8Array.from(JSON.parse(fs.readFileSync(keyPath, "utf8")));
  return Keypair.fromSecretKey(sk);
}

// ---------- Rounds (per socket) ----------
const rounds = new Map(); // nonce -> { playerPk, betLamports, startTs, crashed, cashed, crashAtMul, timer, clientSeed, serverSeed }

// ---- SEND resolve from the SERVER (no 2nd Phantom popup) ----
async function sendResolveTx({ ctx, nonce, cashoutMultiplier }) {
  const playerPk = ctx.playerPk;
  const vaultPda = deriveVaultPda();
  const adminPda = deriveAdminPda();
  const pendingPda = pendingPdaFor(playerPk, nonce);

  const win = cashoutMultiplier != null;
  const checksum = win ? 1 : 100;

  let payout = 0;
  let multBps = 10_000; // 1.00x
  if (win) {
    const m = Math.max(1, Number(cashoutMultiplier));
    multBps = toBps(m);
    const gross = (ctx.betLamports * BigInt(multBps)) / 10000n;
    const net = gross - ctx.betLamports; // net profit
    payout = Number(net > 0n ? net : 0n);
  }
  const expiryUnix = Math.floor(Date.now() / 1000) + Number(process.env.NONCE_TTL_SECONDS || 300);

  // canonical message (your program checks presence of ed25519, but we sign a stable message anyway)
  const msg = Buffer.concat([
    Buffer.from("CRASH_V1"),
    CRASH_PROGRAM_ID.toBuffer(),
    vaultPda.toBuffer(),
    playerPk.toBuffer(),
    u64le(ctx.betLamports),     // bet_amount
    u32le(multBps),             // multiplier_bps
    u64le(BigInt(payout)),      // payout
    u64le(BigInt(nonce)),       // nonce
    i64le(BigInt(expiryUnix)),  // expiry
  ]);
  const edSig = await signMessageEd25519(msg);
  const edIx = buildEd25519VerifyIx({ message: msg, signature: edSig, publicKey: ADMIN_PK });
  const edIndex = 1; // [0] CU, [1] ed25519, [2] resolve

  const dataResolve = encodeResolveArgs({
    checksum,
    multiplierBps: multBps,
    payout,
    ed25519InstrIndex: edIndex,
  });
  const keysResolve = resolveKeys({
    player: playerPk,
    vaultPda,
    adminPda,
    pendingPda,
  });
  const ixResolve = { programId: CRASH_PROGRAM_ID, keys: keysResolve, data: dataResolve };

  const payer = feePayer(); // SERVER pays fees & signs
  const cuLimit = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const msgV0 = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions: [cuLimit, edIx, ixResolve],
  }).compileToV0Message();

  const vtx = new VersionedTransaction(msgV0);
  vtx.sign([payer]);
  const txSig = await connection.sendRawTransaction(vtx.serialize(), {
    skipPreflight: false,
    maxRetries: 5,
  });
  await connection.confirmTransaction(txSig, "confirmed");

  return { txSig, multBps, payout };
}

// ---------- Attach WS ----------
function attachCrash(io) {
  io.on("connection", (socket) => {
    socket.on("register", ({ player }) => { socket.data.player = String(player || "guest"); });

    // STEP 1: prepare lock (client signs & sends — one popup)
    socket.on("crash:prepare_lock", async ({ player, betAmountLamports, clientSeed }) => {
      try {
        if (!player) return socket.emit("crash:error", { code: "NO_PLAYER", message: "player required" });
        const betLamports = BigInt(betAmountLamports || 0);
        if (betLamports <= 0n) {
          return socket.emit("crash:error", { code: "BAD_BET", message: "betAmountLamports invalid" });
        }

        const playerPk = new PublicKey(player);
        const vaultPda = deriveVaultPda();

        const nonce = Date.now();
        const expiryUnix = Math.floor(Date.now() / 1000) + Number(process.env.NONCE_TTL_SECONDS || 300);

        const nonceBuf = Buffer.alloc(8); nonceBuf.writeBigUInt64LE(BigInt(nonce));
        const pendingPda = PublicKey.findProgramAddressSync(
          [Buffer.from("round"), playerPk.toBuffer(), nonceBuf],
          CRASH_PROGRAM_ID
        )[0];

        const dataLock = encodeLockArgs({ betAmount: betLamports, nonce, expiryUnix });
        const keysLock = lockKeys({ player: playerPk, vaultPda, pendingPda });
        const ixLock = { programId: CRASH_PROGRAM_ID, keys: keysLock, data: dataLock };
        const cuLimit = ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 });

        const { blockhash } = await connection.getLatestBlockhash("confirmed");
        const msgV0 = new TransactionMessage({
          payerKey: playerPk,
          recentBlockhash: blockhash,
          instructions: [cuLimit, ixLock],
        }).compileToV0Message();

        const vtx = new VersionedTransaction(msgV0);
        const txBase64 = Buffer.from(vtx.serialize()).toString("base64");

        // round context (starts after lock confirmation)
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

    // Start the round after client confirms the lock tx
    socket.on("crash:lock_confirmed", ({ player, nonce }) => {
      const ctx = rounds.get(Number(nonce));
      if (!ctx) return socket.emit("crash:error", { code: "NOT_FOUND", message: "no round" });

      ctx.startTs = Date.now();
      ctx.crashAtMul = deriveCrashPoint({
        serverSeed: ctx.serverSeed,
        clientSeed: ctx.clientSeed,
        nonce: Number(nonce),
      });

      const tickMs = 75;
      ctx.timer = setInterval(() => {
        if (ctx.cashed || ctx.crashed) return;
        const m = multiplierAt(ctx.startTs);
        if (m >= ctx.crashAtMul) {
          ctx.crashed = true;
          clearInterval(ctx.timer);
          socket.emit("crash:crashed", { nonce: String(nonce), finalMultiplier: ctx.crashAtMul });

          // LOSS resolve (server-sent)
          sendResolveTx({ ctx, nonce: Number(nonce), cashoutMultiplier: null })
            .then(({ txSig, multBps, payout }) => {
              io.emit("crash:resolved", {
                nonce: String(nonce),
                multiplierBps: multBps,
                payoutLamports: String(payout),
                tx: txSig,
              });
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

    // Cashout request from client — SERVER submits resolve
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

        const { txSig, multBps, payout } = await sendResolveTx({
          ctx,
          nonce: Number(nonce),
          cashoutMultiplier: m,
        });

        io.emit("crash:resolved", {
          nonce: String(nonce),
          multiplierBps: multBps,
          payoutLamports: String(payout),
          tx: txSig,
        });
      } catch (e) {
        console.error("crash:cashout error:", e);
        socket.emit("crash:error", { code: "CASHOUT_FAIL", message: String(e.message || e) });
      }
    });
  });
}

module.exports = { attachCrash };
