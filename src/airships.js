// Airships: the traversal layer between related settlements (program plan
// M2.5; art direction docs/ART.md §6 civilization/steampunk + §7 motion —
// "nothing snaps," every eased transition already in this app uses
// smoothstep). Procedural steampunk dirigibles fly seeded great-circle
// routes between settlements that look "related" (see deriveRoutes below),
// moor nose-first at slim dock masts, and trail steam while cruising.
//
// Determinism split follows world.js's own precedent exactly: STRUCTURAL
// choices (which settlements cluster into routes, mast placement, which
// ship starts at which mast, turnaround destination choices) are all seeded
// from `seed` via rngFromString; purely COSMETIC jitter (steam-puff timing/
// color/ttl variance) uses plain Math.random(), same split world.js's own
// spawnPlumePuff uses between structure placement (seeded) and puff jitter
// (not).
//
// Contract (pinned for the architect to wire into main.js):
//   export function createAirships(planet, world, seed) -> { group, update(dt) }
// `world` is read-only here — world.js owns settlement/structure state.
// Settlement anchors aren't on world.list()'s rows, so they're read via a
// one-time world.group traversal for objects carrying `userData.settlement`
// (the same hitMesh.userData.settlement world.js itself uses for
// click-to-visit). Because world.js populates settlements asynchronously
// (its own /api/sessions poll), the fleet is built lazily on first update()
// calls, not at construction time — see the tiny waiting/settling/ready
// state machine at the bottom of this file.
import * as THREE from 'three'
import { rngFromString, clamp, lerp, smoothstep } from './util.js'
import { RACE_PALETTES, boxGeo, sphereGeo } from './buildings.js'
import { findLandAnchor, tangentBasis, orientOnSurface, stepToward } from './placement.js'

// ---------------------------------------------------------------------------
// Tuning constants
// ---------------------------------------------------------------------------

// Steampunk accent pair (program plan §0.5's exact hexes — duplicated here
// rather than imported since assets.js keeps its own copy private too; see
// gitinfo.js's own comment on small threshold/color constants being
// duplicated, not exported, across this codebase).
const BRASS = 0xb0793a
const COPPER = 0xc98d4a // kept alongside BRASS for a future second-tone bolt-on; unused solo today
const COLOR_WOOD = 0x8a6242
const COLOR_DARK = 0x2a2420
const COLOR_STONE = 0x8a8274

const MIN_ROUTE_STRUCTURES = 3
const ROUTE_CAP = 6

const MAST_HEIGHT = 0.012
const MAST_OFFSET_RAD = 0.02 // seeded land search starts this far from the settlement anchor

const SHIP_LENGTH = 0.014
const NOSE_FRAC = 0.42 // fraction of ship length from center to nose/stern tip — shared by geometry AND moor/steam-trail offsets so they can't drift apart
const SHIP_COUNT_MIN = 2
const SHIP_COUNT_MAX = 4

// Altitude band: above HEIGHT_MAX peaks (1.06), below the lower cloud shell
// (1.075) — see docs/ART.md §3's height-cap consequence and §5's cloud fade.
const CRUISE_ALT = 1.068
const ALT_BREATH_AMPLITUDE = 0.002
const ALT_BREATH_FREQ = 0.35 // rad/s

const CASTOFF_DUR = 5 // seconds, moored -> cruise (ease up + away)
const APPROACH_DUR = 6 // seconds, cruise -> moored (decelerate, descend, settle)
const CRUISE_ANGULAR_SPEED = 0.025 // rad/s along the great circle
const DEPART_ANGLE = 0.045 // rad from each mast where cast-off/approach hands off to steady cruise

const TURNAROUND_MIN = 20
const TURNAROUND_MAX = 40

const BANK_MAX = 0.30 // rad, cap on the "slight banking on course corrections"
const BANK_GAIN = 3.2
const BANK_SMOOTH = 2.2 // per-second exponential-approach rate toward the target bank

const MOOR_BOB_AMP = 0.0006
const MOOR_BOB_FREQ = 0.9 // rad/s
const MOOR_SWAY_AMP = 0.05 // rad
const MOOR_SWAY_FREQ = 0.7 // rad/s

const PROP_MAX_RATE = 40 // rad/s at speed01 = 1

// Steam trail: one shared particle pool for every cruising ship's stern,
// pattern-copied from world.js's own structure-plume pool (normal blending
// + real per-vertex alpha via a color itemSize-4 attribute, gray-white,
// fade in/out) — see that file's PLUME_* constants/comments for the source
// this was adapted from.
const TRAIL_POOL_SIZE = 150
const TRAIL_EMIT_INTERVAL = 0.15 // seconds between puffs, per cruising ship
const TRAIL_TTL = 2.0 // seconds a puff lives
const TRAIL_RISE_SPEED = 0.006
const TRAIL_BACK_SPEED = 0.010
const TRAIL_DRIFT_SPEED = 0.0012
const TRAIL_SIZE = 6
const TRAIL_PEAK_ALPHA = 0.4
const TRAIL_FADE_IN = 0.15

