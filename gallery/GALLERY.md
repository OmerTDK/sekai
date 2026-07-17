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
