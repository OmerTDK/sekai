// M2 asset pipeline: loads the Kenney/Quaternius kit parts named in
// buildings.js's recipe tables, merges each (type, tier) recipe into static
// geometry, and renders every structure in the world from just TWO
// THREE.BatchedMesh draw calls (one matte-tinted class, one brass-metal
// class) instead of one THREE.Mesh per building part. See the M2 program
// plan (§0.5 art direction, S4/S5 spike results) and spikes/s4, spikes/s5.
//
// Contract (world.js builds against this exactly):
//   const assets = await loadBuildingAssets(renderer)
//   if (assets.ready) {
//     const { handle, boundingRadius } = assets.createStructureVisual(type, tier, race, seedStr)
//     assets.setVisualMatrix(handle, matrix4)   // full world matrix: position * rotation * scale
//     assets.setVisualVisible(handle, bool)
//     assets.removeVisual(handle)
//     scene.add(assets.group)                   // THREE.Group holding the BatchedMesh(es)
//     assets.update(dt)                         // per-frame env/anim upkeep
//   }
// If loading fails for any reason, loadBuildingAssets() resolves (never
// rejects) to { ready: false } and the caller falls back to buildKit() from
// buildings.js — the procedural kit builders stay fully intact for exactly
// this reason (see buildings.js's own comment on this).
//
// SIZING NOTE (the one contract detail that isn't visible in the function
// signatures, called out per the "flag deviations loudly" instruction):
// every merged (type, tier) recipe is normalized to the SAME "roughly 1 unit
// tall" authored-space convention buildTower/buildHall/etc. already use in
// buildings.js, and boundingRadius is reported in that same authored space —
// NOT world units. The caller still owns KIT_UNIT_SIZE[type] * TIER_MULT[tier-1]
// (both still exported from buildings.js, untouched) and bakes that scale
// into the matrix4 passed to setVisualMatrix, exactly as it does today for
// buildKit()'s output. This keeps sizing tuned in exactly one place for BOTH
// the asset path and the procedural fallback, rather than baking a second,
// independent size system into this file.
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { hash01 } from './util.js'
import {
  RACE_PALETTES,
  ASSET_BASE,
  ROLE_COLOR,
  TINTABLE_ROLES,
  KENNEY_PART_ROLES,
  KENNEY_DEFAULT_ROLE,
  MATERIAL_NAME_ROLES,
  KIT_RECIPES,
  GRAND_RECIPES,
  BOLT_ON_KINDS_BY_RACE,
  BOLT_ON_SECOND_GEAR_RACES,
} from './buildings.js'

const STRUCTURE_TYPES = Object.keys(KIT_RECIPES)

// Steampunk bolt-on palette — exact accent hex from the program plan §0.5.
const BRASS = 0xb0793a
const COPPER = 0xc98d4a
const BRONZE = 0x5e7d6a
const WHITE_COLOR = new THREE.Color(1, 1, 1)

// Bolt-on part sizes are fixed absolutes (not derived from the bounding box)
// because every recipe is normalized to the same authored unit height below
// — a fixed size is already proportionally consistent across every type.
// Tier only scales them up further (bigger machinery on grander buildings).
// Sizes below are FRACTIONS of anchors.scaleRef (the recipe's own narrow-axis
// footprint, see deriveAnchors), not absolute authored units — verified in
// spikes/m2-assets that absolute sizing put a giant tank/gear on any recipe
// narrower than "average" (worst case: the compact tier-3 Quaternius shell,
// where a fixed-size tank rendered as a blimp dwarfing the whole building).
const TIER_BOLT_SCALE = { 1: 1, 2: 1, 3: 1.4 }
const GEAR_RADIUS = 0.26
const TANK_RADIUS = 0.07
const TANK_LENGTH = 0.16
const PIPE_RADIUS = 0.05

// ---------------------------------------------------------------------------
// Small geometry-authoring helpers
// ---------------------------------------------------------------------------

function stripToPositionNormal(geometry) {
  for (const key of Object.keys(geometry.attributes)) {
    if (key !== 'position' && key !== 'normal') geometry.deleteAttribute(key)
  }
  return geometry
}

