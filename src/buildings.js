// Building kits: structure geometry/material caches, the seven structure-kit
// builders (tower/hall/farm/barracks/observatory/library/forge) plus
// buildKit, the tiny-person figure builder shared by agents and minions,
// race palettes/glyphs/naming, and structure type/tier classification. Split
// out of world.js (see the M2 program plan) along that file's own section
// boundaries — no behavior change, only where this code lives.
import * as THREE from 'three'
import { hash01 } from './util.js'

// ---------------------------------------------------------------------------
// Races, palettes, naming
// ---------------------------------------------------------------------------

export const RACE_KEYS = ['human', 'elf', 'dwarf', 'orc']

export const RACE_PALETTES = {
  human: { cloth: 0x3b5c8c, roof: 0x4a6f9e, banner: 0x2f4d78, skin: 0xd9a066, accent: 0x3b5c8c },
  elf: { cloth: 0x3f7a4a, roof: 0x4f8f5a, banner: 0x2f5f3a, skin: 0xe8caa4, accent: 0x5aa868 },
  dwarf: { cloth: 0x8c3f2e, roof: 0x9c4a30, banner: 0x7a2f22, skin: 0xc97b5a, accent: 0xc9622f },
  orc: { cloth: 0x5a5f66, roof: 0x4f5359, banner: 0x3f4348, skin: 0x6d8f4e, accent: 0x9fb15c },
}

export const RACE_GLYPHS = { human: '⚑', elf: '✦', dwarf: '⚒', orc: '⚔' }

const SUFFIXES = {
  human: ['holm', 'stead', 'burg'],
  elf: ['dell', 'thil', 'lorien'],
  dwarf: ['forge', 'deep', 'helm'],
  orc: ['gash', 'maw', 'grot'],
}

const COLOR_WOOD = 0x8a6242
const COLOR_WHITEWASH = 0xe8e0cc
const COLOR_STONE = 0x8a8274
const COLOR_DARK = 0x2a2420
const COLOR_FIELD_A = 0x8ea34f
const COLOR_FIELD_B = 0xc7a24a
export const COLOR_THATCH = 0xc9a94a
const COLOR_EMBER = 0xff7733
const COLOR_EMBER_EMISSIVE = 0xff5a22
// Cool pale marble — deliberately distinct from COLOR_WHITEWASH's warm cream
// (0xe8e0cc) so the model-tier "grand" trim (assets.js) reads as an added
// material, not a slightly-different wall paint. M-WX model-tier styling.
export const COLOR_MARBLE = 0xecebe6

// Structure keyword routing — order matters, first hit wins.
const TYPE_RULES = [
  ['barracks', ['fix', 'bug', 'debug', 'error']],
  ['farm', ['data', 'pipeline', 'sql', 'dbt', 'table', 'etl']],
  ['observatory', ['research', 'explor', 'investigat', 'analy', 'idea']],
  ['library', ['doc', 'readme', 'report', 'write']],
  ['forge', ['deploy', 'infra', 'docker', 'ci', 'server']],
  ['hall', ['ui', 'design', 'front', 'css', 'page', 'app']],
]
const FALLBACK_TYPES = ['tower', 'hall', 'farm', 'observatory', 'library']

// Authored kit height at the tier-1 (x1) baseline; tier2 = x1.45, tier3 = x2.
// (tier2 values land in the ~0.012-0.028 world-height band the spec asks for.)
export const KIT_UNIT_SIZE = {
  tower: 0.016,
  hall: 0.010,
  farm: 0.009,
  barracks: 0.0095,
  observatory: 0.013,
  library: 0.011,
  forge: 0.0095,
}
export const TIER_MULT = [1, 1.45, 2]

function basenameOf(p) {
  const parts = String(p).split(/[\\/]+/).filter(Boolean)
  return parts.length ? parts[parts.length - 1] : 'world'
}

export function makeSettlementName(project, race) {
  const raw = basenameOf(project)
  let clean = raw.replace(/[^a-zA-Z0-9]/g, '')
  if (!clean) clean = 'Settlement'
  clean = clean.charAt(0).toUpperCase() + clean.slice(1)
  if (clean.length > 12) clean = clean.slice(0, 12)
  const suffixes = SUFFIXES[race]
  const suffix = suffixes[Math.floor(hash01(project + '~suffix') * suffixes.length)]
  return { name: clean + suffix, basenameRaw: raw }
}

