// backend/plinko_ws.js — STRICT resolver + DB gating/persistence (table-driven payouts)

const crypto = require("crypto");
const {
  Connection,
  PublicKey,
  VersionedTransaction,
  TransactionMessage,
  SystemProgram,
  ComputeBudgetProgram,
  Ed25519Program,
} = require("@solana/web3.js");

const { ADMIN_PK, signMessageEd25519, getServerKeypair } = require("./signer");
const DB = global.db || require("./db");

// ---------- RPC / Program ----------
const RPC_URL = process.env.CLUSTER || "https://api.devnet.solana.com";
const connection = new Connection(RPC_URL, "confirmed");
if (!process.env.PLINKO_PROGRAM_ID) throw new Error("PLINKO_PROGRAM_ID missing in .env");
const PROGRAM_ID = new PublicKey(process.env.PLINKO_PROGRAM_ID);

const LOCK_IX = process.env.PLINKO_LOCK_IX_NAME || "lock";
const RES_IX  = process.env.PLINKO_RESOLVE_IX_NAME || "resolve";
const SYSVAR_INSTR = new PublicKey("Sysvar1nstructions1111111111111111111111111");

// ---------- PDAs & helpers ----------
const pdaVault = () => PublicKey.findProgramAddressSync([Buffer.from("vault")], PROGRAM_ID)[0];
const pdaAdmin = () => PublicKey.findProgramAddressSync([Buffer.from("admin")], PROGRAM_ID)[0];
function pdaPending(playerPk, nonce) {
  const nb = Buffer.alloc(8); nb.writeBigUInt64LE(BigInt(nonce));
  return PublicKey.findProgramAddressSync([Buffer.from("bet"), playerPk.toBuffer(), nb], PROGRAM_ID)[0];
}
const disc = (name) => crypto.createHash("sha256").update(`global:${name}`).digest().slice(0, 8);

// ---------- Anchor arg encoders ----------
function encLock({ unitAmount, balls, rows, difficulty, nonce, expiryUnix }) {
  const d = disc(LOCK_IX);
  const b = Buffer.alloc(8 + 8 + 2 + 1 + 1 + 8 + 8);
  let o = 0;
  d.copy(b, o); o += 8;
  b.writeBigUInt64LE(BigInt(unitAmount), o); o += 8;
  b.writeUInt16LE(balls & 0xffff, o); o += 2;
  b.writeUInt8(rows & 0xff, o++); b.writeUInt8(difficulty & 0xff, o++);
  b.writeBigUInt64LE(BigInt(nonce), o); o += 8;
  b.writeBigInt64LE(BigInt(expiryUnix), o); o += 8;
  return b;
}
function encResolve({ checksum, payout, edIndex }) {
  const d = disc(RES_IX);
  const b = Buffer.alloc(8 + 1 + 8 + 1);
  let o = 0;
  d.copy(b, o); o += 8;
  b.writeUInt8(checksum & 0xff, o++); b.writeBigUInt64LE(BigInt(payout), o); o += 8; b.writeUInt8(edIndex & 0xff, o++);
  return b;
}