function bakeVertexColor(geometry, hex) {
  const c = new THREE.Color(hex)
  const n = geometry.attributes.position.count
  const arr = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    arr[i * 3] = c.r
    arr[i * 3 + 1] = c.g
    arr[i * 3 + 2] = c.b
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(arr, 3))
  return geometry
}

function coloredGeo(geometry, hex) {
  stripToPositionNormal(geometry)
  bakeVertexColor(geometry, hex)
  return geometry
}

function unionBox(geoms) {
  const box = new THREE.Box3()
  for (const g of geoms) {
    if (!g) continue
    g.computeBoundingBox()
    box.union(g.boundingBox)
  }
  if (box.isEmpty()) box.set(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0.001, 0.001, 0.001))
  return box
}

function roleForFilename(filename) {
  const lower = filename.toLowerCase()
  for (const [substr, role] of KENNEY_PART_ROLES) {
    if (lower.includes(substr)) return role
  }
  return KENNEY_DEFAULT_ROLE
}

function roleForMaterialName(name, fallback) {
  if (name) {
    for (const [substr, role] of MATERIAL_NAME_ROLES) {
      if (name.includes(substr)) return role
    }
  }
  return fallback
}

// ---------------------------------------------------------------------------
// Part loading — one GLTFLoader, cache each unique file's geometry+role list
// by URL (module-level: safe to share across loadBuildingAssets() calls,
// it's an immutable cache of parsed geometry, never mutated after caching).
// ---------------------------------------------------------------------------

const gltfLoader = new GLTFLoader()
const partCache = new Map()

function loadPartMeshes(vendor, filename) {
  const url = ASSET_BASE + vendor + '/' + filename
  let pending = partCache.get(url)
  if (pending) return pending
  const fallbackRole = roleForFilename(filename)
  pending = gltfLoader.loadAsync(url).then((gltf) => {
    const out = []
    gltf.scene.updateMatrixWorld(true)
    gltf.scene.traverse((node) => {
      if (!node.isMesh || !node.geometry || !node.geometry.attributes.position) return
      const geo = node.geometry.clone()
      geo.applyMatrix4(node.matrixWorld)
      stripToPositionNormal(geo)
      // Quaternius sub-materials get their own name-based role EXCEPT when the
      // filename already unambiguously says 'roof' (Roof_*.gltf) — some roof
      // parts shingle themselves with a "MI_WoodTrim" material (a legitimately
      // wood-colored surface, but still THE roof, not incidental wood trim),
      // which would otherwise wrongly fall out of the race-tintable bucket
      // entirely (caught in spikes/m2-assets verification: 6 of 7 tier-3
      // types had a fully neutral, never-tinted roof because of this).
      const role = vendor === 'quaternius' ? (fallbackRole === 'roof' ? 'roof' : roleForMaterialName(node.material && node.material.name, fallbackRole)) : fallbackRole
      out.push({ geometry: geo, role })
    })
    return out
  })
  partCache.set(url, pending)
  return pending
}

/** Assembles one recipe (array of {u,x,y,z,ry}) into { structural, tintable } merged geometry. */
async function buildRecipeGeometry(vendor, partList) {
  const structuralPieces = []
  const tintablePieces = []
  for (const p of partList) {
    const meshes = await loadPartMeshes(vendor, p.u)
    const local = new THREE.Matrix4().compose(new THREE.Vector3(p.x, p.y, p.z), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, p.ry, 0)), new THREE.Vector3(1, 1, 1))
    for (const { geometry, role } of meshes) {
      const g = geometry.clone()
      g.applyMatrix4(local)
      const tintable = TINTABLE_ROLES.includes(role)
      bakeVertexColor(g, tintable ? 0xffffff : ROLE_COLOR[role] ?? ROLE_COLOR.stone)
      ;(tintable ? tintablePieces : structuralPieces).push(g)
    }
  }
  return {
    structural: structuralPieces.length ? mergeGeometries(structuralPieces, false) : null,
    tintable: tintablePieces.length ? mergeGeometries(tintablePieces, false) : null,
  }
}

