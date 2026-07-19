// E-SIM conflict-ladder RENDER layer (rung 1) — see
// docs/design/epilogue-e-sim.md §"R1-2 warrender.js". A pure projection of the
// warsim.js DATA layer: it reads `warSim.raids` (seeded raid records) and
// `warSim.raidStateAt(raid, warClock, out)` (the pure reducer) and draws each
// raid as instanced armies marching → mustering → clashing on an on-land
// battlefield, then the aftermath marks (winner banners, ground scorch,
// ruins-props) that heal completely over the epoch, plus a night-torch ember
// pool among the clashing units.
//
// THE COVENANT: this module owns its own THREE.Group added ALONGSIDE (never
// inside) world.group; it never reads or writes world.js internals and never
// holds a mutable reference to a session mesh. Every army position and every
// mark (banner/scorch/prop) is a pure function of the war clock — warsim has
// already covenant-clearance-tested every dir against the session anchors +
// structure dirs, so this layer only READS planet.sampleHeight and paints.
// Because raidStateAt(raid, clock) is idempotent over EPOCH, the marks heal
// automatically and totally: scorch/banners fade + degenerate-scale to nothing
// and props vanish at epoch end, returning the world bit-for-bit to its
// pre-raid visual state. Session structures are never moved, recolored, scaled
// or hidden by any path in here.
//
// ENGINE: WebGPURenderer(forceWebGL) host — every material is a *NodeMaterial
// from three/webgpu with a TSL node graph built ONCE at construction and
// animated only through uniform() writes (S1 build-once/uniforms-only law).
// Per-instance variation rides on custom instanced float attributes read in
// the colorNode (aFaction/aFall/aHeal) — the exact civrender.js aRuin/aWarm
// pattern, proven on the WebGL2 default host. Inactive instances hide via a
// degenerate makeScale(0,0,0) (WebGPU-safe). frustumCulled=false everywhere
// (instances span the globe).
//
// DRAW-CALL BUDGET = 5, independent of raid count: (1) warriors InstancedMesh
// + (2) banners + (3) scorch + (4) props + (5) torch Points.
//
// DETERMINISM: the sole time source is warClock, accumulated from dt in
// update(); raidStateAt(raid, warClock) is a pure function of it, so a reload
// with a fixed ?seed replays identically. The ONE place Math.random is allowed
// is the ephemeral torch/ember Points pool (never read back into sim state —
// the same exemption events.js's firework pool ships under). No Date.now.
//
// Contract (pinned): export function createWarRender(planet, warSim, seed) ->
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

const WARRIOR_LIFT = 0.0004 // world units above sampleHeight (foot clearance)
const BANNER_LIFT = 0.0004
const SCORCH_LIFT = 0.0005 // sit a hair above the ground so the decal never z-fights terrain
const PROP_LIFT = 0.0004

const FALLEN_LEAN = 1.25 // rad — a fully-fallen unit tips this far forward before greying out

const NIGHT_DOT = 0.1 // sunDir·battlefieldDir below this ⇒ the battlefield is in night (torches lit)

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

// Faction + mark palette.
const REALM_TINT = 0x3b5c8c // banner-blue (RACE_PALETTES.human)
const RAIDER_TINT = 0x6d7346 // orc drab-olive (RACE_PALETTES.orc cloth×accent), reads distinct from realm blue
const FALLEN_GREY = { r: 0.18, g: 0.16, b: 0.14 } // fallen units grey toward this
const SCORCH_DARK = 0x241d16 // burnt-earth char
const GROUND_TONE = 0x6b6459 // neutral earth tone the scorch lerps back to as it heals
const TORCH_WARM = 0xff7a2a // ember color

const TAU = Math.PI * 2

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

