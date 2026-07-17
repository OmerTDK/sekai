// Camera-local snow/rain: precipitation particles only exist in a small pool
// recycled around the camera's own surface footprint -- the standard
// open-world "never simulate the whole planet" trick. WHERE it precipitates
// comes from the sky's already-baked cloud coverage (read CPU-side via
// sky.sampleCloudCover -- see sky.js), gated by a handful of large, slowly
// drifting seeded "front" cells whose strength pulses over real minutes, so
// weather reads as moody systems drifting through rather than a uniform haze
// of drizzle. WHAT falls (rain vs snow) comes from planet.biomeAt at the
// camera's own footprint: polar or high-altitude ground gets snow, sea level
// elsewhere gets rain, blended continuously across the transition.
import * as THREE from 'three/webgpu'
import {
  attribute,
  uniform,
  uv,
  vec2,
  mix,
  smoothstep as nodeSmoothstep,
  length as nodeLength,
  max as nodeMax,
  abs as nodeAbs,
} from 'three/tsl'
import { SEA_LEVEL, rngFromString, makeNoise3D, fbm, clamp, lerp, smoothstep } from './util.js'

const TWO_PI = Math.PI * 2

// M-WX plan / ART.md pinned constants: terrain never exceeds this radius
// (planet.js's own HEIGHT_MAX, not exported -- mirrored here per the plan's
// "Height/shell budget" section, which hands builders this exact number
// rather than having each one reach into planet.js internals). The lower
// cloud shell sits at 1.075 (sky.js); precipitation spawns strictly below it
// so rain/snow never appears to fall from above the visible deck.
const TERRAIN_HEIGHT_MAX = 1.06
const CLOUD_BASE_CLEARANCE = 1.075 - 0.006

// --- pool + camera-local activation ----------------------------------------
const POOL_SIZE = 2000
const CAMERA_ACTIVE_DIST = 1.7 // camera.position.length() must be below this for weather to run at all
const CAMERA_FADE_START = 1.55 // opacity eases to 0 approaching CAMERA_ACTIVE_DIST -- never pops off
const PATCH_RADIUS = 0.22 // rad -- local disk around the camera footprint particles spawn within
const REBASE_DOT = Math.cos(PATCH_RADIUS * 1.6) // particles that drift/teleport this far from camDir respawn immediately

// --- per-particle fall -------------------------------------------------------
const GROUND_GAP = 0.004 // particles recycle this far above sampled terrain/sea height
const SPAWN_GAP_MIN = 0.015 // spawn altitude above ground, before the CLOUD_BASE_CLEARANCE clamp
const SPAWN_GAP_MAX = 0.05
const RAIN_FALL_SPEED = 0.09 // radius units/sec
const SNOW_FALL_SPEED = 0.014
const SPEED_JITTER = 0.25 // +/- fraction, per particle
const FADE_FRACTION = 0.15 // fraction of a fall spent easing alpha in (start) / out (end) -- cells never pop
const WANDER_AMP = 0.006 // world units -- snow's lateral wander amplitude
const WANDER_FREQ = 0.6 // rad/sec
const SLANT_AMT = 0.012 // world units -- rain's constant lateral bias (wind slant)

// --- where it precipitates: cloud cover + fronts + the ocean rule ----------
const COVER_THRESHOLD = 0.55
const COVER_EDGE = 0.1
const OCEAN_COVER_THRESHOLD = 0.78
const OCEAN_COVER_EDGE = 0.08
const OCEAN_DENSITY_MULT = 0.5 // "use lower density" over open ocean, per the M-WX brief

const FRONT_COUNT_MIN = 2
const FRONT_COUNT_MAX = 4
const FRONT_RADIUS_MIN = 0.35 // rad -- "large" cells
const FRONT_RADIUS_MAX = 0.65
const FRONT_DRIFT_RATE = 0.0015 // rad/sec along each front's own great circle (cf. storms.js DRIFT_RATE=0.0025)
const FRONT_WOBBLE_GAIN = 10 // how sharply fbm bends the drift heading (cf. storms.js DRIFT_WOBBLE_GAIN=14)
const FRONT_WOBBLE_SCALE = 3
const FRONT_PULSE_PERIOD_MIN = 150 // seconds ("minutes") -- one front's mood cycle
const FRONT_PULSE_PERIOD_MAX = 320

