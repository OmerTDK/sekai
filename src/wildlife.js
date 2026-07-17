// Roaming wildlife herds (living-world): loose groups of low-poly grazing
// quadrupeds (deer/cattle/bison-like) scattered on GRASSLAND biomes. Each
// herd drifts as a slow, seeded wander near its grassland anchor; individual
// animals sit on the terrain surface, oriented to the surface normal + the
// herd heading (with a per-animal yaw jitter so a grazing group faces loose,
// natural directions), and nod/bob in place as they graze.
//
// ONE InstancedMesh, animated purely by per-instance matrices recomposed each
// frame (the same rigid-body-per-instance technique sealife.js and birds.js
// use). Everything visual is a pure function of accumulated sim time + each
// animal's static per-animal phase constants, so distance-culling the visual
// pass costs nothing but a skipped loop -- state stays correct because there
// is no per-frame state to tick, only `simTime` accumulating.
//
// Contract (pinned): createWildlife(planet, seed) -> { group, update(dt, camera) }.
//
// Determinism: every structural and cosmetic choice comes from an
// rngFromString seed stream (birds.js/sealife.js convention). Herd count, per-
// herd anchor/wander/color, and per-animal offset/scale/graze-phase all derive
// from nested seed strings; no Math.random / Date.now anywhere, and sim time
// is accumulated from dt.
//
// Owns src/wildlife.js only. Additions are decorative -- nothing here touches
// or reads world.js session structures; herds only sample planet.biomeAt /
// sampleHeight for placement + ground-follow.
import * as THREE from 'three/webgpu'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { rngFromString, clamp, lerp } from './util.js'
import { tangentBasis } from './placement.js'

// ---------------------------------------------------------------------------
// Herds / animals.
// ---------------------------------------------------------------------------
const HERD_MIN = 4
const HERD_MAX = 8 // inclusive
const PER_HERD_MIN = 6
const PER_HERD_MAX = 12 // inclusive
const CAPACITY = HERD_MAX * PER_HERD_MAX // InstancedMesh hard capacity (96)

// Grassland selection thresholds (planet.biomeAt semantics -- see planet.js):
// moderate moisture (savanna..grassland, drier than the >0.55 forest band and
// wetter than the <0.3 desert band), rolling low-to-mid elevation, gentle
// slope, away from the polar caps. Same threshold style flora.js uses.
const WILD_MIN_MOISTURE = 0.3
const WILD_MAX_MOISTURE = 0.6
const WILD_MIN_LANDT = 0.05
const WILD_MAX_LANDT = 0.55
const WILD_MAX_SLOPE = 0.35
const WILD_MAX_POLAR = 0.35
const ANCHOR_TRIES = 3000

// Per-animal scatter within a herd (world-unit chord offsets on the sphere,
// small enough that renormalizing center + right*ox + fwd*oz is geodesic
// enough -- the herd stays a tight-ish grazing cluster).
const HERD_SPREAD = 0.013 // rad-ish, per-animal offset from the herd center
const YAW_JITTER = 0.9 // rad, per-animal heading spread off the herd heading

// Animal size (instance scale = world length of the body). Slightly larger
// than the birds so grazers read as ground animals at surface zoom.
const WILD_LEN_MIN = 0.011
const WILD_LEN_MAX = 0.017

// Herd wander: the center slowly loops near its grassland anchor. bearing and
// radial distance each oscillate on their own slow seeded sinusoid, tracing a
// bounded wandering arc (max ~radiusBase+radiusAmp rad from the anchor) so the
// herd never drifts off the grassland it was placed on.
const WANDER_RADIUS_BASE = 0.012
const WANDER_RADIUS_AMP = 0.01
const WANDER_RADIUS_FREQ_MIN = 0.015 // rad/s
const WANDER_RADIUS_FREQ_MAX = 0.04
const WANDER_SWEEP_AMP = 1.2 // rad of bearing sweep
const WANDER_SWEEP_FREQ_MIN = 0.02 // rad/s
const WANDER_SWEEP_FREQ_MAX = 0.05
const FWD_EPS = 0.15 // s -- finite-difference lookahead for the drift heading

// Grazing motion (subtle, so the rigid body reads as a nodding grazer, not a
// rearing one): a small whole-body nose-down nod + a tiny vertical bob, both
// eased sinusoids desynced per animal.
const GRAZE_PITCH_BASE = 0.05 // rad nose-down at rest (head already reaches down in geometry)
const GRAZE_PITCH_AMP = 0.12 // rad extra nod
const GRAZE_RATE_MIN = 0.4 // rad/s
const GRAZE_RATE_MAX = 1.1
const BOB_AMP_LOCAL = 0.04 // fraction of body length, vertical bob
const BOB_RATE_MIN = 0.8 // rad/s
const BOB_RATE_MAX = 1.8

