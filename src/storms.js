// Hurricanes: a spiral cloud system that drifts across the ocean, spins up,
// matures, and dissipates over land -- ISS-photo look (dense white core, a
// dark eye ringed by a bright eyewall, ragged log-spiral feeder bands).
// Everything is derived from `seed` + a per-storm spawn counter, so a given
// seed always produces the same sequence of storms (origin, track, texture).
import * as THREE from 'three/webgpu'
import { uniform, texture, uv, vec2, vec3, mix, min, oneMinus, smoothstep as smoothstepNode } from 'three/tsl'
import { SEA_LEVEL, rngFromString, makeNoise3D, fbm, clamp, lerp, smoothstep } from './util.js'

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
// then track (storm dir * radius) every frame -- see updateStorm(). `radius`
// defaults to PATCH_RADIUS (the cloud patch itself); the M-SKY ocean-shadow
// mesh reuses this same builder at SHADOW_RADIUS (just above sea level) so
// its silhouette is pixel-identical to the storm's own shape.
function buildPatch(sizeScale, radius = PATCH_RADIUS) {
  const phiLength = PATCH_PHI_LENGTH * sizeScale
  const thetaLength = PATCH_THETA_LENGTH * sizeScale
  const thetaStart = Math.PI / 2 - thetaLength / 2
  const geo = new THREE.SphereGeometry(
    radius,
    PATCH_SEGMENTS,
    PATCH_SEGMENTS,
    0,
    phiLength,
    thetaStart,
    thetaLength,
  )

  // SphereGeometry vertex formula: x=-sin(theta)cos(phi), y=cos(theta),
  // z=sin(theta)sin(phi). Patch center is at u=v=0.5 -> theta=PI/2 (always,
  // by the symmetric thetaStart above), phi=phiLength/2.
  const phiCenter = phiLength / 2
  const centerDir = new THREE.Vector3(-Math.cos(phiCenter), 0, Math.sin(phiCenter)).normalize()

  geo.translate(-centerDir.x * radius, -centerDir.y * radius, -centerDir.z * radius)
  geo.computeBoundingSphere()
  return { geo, centerDir, phiLength, thetaStart, thetaLength }
}

const PRIMARY_PATCH = buildPatch(1)
const SECONDARY_PATCH = buildPatch(SECONDARY_SCALE)

// M-SKY: the storm's soft shadow on the ocean -- same silhouette, sea level.
const SHADOW_RADIUS = SEA_LEVEL + 0.001 // just above sea level
const PRIMARY_SHADOW_PATCH = buildPatch(1, SHADOW_RADIUS)
const SECONDARY_SHADOW_PATCH = buildPatch(SECONDARY_SCALE, SHADOW_RADIUS)

/** Local-space unit direction -> a PATCH's own bounded UV window (phiStart
 * is always 0 for these patches; see buildPatch). Same theta/phi formula as
 * sky.js's localDirToUV for the full-sphere cloud shells, just remapped onto
 * this patch's much smaller phi/theta sweep (~0.95 rad, not 2*PI/PI) instead
 * of wrapped to a periodic [0,1) -- there's no seam to wrap around on a
 * bounded patch, so (unlike sky.js) this is a plain, non-periodic remap.
 * Only meaningful as a DIRECTION source (uSunUV - fragment's own uv, then
 * normalized) rather than a literal sample position, which is why it stays
 * well-behaved even though the sun usually sits well outside the patch's
 * own [0,1] window -- and in practice it isn't THAT far outside: the
 * sun-seeking behavior in updateStorm() keeps the storm within ~56 degrees
 * of the sun whenever possible, comparable to the patch's own half-angle. */
function localDirToPatchUV(dir, patch, out) {
  const theta = Math.acos(clamp(dir.y, -1, 1))
  const phi = Math.atan2(dir.z, -dir.x)
  const uLocal = phi / patch.phiLength
  const vLocal = (theta - patch.thetaStart) / patch.thetaLength
  return out.set(uLocal, 1 - vLocal)
}

