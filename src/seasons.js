// The authoritative global season clock (spring -> summer -> autumn ->
// winter) plus a self-rendered, terrain-hugging snow-cover shell whose snow
// line descends toward the equator/lowlands in winter and recedes to
// peaks/poles in summer via ONE animated uniform. Also exposes read-only
// getters that seaice.js/flora.js/sky.js optionally poll (guarded, one-way
// reads on their end -- see docs/design/epilogue-e4.md's "Modified files")
// for sea-ice extent, foliage tint, and daylight feel; this module never
// reaches into any of them.
//
// Presentation only (COVENANT): the shell is a purely additive overlay --
// it never edits planet.js geometry or any session structure -- and it
// fully RECEDES every year (uSnowLine sweeps its whole range every
// SEASON_PERIOD seconds), so it never becomes a permanent mark on the
// world.
//
// Determinism: the season phase is an accumulated presentation dt clock
// starting at phase 0 (no Math.random/Date.now anywhere in it); the only
// structural randomness is the snow shell's per-vertex jitter, pulled from
// rngFromString(seed + ':seasons:snow') in build order (deterministic --
// same seed always regrows the same shell). One extra draw call total.
import * as THREE from 'three/webgpu'
import { attribute, uniform, color, smoothstep } from 'three/tsl'
import { rngFromString, clamp, lerp } from './util.js'

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------
const SHELL_DETAIL = 48 // icosphere subdivision -- high enough that the shell's
// chords follow terrain relief instead of cutting flat facets across valleys
// (detail 6 floated as visible plates). ~138k verts, one static draw call;
// the per-quantized-direction memo keeps the one-time height bake to ~40k samples.
const SNOW_LIFT = 0.001 // hugs terrain, lifted just enough to dodge z-fighting
const SNOW_EDGE_SOFT = 0.06 // soft smoothstep edge width, in snowPotential units

const SEASON_PERIOD = 240 // seconds per full year
const SEASON_NAMES = ['spring', 'summer', 'autumn', 'winter']
// Solstice-style curve: summer peaks mid-quarter (phase 0.375), winter peaks
// exactly half a year later (0.875) -- spring/autumn quarter BOUNDARIES (0,
// 0.5) land on the curve's zero-crossings, like real equinoxes.
const SUMMER_PEAK_PHASE = 0.375

// uSnowLine: LOW = snow reaches lower latitude/altitude (more snow, winter);
// HIGH = only the highest-snowPotential vertices (peaks/poles) stay opaque
// (less snow, summer). Compared directly against the shell's baked
// snowPotential attribute in buildSnowShell's opacityNode below.
const SNOW_LINE_WINTER = 0.25
const SNOW_LINE_SUMMER = 0.85

const DAYLIGHT_WINTER = 0.82
const DAYLIGHT_SUMMER = 1.08

// Negative = more sea ice (winter); positive = less (summer). Consumed by
// seaice.js as an ADDITIVE bias on its own uAlphaThreshold -- a lower
// threshold reads more of the polar density field as opaque ice.
const SEAICE_BIAS_WINTER = -0.08
const SEAICE_BIAS_SUMMER = 0.02

const SNOW_COLOR = 0xf4f8fb

// Foliage keyframes, one per season quarter (green spring -> gold summer ->
// brown autumn -> pale winter), cyclically interpolated across the year.
const FOLIAGE_HEX = [0x5f8a3c, 0xb7963f, 0x7a5a34, 0x9fa88f]

