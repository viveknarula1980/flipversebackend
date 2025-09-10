// backend/slots_ws.js — DB gating + server-sent resolve (no second popup)

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
//   PROGRAM_ID,
//   deriveVaultPda,
//   deriveAdminPda,
//   buildEd25519VerifyIx,
// } = require("./solana");
// const { ADMIN_PK, buildMessageBytes, signMessageEd25519, getServerKeypair } = require("./signer");
// const DB = global.db || require("./db");

// const SYSVAR_INSTRUCTIONS_PUBKEY = new PublicKey(
//   "Sysvar1nstructions1111111111111111111111111"
// );

// // ---------- Helpers ----------
// function anchorDisc(globalSnakeName) {
//   return crypto.createHash("sha256").update(`global:${globalSnakeName}`).digest().slice(0, 8);
// }
// function sha256Hex(buf) { return crypto.createHash("sha256").update(buf).digest("hex"); }
// function makeRng({ serverSeed, clientSeed, nonce }) {
//   let counter = 0, pool = Buffer.alloc(0);
//   function refill() {
//     const h = crypto
//       .createHmac("sha256", serverSeed)
//       .update(String(clientSeed || ""))
//       .update(Buffer.from(String(nonce)))
//       .update(Buffer.from([
//         counter & 0xff, (counter >> 8) & 0xff, (counter >> 16) & 0xff, (counter >> 24) & 0xff,
//       ]))
//       .digest();
//     counter++; pool = Buffer.concat([pool, h]);
//   }
//   function nextU32() { if (pool.length < 4) refill(); const x = pool.readUInt32BE(0); pool = pool.slice(4); return x >>> 0; }
//   function nextFloat() { return nextU32() / 2 ** 32; }
//   function nextInt(min, max) { const span = max - min + 1; return min + Math.floor(nextFloat() * span); }
//   function pick(arr) { return arr[nextInt(0, arr.length - 1)]; }
//   return { nextU32, nextFloat, nextInt, pick };
// }
// function encodePlaceBetLockArgs({ betAmount, betType, target, nonce, expiryUnix }) {
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
//   const disc = anchorDisc("resolve_bet");
//   const buf = Buffer.alloc(8 + 1 + 8 + 1);
//   let o = 0;
//   disc.copy(buf, o); o += 8;
//   buf.writeUInt8(roll & 0xff, o++);
//   buf.writeBigUInt64LE(BigInt(payout), o); o += 8;
//   buf.writeUInt8(ed25519InstrIndex & 0xff, o++);
//   return buf;
// }
// function placeBetLockKeys({ player, vaultPda, pendingBetPda }) {
//   return [
//     { pubkey: player, isSigner: true,  isWritable: true },
//     { pubkey: vaultPda, isSigner: false, isWritable: true },
//     { pubkey: pendingBetPda, isSigner: false, isWritable: true },
//     { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
//   ];
// }

// // ---------- Game constants ----------
// const SLOT_SYMBOLS = ["floki", "wif", "brett", "shiba", "bonk", "doge", "pepe", "sol", "zoggy"];
// const SLOTS_CELLS = 9;

// const PAYTABLE = [
//   { key: "near_miss",   type: "near",   payoutMul: 0.8,  freq: 0.24999992500002252 },
//   { key: "triple_floki",type: "triple", symbol: "floki", payoutMul: 1.5,  freq: 0.04999998500000451 },
//   { key: "triple_wif",  type: "triple", symbol: "wif",   payoutMul: 1.5,  freq: 0.04999998500000451 },
//   { key: "triple_brett",type: "triple", symbol: "brett", payoutMul: 1.5,  freq: 0.04999998500000451 },
//   { key: "triple_shiba",type: "triple", symbol: "shiba", payoutMul: 3,    freq: 0.023609992917002123 },
//   { key: "triple_bonk", type: "triple", symbol: "bonk",  payoutMul: 6,    freq: 0.011804996458501062 },
//   { key: "triple_doge", type: "triple", symbol: "doge",  payoutMul: 10,   freq: 0.007082997875100638 },
//   { key: "triple_pepe", type: "triple", symbol: "pepe",  payoutMul: 20,   freq: 0.003541998937400319 },
//   { key: "triple_sol",  type: "triple", symbol: "sol",   payoutMul: 50,   freq: 0.001416999574900128 },
//   { key: "triple_zoggy",type: "triple", symbol: "zoggy", payoutMul: 100,  freq: 0.000708299787510064 },
//   { key: "jackpot",     type: "triple", symbol: "zoggy", payoutMul: 1000, freq: 0 },
//   { key: "loss",        type: "loss",   payoutMul: 0,    freq: 0.5518348344495496 },
// ];