// ---------- fixed payout tables (multipliers & probabilities) ----------
const PLINKO_TABLE = {
  easy: {
    "8": [{"slot":0,"multiplier":0.0,"probability":0.003906},{"slot":1,"multiplier":0.2464,"probability":0.03125},{"slot":2,"multiplier":0.5288,"probability":0.109375},{"slot":3,"multiplier":0.8777,"probability":0.21875},{"slot":4,"multiplier":1.5541,"probability":0.273437},{"slot":5,"multiplier":0.8777,"probability":0.21875},{"slot":6,"multiplier":0.5288,"probability":0.109375},{"slot":7,"multiplier":0.2464,"probability":0.03125},{"slot":8,"multiplier":0.0,"probability":0.003906}],
    "9": [{"slot":0,"multiplier":0.0,"probability":0.001953},{"slot":1,"multiplier":0.2326,"probability":0.017578},{"slot":2,"multiplier":0.4939,"probability":0.070313},{"slot":3,"multiplier":0.8023,"probability":0.164063},{"slot":4,"multiplier":1.2173,"probability":0.246094},{"slot":5,"multiplier":1.2173,"probability":0.246094},{"slot":6,"multiplier":0.8023,"probability":0.164063},{"slot":7,"multiplier":0.4939,"probability":0.070313},{"slot":8,"multiplier":0.2326,"probability":0.017578},{"slot":9,"multiplier":0.0,"probability":0.001953}],
    "10": [{"slot":0,"multiplier":0.0,"probability":0.000977},{"slot":1,"multiplier":0.1885,"probability":0.009766},{"slot":2,"multiplier":0.3971,"probability":0.043945},{"slot":3,"multiplier":0.6362,"probability":0.117187},{"slot":4,"multiplier":0.9316,"probability":0.205078},{"slot":5,"multiplier":1.5043,"probability":0.246094},{"slot":6,"multiplier":0.9316,"probability":0.205078},{"slot":7,"multiplier":0.6362,"probability":0.117187},{"slot":8,"multiplier":0.3971,"probability":0.043945},{"slot":9,"multiplier":0.1885,"probability":0.009766},{"slot":10,"multiplier":0.0,"probability":0.000977}],
    "11": [{"slot":0,"multiplier":0.0,"probability":0.000488},{"slot":1,"multiplier":0.1797,"probability":0.005371},{"slot":2,"multiplier":0.3763,"probability":0.026855},{"slot":3,"multiplier":0.5971,"probability":0.080566},{"slot":4,"multiplier":0.8577,"probability":0.161133},{"slot":5,"multiplier":1.2085,"probability":0.225586},{"slot":6,"multiplier":1.2085,"probability":0.225586},{"slot":7,"multiplier":0.8577,"probability":0.161133},{"slot":8,"multiplier":0.5971,"probability":0.080566},{"slot":9,"multiplier":0.3763,"probability":0.026855},{"slot":10,"multiplier":0.1797,"probability":0.005371},{"slot":11,"multiplier":0.0,"probability":0.000488}],
    "12": [{"slot":0,"multiplier":0.0,"probability":0.000244},{"slot":1,"multiplier":0.1519,"probability":0.00293},{"slot":2,"multiplier":0.3166,"probability":0.016113},{"slot":3,"multiplier":0.4989,"probability":0.053711},{"slot":4,"multiplier":0.7078,"probability":0.12085},{"slot":5,"multiplier":0.9658,"probability":0.193359},{"slot":6,"multiplier":1.4662,"probability":0.225586},{"slot":7,"multiplier":0.9658,"probability":0.193359},{"slot":8,"multiplier":0.7078,"probability":0.12085},{"slot":9,"multiplier":0.4989,"probability":0.053711},{"slot":10,"multiplier":0.3166,"probability":0.016113},{"slot":11,"multiplier":0.1519,"probability":0.00293},{"slot":12,"multiplier":0.0,"probability":0.000244}],
    "13": [{"slot":0,"multiplier":0.0,"probability":0.000122},{"slot":1,"multiplier":0.1458,"probability":0.001587},{"slot":2,"multiplier":0.3027,"probability":0.009521},{"slot":3,"multiplier":0.4744,"probability":0.034912},{"slot":4,"multiplier":0.6671,"probability":0.08728},{"slot":5,"multiplier":0.8946,"probability":0.157104},{"slot":6,"multiplier":1.2008,"probability":0.209473},{"slot":7,"multiplier":1.2008,"probability":0.209473},{"slot":8,"multiplier":0.8946,"probability":0.157104},{"slot":9,"multiplier":0.6671,"probability":0.08728},{"slot":10,"multiplier":0.4744,"probability":0.034912},{"slot":11,"multiplier":0.3027,"probability":0.009521},{"slot":12,"multiplier":0.1458,"probability":0.001587},{"slot":13,"multiplier":0.0,"probability":0.000122}],
    "14": [{"slot":0,"multiplier":0.0,"probability":6.1e-05},{"slot":1,"multiplier":0.1268,"probability":0.000854},{"slot":2,"multiplier":0.2625,"probability":0.005554},{"slot":3,"multiplier":0.4095,"probability":0.022217},{"slot":4,"multiplier":0.5722,"probability":0.061096},{"slot":5,"multiplier":0.7587,"probability":0.122192},{"slot":6,"multiplier":0.9891,"probability":0.183289},{"slot":7,"multiplier":1.4358,"probability":0.209473},{"slot":8,"multiplier":0.9891,"probability":0.183289},{"slot":9,"multiplier":0.7587,"probability":0.122192},{"slot":10,"multiplier":0.5722,"probability":0.061096},{"slot":11,"multiplier":0.4095,"probability":0.022217},{"slot":12,"multiplier":0.2625,"probability":0.005554},{"slot":13,"multiplier":0.1268,"probability":0.000854},{"slot":14,"multiplier":0.0,"probability":6.1e-05}],
    "15": [{"slot":0,"multiplier":0.0,"probability":3.1e-05},{"slot":1,"multiplier":0.1223,"probability":0.000458},{"slot":2,"multiplier":0.2525,"probability":0.003204},{"slot":3,"multiplier":0.3925,"probability":0.013885},{"slot":4,"multiplier":0.5457,"probability":0.041656},{"slot":5,"multiplier":0.7178,"probability":0.091644},{"slot":6,"multiplier":0.9209,"probability":0.15274},{"slot":7,"multiplier":1.1942,"probability":0.196381},{"slot":8,"multiplier":1.1942,"probability":0.196381},{"slot":9,"multiplier":0.9209,"probability":0.15274},{"slot":10,"multiplier":0.7178,"probability":0.091644},{"slot":11,"multiplier":0.5457,"probability":0.041656},{"slot":12,"multiplier":0.3925,"probability":0.013885},{"slot":13,"multiplier":0.2525,"probability":0.003204},{"slot":14,"multiplier":0.1223,"probability":0.000458},{"slot":15,"multiplier":0.0,"probability":3.1e-05}],
    "16": [{"slot":0,"multiplier":0.0,"probability":1.5e-05},{"slot":1,"multiplier":0.1086,"probability":0.000244},{"slot":2,"multiplier":0.2237,"probability":0.001831},{"slot":3,"multiplier":0.3467,"probability":0.008545},{"slot":4,"multiplier":0.48,"probability":0.027771},{"slot":5,"multiplier":0.6276,"probability":0.06665},{"slot":6,"multiplier":0.7967,"probability":0.122192},{"slot":7,"multiplier":1.0057,"probability":0.174561},{"slot":8,"multiplier":1.4108,"probability":0.196381},{"slot":9,"multiplier":1.0057,"probability":0.174561},{"slot":10,"multiplier":0.7967,"probability":0.122192},{"slot":11,"multiplier":0.6276,"probability":0.06665},{"slot":12,"multiplier":0.48,"probability":0.027771},{"slot":13,"multiplier":0.3467,"probability":0.008545},{"slot":14,"multiplier":0.2237,"probability":0.001831},{"slot":15,"multiplier":0.1086,"probability":0.000244},{"slot":16,"multiplier":0.0,"probability":1.5e-05}]
  },
  med: {
    "8": [{"slot":0,"multiplier":0.0,"probability":0.003906},{"slot":1,"multiplier":0.3058,"probability":0.03125},{"slot":2,"multiplier":0.6223,"probability":0.109375},{"slot":3,"multiplier":0.9557,"probability":0.21875},{"slot":4,"multiplier":1.3408,"probability":0.273437},{"slot":5,"multiplier":0.9557,"probability":0.21875},{"slot":6,"multiplier":0.6223,"probability":0.109375},{"slot":7,"multiplier":0.3058,"probability":0.03125},{"slot":8,"multiplier":0.0,"probability":0.003906}],
    "9": [{"slot":0,"multiplier":0.0,"probability":0.001953},{"slot":1,"multiplier":0.2738,"probability":0.017578},{"slot":2,"multiplier":0.5556,"probability":0.070313},{"slot":3,"multiplier":0.8493,"probability":0.164063},{"slot":4,"multiplier":1.1653,"probability":0.246094},{"slot":5,"multiplier":1.1653,"probability":0.246094},{"slot":6,"multiplier":0.8493,"probability":0.164063},{"slot":7,"multiplier":0.5556,"probability":0.070313},{"slot":8,"multiplier":0.2738,"probability":0.017578},{"slot":9,"multiplier":0.0,"probability":0.001953}],
    "10": [{"slot":0,"multiplier":0.0,"probability":0.000977},{"slot":1,"multiplier":0.2351,"probability":0.009766},{"slot":2,"multiplier":0.4762,"probability":0.043945},{"slot":3,"multiplier":0.7257,"probability":0.117187},{"slot":4,"multiplier":0.9886,"probability":0.205078},{"slot":5,"multiplier":1.2922,"probability":0.246094},{"slot":6,"multiplier":0.9886,"probability":0.205078},{"slot":7,"multiplier":0.7257,"probability":0.117187},{"slot":8,"multiplier":0.4762,"probability":0.043945},{"slot":9,"multiplier":0.2351,"probability":0.009766},{"slot":10,"multiplier":0.0,"probability":0.000977}],
    "11": [{"slot":0,"multiplier":0.0,"probability":0.000488},{"slot":1,"multiplier":0.2149,"probability":0.005371},{"slot":2,"multiplier":0.4346,"probability":0.026855},{"slot":3,"multiplier":0.6608,"probability":0.080566},{"slot":4,"multiplier":0.8966,"probability":0.161133},{"slot":5,"multiplier":1.1502,"probability":0.225586},{"slot":6,"multiplier":1.1502,"probability":0.225586},{"slot":7,"multiplier":0.8966,"probability":0.161133},{"slot":8,"multiplier":0.6608,"probability":0.080566},{"slot":9,"multiplier":0.4346,"probability":0.026855},{"slot":10,"multiplier":0.2149,"probability":0.005371},{"slot":11,"multiplier":0.0,"probability":0.000488}],
    "12": [{"slot":0,"multiplier":0.0,"probability":0.000244},{"slot":1,"multiplier":0.1903,"probability":0.00293},{"slot":2,"multiplier":0.3844,"probability":0.016113},{"slot":3,"multiplier":0.5836,"probability":0.053711},{"slot":4,"multiplier":0.7896,"probability":0.12085},{"slot":5,"multiplier":1.0067,"probability":0.193359},{"slot":6,"multiplier":1.2574,"probability":0.225586},{"slot":7,"multiplier":1.0067,"probability":0.193359},{"slot":8,"multiplier":0.7896,"probability":0.12085},{"slot":9,"multiplier":0.5836,"probability":0.053711},{"slot":10,"multiplier":0.3844,"probability":0.016113},{"slot":11,"multiplier":0.1903,"probability":0.00293},{"slot":12,"multiplier":0.0,"probability":0.000244}],
    "13": [{"slot":0,"multiplier":0.0,"probability":0.000122},{"slot":1,"multiplier":0.1764,"probability":0.001587},{"slot":2,"multiplier":0.3561,"probability":0.009521},{"slot":3,"multiplier":0.5398,"probability":0.034912},{"slot":4,"multiplier":0.7289,"probability":0.08728},{"slot":5,"multiplier":0.926,"probability":0.157104},{"slot":6,"multiplier":1.138,"probability":0.209473},{"slot":7,"multiplier":1.138,"probability":0.209473},{"slot":8,"multiplier":0.926,"probability":0.157104},{"slot":9,"multiplier":0.7289,"probability":0.08728},{"slot":10,"multiplier":0.5398,"probability":0.034912},{"slot":11,"multiplier":0.3561,"probability":0.009521},{"slot":12,"multiplier":0.1764,"probability":0.001587},{"slot":13,"multiplier":0.0,"probability":0.000122}],
    "14": [{"slot":0,"multiplier":0.0,"probability":6.1e-05},{"slot":1,"multiplier":0.1595,"probability":0.000854},{"slot":2,"multiplier":0.3216,"probability":0.005554},{"slot":3,"multiplier":0.4871,"probability":0.022217},{"slot":4,"multiplier":0.6568,"probability":0.061096},{"slot":5,"multiplier":0.8324,"probability":0.122192},{"slot":6,"multiplier":1.0174,"probability":0.183289},{"slot":7,"multiplier":1.2311,"probability":0.209473},{"slot":8,"multiplier":1.0174,"probability":0.183289},{"slot":9,"multiplier":0.8324,"probability":0.122192},{"slot":10,"multiplier":0.6568,"probability":0.061096},{"slot":11,"multiplier":0.4871,"probability":0.022217},{"slot":12,"multiplier":0.3216,"probability":0.005554},{"slot":13,"multiplier":0.1595,"probability":0.000854},{"slot":14,"multiplier":0.0,"probability":6.1e-05}],
    "15": [{"slot":0,"multiplier":0.0,"probability":3.1e-05},{"slot":1,"multiplier":0.1494,"probability":0.000458},{"slot":2,"multiplier":0.3011,"probability":0.003204},{"slot":3,"multiplier":0.4555,"probability":0.013885},{"slot":4,"multiplier":0.6135,"probability":0.041656},{"slot":5,"multiplier":0.7762,"probability":0.091644},{"slot":6,"multiplier":0.9456,"probability":0.15274},{"slot":7,"multiplier":1.128,"probability":0.196381},{"slot":8,"multiplier":1.128,"probability":0.196381},{"slot":9,"multiplier":0.9456,"probability":0.15274},{"slot":10,"multiplier":0.7762,"probability":0.091644},{"slot":11,"multiplier":0.6135,"probability":0.041656},{"slot":12,"multiplier":0.4555,"probability":0.013885},{"slot":13,"multiplier":0.3011,"probability":0.003204},{"slot":14,"multiplier":0.1494,"probability":0.000458},{"slot":15,"multiplier":0.0,"probability":3.1e-05}],
    "16": [{"slot":0,"multiplier":0.0,"probability":1.5e-05},{"slot":1,"multiplier":0.137,"probability":0.000244},{"slot":2,"multiplier":0.2761,"probability":0.001831},{"slot":3,"multiplier":0.4174,"probability":0.008545},{"slot":4,"multiplier":0.5617,"probability":0.027771},{"slot":5,"multiplier":0.7096,"probability":0.06665},{"slot":6,"multiplier":0.8627,"probability":0.122192},{"slot":7,"multiplier":1.024,"probability":0.174561},{"slot":8,"multiplier":1.2102,"probability":0.196381},{"slot":9,"multiplier":1.024,"probability":0.174561},{"slot":10,"multiplier":0.8627,"probability":0.122192},{"slot":11,"multiplier":0.7096,"probability":0.06665},{"slot":12,"multiplier":0.5617,"probability":0.027771},{"slot":13,"multiplier":0.4174,"probability":0.008545},{"slot":14,"multiplier":0.2761,"probability":0.001831},{"slot":15,"multiplier":0.137,"probability":0.000244},{"slot":16,"multiplier":0.0,"probability":1.5e-05}]
  },
  hard: {
    "8": [{"slot":0,"multiplier":0.0,"probability":0.003906},{"slot":1,"multiplier":0.3565,"probability":0.03125},{"slot":2,"multiplier":0.6896,"probability":0.109375},{"slot":3,"multiplier":0.9897,"probability":0.21875},{"slot":4,"multiplier":1.2211,"probability":0.273437},{"slot":5,"multiplier":0.9897,"probability":0.21875},{"slot":6,"multiplier":0.6896,"probability":0.109375},{"slot":7,"multiplier":0.3565,"probability":0.03125},{"slot":8,"multiplier":0.0,"probability":0.003906}],
    "9": [{"slot":0,"multiplier":0.0,"probability":0.001953},{"slot":1,"multiplier":0.3147,"probability":0.017578},{"slot":2,"multiplier":0.6118,"probability":0.070313},{"slot":3,"multiplier":0.8854,"probability":0.164063},{"slot":4,"multiplier":1.1223,"probability":0.246094},{"slot":5,"multiplier":1.1223,"probability":0.246094},{"slot":6,"multiplier":0.8854,"probability":0.164063},{"slot":7,"multiplier":0.6118,"probability":0.070313},{"slot":8,"multiplier":0.3147,"probability":0.017578},{"slot":9,"multiplier":0.0,"probability":0.001953}],
    "10": [{"slot":0,"multiplier":0.0,"probability":0.000977},{"slot":1,"multiplier":0.2767,"probability":0.009766},{"slot":2,"multiplier":0.5398,"probability":0.043945},{"slot":3,"multiplier":0.7857,"probability":0.117187},{"slot":4,"multiplier":1.0072,"probability":0.205078},{"slot":5,"multiplier":1.178,"probability":0.246094},{"slot":6,"multiplier":1.0072,"probability":0.205078},{"slot":7,"multiplier":0.7857,"probability":0.117187},{"slot":8,"multiplier":0.5398,"probability":0.043945},{"slot":9,"multiplier":0.2767,"probability":0.009766},{"slot":10,"multiplier":0.0,"probability":0.000977}],
    "11": [{"slot":0,"multiplier":0.0,"probability":0.000488},{"slot":1,"multiplier":0.2503,"probability":0.005371},{"slot":2,"multiplier":0.4897,"probability":0.026855},{"slot":3,"multiplier":0.7156,"probability":0.080566},{"slot":4,"multiplier":0.9237,"probability":0.161133},{"slot":5,"multiplier":1.1039,"probability":0.225586},{"slot":6,"multiplier":1.1039,"probability":0.225586},{"slot":7,"multiplier":0.9237,"probability":0.161133},{"slot":8,"multiplier":0.7156,"probability":0.080566},{"slot":9,"multiplier":0.4897,"probability":0.026855},{"slot":10,"multiplier":0.2503,"probability":0.005371},{"slot":11,"multiplier":0.0,"probability":0.000488}],
    "12": [{"slot":0,"multiplier":0.0,"probability":0.000244},{"slot":1,"multiplier":0.2257,"probability":0.00293},{"slot":2,"multiplier":0.4424,"probability":0.016113},{"slot":3,"multiplier":0.6485,"probability":0.053711},{"slot":4,"multiplier":0.8411,"probability":0.12085},{"slot":5,"multiplier":1.0147,"probability":0.193359},{"slot":6,"multiplier":1.1484,"probability":0.225586},{"slot":7,"multiplier":1.0147,"probability":0.193359},{"slot":8,"multiplier":0.8411,"probability":0.12085},{"slot":9,"multiplier":0.6485,"probability":0.053711},{"slot":10,"multiplier":0.4424,"probability":0.016113},{"slot":11,"multiplier":0.2257,"probability":0.00293},{"slot":12,"multiplier":0.0,"probability":0.000244}],
    "13": [{"slot":0,"multiplier":0.0,"probability":0.000122},{"slot":1,"multiplier":0.2075,"probability":0.001587},{"slot":2,"multiplier":0.4076,"probability":0.009521},{"slot":3,"multiplier":0.5989,"probability":0.034912},{"slot":4,"multiplier":0.7794,"probability":0.08728},{"slot":5,"multiplier":0.9457,"probability":0.157104},{"slot":6,"multiplier":1.0898,"probability":0.209473},{"slot":7,"multiplier":1.0898,"probability":0.209473},{"slot":8,"multiplier":0.9457,"probability":0.157104},{"slot":9,"multiplier":0.7794,"probability":0.08728},{"slot":10,"multiplier":0.5989,"probability":0.034912},{"slot":11,"multiplier":0.4076,"probability":0.009521},{"slot":12,"multiplier":0.2075,"probability":0.001587},{"slot":13,"multiplier":0.0,"probability":0.000122}],
    "14": [{"slot":0,"multiplier":0.0,"probability":6.1e-05},{"slot":1,"multiplier":0.1903,"probability":0.000854},{"slot":2,"multiplier":0.3743,"probability":0.005554},{"slot":3,"multiplier":0.551,"probability":0.022217},{"slot":4,"multiplier":0.7191,"probability":0.061096},{"slot":5,"multiplier":0.8761,"probability":0.122192},{"slot":6,"multiplier":1.0176,"probability":0.183289},{"slot":7,"multiplier":1.1267,"probability":0.209473},{"slot":8,"multiplier":1.0176,"probability":0.183289},{"slot":9,"multiplier":0.8761,"probability":0.122192},{"slot":10,"multiplier":0.7191,"probability":0.061096},{"slot":11,"multiplier":0.551,"probability":0.022217},{"slot":12,"multiplier":0.3743,"probability":0.005554},{"slot":13,"multiplier":0.1903,"probability":0.000854},{"slot":14,"multiplier":0.0,"probability":6.1e-05}],
    "15": [{"slot":0,"multiplier":0.0,"probability":3.1e-05},{"slot":1,"multiplier":0.177,"probability":0.000458},{"slot":2,"multiplier":0.3487,"probability":0.003204},{"slot":3,"multiplier":0.5142,"probability":0.013885},{"slot":4,"multiplier":0.6724,"probability":0.041656},{"slot":5,"multiplier":0.8218,"probability":0.091644},{"slot":6,"multiplier":0.9594,"probability":0.15274},{"slot":7,"multiplier":1.0785,"probability":0.196381},{"slot":8,"multiplier":1.0785,"probability":0.196381},{"slot":9,"multiplier":0.9594,"probability":0.15274},{"slot":10,"multiplier":0.8218,"probability":0.091644},{"slot":11,"multiplier":0.6724,"probability":0.041656},{"slot":12,"multiplier":0.5142,"probability":0.013885},{"slot":13,"multiplier":0.3487,"probability":0.003204},{"slot":14,"multiplier":0.177,"probability":0.000458},{"slot":15,"multiplier":0.0,"probability":3.1e-05}],
    "16": [{"slot":0,"multiplier":0.0,"probability":1.5e-05},{"slot":1,"multiplier":0.1643,"probability":0.000244},{"slot":2,"multiplier":0.324,"probability":0.001831},{"slot":3,"multiplier":0.4785,"probability":0.008545},{"slot":4,"multiplier":0.6268,"probability":0.027771},{"slot":5,"multiplier":0.7679,"probability":0.06665},{"slot":6,"multiplier":0.8997,"probability":0.122192},{"slot":7,"multiplier":1.0184,"probability":0.174561},{"slot":8,"multiplier":1.11,"probability":0.196381},{"slot":9,"multiplier":1.0184,"probability":0.174561},{"slot":10,"multiplier":0.8997,"probability":0.122192},{"slot":11,"multiplier":0.7679,"probability":0.06665},{"slot":12,"multiplier":0.6268,"probability":0.027771},{"slot":13,"multiplier":0.4785,"probability":0.008545},{"slot":14,"multiplier":0.324,"probability":0.001831},{"slot":15,"multiplier":0.1643,"probability":0.000244},{"slot":16,"multiplier":0.0,"probability":1.5e-05}]
  },
  harder: {
    "8": [{"slot":0,"multiplier":0.0,"probability":0.003906},{"slot":1,"multiplier":0.402,"probability":0.03125},{"slot":2,"multiplier":0.7414,"probability":0.109375},{"slot":3,"multiplier":1.0036,"probability":0.21875},{"slot":4,"multiplier":1.1469,"probability":0.273437},{"slot":5,"multiplier":1.0036,"probability":0.21875},{"slot":6,"multiplier":0.7414,"probability":0.109375},{"slot":7,"multiplier":0.402,"probability":0.03125},{"slot":8,"multiplier":0.0,"probability":0.003906}],
    "9": [{"slot":0,"multiplier":0.0,"probability":0.001953},{"slot":1,"multiplier":0.3547,"probability":0.017578},{"slot":2,"multiplier":0.6617,"probability":0.070313},{"slot":3,"multiplier":0.912,"probability":0.164063},{"slot":4,"multiplier":1.0875,"probability":0.246094},{"slot":5,"multiplier":1.0875,"probability":0.246094},{"slot":6,"multiplier":0.912,"probability":0.164063},{"slot":7,"multiplier":0.6617,"probability":0.070313},{"slot":8,"multiplier":0.3547,"probability":0.017578},{"slot":9,"multiplier":0.0,"probability":0.001953}],
    "10": [{"slot":0,"multiplier":0.0,"probability":0.000977},{"slot":1,"multiplier":0.3156,"probability":0.009766},{"slot":2,"multiplier":0.5938,"probability":0.043945},{"slot":3,"multiplier":0.8288,"probability":0.117187},{"slot":4,"multiplier":1.0102,"probability":0.205078},{"slot":5,"multiplier":1.1095,"probability":0.246094},{"slot":6,"multiplier":1.0102,"probability":0.205078},{"slot":7,"multiplier":0.8288,"probability":0.117187},{"slot":8,"multiplier":0.5938,"probability":0.043945},{"slot":9,"multiplier":0.3156,"probability":0.009766},{"slot":10,"multiplier":0.0,"probability":0.000977}],
    "11": [{"slot":0,"multiplier":0.0,"probability":0.000488},{"slot":1,"multiplier":0.2854,"probability":0.005371},{"slot":2,"multiplier":0.5406,"probability":0.026855},{"slot":3,"multiplier":0.7615,"probability":0.080566},{"slot":4,"multiplier":0.9415,"probability":0.161133},{"slot":5,"multiplier":1.0678,"probability":0.225586},{"slot":6,"multiplier":1.0678,"probability":0.225586},{"slot":7,"multiplier":0.9415,"probability":0.161133},{"slot":8,"multiplier":0.7615,"probability":0.080566},{"slot":9,"multiplier":0.5406,"probability":0.026855},{"slot":10,"multiplier":0.2854,"probability":0.005371},{"slot":11,"multiplier":0.0,"probability":0.000488}],
    "12": [{"slot":0,"multiplier":0.0,"probability":0.000244},{"slot":1,"multiplier":0.2595,"probability":0.00293},{"slot":2,"multiplier":0.4942,"probability":0.016113},{"slot":3,"multiplier":0.7011,"probability":0.053711},{"slot":4,"multiplier":0.8758,"probability":0.12085},{"slot":5,"multiplier":1.0108,"probability":0.193359},{"slot":6,"multiplier":1.0846,"probability":0.225586},{"slot":7,"multiplier":1.0108,"probability":0.193359},{"slot":8,"multiplier":0.8758,"probability":0.12085},{"slot":9,"multiplier":0.7011,"probability":0.053711},{"slot":10,"multiplier":0.4942,"probability":0.016113},{"slot":11,"multiplier":0.2595,"probability":0.00293},{"slot":12,"multiplier":0.0,"probability":0.000244}],
    "13": [{"slot":0,"multiplier":0.0,"probability":0.000122},{"slot":1,"multiplier":0.2386,"probability":0.001587},{"slot":2,"multiplier":0.4563,"probability":0.009521},{"slot":3,"multiplier":0.6511,"probability":0.034912},{"slot":4,"multiplier":0.8196,"probability":0.08728},{"slot":5,"multiplier":0.957,"probability":0.157104},{"slot":6,"multiplier":1.0534,"probability":0.209473},{"slot":7,"multiplier":1.0534,"probability":0.209473},{"slot":8,"multiplier":0.957,"probability":0.157104},{"slot":9,"multiplier":0.8196,"probability":0.08728},{"slot":10,"multiplier":0.6511,"probability":0.034912},{"slot":11,"multiplier":0.4563,"probability":0.009521},{"slot":12,"multiplier":0.2386,"probability":0.001587},{"slot":13,"multiplier":0.0,"probability":0.000122}],
    "14": [{"slot":0,"multiplier":0.0,"probability":6.1e-05},{"slot":1,"multiplier":0.2202,"probability":0.000854},{"slot":2,"multiplier":0.4228,"probability":0.005554},{"slot":3,"multiplier":0.6059,"probability":0.022217},{"slot":4,"multiplier":0.7674,"probability":0.061096},{"slot":5,"multiplier":0.9038,"probability":0.122192},{"slot":6,"multiplier":1.0091,"probability":0.183289},{"slot":7,"multiplier":1.0667,"probability":0.209473},{"slot":8,"multiplier":1.0091,"probability":0.183289},{"slot":9,"multiplier":0.9038,"probability":0.122192},{"slot":10,"multiplier":0.7674,"probability":0.061096},{"slot":11,"multiplier":0.6059,"probability":0.022217},{"slot":12,"multiplier":0.4228,"probability":0.005554},{"slot":13,"multiplier":0.2202,"probability":0.000854},{"slot":14,"multiplier":0.0,"probability":6.1e-05}],
    "15": [{"slot":0,"multiplier":0.0,"probability":3.1e-05},{"slot":1,"multiplier":0.2049,"probability":0.000458},{"slot":2,"multiplier":0.3945,"probability":0.003204},{"slot":3,"multiplier":0.5676,"probability":0.013885},{"slot":4,"multiplier":0.7224,"probability":0.041656},{"slot":5,"multiplier":0.8564,"probability":0.091644},{"slot":6,"multiplier":0.9657,"probability":0.15274},{"slot":7,"multiplier":1.0423,"probability":0.196381},{"slot":8,"multiplier":1.0423,"probability":0.196381},{"slot":9,"multiplier":0.9657,"probability":0.15274},{"slot":10,"multiplier":0.8564,"probability":0.091644},{"slot":11,"multiplier":0.7224,"probability":0.041656},{"slot":12,"multiplier":0.5676,"probability":0.013885},{"slot":13,"multiplier":0.3945,"probability":0.003204},{"slot":14,"multiplier":0.2049,"probability":0.000458},{"slot":15,"multiplier":0.0,"probability":3.1e-05}],
    "16": [{"slot":0,"multiplier":0.0,"probability":1.5e-05},{"slot":1,"multiplier":0.1912,"probability":0.000244},{"slot":2,"multiplier":0.3691,"probability":0.001831},{"slot":3,"multiplier":0.5328,"probability":0.008545},{"slot":4,"multiplier":0.6808,"probability":0.027771},{"slot":5,"multiplier":0.8113,"probability":0.06665},{"slot":6,"multiplier":0.9215,"probability":0.122192},{"slot":7,"multiplier":1.0067,"probability":0.174561},{"slot":8,"multiplier":1.0532,"probability":0.196381},{"slot":9,"multiplier":1.0067,"probability":0.174561},{"slot":10,"multiplier":0.9215,"probability":0.122192},{"slot":11,"multiplier":0.8113,"probability":0.06665},{"slot":12,"multiplier":0.6808,"probability":0.027771},{"slot":13,"multiplier":0.5328,"probability":0.008545},{"slot":14,"multiplier":0.3691,"probability":0.001831},{"slot":15,"multiplier":0.1912,"probability":0.000244},{"slot":16,"multiplier":0.0,"probability":1.5e-05}]
  },
  insane: {
    "8": [{"slot":0,"multiplier":0.0,"probability":0.003906},{"slot":1,"multiplier":0.4438,"probability":0.03125},{"slot":2,"multiplier":0.7827,"probability":0.109375},{"slot":3,"multiplier":1.0075,"probability":0.21875},{"slot":4,"multiplier":1.0981,"probability":0.273437},{"slot":5,"multiplier":1.0075,"probability":0.21875},{"slot":6,"multiplier":0.7827,"probability":0.109375},{"slot":7,"multiplier":0.4438,"probability":0.03125},{"slot":8,"multiplier":0.0,"probability":0.003906}],
    "9": [{"slot":0,"multiplier":0.0,"probability":0.001953},{"slot":1,"multiplier":0.3931,"probability":0.017578},{"slot":2,"multiplier":0.7053,"probability":0.070313},{"slot":3,"multiplier":0.9308,"probability":0.164063},{"slot":4,"multiplier":1.0597,"probability":0.246094},{"slot":5,"multiplier":1.0597,"probability":0.246094},{"slot":6,"multiplier":0.9308,"probability":0.164063},{"slot":7,"multiplier":0.7053,"probability":0.070313},{"slot":8,"multiplier":0.3931,"probability":0.017578},{"slot":9,"multiplier":0.0,"probability":0.001953}],
    "10": [{"slot":0,"multiplier":0.0,"probability":0.000977},{"slot":1,"multiplier":0.3524,"probability":0.009766},{"slot":2,"multiplier":0.6406,"probability":0.043945},{"slot":3,"multiplier":0.8607,"probability":0.117187},{"slot":4,"multiplier":1.0067,"probability":0.205078},{"slot":5,"multiplier":1.0655,"probability":0.246094},{"slot":6,"multiplier":1.0067,"probability":0.205078},{"slot":7,"multiplier":0.8607,"probability":0.117187},{"slot":8,"multiplier":0.6406,"probability":0.043945},{"slot":9,"multiplier":0.3524,"probability":0.009766},{"slot":10,"multiplier":0.0,"probability":0.000977}],
    "11": [{"slot":0,"multiplier":0.0,"probability":0.000488},{"slot":1,"multiplier":0.3196,"probability":0.005371},{"slot":2,"multiplier":0.5869,"probability":0.026855},{"slot":3,"multiplier":0.7992,"probability":0.080566},{"slot":4,"multiplier":0.9525,"probability":0.161133},{"slot":5,"multiplier":1.0402,"probability":0.225586},{"slot":6,"multiplier":1.0402,"probability":0.225586},{"slot":7,"multiplier":0.9525,"probability":0.161133},{"slot":8,"multiplier":0.7992,"probability":0.080566},{"slot":9,"multiplier":0.5869,"probability":0.026855},{"slot":10,"multiplier":0.3196,"probability":0.005371},{"slot":11,"multiplier":0.0,"probability":0.000488}],
    "12": [{"slot":0,"multiplier":0.0,"probability":0.000244},{"slot":1,"multiplier":0.2922,"probability":0.00293},{"slot":2,"multiplier":0.541,"probability":0.016113},{"slot":3,"multiplier":0.7444,"probability":0.053711},{"slot":4,"multiplier":0.8998,"probability":0.12085},{"slot":5,"multiplier":1.0028,"probability":0.193359},{"slot":6,"multiplier":1.0443,"probability":0.225586},{"slot":7,"multiplier":1.0028,"probability":0.193359},{"slot":8,"multiplier":0.8998,"probability":0.12085},{"slot":9,"multiplier":0.7444,"probability":0.053711},{"slot":10,"multiplier":0.541,"probability":0.016113},{"slot":11,"multiplier":0.2922,"probability":0.00293},{"slot":12,"multiplier":0.0,"probability":0.000244}],
    "13": [{"slot":0,"multiplier":0.0,"probability":0.000122},{"slot":1,"multiplier":0.2692,"probability":0.001587},{"slot":2,"multiplier":0.5018,"probability":0.009521},{"slot":3,"multiplier":0.6964,"probability":0.034912},{"slot":4,"multiplier":0.8509,"probability":0.08728},{"slot":5,"multiplier":0.9626,"probability":0.157104},{"slot":6,"multiplier":1.0263,"probability":0.209473},{"slot":7,"multiplier":1.0263,"probability":0.209473},{"slot":8,"multiplier":0.9626,"probability":0.157104},{"slot":9,"multiplier":0.8509,"probability":0.08728},{"slot":10,"multiplier":0.6964,"probability":0.034912},{"slot":11,"multiplier":0.5018,"probability":0.009521},{"slot":12,"multiplier":0.2692,"probability":0.001587},{"slot":13,"multiplier":0.0,"probability":0.000122}],
    "14": [{"slot":0,"multiplier":0.0,"probability":6.1e-05},{"slot":1,"multiplier":0.2495,"probability":0.000854},{"slot":2,"multiplier":0.4677,"probability":0.005554},{"slot":3,"multiplier":0.6535,"probability":0.022217},{"slot":4,"multiplier":0.8055,"probability":0.061096},{"slot":5,"multiplier":0.9216,"probability":0.122192},{"slot":6,"multiplier":0.9985,"probability":0.183289},{"slot":7,"multiplier":1.0295,"probability":0.209473},{"slot":8,"multiplier":0.9985,"probability":0.183289},{"slot":9,"multiplier":0.9216,"probability":0.122192},{"slot":10,"multiplier":0.8055,"probability":0.061096},{"slot":11,"multiplier":0.6535,"probability":0.022217},{"slot":12,"multiplier":0.4677,"probability":0.005554},{"slot":13,"multiplier":0.2495,"probability":0.000854},{"slot":14,"multiplier":0.0,"probability":6.1e-05}],
    "15": [{"slot":0,"multiplier":0.0,"probability":3.1e-05},{"slot":1,"multiplier":0.2325,"probability":0.000458},{"slot":2,"multiplier":0.438,"probability":0.003204},{"slot":3,"multiplier":0.6156,"probability":0.013885},{"slot":4,"multiplier":0.7641,"probability":0.041656},{"slot":5,"multiplier":0.8821,"probability":0.091644},{"slot":6,"multiplier":0.9673,"probability":0.15274},{"slot":7,"multiplier":1.016,"probability":0.196381},{"slot":8,"multiplier":1.016,"probability":0.196381},{"slot":9,"multiplier":0.9673,"probability":0.15274},{"slot":10,"multiplier":0.8821,"probability":0.091644},{"slot":11,"multiplier":0.7641,"probability":0.041656},{"slot":12,"multiplier":0.6156,"probability":0.013885},{"slot":13,"multiplier":0.438,"probability":0.003204},{"slot":14,"multiplier":0.2325,"probability":0.000458},{"slot":15,"multiplier":0.0,"probability":3.1e-05}],
    "16": [{"slot":0,"multiplier":0.0,"probability":1.5e-05},{"slot":1,"multiplier":0.2176,"probability":0.000244},{"slot":2,"multiplier":0.4117,"probability":0.001831},{"slot":3,"multiplier":0.5815,"probability":0.008545},{"slot":4,"multiplier":0.726,"probability":0.027771},{"slot":5,"multiplier":0.8443,"probability":0.06665},{"slot":6,"multiplier":0.9345,"probability":0.122192},{"slot":7,"multiplier":0.9944,"probability":0.174561},{"slot":8,"multiplier":1.0185,"probability":0.196381},{"slot":9,"multiplier":0.9944,"probability":0.174561},{"slot":10,"multiplier":0.9345,"probability":0.122192},{"slot":11,"multiplier":0.8443,"probability":0.06665},{"slot":12,"multiplier":0.726,"probability":0.027771},{"slot":13,"multiplier":0.5815,"probability":0.008545},{"slot":14,"multiplier":0.4117,"probability":0.001831},{"slot":15,"multiplier":0.2176,"probability":0.000244},{"slot":16,"multiplier":0.0,"probability":1.5e-05}]
  },
  extreme: {
    "8": [{"slot":0,"multiplier":0.0,"probability":0.003906},{"slot":1,"multiplier":0.4949,"probability":0.03125},{"slot":2,"multiplier":0.8257,"probability":0.109375},{"slot":3,"multiplier":1.0054,"probability":0.21875},{"slot":4,"multiplier":1.0554,"probability":0.273437},{"slot":5,"multiplier":1.0054,"probability":0.21875},{"slot":6,"multiplier":0.8257,"probability":0.109375},{"slot":7,"multiplier":0.4949,"probability":0.03125},{"slot":8,"multiplier":0.0,"probability":0.003906}],
    "9": [{"slot":0,"multiplier":0.0,"probability":0.001953},{"slot":1,"multiplier":0.4416,"probability":0.017578},{"slot":2,"multiplier":0.7544,"probability":0.070313},{"slot":3,"multiplier":0.947,"probability":0.164063},{"slot":4,"multiplier":1.0314,"probability":0.246094},{"slot":5,"multiplier":1.0314,"probability":0.246094},{"slot":6,"multiplier":0.947,"probability":0.164063},{"slot":7,"multiplier":0.7544,"probability":0.070313},{"slot":8,"multiplier":0.4416,"probability":0.017578},{"slot":9,"multiplier":0.0,"probability":0.001953}],
    "10": [{"slot":0,"multiplier":0.0,"probability":0.000977},{"slot":1,"multiplier":0.3988,"probability":0.009766},{"slot":2,"multiplier":0.6938,"probability":0.043945},{"slot":3,"multiplier":0.891,"probability":0.117187},{"slot":4,"multiplier":0.9982,"probability":0.205078},{"slot":5,"multiplier":1.028,"probability":0.246094},{"slot":6,"multiplier":0.9982,"probability":0.205078},{"slot":7,"multiplier":0.891,"probability":0.117187},{"slot":8,"multiplier":0.6938,"probability":0.043945},{"slot":9,"multiplier":0.3988,"probability":0.009766},{"slot":10,"multiplier":0.0,"probability":0.000977}],
    "11": [{"slot":0,"multiplier":0.0,"probability":0.000488},{"slot":1,"multiplier":0.3635,"probability":0.005371},{"slot":2,"multiplier":0.6416,"probability":0.026855},{"slot":3,"multiplier":0.8387,"probability":0.080566},{"slot":4,"multiplier":0.96,"probability":0.161133},{"slot":5,"multiplier":1.0132,"probability":0.225586},{"slot":6,"multiplier":1.0132,"probability":0.225586},{"slot":7,"multiplier":0.96,"probability":0.161133},{"slot":8,"multiplier":0.8387,"probability":0.080566},{"slot":9,"multiplier":0.6416,"probability":0.026855},{"slot":10,"multiplier":0.3635,"probability":0.005371},{"slot":11,"multiplier":0.0,"probability":0.000488}],
    "12": [{"slot":0,"multiplier":0.0,"probability":0.000244},{"slot":1,"multiplier":0.334,"probability":0.00293},{"slot":2,"multiplier":0.5966,"probability":0.016113},{"slot":3,"multiplier":0.7908,"probability":0.053711},{"slot":4,"multiplier":0.9207,"probability":0.12085},{"slot":5,"multiplier":0.9912,"probability":0.193359},{"slot":6,"multiplier":1.0108,"probability":0.225586},{"slot":7,"multiplier":0.9912,"probability":0.193359},{"slot":8,"multiplier":0.9207,"probability":0.12085},{"slot":9,"multiplier":0.7908,"probability":0.053711},{"slot":10,"multiplier":0.5966,"probability":0.016113},{"slot":11,"multiplier":0.334,"probability":0.00293},{"slot":12,"multiplier":0.0,"probability":0.000244}],
    "13": [{"slot":0,"multiplier":0.0,"probability":0.000122},{"slot":1,"multiplier":0.3089,"probability":0.001587},{"slot":2,"multiplier":0.5571,"probability":0.009521},{"slot":3,"multiplier":0.7471,"probability":0.034912},{"slot":4,"multiplier":0.8817,"probability":0.08728},{"slot":5,"multiplier":0.9645,"probability":0.157104},{"slot":6,"multiplier":1.0008,"probability":0.209473},{"slot":7,"multiplier":1.0008,"probability":0.209473},{"slot":8,"multiplier":0.9645,"probability":0.157104},{"slot":9,"multiplier":0.8817,"probability":0.08728},{"slot":10,"multiplier":0.7471,"probability":0.034912},{"slot":11,"multiplier":0.5571,"probability":0.009521},{"slot":12,"multiplier":0.3089,"probability":0.001587},{"slot":13,"multiplier":0.0,"probability":0.000122}],
    "14": [{"slot":0,"multiplier":0.0,"probability":6.1e-05},{"slot":1,"multiplier":0.2874,"probability":0.000854},{"slot":2,"multiplier":0.5225,"probability":0.005554},{"slot":3,"multiplier":0.7074,"probability":0.022217},{"slot":4,"multiplier":0.8442,"probability":0.061096},{"slot":5,"multiplier":0.9356,"probability":0.122192},{"slot":6,"multiplier":0.9853,"probability":0.183289},{"slot":7,"multiplier":0.9991,"probability":0.209473},{"slot":8,"multiplier":0.9853,"probability":0.183289},{"slot":9,"multiplier":0.9356,"probability":0.122192},{"slot":10,"multiplier":0.8442,"probability":0.061096},{"slot":11,"multiplier":0.7074,"probability":0.022217},{"slot":12,"multiplier":0.5225,"probability":0.005554},{"slot":13,"multiplier":0.2874,"probability":0.000854},{"slot":14,"multiplier":0.0,"probability":6.1e-05}],
    "15": [{"slot":0,"multiplier":0.0,"probability":3.1e-05},{"slot":1,"multiplier":0.2686,"probability":0.000458},{"slot":2,"multiplier":0.4918,"probability":0.003204},{"slot":3,"multiplier":0.6712,"probability":0.013885},{"slot":4,"multiplier":0.8085,"probability":0.041656},{"slot":5,"multiplier":0.9058,"probability":0.091644},{"slot":6,"multiplier":0.9657,"probability":0.15274},{"slot":7,"multiplier":0.9919,"probability":0.196381},{"slot":8,"multiplier":0.9919,"probability":0.196381},{"slot":9,"multiplier":0.9657,"probability":0.15274},{"slot":10,"multiplier":0.9058,"probability":0.091644},{"slot":11,"multiplier":0.8085,"probability":0.041656},{"slot":12,"multiplier":0.6712,"probability":0.013885},{"slot":13,"multiplier":0.4918,"probability":0.003204},{"slot":14,"multiplier":0.2686,"probability":0.000458},{"slot":15,"multiplier":0.0,"probability":3.1e-05}],
    "16": [{"slot":0,"multiplier":0.0,"probability":1.5e-05},{"slot":1,"multiplier":0.2522,"probability":0.000244},{"slot":2,"multiplier":0.4645,"probability":0.001831},{"slot":3,"multiplier":0.6384,"probability":0.008545},{"slot":4,"multiplier":0.775,"probability":0.027771},{"slot":5,"multiplier":0.8761,"probability":0.06665},{"slot":6,"multiplier":0.9437,"probability":0.122192},{"slot":7,"multiplier":0.9804,"probability":0.174561},{"slot":8,"multiplier":0.9906,"probability":0.196381},{"slot":9,"multiplier":0.9804,"probability":0.174561},{"slot":10,"multiplier":0.9437,"probability":0.122192},{"slot":11,"multiplier":0.8761,"probability":0.06665},{"slot":12,"multiplier":0.775,"probability":0.027771},{"slot":13,"multiplier":0.6384,"probability":0.008545},{"slot":14,"multiplier":0.4645,"probability":0.001831},{"slot":15,"multiplier":0.2522,"probability":0.000244},{"slot":16,"multiplier":0.0,"probability":1.5e-05}]
  }
};

