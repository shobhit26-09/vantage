const $ = (s) => document.querySelector(s);
const fmtPct = (p) => `${Math.round(p * 100)}%`;
const timeAgo = (t) => {
  const s = (Date.now() - t) / 1000;
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};
const until = (t) => {
  const s = (t - Date.now()) / 1000;
  if (s <= 0) return "resolving…";
  const d = Math.floor(s / 86400), h = Math.round((s % 86400) / 3600);
  return d > 0 ? `resolves in ${d}d ${h}h` : `resolves in ${h}h`;
};

function sparkline(series, color) {
  if (!series || series.length < 2) return "";
  const w = 300, h = 44, pad = 3;
  const min = Math.min(...series), max = Math.max(...series);
  const span = max - min || 1;
  const pts = series.map((v, i) => [
    pad + (i / (series.length - 1)) * (w - 2 * pad),
    h - pad - ((v - min) / span) * (h - 2 * pad),
  ]);
  const line = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
  const area = `${line} L${pts[pts.length - 1][0].toFixed(1)},${h} L${pts[0][0].toFixed(1)},${h} Z`;
  const id = `g${Math.random().toString(36).slice(2, 8)}`;
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${color}" stop-opacity=".22"/><stop offset="1" stop-color="${color}" stop-opacity="0"/>
    </linearGradient></defs>
    <path d="${area}" fill="url(#${id})"/>
    <path d="${line}" fill="none" stroke="${color}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/>
  </svg>`;
}
const CHIP_COLORS = { markets: "#30d158", tech: "#64d2ff", geopolitics: "#ff9f0a", gdelt: "#ff453a" };
const ENGINE_LABELS = { markets: "Markets", tech: "Tech", geopolitics: "Geopolitics · attention", gdelt: "War · news volume" };

async function load() {
  const [fc, sig, ext] = await Promise.all([
    fetch("forecasts.json").then((r) => r.json()).catch(() => null),
    fetch("signals.json").then((r) => r.json()).catch(() => null),
    fetch("external-forecasts.json").then((r) => r.json()).catch(() => null),
  ]);
  if (fc) renderForecasts(fc);
  if (sig) renderSignals(sig);
  if (ext) renderCrowd(ext);
}

function renderCrowd(ext) {
  const fmtClose = (ms) => {
    if (!ms) return "no close date";
    const d = new Date(ms);
    return "trading closes " + d.toUTCString().slice(5, 16);
  };
  const cardHtml = (m) => `<div class="card crowd">
    <div class="card-top">
      <span class="chip crowd">Crowd · Manifold</span>
      <span class="deadline">${fmtClose(m.close_ms)}</span>
    </div>
    <div class="claim"><a class="crowd-link" href="${m.url}" target="_blank" rel="noopener">${m.question}</a></div>
    <div class="prob-row">
      <span class="prob">${m.p != null ? fmtPct(m.p) : "—"}</span>
      <span class="prob-note">crowd probability · external</span>
    </div>
    <div class="pbar"><div class="pbar-fill crowd-fill" style="width:${m.p != null ? (m.p * 100).toFixed(0) : 0}%"></div></div>
    <div class="crowd-meta">${m.bettors != null ? m.bettors.toLocaleString("en-US") + " traders" : "traders n/a"} · volume M$${m.volume != null ? m.volume.toLocaleString("en-US") : "n/a"}</div>
    ${m.condition ? `<div class="crowd-meta crowd-cond">${m.condition.replace(/</g, "&lt;")}</div>` : ""}
    <details class="evidence-detail"><summary>Resolution criteria &amp; source</summary><div class="evidence-note">${(m.criteria || "No criteria text provided by the market creator.").replace(/</g, "&lt;")}</div><div class="asof">External forecast — Vantage did not originate it. Source: <a href="${m.url}" target="_blank" rel="noopener">Manifold ↗</a> · first tracked at ${m.first_p != null ? fmtPct(m.first_p) : "—"}</div></details>
  </div>`;

  for (const dom of ["war", "geopolitics", "tech"]) {
    const el = $("#crowd-" + dom);
    if (!el) continue;
    const list = (ext.open || []).filter((m) => m.domain === dom);
    if (!list.length) continue;
    el.innerHTML = `<h4 class="crowd-title">Crowd forecasts <span class="fgroup-tag">external · via Manifold · not Vantage's own model</span></h4><div class="cards">` + list.map(cardHtml).join("") + `</div><p class="crowd-note">Trading close is not the resolution deadline: a market is graded only after its creator posts the official resolution.</p>`;
  }

  const cr = $("#crowd-record");
  if (cr) {
    const c = ext.crowd || {};
    const rows = (ext.resolved || []).slice(0, 10).map((r) => {
      const na = r.outcome === "N/A";
      const hit = !na && r.first_p != null && (r.first_p >= 0.5) === (r.outcome === "YES");
      return `<div class="rec-row">
        <span class="rec-badge ${na ? "na" : hit ? "hit" : "miss"}">${na ? "N/A" : hit ? "CROWD HIT" : "CROWD MISS"}</span>
        <span class="rec-claim"><b><a class="crowd-link" href="${r.url}" target="_blank" rel="noopener">${r.question}</a></b><br/>resolved ${r.outcome}${r.resolution_time ? " · " + r.resolution_time.slice(0, 10) : ""} · crowd said ${r.first_p != null ? fmtPct(r.first_p) : "—"} when first tracked</span>
      </div>`;
    }).join("");
    cr.innerHTML = `<p class="empty">Manifold questions Vantage tracks as external context: <b>${c.tracked ?? 0}</b> open · <b>${c.resolved ?? 0}</b> resolved${c.brier != null ? ` · crowd hit rate ${c.hits}/${c.resolved} · crowd Brier ${c.brier.toFixed(3)}` : ""}. These grades describe the crowd, not Vantage — they never enter the engines' own record above.</p>` + rows;
  }
}

