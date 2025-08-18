// plinko_ws.js — payout mode switch (gross|net), server-paid resolve, env-driven names, simulate

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

// ---------- Config ----------
const RPC_URL = process.env.CLUSTER || "https://api.devnet.solana.com";
const connection = new Connection(RPC_URL, "confirmed");

if (!process.env.PLINKO_PROGRAM_ID) throw new Error("PLINKO_PROGRAM_ID missing");
const PROGRAM_ID = new PublicKey(process.env.PLINKO_PROGRAM_ID);

const LOCK_IX = process.env.PLINKO_LOCK_IX_NAME || "lock";
const RESOLVE_IX = process.env.PLINKO_RESOLVE_IX_NAME || "resolve";

// IMPORTANT: choose what your on-chain resolve expects
//   - "gross" => total payout including stake (typical in many programs)
//   - "net"   => profit only
const PAYOUT_MODE = (process.env.PLINKO_PAYOUT_MODE || "gross").toLowerCase(); // "gross" | "net"

const RESOLVE_MODE = (process.env.PLINKO_RESOLVE_MODE || "server").toLowerCase(); // "server" | "client"

const SYSVAR_INSTR = new PublicKey("Sysvar1nstructions1111111111111111111111111");

// ---------- PDAs ----------
const pdaVault = () => PublicKey.findProgramAddressSync([Buffer.from("vault")], PROGRAM_ID)[0];
const pdaAdmin = () => PublicKey.findProgramAddressSync([Buffer.from("admin")], PROGRAM_ID)[0];
function pdaPending(playerPk, nonce) {
  const nb = Buffer.alloc(8); nb.writeBigUInt64LE(BigInt(nonce));
  return PublicKey.findProgramAddressSync([Buffer.from("bet"), playerPk.toBuffer(), nb], PROGRAM_ID)[0];
}

// ---------- Anchor encoders ----------
function disc(name) { return crypto.createHash("sha256").update(`global:${name}`).digest().slice(0, 8); }

// LockArgs { unit_amount:u64, balls:u16, rows:u8, difficulty:u8, nonce:u64, expiry_unix:i64 }
function encLock({ unitAmount, balls, rows, difficulty, nonce, expiryUnix }) {
  const d = disc(LOCK_IX);
  const b = Buffer.alloc(8 + 8 + 2 + 1 + 1 + 8 + 8); let o = 0;
  d.copy(b, o); o += 8;
  b.writeBigUInt64LE(BigInt(unitAmount), o); o += 8;
  b.writeUInt16LE(balls & 0xffff, o); o += 2;
  b.writeUInt8(rows & 0xff, o++); b.writeUInt8(difficulty & 0xff, o++);
  b.writeBigUInt64LE(BigInt(nonce), o); o += 8;
  b.writeBigInt64LE(BigInt(expiryUnix), o); o += 8;
  return b;
}

// ResolveArgs { checksum:u8, payout:u64, ed25519_instr_index:u8 }
function encResolve({ checksum, payout, edIndex }) {
  const d = disc(RESOLVE_IX);
  const b = Buffer.alloc(8 + 1 + 8 + 1); let o = 0;
  d.copy(b, o); o += 8;
  b.writeUInt8(checksum & 0xff, o++);
  b.writeBigUInt64LE(BigInt(payout), o); o += 8;
  b.writeUInt8(edIndex & 0xff, o++);
  return b;
}

