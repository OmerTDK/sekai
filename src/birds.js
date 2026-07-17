// Real articulated low-poly birds (M-WX JIT plan — replaces the day-one
// 2-triangle silhouettes; program plan's "REAL birds... same flock logic").
// Procedural geometry (no network dependency): each bird is a tapered
// bipyramid body + a small head/beak wedge + a tapered tail fan + two swept
// wing quads, merged into ONE non-indexed BufferGeometry (flat-shaded, per
// flora.js's "scattered props are flat-shaded low-poly" convention) and
// rendered as a single InstancedMesh — one draw call for every habit.
//
// Wings flap in the VERTEX SHADER: a per-vertex `wingSide` attribute
// (-1/0/+1) marks which hinge group a vertex belongs to, and two per-instance
// attributes (`flapWave`, `flapCycle`) drive a shared onBeforeCompile
// injection that rotates wing vertices about the shoulder hinge (HINGE_X) —
// the exact instanced-attribute + onBeforeCompile recipe flora.js's grass
// wind / tree sway shaders use, extended from a bend to a hinge rotation.
// Flap-vs-glide alternation is computed ENTIRELY from a shared `uTime`
// uniform plus each bird's own static per-instance phase/cycle attributes
// (set once at creation) — no per-frame CPU work beyond advancing the clock
// and moving each bird's flight path, matching flora's "one uniform update,
// zero per-instance JS" wind pattern. flatShading:true means the fragment
// shader derives its normal from screen-space position derivatives (three.js
// FLAT_SHADED path), so the flap shader only needs to rotate `transformed`
// (position) in `begin_vertex` — no normal-shader injection needed (same
// simplification flora.js's tree-sway shader already relies on).
//
// Three habits, each deterministic from `seed` (rngFromString + makeNoise3D,
// no Math.random/Date.now anywhere):
//   1. Migratory V-formation flocks cruising the shared 1.065-1.073 band
//      (dragon.js's own flight band) on great-circle orbits — axes are
//      seeded-random, so with only a handful of flocks and a dragon that
//      spends ~60% of its time perched, collisions are sparse by
//      construction; this module has no cross-module access to the dragon's
//      actual lair position (createBirds only receives planet+seed), so
//      "non-colliding by longitude offset" is satisfied by even coverage +
//      per-flock altitude/phase variance rather than literal coordination.
//   2. Coastal gulls circling shoreline anchors (found by rejection-sampling
//      isLand transitions) at terrain+0.004-0.008.
//   3. Small forest flocks looping over forest-biome anchors at
//      terrain+0.006-0.012, with a noise-driven organic loop-radius wobble.
//
// Contract (pinned): createBirds(planet, seed) -> { group, update(dt, camera) }.
import * as THREE from 'three/webgpu'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { rngFromString, makeNoise3D, clamp, lerp } from './util.js'
import { tangentBasis } from './placement.js'

// ---------------------------------------------------------------------------
// Geometry tunables
// ---------------------------------------------------------------------------
const HINGE_X = 0.15 // wing-root X in the unit body — the vertex-shader flap hinge
const CAPACITY = 200 // InstancedMesh max; actual count lands ~130-190, see habit tunables below

const COLOR_SLATE = 0x5c6470 // dorsal body — muted blue-grey (ART.md §2 "slate")
const COLOR_CREAM = 0xe6ddc6 // ventral body — pale warm cream (countershading)
const COLOR_CHARCOAL = 0x2b2926 // beak, tail, wingtips — dark accent (ART.md §2 "charcoal")