function deriveAnchors(box) {
  const sizeX = box.max.x - box.min.x
  const sizeY = box.max.y - box.min.y
  const sizeZ = box.max.z - box.min.z
  return {
    wallXPos: box.max.x - sizeX * 0.015,
    wallXNeg: box.min.x + sizeX * 0.015,
    wallYmid: box.min.y + sizeY * 0.4,
    wallZ: box.min.z + sizeZ * 0.5,
    roofTopY: box.min.y + sizeY * 0.86,
    tankX: box.min.x + sizeX * 0.32,
    tankZ: box.min.z + sizeZ * 0.62,
    // Recipes normalize to the same HEIGHT (=1) but vary a lot in footprint
    // (a narrow tower vs. a compact Quaternius tier-3 shell) — bolt-on sizes
    // are authored as fractions of this, not of the fixed height, or they
    // read as wildly oversized on any recipe narrower than "average" (this
    // is exactly the bug the tier-3 gear/tank check screenshot caught).
    scaleRef: Math.max(Math.min(sizeX, sizeZ), 0.15),
  }
}

// ---------------------------------------------------------------------------
// Procedural steampunk bolt-ons (gear/pipe/tank), adapted from spikes/s5's
// validated recipe with the M2 art-verdict refinements: gears are ~1.5x
// chunkier (thicker disc + deeper teeth, so they read at oblique angles) and
// mount FLUSH against the wall (offset outward by half their own thickness,
// not centered on/embedded in the wall plane); no emissive anywhere (pipes
// read as metal, not light tubes — the spike's copper material already had
// none; kept that way deliberately here).
// ---------------------------------------------------------------------------

function makeGearGeometry(radius, thickness, teeth) {
  const parts = [new THREE.CylinderGeometry(radius, radius, thickness, 16), new THREE.CylinderGeometry(radius * 0.22, radius * 0.22, thickness * 1.6, 10)]
  const toothW = radius * 0.34 // chunkier than spikes/s5 (0.26) per the M2 art verdict
  const toothH = radius * 0.33 // chunkier than spikes/s5 (0.22) — the "depth" that reads obliquely
  for (let i = 0; i < teeth; i++) {
    const a = (i / teeth) * Math.PI * 2
    const tooth = new THREE.BoxGeometry(toothW, thickness * 1.05, toothH)
    tooth.translate(Math.cos(a) * (radius + toothH * 0.4), 0, Math.sin(a) * (radius + toothH * 0.4))
    tooth.rotateY(-a)
    parts.push(tooth)
  }
  return coloredGeo(mergeGeometries(parts, false), BRASS)
}

function pipeSegmentGeometry(a, b, radius) {
  const dir = new THREE.Vector3().subVectors(b, a)
  const len = Math.max(dir.length(), 1e-5)
  const geo = new THREE.CylinderGeometry(radius, radius, len, 8)
  const mid = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5)
  const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize())
  geo.applyMatrix4(new THREE.Matrix4().compose(mid, quat, new THREE.Vector3(1, 1, 1)))
  return geo
}

function makePipeRunGeometry(points, radius) {
  const parts = []
  for (let i = 0; i < points.length - 1; i++) parts.push(pipeSegmentGeometry(points[i], points[i + 1], radius))
  for (const p of points) {
    const joint = new THREE.SphereGeometry(radius * 1.2, 8, 6)
    joint.translate(p.x, p.y, p.z)
    parts.push(joint)
  }
  return coloredGeo(mergeGeometries(parts, false), COPPER)
}

function makeTankGeometry(radius, length) {
  const body = new THREE.CapsuleGeometry(radius, length, 4, 10)
  body.rotateZ(Math.PI / 2)
  const parts = [body]
  for (const t of [-0.32, 0, 0.32]) {
    const band = new THREE.TorusGeometry(radius * 1.03, radius * 0.11, 6, 12)
    band.rotateY(Math.PI / 2)
    band.translate(t * length, 0, 0)
    parts.push(band)
  }
  const gauge = new THREE.SphereGeometry(radius * 0.22, 8, 6)
  gauge.translate(length * 0.55, radius * 0.6, 0)
  parts.push(gauge)
  const stub = new THREE.CylinderGeometry(radius * 0.14, radius * 0.14, radius * 0.6, 8)
  stub.rotateZ(Math.PI / 2)
  stub.translate(-length * 0.5 - radius * 0.2, 0, 0)
  parts.push(stub)
  return coloredGeo(mergeGeometries(parts, false), BRONZE)
}

