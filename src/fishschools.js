// Boids fish schools shimmering just under the ocean surface. Small tight
// shoals tethered to seeded shallow-water anchors near the coastline, so they
// stay visible where the camera actually goes (surface flights over
// coastlines), rather than scattered pointlessly across deep ocean.
//
// ONE InstancedMesh (one draw call) for every fish in every school. All
// motion is CPU boids -> instanceMatrix, exactly the rigid-body-per-instance
// technique sealife.js/birds.js/wildlife.js already use -- no ShaderMaterial,
// no custom per-instance vertex attributes (WebGPU-backend safe), animation
// is instance-matrix only.
//
// Contract (pinned): createFishSchools(planet, seed) -> { group, update(dt, camera) }.
//
// Determinism: coastal anchors and each fish's initial tangent-plane offset,
// heading and rest depth come from rngFromString(seed+':fish:...') streams
// (no Math.random/Date.now anywhere). The boids simulation thereafter is
// driven ONLY by the accumulated presentation dt clock -- exactly the
// allowed "presentation state" precedent sealife.js's whale/dolphin pose
// state and wildlife.js's herd wander already establish.
//
// Covenant: sim-owned prop, presentation only. Fish never read or write any
// world.js session structure -- they only ever sample planet.isLand for
// anchor placement at construction time.
import * as THREE from 'three/webgpu'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { SEA_LEVEL, rngFromString, clamp, lerp } from './util.js'
import { tangentBasis } from './placement.js'

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------
const SCHOOL_COUNT = 6
const FISH_PER_SCHOOL = 28
const CAPACITY = SCHOOL_COUNT * FISH_PER_SCHOOL // 168, one fixed-size draw call, always fully populated

const CAMERA_CULL_DIST = 2.2 // R -- beyond this, skip the mesh + all boids work entirely

// -- anchor search: a shallow-water point near a coastline (nearCoast-style
// ring probe, sealife.js's dolphin-anchor idiom) --
const ANCHOR_RING_RADIUS = 0.02 // rad, coastline-crossing probe radius
const ANCHOR_RING_PROBES = 8
const ANCHOR_TRIES = 3000

// -- per-fish scatter around the anchor --
const SCHOOL_SPREAD = 0.006 // rad-ish, initial tangent-plane offset radius from the anchor
const FISH_LENGTH = 0.003 // world-unit body length (spec: "~0.003 long")

// -- depth band: always just under SEA_LEVEL, never breaching, never on the
// seafloor (hard-clamped every frame, see updateBoids below) --
const DEPTH_MIN = -0.006
const DEPTH_MAX = -0.001
const DEPTH_BOB_AMP = 0.0012 // small vertical breathing so the school isn't perfectly flat
const DEPTH_BOB_RATE_MIN = 0.5 // rad/s
const DEPTH_BOB_RATE_MAX = 1.1

// -- boids weights. Flocking only ever happens WITHIN a school (never across
// schools -- O(n^2) per school stays cheap at FISH_PER_SCHOOL=28, per the
// spec's own risk note) --
const SEPARATION_DIST = 0.0015 // rad-ish, push-apart radius
const SEPARATION_WEIGHT = 2.2
const ALIGN_DIST = 0.004 // rad-ish, neighbor heading-match radius
const ALIGN_WEIGHT = 1.1
const COHESION_WEIGHT = 0.5 // pull toward the school's own instantaneous centroid
const TETHER_WEIGHT = 2.0 // spring pulling back toward the seeded anchor -- keeps the school in the shallows
const MAX_SPEED = 0.03 // rad/s tangential swim speed cap
const MIN_SPEED = 0.006 // fish never fully stop -- keeps the shimmer alive
const DAMPING = 0.92 // per-frame velocity damping (stability, not physical drag)

const COLOR_TOP = 0x39525c // dorsal -- dark slate (muted countershaded tone, no glow/emissive)
const COLOR_BELLY = 0xbfc9c4 // ventral/flanks -- pale