// ---------- Account metas (order must match your #[derive(Accounts)]) ----------
function keysLock({ player, vault, pending }) {
  return [
    { pubkey: player, isSigner: true,  isWritable: true },
    { pubkey: vault,  isSigner: false, isWritable: true },
    { pubkey: pending,isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];
}
function keysResolve({ player, vault, admin, pending }) {
  return [
    { pubkey: player, isSigner: false, isWritable: true },
    { pubkey: vault,  isSigner: false, isWritable: true },
    { pubkey: admin,  isSigner: false, isWritable: false },
    { pubkey: pending,isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_INSTR, isSigner: false, isWritable: false },
  ];
}

// ---------- Plinko math ----------
function rowOdds(rows) {
  const C=(n,k)=>{ if(k<0||k>n) return 0; let r=1; for(let i=1;i<=k;i++) r=(r*(n-(k-i)))/i; return r; };
  const d = 2 ** rows;
  return Array.from({length: rows+1}, (_,k)=> C(rows,k)/d);
}
function baseMultis(rows, diff) {
  const slots=rows+1, mid=rows/2, risk=[0.6,0.8,1.0,1.3,1.7][diff]??1.0, min=0.4+diff*0.08;
  const a=[]; for(let i=0;i<slots;i++){ const t=Math.abs(i-mid)/mid; const v=Math.max(min, 0.9*(1 + (1+t**1.4*2.5*risk) - (1-(1-t)**3)*0.6)); a.push(v); }
  const norm = a[Math.floor(mid)]>0? 1/a[Math.floor(mid)] : 1;
  return a.map(v=>v*norm);
}
function scaleRTP(ms, ps, bps){ const want=bps/100.0; const cur=ms.reduce((s,m,i)=>s+m*ps[i],0); const k=cur>0?want/cur:1; return ms.map(m=>m*k); }
function pick(ps){ const r=Math.random(); let a=0; for(let i=0;i<ps.length;i++){ a+=ps[i]; if(r<a) return i; } return ps.length-1; }

// ---------- helpers ----------
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const toNum=(x)=> (Number.isFinite(Number(x))?Number(x):0);

// ---------- state ----------
const rounds = new Map(); // nonce -> ctx

// ---------- build/sim helpers ----------
async function buildLockTx({ playerPk, unitLamports, balls, rows, diff, nonce, expiryUnix }) {
  const vault = pdaVault();
  const pending = pdaPending(playerPk, nonce);
  const data = encLock({ unitAmount: unitLamports, balls, rows, difficulty: diff, nonce, expiryUnix });
  const ix = { programId: PROGRAM_ID, keys: keysLock({ player: playerPk, vault, pending }), data };
  const cu = ComputeBudgetProgram.setComputeUnitLimit({ units: 350_000 });

  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({ payerKey: playerPk, recentBlockhash: blockhash, instructions: [cu, ix] }).compileToV0Message();
  const vtx = new VersionedTransaction(msg);

  const sim = await connection.simulateTransaction(vtx, { sigVerify: false });
  if (sim.value.err) {
    const logs = (sim.value.logs || []).join("\n");
    const errStr = JSON.stringify(sim.value.err);
    const isDisc = logs.includes("InstructionFallbackNotFound") || logs.includes("Fallback functions are not supported");
    if (isDisc) throw new Error(`LOCK discriminator mismatch ("${LOCK_IX}")\n${logs}`);
    const isInsuff = logs.includes("Transfer: insufficient lamports") || errStr.includes('"Custom":1');
    if (!isInsuff) throw new Error(`LOCK simulate failed: ${errStr}\n${logs}`);
    // allow insufficient funds — we'll warn client; they may top-up then sign
  }

  return { txBase64: Buffer.from(vtx.serialize()).toString("base64"), pending };
}

async function buildResolveClient({ playerPk, pending, payoutLamports, nonce }) {
  const vault = pdaVault(), admin = pdaAdmin();

  const msgBuf = Buffer.concat([
    Buffer.from("PLINKO_V1"),
    PROGRAM_ID.toBuffer(),
    vault.toBuffer(),
    playerPk.toBuffer(),
    Buffer.from(String(nonce)),
  ]);
  const sig = await signMessageEd25519(msgBuf);
  const edIx = Ed25519Program.createInstructionWithPublicKey({ publicKey: ADMIN_PK, message: msgBuf, signature: sig });
  const edIndex = 1;

  const data = encResolve({ checksum: (Number(nonce)%251)+1, payout: Number(payoutLamports), edIndex });
  const ix = { programId: PROGRAM_ID, keys: keysResolve({ player: playerPk, vault, admin, pending }), data };
  const cu = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });

  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({ payerKey: playerPk, recentBlockhash: blockhash, instructions: [cu, edIx, ix] }).compileToV0Message();
  const vtx = new VersionedTransaction(msg);

  const sim = await connection.simulateTransaction(vtx, { sigVerify: false });
  if (sim.value.err) {
    const logs = (sim.value.logs || []).join("\n");
    throw new Error(`RESOLVE simulate failed: ${JSON.stringify(sim.value.err)}\n${logs}`);
  }

  return Buffer.from(vtx.serialize()).toString("base64");
}

