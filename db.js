// // db.js
// const { Pool } = require("pg");

// const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// async function ensureSchema() {
//   const fs = require("fs");
//   const path = require("path");
//   const sql = fs.readFileSync(path.join(process.cwd(), "schema.sql"), "utf8");
//   await pool.query(sql);
// }

// async function getRules() {
//   const { rows } = await pool.query("select * from game_rules order by id desc limit 1");
//   return rows[0];
// }

// async function recordBet(b) {
//   await pool.query(
//     `insert into bets(
//        player, bet_amount_lamports, bet_type, target, roll, payout_lamports,
//        nonce, expiry_unix, signature_base58, status
//      )
//      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
//     [
//       b.player,
//       BigInt(b.amount),
//       Number(b.betType),
//       Number(b.target),
//       Number(b.roll || 0),
//       BigInt(b.payout || 0),
//       BigInt(b.nonce),
//       BigInt(b.expiry),
//       b.signature_base58 || "",
//       b.status || "prepared_lock",
//     ]
//   );
// }

// async function getBetByNonce(nonce) {
//   const { rows } = await pool.query(
//     `select * from bets where nonce = $1 order by id desc limit 1`,
//     [BigInt(nonce)]
//   );
//   return rows[0] || null;
// }

// async function updateBetPrepared({ nonce, roll, payout }) {
//   await pool.query(
//     `update bets
//        set roll = $2,
//            payout_lamports = $3,
//            status = 'prepared_resolve'
//      where nonce = $1`,
//     [BigInt(nonce), Number(roll), BigInt(payout)]
//   );
// }

// module.exports = {
//   pool,
//   ensureSchema,
//   getRules,
//   recordBet,
//   getBetByNonce,
//   updateBetPrepared,
// };


// db.js
const { Pool } = require("pg");

const hasDbUrl = !!process.env.DATABASE_URL;

// Some managed DBs require SSL
const useSSL =
  process.env.PGSSL === "true" ||
  /render\.com|neon\.tech|heroku|azure|railway/i.test(process.env.DATABASE_URL || "");

const pool = hasDbUrl
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: useSSL ? { rejectUnauthorized: false } : undefined,
    })
  : null;

async function ensureSchema() {
  if (!pool) {
    console.warn("[db] DATABASE_URL missing; running WITHOUT persistent DB.");
    return;
  }
  const fs = require("fs");
  const path = require("path");
  const sql = fs.readFileSync(path.join(process.cwd(), "schema.sql"), "utf8");
  await pool.query(sql);

  // Ensure one rules row exists
  await pool.query(
    `insert into game_rules (rtp_bps, house_edge_bps)
     select 9900, 100
     where not exists (select 1 from game_rules)`
  );
}

async function getRules() {
  if (!pool) return null;
  const { rows } = await pool.query("select * from game_rules order by id desc limit 1");
  return rows[0] || null;
}

async function recordBet(b) {
  if (!pool) throw new Error("DB disabled");
  await pool.query(
    `insert into bets(
       player, bet_amount_lamports, bet_type, target, roll, payout_lamports,
       nonce, expiry_unix, signature_base58, status
     )
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      b.player,                     // text
      String(b.amount),             // bigint
      Number(b.betType),            // smallint/int
      Number(b.target),             // int
      Number(b.roll || 0),          // int
      String(b.payout || 0),        // bigint
      String(b.nonce),              // bigint
      String(b.expiry),             // bigint
      b.signature_base58 || "",     // text
      b.status || "prepared_lock",  // text
    ]
  );
}

async function getBetByNonceForPlayer(nonce, player) {
  if (!pool) return null;
  const { rows } = await pool.query(
    `select * from bets where nonce = $1 and player = $2 order by id desc limit 1`,
    [String(nonce), String(player)]
  );
  return rows[0] || null;
}

async function updateBetPrepared({ nonce, player, roll, payout }) {
  if (!pool) throw new Error("DB disabled");
  await pool.query(
    `update bets
       set roll = $3,
           payout_lamports = $4,
           status = 'prepared_resolve'
     where nonce = $1 and player = $2`,
    [String(nonce), String(player), Number(roll), String(payout)]
  );
}

module.exports = {
  enabled: !!pool,
  pool,
  ensureSchema,
  getRules,
  recordBet,
  getBetByNonceForPlayer,
  updateBetPrepared,
};

