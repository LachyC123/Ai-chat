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
// Fixed seed → reproducible crime waves (Phase 7 randomness is seeded).
const SEED = Number(process.argv[3] || 12345);
const state = SIM.createState(SEED);
const [mara, tomas, edith, bram, silas, ren, pip] = state.npcs;

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
  ["09:00", "Bram patrolling the market", () => near(bram, bram.locations.market)],
  ["23:30", "the gang back at the shed",  () => [silas, ren, pip].every((n) =>
    n.jailedUntil || near(n, n.locations.home, 2.5))],
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

  // Invariant every tick: anyone currently jailed sits inside the station.
  for (const n of state.npcs)
    if (n.jailedUntil && n.path === null && !SIM.insideBuilding(SIM.STATION(), n.x, n.y)
        && Math.hypot(n.x - SIM.STATION().cell.x, n.y - SIM.STATION().cell.y) > 3)
      fail(`${n.name} is jailed but roaming free at (${n.x.toFixed(1)}, ${n.y.toFixed(1)})`);

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

// The bakery runs like a bakery: visitors buy, staff sell — mirrored counts.
// (With this seed no baker is ever jailed, so the shop stays staffed.)
const bought = state.npcs.flatMap((n) => n.memories.filter((mm) => mm.text.startsWith("Bought a fresh loaf")));
const sold = [mara, tomas].flatMap((n) => n.memories.filter((mm) => mm.text.startsWith("Sold a fresh loaf")));
const edithBought = edith.memories.filter((mm) => mm.text.startsWith("Bought a fresh loaf"));
if (edithBought.length < DAYS) fail(`Edith should buy bread daily: ${edithBought.length} purchases over ${DAYS} days`);
if (sold.length !== bought.length) fail(`sales (${sold.length}) should mirror purchases (${bought.length})`);

// ---- Coin economy (Phase 8): total coins are conserved -------------------
// Bread sales and thefts only MOVE coin between people (nothing is minted
// or burned), so the town-wide total must equal the starting total.
const START_COINS = 30 + 14 + 20 + 18 + 8 + 5 + 3 + 15; // cast + player
const totalCoins = state.npcs.reduce((s, n) => s + (n.coins || 0), 0) + (state.player.coins || 0);
if (totalCoins !== START_COINS)
  fail(`coins not conserved: ${totalCoins} vs ${START_COINS} at start`);
// Sales should have moved coin into the bakers' pockets
if (sold.length > 0 && (mara.coins + tomas.coins) <= 44)
  fail(`bakers took ${sold.length} sales but hold no extra coin (${mara.coins}+${tomas.coins})`);

// ---- Crime & law chain (Phase 5+7) — seeded, so lifecycle not exact days ---
if (state.crimeLog.length < 1) fail("no crimes over the run — the market should tempt somebody");
const c0 = state.crimeLog[0];
if (c0) {
  const culprit = state.npcs.find((n) => n.id === c0.culprit);
  const victim = state.npcs.find((n) => n.id === c0.victim);
  if (!culprit?.gang) fail("first culprit should be a gang member");
  if (c0.loot === undefined) fail("crime should record what was stolen");
  // Full lifecycle: reported after the theft, arrested after the report,
  // released one day after arrest.
  if (c0.reportedDay === null || c0.reportedDay < c0.day) fail(`report day off: ${c0.reportedDay}`);
  if (c0.arrestDay === null || c0.arrestDay < c0.reportedDay) fail(`arrest day off: ${c0.arrestDay}`);
  if (c0.releaseDay !== null && c0.releaseDay !== c0.arrestDay + 1)
    fail(`culprit should serve exactly one day: arrested ${c0.arrestDay}, released ${c0.releaseDay}`);
  // memories on every side of the event
  if (!victim.memories.some((mm) => mm.text.includes(`${c0.loot} is gone`)))
    fail("victim never noticed the theft");
  if (!c0.witnesses.every((wid) => state.npcs.find((n) => n.id === wid)
        .memories.some((mm) => mm.text.startsWith("Saw ") && mm.importance === 9)))
    fail("witnesses missing their sighting memory");
  if (!bram.memories.some((mm) => mm.text.includes("reported the market theft")))
    fail("Bram never received the report");
  if (!bram.memories.some((mm) => mm.text.startsWith("Arrested ")))
    fail("Bram has no arrest memory");
  if (!culprit.memories.some((mm) => mm.text.includes("clapped me in the station cell")))
    fail("culprit has no jail memory");
  if (c0.releaseDay !== null && !culprit.memories.some((mm) => mm.text.startsWith("Out of the cell")))
    fail("culprit has no release memory");
}
// Hierarchy actually reshuffles: an arrest drops your cred below everyone,
// so after the first arrest the old order can't hold.
if (DAYS >= 3) {
  const shakeups = [silas, ren, pip].flatMap((n) =>
    n.memories.filter((mm) => mm.text.startsWith("Crew shake-up")));
  if (!shakeups.length) fail("no crew shake-up memories after an arrest");
  const cSilas = state.crimeLog.find((c) => c.culprit === "npc_silas");
  if (cSilas && cSilas.arrestDay !== null && silas.gangRank === "leader" && !silas.jailedUntil)
    fail("Silas was arrested but still leads the crew — hierarchy never shifted");
  const freeRanks = [silas, ren, pip].filter((n) => !n.jailedUntil).map((n) => n.gangRank);
  if (!freeRanks.includes("leader")) fail("nobody leads the crew");
}

