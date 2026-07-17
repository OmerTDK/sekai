// Stars, atmosphere, clouds, moons and all scene lighting for the stylized
// planet. Everything here is deterministic from the seed string — same seed,
// same sky, every launch. This module owns every light in the scene.
import * as THREE from 'three'
import { makeNoise3D, fbm, rngFromString, clamp, lerp, smoothstep } from './util.js'

const Y_AXIS = new THREE.Vector3(0, 1, 0)

// Other modules assume this exact sun direction — do not change.
const SUN_DIR = new THREE.Vector3(1, 0.45, 0.9).normalize()

// -------------------------------------------------------------- eclipses --
// A moon eclipses the sun when its world direction from the planet lines up
// with the sun's. Threshold is in dot-product space (1 = perfectly aligned):
// 0.9975 ~= 4.05 deg separation (onset), 0.9997 ~= 1.4 deg (full). Generous
// on purpose — see createSky() update() for the frequency this produces.
const ECLIPSE_ALIGN_LOW = 0.9975
const ECLIPSE_ALIGN_HIGH = 0.9997

const SUN_BASE_INTENSITY = 2.3
const SUN_ECLIPSE_INTENSITY = SUN_BASE_INTENSITY * 0.35
const HEMI_BASE_INTENSITY = 0.62
const HEMI_ECLIPSE_INTENSITY = HEMI_BASE_INTENSITY * 0.6
const SUN_BASE_COLOR = new THREE.Color('#fff2d8')
const SUN_ECLIPSE_TINT = new THREE.Color('#ffd0b0')

const CORONA_BASE_SCALE = 9
const CORONA_MAX_SCALE = CORONA_BASE_SCALE * 1.6
const CORONA_MAX_OPACITY = 0.85

export function createSky(seed) {
  const group = new THREE.Group()

  group.add(createStarfield(seed))
  group.add(createNebulae(seed))
  group.add(createAtmosphere())
  const sunSprite = createSunSprite()
  group.add(sunSprite)

  // Eclipse corona: a soft additive ring-glow sprite that lives behind the
  // sun sprite and only becomes visible as the eclipse factor rises.
  let corona = null
  try {
    corona = createCoronaSprite()
    group.add(corona)
  } catch (err) {
    console.warn('[planet] sky: corona degraded — sprite failed to build, eclipses will render without the corona flourish', err)
    corona = null // corona is a flourish — the sun/eclipse lighting still works without it
  }

  const clouds = createClouds(seed)
  group.add(clouds.lowerMesh, clouds.upperMesh)

  const lights = createLights()
  group.add(lights.sun, lights.target, lights.hemi, lights.moonFill)

  const moons = createMoons(seed)
  for (const moon of moons) group.add(moon.pivot)

  // Aurora curtains: two wavy ribbons per pole, seeded shape baked once at
  // build time, shaded live (flow + night-side gating) each frame.
  let aurora = null
  try {
    aurora = createAurora(seed)
    group.add(aurora.group)
  } catch (err) {
    console.warn('[planet] sky: aurora degraded — curtains failed to build, night sky will render without aurora', err)
    aurora = null
  }

  // Shooting-star pool: five reusable streaks, each on its own seeded timer.
  let meteors = null
  try {
    meteors = createMeteors(seed)
    group.add(meteors.group)
  } catch (err) {
    console.warn('[planet] sky: meteors degraded — shooting-star pool failed to build, no meteors this session', err)
    meteors = null
  }

  // Day/night cycle: the sun sweeps a full orbit every ~15 minutes so every
  // settlement gets its dawn (with a fixed sun, half the world would live in
  // eternal night).
  const SUN_ORBIT_RATE = (Math.PI * 2) / 900

  // Per-frame scratch vectors (reused every call — no per-frame allocation).
  const _sunDirScratch = new THREE.Vector3()
  const _moonDirScratch = new THREE.Vector3()

  function update(dt /* sec */, camera /* THREE.PerspectiveCamera */) {
    clouds.lowerMesh.rotateOnWorldAxis(clouds.lowerAxis, clouds.lowerRate * dt)
    clouds.upperMesh.rotateOnWorldAxis(clouds.upperAxis, clouds.upperRate * dt)
    for (const moon of moons) moon.pivot.rotateY(moon.rate * dt)

    const sunAngle = SUN_ORBIT_RATE * dt
    lights.sun.position.applyAxisAngle(Y_AXIS, sunAngle)
    sunSprite.position.applyAxisAngle(Y_AXIS, sunAngle)
    lights.moonFill.position.copy(lights.sun.position).multiplyScalar(-1)

    // Solar eclipses: e is recomputed from scratch every frame (never
    // stored), so every visual response below is just e's current value —
    // no eclipse-start/eclipse-end state machine, it simply tracks alignment.
    _sunDirScratch.copy(lights.sun.position).normalize()
    let eclipseFactor = 0
    for (const moon of moons) {
      moon.mesh.getWorldPosition(_moonDirScratch).normalize()
      const alignment = _moonDirScratch.dot(_sunDirScratch)
      const e = smoothstep(ECLIPSE_ALIGN_LOW, ECLIPSE_ALIGN_HIGH, alignment)
      if (e > eclipseFactor) eclipseFactor = e
    }
    lights.sun.intensity = lerp(SUN_BASE_INTENSITY, SUN_ECLIPSE_INTENSITY, eclipseFactor)
    lights.hemi.intensity = lerp(HEMI_BASE_INTENSITY, HEMI_ECLIPSE_INTENSITY, eclipseFactor)
    lights.sun.color.copy(SUN_BASE_COLOR).lerp(SUN_ECLIPSE_TINT, eclipseFactor)
    if (corona) {
      corona.position.copy(sunSprite.position)
      const coronaScale = lerp(CORONA_BASE_SCALE, CORONA_MAX_SCALE, eclipseFactor)
      corona.scale.set(coronaScale, coronaScale, 1)
      corona.material.opacity = CORONA_MAX_OPACITY * eclipseFactor
    }

    // Aurora: one shared clock + sun direction drives all curtain meshes;
    // the shader itself gates brightness to the night side per-fragment.
    if (aurora) {
      aurora.uniforms.uTime.value += dt
      aurora.uniforms.uSunDir.value.copy(_sunDirScratch)
    }

    // Fade the cloud deck away as the camera dives toward the surface, so
    // close-up views of settlements aren't fogged out. Full deck from 2.4R
    // out, thin wisps by 1.35R.
    const dist = camera.position.length()
    const fade = smoothstep(1.35, 2.4, dist)
    clouds.lowerMesh.material.opacity = 0.88 * Math.max(fade, 0.08)
    clouds.upperMesh.material.opacity = 0.5 * Math.max(fade, 0.05)

    // Shooting stars: five independently-timed slots. Steady-state cost per
    // slot is one counter compare — geometry/material are only touched on
    // the (multi-second) transitions between waiting and active.
    if (meteors) {
      for (const meteor of meteors.meteors) {
        meteor.timer += dt
        if (meteor.active) {
          const t = meteor.timer / meteor.phaseDuration
          if (t >= 1) {
            scheduleMeteorWait(meteor)
          } else {
            const envelope =
              t < METEOR_FLASH_FRACTION
                ? smoothstep(0, METEOR_FLASH_FRACTION, t)
                : 1 - smoothstep(METEOR_FLASH_FRACTION, 1, t)
            meteor.line.material.opacity = envelope
          }
        } else if (meteor.timer >= meteor.phaseDuration) {
          activateMeteor(meteor)
        }
      }
    }
  }

  // Current sun direction (unit vector), written into `out` — used by other
  // modules (e.g. the sun-seeking hurricane).
  function getSunDir(out) {
    return out.copy(lights.sun.position).normalize()
  }

  // Hurricane clears the ambient cloud deck around itself; main.js feeds the
  // storm's position + intensity here each frame.
  function setStormClearing(dir, strength) {
    stormClearUniforms.uStormDir.value.copy(dir)
    stormClearUniforms.uStormOn.value = strength
  }

  return { group, update, getSunDir, setStormClearing }
}

