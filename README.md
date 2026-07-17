# Generative Agent Town Sim

A persistent pixel-art town where NPCs have their own daily routines, memories,
relationships, and free will — built on the Stanford "Generative Agents"
(Smallville) architecture. Full design doc: [`docs/project-plan.pdf`](docs/project-plan.pdf).

**The cast (v1):** seven characters, each with their own personality, wants,
and long-term goal — Mara (baker, owns the bakery), Tomas (her assistant),
Edith (retired seamstress, bakery regular), Constable Bram (patrols, takes
reports, makes arrests), and the Mudlarks — the town's petty thieving crew:
Silas ("fisherman", secretly the leader), Ren (lieutenant, best pickpocket in
town), and Pip (soft-hearted lookout who isn't sure crew life is for him).
The town has the bakery (full interior), homes for everyone, the constable's
station with a jail cell, the gang's boat-shed hideout, a market square, and a
park by the pond.

With an Anthropic key set, everything they do is AI-decided: each character
plans their own day (skipping work for the park is a valid choice — routines
are tendencies, not rules), chats with whoever they run into, and remembers
all of it. Underneath sits a deterministic cause-and-effect layer the AI
reacts to: pickpocketing at the market → victim and witnesses remember → a
witness runs into Bram and reports it → culprit is wanted → pursuit on sight →
arrest → a day in the cell → **the gang hierarchy reshuffles** (an arrest
drops you below everyone; ranks recompute, promotions become memories, and
the old boss comes back at the bottom). Every link in that chain writes
high-importance memories, so plans, conversations, and gossip bend around it.

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

Every character starts with a **full identity**, not just a stat line: a
written backstory (who they are, where they came from, what they're afraid of),
an age, and a **mood** (0–100 contentment) that real events push around — an
arrest, a robbery, a gift, a good meal, landing honest work. That mood, the
backstory, and their wants/goals all ride into every prompt, so the model plays
a person rather than a role. Open the memory panel (**M**) and each character
shows their card: bio, age, current mood, traits, wants, goal, and what they're
carrying.

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

- **OpenAI key — runs the whole game on its own.** Paste it in the settings
  panel and everything works: every NPC plans, talks, reflects and gossips via
  `gpt-4o-mini`, and memory retrieval uses `text-embedding-3-small`. No second
  key needed. (Provider dropdown: Auto / OpenAI / Anthropic.)
- **Anthropic key — optional.** If you'd rather use `claude-fable-5` (with a
  server-side fallback to `claude-opus-4-8`) for the voice layer, add it and
  pick it in the dropdown; embeddings still come from OpenAI.

Whichever provider is active drives the same autonomy layer: every NPC plans
their own day each in-game morning (1 call/NPC/day, staggered), NPCs who meet
strike up their own conversations (1 call per line, max 4 lines, per-pair
cooldown), you can talk to anyone in free text (1 call/turn), high-importance
events trigger escalated re-plans, and once enough has happened to someone they
**reflect** — synthesizing their memories into higher-level insights that get
stored back and can rewrite their opinions and goals ("the market crowd is
where all the trouble begins" → a changed relationship with the fisherman).
Without any key: fallback rhythms + canned dialogue, no NPC-to-NPC chatter.

### Consequences ripple (nothing is isolated)

Actions land on other people. The clearest case: a shop only *operates* when
a non-jailed staffer is actually inside it — so if both bakers get arrested (or
simply choose a day at the park), the bakery is **SHUT**, and every customer
who comes for bread notices *and knows why* ("word is Mara and Tomas got taken
in by the constable"). That's a high-importance memory that bends their day and
spreads through gossip. Crime feeds law feeds the gang hierarchy feeds who's
around to run the shop — one arrest can quietly reshape the whole town's
morning.

### Needs make the economy load-bearing

NPCs get hungry over the day. They eat bread from their bag when they can; a
working baker eats from her own oven; anyone who goes famished with an empty
bag gets a plan-bending "I need to get to the bakery" memory. So bread demand
is *real* — which means the bakery matters, which means an arrest that shuts it
now leaves the whole town hungry, and hungry people change their plans. Hunger,
coins, and job status all show on each NPC's card in the memory panel.

### News travels (rumor propagation)

When two NPCs talk, they don't just co-exist — they swap their juiciest recent
firsthand news. So an arrest, a theft, or a shut shop reaches people who never
witnessed it, attributed to who they heard it from ("Heard from Mara: …").
Secondhand memories don't echo onward, so gossip spreads one hop per teller
instead of looping forever — the town develops a shared, imperfect awareness of
its own events.

### Seeded randomness

The world has luck. Each session rolls a seed (`createState(seed)` fixes it);
gang members have individual **risk appetite**, so whether anyone steals on a
given day — and who, and what they lift (coin purse, silver ring, pocket watch,
a loaf…) — varies run to run. Bold Ren works the crowd often; cautious Pip
rarely does. Same seed replays identically (that's how the tests stay
deterministic); different seeds tell different stories.

### Conversations change the world (no scripts)

Every dialogue turn — yours or NPC-to-NPC — returns `{line, effects}`. The
model decides *what happens*; a small interpreter is only the physics. The
effect vocabulary: give/take items, **pay coins**, **hire/fire** (a real job
at the bakery), set roles (get sworn in as the constable's deputy), join or
leave factions (police / the Mudlarks), shift opinions, rewrite long-term
goals, plant memories, trigger re-plans, **lift or sink someone's mood**, send
someone off on an **errand** (`go_to` — they drop what they were doing and head
to the park/market/bakery/home for a few hours), and **report a crime** to the
law (a witness naming a thief in conversation feeds the same arrest chain the
deterministic layer uses — you can talk a case into motion). A player sworn
into the police suppresses street crime nearby; an NPC who quits the gang
reshuffles the hierarchy on the spot. Invalid or over-reaching effects are
dropped silently — the sim never breaks on a malformed response.

### Things people do on their own (solo actions)

Nobody's day is only reactive. Spend real time at a hands-on activity and you
make something: Silas fishing at the pond lands a **fish**, Edith on her park
bench finishes a **wool scarf**, and the plan's activity id (`fish`, `forage`,
`knit`, `whittle`, `garden`, `sketch`) decides what — a physical good, once a
day, that then flows through the same gift/trade/inventory systems. It's
deterministic (no shared-RNG draw, so seeded runs stay reproducible) and shows
up in memories and the held-item art like anything else.

### A coin economy, and jobs that are real

Everyone carries coins (the bakers richer, the gang broke). Bread costs 2
coins and the coin actually moves from customer to baker; a stolen coin purse
transfers real money from the victim; the `pay` effect settles debts and
bribes. Coins are conserved town-wide — nothing is minted, only moved.

Employment is not cosmetic. `hire` makes someone **actual bakery staff**: they
work the counter, and the shop is *open because of them*. Hire the player and
you can run the counter yourself and take the coin — even keep the shop open
after Mara's arrested. Hire Pip and he leaves the gang for honest work (which
reshuffles the crew) and re-plans his day around the job. It's the loop that
closes "hire the player as staff who actually mans the counter."

### Physical items

Items exist in the world: loaves stack on the bakery counter (restocked by
real oven batches, consumed by purchases), goods sit on market stalls, and
everyone visibly holds their latest possession. Walk up and press **E** to
pick things up — though grabbing off the counter under staff eyes is
remembered, and what that *means* is up to the AI. Items move between people
through dialogue effects, land in inventories, and show up in memories.

Game state (memories, plan, clock) auto-saves to localStorage; "Reset save
data" in settings wipes it.

## Testing

The sim core lives in a `<script id="sim-core">` block inside `index.html` —
pure logic, no DOM — so the headless harness runs the exact shipped code in Node:

```sh
node test/retrieval.mjs       # retrieval math vs a hand-written memory log
node test/planning.mjs        # plans, dialogue effects, reflection, gang math (mock LLM)
node test/headless.mjs        # 3 simulated days (default), seed 12345
node test/headless.mjs 7      # a full week
node test/headless.mjs 3 99   # a different seed → a different crime wave
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
calls always fall back to the previous plan. It also covers the Phase 10
actions: the `mood` effect (nudge, clamp, participant-scoping, memory on a big
swing), `go_to` errands (override the plan, clear on arrival), `report_crime`
(a witness feeding the arrest chain, non-witnesses rejected), and solo crafting
(yields once/day, draws no shared RNG).

`headless.mjs` runs simulated days: NPC at the scheduled place (or inside the
bakery working a station) at spot-check times, never stuck en route, no NaN
drift, day rollover, memory volume bounds, perception cooldowns, oven-session
bounds, no orphaned `related_ids`, and the cost ceiling — zero model calls
with no provider configured, and with a mock embedder only batched per-write
calls (never per-tick), `fable5` still zero (instrumented via
`state.modelCalls`). It also asserts the Phase 10 identity layer over the run:
every NPC keeps a bio/age/in-range mood, moods actually drift from their
starting values, the arrested culprit takes a mood hit, and solo crafting
produces goods (Silas's fish, Edith's scarf) at most once per day.

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
- [x] **5. Roles & dynamics** — seven-NPC cast with per-character wants/goals/secrets
      woven into every prompt; Constable Bram (patrols, reports, pursuit, arrests) and
      the Mudlarks gang (cred-ordered hierarchy, cover identities); station with jail
      cell + boat-shed hideout; deterministic crime chain (theft → witnesses → report →
      wanted → arrest → one-day sentence → rank reshuffle → lie-low period) that the
      AI planning/conversation layer reacts to.
- [x] **6. Open-ended agency** — dialogue effects engine (`{line, effects}` from every
      turn): item transfers, role changes, faction joins/leaves, opinion shifts, goal
      rewrites, planted memories, re-plan triggers — all model-decided, interpreter-
      validated. Physical world items (counter loaves restocked by oven batches,
      stall goods, pickups with E, held-item rendering), player identity (role,
      faction, inventory — a deputized player suppresses street crime), OpenAI
      (`gpt-4o-mini`) as a selectable voice/planning provider alongside Fable 5.
- [x] **7. Intellect & ripple** — reflection (threshold-triggered memory synthesis into
      insights that rewrite opinions/goals); cascading consequences (a business only
      operates when staff are present, so an arrest or a day off shuts the shop and
      customers react with the reason); seeded randomness (per-run luck, gang risk
      appetite, varied loot) so stories diverge run to run.
- [x] **8. Economy & employment** — coins on everyone (conserved town-wide), real coin
      transfer on bread sales / theft / the new `pay` effect; `hire`/`fire` that makes
      someone actual bakery staff (a hired player runs the counter and keeps the shop
      open; a hired NPC leaves the gang and re-plans around the job).
- [x] **9. Needs, gossip & one-key play** — hunger system (bread demand is real, so the
      bakery/arrest cascade has teeth); rumor propagation (firsthand news spreads one hop
      per teller, attributed, no echo loops); settings made clear that one OpenAI key runs
      dialogue + planning + embeddings.
- [x] **10. Identity & richer actions** — every character starts with a full
      written identity (backstory, age) plus a **mood** (0–100) that real events
      move (arrest −, robbery −, gift +, honest work +, a good meal +, famine −),
      all surfaced in prompts and on the character card. New action vocabulary:
      `mood`, `go_to` (drop everything and run an errand), `report_crime` (talk a
      case into the arrest chain), and **solo crafting** — time at a `fish`/`knit`/
      `whittle`/`forage`/`garden`/`sketch` activity produces a real item once a day.
- [ ] **11. World fill** — more runnable businesses, shop hours, pathfinding polish,
      more cast and places, still-wider effect vocabulary.
- [ ] **12. Polish/juice** — dialogue UI, ambient SFX, simulated-week cost-ceiling runs, final art pass.

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
