// Decayed ancient-ruin props: crumbled wall segments, a snapped column, and
// an overgrown rubble mound, scattered at seeded ancient sites that are
// independent of -- and never overlap/destroy -- session settlements (THE
// COVENANT: purely additive, static, and pre-existing). One merged low-poly
// "ruin kit" (walls + column + rubble) is instanced across ~12 seeded sites,
// ~4-6 pieces per site, one draw call total. Mirrors flora.js's
// buildTreeGeometry/plantedMatrix/randUnit3/paintFlatColor/createSpacingGrid
// idioms (copied here rather than imported -- flora.js does not export
// them, and this module must stay self-contained).
import * as THREE from 'three/webgpu'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { rngFromString, clamp, lerp } from './util.js'

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------
const RUIN_SITE_MAX = 12
const PIECES_PER_SITE = 6 // per-site cap; actual count varies 4..6 (seeded)
const PIECES_MIN = 4
const RUIN_CAPACITY = RUIN_SITE_MAX * PIECES_PER_SITE

const SITE_TRIES_CAP = 6000
const SITE_MIN_SPACING = 0.05 // rad -- keeps sites from clumping (Poisson-disk quality)
const SITE_MAX_SLOPE = 0.45
const SITE_MAX_POLAR = 0.4
const SITE_MIN_LAND_T = 0.05
const SITE_MAX_LAND_T = 0.6

const PIECE_SPREAD_RAD = 0.01 // rad -- how far pieces scatter from the site center
const RUIN_SCALE_BASE = 0.012 // world-space scale of one ruin-kit instance (tree/building scale band)
const RUIN_SINK = 0.0004 // sink the footprint slightly so it never floats over terrain
const RUIN_TILT_MAX = 0.12 // rad-ish max terrain-conforming lean

const COLOR_WALL = 0x8a857a
const COLOR_COLUMN = 0x9a938a
const COLOR_RUBBLE = 0x6f7d55

// ---------------------------------------------------------------------------
// Shared scratch (module-level; ruins build once at startup, never
// concurrently, so reuse across helpers is safe).
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
// Dedicated site-tangent scratch, kept SEPARATE from plantedMatrix's
// internal _t1/_t2 above -- plantedMatrix overwrites those on every call, so
// reusing them here for the site's tangent basis (which must survive across
// an entire site's piece loop, spanning multiple plantedMatrix calls) would
// silently corrupt every piece after the first.
const _siteT1 = new THREE.Vector3()
const _siteT2 = new THREE.Vector3()

// Copied from flora.js -- composes a "planted" instance matrix into `out`:
// origin lifted to radius `radius` along unit direction `dir`, local +Y
// aligned to `dir` (the surface normal), optionally leaned by a small
// tangent-plane tilt (`tiltX`/`tiltZ`), rotated by `yaw` around the
// (possibly-leaned) up axis, and non-uniformly scaled.
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

// Copied from flora.js -- deterministic, uniformly-distributed random unit
// vector, written into `out`.
function randUnit3(rng, out) {
  const z = rng() * 2 - 1
  const t = rng() * Math.PI * 2
  const r = Math.sqrt(Math.max(0, 1 - z * z))
  return out.set(r * Math.cos(t), r * Math.sin(t), z)
}

// Copied from flora.js -- paints a single flat color onto every vertex of
// `geo` (pre-merge part coloring).
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