// ---------------------------------------------------------------- helpers --

/** Uniform random point on the unit sphere via the z = 2u-1 method. */
function randomOnUnitSphere(rng, out = new THREE.Vector3()) {
  const z = 2 * rng() - 1
  const t = rng() * Math.PI * 2
  const r = Math.sqrt(Math.max(0, 1 - z * z))
  return out.set(r * Math.cos(t), r * Math.sin(t), z)
}

/** Box-Muller gaussian sample, mean 0. */
function gaussian(rng, sigma = 1) {
  const u1 = Math.max(rng(), 1e-9)
  const u2 = rng()
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(Math.PI * 2 * u2) * sigma
}

/** A seeded great-circle basis {normal, u, v}, shared by the milky-way band
 * and the nebula patches so the patches sit convincingly inside the band. */
function bandBasis(seed) {
  const rng = rngFromString(seed + ':band')
  const normal = randomOnUnitSphere(rng)
  const ref = Math.abs(normal.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)
  const u = new THREE.Vector3().crossVectors(ref, normal).normalize()
  const v = new THREE.Vector3().crossVectors(normal, u).normalize()
  return { normal, u, v }
}

/** A point at angular distance `phi` (radians) from the great circle defined
 * by {normal, u, v}, at circle-angle `theta`. Always unit length. */
function pointNearGreatCircle(normal, u, v, theta, phi, out = new THREE.Vector3()) {
  out.copy(u).multiplyScalar(Math.cos(theta)).addScaledVector(v, Math.sin(theta))
  out.multiplyScalar(Math.cos(phi)).addScaledVector(normal, Math.sin(phi))
  return out.normalize()
}

function makeRadialCanvasTexture(stops, size = 128) {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  for (const [offset, color] of stops) g.addColorStop(offset, color)
  ctx.fillStyle = g
  ctx.fillRect(0, 0, size, size)
  return new THREE.CanvasTexture(canvas)
}

// ------------------------------------------------------------------ stars --

function createStarfield(seed) {
  const group = new THREE.Group()
  group.add(createCoreStars(seed))
  group.add(createMilkyWayBand(seed))
  group.add(createBrightStars(seed))
  return group
}