/** M-SKY 2.5D shading for the hurricane's own cloud material -- the SAME
 * offset-toward-the-sun alphaMap trick sky.js's cloud shells use (see
 * sky.js's applyStormClearing doc comment for the full rationale), just
 * without the periodic U-wrap (this patch is a small bounded sweep, not a
 * full sphere -- see localDirToPatchUV above). TSL node graph, built once;
 * animated purely by writing the returned uniform()/texture() handles'
 * `.value` (per-storm-slot, not shared -- see spawn()/updateStorm()).
 * alphaMap density lives in the texture's GREEN channel (see
 * makeHurricaneTexture's CRITICAL comment), so every sample below reads
 * `.g`, matching three.js's own classic alphamap_fragment convention. */
function applySunShading(mat) {
  const uSunUV = uniform(new THREE.Vector2(0, 0))
  const uOpacity = uniform(0)
  const ownUV = uv()
  const alphaTex = texture(undefined, ownUV) // .value synced in spawn()

  const toSun = uSunUV.sub(ownUV)
  const toSunLen = toSun.length()
  const sunDirUv = toSunLen.greaterThan(1e-5).select(toSun.div(toSunLen), vec2(1.0, 0.0))
  const sunTex = alphaTex.sample(ownUV.add(sunDirUv.mul(0.015))) // separate node -- .value ALSO synced in spawn()

  const ownDensity = alphaTex.g
  const sunSample = sunTex.g
  // high density both here AND toward the sun -> shadowed base of a
  // thicker mass; low density toward the sun but cloud here -> a
  // sun-facing rim, catches a thin highlight.
  const shadowT = smoothstepNode(0.18, 0.7, sunSample).mul(ownDensity)
  const edgeT = oneMinus(smoothstepNode(0.05, 0.4, sunSample)).mul(ownDensity)
  const shadeTint = vec3(0.7255, 0.7686, 0.8314) // #b9c4d4

  let rgb = mix(vec3(1.0, 1.0, 1.0), shadeTint, shadowT.mul(0.6))
  rgb = rgb.mul(edgeT.mul(0.08).add(1.0))
  rgb = min(rgb, vec3(1.0, 1.0, 1.0)) // stay white-dominant, never glow (ART.md 2.5/8)

  mat.colorNode = rgb
  mat.opacityNode = uOpacity.mul(ownDensity) // coverage (density) x lifecycle/cam-fade opacity

  return { uSunUV, uOpacity, alphaTex, sunTex }
}

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

// M-SKY: the storm's soft shadow on the ocean.
const SHADOW_OPACITY = 0.22
const SHADOW_SUN_PUSH = 0.09 // how far the shadow displaces from storm.dir, away from the sun
const SHADOW_COLOR = 0x1c2733 // dark slate-blue -- multiply-style darkening, never pure black
const SHADOW_RENDER_ORDER = 1 // above the plain ocean (default 0), below the storm's own cloud patch (RENDER_ORDER=2)

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

// M-SKY: the storm's soft shadow on the ocean -- a second, dark
// semi-transparent patch mesh at sea level, same texture (silhouette) as the
// storm's own alphaMap, tracking the same drift/spin each frame but
// displaced away from the sun (see updateStorm). Plain MeshBasicMaterial
// (unlit, flat, predictable darkness) rather than the shaded cloud
// material -- a shadow is an absence of light, not a lit surface.
function createShadowSlot(sizeScale) {
  const patch = sizeScale === 1 ? PRIMARY_SHADOW_PATCH : SECONDARY_SHADOW_PATCH
  const uOpacity = uniform(0)
  const alphaTex = texture() // .value synced in spawn() -- same texture as the cloud patch
  const material = new THREE.MeshBasicNodeMaterial({
    color: SHADOW_COLOR,
    transparent: true,
    depthWrite: false,
    blending: THREE.NormalBlending, // "multiply-style" via a dark, low-opacity color -- true MultiplyBlending is order-fragile with other transparents
    opacity: 0,
  })
  // alphaMap density lives in the GREEN channel (see makeHurricaneTexture);
  // colorNode is left to the material default (flat SHADOW_COLOR, untinted).
  material.opacityNode = uOpacity.mul(alphaTex.g)
  const mesh = new THREE.Mesh(patch.geo, material)
  mesh.renderOrder = SHADOW_RENDER_ORDER
  mesh.visible = false
  return { mesh, material, patch, uOpacity, alphaTex }
}

