// Vantage forecasting engine — data pipeline.
// Runs on GitHub Actions every 6h. Fetches free public sources, issues new
// forecasts where an engine has no open position, resolves due forecasts
// against fresh observations using the parameters frozen at issue time, and
// recalibrates probabilities from the engine's own track record.
// Every forecast is dated, falsifiable and scored publicly (Brier score).
// Learning = published probabilities are recalibrated as outcomes accumulate
// (observed hit rate near the raw probability, shrunk toward the raw value).
// No retroactive edits: ledger entries are append/resolve only.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const DAY = 86400000;
const now = Date.now();
const iso = (t) => new Date(t).toISOString();
const day = (t) => iso(t).slice(0, 10);
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const sleep = (ms) => new Promise((s) => setTimeout(s, ms));

async function fetchJSON(url, { retries = 3, timeout = 20000 } = {}) {
  for (let i = 0; i < retries; i++) {
    try {
      const ctl = new AbortController();
      const to = setTimeout(() => ctl.abort(), timeout);
      const r = await fetch(url, {
        signal: ctl.signal,
        headers: { "user-agent": "vantage-forecast/1.0 (forecasting research; github actions)" },
      });
      clearTimeout(to);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      if (i === retries - 1) throw e;
      await sleep(3000 * (i + 1));
    }
  }
}

// ---------- sources ----------

const usgsQuery = (params) =>
  fetchJSON(`https://earthquake.usgs.gov/fdsnws/event/1/query?${new URLSearchParams({ format: "geojson", ...params })}`);
const usgsCount = async (params) =>
  +(await fetchJSON(`https://earthquake.usgs.gov/fdsnws/event/1/count?${new URLSearchParams(params)}`));

async function fetchKp1m() {
  const rows = await fetchJSON("https://services.swpc.noaa.gov/json/planetary_k_index_1m.json");
  return rows
    .map((r) => ({ t: new Date(String(r.time_tag).replace(" ", "T") + "Z").getTime(), kp: +r.estimated_kp }))
    .filter((r) => Number.isFinite(r.t) && Number.isFinite(r.kp))
    .sort((a, b) => a.t - b.t);
}
async function fetchKpForecast() {
  const rows = await fetchJSON("https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json");
  const norm = rows
    .map((r) => (Array.isArray(r)
      ? { t: new Date(r[0] + "Z").getTime(), kp: +r[1], obs: r[2] }
      : { t: new Date(String(r.time_tag).replace(" ", "T") + (String(r.time_tag).includes("Z") ? "" : "Z")).getTime(), kp: +r.kp, obs: r.observed }))
    .filter((r) => r.obs === "predicted" && Number.isFinite(r.t) && Number.isFinite(r.kp));
  return norm;
}

async function fetchCoinbaseDaily(product, days = 400) {
  let end = Math.floor(now / 1000);
  const out = [];
  while (days > 0) {
    const n = Math.min(days, 300);
    const start = end - n * 86400;
    const rows = await fetchJSON(
      `https://api.exchange.coinbase.com/products/${product}/candles?granularity=86400&start=${iso(start * 1000)}&end=${iso(end * 1000)}`
    );
    if (!Array.isArray(rows) || !rows.length) break;
    out.push(...rows.map((r) => ({ t: r[0] * 1000, close: r[4] })));
    end = start;
    days -= n;
    await sleep(400);
  }
  const seen = new Set();
  return out.filter((r) => (seen.has(r.t) ? false : (seen.add(r.t), true))).sort((a, b) => a.t - b.t);
}

async function fetchFrankfurter(from, to) {
  const j = await fetchJSON(`https://api.frankfurter.app/${day(now - 2 * 365 * DAY)}..?from=${from}&to=${to}`);
  return Object.entries(j.rates)
    .map(([d, v]) => ({ t: new Date(d + "T00:00:00Z").getTime(), close: v[to] }))
    .sort((a, b) => a.t - b.t);
}

