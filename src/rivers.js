// Rivers: draped water ribbons that trace the eroded drainage network down the
// carved valleys to the coast, then tuck under the translucent ocean shell at
// their mouths (E1 — see docs/design/epilogue-e1.md, BT6).
//
// The drainage network is baked ONCE inside createPlanet (deterministic CPU
// erosion over the committed heightfield) and exposed via planet.getRiverNetwork()
// — it is ready the moment createPlanet resolves, so unlike roads.js there is NO
// settlement wait / lazy state machine here: we read the network at construction
// and bake the geometry immediately.
//
// >>> ENGINE: WebGPURenderer (WebGL2 backend via forceWebGL) + true-WebGPU. This
// module is a single non-indexed BufferGeometry drawn by ONE Mesh (=> 1 draw
// call) with a TSL MeshStandardNodeMaterial. It uses NO point sprites (pointUV /
// gl_PointCoord) and NO custom per-instance vertex attributes — the two plain
// per-vertex attributes (aRiverT, aFlow) sit on a normal Mesh exactly like
// ocean.js's aDepth / roads.js's color, so both backends compile the WGSL/GLSL.
// The node graph is built ONCE; the only animation is a uTime uniform advanced
// by update(dt) (a presentation-only shimmer clock, never world state).
//
// Draping mirrors roads.js's bakeEdge: per polyline we walk the smoothed node
// dirs, sample planet.sampleHeight(dir)+RIVER_LIFT to sit just above the carved
// valley floor, and emit a two-vertex-wide strip (two triangles per segment).
// The mouth node is pulled just below SEA_LEVEL so the ribbon end fades under the
// ocean shell (the shell is added AFTER rivers in main.js and composites over it).
//
// Determinism (LAWS): geometry derives entirely from the committed, deterministic
// river network + planet.sampleHeight — no per-frame randomness and no wall-clock
// reads anywhere. The only time source is update(dt) accumulating dt into uTime
// for the shimmer, exactly as ocean.js accumulates its presentation clock.
//
// THE COVENANT: rivers are ADDITIVE, static geography. They never read, move, or
// overwrite a world.js structure; they only shimmer in place. No heal cycle is
// needed because they never advance or reshape.
//
// Contract (pinned): export function createRivers(planet, _seed) -> { group, update(dt) }
import * as THREE from 'three/webgpu'
import { attribute, uniform, color, mix, sin, normalize, positionWorld, cameraPosition } from 'three/tsl'
import { SEA_LEVEL, clamp } from './util.js'
import { tangentBasis } from './placement.js'

// ---------------------------------------------------------------------------
// Ribbon geometry tunables.
// ---------------------------------------------------------------------------
const RIVER_LIFT = 0.0005 // world units above the carved valley floor (avoid z-fight)
const RIVER_MOUTH_SINK = 0.002 // how far below SEA_LEVEL the mouth node tucks (under the shell)
const RIVER_MIN_HALF = 0.0004 // floor on per-node half-width so thin headwaters don't vanish
const RIVER_MAX_ORDER = 5 // Strahler order mapped to aFlow == 1 (shallow -> mid palette)

// ---------------------------------------------------------------------------
// Water palette (ocean.js 3-stop depth absorption, shared so rivers read as the
// same water body as the sea). Small rivers stay shallow/turquoise; big trunks
// tend mid-teal; grazing view angles deepen toward sapphire.
// ---------------------------------------------------------------------------
const STOP_SHALLOW = 0x8fe2d1
const STOP_MID = 0x2f8fa8
const STOP_DEEP = 0x0f3a66

// Downstream shimmer: a subtle brightness ripple travelling head->mouth. Kept
// tiny and CLAMPED so the water surface never crosses 1.0 (ART.md §2.5 — water
// must not bloom). Peak channel of the palette is ~0.89, so +AMP stays < 1.0.
const SHIMMER_K = 24 // ripples per unit aRiverT (0 head -> 1 mouth)
const SHIMMER_AMP = 0.06 // brightness swing added to the water color
const FRESNEL_DEEP = 0.7 // how far a grazing view mixes the color toward uStopDeep

let warnedNoRivers = false

