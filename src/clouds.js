// M5c — Volumetric raymarched clouds + a true volumetric hurricane.
//
// One quarter-res screen-space raymarch POST node (the GodraysNode pattern:
// class CloudsNode extends TempNode, owns a RenderTarget + QuadMesh, renders
// once per frame in updateBefore(), exposes its result via getTextureNode()).
// The march reconstructs the world-space view ray from the beauty pass's depth
// (so clouds correctly occlude behind the planet limb / airships / the dragon),
// analytically intersects a spherical cloud shell [Rin..Rout], and marches a
// weather-map-driven density field with cheap Beer–powder lighting. The
// hurricane is injected as an analytic rotating eye / eyewall / log-spiral
// density column — a real 3D feature with a punched eye you can see the ocean
// through.
//
// ENGINE: real WebGPU backend. Everything below is TSL nodes from 'three/tsl'
// + 'three/webgpu'. No onBeforeCompile, no ShaderMaterial, no gl_PointCoord /
// pointUV. NDC depth is [0,1]; we use getViewPosition() rather than hand-rolled
// depth math. The node graph is built ONCE in setup(); every animation is a
// uniform() write in update() (never a graph swap — that would trigger the
// ~140 ms recompile hitch).
//
// SCOPE: this module owns src/clouds.js only. It reads the SAME equirect
// coverage field planet.js shadows from via sky.js's already-exported
// getCloudShadowUniforms() (no sky.js edit), and reads the hurricane via
// storms.getPrimary(). The spin/basis for the storm column is reconstructed
// locally (deterministic spin sign from the storm latitude), so no storms.js
// edit is needed either.
import * as THREE from 'three/webgpu'
import { TempNode, NodeMaterial, QuadMesh, RenderTarget, RendererUtils, NodeUpdateType } from 'three/webgpu'
import {
  uniform,
  texture,
  uv,
  vec2,
  vec3,
  vec4,
  float,
  Fn,
  Loop,
  Break,
  If,
  getViewPosition,
  screenCoordinate,
  interleavedGradientNoise,
  passTexture,
  logarithmicDepthToViewZ,
  viewZToPerspectiveDepth,
  mix,
  exp,
  max,
  min,
  dot,
  length,
  smoothstep,
  acos,
  atan,
  log,
  mx_fractal_noise_float,
} from 'three/tsl'
import { getCloudShadowUniforms } from './sky.js'
import { smoothstep as smoothstepJS } from './util.js'

// -------------------------------------------------------------- geometry ---
// Cloud shell radii (planet radius = 1). Rout stays under the atmosphere rim
// at 1.11 (ART.md §3 rebasing) so the deck never pokes through the glow.
const R_IN = 1.075
const R_OUT = 1.11
const SHELL_H = R_OUT - R_IN

const PI = Math.PI
const TWO_PI = Math.PI * 2

// ------------------------------------------------------------- hurricane ---
// Mirrors storms.js's discDensity/bandDensity constants (fractions of the
// storm's angular radius, r∈[0,1] with the eye at r=0). The JS values are the
// source of truth; this is the faithful TSL port.
const STORM_ANG_R = 0.47 // storm angular half-extent (rad); matches the flat patch's ~0.95-rad sweep
const EYE_R = 0.05
const WALL_R = 0.12
const CORE_R = 0.3
const CORE_SOFT = 0.06
const BAND_OUTER = 1.05
const ARM_COUNT = 2
const ARM_TIGHTNESS = 2.8
const ARM_SHARPNESS = 1.8

// Storm lifecycle spin (mirrors storms.js SPIN_RATE); reconstructed locally
// since getPrimary() exposes only dir + strength.
const SPIN_RATE = 0.16

// ------------------------------------------------------------ appearance ---
const DETAIL_FREQ = 9.0 // cauliflower/wisp erosion frequency
const EROSION = 0.55 // how hard the detail noise carves cloud edges
const DRIFT_SPEED = 0.006 // slow deck drift (rad-ish per second along a fixed tilt)
const COV_LO = 0.4 // in-shader sparsification of the shared 0.20-coverage field:
const COV_HI = 0.85 // remap so only dense cores survive (ART.md §5 "sparse beats dense" + perf)

const SUN_COLOR = new THREE.Color(1.0, 0.98, 0.92) // ≤1 so clouds never trip the bloom threshold (ART.md §2.4)
const AMBIENT_FILL = new THREE.Color(0.55, 0.6, 0.7) // silver-blue hemisphere fill (#b9c4d4 family)

