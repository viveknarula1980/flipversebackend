// backend/slots_ws.js — DB gating + optional unified stats writing

// // slots_ws.js — RTP 85%, near-miss, fee, controlled jackpot, deterministic outcomes
// const crypto = require("crypto");
// const fs = require("fs");
// const os = require("os");
// const path = require("path");
// const {
//   PublicKey,
//   VersionedTransaction,
//   TransactionMessage,
//   SystemProgram,
//   ComputeBudgetProgram,
//   Keypair,
// } = require("@solana/web3.js");

// const {
//   connection,
//   PROGRAM_ID,
//   deriveVaultPda,
//   deriveAdminPda,
//   buildEd25519VerifyIx,
// } = require("./solana");
// const { ADMIN_PK, buildMessageBytes, signMessageEd25519 } = require("./signer");

// const SYSVAR_INSTRUCTIONS_PUBKEY = new PublicKey(
//   "Sysvar1nstructions1111111111111111111111111"
// );

// // ---------- Helpers: Anchor discriminator + RNG ----------
// function anchorDisc(globalSnakeName) {
//   return crypto.createHash("sha256").update(`global:${globalSnakeName}`).digest().slice(0, 8);
// }

// function sha256Hex(buf) {
//   return crypto.createHash("sha256").update(buf).digest("hex");
// }

// // Deterministic HMAC-SHA256 RNG from (serverSeed, clientSeed, nonce)
// function makeRng({ serverSeed, clientSeed, nonce }) {
//   let counter = 0;
//   let pool = Buffer.alloc(0);

//   function refill() {
//     const h = crypto.createHmac("sha256", serverSeed)
//       .update(String(clientSeed || ""))
//       .update(Buffer.from(String(nonce)))
//       .update(Buffer.from([counter & 0xff, (counter >> 8) & 0xff, (counter >> 16) & 0xff, (counter >> 24) & 0xff]))
//       .digest();
//     counter++;
//     pool = Buffer.concat([pool, h]);
//   }

//   function nextU32() {
//     if (pool.length < 4) refill();
//     const x = pool.readUInt32BE(0);
//     pool = pool.slice(4);
//     return x >>> 0;
//   }

//   function nextFloat() {
//     // [0, 1)
//     return nextU32() / 2 ** 32;
//   }

//   function nextInt(minIncl, maxIncl) {
//     const span = maxIncl - minIncl + 1;
//     const v = Math.floor(nextFloat() * span);
//     return minIncl + v;
//   }

//   function pick(arr) {
//     return arr[nextInt(0, arr.length - 1)];
//   }

//   return { nextU32, nextFloat, nextInt, pick };
// }

// // ---------- Encoding for on-chain program ----------
// function encodePlaceBetLockArgs({ betAmount, betType, target, nonce, expiryUnix }) {
//   const disc = anchorDisc("place_bet_lock");
//   const buf = Buffer.alloc(8 + 8 + 1 + 1 + 8 + 8);
//   let o = 0;
//   disc.copy(buf, o); o += 8;
//   buf.writeBigUInt64LE(BigInt(betAmount), o); o += 8;
//   buf.writeUInt8(betType & 0xff, o++);          // fixed=0
//   buf.writeUInt8(target & 0xff, o++);           // fixed=50
//   buf.writeBigUInt64LE(BigInt(nonce), o); o += 8;
//   buf.writeBigInt64LE(BigInt(expiryUnix), o); o += 8;
//   return buf;
// }

// function encodeResolveBetArgs({ roll, payout, ed25519InstrIndex }) {
//   const disc = anchorDisc("resolve_bet");
//   const buf = Buffer.alloc(8 + 1 + 8 + 1);
//   let o = 0;
//   disc.copy(buf, o); o += 8;
//   buf.writeUInt8(roll & 0xff, o++);                 // 1 for win, 100 for loss
//   buf.writeBigUInt64LE(BigInt(payout), o); o += 8;  // lamports
//   buf.writeUInt8(ed25519InstrIndex & 0xff, o++);    // index of ed25519 verify ix
//   return buf;
// }

// function placeBetLockKeys({ player, vaultPda, pendingBetPda }) {
//   return [
//     { pubkey: player, isSigner: true, isWritable: true },
//     { pubkey: vaultPda, isSigner: false, isWritable: true },
//     { pubkey: pendingBetPda, isSigner: false, isWritable: true },
//     { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
//   ];
// }

// // ---------- Game constants ----------
// const SLOT_SYMBOLS = ["🍒","🍋","🍊","🍇","⭐","💎","🍎","🍓","7️⃣"]; // keep your symbols
// const SLOTS_CELLS = 15; // 3x5

// // Payout table + target frequencies (sum ≈ 1.0). Jackpot is controlled-only.
// const PAYTABLE = [
//   // Near-miss (any window of 3 in mid row has exactly 2 same + 1 different)
//   { key: "near_miss", type: "near", payoutMul: 0.8, freq: 0.24999992500002252 },

