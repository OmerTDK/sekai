// Trade caravans + coastal boats: the ground/water traversal layer that
// makes the "active trade routes" between settlements legible (owner
// request). Land caravans (a small wooden cart flanked by 2-3 walker
// figures) plod along seeded great-circle paths between nearby settlements,
// dwelling at each end to "load goods" then turning around and looping.
// Coastal boats (a low wooden hull with a single sail) tack back and forth
// along short water arcs off the coast of port settlements, bobbing on the
// sea surface.
//
// Engine: THREE.WebGPURenderer(forceWebGL) host — every material is a
// NodeMaterial imported from 'three/webgpu' (MeshStandardMaterial resolves
// to the node material there, exactly as sealife.js / airships.js already
// rely on). No legacy shader-string customization anywhere. Animation is pure
// per-instance-matrix root motion (the rigid-body-with-eased-heading
// technique sealife.js uses for its whales/dolphins), driven by three
// InstancedMeshes on a single shared material = 3 draw calls total.
//
// Determinism (LAWS): every structural + cosmetic choice derives from a
// rngFromString(seed) stream; NO Math.random / Date.now anywhere — sim time
// is accumulated from dt. Relaunching the same planet rebuilds the identical
// routes, carts, walkers and boats.
//
// THE COVENANT: `world` is read-only here. Settlement anchors aren't on
// world.list()'s rows, so (like airships.js) they're read via a one-time
// world.group traversal for objects carrying `userData.settlement`. Because
// world.js populates settlements asynchronously (its /api/sessions poll),
// the fleet is built lazily on the first update() ticks — see the
// waiting/settling/ready state machine at the bottom.
//
// Contract (pinned for the architect):
//   export function createCaravans(planet, world, seed) -> { group, update(dt, camera) }
// `camera` is optional; pass it (as seaLife.update does) for distance
// culling. Without it the module simply never culls.
import * as THREE from 'three/webgpu'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { SEA_LEVEL, rngFromString, clamp } from './util.js'
import { tangentBasis, orientOnSurface, stepToward } from './placement.js'

// ---------------------------------------------------------------------------
// Palette — muted wood/canvas tones (ART.md: never emissive/bloom-crossing).
// ---------------------------------------------------------------------------
const CART_WOOD = 0x6b4a2f
const CART_COVER = 0xcabf9f // canvas tilt
const WHEEL_DARK = 0x33291f
const WALKER_CLOTH = 0x7d6a50
const WALKER_SKIN = 0xc79a6b
const BOAT_HULL = 0x5c3f27
const BOAT_TRIM = 0x2f2620
const BOAT_SAIL = 0xd7ccb2

// ---------------------------------------------------------------------------
// Route derivation tunables.
// ---------------------------------------------------------------------------
const MAX_ROUTE_ANGLE = 0.55 // rad — nearest-neighbour caravan link cap (short local trade)
const ROUTE_CAP_LAND = 5 // max caravan routes
const PATH_SAMPLES = 6 // interior samples checked for land along a caravan path
const PATH_MAX_WATER = 1 // tolerate at most this many water samples before rejecting a route

const BOAT_CAP = 5 // max coastal boats
const PORT_TRIES = 60 // attempts to find a coastal ocean point near a settlement
const PORT_MIN = 0.02 // rad — port search ring around the settlement anchor
const PORT_MAX = 0.055
const COAST_RING = 0.02 // rad — a port must have land within this ring (i.e. be coastal, not open ocean)
const COAST_RING_PROBES = 8
const ARC_BEARING_TRIES = 6 // attempts to find an all-water patrol arc off a port
const ARC_LEN_MIN = 0.03 // rad — boat patrol arc length
const ARC_LEN_MAX = 0.05
const ARC_SAMPLES = 5 // samples along the arc that must all be ocean

// ---------------------------------------------------------------------------
// Motion tunables.
// ---------------------------------------------------------------------------
const CARAVAN_SPEED = 0.011 // rad/s along the great circle
const BOAT_SPEED = 0.014 // rad/s
const DWELL_MIN = 3 // seconds a caravan/boat waits at each endpoint
const DWELL_MAX = 7
const HEADING_SMOOTH = 2.6 // per-second exponential-approach rate for eased turnaround (nothing snaps)