export function pickStructureType(topic, id) {
  const t = (topic || '').toLowerCase()
  for (let i = 0; i < TYPE_RULES.length; i++) {
    const type = TYPE_RULES[i][0]
    const words = TYPE_RULES[i][1]
    for (let j = 0; j < words.length; j++) {
      if (t.indexOf(words[j]) !== -1) return type
    }
  }
  return FALLBACK_TYPES[Math.floor(hash01(id) * FALLBACK_TYPES.length)]
}

export function pickTier(bytes) {
  if (bytes < 30000) return 1
  if (bytes < 400000) return 2
  return 3
}

export function truncateText(s, maxLen) {
  const str = String(s == null ? '' : s)
  if (str.length <= maxLen) return str
  return str.slice(0, maxLen - 1) + '…'
}

// ---------------------------------------------------------------------------
// Shared geometry / material caches (never per-instance — see PERFORMANCE)
// ---------------------------------------------------------------------------

const _geomCache = new Map()
function geom(key, factory) {
  let g = _geomCache.get(key)
  if (!g) {
    g = factory()
    _geomCache.set(key, g)
  }
  return g
}

const _matCache = new Map()
function mat(key, factory) {
  let m = _matCache.get(key)
  if (!m) {
    m = factory()
    _matCache.set(key, m)
  }
  return m
}

function stdMat(key, color, extra) {
  return mat(key, () => new THREE.MeshStandardMaterial({ color, flatShading: true, roughness: 0.88, metalness: 0.04, ...extra }))
}

function raceMat(kind, race) {
  const pal = RACE_PALETTES[race]
  if (kind === 'roof') return stdMat('roof_' + race, pal.roof)
  if (kind === 'banner') return stdMat('banner_' + race, pal.banner, { side: THREE.DoubleSide })
  if (kind === 'cloth') return stdMat('cloth_' + race, pal.cloth)
  if (kind === 'skin') return stdMat('skin_' + race, pal.skin)
  return stdMat('accent_' + race, pal.accent, { emissive: pal.accent, emissiveIntensity: 1.1 })
}

export const boxGeo = () => geom('box', () => new THREE.BoxGeometry(1, 1, 1))
const cylGeo = () => geom('cyl6', () => new THREE.CylinderGeometry(0.5, 0.5, 1, 6))
const cylGeo10 = () => geom('cyl10', () => new THREE.CylinderGeometry(0.5, 0.5, 1, 10))
const coneGeo = () => geom('cone6', () => new THREE.ConeGeometry(0.5, 1, 6))
export const sphereGeo = () => geom('sphere8', () => new THREE.SphereGeometry(0.5, 8, 6))
const domeGeo = () => geom('dome8', () => new THREE.SphereGeometry(0.5, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2))
const capsuleGeo = () => geom('capsule', () => new THREE.CapsuleGeometry(0.5, 1, 3, 6))

const woodMat = () => stdMat('wood', COLOR_WOOD)
const whiteMat = () => stdMat('whitewash', COLOR_WHITEWASH)
const stoneMat = () => stdMat('stone', COLOR_STONE)
const darkMat = () => stdMat('dark', COLOR_DARK)
const fieldAMat = () => stdMat('fieldA', COLOR_FIELD_A)
const fieldBMat = () => stdMat('fieldB', COLOR_FIELD_B)
const thatchMat = () => stdMat('thatch', COLOR_THATCH)
const emberMat = () => stdMat('ember', COLOR_EMBER, { emissive: COLOR_EMBER_EMISSIVE, emissiveIntensity: 1.8, roughness: 0.5 })
export const hitMat = () => mat('hit', () => new THREE.MeshBasicMaterial({ color: 0xffffff }))
export const scaffoldMat = () => mat('scaffold', () => new THREE.MeshBasicMaterial({ color: 0x6b4a30, wireframe: true, transparent: true, opacity: 0.85 }))

