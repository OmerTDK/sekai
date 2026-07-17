// Breath-of-the-Wild-inspired vegetation: a camera-following patch of
// wind-swept grass blades, a globally-scattered forest, and scattered rocks.
// Everything is derived from `seed` plus the planet's own deterministic
// biome fields, so the same seed + camera path always regrows the same
// world. Four draw calls total -- one InstancedMesh each for grass, trees,
// rocks, and a shared tree/rock ground-contact-shadow blob layer. Trees and
// rocks scatter via a seeded rejection stream upgraded to Poisson-disk
// quality (see createSpacingGrid below): a candidate within a minimum
// angular distance of an already-accepted point of the SAME layer is
// rejected too, so growth stays dense without clumping.
import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { rngFromString, clamp, lerp, smoothstep } from './util.js'

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

// -- grass --
const GRASS_CAPACITY = 70000
const GRASS_PATCH_RADIUS = 0.13 // rad-ish, camera-following patch half-extent
const GRASS_CELL_STEP = GRASS_PATCH_RADIUS * 0.5 // rescatter granularity
const GRASS_GRID_N = 330 // candidate grid resolution across the patch's bounding square
const BLADE_HEIGHT = 0.0018
const BLADE_WIDTH = 0.0004
const BLADE_BEND_AMOUNT = BLADE_HEIGHT * 0.6 // peak tip displacement budget
const GRASS_VISIBLE_DIST = 1.7
const GRASS_FADE_DIST = 1.45
const GRASS_MIN_LAND_T = 0.02
const GRASS_MAX_LAND_T = 0.75
const GRASS_MAX_SLOPE = 0.55
const GRASS_MAX_POLAR = 0.5

const COLOR_GRASS_ROOT = 0x4e7a3c
const COLOR_GRASS_TIP = 0x8fbf63
const COLOR_GRASS_DRY = 0xa8c96a

// -- trees --
const TREE_CAPACITY = 18000
const TREE_TRIES_CAP = 140000
const TREE_HEIGHT = 0.007
const TREE_MIN_MOISTURE = 0.55
const TREE_MIN_LAND_T = 0.05
const TREE_MAX_LAND_T = 0.6
const TREE_MAX_SLOPE = 0.4
const TREE_MAX_POLAR = 0.3
const TREE_MIN_SPACING = 0.006 // rad-ish min gap between accepted trees (Poisson-disk quality) -- forests stay dense but non-clumping

const COLOR_TRUNK = 0x6b4a32
const COLOR_CANOPY_DARK = 0x4a7f45
const COLOR_CANOPY_LIGHT = 0x639855

// -- rocks --
const ROCK_CAPACITY = 6000
const ROCK_TRIES_CAP = 250000
const ROCK_MIN_SCALE = 0.0015
const ROCK_MAX_SCALE = 0.004
const ROCK_MIN_LAND_T = 0.65
const ROCK_MIN_SLOPE = 0.5
const ROCK_MAX_POLAR = 0.6
const ROCK_MIN_SPACING = 0.01 // rad-ish min gap between accepted rocks (Poisson-disk quality)

const COLOR_ROCK = 0x7d766a

// -- tree/rock contact blobs (soft ground-contact shadow; ONE shared
// InstancedMesh for both layers -- 18k+6k per-instance sprites would be a
// draw-call disaster, this is one draw call regardless of instance count) --
const BLOB_CAPACITY = TREE_CAPACITY + ROCK_CAPACITY
const TREE_BLOB_RADIUS = 0.0016
const ROCK_BLOB_RADIUS_MULT = 1.3 // blob reads as a soft shadow just past the rock's own silhouette
const BLOB_NORMAL_OFFSET = 0.0002 // lifted off the terrain along the normal to dodge z-fighting
const COLOR_BLOB = 0x000000

// Small permanent props (trees/rocks) fade out beyond this -- they're tiny
// from space anyway, so a hard visibility toggle (no opacity fade) is fine.
const PROP_VISIBLE_DIST = 3.2

// ---------------------------------------------------------------------------
// Shared scratch (module-level -- nothing below allocates per call, so these
// are safe to reuse across grass/trees/rocks, which build sequentially, not
// concurrently).
// ---------------------------------------------------------------------------
const REF_Y = new THREE.Vector3(0, 1, 0)
const REF_X = new THREE.Vector3(1, 0, 0)
const _t1 = new THREE.Vector3()
const _t2 = new THREE.Vector3()
const _up = new THREE.Vector3()
const _right = new THREE.Vector3()
const _fwd = new THREE.Vector3()
const _pos = new THREE.Vector3()
const _scale = new THREE.Vector3()
const _basis = new THREE.Matrix4()
const _quat = new THREE.Quaternion()
const _mat4 = new THREE.Matrix4()
const _paintColor = new THREE.Color()
const _blobDir = new THREE.Vector3()

