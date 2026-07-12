// Phase 3 tests: plan parsing/validation, prompt construction (plan §7:
// terse + structured so parsing is unit-testable), dialogue turns, and
// interruption/re-plan — all against a mock LLM, no live calls.
//
//   node test/planning.mjs

import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const src = html.match(/<script id="sim-core">([\s\S]*?)<\/script>/)[1];
const mod = { exports: {} };
new Function("module", "exports", src)(mod, mod.exports);
const SIM = mod.exports;

let failures = 0;
const check = (name, cond, detail = "") => {
  if (cond) return;
  failures++;
  console.error(`FAIL: ${name}${detail ? ` — ${detail}` : ""}`);
};

// ---- validatePlan ---------------------------------------------------------
const GOOD = [
  ["06:30", "wake", "home", "slow morning"],
  ["07:00", "open_shop", "bakery", "opening up"],
  ["09:30", "errand", "market", "running an errand"],
  ["11:00", "tend_shop", "bakery", "back to the counter"],
  ["19:00", "head_home", "home", "heading home"],
  ["22:00", "sleep", "home", "sleeping"],
];
check("accepts a valid plan", JSON.stringify(SIM.validatePlan(JSON.stringify(GOOD))) === JSON.stringify(GOOD));
check("tolerates prose/fences around the array",
  SIM.validatePlan("Here is the plan:\n```json\n" + JSON.stringify(GOOD) + "\n```\nDone!") !== null);

// Freedom (Phase 4): a lazy no-work day at the park is a perfectly valid
// plan — nothing is forced.
const LAZY = [
  ["09:30", "wake", "home", "sleeping in"],
  ["11:00", "park_time", "park", "dozing on a bench"],
  ["17:00", "supper", "home", "early supper"],
  ["21:00", "sleep", "home", "sleeping"],
];
check("accepts a lazy skip-work park day", SIM.validatePlan(JSON.stringify(LAZY)) !== null);
check("accepts a minimal 3-entry day", SIM.validatePlan(JSON.stringify([
  ["08:00", "wake", "home", "a very slow day"],
  ["14:00", "park_time", "park", "an afternoon outside"],
  ["21:00", "sleep", "home", "sleeping"],
])) !== null);

const BAD = [
  ["not json at all", "well, she should probably bake"],
  ["too few entries", JSON.stringify(GOOD.slice(0, 2))],
  ["too many entries", JSON.stringify([...GOOD, ...GOOD])],
  ["unknown place", JSON.stringify(GOOD.map((e, i) => i === 2 ? ["09:30", "errand", "tavern", "x"] : e))],
  ["non-chronological", JSON.stringify([GOOD[1], GOOD[0], ...GOOD.slice(2)])],
  ["duplicate time", JSON.stringify(GOOD.map((e, i) => i === 1 ? ["06:30", "open_shop", "bakery", "x"] : e))],
  ["doesn't end with sleep", JSON.stringify([...GOOD.slice(0, 5), ["22:00", "party", "home", "up late"]])],
  ["sleep away from home", JSON.stringify([...GOOD.slice(0, 5), ["22:00", "sleep", "market", "zzz"]])],
  ["first anchor too late", JSON.stringify([["11:00", "wake", "home", "very late"], ...GOOD.slice(1)])],
  ["bad time format", JSON.stringify(GOOD.map((e, i) => i === 0 ? ["6:30", "wake", "home", "x"] : e))],
  ["bad activity id", JSON.stringify(GOOD.map((e, i) => i === 0 ? ["06:30", "Wake Up!", "home", "x"] : e))],
  ["overlong label", JSON.stringify(GOOD.map((e, i) => i === 0 ? ["06:30", "wake", "home", "x".repeat(61)] : e))],
];
for (const [name, text] of BAD)
  check(`rejects ${name}`, SIM.validatePlan(text) === null);

// ---- prompt construction --------------------------------------------------
const state = SIM.createState();
const mara = state.npcs[0];
SIM.addMemory(state, mara, "observation", "The player gave me a gift of flowers.");
mara.pendingInterrupt = null; // don't let the seed memory trip the replan path

const retrieved = SIM.retrieveMemories(state, mara, { N: 5 });
const pp = SIM.buildPlanningPrompt(state, mara, { retrieved });
check("planning system has traits", pp.system.includes("warm") && pp.system.includes("gossipy"));
check("planning system demands JSON only", pp.system.includes("ONLY a JSON array"));
check("planning prompt carries memories", pp.prompt.includes("gift of flowers"));
check("planning prompt carries skeleton", pp.prompt.includes('"open_shop"'));
check("planning prompt carries relationships", pp.prompt.includes("affinity"));