/** Adds a Mesh child at a local position/scale/rotation. Returns the mesh. */
function part(parent, geometry, material, px, py, pz, sx, sy, sz, rx = 0, ry = 0, rz = 0) {
  const m = new THREE.Mesh(geometry, material)
  m.position.set(px, py, pz)
  m.scale.set(sx, sy, sz)
  if (rx) m.rotation.x = rx
  if (ry) m.rotation.y = ry
  if (rz) m.rotation.z = rz
  parent.add(m)
  return m
}

// ---------------------------------------------------------------------------
// Structure kits — each built from a handful of flat-shaded primitives in
// "local unit" space (roughly 1 unit tall); the caller applies the tier scale.
// ---------------------------------------------------------------------------

export function buildTower(race) {
  const g = new THREE.Group()
  let y = 0
  part(g, cylGeo(), stoneMat(), 0, y + 0.05, 0, 0.62, 0.10, 0.62)
  y += 0.09
  const trunkH = 0.58
  part(g, cylGeo(), whiteMat(), 0, y + trunkH / 2, 0, 0.42, trunkH, 0.42)
  part(g, boxGeo(), darkMat(), 0, y + 0.16, 0.2, 0.1, 0.2, 0.02)
  y += trunkH
  const roofH = 0.46
  part(g, coneGeo(), raceMat('roof', race), 0, y + roofH / 2, 0, 0.56, roofH, 0.56)
  y += roofH
  part(g, sphereGeo(), raceMat('accent', race), 0, y + 0.05, 0, 0.11, 0.11, 0.11)
  return g
}

export function buildHall(race) {
  const g = new THREE.Group()
  let y = 0
  part(g, boxGeo(), stoneMat(), 0, y + 0.03, 0, 0.95, 0.06, 0.62)
  y += 0.05
  const wallH = 0.34
  part(g, boxGeo(), whiteMat(), 0, y + wallH / 2, 0, 0.86, wallH, 0.54)
  part(g, boxGeo(), darkMat(), 0, y + 0.13, 0.275, 0.14, 0.26, 0.03)
  y += wallH
  const roofMat = raceMat('roof', race)
  part(g, boxGeo(), roofMat, 0, y + 0.16, 0.15, 0.92, 0.05, 0.46, 0.55, 0, 0)
  part(g, boxGeo(), roofMat, 0, y + 0.16, -0.15, 0.92, 0.05, 0.46, -0.55, 0, 0)
  return g
}

export function buildFarm(race, rng) {
  const g = new THREE.Group()
  const hutW = 0.3
  part(g, boxGeo(), woodMat(), -0.28, 0.16, -0.05, hutW, 0.32, hutW)
  part(g, coneGeo(), thatchMat(), -0.28, 0.32 + 0.14, -0.05, 0.24, 0.28, 0.24)
  const fieldCount = rng() < 0.5 ? 2 : 3
  const fieldMats = [fieldAMat(), fieldBMat()]
  let fx = 0.1
  for (let i = 0; i < fieldCount; i++) {
    part(g, boxGeo(), fieldMats[i % 2], fx, 0.02, -0.15 + i * 0.16, 0.3, 0.04, 0.32)
    fx += 0.32
  }
  return g
}

export function buildBarracks(race) {
  const g = new THREE.Group()
  let y = 0
  part(g, boxGeo(), stoneMat(), 0, y + 0.03, 0, 1.0, 0.06, 0.4)
  y += 0.05
  const wallH = 0.26
  part(g, boxGeo(), woodMat(), 0, y + wallH / 2, 0, 0.92, wallH, 0.34)
  y += wallH
  part(g, boxGeo(), raceMat('roof', race), 0, y + 0.08, -0.02, 0.98, 0.05, 0.42, 0.22, 0, 0)
  const poleH = 0.5
  part(g, cylGeo(), woodMat(), -0.42, poleH / 2, 0.22, 0.02, poleH, 0.02)
  part(g, boxGeo(), raceMat('banner', race), -0.42, poleH * 0.62, 0.23, 0.02, 0.22, 0.14)
  return g
}