//   // Triples by symbol (3-of-a-kind contiguous in mid row)
//   { key: "triple_cherry",    type: "triple", symbol: "🍒", payoutMul: 1.5,  freq: 0.04999998500000451 },
//   { key: "triple_lemon",     type: "triple", symbol: "🍋", payoutMul: 1.5,  freq: 0.04999998500000451 },
//   { key: "triple_orange",    type: "triple", symbol: "🍊", payoutMul: 1.5,  freq: 0.04999998500000451 },
//   { key: "triple_grape",     type: "triple", symbol: "🍇", payoutMul: 3,    freq: 0.023609992917002123 },
//   { key: "triple_star",      type: "triple", symbol: "⭐",  payoutMul: 6,    freq: 0.011804996458501062 },
//   { key: "triple_diamond",   type: "triple", symbol: "💎", payoutMul: 10,   freq: 0.007082997875100638 },
//   { key: "triple_apple",     type: "triple", symbol: "🍎", payoutMul: 20,   freq: 0.003541998937400319 },
//   { key: "triple_strawberry",type: "triple", symbol: "🍓", payoutMul: 50,   freq: 0.001416999574900128 },
//   { key: "triple_seven",     type: "triple", symbol: "7️⃣", payoutMul: 100, freq: 0.000708299787510064 },

//   // Controlled-only jackpot (same symbol as seven, but 1000x by admin control)
//   { key: "jackpot",          type: "triple", symbol: "7️⃣", payoutMul: 1000, freq: 0 },

//   // Loss (no triple, no near-miss across any 3-consecutive in mid row)
//   { key: "loss",             type: "loss",   payoutMul: 0,    freq: 0.5518348344495496 },
// ];

// // Fee per spin (percentage of bet). Default 5% -> 0.05
// const FEE_PCT = Math.max(0, Math.min(1, Number(process.env.SLOTS_FEE_PCT ?? "0.05")));
// // Optionally force a jackpot on specific nonces: e.g. SLOTS_JACKPOT_NONCES="1724112345678,1724118888888"
// const JACKPOT_NONCES = new Set(String(process.env.SLOTS_JACKPOT_NONCES || "")
//   .split(",")
//   .map(s => s.trim())
//   .filter(Boolean));

// // ---------- Outcome selection + grid synthesis ----------

// // Precompute cumulative distribution (excluding jackpot; it's controlled)
// const CDF = (() => {
//   const rows = PAYTABLE.filter(p => p.key !== "jackpot");
//   let acc = 0;
//   return rows.map(r => {
//     acc += r.freq;
//     return { ...r, cum: acc };
//   });
// })();

// function pickOutcome(rng, nonce) {
//   if (JACKPOT_NONCES.has(String(nonce))) {
//     return PAYTABLE.find(p => p.key === "jackpot");
//   }
//   const r = rng.nextFloat();
//   for (const row of CDF) {
//     if (r < row.cum) return row;
//   }
//   // Safety net due to float rounding:
//   return PAYTABLE.find(p => p.key === "loss");
// }

// // Build a 3x5 grid and inject the desired outcome into the middle row (indices 5..9).
// function buildGridForOutcome({ rng, outcome }) {
//   // start with random grid
//   const grid = [];
//   for (let i = 0; i < SLOTS_CELLS; i++) grid.push(rng.pick(SLOT_SYMBOLS));

//   // middle row indices
//   const midStart = 5;
//   const mid = grid.slice(midStart, midStart + 5);

//   // helper to avoid unwanted extra patterns
//   const pickNot = (exclude) => {
//     let s;
//     do { s = rng.pick(SLOT_SYMBOLS); } while (s === exclude);
//     return s;
//   };

//   // Place outcome in the mid row
//   if (outcome.type === "triple") {
//     const s = outcome.symbol;
//     const startCol = rng.nextInt(0, 2); // place at [start,start+1,start+2]
//     for (let i = 0; i < 5; i++) mid[i] = rng.pick(SLOT_SYMBOLS); // re-roll mid
//     mid[startCol] = s;
//     mid[startCol + 1] = s;
//     mid[startCol + 2] = s;

//     // fill the two remaining mid cells with not-s to avoid 4/5-of-kind illusions
//     for (let i = 0; i < 5; i++) {
//       if (i < startCol || i > startCol + 2) {
//         mid[i] = pickNot(s);
//       }
//     }
//   } else if (outcome.type === "near") {
//     // near-miss: exactly two same and one different in one window of 3
//     const s = rng.pick(SLOT_SYMBOLS);
//     const startCol = rng.nextInt(0, 2);
//     for (let i = 0; i < 5; i++) mid[i] = rng.pick(SLOT_SYMBOLS);

//     const oddPos = rng.nextInt(0, 2); // 0,1,2 → choose which within the triple window is different
//     const t = pickNot(s);
//     for (let j = 0; j < 3; j++) {
//       mid[startCol + j] = (j === oddPos) ? t : s;
//     }

//     // Ensure no other window accidentally forms a triple
//     // Force neighboring cells (outside the window) to not create 3-in-a-row or another near-miss window
//     const forbid = new Set([s, t]);
//     for (let i = 0; i < 5; i++) {
//       if (i < startCol || i > startCol + 2) {
//         // choose something not equal to left/right to reduce chance of unintended patterns
//         let candidate = rng.pick(SLOT_SYMBOLS);
//         let guard = 0;
//         while (forbid.has(candidate) && guard++ < 10) candidate = rng.pick(SLOT_SYMBOLS);
//         mid[i] = candidate;
//       }
//     }
//   } else {
//     // loss: ensure every 3-consecutive window in mid row has all 3 distinct (no near-miss, no triple)
//     // Simple strategy: ensure no adjacent equals, which prevents any AAB/ABA/BAA/AAA within any 3-window.
//     for (let i = 0; i < 5; i++) {
//       let s = rng.pick(SLOT_SYMBOLS);
//       if (i > 0) {
//         let guard = 0;
//         while (s === mid[i - 1] && guard++ < 20) s = rng.pick(SLOT_SYMBOLS);
//       }
//       mid[i] = s;
//     }
//   }

