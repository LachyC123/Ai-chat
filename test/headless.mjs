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

// Cost ceiling (plan §8): with no embedder configured, ZERO model calls.
if (state.modelCalls.fable5 !== 0 || state.modelCalls.embeddings !== 0)
  fail(`model calls without a configured provider: ${JSON.stringify(state.modelCalls)} (must be zero)`);

// ---- Memory stream over simulated days (Phase 2) -------------------------
const mems = mara.memories;
if (mems.length < 5 * DAYS || mems.length > 40 * DAYS)
  fail(`memory volume off: ${mems.length} memories over ${DAYS} days (expected ~8-15/day)`);
if (state.embedQueue.length !== mems.length)
  fail(`without an embedder every memory should stay queued: queue ${state.embedQueue.length} vs ${mems.length}`);
for (const m of mems)
  for (const rid of m.related_ids)
    if (!mems.some((o) => o.id === rid)) fail(`orphaned related_id ${rid} on ${m.id}`);
const dupIds = new Set();
for (const m of mems) { if (dupIds.has(m.id)) fail(`duplicate memory id ${m.id}`); dupIds.add(m.id); }
// Perception cooldown: player sightings can't be logged more often than the cooldown
const sightings = mems.filter((m) => m.text.startsWith("Noticed the player")).map((m) => m.ts);
for (let i = 1; i < sightings.length; i++)
  if (sightings[i] - sightings[i - 1] < SIM.PERCEPTION_COOLDOWN_MIN)
    fail(`player sightings ${sightings[i] - sightings[i - 1]} sim-min apart (cooldown ${SIM.PERCEPTION_COOLDOWN_MIN})`);
// Retrieval works without embeddings (recency+importance fallback)
const top = SIM.retrieveMemories(state, mara, { N: 5 });
if (top.length !== 5 || !top.every((r) => Number.isFinite(r.score)))
  fail("retrieval fallback (no embeddings) broken");

// ---- Mock-embedder run: pipeline + batching cost ceiling ------------------
const mockEmbed = async (texts) => texts.map((t) => {
  const v = new Array(8).fill(0);
  for (let i = 0; i < t.length; i++) v[i % 8] += t.charCodeAt(i) / 255;
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
});
const st2 = SIM.createState();
SIM.setEmbedder(st2, mockEmbed);
const pumpEvery = 200; // ticks, ~= the browser's periodic queue pump
for (let i = 0; i < Math.ceil((2 * SIM.DAY_REAL_SECONDS) / DT); i++) {
  SIM.tick(st2, DT);
  if (i % pumpEvery === 0) await SIM.processEmbedQueue(st2);
}
while (st2.embedQueue.length) await SIM.processEmbedQueue(st2);
const mems2 = st2.npcs[0].memories;
if (!mems2.length || !mems2.every((m) => m.embedding))
  fail(`mock run: ${mems2.filter((m) => !m.embedding).length}/${mems2.length} memories left unembedded`);
if (st2.modelCalls.embeddings === 0 || st2.modelCalls.embeddings > mems2.length)
  fail(`mock run: ${st2.modelCalls.embeddings} embed calls for ${mems2.length} memories (batching broken or per-tick calls)`);
if (st2.modelCalls.fable5 !== 0) fail("mock run: fable5 calls before Phase 3");
// Embedded retrieval end-to-end: a gossip query should surface the market memory
const qv = (await mockEmbed(["Went to the market square to hear the day's news."]))[0];
const top2 = SIM.retrieveMemories(st2, st2.npcs[0], { queryVec: qv, N: 3 });
if (!top2.some((r) => r.memory.text.includes("market square")))
  fail("embedded retrieval: exact-text query didn't surface the matching memory in top 3");

// Retrieval-math placeholder: pathfinding sanity until Phase 2 adds scoring tests
const path = SIM.findPath(state.map, mara.locations.home.x, mara.locations.home.y,
                          mara.locations.market.x, mara.locations.market.y);
if (!path || path.length < 5) fail("no path home -> market");
const blocked = SIM.findPath(state.map, 5, 5, 6, 22); // pond center
if (blocked !== null) fail("pathfinder returned a path into solid water");

console.log(`Simulated ${DAYS} day(s) in ${totalSteps} ticks — ` +
            `${mems.length} memories, model calls: fable5=${state.modelCalls.fable5}, ` +
            `embeddings=${state.modelCalls.embeddings} (no provider) / ` +
            `mock run: ${mems2.length} memories, ${st2.modelCalls.embeddings} batched embed calls`);
if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log("OK: all headless checks passed");