// ---------------------------------------------------------------------------
// Habit 1 — migratory V-formation flocks. Shared altitude band with
// dragon.js (docs/superpowers/plans/2026-07-17-m-wx-jit.md's height budget).
// ---------------------------------------------------------------------------
const MIGRATORY_FLOCKS = 6
const MIGRATORY_SIZE_MIN = 9
const MIGRATORY_SIZE_MAX = 13
const MIGRATORY_SPEED_MIN = 0.009 // rad/s, great-circle angular speed
const MIGRATORY_SPEED_MAX = 0.017
const MIGRATORY_ALT_MIN = 1.065
const MIGRATORY_ALT_MAX = 1.073
const MIGRATORY_SPACING_BACK = 0.0075 // world units, V-formation row spacing
const MIGRATORY_SPACING_SIDE = 0.0062
const MIGRATORY_BODY_MIN = 0.005
const MIGRATORY_BODY_MAX = 0.0065
const MIGRATORY_FLAP_RATE_MIN = 6
const MIGRATORY_FLAP_RATE_MAX = 9
const MIGRATORY_FLAP_AMP_MIN = 0.5
const MIGRATORY_FLAP_AMP_MAX = 0.7
const MIGRATORY_CYCLE_MIN = 3
const MIGRATORY_CYCLE_MAX = 5.5
const MIGRATORY_FLAPFRAC_MIN = 0.6 // migratory flight: mostly flapping, brief glide holds
const MIGRATORY_FLAPFRAC_MAX = 0.8
const BANK_GAIN_V = 32
const BANK_MAX_V = 0.5

// ---------------------------------------------------------------------------
// Habit 2 — coastal gulls circling shoreline anchors.
// ---------------------------------------------------------------------------
const GULL_GROUPS = 6
const GULL_SIZE_MIN = 6
const GULL_SIZE_MAX = 9
const GULL_RADIUS_MIN = 0.02 // rad, angular radius of the circling loop
const GULL_RADIUS_MAX = 0.045
const GULL_SPEED_MIN = 0.3 // rad/s around the anchor
const GULL_SPEED_MAX = 0.55
const GULL_GROUND_MIN = 0.004 // terrain-relative altitude band, per JIT plan
const GULL_GROUND_MAX = 0.008
const GULL_BODY_MIN = 0.0055
const GULL_BODY_MAX = 0.007
const GULL_FLAP_RATE_MIN = 4
const GULL_FLAP_RATE_MAX = 6
const GULL_FLAP_AMP_MIN = 0.32
const GULL_FLAP_AMP_MAX = 0.48
const GULL_CYCLE_MIN = 2.5
const GULL_CYCLE_MAX = 5
const GULL_FLAPFRAC_MIN = 0.22 // gulls: mostly soaring/gliding while circling
const GULL_FLAPFRAC_MAX = 0.42
const COAST_PROBE_DIST = 0.02 // rad, coastline-crossing probe radius
const COAST_ANCHOR_TRIES = 4000

// ---------------------------------------------------------------------------
// Habit 3 — small forest flocks looping over forest-biome anchors. Same
// biome thresholds flora.js uses to decide "this is forest" (TREE_* consts),
// so flocks loop where the trees actually are.
// ---------------------------------------------------------------------------
const FOREST_GROUPS = 6
const FOREST_SIZE_MIN = 6
const FOREST_SIZE_MAX = 9
const FOREST_RADIUS_MIN = 0.012
const FOREST_RADIUS_MAX = 0.026
const FOREST_SPEED_MIN = 0.4
const FOREST_SPEED_MAX = 0.75
const FOREST_GROUND_MIN = 0.006
const FOREST_GROUND_MAX = 0.012
const FOREST_BODY_MIN = 0.004
const FOREST_BODY_MAX = 0.0055
const FOREST_FLAP_RATE_MIN = 9
const FOREST_FLAP_RATE_MAX = 13
const FOREST_FLAP_AMP_MIN = 0.6
const FOREST_FLAP_AMP_MAX = 0.85
const FOREST_CYCLE_MIN = 1.4
const FOREST_CYCLE_MAX = 3
const FOREST_FLAPFRAC_MIN = 0.55 // forest flocks: energetic fluttering flight
const FOREST_FLAPFRAC_MAX = 0.8
const FOREST_RADIUS_WOBBLE_AMP = 0.3 // fraction of radius, noise-driven organic loop breathing
const FOREST_RADIUS_WOBBLE_FREQ_MIN = 0.08
const FOREST_RADIUS_WOBBLE_FREQ_MAX = 0.18
const FOREST_ANCHOR_TRIES = 4000
const FOREST_MIN_MOISTURE = 0.55
const FOREST_MIN_LANDT = 0.05
const FOREST_MAX_LANDT = 0.6
const FOREST_MAX_SLOPE = 0.4
const FOREST_MAX_POLAR = 0.3

const BANK_GAIN_CIRCLE = 0.75
const BANK_MAX_CIRCLE = 0.55

