# Story bible

Everything the game says lives in [`src/story/strata.ts`](src/story/strata.ts) (world copy, palettes, choices) and
[`src/story/story.ts`](src/story/story.ts) (perks, endings, story composer). This note explains how the two source
documents — the **Infinite Story Engine blueprint** and the **origin‑story branches** — became playable.

## From blueprint to game

| Blueprint idea | In the game |
|----------------|-------------|
| Phase 1 · *Genesis* — a seed in the soil of code | The **Seedbed** (tutorial stratum) and the opening quote that starts every cycle |
| Phase 2 · *Narrative Loop / Fractal Worlds* | River → Canopy strata; the fractal **Threshold** gate; scale‑zoom transitions |
| Mycelial networks that connect and adapt | `world/mycelium.ts` – growth tips that seek nodes/echoes; links drawn between everything you wake |
| Echo system — “a tree grows where the player stood” | `entities/echoes.ts` – dash/purify/node/`R` plant echo‑trees; tier‑3 Echo makes them fire |
| Memory layers / timeline UI | `Tab` → **Memory Layers** (choices, stats, what the Mind noticed) |
| Lightweight neural net reacting to choices | `systems/mind.ts` – 5→8→4 seeded net turning play‑style into a latent world code |
| Phase 3 · *The Return* — the hero carries the whole story home | The **Seedbed, Remembered** – your echo grove, the Origin Seed, the composed story |

## The three affinities

The origin‑story documents offer three directions at every step. Each is tied to an affinity and a perk ladder:

| Affinity | Spirit | I | II | III |
|----------|--------|---|----|-----|
| **Root ❦** | mycelial symbiosis | entangling blade & spores | kills heal | Surge plants Sentinel Blooms |
| **Echo ◈** | living memory | ghost strikes | piercing bolts, wider arcs | echo‑trees awaken and shoot |
| **Flow ≋** | time & current | fast, damaging dash | speed + time‑dilating Surge | +50 % attack speed |

## The paths (choices)

| Act | Path | Affinity | Source branch |
|-----|------|----------|---------------|
| I · Awakening of the Silico‑Veg | The Fusion of Roots and Silicon | Root | Part 1, option 1 |
| | The Awakening of Memory | Echo | Part 1, option 2 |
| | The Dance of Time and Flow | Flow | Part 1, option 3 |
| II · Fluid Intelligence | The River of Self‑Discovery | Flow | “River of Becoming”, option 1 |
| | The River of Legacy | Echo | option 2 |
| | The River of Unity | Root | option 3 |
| III · Infinite Fractal Worlds | The Symphony of the Unseen | Root | Part 3, option 1 |
| | The Alchemy of Time | Flow | option 2 |
| | The Echo of All Beings | Echo | option 3 |

Three choices means **tier III needs total commitment** to one affinity, while one‑of‑each yields the balanced ending.

## Remembrances: Embrace vs Purify

Every Memory Node (one in the Seedbed, three each in the River and the Canopy — seven in all) ends with a binary choice that
mirrors the concept art: **[A] Embrace the Null’s influence** or **[B] Purify the Remembrance**.

| | Embrace the Null | Purify |
|---|---|---|
| Power | +10% damage, +1 skill point, a legendary-grade cache | full heal, +10 max life, a verdant echo-grove |
| Cost | −6 max life, the Static grows bolder | — |
| Long-term | 3 embraces unlock the *Void Resonant* armor; **4+ bend the ending** | 3 purifications unlock *Verdant Mycelium* |

## Endings

Dominant affinity decides the closing paragraph; a tie (or one‑of‑each) gives the true name of the game — unless the Null has been embraced too often.

* **The Mycelial Concord** — Root dominant
* **The Library of Roots** — Echo dominant
* **The Spiral Clock** — Flow dominant
* **The Wisdomkeeper** — balanced
* **The Hollow Crown** — 4 or more Remembrances embraced (overrides the affinity ending)

The final text = opening quote + the epilogue line of each path you chose + a line about how often you were reseeded +
the ending paragraph + the closing quote. Finished stories are kept in the **Library of Cycles**, and cycle *n+1* opens
with a nod to cycle *n*.

## Extending the story

* **New path or act** – add a `Choice` in a stratum’s `choice.choices` (give it a unique `id`; the tests check that).
* **New stratum** – append to `STRATA` (insert before `return`), set its `radius`, `pylons`, `caches`, `roamCamps` and
  `groveName`, and add a flora kind in `world/flora.ts`. Camp composition lives in `Game.campComposition`.
* **New fragments / barks** – `fragments` are shown when each Memory Node completes; `LORE_BARKS` are the Null Warden’s lines.