export function buildObservatory(race) {
  const g = new THREE.Group()
  let y = 0
  const baseH = 0.3
  part(g, cylGeo(), stoneMat(), 0, y + baseH / 2, 0, 0.5, baseH, 0.5)
  y += baseH
  const upperH = 0.22
  part(g, cylGeo10(), whiteMat(), 0, y + upperH / 2, 0, 0.4, upperH, 0.4)
  y += upperH
  part(g, domeGeo(), raceMat('roof', race), 0, y, 0, 0.44, 0.36, 0.44)
  part(g, boxGeo(), darkMat(), 0.06, y + 0.1, 0.06, 0.08, 0.08, 0.2)
  part(g, cylGeo(), darkMat(), 0.16, y + 0.2, 0.16, 0.05, 0.34, 0.05, 0, 0, 0.7)
  return g
}

export function buildLibrary(race) {
  const g = new THREE.Group()
  let y = 0
  part(g, boxGeo(), stoneMat(), 0, y + 0.03, 0, 0.86, 0.06, 0.6)
  y += 0.05
  const wallH = 0.36
  part(g, boxGeo(), whiteMat(), 0, y + wallH / 2, 0, 0.78, wallH, 0.52)
  const colH = wallH * 0.9
  part(g, cylGeo(), stoneMat(), -0.28, y + colH / 2, 0.3, 0.05, colH, 0.05)
  part(g, cylGeo(), stoneMat(), 0.28, y + colH / 2, 0.3, 0.05, colH, 0.05)
  y += wallH
  part(g, domeGeo(), raceMat('roof', race), 0, y, 0, 0.64, 0.2, 0.64)
  return g
}

export function buildForge(race, rng) {
  const g = new THREE.Group()
  const hutW = 0.6
  part(g, boxGeo(), stoneMat(), 0, 0.2, 0, hutW, 0.4, 0.44)
  part(g, boxGeo(), darkMat(), 0, 0.42, 0, hutW * 0.95, 0.06, 0.42)
  const y = 0.45
  const chimSide = rng() < 0.5 ? -1 : 1
  part(g, cylGeo(), darkMat(), chimSide * 0.2, y + 0.2, -0.14, 0.09, 0.4, 0.09)
  part(g, boxGeo(), emberMat(), chimSide * 0.2, 0.02, 0.16, 0.12, 0.06, 0.12)
  part(g, boxGeo(), darkMat(), 0, 0.06, 0.28, 0.14, 0.05, 0.09)
  return g
}

export function buildKit(type, race, tier, rng) {
  let g
  if (type === 'tower') g = buildTower(race)
  else if (type === 'hall') g = buildHall(race)
  else if (type === 'farm') g = buildFarm(race, rng)
  else if (type === 'barracks') g = buildBarracks(race)
  else if (type === 'observatory') g = buildObservatory(race)
  else if (type === 'library') g = buildLibrary(race)
  else g = buildForge(race, rng)

  if (tier === 3) {
    // Grand structures fly a race-colored banner from a corner pole.
    const poleH = 0.85
    part(g, cylGeo(), woodMat(), 0.38, poleH / 2, 0.38, 0.025, poleH, 0.025)
    part(g, boxGeo(), raceMat('banner', race), 0.38, poleH * 0.68, 0.38, 0.03, 0.26, 0.16)
  }
  return g
}

// ---------------------------------------------------------------------------
// Tiny people
// ---------------------------------------------------------------------------

export function buildPersonGroup(race) {
  const g = new THREE.Group()
  const cloth = raceMat('cloth', race)
  const skin = raceMat('skin', race)
  const accent = raceMat('accent', race)

  const body = new THREE.Mesh(capsuleGeo(), cloth)
  body.scale.set(0.34, 0.31, 0.34)
  body.position.set(0, 0.31, 0)
  g.add(body)

  const head = new THREE.Mesh(sphereGeo(), skin)
  head.scale.setScalar(0.36)
  head.position.set(0, 0.78, 0)
  g.add(head)

  const dot = new THREE.Mesh(sphereGeo(), accent)
  dot.scale.setScalar(0.075)
  dot.position.set(0, 0.42, 0.14)
  g.add(dot)

  let widthMul = 1
  let heightMul = 1
  if (race === 'dwarf') {
    widthMul = 1.3
    heightMul = 0.75
  } else if (race === 'elf') {
    heightMul = 1.15
  } else if (race === 'orc') {
    widthMul = 1.1
  }
  g.scale.set(widthMul, heightMul, widthMul)

  return g
}

