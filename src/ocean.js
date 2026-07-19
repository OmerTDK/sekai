// Animated moving-water ocean (M5b). Replaces the former effectively-static
// stylized water shell in planet.js with a VISIBLY MOVING ocean: long rolling
// swell that travels across the sphere, crest-pinched Gerstner waves, and white
// foam where waves break on low coasts and along steep crests.
//
// >>> ENGINE: WebGPURenderer (WebGL2 backend via forceWebGL) + TSL node
// materials. This module is 100% TSL NodeMaterial -- it uses none of the legacy
// string-injection compile hook nor raw shader materials (both are
// non-functional under WebGPURenderer). Node factories come from 'three/tsl',
// the material class from 'three/webgpu' (as THREE).
//
// Approach (pure TSL, ONE draw call, NO compute pass -- a true FFT is deferred
// to the post-M4 native-WebGPU backend, see docs/design/m5b-fft-ocean.md):
//   * positionNode  -- a seam-free spherical sum-of-Gerstner-waves evaluated in
//                      OBJECT space (phase = k*dot(Dir,P) + c*t), so wavefronts
//                      are planar slabs cutting the sphere with no pole/seam tear.
//                      A seeded directional SPECTRUM: WAVE_COUNT octaves along a
//                      geometric wavelength progression, spread in a cone about
//                      TWO crossing wind directions, amplitude following a
//                      spectral falloff.
//   * normalNode    -- analytic finite-difference of that displacement in a
//                      pole-safe tangent basis, plus a THREE-octave procedural
//                      wind-advected fractal micro-normal for close-up sparkle.
//   * colorNode     -- the ported stylized fresnel / 3-stop depth-absorption /
//                      coast-glow look (matches the old ocean palette exactly),
//                      with aDepth-driven lapping shore foam + Jacobian-fold
//                      whitecap crest foam, PLUS (M5b-crisp, TIER 2) a
//                      fresnel-weighted PMREM-sky reflection and a live analytic
//                      sun glint -- reflections + a moving sparkle, not a mirror.
//
// Determinism: every wave direction/wavelength/amplitude/speed/steepness is
// derived from `seed` via rngFromString (same seed -> same ocean). uTime is a
// presentation-only clock accumulated from dt (never world state) -- exactly as
// the old ocean's waterElapsed was. The live sun direction fed to the glint is
// read from the sky each frame (presentation only, never written back). No
// Math.random / Date.now.
//
// Altitude LOD: update(dt) reads the (construction-captured) camera altitude and
// writes one uWaveLOD uniform that scales geometric amplitude, foam intensity,
// micro-normal strength, and the reflection/glint, so the whole-planet view
// settles to a calm sphere (where waves would be sub-pixel and shimmer/alias)
// and full detail returns on descent to the ~1.03 skim. The SHORT waves fade
// FIRST (per-wave uWaveLOD^lodPow, chop aliases before swell). Geometric
// amplitude is ADDITIONALLY faded to zero as aDepth -> 0 so crests shrink in the
// shallows (physically correct AND it keeps displaced crests from poking through
// the thin coastline).
//
// Covenant: the ocean is a passive render shell. It READS the terrain-derived
// aDepth attribute (baked once from planet.sampleHeight) and WRITES nothing to
// world state or any other module. Crest displacement is clamped to zero at the
// shoreline, so no wave ever geometrically swallows a coastal structure.
//
// Contract: createOcean(planet, camera, seed, envMap)
//   -> { mesh, update(dt, sunDir), uniforms, setReflect }.
// `envMap` is the OPTIONAL PMREM sky capture (env.js) used for the reflection;
// when omitted the reflection falls back to a 2-color procedural sky gradient
// (same fresnel + live glint), so the ocean is fully functional un-wired.
import * as THREE from 'three/webgpu'
import {
  Fn,
  attribute,
  uniform,
  color,
  float,
  vec2,
  vec3,
  mix,
  step,
  sin,
  cos,
  dot,
  cross,
  normalize,
  smoothstep,
  positionLocal,
  positionWorld,
  normalWorld,
  cameraPosition,
  reflectVector,
  pmremTexture,
  transformNormalToView,
  mx_noise_float,
  mx_fractal_noise_float,
} from 'three/tsl'
import { SEA_LEVEL, rngFromString, lerp, clamp, smoothstep as smoothstepJS } from './util.js'

// ---------------------------------------------------------------------------
// Ported ocean palette (must match the old planet.js ocean so M5b adds MOTION
// + FOAM without restyling the water).
// ---------------------------------------------------------------------------
const OCEAN_COLOR = 0x2d6f9e
const OCEAN_EMISSIVE = 0x123a5e
const SAPPHIRE = 0x0f3a66 // grazing-angle deep water (fresnel high)
const TURQUOISE = 0x2f8fa8 // looking-down shallows (fresnel low)
const STOP_SHALLOW = 0x8fe2d1 // 3-stop depth absorption base
const STOP_MID = 0x2f8fa8
const STOP_DEEP = 0x0f3a66
const COAST_COLOR = 0xcdeee6 // animated coast-glow band
const SHORE_BAND = 0x7fe0c8 // thin posterized shelf-line accent
const FOAM_WHITE = 0xf1f6f6 // wave-break foam

