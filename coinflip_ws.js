// coinflip_ws.js
// Provably-fair Coinflip (PVP) with promo/fake balance support.
// - Computes outcome (and winner) BEFORE initial DB insert, so NOT NULL(winner/outcome) is satisfied.
// - Adds REST: GET /coinflip/resolved?wallet=...&limit=...&cursor=...

const crypto = require("crypto");
const {
  PublicKey,
  VersionedTransaction,
  TransactionMessage,
  ComputeBudgetProgram,
} = require("@solana/web3.js");

const DB = global.db || require("./db");
const Promo = require("./promo_balance");

let precheckOrThrow = async () => {};
try { ({ precheckOrThrow } = require("./bonus_guard")); } catch (_) {}

const {
  connection,
  PROGRAM_ID,
  deriveVaultPda,
  deriveAdminPda,
  deriveUserVaultPda,
  derivePendingFlipPda,
  buildEd25519VerifyIx,
} = require("./solana");

const { ixFlipLock, ixFlipResolve } = require("./solana_anchor_ix");
const { ADMIN_PK, signMessageEd25519, getServerKeypair } = require("./signer");

// ---------- helpers ----------
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const makeFakeTxSig = (pfx, nonce, role) => `${pfx}-${String(nonce)}-${role}`;

function sha256Hex(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function deriveOutcomeAndHmac({ serverSeed, clientSeedA, clientSeedB, nonce }) {
  const h = crypto
    .createHmac("sha256", serverSeed)
    .update(String(clientSeedA || ""))
    .update("|")
    .update(String(clientSeedB || ""))
    .update("|")
    .update(Buffer.from(String(nonce)))
    .digest();
  const outcome = h[0] & 1; // 0=heads, 1=tails
  return { outcome, firstHmacHex: h.toString("hex") };
}

async function ensureCoinflipSchema() {
  if (!DB?.pool) return;
  await DB.pool.query(`
    CREATE TABLE IF NOT EXISTS coinflip_matches (
      id BIGSERIAL PRIMARY KEY,
      nonce BIGINT UNIQUE NOT NULL,
      player_a TEXT NOT NULL,
      player_b TEXT NOT NULL,
      side_a INT NOT NULL,
      side_b INT NOT NULL,
      bet_lamports BIGINT NOT NULL,
      outcome INT,
      winner TEXT,
      payout_lamports BIGINT NOT NULL DEFAULT 0,
      fee_bps INT NOT NULL DEFAULT 600,
      resolve_sig_winner TEXT,
      resolve_sig_loser TEXT,
      server_seed_hash TEXT,
      server_seed TEXT,           -- hex string
      first_hmac_hex TEXT,
      client_seed_a TEXT NOT NULL DEFAULT '',
      client_seed_b TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'locked',
      created_at timestamptz NOT NULL DEFAULT now(),
      resolved_at timestamptz
    );
    -- relax in case older schema had NOT NULL
    ALTER TABLE coinflip_matches ALTER COLUMN outcome DROP NOT NULL;
    ALTER TABLE coinflip_matches ALTER COLUMN winner  DROP NOT NULL;
    ALTER TABLE coinflip_matches ALTER COLUMN payout_lamports SET DEFAULT 0;
    ALTER TABLE coinflip_matches ALTER COLUMN fee_bps         SET DEFAULT 600;
    ALTER TABLE coinflip_matches ALTER COLUMN status          SET DEFAULT 'locked';
    CREATE INDEX IF NOT EXISTS idx_cf_a_status_id ON coinflip_matches (player_a, status, id DESC);
    CREATE INDEX IF NOT EXISTS idx_cf_b_status_id ON coinflip_matches (player_b, status, id DESC);
  `);
}

// --- promo helpers support old/new signatures ---
async function promoFreeze(wallet, amountLamports) {
  try {
    return await Promo.freezeForBet({ wallet, amountLamports, gameKey: "coinflip" });
  } catch {
    try { return await Promo.freezeForBet(wallet, amountLamports); } catch { return false; }
  }
}
async function promoSettle(wallet, payoutLamports, win) {
  try {
    return await Promo.settleBet({ wallet, payoutLamports, win, gameKey: "coinflip" });
  } catch {
    try { return await Promo.settleBet(wallet, payoutLamports); } catch { return false; }
  }
}

// ---------- on-chain lock for a single player ----------
async function serverLock({ playerPk, side, stakeLamports, nonce, expiryUnix }) {
  const feePayer  = await getServerKeypair();
  const userVault = deriveUserVaultPda(playerPk);
  const houseVault= deriveVaultPda();
  const pending   = derivePendingFlipPda(playerPk, nonce);

  const msg = Buffer.from(
    `FLIP_LOCK|${playerPk.toBase58()}|${stakeLamports}|${side}|${nonce}|${expiryUnix}`
  );
  const edSig = await signMessageEd25519(msg);
  const edIx  = buildEd25519VerifyIx({ message: msg, signature: edSig, publicKey: ADMIN_PK });

  const cuLimit = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });
  const edIndex = 2;

  const lockIx = ixFlipLock({
    programId: PROGRAM_ID,
    player: playerPk,
    feePayer: feePayer.publicKey,
    userVault,
    houseVault,
    pendingFlip: pending,
    betAmount: Number(stakeLamports),
    side: Number(side),
    nonce,
    expiryUnix,
    edIndex,
  });

  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const msgV0 = new TransactionMessage({
    payerKey: feePayer.publicKey,
    recentBlockhash: blockhash,
    instructions: [cuLimit, edIx, lockIx],
  }).compileToV0Message();

  const vtx = new VersionedTransaction(msgV0);
  const sim = await connection.simulateTransaction(vtx, { sigVerify: false });
  if (sim.value.err) {
    const logs = (sim.value.logs || []).join("\n");
    throw new Error(`coinflip lock simulate failed: ${JSON.stringify(sim.value.err)}\n${logs}`);
  }

  vtx.sign([feePayer]);
  const sig = await connection.sendRawTransaction(vtx.serialize(), { skipPreflight: false, maxRetries: 5 });
  await connection.confirmTransaction(sig, "confirmed");

  return { pending: pending.toBase58(), txSig: sig };
}

