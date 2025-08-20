// backend/plinko_ws.js — FULL FIX
// STRICT resolver: CU(0) + Ed25519(1) + Resolve(2), skipPreflight=true
// Builds canonical message from on-chain pending_account, encodes rows/diff as u8,
// and robustly handles RPC-sim quirks by simulating with sigVerify:false and
// printing diagnostics if send fails.

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

// ---------- RPC / Program ----------
const RPC_URL = process.env.CLUSTER || "https://api.devnet.solana.com";
const connection = new Connection(RPC_URL, "confirmed");

if (!process.env.PLINKO_PROGRAM_ID) throw new Error("PLINKO_PROGRAM_ID missing in .env");
const PROGRAM_ID = new PublicKey(process.env.PLINKO_PROGRAM_ID);

// Instruction names from on-chain (lib.rs / IDL)
const LOCK_IX = process.env.PLINKO_LOCK_IX_NAME || "lock";
const RES_IX  = process.env.PLINKO_RESOLVE_IX_NAME || "resolve";

// NOTE: Chain expects NET payout; we still compute gross/net for UI,
// but only NET is signed & sent to the program.
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
  // [disc:8][u64][u16][u8][u8][u64][i64]
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
  // [disc:8][u8][u64][u8]
  const d = disc(RES_IX);
  const b = Buffer.alloc(8 + 1 + 8 + 1);
  let o = 0;
  d.copy(b, o); o += 8;
  b.writeUInt8(checksum & 0xff, o++);
  b.writeBigUInt64LE(BigInt(payout), o); o += 8;
  b.writeUInt8(edIndex & 0xff, o++);
  return b;
}

// ---------- math ----------
function rowOdds(rows) {
  const C = (n, k) => {
    if (k < 0 || k > n) return 0;
    let r = 1;
    for (let i = 1; i <= k; i++) r = (r * (n - (k - i))) / i;
    return r;
  };
  const d = 2 ** rows;
  return Array.from({ length: rows + 1 }, (_, k) => C(rows, k) / d);
}

const RISK_ALPHAS = [0.6, 0.8, 1.0, 1.3, 1.7]; // 0..4
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

// RTP in basis points (default 94%)
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

// ---------- diagnostics ----------
async function waitForAccount(pubkey, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const info = await connection.getAccountInfo(pubkey, "confirmed");
    if (info) return true;
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
}
async function diagMissingLine({ playerPk, vault, adminPda, pending }) {
  const [pa, va, aa, pe] = await Promise.all([
    connection.getAccountInfo(playerPk).then(Boolean).catch(()=>false),
    connection.getAccountInfo(vault).then(Boolean).catch(()=>false),
    connection.getAccountInfo(adminPda).then(Boolean).catch(()=>false),
    connection.getAccountInfo(pending).then(Boolean).catch(()=>false),
  ]);
  const parts = [];
  if (!pa) parts.push(`player ${playerPk.toBase58()}`);
  if (!va) parts.push(`vault ${vault.toBase58()}`);
  if (!aa) parts.push(`admin ${adminPda.toBase58()}`);
  if (!pe) parts.push(`pending ${pending.toBase58()}`);
  return parts.length ? `missing: ${parts.join(", ")}` : "all accounts present";
}

