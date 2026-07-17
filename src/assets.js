// M2 asset pipeline: loads the Kenney/Quaternius kit parts named in
// buildings.js's recipe tables, merges each (type, tier) recipe into static
// geometry, and renders every structure in the world from FOUR
// THREE.BatchedMesh draw calls — one per material CLASS (wood, stone+thatch,
// cloth+banner, brass) — instead of one THREE.Mesh per building part. The
// class split is the M-WX "material-distinction" pass (ART.md's owner
// complaint: every building shared one matte skin, reading as clay/
// play-dough); each class gets its own roughness/metalness/envMapIntensity
// and a subtle procedural micro-albedo texture instead of one flat
// treatment for everything. See the M2 program plan (§0.5 art direction,
// S4/S5 spike results), spikes/s4, spikes/s5, and ART.md §2/§6.
//
// Contract (world.js builds against this exactly — UNCHANGED by the M-WX
// pass, only loadBuildingAssets grew one optional trailing parameter):
//   const assets = await loadBuildingAssets(renderer, sky)
//   if (assets.ready) {
//     const { handle, boundingRadius } = assets.createStructureVisual(type, tier, race, seedStr)
//     assets.setVisualMatrix(handle, matrix4)   // full world matrix: position * rotation * scale
//     assets.setVisualVisible(handle, bool)
//     assets.removeVisual(handle)
//     scene.add(assets.group)                   // THREE.Group holding the BatchedMesh(es)
//     assets.update(dt)                         // per-frame env/anim upkeep
//   }
// `sky` is OPTIONAL and defaults to null — today's world.js call site still
// only passes `renderer`, which is fine (see env.js: the PMREM capture it
// feeds is static/baked-once regardless, so a missing live sky handle just
// means the bake uses a fixed fallback sun direction instead of the live
// one). Wiring the real sky object through world.js's loadBuildingAssets
// call is a nice-to-have left to whoever next touches world.js/main.js
// (outside this pass's file ownership) — see env.js's own header comment.
// `handle`'s internal shape is opaque to callers (world.js only ever passes
// it back into setVisualMatrix/setVisualVisible/removeVisual, confirmed by
// grep) and changed freely in this pass.
// If loading fails for any reason, loadBuildingAssets() resolves (never
// rejects) to { ready: false } and the caller falls back to buildKit() from
// buildings.js — the procedural kit builders stay fully intact for exactly
// this reason (see buildings.js's own comment on this).
//
// SIZING NOTE (the one contract detail that isn't visible in the function
// signatures, called out per the "flag deviations loudly" instruction):
// every merged (type,tier) recipe is normalized to the SAME "roughly 1 unit
// tall" authored-space convention buildTower/buildHall/etc. already use in
// buildings.js, and boundingRadius is reported in that same authored space —
// NOT world units. The caller still owns KIT_UNIT_SIZE[type] * TIER_MULT[tier-1]
// (both still exported from buildings.js, untouched) and bakes that scale
// into the matrix4 passed to setVisualMatrix, exactly as it does today for
// buildKit()'s output. This keeps sizing tuned in exactly one place for BOTH
// the asset path and the procedural fallback, rather than baking a second,
// independent size system into this file. The M-WX model-tier pass (task 3)
// adds a SECOND, SMALLER authored-height multiplier on top of the "=1"
// baseline (grand=1.12, humble=0.94, see buildings.js's MODEL_TIER_BUCKET) —
// this still composes cleanly with the caller's KIT_UNIT_SIZE*TIER_MULT
// scale because boundingRadius is read back per-variant, not assumed fixed.
import * as THREE from 'three/webgpu'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { hash01, rngFromString } from './util.js'
import { createEnvironment } from './env.js'
import {
  RACE_PALETTES,
  ASSET_BASE,
  ROLE_COLOR,
  ROLE_CLASS,
  TINTABLE_ROLES,
  KENNEY_PART_ROLES,
  KENNEY_DEFAULT_ROLE,
  MATERIAL_NAME_ROLES,
  KIT_RECIPES,
  GRAND_RECIPES,
  BOLT_ON_KINDS_BY_RACE,
  BOLT_ON_SECOND_GEAR_RACES,
  COLOR_THATCH,
  COLOR_MARBLE,
  MODEL_TIER_BUCKET,
  GRAND_HEIGHT_MULT,
  HUMBLE_HEIGHT_MULT,
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

// Model-tier geometry buckets a recipe gets built in — see buildings.js's
// MODEL_TIER_BUCKET comment for the seedStr-suffix -> bucket mapping and
// what each variant means.
const VARIANT_BUCKETS = ['base', 'grand', 'humble']

// The four merged-geometry buckets buildRecipeGeometry produces per recipe,
// and which micro-albedo/material CLASS each samples (roofTint is the
// 'roof' role's tintable content, itself class 'stone' per ROLE_CLASS —
// bannerTint is 'banner', class 'cloth' — derived straight from ROLE_CLASS
// rather than re-hardcoded, so the two tables can't drift apart).
const BUCKET_KEYS = ['wood', 'stone', 'roofTint', 'bannerTint']
const BUCKET_TILE_KEY = {
  wood: ROLE_CLASS.wood,
  stone: ROLE_CLASS.stone,
  roofTint: ROLE_CLASS.roof,
  bannerTint: ROLE_CLASS.banner,
}

// Micro-albedo tiling frequency per material class — chosen so the pattern
// reads as a handful of grain/speckle/weave cycles across a wall face at the
// authored unit-height scale (every recipe normalizes to height=1 before
// this is applied, post model-tier variant derivation), not a photo-tiled
// repeat. Tuned by eye per S5's "stylized, not photoreal" verdict.
const MICRO_ALBEDO_TILE_SCALE = { wood: 6, stone: 9, cloth: 13 }

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

// Synthetic per-vertex UV (dominant-axis planar projection picked from the
// vertex normal — a cheap triplanar, no shader involved) for sampling the
// class micro-albedo textures below. The vendor's own atlas UV never
// survives stripToPositionNormal (loadPartMeshes strips it at load time,
// same as it always has — an atlas UV would sample disjoint atlas regions
// per merged part, reading as uncorrelated confetti once tiled), so this
// bakes a FRESH uv from the FINAL merged geometry instead. Called only after
// a recipe variant's unit-height normalization + any grand/humble tweaks are
// fully baked in, so tile frequency reads consistently across every vendor/
// tier/variant rather than drifting with raw vendor module scale.
function addPlanarUV(geometry, tileScale) {
  const pos = geometry.attributes.position
  const nrm = geometry.attributes.normal
  const count = pos.count
  const uv = new Float32Array(count * 2)
  for (let i = 0; i < count; i++) {
    const x = pos.getX(i)
    const y = pos.getY(i)
    const z = pos.getZ(i)
    const nx = Math.abs(nrm.getX(i))
    const ny = Math.abs(nrm.getY(i))
    const nz = Math.abs(nrm.getZ(i))
    let u, v
    if (ny >= nx && ny >= nz) {
      u = x
      v = z // top/bottom-facing (roof caps, floors): XZ plane
    } else if (nx >= ny && nx >= nz) {
      u = z
      v = y // X-facing walls: ZY plane
    } else {
      u = x
      v = y // Z-facing walls: XY plane
    }
    uv[i * 2] = u * tileScale
    uv[i * 2 + 1] = v * tileScale
  }
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  return geometry
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
      const role =
        vendor === 'quaternius'
          ? fallbackRole === 'roof'
            ? 'roof'
            : roleForMaterialName(node.material && node.material.name, fallbackRole)
          : fallbackRole
      out.push({ geometry: geo, role })
    })
    return out
  })
  partCache.set(url, pending)
  return pending
}