const CART_SCALE = 0.0065 // world units — unit-space geometry (~1 tall) scaled by this
const WALKER_SCALE = 0.0052
const BOAT_SCALE = 0.0085

const CART_LIFT = 0.0004 // world units the cart body floats above sampleHeight (axle clearance)
const WALKER_LIFT = 0.0005
const WALKERS_MIN = 2
const WALKERS_MAX = 3 // inclusive
const WALKER_LATERAL = 0.0016 // rad — walker offset perpendicular to heading (beside the cart)
const WALKER_ALONG = 0.0022 // rad — walker offset along heading (fore/aft of the cart)
const WALKER_BOB_AMP = 0.0006 // world units vertical walk-bob
const WALKER_BOB_FREQ = 9 // rad/s

const BOAT_BOB_AMP = 0.0007 // world units vertical sea bob
const BOAT_BOB_FREQ = 1.1 // rad/s
const BOAT_ROLL_AMP = 0.08 // rad side-to-side roll
const BOAT_ROLL_FREQ = 0.8 // rad/s

const CAMERA_CULL_DIST = 2.5 // R — beyond this, keep ticking sim but skip instance-matrix writes

// ---------------------------------------------------------------------------
// Module-scope scratch (write-before-read only; never holds state across
// calls — same convention as placement.js's _tb1/_tb2 and sealife.js's
// _instMat, reused across caravans/walkers/boats since they update
// sequentially, not concurrently).
// ---------------------------------------------------------------------------
const _t1 = new THREE.Vector3()
const _t2 = new THREE.Vector3()
const _ring = new THREE.Vector3()
const _fwdDesired = new THREE.Vector3()
const _right = new THREE.Vector3()
const _walkerDir = new THREE.Vector3()
const _nlerp = new THREE.Vector3()
const _dummy = new THREE.Object3D()

let warnedNoRoutes = false

// ---------------------------------------------------------------------------
// Pure spherical helpers (duplicated locally per this codebase's convention —
// airships.js/sealife.js keep their own private copies rather than exporting).
// ---------------------------------------------------------------------------

/** Writes into `out` the point `dist` radians from `base` along `bearing`. */
function offsetPoint(base, bearing, dist, out) {
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

/** Normalized-lerp point between unit vectors `a`/`b` — the cheap great-circle approximation stepToward uses internally. */
function nlerpPoint(out, a, b, t) {
  out.copy(a).lerp(b, t)
  if (out.lengthSq() < 1e-10) out.copy(a)
  return out.normalize()
}

/** Tangent-plane-projected heading from `dir` toward `target`, written into `out` (leaves `out` untouched if degenerate). */
function tangentToward(dir, target, out) {
  out.subVectors(target, dir)
  out.addScaledVector(dir, -out.dot(dir))
  if (out.lengthSq() > 1e-12) out.normalize()
}

/** True if at least one point on a `radius`-ring around ocean point `dir` is land (i.e. `dir` is coastal). */
function hasLandRing(planet, dir, radius, probes) {
  for (let i = 0; i < probes; i++) {
    offsetPoint(dir, (i / probes) * Math.PI * 2, radius, _ring)
    if (planet.isLand(_ring)) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Geometry builders — low-poly merged parts with baked per-vertex colors, so
// a whole cart/walker/boat is ONE geometry drawn by ONE InstancedMesh on the
// shared vertex-color material (sealife.js's paintFlat + mergeParts idiom).
// Everything is built in local unit space with forward = +Z, up = +Y, and
// the wheel/hull bottom resting at y = 0 so the instance sits on the ground
// when placed at sampleHeight.
// ---------------------------------------------------------------------------
function paintFlat(geo, hex) {
  const c = new THREE.Color(hex)
  const n = geo.attributes.position.count
  const arr = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    arr[i * 3] = c.r
    arr[i * 3 + 1] = c.g
    arr[i * 3 + 2] = c.b
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3))
  return geo
}

function mergeParts(parts) {
  // All parts carry position/normal/uv/color; convert any indexed geometry
  // to non-indexed first (mergeGeometries requires consistent indexing —
  // see the TSL spike's BatchedMesh gotcha, same rule applies to merge).
  const nonIndexed = parts.map((g) => (g.index ? g.toNonIndexed() : g))
  const merged = mergeGeometries(nonIndexed, false)
  const out = merged || parts[0]
  out.computeBoundingSphere()
  return out
}

function box(sx, sy, sz, px, py, pz, hex) {
  const g = new THREE.BoxGeometry(1, 1, 1)
  g.scale(sx, sy, sz)
  g.translate(px, py, pz)
  return paintFlat(g, hex)
}

/** Flat double-sided triangle (sail) — relies on the shared material's DoubleSide, same trick sealife's fins use. */
function tri(a, b, c, hex) {
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([...a, ...b, ...c]), 3))
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 0.5, 1]), 2))
  g.setIndex([0, 1, 2])
  g.computeVertexNormals()
  return paintFlat(g, hex)
}