function createCoreStars(seed) {
  const rng = rngFromString(seed + ':stars-core')
  const count = 9000
  const radius = 90
  const positions = new Float32Array(count * 3)
  const colors = new Float32Array(count * 3)
  const p = new THREE.Vector3()
  const warm = new THREE.Color('#ffd9a0')
  const cool = new THREE.Color('#aac4ff')
  const c = new THREE.Color()
  for (let i = 0; i < count; i++) {
    randomOnUnitSphere(rng, p).multiplyScalar(radius)
    positions[i * 3] = p.x
    positions[i * 3 + 1] = p.y
    positions[i * 3 + 2] = p.z

    const roll = rng()
    if (roll < 0.075) c.copy(warm)
    else if (roll < 0.15) c.copy(cool)
    else c.set('#ffffff')
    c.multiplyScalar(lerp(0.35, 1.05, rng()))
    colors[i * 3] = c.r
    colors[i * 3 + 1] = c.g
    colors[i * 3 + 2] = c.b
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  const mat = new THREE.PointsMaterial({
    size: 1.6,
    sizeAttenuation: false,
    vertexColors: true,
    transparent: true,
    depthWrite: false,
  })
  return new THREE.Points(geo, mat)
}

function createMilkyWayBand(seed) {
  const rng = rngFromString(seed + ':stars-band')
  const { normal, u, v } = bandBasis(seed)
  const count = 4500
  const radius = 89
  const sigma = 0.13
  const positions = new Float32Array(count * 3)
  const colors = new Float32Array(count * 3)
  const dir = new THREE.Vector3()
  const tint = new THREE.Color('#dce6ff')
  const c = new THREE.Color()
  for (let i = 0; i < count; i++) {
    const theta = rng() * Math.PI * 2
    const phi = gaussian(rng, sigma)
    pointNearGreatCircle(normal, u, v, theta, phi, dir).multiplyScalar(radius)
    positions[i * 3] = dir.x
    positions[i * 3 + 1] = dir.y
    positions[i * 3 + 2] = dir.z

    c.copy(tint).multiplyScalar(lerp(0.12, 0.45, rng()))
    colors[i * 3] = c.r
    colors[i * 3 + 1] = c.g
    colors[i * 3 + 2] = c.b
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  const mat = new THREE.PointsMaterial({
    size: 1.3,
    sizeAttenuation: false,
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    opacity: 0.85,
  })
  return new THREE.Points(geo, mat)
}

function createBrightStars(seed) {
  const rng = rngFromString(seed + ':stars-bright')
  const count = 40
  const radius = 88
  const positions = new Float32Array(count * 3)
  const colors = new Float32Array(count * 3)
  const p = new THREE.Vector3()
  const warm = new THREE.Color('#ffd9a0')
  const cool = new THREE.Color('#aac4ff')
  const c = new THREE.Color()
  for (let i = 0; i < count; i++) {
    randomOnUnitSphere(rng, p).multiplyScalar(radius)
    positions[i * 3] = p.x
    positions[i * 3 + 1] = p.y
    positions[i * 3 + 2] = p.z

    const roll = rng()
    if (roll < 0.2) c.copy(warm)
    else if (roll < 0.4) c.copy(cool)
    else c.set('#ffffff')
    // A bloom post-pass may run on top of this scene later — leave a little
    // headroom above 1.0 so the brightest stars have something to bloom.
    c.multiplyScalar(lerp(1.05, 1.35, rng()))
    colors[i * 3] = c.r
    colors[i * 3 + 1] = c.g
    colors[i * 3 + 2] = c.b
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  const map = makeRadialCanvasTexture(
    [
      [0, 'rgba(255,255,255,1)'],
      [0.25, 'rgba(255,255,255,0.85)'],
      [0.6, 'rgba(255,255,255,0.25)'],
      [1, 'rgba(255,255,255,0)'],
    ],
    64
  )
  const mat = new THREE.PointsMaterial({
    size: 3,
    map,
    sizeAttenuation: false,
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  })
  return new THREE.Points(geo, mat)
}

// --------------------------------------------------------------- nebulae --

/** A few large, very faint tinted patches sitting in/near the milky-way
 * band — just enough dust to make the sky feel less empty. */
function createNebulae(seed) {
  const group = new THREE.Group()
  const rng = rngFromString(seed + ':nebulae')
  const { normal, u, v } = bandBasis(seed)
  const palette = ['#7d5fc0', '#4fb0a0', '#8a6fd0']
  const count = 2 + Math.floor(rng() * 2) // 2 or 3
  const dir = new THREE.Vector3()

  for (let i = 0; i < count; i++) {
    const theta = rng() * Math.PI * 2
    const phi = gaussian(rng, 0.35)
    pointNearGreatCircle(normal, u, v, theta, phi, dir)
    const dist = lerp(55, 82, rng())

    const hex = palette[Math.floor(rng() * palette.length)]
    const col = new THREE.Color(hex)
    const rgb = `${Math.round(col.r * 255)},${Math.round(col.g * 255)},${Math.round(col.b * 255)}`
    const map = makeRadialCanvasTexture(
      [
        [0, `rgba(${rgb},0.9)`],
        [0.4, `rgba(${rgb},0.4)`],
        [1, `rgba(${rgb},0)`],
      ],
      128
    )
    const mat = new THREE.SpriteMaterial({
      map,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
      opacity: lerp(0.05, 0.1, rng()),
    })
    const sprite = new THREE.Sprite(mat)
    sprite.position.copy(dir).multiplyScalar(dist)
    sprite.scale.setScalar(lerp(38, 62, rng()))
    group.add(sprite)
  }
  return group
}

// ------------------------------------------------------------ atmosphere --

function createAtmosphere() {
  const geo = new THREE.SphereGeometry(1.09, 64, 48)
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      glowColor: { value: new THREE.Color('#7db8ff') },
      power: { value: 3.2 },
      intensity: { value: 0.75 }, // faint overall — do not overdrive this
    },
    vertexShader: `
      varying vec3 vWorldPosition;
      varying vec3 vWorldNormal;
      void main() {
        vec4 worldPos = modelMatrix * vec4(position, 1.0);
        vWorldPosition = worldPos.xyz;
        vWorldNormal = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * worldPos;
      }
    `,
    fragmentShader: `
      uniform vec3 glowColor;
      uniform float power;
      uniform float intensity;
      varying vec3 vWorldPosition;
      varying vec3 vWorldNormal;
      void main() {
        vec3 viewDir = normalize(cameraPosition - vWorldPosition);
        vec3 n = normalize(vWorldNormal);
        float rim = pow(clamp(1.0 - abs(dot(viewDir, n)), 0.0, 1.0), power);
        gl_FragColor = vec4(glowColor, rim * intensity);
      }
    `,
    side: THREE.BackSide,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  })
  return new THREE.Mesh(geo, mat)
}

