// backend/promos_admin_router.js
const express = require("express");
const router = express.Router();
const db = require("./db"); // expects db.pool
const { Pool } = require("pg");
const { getMessage } = require("./messageUtil");

// helper: safe parser
const toNumberOrNull = (v) => (v == null || v === "") ? null : Number(v);

// === Utilities ===
function mapPromoRow(r) {
  return {
    id: String(r.id),
    name: r.name,
    code: r.code,
    type: r.type,
    status: r.status,
    trigger: r.trigger,
    rewardType: r.reward_type,
    rewardValue: r.reward_value != null ? Number(r.reward_value) : null,
    rewardUnit: r.reward_unit,
    maxReward: r.max_reward != null ? Number(r.max_reward) : null,
    minDeposit: r.min_deposit != null ? Number(r.min_deposit) : null,
    wagering: r.wagering != null ? Number(r.wagering) : null,
    validFrom: r.valid_from ? r.valid_from.toISOString() : null,
    validTo: r.valid_to ? r.valid_to.toISOString() : null,
    usageCount: Number(r.usage_count || 0),
    usageLimit: r.usage_limit != null ? Number(r.usage_limit) : null,
    description: r.description,
    createdAt: r.created_at ? r.created_at.toISOString() : null,
    updatedAt: r.updated_at ? r.updated_at.toISOString() : null,
  };
}

// ----------------------------
// STATIC ROUTES (defined first)
// ----------------------------

// List (with filters + pagination)
router.get("/admin/list", async (req, res) => {
  try {
    const {
      search = "",
      type = "all",
      status = "all",
      trigger = "all",
      page = "1",
      perPage = "10",
    } = req.query;

    const pg = Math.max(1, parseInt(page, 10) || 1);
    const limit = Math.max(1, Math.min(200, parseInt(perPage, 10) || 10));
    const offset = (pg - 1) * limit;

    // build WHERE
    const where = [];
    const vals = [];
    let i = 1;

    if (search && String(search).trim()) {
      where.push(`(lower(name) LIKE $${i} OR lower(coalesce(code,'')) LIKE $${i} OR lower(coalesce(description,'')) LIKE $${i})`);
      vals.push(`%${String(search).toLowerCase()}%`);
      i++;
    }
    if (type && type !== "all") {
      where.push(`type = $${i}`); vals.push(String(type)); i++;
    }
    if (status && status !== "all") {
      where.push(`status = $${i}`); vals.push(String(status)); i++;
    }
    if (trigger && trigger !== "all") {
      where.push(`trigger = $${i}`); vals.push(String(trigger)); i++;
    }

    const whereSql = where.length ? `where ${where.join(" AND ")}` : "";

    const totalQ = await db.pool.query(`select count(*)::int as cnt from promotions ${whereSql}`, vals);
    const total = totalQ.rows[0]?.cnt || 0;

    const dataQ = await db.pool.query(
      `select * from promotions ${whereSql} order by updated_at desc nulls last, id desc limit $${i} offset $${i+1}`,
      vals.concat([limit, offset])
    );

    const promos = dataQ.rows.map(mapPromoRow);

    res.json({
      promos,
      meta: {
        totalItems: total,
        page: pg,
        perPage: limit,
        totalPages: Math.ceil(total / limit),
      }
    });
  } catch (e) {
    console.error("[/promo/admin/list] error:", e?.message || e);
    res.status(500).json({ error: getMessage('generalNetwork', 'unknownError') });
  }
});

