// slots_ws.js — provably-fair + promo/fake balance + FREE SPINS (no-stake) support
const crypto = require("crypto");
const {
  PublicKey,
  VersionedTransaction,
  TransactionMessage,
  ComputeBudgetProgram,
  SystemProgram, // ← added for free-mode payouts
} = require("@solana/web3.js");

const DB = global.db || require("./db");

// ---- optional bonus/wagering guard (won't crash if missing) ----
let precheckOrThrow = async () => {};
try { ({ precheckOrThrow } = require("./bonus_guard")); } catch (_) {}

// ---- promo (fake) balance helpers ----
const Promo = require("./promo_balance");
const { pushWinEvent } = require("./ws_wins");

// ---- solana helpers ----
const baseSolana = require("./solana");
const {
  connection,
  PROGRAM_ID,
  deriveVaultPda,
  deriveAdminPda,
  deriveUserVaultPda,
  derivePendingSpinPda,
  buildEd25519VerifyIx,
} = baseSolana;

const { ixSlotsLock, ixSlotsResolve } = require("./solana_anchor_ix");
const { ADMIN_PK, getServerKeypair, signMessageEd25519 } = require("./signer");

// ---------- RNG & Paytable ----------
function sha256Hex(buf) { return crypto.createHash("sha256").update(buf).digest("hex"); }

function makeRng({ serverSeed, clientSeed, nonce }) {
  let counter = 0, pool = Buffer.alloc(0);
  function refill() {
    const h = crypto
      .createHmac("sha256", serverSeed)
      .update(String(clientSeed || ""))
      .update(Buffer.from(String(nonce)))
      .update(Buffer.from([ (counter>>>0)&0xff, (counter>>>8)&0xff, (counter>>>16)&0xff, (counter>>>24)&0xff ]))
      .digest();
    counter++;
    pool = Buffer.concat([pool, h]);
  }
  function nextU32() { if (pool.length < 4) refill(); const x = pool.readUInt32BE(0); pool = pool.slice(4); return x>>>0; }
  function nextFloat() { return nextU32() / 2**32; }
  function nextInt(min, max) { return min + Math.floor(nextFloat()*(max-min+1)); }
  function pick(arr) { return arr[nextInt(0, arr.length-1)]; }
  return { nextU32, nextFloat, nextInt, pick };
}

const SLOT_SYMBOLS = ["floki","wif","brett","shiba","bonk","doge","pepe","sol","zoggy"];
const SLOTS_CELLS = 9;

// Frequencies tuned to desired RTP; "jackpot" is admin-controlled via nonce list.
const PAYTABLE = [
  { key: "near_miss",     type: "near",   payoutMul: 0.8,  freq: 0.24999992500002252 },
  { key: "triple_floki",  type: "triple", symbol: "floki", payoutMul: 1.5,  freq: 0.04999998500000451 },
  { key: "triple_wif",    type: "triple", symbol: "wif",   payoutMul: 1.5,  freq: 0.04999998500000451 },
  { key: "triple_brett",  type: "triple", symbol: "brett", payoutMul: 1.5,  freq: 0.04999998500000451 },
  { key: "triple_shiba",  type: "triple", symbol: "shiba", payoutMul: 3,    freq: 0.023609992917002123 },
  { key: "triple_bonk",   type: "triple", symbol: "bonk",  payoutMul: 6,    freq: 0.011804996458501062 },
  { key: "triple_doge",   type: "triple", symbol: "doge",  payoutMul: 10,   freq: 0.007082997875100638 },
  { key: "triple_pepe",   type: "triple", symbol: "pepe",  payoutMul: 20,   freq: 0.003541998937400319 },
  { key: "triple_sol",    type: "triple", symbol: "sol",   payoutMul: 50,   freq: 0.001416999574900128 },
  { key: "triple_zoggy",  type: "triple", symbol: "zoggy", payoutMul: 100,  freq: 0.000708299787510064 },
  { key: "jackpot",       type: "triple", symbol: "zoggy", payoutMul: 1000, freq: 0 },
  { key: "loss",          type: "loss",   payoutMul: 0,    freq: 0.5518348344495496 },
];

const CDF = (() => {
  const rows = PAYTABLE.filter((p) => p.key !== "jackpot");
  let acc = 0;
  return rows.map((r) => ({ ...r, cum: (acc += r.freq) }));
})();

