const store = require("./store");

function wrapUser(u) {
  if (!u) return null;
  const row = {
    _id: u._id,
    username: u.username,
    password: u.password,
    role: u.role,
    balances: Object.assign({}, u.balances || {}),
    startingEquity: u.startingEquity,
    tokenVersion: u.tokenVersion || 0,
    walletAddress: u.walletAddress || null,
    walletLinkedAt: u.walletLinkedAt || null,
    createdAt: u.createdAt,
    async save() { store.saveUser(this); return this; }
  };
  return row;
}

function wrapBot(b) {
  if (!b) return null;
  return {
    ...b,
    async save() { store.saveBot(this); return this; }
  };
}

const User = {
  async create(doc) { return wrapUser(store.createUser(doc)); },
  async findById(id) { return wrapUser(store.getUserById(id)); },
  async findOne(q) {
    if (q && q.username) return wrapUser(store.getUserByUsername(q.username));
    if (q && q.walletAddress) return wrapUser(store.getUserByWallet(q.walletAddress));
    if (q && q._id) return wrapUser(store.getUserById(q._id));
    return null;
  },
  async find() { return store.listUsers().map(wrapUser); }
};

const Trade = {
  async create(doc) { return store.createTrade(doc); },
  find(q) {
    const rows = q && q.userId ? store.tradesOf(q.userId, 200) : store.allTrades(200);
    return {
      _rows: rows,
      sort() { return this; },
      limit(n) { this._rows = rows.slice(0, n); return this; },
      then(res, rej) { return Promise.resolve(this._rows).then(res, rej); }
    };
  }
};

const BotSetting = {
  async create(doc) { return wrapBot(store.createBot(doc)); },
  async findOne(q) { return wrapBot(store.getBot((q && q.botName) || "MainBot")); }
};

module.exports = { User, Trade, BotSetting };