// ---------- on-chain resolve for a single player ----------
async function serverResolve({ playerPk, winnerSide, payoutLamports, nonce }) {
  const feePayer  = await getServerKeypair();
  const userVault = deriveUserVaultPda(playerPk);
  const houseVault= deriveVaultPda();
  const adminPda  = deriveAdminPda();
  const pending   = derivePendingFlipPda(playerPk, nonce);

  const rmsg = Buffer.from(
    `FLIP_RESOLVE|${playerPk.toBase58()}|${nonce}|${winnerSide}|${payoutLamports}`
  );
  const edSig = await signMessageEd25519(rmsg);
  const edIx  = buildEd25519VerifyIx({ message: rmsg, signature: edSig, publicKey: ADMIN_PK });

  const cuLimit = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });
  const edIndex = 1;

  const resIx = ixFlipResolve({
    programId: PROGRAM_ID,
    player: playerPk,
    houseVault,
    adminPda,
    userVault,
    pendingFlip: pending,
    winnerSide: Number(winnerSide),
    payout: Number(payoutLamports),
    edIndex,
  });

  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const msgV0 = new TransactionMessage({
    payerKey: feePayer.publicKey,
    recentBlockhash: blockhash,
    instructions: [cuLimit, edIx, resIx],
  }).compileToV0Message();

  const vtx = new VersionedTransaction(msgV0);
  const sim = await connection.simulateTransaction(vtx, { sigVerify: false });
  if (sim.value.err) {
    const logs = (sim.value.logs || []).join("\n");
    throw new Error(`coinflip resolve simulate failed: ${JSON.stringify(sim.value.err)}\n${logs}`);
  }

  vtx.sign([feePayer]);
  const sig = await connection.sendRawTransaction(vtx.serialize(), { skipPreflight: false, maxRetries: 5 });
  await connection.confirmTransaction(sig, "confirmed");
  return sig;
}

// ---------------- In-memory rooms ----------------
const QUEUE_TTL_MS = Number(process.env.COINFLIP_QUEUE_TTL_MS || 3000);
const waiting = [];
const rooms = new Map();