/**
 * Composes a "planted" instance matrix into `out`: origin lifted to radius
 * `radius` along unit direction `dir`, local +Y aligned to `dir` (the
 * surface normal), optionally leaned by a small tangent-plane tilt
 * (`tiltX`/`tiltZ`, in "radians-ish" tangent-offset units), then rotated by
 * `yaw` around the (possibly-leaned) up axis, and non-uniformly scaled.
 * Shared by grass/trees/rocks so all three layers plant identically.
 */
function plantedMatrix(out, dir, radius, yaw, tiltX, tiltZ, sx, sy, sz) {
  const ref = Math.abs(dir.y) > 0.95 ? REF_X : REF_Y
  _t1.crossVectors(ref, dir).normalize()
  _t2.crossVectors(dir, _t1).normalize()
  _up.copy(dir)
  if (tiltX !== 0 || tiltZ !== 0) {
    _up.addScaledVector(_t1, tiltX).addScaledVector(_t2, tiltZ).normalize()
    _t1.crossVectors(ref, _up).normalize()
    _t2.crossVectors(_up, _t1).normalize()
  }
  const cosY = Math.cos(yaw)
  const sinY = Math.sin(yaw)
  _right.set(_t1.x * cosY + _t2.x * sinY, _t1.y * cosY + _t2.y * sinY, _t1.z * cosY + _t2.z * sinY)
  _fwd.crossVectors(_right, _up).normalize()
  _right.crossVectors(_up, _fwd).normalize()
  _basis.makeBasis(_right, _up, _fwd)
  _quat.setFromRotationMatrix(_basis)
  _pos.copy(dir).multiplyScalar(radius)
  _scale.set(sx, sy, sz)
  out.compose(_pos, _quat, _scale)
}

/** Deterministic, uniformly-distributed random unit vector, written into `out`. */
function randUnit3(rng, out) {
  const z = rng() * 2 - 1
  const t = rng() * Math.PI * 2
  const r = Math.sqrt(Math.max(0, 1 - z * z))
  return out.set(r * Math.cos(t), r * Math.sin(t), z)
}

/** Paints a single flat color onto every vertex of `geo` (pre-merge part coloring). */
function paintFlatColor(geo, hex) {
  _paintColor.set(hex)
  const n = geo.attributes.position.count
  const arr = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    arr[i * 3] = _paintColor.r
    arr[i * 3 + 1] = _paintColor.g
    arr[i * 3 + 2] = _paintColor.b
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3))
}

// ---------------------------------------------------------------------------
// Poisson-disk-quality spacing grid (trees + rocks; grass is disabled and
// out of scope). Layered on TOP of the existing seeded rejection stream: a
// candidate that already passed every biome check is additionally rejected
// if it falls within `minDist` of an ACCEPTED point of the same layer.
// Accepted points are grid-hashed by quantized direction (cell size ==
// minDist) so a candidate's neighbor check only ever visits the 3x3x3 block
// of cells around it -- O(1) average, never the O(n^2) of scanning every
// prior accept. That 3x3x3 neighborhood is exact, not approximate: two
// points whose cell indices differ by 2+ on any axis are already more than
// `minDist` apart along that axis alone, so nothing outside the block could
// ever be a neighbor. Squared chord (Euclidean) distance stands in for true
// great-circle angular distance -- at these minDist scales (0.006-0.01 rad)
// chord and arc length agree to within ~1e-8 relative error, so no acos()
// is needed. Each builder constructs its own grid from scratch (no shared
// module state across trees/rocks/calls), so the result stays a pure
// function of the candidate stream: same seed -> same accept/reject
// sequence -> same final set, every time.
// ---------------------------------------------------------------------------
function createSpacingGrid(minDist) {
  const invCell = 1 / minDist
  const minDistSq = minDist * minDist
  const cells = new Map()
  const cellKey = (ix, iy, iz) => ix + '_' + iy + '_' + iz

  return {
    /** True if some already-accepted point sits within minDist of (x, y, z). */
    hasNeighbor(x, y, z) {
      const ix = Math.floor(x * invCell)
      const iy = Math.floor(y * invCell)
      const iz = Math.floor(z * invCell)
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dz = -1; dz <= 1; dz++) {
            const bucket = cells.get(cellKey(ix + dx, iy + dy, iz + dz))
            if (!bucket) continue
            for (let i = 0; i < bucket.length; i += 3) {
              const ddx = bucket[i] - x
              const ddy = bucket[i + 1] - y
              const ddz = bucket[i + 2] - z
              if (ddx * ddx + ddy * ddy + ddz * ddz < minDistSq) return true
            }
          }
        }
      }
      return false
    },
    /** Records an accepted point so later candidates are checked against it. */
    insert(x, y, z) {
      const k = cellKey(Math.floor(x * invCell), Math.floor(y * invCell), Math.floor(z * invCell))
      let bucket = cells.get(k)
      if (!bucket) {
        bucket = []
        cells.set(k, bucket)
      }
      bucket.push(x, y, z)
    },
  }
}

