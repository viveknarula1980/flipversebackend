// backend/promo_balance.js
// Fake/promo-balance logic with object-arg helpers compatible with coinflip.js.
// - freezeForBet({ wallet, amountLamports, gameKey }) → boolean success
// - settleBet({ wallet, payoutLamports, ... }) → boolean success
//
// Also keeps positional-call wrappers for older code paths.

const { PublicKey, Connection } = require("@solana/web3.js");
const DB = global.db || require("./db");

const CLUSTER = process.env.CLUSTER || "https://api.devnet.solana.com";
const PROGRAM_ID = new PublicKey(process.env.PROGRAM_ID);
const connection = new Connection(CLUSTER, "confirmed");

function deriveUserVaultPda(playerPk) {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("user_vault"), new PublicKey(playerPk).toBuffer()],
    PROGRAM_ID
  );
  return pda;
}

async function ensurePromoColumns() {
  try {
    await DB.pool.query(`
      ALTER TABLE IF EXISTS app_users
        ADD COLUMN IF NOT EXISTS promo_balance_lamports BIGINT NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS use_fake BOOLEAN NOT NULL DEFAULT FALSE;
    `);
  } catch (e) {
    console.warn("[promo_balance.ensurePromoColumns] failed:", e?.message || e);
  }
}

async function getRow(wallet) {
  await ensurePromoColumns();
  const { rows } = await DB.pool.query(
    `SELECT user_id, promo_balance_lamports::bigint AS promo, use_fake
       FROM app_users WHERE user_id=$1 LIMIT 1`,
    [String(wallet)]
  );
  return rows[0] || null;
}

async function upsertUserRow(wallet) {
  await ensurePromoColumns();
  await DB.pool.query(
    `INSERT INTO app_users (user_id, username, last_active)
     VALUES ($1, $1, now())
     ON CONFLICT (user_id) DO UPDATE SET last_active=now()`,
    [String(wallet)]
  );
}

async function isFakeMode(wallet) {
  await upsertUserRow(wallet);
  const r = await getRow(wallet);
  if (!r) return false;
  return Boolean(r.use_fake || (r.promo && BigInt(r.promo) > 0n));
}

async function setFakeMode(wallet, enabled) {
  await upsertUserRow(wallet);
  await DB.pool.query(
    `UPDATE app_users SET use_fake=$2, last_active=now() WHERE user_id=$1`,
    [String(wallet), !!enabled]
  );
  try {
    if (enabled) await updateWithdrawalPermissions(wallet, false);
  } catch {}
  return { ok: true, enabled: !!enabled };
}

async function getPromoBalanceLamports(wallet) {
  await upsertUserRow(wallet);
  const r = await getRow(wallet);
  return r ? Number(r.promo || 0) : 0;
}

async function setPromoBalanceLamports(wallet, lamports) {
  await upsertUserRow(wallet);
  const val = Math.max(0, Math.round(Number(lamports) || 0));
  await DB.pool.query(
    `UPDATE app_users SET promo_balance_lamports=$2, last_active=now() WHERE user_id=$1`,
    [String(wallet), val]
  );
  return val;
}

async function adjustPromoBalanceLamports(wallet, deltaLamports, activityLabel = null) {
  await upsertUserRow(wallet);
  const delta = Math.round(Number(deltaLamports) || 0);
  const { rows } = await DB.pool.query(
    `UPDATE app_users
       SET promo_balance_lamports = GREATEST(0, promo_balance_lamports + $2),
           last_active = now()
     WHERE user_id=$1
     RETURNING promo_balance_lamports::bigint AS promo`,
    [String(wallet), delta]
  );
  const newBal = rows[0] ? Number(rows[0].promo || 0) : 0;

  if (activityLabel) {
    try {
      await DB.recordActivity?.({
        user: String(wallet),
        action: activityLabel,
        amount: Number(delta) / 1e9,
      });
    } catch {}
  }
  return newBal;
}

