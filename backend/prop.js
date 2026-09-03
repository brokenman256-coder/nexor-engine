// Extra module: Nexora Prop desk (from crypto_prop_firm). Does not touch matching, ticks, or wallet verify.
const store = require("./store");

const TIERS = {
  "10k": { initial: 10000, target: 1000, maxDrawdown: 1000, dailyDrawdown: 500, label: "Starter" },
  "50k": { initial: 50000, target: 5000, maxDrawdown: 5000, dailyDrawdown: 2500, label: "Professional" },
  "100k": { initial: 100000, target: 10000, maxDrawdown: 10000, dailyDrawdown: 5000, label: "Elite" }
};

function publicChallenge(c) {
  if (!c) return null;
  return {
    id: c.id,
    userId: c.userId,
    username: c.username,
    tier: c.tier,
    label: (TIERS[c.tier] || {}).label || c.tier,
    initialBalance: c.initialBalance,
    targetProfit: c.targetProfit,
    maxDrawdown: c.maxDrawdown,
    dailyDrawdown: c.dailyDrawdown,
    currentEquity: c.currentEquity,
    status: c.status,
    stage: c.stage,
    isTrial: !!c.isTrial,
    createdAt: c.createdAt,
    profitSplit: c.profitSplit
  };
}

function seedBook(user, usd) {
  user.balances = { USDT: Number(usd) || 0, BTC: 0, ETH: 0 };
  user.startingEquity = Number(usd) || 0;
  store.saveUser(user);
}

function ensureDesk(owner, usd) {
  const uname = ("px" + String(owner._id)).replace(/[^a-z0-9]/gi, "").toLowerCase().slice(0, 18);
  let u = store.getUserByUsername(uname);
  if (!u) {
    u = store.createUser({
      username: uname,
      password: "prop-desk",
      role: "user",
      balances: { USDT: Number(usd) || 0, BTC: 0, ETH: 0 },
      startingEquity: Number(usd) || 0
    });
  } else {
    seedBook(u, usd);
  }
  return u;
}

function startChallenge(user, tier, isTrial, referrerId) {
  const cfg = TIERS[tier];
  if (!cfg) throw new Error("Unknown tier");
  const prop = store.getProp();
  if (!prop.enabled) throw new Error("Prop desk is closed");
  const existing = store.getPropChallengeByUser(user._id);
  if (existing && existing.status === "active") throw new Error("You already have an active challenge");
  const desk = ensureDesk(user, cfg.initial);
  const row = store.createPropChallenge({
    userId: user._id,
    propUserId: desk._id,
    username: user.username,
    tier,
    initialBalance: cfg.initial,
    targetProfit: cfg.target,
    maxDrawdown: cfg.maxDrawdown,
    dailyDrawdown: cfg.dailyDrawdown,
    dailyStartBalance: cfg.initial,
    currentEquity: cfg.initial,
    status: "active",
    stage: 1,
    isTrial: !!isTrial,
    profitSplit: prop.profitSplit
  });
  if (referrerId && referrerId !== user._id) store.addPropCommission(referrerId, ((prop.pricing[tier] || {}).entry || 0) * 0.15);
  return row;
}

function evaluate(c, equity) {
  if (!c || c.status !== "active") return c;
  const now = Date.now();
  const day = new Date().toISOString().slice(0, 10);
  if (c.dayKey !== day) {
    c.dayKey = day;
    c.dailyStartBalance = equity;
  }
  c.currentEquity = equity;
  c.lastChecked = now;
  if (equity <= c.initialBalance - c.maxDrawdown) {
    c.status = "failed";
    c.failReason = "Max drawdown";
  } else if (equity <= c.dailyStartBalance - c.dailyDrawdown) {
    c.status = "failed";
    c.failReason = "Daily drawdown";
  } else if (equity >= c.initialBalance + c.targetProfit) {
    c.status = "passed";
  }
  return store.savePropChallenge(c);
}

