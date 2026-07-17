// The resident dragon (M2.5; program plan §0.5 + §M2.5 — "dragons are canon:
// resident, lair, event appearances"). One dragon, living at a lair on the
// planet's tallest peak: a landmark, not ambient clutter (plan §6). Every
// easing/palette/bloom choice below is bound by docs/ART.md.
//
// Model: CC0 "Dragon" by Quaternius (public/models/dragon/dragon.glb — see
// public/models/SOURCES.md), rigged/skinned, 1,344 tris, ships one 'Flying'
// animation clip. This module drives that clip with THREE.AnimationMixer,
// easing its *weight* between 0 and 1 for takeoff/landing. The rig's raw
// GLTF bind pose turned out to hold the wings already fully spread (checked
// on the dev-server screenshot pass — not a folded standing pose at all),
// so the "wings folded" perched silhouette instead force-restores whichever
// sampled Flying-clip frame has the narrowest horizontal span (see
// restoreBindPose/boneBindQuats, near createDragon) — the closest thing
// this rig ships to a folded reference pose. Everything else — the flight
// path itself: circling near the lair, great-circle transits to a
// settlement, banking into turns, altitude, vertical bob — is root-motion
// driven every frame by this module, reusing birds.js's basis-matrix
// approach and placement.js's spherical helpers.
//
// State machine (all transitions eased — nothing snaps, per ART.md §7):
//   perched -> takeoff -> circleLair -> landing -> perched      (ordinary patrol)
//   perched -> takeoff -> transitOut -> circleSettlement -> transitBack -> landing -> perched   (flyby)
// perched decides which plan to run (maybeStartFlight, below) using a
// seeded ~4-7min timer gated on world.list() showing any settlement with
// agents>0. maybeStartFlight is the single, well-named entry point for that
// decision — a future 'milestone appearance' feature can force a flyby by
// calling straight into beginFlybyFlight() from here; nothing new is
// exported for it now (out of scope for M2.5), but the seam is this one.
//
// Settlement anchors are looked up read-only through world.list() (agent
// counts) + a world.group traversal for the matching userData.settlement
// record's anchorDir/groundR — the same pattern events.js already documents
// and uses; this module never mutates anything on `world` or `planet`.
import * as THREE from 'three/webgpu'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { rngFromString, clamp, lerp, smoothstep } from './util.js'
import { tangentBasis, orientOnSurface, yawedTangent, stepToward } from './placement.js'
import { buildRockGeometry } from './flora.js'
import { sphereGeo } from './buildings.js'

const MODEL_URL = '/models/dragon/dragon.glb'

// ---------------------------------------------------------------------------
// Palette (docs/ART.md §0.5 steampunk accents + this spec's crimson). The
// hoard-glint recipe mirrors buildings.js's emberMat: base color + an
// emissive*emissiveIntensity>1 headroom on a MeshStandardMaterial — the
// established recipe for ONE isolated small glowing prop (ART.md §2.5),
// as opposed to town-lights' additive-overlap-of-hundreds trick, which
// doesn't apply to a handful of sparse, non-overlapping dots.
// ---------------------------------------------------------------------------
const COLOR_CRIMSON = 0x6e2b2b
const COLOR_BRASS = 0xb0793a
const COLOR_EYE = 0x140a08
const GLINT_COLOR = 0xffd76a // firework gold (ART.md §2.1)
const GLINT_EMISSIVE = 0xffb347 // hammer spark (ART.md §2.1)

// ---------------------------------------------------------------------------
// Scale + flight band
// ---------------------------------------------------------------------------
const WINGSPAN = 0.02 // world units — "~4 houses", per spec
// Above HEIGHT_MAX peaks (1.06, planet.js) and below the lower cloud shell
// (1.075, sky.js) — the same tight band birds.js flies in (1.065-1.073).
const FLIGHT_ALT_MIN = 1.062
const FLIGHT_ALT_MAX = 1.073
const FLIGHT_ALT_MID = (FLIGHT_ALT_MIN + FLIGHT_ALT_MAX) / 2
const FLIGHT_ALT_WOBBLE = 0.0035 // slow soaring sine, stays inside the band with margin
const BOB_AMPLITUDE = 0.0007 // per-flap vertical bob, added on top of the wobble above

// ---------------------------------------------------------------------------
// Lair scan: deterministic seeded lattice, ~4000 samples, tallest point wins.
// ---------------------------------------------------------------------------
const LAIR_LATTICE_SAMPLES = 4000
const LAIR_RING_RADIUS = 0.0055 // world units — roughly one house-width
const LAIR_ROCK_COUNT = 10
const LAIR_GLINT_COUNT = 6