// ---------------------------------------------------------------------------
// Snow-cover shell: one static IcosahedronGeometry, every vertex displaced
// along its own direction to planet.sampleHeight(dir) + SNOW_LIFT so the
// shell hugs terrain, with a baked per-vertex 'snowPotential' field (mostly
// latitude + altitude, plus seeded jitter so the line isn't a perfect
// ring/band). The TSL node graph below is built ONCE; only uSnowLine.value
// is written per frame (S1-law: a structural node-graph edit costs a
// ~187ms recompile, a uniform write costs nothing).
// ---------------------------------------------------------------------------
function buildSnowShell(planet, seed) {
  const geo = new THREE.IcosahedronGeometry(1, SHELL_DETAIL)
  const posAttr = geo.attributes.position
  const vertCount = posAttr.count
  const snowPotential = new Float32Array(vertCount)
  const rng = rngFromString(seed + ':seasons:snow')
  const dir = new THREE.Vector3()
  const biome = {}

  // PolyhedronGeometry (Icosahedron's base class) builds NON-indexed
  // geometry -- every triangle owns its own 3 vertex entries -- so at
  // SHELL_DETAIL the position buffer holds far more raw entries than there
  // are geometrically distinct directions (interior corners are shared by
  // ~6 faces each). Calling planet.sampleHeight/biomeAt (several fbm/ridged
  // octaves apiece) once per raw buffer entry would multiply this one-time
  // build cost for zero visual gain, so memoize per quantized direction
  // instead: 5 decimals is far under the smallest gap between two
  // genuinely distinct corners at this detail level, so the cache only
  // ever collapses true duplicates (plus the tiny floating-point drift
  // between two adjacent faces' own lerp paths to the same shared corner).
  // Each distinct direction ends up sampled exactly once, and the rng draw
  // for its jitter happens in the same deterministic first-encounter order
  // every launch (same seed -> same shell, every time).
  const cache = new Map()
  for (let i = 0; i < vertCount; i++) {
    dir.set(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i)).normalize()
    const key = dir.x.toFixed(5) + ',' + dir.y.toFixed(5) + ',' + dir.z.toFixed(5)
    let entry = cache.get(key)
    if (!entry) {
      const h = planet.sampleHeight(dir)
      planet.biomeAt(dir, biome)
      const jitter = (rng() - 0.5) * 0.2
      const potential = clamp(0.55 * Math.abs(dir.y) + 0.55 * biome.landT + jitter, 0, 1)
      entry = { radius: h + SNOW_LIFT, potential }
      cache.set(key, entry)
    }
    snowPotential[i] = entry.potential
    posAttr.setXYZ(i, dir.x * entry.radius, dir.y * entry.radius, dir.z * entry.radius)
  }
  posAttr.needsUpdate = true
  geo.setAttribute('snowPotential', new THREE.BufferAttribute(snowPotential, 1))
  geo.computeVertexNormals()
  geo.computeBoundingSphere()

  const material = new THREE.MeshStandardNodeMaterial({
    transparent: true,
    flatShading: true, // low-poly facets read as deliberate here (ART.md), same call flora's trees/rocks make
    roughness: 1,
    metalness: 0,
    depthWrite: false, // additive overlay must not occlude what's behind it
    polygonOffset: true, // hugs terrain closely (SNOW_LIFT) -- dodges z-fighting the ground mesh
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  })
  const uSnowLine = uniform(SNOW_LINE_SUMMER)
  material.colorNode = color(SNOW_COLOR)
  const snowPotentialNode = attribute('snowPotential', 'float')
  // Soft edge (not a hard alphaTest cutoff): vertices whose snowPotential
  // clears uSnowLine are opaque, with a SNOW_EDGE_SOFT-wide fade below it --
  // only uSnowLine ever changes, so this is the one uniform write per frame
  // that grows/recedes the whole snow line.
  material.opacityNode = smoothstep(uSnowLine, uSnowLine.add(SNOW_EDGE_SOFT), snowPotentialNode)

  const mesh = new THREE.Mesh(geo, material)
  mesh.renderOrder = 1 // transparent overlay -- draw after opaque terrain/ocean

  return { mesh, uSnowLine }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------
export function createSeasons(planet, seed) {
  const group = new THREE.Group()

  const { mesh, uSnowLine } = buildSnowShell(planet, seed)
  group.add(mesh)

  const foliageKeyframes = FOLIAGE_HEX.map((hex) => new THREE.Color(hex))
  const uFoliageTint = uniform(new THREE.Color(FOLIAGE_HEX[0]))

  let phaseSeconds = 0
  let phase01 = 0
  let daylightFactor = DAYLIGHT_SUMMER
  let seaIceThresholdBias = SEAICE_BIAS_SUMMER

  function update(dt) {
    phaseSeconds += dt
    phase01 = (phaseSeconds / SEASON_PERIOD) % 1

    // Shared winter(0)<->summer(1) blend factor from a cosine centered on
    // the summer peak -- uSnowLine, daylightFactor and seaIceThresholdBias
    // all ride this SAME curve (just mapped to their own ranges), so the
    // three read-outs stay in lockstep across the year.
    const t = Math.cos((phase01 - SUMMER_PEAK_PHASE) * Math.PI * 2) // 1 at summer, -1 at winter
    const u = (t + 1) * 0.5 // 0 winter .. 1 summer

    uSnowLine.value = lerp(SNOW_LINE_WINTER, SNOW_LINE_SUMMER, u)
    daylightFactor = lerp(DAYLIGHT_WINTER, DAYLIGHT_SUMMER, u)
    seaIceThresholdBias = lerp(SEAICE_BIAS_WINTER, SEAICE_BIAS_SUMMER, u)

    // Foliage tint: cyclic 4-keyframe lerp across the year, one keyframe
    // per season quarter, wrapping back to spring at phase01 == 1.
    const segF = phase01 * 4
    const segI = Math.min(3, Math.floor(segF))
    const segT = segF - segI
    uFoliageTint.value.lerpColors(foliageKeyframes[segI], foliageKeyframes[(segI + 1) % 4], segT)
  }

  function getPhase01() {
    return phase01
  }

  function getSeasonIndex() {
    return Math.min(3, Math.floor(phase01 * 4))
  }

  function getSeasonName() {
    return SEASON_NAMES[getSeasonIndex()]
  }

  function getFoliageTint(outColor) {
    outColor.copy(uFoliageTint.value)
    return outColor
  }

  function getDaylightFactor() {
    return daylightFactor
  }

  function getSeaIceThresholdBias() {
    return seaIceThresholdBias
  }

  // Prime every read-out at phase 0 before returning, so a caller that
  // polls this API before the first render-loop update() (e.g. an early
  // god-panel read) never observes a stale, pre-build default.
  update(0)

  return {
    group,
    update,
    getPhase01,
    getSeasonIndex,
    getSeasonName,
    getFoliageTint,
    getDaylightFactor,
    getSeaIceThresholdBias,
    uSnowLine,
    uFoliageTint,
  }
}
