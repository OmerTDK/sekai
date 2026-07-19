// terrainField.js — THREE-free extraction of planet.js's analytic terrain math.
//
// Pure ESM. Imports ONLY from './util.js' (NO 'three'/'three/webgpu'), so BOTH
// the browser (planet.js) AND the Node bake script (scripts/bake-heightfield.mjs)
// can build a byte-identical height function from the same seed. This is the
// seam (E1) that lets erosion be baked offline and loaded at runtime.
//
// createTerrainField(seed) returns:
//   analyticHeight(dir)   -> number   the CURRENT planet.js sampleHeight body,
//                                      moved VERBATIM. Output is bit-identical
//                                      to the old planet.js sampler for every
//                                      dir — this is a no-op refactor.
//   continentField(x,y,z) -> number
//   beltField(x,y,z)      -> number
//   moistureAt(dir)       -> 0..1
//   capThresholdAt(dir)   -> number
//
// It ALSO exposes the raw seeded noise fields it constructs (nContinent..nIsland)
// as additional properties, so planet.js can drop its own inline noise-field
// construction and let its remaining local helpers (terrainColorAt's jitter /
// moisture / cap fbm) read the same fields with zero duplication. The five
// functions above are the binding contract; the noise handles are additive.
//
// `dir` is any { x, y, z } (need NOT be a THREE.Vector3): only .x/.y/.z are read.
import { SEA_LEVEL, makeNoise3D, fbm, ridged, clamp, smoothstep } from './util.js'

// ---------------------------------------------------------------------------
// Noise coordinate scales (multiplied into the unit direction before sampling).
// Copied EXACTLY from planet.js — do NOT retune here; terrainField is the single
// source of truth for the height math and planet.js now defers to it.
// ---------------------------------------------------------------------------
const CONTINENT_SCALE = 1.25
const BELT_SCALE = 2.3
const MOUNTAIN_SCALE = 3.4
const DETAIL_SCALE = 8
const OCEAN_FLOOR_SCALE = 2.0
const MOISTURE_SCALE = 3.5
const CAP_SCALE = 2.6
// M-LD fjord-warp (recipe B): mid-freq vector-noise scale that warps the
// continent field's SAMPLE COORDINATES before its fbm, so coastlines fold into
// inlets/fjords instead of following raw noise contours.
const WARP_SCALE = 2.6
const WARP_STRENGTH = 0.2
// M-LD archipelago (recipe C): higher-freq island-blob band, gated to a coastal
// fringe measured in raw continent-noise space (straddling the mainland
// threshold band [CONTINENT_LO, CONTINENT_HI]) so islands read as offshore arcs
// near a landmass, not scattered mid-ocean.
const ISLAND_SCALE = 4.4
const ISLAND_LO = 0.1
const ISLAND_HI = 0.34
const NEARSHORE_CENTER = 0.08
const NEARSHORE_WIDTH = 0.09

// Continent mask threshold band (raw fbm ~[-1,1] -> smoothstep -> [0,1]).
const CONTINENT_LO = 0.02
const CONTINENT_HI = 0.16
// Mid-freq band mask half-width: how far from the noise's zero-crossing the
// "chain" of mountains extends. Narrow band -> winding ranges, not bumps.
const BELT_BAND_WIDTH = 0.32

// Height contribution budget (relative to SEA_LEVEL = 1.0).
const LAND_RISE = 0.012 // base lowland elevation
// M-LD dramatic-relief (recipe D): mountain rise x1.8 over the pre-M-LD baseline.
const MOUNTAIN_RISE = 0.054
const RIDGE_SHARPNESS = 1.6 // power-curve on the ridge value: narrows crests, deepens flanks
const VALLEY_DEPTH = 0.016 // inverted-ridge subtraction: carves valley floors between peaks
const DETAIL_AMP = 0.0025 // rolling small-scale bumps
const OCEAN_BASE_DEPTH = 0.02 // base basin depth below sea level
const OCEAN_FLOOR_AMP = 0.008 // gentle ocean floor variation
// coastShelf transition band, measured in continent-MASK space (already
// smoothstepped to [0,1]): ocean floor depth ramps up over a short band just
// offshore instead of a whole-range falloff — mild coastal cliffs.
const COAST_SHELF_LO = 0.4
const COAST_SHELF_HI = 0.62

const HEIGHT_MIN = 0.975
// M-LD PINNED CONSTANT (binding): 1.06. Siblings rebase cloud shells / storm
// patch / bird altitude / atmosphere against exactly this value — do not retune
// without re-coordinating.
const HEIGHT_MAX = 1.06