// // get fee pct from DB config (fallback 5%)
// function getFeePctFromConfig(cfg) {
//   const bps = Number(cfg?.fee_bps ?? 500);
//   return Math.max(0, bps) / 10000;
// }

// // Outcome selection
// const CDF = (() => {
//   const rows = PAYTABLE.filter((p) => p.key !== "jackpot");
//   let acc = 0;
//   return rows.map((r) => { acc += r.freq; return { ...r, cum: acc }; });
// })();
// const JACKPOT_NONCES = new Set(
//   String(process.env.SLOTS_JACKPOT_NONCES || "")
//     .split(",").map(s => s.trim()).filter(Boolean)
// );
// function pickOutcome(rng, nonce) {
//   if (JACKPOT_NONCES.has(String(nonce))) return PAYTABLE.find((p) => p.key === "jackpot");
//   const r = rng.nextFloat();
//   for (const row of CDF) if (r < row.cum) return row;
//   return PAYTABLE.find((p) => p.key === "loss");
// }
// function buildGridForOutcome({ rng, outcome }) {
//   const grid = []; for (let i = 0; i < SLOTS_CELLS; i++) grid.push(rng.pick(SLOT_SYMBOLS));
//   const midStart = 3; const mid = grid.slice(midStart, midStart + 3);
//   const pickNot = (exclude) => { let s; do { s = rng.pick(SLOT_SYMBOLS); } while (s === exclude); return s; };

//   if (outcome.type === "triple") {
//     const s = outcome.symbol; mid[0]=s; mid[1]=s; mid[2]=s;
//   } else if (outcome.type === "near") {
//     const s = rng.pick(SLOT_SYMBOLS); const odd = rng.nextInt(0,2); const t = pickNot(s);
//     for (let i = 0; i < 3; i++) mid[i] = i === odd ? t : s;
//   } else {
//     mid[0] = rng.pick(SLOT_SYMBOLS);
//     do { mid[1] = rng.pick(SLOT_SYMBOLS); } while (mid[1] === mid[0]);
//     do { mid[2] = rng.pick(SLOT_SYMBOLS); } while (mid[2] === mid[0] || mid[2] === mid[1]);
//   }
//   for (let i = 0; i < 3; i++) grid[midStart + i] = mid[i];
//   return grid;
// }
// function computePayoutLamports(betLamports, payoutMul, feePct) {
//   const SCALE = 1_000_000n;
//   const mul = BigInt(Math.round(payoutMul * 1_000_000));
//   const fee = BigInt(Math.round(feePct * 1_000_000));
//   const bet = BigInt(betLamports);
//   const gross = (bet * mul) / SCALE;
//   const feeAmt = (bet * fee) / SCALE;
//   const net = gross > feeAmt ? gross - feeAmt : 0n;
//   return net;
// }
// function computeSpin({ serverSeed, clientSeed, nonce, betLamports, feePct }) {
//   const rng = makeRng({ serverSeed, clientSeed, nonce });
//   const outcome = pickOutcome(rng, nonce);
//   const grid = buildGridForOutcome({ rng, outcome });
//   const payoutLamports = computePayoutLamports(betLamports, outcome.payoutMul, feePct);
//   return { outcome, grid, payoutLamports };
// }

// // ---------- State ----------
// const slotsPending = new Map();
// const FIXED_BET_TYPE = 0;
// const FIXED_TARGET = 50;

// // ---------- WS ----------
// function attachSlots(io) {
//   io.on("connection", (socket) => {
//     socket.on("register", ({ player }) => { socket.data.player = String(player || "guest"); });

//     // FIRST POPUP — leave as-is
//     socket.on("slots:prepare_lock", async ({ player, betAmountLamports, clientSeed }) => {
//       try {
//         if (!player)
//           return socket.emit("slots:error", { code: "NO_PLAYER", message: "player required" });

//         // admin gate + min/max
//         const cfg = await DB.getGameConfig?.("slots");
//         if (cfg && (!cfg.enabled || !cfg.running)) {
//           return socket.emit("slots:error", { code: "DISABLED", message: "Slots disabled by admin" });
//         }
//         const min = BigInt(cfg?.min_bet_lamports ?? 50000n);
//         const max = BigInt(cfg?.max_bet_lamports ?? 5_000_000_000n);

//         const betLamports = BigInt(betAmountLamports || 0);
//         if (betLamports <= 0n) return socket.emit("slots:error", { code: "BAD_BET", message: "betAmountLamports invalid" });
//         if (betLamports < min || betLamports > max) {
//           return socket.emit("slots:error", { code: "BET_RANGE", message: "Bet outside allowed range" });
//         }