async function createRoom(io, A, B) {
  const nonce = Date.now();
  const expiryUnix = Math.floor(Date.now() / 1000) + Number(process.env.NONCE_TTL_SECONDS || 300);

  const serverSeed = crypto.randomBytes(32);
  const serverSeedHash = sha256Hex(serverSeed);
  const serverSeedHex = serverSeed.toString("hex");

  const entryLamports = BigInt(A.entryLamports);
  const A_pk = new PublicKey(A.playerPk);
  const B_pk = new PublicKey(B.playerPk);

  const sameSide = Number(A.side) === Number(B.side);
  const eitherFake = !!(A.fakeMode || B.fakeMode);

  // Compute PF outcome + first HMAC
  const { outcome, firstHmacHex } = deriveOutcomeAndHmac({
    serverSeed,
    clientSeedA: A.clientSeed,
    clientSeedB: B.clientSeed,
    nonce,
  });

  // Winner is fully determined by outcome & sides; we can compute it now
  const winnerKeyInit = sameSide ? (outcome === 0 ? "A" : "B")
                                 : (outcome === Number(A.side) ? "A" : "B");
  const winnerBase58Init = winnerKeyInit === "A" ? A_pk.toBase58() : B_pk.toBase58();

  rooms.set(nonce, {
    A: {
      socketId: A.socketId,
      playerPk: A_pk,
      side: Number(A.side),
      clientSeed: String(A.clientSeed || ""),
      wallet: A.playerPk,
      fakeMode: !!A.fakeMode,
      isBot: !!A.isBot,
    },
    B: {
      socketId: B.socketId,
      playerPk: B_pk,
      side: Number(B.side),
      clientSeed: String(B.clientSeed || ""),
      wallet: B.playerPk,
      fakeMode: !!B.fakeMode,
      isBot: !!B.isBot,
    },
    entryLamports,
    pendingA: null,
    pendingB: null,
    sameSide,
    serverSeed,
    serverSeedHash,
    serverSeedHex,
    firstHmacHex,
  });

  // Notify
  if (A.socketId) io.to(A.socketId).emit("coinflip:matched", {
    nonce: String(nonce),
    you: A.side === 0 ? "heads" : "tails",
    opponentSide: B.side,
    opponent: B.isBot ? "bot" : "human",
  });
  if (B.socketId) io.to(B.socketId).emit("coinflip:matched", {
    nonce: String(nonce),
    you: B.side === 0 ? "heads" : "tails",
    opponentSide: A.side,
    opponent: A.isBot ? "bot" : "human",
  });

  // Lock phase
  if (!eitherFake) {
    const lockA = await serverLock({
      playerPk: A_pk,
      side: Number(A.side),
      stakeLamports: entryLamports,
      nonce,
      expiryUnix,
    });
    const lockB = await serverLock({
      playerPk: B_pk,
      side: Number(B.side),
      stakeLamports: entryLamports,
      nonce,
      expiryUnix,
    });

    rooms.get(nonce).pendingA = lockA.pending;
    rooms.get(nonce).pendingB = lockB.pending;

    if (A.socketId)
      io.to(A.socketId).emit("coinflip:locked", {
        nonce: String(nonce),
        txSig: lockA.txSig,
        role: "A",
        serverSeedHash,
      });
    if (B.socketId)
      io.to(B.socketId).emit("coinflip:locked", {
        nonce: String(nonce),
        txSig: lockB.txSig,
        role: "B",
        serverSeedHash,
      });
  } else {
    // FAKE mode: freeze promo for humans
    const R = rooms.get(nonce);

    if (R.A.fakeMode && !R.A.isBot) {
      const okA = await promoFreeze(R.A.wallet, entryLamports);
      if (!okA) {
        if (A.socketId) io.to(A.socketId).emit("coinflip:error", { code: "FAKE_BALANCE_LOW", message: "Insufficient promo balance" });
        rooms.delete(nonce);
        return;
      }
    }
    if (R.B.fakeMode && !R.B.isBot) {
      const okB = await promoFreeze(R.B.wallet, entryLamports);
      if (!okB) {
        if (B.socketId) io.to(B.socketId).emit("coinflip:error", { code: "FAKE_BALANCE_LOW", message: "Insufficient promo balance" });
        rooms.delete(nonce);
        return;
      }
    }

    if (A.socketId)
      io.to(A.socketId).emit("coinflip:locked", {
        nonce: String(nonce),
        txSig: makeFakeTxSig("FAKE-LOCK", nonce, "A"),
        role: "A",
        serverSeedHash,
      });
    if (B.socketId)
      io.to(B.socketId).emit("coinflip:locked", {
        nonce: String(nonce),
        txSig: makeFakeTxSig("FAKE-LOCK", nonce, "B"),
        role: "B",
        serverSeedHash,
      });
  }

  // ---- Persist locked (now includes OUTCOME + WINNER) ----
  try {
    if (typeof DB.pool?.query === "function") {
      await DB.pool.query(
        `INSERT INTO coinflip_matches
           (nonce, player_a, player_b, side_a, side_b, bet_lamports,
            outcome, winner, status,
            server_seed_hash, server_seed, first_hmac_hex,
            client_seed_a, client_seed_b, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'locked',$9,$10,$11,$12,$13, now())
         ON CONFLICT (nonce) DO UPDATE SET
           player_a        = EXCLUDED.player_a,
           player_b        = EXCLUDED.player_b,
           side_a          = EXCLUDED.side_a,
           side_b          = EXCLUDED.side_b,
           bet_lamports    = EXCLUDED.bet_lamports,
           outcome         = EXCLUDED.outcome,
           winner          = EXCLUDED.winner,
           status          = 'locked',
           server_seed_hash= EXCLUDED.server_seed_hash,
           server_seed     = EXCLUDED.server_seed,
           first_hmac_hex  = EXCLUDED.first_hmac_hex,
           client_seed_a   = EXCLUDED.client_seed_a,
           client_seed_b   = EXCLUDED.client_seed_b
        `,
        [
          BigInt(nonce),
          A_pk.toBase58(),
          B_pk.toBase58(),
          Number(A.side),
          Number(B.side),
          Number(entryLamports),
          Number(outcome),
          winnerBase58Init,
          serverSeedHash,
          serverSeedHex,
          firstHmacHex,
          String(A.clientSeed || ""),
          String(B.clientSeed || ""),
        ]
      );
    }
  } catch (e) {
    console.warn("[coinflip] DB insert locked warn:", e?.message || e);
  }

  // Spin-up animation hint
  io.to(A.socketId || "").emit("coinflip:starting", { nonce: String(nonce), outcome });
  io.to(B.socketId || "").emit("coinflip:starting", { nonce: String(nonce), outcome });

  // Fee & payout
  let feeBps = 600;
  try {
    const cfg = await DB.getGameConfig?.("coinflip");
    if (cfg?.fee_bps != null) feeBps = Number(cfg.fee_bps);
  } catch {}
  const totalPot = entryLamports * 2n;
  const fee = (totalPot * BigInt(feeBps)) / 10000n;
  const payout = totalPot - fee;

  // Winner/loser (consistent with init decision)
  const winnerKey = winnerKeyInit;
  const loserKey  = winnerKey === "A" ? "B" : "A";

  // Resolve
  let sigWin = null;
  let sigLos = null;

  if (!eitherFake) {
    const winnerPk = rooms.get(nonce)[winnerKey].playerPk;
    const loserPk  = rooms.get(nonce)[loserKey].playerPk;
    sigWin = await serverResolve({ playerPk: winnerPk, winnerSide: outcome, payoutLamports: payout, nonce });
    sigLos = await serverResolve({ playerPk: loserPk,  winnerSide: outcome, payoutLamports: 0n,    nonce });
  } else {
    const R = rooms.get(nonce);
    const win = R[winnerKey];
    const los = R[loserKey];
    if (win.fakeMode && !win.isBot) await promoSettle(win.wallet, payout, true);
    if (los.fakeMode && !los.isBot) await promoSettle(los.wallet, 0n, false);
    sigWin = makeFakeTxSig("FAKE-RESOLVE", nonce, winnerKey);
    sigLos = makeFakeTxSig("FAKE-RESOLVE", nonce, loserKey);
  }

  // Persist final
  try {
    await DB.recordCoinflipMatch?.({
      nonce: Number(nonce),
      player_a: A_pk.toBase58(),
      player_b: B_pk.toBase58(),
      side_a: Number(A.side),
      side_b: Number(B.side),
      bet_lamports: Number(entryLamports),
      outcome: Number(outcome),
      winner: winnerBase58Init,
      payout_lamports: Number(payout),
      fee_bps: feeBps,
      resolve_sig_winner: sigWin,
      resolve_sig_loser: sigLos,
    }).catch(() => {});

    if (typeof DB.pool?.query === "function") {
      await DB.pool.query(
        `UPDATE coinflip_matches
            SET outcome=$1, winner=$2, payout_lamports=$3, fee_bps=$4, status='resolved',
                resolve_sig_winner=$5, resolve_sig_loser=$6, resolved_at=now()
          WHERE nonce=$7`,
        [ Number(outcome), winnerBase58Init, Number(payout), feeBps, sigWin, sigLos, BigInt(nonce) ]
      );
    }

    await DB.recordActivity?.({
      user: winnerBase58Init,
      action: eitherFake ? "Coinflip win (fake)" : "Coinflip win",
      amount: (Number(payout) / 1e9).toFixed(4),
    }).catch(() => {});
  } catch (e) {
    console.warn("[coinflip] DB save warn:", e?.message || e);
  }

  // Notify clients
  const resultPayload = {
    nonce: String(nonce),
    outcome,
    feeLamports: Number(fee),
    payoutLamports: Number(payout),
    txWinner: sigWin,
    txLoser:  sigLos,
  };
  if (rooms.get(nonce).A.socketId) io.to(rooms.get(nonce).A.socketId).emit("coinflip:resolved", resultPayload);
  if (rooms.get(nonce).B.socketId) io.to(rooms.get(nonce).B.socketId).emit("coinflip:resolved", resultPayload);

  // PF reveal
  try {
    const r = rooms.get(nonce);
    const revealPayload = {
      nonce: String(nonce),
      serverSeedHex: r.serverSeedHex,
      serverSeedHash: r.serverSeedHash,
      clientSeedA: r.A.clientSeed || "",
      clientSeedB: r.B.clientSeed || "",
      formula: "HMAC_SHA256(serverSeed, clientSeedA + '|' + clientSeedB + '|' + nonce) -> first byte & 1",
      firstHmacHex: r.firstHmacHex,
    };
    if (r.A.socketId) io.to(r.A.socketId).emit("coinflip:reveal_seed", revealPayload);
    if (r.B.socketId) io.to(r.B.socketId).emit("coinflip:reveal_seed", revealPayload);
  } catch (err) {
    console.warn("[coinflip] reveal_seed emit failed:", err?.message || err);
  }

  rooms.delete(nonce);
}

