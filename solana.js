// solana.js
const { Connection, PublicKey, Ed25519Program } = require("@solana/web3.js");

const CLUSTER = process.env.CLUSTER || "https://api.devnet.solana.com";
const PROGRAM_ID = new PublicKey(process.env.PROGRAM_ID);

function deriveVaultPda() {
  const [pda] = PublicKey.findProgramAddressSync([Buffer.from("vault")], PROGRAM_ID);
  return pda;
}
function deriveAdminPda() {
  const [pda] = PublicKey.findProgramAddressSync([Buffer.from("admin")], PROGRAM_ID);
  return pda;
}
function derivePendingBetPda(playerPk, nonceBigInt) {
  const nonceBuf = Buffer.from(new Uint8Array(new BigUint64Array([nonceBigInt]).buffer));
  const [pda] = PublicKey.findProgramAddressSync([Buffer.from("bet"), playerPk.toBuffer(), nonceBuf], PROGRAM_ID);
  return pda;
}

const connection = new Connection(CLUSTER, "confirmed");

function buildEd25519VerifyIx({ message, signature, publicKey }) {
  return Ed25519Program.createInstructionWithPublicKey({ publicKey, message, signature });
}

module.exports = {
  connection,
  PROGRAM_ID,
  deriveVaultPda,
  deriveAdminPda,
  derivePendingBetPda,
  buildEd25519VerifyIx,
};