//         const playerPk = new PublicKey(player);
//         const vaultPda = deriveVaultPda();

//         const nonce = Date.now();
//         const expiryUnix =
//           Math.floor(Date.now() / 1000) + Number(process.env.NONCE_TTL_SECONDS || 300);

//         const nb = Buffer.alloc(8);
//         nb.writeBigUInt64LE(BigInt(nonce));
//         const pendingBetPda = PublicKey.findProgramAddressSync(
//           [Buffer.from("bet"), playerPk.toBuffer(), nb],
//           PROGRAM_ID
//         )[0];

//         const serverSeed = crypto.randomBytes(32);
//         const serverSeedHash = sha256Hex(serverSeed);
//         const feePct = getFeePctFromConfig(cfg);

//         const dataLock = encodePlaceBetLockArgs({
//           betAmount: betLamports, betType: FIXED_BET_TYPE, target: FIXED_TARGET, nonce, expiryUnix
//         });
//         const keysLock = placeBetLockKeys({ player: playerPk, vaultPda, pendingBetPda });
//         const ixLock = { programId: PROGRAM_ID, keys: keysLock, data: dataLock };

//         const cuLimit = ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 });
//         const { blockhash } = await connection.getLatestBlockhash("confirmed");
//         const msgV0 = new TransactionMessage({
//           payerKey: playerPk, recentBlockhash: blockhash, instructions: [cuLimit, ixLock]
//         }).compileToV0Message();
//         const vtx = new VersionedTransaction(msgV0);
//         const txBase64 = Buffer.from(vtx.serialize()).toString("base64");

//         try {
//           if (typeof DB.pool?.query === "function") {
//             await DB.pool.query(
//               `insert into slots_spins(player, bet_amount, client_seed, server_seed_hash, server_seed, nonce, status, fee_pct)
//                values ($1,$2,$3,$4,$5,$6,'prepared',$7)`,
//               [player, betLamports.toString(), String(clientSeed || ""), serverSeedHash, serverSeed.toString("hex"), BigInt(nonce), feePct]
//             );
//           } else {
//             slotsPending.set(nonce, {
//               player, betLamports, clientSeed: String(clientSeed || ""),
//               serverSeed, serverSeedHash, expiryUnix,
//               pendingBetPda: pendingBetPda.toBase58(), betType: FIXED_BET_TYPE, target: FIXED_TARGET, feePct
//             });
//           }
//         } catch (e) {
//           console.error("slots DB save error:", e);
//         }

//         socket.emit("slots:lock_tx", {
//           nonce: String(nonce),
//           expiryUnix,
//           serverSeedHash,
//           feePct,
//           pendingBetPda: pendingBetPda.toBase58(),
//           transactionBase64: txBase64,
//         });
//       } catch (e) {
//         console.error("slots:prepare_lock error:", e);
//         socket.emit("slots:error", { code: "PREPARE_FAIL", message: String(e.message || e) });
//       }
//     });

//     // NO SECOND POPUP — server sends resolve tx and returns result + txSig
//     socket.on("slots:prepare_resolve", async ({ player, nonce }) => {
//       try {
//         if (!player) return socket.emit("slots:error", { code: "NO_PLAYER", message: "player required" });
//         if (!nonce)  return socket.emit("slots:error", { code: "NO_NONCE",  message: "nonce required" });

//         const playerPk = new PublicKey(player);

//         let ctx = slotsPending.get(Number(nonce));
//         if (!ctx && typeof DB.pool?.query === "function") {
//           const r = await DB.pool.query(
//             `select * from slots_spins where nonce=$1 and player=$2 limit 1`,
//             [BigInt(nonce), player]
//           );
//           const row = r.rows[0] || null;
//           if (row) {
//             ctx = {
//               player,
//               betLamports: BigInt(row.bet_amount),
//               clientSeed: row.client_seed,
//               serverSeed: Buffer.from(row.server_seed, "hex"),
//               serverSeedHash: row.server_seed_hash,
//               expiryUnix: 0,
//               betType: FIXED_BET_TYPE,
//               target: FIXED_TARGET,
//               feePct: Number(row.fee_pct || 0.05),
//             };
//           }
//         }
//         if (!ctx) {
//           return socket.emit("slots:error", { code: "NOT_FOUND", message: "no prepared spin for nonce" });
//         }

