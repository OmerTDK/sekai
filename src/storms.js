// Hurricanes: a spiral cloud system that drifts across the ocean, spins up,
// matures, and dissipates over land -- ISS-photo look (dense white core, a
// dark eye ringed by a bright eyewall, ragged log-spiral feeder bands).
// Everything is derived from `seed` + a per-storm spawn counter, so a given
// seed always produces the same sequence of storms (origin, track, texture).
import * as THREE from 'three'
import { rngFromString, makeNoise3D, fbm, clamp, lerp, smoothstep } from './util.js'

// ---------------------------------------------------------------------------
// Texture (procedural canvas, drawn once per storm spawn, polar coordinates
// around the texture center). All radii below are fractions of the texture
// radius (texture is TEX_SIZE^2, center at TEX_SIZE/2, radius TEX_SIZE/2).
// ---------------------------------------------------------------------------
const TEX_SIZE = 1024
const EYE_R = 0.05 // fully transparent inside this radius
const WALL_R = 0.12 // bright dense eyewall annulus sits between EYE_R and here
const CORE_R = 0.3 // central dense overcast: high density out to here
const CORE_SOFT = 0.06 // core-edge falloff width, before jitter
const CORE_JITTER = 0.05 // noise jitter on the core/eyewall boundary radii -> ragged, not a perfect circle
const EYE_JITTER = 0.012 // smaller jitter on the eye/eyewall boundary itself
// Beyond this radius the disc term is always ~0 -- skip its noise sample
// there entirely (most of the canvas), which is what keeps generation fast.
const CORE_NOISE_CUTOFF = CORE_R + CORE_SOFT + CORE_JITTER + 0.03
const BAND_OUTER = 1.05 // beyond this the band taper is always 0 -- skip its noise sample too
const MOTTLE_FREQ = 0.01 // spatial frequency (per texel) of the core mottle/edge-jitter noise
const RAGGED_FREQ_MIN = 0.012 // spatial frequency range of the band raggedness noise (seeded per storm)
const RAGGED_FREQ_MAX = 0.02
const ARM_TIGHTNESS_MIN = 2.2 // log-spiral winding: ~2-3 turns from the core edge to the texture edge
const ARM_TIGHTNESS_MAX = 3.4
const ARM_SHARPNESS_MIN = 1.5 // pow() exponent on the arm profile -- higher = thinner ridges
const ARM_SHARPNESS_MAX = 2.2

// Central dense overcast + eyewall: 0 inside the eye, ramps to a bright
// bump through the eyewall, then a mottled near-uniform disc out to CORE_R
// with a noise-jittered (not perfectly circular) outer edge.
function discDensity(r, mottleN) {
  const eyeJ = EYE_R + mottleN * EYE_JITTER
  const wallJ = WALL_R + mottleN * EYE_JITTER
  const coreJ = CORE_R + mottleN * CORE_JITTER
  if (r < eyeJ) return 0
  const intoWall = smoothstep(eyeJ, eyeJ + 0.02, r)
  const wallBump = Math.exp(-(((r - (eyeJ + wallJ) * 0.5) / 0.032) ** 2)) * 0.4
  const discMask = 1 - smoothstep(coreJ, coreJ + CORE_SOFT, r)
  const mottleT = clamp(mottleN * 0.5 + 0.5, 0, 1)
  const base = lerp(0.75, 1.0, mottleT) * discMask
  return clamp(intoWall * (base + wallBump), 0, 1)
}

// Log-spiral feeder bands: density = pow(max(0, sin(armCount*(theta -
// tightness*log(r)))), sharpness), modulated by a radial taper (ramps in
// past the core, fades hard toward the texture edge) and multiplied by fbm
// raggedness so the bands read as torn/cellular cumulus lines, not smooth
// ribbons -- the raggedness threshold is also biased by radius so bands get
// visibly gappier/wispier the further out they go.
function bandDensity(r, theta, cfg, raggedN) {
  const phase = theta - cfg.chirality * cfg.tightness * Math.log(r)
  const raw = Math.sin(cfg.armCount * phase)
  const shape = Math.pow(Math.max(0, raw), cfg.sharpness)

  const riseTaper = smoothstep(WALL_R, CORE_R + 0.02, r)
  const fallT = clamp((r - CORE_R) / (BAND_OUTER - CORE_R), 0, 1)
  const fallTaper = Math.pow(1 - fallT, 0.9)

  const raggedT = raggedN * 0.5 + 0.5
  const threshold = 0.3 + (r - CORE_R) * 0.38
  const raggedShape = smoothstep(threshold - 0.16, threshold + 0.16, raggedT)

  // keep the arms readable well past the core — the ISS look lives or dies
  // on visible feeder bands
  return clamp(shape * 1.2, 0, 1) * riseTaper * fallTaper * lerp(0.1, 1.0, raggedShape)
}