export function createTerrainField(seed) {
  // --- deterministic noise fields, all namespaced off the same seed ---------
  const nContinent = makeNoise3D(seed + ':continents')
  const nBelt = makeNoise3D(seed + ':belt')
  const nMountain = makeNoise3D(seed + ':mountains')
  const nDetail = makeNoise3D(seed + ':detail')
  const nOceanFloor = makeNoise3D(seed + ':oceanfloor')
  const nMoisture = makeNoise3D(seed + ':moisture')
  const nJitter = makeNoise3D(seed + ':jitter')
  const nCap = makeNoise3D(seed + ':caps')
  // M-LD fjord-warp (B): 3 independent vector-noise channels warp the continent
  // field's sample coordinates before its fbm.
  const nWarpX = makeNoise3D(seed + ':fjordwarpx')
  const nWarpY = makeNoise3D(seed + ':fjordwarpy')
  const nWarpZ = makeNoise3D(seed + ':fjordwarpz')
  // M-LD archipelago (C): higher-freq island-blob band.
  const nIsland = makeNoise3D(seed + ':islands')

  // Low-freq fbm pushed through smoothstep -> a handful of distinct landmasses
  // (not one blob). M-LD: sample coordinates are domain-warped (fjord-warp,
  // recipe B) before the fbm so coastlines fold into inlets/fjords instead of
  // following raw noise contours; a second, higher-freq island band
  // (archipelago, recipe C) is gated to the now-fjorded coastline's fringe so
  // it reads as offshore island arcs/skerries rather than open-ocean noise.
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

  // Mid-freq noise band: mask is 1 near the field's zero-crossing and falls off
  // away from it, so it traces winding chain-like ridgelines instead of being
  // uniformly bumpy everywhere.
  function beltField(x, y, z) {
    const raw = fbm(nBelt, x * BELT_SCALE, y * BELT_SCALE, z * BELT_SCALE, 3, 2.0, 0.5)
    return 1 - smoothstep(0.0, BELT_BAND_WIDTH, Math.abs(raw))
  }

  // Terrain radius along `dir`. Deterministic, cheap, allocation-free: only
  // reads dir.x/y/z and does scalar arithmetic (fbm/ridged/smoothstep/clamp are
  // themselves allocation-free).
  //
  // M-LD dramatic-relief (recipe D): ridge crests are sharpened by a power-curve
  // (RIDGE_SHARPNESS) for chunkier massifs, valleys are carved by subtracting
  // the inverted ridge value, and the ocean floor blend uses the narrower
  // coastShelf transition (in continent-mask space) for a steeper shelf just
  // offshore instead of a whole-range falloff.
  function analyticHeight(dir) {
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

  // Continent-scale moisture in [0,1]. Low-freq (2 octaves) so biomes stay at
  // continent scale rather than flipping per vertex. Matches planet.js's former
  // inline moisture computation in biomeAt/terrainColorAt exactly.
  function moistureAt(dir) {
    const x = dir.x
    const y = dir.y
    const z = dir.z
    return (
      fbm(nMoisture, x * MOISTURE_SCALE, y * MOISTURE_SCALE, z * MOISTURE_SCALE, 2, 2.0, 0.5) * 0.5 +
      0.5
    )
  }

  // Latitude (|y|) threshold at which polar ice caps begin, perturbed by a
  // low-freq noise so the cap boundary isn't a perfect circle. Matches
  // planet.js's former inline cap-threshold computation exactly.
  function capThresholdAt(dir) {
    const x = dir.x
    const y = dir.y
    const z = dir.z
    return 0.86 + fbm(nCap, x * CAP_SCALE, y * CAP_SCALE, z * CAP_SCALE, 3, 2.0, 0.5) * 0.07
  }

  return {
    // --- binding contract (E1): five terrain functions -----------------------
    analyticHeight,
    continentField,
    beltField,
    moistureAt,
    capThresholdAt,
    // --- additive: the raw seeded noise fields, so planet.js can drop its own
    // inline construction and let terrainColorAt (jitter/moisture/cap fbm) read
    // these same handles with zero duplication. Bit-identical by seed string.
    nContinent,
    nBelt,
    nMountain,
    nDetail,
    nOceanFloor,
    nMoisture,
    nJitter,
    nCap,
    nWarpX,
    nWarpY,
    nWarpZ,
    nIsland,
    // --- additive: height range, for callers that need the clamp bounds -------
    HEIGHT_MIN,
    HEIGHT_MAX,
  }
}