// ---------------------------------------------------------------------------
// createWarRender
// ---------------------------------------------------------------------------
export function createWarRender(planet, warSim, seed) {
  const group = new THREE.Group()
  const timeUniforms = [] // every animated material's time uniform, written each frame
  const raids = warSim && Array.isArray(warSim.raids) ? warSim.raids.filter(Boolean) : []

  // Ground radius for a mark/unit — never below sea so a dir whose sampleHeight
  // returns seafloor still plants on the surface, not in the abyss.
  const groundRadius = (dir) => Math.max(planet.sampleHeight(dir), SEA_LEVEL)

  // --- resolve per-raid formation slots + assign packed instance ranges ------
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

  const layout = []
  for (const raid of raids) {
    const atkSlots = resolveSlots(raid, 'atk')
    const defSlots = resolveSlots(raid, 'def')
    layout.push({
      raid,
      atkSlots,
      defSlots,
      atkCount: atkSlots.length,
      defCount: defSlots.length,
      bannerCount: Array.isArray(raid.bannerDirs) ? raid.bannerDirs.length : 0,
      scorchCount: Array.isArray(raid.scorchDirs) ? raid.scorchDirs.length : 0,
      propCount: Array.isArray(raid.propDirs) ? raid.propDirs.length : 0,
      atkBase: 0,
      defBase: 0,
      bannerBase: 0,
      scorchBase: 0,
      propBase: 0,
    })
  }
  let wN = 0
  let bN = 0
  let sN = 0
  let pN = 0
  for (const L of layout) {
    L.atkBase = wN
    wN += L.atkCount
    L.defBase = wN
    wN += L.defCount
    L.bannerBase = bN
    bN += L.bannerCount
    L.scorchBase = sN
    sN += L.scorchCount
    L.propBase = pN
    pN += L.propCount
  }
  const warriorCap = Math.max(1, wN)
  const bannerCap = Math.max(1, bN)
  const scorchCap = Math.max(1, sN)
  const propCap = Math.max(1, pN)

  const enabled = layout.length > 0 && wN > 0
  if (!enabled && !warnedNoRaids) {
    warnedNoRaids = true
    console.warn('[planet] warrender.js: no raids to render — the war layer is idle this session')
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
  const bFactionBuf = new THREE.InstancedBufferAttribute(new Float32Array(bannerCap), 1)
  const bHealBuf = new THREE.InstancedBufferAttribute(new Float32Array(bannerCap), 1)
  bFactionBuf.setUsage(THREE.DynamicDrawUsage)
  bHealBuf.setUsage(THREE.DynamicDrawUsage)
  const bannerGeo = buildBannerGeo()
  bannerGeo.setAttribute('aFaction', bFactionBuf)
  bannerGeo.setAttribute('aHeal', bHealBuf)

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
    const tint = mix(vcolOf(REALM_TINT), vcolOf(RAIDER_TINT), aFaction)
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

  // Static per-instance faction: warriors (0=defender,1=attacker), banners
  // (winner side). Written once — these never change over an epoch.
  for (const L of layout) {
    for (let i = 0; i < L.atkCount; i++) wFactionBuf.array[L.atkBase + i] = 1
    for (let i = 0; i < L.defCount; i++) wFactionBuf.array[L.defBase + i] = 0
    const raiderWon = L.raid.winnerFaction ? L.raid.winnerFaction === 'raider' : L.raid.outcome === 'raided'
    for (let j = 0; j < L.bannerCount; j++) bFactionBuf.array[L.bannerBase + j] = raiderWon ? 1 : 0
  }
  wFactionBuf.needsUpdate = true
  bFactionBuf.needsUpdate = true

  // ---- (5) torch / ember Points pool (events.js firework-pool clone) -------
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
  const lastPhase = new Map() // raid.id -> last observed phase, for the once-per-epoch aftermath narration

  // ---- placement helpers --------------------------------------------------
  let liveCount = 0 // living night-clashing unit positions collected this pass (for embers)

  function hideAt(mesh, idx) {
    _mat4.makeScale(0, 0, 0)
    mesh.setMatrixAt(idx, _mat4)
  }

  function placeArmy(L, st, isAtk, night) {
    const raid = L.raid
    const slots = isAtk ? L.atkSlots : L.defSlots
    const base = isAtk ? L.atkBase : L.defBase
    const n = isAtk ? L.atkCount : L.defCount
    const sideAlive = isAtk ? num(st.atkAlive, 1) : num(st.defAlive, 1)
    const marching = st.phase === 'marching'

    // Formation center + the enemy center it faces, interpolated by the clock.
    // Attackers: source→muster (march), muster→battlefield (clash).
    // Defenders: target→defense (muster), defense→battlefield (clash).
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
      // Fallen fraction: a unit whose fallAt has passed tips + greys, scaled by
      // how far its side has lost (loser side falls harder).
      let fall = 0
      if (clashT > 0 && slot.fallAt <= clashT) fall = clamp((clashT - slot.fallAt) * 4, 0, 1) * (1 - sideAlive)
      wFallBuf.array[idx] = fall
      _dummy.position.copy(dir).multiplyScalar(gR + WARRIOR_LIFT)
      orientOnSurface(_dummy, dir, tangentToward(dir, enemyCenter, _fwd))
      if (fall > 0.001) _dummy.rotateX(fall * FALLEN_LEAN)
      _dummy.scale.setScalar(WARRIOR_SCALE)
      _dummy.updateMatrix()
      warriorMesh.setMatrixAt(idx, _dummy.matrix)
      // Living units at night during the clash seed the torch embers.
      if (night && !marching && fall < 0.5 && liveCount < liveBuf.length) liveBuf[liveCount++].copy(_dummy.position)
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

  function placeBanners(L, st, show) {
    const dirs = L.raid.bannerDirs || []
    const heal = clamp(num(st.healFrac, 0), 0, 1)
    for (let j = 0; j < L.bannerCount; j++) {
      const idx = L.bannerBase + j
      const bd = dirs[j]
      if (!show || !bd || !isVec(bd.dir)) {
        hideAt(bannerMesh, idx)
        continue
      }
      const dir = bd.dir
      const fwd = isVec(bd.forward) ? bd.forward : anyForward(dir, _fwd)
      bHealBuf.array[idx] = heal
      _dummy.position.copy(dir).multiplyScalar(groundRadius(dir) + BANNER_LIFT)
      orientOnSurface(_dummy, dir, fwd)
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

  function placeProps(L, show) {
    const dirs = L.raid.propDirs || []
    for (let j = 0; j < L.propCount; j++) {
      const idx = L.propBase + j
      const d = dirs[j]
      if (!show || !isVec(d)) {
        hideAt(propMesh, idx)
        continue
      }
      _dummy.position.copy(d).multiplyScalar(groundRadius(d) + PROP_LIFT)
      orientOnSurface(_dummy, d, anyForward(d, _fwd))
      _dummy.scale.setScalar(PROP_SCALE)
      _dummy.updateMatrix()
      propMesh.setMatrixAt(idx, _dummy.matrix)
    }
  }

  // A full placement pass across every raid. Runs every frame while any raid is
  // moving (marching/clashing), else on the STATE_REFRESH throttle.
  let emberAccum = 0
  function placeAll(dt, sunDir) {
    liveCount = 0
    for (const L of layout) {
      const raid = L.raid
      const st = readRaid(warSim, raid, warClock, _st)

      // Once-per-epoch: on the transition INTO aftermath, narrate the outcome.
      const prev = lastPhase.get(raid.id)
      if (st.phase === 'aftermath' && prev !== 'aftermath') {
        let line = ''
        try {
          if (typeof warSim.outcomeLine === 'function') line = warSim.outcomeLine(raid)
        } catch {
          line = ''
        }
        if (line) narrator(line)
      }
      lastPhase.set(raid.id, st.phase)

      const dirsOk = hasDirs(raid)
      const unitsShow = dirsOk && (st.phase === 'marching' || st.phase === 'clashing')
      // Marks span aftermath through the heal tail (which continues into the
      // 'healed' phase until healFrac completes), then degenerate away.
      const markShow = st.phase === 'aftermath' || (st.phase === 'healed' && num(st.healFrac, 1) < 1)
      const propShow = st.phase === 'aftermath'
      const night = !!(sunDir && isVec(raid.battlefieldDir) && sunDir.dot(raid.battlefieldDir) < NIGHT_DOT)

      if (unitsShow) {
        placeArmy(L, st, true, night)
        placeArmy(L, st, false, night)
      } else {
        hideArmy(L)
      }
      placeBanners(L, st, markShow)
      placeScorch(L, st, markShow)
      placeProps(L, propShow)
    }

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
    scorchMesh.instanceMatrix.needsUpdate = true
    sHealBuf.needsUpdate = true
    propMesh.instanceMatrix.needsUpdate = true
  }

  // ---- update loop --------------------------------------------------------
  let warClock = 0
  let sinceRefresh = STATE_REFRESH // force a refresh on the first near frame
  let wasNear = false

  function update(dt, camera, sunDir) {
    dt = num(dt, 0)
    warClock += dt // THE only clock — pure dt accumulation, no Date.now
    for (let i = 0; i < timeUniforms.length; i++) timeUniforms[i].value = warClock

    const validSun = sunDir && typeof sunDir.dot === 'function' ? sunDir : null
    const camDist = camera && camera.position ? camera.position.length() : 0
    const near = enabled && camDist < VISIBLE_DIST
    warriorMesh.visible = near
    bannerMesh.visible = near
    scorchMesh.visible = near
    propMesh.visible = near
    fwPoints.visible = near
    if (!near) {
      wasNear = false
      return
    }

    sinceRefresh += dt
    // Force a per-frame rewrite while anything is moving (units interpolate);
    // otherwise throttle to STATE_REFRESH, and always refresh the frame the
    // camera first comes back into view so nothing is stale.
    let moving = false
    for (const L of layout) {
      const st = readRaid(warSim, L.raid, warClock, _peek)
      if (st.phase === 'marching' || st.phase === 'clashing') {
        moving = true
        break
      }
    }
    if (moving || sinceRefresh >= STATE_REFRESH || !wasNear) {
      sinceRefresh = 0
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
