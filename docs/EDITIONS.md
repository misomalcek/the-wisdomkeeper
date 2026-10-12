# Editions and the one-way sync

The Wisdomkeeper ships as two editions built from one game:

- **Web edition**: this repository. It deploys to GitHub Pages from `main`.
- **Desktop edition, Infinite Evolutions**: a private fork. It runs this same game inside a Tauri window, with a
  local AI mind (llama.cpp) that plays the Null Warden and the forest.

Code flows **one way**: this repository's `main` is merged into the fork, and nothing is merged back. This keeps
both editions the same world for the same seed, and it means a feature is written only once.

## What goes where

| Lives here (web, shared by both editions) | Lives only in the fork |
|---|---|
| The game: engine, world generation, enemies, story, UI, saves | `src/evo/`: the living world's agents, the Game Master clamp, the chronicle, the first-run model setup |
| Quality tiers and look flags, including the desktop tier's settings | `src-tauri/`: the desktop shell, model manager, sidecar supervisor |
| Pure generators the mind steers (genome, landforms, names, stations) | `crates/`: the `wk-mind` inference sidecar |
| The edition surface (below) | Installers, model catalogue, evals, desktop build scripts |

The rule of thumb: if a player of either edition would notice it, it is built here. The fork keeps only what
needs the native app or the local models.

## The edition surface

The fork never edits this repository's files. It attaches through these points, which are inert here:

1. **`src/main.ts`** loads `src/evo/install.ts` through `import.meta.glob` when the build runs with
   `VITE_EDITION=evolutions`. In this repository the glob is empty, so the web bundle carries nothing of it.
2. **`Game.hooks`** (`src/systems/hooks.ts`) is an event bus for what happens in play: stratum, transition, tick, spawn,
   kill, hurt, death, respawn, remembrance, pylon, echo, save and story. It also holds `travelGate`, which lets an edition bar
   fast travel to a place. `Game.campStates`, `Game.inTransition` and `Game.storycards` give access without reaching into private fields.
3. **`runExtensions.evolution`** in `src/systems/storycards.ts`, with `RunState.evolution`, lets an edition keep
   its own block on a storycard. Without a registered validator, the web build drops the block.

### Rules for changing it

- Don't remove or rename an event, field or getter of the edition surface unless the fork's adapter moves with it
  in its next sync.
- If an edition needs a new moment of play, add an event here instead of wrapping a `Game` method.
- `tests/hooks.test.ts` and section 8b of `scripts/systems-test.mjs` check that the surface keeps working.

The fork's side of the sync is described in its own repository, in `docs/SYNC.md`.