// ---------------------------------------------------------------------------
// Geometry: one small flattened diamond body (2 tris) + a flared tail fin (1
// tri), merged into ONE non-indexed BufferGeometry -- the birds.js/sealife.js
// flat-blade idiom. Local frame: +X right, +Y up (the blade itself is near-
// flat, no local-Y extent), +Z forward (nose at +Z). DoubleSide (set on the
// shared material below) so the flat blade never backface-culls as a fish
// turns or is viewed from beneath.
// ---------------------------------------------------------------------------
let warnedFishMerge = false

function makePart(positions, indices, colorSpec) {
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3))
  geo.setIndex(indices)
  const n = positions.length / 3
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

export function buildFishGeometry() {
  const bodyPos = [
    0, 0, 0.5, // 0 nose
    0.13, 0, -0.03, // 1 right flank
    0, 0, -0.32, // 2 tail root (spine)
    -0.13, 0, -0.03, // 3 left flank
  ]
  const bodyIdx = [0, 1, 2, 0, 2, 3]
  const bodyColors = [COLOR_TOP, COLOR_BELLY, COLOR_TOP, COLOR_BELLY]

  const tailPos = [
    0, 0, -0.32, // 0 tail root (shared spine point)
    0.09, 0, -0.52, // 1 tail tip right
    -0.09, 0, -0.52, // 2 tail tip left
  ]
  const tailIdx = [0, 1, 2]
  const tailColors = [COLOR_TOP, COLOR_BELLY, COLOR_BELLY]

  const body = makePart(bodyPos, bodyIdx, bodyColors)
  const tail = makePart(tailPos, tailIdx, tailColors)
  const merged = mergeGeometries([body, tail], false)
  if (!merged && !warnedFishMerge) {
    warnedFishMerge = true
    console.warn(
      '[planet] fishschools.js: fish geometry merge degraded — mergeGeometries failed, shipping body-only geometry (tail lost)',
    )
  }
  const geo = merged || body
  geo.computeBoundingSphere()
  return geo
}

// ---------------------------------------------------------------------------
// Pure spherical-geometry helpers (duplicated locally per this codebase's own
// convention -- see sealife.js's comment on why these small write-before-read
// helpers are copied per-module rather than exported).
// ---------------------------------------------------------------------------
const _obT1 = new THREE.Vector3()
const _obT2 = new THREE.Vector3()
const _ringProbe = new THREE.Vector3()

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

/** Deterministic, uniformly-distributed random unit vector, written into `out`. */
function randUnitVector(rng, out) {
  const z = rng() * 2 - 1
  const t = rng() * Math.PI * 2
  const r = Math.sqrt(Math.max(0, 1 - z * z))
  return out.set(r * Math.cos(t), r * Math.sin(t), z)
}

/** True if `dir` is ocean but at least one point on a `radius`-ring around it is land (a coastline is nearby). */
function nearCoast(planet, dir, radius, probes) {
  if (planet.isLand(dir)) return false
  for (let i = 0; i < probes; i++) {
    const a = (i / probes) * Math.PI * 2
    offsetPoint(dir, a, radius, _ringProbe)
    if (planet.isLand(_ringProbe)) return true
  }
  return false
}

let warnedAnchor = false
function findShallowAnchor(planet, rng) {
  const dir = new THREE.Vector3()
  for (let i = 0; i < ANCHOR_TRIES; i++) {
    randUnitVector(rng, dir)
    if (nearCoast(planet, dir, ANCHOR_RING_RADIUS, ANCHOR_RING_PROBES)) return dir.clone()
  }
  if (!warnedAnchor) {
    warnedAnchor = true
    console.warn(
      '[planet] fishschools.js: shallow-coast school anchor search degraded — no coastline found within budget, falling back to a best-effort ocean point',
    )
  }
  return dir.clone()
}

