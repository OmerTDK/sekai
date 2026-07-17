// Sea life: whale pods (spout + breach) anchored in deep ocean, and coastal
// dolphin pods that porpoise along a slow drifting path (M-WX program plan
// item; art direction docs/ART.md — muted palette, nothing snaps, no
// unmotivated glow). Two low-poly creature species, each a single merged
// LatheGeometry-body + flat-triangle fin/fluke/dorsal geometry, driven by
// ONE InstancedMesh per species with per-frame instance-matrix root motion
// (no bones, no vertex shader — the same rigid-body-with-eased-pitch/roll
// technique dragon.js and airships.js already use for their own flight/
// cruise poses, just applied per-instance instead of to a scene-graph
// pivot). A single shared Points sprite pool (pattern-copied from world.js's
// steam-plume pool: normal blending, real per-vertex alpha via an RGBA color
// attribute, cursor-based ring-buffer allocation) covers spout puffs, breach
// splash rings, and dolphin entry blips — three different spawn PATTERNS
// into the same underlying arrays, never a fourth draw call.
//
// Contract (pinned): export function createSeaLife(planet, seed) ->
// { group, update(dt, camera) }. No `world` dependency — sea life doesn't
// need settlement data, only planet.isLand for anchor placement.
//
// Determinism: every random choice, structural or cosmetic, comes from a
// rngFromString seed stream (dragon.js's convention, the newest/strictest
// creature module in this codebase — no Math.random anywhere here). Each
// pod gets its own structural rng (anchor search, member count, per-member
// offsets); each individual whale/dolphin then keeps its OWN rng closure for
// its entire lifetime, reused every cycle for timing/breach-roll/particle
// jitter (mirrors dragon.js's single `rng` closure threaded through every
// state-machine timer).
//
// Height budget (ART.md / plan LAWS): nothing sits above SEA_LEVEL + 0.01
// except the brief breach excursion, which is the explicit exception.
// Verified by construction below (see the WHALE_SURFACE_PEAK_ALT /
// WHALE_DIVE_WAYPOINT_ALT comments) — the normal surfacing/diving cycle
// keeps its highest point (dorsal fin tip, worst case) a couple thousandths
// of a world unit above the cap's margin, never close to it.
import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { SEA_LEVEL, rngFromString, clamp, lerp, smoothstep } from './util.js'
import { tangentBasis } from './placement.js'

// ---------------------------------------------------------------------------
// Palette (ART.md: muted, never emissive/bloom-crossing). Two-tone
// countershading per species -- dark slate-blue topside blended down to a
// pale belly, painted as a per-vertex gradient on the body lathe; fins/
// dorsal/fluke get a flat tone close to the topside color.
// ---------------------------------------------------------------------------
const WHALE_TOP = 0x36424e
const WHALE_BELLY = 0xced4d1
const WHALE_FIN = 0x2b3540

const DOLPHIN_TOP = 0x4b5964
const DOLPHIN_BELLY = 0xe2e7e4
const DOLPHIN_FIN = 0x3c4750

// ---------------------------------------------------------------------------
// Scale. "Slightly heroic" per spec -- whales read clearly at ~1.4R zoom.
// ---------------------------------------------------------------------------
const WHALE_LENGTH_MIN = 0.012
const WHALE_LENGTH_MAX = 0.016
const DOLPHIN_LENGTH_MIN = 0.0036
const DOLPHIN_LENGTH_MAX = 0.0044

const RADIAL_SEGMENTS = 8 // low-poly faceted cross-section, matches the trunk cylinder's 6-8 range

// ---------------------------------------------------------------------------
// Pods.
// ---------------------------------------------------------------------------
const WHALE_POD_MIN = 3
const WHALE_POD_MAX = 5 // inclusive
const WHALE_PER_POD_MIN = 1
const WHALE_PER_POD_MAX = 3 // inclusive
const WHALE_DEEP_CLEARANCE = 0.06 // rad -- ring-probe radius for "no land nearby"
const WHALE_ANCHOR_RING_PROBES = 10
const WHALE_ANCHOR_TRIES = 1500
const WHALE_POD_SPREAD_MIN = 0.008 // rad -- per-whale offset from pod anchor
const WHALE_POD_SPREAD_MAX = 0.022 // stays comfortably inside WHALE_DEEP_CLEARANCE

const DOLPHIN_POD_MIN = 3
const DOLPHIN_POD_MAX = 4 // inclusive
const DOLPHIN_PER_POD_MIN = 4
const DOLPHIN_PER_POD_MAX = 7 // inclusive
const DOLPHIN_COAST_RADIUS = 0.03 // rad -- ring-probe radius for "land nearby"
const DOLPHIN_ANCHOR_RING_PROBES = 10
const DOLPHIN_ANCHOR_TRIES = 1500
const DOLPHIN_LATERAL_SPREAD = 0.01 // rad, perpendicular to heading -- pod width
const DOLPHIN_ALONG_SPREAD = 0.012 // rad, along heading -- pod stagger
const DOLPHIN_DRIFT_AMPLITUDE = 0.035 // rad -- bounded so the pod never drifts off its verified coastal anchor
const DOLPHIN_DRIFT_FREQ = 0.05 // rad/s -- one full out-and-back swim every ~125s, ambient pacing

// ---------------------------------------------------------------------------
// Whale cycle timings (seconds). Every phase is smoothstep-eased and every
// phase boundary hands off a continuous alt/pitch/roll value to the next
// (ART.md §7 "nothing snaps") -- see the per-phase comments below for the
// exact continuity chain.
// ---------------------------------------------------------------------------
const WHALE_SUBMERGED_MIN = 6
const WHALE_SUBMERGED_MAX = 15
const WHALE_RISE_DUR = 1.8
const WHALE_HOLD_DUR = 0.6
const WHALE_DIVE_ARC_DUR = 1.5
const WHALE_DIVE_SINK_DUR = 0.7
const WHALE_BREACH_CHANCE = 1 / 6
const WHALE_BREACH_RISE_DUR = 1.1
const WHALE_BREACH_APEX_DUR = 0.15
const WHALE_BREACH_FALL_DUR = 1.0

