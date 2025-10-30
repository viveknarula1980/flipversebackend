// crash_ws.js — Provably-Fair Crash (WS + REST) with fake/promo balance support

const crypto = require("crypto");
const {
  PublicKey,
  VersionedTransaction,
  TransactionMessage,
  ComputeBudgetProgram,
} = require("@solana/web3.js");

const DB = global.db || require("./db");
const Promo = require("./promo_balance");
const { pushWinEvent } = require("./ws_wins");

let precheckOrThrow = async () => {};
try { ({ precheckOrThrow } = require("./bonus_guard")); } catch (_) {}

const {
  connection,
  PROGRAM_ID,
  deriveVaultPda,
  deriveAdminPda,
  deriveUserVaultPda,
  derivePendingCrashPda,
  buildEd25519VerifyIx,
} = require("./solana");

const { ixCrashLock, ixCrashResolve } = require("./solana_anchor_ix");
const { ADMIN_PK, signMessageEd25519, getServerKeypair } = require("./signer");

/* ----------------------- Schema (safe, idempotent) ----------------------- */
async function ensureCrashSchema() {
  if (!DB?.pool) return;
  await DB.pool.query(`
    CREATE TABLE IF NOT EXISTS crash_rounds (
      id BIGSERIAL PRIMARY KEY,
      player TEXT NOT NULL,
      bet_lamports BIGINT NOT NULL,
      nonce BIGINT UNIQUE NOT NULL,
      cashout_multiplier_bps INT,
      crash_at_mul DOUBLE PRECISION NOT NULL,
      payout_lamports BIGINT NOT NULL DEFAULT 0,
      fee_bps INT NOT NULL DEFAULT 0,
      server_seed_hash TEXT,
      server_seed_hex  TEXT,
      first_hmac_hex   TEXT,
      client_seed      TEXT NOT NULL DEFAULT '',
      lock_tx_sig      TEXT,
      resolve_tx_sig   TEXT,
      status TEXT NOT NULL DEFAULT 'locked',
      created_at timestamptz NOT NULL DEFAULT now(),
      resolved_at timestamptz
    );

    ALTER TABLE crash_rounds ALTER COLUMN payout_lamports SET DEFAULT 0;
    ALTER TABLE crash_rounds ALTER COLUMN fee_bps SET DEFAULT 0;
    ALTER TABLE crash_rounds ALTER COLUMN status SET DEFAULT 'locked';

    CREATE INDEX IF NOT EXISTS idx_crash_player_status_id
      ON crash_rounds (player, status, id DESC);
  `);
}

/* ----------------------- Provably-fair helpers --------------------------- */
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

/** Derive crash point & HMAC from serverSeed/clientSeed/nonce */
function deriveCrashPointDetailed({ serverSeed, clientSeed, nonce }) {
  const h = crypto
    .createHmac("sha256", serverSeed)
    .update(String(clientSeed || ""))
    .update(Buffer.from(String(nonce)))
    .digest();

  const first_hmac_hex = h.toString("hex");
  const n64 = u64From(h.subarray(0, 8));
  const r = Number(n64 >> 11n) / Math.pow(2, 53); // [0,1)
  const edge = 0.99;
  const m = Math.max(1.01, edge / (1 - Math.min(0.999999999999, r)));
  const crashAtMul = Math.min(m, 10000);
  return { crashAtMul, first_hmac_hex, n64: n64.toString(), r };
}

/** live multiplier over time since round start (ms) */
function multiplierAt(startMs) {
  const speed = Number(process.env.CRASH_SPEED_MS || 3500);
  const elapsed = Math.max(0, Date.now() - startMs);
  return 1 + Math.pow(elapsed / speed, 1.35);
}
function toBps(m) { return Math.floor(m * 10000); }
function grossPayoutLamports(betLamports, multiplier) {
  const multBps = BigInt(toBps(Number(multiplier)));
  return (BigInt(betLamports) * multBps) / 10000n;
}

/* ---------------------- Ed25519 free-form messages ----------------------- */
function buildLockMessage({ programId, vault, player, betAmount, nonce, expiryUnix }) {
  const parts = [
    Buffer.from("CRASH_LOCK_V1"),
    programId.toBuffer(),
    vault.toBuffer(),
    player.toBuffer(),
    (() => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(betAmount)); return b; })(),
    (() => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(nonce)); return b; })(),
    (() => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(expiryUnix)); return b; })(),
  ];
  return Buffer.concat(parts);
}

