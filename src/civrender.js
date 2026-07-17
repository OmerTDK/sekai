// NPC-civilization RENDER layer (world-sim arc, see
// docs/design/worldsim-npc-civilizations.md §2.3/§3.2 "civrender.js"). Pure
// projection of the civsim DATA layer: it reads `civSim.civs` (seeded civ
// records) + `civSim.civStateAt(civ, simTime)` (the pure reducer) and draws
// each civilization's settlement as a cluster of low-poly structures in one
// of five DISTINCT visual archetypes — desert tents/adobe, seafaring docks,
// mountain stone holds, elven treehouses, steampunk brass towers — so a civ
// reads instantly by architecture silhouette + palette (spec §1).
//
// COVENANT: this module owns its own THREE.Group and never reads or writes
// world.js internals. It only *reads* planet queries + civ records; civ
// placement (avoiding session anchors) is civsim's job. It adds decorative
// meshes only — it cannot move or destroy a session structure.
//
// ENGINE: WebGPURenderer(forceWebGL) host — every material is a NodeMaterial
// from three/webgpu with TSL node graphs from three/tsl (no onBeforeCompile /
// ShaderMaterial anywhere). Node graphs are built ONCE at construction and
// animated only through uniform() writes (S1 build-once/uniforms-only law,
// docs/spikes/2026-07-17-s1-tsl-webgpu.md §6/§8). Per-instance weathering /
// hearth-warmth ride on instanced float attributes read in the colorNode.
//
// DRAW CALLS: one InstancedMesh per populated archetype (≤5) + one shared
// emissive "wonder beacon" InstancedMesh = ≤6 draw calls regardless of how
// many civilizations or structures exist. Civ count never multiplies draws
// (spec §2.3/§4). Distance-culled like flora's permanent props.
//
// DETERMINISM: every structural/cosmetic choice comes from an rngFromString
// seed stream keyed by civ id; sim time is accumulated from dt (no
// Math.random / Date.now in any placement or state read). The only allowed
// non-determinism is the shared real-time uniform driving the beacon pulse /
// window flicker — ephemeral visual phase, never world state.
//
// Contract (pinned): export function createCivRender(planet, civSim, seed) ->
// { group, update(dt, camera) }.
import * as THREE from 'three/webgpu'
import { attribute, positionGeometry, uniform, vec3, mix, sin, smoothstep } from 'three/tsl'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { SEA_LEVEL, rngFromString, clamp } from './util.js'

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------
const MAX_BUILD_HEIGHT = SEA_LEVEL + 0.03 // placement.js's build ceiling — buildings above this are dropped
const MAX_BUILDINGS_PER_CIV = 10 // instance-slot budget per civ; structureCount picks how many show
const GOLDEN_ANGLE = 2.399963229728653 // spiral-cluster bearing step, avoids ring artifacts
const CLUSTER_INNER = 0.0028 // rad — tightest structure offset from the civ anchor
const CLUSTER_STEP = 0.0026 // rad — spiral growth per sqrt(slot)
const SIM_YEARS_PER_SEC = 4 // sim clock rate this module runs its own projection at (tuning knob)
const STATE_REFRESH = 0.5 // s — throttle for re-reading civStateAt + rewriting matrices (spec §4)
const VISIBLE_DIST = 3.2 // R — beyond this the whole layer hides (matches flora PROP_VISIBLE_DIST)
const BUILDING_SINK = 0.0004 // sink the footprint slightly so it never floats over terrain

// Per-archetype world-space unit scale (structure "unit height" ~1 in local
// space × this lands in the ~0.006–0.02 world-height band world.js builds in).
const ARCH_UNIT = {
  desert: 0.011,
  seafaring: 0.012,
  mountain: 0.013,
  elven: 0.015,
  steampunk: 0.014,
}
const ARCH_ORDER = ['desert', 'seafaring', 'mountain', 'elven', 'steampunk']

// Weathering target: baked albedo lerps toward this desaturated stone-grey as
// ruinFrac rises (the "fallen to weathered ruins" look, spec §1).
const WEATHER_GREY = 0x6b6459