function createSunSprite() {
  const map = makeRadialCanvasTexture(
    [
      [0, 'rgba(255,255,255,1)'],
      [0.18, 'rgba(255,244,214,0.95)'],
      [0.45, 'rgba(255,214,140,0.35)'],
      [1, 'rgba(255,200,120,0)'],
    ],
    128
  )
  const mat = new THREE.SpriteMaterial({
    map,
    color: new THREE.Color(1.3, 1.22, 1.05), // slight >1.0 headroom for bloom
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  })
  const sprite = new THREE.Sprite(mat)
  sprite.scale.set(7, 7, 1)
  sprite.position.copy(SUN_DIR).multiplyScalar(80)
  return sprite
}

/** The "ring of light" flourish during a solar eclipse: a soft, faintly
 * ring-shaped additive glow (dim core, bright band around ~0.35-0.55 of the
 * sprite radius) that sits behind the sun sprite and is invisible
 * (opacity 0) outside of an eclipse — see update()'s eclipseFactor. */
function createCoronaSprite() {
  const map = makeRadialCanvasTexture(
    [
      [0, 'rgba(255,214,160,0.12)'],
      [0.32, 'rgba(255,214,160,0.85)'],
      [0.55, 'rgba(255,190,120,0.45)'],
      [1, 'rgba(255,180,100,0)'],
    ],
    128
  )
  const mat = new THREE.SpriteMaterial({
    map,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    opacity: 0,
  })
  const sprite = new THREE.Sprite(mat)
  sprite.scale.set(CORONA_BASE_SCALE, CORONA_BASE_SCALE, 1)
  sprite.renderOrder = -1 // draws before (visually "behind") the sun sprite
  return sprite
}

// ----------------------------------------------------------------- clouds --

/** Two-stage Quilez-style domain warp for filaments/swirls, evaluated purely
 * as a function of the sphere DIRECTION (so the equirect seam at +/-180
 * stays invisible):
 *   q = fbm(dir*s1), r = fbm(dir*s1 + q*k), final = fbm(dir*s2 + r*k2)
 * Before any of that, the direction's latitude (y) component is stretched
 * relative to x/z so structures elongate along parallels (trade-wind
 * streaks). The final value is then biased by a couple of seeded cosine
 * bands over latitude so density favors the equatorial belt and the
 * mid-latitude storm tracks over the subtropical gaps between them. */
function warpedCloudField(noise3, dir, lat, cfg) {
  const sx = dir.x
  const sy = dir.y * cfg.latStretch
  const sz = dir.z

  const q = fbm(
    noise3,
    sx * cfg.warpScale + 2.1,
    sy * cfg.warpScale - 6.4,
    sz * cfg.warpScale + 4.9,
    cfg.warpOctaves, 2.05, 0.5
  )
  const r = fbm(
    noise3,
    sx * cfg.warpScale + q * cfg.warpStrength - 3.7,
    sy * cfg.warpScale + q * cfg.warpStrength + 8.1,
    sz * cfg.warpScale + q * cfg.warpStrength - 1.3,
    cfg.warpOctaves, 2.05, 0.5
  )
  const n = fbm(
    noise3,
    sx * cfg.scale + r * cfg.warpStrength2,
    sy * cfg.scale + r * cfg.warpStrength2,
    sz * cfg.scale + r * cfg.warpStrength2,
    cfg.octaves, 2.05, 0.5
  )

  // Equatorial belt + mirrored mid-latitude storm tracks with subtropical
  // gaps in between: a broad equator-to-pole taper plus a 3x-frequency
  // cosine that carves the subtropical dip / storm-track bump, seeded phase
  // so the bands sit differently from planet to planet.
  const latN = lat / (Math.PI / 2)
  const band = 0.5 + cfg.bandAmp1 * Math.cos(latN * Math.PI) + cfg.bandAmp2 * Math.cos(latN * Math.PI * 3 + cfg.bandPhase)

  return clamp(n * 0.5 + 0.5 + (band - cfg.bandBias) * cfg.bandStrength, 0, 1)
}

/** Mean soft-thresholded coverage of an already-sampled field — cheap (no
 * noise calls), so calibrateThreshold can afford several passes over it. */
function meanCoverage(field, threshold, edge) {
  let sum = 0
  for (let i = 0; i < field.length; i++) sum += smoothstep(threshold - edge, threshold + edge, field[i])
  return sum / field.length
}

/** Bisects on the already-sampled field for the threshold whose mean
 * coverage lands on `target`. Coverage is monotonically non-increasing in
 * threshold, so plain bisection converges in a handful of steps; fully
 * deterministic and silent, and cheap since it never re-touches the noise
 * functions — those were already baked into `field` once. */