function createStormSlot(sizeScale) {
  const patch = sizeScale === 1 ? PRIMARY_PATCH : SECONDARY_PATCH
  const material = new THREE.MeshStandardNodeMaterial({
    color: 0xffffff,
    transparent: true,
    depthWrite: false,
    roughness: 1,
    metalness: 0,
    opacity: 0,
  })
  const sunShadeUniforms = applySunShading(material)
  const mesh = new THREE.Mesh(patch.geo, material)
  mesh.renderOrder = RENDER_ORDER
  mesh.visible = false
  return {
    mesh,
    material,
    patch,
    sunShadeUniforms,
    shadow: createShadowSlot(sizeScale),
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
  group.add(slotA.mesh, slotB.mesh, slotA.shadow.mesh, slotB.shadow.mesh)

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
    storm.sunShadeUniforms.alphaTex.value = storm.texture
    storm.sunShadeUniforms.sunTex.value = storm.texture
    storm.sunShadeUniforms.uOpacity.value = 0
    // Ocean shadow reuses the SAME texture -- its silhouette always matches
    // the cloud patch actually rendered overhead.
    storm.shadow.alphaTex.value = storm.texture
    storm.shadow.uOpacity.value = 0

    storm.mesh.scale.setScalar(MIN_SPAWN_SCALE)
    storm.active = true
    storm.mesh.visible = true
    storm.shadow.mesh.visible = true
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
    slotB.shadow.mesh.visible = false
  }

  // Scratch -- reused every frame across both slots, never reallocated.
  const orientQuat = new THREE.Quaternion()
  const spinQuat = new THREE.Quaternion()
  const _invQuatStorm = new THREE.Quaternion()
  const _localSunStorm = new THREE.Vector3()
  const _shadowDirStorm = new THREE.Vector3()

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
        3,
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
    storm.sunShadeUniforms.uOpacity.value = lifecycleOpacity * camFade

    // M-SKY 2.5D shading: project the sun into this patch's own local UV
    // space (mesh.quaternion was just set above) — see applySunShading.
    if (_hasSun) {
      _invQuatStorm.copy(storm.mesh.quaternion).invert()
      _localSunStorm.copy(_sunDir).applyQuaternion(_invQuatStorm)
      localDirToPatchUV(_localSunStorm, storm.patch, storm.sunShadeUniforms.uSunUV.value)
    }

    // M-SKY ocean shadow: same drift/spin as the storm's own cloud patch
    // (reuses orientQuat/spinQuat, already done with storm.mesh above this
    // frame), just at sea level and displaced slightly AWAY from the sun --
    // a cloud's shadow falls on the ground on the far side from the light.
    _shadowDirStorm.copy(storm.dir)
    if (_hasSun) _shadowDirStorm.addScaledVector(_sunDir, -SHADOW_SUN_PUSH)
    _shadowDirStorm.normalize()
    orientQuat.setFromUnitVectors(storm.shadow.patch.centerDir, _shadowDirStorm)
    spinQuat.setFromAxisAngle(storm.shadow.patch.centerDir, storm.spinAngle)
    storm.shadow.mesh.quaternion.copy(orientQuat).multiply(spinQuat)
    storm.shadow.mesh.position.copy(_shadowDirStorm).multiplyScalar(SHADOW_RADIUS)
    storm.shadow.mesh.scale.copy(storm.mesh.scale)
    storm.shadow.uOpacity.value = lifecycleOpacity * camFade * SHADOW_OPACITY
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
