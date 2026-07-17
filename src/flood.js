// Landfall coastal flooding: a temporary waterline rise + wet-ground
// darkening under a landfalling hurricane. Two bounded sphere-patch meshes
// (storms.js buildPatch-style, reimplemented here since storms.js doesn't
// export its version): a small flood sheet that reads as water sitting in
// low coastal terrain (a per-vertex terrain-height attribute masks where it
// shows), and a larger, fainter wet-ground ring that lingers after the
// flood drains. Fully reactive to storms' own state + planet terrain -- no
// randomness anywhere, so `seed` is accepted (API contract) but unused.
import * as THREE from 'three/webgpu'
import { attribute, color, length, smoothstep as smoothstepNode, uniform, uv } from 'three/tsl'
import { SEA_LEVEL, clamp, smoothstep } from './util.js'

const LANDFALL_STRENGTH_MIN = 0.35 // storms.getPrimary() strength floor for "landfall"
const PROBE_RADIUS_RAD = 0.1 // land-nearby probe ring radius around the storm center
const PROBE_COUNT = 8
const ANCHOR_HZ = 2 // shared throttle: landfall detection + terrain-height resample
const ANCHOR_INTERVAL = 1 / ANCHOR_HZ

const FLOOD_ANGULAR_RADIUS = 0.12 // rad
const FLOOD_SEGMENTS = 32
const FLOOD_RISE_MAX = 0.0035 // peak waterline rise above SEA_LEVEL
// Fixed shell radius (never animated) -- the "rising" look comes entirely
// from the uFloodLevel-vs-terrainH comparison in the fragment shader below,
// not from moving the mesh. Sits at the rise ceiling, safely under the
// module's +0.004-above-sea-level budget.
const FLOOD_RADIUS = SEA_LEVEL + FLOOD_RISE_MAX
const FLOOD_GROW_TIME = 10 // seconds to ease in once landfall starts
const FLOOD_DRAIN_TIME = 30 // seconds to ease out once the storm leaves land
const FLOOD_SHORE_SOFT = 0.0008 // shoreline fade band width, same units as terrain height
const FLOOD_COLOR = 0x3d6a5e // planet.js shallow #2f8fa8 family, shifted darker/greener + desaturated

const RING_ANGULAR_RADIUS = 0.2 // rad -- larger than the flood sheet, "wet shores" extend past the water
const RING_SEGMENTS = 20
const RING_RADIUS = SEA_LEVEL + 0.0025 // fixed shell; depth-test naturally hides it under higher dry land
const RING_LINGER_TIME = 60 // seconds the wet-ground ring fades over, after the flood has fully drained
const RING_PEAK_ALPHA = 0.15
const RING_COLOR = 0x241f18 // dark, muted wet-ground tint (multiply-style darkening, never pure black)

const UP = new THREE.Vector3(0, 1, 0)
const RIGHT = new THREE.Vector3(1, 0, 0)

// A curved sphere-surface patch, storms.js buildPatch-style: built at a
// fixed radius, then translated so its own center sits at the local origin
// (mesh.position/quaternion track it onto a world direction every frame).
function buildSmallPatch(angularRadius, radius, segments) {
  const sweep = angularRadius * 2
  const thetaStart = Math.PI / 2 - sweep / 2
  const geo = new THREE.SphereGeometry(radius, segments, segments, 0, sweep, thetaStart, sweep)
  const phiCenter = sweep / 2
  const centerDir = new THREE.Vector3(-Math.cos(phiCenter), 0, Math.sin(phiCenter)).normalize()
  geo.translate(-centerDir.x * radius, -centerDir.y * radius, -centerDir.z * radius)
  geo.computeBoundingSphere()
  return { geo, centerDir, radius }
}

const FLOOD_PATCH = buildSmallPatch(FLOOD_ANGULAR_RADIUS, FLOOD_RADIUS, FLOOD_SEGMENTS)
const RING_PATCH = buildSmallPatch(RING_ANGULAR_RADIUS, RING_RADIUS, RING_SEGMENTS)

// Per-vertex terrain height under the flood patch, PREALLOCATED once and
// refreshed in place (resampleTerrain) -- never reallocated.
const floodVertexCount = FLOOD_PATCH.geo.attributes.position.count
const terrainHArray = new Float32Array(floodVertexCount)
FLOOD_PATCH.geo.setAttribute('terrainH', new THREE.BufferAttribute(terrainHArray, 1))