// ---------- helpers (difficulty mapping, sampling, numbers) ----------
const DIFF_KEYS = ["easy", "med", "hard", "harder", "insane", "extreme"];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const i32   = (x) => (Number.isFinite(Number(x)) ? Math.floor(Number(x)) : 0);

function getTable(rows, diffIdx) {
  const key = DIFF_KEYS[diffIdx] || DIFF_KEYS[0];
  const table = PLINKO_TABLE[key]?.[String(rows)];
  if (!table) throw new Error(`No plinko table for diff=${key}, rows=${rows}`);
  // normalize probabilities to sum 1
  const ps = table.map((e) => Number(e.probability));
  const sum = ps.reduce((a, b) => a + b, 0);
  const norm = sum > 0 ? 1 / sum : 1;
  return {
    multipliers: table.map((e) => Number(e.multiplier)),
    probabilities: ps.map((p) => p * norm),
  };
}

function chooseIndex(probs) {
  const r = Math.random();
  let acc = 0;
  for (let i = 0; i < probs.length; i++) {
    acc += probs[i];
    if (r <= acc) return i;
  }
  return probs.length - 1;
}

// ---------- state ----------
const rounds = new Map();

// ---------- small number helpers ----------
const u64le = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const i64le = (n) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(n)); return b; };
const u32le = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE((n>>>0)); return b; };