const INIT_RECHECK_INTERVAL = 2 // seconds between "has world.js seen any settlement yet" peeks
const INIT_SETTLE_DELAY = 6 // seconds to let world.js's own poll cycle populate settlements before snapshotting the route graph

const PHASE = { MOORED: 'moored', CASTOFF: 'castoff', CRUISE: 'cruise', APPROACH: 'approach' }

// ---------------------------------------------------------------------------
// Scratch vectors — module-level write-before-read scratch, same convention
// world.js documents for its own _tb1/_tb2 (never holds state across calls).
// ---------------------------------------------------------------------------
const _tb1 = new THREE.Vector3()
const _tb2 = new THREE.Vector3()
const _sa1 = new THREE.Vector3()
const _sa2 = new THREE.Vector3()
const _saCross = new THREE.Vector3()
const _dirScratch = new THREE.Vector3()
const _fwdScratch = new THREE.Vector3()
const _routeFwdScratch = new THREE.Vector3()
const _upWorldScratch = new THREE.Vector3()
const _fwdWorldScratch = new THREE.Vector3()
const _trailVel = new THREE.Vector3()

let warnedDegenerateGeometry = false
function warnDegenerateGeometry(reason) {
  if (warnedDegenerateGeometry) return
  warnedDegenerateGeometry = true
  console.warn(
    '[planet] airships.js: degenerate great-circle geometry — ' +
      reason +
      ' (fell back to an arbitrary tangent; only expected for near-antipodal settlement/mast pairs)'
  )
}

// ---------------------------------------------------------------------------
// Pure spherical-geometry helpers. offsetPoint mirrors placement.js's own
// private sphericalOffset (not exported there, so duplicated here rather
// than modifying that file — this milestone creates ONLY src/airships.js).
// The rest (tangentForward, nlerpPoint, signedTurnAngle) are new math this
// module alone needs, built from placement.js's exported primitives.
// ---------------------------------------------------------------------------

/** Writes into `out` the point `dist` radians from `base` along `bearing`. */
function offsetPoint(base, bearing, dist, out) {
  tangentBasis(base, _tb1, _tb2)
  const cb = Math.cos(bearing)
  const sb = Math.sin(bearing)
  const tx = _tb1.x * cb + _tb2.x * sb
  const ty = _tb1.y * cb + _tb2.y * sb
  const tz = _tb1.z * cb + _tb2.z * sb
  const cd = Math.cos(dist)
  const sd = Math.sin(dist)
  return out.set(base.x * cd + tx * sd, base.y * cd + ty * sd, base.z * cd + tz * sd).normalize()
}

/** Tangent-plane-projected direction from `fromDir` to `toDir`, evaluated at `dir`. */
function tangentForward(dir, fromDir, toDir, out) {
  out.subVectors(toDir, fromDir)
  out.addScaledVector(dir, -out.dot(dir))
  if (out.lengthSq() < 1e-10) {
    warnDegenerateGeometry('tangentForward chord parallel to dir')
    tangentBasis(dir, _tb1, _tb2)
    out.copy(_tb1)
  }
  return out.normalize()
}

/** Normalized-lerp ("nlerp") point between unit vectors `a`/`b` — the same cheap great-circle approximation placement.js's stepToward uses internally. */
function nlerpPoint(out, a, b, t) {
  out.copy(a).lerp(b, t)
  if (out.lengthSq() < 1e-10) {
    warnDegenerateGeometry('nlerp of near-antipodal points')
    out.copy(a)
  }
  return out.normalize()
}

/** Signed turn angle (radians) from `fromVec` to `toVec`, both projected to the tangent plane at `dir`. Used to derive banking from how fast a ship's heading is changing. */
function signedTurnAngle(dir, fromVec, toVec) {
  _sa1.copy(fromVec).addScaledVector(dir, -fromVec.dot(dir))
  if (_sa1.lengthSq() < 1e-10) return 0
  _sa1.normalize()
  _sa2.copy(toVec).addScaledVector(dir, -toVec.dot(dir))
  if (_sa2.lengthSq() < 1e-10) return 0
  _sa2.normalize()
  const cosA = clamp(_sa1.dot(_sa2), -1, 1)
  _saCross.crossVectors(_sa1, _sa2)
  return Math.acos(cosA) * (_saCross.dot(dir) < 0 ? -1 : 1)
}

/** Parent directory of a filesystem path string (no node:path — this module runs in the browser). */
function parentDir(p) {
  const s = String(p || '').replace(/\/+$/, '')
  const idx = s.lastIndexOf('/')
  return idx > 0 ? s.slice(0, idx) : s
}

