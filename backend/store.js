const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const FILE = process.env.DATA_FILE
  ? path.resolve(process.env.DATA_FILE)
  : path.join(__dirname, "data.json");

let data = {
  users: [],
  trades: [],
  botSettings: [],
  deposits: [],
  withdrawals: [],
  markets: {},
  control: {
    autoProfit: true,
    targetHousePnl: 0,
    minHousePnl: -2500,
    aggressiveness: 0.65,
    maxMovePctPerTick: 0.0035,
    protectMode: "both",
    pnlHistory: [],
    lastActions: []
  },
  killSwitch: { active: false, at: null },
  prop: {
    enabled: true,
    autoWatch: true,
    profitSplit: 0.8,
    pricing: { "10k": { entry: 19 }, "50k": { entry: 59 }, "100k": { entry: 99 } },
    challenges: [],
    referrals: [],
    payouts: []
  }
};

try {
  if (fs.existsSync(FILE)) {
    const j = JSON.parse(fs.readFileSync(FILE, "utf8"));
    data = Object.assign(data, j);
  }
} catch (e) {
  console.log("store: starting fresh");
}

let saveT = null;
function save() {
  clearTimeout(saveT);
  saveT = setTimeout(flush, 150);
}
function flush() {
  clearTimeout(saveT);
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error("store flush failed", e.message);
  }
}

const id = () => crypto.randomBytes(12).toString("hex");

function getUserByUsername(username) {
  return data.users.find(u => u.username === String(username || "").toLowerCase()) || null;
}
function getUserById(uid) {
  return data.users.find(u => u._id === uid) || null;
}
function getUserByWallet(address) {
  const a = String(address || "").toLowerCase();
  if (!a) return null;
  return data.users.find(u => u.walletAddress === a) || null;
}
function listUsers() { return data.users.slice(); }
function createUser(u) {
  const row = {
    _id: u._id || id(),
    username: String(u.username).toLowerCase(),
    password: u.password,
    role: u.role || "user",
    balances: Object.assign({ USDT: 10000 }, u.balances || {}),
    startingEquity: u.startingEquity != null ? u.startingEquity : (u.balances && u.balances.USDT != null ? Number(u.balances.USDT) : 10000),
    tokenVersion: u.tokenVersion || 0,
    walletAddress: u.walletAddress ? String(u.walletAddress).toLowerCase() : null,
    walletLinkedAt: u.walletLinkedAt || null,
    createdAt: u.createdAt || new Date().toISOString()
  };
  data.users.push(row);
  save();
  return row;
}
function saveUser(u) {
  const i = data.users.findIndex(x => x._id === u._id);
  if (i >= 0) data.users[i] = u;
  save();
  return u;
}

function createTrade(t) {
  const row = {
    _id: id(),
    userId: t.userId,
    symbol: t.symbol,
    type: t.type,
    amount: t.amount,
    price: t.price,
    total: t.total,
    fee: t.fee || 0,
    timestamp: t.timestamp || new Date().toISOString()
  };
  data.trades.push(row);
  if (data.trades.length > 20000) data.trades = data.trades.slice(-15000);
  save();
  return row;
}
function tradesOf(userId, limit) {
  return data.trades.filter(t => t.userId === userId).slice().reverse().slice(0, limit || 50);
}
function allTrades(limit) {
  return data.trades.slice().reverse().slice(0, limit || 200);
}

function getBot(name) {
  return data.botSettings.find(b => b.botName === name) || null;
}
function createBot(b) {
  const row = Object.assign({ _id: id() }, b);
  data.botSettings.push(row);
  save();
  return row;
}
function saveBot(b) {
  const i = data.botSettings.findIndex(x => x._id === b._id);
  if (i >= 0) data.botSettings[i] = b;
  save();
  return b;
}

function createDeposit(d) {
  const row = Object.assign({ _id: id(), status: "pending", createdAt: new Date().toISOString() }, d);
  data.deposits = data.deposits || [];
  data.deposits.push(row);
  save();
  return row;
}
function getDeposit(id2) { return (data.deposits || []).find(x => x._id === id2) || null; }
function saveDeposit(d) {
  const i = (data.deposits || []).findIndex(x => x._id === d._id);
  if (i >= 0) data.deposits[i] = d;
  save();
  return d;
}
function depositsOf(uid) { return (data.deposits || []).filter(x => x.userId === uid).slice().reverse(); }
function allDeposits() {
  return (data.deposits || []).slice().reverse().map(d => Object.assign({}, d, { username: (getUserById(d.userId) || {}).username }));
}

function createWithdrawal(w) {
  const row = Object.assign({ _id: id(), status: "pending", createdAt: new Date().toISOString() }, w);
  data.withdrawals = data.withdrawals || [];
  data.withdrawals.push(row);
  save();
  return row;
}
function getWithdrawal(id2) { return (data.withdrawals || []).find(x => x._id === id2) || null; }
function saveWithdrawal(w) {
  const i = (data.withdrawals || []).findIndex(x => x._id === w._id);
  if (i >= 0) data.withdrawals[i] = w;
  save();
  return w;
}
function withdrawalsOf(uid) { return (data.withdrawals || []).filter(x => x.userId === uid).slice().reverse(); }
function allWithdrawals() {
  return (data.withdrawals || []).slice().reverse().map(w => Object.assign({}, w, { username: (getUserById(w.userId) || {}).username }));
}

