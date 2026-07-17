# World-sim — NPC civilizations, archetypes & first disaster (volcano)

Arc owner: world-sim foundation. Branch `wave/m3-tsl`. Engine: three.js
0.185.1, `three/webgpu` (WebGPURenderer, `forceWebGL:true` today; M4 flips to
the true WebGPU backend), TSL node materials, node `PostProcessing`.

Plan reference: `docs/superpowers/plans/2026-07-16-claude-planet-program-plan.md`
§"Deep world-simulation ladder" (L530) and §"World-sim expansion" (L559–593).

---

## 1. Goal — what the world becomes, how it looks & behaves

Aemunis today is a *session* world: every settlement is one of the owner's
Claude Code projects (`world.js`, covenant-protected — sim may never move or
destroy a session structure). This arc adds a **second, autonomous layer**: a
seeded NPC civilization ecology that exists for the world's own richness, born
purely from the world seed + a sim clock, **independent of whether any session
maps to it** ("create civilizations even if no related sessions").

What the owner sees:

- The empty continents fill with **distinct civilizations** — desert-nomad
  tent-caravanserais on dunes, seafaring port cities hugging coastlines,
  dwarven holds carved into mountain slopes, elven forest communes under the
  canopy, steampunk industrial metropolises belching gear-smoke, cliff
  monasteries on ridges. Each reads instantly by **architecture + palette +
  units + banner glyph**, never anime/cel — stylized-but-realistic.
- Civilizations have a **visible life**: a hamlet founded near sim-year 40
  grows into a town, a city, sprouts a wonder; a few **fall to weathered
  ruins** during a dark age and later **resettle**. All of it is a pure
  function of `(worldSeed, simTime)` — scrub the sim clock and history replays
  identically forwards or backwards ("fast-forward the civilization").
- **Active trade routes**: caravans plod the roads between inland civs, ships
  ply sea-lanes between ports; trade-hub cities visibly prosper. Continuous,
  seeded, never-ending motion.
- **One disaster as first spectacle — a VOLCANO.** A seeded volcanic mountain
  periodically erupts: lava glow, ash plume, godray shafts, and it **grows new
  land additively** as lava cools to fresh rock. Covenant-safe by construction:
  it only ever *adds* meshes and *heals* (cools, regrows) — it never lowers
  terrain or touches a session structure. A synchronized screen-shake sells the
  quake without moving a single building.

The whole layer hangs off the existing sun/time system (`sky.js` already orbits
the sun deterministically) via a shared **sim clock** with pause / fast-forward
/ rewind — the same control the owner wants for "fast rotating sun so I can see
the dark side light up."

---

## 2. Technical approach — grounded in the real 0.185.1 API

### 2.1 Layering & the golden rule

Strict split between **pure deterministic data** and **rendering**:

```
worldSeed + simTime ──► civsim.js (PURE, no THREE) ──► civ state records
                                                   │
                              ┌────────────────────┼───────────────────┐
                       civrender.js          traderoutes.js        volcano.js
                     (InstancedMesh)     (caravans/ships, GPU)   (additive FX)
```

`civsim.js` imports **no** rendering; it is a pure reducer `civStateAt(simTime)`.
Everything visual is a *projection* of that state. This is what makes the layer
replayable and cheap.

### 2.2 Determinism primitives (already in the codebase — reuse, don't reinvent)

`src/util.js` exports the full deterministic toolkit and NPC civ code must use
**only** these for any state — never `Math.random` / `Date.now`:

- `rngFromString(s)` → seeded `mulberry32` generator (per-civ, per-decision
  streams via distinct string keys, exactly as `world.js` does:
  `rngFromString(id + '~agent')`).
- `hash01(s)` → deterministic scalar in [0,1) (used by `world.js` at
  `createSettlementRecord` L596 for lat/lon).
- `makeNoise3D(seedStr)` + `fbm` / `ridged` for continuous seeded fields
  (density, resource potential).

Sphere-placement math is already factored into `src/placement.js`:
`tangentBasis`, `yawedTangent`, `stepToward`, `orientOnSurface`,
`findLandAnchor`, `findStructureSpot`, `randomLandNear`. **`sphericalOffset` is
private** to placement.js — `airships.js` duplicated it as `offsetPoint`
(L137); a new civ module should either (a) add an exported `sphericalOffset` to
placement.js in a tiny task, or (b) duplicate identically. This doc chooses
(a) — Task P0.

