// Breath-of-the-Wild-style wind streaks: thin white curved lines that hug the
// terrain, race forward, and dissolve. A surface-level flourish only -- the
// group hides itself once the camera pulls back from the planet. Every
// streak's path and timing derives from `seed`, so a given seed + spawn
// order always produces the same sequence of streaks.
import * as THREE from 'three'
import { SEA_LEVEL, rngFromString, makeNoise3D, fbm, clamp, lerp, smoothstep } from './util.js'

const STREAK_COUNT = 7
const SURFACE_GAP = 0.004 // altitude above terrain/sea the streak glides at
const VISIBLE_DIST = 2.6 // camera.position.length() must be below this to show wind

// Tube shape. tubularSegments/radialSegments are the same for every streak,
// so the index-buffer stride used by the drawRange sweep in update() is a
// constant computed once below (see TubeGeometry's generateIndices: each
// tubular ring band contributes radialSegments quads = radialSegments*6
// indices, in one contiguous run -- exactly what setDrawRange needs to cut
// a clean cross-section out of the tube).
const RADIUS = 0.0005
const RADIAL_SEGMENTS = 5
const TUBULAR_SEGMENTS = 64
const INDEX_STRIDE = RADIAL_SEGMENTS * 6
const WINDOW_FRACTION = 0.35 // moving drawRange window covers this much of the tube
const WINDOW_BANDS = Math.round(TUBULAR_SEGMENTS * WINDOW_FRACTION)

// Path shape.
const MIN_ARC = 0.15 // radians of great-circle arc spanned by the whole streak
const MAX_ARC = 0.3
const MIN_POINTS = 50
const MAX_POINTS = 70
const WOBBLE_NOISE_SCALE = 3.5 // spatial frequency the heading-wobble noise is sampled at
const WOBBLE_GAIN = 5 // how sharply fbm bends the heading, per radian of arc travelled
const CURL_POINTS = 9 // trailing points that hook into a tiny curl flourish
const CURL_RATE = 0.55 // constant (non-noise) radians the heading spins per curl step
const CAMERA_BIAS_CHANCE = 0.85 // odds a back-hemisphere start gets mirrored to the front

// Lifecycle timing (seconds) and the opacity ramp riding on top of it.
const MIN_LIFE = 3.5
const MAX_LIFE = 5
const FADE_IN_END = 0.15 // fraction of life over which opacity ramps 0 -> peak
const FADE_OUT_START = 0.8 // fraction of life at which opacity starts ramping to 0
const PEAK_OPACITY = 0.55