function calibrateThreshold(field, edge, target) {
  let lo = 0.02
  let hi = 0.98
  let mid = 0.5
  for (let i = 0; i < 6; i++) {
    mid = (lo + hi) / 2
    if (meanCoverage(field, mid, edge) > target) lo = mid
    else hi = mid
  }
  return mid
}

/** Builds one cloud layer's alpha texture on a 2048x1024 equirect canvas.
 * Samples the warped/banded field (see warpedCloudField) once per texel at
 * the sphere DIRECTION, auto-calibrates the coverage threshold against
 * `cfg.targetCoverage` (see calibrateThreshold), then rasterizes. */
function makeCloudTexture(noise3, cfg) {
  const { width, height, edge, targetCoverage } = cfg
  const dir = new THREE.Vector3()
  const field = new Float32Array(width * height)

  for (let y = 0; y < height; y++) {
    const v = y / (height - 1)
    const lat = (0.5 - v) * Math.PI
    const cosLat = Math.cos(lat)
    const sinLat = Math.sin(lat)
    const rowOffset = y * width
    for (let x = 0; x < width; x++) {
      const u = x / (width - 1)
      const lon = (u - 0.5) * Math.PI * 2
      dir.set(cosLat * Math.cos(lon), sinLat, cosLat * Math.sin(lon))
      field[rowOffset + x] = warpedCloudField(noise3, dir, lat, cfg)
    }
  }

  const threshold = calibrateThreshold(field, edge, targetCoverage)

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  const img = ctx.createImageData(width, height)
  const data = img.data
  for (let i = 0; i < field.length; i++) {
    const a = smoothstep(threshold - edge, threshold + edge, field[i])
    const idx = i * 4
    // alphaMap samples the GREEN channel — write coverage into RGB and keep
    // alpha opaque, otherwise canvas premultiplication turns the texture
    // into a full-planet milky veil.
    const g = Math.round(clamp(a, 0, 1) * 255)
    data[idx] = g
    data[idx + 1] = g
    data[idx + 2] = g
    data[idx + 3] = 255
  }
  ctx.putImageData(img, 0, 0)

  const tex = new THREE.CanvasTexture(canvas)
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.ClampToEdgeWrapping
  return tex
}

// Shared by both cloud shells: the hurricane clears a moat in the ambient
// deck around itself (subsidence ring), driven every frame from main.js.
const stormClearUniforms = {
  uStormDir: { value: new THREE.Vector3(1, 0, 0) },
  uStormOn: { value: 0 },
}

function applyStormClearing(mat) {
  mat.customProgramCacheKey = () => 'cloud-storm-moat-v1'
  mat.onBeforeCompile = (shader) => {
    try {
      Object.assign(shader.uniforms, stormClearUniforms)
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vCloudWorld;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvCloudWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;')
      const frag = shader.fragmentShader
        .replace(
          '#include <common>',
          '#include <common>\nuniform vec3 uStormDir;\nuniform float uStormOn;\nvarying vec3 vCloudWorld;'
        )
        .replace(
          '#include <alphamap_fragment>',
          [
            '#include <alphamap_fragment>',
            '{',
            '  float cosAng = dot(normalize(vCloudWorld), uStormDir);',
            '  // full clear inside ~0.3 rad of the eye, feathering out to ~0.55 rad',
            '  float clearT = smoothstep(0.85, 0.955, cosAng);',
            '  diffuseColor.a *= 1.0 - clearT * uStormOn;',
            '}',
          ].join('\n')
        )
      if (frag === shader.fragmentShader) throw new Error('sky.js: cloud moat injection point not found')
      shader.fragmentShader = frag
    } catch (err) {
      /* clouds simply ignore the storm on failure */
    }
  }
}

function createClouds(seed) {
  const width = 2048
  const height = 1024

  const lowerNoise = makeNoise3D(seed + ':clouds-lower')
  const lowerTex = makeCloudTexture(lowerNoise, {
    width,
    height,
    // Broken cumulus fields + frontal filaments: smaller cells, sharper
    // edges, a moderate warp for cluster-boundary curl.
    scale: 3.6,
    warpScale: 1.3,
    warpStrength: 0.6,
    warpStrength2: 0.22,
    warpOctaves: 2,
    octaves: 4,
    latStretch: 2.6,
    bandAmp1: 0.15,
    bandAmp2: 0.35,
    bandBias: 0.55,
    bandStrength: 0.28,
    bandPhase: rngFromString(seed + ':clouds-bands-lower')() * Math.PI * 2,
    edge: 0.07,
    targetCoverage: 0.27,
  })
  const lowerMesh = new THREE.Mesh(
    new THREE.SphereGeometry(1.055, 64, 32),
    new THREE.MeshStandardMaterial({
      color: 0xffffff,
      alphaMap: lowerTex,
      transparent: true,
      depthWrite: false,
      roughness: 1,
      metalness: 0,
      opacity: 0.88,
    })
  )

  const upperNoise = makeNoise3D(seed + ':clouds-upper')
  const upperTex = makeCloudTexture(upperNoise, {
    width,
    height,
    // Thin elongated cirrus streaks: strong longitudinal stretch, very soft
    // threshold, low density, and only a whisper of warp so the streaks
    // stay long instead of curling into cumulus-like clumps.
    scale: 4.0,
    warpScale: 1.3,
    warpStrength: 0.18,
    warpStrength2: 0.08,
    warpOctaves: 2,
    octaves: 3,
    latStretch: 4.0,
    bandAmp1: 0.15,
    bandAmp2: 0.35,
    bandBias: 0.55,
    bandStrength: 0.22,
    bandPhase: rngFromString(seed + ':clouds-bands-upper')() * Math.PI * 2,
    edge: 0.16,
    targetCoverage: 0.13,
  })
  const upperMesh = new THREE.Mesh(
    new THREE.SphereGeometry(1.07, 64, 32),
    new THREE.MeshStandardMaterial({
      color: 0xffffff,
      alphaMap: upperTex,
      transparent: true,
      depthWrite: false,
      roughness: 1,
      metalness: 0,
      opacity: 0.5,
    })
  )

  applyStormClearing(lowerMesh.material)
  applyStormClearing(upperMesh.material)

  const rng = rngFromString(seed + ':clouds-axis')
  const tiltedAxis = () => new THREE.Vector3(rng() - 0.5, 1.6, rng() - 0.5).normalize()
  const lowerAxis = tiltedAxis()
  const upperAxis = tiltedAxis()
  lowerMesh.rotation.y = rng() * Math.PI * 2
  upperMesh.rotation.y = rng() * Math.PI * 2

  return {
    lowerMesh,
    upperMesh,
    lowerAxis,
    upperAxis,
    lowerRate: 0.006,
    upperRate: -0.0035, // retrograde
  }
}

