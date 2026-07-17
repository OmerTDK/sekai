// The living-world module: settlements, buildings, tiny working people, and
// labels, scattered deterministically across the planet from the Claude Code
// session history. Everything a user will ever see here is derived from
// string hashes (project path, session id) so relaunching the app rebuilds
// the identical village layout, then a 4s poll layers live activity on top.
//
// Structure/person geometry lives in buildings.js, placement search + surface
// math lives in placement.js, and canvas label sprites live in labels.js —
// this module is the orchestration layer: settlement/structure/agent
// records, ingest/polling, the per-frame update loop, click raycasting, the
// camera tween, city lights, and the hammer-spark particle pool.
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
import { findLandAnchor, findStructureSpot, randomLandNear, tangentBasis, yawedTangent, orientOnSurface, stepToward } from './placement.js'
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

const AGENT_SPEED = 0.010 // rad/s baseline walking angular speed
const WORKING_MAX_MS = 3 * 60 * 1000
const AGENT_MAX_MS = 10 * 60 * 1000

const PERSON_HEIGHT = 0.0055
const BOB_WALK = PERSON_HEIGHT * 0.16
const BOB_HAMMER = PERSON_HEIGHT * 0.30
const BOB_IDLE = PERSON_HEIGHT * 0.05
const FOOT_LIFT = PERSON_HEIGHT * 0.05

const CLICK_MOVE_THRESHOLD = 6 // px
const TWEEN_DURATION = 1.1 // seconds

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

// ---------------------------------------------------------------------------
// Scratch tangent-basis vectors for the tangentBasis() calls made directly
// from this module (spark bursts, agent/minion forward vectors) — duplicated
// from placement.js's own private copy rather than shared via an export,
// since these are write-before-read scratch (see the M2 program plan's
// split notes on module-level scratch vectors).
// ---------------------------------------------------------------------------
const _tb1 = new THREE.Vector3()
const _tb2 = new THREE.Vector3()

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
  console.warn('[planet] world.js: session ingest degraded — skipped a malformed session entry (' + reason + ')')
}

function warnPoll(reason) {
  if (warnedPoll) return
  warnedPoll = true
  console.warn('[planet] world.js: session poll degraded — ' + reason)
}

// ---------------------------------------------------------------------------
// createWorld
// ---------------------------------------------------------------------------

