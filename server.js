
require("dotenv").config();

const http = require("http");
const { Server } = require("socket.io");
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const crypto = require("crypto");

const {
  Connection,
  PublicKey,
  VersionedTransaction,
  TransactionMessage,
  SystemProgram,
  ComputeBudgetProgram,
} = require("@solana/web3.js");


const { deriveVaultPda, deriveAdminPda, buildEd25519VerifyIx } = require("./solana");
const { roll1to100 } = require("./rng");
const { ADMIN_PK, buildMessageBytes, signMessageEd25519 } = require("./signer");


const CLUSTER = process.env.CLUSTER || "https://api.devnet.solana.com";


if (!process.env.PROGRAM_ID) throw new Error("PROGRAM_ID missing in .env");
const PROGRAM_ID = new PublicKey(process.env.PROGRAM_ID);


const CRASH_PROGRAM_ID =
  process.env.CRASH_PROGRAM_ID ||
  process.env.NEXT_PUBLIC_CRASH_PROGRAM_ID ||
  "";

const PLINKO_PROGRAM_ID =
  process.env.PLINKO_PROGRAM_ID ||
  process.env.NEXT_PUBLIC_PLINKO_PROGRAM_ID ||
  "";


const connection = new Connection(CLUSTER, "confirmed");


let db;
try {
  db = require("./db");
} catch {
  db = {};
}
global.db = db;


function anchorDisc(globalSnakeName) {
  return crypto.createHash("sha256").update(`global:${globalSnakeName}`).digest().slice(0, 8);
}


function encodePlaceBetLockArgs({ betAmount, betType, target, nonce, expiryUnix }) {
  const disc = anchorDisc("place_bet_lock");
  const buf = Buffer.alloc(8 + 8 + 1 + 1 + 8 + 8);
  let o = 0;
  disc.copy(buf, o); o += 8;
  buf.writeBigUInt64LE(BigInt(betAmount), o); o += 8;
  buf.writeUInt8(betType & 0xff, o++);      // u8
  buf.writeUInt8(target & 0xff, o++);       // u8
  buf.writeBigUInt64LE(BigInt(nonce), o); o += 8;
  buf.writeBigInt64LE(BigInt(expiryUnix), o); o += 8;
  return buf;
}


function encodeResolveBetArgs({ roll, payout, ed25519InstrIndex }) {
  const disc = anchorDisc("resolve_bet");
  const buf = Buffer.alloc(8 + 1 + 8 + 1);
  let o = 0;
  disc.copy(buf, o); o += 8;
  buf.writeUInt8(roll & 0xff, o++);                 // u8
  buf.writeBigUInt64LE(BigInt(payout), o); o += 8;  // u64
  buf.writeUInt8(ed25519InstrIndex & 0xff, o++);    // u8
  return buf;
}

const SYSVAR_INSTRUCTIONS_PUBKEY = new PublicKey(
  "Sysvar1nstructions1111111111111111111111111"
);

function placeBetLockKeys({ player, vaultPda, pendingBetPda }) {
  return [
    { pubkey: player, isSigner: true, isWritable: true },
    { pubkey: vaultPda, isSigner: false, isWritable: true },
    { pubkey: pendingBetPda, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];
}
function resolveBetKeys({ player, vaultPda, adminPda, pendingBetPda }) {
  return [
    { pubkey: player, isSigner: false, isWritable: true },
    { pubkey: vaultPda, isSigner: false, isWritable: true },
    { pubkey: adminPda, isSigner: false, isWritable: false },
    { pubkey: pendingBetPda, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
  ];
}


const app = express();

// CORS (allow multiple origins via comma-separated env, else *)
const ALLOW_ORIGINS = (process.env.ALLOW_ORIGINS || "*")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: ALLOW_ORIGINS.length === 1 && ALLOW_ORIGINS[0] === "*" ? "*" : ALLOW_ORIGINS,
    methods: ["GET", "POST", "OPTIONS"],
    credentials: false,
  })
);
app.use(bodyParser.json());


app.get("/health", (_req, res) => {
  res.json({ ok: true, cluster: CLUSTER, programId: PROGRAM_ID.toBase58() });
});


app.get("/health/all", (_req, res) => {
  res.json({
    ok: true,
    cluster: CLUSTER,
    dice_program: PROGRAM_ID.toBase58(),
    crash_program: CRASH_PROGRAM_ID || null,
    plinko_program: PLINKO_PROGRAM_ID || null,
  });
});