async function sendResolveServer({ playerPk, pending, payoutLamports, nonce }) {
  const vault = pdaVault(), admin = pdaAdmin();
  const feePayer = await getServerKeypair();

  const msgBuf = Buffer.concat([
    Buffer.from("PLINKO_V1"),
    PROGRAM_ID.toBuffer(),
    vault.toBuffer(),
    playerPk.toBuffer(),
    Buffer.from(String(nonce)),
  ]);
  const sig = await signMessageEd25519(msgBuf);
  const edIx = Ed25519Program.createInstructionWithPublicKey({ publicKey: ADMIN_PK, message: msgBuf, signature: sig });
  const edIndex = 1;

  const data = encResolve({ checksum: (Number(nonce)%251)+1, payout: Number(payoutLamports), edIndex });
  const ix = { programId: PROGRAM_ID, keys: keysResolve({ player: playerPk, vault, admin, pending }), data };
  const cu = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });

  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({ payerKey: feePayer.publicKey, recentBlockhash: blockhash, instructions: [cu, edIx, ix] }).compileToV0Message();
  const vtx = new VersionedTransaction(msg);

  const sim = await connection.simulateTransaction(vtx, { sigVerify: false });
  if (sim.value.err) {
    const logs = (sim.value.logs || []).join("\n");
    throw new Error(`RESOLVE simulate (server) failed: ${JSON.stringify(sim.value.err)}\n${logs}`);
  }

  vtx.sign([feePayer]);
  const sigTx = await connection.sendRawTransaction(vtx.serialize(), { skipPreflight: false, maxRetries: 5 });
  await connection.confirmTransaction(sigTx, "confirmed");
  return sigTx;
}