// ---------------------------------------------------------------------------
// M2 asset-kit recipes — consumed by src/assets.js to assemble Kenney/
// Quaternius GLB/glTF parts into merged BatchedMesh geometry. Kept here (not
// in assets.js) so all visual tuning lives in one place alongside the
// palettes/kit sizes above, per the M2 program plan. buildKit() and friends
// above are UNCHANGED and remain the procedural fallback for when the asset
// pack fails to load (assets.js returns { ready: false } in that case).
//
// Coordinates are each vendor's own native module space (Kenney ~1 unit per
// wall module, Quaternius ~2 unit modules / ~3.1 unit wall height); assets.js
// normalizes every merged (type,tier) recipe to the same "roughly 1 unit
// tall" authored convention buildTower/buildHall/etc. use above, so
// KIT_UNIT_SIZE/TIER_MULT keep applying unchanged to either path — the asset
// path is not a second, independently-tuned size system.
// ---------------------------------------------------------------------------

export const ASSET_BASE = '/models/'

// Color role -> hex, reusing the exact flat palette the procedural kits use.
export const ROLE_COLOR = {
  wood: COLOR_WOOD,
  whitewash: COLOR_WHITEWASH,
  stone: COLOR_STONE,
  dark: COLOR_DARK,
  field: COLOR_FIELD_A,
}
// 'roof' and 'banner' are the two TINTABLE roles: assets.js bakes them as
// pure white vertex color and applies the race palette via BatchedMesh's
// per-instance setColorAt at createStructureVisual time. Every role in
// ROLE_COLOR above is baked as a fixed neutral color and never tinted —
// mirrors raceMat() only touching 'roof'/'banner'/'accent' above.
export const TINTABLE_ROLES = ['roof', 'banner']

// Material-CLASS mapping (M-WX "material-distinction" pass — the "clay/
// play-dough" fix, ART.md's owner complaint: every building shared one
// matte skin). assets.js splits its BatchedMesh-per-material-class so each
// class gets its own roughness/metalness/envMapIntensity/micro-albedo
// response instead of one flat treatment for every part. Three matte
// classes here (a fourth, brass/copper/bronze, is handled entirely inside
// assets.js — it's always procedural bolt-on geometry, never role-routed):
//   wood  — timber walls/trim + organic greenery (hedges); warm, low sheen.
//   stone — masonry walls/trim AND roofing (tile/thatch reads as a rigid,
//           matte, non-organic surface materially closer to stone than to
//           wood or cloth — hence "stone+thatch" as one class) + dark iron/
//           chimney/ornament trim, which is too small-area to earn its own
//           class and is optically closer to matte masonry than to brass.
//   cloth — banners/fabric; fully diffuse, no sheen at all.
// 'roof' and 'banner' stay TINTABLE within their class (see TINTABLE_ROLES
// above) — the class split does not change which roles get race-tinted.
export const ROLE_CLASS = {
  wood: 'wood',
  field: 'wood',
  stone: 'stone',
  whitewash: 'stone',
  dark: 'stone',
  roof: 'stone',
  banner: 'cloth',
}
export const MATERIAL_CLASSES = ['wood', 'stone', 'cloth']

// Kenney parts all carry one generic "colormap" material (no semantic name —
// see public/models/SOURCES.md), so color role is decided by filename
// substring, first match wins, default 'stone' (most Kenney parts used here
// are the unpainted stone wall/roof family).
export const KENNEY_PART_ROLES = [
  ['roof', 'roof'],
  ['banner', 'banner'],
  ['chimney', 'dark'],
  ['lantern', 'dark'],
  ['wood', 'wood'],
  ['fence', 'wood'],
  ['hedge', 'field'],
  ['stall', 'wood'],
  ['plank', 'wood'],
  ['pole', 'wood'],
  ['overhang', 'wood'],
  ['cart', 'wood'],
]
export const KENNEY_DEFAULT_ROLE = 'stone'