// Per-archetype warm "hearth" tint added into a mid-height window band of the
// colorNode for occupied/prosperous civs (lit-window warmth). Steampunk runs
// hotter (gear-forge glow); the shared beacon carries the true bloom.
const ARCH_HEARTH = {
  desert: { hex: 0xffb066, gain: 0.5 },
  seafaring: { hex: 0xffd6a0, gain: 0.45 },
  mountain: { hex: 0xff9a50, gain: 0.5 },
  elven: { hex: 0xcfe6a0, gain: 0.4 },
  steampunk: { hex: 0xff7a2a, gain: 0.75 },
}

// Beacon accent per archetype (brightened past the 1.0 bloom threshold in
// main.js's full-scene bloom pass so wonders/prosperous cities glow).
const ARCH_ACCENT = {
  desert: 0xffc64d,
  seafaring: 0x4fd0e0,
  mountain: 0xff8a3d,
  elven: 0x7dffa0,
  steampunk: 0xffa640,
}
const BEACON_BRIGHT = 1.9 // multiplier that pushes accent color over the bloom threshold

// ---------------------------------------------------------------------------
// Archetype-key normalization: civsim tags each civ with an archetype key (a
// string, or possibly the whole Archetype record). Map any reasonable spelling
// onto one of our five visual classes; unknown keys hash deterministically to
// a class so a civ always gets *some* distinct, stable archetype.
// ---------------------------------------------------------------------------
const CLASS_ALIASES = {
  desert: 'desert',
  'desert-nomad': 'desert',
  nomad: 'desert',
  adobe: 'desert',
  sand: 'desert',
  seafaring: 'seafaring',
  'seafaring-port': 'seafaring',
  port: 'seafaring',
  sea: 'seafaring',
  coastal: 'seafaring',
  harbor: 'seafaring',
  mountain: 'mountain',
  'mountain-hold': 'mountain',
  dwarven: 'mountain',
  dwarf: 'mountain',
  hold: 'mountain',
  monastery: 'mountain',
  cliff: 'mountain',
  stone: 'mountain',
  elven: 'elven',
  elf: 'elven',
  forest: 'elven',
  'elven-commune': 'elven',
  wood: 'elven',
  steampunk: 'steampunk',
  steam: 'steampunk',
  'steampunk-metropolis': 'steampunk',
  industrial: 'steampunk',
  brass: 'steampunk',
}

function archetypeKeyOf(civ) {
  const a = civ && civ.archetype
  if (a == null) return null
  if (typeof a === 'string') return a
  return a.key || a.name || null // civsim may hand us the whole record
}

function classOf(civ) {
  const raw = archetypeKeyOf(civ)
  if (raw) {
    const k = String(raw).toLowerCase()
    if (CLASS_ALIASES[k]) return CLASS_ALIASES[k]
    for (const alias in CLASS_ALIASES) {
      if (k.indexOf(alias) !== -1) return CLASS_ALIASES[alias]
    }
  }
  // Deterministic fallback so unknown archetypes still spread across classes.
  const idx = Math.floor(hashKey(String(raw || (civ && civ.id) || 'civ')) * ARCH_ORDER.length)
  return ARCH_ORDER[clamp(idx, 0, ARCH_ORDER.length - 1)]
}

function hashKey(s) {
  // Tiny inline string->[0,1) hash (xmur3 shape) — kept local so this module
  // needs no extra util import; only used for the unknown-archetype fallback.
  let h = 1779033703 ^ s.length
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 3432918353)
    h = (h << 13) | (h >>> 19)
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507)
  h = Math.imul(h ^ (h >>> 13), 3266489909)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