// TSL node graphs, built ONCE here (S1 law: structural node changes cost a
// ~140ms recompile, so the graph shape never changes after this). The only
// per-frame writes are `.value` on the uFloodLevel/uOpacity uniform handles
// (see update() below). No positionNode -- both patches sit at a fixed
// shell radius, so the default vertex transform (position -> MVP) already
// matches the old vertex shaders exactly.
//
// terrainH is the same preallocated-and-resampled BufferAttribute as
// before; attribute('terrainH', 'float') reads it and TSL interpolates it
// to the fragment stage automatically -- no manual varying declaration
// needed. uv() likewise reads the geometry's default uv attribute in place
// of the old `varying vec2 vFUv/vRUv`.
function makeFloodMaterial() {
  const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false })
  material.uFloodLevel = uniform(SEA_LEVEL)
  material.uOpacity = uniform(0)
  const terrainH = attribute('terrainH', 'float')

  const wet = material.uFloodLevel.sub(terrainH)
  const shoreFade = smoothstepNode(0, FLOOD_SHORE_SOFT, wet)
  const c = uv().sub(0.5)
  const edgeFade = smoothstepNode(0.72, 1.0, length(c).mul(2)).oneMinus()

  material.colorNode = color(FLOOD_COLOR)
  material.opacityNode = shoreFade.mul(edgeFade).mul(material.uOpacity).mul(0.78)
  // material.colorNode is vec3 -> promoted to vec4 with alpha 1, so final
  // alpha is exactly opacityNode; alphaTest reproduces `if (alpha < 0.004)
  // discard;` (discards on <=, a no-op difference for a continuous alpha).
  material.alphaTest = 0.004
  return material
}

function makeRingMaterial() {
  const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false })
  material.uOpacity = uniform(0)

  const c = uv().sub(0.5)
  const f = smoothstepNode(0, 1, length(c).mul(2).clamp(0, 1)).oneMinus()

  material.colorNode = color(RING_COLOR)
  material.opacityNode = f.mul(f).mul(material.uOpacity)
  material.alphaTest = 0.003 // matches `if (alpha < 0.003) discard;`
  return material
}

// Silent-fallback rule: warns exactly once, module-level flag (mirrors
// planet.js's warned* pattern).
let warnedContract = false