// ---------------------------------------------------------------------------
// Route derivation (art direction §6: "airship routes between real
// git-remote-derived settlement pairs").
//
// Heuristic v1 — filesystem-path clustering. world.js's `project` key IS a
// session's absolute cwd (server/scan.js), so projects that sit side by
// side under the same parent directory (e.g. everything under
// /Users/x/Cloover/*) read as a "trade cluster." Routes connect each
// cluster's biggest settlement (the hub) to its other qualifying members.
// If no cluster has 2+ qualifying members, the two largest settlements
// overall are linked instead, so a sparse machine still gets one route.
//
// Upgrade path (deliberately not built here): gitinfo.js already does real
// git-remote -> GitHub-org detection server-side (detectGithubRepo /
// parseGithubRepo) for its commit/PR polling. Once that org information is
// exposed to the client (e.g. folded into /api/sessions, or a small new
// endpoint), clustering by GitHub owner/org would be strictly better than
// this path heuristic — it would correctly link forks/clones that live
// under different directories but the same org, and separate unrelated
// repos that just happen to share a parent folder. Filesystem-path
// clustering is the client-only stopgap until that plumbing exists.
// ---------------------------------------------------------------------------
function deriveRoutes(world) {
  const anchorsByProject = new Map()
  world.group.traverse((obj) => {
    const s = obj.userData && obj.userData.settlement
    if (s && !anchorsByProject.has(s.project)) {
      anchorsByProject.set(s.project, { anchorDir: s.anchorDir, groundR: s.groundR, race: s.race })
    }
  })

  const settlements = []
  for (const row of world.list()) {
    const anchor = anchorsByProject.get(row.project)
    if (!anchor) continue
    settlements.push({
      project: row.project,
      name: row.name,
      race: row.race,
      structures: row.structures,
      anchorDir: anchor.anchorDir,
      groundR: anchor.groundR,
    })
  }

  const byParent = new Map()
  for (const s of settlements) {
    const key = parentDir(s.project)
    let arr = byParent.get(key)
    if (!arr) {
      arr = []
      byParent.set(key, arr)
    }
    arr.push(s)
  }

  const candidates = [] // { a, b, weight }
  for (const members of byParent.values()) {
    if (members.length < 2) continue
    const qualifying = members.filter((s) => s.structures >= MIN_ROUTE_STRUCTURES).sort((a, b) => b.structures - a.structures)
    if (qualifying.length < 2) continue
    const hub = qualifying[0]
    for (let i = 1; i < qualifying.length; i++) {
      candidates.push({ a: hub, b: qualifying[i], weight: hub.structures + qualifying[i].structures })
    }
  }

  if (candidates.length === 0) {
    const bySize = settlements.filter((s) => s.structures >= MIN_ROUTE_STRUCTURES).sort((a, b) => b.structures - a.structures)
    if (bySize.length >= 2) {
      candidates.push({ a: bySize[0], b: bySize[1], weight: bySize[0].structures + bySize[1].structures })
    }
  }

  candidates.sort((a, b) => b.weight - a.weight)
  return candidates.slice(0, ROUTE_CAP)
}

// ---------------------------------------------------------------------------
// Shared geometry / material caches — module-level, never per-instance
// (same convention as buildings.js's own geom()/mat() caches). Box/sphere
// geometry is imported from buildings.js so the airship stays on the same
// low-poly flat-shaded primitive budget as everything else at this zoom.
// ---------------------------------------------------------------------------
const _geomCache = new Map()
function geom(key, factory) {
  let g = _geomCache.get(key)
  if (!g) {
    g = factory()
    _geomCache.set(key, g)
  }
  return g
}

const _matCache = new Map()
function cachedMat(key, factory) {
  let m = _matCache.get(key)
  if (!m) {
    m = factory()
    _matCache.set(key, m)
  }
  return m
}

function clothMat(key, color) {
  return cachedMat(key, () => new THREE.MeshStandardMaterial({ color, flatShading: true, roughness: 0.82, metalness: 0.03 }))
}
function metalMat(key, color) {
  return cachedMat(key, () => new THREE.MeshStandardMaterial({ color, flatShading: true, roughness: 0.32, metalness: 0.75 }))
}

const cylGeo = () => geom('airship_cyl8', () => new THREE.CylinderGeometry(0.5, 0.5, 1, 8))
const ribRingGeo = () => geom('airship_ribRing', () => new THREE.TorusGeometry(1, 0.05, 5, 12))
const propHubGeo = () => geom('airship_propHub', () => new THREE.CylinderGeometry(0.5, 0.5, 1, 6))