// --- what falls: snow vs rain by surface ------------------------------------
// biomeAt().polar > ~0.45 -> snow (M-WX brief's pinned threshold); smoothstep
// edges either side so the transition blends instead of hard-cutting.
const SNOW_POLAR_LO = 0.38
const SNOW_POLAR_HI = 0.52
// "terrain altitude near the top of the range" -> snow; altT is elevation
// above sea level normalized by the land height budget.
const SNOW_ALT_LO = 0.68
const SNOW_ALT_HI = 0.85

// --- rendering (muted per ART.md -- atmosphere, not spectacle) -------------
const RAIN_SIZE_PX = 7 // PointsMaterial-style screen-space size, no attenuation -- matches world.js's spark/plume pools
const SNOW_SIZE_PX = 4.5
const MAX_ALPHA_RAIN = 0.5
const MAX_ALPHA_SNOW = 0.65
const RAIN_COLOR_HEX = '#a7b7c8' // cool pale grey-blue, never saturated
const SNOW_COLOR_HEX = '#edf2f6' // matches planet.js's own COLOR_SNOW exactly

// The original raw vertex shader set gl_PointSize directly in framebuffer
// pixels (no DPR factor). PointsNodeMaterial's sprite path multiplies the
// sizeNode by screenDPR (= renderer.getPixelRatio(); see three's
// setupVertexSprite -> `pointSize = pointSize.mul(screenDPR)`), which on a
// retina display would render precipitation ~DPR-times too large vs the
// pre-port build. This app's renderer pins its ratio to
// Math.min(devicePixelRatio, 2) (main.js setPixelRatio) but createWeather
// isn't handed the renderer, so mirror that exact expression here and divide
// sizeNode by it, cancelling the sprite path's multiply so on-screen size
// matches the original 1:1 (on DPR=1 this is a no-op).
const DPR = Math.min((typeof window !== 'undefined' && window.devicePixelRatio) || 1, 2)

// M3 TSL port (was one hand-rolled raw-GLSL material -- this app's other
// custom-shader work all extends an existing standard material via a GLSL
// injection hook, which WebGPURenderer silently ignores rather than
// erroring; a raw custom-shader material errors outright -- see
// docs/spikes/2026-07-17-s1-tsl-webgpu.md).
//
// Can't port straight to `THREE.Points` + `PointsNodeMaterial`: under this
// app's exact host (WebGPURenderer({forceWebGL:true}), whose WebGL2 fallback
// runs on GLSLNodeBuilder), every vertex shader generated for that builder
// unconditionally ends with `gl_PointSize = 1.0;` (see
// node_modules/three/src/renderers/webgl-fallback/nodes/GLSLNodeBuilder.js,
// `_getGLSLVertexCode`) -- sizeNode has no effect on a real Points primitive.
// PointsNodeMaterial's own class doc confirms this is by design (WebGPU point
// primitives are hardware-fixed at 1px) and names the sanctioned workaround:
// drive the material from an instanced quad instead of a Points primitive.
// The gate is `object.isPoints` (see PointsNodeMaterial.setupVertex) -- an
// InstancedMesh of a 1x1 quad takes the *sprite* billboard path instead
// (setupVertexSprite), where sizeNode is fully honored. Translation drives
// through the iPosition attribute below rather than instanceMatrix/
// setMatrixAt, matching the class doc's own instanced-sprite recipe.
//
// Rain streaks are a classic point-sprite fake, ported 1:1: the quad's own
// uv() (this material's gl_PointCoord equivalent) is rotated per-fragment by
// uDownAngle (the on-screen projection of the local "down" direction,
// computed once per frame in update() from the camera's own live
// quaternion -- see the comment there) and shaped into a thin capsule; snow
// is the same quad shaped into a soft round flake instead. aSnowT blends
// shape AND color continuously per-particle, so a rain/snow boundary (e.g. a
// mountain snowline) transitions smoothly rather than popping between two
// pools.
//
// NOTE: uv()'s v axis is a plain, non-flipped geometry uv (0 at the quad's
// -Y edge, 1 at +Y) -- unlike gl_PointCoord, whose v is flipped (0 at the
// top on screen, per the WebGL/GLSL spec). The original formula was written
// against gl_PointCoord's flipped v, so the local y is negated once below
// (see uvC) to reproduce the exact same rotated shape the original fragment
// shader computed.
const QUAD_POSITIONS = new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0])
const QUAD_UVS = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1])
const QUAD_INDEX = [0, 1, 2, 0, 2, 3]

