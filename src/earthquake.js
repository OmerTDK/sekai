// Earthquakes (god-control "shake the ground" + rare ambient tremors): the
// crust jolts at a seeded land epicenter for ~2-3s, sending a visible ripple
// SHOCKWAVE ring expanding across the surface from the epicenter, kicking up a
// puff of DUST/debris, and giving the camera a subtle decaying SHAKE so the
// whole view trembles with the quake. An occasional AMBIENT quake fires on its
// own (seeded, rare -- every few minutes) so the world feels tectonically
// alive with no user input.
//
// Contract (pinned): export function createEarthquakes(planet, camera, seed) ->
//   { group, update(dt), trigger(dirVec3) }.
// trigger(dir) starts one quake at the surface point in direction `dir` (any
// unit-ish Vector3; normalized here). The architect wires a god-controls
// "earthquake" button straight to trigger(raycastDir).
//
// COVENANT: every effect here is additive/decorative and self-heals -- the
// ripple ring grows and fades to nothing, the dust settles and vanishes, and
// the camera offset eases back to zero. Nothing touches, moves, or overwrites
// a session structure; a quake under a settlement rattles the view and throws
// dust over the ground, damaging nothing.
//
// ENGINE: WebGPURenderer(forceWebGL) + TSL NodeMaterials only (no
// ShaderMaterial / onBeforeCompile). TWO draw calls total:
//   1. ONE InstancedMesh ripple-ring pool (MeshBasicNodeMaterial). Each ring
//      is a flat annulus oriented to the surface at its epicenter; its GROWTH
//      and FADE are computed entirely in the node graph from a per-instance
//      stampTime vs a uTime uniform (trails.js's per-instance age recipe), so
//      the shockwave expands + fades with zero per-frame matrix churn.
//   2. ONE Points dust pool (PointsNodeMaterial, normal blending -- soil, not
//      glow), pattern-copied from meteor.js / world.js's shared-FX pool: puffs
//      launched up+out at the epicenter, pulled back down by gravity, fading.
// Camera shake is a tiny additive positional offset applied each frame (no
// mesh, no draw call); see the shake note on update() for wiring order.
//
// DETERMINISM: sim time is accumulated from dt (no Date.now); every random
// choice comes from rngFromString/hash01 keyed off (seed, a launch counter) --
// no Math.random anywhere. Ambient timing is seeded per spawn; epicenters are
// rejection-sampled onto land. No per-frame allocation in update(): all quake
// state, pool buffers, and scratch vectors are preallocated once.
import * as THREE from 'three/webgpu'
import { attribute, uniform, positionGeometry, color, smoothstep as smoothstepNode, float } from 'three/tsl'
import { rngFromString, hash01, clamp, lerp } from './util.js'
import { tangentBasis } from './placement.js'

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------
const MAX_QUAKES = 3 // concurrent quakes (user + ambient); usually 1

// Quake lifetime. Everything (ring, dust, shake) is scoped to ~this window.
const QUAKE_DUR_MIN = 2.1 // seconds a tremor lasts
const QUAKE_DUR_MAX = 3.0

// Ripple shockwave ring (draw call 1). A thin annulus of local radius ~1 that
// the node graph scales outward (RING_START->RING_END x its base world radius)
// and fades over the ring's life. Growth eases fast early (pow<1) so the front
// races out then slows, reading as a real shockwave.
const RING_POOL_SIZE = 12 // ring buffer of concurrent ripples
const RING_SEGMENTS = 48
const RING_INNER = 0.82 // local annulus inner/outer radius (unit ring)
const RING_OUTER = 1.0
const RING_BASE_RADIUS = 0.03 // world radius the unit ring maps to before growth
const RING_START_SCALE = 0.35 // growth multiplier at birth
const RING_END_SCALE = 4.2 // growth multiplier at full expansion
const RING_GROW_POW = 0.55 // <1 => fast early expansion, decelerating front
const RING_LIFE = 2.6 // seconds ring grows + fades
const RING_LIFT = 0.0011 // radial lift above sampleHeight, dodges z-fighting
const RING_FADE_IN = 0.12 // seconds to ramp opacity up
const RING_FADE_POW = 1.6 // tail sharpness of the fade-out
const RING_PEAK_ALPHA = 0.5 // peak opacity of the ring
const RING_COLOR = 0xcdb894 // dusty tan shockwave dust-line
const RING_STAMP_UNSET = -1e6 // sentinel stampTime => fully faded (invisible)

