# Claude Planet — Program Plan v1.0 (audited; awaiting Omer's sign-off)

> **For agentic workers:** This is the PROGRAM plan. At each milestone start,
> write a just-in-time execution plan (superpowers:writing-plans bite-sized
> format), commit it into docs/superpowers/plans/ next to this file, then
> build via sonnet subagents per §0. Do not build ahead of the active
> milestone. ROADMAP.md is superseded by this file (kept for rationale).

**Audit trail:** v0.9 was attacked by three independent auditors (technical,
product/scope, execution/process) plus an architect self-audit on 2026-07-16.
All BLOCKING and MAJOR findings are incorporated below; §7 lists what changed.

**Goal:** Evolve Claude Planet from a beautiful toy into a high-fidelity,
always-running desktop world that visualizes all Claude Code activity as a
living medieval×steampunk civilization — with joy landing every session and
no unshippable gaps.

**Architecture:** Vite + three.js app; session data read directly from
`~/.claude/projects` transcripts (no database — the transcripts are the
persistence); deterministic world from (seed, project, session-id) hashes.
Engine path: minimal Electron shell → beauty + dragons/airships → TSL
material port on the WebGPURenderer(forceWebGL) host → WebGPU-backend flip →
visual flagships.
**Program-complete line: end of M5c.** Everything after is an opt-in epilogue.

---

## 0. Operating model (standing rules)

- **Roles:** architect session = contracts, integration, verification, PRs.
  Sonnet subagents = all construction, disjoint file sets, contracts pinned
  in prompts.
