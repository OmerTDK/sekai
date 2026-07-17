// The living-world module: settlements, buildings, tiny working people, and
// labels, scattered deterministically across the planet from the Claude Code
// session history. Everything a user will ever see here is derived from
// string hashes (project path, session id) so relaunching the app rebuilds
// the identical village layout, then a 4s poll layers live activity on top.
//
// Structure/person geometry lives in buildings.js, placement search + surface
// math lives in placement.js, canvas label sprites live in labels.js, and
// the camera swoop/skim feel lives in cameraFeel.js (M-LD camera verdict) —
// this module is the orchestration layer: settlement/structure/agent
// records, ingest/polling, the per-frame update loop, click raycasting, the
// camera flight (delegated to cameraFeel when wired in, with a small
// built-in tween as a fallback), city lights, agent contact-shadow blobs,
// and the hammer-spark particle pool.
import * as THREE from 'three'
import { hash01, rngFromString, clamp, lerp, smoothstep } from './util.js'
import {
  RACE_KEYS,
  RACE_PALETTES,
  RACE_GLYPHS,
  KIT_UNIT_SIZE,
  TIER_MULT,
  makeSettlementName,
  pickStructureType,
  pickTier,
  truncateText,
  buildKit,
  buildPersonGroup,
  sphereGeo,
  hitMat,
  boxGeo,
  scaffoldMat,
} from './buildings.js'
import {
  findLandAnchor,
  findStructureSpot,
  randomLandNear,
  tangentBasis,
  yawedTangent,
  orientOnSurface,
  stepToward,
} from './placement.js'
import {
  makeSettlementSprite,
  makeTopicSprite,
  refreshTopicSprite,
  makeBubbleSprite,
  refreshBubbleSprite,
  applyLabelScale,
  SETTLEMENT_LABEL_K,
  SETTLEMENT_LABEL_MIN,
  SETTLEMENT_LABEL_MAX,
  TOPIC_LABEL_K,
  TOPIC_LABEL_MIN,
  TOPIC_LABEL_MAX,
  TOPIC_LABEL_REF_DIST,
} from './labels.js'

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

const POLL_INTERVAL = 4 // seconds between /api/sessions polls
const CONSTRUCTION_DURATION = 45 // seconds a fresh structure takes to "grow in"
const CONSTRUCTION_NEW_MAX_MS = 5 * 60 * 1000 // session must be this fresh to animate construction
const LABEL_THROTTLE = 0.3 // seconds between topic-label visibility checks
const TOPIC_VISIBLE_DIST = 0.5 // camera must be this close (world units) to see a topic label

const AGENT_SPEED = 0.01 // rad/s baseline walking angular speed
const WORKING_MAX_MS = 3 * 60 * 1000
const AGENT_MAX_MS = 10 * 60 * 1000

const PERSON_HEIGHT = 0.0055
const BOB_WALK = PERSON_HEIGHT * 0.16
const BOB_HAMMER = PERSON_HEIGHT * 0.3
const BOB_IDLE = PERSON_HEIGHT * 0.05
const FOOT_LIFT = PERSON_HEIGHT * 0.05

const CLICK_MOVE_THRESHOLD = 6 // px
const TWEEN_DURATION = 1.1 // seconds -- fallback-tween duration, used only when no cameraFeel is wired in

// Orbit label declutter (ART.md §7's flagged label-soup defect): above this
// camera radial distance, only a handful of settlement labels stay targeted
// at full opacity -- the rest ease toward invisible instead of piling into
// unreadable text soup. Below it, every settlement label is targeted at
// full opacity, same as before this task.
const SETTLEMENT_DECLUTTER_DIST = 2.0 // R
const SETTLEMENT_DECLUTTER_TOP_N = 8 // ranked by (agents desc, structures desc)
const SETTLEMENT_DECLUTTER_CENTER_RAD = 0.25 // radians of screen-center leeway -- always shown regardless of rank
const SETTLEMENT_LABEL_FADE_RATE = 4 // exponential ease rate (1/s) for the declutter opacity fade -- see dragon.js's identical dt-scaled convention

// Agent contact blobs (M-LD technique audit's "blob contact shadows" slot):
// a soft dark ground-flat ellipse under every worker/minion, tracking their
// true ground position -- NOT their walk-bob or foot-lift offset -- fixing
// the "grounded dwarf" defect where tiny people read as floating just above
// the terrain rather than standing on it.
const BLOB_WIDTH = 0.004 // world units
const BLOB_DEPTH_RATIO = 0.62 // squash factor for the ellipse look
const BLOB_OPACITY = 0.35
const BLOB_GROUND_OFFSET = 0.0006 // world units outward from sampleHeight -- avoids z-fighting with the terrain mesh

const BUBBLE_MAX_CHARS = 42 // speech-bubble text truncation
const BUBBLE_VISIBLE_DIST = 0.35 // camera must be this close (world units) to see a speech bubble
const BUBBLE_OFFSET = 0.004 // world units above the agent's ground position

const SPARK_POOL_SIZE = 120 // shared additive-particle budget for ALL agents' hammer sparks
const SPARK_BURST_MIN = 5
const SPARK_BURST_MAX = 8
const SPARK_TTL = 0.55 // seconds a spark particle lives
const SPARK_GRAVITY = 0.015 // gravity-lite pull back toward the surface, world units/s^2
const SPARK_COOLDOWN_MIN = 0.35 // seconds between bursts from the same hammering agent
const SPARK_COOLDOWN_RANGE = 0.25

const MINION_MAX = 6 // subagent workers rendered per session, even if the real count is higher
const MINION_SCALE = 0.5 // half-size vs a normal worker

const STRUCT_HIT_RADIUS = 0.012 // invisible click-target sphere radius per structure

// Steam/smoke plumes: the "alive" signal (art direction §0.5) — every
// structure whose session is currently WORKING breathes soft gray-white
// puffs. Pattern-copied from the spark pool above, but additive OFF (normal
// blending + real per-vertex alpha, see spawnPlumePuff) so it reads as
// vapor, not glow.
const PLUME_POOL_SIZE = 200 // shared particle budget for ALL structures' plumes
const PLUME_EMIT_INTERVAL = 0.8 // seconds between puffs, per active structure
const PLUME_TTL = 2.5 // seconds a puff lives
const PLUME_RISE_SPEED = 0.01 // world units/s outward along the structure's surface normal
const PLUME_DRIFT_SPEED = 0.0015 // world units/s lateral wander, tangent to the surface
const PLUME_EMIT_OFFSET = 0.012 // world units outward from the anchor along dir — roughly rooftop height
const PLUME_PEAK_ALPHA = 0.4
const PLUME_SIZE = 7 // PointsMaterial size, screen-space (sizeAttenuation: false)
const PLUME_FADE_IN = 0.2 // seconds — avoids a hard pop-in at spawn

// ---------------------------------------------------------------------------
// Scratch tangent-basis vectors for the tangentBasis() calls made directly
// from this module (spark bursts, agent/minion forward vectors) — duplicated
// from placement.js's own private copy rather than shared via an export,
// since these are write-before-read scratch (see the M2 program plan's
// split notes on module-level scratch vectors).
// ---------------------------------------------------------------------------
const _tb1 = new THREE.Vector3()
const _tb2 = new THREE.Vector3()

// Scratch for composing a structure anchor's position/quaternion/scale into
// the Matrix4 pushed to assets.js's setVisualMatrix (see pushVisualMatrix) —
// same write-before-read scratch convention as _tb1/_tb2 above.
const _visMat = new THREE.Matrix4()
const _visScale = new THREE.Vector3()

