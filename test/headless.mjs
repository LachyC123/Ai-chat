// Headless harness (plan §8): runs the sim core extracted from index.html
// in Node — no rendering, no player input — and asserts the schedule loop
// holds up over multiple simulated days.
//
//   node test/headless.mjs [days]

import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const m = html.match(/<script id="sim-core">([\s\S]*?)<\/script>/);
if (!m) { console.error("FAIL: sim-core script block not found in index.html"); process.exit(1); }

const mod = { exports: {} };
new Function("module", "exports", m[1])(mod, mod.exports);
const SIM = mod.exports;

const DAYS = Number(process.argv[2] || 3);
const DT = 0.1; // real seconds per step
const state = SIM.createState();
const mara = state.npcs[0];

let failures = 0;
const fail = (msg) => { failures++; console.error(`FAIL: ${msg}`); };
const near = (a, b, r = 1.5) => Math.hypot(a.x - b.x, a.y - b.y) <= r;

// Spot checks: at these times Mara must be at (or within 1.5 tiles of) the
// location her schedule anchors demand. Times leave travel slack after each
// anchor fires.
const CHECKS = [
  ["09:00", "bakery"], ["12:45", "market"], ["15:00", "bakery"], ["23:00", "home"],
];

let lastMin = state.clock.minutes;
let lastDay = state.clock.day;
let stuck = { x: mara.x, y: mara.y, mins: 0 };
const startDay = state.clock.day;
const totalSteps = Math.ceil((DAYS * SIM.DAY_REAL_SECONDS) / DT);

for (let i = 0; i < totalSteps; i++) {
  SIM.tick(state, DT);
  const { minutes, day } = state.clock;

  if (!Number.isFinite(mara.x) || !Number.isFinite(mara.y))
    { fail(`NaN position at day ${day} ${SIM.fmtClock(minutes)}`); break; }

  // Scheduled-location spot checks (fire once when the clock crosses each mark)
  for (const [t, place] of CHECKS) {
    const mark = SIM.hm(t);
    const crossed = day === lastDay ? (lastMin < mark && minutes >= mark)
                                    : (lastMin < mark + 1440 && minutes + 1440 >= mark + 1440);
    if (crossed && !near(mara, mara.locations[place]))
      fail(`day ${day} ${t}: Mara should be at ${place}, is at (${mara.x.toFixed(1)}, ${mara.y.toFixed(1)}) doing "${mara.activity.label}"`);
  }

  // Stuck detection: far from target but not moving for >10 sim minutes
  const target = mara.locations[mara.activity.place];
  const dMin = minutes - lastMin + (day !== lastDay ? 1440 : 0);
  if (!near(mara, target, 0.2)) {
    if (Math.hypot(mara.x - stuck.x, mara.y - stuck.y) < 0.05) {
      stuck.mins += dMin;
      if (stuck.mins > 10) { fail(`Mara stuck at (${mara.x.toFixed(1)}, ${mara.y.toFixed(1)}) heading to ${mara.activity.place}`); break; }
    } else stuck = { x: mara.x, y: mara.y, mins: 0 };
  } else stuck = { x: mara.x, y: mara.y, mins: 0 };

  lastMin = minutes; lastDay = day;
}

// Day rollover
if (state.clock.day !== startDay + DAYS)
  fail(`expected day ${startDay + DAYS} after ${DAYS} simulated days, got day ${state.clock.day}`);

// Cost ceiling (plan §8): Phase 1 makes ZERO model calls.
if (state.modelCalls.fable5 !== 0 || state.modelCalls.embeddings !== 0)
  fail(`model calls in Phase 1: ${JSON.stringify(state.modelCalls)} (must be zero)`);

// Retrieval-math placeholder: pathfinding sanity until Phase 2 adds scoring tests
const path = SIM.findPath(state.map, mara.locations.home.x, mara.locations.home.y,
                          mara.locations.market.x, mara.locations.market.y);
if (!path || path.length < 5) fail("no path home -> market");
const blocked = SIM.findPath(state.map, 5, 5, 6, 22); // pond center
if (blocked !== null) fail("pathfinder returned a path into solid water");

console.log(`Simulated ${DAYS} day(s) in ${totalSteps} ticks — ` +
            `model calls: fable5=${state.modelCalls.fable5}, embeddings=${state.modelCalls.embeddings}`);
if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log("OK: all headless checks passed");