// --- frozen sea: an ice tint on the ocean surface itself near the poles (NO
// separate shell — the water freezes in place, so it can never read as a
// floating pane at grazing angles the way the old sea-ice caps did). ----------
const ICE_COLOR = 0xdbe8f0 // pale matte ice white-blue
const ICE_CRACK_COLOR = 0x8fb3cc // deeper icy blue in the pressure-crack veins
const ICE_LAT_LO = 0.6 // |latitude| (0=equator, 1=pole) where ice starts
const ICE_LAT_HI = 0.8 // ... where the surface is fully frozen
const ICE_EDGE_JITTER = 0.16 // noise amplitude that makes the ice edge irregular
const ICE_EDGE_SCALE = 3.2 // spatial frequency of the ice-edge noise
const ICE_CRACK_SCALE = 34 // frequency of the pressure-crack veins
const ICE_WAVE_DAMP = 0.9 // how far the swell flattens under full ice (0..1)

// Normalized seafloor-depth denominator -- MUST match planet.js's
// WATER_COLOR_RANGE (OCEAN_BASE_DEPTH 0.02 + OCEAN_FLOOR_AMP 0.008) so the
// baked aDepth here is identical to what the terrain uses. (planet.js exposes
// only sampleHeight/isLand/biomeAt, not this constant, so it is mirrored here.)
const WATER_COLOR_RANGE = 0.028

// ---------------------------------------------------------------------------
// Geometry. 256x192 sphere at SEA_LEVEL (~50k verts, still ONE draw call) --
// vertex spacing ~2*PI/256 ~= 0.0245 rad (halved from the old 128x96). Geometric
// wavelengths are floored to >= ~3-4 vertex spacings so waves never sub-sample
// into facet noise; all higher frequency lives in the normal/micro-normal.
// ---------------------------------------------------------------------------
const SEGMENTS_W = 256
const SEGMENTS_H = 192

// ---------------------------------------------------------------------------
// Wave-set tuning knobs -- a seeded directional SPECTRUM (M5b flagship). Rather
// than two hand-tuned bands we synthesize WAVE_COUNT octaves along a geometric
// wavelength progression from WAVELEN_LONG (broad groundswell) down to
// WAVELEN_SHORT (surface chop, floored to >= ~3.7 vertex spacings at 256 so
// geometry never sub-samples into facet noise). Per octave:
//   * amplitude follows a spectral falloff  A ~ (L/Lmax)^AMP_FALLOFF  (long waves
//     dominate the sea's energy) and the whole set is then renormalized so the
//     summed vertical amplitude hits TARGET_AMP_SUM exactly -- this pins the sea
//     state independent of octave count, so LOD/coast tuning never regresses.
//   * steepness rises toward shorter waves (sharp chop crests, broad swell).
//   * speed follows deep-water dispersion  c ~ sqrt(k)  (long swell outruns chop).
//   * direction is spread in a cone about ONE OF TWO seeded wind directions --
//     the longer ~55% of octaves ride the primary wind, the shorter ~45% ride a
//     crossing second wind -- so the sea is a wind-driven CROSSING sea rather
//     than a single over-aligned comb. The cone widens for shorter waves
//     (directional spreading).
// Amplitudes are world units on a radius-1 planet; the renormalized peak sits
// ~0.012 -- visible at the ~1.03 skim (the old ocean displaced +-0.00027).
// ---------------------------------------------------------------------------
const WAVE_COUNT = 12
const WAVELEN_LONG = 1.25 // rad (world units on the unit sphere)
const WAVELEN_SHORT = 0.09 // >= ~3.7 * (2*PI/256) vertex spacing (needs the 256 mesh)
const AMP_FALLOFF = 0.78 // A_i ~ (L_i / WAVELEN_LONG)^AMP_FALLOFF (energy shifted toward chop)
const TARGET_AMP_SUM = 0.012 // summed vertical amplitude after renormalization
const STEEP_LONG = 0.28 // Gerstner steepness at the longest wave
const STEEP_SHORT = 1.1 // ... at the shortest wave (sharper chop crests)
const SPEED_BASE = 0.2 // c_i = SPEED_BASE * sqrt(k_i) (deep-water dispersion)
const CONE_LONG = 0.28 // directional-spread cone half-angle (rad) at long waves
const CONE_SHORT = 1.25 // ... at short waves (wider -> choppier, less aligned)
const CROSS_FRACTION = 0.55 // octaves at/after this fraction ride the 2nd (crossing) wind
const LOD_POW_LONG = 1.0 // per-wave uWaveLOD exponent at the longest swell (fades last)
const LOD_POW_SHORT = 3.5 // ... at the shortest chop (fades FIRST -> chop aliases before swell)

