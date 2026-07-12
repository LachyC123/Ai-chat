# Generative Agent Town Sim

A persistent pixel-art town where NPCs have their own daily routines, memories,
relationships, and free will — built on the Stanford "Generative Agents"
(Smallville) architecture. Full design doc: [`docs/project-plan.pdf`](docs/project-plan.pdf).

**The cast (v1):** Mara (baker, owns the bakery), Tomas (her assistant), and
Edith (retired seamstress, bakery regular). The town has the bakery (full
interior), three homes, a market square, and a park by the pond. With an
Anthropic key set, everything they do is AI-decided: each character plans their
own day (skipping work for the park is a valid choice — routines are
tendencies, not rules), chats with whoever they run into, and remembers all of
it. The bakery runs like a bakery because its people choose to run it, not
because a script says so.

**The cast (all fully AI-driven when a key is set):**
- **Mara** — baker and owner of the bakery (warm, gossipy, proud)
- **Tomas** — her assistant baker (quiet, practical, kind)
- **Edith** — a retired seamstress (sharp-tongued, nostalgic, kind-hearted) who
  drops by the bakery for a loaf, browses the market, and relaxes at the park

Nothing is forced: each NPC plans their own day every in-game morning — the
prompt explicitly tells the model that work is optional and routines are
tendencies, not rules. If Edith skips the bakery for a park day, that's her
choice. NPCs perceive each other, chat spontaneously when they meet (content
entirely model-decided, shown as speech bubbles), remember conversations, and
the bakery runs like a bakery: staff rotate the oven/counter/shelves, Edith
buys bread when a worker is around.

**Design pillars:** legibility over scale · memory is the game · cheap loop, expensive voice.

## Running

The whole game is a single file. Open `index.html` in a browser, or serve it:

```sh
python3 -m http.server 8000   # then visit http://localhost:8000
```

Controls: **WASD / arrows** move · **E** talk · **M** memory stream · **T** toggle time ×10 · touch: drag anywhere for a virtual joystick, tap TALK.

### API keys (optional — the sim runs without them)

Open the ⚙ settings panel to add keys. Both live only in your browser's
localStorage — never in the repo.

- **Anthropic key** — enables the Fable 5 autonomy layer (`claude-fable-5`,
  with a server-side fallback to `claude-opus-4-8` on safety-classifier false
  positives): every NPC plans their own day each in-game morning (1 call/NPC/
  day, staggered), NPCs who meet strike up their own conversations (1 call per
  line, max 4 lines, per-pair cooldown), you can talk to anyone in free text
  (1 call/turn), and high-importance events — overheard gossip, a theft report
  — trigger an escalated re-plan (cooldown-limited). Without it: fallback
  rhythms + canned dialogue, no NPC-to-NPC chatter.
- **OpenAI key** — enables memory embeddings (`text-embedding-3-small`).
  Without it, retrieval scores on recency + importance.

Game state (memories, plan, clock) auto-saves to localStorage; "Reset save
data" in settings wipes it.

## Testing

The sim core lives in a `<script id="sim-core">` block inside `index.html` —
pure logic, no DOM — so the headless harness runs the exact shipped code in Node:

```sh
node test/retrieval.mjs       # retrieval math vs a hand-written memory log
node test/planning.mjs        # plan validation, prompts, dialogue, re-plan (mock LLM)
node test/headless.mjs        # 3 simulated days (default)
node test/headless.mjs 7      # a full week
```

`retrieval.mjs` validates the scoring function (α·recency + β·importance +
γ·relevance, min-max normalized, recency decay `0.99^hours`) against a
hand-written memory log with hand-computed expected top-N orderings, plus the
importance heuristic, cosine similarity, and embed-queue mechanics — no live
model calls involved.

`planning.mjs` validates the Fable 5 layer offline: plan JSON parsing +
validation (chronology, known places, must end asleep at home), prompt
construction (§7 discipline: sheet + retrieved memories + tight format), a
mock plan actually steering Mara's movement, dialogue turns becoming memories,
and the interruption → re-plan path with its cooldown. Invalid or failed plan
calls always fall back to the previous plan.

`headless.mjs` runs simulated days: NPC at the scheduled place (or inside the
bakery working a station) at spot-check times, never stuck en route, no NaN
drift, day rollover, memory volume bounds, perception cooldowns, oven-session
bounds, no orphaned `related_ids`, and the cost ceiling — zero model calls
with no provider configured, and with a mock embedder only batched per-write
calls (never per-tick), `fable5` still zero (instrumented via
`state.modelCalls`).

## Build phases (plan §9)

- [x] **1. Skeleton** — tilemap render, player movement + virtual joystick, buildings,
      one NPC (Mara the baker) walking a hardcoded schedule loop, day/night palette,
      A* pathfinding, headless harness. No LLM.
- [x] **2. Memory + retrieval** — memory stream (observations from perception +
      activity transitions, dialogue), heuristic importance scoring, OpenAI
      `text-embedding-3-small` pipeline with batched queue, recency/importance/relevance
      retrieval validated against a hand-written memory log, memory inspector
      panel (M), localStorage persistence, key entry via settings panel.
- [x] **3. Planning + dialogue** — Fable 5 (`claude-fable-5` + Opus fallback) generates
      daily schedules each morning and answers free-text conversation fed by
      `retrieveMemories()`; high-importance perceptions escalate to a re-plan
      (threshold check is free, cooldown-limited). Bakery got a cutaway interior
      (oven / counter / kneading table / shelves) with a deterministic workstation
      rotation. Strict plan validation with fallback to the previous schedule.
- [x] **4. Scale cast (first slice)** — three NPCs (Mara, Tomas, Edith), each with
      their own home, sheet, relationships, and fallback rhythm; a park with benches;
      free-choice planning (work optional, park days allowed, 3-8 anchors, wake
      05:00-10:00); NPC-to-NPC perception and spontaneous model-driven conversations
      (per-pair cooldown, turn cap, one at a time, both sides remember); bread
      buying/selling between customer and staff; per-NPC memory panel tabs.
- [ ] **5. Reflection + more cast/places** — reflection cadence (insights compound into
      opinions), relationship summaries that evolve, more NPCs and locations.
- [ ] **5b. World fill** — remaining buildings, items, shop hours, pathfinding polish.
- [ ] **6. Polish/juice** — dialogue UI, ambient SFX, simulated-week cost-ceiling runs, final art pass.

## Architecture notes (Phase 1)

- `index.html` — sim core (map, A*, clock, agent schedule loop, collision) +
  browser layer (canvas renderer with procedural tile atlas, input, dialogue UI).
  Current pixel art is procedural placeholder; Kenmi Cute Fantasy / curated
  Higgsfield assets replace the atlas in Phase 5.
- Agent/building/memory objects follow the plan §6 schemas.
- Both model providers are injected (`SIM.setEmbedder` / `SIM.setLLM`): the
  browser wires OpenAI/Anthropic when keys exist, tests wire deterministic
  mocks, and the default is none — retrieval, plan validation, dialogue, and
  re-plan logic are all testable offline. `state.modelCalls` counts every
  provider call.
- Fable 5 calls are rationed per plan §7: 1 planning call/NPC/day, 1 call per
  player-initiated dialogue turn, and re-plans only when a perception clears
  the importance threshold (cheap check) and the cooldown. Prompts are terse
  and structured; plan output is strictly validated and falls back to the
  previous schedule on any failure.