// Camera-distance fades (ART.md §5): full ambient deck at 2.4R, thin by 1.35R;
// hurricane gone by 1.6R.
const AMBIENT_FADE_NEAR = 1.35
const AMBIENT_FADE_FAR = 2.4
const STORM_FADE_NEAR = 1.35
const STORM_FADE_FAR = 1.6

const _blankData = new Uint8Array([0, 0, 0, 255])

/**
 * A screen-space raymarch post node for the volumetric cloud deck + hurricane.
 *
 * @param {TextureNode} depthNode - the beauty pass's depth texture node.
 * @param {Camera} camera
 * @param {Object} u - the shared uniform bag built by createVolumetricClouds().
 */
class CloudsNode extends TempNode {
  static get type() {
    return 'CloudsNode'
  }

  constructor(depthNode, camera, u) {
    super('vec4')

    this.depthNode = depthNode
    this._camera = camera
    this.u = u

    // Half per axis = quarter pixels (GodraysNode's exact resolutionScale
    // field; setSize rounds resolutionScale * drawingBufferSize).
    this.resolutionScale = 0.5
    this.updateBeforeType = NodeUpdateType.FRAME

    this._rt = new RenderTarget(1, 1, { depthBuffer: false })
    this._rt.texture.name = 'VolumetricClouds'

    this._material = new NodeMaterial()
    this._material.name = 'VolumetricClouds'

    this._textureNode = passTexture(this, this._rt.texture)
  }

  getTextureNode() {
    return this._textureNode
  }

  setSize(width, height) {
    width = Math.max(1, Math.round(this.resolutionScale * width))
    height = Math.max(1, Math.round(this.resolutionScale * height))
    this._rt.setSize(width, height)
  }

  updateBefore(frame) {
    const { renderer } = frame

    this._rendererState = RendererUtils.resetRendererState(renderer, this._rendererState)

    const size = renderer.getDrawingBufferSize(_scratchSize)
    this.setSize(size.width, size.height)

    _quad.material = this._material
    _quad.name = 'VolumetricClouds'

    // Clear to fully-transparent black; empty-sky pixels early-out to vec4(0).
    renderer.setClearColor(0x000000, 0)
    renderer.setRenderTarget(this._rt)
    renderer.clear()
    _quad.render(renderer)

    RendererUtils.restoreRendererState(renderer, this._rendererState)
  }

