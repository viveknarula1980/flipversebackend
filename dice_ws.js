// dice_ws.js — Provably-Fair Dice (WS + REST) with **fake/promo balance** toggle per user
//
// Behavior:
// - If user is in fake mode (use_fake=TRUE or promo_balance_lamports>0), the server runs dice **off-chain**,
//   freezing the promo balance on "place" and crediting payout on "resolve". Events & REST stay identical.
// - If not fake, it uses your on-chain flow exactly as before.
//
// REST:
//   GET /dice/resolved?wallet=...&limit=...&cursor=...
//
// Socket.IO events:
//   dice:place   -> emits dice:locked {nonce, txSig, serverSeedHash}          (txSig="FAKE-LOCK-<nonce>" in fake mode)
//   dice:resolve -> emits dice:resolved {...} then dice:reveal_seed {...}     (txSig="FAKE-RESOLVE-<nonce>" in fake mode)

const crypto = require("crypto");
const express = require("express");
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
  deriveUserVaultPda,
  deriveAdminPda,
  derivePendingBetPda,
  buildEd25519VerifyIx,
} = require("./solana");

const {
  ixActivateUserVault,
  ixDeposit,
  ixWithdraw,
  ixPlaceBetFromVault,
  ixResolve,
} = require("./solana_anchor_ix");

const {
  ADMIN_PK,
  buildMessageBytes,
  signMessageEd25519,
  getServerKeypair,
} = require("./signer");

const DB = global.db || require("./db");
const Promo = require("./promo_balance");

// bonus checks optional
let precheckOrThrow = async () => {};
try { ({ precheckOrThrow } = require("./bonus_guard")); } catch (_) {}

function isMaybeBase58(s) {
  return typeof s === "string" && s.length >= 32 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(s);
}
function toBetTypeNum(x) {
  if (typeof x === "string") return x.toLowerCase() === "over" ? 1 : 0;
  return Number(x) ? 1 : 0;
}
function computePayoutLamports({ betLamports, rtp_bps, win_odds }) {
  if (win_odds < 1 || win_odds > 99) return 0n;
  const bet = BigInt(betLamports);
  const rtp = BigInt(rtp_bps);
  const denom = 100n * BigInt(win_odds);
  return (bet * rtp) / denom;
}
function hmacSha256Buf(serverSeedHex, messageStr) {
  return crypto
    .createHmac("sha256", Buffer.from(serverSeedHex, "hex"))
    .update(String(messageStr))
    .digest();
}
function deriveDiceRoll({ serverSeedHex, clientSeed, nonce }) {
  const buf = hmacSha256Buf(serverSeedHex, String(clientSeed || "") + String(nonce));
  const v = buf.readUInt32BE(0) >>> 0;
  const roll = (v % 100) + 1; // 1..100
  return { roll, hmacHex: buf.toString("hex") };
}

// ---------------- schema helpers ----------------
async function ensureDiceSchema() {
  if (!DB?.pool) return;
  await DB.pool.query(`
    ALTER TABLE IF EXISTS bets
      ADD COLUMN IF NOT EXISTS client_seed        text not null default '',
      ADD COLUMN IF NOT EXISTS server_seed_hash   text,
      ADD COLUMN IF NOT EXISTS server_seed_hex    text,
      ADD COLUMN IF NOT EXISTS first_hmac_hex     text,
      ADD COLUMN IF NOT EXISTS resolved_tx_sig    text,
      ADD COLUMN IF NOT EXISTS resolved_at        timestamptz,
      ADD COLUMN IF NOT EXISTS win                boolean,
      ADD COLUMN IF NOT EXISTS rtp_bps            int,
      ADD COLUMN IF NOT EXISTS fee_bps            int;

    CREATE INDEX IF NOT EXISTS idx_bets_player_status_created
      ON bets (player, status, created_at desc);
  `);
}
const _colHas = new Map();
async function colExists(table, column) {
  const key = `${table}.${column}`;
  if (_colHas.has(key)) return _colHas.get(key);
  if (!DB?.pool) return false;
  const { rows } = await DB.pool.query(
    `select 1 from information_schema.columns where table_name=$1 and column_name=$2 limit 1`,
    [table, column]
  );
  const ok = rows.length > 0;
  _colHas.set(key, ok);
  return ok;
}
async function selectProjectionBets() {
  const want = [
    "id",
    "player",
    "bet_amount_lamports",
    "bet_type",
    "target",
    "roll",
    "payout_lamports",
    "nonce",
    "status",
    "signature_base58 as lock_tx_sig",
    (await colExists("bets", "resolved_tx_sig")) ? "resolved_tx_sig" : "NULL::text as resolved_tx_sig",
    (await colExists("bets", "client_seed")) ? "client_seed" : "''::text as client_seed",
    (await colExists("bets", "server_seed_hash")) ? "server_seed_hash" : "NULL::text as server_seed_hash",
    (await colExists("bets", "server_seed_hex")) ? "server_seed_hex" : "NULL::text as server_seed_hex",
    (await colExists("bets", "first_hmac_hex")) ? "first_hmac_hex" : "NULL::text as first_hmac_hex",
    (await colExists("bets", "win")) ? "win" : "NULL::boolean as win",
    (await colExists("bets", "rtp_bps")) ? "rtp_bps" : "NULL::int as rtp_bps",
    (await colExists("bets", "fee_bps")) ? "fee_bps" : "NULL::int as fee_bps",
    "created_at",
    (await colExists("bets", "resolved_at")) ? "resolved_at" : "NULL::timestamptz as resolved_at",
  ];
  return want.join(", ");
}