// Whale altitude (radial offset from SEA_LEVEL) / pitch (+ = nose down,
// axis-angle convention below) / roll (breach twist only).
const WHALE_SUBMERGED_DEPTH = -0.005 // center depth while hidden/faint-shadow
const WHALE_SUBMERGED_PITCH = 0.06 // gentle cruising nose-down while under
const WHALE_SURFACE_PEAK_ALT = 0.0018 // spine altitude at the surfacing hold
// Worst case (max length 0.016, widest cross-section r=0.115, dorsal fin
// local y ~0.165): peak alt + 0.165*0.016 = 0.0018 + 0.00264 = 0.0046 --
// comfortably under the SEA_LEVEL+0.01 cap outside of breach.
const WHALE_DIVE_WAYPOINT_ALT = -0.0015 // spine altitude at max dive pitch -- this is what lifts the fluke clear (see updateWhaleDiveArc)
const WHALE_DIVE_PITCH_MAX = 0.55
const WHALE_BREACH_APEX_ALT = 0.012 // explicit LAWS exception -- brief breach apex only
const WHALE_BREACH_PITCH_MAX = 0.9
const WHALE_BREACH_ROLL_MAX = 0.7
const WHALE_HOLD_BOB_AMP = 0.0003
const WHALE_HOLD_BOB_FREQ = 6 // rad/s

// Blowhole spawn point, local unit-body space (near-nose, topside) --
// derived once from WHALE_PROFILE below (see the comment at its use site).
const WHALE_BLOWHOLE_LOCAL = new THREE.Vector3(0, 0.076, 0.32)

// ---------------------------------------------------------------------------
// Dolphin cycle timings (seconds) -- simpler 3-phase porpoise loop, no
// breach/spout. Continuity chain: under(const) -> rise(lerp from under's
// const) -> fall(lerp back to under's const) -> under.
// ---------------------------------------------------------------------------
const DOLPHIN_UNDER_MIN = 0.5
const DOLPHIN_UNDER_MAX = 1.3
const DOLPHIN_RISE_DUR = 0.32
const DOLPHIN_FALL_DUR = 0.32
const DOLPHIN_UNDER_DEPTH = -0.0022
const DOLPHIN_UNDER_PITCH = 0.1
const DOLPHIN_PEAK_ALT = 0.0022

// ---------------------------------------------------------------------------
// Shared FX sprite pool (spout puffs, breach splash rings, porpoise entry
// blips) -- pattern-copied from world.js's steam-plume pool: normal
// blending (vapor/foam, not glow), real per-vertex alpha via an RGBA color
// attribute, cursor-based ring-buffer slot allocation.
// ---------------------------------------------------------------------------
const FX_POOL_SIZE = 240
const FX_SIZE = 6 // PointsMaterial size, screen-space (sizeAttenuation: false)
const FX_PEAK_ALPHA = 0.5
const FX_FADE_IN = 0.12

const SPOUT_PUFF_COUNT = 3
const SPOUT_PUFF_INTERVAL = 0.16
const SPOUT_TTL = 1.3
const SPOUT_RISE_SPEED = 0.018
const SPOUT_DRIFT_SPEED = 0.004
const SPOUT_JITTER = 0.0006

const SPLASH_RING_COUNT = 14
const SPLASH_RING_TTL = 0.8
const SPLASH_RING_SPEED = 0.05
const SPLASH_RING_RISE = 0.006

const BLIP_COUNT = 2
const BLIP_TTL = 0.4
const BLIP_SPEED = 0.012

const CAMERA_CULL_DIST = 2.5 // R -- beyond this, skip instance-matrix/FX work but keep state ticking

// ---------------------------------------------------------------------------
// Body profiles: [radius, heightFrac(0..1)] pairs, heightFrac 0 = tail tip,
// 1 = nose tip. Revolved into a LatheGeometry then reoriented so the length
// axis becomes local Z (nose at +Z, tail at -Z) -- see buildBodyGeometry.
// Both profiles start/end at radius 0 so the lathe closes to a point at
// both ends (no open-cap hole); at this world scale the "point" is a
// couple of world-millimeters, visually reads as a blunt tip, not sharp.
// ---------------------------------------------------------------------------
const WHALE_PROFILE = [
  [0.0, 0.0],
  [0.028, 0.05],
  [0.06, 0.14],
  [0.09, 0.26],
  [0.108, 0.4],
  [0.115, 0.52],
  [0.105, 0.64],
  [0.082, 0.76],
  [0.05, 0.88],
  [0.018, 0.97],
  [0.0, 1.0],
]
const WHALE_MAX_R = 0.115

const DOLPHIN_PROFILE = [
  [0.0, 0.0],
  [0.02, 0.06],
  [0.045, 0.16],
  [0.062, 0.3],
  [0.07, 0.46],
  [0.068, 0.58],
  [0.058, 0.68],
  [0.04, 0.8],
  [0.03, 0.88],
  [0.016, 0.94],
  [0.01, 0.98],
  [0.0, 1.0],
]
const DOLPHIN_MAX_R = 0.07

const WHALE_PHASE = {
  SUBMERGED: 'submerged',
  RISE: 'rise',
  HOLD: 'hold',
  DIVE_ARC: 'diveArc',
  DIVE_SINK: 'diveSink',
  BREACH_RISE: 'breachRise',
  BREACH_APEX: 'breachApex',
  BREACH_FALL: 'breachFall',
}

const DOLPHIN_PHASE = { UNDER: 'under', RISE: 'rise', FALL: 'fall' }

let warnedWhaleAnchor = false
let warnedDolphinAnchor = false
let warnedWhaleMerge = false
let warnedDolphinMerge = false

// ---------------------------------------------------------------------------
// Module-scope scratch (write-before-read only, never holds state across
// calls -- same convention as placement.js's _tb1/_tb2, airships.js's
// _dirScratch, etc.). Everything below is reused across whales, dolphins,
// and FX since those update sequentially, not concurrently (flora.js's own
// documented reasoning for sharing scratch across its grass/tree/rock
// builders applies identically here).
// ---------------------------------------------------------------------------
const _obT1 = new THREE.Vector3()
const _obT2 = new THREE.Vector3()
const _ringProbe = new THREE.Vector3()
const _basisRight = new THREE.Vector3()
const _basisFwd = new THREE.Vector3()
const _basisMat4 = new THREE.Matrix4()
const _pitchQuat = new THREE.Quaternion()
const _rollQuat = new THREE.Quaternion()
const _combinedQuat = new THREE.Quaternion()
const _instPos = new THREE.Vector3()
const _instScale = new THREE.Vector3()
const _instMat = new THREE.Matrix4()
const _worldPos = new THREE.Vector3()
const _localOffset = new THREE.Vector3()
const _fxPos = new THREE.Vector3()
const _fxPos0 = new THREE.Vector3()
const _fxVel = new THREE.Vector3()
const _podCenter = new THREE.Vector3()
const _podMoveDelta = new THREE.Vector3()
const _podFwd = new THREE.Vector3()
const _dolphinDirA = new THREE.Vector3()
const _scratchBaseQuat = new THREE.Quaternion()
const X_AXIS = new THREE.Vector3(1, 0, 0)
const Z_AXIS = new THREE.Vector3(0, 0, 1)