async function fetchYahooDaily(symbol) {
  const j = await fetchJSON(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=2y&interval=1d`,
    { retries: 1, timeout: 12000 }
  );
  const res = j.chart?.result?.[0];
  if (!res) return null;
  const ts = res.timestamp || [];
  const closes = res.indicators?.quote?.[0]?.close || [];
  const out = [];
  for (let i = 0; i < ts.length; i++) if (closes[i] != null) out.push({ t: ts[i] * 1000, close: closes[i] });
  return out.length >= 260 ? out : null;
}

async function fetchNpmDaily(pkg) {
  const end = day(now - DAY);
  const start = day(now - 364 * DAY);
  const j = await fetchJSON(`https://api.npmjs.org/downloads/range/${start}:${end}/${encodeURIComponent(pkg)}`);
  return (j.downloads || []).map((d) => ({ t: new Date(d.day + "T00:00:00Z").getTime(), v: d.downloads }));
}

async function fetchWikiDaily(article) {
  const end = day(now - DAY).replaceAll("-", "") + "00";
  const start = day(now - 200 * DAY).replaceAll("-", "") + "00";
  const j = await fetchJSON(
    `https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/all-agents/${article}/daily/${start}/${end}`
  );
  return (j.items || []).map((d) => ({
    t: new Date(d.timestamp.slice(0, 4) + "-" + d.timestamp.slice(4, 6) + "-" + d.timestamp.slice(6, 8) + "T00:00:00Z").getTime(),
    v: d.views,
  }));
}

// ---------- stats ----------

const logReturns = (s) => {
  const r = [];
  for (let i = 1; i < s.length; i++)
    if (s[i - 1].close > 0 && s[i].close > 0) r.push({ t: s[i].t, r: Math.log(s[i].close / s[i - 1].close) });
  return r;
};
const stdev = (xs) => {
  if (xs.length < 2) return 0;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
};
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};

// ---------- engines (issue side) ----------

async function engineMarketVol(target, name, fetcher) {
  const series = await fetcher();
  if (!series || series.length < 260) return null;
  const lastT = series[series.length - 1].t;
  if (now - lastT > 4 * DAY) return null;
  const rets = logReturns(series);
  const rv5 = [];
  for (let i = 4; i < rets.length; i++)
    rv5.push({ t: rets[i].t, v: stdev(rets.slice(i - 4, i + 1).map((x) => x.r)) * Math.sqrt(5) });
  const med = median(rv5.slice(-252).map((x) => x.v));
  const rv20y = [];
  for (let i = Math.max(19, rets.length - 252); i < rets.length; i++)
    rv20y.push(stdev(rets.slice(i - 19, i + 1).map((x) => x.r)) * Math.sqrt(20));
  const cur = rv20y[rv20y.length - 1];
  const pct = rv20y.filter((v) => v <= cur).length / rv20y.length;
  const terc = pct <= 1 / 3 ? 0 : pct <= 2 / 3 ? 1 : 2;
  let same = 0, hits = 0;
  for (let i = 19; i < rets.length - 5; i++) {
    const v20 = stdev(rets.slice(i - 19, i + 1).map((x) => x.r)) * Math.sqrt(20);
    const p20 = rv20y.filter((v) => v <= v20).length / rv20y.length;
    if ((p20 <= 1 / 3 ? 0 : p20 <= 2 / 3 ? 1 : 2) !== terc) continue;
    const fwd = stdev(rets.slice(i + 1, i + 6).map((x) => x.r)) * Math.sqrt(5);
    same++;
    if (fwd > med) hits++;
  }
  const pRaw = same >= 20 ? clamp(hits / same, 0.1, 0.9) : 0.5;
  return {
    engine: "markets", target, horizonDays: 5,
    claim: `5-day realized volatility of ${name} above its 1-year median`,
    pRaw,
    evidence: {
      series: rv5.slice(-60).map((x) => +x.v.toFixed(4)),
      note: `Empirical conditioning on the current volatility regime (20-day vol in the ${["low", "middle", "high"][terc]} tercile of the past year; ${same} comparable periods). Sparkline: 5-day realized vol, 60 days.`,
      asof: iso(lastT),
    },
    frozen: { med },
  };
}