// ---------------------------------------------------------------------------
// Module-scope scratch (write-before-read only, never holds state across
// calls — flora.js/sealife.js convention; the sets update sequentially, not
// concurrently, so sharing is safe).
// ---------------------------------------------------------------------------
const REF_Y = new THREE.Vector3(0, 1, 0)
const REF_X = new THREE.Vector3(1, 0, 0)
const _t1 = new THREE.Vector3()
const _t2 = new THREE.Vector3()
const _up = new THREE.Vector3()
const _right = new THREE.Vector3()
const _fwd = new THREE.Vector3()
const _pos = new THREE.Vector3()
const _scale = new THREE.Vector3()
const _basis = new THREE.Matrix4()
const _quat = new THREE.Quaternion()
const _mat4 = new THREE.Matrix4()
const _dir = new THREE.Vector3()
const _obT1 = new THREE.Vector3()
const _obT2 = new THREE.Vector3()
const _paint = new THREE.Color()
const _tmpColor = new THREE.Color()

/** Writes into `out` the unit point `dist` radians from `base` along `bearing`. */
function offsetPoint(base, bearing, dist, out) {
  tangent(base, _obT1, _obT2)
  const cb = Math.cos(bearing)
  const sb = Math.sin(bearing)
  const tx = _obT1.x * cb + _obT2.x * sb
  const ty = _obT1.y * cb + _obT2.y * sb
  const tz = _obT1.z * cb + _obT2.z * sb
  const cd = Math.cos(dist)
  const sd = Math.sin(dist)
  return out.set(base.x * cd + tx * sd, base.y * cd + ty * sd, base.z * cd + tz * sd).normalize()
}

/** Arbitrary orthonormal tangent basis at `dir` (placement.js tangentBasis shape). */
function tangent(dir, outT1, outT2) {
  if (Math.abs(dir.y) < 0.999) outT1.set(0, 1, 0).cross(dir).normalize()
  else outT1.set(1, 0, 0).cross(dir).normalize()
  outT2.crossVectors(dir, outT1).normalize()
}

/**
 * Composes a "planted" instance matrix into `out`: origin lifted to `radius`
 * along `dir`, local +Y aligned to the surface normal `dir`, an optional small
 * tangent lean, a `yaw` twist, and a non-uniform scale. Copied from flora.js's
 * plantedMatrix so structures plant exactly like trees/rocks do.
 */
function plantedMatrix(out, dir, radius, yaw, tiltX, tiltZ, sx, sy, sz) {
  const ref = Math.abs(dir.y) > 0.95 ? REF_X : REF_Y
  _t1.crossVectors(ref, dir).normalize()
  _t2.crossVectors(dir, _t1).normalize()
  _up.copy(dir)
  if (tiltX !== 0 || tiltZ !== 0) {
    _up.addScaledVector(_t1, tiltX).addScaledVector(_t2, tiltZ).normalize()
    _t1.crossVectors(ref, _up).normalize()
    _t2.crossVectors(_up, _t1).normalize()
  }
  const cosY = Math.cos(yaw)
  const sinY = Math.sin(yaw)
  _right.set(_t1.x * cosY + _t2.x * sinY, _t1.y * cosY + _t2.y * sinY, _t1.z * cosY + _t2.z * sinY)
  _fwd.crossVectors(_right, _up).normalize()
  _right.crossVectors(_up, _fwd).normalize()
  _basis.makeBasis(_right, _up, _fwd)
  _quat.setFromRotationMatrix(_basis)
  _pos.copy(dir).multiplyScalar(radius)
  _scale.set(sx, sy, sz)
  out.compose(_pos, _quat, _scale)
}

// ---------------------------------------------------------------------------
// Geometry builders — one merged, vertex-colored, low-poly structure per
// archetype (flora.js paintFlatColor + mergeGeometries idiom). Local space is
// footprint ~1 wide, base at y=0; `unitHeight` is the silhouette top used by
// the colorNode window-band mask and returned to the caller.
// ---------------------------------------------------------------------------
let warnedMerge = false

function paintFlatColor(geo, hex) {
  _paint.set(hex)
  const n = geo.attributes.position.count
  const arr = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    arr[i * 3] = _paint.r
    arr[i * 3 + 1] = _paint.g
    arr[i * 3 + 2] = _paint.b
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3))
  return geo
}