// ---------- parse pending ----------
function parsePendingAccountData(data) {
  const base = 8;
  const minLen = base + 32 + 8 + 2 + 1 + 1 + 8 + 8 + 1;
  if (!data || data.length < minLen) throw new Error("pending account data too short");
  const player = data.slice(base, base + 32);
  const unit_amount = Number(data.readBigUInt64LE(base + 32));
  const balls = data.readUInt16LE(base + 32 + 8);
  const rows  = data.readUInt8(base + 32 + 8 + 2);
  const difficulty = data.readUInt8(base + 32 + 8 + 2 + 1);
  const nonce = Number(data.readBigUInt64LE(base + 32 + 8 + 2 + 1 + 1));
  const expiry_unix = Number(data.readBigInt64LE(base + 32 + 8 + 2 + 1 + 1 + 8));
  return { player, unit_amount, balls, rows, difficulty, nonce, expiry_unix };
}

// ---------- builders ----------
async function buildLockTx({ playerPk, unitLamports, balls, rows, diff, nonce, expiryUnix }) {
  const vault = pdaVault();
  const pending = pdaPending(playerPk, nonce);

  const ix = { programId: PROGRAM_ID, keys: [
    { pubkey: playerPk, isSigner: true,  isWritable: true },
    { pubkey: vault,    isSigner: false, isWritable: true },
    { pubkey: pending,  isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ], data: encLock({ unitAmount: unitLamports, balls, rows, difficulty: diff, nonce, expiryUnix }) };

  const cu = ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 });
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({ payerKey: playerPk, recentBlockhash: blockhash, instructions: [cu, ix] }).compileToV0Message();
  const vtx = new VersionedTransaction(msg);
  const sim = await connection.simulateTransaction(vtx, { sigVerify: false }).catch(()=>null);
  if (sim?.value?.err) {
    const logs = (sim.value.logs || []).join("\n");
    const abiErr = logs.includes("InstructionFallbackNotFound") || logs.includes("Fallback functions are not supported");
    if (abiErr) throw new Error(`LOCK discriminator mismatch (${LOCK_IX})\n${logs}`);
  }
  return { txBase64: Buffer.from(vtx.serialize()).toString("base64"), pending };
}