// Dust / debris puff (draw call 2). Soil kicked up at the epicenter: launched
// up along the surface normal + out along a random tangent, pulled back down.
const DUST_POOL_SIZE = 320 // ring buffer; short TTLs keep live set well under
const DUST_PER_QUAKE = 46
const DUST_SIZE_MIN = 0.01
const DUST_SIZE_MAX = 0.028
const DUST_COLOR = [0.42, 0.35, 0.28] // brown-grey soil (normal blending)
const DUST_TTL_MIN = 0.7
const DUST_TTL_MAX = 1.7
const DUST_UP_SPEED = 0.05 // world units/s along the surface normal
const DUST_OUT_SPEED = 0.07 // world units/s along a random tangent
const DUST_GRAVITY = 0.11 // world units/s^2 pull back toward the surface
const DUST_PEAK_ALPHA = 0.55
const DUST_FADE_IN = 0.06 // seconds to ramp a fresh puff up
const DUST_FADE_POW = 1.4 // tail sharpness of the fade-out

// Camera shake. A gentle high-frequency positional jitter, its amplitude
// decaying over the quake, scaled by camera distance (so the felt intensity is
// view-scale-consistent) and by how much the epicenter faces the camera.
const SHAKE_AMP = 0.006 // peak offset as a fraction of camera distance
const SHAKE_AMP_MAX = 0.02 // hard cap on combined amplitude (fraction of dist)
const SHAKE_FREQ = [57.3, 61.7, 53.1] // rad/s per axis -- fast tremor
const SHAKE_DECAY_POW = 2.0 // envelope tail (higher => settles sooner)
const SHAKE_FACING_MIN = 0.3 // shake floor even when epicenter faces away

// Ambient (self-firing) quakes -- rare, seeded.
const AMBIENT_DELAY_MIN = 140 // seconds between ambient quakes
const AMBIENT_DELAY_MAX = 320
const AMBIENT_FIRST_MIN = 45 // first ambient quake lands sooner
const AMBIENT_FIRST_MAX = 95
const LAND_TRIES = 24 // rejection-sample attempts to land an epicenter

// ---------------------------------------------------------------------------
// Module-scope scratch (write-before-read; safe to share -- single-threaded,
// same convention as meteor.js/sealife.js).
// ---------------------------------------------------------------------------
const _t1 = new THREE.Vector3()
const _t2 = new THREE.Vector3()
const _dir = new THREE.Vector3()
const _pos = new THREE.Vector3()
const _rRight = new THREE.Vector3()
const _rFwd = new THREE.Vector3()
const _rBasis = new THREE.Matrix4()
const _rQuat = new THREE.Quaternion()
const _rScale = new THREE.Vector3()
const _rPos = new THREE.Vector3()
const _shake = new THREE.Vector3()
const _camDir = new THREE.Vector3()

/** Deterministic uniform random unit vector from a seeded rng. */
function randomUnit(rng, out) {
  const z = rng() * 2 - 1
  const a = rng() * Math.PI * 2
  const r = Math.sqrt(Math.max(0, 1 - z * z))
  return out.set(r * Math.cos(a), r * Math.sin(a), z)
}

