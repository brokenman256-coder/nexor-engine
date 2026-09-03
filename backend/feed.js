// Extra module: pull public BTC/ETH prints, then house tick/Profit Guard still influence.
const https = require("https");

function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": "nexora-feed" }, timeout: 8000 }, res => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => {
        try { resolve(JSON.parse(d)); } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
  });
}

async function pull() {
  const [btc, eth] = await Promise.all([
    getJson("https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT"),
    getJson("https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT")
  ]);
  return { BTC: Number(btc && btc.price), ETH: Number(eth && eth.price) };
}

function attach(marketManager) {
  const run = async () => {
    try {
      const px = await pull();
      if (px.BTC > 0) marketManager.overrideAsset("BTC", { price: px.BTC });
      if (px.ETH > 0) marketManager.overrideAsset("ETH", { price: px.ETH });
    } catch (e) {}
  };
  run();
  setInterval(run, 8000);
}

module.exports = { attach };
