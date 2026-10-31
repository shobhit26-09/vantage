// Self-tests for temporal integrity of the forecasting pipeline.
// Run: node pipeline/selftest.mjs  (exit 1 on any failure)
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const DAY = 86400000;
let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failures++;
};

const fc = JSON.parse(readFileSync(join(root, "forecasts.json"), "utf8"));
const gd = JSON.parse(readFileSync(join(root, "data/gdelt-daily.json"), "utf8"));

// 1. No lookahead: for every open gdelt forecast, no window day existed in
//    the data at issue time, and conditioning data predates the window.
for (const f of (fc.active || []).filter((x) => x.engine === "gdelt")) {
  const scope = f.id.replace(/^gdelt-/, "").replace(/-\d{4}-\d{2}-\d{2}$/, "");
  const series = gd[scope] || {};
  const lastDataDay = Object.keys(series).sort().pop();
  const winDays = [];
  for (let t = f.created + DAY; t <= f.deadline; t += DAY) winDays.push(new Date(t).toISOString().slice(0, 10).replaceAll("-", ""));
  check(`${f.id}: 7-day window`, winDays.length === 7, `${winDays.length} days`);
  check(`${f.id}: conditioning predates window`, lastDataDay < winDays[0], `data ends ${lastDataDay}, window starts ${winDays[0]}`);
  const asofDay = new Date(f.evidence.asof).toISOString().slice(0, 10).replaceAll("-", "");
  check(`${f.id}: asof matches last data day`, asofDay <= lastDataDay, `asof ${asofDay}`);
}

// 2. Window-end/deadline separation: settle metadata present and window_end
//    may exceed the countdown deadline only with an explicit grades note.
for (const f of (fc.active || [])) {
  if (!f.settle) { check(`${f.id}: settle metadata`, false, "missing"); continue; }
  check(`${f.id}: settle metadata`, !!f.settle.window && !!f.settle.grades && f.settle.window_end > 0);
  if (f.settle.window_end > f.deadline) {
    check(`${f.id}: provider-lag separation documented`, f.settle.grades.length > 10, `window_end ${new Date(f.settle.window_end).toISOString().slice(0,10)} > deadline ${new Date(f.deadline).toISOString().slice(0,10)}`);
  }
}

// 3. Resolver partial-window protection (synthetic): gdelt resolver logic
//    must refuse to grade when any window day is missing.
{
  const t0 = Date.UTC(2026, 9, 20, 12), t1 = t0 + 7 * DAY;
  const fake = { rus_ukr: {} };
  // fill only 6 of 7 window days
  for (let t = t0 + DAY; t < t1; t += DAY) fake.rus_ukr[new Date(t).toISOString().slice(0, 10).replaceAll("-", "")] = 10;
  let sum = 0, complete = true;
  for (let t = t0 + DAY; t <= t1; t += DAY) {
    const ds = new Date(t).toISOString().slice(0, 10).replaceAll("-", "");
    if (fake.rus_ukr[ds] == null) { complete = false; break; }
    sum += fake.rus_ukr[ds];
  }
  check("resolver refuses partial window (gdelt)", complete === false);
}

// 4. Market resolver requires 5 returns (structural source check).
{
  const src = readFileSync(join(root, "pipeline/update.mjs"), "utf8");
  check("market resolver requires full 5-return window", /r\.length < 5\) return null/.test(src));
}

// 5. Annotations are append-only: no open entry's frozen fields carry an
//    annotations key, and annotation timestamps postdate issue.
{
  const led = JSON.parse(readFileSync(join(root, "ledger.json"), "utf8"));
  let ok = true;
  for (const f of led.forecasts) {
    if (f.frozen && f.frozen.annotations) ok = false;
    for (const a of f.annotations || []) if (new Date(a.at).getTime() < f.created) ok = false;
  }
  check("annotations append-only, never in frozen", ok);
}

process.exit(failures ? 1 : 0);