function renderForecasts(data) {
  const { stats, learning, active, resolved, generated_at } = data;
  $("#stat-open").textContent = stats.open;
  $("#stat-resolved").textContent = stats.resolved || "0";
  $("#stat-hitrate").textContent = stats.hitRate != null ? fmtPct(stats.hitRate) : "—";
  $("#stat-brier").textContent = stats.brier != null ? stats.brier.toFixed(3) : "—";
  $("#updated").textContent = `Pipeline ran ${timeAgo(new Date(generated_at).getTime())} · auto-refreshes every 6 hours via GitHub Actions`;

  const cardHtml = (f) => {
    const color = CHIP_COLORS[f.engine] || "#30d158";
    const adj = f.adjust && f.adjust.delta ? ` · calibrated ${f.adjust.delta > 0 ? "+" : ""}${(f.adjust.delta * 100).toFixed(0)}pts` : " · unvalidated";
    return `<div class="card">
      <div class="card-top">
        <span class="chip ${f.engine}">${ENGINE_LABELS[f.engine] || f.engine}</span>
        <span class="deadline" data-deadline="${f.deadline}">${until(f.deadline)}</span>
      </div>
      <div class="claim">${f.claim}</div>
      <div class="prob-row">
        <span class="prob">${fmtPct(f.p)}</span>
        <span class="prob-note">probability${adj}</span>
      </div>
      <div class="pbar"><div class="pbar-fill" style="width:${(f.p * 100).toFixed(0)}%"></div></div>
      <div class="evidence">${sparkline(f.evidence?.series, color)}</div>
      <details class="evidence-detail"><summary>Evidence &amp; method</summary><div class="evidence-note">${f.evidence?.note || ""}</div><div class="asof">issued ${new Date(f.created).toUTCString().slice(0, 16)} UTC · data as of ${new Date(f.evidence?.asof || f.created).toUTCString().slice(0, 16)} UTC</div></details>
    </div>`;
  };
  for (const eng of ["gdelt", "geopolitics", "markets", "tech"]) {
    const el = $(`#cards-${eng}`);
    if (!el) continue;
    const list = active.filter((f) => f.engine === eng);
    el.innerHTML = list.length
      ? list.map(cardHtml).join("")
      : `<div class="panel"><p class="empty">No open forecast in this group right now — a new one is issued as soon as the previous window resolves.</p></div>`;
  }

  const rl = $("#record-list");
  if (!resolved.length) {
    rl.innerHTML = `<p class="empty">Nothing graded yet. The first deadlines arrive within a week of each forecast being issued — outcomes will appear here automatically, hits and misses alike.</p>`;
  } else {
    rl.innerHTML = resolved
      .slice(0, 12)
      .map((f) => `<div class="rec-row">
        <span class="rec-badge ${f.status}">${f.status === "hit" ? "HIT" : "MISS"}</span>
        <span class="rec-claim"><b>${f.claim}</b><br/>${f.actual || ""} · ${fmtPct(f.p)} forecast · resolved ${timeAgo(new Date(f.resolved_at).getTime())}</span>
      </div>`)
      .join("");
  }

  const cal = $("#calibration");
  const scored = resolved.filter((f) => f.brier != null);
  if (scored.length < 5) {
    cal.innerHTML = `<p class="empty">Calibration appears once at least 5 forecasts have been graded. It plots the predicted probability of each bucket against how often those forecasts actually came true — a well-calibrated engine sits on the diagonal.</p>`;
  } else {
    const buckets = {};
    for (const f of scored) {
      const b = Math.min(4, Math.floor(f.p * 5));
      (buckets[b] ||= { n: 0, hits: 0, pSum: 0 });
      buckets[b].n++; buckets[b].hits += f.status === "hit" ? 1 : 0; buckets[b].pSum += f.p;
    }
    cal.innerHTML = Object.entries(buckets)
      .map(([b, v]) => `<div class="cal-row">
        <span class="cal-label">${b * 20}–${+b * 20 + 20}%</span>
        <div class="cal-bars">
          <div class="cal-bar cal-pred" style="width:${(v.pSum / v.n) * 100}%"></div>
          <div class="cal-bar cal-obs" style="width:${(v.hits / v.n) * 100}%"></div>
        </div>
      </div>`)
      .join("") + `<div class="cal-legend"><span><span class="cal-dot" style="background:rgba(255,255,255,.16)"></span>predicted</span><span><span class="cal-dot" style="background:var(--accent)"></span>observed</span></div>`;
  }

  const lt = $("#learning-table");
  const entries = Object.entries(learning || {});
  if (!entries.length) {
    lt.innerHTML = `<p class="empty">All engines are in <span class="state cold-start">cold-start</span> — no outcomes yet, so raw model probabilities are published untouched. As forecasts resolve, each engine's published probability starts shrinking toward its own observed hit rate, and this table tracks that adjustment.</p>`;
  } else {
    lt.innerHTML = `<table class="ltable"><thead><tr><th>Engine</th><th>State</th><th>Graded</th><th>Hit rate</th><th>Brier</th><th>Avg. calibration shift</th></tr></thead><tbody>` +
      entries.map(([eng, L]) => `<tr>
        <td>${ENGINE_LABELS[eng] || eng}</td>
        <td><span class="state ${L.state}">${L.state}</span></td>
        <td class="mono">${L.n}</td>
        <td class="mono">${fmtPct(L.hitRate)}</td>
        <td class="mono">${L.brierMean.toFixed(3)}</td>
        <td class="mono">${L.avgAbsDelta ? `±${(L.avgAbsDelta * 100).toFixed(0)}pts` : "—"}</td>
      </tr>`).join("") + `</tbody></table>`;
  }
}