const BIRDS_VISIBLE_DIST = 3.2 // matches flora.js's PROP_VISIBLE_DIST -- tiny detail, pointless past this

// ---------------------------------------------------------------------------
// Geometry construction. Each part is authored as a tiny indexed geometry
// (position + per-vertex wingSide + per-vertex color), then toNonIndexed()
// expands ALL of those attributes together (three.js's toNonIndexed handles
// every attribute present, not just position) to get correct flat-shaded,
// independent-per-triangle vertices before merging.
// ---------------------------------------------------------------------------
let warnedGeometryMerge = false

function makePart(positions, indices, wingSide, colorSpec) {
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3))
  geo.setIndex(indices)
  const n = positions.length / 3
  const wsArr = new Float32Array(n).fill(wingSide)
  geo.setAttribute('wingSide', new THREE.BufferAttribute(wsArr, 1))
  const carr = new Float32Array(n * 3)
  const c = new THREE.Color()
  for (let i = 0; i < n; i++) {
    c.set(Array.isArray(colorSpec) ? colorSpec[i] : colorSpec)
    carr[i * 3] = c.r
    carr[i * 3 + 1] = c.g
    carr[i * 3 + 2] = c.b
  }
  geo.setAttribute('color', new THREE.BufferAttribute(carr, 3))
  const non = geo.toNonIndexed()
  non.computeVertexNormals()
  return non
}

// Body: tapered bipyramid (nose + tail apex, 4-point equator ring).
const BODY_POS = [
  0, 0.03, 0.52, 0, -0.05, -0.48, 0.15, -0.01, 0.06, 0, 0.12, 0.0, -0.15, -0.01, 0.06, 0, -0.08, 0.09,
]
const BODY_IDX = [0, 2, 3, 0, 3, 4, 0, 4, 5, 0, 5, 2, 1, 3, 2, 1, 4, 3, 1, 5, 4, 1, 2, 5]
const BODY_COLORS = [COLOR_SLATE, COLOR_CREAM, COLOR_SLATE, COLOR_SLATE, COLOR_SLATE, COLOR_CREAM]

// Head/beak: a tiny forward-pointing tetrahedron ahead of the body's nose.
const HEAD_POS = [0, 0.035, 0.5, 0.045, -0.005, 0.48, -0.045, -0.005, 0.48, 0, -0.01, 0.66]
const HEAD_IDX = [3, 0, 1, 3, 1, 2, 3, 2, 0, 0, 2, 1]

// Tail: a flared, tapered fan behind the body's tail apex.
const TAIL_POS = [0.05, -0.02, -0.46, -0.05, -0.02, -0.46, -0.09, -0.035, -0.74, 0.09, -0.035, -0.74]
const TAIL_IDX = [0, 1, 2, 0, 2, 3]

// Wing (right side, x>0): swept, tapered quad. Root verts sit exactly at
// x=HINGE_X so the shader's hinge rotation leaves them stationary (welded to
// the shoulder) while the tip sweeps through the flap arc.
const WING_POS_R = [0.15, 0.055, 0.13, 0.15, 0.015, -0.03, 0.66, -0.02, -0.17, 0.72, 0.0, 0.03]
const WING_POS_L = [-0.15, 0.055, 0.13, -0.15, 0.015, -0.03, -0.66, -0.02, -0.17, -0.72, 0.0, 0.03]
const WING_IDX = [0, 1, 2, 0, 2, 3]
const WING_COLORS = [COLOR_SLATE, COLOR_SLATE, COLOR_CHARCOAL, COLOR_CHARCOAL]

/** Procedural low-poly bird: tapered body, head+beak, tail, two hinged wings. */
export function buildBirdGeometry() {
  const body = makePart(BODY_POS, BODY_IDX, 0, BODY_COLORS)
  const head = makePart(HEAD_POS, HEAD_IDX, 0, COLOR_CHARCOAL)
  const tail = makePart(TAIL_POS, TAIL_IDX, 0, COLOR_CHARCOAL)
  const wingR = makePart(WING_POS_R, WING_IDX, 1, WING_COLORS)
  const wingL = makePart(WING_POS_L, WING_IDX, -1, WING_COLORS)
  const merged = mergeGeometries([body, head, tail, wingR, wingL], false)
  if (!merged) {
    if (!warnedGeometryMerge) {
      warnedGeometryMerge = true
      console.warn(
        '[planet] birds.js: bird geometry merge degraded — mergeGeometries failed, shipping body-only geometry (head/tail/wings lost)',
      )
    }
    return { geo: body, hingeX: HINGE_X }
  }
  return { geo: merged, hingeX: HINGE_X }
}