//   // write back the mid row
//   for (let i = 0; i < 5; i++) grid[midStart + i] = mid[i];
//   return grid;
// }

// // Compute payout in lamports using fixed-point math to avoid float issues.
// // payout = max( bet * payoutMul - bet * feePct, 0 )
// function computePayoutLamports(betLamports, payoutMul) {
//   const SCALE = 1_000_000n;
//   const mul = BigInt(Math.round(payoutMul * 1_000_000));
//   const fee = BigInt(Math.round(FEE_PCT * 1_000_000));
//   const bet = BigInt(betLamports);

//   const gross = (bet * mul) / SCALE;
//   const feeAmt = (bet * fee) / SCALE;
//   const net = gross > feeAmt ? (gross - feeAmt) : 0n;
//   return net;
// }

// // High-level: decide outcome (by target frequencies), build grid, and compute payout.
// function computeSpin({ serverSeed, clientSeed, nonce, betLamports }) {
//   const rng = makeRng({ serverSeed, clientSeed, nonce });
//   const outcome = pickOutcome(rng, nonce);
//   const grid = buildGridForOutcome({ rng, outcome });
//   const payoutLamports = computePayoutLamports(betLamports, outcome.payoutMul);
//   return { outcome, grid, payoutLamports };
// }

// // ---------- System / fees ----------
// function loadFeePayer() {
//   let sk;
//   if (process.env.SOLANA_KEYPAIR) {
//     // env var contains JSON array string
//     sk = Uint8Array.from(JSON.parse(process.env.SOLANA_KEYPAIR));
//   } else if (process.env.ANCHOR_WALLET) {
//     sk = Uint8Array.from(JSON.parse(fs.readFileSync(process.env.ANCHOR_WALLET, "utf8")));
//   } else {
//     // fallback to local file
//     const defaultPath = path.join(os.homedir(), ".config/solana/id.json");
//     sk = Uint8Array.from(JSON.parse(fs.readFileSync(defaultPath, "utf8")));
//   }
//   return Keypair.fromSecretKey(sk);
// }

// // optional: store globally if needed
// global.feePayer = loadFeePayer();


// // ---------- State ----------
// const slotsPending = new Map(); // nonce -> ctx (if no DB present)
// const FIXED_BET_TYPE = 0; // you already wired these in your program
// const FIXED_TARGET   = 50;

// // ---------- WebSocket API ----------
// function attachSlots(io) {
//   io.on("connection", (socket) => {
//     socket.on("register", ({ player }) => {
//       socket.data.player = String(player || "guest");
//     });

//     // STEP 1: build lock tx for user to sign (place_bet_lock)
//     socket.on("slots:prepare_lock", async ({ player, betAmountLamports, clientSeed }) => {
//       try {
//         if (!player) return socket.emit("slots:error", { code: "NO_PLAYER", message: "player required" });

//         const betLamports = BigInt(betAmountLamports || 0);
//         if (betLamports <= 0n) {
//           return socket.emit("slots:error", { code: "BAD_BET", message: "betAmountLamports invalid" });
//         }

//         const playerPk = new PublicKey(player);
//         const vaultPda = deriveVaultPda();

//         const nonce = Date.now();
//         const expiryUnix = Math.floor(Date.now() / 1000) + Number(process.env.NONCE_TTL_SECONDS || 300);

//         const nonceBuf = Buffer.alloc(8); nonceBuf.writeBigUInt64LE(BigInt(nonce));
//         const pendingBetPda = PublicKey.findProgramAddressSync(
//           [Buffer.from("bet"), playerPk.toBuffer(), nonceBuf],
//           PROGRAM_ID
//         )[0];

//         const serverSeed = crypto.randomBytes(32);
//         const serverSeedHash = sha256Hex(serverSeed);

//         // ix: place_bet_lock
//         const dataLock = encodePlaceBetLockArgs({
//           betAmount: betLamports,
//           betType: FIXED_BET_TYPE,
//           target: FIXED_TARGET,
//           nonce,
//           expiryUnix,
//         });
//         const keysLock = placeBetLockKeys({ player: playerPk, vaultPda, pendingBetPda });
//         const ixLock = { programId: PROGRAM_ID, keys: keysLock, data: dataLock };

//         const cuLimit = ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 });

//         const { blockhash } = await connection.getLatestBlockhash("confirmed");
//         const msgV0 = new TransactionMessage({
//           payerKey: playerPk,
//           recentBlockhash: blockhash,
//           instructions: [cuLimit, ixLock],
//         }).compileToV0Message();

//         const vtx = new VersionedTransaction(msgV0);
//         const txBase64 = Buffer.from(vtx.serialize()).toString("base64");