// ---- Reflection accrual (Phase 7): importance piles up and flags a pass --
// No LLM here, so reflections never actually fire — but the trigger must arm.
if (!state.npcs.some((n) => n.needsReflection || n.importanceSinceReflection > 0))
  fail("no NPC accumulated any reflection weight over the run");
if (!state.npcs.some((n) => n.needsReflection))
  fail(`nobody crossed the reflection threshold (${SIM.REFLECTION_THRESHOLD}) in ${DAYS} days`);
// Reflection memories don't feed their own accrual (would loop forever)
for (const n of state.npcs)
  if (n.needsReflection && n.memories.filter((m) => m.type !== "reflection")
        .reduce((s, m) => s + m.importance, 0) < SIM.REFLECTION_THRESHOLD)
    fail(`${n.name} flagged reflection without enough non-reflection weight`);

// ---- Cascading consequence: jailed staff shut the shop (Phase 7) ---------
{
  const st4 = SIM.createState(SEED);
  // Run to mid-morning, then jail BOTH bakers — simulating an arrest wave.
  while (!(st4.clock.day === 1 && st4.clock.minutes >= SIM.hm("08:30"))) SIM.tick(st4, DT);
  const [m4, t4] = st4.npcs;
  m4.jailedUntil = SIM.absMinutes(st4.clock) + 100000;
  t4.jailedUntil = SIM.absMinutes(st4.clock) + 100000;
  if (SIM.bakeryOnDuty(st4) !== null) fail("bakery reads staffed with both bakers jailed");
  while (!(st4.clock.day === 1 && st4.clock.minutes >= SIM.hm("11:00"))) SIM.tick(st4, DT);
  const shutMemos = st4.npcs.flatMap((n) => n.memories.filter((mm) => mm.text.includes("bakery was shut")));
  if (!shutMemos.length) fail("no customer noticed the shop was shut while both bakers were jailed");
  if (!shutMemos.some((mm) => mm.text.includes("taken in by the constable")))
    fail("shut-shop memory should name the arrest as the cause");
  if (st4.npcs.some((n) => !n.gang && !n.isOfficer && n.lastPurchaseDay === 1))
    fail("someone bought bread from an unstaffed bakery");
}

// ---- Randomness: different seeds produce different crime waves ------------
{
  const summarize = (seed) => {
    const s = SIM.createState(seed);
    for (let i = 0; i < Math.ceil((3 * SIM.DAY_REAL_SECONDS) / DT); i++) SIM.tick(s, DT);
    return s.crimeLog.map((c) => `${c.culprit}:${c.loot}`).join(",");
  };
  const a = summarize(1), b = summarize(2), c = summarize(3);
  if (a === b && b === c) fail("crime waves identical across seeds — randomness not wired");
}

// ---- Needs: hunger drives eating (Phase 9) --------------------------------
// Everyone got hungry and, having bought/carried bread, ate at least once.
for (const n of state.npcs)
  if (n.hunger < 0 || n.hunger > 100) fail(`${n.name} hunger out of range: ${n.hunger}`);
const ateMemos = state.npcs.flatMap((n) =>
  n.memories.filter((mm) => mm.text.includes("Ate a loaf") || mm.text.includes("Ate one of my own")));
if (ateMemos.length < DAYS) fail(`too few meals eaten: ${ateMemos.length} over ${DAYS} days`);
// A working baker keeps herself fed from her own oven — she eats regularly
// (instantaneous hunger is snapshot-timing-sensitive, so assert meals eaten).
const maraMeals = mara.memories.filter((mm) => mm.text.includes("Ate one of my own")).length;
if (maraMeals < DAYS) fail(`Mara didn't keep herself fed: only ${maraMeals} meals over ${DAYS} days`);

