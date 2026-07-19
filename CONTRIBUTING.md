# Contributing to Sekai

Thanks for your interest! Sekai is a solo passion project, but issues and PRs are welcome.

## Setup

```bash
nvm use            # or fnm/volta — Node 24 (see .nvmrc)
npm install
npm start          # browser at http://localhost:5173
```

- `npm run app` — run the desktop app (Electron) over the dev server
- `npm run dist` — package a `Sekai.app` + `.dmg`
- `?seed=<name>` picks a world; `?renderer=webgpu` opts into the WebGPU backend

## Before you open a PR

CI runs the same checks — run them locally first:

```bash
npx prettier --check .
npx eslint .
npm test           # scanner + geometry + heightfield tests
npm run build
```

Then: branch → PR → green CI → merge.

## Project invariants

Two rules hold everywhere in the code — please keep them:

- **Determinism.** Every position/choice in the world is a pure function of the
  seed, hashed through `src/util.js` (`rngFromString`, `hash01`, `makeNoise3D`).
  No `Math.random()` or `Date.now()` in world state — the only time source is the
  `dt` accumulated in each module's `update(dt)`. This is what makes a world
  reproducible from its inputs.
- **The Covenant.** Simulation (conflict, cataclysm, weather) is *additive*: it
  happens *around* the session-derived structures, leaves marks that always heal,
  and never moves, destroys, or overwrites them.

## Rendering notes

All shaders are **TSL node materials** (no `ShaderMaterial` / `onBeforeCompile` —
they don't run under `WebGPURenderer`). Code must compile on both the WebGL2
default and the true-WebGPU backend, so avoid `pointUV` and custom per-instance
vertex attributes on WebGPU-critical paths. Build each node graph once and animate
via `uniform()` writes.
