// The git-driven spectacle layer: turns /api/events (commits, merged PRs —
// see server/gitinfo.js) into fireworks over a settlement and small
// procedural monuments planted beside it. Polls nothing itself — the caller
// (main.js) fetches /api/events on its own ~60s cadence and hands the array
// to ingest(); this module only owns the resulting meshes/particles and
// their per-frame animation.
//
// Settlement anchors are looked up read-only through world.list() (project
// match) + a world.group traversal for the matching userData.settlement
// record (anchorDir/groundR) — this module never edits world.js state and
// owns its meshes in its own `group`, added alongside (not inside) world's.
import * as THREE from 'three'
import { rngFromString } from './util.js'
import { tangentBasis, yawedTangent, orientOnSurface } from './placement.js'
import { RACE_PALETTES, sphereGeo } from './buildings.js'

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

const EVENT_QUEUE_STAGGER = 0.4 // seconds between dispatching queued events (simultaneous ingests stagger, not explode)
const SEEN_EVENT_CAP = 1000 // defensive dedup cap — gitinfo.js already guarantees each id once, this just bounds memory

const FIREWORK_POOL_SIZE = 300 // shared additive-particle budget for ALL settlements' commit fireworks
const FIREWORK_BURST_MIN = 2 // "2-4 staggered bursts" per commit
const FIREWORK_BURST_MAX = 4
const FIREWORK_BURST_STAGGER_MIN = 0.15 // seconds between bursts within one commit's spectacle
const FIREWORK_BURST_STAGGER_MAX = 0.35
const FIREWORK_PARTICLES_MIN = 16 // particles per individual burst
const FIREWORK_PARTICLES_MAX = 28
const FIREWORK_TTL = 1.5 // seconds a firework particle lives (per spec)
const FIREWORK_TTL_JITTER = 0.35
const FIREWORK_SPEED_MIN = 0.018 // world units/s, radial burst speed
const FIREWORK_SPEED_MAX = 0.034
const FIREWORK_GRAVITY = 0.05 // world units/s^2, pulls particles back toward the planet
const FIREWORK_HEIGHT = 0.045 // world units above the settlement's ground point the burst center sits at
const FIREWORK_JITTER_RADIUS = 0.012 // horizontal spread between one commit's staggered burst origins
const FIREWORK_GOLD_CHANCE = 0.45 // fraction of a burst's particles colored gold vs. the settlement's race accent
const FIREWORK_SIZE = 4.5 // PointsMaterial size, screen-space (sizeAttenuation: false, matches world.js's spark pool)
const GOLD_COLOR = new THREE.Color(0xffd76a)
const DEFAULT_ACCENT_COLOR = new THREE.Color(0xd8ceb0) // used if a settlement's race can't be resolved (shouldn't happen, but never throw)

const MONUMENT_HEIGHT = 0.006 // world units tall, per spec
const MONUMENT_OFFSET_MIN = 0.006 // radians from the settlement anchor
const MONUMENT_OFFSET_MAX = 0.02
const MONUMENT_MAX_PER_SETTLEMENT = 5 // oldest removed once exceeded

let warnedSettlementMissing = false
function warnSettlementMissing(reason) {
  if (warnedSettlementMissing) return
  warnedSettlementMissing = true
  console.warn('[planet] events.js: dropped one or more git events — ' + reason)
}

// ---------------------------------------------------------------------------
// Settlement lookup — read-only. world.list() gives the cheap project-match
// check; a world.group traversal finds the matching settlement record
// (stashed on a hit-sphere's userData by world.js) for its anchorDir/groundR
// and race. Never mutates anything on `world`.
// ---------------------------------------------------------------------------

function findSettlementAnchor(world, project) {
  const known = world.list().some((s) => s.project === project)
  if (!known) return null

  let found = null
  world.group.traverse((obj) => {
    if (found) return
    const settlement = obj.userData && obj.userData.settlement
    if (settlement && settlement.project === project) found = settlement
  })
  if (!found || !found.anchorDir || !Number.isFinite(found.groundR)) return null
  return { anchorDir: found.anchorDir, groundR: found.groundR, race: found.race }
}

// ---------------------------------------------------------------------------
// Monument: 2 stacked cylinders + a sphere finial, brass-tinted, built once
// in "local unit" space (~1 tall) — same authoring convention as
// buildings.js's structure kits — then scaled to MONUMENT_HEIGHT per
// instance. Geometry/material are module-level shared caches (never
// per-instance), same rule buildings.js documents for its own kit parts.
// ---------------------------------------------------------------------------