//         const vaultPda = deriveVaultPda();
//         const nb = Buffer.alloc(8); nb.writeBigUInt64LE(BigInt(nonce));
//         const pendingBetPda = PublicKey.findProgramAddressSync(
//           [Buffer.from("bet"), playerPk.toBuffer(), nb], PROGRAM_ID
//         )[0];

//         // Compute server-authoritative outcome
//         const { outcome, grid, payoutLamports } = computeSpin({
//           serverSeed: ctx.serverSeed,
//           clientSeed: ctx.clientSeed,
//           nonce: Number(nonce),
//           betLamports: ctx.betLamports,
//           feePct: ctx.feePct ?? 0.05,
//         });

//         const willWin = payoutLamports > 0n;
//         const roll = willWin ? 1 : 100;
//         const expiryUnix = Math.floor(Date.now() / 1000) + 120;

//         // Admin message/sign (same as before)
//         const msg = buildMessageBytes({
//           programId: PROGRAM_ID.toBuffer(),
//           vault: vaultPda.toBuffer(),
//           player: playerPk.toBuffer(),
//           betAmount: Number(ctx.betLamports),
//           betType: ctx.betType,
//           target: ctx.target,
//           roll,
//           payout: Number(payoutLamports),
//           nonce: Number(nonce),
//           expiryUnix,
//         });
//         const edSig = await signMessageEd25519(msg);
//         const edIx  = buildEd25519VerifyIx({ message: msg, signature: edSig, publicKey: ADMIN_PK });
//         const edIndex = 1; // [CU, ed25519, resolve]

//         const keysResolve = [
//           { pubkey: playerPk, isSigner: false, isWritable: true },
//           { pubkey: vaultPda, isSigner: false, isWritable: true },
//           { pubkey: deriveAdminPda(), isSigner: false, isWritable: false },
//           { pubkey: pendingBetPda, isSigner: false, isWritable: true },
//           { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
//           { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
//         ];
//         const dataResolve = encodeResolveBetArgs({
//           roll,
//           payout: Number(payoutLamports),
//           ed25519InstrIndex: edIndex,
//         });
//         const ixResolve = { programId: PROGRAM_ID, keys: keysResolve, data: dataResolve };

//         // ---- SERVER FEE PAYER ----
//         const feePayer = await getServerKeypair();
//         const cuLimit  = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });
//         const { blockhash } = await connection.getLatestBlockhash("confirmed");
//         const msgV0 = new TransactionMessage({
//           payerKey: feePayer.publicKey,
//           recentBlockhash: blockhash,
//           instructions: [cuLimit, edIx, ixResolve],
//         }).compileToV0Message();

//         const vtx = new VersionedTransaction(msgV0);

//         // (optional) simulate
//         const sim = await connection.simulateTransaction(vtx, { sigVerify: false });
//         if (sim.value.err) {
//           const logs = (sim.value.logs || []).join("\n");
//           throw new Error(`Resolve simulate failed: ${JSON.stringify(sim.value.err)}\n${logs}`);
//         }

//         vtx.sign([feePayer]);
//         const sig = await connection.sendRawTransaction(vtx.serialize(), { skipPreflight: false, maxRetries: 5 });
//         await connection.confirmTransaction(sig, "confirmed");

//         // persist
//         try {
//           await DB.recordGameRound?.({
//             game_key: "slots",
//             player,
//             nonce: Number(nonce),
//             stake_lamports: Number(ctx.betLamports),
//             payout_lamports: Number(payoutLamports),
//             result_json: { outcome: outcome.key, grid },
//           });
//           if (payoutLamports > 0n) {
//             await DB.recordActivity?.({
//               user: player,
//               action: "Slots win",
//               amount: (Number(payoutLamports)/1e9).toFixed(4),
//             });
//           }
//           if (typeof DB.pool?.query === "function") {
//             await DB.pool.query(
//               `update slots_spins set grid_json=$1, payout=$2, status='resolved', resolve_sig=$3 where nonce=$4 and player=$5`,
//               [JSON.stringify(grid), Number(payoutLamports), sig, BigInt(nonce), player]
//             );
//           }
//         } catch (e) {
//           console.warn("slots: stat save warn:", e?.message || e);
//         }

//         // tell client: final result + txSig (no popup)
//         socket.emit("slots:resolved", {
//           nonce: String(nonce),
//           roll,
//           outcome: outcome.key,
//           grid, // exactly 9 symbols
//           payoutLamports: Number(payoutLamports),
//           feePct: ctx.feePct ?? 0.05,
//           txSig: sig,
//         });
//       } catch (e) {
//         console.error("slots:prepare_resolve error:", e);
//         socket.emit("slots:error", { code: "RESOLVE_PREP_FAIL", message: String(e.message || e) });
//       }
//     });
//   });
// }