// Generic weekly-attention momentum engine (npm downloads, Wikipedia pageviews).
async function engineAttention(kind, target, name, unit, fetchDaily) {
  const daily = await fetchDaily();
  if (!daily || daily.length < 70) return null;
  const lastT = daily[daily.length - 1].t;
  if (now - lastT > 3.5 * DAY) return null;
  const nBlocks = Math.floor(daily.length / 7);
  const weeks = [];
  for (let w = nBlocks; w >= 1; w--) {
    const slice = daily.slice(daily.length - w * 7, daily.length - (w - 1) * 7);
    weeks.push({ t: slice[6].t, v: slice.reduce((a, b) => a + b.v, 0) });
  }
  if (weeks.length < 9) return null;
  const last = weeks[weeks.length - 1].v;
  const prev4 = weeks.slice(-5, -1).map((w) => w.v);
  const baseline = prev4.reduce((a, b) => a + b, 0) / prev4.length;
  const above = last > baseline;
  let same = 0, hits = 0;
  for (let i = 4; i < weeks.length - 1; i++) {
    const b4 = (weeks[i - 1].v + weeks[i - 2].v + weeks[i - 3].v + weeks[i - 4].v) / 4;
    if ((weeks[i].v > b4) !== above) continue;
    const n4 = (weeks[i].v + weeks[i - 1].v + weeks[i - 2].v + weeks[i - 3].v) / 4;
    same++;
    if (weeks[i + 1].v > n4) hits++;
  }
  if (same < 8) return null;
  const pUp = hits / same;
  const forecastAbove = pUp >= 0.5;
  const pRaw = clamp(forecastAbove ? pUp : 1 - pUp, 0.15, 0.85);
  return {
    engine: kind, target, horizonDays: 7,
    claim: `${name} ${unit} over the next 7 days ${forecastAbove ? "above" : "below"} its 4-week average`,
    pRaw,
    evidence: {
      series: weeks.slice(-16).map((w) => w.v),
      note: `Momentum conditioning: ${same} comparable weeks in the past year; current week is ${above ? "above" : "below"} the 4-week average. Sparkline: weekly totals, 16 weeks.`,
      asof: iso(lastT),
    },
    frozen: { baseline, forecastAbove },
  };
}

// ---------- resolvers (use parameters frozen at issue time) ----------

const RESOLVERS = {};

function marketResolver(target, fetcher) {
  RESOLVERS[`markets:${target}`] = async (t0, t1, frozen) => {
    const s = await fetcher();
    if (!s) return null;
    const r = logReturns(s).filter((x) => x.t > t0 && x.t <= t1 + DAY);
    if (r.length < 4) return null;
    const fwd = stdev(r.slice(0, 5).map((x) => x.r)) * Math.sqrt(5);
    return { hit: fwd > frozen.med, actual: `realized 5-day vol ${(fwd * 100).toFixed(1)}% vs median ${(frozen.med * 100).toFixed(1)}%` };
  };
}
function attentionResolver(kind, target, fetchDaily) {
  RESOLVERS[`${kind}:${target}`] = async (t0, t1, frozen) => {
    const daily = await fetchDaily();
    if (!daily) return null;
    const w = daily.filter((d) => d.t > t0 && d.t <= t1);
    if (w.length < 7) return null;
    const sum = w.slice(0, 7).reduce((a, b) => a + b.v, 0);
    const hit = frozen.forecastAbove ? sum > frozen.baseline : sum <= frozen.baseline;
    return {
      hit,
      actual: `7-day total ${sum.toLocaleString("en-US")} vs 4-week average ${Math.round(frozen.baseline).toLocaleString("en-US")}`,
    };
  };
}

