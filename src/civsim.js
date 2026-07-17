// civsim.js — the NPC-civilization SIMULATION/DATA layer. PURE data: no THREE
// rendering, no materials, no scene graph. This module reduces
// `(worldSeed, simTime)` to a fully deterministic, replayable NPC-civ ecology
// that coexists with — and never collides with — the covenant-protected
// session settlements owned by world.js.
//
// Contract (docs/design/worldsim-npc-civilizations.md §3):
//   createCivSim(planet, worldSeed, sessionAnchors)
//     -> { civs, routes, civStateAt(civ, simTime, out), getState(simTime),
//          routeActiveAt(route, simTime), ...meta }
//
// Everything visual is a *projection* of this state: civrender.js reads
// `civStateAt` on a throttled tick to place InstancedMesh transforms;
// traderoutes.js reads `routes` + `routeActiveAt` to run caravans/ships. Both
// are built in parallel against this same file — so the field names below are
// a fixed API, not internal details.
//
// Determinism law: every stateful value derives from string seeds via
// rngFromString / hash01 / makeNoise3D (util.js). No Math.random, no Date.now.
// State is a pure function of simTime (an accumulated sim-year scalar owned by
// the caller's sim clock), so rewind/fast-forward is exact and free.
//
// Vector3 is imported from the three CORE entry (not 'three/webgpu'): it is
// pure math, three/webgpu re-exports the identical class, and keeping the core
// import makes this data module light and node-testable without pulling the
// WebGPU backend. No renderer/material import appears here.
import { Vector3 } from 'three'
import { SEA_LEVEL, clamp, lerp, smoothstep, rngFromString } from './util.js'

// ---------------------------------------------------------------------------
// Tunable knobs (deterministic simulation parameters)
// ---------------------------------------------------------------------------
const MAX_BUILD_HEIGHT = SEA_LEVEL + 0.03 // sampleHeight() must be below this to settle (mirrors placement.js)
const TARGET_CIV_COUNT = 14 // how many NPC civs to accept (count does NOT multiply draw calls — instanced)
const CANDIDATE_COUNT = 720 // Fibonacci-lattice base points swept for blue-noise placement
const SITE_JITTER = 0.045 // radians of seeded jitter applied to each lattice point
const MIN_CIV_SEPARATION = 0.14 // radians of great-circle clearance between two NPC civs
const SESSION_CLEARANCE = 0.115 // radians of clearance from ANY session-settlement anchor (covenant)
const AFFINITY_MIN = 0.28 // reject a site whose best archetype affinity is below this
const COAST_PROBE_RADIUS = 0.03 // radians — ring radius used to detect coastal adjacency
const COAST_PROBE_COUNT = 8 // samples around the ring

const MAX_ROUTE_DIST = 0.5 // radians — farthest great-circle span a trade route may bridge
const ROUTE_ARC_SAMPLES = 6 // midpoint samples used to validate a route stays over land/sea
const MAX_ROUTE_DEGREE = 3 // cap trade connections per civ (keeps the graph from becoming a hairball)
const ROUTE_CAP = 20 // hard cap on total routes (draw-call / motion budget)

// Growth-curve population band (pre archetype popScale).
const POP_MIN = 40
const POP_MAX = 5200