// ---------------------------------------------------------------------------
// Dock mast visual — stone base, brass pole, small mooring arm with a brass
// finial where the ship's nose clips on, brass cap. Built in local
// unit-height space (~1 unit tall); buildMast() below scales the returned
// group by MAST_HEIGHT.
// ---------------------------------------------------------------------------
function buildMastVisual() {
  const g = new THREE.Group()
  const stoneM = clothMat('mast_stone', COLOR_STONE)
  const brassM = metalMat('mast_brass', BRASS)
  const darkM = clothMat('mast_dark', COLOR_DARK)

  const base = new THREE.Mesh(cylGeo(), stoneM)
  base.scale.set(0.3, 0.14, 0.3)
  base.position.y = 0.07
  g.add(base)

  const pole = new THREE.Mesh(cylGeo(), brassM)
  pole.scale.set(0.045, 0.8, 0.045)
  pole.position.y = 0.14 + 0.4
  g.add(pole)

  const arm = new THREE.Mesh(boxGeo(), darkM)
  arm.scale.set(0.035, 0.03, 0.26)
  arm.position.set(0, 0.14 + 0.8 - 0.05, 0.12)
  g.add(arm)

  const armTip = new THREE.Mesh(sphereGeo(), brassM)
  armTip.scale.setScalar(0.045)
  armTip.position.set(0, 0.14 + 0.8 - 0.05, 0.12 + 0.13)
  g.add(armTip)

  const cap = new THREE.Mesh(sphereGeo(), brassM)
  cap.scale.setScalar(0.06)
  cap.position.y = 0.14 + 0.8 + 0.02
  g.add(cap)

  return g
}

// ---------------------------------------------------------------------------
// Airship visual — elongated ellipsoid envelope (race-tinted cloth, brass
// rib rings), small wooden gondola + trim, rudder fin, two side propellers.
// Built centered on the envelope's own center: nose at local Z=+NOSE_FRAC,
// stern at Z=-NOSE_FRAC, in local unit-length space. The caller scales the
// whole group by the ship's world length; group.position tracks the
// envelope center, not the nose (see NOSE_FRAC usage in applyFlightTransform
// / applyMooredTransform for how mooring re-references to the nose).
// ---------------------------------------------------------------------------
function buildShipVisual(race) {
  const g = new THREE.Group()
  const pal = RACE_PALETTES[race] || RACE_PALETTES.human
  const envelopeM = clothMat('ship_envelope_' + race, pal.cloth)
  const gondolaM = clothMat('ship_wood', COLOR_WOOD)
  const trimM = clothMat('ship_trim', COLOR_DARK)
  const brassM = metalMat('ship_brass', BRASS)
  const finM = clothMat('ship_fin_' + race, pal.banner)
  const bladeM = clothMat('ship_blade', COLOR_DARK)

  const envelope = new THREE.Mesh(sphereGeo(), envelopeM)
  envelope.scale.set(0.26, 0.26, NOSE_FRAC * 2)
  envelope.position.set(0, 0.09, 0)
  g.add(envelope)

  // Brass rib rings — radius follows the ellipsoid's own profile so they
  // hug the hull; three stations read as "paneled canvas" without needing
  // separate alternating-color panel geometry.
  const ribStations = [-0.22, 0, 0.22]
  for (const sZ of ribStations) {
    const tNorm = clamp(sZ / NOSE_FRAC, -0.98, 0.98)
    const localR = 0.13 * Math.sqrt(1 - tNorm * tNorm)
    const ring = new THREE.Mesh(ribRingGeo(), brassM)
    ring.scale.set(localR, localR, 1)
    ring.position.set(0, 0.09, sZ)
    g.add(ring)
  }

  const gondola = new THREE.Mesh(boxGeo(), gondolaM)
  gondola.scale.set(0.1, 0.055, 0.32)
  gondola.position.set(0, -0.07, -0.02)
  g.add(gondola)

  const trim = new THREE.Mesh(boxGeo(), trimM)
  trim.scale.set(0.11, 0.016, 0.33)
  trim.position.set(0, -0.07 - 0.055 / 2 - 0.008, -0.02)
  g.add(trim)

  const rudder = new THREE.Mesh(boxGeo(), finM)
  rudder.scale.set(0.008, 0.13, 0.12)
  rudder.position.set(0, 0.13, -NOSE_FRAC - 0.02)
  g.add(rudder)

  function buildProp(sign) {
    const mount = new THREE.Group()
    mount.position.set(sign * 0.11, -0.07, 0.02)
    const hub = new THREE.Mesh(propHubGeo(), brassM)
    hub.scale.set(0.05, 0.04, 0.05)
    hub.rotation.x = Math.PI / 2 // hub axis -> local Z (ship forward = thrust axis)
    mount.add(hub)
    const spinner = new THREE.Group() // rotated each frame around its own local Z — see spinPropellers
    const b1 = new THREE.Mesh(boxGeo(), bladeM)
    b1.scale.set(0.095, 0.016, 0.006)
    spinner.add(b1)
    const b2 = new THREE.Mesh(boxGeo(), bladeM)
    b2.scale.set(0.016, 0.095, 0.006)
    spinner.add(b2)
    mount.add(spinner)
    g.add(mount)
    return spinner
  }
  const propL = buildProp(-1)
  const propR = buildProp(1)

  return { group: g, propL, propR }
}

