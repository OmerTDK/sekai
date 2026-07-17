// Meteor strikes (god-control "cause a meteor to strike haha"): a fast
// glowing meteor arcs down out of the sky to a chosen surface direction,
// leaving an emissive comet streak, then flashes on impact (a bright central
// burst + an expanding shockwave ring), throws a burst of ember debris, and
// leaves a scorch crater decal on the ground that slowly cools and HEALS
// away over ~40s. An occasional AMBIENT meteor fires on its own (seeded,
// rare) so the sky is alive even with no user input.
//
// Contract (pinned): createMeteors(planet, seed) ->
//   { group, update(dt), strike(dirVec3) }.
// strike(dir) launches one meteor aimed at the surface point in direction
// `dir` (any unit-ish Vector3; it's normalized here). The architect wires a
// UI "meteor" button straight to strike(raycastDir).
//
// COVENANT: every visual here is additive/decorative and self-heals. The
// scorch crater is a fading surface decal (depthWrite off, polygon-offset,
// linear heal to nothing over CRATER_HEAL_TIME) that never touches, moves or
// overwrites a session structure -- if a strike lands on a settlement the
// scorch simply lies over the ground and fades, damaging nothing.
//
// ENGINE: WebGPURenderer(forceWebGL) + TSL NodeMaterials only (no
// ShaderMaterial / onBeforeCompile anywhere). Two draw calls total:
//   1. ONE emissive-additive Points pool (PointsNodeMaterial) carrying the
//      comet head+streak, the impact flash + shockwave ring, and the ember
//      debris -- three spawn PATTERNS into one ring-buffer pool, exactly the
//      shared-FX-pool idiom sealife.js/world.js use, but ADDITIVE with >1.0
//      HDR colors so the full-scene bloom (threshold 1.0, see main.js) lifts
//      every spark into a glow.
//   2. ONE InstancedMesh crater-decal pool (MeshBasicNodeMaterial), a flat
//      oval per strike, healing via a per-instance stampTime attribute vs a
//      uTime uniform -- trails.js's exact per-instance age-fade recipe, plus
//      an early red-hot cooling glow that mixes back to cold scorch.
//
// DETERMINISM: sim time is accumulated from dt (no Date.now); every random
// choice comes from rngFromString/hash01 keyed off (seed, a launch counter)
// -- no Math.random anywhere. Ambient timing is seeded per spawn. No
// per-frame allocation: all meteor state objects, pool buffers and scratch
// vectors are preallocated once.
import * as THREE from 'three/webgpu'
import { attribute, color, uniform, uv, vec3, mix, length, smoothstep as smoothstepNode } from 'three/tsl'
import { rngFromString, clamp, lerp } from './util.js'
import { tangentBasis } from './placement.js'

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------
const MAX_METEORS = 4 // concurrent in-flight meteors (user + ambient)

// Flight path. The meteor starts high and off to one side of the target and
// descends along a great-circle arc while its radius accelerates downward, so
// it reads as a diagonal streak curving in, not a straight vertical drop.
const START_RADIUS_MIN = 1.95 // world radius the meteor enters at (terrain tops ~1.06)
const START_RADIUS_MAX = 2.45
const ENTRY_ARC_MIN = 0.55 // rad of great-circle offset of the entry point from the target
const ENTRY_ARC_MAX = 1.15
const FLIGHT_TIME_MIN = 0.95 // seconds sky->impact
const FLIGHT_TIME_MAX = 1.45
const RADIUS_EASE_POW = 2.0 // >1 => accelerates as it falls (radius eased by t^pow)

// Comet streak (spawned every flight frame into the FX pool).
const HEAD_SIZE = 0.05 // world-space point size of the bright leading head
const HEAD_COLOR = [6.0, 3.8, 1.9] // HDR white-hot (>1 => blooms)
const HEAD_TTL = 0.12
const TRAIL_PER_FRAME = 2 // extra dimmer points laid down each frame => the streak body
const TRAIL_SIZE = 0.026
const TRAIL_COLOR = [4.2, 2.1, 0.85] // HDR warm, slightly cooler than the head
const TRAIL_TTL = 0.42
const TRAIL_JITTER = 0.006 // world-space spread of trail points around the path