// ---------------------------------------------------------------------------
// Grass patch candidate grid: a fixed, distance-sorted set of tangent-plane
// (u, v) offsets covering the patch disk, computed once at module load and
// re-centered on the camera's (quantized) ground point every rescatter.
// Distance-sorted so that if a very lush patch fills GRASS_CAPACITY before
// the list is exhausted, the cut is a smaller concentric circle rather than
// a lopsided clip through the middle of the patch.
// ---------------------------------------------------------------------------
const GRASS_CELL_SIZE = (2 * GRASS_PATCH_RADIUS) / GRASS_GRID_N

function buildPatchOffsets() {
  const half = GRASS_PATCH_RADIUS
  const cell = GRASS_CELL_SIZE
  const pts = []
  for (let i = 0; i < GRASS_GRID_N; i++) {
    const u = -half + (i + 0.5) * cell
    for (let j = 0; j < GRASS_GRID_N; j++) {
      const v = -half + (j + 0.5) * cell
      const d = Math.sqrt(u * u + v * v)
      if (d <= half) pts.push([u, v, d])
    }
  }
  pts.sort((a, b) => a[2] - b[2])
  const arr = new Float32Array(pts.length * 2)
  for (let i = 0; i < pts.length; i++) {
    arr[i * 2] = pts[i][0]
    arr[i * 2 + 1] = pts[i][1]
  }
  return arr
}

const PATCH_OFFSETS = buildPatchOffsets()

// ---------------------------------------------------------------------------
// Silent-fallback rule: every graceful-degradation path warns exactly once
// (module-level flags, since onBeforeCompile can re-run on shader recompile).
// ---------------------------------------------------------------------------
let warnedGrassWind = false
let warnedTreeSway = false
let warnedTreeMerge = false

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------
// User verdict: individual grass blades read as visual noise on this planet's
// scale — disabled, machinery kept in case a future pass revives them.
const GRASS_ENABLED = false

export function createFlora(planet, camera, seed) {
  const grass = GRASS_ENABLED ? buildGrass(planet, camera, seed) : null
  const trees = buildTrees(planet, camera, seed)
  const rocks = buildRocks(planet, camera, seed)
  const blobs = buildContactBlobs(trees, rocks, camera)

  const group = new THREE.Group()
  if (grass) group.add(grass.mesh)
  group.add(trees.mesh, rocks.mesh, blobs.mesh)

  function update(dt) {
    if (grass) grass.update(dt)
    trees.update(dt)
    rocks.update(dt)
    blobs.update(dt)
  }

  return { group, update }
}

// ---------------------------------------------------------------------------
// Grass
// ---------------------------------------------------------------------------
export function buildBladeGeometry() {
  const hw = BLADE_WIDTH / 2
  const tw = BLADE_WIDTH * 0.15 // slightly tapered tip, not a perfect point
  const positions = new Float32Array([
    -hw, 0, 0, // 0 base-left
    hw, 0, 0, // 1 base-right
    tw, BLADE_HEIGHT, 0, // 2 tip-right
    -tw, BLADE_HEIGHT, 0, // 3 tip-left
  ])
  const root = new THREE.Color(COLOR_GRASS_ROOT)
  const tip = new THREE.Color(COLOR_GRASS_TIP)
  const colors = new Float32Array([
    root.r, root.g, root.b,
    root.r, root.g, root.b,
    tip.r, tip.g, tip.b,
    tip.r, tip.g, tip.b,
  ])
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  geo.setIndex([0, 1, 2, 0, 2, 3])
  geo.computeVertexNormals()
  return geo
}

