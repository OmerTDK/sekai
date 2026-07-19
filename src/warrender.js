// E-SIM conflict-ladder RENDER layer (rungs 1-3) — see
// docs/design/epilogue-e-sim.md §"R1-2 / R2-3 / R3-2 warrender.js". A pure
// projection of the warsim.js DATA layer: it reads `warSim.raids` (seeded +
// data-driven raid records) and `warSim.raidStateAt(raid, warClock, out)` (the
// pure reducer) and draws each raid as instanced armies marching → mustering →
// clashing on an on-land battlefield, then the aftermath marks (winner banners,
// ground scorch, ruins-props) that heal completely over the epoch, plus a
// night-torch ember pool among the clashing units.
//
// RUNG 1 (always on): field raids — armies + banners + scorch + props + torches.
// RUNG 2 (data-driven, additive): a translucent faction-influence "territory"
//   overlay that ebbs between rival clusters and heals to nothing; and supply
//   intercepts along routes — a road ambush (reuses the scorch ring) that strews
//   supply wreckage (reuses the props mesh).
// RUNG 3 (deep-sim, additive): sieges — besiegers ring a settlement on a
//   covenant-clear offset ring (NEVER the footprint), holding then withdrawing,
//   the ring healing on lift; and treaties — when two rivals reconcile the
//   hostilities are replaced by a gold peace banner at the midpoint and a herald
//   peace line. All rung 2/3 features are OPTIONAL projections of the warsim
//   R2/R3 API (raid.kind / raid.ringDirs / raid.supplyProps / treatyBetween);
//   when warsim exposes none of them (rung-1-only warsim) this layer renders
//   EXACTLY the rung-1 theater — see the defensive readers below.
//
// THE COVENANT: this module owns its own THREE.Group added ALONGSIDE (never
// inside) world.group; it never reads or writes world.js internals and never
// holds a mutable reference to a session mesh. Every army position and every
// mark (banner/scorch/prop/territory/siege ring) is a pure function of the war
// clock — warsim has already covenant-clearance-tested every dir against the
// session anchors + structure dirs, so this layer only READS planet.sampleHeight
// and paints. Because raidStateAt(raid, clock) is idempotent over EPOCH, the
// marks heal automatically and totally: scorch/banners/territory fade +
// degenerate-scale to nothing and props vanish at epoch/siege end, returning the
// world bit-for-bit to its pre-raid visual state. The territory overlay is a
// translucent additive drape (depthWrite:false), never a permanent stain — its
// whole mesh hides when the map is at peace. Session structures are never moved,
// recolored, scaled or hidden by any path in here; a siege rings the settlement
// at an offset and never enters or overlaps the footprint.
//
// ENGINE: WebGPURenderer(forceWebGL) host — every material is a *NodeMaterial
// from three/webgpu with a TSL node graph built ONCE at construction and
// animated only through uniform() writes (S1 build-once/uniforms-only law).
// Per-instance variation rides on custom instanced float attributes read in
// the colorNode (aFaction/aFall/aHeal/aPeace/aIntensity) — the exact
// civrender.js aRuin/aWarm pattern, proven on the WebGL2 default host. Inactive
// instances hide via a degenerate makeScale(0,0,0) (WebGPU-safe).
// frustumCulled=false everywhere (instances span the globe).
//
// DRAW-CALL BUDGET: 5 rung-1 draws — (1) warriors InstancedMesh + (2) banners +
// (3) scorch + (4) props + (5) torch Points — plus (6) ONE territory overlay
// InstancedMesh, drawn only while a conflict is actually contested (hidden at
// peace). Siege / intercept / treaty visuals REUSE the warriors/banners/scorch/
// props meshes — no new draws. Independent of raid count.
//
// DETERMINISM: the sole time source is warClock, accumulated from dt in
// update(); raidStateAt(raid, warClock) is a pure function of it, so a reload
// with a fixed ?seed replays identically. Territory intensity, siege occupancy
// and treaty state are all pure projections of that clock + warsim state — no
// per-frame RNG. The ONE place Math.random is allowed is the ephemeral torch/
// ember Points pool (never read back into sim state — the same exemption
// events.js's firework pool ships under). No Date.now.
//
// Contract (pinned, UNCHANGED across rungs): export function
// createWarRender(planet, warSim, seed) ->
// { group, update(dt, camera, sunDir), setNarrator(fn) }.
import * as THREE from 'three/webgpu'
import { attribute, positionGeometry, uniform, vec3, mix, sin, smoothstep } from 'three/tsl'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { SEA_LEVEL, rngFromString, clamp } from './util.js'
import { tangentBasis, orientOnSurface } from './placement.js'

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------
const VISIBLE_DIST = 3.2 // R — beyond this the whole layer hides (matches civrender VISIBLE_DIST)
const STATE_REFRESH = 0.4 // s — throttle for re-reading raidStateAt + rewriting matrices when nothing is moving

const WARRIOR_SCALE = 0.006 // world units — unit-space geometry (~1 tall) scaled by this at instance time
const BANNER_SCALE = 0.0105
const SCORCH_SCALE = 0.02 // disc radius in world units
const PROP_SCALE = 0.006
const SUPPLY_SCALE = 0.0042 // intercept supply wreckage — smaller scattered pieces (reuses the props geo)

const WARRIOR_LIFT = 0.0004 // world units above sampleHeight (foot clearance)
const BANNER_LIFT = 0.0004
const SCORCH_LIFT = 0.0005 // sit a hair above the ground so the decal never z-fights terrain
const PROP_LIFT = 0.0004

const FALLEN_LEAN = 1.25 // rad — a fully-fallen unit tips this far forward before greying out

const NIGHT_DOT = 0.1 // sunDir·battlefieldDir below this ⇒ the battlefield is in night (torches lit)

// --- Rung-2/3 dynamic-raid capacity ---------------------------------------
// Rung-1 raids are known at construction (warSim.raids); rung-2/3 raids
// (border skirmishes, supply intercepts, sieges) are appended to warSim.raids
// at RUNTIME by warSim.ingest(events). We reserve a fixed pool of dynamic slots
// AFTER the rung-1 region so those render without ever resizing a mesh or
// disturbing a single rung-1 instance range (the rung-1 region stays byte-for-
// byte identical to the shipped rung-1 layout).
const DYN_SLOTS = 6 // concurrent runtime raids we can render (RAID_CAP+2 border headroom + sieges)
const PER_RAID_WARRIORS = 32 // field army (ATK_MAX 16 + DEF_MAX 14) OR a siege ring — max per raid
const PER_RAID_BANNERS = 8 // field 3 / siege ring banners / +1 treaty banner
const PER_RAID_SCORCH = 16 // field ring 7 + raided settlement ring 7 / siege ground ring
const PER_RAID_PROPS = 10 // field wrecks 3 + intercept supply scatter

// --- Rung-2 territory / influence shading ---------------------------------
const TERRITORY_SLOTS = 24 // max influence nodes (cluster anchors + contested borders touched by conflict)
const TERRITORY_ANGLE = 0.06 // world units — influence disc radius on the surface
const TERRITORY_LIFT = 0.0006 // world units above ground (drape, no z-fight)
const TERRITORY_ALPHA = 0.3 // peak additive strength of an influence patch
const TERRITORY_EBB = 0.9 // rad/s pulse rate of the influence breathing
const TERRITORY_VISIBLE_MIN = 0.02 // hide the whole overlay below this max intensity (no peacetime stain)

// --- Rung-3 siege ---------------------------------------------------------
const SIEGE_HIDE_PRESENT = 0.03 // besiegers below this ring-presence are hidden (fully withdrawn)

// Faction + mark palette.
const REALM_TINT = 0x3b5c8c // banner-blue (RACE_PALETTES.human)
const RAIDER_TINT = 0x6d7346 // orc drab-olive (RACE_PALETTES.orc cloth×accent), reads distinct from realm blue
const PEACE_GOLD = 0xd9b24a // treaty cloth — neutral gold, distinct from both factions
const FALLEN_GREY = { r: 0.18, g: 0.16, b: 0.14 } // fallen units grey toward this
const SCORCH_DARK = 0x241d16 // burnt-earth char
const GROUND_TONE = 0x6b6459 // neutral earth tone the scorch lerps back to as it heals
const TORCH_WARM = 0xff7a2a // ember color

const TAU = Math.PI * 2