// ---------------------------------------------------------------------------
// Archetype registry — static, seeded-attribute templates. Each civ is one
// archetype instance. `key` is the stable identity civrender maps to its own
// kits/palettes; `palette` follows the RACE_PALETTES shape from buildings.js so
// the renderer can reuse it directly. `affinity(biome, coastal)` scores how
// well a candidate site suits this archetype (0..1). `coastalReq` archetypes
// score 0 away from a coast.
// ---------------------------------------------------------------------------
export const ARCHETYPES = {
  'desert-nomad': {
    key: 'desert-nomad',
    name: 'Desert Nomads',
    glyph: '☀',
    unit: 'caravan',
    coastalReq: false,
    palette: { cloth: 0xcaa46a, roof: 0xd8b878, banner: 0xb8863c, skin: 0xd9a066, accent: 0xdca24a },
    wealth: 0.5,
    growRate: 1.15, // multiplies the base growth duration (>1 = slower to mature)
    fallProb: 0.35,
    wonderProb: 0.25,
    popScale: 0.55,
    affinity(b) {
      const dry = 1 - b.moisture
      const flat = 1 - b.slope
      const warm = 1 - b.polar
      return clamp(0.55 * dry + 0.25 * flat + 0.2 * warm - 0.15 * b.landT, 0, 1)
    },
  },
  'seafaring-port': {
    key: 'seafaring-port',
    name: 'Seafaring Ports',
    glyph: '⚓',
    unit: 'ship',
    coastalReq: true,
    palette: { cloth: 0x2f6f8c, roof: 0x3a7f9c, banner: 0x1f5f78, skin: 0xd0a878, accent: 0x38b0c0 },
    wealth: 0.85,
    growRate: 0.9,
    fallProb: 0.2,
    wonderProb: 0.3,
    popScale: 0.85,
    affinity(b, coastal) {
      if (!coastal) return 0
      const flat = 1 - b.slope
      const low = 1 - b.landT
      const temperate = 1 - b.polar
      return clamp(0.4 + 0.3 * flat + 0.2 * low + 0.1 * temperate, 0, 1) * (1 - 0.6 * b.polar)
    },
  },
  'mountain-hold': {
    key: 'mountain-hold',
    name: 'Mountain Holds',
    glyph: '⚒',
    unit: 'caravan',
    coastalReq: false,
    palette: { cloth: 0x8c3f2e, roof: 0x9c4a30, banner: 0x7a2f22, skin: 0xc97b5a, accent: 0xc9622f },
    wealth: 0.75,
    growRate: 1.25,
    fallProb: 0.15,
    wonderProb: 0.35,
    popScale: 0.6,
    affinity(b) {
      const steep = b.slope
      const high = b.landT
      const dryish = 1 - 0.5 * b.moisture
      return clamp(0.55 * steep + 0.35 * high + 0.1 * dryish, 0, 1)
    },
  },
  'forest-commune': {
    key: 'forest-commune',
    name: 'Forest Communes',
    glyph: '✦',
    unit: 'caravan',
    coastalReq: false,
    palette: { cloth: 0x3f7a4a, roof: 0x4f8f5a, banner: 0x2f5f3a, skin: 0xe8caa4, accent: 0x5aa868 },
    wealth: 0.55,
    growRate: 1.0,
    fallProb: 0.25,
    wonderProb: 0.3,
    popScale: 0.65,
    affinity(b) {
      const wet = b.moisture
      const gentle = 1 - b.slope
      const temperate = 1 - b.polar
      const mid = 1 - Math.abs(b.landT - 0.4) * 1.4
      return clamp(0.5 * wet + 0.2 * gentle + 0.15 * temperate + 0.15 * clamp(mid, 0, 1), 0, 1)
    },
  },
  'steampunk-metropolis': {
    key: 'steampunk-metropolis',
    name: 'Steam Metropoli',
    glyph: '⚙',
    unit: 'caravan',
    coastalReq: false,
    palette: { cloth: 0x5a5f66, roof: 0x74624f, banner: 0x3f4348, skin: 0xc9a58a, accent: 0xd08a2f },
    wealth: 0.95,
    growRate: 0.85,
    fallProb: 0.3,
    wonderProb: 0.5,
    popScale: 1.0,
    affinity(b, coastal) {
      const flat = 1 - b.slope
      const low = 1 - b.landT
      const temperateMoist = 1 - Math.abs(b.moisture - 0.5) * 2
      const coastBonus = coastal ? 0.1 : 0
      return clamp(
        (0.4 * flat + 0.3 * clamp(temperateMoist, 0, 1) + 0.3 * low + coastBonus) * (1 - 0.85 * b.polar),
        0,
        1,
      )
    },
  },
}

export const ARCHETYPE_KEYS = Object.keys(ARCHETYPES)

// ---------------------------------------------------------------------------
// Spherical math (pure). sphericalOffset is duplicated verbatim from
// placement.js per the design doc's option (b) — placement.js keeps it private,
// and this data module must not depend on the render-side split. tangentBasis
// and the offset are identical math to placement.js so results match exactly.
// ---------------------------------------------------------------------------
const _tb1 = new Vector3()
const _tb2 = new Vector3()