function buildGrass(planet, camera, seed) {
  const bladeGeo = buildBladeGeometry()
  bladeGeo.setAttribute('phase', new THREE.InstancedBufferAttribute(new Float32Array(GRASS_CAPACITY), 1))
  const phaseAttr = bladeGeo.attributes.phase

  const grassMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 1,
    metalness: 0,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 1,
  })

  // Two fixed, seeded "plane wave" directions used purely as a spatial-phase
  // trick: dot(worldPos, dir) turns a 3D position into a traveling-wave
  // phase, so nearby blades (regardless of their own random yaw) share a
  // similar gust amplitude at any given moment -- that's what reads as
  // waves sweeping across the field, even though each blade still bends
  // toward its own local +X.
  const windRng = rngFromString(seed + ':grass:wind')
  const gustDir = new THREE.Vector3()
  const gustDir2 = new THREE.Vector3()
  randUnit3(windRng, gustDir)
  randUnit3(windRng, gustDir2)

  let grassUniforms = null
  grassMat.customProgramCacheKey = () => 'flora-grass-wind-v1'
  grassMat.onBeforeCompile = (shader) => {
    try {
      shader.uniforms.uTime = { value: 0 }
      shader.uniforms.uWindStrength = { value: 1 }
      shader.uniforms.uGustDir = { value: gustDir }
      shader.uniforms.uGustDir2 = { value: gustDir2 }
      shader.vertexShader =
        'uniform float uTime;\nuniform float uWindStrength;\nuniform vec3 uGustDir;\nuniform vec3 uGustDir2;\nattribute float phase;\n' +
        shader.vertexShader
      const patched = shader.vertexShader.replace(
        '#include <begin_vertex>',
        [
          '#include <begin_vertex>',
          `float bladeH = clamp(position.y / ${BLADE_HEIGHT.toFixed(6)}, 0.0, 1.0);`,
          'float bend = bladeH * bladeH;', // bases stay planted, tips move most
          'vec3 worldBase = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;',
          'float gust = 0.6 + 0.4 * sin(dot(worldBase, uGustDir) * 180.0 + uTime * 2.2 + phase * 0.5);',
          'gust += 0.25 * sin(dot(worldBase, uGustDir2) * 55.0 + uTime * 0.7 + phase * 0.3);', // slower, broader layer
          `transformed.x += bend * gust * uWindStrength * ${BLADE_BEND_AMOUNT.toFixed(6)};`,
        ].join('\n')
      )
      if (patched === shader.vertexShader) throw new Error('flora.js: grass shader injection point not found')
      shader.vertexShader = patched
      grassUniforms = shader.uniforms
    } catch (err) {
      grassUniforms = null // fall back to static grass
      if (!warnedGrassWind) {
        warnedGrassWind = true
        console.warn('[planet] flora.js: grass wind animation degraded — onBeforeCompile shader injection failed, blades render static: ' + err)
      }
    }
  }

  const grassMesh = new THREE.InstancedMesh(bladeGeo, grassMat, GRASS_CAPACITY)
  grassMesh.count = 0
  grassMesh.visible = false

  // -- scatter state --
  const biome = {}
  const dir = new THREE.Vector3()
  const gT1 = new THREE.Vector3()
  const gT2 = new THREE.Vector3()
  const quantAnchor = new THREE.Vector3()
  const camDir = new THREE.Vector3()
  const instColor = new THREE.Color()
  let lastQx = Infinity
  let lastQy = Infinity
  let lastQz = Infinity

  // Ratio that would turn the baked tip color into the dry target color
  // under multiplication -- used to nudge (not replace) instanceColor
  // toward a khaki/dry hue in low-moisture spots, layered under the plain
  // +/-10% value jitter every blade gets.
  const tipC = new THREE.Color(COLOR_GRASS_TIP)
  const dryC = new THREE.Color(COLOR_GRASS_DRY)
  const dryMulR = dryC.r / tipC.r
  const dryMulG = dryC.g / tipC.g
  const dryMulB = dryC.b / tipC.b

  // ponytail: this rebuilds the whole patch in one synchronous pass (up to
  // ~85k candidate probes). Spec calls a one-frame hitch on rescatter
  // acceptable, so this is left as one pass; chunking the scatter across a
  // handful of frames is the upgrade path if the hitch is ever noticeable.
  function scatterPatch(anchorDir, cellKey) {
    const rng = rngFromString(seed + ':grass:' + cellKey)
    const ref = Math.abs(anchorDir.y) > 0.95 ? REF_X : REF_Y
    gT1.crossVectors(ref, anchorDir).normalize()
    gT2.crossVectors(anchorDir, gT1).normalize()

    let count = 0
    for (let k = 0; k < PATCH_OFFSETS.length && count < GRASS_CAPACITY; k++) {
      const u = PATCH_OFFSETS[k * 2]
      const v = PATCH_OFFSETS[k * 2 + 1]
      dir.copy(anchorDir).addScaledVector(gT1, u).addScaledVector(gT2, v).normalize()

      if (!planet.isLand(dir)) continue
      planet.biomeAt(dir, biome)
      if (biome.landT < GRASS_MIN_LAND_T || biome.landT > GRASS_MAX_LAND_T) continue
      if (biome.slope >= GRASS_MAX_SLOPE) continue
      if (biome.polar >= GRASS_MAX_POLAR) continue

      const density = 0.15 + 0.85 * biome.moisture // sparse-but-present in dry spots, lush when wet
      if (rng() > density) continue

      const yaw = rng() * Math.PI * 2
      const tiltMag = rng() * 0.1
      const tiltAng = rng() * Math.PI * 2
      const tiltX = Math.cos(tiltAng) * tiltMag
      const tiltZ = Math.sin(tiltAng) * tiltMag
      const scale = 0.7 + rng() * 0.7
      // jitter within the cell so the underlying grid doesn't read as a grid
      const jx = (rng() - 0.5) * GRASS_CELL_SIZE
      const jz = (rng() - 0.5) * GRASS_CELL_SIZE
      dir.addScaledVector(gT1, jx).addScaledVector(gT2, jz).normalize()

      const h = planet.sampleHeight(dir)
      plantedMatrix(_mat4, dir, h, yaw, tiltX, tiltZ, scale, scale, scale)
      grassMesh.setMatrixAt(count, _mat4)

      const valueJitter = 0.9 + rng() * 0.2 // +/-10%
      const dryT = clamp((0.55 - biome.moisture) / 0.55, 0, 1) * 0.4 // "slight" -> capped blend
      instColor.setRGB(
        lerp(1, dryMulR, dryT) * valueJitter,
        lerp(1, dryMulG, dryT) * valueJitter,
        lerp(1, dryMulB, dryT) * valueJitter
      )
      grassMesh.setColorAt(count, instColor)
      phaseAttr.array[count] = rng() * Math.PI * 2

      count++
    }

    grassMesh.count = count
    grassMesh.instanceMatrix.needsUpdate = true
    if (grassMesh.instanceColor) grassMesh.instanceColor.needsUpdate = true
    phaseAttr.needsUpdate = true
    grassMesh.computeBoundingSphere()
  }

  // Quantizes the camera's ground direction to a coarse voxel grid (step ~
  // half the patch radius) so the patch only rescatters in discrete jumps,
  // and the same cell always reproduces the same patch (deterministic).
  function maybeRescatter() {
    camDir.copy(camera.position).normalize()
    const qx = Math.round(camDir.x / GRASS_CELL_STEP)
    const qy = Math.round(camDir.y / GRASS_CELL_STEP)
    const qz = Math.round(camDir.z / GRASS_CELL_STEP)
    if (qx === lastQx && qy === lastQy && qz === lastQz) return
    lastQx = qx
    lastQy = qy
    lastQz = qz
    quantAnchor.set(qx * GRASS_CELL_STEP, qy * GRASS_CELL_STEP, qz * GRASS_CELL_STEP).normalize()
    scatterPatch(quantAnchor, qx + '_' + qy + '_' + qz)
  }

  let elapsed = 0
  function update(dt) {
    const camDist = camera.position.length()
    if (camDist >= GRASS_VISIBLE_DIST + 0.05) {
      grassMesh.visible = false
      return
    }
    grassMesh.visible = true
    elapsed += dt
    if (grassUniforms) {
      grassUniforms.uTime.value = elapsed
      grassUniforms.uWindStrength.value = 0.85 + 0.15 * Math.sin(elapsed * 0.15) // slow "breathing" gust strength
    }
    const fadeT = smoothstep(GRASS_FADE_DIST, GRASS_VISIBLE_DIST, camDist)
    grassMat.opacity = 1 - fadeT
    maybeRescatter()
  }

  return { mesh: grassMesh, update }
}