app.get("/rules", async (_req, res) => {
  try {
    let rules = { rtp_bps: 9900, min_bet_lamports: 50000, max_bet_lamports: 5000000000 };
    if (db.getRules) rules = await db.getRules();
    res.json({
      rtp: Number(rules.rtp_bps) / 100,
      minBetSol: Number(rules.min_bet_lamports) / 1e9,
      maxBetSol: Number(rules.max_bet_lamports) / 1e9,
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});


app.post("/bets/deposit_prepare", async (req, res) => {
  try {
    const { player, betAmountLamports, betType, targetNumber } = req.body || {};
    if (!player) return res.status(400).json({ error: "player required" });
    if (betAmountLamports == null || betType == null || targetNumber == null) {
      return res.status(400).json({ error: "betAmountLamports, betType, targetNumber required" });
    }
    if (!["over", "under"].includes(betType)) {
      return res.status(400).json({ error: "betType must be 'over' or 'under'" });
    }

    const playerPk = new PublicKey(player);
    const betTypeNum = betType === "over" ? 1 : 0;


    let rtp_bps = 9900;
    let min_bet_lamports = 50000n;
    let max_bet_lamports = 5000000000n;
    if (db.getRules) {
      const rules = await db.getRules();
      rtp_bps = rules.rtp_bps || rtp_bps;
      min_bet_lamports = BigInt(rules.min_bet_lamports || min_bet_lamports);
      max_bet_lamports = BigInt(rules.max_bet_lamports || max_bet_lamports);
    }

    const betAmt = BigInt(betAmountLamports);
    if (betAmt < min_bet_lamports || betAmt > max_bet_lamports) {
      return res.status(400).json({ error: "Bet amount out of allowed range" });
    }
    if (targetNumber < 2 || targetNumber > 98) {
      return res.status(400).json({ error: "Target number must be between 2 and 98" });
    }

    const nonce = BigInt(Date.now());
    const expiryUnix = BigInt(Math.floor(Date.now() / 1000) + Number(process.env.NONCE_TTL_SECONDS || 300));

    const vaultPda = deriveVaultPda();
    const pendingBetSeed = Buffer.alloc(8); pendingBetSeed.writeBigUInt64LE(nonce);
    const pendingBetPda = PublicKey.findProgramAddressSync(
      [Buffer.from("bet"), playerPk.toBuffer(), pendingBetSeed],
      PROGRAM_ID
    )[0];


    const data = encodePlaceBetLockArgs({
      betAmount: betAmountLamports,
      betType: betTypeNum,
      target: targetNumber,
      nonce: Number(nonce),
      expiryUnix: Number(expiryUnix),
    });
    const keys = placeBetLockKeys({ player: playerPk, vaultPda, pendingBetPda });
    const programIx = { programId: PROGRAM_ID, keys, data };

    const cuPriceIx = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 });
    const cuLimitIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });

    const { blockhash } = await connection.getLatestBlockhash("confirmed");
    const msgV0 = new TransactionMessage({
      payerKey: playerPk,
      recentBlockhash: blockhash,
      instructions: [cuPriceIx, cuLimitIx, programIx],
    }).compileToV0Message();

    const vtx = new VersionedTransaction(msgV0);
    const txBase64 = Buffer.from(vtx.serialize()).toString("base64");

    try {
      await db.recordBet?.({
        player: playerPk.toBase58(),
        amount: betAmountLamports,
        betType: betTypeNum,
        target: targetNumber,
        roll: 0,
        payout: 0,
        nonce: Number(nonce),
        expiry: Number(expiryUnix),
        signature_base58: "",
      });
    } catch (e) {
      console.error("DB record error:", e);
    }

    res.json({
      nonce: String(nonce),
      expiryUnix: Number(expiryUnix),
      transactionBase64: txBase64,
    });
  } catch (e) {
    console.error("deposit_prepare error:", e);
    res.status(500).json({ error: String(e.message || e) });
  }
});