/** box part, base-anchored, painted flat. */
function boxPart(cx, cy, cz, sx, sy, sz, hex, rot) {
  const g = new THREE.BoxGeometry(sx, sy, sz)
  if (rot) g.rotateY(rot)
  g.translate(cx, cy, cz)
  return paintFlatColor(g, hex)
}
function cylPart(cx, cy, cz, rTop, rBot, h, seg, hex) {
  const g = new THREE.CylinderGeometry(rTop, rBot, h, seg)
  g.translate(cx, cy, cz)
  return paintFlatColor(g, hex)
}
function conePart(cx, cy, cz, r, h, seg, hex) {
  const g = new THREE.ConeGeometry(r, h, seg)
  g.translate(cx, cy, cz)
  return paintFlatColor(g, hex)
}
function icoPart(cx, cy, cz, r, hex) {
  const g = new THREE.IcosahedronGeometry(r, 0)
  g.translate(cx, cy, cz)
  return paintFlatColor(g, hex)
}

function mergeParts(parts) {
  const nonIndexed = parts.map((g) => (g.index ? g.toNonIndexed() : g))
  const merged = mergeGeometries(nonIndexed, false)
  if (!merged && !warnedMerge) {
    warnedMerge = true
    console.warn(
      '[planet] civrender.js: archetype geometry merge degraded — mergeGeometries failed, shipping first part only',
    )
  }
  const out = merged || nonIndexed[0]
  out.computeVertexNormals()
  return out
}

// Desert nomad — adobe cube + flat roof + a conical tent + a small dome.
function buildDesert() {
  const wall = 0xc9a26a
  const roof = 0x8f6a42
  const tent = 0xb5651d
  const dome = 0xd9b98a
  const dark = 0x5a422b
  const parts = [
    boxPart(-0.05, 0.19, 0, 0.5, 0.38, 0.46, wall),
    boxPart(-0.05, 0.4, 0, 0.56, 0.05, 0.52, roof),
    boxPart(-0.05, 0.16, 0.24, 0.12, 0.2, 0.03, dark), // door
    conePart(0.34, 0.24, -0.04, 0.26, 0.48, 8, tent), // tent
    cylPart(0.34, 0.01, -0.04, 0.02, 0.02, 0.02, 6, dark),
    icoPart(-0.02, 0.44, -0.02, 0.11, dome), // roof dome
  ]
  return { geo: mergeParts(parts), unitHeight: 0.5 }
}

// Seafaring port — stilt posts + plank platform + weathered dock house + mast/sail.
function buildSeafaring() {
  const wood = 0x8a6a45
  const plank = 0xa07b4c
  const teal = 0x3f6f74
  const roof = 0x2f5257
  const sail = 0xdcd6c2
  const posts = []
  for (const [px, pz] of [
    [-0.28, -0.24],
    [0.28, -0.24],
    [-0.28, 0.24],
    [0.28, 0.24],
  ]) {
    posts.push(cylPart(px, 0.08, pz, 0.03, 0.03, 0.16, 6, wood))
  }
  const parts = [
    ...posts,
    boxPart(0, 0.17, 0, 0.7, 0.04, 0.6, plank), // platform
    boxPart(-0.06, 0.36, 0, 0.42, 0.34, 0.4, teal), // house
    boxPart(-0.06, 0.55, 0, 0.02, 0.02, 0.02, roof),
    boxPart(-0.06, 0.55, 0.06, 0.46, 0.06, 0.46, roof, 0.0), // low roof cap
    cylPart(0.26, 0.5, 0.02, 0.012, 0.012, 0.66, 6, wood), // mast
    boxPart(0.32, 0.56, 0.02, 0.02, 0.34, 0.22, sail), // sail
  ]
  return { geo: mergeParts(parts), unitHeight: 0.66 }
}

