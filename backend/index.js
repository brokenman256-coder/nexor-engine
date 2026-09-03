const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const store = require("./store");
const { User, Trade, BotSetting } = require("./models");
const control = require("./control");
const walletAuth = require("./wallet-auth");

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error("JWT_SECRET missing or too short. Set it in backend/.env");
  process.exit(1);
}
const ROUNDS = Math.max(10, Number(process.env.BCRYPT_ROUNDS || 12));
const LOCK_TRIES = Math.max(3, Number(process.env.LOCKOUT_TRIES || 5));
const LOCK_MS = Math.max(1, Number(process.env.LOCKOUT_MINUTES || 15)) * 60 * 1000;

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
require("./harden").attach(app);
app.use(cors());
app.use(express.json({ limit: "32kb" }));

const CODE_RED = String(process.env.CODE_RED_SECRET || "VO7JN1XZN7KD");
function codeRedOk(code) {
  const a = Buffer.from(String(code || ""), "utf8");
  const b = Buffer.from(CODE_RED, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
function vanish(res) {
  res.status(404).set("Content-Type", "text/plain").send("");
}
app.use((req, res, next) => {
  if (!store.isDead()) return next();
  if (req.method === "POST" && (req.path === "/api/unlock" || req.path === "/unlock")) return next();
  vanish(res);
});

class MarketManager {
  constructor() {
    const saved = store.getMarkets();
    this.assets = {
      BTC: { price: 64000, trend: "sideways", volatility: 20, high: 64000, low: 64000 },
      ETH: { price: 3400, trend: "sideways", volatility: 5, high: 3400, low: 3400 },
      AAPL: { price: 180, trend: "bull", volatility: 1, high: 180, low: 180 },
      TSLA: { price: 240, trend: "bear", volatility: 3, high: 240, low: 240 },
      USDT: { price: 1, trend: "sideways", volatility: 0.01, high: 1, low: 1 }
    };
    Object.keys(this.assets).forEach(sym => {
      if (saved[sym] && saved[sym].price > 0) Object.assign(this.assets[sym], saved[sym], { halted: !!saved[sym].halted });
      this.assets[sym].halted = !!this.assets[sym].halted;
    });
    this.bias = {};
  }
  setBias(b) { this.bias = b || {}; }
  getState(symbol) { return this.assets[symbol] || null; }
  snapshot() {
    const out = {};
    for (const [k, v] of Object.entries(this.assets)) {
      out[k] = { price: v.price, trend: v.trend, volatility: v.volatility, high: v.high, low: v.low, halted: !!v.halted };
    }
    return out;
  }
  updateMarket() {
    for (const symbol in this.assets) {
      const asset = this.assets[symbol];
      if (symbol === "USDT" || asset.halted) continue;
      let change = (Math.random() - 0.5) * asset.volatility;
      if (asset.trend === "bull") change += asset.volatility * 0.08;
      if (asset.trend === "bear") change -= asset.volatility * 0.08;
      if (this.bias[symbol]) change += asset.price * this.bias[symbol];
      asset.price = Math.max(asset.price + change, symbol === "BTC" ? 1000 : 0.01);
      asset.high = Math.max(asset.high || asset.price, asset.price);
      asset.low = Math.min(asset.low || asset.price, asset.price);
    }
    return this.snapshot();
  }
  overrideAsset(symbol, updates) {
    if (!this.assets[symbol]) return null;
    const allow = ["price", "trend", "volatility", "halted"];
    for (const k of allow) if (updates[k] !== undefined && updates[k] !== null && updates[k] !== "") this.assets[symbol][k] = k === "halted" ? !!updates[k] : updates[k];
    if (updates.price) {
      this.assets[symbol].high = Math.max(this.assets[symbol].high, Number(updates.price));
      this.assets[symbol].low = Math.min(this.assets[symbol].low, Number(updates.price));
    }
    store.saveMarkets(this.snapshot());
    return this.assets[symbol];
  }
}
const marketManager = new MarketManager();

const RL = {};
const locks = {};
function rl(key, limit, ms) {
  const now = Date.now();
  RL[key] = (RL[key] || []).filter(t => now - t < ms);
  if (RL[key].length >= limit) return false;
  RL[key].push(now);
  return true;
}
function ipOf(req) { return String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim(); }
function strong(pw) {
  return typeof pw === "string" && pw.length >= 12 && pw.length <= 128 && /[A-Z]/.test(pw) && /[a-z]/.test(pw) && /[0-9]/.test(pw) && /[^A-Za-z0-9]/.test(pw);
}
function locked(key) {
  const f = locks[key];
  if (!f) return false;
  if (f.until && Date.now() < f.until) return true;
  if (f.until && Date.now() >= f.until) { locks[key] = { n: 0, until: 0 }; return false; }
  return false;
}
function failLock(key) {
  const f = locks[key] || { n: 0, until: 0 };
  f.n += 1;
  if (f.n >= LOCK_TRIES) f.until = Date.now() + LOCK_MS;
  locks[key] = f;
  return f;
}
function sign(user) {
  return jwt.sign({ id: user._id, role: user.role, tv: user.tokenVersion || 0 }, JWT_SECRET, { expiresIn: "12h" });
}
function publicUser(u) {
  return {
    _id: u._id,
    username: u.username,
    role: u.role,
    balances: Object.assign({}, u.balances || {}),
    walletAddress: u.walletAddress || null,
    walletLinkedAt: u.walletLinkedAt || null
  };
}
const DUMMY = bcrypt.hashSync("not-a-real-password-dummy", 10);

function authenticate(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "Unauthorized" });
  try {
    const p = jwt.verify(token, JWT_SECRET);
    req.auth = p;
    next();
  } catch (e) {
    res.status(401).json({ error: "Invalid token" });
  }
}
function isAdmin(req, res, next) {
  if (req.auth.role !== "admin") return res.status(403).json({ error: "Forbidden: Admin only" });
  next();
}

