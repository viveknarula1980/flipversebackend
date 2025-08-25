// backend/plinko_ws.js — STRICT resolver + DB gating/persistence

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

// ---------- RPC / Program ----------
const RPC_URL = process.env.CLUSTER || "https://api.devnet.solana.com";
const connection = new Connection(RPC_URL, "confirmed");
if (!process.env.PLINKO_PROGRAM_ID) throw new Error("PLINKO_PROGRAM_ID missing in .env");
const PROGRAM_ID = new PublicKey(process.env.PLINKO_PROGRAM_ID);

const LOCK_IX = process.env.PLINKO_LOCK_IX_NAME || "lock";
const RES_IX  = process.env.PLINKO_RESOLVE_IX_NAME || "resolve";
const SYSVAR_INSTR = new PublicKey("Sysvar1nstructions1111111111111111111111111");

// ---------- PDAs & helpers ----------
const pdaVault = () => PublicKey.findProgramAddressSync([Buffer.from("vault")], PROGRAM_ID)[0];
const pdaAdmin = () => PublicKey.findProgramAddressSync([Buffer.from("admin")], PROGRAM_ID)[0];
function pdaPending(playerPk, nonce) {
  const nb = Buffer.alloc(8); nb.writeBigUInt64LE(BigInt(nonce));
  return PublicKey.findProgramAddressSync([Buffer.from("bet"), playerPk.toBuffer(), nb], PROGRAM_ID)[0];
}
const disc = (name) => crypto.createHash("sha256").update(`global:${name}`).digest().slice(0, 8);

// ---------- Anchor arg encoders ----------
function encLock({ unitAmount, balls, rows, difficulty, nonce, expiryUnix }) {
  const d = disc(LOCK_IX);
  const b = Buffer.alloc(8 + 8 + 2 + 1 + 1 + 8 + 8);
  let o = 0;
  d.copy(b, o); o += 8;
  b.writeBigUInt64LE(BigInt(unitAmount), o); o += 8;
  b.writeUInt16LE(balls & 0xffff, o); o += 2;
  b.writeUInt8(rows & 0xff, o++); b.writeUInt8(difficulty & 0xff, o++);
  b.writeBigUInt64LE(BigInt(nonce), o); o += 8;
  b.writeBigInt64LE(BigInt(expiryUnix), o); o += 8;
  return b;
}
function encResolve({ checksum, payout, edIndex }) {
  const d = disc(RES_IX);
  const b = Buffer.alloc(8 + 1 + 8 + 1);
  let o = 0;
  d.copy(b, o); o += 8;
  b.writeUInt8(checksum & 0xff, o++); b.writeBigUInt64LE(BigInt(payout), o); o += 8; b.writeUInt8(edIndex & 0xff, o++);
  return b;
}

// ---------- odds/mults ----------
function rowOdds(rows) {
  const C = (n, k) => { if (k < 0 || k > n) return 0; let r = 1; for (let i = 1; i <= k; i++) r = (r * (n - (k - i))) / i; return r; };
  const d = 2 ** rows;
  return Array.from({ length: rows + 1 }, (_, k) => C(rows, k) / d);
}
const RISK_ALPHAS = [0.6, 0.8, 1.0, 1.3, 1.7];
function baseMultis(rows, riskIdx) {
  const slots = rows + 1, mid = rows / 2;
  const alpha = RISK_ALPHAS[riskIdx] ?? 1.0;
  const min = 0.4 + riskIdx * 0.08;
  const a = [];
  for (let i = 0; i < slots; i++) {
    const t = Math.abs(i - mid) / mid;
    const edgeBoost = 1 + Math.pow(t, 1.4) * (2.5 * alpha);
    const centerDrop = 1 - Math.pow(1 - t, 3) * 0.6;
    const v = Math.max(min, 0.9 * (1 + edgeBoost - centerDrop));
    a.push(v);
  }
  const norm = a[Math.floor(mid)] > 0 ? 1 / a[Math.floor(mid)] : 1;
  return a.map((v) => v * norm);
}
function scaleRTP(ms, ps, bps) {
  const want = Number(bps) / 10000.0;
  const cur  = ms.reduce((s, m, i) => s + m * ps[i], 0);
  const k    = cur > 0 ? want / cur : 1;
  return ms.map((m) => m * k);
}
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const i32   = (x) => (Number.isFinite(Number(x)) ? Math.floor(Number(x)) : 0);

// ---------- state ----------
const rounds = new Map();

// ---------- small number helpers ----------
const u64le = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const i64le = (n) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(n)); return b; };
const u32le = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE((n>>>0)); return b; };

// ---------- parse pending ----------
function parsePendingAccountData(data) {
  const base = 8;
  const minLen = base + 32 + 8 + 2 + 1 + 1 + 8 + 8 + 1;
  if (!data || data.length < minLen) throw new Error("pending account data too short");
  const player = data.slice(base, base + 32);
  const unit_amount = Number(data.readBigUInt64LE(base + 32));
  const balls = data.readUInt16LE(base + 32 + 8);
  const rows  = data.readUInt8(base + 32 + 8 + 2);
  const difficulty = data.readUInt8(base + 32 + 8 + 2 + 1);
  const nonce = Number(data.readBigUInt64LE(base + 32 + 8 + 2 + 1 + 1));
  const expiry_unix = Number(data.readBigInt64LE(base + 32 + 8 + 2 + 1 + 1 + 8));
  return { player, unit_amount, balls, rows, difficulty, nonce, expiry_unix };
}