const monumentBaseGeo = new THREE.CylinderGeometry(0.3, 0.34, 0.4, 8)
const monumentShaftGeo = new THREE.CylinderGeometry(0.14, 0.18, 0.48, 8)
const monumentBrassMat = new THREE.MeshStandardMaterial({ color: 0xb0793a, metalness: 0.55, roughness: 0.35, flatShading: true })
const monumentFinialMat = new THREE.MeshStandardMaterial({
  color: 0xc98d4a,
  metalness: 0.5,
  roughness: 0.3,
  flatShading: true,
  emissive: 0xc98d4a,
  emissiveIntensity: 0.35,
})

function buildMonument() {
  const g = new THREE.Group()
  let y = 0
  const baseH = 0.4
  const base = new THREE.Mesh(monumentBaseGeo, monumentBrassMat)
  base.position.set(0, y + baseH / 2, 0)
  g.add(base)
  y += baseH

  const shaftH = 0.48
  const shaft = new THREE.Mesh(monumentShaftGeo, monumentBrassMat)
  shaft.position.set(0, y + shaftH / 2, 0)
  g.add(shaft)
  y += shaftH

  const finial = new THREE.Mesh(sphereGeo(), monumentFinialMat)
  finial.scale.setScalar(0.22)
  finial.position.set(0, y + 0.06, 0)
  g.add(finial)

  return g
}

// Small local re-implementation of placement.js's private sphericalOffset
// (that helper isn't exported — see world.js's own _tb1/_tb2 duplication
// comment for the same "small private scratch/math helpers get duplicated,
// not exported" convention already used in this codebase).
const _offsetT1 = new THREE.Vector3()
const _offsetT2 = new THREE.Vector3()
function offsetDir(base, bearing, dist, out) {
  tangentBasis(base, _offsetT1, _offsetT2)
  const cb = Math.cos(bearing)
  const sb = Math.sin(bearing)
  const tx = _offsetT1.x * cb + _offsetT2.x * sb
  const ty = _offsetT1.y * cb + _offsetT2.y * sb
  const tz = _offsetT1.z * cb + _offsetT2.z * sb
  const cd = Math.cos(dist)
  const sd = Math.sin(dist)
  return out.set(base.x * cd + tx * sd, base.y * cd + ty * sd, base.z * cd + tz * sd).normalize()
}

// ---------------------------------------------------------------------------
// createEvents
// ---------------------------------------------------------------------------

