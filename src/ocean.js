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
//                      6 waves: 4 long swell (low steepness) + 2 short chop.
//   * normalNode    -- analytic finite-difference of that displacement in a
//                      pole-safe tangent basis, plus a procedural scrolling
//                      micro-normal for close-up sparkle.
//   * colorNode     -- the ported stylized fresnel / 3-stop depth-absorption /
//                      coast-glow look (matches the old ocean palette exactly),
//                      with aDepth-driven lapping shore foam + Gerstner crest foam.
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
// Wave-set tuning knobs.
//  * SWELL: long wavelength, low steepness -> broad rolling groundswell.
//  * CHOP:  short wavelength, higher steepness -> sharper surface texture.
// Amplitudes (world units on a radius-1 planet) sum so a typical (RMS) surface
// sits ~0.004-0.005 with peaks to ~0.008 -- visible at the 1.06 skim, inside
// the stylized look (the old ocean displaced only +-0.00027, i.e. glass).
// ---------------------------------------------------------------------------
const SWELL_COUNT = 4
const CHOP_COUNT = 2
const SWELL_WAVELEN = [0.55, 1.05] // rad (world units on the unit sphere)
const SWELL_AMP = [0.0016, 0.0026]
const SWELL_STEEP = [0.28, 0.5]
const SWELL_SPEED = [0.5, 0.95] // phase-speed multiplier on uTime
const CHOP_WAVELEN = [0.18, 0.3]
const CHOP_AMP = [0.0006, 0.0011]
const CHOP_STEEP = [0.6, 0.9]
const CHOP_SPEED = [0.9, 1.5]

// Finite-difference / micro-normal / foam tunables.
const NORMAL_EPS = 0.01 // world-space tangent offset for the analytic normal
const MICRO_FREQ = 30 // spatial frequency of the sparkle micro-normal
const MICRO_EPS = 0.02 // world offset used to finite-difference the noise slope
const MICRO_STRENGTH = 0.28 // how hard the sparkle bends the shading normal (at full LOD)
const MICRO_FLOW = 0.28 // scroll speed of the micro-normal noise
const CREST_HI = 0.0032 // heightSum above which crest foam appears
const CREST_W = 0.0014 // crest-foam smoothstep width
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

/** Seeded 6-wave set: 4 swell + 2 chop, each a plain-number descriptor. */
function makeWaves(seed) {
  const rng = rngFromString(seed + ':ocean:waves')
  const waves = []
  const push = (wl, amp, steep, spd) => {
    const dir = randUnitVec(rng)
    const L = lerp(wl[0], wl[1], rng())
    waves.push({
      dir,
      k: (2 * Math.PI) / L, // wavenumber
      A: lerp(amp[0], amp[1], rng()),
      Q: lerp(steep[0], steep[1], rng()),
      c: lerp(spd[0], spd[1], rng()),
    })
  }
  for (let i = 0; i < SWELL_COUNT; i++) push(SWELL_WAVELEN, SWELL_AMP, SWELL_STEEP, SWELL_SPEED)
  for (let i = 0; i < CHOP_COUNT; i++) push(CHOP_WAVELEN, CHOP_AMP, CHOP_STEEP, CHOP_SPEED)
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
  const waveNodes = makeWaves(seed).map((w) => ({
    dir: vec3(w.dir.x, w.dir.y, w.dir.z),
    k: float(w.k),
    A: float(w.A),
    Q: float(w.Q),
    c: float(w.c),
  }))

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

  // Just the summed vertical term (crest-foam driver) -- cheaper than the full
  // displacement when only the height is needed.
  const waveHeight = Fn(
    ([P]) => {
      const hSum = float(0).toVar()
      for (const w of waveNodes) {
        const phase = w.k.mul(dot(w.dir, P)).add(w.c.mul(uTime))
        hSum.addAssign(w.A.mul(sin(phase)))
      }
      return hSum
    },
    { P: 'vec3', return: 'float' },
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
    // field along U/V) -- the fine sparkle the geometry can't carry. Faded by
    // LOD so the distant ocean never shimmers.
    const scroll = vec3(uTime.mul(MICRO_FLOW), 0, uTime.mul(MICRO_FLOW * 0.8))
    const nUp = mx_noise_float(positionLocal.add(U.mul(MICRO_EPS)).mul(MICRO_FREQ).add(scroll))
    const nUn = mx_noise_float(positionLocal.sub(U.mul(MICRO_EPS)).mul(MICRO_FREQ).add(scroll))
    const nVp = mx_noise_float(positionLocal.add(V.mul(MICRO_EPS)).mul(MICRO_FREQ).add(scroll))
    const nVn = mx_noise_float(positionLocal.sub(V.mul(MICRO_EPS)).mul(MICRO_FREQ).add(scroll))
    const microStrength = uWaveLOD.mul(MICRO_STRENGTH)
    nrm.assign(
      normalize(
        nrm.sub(
          U.mul(nUp.sub(nUn))
            .add(V.mul(nVp.sub(nVn)))
            .mul(microStrength),
        ),
      ),
    )

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
    const h = waveHeight(positionLocal)

    // Crest foam: white highlights on the steepest wave crests (approximates
    // the Gerstner Jacobian fold via the summed vertical term).
    const crest = smoothstep(float(CREST_HI), float(CREST_HI).add(CREST_W), h).mul(uWaveLOD)

    // Shore foam: a lapping white band where the ocean meets shallow coast,
    // modulated by scrolling noise and by wave phase so it laps in and out.
    const shoreNoise = mx_noise_float(positionWorld.mul(42).add(vec3(uTime.mul(0.5), 0, uTime.mul(0.4))))
      .mul(0.5)
      .add(0.5)
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