// ---------------------------------------------------------------------------
// Timing (seconds). Every one of these drives a smoothstep-eased progress,
// never a linear or instant change — ART.md §7, "nothing snaps".
// ---------------------------------------------------------------------------
const PERCHED_DWELL_MIN = 30
const PERCHED_DWELL_MAX = 70 // avg ~50s perched vs. ~25-40s per flight -> perched reads as ~60% of time, per spec
const TAKEOFF_DURATION = 2.4
const TAKEOFF_ARC_ANGLE = 0.05 // rad — how far around the great circle the dragon travels while climbing out, flyby case
const LANDING_DURATION = 2.6
const LANDING_FLARE_START = 0.6 // fraction of LANDING_DURATION where the nose-up flare begins

const CIRCLE_ANGULAR_SPEED = (Math.PI * 2) / 12 // ~12s per loop — majestic, not frantic
const CIRCLE_RADIUS_LAIR = 0.05 // rad — wide thermal circle near the lair
const CIRCLE_RADIUS_SETTLEMENT = 0.035 // rad — tighter, reads as "over" one settlement
const TRANSIT_SPEED = 0.15 // rad/s cruise, great-circle
const TRANSIT_EASE_TIME = 1.5 // seconds to ease into cruise speed at the start of a transit

const FLAP_HZ = 0.5 // spec: "wing flap slow (~0.5Hz)"
const GLIDE_HZ = 0.06 // near-frozen, not fully paused — avoids a dead-stop read
const FLAP_BURST_MIN = 2.2
const FLAP_BURST_MAX = 3.2
const GLIDE_MIN = 1.4
const GLIDE_MAX = 2.4
const FLAP_HZ_EASE_RATE = 2.2 // exponential chase rate (1/s), flap<->glide blend

const BANK_GAIN = 2.6 // bank angle (rad) per (rad/s) of turn rate, before clamp
const BANK_MAX = 0.6 // ~34 degrees
const EASE_CHASE_RATE = 3.0 // exponential chase rate (1/s), shared by bank + climb-pitch
const CLIMB_PITCH_GAIN = 12
const CLIMB_PITCH_MAX = 0.45
const FLARE_PITCH_MAX = 0.32 // landing flare nose-up peak, rad

const BREATHE_HZ = 0.22
const BREATHE_AMPLITUDE = 0.014
const HEAD_TURN_MIN = 4 // seconds between idle head turns, perched only
const HEAD_TURN_MAX = 9
const HEAD_TURN_EASE_IN = 0.6
const HEAD_TURN_HOLD = 1.1
const HEAD_TURN_EASE_OUT = 0.9
const HEAD_TURN_MAX_YAW = 0.45 // rad

const FLYBY_INTERVAL_MIN = 240 // 4 min
const FLYBY_INTERVAL_MAX = 420 // 7 min

// ---------------------------------------------------------------------------
// Lair scan — pure function of planet + seed, runs once at init (~4000
// sampleHeight() calls; negligible next to the settlement/structure search
// budgets in placement.js). A golden-angle (Fibonacci) sphere lattice, tilted
// by a seeded random rotation so the lattice's own pole artifacts don't
// always land in the same spot relative to terrain across different seeds —
// "seeded lattice" per spec. Deterministic: same seed -> same lair always.
// ---------------------------------------------------------------------------
function findLairSpot(planet, seed) {
  const rng = rngFromString(seed + ':dragon-lair')
  const tiltAxis = new THREE.Vector3(rng() * 2 - 1, rng() * 2 - 1, rng() * 2 - 1).normalize()
  const tiltQuat = new THREE.Quaternion().setFromAxisAngle(tiltAxis, rng() * Math.PI * 2)
  const golden = Math.PI * (3 - Math.sqrt(5))
  const p = new THREE.Vector3()
  const best = new THREE.Vector3(0, 1, 0)
  let bestH = -Infinity
  for (let i = 0; i < LAIR_LATTICE_SAMPLES; i++) {
    const y = 1 - (i / (LAIR_LATTICE_SAMPLES - 1)) * 2
    const r = Math.sqrt(Math.max(0, 1 - y * y))
    const theta = golden * i
    p.set(Math.cos(theta) * r, y, Math.sin(theta) * r).applyQuaternion(tiltQuat)
    const h = planet.sampleHeight(p)
    if (h > bestH) {
      bestH = h
      best.copy(p)
    }
  }
  best.normalize()
  return { dir: best, groundR: bestH }
}