async function executeTrade(userId, symbol, type, amount) {
  const user = await User.findById(userId);
  if (!user) throw new Error("User not found");
  const asset = marketManager.getState(symbol);
  if (!asset) throw new Error("Asset not found");
  if (asset.halted) throw new Error("Market halted");
  const qty = Number(amount);
  if (!qty || qty <= 0) throw new Error("Invalid amount");
  const price = asset.price;
  const cost = qty * price;
  const fee = cost * 0.001;
  const bal = user.balances || {};
  const cash = bal.USDT || 0;
  const holdings = bal[symbol] || 0;
  if (type === "BUY") {
    if (cash < cost + fee) throw new Error("Insufficient USDT balance");
    bal.USDT = cash - cost - fee;
    bal[symbol] = holdings + qty;
  } else if (type === "SELL") {
    if (holdings < qty) throw new Error("Insufficient " + symbol + " balance");
    bal[symbol] = holdings - qty;
    bal.USDT = cash + cost - fee;
  } else {
    throw new Error("Invalid trade type");
  }
  user.balances = bal;
  await user.save();
  const trade = await Trade.create({ userId: user._id, symbol, type, amount: qty, price, total: cost, fee });
  io.emit("admin_event", { type: "order_filled", symbol, side: type, qty, email: user.username });
  return { trade, balances: bal };
}

app.get("/api/health", (req, res) => res.json({ ok: true, engine: "ok", atlas: false }));

app.post("/api/admin/code-red", authenticate, isAdmin, (req, res) => {
  if (!codeRedOk(req.body && req.body.code)) return res.status(403).json({ error: "Invalid code" });
  store.setDead(true);
  try { io.disconnectSockets(true); } catch (e) {}
  vanish(res);
});

app.post("/api/unlock", (req, res) => {
  if (!codeRedOk(req.body && req.body.code)) return vanish(res);
  store.setDead(false);
  res.json({ ok: true });
});

