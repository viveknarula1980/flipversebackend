// backend/admin_fake_balance_router.js
// Admin + public (read) endpoints for promo/fake balance & mode.

const express = require("express");
const router = express.Router();

const Promo = require("./promo_balance");

// --- Optional soft admin auth (swap with your auth if you have one)
function maybeRequireAdmin(req, res, next) {
  try {
    const need = !!process.env.ADMIN_API_KEY;
    if (!need) return next(); // dev/no auth
    const auth = String(req.headers["authorization"] || "");
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (!m) return res.status(401).json({ error: "missing authorization" });
    if (m[1] !== process.env.ADMIN_API_KEY) {
      return res.status(403).json({ error: "forbidden" });
    }
    next();
  } catch (e) {
    next(e);
  }
}

const lamportsToSol = (n) => Number(n || 0) / 1e9;

// ------------------------------------------------------------------
// Helper: broadcast latest fake status over Socket.IO (if available)
async function broadcastFakeStatus(wallet) {
  try {
    const io = global.io;
    if (!io || typeof io.to !== "function") return;
    if (!wallet) return;

    const [isFake, promoBal, effBal, frozen, withdrawals] = await Promise.all([
      Promo.isFakeMode(wallet),
      Promo.getPromoBalanceLamports(wallet),
      Promo.getEffectiveLamports(wallet),
      Promo.getFrozenForBetsLamports?.(wallet).catch?.(() => 0) ?? 0,
      Promo.isUserWithdrawalsEnabled?.(wallet).catch?.(() => true) ?? true,
    ]);

    io.to(wallet).emit("fake:status", {
      wallet,
      isFake: !!isFake,
      mode: isFake ? "fake" : "real",
      promoBalanceLamports: Number(promoBal || 0),
      promoBalanceSol: lamportsToSol(promoBal),
      effectiveBalanceLamports: Number(effBal || 0),
      effectiveBalanceSol: lamportsToSol(effBal),
      frozenLamports: Number(frozen || 0),
      frozenSol: lamportsToSol(frozen),
      withdrawalsEnabled: withdrawals !== false,
    });
  } catch (e) {
    console.warn(
      "[admin_fake_balance_router] broadcastFakeStatus error:",
      e?.message || e
    );
  }
}

