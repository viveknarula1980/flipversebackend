// backend/mines_ws.js
// WS + HTTP for Mines with DB schema auto-detection (works with legacy tables).
//
// Adds HTTP routes:
//   GET /mines/ping
//   GET /mines/resolved?wallet=<base58>&limit=10&cursor=<id>
//
// If you only mounted the WS before, also mount HTTP in server.js:
//   const mines = require("./mines_ws");
//   mines.attachMines(io);
//   mines.attachMinesRoutes(app);

const crypto = require("crypto");
const {
  PublicKey,
  VersionedTransaction,
  TransactionMessage,
  ComputeBudgetProgram,
} = require("@solana/web3.js");

const DB = global.db || require("./db");

// ---------- optional bonus guard ----------
let precheckOrThrow = async () => {};
try { ({ precheckOrThrow } = require("./bonus_guard")); } catch (_) {}

// ---------- promo balance helpers ----------
const Promo = require("./promo_balance");
const { pushWinEvent } = require("./ws_wins");


// ---------- solana helpers ----------
const baseSolana = require("./solana");
const {
  connection,
  PROGRAM_ID,
  deriveVaultPda,
  deriveAdminPda,
  deriveUserVaultPda,
  buildEd25519VerifyIx,
} = baseSolana;

const derivePending =
  typeof baseSolana.derivePendingMinesPda === "function"
    ? baseSolana.derivePendingMinesPda
    : baseSolana.derivePendingRoundPda;

const { ixMinesLock, ixMinesResolve } = require("./solana_anchor_ix");
const { signMessageEd25519, ADMIN_PK, getServerKeypair } = require("./signer");

// ---------- small helpers ----------
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function i32(x) { const n = Number(x); return Number.isFinite(n) ? (n | 0) : 0; }
function sha256Hex(buf) { return crypto.createHash("sha256").update(buf).digest("hex"); }
function minesChecksum(nonce) { return Number((BigInt(nonce) % 251n) + 1n) & 0xff; }

// ---------- provably fair bombs (NO first-click safety) ----------
/**
 * Deterministic bomb placement using HMAC(serverSeed, playerPk | nonce | clientSeed).
 * IMPORTANT: Does NOT exclude the first clicked index — first click can be a bomb.
 */
function deriveBombs({ rows, cols, mines, playerPk, nonce, serverSeed, clientSeed }) {
  const total = rows * cols;
  if (!serverSeed) throw new Error("serverSeed required for deriveBombs");

  const seedKey = crypto
    .createHmac("sha256", serverSeed)
    .update(playerPk.toBuffer())
    .update(Buffer.from(String(nonce)))
    .update(Buffer.from(String(clientSeed || "")))
    .digest();

  const picked = new Set();
  let i = 0;
  while (picked.size < mines) {
    const rng = crypto.createHmac("sha256", seedKey).update(Buffer.from(String(i++))).digest();
    const n = ((rng[0] << 24) | (rng[1] << 16) | (rng[2] << 8) | rng[3]) >>> 0;
    const idx = n % total;
    picked.add(idx); // no exclusion
  }
  return picked;
}

function multiplierFor(safeOpened, totalTiles, mines, rtpBps = 10000) {
  if (safeOpened <= 0) return 1;
  let m = 1;
  for (let i = 0; i < safeOpened; i++) {
    const totalLeft = totalTiles - i;
    const safeLeft = (totalTiles - mines) - i;
    m *= totalLeft / safeLeft;
  }
  m *= (rtpBps / 10000);
  return Math.max(1, m);
}

// ---------- in-memory rounds ----------
const rounds = new Map();

// ---------- schema detection ----------
const COLS = { set: null };

