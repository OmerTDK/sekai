// Terrain + ocean module. Builds a stylized, flat-shaded planet mesh (radius 1)
// from deterministic noise fields, plus a subtly animated translucent ocean
// shell. Everything is derived from `seed` so the same seed always yields the
// same planet.
import * as THREE from 'three'
import { SEA_LEVEL, makeNoise3D, fbm, ridged, clamp, smoothstep } from './util.js'

// ---------------------------------------------------------------------------
// Noise coordinate scales (multiplied into the unit direction before sampling)
// ---------------------------------------------------------------------------
const CONTINENT_SCALE = 1.25
const BELT_SCALE = 2.3
const MOUNTAIN_SCALE = 3.4
const DETAIL_SCALE = 8
const OCEAN_FLOOR_SCALE = 2.0
const MOISTURE_SCALE = 3.5
const JITTER_SCALE = 42
const CAP_SCALE = 2.6

// Continent mask threshold band (raw fbm ~[-1,1] -> smoothstep -> [0,1]).
// Tuned empirically against util.js's noise so land coverage lands ~30-40%.
const CONTINENT_LO = 0.02
const CONTINENT_HI = 0.16
// Mid-freq band mask half-width: how far from the noise's zero-crossing the
// "chain" of mountains extends. Narrow band -> winding ranges, not bumps.
const BELT_BAND_WIDTH = 0.32

// Height contribution budget (relative to SEA_LEVEL = 1.0).
const LAND_RISE = 0.012 // base lowland elevation
const MOUNTAIN_RISE = 0.03 // additional peak elevation on top of land
const DETAIL_AMP = 0.0035 // rolling small-scale bumps
const OCEAN_BASE_DEPTH = 0.016 // base basin depth below sea level
const OCEAN_FLOOR_AMP = 0.008 // gentle ocean floor variation

const HEIGHT_MIN = 0.975
const HEIGHT_MAX = 1.045

// Normalization ranges used only for color banding (not for sampleHeight).
const LAND_COLOR_RANGE = LAND_RISE + MOUNTAIN_RISE
const WATER_COLOR_RANGE = OCEAN_BASE_DEPTH + OCEAN_FLOOR_AMP

// Slope estimation (finite difference over a tangent step ~ one mesh edge at
// detail=100) and the resulting rock/snow response. Calibrated empirically:
// land slope from this noise stack has p75~0.33, p90~0.58, p99~1.26.
const SLOPE_EPS = 0.01
const ROCK_SLOPE_LO = 0.4
const ROCK_SLOPE_HI = 0.72
const SNOW_STEEP_LO = 0.5
const SNOW_STEEP_HI = 1.3

// Cheap AO from concavity (local height vs. its tangent-neighbor average).
// Concavity p90~0.002, tail out to ~0.02-0.03 at sharp valleys/ridges.
const AO_CONCAVITY_LO = 0.0006
const AO_CONCAVITY_HI = 0.004
const AO_MIN_MUL = 0.93 // subtle: strong per-vertex AO reads as triangular blotches on smooth shading

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------
const COLOR_BEACH = 0xd5c188
const COLOR_GRASS = 0x78a35b
const COLOR_FOREST = 0x46703f
const COLOR_ROCK = 0x8a8274
const COLOR_SNOW = 0xedf2f6
const COLOR_SHALLOW = 0xb8a97e
const COLOR_DEEP = 0x22303a

const OCEAN_COLOR = 0x2d6f9e
const OCEAN_EMISSIVE = 0x123a5e
// Multiplicative vertex-color tint (on top of OCEAN_COLOR) brightening +
// cooling shallow water for a sun-glint read; neutral (1,1,1) at depth.
const OCEAN_SHALLOW_MUL = [1.06, 1.16, 1.14]
const OCEAN_DEEP_MUL = [1, 1, 1]