// Scratch for the orbit label-declutter "near screen center" check (see the
// throttled settlement-label pass in update()) — same write-before-read
// scratch convention as _tb1/_tb2 above.
const _camForwardScratch = new THREE.Vector3()
const _toSettlementScratch = new THREE.Vector3()

// ---------------------------------------------------------------------------
// Silent-fallback rule: every graceful-degradation path warns exactly once
// (module-level flags — these searches run per-settlement/per-structure and
// the ingest/poll paths repeat every 4s, so a plain warn would spam).
// ---------------------------------------------------------------------------
let warnedIngestSkip = false
let warnedPoll = false
let warnedStructureClickCb = false

function warnIngestSkip(reason) {
  if (warnedIngestSkip) return
  warnedIngestSkip = true
  console.warn(
    '[planet] world.js: session ingest degraded — skipped a malformed session entry (' + reason + ')',
  )
}

function warnPoll(reason) {
  if (warnedPoll) return
  warnedPoll = true
  console.warn('[planet] world.js: session poll degraded — ' + reason)
}

// M2 asset-pack integration (see assets.js's pinned contract in the M2 JIT
// plan): loadBuildingAssets() is imported dynamically and guarded — the
// pack may not exist yet, may throw on import, or may reject/report
// not-ready (missing WEBGL features). Either way the world must render
// identically to before via the procedural buildKit path, so both failure
// modes get their own single warning (load-time vs. per-structure).
let warnedAssetsLoad = false
let warnedAssetsCreate = false

function warnAssetsLoad(reason) {
  if (warnedAssetsLoad) return
  warnedAssetsLoad = true
  console.warn(
    '[planet] world.js: building-asset pack unavailable — using the procedural buildKit fallback for all structures (' +
      reason +
      ')',
  )
}

function warnAssetsCreate(reason) {
  if (warnedAssetsCreate) return
  warnedAssetsCreate = true
  console.warn(
    '[planet] world.js: asset-pack structure visual failed at least once — falling back to procedural buildKit for the affected structure(s) (' +
      reason +
      ')',
  )
}

// ---------------------------------------------------------------------------
// createWorld
// ---------------------------------------------------------------------------