// Mountain hold — chunky stone keep + crenellated round tower + slit windows.
function buildMountain() {
  const stone = 0x8a8274
  const dark = 0x54504a
  const roof = 0x45413c
  const parts = [
    boxPart(-0.08, 0.22, 0, 0.5, 0.44, 0.44, stone), // keep
    boxPart(-0.08, 0.16, 0.23, 0.1, 0.18, 0.03, dark), // gate
    // crenellations along the keep top
    boxPart(-0.24, 0.47, 0.19, 0.08, 0.08, 0.08, stone),
    boxPart(0.08, 0.47, 0.19, 0.08, 0.08, 0.08, stone),
    boxPart(-0.24, 0.47, -0.19, 0.08, 0.08, 0.08, stone),
    boxPart(0.08, 0.47, -0.19, 0.08, 0.08, 0.08, stone),
    cylPart(0.26, 0.34, -0.02, 0.16, 0.18, 0.68, 8, stone), // round tower
    conePart(0.26, 0.74, -0.02, 0.2, 0.16, 8, roof),
    boxPart(0.26, 0.4, 0.16, 0.03, 0.14, 0.05, dark), // tower slit
  ]
  return { geo: mergeParts(parts), unitHeight: 0.82 }
}

// Elven treehouse — slender trunk + elevated pod house + layered canopy.
function buildElven() {
  const trunk = 0x5a4632
  const house = 0xd7cba6
  const leafLo = 0x4f8f5a
  const leafHi = 0x6fae74
  const parts = [
    cylPart(0, 0.34, 0, 0.05, 0.09, 0.68, 6, trunk), // trunk
    boxPart(0, 0.62, 0, 0.34, 0.2, 0.3, house), // pod house
    boxPart(0, 0.5, 0.16, 0.24, 0.02, 0.24, trunk), // platform floor
    conePart(0, 0.82, 0, 0.24, 0.18, 6, leafHi), // roof leaf
    icoPart(-0.02, 1.0, -0.02, 0.28, leafLo), // canopy low
    icoPart(0.04, 1.18, 0.02, 0.2, leafHi), // canopy high
  ]
  return { geo: mergeParts(parts), unitHeight: 1.3 }
}

// Steampunk brass tower — cylindrical brass tower + gear vent + pipes + capped chimney.
function buildSteampunk() {
  const brass = 0xb98a3c
  const copper = 0x9c6b3a
  const iron = 0x4a4640
  const gear = 0xc9a24a
  const parts = [
    cylPart(0, 0.06, 0, 0.34, 0.36, 0.12, 10, iron), // base ring
    cylPart(0, 0.42, 0, 0.24, 0.3, 0.6, 10, brass), // tower
    cylPart(0, 0.74, 0, 0.28, 0.24, 0.06, 10, copper), // rim
    cylPart(0, 0.8, 0, 0.16, 0.16, 0.06, 8, gear), // gear disk (flat cog)
    cylPart(0.28, 0.5, -0.06, 0.04, 0.04, 0.5, 6, copper), // pipe
    cylPart(-0.26, 0.4, 0.08, 0.035, 0.035, 0.4, 6, copper), // pipe
    cylPart(0.16, 0.9, -0.1, 0.06, 0.07, 0.34, 6, iron), // chimney
    cylPart(0.16, 1.08, -0.1, 0.09, 0.06, 0.05, 6, copper), // chimney cap
  ]
  return { geo: mergeParts(parts), unitHeight: 1.1 }
}

const ARCH_BUILDERS = {
  desert: buildDesert,
  seafaring: buildSeafaring,
  mountain: buildMountain,
  elven: buildElven,
  steampunk: buildSteampunk,
}

// ---------------------------------------------------------------------------
// State reader — defensive wrapper over civSim.civStateAt so a partial/absent
// reducer (civsim builds in parallel) degrades gracefully instead of crashing.
// ---------------------------------------------------------------------------
const PHASE_COUNT = { unfounded: 0, hamlet: 3, town: 6, city: 10, ruins: 4, resettled: 7, prime: 10 }