// ---------------------------------------------------------------------------
// Pure spherical-geometry helpers (duplicated locally from placement.js's
// private sphericalOffset / airships.js's own offsetPoint copy -- small
// write-before-read helpers are duplicated per-module in this codebase
// rather than exported, see airships.js's own comment on this).
// ---------------------------------------------------------------------------
function offsetPoint(base, bearing, dist, out) {
  tangentBasis(base, _obT1, _obT2)
  const cb = Math.cos(bearing)
  const sb = Math.sin(bearing)
  const tx = _obT1.x * cb + _obT2.x * sb
  const ty = _obT1.y * cb + _obT2.y * sb
  const tz = _obT1.z * cb + _obT2.z * sb
  const cd = Math.cos(dist)
  const sd = Math.sin(dist)
  return out.set(base.x * cd + tx * sd, base.y * cd + ty * sd, base.z * cd + tz * sd).normalize()
}

/** Deterministic, uniformly-distributed random unit vector. */
function randomUnitVector(rng, out) {
  const z = rng() * 2 - 1
  const t = rng() * Math.PI * 2
  const r = Math.sqrt(Math.max(0, 1 - z * z))
  return out.set(r * Math.cos(t), r * Math.sin(t), z)
}

/** True if `dir` and every point on a `radius`-ring around it are ocean. */
function ringAllOcean(planet, dir, radius, probes) {
  if (planet.isLand(dir)) return false
  for (let i = 0; i < probes; i++) {
    const a = (i / probes) * Math.PI * 2
    offsetPoint(dir, a, radius, _ringProbe)
    if (planet.isLand(_ringProbe)) return false
  }
  return true
}

/** True if `dir` is ocean but at least one point on a `radius`-ring around it is land. */
function nearCoast(planet, dir, radius, probes) {
  if (planet.isLand(dir)) return false
  for (let i = 0; i < probes; i++) {
    const a = (i / probes) * Math.PI * 2
    offsetPoint(dir, a, radius, _ringProbe)
    if (planet.isLand(_ringProbe)) return true
  }
  return false
}

function findDeepOceanAnchor(planet, rng) {
  const dir = new THREE.Vector3()
  for (let i = 0; i < WHALE_ANCHOR_TRIES; i++) {
    randomUnitVector(rng, dir)
    if (ringAllOcean(planet, dir, WHALE_DEEP_CLEARANCE, WHALE_ANCHOR_RING_PROBES)) return dir
  }
  if (!warnedWhaleAnchor) {
    warnedWhaleAnchor = true
    console.warn(
      '[planet] sealife.js: whale pod anchor search degraded — exhausted search budget, using best-effort location (may sit closer to land than the deep-ocean clearance wants)',
    )
  }
  return dir
}

function findCoastAnchor(planet, rng) {
  const dir = new THREE.Vector3()
  for (let i = 0; i < DOLPHIN_ANCHOR_TRIES; i++) {
    randomUnitVector(rng, dir)
    if (nearCoast(planet, dir, DOLPHIN_COAST_RADIUS, DOLPHIN_ANCHOR_RING_PROBES)) return dir
  }
  if (!warnedDolphinAnchor) {
    warnedDolphinAnchor = true
    console.warn(
      '[planet] sealife.js: dolphin pod anchor search degraded — exhausted search budget, using best-effort location (may not actually sit near a coastline)',
    )
  }
  return dir
}

// ---------------------------------------------------------------------------
// Geometry builders.
// ---------------------------------------------------------------------------

/** Linear-interpolated profile radius at local z (body space, z in [-0.5, 0.5]). */
function profileRadiusAt(profile, z) {
  const t = clamp(z + 0.5, 0, 1)
  for (let i = 0; i < profile.length - 1; i++) {
    const [r0, t0] = profile[i]
    const [r1, t1] = profile[i + 1]
    if (t >= t0 && t <= t1) {
      const f = t1 > t0 ? (t - t0) / (t1 - t0) : 0
      return r0 + (r1 - r0) * f
    }
  }
  return 0
}

function buildBodyGeometry(profile) {
  const pts = profile.map(([r, y]) => new THREE.Vector2(r, y))
  const geo = new THREE.LatheGeometry(pts, RADIAL_SEGMENTS)
  geo.translate(0, -0.5, 0) // center length-wise
  geo.rotateX(Math.PI / 2) // length axis Y -> Z, nose ends at +Z
  return geo
}

/** Paints a dorsal(top)->ventral(belly) vertex-color gradient from local Y. */
function paintGradient(geo, topHex, bellyHex, maxR) {
  const topC = new THREE.Color(topHex)
  const bellyC = new THREE.Color(bellyHex)
  const pos = geo.attributes.position
  const n = pos.count
  const arr = new Float32Array(n * 3)
  const blended = new THREE.Color()
  // Transition band shifted toward the belly (span anchored at y=-maxR,
  // reaching pure top color by y=+0.1*maxR) so the dark topside dominates
  // the profile and the pale belly reads as a narrower ventral strip --
  // matches real whale/dolphin countershading better than a 50/50 split.
  const span = maxR * 1.1
  for (let i = 0; i < n; i++) {
    const y = pos.getY(i)
    const blend = clamp((y + maxR) / span, 0, 1)
    blended.copy(bellyC).lerp(topC, blend)
    arr[i * 3] = blended.r
    arr[i * 3 + 1] = blended.g
    arr[i * 3 + 2] = blended.b
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3))
}

/** Paints a single flat color onto every vertex of `geo`. */
function paintFlat(geo, hex) {
  const c = new THREE.Color(hex)
  const n = geo.attributes.position.count
  const arr = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    arr[i * 3] = c.r
    arr[i * 3 + 1] = c.g
    arr[i * 3 + 2] = c.b
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3))
  return geo
}