/** Assembles one recipe (array of {u,x,y,z,ry}) into per-material-class
 * merged geometry buckets: { wood, stone, roofTint, bannerTint }. wood/stone
 * are baked-neutral (actual ROLE_COLOR hex); roofTint/bannerTint are baked
 * pure white for BatchedMesh's per-instance setColorAt race-tinting
 * (TINTABLE_ROLES) — kept as SEPARATE buckets from their class's neutral
 * content because one BatchedMesh instance's tint multiplies its WHOLE
 * geometry uniformly, so a tintable 'roof' part can never share one merged
 * buffer with a neutral 'stone' wall part (that would race-tint the wall
 * too). 'cloth'-class neutral content and 'wood'-class tintable content
 * don't exist in today's role tables (see ROLE_CLASS/TINTABLE_ROLES in
 * buildings.js) so aren't tracked as separate buckets; any future role/class
 * combo outside today's tables defensively lands in neutral.stone rather
 * than being silently dropped. Each returned bucket may be null if the
 * recipe has no parts of that class. */
async function buildRecipeGeometry(vendor, partList) {
  const neutral = { wood: [], stone: [] }
  const tint = { stone: [], cloth: [] }
  for (const p of partList) {
    const meshes = await loadPartMeshes(vendor, p.u)
    const local = new THREE.Matrix4().compose(
      new THREE.Vector3(p.x, p.y, p.z),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(0, p.ry, 0)),
      new THREE.Vector3(1, 1, 1),
    )
    for (const { geometry, role } of meshes) {
      const g = geometry.clone()
      g.applyMatrix4(local)
      const tintable = TINTABLE_ROLES.includes(role)
      const cls = ROLE_CLASS[role] || 'stone'
      bakeVertexColor(g, tintable ? 0xffffff : (ROLE_COLOR[role] ?? ROLE_COLOR.stone))
      const bucket = tintable ? tint[cls] : neutral[cls]
      if (bucket) bucket.push(g)
      else neutral.stone.push(g)
    }
  }
  const merge = (arr) => (arr && arr.length ? mergeGeometries(arr, false) : null)
  return {
    wood: merge(neutral.wood),
    stone: merge(neutral.stone),
    roofTint: merge(tint.stone),
    bannerTint: merge(tint.cloth),
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
    // Recipes normalize to the same HEIGHT (=1, times the model-tier variant
    // multiplier) but vary a lot in footprint (a narrow tower vs. a compact
    // Quaternius tier-3 shell) — bolt-on sizes are authored as fractions of
    // this, not of the fixed height, or they read as wildly oversized on any
    // recipe narrower than "average" (this is exactly the bug the tier-3
    // gear/tank check screenshot caught).
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
  const parts = [
    new THREE.CylinderGeometry(radius, radius, thickness, 16),
    new THREE.CylinderGeometry(radius * 0.22, radius * 0.22, thickness * 1.6, 10),
  ]
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
  for (let i = 0; i < points.length - 1; i++)
    parts.push(pipeSegmentGeometry(points[i], points[i + 1], radius))
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
  const quat = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(0, 0, sign > 0 ? -Math.PI / 2 : Math.PI / 2),
  )
  return new THREE.Matrix4().compose(pos, quat, new THREE.Vector3(1, 1, 1))
}