// ------------------------------------------------------------------ lights --

function createLights() {
  const sun = new THREE.DirectionalLight(SUN_BASE_COLOR, SUN_BASE_INTENSITY)
  sun.position.copy(SUN_DIR).multiplyScalar(10)
  const target = new THREE.Object3D() // stays at the origin: the planet
  sun.target = target

  const hemi = new THREE.HemisphereLight(new THREE.Color('#9db8ff'), new THREE.Color('#3a3128'), HEMI_BASE_INTENSITY)

  // Cool "moonlight" fill from the anti-solar direction so the night side
  // reads silvery-blue instead of black. Kept in opposition in update().
  const moonFill = new THREE.DirectionalLight(new THREE.Color('#8fa8d8'), 0.5)
  moonFill.position.copy(SUN_DIR).multiplyScalar(-10)
  moonFill.target = target

  return { sun, hemi, moonFill, target }
}

// ------------------------------------------------------------------ moons --

/** Per-vertex color on a small sphere: seeded 3D fbm sampled at the vertex
 * direction, so it reads as either pale crater mottling or a faint
 * lavender/teal tint depending on `kind`. */
function buildMoonMesh(seed, radius, kind) {
  const noise3 = makeNoise3D(`${seed}:moon-${kind}`)
  const geo = new THREE.SphereGeometry(radius, 32, 24)
  const posAttr = geo.attributes.position
  const count = posAttr.count
  const colors = new Float32Array(count * 3)
  const p = new THREE.Vector3()
  const col = new THREE.Color()
  const lav = new THREE.Color('#b9a8d9')
  const teal = new THREE.Color('#8fd0c9')

  for (let i = 0; i < count; i++) {
    p.fromBufferAttribute(posAttr, i).normalize()
    const n = fbm(noise3, p.x * 3.2, p.y * 3.2, p.z * 3.2, 4, 2.1, 0.5)

    if (kind === 'crater') {
      const dark = smoothstep(0.05, 0.55, n * 0.5 + 0.5)
      const grey = lerp(0.78, 0.4, dark)
      col.setRGB(grey, grey, grey * 0.98)
    } else {
      const t = smoothstep(-0.4, 0.4, n)
      const tint = lav.clone().lerp(teal, t)
      const base = 0.72
      col.setRGB(base, base, base).lerp(tint, 0.4)
    }

    colors[i * 3] = col.r
    colors[i * 3 + 1] = col.g
    colors[i * 3 + 2] = col.b
  }

  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 })
  return new THREE.Mesh(geo, mat)
}

// The sun's declination (angle of its direction above/below the planet's
// equatorial XZ plane) is fixed forever: SUN_DIR only orbits the Y axis in
// update(), and Y-axis rotation preserves the y-component of a vector, so
// asin(SUN_DIR.y) never changes. Used by createMoons() below.
const SUN_DECLINATION = Math.asin(SUN_DIR.y) // ~= 0.3228 rad (~18.49 deg)

/** Small moons on inclined, seeded circular orbits. Each orbit is a pivot
 * Object3D tilted once at creation; advancing it each frame with rotateY
 * spins the (fixed) tilted axis, sweeping the moon around the planet.
 *
 * Eclipse-guarantee geometry (moon 0, 'crater'): pivot.quaternion tilts the
 * orbit's plane by `tiltAngle` about a horizontal axis, which is the
 * standard orbital-inclination case — the moon's own declination oscillates
 * across exactly [-tiltAngle, +tiltAngle] once per orbit. An eclipse needs
 * the moon's declination to reach the sun's fixed SUN_DECLINATION at the
 * same moment its azimuth (orbital phase) matches the sun's, so a moon whose
 * max declination (tiltAngle) never reaches SUN_DECLINATION can NEVER
 * eclipse, at any time, for that seed — tiltAngle was previously free in
 * lerp(0.15, 0.55) rad (8.6-31.5 deg), a range that dips below
 * SUN_DECLINATION (~18.49 deg) often enough that ~12% of seeds rolled BOTH
 * moons under it (measured via node simulation, real three.js math, dt=1/30:
 * seeds 'x' and 'planet-9000' in a 20-seed sample never eclipse, in 3
 * sim-hours or any amount of sim-time — median was only 2 eclipses/3h across
 * 20 seeds incl. default 'aetherion-1', which itself got 7 with max alignment
 * 0.999999).
 * Fix: clamp moon 0's tiltAngle to [SUN_DECLINATION + 0.01, SUN_DECLINATION +
 * 0.08] rad — always comfortably above SUN_DECLINATION, so its declination
 * band always straddles the sun's twice per orbit, for every seed, forever.
 * A margin sweep (50/80/200-seed pools) picked this 0.01-0.08 rad band as the
 * strongest frequency (wider or tighter bands, or ones abutting
 * SUN_DECLINATION, tested worse) while keeping a real ~4.6 deg seeded spread
 * rather than one fixed tilt. Measured after the fix (same 20-seed sample,
 * dt=1/30, 3 sim-hours): median 6 eclipses/3h, 0/20 seeds stuck at zero, and
 * 52/114 (46%) of eclipses reach the FULL 0.9997 threshold (coronas actually
 * bloom, not just grazing onsets) — comfortably clears the ~1-per-45-sim-min
 * target. Moon 1 ('tinted') is untouched — stays fully free for variety. */