// Copied from flora.js -- Poisson-disk-quality spacing grid. A candidate is
// rejected if it falls within `minDist` of an already-accepted point,
// checked via a 3x3x3 grid-hash neighborhood (O(1) average). Squared chord
// distance stands in for true great-circle angular distance -- at these
// minDist scales the two agree closely enough that no acos() is needed.
function createSpacingGrid(minDist) {
  const invCell = 1 / minDist
  const minDistSq = minDist * minDist
  const cells = new Map()
  const cellKey = (ix, iy, iz) => ix + '_' + iy + '_' + iz

  return {
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
// Geometry: one merged "ruin kit" -- 3 broken wall segments, a snapped
// column, and a low overgrown rubble mound, laid out around a local origin
// so a single instanced kit already reads as a small collapsed structure.
// Each part's translate/rotate calls compose about the geometry's own local
// origin (0,0,0) in sequence, so translating a part's base to y=0 BEFORE
// rotating it tilts/yaws it about its own base pivot (a "leaning wall" /
// "snapped column" look), then the final translate moves the whole
// already-tilted part to its position within the kit.
// ---------------------------------------------------------------------------
let warnedRuinMerge = false

export function buildRuinKitGeometry() {
  const parts = []

  const wallDefs = [
    { x: -0.34, z: 0.1, w: 0.52, h: 0.5, d: 0.09, rotY: 0.18, tiltZ: 0.05 },
    { x: 0.3, z: -0.1, w: 0.4, h: 0.3, d: 0.08, rotY: -0.4, tiltZ: -0.14 },
    { x: 0.0, z: 0.36, w: 0.32, h: 0.18, d: 0.08, rotY: 1.1, tiltZ: 0.1 },
  ]
  for (const w of wallDefs) {
    const g = new THREE.BoxGeometry(w.w, w.h, w.d)
    g.translate(0, w.h / 2, 0)
    g.rotateZ(w.tiltZ)
    g.rotateY(w.rotY)
    g.translate(w.x, 0, w.z)
    paintFlatColor(g, COLOR_WALL)
    parts.push(g)
  }

  const colH = 0.46
  const column = new THREE.CylinderGeometry(0.045, 0.065, colH, 8)
  column.translate(0, colH / 2, 0)
  column.rotateZ(0.14) // "snapped" lean
  column.translate(-0.06, 0, -0.32)
  paintFlatColor(column, COLOR_COLUMN)
  parts.push(column)

  const rubbleR = 0.22
  const rubble = new THREE.IcosahedronGeometry(rubbleR, 0)
  rubble.scale(1, 0.5, 1) // squash into a low mound
  rubble.translate(0, rubbleR * 0.5, 0) // rest base near y=0
  rubble.translate(0.2, 0, 0.02)
  paintFlatColor(rubble, COLOR_RUBBLE)
  parts.push(rubble)

  // mergeGeometries refuses mixed indexing -- force every part non-indexed
  // (toNonIndexed() is a no-op, plus a console warn, on geometry that
  // already qualifies) before merging, mirroring flora.js buildTreeGeometry.
  const nonIndexed = parts.map((g) => (g.index ? g.toNonIndexed() : g))
  const merged = mergeGeometries(nonIndexed, false)
  if (!merged && !warnedRuinMerge) {
    warnedRuinMerge = true
    console.warn(
      '[planet] ruins.js: ruin-kit geometry merge degraded — mergeGeometries failed, shipping wall-only fallback (column/rubble lost)',
    )
  }
  return merged || nonIndexed[0]
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------
export function createRuins(planet, seed) {
  const kitGeo = buildRuinKitGeometry()

  const mat = new THREE.MeshStandardNodeMaterial({
    vertexColors: true,
    flatShading: true,
    roughness: 1,
    metalness: 0,
  })

  const mesh = new THREE.InstancedMesh(kitGeo, mat, RUIN_CAPACITY)
  mesh.count = 0

  // -- seeded rejection loop over site candidates, spaced with a Poisson-
  // disk-quality grid so ruins never clump -- see createSpacingGrid above.
  const siteRng = rngFromString(seed + ':ruins:sites')
  const siteDir = new THREE.Vector3()
  const pieceDir = new THREE.Vector3()
  const biome = {}
  const siteSpacing = createSpacingGrid(SITE_MIN_SPACING)
  const instColor = new THREE.Color()

  let siteCount = 0
  let pieceCount = 0
  for (
    let tries = 0;
    tries < SITE_TRIES_CAP && siteCount < RUIN_SITE_MAX && pieceCount < RUIN_CAPACITY;
    tries++
  ) {
    randUnit3(siteRng, siteDir)
    if (!planet.isLand(siteDir)) continue
    planet.biomeAt(siteDir, biome)
    if (biome.slope > SITE_MAX_SLOPE) continue
    if (biome.polar > SITE_MAX_POLAR) continue
    if (biome.landT < SITE_MIN_LAND_T || biome.landT > SITE_MAX_LAND_T) continue
    // Poisson-disk-quality spacing between SITES (not pieces): reject a
    // candidate site too close to an already-accepted one.
    if (siteSpacing.hasNeighbor(siteDir.x, siteDir.y, siteDir.z)) continue

    siteSpacing.insert(siteDir.x, siteDir.y, siteDir.z)
    const siteIndex = siteCount
    siteCount++

    // Tangent basis at the site center, used to scatter this site's pieces
    // on small tangent-plane offsets around it. Must stay untouched across
    // the whole piece loop below, so it uses _siteT1/_siteT2, NOT
    // plantedMatrix's internal _t1/_t2 scratch (see the declaration above).
    const ref = Math.abs(siteDir.y) > 0.95 ? REF_X : REF_Y
    _siteT1.crossVectors(ref, siteDir).normalize()
    _siteT2.crossVectors(siteDir, _siteT1).normalize()

    // Deterministic per-site stream -- piece count, offsets, yaw/tilt/scale,
    // and overgrowth tint all pulled from here (Determinism: rngFromString
    // seed+':ruins:site:'+siteIndex).
    const pieceRng = rngFromString(seed + ':ruins:site:' + siteIndex)
    const pieceN = PIECES_MIN + Math.floor(pieceRng() * (PIECES_PER_SITE - PIECES_MIN + 1))

    for (let p = 0; p < pieceN && pieceCount < RUIN_CAPACITY; p++) {
      const ang = pieceRng() * Math.PI * 2
      const rad = Math.sqrt(pieceRng()) * PIECE_SPREAD_RAD // sqrt for a uniform-density disk, not center-heavy
      pieceDir
        .copy(siteDir)
        .addScaledVector(_siteT1, Math.cos(ang) * rad)
        .addScaledVector(_siteT2, Math.sin(ang) * rad)
        .normalize()

      const yaw = pieceRng() * Math.PI * 2
      const tiltMag = pieceRng() * RUIN_TILT_MAX
      const tiltAng = pieceRng() * Math.PI * 2
      const tiltX = Math.cos(tiltAng) * tiltMag
      const tiltZ = Math.sin(tiltAng) * tiltMag
      const scale = RUIN_SCALE_BASE * lerp(0.75, 1.35, pieceRng())

      const groundH = planet.sampleHeight(pieceDir)
      const h = groundH - RUIN_SINK
      plantedMatrix(_mat4, pieceDir, h, yaw, tiltX, tiltZ, scale, scale, scale)
      mesh.setMatrixAt(pieceCount, _mat4)

      // Seeded overgrowth tint -- a value jitter nudged toward a mossy hue,
      // multiplying the baked flat wall/column/rubble vertex colors.
      const valueJitter = 0.82 + pieceRng() * 0.3
      const overgrowth = pieceRng()
      instColor.setRGB(
        clamp(valueJitter * lerp(1, 0.88, overgrowth * 0.5), 0, 1.2),
        clamp(valueJitter * lerp(1, 1.05, overgrowth * 0.5), 0, 1.2),
        clamp(valueJitter * lerp(1, 0.85, overgrowth * 0.4), 0, 1.2),
      )
      mesh.setColorAt(pieceCount, instColor)

      pieceCount++
    }
  }

  mesh.count = pieceCount
  mesh.instanceMatrix.needsUpdate = true
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
  if (pieceCount > 0) mesh.computeBoundingSphere()

  const group = new THREE.Group()
  group.add(mesh)

  // Static and purely additive (THE COVENANT): ruins are ancient,
  // pre-existing props seeded independently of sessions -- they never move,
  // never destroy/overwrite a session structure, and carry no animated
  // uniforms. The module contract's update(dt) receives no camera (see
  // main.js wiring, which calls ruins.update(dt) alongside the other
  // per-frame updates), so there is no distance to cull against here; ruins
  // are tiny from orbit anyway, same as flora.js's small permanent props.
  function update() {}

  return { group, update }
}