function mountMatrix(x, y, z, halfThickness, sign) {
  const pos = new THREE.Vector3(x + sign * halfThickness, y, z)
  const quat = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, sign > 0 ? -Math.PI / 2 : Math.PI / 2))
  return new THREE.Matrix4().compose(pos, quat, new THREE.Vector3(1, 1, 1))
}

function pickBoltOnKinds(race, tier) {
  if (tier === 3) return { kinds: ['gear', 'pipe', 'tank'], secondGear: BOLT_ON_SECOND_GEAR_RACES.includes(race) }
  return { kinds: BOLT_ON_KINDS_BY_RACE[race] || BOLT_ON_KINDS_BY_RACE.human, secondGear: false }
}

/** Builds one merged bolt-on geometry for a (type,tier,race,variant) combo, or null if the recipe has no bolt-ons. */
function buildBoltOnGeometry(kinds, secondGear, anchors, tier, variant) {
  const s = (TIER_BOLT_SCALE[tier] || 1) * anchors.scaleRef
  const sign = variant === 0 ? 1 : -1
  const wallX = sign > 0 ? anchors.wallXPos : anchors.wallXNeg
  const parts = []

  if (kinds.includes('gear')) {
    const gr = GEAR_RADIUS * s
    const gear = makeGearGeometry(gr, gr * 0.45, 10)
    gear.applyMatrix4(mountMatrix(wallX, anchors.wallYmid, anchors.wallZ, gr * 0.45, sign))
    parts.push(gear)
    if (secondGear) {
      const gr2 = gr * 0.68
      const gear2 = makeGearGeometry(gr2, gr2 * 0.45, 8)
      gear2.applyMatrix4(mountMatrix(wallX, anchors.wallYmid - gr * 1.3, anchors.wallZ, gr2 * 0.45, sign))
      parts.push(gear2)
    }
  }
  if (kinds.includes('tank')) {
    const tr = TANK_RADIUS * s
    const tl = TANK_LENGTH * s
    const tank = makeTankGeometry(tr, tl)
    tank.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(anchors.tankX, anchors.roofTopY + 0.05 * s, anchors.tankZ), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0.35, 0)), new THREE.Vector3(1, 1, 1)))
    parts.push(tank)
  }
  if (kinds.includes('pipe')) {
    const pr = PIPE_RADIUS * s
    const gy = anchors.wallYmid
    const pts = [
      new THREE.Vector3(wallX, gy - 0.22 * s, anchors.wallZ),
      new THREE.Vector3(wallX, gy, anchors.wallZ),
      new THREE.Vector3(wallX, anchors.roofTopY - 0.15 * s, anchors.wallZ * 0.6),
      new THREE.Vector3(anchors.tankX + 0.14 * s, anchors.roofTopY, anchors.tankZ + 0.1),
      new THREE.Vector3(anchors.tankX, anchors.roofTopY + 0.05 * s, anchors.tankZ),
    ]
    parts.push(makePipeRunGeometry(pts, pr))
  }
  return parts.length ? mergeGeometries(parts, false) : null
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function loadBuildingAssets(renderer) {
  try {
    if (!renderer.extensions.has('WEBGL_multi_draw')) {
      console.warn('[planet] assets: WEBGL_multi_draw not supported — BatchedMesh falls back to one draw call per unique geometry (higher draw-call count, same visuals)')
    }

    // Phase 1: load + merge every (type,tier) recipe's parts. Kenney for
    // tier 1-2, Quaternius for tier 3 grand landmarks (art verdict).
    const built = []
    for (const type of STRUCTURE_TYPES) {
      for (const tier of [1, 2, 3]) {
        const vendor = tier === 3 ? 'quaternius' : 'kenney'
        const parts = tier === 3 ? GRAND_RECIPES[type] : KIT_RECIPES[type]['tier' + tier]
        const { structural, tintable } = await buildRecipeGeometry(vendor, parts)
        built.push({ key: type + '|' + tier, structural, tintable })
      }
    }

    // Normalize every recipe to the same authored unit height (=1), matching
    // buildTower/buildHall/etc.'s existing convention, then derive bolt-on
    // mount anchors + a bounding-sphere radius from the normalized box.
    for (const b of built) {
      const rawBox = unionBox([b.structural, b.tintable])
      const rawSize = rawBox.getSize(new THREE.Vector3())
      const scale = 1 / Math.max(rawSize.y, 1e-6)
      if (b.structural) b.structural.scale(scale, scale, scale)
      if (b.tintable) b.tintable.scale(scale, scale, scale)
      const box = unionBox([b.structural, b.tintable])
      b.anchors = deriveAnchors(box)
      b.boundingRadius = box.getBoundingSphere(new THREE.Sphere()).radius
    }

    // Phase 2: matte BatchedMesh (walls/roofs/chimneys + the race-tintable
    // roof/banner geometry) — size = sum of the UNIQUE geometries above,
    // never instanceCount * per-instance size (S4 gotcha).
    let sumV = 0
    let sumI = 0
    for (const b of built) {
      for (const g of [b.structural, b.tintable]) {
        if (!g) continue
        sumV += g.attributes.position.count
        sumI += g.index ? g.index.count : 0
      }
    }
    const matteMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, flatShading: true, roughness: 0.88, metalness: 0.04 })
    let matteInstanceCap = 3000
    const matteBatch = new THREE.BatchedMesh(matteInstanceCap, Math.ceil(sumV * 1.1) + 64, Math.ceil(sumI * 1.1) + 64, matteMaterial)
    matteBatch.perObjectFrustumCulled = true

    const recipeCache = new Map()
    for (const b of built) {
      const structGeoId = b.structural ? matteBatch.addGeometry(b.structural) : null
      const roofGeoId = b.tintable ? matteBatch.addGeometry(b.tintable) : null
      recipeCache.set(b.key, { structGeoId, roofGeoId, anchors: b.anchors, boundingRadius: b.boundingRadius })
    }

    // Metal (brass/copper/bronze bolt-on) BatchedMesh — geometries are built
    // lazily per (type,tier,race,variant) the first time that combo is
    // requested (cheap: procedural, synchronous, no loading involved), sized
    // generously up front with an auto-grow safety net (setGeometrySize /
    // setInstanceCount) rather than trying to predict the exact final count.
    // Budget below covers the full type x tier x race x variant space (the
    // worst case spikes/m2-assets/check.js exercises directly, measured at
    // ~163k verts / ~330k indices) with headroom; real sessions populate
    // this incrementally as distinct combos are first encountered.
    let metalMaxVertex = 200000
    let metalMaxIndex = 420000
    let metalInstanceCap = 1500
    const metalMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, flatShading: true, roughness: 0.4, metalness: 0.62, envMapIntensity: 1.1 })
    const metalBatch = new THREE.BatchedMesh(metalInstanceCap, metalMaxVertex, metalMaxIndex, metalMaterial)
    metalBatch.perObjectFrustumCulled = true

    // Scoped environment lighting for metalness > 0.3 materials ONLY (per
    // the M2 art verdict + spikes/s5's finding): a neutral generated room
    // env assigned just to metalMaterial.envMap, never scene.environment —
    // setting it globally would relight every low-metalness matte material
    // in the scene (confirmed by the spike to wash the whole scene pastel
    // under ACES tonemapping).
    const pmrem = new THREE.PMREMGenerator(renderer)
    metalMaterial.envMap = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
    pmrem.dispose()

    const group = new THREE.Group()
    group.add(matteBatch, metalBatch)

    const boltOnCache = new Map()

    function ensureMatteInstances() {
      if (matteBatch.instanceCount >= matteInstanceCap) {
        matteInstanceCap *= 2
        matteBatch.setInstanceCount(matteInstanceCap)
        console.warn('[planet] assets: grew matte BatchedMesh instance capacity to', matteInstanceCap)
      }
    }
    function ensureMetalInstances() {
      if (metalBatch.instanceCount >= metalInstanceCap) {
        metalInstanceCap *= 2
        metalBatch.setInstanceCount(metalInstanceCap)
        console.warn('[planet] assets: grew metal BatchedMesh instance capacity to', metalInstanceCap)
      }
    }
    function ensureMetalGeometryCapacity(vertsNeeded, idxNeeded) {
      if (metalBatch.unusedVertexCount < vertsNeeded || metalBatch.unusedIndexCount < idxNeeded) {
        metalMaxVertex = metalMaxVertex * 2 + vertsNeeded
        metalMaxIndex = metalMaxIndex * 2 + idxNeeded
        metalBatch.setGeometrySize(metalMaxVertex, metalMaxIndex)
        console.warn('[planet] assets: grew metal BatchedMesh geometry buffer to', metalMaxVertex, 'verts')
      }
    }

    function getOrBuildBoltOn(type, tier, race, seedStr, anchors) {
      const variant = Math.floor(hash01(String(seedStr) + '~boltvariant') * 2)
      const key = type + '|' + tier + '|' + race + '|' + variant
      let entry = boltOnCache.get(key)
      if (entry !== undefined) return entry
      const { kinds, secondGear } = pickBoltOnKinds(race, tier)
      const geo = buildBoltOnGeometry(kinds, secondGear, anchors, tier, variant)
      if (!geo) {
        boltOnCache.set(key, null)
        return null
      }
      ensureMetalGeometryCapacity(geo.attributes.position.count, geo.index ? geo.index.count : 0)
      const geoId = metalBatch.addGeometry(geo)
      entry = { geoId }
      boltOnCache.set(key, entry)
      return entry
    }

    function forEachSub(handle, fn) {
      if (handle.structId != null) fn(matteBatch, handle.structId)
      if (handle.roofId != null) fn(matteBatch, handle.roofId)
      if (handle.boltId != null) fn(metalBatch, handle.boltId)
    }

    function createStructureVisual(type, tier, race, seedStr) {
      const key = type + '|' + tier
      const recipe = recipeCache.get(key)
      const pal = RACE_PALETTES[race] || RACE_PALETTES.human
      if (!recipe) {
        console.warn('[planet] assets: no recipe for', key, '- returning an empty (invisible) visual')
        return { handle: { structId: null, roofId: null, boltId: null }, boundingRadius: 0.05 }
      }

      ensureMatteInstances()
      const structId = recipe.structGeoId != null ? matteBatch.addInstance(recipe.structGeoId) : null
      // Explicit white, not relying on BatchedMesh's own default-white fill
      // — makes the "colors texture lazy-init" gotcha a non-issue regardless
      // of call order (see S4 spike notes): every instance we ever add gets
      // an explicit setColorAt call, full stop.
      if (structId != null) matteBatch.setColorAt(structId, WHITE_COLOR)

      ensureMatteInstances()
      const roofId = recipe.roofGeoId != null ? matteBatch.addInstance(recipe.roofGeoId) : null
      if (roofId != null) matteBatch.setColorAt(roofId, new THREE.Color(pal.roof))

      let boltId = null
      const boltOn = getOrBuildBoltOn(type, tier, race, seedStr, recipe.anchors)
      if (boltOn) {
        ensureMetalInstances()
        boltId = metalBatch.addInstance(boltOn.geoId)
      }

      return { handle: { structId, roofId, boltId }, boundingRadius: recipe.boundingRadius }
    }

    function setVisualMatrix(handle, matrix4) {
      forEachSub(handle, (batch, id) => batch.setMatrixAt(id, matrix4))
    }
    function setVisualVisible(handle, visible) {
      forEachSub(handle, (batch, id) => batch.setVisibleAt(id, visible))
    }
    function removeVisual(handle) {
      forEachSub(handle, (batch, id) => batch.deleteInstance(id))
    }

    let elapsed = 0
    function update(dt) {
      elapsed += dt
      // Subtle "breathing" metal — env-map intensity pulse, cheap (one
      // shared-material uniform, not per-instance). Everything else here is
      // static merged geometry; there is no per-instance animation to drive.
      metalMaterial.envMapIntensity = 1.1 + Math.sin(elapsed * 0.5) * 0.04
    }

    return { ready: true, createStructureVisual, setVisualMatrix, setVisualVisible, removeVisual, group, update }
  } catch (err) {
    console.warn('[planet] assets: failed to load the building asset pack, falling back to procedural kits —', err)
    return { ready: false }
  }
}