// Quaternius parts keep their descriptive per-primitive material NAME
// (textures/samplers/images stripped, name preserved — see SOURCES.md) —
// role decided by that name, first match wins, same 'stone' default.
export const MATERIAL_NAME_ROLES = [
  ['RoundTiles', 'roof'],
  ['WoodTrim', 'wood'],
  ['Plaster', 'whitewash'],
  ['UnevenBrick', 'stone'],
  ['RockTrim', 'stone'],
  ['Brick', 'stone'],
  ['MetalOrnaments', 'dark'],
]

// --- Kenney recipes: tier1 "modest" / tier2 "bigger, extended" -------------
// Each part: { u: filename in public/models/kenney/, x,y,z: local position,
// ry: Y rotation radians }. Kenney wall parts are pre-offset to their own
// 1x1 cell edge, so a plain 4-way ring only needs to rotate about a shared
// origin (no per-side XZ offset) — same convention spikes/s5/scene.js used.
const kPart = (u, x, y, z, ry = 0) => ({ u, x, y, z, ry })
const RING_RY = [0, Math.PI / 2, Math.PI, -Math.PI / 2]
function kRing(urls, y) {
  return urls.map((u, i) => kPart(u, 0, y, 0, RING_RY[i]))
}

export const KIT_RECIPES = {
  tower: {
    tier1: [...kRing(['wall-door.glb', 'wall-block.glb', 'wall-block.glb', 'wall-window-shutters.glb'], 0), kPart('roof-high-point.glb', 0, 1, 0)],
    tier2: [
      ...kRing(['wall-door.glb', 'wall-block.glb', 'wall-block.glb', 'wall-window-shutters.glb'], 0),
      ...kRing(['wall-block.glb', 'wall-window-shutters.glb', 'wall-block.glb', 'wall-window-shutters.glb'], 1),
      kPart('roof-high-point.glb', 0, 2, 0),
      kPart('pillar-stone.glb', 0.62, 0, 0.55),
      kPart('pillar-stone.glb', -0.62, 0, 0.55),
    ],
  },
  hall: {
    tier1: [
      ...kRing(['wall-wood-door.glb', 'wall-wood-block.glb', 'wall-wood-block.glb', 'wall-wood-window-shutters.glb'], 0),
      kPart('roof-high-gable.glb', 0, 1, 0),
      kPart('chimney-base.glb', -0.25, 0.75, -0.25),
      kPart('chimney.glb', -0.25, 1.75, -0.25),
    ],
    tier2: [
      ...kRing(['wall-wood-door.glb', 'wall-wood-block.glb', 'wall-wood-block.glb', 'wall-wood-window-shutters.glb'], 0),
      kPart('roof-high-gable.glb', 0, 1, 0),
      kPart('roof-gable-top.glb', 0, 1.85, 0),
      kPart('chimney-base.glb', -0.25, 0.75, -0.25),
      kPart('chimney.glb', -0.25, 1.75, -0.25),
      kPart('overhang.glb', 0, 1.0, 0.55),
      kPart('pillar-wood.glb', 0.38, 0, 0.6),
      kPart('pillar-wood.glb', -0.38, 0, 0.6),
    ],
  },
  farm: {
    tier1: [
      ...kRing(['wall-wood-door.glb', 'wall-wood-block.glb', 'wall-wood-block.glb', 'wall-wood-block.glb'], 0),
      kPart('roof-gable.glb', 0, 1, 0),
      kPart('hedge.glb', 0.9, 0, -0.45, Math.PI / 2),
      kPart('hedge.glb', 0.9, 0, -0.1, Math.PI / 2),
      kPart('hedge.glb', 0.9, 0, 0.25, Math.PI / 2),
      kPart('fence-gate.glb', 0.9, 0, 0.6, Math.PI / 2),
    ],
    tier2: [
      ...kRing(['wall-wood-door.glb', 'wall-wood-block.glb', 'wall-wood-block.glb', 'wall-wood-block.glb'], 0),
      kPart('roof-gable.glb', 0, 1, 0),
      kPart('hedge.glb', 0.9, 0, -0.6, Math.PI / 2),
      kPart('hedge.glb', 0.9, 0, -0.25, Math.PI / 2),
      kPart('hedge.glb', 0.9, 0, 0.1, Math.PI / 2),
      kPart('hedge.glb', 0.9, 0, 0.45, Math.PI / 2),
      kPart('fence-gate.glb', 0.9, 0, 0.8, Math.PI / 2),
      kPart('cart.glb', -0.85, 0, 0.55, 0.4),
      kPart('stall.glb', -0.8, 0, -0.55, -0.5),
    ],
  },
  barracks: {
    tier1: [...kRing(['wall-door.glb', 'wall-block.glb', 'wall-block.glb', 'wall-block.glb'], 0), kPart('roof-flat.glb', 0, 1, 0), kPart('banner-red.glb', 0.55, 0, 0.55)],
    tier2: [
      ...kRing(['wall-door.glb', 'wall-block.glb', 'wall-block.glb', 'wall-block.glb'], 0),
      kPart('roof-flat.glb', 0, 1, 0),
      kPart('banner-red.glb', 0.55, 0, 0.55),
      kPart('banner-green.glb', -0.55, 0, 0.55),
      kPart('stairs-stone.glb', 0, 0, 0.65),
      kPart('fence-gate.glb', 0, 0, 0.95),
    ],
  },
  observatory: {
    tier1: [
      ...kRing(['wall-door.glb', 'wall-block.glb', 'wall-window-glass.glb', 'wall-window-glass.glb'], 0),
      kPart('roof-corner-round.glb', 0, 1, 0),
      kPart('pillar-stone.glb', 0.55, 0, 0.55),
      kPart('pillar-stone.glb', -0.55, 0, 0.55),
    ],
    tier2: [
      ...kRing(['wall-door.glb', 'wall-block.glb', 'wall-window-glass.glb', 'wall-window-glass.glb'], 0),
      ...kRing(['wall-window-glass.glb', 'wall-window-glass.glb', 'wall-window-glass.glb', 'wall-window-glass.glb'], 1),
      kPart('roof-high-corner-round.glb', 0, 2, 0),
      kPart('pillar-stone.glb', 0.55, 0, 0.55),
      kPart('pillar-stone.glb', -0.55, 0, 0.55),
      kPart('stairs-stone.glb', 0, 0, 0.65),
    ],
  },
  library: {
    tier1: [
      ...kRing(['wall-door.glb', 'wall-window-glass.glb', 'wall-block.glb', 'wall-window-glass.glb'], 0),
      kPart('roof-flat.glb', 0, 1, 0),
      kPart('pillar-stone.glb', 0.6, 0, 0.55),
      kPart('pillar-stone.glb', -0.6, 0, 0.55),
    ],
    tier2: [
      ...kRing(['wall-door.glb', 'wall-window-glass.glb', 'wall-block.glb', 'wall-window-glass.glb'], 0),
      kPart('roof-flat.glb', 0, 1, 0),
      kPart('roof-gable-top.glb', 0, 1.8, 0),
      kPart('pillar-stone.glb', 0.6, 0, 0.55),
      kPart('pillar-stone.glb', -0.6, 0, 0.55),
      kPart('pillar-stone.glb', 0.35, 0, 0.62),
      kPart('pillar-stone.glb', -0.35, 0, 0.62),
      kPart('stairs-stone.glb', 0, 0, 0.7),
    ],
  },
  forge: {
    tier1: [
      ...kRing(['wall-door.glb', 'wall-block.glb', 'wall-block.glb', 'wall-block.glb'], 0),
      kPart('roof-flat.glb', 0, 1, 0),
      kPart('chimney-base.glb', 0.22, 0.75, -0.2),
      kPart('chimney.glb', 0.22, 1.75, -0.2),
    ],
    tier2: [
      ...kRing(['wall-door.glb', 'wall-block.glb', 'wall-block.glb', 'wall-block.glb'], 0),
      kPart('roof-flat.glb', 0, 1, 0),
      kPart('chimney-base.glb', 0.22, 0.75, -0.2),
      kPart('chimney.glb', 0.22, 1.75, -0.2),
      kPart('chimney-base.glb', -0.22, 0.75, -0.22),
      kPart('chimney.glb', -0.22, 1.75, -0.22),
      kPart('planks.glb', 0.6, 0, 0.5),
      kPart('stairs-stone.glb', 0, 0, 0.65),
    ],
  },
}

