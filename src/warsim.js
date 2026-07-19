// warsim.js — the E-SIM conflict SIMULATION/DATA layer (rung 1). PURE data: no
// THREE rendering, no materials, no scene graph. This module reduces
// `(settlement snapshot, worldSeed, warClock)` to a fully deterministic,
// replayable set of raids — who marches on whom, when, the on-land
// battlefield/muster/defense geometry, per-unit formation slots + casualty
// times, the seeded outcome, and every mark (scorch/banner/prop) position.
// warrender.js is a PURE projection of this state, exactly as civrender.js is
// of civsim.js.
//
// Contract (docs/design/epilogue-e-sim.md §R1-1):
//   createWarSim(planet, settlements, seed, opts={})
//     -> { raids, EPOCH,
//          isRaider(projectOrSettlement)->bool,
//          strengthOf(settlement)->number,
//          attractivenessOf(settlement)->number,
//          raidStateAt(raid, warClock, out={})->out,
//          outcomeLine(raid)->string,
//          meta:{ raidCount } }
//   `settlements` is an array of
//     { project, name, race, structures, anchorDir:Vector3, groundR, structureDirs:Vector3[] }
//
// THE COVENANT: session structures are immutable history. This file NEVER
// writes, moves, recolors, scales or hides them. Every battlefield, muster,
// defensive line, scorch, banner and prop position is rejection-sampled against
// a covenant set (every settlement anchorDir PLUS every structureDir), requiring
// >= MARK_CLEARANCE great-circle radians of clearance AND clear land below the
// build ceiling. An expanding-ring search widens the offset until clear; if no
// clear battlefield exists near a target the raid is DROPPED (warn-once) rather
// than ever placed on a record. Because raidStateAt(raid, warClock) is a pure
// function of the clock, every mark heals automatically and totally.
//
// Determinism law: every stateful value derives from string seeds via
// rngFromString / hash01 (util.js). No runtime randomness and no wall-clock
// reads anywhere in this file (it stays grep-clean of both). State is a pure
// function of warClock (an accumulated dt scalar owned by warrender's clock),
// so scrub/reload replays identically.
//
// Vector3 is imported from the three CORE entry (not 'three/webgpu'), exactly
// like civsim.js: it is pure math, three/webgpu re-exports the identical class,
// and the core import keeps this data module light and node-testable without
// pulling in the WebGPU backend. No renderer/material import appears here.
import { Vector3 } from 'three'
import { SEA_LEVEL, clamp, lerp, smoothstep, rngFromString, hash01 } from './util.js'

// ---------------------------------------------------------------------------
// Tunable knobs (deterministic simulation parameters). Sim units are seconds of
// warClock.
// ---------------------------------------------------------------------------
const MAX_RAID_ANGLE = 0.6 // radians — farthest a raider will march to a target
const RAID_CAP = 4 // hard cap on concurrent raids (motion / mark budget)
const MARK_CLEARANCE = 0.03 // radians — min great-circle clearance from ANY covenant point
const MAX_BUILD_HEIGHT = SEA_LEVEL + 0.03 // sampleHeight() must be below this to be walkable ground

const ATK_MIN = 6
const ATK_MAX = 16
const DEF_MIN = 5
const DEF_MAX = 14

const SCORCH_COUNT = 7 // scorch marks in the battlefield ring (and again around a raided target)
const BANNERS_PER_RAID = 3

