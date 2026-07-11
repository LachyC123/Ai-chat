// Retrieval-math unit tests (plan §8): validate the scoring function
// against a hand-written memory log with known expected top-N results —
// no live model calls involved.
//
//   node test/retrieval.mjs

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

// ---- cosine similarity -------------------------------------------------
check("cosine identical", Math.abs(SIM.cosineSim([1, 0], [1, 0]) - 1) < 1e-9);
check("cosine orthogonal", Math.abs(SIM.cosineSim([1, 0], [0, 1])) < 1e-9);
check("cosine opposite", Math.abs(SIM.cosineSim([1, 0], [-1, 0]) + 1) < 1e-9);
check("cosine zero vector", SIM.cosineSim([0, 0], [1, 0]) === 0);

// ---- importance heuristic (scored at creation, never a model call) -----
const IMP_CASES = [
  ["Got into an argument with Tomas at the market.", 9],
  ["The player gave me a gift of flowers.", 8],
  ["Tomas helped fix the oven.", 7],
  ["Heard a rumor about the stall on the corner.", 6],
  ["Noticed the player nearby at the market square.", 4],
  ["Opened the bakery for the morning.", 2],
  ["The sky looked strange this evening.", 3], // default
];
for (const [text, want] of IMP_CASES) {
  const got = SIM.scoreImportance(text, "observation");
  check(`importance("${text}")`, got === want, `want ${want}, got ${got}`);
}
check("reflection importance", SIM.scoreImportance("anything", "reflection") === 6);

// ---- hand-written memory log with known expected top-N -------------------
// now = abs minute 10000. Components (worked by hand):
//   recency raw 0.99^h:  A(1h)=.990  B(100h)=.366  C(10h)=.904  D(50h)=.605
//   -> min-max:          A 1.000     B 0.000       C 0.863      D 0.383
//   importance 3/9/6/2 -> A 0.143    B 1.000       C 0.571      D 0.000
//   cos vs [1,0,0]:      A 0         B 0           C 1          D 0.6
// equal weights => C 2.434 > A 1.143 > B 1.000 > D 0.983
const state = SIM.createState();
state.clock = { day: Math.floor(10000 / 1440) + 1, minutes: 10000 % 1440 };
const mara = state.npcs[0];
const mk = (id, hoursAgo, importance, embedding, text) => ({
  id, npc: "npc_mara", ts: 10000 - hoursAgo * 60,
  timestamp: SIM.fmtTimestamp(10000 - hoursAgo * 60),
  type: "observation", text, importance, embedding, related_ids: [],
});
mara.memories = [
  mk("mem_A", 1, 3, [0, 1, 0], "A recent unimportant irrelevant"),
  mk("mem_B", 100, 9, [0, 0, 1], "B old important irrelevant"),
  mk("mem_C", 10, 6, [1, 0, 0], "C fresh-ish important relevant"),
  mk("mem_D", 50, 2, [0.6, 0.8, 0], "D older unimportant half-relevant"),
];
const q = [1, 0, 0];
const ids = (rs) => rs.map((r) => r.memory.id).join(",");

const full = SIM.retrieveMemories(state, mara, { queryVec: q, N: 4 });
check("equal-weight order", ids(full) === "mem_C,mem_A,mem_B,mem_D", ids(full));
check("scores desc", full.every((r, i) => i === 0 || full[i - 1].score >= r.score));
check("components in [0,1]", full.every((r) =>
  [r.recency, r.importance, r.relevance].every((v) => v >= 0 && v <= 1)));
check("top score value", Math.abs(full[0].score - 2.434) < 0.01, String(full[0].score));

const impOnly = SIM.retrieveMemories(state, mara,
  { queryVec: q, N: 4, weights: { recency: 0, importance: 1, relevance: 0 } });
check("importance-only order", ids(impOnly) === "mem_B,mem_C,mem_A,mem_D", ids(impOnly));

const recOnly = SIM.retrieveMemories(state, mara,
  { queryVec: q, N: 4, weights: { recency: 1, importance: 0, relevance: 0 } });
check("recency-only order", ids(recOnly) === "mem_A,mem_C,mem_D,mem_B", ids(recOnly));

const noQuery = SIM.retrieveMemories(state, mara, { N: 4 });
check("no-query fallback order", ids(noQuery) === "mem_C,mem_A,mem_B,mem_D", ids(noQuery));

check("top-N truncation", SIM.retrieveMemories(state, mara, { queryVec: q, N: 2 }).length === 2);

// Unembedded memories participate with raw relevance 0 (pending embed)
mara.memories.push(mk("mem_E", 0.5, 5, null, "E not yet embedded"));
const mixed = SIM.retrieveMemories(state, mara, { queryVec: q, N: 5 });
check("mixed embedded/unembedded doesn't crash", mixed.length === 5);
check("mixed scores finite", mixed.every((r) => Number.isFinite(r.score)));

// Single-memory stream: min-max degenerates to 1, no NaN
mara.memories = [mk("mem_only", 1, 5, [1, 0, 0], "only memory")];
const single = SIM.retrieveMemories(state, mara, { queryVec: q, N: 5 });
check("single memory no NaN", single.length === 1 && Number.isFinite(single[0].score));

// ---- addMemory + embed queue mechanics ----------------------------------
const s2 = SIM.createState();
const m2 = s2.npcs[0];
const mem = SIM.addMemory(s2, m2, "observation", "The player gave me a gift of bread.");
check("addMemory stores", m2.memories.length === 1 && s2.embedQueue[0] === mem);
check("addMemory auto-importance", mem.importance === 8, String(mem.importance));
check("addMemory schema fields",
  mem.id.startsWith("mem_") && mem.npc === "npc_mara" && mem.embedding === null &&
  /^day\d+_\d\d:\d\d$/.test(mem.timestamp) && Array.isArray(mem.related_ids));

const mockEmbed = async (texts) => texts.map((t) => {
  const v = new Array(8).fill(0);
  for (let i = 0; i < t.length; i++) v[i % 8] += t.charCodeAt(i) / 255;
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
});
SIM.setEmbedder(s2, mockEmbed);
SIM.addMemory(s2, m2, "observation", "Another day at the bakery.");
await SIM.processEmbedQueue(s2);
check("queue drained", s2.embedQueue.length === 0);
check("memories embedded", m2.memories.every((m) => m.embedding && m.embedding.length === 8));
check("one batched call", s2.modelCalls.embeddings === 1, String(s2.modelCalls.embeddings));
await SIM.processEmbedQueue(s2); // empty queue: must not count a call
check("no call on empty queue", s2.modelCalls.embeddings === 1);
check("embedText counts a call", (await SIM.embedText(s2, "query")) !== null && s2.modelCalls.embeddings === 2);
check("fable5 untouched", s2.modelCalls.fable5 === 0);

// Failed provider keeps the batch queued for retry
const s3 = SIM.createState();
SIM.setEmbedder(s3, async () => { throw new Error("boom"); });
SIM.addMemory(s3, s3.npcs[0], "observation", "will fail to embed");
let threw = false;
try { await SIM.processEmbedQueue(s3); } catch { threw = true; }
check("provider failure propagates", threw);
check("failed batch requeued", s3.embedQueue.length === 1);

if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log("OK: all retrieval-math checks passed");
