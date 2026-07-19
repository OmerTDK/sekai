// warsim.js — the E-SIM conflict SIMULATION/DATA layer. PURE data: no THREE
// rendering, no materials, no scene graph. This module reduces
// `(settlement snapshot, worldSeed, warClock, ingested git history)` to a fully
// deterministic, replayable set of raids — who marches on whom, when, the
// on-land battlefield/muster/defense geometry, per-unit formation slots +
// casualty times, the seeded outcome, and every mark (scorch/banner/prop)
// position. warrender.js is a PURE projection of this state, exactly as
// civrender.js is of civsim.js.
//
// ─────────────────────────────────────────────────────────────────────────────
// RUNGS
//   Rung 1 (shipped): the seeded skirmish theater. Raider settlements
//     (tmp/scratch dirs or the orc race) march on the most-attractive in-range
//     target; a field battle clashes at an on-land midpoint; the aftermath
//     leaves winner banners + ground scorch + ruins-props, all healing over the
//     epoch. Built ONCE at construction, purely from the seed + snapshot.
//   Rung 2 (data-driven, additive): ingest() accepts the live /api/events feed
//     (server/gitinfo.js). Merge-conflict events between related projects stage
//     BORDER skirmishes; commit / pr-merged activity refines raid attractiveness
//     (prosperity); a derived supply-route graph exposes INTERCEPT targets whose
//     ambush scorches the road and scatters supply props; prosperityOf/
//     supplyRoutes/ingest are exposed. A territory/influence field between rival
//     clusters is exposed for the render overlay.
//   Rung 3 (deep sim, additive): persistent faction STANDING evolves from the
//     cumulative event log (conflicts lower it, merges raise it); a SUPPLY
//     economy over the route graph (interceptions cut a settlement's supply,
//     which lowers its strength in the NEXT raid); SIEGES surround a rich,
//     deeply-hostile target on a covenant-clear ring (NEVER entering the
//     footprint) and always lift + heal; a pr-merge between rivals seals a
//     TREATY that suppresses raids and narrates peace. standingBetween /
//     treatyBetween / supplyOf are exposed.
//
//   Every rung-2/3 addition is a PURE function of (seed, warClock, the SET of
//   ingested events). With NO live drivers ingested, the module reduces
//   bit-for-bit to rung 1: the seeded raids, their geometry, outcomes and
//   timings are byte-identical for a fixed seed. (See the preservedR1 proof.)
//
// ─────────────────────────────────────────────────────────────────────────────
// Contract (only ADD keys/inputs vs rung 1 — never remove or change meaning):
//   createWarSim(planet, settlements, seed, opts={})
//     -> { // rung 1 (unchanged) —
//          raids, EPOCH,
//          isRaider(projectOrSettlement)->bool,
//          strengthOf(settlement)->number,
//          attractivenessOf(settlement)->number,
//          raidStateAt(raid, warClock, out={})->out,
//          outcomeLine(raid)->string,
//          meta:{ raidCount },
//          // rung 2 (additive) —
//          ingest(events)->void,
//          supplyRoutes:[{a,b,aDir,bDir,kind}],
//          deriveSupplyRoutes()->routes,
//          scheduleInterceptOnRoute(route, id?)->raid|null,
//          prosperityOf(settlementOrProject)->0..1,
//          territoryAt(dir, out={})->{ faction, influence } | field accessor,
//          // rung 3 (additive) —
//          standingBetween(a,b)->-1..1,
//          treatyBetween(a,b)->bool,
//          supplyOf(settlementOrProject, warClock?)->0..1 }
//   `settlements` is an array of
//     { project, name, race, structures, anchorDir:Vector3, groundR,
//       structureDirs:Vector3[], sessionCount? }
//   `events` (ingest) is the /api/events array — the shape events.js/herald
//     consume: { project, kind:'commit'|'pr-merged'|'conflict', id, title, ts,
//     other? } where `other` (optional) is the related/rival project path.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE COVENANT: session structures are immutable history. This file NEVER
// writes, moves, recolors, scales or hides them. Every battlefield, muster,
// defensive line, scorch, banner, prop, siege-ring station AND supply-props
// position is rejection-sampled against a covenant set (every settlement
// anchorDir PLUS every structureDir), requiring >= MARK_CLEARANCE great-circle
// radians of clearance AND clear land below the build ceiling. An expanding-ring
// search widens the offset until clear; if no clear spot exists the raid/siege
// is DROPPED (warn-once) rather than ever placed on a record. A siege surrounds
// the target on a ring strictly OUTSIDE the footprint and always lifts + heals.
// Because raidStateAt(raid, warClock) is a pure function of the clock, every
// mark heals automatically and totally.
//
// Determinism law: every stateful value derives from string seeds via
// rngFromString / hash01 (util.js). No Math.random and no wall-clock reads
// anywhere in this file (it stays grep-clean of both). Sim state is a pure
// function of warClock (an accumulated dt scalar owned by warrender's clock);
// data-driven state is a pure function of the SET of ingested events (deduped by
// id, deltas are commutative), so scrub/reload with the same seed + event
// history replays identically. The sole clock the module observes is the
// warClock passed to raidStateAt each frame — cached as `_lastClock` so ingest
// can schedule a fresh event's skirmish to begin "now"; this cache never feeds
// any pure output (it only time-stamps newly-scheduled data raids).
//
// Vector3 is imported from the three CORE entry (not 'three/webgpu'), exactly
// like civsim.js: it is pure math, three/webgpu re-exports the identical class,
// and the core import keeps this data module light and node-testable.
import { Vector3 } from 'three'
import { SEA_LEVEL, clamp, lerp, smoothstep, rngFromString, hash01 } from './util.js'

// ---------------------------------------------------------------------------
// Tunable knobs (deterministic simulation parameters). Sim units are seconds of
// warClock.
// ---------------------------------------------------------------------------
const MAX_RAID_ANGLE = 0.6 // radians — farthest a raider will march to a target
const RAID_CAP = 4 // hard cap on concurrent SEEDED raids (motion / mark budget)
const MARK_CLEARANCE = 0.03 // radians — min great-circle clearance from ANY covenant point
const MAX_BUILD_HEIGHT = SEA_LEVEL + 0.03 // sampleHeight() must be below this to be walkable ground

const ATK_MIN = 6
const ATK_MAX = 16
const DEF_MIN = 5
const DEF_MAX = 14

const SCORCH_COUNT = 7 // scorch marks in the battlefield ring (and again around a raided target)
const BANNERS_PER_RAID = 3

const EPOCH = 90 // sim-seconds — one full seeded-raid cycle (idempotent → total heal)
const MARCH_DUR = 14 // armies march into position
const MUSTER_LEAD = 6 // defenders begin mustering this long before the clash
const CLASH_DUR = 10 // the field battle
const AFTERMATH_DUR = 12 // banners planted / props strewn after the clash
const HEAL_DUR = 20 // scorch/marks lerp back to ground over this long from clash end

const MUSTER_OFFSET = 0.05 // radians — attacker assembly point outward from target toward source
const TARGET_SCORCH_RING = 0.045 // radians — ring around a raided settlement (ground, never buildings)

const TWO_PI = Math.PI * 2

// tmp/scratch dirs are canonically the raider faction (orc race is the other).
const RAIDER_PATH_RE = /(^|\/)(tmp|temp|\.tmp|var\/folders|T\/)/

// Herald vocab — kept tiny and local (never invents data; only names from the
// snapshot flow into the sentence).
const RAIDER_WORDS = ['tuskclans', 'iron-drummers', 'warhost']
const REALM_WORDS = ['banner-folk', 'wardens', 'free-companies']