export function createWind(planet, camera, seed) {
  const group = new THREE.Group()
  const noise3 = makeNoise3D(seed + ':wind:noise')
  let spawnCounter = 0

  const streaks = []
  for (let i = 0; i < STREAK_COUNT; i++) {
    const material = new THREE.MeshBasicMaterial({
      color: 0xeef6ff,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      opacity: 0,
    })
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), material)
    group.add(mesh)
    const streak = { mesh, material, age: 0, life: 1 }
    respawn(streak)
    streaks.push(streak)
  }

  // Picks a fresh seeded path and rebuilds the streak's tube geometry. Runs
  // 7x at startup and thereafter only when a streak finishes its life (every
  // few seconds) -- rebuilding a TubeGeometry here is fine; update() below
  // only ever touches setDrawRange + opacity, with zero allocations.
  function respawn(streak) {
    const rng = rngFromString(seed + ':wind:' + spawnCounter++)

    // Prefer the camera-facing hemisphere: a back-facing pick is usually
    // (not always, for variety) mirrored across the plane through the
    // origin perpendicular to the camera direction. Bias is only ever
    // recomputed here, at respawn.
    const dir = randomDirection(rng)
    const camDir = camera.position.clone().normalize()
    const facing = dir.dot(camDir)
    if (facing < 0 && rng() < CAMERA_BIAS_CHANCE) dir.addScaledVector(camDir, -2 * facing)
    dir.normalize()

    const totalArc = lerp(MIN_ARC, MAX_ARC, rng())
    const numPoints = MIN_POINTS + Math.floor(rng() * (MAX_POINTS - MIN_POINTS + 1))
    const stepArc = totalArc / (numPoints - 1)
    const curlSign = rng() < 0.5 ? 1 : -1
    // Per-streak noise offset so two streaks crossing similar ground still
    // wobble independently (decorrelates the shared noise field).
    const nx = rng() * 1000
    const ny = rng() * 1000
    const nz = rng() * 1000

    // Advance along a great circle from `dir`, heading held by `axis` (kept
    // perpendicular to the current position). Each step nudges `axis`
    // around the current position by a small angle -- fbm-driven for a
    // gust-like wobble along most of the path, then a constant spin for the
    // last few points to hook the tail into a tiny curl.
    const axis = perpendicular(rng, dir)
    const pos = dir // owned by this call; safe to mutate in place from here
    const points = [pos.clone().multiplyScalar(altitudeOf(planet, pos))]

    for (let i = 1; i < numPoints; i++) {
      const inCurl = i >= numPoints - CURL_POINTS
      const turn = inCurl
        ? CURL_RATE * curlSign
        : fbm(
            noise3,
            pos.x * WOBBLE_NOISE_SCALE + nx,
            pos.y * WOBBLE_NOISE_SCALE + ny,
            pos.z * WOBBLE_NOISE_SCALE + nz,
            3
          ) *
          WOBBLE_GAIN *
          stepArc
      axis.applyAxisAngle(pos, turn)
      const arc = inCurl ? stepArc * (1 - (i - (numPoints - CURL_POINTS)) / CURL_POINTS) : stepArc
      pos.applyAxisAngle(axis, arc).normalize()
      points.push(pos.clone().multiplyScalar(altitudeOf(planet, pos)))
    }

    streak.mesh.geometry.dispose()
    streak.mesh.geometry = new THREE.TubeGeometry(
      new THREE.CatmullRomCurve3(points),
      TUBULAR_SEGMENTS,
      RADIUS,
      RADIAL_SEGMENTS,
      false
    )
    streak.mesh.geometry.setDrawRange(0, 0)
    streak.age = 0
    streak.life = lerp(MIN_LIFE, MAX_LIFE, rng())
    streak.material.opacity = 0
  }

  function update(dt) {
    const visible = camera.position.length() < VISIBLE_DIST
    group.visible = visible
    if (!visible) return // wind is a surface-level detail; skip the geometry work below

    for (const streak of streaks) {
      streak.age += dt
      if (streak.age >= streak.life) {
        respawn(streak)
        continue
      }
      const p = streak.age / streak.life

      // Moving drawRange window over the index buffer: grows in from
      // nothing (draws on head-first), slides forward at constant width
      // (races forward), then shrinks to nothing as it overshoots the
      // tube's end (dissolves tail-last).
      const virtualHead = p * (TUBULAR_SEGMENTS + WINDOW_BANDS)
      const headBand = clamp(virtualHead, 0, TUBULAR_SEGMENTS)
      const tailBand = clamp(virtualHead - WINDOW_BANDS, 0, TUBULAR_SEGMENTS)
      const start = Math.floor(tailBand) * INDEX_STRIDE
      const end = Math.floor(headBand) * INDEX_STRIDE
      streak.mesh.geometry.setDrawRange(start, end - start)

      // Independent opacity ramp on top of the draw-range reveal/dissolve.
      const fadeIn = smoothstep(0, FADE_IN_END, p)
      const fadeOut = 1 - smoothstep(FADE_OUT_START, 1, p)
      streak.material.opacity = PEAK_OPACITY * fadeIn * fadeOut
    }
  }

  return { group, update }
}

// --- seeded path helpers (spawn-time only -- allocation here is fine) -----

function randomDirection(rng) {
  const z = rng() * 2 - 1
  const t = rng() * Math.PI * 2
  const r = Math.sqrt(Math.max(0, 1 - z * z))
  return new THREE.Vector3(r * Math.cos(t), r * Math.sin(t), z)
}

// A random unit vector perpendicular to `dir` -- the initial heading axis
// for the streak's great-circle path.
function perpendicular(rng, dir) {
  for (let tries = 0; tries < 4; tries++) {
    const rand = randomDirection(rng)
    const axis = rand.addScaledVector(dir, -rand.dot(dir))
    if (axis.lengthSq() > 1e-6) return axis.normalize()
  }
  // Degenerate fallback (measure-zero in practice): Gram-Schmidt off world-up.
  const up = Math.abs(dir.y) < 0.99 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)
  return up.addScaledVector(dir, -up.dot(dir)).normalize()
}

// Surface altitude (radius) a wind streak glides at over direction `dir`:
// hugs the terrain over land, but rides flat at sea level over open water
// (sampleHeight there is the ocean floor, well below the surface).
function altitudeOf(planet, dir) {
  const h = planet.isLand(dir) ? planet.sampleHeight(dir) : SEA_LEVEL
  return h + SURFACE_GAP
}