// ---------------- DB ops (commitment / reveal) ----------------
async function dbRecordDiceLock({
  player,
  amountLamports,
  betType,
  target,
  nonce,
  expiry,
  signature_base58,
  serverSeedHash,
  clientSeed,
}) {
  if (!DB?.pool) return null;
  await ensureDiceSchema().catch(() => {});
  const hasClient = await colExists("bets", "client_seed");
  const hasHash   = await colExists("bets", "server_seed_hash");

  const cols = [
    "player", "bet_amount_lamports", "bet_type", "target",
    "roll", "payout_lamports",
    "nonce", "expiry_unix", "signature_base58", "status",
    ...(hasClient ? ["client_seed"] : []),
    ...(hasHash ? ["server_seed_hash"] : []),
    "created_at"
  ];
  const placeholders = cols.map((_, i) => `$${i+1}`);
  const vals = [
    String(player),
    Math.round(Number(amountLamports) || 0),
    Number(betType),
    Number(target),
    0, 0,
    Number(nonce),
    Number(expiry),
    String(signature_base58 || ""),
    "prepared_lock",
    ...(hasClient ? [String(clientSeed || "")] : []),
    ...(hasHash ? [String(serverSeedHash || "")] : []),
    new Date()
  ];
  const updates = [
    "player = excluded.player",
    "bet_amount_lamports = excluded.bet_amount_lamports",
    "bet_type = excluded.bet_type",
    "target = excluded.target",
    "expiry_unix = excluded.expiry_unix",
    "signature_base58 = excluded.signature_base58",
    "status = 'prepared_lock'",
    ...(hasClient ? ["client_seed = excluded.client_seed"] : []),
    ...(hasHash ? ["server_seed_hash = excluded.server_seed_hash"] : []),
  ];

  const q = `
    INSERT INTO bets(${cols.join(",")})
    VALUES (${placeholders.join(",")})
    ON CONFLICT (nonce) DO UPDATE SET
      ${updates.join(", ")}
    RETURNING *;
  `;
  const { rows } = await DB.pool.query(q, vals);
  return rows[0];
}