// ---- Rumor: firsthand news reaches non-witnesses via gossip ---------------
// (No LLM here, so no NPC conversations fire — assert the spread mechanic
//  directly and prove secondhand memories don't re-propagate.)
{
  const s = SIM.createState(SEED);
  const [m2, , e2] = s.npcs;
  SIM.addMemory(s, m2, "observation", "Watched Bram march Ren off to the station cell.", { importance: 8 });
  const first = SIM.spreadRumor(s, m2, e2);
  if (!first) fail("rumor didn't spread a high-importance firsthand fact");
  if (!e2.memories.some((mm) => mm.text.startsWith("Heard from Mara") && mm.text.includes("march Ren")))
    fail("listener didn't record the rumor with its source");
  if (SIM.spreadRumor(s, m2, e2) !== null) fail("same rumor spread twice");
  // secondhand "Heard from" memories must not re-propagate as firsthand
  if (SIM.spreadRumor(s, e2, s.npcs[3]) !== null) fail("secondhand rumor re-propagated");
}

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

// Physical items: the counter restocks from real oven batches, purchases
// consume loaves, and totals stay bounded
if (SIM.bakeryBreadCount(state) > 4)
  fail(`bakery counter overstocked: ${SIM.bakeryBreadCount(state)} loaves`);
if (state.worldItems.length > 12)
  fail(`world item count runaway: ${state.worldItems.length}`);
if (!state.worldItems.some((it) => it.kind === "apple"))
  fail("market stall goods went missing without anyone taking them");

// A player who joined the police suppresses street crime entirely
{
  const st3 = SIM.createState();
  st3.player.faction = "police"; // plaza spawn is close enough to the market
  for (let i = 0; i < Math.ceil((2 * SIM.DAY_REAL_SECONDS) / DT); i++) SIM.tick(st3, DT);
  if (st3.crimeLog.length !== 0)
    fail(`crimes happened under a police-player's nose: ${st3.crimeLog.length}`);
}

// Pathfinder sanity
const path = SIM.findPath(state.map, mara.locations.home.x, mara.locations.home.y,
                          mara.locations.market.x, mara.locations.market.y);
if (!path || path.length < 5) fail("no path home -> market");
const blocked = SIM.findPath(state.map, 5, 5, 6, 22); // pond center
if (blocked !== null) fail("pathfinder returned a path into solid water");

// ---- Mock-embedder run: pipeline + batching cost ceiling ------------------
// 32-dim rolling hash so distinct texts get distinct vectors (an exact
// match is then uniquely the nearest — mirrors real embedding behavior).
const mockEmbed = async (texts) => texts.map((t) => {
  const v = new Array(32).fill(0);
  let h = 2166136261;
  for (let i = 0; i < t.length; i++) {
    h = (Math.imul(h ^ t.charCodeAt(i), 16777619)) >>> 0;
    v[i % 32] += ((h % 2000) / 1000) - 1;
  }
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
});
const st2 = SIM.createState(777);
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
// Embedded retrieval end-to-end: an exact-text query, scored on relevance
// alone, must rank its own memory first (cosine 1.0). Uses a memory that
// actually exists this run, decoupled from the now-randomized schedules.
const anchorNpc = st2.npcs.find((n) => n.memories.length > 3);
const anchorMem = anchorNpc.memories[anchorNpc.memories.length - 1];
const qv = (await mockEmbed([anchorMem.text]))[0];
const top2 = SIM.retrieveMemories(st2, anchorNpc,
  { queryVec: qv, N: 3, weights: { recency: 0, importance: 0, relevance: 1 } });
// The top result must be an exact-text match (relevance 1.0) — duplicate
// daily memories share the text, so match on text, not id.
if (top2[0].memory.text !== anchorMem.text || top2[0].relevance < 0.999)
  fail("embedded retrieval: exact-text query didn't rank a matching memory first on relevance");

console.log(`Simulated ${DAYS} day(s) in ${totalSteps} ticks — ` +
            `${totalMems} memories across ${state.npcs.length} NPCs, ` +
            `${bought.length} bread purchases, model calls: fable5=${state.modelCalls.fable5}, ` +
            `embeddings=${state.modelCalls.embeddings} (no provider) / ` +
            `mock run: ${mems2.length} memories, ${st2.modelCalls.embeddings} batched embed calls`);
if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log("OK: all headless checks passed");
