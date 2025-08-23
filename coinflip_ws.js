// backend/coinflip_ws.js
// 2-player coinflip with server-paid resolve (single wallet popup per human).
// Matches by stake. Prefers opposite sides; if both humans pick the SAME side,
// we still match them and pick a winner by RNG. If no opponent in 10s, a bot joins.

const crypto = require("crypto");
const {
  Connection,
  PublicKey,
  VersionedTransaction,
  TransactionMessage,
  SystemProgram,
  ComputeBudgetProgram,
} = require("@solana/web3.js");

const { ADMIN_PK, signMessageEd25519, getServerKeypair } = require("./signer");
const sol = require("./solana");

// ----- ENV / Program IDs -----
const RPC_URL = process.env.CLUSTER || "https://api.devnet.solana.com";
const COINFLIP_PROGRAM_ID = new PublicKey(
  process.env.COINFLIP_PROGRAM_ID ||
    process.env.NEXT_PUBLIC_COINFLIP_PROGRAM_ID ||
    (() => {
      throw new Error("COINFLIP_PROGRAM_ID missing in .env");
    })()
);

const LOCK_IX = process.env.COINFLIP_LOCK_IX_NAME || "lock";
const RES_IX  = process.env.COINFLIP_RESOLVE_IX_NAME || "resolve";
const FEE_BPS = Number(process.env.COINFLIP_FEE_BPS || 600);           // 6%
const QUEUE_TTL_MS = Number(process.env.COINFLIP_QUEUE_TTL_MS || 10000);
const PENDING_SEED = String(process.env.COINFLIP_PENDING_SEED || "match");

// Common sysvars
const SYSVAR_INSTR = new PublicKey("Sysvar1nstructions1111111111111111111111111");
const SYSVAR_CLOCK = new PublicKey("SysvarC1ock11111111111111111111111111111111");
const SYSVAR_RENT  = new PublicKey("SysvarRent111111111111111111111111111111111");

// Connection (reuse shared if available)
const connection = sol?.connection instanceof Connection
  ? sol.connection
  : new Connection(RPC_URL, "confirmed");

const buildEd25519VerifyIx = sol.buildEd25519VerifyIx;

// ----- PDA helpers -----
function deriveVaultPda() {
  return PublicKey.findProgramAddressSync([Buffer.from("vault")], COINFLIP_PROGRAM_ID)[0];
}
function deriveAdminPda() {
  return PublicKey.findProgramAddressSync([Buffer.from("admin")], COINFLIP_PROGRAM_ID)[0];
}
function derivePendingPda(player, nonce) {
  const nb = Buffer.alloc(8); nb.writeBigUInt64LE(BigInt(nonce));
  return PublicKey.findProgramAddressSync(
    [Buffer.from(PENDING_SEED), player.toBuffer(), nb],
    COINFLIP_PROGRAM_ID
  )[0];
}

// ----- Anchor discriminators & arg encoders -----
const disc = (name) =>
  crypto.createHash("sha256").update(`global:${name}`).digest().slice(0, 8);

// LockArgs (example): [u64 entry_lamports][u8 side][u64 nonce][i64 expiry]
function encLockArgs({ entryLamports, side, nonce, expiryUnix }) {
  const d = disc(LOCK_IX);
  const b = Buffer.alloc(8 + 8 + 1 + 8 + 8);
  let o = 0;
  d.copy(b, o); o += 8;
  b.writeBigUInt64LE(BigInt(entryLamports), o); o += 8;  // entry
  b.writeUInt8((side ?? 0) & 0xff, o++);                 // 0=heads,1=tails
  b.writeBigUInt64LE(BigInt(nonce), o); o += 8;          // nonce
  b.writeBigInt64LE(BigInt(expiryUnix), o); o += 8;      // expiry
  return b;
}

// ResolveArgs: [u8 checksum][u64 payout][u8 ed_index][u8 winner_side]
function encResolveArgs({ checksum, payout, edIndex, winnerSide }) {
  const d = disc(RES_IX);
  const b = Buffer.alloc(8 + 1 + 8 + 1 + 1);
  let o = 0;
  d.copy(b, o); o += 8;
  b.writeUInt8(checksum & 0xff, o++);                    // checksum
  b.writeBigUInt64LE(BigInt(payout), o); o += 8;         // payout
  b.writeUInt8(edIndex & 0xff, o++);                     // ed idx
  b.writeUInt8((winnerSide ?? 0) & 0xff, o++);           // 0=heads 1=tails
  return b;
}