// --- Rung 2/3 tunables ------------------------------------------------------
const DATA_RAID_CAP = 2 // data-driven raids may push concurrency to RAID_CAP + this
const RELATED_DIST = 0.26 // radians — two settlements are "related" within this (roads.js DIST_THRESHOLD)
const SEEN_EVENT_CAP = 2000 // dedup-set bound (events.js idiom)

// Prosperity / activity (attractiveness refinement).
const ACTIVITY_BOOST = 0.6 // max fractional attractiveness bump a fully-active settlement earns

// Supply economy.
const SUPPLY_ROUTE_CAP = 8 // max derived supply routes
const SUPPLY_ROUTE_MAX_ANGLE = 0.6 // radians — a supply route is never an ocean-crossing
const MIN_ROUTE_STRUCTURES = 1 // a settlement must have at least this many structures to anchor a route
const RESUPPLY_DUR = 120 // sim-seconds for an intercepted settlement to recover full supply
const SUPPLY_HIT = 0.5 // supply removed per interception (decays linearly over RESUPPLY_DUR)
const SUPPLY_MIN = 0.25 // supply floor
const SUPPLY_STRENGTH_FLOOR = 0.6 // strengthOf() multiplier at zero supply (1.0 at full supply)

// Border skirmish (conflict-driven).
const BORDER_MARCH = 12 // border skirmishes muster a touch faster than a full raid

// Intercept (supply ambush).
const INTERCEPT_MARCH = 6 // a road ambush strikes fast (shorter march than a raid)
const INTERCEPT_ATK = 5
const INTERCEPT_DEF = 4
const SUPPLY_PROP_COUNT = 4 // scattered crates/barrels dropped at the ambush point

// Faction standing (persistent, from the cumulative event log).
const STANDING_MIN = -1
const STANDING_MAX = 1
const STANDING_CONFLICT = 0.34 // each conflict lowers standing between two clusters
const STANDING_MERGE = 0.6 // each merge raises it
const SIEGE_STANDING = -0.6 // at/below this standing (with a rich target) a conflict escalates to a siege
const SIEGE_RICH_STRENGTH = 5 // the besieged target must be at least this strong to be worth a siege
const TREATY_STANDING = 0.4 // at/above this a merge seals a treaty
const TREATY_COOLDOWN = 240 // sim-seconds a treaty suppresses raids between two clusters

// Siege geometry / phases (covenant: the ring is strictly OUTSIDE the footprint).
const SIEGE_APPROACH = 12
const SIEGE_ENCIRCLE = 10
const SIEGE_HOLD = 26
const SIEGE_LIFT = 10
const SIEGE_RING = 0.052 // radians — besieger ring radius (outside any structure)
const SIEGE_RING_POINTS = 10 // besieger stations around the ring
const SIEGE_SCORCH_RING = 0.05 // radians — scorch ring on the GROUND around (never on) the settlement
const SIEGE_MIN_RING = 4 // fewer clear ring stations than this ⇒ drop the siege (covenant wins)

// Treaty peace beat.
const PEACE_SHOW = TREATY_COOLDOWN // a peace banner stands for the treaty's cooldown, then heals

// ---------------------------------------------------------------------------
// Spherical math (pure) — duplicated locally per codebase convention (see
// civsim.js / placement.js). Identical math to placement.js so results match.
// ---------------------------------------------------------------------------
const _tb1 = new Vector3()
const _tb2 = new Vector3()
const _tmp = new Vector3()

function tangentBasis(dir, outT1, outT2) {
  if (Math.abs(dir.y) < 0.999) outT1.set(0, 1, 0).cross(dir).normalize()
  else outT1.set(1, 0, 0).cross(dir).normalize()
  outT2.crossVectors(dir, outT1).normalize()
}

/** Writes into `out` the unit point `dist` radians from `base` along `bearing`. */
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

/** Normalized-lerp "slerp" between two unit vectors, written into `out`. */
function slerpUnit(a, b, t, out) {
  return out.set(lerp(a.x, b.x, t), lerp(a.y, b.y, t), lerp(a.z, b.z, t)).normalize()
}

/** Great-circle angle (radians) between two unit vectors, via clamped dot — allocation-free. */
function angleBetween(a, b) {
  return Math.acos(clamp(a.x * b.x + a.y * b.y + a.z * b.z, -1, 1))
}

/** Writes into `out` the unit tangent at `base` pointing toward `other`. */
function tangentToward(base, other, out) {
  const dot = other.x * base.x + other.y * base.y + other.z * base.z
  out.set(other.x - base.x * dot, other.y - base.y * dot, other.z - base.z * dot)
  if (out.lengthSq() < 1e-12) {
    tangentBasis(base, _tb1, _tb2)
    return out.copy(_tb1)
  }
  return out.normalize()
}

/** Bearing (radians, in `base`'s tangent frame) from `base` toward `other`. */
function bearingToward(base, other) {
  tangentBasis(base, _tb1, _tb2)
  const dot = other.x * base.x + other.y * base.y + other.z * base.z
  const tx = other.x - base.x * dot
  const ty = other.y - base.y * dot
  const tz = other.z - base.z * dot
  const b1 = tx * _tb1.x + ty * _tb1.y + tz * _tb1.z
  const b2 = tx * _tb2.x + ty * _tb2.y + tz * _tb2.z
  return Math.atan2(b2, b1)
}

/** Parent directory of a filesystem path string (no node:path — this runs in the browser). Mirrors airships.js/roads.js. */
function parentDir(p) {
  const s = String(p || '').replace(/\/+$/, '')
  const idx = s.lastIndexOf('/')
  return idx > 0 ? s.slice(0, idx) : s
}

/** Best-effort display name for a settlement (its fantasy name, else a tidied basename). */
function nameOf(s) {
  if (s && s.name) return s.name
  const p = (s && s.project) || ''
  const base = String(p).split('/').filter(Boolean).pop() || p
  return base ? base.replace(/[-_]+/g, ' ') : 'the settlement'
}

const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s)