async function ensureCols() {
  if (COLS.set) return COLS.set;
  try {
    if (!DB?.pool?.query) {
      COLS.set = new Set();
      return COLS.set;
    }
    const r = await DB.pool.query(
      `select column_name from information_schema.columns
       where table_schema='public' and table_name='mines_rounds'`
    );
    COLS.set = new Set(r.rows.map((x) => x.column_name));
    console.log("[mines] detected columns:", [...COLS.set].join(", "));
  } catch (e) {
    console.warn("[mines] schema detection failed:", e?.message || e);
    COLS.set = new Set();
  }
  return COLS.set;
}
function hasCol(name) { return COLS.set && COLS.set.has(name); }
function pickFirst(...names) {
  for (const n of names) if (hasCol(n)) return n;
  return null;
}

// ---------- DB helpers (dynamic SQL) ----------
async function dbInsertLockedRow(ctx, txSig, mode) {
  try {
    if (!DB?.pool?.query) return;
    await ensureCols();

    const cols = [];
    const vals = [];
    const params = [];
    let i = 1;

    const push = (name, value) => { cols.push(name); params.push(value); vals.push(`$${i++}`); };

    push("player", ctx.playerPk.toBase58());
    push("nonce", BigInt(ctx.nonce));
    push("bet_lamports", Number(ctx.betLamports));
    push("rows", ctx.rows);
    push("cols", ctx.cols);
    push("mines", ctx.mines);
    if (hasCol("server_seed_hash")) push("server_seed_hash", ctx.serverSeedHash);
    // SECURITY: do NOT persist server_seed here; only reveal on resolve
    if (hasCol("client_seed")) push("client_seed", ctx.clientSeed || "");
    if (hasCol("first_hmac_hex")) push("first_hmac_hex", ctx.firstHmacHex || null);
    if (hasCol("rtp_bps")) push("rtp_bps", Number(ctx.rtpBps || 10000));
    if (hasCol("status")) push("status", "locked");
    const lockCol = pickFirst("lock_sig", "lock_tx_sig");
    if (lockCol) push(lockCol, txSig || null);
    if (hasCol("expiry_unix")) push("expiry_unix", Number(ctx.expiryUnix));
    if (hasCol("mode")) push("mode", mode);
    const pendingCol = pickFirst("pending_round", "pending_mines_round");
    if (pendingCol) push(pendingCol, ctx.pending || null);

    const sql =
      `insert into mines_rounds(${cols.join(",")}) values (${vals.join(",")})
       on conflict (nonce) do nothing`;
    await DB.pool.query(sql, params);
  } catch (e) {
    console.warn("[mines] insert locked warn:", e?.message || e);
  }
}

async function dbUpdateOpened(nonce, openedSet) {
  try {
    if (!DB?.pool?.query) return;
    await ensureCols();

    if (!hasCol("opened_json")) return; // nothing to persist
    const sql = `update mines_rounds set opened_json=$2 where nonce=$1`;
    await DB.pool.query(sql, [BigInt(nonce), JSON.stringify(Array.from(openedSet).sort((a, b) => a - b))]);
  } catch (e) {
    console.warn("[mines] update opened warn:", e?.message || e);
  }
}

async function dbResolve(nonce, payoutLamports, resolvedSig, revealSeedHex) {
  try {
    if (!DB?.pool?.query) return;
    await ensureCols();

    const sets = [];
    const params = [BigInt(nonce)];
    let i = 2;

    if (hasCol("status")) { sets.push(`status=$${i}`); params.push("resolved"); i++; }
    if (hasCol("payout_lamports")) { sets.push(`payout_lamports=$${i}`); params.push(Number(payoutLamports || 0)); i++; }
    const resolvedCol = pickFirst("resolved_tx_sig", "resolve_tx_sig", "resolved_sig");
    if (resolvedCol) { sets.push(`${resolvedCol}=$${i}`); params.push(resolvedSig || null); i++; }
    if (hasCol("server_seed")) { sets.push(`server_seed=$${i}`); params.push(revealSeedHex || null); i++; }
    if (hasCol("resolved_at")) { sets.push(`resolved_at=now()`); }

    if (!sets.length) return; // nothing to update

    const sql = `update mines_rounds set ${sets.join(", ")} where nonce=$1`;
    await DB.pool.query(sql, params);
  } catch (e) {
    console.warn("[mines] resolve update warn:", e?.message || e);
  }
}