// ---------------------------------------------------------------------------
// createAirships
// ---------------------------------------------------------------------------
export function createAirships(planet, world, seed) {
  const group = new THREE.Group()
  const mastsGroup = new THREE.Group()
  const shipsGroup = new THREE.Group()
  group.add(mastsGroup, shipsGroup)

  // --- steam trail: shared particle pool (see the constants block above) ---
  const trailPositions = new Float32Array(TRAIL_POOL_SIZE * 3)
  const trailColors = new Float32Array(TRAIL_POOL_SIZE * 4) // RGBA — itemSize 4 enables true per-vertex alpha, same as world.js's plume pool
  const trailVelocity = new Float32Array(TRAIL_POOL_SIZE * 3)
  const trailAge = new Float32Array(TRAIL_POOL_SIZE)
  const trailTtl = new Float32Array(TRAIL_POOL_SIZE) // 0 = free/dead slot
  let trailCursor = 0
  const trailGeo = new THREE.BufferGeometry()
  trailGeo.setAttribute('position', new THREE.BufferAttribute(trailPositions, 3))
  trailGeo.setAttribute('color', new THREE.BufferAttribute(trailColors, 4))
  const trailMat = new THREE.PointsMaterial({
    size: TRAIL_SIZE,
    sizeAttenuation: false,
    vertexColors: true,
    transparent: true,
    opacity: 1,
    blending: THREE.NormalBlending, // vapor, not glow — matches world.js's plume, deliberately not additive
    depthWrite: false,
  })
  const trailPoints = new THREE.Points(trailGeo, trailMat)
  trailPoints.renderOrder = 1
  trailPoints.frustumCulled = false // pool slots can sit anywhere on the planet
  group.add(trailPoints)

  function spawnTrailPuff(ship) {
    const slot = trailCursor
    trailCursor = (trailCursor + 1) % TRAIL_POOL_SIZE
    const i3 = slot * 3
    const i4 = slot * 4
    trailPositions[i3] = ship.sternWorld.x
    trailPositions[i3 + 1] = ship.sternWorld.y
    trailPositions[i3 + 2] = ship.sternWorld.z
    tangentBasis(ship.dir, _tb1, _tb2)
    const a = Math.random() * Math.PI * 2
    _trailVel
      .copy(ship.fwdWorld)
      .multiplyScalar(-TRAIL_BACK_SPEED)
      .addScaledVector(_tb1, Math.cos(a) * TRAIL_DRIFT_SPEED)
      .addScaledVector(_tb2, Math.sin(a) * TRAIL_DRIFT_SPEED)
      .addScaledVector(ship.upWorld, TRAIL_RISE_SPEED)
    trailVelocity[i3] = _trailVel.x
    trailVelocity[i3 + 1] = _trailVel.y
    trailVelocity[i3 + 2] = _trailVel.z
    trailAge[slot] = 0
    trailTtl[slot] = TRAIL_TTL * (0.85 + Math.random() * 0.3)
    const gc = 0.82 + Math.random() * 0.12
    trailColors[i4] = gc
    trailColors[i4 + 1] = gc
    trailColors[i4 + 2] = Math.min(1, gc + 0.03)
    trailColors[i4 + 3] = 0 // starts transparent; updateTrail fades it in over TRAIL_FADE_IN
  }

  function updateTrail(dt) {
    for (let slot = 0; slot < TRAIL_POOL_SIZE; slot++) {
      const t = trailTtl[slot]
      if (t <= 0) continue
      const a = trailAge[slot] + dt
      const i3 = slot * 3
      const i4 = slot * 4
      if (a >= t) {
        trailTtl[slot] = 0
        trailColors[i4 + 3] = 0
        continue
      }
      trailAge[slot] = a
      trailPositions[i3] += trailVelocity[i3] * dt
      trailPositions[i3 + 1] += trailVelocity[i3 + 1] * dt
      trailPositions[i3 + 2] += trailVelocity[i3 + 2] * dt
      const fadeIn = a < TRAIL_FADE_IN ? a / TRAIL_FADE_IN : 1
      trailColors[i4 + 3] = TRAIL_PEAK_ALPHA * fadeIn * (1 - a / t)
    }
    trailGeo.attributes.position.needsUpdate = true
    trailGeo.attributes.color.needsUpdate = true
  }

  function emitTrailIfDue(ship, dt) {
    ship.trailTimer -= dt
    if (ship.trailTimer <= 0) {
      ship.trailTimer = TRAIL_EMIT_INTERVAL * (0.85 + Math.random() * 0.3)
      spawnTrailPuff(ship)
    }
  }

  // --- masts ----------------------------------------------------------------

  function buildMast(settlement) {
    const rng = rngFromString(seed + ':airships:mast:' + settlement.project)
    const bearing = rng() * Math.PI * 2
    const base = offsetPoint(settlement.anchorDir, bearing, MAST_OFFSET_RAD, new THREE.Vector3())
    const dir = findLandAnchor(planet, base, rng)
    const groundR = planet.sampleHeight(dir)
    const visual = buildMastVisual()
    visual.scale.setScalar(MAST_HEIGHT)
    mastsGroup.add(visual)
    return { project: settlement.project, race: settlement.race, dir, groundR, facing: new THREE.Vector3(1, 0, 0), visual }
  }

  // --- ship lifecycle ---------------------------------------------------------

  function beginLeg(ship, originMast, destMast) {
    ship.originMast = originMast
    ship.destMast = destMast
    const angle = originMast.dir.angleTo(destMast.dir)
    const departAngle = Math.min(DEPART_ANGLE, angle * 0.25)
    const dep = originMast.dir.clone()
    stepToward(dep, destMast.dir, departAngle)
    const arr = destMast.dir.clone()
    stepToward(arr, originMast.dir, departAngle)
    ship.leg = { depDir: dep, arriveDir: arr }
    ship.cruiseDuration = Math.max(4, dep.angleTo(arr) / CRUISE_ANGULAR_SPEED)
  }

  function initShipPhase(ship, rng) {
    const r = rng()
    if (r < 0.3) {
      ship.phase = PHASE.MOORED
      ship.atMast = ship.originMast
      ship.pauseRemaining = TURNAROUND_MIN + rng() * (TURNAROUND_MAX - TURNAROUND_MIN)
      return
    }
    beginLeg(ship, ship.originMast, ship.destMast)
    if (r < 0.375) {
      ship.phase = PHASE.CASTOFF
      ship.phaseElapsed = rng() * CASTOFF_DUR
      ship.castoffStartForward.copy(ship.originMast.facing)
    } else if (r < 0.925) {
      ship.phase = PHASE.CRUISE
      ship.phaseElapsed = rng() * ship.cruiseDuration
    } else {
      ship.phase = PHASE.APPROACH
      ship.phaseElapsed = rng() * APPROACH_DUR
    }
  }

  function applyMooredTransform(ship) {
    const mast = ship.atMast
    const bob = Math.sin(simTime * MOOR_BOB_FREQ + ship.bobPhase) * MOOR_BOB_AMP
    const alt = mast.groundR + MAST_HEIGHT + bob
    const halfLength = ship.length * NOSE_FRAC
    ship.group.position.copy(mast.dir).multiplyScalar(alt).addScaledVector(mast.facing, -halfLength)
    orientOnSurface(ship.group, mast.dir, mast.facing)
    ship.group.rotateZ(Math.sin(simTime * MOOR_SWAY_FREQ + ship.bobPhase) * MOOR_SWAY_AMP)
    ship.group.rotateX(Math.sin(simTime * MOOR_SWAY_FREQ * 0.6 + ship.bobPhase * 1.7) * MOOR_SWAY_AMP * 0.4)
    ship.dir.copy(mast.dir)
    ship.alt = alt
    ship.speed01 = 0
  }

  // Flight phases (cast-off / cruise / approach) share one transform: a
  // ground-track direction + altitude derived from phase progress, a
  // tangent-projected forward blended between "facing the mast" and
  // "facing the route" during the two mast-adjacent phases, and a fading
  // nose-referenced position offset (mastOffsetFrac) so the pose is
  // continuous with applyMooredTransform's own nose-at-mast formula at
  // both ends of the leg — see NOSE_FRAC's doc comment above.
  function applyFlightTransform(ship, dt) {
    const leg = ship.leg
    const breathe = Math.sin(simTime * ALT_BREATH_FREQ + ship.bobPhase) * ALT_BREATH_AMPLITUDE
    const halfLength = ship.length * NOSE_FRAC
    let alt
    let mastOffsetFrac = 0

    if (ship.phase === PHASE.CASTOFF) {
      const eased = smoothstep(0, 1, clamp(ship.phaseElapsed / CASTOFF_DUR, 0, 1))
      nlerpPoint(_dirScratch, ship.originMast.dir, leg.depDir, eased)
      alt = lerp(ship.originMast.groundR + MAST_HEIGHT, CRUISE_ALT, eased) + breathe * eased
      tangentForward(_dirScratch, ship.originMast.dir, ship.destMast.dir, _routeFwdScratch)
      _fwdScratch.copy(ship.castoffStartForward).lerp(_routeFwdScratch, eased)
      ship.speed01 = eased
      mastOffsetFrac = 1 - eased
    } else if (ship.phase === PHASE.CRUISE) {
      const t = clamp(ship.phaseElapsed / ship.cruiseDuration, 0, 1)
      nlerpPoint(_dirScratch, leg.depDir, leg.arriveDir, t)
      alt = CRUISE_ALT + breathe
      tangentForward(_dirScratch, ship.originMast.dir, ship.destMast.dir, _fwdScratch)
      ship.speed01 = 1
    } else {
      const eased = smoothstep(0, 1, clamp(ship.phaseElapsed / APPROACH_DUR, 0, 1))
      nlerpPoint(_dirScratch, leg.arriveDir, ship.destMast.dir, eased)
      alt = lerp(CRUISE_ALT, ship.destMast.groundR + MAST_HEIGHT, eased) + breathe * (1 - eased)
      tangentForward(_dirScratch, ship.originMast.dir, ship.destMast.dir, _routeFwdScratch)
      _fwdScratch.copy(_routeFwdScratch).lerp(ship.destMast.facing, eased)
      ship.speed01 = 1 - eased
      mastOffsetFrac = eased
    }

    ship.dir.copy(_dirScratch)
    ship.alt = alt
    ship.group.position.copy(_dirScratch).multiplyScalar(alt)
    if (mastOffsetFrac > 0) ship.group.position.addScaledVector(_fwdScratch, -halfLength * mastOffsetFrac)
    orientOnSurface(ship.group, _dirScratch, _fwdScratch)

    if (ship.firstFrame) {
      ship.prevForward.copy(_fwdScratch)
      ship.firstFrame = false
    }
    const safeDt = Math.max(dt, 1e-4)
    const turnAngle = signedTurnAngle(_dirScratch, ship.prevForward, _fwdScratch)
    const targetBank = clamp((turnAngle / safeDt) * BANK_GAIN, -BANK_MAX, BANK_MAX)
    ship.bank += (targetBank - ship.bank) * clamp(BANK_SMOOTH * dt, 0, 1)
    ship.group.rotateZ(ship.bank)
    ship.prevForward.copy(_fwdScratch)

    _upWorldScratch.set(0, 1, 0).applyQuaternion(ship.group.quaternion)
    _fwdWorldScratch.set(0, 0, 1).applyQuaternion(ship.group.quaternion)
    ship.upWorld.copy(_upWorldScratch)
    ship.fwdWorld.copy(_fwdWorldScratch)
    ship.sternWorld.copy(ship.group.position).addScaledVector(_fwdWorldScratch, -halfLength)
  }

  function spinPropellers(ship, dt) {
    const spin = ship.speed01 * PROP_MAX_RATE * dt
    ship.propL.rotation.z += spin
    ship.propR.rotation.z += spin
  }

  function updateShip(ship, dt) {
    if (ship.phase === PHASE.MOORED) {
      ship.pauseRemaining -= dt
      applyMooredTransform(ship)
      spinPropellers(ship, dt)
      if (ship.pauseRemaining <= 0) {
        const neighbors = adjacency.get(ship.atMast.project)
        const nextMast = mastsByProject.get(neighbors[Math.floor(ship.rng() * neighbors.length)])
        ship.castoffStartForward.copy(ship.atMast.facing)
        beginLeg(ship, ship.atMast, nextMast)
        ship.phase = PHASE.CASTOFF
        ship.phaseElapsed = 0
      }
      return
    }

    ship.phaseElapsed += dt
    applyFlightTransform(ship, dt)
    spinPropellers(ship, dt)
    if (ship.phase === PHASE.CRUISE) emitTrailIfDue(ship, dt)

    if (ship.phase === PHASE.CASTOFF && ship.phaseElapsed >= CASTOFF_DUR) {
      ship.phase = PHASE.CRUISE
      ship.phaseElapsed = 0
    } else if (ship.phase === PHASE.CRUISE && ship.phaseElapsed >= ship.cruiseDuration) {
      ship.phase = PHASE.APPROACH
      ship.phaseElapsed = 0
    } else if (ship.phase === PHASE.APPROACH && ship.phaseElapsed >= APPROACH_DUR) {
      ship.phase = PHASE.MOORED
      ship.atMast = ship.destMast
      ship.pauseRemaining = TURNAROUND_MIN + ship.rng() * (TURNAROUND_MAX - TURNAROUND_MIN)
    }
  }

  function createShip(seedStr, home, target) {
    const rng = rngFromString(seedStr + ':decisions')
    const visRng = rngFromString(seedStr + ':visual')
    const { group: visualGroup, propL, propR } = buildShipVisual(home.race)
    const length = SHIP_LENGTH * (0.92 + visRng() * 0.2)
    visualGroup.scale.setScalar(length)

    const ship = {
      group: visualGroup,
      propL,
      propR,
      length,
      rng,
      atMast: home,
      originMast: home,
      destMast: target,
      leg: null,
      cruiseDuration: 1,
      phase: PHASE.MOORED,
      phaseElapsed: 0,
      pauseRemaining: 0,
      dir: new THREE.Vector3().copy(home.dir),
      alt: home.groundR + MAST_HEIGHT,
      fwdWorld: new THREE.Vector3(),
      upWorld: new THREE.Vector3(),
      sternWorld: new THREE.Vector3(),
      prevForward: new THREE.Vector3(),
      castoffStartForward: new THREE.Vector3(),
      bank: 0,
      speed01: 0,
      trailTimer: Math.random() * TRAIL_EMIT_INTERVAL,
      bobPhase: rng() * Math.PI * 2,
      firstFrame: true,
    }
    // Scene-graph back-reference, same convention as world.js's own
    // hitMesh.userData.settlement / userData.structure.
    visualGroup.userData.airship = ship

    initShipPhase(ship, rng)
    updateShip(ship, 0) // prime position/orientation so frame 1 never pops in at the origin
    return ship
  }

  // --- fleet state (populated lazily — see the state machine in update()) ---
  let mastsByProject = null
  let adjacency = null
  const ships = []

  function buildFleet() {
    const routes = deriveRoutes(world)
    if (routes.length === 0) return // a machine with <2 related qualifying settlements correctly flies no ships

    adjacency = new Map()
    const link = (pa, pb) => {
      if (!adjacency.has(pa)) adjacency.set(pa, [])
      adjacency.get(pa).push(pb)
    }
    mastsByProject = new Map()
    for (const r of routes) {
      link(r.a.project, r.b.project)
      link(r.b.project, r.a.project)
      if (!mastsByProject.has(r.a.project)) mastsByProject.set(r.a.project, buildMast(r.a))
      if (!mastsByProject.has(r.b.project)) mastsByProject.set(r.b.project, buildMast(r.b))
    }

    // Facing: toward the first neighbor, tangent-projected — the direction
    // moored ships nose into and depart along.
    for (const mast of mastsByProject.values()) {
      const neighbors = adjacency.get(mast.project) || []
      if (neighbors.length > 0) {
        tangentForward(mast.dir, mast.dir, mastsByProject.get(neighbors[0]).dir, mast.facing)
      } else {
        tangentBasis(mast.dir, _tb1, _tb2)
        mast.facing.copy(_tb1)
      }
      orientOnSurface(mast.visual, mast.dir, mast.facing)
      mast.visual.position.copy(mast.dir).multiplyScalar(mast.groundR)
    }

    const routedMasts = Array.from(mastsByProject.values())
    const fleetRng = rngFromString(seed + ':airships:fleet-size')
    const shipCount = SHIP_COUNT_MIN + Math.floor(fleetRng() * (SHIP_COUNT_MAX - SHIP_COUNT_MIN + 1))
    for (let i = 0; i < shipCount; i++) {
      const assignRng = rngFromString(seed + ':airships:assign:' + i)
      const home = routedMasts[Math.floor(assignRng() * routedMasts.length)]
      const homeNeighbors = adjacency.get(home.project)
      const target = mastsByProject.get(homeNeighbors[Math.floor(assignRng() * homeNeighbors.length)])
      const ship = createShip(seed + ':airships:ship:' + i, home, target)
      ships.push(ship)
      shipsGroup.add(ship.group)
    }
  }

  // --- update: waiting (no settlements yet) -> settling (let world.js's
  // poll populate) -> ready (fleet built, ships flying). Fast-forwarding
  // update() with a large dt advances this state machine proportionally,
  // same as ship phases below — see the M2.5 JIT plan's verify step.
  let simTime = 0
  let initPhase = 'waiting'
  let peekTimer = 0
  let settleRemaining = 0

  function update(dt) {
    simTime += dt

    if (initPhase === 'ready') {
      for (let i = 0; i < ships.length; i++) updateShip(ships[i], dt)
      updateTrail(dt)
      return
    }

    if (initPhase === 'waiting') {
      peekTimer -= dt
      if (peekTimer > 0) return
      peekTimer = INIT_RECHECK_INTERVAL
      let any = false
      world.group.traverse((obj) => {
        if (obj.userData && obj.userData.settlement) any = true
      })
      if (any) {
        initPhase = 'settling'
        settleRemaining = INIT_SETTLE_DELAY
      }
      return
    }

    // initPhase === 'settling'
    settleRemaining -= dt
    if (settleRemaining > 0) return
    initPhase = 'ready'
    buildFleet()
  }

  return { group, update }
}