// Torch/ember pool (events.js firework-pool clone — the ONE Math.random block).
const TORCH_POOL = 260 // shared additive-particle budget for ALL raids' battle torches
const TORCH_TTL = 1.3 // seconds an ember lives
const TORCH_TTL_JITTER = 0.4
const TORCH_SIZE = 5 // PointsMaterial size, screen-space (sizeAttenuation:false)
const TORCH_GRAVITY = 0.04 // world units/s^2 pulling embers back toward the planet
const TORCH_SPEED_MIN = 0.006 // world units/s ember rise speed
const TORCH_SPEED_MAX = 0.014
const TORCH_HEIGHT = 0.004 // world units above the unit the ember spawns at
const EMBER_RATE = 26 // embers/sec spawned across all night-clashing units

// ---------------------------------------------------------------------------
// Module-scope scratch (write-before-read only; never holds state across calls
// — civrender/caravans convention; the placement passes run sequentially, not
// concurrently, so sharing is safe). Separate tangent scratch per helper so no
// call clobbers another's basis mid-computation.
// ---------------------------------------------------------------------------
const _c = new THREE.Color() // build-time only
const _o1 = new THREE.Vector3() // offsetPoint tangent basis
const _o2 = new THREE.Vector3()
const _ta1 = new THREE.Vector3() // anyForward basis
const _ta2 = new THREE.Vector3()
const _center = new THREE.Vector3()
const _enemy = new THREE.Vector3()
const _unitDir = new THREE.Vector3()
const _fwd = new THREE.Vector3()
const _emberUp = new THREE.Vector3()
const _dummy = new THREE.Object3D()
const _mat4 = new THREE.Matrix4()

// Two independent state scratch objects: one for the cheap per-frame "is
// anything moving" peek, one for the full placement pass.
const _peek = {}
const _st = {}

// ---------------------------------------------------------------------------
// Pure spherical helpers (duplicated locally per this codebase's convention —
// caravans.js/civrender.js keep private copies rather than exporting).
// ---------------------------------------------------------------------------

/** Writes into `out` the unit point `dist` radians from `base` along `bearing`. */
function offsetPoint(base, bearing, dist, out) {
  tangentBasis(base, _o1, _o2)
  const cb = Math.cos(bearing)
  const sb = Math.sin(bearing)
  const tx = _o1.x * cb + _o2.x * sb
  const ty = _o1.y * cb + _o2.y * sb
  const tz = _o1.z * cb + _o2.z * sb
  const cd = Math.cos(dist)
  const sd = Math.sin(dist)
  return out.set(base.x * cd + tx * sd, base.y * cd + ty * sd, base.z * cd + tz * sd).normalize()
}

/** Normalized-lerp between unit vectors `a`/`b` — the cheap great-circle approximation used across the codebase. */
function slerpUnit(a, b, t, out) {
  out.set(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t)
  if (out.lengthSq() < 1e-10) out.set(a.x, a.y, a.z)
  return out.normalize()
}

/** Tangent-plane heading at `dir` toward `target`, written into `out` (falls back to any tangent if degenerate). */
function tangentToward(dir, target, out) {
  out.set(target.x - dir.x, target.y - dir.y, target.z - dir.z)
  const d = out.dot(dir)
  out.addScaledVector(dir, -d)
  if (out.lengthSq() < 1e-12) return anyForward(dir, out)
  return out.normalize()
}

/** Any unit tangent at `dir`, written into `out` — used when there is no meaningful facing. */
function anyForward(dir, out) {
  tangentBasis(dir, _ta1, _ta2)
  return out.copy(_ta1)
}

const isVec = (v) => v != null && typeof v.x === 'number' && typeof v.y === 'number' && typeof v.z === 'number'
const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d)
const ease = (t) => {
  const x = clamp(t, 0, 1)
  return x * x * (3 - 2 * x)
}
/** Scalar smoothstep (kept distinct from the TSL `smoothstep` node import above). */
function smooth01(a, b, x) {
  const t = clamp((x - a) / (b - a), 0, 1)
  return t * t * (3 - 2 * t)
}

// Normalize a warsim raid kind to one of the render paths. Anything not a known
// rung-2/3 kind (including a missing kind, i.e. a rung-1 raid) is a field raid.
function raidKind(raid) {
  const k = raid && raid.kind
  return k === 'border' || k === 'intercept' || k === 'siege' ? k : 'raid'
}
const movingPhase = (p) =>
  p === 'marching' || p === 'clashing' || p === 'approach' || p === 'encircle' || p === 'lift'

// ---------------------------------------------------------------------------
// Geometry authoring — local unit space, forward=+Z, up=+Y, feet/base at y=0,
// figures ~1 tall (scaled to world size at instance time). Low-poly merged
// parts with baked per-vertex 'color' (caravans.js/civrender.js mergeParts +
// paintFlat idiom). For faction-tinted geometry the vertex color is a
// grayscale *brightness* the colorNode multiplies the faction tint by, so hue
// comes from aFaction and part definition from the baked brightness.
// ---------------------------------------------------------------------------
let warnedMerge = false
let warnedNoRaids = false
let warnedDropRaid = false
let warnedNoRing = false

function paintRGB(geo, r, g, b) {
  const n = geo.attributes.position.count
  const arr = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    arr[i * 3] = r
    arr[i * 3 + 1] = g
    arr[i * 3 + 2] = b
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3))
  return geo
}

function paintColor(geo, hex) {
  _c.set(hex)
  return paintRGB(geo, _c.r, _c.g, _c.b)
}

function box(sx, sy, sz, px, py, pz) {
  const g = new THREE.BoxGeometry(sx, sy, sz)
  g.translate(px, py, pz)
  return g
}

function mergeParts(parts) {
  const nonIndexed = parts.map((g) => (g.index ? g.toNonIndexed() : g))
  const merged = mergeGeometries(nonIndexed, false)
  if (!merged && !warnedMerge) {
    warnedMerge = true
    console.warn('[planet] warrender.js: geometry merge degraded — mergeGeometries failed, shipping first part only')
  }
  const out = merged || nonIndexed[0]
  out.computeVertexNormals()
  return out
}

// A spear-and-shield warrior: torso/legs + head + shoulders + a tall spear on
// the right and a shield on the left. Brightness-baked so the faction tint
// carries the hue (head slightly warm to read as skin, spear/shield darker).
function buildWarriorGeo() {
  return mergeParts([
    paintRGB(box(0.3, 0.5, 0.22, 0, 0.28, 0), 0.95, 0.95, 0.95), // torso/legs
    paintRGB(box(0.2, 0.2, 0.2, 0, 0.63, 0), 1.15, 1.05, 0.9), // head (warm)
    paintRGB(box(0.3, 0.13, 0.18, 0, 0.5, 0.02), 1.0, 1.0, 1.0), // shoulders
    paintRGB(box(0.03, 0.95, 0.03, 0.17, 0.48, 0.05), 0.4, 0.36, 0.3), // spear shaft (dark wood)
    paintRGB(box(0.06, 0.11, 0.06, 0.17, 0.99, 0.05), 0.72, 0.72, 0.74), // spear head (steel)
    paintRGB(box(0.05, 0.28, 0.24, -0.16, 0.38, 0.04), 0.78, 0.78, 0.82), // shield
  ])
}

// A war banner: a dark pole (baked low brightness so it stays dark regardless
// of faction tint) with a cloth flying to one side (full brightness = faction).
function buildBannerGeo() {
  const pole = new THREE.CylinderGeometry(0.02, 0.02, 1.0, 6)
  pole.translate(0, 0.5, 0)
  return mergeParts([
    paintRGB(pole, 0.32, 0.28, 0.24), // pole
    paintRGB(box(0.03, 0.42, 0.5, 0.0, 0.68, 0.27), 1.0, 1.0, 1.0), // cloth (faction-tinted)
  ])
}

// A flat down-facing scorch disc (+Y normal after the rotate) — the colorNode
// defines its color entirely (dark char → ground tone by aHeal), so it needs
// no baked vertex color.
function buildScorchGeo() {
  const g = new THREE.CircleGeometry(1, 20)
  g.rotateX(-Math.PI / 2)
  return g
}