// Builds one storm's alpha texture. `rng` is the storm's own spawn RNG
// (shared with origin/track picking, so the whole storm is one deterministic
// draw sequence); `texSeed` seeds the two noise fields. `spinSign` ties the
// spiral's winding handedness to the storm's actual cyclonic rotation
// direction (set in spawn()), so the bands trail consistently with the spin.
function makeHurricaneTexture(rng, texSeed, spinSign) {
  const noiseMottle = makeNoise3D(texSeed + ':mottle')
  const noiseRagged = makeNoise3D(texSeed + ':ragged')

  const cfg = {
    armCount: rng() < 0.5 ? 2 : 3,
    tightness: lerp(ARM_TIGHTNESS_MIN, ARM_TIGHTNESS_MAX, rng()),
    sharpness: lerp(ARM_SHARPNESS_MIN, ARM_SHARPNESS_MAX, rng()),
    chirality: spinSign,
  }
  const raggedFreq = lerp(RAGGED_FREQ_MIN, RAGGED_FREQ_MAX, rng())
  const zMottle = rng() * 1000
  const zRagged = rng() * 1000

  const canvas = document.createElement('canvas')
  canvas.width = TEX_SIZE
  canvas.height = TEX_SIZE
  const ctx = canvas.getContext('2d')
  const img = ctx.createImageData(TEX_SIZE, TEX_SIZE)
  const data = img.data

  const R = TEX_SIZE / 2
  for (let y = 0; y < TEX_SIZE; y++) {
    const dy = y - R
    const row = y * TEX_SIZE
    for (let x = 0; x < TEX_SIZE; x++) {
      const dx = x - R
      const r = Math.sqrt(dx * dx + dy * dy) / R

      let disc = 0
      if (r < CORE_NOISE_CUTOFF) {
        const mottleN = fbm(noiseMottle, dx * MOTTLE_FREQ, dy * MOTTLE_FREQ, zMottle, 3, 2.0, 0.5)
        disc = discDensity(r, mottleN)
      }

      let band = 0
      if (r >= WALL_R && r < BAND_OUTER) {
        const theta = Math.atan2(dy, dx)
        const raggedN = fbm(noiseRagged, dx * raggedFreq, dy * raggedFreq, zRagged, 3, 2.1, 0.5)
        band = bandDensity(r, theta, cfg, raggedN)
      }

      const v = Math.round(clamp(Math.max(disc, band), 0, 1) * 255)
      // CRITICAL: the material uses this as an alphaMap, and alphaMap
      // samples the GREEN channel -- write density into R,G,B and keep
      // alpha opaque, or canvas premultiplication wrecks the texture.
      const idx = (row + x) * 4
      data[idx] = v
      data[idx + 1] = v
      data[idx + 2] = v
      data[idx + 3] = 255
    }
  }
  ctx.putImageData(img, 0, 0)
  return new THREE.CanvasTexture(canvas)
}

// ---------------------------------------------------------------------------
// Mesh: a curved sphere-surface patch so the storm hugs the planet.
// ---------------------------------------------------------------------------
const PATCH_RADIUS = 1.08 // between the two cloud shells (1.075 / 1.09)
const PATCH_SEGMENTS = 64
const PATCH_PHI_LENGTH = 0.95 // planet-scale monster, like the ISS reference
const PATCH_THETA_LENGTH = 0.95
const SECONDARY_SCALE = 0.6 // angular footprint of the occasional second, smaller storm
const RENDER_ORDER = 2 // above the cloud shells (sky.js leaves them at the default 0)

