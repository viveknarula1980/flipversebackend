// admin_referrals_router.js
const express = require("express");
const router = express.Router();
const db = require("./db");

const USD_PER_SOL = Number(process.env.USD_PER_SOL || 200);
const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL || process.env.SITE_URL || "https://flipverse-web.vercel.app";

const toLam = (usd) => {
  const n = Number(usd);
  if (!isFinite(n) || n <= 0) return 0n;
  const sol = n / USD_PER_SOL;
  return BigInt(Math.round(sol * 1e9));
};
const lamToUsd = (lam) => (Number(lam) / 1e9) * USD_PER_SOL;

/* ---------------------------- Affiliates list ---------------------------- */
router.get("/affiliates", async (_req, res) => {
  try {
    const { rows: aff } = await db.pool.query(
      `select code, owner_wallet, status, created_at from affiliates order by created_at desc`
    );

    const { rows: refCounts } = await db.pool.query(
      `select affiliate_code, count(*)::int as total from referrals group by affiliate_code`
    );
    const refByCode = Object.fromEntries(
      refCounts.map((r) => [r.affiliate_code, Number(r.total)])
    );

    const { rows: activeRefRows } = await db.pool.query(
      `select affiliate_code, count(distinct referred_wallet)::int as active
         from affiliate_commissions
        where created_at >= now() - interval '30 days'
        group by affiliate_code`
    );
    const actByCode = Object.fromEntries(
      activeRefRows.map((r) => [r.affiliate_code, Number(r.active)])
    );

    const { rows: bal } = await db.pool.query(`select * from v_affiliate_balances`);
    const balByCode = Object.fromEntries(bal.map((r) => [r.affiliate_code, r]));

    const { rows: last1 } = await db.pool.query(
      `select affiliate_code, max(created_at) as last from affiliate_commissions group by affiliate_code`
    );
    const { rows: last2 } = await db.pool.query(
      `select r.affiliate_code, max(coalesce(r.bound_at,r.created_at)) as last from referrals r group by r.affiliate_code`
    );
    const { rows: last3 } = await db.pool.query(
      `select code as affiliate_code, max(created_at) as last from affiliate_link_clicks group by code`
    );
    const lastMap = new Map();
    for (const r of [...last1, ...last2, ...last3]) {
      const k = r.affiliate_code;
      const t = r.last;
      if (!k || !t) continue;
      const prev = lastMap.get(k);
      const cur = new Date(t);
      if (!prev || cur > prev) lastMap.set(k, cur);
    }

    // fraud heuristics flags (lightweight)
    const flagsByCode = Object.create(null);
    function addFlag(map, code, f) {
      if (!map[code]) map[code] = [];
      if (!map[code].includes(f)) map[code].push(f);
    }
    const { rows: selfRef } = await db.pool.query(
      `select affiliate_code, count(*)::int as c
         from referrals where referrer_wallet = referred_wallet group by affiliate_code`
    );
    for (const r of selfRef) addFlag(flagsByCode, r.affiliate_code, "self_referral");

    const { rows: noW } = await db.pool.query(
      `with ref as (
         select affiliate_code, count(*)::int as total from referrals group by affiliate_code
       ), wr as (
         select affiliate_code, count(distinct referred_wallet)::int as active from affiliate_commissions group by affiliate_code
       )
       select ref.affiliate_code, ref.total, coalesce(wr.active,0) as active
         from ref left join wr on wr.affiliate_code = ref.affiliate_code
        where ref.total >= 5 and (ref.total - coalesce(wr.active,0))::float / ref.total > 0.7`
    );
    for (const r of noW) addFlag(flagsByCode, r.affiliate_code, "no_wagering");

    const { rows: multiIps } = await db.pool.query(
      `select code as affiliate_code
         from (
           select code, clicked_wallet, count(distinct ip::text) as ips
             from affiliate_link_clicks
            where clicked_wallet is not null
            group by code, clicked_wallet
         ) x
        where ips >= 3`
    );
    for (const r of multiIps) addFlag(flagsByCode, r.affiliate_code, "multiple_ips");

    const out = aff.map((a) => {
      const b = balByCode[a.code] || {
        lifetime_earned_lamports: 0,
        current_balance_lamports: 0,
      };
      return {
        id: a.code,
        walletAddress: a.owner_wallet,
        affiliateId: a.code,
        referralLink: `${SITE_URL}/?ref=${encodeURIComponent(a.code)}`,
        totalReferrals: refByCode[a.code] || 0,
        activeReferrals: actByCode[a.code] || 0,
        lifetimeEarnings: Number(lamToUsd(b.lifetime_earned_lamports || 0)),
        currentBalance: Number(lamToUsd(b.current_balance_lamports || 0)),
        status: a.status,
        joinDate: new Date(a.created_at).toISOString(),
        lastActivity: (lastMap.get(a.code) || a.created_at)?.toISOString?.() || null,
        fraudFlags: flagsByCode[a.code] || [],
      };
    });

    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

router.put("/affiliates/:code/status", async (req, res) => {
  try {
    const code = String(req.params.code).toUpperCase();
    const status = String(req.body?.status || "");
    if (!["active", "suspended", "banned"].includes(status))
      return res.status(400).json({ error: "invalid status" });
    const q = await db.pool.query(`update affiliates set status=$1 where code=$2`, [
      status,
      code,
    ]);
    if (q.rowCount === 0) return res.status(404).json({ error: "affiliate not found" });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

/* --------------------------------- Metrics -------------------------------- */
router.get("/metrics", async (_req, res) => {
  try {
    const [{ rows: totAff }, { rows: actAff }] = await Promise.all([
      db.pool.query(`select count(*)::int as c from affiliates`),
      db.pool.query(`select count(distinct affiliate_code)::int as c
                       from affiliate_commissions
                      where created_at >= now() - interval '30 days'`),
    ]);

    const { rows: paid } = await db.pool.query(
      `select coalesce(sum(amount_lamports),0)::bigint as s from affiliate_payout_requests where status='completed'`
    );
    const { rows: pend } = await db.pool.query(
      `select coalesce(sum(amount_lamports),0)::bigint as s from affiliate_payout_requests where status in ('pending','approved','processing')`
    );

    const { rows: dep } = await db.pool.query(
      `select coalesce(sum(d.amount_lamports),0)::bigint as s
         from deposits d
         where d.user_wallet in (select referred_wallet from referrals)`
    );

    const { rows: ngr } = await db.pool.query(
      `select coalesce(sum(ngr_lamports),0)::bigint as ngr,
              coalesce(sum(affiliate_commission_lamports),0)::bigint as comm
         from affiliate_commissions`
    );

    const totalNgr = Number(ngr[0].ngr || 0);
    const totalCom = Number(ngr[0].comm || 0);
    const avgRate = totalNgr > 0 ? (totalCom / totalNgr) * 100 : 0;

    res.json({
      totalAffiliates: Number(totAff[0]?.c || 0),
      activeAffiliates: Number(actAff[0]?.c || 0),
      totalCommissionsPaid: lamToUsd(paid[0]?.s || 0),
      pendingPayouts: lamToUsd(pend[0]?.s || 0),
      totalDepositsGenerated: lamToUsd(dep[0]?.s || 0),
      netGamingRevenue: lamToUsd(ngr[0]?.ngr || 0),
      averageCommissionRate: Number(avgRate.toFixed(2)),
    });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

/* --------------------------------- Payouts -------------------------------- */
router.get("/payouts", async (_req, res) => {
  try {
    const { rows } = await db.pool.query(
      `select id, affiliate_code, affiliate_wallet, amount_lamports, network, status,
              requested_at, processed_at, fraud_score, is_automatic, requires_manual_review, tx_hash, notes
         from affiliate_payout_requests
        order by requested_at desc limit 500`
    );
    const out = rows.map((r) => ({
      id: String(r.id),
      affiliateId: r.affiliate_code,
      walletAddress: r.affiliate_wallet,
      amount: lamToUsd(r.amount_lamports),
      network: r.network,
      status: r.status,
      requestDate: r.requested_at?.toISOString?.() || null,
      processedDate: r.processed_at ? r.processed_at.toISOString() : undefined,
      fraudScore: Number(r.fraud_score || 0),
      isAutomatic: !!r.is_automatic,
      requiresManualReview: !!r.requires_manual_review,
      transactionHash: r.tx_hash || undefined,
      notes: r.notes || undefined,
    }));
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

router.post("/payouts/manual", async (req, res) => {
  try {
    const { affiliateId, amount, network = "SOL", notes } = req.body || {};
    if (!affiliateId || !amount)
      return res.status(400).json({ error: "affiliateId and amount required" });
    const { rows: aff } = await db.pool.query(
      `select code, owner_wallet from affiliates where code=$1`,
      [String(affiliateId).toUpperCase()]
    );
    if (!aff[0]) return res.status(404).json({ error: "affiliate not found" });

    const { rows: bal } = await db.pool.query(
      `select * from v_affiliate_balances where affiliate_code=$1`,
      [aff[0].code]
    );
    const currentUsd = lamToUsd(bal[0]?.current_balance_lamports || 0);
    if (Number(amount) > currentUsd)
      return res.status(400).json({ error: "amount exceeds current balance" });

    const ins = await db.pool.query(
      `insert into affiliate_payout_requests (affiliate_code, affiliate_wallet, amount_lamports, network, status, is_automatic, requires_manual_review, fraud_score, notes)
       values ($1,$2,$3,$4,'pending',false,false,0,$5) returning id`,
      [aff[0].code, aff[0].owner_wallet, toLam(amount), String(network), notes || null]
    );
    res.json({ ok: true, id: String(ins.rows[0].id) });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

router.post("/payouts/auto-trigger", async (_req, res) => {
  try {
    const { rows: s } = await db.pool.query(
      `select * from affiliate_payout_settings where id=1`
    );
    const set = s[0] || {};

    const threshold = BigInt(set.auto_payout_threshold_lamports || 50000000n);
    const maxAmt = BigInt(set.auto_payout_max_amount_lamports || 5000000000n);
    const defaultNetwork = set.default_network || "SOL";
    const fraudCutoff = Number(set.fraud_score_threshold || 0.3);

    const { rows: bals } = await db.pool.query(`select * from v_affiliate_balances`);
    let created = 0;
    for (const r of bals) {
      const code = r.affiliate_code;
      const balLam = BigInt(r.current_balance_lamports || 0);
      if (balLam < threshold) continue;
      const amount = balLam > maxAmt ? maxAmt : balLam;

      const { rows: recent } = await db.pool.query(
        `select 1 from affiliate_commissions where affiliate_code=$1 and created_at >= now() - interval '7 days' limit 1`,
        [code]
      );
      const fraudScore = recent[0] ? 0 : 0.8;
      if (fraudScore > fraudCutoff) continue;

      const { rows: aff } = await db.pool.query(
        `select owner_wallet from affiliates where code=$1`,
        [code]
      );
      if (!aff[0]) continue;

      await db.pool.query(
        `insert into affiliate_payout_requests (affiliate_code, affiliate_wallet, amount_lamports, network, status, is_automatic, requires_manual_review, fraud_score)
         values ($1,$2,$3,$4,'pending',true,$5,$6)`,
        [
          code,
          aff[0].owner_wallet,
          amount,
          defaultNetwork,
          amount > BigInt(set.manual_review_above_lamports || 1000000000n),
          fraudScore,
        ]
      );
      created++;
    }

    res.json({ ok: true, created });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

router.put("/payouts/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { action, network, notes, txHash } = req.body || {};
    if (!["approve", "reject", "complete", "processing"].includes(action))
      return res.status(400).json({ error: "invalid action" });

    if (action === "approve") {
      await db.pool.query(
        `update affiliate_payout_requests set status='approved', network=coalesce($2,network), notes=coalesce($3,notes) where id=$1`,
        [id, network || null, notes || null]
      );
    } else if (action === "reject") {
      await db.pool.query(
        `update affiliate_payout_requests set status='rejected', processed_at=now(), notes=coalesce($2,notes) where id=$1`,
        [id, notes || null]
      );
    } else if (action === "processing") {
      await db.pool.query(
        `update affiliate_payout_requests set status='processing', tx_hash=coalesce($2,tx_hash), processed_at=null where id=$1`,
        [id, txHash || null]
      );
    } else if (action === "complete") {
      await db.pool.query(
        `update affiliate_payout_requests set status='completed', tx_hash=coalesce($2,tx_hash), processed_at=now() where id=$1`,
        [id, txHash || null]
      );
    }

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

/* ---------------------------- Payout Settings ---------------------------- */
router.get("/payout-settings", async (_req, res) => {
  try {
    const { rows } = await db.pool.query(
      `select * from affiliate_payout_settings where id=1`
    );
    const s = rows[0] || {};
    res.json({
      autoPayoutEnabled: s.auto_payout_enabled ?? true,
      autoPayoutThreshold: lamToUsd(s.auto_payout_threshold_lamports || 50000000),
      autoPayoutMaxAmount: lamToUsd(s.auto_payout_max_amount_lamports || 5000000000),
      defaultNetwork: s.default_network || "SOL",
      fraudScoreThreshold: Number(s.fraud_score_threshold ?? 0.3),
      requireManualReviewAbove: lamToUsd(s.manual_review_above_lamports || 1000000000),
    });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

router.put("/payout-settings", async (req, res) => {
  try {
    const {
      autoPayoutEnabled = true,
      autoPayoutThreshold = 50,
      autoPayoutMaxAmount = 500,
      defaultNetwork = "SOL",
      fraudScoreThreshold = 0.3,
      requireManualReviewAbove = 1000,
    } = req.body || {};

    await db.pool.query(
      `insert into affiliate_payout_settings(id, auto_payout_enabled, auto_payout_threshold_lamports, auto_payout_max_amount_lamports, default_network, fraud_score_threshold, manual_review_above_lamports, updated_at)
       values (1,$1,$2,$3,$4,$5,$6,now())
       on conflict (id) do update set
         auto_payout_enabled=$1,
         auto_payout_threshold_lamports=$2,
         auto_payout_max_amount_lamports=$3,
         default_network=$4,
         fraud_score_threshold=$5,
         manual_review_above_lamports=$6,
         updated_at=now()`,
      [
        !!autoPayoutEnabled,
        toLam(autoPayoutThreshold),
        toLam(autoPayoutMaxAmount),
        String(defaultNetwork),
        Number(fraudScoreThreshold),
        toLam(requireManualReviewAbove),
      ]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

/* --------------------------- Commission rules CRUD --------------------------- */
router.get("/rules", async (_req, res) => {
  try {
    const { rows } = await db.pool.query(
      `select * from affiliate_commission_rules order by id desc`
    );
    const out = rows.map((r) => ({
      id: String(r.id),
      name: r.name,
      gameType: r.game_type,
      isGlobal: r.is_global,
      commissionRate: Number(r.config?.commissionRate ?? 0),
      bonusPerDeposit: Number(r.config?.bonusPerDeposit ?? 0),
      rakeback: Number(r.config?.rakeback ?? 0),
      affiliateIds: Array.isArray(r.config?.affiliateIds) ? r.config.affiliateIds : [],
      tierBasedRates: r.config?.tierBasedRates || { enabled: false, tiers: [] },
      bonusTriggers:
        r.config?.bonusTriggers || {
          firstDepositBonus: 0,
          minimumDepositAmount: 0,
          recurringDepositBonus: 0,
          volumeMilestoneBonus: [],
        },
      rakebackIncentives:
        r.config?.rakebackIncentives || {
          baseRakeback: 0,
          referralBonus: 0,
          loyaltyMultiplier: 1,
        },
      restrictions:
        r.config?.restrictions || {
          minimumBetAmount: 0,
          excludedCountries: [],
          maxCommissionPerMonth: 0,
          requireKYC: false,
        },
      validityPeriod: r.config?.validityPeriod || {
        startDate: new Date().toISOString(),
        isActive: !!r.is_active,
      },
    }));
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

router.post("/rules", async (req, res) => {
  try {
    const r = req.body || {};
    const ins = await db.pool.query(
      `insert into affiliate_commission_rules (name, game_type, is_global, config, start_date, end_date, is_active)
       values ($1,$2,$3,$4,$5,$6,$7) returning id`,
      [
        String(r.name || "Unnamed"),
        String(r.gameType || "all"),
        !!r.isGlobal,
        JSON.stringify(r),
        r.validityPeriod?.startDate ? new Date(r.validityPeriod.startDate) : new Date(),
        r.validityPeriod?.endDate ? new Date(r.validityPeriod.endDate) : null,
        !!(r.validityPeriod?.isActive ?? true),
      ]
    );
    res.json({ id: String(ins.rows[0].id) });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

router.put("/rules/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const r = req.body || {};
    await db.pool.query(
      `update affiliate_commission_rules
          set name=$2,
              game_type=$3,
              is_global=$4,
              config=$5,
              start_date=$6,
              end_date=$7,
              is_active=$8
        where id=$1`,
      [
        id,
        String(r.name || "Unnamed"),
        String(r.gameType || "all"),
        !!r.isGlobal,
        JSON.stringify(r),
        r.validityPeriod?.startDate ? new Date(r.validityPeriod.startDate) : new Date(),
        r.validityPeriod?.endDate ? new Date(r.validityPeriod.endDate) : null,
        !!(r.validityPeriod?.isActive ?? true),
      ]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

router.delete("/rules/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    await db.pool.query(`delete from affiliate_commission_rules where id=$1`, [id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

/* --------------------------- Top affiliates + Fraud -------------------------- */
router.get("/top", async (_req, res) => {
  try {
    const { rows } = await db.pool.query(
      `select affiliate_code, min(referrer_wallet) as wallet, 
              sum(ngr_lamports)::bigint as vol,
              sum(affiliate_commission_lamports)::bigint as comm,
              count(distinct referred_wallet)::int as refs
         from affiliate_commissions
        group by affiliate_code
        order by comm desc
        limit 50`
    );
    res.json(
      rows.map((r) => ({
        affiliateId: r.affiliate_code,
        walletAddress: r.wallet,
        totalVolume: lamToUsd(r.vol),
        commissionEarned: lamToUsd(r.comm),
        referralCount: Number(r.refs || 0),
      }))
    );
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

router.get("/fraud", async (_req, res) => {
  try {
    const { rows } = await db.pool.query(
      `select id, affiliate_code, alert_type, description, severity, created_at, resolved
         from affiliate_fraud_alerts
        order by created_at desc
        limit 200`
    );
    const out = rows.map((r) => ({
      id: String(r.id),
      affiliateId: r.affiliate_code,
      type: r.alert_type,
      description: r.description,
      severity: r.severity,
      date: r.created_at?.toISOString?.() || null,
      resolved: !!r.resolved,
    }));
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

router.patch("/fraud/:id/resolve", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const resolved = !!(req.body?.resolved ?? true);
    await db.pool.query(`update affiliate_fraud_alerts set resolved=$2 where id=$1`, [
      id,
      resolved,
    ]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// ----------------------------- Activity helpers -----------------------------
function windowSql(window = "today", col = "created_at") {
  if (window === "7d") return `${col} >= now() - interval '7 days'`;
  if (window === "30d") return `${col} >= now() - interval '30 days'`;
  // today (UTC date)
  return `${col}::date = now()::date`;
}

function mapPayoutStatusToFeed(status) {
  if (status === "rejected") return "failed";
  if (status === "pending" || status === "approved" || status === "processing") return "pending";
  if (status === "completed") return "success";
  return "pending";
}

function classifySource(referer) {
  const r = (referer || "").toLowerCase();
  if (r.includes("t.me") || r.includes("telegram")) return "Telegram Groups";
  if (r.includes("twitter.com") || r.includes("x.com")) return "Twitter";
  if (r.includes("discord.gg") || r.includes("discord.com")) return "Discord Communities";
  if (!r) return "Direct Links";
  // domain-only fallback
  try {
    const u = new URL(r);
    return (u.hostname || r).replace(/^www\./, "");
  } catch {
    return r.replace(/^https?:\/\//, "").split("/")[0] || "Other";
  }
}

// --------------------------- GET /activity (feed) ---------------------------
router.get("/activity", async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50));

    // Signups
    const signups = (
      await db.pool.query(
        `select 'signup-'||r.ctid::text as id,
                'signup' as type,
                r.affiliate_code as affiliate_id,
                'New referral signup' as description,
                null::bigint as amount_lamports,
                coalesce(r.bound_at, r.created_at) as ts,
                'success' as status
           from referrals r
           order by ts desc
           limit $1`,
        [limit]
      )
    ).rows;

    // First deposits from referred users
    const deposits = (
      await db.pool.query(
        `with first_dep as (
           select distinct on (d.user_wallet)
                  d.id, d.user_wallet, d.amount_lamports, d.created_at
             from deposits d
             order by d.user_wallet, d.created_at asc, d.id asc
         )
         select 'deposit-'||fd.id::text as id,
                'deposit' as type,
                r.affiliate_code as affiliate_id,
                'Referral made first deposit' as description,
                fd.amount_lamports,
                fd.created_at as ts,
                'success' as status
           from first_dep fd
           join referrals r on r.referred_wallet = fd.user_wallet
           order by ts desc
           limit $1`,
        [limit]
      )
    ).rows;

    // Commissions
    const comms = (
      await db.pool.query(
        `select 'commission-'||c.ctid::text as id,
                'commission' as type,
                c.affiliate_code as affiliate_id,
                'Commission earned from referral wagering' as description,
                c.affiliate_commission_lamports as amount_lamports,
                c.created_at as ts,
                'success' as status
           from affiliate_commissions c
           order by c.created_at desc
           limit $1`,
        [limit]
      )
    ).rows;

    // Payouts
    const payouts = (
      await db.pool.query(
        `select 'payout-'||p.id::text as id,
                'payout' as type,
                p.affiliate_code as affiliate_id,
                case p.status
                  when 'pending' then 'Payout request submitted'
                  when 'approved' then 'Payout approved'
                  when 'processing' then 'Payout processing'
                  when 'completed' then 'Payout completed'
                  when 'rejected' then 'Payout rejected'
                  else 'Payout update'
                end as description,
                p.amount_lamports,
                coalesce(p.processed_at, p.requested_at) as ts,
                p.status as raw_status
           from affiliate_payout_requests p
           order by coalesce(p.processed_at, p.requested_at) desc nulls last
           limit $1`,
        [limit]
      )
    ).rows.map((r) => ({ ...r, status: mapPayoutStatusToFeed(r.raw_status) }));

    const rows = [...signups, ...deposits, ...comms, ...payouts]
      .sort((a, b) => new Date(b.ts) - new Date(a.ts))
      .slice(0, limit)
      .map((r) => ({
        id: String(r.id),
        type: r.type,
        affiliateId: r.affiliate_id,
        description: r.description,
        amount:
          r.amount_lamports == null
            ? null
            : +((Number(r.amount_lamports) / 1e9) * USD_PER_SOL).toFixed(2),
        timestamp: new Date(r.ts).toISOString(),
        status: r.status,
      }));

    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// ----------------------- GET /activity/stats (KPIs) ------------------------
router.get("/activity/stats", async (req, res) => {
  try {
    const window = String(req.query.window || "today");
    const w1 = windowSql(window, "coalesce(r.bound_at, r.created_at)");
    const w2 = windowSql(window, "fd.created_at"); // FIX: use fd alias from the CTE below
    const w3 = windowSql(window, "c.created_at");

    const [{ rows: s }, { rows: d }, { rows: c }, { rows: a }] = await Promise.all([
      db.pool.query(`select count(*)::int as cnt from referrals r where ${w1}`),

      // Sum of FIRST deposits (per referred wallet) in window
      db.pool.query(`
        with first_dep as (
          select distinct on (user_wallet)
                 user_wallet, amount_lamports, created_at
            from deposits
            order by user_wallet, created_at asc, id asc
        )
        select coalesce(sum(fd.amount_lamports),0)::bigint as lam
          from first_dep fd
          join referrals r on r.referred_wallet = fd.user_wallet
         where ${w2}`),

      db.pool.query(
        `select coalesce(sum(c.affiliate_commission_lamports),0)::bigint as lam from affiliate_commissions c where ${w3}`
      ),
      db.pool.query(
        `select count(distinct c.affiliate_code)::int as cnt from affiliate_commissions c where ${w3}`
      ),
    ]);

    res.json({
      signupsToday: Number(s[0]?.cnt || 0),
      depositsToday: (Number(d[0]?.lam || 0) / 1e9) * USD_PER_SOL,
      commissionsToday: (Number(c[0]?.lam || 0) / 1e9) * USD_PER_SOL,
      activeAffiliates: Number(a[0]?.cnt || 0),
    });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// ----------------------- GET /sources/top (attribution) --------------------
router.get("/sources/top", async (req, res) => {
  try {
    const window = String(req.query.window || "today");
    const w = windowSql(window, "created_at");

    // clicks by source
    const clicks = (
      await db.pool.query(
        `select referer from affiliate_link_clicks where ${w}`
      )
    ).rows;

    const clickBySource = Object.create(null);
    for (const r of clicks) {
      const src = classifySource(r.referer);
      clickBySource[src] = (clickBySource[src] || 0) + 1;
    }

    // attribute signups to the source of a matching click (same referred wallet) within ±1 day
    const signups = (
      await db.pool.query(
        `with s as (
           select referred_wallet, coalesce(bound_at, created_at) as signup_at
             from referrals
            where ${windowSql(window, "coalesce(bound_at, created_at)")}
         ),
         c as (
           select clicked_wallet, referer, created_at
             from affiliate_link_clicks
            where ${w} and clicked_wallet is not null
         )
         select c.referer as referer, count(*)::int as signups
           from s
           join c on c.clicked_wallet = s.referred_wallet
                 and c.created_at between s.signup_at - interval '1 day' and s.signup_at + interval '1 day'
          group by c.referer`
      )
    ).rows;

    const resBySource = Object.create(null);
    for (const r of signups) {
      const src = classifySource(r.referer);
      resBySource[src] = (resBySource[src] || 0) + Number(r.signups || 0);
    }

    const out = Object.entries(clickBySource)
      .map(([source, clicks]) => {
        const signups = resBySource[source] || 0;
        const conversion = clicks > 0 ? +((signups * 100) / clicks).toFixed(1) : 0;
        return { source, signups, conversion };
      })
      .sort((a, b) => b.signups - a.signups || b.conversion - a.conversion)
      .slice(0, 20);

    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

module.exports = router;
