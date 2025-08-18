// db.js
const { Pool } = require("pg");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function ensureSchema() {
  const fs = require("fs");
  const path = require("path");
  const sql = fs.readFileSync(path.join(process.cwd(), "schema.sql"), "utf8");
  await pool.query(sql);
}

async function getRules() {
  const { rows } = await pool.query("select * from game_rules order by id desc limit 1");
  return rows[0];
}

async function recordBet(b) {
  await pool.query(
    `insert into bets(
       player, bet_amount_lamports, bet_type, target, roll, payout_lamports,
       nonce, expiry_unix, signature_base58, status
     )
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      b.player,
      BigInt(b.amount),
      Number(b.betType),
      Number(b.target),
      Number(b.roll || 0),
      BigInt(b.payout || 0),
      BigInt(b.nonce),
      BigInt(b.expiry),
      b.signature_base58 || "",
      b.status || "prepared_lock",
    ]
  );
}

async function getBetByNonce(nonce) {
  const { rows } = await pool.query(
    `select * from bets where nonce = $1 order by id desc limit 1`,
    [BigInt(nonce)]
  );
  return rows[0] || null;
}

async function updateBetPrepared({ nonce, roll, payout }) {
  await pool.query(
    `update bets
       set roll = $2,
           payout_lamports = $3,
           status = 'prepared_resolve'
     where nonce = $1`,
    [BigInt(nonce), Number(roll), BigInt(payout)]
  );
}

module.exports = {
  pool,
  ensureSchema,
  getRules,
  recordBet,
  getBetByNonce,
  updateBetPrepared,
};