/**
 * Flat double-sided triangular fin/fluke wedge: a swept blade from a root
 * chord (rootA/rootB, both plain [x,y,z] arrays) to a tip point. Relies on
 * the shared body material's THREE.DoubleSide so a zero-thickness triangle
 * never backface-culls away -- same trick birds.js uses for its own flat
 * wing triangles. A `uv` attribute is included purely so this geometry's
 * attribute set matches the Lathe body's for mergeGeometries (no texture
 * ever samples it).
 */
function buildFinTri(rootA, rootB, tip) {
  const geo = new THREE.BufferGeometry()
  const pos = new Float32Array([...rootA, ...rootB, ...tip])
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 0.5, 1]), 2))
  geo.setIndex([0, 1, 2])
  geo.computeVertexNormals()
  return geo
}

function mergeParts(parts, warnedFlag, warnFn) {
  const nonIndexed = parts.map((g) => (g.index ? g.toNonIndexed() : g))
  const merged = mergeGeometries(nonIndexed, false)
  if (!merged && !warnedFlag()) {
    warnFn()
  }
  return merged || parts[0]
}

function buildWhaleGeometry() {
  const body = buildBodyGeometry(WHALE_PROFILE)
  paintGradient(body, WHALE_TOP, WHALE_BELLY, WHALE_MAX_R)

  const dorsalZ = -0.06
  const dorsalR = profileRadiusAt(WHALE_PROFILE, dorsalZ)
  const dorsal = paintFlat(
    buildFinTri(
      [0, dorsalR * 0.98, dorsalZ + 0.035],
      [0, dorsalR * 0.98, dorsalZ - 0.035],
      [0, dorsalR + 0.055, dorsalZ - 0.05],
    ),
    WHALE_FIN,
  )

  const pecZ = 0.18
  const pecR = profileRadiusAt(WHALE_PROFILE, pecZ)
  const pecs = [-1, 1].map((s) =>
    paintFlat(
      buildFinTri(
        [s * pecR * 0.95, -pecR * 0.15, pecZ + 0.03],
        [s * pecR * 0.95, -pecR * 0.15, pecZ - 0.03],
        [s * (pecR + 0.09), -pecR * 0.35, pecZ - 0.06],
      ),
      WHALE_FIN,
    ),
  )

  const flukes = [-1, 1].map((s) =>
    paintFlat(buildFinTri([0, 0.01, -0.46], [s * 0.02, 0, -0.49], [s * 0.16, 0, -0.58]), WHALE_FIN),
  )

  const merged = mergeParts(
    [body, dorsal, ...pecs, ...flukes],
    () => warnedWhaleMerge,
    () => {
      warnedWhaleMerge = true
      console.warn(
        '[planet] sealife.js: whale geometry merge degraded — mergeGeometries failed, shipping body-only geometry (fins/fluke lost)',
      )
    },
  )
  merged.computeBoundingSphere()
  return merged
}

function buildDolphinGeometry() {
  const body = buildBodyGeometry(DOLPHIN_PROFILE)
  paintGradient(body, DOLPHIN_TOP, DOLPHIN_BELLY, DOLPHIN_MAX_R)

  const dorsalZ = 0.0
  const dorsalR = profileRadiusAt(DOLPHIN_PROFILE, dorsalZ)
  const dorsal = paintFlat(
    buildFinTri(
      [0, dorsalR * 0.98, dorsalZ + 0.025],
      [0, dorsalR * 0.98, dorsalZ - 0.025],
      [0, dorsalR + 0.045, dorsalZ - 0.035],
    ),
    DOLPHIN_FIN,
  )

  const pecZ = 0.15
  const pecR = profileRadiusAt(DOLPHIN_PROFILE, pecZ)
  const pecs = [-1, 1].map((s) =>
    paintFlat(
      buildFinTri(
        [s * pecR * 0.95, -pecR * 0.1, pecZ + 0.02],
        [s * pecR * 0.95, -pecR * 0.1, pecZ - 0.02],
        [s * (pecR + 0.05), -pecR * 0.25, pecZ - 0.04],
      ),
      DOLPHIN_FIN,
    ),
  )

  const flukes = [-1, 1].map((s) =>
    paintFlat(buildFinTri([0, 0.006, -0.44], [s * 0.012, 0, -0.49], [s * 0.095, 0, -0.56]), DOLPHIN_FIN),
  )

  const merged = mergeParts(
    [body, dorsal, ...pecs, ...flukes],
    () => warnedDolphinMerge,
    () => {
      warnedDolphinMerge = true
      console.warn(
        '[planet] sealife.js: dolphin geometry merge degraded — mergeGeometries failed, shipping body-only geometry (fins/fluke lost)',
      )
    },
  )
  merged.computeBoundingSphere()
  return merged
}

// ---------------------------------------------------------------------------
// Orientation compose: up = surface normal, forward re-orthogonalized
// against it (same idiom as placement.js's orientOnSurface / dragon.js's
// applyFlightOrientation), then pitch (axis-angle around local X, + = nose
// down) and roll (around local Z, breach twist only) layered on top, same
// composition order as dragon.js's own _baseQuat*_rollQuat*_pitchQuat.
// ---------------------------------------------------------------------------
function computeBaseQuat(outQuat, up, fwd) {
  _basisRight.crossVectors(up, fwd)
  if (_basisRight.lengthSq() < 1e-10) {
    tangentBasis(up, _basisRight, _basisFwd)
  } else {
    _basisRight.normalize()
    _basisFwd.crossVectors(_basisRight, up).normalize()
  }
  _basisMat4.makeBasis(_basisRight, up, _basisFwd)
  outQuat.setFromRotationMatrix(_basisMat4)
}

function composeInstanceMatrix(outMat, dir, altOffset, baseQuat, pitch, roll, length) {
  _pitchQuat.setFromAxisAngle(X_AXIS, pitch)
  _rollQuat.setFromAxisAngle(Z_AXIS, roll)
  _combinedQuat.copy(baseQuat).multiply(_rollQuat).multiply(_pitchQuat)
  _instPos.copy(dir).multiplyScalar(SEA_LEVEL + altOffset)
  _instScale.setScalar(length)
  outMat.compose(_instPos, _combinedQuat, _instScale)
}