function renderSignals(s) {
  const items = [];
  if (s.btc) items.push({ label: "Bitcoin", value: `$${s.btc.price.toLocaleString("en-US")}`, sub: `<span class="${s.btc.chg24 >= 0 ? "sig-pos" : "sig-neg"}">${s.btc.chg24 >= 0 ? "+" : ""}${s.btc.chg24}%</span> 24h · Coinbase` });
  if (s.usdinr) items.push({ label: "USD / INR", value: `₹${s.usdinr.toFixed(2)}`, sub: "ECB reference rate" });
  if (s.kpNow != null) items.push({ label: "Kp index now", value: s.kpNow.toFixed(1), sub: `NOAA forecast peak ${s.kpForecastMax ?? "—"} · storm at ≥ 5` });
  if (s.quakes?.length) items.push({ label: "Strongest quake, 7d", value: `M${Math.max(...s.quakes.map((q) => q.mag)).toFixed(1)}`, sub: s.quakes[0].place });
  if (s.eonet) {
    const total = Object.values(s.eonet).reduce((a, b) => a + b, 0);
    const top = Object.entries(s.eonet).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${v} ${k.toLowerCase()}`).join(" · ");
    items.push({ label: "Active natural events", value: total, sub: `${top} · NASA EONET` });
  }
  $("#signals-board").innerHTML = items.map((i) => `<div class="sig"><div class="sig-label">${i.label}</div><div class="sig-value">${i.value}</div><div class="sig-sub">${i.sub}</div></div>`).join("") +
    `<div class="sig"><div class="sig-label">Feed updated</div><div class="sig-value" style="font-size:16px">${timeAgo(new Date(s.generated_at).getTime())}</div><div class="sig-sub">Coinbase · ECB · Yahoo Finance · npm · Wikimedia</div></div>`;
}

setInterval(() => {
  document.querySelectorAll("[data-deadline]").forEach((el) => {
    el.textContent = until(+el.dataset.deadline);
  });
}, 60000);

load();