function pickBoltOnKinds(race, tier) {
  if (tier === 3)
    return { kinds: ['gear', 'pipe', 'tank'], secondGear: BOLT_ON_SECOND_GEAR_RACES.includes(race) }
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
    tank.applyMatrix4(
      new THREE.Matrix4().compose(
        new THREE.Vector3(anchors.tankX, anchors.roofTopY + 0.05 * s, anchors.tankZ),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0.35, 0)),
        new THREE.Vector3(1, 1, 1),
      ),
    )
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
// Model-tier variant geometry (M-WX task 3 — "the plan's carryover"):
// fable/opus sessions get a marble-trim cornice + a taller shell; haiku
// sessions get a re-baked thatch roof (no longer race-tintable) + a shorter
// shell; sonnet/unknown keep today's recipe verbatim. See buildings.js's
// MODEL_TIER_BUCKET comment for the full mapping/rationale.
// ---------------------------------------------------------------------------

/** A thin marble-white cornice band just under the roofline, spanning the
 * recipe's own footprint — the 'grand' variant's one added part. Built from
 * the recipe's OWN (already re-derived) bounding box so it fits any type/
 * vendor/tier without per-recipe tuning. */
function buildMarbleTrimGeometry(box) {
  const sizeX = box.max.x - box.min.x
  const sizeY = box.max.y - box.min.y
  const sizeZ = box.max.z - box.min.z
  const cx = (box.max.x + box.min.x) / 2
  const cz = (box.max.z + box.min.z) / 2
  const bandH = Math.max(sizeY * 0.045, 0.01)
  const bandY = box.min.y + sizeY * 0.84
  const geo = new THREE.BoxGeometry(sizeX * 1.03, bandH, sizeZ * 1.03)
  geo.translate(cx, bandY, cz)
  return coloredGeo(geo, COLOR_MARBLE)
}