export function createWeather(planet, sky, seed) {
  const group = new THREE.Group()

  // --- front cells: deterministic, slowly drifting "weather mood" state ---
  const frontNoise = makeNoise3D(seed + ':wx:front-drift')
  const frontCountRng = rngFromString(seed + ':wx:front-count')
  const frontCount = FRONT_COUNT_MIN + Math.floor(frontCountRng() * (FRONT_COUNT_MAX - FRONT_COUNT_MIN + 1))
  const fronts = []
  for (let i = 0; i < frontCount; i++) fronts.push(makeFrontCell(seed, i))

  // --- particle pool: CPU-only physics state (typed arrays, no GC churn) --
  const pDirX = new Float32Array(POOL_SIZE)
  const pDirY = new Float32Array(POOL_SIZE)
  const pDirZ = new Float32Array(POOL_SIZE)
  const pTanX = new Float32Array(POOL_SIZE)
  const pTanY = new Float32Array(POOL_SIZE)
  const pTanZ = new Float32Array(POOL_SIZE)
  const pRadius = new Float32Array(POOL_SIZE)
  const pSpawnR = new Float32Array(POOL_SIZE)
  const pGroundR = new Float32Array(POOL_SIZE)
  const pFallSpeed = new Float32Array(POOL_SIZE)
  const pSnowT = new Float32Array(POOL_SIZE)
  const pSeed = new Float32Array(POOL_SIZE)
  // pRadius/pGroundR both start at 0 -- every particle looks "already on the
  // ground" -- so the first active frame's update loop below respawns the
  // whole pool in one pass; no separate init-time spawn loop is needed.

  // --- GPU-facing attributes (rewritten every active frame) ---------------
  const posArr = new Float32Array(POOL_SIZE * 3)
  const alphaArr = new Float32Array(POOL_SIZE)
  const snowTArr = new Float32Array(POOL_SIZE)
  const seedArr = new Float32Array(POOL_SIZE)

  // Shared 1x1 quad, instanced once per pool slot -- see the port comment
  // above for why this replaces a THREE.Points primitive under this app's
  // TSL host. `position`/`uv` are the quad's own per-vertex shape (shared by
  // every instance); `iPosition`/`aAlpha`/`aSnowT`/`aSeed` are per-instance.
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(QUAD_POSITIONS, 3))
  geometry.setAttribute('uv', new THREE.BufferAttribute(QUAD_UVS, 2))
  geometry.setIndex(QUAD_INDEX)
  geometry.setAttribute('iPosition', new THREE.InstancedBufferAttribute(posArr, 3))
  geometry.setAttribute('aAlpha', new THREE.InstancedBufferAttribute(alphaArr, 1))
  geometry.setAttribute('aSnowT', new THREE.InstancedBufferAttribute(snowTArr, 1))
  geometry.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seedArr, 1))

  // uDownAngle is the only uniform written after creation (every active
  // frame, from the camera's live quaternion -- see update() below); the
  // rest are fixed for this pool's lifetime, kept as uniform() handles
  // (rather than baked-in constants) to mirror the original shader's own
  // uniform set 1:1.
  const uDownAngle = uniform(0)
  const uRainSize = uniform(RAIN_SIZE_PX)
  const uSnowSize = uniform(SNOW_SIZE_PX)
  const uRainColor = uniform(new THREE.Color(RAIN_COLOR_HEX))
  const uSnowColor = uniform(new THREE.Color(SNOW_COLOR_HEX))

  const aAlphaNode = attribute('aAlpha', 'float')
  const aSnowTNode = attribute('aSnowT', 'float')
  const aSeedNode = attribute('aSeed', 'float')
  const iPositionNode = attribute('iPosition', 'vec3')

  // fract(sin(seed*78.233)*43758.5453) -- same cheap per-particle
  // pseudo-random hash the original vertex shader used for vSizeJitter.
  // Referenced from both the vertex-stage sizeNode and the fragment-stage
  // opacityNode below; TSL auto-inserts the vertex->fragment varying.
  const sizeJitter = aSeedNode.mul(78.233).sin().mul(43758.5453).fract()

  // ONE draw call for all precipitation -- rain and snow both live in this
  // same pool/material, blended per-particle via aSnowT rather than split
  // into two pools/materials.
  const material = new THREE.PointsNodeMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.NormalBlending, // never additive -- ART.md: snow/rain must never glow
    sizeAttenuation: false, // PointsMaterial-style screen-space size, no distance falloff (matches original)
    alphaToCoverage: false, // keep this material on plain alpha blending, not MSAA coverage dithering
  })
  material.positionNode = iPositionNode
  // .div(DPR) cancels the sprite path's `pointSize.mul(screenDPR)` so the
  // on-screen size matches the original raw-shader gl_PointSize -- see DPR above.
  material.sizeNode = mix(uRainSize, uSnowSize, aSnowTNode).mul(sizeJitter.mul(0.5).add(0.75)).div(DPR)

  // uvC: gl_PointCoord-equivalent local coordinate, y-negated -- see the
  // port comment above for why.
  const uvC = vec2(uv().x.sub(0.5), uv().y.sub(0.5).negate())
  const ca = uDownAngle.cos()
  const sa = uDownAngle.sin()
  const rx = uvC.x.mul(ca).add(uvC.y.mul(sa))
  const ry = uvC.x.mul(sa).negate().add(uvC.y.mul(ca))

  // Rain: soft capsule stretched along the rotated axis (aligned to the
  // on-screen projection of the local down direction -- see uDownAngle).
  const capLen = nodeLength(vec2(rx, nodeMax(nodeAbs(ry).sub(0.32), 0))).div(0.15)
  const streakA = nodeSmoothstep(0.65, 1.0, capLen).oneMinus()

  // Snow: soft round flake, slightly larger falloff so it reads as fluffier.
  const roundD = nodeLength(uvC).div(sizeJitter.mul(0.06).add(0.4))
  const roundA = nodeSmoothstep(0.55, 1.0, roundD).oneMinus()

  const shape = mix(streakA, roundA, aSnowTNode)

  material.colorNode = mix(uRainColor, uSnowColor, aSnowTNode)
  material.opacityNode = shape.mul(aAlphaNode)

  const points = new THREE.InstancedMesh(geometry, material, POOL_SIZE)
  points.frustumCulled = false // the pool's bounding sphere is never recomputed; it moves with the camera every frame
  // instanceMatrix itself is unused -- translation comes from the iPosition
  // attribute above (positionNode), per PointsNodeMaterial's own instanced-
  // sprite recipe -- seeded to identity once so it's never a degenerate/zero
  // transform (defensive; not per-frame, so free under the build-once law).
  const _identityMatrix = new THREE.Matrix4()
  for (let i = 0; i < POOL_SIZE; i++) points.setMatrixAt(i, _identityMatrix)
  points.instanceMatrix.needsUpdate = true
  group.add(points)

  let spawnCounter = 0
  let simTime = 0
  let ambientSnowT = 0
  let coverageWarned = false

  // Per-frame scratch (reused every call -- zero per-frame allocation).
  const _camDir = new THREE.Vector3()
  const _camTan1 = new THREE.Vector3()
  const _camTan2 = new THREE.Vector3()
  const _camRight = new THREE.Vector3()
  const _camUp = new THREE.Vector3()
  const _downVec = new THREE.Vector3()
  const _biome = {}
  const _spawnDir = new THREE.Vector3()
  const _spawnTan1 = new THREE.Vector3()
  const _spawnTan2 = new THREE.Vector3()

  // sky.sampleCloudCover is this module's one cross-file contract point;
  // degrade (precipitation simply never triggers) rather than throw if a
  // future refactor ever breaks it.
  function safeCoverage(dir) {
    if (typeof sky.sampleCloudCover !== 'function') {
      if (!coverageWarned) {
        coverageWarned = true
        console.warn('[planet] weather: sky.sampleCloudCover unavailable — precipitation disabled')
      }
      return 0
    }
    return sky.sampleCloudCover(dir)
  }

  // Front cells modulate WHERE cloud-gated precipitation actually happens:
  // max across cells (not additive -- overlapping fronts don't double up),
  // each contributing a spatial falloff around its own center times a
  // temporal strength that beats between two seeded sine waves (a plain
  // single sine would repeat identically every period; this reads less
  // metronomic for near-zero extra cost).
  function evalFrontMod(dir) {
    let m = 0
    for (const f of fronts) {
      const ang = Math.acos(clamp(dir.dot(f.dir), -1, 1))
      const falloff = 1 - smoothstep(f.radius * 0.5, f.radius, ang)
      if (falloff <= 0) continue
      const phase = (simTime / f.pulsePeriod) * TWO_PI
      const s1 = Math.sin(phase + f.pulsePhase)
      const s2 = Math.sin(phase * f.secondaryRatio + f.secondaryPhase)
      const strength = clamp(0.5 + 0.35 * s1 + 0.15 * s2, 0, 1)
      const v = falloff * strength
      if (v > m) m = v
    }
    return m
  }

  // Drifts each front's center along its own slowly-wobbling great circle --
  // same technique as storms.js's hurricane drift, just slower/gentler.
  // Always runs (even when the camera is far away/inactive below), so
  // fronts keep moving in the background exactly like the hurricane does.
  function updateFronts(dt) {
    for (const f of fronts) {
      const turn =
        fbm(
          frontNoise,
          f.dir.x * FRONT_WOBBLE_SCALE + f.nx,
          f.dir.y * FRONT_WOBBLE_SCALE + f.ny,
          f.dir.z * FRONT_WOBBLE_SCALE + f.nz,
          3,
        ) *
        FRONT_WOBBLE_GAIN *
        FRONT_DRIFT_RATE *
        dt
      f.axis.applyAxisAngle(f.dir, turn)
      f.dir.applyAxisAngle(f.axis, FRONT_DRIFT_RATE * dt).normalize()
    }
  }

  // Respawns particle slot `i` at a fresh position within PATCH_RADIUS of
  // the current camera footprint (_camDir/_camTan1/_camTan2, set once per
  // frame in update() below). rngFromString per spawn (not a persistent
  // stream) mirrors wind.js/storms.js's own respawn convention.
  function respawnParticle(i) {
    const rng = rngFromString(seed + ':wx:p:' + spawnCounter++)
    const rho = PATCH_RADIUS * Math.sqrt(rng())
    const theta = rng() * TWO_PI
    _spawnDir
      .copy(_camDir)
      .addScaledVector(_camTan1, Math.cos(theta) * rho)
      .addScaledVector(_camTan2, Math.sin(theta) * rho)
      .normalize()

    const ground = planet.isLand(_spawnDir) ? planet.sampleHeight(_spawnDir) : SEA_LEVEL
    const groundR = ground + GROUND_GAP
    const gap = lerp(SPAWN_GAP_MIN, SPAWN_GAP_MAX, rng())
    const spawnR = Math.max(Math.min(groundR + gap, CLOUD_BASE_CLEARANCE), groundR + 0.002)

    tangentBasis(_spawnDir, _spawnTan1, _spawnTan2)
    const wanderAngle = rng() * TWO_PI
    const ct = Math.cos(wanderAngle)
    const st = Math.sin(wanderAngle)

    pDirX[i] = _spawnDir.x
    pDirY[i] = _spawnDir.y
    pDirZ[i] = _spawnDir.z
    pTanX[i] = _spawnTan1.x * ct + _spawnTan2.x * st
    pTanY[i] = _spawnTan1.y * ct + _spawnTan2.y * st
    pTanZ[i] = _spawnTan1.z * ct + _spawnTan2.z * st
    pGroundR[i] = groundR
    pSpawnR[i] = spawnR
    pRadius[i] = spawnR
    pSnowT[i] = ambientSnowT
    pFallSpeed[i] =
      lerp(RAIN_FALL_SPEED, SNOW_FALL_SPEED, ambientSnowT) * (1 + (rng() * 2 - 1) * SPEED_JITTER)
    pSeed[i] = rng()
  }

  function update(dt, camera) {
    simTime += dt
    updateFronts(dt)

    const dist = camera.position.length()
    const active = dist < CAMERA_ACTIVE_DIST
    group.visible = active
    if (!active) return // precipitation is a surface-level detail; skip the pool work below

    _camDir.copy(camera.position).normalize()
    tangentBasis(_camDir, _camTan1, _camTan2)

    // Ambient evaluation: ONE sample per frame at the camera's own
    // footprint, not per-particle -- planet.biomeAt is explicitly documented
    // as too costly for per-frame/per-call use (planet.js), so every spawn
    // this frame shares this frame's single reading. The patch is small
    // (PATCH_RADIUS ~0.22 rad) so this is a fair approximation.
    const coverage = safeCoverage(_camDir)
    const coverGate = smoothstep(COVER_THRESHOLD - COVER_EDGE, COVER_THRESHOLD + COVER_EDGE, coverage)
    const frontMod = evalFrontMod(_camDir)
    const overOcean = !planet.isLand(_camDir)
    let gate = coverGate
    let densityMult = 1
    if (overOcean) {
      gate *= smoothstep(
        OCEAN_COVER_THRESHOLD - OCEAN_COVER_EDGE,
        OCEAN_COVER_THRESHOLD + OCEAN_COVER_EDGE,
        coverage,
      )
      densityMult = OCEAN_DENSITY_MULT
    }
    const camFade = 1 - smoothstep(CAMERA_FADE_START, CAMERA_ACTIVE_DIST, dist)
    const ambientIntensity = gate * frontMod * densityMult * camFade

    planet.biomeAt(_camDir, _biome)
    const altT = clamp((_biome.h - SEA_LEVEL) / (TERRAIN_HEIGHT_MAX - SEA_LEVEL), 0, 1)
    const snowFromPolar = smoothstep(SNOW_POLAR_LO, SNOW_POLAR_HI, _biome.polar)
    const snowFromAlt = smoothstep(SNOW_ALT_LO, SNOW_ALT_HI, altT)
    ambientSnowT = clamp(Math.max(snowFromPolar, snowFromAlt), 0, 1)

    // Screen-space angle of the local "down" direction, for the shader's
    // streak rotation -- derived from the camera's own LIVE quaternion,
    // never matrixWorld/matrixWorldInverse (those lag a frame behind this
    // update() call -- see sky.js's cloud-shadow contract comment for the
    // same trap already paid for once in this codebase).
    _camRight.set(1, 0, 0).applyQuaternion(camera.quaternion)
    _camUp.set(0, 1, 0).applyQuaternion(camera.quaternion)
    _downVec.copy(_camDir).multiplyScalar(-1)
    const sx = _downVec.dot(_camRight)
    const sy = _downVec.dot(_camUp)
    uDownAngle.value = Math.atan2(sy, sx) - Math.PI / 2

    for (let i = 0; i < POOL_SIZE; i++) {
      // Recycle on reaching ground OR on drifting too far from the (moving)
      // camera footprint -- the latter handles both ordinary camera travel
      // and a hard cut/teleport (click-to-visit swoop) gracefully.
      const camAlign = pDirX[i] * _camDir.x + pDirY[i] * _camDir.y + pDirZ[i] * _camDir.z
      if (pRadius[i] <= pGroundR[i] || camAlign < REBASE_DOT) {
        respawnParticle(i)
      } else {
        pRadius[i] -= pFallSpeed[i] * dt
      }

      const span = pSpawnR[i] - pGroundR[i]
      const fallT = span > 1e-6 ? clamp((pSpawnR[i] - pRadius[i]) / span, 0, 1) : 1
      const fadeIn = smoothstep(0, FADE_FRACTION, fallT)
      const fadeOut = 1 - smoothstep(1 - FADE_FRACTION, 1, fallT)
      const wobble = Math.sin(simTime * WANDER_FREQ + pSeed[i] * TWO_PI) * WANDER_AMP * pSnowT[i]
      const slant = SLANT_AMT * (1 - pSnowT[i])
      const lateral = wobble + slant

      const i3 = i * 3
      posArr[i3] = pDirX[i] * pRadius[i] + pTanX[i] * lateral
      posArr[i3 + 1] = pDirY[i] * pRadius[i] + pTanY[i] * lateral
      posArr[i3 + 2] = pDirZ[i] * pRadius[i] + pTanZ[i] * lateral

      const maxAlpha = lerp(MAX_ALPHA_RAIN, MAX_ALPHA_SNOW, pSnowT[i])
      alphaArr[i] = fadeIn * fadeOut * ambientIntensity * maxAlpha
      snowTArr[i] = pSnowT[i]
      seedArr[i] = pSeed[i]
    }

    geometry.attributes.iPosition.needsUpdate = true
    geometry.attributes.aAlpha.needsUpdate = true
    geometry.attributes.aSnowT.needsUpdate = true
    geometry.attributes.aSeed.needsUpdate = true
  }

  return { group, update }
}