export function createPlanet(seed) {
  // --- deterministic noise fields, all namespaced off the same seed -------
  const nContinent = makeNoise3D(seed + ':continents')
  const nBelt = makeNoise3D(seed + ':belt')
  const nMountain = makeNoise3D(seed + ':mountains')
  const nDetail = makeNoise3D(seed + ':detail')
  const nOceanFloor = makeNoise3D(seed + ':oceanfloor')
  const nMoisture = makeNoise3D(seed + ':moisture')
  const nJitter = makeNoise3D(seed + ':jitter')
  const nCap = makeNoise3D(seed + ':caps')

  // Low-freq fbm pushed through smoothstep -> a handful of distinct
  // landmasses (not one blob), coastlines follow the noise field's organic
  // contours rather than a circle.
  function continentField(x, y, z) {
    const raw = fbm(nContinent, x * CONTINENT_SCALE, y * CONTINENT_SCALE, z * CONTINENT_SCALE, 5, 2.0, 0.5)
    return smoothstep(CONTINENT_LO, CONTINENT_HI, raw)
  }

  // Mid-freq noise band: mask is 1 near the field's zero-crossing and falls
  // off away from it, so it traces winding chain-like ridgelines instead of
  // being uniformly bumpy everywhere.
  function beltField(x, y, z) {
    const raw = fbm(nBelt, x * BELT_SCALE, y * BELT_SCALE, z * BELT_SCALE, 3, 2.0, 0.5)
    return 1 - smoothstep(0.0, BELT_BAND_WIDTH, Math.abs(raw))
  }

  // Terrain radius along `dir`. Deterministic, cheap, allocation-free: only
  // reads dir.x/y/z and does scalar arithmetic (fbm/ridged/smoothstep/clamp
  // are themselves allocation-free). Safe to call every frame from other
  // modules (e.g. to place agents/structures).
  function sampleHeight(dir) {
    const x = dir.x
    const y = dir.y
    const z = dir.z

    const continent = continentField(x, y, z)
    const belt = beltField(x, y, z)

    const ridge = ridged(nMountain, x * MOUNTAIN_SCALE, y * MOUNTAIN_SCALE, z * MOUNTAIN_SCALE, 4, 2.1, 0.55)
    const mountains = ridge * belt * continent // chains, masked to land

    const detail = fbm(nDetail, x * DETAIL_SCALE, y * DETAIL_SCALE, z * DETAIL_SCALE, 4, 2.0, 0.5)
    const floor = fbm(nOceanFloor, x * OCEAN_FLOOR_SCALE, y * OCEAN_FLOOR_SCALE, z * OCEAN_FLOOR_SCALE, 4, 2.0, 0.5)

    let h = SEA_LEVEL
    h += continent * LAND_RISE
    h += mountains * MOUNTAIN_RISE
    h += detail * DETAIL_AMP * (0.35 + 0.65 * continent) // slightly damped underwater
    h += (1 - continent) * (floor * OCEAN_FLOOR_AMP - OCEAN_BASE_DEPTH) // gentle basin

    return clamp(h, HEIGHT_MIN, HEIGHT_MAX)
  }

  function isLand(dir) {
    return sampleHeight(dir) > SEA_LEVEL + 0.0015
  }

  // Compact biome sample for flora/effect placement. Uses the same noise
  // fields as the vertex coloring below, so scattered props (grass, trees,
  // rocks) land on ground that visually matches. Load-time use only — not
  // tuned for per-frame calls.
  function biomeAt(dir, out = {}) {
    const x = dir.x
    const y = dir.y
    const z = dir.z
    const h = sampleHeight(dir)
    out.h = h
    out.landT = clamp((h - SEA_LEVEL) / LAND_COLOR_RANGE, 0, 1)
    out.moisture = fbm(nMoisture, x * MOISTURE_SCALE, y * MOISTURE_SCALE, z * MOISTURE_SCALE, 4, 2.0, 0.5) * 0.5 + 0.5
    const { slope } = estimateSlopeAndConcavity(x, y, z, h)
    out.slope = clamp(slope / ROCK_SLOPE_HI, 0, 1)
    const capNoiseVal = fbm(nCap, x * CAP_SCALE, y * CAP_SCALE, z * CAP_SCALE, 3, 2.0, 0.5)
    const capThreshold = 0.86 + capNoiseVal * 0.07
    out.polar = smoothstep(capThreshold - 0.04, capThreshold + 0.04, Math.abs(y))
    return out
  }

  // --- slope / concavity (build-time only; used for coloring, not exported) -
  // Finite-difference sampleHeight at two tangent offsets around dir to get
  // a cheap local slope magnitude and a concavity value (positive where the
  // tangent neighbors sit higher than this point, i.e. valley floors).
  const upRefY = new THREE.Vector3(0, 1, 0)
  const upRefX = new THREE.Vector3(1, 0, 0)
  const slopeDir = new THREE.Vector3()
  const slopeTangent1 = new THREE.Vector3()
  const slopeTangent2 = new THREE.Vector3()
  const slopeSampleA = new THREE.Vector3()
  const slopeSampleB = new THREE.Vector3()

  function estimateSlopeAndConcavity(x, y, z, h) {
    slopeDir.set(x, y, z)
    const upRef = Math.abs(y) > 0.95 ? upRefX : upRefY
    slopeTangent1.crossVectors(slopeDir, upRef).normalize()
    slopeTangent2.crossVectors(slopeDir, slopeTangent1).normalize()
    slopeSampleA.copy(slopeDir).addScaledVector(slopeTangent1, SLOPE_EPS).normalize()
    slopeSampleB.copy(slopeDir).addScaledVector(slopeTangent2, SLOPE_EPS).normalize()

    const hA = sampleHeight(slopeSampleA)
    const hB = sampleHeight(slopeSampleB)
    const slope = (Math.abs(hA - h) + Math.abs(hB - h)) / (2 * SLOPE_EPS)
    const concavity = (hA + hB) * 0.5 - h
    return { slope, concavity }
  }

  // --- vertex coloring (build-time only; free to allocate here) -----------
  const cBeach = new THREE.Color(COLOR_BEACH)
  const cGrass = new THREE.Color(COLOR_GRASS)
  const cForest = new THREE.Color(COLOR_FOREST)
  const cRock = new THREE.Color(COLOR_ROCK)
  const cSnow = new THREE.Color(COLOR_SNOW)
  const cShallow = new THREE.Color(COLOR_SHALLOW)
  const cDeep = new THREE.Color(COLOR_DEEP)

  // Writes the stylized terrain color for direction (x,y,z) at height h into
  // `out`. Height + latitude + a moisture band decide the biome; a high-freq
  // jitter noise perturbs the band thresholds (and final value) so
  // boundaries dither instead of banding.
  function terrainColorAt(x, y, z, h, out) {
    const jitter = fbm(nJitter, x * JITTER_SCALE, y * JITTER_SCALE, z * JITTER_SCALE, 2, 2.0, 0.5)
    const { slope, concavity } = estimateSlopeAndConcavity(x, y, z, h)

    if (h < SEA_LEVEL) {
      const depthT = clamp((SEA_LEVEL - h) / WATER_COLOR_RANGE + jitter * 0.06, 0, 1)
      out.copy(cShallow).lerp(cDeep, smoothstep(0, 1, depthT))
    } else {
      const landT = clamp((h - SEA_LEVEL) / LAND_COLOR_RANGE, 0, 1)
      const moisture = fbm(nMoisture, x * MOISTURE_SCALE, y * MOISTURE_SCALE, z * MOISTURE_SCALE, 4, 2.0, 0.5) * 0.5 + 0.5

      // Rock wins from elevation OR from being a steep face -- cliffs and
      // mountainsides read as rock regardless of altitude band, which is
      // what actually sells a mountain range at a glance. Bands are kept
      // narrow so biome edges stay sharp facet-to-facet.
      const elevationRockT = smoothstep(0.3, 0.68, landT + jitter * 0.05)
      const slopeRockT = smoothstep(ROCK_SLOPE_LO, ROCK_SLOPE_HI, slope)
      const rockT = Math.max(elevationRockT, slopeRockT)

      // band must span >= 2 vertex steps or the shoreline aliases into sawteeth
      const beachW = 1 - smoothstep(0.0, 0.045, landT + jitter * 0.015)
      const forestW = smoothstep(0.42, 0.58, moisture) * (1 - rockT)

      out.copy(cGrass).lerp(cRock, rockT)
      out.lerp(cForest, forestW * 0.9)
      out.lerp(cBeach, beachW)

      // Snow on high peaks OR polar caps, whichever wins. Cap boundary uses
      // |y| (unit-sphere proxy for latitude) offset by a low-freq noise so
      // it isn't a perfect circle around each pole. Damped on very steep
      // faces -- snow doesn't cling to cliffs, it exposes rock instead.
      const peakT = smoothstep(0.74, 0.86, landT)
      const capNoiseVal = fbm(nCap, x * CAP_SCALE, y * CAP_SCALE, z * CAP_SCALE, 3, 2.0, 0.5)
      const capThreshold = 0.86 + capNoiseVal * 0.07 // caps stay poleward of ~57-68 deg
      const lat = Math.abs(y)
      const polarT = smoothstep(capThreshold - 0.035, capThreshold + 0.035, lat)
      const steepDamp = 1 - smoothstep(SNOW_STEEP_LO, SNOW_STEEP_HI, slope) * 0.6
      const snowW = clamp(Math.max(peakT, polarT) + jitter * 0.05, 0, 1) * steepDamp
      out.lerp(cSnow, snowW)
    }

    // Cheap AO: valley floors / concavities read slightly darker.
    const aoT = smoothstep(AO_CONCAVITY_LO, AO_CONCAVITY_HI, concavity)
    const aoMul = 1 - aoT * (1 - AO_MIN_MUL)

    // Hand-painted per-vertex value jitter, combined with AO. Kept subtle:
    // smooth shading shows speckle much more than flat facets did.
    const shade = (1 + jitter * 0.012) * aoMul
    out.r = clamp(out.r * shade, 0, 1)
    out.g = clamp(out.g * shade, 0, 1)
    out.b = clamp(out.b * shade, 0, 1)
  }

  // --- terrain mesh ---------------------------------------------------------
  // detail=128 -> ~327k tris, ~164k verts; smooth-shaded with per-vertex
  // biome colors. Smooth normals + tight biome bands read as clean painted
  // fields with crisp borders — no visible triangulation up close.
  const terrainGeo = new THREE.IcosahedronGeometry(1, 128)
  const posAttr = terrainGeo.attributes.position
  const vertexCount = posAttr.count
  const colorArray = new Float32Array(vertexCount * 3)

  const dir = new THREE.Vector3() // scratch, reused across the build loop
  const vColor = new THREE.Color() // scratch, reused across the build loop

  for (let i = 0; i < vertexCount; i++) {
    dir.set(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i)).normalize()
    const h = sampleHeight(dir)
    posAttr.setXYZ(i, dir.x * h, dir.y * h, dir.z * h)

    terrainColorAt(dir.x, dir.y, dir.z, h, vColor)
    colorArray[i * 3] = vColor.r
    colorArray[i * 3 + 1] = vColor.g
    colorArray[i * 3 + 2] = vColor.b
  }
  posAttr.needsUpdate = true
  terrainGeo.setAttribute('color', new THREE.BufferAttribute(colorArray, 3))
  // Normals (and bounds) must be recomputed from the displaced positions,
  // not the original unit icosahedron -- both for correct lighting and so
  // culling/raycasting bounds cover the displaced mountains.
  terrainGeo.computeVertexNormals()
  terrainGeo.computeBoundingSphere()

  const terrainMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    flatShading: false, // smooth fields, crisp band edges — no triangle mosaics
    roughness: 0.95,
    metalness: 0,
  })
  const terrainMesh = new THREE.Mesh(terrainGeo, terrainMat)

  // --- ocean mesh -----------------------------------------------------------
  const oceanGeo = new THREE.SphereGeometry(SEA_LEVEL, 128, 96)

  // Per-vertex multiplicative tint (brighter/cooler over shallow terrain, for
  // a sun-glint read), keyed off the terrain height directly beneath each
  // ocean vertex. Cheap: ocean has ~12.5k vertices vs. the terrain's ~200k+.
  const oceanPosAttr = oceanGeo.attributes.position
  const oceanVertexCount = oceanPosAttr.count
  const oceanColorArray = new Float32Array(oceanVertexCount * 3)
  const oceanDir = new THREE.Vector3()
  const oceanTint = new THREE.Color()
  const shallowMulColor = new THREE.Color(...OCEAN_SHALLOW_MUL)
  const deepMulColor = new THREE.Color(...OCEAN_DEEP_MUL)
  for (let i = 0; i < oceanVertexCount; i++) {
    oceanDir.set(oceanPosAttr.getX(i), oceanPosAttr.getY(i), oceanPosAttr.getZ(i)).normalize()
    const seafloorH = sampleHeight(oceanDir)
    const depthT = clamp((SEA_LEVEL - seafloorH) / WATER_COLOR_RANGE, 0, 1)
    const shallowFactor = 1 - smoothstep(0, 1, depthT)
    oceanTint.copy(deepMulColor).lerp(shallowMulColor, shallowFactor)
    oceanColorArray[i * 3] = oceanTint.r
    oceanColorArray[i * 3 + 1] = oceanTint.g
    oceanColorArray[i * 3 + 2] = oceanTint.b
  }
  oceanGeo.setAttribute('color', new THREE.BufferAttribute(oceanColorArray, 3))

  const oceanMat = new THREE.MeshStandardMaterial({
    color: OCEAN_COLOR,
    vertexColors: true,
    transparent: true,
    opacity: 0.86,
    roughness: 0.42, // low enough for a glint, high enough not to blow out a hemisphere
    metalness: 0.02,
    emissive: OCEAN_EMISSIVE,
    emissiveIntensity: 0.25,
    depthWrite: true,
  })

  // Gentle living-water feel: displace vertices along their normal by a few
  // summed sines of object-space position + time. Guarded so a shader-chunk
  // mismatch in a future three.js version degrades to plain static water
  // instead of breaking the material.
  let waterUniforms = null
  let waterElapsed = 0
  oceanMat.onBeforeCompile = (shader) => {
    try {
      shader.uniforms.uTime = { value: waterElapsed }
      shader.vertexShader = `uniform float uTime;\n${shader.vertexShader}`
      const patched = shader.vertexShader.replace(
        '#include <begin_vertex>',
        [
          'vec3 transformed = vec3( position );',
          'float swell =',
          '  sin( dot( position, vec3( 1.3, 0.7, 0.4 ) ) * 18.0 + uTime * 1.1 ) +',
          '  sin( dot( position, vec3( -0.6, 1.1, 0.8 ) ) * 24.0 - uTime * 0.8 ) +',
          '  sin( dot( position, vec3( 0.9, -0.5, 1.2 ) ) * 14.0 + uTime * 1.6 );',
          'transformed += normal * ( swell * 0.00027 );',
        ].join('\n')
      )
      if (patched === shader.vertexShader) throw new Error('planet.js: ocean shader injection point not found')
      shader.vertexShader = patched
      waterUniforms = shader.uniforms
    } catch (err) {
      waterUniforms = null // fall back to static water
    }
  }

  const oceanMesh = new THREE.Mesh(oceanGeo, oceanMat)

  // --- assembly ---------------------------------------------------------
  const group = new THREE.Group()
  group.add(terrainMesh)
  group.add(oceanMesh)

  function update(dt) {
    waterElapsed += dt
    if (waterUniforms) waterUniforms.uTime.value = waterElapsed
  }

  return { group, sampleHeight, isLand, biomeAt, update }
}