const NPM_TARGETS = [["npm-react", "React npm", () => fetchNpmDaily("react")], ["npm-typescript", "TypeScript npm", () => fetchNpmDaily("typescript")], ["npm-openai", "OpenAI npm", () => fetchNpmDaily("openai")]];
const WIKI_TARGETS = [["ukraine", "Wikipedia views of 'Russian invasion of Ukraine'", () => fetchWikiDaily("Russian_invasion_of_Ukraine")], ["gaza", "Wikipedia views of 'Gaza war'", () => fetchWikiDaily("Gaza_war")]];
const MARKET_TARGETS = [["btc-usd", "Bitcoin (BTC/USD)", () => fetchCoinbaseDaily("BTC-USD")], ["eth-usd", "Ether (ETH/USD)", () => fetchCoinbaseDaily("ETH-USD")], ["usd-inr", "USD/INR", () => fetchFrankfurter("USD", "INR")], ["spx", "S&P 500", () => fetchYahooDaily("^GSPC")], ["nifty", "NIFTY 50", () => fetchYahooDaily("^NSEI")]];

for (const [t, , f] of MARKET_TARGETS) marketResolver(t, f);
for (const [t, , f] of NPM_TARGETS) attentionResolver("tech", t, f);
for (const [t, , f] of WIKI_TARGETS) attentionResolver("geopolitics", t, f);

const ENGINE_SPECS = [
  ...MARKET_TARGETS.map(([t, name, f]) => [`markets-${t}`, () => engineMarketVol(t, name, f)]),
  ...NPM_TARGETS.map(([t, name, f]) => [`tech-${t}`, () => engineAttention("tech", t, name, "weekly downloads", f)]),
  ...WIKI_TARGETS.map(([t, name, f]) => [`geo-${t}`, () => engineAttention("geopolitics", t, name, "weekly views", f)]),
];

// ---------- learning ----------

function recalibrate(ledger, engine, pRaw) {
  const hist = ledger.forecasts.filter((f) => f.engine === engine && f.status !== "open" && f.p_raw != null);
  const near = hist.filter((f) => Math.abs(f.p_raw - pRaw) <= 0.15);
  const n = near.length;
  if (n < 5) return { p: pRaw, adj: { state: "cold-start", n, obsRate: null, delta: 0 } };
  const obs = near.filter((f) => f.status === "hit").length / n;
  const prior = 20;
  const p = clamp((n * obs + prior * pRaw) / (n + prior), 0.03, 0.97);
  return { p, adj: { state: n >= 20 ? "learning" : "warming", n, obsRate: +obs.toFixed(3), delta: +(p - pRaw).toFixed(3) } };
}

// ---------- main ----------

function loadLedger() {
  try {
    return JSON.parse(readFileSync(join(root, "ledger.json"), "utf8"));
  } catch {
    return { forecasts: [] };
  }
}