// Account metas — a few variants to match different programs.
function makeResolveLayouts({ player, vault, adminPda, adminAuth, pending }) {
  const base = [
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_INSTR,            isSigner: false, isWritable: false },
    { pubkey: SYSVAR_CLOCK,            isSigner: false, isWritable: false },
    { pubkey: SYSVAR_RENT,             isSigner: false, isWritable: false },
  ];
  return [
    // 0) [player, vault, pending, sysvars]  <-- NO admin PDA at all
    [
      { pubkey: player,  isSigner: false, isWritable: true },
      { pubkey: vault,   isSigner: false, isWritable: true },
      { pubkey: pending, isSigner: false, isWritable: true },
      ...base,
    ],
    // 1) [player, vault, admin_pda, pending, sysvars]
    [
      { pubkey: player,  isSigner: false, isWritable: true },
      { pubkey: vault,   isSigner: false, isWritable: true },
      { pubkey: adminPda,isSigner: false, isWritable: false },
      { pubkey: pending, isSigner: false, isWritable: true },
      ...base,
    ],
    // 2) [player, vault, admin_pda, admin_auth, pending, sysvars]
    [
      { pubkey: player,  isSigner: false, isWritable: true },
      { pubkey: vault,   isSigner: false, isWritable: true },
      { pubkey: adminPda,isSigner: false, isWritable: false },
      { pubkey: adminAuth,isSigner:false, isWritable: false },
      { pubkey: pending, isSigner: false, isWritable: true },
      ...base,
    ],
  ];
}

// helpers
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// fair randomness (HMAC over both client seeds and server seed)
function deriveOutcome({ serverSeed, clientSeedA, clientSeedB, nonce }) {
  const h = crypto
    .createHmac("sha256", serverSeed)
    .update(String(clientSeedA || ""))
    .update("|")
    .update(String(clientSeedB || ""))
    .update("|")
    .update(Buffer.from(String(nonce)))
    .digest();
  return h[0] & 1; // 0=heads, 1=tails
}

