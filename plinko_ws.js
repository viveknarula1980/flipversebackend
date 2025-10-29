// backend/plinko_ws.js
// Provably-Fair Plinko (WS) with promo/fake balance support + REST history API
// - Saves fairness data to DB (server_seed_hash, server_seed hex, client_seed, first_hmac_hex).
// - REST: GET /plinko/resolved?wallet=...&limit=...&cursor=...
//
// Requires:
//   - ./promo_balance.js
//   - ./solana*, ./signer
//   - ./bonus_guard (optional, same API as Dice/Coinflip/Crash)

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
try { ({ precheckOrThrow } = require("./bonus_guard")); } catch {}

// ---------- solana helpers ----------
const {
  connection,
  PROGRAM_ID,
  deriveVaultPda,
  deriveUserVaultPda,
  deriveAdminPda,
  derivePendingPlinkoPda,
  buildEd25519VerifyIx,
} = require("./solana");

const { ixPlinkoLock, ixPlinkoResolve } = require("./solana_anchor_ix");
const { ADMIN_PK, signMessageEd25519, getServerKeypair } = require("./signer");

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
// ^ If you trimmed tables above for brevity, keep the full tables from your existing file.

const DIFF_KEYS = ["easy", "med", "hard", "harder", "insane", "extreme"];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const i32   = (x) => (Number.isFinite(Number(x)) ? Math.floor(Number(x)) : 0);

// ---------- Table helpers ----------
function getTable(rows, diffIdx) {
  const key = DIFF_KEYS[diffIdx] || DIFF_KEYS[0];
  const table = PLINKO_TABLE[key]?.[String(rows)];
  if (!table) throw new Error(`No plinko table for diff=${key}, rows=${rows}`);
  const ps = table.map((e) => Number(e.probability));
  const sum = ps.reduce((a, b) => a + b, 0);
  const norm = sum > 0 ? 1 / sum : 1;
  return {
    multipliers: table.map((e) => Number(e.multiplier)),
    probabilities: ps.map((p) => p * norm),
  };
}

// ---------- Provably-fair RNG (HMAC-SHA256 stream) ----------
function sha256Hex(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}
function makeRng({ serverSeed, clientSeed, nonce }) {
  let counter = 0;
  let pool = Buffer.alloc(0);
  function refill() {
    const h = crypto
      .createHmac("sha256", serverSeed)
      .update(String(clientSeed || ""))
      .update(Buffer.from(String(nonce)))
      .update(Buffer.from([0,0,0,0].map((_, i) => (counter >> (8 * (3 - i))) & 0xff))) // BE u32
      .digest();
    counter++;
    pool = Buffer.concat([pool, h]);
  }
  function nextU32() { if (pool.length < 4) refill(); const x = pool.readUInt32BE(0); pool = pool.slice(4); return x >>> 0; }
  function nextFloat() { return nextU32() / 2 ** 32; }
  function nextInt(min, max) { const span = max - min + 1; return min + Math.floor(nextFloat() * span); }
  return { nextU32, nextFloat, nextInt };
}

// choose index by probabilities using rng.nextFloat
function chooseIndexWithRng(rng, probs) {
  const r = rng.nextFloat();
  let acc = 0;
  for (let i = 0; i < probs.length; i++) {
    acc += probs[i];
    if (r <= acc) return i;
  }
  return probs.length - 1;
}

const rounds = new Map();
const u64le = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const i64le = (n) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(n)); return b; };

// ---------- helpers ----------
function makeFakeTxSig(prefix, nonce) { return `${prefix}-${String(nonce)}`; }
function grossFromMultiplier(unitLamports, mul) {
  return (BigInt(unitLamports) * BigInt(Math.floor(mul * 10000))) / 10000n; // 4 dp
}