// Finite-difference / micro-normal / foam tunables.
const NORMAL_EPS = 0.006 // world-space tangent offset for the analytic normal (sharper at 256)
// Three-octave procedural micro-normal: a wind-advected fractal bump built from
// finite differences of mx_fractal_noise_float (multi-octave per tap => crisper
// than a single-octave value noise). DN is the finite-diff offset in NOISE space
// (fixed, freq-independent -- the old freq*MICRO_EPS coupling was the softness
// culprit). Octave 3 is a capillary detail gated to the skim only (LOD^3).
const MICRO_DN = 0.1 // finite-diff offset in noise space (shared by all octaves)
const MICRO_FREQ = 44 // spatial frequency of the broad sparkle micro-normal
const MICRO_FLOW = 0.22 // scroll speed (along wind) of the broad octave
const MICRO_STRENGTH = 0.3 // how hard the broad octave bends the normal (LOD^1 gated)
const MICRO_FREQ2 = 112 // finer second octave (LOD^2 gated -> close-up only)
const MICRO_FLOW2 = 0.5 // counter-scroll speed of the fine octave
const MICRO_STRENGTH2 = 0.16 // strength of the fine octave
const MICRO_FREQ3 = 190 // capillary third octave (LOD^3 gated -> skim only, never aliases far)
const MICRO_FLOW3 = 0.9 // scroll speed of the capillary octave
const MICRO_STRENGTH3 = 0.1 // strength of the capillary octave
const MICRO_FRACTAL_OCT = 2 // octaves per fractal-noise tap
const MICRO_FRACTAL_LAC = 2.0 // lacunarity per fractal-noise tap
const MICRO_FRACTAL_DIM = 0.5 // diminish (gain) per fractal-noise tap
// Whitecap crest foam is driven by the Gerstner JACOBIAN fold rather than raw
// height: fold_i = Q_i*A_i*k_i*sin(phase_i) peaks where the surface compresses at
// steep crests (short/steep waves fold hardest -> physical whitecaps). Thresholds
// are fractions of foldMax = sum Q_i*A_i*k_i so they auto-scale with the spectrum.
const CREST_FOLD_LO = 0.38 // fold/foldMax where whitecaps begin
const CREST_FOLD_HI = 0.74 // ... where they saturate to solid white
const SHORE_FOAM_DEPTH = 0.12 // aDepth band the shore foam lives inside (0 at shoreline)

// LOD altitude band: full detail at/under NEAR, fully calm by FAR. Pulled in
// from 0.3/3.0 because the denser mesh + shorter waves alias sooner at mid
// altitude, so calm needs to arrive earlier on pull-out.
const LOD_NEAR = 0.2
const LOD_FAR = 2.2

// --- TIER 2 reflection defaults (all live-tunable uniforms; see `uniforms`
// on the returned handle). Reflection is art-directed directly in colorNode
// (NOT via material.envMap) so fresnel weighting, crispness and the moving sun
// glint are fully controllable and decoupled from the lit roughness. ----------
const REFL_INTENSITY = 0.55 // grazing (edge-on) sky-reflection strength
const REFL_F0 = 0.03 // face-on water reflectance (Schlick F0 ~ 0.02-0.03)
const REFL_ROUGH = 0.06 // env-sample roughness: low = crisp sky, ~0.12 = softer
const GLINT_SHARP = 600 // sun-glint tightness (200 broad ... 2000 pinpoint)
const GLINT_INTENSITY = 2.5 // >1 leaves bloom headroom
const SUN_GLINT_COLOR = 0xfff2d8 // matches sky.js SUN_BASE_COLOR
const REFL_SKY_LO = 0x223247 // procedural-fallback horizon tint (no envMap)
const REFL_SKY_HI = 0x9db8ff // procedural-fallback zenith tint (matches ART.md sky top)
const DEFAULT_SUN_DIR = new THREE.Vector3(1, 0.45, 0.9).normalize() // == sky.js SUN_DIR

/** Deterministic, uniformly distributed random unit vector. */
function randUnitVec(rng) {
  const z = rng() * 2 - 1
  const t = rng() * Math.PI * 2
  const r = Math.sqrt(Math.max(0, 1 - z * z))
  return new THREE.Vector3(r * Math.cos(t), r * Math.sin(t), z)
}

/** A random unit vector perpendicular to W (uniform azimuth in W's tangent plane). */
function randPerp(W, rng) {
  const a = Math.abs(W.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0)
  const t1 = new THREE.Vector3().crossVectors(W, a).normalize()
  const t2 = new THREE.Vector3().crossVectors(W, t1) // already unit (W,t1 orthonormal)
  const phi = rng() * Math.PI * 2
  return t1.multiplyScalar(Math.cos(phi)).add(t2.multiplyScalar(Math.sin(phi)))
}