export function createWorld(planet, camera, domElement) {
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
    if (townLights) {
      structuresGroup.remove(townLights)
      townLights.geometry.dispose()
    }
    const positions = new Float32Array(structures.size * 3)
    let i = 0
    for (const st of structures.values()) {
      positions[i * 3] = st.structureRoot.position.x + st.dir.x * 0.004
      positions[i * 3 + 1] = st.structureRoot.position.y + st.dir.y * 0.004
      positions[i * 3 + 2] = st.structureRoot.position.z + st.dir.z * 0.004
      i++
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    townLights = new THREE.Points(geo, townLightsMat)
    townLights.renderOrder = 1
    structuresGroup.add(townLights)
  }
  group.add(settlementsGroup, structuresGroup, agentsGroup)

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
    const base = new THREE.Vector3(Math.cos(lat) * Math.cos(lon), Math.sin(lat), Math.cos(lat) * Math.sin(lon))

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

    const settlement = { project, anchorDir, groundR, race, name, basenameRaw, labelSprite, hitMesh, structureDirs: [] }
    hitMesh.userData.settlement = settlement
    hitSpheres.push(hitMesh)
    return settlement
  }

  // --- structure --------------------------------------------------------------

  function createStructureRecord(id, settlement, topic, bytes, lastActive, animate) {
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

    const kitGroup = buildKit(type, settlement.race, tier, rng)
    kitGroup.scale.setScalar(animate ? finalScale * 0.05 : finalScale)
    structureRoot.add(kitGroup)

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
      settlement,
      finalScale,
      structureRoot,
      kitGroup,
      scaffold,
      topicSprite,
      hitMesh,
      constructing: !!animate,
      constructionT: 0,
    }
    hitMesh.userData.structure = structure
    structureHitSpheres.push(hitMesh)
    settlement.structureDirs.push(dir)
    if (animate) constructingSet.add(structure)
    return structure
  }

  function updateStructureData(structure, topic, bytes, lastActive) {
    structure.lastActive = lastActive
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
        if (!structure.constructing) structure.kitGroup.scale.setScalar(structure.finalScale)
        structure.topicSprite.position.set(0, structure.finalScale * 1.3, 0)
      }
    }
  }

  // --- agent ------------------------------------------------------------------

  function createAgentRecord(id, settlement, structure) {
    const rng = rngFromString(id + '~agent')
    const visual = buildPersonGroup(settlement.race)
    const visualGroup = new THREE.Group()
    visualGroup.add(visual)
    agentsGroup.add(visualGroup)

    const wanderPoints = [structure.dir.clone()]
    for (let i = 0; i < 3; i++) {
      wanderPoints.push(randomLandNear(planet, settlement.anchorDir, rngFromString(id + '~wander' + i), 0.045))
    }

    tangentBasis(structure.dir, _tb1, _tb2)

    return {
      id,
      structure,
      settlement,
      group: visualGroup,
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

    const wanderPoints = [structure.dir.clone()]
    for (let i = 0; i < 3; i++) {
      wanderPoints.push(randomLandNear(planet, settlement.anchorDir, rngFromString(seed + '~wander' + i), 0.045))
    }
    const start = randomLandNear(planet, settlement.anchorDir, rngFromString(seed + '~start'), 0.045)

    tangentBasis(structure.dir, _tb1, _tb2)

    return {
      group: visualGroup,
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
          structure = createStructureRecord(id, settlement, topic, bytes, lastActive, animate)
          structures.set(id, structure)
        } else {
          updateStructureData(structure, topic, bytes, lastActive)
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
        }
      } catch (e) {
        // Keep the world stable even if one session entry is malformed.
        warnIngestSkip('exception: ' + e)
      }
    }
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
  poll()

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
    const structure = structHits.length ? structHits[0].object.userData.structure : null
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
            console.warn('[planet] world.js: structure-click subscriber degraded — a registered callback threw: ' + err)
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
    tween.from.copy(camera.position)
    tween.to.copy(settlement.anchorDir).multiplyScalar(Math.max(1.3, 0.45 * currentDist))
    tween.t = 0
    tween.active = true
  }

  function onStructureClick(cb) {
    if (typeof cb === 'function') structureClickCallbacks.push(cb)
  }

  domElement.addEventListener('pointerdown', onPointerDown)
  domElement.addEventListener('pointerup', onPointerUp)

  // --- frame update ---------------------------------------------------------

  function update(dt) {
    simTime += dt
    pollTimer += dt
    if (pollTimer >= POLL_INTERVAL) {
      pollTimer = 0
      poll()
    }

    for (const settlement of settlements.values()) {
      // scale by distance to the label itself, so close-ups get signposts,
      // not billboards
      const d = settlement.labelSprite.position.distanceTo(camera.position)
      applyLabelScale(settlement.labelSprite, d, SETTLEMENT_LABEL_K, SETTLEMENT_LABEL_MIN, SETTLEMENT_LABEL_MAX)
    }

    for (const st of constructingSet) {
      st.constructionT += dt / CONSTRUCTION_DURATION
      const t = Math.min(1, st.constructionT)
      const eased = smoothstep(0, 1, t)
      st.kitGroup.scale.setScalar(lerp(st.finalScale * 0.05, st.finalScale, eased))
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
    }

    const nowMs = Date.now()
    for (const [id, agent] of agents) {
      const remove = updateAgent(agent, dt, nowMs)
      if (remove) {
        agentsGroup.remove(agent.group)
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

    if (tween.active) {
      tween.t += dt / TWEEN_DURATION
      const t = Math.min(1, tween.t)
      camera.position.lerpVectors(tween.from, tween.to, smoothstep(0, 1, t))
      if (t >= 1) tween.active = false
    }

    stats.settlements = settlements.size
    stats.structures = structures.size
    stats.agents = agents.size

    if (structures.size !== townLightCount) rebuildTownLights()
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

  // Fly the camera to a settlement — same tween as clicking it in the scene.
  function visit(project) {
    const s = settlements.get(project)
    if (!s) return false
    tween.from.copy(camera.position)
    tween.to.copy(s.anchorDir).multiplyScalar(Math.max(1.3, 0.45 * camera.position.length()))
    tween.t = 0
    tween.active = true
    return true
  }

  return { group, update, stats, list, visit, _tween: tween, onStructureClick }
}
