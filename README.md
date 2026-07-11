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

Controls: **WASD / arrows** move · **E** talk · **T** toggle time ×10 · touch: drag anywhere for a virtual joystick, tap TALK.

## Testing

The sim core lives in a `<script id="sim-core">` block inside `index.html` —
pure logic, no DOM — so the headless harness runs the exact shipped code in Node:

```sh
node test/headless.mjs        # 3 simulated days (default)
node test/headless.mjs 7      # a full week
```

Checks: NPC is at the scheduled place at spot-check times, never stuck en route,
no NaN drift, day rollover, pathfinding sanity, and the cost ceiling —
**zero model calls** are made in Phase 1 (instrumented via `state.modelCalls`).

## Build phases (plan §9)

- [x] **1. Skeleton** — tilemap render, player movement + virtual joystick, buildings,
      one NPC (Mara the baker) walking a hardcoded schedule loop, day/night palette,
      A* pathfinding, headless harness. No LLM.
- [ ] **2. Memory + retrieval** — OpenAI `text-embedding-3-small` + recency/importance/relevance
      scoring, validated against a hand-written memory log before any live calls.
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
- Agent/building objects already follow the plan §6 schemas so Phase 2 memory
  objects slot in without reshaping state.
- NPC dialogue is hardcoded placeholder small talk — the Fable 5 voice layer
  is deliberately absent until the memory layer exists to feed it.