// ---------- DB schema / history API ----------
async function ensurePlinkoSchema() {
  if (!DB?.pool) return;
  await DB.pool.query(`
    CREATE TABLE IF NOT EXISTS plinko_rounds (
      id BIGSERIAL PRIMARY KEY,
      nonce BIGINT NOT NULL,
      player TEXT NOT NULL,
      unit_lamports BIGINT NOT NULL,
      balls INT NOT NULL,
      rows INT NOT NULL,
      diff INT NOT NULL,
      server_seed_hash TEXT,
      server_seed TEXT,            -- hex string
      first_hmac_hex TEXT,         -- HMAC(serverSeed, clientSeed + nonce + u32_be(0))
      client_seed TEXT NOT NULL DEFAULT '',
      results_json JSONB,
      payout BIGINT NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'locked',
      lock_sig TEXT,
      resolve_sig TEXT,
      pending TEXT,
      expiry_unix BIGINT,
      created_at timestamptz NOT NULL DEFAULT now(),
      resolved_at timestamptz,
      UNIQUE (nonce, player)
    );
    ALTER TABLE plinko_rounds ALTER COLUMN payout SET DEFAULT 0;
    ALTER TABLE plinko_rounds ALTER COLUMN status SET DEFAULT 'locked';
    CREATE INDEX IF NOT EXISTS idx_plinko_player_status_id ON plinko_rounds (player, status, id DESC);
    CREATE INDEX IF NOT EXISTS idx_plinko_nonce ON plinko_rounds (nonce);
  `);
}

async function dbListPlinkoResolvedByWallet(wallet, { limit = 50, cursor = null } = {}) {
  if (!DB?.pool) return { items: [], nextCursor: null };
  const L = Math.max(1, Math.min(200, Number(limit) || 50));
  const baseWhere = `status='resolved' AND player = $1`;

  const selectCols = `
    id::text,
    nonce::text,
    player,
    unit_lamports::text,
    balls,
    rows,
    diff,
    payout::text,
    lock_sig,
    resolve_sig,
    server_seed_hash,
    server_seed AS server_seed_hex,
    first_hmac_hex,
    client_seed,
    results_json,
    status,
    expiry_unix,
    created_at,
    resolved_at
  `;

  if (cursor) {
    const { rows } = await DB.pool.query(
      `SELECT ${selectCols}
         FROM plinko_rounds
        WHERE ${baseWhere} AND id < $2
        ORDER BY id DESC
        LIMIT $3`,
      [String(wallet), Number(cursor), L]
    );
    const nextCursor = rows.length ? rows[rows.length - 1].id : null;
    return { items: rows, nextCursor };
  } else {
    const { rows } = await DB.pool.query(
      `SELECT ${selectCols}
         FROM plinko_rounds
        WHERE ${baseWhere}
        ORDER BY id DESC
        LIMIT $2`,
      [String(wallet), L]
    );
    const nextCursor = rows.length ? rows[rows.length - 1].id : null;
    return { items: rows, nextCursor };
  }
}