// ---------------------------------------------------------------------------
// createWarSim — the public factory.
// ---------------------------------------------------------------------------
export function createWarSim(planet, settlements, seed, opts = {}) {
  const worldSeed = String(seed)
  const list = Array.isArray(settlements) ? settlements.filter((s) => s && s.anchorDir) : []
  const raidCap = opts.raidCap ?? RAID_CAP

  // --- Covenant set: every session anchor PLUS every structure. Immutable. ---
  const covenant = []
  for (const s of list) {
    covenant.push(new Vector3(s.anchorDir.x, s.anchorDir.y, s.anchorDir.z).normalize())
    if (Array.isArray(s.structureDirs)) {
      for (const d of s.structureDirs) {
        if (d && typeof d.x === 'number') covenant.push(new Vector3(d.x, d.y, d.z).normalize())
      }
    }
  }

  // Project → settlement index (read-only snapshot lookups for ingest).
  const byProject = new Map()
  for (const s of list) if (!byProject.has(s.project)) byProject.set(s.project, s)

  // --- Rung 2/3 mutable state (all deterministic functions of ingested events
  // + warClock). Declared BEFORE buildRaids() runs so strengthOf/attractivenessOf
  // can reference the "economy active?" flags; both flags are false at
  // construction, so the seeded raids are built on the pure rung-1 path. -------
  const activity = new Map() // project -> { count, lastTs }  (commit/pr-merged tally)
  const standings = new Map() // clusterPairKey -> number in [STANDING_MIN, STANDING_MAX]
  const treatyUntil = new Map() // clusterPairKey -> warClock at which the treaty lapses
  const supplyHits = new Map() // project -> [{ at }]  (interception timestamps in warClock)
  const seenEventIds = new Set() // dedup ingested events (deltas applied exactly once)
  let _lastClock = 0 // most recent warClock observed via raidStateAt (heartbeat; never a pure output)
  let activityActive = false // becomes true after the first commit/pr-merged tally
  let supplyEconomyActive = false // becomes true after the first interception
  let warnedNoBattlefield = false
  let warnedNoSiege = false
  const _capScratch = {} // reused by activeDataRaidCount / pruneHealed

  /**
   * The core covenant guarantee: a direction is "clear" only if it is at least
   * `minRad` great-circle radians from EVERY covenant point AND on walkable land
   * below the build ceiling. No mark is ever placed anywhere clearOf is false.
   */
  function clearOf(dir, minRad) {
    for (let i = 0; i < covenant.length; i++) {
      if (angleBetween(dir, covenant[i]) < minRad) return false
    }
    if (!planet.isLand(dir)) return false
    if (planet.sampleHeight(dir) >= MAX_BUILD_HEIGHT) return false
    return true
  }

  /**
   * Expanding-ring search: if `base` is already clear, copy it into `out`;
   * otherwise sample seeded points around `base`, widening the offset ~1.15x
   * every few tries up to a cap. Returns true (with `out` set to a clear point)
   * or false if no clear spot was found within budget.
   */
  function findClear(base, seedTag, minRad, startDist, out) {
    if (clearOf(base, minRad)) {
      out.copy(base).normalize()
      return true
    }
    const rng = rngFromString(worldSeed + '|' + seedTag)
    let dist = startDist
    const CLEAR_TRIES = 44
    for (let t = 0; t < CLEAR_TRIES; t++) {
      offsetPoint(base, rng() * TWO_PI, dist, out)
      if (clearOf(out, minRad)) return true
      if ((t + 1) % 4 === 0) dist = Math.min(dist * 1.15, 0.4)
    }
    return false
  }

  // --- Faction / strength / attractiveness -----------------------------------
  function isRaider(sOrProject) {
    const project = typeof sOrProject === 'string' ? sOrProject : (sOrProject && sOrProject.project) || ''
    const race = typeof sOrProject === 'string' ? null : sOrProject && sOrProject.race
    return RAIDER_PATH_RE.test(project) || race === 'orc'
  }

  // strengthOf: the rung-1 proxy is `max(structures, 3)` (richest = most
  // structures; floor of 3 so a bare scratch dir can still field a war party).
  // Rung 3 folds in the supply economy: a settlement whose supply lines have
  // been cut fields fewer defenders in its NEXT raid. CRUCIALLY this only
  // engages AFTER the first interception (supplyEconomyActive) and the
  // multiplier is EXACTLY 1.0 at full supply, so with no drivers strengthOf
  // returns the identical integer rung 1 did — and the seeded raids (built at
  // construction, before any interception) are byte-identical. Optional
  // `sessionCount` from the snapshot (historical session tally) reinforces the
  // structure count where present.
  function strengthOf(s) {
    let base = Math.max((s && s.structures) || 0, 3)
    if (s && typeof s.sessionCount === 'number' && s.sessionCount > 0) {
      base = Math.max(base, Math.round((base + s.sessionCount) / 2))
    }
    if (!supplyEconomyActive || !s || !s.project) return base
    return base * supplyMultiplier(s)
  }

  // attractivenessOf: rung 1 is `strengthOf(s)` (targeting favors the richest
  // settlement). Rung 2 refines it with a prosperity boost from live git
  // activity (commits / merges), multiplicatively on top of strength so that —
  // with no activity ingested — it collapses to exactly strengthOf (and the
  // seeded raid pairings/ordering are identical). The boost only steers NEW
  // data-driven targeting decisions made during ingest.
  function attractivenessOf(s) {
    const base = strengthOf(s)
    if (!activityActive || !s) return base
    return base * (1 + ACTIVITY_BOOST * activityScore01(s))
  }

  // --- Raid construction (rung 1 — runs ONCE, on the pure path) --------------
  const raids = buildRaids()

  function buildRaids() {
    const raiders = list.filter((s) => isRaider(s))
    const targets = list.filter((s) => !isRaider(s))

    // Pair each raider to its most-attractive in-range non-raider target.
    // Ties broken deterministically by a per-(raider,target) hash — the jitter
    // is < 1, so it only separates equal integer attractiveness, never reorders
    // distinct richness.
    const pairs = []
    const seen = new Set()
    for (const raider of raiders) {
      let best = null
      let bestScore = -Infinity
      for (const t of targets) {
        if (angleBetween(raider.anchorDir, t.anchorDir) > MAX_RAID_ANGLE) continue
        const score = attractivenessOf(t) + 1e-3 * hash01(raider.project + ':target:' + t.project)
        if (score > bestScore) {
          bestScore = score
          best = t
        }
      }
      if (!best) continue
      const id = 'raid:' + raider.project + '>' + best.project
      if (seen.has(id)) continue
      seen.add(id)
      pairs.push({ raider, target: best, id })
    }

    // Richest targets first (deterministic hash tie-break), then cap.
    pairs.sort(
      (a, b) =>
        attractivenessOf(b.target) - attractivenessOf(a.target) ||
        hash01(b.id + ':o') - hash01(a.id + ':o'),
    )
    const capped = pairs.slice(0, raidCap)

    const out = []
    for (const pair of capped) {
      const raid = buildRaid(pair.raider, pair.target, pair.id, out.length)
      if (raid) out.push(raid)
    }

    if (out.length === 0) {
      console.warn(
        '[planet] warsim.js: no raids — need a raider (tmp/orc) settlement and a target within range',
      )
    }
    return out
  }

  // buildRaid — builds a march→clash→aftermath record. Rung 1 calls it with no
  // `opts`; every option defaults to the exact rung-1 value, so a default call
  // reproduces the shipped record (same seed tags, same geometry, same outcome).
  // Data-driven kinds (border/intercept) pass opts to retune march length, force
  // an on-route battlefield, override unit counts, suppress the settlement
  // scorch-ring, and pin a "start now" schedule; only then are the extra fields
  // (oneShot/scheduledAt/durations/supplyProps) attached to the record.
  function buildRaid(raider, target, id, idx, opts = {}) {
    const kind = opts.kind || 'raid'
    const sourceDir = new Vector3(raider.anchorDir.x, raider.anchorDir.y, raider.anchorDir.z).normalize()
    const targetDir = new Vector3(target.anchorDir.x, target.anchorDir.y, target.anchorDir.z).normalize()

    // Battlefield — the great-circle midpoint (biased toward the target), nudged
    // clear. Its failure is the canonical "no clear battlefield" drop. An
    // intercept pins the battlefield to an on-route ambush point instead.
    const battlefieldDir = new Vector3()
    if (opts.battlefieldDir) {
      battlefieldDir.copy(opts.battlefieldDir).normalize()
    } else {
      slerpUnit(sourceDir, targetDir, 0.55, _tmp)
      if (!findClear(_tmp, id + ':bf', MARK_CLEARANCE, 0.03, battlefieldDir)) return dropRaid(target)
    }

    // Muster — attacker assembly point offset OUTWARD from the target toward the
    // incoming enemy (so the army forms up OUTSIDE the settlement footprint).
    const musterDir = new Vector3()
    offsetPoint(targetDir, bearingToward(targetDir, sourceDir), MUSTER_OFFSET, _tmp)
    if (!findClear(_tmp, id + ':muster', MARK_CLEARANCE, 0.02, musterDir)) return dropRaid(target)

    // Defense — defender line between the target and the battlefield.
    const defenseDir = new Vector3()
    slerpUnit(targetDir, battlefieldDir, 0.5, _tmp)
    if (!findClear(_tmp, id + ':defense', MARK_CLEARANCE, 0.02, defenseDir)) return dropRaid(target)

    const atkCount =
      opts.atkCount != null ? opts.atkCount : clamp(Math.round(strengthOf(raider) * 1.1), ATK_MIN, ATK_MAX)
    const defCount =
      opts.defCount != null ? opts.defCount : clamp(Math.round(strengthOf(target)), DEF_MIN, DEF_MAX)

    // Per-unit formation slots + casualty fall-times. Each unit gets its own
    // seeded RNG stream (three sequential draws: bearing, dist, fallAt).
    const attackerSlots = buildSlots(id + ':atk:', atkCount)
    const defenderSlots = buildSlots(id + ':def:', defCount)

    // Outcome — defenders repel unless the raiders clearly out-muscle them.
    const r = hash01(id + ':outcome')
    const outcome =
      opts.forcedOutcome ||
      (strengthOf(target) * (0.6 + 0.8 * r) >= strengthOf(raider) ? 'repelled' : 'raided')
    const winnerFaction = outcome === 'raided' ? 'raider' : 'realm'

    // Scorch — a ring on the battlefield ground, plus (only if the settlement
    // fell, and only when the caller wants it) a ring AROUND the target on the
    // GROUND, never on the buildings. Border/intercept skirmishes suppress the
    // target ring (opts.scorchTargetRing === false) — they scar the field/road,
    // not a settlement.
    const scorchDirs = []
    for (let i = 0; i < SCORCH_COUNT; i++) {
      const rng = rngFromString(worldSeed + '|' + id + ':scorch:' + i)
      const bearing = (i / SCORCH_COUNT) * TWO_PI + rng() * 0.5
      const dist = 0.008 + rng() * 0.012
      offsetPoint(battlefieldDir, bearing, dist, _tmp)
      const v = new Vector3()
      if (findClear(_tmp, id + ':scorchC:' + i, MARK_CLEARANCE, 0.006, v)) scorchDirs.push(v)
    }
    const doTargetRing = opts.scorchTargetRing !== false
    if (outcome === 'raided' && doTargetRing) {
      for (let i = 0; i < SCORCH_COUNT; i++) {
        const rng = rngFromString(worldSeed + '|' + id + ':tscorch:' + i)
        const bearing = (i / SCORCH_COUNT) * TWO_PI + rng() * 0.4
        const dist = TARGET_SCORCH_RING + (rng() - 0.5) * 0.01
        offsetPoint(targetDir, bearing, dist, _tmp)
        const v = new Vector3()
        if (findClear(_tmp, id + ':tscorchC:' + i, MARK_CLEARANCE, 0.006, v)) scorchDirs.push(v)
      }
    }

    // Banners — winner-side, planted near the battlefield, facing the vanquished.
    const bannerDirs = []
    const facedAnchor = winnerFaction === 'raider' ? targetDir : sourceDir
    for (let i = 0; i < BANNERS_PER_RAID; i++) {
      const rng = rngFromString(worldSeed + '|' + id + ':banner:' + i)
      const bearing = (i / BANNERS_PER_RAID) * TWO_PI + rng() * 0.6
      const dist = 0.006 + rng() * 0.008
      offsetPoint(battlefieldDir, bearing, dist, _tmp)
      const dir = new Vector3()
      if (!findClear(_tmp, id + ':bannerC:' + i, MARK_CLEARANCE, 0.005, dir)) continue
      const forward = new Vector3()
      tangentToward(dir, facedAnchor, forward)
      bannerDirs.push({ dir, forward })
    }

    // Ruins-props — a couple of broken carts strewn on the battlefield.
    const propDirs = []
    const propRng = rngFromString(worldSeed + '|' + id + ':props')
    const propCount = 2 + Math.floor(propRng() * 2) // 2 or 3
    for (let i = 0; i < propCount; i++) {
      const rng = rngFromString(worldSeed + '|' + id + ':prop:' + i)
      const bearing = rng() * TWO_PI
      const dist = 0.005 + rng() * 0.01
      offsetPoint(battlefieldDir, bearing, dist, _tmp)
      const v = new Vector3()
      if (findClear(_tmp, id + ':propC:' + i, MARK_CLEARANCE, 0.005, v)) propDirs.push(v)
    }

    const record = {
      id,
      kind,
      idx,
      raider,
      target,
      epochOffset: opts.epochOffset != null ? opts.epochOffset : idx * (EPOCH / raidCap),
      sourceDir,
      targetDir,
      musterDir,
      battlefieldDir,
      defenseDir,
      atkCount,
      defCount,
      attackerSlots,
      defenderSlots,
      outcome,
      winnerFaction,
      scorchDirs,
      bannerDirs,
      propDirs,
    }

    // Only data-driven kinds carry the extra fields — a rung-1 'raid' record
    // keeps EXACTLY the original key set (see preservedR1).
    if (kind !== 'raid') {
      record.oneShot = opts.oneShot === true
      record.scheduledAt = opts.scheduledAt != null ? opts.scheduledAt : record.epochOffset
      if (opts.marchDur != null) record.marchDur = opts.marchDur
      if (opts.clashDur != null) record.clashDur = opts.clashDur
      if (opts.aftermathDur != null) record.aftermathDur = opts.aftermathDur
      if (opts.healDur != null) record.healDur = opts.healDur
      if (kind === 'intercept') record.supplyProps = buildSupplyProps(battlefieldDir, id)
    }
    return record
  }

  function buildSlots(tagPrefix, n) {
    const slots = []
    for (let i = 0; i < n; i++) {
      const rng = rngFromString(worldSeed + '|' + tagPrefix + i)
      slots.push({ bearing: rng() * TWO_PI, dist: 0.004 + rng() * 0.01, fallAt: rng() })
    }
    return slots
  }

  function dropRaid(target) {
    if (!warnedNoBattlefield) {
      warnedNoBattlefield = true
      const name = (target && target.name) || (target && target.project) || 'a target'
      console.warn('[planet] warsim.js: raid skipped — no covenant-clear battlefield near ' + name)
    }
    return null
  }

  // Scattered supply props (crates/barrels) around an on-route ambush point —
  // covenant-clearance-tested like every other mark.
  function buildSupplyProps(bf, id) {
    const out = []
    for (let i = 0; i < SUPPLY_PROP_COUNT; i++) {
      const rng = rngFromString(worldSeed + '|' + id + ':supply:' + i)
      const bearing = rng() * TWO_PI
      const dist = 0.004 + rng() * 0.008
      offsetPoint(bf, bearing, dist, _tmp)
      const v = new Vector3()
      if (findClear(_tmp, id + ':supplyC:' + i, MARK_CLEARANCE, 0.004, v)) out.push(v)
    }
    return out
  }

  // ==========================================================================
  // Rung 2 — supply-route graph. Re-derived the SAME way the fleets do
  // (airships.js parentDir clustering + caravans.js/roads.js nearest-neighbour
  // land links), WITHOUT importing them (avoid coupling). Exposed for the render
  // overlay and as interceptable targets.
  // ==========================================================================
  const supplyRoutes = deriveSupplyRoutes()

  function deriveSupplyRoutes() {
    const routes = []
    const seen = new Set()

    // (a) parentDir clusters → hub links (airships.js deriveRoutes idiom).
    const byParent = new Map()
    for (const s of list) {
      const k = parentDir(s.project)
      let arr = byParent.get(k)
      if (!arr) {
        arr = []
        byParent.set(k, arr)
      }
      arr.push(s)
    }
    for (const members of byParent.values()) {
      if (members.length < 2) continue
      const q = members
        .filter((s) => (s.structures || 0) >= MIN_ROUTE_STRUCTURES)
        .sort((a, b) => (b.structures || 0) - (a.structures || 0))
      if (q.length < 2) continue
      const hub = q[0]
      for (let i = 1; i < q.length; i++) addRoute(routes, seen, hub, q[i], 'air')
    }

    // (b) nearest-neighbour land links for close pairs (roads.js proximity).
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (angleBetween(list[i].anchorDir, list[j].anchorDir) > RELATED_DIST) continue
        addRoute(routes, seen, list[i], list[j], 'land')
      }
    }

    // (c) fallback: a sparse world still gets its two nearest as one route.
    if (routes.length === 0 && list.length >= 2) {
      let best = null
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const ang = angleBetween(list[i].anchorDir, list[j].anchorDir)
          if (ang <= SUPPLY_ROUTE_MAX_ANGLE && (!best || ang < best.ang)) {
            best = { a: list[i], b: list[j], ang }
          }
        }
      }
      if (best) addRoute(routes, seen, best.a, best.b, 'land')
    }

    return routes.slice(0, SUPPLY_ROUTE_CAP)
  }

  function addRoute(routes, seen, a, b, kind) {
    if (a === b) return
    if (angleBetween(a.anchorDir, b.anchorDir) > SUPPLY_ROUTE_MAX_ANGLE) return
    const key = a.project < b.project ? a.project + '|' + b.project : b.project + '|' + a.project
    if (seen.has(key)) return
    seen.add(key)
    routes.push({
      a,
      b,
      aProject: a.project,
      bProject: b.project,
      aDir: a.anchorDir.clone().normalize(),
      bDir: b.anchorDir.clone().normalize(),
      kind,
    })
  }

  // ==========================================================================
  // raidStateAt — the pure reducer + dispatcher. Rung-1 'raid' records go down
  // the UNCHANGED combat path (byte-identical output); border/intercept share it
  // (they only retune durations + run one-shot); siege/treaty have their own
  // reducers. Caches `_lastClock` for ingest scheduling.
  // ==========================================================================
  function raidStateAt(raid, warClock, out = {}) {
    _lastClock = warClock
    const kind = raid && raid.kind
    if (kind === 'siege') return siegeStateAt(raid, warClock, out)
    if (kind === 'treaty') return treatyStateAt(raid, warClock, out)
    return combatStateAt(raid, warClock, out)
  }

  // The rung-1 reducer (unchanged for a 'raid': every default equals the shipped
  // constant, oneShot is false so tau wraps over EPOCH exactly as before). A
  // one-shot data raid uses a non-wrapping tau off its scheduledAt so it plays
  // once and then stays healed.
  function combatStateAt(raid, warClock, out) {
    const marchDur = raid.marchDur != null ? raid.marchDur : MARCH_DUR
    const clashDur = raid.clashDur != null ? raid.clashDur : CLASH_DUR
    const aftermathDur = raid.aftermathDur != null ? raid.aftermathDur : AFTERMATH_DUR
    const healDur = raid.healDur != null ? raid.healDur : HEAL_DUR
    const clashEnd = marchDur + clashDur
    const aftermathEnd = clashEnd + aftermathDur

    const oneShot = raid.oneShot === true
    const base = oneShot ? (raid.scheduledAt != null ? raid.scheduledAt : raid.epochOffset) : raid.epochOffset
    const tau = oneShot ? Math.max(0, warClock - base) : (((warClock - base) % EPOCH) + EPOCH) % EPOCH

    let phase
    if (tau < marchDur) phase = 'marching'
    else if (tau < clashEnd) phase = 'clashing'
    else if (tau < aftermathEnd) phase = 'aftermath'
    else phase = 'healed'

    out.phase = phase
    out.marchT = smoothstep(0, marchDur, tau)
    out.musterT = smoothstep(marchDur - MUSTER_LEAD, marchDur, tau)
    out.clashT = clamp((tau - marchDur) / clashDur, 0, 1)
    out.aftermathT = clamp((tau - clashEnd) / aftermathDur, 0, 1)
    out.healFrac = clamp((tau - clashEnd) / healDur, 0, 1)
    out.active = phase !== 'healed'
    out.outcome = raid.outcome

    // Casualties accrue across the clash; the loser side loses more. At clashT=0
    // (before the clash) both sides are whole; the survivors persist through the
    // aftermath at clashT=1.
    const ct = out.clashT
    out.atkAlive = raid.outcome === 'raided' ? lerp(1, 0.7, ct) : lerp(1, 0.35, ct)
    out.defAlive = raid.outcome === 'raided' ? lerp(1, 0.35, ct) : lerp(1, 0.7, ct)
    return out
  }

  // Siege reducer — phases {approach, encircle, hold, lift, healed}. Besiegers
  // occupy the covenant-clear ring (never the footprint); occupancy fills during
  // approach+encircle, holds full, then empties on lift; the scorch RING heals
  // from lift onward. Always lifts (timed) and heals to nothing.
  function siegeStateAt(raid, warClock, out) {
    const base = raid.scheduledAt != null ? raid.scheduledAt : 0
    const tau = Math.max(0, warClock - base)
    const A = SIEGE_APPROACH
    const E = SIEGE_ENCIRCLE
    const H = SIEGE_HOLD
    const L = SIEGE_LIFT
    const encEnd = A + E
    const holdEnd = encEnd + H
    const liftEnd = holdEnd + L

    let phase
    if (tau < A) phase = 'approach'
    else if (tau < encEnd) phase = 'encircle'
    else if (tau < holdEnd) phase = 'hold'
    else if (tau < liftEnd) phase = 'lift'
    else phase = 'healed'

    let ring
    if (phase === 'approach') ring = smoothstep(0, A, tau) * 0.6
    else if (phase === 'encircle') ring = 0.6 + 0.4 * clamp((tau - A) / E, 0, 1)
    else if (phase === 'hold') ring = 1
    else if (phase === 'lift') ring = 1 - clamp((tau - holdEnd) / L, 0, 1)
    else ring = 0

    out.phase = phase
    out.approachT = clamp(tau / A, 0, 1)
    out.encircleT = clamp((tau - A) / E, 0, 1)
    out.holdT = clamp((tau - encEnd) / H, 0, 1)
    out.liftT = clamp((tau - holdEnd) / L, 0, 1)
    out.ringActive = ring
    out.siegeT = clamp(tau / liftEnd, 0, 1)
    out.healFrac = clamp((tau - holdEnd) / HEAL_DUR, 0, 1) // scorch ring heals once the siege lifts
    out.active = phase !== 'healed'
    out.outcome = 'siege'
    // Compat fields so a generic reader never sees undefined.
    out.marchT = out.approachT
    out.musterT = out.encircleT
    out.clashT = out.holdT
    out.aftermathT = out.liftT
    out.atkAlive = 1
    out.defAlive = 1
    return out
  }

  // Treaty reducer — a peace beat: a neutral banner stands at the rivals'
  // midpoint for the cooldown, then fades over the final HEAL_DUR. It reaches
  // 'aftermath' on the first read (so the render narrates the peace line once).
  function treatyStateAt(raid, warClock, out) {
    const base = raid.scheduledAt != null ? raid.scheduledAt : 0
    const tau = Math.max(0, warClock - base)
    const phase = tau < PEACE_SHOW ? 'aftermath' : 'healed'
    out.phase = phase
    out.marchT = 0
    out.musterT = 0
    out.clashT = 0
    out.aftermathT = clamp(tau / PEACE_SHOW, 0, 1)
    out.healFrac = clamp((tau - (PEACE_SHOW - HEAL_DUR)) / HEAL_DUR, 0, 1)
    out.active = phase !== 'healed'
    out.outcome = 'peace'
    out.atkAlive = 1
    out.defAlive = 1
    return out
  }

  // ==========================================================================
  // outcomeLine — a deterministic herald sentence. The rung-1 'raid' branch is
  // UNCHANGED (only names from the snapshot + local vocab ever appear). The
  // border/intercept/siege/treaty branches read the same way.
  // ==========================================================================
  function outcomeLine(raid) {
    if (!raid) return ''
    const wi = Math.floor(hash01(raid.id + ':word') * RAIDER_WORDS.length)
    const raiderword = RAIDER_WORDS[wi]
    const realmword = REALM_WORDS[wi]

    if (raid.kind === 'treaty') {
      const an = nameOf(raid.a || raid.raider)
      const bn = nameOf(raid.b || raid.target)
      return `Banners are lowered between ${an} and ${bn}; a merge joins their roads and the war-drums fall silent`
    }
    if (raid.kind === 'siege') {
      const tn = nameOf(raid.target)
      return `${cap(raiderword)} ring ${tn} in a siege — no gate opens, yet not one stone is thrown down`
    }
    if (raid.kind === 'border') {
      const an = nameOf(raid.raider)
      const tn = nameOf(raid.target)
      if (raid.outcome === 'repelled') {
        return `Border steel rings between ${an} and ${tn}; the ${raiderword} are driven back to the marches`
      }
      return `A border skirmish flares as ${an}'s ${raiderword} raid the fields of ${tn}`
    }
    if (raid.kind === 'intercept') {
      const tn = nameOf(raid.target)
      return `${cap(raiderword)} fall upon a supply train bound for ${tn}; crates lie scattered and smouldering on the road`
    }

    // Rung 1 (unchanged).
    const name = (raid.target && raid.target.name) || 'the settlement'
    if (raid.outcome === 'repelled') {
      return `The banners of ${name} hold — the ${raiderword} raid breaks on the walls`
    }
    const w = raiderword.charAt(0).toUpperCase() + raiderword.slice(1)
    return `${w} torches ring ${name}; its ${realmword} muster in the ash`
  }

  // ==========================================================================
  // Rung 2/3 — event ingestion + drivers. All deterministic given the SET of
  // ingested events (deduped by id) + warClock.
  // ==========================================================================
  function ingest(events) {
    if (!Array.isArray(events)) return
    pruneHealed() // keep the data-raid array bounded before adding more
    for (const e of events) {
      if (!e || typeof e.id !== 'string' || !e.id) continue
      if (typeof e.project !== 'string' || !e.project) continue
      if (seenEventIds.has(e.id)) continue
      seenEventIds.add(e.id)
      if (seenEventIds.size > SEEN_EVENT_CAP) {
        const it = seenEventIds.values()
        for (let i = 0; i < SEEN_EVENT_CAP / 2; i++) seenEventIds.delete(it.next().value)
      }
      handleEvent(e)
    }
  }

  function handleEvent(e) {
    if (e.kind === 'commit' || e.kind === 'pr-merged') bumpActivity(e.project, e.ts)

    if (e.kind === 'conflict') {
      const pair = eventEndpoints(e)
      if (!pair) return
      const { sa, sb } = pair
      lowerStanding(sa, sb) // persistent hostility deepens
      if (treatyActive(sa, sb)) return // peace holds — no skirmish
      const aggressor = pickAggressor(sa, sb)
      const target = aggressor === sa ? sb : sa
      if (shouldSiege(sa, sb) && strengthOf(target) >= SIEGE_RICH_STRENGTH) {
        scheduleSiege(aggressor, target, e.id)
      } else {
        scheduleBorderSkirmish(aggressor, target, e.id)
      }
      maybeInterceptBetween(sa, sb, e.id) // sever a supply line between them if one runs
      return
    }

    if (e.kind === 'pr-merged') {
      const pair = eventEndpoints(e)
      if (!pair) return
      const { sa, sb } = pair
      const wasHostile = standingBetween(sa, sb) < 0
      raiseStanding(sa, sb)
      if (wasHostile || standingBetween(sa, sb) >= TREATY_STANDING) formTreaty(sa, sb, e.id)
    }
  }

  // Resolve an event to its two settlement endpoints: `project` + (`other` if it
  // resolves, else the most-related settlement). Returns null if it can't name a
  // distinct rival.
  function eventEndpoints(e) {
    const sa = byProject.get(e.project)
    if (!sa) return null
    let sb = e.other ? byProject.get(e.other) : null
    if (!sb) sb = mostRelated(sa)
    if (!sb || sb === sa) return null
    return { sa, sb }
  }

  function mostRelated(sa) {
    let best = null
    let bestAng = Infinity
    const pa = parentDir(sa.project)
    for (const s of list) {
      if (s === sa) continue
      const ang = angleBetween(sa.anchorDir, s.anchorDir)
      const related = parentDir(s.project) === pa || ang < RELATED_DIST
      if (!related) continue
      if (ang < bestAng) {
        bestAng = ang
        best = s
      }
    }
    return best
  }

  // Aggressor selection for a symmetric conflict: a raider faction if exactly one
  // side is one, else the lower-attractiveness side (per spec).
  function pickAggressor(sa, sb) {
    if (isRaider(sa) && !isRaider(sb)) return sa
    if (isRaider(sb) && !isRaider(sa)) return sb
    return attractivenessOf(sa) <= attractivenessOf(sb) ? sa : sb
  }

  function shouldSiege(sa, sb) {
    if (standingBetween(sa, sb) > SIEGE_STANDING) return false
    const rich = attractivenessOf(sa) >= attractivenessOf(sb) ? sa : sb
    return strengthOf(rich) >= SIEGE_RICH_STRENGTH
  }

  // --- data-raid schedulers (all capped, deduped, covenant-tested) -----------
  function activeDataRaidCount() {
    let n = 0
    for (const r of raids) {
      if (r.kind === 'raid') continue
      if (raidStateAt(r, _lastClock, _capScratch).active) n++
    }
    return n
  }

  function pruneHealed() {
    for (let i = raids.length - 1; i >= 0; i--) {
      const r = raids[i]
      if (r.kind === 'raid') continue // seeded raids recur forever — never pruned
      if (!raidStateAt(r, _lastClock, _capScratch).active) raids.splice(i, 1)
    }
  }

  function scheduleBorderSkirmish(attacker, target, eventId) {
    if (treatyActive(attacker, target)) return null
    const id = 'border:' + eventId
    if (raids.some((r) => r.id === id)) return null
    if (activeDataRaidCount() >= raidCap + DATA_RAID_CAP) return null
    if (angleBetween(attacker.anchorDir, target.anchorDir) > MAX_RAID_ANGLE + 0.3) return null
    const raid = buildRaid(attacker, target, id, raids.length, {
      kind: 'border',
      scheduledAt: _lastClock,
      epochOffset: _lastClock,
      oneShot: true,
      marchDur: BORDER_MARCH,
      scorchTargetRing: false,
    })
    if (raid) raids.push(raid)
    return raid
  }

  function scheduleSiege(aggressor, target, eventId) {
    if (treatyActive(aggressor, target)) return null
    const id = 'siege:' + eventId
    if (raids.some((r) => r.id === id)) return null
    if (activeDataRaidCount() >= raidCap + DATA_RAID_CAP) return null
    const raid = buildSiege(aggressor, target, id, _lastClock)
    if (raid) raids.push(raid)
    return raid
  }

  // Public: stage a supply-interception on a route (a raid.kind='intercept'
  // whose battlefield is a covenant-clear point along the route arc; scorches
  // the road + drops supply props; cuts both endpoints' supply).
  function scheduleInterceptOnRoute(route, id) {
    if (!route || !route.aDir || !route.bDir) return null
    id = id || 'intercept:' + (route.aProject || 'a') + '>' + (route.bProject || 'b')
    if (raids.some((r) => r.id === id)) return null
    if (activeDataRaidCount() >= raidCap + DATA_RAID_CAP) return null

    // Ambush point along the arc, covenant-clear.
    const rng = rngFromString(worldSeed + '|' + id + ':amb')
    const t = 0.35 + rng() * 0.3
    slerpUnit(route.aDir, route.bDir, t, _tmp)
    const bf = new Vector3()
    if (!findClear(_tmp, id + ':amb', MARK_CLEARANCE, 0.02, bf)) return null

    // Endpoints modelled as source/target so buildRaid's muster/defense geometry
    // works; the battlefield is pinned to the on-route ambush.
    const raider = route.a
    const target = route.b
    const raid = buildRaid(raider, target, id, raids.length, {
      kind: 'intercept',
      scheduledAt: _lastClock,
      epochOffset: _lastClock,
      oneShot: true,
      marchDur: INTERCEPT_MARCH,
      atkCount: INTERCEPT_ATK,
      defCount: INTERCEPT_DEF,
      battlefieldDir: bf,
      scorchTargetRing: false,
      forcedOutcome: 'raided', // an ambush takes the supply
    })
    if (!raid) return null
    raids.push(raid)
    // A severed route starves BOTH ends (supply flows both ways).
    recordSupplyHit(route.aProject)
    recordSupplyHit(route.bProject)
    return raid
  }

  function maybeInterceptBetween(sa, sb, eventId) {
    const route = supplyRoutes.find(
      (r) =>
        (r.aProject === sa.project && r.bProject === sb.project) ||
        (r.aProject === sb.project && r.bProject === sa.project),
    )
    if (route) scheduleInterceptOnRoute(route, 'intercept:' + eventId)
  }

  // Siege builder — besiegers ring the target on a covenant-clear circle strictly
  // OUTSIDE the footprint; a scorch ring scars the GROUND around it. Dropped
  // (warn-once) if too few ring stations clear — the covenant wins over spectacle.
  function buildSiege(raider, target, id, scheduledAt) {
    const targetDir = new Vector3().copy(target.anchorDir).normalize()
    const sourceDir = new Vector3().copy(raider.anchorDir).normalize()

    const ringDirs = []
    for (let i = 0; i < SIEGE_RING_POINTS; i++) {
      const bearing = (i / SIEGE_RING_POINTS) * TWO_PI
      offsetPoint(targetDir, bearing, SIEGE_RING, _tmp)
      const v = new Vector3()
      if (findClear(_tmp, id + ':ring:' + i, MARK_CLEARANCE, 0.006, v)) ringDirs.push(v)
    }
    if (ringDirs.length < SIEGE_MIN_RING) return dropSiege(target)

    const scorchDirs = []
    for (let i = 0; i < SCORCH_COUNT; i++) {
      const rng = rngFromString(worldSeed + '|' + id + ':sscorch:' + i)
      const bearing = (i / SCORCH_COUNT) * TWO_PI + rng() * 0.3
      const dist = SIEGE_SCORCH_RING + (rng() - 0.5) * 0.008
      offsetPoint(targetDir, bearing, dist, _tmp)
      const v = new Vector3()
      if (findClear(_tmp, id + ':sscorchC:' + i, MARK_CLEARANCE, 0.006, v)) scorchDirs.push(v)
    }

    const bannerDirs = []
    const bn = Math.min(BANNERS_PER_RAID, ringDirs.length)
    for (let i = 0; i < bn; i++) {
      const rd = ringDirs[Math.floor((i * ringDirs.length) / bn)]
      const forward = new Vector3()
      tangentToward(rd, targetDir, forward) // besiegers face inward
      bannerDirs.push({ dir: rd.clone(), forward })
    }

    const siegeCount = clamp(Math.round(strengthOf(raider) * 1.2), ATK_MIN, ATK_MAX + 4)
    const siegeSlots = []
    for (let i = 0; i < siegeCount; i++) {
      const rng = rngFromString(worldSeed + '|' + id + ':siege:' + i)
      siegeSlots.push({
        ring: i % ringDirs.length,
        bearing: rng() * TWO_PI,
        dist: 0.003 + rng() * 0.006,
        fallAt: rng(),
      })
    }

    return {
      id,
      kind: 'siege',
      oneShot: true,
      scheduledAt: scheduledAt != null ? scheduledAt : _lastClock,
      raider,
      target,
      sourceDir,
      targetDir,
      // generic dirs so any reader has something sane (siege placement is ring-based)
      musterDir: ringDirs[0].clone(),
      battlefieldDir: ringDirs[0].clone(),
      defenseDir: targetDir.clone(),
      ringDirs,
      siegeCount,
      siegeSlots,
      atkCount: siegeCount,
      defCount: 0,
      attackerSlots: siegeSlots,
      defenderSlots: [],
      outcome: 'siege',
      winnerFaction: 'raider',
      scorchDirs,
      bannerDirs,
      propDirs: [],
    }
  }

  function dropSiege(target) {
    if (!warnedNoSiege) {
      warnedNoSiege = true
      const name = (target && target.name) || (target && target.project) || 'a target'
      console.warn('[planet] warsim.js: siege skipped — no covenant-clear ring around ' + name)
    }
    return null
  }

  // Treaty peace record — a neutral banner at the rivals' clear midpoint. Pushed
  // into `raids` (kind='treaty') so the render's generic banner + narrate path
  // surfaces it. No armies, no scorch.
  function buildTreatyRecord(sa, sb, id) {
    slerpUnit(sa.anchorDir, sb.anchorDir, 0.5, _tmp)
    const dir = new Vector3()
    if (!findClear(_tmp, id + ':peace', MARK_CLEARANCE, 0.02, dir)) return null
    const forward = new Vector3()
    tangentToward(dir, sa.anchorDir, forward)
    return {
      id,
      kind: 'treaty',
      oneShot: true,
      scheduledAt: _lastClock,
      a: sa,
      b: sb,
      raider: sa,
      target: sb,
      sourceDir: sa.anchorDir.clone().normalize(),
      targetDir: dir.clone(),
      musterDir: dir.clone(),
      battlefieldDir: dir.clone(),
      defenseDir: dir.clone(),
      atkCount: 0,
      defCount: 0,
      attackerSlots: [],
      defenderSlots: [],
      outcome: 'peace',
      winnerFaction: 'realm',
      scorchDirs: [],
      bannerDirs: [{ dir: dir.clone(), forward }],
      propDirs: [],
    }
  }

  function formTreaty(sa, sb, eventId) {
    const key = standingKey(sa, sb)
    treatyUntil.set(key, _lastClock + TREATY_COOLDOWN)
    // Prune active hostilities between these two clusters.
    for (let i = raids.length - 1; i >= 0; i--) {
      const r = raids[i]
      if (r.kind !== 'border' && r.kind !== 'siege' && r.kind !== 'intercept') continue
      if (raidLinksClusters(r, sa, sb)) raids.splice(i, 1)
    }
    const tid = 'treaty:' + eventId
    if (!raids.some((r) => r.id === tid)) {
      const rec = buildTreatyRecord(sa, sb, tid)
      if (rec) raids.push(rec)
    }
  }

  function raidLinksClusters(r, sa, sb) {
    const a = r.raider
    const b = r.target
    if (!a || !b) return false
    const set = new Set([clusterOf(sa.project), clusterOf(sb.project)])
    return set.has(clusterOf(a.project)) && set.has(clusterOf(b.project))
  }

  // --- activity / prosperity -------------------------------------------------
  function bumpActivity(project, ts) {
    activityActive = true
    let r = activity.get(project)
    if (!r) {
      r = { count: 0, lastTs: 0 }
      activity.set(project, r)
    }
    r.count++
    if (typeof ts === 'number' && ts > r.lastTs) r.lastTs = ts
  }

  // A settlement's live-activity score in [0,1] — half a count-share, half a
  // recency-share (newest event = most recent). Wall-clock-free: recency is
  // measured against the ingested tally's own ts range, so it stays deterministic
  // for a fixed event set.
  function activityScore01(s) {
    const rec = activity.get(s.project)
    if (!rec) return 0
    let maxCount = 1
    let minTs = Infinity
    let maxTs = -Infinity
    for (const r of activity.values()) {
      if (r.count > maxCount) maxCount = r.count
      if (r.lastTs < minTs) minTs = r.lastTs
      if (r.lastTs > maxTs) maxTs = r.lastTs
    }
    const cW = rec.count / maxCount
    const rW = maxTs > minTs ? (rec.lastTs - minTs) / (maxTs - minTs) : 1
    return clamp(0.5 * cW + 0.5 * rW, 0, 1)
  }

  // prosperityOf — the spec's normalized blend (0..1), for the render/UI overlay
  // and prosperity-weighted targeting readouts: 0.6·norm(structures) +
  // 0.4·norm(activity). (Targeting itself uses attractivenessOf, which multiplies
  // strength by an activity boost so it collapses to rung 1 with no drivers.)
  function prosperityOf(x) {
    const s = asSettlement(x)
    if (!s) return 0
    let minStruct = Infinity
    let maxStruct = -Infinity
    for (const it of list) {
      const v = Math.max(it.structures || 0, 0)
      if (v < minStruct) minStruct = v
      if (v > maxStruct) maxStruct = v
    }
    const struct = Math.max(s.structures || 0, 0)
    const nStruct =
      maxStruct > minStruct ? (struct - minStruct) / (maxStruct - minStruct) : maxStruct > 0 ? struct / maxStruct : 0
    const nAct = activityScore01(s)
    return clamp(0.6 * nStruct + 0.4 * nAct, 0, 1)
  }

  // --- supply economy --------------------------------------------------------
  function recordSupplyHit(project) {
    if (!project) return
    supplyEconomyActive = true
    let arr = supplyHits.get(project)
    if (!arr) {
      arr = []
      supplyHits.set(project, arr)
    }
    arr.push({ at: _lastClock })
    if (arr.length > 32) arr.shift()
  }

  // supplyOf — a settlement's 0..1 supply level at `warClock` (defaults to the
  // last observed clock). Full (1) with no interceptions; each interception
  // removes SUPPLY_HIT, recovering linearly over RESUPPLY_DUR. Pure function of
  // (clock, recorded hits) → replayable.
  function supplyOf(x, warClock) {
    const project = typeof x === 'string' ? x : x && x.project
    if (!project) return 1
    const hits = supplyHits.get(project)
    if (!hits || !hits.length) return 1
    const c = typeof warClock === 'number' ? warClock : _lastClock
    let deficit = 0
    for (const h of hits) {
      const age = c - h.at
      if (age < 0) continue
      const remain = 1 - age / RESUPPLY_DUR
      if (remain > 0) deficit += SUPPLY_HIT * remain
    }
    return clamp(1 - deficit, SUPPLY_MIN, 1)
  }

  // strengthOf's supply multiplier — exactly 1.0 at full supply (rung-1 parity),
  // sinking to SUPPLY_STRENGTH_FLOOR as supply empties.
  function supplyMultiplier(s) {
    return SUPPLY_STRENGTH_FLOOR + (1 - SUPPLY_STRENGTH_FLOOR) * supplyOf(s)
  }

  // --- faction standing / treaties -------------------------------------------
  function clusterOf(project) {
    return parentDir(project)
  }

  function standingKey(sa, sb) {
    const ka = clusterOf(sa.project)
    const kb = clusterOf(sb.project)
    return ka < kb ? ka + '::' + kb : kb + '::' + ka
  }

  function asSettlement(x) {
    if (!x) return null
    if (typeof x === 'string') return byProject.get(x) || null
    return x.project ? x : null
  }

  function lowerStanding(sa, sb) {
    const key = standingKey(sa, sb)
    standings.set(key, clamp((standings.get(key) || 0) - STANDING_CONFLICT, STANDING_MIN, STANDING_MAX))
  }
  function raiseStanding(sa, sb) {
    const key = standingKey(sa, sb)
    standings.set(key, clamp((standings.get(key) || 0) + STANDING_MERGE, STANDING_MIN, STANDING_MAX))
  }

  // standingBetween — persistent hostility/amity in [-1, 1] (0 = neutral).
  function standingBetween(a, b) {
    const sa = asSettlement(a)
    const sb = asSettlement(b)
    if (!sa || !sb) return 0
    return standings.get(standingKey(sa, sb)) || 0
  }

  function treatyActive(sa, sb) {
    const until = treatyUntil.get(standingKey(sa, sb))
    return until != null && _lastClock < until
  }
  // treatyBetween — true while a peace holds between two clusters.
  function treatyBetween(a, b) {
    const sa = asSettlement(a)
    const sb = asSettlement(b)
    if (!sa || !sb) return false
    return treatyActive(sa, sb)
  }

  // territoryAt — the influence field between rival clusters, for the render
  // overlay: nearest-anchor Voronoi over settlement anchors, tinted raider vs
  // realm, its intensity ebbing with the pair's live standing (never a permanent
  // stain — the render drives opacity from this + a uTime pulse). Pure read.
  function territoryAt(dir, out = {}) {
    let nearest = null
    let nearestAng = Infinity
    for (const s of list) {
      const ang = angleBetween(dir, s.anchorDir)
      if (ang < nearestAng) {
        nearestAng = ang
        nearest = s
      }
    }
    if (!nearest) {
      out.faction = 'neutral'
      out.influence = 0
      out.settlement = null
      return out
    }
    out.faction = isRaider(nearest) ? 'raider' : 'realm'
    out.settlement = nearest
    // Influence falls off with distance and rises with how contested the nearest
    // settlement currently is (its most-negative standing with any neighbour).
    let hostility = 0
    for (const s of list) {
      if (s === nearest) continue
      const st = standingBetween(nearest, s)
      if (st < hostility) hostility = st
    }
    const prox = clamp(1 - nearestAng / RELATED_DIST, 0, 1)
    out.influence = clamp(prox * (0.35 + 0.65 * -hostility), 0, 1)
    return out
  }

  const meta = {
    get raidCount() {
      return raids.length
    },
  }

  return {
    // Rung 1 (contract preserved) —
    raids,
    EPOCH,
    isRaider,
    strengthOf,
    attractivenessOf,
    raidStateAt,
    outcomeLine,
    meta,
    // Rung 2 (additive) —
    ingest,
    supplyRoutes,
    deriveSupplyRoutes,
    scheduleInterceptOnRoute,
    prosperityOf,
    territoryAt,
    // Rung 3 (additive) —
    standingBetween,
    treatyBetween,
    supplyOf,
    // Static meta for the renderers / verifykit (harmless extras, like civsim).
    planet,
    seed: worldSeed,
    covenantCount: covenant.length,
  }
}
