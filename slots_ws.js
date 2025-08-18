// slots_ws.js 
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

const SYSVAR_INSTRUCTIONS_PUBKEY = new PublicKey(
  "Sysvar1nstructions1111111111111111111111111"
);

function anchorDisc(globalSnakeName) {
  return crypto.createHash("sha256").update(`global:${globalSnakeName}`).digest().slice(0, 8);
}
function encodePlaceBetLockArgs({ betAmount, betType, target, nonce, expiryUnix }) {
  const disc = anchorDisc("place_bet_lock");
  const buf = Buffer.alloc(8 + 8 + 1 + 1 + 8 + 8);
  let o = 0;
  disc.copy(buf, o); o += 8;
  buf.writeBigUInt64LE(BigInt(betAmount), o); o += 8;
  buf.writeUInt8(betType & 0xff, o++);          
  buf.writeUInt8(target & 0xff, o++);           
  buf.writeBigUInt64LE(BigInt(nonce), o); o += 8;
  buf.writeBigInt64LE(BigInt(expiryUnix), o); o += 8;
  return buf;
}

function encodeResolveBetArgs({ roll, payout, ed25519InstrIndex }) {
  const disc = anchorDisc("resolve_bet");
  const buf = Buffer.alloc(8 + 1 + 8 + 1);
  let o = 0;
  disc.copy(buf, o); o += 8;
  buf.writeUInt8(roll & 0xff, o++);                 
  buf.writeBigUInt64LE(BigInt(payout), o); o += 8;  
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

const SLOT_SYMBOLS = ["🍒","🍋","🍊","🍇","⭐","💎","🍎","🍓","7️⃣"];
const SLOTS_CELLS = 15;

function deriveGrid({ serverSeed, clientSeed, nonce }) {
  const grid = [];
  for (let i = 0; i < SLOTS_CELLS; i++) {
    const h = crypto.createHash("sha256")
      .update(serverSeed)
      .update(String(clientSeed || ""))
      .update(Buffer.from(String(nonce)))
      .update(Buffer.from([i]))
      .digest();
    const idx = ((h[0] << 8) | h[1]) % SLOT_SYMBOLS.length;
    grid.push(SLOT_SYMBOLS[idx]);
  }
  return grid;
}

function calcSlotsPayout(grid, betAmountLamports) {
  const mid = [grid[5], grid[6], grid[7], grid[8], grid[9]];
  const allFiveSame = mid.every((s) => s === mid[0]);
  if (allFiveSame) return betAmountLamports * 1000n; // jackpot
  for (let i = 0; i <= 2; i++) {
    const s0 = mid[i];
    if (s0 === mid[i+1] && s0 === mid[i+2]) return betAmountLamports * 5n;
  }
  if (mid.includes("💎")) return betAmountLamports * 2n;
  return 0n;
}

function sha256Hex(buf) { return crypto.createHash("sha256").update(buf).digest("hex"); }

function loadFeePayer() {
  const p =
    process.env.SOLANA_KEYPAIR ||
    process.env.ANCHOR_WALLET ||
    path.join(os.homedir(), ".config/solana/id.json");
  const sk = Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8")));
  return Keypair.fromSecretKey(sk);
}
loadFeePayer(); 


const slotsPending = new Map(); 

const FIXED_BET_TYPE = 0;   
const FIXED_TARGET   = 50;  
// ----------------- WebSocket API -----------------
function attachSlots(io) {
  io.on("connection", (socket) => {
    socket.on("register", ({ player }) => {
      socket.data.player = String(player || "guest");
    });

    // STEP 1: build lock tx for user to sign (place_bet_lock)
    socket.on("slots:prepare_lock", async ({ player, betAmountLamports, clientSeed }) => {
      try {
        if (!player) return socket.emit("slots:error", { code: "NO_PLAYER", message: "player required" });

        const betLamports = BigInt(betAmountLamports || 0);
        if (betLamports <= 0n) {
          return socket.emit("slots:error", { code: "BAD_BET", message: "betAmountLamports invalid" });
        }

        const playerPk = new PublicKey(player);
        const vaultPda = deriveVaultPda();

        const nonce = Date.now();
        const expiryUnix = Math.floor(Date.now() / 1000) + Number(process.env.NONCE_TTL_SECONDS || 300);

        const nonceBuf = Buffer.alloc(8); nonceBuf.writeBigUInt64LE(BigInt(nonce));
        const pendingBetPda = PublicKey.findProgramAddressSync(
          [Buffer.from("bet"), playerPk.toBuffer(), nonceBuf],
          PROGRAM_ID
        )[0];

        const serverSeed = crypto.randomBytes(32);
        const serverSeedHash = sha256Hex(serverSeed);
        const dataLock = encodePlaceBetLockArgs({
          betAmount: betLamports,
          betType: FIXED_BET_TYPE,
          target: FIXED_TARGET,
          nonce,
          expiryUnix,
        });
        const keysLock = placeBetLockKeys({ player: playerPk, vaultPda, pendingBetPda });
        const ixLock = { programId: PROGRAM_ID, keys: keysLock, data: dataLock };
        const cuLimit = ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 });
        const { blockhash } = await connection.getLatestBlockhash("confirmed");
        const msgV0 = new TransactionMessage({
          payerKey: playerPk,
          recentBlockhash: blockhash,
          instructions: [cuLimit, ixLock],
        }).compileToV0Message();

        const vtx = new VersionedTransaction(msgV0);
        const txBase64 = Buffer.from(vtx.serialize()).toString("base64");

        // persist prepared spin (DB optional)
        try {
          if (typeof global.db?.pool?.query === "function") {
            await global.db.pool.query(
              `insert into slots_spins(player, bet_amount, client_seed, server_seed_hash, server_seed, nonce, status)
               values ($1,$2,$3,$4,$5,$6,'prepared')`,
              [player, betLamports.toString(), String(clientSeed || ""), serverSeedHash, serverSeed.toString("hex"), BigInt(nonce)]
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
              // stash rails fields so resolve can sign consistently
              betType: FIXED_BET_TYPE,
              target:  FIXED_TARGET,
            });
          }
        } catch (e) {
          console.error("slots DB save error:", e);
        }

        socket.emit("slots:lock_tx", {
          nonce: String(nonce),
          expiryUnix,
          serverSeedHash,
          pendingBetPda: pendingBetPda.toBase58(),
          transactionBase64: txBase64,
        });
      } catch (e) {
        console.error("slots:prepare_lock error:", e);
        socket.emit("slots:error", { code: "PREPARE_FAIL", message: String(e.message || e) });
      }
    });

    // STEP 2: resolve — backend computes grid/payout, chooses roll to match payout boolean, signs ed25519
    socket.on("slots:prepare_resolve", async ({ player, nonce }) => {
      try {
        if (!player) return socket.emit("slots:error", { code: "NO_PLAYER", message: "player required" });
        if (!nonce)  return socket.emit("slots:error", { code: "NO_NONCE",  message: "nonce required"  });

        const playerPk = new PublicKey(player);

        // load prepared spin
        let ctx = slotsPending.get(Number(nonce));
        if (!ctx && typeof global.db?.pool?.query === "function") {
          const r = await global.db.pool.query(
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
              betType: FIXED_BET_TYPE,
              target:  FIXED_TARGET,
            };
          }
        }
        if (!ctx) {
          return socket.emit("slots:error", { code: "NOT_FOUND", message: "no prepared spin for nonce" });
        }

        const vaultPda = deriveVaultPda();
        const pendingBetSeed = Buffer.alloc(8); pendingBetSeed.writeBigUInt64LE(BigInt(nonce));
        const pendingBetPda = PublicKey.findProgramAddressSync(
          [Buffer.from("bet"), playerPk.toBuffer(), pendingBetSeed],
          PROGRAM_ID
        )[0];

        // compute result
        const grid = deriveGrid({ serverSeed: ctx.serverSeed, clientSeed: ctx.clientSeed, nonce: Number(nonce) });
        const payoutLamports = calcSlotsPayout(grid, ctx.betLamports);

        const willWin = payoutLamports > 0n;
        const roll = willWin ? 1 : 100;

        // MUST match program)
        const expiryUnix = Math.floor(Date.now() / 1000) + 120; 
        const msg = buildMessageBytes({
          programId: PROGRAM_ID.toBuffer(),
          vault: vaultPda.toBuffer(),
          player: playerPk.toBuffer(),
          betAmount: Number(ctx.betLamports),
          betType: ctx.betType,     // 0
          target:  ctx.target,      // 50
          roll,
          payout: Number(payoutLamports),
          nonce: Number(nonce),
          expiryUnix,
        });
        const edSig = await signMessageEd25519(msg);

        // ed25519 verify ix 
        const edIx = buildEd25519VerifyIx({
          message: msg,
          signature: edSig,
          publicKey: ADMIN_PK,
        });
        const edIndex = 1;

        // resolve_bet ix
        const keysResolve = [
          { pubkey: playerPk, isSigner: false, isWritable: true },
          { pubkey: vaultPda,  isSigner: false, isWritable: true },
          { pubkey: deriveAdminPda(), isSigner: false, isWritable: false },
          { pubkey: pendingBetPda, isSigner: false, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
        ];
        const dataResolve = encodeResolveBetArgs({
          roll,
          payout: Number(payoutLamports),
          ed25519InstrIndex: edIndex,
        });
        const ixResolve = { programId: PROGRAM_ID, keys: keysResolve, data: dataResolve };

        // CU headroom; wallets may still prepend their own (frontend retargets)
        const cuLimit = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });

        const { blockhash } = await connection.getLatestBlockhash("confirmed");
        const msgV0 = new TransactionMessage({
          payerKey: playerPk,
          recentBlockhash: blockhash,
          instructions: [cuLimit, edIx, ixResolve], 
        }).compileToV0Message();

        const vtx = new VersionedTransaction(msgV0);
        const txBase64 = Buffer.from(vtx.serialize()).toString("base64");

        socket.emit("slots:resolve_tx", {
          nonce: String(nonce),
          roll,
          grid,
          payoutLamports: Number(payoutLamports),
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