function tangentBasis(dir, outT1, outT2) {
  if (Math.abs(dir.y) < 0.999) outT1.set(0, 1, 0).cross(dir).normalize()
  else outT1.set(1, 0, 0).cross(dir).normalize()
  outT2.crossVectors(dir, outT1).normalize()
}

/** Writes into `out` the unit point `dist` radians from `base` along `bearing`. */
function sphericalOffset(out, base, bearing, dist) {
  tangentBasis(base, _tb1, _tb2)
  const cb = Math.cos(bearing)
  const sb = Math.sin(bearing)
  const tx = _tb1.x * cb + _tb2.x * sb
  const ty = _tb1.y * cb + _tb2.y * sb
  const tz = _tb1.z * cb + _tb2.z * sb
  const cd = Math.cos(dist)
  const sd = Math.sin(dist)
  out.set(base.x * cd + tx * sd, base.y * cd + ty * sd, base.z * cd + tz * sd).normalize()
}

/** Great-circle angle (radians) between two unit vectors, via dot — allocation-free. */
function angleBetween(a, b) {
  return Math.acos(clamp(a.x * b.x + a.y * b.y + a.z * b.z, -1, 1))
}

// Module-scope scratch — reused across placement/route building and every
// getState() tick so the hot paths never allocate.
const _probe = new Vector3()
const _arc = new Vector3()
const _stateScratch = {}

// ---------------------------------------------------------------------------
// Coastal detection: a site is coastal if any point on a small ring around it
// is ocean. Deterministic (fixed ring, planet queries are pure).
// ---------------------------------------------------------------------------
function isCoastal(planet, dir) {
  for (let i = 0; i < COAST_PROBE_COUNT; i++) {
    const bearing = (i / COAST_PROBE_COUNT) * Math.PI * 2
    sphericalOffset(_probe, dir, bearing, COAST_PROBE_RADIUS)
    if (!planet.isLand(_probe)) return true
  }
  return false
}

/** Fraction of great-circle midpoints between a,b that are land (0..1). */
function arcLandFraction(planet, a, b) {
  let land = 0
  for (let i = 1; i <= ROUTE_ARC_SAMPLES; i++) {
    const t = i / (ROUTE_ARC_SAMPLES + 1)
    _arc.set(lerp(a.x, b.x, t), lerp(a.y, b.y, t), lerp(a.z, b.z, t)).normalize()
    if (planet.isLand(_arc)) land++
  }
  return land / ROUTE_ARC_SAMPLES
}

// ---------------------------------------------------------------------------
// Session-anchor snapshot normalization. Accepts either raw unit vectors or
// records carrying an `anchorDir`. The covenant depends on this list: NPC civs
// are rejection-sampled to stay SESSION_CLEARANCE radians clear of every one.
// ---------------------------------------------------------------------------
function normalizeSessionAnchors(sessionAnchors) {
  const out = []
  if (!sessionAnchors) return out
  for (const item of sessionAnchors) {
    if (!item) continue
    const v = item.anchorDir || item
    if (typeof v.x !== 'number' || typeof v.y !== 'number' || typeof v.z !== 'number') continue
    out.push(new Vector3(v.x, v.y, v.z).normalize())
  }
  return out
}

// ---------------------------------------------------------------------------
// Seeded weighted pick over {value, weight} entries. Deterministic given rng.
// ---------------------------------------------------------------------------
function weightedPick(entries, rng) {
  let total = 0
  for (const e of entries) total += e.weight
  if (total <= 0) return entries[0].value
  let r = rng() * total
  for (const e of entries) {
    r -= e.weight
    if (r <= 0) return e.value
  }
  return entries[entries.length - 1].value
}