// ------------------------------------------------------------------
// NEW: simple read endpoints (no auth) used by the frontend hook
// GET /admin/fake/balance?wallet=...
router.get("/balance", async (req, res) => {
  try {
    const wallet = String(req.query.wallet || "");
    if (!wallet) return res.status(400).json({ error: "wallet required" });

    const [isFake, promoBal, effBal, withdrawals] = await Promise.all([
      Promo.isFakeMode(wallet),
      Promo.getPromoBalanceLamports(wallet),
      Promo.getEffectiveLamports(wallet),
      Promo.isUserWithdrawalsEnabled?.(wallet).catch?.(() => true) ?? true,
    ]);

    res.json({
      wallet,
      isFake: !!isFake,
      mode: isFake ? "fake" : "real",
      promoBalanceLamports: Number(promoBal || 0),
      promoBalanceSol: lamportsToSol(promoBal),
      effectiveBalanceLamports: Number(effBal || 0),
      effectiveBalanceSol: lamportsToSol(effBal),
      withdrawalsEnabled: withdrawals !== false,
    });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// GET /admin/fake/status?wallet=...
router.get("/status", async (req, res) => {
  try {
    const wallet = String(req.query.wallet || "");
    if (!wallet) return res.status(400).json({ error: "wallet required" });

    const [isFake, promoBal, effBal, frozen, withdrawals] = await Promise.all([
      Promo.isFakeMode(wallet),
      Promo.getPromoBalanceLamports(wallet),
      Promo.getEffectiveLamports(wallet),
      Promo.getFrozenForBetsLamports?.(wallet).catch?.(() => 0) ?? 0,
      Promo.isUserWithdrawalsEnabled?.(wallet).catch?.(() => true) ?? true,
    ]);

    res.json({
      wallet,
      isFake: !!isFake,
      mode: isFake ? "fake" : "real",
      promoBalanceLamports: Number(promoBal || 0),
      promoBalanceSol: lamportsToSol(promoBal),
      effectiveBalanceLamports: Number(effBal || 0),
      effectiveBalanceSol: lamportsToSol(effBal),
      frozenLamports: Number(frozen || 0),
      frozenSol: lamportsToSol(frozen),
      withdrawalsEnabled: withdrawals !== false,
    });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// ------------------------------------------------------------------
// Compatibility admin endpoints (auth) — users/:id variants

// GET /admin/fake/users/:id
router.get("/users/:id", maybeRequireAdmin, async (req, res) => {
  try {
    const id = String(req.params.id);
    const [isFake, promo, eff] = await Promise.all([
      Promo.isFakeMode(id),
      Promo.getPromoBalanceLamports(id),
      Promo.getEffectiveLamports(id),
    ]);
    res.json({
      wallet: id,
      useFake: !!isFake,
      promoBalanceLamports: Number(promo || 0),
      effectiveBalanceLamports: Number(eff || 0),
    });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// PUT /admin/fake/users/:id/promo-balance
// Body: { type: "add"|"subtract", amountUsd?: number, amountLamports?: number, reason?: string }
router.put("/users/:id/promo-balance", maybeRequireAdmin, async (req, res) => {
  try {
    const id = String(req.params.id);
    const { type, amountUsd, amountLamports, reason } = req.body || {};
    let lamports = 0;

    if (amountLamports != null) {
      lamports = Math.round(Number(amountLamports));
    } else if (amountUsd != null) {
      const price = Number(process.env.USD_PER_SOL || 200);
      lamports = Math.round((Number(amountUsd) / (price || 1)) * 1e9);
    } else {
      return res.status(400).json({ error: "amountUsd or amountLamports required" });
    }

    if (!Number.isFinite(lamports) || lamports <= 0) {
      return res.status(400).json({ error: "amount must be > 0" });
    }

    const signed =
      String(type).toLowerCase() === "subtract" ? -lamports : lamports;

    const newBal = await Promo.adjustPromoBalanceLamports(
      id,
      signed,
      `admin_promo_${String(type || "add").toLowerCase()}${
        reason ? `: ${String(reason).slice(0, 200)}` : ""
      }`
    );

    const isFake = await Promo.isFakeMode(id);
    res.json({
      ok: true,
      wallet: id,
      useFake: !!isFake,
      newPromoBalanceLamports: Number(newBal || 0),
      newPromoBalanceSol: lamportsToSol(newBal),
    });

    // push latest status to this wallet over WS
    broadcastFakeStatus(id);
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// PUT /admin/fake/users/:id/fake-mode
// Body: { enabled: boolean, reason?: string }
router.put("/users/:id/fake-mode", maybeRequireAdmin, async (req, res) => {
  try {
    const id = String(req.params.id);
    const { enabled } = req.body || {};
    const out = await Promo.setFakeMode(id, !!enabled);
    res.json(out);

    // broadcast new status
    broadcastFakeStatus(id);
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// PUT /admin/fake/users/:id/withdrawals
// Body: { withdrawalsEnabled: boolean, reason?: string }
router.put("/users/:id/withdrawals", maybeRequireAdmin, async (req, res) => {
  try {
    const id = String(req.params.id);
    const { withdrawalsEnabled } = req.body || {};
    const out = await Promo.updateWithdrawalPermissions(
      id,
      !!withdrawalsEnabled
    );
    res.json(out);

    // broadcast new status
    broadcastFakeStatus(id);
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// ------------------------------------------------------------------
// Extra admin shortcuts (auth) — grant/take/mode by body.wallet

// POST /admin/fake/grant { wallet, amountLamports?: number, amountSol?: number }
router.post("/grant", maybeRequireAdmin, async (req, res) => {
  try {
    const wallet = String(req.body?.wallet || "");
    if (!wallet) return res.status(400).json({ error: "wallet required" });

    let lamports = Number(req.body?.amountLamports || 0);
    if (!lamports && req.body?.amountSol)
      lamports = Math.floor(Number(req.body.amountSol) * 1e9);
    if (!(lamports > 0))
      return res.status(400).json({ error: "positive amount required" });

    const newBal = await Promo.adjustPromoBalanceLamports(
      wallet,
      lamports,
      "admin_promo_grant"
    );
    const isFake = await Promo.isFakeMode(wallet);
    res.json({
      ok: true,
      wallet,
      useFake: !!isFake,
      promoBalanceLamports: Number(newBal || 0),
      promoBalanceSol: lamportsToSol(newBal),
    });

    // notify this wallet
    broadcastFakeStatus(wallet);
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// POST /admin/fake/take { wallet, amountLamports?: number, amountSol?: number }
router.post("/take", maybeRequireAdmin, async (req, res) => {
  try {
    const wallet = String(req.body?.wallet || "");
    if (!wallet) return res.status(400).json({ error: "wallet required" });

    let lamports = Number(req.body?.amountLamports || 0);
    if (!lamports && req.body?.amountSol)
      lamports = Math.floor(Number(req.body.amountSol) * 1e9);
    if (!(lamports > 0))
      return res.status(400).json({ error: "positive amount required" });

    const newBal = await Promo.adjustPromoBalanceLamports(
      wallet,
      -lamports,
      "admin_promo_take"
    );
    const isFake = await Promo.isFakeMode(wallet);
    res.json({
      ok: true,
      wallet,
      useFake: !!isFake,
      promoBalanceLamports: Number(newBal || 0),
      promoBalanceSol: lamportsToSol(newBal),
    });

    // notify this wallet
    broadcastFakeStatus(wallet);
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// POST /admin/fake/mode { wallet, useFake: boolean }
router.post("/mode", maybeRequireAdmin, async (req, res) => {
  try {
    const wallet = String(req.body?.wallet || "");
    const useFake = !!req.body?.useFake;
    if (!wallet) return res.status(400).json({ error: "wallet required" });

    await Promo.setFakeMode(wallet, useFake);
    const bal = await Promo.getPromoBalanceLamports(wallet);
    res.json({
      ok: true,
      wallet,
      isFake: !!useFake,
      promoBalanceLamports: Number(bal || 0),
      promoBalanceSol: lamportsToSol(bal),
    });

    // notify this wallet
    broadcastFakeStatus(wallet);
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

module.exports = router;