// ---------------------------------------------------------------------------
// createSeaLife
// ---------------------------------------------------------------------------
export function createSeaLife(planet, seed) {
  const group = new THREE.Group()

  // --- shared FX sprite pool ----------------------------------------------
  const fxPositions = new Float32Array(FX_POOL_SIZE * 3)
  const fxColors = new Float32Array(FX_POOL_SIZE * 4)
  const fxVelocity = new Float32Array(FX_POOL_SIZE * 3)
  const fxAge = new Float32Array(FX_POOL_SIZE)
  const fxTtl = new Float32Array(FX_POOL_SIZE)
  let fxCursor = 0
  const fxGeo = new THREE.BufferGeometry()
  fxGeo.setAttribute('position', new THREE.BufferAttribute(fxPositions, 3))
  fxGeo.setAttribute('color', new THREE.BufferAttribute(fxColors, 4))
  const fxMat = new THREE.PointsMaterial({
    size: FX_SIZE,
    sizeAttenuation: false,
    vertexColors: true,
    transparent: true,
    opacity: 1,
    blending: THREE.NormalBlending, // vapor/foam, not glow
    depthWrite: false,
  })
  const fxPoints = new THREE.Points(fxGeo, fxMat)
  fxPoints.renderOrder = 1
  fxPoints.frustumCulled = false // pool slots can sit anywhere on the planet
  group.add(fxPoints)

  function spawnFxParticle(pos, vel, ttl, r, g, b) {
    const slot = fxCursor
    fxCursor = (fxCursor + 1) % FX_POOL_SIZE
    const i3 = slot * 3
    const i4 = slot * 4
    fxPositions[i3] = pos.x
    fxPositions[i3 + 1] = pos.y
    fxPositions[i3 + 2] = pos.z
    fxVelocity[i3] = vel.x
    fxVelocity[i3 + 1] = vel.y
    fxVelocity[i3 + 2] = vel.z
    fxAge[slot] = 0
    fxTtl[slot] = ttl
    fxColors[i4] = r
    fxColors[i4 + 1] = g
    fxColors[i4 + 2] = b
    fxColors[i4 + 3] = 0
  }

  function updateFxPool(dt) {
    for (let slot = 0; slot < FX_POOL_SIZE; slot++) {
      const ttl = fxTtl[slot]
      if (ttl <= 0) continue
      const age = fxAge[slot] + dt
      const i3 = slot * 3
      const i4 = slot * 4
      if (age >= ttl) {
        fxTtl[slot] = 0
        fxColors[i4 + 3] = 0
        continue
      }
      fxAge[slot] = age
      fxPositions[i3] += fxVelocity[i3] * dt
      fxPositions[i3 + 1] += fxVelocity[i3 + 1] * dt
      fxPositions[i3 + 2] += fxVelocity[i3 + 2] * dt
      const fadeIn = age < FX_FADE_IN ? age / FX_FADE_IN : 1
      fxColors[i4 + 3] = FX_PEAK_ALPHA * fadeIn * (1 - age / ttl)
    }
    fxGeo.attributes.position.needsUpdate = true
    fxGeo.attributes.color.needsUpdate = true
  }

  function emitSpoutPuff(rng, worldPos, upDir) {
    tangentBasis(upDir, _obT1, _obT2)
    const a = rng() * Math.PI * 2
    _fxVel
      .copy(upDir)
      .multiplyScalar(SPOUT_RISE_SPEED)
      .addScaledVector(_obT1, Math.cos(a) * SPOUT_DRIFT_SPEED)
      .addScaledVector(_obT2, Math.sin(a) * SPOUT_DRIFT_SPEED)
    _fxPos
      .copy(worldPos)
      .addScaledVector(_obT1, (rng() - 0.5) * SPOUT_JITTER)
      .addScaledVector(_obT2, (rng() - 0.5) * SPOUT_JITTER)
    const g = 0.9 + rng() * 0.06
    spawnFxParticle(_fxPos, _fxVel, SPOUT_TTL * (0.85 + rng() * 0.3), g, g, Math.min(1, g + 0.02))
  }

  function emitSplashRing(rng, dir, alt) {
    tangentBasis(dir, _obT1, _obT2)
    _fxPos0.copy(dir).multiplyScalar(SEA_LEVEL + alt)
    for (let k = 0; k < SPLASH_RING_COUNT; k++) {
      const a = (k / SPLASH_RING_COUNT) * Math.PI * 2
      _fxVel
        .copy(dir)
        .multiplyScalar(SPLASH_RING_RISE)
        .addScaledVector(_obT1, Math.cos(a) * SPLASH_RING_SPEED)
        .addScaledVector(_obT2, Math.sin(a) * SPLASH_RING_SPEED)
      const g = 0.93 + rng() * 0.05
      spawnFxParticle(_fxPos0, _fxVel, SPLASH_RING_TTL * (0.9 + rng() * 0.2), g, g, Math.min(1, g + 0.02))
    }
  }

  function emitEntryBlip(rng, dir, alt) {
    tangentBasis(dir, _obT1, _obT2)
    _fxPos0.copy(dir).multiplyScalar(SEA_LEVEL + alt)
    for (let k = 0; k < BLIP_COUNT; k++) {
      const a = rng() * Math.PI * 2
      _fxVel
        .copy(dir)
        .multiplyScalar(BLIP_SPEED * 0.6)
        .addScaledVector(_obT1, Math.cos(a) * BLIP_SPEED)
        .addScaledVector(_obT2, Math.sin(a) * BLIP_SPEED)
      const g = 0.94 + rng() * 0.05
      spawnFxParticle(_fxPos0, _fxVel, BLIP_TTL * (0.85 + rng() * 0.3), g, g, Math.min(1, g + 0.02))
    }
  }

  // --- whales ---------------------------------------------------------------
  const whaleGeo = buildWhaleGeometry()
  const whaleMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    flatShading: true,
    roughness: 0.65,
    metalness: 0.04,
    side: THREE.DoubleSide,
  })
  const whaleCapacity = WHALE_POD_MAX * WHALE_PER_POD_MAX
  const whaleMesh = new THREE.InstancedMesh(whaleGeo, whaleMat, whaleCapacity)
  whaleMesh.count = 0
  whaleMesh.frustumCulled = false // whale altitude can briefly exceed a stale bounding sphere during breach
  group.add(whaleMesh)

  const whaleCountRng = rngFromString(seed + ':sealife:whale-pod-count')
  const whales = []
  const whalePodCount = WHALE_POD_MIN + Math.floor(whaleCountRng() * (WHALE_POD_MAX - WHALE_POD_MIN + 1))
  for (let p = 0; p < whalePodCount; p++) {
    const podRng = rngFromString(seed + ':sealife:whalepod:' + p)
    const anchor = findDeepOceanAnchor(planet, podRng)
    const count = WHALE_PER_POD_MIN + Math.floor(podRng() * (WHALE_PER_POD_MAX - WHALE_PER_POD_MIN + 1))
    for (let i = 0; i < count; i++) {
      const wRng = rngFromString(seed + ':sealife:whale:' + p + ':' + i)
      const offsetR = WHALE_POD_SPREAD_MIN + wRng() * (WHALE_POD_SPREAD_MAX - WHALE_POD_SPREAD_MIN)
      const offsetA = wRng() * Math.PI * 2
      const dir = offsetPoint(anchor, offsetA, offsetR, new THREE.Vector3())
      const yaw = wRng() * Math.PI * 2
      const fwd = new THREE.Vector3()
      tangentBasis(dir, _obT1, _obT2)
      fwd
        .set(
          _obT1.x * Math.cos(yaw) + _obT2.x * Math.sin(yaw),
          _obT1.y * Math.cos(yaw) + _obT2.y * Math.sin(yaw),
          _obT1.z * Math.cos(yaw) + _obT2.z * Math.sin(yaw),
        )
        .normalize()
      const baseQuat = new THREE.Quaternion()
      computeBaseQuat(baseQuat, dir, fwd)
      const w = {
        dir,
        baseQuat,
        rng: wRng,
        phase: WHALE_PHASE.SUBMERGED,
        timer: 0,
        dur: 1,
        pendingBreach: false,
        breachRollDir: 1,
        splashed: false,
        splashPending: false,
        spoutPuffsRemaining: 0,
        spoutPuffTimer: 0,
        spoutPending: 0,
        altOffset: WHALE_SUBMERGED_DEPTH,
        pitch: WHALE_SUBMERGED_PITCH,
        roll: 0,
        length: WHALE_LENGTH_MIN + wRng() * (WHALE_LENGTH_MAX - WHALE_LENGTH_MIN),
      }
      enterWhalePhase(w, WHALE_PHASE.SUBMERGED)
      w.timer = wRng() * w.dur // desync pod members
      whales.push(w)
    }
  }
  whaleMesh.count = whales.length

  function enterWhalePhase(w, phase) {
    w.phase = phase
    w.timer = 0
    switch (phase) {
      case WHALE_PHASE.SUBMERGED:
        w.dur = WHALE_SUBMERGED_MIN + w.rng() * (WHALE_SUBMERGED_MAX - WHALE_SUBMERGED_MIN)
        w.pendingBreach = w.rng() < WHALE_BREACH_CHANCE
        break
      case WHALE_PHASE.RISE:
        w.dur = WHALE_RISE_DUR
        break
      case WHALE_PHASE.HOLD:
        w.dur = WHALE_HOLD_DUR
        w.spoutPuffsRemaining = SPOUT_PUFF_COUNT
        w.spoutPuffTimer = 0
        // Drop any puffs a previous, camera-culled surfacing queued but
        // never got to spawn (see updateWhaleVisuals) -- otherwise a whale
        // that surfaces many times off-screen would accumulate an
        // unbounded backlog that dumps out all at once whenever the
        // camera finally comes back.
        w.spoutPending = 0
        break
      case WHALE_PHASE.DIVE_ARC:
        w.dur = WHALE_DIVE_ARC_DUR
        break
      case WHALE_PHASE.DIVE_SINK:
        w.dur = WHALE_DIVE_SINK_DUR
        break
      case WHALE_PHASE.BREACH_RISE:
        w.dur = WHALE_BREACH_RISE_DUR
        w.breachRollDir = w.rng() < 0.5 ? -1 : 1
        break
      case WHALE_PHASE.BREACH_APEX:
        w.dur = WHALE_BREACH_APEX_DUR
        break
      case WHALE_PHASE.BREACH_FALL:
        w.dur = WHALE_BREACH_FALL_DUR
        w.splashed = false
        break
    }
  }

  function advanceWhalePhase(w) {
    switch (w.phase) {
      case WHALE_PHASE.SUBMERGED:
        enterWhalePhase(w, w.pendingBreach ? WHALE_PHASE.BREACH_RISE : WHALE_PHASE.RISE)
        break
      case WHALE_PHASE.RISE:
        enterWhalePhase(w, WHALE_PHASE.HOLD)
        break
      case WHALE_PHASE.HOLD:
        enterWhalePhase(w, WHALE_PHASE.DIVE_ARC)
        break
      case WHALE_PHASE.DIVE_ARC:
        enterWhalePhase(w, WHALE_PHASE.DIVE_SINK)
        break
      case WHALE_PHASE.DIVE_SINK:
        enterWhalePhase(w, WHALE_PHASE.SUBMERGED)
        break
      case WHALE_PHASE.BREACH_RISE:
        enterWhalePhase(w, WHALE_PHASE.BREACH_APEX)
        break
      case WHALE_PHASE.BREACH_APEX:
        enterWhalePhase(w, WHALE_PHASE.BREACH_FALL)
        break
      case WHALE_PHASE.BREACH_FALL:
        enterWhalePhase(w, WHALE_PHASE.SUBMERGED)
        break
    }
  }

  /** Always-cheap state tick: pure scalar math, no THREE allocation, safe every frame regardless of camera distance. */
  function tickWhale(w, dt) {
    w.timer += dt
    const t = clamp(w.timer / w.dur, 0, 1)
    const e = smoothstep(0, 1, t)
    switch (w.phase) {
      case WHALE_PHASE.SUBMERGED:
        w.altOffset = WHALE_SUBMERGED_DEPTH
        w.pitch = WHALE_SUBMERGED_PITCH
        w.roll = 0
        break
      case WHALE_PHASE.RISE:
        w.altOffset = lerp(WHALE_SUBMERGED_DEPTH, WHALE_SURFACE_PEAK_ALT, e)
        w.pitch = lerp(WHALE_SUBMERGED_PITCH, 0, e)
        w.roll = 0
        break
      case WHALE_PHASE.HOLD:
        w.altOffset = WHALE_SURFACE_PEAK_ALT + Math.sin(w.timer * WHALE_HOLD_BOB_FREQ) * WHALE_HOLD_BOB_AMP
        w.pitch = 0
        w.roll = 0
        if (w.spoutPuffsRemaining > 0) {
          w.spoutPuffTimer -= dt
          if (w.spoutPuffTimer <= 0) {
            w.spoutPuffsRemaining--
            w.spoutPuffTimer = SPOUT_PUFF_INTERVAL
            w.spoutPending++
          }
        }
        break
      case WHALE_PHASE.DIVE_ARC:
        // Fluke-lift: center eases toward a near-surface waypoint while
        // pitch steepens nose-down -- the tail (opposite the nose along
        // local -Z) swings up above the water purely from that rotation,
        // no separate fluke animation needed. See WHALE_DIVE_WAYPOINT_ALT.
        w.altOffset = lerp(WHALE_SURFACE_PEAK_ALT, WHALE_DIVE_WAYPOINT_ALT, e)
        w.pitch = lerp(0, WHALE_DIVE_PITCH_MAX, e)
        w.roll = 0
        break
      case WHALE_PHASE.DIVE_SINK:
        w.altOffset = lerp(WHALE_DIVE_WAYPOINT_ALT, WHALE_SUBMERGED_DEPTH, e)
        w.pitch = lerp(WHALE_DIVE_PITCH_MAX, WHALE_SUBMERGED_PITCH, e)
        w.roll = 0
        break
      case WHALE_PHASE.BREACH_RISE:
        w.altOffset = lerp(WHALE_SUBMERGED_DEPTH, WHALE_BREACH_APEX_ALT, e)
        w.pitch = lerp(WHALE_SUBMERGED_PITCH, -WHALE_BREACH_PITCH_MAX, e)
        w.roll = w.breachRollDir * WHALE_BREACH_ROLL_MAX * e
        break
      case WHALE_PHASE.BREACH_APEX:
        w.altOffset = WHALE_BREACH_APEX_ALT
        w.pitch = -WHALE_BREACH_PITCH_MAX + Math.sin(t * Math.PI) * 0.05
        w.roll = w.breachRollDir * WHALE_BREACH_ROLL_MAX
        break
      case WHALE_PHASE.BREACH_FALL: {
        const prevAlt = w.altOffset
        w.altOffset = lerp(WHALE_BREACH_APEX_ALT, WHALE_SUBMERGED_DEPTH, e)
        w.pitch = lerp(-WHALE_BREACH_PITCH_MAX, WHALE_SUBMERGED_PITCH, e)
        w.roll = lerp(w.breachRollDir * WHALE_BREACH_ROLL_MAX, 0, e)
        if (!w.splashed && prevAlt >= 0 && w.altOffset < 0) {
          w.splashed = true
          w.splashPending = true
        }
        break
      }
    }
    if (t >= 1) advanceWhalePhase(w)
  }

  // --- dolphins ---------------------------------------------------------------
  const dolphinGeo = buildDolphinGeometry()
  const dolphinMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    flatShading: true,
    roughness: 0.65,
    metalness: 0.04,
    side: THREE.DoubleSide,
  })
  const dolphinCapacity = DOLPHIN_POD_MAX * DOLPHIN_PER_POD_MAX
  const dolphinMesh = new THREE.InstancedMesh(dolphinGeo, dolphinMat, dolphinCapacity)
  dolphinMesh.count = 0
  dolphinMesh.frustumCulled = false // pods drift; avoid a stale bounding sphere
  group.add(dolphinMesh)

  const dolphinCountRng = rngFromString(seed + ':sealife:dolphin-pod-count')
  const dolphinPods = []
  let dolphinTotal = 0
  const dolphinPodCount =
    DOLPHIN_POD_MIN + Math.floor(dolphinCountRng() * (DOLPHIN_POD_MAX - DOLPHIN_POD_MIN + 1))
  for (let p = 0; p < dolphinPodCount; p++) {
    const podRng = rngFromString(seed + ':sealife:dolphinpod:' + p)
    const anchor = findCoastAnchor(planet, podRng)
    const headingBearing = podRng() * Math.PI * 2
    const driftPhase = podRng() * Math.PI * 2
    const count = DOLPHIN_PER_POD_MIN + Math.floor(podRng() * (DOLPHIN_PER_POD_MAX - DOLPHIN_PER_POD_MIN + 1))
    const fallbackFwd = new THREE.Vector3()
    tangentBasis(anchor, _obT1, _obT2)
    fallbackFwd
      .set(
        _obT1.x * Math.cos(headingBearing) + _obT2.x * Math.sin(headingBearing),
        _obT1.y * Math.cos(headingBearing) + _obT2.y * Math.sin(headingBearing),
        _obT1.z * Math.cos(headingBearing) + _obT2.z * Math.sin(headingBearing),
      )
      .normalize()
    const pod = {
      anchorDir: anchor,
      headingBearing,
      driftPhase,
      prevCenter: new THREE.Vector3().copy(anchor),
      prevForward: fallbackFwd,
      currentCenter: new THREE.Vector3().copy(anchor),
      currentForward: fallbackFwd.clone(),
      firstFrame: true,
      dolphins: [],
    }
    for (let i = 0; i < count; i++) {
      const dRng = rngFromString(seed + ':sealife:dolphin:' + p + ':' + i)
      const d = {
        currentDir: new THREE.Vector3().copy(anchor),
        lateralOffset: (dRng() * 2 - 1) * DOLPHIN_LATERAL_SPREAD,
        alongOffset: (dRng() * 2 - 1) * DOLPHIN_ALONG_SPREAD,
        rng: dRng,
        phase: DOLPHIN_PHASE.UNDER,
        timer: 0,
        dur: 1,
        splashed: false,
        splashPending: false,
        altOffset: DOLPHIN_UNDER_DEPTH,
        pitch: DOLPHIN_UNDER_PITCH,
        length: DOLPHIN_LENGTH_MIN + dRng() * (DOLPHIN_LENGTH_MAX - DOLPHIN_LENGTH_MIN),
      }
      enterDolphinPhase(d, DOLPHIN_PHASE.UNDER)
      d.timer = dRng() * d.dur // desync pod members -- the "sewing machine" stagger
      pod.dolphins.push(d)
      dolphinTotal++
    }
    dolphinPods.push(pod)
  }
  dolphinMesh.count = dolphinTotal

  function enterDolphinPhase(d, phase) {
    d.phase = phase
    d.timer = 0
    if (phase === DOLPHIN_PHASE.UNDER)
      d.dur = DOLPHIN_UNDER_MIN + d.rng() * (DOLPHIN_UNDER_MAX - DOLPHIN_UNDER_MIN)
    else if (phase === DOLPHIN_PHASE.RISE) d.dur = DOLPHIN_RISE_DUR
    else {
      d.dur = DOLPHIN_FALL_DUR
      d.splashed = false
    }
  }

  function advanceDolphinPhase(d) {
    if (d.phase === DOLPHIN_PHASE.UNDER) enterDolphinPhase(d, DOLPHIN_PHASE.RISE)
    else if (d.phase === DOLPHIN_PHASE.RISE) enterDolphinPhase(d, DOLPHIN_PHASE.FALL)
    else enterDolphinPhase(d, DOLPHIN_PHASE.UNDER)
  }

  function tickDolphin(d, dt) {
    d.timer += dt
    const t = clamp(d.timer / d.dur, 0, 1)
    const e = smoothstep(0, 1, t)
    if (d.phase === DOLPHIN_PHASE.UNDER) {
      d.altOffset = DOLPHIN_UNDER_DEPTH
      d.pitch = DOLPHIN_UNDER_PITCH
    } else if (d.phase === DOLPHIN_PHASE.RISE) {
      d.altOffset = lerp(DOLPHIN_UNDER_DEPTH, DOLPHIN_PEAK_ALT, e)
      d.pitch = lerp(DOLPHIN_UNDER_PITCH, 0, e)
    } else {
      const prevAlt = d.altOffset
      d.altOffset = lerp(DOLPHIN_PEAK_ALT, DOLPHIN_UNDER_DEPTH, e)
      d.pitch = lerp(0, DOLPHIN_UNDER_PITCH, e)
      if (!d.splashed && prevAlt >= 0 && d.altOffset < 0) {
        d.splashed = true
        d.splashPending = true
      }
    }
    if (t >= 1) advanceDolphinPhase(d)
  }

  /** Pod-shared heading, derived from actual center-point motion each frame (dragon.js's root-motion-heading idiom, robust through the drift oscillation's zero-velocity turnaround points). */
  function updatePodTransform(pod, simTime) {
    const driftDist = Math.sin(simTime * DOLPHIN_DRIFT_FREQ + pod.driftPhase) * DOLPHIN_DRIFT_AMPLITUDE
    offsetPoint(pod.anchorDir, pod.headingBearing, driftDist, _podCenter)
    if (pod.firstFrame) {
      pod.prevCenter.copy(_podCenter)
      pod.firstFrame = false
    }
    _podMoveDelta.copy(_podCenter).sub(pod.prevCenter)
    if (_podMoveDelta.lengthSq() > 1e-16) {
      _podFwd.copy(_podMoveDelta).addScaledVector(_podCenter, -_podMoveDelta.dot(_podCenter))
      if (_podFwd.lengthSq() > 1e-16) _podFwd.normalize()
      else _podFwd.copy(pod.prevForward)
    } else {
      _podFwd.copy(pod.prevForward)
    }
    pod.currentCenter.copy(_podCenter)
    pod.currentForward.copy(_podFwd)
    pod.prevCenter.copy(_podCenter)
    pod.prevForward.copy(_podFwd)
  }

  // --- per-frame visual work (skipped when camera is far -- see update()) ---
  function updateWhaleVisuals() {
    for (let i = 0; i < whales.length; i++) {
      const w = whales[i]
      composeInstanceMatrix(_instMat, w.dir, w.altOffset, w.baseQuat, w.pitch, w.roll, w.length)
      whaleMesh.setMatrixAt(i, _instMat)

      if (w.spoutPending > 0) {
        // _instPos/_combinedQuat still hold this whale's just-composed
        // world position/orientation (written by composeInstanceMatrix
        // above, nothing else touches them in between) -- reuse them to
        // place the blowhole spawn point without recomputing the pose.
        _localOffset.copy(WHALE_BLOWHOLE_LOCAL).multiplyScalar(w.length)
        _worldPos.copy(_localOffset).applyQuaternion(_combinedQuat).add(_instPos)
        while (w.spoutPending > 0) {
          w.spoutPending--
          emitSpoutPuff(w.rng, _worldPos, w.dir)
        }
      }
      if (w.splashPending) {
        w.splashPending = false
        emitSplashRing(w.rng, w.dir, 0)
      }
    }
    whaleMesh.instanceMatrix.needsUpdate = true
  }

  function updateDolphinVisuals(simTime) {
    let idx = 0
    for (let p = 0; p < dolphinPods.length; p++) {
      const pod = dolphinPods[p]
      updatePodTransform(pod, simTime)
      for (let i = 0; i < pod.dolphins.length; i++) {
        const d = pod.dolphins[i]
        offsetPoint(pod.currentCenter, pod.headingBearing + Math.PI / 2, d.lateralOffset, _dolphinDirA)
        offsetPoint(_dolphinDirA, pod.headingBearing, d.alongOffset, d.currentDir)
        computeBaseQuat(_scratchBaseQuat, d.currentDir, pod.currentForward)
        composeInstanceMatrix(_instMat, d.currentDir, d.altOffset, _scratchBaseQuat, d.pitch, 0, d.length)
        dolphinMesh.setMatrixAt(idx, _instMat)
        if (d.splashPending) {
          d.splashPending = false
          emitEntryBlip(d.rng, d.currentDir, 0)
        }
        idx++
      }
    }
    dolphinMesh.instanceMatrix.needsUpdate = true
  }

  let simTime = 0

  function update(dt, camera) {
    simTime += dt

    for (let i = 0; i < whales.length; i++) tickWhale(whales[i], dt)
    for (let p = 0; p < dolphinPods.length; p++) {
      const pod = dolphinPods[p]
      for (let i = 0; i < pod.dolphins.length; i++) tickDolphin(pod.dolphins[i], dt)
    }

    const camDist = camera && camera.position ? camera.position.length() : 0
    const near = camDist <= CAMERA_CULL_DIST
    whaleMesh.visible = near && whales.length > 0
    dolphinMesh.visible = near && dolphinTotal > 0
    fxPoints.visible = near

    if (!near) return

    updateWhaleVisuals()
    updateDolphinVisuals(simTime)
    updateFxPool(dt)
  }

  return { group, update }
}