// ---------------------------------------------------------------------------
// createEarthquakes
// ---------------------------------------------------------------------------
export function createEarthquakes(planet, camera, seed) {
  const group = new THREE.Group()

  // --- ripple ring pool (draw call 1) --------------------------------------
  // Unit annulus in the XZ plane (local +Y is the surface normal). Growth +
  // fade live in the node graph; only uTime.value changes per frame.
  const ringGeo = new THREE.RingGeometry(RING_INNER, RING_OUTER, RING_SEGMENTS)
  ringGeo.rotateX(-Math.PI / 2) // default +Z-facing disc -> +Y-facing
  ringGeo.setAttribute(
    'stampTime',
    new THREE.InstancedBufferAttribute(new Float32Array(RING_POOL_SIZE).fill(RING_STAMP_UNSET), 1),
  )
  const ringStampAttr = ringGeo.attributes.stampTime

  const ringMat = new THREE.MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  })
  // stampAge = uTime - stampTime; p is normalized 0..1 over RING_LIFE.
  // growth scales the unit ring outward (fast early via pow<1); opacity ramps
  // in then fades out. Sentinel stampTime => p=1 => fade 0 => invisible.
  const uTime = uniform(0)
  const stampAge = uTime.sub(attribute('stampTime', 'float'))
  const p = stampAge.div(RING_LIFE).clamp(0, 1)
  const growth = float(RING_START_SCALE).add(p.pow(RING_GROW_POW).mul(RING_END_SCALE - RING_START_SCALE))
  ringMat.positionNode = positionGeometry.mul(growth)
  const ringFadeIn = smoothstepNode(0.0, RING_FADE_IN / RING_LIFE, p)
  const ringFadeOut = p.oneMinus().pow(RING_FADE_POW)
  ringMat.colorNode = color(RING_COLOR)
  ringMat.opacityNode = ringFadeIn.mul(ringFadeOut).mul(RING_PEAK_ALPHA)
  ringMat.alphaTest = 0.003

  const ringMesh = new THREE.InstancedMesh(ringGeo, ringMat, RING_POOL_SIZE)
  ringMesh.frustumCulled = false // sparse, planet-wide decals
  ringMesh.renderOrder = 1
  const zeroMat = new THREE.Matrix4().makeScale(0, 0, 0)
  for (let i = 0; i < RING_POOL_SIZE; i++) ringMesh.setMatrixAt(i, zeroMat)
  ringMesh.instanceMatrix.needsUpdate = true
  group.add(ringMesh)

  let ringCursor = 0

  function stampRing(dir, rng, simTime) {
    const slot = ringCursor
    ringCursor = (ringCursor + 1) % RING_POOL_SIZE
    const yaw = rng() * Math.PI * 2

    tangentBasis(dir, _t1, _t2)
    const cy = Math.cos(yaw)
    const sy = Math.sin(yaw)
    _rRight.set(_t1.x * cy + _t2.x * sy, _t1.y * cy + _t2.y * sy, _t1.z * cy + _t2.z * sy)
    _rFwd.set(_t2.x * cy - _t1.x * sy, _t2.y * cy - _t1.y * sy, _t2.z * cy - _t1.z * sy)
    _rBasis.makeBasis(_rRight, dir, _rFwd)
    _rQuat.setFromRotationMatrix(_rBasis)
    _rPos.copy(dir).multiplyScalar(planet.sampleHeight(dir) + RING_LIFT)
    _rScale.set(RING_BASE_RADIUS, 1, RING_BASE_RADIUS)
    _rBasis.compose(_rPos, _rQuat, _rScale)
    ringMesh.setMatrixAt(slot, _rBasis)
    ringMesh.instanceMatrix.needsUpdate = true
    ringStampAttr.array[slot] = simTime
    ringStampAttr.needsUpdate = true
  }

  // --- dust puff Points pool (draw call 2) ---------------------------------
  const dustPositions = new Float32Array(DUST_POOL_SIZE * 3)
  const dustColorArr = new Float32Array(DUST_POOL_SIZE * 3)
  const dustAlpha = new Float32Array(DUST_POOL_SIZE)
  const dustSize = new Float32Array(DUST_POOL_SIZE)
  const dustVel = new Float32Array(DUST_POOL_SIZE * 3)
  const dustGrav = new Float32Array(DUST_POOL_SIZE * 3)
  const dustAge = new Float32Array(DUST_POOL_SIZE)
  const dustTtl = new Float32Array(DUST_POOL_SIZE)
  let dustCursor = 0

  const dustGeo = new THREE.BufferGeometry()
  dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPositions, 3))
  dustGeo.setAttribute('dustColor', new THREE.BufferAttribute(dustColorArr, 3))
  dustGeo.setAttribute('dustAlpha', new THREE.BufferAttribute(dustAlpha, 1))
  dustGeo.setAttribute('dustSize', new THREE.BufferAttribute(dustSize, 1))

  const dustMat = new THREE.PointsNodeMaterial({
    transparent: true,
    depthWrite: false, // soil puffs must not occlude; depthTest hides far dust
    blending: THREE.NormalBlending,
  })
  // Node graph built ONCE: per-point soil color, lifetime-envelope opacity,
  // world-space size. sizeAttenuation (default) recedes distant puffs.
  dustMat.colorNode = attribute('dustColor', 'vec3')
  dustMat.opacityNode = attribute('dustAlpha', 'float').mul(DUST_PEAK_ALPHA)
  dustMat.sizeNode = attribute('dustSize', 'float')

  const dustPoints = new THREE.Points(dustGeo, dustMat)
  dustPoints.frustumCulled = false
  dustPoints.renderOrder = 1
  group.add(dustPoints)

  let dustColorDirty = false
  let dustSizeDirty = false

  function spawnDust(px, py, pz, vx, vy, vz, gx, gy, gz, ttl, size) {
    const slot = dustCursor
    dustCursor = (dustCursor + 1) % DUST_POOL_SIZE
    const i3 = slot * 3
    dustPositions[i3] = px
    dustPositions[i3 + 1] = py
    dustPositions[i3 + 2] = pz
    dustVel[i3] = vx
    dustVel[i3 + 1] = vy
    dustVel[i3 + 2] = vz
    dustGrav[i3] = gx
    dustGrav[i3 + 1] = gy
    dustGrav[i3 + 2] = gz
    dustColorArr[i3] = DUST_COLOR[0]
    dustColorArr[i3 + 1] = DUST_COLOR[1]
    dustColorArr[i3 + 2] = DUST_COLOR[2]
    dustSize[slot] = size
    dustAlpha[slot] = 0
    dustAge[slot] = 0
    dustTtl[slot] = ttl
    dustColorDirty = true
    dustSizeDirty = true
  }

  function updateDustPool(dt) {
    let anyLive = false
    for (let slot = 0; slot < DUST_POOL_SIZE; slot++) {
      const ttl = dustTtl[slot]
      if (ttl <= 0) continue
      const age = dustAge[slot] + dt
      const i3 = slot * 3
      if (age >= ttl) {
        dustTtl[slot] = 0
        dustAlpha[slot] = 0
        continue
      }
      anyLive = true
      dustAge[slot] = age
      dustVel[i3] += dustGrav[i3] * dt
      dustVel[i3 + 1] += dustGrav[i3 + 1] * dt
      dustVel[i3 + 2] += dustGrav[i3 + 2] * dt
      dustPositions[i3] += dustVel[i3] * dt
      dustPositions[i3 + 1] += dustVel[i3 + 1] * dt
      dustPositions[i3 + 2] += dustVel[i3 + 2] * dt
      const fadeIn = age < DUST_FADE_IN ? age / DUST_FADE_IN : 1
      const tail = 1 - age / ttl
      dustAlpha[slot] = fadeIn * Math.pow(tail, DUST_FADE_POW)
    }
    dustGeo.attributes.position.needsUpdate = true
    dustGeo.attributes.dustAlpha.needsUpdate = true
    if (dustColorDirty) {
      dustGeo.attributes.dustColor.needsUpdate = true
      dustColorDirty = false
    }
    if (dustSizeDirty) {
      dustGeo.attributes.dustSize.needsUpdate = true
      dustSizeDirty = false
    }
    dustPoints.visible = anyLive
  }

  function burstDust(dir, rng) {
    _dir.copy(dir)
    _pos.copy(_dir).multiplyScalar(planet.sampleHeight(_dir))
    tangentBasis(_dir, _t1, _t2)
    for (let k = 0; k < DUST_PER_QUAKE; k++) {
      const a = rng() * Math.PI * 2
      const outSpeed = DUST_OUT_SPEED * (0.35 + rng() * 0.95)
      const upSpeed = DUST_UP_SPEED * (0.45 + rng() * 0.95)
      const ox = _t1.x * Math.cos(a) + _t2.x * Math.sin(a)
      const oy = _t1.y * Math.cos(a) + _t2.y * Math.sin(a)
      const oz = _t1.z * Math.cos(a) + _t2.z * Math.sin(a)
      spawnDust(
        _pos.x,
        _pos.y,
        _pos.z,
        _dir.x * upSpeed + ox * outSpeed,
        _dir.y * upSpeed + oy * outSpeed,
        _dir.z * upSpeed + oz * outSpeed,
        -_dir.x * DUST_GRAVITY,
        -_dir.y * DUST_GRAVITY,
        -_dir.z * DUST_GRAVITY,
        lerp(DUST_TTL_MIN, DUST_TTL_MAX, rng()),
        lerp(DUST_SIZE_MIN, DUST_SIZE_MAX, rng()),
      )
    }
  }

  // --- quake state pool (drives camera shake) ------------------------------
  const quakes = []
  for (let i = 0; i < MAX_QUAKES; i++) {
    quakes.push({
      active: false,
      age: 0,
      duration: 1,
      epicenter: new THREE.Vector3(),
    })
  }

  let simTime = 0

  // Starts a quake at surface direction `epiDir`, using seeded `rng` for the
  // ring yaw and dust jitter. Reuses a dormant slot; if all are busy the ring +
  // dust still fire (spectacle), only the shake slot is dropped.
  function begin(epiDir, rng) {
    _dir.copy(epiDir)
    if (_dir.lengthSq() < 1e-12) _dir.set(0, 1, 0)
    _dir.normalize()

    stampRing(_dir, rng, simTime)
    burstDust(_dir, rng)

    for (let i = 0; i < quakes.length; i++) {
      const q = quakes[i]
      if (!q.active) {
        q.active = true
        q.age = 0
        q.duration = lerp(QUAKE_DUR_MIN, QUAKE_DUR_MAX, rng())
        q.epicenter.copy(_dir)
        break
      }
    }
  }

  // --- camera shake --------------------------------------------------------
  // Deterministic high-frequency jitter, seeded phase offsets. Applied as a
  // pure additive offset each frame (see update() note). Combined amplitude is
  // the strongest active quake's decaying envelope, scaled by camera distance
  // and how much the epicenter faces the camera.
  const shakePhase = [
    hash01(seed + ':quake:shakeX') * Math.PI * 2,
    hash01(seed + ':quake:shakeY') * Math.PI * 2,
    hash01(seed + ':quake:shakeZ') * Math.PI * 2,
  ]

  function shakeAmplitude() {
    let amp = 0
    const dist = camera.position.length()
    if (dist < 1e-6) return 0
    _camDir.copy(camera.position).multiplyScalar(1 / dist)
    for (let i = 0; i < quakes.length; i++) {
      const q = quakes[i]
      if (!q.active) continue
      const env = Math.pow(clamp(1 - q.age / q.duration, 0, 1), SHAKE_DECAY_POW)
      const facing =
        SHAKE_FACING_MIN + (1 - SHAKE_FACING_MIN) * clamp(_camDir.dot(q.epicenter) * 0.5 + 0.5, 0, 1)
      const a = SHAKE_AMP * env * facing
      if (a > amp) amp = a
    }
    return clamp(amp, 0, SHAKE_AMP_MAX) * dist
  }

  function applyCameraShake() {
    const amp = shakeAmplitude()
    if (amp <= 0) return
    _shake.set(
      Math.sin(simTime * SHAKE_FREQ[0] + shakePhase[0]),
      Math.sin(simTime * SHAKE_FREQ[1] + shakePhase[1]),
      Math.sin(simTime * SHAKE_FREQ[2] + shakePhase[2]),
    )
    camera.position.addScaledVector(_shake, amp)
  }

  // --- ambient (self-firing) quakes ----------------------------------------
  let ambientCounter = 0
  let ambientTimer = 0
  let nextAmbient = lerp(AMBIENT_FIRST_MIN, AMBIENT_FIRST_MAX, rngFromString(seed + ':quake:ambient:first')())

  /** Rejection-sample a land epicenter; falls back to the last sample. */
  function pickLandDir(rng, out) {
    for (let i = 0; i < LAND_TRIES; i++) {
      randomUnit(rng, out)
      if (planet.isLand(out)) return out
    }
    return out
  }

  function fireAmbient() {
    const rng = rngFromString(seed + ':quake:ambient:' + ambientCounter++)
    pickLandDir(rng, _dir)
    begin(_dir, rng)
    nextAmbient = lerp(AMBIENT_DELAY_MIN, AMBIENT_DELAY_MAX, rng())
    ambientTimer = 0
  }

  // --- public trigger (god control / UI button) ----------------------------
  let triggerCounter = 0
  const _trigDir = new THREE.Vector3()
  function trigger(dirVec3) {
    if (!dirVec3) return
    _trigDir.copy(dirVec3)
    if (_trigDir.lengthSq() < 1e-12) return
    _trigDir.normalize()
    begin(_trigDir, rngFromString(seed + ':quake:trigger:' + triggerCounter++))
  }

  // update(dt): advance sim time, fire ambient quakes, age quakes, tick the
  // dust pool, and apply the camera shake.
  //
  // SHAKE WIRING NOTE: the shake is a pure additive offset to camera.position
  // with NO accumulation -- OrbitControls.update() rewrites camera.position
  // from its spherical target every frame, so last frame's offset is naturally
  // discarded and this frame's is laid fresh on top. For the shake to be
  // visible, call earthquakes.update(dt) AFTER controls.update(), just before
  // render. If called before, the offset is harmlessly overwritten (no shake,
  // no drift) -- so ordering only affects visibility, never correctness.
  function update(dt) {
    simTime += dt
    uTime.value = simTime

    ambientTimer += dt
    if (ambientTimer >= nextAmbient) fireAmbient()

    for (let i = 0; i < quakes.length; i++) {
      const q = quakes[i]
      if (!q.active) continue
      q.age += dt
      if (q.age >= q.duration) q.active = false
    }

    updateDustPool(dt)
    applyCameraShake()
  }

  return { group, update, trigger }
}