const GROUND_EPS = 0.0003 // lift feet a hair off the terrain to avoid z-fighting
const CAMERA_CULL_DIST = 2.5 // R -- beyond this, skip the visual pass entirely

// Muted, naturalistic herd base colors (deer browns, cattle tans, bison
// darks). One geometry serves every herd; per-instance setColorAt tints each
// animal to its herd color, multiplied by the geometry's grayscale part-shade
// vertex colors (body brightest, legs/head/tail darker).
const HERD_COLORS = [
  0x6b5030, // deer brown
  0x4a3b2b, // bison dark brown
  0x8a7350, // tan cattle
  0x5c4a34, // chestnut
  0x77613f, // fawn
  0x3f342a, // dark bison
  0x9c8560, // light tan
  0x6e5a3e, // muddy brown
]

// ---------------------------------------------------------------------------
// Grayscale part shades (multiplied by the per-instance herd tint). Body is
// full-bright; extremities darker for cheap low-poly form.
// ---------------------------------------------------------------------------
const SHADE_BODY = 1.0
const SHADE_HUMP = 1.0
const SHADE_NECK = 0.9
const SHADE_HEAD = 0.82
const SHADE_MUZZLE = 0.62
const SHADE_EAR = 0.7
const SHADE_LEG = 0.6
const SHADE_TAIL = 0.55

let warnedAnchor = false
let warnedMerge = false

// ---------------------------------------------------------------------------
// Module-scope scratch (write-before-read only, never holds state across
// calls -- placement.js / sealife.js convention).
// ---------------------------------------------------------------------------
const _obT1 = new THREE.Vector3()
const _obT2 = new THREE.Vector3()
const _anchorDir = new THREE.Vector3()
const _center = new THREE.Vector3()
const _center2 = new THREE.Vector3()
const _fwd = new THREE.Vector3()
const _right = new THREE.Vector3()
const _animalDir = new THREE.Vector3()
const _headingFwd = new THREE.Vector3()
const _basisRight = new THREE.Vector3()
const _basisFwd = new THREE.Vector3()
const _basisMat4 = new THREE.Matrix4()
const _baseQuat = new THREE.Quaternion()
const _pitchQuat = new THREE.Quaternion()
const _combinedQuat = new THREE.Quaternion()
const _instPos = new THREE.Vector3()
const _instScale = new THREE.Vector3()
const _instMat = new THREE.Matrix4()
const _tintColor = new THREE.Color()
const X_AXIS = new THREE.Vector3(1, 0, 0)

// ---------------------------------------------------------------------------
// Spherical helpers (duplicated locally per this codebase's per-module
// convention -- see sealife.js's own note).
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

function randomUnitVector(rng, out) {
  const z = rng() * 2 - 1
  const t = rng() * Math.PI * 2
  const r = Math.sqrt(Math.max(0, 1 - z * z))
  return out.set(r * Math.cos(t), r * Math.sin(t), z)
}

/** up = surface normal, forward re-orthogonalized against it, into a quaternion
 *  (sealife.js's computeBaseQuat idiom). */
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

function composeMatrix(outMat, dir, radius, baseQuat, pitch, length) {
  _pitchQuat.setFromAxisAngle(X_AXIS, pitch)
  _combinedQuat.copy(baseQuat).multiply(_pitchQuat)
  _instPos.copy(dir).multiplyScalar(radius)
  _instScale.setScalar(length)
  outMat.compose(_instPos, _combinedQuat, _instScale)
}

// ---------------------------------------------------------------------------
// Geometry: a low-poly quadruped built from a handful of axis-aligned boxes,
// each painted with a flat grayscale part-shade vertex color, merged into one
// geometry. Local frame: +Z = nose (forward), +Y = up, feet at y=0. The head/
// neck already reach forward-and-down (a grazing rest pose) so the subtle nod
// animation reads unmistakably as grazing.
// ---------------------------------------------------------------------------
function makeBox(sx, sy, sz, cx, cy, cz, shade) {
  const geo = new THREE.BoxGeometry(sx, sy, sz)
  geo.translate(cx, cy, cz)
  const n = geo.attributes.position.count
  const arr = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    arr[i * 3] = shade
    arr[i * 3 + 1] = shade
    arr[i * 3 + 2] = shade
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3))
  return geo
}

