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
//                      one wind direction, amplitude following a spectral falloff.
//   * normalNode    -- analytic finite-difference of that displacement in a
//                      pole-safe tangent basis, plus a two-octave procedural
//                      scrolling micro-normal for close-up sparkle.
//   * colorNode     -- the ported stylized fresnel / 3-stop depth-absorption /
//                      coast-glow look (matches the old ocean palette exactly),
//                      with aDepth-driven lapping shore foam + Jacobian-fold
//                      whitecap crest foam.
//
// Determinism: every wave direction/wavelength/amplitude/speed/steepness is
// derived from `seed` via rngFromString (same seed -> same ocean). uTime is a
// presentation-only clock accumulated from dt (never world state) -- exactly as
// the old ocean's waterElapsed was. No Math.random / Date.now.
//
// Altitude LOD: update(dt) reads the (construction-captured) camera altitude and
// writes one uWaveLOD uniform that scales geometric amplitude, foam intensity,
// and micro-normal strength, so the whole-planet view settles to a calm sphere
// (where waves would be sub-pixel and shimmer/alias) and full detail returns on
// descent to the minDistance 1.06 skim. Geometric amplitude is ADDITIONALLY
// faded to zero as aDepth -> 0 so crests shrink in the shallows (physically
// correct AND it keeps displaced crests from poking through the thin coastline).
//
// Covenant: the ocean is a passive render shell. It READS the terrain-derived
// aDepth attribute (baked once from planet.sampleHeight) and WRITES nothing to
// world state or any other module. Crest displacement is clamped to zero at the
// shoreline, so no wave ever geometrically swallows a coastal structure.
//
// Contract: createOcean(planet, camera, seed) -> { mesh, update(dt) }.
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
  transformNormalToView,
  mx_noise_float,
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

// Normalized seafloor-depth denominator -- MUST match planet.js's
// WATER_COLOR_RANGE (OCEAN_BASE_DEPTH 0.02 + OCEAN_FLOOR_AMP 0.008) so the
// baked aDepth here is identical to what the terrain uses. (planet.js exposes
// only sampleHeight/isLand/biomeAt, not this constant, so it is mirrored here.)
const WATER_COLOR_RANGE = 0.028

// ---------------------------------------------------------------------------
// Geometry. 128x96 sphere at SEA_LEVEL (~12.5k verts) -- vertex spacing
// ~2*PI/128 ~= 0.049 rad. Geometric wavelengths are floored to >= ~3-4 vertex
// spacings so waves never sub-sample into facet noise; all higher frequency
// lives in the normal/micro-normal, not the geometry.
// ---------------------------------------------------------------------------
const SEGMENTS_W = 128
const SEGMENTS_H = 96

// ---------------------------------------------------------------------------
// Wave-set tuning knobs -- a seeded directional SPECTRUM (M5b flagship). Rather
// than two hand-tuned bands we synthesize WAVE_COUNT octaves along a geometric
// wavelength progression from WAVELEN_LONG (broad groundswell) down to
// WAVELEN_SHORT (surface chop, floored to >= ~2.5 vertex spacings so geometry
// never sub-samples into facet noise). Per octave:
//   * amplitude follows a spectral falloff  A ~ (L/Lmax)^AMP_FALLOFF  (long waves
//     dominate the sea's energy) and the whole set is then renormalized so the
//     summed vertical amplitude hits TARGET_AMP_SUM exactly -- this pins the sea
//     state independent of octave count, so LOD/coast tuning never regresses.
//   * steepness rises toward shorter waves (sharp chop crests, broad swell).
//   * speed follows deep-water dispersion  c ~ sqrt(k)  (long swell outruns chop).
//   * direction is spread in a cone about a single seeded WIND direction, the
//     cone widening for shorter waves (directional spreading) -- a COHERENT
//     wind-driven sea rather than six waves pointing at random.
// Amplitudes are world units on a radius-1 planet; the renormalized peak sits
// ~0.008-0.011 -- visible at the 1.06 skim (the old ocean displaced +-0.00027).
// ---------------------------------------------------------------------------
const WAVE_COUNT = 9
const WAVELEN_LONG = 1.15 // rad (world units on the unit sphere)
const WAVELEN_SHORT = 0.14 // >= ~2.5 * (2*PI/128) vertex spacing
const AMP_FALLOFF = 0.9 // A_i ~ (L_i / WAVELEN_LONG)^AMP_FALLOFF
const TARGET_AMP_SUM = 0.011 // summed vertical amplitude after renormalization
const STEEP_LONG = 0.3 // Gerstner steepness at the longest wave
const STEEP_SHORT = 0.95 // ... at the shortest wave
const SPEED_BASE = 0.2 // c_i = SPEED_BASE * sqrt(k_i) (deep-water dispersion)
const CONE_LONG = 0.22 // directional-spread cone half-angle (rad) at long waves
const CONE_SHORT = 0.9 // ... at short waves (wider -> choppier, less aligned)