function readState(civSim, civ, simTime, out) {
  let s = null
  if (civSim && typeof civSim.civStateAt === 'function') {
    try {
      s = civSim.civStateAt(civ, simTime)
    } catch {
      s = null
    }
  }
  s = s || {}
  const phase = typeof s.phase === 'string' ? s.phase : 'town'
  const ruin = clamp(s.ruinFrac != null ? s.ruinFrac : phase === 'ruins' ? 1 : 0, 0, 1)
  const prosperity = clamp(s.prosperity != null ? s.prosperity : 0.5, 0, 1)
  let count = s.structureCount != null ? s.structureCount : PHASE_COUNT[phase]
  if (count == null) count = 6
  out.phase = phase
  out.ruin = ruin
  out.prosperity = prosperity
  out.count = clamp(Math.round(count), 0, MAX_BUILDINGS_PER_CIV)
  out.hasWonder = !!s.hasWonder
  out.founded = phase !== 'unfounded'
}

// ---------------------------------------------------------------------------
// createCivRender
// ---------------------------------------------------------------------------
export function createCivRender(planet, civSim, seed) {
  const group = new THREE.Group()
  const timeUniforms = [] // every material's real-time uniform, written each frame
  const civs = civSim && Array.isArray(civSim.civs) ? civSim.civs : []

  // Resolve a civ's anchor direction + ground radius (accept whatever civsim
  // provides; recompute groundR if absent).
  function anchorOf(civ) {
    const a = civ.anchorDir
    const dir = new THREE.Vector3()
    if (a && typeof a.x === 'number') dir.set(a.x, a.y, a.z)
    else dir.set(0, 1, 0)
    dir.normalize()
    const gr = typeof civ.groundR === 'number' ? civ.groundR : planet.sampleHeight(dir)
    return { dir, groundR: gr }
  }

  // --- classify civs into visual archetype classes -------------------------
  const byClass = {}
  for (const key of ARCH_ORDER) byClass[key] = []
  for (const civ of civs) {
    if (!civ) continue
    byClass[classOf(civ)].push(civ)
  }

  // --- build one instanced set per populated archetype ---------------------
  const sets = []
  for (const key of ARCH_ORDER) {
    const list = byClass[key]
    if (list.length > 0) sets.push(buildArchetypeSet(key, list))
  }

  // --- shared wonder-beacon set across all civs ----------------------------
  const beacon = civs.length > 0 ? buildBeaconSet(civs) : null

  // ---- archetype set ------------------------------------------------------
  function buildArchetypeSet(key, list) {
    const { geo, unitHeight } = ARCH_BUILDERS[key]()
    const capacity = list.length * MAX_BUILDINGS_PER_CIV

    const aRuinBuf = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1)
    const aWarmBuf = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1)
    aRuinBuf.setUsage(THREE.DynamicDrawUsage)
    aWarmBuf.setUsage(THREE.DynamicDrawUsage)
    geo.setAttribute('aRuin', aRuinBuf)
    geo.setAttribute('aWarm', aWarmBuf)

    const material = new THREE.MeshStandardNodeMaterial({
      flatShading: true,
      roughness: key === 'steampunk' ? 0.55 : 0.9,
      metalness: key === 'steampunk' ? 0.35 : 0.03,
    })
    // TSL colorNode (built ONCE, animated only via uTime): baked vertex albedo
    // weathered toward grey by the per-instance ruin fraction, plus a warm
    // hearth tint added into a mid-height window band for occupied civs.
    const uTime = uniform(0)
    timeUniforms.push(uTime)
    const vColor = attribute('color', 'vec3')
    const aRuin = attribute('aRuin', 'float')
    const aWarm = attribute('aWarm', 'float')
    _tmpColor.set(WEATHER_GREY)
    const grey = vec3(_tmpColor.r, _tmpColor.g, _tmpColor.b)
    const weathered = mix(vColor, grey, aRuin.mul(0.75))
    const hearth = ARCH_HEARTH[key]
    _tmpColor.set(hearth.hex)
    const warmCol = vec3(_tmpColor.r, _tmpColor.g, _tmpColor.b)
    const yFrac = positionGeometry.y.div(unitHeight).clamp(0, 1)
    const band = smoothstep(0.04, 0.28, yFrac).mul(smoothstep(0.32, 0.68, yFrac).oneMinus())
    const flicker = sin(uTime.mul(2.6).add(aWarm.mul(6.2832)))
      .mul(0.1)
      .add(0.9)
    const warmAdd = warmCol.mul(aWarm).mul(band).mul(flicker).mul(hearth.gain)
    material.colorNode = weathered.add(warmAdd)

    const mesh = new THREE.InstancedMesh(geo, material, capacity)
    mesh.count = capacity
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    mesh.frustumCulled = false // instances span the globe; a single bounding sphere would pop
    mesh.visible = false
    group.add(mesh)

    // Precompute each civ's deterministic building layout ONCE (spiral cluster
    // around the anchor; per-slot bearing/dist/yaw/tilt/size + a land check).
    const worldUnit = ARCH_UNIT[key]
    const civRecords = list.map((civ, ci) => {
      const { dir: anchor, groundR } = anchorOf(civ)
      const rng = rngFromString(seed + ':civrender:' + (civ.id || key + ci))
      const slots = []
      for (let b = 0; b < MAX_BUILDINGS_PER_CIV; b++) {
        const dist = CLUSTER_INNER + CLUSTER_STEP * Math.sqrt(b) * (0.7 + rng() * 0.6)
        const bearing = b * GOLDEN_ANGLE + rng() * 0.5
        const bdir = offsetPoint(anchor, bearing, dist, new THREE.Vector3())
        const valid = planet.isLand(bdir) && planet.sampleHeight(bdir) < MAX_BUILD_HEIGHT
        const gr = valid ? planet.sampleHeight(bdir) : groundR
        const tiltMag = rng() * 0.05
        const tiltAng = rng() * Math.PI * 2
        slots.push({
          dir: bdir,
          groundR: gr,
          yaw: rng() * Math.PI * 2,
          tiltX: Math.cos(tiltAng) * tiltMag,
          tiltZ: Math.sin(tiltAng) * tiltMag,
          size: b === 0 ? 1.25 : 0.7 + rng() * 0.5, // slot 0 = the civ's core/keep
          valid,
        })
      }
      return { civ, base: ci * MAX_BUILDINGS_PER_CIV, slots }
    })

    // Rewrite matrices + per-instance attributes for this set from current
    // civ states. Throttled by the caller; O(total buildings), no allocation.
    const st = {}
    function refresh(simTime) {
      for (let r = 0; r < civRecords.length; r++) {
        const rec = civRecords[r]
        readState(civSim, rec.civ, simTime, st)
        const civScale = 0.82 + 0.32 * st.prosperity
        const warm = st.founded ? clamp(st.prosperity * (1 - st.ruin * 0.85), 0, 1) : 0
        const active = st.founded ? st.count : 0
        for (let b = 0; b < MAX_BUILDINGS_PER_CIV; b++) {
          const idx = rec.base + b
          const slot = rec.slots[b]
          const show = slot.valid && b < active
          if (!show) {
            _mat4.makeScale(0, 0, 0) // degenerate: transformed away, no fragments
            mesh.setMatrixAt(idx, _mat4)
            aWarmBuf.array[idx] = 0
            aRuinBuf.array[idx] = 0
            continue
          }
          // Ruined structures squat + sink slightly (collapsed silhouette).
          const yScale = 1 - st.ruin * 0.5
          const s = worldUnit * slot.size * civScale
          const radius = slot.groundR - BUILDING_SINK - st.ruin * 0.001
          plantedMatrix(_mat4, slot.dir, radius, slot.yaw, slot.tiltX, slot.tiltZ, s, s * yScale, s)
          mesh.setMatrixAt(idx, _mat4)
          aRuinBuf.array[idx] = st.ruin
          aWarmBuf.array[idx] = warm
        }
      }
      mesh.instanceMatrix.needsUpdate = true
      aRuinBuf.needsUpdate = true
      aWarmBuf.needsUpdate = true
    }

    return { mesh, refresh }
  }

  // ---- beacon set ---------------------------------------------------------
  // One glowing orb per civ, floated above the settlement center; scaled up
  // only for civs that earn it (a wonder, or a prosperous city). MeshBasic
  // node material with a per-instance bright accent color pushed over the
  // bloom threshold + a per-instance-phased gentle pulse.
  function buildBeaconSet(list) {
    const geo = new THREE.IcosahedronGeometry(1, 0)
    const capacity = list.length
    const bcolBuf = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3)
    const bphaseBuf = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1)
    geo.setAttribute('bcol', bcolBuf)
    geo.setAttribute('bphase', bphaseBuf)

    const material = new THREE.MeshBasicNodeMaterial({ toneMapped: false })
    const uTime = uniform(0)
    timeUniforms.push(uTime)
    const bcol = attribute('bcol', 'vec3')
    const bphase = attribute('bphase', 'float')
    const pulse = sin(uTime.mul(1.6).add(bphase)).mul(0.18).add(0.82)
    material.colorNode = bcol.mul(pulse)

    const mesh = new THREE.InstancedMesh(geo, material, capacity)
    mesh.count = capacity
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    mesh.frustumCulled = false
    mesh.visible = false
    group.add(mesh)

    const records = list.map((civ, ci) => {
      const { dir, groundR } = anchorOf(civ)
      const accent = ARCH_ACCENT[classOf(civ)]
      _tmpColor.set(accent)
      bcolBuf.array[ci * 3] = _tmpColor.r * BEACON_BRIGHT
      bcolBuf.array[ci * 3 + 1] = _tmpColor.g * BEACON_BRIGHT
      bcolBuf.array[ci * 3 + 2] = _tmpColor.b * BEACON_BRIGHT
      bphaseBuf.array[ci] = hashKey(String(civ.id || ci) + '~beacon') * Math.PI * 2
      return { civ, dir, groundR }
    })
    bcolBuf.needsUpdate = true
    bphaseBuf.needsUpdate = true

    const st = {}
    function refresh(simTime) {
      for (let r = 0; r < records.length; r++) {
        const rec = records[r]
        readState(civSim, rec.civ, simTime, st)
        const glow = st.founded && (st.hasWonder || st.prosperity > 0.62)
        if (!glow) {
          _mat4.makeScale(0, 0, 0)
        } else {
          const s = 0.0032 + (st.hasWonder ? 0.0016 : 0) + 0.0016 * st.prosperity
          plantedMatrix(_mat4, rec.dir, rec.groundR + 0.02, 0, 0, 0, s, s, s)
        }
        mesh.setMatrixAt(r, _mat4)
      }
      mesh.instanceMatrix.needsUpdate = true
    }

    return { mesh, refresh }
  }

  // ---- update loop --------------------------------------------------------
  let simTime = 0
  let realTime = 0
  let sinceRefresh = STATE_REFRESH // force a refresh on the first near frame
  let wasNear = false

  function update(dt, camera) {
    // Deterministic sim clock: pure accumulation from dt (no Date.now).
    simTime += dt * SIM_YEARS_PER_SEC
    realTime += dt
    for (let i = 0; i < timeUniforms.length; i++) timeUniforms[i].value = realTime

    const camDist = camera && camera.position ? camera.position.length() : 0
    const near = camDist < VISIBLE_DIST
    for (let i = 0; i < sets.length; i++) sets[i].mesh.visible = near
    if (beacon) beacon.mesh.visible = near
    if (!near) {
      wasNear = false
      return
    }

    sinceRefresh += dt
    // Re-read civStateAt + rewrite matrices on the throttle, or immediately on
    // the frame the camera first comes back into view (so nothing is stale).
    if (sinceRefresh >= STATE_REFRESH || !wasNear) {
      sinceRefresh = 0
      for (let i = 0; i < sets.length; i++) sets[i].refresh(simTime)
      if (beacon) beacon.refresh(simTime)
    }
    wasNear = true
  }

  return { group, update }
}