function buildAnimalGeometry() {
  const parts = [
    // body trunk
    makeBox(0.3, 0.32, 0.72, 0, 0.56, 0, SHADE_BODY),
    // shoulder / bison hump
    makeBox(0.28, 0.16, 0.24, 0, 0.78, 0.16, SHADE_HUMP),
    // neck (reaching forward-down)
    makeBox(0.16, 0.2, 0.24, 0, 0.62, 0.42, SHADE_NECK),
    // head
    makeBox(0.16, 0.15, 0.22, 0, 0.5, 0.58, SHADE_HEAD),
    // muzzle
    makeBox(0.1, 0.1, 0.13, 0, 0.44, 0.71, SHADE_MUZZLE),
    // ears
    makeBox(0.03, 0.09, 0.05, 0.08, 0.6, 0.54, SHADE_EAR),
    makeBox(0.03, 0.09, 0.05, -0.08, 0.6, 0.54, SHADE_EAR),
    // legs (feet at y=0)
    makeBox(0.09, 0.4, 0.09, 0.11, 0.2, 0.24, SHADE_LEG),
    makeBox(0.09, 0.4, 0.09, -0.11, 0.2, 0.24, SHADE_LEG),
    makeBox(0.09, 0.4, 0.09, 0.11, 0.2, -0.24, SHADE_LEG),
    makeBox(0.09, 0.4, 0.09, -0.11, 0.2, -0.24, SHADE_LEG),
    // tail
    makeBox(0.05, 0.05, 0.16, 0, 0.58, -0.42, SHADE_TAIL),
  ]
  const merged = mergeGeometries(parts, false)
  if (!merged) {
    if (!warnedMerge) {
      warnedMerge = true
      console.warn(
        '[planet] wildlife.js: animal geometry merge degraded — mergeGeometries failed, shipping body-only geometry (legs/head lost)',
      )
    }
    return parts[0]
  }
  merged.computeBoundingSphere()
  return merged
}

// ---------------------------------------------------------------------------
// Grassland anchor search: rejection-sample a random land point matching the
// grassland biome thresholds (bounded budget + warn-once fallback, exactly
// placement.js's style).
// ---------------------------------------------------------------------------
function findGrasslandAnchor(planet, rng) {
  const biome = {}
  for (let tries = 0; tries < ANCHOR_TRIES; tries++) {
    randomUnitVector(rng, _anchorDir)
    if (!planet.isLand(_anchorDir)) continue
    planet.biomeAt(_anchorDir, biome)
    if (biome.moisture < WILD_MIN_MOISTURE || biome.moisture > WILD_MAX_MOISTURE) continue
    if (biome.landT < WILD_MIN_LANDT || biome.landT > WILD_MAX_LANDT) continue
    if (biome.slope >= WILD_MAX_SLOPE) continue
    if (biome.polar >= WILD_MAX_POLAR) continue
    return _anchorDir.clone()
  }
  if (!warnedAnchor) {
    warnedAnchor = true
    console.warn(
      '[planet] wildlife.js: grassland herd anchor search degraded — no matching grassland biome found within budget, falling back to a random land point',
    )
  }
  return _anchorDir.clone()
}