// ---------------------------------------------------------------------------
// createCivSim — the public factory.
// ---------------------------------------------------------------------------
export function createCivSim(planet, worldSeed, sessionAnchors, opts = {}) {
  const seed = String(worldSeed)
  const targetCount = opts.targetCount ?? TARGET_CIV_COUNT
  const anchors = normalizeSessionAnchors(sessionAnchors)

  // --- Placement: blue-noise Fibonacci sweep + covenant/separation rejection -
  const civs = placeCivs(planet, seed, anchors, targetCount)

  // --- Timeline seeding: found/prime/fall/resettle/wonder per civ ------------
  for (const civ of civs) seedTimeline(civ)

  // --- Trade-route graph derivation + hub-degree for prosperity --------------
  const routes = deriveRoutes(planet, civs)

  // --------------------------------------------------------------------------
  // civStateAt — the pure reducer. Writes into `out` (allocation-free when the
  // caller supplies a scratch object, as civrender does per throttled tick).
  // --------------------------------------------------------------------------
  function civStateAt(civ, simTime, out = {}) {
    const t = simTime

    // Unfounded — nothing yet.
    if (t < civ.foundedAt) {
      out.phase = 'unfounded'
      out.population = 0
      out.prosperity = 0
      out.ruinFrac = 0
      out.structureCount = 0
      out.hasWonder = false
      return out
    }

    // Ruins window: [fallAt, resettleAt) (resettleAt may be null = permanent).
    const inRuins = civ.fallAt != null && t >= civ.fallAt && (civ.resettleAt == null || t < civ.resettleAt)
    if (inRuins) {
      const weather = smoothstep(civ.fallAt, civ.fallAt + civ.weatherDur, t)
      out.phase = 'ruins'
      out.population = Math.round(lerp(civ.peakPop * 0.04, 0, weather))
      out.prosperity = 0
      out.ruinFrac = weather
      out.structureCount = Math.max(1, Math.round(civ.peakStructures * 0.55))
      out.hasWonder = false
      return out
    }

    // Active — either the original founding or a post-dark-age resettlement.
    const reoccupied = civ.resettleAt != null && t >= civ.resettleAt
    const activeStart = reoccupied ? civ.resettleAt : civ.foundedAt
    const age = t - activeStart
    const growth = smoothstep(0, civ.growDur, age)

    let phase
    if (reoccupied && growth < 0.3) phase = 'resettled'
    else if (growth < 0.18) phase = 'hamlet'
    else if (growth < 0.55) phase = 'town'
    else phase = 'city'

    const population = Math.round(lerp(POP_MIN, POP_MAX, growth) * civ.archetype.popScale)

    const hubBonus = clamp(civ.routeDegree * 0.11, 0, 0.4)
    const prosperity = clamp(growth * (0.55 + 0.35 * civ.archetype.wealth) + hubBonus, 0, 1)

    // Residual weathering right after a resettlement, decaying as it regrows.
    const ruinFrac = reoccupied ? clamp((1 - smoothstep(0, 0.45, growth)) * 0.5, 0, 1) : 0

    // Structure count grows with phase, nudged by prosperity. Drives instance
    // count on the render side — kept small and integer.
    const baseCount = phase === 'city' ? 12 : phase === 'town' ? 6 : phase === 'resettled' ? 2 : 3
    const structureCount = Math.max(1, Math.round(baseCount * (0.75 + 0.5 * prosperity)))

    out.phase = phase
    out.population = population
    out.prosperity = prosperity
    out.ruinFrac = ruinFrac
    out.structureCount = structureCount
    out.hasWonder = civ.wonderAt != null && t >= civ.wonderAt
    return out
  }

  /** True when both endpoint civs are in an active (trading) phase at simTime. */
  function routeActiveAt(route, simTime) {
    const sa = civStateAt(route.aCiv, simTime, _stateScratch)
    if (sa.phase === 'unfounded' || sa.phase === 'ruins') return false
    const sb = civStateAt(route.bCiv, simTime, _stateScratch)
    return !(sb.phase === 'unfounded' || sb.phase === 'ruins')
  }

  // --------------------------------------------------------------------------
  // getState — convenience projection for the renderers. Fills preallocated
  // pools (no per-call allocation) and returns them. NOTE: the returned arrays
  // and their entry objects are REUSED on every call — consume before calling
  // again (civrender/traderoutes read them immediately on a throttled tick).
  // --------------------------------------------------------------------------
  const _statePool = civs.map((civ) => ({ civ, state: {} }))
  const _routePool = routes.map((route) => ({ route, active: false }))
  const _stateView = { simTime: 0, civs: _statePool, routes: _routePool }

  function getState(simTime) {
    _stateView.simTime = simTime
    for (let i = 0; i < civs.length; i++) {
      _statePool[i].civ = civs[i]
      civStateAt(civs[i], simTime, _statePool[i].state)
    }
    for (let i = 0; i < routes.length; i++) {
      _routePool[i].route = routes[i]
      _routePool[i].active = routeActiveAt(routes[i], simTime)
    }
    return _stateView
  }

  return {
    civs,
    routes,
    civStateAt,
    routeActiveAt,
    getState,
    // Static meta for the renderers / verifykit.
    archetypes: ARCHETYPES,
    planet,
    seed,
    sessionAnchorCount: anchors.length,
  }
}