// Impact flash + shockwave ring.
const FLASH_SIZE = 0.14
const FLASH_COLOR = [7.0, 6.0, 4.5] // HDR near-white
const FLASH_TTL = 0.34
const RING_COUNT = 22
const RING_SIZE = 0.03
const RING_COLOR = [4.6, 3.2, 1.7]
const RING_TTL = 0.55
const RING_SPEED = 0.16 // rad/s outward along the surface tangent (converted to world speed below)

// Ember debris burst.
const EMBER_COUNT = 30
const EMBER_SIZE_MIN = 0.007
const EMBER_SIZE_MAX = 0.02
const EMBER_COLOR = [5.0, 1.7, 0.4] // HDR orange
const EMBER_TTL_MIN = 0.5
const EMBER_TTL_MAX = 1.25
const EMBER_UP_SPEED = 0.09 // world units/s launched along the surface normal
const EMBER_OUT_SPEED = 0.11 // world units/s launched along a random tangent
const EMBER_GRAVITY = 0.14 // world units/s^2 pull back toward the surface (nice arc)

const FX_POOL_SIZE = 1200 // ring buffer; short TTLs keep the live set far under this
const FX_FADE_IN = 0.04 // seconds to ramp a fresh point's envelope up
const FX_FADE_POW = 1.5 // tail sharpness of the fade-out envelope

// Scorch crater decal.
const CRATER_POOL_SIZE = 16 // ring buffer of concurrent scorches
const CRATER_SEGMENTS = 16
const CRATER_RADIUS_MIN = 0.02 // world-space radius of the flat oval
const CRATER_RADIUS_MAX = 0.036
const CRATER_LIFT = 0.0009 // radial lift above sampleHeight, dodges z-fighting
const CRATER_HEAL_TIME = 40 // seconds to fade fully out ("slowly heals")
const CRATER_PEAK_ALPHA = 0.62
const CRATER_SCORCH = 0x17110c // cold burnt-earth (near-black brown)
const CRATER_HOT = [4.0, 1.15, 0.22] // HDR red-hot glow while the crater is fresh
const CRATER_COOL_TIME = 2.6 // seconds the red-hot inner glow lingers before cooling
const CRATER_STAMP_UNSET = -1e6 // sentinel stampTime => healFade 0 (invisible) from frame one

// Ambient (self-firing) meteors -- rare, seeded.
const AMBIENT_DELAY_MIN = 24 // seconds between ambient strikes
const AMBIENT_DELAY_MAX = 68
const AMBIENT_FIRST_MIN = 8 // first ambient strike lands sooner so the world shows life early
const AMBIENT_FIRST_MAX = 20

const UP = new THREE.Vector3(0, 1, 0)
const RIGHT = new THREE.Vector3(1, 0, 0)

// ---------------------------------------------------------------------------
// Module-scope scratch (write-before-read; safe to share since everything
// runs synchronously on one thread -- same convention as trails.js/sealife.js).
// ---------------------------------------------------------------------------
const _t1 = new THREE.Vector3()
const _t2 = new THREE.Vector3()
const _dir = new THREE.Vector3()
const _curDir = new THREE.Vector3()
const _pos = new THREE.Vector3()
const _vel = new THREE.Vector3()
const _jit = new THREE.Vector3()
const _cRight = new THREE.Vector3()
const _cFwd = new THREE.Vector3()
const _cBasis = new THREE.Matrix4()
const _cQuat = new THREE.Quaternion()
const _cScale = new THREE.Vector3()
const _cPos = new THREE.Vector3()

/** Unit direction `dist` radians from `base` along `bearing` (great circle). */
function offsetDir(base, bearing, dist, out) {
  tangentBasis(base, _t1, _t2)
  const cb = Math.cos(bearing)
  const sb = Math.sin(bearing)
  const tx = _t1.x * cb + _t2.x * sb
  const ty = _t1.y * cb + _t2.y * sb
  const tz = _t1.z * cb + _t2.z * sb
  const cd = Math.cos(dist)
  const sd = Math.sin(dist)
  return out.set(base.x * cd + tx * sd, base.y * cd + ty * sd, base.z * cd + tz * sd).normalize()
}

/** Deterministic uniform random unit vector from a seeded rng. */
function randomUnit(rng, out) {
  const z = rng() * 2 - 1
  const a = rng() * Math.PI * 2
  const r = Math.sqrt(Math.max(0, 1 - z * z))
  return out.set(r * Math.cos(a), r * Math.sin(a), z)
}