// ---------------------------------------------------------------------------
// Anchor search — rejection-sample random points, testing for an isLand
// transition (coast) or a forest-biome match, exactly placement.js's
// bounded-search-with-fallback style.
// ---------------------------------------------------------------------------
function randUnitVector(rng, out) {
  const z = rng() * 2 - 1
  const t = rng() * Math.PI * 2
  const r = Math.sqrt(Math.max(0, 1 - z * z))
  return out.set(r * Math.cos(t), r * Math.sin(t), z)
}

const _anchorT1 = new THREE.Vector3()
const _anchorT2 = new THREE.Vector3()
const _anchorProbe = new THREE.Vector3()
const _anchorDir = new THREE.Vector3()
const COAST_PROBE_BEARINGS = [0, Math.PI / 2, Math.PI, (Math.PI * 3) / 2]

let warnedCoastAnchor = false
/** Rejection-samples a point near an isLand transition (a coastline). */
function findCoastAnchor(planet, rng) {
  for (let tries = 0; tries < COAST_ANCHOR_TRIES; tries++) {
    randUnitVector(rng, _anchorDir)
    const land = planet.isLand(_anchorDir)
    tangentBasis(_anchorDir, _anchorT1, _anchorT2)
    for (let b = 0; b < COAST_PROBE_BEARINGS.length; b++) {
      const bearing = COAST_PROBE_BEARINGS[b] + rng() * 0.4
      _anchorProbe
        .copy(_anchorDir)
        .addScaledVector(_anchorT1, Math.cos(bearing) * COAST_PROBE_DIST)
        .addScaledVector(_anchorT2, Math.sin(bearing) * COAST_PROBE_DIST)
        .normalize()
      if (planet.isLand(_anchorProbe) !== land) return (land ? _anchorDir : _anchorProbe).clone()
    }
  }
  if (!warnedCoastAnchor) {
    warnedCoastAnchor = true
    console.warn(
      '[planet] birds.js: coastal gull anchor search degraded — no coastline found within budget, falling back to a random point',
    )
  }
  return _anchorDir.clone()
}

let warnedForestAnchor = false
/** Rejection-samples a point matching flora.js's forest-biome thresholds. */
function findForestAnchor(planet, rng) {
  const dir = new THREE.Vector3()
  const biome = {}
  for (let tries = 0; tries < FOREST_ANCHOR_TRIES; tries++) {
    randUnitVector(rng, dir)
    if (!planet.isLand(dir)) continue
    planet.biomeAt(dir, biome)
    if (biome.moisture <= FOREST_MIN_MOISTURE) continue
    if (biome.landT < FOREST_MIN_LANDT || biome.landT > FOREST_MAX_LANDT) continue
    if (biome.slope >= FOREST_MAX_SLOPE) continue
    if (biome.polar >= FOREST_MAX_POLAR) continue
    return dir.clone()
  }
  if (!warnedForestAnchor) {
    warnedForestAnchor = true
    console.warn(
      '[planet] birds.js: forest flock anchor search degraded — no matching forest biome found within budget, falling back to a random land point',
    )
  }
  return dir.clone()
}

