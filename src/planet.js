// Terrain + ocean module. Builds a stylized, flat-shaded planet mesh (radius 1)
// from deterministic noise fields, plus a subtly animated translucent ocean
// shell. Everything is derived from `seed` so the same seed always yields the
// same planet.
import * as THREE from 'three/webgpu'
// M3/TSL: the terrain + ocean shader customizations are node graphs now
// (the classic string-injection compile hook is silently ignored under
// WebGPURenderer). These are the exact node factories/accessors used below.
import {
  Fn,
  If,
  attribute,
  uniform,
  texture,
  color,
  vec2,
  vec3,
  mix,
  step,
  atan,
  positionGeometry,
  positionLocal,
  positionView,
  positionWorld,
  normalLocal,
  normalWorld,
  cameraPosition,
  transformNormalToView,
} from 'three/tsl'
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js'
import { SEA_LEVEL, makeNoise3D, fbm, ridged, clamp, smoothstep } from './util.js'
// M-SKY cloud-shadows-on-terrain: architect-pinned contract, see sky.js's
// getCloudShadowUniforms() doc comment for the uniform shapes and the
// world-dir -> shell-UV formula the terrain colorNode below replicates in
// TSL. Imported at the top per normal ES-module style; the GETTER is called
// once at construction and guarded (try/catch + warn-once flag below) so a
// contract mismatch degrades gracefully instead of breaking terrain rendering.
import { getCloudShadowUniforms } from './sky.js'

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
// M-LD fjord-warp (recipe B): mid-freq vector-noise scale that warps the
// continent field's SAMPLE COORDINATES before its fbm, so coastlines fold
// into inlets/fjords instead of following raw noise contours. Ported
// verbatim from spikes/ld-terrain/recipes.js buildB.
const WARP_SCALE = 2.6
const WARP_STRENGTH = 0.2
// M-LD archipelago (recipe C): higher-freq island-blob band, gated to a
// coastal fringe measured in raw continent-noise space (straddling the
// mainland threshold band [CONTINENT_LO, CONTINENT_HI] below) so islands
// read as offshore arcs near a landmass, not scattered mid-ocean. The gate
// reuses the WARPED raw continent value (see continentField), so island
// arcs trace the now-fjorded coastline too -- i.e. skerries. Ported
// verbatim from spikes/ld-terrain/recipes.js buildC.
const ISLAND_SCALE = 4.4
const ISLAND_LO = 0.1
const ISLAND_HI = 0.34
const NEARSHORE_CENTER = 0.08
const NEARSHORE_WIDTH = 0.09

// Continent mask threshold band (raw fbm ~[-1,1] -> smoothstep -> [0,1]).
// Tuned empirically against util.js's noise so land coverage lands ~30-40%
// (measured ~44% with the M-LD B+C+D terrain below -- within the accepted
// 35-45% band recorded in the program plan's M-LD verdict).
const CONTINENT_LO = 0.02
const CONTINENT_HI = 0.16
// Mid-freq band mask half-width: how far from the noise's zero-crossing the
// "chain" of mountains extends. Narrow band -> winding ranges, not bumps.
const BELT_BAND_WIDTH = 0.32

// Height contribution budget (relative to SEA_LEVEL = 1.0).
const LAND_RISE = 0.012 // base lowland elevation
// M-LD dramatic-relief (recipe D): mountain rise x1.8 over the pre-M-LD
// baseline (0.03) for chunkier massifs; ridge crests are sharpened by
// RIDGE_SHARPNESS and valleys carved by VALLEY_DEPTH in sampleHeight below.
// Ported verbatim from spikes/ld-terrain/recipes.js buildD.
const MOUNTAIN_RISE = 0.054
const RIDGE_SHARPNESS = 1.6 // power-curve on the ridge value: narrows crests, deepens flanks
const VALLEY_DEPTH = 0.016 // inverted-ridge subtraction: carves valley floors between peaks
const DETAIL_AMP = 0.0025 // rolling small-scale bumps
// M-LD dramatic-relief: steeper coastal shelf, x1.25 over the pre-M-LD
// baseline (0.016) -- see coastShelf in sampleHeight below.
const OCEAN_BASE_DEPTH = 0.02 // base basin depth below sea level
const OCEAN_FLOOR_AMP = 0.008 // gentle ocean floor variation
// coastShelf transition band, measured in continent-MASK space (already
// smoothstepped to [0,1]) rather than raw noise space -- narrower than the
// mask's own [0,1] range, so ocean floor depth ramps up over a short band
// just offshore instead of baseline's whole-range falloff: mild coastal
// cliffs. Ported verbatim from spikes/ld-terrain/recipes.js buildD.
const COAST_SHELF_LO = 0.4
const COAST_SHELF_HI = 0.62

const HEIGHT_MIN = 0.975
// M-LD PINNED CONSTANT (binding, program plan M-LD section): 1.045 -> 1.06.
// Siblings rebase cloud shells / storm patch / bird altitude / atmosphere
// against exactly this value -- do not retune without re-coordinating.
// Dramatic-relief's unclamped peak lands ~1.058-1.062 depending on sample
// density (spike itself overshot to ~1.057 at this same cap) -- the clamp
// below makes sure the shipped output never exceeds 1.06.
const HEIGHT_MAX = 1.06