Planet query API (from `src/planet.js` L888): `planet.sampleHeight(dir)`,
`planet.isLand(dir)`, `planet.biomeAt(dir,out)` → `{h, landT, moisture, slope,
polar}`. Radius 1, `SEA_LEVEL = 1.0` (`util.js`). Archetype biome-affinity
scoring uses `biomeAt` (moisture→forest/desert, slope→mountain, coastal
adjacency→ports).

### 2.3 Rendering: instancing to protect the draw-call budget

Baseline is **54 draw calls / ~11 ms headroom on M5 Pro**. NPC civs could be
dozens of settlements × many structures — naive `Group`-per-building would blow
the budget. Approach:

- **`THREE.InstancedMesh`** (in `three/webgpu`) — **one instanced mesh per
  (archetype × structure-role)**, e.g. all dwarven-hold "gatehouses" in one
  draw call regardless of how many holds exist. Per-instance transform via
  `setMatrixAt` using `orientOnSurface` + `sampleHeight` for surface placement.
  Per-instance tint/weathering via an instanced attribute read in a TSL node
  material — TSL exposes `instancedBufferAttribute` / `attribute` /
  `instanceIndex` (confirmed in `three/tsl` exports) so ruins-weathering and
  age-tint are a `mix()` in the material, not extra draw calls.
- Structure geometry reuses `src/buildings.js` kit builders
  (`buildTower/Hall/Farm/Barracks`, `RACE_PALETTES`, `KIT_UNIT_SIZE`,
  `TIER_MULT`); archetypes extend `RACE_KEYS` (today `human/elf/dwarf/orc`) with
  archetype-specific palettes/kits. Merge each archetype's kit into a small set
  of instanced geometries at build time.
- Node materials only (TSL): albedo/emissive via `MeshStandardNodeMaterial`;
  age/ruin blend via TSL `mix`/`smoothstep`/`mx_fractal_noise_vec3` (confirmed
  exports) — same pattern `planet.js` already uses for biome splatting.

### 2.4 Trade routes — reuse the airship travel engine

`src/airships.js` already implements exactly the motion we need: `deriveRoutes`
(L213) builds a seeded route graph over settlements, `beginLeg`/`nlerpPoint`/
`offsetPoint`/`tangentForward` move a craft along a great circle with an
instanced fading trail. **Caravans and ships are the same machine with a
ground-clamped path (`sampleHeight` each step) vs a sea-clamped path.** Build
`traderoutes.js` by generalizing that pattern:

- Land caravans: instanced low-poly wagon/pack-beast meshes, path snapped to
  terrain via `sampleHeight`, oriented via `orientOnSurface`.
- Sea ships: instanced hulls, path clamped to `SEA_LEVEL`, only between
  civs with a coastal port node.
- Optional GPU upgrade (post-M4, if CPU stepping shows up in the profile):
  drive caravan positions with a **compute pass** — `three/tsl` exports
  `instancedArray`, `compute`, `storage`, `storageBarrier`, `Fn`,
  `instanceIndex`, `deltaTime`, `time` — write positions into an
  `instancedArray` storage buffer in an `Fn` kernel dispatched via
  `.compute(count)`, exactly the gpgpu idiom. Kept as a fallback lever, not the
  first cut.

### 2.5 The volcano (first disaster) — additive & covenant-safe

Pick **VOLCANO** over earthquake: it is the bigger spectacle and is naturally
additive (lava *adds* land), whereas a destructive quake risks the covenant.

- **Geometry**: a seeded conical volcanic mountain placed like any civ anchor
  (its own group; never edits `planet` geometry). Eruptions are timeline events
  from `civStateAt` (or triggered by a real `deploy` event via `events.js`).
- **Lava glow**: emissive TSL material; the existing `bloom()` post pass
  (`main.js` L116, `three/addons/tsl/display/BloomNode.js`) already picks up
  >1.0 emissive, so lava blooms for free. Animated crust cracks via
  `mx_fractal_noise_vec3` + `time`.