function buildCartGeometry() {
  const parts = []
  // Wheels: 4 low-poly discs, axis along local X (bottom at y=0).
  const R = 0.22
  for (const px of [-0.3, 0.3]) {
    for (const pz of [-0.32, 0.32]) {
      const w = new THREE.CylinderGeometry(R, R, 0.09, 8)
      w.rotateZ(Math.PI / 2)
      w.translate(px, R, pz)
      parts.push(paintFlat(w, WHEEL_DARK))
    }
  }
  parts.push(box(0.52, 0.34, 0.92, 0, R + 0.18, 0, CART_WOOD)) // bed
  parts.push(box(0.56, 0.32, 0.78, 0, R + 0.5, -0.02, CART_COVER)) // canvas tilt
  parts.push(box(0.06, 0.06, 0.5, 0, R + 0.06, 0.62, CART_WOOD)) // draw shaft out the front
  return mergeParts(parts)
}

function buildWalkerGeometry() {
  const parts = []
  parts.push(box(0.3, 0.58, 0.24, 0, 0.42, 0, WALKER_CLOTH)) // torso/legs
  parts.push(box(0.24, 0.24, 0.24, 0, 0.82, 0, WALKER_SKIN)) // head
  parts.push(box(0.34, 0.14, 0.2, 0, 0.62, 0.02, WALKER_CLOTH)) // shoulders/pack
  return mergeParts(parts)
}

function buildBoatGeometry() {
  const parts = []
  parts.push(box(0.42, 0.22, 1.0, 0, 0.14, 0, BOAT_HULL)) // hull
  parts.push(box(0.36, 0.06, 0.9, 0, 0.27, 0, BOAT_TRIM)) // gunwale trim
  parts.push(box(0.05, 0.55, 0.05, 0, 0.5, 0, BOAT_TRIM)) // mast
  // Fore-and-aft mainsail (triangle in the local x=0 plane), double-sided.
  parts.push(tri([0, 0.28, 0.28], [0, 0.78, -0.02], [0, 0.28, -0.34], BOAT_SAIL))
  return mergeParts(parts)
}