function cloneBucket(g) {
  return g ? g.clone() : null
}

/** Derives the 'grand' or 'humble' model-tier variant from a recipe's
 * already unit-height-normalized BASE buckets (mutates nothing on
 * baseBuckets — 'base' itself still needs those buckets untouched). MUST run
 * before any UV pass touches baseBuckets (addPlanarUV mutates its geometry
 * in place; cloning afterward would carry a stale 'uv' attribute into
 * geometry that still needs a plain position/normal/color merge with the
 * trim/thatch pieces below — see the Phase 1 build loop's ordering). */
function deriveVariant(baseBuckets, bucket) {
  if (bucket === 'base') return baseBuckets
  const out = {}
  for (const key of BUCKET_KEYS) out[key] = cloneBucket(baseBuckets[key])

  const mult = bucket === 'grand' ? GRAND_HEIGHT_MULT : HUMBLE_HEIGHT_MULT
  for (const key of BUCKET_KEYS) if (out[key]) out[key].scale(1, mult, 1)

  if (bucket === 'grand') {
    const box = unionBox(BUCKET_KEYS.map((k) => out[k]))
    const trim = buildMarbleTrimGeometry(box)
    out.stone = out.stone ? mergeGeometries([out.stone, trim], false) : trim
  } else if (bucket === 'humble' && out.roofTint) {
    // Thatch-heavy: the roof stops being race-tintable and becomes a fixed
    // neutral thatch color, folded into the stone-neutral bucket instead of
    // staying a separate tint bucket.
    bakeVertexColor(out.roofTint, COLOR_THATCH)
    out.stone = out.stone ? mergeGeometries([out.stone, out.roofTint], false) : out.roofTint
    out.roofTint = null
  }
  return out
}

// ---------------------------------------------------------------------------
// Micro-albedo textures (M-WX material-distinction pass) — tiny, low-
// contrast, stylized detail per class, NOT photo-PBR (S5 verdict bans that
// route). Each is a 256px canvas, base white, with a class-appropriate
// low-alpha pattern baked in; sampled through material.map, which MULTIPLIES
// against the baked vertex color — so the effect can only ever DARKEN
// slightly (a plain multiply can't exceed white), staying within roughly 5%
// of "no effect" by construction (alpha values below are chosen so even a
// couple of overlapping strokes stay close to that budget). Tiled via the
// synthetic UV from addPlanarUV above. Deterministic (seeded rngFromString,
// not Math.random) purely for reproducibility across reloads — these are
// fixed shared assets, not per-world content, so this isn't the same
// determinism contract the program plan requires of world-state code.
// ---------------------------------------------------------------------------

function makeMicroAlbedoTexture(seed, draw) {
  const canvas = document.createElement('canvas')
  canvas.width = 256
  canvas.height = 256
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, 256, 256)
  draw(ctx, rngFromString(seed))
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.RepeatWrapping
  tex.needsUpdate = true
  return tex
}

/** Wood grain: low-alpha horizontal streaks with a slight sine wobble —
 * reads as grain once tiled without needing per-part UV alignment. */