async function dbUpsertDiceResolve({
  player,
  betLamports,
  betTypeNum,
  target,
  nonce,
  roll,
  payoutLamports,
  resolvedSig,
  serverSeedHex,
  hmacHex,
  clientSeed,
  win,
  rtp_bps,
  fee_bps,
}) {
  if (!DB?.pool) return null;
  await ensureDiceSchema().catch(() => {});

  const hasClient   = await colExists("bets", "client_seed");
  const hasSrvHex   = await colExists("bets", "server_seed_hex");
  const hasFirstH   = await colExists("bets", "first_hmac_hex");
  const hasResolved = await colExists("bets", "resolved_tx_sig");
  const hasWin      = await colExists("bets", "win");
  const hasRtp      = await colExists("bets", "rtp_bps");
  const hasFee      = await colExists("bets", "fee_bps");

  // Try UPDATE first
  const setParts = [
    "roll = $2",
    "payout_lamports = $3",
    "status = 'resolved'",
    "resolved_at = now()",
  ];
  const updVals = [ Number(nonce), Number(roll), Math.round(Number(payoutLamports) || 0) ];
  let p = 4;
  if (hasResolved) { setParts.push(`resolved_tx_sig = $${p++}`); updVals.push(String(resolvedSig || "")); }
  if (hasSrvHex)   { setParts.push(`server_seed_hex = $${p++}`);  updVals.push(serverSeedHex ? String(serverSeedHex) : null); }
  if (hasFirstH)   { setParts.push(`first_hmac_hex = $${p++}`);   updVals.push(hmacHex ? String(hmacHex) : null); }
  if (hasClient)   { setParts.push(`client_seed = CASE WHEN $${p} <> '' THEN $${p} ELSE client_seed END`); updVals.push(String(clientSeed || "")); p++; }
  if (hasWin)      { setParts.push(`win = $${p++}`);              updVals.push(!!win); }
  if (hasRtp)      { setParts.push(`rtp_bps = coalesce($${p++}, rtp_bps)`); updVals.push(rtp_bps == null ? null : Number(rtp_bps)); }
  if (hasFee)      { setParts.push(`fee_bps = coalesce($${p++}, fee_bps)`); updVals.push(fee_bps == null ? null : Number(fee_bps)); }

  const updQ = `
    UPDATE bets
       SET ${setParts.join(", ")}
     WHERE nonce = $1
     RETURNING *;
  `;
  const upd = await DB.pool.query(updQ, updVals);
  if (upd.rows.length) return upd.rows[0];

  // Else insert (UPSERT)
  const cols = ["player","bet_amount_lamports","bet_type","target","roll","payout_lamports","nonce","status","created_at"];
  const insVals = [
    String(player),
    Math.round(Number(betLamports) || 0),
    Number(betTypeNum),
    Number(target),
    Number(roll),
    Math.round(Number(payoutLamports) || 0),
    Number(nonce),
    "resolved",
    new Date(),
  ];
  if (hasResolved) { cols.push("resolved_tx_sig"); insVals.push(String(resolvedSig || "")); }
  if (hasClient)   { cols.push("client_seed");     insVals.push(String(clientSeed || "")); }
  if (hasSrvHex)   { cols.push("server_seed_hex"); insVals.push(serverSeedHex ? String(serverSeedHex) : null); }
  if (hasFirstH)   { cols.push("first_hmac_hex");  insVals.push(hmacHex ? String(hmacHex) : null); }
  if (hasWin)      { cols.push("win");             insVals.push(!!win); }
  if (hasRtp)      { cols.push("rtp_bps");         insVals.push(rtp_bps == null ? null : Number(rtp_bps)); }
  if (hasFee)      { cols.push("fee_bps");         insVals.push(fee_bps == null ? null : Number(fee_bps)); }

  const placeholders = insVals.map((_, i) => `$${i+1}`);
  const insQ = `
    INSERT INTO bets(${cols.join(",")})
    VALUES (${placeholders.join(",")})
    ON CONFLICT (nonce) DO UPDATE SET
      roll = excluded.roll,
      payout_lamports = excluded.payout_lamports,
      status = 'resolved',
      ${hasResolved ? "resolved_tx_sig = excluded.resolved_tx_sig," : ""}
      ${hasClient   ? "client_seed = CASE WHEN excluded.client_seed <> '' THEN excluded.client_seed ELSE bets.client_seed END," : ""}
      ${hasSrvHex   ? "server_seed_hex = excluded.server_seed_hex," : ""}
      ${hasFirstH   ? "first_hmac_hex = excluded.first_hmac_hex," : ""}
      ${hasWin      ? "win = excluded.win," : ""}
      ${hasRtp      ? "rtp_bps = coalesce(excluded.rtp_bps, bets.rtp_bps)," : ""}
      ${hasFee      ? "fee_bps = coalesce(excluded.fee_bps, bets.fee_bps)," : ""}
      resolved_at = now()
    RETURNING *;
  `;
  const ins = await DB.pool.query(insQ, insVals);
  return ins.rows[0] || null;
}