// An equator-centered patch (phiStart=0, thetaStart=PI/2-thetaLength/2) sized
// by `sizeScale`, re-centered on its own patch-center point (rather than the
// planet origin) so that scaling the mesh grows/shrinks it toward its own
// surface anchor instead of toward the planet's core. mesh.position must
// then track (storm dir * PATCH_RADIUS) every frame -- see updateStorm().
function buildPatch(sizeScale) {
  const phiLength = PATCH_PHI_LENGTH * sizeScale
  const thetaLength = PATCH_THETA_LENGTH * sizeScale
  const thetaStart = Math.PI / 2 - thetaLength / 2
  const geo = new THREE.SphereGeometry(PATCH_RADIUS, PATCH_SEGMENTS, PATCH_SEGMENTS, 0, phiLength, thetaStart, thetaLength)

  // SphereGeometry vertex formula: x=-sin(theta)cos(phi), y=cos(theta),
  // z=sin(theta)sin(phi). Patch center is at u=v=0.5 -> theta=PI/2 (always,
  // by the symmetric thetaStart above), phi=phiLength/2.
  const phiCenter = phiLength / 2
  const centerDir = new THREE.Vector3(-Math.cos(phiCenter), 0, Math.sin(phiCenter)).normalize()

  geo.translate(-centerDir.x * PATCH_RADIUS, -centerDir.y * PATCH_RADIUS, -centerDir.z * PATCH_RADIUS)
  geo.computeBoundingSphere()
  return { geo, centerDir }
}

const PRIMARY_PATCH = buildPatch(1)
const SECONDARY_PATCH = buildPatch(SECONDARY_SCALE)

// ---------------------------------------------------------------------------
// Behavior tunables
// ---------------------------------------------------------------------------
const SPIN_RATE = 0.16 // rad/s, cyclonic (sign flips in the southern hemisphere)
const DRIFT_RATE = 0.0025 // rad/s along the track
const SUN_STEER_RATE = 0.035 // rad/s max pull toward the subsolar point (keeps the storm watchable)

// Latest sun direction, fed in via update(dt, sunDir) from main.js.
const _sunDir = new THREE.Vector3(1, 0.45, 0.9).normalize()
let _hasSun = false
const _steerAxis = new THREE.Vector3()
const DRIFT_WOBBLE_SCALE = 3.0 // spatial frequency the heading-wobble noise is sampled at
const DRIFT_WOBBLE_GAIN = 14 // how sharply fbm bends the heading, per radian of travel
const GROW_TIME = 15 // seconds to grow opacity+scale in
const DECAY_TIME = 20 // seconds to fade out once decay starts
const MATURE_MIN = 90 // seeded mature-phase duration range
const MATURE_MAX = 150
const MIN_SPAWN_SCALE = 0.25 // storm starts small and grows in, rather than popping in at full size
const CAM_FADE_NEAR = 1.35 // camera distance fade band (matches the cloud shells' style)
const CAM_FADE_FAR = 1.6
const MIN_LAT = 0.1 // real hurricanes avoid the equator...
const MAX_LAT = 0.65 // ...and the poles. (dir.y used as a cheap latitude proxy, as planet.js does)
const SECOND_STORM_CHANCE = 0 // user rule: exactly one hurricane at a time (machinery kept dormant)

const UP = new THREE.Vector3(0, 1, 0)
const RIGHT = new THREE.Vector3(1, 0, 0)

// --- seeded spawn-time helpers (allocation here is fine -- spawn is rare) --

// Uniform random unit vector, y put directly in the [-1,1] slot so
// Math.abs(dir.y) is a meaningful latitude proxy (this app's convention:
// planet.js and sky.js both treat Y as the pole axis).
function randomDirection(rng, out = new THREE.Vector3()) {
  const y = rng() * 2 - 1
  const t = rng() * Math.PI * 2
  const rr = Math.sqrt(Math.max(0, 1 - y * y))
  return out.set(rr * Math.cos(t), y, rr * Math.sin(t))
}

// A random unit vector perpendicular to `dir` -- the storm's initial drift
// heading axis.
function perpendicular(rng, dir, out = new THREE.Vector3()) {
  const rand = new THREE.Vector3()
  for (let tries = 0; tries < 4; tries++) {
    randomDirection(rng, rand)
    out.copy(rand).addScaledVector(dir, -rand.dot(dir))
    if (out.lengthSq() > 1e-6) return out.normalize()
  }
  const up = Math.abs(dir.y) < 0.99 ? UP : RIGHT
  return out.copy(up).addScaledVector(dir, -up.dot(dir)).normalize()
}