async function sendResolveStrict({ playerPk, pending, payoutLamportsNet, nonce, expiryUnix }) {
  const vault    = pdaVault();
  const adminPda = pdaAdmin();
  const feePayer = await getServerKeypair();

  const [vaultAcc, adminAcc] = await Promise.all([
    connection.getAccountInfo(vault),
    connection.getAccountInfo(adminPda),
  ]);
  if (!vaultAcc)  throw new Error("VAULT_NOT_FOUND");
  if (!adminAcc)  throw new Error("ADMIN_CONFIG_NOT_FOUND");

  const pendingAi = await connection.getAccountInfo(pending);
  if (!pendingAi) throw new Error("PENDING_NOT_FOUND_AFTER_WAIT");

  const pendingParsed = parsePendingAccountData(pendingAi.data);

  const msgBuf = Buffer.concat([
    Buffer.from("PLINKO_V1"),
    PROGRAM_ID.toBuffer(),
    vault.toBuffer(),
    playerPk.toBuffer(),
    pending.toBuffer(),
    u64le(pendingParsed.unit_amount),
    u32le(pendingParsed.balls),
    Buffer.from([pendingParsed.rows & 0xff]),
    Buffer.from([pendingParsed.difficulty & 0xff]),
    u64le(payoutLamportsNet),
    u64le(pendingParsed.nonce),
    i64le(pendingParsed.expiry_unix),
  ]);

  const edSig = await signMessageEd25519(msgBuf);
  const edIx  = Ed25519Program.createInstructionWithPublicKey({ publicKey: ADMIN_PK, message: msgBuf, signature: edSig });

  const cu = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });
  const edIndex = 1;

  const data = encResolve({ checksum: (Number(nonce) % 251) + 1, payout: Number(payoutLamportsNet), edIndex });
  const keys = [
    { pubkey: playerPk,                isSigner: false, isWritable: true  },
    { pubkey: vault,                   isSigner: false, isWritable: true  },
    { pubkey: adminPda,                isSigner: false, isWritable: false },
    { pubkey: pending,                 isSigner: false, isWritable: true  },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_INSTR,            isSigner: false, isWritable: false },
  ];
  const ixResolve = { programId: PROGRAM_ID, keys, data };

  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({ payerKey: feePayer.publicKey, recentBlockhash: blockhash, instructions: [cu, edIx, ixResolve] }).compileToV0Message();
  const vtx = new VersionedTransaction(msg);

  try { await connection.simulateTransaction(vtx, { sigVerify: false }); } catch {}

  vtx.sign([feePayer]);
  const sig = await connection.sendRawTransaction(vtx.serialize(), { skipPreflight: true, maxRetries: 5 });
  await connection.confirmTransaction(sig, "confirmed");
  return sig;
}