- **Ash plume**: instanced billboarded particles. `three/tsl` exports
  `billboarding`, `time`, `deltaTime`, `range` — a pool of camera-facing quads
  rising + drifting, identical in spirit to `world.js` `spawnPlumePuff` (L424)
  and airship trails. Particle *jitter* may use `Math.random` (it's ephemeral
  visual noise, not world state — same precedent as the existing plume);
  eruption *timing/location* must be seed-derived.
- **God-rays** (optional polish): `three/addons/tsl/display/GodraysNode.js`
  exports `godrays(depthNode, camera, light)` (verified L615) — shafts through
  the ash. Behind a quality flag.
- **New land, additively**: as lava flows, spawn fresh-rock instanced tiles on
  top of existing terrain along the flow path (a growing skirt around the
  cone). It only *adds* height/meshes; `planet.sampleHeight` is never mutated,
  so no session structure ever loses ground. Lava then **cools** (emissive →
  rock albedo lerp) and ash **fades** — the world heals.
- **Screen-shake**: drive `src/cameraFeel.js` with an additive positional
  shake envelope during the eruption. Buildings never move; only the camera
  does. This is how we get "earthquake feel" covenant-safely.

### 2.6 Sim clock & sun coupling

`simClock.js`: a scalar `simTime` (sim-years) advanced by `dt * speed`;
`speed` is user-controllable (pause / ×1 / ×fast / rewind negative). **State is
a pure function of `simTime`**, so rewind is free and exact. The clock also
feeds `sky.js`'s sun so the terminator sweeps at the chosen speed (owner's
"fast rotating sun" headline). Clock **controls** are UI state (not world
state) — allowed to be imperative; the *world* stays a pure projection.

---

## 3. Data model, new/changed files & module contracts

### 3.1 Core data model (the heart of the arc)

```js
// civsim.js — PURE. No THREE import.
Archetype = {              // static, from archetypes.js
  key, name, glyph,        // 'desert-nomad', '☀', ...
  palette,                 // {cloth,roof,banner,accent,...} extends RACE_PALETTES shape
  kit,                     // structure-role -> kit builder / geometry key
  biomeAffinity(biome),    // (planet.biomeAt result) -> score 0..1
  unit,                    // caravan/ship visual key
  behavior,                // growth rate, fall probability, wonder type
}

Civ = {                    // one NPC civilization, fully seeded
  id,                      // `npc:${archetypeKey}:${index}` (stable seed key)
  archetype,               // Archetype key
  anchorDir: Vector3,      // deterministic placement (see §3.2)
  groundR,                 // sampleHeight(anchorDir)
  foundedAt, prime, fallAt, resettleAt,  // sim-year milestones (seeded, may be null)
  wonderAt,                // sim-year a wonder appears (or null)
  routeAffinityKey,        // for trade-route graph clustering
}

CivState = {               // civStateAt(civ, simTime) — pure
  phase,                   // 'unfounded'|'hamlet'|'town'|'city'|'ruins'|'resettled'
  population,              // smoothstep growth curve of simTime
  prosperity,             // 0..1, boosted by trade-hub degree
  ruinFrac,               // 0..1 weathering blend for the material
  structureCount,         // derived from phase (drives instance count)
  hasWonder,
}
```

**Placement law** (`civsim.js`, §3.2 detail): candidate anchors are generated
by a seeded blue-noise sweep over the sphere (Fibonacci-lattice base points
jittered by `rngFromString('npc-site:'+i)`); each candidate is **rejected** if
(a) not land / above build height (`planet.isLand`), (b) within
`MIN_CIV_SEPARATION` great-circle angle of **any session-settlement anchor** (a
snapshot of `world.list()` anchors — the collision-avoidance that guarantees
NPC civs never overlap covenant structures), (c) within separation of an
already-accepted NPC civ, or (d) biome-affinity below threshold for its
archetype. Accept in deterministic candidate order until `TARGET_CIV_COUNT`.
Because both the candidate order and the session-anchor set are deterministic,
placement is fully replayable.

### 3.2 New files & `create*` contracts

