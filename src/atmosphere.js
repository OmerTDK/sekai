// Screen-space single-scattering atmosphere (M5a) for the true WebGPU backend.
//
// A node-PostProcessing pass, composited BEFORE bloom, that gives Aemunis a
// physically-inspired atmospheric limb (the layered sunrise/sunset crescent
// hugging the planet's silhouette against space) AND aerial-perspective haze
// over terrain. Both fall out of one cause: single-scattering of sunlight
// through the air shell along each eye ray.
//
// Approach (see docs/design/m5a-atmospheric-scattering.md):
//   1. Reconstruct each pixel's world ray from the scene pass depth MRT
//      (getViewPosition + camera matrices) — proven by GTAO/Godrays/DoF.
//   2. Analytically intersect the eye ray with two concentric spheres:
//      the ground (Rg = 1) and the air-top (Rt ~ 1.15).
//   3. Integrate exponential air density over the in-shell segment with a
//      4-tap midpoint rule -> optical depth I.
//   4. Rayleigh + Mie(Henyey-Greenstein) phase + extinction, using the exact
//      scattering constants shipped in three's SkyMesh.js (cited below).
//   5. Composite: sky/star/sun pixels are NEVER dimmed (extinction gated to
//      terrain only) — they only receive additive in-scatter, so the
//      starfield, milky-way skybox, nebulae and the >1.0 bloom-headroom sun
//      all survive untouched; only the additive limb blooms.
//
// Robust to the camera being inside OR outside the shell (minDistance 1.06 is
// inside a 1.15R shell). Deterministic: every tunable derives from
// rngFromString(seed + ':atmo'); no Math.random / Date.now. The only time
// input is the sun orbit, fed in through update(dt, sunDir) — the look at a
// given sun position is a pure function of the sun uniform.
//
// Pure render module: reads uniforms + the depth buffer, owns no world/session
// state, creates/moves/destroys no scene objects. Covenant-inert by
// construction. NO onBeforeCompile / ShaderMaterial / pointUV / gl_PointCoord.

import * as THREE from 'three/webgpu'
import {
  Fn,
  Loop,
  uv,
  uniform,
  float,
  vec3,
  vec4,
  dot,
  max,
  min,
  sqrt,
  exp,
  pow,
  mix,
  select,
  getViewPosition,
} from 'three/tsl'
import { rngFromString, lerp } from './util.js'

// Planet ground radius. Terrain caps at HEIGHT_MAX ~1.06 and cloud shells sit
// ~1.09, so an air-top near 1.15 clears both (per ART.md height-cap).
const Rg = 1.0

// Wavelength primaries per Preetham, lifted verbatim from three's SkyMesh.js
// (examples/jsm/objects/SkyMesh.js:173). The hue *ratio* is what makes air
// blue and sunsets red — we keep the ratio and scale amplitude for planetary
// (unit-radius) geometry, which SkyMesh does not do (it is a ground dome).
const TOTAL_RAYLEIGH = [5.804542996261093e-6, 1.3562911419845635e-5, 3.0265902468824876e-5]

// 3 / (16*pi) and 1 / (4*pi) — Rayleigh and Mie phase normalizers
// (SkyMesh.js:240,242).
const THREE_OVER_SIXTEENPI = 0.05968310365946075
const ONE_OVER_FOURPI = 0.07957747154594767

// Warm-white sunlight anchor (#fff2d8, the app's sun color). The pass reddens
// this per-pixel via the sun-transmittance proxy, so the *base* stays neutral.
const SUN_COLOR = new THREE.Color('#fff2d8')

/**
 * Build the atmospheric-scattering post node.
 *
 * @param {string} seed - world seed; all params derive from `seed + ':atmo'`.
 * @param {THREE.PerspectiveCamera} camera - the scene camera (its matrices are
 *   sampled each frame in update(); the post quad's own camera must NOT be used
 *   to reconstruct world rays, hence explicit uniforms here).
 * @returns {{
 *   node: (sceneColorNode: Node, sceneDepthNode: Node) => Node,
 *   update: (dt: number, sunDir: THREE.Vector3, sunIntensity?: number) => void,
 *   setEnabled: (on: boolean) => void,
 *   getParams: () => object,
 *   params: object,
 * }}
 */