function createMoons(seed) {
  const specs = [
    { name: 'crater', distance: 2.6, kind: 'crater' },
    { name: 'tinted', distance: 3.8, kind: 'tinted' },
  ]

  return specs.map((spec, index) => {
    const rng = rngFromString(`${seed}:moon-${spec.name}`)
    const radius = lerp(0.05, 0.09, rng())
    const distance = spec.distance * lerp(0.95, 1.05, rng())
    const rate = lerp(0.01, 0.02, rng())

    const pivot = new THREE.Object3D()
    const tiltAxis = new THREE.Vector3(rng() - 0.5, 0, rng() - 0.5).normalize()
    const tiltAngle =
      index === 0
        ? lerp(SUN_DECLINATION + 0.01, SUN_DECLINATION + 0.08, rng())
        : lerp(0.15, 0.55, rng())
    pivot.quaternion.setFromAxisAngle(tiltAxis, tiltAngle)
    pivot.rotateY(rng() * Math.PI * 2) // random starting phase

    const mesh = buildMoonMesh(seed, radius, spec.kind)
    mesh.position.set(distance, 0, 0)
    pivot.add(mesh)

    // `mesh` (not just `pivot`) is kept so update() can read the moon's true
    // world direction via getWorldPosition — needed for eclipse alignment.
    return { pivot, mesh, rate }
  })
}

// ------------------------------------------------------------------ aurora --

const AURORA_STEPS = 128
const AURORA_SHELL_R0 = 1.1
const AURORA_SHELL_R1 = AURORA_SHELL_R0 + 0.05
const AURORA_BASE_ANG_RADIUS = 0.35 // radians from the pole

/** One wavy curtain ribbon: a 129x2-vertex parametric strip circling the
 * pole at ~AURORA_BASE_ANG_RADIUS, radius perturbed per-column by a seeded
 * fbm sampled at (cos theta, sin theta) so the wobble closes seamlessly at
 * the theta=0/2pi seam. Shape is baked once here; the shader animates only
 * color flow + night-side visibility (see fragment shader below). */
function buildAuroraCurtain(seed, poleSign, ringIndex, uniforms) {
  const noise3 = makeNoise3D(`${seed}:aurora:${poleSign > 0 ? 'n' : 's'}:${ringIndex}`)
  const angRadius0 = AURORA_BASE_ANG_RADIUS + (ringIndex - 0.5) * 0.07
  const waveFreq = 2.2
  const waveAmp = 0.06

  const cols = AURORA_STEPS + 1
  const positions = new Float32Array(cols * 2 * 3)
  const grads = new Float32Array(cols * 2)
  const alongs = new Float32Array(cols * 2)
  const dir = new THREE.Vector3()

  for (let i = 0; i < cols; i++) {
    const theta = (i / AURORA_STEPS) * Math.PI * 2
    const wob = fbm(noise3, Math.cos(theta) * waveFreq, Math.sin(theta) * waveFreq, ringIndex * 4.1 + 2.3, 3, 2.15, 0.5)
    const angRadius = angRadius0 + wob * waveAmp
    const sinA = Math.sin(angRadius)
    const cosA = Math.cos(angRadius)
    dir.set(sinA * Math.cos(theta), cosA * poleSign, sinA * Math.sin(theta))

    for (let row = 0; row < 2; row++) {
      const vi = i * 2 + row
      const shellR = row === 0 ? AURORA_SHELL_R0 : AURORA_SHELL_R1
      positions[vi * 3] = dir.x * shellR
      positions[vi * 3 + 1] = dir.y * shellR
      positions[vi * 3 + 2] = dir.z * shellR
      grads[vi] = row
      alongs[vi] = i / AURORA_STEPS
    }
  }

  const indices = []
  for (let i = 0; i < AURORA_STEPS; i++) {
    const a = i * 2
    const b = i * 2 + 1
    const c = (i + 1) * 2
    const d = (i + 1) * 2 + 1
    indices.push(a, c, b, b, c, d)
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geo.setAttribute('grad', new THREE.BufferAttribute(grads, 1))
  geo.setAttribute('along', new THREE.BufferAttribute(alongs, 1))
  geo.setIndex(indices)

  const mat = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    vertexShader: `
      attribute float grad;
      attribute float along;
      varying float vGrad;
      varying float vAlong;
      varying vec3 vWorldPos;
      void main() {
        vGrad = grad;
        vAlong = along;
        vec4 worldPos = modelMatrix * vec4(position, 1.0);
        vWorldPos = worldPos.xyz;
        gl_Position = projectionMatrix * viewMatrix * worldPos;
      }
    `,
    fragmentShader: `
      uniform float uTime;
      uniform vec3 uSunDir;
      varying float vGrad;
      varying float vAlong;
      varying vec3 vWorldPos;

      float hash1(float n) { return fract(sin(n) * 43758.5453123); }
      float noise1(float x) {
        float i = floor(x);
        float f = fract(x);
        float u = f * f * (3.0 - 2.0 * f);
        return mix(hash1(i), hash1(i + 1.0), u);
      }
      // Manual smoothstep so reversed edges (a > b) behave the same
      // predictable way the JS util.js one does — GLSL's built-in leaves
      // that case undefined.
      float smoothstepSafe(float a, float b, float x) {
        float t = clamp((x - a) / (b - a), 0.0, 1.0);
        return t * t * (3.0 - 2.0 * t);
      }

      void main() {
        vec3 baseColor = vec3(0.302, 1.0, 0.651); // #4dffa6
        vec3 topColor = vec3(0.690, 0.486, 1.0);  // #b07cff
        vec3 col = mix(baseColor, topColor, clamp(vGrad, 0.0, 1.0));

        float w1 = noise1(vAlong * 9.0 + uTime * 0.55);
        float w2 = noise1(vAlong * 3.5 - uTime * 0.22 + 11.3);
        float waves = w1 * 0.6 + w2 * 0.4;

        // Soft fade at the ribbon's top/bottom edges instead of a hard cut.
        float edgeFade = sin(clamp(vGrad, 0.0, 1.0) * 3.14159265);
        // Night-side only: fades out approaching the sunlit terminator.
        float nightFade = smoothstepSafe(0.1, -0.25, dot(normalize(vWorldPos), uSunDir));

        float alpha = 0.35 * mix(0.25, 1.0, waves) * edgeFade * nightFade;
        gl_FragColor = vec4(col, alpha);
      }
    `,
  })

  return new THREE.Mesh(geo, mat)
}