function drawWoodGrainTexture(ctx, rng) {
  const rows = 22
  for (let i = 0; i < rows; i++) {
    const y = (i + 0.5) * (256 / rows) + (rng() - 0.5) * 6
    ctx.strokeStyle = `rgba(90,60,30,${(0.02 + rng() * 0.025).toFixed(3)})`
    ctx.lineWidth = 1.5 + rng() * 2
    ctx.beginPath()
    ctx.moveTo(0, y)
    for (let x = 0; x <= 256; x += 16) ctx.lineTo(x, y + Math.sin(x * 0.05 + i) * 3 + (rng() - 0.5) * 2)
    ctx.stroke()
  }
}

/** Stone speckle: scattered low-alpha mottled blotches — masonry grain. */
function drawStoneSpeckleTexture(ctx, rng) {
  const count = 260
  for (let i = 0; i < count; i++) {
    const x = rng() * 256
    const y = rng() * 256
    const r = 1 + rng() * 3.5
    ctx.fillStyle = `rgba(60,55,48,${(0.018 + rng() * 0.022).toFixed(3)})`
    ctx.beginPath()
    ctx.arc(x, y, r, 0, Math.PI * 2)
    ctx.fill()
  }
}

/** Cloth weave: a fine, slightly-jittered crosshatch — woven-fabric hint. */
function drawClothWeaveTexture(ctx, rng) {
  ctx.strokeStyle = 'rgba(40,40,45,0.03)'
  ctx.lineWidth = 1
  for (let x = 0; x <= 256; x += 6) {
    const j = (rng() - 0.5) * 1.5
    ctx.beginPath()
    ctx.moveTo(x + j, 0)
    ctx.lineTo(x + j, 256)
    ctx.stroke()
  }
  for (let y = 0; y <= 256; y += 6) {
    const j = (rng() - 0.5) * 1.5
    ctx.beginPath()
    ctx.moveTo(0, y + j)
    ctx.lineTo(256, y + j)
    ctx.stroke()
  }
}

/** Parses the model-tier hint off the END of seedStr (world.js builds it as
 * `id + ':' + (model || '')`) and buckets it per buildings.js's
 * MODEL_TIER_BUCKET. Robust to `id` itself containing colons — the LAST
 * colon is always the one world.js inserted before the model hint. */