// ---------- HTTP router (fixes /mines/resolved 404) ----------
function makeMinesRouter() {
  const express = require("express");
  const router = express.Router();

  router.get("/ping", (req, res) => res.json({ ok: true }));

  router.get("/resolved", async (req, res) => {
    try {
      if (!DB?.pool?.query) return res.json({ items: [], nextCursor: null });

      await ensureCols();

      const wallet = String(req.query.wallet || "").trim();
      if (!wallet) return res.status(400).json({ error: "wallet required" });

      let limit = Number(req.query.limit || 20);
      if (!Number.isFinite(limit) || limit <= 0) limit = 20;
      limit = Math.min(100, Math.max(1, limit));

      const cursor =
        req.query.cursor != null && req.query.cursor !== "" ? Number(req.query.cursor) : null;

      const params = [wallet];
      const whereParts = ["player=$1"];
      if (hasCol("status")) whereParts.push(`status='resolved'`);
      if (Number.isFinite(cursor) && cursor) {
        params.push(cursor);
        whereParts.push(`id < $2`);
      }
      const where = whereParts.join(" AND ");

      // Build SELECT list that matches your schema
      const sel = [
        "id",
        "player",
        hasCol("bet_lamports") ? "bet_lamports" : "NULL::bigint as bet_lamports",
        "nonce",
        hasCol("rows") ? '"rows"' : "NULL::int as rows",
        hasCol("cols") ? '"cols"' : "NULL::int as cols",
        hasCol("mines") ? "mines" : "NULL::int as mines",
        hasCol("rtp_bps") ? "rtp_bps" : "NULL::int as rtp_bps",
        hasCol("payout_lamports") ? "payout_lamports" : "0::bigint as payout_lamports",
        hasCol("server_seed_hash") ? "server_seed_hash" : "NULL::text as server_seed_hash",
        hasCol("server_seed") ? "server_seed AS server_seed_hex" : "NULL::text as server_seed_hex",
        hasCol("first_hmac_hex") ? "first_hmac_hex" : "NULL::text as first_hmac_hex",
        hasCol("client_seed") ? "client_seed" : "''::text as client_seed",
        hasCol("first_safe_index") ? "first_safe_index" : "NULL::int as first_safe_index",
        hasCol("opened_json") ? "opened_json" : "NULL::jsonb as opened_json",
        hasCol("lock_sig") ? "lock_sig AS lock_tx_sig"
          : (hasCol("lock_tx_sig") ? "lock_tx_sig" : "NULL::text AS lock_tx_sig"),
        (pickFirst("resolved_tx_sig", "resolve_tx_sig", "resolved_sig") || "NULL::text") + " AS resolved_tx_sig",
        hasCol("status") ? "status" : "'resolved'::text as status",
        hasCol("created_at") ? "created_at" : "NULL::timestamp as created_at",
        hasCol("resolved_at") ? "resolved_at" : "NULL::timestamp as resolved_at",
      ];

      const sql =
        `SELECT ${sel.join(", ")}
           FROM mines_rounds
          WHERE ${where}
          ORDER BY id DESC
          LIMIT ${limit};`;

      const q = await DB.pool.query(sql, params);
      const items = q.rows || [];
      const nextCursor = items.length === limit ? Number(items[items.length - 1].id) : null;

      res.json({ items, nextCursor });
    } catch (e) {
      console.error("[GET /mines/resolved] error:", e);
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  return router;
}

function attachMinesRoutes(app) {
  if (!app) return;
  const router = makeMinesRouter();
  app.use("/mines", router);
  // (optional) also at /api/mines for frontends expecting /api prefix
  app.use("/api/mines", router);
  console.log("[mines] HTTP routes mounted at /mines and /api/mines");
}

// ---------- WebSocket attach (no first-click guarantee) ----------
function attachMines(io) {
  io.on("connection", (socket) => {
    socket.on("register", ({ player }) => { socket.data.player = String(player || "guest"); });

    // place / lock
    socket.on("mines:place", async ({ player, betAmountLamports, rows, cols, minesCount, clientSeed }) => {
      try {
        if (!player) return socket.emit("mines:error", { code: "NO_PLAYER", message: "player required" });

        const cfg = await DB.getGameConfig?.("mines").catch(() => null);
        if (cfg && (!cfg.enabled || !cfg.running)) {
          return socket.emit("mines:error", { code: "DISABLED", message: "Mines disabled by admin" });
        }

        const min = BigInt(cfg?.min_bet_lamports ?? 50_000n);
        const max = BigInt(cfg?.max_bet_lamports ?? 5_000_000_000n);

        const betLamports = BigInt(betAmountLamports || 0);
        if (!(betLamports > 0n)) return socket.emit("mines:error", { code: "BAD_BET", message: "betAmountLamports must be > 0" });
        if (betLamports < min || betLamports > max) return socket.emit("mines:error", { code: "BET_RANGE", message: "Bet outside allowed range" });

        const R = clamp(i32(rows), 2, 8);
        const C = clamp(i32(cols), 2, 8);
        const M = clamp(i32(minesCount), 1, R * C - 1);

        const wallet     = String(player);
        const playerPk   = new PublicKey(wallet);
        const userVault  = deriveUserVaultPda(playerPk);
        const houseVault = deriveVaultPda();

        const nonce      = Date.now();
        const expiryUnix = Math.floor(Date.now() / 1000) + Number(process.env.NONCE_TTL_SECONDS || 300);
        const pendingPda = derivePending ? derivePending(playerPk, nonce) : null;

        const fakeMode = await Promo.isFakeMode(wallet).catch(() => false);

        const serverSeed = crypto.randomBytes(32);
        const serverSeedHash = sha256Hex(serverSeed);

        const firstHmacHex = crypto
          .createHmac("sha256", serverSeed)
          .update(playerPk.toBuffer())
          .update(Buffer.from(String(nonce)))
          .update(Buffer.from(String(clientSeed || "")))
          .digest("hex");

        await precheckOrThrow({
          userWallet: wallet,
          stakeLamports: betLamports,
          gameKey: "mines",
        }).catch(() => {});

        const ctx = {
          mode: fakeMode ? "fake" : "real",
          playerPk,
          betLamports: BigInt(betLamports),
          rows: R, cols: C, mines: M,
          opened: new Set(),
          bombs: null,
          rtpBps: Number(cfg?.rtp_bps ?? 9800),
          over: false,
          nonce,
          expiryUnix,
          pending: pendingPda ? pendingPda.toBase58() : null,
          serverSeed,
          serverSeedHash,
          clientSeed: clientSeed || "",
          firstHmacHex,
          // no first-click pinning
          firstSafeIndex: null,
        };

        let txSig;
        if (ctx.mode === "fake") {
          await Promo.freezeForBet(wallet, String(betLamports));
          txSig = `FAKE-LOCK-${nonce}`;
        } else {
          const feePayer = await getServerKeypair();
          const msg = Buffer.from(`MINES_LOCK_V1|${wallet}|${Number(betLamports)}|${R}x${C}|${M}|${nonce}|${expiryUnix}`);
          const edSig = await signMessageEd25519(msg);
          const edIx  = buildEd25519VerifyIx({ message: msg, signature: edSig, publicKey: ADMIN_PK });
          const edIndex = 1;

          const cuLimit = ComputeBudgetProgram.setComputeUnitLimit({ units: 900_000 });
          const cuPrice = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 });

          const lockIx = ixMinesLock({
            programId: PROGRAM_ID,
            player: playerPk,
            feePayer: feePayer.publicKey,
            userVault,
            houseVault,
            pendingRound: pendingPda,
            betAmount: Number(betLamports),
            rows: R, cols: C, mines: M,
            nonce, expiryUnix, edIndex,
          });

          const { blockhash } = await connection.getLatestBlockhash("confirmed");
          const msgV0 = new TransactionMessage({
            payerKey: feePayer.publicKey,
            recentBlockhash: blockhash,
            instructions: [cuPrice, cuLimit, edIx, lockIx],
          }).compileToV0Message();

          const vtx = new VersionedTransaction(msgV0);
          const sim = await connection.simulateTransaction(vtx, { sigVerify: false }).catch(() => null);
          if (sim?.value?.err) {
            const logs = (sim.value?.logs || []).join("\n");
            throw new Error(`Mines lock simulate failed: ${JSON.stringify(sim.value.err)}\n${logs}`);
          }
          vtx.sign([feePayer]);
          txSig = await connection.sendRawTransaction(vtx.serialize(), { skipPreflight: false, maxRetries: 5 });
          await connection.confirmTransaction(txSig, "confirmed");
        }

        rounds.set(nonce, ctx);
        await dbInsertLockedRow(ctx, txSig, ctx.mode);

        DB.recordBet?.({
          player: wallet,
          amount: String(betLamports),
          betType: -1,
          target: -1,
          roll: 0,
          payout: 0,
          nonce, expiry: expiryUnix,
          signature_base58: txSig,
          mode: ctx.mode,
        }).catch(() => {});

        socket.emit("mines:locked", {
          nonce: String(nonce),
          txSig,
          rows: R, cols: C, mines: M,
          serverSeedHash,
          firstHmacHex,
        });
      } catch (e) {
        console.error("mines:place error:", e);
        socket.emit("mines:error", { code: "PLACE_FAIL", message: e?.message || String(e) });
      }
    });

    // open tile
    socket.on("mines:open", async ({ nonce, row, col }) => {
      try {
        let ctx = rounds.get(Number(nonce));

        if (!ctx && DB?.pool?.query) {
          try {
            await ensureCols();
            // Note: server_seed is NOT stored pre-resolve anymore; round resume after process restart may not be possible without external seed store.
            const q = await DB.pool.query(`select * from mines_rounds where nonce=$1 limit 1`, [BigInt(nonce)]);
            const w = q.rows[0] || null;
            if (w) {
              ctx = {
                mode: w.mode || "real",
                playerPk: new PublicKey(w.player),
                betLamports: BigInt(w.bet_lamports || w.bet_amount || 0),
                rows: Number(w.rows),
                cols: Number(w.cols),
                mines: Number(w.mines),
                opened: new Set(JSON.parse(w.opened_json || "[]")),
                bombs: null,
                rtpBps: Number(w.rtp_bps ?? 9800),
                over: w.status === "resolved",
                nonce: Number(w.nonce),
                expiryUnix: Number(w.expiry_unix || 0),
                // serverSeed may be NULL now; only hash is stored. Without in-memory ctx this round can't continue safely.
                serverSeed: w.server_seed ? Buffer.from(w.server_seed, "hex") : null,
                serverSeedHash: w.server_seed_hash || null,
                clientSeed: w.client_seed || "",
                pending: w.pending_round || w.pending_mines_round || null,
                firstHmacHex: w.first_hmac_hex || null,
                firstSafeIndex: null,
              };
              rounds.set(Number(nonce), ctx);
            }
          } catch (err) {
            console.warn("mines: DB restore warn:", err?.message || err);
          }
        }

        if (!ctx) return socket.emit("mines:error", { code: "NOT_FOUND", message: "no round" });
        if (ctx.over) return;

        const r = i32(row), c = i32(col);
        if (r < 0 || c < 0 || r >= ctx.rows || c >= ctx.cols) {
          return socket.emit("mines:error", { code: "BAD_COORD", message: "row/col out of range" });
        }

        const idx = r * ctx.cols + c;
        if (ctx.opened.has(idx)) return;

        if (!ctx.bombs) {
          if (!ctx.serverSeed && DB?.pool?.query) {
            try {
              const q = await DB.pool.query(`select server_seed from mines_rounds where nonce=$1 limit 1`, [BigInt(nonce)]);
              const rw = q.rows[0] || null;
              if (rw?.server_seed) ctx.serverSeed = Buffer.from(rw.server_seed, "hex");
            } catch (err) { console.warn("mines:read seed warn:", err?.message || err); }
          }
          if (!ctx.serverSeed) throw new Error("serverSeed missing for round (cannot derive bombs)");

          ctx.bombs = deriveBombs({
            rows: ctx.rows, cols: ctx.cols, mines: ctx.mines,
            playerPk: ctx.playerPk, nonce: Number(nonce),
            serverSeed: ctx.serverSeed,
            clientSeed: ctx.clientSeed || "",
          });
        }

        if (ctx.bombs.has(idx)) {
          ctx.over = true;

          const serverSeedHex = ctx.serverSeed.toString("hex");
          const recomputedHash = sha256Hex(ctx.serverSeed);
          const firstHmac = crypto
            .createHmac("sha256", ctx.serverSeed)
            .update(ctx.playerPk.toBuffer())
            .update(Buffer.from(String(ctx.nonce)))
            .update(Buffer.from(String(ctx.clientSeed || "")))
            .digest("hex");

          const openedArr = Array.from(ctx.opened).sort((a, b) => a - b);
          const bombIndices = Array.from(ctx.bombs).sort((a, b) => a - b);

          let txSig = null;
          if (ctx.mode === "fake") {
            await Promo.settleBet(ctx.playerPk.toBase58(), "0");
            txSig = `FAKE-RESOLVE-${ctx.nonce}-LOSS`;
          } else {
            const feePayer   = await getServerKeypair();
            const playerPk   = ctx.playerPk;
            const houseVault = deriveVaultPda();
            const adminPda   = deriveAdminPda();
            const userVault  = deriveUserVaultPda(playerPk);
            const pendingPda = derivePending ? derivePending(playerPk, ctx.nonce) : null;

            const checksum = minesChecksum(ctx.nonce);
            const msg = Buffer.from(`MINES_RESOLVE_V1|${playerPk.toBase58()}|${ctx.nonce}|${checksum}|0`);
            const edSig = await signMessageEd25519(msg);
            const edIx  = buildEd25519VerifyIx({ message: msg, signature: edSig, publicKey: ADMIN_PK });
            const edIndex = 1;

            const ix = ixMinesResolve({
              programId: PROGRAM_ID,
              player: playerPk,
              houseVault,
              adminPda,
              userVault,
              pendingRound: pendingPda,
              checksum,
              payout: 0,
              edIndex,
            });

            const cu = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });
            const { blockhash } = await connection.getLatestBlockhash("confirmed");
            const msgV0 = new TransactionMessage({
              payerKey: feePayer.publicKey,
              recentBlockhash: blockhash,
              instructions: [cu, edIx, ix],
            }).compileToV0Message();
            const vtx = new VersionedTransaction(msgV0);
            vtx.sign([feePayer]);
            txSig = await connection.sendRawTransaction(vtx.serialize(), { skipPreflight: false, maxRetries: 5 });
            await connection.confirmTransaction(txSig, "confirmed");
          }

          await dbUpdateOpened(ctx.nonce, ctx.opened);
          await dbResolve(ctx.nonce, 0, txSig, serverSeedHex);
          try {
            await DB.recordGameRound?.({
              game_key: "mines",
              player: ctx.playerPk.toBase58(),
              nonce: Number(ctx.nonce),
              stake_lamports: Number(ctx.betLamports),
              payout_lamports: 0,
              result_json: { rows: ctx.rows, cols: ctx.cols, mines: ctx.mines, opened: openedArr, boomAt: idx, bombs: bombIndices, mode: ctx.mode },
            });
          } catch (_) {}

          const payload = {
            nonce: String(ctx.nonce),
            atIndex: idx,
            atStep: ctx.opened.size,
            rows: ctx.rows, cols: ctx.cols, mines: ctx.mines,
            opened: openedArr,
            firstSafeIndex: null, // no first-click guarantee
            bombIndices,
            serverSeedHex,
            serverSeedHash: ctx.serverSeedHash || recomputedHash,
            clientSeed: ctx.clientSeed || "",
            firstHmacHex: firstHmac,
            formula: "HMAC_SHA256(serverSeed, playerPubKey + nonce + clientSeed) -> deterministic tiles (NO first-click safety).",
          };

          socket.emit("mines:boom", payload);
          io.emit("mines:resolved", { ...payload, payoutLamports: 0, tx: txSig, safeSteps: ctx.opened.size });

          rounds.delete(Number(ctx.nonce));
          try {
  pushWinEvent({
    user: ctx.playerPk.toBase58(),
    game: "mines",
    amountSol: Number(ctx.betLamports) / 1e9,
    payoutSol: 0,
    result: "loss",
  });
} catch (err) {
  console.warn("[mines] pushWinEvent (loss) failed:", err?.message || err);
}

          return;
          
        }

        // safe tile
        ctx.opened.add(idx);
        await dbUpdateOpened(ctx.nonce, ctx.opened);

        const totalTiles = ctx.rows * ctx.cols;
        const mult = multiplierFor(ctx.opened.size, totalTiles, ctx.mines, ctx.rtpBps);

        socket.emit("mines:safe", { nonce: String(nonce), index: idx, safeCount: ctx.opened.size, multiplier: mult });
      } catch (e) {
        console.error("mines:open error:", e);
        socket.emit("mines:error", { code: "OPEN_FAIL", message: e?.message || String(e) });
      }
    });

    // cashout
    socket.on("mines:cashout", async ({ nonce }) => {
      try {
        let ctx = rounds.get(Number(nonce));
        if (!ctx) return socket.emit("mines:error", { code: "NOT_FOUND", message: "no round" });
        if (ctx.over) return;
        if (ctx.opened.size < 1) {
          return socket.emit("mines:error", { code: "TOO_SOON", message: "Open at least 1 tile before cashout" });
        }

        if (!ctx.bombs) {
          if (!ctx.serverSeed && DB?.pool?.query) {
            try {
              const q = await DB.pool.query(`select server_seed from mines_rounds where nonce=$1 limit 1`, [BigInt(nonce)]);
              const w = q.rows[0] || null;
              if (w?.server_seed) ctx.serverSeed = Buffer.from(w.server_seed, "hex");
            } catch (err) { console.warn("mines:read seed warn:", err?.message || err); }
          }
          if (!ctx.serverSeed) throw new Error("serverSeed missing for round (cannot derive bombs)");

          ctx.bombs = deriveBombs({
            rows: ctx.rows, cols: ctx.cols, mines: ctx.mines,
            playerPk: ctx.playerPk, nonce: Number(nonce),
            serverSeed: ctx.serverSeed,
            clientSeed: ctx.clientSeed || "",
          });
        }

        const totalTiles = ctx.rows * ctx.cols;
        const mult = multiplierFor(ctx.opened.size, totalTiles, ctx.mines, ctx.rtpBps);
        const multBps = Math.floor(mult * 10000);
        const payoutGross = (ctx.betLamports * BigInt(multBps)) / 10000n;
        const netProfit = payoutGross - ctx.betLamports;

        ctx.over = true;

        let txSig;
        if (ctx.mode === "fake") {
          await Promo.settleBet(ctx.playerPk.toBase58(), netProfit > 0n ? netProfit.toString() : "0");
          txSig = `FAKE-RESOLVE-${ctx.nonce}-WIN`;
        } else {
          const feePayer   = await getServerKeypair();
          const playerPk   = ctx.playerPk;
          const houseVault = deriveVaultPda();
          const adminPda   = deriveAdminPda();
          const userVault  = deriveUserVaultPda(playerPk);
          const pendingPda = derivePending ? derivePending(playerPk, ctx.nonce) : null;

          const checksum = minesChecksum(ctx.nonce);
          const msg = Buffer.from(`MINES_RESOLVE_V1|${playerPk.toBase58()}|${ctx.nonce}|${checksum}|${payoutGross.toString()}`);
          const edSig = await signMessageEd25519(msg);
          const edIx  = buildEd25519VerifyIx({ message: msg, signature: edSig, publicKey: ADMIN_PK });
          const edIndex = 1;

          const ix = ixMinesResolve({
            programId: PROGRAM_ID,
            player: playerPk,
            houseVault,
            adminPda,
            userVault,
            pendingRound: pendingPda,
            checksum,
            payout: Number(payoutGross),
            edIndex,
          });

          const cu = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });
          const { blockhash } = await connection.getLatestBlockhash("confirmed");
          const msgV0 = new TransactionMessage({
            payerKey: feePayer.publicKey,
            recentBlockhash: blockhash,
            instructions: [cu, edIx, ix],
          }).compileToV0Message();

          const vtx = new VersionedTransaction(msgV0);
          const sim = await connection.simulateTransaction(vtx, { sigVerify: false }).catch(() => null);
          if (sim?.value?.err) {
            const logs = (sim.value?.logs || []).join("\n");
            throw new Error(`Mines resolve simulate failed: ${JSON.stringify(sim.value.err)}\n${logs}`);
          }
          vtx.sign([feePayer]);
          txSig = await connection.sendRawTransaction(vtx.serialize(), { skipPreflight: false, maxRetries: 5 });
          await connection.confirmTransaction(txSig, "confirmed");
        }

        const serverSeedHex = ctx.serverSeed ? ctx.serverSeed.toString("hex") : null;
        const recomputedHash = ctx.serverSeed ? sha256Hex(ctx.serverSeed) : null;
        const firstHmac = ctx.serverSeed
          ? crypto.createHmac("sha256", ctx.serverSeed)
              .update(ctx.playerPk.toBuffer())
              .update(Buffer.from(String(ctx.nonce)))
              .update(Buffer.from(String(ctx.clientSeed || "")))
              .digest("hex")
          : null;

        const bombIndices = Array.from(ctx.bombs).sort((a, b) => a - b);
        const openedArr = Array.from(ctx.opened).sort((a, b) => a - b);

        await dbUpdateOpened(ctx.nonce, ctx.opened);
        await dbResolve(ctx.nonce, payoutGross, txSig, serverSeedHex);
        try {
          await DB.recordGameRound?.({
            game_key: "mines",
            player: ctx.playerPk.toBase58(),
            nonce: Number(ctx.nonce),
            stake_lamports: Number(ctx.betLamports),
            payout_lamports: Number(payoutGross),
            result_json: { rows: ctx.rows, cols: ctx.cols, mines: ctx.mines, opened: openedArr, bombs: bombIndices, mode: ctx.mode },
          });
          await DB.recordActivity?.({ user: ctx.playerPk.toBase58(), action: "Mines cashout", amount: (Number(payoutGross)/1e9).toFixed(4) });
        } catch (_) {}

        const payload = {
          nonce: String(ctx.nonce),
          payoutLamports: Number(payoutGross),
          safeSteps: ctx.opened.size,
          tx: txSig,
          rows: ctx.rows, cols: ctx.cols, mines: ctx.mines,
          opened: openedArr,
          firstSafeIndex: null, // no first-click guarantee
          bombIndices,
          serverSeedHex,
          serverSeedHash: ctx.serverSeedHash || recomputedHash,
          clientSeed: ctx.clientSeed || "",
          firstHmacHex: firstHmac,
          formula: "HMAC_SHA256(serverSeed, playerPubKey + nonce + clientSeed) -> deterministic tiles (NO first-click safety).",
        };

        socket.emit("mines:resolved", payload);
        io.emit("mines:resolved", payload);

        rounds.delete(Number(ctx.nonce));

   try {
  pushWinEvent({
    user: ctx.playerPk.toBase58(),
    game: "mines",
    amountSol: Number(ctx.betLamports) / 1e9,
    payoutSol: Number(payoutGross) / 1e9,
    result: payoutGross > ctx.betLamports ? "win" : "loss",
  });
} catch (err) {
  console.warn("[mines] pushWinEvent (cashout) failed:", err?.message || err);
}


      } catch (e) {
        console.error("mines:cashout error:", e);
        socket.emit("mines:error", { code: "CASHOUT_FAIL", message: e?.message || String(e) });
      }
    });
  });
}

module.exports = { attachMines, attachMinesRoutes, makeMinesRouter };