async function dbGetBetByNonce(nonce) {
  if (!DB?.pool) return null;
  const { rows } = await DB.pool.query(`select * from bets where nonce=$1 limit 1`, [ Number(nonce) ]);
  return rows[0] || null;
}

async function dbListDiceResolvedByWallet(wallet, { limit = 50, cursor = null } = {}) {
  if (!DB?.pool) return { items: [], nextCursor: null };
  const L = Math.max(1, Math.min(200, Number(limit) || 50));
  const proj = await selectProjectionBets();

  if (cursor) {
    const q = `
      select ${proj}
      from bets
      where player = $1 and status = 'resolved' and id < $2
      order by id desc
      limit $3
    `;
    const { rows } = await DB.pool.query(q, [String(wallet), Number(cursor), L]);
    const nextCursor = rows.length ? rows[rows.length - 1].id : null;
    return { items: rows, nextCursor };
  } else {
    const q = `
      select ${proj}
      from bets
      where player = $1 and status = 'resolved'
      order by id desc
      limit $2
    `;
    const { rows } = await DB.pool.query(q, [String(wallet), L]);
    const nextCursor = rows.length ? rows[rows.length - 1].id : null;
    return { items: rows, nextCursor };
  }
}

// ---------------- in-memory pending ----------------
const dicePending = new Map();