SIM.tick(state, 0.1); // sets mara.activity
const dp = SIM.buildDialoguePrompt(state, mara, retrieved, [
  { speaker: "Player", text: "hello!" }, { speaker: "Mara", text: "Morning!" },
], "got any bread?");
check("dialogue system stays terse", dp.system.includes("single short line"));
check("dialogue prompt carries memories", dp.prompt.includes("gift of flowers"));
check("dialogue prompt carries history", dp.prompt.includes("Player: hello!"));
check("dialogue prompt ends at her line", dp.prompt.trimEnd().endsWith("Mara:"));

// ---- generatePlan with a mock LLM ------------------------------------------
const CUSTOM = [
  ["06:00", "wake", "home", "waking up"],
  ["07:00", "open_shop", "bakery", "opening the bakery"],
  ["09:30", "errand", "market", "running a market errand"],
  ["12:00", "tend_shop", "bakery", "selling bread"],
  ["19:00", "head_home", "home", "heading home"],
  ["22:00", "sleep", "home", "sleeping"],
];
{
  const st = SIM.createState();
  const npc = st.npcs[0];
  SIM.setLLM(st, async () => JSON.stringify(CUSTOM));
  const plan = await SIM.generatePlan(st, npc);
  check("generatePlan applies a valid plan", JSON.stringify(npc.current_plan) === JSON.stringify(CUSTOM));
  check("generatePlan returns the plan", plan !== null);
  check("one fable5 call", st.modelCalls.fable5 === 1, String(st.modelCalls.fable5));
  check("plan memory recorded", npc.memories.some((m) => m.type === "plan" && m.text.includes("market errand")));
  check("lastPlanDay set", npc.lastPlanDay === st.clock.day);
}
{
  const st = SIM.createState();
  const npc = st.npcs[0];
  const before = JSON.stringify(npc.current_plan);
  SIM.setLLM(st, async () => "I think she should just vibe today, no schedule needed!");
  const plan = await SIM.generatePlan(st, npc);
  check("invalid plan keeps previous plan", plan === null && JSON.stringify(npc.current_plan) === before);
  check("plan failure counted", npc.planFailures === 1);
}
{
  const st = SIM.createState();
  const npc = st.npcs[0];
  SIM.setLLM(st, async () => { throw new Error("network down"); });
  const plan = await SIM.generatePlan(st, npc);
  check("provider error keeps previous plan", plan === null && npc.current_plan.length === 7);
}

// ---- end-to-end: mock plan actually steers movement -------------------------
{
  const st = SIM.createState();
  const npc = st.npcs[0];
  SIM.setLLM(st, async () => JSON.stringify(CUSTOM));
  // simulate the browser planning pump inside the tick loop
  const DT = 0.1;
  for (let i = 0; i < Math.ceil((0.25 * SIM.DAY_REAL_SECONDS) / DT); i++) { // ~6 in-game hours
    SIM.tick(st, DT);
    if (npc.needsPlan && st.llm) { npc.needsPlan = false; await SIM.generatePlan(st, npc); }
  }
  // 06:50 + 6h = ~12:50; CUSTOM has her back at the bakery from 12:00
  check("custom plan steers her (bakery at ~12:50)",
    SIM.insideBuilding(SIM.BUILDINGS[0], npc.x, npc.y),
    `at (${npc.x.toFixed(1)}, ${npc.y.toFixed(1)}) doing "${npc.activity.label}"`);
  check("exactly one planning call across the run", st.modelCalls.fable5 === 1, String(st.modelCalls.fable5));

  // At 09:30-12:00 the errand anchor should have sent her to the market —
  // verify the activity resolves from the custom plan
  const at10 = SIM.activityAt(npc, SIM.hm("10:00"));
  check("custom anchor resolves", at10.place === "market" && at10.activity === "errand");
}

// ---- dialogueTurn + interruption/re-plan ------------------------------------
{
  const st = SIM.createState();
  const npc = st.npcs[0];
  SIM.tick(st, 0.1);
  npc.pendingInterrupt = null;
  SIM.setLLM(st, async ({ prompt }) =>
    prompt.includes("stole") ? "A theft?! Keep your voice down — I'll close up early and check my till." : "Fresh out of the oven, dear.");

  const r1 = await SIM.dialogueTurn(st, npc, "got any bread?");
  check("dialogue returns a line", r1 && r1.line === "Fresh out of the oven, dear.");
  check("conversation recorded", npc.conversation.length === 2);
  check("dialogue memory added", npc.memories.some((m) => m.type === "dialogue" && m.text.includes("got any bread")));
  check("normal chat doesn't trip replan", npc.pendingInterrupt === null);

  const r2 = await SIM.dialogueTurn(st, npc, "someone stole from the market stalls!");
  check("theft line answered in character", r2 && r2.line.includes("theft") === false ? r2.line.includes("close up early") : true);
  check("high-importance exchange trips interrupt",
    npc.pendingInterrupt && npc.pendingInterrupt.importance >= SIM.REPLAN_THRESHOLD);

  const interrupt = SIM.takeInterrupt(st, npc);
  check("takeInterrupt yields the memory", interrupt && interrupt.text.includes("stole"));
  check("interrupt consumed", npc.pendingInterrupt === null);

  // Cooldown: a second interrupt right away is suppressed
  SIM.addMemory(st, npc, "observation", "Another fight broke out at the market!");
  check("second interrupt pending", npc.pendingInterrupt !== null);
  check("cooldown suppresses immediate re-plan", SIM.takeInterrupt(st, npc) === null);

  // ...but clears after the cooldown window
  st.clock.minutes += SIM.REPLAN_COOLDOWN_MIN + 1;
  SIM.addMemory(st, npc, "observation", "The player gave me a gift of honey.");
  check("interrupt allowed after cooldown", SIM.takeInterrupt(st, npc) !== null);

  check("dialogue calls counted", st.modelCalls.fable5 === 2, String(st.modelCalls.fable5));
}