function attachPlinkoRoutes(app) {
  if (!app || !app.use) return;
  const express = require("express");
  const router = express.Router();

  router.get("/resolved", async (req, res) => {
    try {
      const wallet = String(req.query.wallet || "");
      const limit = req.query.limit;
      const cursor = req.query.cursor;
      if (!wallet || wallet.length < 32) return res.status(400).json({ error: "bad wallet" });

      await ensurePlinkoSchema().catch(() => {});
      const out = await dbListPlinkoResolvedByWallet(wallet, { limit, cursor });
      out.verify = {
        algorithm: "RNG stream via HMAC_SHA256(serverSeed, clientSeed + nonce + u32_be(counter)); choose slot per ball using cumulative probabilities for (rows,difficulty). first_hmac_hex is counter=0.",
        fields: {
          server_seed_hash: "sha256(serverSeed)",
          server_seed_hex: "Reveal of committed seed",
          client_seed: "User-chosen/optional",
          first_hmac_hex: "HMAC(serverSeed, clientSeed + nonce + 0x00000000)",
          results_json: "{ rows, balls, results[ballIndex]=slotIndex }",
        },
      };
      res.json(out);
    } catch (e) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  app.use("/plinko", router);
}

// ---------- WS ----------
function attachPlinko(io, app /* optional */) {
  ensurePlinkoSchema().catch((e) => console.warn("[ensurePlinkoSchema] warn:", e?.message || e));
  try { attachPlinkoRoutes(app); } catch {}

  console.log("Plinko WS (promo-aware; real on-chain or fake off-chain)");

  io.on("connection", (socket) => {
    socket.on("register", ({ player }) => { socket.data.player = String(player || "guest"); });

    // ---- Prepare lock (server signs; wallet not required here) ----
    socket.on("plinko:prepare_lock", async (p) => {
      try {
        const player = String(p?.player || "");
        if (!player) return socket.emit("plinko:error", { code: "NO_PLAYER", message: "player required" });

        // config gates
        const cfg = await DB.getGameConfig?.("plinko").catch(() => null);
        if (cfg && (!cfg.enabled || !cfg.running)) {
          return socket.emit("plinko:error", { code: "DISABLED", message: "Plinko disabled by admin" });
        }
        const min = BigInt(cfg?.min_bet_lamports ?? 50_000n);
        const max = BigInt(cfg?.max_bet_lamports ?? 5_000_000_000n);

        const unitLamports = BigInt(i32(p.unitLamports ?? p.betPerLamports));
        const balls = clamp(i32(p.balls), 1, 100);
        const rows  = clamp(i32(p.rows),  8, 16);
        const diff  = clamp(i32(p.diff ?? p.riskIndex), 0, 5);
        const clientSeed = String(p.clientSeed || "");

        if (!(unitLamports > 0n)) return socket.emit("plinko:error", { code: "BAD_BET", message: "unitLamports must be > 0" });
        if (unitLamports < min || unitLamports > max)
          return socket.emit("plinko:error", { code: "BET_RANGE", message: "Bet outside allowed range" });

        const total = unitLamports * BigInt(balls);
        if (total > max) return socket.emit("plinko:error", { code: "BET_RANGE", message: "Total exceeds max" });

        // derive multipliers & probabilities
        const { multipliers, probabilities } = getTable(rows, diff);

        const playerPk = new PublicKey(player);
        const userVault = deriveUserVaultPda(playerPk);
        const houseVault = deriveVaultPda();
        const nonce = Date.now();
        const expiryUnix = Math.floor(Date.now() / 1000) + Number(process.env.NONCE_TTL_SECONDS || 300);
        const pendingPlinko = derivePendingPlinkoPda(playerPk, nonce);

        // (optional) bonus/abuse checks
        await precheckOrThrow({ userWallet: player, stakeLamports: String(total), gameKey: "plinko" }).catch(() => {});

        // Provably-fair commitment (always)
        const serverSeed = crypto.randomBytes(32);
        const serverSeedHash = sha256Hex(serverSeed);
        // Store the *first block* of the RNG stream (counter=0) for easy external verification
        const firstHmacHex = crypto
          .createHmac("sha256", serverSeed)
          .update(String(clientSeed || ""))
          .update(Buffer.from(String(nonce)))
          .update(Buffer.from([0,0,0,0])) // counter = 0 (BE)
          .digest("hex");

        const useFake = await Promo.isFakeMode(player);

        if (useFake) {
          // ----- FAKE MODE (off-chain promo) -----
          const newBal = await Promo.freezeForBet(player, total);
          if (!newBal && newBal !== 0) {
            return socket.emit("plinko:error", { code: "FAKE_BALANCE_LOW", message: "Insufficient promo balance" });
          }

          // In-memory round
          rounds.set(nonce, {
            fakeMode: true,
            player,
            playerPk,
            unitLamports,
            balls,
            rows,
            diff,
            multipliers,
            probabilities,
            results: [],
            expiryUnix,
            serverSeed,
            serverSeedHash,
            clientSeed,
          });

          // Persist (locked)
          try {
            if (typeof DB.pool?.query === "function") {
              await DB.pool.query(
                `INSERT INTO plinko_rounds
                   (player, nonce, unit_lamports, balls, rows, diff,
                    server_seed_hash, server_seed, first_hmac_hex, client_seed,
                    status, lock_sig, expiry_unix)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'locked',$11,$12)
                 ON CONFLICT (nonce,player) DO NOTHING`,
                [
                  player,
                  BigInt(nonce),
                  Number(unitLamports),
                  balls,
                  rows,
                  diff,
                  serverSeedHash,
                  serverSeed.toString("hex"),
                  firstHmacHex,
                  clientSeed,
                  makeFakeTxSig("FAKE-LOCK", nonce),
                  Number(expiryUnix),
                ]
              );
            }
          } catch (e) {
            console.warn("plinko(fake): DB insert warn:", e?.message || e);
          }

          socket.emit("plinko:locked", {
            nonce: String(nonce),
            expiryUnix,
            multipliers,
            probabilities,
            txSig: makeFakeTxSig("FAKE-LOCK", nonce),
            serverSeedHash,
            promoBalanceLamports: newBal,
          });
          return;
        }

        // ----- REAL MODE (on-chain) -----
        const msgBuf = Buffer.concat([
          Buffer.from("PLINKO_LOCK"),
          new PublicKey(PROGRAM_ID).toBuffer(),
          houseVault.toBuffer(),
          playerPk.toBuffer(),
          pendingPlinko.toBuffer(),
          u64le(Number(unitLamports)),
          Buffer.from([rows & 0xff]),
          Buffer.from([diff & 0xff]),
          u64le(Number(nonce)),
          i64le(Number(expiryUnix)),
        ]);
        const edSig = await signMessageEd25519(msgBuf);
        const edIx  = buildEd25519VerifyIx({ message: msgBuf, signature: edSig, publicKey: ADMIN_PK });
        const edIndex = 1;

        const feePayer = await getServerKeypair();
        const cuPriceIx = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 });
        const cuLimitIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 350_000 });

        const lockIx = ixPlinkoLock({
          programId: PROGRAM_ID,
          player: playerPk,
          feePayer: feePayer.publicKey,
          userVault,
          houseVault,
          pendingPlinko,
          unitAmount: Number(unitLamports),
          balls,
          rows,
          difficulty: diff,
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
        const sim = await connection.simulateTransaction(vtx, { sigVerify: false }).catch(() => null);
        if (sim?.value?.err) {
          const logs = (sim.value.logs || []).join("\n");
          throw new Error(`plinko_lock simulate failed: ${JSON.stringify(sim.value.err)}\n${logs}`);
        }

        vtx.sign([feePayer]);
        const sig = await connection.sendRawTransaction(vtx.serialize(), { skipPreflight: false, maxRetries: 5 });
        await connection.confirmTransaction(sig, "confirmed");

        // In-memory round
        rounds.set(nonce, {
          fakeMode: false,
          player,
          playerPk,
          unitLamports,
          balls,
          rows,
          diff,
          multipliers,
          probabilities,
          results: [],
          pending: pendingPlinko.toBase58(),
          expiryUnix,
          serverSeed,
          serverSeedHash,
          clientSeed,
        });

        // Persist (locked)
        try {
          if (typeof DB.pool?.query === "function") {
            await DB.pool.query(
              `INSERT INTO plinko_rounds
                 (player, nonce, unit_lamports, balls, rows, diff,
                  server_seed_hash, server_seed, first_hmac_hex, client_seed,
                  status, lock_sig, pending, expiry_unix)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'locked',$11,$12,$13)
               ON CONFLICT (nonce,player) DO NOTHING`,
              [
                player,
                BigInt(nonce),
                Number(unitLamports),
                balls,
                rows,
                diff,
                serverSeedHash,
                serverSeed.toString("hex"),
                firstHmacHex,
                clientSeed,
                sig,
                pendingPlinko.toBase58(),
                Number(expiryUnix),
              ]
            );
          }
        } catch (e) {
          console.warn("plinko(real): DB insert warn:", e?.message || e);
        }

        socket.emit("plinko:locked", {
          nonce: String(nonce),
          expiryUnix,
          multipliers,
          probabilities,
          txSig: sig,
          serverSeedHash,
        });
      } catch (e) {
        console.error("plinko:prepare_lock error:", e);
        socket.emit("plinko:error", { code: "PREPARE_FAIL", message: e?.message || String(e) });
      }
    });

    // ---- Start run (server sim + resolve) ----
    socket.on("plinko:start_run", async ({ nonce }) => {
      try {
        let ctx = rounds.get(Number(nonce));

        // Attempt restore (optional)
        if (!ctx && typeof DB.pool?.query === "function") {
          try {
            const r = await DB.pool.query(`SELECT * FROM plinko_rounds WHERE nonce=$1 LIMIT 1`, [BigInt(nonce)]);
            const row = r.rows[0] || null;
            if (row) {
              const t = getTable(Number(row.rows || 8), Number(row.diff || 0));
              ctx = {
                fakeMode: !row.pending, // if no pending stored, assume fake
                player: row.player,
                playerPk: new PublicKey(row.player),
                unitLamports: BigInt(row.unit_lamports || 0),
                balls: Number(row.balls || 0),
                rows: Number(row.rows || 0),
                diff: Number(row.diff || 0),
                multipliers: t.multipliers,
                probabilities: t.probabilities,
                results: [],
                pending: row.pending || null,
                expiryUnix: Number(row.expiry_unix || 0),
                serverSeed: row.server_seed ? Buffer.from(row.server_seed, "hex") : null,
                serverSeedHash: row.server_seed_hash,
                clientSeed: row.client_seed || "",
              };
            }
          } catch (e) {
            console.warn("plinko: DB restore warn:", e?.message || e);
          }
        }

        if (!ctx) return socket.emit("plinko:error", { code: "NOT_FOUND", message: "no round" });

        // Simulate results with provably-fair RNG
        const rng = makeRng({ serverSeed: ctx.serverSeed, clientSeed: ctx.clientSeed || "", nonce: Number(nonce) });

        for (let i = 0; i < ctx.balls; i++) {
          const idx = chooseIndexWithRng(rng, ctx.probabilities);
          ctx.results.push(idx);
          socket.emit("plinko:tick", { nonce: String(nonce), ballIndex: i, slotIndex: idx });
          await new Promise((r) => setTimeout(r, 60));
        }

        const perBall = BigInt(ctx.unitLamports);
        let gross = 0n;
        for (const idx of ctx.results) {
          const mul = ctx.multipliers[idx] || 0.0;
          gross += grossFromMultiplier(perBall, mul);
        }
        const stake = perBall * BigInt(ctx.balls);
        const net   = gross > stake ? gross - stake : 0n;

        if (ctx.fakeMode) {
          // ----- FAKE MODE RESOLVE (promo, pay GROSS back) -----
          await Promo.settleBet(ctx.player, Number(gross)).catch(() => {});

          try {
            await DB.recordGameRound?.({
              game_key: "plinko",
              player: ctx.player,
              nonce: Number(nonce),
              stake_lamports: Number(stake),
              payout_lamports: Number(gross), // GROSS for promo mode
              result_json: { rows: ctx.rows, balls: ctx.balls, results: ctx.results, multipliers: ctx.multipliers, fake: true },
            }).catch(() => {});
            if (gross > 0n) {
              await DB.recordActivity?.({
                user: ctx.player,
                action: "Plinko win (fake)",
                amount: (Number(gross) / 1e9).toFixed(4),
              }).catch(() => {});
            }
            if (typeof DB.pool?.query === "function") {
              await DB.pool.query(
                `UPDATE plinko_rounds
                    SET results_json=$1, payout=$2, status='resolved', resolve_sig=$3, resolved_at=now()
                  WHERE nonce=$4 AND player=$5`,
                [ JSON.stringify({ rows: ctx.rows, balls: ctx.balls, results: ctx.results }),
                  Number(gross),
                  makeFakeTxSig("FAKE-RESOLVE", nonce),
                  BigInt(nonce),
                  ctx.player ]
              );
            }
          } catch (err) {
            console.warn("plinko(fake): DB update warn:", err?.message || err);
          }

          socket.emit("plinko:resolved", {
            nonce: String(nonce),
            results: ctx.results,
            multipliers: ctx.multipliers,
            payoutLamports: Number(gross), // gross (promo)
            grossLamports: Number(gross),
            netLamports: Number(net),
            stakeLamports: Number(stake),
            txSig: makeFakeTxSig("FAKE-RESOLVE", nonce),
          });

          // Reveal seed (counter=0 block matches DB first_hmac_hex)
          try {
            const serverSeedHex = ctx.serverSeed ? ctx.serverSeed.toString("hex") : null;
            const firstHmacHex = crypto
              .createHmac("sha256", ctx.serverSeed)
              .update(String(ctx.clientSeed || ""))
              .update(Buffer.from(String(nonce)))
              .update(Buffer.from([0,0,0,0]))
              .digest("hex");

            socket.emit("plinko:reveal_seed", {
              nonce: String(nonce),
              serverSeedHex,
              serverSeedHash: ctx.serverSeedHash || sha256Hex(ctx.serverSeed),
              clientSeed: ctx.clientSeed || "",
              formula: "HMAC_SHA256(serverSeed, clientSeed + nonce + u32_be(counter)) -> RNG stream (counter starts at 0)",
              firstHmacHex,
            });
          } catch (err) {
            console.warn("plinko(fake): reveal_seed failed:", err?.message || err);
          }

          rounds.delete(Number(nonce));
          return;
        }

        // ----- REAL MODE RESOLVE (on-chain, pay NET to vault) -----
        const houseVault = deriveVaultPda();
        const adminPda   = deriveAdminPda();
        const userVault  = deriveUserVaultPda(ctx.playerPk);
        const pendingPlinko = new PublicKey(ctx.pending);
        const checksum = (Number(nonce) % 251) + 1;

        const msgBuf = Buffer.concat([
          Buffer.from("PLINKO_RESOLVE"),
          new PublicKey(PROGRAM_ID).toBuffer(),
          houseVault.toBuffer(),
          ctx.playerPk.toBuffer(),
          pendingPlinko.toBuffer(),
          u64le(Number(net)),
          u64le(Number(nonce)),
          i64le(Number(ctx.expiryUnix)),
        ]);
        const edSig = await signMessageEd25519(msgBuf);
        const edIx  = buildEd25519VerifyIx({ message: msgBuf, signature: edSig, publicKey: ADMIN_PK });
        const edIndex = 1;

        const feePayer = await getServerKeypair();
        const cuPriceIx = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 });
        const cuLimitIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });

        const ixRes = ixPlinkoResolve({
          programId: PROGRAM_ID,
          player: ctx.playerPk,
          houseVault,
          adminPda,
          userVault,
          pendingPlinko,
          checksum,
          totalPayout: Number(net), // NET payout to user vault
          edIndex,
        });

        const { blockhash } = await connection.getLatestBlockhash("confirmed");
        const msgV0 = new TransactionMessage({
          payerKey: feePayer.publicKey,
          recentBlockhash: blockhash,
          instructions: [cuPriceIx, cuLimitIx, edIx, ixRes],
        }).compileToV0Message();

        const vtx = new VersionedTransaction(msgV0);
        const sim = await connection.simulateTransaction(vtx, { sigVerify: false }).catch(() => null);
        if (sim?.value?.err) {
          const logs = (sim.value.logs || []).join("\n");
          throw new Error(`plinko_resolve simulate failed: ${JSON.stringify(sim.value.err)}\n${logs}`);
        }

        vtx.sign([feePayer]);
        const sig = await connection.sendRawTransaction(vtx.serialize(), { skipPreflight: false, maxRetries: 5 });
        await connection.confirmTransaction(sig, "confirmed");

        try {
          await DB.recordGameRound?.({
            game_key: "plinko",
            player: ctx.playerPk.toBase58(),
            nonce: Number(nonce),
            stake_lamports: Number(stake),
            payout_lamports: Number(net), // NET (on-chain)
            result_json: { rows: ctx.rows, balls: ctx.balls, results: ctx.results, multipliers: ctx.multipliers },
          }).catch(() => {});
          if (net > 0n) {
            await DB.recordActivity?.({
              user: ctx.playerPk.toBase58(),
              action: "Plinko win",
              amount: (Number(net) / 1e9).toFixed(4),
            }).catch(() => {});
          }
          if (typeof DB.pool?.query === "function") {
            await DB.pool.query(
              `UPDATE plinko_rounds
                  SET results_json=$1, payout=$2, status='resolved', resolve_sig=$3, resolved_at=now()
                WHERE nonce=$4 AND player=$5`,
              [ JSON.stringify({ rows: ctx.rows, balls: ctx.balls, results: ctx.results }),
                Number(net), sig, BigInt(nonce), ctx.player ]
            );
          }
        } catch (err) {
          console.warn("plinko(real): DB update warn:", err?.message || err);
        }

        socket.emit("plinko:resolved", {
          nonce: String(nonce),
          results: ctx.results,
          multipliers: ctx.multipliers,
          payoutLamports: Number(net),  // net (real)
          grossLamports: Number(gross),
          netLamports: Number(net),
          stakeLamports: Number(stake),
          txSig: sig,
        });

        // Reveal seed (counter=0 block matches DB first_hmac_hex)
        try {
          const serverSeedHex = ctx.serverSeed ? ctx.serverSeed.toString("hex") : null;
          const firstHmacHex = crypto
            .createHmac("sha256", ctx.serverSeed)
            .update(String(ctx.clientSeed || ""))
            .update(Buffer.from(String(nonce)))
            .update(Buffer.from([0,0,0,0]))
            .digest("hex");

          socket.emit("plinko:reveal_seed", {
            nonce: String(nonce),
            serverSeedHex,
            serverSeedHash: ctx.serverSeedHash || sha256Hex(ctx.serverSeed),
            clientSeed: ctx.clientSeed || "",
            formula: "HMAC_SHA256(serverSeed, clientSeed + nonce + u32_be(counter)) -> RNG stream (counter starts at 0)",
            firstHmacHex,
          });
        } catch (err) {
          console.warn("plinko(real): reveal_seed failed:", err?.message || err);
        }

        rounds.delete(Number(nonce));
      } catch (e) {
        console.error("plinko:start_run error:", e);
        socket.emit("plinko:error", { code: "ROUND_FAIL", message: e?.message || String(e) });
      }
    });
  });
}

module.exports = {
  attachPlinko,
  attachPlinkoRoutes,
  ensurePlinkoSchema,
};