// ---------------------------------------------------------------------------
// createCaravans
// ---------------------------------------------------------------------------
export function createCaravans(planet, world, seed) {
  const group = new THREE.Group()

  // One shared node material for all three instanced meshes (vertex colors,
  // flat-shaded, double-sided for the flat sail). Same material config
  // sealife.js's creatures use.
  const sharedMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    flatShading: true,
    roughness: 0.85,
    metalness: 0.02,
    side: THREE.DoubleSide,
  })

  const cartMesh = new THREE.InstancedMesh(buildCartGeometry(), sharedMat, ROUTE_CAP_LAND)
  const walkerMesh = new THREE.InstancedMesh(buildWalkerGeometry(), sharedMat, ROUTE_CAP_LAND * WALKERS_MAX)
  const boatMesh = new THREE.InstancedMesh(buildBoatGeometry(), sharedMat, BOAT_CAP)
  for (const m of [cartMesh, walkerMesh, boatMesh]) {
    m.count = 0
    m.frustumCulled = false // travelers roam the sphere; a per-instance bounding sphere would be stale
    group.add(m)
  }

  const caravans = [] // { a, b, dir, forward, target, dwell, walkers:[{lateral,along,phase}], scale }
  const walkersFlat = [] // flat list for the walker InstancedMesh, each -> its caravan
  const boats = [] // { a, b, dir, forward, target, dwell, bobPhase, scale }

  // --- settlement snapshot (read-only from world) ---------------------------
  function readSettlements() {
    const anchorsByProject = new Map()
    world.group.traverse((obj) => {
      const s = obj.userData && obj.userData.settlement
      if (s && !anchorsByProject.has(s.project)) {
        anchorsByProject.set(s.project, { anchorDir: s.anchorDir, groundR: s.groundR, race: s.race })
      }
    })
    const out = []
    for (const row of world.list()) {
      const a = anchorsByProject.get(row.project)
      if (!a) continue
      out.push({
        project: row.project,
        anchorDir: a.anchorDir,
        groundR: a.groundR,
        structures: row.structures,
      })
    }
    return out
  }

  // --- caravan routes: nearest-neighbour land links -------------------------
  function pathOnLand(a, b) {
    let water = 0
    for (let k = 1; k < PATH_SAMPLES; k++) {
      nlerpPoint(_nlerp, a, b, k / PATH_SAMPLES)
      if (!planet.isLand(_nlerp)) water++
    }
    return water <= PATH_MAX_WATER
  }

  function deriveLandRoutes(settlements) {
    const seen = new Set()
    const candidates = []
    for (let i = 0; i < settlements.length; i++) {
      let best = -1
      let bestAng = MAX_ROUTE_ANGLE
      for (let j = 0; j < settlements.length; j++) {
        if (i === j) continue
        const ang = settlements[i].anchorDir.angleTo(settlements[j].anchorDir)
        if (ang < bestAng) {
          bestAng = ang
          best = j
        }
      }
      if (best < 0) continue
      const key = i < best ? i + '-' + best : best + '-' + i
      if (seen.has(key)) continue
      seen.add(key)
      candidates.push({ a: settlements[i], b: settlements[best], ang: bestAng })
    }
    candidates.sort((p, q) => p.ang - q.ang) // shortest hops first = most plausible trade legs
    const routes = []
    for (const c of candidates) {
      if (routes.length >= ROUTE_CAP_LAND) break
      if (!pathOnLand(c.a.anchorDir, c.b.anchorDir)) continue
      routes.push(c)
    }
    return routes
  }

  function buildCaravans(settlements) {
    const routes = deriveLandRoutes(settlements)
    for (let r = 0; r < routes.length; r++) {
      const rng = rngFromString(seed + ':caravans:route:' + r)
      const a = routes[r].a.anchorDir.clone()
      const b = routes[r].b.anchorDir.clone()
      const dir = a.clone()
      const forward = new THREE.Vector3()
      tangentToward(dir, b, forward)
      if (forward.lengthSq() < 1e-12) {
        tangentBasis(dir, _t1, _t2)
        forward.copy(_t1)
      }
      const nWalkers = WALKERS_MIN + Math.floor(rng() * (WALKERS_MAX - WALKERS_MIN + 1))
      const walkers = []
      for (let w = 0; w < nWalkers; w++) {
        const walker = {
          lateral: (rng() * 2 - 1) * WALKER_LATERAL,
          along: -WALKER_ALONG * (0.4 + w * 0.6), // trailing behind the cart, staggered
          phase: rng() * Math.PI * 2,
        }
        walkers.push(walker)
        walkersFlat.push({ caravan: null, spec: walker })
      }
      const caravan = {
        a,
        b,
        dir,
        forward,
        target: b,
        moving: true,
        dwell: 0,
        walkers,
        scale: CART_SCALE * (0.9 + rng() * 0.2),
      }
      for (let w = walkersFlat.length - nWalkers; w < walkersFlat.length; w++)
        walkersFlat[w].caravan = caravan
      caravans.push(caravan)
    }
    cartMesh.count = caravans.length
    walkerMesh.count = walkersFlat.length
  }

  // --- coastal boats: an all-water patrol arc off a port settlement ---------
  function findBoatArc(settlement, rng) {
    for (let t = 0; t < PORT_TRIES; t++) {
      const bearing = rng() * Math.PI * 2
      const dist = PORT_MIN + rng() * (PORT_MAX - PORT_MIN)
      const port = offsetPoint(settlement.anchorDir, bearing, dist, new THREE.Vector3())
      if (planet.isLand(port)) continue
      if (!hasLandRing(planet, port, COAST_RING, COAST_RING_PROBES)) continue // must actually be coastal
      for (let ab = 0; ab < ARC_BEARING_TRIES; ab++) {
        const arcBearing = rng() * Math.PI * 2
        const arcLen = ARC_LEN_MIN + rng() * (ARC_LEN_MAX - ARC_LEN_MIN)
        const far = offsetPoint(port, arcBearing, arcLen, new THREE.Vector3())
        let allOcean = !planet.isLand(far)
        for (let k = 1; k < ARC_SAMPLES && allOcean; k++) {
          nlerpPoint(_ring, port, far, k / ARC_SAMPLES)
          if (planet.isLand(_ring)) allOcean = false
        }
        if (allOcean) return { a: port, b: far }
      }
    }
    return null
  }

  function buildBoats(settlements) {
    for (let i = 0; i < settlements.length && boats.length < BOAT_CAP; i++) {
      const rng = rngFromString(seed + ':caravans:boat:' + settlements[i].project)
      const arc = findBoatArc(settlements[i], rng)
      if (!arc) continue
      const dir = arc.a.clone()
      const forward = new THREE.Vector3()
      tangentToward(dir, arc.b, forward)
      if (forward.lengthSq() < 1e-12) {
        tangentBasis(dir, _t1, _t2)
        forward.copy(_t1)
      }
      boats.push({
        a: arc.a,
        b: arc.b,
        dir,
        forward,
        target: arc.b,
        moving: true,
        dwell: 0,
        bobPhase: rng() * Math.PI * 2,
        scale: BOAT_SCALE * (0.9 + rng() * 0.2),
      })
    }
    boatMesh.count = boats.length
  }

  // --- shared mover step ----------------------------------------------------
  // Advances a traveler along its great circle toward `target`, ping-ponging
  // (a<->b) with a dwell pause at each endpoint. Heading eases toward the
  // travel direction (nothing snaps — the 180° turnaround glides over ~1s
  // rather than flipping). `rng` supplies the per-endpoint dwell length.
  function stepMover(m, dt, speed, rng) {
    if (m.moving) {
      const arrived = stepToward(m.dir, m.target, speed * dt)
      if (arrived) {
        m.moving = false
        m.dwell = DWELL_MIN + rng() * (DWELL_MAX - DWELL_MIN)
        m.target = m.target === m.a ? m.b : m.a // face the other way while loading
      }
    } else {
      m.dwell -= dt
      if (m.dwell <= 0) m.moving = true
    }
    tangentToward(m.dir, m.target, _fwdDesired)
    if (_fwdDesired.lengthSq() > 1e-12) {
      m.forward.lerp(_fwdDesired, clamp(HEADING_SMOOTH * dt, 0, 1))
      m.forward.addScaledVector(m.dir, -m.forward.dot(m.dir))
      if (m.forward.lengthSq() > 1e-12) m.forward.normalize()
    }
  }

  // --- per-frame visual writes (skipped when camera is far) -----------------
  function writeCaravans(simTime) {
    let widx = 0
    for (let i = 0; i < caravans.length; i++) {
      const c = caravans[i]
      const groundR = planet.sampleHeight(c.dir)
      _dummy.position.copy(c.dir).multiplyScalar(groundR + CART_LIFT)
      orientOnSurface(_dummy, c.dir, c.forward)
      _dummy.scale.setScalar(c.scale)
      _dummy.updateMatrix()
      cartMesh.setMatrixAt(i, _dummy.matrix)

      // Walkers: offset from the cart in the tangent plane (right = fwd×up),
      // each on its own sampled ground height with a walk-bob (only while the
      // caravan is actually moving).
      _right.crossVectors(c.forward, c.dir).normalize()
      for (let w = 0; w < c.walkers.length; w++) {
        const spec = c.walkers[w]
        _walkerDir
          .copy(c.dir)
          .addScaledVector(_right, spec.lateral)
          .addScaledVector(c.forward, spec.along)
          .normalize()
        const gR = planet.sampleHeight(_walkerDir)
        const bob = c.moving ? Math.abs(Math.sin(simTime * WALKER_BOB_FREQ + spec.phase)) * WALKER_BOB_AMP : 0
        _dummy.position.copy(_walkerDir).multiplyScalar(gR + WALKER_LIFT + bob)
        orientOnSurface(_dummy, _walkerDir, c.forward)
        _dummy.scale.setScalar(WALKER_SCALE)
        _dummy.updateMatrix()
        walkerMesh.setMatrixAt(widx++, _dummy.matrix)
      }
    }
    cartMesh.instanceMatrix.needsUpdate = true
    walkerMesh.instanceMatrix.needsUpdate = true
  }

  function writeBoats(simTime) {
    for (let i = 0; i < boats.length; i++) {
      const b = boats[i]
      const bob = Math.sin(simTime * BOAT_BOB_FREQ + b.bobPhase) * BOAT_BOB_AMP
      _dummy.position.copy(b.dir).multiplyScalar(SEA_LEVEL + bob)
      orientOnSurface(_dummy, b.dir, b.forward)
      _dummy.rotateZ(Math.sin(simTime * BOAT_ROLL_FREQ + b.bobPhase) * BOAT_ROLL_AMP)
      _dummy.scale.setScalar(b.scale)
      _dummy.updateMatrix()
      boatMesh.setMatrixAt(i, _dummy.matrix)
    }
    boatMesh.instanceMatrix.needsUpdate = true
  }

  // --- lazy init state machine (mirrors airships.js): waiting for world.js
  // to populate settlements -> settling (let its poll cycle finish) -> ready.
  const INIT_RECHECK = 2 // seconds between "any settlement yet" peeks
  const INIT_SETTLE = 6 // seconds to let world.js's poll populate before snapshotting
  let simTime = 0
  let initPhase = 'waiting'
  let peekTimer = 0
  let settleRemaining = 0

  // Deterministic dwell streams (one per traveler kind), threaded through
  // stepMover — kept as closures so no Math.random ever enters the sim.
  const caravanDwellRng = rngFromString(seed + ':caravans:dwell:land')
  const boatDwellRng = rngFromString(seed + ':caravans:dwell:sea')

  function update(dt, camera) {
    simTime += dt

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

    if (initPhase === 'settling') {
      settleRemaining -= dt
      if (settleRemaining > 0) return
      const settlements = readSettlements()
      buildCaravans(settlements)
      buildBoats(settlements)
      initPhase = 'ready'
      if (caravans.length === 0 && boats.length === 0 && !warnedNoRoutes) {
        warnedNoRoutes = true
        console.warn(
          '[planet] caravans.js: no trade routes built — fewer than 2 nearby land settlements and no coastal ports (expected on sparse/island worlds)',
        )
      }
      return
    }

    // ready — always tick the (cheap, allocation-free) sim so travelers keep
    // their positions/dwell timers advancing even while culled.
    for (let i = 0; i < caravans.length; i++) stepMover(caravans[i], dt, CARAVAN_SPEED, caravanDwellRng)
    for (let i = 0; i < boats.length; i++) stepMover(boats[i], dt, BOAT_SPEED, boatDwellRng)

    const camDist = camera && camera.position ? camera.position.length() : 0
    const near = !camera || camDist <= CAMERA_CULL_DIST
    cartMesh.visible = near && caravans.length > 0
    walkerMesh.visible = near && walkersFlat.length > 0
    boatMesh.visible = near && boats.length > 0
    if (!near) return

    writeCaravans(simTime)
    writeBoats(simTime)
  }

  return { group, update }
}