//         // persist prepared spin (DB optional)
//         try {
//           if (typeof global.db?.pool?.query === "function") {
//             await global.db.pool.query(
//               `insert into slots_spins(player, bet_amount, client_seed, server_seed_hash, server_seed, nonce, status, fee_pct)
//                values ($1,$2,$3,$4,$5,$6,'prepared',$7)`,
//               [player, betLamports.toString(), String(clientSeed || ""), serverSeedHash, serverSeed.toString("hex"), BigInt(nonce), FEE_PCT]
//             );
//           } else {
//             slotsPending.set(nonce, {
//               player,
//               betLamports,
//               clientSeed: String(clientSeed || ""),
//               serverSeed,
//               serverSeedHash,
//               expiryUnix,
//               pendingBetPda: pendingBetPda.toBase58(),
//               betType: FIXED_BET_TYPE,
//               target:  FIXED_TARGET,
//             });
//           }
//         } catch (e) {
//           console.error("slots DB save error:", e);
//         }

//         socket.emit("slots:lock_tx", {
//           nonce: String(nonce),
//           expiryUnix,
//           serverSeedHash,
//           feePct: FEE_PCT,
//           pendingBetPda: pendingBetPda.toBase58(),
//           transactionBase64: txBase64,
//         });
//       } catch (e) {
//         console.error("slots:prepare_lock error:", e);
//         socket.emit("slots:error", { code: "PREPARE_FAIL", message: String(e.message || e) });
//       }
//     });

//     // STEP 2: resolve — backend computes grid/payout deterministically & signs ed25519
//     socket.on("slots:prepare_resolve", async ({ player, nonce }) => {
//       try {
//         if (!player) return socket.emit("slots:error", { code: "NO_PLAYER", message: "player required" });
//         if (!nonce)  return socket.emit("slots:error", { code: "NO_NONCE",  message: "nonce required"  });

//         const playerPk = new PublicKey(player);

//         // load prepared spin
//         let ctx = slotsPending.get(Number(nonce));
//         if (!ctx && typeof global.db?.pool?.query === "function") {
//           const r = await global.db.pool.query(
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
//               target:  FIXED_TARGET,
//             };
//           }
//         }
//         if (!ctx) {
//           return socket.emit("slots:error", { code: "NOT_FOUND", message: "no prepared spin for nonce" });
//         }

//         const vaultPda = deriveVaultPda();
//         const pendingBetSeed = Buffer.alloc(8); pendingBetSeed.writeBigUInt64LE(BigInt(nonce));
//         const pendingBetPda = PublicKey.findProgramAddressSync(
//           [Buffer.from("bet"), playerPk.toBuffer(), pendingBetSeed],
//           PROGRAM_ID
//         )[0];

//         // --- Compute result deterministically per your RTP / frequencies ---
//         const { outcome, grid, payoutLamports } = computeSpin({
//           serverSeed: ctx.serverSeed,
//           clientSeed: ctx.clientSeed,
//           nonce: Number(nonce),
//           betLamports: ctx.betLamports,
//         });

//         const willWin = payoutLamports > 0n;
//         const roll = willWin ? 1 : 100;
//         const expiryUnix = Math.floor(Date.now() / 1000) + 120;

//         // Admin-signed message for program verification
//         const msg = buildMessageBytes({
//           programId: PROGRAM_ID.toBuffer(),
//           vault: vaultPda.toBuffer(),
//           player: playerPk.toBuffer(),
//           betAmount: Number(ctx.betLamports),
//           betType: ctx.betType,      // 0
//           target:  ctx.target,       // 50
//           roll,
//           payout: Number(payoutLamports),
//           nonce: Number(nonce),
//           expiryUnix,
//         });
//         const edSig = await signMessageEd25519(msg);

//         // ed25519 verify ix (index 1)
//         const edIx = buildEd25519VerifyIx({
//           message: msg,
//           signature: edSig,
//           publicKey: ADMIN_PK,
//         });
//         const edIndex = 1;

//         // resolve_bet ix
//         const keysResolve = [
//           { pubkey: playerPk, isSigner: false, isWritable: true },
//           { pubkey: vaultPda,  isSigner: false, isWritable: true },
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

//         const cuLimit = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });
//         const { blockhash } = await connection.getLatestBlockhash("confirmed");
//         const msgV0 = new TransactionMessage({
//           payerKey: playerPk,
//           recentBlockhash: blockhash,
//           instructions: [cuLimit, edIx, ixResolve],
//         }).compileToV0Message();

//         const vtx = new VersionedTransaction(msgV0);
//         const txBase64 = Buffer.from(vtx.serialize()).toString("base64");

//         socket.emit("slots:resolve_tx", {
//           nonce: String(nonce),
//           roll,
//           outcome: outcome.key,
//           grid,
//           payoutLamports: Number(payoutLamports),
//           feePct: FEE_PCT,
//           transactionBase64: txBase64,
//         });
//       } catch (e) {
//         console.error("slots:prepare_resolve error:", e);
//         socket.emit("slots:error", { code: "RESOLVE_PREP_FAIL", message: String(e.message || e) });
//       }
//     });
//   });
// }

// module.exports = { attachSlots };



// slots_ws.js — 3×3 grid, RTP 85%, near-miss, fee, controlled jackpot, deterministic outcomes

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  PublicKey,
  VersionedTransaction,
  TransactionMessage,
  SystemProgram,
  ComputeBudgetProgram,
  Keypair,
} = require("@solana/web3.js");

const {
  connection,
  PROGRAM_ID,
  deriveVaultPda,
  deriveAdminPda,
  buildEd25519VerifyIx,
} = require("./solana");
const { ADMIN_PK, buildMessageBytes, signMessageEd25519 } = require("./signer");
const DB = global.db || require("./db");