// ---------------------------------------------------------------------------
// Lair marker: a small cave-mouth arc of rocks (reusing flora.js's own rock
// geometry/palette so it matches every other rock in the world) around a
// gap that reads as the entrance, plus a few brass hoard glints scattered
// just inside it.
// ---------------------------------------------------------------------------
function buildLairMarker(planet, seed, lairDir, _forwardHint) {
  const group = new THREE.Group()
  const rng = rngFromString(seed + ':dragon-lair-deco')

  const rockGeo = buildRockGeometry()
  const rockMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    flatShading: true,
    roughness: 1,
    metalness: 0,
  })
  const t1 = new THREE.Vector3()
  const t2 = new THREE.Vector3()
  tangentBasis(lairDir, t1, t2)
  const p = new THREE.Vector3()

  // Arc, not a full ring — leave a gap facing forwardHint so it reads as a
  // mouth, not a stone crown.
  const ARC_SPAN = Math.PI * 2 * (250 / 360)
  const ARC_START = Math.PI * 0.5
  for (let i = 0; i < LAIR_ROCK_COUNT; i++) {
    const angle = ARC_START + (i / (LAIR_ROCK_COUNT - 1)) * ARC_SPAN
    const rad = LAIR_RING_RADIUS * (0.85 + rng() * 0.3)
    p.copy(lairDir)
      .addScaledVector(t1, Math.cos(angle) * rad)
      .addScaledVector(t2, Math.sin(angle) * rad)
      .normalize()
    const h = planet.sampleHeight(p)
    const rock = new THREE.Mesh(rockGeo, rockMat)
    rock.position.copy(p).multiplyScalar(h)
    const s = 0.0009 + rng() * 0.0013
    rock.scale.set(s * (0.8 + rng() * 0.4), s * (0.7 + rng() * 0.5), s * (0.8 + rng() * 0.4))
    orientOnSurface(rock, p, t1)
    rock.rotateY(rng() * Math.PI * 2) // vary facing so the arc doesn't look stamped-copy
    group.add(rock)
  }

  const glintGeo = sphereGeo()
  const glintMat = new THREE.MeshStandardMaterial({
    color: GLINT_COLOR,
    emissive: GLINT_EMISSIVE,
    emissiveIntensity: 1.6,
    roughness: 0.3,
    metalness: 0.6,
    flatShading: true,
  })
  for (let i = 0; i < LAIR_GLINT_COUNT; i++) {
    const angle = rng() * Math.PI * 2
    const rad = LAIR_RING_RADIUS * rng() * 0.65
    p.copy(lairDir)
      .addScaledVector(t1, Math.cos(angle) * rad)
      .addScaledVector(t2, Math.sin(angle) * rad)
      .normalize()
    const h = planet.sampleHeight(p)
    const glint = new THREE.Mesh(glintGeo, glintMat)
    glint.position.copy(p).multiplyScalar(h + 0.0004)
    glint.scale.setScalar(0.0014 + rng() * 0.0012) // sphereGeo() base radius is 0.5
    group.add(glint)
  }

  return group
}

// ---------------------------------------------------------------------------
// Settlement lookup — read-only, mirrors events.js's documented pattern.
// ---------------------------------------------------------------------------
function findBusiestSettlement(world) {
  const list = world.list()
  let best = null
  for (let i = 0; i < list.length; i++) {
    const s = list[i]
    if (s.agents > 0 && (!best || s.agents > best.agents)) best = s
  }
  return best
}

function findSettlementAnchor(world, project) {
  let found = null
  world.group.traverse((obj) => {
    if (found) return
    const settlement = obj.userData && obj.userData.settlement
    if (settlement && settlement.project === project) found = settlement
  })
  if (!found || !found.anchorDir || !Number.isFinite(found.groundR)) return null
  return found
}

// ---------------------------------------------------------------------------
// Material recoloring — the sourced GLB ships zero images/textures already
// (flat baseColorFactor materials only), so there's nothing to strip; we
// just override colors at load time, same "tint at runtime" convention
// assets.js uses for the Kenney/Quaternius building parts.
// ---------------------------------------------------------------------------
function recolorDragonMaterials(scene) {
  const seen = new Set()
  scene.traverse((obj) => {
    if (!obj.isMesh) return
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material]
    for (const m of mats) {
      if (!m || seen.has(m)) continue
      seen.add(m)
      m.flatShading = true
      if (m.name === 'Claws') {
        m.color.setHex(COLOR_BRASS)
        m.metalness = 0.55
        m.roughness = 0.35
      } else if (m.name === 'Eyes') {
        m.color.setHex(COLOR_EYE)
        m.metalness = 0.1
        m.roughness = 0.4
      } else {
        // Main / Belly / Wings -> one flat crimson body, per spec.
        m.color.setHex(COLOR_CRIMSON)
        m.metalness = 0.08
        m.roughness = 0.85
      }
      m.needsUpdate = true
    }
  })
}