function modelTierBucket(seedStr) {
  const s = String(seedStr)
  const idx = s.lastIndexOf(':')
  const modelHint = idx >= 0 ? s.slice(idx + 1) : ''
  return MODEL_TIER_BUCKET[modelHint] || 'base'
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function loadBuildingAssets(renderer, sky = null) {
  try {
    // WebGLRenderer exposes .extensions; WebGPURenderer (M3 host) does not —
    // BatchedMesh multi-draw is handled by the backend there, so only probe
    // when the classic extensions API is present.
    if (renderer.extensions && !renderer.extensions.has('WEBGL_multi_draw')) {
      console.warn(
        '[planet] assets: WEBGL_multi_draw not supported — BatchedMesh falls back to one draw call per unique geometry (higher draw-call count, same visuals)',
      )
    }

    // Phase 1: load + merge every (type,tier) recipe's parts into per-class
    // buckets (buildRecipeGeometry), normalize to the shared unit-height
    // convention, then derive the 3 model-tier geometry VARIANTS per recipe
    // (base/grand/humble). Kenney for tier 1-2, Quaternius for tier 3 grand
    // landmarks (art verdict) — unchanged from before this pass.
    const built = []
    for (const type of STRUCTURE_TYPES) {
      for (const tier of [1, 2, 3]) {
        const vendor = tier === 3 ? 'quaternius' : 'kenney'
        const parts = tier === 3 ? GRAND_RECIPES[type] : KIT_RECIPES[type]['tier' + tier]
        const baseBuckets = await buildRecipeGeometry(vendor, parts)

        // Normalize to the same authored unit height (=1), matching
        // buildTower/buildHall/etc.'s existing convention.
        const rawBox = unionBox(BUCKET_KEYS.map((k) => baseBuckets[k]))
        const rawSize = rawBox.getSize(new THREE.Vector3())
        const scale = 1 / Math.max(rawSize.y, 1e-6)
        for (const key of BUCKET_KEYS) if (baseBuckets[key]) baseBuckets[key].scale(scale, scale, scale)

        // Derive ALL THREE variants before any of them gets a UV pass (see
        // deriveVariant's own ordering comment).
        const variantBuckets = {
          base: baseBuckets,
          grand: deriveVariant(baseBuckets, 'grand'),
          humble: deriveVariant(baseBuckets, 'humble'),
        }

        for (const bucket of VARIANT_BUCKETS) {
          const buckets = variantBuckets[bucket]
          const box = unionBox(BUCKET_KEYS.map((k) => buckets[k]))
          const anchors = deriveAnchors(box)
          const boundingRadius = box.getBoundingSphere(new THREE.Sphere()).radius
          for (const key of BUCKET_KEYS)
            if (buckets[key]) addPlanarUV(buckets[key], MICRO_ALBEDO_TILE_SCALE[BUCKET_TILE_KEY[key]])
          built.push({
            key: type + '|' + tier + '|' + bucket,
            wood: buckets.wood,
            stone: buckets.stone,
            roofTint: buckets.roofTint,
            bannerTint: buckets.bannerTint,
            anchors,
            boundingRadius,
          })
        }
      }
    }

    // Phase 2: one BatchedMesh per material class (wood / stone+thatch /
    // cloth+banner) — size = sum of the UNIQUE geometries above, never
    // instanceCount * per-instance size (S4 gotcha). All (type,tier,bucket)
    // combos are known upfront (built eagerly above), so — like the old
    // single matte batch before this pass — these geometry buffers never
    // need runtime growth, only instance COUNT does (ensure*Instances below).
    function classSum(keys) {
      let v = 0
      let idx = 0
      for (const b of built) {
        for (const key of keys) {
          const g = b[key]
          if (!g) continue
          v += g.attributes.position.count
          idx += g.index ? g.index.count : 0
        }
      }
      return { v, idx }
    }
    const woodSum = classSum(['wood'])
    const stoneSum = classSum(['stone', 'roofTint'])
    const clothSum = classSum(['bannerTint'])

    const woodAlbedoTex = makeMicroAlbedoTexture('planet:micro-albedo:wood', drawWoodGrainTexture)
    const stoneAlbedoTex = makeMicroAlbedoTexture('planet:micro-albedo:stone', drawStoneSpeckleTexture)
    const clothAlbedoTex = makeMicroAlbedoTexture('planet:micro-albedo:cloth', drawClothWeaveTexture)

    // Per-class roughness/metalness/envMapIntensity (M-WX verdict numbers).
    // metalness isn't spec'd per-class beyond brass — wood keeps a hair of
    // dielectric sheen (matches "warm sheen"), stone/cloth sit at/near zero
    // (matte masonry, fully-diffuse fabric) — all well under brass's 0.75.
    const woodMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      vertexColors: true,
      flatShading: true,
      roughness: 0.75,
      metalness: 0.04,
      map: woodAlbedoTex,
    })
    const stoneMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      vertexColors: true,
      flatShading: true,
      roughness: 0.95,
      metalness: 0.02,
      map: stoneAlbedoTex,
    })
    const clothMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      vertexColors: true,
      flatShading: true,
      roughness: 1.0,
      metalness: 0.0,
      map: clothAlbedoTex,
    })
    const metalMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      vertexColors: true,
      flatShading: true,
      roughness: 0.3,
      metalness: 0.75,
    })

    // Scoped environment lighting (env.js — the M-LD env-lighting follow-on):
    // a static PMREM capture of OUR sky palette, assigned to each class
    // material's .envMap/.envMapIntensity individually. NEVER scene.environment
    // — see env.js's own header for the S5 pastel-wash lesson this avoids.
    const env = createEnvironment(renderer, sky)
    env.apply(woodMaterial, 0.25)
    env.apply(stoneMaterial, 0.1)
    env.apply(clothMaterial, 0)
    env.apply(metalMaterial, 0.9)

    let woodInstanceCap = 1500
    let stoneInstanceCap = 3000
    let clothInstanceCap = 400
    let metalInstanceCap = 1500

    const woodBatch = new THREE.BatchedMesh(
      woodInstanceCap,
      Math.ceil(woodSum.v * 1.1) + 64,
      Math.ceil(woodSum.idx * 1.1) + 64,
      woodMaterial,
    )
    const stoneBatch = new THREE.BatchedMesh(
      stoneInstanceCap,
      Math.ceil(stoneSum.v * 1.1) + 64,
      Math.ceil(stoneSum.idx * 1.1) + 64,
      stoneMaterial,
    )
    const clothBatch = new THREE.BatchedMesh(
      clothInstanceCap,
      Math.ceil(clothSum.v * 1.1) + 64,
      Math.ceil(clothSum.idx * 1.1) + 64,
      clothMaterial,
    )
    woodBatch.perObjectFrustumCulled = true
    stoneBatch.perObjectFrustumCulled = true
    clothBatch.perObjectFrustumCulled = true

    // Metal (brass/copper/bronze bolt-on) BatchedMesh — geometries are built
    // lazily per (type,tier,race,variant,bucket) the first time that combo is
    // requested (cheap: procedural, synchronous, no loading involved), sized
    // generously up front with an auto-grow safety net (setGeometrySize /
    // setInstanceCount) rather than trying to predict the exact final count.
    // Budget below covers the full type x tier x race x variant space (the
    // worst case spikes/m2-assets/check.js exercises directly, measured at
    // ~163k verts / ~330k indices) with headroom; real sessions populate
    // this incrementally as distinct combos are first encountered.
    let metalMaxVertex = 200000
    let metalMaxIndex = 420000
    const metalBatch = new THREE.BatchedMesh(metalInstanceCap, metalMaxVertex, metalMaxIndex, metalMaterial)
    metalBatch.perObjectFrustumCulled = true

    const recipeCache = new Map()
    for (const b of built) {
      const woodGeoId = b.wood ? woodBatch.addGeometry(b.wood) : null
      const stoneGeoId = b.stone ? stoneBatch.addGeometry(b.stone) : null
      const roofGeoId = b.roofTint ? stoneBatch.addGeometry(b.roofTint) : null
      const bannerGeoId = b.bannerTint ? clothBatch.addGeometry(b.bannerTint) : null
      recipeCache.set(b.key, {
        woodGeoId,
        stoneGeoId,
        roofGeoId,
        bannerGeoId,
        anchors: b.anchors,
        boundingRadius: b.boundingRadius,
      })
    }

    const group = new THREE.Group()
    group.add(woodBatch, stoneBatch, clothBatch, metalBatch)

    const boltOnCache = new Map()

    function makeCapGrower(batch, label, initialCap) {
      let cap = initialCap
      return function ensure() {
        if (batch.instanceCount >= cap) {
          cap *= 2
          batch.setInstanceCount(cap)
          console.warn('[planet] assets: grew ' + label + ' BatchedMesh instance capacity to', cap)
        }
      }
    }
    const ensureWoodInstances = makeCapGrower(woodBatch, 'wood', woodInstanceCap)
    const ensureStoneInstances = makeCapGrower(stoneBatch, 'stone', stoneInstanceCap)
    const ensureClothInstances = makeCapGrower(clothBatch, 'cloth', clothInstanceCap)
    const ensureMetalInstances = makeCapGrower(metalBatch, 'metal', metalInstanceCap)

    function ensureMetalGeometryCapacity(vertsNeeded, idxNeeded) {
      if (metalBatch.unusedVertexCount < vertsNeeded || metalBatch.unusedIndexCount < idxNeeded) {
        metalMaxVertex = metalMaxVertex * 2 + vertsNeeded
        metalMaxIndex = metalMaxIndex * 2 + idxNeeded
        metalBatch.setGeometrySize(metalMaxVertex, metalMaxIndex)
        console.warn('[planet] assets: grew metal BatchedMesh geometry buffer to', metalMaxVertex, 'verts')
      }
    }

    // Bolt-on cache key includes `bucket`: grand/humble anchors differ from
    // base (the model-tier height stretch moves wallYmid/roofTopY/etc.), so
    // a bolt-on built for one bucket would be mis-sized/mis-mounted if
    // reused verbatim on another — this is genuinely a different anchor
    // space, not just a cosmetic cache-key nicety.
    function getOrBuildBoltOn(type, tier, race, seedStr, bucket, anchors) {
      const variant = Math.floor(hash01(String(seedStr) + '~boltvariant') * 2)
      const key = type + '|' + tier + '|' + race + '|' + variant + '|' + bucket
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
      if (handle.woodId != null) fn(woodBatch, handle.woodId)
      if (handle.stoneId != null) fn(stoneBatch, handle.stoneId)
      if (handle.roofId != null) fn(stoneBatch, handle.roofId)
      if (handle.bannerId != null) fn(clothBatch, handle.bannerId)
      if (handle.boltId != null) fn(metalBatch, handle.boltId)
    }

    function createStructureVisual(type, tier, race, seedStr) {
      const bucket = modelTierBucket(seedStr)
      const key = type + '|' + tier + '|' + bucket
      const recipe = recipeCache.get(key)
      const pal = RACE_PALETTES[race] || RACE_PALETTES.human
      if (!recipe) {
        console.warn('[planet] assets: no recipe for', key, '- returning an empty (invisible) visual')
        return {
          handle: { woodId: null, stoneId: null, roofId: null, bannerId: null, boltId: null },
          boundingRadius: 0.05,
        }
      }

      ensureWoodInstances()
      const woodId = recipe.woodGeoId != null ? woodBatch.addInstance(recipe.woodGeoId) : null
      // Explicit white, not relying on BatchedMesh's own default-white fill
      // — makes the "colors texture lazy-init" gotcha a non-issue regardless
      // of call order (see S4 spike notes): every instance we ever add gets
      // an explicit setColorAt call, full stop.
      if (woodId != null) woodBatch.setColorAt(woodId, WHITE_COLOR)

      ensureStoneInstances()
      const stoneId = recipe.stoneGeoId != null ? stoneBatch.addInstance(recipe.stoneGeoId) : null
      if (stoneId != null) stoneBatch.setColorAt(stoneId, WHITE_COLOR)

      ensureStoneInstances()
      const roofId = recipe.roofGeoId != null ? stoneBatch.addInstance(recipe.roofGeoId) : null
      if (roofId != null) stoneBatch.setColorAt(roofId, new THREE.Color(pal.roof))

      ensureClothInstances()
      const bannerId = recipe.bannerGeoId != null ? clothBatch.addInstance(recipe.bannerGeoId) : null
      if (bannerId != null) clothBatch.setColorAt(bannerId, new THREE.Color(pal.banner))

      let boltId = null
      const boltOn = getOrBuildBoltOn(type, tier, race, seedStr, bucket, recipe.anchors)
      if (boltOn) {
        ensureMetalInstances()
        boltId = metalBatch.addInstance(boltOn.geoId)
      }

      return { handle: { woodId, stoneId, roofId, bannerId, boltId }, boundingRadius: recipe.boundingRadius }
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
      metalMaterial.envMapIntensity = 0.9 + Math.sin(elapsed * 0.5) * 0.04
    }

    return {
      ready: true,
      createStructureVisual,
      setVisualMatrix,
      setVisualVisible,
      removeVisual,
      group,
      update,
    }
  } catch (err) {
    console.warn(
      '[planet] assets: failed to load the building asset pack, falling back to procedural kits —',
      err,
    )
    return { ready: false }
  }
}