// ---------------------------------------------------------------------------
// Trees
// ---------------------------------------------------------------------------
export function buildTreeGeometry() {
  const trunkTopR = 0.05
  const trunkBottomR = 0.078
  const trunkH = 0.42
  const trunkGeo = new THREE.CylinderGeometry(trunkTopR, trunkBottomR, trunkH, 6)
  trunkGeo.translate(0, trunkH / 2, 0) // base at y=0
  paintFlatColor(trunkGeo, COLOR_TRUNK)

  const lowR = 0.3
  const lowY = trunkH + lowR * 0.65
  const canopyLowGeo = new THREE.IcosahedronGeometry(lowR, 0)
  canopyLowGeo.translate(0, lowY, 0)
  paintFlatColor(canopyLowGeo, COLOR_CANOPY_DARK)

  const highR = 0.22
  const highY = lowY + lowR * 0.55
  const canopyHighGeo = new THREE.IcosahedronGeometry(highR, 0)
  canopyHighGeo.translate(0, highY, 0)
  paintFlatColor(canopyHighGeo, COLOR_CANOPY_LIGHT)

  const unitHeight = highY + highR
  // mergeGeometries refuses mixed indexing (and silently shipped canopy-less
  // stump trees). Different three versions index these primitives
  // differently, so force ALL parts non-indexed — toNonIndexed() is a no-op
  // (plus a console warn) on geometry that already qualifies.
  const parts = [trunkGeo, canopyLowGeo, canopyHighGeo].map((g) => (g.index ? g.toNonIndexed() : g))
  const merged = mergeGeometries(parts, false)
  if (!merged && !warnedTreeMerge) {
    warnedTreeMerge = true
    console.warn('[planet] flora.js: tree geometry merge degraded — mergeGeometries failed, shipping trunk-only stump geometry (canopy lost)')
  }
  return { geo: merged || trunkGeo, unitHeight }
}

