// Deterministic placement math: where settlements/structures/wander-points
// land on the planet surface, and the spherical-geometry helpers (tangent
// bases, great-circle stepping, surface orientation) they're built from.
// Pure functions — no dependency on live world state beyond the `planet`
// argument each search takes. Split out of world.js (see the M2 program
// plan) along that file's own section boundaries — no behavior change, only
// where this code lives.
import * as THREE from 'three'
import { SEA_LEVEL, clamp } from './util.js'

const MAX_BUILD_HEIGHT = SEA_LEVEL + 0.03 // sampleHeight() must be below this to build/walk

const ANCHOR_SEARCH_TRIES = 600
const ANCHOR_STEP = 0.05
const STRUCT_SEARCH_RADIUS = 0.05
const STRUCT_MIN_SEP = 0.012
const STRUCT_SEARCH_HARD_CAP = 400

// ---------------------------------------------------------------------------
// Spherical math helpers (pure — no dependency on the live planet/world state)
// ---------------------------------------------------------------------------

const _tb1 = new THREE.Vector3()
const _tb2 = new THREE.Vector3()

/** Arbitrary orthonormal tangent basis at a point on the unit sphere. */
export function tangentBasis(dir, outT1, outT2) {
  if (Math.abs(dir.y) < 0.999) outT1.set(0, 1, 0).cross(dir).normalize()
  else outT1.set(1, 0, 0).cross(dir).normalize()
  outT2.crossVectors(dir, outT1).normalize()
}

/** Writes into `out` the point `dist` radians from `base` along `bearing`. */
function sphericalOffset(out, base, bearing, dist) {
  tangentBasis(base, _tb1, _tb2)
  const cb = Math.cos(bearing)
  const sb = Math.sin(bearing)
  const tx = _tb1.x * cb + _tb2.x * sb
  const ty = _tb1.y * cb + _tb2.y * sb
  const tz = _tb1.z * cb + _tb2.z * sb
  const cd = Math.cos(dist)
  const sd = Math.sin(dist)
  out.set(base.x * cd + tx * sd, base.y * cd + ty * sd, base.z * cd + tz * sd).normalize()
}

/** A unit tangent at `dir` rotated to bearing `yaw` — used to give structures a facing. */
export function yawedTangent(dir, yaw, out) {
  tangentBasis(dir, _tb1, _tb2)
  const cb = Math.cos(yaw)
  const sb = Math.sin(yaw)
  return out.set(_tb1.x * cb + _tb2.x * sb, _tb1.y * cb + _tb2.y * sb, _tb1.z * cb + _tb2.z * sb).normalize()
}

/** Moves `current` at most `maxAngle` radians toward `target` along the great circle. Returns true if arrived. */
export function stepToward(current, target, maxAngle) {
  const d = clamp(current.dot(target), -1, 1)
  const angle = Math.acos(d)
  if (angle < 1e-5) return true
  const t = Math.min(1, maxAngle / angle)
  current.lerp(target, t).normalize()
  return t >= 1
}

const _up = new THREE.Vector3()
const _right = new THREE.Vector3()
const _fwd = new THREE.Vector3()
const _basisMat = new THREE.Matrix4()

/** Orients `object` so local +Y matches the surface normal `dir` and local +Z faces `forwardHint`. */
export function orientOnSurface(object, dir, forwardHint) {
  _up.copy(dir).normalize()
  _fwd.copy(forwardHint)
  _fwd.addScaledVector(_up, -_fwd.dot(_up))
  if (_fwd.lengthSq() < 1e-10) {
    _fwd.set(1, 0, 0).addScaledVector(_up, -_up.x)
    if (_fwd.lengthSq() < 1e-10) _fwd.set(0, 0, 1)
  }
  _fwd.normalize()
  _right.crossVectors(_up, _fwd).normalize()
  _fwd.crossVectors(_right, _up).normalize()
  _basisMat.makeBasis(_right, _up, _fwd)
  object.quaternion.setFromRotationMatrix(_basisMat)
}

// ---------------------------------------------------------------------------
// Silent-fallback rule: every graceful-degradation path warns exactly once
// (module-level flags — these searches run per-settlement/per-structure and
// the ingest/poll paths repeat every 4s, so a plain warn would spam).
// ---------------------------------------------------------------------------
let warnedLandAnchorFallback = false
let warnedStructureSpotFallback = false
let warnedLandNearFallback = false

export function findLandAnchor(planet, base, rng) {
  const dir = base.clone()
  for (let i = 0; i <= ANCHOR_SEARCH_TRIES; i++) {
    if (planet.isLand(dir) && planet.sampleHeight(dir) < MAX_BUILD_HEIGHT) return dir
    if (i === ANCHOR_SEARCH_TRIES) break
    dir
      .set(
        dir.x + (rng() - 0.5) * ANCHOR_STEP,
        dir.y + (rng() - 0.5) * ANCHOR_STEP,
        dir.z + (rng() - 0.5) * ANCHOR_STEP,
      )
      .normalize()
  }
  if (!warnedLandAnchorFallback) {
    warnedLandAnchorFallback = true
    console.warn(
      '[planet] world.js: settlement anchor placement degraded — exhausted search budget, using best-effort location (may be underwater or above build height)',
    )
  }
  return dir // best-effort last (island worlds happen)
}

export function findStructureSpot(planet, anchorDir, rng, siblings) {
  let radius = STRUCT_SEARCH_RADIUS
  let minSep = STRUCT_MIN_SEP
  const dir = new THREE.Vector3()
  let fallback = null
  for (let tries = 1; tries <= STRUCT_SEARCH_HARD_CAP; tries++) {
    const bearing = rng() * Math.PI * 2
    const dist = Math.sqrt(rng()) * radius
    sphericalOffset(dir, anchorDir, bearing, dist)
    if (!fallback) fallback = dir.clone()
    if (planet.isLand(dir) && planet.sampleHeight(dir) < MAX_BUILD_HEIGHT) {
      let ok = true
      for (let i = 0; i < siblings.length; i++) {
        if (dir.angleTo(siblings[i]) < minSep) {
          ok = false
          break
        }
      }
      if (ok) return dir.clone()
    }
    if (tries % 80 === 0) {
      minSep *= 0.82
      radius = Math.min(radius * 1.15, 0.14)
    }
  }
  if (!warnedStructureSpotFallback) {
    warnedStructureSpotFallback = true
    console.warn(
      '[planet] world.js: structure placement degraded — exhausted search budget, using fallback spot (may overlap a sibling or sit on unsuitable ground)',
    )
  }
  return fallback || anchorDir.clone()
}

export function randomLandNear(planet, center, rng, maxRadius) {
  const out = new THREE.Vector3()
  let fallback = null
  for (let i = 0; i < 120; i++) {
    const bearing = rng() * Math.PI * 2
    const dist = Math.sqrt(rng()) * maxRadius
    sphericalOffset(out, center, bearing, dist)
    if (!fallback) fallback = out.clone()
    if (planet.isLand(out) && planet.sampleHeight(out) < MAX_BUILD_HEIGHT) return out.clone()
  }
  if (!warnedLandNearFallback) {
    warnedLandNearFallback = true
    console.warn(
      '[planet] world.js: agent wander-point placement degraded — exhausted search budget, using fallback location (may be underwater or above build height)',
    )
  }
  return fallback || center.clone()
}
