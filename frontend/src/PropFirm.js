import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import axios from "axios";

const API_URL = process.env.REACT_APP_API_URL || "http://localhost:5000/api";
const api = axios.create({ baseURL: API_URL });
api.interceptors.request.use(cfg => {
  const t = localStorage.getItem("token");
  if (t) cfg.headers.Authorization = "Bearer " + t;
  return cfg;
});

function Card({ children, className = "" }) {
  return <div className={`eq-card ${className}`}>{children}</div>;
}

export default function PropFirm({ user, setAuth }) {
  const nav = useNavigate();
  const [pub, setPub] = useState(null);
  const [me, setMe] = useState(null);
  const [err, setErr] = useState("");
  const [qty, setQty] = useState("");
  const ref = new URLSearchParams(window.location.search).get("ref") || "";

  const load = async () => {
    try {
      const p = await api.get("/prop/public");
      setPub(p.data);
      if (user) {
        const m = await api.get("/prop/me");
        setMe(m.data);
      }
    } catch (e) { setErr(e.response?.data?.error || "Prop desk unavailable"); }
  };
  useEffect(() => { load(); }, [user]);

  const start = async (tier, trial) => {
    setErr("");
    if (!user) { nav("/login?next=/prop"); return; }
    try {
      await api.post("/prop/start", { tier, trial, ref });
      await load();
    } catch (e) { setErr(e.response?.data?.error || "Could not start"); }
  };

  const payout = async () => {
    try {
      await api.post("/prop/payout", { qty: Number(qty) });
      setQty("");
      await load();
    } catch (e) { setErr(e.response?.data?.error || "Payout failed"); }
  };

  const c = me && me.challenge;
  const progress = c ? Math.min(100, Math.max(0, ((c.currentEquity - c.initialBalance) / c.targetProfit) * 100)) : 0;
  const health = c ? Math.min(100, Math.max(0, (1 - Math.max(0, c.initialBalance - c.currentEquity) / c.maxDrawdown) * 100)) : 100;

  return (
    <div className="eq-shell min-h-screen text-white">
      <header className="flex items-center justify-between px-8 py-5 border-b border-white/10">
        <div className="flex items-center gap-3 cursor-pointer" onClick={() => nav("/")}>
          <img src="/logo.jpg" alt="Nexora" className="w-10 h-10 rounded-xl object-cover eq-mark" />
          <div>
            <div className="eq-title text-xl">Nexora</div>
            <div className="text-[10px] tracking-[0.28em] uppercase text-amber-200/70">Prop desk</div>
          </div>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <button onClick={() => nav("/")} className="eq-ghost">Exchange</button>
          {user?.role === "admin" && <button onClick={() => nav("/admin")} className="eq-ghost">Admin</button>}
          {user ? (
            <button onClick={() => { localStorage.clear(); setAuth(null); nav("/login?next=/prop"); }} className="eq-ghost text-red-300">Leave</button>
          ) : (
            <button onClick={() => nav("/login?next=/prop")} className="eq-btn">Sign in</button>
          )}
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-10 space-y-10">
        <section className="eq-hero">
          <p className="text-[11px] tracking-[0.4em] uppercase text-amber-200/80">Horizon capital · evaluation desk</p>
          <h1 className="eq-title text-5xl md:text-6xl mt-3 leading-[1.05]">Trade our book.<br />Keep the dusk share.</h1>
          <p className="mt-4 max-w-xl text-white/60">Pass the Nexora evaluation on the same house-controlled crypto tape. Paper capital only — no chain settlement, no other venue’s layout.</p>
          <div className="mt-6 flex gap-3">
            <a href="#tiers" className="eq-btn">View desks</a>
            <button onClick={() => nav("/")} className="eq-ghost">Open Nexora tape</button>
          </div>
        </section>

        {err && <div className="eq-alert">{err}</div>}
        {pub && !pub.enabled && <div className="eq-alert">Prop desk is closed by admin.</div>}

        {c && (
          <section className="grid md:grid-cols-3 gap-4">
            <Card>
              <div className="eq-kicker">Equity</div>
              <div className="eq-title text-3xl mt-1">${Number(c.currentEquity).toLocaleString()}</div>
              <div className="text-xs text-white/40 mt-2">Stage {c.stage} · {c.status}</div>
            </Card>
            <Card>
              <div className="eq-kicker">Profit path</div>
              <div className="eq-meter mt-3"><span style={{ width: progress + "%" }} /></div>
              <div className="text-xs text-amber-200/80 mt-2">{Math.round(progress)}% of ${c.targetProfit.toLocaleString()} target</div>
            </Card>
            <Card>
              <div className="eq-kicker">Drawdown health</div>
              <div className="eq-meter eq-meter-health mt-3"><span style={{ width: health + "%" }} /></div>
              <div className="text-xs text-white/50 mt-2">Floor ${c.maxDrawdown.toLocaleString()} · daily ${c.dailyDrawdown.toLocaleString()}</div>
            </Card>
            <Card className="md:col-span-3 flex flex-wrap gap-3 items-center justify-between">
              <p className="text-sm text-white/60">Same Nexora crypto book. House tape stays unique — Profit Guard still steers crowded inventory.</p>
              <div className="flex gap-2">
                <button onClick={() => nav("/?book=prop")} className="eq-btn">Trade prop seat</button>
                <button onClick={() => nav("/")} className="eq-ghost">Open personal Nexora</button>
                {c.stage === "funded" && (
                  <>
                    <input value={qty} onChange={e => setQty(e.target.value)} placeholder="Payout USDT" className="eq-input w-36" />
                    <button onClick={payout} className="eq-ghost">Request payout</button>
                  </>
                )}
              </div>
            </Card>
          </section>
        )}

        <section id="tiers">
          <h2 className="eq-title text-3xl mb-6">Desks</h2>
          <div className="grid md:grid-cols-3 gap-5">
            {(pub?.tiers || []).map(t => (
              <Card key={t.id} className={t.id === "50k" ? "eq-card-hot" : ""}>
                <div className="eq-kicker">{t.label}</div>
                <div className="eq-title text-4xl mt-2">${t.account.toLocaleString()}</div>
                <div className="text-amber-200/90 text-sm mt-1">Entry listed ${t.entry} · paper seat</div>
                <ul className="mt-4 space-y-1 text-sm text-white/55">
                  <li>Target ${t.target.toLocaleString()}</li>
                  <li>Max DD ${t.maxDrawdown.toLocaleString()}</li>
                  <li>Daily ${t.dailyDrawdown.toLocaleString()}</li>
                  <li>{Math.round((pub.profitSplit || 0.8) * 100)}% dusk split</li>
                </ul>
                <div className="mt-5 flex flex-col gap-2">
                  <button disabled={!pub?.enabled} onClick={() => start(t.id, false)} className="eq-btn">Join desk</button>
                  <button disabled={!pub?.enabled} onClick={() => start(t.id, true)} className="eq-ghost text-xs">Trial seat</button>
                </div>
              </Card>
            ))}
          </div>
        </section>

        <section className="grid md:grid-cols-2 gap-5">
          <Card>
            <h3 className="eq-title text-2xl mb-3">Horizon board</h3>
            <table className="w-full text-sm">
              <thead><tr className="text-white/30 text-left"><th className="pb-2">Trader</th><th>Desk</th><th>Equity</th></tr></thead>
              <tbody>
                {(pub?.leaderboard || []).map((r, i) => (
                  <tr key={i} className="border-t border-white/5">
                    <td className="py-2">{r.username}</td>
                    <td>{r.tier}</td>
                    <td className="text-amber-200">${Number(r.equity).toLocaleString()}</td>
                  </tr>
                ))}
                {!(pub?.leaderboard || []).length && <tr><td className="py-3 text-white/40" colSpan={3}>No seats yet</td></tr>}
              </tbody>
            </table>
          </Card>
          <Card>
            <h3 className="eq-title text-2xl mb-3">Referral veil</h3>
            <p className="text-white/50 text-sm">15% listed-fee credit on referred seats. Paper ledger only.</p>
            {me && (
              <div className="mt-4 text-xs break-all text-amber-100/80 bg-black/30 rounded-xl p-3">
                {window.location.origin}/prop?ref={user?._id}
                <div className="mt-2 text-white/40">Earned ${Number(me.referral?.commissionEarned || 0).toFixed(2)}</div>
              </div>
            )}
          </Card>
        </section>
      </main>
    </div>
  );
}