// module.exports = { attachSlots };



// backend/slots_ws.js — unified with Dice/Mines: single smart vault, one program id, server fee-payer

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
  derivePendingSpinPda,
  buildEd25519VerifyIx,
} = require("./solana");

const { ixSlotsLock, ixSlotsResolve } = require("./solana_anchor_ix");
const { ADMIN_PK, getServerKeypair } = require("./signer");
const DB = global.db || require("./db");
const { precheckOrThrow } = require("./bonus_guard");


const SYSVAR_INSTRUCTIONS_PUBKEY = new PublicKey("Sysvar1nstructions1111111111111111111111111");

// ---------- RNG & Paytable ----------
function sha256Hex(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}
function makeRng({ serverSeed, clientSeed, nonce }) {
  let counter = 0,
    pool = Buffer.alloc(0);
  function refill() {
    const h = crypto
      .createHmac("sha256", serverSeed)
      .update(String(clientSeed || ""))
      .update(Buffer.from(String(nonce)))
      .update(
        Buffer.from([
          counter & 0xff,
          (counter >> 8) & 0xff,
          (counter >> 16) & 0xff,
          (counter >> 24) & 0xff,
        ])
      )
      .digest();
    counter++;
    pool = Buffer.concat([pool, h]);
  }
  function nextU32() {
    if (pool.length < 4) refill();
    const x = pool.readUInt32BE(0);
    pool = pool.slice(4);
    return x >>> 0;
  }
  function nextFloat() {
    return nextU32() / 2 ** 32;
  }
  function nextInt(min, max) {
    const span = max - min + 1;
    return min + Math.floor(nextFloat() * span);
  }
  function pick(arr) {
    return arr[nextInt(0, arr.length - 1)];
  }
  return { nextU32, nextFloat, nextInt, pick };
}

const SLOT_SYMBOLS = ["floki", "wif", "brett", "shiba", "bonk", "doge", "pepe", "sol", "zoggy"];
const SLOTS_CELLS = 9;

const PAYTABLE = [
  { key: "near_miss", type: "near", payoutMul: 0.8, freq: 0.24999992500002252 },
  { key: "triple_floki", type: "triple", symbol: "floki", payoutMul: 1.5, freq: 0.04999998500000451 },
  { key: "triple_wif", type: "triple", symbol: "wif", payoutMul: 1.5, freq: 0.04999998500000451 },
  { key: "triple_brett", type: "triple", symbol: "brett", payoutMul: 1.5, freq: 0.04999998500000451 },
  { key: "triple_shiba", type: "triple", symbol: "shiba", payoutMul: 3, freq: 0.023609992917002123 },
  { key: "triple_bonk", type: "triple", symbol: "bonk", payoutMul: 6, freq: 0.011804996458501062 },
  { key: "triple_doge", type: "triple", symbol: "doge", payoutMul: 10, freq: 0.007082997875100638 },
  { key: "triple_pepe", type: "triple", symbol: "pepe", payoutMul: 20, freq: 0.003541998937400319 },
  { key: "triple_sol", type: "triple", symbol: "sol", payoutMul: 50, freq: 0.001416999574900128 },
  { key: "triple_zoggy", type: "triple", symbol: "zoggy", payoutMul: 100, freq: 0.000708299787510064 },
  { key: "jackpot", type: "triple", symbol: "zoggy", payoutMul: 1000, freq: 0 },
  { key: "loss", type: "loss", payoutMul: 0, freq: 0.5518348344495496 },
];