function buildTrees(planet, camera, seed) {
  const { geo: treeGeo, unitHeight } = buildTreeGeometry()
  treeGeo.setAttribute('treePhase', new THREE.InstancedBufferAttribute(new Float32Array(TREE_CAPACITY), 1))
  const phaseAttr = treeGeo.attributes.treePhase

  const treeMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    flatShading: true,
    roughness: 0.92,
    metalness: 0,
  })

  // Subtle canopy+trunk wobble, proportional to height above the base so the
  // planted foot never moves; OPTIONAL per spec, guarded the same way as the
  // grass wind shader so a failed injection just leaves trees static.
  let treeUniforms = null
  treeMat.customProgramCacheKey = () => 'flora-tree-sway-v1'
  treeMat.onBeforeCompile = (shader) => {
    try {
      shader.uniforms.uTime = { value: 0 }
      shader.vertexShader = 'uniform float uTime;\nattribute float treePhase;\n' + shader.vertexShader
      const patched = shader.vertexShader.replace(
        '#include <begin_vertex>',
        [
          '#include <begin_vertex>',
          `float swayT = clamp(position.y / ${unitHeight.toFixed(6)}, 0.0, 1.0);`,
          'float sway = swayT * swayT;',
          'float wob = sin(uTime * 1.1 + treePhase) * 0.045;', // treePhase is already in radians ([0, 2pi))
          'transformed.x += sway * wob;',
          'transformed.z += sway * wob * 0.7;',
        ].join('\n')
      )
      if (patched === shader.vertexShader) throw new Error('flora.js: tree shader injection point not found')
      shader.vertexShader = patched
      treeUniforms = shader.uniforms
    } catch (err) {
      treeUniforms = null // fall back to static trees
      if (!warnedTreeSway) {
        warnedTreeSway = true
        console.warn('[planet] flora.js: tree sway animation degraded — onBeforeCompile shader injection failed, trees render static: ' + err)
      }
    }
  }

  const treeMesh = new THREE.InstancedMesh(treeGeo, treeMat, TREE_CAPACITY)
  treeMesh.count = 0
  treeMesh.visible = false

  const rng = rngFromString(seed + ':trees')
  const dir = new THREE.Vector3()
  const biome = {}
  const spacing = createSpacingGrid(TREE_MIN_SPACING)
  // Contact-blob data, collected in lockstep with accepted trees so the
  // blob layer reuses these exact directions/heights -- never recomputed,
  // never drifts from where the tree itself actually landed.
  const blobDirX = new Float32Array(TREE_CAPACITY)
  const blobDirY = new Float32Array(TREE_CAPACITY)
  const blobDirZ = new Float32Array(TREE_CAPACITY)
  const blobGroundH = new Float32Array(TREE_CAPACITY)
  const blobRadius = new Float32Array(TREE_CAPACITY).fill(TREE_BLOB_RADIUS)
  let count = 0
  for (let tries = 0; tries < TREE_TRIES_CAP && count < TREE_CAPACITY; tries++) {
    randUnit3(rng, dir)
    if (!planet.isLand(dir)) continue
    planet.biomeAt(dir, biome)
    if (biome.moisture <= TREE_MIN_MOISTURE) continue
    if (biome.landT < TREE_MIN_LAND_T || biome.landT > TREE_MAX_LAND_T) continue
    if (biome.slope >= TREE_MAX_SLOPE) continue
    if (biome.polar >= TREE_MAX_POLAR) continue
    // Poisson-disk-quality spacing: reject candidates too close to an
    // already-accepted tree of this same layer (grid-hash lookup, O(1)).
    if (spacing.hasNeighbor(dir.x, dir.y, dir.z)) continue

    const yaw = rng() * Math.PI * 2
    const scale = TREE_HEIGHT * (0.7 + rng() * 0.6) // +/-30%
    const groundH = planet.sampleHeight(dir)
    const h = groundH - 0.0004 // sink the base slightly so it never floats
    plantedMatrix(_mat4, dir, h, yaw, 0, 0, scale, scale, scale)
    treeMesh.setMatrixAt(count, _mat4)
    phaseAttr.array[count] = rng() * Math.PI * 2

    spacing.insert(dir.x, dir.y, dir.z)
    blobDirX[count] = dir.x
    blobDirY[count] = dir.y
    blobDirZ[count] = dir.z
    blobGroundH[count] = groundH
    count++
  }
  treeMesh.count = count
  treeMesh.instanceMatrix.needsUpdate = true
  phaseAttr.needsUpdate = true
  if (count > 0) treeMesh.computeBoundingSphere()

  let elapsed = 0
  function update(dt) {
    const camDist = camera.position.length()
    treeMesh.visible = camDist < PROP_VISIBLE_DIST
    if (!treeMesh.visible) return
    elapsed += dt
    if (treeUniforms) treeUniforms.uTime.value = elapsed
  }

  return {
    mesh: treeMesh,
    update,
    blobData: { count, dirX: blobDirX, dirY: blobDirY, dirZ: blobDirZ, groundH: blobGroundH, radius: blobRadius },
  }
}