// --- Quaternius tier-3 "grand" recipe: shared shell, per-type roof swap ----
// The shell is the exact wall+chimney assembly spikes/s5/scene.js validated
// (buildQuaterniusHouse); every type shares it (all 7 tier-3 buildings are
// the same grand footprint) and only the roof + bolt-on set differ per type,
// per the M2 art verdict ("Quaternius reserved for grand tier-3 landmarks").
const qPart = (u, x, y, z, ry = 0) => ({ u, x, y, z, ry })
const Q_WALL_TOP_Y = 3.1227
const QUATERNIUS_SHELL = [
  qPart('Wall_UnevenBrick_Door_Flat.gltf', 0, 0, 1, 0),
  qPart('Wall_UnevenBrick_Straight.gltf', 0, 0, -1, Math.PI),
  qPart('Wall_UnevenBrick_Window_Wide_Flat.gltf', -1, 0, 0, -Math.PI / 2),
  qPart('Wall_UnevenBrick_Straight.gltf', 1, 0, 0, Math.PI / 2),
  qPart('Prop_Chimney.gltf', -0.6, Q_WALL_TOP_Y, -0.6, 0),
]
const QUATERNIUS_ROOF_DEFAULT = [qPart('Roof_Wooden_2x1_Center.gltf', 0, Q_WALL_TOP_Y, 0, 0), qPart('Roof_Wooden_2x1_Center.gltf', 0, Q_WALL_TOP_Y, 0, Math.PI)]
const QUATERNIUS_ROOF_TOWER = [qPart('Roof_Tower_RoundTiles.gltf', 0, Q_WALL_TOP_Y, 0, 0)]