  setup(builder) {
    const u = this.u
    const uvNode = uv()

    // --- depth → world-space view ray (GodraysNode recipe) ------------------
    const sampleDepth = (coord) => {
      const d = this.depthNode.sample(coord).r
      if (builder.renderer.logarithmicDepthBuffer === true) {
        const vz = logarithmicDepthToViewZ(d, u.cameraNear, u.cameraFar)
        return viewZToPerspectiveDepth(vz, u.cameraNear, u.cameraFar)
      }
      return d
    }

    // Coverage from the SAME equirect weather map planet.js shadows from:
    // rotate world dir → lower-shell-local, then equirect uv (theta=acos(y),
    // phi=atan2(z,-x)) — exactly sky.js's localDirToUV convention. Sparsified
    // in-shader to a near-clear ambient sky (perf + hero-hurricane doctrine).
    const coverageAt = (dir) => {
      const localDir = u.weatherMat.mul(dir).normalize()
      const theta = acos(localDir.y.clamp(-1, 1))
      const phi = atan(localDir.z, localDir.x.negate())
      const mapUv = vec2(phi.div(TWO_PI), float(1).sub(theta.div(PI)))
      // Explicit LOD 0: this sample runs inside the march loop (non-uniform
      // control flow), where WGSL forbids implicit-derivative textureSample.
      const raw = u.weatherTex.sample(mapUv).level(0).g
      return smoothstep(COV_LO, COV_HI, raw)
    }

    // Analytic hurricane column, evaluated at a shell DIRECTION + height h.
    // Eye = a real 0-density hole; eyewall = tall bright ring; core = dense
    // overshoot; feeder bands = log-spiral. Ported from storms.js.
    const hurricaneAt = (dir, h) => {
      const cosA = dot(dir, u.stormDir).clamp(-1, 1)
      const r = acos(cosA).div(STORM_ANG_R).toVar()
      // azimuth in the storm's local tangent frame, rotated by the live spin
      const az = atan(dot(dir, u.stormFwd), dot(dir, u.stormRight)).add(u.stormSpin)

      const rSafe = max(r, float(0.001))

      // disc / eyewall (discDensity)
      const intoWall = smoothstep(EYE_R, EYE_R + 0.02, r)
      const wallBump = exp(
        r
          .sub((EYE_R + WALL_R) * 0.5)
          .div(0.032)
          .pow(2)
          .negate(),
      ).mul(0.4)
      const discMask = smoothstep(CORE_R, CORE_R + CORE_SOFT, r).oneMinus()
      const discD = intoWall.mul(discMask.mul(0.85).add(wallBump)).clamp(0, 1)

      // log-spiral feeder bands (bandDensity)
      const phase = az.sub(u.stormSign.mul(ARM_TIGHTNESS).mul(log(rSafe)))
      const shape = phase.mul(ARM_COUNT).sin().max(0).pow(ARM_SHARPNESS)
      const riseTaper = smoothstep(WALL_R, CORE_R + 0.02, r)
      const fallT = r
        .sub(CORE_R)
        .div(BAND_OUTER - CORE_R)
        .clamp(0, 1)
      const fallTaper = fallT.oneMinus().pow(0.9)
      const bandD = shape.mul(1.2).clamp(0, 1).mul(riseTaper).mul(fallTaper)

      // vertical profiles: overshoot column is tall; bands are lower cumulus.
      const discHeight = smoothstep(0, 0.1, h).mul(smoothstep(0.9, 1.0, h).oneMinus())
      const bandHeight = smoothstep(0, 0.15, h).mul(smoothstep(0.45, 0.75, h).oneMinus())

      // r>1 (outside the storm) contributes nothing.
      const inStorm = smoothstep(1.02, 0.98, r)
      return max(discD.mul(discHeight), bandD.mul(bandHeight)).mul(inStorm)
    }

    // Full density: max(ambient, hurricane). Used by the primary march.
    const densityAt = (p) => {
      const len = length(p)
      const h = len.sub(R_IN).div(SHELL_H).clamp(0, 1)
      const dir = p.div(len)

      const cov = coverageAt(dir)
      const ambHeight = smoothstep(0, 0.15, h).mul(smoothstep(0.55, 1.0, h).oneMinus())
      const detail = mx_fractal_noise_float(p.mul(DETAIL_FREQ).add(u.drift), 3, 2.0, 0.5).mul(0.5).add(0.5)
      const amb = cov
        .mul(ambHeight)
        .sub(detail.mul(EROSION).mul(cov.oneMinus()))
        .clamp(0, 1)
        .mul(u.ambient)
        .mul(u.ambientFade)

      const hur = hurricaneAt(dir, h).mul(u.stormStrength).mul(u.stormFade)
      return max(amb, hur)
    }

    // Cheaper density for the shadow/light march (no erosion, no bands) — keeps
    // the nested loop affordable.
    const densityLight = (p) => {
      const len = length(p)
      const h = len.sub(R_IN).div(SHELL_H).clamp(0, 1)
      const dir = p.div(len)
      const cov = coverageAt(dir)
      const ambHeight = smoothstep(0, 0.15, h).mul(smoothstep(0.55, 1.0, h).oneMinus())
      const amb = cov.mul(ambHeight).mul(u.ambient).mul(u.ambientFade)
      const hur = hurricaneAt(dir, h).mul(u.stormStrength).mul(u.stormFade)
      return max(amb, hur)
    }

    const march = Fn(() => {
      const out = vec4(0, 0, 0, 0).toVar()

      const depth = sampleDepth(uvNode)
      const viewPos = getViewPosition(uvNode, depth, u.projInverse)
      const worldHit = u.cameraMatrixWorld.mul(vec4(viewPos, 1)).xyz
      const ro = u.cameraPosition
      const toHit = worldHit.sub(ro)
      const tMax = length(toHit)
      const rd = toHit.div(max(tMax, float(1e-5)))

      // Ray vs outer shell sphere (planet centred at origin, radius 1).
      const b = dot(ro, rd)
      const c = dot(ro, ro).sub(R_OUT * R_OUT)
      const disc = b.mul(b).sub(c)

      If(disc.greaterThan(0), () => {
        const sq = disc.sqrt()
        const tNear = max(b.negate().sub(sq), float(0)).toVar()
        const tFar = min(b.negate().add(sq), tMax).toVar()

        If(tFar.greaterThan(tNear), () => {
          const STEPS = 32
          const segLen = tFar.sub(tNear)
          const stepLen = segLen.div(STEPS)
          const jitter = interleavedGradientNoise(screenCoordinate.add(u.frameJitter))
          const t = tNear.add(stepLen.mul(jitter)).toVar()

          const trans = float(1).toVar()
          const col = vec3(0).toVar()

          Loop(STEPS, () => {
            const p = ro.add(rd.mul(t))
            const dens = densityAt(p).toVar()

            If(dens.greaterThan(0.001), () => {
              // Beer light march: a few short steps toward the sun.
              const LSTEPS = 4
              const lStep = SHELL_H / LSTEPS
              const lp = p.add(u.sunDir.mul(lStep * 0.5)).toVar()
              const lDens = float(0).toVar()
              Loop(LSTEPS, () => {
                lDens.addAssign(densityLight(lp))
                lp.addAssign(u.sunDir.mul(lStep))
              })
              const lightTrans = exp(lDens.mul(lStep).mul(u.extinction).negate())
              // powder: dark cauliflower edges from local density.
              const powder = dens.mul(2.0).negate().exp().oneMinus()
              const lightEnergy = u.sunColor
                .mul(lightTrans)
                .mul(powder.mul(0.85).add(0.15))
                .add(u.ambientFill.mul(0.35))

              const sigmaT = dens.mul(u.extinction)
              const sampleTrans = exp(sigmaT.mul(stepLen).negate())
              col.addAssign(lightEnergy.mul(trans).mul(sampleTrans.oneMinus()))
              trans.mulAssign(sampleTrans)
            })

            t.addAssign(stepLen)
            If(trans.lessThan(0.02), () => {
              Break()
            })
          })

          out.assign(vec4(col.min(vec3(1, 1, 1)), trans.oneMinus()))
        })
      })

      return out
    })

    this._material.fragmentNode = march().context(builder.getSharedContext())
    this._material.needsUpdate = true

    return this._textureNode
  }