export function createAtmosphereScattering(seed, camera) {
  const rng = rngFromString(seed + ':atmo')

  // --- seeded params (deterministic) ---------------------------------------
  // rayleighScale re-parameterizes the tiny per-metre Earth coefficients up to
  // order-1 optical depth over a ~0.15-unit shell (SkyMesh multiplies by an
  // 8.4e3 zenith length for the same reason; ours is folded into one scale).
  const params = {
    rayleighScale: lerp(0.9e5, 1.15e5, rng()),
    mieCoeff: lerp(0.5, 0.75, rng()),
    mieG: lerp(0.76, 0.82, rng()),
    scaleHeight: lerp(0.018, 0.026, rng()),
    Rt: lerp(1.14, 1.16, rng()),
    aerialStrength: lerp(0.4, 0.6, rng()),
    amplitude: lerp(1.2, 1.55, rng()),
    // Redness of sunlight after traversing the air toward each scatter point,
    // as a fraction of the view-segment optical depth (cheap sunset proxy).
    sunPathK: lerp(0.5, 0.75, rng()),
  }

  // --- uniforms ------------------------------------------------------------
  // Scene-camera matrices (post quad's camera differs — must be explicit).
  const uProjInv = uniform(new THREE.Matrix4())
  const uCamWorld = uniform(new THREE.Matrix4())
  const uCamPos = uniform(new THREE.Vector3())
  const uSunDir = uniform(new THREE.Vector3(0, 1, 0))
  const uSunColor = uniform(new THREE.Vector3(SUN_COLOR.r, SUN_COLOR.g, SUN_COLOR.b))
  const uSunIntensity = uniform(1)
  const uEnabled = uniform(1) // 0 -> exact passthrough (setEnabled / fallback)

  // Seeded scattering coefficients (baked constants — hue ratio preserved).
  const betaR = vec3(
    TOTAL_RAYLEIGH[0] * params.rayleighScale,
    TOTAL_RAYLEIGH[1] * params.rayleighScale,
    TOTAL_RAYLEIGH[2] * params.rayleighScale,
  )
  const betaM = vec3(params.mieCoeff, params.mieCoeff, params.mieCoeff)
  const Rt = float(params.Rt)
  const H = float(params.scaleHeight)
  const mieG = float(params.mieG)
  const uAerial = uniform(params.aerialStrength)
  const uAmplitude = uniform(params.amplitude)
  const sunPathK = float(params.sunPathK)

  const NUM_STEPS = 4 // fixed, deterministic; no dither needed for a thin shell

  function node(sceneColorNode, sceneDepthNode) {
    const graph = Fn(() => {
      const uvN = uv()

      // Perspective depth straight from the scene pass depth MRT. Our true
      // WebGPU backend is non-logarithmic (renderer.logarithmicDepthBuffer is
      // false), so no linearization guard is needed; if log-depth is ever
      // enabled, wrap this in the GodraysNode.js:357-371 viewZ guard.
      const depth = sceneDepthNode.sample(uvN).r

      // Sky pixels write far depth (skybox/stars/sun sprite are depthWrite:false
      // MeshBasic/Sprite) -> they must never be extinguished, only lit.
      const isSky = depth.greaterThanEqual(0.9999)

      // World-space eye ray. View position is valid for terrain AND sky (the
      // far-plane point still gives the correct ray direction).
      const viewPos = getViewPosition(uvN, depth, uProjInv)
      const worldPos = uCamWorld.mul(vec4(viewPos, 1.0)).xyz
      const ro = uCamPos // ray origin (camera, world)
      const toPixel = worldPos.sub(ro)
      const sceneDist = toPixel.length()
      const rd = toPixel.div(max(sceneDist, float(1e-5))) // normalized dir

      // --- ray vs. air-top sphere (radius Rt, centred at origin) ------------
      // |ro + t*rd|^2 = Rt^2  ->  t^2 + 2b t + (|ro|^2 - Rt^2) = 0
      const b = dot(ro, rd)
      const roLen2 = dot(ro, ro)
      const cTop = roLen2.sub(Rt.mul(Rt))
      const discTop = b.mul(b).sub(cTop)
      const hitAtmo = discTop.greaterThan(0.0)
      const sqrtTop = sqrt(max(discTop, float(0.0)))
      const tA0 = b.negate().sub(sqrtTop) // shell entry
      const tA1 = b.negate().add(sqrtTop) // shell exit

      // Segment of the ray actually inside the air shell, in front of the
      // camera, and not past the nearest occluder. For sky the occluder is the
      // far shell exit; for terrain it's the reconstructed surface distance.
      const occluder = select(isSky, tA1, min(sceneDist, tA1))
      const segStart = max(tA0, float(0.0))
      const segEnd = max(occluder, segStart)
      // Zero-length (and atmosphere-miss) segments contribute nothing.
      const segLen = select(hitAtmo, segEnd.sub(segStart), float(0.0))
      const ds = segLen.div(float(NUM_STEPS))

      // --- optical depth: 4-tap midpoint integral of exp(-(r-Rg)/H) ---------
      const opticalI = float(0.0).toVar()
      Loop(NUM_STEPS, ({ i }) => {
        const t = segStart.add(ds.mul(float(i).add(0.5)))
        const p = ro.add(rd.mul(t))
        const height = p.length().sub(float(Rg))
        const density = exp(height.div(H).negate())
        opticalI.addAssign(density.mul(ds))
      })

      // Segment transmittance (aerial extinction). Mie extinction ~ 1.1x its
      // scattering. Per-channel: blue attenuates fastest.
      const Fex = exp(betaR.add(betaM.mul(1.1)).mul(opticalI).negate())

      // Sunlight reddens as it traverses the air toward the scatter points
      // (long view path near the limb -> deep, reddened sun -> amber crescent).
      const sunTransmit = exp(betaR.add(betaM).mul(opticalI).mul(sunPathK).negate())

      // --- phase functions (SkyMesh.js:264,269-271) -------------------------
      const cosTheta = dot(rd, uSunDir)
      const cH = cosTheta.mul(0.5).add(0.5)
      const rPhase = float(THREE_OVER_SIXTEENPI).mul(float(1.0).add(cH.mul(cH)))
      const g2 = mieG.mul(mieG)
      const mDenom = pow(float(1.0).add(g2).sub(mieG.mul(2.0).mul(cosTheta)), 1.5)
      const mPhase = float(ONE_OVER_FOURPI)
        .mul(float(1.0).sub(g2))
        .div(max(mDenom, float(1e-4)))

      // Directional scattering color (normalized ratio, SkyMesh Lin structure).
      const betaRTheta = betaR.mul(rPhase)
      const betaMTheta = betaM.mul(mPhase)
      const inScatterCoeff = betaRTheta.add(betaMTheta).div(betaR.add(betaM))

      // In-scattered radiance. (1 - Fex) is the analytic path accumulation.
      const Lin = uSunColor
        .mul(uSunIntensity)
        .mul(sunTransmit)
        .mul(inScatterCoeff)
        .mul(float(1.0).sub(Fex))
        .mul(uAmplitude)
        .mul(uEnabled)

      // Extinction gated to terrain only — sky/stars/sun are additive-only.
      const terrainExt = mix(vec3(1.0, 1.0, 1.0), Fex, uAerial.mul(uEnabled))
      const extinction = select(isSky, vec3(1.0, 1.0, 1.0), terrainExt)

      const outRgb = sceneColorNode.rgb.mul(extinction).add(Lin)
      return vec4(outRgb, sceneColorNode.a)
    })
    return graph()
  }

  // Feed the scene camera + sun into the uniforms each frame. Called after
  // sky.update() so the sun position is current. No per-frame allocation.
  function update(dt, sunDir, sunIntensity = 1) {
    camera.updateMatrixWorld()
    uCamWorld.value.copy(camera.matrixWorld)
    uProjInv.value.copy(camera.projectionMatrixInverse)
    uCamPos.value.setFromMatrixPosition(camera.matrixWorld)
    if (sunDir) uSunDir.value.copy(sunDir).normalize()
    uSunIntensity.value = sunIntensity
  }

  function setEnabled(on) {
    uEnabled.value = on ? 1 : 0
  }

  function getParams() {
    return { ...params }
  }

  return { node, update, setEnabled, getParams, params }
}