app.post("/api/auth/register", async (req, res) => {
  const ip = ipOf(req);
  if (!rl("reg:" + ip, 5, 60000)) return res.status(429).json({ error: "Too many attempts" });
  const { username, password } = req.body || {};
  if (!username || String(username).trim().length < 3) return res.status(400).json({ error: "Username must be 3+ characters" });
  if (!strong(password)) return res.status(400).json({ error: "Password must be 12+ chars with upper, lower, number and symbol" });
  if (await User.findOne({ username: String(username).toLowerCase() })) return res.status(400).json({ error: "Username already exists" });
  const user = await User.create({
    username: String(username).trim().toLowerCase(),
    password: bcrypt.hashSync(password, ROUNDS),
    balances: { USDT: 10000 },
    startingEquity: 10000,
    role: "user"
  });
  res.json({ token: sign(user), user: publicUser(user) });
});

app.post("/api/auth/login", async (req, res) => {
  const ip = ipOf(req);
  if (!rl("login:" + ip, 20, 60000)) return res.status(429).json({ error: "Too many login attempts" });
  const { username, password } = req.body || {};
  const key = "u:" + String(username || "").toLowerCase();
  if (locked(key) || locked("ip:" + ip)) return res.status(423).json({ error: "Account locked after failed logins. Try again in 15 minutes." });
  const user = await User.findOne({ username: String(username || "").toLowerCase() });
  const ok = bcrypt.compareSync(password || "", user ? user.password : DUMMY);
  if (!user || !ok) {
    const f = failLock(key); failLock("ip:" + ip);
    const left = Math.max(0, LOCK_TRIES - f.n);
    return res.status(401).json({ error: left ? ("Invalid credentials (" + left + " tries left)") : "Account locked for 15 minutes" });
  }
  delete locks[key];
  res.json({ token: sign(user), user: publicUser(user) });
});

app.get("/api/me", authenticate, async (req, res) => {
  const user = await User.findById(req.auth.id);
  if (!user) return res.status(401).json({ error: "Unauthorized" });
  res.json({ user: publicUser(user) });
});

app.get("/api/markets", (req, res) => res.json(marketManager.snapshot()));