// CSV export
router.get("/admin/export.csv", async (req, res) => {
  try {
    const { search = "", type = "all", status = "all", trigger = "all" } = req.query;

    const where = [];
    const vals = [];
    let i = 1;

    if (search && String(search).trim()) {
      where.push(`(lower(name) LIKE $${i} OR lower(coalesce(code,'')) LIKE $${i} OR lower(coalesce(description,'')) LIKE $${i})`);
      vals.push(`%${String(search).toLowerCase()}%`);
      i++;
    }
    if (type && type !== "all") { where.push(`type = $${i}`); vals.push(String(type)); i++; }
    if (status && status !== "all") { where.push(`status = $${i}`); vals.push(String(status)); i++; }
    if (trigger && trigger !== "all") { where.push(`trigger = $${i}`); vals.push(String(trigger)); i++; }

    const whereSql = where.length ? `where ${where.join(" AND ")}` : "";

    const q = await db.pool.query(`select * from promotions ${whereSql} order by updated_at desc nulls last, id desc`, vals);

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=promotions_export.csv");

    res.write(`Name,Code,Type,Status,Trigger,Reward,Usage,Valid From,Valid To,Description\n`);

    for (const p of q.rows) {
      const rewardStr = p.reward_unit === 'percentage' ? `${p.reward_value}%` : (p.reward_unit === 'spins' ? `${p.reward_value} spins` : `$${p.reward_value}`);
      const usage = `${Number(p.usage_count || 0)}${p.usage_limit ? `/${p.usage_limit}` : ""}`;
      const vf = p.valid_from ? p.valid_from.toISOString() : "";
      const vt = p.valid_to ? p.valid_to.toISOString() : "";
      const name = `"${String(p.name || "").replace(/"/g, '""')}"`;
      const code = `"${String(p.code || "").replace(/"/g, '""')}"`;
      const desc = `"${String(p.description || "").replace(/"/g, '""')}"`;
      res.write([name, code, p.type, p.status, p.trigger || "", rewardStr, usage, vf, vt, desc].join(",") + "\n");
    }
    res.end();
  } catch (e) {
    console.error("[/promo/admin/export.csv] error:", e?.message || e);
    res.status(500).json({ error: getMessage('generalNetwork', 'unknownError') });
  }
});

// Stats for admin dashboard
router.get("/admin/stats", async (req, res) => {
  try {
    const tQ = await db.pool.query(`select count(*)::int as total, sum(case when status='active' then 1 else 0 end)::int as active from promotions`);
    const total = tQ.rows[0]?.total || 0;
    const active = tQ.rows[0]?.active || 0;

    const valQ = await db.pool.query(`select coalesce(sum(usage_count)::int,0) as total_redeemed, coalesce(sum(coalesce(reward_value,0) * coalesce(usage_count,0)),0) as total_value from promotions`);
    const totalRedeemed = Number(valQ.rows[0]?.total_redeemed || 0);
    const totalValue = Number(valQ.rows[0]?.total_value || 0);

    let weeklyRedemptions = 0;
    try {
      const wr = await db.pool.query(`select count(*)::int as cnt from promos_claims where created_at >= now() - interval '7 days'`);
      weeklyRedemptions = wr.rows[0]?.cnt || 0;
    } catch (e) {
      weeklyRedemptions = 0;
    }

    const convQ = await db.pool.query(`select count(*)::int as with_usage from promotions where coalesce(usage_count,0) > 0`);
    const withUsage = convQ.rows[0]?.with_usage || 0;
    const conversionRate = total === 0 ? 0 : Math.round((withUsage / total) * 100 * 10) / 10;

    res.json({
      totalPromos: total,
      activePromos: active,
      totalRedeemed,
      totalValue,
      weeklyRedemptions,
      conversionRate
    });
  } catch (e) {
    console.error("[/promo/admin/stats] error:", e?.message || e);
    res.status(500).json({ error: getMessage('generalNetwork', 'unknownError') });
  }
});

// -----------------------------
// NON-CONFLICTING / DYNAMIC ID
// -----------------------------

// Single promo (numeric id only)
router.get("/admin/:id(\\d+)", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { rows } = await db.pool.query(`select * from promotions where id=$1 limit 1`, [id]);
    if (!rows.length) return res.status(404).json({ error: getMessage('users', 'fetchUserFailed') });
    res.json(mapPromoRow(rows[0]));
  } catch (e) {
    res.status(500).json({ error: getMessage('generalNetwork', 'unknownError') });
  }
});

// Create
router.post("/admin", async (req, res) => {
  try {
    const body = req.body || {};
    if (!body.name || !body.type) return res.status(400).json({ error: getMessage('settings', 'invalidInput') });

    const q = await db.pool.query(
      `insert into promotions
        (name, code, type, status, trigger, reward_type, reward_value, reward_unit, max_reward, min_deposit, wagering, valid_from, valid_to, usage_count, usage_limit, description, created_at, updated_at)
       values
        ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, coalesce($14,0), $15, $16, now(), now())
       returning *`,
      [
        String(body.name),
        body.code || null,
        String(body.type),
        body.status || "draft",
        body.trigger || null,
        body.rewardType || null,
        toNumberOrNull(body.rewardValue),
        body.rewardUnit || "USD",
        toNumberOrNull(body.maxReward),
        toNumberOrNull(body.minDeposit),
        toNumberOrNull(body.wagering),
        body.validFrom ? new Date(body.validFrom) : null,
        body.validTo ? new Date(body.validTo) : null,
        toNumberOrNull(body.usageCount),
        toNumberOrNull(body.usageLimit),
        body.description || null
      ]
    );
    res.json(mapPromoRow(q.rows[0]));
  } catch (e) {
    console.error("[/promo/admin POST] error:", e?.message || e);
    res.status(500).json({ error: getMessage('generalNetwork', 'unknownError') });
  }
});