/**
 * Seeded directional wave SPECTRUM: WAVE_COUNT octaves along a geometric
 * wavelength progression, spread in a cone about one of TWO seeded wind
 * directions (primary wind for the longer octaves, a crossing second wind for
 * the shorter ~45%), with a spectral amplitude falloff renormalized to
 * TARGET_AMP_SUM. Each entry is a plain-number descriptor
 * { dir, k, A, Q, c, lodPow }. Returns { waves, wind } (the primary wind drives
 * the micro-normal advection).
 */
function makeWaves(seed) {
  const rng = rngFromString(seed + ':ocean:waves')
  const wind = randUnitVec(rng) // dominant sea direction
  // A crossing second wind 60-109deg off the primary, for the shorter octaves.
  const wind2 = (() => {
    const p = randPerp(wind, rng)
    const a = lerp(1.05, 1.9, rng()) // radians off `wind`
    return wind
      .clone()
      .multiplyScalar(Math.cos(a))
      .add(p.multiplyScalar(Math.sin(a)))
      .normalize()
  })()
  const crossFrom = Math.floor(WAVE_COUNT * CROSS_FRACTION)
  const waves = []
  for (let i = 0; i < WAVE_COUNT; i++) {
    // t in [0,1]: 0 -> longest swell, 1 -> shortest chop. Jittered so octaves
    // don't beat against each other in a perfectly even comb.
    const t = (i + (rng() - 0.5) * 0.6) / (WAVE_COUNT - 1)
    const tc = clamp(t, 0, 1)
    const L = WAVELEN_LONG * Math.pow(WAVELEN_SHORT / WAVELEN_LONG, tc) // geometric
    const k = (2 * Math.PI) / L
    const A = Math.pow(L / WAVELEN_LONG, AMP_FALLOFF) // spectral falloff (pre-norm)
    const Q = lerp(STEEP_LONG, STEEP_SHORT, tc)
    const c = SPEED_BASE * Math.sqrt(k) // deep-water dispersion
    const cone = lerp(CONE_LONG, CONE_SHORT, tc)
    const theta = (rng() * 2 - 1) * cone
    // Shorter octaves ride the crossing wind -> a crossing sea (the single
    // biggest "less uniform / more sea-like" lever).
    const base = i >= crossFrom ? wind2 : wind
    const perp = randPerp(base, rng)
    const dir = base
      .clone()
      .multiplyScalar(Math.cos(theta))
      .add(perp.multiplyScalar(Math.sin(theta))) // unit: cos*base + sin*perp
    // Per-wave LOD exponent: short chop (tc->1) fades FIRST on pull-out because
    // it aliases before the swell. Applied as uWaveLOD^lodPow inside waveDisp.
    const lodPow = lerp(LOD_POW_LONG, LOD_POW_SHORT, tc)
    waves.push({ dir, k, A, Q, c, lodPow })
  }
  // Renormalize amplitudes so the summed vertical amplitude == TARGET_AMP_SUM,
  // pinning the sea state regardless of octave count / falloff exponent.
  const ampSum = waves.reduce((s, w) => s + w.A, 0)
  const scale = TARGET_AMP_SUM / ampSum
  for (const w of waves) w.A *= scale
  return { waves, wind }
}

