# Gallery — the making of Aemunis

WIPs, bugs, verdict packets and milestones, kept forever. Rule (plan §0):
every verdict packet, milestone screenshot and GIF gets copied into
`gallery/YYYY-MM-DD/` before its PR merges — the temp dirs they're born in
are lava.

## 2026-07-16 — day one: nothing → a living world

The `screenshot-17842*.jpg` files are chronological. Highlights:

- `…560071-0.jpg` — **first space portrait**: Aemunis with labels, moon, milky way.
- `…0587760-1.jpg` — first sunlit settlement close-up (Crifconsistestead).
- `…3278756-3.jpg` — the short-lived **per-facet "sharp" era** (led to the triangle complaints).
- `…3845080-5.jpg` — grass era, BotW moment (later deleted by verdict — RIP 70k blades).
- `…3961321-6.jpg` / `…3988600-7.jpg` — the **stump-trees bug**: canopies silently
  eaten by a geometry merge failure; birthplace of the warn-loudly rule.
- `…4300925-8.jpg` — sidebar's first appearance; trees got canopies back.
- `…4396914-9.jpg` — **the vertex weld**: triangles finally dead, the smooth island.
- `…5236861-13.jpg` — **first daylight hurricane**, eye and core over the ocean.
- `…5684813-14.jpg` — desert biome reveal.
- `…6035940-18.jpg` — first real ground texture (the grass hillside).
- `…6665389-19.jpg` — **Clooverforge at night**: moonlight + a hundred windows.
  The shot that proved the whole idea.
- `…7307606-20.jpg` — the hurricane carving its subsidence moat through the deck.

## 2026-07-17 — day two: safety net, assets, look development

- `m0-01…06-*.jpg` — the five verify-kit viewpoints, first automated sweep.
- `s5-0*.jpg` — **art-direction verdict packet** (Kenney vs Quaternius ×
  steampunk bolt-ons) → verdict: mix, Kenney base + Quaternius landmarks.
- `screenshot-…-8/10/11.jpg` — S4 BatchedMesh spike (20k meshes vs 1 draw call).
- `screenshot-…-16/17/18.*` — the **84-variant asset grid**: every building
  type × tier × race in two draw calls.
- `ld-terrain-{A..E}-*.jpg` — terrain recipe packet → verdict: **B+C+D**,
  fjords + archipelagos + dramatic relief.
- `ld-water-{1..3}-*.jpg` — water packet (the island-halo shot lives here)
  → verdict: graded-fresnel × stylized-banded hybrid.
- `camera-{1..3}-*.gif` — camera-feel packet → verdict: swoop for visits,
  terrain-skim near the ground.

- `screenshot-…-38/39/41.jpg` — **the fjord world arrives**: M-LD terrain B+C+D + hybrid water live (39 = the fjord-and-coast-glow money shot).
- `screenshot-…-42.jpg` — new Aemunis from orbit, all 250 buildings on the GLTF asset path.
- `m25-airships-01-cruising.jpg` — M2.5 airships verify: a dirigible cruising
  the `/Users/omertdk/Cloover/*` trade-cluster route at altitude, brass rib
  rings + gondola visible against daylight cloud deck.
- `m25-airships-02-moored.jpg` — same ship moments later, moored nose-first
  at its dock mast (altitude locked to `groundR + MAST_HEIGHT` exactly) next
  to Clooverdbtfolorien's forge glow.
- `m25-dragon-01-perched.jpg` — M2.5 dragon verify: the resident dragon
  perched at its lair (tallest-peak lattice scan landed it on a polar
  massif this seed), cave-mouth rock arc + brass hoard glints visible at
  its feet, wings folded via the Flying clip's own narrowest-span frame
  (the rig's raw bind pose turned out fully spread, not folded — worth
  flagging for anyone reusing this asset).
- `m25-dragon-02-banking.jpg` — same dragon moments later, mid-patrol,
  banked hard into a turn over icy terrain — wings, tail and tucked legs
  all read clearly against the sky; a settlement's speech bubble is
  visible below for scale.
- `m-sky-01-starfield-night-orbit.jpg` / `m-sky-02-starfield-zoom-dustlanes.png`
  — M-SKY baked skybox verify: night-side orbit view showing the new
  procedurally-baked milky way (2048x1024 equirect, 553.7ms bake, cached
  per-seed) — the zoom crop shows the dust-lane dark filaments and
  blue-white-core-to-warm-rim grading over the amber galactic band; the
  old point-based starfield rides on top unchanged for parallax twinkle.