// A broken ruins-cart: a tilted bed, a snapped plank, one standing wheel and
// one fallen wheel — a legible "battle wreck" silhouette (real wood tones).
// Doubles as intercepted-supply wreckage (scaled down) at an ambush point.
function buildPropGeo() {
  const wood = 0x5c4327
  const wheelCol = 0x33291f
  const standing = new THREE.CylinderGeometry(0.2, 0.2, 0.06, 10)
  standing.rotateZ(Math.PI / 2)
  standing.translate(-0.28, 0.2, -0.28)
  const fallen = new THREE.CylinderGeometry(0.2, 0.2, 0.06, 10)
  fallen.translate(0.34, 0.03, 0.26)
  const geo = mergeParts([
    paintColor(box(0.5, 0.26, 0.8, 0, 0.28, 0), wood), // bed
    paintColor(box(0.05, 0.4, 0.06, 0.2, 0.46, 0.3), wood), // snapped plank
    paintColor(standing, wheelCol),
    paintColor(fallen, wheelCol),
  ])
  geo.rotateZ(0.28) // list to one side as if collapsed
  return geo
}

// A flat influence disc for the territory overlay: same +Y-normal disc as the
// scorch, but with a baked per-vertex `aRim` soft-ring alpha profile (0 at the
// centre so a settlement's own footprint stays clear — covenant "around, not
// on" — peaking at ~0.55R, back to 0 at the rim so patches blend softly).
function buildTerritoryGeo() {
  const g = new THREE.CircleGeometry(1, 28)
  g.rotateX(-Math.PI / 2)
  const pos = g.attributes.position
  const n = pos.count
  const rim = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const x = pos.getX(i)
    const z = pos.getZ(i)
    const r = Math.min(1, Math.hypot(x, z))
    rim[i] = smooth01(0.0, 0.55, r) * (1 - smooth01(0.55, 1.0, r))
  }
  g.setAttribute('aRim', new THREE.BufferAttribute(rim, 1))
  return g
}

// ---------------------------------------------------------------------------
// State reader — defensive wrapper over warSim.raidStateAt so a partial/absent
// reducer (warsim builds in parallel) degrades to a dormant raid instead of
// crashing (civrender.readState convention).
// ---------------------------------------------------------------------------
function readRaid(warSim, raid, clock, out) {
  if (warSim && typeof warSim.raidStateAt === 'function') {
    try {
      const s = warSim.raidStateAt(raid, clock, out)
      if (s) return s
    } catch {
      /* fall through to dormant default */
    }
  }
  out.phase = 'dormant'
  out.marchT = 0
  out.musterT = 0
  out.clashT = 0
  out.aftermathT = 0
  out.healFrac = 0
  out.atkAlive = 1
  out.defAlive = 1
  out.active = false
  out.outcome = raid && raid.outcome ? raid.outcome : 'repelled'
  return out
}

const hasDirs = (raid) =>
  isVec(raid.sourceDir) &&
  isVec(raid.musterDir) &&
  isVec(raid.battlefieldDir) &&
  isVec(raid.defenseDir) &&
  isVec(raid.targetDir)

// Ring slots for a siege (warsim R3 provides raid.ringDirs — Vector3[] or
// [{dir,forward}]). Normalized to a uniform {dir,forward?} shape.
function ringSlots(raid) {
  const arr = Array.isArray(raid && raid.ringDirs) ? raid.ringDirs : []
  const out = []
  for (const e of arr) {
    if (isVec(e)) out.push({ dir: e, forward: null })
    else if (e && isVec(e.dir)) out.push({ dir: e.dir, forward: isVec(e.forward) ? e.forward : null })
  }
  return out
}

const bannerLen = (raid) => (Array.isArray(raid && raid.bannerDirs) ? raid.bannerDirs.length : 0)
const scorchLen = (raid) => (Array.isArray(raid && raid.scorchDirs) ? raid.scorchDirs.length : 0)
const propMainLen = (raid) => (Array.isArray(raid && raid.propDirs) ? raid.propDirs.length : 0)
const propSupplyLen = (raid) => (Array.isArray(raid && raid.supplyProps) ? raid.supplyProps.length : 0)

// A dir that warsim has ALREADY covenant-clearance-tested — for the treaty peace
// banner, so a reconciliation mark never lands on an unverified spot. Never
// falls back to a raw midpoint (which warsim never cleared).
function covenantClearPoint(raid) {
  if (isVec(raid.battlefieldDir)) return raid.battlefieldDir
  if (Array.isArray(raid.bannerDirs)) {
    for (const b of raid.bannerDirs) {
      const d = isVec(b) ? b : b && b.dir
      if (isVec(d)) return d
    }
  }
  if (Array.isArray(raid.ringDirs)) {
    for (const r of raid.ringDirs) {
      const d = isVec(r) ? r : r && r.dir
      if (isVec(d)) return d
    }
  }
  if (isVec(raid.musterDir)) return raid.musterDir
  return null
}

