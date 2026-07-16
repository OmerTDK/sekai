// Stars, atmosphere, clouds, moons and all scene lighting for the stylized
// planet. Everything here is deterministic from the seed string — same seed,
// same sky, every launch. This module owns every light in the scene.
import * as THREE from 'three'
import { makeNoise3D, fbm, rngFromString, clamp, lerp, smoothstep } from './util.js'

const Y_AXIS = new THREE.Vector3(0, 1, 0)

// Other modules assume this exact sun direction — do not change.
const SUN_DIR = new THREE.Vector3(1, 0.45, 0.9).normalize()

export function createSky(seed) {
  const group = new THREE.Group()

  group.add(createStarfield(seed))
  group.add(createNebulae(seed))
  group.add(createAtmosphere())
  const sunSprite = createSunSprite()
  group.add(sunSprite)

  const clouds = createClouds(seed)
  group.add(clouds.lowerMesh, clouds.upperMesh)

  const lights = createLights()
  group.add(lights.sun, lights.target, lights.hemi, lights.moonFill)

  const moons = createMoons(seed)
  for (const moon of moons) group.add(moon.pivot)

  // Day/night cycle: the sun sweeps a full orbit every ~15 minutes so every
  // settlement gets its dawn (with a fixed sun, half the world would live in
  // eternal night).
  const SUN_ORBIT_RATE = (Math.PI * 2) / 900

  function update(dt /* sec */, camera /* THREE.PerspectiveCamera */) {
    clouds.lowerMesh.rotateOnWorldAxis(clouds.lowerAxis, clouds.lowerRate * dt)
    clouds.upperMesh.rotateOnWorldAxis(clouds.upperAxis, clouds.upperRate * dt)
    for (const moon of moons) moon.pivot.rotateY(moon.rate * dt)

    const sunAngle = SUN_ORBIT_RATE * dt
    lights.sun.position.applyAxisAngle(Y_AXIS, sunAngle)
    sunSprite.position.applyAxisAngle(Y_AXIS, sunAngle)
    lights.moonFill.position.copy(lights.sun.position).multiplyScalar(-1)

    // Fade the cloud deck away as the camera dives toward the surface, so
    // close-up views of settlements aren't fogged out. Full deck from 2.4R
    // out, thin wisps by 1.35R.
    const dist = camera.position.length()
    const fade = smoothstep(1.35, 2.4, dist)
    clouds.lowerMesh.material.opacity = 0.88 * Math.max(fade, 0.08)
    clouds.upperMesh.material.opacity = 0.5 * Math.max(fade, 0.05)
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
  const sun = new THREE.DirectionalLight(new THREE.Color('#fff2d8'), 2.3)
  sun.position.copy(SUN_DIR).multiplyScalar(10)
  const target = new THREE.Object3D() // stays at the origin: the planet
  sun.target = target

  const hemi = new THREE.HemisphereLight(new THREE.Color('#9db8ff'), new THREE.Color('#3a3128'), 0.62)

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

/** Small moons on inclined, seeded circular orbits. Each orbit is a pivot
 * Object3D tilted once at creation; advancing it each frame with rotateY
 * spins the (fixed) tilted axis, sweeping the moon around the planet. */
function createMoons(seed) {
  const specs = [
    { name: 'crater', distance: 2.6, kind: 'crater' },
    { name: 'tinted', distance: 3.8, kind: 'tinted' },
  ]

  return specs.map((spec) => {
    const rng = rngFromString(`${seed}:moon-${spec.name}`)
    const radius = lerp(0.05, 0.09, rng())
    const distance = spec.distance * lerp(0.95, 1.05, rng())
    const rate = lerp(0.01, 0.02, rng())

    const pivot = new THREE.Object3D()
    const tiltAxis = new THREE.Vector3(rng() - 0.5, 0, rng() - 0.5).normalize()
    const tiltAngle = lerp(0.15, 0.55, rng())
    pivot.quaternion.setFromAxisAngle(tiltAxis, tiltAngle)
    pivot.rotateY(rng() * Math.PI * 2) // random starting phase

    const mesh = buildMoonMesh(seed, radius, spec.kind)
    mesh.position.set(distance, 0, 0)
    pivot.add(mesh)

    return { pivot, rate }
  })
}
