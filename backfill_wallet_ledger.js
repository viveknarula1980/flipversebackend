// listeners/backfill_wallet_ledger.js
//
// One-off scanner to backfill historical deposit/withdraw events into your DB.
// Usage: node listeners/backfill_wallet_ledger.js

const { Connection, PublicKey } = require("@solana/web3.js");
const { handleTxSig } = require("./vault_listener");

(async () => {
  if (!process.env.PROGRAM_ID) {
    throw new Error("PROGRAM_ID missing in env");
  }
  const PROGRAM_ID = new PublicKey(process.env.PROGRAM_ID);
  const RPC_URL =
    process.env.RPC_URL ||
    process.env.SOLANA_RPC ||
    process.env.CLUSTER ||
    "https://api.devnet.solana.com";

  const connection = new Connection(RPC_URL, "confirmed");
  let before = undefined;
  let scanned = 0;

  while (true) {
    const sigs = await connection.getSignaturesForAddress(PROGRAM_ID, { limit: 1000, before });
    if (!sigs.length) break;

    for (const s of sigs) {
      try {
        await handleTxSig(s.signature);
        scanned++;
      } catch (e) {
        // ignore and continue
      }
    }
    before = sigs[sigs.length - 1].signature;
    console.log(`[backfill] scanned up to ${before} (total ${scanned})`);
  }

  console.log(`[backfill] complete, total scanned: ${scanned}`);
})();
