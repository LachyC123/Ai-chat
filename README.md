# Generative Agent Town Sim

A persistent pixel-art town where NPCs have their own daily routines, memories,
relationships, and free will — built on the Stanford "Generative Agents"
(Smallville) architecture. Full design doc: [`docs/project-plan.pdf`](docs/project-plan.pdf).

**Design pillars:** legibility over scale · memory is the game · cheap loop, expensive voice.

## Running

The whole game is a single file. Open `index.html` in a browser, or serve it:

```sh
python3 -m http.server 8000   # then visit http://localhost:8000
```

Controls: **WASD / arrows** move · **E** talk · **M** memory stream · **T** toggle time ×10 · touch: drag anywhere for a virtual joystick, tap TALK.

### Memory embeddings (optional)

Open the ⚙ settings panel and paste an OpenAI API key to enable memory
embeddings (`text-embedding-3-small`). The key lives only in your browser's
localStorage — never in the repo. Without a key the sim runs fine: memories
still accrue and retrieval scores on recency + importance until embeddings
exist. Game state (memories included) auto-saves to localStorage; "Reset save
data" in settings wipes it.

## Testing

The sim core lives in a `<script id="sim-core">` block inside `index.html` —
pure logic, no DOM — so the headless harness runs the exact shipped code in Node:

```sh
node test/retrieval.mjs       # retrieval math vs a hand-written memory log
node test/headless.mjs        # 3 simulated days (default)
node test/headless.mjs 7      # a full week
```

`retrieval.mjs` validates the scoring function (α·recency + β·importance +
γ·relevance, min-max normalized, recency decay `0.99^hours`) against a
hand-written memory log with hand-computed expected top-N orderings, plus the
importance heuristic, cosine similarity, and embed-queue mechanics — no live
model calls involved.

`headless.mjs` runs simulated days: NPC at the scheduled place at spot-check
times, never stuck en route, no NaN drift, day rollover, memory volume bounds,
perception cooldowns, no orphaned `related_ids`, and the cost ceiling — zero
model calls with no provider configured, and with a mock embedder only batched
per-write calls (never per-tick), `fable5` still zero (instrumented via
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
- [ ] **3. Planning + dialogue** — Fable 5 for daily plans and conversation; single NPC
      end-to-end, including interruption/re-plan.
- [ ] **4. Scale cast** — full roster (6–8), relationship graph, reflection cadence.
- [ ] **5. World fill** — remaining buildings, items, shop hours, pathfinding polish.
- [ ] **6. Polish/juice** — dialogue UI, ambient SFX, simulated-week cost-ceiling runs, final art pass.

## Architecture notes (Phase 1)

- `index.html` — sim core (map, A*, clock, agent schedule loop, collision) +
  browser layer (canvas renderer with procedural tile atlas, input, dialogue UI).
  Current pixel art is procedural placeholder; Kenmi Cute Fantasy / curated
  Higgsfield assets replace the atlas in Phase 5.
- Agent/building/memory objects follow the plan §6 schemas.
- The embedding provider is injected (`SIM.setEmbedder`): the browser wires
  OpenAI when a key exists, the headless harness wires a deterministic mock,
  and the default is none — so cosine similarity, batching, and retrieval are
  all testable offline. `state.modelCalls` counts every provider call.
- NPC dialogue is hardcoded placeholder small talk — the Fable 5 voice layer
  (Phase 3) will consume `retrieveMemories()` output, which already works.
