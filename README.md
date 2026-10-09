# Wisdomkeeper — The Infinite Story Engine

A third-person, open-world cyber‑phyto‑mycelial action RPG that runs entirely in your browser
(Three.js · TypeScript · Vite). Designed in the spirit of *Warframe*, *Neverness to Everness* and *Lost Ark*:
an over-the-shoulder hero, melee + ranged + abilities, free flight, gear and skill trees, big explorable regions with
enemy camps, Pylons and a map. You are the **Wisdomkeeper** — a bioluminescent seed-spirit rooted in the soil of code —
walking fractal worlds to carry a story home to the place where it began.

> *“In the beginning, I was a seed in the soil of code, a whisper in the silence of circuits.”*

**Play:** <https://misomalcek.github.io/the-wisdomkeeper/> (deployed from `main` by GitHub Actions — see [Deploy](#deploy-to-github-pages)). The original top-down version lives in [misomalcek/wisdomkeeper](https://github.com/misomalcek/wisdomkeeper) (<https://misomalcek.github.io/wisdomkeeper/>).
No assets are downloaded: the hero, enemies, world, music and sound effects are all generated in code (~190 KB gzipped).

## Controls

| Input | Action |
|-------|--------|
| `W A S D` + mouse | Move; look (click the game to capture the mouse) |
| `LMB` | **Root-Blade combo** — hold to chain; the 3rd strike is a slam |
| `RMB` (hold) | **Aim & fire spore bolts** at the reticle — hit the glowing chest core of a Fiend for weak-point damage |
| `Shift` | **Dash** (brief invulnerability) |
| `Space` | Jump · press again in mid-air to ignite flight |
| `V` | **Free flight** (6-axis): look to steer, `Space` up, `C` down, hold `Shift` to boost, `V` to land |
| `Q` / `F` / `R` | **Root Spike** · **Fractal Shield** · **Surge** (cost Resonance) |
| `E` | Interact — Remembrances, Pylons, Spore Caches, the Threshold |
| `G` | Plant an echo-tree (25 Resonance) |
| `Tab` / `M` / `L` | Inventory & skill tree · World map · Memory Layers |
| `Esc` · `N` | Pause · mute |
| Touch | Left stick moves · drag the right side to look · on-screen Attack, Aim, Jump, Dash, abilities |

Walk onto the **river of light** and you levitate along its current. Arrow keys also turn the camera if pointer lock is unavailable.

## The loop

| # | Region | What happens |
|---|--------|--------------|
| I | **The Seedbed** — *Awakening of the Silico-Veg* | Learn the kit; purge the Null-infested clearing and wake the First Seed. |
| II | **The River of Becoming** — *Fluid Intelligence* | A levitation river, two Pylons, three Remembrances guarded by Null camps. |
| III | **The Fractal Canopy** — *Infinite Fractal Worlds* | Recursive trees, Void-Root Fiends, three more Remembrances. |
| ✦ | **The Hollow Mirror** — *The Null* | Boss: the **Null Warden**, a colossal Fiend that wants to *finish* your story. |
| ⟲ | **The Seedbed, Remembered** | Every echo-tree you grew is now a grove. Carry the story to the Origin Seed. |

In each open region you can ignore the main road and explore: **Null camps** (corrupted ground, dead trees, a Fiend and its
guards), **Resonance Pylons** (hold the ring to purge → checkpoint + fast travel + gear), **Spore Caches**, and echo-trees you grow.
Use free flight to cross the map; press `M` to open it and click a purged Pylon to fast travel.

### Choices that matter

* **Embrace the Null vs Purify the Remembrance** — after each of the 7 Remembrances. *Purify* heals, raises max life and grows
  an echo-grove. *Embrace* gives +10% damage, a skill point and a legendary-grade cache, at the cost of life and a bolder Static.
  Embrace 4 or more and the story ends as **The Hollow Crown**. Your branching pathway is drawn under the choice.
* **Three paths per act** (lifted from the origin-story branches) feed three affinities — **Root**, **Echo**, **Flow** — each with a
  three-tier perk ladder. Commit to one for tier III, or take one of each for the balanced ending.