// ---------- builders ----------
async function buildLockTx({ playerPk, unitLamports, balls, rows, diff, nonce, expiryUnix }) {
  const vault = pdaVault();
  const pending = pdaPending(playerPk, nonce);

  const ix = { programId: PROGRAM_ID, keys: [
    { pubkey: playerPk, isSigner: true,  isWritable: true },
    { pubkey: vault,    isSigner: false, isWritable: true },
    { pubkey: pending,  isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ], data: encLock({ unitAmount: unitLamports, balls, rows, difficulty: diff, nonce, expiryUnix }) };

  const cu = ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 });
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({ payerKey: playerPk, recentBlockhash: blockhash, instructions: [cu, ix] }).compileToV0Message();
  const vtx = new VersionedTransaction(msg);
  const sim = await connection.simulateTransaction(vtx, { sigVerify: false }).catch(()=>null);
  if (sim?.value?.err) {
    const logs = (sim.value.logs || []).join("\n");
    const abiErr = logs.includes("InstructionFallbackNotFound") || logs.includes("Fallback functions are not supported");
    if (abiErr) throw new Error(`LOCK discriminator mismatch (${LOCK_IX})\n${logs}`);
  }
  return { txBase64: Buffer.from(vtx.serialize()).toString("base64"), pending };
}

async function sendResolveStrict({ ctx, playerPk, pending, payoutLamportsNet, nonce, expiryUnix }) {
  const vault    = pdaVault();
  const adminPda = pdaAdmin();
  const feePayer = await getServerKeypair();

  const [vaultAcc, adminAcc] = await Promise.all([
    connection.getAccountInfo(vault),
    connection.getAccountInfo(adminPda),
  ]);
  if (!vaultAcc)  throw new Error("VAULT_NOT_FOUND");
  if (!adminAcc)  throw new Error("ADMIN_CONFIG_NOT_FOUND");

  const pendingAi = await connection.getAccountInfo(pending);
  if (!pendingAi) throw new Error("PENDING_NOT_FOUND_AFTER_WAIT");

  let pendingParsed = parsePendingAccountData(pendingAi.data);

  const msgBuf = Buffer.concat([
    Buffer.from("PLINKO_V1"),
    PROGRAM_ID.toBuffer(),
    vault.toBuffer(),
    playerPk.toBuffer(),
    pending.toBuffer(),
    u64le(pendingParsed.unit_amount),
    u32le(pendingParsed.balls),
    Buffer.from([pendingParsed.rows & 0xff]),
    Buffer.from([pendingParsed.difficulty & 0xff]),
    u64le(payoutLamportsNet),
    u64le(pendingParsed.nonce),
    i64le(pendingParsed.expiry_unix),
  ]);

  const edSig = await signMessageEd25519(msgBuf);
  const edIx  = Ed25519Program.createInstructionWithPublicKey({ publicKey: ADMIN_PK, message: msgBuf, signature: edSig });

  const cu = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });
  const edIndex = 1;

  const data = encResolve({ checksum: (Number(nonce) % 251) + 1, payout: Number(payoutLamportsNet), edIndex });
  const keys = [
    { pubkey: playerPk,                isSigner: false, isWritable: true  },
    { pubkey: vault,                   isSigner: false, isWritable: true  },
    { pubkey: adminPda,                isSigner: false, isWritable: false },
    { pubkey: pending,                 isSigner: false, isWritable: true  },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_INSTR,            isSigner: false, isWritable: false },
  ];
  const ixResolve = { programId: PROGRAM_ID, keys, data };

  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({ payerKey: feePayer.publicKey, recentBlockhash: blockhash, instructions: [cu, edIx, ixResolve] }).compileToV0Message();
  const vtx = new VersionedTransaction(msg);

  try { await connection.simulateTransaction(vtx, { sigVerify: false }); } catch {}

  vtx.sign([feePayer]);
  const sig = await connection.sendRawTransaction(vtx.serialize(), { skipPreflight: true, maxRetries: 5 });
  await connection.confirmTransaction(sig, "confirmed");
  return sig;
}