function buildResolveMessage({ programId, vault, player, betAmount, multiplierBps, payout, nonce, expiryUnix }) {
  const parts = [
    Buffer.from("CRASH_RESOLVE_V1"),
    programId.toBuffer(),
    vault.toBuffer(),
    player.toBuffer(),
    (() => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(betAmount)); return b; })(),
    (() => { const b = Buffer.alloc(4); b.writeUInt32LE(multiplierBps >>> 0); return b; })(),
    (() => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(payout)); return b; })(),
    (() => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(nonce)); return b; })(),
    (() => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(expiryUnix)); return b; })(),
  ];
  return Buffer.concat(parts);
}

/* --------------------------- Real resolve (on-chain) --------------------- */
async function sendResolveTx({ ctx, nonce, cashoutMultiplier }) {
  const playerPk   = ctx.playerPk;
  const userVault  = deriveUserVaultPda(playerPk);
  const houseVault = deriveVaultPda();
  const adminPda   = deriveAdminPda();
  const pendingPda = derivePendingCrashPda(playerPk, nonce);

  const win = cashoutMultiplier != null;

  let multBps = 10_000; // 1.0x
  let payout = 0;       // NET to pay (gross - stake)
  if (win) {
    const m = Math.max(1, Number(cashoutMultiplier));
    multBps = toBps(m);
    const gross = (ctx.betLamports * BigInt(multBps)) / 10000n;
    const net   = gross - ctx.betLamports;
    payout = Number(net > 0n ? net : 0n);
  }

  const expiryUnix = Math.floor(Date.now() / 1000) + Number(process.env.NONCE_TTL_SECONDS || 300);

  const msg  = buildResolveMessage({
    programId: PROGRAM_ID,
    vault: houseVault,
    player: playerPk,
    betAmount: Number(ctx.betLamports),
    multiplierBps: multBps,
    payout,
    nonce,
    expiryUnix,
  });
  const edSig = await signMessageEd25519(msg);
  const edIx  = buildEd25519VerifyIx({ message: msg, signature: edSig, publicKey: ADMIN_PK });

  const edIndex = 1;
  const ixResolve = ixCrashResolve({
    programId: PROGRAM_ID,
    player: playerPk,
    houseVault,
    adminPda,
    userVault,
    pendingCrash: pendingPda,
    multiplierBps: multBps,
    payout,
    edIndex,
  });

  const payer    = await getServerKeypair();
  const cuLimit  = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });

  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const msgV0 = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions: [cuLimit, edIx, ixResolve],
  }).compileToV0Message();

  const vtx = new VersionedTransaction(msgV0);
  vtx.sign([payer]);

  const txSig = await connection.sendRawTransaction(vtx.serialize(), { skipPreflight: false, maxRetries: 5 });
  await connection.confirmTransaction(txSig, "confirmed");

  return { txSig, multBps, payout };
}

/* ---------------------------- Fake-mode helpers -------------------------- */
function makeFakeTxSig(prefix, nonce) { return `${prefix}-${String(nonce)}`; }

/* --------------------------- In-memory state ----------------------------- */
/*
  rounds: Map<nonce, {
    playerPk: PublicKey,
    wallet: string,
    fakeMode: boolean,
    betLamports: BigInt,
    clientSeed: string,
    serverSeed: Buffer,
    serverSeedHex: string,
    serverSeedHash: string,
    startTs: number,
    crashAtMul: number,
    crashed: boolean,
    cashed: boolean,
    timer: Timeout | null,
    first_hmac_hex: string
  }>
*/
const rounds = new Map();