// ---------- WS ----------
function attachPlinko(io) {
  io.on("connection", (socket) => {
    socket.on("register", ({ player }) => { socket.data.player = String(player || "guest"); });

    // Prepare lock
    socket.on("plinko:prepare_lock", async (payload) => {
      try {
        const playerB58 = String(payload?.player || "");
        if (!playerB58) return socket.emit("plinko:error", { code: "NO_PLAYER", message: "player required" });

        const unitLamports = BigInt(toNum(payload.unitLamports ?? payload.betPerLamports));
        const balls = clamp(toNum(payload.balls), 1, 100000);
        const rows  = clamp(toNum(payload.rows), 8, 16);
        const diff  = clamp(toNum(payload.diff ?? payload.riskIndex), 0, 4);
        if (!(unitLamports > 0n)) return socket.emit("plinko:error", { code: "BAD_BET", message: "unitLamports must be > 0" });

        const playerPk = new PublicKey(playerB58);
        const nonce = Date.now();
        const expiryUnix = Math.floor(Date.now()/1000) + Number(process.env.NONCE_TTL_SECONDS || 300);

        // Build + simulate lock (tolerate insufficient lamports: warn)
        let warn = null;
        let built;
        try {
          built = await buildLockTx({ playerPk, unitLamports, balls, rows, diff, nonce, expiryUnix });
        } catch (e) {
          const msg = String(e?.message || e);
          if (msg.includes("insufficient lamports")) warn = msg;
          else throw e;
        }
        if (!built) {
          // re-build without simulate for insufficient funds case
          const vault = pdaVault();
          const pending = pdaPending(playerPk, nonce);
          const data = encLock({ unitAmount: unitLamports, balls, rows, difficulty: diff, nonce, expiryUnix });
          const ix = { programId: PROGRAM_ID, keys: keysLock({ player: playerPk, vault, pending }), data };
          const cu = ComputeBudgetProgram.setComputeUnitLimit({ units: 350_000 });
          const { blockhash } = await connection.getLatestBlockhash("confirmed");
          const msgV0 = new TransactionMessage({ payerKey: playerPk, recentBlockhash: blockhash, instructions: [cu, ix] }).compileToV0Message();
          built = { txBase64: Buffer.from(new VersionedTransaction(msgV0).serialize()).toString("base64"), pending };
        }

        // RTP/multipliers for UI
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
        const probs = rowOdds(rows);
        const base = baseMultis(rows, diff);
        const scaled = scaleRTP(base, probs, rtp_bps);

        rounds.set(nonce, {
          playerPk, unitLamports, balls, rows, diff,
          probs, scaledMultis: scaled,
          results: [],
          pending: pdaPending(playerPk, nonce).toBase58(),
        });

        if (warn) socket.emit("plinko:warn", { code: "INSUFFICIENT_FUNDS_SIM", message: warn });

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

    // Confirmed lock -> animate -> resolve
    socket.on("plinko:lock_confirmed", async ({ player, nonce }) => {
      try {
        const ctx = rounds.get(Number(nonce));
        if (!ctx) return socket.emit("plinko:error", { code: "NOT_FOUND", message: "no round" });

        // Ticks
        for (let i = 0; i < ctx.balls; i++) {
          const idx = pick(ctx.probs);
          ctx.results.push(idx);
          socket.emit("plinko:tick", { nonce: String(nonce), ballIndex: i, slotIndex: idx });
          await new Promise(r => setTimeout(r, 60));
        }

        // Payouts
        const perBall = ctx.unitLamports;
        let gross = 0n;
        for (const idx of ctx.results) {
          const m = ctx.scaledMultis[idx] || 1.0;
          const p = (perBall * BigInt(Math.floor(m * 10000))) / 10000n;
          gross += p;
        }
        const stake = perBall * BigInt(ctx.balls);
        const net = gross > stake ? gross - stake : 0n;

        // Decide which to send to program
        const payoutLamports = PAYOUT_MODE === "net" ? net : gross;

        const playerPk = ctx.playerPk;
        const pending = new PublicKey(ctx.pending);

        if (RESOLVE_MODE === "server") {
          const sig = await sendResolveServer({ playerPk, pending, payoutLamports, nonce });
          // emit both gross & net so UI can show what you prefer
          const res = {
            nonce: String(nonce),
            results: ctx.results,
            multipliers: ctx.scaledMultis,
            payoutLamports: Number(payoutLamports),
            grossLamports: Number(gross),
            netLamports: Number(net),
            stakeLamports: Number(stake),
            tx: sig,
          };
          io.emit("plinko:resolved", res);
        } else {
          const txBase64 = await buildResolveClient({ playerPk, pending, payoutLamports, nonce });
          socket.emit("plinko:resolve_tx", {
            nonce: String(nonce),
            results: ctx.results,
            multipliers: ctx.scaledMultis,
            payoutLamports: Number(payoutLamports),
            grossLamports: Number(gross),
            netLamports: Number(net),
            stakeLamports: Number(stake),
            transactionBase64: txBase64,
          });
        }
      } catch (e) {
        console.error("plinko:lock_confirmed error:", e);
        socket.emit("plinko:error", { code: "ROUND_FAIL", message: e.message || String(e) });
      }
    });
  });
}

module.exports = { attachPlinko };