const CDF = (() => {
  const rows = PAYTABLE.filter((p) => p.key !== "jackpot");
  let acc = 0;
  return rows.map((r) => {
    acc += r.freq;
    return { ...r, cum: acc };
  });
})();
const JACKPOT_NONCES = new Set(
  String(process.env.SLOTS_JACKPOT_NONCES || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);

function getFeePctFromConfig(cfg) {
  const bps = Number(cfg?.fee_bps ?? 500);
  return Math.max(0, bps) / 10000;
}
function pickOutcome(rng, nonce) {
  if (JACKPOT_NONCES.has(String(nonce))) return PAYTABLE.find((p) => p.key === "jackpot");
  const r = rng.nextFloat();
  for (const row of CDF) if (r < row.cum) return row;
  return PAYTABLE.find((p) => p.key === "loss");
}
function buildGridForOutcome({ rng, outcome }) {
  const grid = [];
  for (let i = 0; i < SLOTS_CELLS; i++) grid.push(rng.pick(SLOT_SYMBOLS));
  const midStart = 3;
  const mid = grid.slice(midStart, midStart + 3);
  const pickNot = (exclude) => {
    let s;
    do {
      s = rng.pick(SLOT_SYMBOLS);
    } while (s === exclude);
    return s;
  };

  if (outcome.type === "triple") {
    const s = outcome.symbol;
    mid[0] = s;
    mid[1] = s;
    mid[2] = s;
  } else if (outcome.type === "near") {
    const s = rng.pick(SLOT_SYMBOLS);
    const odd = rng.nextInt(0, 2);
    const t = pickNot(s);
    for (let i = 0; i < 3; i++) mid[i] = i === odd ? t : s;
  } else {
    mid[0] = rng.pick(SLOT_SYMBOLS);
    do {
      mid[1] = rng.pick(SLOT_SYMBOLS);
    } while (mid[1] === mid[0]);
    do {
      mid[2] = rng.pick(SLOT_SYMBOLS);
    } while (mid[2] === mid[0] || mid[2] === mid[1]);
  }
  for (let i = 0; i < 3; i++) grid[midStart + i] = mid[i];
  return grid;
}
function computePayoutLamports(betLamports, payoutMul, feePct) {
  const SCALE = 1_000_000n;
  const mul = BigInt(Math.round(payoutMul * 1_000_000));
  const fee = BigInt(Math.round(feePct * 1_000_000));
  const bet = BigInt(betLamports);
  const gross = (bet * mul) / SCALE;
  const feeAmt = (bet * fee) / SCALE;
  const net = gross > feeAmt ? gross - feeAmt : 0n;
  return net;
}
function computeSpin({ serverSeed, clientSeed, nonce, betLamports, feePct }) {
  const rng = makeRng({ serverSeed, clientSeed, nonce });
  const outcome = pickOutcome(rng, nonce);
  const grid = buildGridForOutcome({ rng, outcome });
  const payoutLamports = computePayoutLamports(betLamports, outcome.payoutMul, feePct);
  return { outcome, grid, payoutLamports };
}

// Small checksum for event/audit (program doesn’t validate value)
const slotsChecksum = (nonce) => Number((BigInt(nonce) % 251n) + 1n) & 0xff;

// ---------- State ----------
const slotsPending = new Map();

// ---------- WS ----------
function attachSlots(io) {
  io.on("connection", (socket) => {
    socket.on("register", ({ player }) => {
      socket.data.player = String(player || "guest");
    });

    /**
     * SLOTS PLACE (server signs & sends lock; no client signing)
     * in:  { player, betAmountLamports, clientSeed? }
     * out: "slots:locked" { nonce, txSig, serverSeedHash }
     */
    socket.on("slots:place", async ({ player, betAmountLamports, clientSeed }) => {
      try {
        if (!player)
          return socket.emit("slots:error", { code: "NO_PLAYER", message: "player required" });

        const cfg = await DB.getGameConfig?.("slots");
        if (cfg && (!cfg.enabled || !cfg.running)) {
          return socket.emit("slots:error", { code: "DISABLED", message: "Slots disabled by admin" });
        }

        const min = BigInt(cfg?.min_bet_lamports ?? 50000n);
        const max = BigInt(cfg?.max_bet_lamports ?? 5_000_000_000n);
        const betLamports = BigInt(betAmountLamports || 0);
        if (betLamports <= 0n)
          return socket.emit("slots:error", {
            code: "BAD_BET",
            message: "betAmountLamports invalid",
          });
        if (betLamports < min || betLamports > max)
          return socket.emit("slots:error", {
            code: "BET_RANGE",
            message: "Bet outside allowed range",
          });
          // Bonus guard check (welcome bonus, max bet, WR, etc.)
await precheckOrThrow({
  userWallet: player,                  // base58 pubkey
  stakeLamports: betLamports.toString(), // string, not BigInt
  gameKey: "slots",
});


        const playerPk = new PublicKey(player);
        const userVault = deriveUserVaultPda(playerPk);
        const houseVault = deriveVaultPda();
        const nonce = Date.now();
        const expiryUnix =
          Math.floor(Date.now() / 1000) + Number(process.env.NONCE_TTL_SECONDS || 300);
        const pending = derivePendingSpinPda(playerPk, nonce);

        // Admin ed25519 presence
        const msg = Buffer.from(`SLOTS|${player}|${betLamports.toString()}|${nonce}|${expiryUnix}`);
        const { ADMIN_PK: ADMIN_PK_LOCAL, signMessageEd25519 } = require("./signer");
        const edSig = await signMessageEd25519(msg);
        const edIx = buildEd25519VerifyIx({
          message: msg,
          signature: edSig,
          publicKey: ADMIN_PK_LOCAL,
        });
        const edIndex = 2;

        const feePayer = await getServerKeypair();
        const cuPrice = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 });
        const cuLimit = ComputeBudgetProgram.setComputeUnitLimit({ units: 350_000 });

        
        const lockIx = ixSlotsLock({
          programId: PROGRAM_ID,
          player: playerPk,
          feePayer: feePayer.publicKey,
          userVault,
          houseVault,
          pendingSpin: pending,
          betAmount: Number(betLamports),
          nonce,
          expiryUnix,
          edIndex,
        });

        const { blockhash } = await connection.getLatestBlockhash("confirmed");
        const msgV0 = new TransactionMessage({
          payerKey: feePayer.publicKey,
          recentBlockhash: blockhash,
          instructions: [cuPrice, cuLimit, edIx, lockIx],
        }).compileToV0Message();

        const vtx = new VersionedTransaction(msgV0);
        const sim = await connection.simulateTransaction(vtx, { sigVerify: false });
        if (sim.value.err) {
          const logs = (sim.value.logs || []).join("\n");
          throw new Error(`Slots lock simulate failed: ${JSON.stringify(sim.value.err)}\n${logs}`);
        }

        vtx.sign([feePayer]);
        const txSig = await connection.sendRawTransaction(vtx.serialize(), {
          skipPreflight: false,
          maxRetries: 5,
        });
        await connection.confirmTransaction(txSig, "confirmed");

        // Prepare server seed and store context
        const serverSeed = crypto.randomBytes(32);
        const serverSeedHash = sha256Hex(serverSeed);
        const feePct = getFeePctFromConfig(cfg);

        slotsPending.set(nonce, {
          player,
          betLamports,
          clientSeed: String(clientSeed || ""),
          serverSeed,
          serverSeedHash,
          expiryUnix,
          feePct,
        });

        try {
          if (typeof DB.pool?.query === "function") {
            await DB.pool.query(
              `insert into slots_spins(player, bet_amount, client_seed, server_seed_hash, server_seed, nonce, status, fee_pct, lock_sig)
               values ($1,$2,$3,$4,$5,$6,'locked',$7,$8)`,
              [
                player,
                betLamports.toString(),
                String(clientSeed || ""),
                serverSeedHash,
                serverSeed.toString("hex"),
                BigInt(nonce),
                feePct,
                txSig,
              ]
            );
          }
        } catch (e) {
          console.warn("slots: DB insert warn:", e?.message || e);
        }

        // 🔔 Emit lock (now includes serverSeedHash for UI)
        socket.emit("slots:locked", { nonce: String(nonce), txSig, serverSeedHash });
      } catch (e) {
        console.error("slots:place error:", e);
        socket.emit("slots:error", { code: "PLACE_FAIL", message: String(e.message || e) });
      }
    });

    /**
     * SLOTS RESOLVE
     * in:  { player, nonce }
     * out: "slots:resolved" { nonce, outcome, grid, payoutLamports, feePct, txSig }
     */
    socket.on("slots:resolve", async ({ player, nonce }) => {
      try {
        if (!player)
          return socket.emit("slots:error", { code: "NO_PLAYER", message: "player required" });
        if (!nonce)
          return socket.emit("slots:error", { code: "NO_NONCE", message: "nonce required" });

        const playerPk = new PublicKey(player);
        let ctx = slotsPending.get(Number(nonce));

        // restore from DB if missing (server restart)
        if (!ctx && typeof DB.pool?.query === "function") {
          try {
            const r = await DB.pool.query(
              `select * from slots_spins where nonce=$1 and player=$2 limit 1`,
              [BigInt(nonce), player]
            );
            const row = r.rows[0] || null;
            if (row) {
              ctx = {
                player,
                betLamports: BigInt(row.bet_amount),
                clientSeed: row.client_seed,
                serverSeed: Buffer.from(row.server_seed, "hex"),
                serverSeedHash: row.server_seed_hash,
                expiryUnix: 0,
                feePct: Number(row.fee_pct || 0.05),
              };
            }
          } catch {}
        }

        if (!ctx) {
          return socket.emit("slots:error", {
            code: "NOT_FOUND",
            message: "no prepared spin for nonce",
          });
        }

        const userVault = deriveUserVaultPda(playerPk);
        const houseVault = deriveVaultPda();
        const adminPda = deriveAdminPda();
        const pending = derivePendingSpinPda(playerPk, nonce);

        // Compute outcome
        const { outcome, grid, payoutLamports } = computeSpin({
          serverSeed: ctx.serverSeed,
          clientSeed: ctx.clientSeed,
          nonce: Number(nonce),
          betLamports: ctx.betLamports,
          feePct: ctx.feePct ?? 0.05,
        });

        // checksum for event
        const checksum = slotsChecksum(nonce);
        const expiryUnix = Math.floor(Date.now() / 1000) + 120;

        // Admin ed25519 presence
        const resolveMsg = Buffer.from(
          `SLOTS_RESOLVE|${player}|${nonce}|${checksum}|${Number(payoutLamports)}`
        );
        const { ADMIN_PK: ADMIN_PK_LOCAL, signMessageEd25519 } = require("./signer");
        const edSig = await signMessageEd25519(resolveMsg);
        const edIx = buildEd25519VerifyIx({
          message: resolveMsg,
          signature: edSig,
          publicKey: ADMIN_PK_LOCAL,
        });

        // We'll send [cuLimit, edIx, resolve]; ed index = 1
        const edIndex = 1;

        const ixResolve = ixSlotsResolve({
          programId: PROGRAM_ID,
          player: playerPk,
          houseVault,
          adminPda,
          userVault,
          pendingSpin: pending,
          checksum,
          payout: Number(payoutLamports),
          edIndex,
        });

        const feePayer = await getServerKeypair();
        const cuLimit = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });

        const { blockhash } = await connection.getLatestBlockhash("confirmed");
        const msgV0 = new TransactionMessage({
          payerKey: feePayer.publicKey,
          recentBlockhash: blockhash,
          instructions: [cuLimit, edIx, ixResolve],
        }).compileToV0Message();

        const vtx = new VersionedTransaction(msgV0);
        const sim = await connection.simulateTransaction(vtx, { sigVerify: false });
        if (sim.value.err) {
          const logs = (sim.value.logs || []).join("\n");
          throw new Error(
            `Slots resolve simulate failed: ${JSON.stringify(sim.value.err)}\n${logs}`
          );
        }

        vtx.sign([feePayer]);
        const txSig = await connection.sendRawTransaction(vtx.serialize(), {
          skipPreflight: false,
          maxRetries: 5,
        });
        await connection.confirmTransaction(txSig, "confirmed");

        try {
          await DB.recordGameRound?.({
            game_key: "slots",
            player,
            nonce: Number(nonce),
            stake_lamports: Number(ctx.betLamports),
            payout_lamports: Number(payoutLamports),
            result_json: { outcome: outcome.key, grid },
          });
          if (payoutLamports > 0n) {
            await DB.recordActivity?.({
              user: player,
              action: "Slots win",
              amount: (Number(payoutLamports) / 1e9).toFixed(4),
            });
          }
          if (typeof DB.pool?.query === "function") {
            await DB.pool.query(
              `update slots_spins set grid_json=$1, payout=$2, status='resolved', resolve_sig=$3 where nonce=$4 and player=$5`,
              [JSON.stringify(grid), Number(payoutLamports), txSig, BigInt(nonce), player]
            );
          }
        } catch (e) {
          console.warn("slots: DB update warn:", e?.message || e);
        }

        socket.emit("slots:resolved", {
          nonce: String(nonce),
          outcome: outcome.key,
          grid,
          payoutLamports: Number(payoutLamports),
          feePct: ctx.feePct ?? 0.05,
          txSig,
        });

        slotsPending.delete(Number(nonce));
      } catch (e) {
        console.error("slots:resolve error:", e);
        socket.emit("slots:error", { code: "RESOLVE_FAIL", message: String(e.message || e) });
      }
    });

    // ---- Legacy shims (optional) ----
    socket.on("slots:prepare_lock", async (payload) => {
      // run place and translate response event name to "slots:lock_tx" for older frontends
      const originalEmit = socket.emit.bind(socket);
      socket.emit = (ev, data) => {
        if (ev === "slots:locked") {
          // rename and forward
          originalEmit("slots:lock_tx", data);
          return;
        }
        return originalEmit(ev, data);
      };
      await new Promise((res) => {
        socket.once("slots:lock_tx", res);
        originalEmit("slots:place", payload);
      });
      socket.emit = originalEmit;
    });

    socket.on("slots:prepare_resolve", async (payload) => {
      // direct map to slots:resolve
      await new Promise((res) => {
        const done = () => res();
        socket.once("slots:resolved", done);
        socket.emit("slots:resolve", payload);
      });
    });
  });
}

module.exports = { attachSlots };