/* ----------------------------- REST routes ------------------------------- */
function attachCrashRoutes(app) {
  if (!app || !app.use) return;
  const express = require("express");
  const router = express.Router();

  router.get("/resolved", async (req, res) => {
    try {
      const wallet = String(req.query.wallet || "");
      const limit  = Number(req.query.limit || 50);
      const cursor = req.query.cursor ? Number(req.query.cursor) : null;
      if (!wallet || wallet.length < 32) return res.status(400).json({ error: "bad wallet" });

      await ensureCrashSchema().catch(() => {});
      const L = Math.max(1, Math.min(200, limit));
      const sel = `
        id::text,
        player,
        bet_lamports::text,
        nonce::text,
        cashout_multiplier_bps,
        crash_at_mul,
        payout_lamports::text,
        fee_bps,
        lock_tx_sig,
        resolve_tx_sig,
        server_seed_hash,
        server_seed_hex,
        first_hmac_hex,
        client_seed,
        status,
        created_at,
        resolved_at
      `;

      let rows;
      if (cursor) {
        ({ rows } = await DB.pool.query(
          `SELECT ${sel} FROM crash_rounds
             WHERE status='resolved' AND player=$1 AND id < $2
             ORDER BY id DESC LIMIT $3`,
          [wallet, cursor, L]
        ));
      } else {
        ({ rows } = await DB.pool.query(
          `SELECT ${sel} FROM crash_rounds
             WHERE status='resolved' AND player=$1
             ORDER BY id DESC LIMIT $2`,
          [wallet, L]
        ));
      }
      const nextCursor = rows.length ? rows[rows.length - 1].id : null;

      res.json({
        items: rows,
        nextCursor,
        verify: {
          algorithm:
            "HMAC_SHA256(serverSeed, clientSeed + nonce) → first 8 bytes → u64 >> 11 / 2^53 → edge adjust; live multiplier ticks; cashout must be < crashAt.",
        },
      });
    } catch (e) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  app.use("/crash", router);
}

/* ----------------------------- WS attach --------------------------------- */
function attachCrash(io, app) {
  ensureCrashSchema().catch((e) => console.warn("[ensureCrashSchema] warn:", e?.message || e));
  try { attachCrashRoutes(app); } catch (_) {}

  io.on("connection", (socket) => {
    socket.on("register", ({ player }) => { socket.data.player = String(player || "guest"); });

    // Prepare lock
    socket.on("crash:prepare_lock", async ({ player, betAmountLamports, clientSeed = "" }) => {
      try {
        if (!player) return socket.emit("crash:error", { code: "NO_PLAYER", message: "player required" });

        const cfg = await DB.getGameConfig?.("crash");
        if (cfg && (!cfg.enabled || !cfg.running)) {
          return socket.emit("crash:error", { code: "DISABLED", message: "Crash disabled by admin" });
        }
        const min = BigInt(cfg?.min_bet_lamports ?? 50_000n);
        const max = BigInt(cfg?.max_bet_lamports ?? 5_000_000_000n);

        const betLamports = BigInt(betAmountLamports || 0);
        if (!(betLamports > 0n)) {
          return socket.emit("crash:error", { code: "BAD_BET", message: "bet must be > 0" });
        }
        if (betLamports < min || betLamports > max) {
          return socket.emit("crash:error", { code: "BET_RANGE", message: "Bet outside allowed range" });
        }

        // (Optional) bonus/abuse guard
        await precheckOrThrow({ userWallet: String(player), stakeLamports: betLamports, gameKey: "crash" }).catch(() => {});

        const wallet     = String(player);
        const playerPk   = new PublicKey(wallet);
        const userVault  = deriveUserVaultPda(playerPk);
        const houseVault = deriveVaultPda();

        const nonce = Date.now();
        const expiryUnix = Math.floor(Date.now() / 1000) + Number(process.env.NONCE_TTL_SECONDS || 300);
        const pendingPda = derivePendingCrashPda(playerPk, nonce);

        // Fairness commitment
        const serverSeed = crypto.randomBytes(32);
        const serverSeedHex  = serverSeed.toString("hex");
        const serverSeedHash = crypto.createHash("sha256").update(serverSeed).digest("hex");
        const det = deriveCrashPointDetailed({ serverSeed, clientSeed, nonce });
        const crashAtMul = det.crashAtMul;
        const first_hmac_hex = det.first_hmac_hex;

        // Mode
        const fakeMode = await Promo.isFakeMode(wallet);

        let txSig;
        if (!fakeMode) {
          // -------- REAL MODE (on-chain) ----------
          const lockMsg = buildLockMessage({
            programId: PROGRAM_ID,
            vault: houseVault,
            player: playerPk,
            betAmount: Number(betLamports),
            nonce,
            expiryUnix,
          });
          const edSig = await signMessageEd25519(lockMsg);
          const edIx  = buildEd25519VerifyIx({ message: lockMsg, signature: edSig, publicKey: ADMIN_PK });

          const edIndex = 1;
          const payer   = await getServerKeypair();
          const cuLimit = ComputeBudgetProgram.setComputeUnitLimit({ units: 220_000 });

          const ixLock  = ixCrashLock({
            programId: PROGRAM_ID,
            player: playerPk,
            feePayer: payer.publicKey,
            userVault,
            houseVault,
            pendingCrash: pendingPda,
            betAmount: Number(betLamports),
            nonce,
            expiryUnix,
            edIndex,
          });

          const { blockhash } = await connection.getLatestBlockhash("confirmed");
          const msgV0 = new TransactionMessage({
            payerKey: payer.publicKey,
            recentBlockhash: blockhash,
            instructions: [cuLimit, edIx, ixLock],
          }).compileToV0Message();

          const vtx = new VersionedTransaction(msgV0);
          vtx.sign([payer]);

          txSig = await connection.sendRawTransaction(vtx.serialize(), { skipPreflight: false, maxRetries: 5 });
          await connection.confirmTransaction(txSig, "confirmed");
        } else {
          // -------- FAKE MODE (off-chain promo) ----------
          const newBal = await Promo.freezeForBet(wallet, Number(betLamports));
          if (newBal === false || newBal == null) {
            return socket.emit("crash:error", { code: "FAKE_BALANCE_LOW", message: "Insufficient promo balance" });
          }
          txSig = makeFakeTxSig("FAKE-LOCK", nonce);
          socket.emit("crash:locked", {
            nonce: String(nonce),
            txSig,
            serverSeedHash,
            promoBalanceLamports: newBal,
          });
        }

        // In-memory round
        rounds.set(nonce, {
          playerPk,
          wallet,
          fakeMode,
          betLamports,
          clientSeed: String(clientSeed || ""),
          serverSeed, serverSeedHex, serverSeedHash,
          startTs: Date.now(),
          crashAtMul,
          crashed: false,
          cashed: false,
          timer: null,
          first_hmac_hex,
        });

        // Persist LOCKED row immediately (contains fairness data)
        try {
          await ensureCrashSchema().catch(() => {});
          await DB.pool?.query(
            `INSERT INTO crash_rounds
               (player, bet_lamports, nonce, cashout_multiplier_bps, crash_at_mul,
                payout_lamports, fee_bps, server_seed_hash, server_seed_hex, first_hmac_hex,
                client_seed, lock_tx_sig, status, created_at)
             VALUES ($1,$2,$3,NULL,$4,0,0,$5,$6,$7,$8,$9,'locked',now())
             ON CONFLICT (nonce) DO UPDATE SET
               player=EXCLUDED.player,
               bet_lamports=EXCLUDED.bet_lamports,
               crash_at_mul=EXCLUDED.crash_at_mul,
               server_seed_hash=EXCLUDED.server_seed_hash,
               server_seed_hex=EXCLUDED.server_seed_hex,
               first_hmac_hex=EXCLUDED.first_hmac_hex,
               client_seed=EXCLUDED.client_seed,
               lock_tx_sig=EXCLUDED.lock_tx_sig,
               status='locked'`,
            [
              wallet,
              Number(betLamports),
              BigInt(nonce),
              Number(crashAtMul),
              serverSeedHash,
              serverSeedHex,
              first_hmac_hex,
              String(clientSeed || ""),
              txSig || null,
            ]
          );
        } catch (e) {
          console.warn("[crash] locked insert warn:", e?.message || e);
        }

        // Emit locked for real mode (fake already emitted)
        if (!fakeMode) {
          socket.emit("crash:locked", { nonce: String(nonce), txSig, serverSeedHash });
        }

        // Start ticking
        const ctx = rounds.get(nonce);
        const tickMs = 75;
        ctx.timer = setInterval(async () => {
          try {
            if (ctx.cashed || ctx.crashed) return;
            const m = multiplierAt(ctx.startTs);
            // broadcast tick (room-wide is fine; or to socket only)
            socket.emit("crash:tick", { nonce: String(nonce), multiplier: m });

            if (m >= ctx.crashAtMul) {
              // Crash (loss)
              ctx.crashed = true;
              clearInterval(ctx.timer);

              socket.emit("crash:crashed", { nonce: String(nonce), finalMultiplier: ctx.crashAtMul });

              if (!ctx.fakeMode) {
                // Resolve on-chain with no cashout
                try {
                  const { txSig: rSig, multBps } = await sendResolveTx({ ctx, nonce: Number(nonce), cashoutMultiplier: null });

                  await DB.pool?.query(
                    `UPDATE crash_rounds
                       SET cashout_multiplier_bps=NULL, payout_lamports=0,
                           resolve_tx_sig=$1, status='resolved', resolved_at=now()
                     WHERE nonce=$2`,
                    [rSig, BigInt(nonce)]
                  );
                } catch (e) {
                  console.error("[crash] resolve(loss) tx fail:", e?.message || e);
                }

                try {
                  await DB.recordGameRound?.({
                    game_key: "crash",
                    player: ctx.wallet,
                    nonce: Number(nonce),
                    stake_lamports: Number(ctx.betLamports),
                    payout_lamports: 0,
                    result_json: { crashedAt: ctx.crashAtMul, cashout: null },
                  });
                } catch {}

              } else {
                // Fake: settle promo (stake was frozen, loss -> 0)
                try {
                  await Promo.settleBet(ctx.wallet, 0);
                } catch {}

                try {
                  await DB.pool?.query(
                    `UPDATE crash_rounds
                       SET cashout_multiplier_bps=NULL, payout_lamports=0,
                           resolve_tx_sig=$1, status='resolved', resolved_at=now()
                     WHERE nonce=$2`,
                    [makeFakeTxSig("FAKE-RESOLVE", nonce), BigInt(nonce)]
                  );
                } catch (e) {
                  console.warn("[crash] fake resolve(loss) update warn:", e?.message || e);
                }

                try {
                  await DB.recordGameRound?.({
                    game_key: "crash",
                    player: ctx.wallet,
                    nonce: Number(nonce),
                    stake_lamports: Number(ctx.betLamports),
                    payout_lamports: 0,
                    result_json: { crashedAt: ctx.crashAtMul, cashout: null, fake: true },
                  });
                } catch {}
              }

              // Reveal payload (same both modes)
              const revealPayload = {
                nonce: String(nonce),
                serverSeedHex: ctx.serverSeedHex,
                clientSeed: ctx.clientSeed,
                formula: "HMAC_SHA256(serverSeed, clientSeed + nonce) → first 8 bytes → u64 >> 11 / 2^53 → edge adjusted; cashout < crashAt",
                firstHmacHex: ctx.first_hmac_hex,
                crashAtMul: ctx.crashAtMul,
                txSig: ctx.fakeMode ? makeFakeTxSig("FAKE-RESOLVE", nonce) : undefined,
                payoutLamports: "0",
                multiplierBps: 10_000,
              };
              socket.emit("crash:resolved", revealPayload);
              socket.emit("crash:reveal_seed", revealPayload);

              rounds.delete(Number(nonce));

              // ---- Push live win feed (loss) ----
try {
  pushWinEvent({
    user: ctx.wallet,
    game: "crash",
    amountSol: Number(ctx.betLamports) / 1e9,
    payoutSol: 0,
    result: "loss",
  });
} catch (err) {
  console.warn("[crash] pushWinEvent (loss) failed:", err?.message || err);
}

            }
          } catch (tickErr) {
            console.error("crash tick err:", tickErr);
          }
        }, tickMs);

      } catch (e) {
        console.error("crash:prepare_lock error:", e);
        socket.emit("crash:error", { code: "PREPARE_FAIL", message: String(e.message || e) });
      }
    });

    // Cashout (player wins)
    socket.on("crash:cashout", async ({ player, nonce, atMultiplier }) => {
      try {
        const ctx = rounds.get(Number(nonce));
        if (!ctx) return socket.emit("crash:error", { code: "NOT_FOUND", message: "no round" });
        if (ctx.crashed || ctx.cashed) return socket.emit("crash:error", { code: "ALREADY_RESOLVED", message: "round already finished" });

        // Ensure the requested cashout multiplier is valid (not after crash)
        const liveM = multiplierAt(ctx.startTs);
        const m = Math.max(1, Number(atMultiplier || liveM));
        if (m <= 1) return socket.emit("crash:error", { code: "BAD_MULTIPLIER", message: "invalid cashout multiplier" });
        if (m >= ctx.crashAtMul) return socket.emit("crash:error", { code: "TOO_LATE", message: "round already crashed" });

        ctx.cashed = true;
        if (ctx.timer) clearInterval(ctx.timer);

        if (!ctx.fakeMode) {
          // ----- REAL MODE (on-chain) pays NET -----
          const { txSig, multBps, payout } = await sendResolveTx({ ctx, nonce: Number(nonce), cashoutMultiplier: m });

          try {
            await DB.pool?.query(
              `UPDATE crash_rounds
                 SET cashout_multiplier_bps=$1, payout_lamports=$2, resolve_tx_sig=$3,
                     status='resolved', resolved_at=now()
               WHERE nonce=$4`,
              [multBps, Number(payout), txSig, BigInt(nonce)]
            );
          } catch (e) {
            console.warn("[crash] update resolved (real) warn:", e?.message || e);
          }

          try {
            await DB.recordGameRound?.({
              game_key: "crash",
              player: ctx.wallet,
              nonce: Number(nonce),
              stake_lamports: Number(ctx.betLamports),
              payout_lamports: Number(payout), // NET on-chain
              result_json: { crashedAt: ctx.crashAtMul, cashout: m },
            });
            if (payout > 0) {
              await DB.recordActivity?.({
                user: ctx.wallet,
                action: "Crash cashout",
                amount: (Number(payout) / 1e9).toFixed(4),
              });
            }
          } catch {}

          const revealPayload = {
            nonce: String(nonce),
            serverSeedHex: ctx.serverSeedHex,
            clientSeed: ctx.clientSeed,
            formula: "HMAC_SHA256(serverSeed, clientSeed + nonce) → first 8 bytes → u64 >> 11 / 2^53 → edge adjusted; cashout < crashAt",
            firstHmacHex: ctx.first_hmac_hex,
            crashAtMul: ctx.crashAtMul,
            txSig,
            payoutLamports: String(payout), // NET
            multiplierBps: multBps,
            cashoutMultiplier: m,
          };
          socket.emit("crash:resolved", revealPayload);
          socket.emit("crash:reveal_seed", revealPayload);

          rounds.delete(Number(nonce));

          // ---- Push live win feed (cashout) ----
try {
  const payoutSol = ctx.fakeMode
    ? Number(grossPayoutLamports(ctx.betLamports, m)) / 1e9
    : Number(ctx.betLamports * BigInt(toBps(m)) / 10000n) / 1e9;

  pushWinEvent({
    user: ctx.wallet,
    game: "crash",
    amountSol: Number(ctx.betLamports) / 1e9,
    payoutSol,
    result: payoutSol > Number(ctx.betLamports) / 1e9 ? "win" : "loss",
  });
} catch (err) {
  console.warn("[crash] pushWinEvent (cashout) failed:", err?.message || err);
}

        } else {
          // ----- FAKE MODE (promo) pays GROSS (stake was frozen) -----
          const payoutGross = grossPayoutLamports(ctx.betLamports, m); // GROSS
          await Promo.settleBet(ctx.wallet, Number(payoutGross)).catch(() => {});

          try {
            await DB.pool?.query(
              `UPDATE crash_rounds
                 SET cashout_multiplier_bps=$1, payout_lamports=$2, resolve_tx_sig=$3,
                     status='resolved', resolved_at=now()
               WHERE nonce=$4`,
              [toBps(m), Number(payoutGross), makeFakeTxSig("FAKE-RESOLVE", nonce), BigInt(nonce)]
            );
          } catch (e) {
            console.warn("[crash] update resolved (fake) warn:", e?.message || e);
          }

          try {
            await DB.recordGameRound?.({
              game_key: "crash",
              player: ctx.wallet,
              nonce: Number(nonce),
              stake_lamports: Number(ctx.betLamports),
              payout_lamports: Number(payoutGross), // store GROSS in promo path (parity with dice fake)
              result_json: { crashedAt: ctx.crashAtMul, cashout: m, fake: true },
            });
            if (payoutGross > 0n) {
              await DB.recordActivity?.({
                user: ctx.wallet,
                action: "Crash cashout (fake)",
                amount: (Number(payoutGross) / 1e9).toFixed(4),
              });
            }
          } catch {}

          const revealPayload = {
            nonce: String(nonce),
            serverSeedHex: ctx.serverSeedHex,
            clientSeed: ctx.clientSeed,
            formula: "HMAC_SHA256(serverSeed, clientSeed + nonce) → first 8 bytes → u64 >> 11 / 2^53 → edge adjusted; cashout < crashAt",
            firstHmacHex: ctx.first_hmac_hex,
            crashAtMul: ctx.crashAtMul,
            txSig: makeFakeTxSig("FAKE-RESOLVE", nonce),
            payoutLamports: String(payoutGross), // GROSS
            multiplierBps: toBps(m),
            cashoutMultiplier: m,
          };
          socket.emit("crash:resolved", revealPayload);
          socket.emit("crash:reveal_seed", revealPayload);

          rounds.delete(Number(nonce));
        }
      } catch (e) {
        console.error("crash:cashout error:", e);
        socket.emit("crash:error", { code: "CASHOUT_FAIL", message: String(e.message || e) });
      }
    });
  });
}

module.exports = { attachCrash, attachCrashRoutes, ensureCrashSchema };