// ---------------------------------------------------------------------------
// createWildlife
// ---------------------------------------------------------------------------
export function createWildlife(planet, seed) {
  const group = new THREE.Group()

  const geo = buildAnimalGeometry()
  const material = new THREE.MeshStandardNodeMaterial({
    vertexColors: true,
    flatShading: true,
    roughness: 0.9,
    metalness: 0,
  })
  const mesh = new THREE.InstancedMesh(geo, material, CAPACITY)
  mesh.count = 0
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage) // every animal recomposed each frame
  mesh.frustumCulled = false // herds roam; no single static bounding volume applies
  group.add(mesh)

  const herds = []
  let count = 0

  const countRng = rngFromString(seed + ':wildlife:herd-count')
  const herdCount = HERD_MIN + Math.floor(countRng() * (HERD_MAX - HERD_MIN + 1))

  for (let h = 0; h < herdCount; h++) {
    const herdRng = rngFromString(seed + ':wildlife:herd:' + h)
    const anchor = findGrasslandAnchor(planet, herdRng)
    const baseColor = HERD_COLORS[Math.floor(herdRng() * HERD_COLORS.length)]
    const baseBearing = herdRng() * Math.PI * 2

    // Fallback drift heading (used only at the rare zero-velocity turnaround
    // of the wander path): the base-bearing tangent at the anchor.
    tangentBasis(anchor, _obT1, _obT2)
    const cb = Math.cos(baseBearing)
    const sb = Math.sin(baseBearing)
    const baseFwd = new THREE.Vector3(
      _obT1.x * cb + _obT2.x * sb,
      _obT1.y * cb + _obT2.y * sb,
      _obT1.z * cb + _obT2.z * sb,
    ).normalize()

    const herd = {
      anchor,
      baseBearing,
      baseFwd,
      sweepAmp: WANDER_SWEEP_AMP,
      sweepFreq: lerp(WANDER_SWEEP_FREQ_MIN, WANDER_SWEEP_FREQ_MAX, herdRng()),
      sweepPhase: herdRng() * Math.PI * 2,
      radiusBase: WANDER_RADIUS_BASE,
      radiusAmp: WANDER_RADIUS_AMP,
      radiusFreq: lerp(WANDER_RADIUS_FREQ_MIN, WANDER_RADIUS_FREQ_MAX, herdRng()),
      radiusPhase: herdRng() * Math.PI * 2,
      animals: [],
    }

    const size = PER_HERD_MIN + Math.floor(herdRng() * (PER_HERD_MAX - PER_HERD_MIN + 1))
    for (let i = 0; i < size && count < CAPACITY; i++) {
      const aRng = rngFromString(seed + ':wildlife:animal:' + h + ':' + i)
      const idx = count++
      const a = {
        idx,
        ox: (aRng() * 2 - 1) * HERD_SPREAD,
        oz: (aRng() * 2 - 1) * HERD_SPREAD,
        yaw: (aRng() * 2 - 1) * YAW_JITTER,
        length: lerp(WILD_LEN_MIN, WILD_LEN_MAX, aRng()),
        grazePhase: aRng() * Math.PI * 2,
        grazeRate: lerp(GRAZE_RATE_MIN, GRAZE_RATE_MAX, aRng()),
        bobPhase: aRng() * Math.PI * 2,
        bobRate: lerp(BOB_RATE_MIN, BOB_RATE_MAX, aRng()),
      }
      // Per-animal color: herd base tinted by a small deterministic jitter.
      _tintColor.setHex(baseColor)
      _tintColor.r = clamp(_tintColor.r * (0.88 + aRng() * 0.2), 0, 1)
      _tintColor.g = clamp(_tintColor.g * (0.88 + aRng() * 0.2), 0, 1)
      _tintColor.b = clamp(_tintColor.b * (0.88 + aRng() * 0.2), 0, 1)
      mesh.setColorAt(idx, _tintColor)
      herd.animals.push(a)
    }
    herds.push(herd)
  }

  mesh.count = count
  mesh.instanceMatrix.needsUpdate = true
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true

  /** Herd center at sim time t: bearing + radial distance each on a slow
   *  seeded sinusoid, offset from the anchor. */
  function herdCenterAt(herd, t, out) {
    const bearing = herd.baseBearing + herd.sweepAmp * Math.sin(herd.sweepFreq * t + herd.sweepPhase)
    const dist = herd.radiusBase + herd.radiusAmp * Math.sin(herd.radiusFreq * t + herd.radiusPhase)
    return offsetPoint(herd.anchor, bearing, dist, out)
  }

  let simTime = 0

  function update(dt, camera) {
    simTime += dt

    const camDist = camera && camera.position ? camera.position.length() : 0
    const near = camDist <= CAMERA_CULL_DIST
    mesh.visible = near && count > 0
    if (!near) return

    for (let h = 0; h < herds.length; h++) {
      const herd = herds[h]
      herdCenterAt(herd, simTime, _center)
      herdCenterAt(herd, simTime + FWD_EPS, _center2)

      // Drift heading = tangent from center(t) toward center(t+eps); fall back
      // to the herd's base tangent at the rare zero-velocity turnaround.
      _fwd.copy(_center2).sub(_center)
      _fwd.addScaledVector(_center, -_fwd.dot(_center))
      if (_fwd.lengthSq() > 1e-12) _fwd.normalize()
      else _fwd.copy(herd.baseFwd)
      _right.crossVectors(_center, _fwd).normalize()

      for (let i = 0; i < herd.animals.length; i++) {
        const a = herd.animals[i]
        // Scatter position in the herd's tangent frame (small offsets, so the
        // renormalize stays geodesic enough), snapped down onto the terrain.
        _animalDir.copy(_center).addScaledVector(_right, a.ox).addScaledVector(_fwd, a.oz).normalize()
        // Individual heading = herd heading rotated about this animal's own
        // surface normal by its static yaw jitter (grazers face loose ways).
        _headingFwd.copy(_fwd).applyAxisAngle(_animalDir, a.yaw)
        computeBaseQuat(_baseQuat, _animalDir, _headingFwd)

        const nod =
          GRAZE_PITCH_BASE + GRAZE_PITCH_AMP * (0.5 + 0.5 * Math.sin(simTime * a.grazeRate + a.grazePhase))
        const bob = a.length * BOB_AMP_LOCAL * Math.sin(simTime * a.bobRate + a.bobPhase)
        const surfaceR = planet.sampleHeight(_animalDir)
        composeMatrix(_instMat, _animalDir, surfaceR + GROUND_EPS + bob, _baseQuat, nod, a.length)
        mesh.setMatrixAt(a.idx, _instMat)
      }
    }
    mesh.instanceMatrix.needsUpdate = true
  }

  return { group, update }
}