export function createFloods(planet, storms, _seed) {
  const group = new THREE.Group()

  const floodMat = makeFloodMaterial()
  const floodMesh = new THREE.Mesh(FLOOD_PATCH.geo, floodMat)
  floodMesh.renderOrder = 2 // draws after the ring, compositing on top near the coast
  floodMesh.visible = false
  group.add(floodMesh)

  const ringMat = makeRingMaterial()
  const ringMesh = new THREE.Mesh(RING_PATCH.geo, ringMat)
  ringMesh.renderOrder = 1
  ringMesh.visible = false
  group.add(ringMesh)

  // Precomputed probe-ring offset angles, built once -- landNearby() below
  // reuses these every call, no per-call allocation.
  const probeCos = new Float32Array(PROBE_COUNT)
  const probeSin = new Float32Array(PROBE_COUNT)
  for (let i = 0; i < PROBE_COUNT; i++) {
    const a = (i / PROBE_COUNT) * Math.PI * 2
    probeCos[i] = Math.cos(a)
    probeSin[i] = Math.sin(a)
  }
  const cosPR = Math.cos(PROBE_RADIUS_RAD)
  const sinPR = Math.sin(PROBE_RADIUS_RAD)

  // Scratch -- allocated once, reused every call across the module's life.
  const _stormDir = new THREE.Vector3()
  const _t1 = new THREE.Vector3()
  const _t2 = new THREE.Vector3()
  const _probe = new THREE.Vector3()
  const _origPos = new THREE.Vector3()
  const _worldDir = new THREE.Vector3()
  const _orientQuat = new THREE.Quaternion()

  let anchorTimer = 0
  let floodActive = false
  let riseT = 0
  let ringT = 0

  function tangentBasis(dir) {
    const ref = Math.abs(dir.y) > 0.95 ? RIGHT : UP
    _t1.crossVectors(ref, dir).normalize()
    _t2.crossVectors(dir, _t1).normalize()
  }

  // Ring of precomputed offsets around `dir`, PROBE_RADIUS_RAD out -- true
  // if any sample is land. Same tangent-basis idea as storms.js's own
  // perpendicular(), but a fixed ring instead of one random sample.
  function landNearby(dir) {
    tangentBasis(dir)
    for (let i = 0; i < PROBE_COUNT; i++) {
      const tx = _t1.x * probeCos[i] + _t2.x * probeSin[i]
      const ty = _t1.y * probeCos[i] + _t2.y * probeSin[i]
      const tz = _t1.z * probeCos[i] + _t2.z * probeSin[i]
      _probe
        .set(dir.x * cosPR + tx * sinPR, dir.y * cosPR + ty * sinPR, dir.z * cosPR + tz * sinPR)
        .normalize()
      if (planet.isLand(_probe)) return true
    }
    return false
  }

  // Resamples terrain height at every flood-patch vertex under the CURRENT
  // orientation, straight into the preallocated terrainHArray backing the
  // `terrainH` attribute -- only called at the throttled re-anchor tick.
  function resampleTerrain(quaternion) {
    const posAttr = FLOOD_PATCH.geo.attributes.position
    for (let i = 0; i < floodVertexCount; i++) {
      _origPos.set(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i))
      _origPos.addScaledVector(FLOOD_PATCH.centerDir, FLOOD_PATCH.radius)
      _worldDir.copy(_origPos).applyQuaternion(quaternion).normalize()
      terrainHArray[i] = planet.sampleHeight(_worldDir)
    }
    FLOOD_PATCH.geo.attributes.terrainH.needsUpdate = true
  }

  // Orients `mesh` (built from `patch`) so its own center points along
  // `dir`, at the patch's fixed shell radius -- same derivation storms.js
  // relies on (buildPatch's doc comment): a pure rotation of the patch's
  // pre-translate sphere point, so mesh.position + quaternion * localVertex
  // always lands back on the sphere of that fixed radius.
  function orient(mesh, patch, dir) {
    _orientQuat.setFromUnitVectors(patch.centerDir, dir)
    mesh.quaternion.copy(_orientQuat)
    mesh.position.copy(dir).multiplyScalar(patch.radius)
  }

  function update(dt) {
    if (
      typeof storms.getPrimary !== 'function' ||
      typeof planet.sampleHeight !== 'function' ||
      typeof planet.isLand !== 'function'
    ) {
      if (!warnedContract) {
        warnedContract = true
        console.warn('[flood] flood.js: planet/storms API contract mismatch -- floods disabled')
      }
      return
    }

    const strength = storms.getPrimary(_stormDir)
    if (strength > 0) {
      orient(floodMesh, FLOOD_PATCH, _stormDir)
      orient(ringMesh, RING_PATCH, _stormDir)

      anchorTimer += dt
      if (anchorTimer >= ANCHOR_INTERVAL) {
        anchorTimer -= ANCHOR_INTERVAL
        floodActive = strength > LANDFALL_STRENGTH_MIN && landNearby(_stormDir)
        if (floodActive) resampleTerrain(floodMesh.quaternion)
      }
    } else {
      floodActive = false
    }

    // Asymmetric ease: grows over FLOOD_GROW_TIME, drains over the slower
    // FLOOD_DRAIN_TIME once landfall ends -- "temporary", "always heals".
    const riseRate = floodActive ? 1 / FLOOD_GROW_TIME : -1 / FLOOD_DRAIN_TIME
    riseT = clamp(riseT + riseRate * dt, 0, 1)

    // Wet-ground ring tracks the flood while it's present, then lingers on
    // its own much slower RING_LINGER_TIME clock once the flood is fully gone.
    const ringTarget = floodActive || riseT > 0
    const ringRate = ringTarget ? 1 / FLOOD_GROW_TIME : -1 / RING_LINGER_TIME
    ringT = clamp(ringT + ringRate * dt, 0, 1)

    const easedRise = smoothstep(0, 1, riseT)
    floodMat.uFloodLevel.value = SEA_LEVEL + easedRise * FLOOD_RISE_MAX
    floodMat.uOpacity.value = easedRise
    floodMesh.visible = easedRise > 0.001

    const easedRing = smoothstep(0, 1, ringT)
    ringMat.uOpacity.value = easedRing * RING_PEAK_ALPHA
    ringMesh.visible = easedRing > 0.001
  }

  return { group, update }
}