// Refusal / empty response path: dialogueTurn returns null, nothing recorded
{
  const st = SIM.createState();
  const npc = st.npcs[0];
  SIM.tick(st, 0.1);
  const memsBefore = npc.memories.length;
  SIM.setLLM(st, async () => null);
  const r = await SIM.dialogueTurn(st, npc, "hello?");
  check("null response yields null turn", r === null);
  check("no memory recorded for failed turn", npc.memories.length === memsBefore);
  check("no conversation recorded for failed turn", npc.conversation.length === 0);
}

// ---- NPC-to-NPC conversations (Phase 4) --------------------------------------
{
  const st = SIM.createState();
  const [a, b] = st.npcs; // Mara, Tomas
  SIM.tick(st, 0.1);

  // no LLM -> no conversations, ever
  a.x = b.x = 10; a.y = b.y = 7;
  check("no convo pair without LLM", SIM.findConvoPair(st) === null);

  SIM.setLLM(st, async ({ prompt }) =>
    prompt.includes("You speak first") ? "Ovens are running hot today, Tomas."
      : "Aye — third batch already. Edith asked after you earlier.");

  // too far apart -> no pair
  b.x = 20;
  check("no pair when far apart", SIM.findConvoPair(st) === null);

  // adjacent -> pair found once, then cooldown blocks re-trigger
  b.x = 10.5; b.y = 7;
  const pair = SIM.findConvoPair(st);
  check("pair found when adjacent", pair && pair[0].id === "npc_mara" && pair[1].id === "npc_tomas");
  check("cooldown blocks immediate re-pair", SIM.findConvoPair(st) === null);

  const heard = [];
  const turns = await SIM.runNpcConversation(st, pair[0], pair[1], {
    onLine: (speaker, line) => heard.push(`${speaker.name}: ${line}`),
  });
  check("conversation alternates for the full turn cap",
    turns.length === SIM.NPC_CONVO_MAX_TURNS, String(turns.length));
  check("speakers alternate", turns[0].speaker === "Mara" && turns[1].speaker === "Tomas");
  check("onLine saw every line", heard.length === turns.length);
  check("both remember the chat",
    pair[0].memories.some((mm) => mm.type === "dialogue" && mm.text.startsWith("Chatted with Tomas")) &&
    pair[1].memories.some((mm) => mm.type === "dialogue" && mm.text.startsWith("Chatted with Mara")));
  check("talking flags released", !pair[0].talking && !pair[1].talking);
  check("activeConvo cleared", st.activeConvo === null);
  check("one call per line", st.modelCalls.fable5 === turns.length, String(st.modelCalls.fable5));

  // cooldown expiry re-enables the pair
  st.clock.minutes += SIM.NPC_CONVO_COOLDOWN_MIN + 1;
  check("pair eligible again after cooldown", SIM.findConvoPair(st) !== null);
}

// Sleeping NPCs never chat
{
  const st = SIM.createState();
  SIM.setLLM(st, async () => "zzz");
  SIM.tick(st, 0.1);
  const [a, b] = st.npcs;
  a.x = b.x = 10; a.y = b.y = 7;
  a.activity = { activity: "sleep", place: "home", label: "sleeping" };
  check("sleepers don't start conversations", SIM.findConvoPair(st) === null);
}

// tick raises needsPlan each morning
{
  const st = SIM.createState(); // day 1, 06:50
  const npc = st.npcs[0];
  SIM.tick(st, 0.1);
  check("needsPlan raised on day 1", npc.needsPlan === true);
  npc.needsPlan = false; npc.lastPlanDay = 1;
  SIM.tick(st, 0.1);
  check("not re-raised same day", npc.needsPlan === false);
  st.clock.day = 2; st.clock.minutes = SIM.hm("06:01");
  SIM.tick(st, 0.1);
  check("re-raised next morning", npc.needsPlan === true);
}

if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log("OK: all planning/dialogue checks passed");
