// Roads & bridges: the static ground-network layer that makes the project
// graph legible as geography (owner "roads/bridges" idea). Between RELATED
// settlement pairs — pairs that share a project path prefix (same parent
// directory, mirroring airships.js's parentDir clustering) OR sit within a
// short angular distance of each other (mirroring caravans.js's
// nearest-neighbour land links) — we draw a thin dirt ribbon that hugs the
// terrain surface, following the great circle between the two anchors and
// re-sampling sampleHeight() at every step so it drapes over hills. Where a
// road would cross water, that span is lifted into a slightly-raised stone
// BRIDGE deck over the gap instead of dipping under the sea.
//
// Engine: THREE.WebGPURenderer(forceWebGL) host — the one surface material is
// a NodeMaterial from 'three/webgpu' (MeshStandardMaterial resolves to the
// node material there, exactly as sealife.js / caravans.js / airships.js
// already rely on). No legacy shader-string customization anywhere.
//
// Draw-call budget: the whole network — every road and every bridge deck —
// is baked into ONE non-indexed BufferGeometry with per-vertex colors (dirt
// vs stone) and drawn by a SINGLE Mesh => 1 draw call. Geometry is static:
// built once after settlements populate, and update() is a no-op afterward.
//
// Determinism (LAWS): every road, every color jitter derives from a
// rngFromString/hash01(seed) stream; NO Math.random / Date.now anywhere.
// Relaunching the same planet rebuilds the identical network.
//
// THE COVENANT: `world` is read-only here. Settlement anchors aren't on
// world.list()'s rows, so (like airships.js / caravans.js) they're read via a
// one-time world.group traversal for objects carrying `userData.settlement`.
// Because world.js populates settlements asynchronously (its /api/sessions
// poll), the network is built lazily on the first update() ticks — see the
// waiting/settling/ready state machine at the bottom.
//
// Contract (pinned for the architect):
//   export function createRoads(planet, world, seed) -> { group, update(dt) }
import * as THREE from 'three/webgpu'
import { SEA_LEVEL, hash01, clamp } from './util.js'
import { tangentBasis } from './placement.js'

// ---------------------------------------------------------------------------
// Palette — muted dirt track + stone bridge deck (ART.md: never emissive /
// bloom-crossing; roads should read as worn ground, not decoration).
// ---------------------------------------------------------------------------
const ROAD_DIRT = 0x7c6a4d // packed-earth track
const BRIDGE_STONE = 0x8a8274 // pale stone deck (COLOR_STONE, shared with airships masts)
const COLOR_JITTER = 0.06 // ± per-vertex value jitter so the ribbon isn't a flat slab

// ---------------------------------------------------------------------------
// Relatedness / route derivation tunables.
// ---------------------------------------------------------------------------
const ROAD_CAP = 8 // max roads drawn (keeps the merged geometry tiny)
const ROAD_MAX_ANGLE = 0.5 // rad — hard cap on road length (never span an ocean; that's not a "road")
const DIST_THRESHOLD = 0.26 // rad — proximity relatedness (two close settlements get a road even across dirs)
const MAX_WATER_FRAC = 0.55 // reject an edge whose path is mostly water (a bridge spans a gap, not the sea)

// ---------------------------------------------------------------------------
// Ribbon geometry tunables.
// ---------------------------------------------------------------------------
const ROAD_STEP = 0.012 // rad between path samples (finer = smoother terrain hug)
const ROAD_MAX_SAMPLES = 64 // cap samples per road
const HALF_WIDTH = 0.0016 // world units — half the ribbon width (~0.0032 wide)
const ROAD_LIFT = 0.0006 // world units above sampleHeight (avoid z-fight with terrain)
const BRIDGE_LIFT = 0.0032 // world units above SEA_LEVEL for the raised bridge deck

// ---------------------------------------------------------------------------
// Build-time scratch. (Allocation is fine at build time — LAWS only bans
// per-frame allocation in update(), and update() here is a no-op.)
// ---------------------------------------------------------------------------
const _tb1 = new THREE.Vector3()
const _tb2 = new THREE.Vector3()

let warnedNoRoads = false

// ---------------------------------------------------------------------------
// Pure spherical helpers (duplicated locally per this codebase's convention —
// airships.js / caravans.js keep their own private copies rather than
// exporting theirs).
// ---------------------------------------------------------------------------

/** Normalized-lerp point between unit vectors `a`/`b`, written into `out`. */
function nlerpPoint(out, a, b, t) {
  out.copy(a).lerp(b, t)
  if (out.lengthSq() < 1e-10) out.copy(a)
  return out.normalize()
}

/** Tangent-plane-projected heading from `dir` toward `target`, into `out`. Leaves `out` zero-length if degenerate. */
function tangentToward(dir, target, out) {
  out.subVectors(target, dir)
  out.addScaledVector(dir, -out.dot(dir))
  if (out.lengthSq() > 1e-12) out.normalize()
  else out.set(0, 0, 0)
  return out
}