const JACKPOT_NONCES = new Set(
  String(process.env.SLOTS_JACKPOT_NONCES || "")
    .split(",").map((s) => s.trim()).filter(Boolean)
);

function getFeePctFromConfig(cfg) {
  const bps = Number(cfg?.fee_bps ?? 500); // 5% default
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
  const pickNot = (exclude) => { let s; do s = rng.pick(SLOT_SYMBOLS); while (s === exclude); return s; };

  if (outcome.type === "triple") {
    const s = outcome.symbol; mid[0] = s; mid[1] = s; mid[2] = s;
  } else if (outcome.type === "near") {
    const s = rng.pick(SLOT_SYMBOLS);
    const odd = rng.nextInt(0,2);
    const t = pickNot(s);
    for (let i = 0; i < 3; i++) mid[i] = (i === odd ? t : s);
  } else {
    mid[0] = rng.pick(SLOT_SYMBOLS);
    do { mid[1] = rng.pick(SLOT_SYMBOLS); } while (mid[1] === mid[0]);
    do { mid[2] = rng.pick(SLOT_SYMBOLS); } while (mid[2] === mid[0] || mid[2] === mid[1]);
  }
  for (let i = 0; i < 3; i++) grid[midStart + i] = mid[i];
  return grid;
}

function computePayoutLamports(betLamports, payoutMul, feePct) {
  // net payout (stake is locked separately in paid mode); fee is applied to stake for house rake
  const SCALE = 1_000_000n;
  const mul = BigInt(Math.round(payoutMul * 1_000_000));
  const fee = BigInt(Math.round(feePct * 1_000_000));
  const bet = BigInt(betLamports);
  const gross = (bet * mul) / SCALE;      // bet * multiplier
  const feeAmt = (bet * fee) / SCALE;     // house rake
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

const slotsChecksum = (nonce) => Number((BigInt(nonce) % 251n) + 1n) & 0xff;

// ---------- in-memory pending spins ----------
/**
 * Map<nonce, {
 *   player: string,
 *   betLamports: bigint,
 *   clientSeed: string,
 *   serverSeed: Buffer,
 *   serverSeedHash: string,
 *   feePct: number,
 *   mode: "real" | "fake" | "free"
 * }>
 */
const slotsPending = new Map();

// ---------- (optional) helpers ----------
async function getPromoBalance(player) {
  try {
    if (typeof Promo.getPromoBalanceLamports === "function") {
      return await Promo.getPromoBalanceLamports(player);
    }
  } catch (_) {}
  return null;
}

// ---------- FREE SPINS (Welcome Bonus) helpers ----------
async function getActiveWelcomeState(wallet) {
  try {
    const r = await DB.pool.query(
      `select status, fs_count, fs_value_usd, fs_max_win_usd
         from welcome_bonus_states
        where user_wallet=$1 and status='active'
        order by created_at desc limit 1`,
      [String(wallet)]
    );
    return r.rows[0] || null;
  } catch { return null; }
}
async function consumeOneFreeSpin(wallet) {
  try {
    const r = await DB.pool.query(
      `update welcome_bonus_states
          set fs_count = GREATEST(0, fs_count - 1), updated_at = now()
        where user_wallet=$1 and status='active' and fs_count > 0
        returning fs_count`,
      [String(wallet)]
    );
    return Number(r.rows?.[0]?.fs_count ?? 0);
  } catch { return 0; }
}
async function refundFreeSpin(wallet) {
  try {
    await DB.pool.query(
      `update welcome_bonus_states
          set fs_count = fs_count + 1, updated_at = now()
        where user_wallet=$1 and status='active'`,
      [String(wallet)]
    );
  } catch {}
}
function usdToLamports(usd, usdPerSol = Number(process.env.USD_PER_SOL || 200)) {
  const lamports = Math.round((Number(usd || 0) / Number(usdPerSol || 1)) * 1e9);
  return Math.max(1, lamports);
}

// ---------- schema detection (for legacy/new DBs) ----------
const COLS = { set: null };
async function ensureCols() {
  if (COLS.set) return COLS.set;
  try {
    if (!DB?.pool?.query) { COLS.set = new Set(); return COLS.set; }
    const r = await DB.pool.query(
      `select column_name from information_schema.columns
       where table_schema='public' and table_name='slots_spins'`
    );
    COLS.set = new Set(r.rows.map((x) => x.column_name));
    console.log("[slots] detected columns:", [...COLS.set].join(", "));
  } catch (e) {
    console.warn("[slots] schema detection failed:", e?.message || e);
    COLS.set = new Set();
  }
  return COLS.set;
}
function hasCol(n) { return COLS.set && COLS.set.has(n); }
function pickFirst(...names) { for (const n of names) if (hasCol(n)) return n; return null; }

// ---------- DB helpers (best effort) ----------
async function dbInsertLockedRow({ player, betLamports, clientSeed, serverSeedHash, serverSeed, nonce, feePct, txSig }) {
  try {
    if (!DB?.pool?.query) return;
    await ensureCols();

    const cols = [];
    const vals = [];
    const params = [];
    let i = 1;
    const push = (name, value) => { cols.push(name); params.push(value); vals.push(`$${i++}`); };

    push("player", player);
    const betCol = pickFirst("bet_amount", "bet_lamports") || "bet_amount";

// ⚙️ If we're writing into "bet_amount", store in SOL instead of lamports
if (betCol === "bet_amount") {
  push(betCol, Number(betLamports) / 1e9);
} else {
  push(betCol, String(betLamports));
}

    if (hasCol("client_seed")) push("client_seed", String(clientSeed || ""));
    if (hasCol("server_seed_hash")) push("server_seed_hash", serverSeedHash);
    if (hasCol("server_seed")) push("server_seed", serverSeed.toString("hex"));
    push("nonce", BigInt(nonce));
    if (hasCol("status")) push("status", "locked");
    if (hasCol("fee_pct")) push("fee_pct", feePct);
    const lockCol = pickFirst("lock_sig", "lock_tx_sig");
    if (lockCol) push(lockCol, txSig || null);

    const sql =
      `insert into slots_spins(${cols.join(",")}) values (${vals.join(",")})
       on conflict (nonce) do nothing`;
    await DB.pool.query(sql, params);
  } catch (e) {
    console.warn("[slots] insert locked warn:", e?.message || e);
  }
}

async function dbResolveUpdate({ player, nonce, grid, payoutLamports, resolveSig }) {
  try {
    if (!DB?.pool?.query) return;
    await ensureCols();

    const sets = [];
    const params = [];
    let i = 1;

    if (hasCol("grid_json")) { sets.push(`grid_json=$${i}`); params.push(JSON.stringify(grid)); i++; }
    const payCol = pickFirst("payout", "payout_lamports");
if (payCol === "payout") {
  // Store in SOL
  sets.push(`${payCol}=$${i}`);
  params.push(Number(payoutLamports) / 1e9);
  i++;
} else if (payCol) {
  sets.push(`${payCol}=$${i}`);
  params.push(Number(payoutLamports));
  i++;
}

    if (hasCol("status")) { sets.push(`status='resolved'`); }
    const resCol = pickFirst("resolve_sig", "resolved_tx_sig", "resolved_sig");
    if (resCol) { sets.push(`${resCol}=$${i}`); params.push(resolveSig || null); i++; }
    if (hasCol("resolved_at")) { sets.push(`resolved_at=now()`); }

    if (!sets.length) return;

    const sql = `update slots_spins set ${sets.join(", ")} where nonce=$${i} and player=$${i+1}`;
    params.push(BigInt(nonce), player);
    await DB.pool.query(sql, params);
  } catch (e) {
    console.warn("[slots] resolve update warn:", e?.message || e);
  }
}

// ---------- HTTP routes (history listing, avoids 404) ----------
function makeSlotsRouter() {
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
      if (Number.isFinite(cursor) && cursor) { params.push(cursor); whereParts.push(`id < $2`); }
      const where = whereParts.join(" AND ");

      // Build SELECT list based on available columns
      const sel = [
        "id",
        "player",
        (pickFirst("bet_amount","bet_lamports") || "NULL::bigint") + " as bet_lamports",
        "nonce",
        hasCol("fee_pct") ? "fee_pct" : "NULL::numeric as fee_pct",
        (pickFirst("payout","payout_lamports") || "NULL::bigint") + " as payout_lamports",
        hasCol("server_seed_hash") ? "server_seed_hash" : "NULL::text as server_seed_hash",
        hasCol("server_seed") ? "server_seed as server_seed_hex" : "NULL::text as server_seed_hex",
        hasCol("client_seed") ? "client_seed" : "''::text as client_seed",
        hasCol("grid_json") ? "grid_json" : "NULL::jsonb as grid_json",
        (pickFirst("lock_sig","lock_tx_sig") || "NULL::text") + " as lock_tx_sig",
        (pickFirst("resolve_sig","resolved_tx_sig","resolved_sig") || "NULL::text") + " as resolved_tx_sig",
        hasCol("status") ? "status" : "'resolved'::text as status",
        hasCol("created_at") ? "created_at" : "NULL::timestamp as created_at",
        hasCol("resolved_at") ? "resolved_at" : "NULL::timestamp as resolved_at",
      ];

      const sql =
        `select ${sel.join(", ")}
           from slots_spins
          where ${where}
          order by id desc
          limit ${limit};`;

      const q = await DB.pool.query(sql, params);
      const items = q.rows || [];
      const nextCursor = items.length === limit ? Number(items[items.length - 1].id) : null;
      res.json({ items, nextCursor });
    } catch (e) {
      console.error("[GET /slots/resolved] error:", e);
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  return router;
}

function attachSlotsRoutes(app) {
  if (!app) return;
  const router = makeSlotsRouter();
  app.use("/slots", router);
  app.use("/api/slots", router);
  console.log("[slots] HTTP routes mounted at /slots and /api/slots");
}

// ---------- WebSocket ----------
function attachSlots(io) {
  io.on("connection", (socket) => {
    socket.on("register", ({ player }) => { socket.data.player = String(player || "guest"); });

    /**
     * SLOTS PLACE
     * in:  { player, betAmountLamports, clientSeed?, welcomeFreeSpin? }
     * out: "slots:locked" { nonce, txSig, serverSeedHash, promoBalanceLamports? }
     */
    socket.on("slots:place", async ({ player, betAmountLamports, clientSeed, welcomeFreeSpin }) => {
      try {
        if (!player) return socket.emit("slots:error", { code: "NO_PLAYER", message: "player required" });

        const cfg = await DB.getGameConfig?.("slots").catch(()=>null);
        if (cfg && (!cfg.enabled || !cfg.running)) {
          return socket.emit("slots:error", { code: "DISABLED", message: "Slots disabled by admin" });
        }

        const min = BigInt(cfg?.min_bet_lamports ?? 50_000n);
        const max = BigInt(cfg?.max_bet_lamports ?? 5_000_000_000n);

        let betLamports = BigInt(betAmountLamports || 0);
        const isFree = Boolean(welcomeFreeSpin);

        if (!isFree) {
          if (betLamports <= 0n) {
            return socket.emit("slots:error", { code: "BAD_BET", message: "betAmountLamports invalid" });
          }
          if (betLamports < min || betLamports > max) {
            return socket.emit("slots:error", { code: "BET_RANGE", message: "Bet outside allowed range" });
          }

          // bonus/wager guard (no-op if missing)
          await precheckOrThrow({
            userWallet: player,
            stakeLamports: betLamports.toString(),
            gameKey: "slots",
          }).catch(()=>{});
        } else {
          // FREE MODE: ignore min/max & bonus guards; server controls stake size
          const st = await getActiveWelcomeState(player);
          if (!st || Number(st.fs_count || 0) <= 0) {
            return socket.emit("slots:error", { code: "NO_FREE_SPINS", message: "No free spins available" });
          }
          // if client sent 0, derive stake from configured free spin value
          if (betLamports <= 0n) {
            betLamports = BigInt(usdToLamports(Number(st.fs_value_usd || 0)));
          }
          // consume one free spin now (refund if later stage fails)
          await consumeOneFreeSpin(player).catch(()=>{});
        }

        const useFake   = isFree ? false : await Promo.isFakeMode(player).catch(()=>false);
        const playerPk  = new PublicKey(player);
        const nonce     = Date.now();
        const expiryUnix= Math.floor(Date.now()/1000) + Number(process.env.NONCE_TTL_SECONDS || 300);

        // provably-fair commitment
        const serverSeed = crypto.randomBytes(32);
        const serverSeedHash = sha256Hex(serverSeed);

        const feePct = getFeePctFromConfig(cfg);
        let txSig = null;

        if (isFree) {
          // ✅ FREE: no PDA lock, no promo freeze; just mark pending
          txSig = `FREE-LOCK-${nonce}`;

          slotsPending.set(nonce, {
            player,
            betLamports,
            clientSeed: String(clientSeed || ""),
            serverSeed,
            serverSeedHash,
            feePct,
            mode: "free",
          });

          // persist (best-effort)
          await dbInsertLockedRow({
            player, betLamports, clientSeed, serverSeedHash, serverSeed, nonce, feePct, txSig
          });

          socket.emit("slots:locked", { nonce: String(nonce), txSig, serverSeedHash });
          return;
        }

        if (useFake) {
          // FAKE: freeze promo balance, no chain tx
          await Promo.freezeForBet(player, betLamports.toString());
          txSig = `FAKE-LOCK-${nonce}`;

          slotsPending.set(nonce, {
            player,
            betLamports,
            clientSeed: String(clientSeed || ""),
            serverSeed,
            serverSeedHash,
            feePct,
            mode: "fake",
          });

          // persist (best-effort)
          await dbInsertLockedRow({
            player, betLamports, clientSeed, serverSeedHash, serverSeed, nonce, feePct, txSig
          });

          const promoBal = await getPromoBalance(player);
          socket.emit("slots:locked", {
            nonce: String(nonce),
            txSig,
            serverSeedHash,
            promoBalanceLamports: promoBal != null ? Number(promoBal) : undefined,
          });
        } else {
          // REAL: on-chain lock
          const userVault  = deriveUserVaultPda(playerPk);
          const houseVault = deriveVaultPda();
          const pending    = derivePendingSpinPda(playerPk, nonce);

          const msg  = Buffer.from(`SLOTS|${player}|${betLamports.toString()}|${nonce}|${expiryUnix}`);
          const edSig = await signMessageEd25519(msg);
          const edIx  = buildEd25519VerifyIx({ message: msg, signature: edSig, publicKey: ADMIN_PK });
          const edIndex = 2;

          const feePayer = await getServerKeypair();
          const cuPrice  = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 });
          const cuLimit  = ComputeBudgetProgram.setComputeUnitLimit({ units: 350_000 });

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
          txSig = await connection.sendRawTransaction(vtx.serialize(), { skipPreflight: false, maxRetries: 5 });
          await connection.confirmTransaction(txSig, "confirmed");

          slotsPending.set(nonce, {
            player,
            betLamports,
            clientSeed: String(clientSeed || ""),
            serverSeed,
            serverSeedHash,
            feePct,
            mode: "real",
          });

          await dbInsertLockedRow({
            player, betLamports, clientSeed, serverSeedHash, serverSeed, nonce, feePct, txSig
          });

          socket.emit("slots:locked", { nonce: String(nonce), txSig, serverSeedHash });
        }
      } catch (e) {
        // If a free spin failed at place-time, refund it
        try {
          if (welcomeFreeSpin) await refundFreeSpin(player);
        } catch {}
        console.error("slots:place error:", e);
        socket.emit("slots:error", { code: "PLACE_FAIL", message: String(e?.message || e) });
      }
    });

    /**
     * SLOTS RESOLVE
     * in:  { player, nonce }
     * out: "slots:resolved" { nonce, outcome, grid, payoutLamports, feePct, txSig, promoBalanceLamports? }
     * then "slots:reveal_seed" { serverSeedHex, serverSeedHash, clientSeed, firstHmacHex, formula }
     */
    socket.on("slots:resolve", async ({ player, nonce }) => {
      try {
        if (!player) return socket.emit("slots:error", { code: "NO_PLAYER", message: "player required" });
        if (!nonce)  return socket.emit("slots:error", { code: "NO_NONCE",  message: "nonce required"  });

        const playerPk = new PublicKey(player);
        let ctx = slotsPending.get(Number(nonce));

        // restore from DB if needed (server restart)
        if (!ctx && DB?.pool?.query) {
          try {
            await ensureCols();
            const r = await DB.pool.query(
              `select * from slots_spins where nonce=$1 and player=$2 limit 1`,
              [BigInt(nonce), player]
            );
            const row = r.rows[0] || null;
            if (row) {
              const useFake = await Promo.isFakeMode(player).catch(()=>false);
              ctx = {
                player,
                betLamports: BigInt(row.bet_amount || row.bet_lamports || 0),
                clientSeed: row.client_seed || "",
                serverSeed: row.server_seed ? Buffer.from(row.server_seed, "hex") : null,
                serverSeedHash: row.server_seed_hash || null,
                feePct: Number(row.fee_pct ?? 0.05),
                mode: useFake ? "fake" : "real",
              };
            }
          } catch (e) {
            console.warn("[slots] DB restore warn:", e?.message || e);
          }
        }

        if (!ctx) return socket.emit("slots:error", { code: "NOT_FOUND", message: "no prepared spin for nonce" });

        // compute outcome
        const { outcome, grid, payoutLamports: rawPayout } = computeSpin({
          serverSeed: ctx.serverSeed,
          clientSeed: ctx.clientSeed,
          nonce: Number(nonce),
          betLamports: ctx.betLamports,
          feePct: ctx.feePct ?? 0.05,
        });

        let payoutLamports = rawPayout;
        const checksum = slotsChecksum(nonce);
        let txSig = null;
        let promoBalance = null;

        if (ctx.mode === "free") {
          // Optional: cap free-spin win if you want to enforce a max; uncomment if desired:
          // const st = await getActiveWelcomeState(ctx.player).catch(()=>null);
          // if (st?.fs_max_win_usd) {
          //   const cap = BigInt(usdToLamports(Number(st.fs_max_win_usd)));
          //   if (payoutLamports > cap) payoutLamports = cap;
          // }

          try {
            if (payoutLamports > 0n) {
              // ✅ Transfer real SOL (no prior lock) to user vault PDA
              const userVault = deriveUserVaultPda(playerPk);
              const feePayer = await getServerKeypair();
              const { blockhash } = await connection.getLatestBlockhash("confirmed");

              const ix = SystemProgram.transfer({
                fromPubkey: feePayer.publicKey,
                toPubkey: userVault,
                lamports: Number(payoutLamports),
              });

              const msgV0 = new TransactionMessage({
                payerKey: feePayer.publicKey,
                recentBlockhash: blockhash,
                instructions: [ix],
              }).compileToV0Message();

              const vtx = new VersionedTransaction(msgV0);
              vtx.sign([feePayer]);

              const sig = await connection.sendRawTransaction(vtx.serialize(), {
                skipPreflight: false,
                maxRetries: 5,
              });
              await connection.confirmTransaction(sig, "confirmed");
              txSig = sig;
            } else {
              txSig = `FREE-LOSE-${nonce}`;
            }

            // bookkeeping (best-effort)
            try {
              await DB.recordGameRound?.({
                game_key: "slots",
                player,
                nonce: Number(nonce),
                stake_lamports: Number(ctx.betLamports),
                payout_lamports: Number(payoutLamports),
                result_json: { outcome: outcome.key, grid, mode: "free" },
              });
              if (payoutLamports > 0n) {
                await DB.recordActivity?.({
                  user: player,
                  action: "Slots win (free)",
                  amount: (Number(payoutLamports) / 1e9).toFixed(4),
                });
              }
              await dbResolveUpdate({ player, nonce, grid, payoutLamports, resolveSig: txSig });
            } catch (e) {
              console.warn("[slots] free resolve DB warn:", e?.message || e);
            }
          } catch (e) {
            console.error("FREE payout failed:", e?.message || e);
            // If you want to refund consumed FS on payout failure, uncomment:
            // await refundFreeSpin(player).catch(()=>{});
            return socket.emit("slots:error", { code: "FREE_PAYOUT_FAILED", message: String(e?.message || e) });
          }

        } else if (ctx.mode === "fake") {
          // settle promo net payout
          await Promo.settleBet(player, payoutLamports.toString());
          txSig = `FAKE-RESOLVE-${nonce}`;
          promoBalance = await getPromoBalance(player);

          // bookkeeping (best-effort)
          try {
            await DB.recordGameRound?.({
              game_key: "slots",
              player,
              nonce: Number(nonce),
              stake_lamports: Number(ctx.betLamports),
              payout_lamports: Number(payoutLamports),
              result_json: { outcome: outcome.key, grid, mode: "fake" },
            });
            if (payoutLamports > 0n) {
              await DB.recordActivity?.({
                user: player,
                action: "Slots win (promo)",
                amount: (Number(payoutLamports) / 1e9).toFixed(4),
              });
            }
            await dbResolveUpdate({ player, nonce, grid, payoutLamports, resolveSig: txSig });
          } catch (e) {
            console.warn("[slots] fake resolve DB warn:", e?.message || e);
          }
        } else {
          // on-chain resolve (paid)
          const userVault  = deriveUserVaultPda(playerPk);
          const houseVault = deriveVaultPda();
          const adminPda   = deriveAdminPda();
          const pending    = derivePendingSpinPda(playerPk, nonce);

          const resolveMsg = Buffer.from(`SLOTS_RESOLVE|${player}|${nonce}|${checksum}|${Number(payoutLamports)}`);
          const edSig = await signMessageEd25519(resolveMsg);
          const edIx  = buildEd25519VerifyIx({ message: resolveMsg, signature: edSig, publicKey: ADMIN_PK });
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
          const cuLimit  = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });

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
            throw new Error(`Slots resolve simulate failed: ${JSON.stringify(sim.value.err)}\n${logs}`);
          }

          vtx.sign([feePayer]);
          txSig = await connection.sendRawTransaction(vtx.serialize(), { skipPreflight: false, maxRetries: 5 });
          await connection.confirmTransaction(txSig, "confirmed");

          // bookkeeping (best-effort)
          try {
            await DB.recordGameRound?.({
              game_key: "slots",
              player,
              nonce: Number(nonce),
              stake_lamports: Number(ctx.betLamports),
              payout_lamports: Number(payoutLamports),
              result_json: { outcome: outcome.key, grid, mode: "real" },
            });
            if (payoutLamports > 0n) {
              await DB.recordActivity?.({
                user: player,
                action: "Slots win",
                amount: (Number(payoutLamports)/1e9).toFixed(4),
              });
            }
            await dbResolveUpdate({ player, nonce, grid, payoutLamports, resolveSig: txSig });
          } catch (e) {
            console.warn("[slots] real resolve DB warn:", e?.message || e);
          }
        }

        // emit resolved
        socket.emit("slots:resolved", {
          nonce: String(nonce),
          outcome: outcome.key,
          grid,
          payoutLamports: Number(payoutLamports),
          feePct: ctx.feePct ?? 0.05,
          txSig,
          promoBalanceLamports: promoBalance != null ? Number(promoBalance) : undefined,
        });
        // ---- push live win event ----
try {
  pushWinEvent({
    user: player,
    game: "slots",
    amountSol: Number(ctx.betLamports) / 1e9,
    payoutSol: Number(payoutLamports) / 1e9,
    result: payoutLamports > ctx.betLamports ? "win" : "loss",
  });
} catch (err) {
  console.warn("[slots] pushWinEvent failed:", err?.message || err);
}

        // provably-fair reveal
        try {
          const serverSeedHex = ctx.serverSeed ? ctx.serverSeed.toString("hex") : null;
          const recomputedHash = ctx.serverSeed ? sha256Hex(ctx.serverSeed) : null;
          // expose the first RNG HMAC chunk preview (counter=0)
          const firstHmacHex = ctx.serverSeed
            ? crypto.createHmac("sha256", ctx.serverSeed)
                .update(String(ctx.clientSeed || ""))
                .update(Buffer.from(String(nonce)))
                .update(Buffer.from([0,0,0,0])) // counter bytes
                .digest("hex")
            : null;

          socket.emit("slots:reveal_seed", {
            nonce: String(nonce),
            serverSeedHex,
            serverSeedHash: ctx.serverSeedHash || recomputedHash,
            clientSeed: ctx.clientSeed || "",
            firstHmacHex,
            formula: "HMAC_SHA256(serverSeed, clientSeed + nonce + counter) → RNG stream (makeRng) used to produce reels",
          });
        } catch (err) {
          console.warn("slots: reveal_seed emit failed:", err?.message || err);
        }

        slotsPending.delete(Number(nonce));
      } catch (e) {
        console.error("slots:resolve error:", e);
        socket.emit("slots:error", { code: "RESOLVE_FAIL", message: String(e?.message || e) });
      }
    });

    // ---- optional legacy shims ----
    socket.on("slots:prepare_lock", async (payload) => {
      const originalEmit = socket.emit.bind(socket);
      socket.emit = (ev, data) => {
        if (ev === "slots:locked") {
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
      await new Promise((res) => {
        const done = () => res();
        socket.once("slots:resolved", done);
        socket.emit("slots:resolve", payload);
      });
    });
  });
}

module.exports = { attachSlots, attachSlotsRoutes, makeSlotsRouter };