// ---------------------------------------------------------------------------
// createDragon
// ---------------------------------------------------------------------------
export function createDragon(planet, world, seed) {
  const rng = rngFromString(seed + ':dragon')

  const { dir: lairDir, groundR: lairGroundR } = findLairSpot(planet, seed)
  const restingYaw = rng() * Math.PI * 2
  const restingForward = new THREE.Vector3()
  yawedTangent(lairDir, restingYaw, restingForward)

  const group = new THREE.Group()
  group.add(buildLairMarker(planet, seed, lairDir, restingForward))

  const dragonPivot = new THREE.Group()
  dragonPivot.name = 'dragonPivot'
  group.add(dragonPivot)

  // --- async model state -----------------------------------------------
  let ready = false
  let modelRoot = null
  let mixer = null
  let flyAction = null
  let flyClipDuration = 1
  let scaleFactor = 1
  let headBone = null
  let warnedLoadFailed = false
  let warnedNoHeadBone = false

  // "Perched" bone quaternions — force-restored every perched frame
  // (restoreBindPose, below). NOT the rig's raw GLTF bind pose: that turned
  // out to hold the wings already fully spread (verified on the dev-server
  // screenshot check — this rig's rest pose reads as a flight/reference
  // stance, not a standing-with-folded-wings one), which fails the spec's
  // "PERCHED (wings folded)" requirement outright. Instead this captures
  // whichever sampled frame of the Flying clip itself has the *narrowest*
  // horizontal span — the wings' natural up-and-back extreme mid-flap,
  // anatomically the closest thing this rig ships to a folded silhouette —
  // during the same measurement pass used for wingspan scaling, below.
  const boneBindQuats = new Map()
  function restoreBindPose() {
    for (const [bone, q] of boneBindQuats) bone.quaternion.copy(q)
  }

  new GLTFLoader()
    .loadAsync(MODEL_URL)
    .then((gltf) => {
      const scene = gltf.scene
      recolorDragonMaterials(scene)
      const bones = []
      scene.traverse((obj) => {
        if (!obj.isBone) return
        if (obj.name === 'Head') headBone = obj
        bones.push(obj)
      })

      const clip = gltf.animations.find((a) => /flying/i.test(a.name)) || gltf.animations[0]
      if (clip) {
        mixer = new THREE.AnimationMixer(scene)
        flyClipDuration = clip.duration || 1
        flyAction = mixer.clipAction(clip)
        flyAction.play()
        flyAction.setEffectiveWeight(1)

        // Single sampling pass over the Flying clip: track the widest
        // horizontal span (wingspan, for WINGSPAN scaling below) AND the
        // narrowest (the "folded" reference pose for perched). Measured in
        // local model space, before this scene is parented into the live
        // graph.
        const box = new THREE.Box3()
        const size = new THREE.Vector3()
        let maxSpan = 0
        let minSpan = Infinity
        let minSpanTime = 0
        const SAMPLES = 24
        for (let i = 0; i < SAMPLES; i++) {
          const t = (flyClipDuration * i) / SAMPLES
          flyAction.time = t
          mixer.update(0)
          scene.updateMatrixWorld(true)
          box.setFromObject(scene)
          box.getSize(size)
          const span = Math.max(size.x, size.z)
          maxSpan = Math.max(maxSpan, span)
          if (span < minSpan) {
            minSpan = span
            minSpanTime = t
          }
        }

        flyAction.time = minSpanTime
        mixer.update(0)
        for (const bone of bones) boneBindQuats.set(bone, bone.quaternion.clone())

        flyAction.time = 0
        flyAction.setEffectiveWeight(0)
        restoreBindPose()
        scaleFactor = maxSpan > 1e-6 ? WINGSPAN / maxSpan : 1
      } else {
        // Shouldn't happen (the stripped GLB keeps exactly one clip) — warn
        // loudly and fall back to a plain bbox so the dragon still appears
        // at a sane size instead of silently vanishing.
        console.warn('[planet] dragon.js: no animation clip in dragon.glb — flight animation disabled')
        scene.updateMatrixWorld(true)
        const box = new THREE.Box3().setFromObject(scene)
        const size = new THREE.Vector3()
        box.getSize(size)
        const span = Math.max(size.x, size.z)
        scaleFactor = span > 1e-6 ? WINGSPAN / span : 1
      }

      modelRoot = new THREE.Group()
      modelRoot.name = 'dragonModelRoot'
      modelRoot.scale.setScalar(scaleFactor)
      modelRoot.add(scene)
      dragonPivot.add(modelRoot)
      ready = true
    })
    .catch((err) => {
      if (!warnedLoadFailed) {
        warnedLoadFailed = true
        console.warn(
          '[planet] dragon.js: failed to load ' +
            MODEL_URL +
            ' — the dragon will not appear: ' +
            (err && err.message),
        )
      }
    })

  // --- state machine ------------------------------------------------------
  // stateTimer is "seconds spent in the current state" and is also used
  // directly as the perched dwell clock (both reset together in
  // enterPerched(), so a separate perched-only timer would just duplicate it).
  let state = 'perched'
  let stateTimer = 0
  let perchedDwellTarget = PERCHED_DWELL_MIN + rng() * (PERCHED_DWELL_MAX - PERCHED_DWELL_MIN)

  let flightPlan = []
  let planIndex = 0
  let loopCountForThisPatrol = 1
  let circleAngle = 0
  let circleLoopsTotal = 1

  let flybyElapsed = 0
  let flybyThreshold = FLYBY_INTERVAL_MIN + rng() * (FLYBY_INTERVAL_MAX - FLYBY_INTERVAL_MIN)

  // head-turn idle flourish
  let headTurnState = 'idle' // 'idle' | 'in' | 'hold' | 'out'
  let headTurnTimer = HEAD_TURN_MIN + rng() * (HEAD_TURN_MAX - HEAD_TURN_MIN)
  let headTurnYaw = 0
  let headTurnTargetYaw = 0

  // flap/glide sub-phase (drives flyAction.timeScale + the vertical bob)
  let flapSubPhase = 'flap'
  let flapSubTimer = FLAP_BURST_MIN
  let flapHzCurrent = GLIDE_HZ
  let bobPhase = 0
  let soarWobblePhase = 0

  // motion-orientation running state
  let bankCurrent = 0
  let climbPitchCurrent = 0
  let prevAltitude = lairGroundR

  // --- scratch (persistent — no per-frame allocations) ---------------------
  const _dir = new THREE.Vector3().copy(lairDir)
  const _prevDir = new THREE.Vector3().copy(lairDir)
  const _fwd = new THREE.Vector3().copy(restingForward)
  const _prevFwd = new THREE.Vector3().copy(restingForward)
  const _right = new THREE.Vector3()
  const _moveDelta = new THREE.Vector3()
  const _tmpCross = new THREE.Vector3()
  const _basisMat = new THREE.Matrix4()
  const _baseQuat = new THREE.Quaternion()
  const _rollQuat = new THREE.Quaternion()
  const _pitchQuat = new THREE.Quaternion()
  const _headExtraQuat = new THREE.Quaternion()
  const _xAxis = new THREE.Vector3(1, 0, 0)
  const _yAxis = new THREE.Vector3(0, 1, 0)
  const _zAxis = new THREE.Vector3(0, 0, 1)
  const _circleAxis = new THREE.Vector3()
  const _circleStart = new THREE.Vector3()
  const _radial = new THREE.Vector3()
  const _settlementDir = new THREE.Vector3()
  const _transitTarget = new THREE.Vector3()
  const _takeoffFromDir = new THREE.Vector3()
  const _takeoffToDir = new THREE.Vector3()
  const _landingFromDir = new THREE.Vector3()

  /** rho radians from axis, in whatever direction best matches current heading — used to enter a circle without a pop. */
  function computeCircleStart(axis, rho, out) {
    _radial.copy(_dir).addScaledVector(axis, -_dir.dot(axis))
    if (_radial.lengthSq() < 1e-10) _radial.copy(_fwd).addScaledVector(axis, -_fwd.dot(axis))
    if (_radial.lengthSq() < 1e-10) _radial.copy(restingForward)
    _radial.normalize()
    out.copy(axis).multiplyScalar(Math.cos(rho)).addScaledVector(_radial, Math.sin(rho)).normalize()
  }

  function enterPerched() {
    state = 'perched'
    stateTimer = 0
    perchedDwellTarget = PERCHED_DWELL_MIN + rng() * (PERCHED_DWELL_MAX - PERCHED_DWELL_MIN)
    _dir.copy(lairDir)
    _prevDir.copy(lairDir)
    _fwd.copy(restingForward)
    _prevFwd.copy(restingForward)
    bankCurrent = 0
    climbPitchCurrent = 0
    prevAltitude = lairGroundR
    dragonPivot.position.copy(lairDir).multiplyScalar(lairGroundR)
    orientOnSurface(dragonPivot, lairDir, restingForward)
    if (flyAction) flyAction.setEffectiveWeight(0)
    if (modelRoot) modelRoot.scale.setScalar(scaleFactor)
    restoreBindPose()
  }

  function enterState(name) {
    state = name
    stateTimer = 0
    if (name === 'takeoff') {
      _takeoffFromDir.copy(_dir)
      flapSubPhase = 'flap'
      flapSubTimer = FLAP_BURST_MIN + rng() * (FLAP_BURST_MAX - FLAP_BURST_MIN)
      if (flightPlan[1] === 'transitOut') {
        _takeoffToDir.copy(lairDir)
        stepToward(_takeoffToDir, _settlementDir, TAKEOFF_ARC_ANGLE)
      } else {
        computeCircleStart(lairDir, CIRCLE_RADIUS_LAIR, _takeoffToDir)
      }
    } else if (name === 'circleLair') {
      _circleAxis.copy(lairDir)
      computeCircleStart(_circleAxis, CIRCLE_RADIUS_LAIR, _circleStart)
      circleAngle = 0
      circleLoopsTotal = loopCountForThisPatrol
    } else if (name === 'circleSettlement') {
      _circleAxis.copy(_settlementDir)
      computeCircleStart(_circleAxis, CIRCLE_RADIUS_SETTLEMENT, _circleStart)
      circleAngle = 0
      circleLoopsTotal = 1
    } else if (name === 'transitOut') {
      _transitTarget.copy(_settlementDir)
    } else if (name === 'transitBack') {
      _transitTarget.copy(lairDir)
    } else if (name === 'landing') {
      _landingFromDir.copy(_dir)
    }
  }

  function advancePlan() {
    planIndex++
    if (planIndex >= flightPlan.length) enterPerched()
    else enterState(flightPlan[planIndex])
  }

  function beginPatrolFlight() {
    loopCountForThisPatrol = 1 + Math.floor(rng() * 3) // "1-3 wide thermal circles", per spec
    flightPlan = ['takeoff', 'circleLair', 'landing']
    planIndex = 0
    enterState('takeoff')
  }

  function beginFlybyFlight(anchor) {
    _settlementDir.copy(anchor.anchorDir)
    flightPlan = ['takeoff', 'transitOut', 'circleSettlement', 'transitBack', 'landing']
    planIndex = 0
    enterState('takeoff')
  }

  /** perched's decision point: ordinary patrol, or (seeded timer + a busy
   * settlement) a flyby. Kept as one small entry point on purpose — a
   * future 'milestone appearance' feature can force a flyby by calling
   * beginFlybyFlight(anchor) directly from wherever that trigger lives;
   * out of scope for M2.5 itself, nothing new exported for it here. */
  function maybeStartFlight() {
    if (flybyElapsed >= flybyThreshold) {
      const busiest = findBusiestSettlement(world)
      const anchor = busiest ? findSettlementAnchor(world, busiest.project) : null
      if (anchor) {
        flybyElapsed = 0
        flybyThreshold = FLYBY_INTERVAL_MIN + rng() * (FLYBY_INTERVAL_MAX - FLYBY_INTERVAL_MIN)
        beginFlybyFlight(anchor)
        return
      }
    }
    beginPatrolFlight()
  }

  function updateFlapPhase(dt) {
    flapSubTimer -= dt
    if (flapSubTimer <= 0) {
      if (flapSubPhase === 'flap') {
        flapSubPhase = 'glide'
        flapSubTimer = GLIDE_MIN + rng() * (GLIDE_MAX - GLIDE_MIN)
      } else {
        flapSubPhase = 'flap'
        flapSubTimer = FLAP_BURST_MIN + rng() * (FLAP_BURST_MAX - FLAP_BURST_MIN)
      }
    }
    const targetHz = flapSubPhase === 'flap' ? FLAP_HZ : GLIDE_HZ
    flapHzCurrent += (targetHz - flapHzCurrent) * clamp(dt * FLAP_HZ_EASE_RATE, 0, 1)
    bobPhase += flapHzCurrent * Math.PI * 2 * dt
    soarWobblePhase += dt * 0.35
    if (flyAction) flyAction.timeScale = flapHzCurrent * flyClipDuration
  }

  /** Shared root-motion orientation: derives heading from this frame's
   * actual position change (so it's continuous across every state
   * transition by construction — whatever state set _dir this frame,
   * however it got there), banks into turns, pitches with climb/descent
   * rate plus an optional extra (the landing flare). */
  function applyFlightOrientation(dt, altitude, extraPitch) {
    _moveDelta.copy(_dir).sub(_prevDir)
    if (_moveDelta.lengthSq() > 1e-14) {
      _fwd.copy(_moveDelta).addScaledVector(_dir, -_moveDelta.dot(_dir))
      if (_fwd.lengthSq() > 1e-14) _fwd.normalize()
      else _fwd.copy(_prevFwd)
    } else {
      _fwd.copy(_prevFwd)
    }
    _right.crossVectors(_dir, _fwd).normalize()
    _fwd.crossVectors(_right, _dir).normalize() // re-orthogonalize, guards against drift
    _basisMat.makeBasis(_right, _dir, _fwd)
    _baseQuat.setFromRotationMatrix(_basisMat)

    _tmpCross.crossVectors(_prevFwd, _fwd)
    const turnAngle = Math.atan2(_tmpCross.dot(_dir), _prevFwd.dot(_fwd))
    const turnRate = dt > 1e-5 ? turnAngle / dt : 0
    const bankTarget = clamp(turnRate * BANK_GAIN, -BANK_MAX, BANK_MAX)
    bankCurrent += (bankTarget - bankCurrent) * clamp(dt * EASE_CHASE_RATE, 0, 1)

    const altRate = dt > 1e-5 ? (altitude - prevAltitude) / dt : 0
    const climbTarget = clamp(altRate * CLIMB_PITCH_GAIN, -CLIMB_PITCH_MAX, CLIMB_PITCH_MAX)
    climbPitchCurrent += (climbTarget - climbPitchCurrent) * clamp(dt * EASE_CHASE_RATE, 0, 1)

    _rollQuat.setFromAxisAngle(_zAxis, bankCurrent)
    _pitchQuat.setFromAxisAngle(_xAxis, -(climbPitchCurrent + (extraPitch || 0)))
    dragonPivot.quaternion.copy(_baseQuat).multiply(_rollQuat).multiply(_pitchQuat)
    dragonPivot.position.copy(_dir).multiplyScalar(altitude)

    _prevDir.copy(_dir)
    _prevFwd.copy(_fwd)
    prevAltitude = altitude
  }

  function soaringAltitude() {
    const alt =
      FLIGHT_ALT_MID + Math.sin(soarWobblePhase) * FLIGHT_ALT_WOBBLE + Math.sin(bobPhase) * BOB_AMPLITUDE
    return clamp(alt, FLIGHT_ALT_MIN, FLIGHT_ALT_MAX)
  }

  function updatePerchedIdle(dt) {
    // Force the bind pose (wings folded) every perched frame — see
    // restoreBindPose's own comment for why this can't just be left to the
    // AnimationAction's weight sitting at 0.
    restoreBindPose()
    if (modelRoot) {
      const breathe = 1 + Math.sin(stateTimer * BREATHE_HZ * Math.PI * 2) * BREATHE_AMPLITUDE
      modelRoot.scale.setScalar(scaleFactor * breathe)
    }
    if (!headBone) {
      // update() only reaches here once ready===true, so a still-null
      // headBone at this point means the loaded rig genuinely has no bone
      // by this name — warn once (placement.js's silent-fallback rule) and
      // skip the flourish rather than throw.
      if (!warnedNoHeadBone) {
        warnedNoHeadBone = true
        console.warn(
          '[planet] dragon.js: no "Head" bone found on the dragon rig — skipping the idle head-turn flourish',
        )
      }
      return
    }
    headTurnTimer -= dt
    if (headTurnState === 'idle') {
      if (headTurnTimer <= 0) {
        headTurnState = 'in'
        headTurnTimer = HEAD_TURN_EASE_IN
        headTurnTargetYaw = (rng() * 2 - 1) * HEAD_TURN_MAX_YAW
      }
    } else if (headTurnState === 'in') {
      const t = 1 - clamp(headTurnTimer / HEAD_TURN_EASE_IN, 0, 1)
      headTurnYaw = lerp(0, headTurnTargetYaw, smoothstep(0, 1, t))
      if (headTurnTimer <= 0) {
        headTurnState = 'hold'
        headTurnTimer = HEAD_TURN_HOLD
      }
    } else if (headTurnState === 'hold') {
      if (headTurnTimer <= 0) {
        headTurnState = 'out'
        headTurnTimer = HEAD_TURN_EASE_OUT
      }
    } else if (headTurnState === 'out') {
      const t = 1 - clamp(headTurnTimer / HEAD_TURN_EASE_OUT, 0, 1)
      headTurnYaw = lerp(headTurnTargetYaw, 0, smoothstep(0, 1, t))
      if (headTurnTimer <= 0) {
        headTurnState = 'idle'
        headTurnYaw = 0
        headTurnTimer = HEAD_TURN_MIN + rng() * (HEAD_TURN_MAX - HEAD_TURN_MIN)
      }
    }
    _headExtraQuat.setFromAxisAngle(_yAxis, headTurnYaw)
    headBone.quaternion.multiply(_headExtraQuat) // restoreBindPose() above already reset it to bind this frame
  }

  // --- per-state per-frame handlers ---------------------------------------
  function updateTakeoff(dt) {
    const t = clamp(stateTimer / TAKEOFF_DURATION, 0, 1)
    const e = smoothstep(0, 1, t)
    _dir.copy(_takeoffFromDir).lerp(_takeoffToDir, e).normalize()
    const alt = lerp(lairGroundR, FLIGHT_ALT_MID, e)
    updateFlapPhase(dt)
    applyFlightOrientation(dt, alt, 0)
    if (flyAction) flyAction.setEffectiveWeight(e)
    if (t >= 1) advancePlan()
  }

  function updateCircle(dt) {
    circleAngle += CIRCLE_ANGULAR_SPEED * dt
    _dir.copy(_circleStart).applyAxisAngle(_circleAxis, circleAngle)
    updateFlapPhase(dt)
    applyFlightOrientation(dt, soaringAltitude(), 0)
    if (flyAction) flyAction.setEffectiveWeight(1)
    if (circleAngle >= circleLoopsTotal * Math.PI * 2) advancePlan()
  }

  function updateTransit(dt) {
    const speedT = smoothstep(0, TRANSIT_EASE_TIME, stateTimer)
    const arrived = stepToward(_dir, _transitTarget, TRANSIT_SPEED * speedT * dt)
    updateFlapPhase(dt)
    applyFlightOrientation(dt, soaringAltitude(), 0)
    if (flyAction) flyAction.setEffectiveWeight(1)
    if (arrived) advancePlan()
  }

  function updateLanding(dt) {
    const t = clamp(stateTimer / LANDING_DURATION, 0, 1)
    const e = smoothstep(0, 1, t)
    _dir.copy(_landingFromDir).lerp(lairDir, e).normalize()
    const alt = lerp(FLIGHT_ALT_MID, lairGroundR, e)
    updateFlapPhase(dt)
    let flare = 0
    if (t > LANDING_FLARE_START) {
      const ft = clamp((t - LANDING_FLARE_START) / (1 - LANDING_FLARE_START), 0, 1)
      flare = Math.sin(ft * Math.PI) * FLARE_PITCH_MAX
    }
    applyFlightOrientation(dt, alt, flare)
    if (flyAction) flyAction.setEffectiveWeight(1 - e)
    if (t >= 1) advancePlan() // -> enterPerched(), which also hard-resets weight to 0
  }

  function update(dt, sunDir) {
    // sunDir accepted per contract for a future sky-reactive touch (e.g.
    // hoard glints catching extra light at dusk) — not required by this
    // milestone's spec, so intentionally unused for now.
    void sunDir
    flybyElapsed += dt
    // Lair is visible immediately (built synchronously below); the dragon
    // mesh itself just isn't loaded yet — sit quietly perched-and-invisible
    // rather than run the state machine against a model that isn't there.
    if (!ready) return
    stateTimer += dt

    switch (state) {
      case 'perched':
        updatePerchedIdle(dt)
        if (stateTimer >= perchedDwellTarget) maybeStartFlight()
        break
      case 'takeoff':
        updateTakeoff(dt)
        break
      case 'circleLair':
      case 'circleSettlement':
        updateCircle(dt)
        break
      case 'transitOut':
      case 'transitBack':
        updateTransit(dt)
        break
      case 'landing':
        updateLanding(dt)
        break
    }
    if (mixer) mixer.update(dt)
  }

  enterPerched()

  return { group, update }
}