// Normalization ranges used only for color banding (not for sampleHeight).
// Recomputed automatically from the M-LD constants above so every
// height-budget-derived color threshold (snowline, elevation rock bands,
// ocean depth bands) keeps the same VISUAL position on the new, taller
// relief -- terrainColorAt's own threshold numbers are unchanged fractions.
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
const AO_MIN_MUL = 0.97 // near-off: per-vertex AO reads as triangular blotches on smooth shading

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------
const COLOR_BEACH = 0xd5c188
const COLOR_GRASS = 0x78a35b
const COLOR_DRYGRASS = 0xb0a35c // savanna end of the moisture gradient
const COLOR_DESERT = 0xd9bd7f
const COLOR_FOREST = 0x46703f
const COLOR_ROCK = 0x8a8274
const COLOR_TUNDRA = 0x8f9682 // cold scrub ring below the ice caps
const COLOR_SNOW = 0xedf2f6
const COLOR_SHALLOW = 0xb8a97e
const COLOR_DEEP = 0x22303a

const OCEAN_COLOR = 0x2d6f9e
const OCEAN_EMISSIVE = 0x123a5e
// Multiplicative vertex-color tint (on top of OCEAN_COLOR) brightening +
// cooling shallow water for a sun-glint read; neutral (1,1,1) at depth.
const OCEAN_SHALLOW_MUL = [1.06, 1.16, 1.14]
const OCEAN_DEEP_MUL = [1, 1, 1]

// ---------------------------------------------------------------------------
// Silent-fallback rule: every graceful-degradation path warns exactly once.
// ---------------------------------------------------------------------------
let warnedCloudShadow = false
let warnedNormalMapLoad = false

// ---------------------------------------------------------------------------
// TSL node helpers (M3): the terrain splat/detail-normal chains, formerly GLSL
// injected as shader-chunk strings, are node composition now. These build
// lazily inside the colorNode/normalNode Fn graphs (which supply the stack).
// ---------------------------------------------------------------------------

// Tangentless triplanar albedo blend: sample `texNode` on the three world
// planes (yz/xz/xy) of object-space position `p`, blended by the per-axis
// weights `bw`. Mirrors planet.js's former GLSL triplanar() exactly.
function triplanarColor(texNode, p, bw, scale) {
  const cx = texNode.sample(p.yz.mul(scale)).rgb
  const cy = texNode.sample(p.xz.mul(scale)).rgb
  const cz = texNode.sample(p.xy.mul(scale)).rgb
  return cx.mul(bw.x).add(cy.mul(bw.y)).add(cz.mul(bw.z))
}

// Tangentless "whiteout" triplanar normal blend — folds the in-plane
// components of the flat object-space normal `n` into each planar sample
// before the final swizzle (no per-vertex tangent needed). Mirrors the former
// GLSL triplanarNormal(); returns a perturbed object-space normal.
function triplanarNormalSample(texNode, p, n, bw, scale) {
  const tx = texNode.sample(p.yz.mul(scale)).xyz.mul(2).sub(1).toVar()
  const ty = texNode.sample(p.xz.mul(scale)).xyz.mul(2).sub(1).toVar()
  const tz = texNode.sample(p.xy.mul(scale)).xyz.mul(2).sub(1).toVar()
  tx.assign(vec3(tx.xy.add(n.yz), tx.z.abs().mul(n.x)))
  ty.assign(vec3(ty.xy.add(n.xz), ty.z.abs().mul(n.y)))
  tz.assign(vec3(tz.xy.add(n.xy), tz.z.abs().mul(n.z)))
  return tx.zxy.mul(bw.x).add(ty.xzy.mul(bw.y)).add(tz.xyz.mul(bw.z)).normalize()
}