- `m-sky-03-sunlit-clouds-shaded.jpg` — M-SKY 2.5D cloud shading + coverage
  cut: ambient deck at its new ~20%/~9% (lower/upper) calibrated coverage,
  sun-relative base-darkening/edge-highlight visible but deliberately
  subtle (white-dominant, no glow, per ART.md 2.5/8).
- `m-sky-04-hurricane-oblique.jpg` / `m-sky-05-hurricane-shadow-zoom.png` —
  M-SKY hurricane 2.5D shading + ocean shadow: oblique view of the mature
  storm (strength 1.0) showing sun-relative shading on the spiral bands;
  the ocean-shadow patch mesh (r=1.001, opacity 0.22, offset away from the
  sun, confirmed live via direct mesh inspection: visible=true, correct
  color/position/renderOrder) is mostly self-occluded under the storm's
  own dense core from this angle — physically expected, most visible at
  the cloud edges/gaps.
- `m-sky-06/07-terrain-cloud-shadow-before/after.jpg` — M-SKY cloud
  shadows on terrain: same fixed camera position, 90 sim-seconds apart
  (verify.seekTime) — the lower cloud deck visibly drifts and the darker
  patches on the terrain beneath track the same motion, confirming the
  getCloudShadowUniforms() contract (sky.js -> planet.js) is live, not
  static. `m-sky-08-terrain-cloud-shadow-zoom.png` is a close crop of the
  after-state showing a shadow band right at a cloud/coast boundary.
- `screenshot-…-64.jpg` — **the galaxy arrives**: PR #4 wave complete — baked milky way, shaded clouds, dragon + airships live.
- `crispness-01-normalmap-ground-ON.jpg` / `crispness-02-normalmap-ground-OFF.jpg`
  — M-POLISH surface-crispness pass, detail normal maps: `ground-sunlit`
  viewpoint, identical camera position (position vector matched to float
  precision across both captures — confirmed via a temporary `uNormalOn`
  live-uniform toggle, removed after use), triplanar NormalGL perturbation
  ON vs OFF. Deliberately subtle at a glance — strength 0.55 per ART.md's
  "silhouettes over noise" — the shading gains a little more micro-variation
  with the maps on; no silhouette or hue change either way.
- `crispness-03-macro-midcoast2R-ON.jpg` / `crispness-04-macro-midcoast2R-OFF.jpg`
  — M-POLISH surface-crispness pass, mid-zoom macro layer: camera pinned to
  exactly 2R along the `mid-coast` viewpoint's own direction (inside the
  layer's 1.5R-3R full-strength band), toggled via a temporary `uMacroOn`
  uniform (added for this comparison, removed from the shipped code
  afterward). `crispness-05-macro-zoom-ON.png` / `crispness-06-macro-zoom-OFF.png`
  are a tighter crop of the same pair (same region, same two states) — the
  broad TILE_MACRO=7 tint breaking up the flat interpolated-vertex-color
  "gradient" look reads more clearly at this crop size, especially over the
  desert/grass transition on the right.
- `flora-poisson-01-before-clumping-wide.jpg` / `flora-poisson-02-after-spread-wide.jpg`
  — M-POLISH flora pass (`flora.js`), Poisson-disk-quality scattering:
  identical camera position/viewpoint (same forest patch, an isolated
  git-worktree build used to isolate this comparison from other builders'
  concurrent in-flight changes on the shared checkout) — before is the
  original pure-rejection stream (12365 trees), after is the same seeded
  stream with a minimum-spacing rejection layered on top via a grid-hashed
  accepted-point lookup (8069 trees, min spacing 0.006 rad, independently
  verified by a brute-force O(n^2) nearest-neighbor check over the actual
  output). The tight clumps + bare gaps in "before" (top-left and
  top-right tree bunches) give way to a more even, breathing-room spread
  in "after" at comparable overall density. Rocks stayed capacity-bound at
  6000/6000 in both (spacing = 0.01 rad had headroom under the existing
  tries budget on this seed).
- `flora-poisson-03-before-close.jpg` / `flora-poisson-04-after-close-blobs.jpg`
  — same pass, close-up on grounded trees: "after" shows the new soft dark
  contact-shadow blobs (one shared InstancedMesh across both trees' and
  rocks' footprints — 14069 instances, ONE draw call; MeshBasicMaterial
  black, opacity 0.28, depthWrite off, polygonOffset, planted +0.0002 along
  the surface normal to dodge z-fighting) grounding each tree/rock instead
  of them looking like they're floating on the terrain.