/** Two wavy curtains per pole (4 total), all driven by one shared
 * {uTime, uSunDir} uniform pair updated once per frame in update(). */
function createAurora(seed) {
  const uniforms = {
    uTime: { value: 0 },
    uSunDir: { value: new THREE.Vector3(1, 0, 0) },
  }
  const group = new THREE.Group()
  for (const poleSign of [1, -1]) {
    for (let ringIndex = 0; ringIndex < 2; ringIndex++) {
      group.add(buildAuroraCurtain(seed, poleSign, ringIndex, uniforms))
    }
  }
  return { group, uniforms }
}

// ------------------------------------------------------------- meteors --

const METEOR_COUNT = 5
const METEOR_RADIUS = 70
const METEOR_FLASH_FRACTION = 0.18 // fraction of the active phase spent drawing on

/** Parks a meteor back in its (long) waiting phase. */
function scheduleMeteorWait(meteor) {
  meteor.active = false
  meteor.timer = 0
  meteor.phaseDuration = lerp(6, 20, meteor.rng())
  meteor.line.material.opacity = 0
}

/** Respawns a meteor "elsewhere": a short chord along a random great circle
 * on the r=METEOR_RADIUS sky sphere, bright head fading additively (via
 * vertex color, not alpha) to a dark tail. Geometry is mutated in place. */
function activateMeteor(meteor) {
  const rng = meteor.rng
  const p = randomOnUnitSphere(rng)
  const raw = randomOnUnitSphere(rng)
  const tangent = raw.addScaledVector(p, -raw.dot(p)).normalize()
  const halfLen = lerp(0.025, 0.05, rng())

  const head = p.clone().addScaledVector(tangent, halfLen).normalize().multiplyScalar(METEOR_RADIUS)
  const tail = p.clone().addScaledVector(tangent, -halfLen).normalize().multiplyScalar(METEOR_RADIUS)

  const posAttr = meteor.line.geometry.attributes.position
  posAttr.setXYZ(0, head.x, head.y, head.z)
  posAttr.setXYZ(1, tail.x, tail.y, tail.z)
  posAttr.needsUpdate = true

  const colAttr = meteor.line.geometry.attributes.color
  const brightness = lerp(1.1, 1.6, rng())
  colAttr.setXYZ(0, brightness, brightness * 0.97, brightness * 0.9)
  colAttr.setXYZ(1, 0, 0, 0)
  colAttr.needsUpdate = true

  meteor.active = true
  meteor.timer = 0
  meteor.phaseDuration = lerp(0.55, 0.85, rng())
}

function createMeteor(seed, index) {
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3))
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(6), 3))
  const mat = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    opacity: 0,
  })
  const line = new THREE.Line(geo, mat)
  line.frustumCulled = false // geometry is rewritten in place on respawn

  const meteor = {
    line,
    rng: rngFromString(`${seed}:meteor:${index}`),
    active: false,
    timer: 0,
    phaseDuration: 0,
  }
  scheduleMeteorWait(meteor)
  return meteor
}

/** Pool of METEOR_COUNT reusable streaks; each is independently timed from
 * its own seeded rng (rngFromString(seed+':meteor:'+n)), advancing that
 * generator every time it respawns — deterministic, no Math.random/Date.now. */
function createMeteors(seed) {
  const group = new THREE.Group()
  const meteors = []
  for (let i = 0; i < METEOR_COUNT; i++) {
    const meteor = createMeteor(seed, i)
    meteors.push(meteor)
    group.add(meteor.line)
  }
  return { group, meteors }
}
