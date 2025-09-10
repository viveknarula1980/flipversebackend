// bonus_transfer.js
// Moves real lamports from your HOUSE wallet to a user's vault PDA.

require("dotenv").config();

const {
  Connection,
  PublicKey,
  SystemProgram,
  Keypair,
  Transaction,
  sendAndConfirmTransaction,
} = require("@solana/web3.js");
const bs58 = require("bs58");

// ---------- ENV ----------
const RPC_HTTP = process.env.CLUSTER || "https://api.devnet.solana.com";
if (!process.env.PROGRAM_ID) throw new Error("PROGRAM_ID missing in .env");
const PROGRAM_ID = new PublicKey(process.env.PROGRAM_ID);

// HOUSE secret: base58-encoded 64-byte secret key OR JSON array.
function loadKeypairFromEnv(envName = "HOUSE_SECRET_KEY") {
  const raw = (process.env[envName] || "").trim();
  if (!raw) throw new Error(`${envName} missing in .env`);
  try {
    if (raw.startsWith("[") && raw.endsWith("]")) {
      const arr = JSON.parse(raw);
      const secret = Uint8Array.from(arr);
      return Keypair.fromSecretKey(secret);
    }
    const secret = bs58.decode(raw);
    return Keypair.fromSecretKey(secret);
  } catch (e) {
    throw new Error(`${envName} not a valid key: ${e?.message || e}`);
  }
}

// ---------- Helpers ----------
/** Derive user_vault PDA from player pubkey (MUST match on-chain program). */
function userVaultPda(player) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("user_vault"), new PublicKey(player).toBuffer()],
    PROGRAM_ID
  )[0];
}

async function accountExists(connection, pubkey) {
  const info = await connection.getAccountInfo(pubkey, "confirmed");
  return !!info;
}

async function systemTransfer({
  connection,
  fromKeypair,
  toPubkey,
  lamports,
  skipPreflight = false,
}) {
  const ix = SystemProgram.transfer({
    fromPubkey: fromKeypair.publicKey,
    toPubkey,
    lamports: Number(lamports),
  });

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("finalized");
  const tx = new Transaction({ feePayer: fromKeypair.publicKey, blockhash, lastValidBlockHeight });
  tx.add(ix);

  const sig = await sendAndConfirmTransaction(connection, tx, [fromKeypair], {
    commitment: "confirmed",
    skipPreflight,
  });
  return sig;
}

/**
 * Deposit bonus lamports into the player's vault PDA.
 * - Verifies the PDA exists (so you don't transfer to a non-existent account).
 * - Sends a SystemProgram transfer (chain-native).
 * Returns: { ok:true, txSig: string, toVault: string }
 */
async function depositBonusToVault({ userWallet, lamports }) {
  if (!userWallet) throw new Error("userWallet is required");
  const lp = Number(lamports || 0);
  if (!Number.isFinite(lp) || lp <= 0) throw new Error("lamports must be > 0");

  const connection = new Connection(RPC_HTTP, "confirmed");
  const house = loadKeypairFromEnv("HOUSE_SECRET_KEY");
  const pda = userVaultPda(userWallet);

  // Ensure the PDA exists
  const exists = await accountExists(connection, pda);
  if (!exists) {
    const err = new Error("vault-not-activated");
    err.code = "VAULT_NOT_ACTIVATED";
    err.details = { userWallet, pda: pda.toBase58() };
    throw err;
  }

  // Log some helpful context for ops
  console.log("[bonus_transfer] cluster:", RPC_HTTP);
  console.log("[bonus_transfer] programId:", PROGRAM_ID.toBase58());
  console.log("[bonus_transfer] house:", house.publicKey.toBase58());
  console.log("[bonus_transfer] toVault:", pda.toBase58(), "lamports:", lp);

  // Transfer lamports from HOUSE → PDA
  const txSig = await systemTransfer({
    connection,
    fromKeypair: house,
    toPubkey: pda,
    lamports: lp,
  });

  console.log("[bonus_transfer] txSig:", txSig);
  return { ok: true, txSig, toVault: pda.toBase58() };
}

module.exports = {
  depositBonusToVault,
  userVaultPda,
};