// ---------------------------------------------------------------------------
// Build-time spherical scratch (allocation is fine at build time — LAWS only
// bans per-frame allocation, and update() here just writes a uniform).
// ---------------------------------------------------------------------------
const _tb1 = new THREE.Vector3()
const _tb2 = new THREE.Vector3()

/** Tangent-plane-projected heading from unit `dir` toward `target`, into `out`. Zero-length if degenerate. */
function tangentToward(dir, target, out) {
  out.subVectors(target, dir)
  out.addScaledVector(dir, -out.dot(dir))
  if (out.lengthSq() > 1e-12) out.normalize()
  else out.set(0, 0, 0)
  return out
}

// ---------------------------------------------------------------------------
// createRivers
// ---------------------------------------------------------------------------
export function createRivers(planet, _seed) {
  const group = new THREE.Group()
  // Determinism handle for the verify sweep (matches the planet's bake hash).
  group.userData.riverHash = planet.bakeHash

  const net = planet.getRiverNetwork ? planet.getRiverNetwork() : null
  const paths = net && Array.isArray(net.paths) ? net.paths : []

  // --- bake ONE non-indexed geometry from all polylines ---------------------
  const positions = []
  const riverT = []
  const flow = []

  const dirK = new THREE.Vector3()
  const dirNext = new THREE.Vector3()
  const fwd = new THREE.Vector3()
  const right = new THREE.Vector3()
  const prevFwd = new THREE.Vector3()

  for (const path of paths) {
    const nodes = path && path.nodes
    if (!nodes || nodes.length < 6) continue // need >= 2 nodes (6 floats) to form a segment
    const n = Math.floor(nodes.length / 3)
    const widths = path.widths || null
    const order = path.order | 0 || 1
    const mouthUnder = !!path.mouthUnder
    // Flow tier -> aFlow (0 = smallest creek, 1 = trunk): drives shallow->mid mix.
    const flowTier = clamp((order - 1) / (RIVER_MAX_ORDER - 1), 0, 1)

    // Precompute per-node surface centre point and ribbon-right vector.
    const centre = new Array(n) // Vector3 draped centreline points
    const half = new Array(n) // Vector3 ribbon-right * half-width
    let havePrevFwd = false

    for (let k = 0; k < n; k++) {
      dirK.set(nodes[3 * k], nodes[3 * k + 1], nodes[3 * k + 2])
      if (dirK.lengthSq() < 1e-12) dirK.set(0, 1, 0)
      dirK.normalize()

      // Radius: sit just above the carved valley floor; the mouth tucks under sea.
      let radius = planet.sampleHeight(dirK) + RIVER_LIFT
      if (mouthUnder && k === n - 1) radius = Math.min(radius, SEA_LEVEL - RIVER_MOUTH_SINK)
      centre[k] = new THREE.Vector3().copy(dirK).multiplyScalar(radius)

      // Forward heading toward the next node (reuse previous at the mouth).
      if (k < n - 1) {
        dirNext.set(nodes[3 * (k + 1)], nodes[3 * (k + 1) + 1], nodes[3 * (k + 1) + 2]).normalize()
        tangentToward(dirK, dirNext, fwd)
      } else {
        fwd.set(0, 0, 0)
      }
      if (fwd.lengthSq() < 1e-12) {
        if (havePrevFwd) fwd.copy(prevFwd)
        else {
          tangentBasis(dirK, _tb1, _tb2)
          fwd.copy(_tb1)
        }
      }
      prevFwd.copy(fwd)
      havePrevFwd = true

      // Ribbon-right = dir x forward (tangent perpendicular to the path).
      right.crossVectors(dirK, fwd)
      if (right.lengthSq() < 1e-12) {
        tangentBasis(dirK, _tb1, _tb2)
        right.copy(_tb2)
      }
      right.normalize()
      const hw = Math.max(RIVER_MIN_HALF, widths && widths.length > k ? widths[k] : RIVER_MIN_HALF)
      half[k] = new THREE.Vector3().copy(right).multiplyScalar(hw)
    }

    // Emit one quad (two triangles) per segment. aRiverT = k/(n-1): 0 head, 1 mouth.
    for (let k = 0; k < n - 1; k++) {
      const t0 = k / (n - 1)
      const t1 = (k + 1) / (n - 1)
      const L0 = _sub(centre[k], half[k])
      const R0 = _add(centre[k], half[k])
      const L1 = _sub(centre[k + 1], half[k + 1])
      const R1 = _add(centre[k + 1], half[k + 1])
      // Winding mirrors roads.js pushTri: (L0,R0,R1) and (L0,R1,L1).
      pushVert(L0, t0, flowTier)
      pushVert(R0, t0, flowTier)
      pushVert(R1, t1, flowTier)
      pushVert(L0, t0, flowTier)
      pushVert(R1, t1, flowTier)
      pushVert(L1, t1, flowTier)
    }
  }

  function pushVert(p, t, f) {
    positions.push(p.x, p.y, p.z)
    riverT.push(t)
    flow.push(f)
  }

  // Nothing to draw (no committed rivers, or all polylines degenerate).
  if (positions.length === 0) {
    if (!warnedNoRivers) {
      warnedNoRivers = true
      console.warn(
        '[planet] rivers.js: no river ribbons built — drainage network is empty (expected on all-ocean or flat seeds)',
      )
    }
    return { group, update() {} }
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3))
  geo.setAttribute('aRiverT', new THREE.BufferAttribute(new Float32Array(riverT), 1))
  geo.setAttribute('aFlow', new THREE.BufferAttribute(new Float32Array(flow), 1))
  geo.computeVertexNormals()
  geo.computeBoundingSphere()

  // --- material: node graph built ONCE, only uTime animates -----------------
  // Unlit: a stylized water ribbon must read as its palette everywhere, not
  // blow out to white where the sun's specular glint hits a low-roughness lit
  // surface. colorNode IS the final color (matches the stylized-water intent).
  const material = new THREE.MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: true,
    side: THREE.DoubleSide,
  })

  const uTime = uniform(0)
  const uStopShallow = color(STOP_SHALLOW)
  const uStopMid = color(STOP_MID)
  const uStopDeep = color(STOP_DEEP)

  const aFlow = attribute('aFlow', 'float')
  const aRiverT = attribute('aRiverT', 'float')

  // View-dependent fresnel over the ribbon's (near-radial) normal — grazing
  // angles deepen toward sapphire, looking down stays shallow/mid (ocean.js look).
  const view = normalize(cameraPosition.sub(positionWorld))
  // Radial surface normal (sphere-draped ribbon) — robust regardless of the
  // ribbon geometry's own normals, which an unlit material may not carry.
  const fresnel = view.dot(normalize(positionWorld)).clamp(0, 1).oneMinus().pow(3)

  const base = mix(uStopShallow, uStopMid, aFlow) // flow tier: creek -> trunk
  const deepened = mix(base, uStopDeep, fresnel.mul(FRESNEL_DEEP))

  // Downstream shimmer, CLAMPED so the surface never exceeds 1.0 (no bloom).
  const shimmer = sin(aRiverT.mul(SHIMMER_K).add(uTime)).mul(SHIMMER_AMP)
  material.colorNode = deepened.add(shimmer).clamp(0, 1)

  const mesh = new THREE.Mesh(geo, material)
  mesh.frustumCulled = false // spans the sphere; a single bounding sphere is useless
  group.add(mesh)

  // --- update: presentation-only shimmer clock (no allocation, graph static) -
  function update(dt) {
    uTime.value += dt
  }

  return { group, update }
}

// ---------------------------------------------------------------------------
// Build-time vertex temporaries — return fresh {x,y,z} for centre ± half.
// (Cheap, build-time only; keeps the emit loop free of Vector3 churn.)
// ---------------------------------------------------------------------------
const _vTmp = new THREE.Vector3()
function _sub(centre, half) {
  _vTmp.copy(centre).sub(half)
  return { x: _vTmp.x, y: _vTmp.y, z: _vTmp.z }
}
function _add(centre, half) {
  _vTmp.copy(centre).add(half)
  return { x: _vTmp.x, y: _vTmp.y, z: _vTmp.z }
}