// ---------- Build user-paid lock (returns b64 tx) ----------
async function buildLockTx({ playerPk, entryLamports, side, nonce, expiryUnix }) {
  const vault   = deriveVaultPda();
  const pending = derivePendingPda(playerPk, nonce);

  const ix = {
    programId: COINFLIP_PROGRAM_ID,
    keys: [
      { pubkey: playerPk, isSigner: true,  isWritable: true },
      { pubkey: vault,    isSigner: false, isWritable: true },
      { pubkey: pending,  isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: encLockArgs({ entryLamports, side, nonce, expiryUnix }),
  };

  const cu = ComputeBudgetProgram.setComputeUnitLimit({ units: 250_000 });
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({
    payerKey: playerPk,
    recentBlockhash: blockhash,
    instructions: [cu, ix],
  }).compileToV0Message();

  const vtx = new VersionedTransaction(msg);

  // simulate: allow "insufficient lamports", block ABI mismatch
  const sim = await connection.simulateTransaction(vtx, { sigVerify: false });
  if (sim.value.err) {
    const logs = (sim.value.logs || []).join("\n");
    const errStr = JSON.stringify(sim.value.err);
    const abiErr =
      logs.includes("InstructionFallbackNotFound") ||
      logs.includes("Fallback functions are not supported");
    if (abiErr) throw new Error(`LOCK discriminator mismatch (${LOCK_IX})\n${logs}`);
    const fundsErr = logs.includes("Transfer: insufficient lamports") || errStr.includes('"Custom":1');
    if (!fundsErr) throw new Error(`LOCK simulate failed: ${errStr}\n${logs}`);
  }

  return {
    pending: pending.toBase58(),
    txBase64: Buffer.from(vtx.serialize()).toString("base64"),
  };
}

// ---------- Server-signed lock for BOT (sends on-chain immediately) ----------
async function sendBotLockTx({ bot, entryLamports, side, nonce, expiryUnix }) {
  const playerPk = bot.publicKey;
  const vault   = deriveVaultPda();
  const pending = derivePendingPda(playerPk, nonce);

  const ix = {
    programId: COINFLIP_PROGRAM_ID,
    keys: [
      { pubkey: playerPk, isSigner: true,  isWritable: true },
      { pubkey: vault,    isSigner: false, isWritable: true },
      { pubkey: pending,  isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: encLockArgs({ entryLamports, side, nonce, expiryUnix }),
  };

  const cu = ComputeBudgetProgram.setComputeUnitLimit({ units: 250_000 });
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({
    payerKey: bot.publicKey,
    recentBlockhash: blockhash,
    instructions: [cu, ix],
  }).compileToV0Message();

  const vtx = new VersionedTransaction(msg);

  // For bot: do not ignore insufficient lamports
  const sim = await connection.simulateTransaction(vtx, { sigVerify: false });
  if (sim.value.err) {
    const logs = (sim.value.logs || []).join("\n");
    throw new Error(`BOT LOCK simulate failed: ${JSON.stringify(sim.value.err)}\n${logs}`);
  }

  vtx.sign([bot]);
  const sig = await connection.sendRawTransaction(vtx.serialize(), {
    skipPreflight: false,
    maxRetries: 5,
  });
  await connection.confirmTransaction(sig, "confirmed");

  return {
    pending: pending.toBase58(),
    txSig: sig,
  };
}

// ---------- Resolve (server-paid) for one player ----------
async function sendResolve({ playerPk, pending, payoutLamports, nonce, winnerSide }) {
  const vault     = deriveVaultPda();
  const adminPda  = deriveAdminPda();          // may not exist; we try several layouts
  const adminAuth = ADMIN_PK;                  // ed25519 pubkey (not system account)
  const feePayer  = await getServerKeypair();

  const msgBuf = Buffer.concat([
    Buffer.from("COINFLIP_V1"),
    COINFLIP_PROGRAM_ID.toBuffer(),
    vault.toBuffer(),
    playerPk.toBuffer(),
    Buffer.from(String(nonce)),
  ]);
  const edSig = await signMessageEd25519(msgBuf);
  const edIx  = buildEd25519VerifyIx({
    publicKey: ADMIN_PK,
    message: msgBuf,
    signature: edSig,
  });
  const edIndex = 1;

  const data = encResolveArgs({
    checksum: (Number(nonce) % 251) + 1,
    payout: Number(payoutLamports),
    edIndex,
    winnerSide: Number(winnerSide ?? 0),
  });

  const layouts = makeResolveLayouts({
    player: playerPk,
    vault,
    adminPda,
    adminAuth,
    pending: new PublicKey(pending),
  });

  const cu = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });
  const { blockhash } = await connection.getLatestBlockhash("confirmed");

  let lastErr = null;
  for (let i = 0; i < layouts.length; i++) {
    try {
      const ix = { programId: COINFLIP_PROGRAM_ID, keys: layouts[i], data };
      const msg = new TransactionMessage({
        payerKey: feePayer.publicKey,
        recentBlockhash: blockhash,
        instructions: [cu, edIx, ix],
      }).compileToV0Message();

      const vtx = new VersionedTransaction(msg);

      const sim = await connection.simulateTransaction(vtx, { sigVerify: false });
      if (sim.value.err) {
        const logs = (sim.value.logs || []).join("\n");
        lastErr = new Error(
          `coinflip resolve layout[${i}] simulate failed: ${JSON.stringify(sim.value.err)}\n${logs}`
        );
        continue;
      }
      vtx.sign([feePayer]);
      const sig = await connection.sendRawTransaction(vtx.serialize(), {
        skipPreflight: false,
        maxRetries: 5,
      });
      await connection.confirmTransaction(sig, "confirmed");
      return sig;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("all resolve layouts failed");
}

// ---------------- Matchmaking ----------------
const waiting = []; // queue of { socketId, playerPk, entryLamports, side, clientSeed, tExpire, timer }
const rooms = new Map(); // nonce -> { A, B, entryLamports, readyA, readyB, pendingA, pendingB, serverSeed, sameSide }

// make a room with two participants (human or bot)
async function createRoom(io, A, B) {
  const nonce = Date.now();
  const expiryUnix = Math.floor(Date.now() / 1000) + Number(process.env.NONCE_TTL_SECONDS || 300);
  const serverSeed = crypto.randomBytes(32);

  const entryLamports = BigInt(A.entryLamports);

  // A & B may be bot/human; normalize
  const AA = { ...A, playerPk: new PublicKey(A.playerPk) };
  const BB = { ...B, playerPk: new PublicKey(B.playerPk) };

  rooms.set(nonce, {
    A: { socketId: AA.socketId, playerPk: AA.playerPk, side: Number(AA.side), clientSeed: String(AA.clientSeed || "") },
    B: { socketId: BB.socketId, playerPk: BB.playerPk, side: Number(BB.side), clientSeed: String(BB.clientSeed || "") },
    entryLamports,
    readyA: false,
    readyB: false,
    pendingA: null,
    pendingB: null,
    serverSeed,
    sameSide: Number(AA.side) === Number(BB.side),
  });

  // Build locks
  const builtA = await buildLockTx({
    playerPk: AA.playerPk,
    entryLamports,
    side: Number(AA.side),
    nonce,
    expiryUnix,
  });

  let builtB;
  if (BB.isBot) {
    // bot locks immediately on-chain
    const bot = await getServerKeypair();
    const sent = await sendBotLockTx({
      bot,
      entryLamports,
      side: Number(BB.side),
      nonce,
      expiryUnix,
    });
    rooms.get(nonce).pendingB = sent.pending;
    rooms.get(nonce).readyB = true; // bot already locked
  } else {
    builtB = await buildLockTx({
      playerPk: BB.playerPk,
      entryLamports,
      side: Number(BB.side),
      nonce,
      expiryUnix,
    });
  }

  rooms.get(nonce).pendingA = builtA.pending;
  if (builtB) rooms.get(nonce).pendingB = builtB.pending;

  // send lock to humans
  if (!AA.isBot) {
    io.to(AA.socketId).emit("coinflip:lock_tx", {
      nonce: String(nonce),
      expiryUnix,
      transactionBase64: builtA.txBase64,
      role: "A",
    });
    io.to(AA.socketId).emit("coinflip:matched", {
      nonce: String(nonce),
      you: AA.side === 0 ? "heads" : "tails",
      opponentSide: BB.side,
      opponent: BB.isBot ? "bot" : "human",
    });
  }

  if (!BB?.isBot) {
    io.to(BB.socketId).emit("coinflip:lock_tx", {
      nonce: String(nonce),
      expiryUnix,
      transactionBase64: builtB.txBase64,
      role: "B",
    });
    io.to(BB.socketId).emit("coinflip:matched", {
      nonce: String(nonce),
      you: BB.side === 0 ? "heads" : "tails",
      opponentSide: AA.side,
      opponent: AA.isBot ? "bot" : "human",
    });
  }

  return nonce;
}

function attachCoinflip(io) {
  io.on("connection", (socket) => {
    socket.on("register", ({ player }) => { socket.data.player = String(player || "guest"); });

    socket.on("disconnect", () => {
      const idx = waiting.findIndex((w) => w.socketId === socket.id);
      if (idx >= 0) {
        const w = waiting[idx];
        clearTimeout(w.timer);
        waiting.splice(idx, 1);
      }
    });

    // player joins queue (side: 0=heads, 1=tails). match by stake; prefer opposite side.
    socket.on("coinflip:join", async ({ player, side, entryLamports, clientSeed }) => {
      try {
        if (!player) return socket.emit("coinflip:error", { code: "NO_PLAYER", message: "player required" });

        const playerPk = new PublicKey(player);
        const s = clamp(Number(side), 0, 1);
        const stake = BigInt(entryLamports || 0);
        if (!(stake > 0n)) {
          return socket.emit("coinflip:error", { code: "BAD_BET", message: "entryLamports must be > 0" });
        }

        // prefer an opposite-side opponent with same stake
        let oppIdx = waiting.findIndex(
          (w) => w.entryLamports === String(stake) && Number(w.side) !== s
        );

        // if not found, allow same-side match (your requirement: match even if both chose same side)
        if (oppIdx < 0) {
          oppIdx = waiting.findIndex(
            (w) => w.entryLamports === String(stake) && Number(w.side) === s
          );
        }

        if (oppIdx >= 0) {
          // pair now
          const opponent = waiting.splice(oppIdx, 1)[0];
          clearTimeout(opponent.timer);

          const A = {
            socketId: opponent.socketId,
            playerPk: opponent.playerPk,
            entryLamports: String(stake),
            side: Number(opponent.side),
            clientSeed: opponent.clientSeed,
          };
          const B = {
            socketId: socket.id,
            playerPk: playerPk.toBase58(),
            entryLamports: String(stake),
            side: s,
            clientSeed: String(clientSeed || ""),
          };

          await createRoom(io, A, B);
          return;
        }

        // enqueue and arm bot-after-10s
        const w = {
          socketId: socket.id,
          playerPk: playerPk.toBase58(),
          entryLamports: String(stake),
          side: s,
          clientSeed: String(clientSeed || ""),
          tExpire: Date.now() + QUEUE_TTL_MS,
          timer: null,
        };

        w.timer = setTimeout(async () => {
          // if still in queue -> bot joins with *opposite* side to ensure standard heads/tails mapping
          const idx = waiting.findIndex((x) => x === w);
          if (idx < 0) return; // already paired
          waiting.splice(idx, 1);

          const botSide = 1 - s; // opposite of the human's choice
          const A = {
            socketId: socket.id,
            playerPk: w.playerPk,
            entryLamports: String(stake),
            side: s,
            clientSeed: w.clientSeed,
          };
          const B = {
            socketId: null,
            playerPk: (await getServerKeypair()).publicKey.toBase58(),
            entryLamports: String(stake),
            side: botSide,
            clientSeed: "", // server seed drives fairness anyway
            isBot: true,
          };
          try {
            await createRoom(io, A, B);
          } catch (e) {
            io.to(socket.id).emit("coinflip:error", { code: "BOT_FAIL", message: String(e.message || e) });
          }
        }, QUEUE_TTL_MS);

        waiting.push(w);
        socket.emit("coinflip:queued", { side: s, entryLamports: String(stake) });
      } catch (e) {
        console.error("coinflip:join error:", e);
        socket.emit("coinflip:error", { code: "JOIN_FAIL", message: e.message || String(e) });
      }
    });

    // client confirmed lock on-chain
    socket.on("coinflip:lock_confirmed", ({ nonce }) => {
      const room = rooms.get(Number(nonce));
      if (!room) return socket.emit("coinflip:error", { code: "ROOM_MISSING", message: "no match" });

      if (socket.id === room.A.socketId) room.readyA = true;
      if (socket.id === room.B.socketId) room.readyB = true;

      if (room.readyA && room.readyB) {
        // Decide outcome
        const outcome = deriveOutcome({
          serverSeed: room.serverSeed,
          clientSeedA: room.A.clientSeed,
          clientSeedB: room.B.clientSeed,
          nonce: Number(nonce),
        }); // 0=heads,1=tails

        let winnerKey = null;
        if (room.sameSide) {
          // both chose the same side -> choose winner purely by RNG (0 => A wins, 1 => B wins)
          winnerKey = outcome === 0 ? "A" : "B";
        } else {
          // standard mapping: side 0=heads wins if outcome==0, side 1=tails wins if outcome==1
          winnerKey = (outcome === room.A.side) ? "A" : "B";
        }
        const loserKey = winnerKey === "A" ? "B" : "A";

        const totalPot = room.entryLamports * 2n;
        const fee = (totalPot * BigInt(FEE_BPS)) / 10000n;
        const payout = totalPot - fee;

        const winnerPlayer = room[winnerKey].playerPk;
        const loserPlayer  = room[loserKey].playerPk;

        const winnerPending = room[winnerKey === "A" ? "pendingA" : "pendingB"];
        const loserPending  = room[winnerKey === "A" ? "pendingB" : "pendingA"];

        // let both clients know we're flipping
        if (room.A.socketId) io.to(room.A.socketId).emit("coinflip:starting", { nonce: String(nonce), outcome });
        if (room.B.socketId) io.to(room.B.socketId).emit("coinflip:starting", { nonce: String(nonce), outcome });

        (async () => {
          try {
            const sigW = await sendResolve({
              playerPk: winnerPlayer,
              pending: winnerPending,
              payoutLamports: payout,
              nonce: Number(nonce),
              winnerSide: outcome,
            });
            const sigL = await sendResolve({
              playerPk: loserPlayer,
              pending: loserPending,
              payoutLamports: 0n,
              nonce: Number(nonce),
              winnerSide: outcome,
            });

            io.emit("coinflip:resolved", {
              nonce: String(nonce),
              outcome,                          // 0=heads,1=tails
              feeLamports: Number(fee),
              payoutLamports: Number(payout),   // winner payout (net of fee)
              txWinner: sigW,
              txLoser: sigL,
            });

            rooms.delete(Number(nonce));
          } catch (e) {
            console.error("coinflip resolve fail:", e);
            if (room.A.socketId) io.to(room.A.socketId).emit("coinflip:error", { code: "RESOLVE_FAIL", message: String(e.message || e) });
            if (room.B.socketId) io.to(room.B.socketId).emit("coinflip:error", { code: "RESOLVE_FAIL", message: String(e.message || e) });
          }
        })();
      }
    });
  });
}

module.exports = { attachCoinflip };