// Finite-difference / micro-normal / foam tunables.
const NORMAL_EPS = 0.01 // world-space tangent offset for the analytic normal
const MICRO_FREQ = 30 // spatial frequency of the sparkle micro-normal
const MICRO_EPS = 0.02 // world offset used to finite-difference the noise slope
const MICRO_STRENGTH = 0.28 // how hard the sparkle bends the shading normal (at full LOD)
const MICRO_FLOW = 0.28 // scroll speed of the micro-normal noise
const MICRO_FREQ2 = 78 // finer second sparkle octave (close-up only via LOD gate)
const MICRO_FLOW2 = 0.6 // faster counter-scroll of the fine octave
const MICRO_STRENGTH2 = 0.16 // strength of the fine octave (LOD^2 gated)
// Whitecap crest foam is driven by the Gerstner JACOBIAN fold rather than raw
// height: fold_i = Q_i*A_i*k_i*sin(phase_i) peaks where the surface compresses at
// steep crests (short/steep waves fold hardest -> physical whitecaps). Thresholds
// are fractions of foldMax = sum Q_i*A_i*k_i so they auto-scale with the spectrum.
const CREST_FOLD_LO = 0.38 // fold/foldMax where whitecaps begin
const CREST_FOLD_HI = 0.74 // ... where they saturate to solid white
const SHORE_FOAM_DEPTH = 0.12 // aDepth band the shore foam lives inside (0 at shoreline)

// LOD altitude band: full detail at/under NEAR, fully calm by FAR.
const LOD_NEAR = 0.3
const LOD_FAR = 3.0

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
 * wavelength progression, spread in a cone about one seeded wind direction, with
 * a spectral amplitude falloff renormalized to TARGET_AMP_SUM. Each entry is a
 * plain-number descriptor { dir, k, A, Q, c }.
 */
function makeWaves(seed) {
  const rng = rngFromString(seed + ':ocean:waves')
  const wind = randUnitVec(rng) // dominant sea direction
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
    const perp = randPerp(wind, rng)
    const dir = wind
      .clone()
      .multiplyScalar(Math.cos(theta))
      .add(perp.multiplyScalar(Math.sin(theta))) // unit: cos*W + sin*perp
    waves.push({ dir, k, A, Q, c })
  }
  // Renormalize amplitudes so the summed vertical amplitude == TARGET_AMP_SUM,
  // pinning the sea state regardless of octave count / falloff exponent.
  const ampSum = waves.reduce((s, w) => s + w.A, 0)
  const scale = TARGET_AMP_SUM / ampSum
  for (const w of waves) w.A *= scale
  return waves
}

