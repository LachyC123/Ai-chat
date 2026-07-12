// Headless harness (plan §8): runs the sim core extracted from index.html
// in Node — no rendering, no player input — and asserts the whole cast's
// schedule loops hold up over multiple simulated days.
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
const [mara, tomas, edith] = state.npcs;

let failures = 0;
const fail = (msg) => { failures++; console.error(`FAIL: ${msg}`); };
const near = (a, b, r = 1.5) => Math.hypot(a.x - b.x, a.y - b.y) <= r;

// Spot checks against each NPC's fallback rhythm (no LLM in this run, so
// the default anchors are what they follow). Times leave travel slack.
const bakery = SIM.BUILDINGS[0];
const CHECKS = [
  ["09:00", "Mara inside the bakery",  () => SIM.insideBuilding(bakery, mara.x, mara.y)],
  ["12:45", "Mara at the market",      () => near(mara, mara.locations.market)],
  ["15:00", "Mara inside the bakery",  () => SIM.insideBuilding(bakery, mara.x, mara.y)],
  ["23:00", "Mara at home",            () => near(mara, mara.locations.home)],
  ["09:00", "Tomas inside the bakery", () => SIM.insideBuilding(bakery, tomas.x, tomas.y)],
  ["22:30", "Tomas at home",           () => near(tomas, tomas.locations.home)],
  ["09:45", "Edith at the bakery",     () => SIM.insideBuilding(bakery, edith.x, edith.y) || near(edith, edith.locations.bakery)],
  ["11:30", "Edith at the park",       () => near(edith, edith.locations.park)],
  ["17:30", "Edith at the park",       () => near(edith, edith.locations.park)],
  ["22:00", "Edith at home",           () => near(edith, edith.locations.home)],
];

let lastMin = state.clock.minutes;
let lastDay = state.clock.day;
const stuck = new Map(state.npcs.map((n) => [n.id, { x: n.x, y: n.y, mins: 0 }]));
const startDay = state.clock.day;
const totalSteps = Math.ceil((DAYS * SIM.DAY_REAL_SECONDS) / DT);

for (let i = 0; i < totalSteps; i++) {
  SIM.tick(state, DT);
  const { minutes, day } = state.clock;

  for (const n of state.npcs) {
    if (!Number.isFinite(n.x) || !Number.isFinite(n.y))
      { fail(`NaN position for ${n.name} at day ${day} ${SIM.fmtClock(minutes)}`); process.exit(1); }

    // Stuck detection: far from target but not moving for >10 sim minutes
    const target = n.currentTarget || n.locations[n.activity.place] || n.locations.home;
    const s = stuck.get(n.id);
    const dMin = minutes - lastMin + (day !== lastDay ? 1440 : 0);
    if (!near(n, target, 0.2)) {
      if (Math.hypot(n.x - s.x, n.y - s.y) < 0.05) {
        s.mins += dMin;
        if (s.mins > 10) {
          fail(`${n.name} stuck at (${n.x.toFixed(1)}, ${n.y.toFixed(1)}) heading to (${target.x},${target.y}) doing "${n.activity.label}"`);
          process.exit(1);
        }
      } else { s.x = n.x; s.y = n.y; s.mins = 0; }
    } else { s.x = n.x; s.y = n.y; s.mins = 0; }
  }

  // Scheduled-location spot checks (fire once when the clock crosses each mark)
  for (const [t, desc, ok] of CHECKS) {
    const mark = SIM.hm(t);
    const crossed = day === lastDay ? (lastMin < mark && minutes >= mark)
                                    : (lastMin < mark + 1440 && minutes + 1440 >= mark + 1440);
    if (crossed && !ok()) fail(`day ${day} ${t}: expected ${desc}`);
  }

  lastMin = minutes; lastDay = day;
}

// Day rollover
if (state.clock.day !== startDay + DAYS)
  fail(`expected day ${startDay + DAYS} after ${DAYS} simulated days, got day ${state.clock.day}`);

// Cost ceiling (plan §8): with no providers configured, ZERO model calls.
if (state.modelCalls.fable5 !== 0 || state.modelCalls.embeddings !== 0)
  fail(`model calls without a configured provider: ${JSON.stringify(state.modelCalls)} (must be zero)`);