// ---------------------------------------------------------------------------
// Rocks
// ---------------------------------------------------------------------------
export function buildRockGeometry() {
  const rockGeo = new THREE.DodecahedronGeometry(1, 0)
  paintFlatColor(rockGeo, COLOR_ROCK)
  return rockGeo
}

function buildRocks(planet, camera, seed) {
  const rockGeo = buildRockGeometry()

  const rockMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    flatShading: true,
    roughness: 1,
    metalness: 0,
  })

  const rockMesh = new THREE.InstancedMesh(rockGeo, rockMat, ROCK_CAPACITY)
  rockMesh.count = 0
  rockMesh.visible = false

  const rng = rngFromString(seed + ':rocks')
  const dir = new THREE.Vector3()
  const biome = {}
  const instColor = new THREE.Color()
  const spacing = createSpacingGrid(ROCK_MIN_SPACING)
  // Contact-blob data, collected in lockstep with accepted rocks (see the
  // matching comment in buildTrees above).
  const blobDirX = new Float32Array(ROCK_CAPACITY)
  const blobDirY = new Float32Array(ROCK_CAPACITY)
  const blobDirZ = new Float32Array(ROCK_CAPACITY)
  const blobGroundH = new Float32Array(ROCK_CAPACITY)
  const blobRadius = new Float32Array(ROCK_CAPACITY)
  let count = 0
  for (let tries = 0; tries < ROCK_TRIES_CAP && count < ROCK_CAPACITY; tries++) {
    randUnit3(rng, dir)
    if (!planet.isLand(dir)) continue
    planet.biomeAt(dir, biome)
    if (biome.slope <= ROCK_MIN_SLOPE && biome.landT <= ROCK_MIN_LAND_T) continue // needs slope>0.5 OR landT>0.65
    if (biome.polar >= ROCK_MAX_POLAR) continue
    // Poisson-disk-quality spacing: reject candidates too close to an
    // already-accepted rock of this same layer (grid-hash lookup, O(1)).
    if (spacing.hasNeighbor(dir.x, dir.y, dir.z)) continue

    const yaw = rng() * Math.PI * 2
    const tiltMag = rng() * 0.3 // rocks settle at odd angles more readily than trees
    const tiltAng = rng() * Math.PI * 2
    const tiltX = Math.cos(tiltAng) * tiltMag
    const tiltZ = Math.sin(tiltAng) * tiltMag
    const base = lerp(ROCK_MIN_SCALE, ROCK_MAX_SCALE, rng())
    const sx = base * (0.8 + rng() * 0.4)
    const sy = base * (0.8 + rng() * 0.4)
    const sz = base * (0.8 + rng() * 0.4)
    const h = planet.sampleHeight(dir)
    plantedMatrix(_mat4, dir, h, yaw, tiltX, tiltZ, sx, sy, sz)
    rockMesh.setMatrixAt(count, _mat4)

    const jitter = 0.85 + rng() * 0.3
    instColor.setRGB(jitter, jitter * (0.97 + rng() * 0.06), jitter * (0.97 + rng() * 0.06))
    rockMesh.setColorAt(count, instColor)

    spacing.insert(dir.x, dir.y, dir.z)
    blobDirX[count] = dir.x
    blobDirY[count] = dir.y
    blobDirZ[count] = dir.z
    blobGroundH[count] = h
    blobRadius[count] = base * ROCK_BLOB_RADIUS_MULT
    count++
  }
  rockMesh.count = count
  rockMesh.instanceMatrix.needsUpdate = true
  if (rockMesh.instanceColor) rockMesh.instanceColor.needsUpdate = true
  if (count > 0) rockMesh.computeBoundingSphere()

  function update() {
    rockMesh.visible = camera.position.length() < PROP_VISIBLE_DIST
  }

  return {
    mesh: rockMesh,
    update,
    blobData: { count, dirX: blobDirX, dirY: blobDirY, dirZ: blobDirZ, groundH: blobGroundH, radius: blobRadius },
  }
}