| File | Contract | Notes |
|---|---|---|
| `src/sim/archetypes.js` | `export const ARCHETYPES` (registry) + `pickArchetypeForBiome(biome, rng)` | Pure data + kits; extends buildings.js palettes |
| `src/sim/simClock.js` | `createSimClock(opts) -> { simTime, update(dt), setSpeed(s), pause(), seek(t) }` | UI-controllable scalar; feeds sky sun |
| `src/sim/civsim.js` | `createCivSim(planet, worldSeed, sessionAnchors) -> { civs, civStateAt(civ, simTime), routes }` | PURE data; no THREE render. `routes` = derived graph |
| `src/civrender.js` | `createCivCivs(planet, civSim, simClock) -> { group, update(dt) }` | InstancedMesh per archetype×role; reads civStateAt each throttled tick |
| `src/traderoutes.js` | `createTradeRoutes(planet, civSim, simClock) -> { group, update(dt) }` | Caravans (land) + ships (sea); reuse airships travel math |
| `src/volcano.js` | `createVolcano(planet, worldSeed, simClock, cameraFeel, events) -> { group, update(dt), erupt() }` | Additive FX; screen-shake via cameraFeel |
| `src/placement.js` | **add** `export function sphericalOffset(out, base, bearing, dist)` | Un-privatize the existing helper (Task P0) |

### 3.3 Integration points in `main.js` (all additive)

- After `const world = createWorld(...)` (L58) and once settlements are
  snapshotted (mirror `airships.js` `INIT_SETTLE_DELAY` — take
  `sessionAnchors` from `world.list()` + settlement `anchorDir`s after the
  first poll, so NPC placement sees the covenant set):
  ```js
  const simClock = createSimClock({ speed: 1 })
  const civSim   = createCivSim(planet, SEED, sessionAnchors)
  const civs     = createCivCivs(planet, civSim, simClock);   scene.add(civs.group)
  const trade    = createTradeRoutes(planet, civSim, simClock); scene.add(trade.group)
  const volcano  = createVolcano(planet, SEED, simClock, cameraFeel, events); scene.add(volcano.group)
  ```
- In `renderer.setAnimationLoop` (L191): add
  `simClock.update(dt); civs.update(dt); trade.update(dt); volcano.update(dt);`
  and pass `simClock.simTime` into `sky.update` so the sun couples to sim
  speed.
- `ui.js`: expose sim-clock controls (pause / speed / seek) — the god-controls
  panel; also volcano `erupt()` as a demo button.
- `window.__planet` + `verifykit`: register `civSim`, `civs`, `trade`,
  `volcano`, `simClock` for console + verification (mirror L143/L166).

---

## 4. Determinism, covenant & performance

**Determinism.** All civ state derives from `(worldSeed, simTime)` via
`rngFromString`/`hash01`/`makeNoise3D`. No `Math.random`/`Date.now` in any
Civ/CivState field, placement, route graph, or eruption timeline. Per-decision
RNG streams use distinct string keys (`'npc-site:'+i`, `civ.id+'~timeline'`,
`civ.id+'~kit'`). Sim clock rewind is exact because state is a pure function of
`simTime`, not an accumulator. **Allowed non-determinism:** ephemeral particle
jitter (ash, trail puffs) and camera-shake phase — visual noise only, matching
the existing `world.js` plume precedent; never world state.

**Covenant.** The NPC layer lives in its **own** `group`s and never reads/writes
`world.js` internals. Placement *reads* session anchors only to keep clear of
them (rejection sampling), guaranteeing zero overlap. The volcano is strictly
additive: it spawns fresh-land tiles *on top of* terrain and cools/heals; it
never mutates `planet` geometry or `sampleHeight`, so no session structure ever
loses its ground. Quake feel is camera-only. Nothing in this arc can move or
destroy a session structure — it's structurally impossible, not merely avoided.

**Performance (54 draws / ~11 ms M5 Pro budget).**
- Instancing caps draw calls: target **+8–14 draw calls total** — one per
  archetype×role InstancedMesh (~6 archetypes × ~2 roles batched), one
  caravan mesh, one ship mesh, one route-trail system, one volcano cone +
  one ash-particle system. Civ *count* does not multiply draw calls.