export const GRAND_RECIPES = {}
for (const gtype of ['tower', 'hall', 'farm', 'barracks', 'observatory', 'library', 'forge']) {
  GRAND_RECIPES[gtype] = [...QUATERNIUS_SHELL, ...(gtype === 'tower' ? QUATERNIUS_ROOF_TOWER : QUATERNIUS_ROOF_DEFAULT)]
}

// --- Steampunk bolt-on density, per §0.5 (dwarf full-industrial, human
// medieval-clockwork, orc scrap-punk, elf organic/least) -------------------
// Tier 1-2 get exactly the listed kinds (count IS the density signal); tier 3
// always gets the full {gear,pipe,tank} set plus an optional 2nd gear for the
// races with the densest machinery.
export const BOLT_ON_KINDS_BY_RACE = {
  dwarf: ['gear', 'pipe', 'tank'],
  human: ['gear', 'pipe'],
  orc: ['pipe', 'tank'],
  elf: ['gear'],
}
export const BOLT_ON_SECOND_GEAR_RACES = ['dwarf', 'orc']

// --- Model-tier styling (M-WX carryover) -----------------------------------
// world.js folds the session's model into assets.js's createStructureVisual
// seedStr as a trailing ":<model>" suffix (id + ':' + (model || '')) — model
// is one of server/scan.js's MODEL_TIERS ('fable'|'opus'|'sonnet'|'haiku') or
// '' when unknown. assets.js parses that suffix and buckets it into one of
// three geometry VARIANTS via the table below; 'sonnet' and unrecognized/
// empty hints both fall through to the implicit 'base' bucket (no entry
// needed — assets.js defaults any unmapped hint to 'base').
//   grand  (fable, opus — the top-tier models): a marble-white trim band
//          (COLOR_MARBLE) added just under the roofline + the whole
//          structure stretched GRAND_HEIGHT_MULT taller.
//   humble (haiku — the lightweight model): the roof re-baked from the
//          race-tinted 'roof' role to a fixed neutral thatch color
//          (COLOR_THATCH, i.e. no longer race-tintable for this variant)
//          + the whole structure stretched HUMBLE_HEIGHT_MULT shorter.
//   base   (sonnet / unknown / no model recorded yet): today's recipe,
//          unchanged.
// Deliberately small/legible, not a rebuild — see ART.md §1 "reads clearly
// at every zoom" and §2.3's saturation budget, neither of which this touches
// (only silhouette height + one neutral-vs-tinted material swap).
export const MODEL_TIER_BUCKET = { fable: 'grand', opus: 'grand', haiku: 'humble' }
export const GRAND_HEIGHT_MULT = 1.12
export const HUMBLE_HEIGHT_MULT = 0.94