const EPOCH = 90 // sim-seconds — one full raid cycle (idempotent → total heal)
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

  // Warn-once flags (per sim instance) — these searches run per raid/mark and a
  // plain warn would spam.
  let warnedNoBattlefield = false

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

  // No prosperity field exists on session settlements (confirmed in the design
  // doc) — rung 1 uses the `structures` count as the strength/attractiveness
  // proxy (richest = most structures). Floor of 3 so even a bare scratch dir can
  // still field a war party.
  function strengthOf(s) {
    return Math.max((s && s.structures) || 0, 3)
  }
  function attractivenessOf(s) {
    return strengthOf(s)
  }

  // --- Raid construction -----------------------------------------------------
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

  function buildRaid(raider, target, id, idx) {
    const sourceDir = new Vector3(raider.anchorDir.x, raider.anchorDir.y, raider.anchorDir.z).normalize()
    const targetDir = new Vector3(target.anchorDir.x, target.anchorDir.y, target.anchorDir.z).normalize()

    // Battlefield — the great-circle midpoint (biased toward the target), nudged
    // clear. Its failure is the canonical "no clear battlefield" drop.
    const battlefieldDir = new Vector3()
    slerpUnit(sourceDir, targetDir, 0.55, _tmp)
    if (!findClear(_tmp, id + ':bf', MARK_CLEARANCE, 0.03, battlefieldDir)) return dropRaid(target)

    // Muster — attacker assembly point offset OUTWARD from the target toward the
    // incoming enemy (so the army forms up OUTSIDE the settlement footprint).
    const musterDir = new Vector3()
    offsetPoint(targetDir, bearingToward(targetDir, sourceDir), MUSTER_OFFSET, _tmp)
    if (!findClear(_tmp, id + ':muster', MARK_CLEARANCE, 0.02, musterDir)) return dropRaid(target)

    // Defense — defender line between the target and the battlefield.
    const defenseDir = new Vector3()
    slerpUnit(targetDir, battlefieldDir, 0.5, _tmp)
    if (!findClear(_tmp, id + ':defense', MARK_CLEARANCE, 0.02, defenseDir)) return dropRaid(target)

    const atkCount = clamp(Math.round(strengthOf(raider) * 1.1), ATK_MIN, ATK_MAX)
    const defCount = clamp(Math.round(strengthOf(target)), DEF_MIN, DEF_MAX)

    // Per-unit formation slots + casualty fall-times. Each unit gets its own
    // seeded RNG stream (three sequential draws: bearing, dist, fallAt).
    const attackerSlots = buildSlots(id + ':atk:', atkCount)
    const defenderSlots = buildSlots(id + ':def:', defCount)

    // Outcome — defenders repel unless the raiders clearly out-muscle them.
    const r = hash01(id + ':outcome')
    const outcome = strengthOf(target) * (0.6 + 0.8 * r) >= strengthOf(raider) ? 'repelled' : 'raided'
    const winnerFaction = outcome === 'raided' ? 'raider' : 'realm'

    // Scorch — a ring on the battlefield ground, plus (only if the settlement
    // fell) a ring AROUND the target on the GROUND, never on the buildings.
    const scorchDirs = []
    for (let i = 0; i < SCORCH_COUNT; i++) {
      const rng = rngFromString(worldSeed + '|' + id + ':scorch:' + i)
      const bearing = (i / SCORCH_COUNT) * TWO_PI + rng() * 0.5
      const dist = 0.008 + rng() * 0.012
      offsetPoint(battlefieldDir, bearing, dist, _tmp)
      const v = new Vector3()
      if (findClear(_tmp, id + ':scorchC:' + i, MARK_CLEARANCE, 0.006, v)) scorchDirs.push(v)
    }
    if (outcome === 'raided') {
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

    return {
      id,
      kind: 'raid',
      idx,
      raider,
      target,
      epochOffset: idx * (EPOCH / raidCap),
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

  // --------------------------------------------------------------------------
  // raidStateAt — the pure reducer. Writes into `out` (allocation-free when the
  // caller supplies a scratch, as warrender does per throttled tick). Every
  // field is a plain number/string/boolean so scrub/reload replays identically.
  // --------------------------------------------------------------------------
  const CLASH_END = MARCH_DUR + CLASH_DUR
  const AFTERMATH_END = CLASH_END + AFTERMATH_DUR

  function raidStateAt(raid, warClock, out = {}) {
    const tau = (((warClock - raid.epochOffset) % EPOCH) + EPOCH) % EPOCH

    let phase
    if (tau < MARCH_DUR) phase = 'marching'
    else if (tau < CLASH_END) phase = 'clashing'
    else if (tau < AFTERMATH_END) phase = 'aftermath'
    else phase = 'healed'

    out.phase = phase
    out.marchT = smoothstep(0, MARCH_DUR, tau)
    out.musterT = smoothstep(MARCH_DUR - MUSTER_LEAD, MARCH_DUR, tau)
    out.clashT = clamp((tau - MARCH_DUR) / CLASH_DUR, 0, 1)
    out.aftermathT = clamp((tau - CLASH_END) / AFTERMATH_DUR, 0, 1)
    out.healFrac = clamp((tau - CLASH_END) / HEAL_DUR, 0, 1)
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

  // --------------------------------------------------------------------------
  // outcomeLine — a deterministic herald sentence. Only names from the snapshot
  // and the local vocab ever appear; nothing is invented.
  // --------------------------------------------------------------------------
  function outcomeLine(raid) {
    const wi = Math.floor(hash01(raid.id + ':word') * RAIDER_WORDS.length)
    const raiderword = RAIDER_WORDS[wi]
    const realmword = REALM_WORDS[wi]
    const name = (raid.target && raid.target.name) || 'the settlement'
    if (raid.outcome === 'repelled') {
      return `The banners of ${name} hold — the ${raiderword} raid breaks on the walls`
    }
    const w = raiderword.charAt(0).toUpperCase() + raiderword.slice(1)
    return `${w} torches ring ${name}; its ${realmword} muster in the ash`
  }

  return {
    raids,
    EPOCH,
    isRaider,
    strengthOf,
    attractivenessOf,
    raidStateAt,
    outcomeLine,
    meta: { raidCount: raids.length },
    // Static meta for the renderers / verifykit (harmless extras, like civsim).
    planet,
    seed: worldSeed,
    covenantCount: covenant.length,
  }
}