const SYSVAR_INSTRUCTIONS_PUBKEY = new PublicKey("Sysvar1nstructions1111111111111111111111111");

// ---------- Helpers ----------
function anchorDisc(globalSnakeName) {
  return crypto.createHash("sha256").update(`global:${globalSnakeName}`).digest().slice(0, 8);
}
function sha256Hex(buf) { return crypto.createHash("sha256").update(buf).digest("hex"); }
function makeRng({ serverSeed, clientSeed, nonce }) {
  let counter = 0, pool = Buffer.alloc(0);
  function refill() {
    const h = crypto
      .createHmac("sha256", serverSeed)
      .update(String(clientSeed || ""))
      .update(Buffer.from(String(nonce)))
      .update(Buffer.from([counter & 0xff,(counter>>8)&0xff,(counter>>16)&0xff,(counter>>24)&0xff]))

      .update(
        Buffer.from([
          counter & 0xff,
          (counter >> 8) & 0xff,
          (counter >> 16) & 0xff,
          (counter >> 24) & 0xff,
        ])
      )
      .digest();
    counter++; pool = Buffer.concat([pool, h]);
  }
  function nextU32() { if (pool.length < 4) refill(); const x = pool.readUInt32BE(0); pool = pool.slice(4); return x>>>0; }
  function nextFloat() { return nextU32() / 2 ** 32; }
  function nextInt(min, max) { const span = max - min + 1; return min + Math.floor(nextFloat() * span); }
  function pick(arr) { return arr[nextInt(0, arr.length - 1)]; }
  return { nextU32, nextFloat, nextInt, pick };
}
function encodePlaceBetLockArgs({ betAmount, betType, target, nonce, expiryUnix }) {
  const disc = anchorDisc("place_bet_lock");
  const buf = Buffer.alloc(8 + 8 + 1 + 1 + 8 + 8);
  let o = 0;
  disc.copy(buf, o); o += 8;
  buf.writeBigUInt64LE(BigInt(betAmount), o); o += 8;
  buf.writeUInt8(betType & 0xff, o++); buf.writeUInt8(target & 0xff, o++); buf.writeBigUInt64LE(BigInt(nonce), o); o += 8;
  buf.writeBigInt64LE(BigInt(expiryUnix), o); o += 8;

  disc.copy(buf, o);
  o += 8;
  buf.writeBigUInt64LE(BigInt(betAmount), o);
  o += 8;
  buf.writeUInt8(betType & 0xff, o++); // fixed=0
  buf.writeUInt8(target & 0xff, o++); // fixed=50
  buf.writeBigUInt64LE(BigInt(nonce), o);
  o += 8;
  buf.writeBigInt64LE(BigInt(expiryUnix), o);
  o += 8;
  return buf;
}
function encodeResolveBetArgs({ roll, payout, ed25519InstrIndex }) {
  const disc = anchorDisc("resolve_bet");
  const buf = Buffer.alloc(8 + 1 + 8 + 1);
  let o = 0;
  disc.copy(buf, o); o += 8;
  buf.writeUInt8(roll & 0xff, o++); buf.writeBigUInt64LE(BigInt(payout), o); o += 8; buf.writeUInt8(ed25519InstrIndex & 0xff, o++);

  disc.copy(buf, o);
  o += 8;
  buf.writeUInt8(roll & 0xff, o++); // 1 for win, 100 for loss
  buf.writeBigUInt64LE(BigInt(payout), o);
  o += 8; // lamports
  buf.writeUInt8(ed25519InstrIndex & 0xff, o++);
  return buf;
}
function placeBetLockKeys({ player, vaultPda, pendingBetPda }) {
  return [
    { pubkey: player, isSigner: true, isWritable: true },
    { pubkey: vaultPda, isSigner: false, isWritable: true },
    { pubkey: pendingBetPda, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];
}

// ---------- Game constants ----------
const SLOT_SYMBOLS = ["floki", "wif", "brett", "shiba", "bonk", "doge", "pepe", "sol", "zoggy"];
const SLOTS_CELLS = 9;

const PAYTABLE = [
  { key: "near_miss", type: "near", payoutMul: 0.8, freq: 0.24999992500002252 },

// ---------- Game constants (3×3) ----------
// Use UI slugs, not emojis. Keep EXACT order that the frontend expects.
const SLOT_SYMBOLS = ["floki", "wif", "brett", "shiba", "bonk", "doge", "pepe", "sol", "zoggy"];
const SLOTS_CELLS = 9; // 3x3

// Payout table + target frequencies (sum ≈ 1.0). Jackpot is controlled-only.
// RTP target ~85% (house edge ~15%). Fee per spin is applied after gross payout.
const PAYTABLE = [
  // Near-miss: exactly two same + one different in the middle row (3 cells)
  { key: "near_miss", type: "near", payoutMul: 0.8, freq: 0.24999992500002252 },

  // Triples by symbol (3-in-a-row in the mid row)
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

// get fee pct from DB config (fallback 5%)
function getFeePctFromConfig(cfg) {
  const bps = Number(cfg?.fee_bps ?? 500);
  return Math.max(0, bps) / 10000;
}

// Outcome selection
const CDF = (() => {
  const rows = PAYTABLE.filter((p) => p.key !== "jackpot");
  let acc = 0;
  return rows.map((r) => { acc += r.freq; return { ...r, cum: acc }; });
})();
const JACKPOT_NONCES = new Set(String(process.env.SLOTS_JACKPOT_NONCES || "").split(",").map(s=>s.trim()).filter(Boolean));
function pickOutcome(rng, nonce) {
  if (JACKPOT_NONCES.has(String(nonce))) return PAYTABLE.find((p) => p.key === "jackpot");
  const r = rng.nextFloat();
  for (const row of CDF) if (r < row.cum) return row;
  return PAYTABLE.find((p) => p.key === "loss");
}
function buildGridForOutcome({ rng, outcome }) {
  const grid = []; for (let i = 0; i < SLOTS_CELLS; i++) grid.push(rng.pick(SLOT_SYMBOLS));
  const midStart = 3; const mid = grid.slice(midStart, midStart + 3);
  const pickNot = (exclude) => { let s; do { s = rng.pick(SLOT_SYMBOLS); } while (s === exclude); return s; };

  if (outcome.type === "triple") {
    const s = outcome.symbol; mid[0]=s; mid[1]=s; mid[2]=s;
  } else if (outcome.type === "near") {
    const s = rng.pick(SLOT_SYMBOLS); const odd = rng.nextInt(0,2); const t = pickNot(s);
    for (let i = 0; i < 3; i++) mid[i] = i === odd ? t : s;
  } else {
    mid[0] = rng.pick(SLOT_SYMBOLS);
    do { mid[1] = rng.pick(SLOT_SYMBOLS); } while (mid[1] === mid[0]);
    do { mid[2] = rng.pick(SLOT_SYMBOLS); } while (mid[2] === mid[0] || mid[2] === mid[1]);
  }
  for (let i = 0; i < 3; i++) grid[midStart + i] = mid[i];
  return grid;


  // Controlled-only jackpot (force via env nonces)
  { key: "jackpot", type: "triple", symbol: "zoggy", payoutMul: 1000, freq: 0 },

  // Loss (no triple, no near-miss)
  { key: "loss", type: "loss", payoutMul: 0, freq: 0.5518348344495496 },
];

// Fee per spin (percentage of bet). Default 5% -> 0.05
const FEE_PCT = Math.max(0, Math.min(1, Number(process.env.SLOTS_FEE_PCT ?? "0.05")));

// Optionally force a jackpot on specific nonces: e.g. SLOTS_JACKPOT_NONCES="1724112345678,1724118888888"
const JACKPOT_NONCES = new Set(
  String(process.env.SLOTS_JACKPOT_NONCES || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);

// ---------- Outcome selection + grid synthesis ----------

// Precompute cumulative distribution (excluding jackpot; it's controlled)
const CDF = (() => {
  const rows = PAYTABLE.filter((p) => p.key !== "jackpot");
  let acc = 0;
  return rows.map((r) => {
    acc += r.freq;
    return { ...r, cum: acc };
  });
})();

function pickOutcome(rng, nonce) {
  if (JACKPOT_NONCES.has(String(nonce))) {
    return PAYTABLE.find((p) => p.key === "jackpot");
  }
  const r = rng.nextFloat();
  for (const row of CDF) {
    if (r < row.cum) return row;
  }
  // Safety net due to float rounding:
  return PAYTABLE.find((p) => p.key === "loss");
}

// Build a 3×3 grid and inject the desired outcome into the MIDDLE ROW (indices 3..5).
function buildGridForOutcome({ rng, outcome }) {
  // start with random grid (9 cells)
  const grid = [];
  for (let i = 0; i < SLOTS_CELLS; i++) grid.push(rng.pick(SLOT_SYMBOLS));

  // middle row indices
  const midStart = 3;
  const mid = grid.slice(midStart, midStart + 3);

  // helper to avoid unwanted triples when not desired
  const pickNot = (exclude) => {
    let s;
    do {
      s = rng.pick(SLOT_SYMBOLS);
    } while (s === exclude);
    return s;
  };

  if (outcome.type === "triple") {
    // force AAA across the entire middle row
    const s = outcome.symbol;
    mid[0] = s;
    mid[1] = s;
    mid[2] = s;
  } else if (outcome.type === "near") {
    // exactly two same + one different in some position
    const s = rng.pick(SLOT_SYMBOLS);
    const odd = rng.nextInt(0, 2);
    const t = pickNot(s);
    for (let i = 0; i < 3; i++) mid[i] = i === odd ? t : s;
  } else {
    // loss: all three distinct (prevents AAA and any AAB/ABA/BAA near-miss)
    mid[0] = rng.pick(SLOT_SYMBOLS);
    do {
      mid[1] = rng.pick(SLOT_SYMBOLS);
    } while (mid[1] === mid[0]);
    do {
      mid[2] = rng.pick(SLOT_SYMBOLS);
    } while (mid[2] === mid[0] || mid[2] === mid[1]);
  }

  // write middle row back
  for (let i = 0; i < 3; i++) grid[midStart + i] = mid[i];
  return grid; // length === 9
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

// ---------- State ----------
const slotsPending = new Map();
const FIXED_BET_TYPE = 0;

  const grid = buildGridForOutcome({ rng, outcome }); // 9 symbols
  const payoutLamports = computePayoutLamports(betLamports, outcome.payoutMul);
  return { outcome, grid, payoutLamports };
}

// ---------- System / fees ----------
function loadFeePayer() {
  let sk;
  if (process.env.SOLANA_KEYPAIR) {
    // env var contains JSON array string
    sk = Uint8Array.from(JSON.parse(process.env.SOLANA_KEYPAIR));
  } else if (process.env.ANCHOR_WALLET) {
    sk = Uint8Array.from(JSON.parse(fs.readFileSync(process.env.ANCHOR_WALLET, "utf8")));
  } else {
    // fallback to local file
    const defaultPath = path.join(os.homedir(), ".config/solana/id.json");
    sk = Uint8Array.from(JSON.parse(fs.readFileSync(defaultPath, "utf8")));
  }
  return Keypair.fromSecretKey(sk);
}

// optional: store globally if needed
global.feePayer = loadFeePayer();

// ---------- State ----------
const slotsPending = new Map(); // nonce -> ctx (if no DB present)
const FIXED_BET_TYPE = 0; // you already wired these in your program
const FIXED_TARGET = 50;

// ---------- WS ----------
function attachSlots(io) {
  io.on("connection", (socket) => {
    socket.on("register", ({ player }) => { socket.data.player = String(player || "guest"); });

    socket.on("slots:prepare_lock", async ({ player, betAmountLamports, clientSeed }) => {
      try {
        if (!player)
          return socket.emit("slots:error", { code: "NO_PLAYER", message: "player required" });

        // admin gate + min/max
        const cfg = await DB.getGameConfig?.("slots");
        if (cfg && (!cfg.enabled || !cfg.running)) {
          return socket.emit("slots:error", { code: "DISABLED", message: "Slots disabled by admin" });
        }
        const min = BigInt(cfg?.min_bet_lamports ?? 50000);
        const max = BigInt(cfg?.max_bet_lamports ?? 5_000_000_000n);

        const betLamports = BigInt(betAmountLamports || 0);
        if (betLamports <= 0n) return socket.emit("slots:error", { code: "BAD_BET", message: "betAmountLamports invalid" });
        if (betLamports < min || betLamports > max) {
          return socket.emit("slots:error", { code: "BET_RANGE", message: "Bet outside allowed range" });

        if (betLamports <= 0n) {
          return socket.emit("slots:error", {
            code: "BAD_BET",
            message: "betAmountLamports invalid",
          });
        }

        const playerPk = new PublicKey(player);
        const vaultPda = deriveVaultPda();

        const nonce = Date.now();
        const expiryUnix =
          Math.floor(Date.now() / 1000) + Number(process.env.NONCE_TTL_SECONDS || 300);

        const nonceBuf = Buffer.alloc(8);
        nonceBuf.writeBigUInt64LE(BigInt(nonce));
        const pendingBetPda = PublicKey.findProgramAddressSync(
          [Buffer.from("bet"), playerPk.toBuffer(), nonceBuf],
          PROGRAM_ID
        )[0];

        const serverSeed = crypto.randomBytes(32);
        const serverSeedHash = sha256Hex(serverSeed);
        const feePct = getFeePctFromConfig(cfg);

        const dataLock = encodePlaceBetLockArgs({ betAmount: betLamports, betType: FIXED_BET_TYPE, target: FIXED_TARGET, nonce, expiryUnix });
        const keysLock = placeBetLockKeys({ player: playerPk, vaultPda, pendingBetPda });
        const ixLock = { programId: PROGRAM_ID, keys: keysLock, data: dataLock };

        const cuLimit = ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 });
        const { blockhash } = await connection.getLatestBlockhash("confirmed");
        const msgV0 = new TransactionMessage({ payerKey: playerPk, recentBlockhash: blockhash, instructions: [cuLimit, ixLock] }).compileToV0Message();
        const vtx = new VersionedTransaction(msgV0);
        const txBase64 = Buffer.from(vtx.serialize()).toString("base64");

        try {
          if (typeof DB.pool?.query === "function") {
            await DB.pool.query(
              `insert into slots_spins(player, bet_amount, client_seed, server_seed_hash, server_seed, nonce, status, fee_pct)
               values ($1,$2,$3,$4,$5,$6,'prepared',$7)`,
              [player, betLamports.toString(), String(clientSeed || ""), serverSeedHash, serverSeed.toString("hex"), BigInt(nonce), feePct]
            );
          } else {
            slotsPending.set(nonce, { player, betLamports, clientSeed: String(clientSeed || ""), serverSeed, serverSeedHash, expiryUnix, pendingBetPda: pendingBetPda.toBase58(), betType: FIXED_BET_TYPE, target: FIXED_TARGET, feePct });

              [
                player,
                betLamports.toString(),
                String(clientSeed || ""),
                serverSeedHash,
                serverSeed.toString("hex"),
                BigInt(nonce),
                FEE_PCT,
              ]
            );
          } else {
            slotsPending.set(nonce, {
              player,
              betLamports,
              clientSeed: String(clientSeed || ""),
              serverSeed,
              serverSeedHash,
              expiryUnix,
              pendingBetPda: pendingBetPda.toBase58(),
              betType: FIXED_BET_TYPE,
              target: FIXED_TARGET,
            });
          }
        } catch (e) {
          // If your table doesn't have fee_pct column yet, this will log and continue gracefully.
          console.error("slots DB save error:", e);
        }

        socket.emit("slots:lock_tx", {
          nonce: String(nonce),
          expiryUnix,
          serverSeedHash,
          feePct,
          pendingBetPda: pendingBetPda.toBase58(),
          transactionBase64: txBase64,
        });
      } catch (e) {
        console.error("slots:prepare_lock error:", e);
        socket.emit("slots:error", { code: "PREPARE_FAIL", message: String(e.message || e) });
      }
    });

    socket.on("slots:prepare_resolve", async ({ player, nonce }) => {
      try {
        if (!player) return socket.emit("slots:error", { code: "NO_PLAYER", message: "player required" });
        if (!nonce) return socket.emit("slots:error", { code: "NO_NONCE", message: "nonce required" });

        if (!player)
          return socket.emit("slots:error", { code: "NO_PLAYER", message: "player required" });
        if (!nonce)
          return socket.emit("slots:error", { code: "NO_NONCE", message: "nonce required" });

        const playerPk = new PublicKey(player);

        let ctx = slotsPending.get(Number(nonce));
        if (!ctx && typeof DB.pool?.query === "function") {
          const r = await DB.pool.query(`select * from slots_spins where nonce=$1 and player=$2 limit 1`, [BigInt(nonce), player]);
          const row = r.rows[0] || null;
          if (row) {
            ctx = {
              player,
              betLamports: BigInt(row.bet_amount),
              clientSeed: row.client_seed,
              serverSeed: Buffer.from(row.server_seed, "hex"),
              serverSeedHash: row.server_seed_hash,
              expiryUnix: 0,
              betType: FIXED_BET_TYPE,
              target: FIXED_TARGET,
              feePct: Number(row.fee_pct || 0),

            };
          }
        }
        if (!ctx) {
          return socket.emit("slots:error", {
            code: "NOT_FOUND",
            message: "no prepared spin for nonce",
          });
        }

        const vaultPda = deriveVaultPda();
        const pendingBetSeed = Buffer.alloc(8); pendingBetSeed.writeBigUInt64LE(BigInt(nonce));
        const pendingBetPda = PublicKey.findProgramAddressSync([Buffer.from("bet"), playerPk.toBuffer(), pendingBetSeed], PROGRAM_ID)[0];

        const pendingBetSeed = Buffer.alloc(8);
        pendingBetSeed.writeBigUInt64LE(BigInt(nonce));
        const pendingBetPda = PublicKey.findProgramAddressSync(
          [Buffer.from("bet"), playerPk.toBuffer(), pendingBetSeed],
          PROGRAM_ID
        )[0];

        const { outcome, grid, payoutLamports } = computeSpin({
          serverSeed: ctx.serverSeed,
          clientSeed: ctx.clientSeed,
          nonce: Number(nonce),
          betLamports: ctx.betLamports,
          feePct: ctx.feePct ?? 0.05,
        });

        const willWin = payoutLamports > 0n;
        const roll = willWin ? 1 : 100;
        const expiryUnix = Math.floor(Date.now() / 1000) + 120;

        const msg = buildMessageBytes({
          programId: PROGRAM_ID.toBuffer(),
          vault: vaultPda.toBuffer(),
          player: playerPk.toBuffer(),
          betAmount: Number(ctx.betLamports),
          betType: ctx.betType,
          target: ctx.target,

          betType: ctx.betType, // 0
          target: ctx.target, // 50
          roll,
          payout: Number(payoutLamports),
          nonce: Number(nonce),
          expiryUnix,
        });
        const edSig = await signMessageEd25519(msg);
        const edIx = buildEd25519VerifyIx({ message: msg, signature: edSig, publicKey: ADMIN_PK });
        const edIndex = 1;

        const keysResolve = [
          { pubkey: playerPk, isSigner: false, isWritable: true },
          { pubkey: vaultPda, isSigner: false, isWritable: true },
          { pubkey: deriveAdminPda(), isSigner: false, isWritable: false },
          { pubkey: pendingBetPda, isSigner: false, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
        ];
        const dataResolve = encodeResolveBetArgs({ roll, payout: Number(payoutLamports), ed25519InstrIndex: edIndex });
        const ixResolve = { programId: PROGRAM_ID, keys: keysResolve, data: dataResolve };

        const cuLimit = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });
        const { blockhash } = await connection.getLatestBlockhash("confirmed");
        const msgV0 = new TransactionMessage({ payerKey: playerPk, recentBlockhash: blockhash, instructions: [cuLimit, edIx, ixResolve] }).compileToV0Message();

        const vtx = new VersionedTransaction(msgV0);
        const txBase64 = Buffer.from(vtx.serialize()).toString("base64");

        // persist a unified stat row
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
              amount: (Number(payoutLamports)/1e9).toFixed(4),
            });
          }
          // also mirror into slots_spins if using that table
          if (typeof DB.pool?.query === "function") {
            await DB.pool.query(
              `update slots_spins set grid_json=$1, payout=$2, status='prepared_resolve' where nonce=$3 and player=$4`,
              [JSON.stringify(grid), Number(payoutLamports), BigInt(nonce), player]
            );
          }
        } catch (e) {
          console.warn("slots: stat save warn:", e?.message || e);
        }

        socket.emit("slots:resolve_tx", {
          nonce: String(nonce),
          roll,
          outcome: outcome.key,
          grid, // <-- exactly 9 slugs for 3×3
          payoutLamports: Number(payoutLamports),
          feePct: ctx.feePct ?? 0.05,
          transactionBase64: txBase64,
        });
      } catch (e) {
        console.error("slots:prepare_resolve error:", e);
        socket.emit("slots:error", { code: "RESOLVE_PREP_FAIL", message: String(e.message || e) });
      }
    });
  });
}

module.exports = { attachSlots };