app.post("/bets/resolve_prepare", async (req, res) => {
  try {
    const { player, nonce: nonceStr } = req.body || {};
    if (!player) return res.status(400).json({ error: "player required" });
    if (nonceStr == null) return res.status(400).json({ error: "nonce required" });

    const playerPk = new PublicKey(player);
    const vaultPda = deriveVaultPda();
    const adminPda = deriveAdminPda();

    const nonce = BigInt(nonceStr);
    const lastBet = db.getBetByNonce ? await db.getBetByNonce(Number(nonce)) : null;
    const amount = lastBet ? Number(lastBet.bet_amount_lamports) : null;
    const betTypeNum = lastBet ? Number(lastBet.bet_type) : null;
    const targetNumber = lastBet ? Number(lastBet.target) : null;
    if (amount == null || betTypeNum == null || targetNumber == null) {
      return res.status(400).json({ error: "Backend missing bet context for this nonce" });
    }

    let rtp_bps = 9900;
    if (db.getRules) {
      const rules = await db.getRules();
      rtp_bps = rules.rtp_bps || rtp_bps;
    }

    // RNG + payout
    const roll = roll1to100();
    const win_odds = betTypeNum === 0 ? targetNumber - 1 : 100 - targetNumber;
    if (win_odds < 1 || win_odds > 99) {
      return res.status(400).json({ error: "Invalid win odds based on target" });
    }
    const win = betTypeNum === 0 ? roll < targetNumber : roll > targetNumber;
    const payoutLamports = win
      ? Number((BigInt(amount) * BigInt(rtp_bps)) / (100n * BigInt(win_odds)))
      : 0;

    const expiryUnix = Math.floor(Date.now() / 1000) + Number(process.env.NONCE_TTL_SECONDS || 300);

    // canonical message to be verified on-chain via ed25519 pre-instruction
    const msg = buildMessageBytes({
      programId: PROGRAM_ID.toBuffer(),
      vault: vaultPda.toBuffer(),
      player: playerPk.toBuffer(),
      betAmount: amount,
      betType: betTypeNum,
      target: targetNumber,
      roll,
      payout: payoutLamports,
      nonce: Number(nonce),
      expiryUnix: Number(expiryUnix),
    });

    const signature = await signMessageEd25519(msg);

    // ed25519 verify ix
    const edIx = buildEd25519VerifyIx({ message: msg, signature, publicKey: ADMIN_PK });
    const edIndex = 2; // CU price=0, CU limit=1, ed25519=2, resolve=3

    // build resolve_bet ix
    const pendingBetSeed = Buffer.alloc(8); pendingBetSeed.writeBigUInt64LE(nonce);
    const pendingBetPda = PublicKey.findProgramAddressSync(
      [Buffer.from("bet"), playerPk.toBuffer(), pendingBetSeed],
      PROGRAM_ID
    )[0];

    const data = encodeResolveBetArgs({ roll, payout: payoutLamports, ed25519InstrIndex: edIndex });
    const keys = resolveBetKeys({ player: playerPk, vaultPda, adminPda, pendingBetPda });
    const programIx = { programId: PROGRAM_ID, keys, data };

    // CU ixs at the front
    const cuPriceIx = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 });
    const cuLimitIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });

    const { blockhash } = await connection.getLatestBlockhash("confirmed");
    const msgV0 = new TransactionMessage({
      payerKey: playerPk,
      recentBlockhash: blockhash,
      instructions: [cuPriceIx, cuLimitIx, edIx, programIx],
    }).compileToV0Message();

    const vtx = new VersionedTransaction(msgV0);
    const txBase64 = Buffer.from(vtx.serialize()).toString("base64");

    // optional DB update
    try {
      await db.updateBetPrepared?.({
        nonce: Number(nonce),
        roll,
        payout: payoutLamports,
      });
    } catch (e) {
      console.error("DB update error:", e);
    }

    res.json({
      roll,
      win,
      payoutLamports: String(payoutLamports),
      nonce: String(nonce),
      expiryUnix: Number(expiryUnix),
      transactionBase64: txBase64,
    });
  } catch (e) {
    console.error("resolve_prepare error:", e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ---- HTTP server + Socket.IO ----
const PORT = Number(process.env.PORT || 4000);
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin:
      ALLOW_ORIGINS.length === 1 && ALLOW_ORIGINS[0] === "*"
        ? "*"
        : ALLOW_ORIGINS,
    methods: ["GET", "POST"],
  },
});

// Helper: mount WS module defensively (supports both default export or { attachX })
function mountWs(modulePath, name, attachName, io) {
  try {
    const mod = require(modulePath);
    const fn =
      typeof mod === "function"
        ? mod
        : typeof mod?.[attachName] === "function"
        ? mod[attachName]
        : null;

    if (fn) {
      fn(io);
      console.log(`${name} WS mounted`);
    } else {
      console.warn(`${name} WS not found / failed to mount: ${attachName} is not a function`);
    }
  } catch (e) {
    console.warn(`${name} WS not found / failed to mount:`, e?.message || e);
  }
}

// Slots WS (uses your dice program rails)
mountWs("./slots_ws", "Slots", "attachSlots", io);

// Crash WS (separate crash program)
mountWs("./crash_ws", "Crash", "attachCrash", io);

// ---- Slots WS ----
try {
  const slotsPath = require.resolve(__dirname + "/slots_ws.js");
  const slots = require(slotsPath);
  slots.attachSlots(io);
  console.log("Slots WS mounted from", slotsPath);
} catch (e) {
  console.error("slots_ws not found / failed to mount:", e);
}


// Crash WS (separate crash program, uses CRASH_PROGRAM_ID internally)
try {
  require("./crash_ws").attachCrash(io);
  console.log("Crash WS mounted");
} catch (e) {
  console.warn("crash_ws not found / failed to mount:", e?.message || e);
}

// Plinko WS (separate plinko program)
mountWs("./plinko_ws", "Plinko", "attachPlinko", io);

server.listen(PORT, () => {
  console.log(
    `api up on :${PORT} (cluster=${CLUSTER}, dice_program=${PROGRAM_ID.toBase58()}, crash_program=${CRASH_PROGRAM_ID || "—"}, plinko_program=${PLINKO_PROGRAM_ID || "—"})`
  );
});