// Update (numeric id)
router.put("/admin/:id(\\d+)", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const b = req.body || {};

    const sets = [];
    const vals = [id];
    let i = 1;
    function pushSet(col, val) {
      vals.push(val); i++;
      sets.push(`${col} = $${i}`);
    }

    const allowed = {
      name: "name",
      code: "code",
      type: "type",
      status: "status",
      trigger: "trigger",
      rewardType: "reward_type",
      rewardValue: "reward_value",
      rewardUnit: "reward_unit",
      maxReward: "max_reward",
      minDeposit: "min_deposit",
      wagering: "wagering",
      validFrom: "valid_from",
      validTo: "valid_to",
      usageCount: "usage_count",
      usageLimit: "usage_limit",
      description: "description",
    };

    for (const [k, col] of Object.entries(allowed)) {
      if (Object.prototype.hasOwnProperty.call(b, k)) {
        let v = b[k];
        if (k === "validFrom" || k === "validTo") v = v ? new Date(v) : null;
        if (k === "rewardValue" || k === "maxReward" || k === "minDeposit" || k === "wagering" || k === "usageCount" || k === "usageLimit") v = toNumberOrNull(v);
        pushSet(col, v);
      }
    }

    if (sets.length === 0) {
      return res.status(400).json({ error: getMessage('settings', 'invalidInput') });
    }

    sets.push(`updated_at = now()`);

    const sql = `update promotions set ${sets.join(", ")} where id = $1 returning *`;
    const { rows } = await db.pool.query(sql, vals);
    if (!rows.length) return res.status(404).json({ error: getMessage('users', 'fetchUserFailed') });
    res.json(mapPromoRow(rows[0]));
  } catch (e) {
    console.error("[/promo/admin PUT] error:", e?.message || e);
    res.status(500).json({ error: getMessage('generalNetwork', 'unknownError') });
  }
});

// Delete (numeric id)
router.delete("/admin/:id(\\d+)", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const q = await db.pool.query(`delete from promotions where id=$1`, [id]);
    if (q.rowCount === 0) return res.status(404).json({ error: getMessage('users', 'fetchUserFailed') });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: getMessage('generalNetwork', 'unknownError') });
  }
});

// Duplicate (numeric id)
router.post("/admin/:id(\\d+)/duplicate", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { rows } = await db.pool.query(`select * from promotions where id=$1 limit 1`, [id]);
    if (!rows.length) return res.status(404).json({ error: getMessage('users', 'fetchUserFailed') });
    const p = rows[0];
    const q = await db.pool.query(
      `insert into promotions (name,code,type,status,trigger,reward_type,reward_value,reward_unit,max_reward,min_deposit,wagering,valid_from,valid_to,usage_count,usage_limit,description,created_at,updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16, now(), now())
       returning *`,
      [
        String(p.name) + " (Copy)",
        p.code ? String(p.code) + "_COPY" : null,
        p.type,
        "draft",
        p.trigger,
        p.reward_type,
        p.reward_value,
        p.reward_unit,
        p.max_reward,
        p.min_deposit,
        p.wagering,
        p.valid_from,
        p.valid_to,
        0,
        p.usage_limit,
        p.description
      ]
    );
    res.json(mapPromoRow(q.rows[0]));
  } catch (e) {
    res.status(500).json({ error: getMessage('generalNetwork', 'unknownError') });
  }
});

// Toggle (numeric id)
router.post("/admin/:id(\\d+)/toggle", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { rows } = await db.pool.query(`select status from promotions where id=$1 limit 1`, [id]);
    if (!rows.length) return res.status(404).json({ error: getMessage('users', 'fetchUserFailed') });
    const newStatus = rows[0].status === "active" ? "inactive" : "active";
    const u = await db.pool.query(`update promotions set status=$1, updated_at=now() where id=$2 returning *`, [newStatus, id]);
    res.json(mapPromoRow(u.rows[0]));
  } catch (e) {
    res.status(500).json({ error: getMessage('generalNetwork', 'unknownError') });
  }
});

module.exports = router;