// ---------------------------------------------------------------------------
// Placement — deterministic blue-noise Fibonacci sweep with covenant rejection.
// ---------------------------------------------------------------------------
function placeCivs(planet, seed, anchors, targetCount) {
  const golden = Math.PI * (3 - Math.sqrt(5))
  const base = new Vector3()
  const cand = new Vector3()
  const accepted = [] // { dir, groundR, biome, coastal }
  const civs = []

  for (let i = 0; i < CANDIDATE_COUNT && civs.length < targetCount; i++) {
    // Fibonacci-lattice base point (well-distributed over the sphere).
    const y = 1 - ((i + 0.5) / CANDIDATE_COUNT) * 2
    const r = Math.sqrt(Math.max(0, 1 - y * y))
    const theta = golden * i
    base.set(Math.cos(theta) * r, y, Math.sin(theta) * r).normalize()

    // Seeded per-site jitter — distinct RNG stream per candidate index.
    const rng = rngFromString(seed + '~npc-site:' + i)
    sphericalOffset(cand, base, rng() * Math.PI * 2, rng() * SITE_JITTER)

    // (a) must be land, below the build ceiling.
    if (!planet.isLand(cand)) continue
    const groundR = planet.sampleHeight(cand)
    if (groundR >= MAX_BUILD_HEIGHT) continue

    // (b) covenant: clear of EVERY session-settlement anchor.
    let clash = false
    for (let s = 0; s < anchors.length; s++) {
      if (angleBetween(cand, anchors[s]) < SESSION_CLEARANCE) {
        clash = true
        break
      }
    }
    if (clash) continue

    // (c) clear of every already-accepted NPC civ (blue-noise spacing).
    for (let a = 0; a < accepted.length; a++) {
      if (angleBetween(cand, accepted[a].dir) < MIN_CIV_SEPARATION) {
        clash = true
        break
      }
    }
    if (clash) continue

    // (d) biome-affinity: pick an archetype for this site; reject weak sites.
    const biome = planet.biomeAt(cand, {})
    const coastal = isCoastal(planet, cand)
    const scored = []
    let best = 0
    for (const key of ARCHETYPE_KEYS) {
      const a = ARCHETYPES[key]
      const score = a.affinity(biome, coastal)
      if (score > best) best = score
      if (score > 0) scored.push({ value: key, weight: score * score * score })
    }
    if (best < AFFINITY_MIN || scored.length === 0) continue

    // Seeded weighted archetype choice (favours best-fit, allows variety).
    const archKey = weightedPick(scored, rngFromString(seed + '~npc-arch:' + i))
    const archetype = ARCHETYPES[archKey]

    const dir = cand.clone()
    const index = civs.length
    accepted.push({ dir, groundR, biome, coastal })
    civs.push({
      id: 'npc:' + archKey + ':' + index,
      index,
      archetypeKey: archKey,
      archetype,
      anchorDir: dir,
      groundR,
      coastal,
      // regional cluster key for route grouping (coarse sphere cell).
      routeAffinityKey: cellKey(dir),
      // Timeline fields (filled by seedTimeline).
      foundedAt: 0,
      prime: 0,
      fallAt: null,
      resettleAt: null,
      wonderAt: null,
      growDur: 0,
      weatherDur: 0,
      peakPop: 0,
      peakStructures: 0,
      // Route degree (filled by deriveRoutes).
      routeDegree: 0,
    })
  }

  return civs
}

/** Coarse sphere-cell id for regional clustering — deterministic bucketing. */
function cellKey(dir) {
  const cx = Math.round(dir.x * 3)
  const cy = Math.round(dir.y * 3)
  const cz = Math.round(dir.z * 3)
  return cx + ',' + cy + ',' + cz
}

