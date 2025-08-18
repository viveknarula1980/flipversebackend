// solana.js

const { Connection, PublicKey, Ed25519Program } = require("@solana/web3.js");

const RPC_URL =
  process.env.RPC_URL ||
  process.env.CLUSTER || 
  "https://api.devnet.solana.com";

if (!process.env.PROGRAM_ID) {
  throw new Error("Missing PROGRAM_ID in environment (.env)");
}

let PROGRAM_ID;
try {
  PROGRAM_ID = new PublicKey(process.env.PROGRAM_ID);
} catch (e) {
  throw new Error(`Invalid PROGRAM_ID: ${process.env.PROGRAM_ID}`);
}

// --- Connection ---
const connection = new Connection(RPC_URL, "confirmed");

// --- PDA derived
function deriveVaultPda() {
  const [pda] = PublicKey.findProgramAddressSync([Buffer.from("vault")], PROGRAM_ID);
  return pda;
}

function deriveAdminPda() {
  const [pda] = PublicKey.findProgramAddressSync([Buffer.from("admin")], PROGRAM_ID);
  return pda;
}


function buildEd25519VerifyIx({ message, signature, publicKey }) {
  if (!Buffer.isBuffer(message)) throw new Error("ed25519: message must be Buffer");
  if (!Buffer.isBuffer(signature) || signature.length !== 64) {
    throw new Error("ed25519: signature must be 64-byte Buffer");
  }
  if (!Buffer.isBuffer(publicKey) || publicKey.length !== 32) {
    throw new Error("ed25519: publicKey must be 32-byte Buffer");
  }

  return Ed25519Program.createInstructionWithPublicKey({
    publicKey,
    message,
    signature,
  });
}

module.exports = {
  connection,
  RPC_URL,
  PROGRAM_ID,
  deriveVaultPda,
  deriveAdminPda,
  buildEd25519VerifyIx,
};