export function createWorld(planet, camera, domElement, renderer = null, cameraFeel = null) {
  const group = new THREE.Group()
  const settlementsGroup = new THREE.Group()
  const structuresGroup = new THREE.Group()
  const agentsGroup = new THREE.Group()

  // City lights: one warm additive speck per structure, so settlements
  // twinkle on the night side (bloom gives them their halo). Rebuilt
  // whenever the structure count changes.
  const townLightsMat = new THREE.PointsMaterial({
    color: 0xffc66e,
    size: 2.4,
    sizeAttenuation: false,
    transparent: true,
    opacity: 0.85,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  })
  let townLights = null
  let townLightCount = -1
  function rebuildTownLights() {
    townLightCount = structures.size
    townLightsDirty = false
    if (townLights) {
      structuresGroup.remove(townLights)
      townLights.geometry.dispose()
    }
    // Filtered set: while a time-lapse cutoff is active, only currently-
    // visible structures twinkle — a plain array first since the visible
    // count (unlike structures.size) isn't known ahead of time.
    const coords = []
    for (const st of structures.values()) {
      if (!st.timeVisible) continue
      coords.push(
        st.structureRoot.position.x + st.dir.x * 0.004,
        st.structureRoot.position.y + st.dir.y * 0.004,
        st.structureRoot.position.z + st.dir.z * 0.004,
      )
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(coords), 3))
    townLights = new THREE.Points(geo, townLightsMat)
    townLights.renderOrder = 1
    structuresGroup.add(townLights)
  }
  group.add(settlementsGroup, structuresGroup, agentsGroup)

  // ---------------------------------------------------------------------------
  // M2 asset-pack bootstrap (see the pinned contract in the M2 JIT plan).
  // renderer isn't available in world.js, so loadBuildingAssets is called
  // with null; a dynamic import means a missing/half-written assets.js
  // degrades to the procedural buildKit path instead of breaking the whole
  // module at import time. Structures created before this resolves keep
  // their procedural visuals forever — no retro-swap, per the spec.
  // ---------------------------------------------------------------------------
  let assetsApi = null
  let assetsReady = false

  ;(async function initAssets() {
    let mod
    try {
      mod = await import('./assets.js')
    } catch (e) {
      warnAssetsLoad('import failed: ' + e)
      return
    }
    try {
      const api = await mod.loadBuildingAssets(renderer)
      if (api && api.ready) {
        assetsApi = api
        assetsReady = true
        group.add(api.group)
      } else {
        warnAssetsLoad('loadBuildingAssets reported not-ready (missing WebGL features or a load failure)')
      }
    } catch (e) {
      warnAssetsLoad('loadBuildingAssets rejected: ' + e)
    }
  })()

  // Composes a structure anchor's current position/quaternion/visualScale
  // into a Matrix4 and pushes it to the asset pack. Anchor position/
  // quaternion never change after creation (structures are static), so this
  // only needs to run at creation and whenever visualScale itself changes
  // (construction growth, tier change) — never per-frame for settled
  // structures. assets.js's contract asks for the FULL WORLD matrix; every
  // ancestor from structureRoot up to the scene (structuresGroup, this
  // world's own `group`) is identity-transformed, so structureRoot's local
  // position/quaternion/scale composition already equals its world matrix —
  // confirmed against assets.js's actual setVisualMatrix contract comment.
  function pushVisualMatrix(structure) {
    if (!assetsApi || structure.visualHandle == null) return
    _visMat.compose(
      structure.structureRoot.position,
      structure.structureRoot.quaternion,
      _visScale.setScalar(structure.visualScale),
    )
    assetsApi.setVisualMatrix(structure.visualHandle, _visMat)
  }

  // Hammer sparks: one shared additive-particle pool for every agent's
  // hammering animation, round-robin allocated so a burst never allocates.
  const sparkPositions = new Float32Array(SPARK_POOL_SIZE * 3)
  const sparkColors = new Float32Array(SPARK_POOL_SIZE * 3)
  const sparkVelocity = new Float32Array(SPARK_POOL_SIZE * 3)
  const sparkDown = new Float32Array(SPARK_POOL_SIZE * 3)
  const sparkAge = new Float32Array(SPARK_POOL_SIZE)
  const sparkTtl = new Float32Array(SPARK_POOL_SIZE) // 0 = free/dead slot
  let sparkCursor = 0
  const sparkGeo = new THREE.BufferGeometry()
  sparkGeo.setAttribute('position', new THREE.BufferAttribute(sparkPositions, 3))
  sparkGeo.setAttribute('color', new THREE.BufferAttribute(sparkColors, 3))
  const sparkPointsMat = new THREE.PointsMaterial({
    color: 0xffb347,
    size: 3,
    sizeAttenuation: false,
    vertexColors: true,
    transparent: true,
    opacity: 0.9,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  })
  const sparkPoints = new THREE.Points(sparkGeo, sparkPointsMat)
  sparkPoints.renderOrder = 2
  sparkPoints.frustumCulled = false // pool slots can sit anywhere on the planet
  agentsGroup.add(sparkPoints)

  function spawnSparkBurst(originPos, normalDir) {
    const count = SPARK_BURST_MIN + Math.floor(Math.random() * (SPARK_BURST_MAX - SPARK_BURST_MIN + 1))
    tangentBasis(normalDir, _tb1, _tb2)
    for (let n = 0; n < count; n++) {
      const slot = sparkCursor
      sparkCursor = (sparkCursor + 1) % SPARK_POOL_SIZE
      const i3 = slot * 3
      sparkPositions[i3] = originPos.x
      sparkPositions[i3 + 1] = originPos.y
      sparkPositions[i3 + 2] = originPos.z
      const a = Math.random() * Math.PI * 2
      const spread = 0.0025 + Math.random() * 0.004
      const up = 0.004 + Math.random() * 0.003
      const tx = _tb1.x * Math.cos(a) + _tb2.x * Math.sin(a)
      const ty = _tb1.y * Math.cos(a) + _tb2.y * Math.sin(a)
      const tz = _tb1.z * Math.cos(a) + _tb2.z * Math.sin(a)
      sparkVelocity[i3] = tx * spread + normalDir.x * up
      sparkVelocity[i3 + 1] = ty * spread + normalDir.y * up
      sparkVelocity[i3 + 2] = tz * spread + normalDir.z * up
      sparkDown[i3] = -normalDir.x
      sparkDown[i3 + 1] = -normalDir.y
      sparkDown[i3 + 2] = -normalDir.z
      sparkAge[slot] = 0
      sparkTtl[slot] = SPARK_TTL * (0.7 + Math.random() * 0.6)
      sparkColors[i3] = 1
      sparkColors[i3 + 1] = 1
      sparkColors[i3 + 2] = 1
    }
  }

  function updateSparks(dt) {
    for (let slot = 0; slot < SPARK_POOL_SIZE; slot++) {
      const t = sparkTtl[slot]
      if (t <= 0) continue
      const a = sparkAge[slot] + dt
      const i3 = slot * 3
      if (a >= t) {
        sparkTtl[slot] = 0
        sparkColors[i3] = sparkColors[i3 + 1] = sparkColors[i3 + 2] = 0
        continue
      }
      sparkAge[slot] = a
      sparkVelocity[i3] += sparkDown[i3] * SPARK_GRAVITY * dt
      sparkVelocity[i3 + 1] += sparkDown[i3 + 1] * SPARK_GRAVITY * dt
      sparkVelocity[i3 + 2] += sparkDown[i3 + 2] * SPARK_GRAVITY * dt
      sparkPositions[i3] += sparkVelocity[i3] * dt
      sparkPositions[i3 + 1] += sparkVelocity[i3 + 1] * dt
      sparkPositions[i3 + 2] += sparkVelocity[i3 + 2] * dt
      const fade = 1 - a / t
      sparkColors[i3] = sparkColors[i3 + 1] = sparkColors[i3 + 2] = fade
    }
    sparkGeo.attributes.position.needsUpdate = true
    sparkGeo.attributes.color.needsUpdate = true
  }

  // Steam/smoke plumes: shared particle pool, pattern-copied from the spark
  // pool above but with a real per-vertex ALPHA channel (color itemSize 4 —
  // three.js auto-enables USE_COLOR_ALPHA for exactly this shape; see
  // WebGLRenderer's vertexAlphas check) instead of fading color-to-black,
  // since color-to-black only reads as "fade out" under additive blending.
  // Blending stays the THREE default (normal) — "additive OFF" is
  // deliberate here: vapor, not glow.
  const plumePositions = new Float32Array(PLUME_POOL_SIZE * 3)
  const plumeColors = new Float32Array(PLUME_POOL_SIZE * 4) // RGBA — itemSize 4 is what enables true per-vertex alpha
  const plumeVelocity = new Float32Array(PLUME_POOL_SIZE * 3)
  const plumeAge = new Float32Array(PLUME_POOL_SIZE)
  const plumeTtl = new Float32Array(PLUME_POOL_SIZE) // 0 = free/dead slot
  let plumeCursor = 0
  const plumeGeo = new THREE.BufferGeometry()
  plumeGeo.setAttribute('position', new THREE.BufferAttribute(plumePositions, 3))
  plumeGeo.setAttribute('color', new THREE.BufferAttribute(plumeColors, 4))
  const plumePointsMat = new THREE.PointsMaterial({
    size: PLUME_SIZE,
    sizeAttenuation: false,
    vertexColors: true,
    transparent: true,
    opacity: 1,
    blending: THREE.NormalBlending,
    depthWrite: false,
  })
  const plumePoints = new THREE.Points(plumeGeo, plumePointsMat)
  plumePoints.renderOrder = 1
  plumePoints.frustumCulled = false // pool slots can sit anywhere on the planet
  structuresGroup.add(plumePoints)

  function spawnPlumePuff(st) {
    const slot = plumeCursor
    plumeCursor = (plumeCursor + 1) % PLUME_POOL_SIZE
    const i3 = slot * 3
    const i4 = slot * 4
    plumePositions[i3] = st.structureRoot.position.x + st.dir.x * PLUME_EMIT_OFFSET
    plumePositions[i3 + 1] = st.structureRoot.position.y + st.dir.y * PLUME_EMIT_OFFSET
    plumePositions[i3 + 2] = st.structureRoot.position.z + st.dir.z * PLUME_EMIT_OFFSET
    tangentBasis(st.dir, _tb1, _tb2)
    const a = Math.random() * Math.PI * 2
    plumeVelocity[i3] =
      (_tb1.x * Math.cos(a) + _tb2.x * Math.sin(a)) * PLUME_DRIFT_SPEED + st.dir.x * PLUME_RISE_SPEED
    plumeVelocity[i3 + 1] =
      (_tb1.y * Math.cos(a) + _tb2.y * Math.sin(a)) * PLUME_DRIFT_SPEED + st.dir.y * PLUME_RISE_SPEED
    plumeVelocity[i3 + 2] =
      (_tb1.z * Math.cos(a) + _tb2.z * Math.sin(a)) * PLUME_DRIFT_SPEED + st.dir.z * PLUME_RISE_SPEED
    plumeAge[slot] = 0
    plumeTtl[slot] = PLUME_TTL * (0.85 + Math.random() * 0.3)
    const g = 0.82 + Math.random() * 0.12
    plumeColors[i4] = g
    plumeColors[i4 + 1] = g
    plumeColors[i4 + 2] = Math.min(1, g + 0.03)
    plumeColors[i4 + 3] = 0 // starts transparent; updatePlumes fades it in over PLUME_FADE_IN
  }

  function updatePlumes(dt) {
    for (let slot = 0; slot < PLUME_POOL_SIZE; slot++) {
      const t = plumeTtl[slot]
      if (t <= 0) continue
      const a = plumeAge[slot] + dt
      const i3 = slot * 3
      const i4 = slot * 4
      if (a >= t) {
        plumeTtl[slot] = 0
        plumeColors[i4 + 3] = 0
        continue
      }
      plumeAge[slot] = a
      plumePositions[i3] += plumeVelocity[i3] * dt
      plumePositions[i3 + 1] += plumeVelocity[i3 + 1] * dt
      plumePositions[i3 + 2] += plumeVelocity[i3 + 2] * dt
      const fadeIn = a < PLUME_FADE_IN ? a / PLUME_FADE_IN : 1
      plumeColors[i4 + 3] = PLUME_PEAK_ALPHA * fadeIn * (1 - a / t)
    }
    plumeGeo.attributes.position.needsUpdate = true
    plumeGeo.attributes.color.needsUpdate = true
  }

  // Per-structure emission timer: only structures whose session is
  // currently WORKING (same threshold an agent uses for its own hammer/work
  // phase) breathe smoke. New spawns are suppressed while a time-lapse
  // cutoff is active (nowMs vs. lastActive would be comparing live "now" to
  // a scrubbed-to timestamp, which is meaningless) — in-flight puffs are
  // left to fade out naturally rather than snapping off.
  function updateStructurePlumes(dt, nowMs) {
    if (timeCutoff != null) return
    for (const st of structures.values()) {
      if (nowMs - st.lastActive >= WORKING_MAX_MS) continue
      st.plumeTimer -= dt
      if (st.plumeTimer <= 0) {
        st.plumeTimer = PLUME_EMIT_INTERVAL * (0.85 + Math.random() * 0.3)
        spawnPlumePuff(st)
      }
    }
  }

  // Agent contact blobs: one shared canvas texture + geometry + material for
  // every blob in the world (see the BLOB_* tunables above for the "grounded
  // dwarf" background) — only the per-agent Mesh (position/orientation/
  // scale) is unique, so a busy settlement costs one shared draw-call-worth
  // of GL state, not N.
  //
  // A THREE.Sprite (always camera-facing) was considered and rejected: this
  // app's own ground-sunlit viewpoint looks nearly horizontally along the
  // terrain (verifykit.js), and a billboarded blob at that grazing angle
  // reads as a floating card next to the character, not a shadow on the
  // ground beneath them. A flat, surface-oriented quad — the same
  // orientOnSurface convention already used for every other ground object in
  // this file — reads correctly from any angle, including the one that
  // matters most here.
  function buildBlobTexture() {
    const size = 64
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const ctx = canvas.getContext('2d')
    const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
    grad.addColorStop(0, 'rgba(8,7,6,0.9)')
    grad.addColorStop(0.55, 'rgba(8,7,6,0.5)')
    grad.addColorStop(1, 'rgba(8,7,6,0)')
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, size, size)
    const tex = new THREE.CanvasTexture(canvas)
    tex.colorSpace = THREE.SRGBColorSpace
    return tex
  }
  // PlaneGeometry's default face-normal is local +Z; rotated here so the
  // visible face is local +Y instead, matching orientOnSurface's contract
  // ("local +Y matches the surface normal").
  const blobGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2)
  const blobTexture = buildBlobTexture()
  const blobMaterial = new THREE.MeshBasicMaterial({
    map: blobTexture,
    transparent: true,
    opacity: BLOB_OPACITY,
    depthWrite: false,
  })

  function makeBlobMesh() {
    const mesh = new THREE.Mesh(blobGeo, blobMaterial)
    mesh.renderOrder = 1
    agentsGroup.add(mesh)
    return mesh
  }

  // Tracks the agent/minion's true ground position (dir * groundR, no
  // walk-bob or foot-lift) rather than their bouncing visual position — a
  // shadow that bobbed along with its owner would read as attached to them,
  // not resting on the ground beneath them. scaleMult lets callers shrink
  // the blob with a despawning agent's own fadeScale, or a minion's
  // half-size MINION_SCALE.
  function updateBlobTransform(mesh, dir, forward, groundR, scaleMult) {
    mesh.position.copy(dir).multiplyScalar(groundR + BLOB_GROUND_OFFSET)
    orientOnSurface(mesh, dir, forward)
    mesh.scale.set(BLOB_WIDTH * scaleMult, BLOB_WIDTH * BLOB_DEPTH_RATIO * scaleMult, 1)
  }

  const stats = { settlements: 0, structures: 0, agents: 0 }

  const settlements = new Map() // project -> settlement record
  const structures = new Map() // session id -> structure record
  const agents = new Map() // session id -> agent record
  const minions = new Map() // session id -> array of half-size subagent-worker records
  const knownIds = new Set() // every session id ever observed
  const constructingSet = new Set() // structure records currently growing in
  const hitSpheres = [] // invisible raycast targets for click-to-visit (settlements)
  const structureHitSpheres = [] // invisible raycast targets for click-to-visit (structures)
  const structureClickCallbacks = [] // subscribers registered via onStructureClick()

  let simTime = 0
  let pollTimer = 0
  let labelThrottle = 0
  let townLightsDirty = true // set whenever any structure's timeVisible flips — forces rebuildTownLights beyond just the size-changed check

  // --- time-lapse filter state (setTimeFilter/getTimeRange) -----------------
  // timeCutoff: null = live (nothing filtered). timeSorted: all structures
  // ascending by lastActive, rebuilt lazily (see ensureTimeSorted) only when
  // ingest() has actually touched the data — cheap to leave stale between
  // polls since setTimeFilter is the ~30x/s hot path and never re-sorts
  // itself. timeVisibleUpTo: boundary index into timeSorted — [0,
  // timeVisibleUpTo) are the currently-visible structures — so a scrub that
  // doesn't cross any structure's timestamp touches nothing at all.
  let timeCutoff = null
  let timeSorted = []
  let timeSortedDirty = true
  let timeVisibleUpTo = 0

  const raycaster = new THREE.Raycaster()
  const ndc = new THREE.Vector2()
  const tween = { active: false, from: new THREE.Vector3(), to: new THREE.Vector3(), t: 0 }
  const _fwdCalc = new THREE.Vector3()
  const _yawScratch = new THREE.Vector3()

  function updateAgentForward(agent, target) {
    _fwdCalc.copy(target).sub(agent.dir)
    _fwdCalc.addScaledVector(agent.dir, -_fwdCalc.dot(agent.dir))
    if (_fwdCalc.lengthSq() > 1e-10) agent.forward.copy(_fwdCalc).normalize()
  }

  // --- settlement -----------------------------------------------------------

  function createSettlementRecord(project) {
    const u = hash01(project)
    const v = hash01(project + '~lon')
    const lat = Math.asin(clamp(2 * u - 1, -1, 1))
    const lon = 2 * Math.PI * v
    const base = new THREE.Vector3(
      Math.cos(lat) * Math.cos(lon),
      Math.sin(lat),
      Math.cos(lat) * Math.sin(lon),
    )

    const anchorRng = rngFromString(project)
    const anchorDir = findLandAnchor(planet, base, anchorRng)
    const groundR = planet.sampleHeight(anchorDir)

    const race = RACE_KEYS[Math.floor(hash01(project + '~race') * RACE_KEYS.length)]
    const pal = RACE_PALETTES[race]
    const { name, basenameRaw } = makeSettlementName(project, race)
    const accentCss = '#' + pal.accent.toString(16).padStart(6, '0')

    const labelSprite = makeSettlementSprite(RACE_GLYPHS[race], name, basenameRaw, accentCss)
    labelSprite.position.copy(anchorDir).multiplyScalar(groundR + 0.035)
    settlementsGroup.add(labelSprite)

    const hitMesh = new THREE.Mesh(sphereGeo(), hitMat())
    hitMesh.visible = false
    hitMesh.position.copy(anchorDir).multiplyScalar(groundR)
    hitMesh.scale.setScalar(0.08) // sphereGeo radius 0.5 -> world radius 0.04
    settlementsGroup.add(hitMesh)

    const settlement = {
      project,
      anchorDir,
      groundR,
      race,
      name,
      basenameRaw,
      labelSprite,
      hitMesh,
      structureDirs: [],
      visibleStructureCount: 0,
      labelWantVisible: true,
    }
    hitMesh.userData.settlement = settlement
    hitSpheres.push(hitMesh)
    return settlement
  }

  // --- structure --------------------------------------------------------------

  function createStructureRecord(id, settlement, topic, bytes, lastActive, animate, model) {
    const rng = rngFromString(id)
    const dir = findStructureSpot(planet, settlement.anchorDir, rng, settlement.structureDirs)
    const groundR = planet.sampleHeight(dir)

    const type = pickStructureType(topic, id)
    const tier = pickTier(bytes)
    const finalScale = KIT_UNIT_SIZE[type] * TIER_MULT[tier - 1]

    const structureRoot = new THREE.Group()
    const yaw = rng() * Math.PI * 2
    yawedTangent(dir, yaw, _yawScratch)
    orientOnSurface(structureRoot, dir, _yawScratch)
    structureRoot.position.copy(dir).multiplyScalar(groundR - 0.0005 * finalScale)

    const initialVisualScale = animate ? finalScale * 0.05 : finalScale

    // Asset-pack visual (M2): once assets.js has resolved, new structures
    // are built from its merged/batched geometry instead of the procedural
    // buildKit primitives. structureRoot remains the anchor either way —
    // its position/quaternion are unchanged from before this task, and
    // topicSprite/scaffold/hitMesh/city-lights all still key off it exactly
    // as today. Falls back to buildKit per-structure (not just globally) so
    // one bad (type,tier,race) combo can never take the whole world down.
    // seedStr folds in the model-tier hint (M2 task 4) so asset selection
    // can vary by model later without another world.js change.
    let kitGroup = null
    let visualHandle = null
    let boundingRadius = null
    if (assetsReady) {
      try {
        const seedStr = id + ':' + (model || '')
        const res = assetsApi.createStructureVisual(type, tier, settlement.race, seedStr)
        if (!res || res.handle == null) throw new Error('no handle returned')
        visualHandle = res.handle
        if (Number.isFinite(res.boundingRadius) && res.boundingRadius > 0) boundingRadius = res.boundingRadius
      } catch (e) {
        warnAssetsCreate(String(e))
        visualHandle = null
      }
    }
    if (visualHandle == null) {
      kitGroup = buildKit(type, settlement.race, tier, rng)
      kitGroup.scale.setScalar(initialVisualScale)
      structureRoot.add(kitGroup)
    }

    const topicSprite = makeTopicSprite(truncateText(topic, 44))
    topicSprite.visible = false
    topicSprite.position.set(0, finalScale * 1.3, 0)
    applyLabelScale(topicSprite, TOPIC_LABEL_REF_DIST, TOPIC_LABEL_K, TOPIC_LABEL_MIN, TOPIC_LABEL_MAX)
    structureRoot.add(topicSprite)

    let scaffold = null
    if (animate) {
      scaffold = new THREE.Mesh(boxGeo(), scaffoldMat())
      scaffold.scale.setScalar(finalScale * 1.3)
      scaffold.position.set(0, finalScale * 0.5, 0)
      structureRoot.add(scaffold)
    }

    structuresGroup.add(structureRoot)

    // Invisible click target for the structure inspector (onStructureClick).
    const hitMesh = new THREE.Mesh(sphereGeo(), hitMat())
    hitMesh.visible = false
    hitMesh.position.copy(dir).multiplyScalar(groundR)
    hitMesh.scale.setScalar(STRUCT_HIT_RADIUS * 2) // sphereGeo radius 0.5 -> world radius STRUCT_HIT_RADIUS
    structuresGroup.add(hitMesh)

    const structure = {
      id,
      dir,
      groundR,
      type,
      tier,
      bytes,
      topic,
      lastActive,
      model: model || null,
      settlement,
      finalScale,
      structureRoot,
      kitGroup,
      visualHandle,
      visualScale: initialVisualScale,
      boundingRadius,
      scaffold,
      topicSprite,
      hitMesh,
      constructing: !!animate,
      constructionT: 0,
      timeVisible: false, // sentinel — setStructureVisible() below establishes the real initial state
      plumeTimer: Math.random() * PLUME_EMIT_INTERVAL,
    }
    hitMesh.userData.structure = structure
    structureHitSpheres.push(hitMesh)
    settlement.structureDirs.push(dir)
    if (animate) constructingSet.add(structure)
    if (visualHandle != null) pushVisualMatrix(structure)
    setStructureVisible(structure, timeCutoff == null || lastActive <= timeCutoff)
    return structure
  }

  function updateStructureData(structure, topic, bytes, lastActive, model) {
    structure.lastActive = lastActive
    structure.model = model || null
    if (topic !== structure.topic) {
      structure.topic = topic
      refreshTopicSprite(structure.topicSprite, truncateText(topic, 44))
    }
    if (bytes !== structure.bytes) {
      structure.bytes = bytes
      const tier = pickTier(bytes)
      if (tier !== structure.tier) {
        structure.tier = tier
        structure.finalScale = KIT_UNIT_SIZE[structure.type] * TIER_MULT[tier - 1]
        if (!structure.constructing) {
          if (structure.kitGroup) {
            structure.kitGroup.scale.setScalar(structure.finalScale)
          } else if (structure.visualHandle != null) {
            structure.visualScale = structure.finalScale
            pushVisualMatrix(structure)
          }
        }
        structure.topicSprite.position.set(0, structure.finalScale * 1.3, 0)
      }
    }
  }

  // --- time-lapse filter (setTimeFilter/getTimeRange) ------------------------
  //
  // Single choke point for structure visibility: toggles the anchor itself
  // (cascades to topicSprite/scaffold/kitGroup, all its children — three.js
  // never renders into an invisible object's subtree) AND the asset-pack
  // visual (a separate object living in assets.js's own group, outside
  // structureRoot's subtree, so it needs its own explicit call), keeps each
  // settlement's visible-structure count in sync for the "hide empty
  // settlement labels" rule, and marks city lights dirty. Click-through is
  // guarded separately in onPointerUp — three.js's Raycaster ignores
  // Object3D.visible entirely, so hiding the anchor alone would NOT stop a
  // hidden structure's hitMesh from still being clickable.
  function setStructureVisible(st, visible) {
    if (st.timeVisible === visible) return
    st.timeVisible = visible
    st.structureRoot.visible = visible
    if (st.visualHandle != null && assetsApi) assetsApi.setVisualVisible(st.visualHandle, visible)
    st.settlement.visibleStructureCount += visible ? 1 : -1
    st.settlement.labelSprite.visible = st.settlement.visibleStructureCount > 0
    townLightsDirty = true
  }

  // Binary search: count of timeSorted entries with lastActive <= cutoff
  // (null cutoff = everything, i.e. live mode).
  function computeTimeBoundary(cutoff) {
    if (cutoff == null) return timeSorted.length
    let lo = 0
    let hi = timeSorted.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (timeSorted[mid].lastActive <= cutoff) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  // Full O(n) correctness pass — only runs right after timeSorted was just
  // rebuilt (i.e. at most once per ingest(), never mid-scrub): a structure's
  // lastActive can only increase over real time, so a live/active structure
  // that was visible under a fixed historical cutoff can drift to hidden
  // between rebuilds; this reconciles any such drift before resuming the
  // fast incremental path below. setStructureVisible's own early-return
  // makes the common no-op case (nothing actually changed) cheap.
  function reconcileTimeVisibility() {
    for (let i = 0; i < timeSorted.length; i++) {
      const st = timeSorted[i]
      setStructureVisible(st, timeCutoff == null || st.lastActive <= timeCutoff)
    }
    timeVisibleUpTo = computeTimeBoundary(timeCutoff)
  }

  function ensureTimeSorted() {
    if (!timeSortedDirty) return
    timeSorted = Array.from(structures.values()).sort((a, b) => a.lastActive - b.lastActive)
    timeSortedDirty = false
    reconcileTimeVisibility()
  }

  // setTimeFilter(cutoffMs|null): the ~30x/s scrubber hot path. When
  // timeSorted is already fresh (the common case — no ingest happened since
  // the last call) this does zero allocation and zero sorting: a binary
  // search for the new boundary, then only touches the structures whose
  // visibility actually flips between the old and new boundary.
  function setTimeFilter(cutoffMsRaw) {
    const cutoff = typeof cutoffMsRaw === 'number' && Number.isFinite(cutoffMsRaw) ? cutoffMsRaw : null
    ensureTimeSorted()

    const wasFiltering = timeCutoff !== null
    timeCutoff = cutoff
    const isFiltering = cutoff !== null
    if (isFiltering !== wasFiltering) agentsGroup.visible = !isFiltering // agents/minions/bubbles/sparks all live under agentsGroup

    const newBoundary = computeTimeBoundary(cutoff)
    if (newBoundary !== timeVisibleUpTo) {
      if (newBoundary > timeVisibleUpTo) {
        for (let i = timeVisibleUpTo; i < newBoundary; i++) setStructureVisible(timeSorted[i], true)
      } else {
        for (let i = newBoundary; i < timeVisibleUpTo; i++) setStructureVisible(timeSorted[i], false)
      }
      timeVisibleUpTo = newBoundary
    }
  }

  function getTimeRange() {
    ensureTimeSorted()
    if (timeSorted.length === 0) return { min: 0, max: 0 }
    return { min: timeSorted[0].lastActive, max: timeSorted[timeSorted.length - 1].lastActive }
  }

  // --- agent ------------------------------------------------------------------

  function createAgentRecord(id, settlement, structure) {
    const rng = rngFromString(id + '~agent')
    const visual = buildPersonGroup(settlement.race)
    const visualGroup = new THREE.Group()
    visualGroup.add(visual)
    agentsGroup.add(visualGroup)
    const blobMesh = makeBlobMesh()

    const wanderPoints = [structure.dir.clone()]
    for (let i = 0; i < 3; i++) {
      wanderPoints.push(
        randomLandNear(planet, settlement.anchorDir, rngFromString(id + '~wander' + i), 0.045),
      )
    }

    tangentBasis(structure.dir, _tb1, _tb2)

    return {
      id,
      structure,
      settlement,
      group: visualGroup,
      blobMesh,
      dir: structure.dir.clone(),
      forward: _tb1.clone(),
      targetDir: wanderPoints[1].clone(),
      targetIsHome: false,
      wanderPoints,
      rng,
      pauseTimer: 1 + rng() * 3,
      fadeScale: 1,
      arrivedHome: false,
      lastActive: Date.now(),
      bobPhase: rng() * Math.PI * 2,
      lastAction: null,
      bubbleSprite: null,
      bubbleText: '',
      sparkCooldown: Math.random() * SPARK_COOLDOWN_MIN,
    }
  }

  function createMinionRecord(id, index, settlement, structure) {
    const seed = id + '~minion' + index
    const rng = rngFromString(seed)
    const visual = buildPersonGroup(settlement.race)
    const visualGroup = new THREE.Group()
    visualGroup.add(visual)
    agentsGroup.add(visualGroup)
    const blobMesh = makeBlobMesh()

    const wanderPoints = [structure.dir.clone()]
    for (let i = 0; i < 3; i++) {
      wanderPoints.push(
        randomLandNear(planet, settlement.anchorDir, rngFromString(seed + '~wander' + i), 0.045),
      )
    }
    const start = randomLandNear(planet, settlement.anchorDir, rngFromString(seed + '~start'), 0.045)

    tangentBasis(structure.dir, _tb1, _tb2)

    return {
      group: visualGroup,
      blobMesh,
      dir: start.clone(),
      forward: _tb1.clone(),
      targetDir: wanderPoints[1].clone(),
      targetIsHome: false,
      wanderPoints,
      rng,
      pauseTimer: rng() * 2,
      bobPhase: rng() * Math.PI * 2,
    }
  }

  function pickNextTarget(agent) {
    if (agent.rng() < 0.28) {
      agent.targetDir.copy(agent.wanderPoints[0])
      agent.targetIsHome = true
    } else {
      const idx = 1 + Math.floor(agent.rng() * (agent.wanderPoints.length - 1))
      agent.targetDir.copy(agent.wanderPoints[idx])
      agent.targetIsHome = false
    }
  }

  function updateAgent(agent, dt, nowMs) {
    const st = agent.structure
    const home = st.dir
    const age = nowMs - agent.lastActive

    let phase
    if (st.constructing) phase = 'hammer'
    else if (age < WORKING_MAX_MS) phase = 'work'
    else if (age < AGENT_MAX_MS) phase = 'idle'
    else phase = 'despawn'

    if (phase !== 'despawn' && agent.fadeScale < 1) agent.fadeScale = Math.min(1, agent.fadeScale + dt * 2)

    let bob = 0
    let hammering = false

    if (phase === 'hammer') {
      const arrived = stepToward(agent.dir, home, AGENT_SPEED * dt * 2.2)
      if (arrived) {
        bob = Math.sin(simTime * 20 + agent.bobPhase) * BOB_HAMMER
        hammering = true
      } else {
        updateAgentForward(agent, home)
        bob = Math.sin(simTime * 9 + agent.bobPhase) * BOB_WALK
      }
    } else if (phase === 'work') {
      if (agent.pauseTimer > 0) {
        agent.pauseTimer -= dt
        bob = Math.sin(simTime * 20 + agent.bobPhase) * BOB_HAMMER
        hammering = true
      } else {
        const arrived = stepToward(agent.dir, agent.targetDir, AGENT_SPEED * dt)
        if (arrived) {
          if (agent.targetIsHome) agent.pauseTimer = 3 + agent.rng() * 5
          else pickNextTarget(agent)
        } else {
          updateAgentForward(agent, agent.targetDir)
        }
        bob = Math.sin(simTime * 9 + agent.bobPhase) * BOB_WALK
      }
    } else if (phase === 'idle') {
      const arrived = stepToward(agent.dir, home, AGENT_SPEED * dt * 1.4)
      if (!arrived) updateAgentForward(agent, home)
      bob = Math.sin(simTime * 4 + agent.bobPhase) * BOB_IDLE
    } else {
      if (!agent.arrivedHome) {
        const arrived = stepToward(agent.dir, home, AGENT_SPEED * dt * 1.4)
        if (arrived) agent.arrivedHome = true
        else updateAgentForward(agent, home)
        bob = Math.sin(simTime * 9 + agent.bobPhase) * BOB_WALK
      } else {
        agent.fadeScale = Math.max(0, agent.fadeScale - dt)
      }
    }

    const groundR = planet.sampleHeight(agent.dir)
    agent.group.position.copy(agent.dir).multiplyScalar(groundR + FOOT_LIFT + bob)
    orientOnSurface(agent.group, agent.dir, agent.forward)
    agent.group.scale.setScalar(PERSON_HEIGHT * agent.fadeScale)
    updateBlobTransform(agent.blobMesh, agent.dir, agent.forward, groundR, agent.fadeScale)

    if (hammering) {
      agent.sparkCooldown -= dt
      if (agent.sparkCooldown <= 0) {
        agent.sparkCooldown = SPARK_COOLDOWN_MIN + Math.random() * SPARK_COOLDOWN_RANGE
        spawnSparkBurst(agent.group.position, agent.dir)
      }
    }

    updateAgentBubble(agent, phase)

    return phase === 'despawn' && agent.arrivedHome && agent.fadeScale <= 0.001
  }

  // Speech bubble: only while WORKING and only when the camera is close.
  // Canvas is redrawn only when the text actually changes.
  function updateAgentBubble(agent, phase) {
    const text = phase === 'work' ? agent.lastAction : null
    if (!text) {
      if (agent.bubbleSprite) agent.bubbleSprite.visible = false
      return
    }
    if (!agent.bubbleSprite) {
      agent.bubbleSprite = makeBubbleSprite(truncateText(text, BUBBLE_MAX_CHARS))
      agent.bubbleText = text
      agentsGroup.add(agent.bubbleSprite)
    } else if (text !== agent.bubbleText) {
      agent.bubbleText = text
      refreshBubbleSprite(agent.bubbleSprite, truncateText(text, BUBBLE_MAX_CHARS))
    }
    const sprite = agent.bubbleSprite
    sprite.position.copy(agent.group.position).addScaledVector(agent.dir, BUBBLE_OFFSET)
    const dist = camera.position.distanceTo(sprite.position)
    const near = dist < BUBBLE_VISIBLE_DIST
    sprite.visible = near
    if (near) applyLabelScale(sprite, dist, TOPIC_LABEL_K, TOPIC_LABEL_MIN, TOPIC_LABEL_MAX)
  }

  // Subagent minions: lightweight, always-wandering, no work/hammer/despawn
  // phases of their own — existence is driven purely by ingest()'s pool sync.
  function updateMinion(m, dt) {
    let bob
    if (m.pauseTimer > 0) {
      m.pauseTimer -= dt
      bob = Math.sin(simTime * 9 + m.bobPhase) * BOB_IDLE
    } else {
      const arrived = stepToward(m.dir, m.targetDir, AGENT_SPEED * dt)
      if (arrived) {
        pickNextTarget(m)
        m.pauseTimer = 0.5 + m.rng() * 1.5
      } else {
        updateAgentForward(m, m.targetDir)
      }
      bob = Math.sin(simTime * 9 + m.bobPhase) * BOB_WALK
    }
    const groundR = planet.sampleHeight(m.dir)
    m.group.position.copy(m.dir).multiplyScalar(groundR + FOOT_LIFT * MINION_SCALE + bob * MINION_SCALE)
    orientOnSurface(m.group, m.dir, m.forward)
    m.group.scale.setScalar(PERSON_HEIGHT * MINION_SCALE)
    updateBlobTransform(m.blobMesh, m.dir, m.forward, groundR, MINION_SCALE)
  }

  // --- data ingest --------------------------------------------------------------

  function ingest(sessions) {
    const now = Date.now()
    for (let i = 0; i < sessions.length; i++) {
      try {
        const s = sessions[i]
        if (!s || typeof s.id !== 'string' || !s.id) {
          warnIngestSkip('missing/invalid id')
          continue
        }
        if (typeof s.project !== 'string' || !s.project) {
          warnIngestSkip('missing/invalid project')
          continue
        }
        const id = s.id
        const project = s.project
        const topic = typeof s.topic === 'string' ? s.topic : ''
        const lastActive = Number.isFinite(s.lastActive) ? s.lastActive : now
        const bytes = Number.isFinite(s.bytes) ? s.bytes : 0
        const lastAction = typeof s.lastAction === 'string' && s.lastAction ? s.lastAction : null
        const subagents = Number.isFinite(s.subagents) ? clamp(Math.floor(s.subagents), 0, 20) : 0
        // Defensive: the scanner is adding `model` (tier string | null) —
        // read it loosely so both an old and a new server payload shape
        // work. See createStructureRecord/updateStructureData for the one
        // place this currently feeds into (the asset-visual seedStr).
        const model = typeof s.model === 'string' && s.model ? s.model : null

        let settlement = settlements.get(project)
        if (!settlement) {
          settlement = createSettlementRecord(project)
          settlements.set(project, settlement)
        }

        let structure = structures.get(id)
        if (!structure) {
          const isNew = !knownIds.has(id)
          knownIds.add(id)
          const animate = isNew && now - lastActive < CONSTRUCTION_NEW_MAX_MS
          structure = createStructureRecord(id, settlement, topic, bytes, lastActive, animate, model)
          structures.set(id, structure)
        } else {
          updateStructureData(structure, topic, bytes, lastActive, model)
        }

        if (now - lastActive < AGENT_MAX_MS) {
          let agent = agents.get(id)
          if (!agent) {
            agent = createAgentRecord(id, settlement, structure)
            agents.set(id, agent)
          }
          agent.lastActive = lastActive
          agent.lastAction = lastAction
        }

        const wantMinions = Math.min(subagents, MINION_MAX)
        let minionPool = minions.get(id)
        if (!minionPool) {
          minionPool = []
          minions.set(id, minionPool)
        }
        while (minionPool.length < wantMinions) {
          minionPool.push(createMinionRecord(id, minionPool.length, settlement, structure))
        }
        while (minionPool.length > wantMinions) {
          const m = minionPool.pop()
          agentsGroup.remove(m.group)
          agentsGroup.remove(m.blobMesh) // shared geometry/material -- only the mesh itself is per-instance and needs removing, never disposing
        }
      } catch (e) {
        // Keep the world stable even if one session entry is malformed.
        warnIngestSkip('exception: ' + e)
      }
    }
    timeSortedDirty = true
  }

  async function poll() {
    try {
      const res = await fetch('/api/sessions')
      if (!res || !res.ok) {
        warnPoll('bad response' + (res ? ' (status ' + res.status + ')' : ''))
        return
      }
      const data = await res.json()
      if (Array.isArray(data)) ingest(data)
    } catch (e) {
      // Server may briefly 500 — ignore silently, try again next poll.
      warnPoll('fetch/parse failed: ' + e)
    }
  }
  // Hold the first ingest briefly for the asset pack (capped at 3s so a
  // broken pack can never block the world) — otherwise the instant first
  // poll beats the async GLB loads and nearly every structure is born on
  // the procedural fallback path ("no retro-swap" design).
  ;(async () => {
    const start = performance.now()
    while (!assetsReady && performance.now() - start < 3000) {
      await new Promise((r) => setTimeout(r, 50))
    }
    poll()
  })()

  // --- click-to-visit -----------------------------------------------------------

  let downPos = null
  let downId = null

  function onPointerDown(e) {
    downPos = { x: e.clientX, y: e.clientY }
    downId = e.pointerId
  }

  function onPointerUp(e) {
    const p = downPos
    downPos = null
    if (!p || e.pointerId !== downId) return
    const dx = e.clientX - p.x
    const dy = e.clientY - p.y
    if (Math.sqrt(dx * dx + dy * dy) >= CLICK_MOVE_THRESHOLD) return

    const rect = domElement.getBoundingClientRect()
    ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1)
    raycaster.setFromCamera(ndc, camera)

    // Structures are tested first: a hit opens the inspector and never
    // triggers the settlement fly-to underneath it.
    const structHits = raycaster.intersectObjects(structureHitSpheres, false)
    let structure = null
    for (let i = 0; i < structHits.length; i++) {
      // three.js's Raycaster ignores Object3D.visible entirely (core
      // behavior, not specific to this codebase), so a hitMesh for a
      // time-lapse-hidden structure is still geometrically hittable —
      // timeVisible is the actual gate here.
      const s = structHits[i].object.userData.structure
      if (s && s.timeVisible) {
        structure = s
        break
      }
    }
    if (structure) {
      const st = structure.settlement
      const payload = {
        id: structure.id,
        project: st ? st.project : null,
        topic: structure.topic,
        bytes: structure.bytes,
        lastActive: structure.lastActive,
        type: structure.type,
        tier: structure.tier,
        settlementName: st ? st.name : null,
        race: st ? st.race : null,
      }
      for (let i = 0; i < structureClickCallbacks.length; i++) {
        try {
          structureClickCallbacks[i](payload)
        } catch (err) {
          // A misbehaving subscriber shouldn't break click handling.
          if (!warnedStructureClickCb) {
            warnedStructureClickCb = true
            console.warn(
              '[planet] world.js: structure-click subscriber degraded — a registered callback threw: ' + err,
            )
          }
        }
      }
      return
    }

    const hits = raycaster.intersectObjects(hitSpheres, false)
    if (!hits.length) return
    const settlement = hits[0].object.userData.settlement
    if (!settlement) return

    const currentDist = camera.position.length()
    const arriveDist = Math.max(1.3, 0.45 * currentDist)
    if (cameraFeel) {
      cameraFeel.flyTo(settlement.anchorDir, arriveDist)
    } else {
      // Fallback: the pre-M-LD straight-chord tween, kept for when no
      // cameraFeel instance is wired in.
      tween.from.copy(camera.position)
      tween.to.copy(settlement.anchorDir).multiplyScalar(arriveDist)
      tween.t = 0
      tween.active = true
    }
  }

  function onStructureClick(cb) {
    if (typeof cb === 'function') structureClickCallbacks.push(cb)
  }

  domElement.addEventListener('pointerdown', onPointerDown)
  domElement.addEventListener('pointerup', onPointerUp)

  // --- frame update ---------------------------------------------------------

  function update(dt) {
    simTime += dt
    const nowMs = Date.now()
    if (assetsApi) assetsApi.update(dt)
    pollTimer += dt
    if (pollTimer >= POLL_INTERVAL) {
      pollTimer = 0
      poll()
    }

    for (const settlement of settlements.values()) {
      // scale by distance to the label itself, so close-ups get signposts,
      // not billboards
      const d = settlement.labelSprite.position.distanceTo(camera.position)
      applyLabelScale(
        settlement.labelSprite,
        d,
        SETTLEMENT_LABEL_K,
        SETTLEMENT_LABEL_MIN,
        SETTLEMENT_LABEL_MAX,
      )
      // Orbit label declutter: ease opacity toward the throttled selection's
      // target (below) every single frame, so crossing the
      // SETTLEMENT_DECLUTTER_DIST threshold — or a settlement entering/
      // leaving the top-N + near-center set — always fades smoothly rather
      // than popping visible/invisible.
      const mat = settlement.labelSprite.material
      const targetOpacity = settlement.labelWantVisible ? 1 : 0
      mat.opacity += (targetOpacity - mat.opacity) * clamp(dt * SETTLEMENT_LABEL_FADE_RATE, 0, 1)
    }

    for (const st of constructingSet) {
      st.constructionT += dt / CONSTRUCTION_DURATION
      const t = Math.min(1, st.constructionT)
      const eased = smoothstep(0, 1, t)
      const scale = lerp(st.finalScale * 0.05, st.finalScale, eased)
      if (st.kitGroup) {
        st.kitGroup.scale.setScalar(scale)
      } else if (st.visualHandle != null) {
        st.visualScale = scale
        pushVisualMatrix(st)
      }
      if (t >= 1) {
        st.constructing = false
        if (st.scaffold) {
          st.structureRoot.remove(st.scaffold)
          st.scaffold = null
        }
        constructingSet.delete(st)
      }
    }

    labelThrottle -= dt
    if (labelThrottle <= 0) {
      labelThrottle = LABEL_THROTTLE
      // Only the nearest few topics get a label — a 100-building city would
      // otherwise be a wall of text.
      const inRange = []
      for (const st of structures.values()) {
        const d = st.structureRoot.position.distanceTo(camera.position)
        st.topicSprite.visible = false
        if (d < TOPIC_VISIBLE_DIST) inRange.push({ st, d })
      }
      inRange.sort((a, b) => a.d - b.d)
      for (const { st, d } of inRange.slice(0, 12)) {
        st.topicSprite.visible = true
        applyLabelScale(st.topicSprite, d, TOPIC_LABEL_K, TOPIC_LABEL_MIN, TOPIC_LABEL_MAX)
      }

      // Settlement label declutter (ART.md §7's flagged label-soup defect):
      // above SETTLEMENT_DECLUTTER_DIST, only the top-N settlements by
      // (agents desc, structures desc) plus anything near screen center are
      // targeted visible; below it, every settlement is targeted visible,
      // same as before this task. This only decides the TARGET — the actual
      // opacity easing runs unthrottled above so it stays smooth regardless
      // of how often this selection re-runs.
      if (camera.position.length() > SETTLEMENT_DECLUTTER_DIST) {
        const agentCounts = new Map()
        for (const a of agents.values()) {
          agentCounts.set(a.settlement, (agentCounts.get(a.settlement) || 0) + 1)
        }
        const ranked = Array.from(settlements.values()).sort((a, b) => {
          const agentsA = agentCounts.get(a) || 0
          const agentsB = agentCounts.get(b) || 0
          if (agentsB !== agentsA) return agentsB - agentsA
          return b.visibleStructureCount - a.visibleStructureCount
        })
        const topSet = new Set(ranked.slice(0, SETTLEMENT_DECLUTTER_TOP_N))

        camera.getWorldDirection(_camForwardScratch)
        for (const settlement of settlements.values()) {
          let want = topSet.has(settlement)
          if (!want) {
            _toSettlementScratch.copy(settlement.labelSprite.position).sub(camera.position).normalize()
            want = _toSettlementScratch.angleTo(_camForwardScratch) < SETTLEMENT_DECLUTTER_CENTER_RAD
          }
          settlement.labelWantVisible = want
        }
      } else {
        for (const settlement of settlements.values()) settlement.labelWantVisible = true
      }
    }

    for (const [id, agent] of agents) {
      const remove = updateAgent(agent, dt, nowMs)
      if (remove) {
        agentsGroup.remove(agent.group)
        agentsGroup.remove(agent.blobMesh) // shared geometry/material -- only the mesh itself is per-instance and needs removing, never disposing
        if (agent.bubbleSprite) {
          agentsGroup.remove(agent.bubbleSprite)
          agent.bubbleSprite.material.map.dispose()
          agent.bubbleSprite.material.dispose()
        }
        agents.delete(id)
      }
    }

    for (const pool of minions.values()) {
      for (let i = 0; i < pool.length; i++) updateMinion(pool[i], dt)
    }

    updateSparks(dt)
    updateStructurePlumes(dt, nowMs)
    updatePlumes(dt)

    if (tween.active) {
      tween.t += dt / TWEEN_DURATION
      const t = Math.min(1, tween.t)
      camera.position.lerpVectors(tween.from, tween.to, smoothstep(0, 1, t))
      if (t >= 1) tween.active = false
    }

    stats.settlements = settlements.size
    stats.structures = structures.size
    stats.agents = agents.size

    if (structures.size !== townLightCount || townLightsDirty) rebuildTownLights()
  }

  // Read-only settlement summaries for UI (sidebar/legend).
  function list() {
    const counts = new Map()
    for (const a of agents.values()) {
      counts.set(a.settlement.project, (counts.get(a.settlement.project) || 0) + 1)
    }
    return Array.from(settlements.values()).map((s) => ({
      project: s.project,
      name: s.name,
      basename: s.basenameRaw,
      race: s.race,
      structures: s.structureDirs.length,
      agents: counts.get(s.project) || 0,
    }))
  }

  // Fly the camera to a settlement — same flight as clicking it in the scene.
  function visit(project) {
    const s = settlements.get(project)
    if (!s) return false
    const arriveDist = Math.max(1.3, 0.45 * camera.position.length())
    if (cameraFeel) {
      cameraFeel.flyTo(s.anchorDir, arriveDist)
    } else {
      // Fallback: the pre-M-LD straight-chord tween, kept for when no
      // cameraFeel instance is wired in.
      tween.from.copy(camera.position)
      tween.to.copy(s.anchorDir).multiplyScalar(arriveDist)
      tween.t = 0
      tween.active = true
    }
    return true
  }

  return { group, update, stats, list, visit, _tween: tween, onStructureClick, setTimeFilter, getTimeRange }
}