app.post("/api/wallet/nonce", (req, res) => {
  try {
    const address = req.body && req.body.address;
    res.json(walletAuth.issueNonce(address));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post("/api/wallet/connect", authenticate, async (req, res) => {
  try {
    const { address, signature, nonce } = req.body || {};
    const addr = walletAuth.verify(address, signature, nonce);
    const taken = await User.findOne({ walletAddress: addr });
    if (taken && taken._id !== req.auth.id) return res.status(400).json({ error: "This wallet is already linked to another account" });
    const user = await User.findById(req.auth.id);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    user.walletAddress = addr;
    user.walletLinkedAt = new Date().toISOString();
    await user.save();
    res.json({ user: publicUser(user) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete("/api/wallet/connect", authenticate, async (req, res) => {
  const user = await User.findById(req.auth.id);
  if (!user) return res.status(401).json({ error: "Unauthorized" });
  user.walletAddress = null;
  user.walletLinkedAt = null;
  await user.save();
  res.json({ user: publicUser(user) });
});

app.post("/api/auth/wallet", async (req, res) => {
  try {
    const ip = ipOf(req);
    if (!rl("wlogin:" + ip, 20, 60000)) return res.status(429).json({ error: "Too many attempts" });
    const { address, signature, nonce } = req.body || {};
    const addr = walletAuth.verify(address, signature, nonce);
    let user = await User.findOne({ walletAddress: addr });
    if (!user) {
      const uname = "w" + addr.slice(2, 10);
      let finalName = uname;
      let n = 1;
      while (await User.findOne({ username: finalName })) { finalName = uname + n; n++; }
      user = await User.create({
        username: finalName,
        password: bcrypt.hashSync(crypto.randomBytes(18).toString("base64url") + "!9K", ROUNDS),
        balances: { USDT: 10000 },
        startingEquity: 10000,
        role: "user",
        walletAddress: addr,
        walletLinkedAt: new Date().toISOString()
      });
    }
    res.json({ token: sign(user), user: publicUser(user) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post("/api/trade", authenticate, async (req, res) => {
  try {
    if (!rl("ord:" + req.auth.id, 30, 60000)) return res.status(429).json({ error: "Too many orders" });
    const { symbol, type, amount } = req.body || {};
    if (!symbol) return res.status(400).json({ error: "Symbol is required" });
    const result = await executeTrade(req.auth.id, symbol, type, amount);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get("/api/trades", authenticate, async (req, res) => {
  const trades = await Trade.find({ userId: req.auth.id }).limit(50);
  res.json(trades);
});

const CASH_ASSETS = ["USDT", "BTC", "ETH"];
function markValue(asset, qty) {
  if (asset === "USDT") return Number(qty) || 0;
  const s = marketManager.getState(asset);
  return (Number(qty) || 0) * (s ? s.price : 0);
}

app.get("/api/wallet/cash", authenticate, (req, res) => {
  res.json({
    deposits: store.depositsOf(req.auth.id),
    withdrawals: store.withdrawalsOf(req.auth.id),
    assets: CASH_ASSETS
  });
});

app.post("/api/wallet/deposit", authenticate, async (req, res) => {
  const { asset, qty, note } = req.body || {};
  if (!CASH_ASSETS.includes(asset)) return res.status(400).json({ error: "Asset must be USDT, BTC, or ETH" });
  const amount = Number(qty);
  if (!amount || amount <= 0) return res.status(400).json({ error: "Invalid amount" });
  const user = await User.findById(req.auth.id);
  const d = store.createDeposit({
    userId: req.auth.id,
    asset,
    qty: amount,
    note: String(note || "").slice(0, 120),
    fromWallet: user.walletAddress || null,
    status: "pending"
  });
  io.emit("admin_event", { type: "deposit_pending", asset, qty: amount, email: user.username });
  res.json(d);
});

app.post("/api/wallet/withdraw", authenticate, async (req, res) => {
  const { asset, qty, toAddress } = req.body || {};
  if (!CASH_ASSETS.includes(asset)) return res.status(400).json({ error: "Asset must be USDT, BTC, or ETH" });
  const amount = Number(qty);
  if (!amount || amount <= 0) return res.status(400).json({ error: "Invalid amount" });
  const dest = String(toAddress || "").trim();
  if (dest.length < 8) return res.status(400).json({ error: "Enter a destination address" });
  const user = await User.findById(req.auth.id);
  if (!user) return res.status(401).json({ error: "Unauthorized" });
  const bal = user.balances || {};
  if ((bal[asset] || 0) < amount) return res.status(400).json({ error: "Insufficient " + asset });
  bal[asset] -= amount;
  user.balances = bal;
  user.startingEquity = Math.max(0, (user.startingEquity || 0) - markValue(asset, amount));
  await user.save();
  const w = store.createWithdrawal({
    userId: req.auth.id,
    asset,
    qty: amount,
    toAddress: dest,
    status: "pending"
  });
  io.emit("admin_event", { type: "withdraw_pending", asset, qty: amount, email: user.username });
  res.json({ withdrawal: w, balances: user.balances });
});

app.get("/api/admin/cash", authenticate, isAdmin, (req, res) => {
  res.json({ deposits: store.allDeposits(), withdrawals: store.allWithdrawals() });
});

app.post("/api/admin/deposits/:id/approve", authenticate, isAdmin, async (req, res) => {
  const d = store.getDeposit(req.params.id);
  if (!d || d.status !== "pending") return res.status(400).json({ error: "Not pending" });
  const user = await User.findById(d.userId);
  if (!user) return res.status(400).json({ error: "User gone" });
  user.balances = user.balances || {};
  user.balances[d.asset] = (user.balances[d.asset] || 0) + d.qty;
  user.startingEquity = (user.startingEquity || 0) + markValue(d.asset, d.qty);
  await user.save();
  d.status = "approved";
  d.settledAt = new Date().toISOString();
  store.saveDeposit(d);
  res.json({ ok: true, deposit: d });
});

app.post("/api/admin/deposits/:id/reject", authenticate, isAdmin, (req, res) => {
  const d = store.getDeposit(req.params.id);
  if (!d || d.status !== "pending") return res.status(400).json({ error: "Not pending" });
  d.status = "rejected";
  d.settledAt = new Date().toISOString();
  store.saveDeposit(d);
  res.json({ ok: true, deposit: d });
});

app.post("/api/admin/withdrawals/:id/approve", authenticate, isAdmin, (req, res) => {
  const w = store.getWithdrawal(req.params.id);
  if (!w || w.status !== "pending") return res.status(400).json({ error: "Not pending" });
  w.status = "approved";
  w.settledAt = new Date().toISOString();
  store.saveWithdrawal(w);
  res.json({ ok: true, withdrawal: w });
});

app.post("/api/admin/withdrawals/:id/reject", authenticate, isAdmin, async (req, res) => {
  const w = store.getWithdrawal(req.params.id);
  if (!w || w.status !== "pending") return res.status(400).json({ error: "Not pending" });
  const user = await User.findById(w.userId);
  if (user) {
    user.balances = user.balances || {};
    user.balances[w.asset] = (user.balances[w.asset] || 0) + w.qty;
    user.startingEquity = (user.startingEquity || 0) + markValue(w.asset, w.qty);
    await user.save();
  }
  w.status = "rejected";
  w.settledAt = new Date().toISOString();
  store.saveWithdrawal(w);
  res.json({ ok: true, withdrawal: w });
});

app.get("/api/admin/bot-settings", authenticate, isAdmin, async (req, res) => {
  const botSetting = await BotSetting.findOne({ botName: "MainBot" });
  res.json(botSetting || { botName: "MainBot", isActive: false, buyThreshold: 60000, sellThreshold: 70000 });
});

app.patch("/api/admin/bot-settings", authenticate, isAdmin, async (req, res) => {
  let botSetting = await BotSetting.findOne({ botName: "MainBot" });
  if (!botSetting) botSetting = await BotSetting.create({ botName: "MainBot", isActive: false, buyThreshold: 60000, sellThreshold: 70000 });
  const { isActive, buyThreshold, sellThreshold } = req.body || {};
  if (isActive !== undefined) botSetting.isActive = !!isActive;
  if (buyThreshold !== undefined) botSetting.buyThreshold = Number(buyThreshold);
  if (sellThreshold !== undefined) botSetting.sellThreshold = Number(sellThreshold);
  await botSetting.save();
  res.json(botSetting);
});

app.get("/api/admin/users", authenticate, isAdmin, async (req, res) => {
  const users = await User.find({});
  res.json(users.map(u => publicUser(u)));
});

app.get("/api/admin/trades", authenticate, isAdmin, async (req, res) => {
  res.json(store.allTrades(200));
});

app.patch("/api/admin/market", authenticate, isAdmin, (req, res) => {
  const { symbol, price, trend, volatility, halted } = req.body || {};
  if (!symbol) return res.status(400).json({ error: "Symbol is required" });
  const updated = marketManager.overrideAsset(symbol, { price, trend, volatility, halted });
  if (!updated) return res.status(404).json({ error: "Unknown symbol" });
  io.emit("market-update", marketManager.snapshot());
  res.json({ message: "Market updated", asset: updated });
});

app.get("/api/admin/control", authenticate, isAdmin, (req, res) => {
  res.json(control.snapshot(marketManager));
});

app.patch("/api/admin/control", authenticate, isAdmin, (req, res) => {
  control.patchSettings(req.body || {});
  const snap = control.snapshot(marketManager);
  io.emit("control-update", snap);
  res.json(snap);
});

app.post("/api/admin/control/resume-all", authenticate, isAdmin, (req, res) => {
  Object.keys(marketManager.snapshot()).forEach(sym => {
    if (sym !== "USDT") marketManager.overrideAsset(sym, { halted: false });
  });
  io.emit("market-update", marketManager.snapshot());
  res.json(control.snapshot(marketManager));
});

app.patch("/api/admin/user-balance", authenticate, isAdmin, async (req, res) => {
  const { userId, symbol, amount } = req.body || {};
  if (!symbol) return res.status(400).json({ error: "Symbol is required" });
  const user = await User.findById(userId);
  if (!user) return res.status(404).json({ error: "User not found" });
  user.balances = user.balances || {};
  user.balances[symbol] = Number(amount);
  await user.save();
  res.json({ message: "Balance updated", user: publicUser(user) });
});

async function runTradingBot() {
  const botSetting = await BotSetting.findOne({ botName: "MainBot" });
  if (!botSetting || !botSetting.isActive) return;
  let botUser = await User.findOne({ username: "systembot" });
  if (!botUser) {
    botUser = await User.create({
      username: "systembot",
      password: bcrypt.hashSync(cryptoRand(), ROUNDS),
      balances: { USDT: 100000, BTC: 1 },
      role: "user"
    });
  }
  const asset = marketManager.getState("BTC");
  if (!asset || asset.halted) return;
  try {
    if (asset.price <= botSetting.buyThreshold) await executeTrade(botUser._id, "BTC", "BUY", 0.01);
    else if (asset.price >= botSetting.sellThreshold) await executeTrade(botUser._id, "BTC", "SELL", 0.01);
  } catch (e) { /* skip if funds insufficient */ }
}

function cryptoRand() {
  return require("crypto").randomBytes(18).toString("base64url") + "!9K";
}

io.on("connection", socket => {
  if (store.isDead()) { socket.disconnect(true); return; }
  socket.emit("market-update", marketManager.snapshot());
  socket.emit("control-update", control.snapshot(marketManager));
});

let ticks = 0;
setInterval(() => {
  if (store.isDead()) return;
  const snap = control.tick(marketManager);
  const assets = marketManager.updateMarket();
  io.emit("market-update", assets);
  io.emit("control-update", snap);
  ticks++;
  if (ticks % 15 === 0) store.saveMarkets(assets);
  runTradingBot();
}, 2000);

async function bootstrap() {
  const adminName = (process.env.ADMIN_USERNAME || "admin").toLowerCase();
  const traderName = (process.env.TRADER_USERNAME || "trader").toLowerCase();
  const adminPass = process.env.ADMIN_PASSWORD;
  const traderPass = process.env.TRADER_PASSWORD;
  if (adminPass) {
    let admin = await User.findOne({ username: adminName });
    if (!admin) {
      admin = await User.create({
        username: adminName,
        password: bcrypt.hashSync(adminPass, ROUNDS),
        role: "admin",
        balances: { USDT: 1000000, BTC: 2, ETH: 10 }
      });
    } else if (!bcrypt.compareSync(adminPass, admin.password)) {
      admin.password = bcrypt.hashSync(adminPass, ROUNDS);
      admin.role = "admin";
      admin.tokenVersion = (admin.tokenVersion || 0) + 1;
      await admin.save();
    }
  }
  if (traderPass) {
    let trader = await User.findOne({ username: traderName });
    if (!trader) {
      const px = marketManager.snapshot();
      const balances = { USDT: 250000, BTC: 0.5, ETH: 4 };
      await User.create({
        username: traderName,
        password: bcrypt.hashSync(traderPass, ROUNDS),
        role: "user",
        balances,
        startingEquity: control.equity({ balances }, px)
      });
    } else if (!bcrypt.compareSync(traderPass, trader.password)) {
      trader.password = bcrypt.hashSync(traderPass, ROUNDS);
      trader.tokenVersion = (trader.tokenVersion || 0) + 1;
      await trader.save();
    }
  }
  if (!(await BotSetting.findOne({ botName: "MainBot" }))) {
    await BotSetting.create({ botName: "MainBot", isActive: false, buyThreshold: 60000, sellThreshold: 70000 });
  }
  const prices = marketManager.snapshot();
  store.listUsers().forEach(u => {
    if (u.startingEquity == null) {
      u.startingEquity = control.equity(u, prices);
      store.saveUser(u);
    }
  });
  store.getControl();
  store.flush();
}

bootstrap().then(() => {
  const PORT = process.env.PORT || 5000;
  server.listen(PORT, () => console.log("Nexora control engine on :" + PORT + " (local persist, no Atlas)"));
}).catch(err => {
  console.error(err);
  process.exit(1);
});