function watch(getPrices, equityFn) {
  const prop = store.getProp();
  if (!prop.autoWatch) return;
  const prices = getPrices();
  store.listPropChallenges().forEach(c => {
    if (c.status !== "active") return;
    const desk = store.getUserById(c.propUserId || c.userId);
    if (!desk) return;
    evaluate(c, equityFn(desk, prices));
  });
}

function guardTrade(req, res, next) {
  const c = store.getPropChallengeByUser(req.auth && req.auth.id);
  if (c && (c.status === "failed" || c.locked)) {
    return res.status(403).json({ error: "Prop account locked (" + (c.failReason || c.status) + ")" });
  }
  next();
}

function attach(app, deps) {
  const { authenticate, isAdmin, equity, getPrices, executeTrade } = deps;

  app.get("/api/prop/public", (req, res) => {
    const p = store.getProp();
    res.json({
      brand: "Nexora Prop",
      enabled: !!p.enabled,
      profitSplit: p.profitSplit,
      pricing: p.pricing,
      tiers: Object.entries(TIERS).map(([id, t]) => ({
        id, label: t.label, account: t.initial, target: t.target, maxDrawdown: t.maxDrawdown, dailyDrawdown: t.dailyDrawdown, entry: (p.pricing[id] || {}).entry || 0
      })),
      leaderboard: store.listPropChallenges()
        .filter(c => c.status === "active" || c.status === "passed" || c.stage === "funded")
        .sort((a, b) => (b.currentEquity || 0) - (a.currentEquity || 0))
        .slice(0, 10)
        .map(c => ({ username: c.username, equity: c.currentEquity, tier: c.tier, status: c.status, stage: c.stage }))
    });
  });

  app.get("/api/prop/me", authenticate, (req, res) => {
    const c = store.getPropChallengeByUser(req.auth.id);
    const ref = store.getPropReferral(req.auth.id);
    const desk = c && store.getUserById(c.propUserId);
    res.json({
      challenge: publicChallenge(c),
      referral: ref,
      link: "/prop?ref=" + req.auth.id,
      tradeUrl: "/?book=prop",
      balances: desk ? desk.balances : null,
      locked: !!(c && (c.status === "failed" || c.locked))
    });
  });

  app.post("/api/prop/trade", authenticate, async (req, res) => {
    try {
      const c = store.getPropChallengeByUser(req.auth.id);
      if (!c || !c.propUserId) return res.status(400).json({ error: "No active prop desk. Open a seat first." });
      if (c.status === "failed" || c.locked) return res.status(403).json({ error: "Prop account locked (" + (c.failReason || c.status) + ")" });
      if (c.status !== "active" && c.stage !== "funded") return res.status(400).json({ error: "Desk is not trading" });
      const { symbol, type, amount } = req.body || {};
      if (!symbol) return res.status(400).json({ error: "Symbol is required" });
      const result = await executeTrade(c.propUserId, symbol, type, amount);
      const desk = store.getUserById(c.propUserId);
      if (desk) evaluate(c, equity(desk, getPrices()));
      res.json(result);
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.get("/api/prop/trades", authenticate, (req, res) => {
    const c = store.getPropChallengeByUser(req.auth.id);
    if (!c || !c.propUserId) return res.json([]);
    res.json(store.tradesOf(c.propUserId, 50));
  });

  app.post("/api/prop/start", authenticate, (req, res) => {
    try {
      const user = store.getUserById(req.auth.id);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      const { tier, trial } = req.body || {};
      const row = startChallenge(user, String(tier || ""), !!trial, req.body && req.body.ref);
      res.json({ ok: true, challenge: publicChallenge(row), balances: user.balances });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.post("/api/prop/payout", authenticate, (req, res) => {
    const c = store.getPropChallengeByUser(req.auth.id);
    if (!c || c.stage !== "funded") return res.status(400).json({ error: "Funded desk only" });
    const user = store.getUserById(req.auth.id);
    const qty = Number(req.body && req.body.qty);
    if (!qty || qty <= 0) return res.status(400).json({ error: "Invalid amount" });
    const profit = Math.max(0, (c.currentEquity || 0) - c.initialBalance);
    const take = Math.min(qty, profit * (c.profitSplit || 0.8));
    if (take <= 0) return res.status(400).json({ error: "No payable profit" });
    const p = store.createPropPayout({ userId: user._id, username: user.username, challengeId: c.id, qty: take, status: "pending" });
    res.json({ ok: true, payout: p });
  });

  app.get("/api/admin/prop", authenticate, isAdmin, (req, res) => {
    const p = store.getProp();
    res.json({
      enabled: p.enabled,
      autoWatch: p.autoWatch,
      profitSplit: p.profitSplit,
      pricing: p.pricing,
      challenges: store.listPropChallenges().map(publicChallenge),
      payouts: store.listPropPayouts()
    });
  });

  app.patch("/api/admin/prop", authenticate, isAdmin, (req, res) => {
    const p = store.patchProp(req.body || {});
    res.json({ enabled: p.enabled, autoWatch: p.autoWatch, profitSplit: p.profitSplit, pricing: p.pricing });
  });

  app.post("/api/admin/prop/promote", authenticate, isAdmin, (req, res) => {
    const c = store.getPropChallengeById(req.body && req.body.id);
    if (!c) return res.status(404).json({ error: "Not found" });
    const desk = store.getUserById(c.propUserId);
    if (c.stage === 1) {
      c.stage = 2;
      c.status = "active";
      c.locked = false;
      c.failReason = null;
      if (desk) seedBook(desk, c.initialBalance);
      c.currentEquity = c.initialBalance;
      c.dailyStartBalance = c.initialBalance;
    } else if (c.stage === 2 || c.status === "passed") {
      c.stage = "funded";
      c.status = "active";
    } else {
      return res.status(400).json({ error: "Already funded" });
    }
    store.savePropChallenge(c);
    res.json({ ok: true, challenge: publicChallenge(c) });
  });

  app.post("/api/admin/prop/fail", authenticate, isAdmin, (req, res) => {
    const c = store.getPropChallengeById(req.body && req.body.id);
    if (!c) return res.status(404).json({ error: "Not found" });
    c.status = "failed";
    c.locked = true;
    c.failReason = (req.body && req.body.reason) || "Admin";
    store.savePropChallenge(c);
    res.json({ ok: true, challenge: publicChallenge(c) });
  });

  app.post("/api/admin/prop/payouts/:id/approve", authenticate, isAdmin, (req, res) => {
    const p = store.getPropPayout(req.params.id);
    if (!p || p.status !== "pending") return res.status(400).json({ error: "Not pending" });
    const c = store.getPropChallengeById(p.challengeId);
    const desk = store.getUserById(c && c.propUserId);
    if (desk) {
      desk.balances = desk.balances || {};
      desk.balances.USDT = Math.max(0, Number(desk.balances.USDT || 0) - p.qty);
      store.saveUser(desk);
    }
    p.status = "approved";
    p.settledAt = new Date().toISOString();
    store.savePropPayout(p);
    res.json({ ok: true, payout: p });
  });

  app.post("/api/admin/prop/payouts/:id/reject", authenticate, isAdmin, (req, res) => {
    const p = store.getPropPayout(req.params.id);
    if (!p || p.status !== "pending") return res.status(400).json({ error: "Not pending" });
    p.status = "rejected";
    p.settledAt = new Date().toISOString();
    store.savePropPayout(p);
    res.json({ ok: true, payout: p });
  });

  setInterval(() => {
    try { watch(getPrices, equity); } catch (e) {}
  }, 4000);
}

module.exports = { attach, guardTrade, TIERS };