function getMarkets() { return data.markets || {}; }
function saveMarkets(m) { data.markets = m; save(); }

function getControl() {
  if (!data.control) {
    data.control = {
      autoProfit: true, targetHousePnl: 0, minHousePnl: -2500,
      aggressiveness: 0.65, maxMovePctPerTick: 0.0035, protectMode: "both",
      pnlHistory: [], lastActions: []
    };
  }
  return data.control;
}
function saveControl(patch) {
  data.control = Object.assign(getControl(), patch || {});
  save();
  return data.control;
}
function pushPnlPoint(pt) {
  const c = getControl();
  c.pnlHistory = (c.pnlHistory || []).concat([pt]).slice(-240);
  save();
}

function isDead() { return !!(data.killSwitch && data.killSwitch.active); }
function setDead(on) {
  data.killSwitch = { active: !!on, at: on ? new Date().toISOString() : null };
  flush();
  return data.killSwitch;
}

function getProp() {
  if (!data.prop) {
    data.prop = {
      enabled: true, autoWatch: true, profitSplit: 0.8,
      pricing: { "10k": { entry: 19 }, "50k": { entry: 59 }, "100k": { entry: 99 } },
      challenges: [], referrals: [], payouts: []
    };
  }
  data.prop.challenges = data.prop.challenges || [];
  data.prop.referrals = data.prop.referrals || [];
  data.prop.payouts = data.prop.payouts || [];
  return data.prop;
}
function patchProp(body) {
  const p = getProp();
  if (body.enabled !== undefined) p.enabled = !!body.enabled;
  if (body.autoWatch !== undefined) p.autoWatch = !!body.autoWatch;
  if (body.profitSplit !== undefined) p.profitSplit = Math.max(0, Math.min(1, Number(body.profitSplit)));
  if (body.pricing) p.pricing = Object.assign({}, p.pricing, body.pricing);
  save();
  return p;
}
function listPropChallenges() { return (getProp().challenges || []).slice().reverse(); }
function getPropChallengeByUser(uid) {
  const all = (getProp().challenges || []).filter(c => c.userId === uid);
  return all.find(c => c.status === "active") || all[all.length - 1] || null;
}
function getPropChallengeById(cid) { return (getProp().challenges || []).find(c => c.id === cid) || null; }
function createPropChallenge(doc) {
  const row = Object.assign({ id: "ch_" + id(), createdAt: new Date().toISOString(), dayKey: new Date().toISOString().slice(0, 10) }, doc);
  getProp().challenges.push(row);
  save();
  return row;
}
function savePropChallenge(c) {
  const arr = getProp().challenges;
  const i = arr.findIndex(x => x.id === c.id);
  if (i >= 0) arr[i] = c;
  save();
  return c;
}
function getPropReferral(uid) {
  return (getProp().referrals || []).find(r => r.userId === uid) || { userId: uid, commissionEarned: 0 };
}
function addPropCommission(uid, amount) {
  const p = getProp();
  let r = p.referrals.find(x => x.userId === uid);
  if (!r) { r = { userId: uid, commissionEarned: 0 }; p.referrals.push(r); }
  r.commissionEarned = (r.commissionEarned || 0) + (Number(amount) || 0);
  save();
  return r;
}
function listPropPayouts() { return (getProp().payouts || []).slice().reverse(); }
function getPropPayout(pid) { return (getProp().payouts || []).find(x => x._id === pid) || null; }
function createPropPayout(doc) {
  const row = Object.assign({ _id: id(), status: "pending", createdAt: new Date().toISOString() }, doc);
  getProp().payouts.push(row);
  save();
  return row;
}
function savePropPayout(p) {
  const arr = getProp().payouts;
  const i = arr.findIndex(x => x._id === p._id);
  if (i >= 0) arr[i] = p;
  save();
  return p;
}

module.exports = {
  FILE, data, save, flush, id,
  getUserByUsername, getUserById, getUserByWallet, listUsers, createUser, saveUser,
  createTrade, tradesOf, allTrades,
  getBot, createBot, saveBot,
  getMarkets, saveMarkets,
  createDeposit, getDeposit, saveDeposit, depositsOf, allDeposits,
  createWithdrawal, getWithdrawal, saveWithdrawal, withdrawalsOf, allWithdrawals,
  getControl, saveControl, pushPnlPoint,
  isDead, setDead,
  getProp, patchProp, listPropChallenges, getPropChallengeByUser, getPropChallengeById,
  createPropChallenge, savePropChallenge, getPropReferral, addPropCommission,
  listPropPayouts, getPropPayout, createPropPayout, savePropPayout
};
