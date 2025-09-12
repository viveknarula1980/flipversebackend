// affiliate_service.js
// exports a factory: pass in the pg pool (db.pool)
const REFERRAL_RAKEBACK_BOOST_BPS = Number(process.env.AFF_REFERRAL_RAKEBACK_BOOST_BPS || 1000);
const REFERRAL_RAKEBACK_BOOST_DAYS = Number(process.env.AFF_RAKEBACK_DAYS || 7);

const big = (v) => (v == null ? null : String(v));

module.exports = function createAffiliateService(pool) {
  if (!pool) throw new Error("affiliate_service requires a pg pool");

  async function creditAffiliateAndRakeback({ player, game_key, round_id, stakeLamports, payoutLamports }) {
    const ply = String(player);
    const stake = BigInt(stakeLamports ?? 0);
    const payout = BigInt(payoutLamports ?? 0);
    const ngr = stake - payout;

    if (ngr <= 0n) return { ngr: ngr.toString(), rakebackLamports: "0", affiliateCommissionLamports: "0" };

    const { rows: refRows } = await pool.query(
      `select r.affiliate_code, r.referrer_wallet, r.bound_at, a.rakeback_bps, a.revshare_bps
       from referrals r
       join affiliates a on a.code = r.affiliate_code
       where r.referred_wallet = $1
       limit 1`, [ply]
    );

    if (refRows.length === 0) {
      return { ngr: ngr.toString(), rakebackLamports: "0", affiliateCommissionLamports: "0" };
    }

    const { affiliate_code, referrer_wallet, bound_at, rakeback_bps, revshare_bps } = refRows[0];
    let rbBps = Number(rakeback_bps || 0);
    if (bound_at) {
      const diffDays = Math.floor((Date.now() - new Date(bound_at).getTime()) / (24*3600*1000));
      if (diffDays <= REFERRAL_RAKEBACK_BOOST_DAYS) rbBps += REFERRAL_RAKEBACK_BOOST_BPS;
    }

    const rakeback = (ngr * BigInt(rbBps)) / 10000n;
    const affiliateCut = (ngr * BigInt(Number(revshare_bps || 0))) / 10000n;

    try {
      await pool.query(
        `insert into affiliate_commissions
          (affiliate_code, referrer_wallet, referred_wallet, game_key, round_id, ngr_lamports, rakeback_lamports, affiliate_commission_lamports, created_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8, now())`,
        [ affiliate_code, referrer_wallet, ply, String(game_key||""), (round_id==null?null:Number(round_id)),
          big(ngr.toString()), big(rakeback.toString()), big(affiliateCut.toString()) ]
      );
    } catch (err) {
      // ignore duplicate/unique-violation (someone else already inserted)
      if (!(err && err.code === "23505")) throw err;
    }

    return {
      ngr: ngr.toString(),
      rakebackLamports: rakeback.toString(),
      affiliateCommissionLamports: affiliateCut.toString(),
    };
  }

  return {
    creditAffiliateAndRakeback,
  };
};
