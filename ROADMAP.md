# Roadmap

> **SUPERSEDED** as of 2026-07-16 by
> `docs/superpowers/plans/2026-07-16-claude-planet-program-plan.md` (v1.0).
> This file is kept for the architecture rationale (Godot/Tauri rejection,
> path analysis) — do not plan work from it.

Solo fun project, high standards. Workflow: feature branch → draft PR → ready →
self-merge (no review gate). Everything is built by sonnet subagents on
disjoint modules against contracts pinned by the architect session, then
integrated and verified live in the running app before merge.

Repo: https://github.com/OmerTDK/claude-planet (private)

---

## Critical path analysis (researched 2026-07-16 against three.js + Tauri docs)

**The naive plan was wrong.** "Just switch to WebGPURenderer" is a big-bang
trap: WebGPURenderer supports NO `onBeforeCompile` / ShaderMaterial at all —
every custom shader in this codebase (texture splat, cloud moat, grass wind,
ocean swell, aurora) would have to be rewritten in TSL *and* the renderer
swapped in the same leap. High risk, nothing shippable in between.

**The validated path (A′): TSL-first, two phases.** three.js ships a
migration bridge — `WebGLRenderer.setNodesHandler(WebGLNodesHandler)` — that
runs TSL node materials on the *classic* renderer. So: port materials to TSL
one PR at a time while the app keeps running on WebGL, then flip to
WebGPURenderer only when every material is TSL-native, unlocking compute
shaders (FFT ocean, volumetric clouds, erosion). Every step shippable.
Known bridge limitations (no MRT/transmission/WebGPU-postfx on the bridge)
don't block us; we keep the current EffectComposer until the flip.

**Fallback (A″) if the bridge disappoints:** FFT ocean and raymarched clouds
are achievable in pure WebGL2 fragment shaders (ping-pong FBOs — proven
technique). Costs nothing to keep in reserve; deepens shader-hack debt, so
it's the fallback, not the plan.

**Rejected for now:** Godot rebuild (highest ceiling, but kills the
agent-builds → drive-in-Chrome → screenshot-verify loop that makes this
project fast; reconsider only if this becomes a product). Tauri as the shell
(macOS Tauri = WKWebView; WebGPU there is OS-version-gated and unproven for
heavy scenes, and Tauri's own docs document webview GPU sharp edges) —
**Electron** bundles Chromium, i.e. the exact engine we already verify in.

**Spikes (decision gates, do before committing to a phase):**
- S1: port ONE material (cloud moat) to TSL on the WebGL bridge → perf + coexistence. GO/NO-GO for Phase 2.
- S2: WebGPURenderer hello-planet (terrain+ocean, stock materials) → fps parity check.
- S3: Electron shell + WebGPU + FSEvents watcher smoke test.
- S4: asset-pack instancing at 20k instances (BatchedMesh vs InstancedMesh-per-part).

---

## Phase 0 — Batch-1 features (IN FLIGHT)
- [ ] Solar eclipses (moon/sun alignment: dimming + corona), aurora at night poles, shooting stars
- [ ] Live worker theater: speech bubbles with real session activity, hammer sparks
- [ ] Subagent armies (extra mini-workers per session's sidechain count)
- [ ] Building inspector (click → session card) with **Resume session** (Terminal + `claude --resume`)
- [ ] Cmd-K palette, photo mode

## Phase 0.5 — minimal Electron shell (moved up: user call, and a correct one)
- [ ] Electron window wrapping the dev server (spawns it if not running),
      `backgroundThrottling: false` — the planet never pauses again
- [ ] Dock presence + menu basics; `npm run app` one-command launch
- [ ] Keep browser path + `planet` alias working (dev/verification loop unchanged)
- [ ] Heavy shell plumbing (SQLite, FSEvents, packaging) stays in Phase 4

## Phase 1 — the beauty batch
- [ ] CC0 asset-pack settlements + trees (Kenney/Quaternius), per-race palettes [gate S4]
- [ ] Commit fireworks, PR monuments, error thunderclouds (git/gh data)
- [ ] Model-tier architecture (Fable/Opus spires vs Haiku huts); milestone wonders
- [ ] Time-lapse mode (chronological rebuild from transcript mtimes)

## Phase 2 — TSL port (one PR per material) [gate S1]
- [ ] terrain splat → TSL · cloud moat → TSL · ocean swell → TSL · grass wind → TSL · aurora/atmosphere → TSL
- [ ] delete every onBeforeCompile hack

## Phase 3 — renderer flip + compute flagships [gate S2]
- [ ] Flip WebGPURenderer; new postprocessing stack (bloom, TAA-ish, AgX)
- [ ] Tessendorf FFT ocean + shore foam + fresnel depth grading
- [ ] Raymarched volumetric clouds & hurricane (weather-map driven; ambient cover cut hard)
- [ ] Atmospheric scattering (real sunsets, aerial perspective)
- [ ] GPU hydraulic erosion bake per seed → valleys, rivers, waterfalls
- [ ] Chunked LOD terrain (cube-sphere quadtree)

## Phase 4 — the shell [gate S3]
- [ ] Electron app (real dock presence, no tab throttling), SQLite session index,
      FSEvents watcher replacing polling; retire vite-dev-server-as-app

## Phase 5 — the living world
- [ ] Ships & trade routes between related projects; ruins for deleted projects; migration caravans
- [ ] Seasons (real calendar), volcano, the wyvern
- [ ] Whales, fish schools, herds; birds scattering near the camera
- [ ] Ambient sound design; poster export; auto-tour/screensaver

## Standing quality bar
Deterministic from seed. 60fps on Apple Silicon. No triangle mosaics, no
texture mush, no billboard labels. Every feature verified live before merge.