// ---------- parse pending account (Anchor layout) ----------
function parsePendingAccountData(data) {
  // PendingRound { player: Pubkey(32), unit_amount: u64, balls: u16, rows: u8, difficulty: u8, nonce: u64, expiry_unix: i64, settled: bool }
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

// ---------- tx builders ----------
async function buildLockTx({ playerPk, unitLamports, balls, rows, diff, nonce, expiryUnix }) {
  const vault = pdaVault();
  const pending = pdaPending(playerPk, nonce);

  const ix = {
    programId: PROGRAM_ID,
    keys: [
      { pubkey: playerPk, isSigner: true,  isWritable: true },
      { pubkey: vault,    isSigner: false, isWritable: true },
      { pubkey: pending,  isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: encLock({ unitAmount: unitLamports, balls, rows, difficulty: diff, nonce, expiryUnix }),
  };
  const cu = ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 });
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({
    payerKey: playerPk,
    recentBlockhash: blockhash,
    instructions: [cu, ix],
  }).compileToV0Message();

  const vtx = new VersionedTransaction(msg);
  const sim = await connection.simulateTransaction(vtx, { sigVerify: false }).catch(()=>null);
  if (sim?.value?.err) {
    const logs = (sim.value.logs || []).join("\n");
    const abiErr =
      logs.includes("InstructionFallbackNotFound") ||
      logs.includes("Fallback functions are not supported");
    if (abiErr) throw new Error(`LOCK discriminator mismatch (${LOCK_IX})\n${logs}`);
  }

  return { txBase64: Buffer.from(vtx.serialize()).toString("base64"), pending };
}

// ---------- STRICT resolve (CU first, Ed25519 second, Resolve third) ----------
async function sendResolveStrict({ ctx, playerPk, pending, payoutLamportsNet, nonce, expiryUnix }) {
  const vault    = pdaVault();
  const adminPda = pdaAdmin();
  const feePayer = await getServerKeypair();

  // required accounts must exist
  const [vaultAcc, adminAcc] = await Promise.all([
    connection.getAccountInfo(vault),
    connection.getAccountInfo(adminPda),
  ]);
  if (!vaultAcc)  throw new Error("VAULT_NOT_FOUND");
  if (!adminAcc)  throw new Error("ADMIN_CONFIG_NOT_FOUND");

  // ensure the pending round PDA is on-chain (created by lock)
  if (!(await waitForAccount(pending, 30000))) {
    const line = await diagMissingLine({ playerPk, vault, adminPda, pending });
    throw new Error(`PENDING_NOT_FOUND: ${line}`);
  }

  // fetch pending account authoritative data
  const pendingAi = await connection.getAccountInfo(pending);
  if (!pendingAi) throw new Error("PENDING_NOT_FOUND_AFTER_WAIT");

  let pendingParsed;
  try {
    pendingParsed = parsePendingAccountData(pendingAi.data);
  } catch (e) {
    // fallback (shouldn't happen)
    pendingParsed = {
      player: ctx?.playerPk ? ctx.playerPk.toBuffer() : playerPk.toBuffer(),
      unit_amount: Number(ctx?.unitLamports ?? 0n),
      balls: (ctx.balls ?? Number(ctx.balls)) || 1,
      rows: ctx.rows ?? 8,
      difficulty: (ctx.diff ?? ctx.difficulty) ?? 0,
      nonce,
      expiry_unix: expiryUnix,
    };
    console.warn("[plinko] fallback pendingParsed used:", e.message || e);
  }

  if (process.env.DEBUG_MSGBUF === "1") {
    console.log("[plinko] pending parsed:", {
      unit_amount: pendingParsed.unit_amount,
      balls: pendingParsed.balls,
      rows: pendingParsed.rows,
      difficulty: pendingParsed.difficulty,
      nonce: pendingParsed.nonce,
      expiry_unix: pendingParsed.expiry_unix,
    });
  }

  // build canonical msg (must match Rust build_canonical_msg exactly)
  const msgBuf = Buffer.concat([
    Buffer.from("PLINKO_V1"),
    PROGRAM_ID.toBuffer(),
    vault.toBuffer(),
    playerPk.toBuffer(),
    pending.toBuffer(),
    u64le(pendingParsed.unit_amount),       // u64
    u32le(pendingParsed.balls),             // pr.balls cast to u32 in Rust
    Buffer.from([pendingParsed.rows & 0xff]),       // u8
    Buffer.from([pendingParsed.difficulty & 0xff]), // u8
    u64le(payoutLamportsNet),               // u64  (NET payout!)
    u64le(pendingParsed.nonce),             // u64
    i64le(pendingParsed.expiry_unix),       // i64
  ]);

  if (process.env.DEBUG_MSGBUF === "1") {
    console.log("[plinko] msgBuf hex:", msgBuf.toString("hex"));
  }

  const edSig = await signMessageEd25519(msgBuf);
  const edIx  = Ed25519Program.createInstructionWithPublicKey({
    publicKey: ADMIN_PK,   // Uint8Array(32)
    message:  msgBuf,
    signature: edSig,
  });

  // optional debug-parse of edIx
  if (process.env.DEBUG_MSGBUF === "1") {
    try {
      const d = Buffer.from(edIx.data);
      console.log("[plinko-debug] edIx.data hex:", d.toString("hex"));
      if (d.length >= 16) {
        const pk_off  = d.readUInt16LE(6);
        const msg_off = d.readUInt16LE(10);
        const msg_sz  = d.readUInt16LE(12);
        const pk = d.slice(pk_off, pk_off + 32);
        const msg = d.slice(msg_off, msg_off + msg_sz);
        console.log("[plinko-debug] parsed pk hex:", pk.toString("hex"));
        console.log("[plinko-debug] parsed msg hex:", msg.toString("hex"));
        console.log("[plinko-debug] client msgBuf hex:", msgBuf.toString("hex"));
        console.log("[plinko-debug] ADMIN_PK (env) hex:", Buffer.from(ADMIN_PK).toString("hex"));
        console.log("[plinko-debug] msg_eq_parsed?", Buffer.from(msgBuf).equals(msg));
        console.log("[plinko-debug] pk_eq_env?", Buffer.from(pk).equals(Buffer.from(ADMIN_PK)));
      }
    } catch (e) {
      console.warn("[plinko-debug] failed to parse edIx.data:", e.message || e);
    }
  }

  // CU first so ed25519 gets proper compute during sim
  const cu = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });

  // CU (0), ed25519 (1), resolve (2)
  const edIndex = 1;

  const data = encResolve({
    checksum: (Number(nonce) % 251) + 1,
    payout: Number(payoutLamportsNet), // NET sent to chain
    edIndex,
  });

  // account order matches #[derive(Accounts) Resolve] in lib.rs
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
  const msg = new TransactionMessage({
    payerKey: feePayer.publicKey,
    recentBlockhash: blockhash,
    instructions: [cu, edIx, ixResolve],
  }).compileToV0Message();

  const vtx = new VersionedTransaction(msg);

  // simulate without sig verify (some RPCs false-negative verify)
  try {
    const sim = await connection.simulateTransaction(vtx, { sigVerify: false });
    if (sim?.value?.err) {
      const logs  = (sim.value.logs || []).join("\n");
      const errStr = JSON.stringify(sim.value.err);
      const line = await diagMissingLine({ playerPk, vault, adminPda, pending });
      console.warn(`[plinko] resolve simulate err (non-fatal): ${errStr}\n${logs || "(no logs)"}\n${line}`);
    } else if (process.env.DEBUG_MSGBUF === "1") {
      console.log("[plinko] simulate logs:\n", (sim.value.logs||[]).join("\n"));
    }
  } catch (e) {
    console.warn("[plinko] simulate threw (non-fatal):", e?.message || e);
  }

  // sign & send (skip preflight to dodge flaky sims)
  vtx.sign([feePayer]);
  if (process.env.DEBUG_MSGBUF === "1") {
    console.log("[plinko] vtx signatures:",
      vtx.signatures.map((s,i)=>`sig[${i}] present=${!!s} len=${s? s.length:0}`).join(", "));
    console.log("[plinko] feePayer pubkey:", feePayer.publicKey.toBase58());
  }

  try {
    const sig = await connection.sendRawTransaction(vtx.serialize(), { skipPreflight: true, maxRetries: 5 });
    await connection.confirmTransaction(sig, "confirmed");
    return sig;
  } catch (sendErr) {
    console.error("[plinko] sendRawTransaction failed:", sendErr?.message || sendErr);
    try {
      const sim2 = await connection.simulateTransaction(vtx, { sigVerify: false });
      console.error("[plinko] second simulate logs:", sim2?.value?.logs || sim2);
    } catch (e2) {
      console.error("[plinko] second simulate threw:", e2?.message || e2);
    }
    throw sendErr;
  }
}