// 1x1 placeholder so every texture() node has a valid, correctly-colorspaced
// texture at graph-build time; the async loaders swap in the real maps via
// `.value` (a cheap binding refresh, never a graph rebuild). Detail/normal
// layers stay gated off (uDetailOn/uNormalOn = 0) until their four maps land,
// so the placeholder is never visible.
function makePlaceholderTexture(colorSpace, rgba) {
  const tex = new THREE.DataTexture(new Uint8Array(rgba), 1, 1)
  tex.colorSpace = colorSpace
  tex.needsUpdate = true
  return tex
}

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
  // M-LD fjord-warp (B): 3 independent vector-noise channels warp the
  // continent field's sample coordinates before its fbm.
  const nWarpX = makeNoise3D(seed + ':fjordwarpx')
  const nWarpY = makeNoise3D(seed + ':fjordwarpy')
  const nWarpZ = makeNoise3D(seed + ':fjordwarpz')
  // M-LD archipelago (C): higher-freq island-blob band.
  const nIsland = makeNoise3D(seed + ':islands')

  // Low-freq fbm pushed through smoothstep -> a handful of distinct
  // landmasses (not one blob). M-LD: sample coordinates are domain-warped
  // (fjord-warp, recipe B) before the fbm so coastlines fold into
  // inlets/fjords instead of following raw noise contours; a second,
  // higher-freq island band (archipelago, recipe C) is gated to the
  // now-fjorded coastline's fringe so it reads as offshore island
  // arcs/skerries rather than noise scattered across the open ocean.
  function continentField(x, y, z) {
    const wx = fbm(nWarpX, x * WARP_SCALE, y * WARP_SCALE, z * WARP_SCALE, 3, 2.0, 0.5)
    const wy = fbm(nWarpY, x * WARP_SCALE, y * WARP_SCALE, z * WARP_SCALE, 3, 2.0, 0.5)
    const wz = fbm(nWarpZ, x * WARP_SCALE, y * WARP_SCALE, z * WARP_SCALE, 3, 2.0, 0.5)
    const wx2 = x + wx * WARP_STRENGTH
    const wy2 = y + wy * WARP_STRENGTH
    const wz2 = z + wz * WARP_STRENGTH
    const raw = fbm(
      nContinent,
      wx2 * CONTINENT_SCALE,
      wy2 * CONTINENT_SCALE,
      wz2 * CONTINENT_SCALE,
      5,
      2.0,
      0.5,
    )
    const mainland = smoothstep(CONTINENT_LO, CONTINENT_HI, raw)

    const nearShore = 1 - smoothstep(0.0, NEARSHORE_WIDTH, Math.abs(raw - NEARSHORE_CENTER))
    const islandRaw = fbm(nIsland, x * ISLAND_SCALE, y * ISLAND_SCALE, z * ISLAND_SCALE, 4, 2.0, 0.5)
    const islandMask = smoothstep(ISLAND_LO, ISLAND_HI, islandRaw) * nearShore
    return Math.max(mainland, islandMask)
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
  //
  // M-LD dramatic-relief (recipe D): ridge crests are sharpened by a
  // power-curve (RIDGE_SHARPNESS) for chunkier massifs, valleys are carved
  // by subtracting the inverted ridge value, and the ocean floor blend uses
  // the narrower coastShelf transition (in continent-mask space) for a
  // steeper shelf just offshore instead of baseline's whole-range falloff.
  // Ported verbatim from spikes/ld-terrain/recipes.js buildD.
  function sampleHeight(dir) {
    const x = dir.x
    const y = dir.y
    const z = dir.z

    const continent = continentField(x, y, z)
    const belt = beltField(x, y, z)

    const ridgeRaw = ridged(
      nMountain,
      x * MOUNTAIN_SCALE,
      y * MOUNTAIN_SCALE,
      z * MOUNTAIN_SCALE,
      5,
      2.3,
      0.6,
    )
    const ridgeSharp = Math.pow(ridgeRaw, RIDGE_SHARPNESS)
    const mountains = ridgeSharp * belt * continent // chains, masked to land
    const valleyCarve = (1 - ridgeRaw) * belt * continent

    const detail = fbm(nDetail, x * DETAIL_SCALE, y * DETAIL_SCALE, z * DETAIL_SCALE, 3, 2.0, 0.5)
    const floor = fbm(
      nOceanFloor,
      x * OCEAN_FLOOR_SCALE,
      y * OCEAN_FLOOR_SCALE,
      z * OCEAN_FLOOR_SCALE,
      4,
      2.0,
      0.5,
    )
    const coastShelf = smoothstep(COAST_SHELF_LO, COAST_SHELF_HI, continent)

    let h = SEA_LEVEL
    h += continent * LAND_RISE
    h += mountains * MOUNTAIN_RISE
    h -= valleyCarve * VALLEY_DEPTH
    h += detail * DETAIL_AMP * (0.35 + 0.65 * continent) // slightly damped underwater
    h += (1 - coastShelf) * (floor * OCEAN_FLOOR_AMP - OCEAN_BASE_DEPTH) // gentle basin, steeper shelf

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
    out.moisture =
      fbm(nMoisture, x * MOISTURE_SCALE, y * MOISTURE_SCALE, z * MOISTURE_SCALE, 2, 2.0, 0.5) * 0.5 + 0.5
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
  const cDryGrass = new THREE.Color(COLOR_DRYGRASS)
  const cDesert = new THREE.Color(COLOR_DESERT)
  const cForest = new THREE.Color(COLOR_FOREST)
  const cRock = new THREE.Color(COLOR_ROCK)
  const cTundra = new THREE.Color(COLOR_TUNDRA)
  const cSnow = new THREE.Color(COLOR_SNOW)
  const cShallow = new THREE.Color(COLOR_SHALLOW)
  const cDeep = new THREE.Color(COLOR_DEEP)

  // Texture-splat weights for the vertex being colored: grass / rock / sand /
  // snow. terrainColorAt fills this alongside the color; the mesh build loop
  // copies it into the biomeW vertex attribute for the detail shader.
  const _w = { grass: 0, rock: 0, sand: 0, snow: 0 }

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
      _w.sand = 1 - depthT
      _w.rock = depthT
      _w.grass = 0
      _w.snow = 0
    } else {
      const landT = clamp((h - SEA_LEVEL) / LAND_COLOR_RANGE, 0, 1)
      // 2 octaves only: high-frequency moisture flips biomes per vertex,
      // which reads as triangle mosaic. Low-freq -> continent-scale biomes.
      const moisture =
        fbm(nMoisture, x * MOISTURE_SCALE, y * MOISTURE_SCALE, z * MOISTURE_SCALE, 2, 2.0, 0.5) * 0.5 + 0.5

      // Moisture axis: desert -> savanna -> grassland -> forest.
      const lushT = smoothstep(0.32, 0.6, moisture)
      const desertT = 1 - smoothstep(0.24, 0.34, moisture)
      const forestW = smoothstep(0.52, 0.64, moisture)

      // Rock wins from elevation OR from being a steep face -- cliffs and
      // mountainsides read as rock regardless of altitude band, which is
      // what actually sells a mountain range at a glance.
      const elevationRockT = smoothstep(0.3, 0.68, landT + jitter * 0.05)
      const slopeRockT = smoothstep(ROCK_SLOPE_LO, ROCK_SLOPE_HI, slope)
      const rockT = Math.max(elevationRockT, slopeRockT)

      // band must span >= 2 vertex steps or the shoreline aliases into sawteeth
      const beachW = 1 - smoothstep(0.0, 0.045, landT + jitter * 0.015)

      out.copy(cDryGrass).lerp(cGrass, lushT)
      out.lerp(cForest, forestW * 0.9 * (1 - rockT))
      out.lerp(cDesert, desertT * (1 - rockT * 0.6))
      out.lerp(cRock, rockT)

      // Snow on high peaks OR polar caps, whichever wins. Cap boundary uses
      // |y| (unit-sphere proxy for latitude) offset by a low-freq noise so
      // it isn't a perfect circle around each pole. Damped on very steep
      // faces -- snow doesn't cling to cliffs, it exposes rock instead.
      const peakT = smoothstep(0.74, 0.86, landT)
      const capNoiseVal = fbm(nCap, x * CAP_SCALE, y * CAP_SCALE, z * CAP_SCALE, 3, 2.0, 0.5)
      const capThreshold = 0.86 + capNoiseVal * 0.07 // caps stay poleward of ~57-68 deg
      const lat = Math.abs(y)
      const polarT = smoothstep(capThreshold - 0.035, capThreshold + 0.035, lat)
      // Cold scrub ring just equatorward of the cap: mutes greens before the ice.
      const tundraT = smoothstep(capThreshold - 0.16, capThreshold - 0.05, lat) * (1 - polarT)
      out.lerp(cTundra, tundraT * 0.85)
      out.lerp(cBeach, beachW)

      const steepDamp = 1 - smoothstep(SNOW_STEEP_LO, SNOW_STEEP_HI, slope) * 0.6
      const snowW = clamp(Math.max(peakT, polarT) + jitter * 0.05, 0, 1) * steepDamp
      out.lerp(cSnow, snowW)

      // Splat weights: snow > sand > rock claim their share, grass keeps the rest.
      _w.snow = snowW
      _w.sand = clamp(Math.max(beachW, desertT), 0, 1) * (1 - snowW)
      _w.rock = clamp(Math.max(rockT, tundraT * 0.45), 0, 1) * (1 - snowW) * (1 - _w.sand * 0.7)
      _w.grass = Math.max(0, 1 - _w.snow - _w.sand - _w.rock)
    }

    // Cheap AO: valley floors / concavities read slightly darker.
    const aoT = smoothstep(AO_CONCAVITY_LO, AO_CONCAVITY_HI, concavity)
    const aoMul = 1 - aoT * (1 - AO_MIN_MUL)

    // Value jitter killed: any per-vertex brightness variation reads as
    // triangle mosaic under smooth shading. Clean fields win.
    const shade = aoMul
    out.r = clamp(out.r * shade, 0, 1)
    out.g = clamp(out.g * shade, 0, 1)
    out.b = clamp(out.b * shade, 0, 1)
  }

  // --- terrain mesh ---------------------------------------------------------
  // detail=128 -> ~327k tris. IcosahedronGeometry is NON-indexed (every
  // triangle owns its 3 vertices), so computeVertexNormals would produce
  // per-face normals and the planet renders faceted no matter what the
  // material says — weld the vertices first, THEN displace and shade.
  const rawGeo = new THREE.IcosahedronGeometry(1, 128)
  const terrainGeo = mergeVertices(rawGeo)
  rawGeo.dispose()
  const posAttr = terrainGeo.attributes.position
  const vertexCount = posAttr.count
  const colorArray = new Float32Array(vertexCount * 3)
  const biomeWArray = new Float32Array(vertexCount * 4)

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
    biomeWArray[i * 4] = _w.grass
    biomeWArray[i * 4 + 1] = _w.rock
    biomeWArray[i * 4 + 2] = _w.sand
    biomeWArray[i * 4 + 3] = _w.snow
  }
  posAttr.needsUpdate = true
  terrainGeo.setAttribute('color', new THREE.BufferAttribute(colorArray, 3))
  terrainGeo.setAttribute('biomeW', new THREE.BufferAttribute(biomeWArray, 4))
  // Normals (and bounds) must be recomputed from the displaced positions,
  // not the original unit icosahedron -- both for correct lighting and so
  // culling/raycasting bounds cover the displaced mountains.
  terrainGeo.computeVertexNormals()
  terrainGeo.computeBoundingSphere()

  const terrainMat = new THREE.MeshStandardNodeMaterial({
    // M3/TSL: vertexColors is intentionally NOT set. The vertex color is
    // consumed inside colorNode (attribute('color')) so the former GLSL's
    // per-layer clamp(diffuseColor, 0, 1) — which clamps the vColor * detail
    // PRODUCT after the near-detail and macro layers — can be reproduced
    // exactly. NodeMaterial's own vertexColors path multiplies vColor AFTER
    // colorNode, which would defeat that clamp. Vertex colors are fully
    // preserved, just applied in-graph.
    flatShading: false, // smooth fields, crisp band edges — no triangle mosaics
    roughness: 0.95,
    metalness: 0,
  })

  // Per-vertex biome splat weights (grass/rock/sand/snow), read by both the
  // colorNode and normalNode graphs below.
  const biomeW = attribute('biomeW', 'vec4')

  // "HD" ground detail: real CC0 material textures (ambientCG), triplanar-
  // mapped per pixel (no UVs, no seams on a sphere) and blended by the
  // biomeW vertex weights — grass/rock/sand/snow each get their own surface
  // pattern while the vertex color keeps the biome hue. Distance-faded so
  // orbit views stay clean; uDetailOn stays 0 until all four maps are loaded.
  //
  // M-POLISH surface-crispness pass adds two more layers on this same
  // triplanar plumbing (see colorNode/normalNode below): (1) NormalGL detail
  // normal maps, perturbing the shaded normal at the same near-camera fade
  // + biomeW blend as the albedo above (uNormalOn gates once all four
  // normal maps load, independently of uDetailOn so one missing/failed
  // fetch never blocks the other layer); (2) a much-lower-frequency
  // "macro" resample (TILE_MACRO=7) of the SAME four textures, active only
  // in the 1.2R-4R camera-to-planet-center band where the close-up layers
  // have already faded — breaks up the flat interpolated-vertex-color look
  // at mid zoom without fighting the close-up detail. Sources for all eight
  // (four Color + four NormalGL) maps: public/textures/SOURCES.md.
  //
  // TSL wiring: one texture() node per map (re-sampled at three planar UVs by
  // triplanarColor/triplanarNormalSample), swapped from placeholder to loaded
  // map via `.value` in the loader callbacks; uDetailOn/uNormalOn are
  // uniform() gates flipped to 1 once each group's four maps land.
  const texLoader = new THREE.TextureLoader()
  // NoColorSpace (raw): the pre-port GLSL read these detail albedo maps via a
  // hand-written texture2D().rgb sampler, which does NOT sRGB-decode. The
  // near/macro detail constants (det/0.45, clamp 0.35..1.9 / 0.94..1.06) are
  // calibrated to those RAW ~sRGB mid-gray texels; TSL texture() auto-decodes
  // an SRGBColorSpace map, halving mid-zoom albedo. Reading raw keeps the
  // original calibration. (Normal maps below are separately NoColorSpace.)
  const colorPlaceholder = makePlaceholderTexture(THREE.NoColorSpace, [128, 128, 128, 255])
  const uDetailOn = uniform(0)
  const grassTexNode = texture(colorPlaceholder)
  const rockTexNode = texture(colorPlaceholder)
  const sandTexNode = texture(colorPlaceholder)
  const snowTexNode = texture(colorPlaceholder)
  {
    const files = [
      [grassTexNode, '/textures/Grass004_1K-JPG_Color.jpg'],
      [rockTexNode, '/textures/Rock030_1K-JPG_Color.jpg'],
      [sandTexNode, '/textures/Ground080_1K-JPG_Color.jpg'],
      [snowTexNode, '/textures/Snow_Color.jpg'],
    ]
    let loaded = 0
    const total = files.length
    for (const [node, url] of files) {
      texLoader.load(url, (tex) => {
        tex.wrapS = THREE.RepeatWrapping
        tex.wrapT = THREE.RepeatWrapping
        tex.colorSpace = THREE.NoColorSpace // read raw ~sRGB texels (no decode) to match the pre-port GLSL sampler the detail constants were tuned for
        tex.anisotropy = 8 // keeps ground texture crisp at grazing angles
        node.value = tex
        if (++loaded === total) uDetailOn.value = 1
      })
    }
  }

  // Detail NORMAL maps: same four ambientCG sets' NormalGL downloads (see
  // public/textures/SOURCES.md), loaded the same way as the Color maps
  // above but gated by their OWN uNormalOn flag -- a missing/failed normal
  // map degrades to flat (unperturbed) shading without blocking the albedo
  // detail layer, and vice versa.
  const normalPlaceholder = makePlaceholderTexture(THREE.NoColorSpace, [128, 128, 255, 255])
  const uNormalOn = uniform(0)
  const grassNrmNode = texture(normalPlaceholder)
  const rockNrmNode = texture(normalPlaceholder)
  const sandNrmNode = texture(normalPlaceholder)
  const snowNrmNode = texture(normalPlaceholder)
  {
    const files = [
      [grassNrmNode, '/textures/Grass004_1K-JPG_NormalGL.jpg'],
      [rockNrmNode, '/textures/Rock030_1K-JPG_NormalGL.jpg'],
      [sandNrmNode, '/textures/Ground080_1K-JPG_NormalGL.jpg'],
      [snowNrmNode, '/textures/Snow_NormalGL.jpg'],
    ]
    let loaded = 0
    const total = files.length
    for (const [node, url] of files) {
      texLoader.load(
        url,
        (tex) => {
          tex.wrapS = THREE.RepeatWrapping
          tex.wrapT = THREE.RepeatWrapping
          tex.colorSpace = THREE.NoColorSpace // normal maps encode directions, not sRGB color
          tex.anisotropy = 8
          node.value = tex
          if (++loaded === total) uNormalOn.value = 1
        },
        undefined,
        (err) => {
          if (!warnedNormalMapLoad) {
            warnedNormalMapLoad = true
            console.warn(
              '[planet] planet.js: detail normal-map load failed, ground renders without normal perturbation (' +
                url +
                '): ' +
                err,
            )
          }
        },
      )
    }
  }

  // M-SKY cloud-shadows-on-terrain (architect-pinned contract with sky.js's
  // getCloudShadowUniforms()). sky.js OWNS these uniform objects and mutates
  // their `.value` every frame; planet.js is the consumer. Under WebGPURenderer
  // we bridge them into TSL handles: uCloudShadowOn (float), uCloudMat (mat3),
  // and cloudTexNode (the lower deck's alpha texture) — copied from sky.js each
  // frame in update(). Guarded + warn-once so a contract mismatch degrades to
  // no cloud shadows (uCloudShadowOn stays 0) instead of breaking terrain.
  const cloudPlaceholder = makePlaceholderTexture(THREE.NoColorSpace, [0, 0, 0, 255])
  const uCloudShadowOn = uniform(0)
  const uCloudMat = uniform(new THREE.Matrix3())
  const cloudTexNode = texture(cloudPlaceholder)
  let cloudShadowSource = null
  try {
    cloudShadowSource = getCloudShadowUniforms()
  } catch (err) {
    if (!warnedCloudShadow) {
      warnedCloudShadow = true
      console.warn(
        '[planet] planet.js: cloud-shadow uniforms unavailable — ground renders without moving cloud shadows: ' +
          err,
      )
    }
  }

  // colorNode = vColor * near-detail splat * mid-zoom macro * cloud-shadow
  // darkening. Reproduces the former <color_fragment> + <roughnessmap_fragment>
  // GLSL injections as node composition. vColor is applied here (not via the
  // material's vertexColors flag) so the per-layer clamp(., 0, 1) lands on the
  // vColor * detail product exactly as the GLSL did. Built ONCE; the graph is
  // static, only uniform()/texture() values change per frame (spike §6 law).
  const detailPos = positionGeometry // displaced terrain position; object space == world dir (group at origin)
  const objNormal = normalLocal.normalize()
  terrainMat.colorNode = Fn(() => {
    const dNear = positionView.length().smoothstep(0.3, 1.7).oneMinus().toVar()
    const col = attribute('color', 'vec3').toVar()

    // Near-camera triplanar albedo detail (chunky stylized tiles).
    If(uDetailOn.greaterThan(0.5).and(dNear.greaterThan(0.003)), () => {
      const bw = objNormal.abs().toVar()
      bw.assign(bw.div(bw.x.add(bw.y).add(bw.z)))
      const det = triplanarColor(grassTexNode, detailPos, bw, 80)
        .mul(biomeW.x)
        .add(triplanarColor(rockTexNode, detailPos, bw, 80).mul(biomeW.y))
        .add(triplanarColor(sandTexNode, detailPos, bw, 80).mul(biomeW.z))
        .add(triplanarColor(snowTexNode, detailPos, bw, 80).mul(biomeW.w))
        .toVar()
      const wTot = biomeW.x.add(biomeW.y).add(biomeW.z).add(biomeW.w)
      det.assign(det.div(wTot.max(0.001)))
      const mult = det.div(0.45) // per-blend mid-gray so the vertex color keeps owning the hue
      col.assign(col.mul(mix(vec3(1), mult.clamp(0.35, 1.9), dNear.mul(0.95))))
      col.assign(col.clamp(0, 1))
    })

    // Mid-zoom macro layer (inverted envelope: 1.2R-4R camera-to-center band).
    const camR = cameraPosition.length()
    const macroT = camR.smoothstep(1.2, 1.5).mul(camR.smoothstep(3.0, 4.0).oneMinus()).toVar()
    If(uDetailOn.greaterThan(0.5).and(macroT.greaterThan(0.003)), () => {
      const bw2 = objNormal.abs().toVar()
      bw2.assign(bw2.div(bw2.x.add(bw2.y).add(bw2.z)))
      const macroDet = triplanarColor(grassTexNode, detailPos, bw2, 7)
        .mul(biomeW.x)
        .add(triplanarColor(rockTexNode, detailPos, bw2, 7).mul(biomeW.y))
        .add(triplanarColor(sandTexNode, detailPos, bw2, 7).mul(biomeW.z))
        .add(triplanarColor(snowTexNode, detailPos, bw2, 7).mul(biomeW.w))
        .toVar()
      const macroWTot = biomeW.x.add(biomeW.y).add(biomeW.z).add(biomeW.w)
      macroDet.assign(macroDet.div(macroWTot.max(0.001)))
      const macroMult = macroDet.div(0.45) // +-6% subtle value tint — clamp range IS the budget
      col.assign(col.mul(mix(vec3(1), macroMult.clamp(0.94, 1.06), macroT)))
      col.assign(col.clamp(0, 1))
    })

    // Cloud shadows: sample the lower deck's alpha along this fragment's world
    // direction (equirect UV via the same acos/atan formula sky.js documents)
    // and darken up to ~18%, faded by the same near-camera factor.
    If(uCloudShadowOn.greaterThan(0.003).and(dNear.greaterThan(0.003)), () => {
      const worldDir = detailPos.normalize()
      const localDir = uCloudMat.mul(worldDir).normalize()
      const theta = localDir.y.clamp(-1, 1).acos()
      const phi = atan(localDir.z, localDir.x.negate())
      const cloudUv = vec2(phi.div(Math.PI * 2).fract(), theta.div(Math.PI).oneMinus())
      const cloudDensity = cloudTexNode.sample(cloudUv).g // coverage lives in the GREEN channel
      const shadowT = cloudDensity.mul(uCloudShadowOn).mul(dNear)
      col.assign(col.mul(shadowT.mul(0.18).oneMinus()))
    })

    return col
  })()

  // normalNode = whiteout-triplanar detail-normal perturbation transformed
  // object->view (the former <normal_fragment_maps> injection). When the layer
  // is gated off / far, this returns the plain geometry view normal — identical
  // to not setting normalNode at all.
  terrainMat.normalNode = Fn(() => {
    const nrmN = normalLocal.normalize().toVar()
    const outN = transformNormalToView(nrmN).normalize().toVar()
    const dNearNrm = positionView.length().smoothstep(0.3, 1.7).oneMinus().toVar()
    If(uNormalOn.greaterThan(0.5).and(dNearNrm.greaterThan(0.003)), () => {
      const bw = nrmN.abs().toVar()
      bw.assign(bw.div(bw.x.add(bw.y).add(bw.z)))
      const detN = triplanarNormalSample(grassNrmNode, detailPos, nrmN, bw, 80)
        .mul(biomeW.x)
        .add(triplanarNormalSample(rockNrmNode, detailPos, nrmN, bw, 80).mul(biomeW.y))
        .add(triplanarNormalSample(sandNrmNode, detailPos, nrmN, bw, 80).mul(biomeW.z))
        .add(triplanarNormalSample(snowNrmNode, detailPos, nrmN, bw, 80).mul(biomeW.w))
        .toVar()
      const nrmWTot = biomeW.x.add(biomeW.y).add(biomeW.z).add(biomeW.w)
      const blendedObjN = nrmWTot.greaterThan(0.001).select(detN.normalize(), nrmN).toVar()
      // ART.md silhouettes-over-noise: modest strength (0.55), same near-camera fade.
      blendedObjN.assign(mix(nrmN, blendedObjN, dNearNrm.mul(0.55)).normalize())
      outN.assign(transformNormalToView(blendedObjN).normalize())
    })
    return outN
  })()

  const terrainMesh = new THREE.Mesh(terrainGeo, terrainMat)

  // --- ocean mesh -----------------------------------------------------------
  const oceanGeo = new THREE.SphereGeometry(SEA_LEVEL, 128, 96)

  // Per-vertex multiplicative tint (brighter/cooler over shallow terrain, for
  // a sun-glint read), keyed off the terrain height directly beneath each
  // ocean vertex. Cheap: ocean has ~12.5k vertices vs. the terrain's ~200k+.
  // `aDepth` (M-LD water) carries the same normalized seafloor depth
  // (0=shoreline..1=deepest) to the ocean shader for the fresnel/depth-band/
  // shore-accent styling below.
  const oceanPosAttr = oceanGeo.attributes.position
  const oceanVertexCount = oceanPosAttr.count
  const oceanColorArray = new Float32Array(oceanVertexCount * 3)
  const oceanDepthArray = new Float32Array(oceanVertexCount)
  const oceanDir = new THREE.Vector3()
  const oceanTint = new THREE.Color()
  const shallowMulColor = new THREE.Color(...OCEAN_SHALLOW_MUL)
  const deepMulColor = new THREE.Color(...OCEAN_DEEP_MUL)
  for (let i = 0; i < oceanVertexCount; i++) {
    oceanDir.set(oceanPosAttr.getX(i), oceanPosAttr.getY(i), oceanPosAttr.getZ(i)).normalize()
    const seafloorH = sampleHeight(oceanDir)
    const depthT = clamp((SEA_LEVEL - seafloorH) / WATER_COLOR_RANGE, 0, 1)
    oceanDepthArray[i] = depthT
    const shallowFactor = 1 - smoothstep(0, 1, depthT)
    oceanTint.copy(deepMulColor).lerp(shallowMulColor, shallowFactor)
    oceanColorArray[i * 3] = oceanTint.r
    oceanColorArray[i * 3 + 1] = oceanTint.g
    oceanColorArray[i * 3 + 2] = oceanTint.b
  }
  oceanGeo.setAttribute('color', new THREE.BufferAttribute(oceanColorArray, 3))
  oceanGeo.setAttribute('aDepth', new THREE.BufferAttribute(oceanDepthArray, 1))

  const oceanMat = new THREE.MeshStandardNodeMaterial({
    color: OCEAN_COLOR,
    // M3/TSL: vertexColors NOT set — the colorNode below fully REPLACES the
    // diffuse (as the former GLSL did: `diffuseColor.rgb = waterColor`), so the
    // baked per-vertex ocean tint was already discarded in the shipped shader.
    // The `color`/`aDepth` geometry attributes are still built (unchanged).
    transparent: true,
    opacity: 0.86,
    roughness: 0.42, // low enough for a glint, high enough not to blow out a hemisphere
    metalness: 0.02,
    emissive: OCEAN_EMISSIVE,
    emissiveIntensity: 0.25,
    depthWrite: true,
  })

  // Living-water feel + M-LD water styling (hybrid of the ld-water spike's
  // treatments 2+3, stylized-leaning verdict), ported to TSL node graphs:
  // vertices displace along their normal by a few summed sines
  // of object-space position + time (positionNode); the colorNode replaces
  // diffuse with a view-dependent fresnel mix of deep sapphire (grazing) /
  // turquoise shallows (looking down) over a 3-stop depth-absorption base, an
  // animated coast glow band (treatment 2), and ONE thin hard-edged posterized
  // "shelf line" band with a subtly wobbling edge just seaward of the coast
  // glow (treatment 3's graphic accent). Built ONCE; only uTime animates.
  const uTime = uniform(0)
  const uSapphire = color(0x0f3a66)
  const uTurquoise = color(0x2f8fa8)
  const uStopShallow = color(0x8fe2d1)
  const uStopMid = color(0x2f8fa8)
  const uStopDeep = color(0x0f3a66)
  const uCoastColor = color(0xcdeee6)
  const uShoreBand = color(0x7fe0c8)
  const aDepth = attribute('aDepth', 'float')

  // Vertex swell: sum of three sines of object-space position + time, pushed
  // along the object normal. positionNode outputs LOCAL (pre-transform) space;
  // the renderer applies the model matrix after (spike §5/§8.7).
  const swell = positionLocal
    .dot(vec3(1.3, 0.7, 0.4))
    .mul(18)
    .add(uTime.mul(1.1))
    .sin()
    .add(
      positionLocal
        .dot(vec3(-0.6, 1.1, 0.8))
        .mul(24)
        .sub(uTime.mul(0.8))
        .sin(),
    )
    .add(
      positionLocal
        .dot(vec3(0.9, -0.5, 1.2))
        .mul(14)
        .add(uTime.mul(1.6))
        .sin(),
    )
  oceanMat.positionNode = positionLocal.add(normalLocal.mul(swell.mul(0.00027)))

  oceanMat.colorNode = Fn(() => {
    // World-space view + up (positionWorld reflects the swell; matches the
    // former vWaterPos/vLocalUp world-space convention).
    const view = cameraPosition.sub(positionWorld).normalize()
    const fresnel = view.dot(normalWorld).clamp(0, 1).oneMinus().pow(3).toVar()
    const fresnelColor = mix(uTurquoise, uSapphire, fresnel)

    const depthShallow = mix(uStopShallow, uStopMid, aDepth.div(0.35))
    const depthDeep = mix(uStopMid, uStopDeep, aDepth.sub(0.35).div(0.65).clamp(0, 1))
    const depthColor = aDepth.lessThan(0.35).select(depthShallow, depthDeep)

    const waterColor = mix(depthColor, fresnelColor, fresnel.mul(0.65)).toVar()

    // Animated coast glow band (treatment 2).
    const coastNoise = positionWorld.x
      .mul(27)
      .add(uTime.mul(0.4))
      .sin()
      .mul(positionWorld.z.mul(22).sub(uTime.mul(0.3)).sin())
    const coastBand = aDepth.smoothstep(0.02, 0.14).oneMinus().mul(coastNoise.mul(0.45).add(0.55))
    waterColor.assign(mix(waterColor, uCoastColor, coastBand.clamp(0, 1).mul(0.55)))

    // Treatment-3 graphic accent: ONE thin hard-edged posterized band just
    // seaward of the coast glow, edge wobbling subtly so it never reads static.
    const shoreWobble = positionWorld.x
      .mul(6)
      .add(uTime.mul(0.12))
      .sin()
      .mul(positionWorld.z.mul(5.1).sub(uTime.mul(0.09)).sin())
      .mul(0.012)
    const shoreBandT = step(shoreWobble.add(0.16), aDepth).mul(step(shoreWobble.add(0.2), aDepth).oneMinus())
    waterColor.assign(mix(waterColor, uShoreBand, shoreBandT.mul(0.6)))

    return waterColor
  })()

  let waterElapsed = 0

  const oceanMesh = new THREE.Mesh(oceanGeo, oceanMat)

  // --- assembly ---------------------------------------------------------
  const group = new THREE.Group()
  group.add(terrainMesh)
  group.add(oceanMesh)

  // Frame update: animate ONLY uniform()/texture() values (the node graphs are
  // static — a structural change costs a ~187ms recompile, spike §6). Ocean
  // clock advances uTime; the cloud-shadow handles are copied from sky.js's
  // own per-frame uniform objects (allocation-free: scalar writes, an in-place
  // Matrix3.copy, and a reference-equality-guarded texture swap).
  function update(dt) {
    waterElapsed += dt
    uTime.value = waterElapsed
    if (cloudShadowSource) {
      uCloudShadowOn.value = cloudShadowSource.uCloudShadowOn.value
      uCloudMat.value.copy(cloudShadowSource.uCloudMat.value)
      const cloudTex = cloudShadowSource.uCloudTex.value
      if (cloudTex && cloudTexNode.value !== cloudTex) cloudTexNode.value = cloudTex
    }
  }

  return { group, sampleHeight, isLand, biomeAt, update }
}