// ---------------------------------------------------------------------------
// Tree/rock contact blobs -- a soft dark ground-contact shadow under every
// tree and large rock. NOT per-instance sprites (18k+6k sprites would be a
// draw-call disaster); instead ONE shared InstancedMesh of tiny flat circle
// geometry, reusing the exact directions/heights buildTrees/buildRocks
// already collected above (see each function's blobData return field) so
// placement can never drift from where the tree/rock itself landed.
// ---------------------------------------------------------------------------
export function buildBlobGeometry() {
  const geo = new THREE.CircleGeometry(1, 8) // unit radius (per-instance scaled); 8-segment, low-poly
  geo.rotateX(-Math.PI / 2) // lie flat: default +Z-facing circle -> +Y-facing (matches plantedMatrix's "local +Y = surface normal" basis)
  return geo
}

function buildContactBlobs(treesResult, rocksResult, camera) {
  const blobGeo = buildBlobGeometry()

  const blobMat = new THREE.MeshBasicMaterial({
    color: COLOR_BLOB,
    transparent: true,
    opacity: 0.28,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  })

  const blobMesh = new THREE.InstancedMesh(blobGeo, blobMat, BLOB_CAPACITY)
  blobMesh.count = 0
  blobMesh.visible = false

  let count = 0
  for (const src of [treesResult.blobData, rocksResult.blobData]) {
    for (let i = 0; i < src.count; i++) {
      _blobDir.set(src.dirX[i], src.dirY[i], src.dirZ[i])
      const r = src.groundH[i] + BLOB_NORMAL_OFFSET
      const br = src.radius[i]
      // yaw is irrelevant for a rotationally-symmetric circle; tilt stays 0
      // so every blob lies flat on its own local tangent plane regardless
      // of whether the rock above it settled at an angle.
      plantedMatrix(_mat4, _blobDir, r, 0, 0, 0, br, 1, br)
      blobMesh.setMatrixAt(count, _mat4)
      count++
    }
  }
  blobMesh.count = count
  blobMesh.instanceMatrix.needsUpdate = true
  if (count > 0) blobMesh.computeBoundingSphere()

  function update() {
    blobMesh.visible = camera.position.length() < PROP_VISIBLE_DIST
  }

  return { mesh: blobMesh, update }
}