- Sim tick is **throttled** (e.g. re-evaluate `civStateAt` for all civs every
  ~0.5 s, like `world.js`'s HUD/label throttle), not every frame; only instance
  matrices for civs whose phase/scale changed are rewritten.
- Particles pooled (fixed-size ring buffer like `spawnPlumePuff`), no per-frame
  allocation. Vector scratch objects module-scoped (codebase convention).
- GPU-compute caravan path (§2.4) held in reserve if CPU stepping ever costs
  budget post-M4.

---

## 5. Build-task breakdown (fan-out ready — one file each where possible)

Ordered; **P-tasks** unblock parallel fan-out. Tasks marked ∥ are mutually
independent once their prereqs land.

- **P0 — placement.js**: export `sphericalOffset` (un-privatize existing
  helper). Tiny, unblocks civsim/traderoutes/volcano. *(no new file)*
- **P1 — archetypes.js** ∥: author the 6 archetype records (palette, glyph,
  kit-role map, `biomeAffinity`, growth/fall/wonder behavior params). Pure
  data; extends `buildings.js` palette shape. No deps beyond buildings.js.
- **P2 — simClock.js** ∥: `createSimClock` scalar + pause/speed/seek. Pure,
  no deps.
- **T3 — civsim.js** (needs P0, P1): the data-model core — seeded placement
  (blue-noise + session-anchor rejection + biome affinity), `Civ` timeline
  seeding, `civStateAt` reducer, `routes` graph derivation. **Highest-value,
  most-tested task; ship with a unit test asserting identical output for a
  fixed (seed, simTime) and identical replay after seek.**
- **T4 — civrender.js** (needs T3, P1): InstancedMesh per archetype×role;
  build kits from buildings.js; per-instance age/ruin tint via TSL node
  material; throttled update reads `civStateAt`.
- **T5 — traderoutes.js** (needs T3, P0): generalize airships travel math into
  land-caravan + sea-ship instanced movers along the `routes` graph; instanced
  fading trails. ∥ with T4.
- **T6 — volcano.js** (needs P0, P2): seeded cone, emissive lava (bloom
  pickup), instanced ash plume (`billboarding`+`time`+`range`), additive
  cool-to-rock land growth, cameraFeel screen-shake, optional `godrays`
  behind a quality flag. ∥ with T4/T5.
- **T7 — main.js wiring**: instantiate the four modules with a session-anchor
  snapshot (mirror airships `INIT_SETTLE_DELAY`); add to loop; couple
  `simClock.simTime` into `sky.update`; register in `__planet`/verifykit.
  (Serialize after T4–T6 land.)
- **T8 — ui.js god-controls**: sim-clock panel (pause/speed/seek slider) +
  volcano erupt trigger; wire to simClock + fast-sun. ∥ with T7-tail.
- **T9 — verifykit.js hooks**: deterministic-replay assertion (seek to Y,
  seek away, seek back → identical instance matrices) + draw-call budget probe.
- **T10 — events.js hook** (optional): `deploy` event → `volcano.erupt()`,
  as the plan's "deploy→eruption" trigger. ∥, low-risk.

Fan-out: after P0/P1/P2 merge, **T4, T5, T6 run fully in parallel**; T3 is the
one serial spine everything depends on, so build it first and gate the rest on
its test passing.

---

## 6. Risks & fallback

**Biggest risk — draw-call / budget blow-out from the civ layer.** Six
archetypes with varied architecture is a lot of distinct geometry; if
per-archetype kits fragment into many materials/meshes, the +8–14 target
balloons and we lose the ~11 ms headroom. *Mitigation:* enforce **one
InstancedMesh per archetype×role** with per-instance variation pushed into the
TSL node material (tint/weathering as attributes, not new meshes); merge each
archetype's kit into ≤2 geometries at build time. *Fallback if still too
costly:* ship **3 archetypes** at full fidelity (desert-nomad, seafaring-port,
steampunk-metropolis — the most visually distinct) and represent the rest as
palette/banner reskins of existing `buildings.js` kits; drop `godrays` and the
GPU-compute caravans (both are already flagged as optional polish, not the
first cut). The data model (T3) is unchanged by this fallback — only the
rendering fidelity scales down, which is exactly why the pure-data split is the
architectural keystone.

**Secondary risks:** (a) session-anchor snapshot timing — NPC placement must
wait for `world.js`'s first poll or it'll place civs where sessions later
appear; mitigated by the `INIT_SETTLE_DELAY` snapshot pattern airships already
proves. (b) M4 backend flip — all APIs named here are `three/webgpu` +
`three/tsl` (not WebGL-host-specific), so the layer is M4-ready by
construction; the only backend-sensitive lever (compute-driven caravans) is
deliberately deferred.