// ---- Memory streams over simulated days -----------------------------------
let totalMems = 0;
for (const n of state.npcs) {
  const mems = n.memories;
  totalMems += mems.length;
  if (mems.length < 4 * DAYS || mems.length > 40 * DAYS)
    fail(`${n.name} memory volume off: ${mems.length} over ${DAYS} days`);
  for (const mm of mems)
    for (const rid of mm.related_ids)
      if (!mems.some((o) => o.id === rid)) fail(`orphaned related_id ${rid} on ${mm.id} (${n.name})`);
  // Perception cooldowns per subject
  for (const [subject, cd] of [["the player", SIM.PERCEPTION_COOLDOWN_MIN]]) {
    const sightings = mems.filter((mm) => mm.text.startsWith(`Noticed ${subject}`)).map((mm) => mm.ts);
    for (let i = 1; i < sightings.length; i++)
      if (sightings[i] - sightings[i - 1] < cd)
        fail(`${n.name} sightings of ${subject} ${sightings[i] - sightings[i - 1]} sim-min apart (cooldown ${cd})`);
  }
}
const allIds = new Set();
for (const n of state.npcs)
  for (const mm of n.memories) {
    if (allIds.has(mm.id)) fail(`duplicate memory id ${mm.id}`);
    allIds.add(mm.id);
  }

// Without an embedder every memory stays queued
if (state.embedQueue.length !== totalMems)
  fail(`without an embedder every memory should stay queued: queue ${state.embedQueue.length} vs ${totalMems}`);

// Retrieval works without embeddings (recency+importance fallback)
const top = SIM.retrieveMemories(state, mara, { N: 5 });
if (top.length !== 5 || !top.every((r) => Number.isFinite(r.score)))
  fail("retrieval fallback (no embeddings) broken");

// Workstation micro-routine: staff log oven sessions, bounded per day
const ovenMems = [mara, tomas].flatMap((n) => n.memories.filter((mm) => mm.text.includes("batch of loaves")));
if (ovenMems.length < DAYS || ovenMems.length > 14 * DAYS)
  fail(`oven-session memories off: ${ovenMems.length} over ${DAYS} days`);

// The bakery runs like a bakery: Edith buys, staff sell — every day
const bought = edith.memories.filter((mm) => mm.text.startsWith("Bought a fresh loaf"));
const sold = [mara, tomas].flatMap((n) => n.memories.filter((mm) => mm.text.startsWith("Sold a fresh loaf")));
if (bought.length < DAYS) fail(`Edith should buy bread daily: ${bought.length} purchases over ${DAYS} days`);
if (sold.length !== bought.length) fail(`sales (${sold.length}) should mirror purchases (${bought.length})`);

// NPCs notice each other (colleagues share the bakery)
if (!mara.memories.some((mm) => mm.text.startsWith("Noticed Tomas")))
  fail("Mara never noticed Tomas despite sharing the bakery");
if (!edith.memories.some((mm) => mm.text.startsWith("Noticed")))
  fail("Edith noticed nobody all week");

// No LLM: plans stay on the fallback rhythm, no conversations start
if (mara.needsPlan !== true) fail("needsPlan should stay raised when no LLM is configured");
if (mara.current_plan.length !== 7) fail("Mara's default plan should be unchanged without an LLM");
if (SIM.findConvoPair(state) !== null) fail("findConvoPair must be null without an LLM");
if (Object.keys(state.convoCooldowns).length !== 0) fail("no convo cooldowns should be recorded without an LLM");

// Pathfinder sanity
const path = SIM.findPath(state.map, mara.locations.home.x, mara.locations.home.y,
                          mara.locations.market.x, mara.locations.market.y);
if (!path || path.length < 5) fail("no path home -> market");
const blocked = SIM.findPath(state.map, 5, 5, 6, 22); // pond center
if (blocked !== null) fail("pathfinder returned a path into solid water");

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
const mems2 = st2.npcs.flatMap((n) => n.memories);
if (!mems2.length || !mems2.every((mm) => mm.embedding))
  fail(`mock run: ${mems2.filter((mm) => !mm.embedding).length}/${mems2.length} memories left unembedded`);
if (st2.modelCalls.embeddings === 0 || st2.modelCalls.embeddings > mems2.length)
  fail(`mock run: ${st2.modelCalls.embeddings} embed calls for ${mems2.length} memories (batching broken or per-tick calls)`);
if (st2.modelCalls.fable5 !== 0) fail("mock run: fable5 calls without an LLM provider");
// Embedded retrieval end-to-end: a gossip query should surface the market memory
const qv = (await mockEmbed(["Went to the market square to hear the day's news."]))[0];
const top2 = SIM.retrieveMemories(st2, st2.npcs[0], { queryVec: qv, N: 3 });
if (!top2.some((r) => r.memory.text.includes("market square")))
  fail("embedded retrieval: exact-text query didn't surface the matching memory in top 3");

console.log(`Simulated ${DAYS} day(s) in ${totalSteps} ticks — ` +
            `${totalMems} memories across ${state.npcs.length} NPCs, ` +
            `${bought.length} bread purchases, model calls: fable5=${state.modelCalls.fable5}, ` +
            `embeddings=${state.modelCalls.embeddings} (no provider) / ` +
            `mock run: ${mems2.length} memories, ${st2.modelCalls.embeddings} batched embed calls`);
if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log("OK: all headless checks passed");