- **Architect-only files** (never assigned to a builder): `package.json`,
  `vite.config.js`, `electron/main.cjs`, `src/main.js`, `src/ui.css` (to be
  extracted from index.html's inline styles at M2 entry).
- **Workflow:** one branch + draft PR per milestone → `gh pr ready` →
  self-merge. No AI attribution anywhere in commits or PRs (standing user
  rule). Revert protocol: `git revert <sha>` then re-run that milestone's
  JIT plan — commits stay fine-grained to keep this cheap.
- **WORKTREE RULE (user, 2026-07-17: "always work in proper git worktrees"):**
  the main checkout `~/claude-planet` stays parked on `main` forever — it is
  what the user's app and :5173 serve (stable, merged). Every wave works in
  `git worktree add ~/.config/superpowers/worktrees/claude-planet/<branch>`
  with its own `npm install`, its own dev-server port for verification, and
  a green baseline test before builders start; builders receive the worktree
  absolute path. Merge → main checkout pulls → worktree removed. Branch
  switching in the main checkout is banned (it swaps the app under the live
  server — the failure that motivated this rule). The m-polish wave
  (2026-07-17) was the last grandfathered in-place wave.
- **CI (M0 deliverable):** GitHub Action on PR: `node --check` all src/server
  files + `npm test` + `npm run build`. Merge blocked on red.
- **Verification is code, not labor (M0 deliverable, the "verify kit"):**
  `__planet.gotoViewpoint(name)` for the 5 standard viewpoints (orbit,
  mid-coast, ground-sunlit, night-city, storm), `__planet.seekTime(s)` to
  fast-forward the sim clock, a script that captures the 5 shots +
  `renderer.info` + a 5s fps sample, and a determinism hash (structure
  positions hashed after two seeded reloads must match). Full 5-viewpoint
  sweep at **milestone exit**; intra-milestone PRs verify only the 1–2
  viewpoints they touch.
- **Tests:** `npm test` gains geometry sanity asserts (non-zero vertex/index
  counts, non-degenerate bounding boxes) for merge-built geometry — the
  class of check that would have caught the canopy-less-trees bug.
- **Silent-fallback rule (quality bar):** every graceful degradation path
  (`|| fallback`, empty `catch`) must `console.warn` once; the verify sweep
  reads the console. Existing silent sites get warnings during M0.
- **Contracts:** no separate prose contracts doc (prose demonstrably rots
  here within hours). Instead: `// @ts-check` + JSDoc types on the height-
  contract consumer files (planet.js, world.js, flora.js, wind.js,
  storms.js); invariants live in this file: `SEA_LEVEL = 1.0`;
  `sampleHeight(dir)` is synchronous, allocation-free, deterministic;
  three.js `alphaMap` samples the GREEN channel; icosphere geometry must be
  vertex-welded before smooth shading; all randomness seeded (no
  `Math.random`/`Date.now` in world-state code).
- **Dependency pinning:** three.js pinned EXACT (0.185.1); version bumps are
  deliberate, one per milestone gate at most.
- **Gallery rule (user, 2026-07-17):** every verdict packet, milestone
  screenshot, and GIF is copied into `gallery/YYYY-MM-DD/` (with a line in
  gallery/GALLERY.md) before its PR merges — screenshots are born in temp
  dirs that macOS deletes; the gallery is the project's memory book.
- **Budget honesty:** estimates below are sonnet builder-runs (observed
  median ~130k tokens, hard runs 190–290k). Architect integration time
  historically ≈ builder time — budgets are ranges, not promises; WIP cap =
  one milestone.

## 0.5 Art direction: medieval × steampunk

- Base world deeply medieval (stone keeps, timber halls, banners, torchlight);
  terrain/nature stays natural-stylized.
- Steampunk is the language of ACTIVITY: busy/large sessions sprout brass
  gearworks, steam vents, glass observatory domes, pressure tanks; the
  busiest projects earn great-engine landmarks. Steam/smoke plumes join city
  lights as the "alive" signal.
- Race flavor: dwarves full industrial; humans medieval-clockwork; elves
  organic with brass filigree only; orcs scrap-punk.
- Palette accents: brass #b0793a, copper #c98d4a, aged-bronze patina #5e7d6a.
- Dragons are canon (resident, lair, event appearances — M2.5).
- Airships are the traversal layer (dirigibles, steam trails — M2.5).
- Asset strategy (validated by spike S5 before M2 commits): CC0 medieval
  packs (Kenney/Quaternius) + procedural steampunk bolt-on kit parts.

## 1. Current state (baseline, 2026-07-16 end of day)

Merged (PR #1): full v1 world — terrain/biomes/textures, ocean, sky (moons,
domain-warped clouds + storm moat, sun orbit, moonlight), sun-seeking
planet-scale hurricane, flora (trees/rocks), wind streaks, birds, city
lights, civilization layer (29 settlements, 250+ structures, races, workers),
sidebar UI, scanner (+tests), Dock launcher.
Built and parked on PR #2 branch (unmerged, pending M0): eclipses + aurora +
meteors; worker speech bubbles + hammer sparks + subagent minions +
structure-click API; building inspector + resume-session endpoint + cmd-K +
photo mode; minimal Electron shell (electron 43.1.1).
Known debt: 5 `onBeforeCompile` sites + 1 raw `ShaderMaterial` (atmosphere
rim — sky.js:307) + aurora ShaderMaterial (M3 targets ALL of these);
primitive kit-bash buildings (M2); world.js god-module 1113 lines (split at
M2 entry); index.html inline styles (extract at M2 entry); silent fallbacks
(warn-sweep at M0).

## 2. Milestones

### M0 — Land Batch-1 + build the safety net
- **Scope:** integrate + verify the four parked builders' work; merge PR #2.
  Deliverables beyond features: verify kit (`gotoViewpoint`, `seekTime`,
  capture script, determinism hash), CI action, geometry sanity asserts in
  `npm test`, silent-fallback warn sweep, three.js pinned exact.
- **Exit:** verify-kit sweep passes all 5 viewpoints; CI green on the PR;
  eclipse frequency MEASURED via `seekTime` fast-forward — if a real eclipse
  occurs less than ~once per 30 sim-minutes, bias one moon's orbit plane
  until it does (spectacle exists to be seen); "Resume session" opens
  Terminal and resumes the right session (verified once by hand).
- **Est:** 1–2 builder-runs (verify kit, CI) + integration. 1 session.

### M1 — Minimal Electron shell (BUILT; verification only)
- **Exit:** planet animates 10 min unfocused/hidden (HUD clock advances) —
  covering BOTH rAF and timers (the 4s poll must keep firing); hot reload
  works in-shell; Chrome can still drive the same server; Dock launcher
  repointed to the Electron app.
- **Est:** 0 new runs. Folded into the M0 session.

### M2 — Beauty batch
- **Entry tasks (architect):** split world.js → buildings.js / placement.js /
  labels.js (+world.js orchestration); extract index.html styles → ui.css.
- **S5 art spike (first hour, GO/NO-GO):** ONE medieval GLTF house + 2–3
  procedural steampunk bolt-ons (gear, pipe, tank) + a Kenney-vs-Quaternius
  side-by-side → screenshot → Omer verdict before anything else proceeds.
- **S4 perf spike:** BatchedMesh @ ~20k GLTF-part instances → GO if ≥55fps
  and civ layer ≤ ~30 draw calls.
- **Scope:** asset-pack buildings + trees with per-race palettes and
  steampunk-by-activity bolt-ons; steam/smoke plumes; git-driven charm
  (commit fireworks, PR monuments, error thunderclouds — polled only for
  settlements with active sessions, 60s interval); model-tier architecture;
  milestone wonders; time-lapse mode (scrub timeline, replay by mtime).
- **Exit:** settlement close-up passes Omer's eye; fireworks fire on a real
  commit within 60s; time-lapse replays full history ≤60s smoothly; fps ≥55.
- **Est:** 7–9 builder-runs. 2 sessions.

### M-SKY — sky interim package (added 2026-07-17, user: "skybox/clouds/
### hurricane feel cheap"; runs PARALLEL with M2.5 — disjoint files; the real
### fix remains M5a/M5c, this is shell polish, not early flagships)
- [ ] Baked starfield cubemap: procedural milky way with dust lanes + color
      grading, generated once + cached (a genuine menu gap the user caught —
      neither plan nor technique audit had the skybox)
- [ ] 2.5D cloud shading: sample alphaMap toward the sun → lit tops, shaded
      bases; applied to cloud shells AND the hurricane patch
- [ ] Cloud shadows on terrain (sky exposes texture+rotation to the splat
      shader via an architect-pinned contract)
- [ ] Ambient coverage cut to ART.md's 15-25% target
- [ ] Hurricane casts a soft moving shadow on the ocean beneath it
- IN PROGRESS 2026-07-17 (PR #5): camera swoop/skim
  implementation, surface-crispness pass, wonders, model-tier styling,
  orbit label-soup fix.

### M2.5 — Dragons + airships (IN PROGRESS 2026-07-17, parallel with M-SKY)
- **Scope:** one resident dragon (lair on the tallest range, patrol flights,
  event appearances on milestones); airship dirigibles on great-circle
  routes between git-related settlements, steam trails, dock masts at
  qualifying settlements.
- **Exit:** dragon visible within one sim-day of watching; airships visibly
  travel between at least 2 settlement pairs derived from real git remotes;
  fps ≥55.
- **Est:** 3–4 builder-runs. 1 session.

### CHOICE-1 — RESOLVED: (a) clean path (Omer, 2026-07-16, decided early)
- Sequence stands as written: M2 → M2.5 → M3 (TSL port) → M4 (renderer flip)
  → M5a-c, each flagship built exactly once on the final engine.
- The fast-joy detour (b) is rejected; do not build WebGL2 throwaway
  versions of scattering/ocean.

- **MECHANISM CORRECTED 2026-07-17 (context7-verified, after M-WX):** the
  original notes assumed `WebGLRenderer.setNodesHandler(WebGLNodesHandler)`
  as the incremental host. **That bridge is a dead end for us** — its
  documented limitations forbid SHARED INSTANCED-MESH GEOMETRY and the
  `compile()` path, but the whole app is BatchedMesh (250 buildings / 2–4
  draw calls) + InstancedMesh with per-instance custom attributes (flora
  sway, birds flap, trails, contact-blobs). The real clean path is
  **`WebGPURenderer({ forceWebGL: true })`** (from `three/webgpu`) as the
  incremental host: it runs TSL NodeMaterials on a WebGL2 backend today, and
  the M4 "flip" becomes deleting `forceWebGL`. Consequences that move work
  earlier than the old M3/M4 split implied: (1) `WebGPURenderer` does NOT run
  `EffectComposer`/`UnrealBloomPass`, so the post-stack rebuild (node
  `PostProcessing` + TSL `bloom()`) happens AT renderer-swap time, not as a
  separable later step; (2) `WebGPURenderer` ignores `onBeforeCompile`, so
  every one of the ~31 `onBeforeCompile` + ~5 `ShaderMaterial` sites across 9
  files (planet 11, seaice 5, flora 5, birds 4, sky 2+2, trails 2, storms 1,
  weather 1+1, flood 0+2) must become a NodeMaterial before the swap can go
  live. S1 (below) is the GO/NO-GO gate on this whole path.

### M-LD — Look Development (added 2026-07-17, Omer's call: the aesthetic
### layer was complaint-driven, never designed; fix that before the engine work)
- **Why:** every user frustration to date was in the vibed visual layer
  (triangles ×2, grass, clouds), zero in the designed data layer. M5's better
  engines would just render an undesigned world more crisply.
- **Scope (all spikes + one doc; verdict packets like S5):**
  1. `docs/ART.md` — reference board distilled into WRITTEN rules: palette
     grade, shape language, terrain character (coast drama, fjords,
     archipelagos, silhouettes), water feel, cloud feel, camera feel.
     Sources: BotW, Sable, Monument Valley, Outer Wilds, Bad North, ISS
     photography. Owner-approved before it becomes binding.
  2. Terrain recipe comparison — VERDICT RECORDED (Omer, 2026-07-17):
     **B+C+D — fjord-warped coasts + archipelago arcs + dramatic relief.**
     Integration consequences (bind the implementation): HEIGHT_MAX
     1.045→1.06 with LAND_COLOR_RANGE recomputed; cloud shells 1.055/1.07 →
     ~1.075/1.09; storm patch 1.062 → ~1.08; atmosphere 1.09 → ~1.11; bird
     altitude band raised above new peaks; settlement layout WILL reshuffle
     (isLand changes at coasts — accepted, pre-1.0 world). Mesa (E) rejected
     as underdelivering. Implementation ships in the single M-LD wave after
     the water + camera verdicts, so the look upgrades land coherently.
  3. Water — VERDICT (Omer, 2026-07-17): **hybrid 2+3, stylized-leaning** —
     graded-fresnel depth base (sapphire→turquoise, coast glow band) with
     posterized stylized band accents at shorelines; owner "really liked the
     stylized look" — err graphic when tuning. Min-elevation camera clamp
     near water adopted (spike lesson).
  4. Camera — VERDICT (Omer, 2026-07-17): **swoop for visits + skim near
     ground** (parameters as measured in the GIF packet: easeInOutCubic,
     arc 0.35·sin(πt), FOV 45→52→45; skim floor sampleHeight+0.008,
     smoothing gain 0.12, roll 0.18 rad).
  5. Technique audit (2026-07-17) — adopted top-5: banner sway (rides M3
     tree-sway PR), blob contact shadows, orbit tilt-shift DoF, path +
     farmland decals, night light-pools (M2/M-LD wave, additive-safe).
     Tone-touching items (near-camera shadow map, SSAO, LUT grades,
     vignette-tune) sequenced AFTER the M-LD wave ships, one variable at a
     time. Motion blur = anti-rule. Outline/ink stylization = owner
     question, default SKIP. Fog stopgap killed (CHOICE-1 conflict).
  6. Industry-technique research (2026-07-17, user ask) — adopted into slots:
     **flow maps** (three's own Water2, coastal currents → M5b-or-sooner);
     **stochastic hex-tiling** (kills splat repetition → rides M3 splat
     port); **dithered LOD crossfade** (bayer16 ships in TSL → any LOD
     fade, post-M4); **curl-noise particles** (TSL primitive → post-M4
     plume upgrade); **Poisson-disk scattering** (CPU, anytime → flora/
     placement quality); **clustered many-light night windows** (real
     per-window lights → M4+ flagship-adjacent); **dragon neck/tail CCD IK**
     (M2.5 polish); **snow/moss top-down coverage on props** + **vertex-AO
     bake** (ride the crispness pass); **space-colonization rivers/roads**
     (E1). Rejected with reasons: interior mapping (cottages have 1-2
     windows — weak fit, tier-3 only maybe), WFC town layout (CONFLICTS
     with sessions-ARE-placement invariant; paths only), billboard cloud
     imposters (superseded by octahedral), parallax-corrected cubemaps
     (single-probe world), crepuscular billboards (god-rays double-build).
     Octahedral impostors + VAT crowds parked as scale insurance (E2/late).
- **Exit:** ART.md approved + committed; one verdict recorded per packet;
  M3/M5 JIT plans MUST cite ART.md as binding art direction.
- **Follow-on — the "surface crispness pass" (user asks 2026-07-17: blurry
  surface / HD textures / cube maps / POM; sequenced AFTER the verdicts so
  packet lighting stays comparable), ships WITH the M-LD implementation wave:**
  (1) environment-lighting — PMREM env from our own sky, per-material
  envMapIntensity, never the naive global wash; (2) detail normal maps from
  the ambientCG sets (per-pixel relief is the #1 anti-blur lever);
  (3) extend/replace the splat detail fade so mid-zoom (1.7R+) isn't raw
  vertex-color gradients — evaluate a mid-frequency macro texture layer;
  (4) 2K ground textures eval. POM stays in E2's ladder (needs the normal-map
  rung proven first).
- **Est:** 4 builder-runs. Runs parallel-safe with M2 integration
  (spikes/ + docs/ only).

### M3 — TSL material port on the forceWebGL host [gate S1]
- **Host correction (see CHOICE-1, 2026-07-17):** the incremental host is
  `WebGPURenderer({ forceWebGL: true })`, NOT the WebGLNodesHandler bridge.
  Because that renderer ignores `onBeforeCompile` and cannot run
  EffectComposer, M3 and the old M4 partially MERGE: the renderer swap +
  node post-stack rebuild happen together, and the app can only go live on
  the new renderer once ALL materials are NodeMaterials. Interim strategy is
  therefore branch-local (spike page + progressively-ported modules verified
  off-main) rather than shipping a half-ported main.
- **S1 spike — GO (architect-confirmed live in Chrome, 2026-07-17).** All
  mechanism gates passed on `window.__S1`: forceWebGL→`WebGLBackend`;
  per-instance attribute sway proven by a zero-phase discriminator
  (`zeroingChangedImage:true, restoreReverted:true`); BatchedMesh+NodeMaterial
  renders no-error; the true-WebGPU flip even boots on this machine. Two
  watch-items, both bounded: (1) fps deltas are a submit-bound micro-benchmark
  artifact (0.04→0.11ms on empty scenes) — advisory, profile the real app;
  (2) a **187ms node-recompile hitch** on structural graph changes → M3 law:
  build every node graph once, pre-warm at load, animate via `uniform()`
  writes only. Full design in `docs/spikes/2026-07-17-s1-tsl-webgpu.md`.
- **Original spike framing (retargeted to the forceWebGL host):**
  a standalone page renders a representative scene (customized sphere +
  InstancedMesh-with-per-instance-attribute sway + BatchedMesh) under both
  WebGLRenderer/onBeforeCompile (baseline) and WebGPURenderer(forceWebGL)/TSL
  NodeMaterials. GO criteria: candidate fps within 10% of baseline; **per-
  instance attributes animate correctly on InstancedMesh** (the crux the
  rejected bridge failed); **BatchedMesh renders under the node path** (or a
  documented workaround); forced material rebuild mid-run has no unacceptable
  hitch; forceWebGL→WebGPU flip boots (or is documented as env-limited).
  Measure fps by timing back-to-back renders, NOT rAF (backgrounded-tab
  suspension gotcha).
- **Port list (grouped, one PR each — ~36 sites total):** representative
  first (tree-sway/birds instanced sway) → terrain splat/normal/macro chain
  (planet.js, 11 sites — the biggest) → ocean → cloud/storm/weather →
  sea-ice → flood/trails → atmosphere rim + aurora (the ShaderMaterials) →
  grass-wind (dormant, port or delete).
- **Exit:** `grep -rE "onBeforeCompile|new THREE\.(Raw)?ShaderMaterial" src/`
  → zero hits; app runs on `WebGPURenderer({forceWebGL:true})`; node post-
  stack (bloom) rebuilt; visual parity via verify kit; fps within 10% of the
  WebGLRenderer baseline.
- **Fallback if S1 NO-GO:** documented A″ (stay on WebGLRenderer + onBefore-
  Compile; build M5 flagships as WebGL2 fragment-shader implementations;
  revisit the node path on a later three.js). E-SIM rung 1 becomes the more
  attractive next arc in that world.
- **Est:** 1 spike + ~8–10 builder-runs (grew with M-WX's added materials).

### M4 — WebGPU flip [gate S2]
- **Now a thin milestone** (most of its old scope moved into M3 with the host
  correction): with the app already on `WebGPURenderer({forceWebGL:true})`
  and the node post-stack live, M4 is deleting `forceWebGL` and validating
  the true WebGPU backend.
- **S2 spike:** `WebGPURenderer()` (no forceWebGL) boots the full ported
  scene on the WebGPU backend; fps parity vs the forceWebGL baseline.
- **Scope:** drop `forceWebGL`; verify the >1.0-color bloom-headroom trick
  against TSL `bloom()` threshold semantics (sky sun/stars depend on it);
  AgX regrade; retain a `?renderer=webgl` (forceWebGL) escape hatch ONE
  milestone for machines without WebGPU.
- **Exit:** WebGPU backend default; verify-kit sweep + bloom-parity shots;
  fps ≥ forceWebGL baseline −10%; escape hatch still renders.
- **Est:** 1 spike + 2–3 builder-runs.

### M5a — Atmospheric scattering
- **Exit:** before/after approved by Omer; sunset limb + aerial perspective
  visible at viewpoint 2; fps ≥55. **Est:** 2–3 runs.
### M5b — FFT ocean + foam
- **Exit:** approved before/after; shore foam on coasts; fps ≥55.
  **Est:** 3–4 runs + 1 integration run.
### M5c — Volumetric clouds + hurricane
- **Scope:** raymarched volumetrics (quarter-res march + upsample, step
  caps, blue-noise jitter), weather-map-driven; ambient coverage cut ~70%;
  hurricane becomes a true rotating density feature. Fallback: keep 2.5D
  shells, volumetric hurricane only.
- **Exit:** approved before/after; fps ≥55 sustained at mid-zoom.
  **Est:** 4–6 runs + 1 integration run.

**══ PROGRAM COMPLETE at M5c exit. Everything below is epilogue, opt-in per session. ══**

### E1 (was M5d) — GPU erosion + rivers [epilogue]
- **Hard prerequisite task (from technical audit):** design the CPU-side
  height sampler FIRST — bake → Float32Array grid + bilinear synchronous
  `sampleHeight` replacement (same signature, allocation-free), because
  world/storms/wind call it per-frame and placement loops call it 600×.
  The bake FILE (committed per seed) is the source of truth — machines never
  recompute independently (GPU compute is not bit-identical across GPUs).
- **Exit:** rivers/valleys visible; determinism hash stable across reloads;
  placement unchanged for unchanged seed+bake. **Est:** 4–5 runs.
### E2 (was M6) — terrain close-up detail [epilogue; spike-first]
- **S6 spike:** try cheap paths first, in this order (user ask 2026-07-17:
  "tessellation or the technique that imitates it" = parallax occlusion
  mapping): (1) detail normal maps from the ambientCG height/normal sets we
  already source, (2) parallax occlusion mapping on the ground splat
  (per-pixel heightmap ray-march — fake relief, zero new triangles, fades
  with altitude like the existing detail), (3) base-mesh density bump,
  (4) min-zoom clamp. MEASURE memory + frame-time at each rung. True
  tessellation stages don't exist in WebGL/WebGPU — full cube-sphere
  quadtree LOD is the only real-subdivision path, built ONLY if the spike
  rungs fail Omer's eye. Depends on E1 if erosion landed (explicit edge:
  E2 → E1's sampler).
- **Est:** spike 1 run; full LOD (if needed) 8–12 runs.
### E3 (was M7a) — packaged .app (electron-builder, unsigned). **Est:** 2–3 runs.
### M-WX — weather & life (added 2026-07-17 from the owner's "dreaming" list —
### none of it was crazy; sequenced after M2.5/M-SKY land)
- [ ] REAL birds: articulated low-poly models (CC0 or built) replacing the
      day-one 2-triangle silhouettes; same flock logic
- [ ] Material-distinction pass (the "clay/play-dough" fix): per-material-class
      roughness/normal/micro-albedo on buildings & props — wood/stone/cloth/
      metal each respond to light distinctly; stylized, NOT photoreal PBR
      (S5 verdict stands); extends the terrain-only crispness pass
- [ ] Sea ice: polar freeze mask on the ocean (matte white-blue, pressure
      cracks, no swell, ragged noise edge); extent hooks into E4 seasons later
- [ ] Precipitation: camera-local snowfall in cold zones, rain under wet
      fronts; lightweight ambient weather-front state drifting across the world
- [ ] Hurricane landfall → coastal flooding: temporary waterline rise + wet
      ground darkening on low shores under a landfalling storm
- [ ] Footprint decal trails behind workers/caravans in snow biomes (the
      honest version of snow deformation)
- [ ] Whales + dolphins pulled forward from E4 (second owner request):
      breaches, spouts via the plume pool, coastal dolphin pods
- Parked with reasons: true RT snow deformation and dynamic hydrological
  floods (payoff-per-cost fails at miniature scale; revisit for a close-up mode)

### E4 (was M8) — living world remainder: ruins, migration caravans, seasons,
  volcano, fish schools, herds, bird scatter, ambient sound, poster export,
  auto-tour. Per-feature JIT plans. **Est:** 6–8 runs.
### E-SIM — world simulation ladder (added 2026-07-17; owner: raids, wars,
### armies, "how far can we push world simulation" — roadmapped, not scheduled)
- **THE COVENANT (inviolable):** structures are session history — simulation
  may never destroy, move, or overwrite them. Conflict is additive: it
  happens AROUND the record, leaves marks (decals, banners, ruins-props),
  and always heals. Sim-owned props (carts, outposts, camps) are fair game.
- **Rung 1 — skirmish theater (cosmetic):** raiding parties march from orc
  settlements (tmp-dir projects are canonically the raider faction) toward
  rich ones; defenders muster; a field battle plays out with formation
  movement, clash animations, torches at night; outcome = banners + scorch
  decals + a "raid repelled" event in the feed. Fully scripted, seeded.
- **Rung 2 — systemic layer:** drivers from REAL data — git merge conflicts
  between related projects = border skirmishes; airship routes carry
  "supplies" that raids can intercept (ties into the M2.5 route system);
  settlement prosperity (session activity) sets raid attractiveness;
  territory/influence shading on the terrain between rival clusters.
- **Rung 3 — deep sim:** persistent faction standing, supply economy over
  the route graph, army strength from historical session counts, sieges
  (surround, never destroy), peace treaties when projects merge branches.
  VAT GPU crowds (parked technique) is the enabler for army scale.
- Sequencing: rung 1 is a fun standalone batch any time after M-WX; rungs
  2-3 gated on appetite after living with rung 1.

### E5 (was M7b) — SQLite index + FSEvents watcher. Parked indefinitely: it
  reverses the no-database principle to fix a 4s poll nobody minds. Revisit
  only if cold-start or history-analytics pain becomes real.

## 3. Dependency graph

```
M0 ─→ M1 ─→ M2 ─→ M2.5 ─→ CHOICE-1 ─→ M3 ─→ M4 ─→ M5a → M5b → M5c ═ COMPLETE
                                                            (b-path: M5a'/M5b'-lite before M3)
Epilogue: E1(erosion) ─→ E2(LOD, needs E1's sampler if E1 landed)
          E3(package), E4(living world) — independent, any time post-M2
          E5 — parked
```

## 4. Spike register

| Spike | Question | GO criteria | When |
|---|---|---|---|
| S1 | WebGPURenderer(forceWebGL) + TSL on instanced custom-attr + BatchedMesh? | parity, fps −≤10%, instanced attrs correct, BatchedMesh works, no rebuild hitch | M3 start |
| S2 | true WebGPU backend (drop forceWebGL) full-scene parity? | fps ≥ forceWebGL baseline−10%, nothing missing | M4 flip |
| S4 | BatchedMesh @ 20k GLTF instances? | ≥55fps, ≤~30 civ draw calls | M2 start |
| S5 | RESOLVED 2026-07-17 (GO — mix): Kenney base for all standard buildings, Quaternius reserved for grand tier-3 landmarks. Constraints from the spike: drop/downsize Quaternius PBR textures (17MB → tint-or-512px, fix dark faces), chunkier gear mounts (gears illegible oblique), tame pipe glow, scoped env-map for metals, everything batched per S4. | — | done |
| S6 | Cheap terrain close-up fixes beat LOD? | Omer's eye at street level | E2 start |

## 5. Risk register

| # | Risk | L | I | Mitigation |
|---|---|---|---|---|
| 1 | TSL bridge fails on live instancing (S1) | M | H | fallback A″ documented; S1 tests the real case incl. recompile hitch |
| 2 | Volumetric clouds miss 55fps | M | H | quarter-res+caps; fallback shells+volumetric-hurricane-only |
| 3 | Erosion breaks height contract | M | H | E1's mandatory CPU-sampler task; bake file committed as source of truth |
| 4 | Silent fallbacks ship broken visuals | H | M | warn-once rule + console read in verify sweep (M0) |
| 5 | world.js collisions between builders | M | M | M2-entry split + architect-only file list |
| 6 | Scope creep from brainstorms | H | M | new ideas → ROADMAP "later"; plan changes via PR only |
| 7 | three.js drift under caret ranges | M | M | exact pin; deliberate bumps at milestone gates |
| 8 | Post-fx double-maintenance via escape hatch | M | M | hatch = materials only; WebGL mode ships unbloomed |
| 9 | Transcript format changes upstream | L | H | tolerant parsing + scanner tests on real files each session |

## 6. Budget (builder-runs; architect integration ≈ builder time, not counted)

M0: 1–2 · M1: 0 · M2: 7–9 · M2.5: 3–4 · M3: 7–8 · M4: 5–6 ·
M5a: 2–3 · M5b: 4–5 · M5c: 5–7 → **program ≈ 34–44 runs, ~10–12 sessions.**
Epilogue (all optional): E1 4–5 · E2 1–13 · E3 2–3 · E4 8–10 · E5 parked.

## 7. What the audit changed (v0.9 → v1.0)

1. Dragons+airships pulled from last place to M2.5 (scope audit, BLOCKING).
2. Program-complete line drawn at M5c; E-items are opt-in epilogue (self-audit).
3. CHOICE-1 added: clean path vs fast-joy detour, Omer decides (self-audit).
4. E1 gained the mandatory CPU-sampler design + committed-bake determinism
   (technical audit, BLOCKING).
5. M3 port list gained atmosphere + aurora ShaderMaterials; exit grep widened
   (technical audit, BLOCKING).
6. S1 retargeted to live tree-sway instancing + recompile-hitch test
   (technical audit, MAJOR).
7. M4 rebudgeted; escape hatch scoped materials-only; bloom-headroom
   re-verification added (technical audit, MAJOR).
8. Verify kit + CI + geometry asserts + silent-fallback rule became M0
   deliverables (process audit, BLOCKING×2; self-audit).
9. world.js split + ui.css extraction + architect-only files policy
   (process audit, MAJOR).
10. SQLite/watcher demoted to parked E5; packaging split out (scope audit).
11. LOD demoted to spike-first epilogue E2 with measured memory baseline
    (scope audit, MAJOR; self-audit).
12. Eclipse exit criterion changed from invented number to measured-and-
    biased (self-audit — the moons' inclined orbits may near-never align).
13. Budgets converted to honest ranges; fake grand total dropped; M5/M6
    raised per observed hard-run costs (process audit, MAJOR).
14. CONTRACTS.md idea replaced by targeted `// @ts-check` JSDoc on the five
    height-contract files + invariants inlined here (process audit; prose
    docs demonstrably rotted within hours today).
15. ROADMAP.md marked superseded; JIT plans get committed per milestone
    (process audit, BLOCKING).
16. Standing rule recorded: no AI attribution in commits/PRs (user).

**Sign-off required from Omer before M0 execution begins.**

---

## Delight, UX & deep-simulation backlog (added 2026-07-17, live brainstorm with Omer)

Captured mid-M3 so nothing evaporates. Sequenced AFTER the migration frees the
modules, except the pure-UI items which ship independently off `main`.

### UX / controls (wave `ui-controls`, ships off main — no renderer dependency)
- [ ] Zoom in/out buttons, bottom-right (dispatch wheel events to OrbitControls).
- [ ] Make the sidebar hide/unhide toggle obvious (the `‹` exists but is too subtle).
- [ ] **Feature-toggle panel** — live show/hide of birds, flora, hurricane
      (storms), sea life, weather, sea ice, trails, dragon, airships via
      `.group.visible` on the exposed `__planet` handles (no module changes).

### God-controls / spectacle wave (post-migration; needs module trigger methods)
- [ ] **Meteor strike on click** — streak + impact flash + crater that heals
      (covenant). Stretch: a real force-push / reverted commit auto-summons one.
- [ ] Summon-weather: conjure a hurricane, call an aurora, trigger an eclipse,
      drag the sun to set time-of-day. (Modules exist; expose triggers post-port.)
- [ ] Clouds on/off (needs a sky.js sub-group setter — deferred past the sky port).

### "Soul" features — make Aemunis reflect real work (the app's whole point)
- [ ] **The Aemunis Herald** — a fantasy news ticker narrating REAL git/session
      activity as chronicle ("Clooverforge raised 12 halls overnight"; "a merge
      bridged Omertdkdeep and Dataplatformstead").
- [ ] **Living construction + session health** — active session = building under
      construction (scaffolds/cranes/sparks); errored session = smoke/scorch;
      big clean session = banners. The world becomes a work dashboard.
- [ ] **Roads & bridges** — co-edited projects grow roads between settlements; a
      PR merge builds a bridge; a monorepo becomes a megacity.
- [ ] Soundscape (wind/ocean/forge swelling near activity); ride-along camera
      (follow dragon/airship; walk a worker first-person-ish).

### Deep world-simulation ladder (extends E-SIM; covenant-bound, data-driven)
Everything deterministic from session/git history + a seeded sim clock;
simulation is ADDITIVE and always heals — never destroys session structures.
- **Economy layer:** settlement prosperity from recent session activity; trade
  caravans/airships between frequently-co-edited projects; "industry" from
  tokens spent, "materials" from lines changed, "fortifications" from test
  coverage. Dormant projects overgrow into (weathered, intact) ruins that
  revive when you return.
- **Population/demographics:** population = cumulative session count; cities grow
  a historic old-town (early sessions) + new suburbs (recent); citizen roles by
  work type (tests→inspectors, refactor→masons, feature→builders, bugfix→
  firefighters); work moving between projects = visible migration caravans.
- **Politics/diplomacy (deepens E-SIM raids):** factions = project clusters
  (Cloover kingdom vs tmp/experiment wildlands); merges = treaties/bridges,
  reverts = broken pacts, long branches = breakaway colonies; territory shading
  shifts with activity; merge conflicts = border skirmishes; big rebase =
  invasion; resolution = peace.
- **Data-driven live events:** CI failure = fire/plague until fixed; feature
  merge = festival + new landmark; security fix = walls raised; late-night real
  work = lanterns burning late; commit streak = flourishing, long absence =
  quiet.
- **Emergent/ambitious ceiling:** agent needs + day/night schedules (work by day,
  taverns by night); light wildlife food-web (herds/predators/seasonal
  migration); a true tick-based sim that evolves between visits but stays
  deterministically replayable from the data — "fast-forward the civilization."
- Recommended first cut once appetite allows: **Herald + living-construction/
  health + prosperity/ruins** (highest soul-per-effort), THEN the E-SIM rung-1
  skirmish theater for spectacle.