// ---------- WS ----------
function attachPlinko(io) {
  console.log("Plinko WS (table-driven) using STRICT resolver + DB gating/persistence");

  io.on("connection", (socket) => {
    socket.on("register", ({ player }) => { socket.data.player = String(player || "guest"); });

    // Step 1: client asks to build the lock tx
    socket.on("plinko:prepare_lock", async (p) => {
      try {
        const player = String(p?.player || "");
        if (!player) return socket.emit("plinko:error", { code: "NO_PLAYER", message: "player required" });

        // admin gate + min/max
        const cfg = await DB.getGameConfig?.("plinko");
        if (cfg && (!cfg.enabled || !cfg.running)) {
          return socket.emit("plinko:error", { code: "DISABLED", message: "Plinko disabled by admin" });
        }
        const min = BigInt(cfg?.min_bet_lamports ?? 50000);
        const max = BigInt(cfg?.max_bet_lamports ?? 5_000_000_000n);

        const unitLamports = BigInt(i32(p.unitLamports ?? p.betPerLamports));
        const balls = clamp(i32(p.balls), 1, 100);
        const rows  = clamp(i32(p.rows),  8, 16);
        const diff  = clamp(i32(p.diff ?? p.riskIndex), 0, 5);

        if (!(unitLamports > 0n)) return socket.emit("plinko:error", { code: "BAD_BET", message: "unitLamports must be > 0" });
        if (unitLamports < min || unitLamports > max) {
          return socket.emit("plinko:error", { code: "BET_RANGE", message: "Bet outside allowed range" });
        }

        // derive multipliers & probabilities from fixed tables
        const { multipliers, probabilities } = getTable(rows, diff);

        const playerPk = new PublicKey(player);
        const nonce = Date.now();
        const expiryUnix = Math.floor(Date.now() / 1000) + Number(process.env.NONCE_TTL_SECONDS || 300);

        const built = await buildLockTx({ playerPk, unitLamports, balls, rows, diff, nonce, expiryUnix });

        // persist a round context
        rounds.set(nonce, {
          playerPk,
          unitLamports,
          balls,
          rows,
          diff,
          probabilities,
          multipliers,
          results: [],
          pending: pdaPending(playerPk, nonce).toBase58(),
          expiryUnix,
        });

        socket.emit("plinko:lock_tx", {
          nonce: String(nonce),
          expiryUnix,
          transactionBase64: built.txBase64,
          multipliers,
          probabilities,
        });
      } catch (e) {
        console.error("plinko:prepare_lock error:", e);
        socket.emit("plinko:error", { code: "PREPARE_FAIL", message: e.message || String(e) });
      }
    });

    // Step 2: frontend notifies that lock tx is confirmed; server simulates drops + resolves on-chain (server fee payer)
    socket.on("plinko:lock_confirmed", async ({ nonce }) => {
      try {
        const ctx = rounds.get(Number(nonce));
        if (!ctx) return socket.emit("plinko:error", { code: "NOT_FOUND", message: "no round" });

        for (let i = 0; i < ctx.balls; i++) {
          const idx = chooseIndex(ctx.probabilities);
          ctx.results.push(idx);
          socket.emit("plinko:tick", { nonce: String(nonce), ballIndex: i, slotIndex: idx });
          await new Promise((r) => setTimeout(r, 60));
        }

        const perBall = ctx.unitLamports;
        let gross = 0n;
        for (const idx of ctx.results) {
          const mul = ctx.multipliers[idx] || 0.0;
          // 4 dp precision on multiplier -> integer lamports
          const p   = (perBall * BigInt(Math.floor(mul * 10000))) / 10000n;
          gross += p;
        }
        const stake = perBall * BigInt(ctx.balls);
        const net   = gross > stake ? gross - stake : 0n;

        const payoutLamportsNet = net;

        const txSig = await sendResolveStrict({
          playerPk: ctx.playerPk,
          pending:  new PublicKey(ctx.pending),
          payoutLamportsNet,
          nonce: Number(nonce),
          expiryUnix: ctx.expiryUnix,
        });

        // persist + activity
        try {
          await DB.recordGameRound?.({
            game_key: "plinko",
            player: ctx.playerPk.toBase58(),
            nonce: Number(nonce),
            stake_lamports: Number(stake),
            payout_lamports: Number(net),
            result_json: { rows: ctx.rows, balls: ctx.balls, results: ctx.results, multipliers: ctx.multipliers },
          });
          if (net > 0n) {
            await DB.recordActivity?.({
              user: ctx.playerPk.toBase58(),
              action: "Plinko win",
              amount: (Number(net)/1e9).toFixed(4),
            });
          }
        } catch {}

        socket.emit("plinko:resolved", {
          nonce: String(nonce),
          results: ctx.results,
          multipliers: ctx.multipliers,
          payoutLamports: Number(payoutLamportsNet), // net
          grossLamports: Number(gross),
          netLamports: Number(net),
          stakeLamports: Number(stake),
          tx: txSig,
        });
      } catch (e) {
        console.error("plinko:lock_confirmed error:", e);
        const msg = (e?.transactionLogs && Array.isArray(e.transactionLogs))
          ? e.transactionLogs.join("\n")
          : (e?.message || String(e));
        socket.emit("plinko:error", { code: "ROUND_FAIL", message: msg });
      }
    });
  });
}

module.exports = { attachPlinko };