- `m-wx-material-01-before-clay.jpg` / `m-wx-material-02-after-distinct.jpg` —
  M-WX material-distinction pass (`assets.js`/`buildings.js`/new `env.js`),
  the "clay/play-dough" fix: identical camera position/target/lookAt
  (float-matched, hardcoded and reused across both captures) on the same
  Omertdkdeep dwarf forge cluster, sunlit (seekTime-advanced to a shared
  sun-alignment dot ~0.25 in both), same live speech-bubble labels confirming
  the same deterministic world moment. Before = the old 2-BatchedMesh
  (matte+brass) treatment, everything sharing one flat roughness/color skin.
  After = 4 BatchedMeshes (wood/stone+thatch/cloth+banner/brass), each its
  own roughness+metalness+envMapIntensity+micro-albedo — the roof reads
  distinctly reddish-maroon, walls stone-gray with speckle, wood trim warm
  tan, brass bolt-ons catching a directional highlight from env.js's
  sky-tinted PMREM capture instead of the flat ambient-only look. Captured
  via a scoped `git stash push -- src/assets.js src/buildings.js` / `stash
  pop` round-trip (not a full worktree — env.js and buildings.js's
  non-material exports aren't part of the comparison) so the concurrent
  builders' in-flight world.js/flora.js/planet.js changes on the shared
  checkout stayed untouched throughout.
- `m-polish-camera-1-orbit-start.jpg` / `m-polish-camera-2-swoop-fov-peak.jpg`
  / `m-polish-camera-3-swoop-descending.jpg` /
  `m-polish-camera-4-arrival-tmpgrot.jpg` — M-POLISH camera-feel pass
  (`src/cameraFeel.js`, new), the swoop verdict (ART.md §7) implemented and
  driven live: `flyTo(Tmpgrot.anchorDir, 1.523)` from the default orbit
  (163.5° away — near-antipodal, duration ≈6.1s per the
  `lerp(2.2s,6.5s,angle/π)` formula), four checkpoints through the same
  flight (manually ticked via a temporary cameraFeel instance since the
  verify tab was backgrounded — the task's own "drive updates manually if
  tab hidden" path). Shot 1 near the start (FOV 45.1°, barely underway);
  shot 2 at the exact temporal midpoint (FOV 52.0° — the `sin(πt)` envelope's
  exact peak, camera visibly arced off the straight chord and much closer to
  the surface than a linear interpolation would put it); shot 3 descending
  (FOV 48.7°, easing back down); shot 4 at arrival (`isFlying()`=false, FOV
  exactly 45.0000, camera radius exactly 1.5227 — the commanded arriveDist,
  landed square on Tmpgrot's own buildings). Cancel-on-pointerdown (position
  freezes exactly where interrupted, FOV eases back to exactly 45 over its
  own short recovery timer) verified separately via direct isFlying()/fov
  assertions, not screenshotted.
- `m-polish-declutter-before-orbit.jpg` / `m-polish-declutter-after-orbit.jpg`
  — M-POLISH orbit label-declutter fix (`src/world.js`, the ART.md §7
  flagged label-soup defect): same camera position (default orbit, 3.384R),
  same live world state. Before = every settlement's label sprite forced to
  opacity 1 (simulating the pre-fix unconditional-visible behavior); after =
  the live declutter rule actually running — top 8 settlements by (agents
  desc, structures desc) plus anything within 0.25 rad of screen center,
  eased toward opacity 0/1 (rate 4/s) rather than popped. Verified
  quantitatively, not just visually: 26/26 labels at opacity 1 before, 16/26
  after (8 by rank + 8 more inside the screen-center cone at this particular
  view angle — confirmed by directly reading `labelWantVisible` +
  `material.opacity` off every settlement's own record).
- `m-polish-blob-with.png` / `m-polish-blob-without.png` — M-POLISH agent
  contact-shadow blobs (`src/world.js`, the technique audit's "blob contact
  shadows" slot / the "grounded dwarf" fix): identical camera position, one
  agent's own blob mesh toggled visible/hidden between the two captures
  (nothing else changed) — the soft dark ellipse extending past the dwarf's
  feet in "with" is entirely gone in "without", leaving only the character's
  own tight self-shadow. `m-polish-blob-context.jpg` is the wider same-angle
  shot the crop was taken from, for scene context (rocks/coastline visible).
  Confirmed programmatically too: the blob mesh's scale reads exactly
  `[0.004, 0.00248, 1]` (`BLOB_WIDTH` × `BLOB_WIDTH·BLOB_DEPTH_RATIO`),
  tracking each agent's true ground position (`dir·groundR`) rather than
  their walk-bob/foot-lift offset — confirmed by direct position diffing
  against the paired agent's own visual group.

## 2026-07-17 — M-WX: the world comes alive (weather & life, PR #6)

Six sonnet builders in parallel on a fresh `wave/m-wx` worktree, each owning
one file, wired together by the architect. The wave that added weather and
wildlife to Aemunis.

- `m-wx-01-polar-seaice-snow.jpg` — **polar sea ice + snowfall**, the money
  shot for two features at once (`seaice.js` + `weather.js`). The matte
  white-blue freeze mask caps the pole with a torn, organic edge (noise
  matched to the terrain's own polar-snow band, not a clean latitude line),
  teal shelf edges, branching pressure cracks, and drifting floes; camera-
  local snow streaks fall across it. The sea-ice builder live-drove its own
  module in-browser and caught two bugs a static review would miss: floes
  rendering solid black (a `vertexColors:true` material with no `color`
  attribute → WebGL's default-zero attribute), and cracks invisible because
  their noise-threshold band sat past the 99.8th percentile of the actual
  `ridged()` output (recalibrated against 20k empirical samples).
- `m-wx-02-landfall-flood.jpg` — **hurricane landfall flooding** (`flood.js`).
  Storm forced onto the Camtdbtmodelburg coast (via a scoped `getPrimary`
  override for the capture); the desaturated green-teal storm-water sheet
  rises into the low coastal ground over ~10s, its per-fragment shoreline
  driven by a per-vertex terrain-height attribute resampled at 2Hz so it
  fills inlets and hugs the coast rather than floating as a disc. A worker
  is still logging "Review bank transaction model refactoring" at the
  flooded shore — the covenant holds: weather happens *around* the session
  record, never destroying it. Drains over ~30s, wet-shore ring lingers ~60s.
- `m-wx-03-living-planet-hurricane.jpg` — **Aemunis whole**, all six M-WX
  modules live at once: hurricane eye spiralling on the lit side, polar ice
  caps, drifting weather cells, 161 articulated birds and whale/dolphin pods
  in the seas (too small to resolve at this orbit distance — see the close
  shots), galaxy backdrop. The full living world.
- Also shipped this wave (not re-screenshotted; verified live + by draw-call
  and frame-budget measurement): **articulated birds** (`birds.js`, full
  rewrite — 54-vertex bodies, GPU wing-flap hinge via per-instance phase
  attributes, V-formation/gull/forest habits, 1 draw call for ~150 birds,
  replacing the day-one 2-triangle silhouettes); **whales & dolphins**
  (`sealife.js` — surfacing cycles with spout puffs, fluke-up dives, 1-in-6
  full breach + splash ring, coastal dolphin porpoise arcs, 3 draw calls,
  proven height-bounded via a 667s headless run); **footprint trails**
  (`trails.js` — 600-instance decal ring behind snow-walkers, 25s fade,
  snow-detection matched to the terrain's own thresholds, 1 draw call).
- **Gate metrics** (verify-kit, this wave): all 5 viewpoints resolve, no
  fallbacks; draw calls 52–113/viewpoint; worst-case frame budget 11.4ms /
  88fps at `ground-sunlit` (gate: ≤18ms / ≥55fps), the rest 134–970fps;
  determinism law clean (no `Math.random`/`Date.now` in any world-state
  path); all module scratch allocated once at factory scope, none per-frame.
- **Integration bug caught by the sweep** (`fix(verifykit)`): the birds
  contract gained a `camera` param this wave, but verify-kit's `seekTime`
  still called `birds.update(dt)` with the old signature — the storm
  viewpoint's time-seek threw on `camera.position`. Fixed by threading camera
  through and pumping the new M-WX modules in the fast-forward loop so
  `seekTime` stays a faithful mirror of the render loop. (Also a live
  reminder of the M0 background-throttle gotcha: `sampleFps` waits on
  `requestAnimationFrame`, which Chrome suspends in a backgrounded tab, so
  the sweep hangs at the fps step — the frame budget above was measured by
  timing back-to-back renders instead, immune to throttling.)