// ---------- WS ----------
function attachPlinko(io) {
  console.log("Plinko WS using STRICT resolver (+final pending wait + sim fallback)");

  io.on("connection", (socket) => {
    socket.on("register", ({ player }) => {
      socket.data.player = String(player || "guest");
    });

    // Step 1: build lock (client signs & sends)
    socket.on("plinko:prepare_lock", async (p) => {
      try {
        const player = String(p?.player || "");
        if (!player)
          return socket.emit("plinko:error", { code: "NO_PLAYER", message: "player required" });

        const unitLamports = BigInt(i32(p.unitLamports ?? p.betPerLamports));
        const balls = clamp(i32(p.balls), 1, 100);
        const rows  = clamp(i32(p.rows),  8, 16);
        const diff  = clamp(i32(p.diff ?? p.riskIndex), 0, 5); // allow up to 6 profiles

        if (!(unitLamports > 0n)) {
          return socket.emit("plinko:error", { code: "BAD_BET", message: "unitLamports must be > 0" });
        }

        const playerPk = new PublicKey(player);
        const nonce = Date.now();
        const expiryUnix = Math.floor(Date.now() / 1000) + Number(process.env.NONCE_TTL_SECONDS || 300);

        const built = await buildLockTx({
          playerPk, unitLamports, balls, rows, diff, nonce, expiryUnix,
        });

        // RTP (default 94%); override via DB if present
        let rtp_bps = 9400;
        try {
          if (typeof global.db?.getPlinkoRules === "function") {
            const r = await global.db.getPlinkoRules(rows, diff);
            if (r?.rtp_bps) rtp_bps = r.rtp_bps;
          } else if (typeof global.db?.getRules === "function") {
            const r = await global.db.getRules();
            if (r?.rtp_bps) rtp_bps = r.rtp_bps;
          }
        } catch {}

        const probs  = rowOdds(rows);
        const base   = baseMultis(rows, diff);
        const scaled = scaleRTP(base, probs, rtp_bps);

        // remember round
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

    // Step 2: after client confirms lock -> animate -> resolve on server (server pays fees)
    socket.on("plinko:lock_confirmed", async ({ nonce }) => {
      try {
        const ctx = rounds.get(Number(nonce));
        if (!ctx) return socket.emit("plinko:error", { code: "NOT_FOUND", message: "no round" });

        // Draw each ball (simple binomial-weighted pick)
        const pick = (ps) => {
          const r = Math.random(); let a = 0;
          for (let j = 0; j < ps.length; j++) { a += ps[j]; if (r < a) return j; }
          return ps.length - 1;
        };

        for (let i = 0; i < ctx.balls; i++) {
          const idx = pick(ctx.probs);
          ctx.results.push(idx);
          socket.emit("plinko:tick", { nonce: String(nonce), ballIndex: i, slotIndex: idx });
          await new Promise((r) => setTimeout(r, 60));
        }

        // payout calc
        const perBall = ctx.unitLamports;
        let gross = 0n;
        for (const idx of ctx.results) {
          const mul = ctx.scaledMultis[idx] || 1.0;
          const p   = (perBall * BigInt(Math.floor(mul * 10000))) / 10000n; // 4dp
          gross += p;
        }
        const stake = perBall * BigInt(ctx.balls);
        const net   = gross > stake ? gross - stake : 0n;

        // ✅ Send NET to chain (program returns stake + net)
        const payoutLamportsNet = net;

        const txSig = await sendResolveStrict({
          ctx,
          playerPk: ctx.playerPk,
          pending:  new PublicKey(ctx.pending),
          payoutLamportsNet,
          nonce: Number(nonce),
          expiryUnix: ctx.expiryUnix,
        });

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