/** Parent directory of a filesystem path string (no node:path — this runs in the browser). Mirrors airships.js. */
function parentDir(p) {
  const s = String(p || '').replace(/\/+$/, '')
  const idx = s.lastIndexOf('/')
  return idx > 0 ? s.slice(0, idx) : s
}

// ---------------------------------------------------------------------------
// createRoads
// ---------------------------------------------------------------------------
export function createRoads(planet, world, seed) {
  const group = new THREE.Group()

  // One shared node material for the whole network (dirt + stone distinguished
  // purely by baked per-vertex color). Flat-shaded matte to match the app's
  // low-poly ground aesthetic; DoubleSide so the ribbon reads from any angle.
  const surfaceMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    flatShading: true,
    roughness: 0.95,
    metalness: 0.0,
    side: THREE.DoubleSide,
  })

  const netMesh = new THREE.Mesh(new THREE.BufferGeometry(), surfaceMat)
  netMesh.frustumCulled = false // spans the sphere; a single bounding sphere would be useless
  netMesh.visible = false // hidden until the network is baked
  group.add(netMesh)

  // --- settlement snapshot (read-only from world) ---------------------------
  function readSettlements() {
    const anchorsByProject = new Map()
    world.group.traverse((obj) => {
      const s = obj.userData && obj.userData.settlement
      if (s && !anchorsByProject.has(s.project)) {
        anchorsByProject.set(s.project, s.anchorDir)
      }
    })
    const out = []
    for (const row of world.list()) {
      const anchorDir = anchorsByProject.get(row.project)
      if (!anchorDir) continue
      out.push({ project: row.project, anchorDir })
    }
    return out
  }

  // --- relatedness edges: shared path prefix OR short angular distance ------
  // Every candidate is capped at ROAD_MAX_ANGLE (a road is never an
  // ocean-crossing), deduped, then greedily taken shortest-first until
  // ROAD_CAP, skipping any whose path runs mostly through water.
  function waterFraction(a, b, samples) {
    let water = 0
    const p = _tb1 // reuse scratch — no cross-call state
    for (let k = 1; k < samples; k++) {
      nlerpPoint(p, a, b, k / samples)
      if (!planet.isLand(p)) water++
    }
    return water / Math.max(1, samples - 1)
  }

  function deriveEdges(settlements) {
    const seen = new Set()
    const candidates = []
    for (let i = 0; i < settlements.length; i++) {
      const pi = parentDir(settlements[i].project)
      for (let j = i + 1; j < settlements.length; j++) {
        const ang = settlements[i].anchorDir.angleTo(settlements[j].anchorDir)
        if (ang > ROAD_MAX_ANGLE) continue
        const related = pi === parentDir(settlements[j].project) || ang < DIST_THRESHOLD
        if (!related) continue
        const key = i + '-' + j
        if (seen.has(key)) continue
        seen.add(key)
        candidates.push({ a: settlements[i], b: settlements[j], ang })
      }
    }
    // Fallback: sparse world with no "related" pair still gets one road
    // between its two nearest settlements (if short enough to be plausible).
    if (candidates.length === 0 && settlements.length >= 2) {
      let best = null
      for (let i = 0; i < settlements.length; i++) {
        for (let j = i + 1; j < settlements.length; j++) {
          const ang = settlements[i].anchorDir.angleTo(settlements[j].anchorDir)
          if (ang <= ROAD_MAX_ANGLE && (!best || ang < best.ang)) {
            best = { a: settlements[i], b: settlements[j], ang }
          }
        }
      }
      if (best) candidates.push(best)
    }
    candidates.sort((p, q) => p.ang - q.ang) // shortest hops first = most plausible tracks
    const edges = []
    for (const c of candidates) {
      if (edges.length >= ROAD_CAP) break
      const samples = clamp(Math.ceil(c.ang / ROAD_STEP), 2, ROAD_MAX_SAMPLES)
      if (waterFraction(c.a.anchorDir, c.b.anchorDir, samples) > MAX_WATER_FRAC) continue
      edges.push({ a: c.a.anchorDir, b: c.b.anchorDir, samples })
    }
    return edges
  }

  // --- ribbon baker ---------------------------------------------------------
  // Walks the great circle A->B, emitting a two-vertex-wide strip that hugs
  // the surface (sampleHeight + ROAD_LIFT on land) or lifts into a stone
  // bridge deck (SEA_LEVEL + BRIDGE_LIFT) over water. Appends triangles into
  // the shared positions/colors arrays. All parts merge into one geometry.
  function bakeEdge(edge, edgeIdx, positions, colors) {
    const { a, b, samples } = edge
    // Precompute per-sample surface point, side vector, land flag.
    const P = [] // Vector3 surface centerline points
    const Rt = [] // Vector3 side (ribbon-right) unit vectors
    const land = []
    const dir = new THREE.Vector3()
    const fwd = new THREE.Vector3()
    const right = new THREE.Vector3()
    let prevFwd = null
    for (let k = 0; k <= samples; k++) {
      nlerpPoint(dir, a, b, k / samples)
      const isLand = planet.isLand(dir)
      const radius = isLand ? planet.sampleHeight(dir) + ROAD_LIFT : SEA_LEVEL + BRIDGE_LIFT
      P.push(new THREE.Vector3().copy(dir).multiplyScalar(radius))
      // Ribbon-right = dir x forward (a tangent perpendicular to the path).
      tangentToward(dir, b, fwd)
      if (fwd.lengthSq() < 1e-12) {
        if (prevFwd) fwd.copy(prevFwd)
        else {
          tangentBasis(dir, _tb1, _tb2)
          fwd.copy(_tb1)
        }
      }
      prevFwd = prevFwd || new THREE.Vector3()
      prevFwd.copy(fwd)
      right.crossVectors(dir, fwd)
      if (right.lengthSq() < 1e-12) {
        tangentBasis(dir, _tb1, _tb2)
        right.copy(_tb2)
      }
      right.normalize()
      Rt.push(new THREE.Vector3().copy(right).multiplyScalar(HALF_WIDTH))
      land.push(isLand)
    }

    // Emit one quad (two triangles) per segment. A segment is a bridge if
    // either of its endpoints is over water — that lifts the ramps too.
    for (let k = 0; k < samples; k++) {
      const isBridge = !land[k] || !land[k + 1]
      const baseHex = isBridge ? BRIDGE_STONE : ROAD_DIRT
      const L0 = _v(P[k], Rt[k], -1)
      const R0 = _v(P[k], Rt[k], 1)
      const L1 = _v(P[k + 1], Rt[k + 1], -1)
      const R1 = _v(P[k + 1], Rt[k + 1], 1)
      // Two triangles: (L0,R0,R1) and (L0,R1,L1).
      pushTri(positions, colors, L0, R0, R1, baseHex, edgeIdx, k, 0)
      pushTri(positions, colors, L0, R1, L1, baseHex, edgeIdx, k, 1)
    }
  }

  // Small local temporaries reused inside bakeEdge's inner loop (still build
  // time — cheap, and avoids churning Vector3s).
  const _edgeTmp = new THREE.Vector3()
  function _v(center, halfRight, sign) {
    // Returns a fresh {x,y,z} for the vertex center ± halfRight (build-time).
    _edgeTmp.copy(center).addScaledVector(halfRight, sign)
    return { x: _edgeTmp.x, y: _edgeTmp.y, z: _edgeTmp.z }
  }

  function pushTri(positions, colors, p0, p1, p2, hex, edgeIdx, k, triIdx) {
    const c = new THREE.Color(hex)
    // Deterministic per-triangle value jitter (worn, uneven ground).
    const j = (hash01(seed + ':road:' + edgeIdx + ':' + k + ':' + triIdx) - 0.5) * 2 * COLOR_JITTER
    const r = clamp(c.r + j, 0, 1)
    const g = clamp(c.g + j, 0, 1)
    const bl = clamp(c.b + j, 0, 1)
    for (const p of [p0, p1, p2]) {
      positions.push(p.x, p.y, p.z)
      colors.push(r, g, bl)
    }
  }

  function buildNetwork(settlements) {
    const edges = deriveEdges(settlements)
    if (edges.length === 0) return 0
    const positions = []
    const colors = []
    for (let e = 0; e < edges.length; e++) bakeEdge(edges[e], e, positions, colors)
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3))
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(colors), 3))
    geo.computeVertexNormals()
    geo.computeBoundingSphere()
    netMesh.geometry.dispose()
    netMesh.geometry = geo
    netMesh.visible = true
    return edges.length
  }

  // --- lazy init state machine (mirrors airships.js / caravans.js): waiting
  // for world.js to populate settlements -> settling (let its poll cycle
  // finish) -> ready (network baked once, then update() is a no-op).
  const INIT_RECHECK = 2 // seconds between "any settlement yet" peeks
  const INIT_SETTLE = 6 // seconds to let world.js's poll populate before snapshotting
  let initPhase = 'waiting'
  let peekTimer = 0
  let settleRemaining = 0

  function update(dt) {
    if (initPhase === 'ready') return // static geometry — nothing to animate

    if (initPhase === 'waiting') {
      peekTimer -= dt
      if (peekTimer > 0) return
      peekTimer = INIT_RECHECK
      let any = false
      world.group.traverse((obj) => {
        if (obj.userData && obj.userData.settlement) any = true
      })
      if (any) {
        initPhase = 'settling'
        settleRemaining = INIT_SETTLE
      }
      return
    }

    // initPhase === 'settling'
    settleRemaining -= dt
    if (settleRemaining > 0) return
    const built = buildNetwork(readSettlements())
    initPhase = 'ready'
    if (built === 0 && !warnedNoRoads) {
      warnedNoRoads = true
      console.warn(
        '[planet] roads.js: no roads built — fewer than 2 related/nearby settlements within range (expected on sparse/scattered worlds)',
      )
    }
  }

  return { group, update }
}