// ---------- WS ----------
function attachPlinko(io) {
  console.log("Plinko WS using STRICT resolver + DB gating/persistence");

  io.on("connection", (socket) => {
    socket.on("register", ({ player }) => { socket.data.player = String(player || "guest"); });

    socket.on("plinko:prepare_lock", async (p) => {
      try {
        const player = String(p?.player || "");
        if (!player) return socket.emit("plinko:error", { code: "NO_PLAYER", message: "player required" });

        // admin gate + min/max
        const cfg = await DB.getGameConfig?.("plinko");
        if (cfg && (!cfg.enabled || !cfg.running)) {
          return socket.emit("plinko:error", { code: "DISABLED", message: "Plinko disabled by admin" });
        }
        const min = BigInt(cfg?.min_bet_lamports ?? 50000);
        const max = BigInt(cfg?.max_bet_lamports ?? 5_000_000_000n);

        const unitLamports = BigInt(i32(p.unitLamports ?? p.betPerLamports));
        const balls = clamp(i32(p.balls), 1, 100);
        const rows  = clamp(i32(p.rows),  8, 16);
        const diff  = clamp(i32(p.diff ?? p.riskIndex), 0, 5);

        if (!(unitLamports > 0n)) return socket.emit("plinko:error", { code: "BAD_BET", message: "unitLamports must be > 0" });
        if (unitLamports < min || unitLamports > max) {
          return socket.emit("plinko:error", { code: "BET_RANGE", message: "Bet outside allowed range" });
        }

        const playerPk = new PublicKey(player);
        const nonce = Date.now();
        const expiryUnix = Math.floor(Date.now() / 1000) + Number(process.env.NONCE_TTL_SECONDS || 300);

        const built = await buildLockTx({ playerPk, unitLamports, balls, rows, diff, nonce, expiryUnix });

        let rtp_bps = cfg?.rtp_bps ?? 9400;
        try {
          if (typeof DB.getPlinkoRules === "function") {
            const r = await DB.getPlinkoRules(rows, diff);
            if (r?.rtp_bps) rtp_bps = r.rtp_bps;
          }
        } catch {}

        const probs  = rowOdds(rows);
        const base   = baseMultis(rows, diff);
        const scaled = scaleRTP(base, probs, rtp_bps);

        rounds.set(nonce, {
          playerPk, unitLamports, balls, rows, diff,
          probs, scaledMultis: scaled, results: [],
          pending: pdaPending(playerPk, nonce).toBase58(),
          expiryUnix,
        });

        socket.emit("plinko:lock_tx", {
          nonce: String(nonce),
          expiryUnix,
          transactionBase64: built.txBase64,
          multipliers: scaled.map((m) => Number(m.toFixed(4))),
        });
      } catch (e) {
        console.error("plinko:prepare_lock error:", e);
        socket.emit("plinko:error", { code: "PREPARE_FAIL", message: e.message || String(e) });
      }
    });

    socket.on("plinko:lock_confirmed", async ({ nonce }) => {
      try {
        const ctx = rounds.get(Number(nonce));
        if (!ctx) return socket.emit("plinko:error", { code: "NOT_FOUND", message: "no round" });

        const pick = (ps) => { const r = Math.random(); let a = 0; for (let j = 0; j < ps.length; j++) { a += ps[j]; if (r < a) return j; } return ps.length - 1; };

        for (let i = 0; i < ctx.balls; i++) {
          const idx = pick(ctx.probs);
          ctx.results.push(idx);
          socket.emit("plinko:tick", { nonce: String(nonce), ballIndex: i, slotIndex: idx });
          await new Promise((r) => setTimeout(r, 60));
        }

        const perBall = ctx.unitLamports;
        let gross = 0n;
        for (const idx of ctx.results) {
          const mul = ctx.scaledMultis[idx] || 1.0;
          const p   = (perBall * BigInt(Math.floor(mul * 10000))) / 10000n;
          gross += p;
        }
        const stake = perBall * BigInt(ctx.balls);
        const net   = gross > stake ? gross - stake : 0n;

        const payoutLamportsNet = net;

        const txSig = await sendResolveStrict({
          ctx,
          playerPk: ctx.playerPk,
          pending:  new PublicKey(ctx.pending),
          payoutLamportsNet,
          nonce: Number(nonce),
          expiryUnix: ctx.expiryUnix,
        });

        // persist + activity
        try {
          await DB.recordGameRound?.({
            game_key: "plinko",
            player: ctx.playerPk.toBase58(),
            nonce: Number(nonce),
            stake_lamports: Number(stake),
            payout_lamports: Number(net),
            result_json: { rows: ctx.rows, balls: ctx.balls, results: ctx.results },
          });
          if (net > 0n) {
            await DB.recordActivity?.({
              user: ctx.playerPk.toBase58(),
              action: "Plinko win",
              amount: (Number(net)/1e9).toFixed(4),
            });
          }
        } catch {}

        socket.emit("plinko:resolved", {
          nonce: String(nonce),
          results: ctx.results,
          multipliers: ctx.scaledMultis,
          payoutLamports: Number(payoutLamportsNet), // net
          grossLamports: Number(gross),
          netLamports: Number(net),
          stakeLamports: Number(stake),
          tx: txSig,
        });
      } catch (e) {
        console.error("plinko:lock_confirmed error:", e);
        const msg = (e?.transactionLogs && Array.isArray(e.transactionLogs))
          ? e.transactionLogs.join("\n")
          : (e?.message || String(e));
        socket.emit("plinko:error", { code: "ROUND_FAIL", message: msg });
      }
    });
  });
}

module.exports = { attachPlinko };