// ---------------------------------------------------------------------------
// createFishSchools
// ---------------------------------------------------------------------------
export function createFishSchools(planet, seed) {
  const group = new THREE.Group()

  const fishGeo = buildFishGeometry()
  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    flatShading: true,
    roughness: 0.7,
    metalness: 0.03,
    side: THREE.DoubleSide,
  })
  const mesh = new THREE.InstancedMesh(fishGeo, material, CAPACITY)
  mesh.count = CAPACITY // fixed-size population (SCHOOL_COUNT x FISH_PER_SCHOOL are both constants) -- always fully populated
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage) // every fish recomposed each near-camera frame
  mesh.frustumCulled = false // fish drift within their school; no single static bounding volume applies
  group.add(mesh)

  // --- seeded anchors + per-fish initial state -----------------------------
  const schools = []
  const _initT1 = new THREE.Vector3()
  const _initT2 = new THREE.Vector3()
  for (let p = 0; p < SCHOOL_COUNT; p++) {
    const schoolRng = rngFromString(seed + ':fish:school:' + p)
    const anchorDir = findShallowAnchor(planet, schoolRng)

    const fish = []
    for (let i = 0; i < FISH_PER_SCHOOL; i++) {
      const fishRng = rngFromString(seed + ':fish:' + p + ':' + i)
      const bearing = fishRng() * Math.PI * 2
      const dist = Math.sqrt(fishRng()) * SCHOOL_SPREAD // uniform disk sample
      const currentDir = offsetPoint(anchorDir, bearing, dist, new THREE.Vector3())

      const headBearing = fishRng() * Math.PI * 2
      tangentBasis(currentDir, _initT1, _initT2)
      const cb = Math.cos(headBearing)
      const sb = Math.sin(headBearing)
      const speed0 = lerp(MIN_SPEED, MAX_SPEED * 0.5, fishRng())
      const velocity = new THREE.Vector3(
        (_initT1.x * cb + _initT2.x * sb) * speed0,
        (_initT1.y * cb + _initT2.y * sb) * speed0,
        (_initT1.z * cb + _initT2.z * sb) * speed0,
      )

      const restDepth = lerp(DEPTH_MIN, DEPTH_MAX, fishRng())
      fish.push({
        idx: p * FISH_PER_SCHOOL + i,
        currentDir,
        velocity,
        restDepth,
        altOffset: restDepth,
        bobPhase: fishRng() * Math.PI * 2,
        bobRate: lerp(DEPTH_BOB_RATE_MIN, DEPTH_BOB_RATE_MAX, fishRng()),
      })
    }
    schools.push({ anchorDir, fish })
  }

  // --- per-frame boids scratch (module-call-local, reused every frame -- no
  // per-fish/per-frame allocation) ---
  const _centroid = new THREE.Vector3()
  const _diff = new THREE.Vector3()
  const _sep = new THREE.Vector3()
  const _align = new THREE.Vector3()
  const _cohesion = new THREE.Vector3()
  const _tether = new THREE.Vector3()
  const _accel = new THREE.Vector3()
  const _up = new THREE.Vector3()
  const _fwd = new THREE.Vector3()
  const _right = new THREE.Vector3()
  const _t1 = new THREE.Vector3()
  const _t2 = new THREE.Vector3()
  const _basisMat = new THREE.Matrix4()
  const _quat = new THREE.Quaternion()
  const _instPos = new THREE.Vector3()
  const _instScale = new THREE.Vector3()
  const _instMat = new THREE.Matrix4()

  const sepDistSq = SEPARATION_DIST * SEPARATION_DIST
  const alignDistSq = ALIGN_DIST * ALIGN_DIST

  function updateBoids(dt) {
    for (let s = 0; s < schools.length; s++) {
      const school = schools[s]
      const fish = school.fish
      const n = fish.length

      // School-wide cohesion target: instantaneous centroid of the flock.
      _centroid.set(0, 0, 0)
      for (let i = 0; i < n; i++) _centroid.add(fish[i].currentDir)
      _centroid.multiplyScalar(1 / n)
      if (_centroid.lengthSq() > 1e-12) _centroid.normalize()
      else _centroid.copy(school.anchorDir)

      for (let i = 0; i < n; i++) {
        const f = fish[i]
        _sep.set(0, 0, 0)
        _align.set(0, 0, 0)
        let alignCount = 0

        for (let j = 0; j < n; j++) {
          if (j === i) continue
          const g = fish[j]
          _diff.copy(f.currentDir).sub(g.currentDir)
          const distSq = _diff.lengthSq()
          if (distSq > 1e-12 && distSq < sepDistSq) {
            _sep.addScaledVector(_diff, 1 / distSq) // stronger push the closer the neighbor
          }
          if (distSq < alignDistSq) {
            _align.add(g.velocity)
            alignCount++
          }
        }
        if (alignCount > 0) _align.multiplyScalar(1 / alignCount).sub(f.velocity)

        _cohesion.copy(_centroid).sub(f.currentDir)
        _tether.copy(school.anchorDir).sub(f.currentDir)

        _accel.set(0, 0, 0)
        _accel.addScaledVector(_sep, SEPARATION_WEIGHT)
        _accel.addScaledVector(_align, ALIGN_WEIGHT)
        _accel.addScaledVector(_cohesion, COHESION_WEIGHT)
        _accel.addScaledVector(_tether, TETHER_WEIGHT)
        // Keep the acceleration tangent to the sphere at this fish's position.
        _accel.addScaledVector(f.currentDir, -_accel.dot(f.currentDir))

        f.velocity.addScaledVector(_accel, dt)
        // Re-project velocity too, guarding against a radial component
        // creeping in from repeated tangent-plane approximations.
        f.velocity.addScaledVector(f.currentDir, -f.velocity.dot(f.currentDir))
        f.velocity.multiplyScalar(DAMPING)
        const speed = f.velocity.length()
        if (speed > MAX_SPEED) f.velocity.multiplyScalar(MAX_SPEED / speed)
        else if (speed > 1e-9 && speed < MIN_SPEED) f.velocity.multiplyScalar(MIN_SPEED / speed)

        f.currentDir.addScaledVector(f.velocity, dt).normalize()

        // Depth: gentle bob around a per-fish rest depth, hard-clamped to the
        // allowed under-surface band every frame (never breaches, never
        // touches the seafloor).
        f.bobPhase += dt * f.bobRate
        f.altOffset = clamp(f.restDepth + Math.sin(f.bobPhase) * DEPTH_BOB_AMP, DEPTH_MIN, DEPTH_MAX)

        // Compose this fish's instance matrix: up = surface normal (its own
        // position direction), forward = normalized velocity projected onto
        // the tangent plane (fallback to a stable tangent when ~stationary).
        _up.copy(f.currentDir)
        if (speed > 1e-9) {
          _fwd.copy(f.velocity).normalize()
        } else {
          tangentBasis(_up, _t1, _t2)
          _fwd.copy(_t1)
        }
        _right.crossVectors(_up, _fwd)
        if (_right.lengthSq() < 1e-10) {
          tangentBasis(_up, _t1, _t2)
          _right.copy(_t1)
        } else {
          _right.normalize()
        }
        _fwd.crossVectors(_right, _up).normalize()
        _basisMat.makeBasis(_right, _up, _fwd)
        _quat.setFromRotationMatrix(_basisMat)
        _instPos.copy(f.currentDir).multiplyScalar(SEA_LEVEL + f.altOffset)
        _instScale.setScalar(FISH_LENGTH)
        _instMat.compose(_instPos, _quat, _instScale)
        mesh.setMatrixAt(f.idx, _instMat)
      }
    }
    mesh.instanceMatrix.needsUpdate = true
  }

  // Bake an initial pose immediately (dt=0 -- composes matrices from the
  // seeded initial state without advancing any motion), so the very first
  // rendered frame already shows correctly-posed fish rather than identity
  // matrices, regardless of when update() first runs.
  updateBoids(0)
  mesh.computeBoundingSphere()

  function update(dt, camera) {
    const camDist = camera && camera.position ? camera.position.length() : 0
    if (camDist > CAMERA_CULL_DIST) {
      mesh.visible = false
      return
    }
    mesh.visible = true
    updateBoids(dt)
  }

  return { group, update }
}