  dispose() {
    this._rt.dispose()
    this._material.dispose()
  }
}

// Shared quad + scratch (module-level, like GodraysNode — this app builds one
// clouds node).
const _quad = new QuadMesh()
const _scratchSize = new THREE.Vector2()

/**
 * Build the volumetric clouds post node.
 *
 * @param {PassNode} scenePass - the beauty pass (`pass(scene, camera)`).
 * @param {Camera} camera
 * @param {Object} deps
 * @param {(out:THREE.Vector3)=>THREE.Vector3} deps.getSunDir
 * @param {{getPrimary:(out:THREE.Vector3)=>number}} deps.storms
 * @param {Object} [deps.planet] - unused today; reserved for future ocean-colour tint.
 * @param {Object} [deps.sky] - unused directly; coverage comes via getCloudShadowUniforms().
 * @returns {{ node: CloudsNode, compositeOver:(sceneColor:Node)=>Node, update:(dt:number, camera:Camera)=>void, setMode:(m:string)=>void, getWeatherHandles:()=>Object }}
 */
export function createVolumetricClouds(scenePass, camera, { getSunDir, storms, planet, sky } = {}) {
  void planet
  void sky

  // A 1×1 fallback so the sampler is always valid even before sky.update()
  // publishes the real alphaMap into the shared cloud-shadow node.
  const blankTex = new THREE.DataTexture(_blankData, 1, 1)
  blankTex.needsUpdate = true

  const u = {
    // camera (matrices are held by reference — three updates them in place)
    cameraMatrixWorld: uniform(camera.matrixWorld),
    projInverse: uniform(camera.projectionMatrixInverse),
    cameraPosition: uniform(new THREE.Vector3()),
    cameraNear: uniform(camera.near),
    cameraFar: uniform(camera.far),
    // weather map (own nodes; .value copied from the shared shadow contract)
    weatherTex: texture(blankTex),
    weatherMat: uniform(new THREE.Matrix3()),
    // lighting
    sunDir: uniform(new THREE.Vector3(1, 0.45, 0.9).normalize()),
    sunColor: uniform(SUN_COLOR.clone()),
    ambientFill: uniform(AMBIENT_FILL.clone()),
    extinction: uniform(60), // density→optical-depth scale (tuning handle)
    // animation
    drift: uniform(new THREE.Vector3()),
    frameJitter: uniform(0),
    // storm frame
    stormDir: uniform(new THREE.Vector3(1, 0, 0)),
    stormRight: uniform(new THREE.Vector3(0, 0, 1)),
    stormFwd: uniform(new THREE.Vector3(0, 1, 0)),
    stormSpin: uniform(0),
    stormSign: uniform(1),
    stormStrength: uniform(0),
    // fades + mode toggles
    ambient: uniform(1), // 1 = full-sky ambient deck, 0 = hurricane-only fallback
    stormMul: uniform(1), // 1 = hurricane on, 0 = off
    ambientFade: uniform(1),
    stormFade: uniform(1),
  }

  const depthNode = scenePass.getTextureNode('depth')
  const node = new CloudsNode(depthNode, camera, u)

  // The shared cloud-shadow contract from sky.js: uCloudTex.value is the lower
  // deck's alphaMap (the coverage field), uCloudMat.value is the world→shell
  // rotation. Both are refreshed every frame in sky.update(), which runs before
  // clouds.update() in the main loop — so copying here is always current.
  const shadow = getCloudShadowUniforms()

  // Hoisted scratch — no per-frame allocation.
  const _sun = new THREE.Vector3()
  const _stormDir = new THREE.Vector3()
  const _right = new THREE.Vector3()
  const _fwd = new THREE.Vector3()
  const _up = new THREE.Vector3(0, 1, 0)
  const _altUp = new THREE.Vector3(1, 0, 0)
  const _driftAxis = new THREE.Vector3(0.3, 1, 0.15).normalize()

  let driftTime = 0
  let frameCounter = 0

  function update(dt, cam = camera) {
    // Camera: ensure world matrix is current, then publish position.
    cam.updateMatrixWorld()
    u.cameraPosition.value.setFromMatrixPosition(cam.matrixWorld)
    u.cameraNear.value = cam.near
    u.cameraFar.value = cam.far

    // Weather map: mirror the shared shadow contract (identical field + drift).
    if (shadow.uCloudTex.value) u.weatherTex.value = shadow.uCloudTex.value
    u.weatherMat.value.copy(shadow.uCloudMat.value)

    // Sun.
    if (getSunDir) {
      getSunDir(_sun)
      u.sunDir.value.copy(_sun)
    }

    // Deck drift.
    driftTime += dt
    u.drift.value.copy(_driftAxis).multiplyScalar(driftTime * DRIFT_SPEED * 60)

    // Anti-banding temporal jitter — a benign sub-pixel dither derived from a
    // frame COUNTER (never Math.random/Date.now); reads no world state.
    frameCounter = (frameCounter + 1) % 1024
    u.frameJitter.value = frameCounter * 0.618

    // Hurricane: getPrimary() gives dir + strength; reconstruct the spin frame.
    const strength = storms && storms.getPrimary ? storms.getPrimary(_stormDir) : 0
    u.stormStrength.value = (strength || 0) * u.stormMul.value
    if (strength) {
      _stormDir.normalize()
      u.stormDir.value.copy(_stormDir)
      // Tangent basis at the eye (any consistent one — the pattern is rotated
      // by stormSpin, so the absolute azimuth origin is arbitrary).
      const up = Math.abs(_stormDir.y) < 0.99 ? _up : _altUp
      _right.crossVectors(up, _stormDir).normalize()
      _fwd.crossVectors(_stormDir, _right).normalize()
      u.stormRight.value.copy(_right)
      u.stormFwd.value.copy(_fwd)
      // Cyclonic spin sign from latitude (matches storms.js: dir.y ≥ 0 → +1).
      const sign = _stormDir.y >= 0 ? 1 : -1
      u.stormSign.value = sign
      u.stormSpin.value += SPIN_RATE * sign * dt
    }

    // Camera-distance fades.
    const dist = cam.position.length()
    u.ambientFade.value = smoothstepJS(AMBIENT_FADE_NEAR, AMBIENT_FADE_FAR, dist)
    u.stormFade.value = smoothstepJS(STORM_FADE_NEAR, STORM_FADE_FAR, dist)
  }

  // Composite the (bilinearly-upsampled) quarter-res cloud result over the
  // beauty pass, before bloom. Occlusion is already handled inside the march
  // (tFar is clamped to the beauty depth), so a straight over-blend by cloud
  // alpha is correct; we keep the scene's own alpha.
  function compositeOver(sceneColor) {
    const c = node.getTextureNode().sample(uv())
    return vec4(mix(sceneColor.rgb, c.rgb, c.a), sceneColor.a)
  }

  // Fallback ladder (spec §6). 'full' = full-sky volumetric deck (architect
  // should hide the 2.5D shells via sky.setCloudsVisible(false)); 'hurricane'
  // = volumetric hurricane only, keep the 2.5D ambient shells; 'off' = nothing.
  function setMode(mode) {
    if (mode === 'hurricane') {
      u.ambient.value = 0
      u.stormMul.value = 1
    } else if (mode === 'off') {
      u.ambient.value = 0
      u.stormMul.value = 0
    } else {
      u.ambient.value = 1
      u.stormMul.value = 1
    }
  }

  function getWeatherHandles() {
    return u
  }

  return { node, compositeOver, update, setMode, getWeatherHandles }
}