export function createEvents(world, camera) {
  const group = new THREE.Group()
  const fireworksGroup = new THREE.Group()
  const monumentsGroup = new THREE.Group()
  group.add(fireworksGroup, monumentsGroup)

  // --- firework particle pool (round-robin allocated, never grows) ---------
  // Mirrors world.js's hammer-spark pool exactly: parallel typed arrays for
  // simulation state, a single shared Points geometry/material for
  // rendering, per-slot age/ttl (ttl<=0 means free/dead).
  const fwPositions = new Float32Array(FIREWORK_POOL_SIZE * 3)
  const fwColors = new Float32Array(FIREWORK_POOL_SIZE * 3) // displayed (faded) color, written into the geometry attribute
  const fwBaseColor = new Float32Array(FIREWORK_POOL_SIZE * 3) // each particle's un-faded color
  const fwVelocity = new Float32Array(FIREWORK_POOL_SIZE * 3)
  const fwGravity = new Float32Array(FIREWORK_POOL_SIZE * 3) // unit direction pulled "down" (toward the planet center)
  const fwAge = new Float32Array(FIREWORK_POOL_SIZE)
  const fwTtl = new Float32Array(FIREWORK_POOL_SIZE) // 0 = free/dead slot
  let fwCursor = 0

  const fwGeo = new THREE.BufferGeometry()
  fwGeo.setAttribute('position', new THREE.BufferAttribute(fwPositions, 3))
  fwGeo.setAttribute('color', new THREE.BufferAttribute(fwColors, 3))
  const fwMat = new THREE.PointsMaterial({
    size: FIREWORK_SIZE,
    sizeAttenuation: false,
    vertexColors: true,
    transparent: true,
    opacity: 0.95,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  })
  const fwPoints = new THREE.Points(fwGeo, fwMat)
  fwPoints.frustumCulled = false // pool slots can sit anywhere on the planet
  fireworksGroup.add(fwPoints)

  // Spawn-time allocation is fine here (bursts are rare, not per-frame) —
  // same rationale storms.js states for its own spawn-time helpers.
  function spawnFireworkBurst(originPos, upDir, accentColor) {
    const count = FIREWORK_PARTICLES_MIN + Math.floor(Math.random() * (FIREWORK_PARTICLES_MAX - FIREWORK_PARTICLES_MIN + 1))
    for (let n = 0; n < count; n++) {
      const slot = fwCursor
      fwCursor = (fwCursor + 1) % FIREWORK_POOL_SIZE
      const i3 = slot * 3

      fwPositions[i3] = originPos.x
      fwPositions[i3 + 1] = originPos.y
      fwPositions[i3 + 2] = originPos.z

      // Uniform-ish sphere direction for a radial burst.
      const theta = Math.random() * Math.PI * 2
      const u = Math.random() * 2 - 1
      const s = Math.sqrt(Math.max(0, 1 - u * u))
      const speed = FIREWORK_SPEED_MIN + Math.random() * (FIREWORK_SPEED_MAX - FIREWORK_SPEED_MIN)
      fwVelocity[i3] = s * Math.cos(theta) * speed
      fwVelocity[i3 + 1] = u * speed
      fwVelocity[i3 + 2] = s * Math.sin(theta) * speed

      fwGravity[i3] = -upDir.x
      fwGravity[i3 + 1] = -upDir.y
      fwGravity[i3 + 2] = -upDir.z

      fwAge[slot] = 0
      fwTtl[slot] = FIREWORK_TTL * (1 - FIREWORK_TTL_JITTER / 2 + Math.random() * FIREWORK_TTL_JITTER)

      const c = Math.random() < FIREWORK_GOLD_CHANCE ? GOLD_COLOR : accentColor
      fwBaseColor[i3] = c.r
      fwBaseColor[i3 + 1] = c.g
      fwBaseColor[i3 + 2] = c.b
      fwColors[i3] = c.r
      fwColors[i3 + 1] = c.g
      fwColors[i3 + 2] = c.b
    }
  }

  function updateFireworks(dt) {
    let any = false
    for (let slot = 0; slot < FIREWORK_POOL_SIZE; slot++) {
      const t = fwTtl[slot]
      if (t <= 0) continue
      any = true
      const a = fwAge[slot] + dt
      const i3 = slot * 3
      if (a >= t) {
        fwTtl[slot] = 0
        fwColors[i3] = fwColors[i3 + 1] = fwColors[i3 + 2] = 0
        continue
      }
      fwAge[slot] = a
      fwVelocity[i3] += fwGravity[i3] * FIREWORK_GRAVITY * dt
      fwVelocity[i3 + 1] += fwGravity[i3 + 1] * FIREWORK_GRAVITY * dt
      fwVelocity[i3 + 2] += fwGravity[i3 + 2] * FIREWORK_GRAVITY * dt
      fwPositions[i3] += fwVelocity[i3] * dt
      fwPositions[i3 + 1] += fwVelocity[i3 + 1] * dt
      fwPositions[i3 + 2] += fwVelocity[i3 + 2] * dt
      const fade = 1 - a / t
      fwColors[i3] = fwBaseColor[i3] * fade
      fwColors[i3 + 1] = fwBaseColor[i3 + 1] * fade
      fwColors[i3 + 2] = fwBaseColor[i3 + 2] * fade
    }
    if (any) {
      fwGeo.attributes.position.needsUpdate = true
      fwGeo.attributes.color.needsUpdate = true
    }
  }

  // --- pending multi-burst commit spectacles --------------------------------
  // Each commit schedules 2-4 bursts fired FIREWORK_BURST_STAGGER apart
  // rather than all at once.
  const pendingBursts = [] // { fireIn, originPos, upDir, accentColor }

  function scheduleCommitFireworks(anchor) {
    const groundPos = anchor.anchorDir.clone().multiplyScalar(anchor.groundR + FIREWORK_HEIGHT)
    tangentBasis(anchor.anchorDir, _offsetT1, _offsetT2)
    const pal = RACE_PALETTES[anchor.race]
    const accentColor = pal ? new THREE.Color(pal.accent) : DEFAULT_ACCENT_COLOR

    const burstCount = FIREWORK_BURST_MIN + Math.floor(Math.random() * (FIREWORK_BURST_MAX - FIREWORK_BURST_MIN + 1))
    let fireIn = 0
    for (let i = 0; i < burstCount; i++) {
      const jx = (Math.random() * 2 - 1) * FIREWORK_JITTER_RADIUS
      const jz = (Math.random() * 2 - 1) * FIREWORK_JITTER_RADIUS
      const originPos = groundPos.clone().addScaledVector(_offsetT1, jx).addScaledVector(_offsetT2, jz)
      pendingBursts.push({ fireIn, originPos, upDir: anchor.anchorDir.clone(), accentColor })
      fireIn += FIREWORK_BURST_STAGGER_MIN + Math.random() * (FIREWORK_BURST_STAGGER_MAX - FIREWORK_BURST_STAGGER_MIN)
    }
  }

  function updatePendingBursts(dt) {
    for (let i = pendingBursts.length - 1; i >= 0; i--) {
      const b = pendingBursts[i]
      b.fireIn -= dt
      if (b.fireIn <= 0) {
        spawnFireworkBurst(b.originPos, b.upDir, b.accentColor)
        pendingBursts.splice(i, 1)
      }
    }
  }

  // --- monuments -------------------------------------------------------------
  const monumentsBySettlement = new Map() // project -> array of { root }, oldest first

  function plantMonument(anchor, project, eventId) {
    const rng = rngFromString(eventId + ':monument')
    const bearing = rng() * Math.PI * 2
    const dist = MONUMENT_OFFSET_MIN + rng() * (MONUMENT_OFFSET_MAX - MONUMENT_OFFSET_MIN)
    const dir = offsetDir(anchor.anchorDir, bearing, dist, new THREE.Vector3())
    const yaw = rng() * Math.PI * 2
    const forward = yawedTangent(dir, yaw, new THREE.Vector3())

    const root = new THREE.Group()
    const mesh = buildMonument()
    mesh.scale.setScalar(MONUMENT_HEIGHT)
    root.add(mesh)
    orientOnSurface(root, dir, forward)
    root.position.copy(dir).multiplyScalar(anchor.groundR)
    monumentsGroup.add(root)

    let list = monumentsBySettlement.get(project)
    if (!list) {
      list = []
      monumentsBySettlement.set(project, list)
    }
    list.push({ root })
    if (list.length > MONUMENT_MAX_PER_SETTLEMENT) {
      const oldest = list.shift()
      monumentsGroup.remove(oldest.root)
    }
  }

  // --- event queue: staggers simultaneous ingests instead of exploding ------
  const queue = []
  const seenEventIds = new Set() // defensive belt-and-suspenders; gitinfo.js already dedups server-side
  let queueTimer = 0

  function ingest(events) {
    if (!Array.isArray(events)) return
    for (const e of events) {
      if (!e || typeof e.id !== 'string' || !e.id) continue
      if (typeof e.project !== 'string' || !e.project) continue
      if (e.kind !== 'commit' && e.kind !== 'pr-merged') continue // 'error' is reserved/unhandled here
      if (seenEventIds.has(e.id)) continue
      seenEventIds.add(e.id)
      if (seenEventIds.size > SEEN_EVENT_CAP) {
        // Cheap unbounded-growth guard: drop the oldest half once we blow the
        // cap. Insertion order is preserved by Set, so this is a clean trim.
        const it = seenEventIds.values()
        for (let i = 0; i < SEEN_EVENT_CAP / 2; i++) seenEventIds.delete(it.next().value)
      }
      queue.push(e)
    }
  }

  function dispatchEvent(e) {
    const anchor = findSettlementAnchor(world, e.project)
    if (!anchor) {
      warnSettlementMissing('no settlement found yet for project "' + e.project + '" — dropped a ' + e.kind + ' event')
      return
    }
    if (e.kind === 'commit') scheduleCommitFireworks(anchor)
    else if (e.kind === 'pr-merged') plantMonument(anchor, e.project, e.id)
  }

  function updateQueue(dt) {
    if (!queue.length) return
    queueTimer -= dt
    if (queueTimer > 0) return
    queueTimer = EVENT_QUEUE_STAGGER
    dispatchEvent(queue.shift())
  }

  function update(dt) {
    updateQueue(dt)
    updatePendingBursts(dt)
    updateFireworks(dt)
  }

  return { group, update, ingest }
}