// ---------------------------------------------------------------------------
// Habit builders — each returns an array of flock descriptors and registers
// its birds via the shared `addBird` callback (assigns an instance index,
// writes per-instance shader attributes + instance color).
// ---------------------------------------------------------------------------
function buildMigratoryFlocks(seed, addBird) {
  const rng = rngFromString(seed + ':birds:migratory')
  const flocks = []
  for (let f = 0; f < MIGRATORY_FLOCKS; f++) {
    const axis = randUnitVector(rng, new THREE.Vector3())
    const start = randUnitVector(rng, new THREE.Vector3())
    start.addScaledVector(axis, -start.dot(axis)).normalize()
    const size = MIGRATORY_SIZE_MIN + Math.floor(rng() * (MIGRATORY_SIZE_MAX - MIGRATORY_SIZE_MIN + 1))
    const fl = {
      axis,
      start,
      angle: rng() * Math.PI * 2,
      speed: lerp(MIGRATORY_SPEED_MIN, MIGRATORY_SPEED_MAX, rng()),
      altBase: lerp(MIGRATORY_ALT_MIN, MIGRATORY_ALT_MAX, rng()),
      altWobbleAmp: lerp(0.0012, 0.003, rng()),
      altWobbleFreq: lerp(0.15, 0.4, rng()),
      altPhase: rng() * Math.PI * 2,
      bankWobbleAmp: lerp(0.04, 0.09, rng()),
      bankWobbleFreq: lerp(0.1, 0.25, rng()),
      bankPhase: rng() * Math.PI * 2,
      members: [],
    }
    for (let i = 0; i < size; i++) {
      const row = Math.ceil(i / 2)
      const side = i % 2 === 0 ? 1 : -1
      const idx = addBird({
        size: lerp(MIGRATORY_BODY_MIN, MIGRATORY_BODY_MAX, rng()),
        tint: [lerp(0.8, 0.88, rng()), lerp(0.84, 0.92, rng()), lerp(0.9, 0.98, rng())],
        flapPhase: rng() * Math.PI * 2,
        flapRate: lerp(MIGRATORY_FLAP_RATE_MIN, MIGRATORY_FLAP_RATE_MAX, rng()),
        flapAmp: lerp(MIGRATORY_FLAP_AMP_MIN, MIGRATORY_FLAP_AMP_MAX, rng()),
        cycleOffset: rng() * 8,
        cycleLen: lerp(MIGRATORY_CYCLE_MIN, MIGRATORY_CYCLE_MAX, rng()),
        flapFrac: lerp(MIGRATORY_FLAPFRAC_MIN, MIGRATORY_FLAPFRAC_MAX, rng()),
      })
      if (idx < 0) continue
      fl.members.push({
        instanceIndex: idx,
        back: row * MIGRATORY_SPACING_BACK,
        side: side * row * MIGRATORY_SPACING_SIDE,
      })
    }
    flocks.push(fl)
  }
  return flocks
}