// --- seeded/geometric helpers (module-level, mirroring wind.js/storms.js's --
// own local copies of the same small vector-math patterns) -----------------

/** Uniform random point on the unit sphere, Y as the pole axis (this app's
 * convention throughout planet.js/sky.js/storms.js). */
function randomDirection(rng, out = new THREE.Vector3()) {
  const y = rng() * 2 - 1
  const t = rng() * Math.PI * 2
  const r = Math.sqrt(Math.max(0, 1 - y * y))
  return out.set(r * Math.cos(t), y, r * Math.sin(t))
}

/** Deterministic (non-random) orthonormal tangent basis at `dir`: cross with
 * world-up, falling back to world-X within ~18 degrees of the poles to avoid
 * a degenerate cross product (same trick planet.js's own slope estimation
 * and sky.js's bandBasis use). Any actual randomness needed on top of this
 * basis (e.g. a random tangent direction) comes from rotating IN this plane
 * with a seeded angle, not from randomizing which basis gets built. */
const TB_UP_Y = new THREE.Vector3(0, 1, 0)
const TB_UP_X = new THREE.Vector3(1, 0, 0)
function tangentBasis(dir, outT1, outT2) {
  const upRef = Math.abs(dir.y) > 0.95 ? TB_UP_X : TB_UP_Y
  outT1.crossVectors(upRef, dir).normalize()
  outT2.crossVectors(dir, outT1).normalize()
}

/** One deterministic front cell: a seeded center + drift heading + radius +
 * a two-sine pulse envelope (period/phase/secondary ratio all seeded). */
function makeFrontCell(seed, index) {
  const rng = rngFromString(`${seed}:wx:front:${index}`)
  const dir = randomDirection(rng)
  const t1 = new THREE.Vector3()
  const t2 = new THREE.Vector3()
  tangentBasis(dir, t1, t2)
  const axisAngle = rng() * TWO_PI
  const axis = new THREE.Vector3()
    .addScaledVector(t1, Math.cos(axisAngle))
    .addScaledVector(t2, Math.sin(axisAngle))
    .normalize()
  return {
    dir,
    axis,
    radius: lerp(FRONT_RADIUS_MIN, FRONT_RADIUS_MAX, rng()),
    pulsePeriod: lerp(FRONT_PULSE_PERIOD_MIN, FRONT_PULSE_PERIOD_MAX, rng()),
    pulsePhase: rng() * TWO_PI,
    secondaryRatio: lerp(1.8, 2.6, rng()),
    secondaryPhase: rng() * TWO_PI,
    nx: rng() * 1000,
    ny: rng() * 1000,
    nz: rng() * 1000,
  }
}
