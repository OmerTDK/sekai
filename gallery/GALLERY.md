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