// ---------------- REST: /coinflip/resolved ----------------
async function dbListCoinflipResolvedByWallet(wallet, { limit = 50, cursor = null } = {}) {
  if (!DB?.pool) return { items: [], nextCursor: null };
  const L = Math.max(1, Math.min(200, Number(limit) || 50));
  const baseWhere = `status='resolved' AND (player_a = $1 OR player_b = $1)`;

  const selectCols = `
    id::text,
    nonce::text,
    player_a,
    player_b,
    side_a,
    side_b,
    bet_lamports::text,
    outcome,
    winner,
    payout_lamports::text,
    fee_bps,
    resolve_sig_winner,
    resolve_sig_loser,
    server_seed_hash,
    server_seed AS server_seed_hex,
    first_hmac_hex,
    client_seed_a,
    client_seed_b,
    status,
    created_at,
    resolved_at
  `;

  if (cursor) {
    const { rows } = await DB.pool.query(
      `SELECT ${selectCols} FROM coinflip_matches
        WHERE ${baseWhere} AND id < $2
        ORDER BY id DESC LIMIT $3`,
      [String(wallet), Number(cursor), L]
    );
    const nextCursor = rows.length ? rows[rows.length - 1].id : null;
    return { items: rows, nextCursor };
  } else {
    const { rows } = await DB.pool.query(
      `SELECT ${selectCols} FROM coinflip_matches
        WHERE ${baseWhere}
        ORDER BY id DESC LIMIT $2`,
      [String(wallet), L]
    );
    const nextCursor = rows.length ? rows[rows.length - 1].id : null;
    return { items: rows, nextCursor };
  }
}