// ---------------------------------------------------------------------------
// Timeline seeding — per-civ lifecycle milestones, all from a dedicated RNG
// stream so scrubbing simTime replays history identically.
// ---------------------------------------------------------------------------
function seedTimeline(civ) {
  const rng = rngFromString(civ.id + '~timeline')
  const a = civ.archetype

  civ.foundedAt = 4 + rng() * 90 // sim-year first founded
  civ.growDur = (34 + rng() * 66) * a.growRate // years to reach maturity
  civ.prime = civ.foundedAt + civ.growDur

  // Decline: some civs fall to ruins during a dark age, a fraction resettle.
  if (rng() < a.fallProb) {
    civ.fallAt = civ.prime + (18 + rng() * 90)
    civ.weatherDur = 30 + rng() * 45
    // ~65% of fallen civs are later resettled.
    if (rng() < 0.65) {
      civ.resettleAt = civ.fallAt + (28 + rng() * 80)
    }
  }

  // Optional wonder appears sometime after prime.
  if (rng() < a.wonderProb) {
    civ.wonderAt = civ.prime + rng() * 45
  }

  // Peak scalars cached for the reducer (ruins pop/structure baselines).
  civ.peakPop = Math.round(POP_MAX * a.popScale)
  civ.peakStructures = a.key === 'steampunk-metropolis' ? 16 : 13
}

// ---------------------------------------------------------------------------
// Route graph — deterministic trade network over the civ set. Land caravans
// travel civ-to-civ over land; sea ships link coastal ports over water. Routes
// are validated to stay on the correct medium (arc-sampling), capped per-civ
// and in total, and feed each civ's hub-degree (prosperity boost).
// ---------------------------------------------------------------------------
function deriveRoutes(planet, civs) {
  const candidates = []
  for (let i = 0; i < civs.length; i++) {
    for (let j = i + 1; j < civs.length; j++) {
      const ci = civs[i]
      const cj = civs[j]
      const angle = angleBetween(ci.anchorDir, cj.anchorDir)
      if (angle > MAX_ROUTE_DIST) continue

      const bothCoastal = ci.coastal && cj.coastal
      let kind
      if (bothCoastal) {
        // Prefer a sea-lane between ports only if the span is mostly water.
        const landFrac = arcLandFraction(planet, ci.anchorDir, cj.anchorDir)
        kind = landFrac < 0.5 ? 'sea' : landFrac < 0.85 ? null : 'land'
      } else {
        // Land caravan — require the arc to stay mostly over land.
        const landFrac = arcLandFraction(planet, ci.anchorDir, cj.anchorDir)
        kind = landFrac >= 0.6 ? 'land' : null
      }
      if (!kind) continue

      const weight =
        (ci.archetype.wealth + cj.archetype.wealth) *
        (1 - angle / MAX_ROUTE_DIST) *
        (ci.routeAffinityKey === cj.routeAffinityKey ? 1.25 : 1)
      candidates.push({ i, j, ci, cj, kind, angle, weight })
    }
  }

  // Greedy: strongest routes first, respecting per-civ degree + total caps.
  candidates.sort((x, y) => y.weight - x.weight || x.i - y.i || x.j - y.j)
  const degree = new Array(civs.length).fill(0)
  const routes = []
  for (const c of candidates) {
    if (routes.length >= ROUTE_CAP) break
    if (degree[c.i] >= MAX_ROUTE_DEGREE || degree[c.j] >= MAX_ROUTE_DEGREE) continue
    degree[c.i]++
    degree[c.j]++
    routes.push({
      id: 'route:' + c.i + '-' + c.j,
      a: c.i,
      b: c.j,
      aCiv: c.ci,
      bCiv: c.cj,
      kind: c.kind, // 'land' | 'sea'
      angle: c.angle,
      weight: c.weight,
      aDir: c.ci.anchorDir,
      bDir: c.cj.anchorDir,
      aGroundR: c.ci.groundR,
      bGroundR: c.cj.groundR,
    })
  }

  for (let k = 0; k < civs.length; k++) civs[k].routeDegree = degree[k]
  return routes
}
