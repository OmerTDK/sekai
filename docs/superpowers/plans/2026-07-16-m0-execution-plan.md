# M0 Execution Plan — Land Batch-1 + Safety Net

> Program plan: `2026-07-16-claude-planet-program-plan.md` (v1.0, signed off).
> Builders: sonnet subagents on disjoint files. Architect owns package.json,
> vite.config.js, electron/main.cjs, src/main.js, launcher, integration, merge.

**Goal:** merge PR #2 with every Batch-1 feature verified, and make
verification code instead of labor (verify kit, CI, geometry tests,
loud fallbacks, measured eclipses).

**File ownership this milestone (no overlaps):**
- Builder A: `src/verifykit.js` (new) only.
- Builder B: `src/planet.js` `src/flora.js` `src/world.js` `src/storms.js`
  (warn-sweep + testable exports), `tests/geometry.test.mjs` (new),
  `.github/workflows/ci.yml` (new).
- Builder D: `src/sky.js` only (warn-sweep + eclipse seed audit/bias).
- Architect: `src/main.js` (kit wiring), `package.json` (three pin, test
  script), Dock launcher repoint, integration, verification sweep, merge.

### Task A — Verify kit (Builder A)
- [ ] Create `src/verifykit.js` exporting
  `createVerifyKit(handles) -> { gotoViewpoint(name), seekTime(seconds), sweep(), listViewpoints() }`
  where `handles = { scene, camera, composer, renderer, controls, planet, sky, world, birds, flora, wind, storms }`.
- [ ] Viewpoints (names fixed): `orbit` (camera at 3.2R on the sunlit side),
  `mid-coast` (1.42R over a sunlit coastline found via planet.biomeAt probe),
  `ground-sunlit` (surface+0.01R over sunlit grass, looking across terrain),
  `night-city` (1.35R over the settlement with most structures on the night
  side — fall back to any settlement + seekTime to its night),
  `storm` (2.0R over the active hurricane; seekTime forward ≤120s if none).
- [ ] `seekTime(s)`: fixed-step fast-forward (dt=1/30) calling every module's
  update without rendering; render 3 frames at the end.
- [ ] `sweep()`: for each viewpoint — goto, render, capture
  `renderer.domElement.toDataURL('image/jpeg', 0.7)`, record
  `renderer.info.render.calls`; then a 3s fps sample; then
  `determinismHash()` = FNV-1a over every structure/settlement world position
  (world.group traversal, sorted) → returns
  `{ shots, drawCalls, fps, determinismHash }`.
- [ ] Verify: `node --check`; hash stability proven by calling twice in-page.

### Task B — Hardening (Builder B)
- [ ] Warn-sweep planet/flora/world/storms: every silent `catch {}` and
  `|| fallback` logs `console.warn('[planet] …degraded…')` exactly once.
- [ ] Export geometry factories for tests (`export` the tree/rock geometry
  builders in flora.js and the structure-kit builders in world.js — no
  behavior change).
- [ ] Create `tests/geometry.test.mjs` (node-runnable, imports three):
  tree geometry vertex count > 150 (stump regression), every structure kit
  has >0 vertices + finite non-degenerate bounding box, blade geometry has
  all-finite positions. Must pass via `node tests/geometry.test.mjs`.
- [ ] Create `.github/workflows/ci.yml`: on PR/push — setup-node 24,
  `npm ci`, `node --check` all src/server/electron files, `npm test`,
  `npm run build`.
- [ ] Do NOT edit package.json (architect wires the test script).

### Task D — Eclipse guarantee (Builder D)
- [ ] Node-simulate seed `aetherion-1` (the default) with sky.js's real moon
  math: does an eclipse (alignment ≥ 0.9975) occur within 3 sim-hours?
- [ ] If not (or marginal), bias deterministically IN sky.js for ALL seeds:
  clamp/steer moon-1's orbital tilt so its declination band always crosses
  the sun's; target ≥1 eclipse per ~45 sim-min median, verified by re-running
  the simulation across ≥20 seeds. Document the numbers in a comment.
- [ ] Warn-sweep sky.js's own silent guards (corona/aurora/meteors catches).
- [ ] Verify: `node --check src/sky.js`; report measured frequencies.

### Task E — Architect wiring + integration (after A/B/D land)
- [ ] main.js: import createVerifyKit, attach as `__planet.verify`.
- [ ] package.json: pin `"three": "0.185.1"` exact; `"test"` runs scan tests
  + geometry tests; commit lockfile.
- [ ] Repoint `~/Applications/Claude Planet.app` launcher to `npm run app`
  (Electron) instead of Chrome app-mode.
- [ ] Full verification: `npm test` green; `__planet.verify.sweep()` — all 5
  shots captured, fps ≥55, determinism hash stable across two reloads;
  eclipse check per Task D's numbers; console clean of unexpected warns;
  Electron 10-min background test (HUD clock + poll timers advance);
  resume-session verified once against a real old session.
- [ ] Merge PR #2 (`gh pr ready` → merge). M0 exit.