function attachCoinflipRoutes(app) {
  if (!app || !app.use) return;
  const express = require("express");
  const router = express.Router();

  router.get("/resolved", async (req, res) => {
    try {
      const wallet = String(req.query.wallet || "");
      const limit = req.query.limit;
      const cursor = req.query.cursor;
      if (!wallet || wallet.length < 32) return res.status(400).json({ error: "bad wallet" });

      await ensureCoinflipSchema().catch(() => {});
      const out = await dbListCoinflipResolvedByWallet(wallet, { limit, cursor });
      out.verify = {
        algorithm: "HMAC_SHA256(serverSeed, clientSeedA + '|' + clientSeedB + '|' + nonce) -> first byte & 1",
      };
      res.json(out);
    } catch (e) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  app.use("/coinflip", router);
}

// ---------------- Attach ----------------
function attachCoinflip(io, app /* optional */) {
  ensureCoinflipSchema().catch((e) => console.warn("[ensureCoinflipSchema] warn:", e?.message || e));
  try { attachCoinflipRoutes(app); } catch (_) {}

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

    socket.on("coinflip:join", async ({ player, side, entryLamports, clientSeed }) => {
      try {
        if (!player) return socket.emit("coinflip:error", { code: "NO_PLAYER", message: "player required" });

        const cfg = await DB.getGameConfig?.("coinflip");
        if (cfg && (!cfg.enabled || !cfg.running)) {
          return socket.emit("coinflip:error", { code: "DISABLED", message: "Coinflip disabled by admin" });
        }
        const min = BigInt(cfg?.min_bet_lamports ?? 50000n);
        const max = BigInt(cfg?.max_bet_lamports ?? 5_000_000_000n);

        const stake = BigInt(entryLamports || 0);
        if (!(stake > 0n)) return socket.emit("coinflip:error", { code: "BAD_BET", message: "entryLamports must be > 0" });
        if (stake < min || stake > max) return socket.emit("coinflip:error", { code: "BET_RANGE", message: "Bet outside allowed range" });

        const s = clamp(Number(side), 0, 1);
        const playerPk = new PublicKey(player);

        const fakeMode = await Promo.isFakeMode(playerPk.toBase58());
        if (!fakeMode) {
          await precheckOrThrow({
            userWallet: player,
            stakeLamports: stake.toString(),
            gameKey: "coinflip_pvp",
          });
        }

        // match by stake and mode
        let oppIdx = waiting.findIndex(
          (w) => w.entryLamports === String(stake) && Number(w.side) !== s && !!w.fakeMode === !!fakeMode
        );
        if (oppIdx < 0) {
          oppIdx = waiting.findIndex(
            (w) => w.entryLamports === String(stake) && Number(w.side) === s && !!w.fakeMode === !!fakeMode
          );
        }

        if (oppIdx >= 0) {
          const opponent = waiting.splice(oppIdx, 1)[0];
          clearTimeout(opponent.timer);

          const A = {
            socketId: opponent.socketId,
            playerPk: opponent.playerPk,
            entryLamports: String(stake),
            side: Number(opponent.side),
            clientSeed: opponent.clientSeed,
            fakeMode: !!opponent.fakeMode,
            isBot: !!opponent.isBot,
          };
          const B = {
            socketId: socket.id,
            playerPk: playerPk.toBase58(),
            entryLamports: String(stake),
            side: s,
            clientSeed: String(clientSeed || ""),
            fakeMode: !!fakeMode,
            isBot: false,
          };
          await createRoom(io, A, B);
          return;
        }

        // queue & bot fallback (same mode)
        const w = {
          socketId: socket.id,
          playerPk: playerPk.toBase58(),
          entryLamports: String(stake),
          side: s,
          clientSeed: String(clientSeed || ""),
          fakeMode: !!fakeMode,
          isBot: false,
          timer: null,
        };
        w.timer = setTimeout(async () => {
          const idx = waiting.findIndex((x) => x === w);
          if (idx < 0) return;
          waiting.splice(idx, 1);

          const bot = await getServerKeypair();
          const botSide = 1 - s;
          const A = {
            socketId: socket.id,
            playerPk: w.playerPk,
            entryLamports: String(stake),
            side: s,
            clientSeed: w.clientSeed,
            fakeMode: !!fakeMode,
            isBot: false,
          };
          const B = {
            socketId: null,
            playerPk: bot.publicKey.toBase58(),
            entryLamports: String(stake),
            side: botSide,
            clientSeed: "",
            isBot: true,
            fakeMode: !!fakeMode,
          };
          try { await createRoom(io, A, B); }
          catch (e) { io.to(socket.id).emit("coinflip:error", { code: "BOT_FAIL", message: String(e.message || e) }); }
        }, QUEUE_TTL_MS);

        waiting.push(w);
        socket.emit("coinflip:queued", { side: s, entryLamports: String(stake) });
      } catch (e) {
        console.error("coinflip:join error:", e);
        socket.emit("coinflip:error", { code: "JOIN_FAIL", message: e.message || String(e) });
      }
    });
  });
}

module.exports = { attachCoinflip, attachCoinflipRoutes, ensureCoinflipSchema };