async function fetchLivePdaLamports(wallet) {
  try {
    const pda = deriveUserVaultPda(wallet);
    const lamports = await connection.getBalance(pda, "confirmed");
    return lamports;
  } catch {
    return 0;
  }
}

async function getEffectiveLamports(wallet) {
  if (await isFakeMode(wallet)) {
    return await getPromoBalanceLamports(wallet);
  }
  return await fetchLivePdaLamports(wallet);
}

// ---- helpers to normalize inputs from object/positional forms ----
function _numLamports(x) {
  if (typeof x === "bigint") return Number(x);
  const n = Number(x);
  return Number.isFinite(n) ? Math.round(n) : 0;
}
function _walletFromArg(arg0) {
  return typeof arg0 === "object" && arg0 && arg0.wallet ? String(arg0.wallet) : String(arg0);
}
function _amountFromArg(arg0, arg1) {
  if (typeof arg0 === "object" && arg0) {
    return _numLamports(arg0.amountLamports ?? arg0.stakeLamports ?? arg0.payoutLamports ?? 0);
  }
  return _numLamports(arg1);
}
function _label(gameKey, suffix) {
  return `${gameKey ? String(gameKey) : "game"}_${suffix}`;
}

// === Fake mode: freeze on place (return boolean success) ===
// Supports:
//   freezeForBet({ wallet, amountLamports, gameKey })
//   freezeForBet(wallet, stakeLamports)
async function freezeForBet(arg0, arg1) {
  const wallet = _walletFromArg(arg0);
  const amount = _amountFromArg(arg0, arg1);
  const gameKey = typeof arg0 === "object" ? arg0.gameKey : null;

  if (!wallet || !(amount > 0)) return false;

  await upsertUserRow(wallet);
  const bal = await getPromoBalanceLamports(wallet);
  if (bal < amount) return false;

  await adjustPromoBalanceLamports(wallet, -amount, _label(gameKey, "freeze"));
  return true;
}

// === Fake mode: settle on resolve (credit net winnings if any) ===
// Supports:
//   settleBet({ wallet, payoutLamports, win, gameKey })
//   settleBet(wallet, payoutLamports)
async function settleBet(arg0, arg1) {
  const wallet = _walletFromArg(arg0);
  const payout = _amountFromArg(arg0, arg1);
  const gameKey = typeof arg0 === "object" ? arg0.gameKey : null;

  if (!wallet) return false;
  if (payout > 0) {
    await adjustPromoBalanceLamports(wallet, payout, _label(gameKey, "settle"));
  }
  return true;
}

// --- Optional: frozen amount reporting (no separate ledger here) ---
async function getFrozenForBetsLamports(_wallet) {
  return 0;
}

// --- Withdrawal flags (optional) ---
async function isUserWithdrawalsEnabled(wallet) {
  const { rows } = await DB.pool.query(
    `SELECT withdrawals_enabled FROM admin_user_flags WHERE wallet=$1 LIMIT 1`,
    [String(wallet)]
  );
  return rows[0] ? !!rows[0].withdrawals_enabled : true;
}

async function updateWithdrawalPermissions(wallet, enabled) {
  await DB.pool.query(
    `INSERT INTO admin_user_flags (wallet, withdrawals_enabled, updated_at)
     VALUES ($1,$2,now())
     ON CONFLICT (wallet) DO UPDATE SET withdrawals_enabled=excluded.withdrawals_enabled, updated_at=now()`,
    [String(wallet), !!enabled]
  );
  return { ok: true, withdrawalsEnabled: !!enabled };
}

module.exports = {
  // mode + balances
  isFakeMode,
  setFakeMode,
  getPromoBalanceLamports,
  setPromoBalanceLamports,
  adjustPromoBalanceLamports,
  getEffectiveLamports,
  fetchLivePdaLamports,
  getFrozenForBetsLamports,

  // gameplay (object + positional)
  freezeForBet,
  settleBet,

  // withdrawals flags
  isUserWithdrawalsEnabled,
  updateWithdrawalPermissions,
};