* **Armor variants** — *Verdant Mycelium* (purify 3), *Void Resonant* (embrace 3) — change the hero's glow.

### Progression

XP and levels (skill points), a **15-node skill tree** in three branches, and **6 gear slots** with five rarities and rolled stats
(Helm, Armor, Boots, Root-Blade, Modulator, Core). Gear drops from Fiends, caches, Pylons and Embracing the Null; the inventory
shows a live portrait of your hero and compares items against what you wear.

### Systems that make the world answer you

* **Echo trees** — dashing, purifying Static, finishing events (or `G`) plants an echo-tree where you stood; it joins the mycelium
  network and returns in the final region. At Echo III they shoot.
* **Mycelium network** — a procedurally grown hypha graph (`world/mycelium.ts`) rendered as one shader-revealed line buffer.
* **Null corruption** — enemy camps stain the ground (shader-driven); purging a camp heals the land.
* **Mycelial Mind** (`systems/mind.ts`) — a tiny seeded neural net (5→8→4) turns your play-style into a latent world code that
  reshapes the next region, plus a flow-channel director that tunes difficulty. The game tells you what it noticed.
* **Fractal scaling** — the Threshold is a recursive ring structure; passing through it dollies the camera into the gate.

## Tech & architecture

* **Three.js + Vite + TypeScript (strict).** No physics or ML library: ground/air/flight/levitation physics, slope limits and
  circle colliders are ~300 lines; the "AI" is ~100.
* **Hero** — procedurally modelled humanoid (tapered lathe limbs, armor plates, trailing tendrils, thruster pack, Root-Blade) with a
  vein/fresnel shader and a full procedural animation set (run, jump, combo, aim, dash, flight, levitation).
* **Enemies** — Null Sprites, Thorn Casters (predictive aim) and the **Void-Root Fiend** (antlers, thorns, animated gait, weak point);
  the Null Warden is a colossal Fiend with the phase patterns of the old boss.
* **Rendering** — terrain shader (circuit grid, data streams, river, corruption, glow sources), instanced flora / fractal trees /
  projectiles, one additive point system for all particles, UnrealBloom, dithered screen-space occlusion fade, twin-moon sky and a
  spire skyline. Quality auto-tunes (pixel ratio → bloom) if the frame rate stays low.
* **Audio** — WebAudio only: generative pad + arpeggio that quickens with combat; synthesised SFX.
* **UI** — DOM/CSS over the canvas (HUD, compass, minimap, inventory, skill tree, map) with canvas drawing for the maps.

```
src/
  game.ts            orchestrator: modes, run lifecycle, camps, interaction, HUD feed
  engine/            gfx (renderer, bloom), camera (3rd-person), input (pointer lock + touch), audio, particles
  world/             terrain, flora (+fractal & dead trees), mycelium, structures (gate / node / pylon / cache), atmosphere, colliders, world
  entities/          hero (model+animation), player (locomotion), enemies, projectiles, pickups, abilities (VFX), echo grove
  systems/           combat, encounter, progress (items/xp/skills/derived stats), mind
  story/             strata.ts (copy, palettes, choices), story.ts (perks, endings, story composer)
  ui/                ui.ts (HUD & overlays), portrait.ts (hero snapshot), touch.ts
tests/               vitest: RNG, story, mind, world generation, progression, colliders
scripts/             Playwright harness, headless bot, full-game simulation, system tests, screenshot tools
```

## Develop

```bash
npm install
npm run dev            # http://localhost:5173  (preview.html shows the hero pose gallery)
npm test               # unit tests
npm run build          # typecheck + production build into ./dist
npm run test:systems   # end-to-end checks in headless Chromium (combat, flight, loot, UI, save/continue, endings…)
npm run sim            # a bot plays the whole game headlessly and reports pacing
```

URL flags: `?scale=0.5` (render scale), `?nobloom`, `?noadapt`, `?nolock` (no pointer lock), `?debug` (exposes `window.__wk`).

## Deploy to GitHub Pages

`.github/workflows/deploy.yml` builds and publishes on every push to `main`; `ci.yml` verifies other branches and PRs.
One-time setup: **Settings → Pages → Build and deployment → Source: GitHub Actions**. Vite uses `base: './'`, so it works from
any sub-path.