// ---------------- REST ----------------
function attachDiceRoutes(app) {
  if (!app || !app.use) return;
  const router = express.Router();

  router.get("/resolved", async (req, res) => {
    try {
      const wallet = String(req.query.wallet || "");
      const limit = req.query.limit;
      const cursor = req.query.cursor;
      if (!isMaybeBase58(wallet)) return res.status(400).json({ error: "bad wallet" });

      await ensureDiceSchema().catch(() => {});
      const out = await dbListDiceResolvedByWallet(wallet, { limit, cursor });
      out.verify = {
        algorithm: "HMAC_SHA256(serverSeed, clientSeed + nonce)",
        rollMapping: "uint32_be(hmac)[0:4] % 100 + 1",
      };
      res.json(out);
    } catch (e) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  app.use("/dice", router);
}

// ---------------- Socket.IO ----------------
function attachDice(io, app /* optional */) {
  ensureDiceSchema().catch((e) => console.warn("[ensureDiceSchema] failed:", e?.message || e));
  try { attachDiceRoutes(app); } catch (_) {}

  io.on("connection", (socket) => {
    // ---- keep original vault ops (on-chain) for real users ----
    socket.on("vault:activate_prepare", async ({ player, initialDepositLamports = 0 }) => {
      try {
        if (!player) return socket.emit("vault:error", { code: "NO_PLAYER", message: "player required" });

        // If in fake mode we don't build any on-chain tx; just acknowledge (front-end UX usually not used for fake)
        if (await Promo.isFakeMode(player)) {
          return socket.emit("vault:activated_fake", { ok: true, player });
        }

        const playerPk = new PublicKey(player);
        const userVault = deriveUserVaultPda(playerPk);

        const ixs = [
          ComputeBudgetProgram.setComputeUnitLimit({ units: 250_000 }),
          ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
          ixActivateUserVault({
            programId: PROGRAM_ID,
            player: playerPk,
            userVault,
            initialDepositLamports: Number(initialDepositLamports || 0),
          }),
        ];

        const { blockhash } = await connection.getLatestBlockhash("confirmed");
        const msg = new TransactionMessage({ payerKey: playerPk, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message();
        const vtx = new VersionedTransaction(msg);
        const txBase64 = Buffer.from(vtx.serialize()).toString("base64");
        socket.emit("vault:activate_tx", { transactionBase64: txBase64 });
      } catch (e) {
        socket.emit("vault:error", { code: "ACTIVATE_FAIL", message: String(e.message || e) });
      }
    });

    socket.on("vault:deposit_prepare", async ({ player, amountLamports }) => {
      try {
        if (!player) return socket.emit("vault:error", { code: "NO_PLAYER", message: "player required" });
        if (!amountLamports || Number(amountLamports) <= 0)
          return socket.emit("vault:error", { code: "BAD_AMOUNT", message: "amount required" });

        if (await Promo.isFakeMode(player)) {
          // In fake mode deposits are admin-driven; we simply reflect promo balance to UI
          const bal = await Promo.getPromoBalanceLamports(player);
          return socket.emit("vault:deposit_fake", { ok: true, promoBalanceLamports: bal });
        }

        const playerPk = new PublicKey(player);
        const userVault = deriveUserVaultPda(playerPk);

        const ixs = [
          ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
          ixDeposit({ programId: PROGRAM_ID, player: playerPk, userVault, amount: Number(amountLamports) }),
        ];

        const { blockhash } = await connection.getLatestBlockhash("confirmed");
        const msg = new TransactionMessage({ payerKey: playerPk, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message();
        const vtx = new VersionedTransaction(msg);
        const txBase64 = Buffer.from(vtx.serialize()).toString("base64");
        socket.emit("vault:deposit_tx", { transactionBase64: txBase64 });
      } catch (e) {
        socket.emit("vault:error", { code: "DEPOSIT_FAIL", message: String(e.message || e) });
      }
    });

    socket.on("vault:withdraw_prepare", async ({ player, amountLamports }) => {
      try {
        if (!player) return socket.emit("vault:error", { code: "NO_PLAYER", message: "player required" });
        if (!amountLamports || Number(amountLamports) <= 0)
          return socket.emit("vault:error", { code: "BAD_AMOUNT", message: "amount required" });

        // If user is in fake mode OR withdrawals disabled => block
        if (await Promo.isFakeMode(player)) {
          return socket.emit("vault:error", { code: "WITHDRAW_DISABLED", message: "withdrawals disabled for promo balance" });
        }
        if (!(await Promo.isUserWithdrawalsEnabled(player))) {
          return socket.emit("vault:error", { code: "WITHDRAW_DISABLED", message: "withdrawals disabled by admin" });
        }

        const playerPk = new PublicKey(player);
        const userVault = deriveUserVaultPda(playerPk);

        const ixs = [
          ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
          ixWithdraw({ programId: PROGRAM_ID, player: playerPk, userVault, amount: Number(amountLamports) }),
        ];

        const { blockhash } = await connection.getLatestBlockhash("confirmed");
        const msg = new TransactionMessage({ payerKey: playerPk, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message();
        const vtx = new VersionedTransaction(msg);
        const txBase64 = Buffer.from(vtx.serialize()).toString("base64");
        socket.emit("vault:withdraw_tx", { transactionBase64: txBase64 });
      } catch (e) {
        socket.emit("vault:error", { code: "WITHDRAW_FAIL", message: String(e.message || e) });
      }
    });

    // ---- Dice: place ----
    socket.on("dice:place", async ({ player, betAmountLamports, betType, targetNumber, clientSeed = "" }) => {
      try {
        if (!player) return socket.emit("dice:error", { code: "NO_PLAYER", message: "player required" });

        const betLamports = BigInt(betAmountLamports || 0);
        const betTypeNum = toBetTypeNum(betType);
        const target = Number(targetNumber);

        const cfg = await DB.getGameConfig?.("dice");
        const min = BigInt(cfg?.min_bet_lamports ?? 50000);
        const max = BigInt(cfg?.max_bet_lamports ?? 5_000_000_000n);
        if (betLamports < min || betLamports > max)
          return socket.emit("dice:error", { code: "BET_RANGE", message: "Bet outside allowed range" });
        if (!(target >= 2 && target <= 98))
          return socket.emit("dice:error", { code: "BAD_TARGET", message: "Target must be 2..98" });

        const useFake = await Promo.isFakeMode(player);
        const nonce = Date.now();
        const expiryUnix = Math.floor(Date.now() / 1000) + Number(process.env.NONCE_TTL_SECONDS || 300);

        // Provably-fair commitment (always, both modes)
        const serverSeedBuf = crypto.randomBytes(32);
        const serverSeedHex = serverSeedBuf.toString("hex");
        const serverSeedHash = crypto.createHash("sha256").update(serverSeedBuf).digest("hex");

        await precheckOrThrow({ userWallet: player, stakeLamports: betLamports, gameKey: "dice" });

        if (useFake) {
          // Freeze promo balance and record lock
          const newBal = await Promo.freezeForBet(player, betLamports);
          await dbRecordDiceLock({
            player,
            amountLamports: String(betLamports),
            betType: betTypeNum,
            target,
            nonce,
            expiry: expiryUnix,
            signature_base58: `FAKE-LOCK-${nonce}`,
            serverSeedHash,
            clientSeed: String(clientSeed || ""),
          });
          // Keep pending context in-memory
          dicePending.set(nonce, {
            player,
            betLamports,
            betTypeNum,
            target,
            clientSeed: String(clientSeed || ""),
            serverSeedHex,
            serverSeedHash,
          });
          return socket.emit("dice:locked", {
            nonce: String(nonce),
            txSig: `FAKE-LOCK-${nonce}`,
            serverSeedHash,
            promoBalanceLamports: newBal,
          });
        }

        // === REAL (on-chain) path ===
        const playerPk = new PublicKey(player);
        const userVault = deriveUserVaultPda(playerPk);
        const houseVault = deriveVaultPda();

        const pendingBet = derivePendingBetPda(playerPk, nonce);

        const msgBytes = buildMessageBytes({
          programId: PROGRAM_ID.toBuffer(),
          vault: houseVault.toBuffer(),
          player: playerPk.toBuffer(),
          betAmount: Number(betLamports),
          betType: Number(betTypeNum),
          target: Number(target),
          roll: 0,
          payout: 0,
          nonce: Number(nonce),
          expiryUnix: Number(expiryUnix),
        });
        const edSig = await signMessageEd25519(msgBytes);
        const edIx  = buildEd25519VerifyIx({ message: msgBytes, signature: edSig, publicKey: ADMIN_PK });
        const edIndex = 1;

        const feePayer = await getServerKeypair();
        const cuPriceIx = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 });
        const cuLimitIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 350_000 });

        const lockIx = ixPlaceBetFromVault({
          programId: PROGRAM_ID,
          player: playerPk,
          feePayer: feePayer.publicKey,
          userVault,
          houseVault,
          pendingBet,
          betAmount: Number(betLamports),
          betType: betTypeNum,
          target,
          nonce,
          expiryUnix,
          edIndex,
        });

        const { blockhash } = await connection.getLatestBlockhash("confirmed");
        const msgV0 = new TransactionMessage({
          payerKey: feePayer.publicKey,
          recentBlockhash: blockhash,
          instructions: [cuPriceIx, cuLimitIx, edIx, lockIx],
        }).compileToV0Message();

        const vtx = new VersionedTransaction(msgV0);
        const sim = await connection.simulateTransaction(vtx, { sigVerify: false });
        if (sim.value.err)
          throw new Error(`Dice lock simulate failed: ${JSON.stringify(sim.value.err)}\n${(sim.value.logs || []).join("\n")}`);

        vtx.sign([feePayer]);
        const sig = await connection.sendRawTransaction(vtx.serialize(), { skipPreflight: false, maxRetries: 5 });
        await connection.confirmTransaction(sig, "confirmed");

        // persist commitment
        await dbRecordDiceLock({
          player: playerPk.toBase58(),
          amountLamports: String(betLamports),
          betType: betTypeNum,
          target,
          nonce,
          expiry: expiryUnix,
          signature_base58: sig,
          serverSeedHash,
          clientSeed: String(clientSeed || ""),
        }).catch(() => {});

        dicePending.set(nonce, {
          player,
          betLamports,
          betTypeNum,
          target,
          clientSeed: String(clientSeed || ""),
          serverSeedHex,
          serverSeedHash,
        });

        socket.emit("dice:locked", { nonce: String(nonce), txSig: sig, serverSeedHash });
      } catch (e) {
        socket.emit("dice:error", { code: "PLACE_FAIL", message: String(e.message || e) });
      }
    });

    // ---- Dice: resolve ----
    socket.on("dice:resolve", async ({ player, nonce }) => {
      try {
        if (!player) return socket.emit("dice:error", { code: "NO_PLAYER", message: "player required" });
        if (!nonce)  return socket.emit("dice:error", { code: "NO_NONCE",  message: "nonce required" });

        const useFake = await Promo.isFakeMode(player);
        let ctx = dicePending.get(Number(nonce));

        if (!ctx) {
          const row = await dbGetBetByNonce(Number(nonce)).catch(() => null);
          if (row) {
            ctx = {
              player,
              betLamports: BigInt(row.bet_amount_lamports),
              betTypeNum: Number(row.bet_type),
              target: Number(row.target),
              clientSeed: String(row.client_seed || ""),
              serverSeedHex: String(row.server_seed_hex || ""),
              serverSeedHash: String(row.server_seed_hash || ""),
            };
          }
        }
        if (!ctx) return socket.emit("dice:error", { code: "NOT_FOUND", message: "no prepared dice bet for nonce" });

        // House edge / RTP
        let rtp_bps = 9900, fee_bps = 100;
        try {
          const rules = await DB.getRules?.();
          if (rules?.rtp_bps != null) rtp_bps = Number(rules.rtp_bps);
          if (rules?.house_edge_bps != null) fee_bps = Number(rules.house_edge_bps);
          if (DB.getGameConfig) {
            const cfg = await DB.getGameConfig("dice");
            if (cfg?.rtp_bps != null) rtp_bps = Number(cfg.rtp_bps);
            if (cfg?.fee_bps != null) fee_bps = Number(cfg.fee_bps);
            else fee_bps = Math.max(0, 10000 - rtp_bps);
          } else {
            fee_bps = Math.max(0, 10000 - rtp_bps);
          }
        } catch {}

        // Deterministic roll
        let roll, hmacHex;
        if (ctx.serverSeedHex) {
          const out = deriveDiceRoll({
            serverSeedHex: ctx.serverSeedHex,
            clientSeed: ctx.clientSeed,
            nonce: Number(nonce),
          });
          roll = out.roll;
          hmacHex = out.hmacHex;
        } else {
          roll = Math.floor(Math.random() * 100) + 1;
          hmacHex = null;
        }

        const win_odds = ctx.betTypeNum === 0 ? ctx.target - 1 : 100 - ctx.target;
        if (win_odds < 1 || win_odds > 99) throw new Error("Invalid win odds");
        const win = ctx.betTypeNum === 0 ? roll < ctx.target : roll > ctx.target;
        const payoutLamports = win
          ? Number(computePayoutLamports({ betLamports: ctx.betLamports, rtp_bps, win_odds }))
          : 0;

        if (useFake) {
          // Persist reveal, round, activity
          await dbUpsertDiceResolve({
            player,
            betLamports: Number(ctx.betLamports),
            betTypeNum: Number(ctx.betTypeNum),
            target: Number(ctx.target),
            nonce: Number(nonce),
            roll: Number(roll),
            payoutLamports: Number(payoutLamports),
            resolvedSig: `FAKE-RESOLVE-${nonce}`,
            serverSeedHex: ctx.serverSeedHex || null,
            hmacHex: hmacHex || null,
            clientSeed: ctx.clientSeed || "",
            win,
            rtp_bps,
            fee_bps,
          }).catch(() => {});

          await DB.recordGameRound?.({
            game_key: "dice",
            player,
            nonce: Number(nonce),
            stake_lamports: Number(ctx.betLamports),
            payout_lamports: Number(payoutLamports),
            result_json: {
              roll,
              betType: ctx.betTypeNum === 0 ? "under" : "over",
              target: ctx.target,
              win,
              hmacHex: hmacHex || null,
            },
          }).catch(() => {});
          if (payoutLamports > 0) {
            await DB.recordActivity?.({
              user: player,
              action: "Dice win",
              amount: (Number(payoutLamports) / 1e9).toFixed(4),
            }).catch(() => {});
          }

          // Credit payout back to promo
          await Promo.settleBet(player, payoutLamports);

          socket.emit("dice:resolved", {
            nonce: String(nonce),
            roll,
            win,
            payoutLamports: Number(payoutLamports),
            txSig: `FAKE-RESOLVE-${nonce}`,
          });

          if (ctx.serverSeedHex) {
            socket.emit("dice:reveal_seed", {
              nonce: String(nonce),
              serverSeedHex: ctx.serverSeedHex,
              clientSeed: ctx.clientSeed,
              formula: "HMAC_SHA256(serverSeed, clientSeed + nonce)",
              hmacHex: hmacHex || null,
            });
          }

          dicePending.delete(Number(nonce));
          return;
        }

        // === REAL (on-chain) resolve ===
        const playerPk = new PublicKey(player);
        const houseVault = deriveVaultPda();
        const adminPda   = deriveAdminPda();
        const userVault  = deriveUserVaultPda(playerPk);
        const expiryUnix = Math.floor(Date.now() / 1000) + Number(process.env.NONCE_TTL_SECONDS || 300);

        const msg = buildMessageBytes({
          programId: PROGRAM_ID.toBuffer(),
          vault: houseVault.toBuffer(),
          player: playerPk.toBuffer(),
          betAmount: Number(ctx.betLamports),
          betType: Number(ctx.betTypeNum),
          target: Number(ctx.target),
          roll,
          payout: payoutLamports,
          nonce: Number(nonce),
          expiryUnix: Number(expiryUnix),
        });
        const edSig = await signMessageEd25519(msg);
        const edIx  = buildEd25519VerifyIx({ message: msg, signature: edSig, publicKey: ADMIN_PK });
        const edIndex = 1;

        const pendingBet = derivePendingBetPda(playerPk, nonce);
        const ixRes = ixResolve({
          programId: PROGRAM_ID,
          player: playerPk,
          houseVault,
          adminPda,
          userVault,
          pendingBet,
          roll,
          payout: payoutLamports,
          edIndex,
        });

        const feePayer = await getServerKeypair();
        const cuPriceIx = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 });
        const cuLimitIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });

        const { blockhash } = await connection.getLatestBlockhash("confirmed");
        const msgV0 = new TransactionMessage({
          payerKey: feePayer.publicKey,
          recentBlockhash: blockhash,
          instructions: [cuPriceIx, cuLimitIx, edIx, ixRes],
        }).compileToV0Message();

        const vtx = new VersionedTransaction(msgV0);
        const sim = await connection.simulateTransaction(vtx, { sigVerify: false });
        if (sim.value.err)
          throw new Error(`Dice resolve simulate failed: ${JSON.stringify(sim.value.err)}\n${(sim.value.logs || []).join("\n")}`);

        vtx.sign([feePayer]);
        const sig = await connection.sendRawTransaction(vtx.serialize(), { skipPreflight: false, maxRetries: 5 });
        await connection.confirmTransaction(sig, "confirmed");

        await dbUpsertDiceResolve({
          player,
          betLamports: Number(ctx.betLamports),
          betTypeNum: Number(ctx.betTypeNum),
          target: Number(ctx.target),
          nonce: Number(nonce),
          roll: Number(roll),
          payoutLamports: Number(payoutLamports),
          resolvedSig: sig,
          serverSeedHex: ctx.serverSeedHex || null,
          hmacHex: hmacHex || null,
          clientSeed: ctx.clientSeed || "",
          win,
          rtp_bps,
          fee_bps,
        }).catch(() => {});

        await DB.recordGameRound?.({
          game_key: "dice",
          player,
          nonce: Number(nonce),
          stake_lamports: Number(ctx.betLamports),
          payout_lamports: Number(payoutLamports),
          result_json: {
            roll,
            betType: ctx.betTypeNum === 0 ? "under" : "over",
            target: ctx.target,
            win,
            hmacHex: hmacHex || null,
          },
        }).catch(() => {});
        if (payoutLamports > 0) {
          await DB.recordActivity?.({
            user: player,
            action: "Dice win",
            amount: (Number(payoutLamports) / 1e9).toFixed(4),
          }).catch(() => {});
        }

        socket.emit("dice:resolved", {
          nonce: String(nonce),
          roll,
          win,
          payoutLamports: Number(payoutLamports),
          txSig: sig,
        });

        if (ctx.serverSeedHex) {
          socket.emit("dice:reveal_seed", {
            nonce: String(nonce),
            serverSeedHex: ctx.serverSeedHex,
            clientSeed: ctx.clientSeed,
            formula: "HMAC_SHA256(serverSeed, clientSeed + nonce)",
            hmacHex: hmacHex || null,
          });
        }

        dicePending.delete(Number(nonce));
      } catch (e) {
        socket.emit("dice:error", { code: "RESOLVE_FAIL", message: String(e.message || e) });
      }
    });
  });
}

module.exports = {
  ensureDiceSchema,
  attachDiceRoutes,
  attachDice,
};