// Rejection-samples an ocean direction within the hurricane latitude band.
function pickStormOrigin(rng, planet, out) {
  for (let tries = 0; tries < 160; tries++) {
    randomDirection(rng, out)
    const latProxy = Math.abs(out.y)
    if (latProxy < MIN_LAT || latProxy > MAX_LAT) continue
    if (planet.isLand(out)) continue
    // spawn in daylight so the show is always watchable (relaxed after
    // enough failed tries — ocean+lat+lit can be a tight combination)
    if (_hasSun && tries < 120 && out.dot(_sunDir) < 0.35) continue
    return out
  }
  return out // fallback: last sample: rare in practice given ~30-40% land coverage
}

function createStormSlot(sizeScale) {
  const patch = sizeScale === 1 ? PRIMARY_PATCH : SECONDARY_PATCH
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    transparent: true,
    depthWrite: false,
    roughness: 1,
    metalness: 0,
    opacity: 0,
  })
  const mesh = new THREE.Mesh(patch.geo, material)
  mesh.renderOrder = RENDER_ORDER
  mesh.visible = false
  return {
    mesh,
    material,
    patch,
    texture: null,
    dir: new THREE.Vector3(),
    axis: new THREE.Vector3(),
    nx: 0,
    ny: 0,
    nz: 0,
    spinAngle: 0,
    spinSign: 1,
    age: 0,
    matureDuration: 0,
    decayStartAge: null, // null until landfall/maturity starts the decay countdown
    active: false,
  }
}