function buildCircleFlocks(kind, planet, seed, addBird) {
  const isGull = kind === 'gull'
  const rng = rngFromString(seed + ':birds:' + kind)
  const groups = isGull ? GULL_GROUPS : FOREST_GROUPS
  const sizeMin = isGull ? GULL_SIZE_MIN : FOREST_SIZE_MIN
  const sizeMax = isGull ? GULL_SIZE_MAX : FOREST_SIZE_MAX
  const radiusMin = isGull ? GULL_RADIUS_MIN : FOREST_RADIUS_MIN
  const radiusMax = isGull ? GULL_RADIUS_MAX : FOREST_RADIUS_MAX
  const speedMin = isGull ? GULL_SPEED_MIN : FOREST_SPEED_MIN
  const speedMax = isGull ? GULL_SPEED_MAX : FOREST_SPEED_MAX
  const groundMin = isGull ? GULL_GROUND_MIN : FOREST_GROUND_MIN
  const groundMax = isGull ? GULL_GROUND_MAX : FOREST_GROUND_MAX
  const bodyMin = isGull ? GULL_BODY_MIN : FOREST_BODY_MIN
  const bodyMax = isGull ? GULL_BODY_MAX : FOREST_BODY_MAX
  const flapRateMin = isGull ? GULL_FLAP_RATE_MIN : FOREST_FLAP_RATE_MIN
  const flapRateMax = isGull ? GULL_FLAP_RATE_MAX : FOREST_FLAP_RATE_MAX
  const flapAmpMin = isGull ? GULL_FLAP_AMP_MIN : FOREST_FLAP_AMP_MIN
  const flapAmpMax = isGull ? GULL_FLAP_AMP_MAX : FOREST_FLAP_AMP_MAX
  const cycleMin = isGull ? GULL_CYCLE_MIN : FOREST_CYCLE_MIN
  const cycleMax = isGull ? GULL_CYCLE_MAX : FOREST_CYCLE_MAX
  const flapFracMin = isGull ? GULL_FLAPFRAC_MIN : FOREST_FLAPFRAC_MIN
  const flapFracMax = isGull ? GULL_FLAPFRAC_MAX : FOREST_FLAPFRAC_MAX

  const flocks = []
  for (let g = 0; g < groups; g++) {
    const anchor = isGull ? findCoastAnchor(planet, rng) : findForestAnchor(planet, rng)
    const t1 = new THREE.Vector3()
    const t2 = new THREE.Vector3()
    tangentBasis(anchor, t1, t2)
    const bearing = rng() * Math.PI * 2
    const radial = new THREE.Vector3()
      .copy(t1)
      .multiplyScalar(Math.cos(bearing))
      .addScaledVector(t2, Math.sin(bearing))
      .normalize()
    const size = sizeMin + Math.floor(rng() * (sizeMax - sizeMin + 1))
    const fl = {
      anchor,
      radial,
      angle: rng() * Math.PI * 2,
      speed: lerp(speedMin, speedMax, rng()) * (rng() < 0.5 ? 1 : -1), // circle either direction
      radius: lerp(radiusMin, radiusMax, rng()),
      radiusWobbleAmp: isGull ? 0 : FOREST_RADIUS_WOBBLE_AMP,
      radiusWobbleFreq: lerp(FOREST_RADIUS_WOBBLE_FREQ_MIN, FOREST_RADIUS_WOBBLE_FREQ_MAX, rng()),
      noiseX: rng() * 1000,
      noiseZ: rng() * 1000,
      altWobbleFreq: lerp(0.3, 0.6, rng()),
      altWobbleAmp: lerp(0.0003, 0.0007, rng()),
      groundOffsetMin: groundMin,
      groundOffsetMax: groundMax,
      members: [],
    }
    for (let i = 0; i < size; i++) {
      const idx = addBird({
        size: lerp(bodyMin, bodyMax, rng()),
        tint: isGull
          ? [lerp(1.05, 1.18, rng()), lerp(1.05, 1.18, rng()), lerp(1.0, 1.12, rng())]
          : [lerp(0.72, 0.86, rng()), lerp(0.62, 0.76, rng()), lerp(0.42, 0.56, rng())],
        flapPhase: rng() * Math.PI * 2,
        flapRate: lerp(flapRateMin, flapRateMax, rng()),
        flapAmp: lerp(flapAmpMin, flapAmpMax, rng()),
        cycleOffset: rng() * 8,
        cycleLen: lerp(cycleMin, cycleMax, rng()),
        flapFrac: lerp(flapFracMin, flapFracMax, rng()),
      })
      if (idx < 0) continue
      fl.members.push({
        instanceIndex: idx,
        phaseOffset: (i / size) * Math.PI * 2 + rng() * 0.3,
        radiusMul: lerp(0.8, 1.2, rng()),
        groundOffset: lerp(groundMin, groundMax, rng()),
        altPhase: rng() * Math.PI * 2,
      })
    }
    flocks.push(fl)
  }
  return flocks
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------
export function createBirds(planet, seed) {
  const group = new THREE.Group()
  const noise3 = makeNoise3D(seed + ':birds:noise')

  const { geo, hingeX } = buildBirdGeometry()
  geo.setAttribute('flapWave', new THREE.InstancedBufferAttribute(new Float32Array(CAPACITY * 3), 3)) // phase, rate, amp
  geo.setAttribute('flapCycle', new THREE.InstancedBufferAttribute(new Float32Array(CAPACITY * 3), 3)) // offset, len, flapFrac

  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    flatShading: true,
    roughness: 0.92,
    metalness: 0,
    side: THREE.DoubleSide,
  })
  let flapUniforms = null
  let warnedFlapShader = false
  material.customProgramCacheKey = () => 'birds-flap-v1'
  material.onBeforeCompile = (shader) => {
    try {
      shader.uniforms.uTime = { value: 0 }
      shader.vertexShader =
        'uniform float uTime;\n' +
        'attribute float wingSide;\n' +
        'attribute vec3 flapWave;\n' +
        'attribute vec3 flapCycle;\n' +
        'float birdFlapAngle() {\n' +
        '  float cyclePos = mod(uTime + flapCycle.x, flapCycle.y);\n' +
        '  float flapWindow = flapCycle.y * flapCycle.z;\n' +
        '  float edge = min(flapCycle.y * 0.12, 0.35);\n' +
        '  float env = smoothstep(0.0, edge, cyclePos) * (1.0 - smoothstep(flapWindow, flapWindow + edge, cyclePos));\n' +
        '  return sin(uTime * flapWave.y + flapWave.x) * flapWave.z * env;\n' +
        '}\n' +
        'vec3 birdFlapRotate(vec3 p, float angle) {\n' +
        `  float hx = ${hingeX.toFixed(6)} * wingSide;\n` +
        '  float dx = p.x - hx;\n' +
        '  float a = angle * wingSide;\n' +
        '  float ca = cos(a);\n' +
        '  float sa = sin(a);\n' +
        '  return vec3(hx + dx * ca - p.y * sa, dx * sa + p.y * ca, p.z);\n' +
        '}\n' +
        shader.vertexShader
      const patched = shader.vertexShader.replace(
        '#include <begin_vertex>',
        ['#include <begin_vertex>', 'transformed = birdFlapRotate(transformed, birdFlapAngle());'].join('\n'),
      )
      if (patched === shader.vertexShader) throw new Error('birds.js: begin_vertex injection point not found')
      shader.vertexShader = patched
      flapUniforms = shader.uniforms
    } catch (err) {
      flapUniforms = null // fall back to static (unflapping, flat) wings
      if (!warnedFlapShader) {
        warnedFlapShader = true
        console.warn(
          '[planet] birds.js: wing-flap animation degraded — onBeforeCompile shader injection failed, wings render static: ' +
            err,
        )
      }
    }
  }

  const mesh = new THREE.InstancedMesh(geo, material, CAPACITY)
  mesh.count = 0
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage) // every instance moves every frame
  mesh.frustumCulled = false // flocks roam the whole sphere; no single static bounding volume applies
  group.add(mesh)

  const sizes = new Float32Array(CAPACITY)
  const flapWaveArr = geo.attributes.flapWave.array
  const flapCycleArr = geo.attributes.flapCycle.array
  const _tintColor = new THREE.Color()
  let count = 0
  let warnedCapacity = false

  function addBird(spec) {
    if (count >= CAPACITY) {
      if (!warnedCapacity) {
        warnedCapacity = true
        console.warn(
          '[planet] birds.js: instance capacity (' + CAPACITY + ') exceeded — dropping extra birds',
        )
      }
      return -1
    }
    const idx = count++
    sizes[idx] = spec.size
    flapWaveArr[idx * 3] = spec.flapPhase
    flapWaveArr[idx * 3 + 1] = spec.flapRate
    flapWaveArr[idx * 3 + 2] = spec.flapAmp
    flapCycleArr[idx * 3] = spec.cycleOffset
    flapCycleArr[idx * 3 + 1] = spec.cycleLen
    flapCycleArr[idx * 3 + 2] = spec.flapFrac
    _tintColor.setRGB(spec.tint[0], spec.tint[1], spec.tint[2])
    mesh.setColorAt(idx, _tintColor)
    return idx
  }

  const migratoryFlocks = buildMigratoryFlocks(seed, addBird)
  const gullFlocks = buildCircleFlocks('gull', planet, seed, addBird)
  const forestFlocks = buildCircleFlocks('forest', planet, seed, addBird)

  mesh.count = count
  mesh.instanceMatrix.needsUpdate = true
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
  geo.attributes.flapWave.needsUpdate = true
  geo.attributes.flapCycle.needsUpdate = true

  // -- scratch (persistent -- no per-frame allocations) --------------------
  const _leaderDir = new THREE.Vector3()
  const _fwd = new THREE.Vector3()
  const _right = new THREE.Vector3()
  const _basisMat = new THREE.Matrix4()
  const _baseQuat = new THREE.Quaternion()
  const _rollQuat = new THREE.Quaternion()
  const _instQuat = new THREE.Quaternion()
  const _instPos = new THREE.Vector3()
  const _scaleVec = new THREE.Vector3()
  const _instMat = new THREE.Matrix4()
  const _zAxis = new THREE.Vector3(0, 0, 1)
  let simTime = 0

  function stepVFlock(fl, dt) {
    fl.angle += fl.speed * dt
    _leaderDir.copy(fl.start).applyAxisAngle(fl.axis, fl.angle)
    _fwd.crossVectors(fl.axis, _leaderDir).normalize()
    _right.crossVectors(_leaderDir, _fwd).normalize()
    _fwd.crossVectors(_right, _leaderDir).normalize()
    const alt = clamp(
      fl.altBase + Math.sin(simTime * fl.altWobbleFreq + fl.altPhase) * fl.altWobbleAmp,
      MIGRATORY_ALT_MIN,
      MIGRATORY_ALT_MAX,
    )
    _basisMat.makeBasis(_right, _leaderDir, _fwd)
    _baseQuat.setFromRotationMatrix(_basisMat)
    const bank =
      clamp(fl.speed * BANK_GAIN_V, -BANK_MAX_V, BANK_MAX_V) +
      Math.sin(simTime * fl.bankWobbleFreq + fl.bankPhase) * fl.bankWobbleAmp
    _rollQuat.setFromAxisAngle(_zAxis, bank)
    _instQuat.copy(_baseQuat).multiply(_rollQuat)
    for (const m of fl.members) {
      _instPos
        .copy(_leaderDir)
        .multiplyScalar(alt)
        .addScaledVector(_fwd, -m.back)
        .addScaledVector(_right, m.side)
      _scaleVec.setScalar(sizes[m.instanceIndex])
      _instMat.compose(_instPos, _instQuat, _scaleVec)
      mesh.setMatrixAt(m.instanceIndex, _instMat)
    }
  }

  function stepCircleFlock(fl, dt) {
    fl.angle += fl.speed * dt
    const bank =
      clamp(Math.abs(fl.speed) * BANK_GAIN_CIRCLE, -BANK_MAX_CIRCLE, BANK_MAX_CIRCLE) * Math.sign(fl.speed)
    const wob = fl.radiusWobbleAmp > 0 ? noise3(fl.noiseX, simTime * fl.radiusWobbleFreq, fl.noiseZ) : 0
    for (const m of fl.members) {
      const rho = fl.radius * m.radiusMul * (1 + wob * fl.radiusWobbleAmp)
      const ang = fl.angle + m.phaseOffset
      _leaderDir
        .copy(fl.anchor)
        .multiplyScalar(Math.cos(rho))
        .addScaledVector(fl.radial, Math.sin(rho))
        .normalize()
      _leaderDir.applyAxisAngle(fl.anchor, ang)
      const ground = planet.sampleHeight(_leaderDir)
      const offset = clamp(
        m.groundOffset + Math.sin(simTime * fl.altWobbleFreq + m.altPhase) * fl.altWobbleAmp,
        fl.groundOffsetMin,
        fl.groundOffsetMax,
      )
      _fwd.crossVectors(fl.anchor, _leaderDir).normalize()
      _right.crossVectors(_leaderDir, _fwd).normalize()
      _fwd.crossVectors(_right, _leaderDir).normalize()
      _basisMat.makeBasis(_right, _leaderDir, _fwd)
      _baseQuat.setFromRotationMatrix(_basisMat)
      _rollQuat.setFromAxisAngle(_zAxis, bank)
      _instQuat.copy(_baseQuat).multiply(_rollQuat)
      _instPos.copy(_leaderDir).multiplyScalar(ground + offset)
      _scaleVec.setScalar(sizes[m.instanceIndex])
      _instMat.compose(_instPos, _instQuat, _scaleVec)
      mesh.setMatrixAt(m.instanceIndex, _instMat)
    }
  }

  function update(dt, camera) {
    const camDist = camera.position.length()
    if (camDist >= BIRDS_VISIBLE_DIST) {
      mesh.visible = false
      return
    }
    mesh.visible = true
    simTime += dt
    if (flapUniforms) flapUniforms.uTime.value = simTime
    for (const fl of migratoryFlocks) stepVFlock(fl, dt)
    for (const fl of gullFlocks) stepCircleFlock(fl, dt)
    for (const fl of forestFlocks) stepCircleFlock(fl, dt)
    mesh.instanceMatrix.needsUpdate = true
  }

  return { group, update }
}