export function createOcean(planet, camera, seed) {
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
  // REPLACES the diffuse albedo, as the old shader did.
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

  // Wave constants baked into the graph.
  const waves = makeWaves(seed)
  const waveNodes = waves.map((w) => ({
    dir: vec3(w.dir.x, w.dir.y, w.dir.z),
    k: float(w.k),
    A: float(w.A),
    Q: float(w.Q),
    c: float(w.c),
  }))

  // Max possible Gerstner fold (sum of per-wave Q*A*k). Whitecap thresholds are
  // fractions of this so they auto-scale with the seeded spectrum.
  const foldMax = waves.reduce((s, w) => s + w.Q * w.A * w.k, 0)
  const uFoldLo = float(foldMax * CREST_FOLD_LO)
  const uFoldHi = float(foldMax * CREST_FOLD_HI)

  // Shared spherical-Gerstner displacement, evaluated in OBJECT space. Returns
  // the vec3 displacement to add to positionLocal. The tangential (crest-pinch)
  // term uses the UN-normalized tangent-plane projection of the wave direction:
  // its magnitude naturally tapers to 0 where the wave direction meets the
  // surface normal (the wave's own "poles"), which both avoids a normalize()
  // NaN there and reads as a physically sensible steepness falloff.
  const waveDisp = Fn(
    ([P]) => {
      const N = normalize(P)
      const disp = vec3(0, 0, 0).toVar()
      for (const w of waveNodes) {
        const phase = w.k.mul(dot(w.dir, P)).add(w.c.mul(uTime))
        const tang = w.dir.sub(N.mul(dot(w.dir, N))) // tangent-plane projection (un-normalized)
        disp.addAssign(N.mul(w.A.mul(sin(phase)))) // vertical bob
        disp.addAssign(tang.mul(w.Q.mul(w.A).mul(cos(phase)))) // Gerstner crest pinch
      }
      return disp
    },
    { P: 'vec3', return: 'vec3' },
  )

  // Foam drivers -- returns vec2(height, fold): the summed vertical term (shore
  // lapping) and the summed Gerstner Jacobian fold sum Q*A*k*sin(phase) (whitecap
  // crest compression). Cheaper than the full displacement when only these
  // scalars are needed.
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

  // Per-vertex geometric-amplitude scale: LOD * shoreline fade (crests shrink
  // to nothing in the shallows -- covenant/coast-read protection).
  const geoScale = uWaveLOD.mul(smoothstep(0.01, 0.14, aDepth))

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

    // Procedural scrolling micro-normal (object-space finite-diff of a noise
    // field along U/V) -- the fine sparkle the geometry can't carry. Two octaves:
    // a broad drift plus a finer counter-scrolling octave (LOD^2-gated) that only
    // sharpens up close, so the distant ocean never shimmers/aliases.
    const scroll = vec3(uTime.mul(MICRO_FLOW), 0, uTime.mul(MICRO_FLOW * 0.8))
    const nUp = mx_noise_float(positionLocal.add(U.mul(MICRO_EPS)).mul(MICRO_FREQ).add(scroll))
    const nUn = mx_noise_float(positionLocal.sub(U.mul(MICRO_EPS)).mul(MICRO_FREQ).add(scroll))
    const nVp = mx_noise_float(positionLocal.add(V.mul(MICRO_EPS)).mul(MICRO_FREQ).add(scroll))
    const nVn = mx_noise_float(positionLocal.sub(V.mul(MICRO_EPS)).mul(MICRO_FREQ).add(scroll))
    const slope = U.mul(nUp.sub(nUn))
      .add(V.mul(nVp.sub(nVn)))
      .mul(uWaveLOD.mul(MICRO_STRENGTH))
      .toVar()

    const scroll2 = vec3(uTime.mul(-MICRO_FLOW2), 0, uTime.mul(MICRO_FLOW2 * 0.9))
    const mUp = mx_noise_float(positionLocal.add(U.mul(MICRO_EPS)).mul(MICRO_FREQ2).add(scroll2))
    const mUn = mx_noise_float(positionLocal.sub(U.mul(MICRO_EPS)).mul(MICRO_FREQ2).add(scroll2))
    const mVp = mx_noise_float(positionLocal.add(V.mul(MICRO_EPS)).mul(MICRO_FREQ2).add(scroll2))
    const mVn = mx_noise_float(positionLocal.sub(V.mul(MICRO_EPS)).mul(MICRO_FREQ2).add(scroll2))
    slope.addAssign(
      U.mul(mUp.sub(mUn))
        .add(V.mul(mVp.sub(mVn)))
        .mul(uWaveLOD.mul(uWaveLOD).mul(MICRO_STRENGTH2)),
    )

    nrm.assign(normalize(nrm.sub(slope)))

    return transformNormalToView(nrm).normalize()
  })()

  // --- colorNode: ported stylized water look + foam ------------------------
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

    return waterColor
  })()

  const mesh = new THREE.Mesh(geo, material)

  // --- update: presentation clock + altitude LOD ---------------------------
  let elapsed = 0
  function update(dt) {
    elapsed += dt
    uTime.value = elapsed
    const alt = camera.position.length() - SEA_LEVEL
    uWaveLOD.value = 1 - smoothstepJS(LOD_NEAR, LOD_FAR, alt)
  }

  return { mesh, update }
}