// ---------------------------------------------------------------------------
// createWarRender
// ---------------------------------------------------------------------------
export function createWarRender(planet, warSim, seed) {
  const group = new THREE.Group()
  const timeUniforms = [] // every animated material's time uniform, written each frame

  // Read warSim.raids FRESH each call — rung-2/3 raids are appended at runtime
  // by warSim.ingest(); the layer must pick them up.
  const rawRaids = () => (warSim && Array.isArray(warSim.raids) ? warSim.raids : [])
  const initialRaids = rawRaids().filter(Boolean)

  // isRaider(projectOrSettlement) — optional in warsim; falls back to a heuristic.
  const isRaiderKnown = warSim && typeof warSim.isRaider === 'function'
  function isRaiderOf(x) {
    if (isRaiderKnown && x != null) {
      try {
        return !!warSim.isRaider(x)
      } catch {
        /* ignore */
      }
    }
    return false
  }

  // Ground radius for a mark/unit — never below sea so a dir whose sampleHeight
  // returns seafloor still plants on the surface, not in the abyss.
  const groundRadius = (dir) => Math.max(planet.sampleHeight(dir), SEA_LEVEL)

  // --- resolve per-raid formation slots (rung-1 field armies) ----------------
  // Slots come from warsim; if a raid omits them we synthesize a deterministic
  // fallback stream so the layer still plays (pure projection stays robust).
  function resolveSlots(raid, side) {
    const given = side === 'atk' ? raid.attackerSlots : raid.defenderSlots
    if (Array.isArray(given) && given.length) return given
    const count = clamp(Math.round(num(side === 'atk' ? raid.atkCount : raid.defCount, 8)), 0, 40)
    const rng = rngFromString(seed + ':warrender:' + (raid.id || 'raid') + ':' + side)
    const out = []
    for (let i = 0; i < count; i++) out.push({ bearing: rng() * TAU, dist: 0.004 + rng() * 0.01, fallAt: rng() })
    return out
  }

  // Per-raid slot geometry (kind-aware): a siege's "attackers" are its ring
  // besiegers; every other kind is a field army.
  function raidSlots(raid) {
    if (raidKind(raid) === 'siege') return { atk: ringSlots(raid), def: [] }
    return { atk: resolveSlots(raid, 'atk'), def: resolveSlots(raid, 'def') }
  }

  // ---- (0) rung-1 region layout: TIGHT per-raid ranges, computed ONCE, exactly
  // as the shipped rung-1 layer packed them. The rung-1 raids occupy instance
  // indices [0, iW/iB/iS/iP) and are never re-packed → byte-identical rung-1
  // rendering. Dynamic (rung-2/3) raids live in fixed-size blocks AFTER this.
  const initLayout = []
  let iW = 0
  let iB = 0
  let iS = 0
  let iP = 0
  for (const raid of initialRaids) {
    const slots = raidSlots(raid)
    const propMain = propMainLen(raid)
    const propSupply = propSupplyLen(raid)
    const L = {
      raid,
      id: raid.id,
      kind: raidKind(raid),
      permanent: true,
      atkSlots: slots.atk,
      defSlots: slots.def,
      atkCount: slots.atk.length,
      defCount: slots.def.length,
      bannerCount: bannerLen(raid),
      scorchCount: scorchLen(raid),
      propMain,
      propSupply,
      propCount: propMain + propSupply,
      atkBase: iW,
      defBase: iW + slots.atk.length,
      bannerBase: iB,
      scorchBase: iS,
      propBase: iP,
    }
    initLayout.push(L)
    iW += L.atkCount + L.defCount
    iB += L.bannerCount
    iS += L.scorchCount
    iP += L.propCount
  }

  // Total capacities = rung-1 tight region + fixed dynamic pool.
  const warriorCap = Math.max(1, iW + DYN_SLOTS * PER_RAID_WARRIORS)
  const bannerCap = Math.max(1, iB + DYN_SLOTS * PER_RAID_BANNERS)
  const scorchCap = Math.max(1, iS + DYN_SLOTS * PER_RAID_SCORCH)
  const propCap = Math.max(1, iP + DYN_SLOTS * PER_RAID_PROPS)
  const territoryCap = TERRITORY_SLOTS

  if (initialRaids.length === 0 && !warnedNoRaids) {
    warnedNoRaids = true
    console.warn('[planet] warrender.js: no seeded raids — the war layer idles until data-driven raids arrive')
  }

  // Pre-allocated live-unit position buffer for ember spawning (built once, no
  // per-frame allocation). Sized to the whole army capacity.
  const liveBuf = []
  for (let i = 0; i < warriorCap; i++) liveBuf.push(new THREE.Vector3())

  // ---- (1) warriors -------------------------------------------------------
  const wFactionBuf = new THREE.InstancedBufferAttribute(new Float32Array(warriorCap), 1)
  const wFallBuf = new THREE.InstancedBufferAttribute(new Float32Array(warriorCap), 1)
  wFactionBuf.setUsage(THREE.DynamicDrawUsage)
  wFallBuf.setUsage(THREE.DynamicDrawUsage)
  const warriorGeo = buildWarriorGeo()
  warriorGeo.setAttribute('aFaction', wFactionBuf)
  warriorGeo.setAttribute('aFall', wFallBuf)

  const warriorMat = new THREE.MeshStandardNodeMaterial({ flatShading: true, roughness: 0.82, metalness: 0.03 })
  {
    const vcol = attribute('color', 'vec3')
    const aFaction = attribute('aFaction', 'float')
    const aFall = attribute('aFall', 'float')
    const tint = mix(vcolOf(REALM_TINT), vcolOf(RAIDER_TINT), aFaction)
    // Subtle grounding AO: darken the lower body a touch (uses positionGeometry).
    const yf = positionGeometry.y.clamp(0, 1)
    const aoNode = smoothstep(0, 0.4, yf).mul(0.3).add(0.7)
    const body = tint.mul(vcol).mul(aoNode)
    warriorMat.colorNode = mix(body, vec3(FALLEN_GREY.r, FALLEN_GREY.g, FALLEN_GREY.b), aFall.mul(0.7))
  }
  const warriorMesh = new THREE.InstancedMesh(warriorGeo, warriorMat, warriorCap)

  // ---- (2) banners --------------------------------------------------------
  // aFaction tint + aHeal fade (rung 1) + aPeace (rung 3): a treaty banner mixes
  // the faction tint toward neutral gold. aPeace defaults 0 for every rung-1
  // banner ⇒ mix(...,0) is a no-op ⇒ rung-1 banners render identically.
  const bFactionBuf = new THREE.InstancedBufferAttribute(new Float32Array(bannerCap), 1)
  const bHealBuf = new THREE.InstancedBufferAttribute(new Float32Array(bannerCap), 1)
  const bPeaceBuf = new THREE.InstancedBufferAttribute(new Float32Array(bannerCap), 1)
  bFactionBuf.setUsage(THREE.DynamicDrawUsage)
  bHealBuf.setUsage(THREE.DynamicDrawUsage)
  bPeaceBuf.setUsage(THREE.DynamicDrawUsage)
  const bannerGeo = buildBannerGeo()
  bannerGeo.setAttribute('aFaction', bFactionBuf)
  bannerGeo.setAttribute('aHeal', bHealBuf)
  bannerGeo.setAttribute('aPeace', bPeaceBuf)

  const bannerMat = new THREE.MeshStandardNodeMaterial({
    flatShading: true,
    roughness: 0.85,
    metalness: 0.02,
    side: THREE.DoubleSide,
  })
  {
    const vcol = attribute('color', 'vec3')
    const aFaction = attribute('aFaction', 'float')
    const aHeal = attribute('aHeal', 'float')
    const aPeace = attribute('aPeace', 'float')
    const factionTint = mix(vcolOf(REALM_TINT), vcolOf(RAIDER_TINT), aFaction)
    const tint = mix(factionTint, vcolOf(PEACE_GOLD), aPeace) // aPeace=0 (rung-1) ⇒ factionTint
    const lit = tint.mul(vcol)
    bannerMat.colorNode = mix(lit, vcolOf(GROUND_TONE), aHeal.mul(0.6)) // fade toward ground as it heals
  }
  const bannerMesh = new THREE.InstancedMesh(bannerGeo, bannerMat, bannerCap)

  // ---- (3) scorch ---------------------------------------------------------
  const sHealBuf = new THREE.InstancedBufferAttribute(new Float32Array(scorchCap), 1)
  sHealBuf.setUsage(THREE.DynamicDrawUsage)
  const scorchGeo = buildScorchGeo()
  scorchGeo.setAttribute('aHeal', sHealBuf)

  const scorchMat = new THREE.MeshStandardNodeMaterial({
    flatShading: true,
    roughness: 0.95,
    metalness: 0.0,
    side: THREE.DoubleSide,
  })
  {
    const uTime = uniform(0)
    timeUniforms.push(uTime)
    const aHeal = attribute('aHeal', 'float')
    const base = mix(vcolOf(SCORCH_DARK), vcolOf(GROUND_TONE), aHeal)
    // A faint warm smolder while unhealed, gently flickering (the one animated
    // color in this layer — the S1 uniform-driven pulse). Torches carry the
    // real glow; this just keeps the char from reading dead.
    const flicker = sin(uTime.mul(4.0)).mul(0.1).add(0.16)
    const smolder = vcolOf(TORCH_WARM).mul(smoothstep(0, 0.7, aHeal).oneMinus()).mul(flicker)
    scorchMat.colorNode = base.add(smolder)
  }
  const scorchMesh = new THREE.InstancedMesh(scorchGeo, scorchMat, scorchCap)

  // ---- (4) props ----------------------------------------------------------
  const propMat = new THREE.MeshStandardNodeMaterial({
    vertexColors: true,
    flatShading: true,
    roughness: 0.9,
    metalness: 0.02,
  })
  const propMesh = new THREE.InstancedMesh(buildPropGeo(), propMat, propCap)

  // Common instanced-mesh setup + a degenerate init so no slot ever flashes as
  // a giant identity-matrix instance at the planet center before first place.
  for (const m of [warriorMesh, bannerMesh, scorchMesh, propMesh]) {
    m.count = m.instanceMatrix.count
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    m.frustumCulled = false
    m.visible = false
    _mat4.makeScale(0, 0, 0)
    for (let i = 0; i < m.count; i++) m.setMatrixAt(i, _mat4)
    m.instanceMatrix.needsUpdate = true
    group.add(m)
  }

  // ---- (5) territory / influence overlay (rung 2, +1 draw call) -----------
  // Translucent additive faction-tinted discs draped on the ground at rival
  // cluster anchors (+ contested battlefield midpoints). Unlit (a flat wash,
  // sun-independent). Opacity = per-vertex soft ring × per-instance conflict
  // intensity × a uTime ebb × a peak alpha — so it breathes and, when the map
  // is at peace, drops to zero and the whole mesh hides (never a permanent
  // stain). depthWrite:false + renderOrder:-1 ⇒ drawn under the armies.
  const terrFactionBuf = new THREE.InstancedBufferAttribute(new Float32Array(territoryCap), 1)
  const terrIntensityBuf = new THREE.InstancedBufferAttribute(new Float32Array(territoryCap), 1)
  terrFactionBuf.setUsage(THREE.DynamicDrawUsage)
  terrIntensityBuf.setUsage(THREE.DynamicDrawUsage)
  const territoryGeo = buildTerritoryGeo()
  territoryGeo.setAttribute('aFaction', terrFactionBuf)
  territoryGeo.setAttribute('aIntensity', terrIntensityBuf)

  const territoryMat = new THREE.MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
    side: THREE.DoubleSide,
  })
  {
    const uTime = uniform(0)
    timeUniforms.push(uTime)
    const aRim = attribute('aRim', 'float')
    const aFaction = attribute('aFaction', 'float')
    const aIntensity = attribute('aIntensity', 'float')
    territoryMat.colorNode = mix(vcolOf(REALM_TINT), vcolOf(RAIDER_TINT), aFaction)
    const ebb = sin(uTime.mul(TERRITORY_EBB)).mul(0.2).add(0.8)
    territoryMat.opacityNode = aRim.mul(aIntensity).mul(ebb).mul(TERRITORY_ALPHA)
  }
  const territoryMesh = new THREE.InstancedMesh(territoryGeo, territoryMat, territoryCap)
  territoryMesh.count = territoryCap
  territoryMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  territoryMesh.frustumCulled = false
  territoryMesh.visible = false
  territoryMesh.renderOrder = -1
  _mat4.makeScale(0, 0, 0)
  for (let i = 0; i < territoryCap; i++) territoryMesh.setMatrixAt(i, _mat4)
  territoryMesh.instanceMatrix.needsUpdate = true
  group.add(territoryMesh)

  const territoryNodes = [] // { dir, faction(0 realm / 0.5 contested / 1 raider), radiusMul }
  const territoryByRaid = new Map() // raid.id -> [nodeIndex]
  const nodeHeat = new Float32Array(territoryCap)
  let lastTerrMax = 0

  // ---- (6) torch / ember Points pool (events.js firework-pool clone) -------
  // Parallel typed arrays, round-robin cursor, additive Points, TTL fade. This
  // is the ONE place Math.random is allowed — ephemeral spectacle, never read
  // back into sim/mark/schedule state.
  const fwPositions = new Float32Array(TORCH_POOL * 3)
  const fwColors = new Float32Array(TORCH_POOL * 3) // displayed (faded) color
  const fwBase = new Float32Array(TORCH_POOL * 3) // un-faded color
  const fwVel = new Float32Array(TORCH_POOL * 3)
  const fwGrav = new Float32Array(TORCH_POOL * 3) // unit dir pulled toward the planet center
  const fwAge = new Float32Array(TORCH_POOL)
  const fwTtl = new Float32Array(TORCH_POOL) // 0 = free/dead slot
  let fwCursor = 0

  const fwGeo = new THREE.BufferGeometry()
  fwGeo.setAttribute('position', new THREE.BufferAttribute(fwPositions, 3))
  fwGeo.setAttribute('color', new THREE.BufferAttribute(fwColors, 3))
  const fwMat = new THREE.PointsMaterial({
    size: TORCH_SIZE,
    sizeAttenuation: false,
    vertexColors: true,
    transparent: true,
    opacity: 0.95,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  })
  const fwPoints = new THREE.Points(fwGeo, fwMat)
  fwPoints.frustumCulled = false
  fwPoints.visible = false
  group.add(fwPoints)

  const _warm = new THREE.Color(TORCH_WARM)
  function spawnEmber(pos) {
    const slot = fwCursor
    fwCursor = (fwCursor + 1) % TORCH_POOL
    const i3 = slot * 3
    _emberUp.copy(pos).normalize()
    fwPositions[i3] = pos.x + _emberUp.x * TORCH_HEIGHT
    fwPositions[i3 + 1] = pos.y + _emberUp.y * TORCH_HEIGHT
    fwPositions[i3 + 2] = pos.z + _emberUp.z * TORCH_HEIGHT
    const speed = TORCH_SPEED_MIN + Math.random() * (TORCH_SPEED_MAX - TORCH_SPEED_MIN)
    // Mostly rising, with a little sideways jitter.
    fwVel[i3] = _emberUp.x * speed + (Math.random() - 0.5) * speed * 0.7
    fwVel[i3 + 1] = _emberUp.y * speed + (Math.random() - 0.5) * speed * 0.7
    fwVel[i3 + 2] = _emberUp.z * speed + (Math.random() - 0.5) * speed * 0.7
    fwGrav[i3] = -_emberUp.x
    fwGrav[i3 + 1] = -_emberUp.y
    fwGrav[i3 + 2] = -_emberUp.z
    fwAge[slot] = 0
    fwTtl[slot] = TORCH_TTL * (1 - TORCH_TTL_JITTER / 2 + Math.random() * TORCH_TTL_JITTER)
    const b = 0.7 + Math.random() * 0.5 // per-ember brightness flicker
    fwBase[i3] = _warm.r * b
    fwBase[i3 + 1] = _warm.g * b
    fwBase[i3 + 2] = _warm.b * b
    fwColors[i3] = fwBase[i3]
    fwColors[i3 + 1] = fwBase[i3 + 1]
    fwColors[i3 + 2] = fwBase[i3 + 2]
  }

  function updateTorches(dt) {
    let any = false
    for (let slot = 0; slot < TORCH_POOL; slot++) {
      const t = fwTtl[slot]
      if (t <= 0) continue
      any = true
      const i3 = slot * 3
      const a = fwAge[slot] + dt
      if (a >= t) {
        fwTtl[slot] = 0
        fwColors[i3] = fwColors[i3 + 1] = fwColors[i3 + 2] = 0
        continue
      }
      fwAge[slot] = a
      fwVel[i3] += fwGrav[i3] * TORCH_GRAVITY * dt
      fwVel[i3 + 1] += fwGrav[i3 + 1] * TORCH_GRAVITY * dt
      fwVel[i3 + 2] += fwGrav[i3 + 2] * TORCH_GRAVITY * dt
      fwPositions[i3] += fwVel[i3] * dt
      fwPositions[i3 + 1] += fwVel[i3 + 1] * dt
      fwPositions[i3 + 2] += fwVel[i3 + 2] * dt
      const fade = 1 - a / t
      fwColors[i3] = fwBase[i3] * fade
      fwColors[i3 + 1] = fwBase[i3 + 1] * fade
      fwColors[i3 + 2] = fwBase[i3 + 2] * fade
    }
    if (any) {
      fwGeo.attributes.position.needsUpdate = true
      fwGeo.attributes.color.needsUpdate = true
    }
  }

  // ---- narrator (default no-op until wired to the herald) ------------------
  let narrator = () => {}
  function setNarrator(fn) {
    narrator = typeof fn === 'function' ? fn : () => {}
  }
  const lastPhase = new Map() // raid.id -> last observed phase (once-per-epoch outcome narration)
  const lastTreaty = new Map() // raid.id -> last observed treaty flag (once-per-treaty peace narration)

  // ---- dynamic-raid allocator ---------------------------------------------
  const alloc = new Map() // raid.id -> layout record
  const dynFree = [] // free dynamic-slot indices [0, DYN_SLOTS)
  for (let k = DYN_SLOTS - 1; k >= 0; k--) dynFree.push(k)
  let staticDirty = false // per-instance faction/peace attrs need re-upload
  let layoutSig = null

  // Seed the rung-1 region into the allocator and write its static attributes.
  for (const L of initLayout) {
    alloc.set(L.id, L)
    writeStaticAttrs(L)
  }

  function writeStaticAttrs(L) {
    const raiderBanner =
      L.kind === 'siege'
        ? true // besiegers fly raider colours
        : L.raid.winnerFaction
          ? L.raid.winnerFaction === 'raider'
          : L.raid.outcome === 'raided'
    for (let i = 0; i < L.atkCount; i++) wFactionBuf.array[L.atkBase + i] = 1
    for (let i = 0; i < L.defCount; i++) wFactionBuf.array[L.defBase + i] = 0
    for (let j = 0; j < L.bannerCount; j++) {
      bFactionBuf.array[L.bannerBase + j] = raiderBanner ? 1 : 0
      bPeaceBuf.array[L.bannerBase + j] = 0
    }
    staticDirty = true
  }

  function allocDynamic(raid) {
    if (alloc.has(raid.id)) return
    if (dynFree.length === 0) {
      if (!warnedDropRaid) {
        warnedDropRaid = true
        console.warn('[planet] warrender.js: dynamic-raid pool full — extra concurrent raid not rendered this cycle')
      }
      return
    }
    const k = dynFree.pop()
    const kind = raidKind(raid)
    const slots = raidSlots(raid)
    if (kind === 'siege' && slots.atk.length === 0 && !warnedNoRing) {
      warnedNoRing = true
      console.warn('[planet] warrender.js: siege has no covenant-clear ring (raid.ringDirs) — rendering marks only')
    }
    let atkCount = Math.min(slots.atk.length, PER_RAID_WARRIORS)
    let defCount = Math.min(slots.def.length, PER_RAID_WARRIORS - atkCount)
    const bannerCount = Math.min(Math.max(bannerLen(raid), 1), PER_RAID_BANNERS) // >=1 leaves a treaty-banner slot
    const scorchCount = Math.min(scorchLen(raid), PER_RAID_SCORCH)
    const propMain = Math.min(propMainLen(raid), PER_RAID_PROPS)
    const propSupply = Math.min(propSupplyLen(raid), PER_RAID_PROPS - propMain)
    const wBlk = iW + k * PER_RAID_WARRIORS
    const L = {
      raid,
      id: raid.id,
      kind,
      permanent: false,
      dynSlot: k,
      atkSlots: slots.atk,
      defSlots: slots.def,
      atkCount,
      defCount,
      bannerCount,
      scorchCount,
      propMain,
      propSupply,
      propCount: propMain + propSupply,
      atkBase: wBlk,
      defBase: wBlk + atkCount,
      bannerBase: iB + k * PER_RAID_BANNERS,
      scorchBase: iS + k * PER_RAID_SCORCH,
      propBase: iP + k * PER_RAID_PROPS,
    }
    alloc.set(raid.id, L)
    writeStaticAttrs(L)
  }

  function freeRaid(id, L) {
    for (let i = 0; i < L.atkCount; i++) {
      hideAt(warriorMesh, L.atkBase + i)
      wFactionBuf.array[L.atkBase + i] = 0
      wFallBuf.array[L.atkBase + i] = 0
    }
    for (let i = 0; i < L.defCount; i++) {
      hideAt(warriorMesh, L.defBase + i)
      wFactionBuf.array[L.defBase + i] = 0
      wFallBuf.array[L.defBase + i] = 0
    }
    for (let j = 0; j < L.bannerCount; j++) {
      hideAt(bannerMesh, L.bannerBase + j)
      bFactionBuf.array[L.bannerBase + j] = 0
      bPeaceBuf.array[L.bannerBase + j] = 0
      bHealBuf.array[L.bannerBase + j] = 0
    }
    for (let j = 0; j < L.scorchCount; j++) {
      hideAt(scorchMesh, L.scorchBase + j)
      sHealBuf.array[L.scorchBase + j] = 0
    }
    for (let j = 0; j < L.propCount; j++) hideAt(propMesh, L.propBase + j)
    if (typeof L.dynSlot === 'number') dynFree.push(L.dynSlot)
    alloc.delete(id)
    lastPhase.delete(id)
    lastTreaty.delete(id)
    staticDirty = true
  }

  // Reconcile the allocator + territory nodes with the CURRENT raid set. Cheap
  // no-op when the set is unchanged (the rung-1 offline case → the layout is
  // built exactly once, identical to the shipped rung-1 layer).
  function ensureLayout() {
    const raw = rawRaids()
    let sig = ''
    for (const r of raw) if (r && r.id) sig += r.id + '|'
    if (sig === layoutSig) return
    layoutSig = sig
    const present = new Set()
    for (const r of raw) {
      if (!r || !r.id) continue
      present.add(r.id)
      if (!alloc.has(r.id)) allocDynamic(r)
    }
    for (const [id, L] of alloc) {
      if (!L.permanent && !present.has(id)) freeRaid(id, L)
    }
    buildTerritoryNodes(raw)
    flushStaticAttrs()
  }

  function flushStaticAttrs() {
    if (!staticDirty) return
    wFactionBuf.needsUpdate = true
    wFallBuf.needsUpdate = true
    bFactionBuf.needsUpdate = true
    bPeaceBuf.needsUpdate = true
    bHealBuf.needsUpdate = true
    warriorMesh.instanceMatrix.needsUpdate = true
    bannerMesh.instanceMatrix.needsUpdate = true
    scorchMesh.instanceMatrix.needsUpdate = true
    propMesh.instanceMatrix.needsUpdate = true
    staticDirty = false
  }

  // ---- territory node derivation ------------------------------------------
  const keyDir = (d) => (Math.round(d.x * 100) | 0) + ',' + (Math.round(d.y * 100) | 0) + ',' + (Math.round(d.z * 100) | 0)
  // faction of a settlement record: raider(1)/realm(0) via warsim.isRaider when
  // available, else a positional default (source side raids, target defends).
  function factionOf(rec, dflt) {
    if (rec != null && isRaiderKnown) return isRaiderOf(rec) ? 1 : 0
    return dflt
  }

  function buildTerritoryNodes(raw) {
    territoryNodes.length = 0
    territoryByRaid.clear()
    const seen = new Map() // rounded-dir -> node index (dedup shared cluster anchors)
    const addNode = (dir, faction, radiusMul, raidId, dedup) => {
      if (!isVec(dir)) return
      let idx = -1
      const key = dedup ? keyDir(dir) : null
      if (dedup && seen.has(key)) idx = seen.get(key)
      if (idx < 0) {
        if (territoryNodes.length >= TERRITORY_SLOTS) return
        idx = territoryNodes.length
        territoryNodes.push({ dir: new THREE.Vector3(dir.x, dir.y, dir.z).normalize(), faction, radiusMul })
        if (dedup) seen.set(key, idx)
      }
      let arr = territoryByRaid.get(raidId)
      if (!arr) {
        arr = []
        territoryByRaid.set(raidId, arr)
      }
      if (arr.indexOf(idx) < 0) arr.push(idx)
    }
    for (const r of raw) {
      if (!r || !r.id) continue
      addNode(r.sourceDir, factionOf(r.raider, 1), 1, r.id, true) // raider cluster
      addNode(r.targetDir, factionOf(r.target, 0), 1, r.id, true) // realm cluster
      addNode(r.battlefieldDir, 0.5, 1.3, r.id, false) // contested borderland
    }
    for (let i = 0; i < territoryCap; i++) {
      if (i < territoryNodes.length) {
        const nd = territoryNodes[i]
        terrFactionBuf.array[i] = nd.faction
        _dummy.position.copy(nd.dir).multiplyScalar(groundRadius(nd.dir) + TERRITORY_LIFT)
        orientOnSurface(_dummy, nd.dir, anyForward(nd.dir, _fwd))
        _dummy.scale.setScalar(TERRITORY_ANGLE * nd.radiusMul)
        _dummy.updateMatrix()
        territoryMesh.setMatrixAt(i, _dummy.matrix)
      } else {
        terrFactionBuf.array[i] = 0
        terrIntensityBuf.array[i] = 0
        _mat4.makeScale(0, 0, 0)
        territoryMesh.setMatrixAt(i, _mat4)
      }
    }
    terrFactionBuf.needsUpdate = true
    terrIntensityBuf.needsUpdate = true
    territoryMesh.instanceMatrix.needsUpdate = true
  }

  // ---- treaty / narration helpers -----------------------------------------
  const treatyKnown = warSim && typeof warSim.treatyBetween === 'function'
  const projectOf = (s) => (s == null ? null : typeof s === 'string' ? s : s.project != null ? s.project : null)
  function treatyActive(raid) {
    if (!treatyKnown) return false
    const a = projectOf(raid.raider)
    const b = projectOf(raid.target)
    if (a == null || b == null) return false
    try {
      return !!warSim.treatyBetween(a, b)
    } catch {
      return false
    }
  }
  function peaceLine(raid) {
    for (const m of ['treatyLine', 'peaceLine']) {
      if (warSim && typeof warSim[m] === 'function') {
        try {
          const l = warSim[m](raid)
          if (l) return l
        } catch {
          /* ignore */
        }
      }
    }
    const a = (raid.raider && raid.raider.name) || 'the war-band'
    const b = (raid.target && raid.target.name) || 'the free peoples'
    return `A treaty is sealed — ${a} and ${b} lower their banners and the roads reopen`
  }
  function narrateFor(raid, st, kind, treaty) {
    const id = raid.id
    const prevTreaty = lastTreaty.get(id) || false
    if (treaty && !prevTreaty) narrator(peaceLine(raid))
    lastTreaty.set(id, treaty)
    const prev = lastPhase.get(id)
    lastPhase.set(id, st.phase)
    if (treaty) return // peace suppresses the battle outcome line
    const entered =
      kind === 'siege' ? st.phase === 'lift' && prev !== 'lift' : st.phase === 'aftermath' && prev !== 'aftermath'
    if (entered) {
      let line = ''
      try {
        if (typeof warSim.outcomeLine === 'function') line = warSim.outcomeLine(raid)
      } catch {
        line = ''
      }
      if (line) narrator(line)
    }
  }

  // ---- conflict "heat" driving the territory overlay ----------------------
  function raidHeat(kind, st) {
    const p = st.phase
    if (kind === 'siege') {
      if (p === 'approach' || p === 'encircle' || p === 'hold') return 1
      if (p === 'lift') return 0.6
      if (p === 'healed') return (1 - clamp(num(st.healFrac, 1), 0, 1)) * 0.3
      return 0
    }
    if (p === 'marching' || p === 'clashing') return 1
    if (p === 'aftermath') return 1 - clamp(num(st.aftermathT, 0), 0, 1) * 0.4
    if (p === 'healed') return (1 - clamp(num(st.healFrac, 1), 0, 1)) * 0.3
    return 0
  }
  function addNodeHeat(raidId, heat) {
    const arr = territoryByRaid.get(raidId)
    if (!arr) return
    for (const idx of arr) if (heat > nodeHeat[idx]) nodeHeat[idx] = heat
  }
  function writeTerritory() {
    let mx = 0
    for (let i = 0; i < territoryNodes.length; i++) {
      const h = nodeHeat[i]
      terrIntensityBuf.array[i] = h
      if (h > mx) mx = h
    }
    for (let i = territoryNodes.length; i < territoryCap; i++) terrIntensityBuf.array[i] = 0
    terrIntensityBuf.needsUpdate = true
    lastTerrMax = mx
  }

  // ---- placement helpers --------------------------------------------------
  let liveCount = 0 // living night-clashing unit positions collected this pass (for embers)

  function hideAt(mesh, idx) {
    _mat4.makeScale(0, 0, 0)
    mesh.setMatrixAt(idx, _mat4)
  }

  // Field army (rung 1 — UNCHANGED): source→muster→battlefield (attacker),
  // target→defense→battlefield (defender), interpolated by the clock.
  function placeArmy(L, st, isAtk, night) {
    const raid = L.raid
    const slots = isAtk ? L.atkSlots : L.defSlots
    const base = isAtk ? L.atkBase : L.defBase
    const n = isAtk ? L.atkCount : L.defCount
    const sideAlive = isAtk ? num(st.atkAlive, 1) : num(st.defAlive, 1)
    const marching = st.phase === 'marching'

    let center
    let enemyCenter
    if (isAtk) {
      center = marching
        ? slerpUnit(raid.sourceDir, raid.musterDir, ease(st.marchT), _center)
        : slerpUnit(raid.musterDir, raid.battlefieldDir, ease(st.clashT), _center)
      enemyCenter = marching
        ? slerpUnit(raid.targetDir, raid.defenseDir, ease(st.musterT), _enemy)
        : slerpUnit(raid.defenseDir, raid.battlefieldDir, ease(st.clashT), _enemy)
    } else {
      center = marching
        ? slerpUnit(raid.targetDir, raid.defenseDir, ease(st.musterT), _center)
        : slerpUnit(raid.defenseDir, raid.battlefieldDir, ease(st.clashT), _center)
      enemyCenter = marching
        ? slerpUnit(raid.sourceDir, raid.musterDir, ease(st.marchT), _enemy)
        : slerpUnit(raid.musterDir, raid.battlefieldDir, ease(st.clashT), _enemy)
    }

    const clashT = num(st.clashT, 0)
    for (let i = 0; i < n; i++) {
      const idx = base + i
      const slot = slots[i]
      const dir = offsetPoint(center, slot.bearing, slot.dist, _unitDir)
      const gR = groundRadius(dir)
      let fall = 0
      if (clashT > 0 && slot.fallAt <= clashT) fall = clamp((clashT - slot.fallAt) * 4, 0, 1) * (1 - sideAlive)
      wFallBuf.array[idx] = fall
      _dummy.position.copy(dir).multiplyScalar(gR + WARRIOR_LIFT)
      orientOnSurface(_dummy, dir, tangentToward(dir, enemyCenter, _fwd))
      if (fall > 0.001) _dummy.rotateX(fall * FALLEN_LEAN)
      _dummy.scale.setScalar(WARRIOR_SCALE)
      _dummy.updateMatrix()
      warriorMesh.setMatrixAt(idx, _dummy.matrix)
      if (night && !marching && fall < 0.5 && liveCount < liveBuf.length) liveBuf[liveCount++].copy(_dummy.position)
    }
  }

  // Rung-3 siege: besiegers ride the covenant-clear ring (raid.ringDirs), facing
  // inward toward the settlement; they slide in from the raider anchor as the
  // ring fills (present 0→1) and withdraw on 'lift' (present 1→0). They never
  // enter the footprint — every ring dir was clearance-tested by warsim.
  function placeSiege(L, sg, night) {
    const raid = L.raid
    const slots = L.atkSlots
    const base = L.atkBase
    const n = L.atkCount
    const target = raid.targetDir
    const from = isVec(raid.sourceDir) ? raid.sourceDir : null
    for (let i = 0; i < n; i++) {
      const idx = base + i
      const slot = slots[i]
      const ringDir = slot && slot.dir
      if (!isVec(ringDir) || sg.present < SIEGE_HIDE_PRESENT) {
        hideAt(warriorMesh, idx)
        wFallBuf.array[idx] = 0
        continue
      }
      const dir = from ? slerpUnit(from, ringDir, ease(sg.present), _unitDir) : _unitDir.copy(ringDir)
      const gR = groundRadius(dir)
      wFallBuf.array[idx] = 0
      _dummy.position.copy(dir).multiplyScalar(gR + WARRIOR_LIFT)
      const face = isVec(target)
        ? tangentToward(dir, target, _fwd)
        : slot.forward
          ? _fwd.copy(slot.forward)
          : anyForward(dir, _fwd)
      orientOnSurface(_dummy, dir, face)
      _dummy.scale.setScalar(WARRIOR_SCALE)
      _dummy.updateMatrix()
      warriorMesh.setMatrixAt(idx, _dummy.matrix)
      if (night && sg.holding && liveCount < liveBuf.length) liveBuf[liveCount++].copy(_dummy.position)
    }
  }

  function hideArmy(L) {
    for (let i = 0; i < L.atkCount; i++) {
      hideAt(warriorMesh, L.atkBase + i)
      wFallBuf.array[L.atkBase + i] = 0
    }
    for (let i = 0; i < L.defCount; i++) {
      hideAt(warriorMesh, L.defBase + i)
      wFallBuf.array[L.defBase + i] = 0
    }
  }

  // Banners. `treatyMode` repaints slot 0 as a neutral gold peace banner at the
  // (covenant-clear) battlefield midpoint and hides the rest.
  function placeBanners(L, st, show, treatyMode) {
    const raid = L.raid
    const heal = clamp(num(st.healFrac, 0), 0, 1)
    if (treatyMode) {
      const peaceDir = covenantClearPoint(raid) // warsim-cleared point only (never a raw midpoint)
      for (let j = 0; j < L.bannerCount; j++) {
        const idx = L.bannerBase + j
        if (j === 0 && isVec(peaceDir)) {
          bPeaceBuf.array[idx] = 1
          bHealBuf.array[idx] = 0
          _dummy.position.copy(peaceDir).multiplyScalar(groundRadius(peaceDir) + BANNER_LIFT)
          orientOnSurface(_dummy, peaceDir, anyForward(peaceDir, _fwd))
          _dummy.scale.setScalar(BANNER_SCALE * 1.15)
          _dummy.updateMatrix()
          bannerMesh.setMatrixAt(idx, _dummy.matrix)
        } else {
          hideAt(bannerMesh, idx)
          bPeaceBuf.array[idx] = 0
        }
      }
      return
    }
    const dirs = raid.bannerDirs || []
    for (let j = 0; j < L.bannerCount; j++) {
      const idx = L.bannerBase + j
      bPeaceBuf.array[idx] = 0 // reset a slot that may have carried a peace banner last cycle
      const bd = dirs[j]
      const bdDir = isVec(bd) ? bd : bd && bd.dir
      if (!show || !isVec(bdDir)) {
        hideAt(bannerMesh, idx)
        continue
      }
      const fwd = !isVec(bd) && bd && isVec(bd.forward) ? bd.forward : anyForward(bdDir, _fwd)
      bHealBuf.array[idx] = heal
      _dummy.position.copy(bdDir).multiplyScalar(groundRadius(bdDir) + BANNER_LIFT)
      orientOnSurface(_dummy, bdDir, fwd)
      _dummy.scale.setScalar(BANNER_SCALE * (1 - heal * 0.5)) // shrink out as it heals
      _dummy.updateMatrix()
      bannerMesh.setMatrixAt(idx, _dummy.matrix)
    }
  }

  function placeScorch(L, st, show) {
    const dirs = L.raid.scorchDirs || []
    const heal = clamp(num(st.healFrac, 0), 0, 1)
    for (let j = 0; j < L.scorchCount; j++) {
      const idx = L.scorchBase + j
      const d = dirs[j]
      if (!show || !isVec(d)) {
        hideAt(scorchMesh, idx)
        continue
      }
      sHealBuf.array[idx] = heal
      _dummy.position.copy(d).multiplyScalar(groundRadius(d) + SCORCH_LIFT)
      orientOnSurface(_dummy, d, anyForward(d, _fwd))
      _dummy.scale.setScalar(SCORCH_SCALE)
      _dummy.updateMatrix()
      scorchMesh.setMatrixAt(idx, _dummy.matrix)
    }
  }

  // Props: battlefield wrecks (raid.propDirs) at full scale, then intercepted-
  // supply wreckage (raid.supplyProps) at a smaller scale — all reusing the ONE
  // props mesh (no extra draw call).
  function placeProps(L, show) {
    const mainDirs = L.raid.propDirs || []
    const supplyDirs = L.raid.supplyProps || []
    for (let j = 0; j < L.propCount; j++) {
      const idx = L.propBase + j
      const isSupply = j >= L.propMain
      const d = isSupply ? supplyDirs[j - L.propMain] : mainDirs[j]
      if (!show || !isVec(d)) {
        hideAt(propMesh, idx)
        continue
      }
      _dummy.position.copy(d).multiplyScalar(groundRadius(d) + PROP_LIFT)
      orientOnSurface(_dummy, d, anyForward(d, _fwd))
      _dummy.scale.setScalar(isSupply ? SUPPLY_SCALE : PROP_SCALE)
      _dummy.updateMatrix()
      propMesh.setMatrixAt(idx, _dummy.matrix)
    }
  }

  // Normalize a siege reducer state (warsim R3) to ring presence + hold flag,
  // tolerating whatever subset of fields it exposes.
  function siegeState(st) {
    const phase = st.phase
    let present
    if (typeof st.ringOccupancy === 'number') present = clamp(st.ringOccupancy, 0, 1)
    else if (typeof st.present === 'number') present = clamp(st.present, 0, 1)
    else if (phase === 'approach') present = clamp(num(st.approachT, num(st.progress, 0.5)), 0, 1) * 0.7
    else if (phase === 'encircle') present = 0.6 + clamp(num(st.encircleT, num(st.progress, 1)), 0, 1) * 0.4
    else if (phase === 'hold') present = 1
    else if (phase === 'lift') present = 1 - clamp(num(st.liftT, num(st.progress, 0)), 0, 1)
    else present = 0
    const holding = phase === 'approach' || phase === 'encircle' || phase === 'hold' || phase === 'lift'
    return { phase, present, holding }
  }

  // A full placement pass across every raid. Runs every frame while any raid is
  // moving, else on the STATE_REFRESH throttle.
  let emberAccum = 0
  function placeAll(dt, sunDir) {
    ensureLayout()
    liveCount = 0
    nodeHeat.fill(0)

    const raw = rawRaids()
    for (const raid of raw) {
      if (!raid || !raid.id) continue
      const L = alloc.get(raid.id)
      if (!L) continue // dropped (dynamic pool full)
      const st = readRaid(warSim, raid, warClock, _st)
      const kind = L.kind
      const treaty = treatyActive(raid)

      narrateFor(raid, st, kind, treaty)
      addNodeHeat(raid.id, treaty ? 0 : raidHeat(kind, st))

      const night = !!(sunDir && isVec(raid.battlefieldDir) && sunDir.dot(raid.battlefieldDir) < NIGHT_DOT)

      if (treaty) {
        // Peace: withdraw the hostilities, plant a gold treaty banner, let the
        // scars heal away.
        hideArmy(L)
        placeBanners(L, st, true, true)
        placeScorch(L, st, false)
        placeProps(L, false)
        continue
      }

      if (kind === 'siege' && L.atkCount > 0) {
        const sg = siegeState(st)
        placeSiege(L, sg, night)
        const healed = st.phase === 'healed' && num(st.healFrac, 1) >= 1
        const marks = sg.phase !== 'dormant' && !healed
        placeBanners(L, st, marks, false)
        placeScorch(L, st, marks)
        placeProps(L, false)
      } else {
        // Field raid (rung-1 'raid', rung-2 'border'/'intercept', or a siege
        // that lacks a ring → degrades to a field skirmish).
        const dirsOk = hasDirs(raid)
        const unitsShow = dirsOk && (st.phase === 'marching' || st.phase === 'clashing')
        const markShow = st.phase === 'aftermath' || (st.phase === 'healed' && num(st.healFrac, 1) < 1)
        const propShow = st.phase === 'aftermath'
        if (unitsShow) {
          placeArmy(L, st, true, night)
          placeArmy(L, st, false, night)
        } else {
          hideArmy(L)
        }
        placeBanners(L, st, markShow, false)
        placeScorch(L, st, markShow)
        placeProps(L, propShow)
      }
    }

    writeTerritory()

    // Seed torch embers from the collected living night-clashing unit positions.
    if (liveCount > 0) {
      emberAccum += EMBER_RATE * dt
      let guard = 0
      while (emberAccum >= 1 && guard++ < TORCH_POOL) {
        emberAccum -= 1
        spawnEmber(liveBuf[(Math.random() * liveCount) | 0])
      }
    } else {
      emberAccum = 0
    }

    warriorMesh.instanceMatrix.needsUpdate = true
    wFallBuf.needsUpdate = true
    bannerMesh.instanceMatrix.needsUpdate = true
    bHealBuf.needsUpdate = true
    bPeaceBuf.needsUpdate = true
    scorchMesh.instanceMatrix.needsUpdate = true
    sHealBuf.needsUpdate = true
    propMesh.instanceMatrix.needsUpdate = true
  }

  // Flush the rung-1 region's static attributes written above (before the first
  // placeAll). Territory nodes for the rung-1 raids are built here too so the
  // signature starts settled.
  flushStaticAttrs()
  {
    let sig = ''
    for (const r of initialRaids) if (r && r.id) sig += r.id + '|'
    layoutSig = sig
    buildTerritoryNodes(initialRaids)
  }

  // ---- update loop --------------------------------------------------------
  let warClock = 0
  let sinceRefresh = STATE_REFRESH // force a refresh on the first near frame
  let wasNear = false
  let lastCount = -1

  function update(dt, camera, sunDir) {
    dt = num(dt, 0)
    warClock += dt // THE only clock — pure dt accumulation, no Date.now
    for (let i = 0; i < timeUniforms.length; i++) timeUniforms[i].value = warClock

    const validSun = sunDir && typeof sunDir.dot === 'function' ? sunDir : null
    const raw = rawRaids()
    const anyRaid = raw.length > 0
    const camDist = camera && camera.position ? camera.position.length() : 0
    const near = anyRaid && camDist < VISIBLE_DIST
    warriorMesh.visible = near
    bannerMesh.visible = near
    scorchMesh.visible = near
    propMesh.visible = near
    fwPoints.visible = near
    // Territory only draws while a conflict is actually contested (no stain).
    territoryMesh.visible = near && lastTerrMax > TERRITORY_VISIBLE_MIN
    if (!near) {
      wasNear = false
      return
    }

    sinceRefresh += dt
    // Force a per-frame rewrite while anything is moving (units interpolate);
    // otherwise throttle to STATE_REFRESH, always refresh the frame the camera
    // returns to view, and always refresh when the raid set changed (a new
    // data-driven raid must surface promptly).
    let moving = false
    for (const r of raw) {
      if (!r || !r.id) continue
      const st = readRaid(warSim, r, warClock, _peek)
      if (movingPhase(st.phase)) {
        moving = true
        break
      }
    }
    if (moving || sinceRefresh >= STATE_REFRESH || !wasNear || raw.length !== lastCount) {
      sinceRefresh = 0
      lastCount = raw.length
      placeAll(dt, validSun)
    }

    updateTorches(dt) // ephemeral pool always advances on near frames
    wasNear = true
  }

  return { group, update, setNarrator }
}

// TSL vec3 literal from a hex color in the working (linear) space — the exact
// civrender.js `_tmpColor.set(hex); vec3(r,g,b)` idiom.
function vcolOf(hex) {
  _c.set(hex)
  return vec3(_c.r, _c.g, _c.b)
}