// ---------------------------------------------------------------------------
// createMeteors
// ---------------------------------------------------------------------------
export function createMeteors(planet, seed) {
  const group = new THREE.Group()

  // --- emissive-additive FX Points pool (draw call 1) ----------------------
  // Custom per-point attribute names (emColor/emAlpha/emSize) sidestep the
  // built-in vertexColors path entirely, so the HDR (>1) colors flow straight
  // through colorNode unclamped and bloom lifts them. sizeAttenuation stays on
  // (default) so distant sparks recede naturally with perspective.
  const fxPositions = new Float32Array(FX_POOL_SIZE * 3)
  const fxEmColor = new Float32Array(FX_POOL_SIZE * 3)
  const fxEmAlpha = new Float32Array(FX_POOL_SIZE)
  const fxEmSize = new Float32Array(FX_POOL_SIZE)
  const fxVel = new Float32Array(FX_POOL_SIZE * 3)
  const fxGrav = new Float32Array(FX_POOL_SIZE * 3) // per-point pull direction * accel (embers only)
  const fxAge = new Float32Array(FX_POOL_SIZE)
  const fxTtl = new Float32Array(FX_POOL_SIZE)
  let fxCursor = 0

  const fxGeo = new THREE.BufferGeometry()
  fxGeo.setAttribute('position', new THREE.BufferAttribute(fxPositions, 3))
  fxGeo.setAttribute('emColor', new THREE.BufferAttribute(fxEmColor, 3))
  fxGeo.setAttribute('emAlpha', new THREE.BufferAttribute(fxEmAlpha, 1))
  fxGeo.setAttribute('emSize', new THREE.BufferAttribute(fxEmSize, 1))

  const fxMat = new THREE.PointsNodeMaterial({
    transparent: true,
    depthWrite: false, // additive glow must not occlude; depthTest stays on so the planet hides far sparks
    blending: THREE.AdditiveBlending,
  })
  // Node graph built ONCE (S1 build-once/uniforms-only law): emColor is the
  // HDR emissive, emAlpha the lifetime envelope, emSize the per-point world
  // size. AdditiveBlending contributes emColor * emAlpha, so folding the
  // brightness into emColor (>1) and the fade into emAlpha reads correct.
  fxMat.colorNode = attribute('emColor', 'vec3')
  fxMat.opacityNode = attribute('emAlpha', 'float')
  fxMat.sizeNode = attribute('emSize', 'float')

  const fxPoints = new THREE.Points(fxGeo, fxMat)
  fxPoints.frustumCulled = false // sparks land anywhere on/around the planet
  fxPoints.renderOrder = 3 // over clouds/storms, like other bright overlays
  group.add(fxPoints)

  let fxColorDirty = false
  let fxSizeDirty = false

  function spawnPoint(px, py, pz, vx, vy, vz, gx, gy, gz, ttl, size, cr, cg, cb) {
    const slot = fxCursor
    fxCursor = (fxCursor + 1) % FX_POOL_SIZE
    const i3 = slot * 3
    fxPositions[i3] = px
    fxPositions[i3 + 1] = py
    fxPositions[i3 + 2] = pz
    fxVel[i3] = vx
    fxVel[i3 + 1] = vy
    fxVel[i3 + 2] = vz
    fxGrav[i3] = gx
    fxGrav[i3 + 1] = gy
    fxGrav[i3 + 2] = gz
    fxEmColor[i3] = cr
    fxEmColor[i3 + 1] = cg
    fxEmColor[i3 + 2] = cb
    fxEmSize[slot] = size
    fxEmAlpha[slot] = 0
    fxAge[slot] = 0
    fxTtl[slot] = ttl
    fxColorDirty = true
    fxSizeDirty = true
  }

  function updateFxPool(dt) {
    let anyLive = false
    for (let slot = 0; slot < FX_POOL_SIZE; slot++) {
      const ttl = fxTtl[slot]
      if (ttl <= 0) continue
      const age = fxAge[slot] + dt
      const i3 = slot * 3
      if (age >= ttl) {
        fxTtl[slot] = 0
        fxEmAlpha[slot] = 0
        continue
      }
      anyLive = true
      fxAge[slot] = age
      // gravity (embers) pulls the velocity back toward the surface over time
      fxVel[i3] += fxGrav[i3] * dt
      fxVel[i3 + 1] += fxGrav[i3 + 1] * dt
      fxVel[i3 + 2] += fxGrav[i3 + 2] * dt
      fxPositions[i3] += fxVel[i3] * dt
      fxPositions[i3 + 1] += fxVel[i3 + 1] * dt
      fxPositions[i3 + 2] += fxVel[i3 + 2] * dt
      const fadeIn = age < FX_FADE_IN ? age / FX_FADE_IN : 1
      const tail = 1 - age / ttl
      fxEmAlpha[slot] = fadeIn * Math.pow(tail, FX_FADE_POW)
    }
    fxGeo.attributes.position.needsUpdate = true
    fxGeo.attributes.emAlpha.needsUpdate = true
    if (fxColorDirty) {
      fxGeo.attributes.emColor.needsUpdate = true
      fxColorDirty = false
    }
    if (fxSizeDirty) {
      fxGeo.attributes.emSize.needsUpdate = true
      fxSizeDirty = false
    }
    fxPoints.visible = anyLive
  }

  // --- scorch crater decal pool (draw call 2) ------------------------------
  const craterGeo = new THREE.CircleGeometry(1, CRATER_SEGMENTS)
  craterGeo.rotateX(-Math.PI / 2) // default +Z-facing disc -> +Y-facing (local +Y is the surface normal)
  craterGeo.setAttribute(
    'stampTime',
    new THREE.InstancedBufferAttribute(new Float32Array(CRATER_POOL_SIZE).fill(CRATER_STAMP_UNSET), 1),
  )
  const craterStampAttr = craterGeo.attributes.stampTime

  const craterMat = new THREE.MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  })
  // Per-instance heal fade (trails.js recipe) + a fresh-crater red-hot glow.
  // stampAge = uTime - stampTime; healFade linear-fades opacity to 0 over
  // CRATER_HEAL_TIME; the inner disc glows HDR-hot (CRATER_HOT, >1 => blooms)
  // for the first CRATER_COOL_TIME seconds, then mixes back to cold scorch.
  // Graph built once; only uTime.value changes per frame.
  const uTime = uniform(0)
  const stampAge = uTime.sub(attribute('stampTime', 'float'))
  const healFade = stampAge.div(CRATER_HEAL_TIME).clamp(0, 1).oneMinus()
  const c = uv().sub(0.5)
  const rr = length(c).mul(2) // 0 at center -> 1 at rim
  const craterShape = smoothstepNode(1.0, 0.28, rr) // 1 in the burnt center, soft to 0 at the rim
  const hot = smoothstepNode(CRATER_COOL_TIME, 0.0, stampAge).mul(smoothstepNode(0.85, 0.0, rr))
  craterMat.colorNode = mix(color(CRATER_SCORCH), vec3(CRATER_HOT[0], CRATER_HOT[1], CRATER_HOT[2]), hot)
  craterMat.opacityNode = craterShape.mul(healFade).mul(CRATER_PEAK_ALPHA)
  craterMat.alphaTest = 0.003

  const craterMesh = new THREE.InstancedMesh(craterGeo, craterMat, CRATER_POOL_SIZE)
  craterMesh.frustumCulled = false // sparse, planet-wide decals; 16 tiny instances are cheap regardless
  craterMesh.renderOrder = 1
  const zeroMat = new THREE.Matrix4().makeScale(0, 0, 0)
  for (let i = 0; i < CRATER_POOL_SIZE; i++) craterMesh.setMatrixAt(i, zeroMat)
  craterMesh.instanceMatrix.needsUpdate = true
  group.add(craterMesh)

  let craterCursor = 0

  function stampCrater(dir, rng, simTime) {
    const slot = craterCursor
    craterCursor = (craterCursor + 1) % CRATER_POOL_SIZE
    const radius = lerp(CRATER_RADIUS_MIN, CRATER_RADIUS_MAX, rng())
    const yaw = rng() * Math.PI * 2

    tangentBasis(dir, _t1, _t2)
    const cy = Math.cos(yaw)
    const sy = Math.sin(yaw)
    _cRight.set(_t1.x * cy + _t2.x * sy, _t1.y * cy + _t2.y * sy, _t1.z * cy + _t2.z * sy)
    _cFwd.set(_t2.x * cy - _t1.x * sy, _t2.y * cy - _t1.y * sy, _t2.z * cy - _t1.z * sy)
    _cBasis.makeBasis(_cRight, dir, _cFwd)
    _cQuat.setFromRotationMatrix(_cBasis)
    _cPos.copy(dir).multiplyScalar(planet.sampleHeight(dir) + CRATER_LIFT)
    _cScale.set(radius, 1, radius)
    _cBasis.compose(_cPos, _cQuat, _cScale)
    craterMesh.setMatrixAt(slot, _cBasis)
    craterMesh.instanceMatrix.needsUpdate = true
    craterStampAttr.array[slot] = simTime
    craterStampAttr.needsUpdate = true
  }

  // --- meteor state pool ---------------------------------------------------
  const meteors = []
  for (let i = 0; i < MAX_METEORS; i++) {
    meteors.push({
      active: false,
      age: 0,
      duration: 1,
      startRadius: 2,
      impactRadius: 1.06,
      startDir: new THREE.Vector3(),
      target: new THREE.Vector3(),
      axis: new THREE.Vector3(), // rotation axis startDir->target
      arcAngle: 0, // total angle startDir->target
      rng: null, // this launch's own rng closure (impact jitter reuses it)
      headR: HEAD_COLOR[0],
      headG: HEAD_COLOR[1],
      headB: HEAD_COLOR[2],
    })
  }

  let simTime = 0

  // Launches a meteor at surface direction `targetDir`, using `rng` (a seeded
  // closure) for every jittered choice. Reuses a dormant slot; if all are
  // busy the newest request is dropped (rare -- MAX_METEORS concurrent).
  function launch(targetDir, rng) {
    let m = null
    for (let i = 0; i < meteors.length; i++) {
      if (!meteors[i].active) {
        m = meteors[i]
        break
      }
    }
    if (!m) return

    m.target.copy(targetDir)
    if (m.target.lengthSq() < 1e-12) m.target.set(0, 1, 0)
    m.target.normalize()
    m.impactRadius = planet.sampleHeight(m.target)

    const bearing = rng() * Math.PI * 2
    const arc = lerp(ENTRY_ARC_MIN, ENTRY_ARC_MAX, rng())
    offsetDir(m.target, bearing, arc, m.startDir)
    m.startRadius = lerp(START_RADIUS_MIN, START_RADIUS_MAX, rng())
    m.duration = lerp(FLIGHT_TIME_MIN, FLIGHT_TIME_MAX, rng())

    m.axis.crossVectors(m.startDir, m.target)
    if (m.axis.lengthSq() < 1e-12) {
      // startDir ~ target (degenerate) -- pick any perpendicular axis
      m.axis.crossVectors(Math.abs(m.startDir.y) < 0.99 ? UP : RIGHT, m.startDir)
    }
    m.axis.normalize()
    m.arcAngle = Math.acos(clamp(m.startDir.dot(m.target), -1, 1))

    m.rng = rng
    m.age = 0
    m.active = true
  }

  function impact(m) {
    const rng = m.rng
    _dir.copy(m.target)
    _pos.copy(_dir).multiplyScalar(m.impactRadius)
    tangentBasis(_dir, _t1, _t2)

    // Central flash.
    spawnPoint(
      _pos.x,
      _pos.y,
      _pos.z,
      0,
      0,
      0,
      0,
      0,
      0,
      FLASH_TTL,
      FLASH_SIZE,
      FLASH_COLOR[0],
      FLASH_COLOR[1],
      FLASH_COLOR[2],
    )

    // Expanding shockwave ring: points launched along the surface tangent.
    const ringSpeed = RING_SPEED * m.impactRadius
    for (let k = 0; k < RING_COUNT; k++) {
      const a = (k / RING_COUNT) * Math.PI * 2 + rng() * 0.2
      const dx = _t1.x * Math.cos(a) + _t2.x * Math.sin(a)
      const dy = _t1.y * Math.cos(a) + _t2.y * Math.sin(a)
      const dz = _t1.z * Math.cos(a) + _t2.z * Math.sin(a)
      spawnPoint(
        _pos.x,
        _pos.y,
        _pos.z,
        dx * ringSpeed,
        dy * ringSpeed,
        dz * ringSpeed,
        0,
        0,
        0,
        RING_TTL * (0.85 + rng() * 0.3),
        RING_SIZE,
        RING_COLOR[0],
        RING_COLOR[1],
        RING_COLOR[2],
      )
    }

    // Ember debris: up along the normal + out along a random tangent, pulled
    // back down by gravity for a nice ballistic arc.
    for (let k = 0; k < EMBER_COUNT; k++) {
      const a = rng() * Math.PI * 2
      const outSpeed = EMBER_OUT_SPEED * (0.4 + rng() * 0.9)
      const upSpeed = EMBER_UP_SPEED * (0.5 + rng() * 0.9)
      const ox = _t1.x * Math.cos(a) + _t2.x * Math.sin(a)
      const oy = _t1.y * Math.cos(a) + _t2.y * Math.sin(a)
      const oz = _t1.z * Math.cos(a) + _t2.z * Math.sin(a)
      spawnPoint(
        _pos.x,
        _pos.y,
        _pos.z,
        _dir.x * upSpeed + ox * outSpeed,
        _dir.y * upSpeed + oy * outSpeed,
        _dir.z * upSpeed + oz * outSpeed,
        -_dir.x * EMBER_GRAVITY,
        -_dir.y * EMBER_GRAVITY,
        -_dir.z * EMBER_GRAVITY,
        lerp(EMBER_TTL_MIN, EMBER_TTL_MAX, rng()),
        lerp(EMBER_SIZE_MIN, EMBER_SIZE_MAX, rng()),
        EMBER_COLOR[0],
        EMBER_COLOR[1],
        EMBER_COLOR[2],
      )
    }

    // Scorch crater -- additive, healing, never destroys a structure.
    stampCrater(_dir, rng, simTime)
  }

  function tickMeteor(m, dt) {
    if (!m.active) return
    m.age += dt
    const t = clamp(m.age / m.duration, 0, 1)

    // Angular progress linear (t); radius accelerates (t^pow): the blend
    // curves the descent -- fast radial plunge near the end.
    _curDir.copy(m.startDir).applyAxisAngle(m.axis, m.arcAngle * t)
    const radius = lerp(m.startRadius, m.impactRadius, Math.pow(t, RADIUS_EASE_POW))
    _pos.copy(_curDir).multiplyScalar(radius)

    // Bright leading head.
    spawnPoint(_pos.x, _pos.y, _pos.z, 0, 0, 0, 0, 0, 0, HEAD_TTL, HEAD_SIZE, m.headR, m.headG, m.headB)
    // Trail body: a few jittered dimmer points laid down at the head each
    // frame; their lingering TTL is what draws the streak.
    for (let k = 0; k < TRAIL_PER_FRAME; k++) {
      _jit.set(m.rng() * 2 - 1, m.rng() * 2 - 1, m.rng() * 2 - 1).multiplyScalar(TRAIL_JITTER)
      spawnPoint(
        _pos.x + _jit.x,
        _pos.y + _jit.y,
        _pos.z + _jit.z,
        0,
        0,
        0,
        0,
        0,
        0,
        TRAIL_TTL,
        TRAIL_SIZE,
        TRAIL_COLOR[0],
        TRAIL_COLOR[1],
        TRAIL_COLOR[2],
      )
    }

    if (t >= 1) {
      impact(m)
      m.active = false
    }
  }

  // --- ambient (self-firing) meteors ---------------------------------------
  let ambientCounter = 0
  let ambientTimer = 0
  let nextAmbient = lerp(
    AMBIENT_FIRST_MIN,
    AMBIENT_FIRST_MAX,
    rngFromString(seed + ':meteor:ambient:first')(),
  )

  function fireAmbient() {
    const rng = rngFromString(seed + ':meteor:ambient:' + ambientCounter++)
    randomUnit(rng, _dir)
    launch(_dir, rng)
    nextAmbient = lerp(AMBIENT_DELAY_MIN, AMBIENT_DELAY_MAX, rng())
    ambientTimer = 0
  }

  // --- public strike (god control / UI button) -----------------------------
  let strikeCounter = 0
  const _strikeDir = new THREE.Vector3()
  function strike(dirVec3) {
    if (!dirVec3) return
    _strikeDir.copy(dirVec3)
    if (_strikeDir.lengthSq() < 1e-12) return
    _strikeDir.normalize()
    launch(_strikeDir, rngFromString(seed + ':meteor:strike:' + strikeCounter++))
  }

  function update(dt) {
    simTime += dt
    uTime.value = simTime

    ambientTimer += dt
    if (ambientTimer >= nextAmbient) fireAmbient()

    for (let i = 0; i < meteors.length; i++) tickMeteor(meteors[i], dt)
    updateFxPool(dt)
  }

  return { group, update, strike }
}