async function main() {
  const ledger = loadLedger();
  const report = { resolved: [], issued: [], skipped: [], errors: [] };

  for (const f of ledger.forecasts) {
    if (f.status !== "open" || now < f.deadline) continue;
    try {
      const resolver = RESOLVERS[`${f.engine}:${f.target}`];
      if (!resolver) { report.errors.push(`no resolver ${f.id}`); continue; }
      const out = await resolver(f.created, f.deadline, f.frozen || {});
      if (!out) { report.skipped.push(`resolve-retry ${f.id}`); continue; }
      f.status = out.hit ? "hit" : "miss";
      f.actual = out.actual;
      f.resolved_at = iso(now);
      f.brier = +(((out.hit ? 1 : 0) - f.p) ** 2).toFixed(4);
      report.resolved.push(`${f.id}: ${f.status}`);
    } catch (e) {
      report.errors.push(`resolve ${f.id}: ${e.message}`);
    }
  }

  for (const [name, run] of ENGINE_SPECS) {
    try {
      const fc = await run();
      if (!fc) { report.skipped.push(`${name}: no-data`); continue; }
      const key = (x) => `${x.engine}:${x.target}`;
      if (ledger.forecasts.some((x) => x.status === "open" && key(x) === key(fc))) {
        report.skipped.push(`${name}: open exists`);
        continue;
      }
      const { p, adj } = recalibrate(ledger, fc.engine, fc.pRaw);
      ledger.forecasts.push({
        id: `${fc.engine}-${fc.target}-${day(now)}`,
        engine: fc.engine, target: fc.target, claim: fc.claim,
        p: +p.toFixed(3), p_raw: +fc.pRaw.toFixed(3), adjust: adj,
        created: now, deadline: now + fc.horizonDays * DAY,
        evidence: fc.evidence, frozen: fc.frozen, status: "open",
      });
      report.issued.push(`${name} p=${p.toFixed(3)} raw=${fc.pRaw.toFixed(3)}`);
    } catch (e) {
      report.errors.push(`issue ${name}: ${e.message}`);
    }
  }

  ledger.forecasts = ledger.forecasts.slice(-500);
  ledger.updated_at = iso(now);

  const learning = {};
  for (const f of ledger.forecasts) {
    if (f.status === "open" || f.brier == null) continue;
    const L = (learning[f.engine] ||= { n: 0, hits: 0, brierSum: 0, deltas: [] });
    L.n++;
    if (f.status === "hit") L.hits++;
    L.brierSum += f.brier;
    if (f.adjust?.delta != null) L.deltas.push(Math.abs(f.adjust.delta));
  }
  for (const L of Object.values(learning)) {
    L.hitRate = +(L.hits / L.n).toFixed(3);
    L.brierMean = +(L.brierSum / L.n).toFixed(4);
    L.avgAbsDelta = L.deltas.length ? +(L.deltas.reduce((a, b) => a + b, 0) / L.deltas.length).toFixed(3) : 0;
    L.state = L.n >= 20 ? "learning" : L.n >= 5 ? "warming" : "cold-start";
    delete L.brierSum;
    delete L.deltas;
  }

  const resolved = ledger.forecasts.filter((f) => f.status !== "open").slice(-40).reverse();
  const open = ledger.forecasts.filter((f) => f.status === "open");
  const scored = ledger.forecasts.filter((f) => f.brier != null);
  const stats = {
    open: open.length,
    resolved: scored.length,
    hits: scored.filter((f) => f.status === "hit").length,
    hitRate: scored.length ? +(scored.filter((f) => f.status === "hit").length / scored.length).toFixed(3) : null,
    brier: scored.length ? +(scored.reduce((a, f) => a + f.brier, 0) / scored.length).toFixed(4) : null,
  };
  writeFileSync(join(root, "ledger.json"), JSON.stringify(ledger, null, 2));
  writeFileSync(join(root, "forecasts.json"), JSON.stringify({ generated_at: iso(now), stats, learning, active: open, resolved }, null, 2));

  try {
    const [spx, btc, inr] = await Promise.allSettled([
      fetchYahooDaily("^GSPC"), fetchCoinbaseDaily("BTC-USD", 3), fetchFrankfurter("USD", "INR"),
    ]);
    const signals = { generated_at: iso(now) };
    if (spx.status === "fulfilled" && spx.value && spx.value.length >= 2) {
      const b = spx.value;
      signals.spx = { price: Math.round(b[b.length - 1].close), chg24: +(((b[b.length - 1].close / b[b.length - 2].close) - 1) * 100).toFixed(2) };
    }
    if (btc.status === "fulfilled" && btc.value.length >= 2) {
      const b = btc.value;
      signals.btc = { price: b[b.length - 1].close, chg24: +(((b[b.length - 1].close / b[b.length - 2].close) - 1) * 100).toFixed(2) };
    }
    if (inr.status === "fulfilled" && inr.value.length) signals.usdinr = inr.value[inr.value.length - 1].close;
    writeFileSync(join(root, "signals.json"), JSON.stringify(signals, null, 2));
  } catch (e) {
    report.errors.push(`signals: ${e.message}`);
  }

  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