export function createOcean(planet, camera, seed, envMap) {
  // --- geometry + aDepth bake ---------------------------------------------
  const geo = new THREE.SphereGeometry(SEA_LEVEL, SEGMENTS_W, SEGMENTS_H)
  const posAttr = geo.attributes.position
  const vtxCount = posAttr.count
  const depthArr = new Float32Array(vtxCount)
  const dir = new THREE.Vector3()
  for (let i = 0; i < vtxCount; i++) {
    dir.set(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i)).normalize()
    const seafloorH = planet.sampleHeight(dir)
    depthArr[i] = clamp((SEA_LEVEL - seafloorH) / WATER_COLOR_RANGE, 0, 1)
  }
  geo.setAttribute('aDepth', new THREE.BufferAttribute(depthArr, 1))

  // --- material ------------------------------------------------------------
  // Ported constructor values from the old ocean (opacity/roughness/metalness/
  // emissive preserved). vertexColors intentionally NOT set: colorNode fully
  // REPLACES the diffuse albedo, as the old shader did. Roughness/metalness are
  // left as-is (0.42 / 0.02): the TIER 2 reflection is done in colorNode,
  // decoupled from the lit roughness, so we get crisp reflections without a
  // metallic hemisphere blowout.
  const material = new THREE.MeshStandardNodeMaterial({
    color: OCEAN_COLOR,
    transparent: true,
    opacity: 0.86,
    roughness: 0.42, // low enough for a glint, high enough not to blow out a hemisphere
    metalness: 0.02,
    emissive: OCEAN_EMISSIVE,
    emissiveIntensity: 0.25,
    depthWrite: true,
  })

  // --- uniforms (only these animate; the node graph is built ONCE) ---------
  const uTime = uniform(0)
  const uWaveLOD = uniform(1)

  // TIER 2 reflection uniforms (all live-tunable via the returned `uniforms`).
  const uReflect = uniform(1) // master A/B gate for the whole reflection+glint layer (1=on)
  const uSunDir = uniform(DEFAULT_SUN_DIR.clone()) // LIVE sun direction (written each frame)
  const uReflIntensity = uniform(REFL_INTENSITY)
  const uReflF0 = uniform(REFL_F0)
  const uReflRough = uniform(REFL_ROUGH)
  const uGlintSharp = uniform(GLINT_SHARP)
  const uGlintIntensity = uniform(GLINT_INTENSITY)
  const uSunColor = color(SUN_GLINT_COLOR) // fixed glint tint (matches sky SUN_BASE_COLOR)

  // Palette nodes.
  const uSapphire = color(SAPPHIRE)
  const uTurquoise = color(TURQUOISE)
  const uStopShallow = color(STOP_SHALLOW)
  const uStopMid = color(STOP_MID)
  const uStopDeep = color(STOP_DEEP)
  const uCoastColor = color(COAST_COLOR)
  const uShoreBand = color(SHORE_BAND)
  const uFoam = color(FOAM_WHITE)

  const aDepth = attribute('aDepth', 'float')

  // Wave constants baked into the graph. The primary wind drives the
  // micro-normal advection (object-space; the ocean mesh is never rotated).
  const { waves, wind } = makeWaves(seed)
  const uWind = vec3(wind.x, wind.y, wind.z)
  const waveNodes = waves.map((w) => ({
    dir: vec3(w.dir.x, w.dir.y, w.dir.z),
    k: float(w.k),
    A: float(w.A),
    Q: float(w.Q),
    c: float(w.c),
    lodPow: float(w.lodPow),
  }))

  // Max possible Gerstner fold (sum of per-wave Q*A*k). Whitecap thresholds are
  // fractions of this so they auto-scale with the seeded spectrum.
  const foldMax = waves.reduce((s, w) => s + w.Q * w.A * w.k, 0)
  const uFoldLo = float(foldMax * CREST_FOLD_LO)
  const uFoldHi = float(foldMax * CREST_FOLD_HI)

  // Shared spherical-Gerstner displacement, evaluated in OBJECT space. Returns
  // the vec3 displacement to add to positionLocal. Each wave is scaled by a
  // per-wave LOD term uWaveLOD^lodPow (short chop fades first on pull-out) --
  // this is the ONLY place altitude LOD touches the geometry now, so the
  // finite-diff normal (which also calls waveDisp) stays perfectly consistent.
  // The tangential (crest-pinch) term uses the UN-normalized tangent-plane
  // projection of the wave direction: its magnitude naturally tapers to 0 where
  // the wave direction meets the surface normal (the wave's own "poles"), which
  // both avoids a normalize() NaN there and reads as a sensible steepness falloff.
  const waveDisp = Fn(
    ([P]) => {
      const N = normalize(P)
      const disp = vec3(0, 0, 0).toVar()
      for (const w of waveNodes) {
        const phase = w.k.mul(dot(w.dir, P)).add(w.c.mul(uTime))
        const tang = w.dir.sub(N.mul(dot(w.dir, N))) // tangent-plane projection (un-normalized)
        const wl = uWaveLOD.pow(w.lodPow) // per-wave altitude fade (chop first)
        disp.addAssign(N.mul(w.A.mul(sin(phase))).mul(wl)) // vertical bob
        disp.addAssign(tang.mul(w.Q.mul(w.A).mul(cos(phase))).mul(wl)) // Gerstner crest pinch
      }
      return disp
    },
    { P: 'vec3', return: 'vec3' },
  )

  // Foam drivers -- returns vec2(height, fold): the summed vertical term (shore
  // lapping) and the summed Gerstner Jacobian fold sum Q*A*k*sin(phase) (whitecap
  // crest compression). Cheaper than the full displacement when only these
  // scalars are needed. (No LOD applied here -- foam is gated by uWaveLOD at the
  // colorNode consumer, and fold thresholds are fractions of the full foldMax.)
  const waveScalars = Fn(
    ([P]) => {
      const hSum = float(0).toVar()
      const foldSum = float(0).toVar()
      for (const w of waveNodes) {
        const phase = w.k.mul(dot(w.dir, P)).add(w.c.mul(uTime))
        const s = sin(phase)
        hSum.addAssign(w.A.mul(s))
        foldSum.addAssign(w.Q.mul(w.A).mul(w.k).mul(s))
      }
      return vec2(hSum, foldSum)
    },
    { P: 'vec3', return: 'vec2' },
  )

  // Frozen-sea palette + irregular polar-ice mask, computed from positionLocal
  // so the vertex wave-flattening and the fragment colour agree exactly. The
  // |latitude| is pushed through a noise-jittered smoothstep, so the frozen zone
  // has a wavy, coastline-like edge instead of a clean latitude ring.
  const uIce = color(ICE_COLOR)
  const uIceCrack = color(ICE_CRACK_COLOR)
  const uIceBias = uniform(0) // season-driven extent shift (winter grows the cap)
  const iceMaskAt = (pos) => {
    const lat = normalize(pos).y.abs()
    const edge = mx_noise_float(pos.mul(ICE_EDGE_SCALE)).mul(ICE_EDGE_JITTER)
    return smoothstep(float(ICE_LAT_LO), float(ICE_LAT_HI), lat.add(edge).add(uIceBias))
  }

  // Ice reads matte (no water sun-glint) — roughnessNode overrides the
  // constructor roughness where the surface is frozen.
  material.roughnessNode = mix(float(0.42), float(0.92), iceMaskAt(positionLocal))

  // Per-vertex geometric-amplitude scale: shoreline fade (crests shrink to
  // nothing in the shallows -- covenant/coast-read protection), then the swell
  // flattens to near-nothing under full ice so the frozen sea sits calm. The
  // altitude LOD is NOT here anymore -- it lives per-wave inside waveDisp so the
  // short chop can fade before the swell.
  const geoScale = smoothstep(0.01, 0.14, aDepth).mul(iceMaskAt(positionLocal).mul(ICE_WAVE_DAMP).oneMinus())

  // --- positionNode: displace along the Gerstner field ---------------------
  material.positionNode = positionLocal.add(waveDisp(positionLocal).mul(geoScale))

  // --- normalNode: analytic finite-diff normal + procedural micro-normal ----
  material.normalNode = Fn(() => {
    const N0 = normalize(positionLocal)
    // Pole-safe tangent basis.
    const axis = N0.y
      .abs()
      .lessThan(0.99)
      .select(vec3(0, 1, 0), vec3(1, 0, 0))
    const U = normalize(cross(N0, axis))
    const V = cross(N0, U)

    const eps = float(NORMAL_EPS)
    const s = geoScale
    const P0 = positionLocal.add(waveDisp(positionLocal).mul(s))
    const Pu0 = positionLocal.add(U.mul(eps))
    const Pu = Pu0.add(waveDisp(Pu0).mul(s))
    const Pv0 = positionLocal.add(V.mul(eps))
    const Pv = Pv0.add(waveDisp(Pv0).mul(s))
    const nrm = normalize(cross(Pu.sub(P0), Pv.sub(P0))).toVar()

    // Procedural scrolling micro-normal: object-space finite-diff of a
    // WIND-ADVECTED FRACTAL noise field along U/V -- the fine sparkle the
    // geometry can't carry. Each tap is multi-octave (mx_fractal_noise_float)
    // so it's crisper than single-octave value noise; the finite-diff offset
    // MICRO_DN is in NOISE space (fixed, freq-independent). Three octaves: a
    // broad drift (LOD^1), a finer counter-scroll (LOD^2), and a capillary
    // detail (LOD^3) that only sharpens at the skim so the distant ocean never
    // shimmers/aliases.
    const microSlope = (freq, flow, strength) => {
      const scroll = uWind.mul(uTime.mul(flow)) // advect along the seeded wind
      const c = positionLocal.mul(freq).add(scroll) // noise-space coord
      const du = U.mul(MICRO_DN)
      const dv = V.mul(MICRO_DN)
      const hUp = mx_fractal_noise_float(c.add(du), MICRO_FRACTAL_OCT, MICRO_FRACTAL_LAC, MICRO_FRACTAL_DIM)
      const hUn = mx_fractal_noise_float(c.sub(du), MICRO_FRACTAL_OCT, MICRO_FRACTAL_LAC, MICRO_FRACTAL_DIM)
      const hVp = mx_fractal_noise_float(c.add(dv), MICRO_FRACTAL_OCT, MICRO_FRACTAL_LAC, MICRO_FRACTAL_DIM)
      const hVn = mx_fractal_noise_float(c.sub(dv), MICRO_FRACTAL_OCT, MICRO_FRACTAL_LAC, MICRO_FRACTAL_DIM)
      return U.mul(hUp.sub(hUn))
        .add(V.mul(hVp.sub(hVn)))
        .mul(strength)
    }

    const slope = microSlope(MICRO_FREQ, MICRO_FLOW, MICRO_STRENGTH).mul(uWaveLOD).toVar()
    slope.addAssign(microSlope(MICRO_FREQ2, MICRO_FLOW2 * -1, MICRO_STRENGTH2).mul(uWaveLOD.mul(uWaveLOD)))
    slope.addAssign(
      microSlope(MICRO_FREQ3, MICRO_FLOW3, MICRO_STRENGTH3).mul(uWaveLOD.mul(uWaveLOD).mul(uWaveLOD)),
    )

    nrm.assign(normalize(nrm.sub(slope)))

    return transformNormalToView(nrm).normalize()
  })()

  // --- colorNode: ported stylized water look + foam + TIER 2 reflection -----
  material.colorNode = Fn(() => {
    // View-dependent fresnel over the (radial) geometry normal -- matches the
    // old ocean's vWaterPos/vLocalUp world-space convention.
    const view = normalize(cameraPosition.sub(positionWorld))
    const fresnel = view.dot(normalWorld).clamp(0, 1).oneMinus().pow(3).toVar()
    const fresnelColor = mix(uTurquoise, uSapphire, fresnel)

    // 3-stop depth absorption.
    const depthShallow = mix(uStopShallow, uStopMid, aDepth.div(0.35))
    const depthDeep = mix(uStopMid, uStopDeep, aDepth.sub(0.35).div(0.65).clamp(0, 1))
    const depthColor = aDepth.lessThan(0.35).select(depthShallow, depthDeep)

    const waterColor = mix(depthColor, fresnelColor, fresnel.mul(0.65)).toVar()

    // Animated coast glow band (ported treatment 2).
    const coastNoise = positionWorld.x
      .mul(27)
      .add(uTime.mul(0.4))
      .sin()
      .mul(positionWorld.z.mul(22).sub(uTime.mul(0.3)).sin())
    const coastBand = aDepth.smoothstep(0.02, 0.14).oneMinus().mul(coastNoise.mul(0.45).add(0.55))
    waterColor.assign(mix(waterColor, uCoastColor, coastBand.clamp(0, 1).mul(0.55)))

    // Thin posterized shelf-line accent, edge wobbling (ported treatment 3).
    const shoreWobble = positionWorld.x
      .mul(6)
      .add(uTime.mul(0.12))
      .sin()
      .mul(positionWorld.z.mul(5.1).sub(uTime.mul(0.09)).sin())
      .mul(0.012)
    const shoreBandT = step(shoreWobble.add(0.16), aDepth).mul(step(shoreWobble.add(0.2), aDepth).oneMinus())
    waterColor.assign(mix(waterColor, uShoreBand, shoreBandT.mul(0.6)))

    // --- foam -------------------------------------------------------------
    const sc = waveScalars(positionLocal)
    const h = sc.x
    const fold = sc.y

    // Crest whitecaps: driven by the Gerstner Jacobian fold (steep short crests
    // fold hardest), broken up by scrolling noise so caps are patchy foam, not a
    // solid painted line.
    const crestRaw = smoothstep(uFoldLo, uFoldHi, fold)
    const crestNoise = mx_noise_float(positionWorld.mul(19).add(vec3(uTime.mul(0.7), 0, uTime.mul(0.55))))
      .mul(0.5)
      .add(0.5)
    const crest = crestRaw.mul(crestNoise.mul(0.55).add(0.45)).mul(uWaveLOD)

    // Shore foam: a lapping white band where the ocean meets shallow coast, two
    // scrolling noise octaves (broad drift + fine froth) modulated by wave phase
    // so it laps in and out rather than sitting static.
    const shoreN1 = mx_noise_float(positionWorld.mul(42).add(vec3(uTime.mul(0.5), 0, uTime.mul(0.4))))
      .mul(0.5)
      .add(0.5)
    const shoreN2 = mx_noise_float(positionWorld.mul(96).add(vec3(uTime.mul(-0.7), 0, uTime.mul(0.9))))
      .mul(0.5)
      .add(0.5)
    const shoreNoise = shoreN1.mul(0.65).add(shoreN2.mul(0.35))
    const lap = h.mul(60).add(uTime.mul(1.3)).sin().mul(0.5).add(0.5)
    const shoreMask = smoothstep(float(SHORE_FOAM_DEPTH), float(0), aDepth).mul(uWaveLOD)
    const shoreFoam = shoreMask.mul(shoreNoise).mul(lap.mul(0.55).add(0.45))

    const foam = crest.add(shoreFoam).clamp(0, 1)
    waterColor.assign(mix(waterColor, uFoam, foam))

    // --- TIER 2: fresnel-weighted sky reflection + live sun glint ----------
    // reflectVector is WORLD space and built from the material's SHADING normal
    // (the wave finite-diff normal + the wind-advected micro-normal above), so
    // BOTH the sky tint and the sun glint shimmer with the ripples for free --
    // no extra pass, no MRT, one cube-uv sample + a few ALU. Gated by uReflect
    // (A/B toggle), by uWaveLOD (distant/whole-planet water shows only a soft
    // tint, never a sparkle-alias), and by a SEPARATE steeper Schlick-ish
    // fresnel (pow 5) so the reflection reads mostly at grazing angles and the
    // water stays matte face-on. Placed AFTER foam and BEFORE the ice block so
    // frozen sea stays matte and overrides the reflection.
    const nDotV = view.dot(normalWorld).clamp(0, 1)
    const reflFresnel = nDotV.oneMinus().pow(5.0)
    const reflStrength = mix(uReflF0, uReflIntensity, reflFresnel).mul(uWaveLOD).mul(uReflect)

    // Sky tint: sample the existing PMREM sky capture along the wave-perturbed
    // reflectVector (its palette IS the ART.md sky, so it ties in perfectly; the
    // PMREM render-target's Y-flip is applied automatically). Zero-wiring
    // fallback when envMap isn't threaded through: a 2-color horizon->zenith
    // gradient by reflectVector.y (same fresnel + glint, just a simpler sky).
    const skyRefl = envMap
      ? pmremTexture(envMap, reflectVector, uReflRough)
      : mix(color(REFL_SKY_LO), color(REFL_SKY_HI), reflectVector.y.clamp(-1, 1).mul(0.5).add(0.5))
    waterColor.assign(mix(waterColor, skyRefl, reflStrength))

    // Sharp sun glint -- analytic, from the LIVE sun dir (the env capture's
    // baked sun is frozen at build time and would desync from the ~15-min
    // day/night orbit). Gated to the lit hemisphere (dayness) + close range
    // (uWaveLOD) so the distant/whole-planet view never sparkle-aliases.
    const dayness = normalWorld.dot(uSunDir).smoothstep(0.0, 0.15)
    const glint = reflectVector
      .dot(uSunDir)
      .max(0)
      .pow(uGlintSharp)
      .mul(uGlintIntensity)
      .mul(dayness)
      .mul(uWaveLOD)
      .mul(uReflect)
    waterColor.addAssign(uSunColor.mul(glint))

    // --- frozen sea: blend the surface toward matte ice near the poles, with
    // pressure-crack veins + faint snow mottle. This IS the ocean surface, so
    // it conforms perfectly -- no floating shell, no grazing-angle pane. Runs
    // LAST so ice overrides the reflection/glint (frozen water isn't glassy).
    const iceMask = iceMaskAt(positionLocal)
    const crackN = mx_noise_float(positionWorld.mul(ICE_CRACK_SCALE))
    const crackLines = smoothstep(0.05, 0.0, crackN.abs()).mul(0.55)
    const iceCol = mix(uIce, uIceCrack, crackLines).add(mx_noise_float(positionWorld.mul(7)).mul(0.05))
    waterColor.assign(mix(waterColor, iceCol, iceMask))

    return waterColor
  })()

  const mesh = new THREE.Mesh(geo, material)

  // --- update: presentation clock + altitude LOD + live sun direction ------
  let elapsed = 0
  function update(dt, sunDir) {
    elapsed += dt
    uTime.value = elapsed
    const alt = camera.position.length() - SEA_LEVEL
    uWaveLOD.value = 1 - smoothstepJS(LOD_NEAR, LOD_FAR, alt)
    // Live sun direction for the analytic glint (presentation only -- read from
    // the sky, never written back). Guarded so an un-wired update(dt) call just
    // leaves the glint parked at DEFAULT_SUN_DIR (== sky.js SUN_DIR).
    if (sunDir) uSunDir.value.copy(sunDir).normalize()
    // Frozen-sea extent breathes with the season (winter grows the cap toward
    // the equator). The season module's bias is negative in winter, so negate
    // it to push the ice edge outward. Guarded — no-op if seasons isn't up yet.
    const seasons = typeof window !== 'undefined' && window.__planet && window.__planet.seasons
    if (seasons && typeof seasons.getSeaIceThresholdBias === 'function') {
      uIceBias.value = -seasons.getSeaIceThresholdBias()
    }
  }

  return {
    mesh,
    update,
    // Live-tunable reflection uniforms for console A/B + tuning, e.g.:
    //   window.__planet.ocean.uniforms.uReflIntensity.value = 0.7
    //   window.__planet.ocean.uniforms.uGlintSharp.value = 1200
    // (uWaveLOD is driven every frame by update(); listed for read-back only.)
    uniforms: {
      uReflect,
      uReflIntensity,
      uReflF0,
      uReflRough,
      uGlintSharp,
      uGlintIntensity,
      uSunDir,
      uWaveLOD,
    },
    // One-liner A/B toggle for the whole reflection+glint layer:
    //   window.__planet.ocean.setReflect(false)
    setReflect(on) {
      uReflect.value = on ? 1 : 0
    },
  }
}