export function createStorms(planet, camera, seed) {
  const group = new THREE.Group()
  const driftNoise = makeNoise3D(seed + ':storms:drift')
  let spawnCounter = 0

  const slotA = createStormSlot(1) // always present
  const slotB = createStormSlot(SECONDARY_SCALE) // sometimes present, smaller
  group.add(slotA.mesh, slotB.mesh)

  // Deterministic sequence: rngFromString(seed + ':storm:' + counter). One
  // rng draws the whole storm -- origin, track, lifetime, and texture -- so
  // a given seed always reproduces the same sequence of storms.
  function spawn(storm) {
    const spawnSeed = seed + ':storm:' + spawnCounter++
    const rng = rngFromString(spawnSeed)

    pickStormOrigin(rng, planet, storm.dir)
    storm.spinSign = storm.dir.y >= 0 ? 1 : -1
    perpendicular(rng, storm.dir, storm.axis)
    storm.nx = rng() * 1000
    storm.ny = rng() * 1000
    storm.nz = rng() * 1000
    storm.spinAngle = 0
    storm.age = 0
    storm.matureDuration = lerp(MATURE_MIN, MATURE_MAX, rng())
    storm.decayStartAge = null

    storm.texture?.dispose()
    storm.texture = makeHurricaneTexture(rng, spawnSeed + ':tex', storm.spinSign)
    storm.material.alphaMap = storm.texture
    storm.material.opacity = 0

    storm.mesh.scale.setScalar(MIN_SPAWN_SCALE)
    storm.active = true
    storm.mesh.visible = true
  }

  spawn(slotA)
  // slotB stays dormant (inactive, invisible) until a slotA respawn rolls it active.

  function finishA() {
    spawn(slotA)
    if (!slotB.active) {
      const roll = rngFromString(seed + ':storm:secondroll:' + spawnCounter)()
      if (roll < SECOND_STORM_CHANCE) spawn(slotB)
    }
  }
  function finishB() {
    slotB.active = false
    slotB.mesh.visible = false
  }

  // Scratch -- reused every frame across both slots, never reallocated.
  const orientQuat = new THREE.Quaternion()
  const spinQuat = new THREE.Quaternion()

  function updateStorm(storm, onFinish, dt) {
    if (!storm.active) return

    storm.age += dt

    // Drift: precess the heading axis with fbm (gust-like wobble), then
    // advance the storm center along the resulting great circle -- a slow,
    // gently curving seeded track (same idea as wind.js's path wobble, but
    // evaluated live frame-by-frame instead of pre-baked).
    const turn =
      fbm(
        driftNoise,
        storm.dir.x * DRIFT_WOBBLE_SCALE + storm.nx,
        storm.dir.y * DRIFT_WOBBLE_SCALE + storm.ny,
        storm.dir.z * DRIFT_WOBBLE_SCALE + storm.nz,
        3
      ) *
      DRIFT_WOBBLE_GAIN *
      DRIFT_RATE *
      dt
    storm.axis.applyAxisAngle(storm.dir, turn)
    storm.dir.applyAxisAngle(storm.axis, DRIFT_RATE * dt).normalize()

    // Sun-seeking: the hurricane hugs the lit hemisphere so it's always
    // watchable — steered toward the subsolar point as it nears dusk, and
    // dissipating if night catches it anyway.
    if (_hasSun) {
      const litDot = storm.dir.dot(_sunDir)
      if (litDot < 0.55) {
        _steerAxis.crossVectors(storm.dir, _sunDir)
        if (_steerAxis.lengthSq() > 1e-8) {
          _steerAxis.normalize()
          const steer = SUN_STEER_RATE * (0.55 - litDot) * dt
          storm.dir.applyAxisAngle(_steerAxis, steer).normalize()
          storm.axis.applyAxisAngle(_steerAxis, steer).normalize()
        }
      }
      if (litDot < -0.08 && storm.decayStartAge === null) {
        storm.decayStartAge = storm.age
      }
    }

    // Landfall pulls decay forward; otherwise decay starts once mature.
    if (storm.decayStartAge === null && planet.isLand(storm.dir)) {
      storm.decayStartAge = storm.age
    }
    const decayStart = storm.decayStartAge ?? GROW_TIME + storm.matureDuration
    const decayEnd = decayStart + DECAY_TIME

    if (storm.age >= decayEnd) {
      onFinish()
      return
    }

    // Grow envelope ramps 0->1 over GROW_TIME, freezing at whatever it
    // reached if decay cuts growth short (landfall while still forming);
    // decay then fades from there down to 0. Continuous at both joins.
    const grown = smoothstep(0, GROW_TIME, Math.min(storm.age, decayStart))
    const decayFade = storm.age < decayStart ? 1 : 1 - smoothstep(decayStart, decayEnd, storm.age)
    const lifecycleOpacity = grown * decayFade
    storm.strength = lifecycleOpacity // exposed via getPrimary for cloud-deck clearing

    storm.spinAngle += SPIN_RATE * storm.spinSign * dt

    orientQuat.setFromUnitVectors(storm.patch.centerDir, storm.dir)
    spinQuat.setFromAxisAngle(storm.patch.centerDir, storm.spinAngle)
    storm.mesh.quaternion.copy(orientQuat).multiply(spinQuat)
    storm.mesh.position.copy(storm.dir).multiplyScalar(PATCH_RADIUS)
    storm.mesh.scale.setScalar(lerp(MIN_SPAWN_SCALE, 1, grown))

    // Fade out close to the surface, like the cloud shells, so ground-level
    // views aren't blocked.
    const camDist = camera.position.length()
    const camFade = smoothstep(CAM_FADE_NEAR, CAM_FADE_FAR, camDist)
    storm.material.opacity = lifecycleOpacity * camFade
  }

  let sunPrimed = false
  function update(dt, sunDir) {
    if (sunDir) {
      _sunDir.copy(sunDir)
      _hasSun = true
      // The launch-time storm spawns before the first sun handshake; if it
      // came up on the night side, quietly redo it (still invisible at age<2).
      if (!sunPrimed) {
        sunPrimed = true
        if (slotA.active && slotA.age < 2 && slotA.dir.dot(_sunDir) < 0.35) finishA()
      }
    }
    updateStorm(slotA, finishA, dt)
    updateStorm(slotB, finishB, dt)
  }

  // Primary storm's direction + intensity (0..1), for the cloud shells'
  // clearing moat. Returns 0 when no storm is active.
  function getPrimary(out) {
    if (!slotA.active || !slotA.strength) return 0
    out.copy(slotA.dir)
    return slotA.strength
  }

  return { group, update, getPrimary }
}
