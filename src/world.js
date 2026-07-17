// The living-world module: settlements, buildings, tiny working people, and
// labels, scattered deterministically across the planet from the Claude Code
// session history. Everything a user will ever see here is derived from
// string hashes (project path, session id) so relaunching the app rebuilds
// the identical village layout, then a 4s poll layers live activity on top.
import * as THREE from 'three'
import { SEA_LEVEL, hash01, rngFromString, clamp, lerp, smoothstep } from './util.js'

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

const MAX_BUILD_HEIGHT = SEA_LEVEL + 0.03 // sampleHeight() must be below this to build/walk

const POLL_INTERVAL = 4 // seconds between /api/sessions polls
const CONSTRUCTION_DURATION = 45 // seconds a fresh structure takes to "grow in"
const CONSTRUCTION_NEW_MAX_MS = 5 * 60 * 1000 // session must be this fresh to animate construction
const LABEL_THROTTLE = 0.3 // seconds between topic-label visibility checks
const TOPIC_VISIBLE_DIST = 0.5 // camera must be this close (world units) to see a topic label

const ANCHOR_SEARCH_TRIES = 600
const ANCHOR_STEP = 0.05
const STRUCT_SEARCH_RADIUS = 0.05
const STRUCT_MIN_SEP = 0.012
const STRUCT_SEARCH_HARD_CAP = 400

const AGENT_SPEED = 0.010 // rad/s baseline walking angular speed
const WORKING_MAX_MS = 3 * 60 * 1000
const AGENT_MAX_MS = 10 * 60 * 1000

const PERSON_HEIGHT = 0.0055
const BOB_WALK = PERSON_HEIGHT * 0.16
const BOB_HAMMER = PERSON_HEIGHT * 0.30
const BOB_IDLE = PERSON_HEIGHT * 0.05
const FOOT_LIFT = PERSON_HEIGHT * 0.05

const CLICK_MOVE_THRESHOLD = 6 // px
const TWEEN_DURATION = 1.1 // seconds

const SETTLEMENT_LABEL_K = 0.022
const SETTLEMENT_LABEL_MIN = 0.006
const SETTLEMENT_LABEL_MAX = 0.085
const TOPIC_LABEL_K = 0.02
const TOPIC_LABEL_MIN = 0.0045
const TOPIC_LABEL_MAX = 0.028
const TOPIC_LABEL_REF_DIST = 1.15 // representative "up close" distance used to size topic labels once

const BUBBLE_MAX_CHARS = 42 // speech-bubble text truncation
const BUBBLE_VISIBLE_DIST = 0.35 // camera must be this close (world units) to see a speech bubble
const BUBBLE_OFFSET = 0.004 // world units above the agent's ground position

const SPARK_POOL_SIZE = 120 // shared additive-particle budget for ALL agents' hammer sparks
const SPARK_BURST_MIN = 5
const SPARK_BURST_MAX = 8
const SPARK_TTL = 0.55 // seconds a spark particle lives
const SPARK_GRAVITY = 0.015 // gravity-lite pull back toward the surface, world units/s^2
const SPARK_COOLDOWN_MIN = 0.35 // seconds between bursts from the same hammering agent
const SPARK_COOLDOWN_RANGE = 0.25

const MINION_MAX = 6 // subagent workers rendered per session, even if the real count is higher
const MINION_SCALE = 0.5 // half-size vs a normal worker

const STRUCT_HIT_RADIUS = 0.012 // invisible click-target sphere radius per structure

// ---------------------------------------------------------------------------
// Races, palettes, naming
// ---------------------------------------------------------------------------

const RACE_KEYS = ['human', 'elf', 'dwarf', 'orc']

const RACE_PALETTES = {
  human: { cloth: 0x3b5c8c, roof: 0x4a6f9e, banner: 0x2f4d78, skin: 0xd9a066, accent: 0x3b5c8c },
  elf: { cloth: 0x3f7a4a, roof: 0x4f8f5a, banner: 0x2f5f3a, skin: 0xe8caa4, accent: 0x5aa868 },
  dwarf: { cloth: 0x8c3f2e, roof: 0x9c4a30, banner: 0x7a2f22, skin: 0xc97b5a, accent: 0xc9622f },
  orc: { cloth: 0x5a5f66, roof: 0x4f5359, banner: 0x3f4348, skin: 0x6d8f4e, accent: 0x9fb15c },
}

const RACE_GLYPHS = { human: '⚑', elf: '✦', dwarf: '⚒', orc: '⚔' }

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
const COLOR_THATCH = 0xc9a94a
const COLOR_EMBER = 0xff7733
const COLOR_EMBER_EMISSIVE = 0xff5a22

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
const KIT_UNIT_SIZE = {
  tower: 0.016,
  hall: 0.010,
  farm: 0.009,
  barracks: 0.0095,
  observatory: 0.013,
  library: 0.011,
  forge: 0.0095,
}
const TIER_MULT = [1, 1.45, 2]

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

const boxGeo = () => geom('box', () => new THREE.BoxGeometry(1, 1, 1))
const cylGeo = () => geom('cyl6', () => new THREE.CylinderGeometry(0.5, 0.5, 1, 6))
const cylGeo10 = () => geom('cyl10', () => new THREE.CylinderGeometry(0.5, 0.5, 1, 10))
const coneGeo = () => geom('cone6', () => new THREE.ConeGeometry(0.5, 1, 6))
const sphereGeo = () => geom('sphere8', () => new THREE.SphereGeometry(0.5, 8, 6))
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
const hitMat = () => mat('hit', () => new THREE.MeshBasicMaterial({ color: 0xffffff }))
const scaffoldMat = () => mat('scaffold', () => new THREE.MeshBasicMaterial({ color: 0x6b4a30, wireframe: true, transparent: true, opacity: 0.85 }))

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
// Spherical math helpers (pure — no dependency on the live planet/world state)
// ---------------------------------------------------------------------------

const _tb1 = new THREE.Vector3()
const _tb2 = new THREE.Vector3()

/** Arbitrary orthonormal tangent basis at a point on the unit sphere. */
function tangentBasis(dir, outT1, outT2) {
  if (Math.abs(dir.y) < 0.999) outT1.set(0, 1, 0).cross(dir).normalize()
  else outT1.set(1, 0, 0).cross(dir).normalize()
  outT2.crossVectors(dir, outT1).normalize()
}

/** Writes into `out` the point `dist` radians from `base` along `bearing`. */
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

/** A unit tangent at `dir` rotated to bearing `yaw` — used to give structures a facing. */
function yawedTangent(dir, yaw, out) {
  tangentBasis(dir, _tb1, _tb2)
  const cb = Math.cos(yaw)
  const sb = Math.sin(yaw)
  return out.set(_tb1.x * cb + _tb2.x * sb, _tb1.y * cb + _tb2.y * sb, _tb1.z * cb + _tb2.z * sb).normalize()
}

/** Moves `current` at most `maxAngle` radians toward `target` along the great circle. Returns true if arrived. */
function stepToward(current, target, maxAngle) {
  const d = clamp(current.dot(target), -1, 1)
  const angle = Math.acos(d)
  if (angle < 1e-5) return true
  const t = Math.min(1, maxAngle / angle)
  current.lerp(target, t).normalize()
  return t >= 1
}

const _up = new THREE.Vector3()
const _right = new THREE.Vector3()
const _fwd = new THREE.Vector3()
const _basisMat = new THREE.Matrix4()

/** Orients `object` so local +Y matches the surface normal `dir` and local +Z faces `forwardHint`. */
function orientOnSurface(object, dir, forwardHint) {
  _up.copy(dir).normalize()
  _fwd.copy(forwardHint)
  _fwd.addScaledVector(_up, -_fwd.dot(_up))
  if (_fwd.lengthSq() < 1e-10) {
    _fwd.set(1, 0, 0).addScaledVector(_up, -_up.x)
    if (_fwd.lengthSq() < 1e-10) _fwd.set(0, 0, 1)
  }
  _fwd.normalize()
  _right.crossVectors(_up, _fwd).normalize()
  _fwd.crossVectors(_right, _up).normalize()
  _basisMat.makeBasis(_right, _up, _fwd)
  object.quaternion.setFromRotationMatrix(_basisMat)
}

// ---------------------------------------------------------------------------
// Silent-fallback rule: every graceful-degradation path warns exactly once
// (module-level flags — these searches run per-settlement/per-structure and
// the ingest/poll paths repeat every 4s, so a plain warn would spam).
// ---------------------------------------------------------------------------
let warnedLandAnchorFallback = false
let warnedStructureSpotFallback = false
let warnedLandNearFallback = false
let warnedIngestSkip = false
let warnedPoll = false
let warnedStructureClickCb = false

function warnIngestSkip(reason) {
  if (warnedIngestSkip) return
  warnedIngestSkip = true
  console.warn('[planet] world.js: session ingest degraded — skipped a malformed session entry (' + reason + ')')
}

function warnPoll(reason) {
  if (warnedPoll) return
  warnedPoll = true
  console.warn('[planet] world.js: session poll degraded — ' + reason)
}

function findLandAnchor(planet, base, rng) {
  const dir = base.clone()
  for (let i = 0; i <= ANCHOR_SEARCH_TRIES; i++) {
    if (planet.isLand(dir) && planet.sampleHeight(dir) < MAX_BUILD_HEIGHT) return dir
    if (i === ANCHOR_SEARCH_TRIES) break
    dir.set(dir.x + (rng() - 0.5) * ANCHOR_STEP, dir.y + (rng() - 0.5) * ANCHOR_STEP, dir.z + (rng() - 0.5) * ANCHOR_STEP).normalize()
  }
  if (!warnedLandAnchorFallback) {
    warnedLandAnchorFallback = true
    console.warn('[planet] world.js: settlement anchor placement degraded — exhausted search budget, using best-effort location (may be underwater or above build height)')
  }
  return dir // best-effort last (island worlds happen)
}

function findStructureSpot(planet, anchorDir, rng, siblings) {
  let radius = STRUCT_SEARCH_RADIUS
  let minSep = STRUCT_MIN_SEP
  const dir = new THREE.Vector3()
  let fallback = null
  for (let tries = 1; tries <= STRUCT_SEARCH_HARD_CAP; tries++) {
    const bearing = rng() * Math.PI * 2
    const dist = Math.sqrt(rng()) * radius
    sphericalOffset(dir, anchorDir, bearing, dist)
    if (!fallback) fallback = dir.clone()
    if (planet.isLand(dir) && planet.sampleHeight(dir) < MAX_BUILD_HEIGHT) {
      let ok = true
      for (let i = 0; i < siblings.length; i++) {
        if (dir.angleTo(siblings[i]) < minSep) {
          ok = false
          break
        }
      }
      if (ok) return dir.clone()
    }
    if (tries % 80 === 0) {
      minSep *= 0.82
      radius = Math.min(radius * 1.15, 0.14)
    }
  }
  if (!warnedStructureSpotFallback) {
    warnedStructureSpotFallback = true
    console.warn('[planet] world.js: structure placement degraded — exhausted search budget, using fallback spot (may overlap a sibling or sit on unsuitable ground)')
  }
  return fallback || anchorDir.clone()
}

function randomLandNear(planet, center, rng, maxRadius) {
  const out = new THREE.Vector3()
  let fallback = null
  for (let i = 0; i < 120; i++) {
    const bearing = rng() * Math.PI * 2
    const dist = Math.sqrt(rng()) * maxRadius
    sphericalOffset(out, center, bearing, dist)
    if (!fallback) fallback = out.clone()
    if (planet.isLand(out) && planet.sampleHeight(out) < MAX_BUILD_HEIGHT) return out.clone()
  }
  if (!warnedLandNearFallback) {
    warnedLandNearFallback = true
    console.warn('[planet] world.js: agent wander-point placement degraded — exhausted search budget, using fallback location (may be underwater or above build height)')
  }
  return fallback || center.clone()
}

// ---------------------------------------------------------------------------
// Naming / classification
// ---------------------------------------------------------------------------

function basenameOf(p) {
  const parts = String(p).split(/[\\/]+/).filter(Boolean)
  return parts.length ? parts[parts.length - 1] : 'world'
}

function makeSettlementName(project, race) {
  const raw = basenameOf(project)
  let clean = raw.replace(/[^a-zA-Z0-9]/g, '')
  if (!clean) clean = 'Settlement'
  clean = clean.charAt(0).toUpperCase() + clean.slice(1)
  if (clean.length > 12) clean = clean.slice(0, 12)
  const suffixes = SUFFIXES[race]
  const suffix = suffixes[Math.floor(hash01(project + '~suffix') * suffixes.length)]
  return { name: clean + suffix, basenameRaw: raw }
}

function pickStructureType(topic, id) {
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

function pickTier(bytes) {
  if (bytes < 30000) return 1
  if (bytes < 400000) return 2
  return 3
}

function truncateText(s, maxLen) {
  const str = String(s == null ? '' : s)
  if (str.length <= maxLen) return str
  return str.slice(0, maxLen - 1) + '…'
}

// ---------------------------------------------------------------------------
// Canvas label sprites (topic text is untrusted — always drawn via fillText)
// ---------------------------------------------------------------------------

const LABEL_FONT = 'system-ui, -apple-system, "Segoe UI", Helvetica, sans-serif'

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + w - r, y)
  ctx.quadraticCurveTo(x + w, y, x + w, y + r)
  ctx.lineTo(x + w, y + h - r)
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
  ctx.lineTo(x + r, y + h)
  ctx.quadraticCurveTo(x, y + h, x, y + h - r)
  ctx.lineTo(x, y + r)
  ctx.quadraticCurveTo(x, y, x + r, y)
  ctx.closePath()
}

function buildSettlementCanvas(glyph, name, basenameRaw, accentCss) {
  const titleSize = 46
  const subSize = 30
  const padX = 26
  const padY = 18
  const gap = 6

  const meas = document.createElement('canvas').getContext('2d')
  const titleText = glyph + '  ' + name
  meas.font = '700 ' + titleSize + 'px ' + LABEL_FONT
  const titleW = meas.measureText(titleText).width
  meas.font = '500 ' + subSize + 'px ' + LABEL_FONT
  const subW = meas.measureText(basenameRaw).width

  const width = Math.ceil(Math.max(titleW, subW) + padX * 2)
  const height = Math.ceil(titleSize + subSize + gap + padY * 2)

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')

  ctx.fillStyle = 'rgba(16,14,20,0.55)'
  roundRectPath(ctx, 1, 1, width - 2, height - 2, 18)
  ctx.fill()
  ctx.strokeStyle = accentCss
  ctx.lineWidth = 3
  roundRectPath(ctx, 1.5, 1.5, width - 3, height - 3, 18)
  ctx.stroke()

  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  ctx.fillStyle = '#f6ecd9'
  ctx.font = '700 ' + titleSize + 'px ' + LABEL_FONT
  ctx.fillText(titleText, width / 2, padY)

  ctx.fillStyle = 'rgba(216,206,196,0.72)'
  ctx.font = '500 ' + subSize + 'px ' + LABEL_FONT
  ctx.fillText(basenameRaw, width / 2, padY + titleSize + gap)

  return { canvas, aspect: width / height }
}

function buildTopicCanvas(text) {
  const size = 30
  const padX = 18
  const padY = 12

  const meas = document.createElement('canvas').getContext('2d')
  meas.font = '600 ' + size + 'px ' + LABEL_FONT
  const w = meas.measureText(text).width

  const width = Math.ceil(w + padX * 2)
  const height = Math.ceil(size + padY * 2)

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')

  ctx.fillStyle = 'rgba(14,13,18,0.62)'
  roundRectPath(ctx, 1, 1, width - 2, height - 2, 12)
  ctx.fill()

  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  ctx.fillStyle = '#eee6d6'
  ctx.font = '600 ' + size + 'px ' + LABEL_FONT
  ctx.fillText(text, width / 2, padY)

  return { canvas, aspect: width / height }
}

function makeSettlementSprite(glyph, name, basenameRaw, accentCss) {
  const { canvas, aspect } = buildSettlementCanvas(glyph, name, basenameRaw, accentCss)
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  const material = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false })
  const sprite = new THREE.Sprite(material)
  sprite.center.set(0.5, 0)
  sprite.userData.aspect = aspect
  return sprite
}

function makeTopicSprite(text) {
  const { canvas, aspect } = buildTopicCanvas(text)
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  const material = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false })
  const sprite = new THREE.Sprite(material)
  sprite.center.set(0.5, 0)
  sprite.userData.aspect = aspect
  return sprite
}

function refreshTopicSprite(sprite, text) {
  const { canvas, aspect } = buildTopicCanvas(text)
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  sprite.material.map.dispose()
  sprite.material.map = tex
  sprite.material.needsUpdate = true
  sprite.userData.aspect = aspect
}

// Small rounded speech-bubble with a tail pointing down at the speaker.
// Text is untrusted (session lastAction) — canvas fillText only, same as topics.
function buildBubbleCanvas(text) {
  const size = 22
  const padX = 14
  const padY = 9
  const tail = 7

  const meas = document.createElement('canvas').getContext('2d')
  meas.font = '600 ' + size + 'px ' + LABEL_FONT
  const w = meas.measureText(text).width

  const width = Math.ceil(w + padX * 2)
  const bodyH = Math.ceil(size + padY * 2)
  const height = bodyH + tail

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')

  ctx.fillStyle = 'rgba(20,18,26,0.75)'
  roundRectPath(ctx, 1, 1, width - 2, bodyH - 2, 10)
  ctx.fill()
  ctx.beginPath()
  ctx.moveTo(width / 2 - tail, bodyH - 2)
  ctx.lineTo(width / 2 + tail, bodyH - 2)
  ctx.lineTo(width / 2, bodyH - 2 + tail)
  ctx.closePath()
  ctx.fill()

  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  ctx.fillStyle = '#f6ecd9'
  ctx.font = '600 ' + size + 'px ' + LABEL_FONT
  ctx.fillText(text, width / 2, padY)

  return { canvas, aspect: width / height }
}

function makeBubbleSprite(text) {
  const { canvas, aspect } = buildBubbleCanvas(text)
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  const material = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false })
  const sprite = new THREE.Sprite(material)
  sprite.center.set(0.5, 0)
  sprite.userData.aspect = aspect
  sprite.renderOrder = 2
  return sprite
}

function refreshBubbleSprite(sprite, text) {
  const { canvas, aspect } = buildBubbleCanvas(text)
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  sprite.material.map.dispose()
  sprite.material.map = tex
  sprite.material.needsUpdate = true
  sprite.userData.aspect = aspect
}

function applyLabelScale(sprite, dist, k, min, max) {
  const s = clamp(dist * k, min, max)
  const aspect = sprite.userData.aspect || 2
  sprite.scale.set(s * aspect, s, 1)
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

function buildPersonGroup(race) {
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
// createWorld
// ---------------------------------------------------------------------------

export function createWorld(planet, camera, domElement) {
  const group = new THREE.Group()
  const settlementsGroup = new THREE.Group()
  const structuresGroup = new THREE.Group()
  const agentsGroup = new THREE.Group()

  // City lights: one warm additive speck per structure, so settlements
  // twinkle on the night side (bloom gives them their halo). Rebuilt
  // whenever the structure count changes.
  const townLightsMat = new THREE.PointsMaterial({
    color: 0xffc66e,
    size: 2.4,
    sizeAttenuation: false,
    transparent: true,
    opacity: 0.85,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  })
  let townLights = null
  let townLightCount = -1
  function rebuildTownLights() {
    townLightCount = structures.size
    if (townLights) {
      structuresGroup.remove(townLights)
      townLights.geometry.dispose()
    }
    const positions = new Float32Array(structures.size * 3)
    let i = 0
    for (const st of structures.values()) {
      positions[i * 3] = st.structureRoot.position.x + st.dir.x * 0.004
      positions[i * 3 + 1] = st.structureRoot.position.y + st.dir.y * 0.004
      positions[i * 3 + 2] = st.structureRoot.position.z + st.dir.z * 0.004
      i++
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    townLights = new THREE.Points(geo, townLightsMat)
    townLights.renderOrder = 1
    structuresGroup.add(townLights)
  }
  group.add(settlementsGroup, structuresGroup, agentsGroup)

  // Hammer sparks: one shared additive-particle pool for every agent's
  // hammering animation, round-robin allocated so a burst never allocates.
  const sparkPositions = new Float32Array(SPARK_POOL_SIZE * 3)
  const sparkColors = new Float32Array(SPARK_POOL_SIZE * 3)
  const sparkVelocity = new Float32Array(SPARK_POOL_SIZE * 3)
  const sparkDown = new Float32Array(SPARK_POOL_SIZE * 3)
  const sparkAge = new Float32Array(SPARK_POOL_SIZE)
  const sparkTtl = new Float32Array(SPARK_POOL_SIZE) // 0 = free/dead slot
  let sparkCursor = 0
  const sparkGeo = new THREE.BufferGeometry()
  sparkGeo.setAttribute('position', new THREE.BufferAttribute(sparkPositions, 3))
  sparkGeo.setAttribute('color', new THREE.BufferAttribute(sparkColors, 3))
  const sparkPointsMat = new THREE.PointsMaterial({
    color: 0xffb347,
    size: 3,
    sizeAttenuation: false,
    vertexColors: true,
    transparent: true,
    opacity: 0.9,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  })
  const sparkPoints = new THREE.Points(sparkGeo, sparkPointsMat)
  sparkPoints.renderOrder = 2
  sparkPoints.frustumCulled = false // pool slots can sit anywhere on the planet
  agentsGroup.add(sparkPoints)

  function spawnSparkBurst(originPos, normalDir) {
    const count = SPARK_BURST_MIN + Math.floor(Math.random() * (SPARK_BURST_MAX - SPARK_BURST_MIN + 1))
    tangentBasis(normalDir, _tb1, _tb2)
    for (let n = 0; n < count; n++) {
      const slot = sparkCursor
      sparkCursor = (sparkCursor + 1) % SPARK_POOL_SIZE
      const i3 = slot * 3
      sparkPositions[i3] = originPos.x
      sparkPositions[i3 + 1] = originPos.y
      sparkPositions[i3 + 2] = originPos.z
      const a = Math.random() * Math.PI * 2
      const spread = 0.0025 + Math.random() * 0.004
      const up = 0.004 + Math.random() * 0.003
      const tx = _tb1.x * Math.cos(a) + _tb2.x * Math.sin(a)
      const ty = _tb1.y * Math.cos(a) + _tb2.y * Math.sin(a)
      const tz = _tb1.z * Math.cos(a) + _tb2.z * Math.sin(a)
      sparkVelocity[i3] = tx * spread + normalDir.x * up
      sparkVelocity[i3 + 1] = ty * spread + normalDir.y * up
      sparkVelocity[i3 + 2] = tz * spread + normalDir.z * up
      sparkDown[i3] = -normalDir.x
      sparkDown[i3 + 1] = -normalDir.y
      sparkDown[i3 + 2] = -normalDir.z
      sparkAge[slot] = 0
      sparkTtl[slot] = SPARK_TTL * (0.7 + Math.random() * 0.6)
      sparkColors[i3] = 1
      sparkColors[i3 + 1] = 1
      sparkColors[i3 + 2] = 1
    }
  }

  function updateSparks(dt) {
    for (let slot = 0; slot < SPARK_POOL_SIZE; slot++) {
      const t = sparkTtl[slot]
      if (t <= 0) continue
      const a = sparkAge[slot] + dt
      const i3 = slot * 3
      if (a >= t) {
        sparkTtl[slot] = 0
        sparkColors[i3] = sparkColors[i3 + 1] = sparkColors[i3 + 2] = 0
        continue
      }
      sparkAge[slot] = a
      sparkVelocity[i3] += sparkDown[i3] * SPARK_GRAVITY * dt
      sparkVelocity[i3 + 1] += sparkDown[i3 + 1] * SPARK_GRAVITY * dt
      sparkVelocity[i3 + 2] += sparkDown[i3 + 2] * SPARK_GRAVITY * dt
      sparkPositions[i3] += sparkVelocity[i3] * dt
      sparkPositions[i3 + 1] += sparkVelocity[i3 + 1] * dt
      sparkPositions[i3 + 2] += sparkVelocity[i3 + 2] * dt
      const fade = 1 - a / t
      sparkColors[i3] = sparkColors[i3 + 1] = sparkColors[i3 + 2] = fade
    }
    sparkGeo.attributes.position.needsUpdate = true
    sparkGeo.attributes.color.needsUpdate = true
  }

  const stats = { settlements: 0, structures: 0, agents: 0 }

  const settlements = new Map() // project -> settlement record
  const structures = new Map() // session id -> structure record
  const agents = new Map() // session id -> agent record
  const minions = new Map() // session id -> array of half-size subagent-worker records
  const knownIds = new Set() // every session id ever observed
  const constructingSet = new Set() // structure records currently growing in
  const hitSpheres = [] // invisible raycast targets for click-to-visit (settlements)
  const structureHitSpheres = [] // invisible raycast targets for click-to-visit (structures)
  const structureClickCallbacks = [] // subscribers registered via onStructureClick()

  let simTime = 0
  let pollTimer = 0
  let labelThrottle = 0

  const raycaster = new THREE.Raycaster()
  const ndc = new THREE.Vector2()
  const tween = { active: false, from: new THREE.Vector3(), to: new THREE.Vector3(), t: 0 }
  const _fwdCalc = new THREE.Vector3()
  const _yawScratch = new THREE.Vector3()

  function updateAgentForward(agent, target) {
    _fwdCalc.copy(target).sub(agent.dir)
    _fwdCalc.addScaledVector(agent.dir, -_fwdCalc.dot(agent.dir))
    if (_fwdCalc.lengthSq() > 1e-10) agent.forward.copy(_fwdCalc).normalize()
  }

  // --- settlement -----------------------------------------------------------

  function createSettlementRecord(project) {
    const u = hash01(project)
    const v = hash01(project + '~lon')
    const lat = Math.asin(clamp(2 * u - 1, -1, 1))
    const lon = 2 * Math.PI * v
    const base = new THREE.Vector3(Math.cos(lat) * Math.cos(lon), Math.sin(lat), Math.cos(lat) * Math.sin(lon))

    const anchorRng = rngFromString(project)
    const anchorDir = findLandAnchor(planet, base, anchorRng)
    const groundR = planet.sampleHeight(anchorDir)

    const race = RACE_KEYS[Math.floor(hash01(project + '~race') * RACE_KEYS.length)]
    const pal = RACE_PALETTES[race]
    const { name, basenameRaw } = makeSettlementName(project, race)
    const accentCss = '#' + pal.accent.toString(16).padStart(6, '0')

    const labelSprite = makeSettlementSprite(RACE_GLYPHS[race], name, basenameRaw, accentCss)
    labelSprite.position.copy(anchorDir).multiplyScalar(groundR + 0.035)
    settlementsGroup.add(labelSprite)

    const hitMesh = new THREE.Mesh(sphereGeo(), hitMat())
    hitMesh.visible = false
    hitMesh.position.copy(anchorDir).multiplyScalar(groundR)
    hitMesh.scale.setScalar(0.08) // sphereGeo radius 0.5 -> world radius 0.04
    settlementsGroup.add(hitMesh)

    const settlement = { project, anchorDir, groundR, race, name, basenameRaw, labelSprite, hitMesh, structureDirs: [] }
    hitMesh.userData.settlement = settlement
    hitSpheres.push(hitMesh)
    return settlement
  }

  // --- structure --------------------------------------------------------------

  function createStructureRecord(id, settlement, topic, bytes, lastActive, animate) {
    const rng = rngFromString(id)
    const dir = findStructureSpot(planet, settlement.anchorDir, rng, settlement.structureDirs)
    const groundR = planet.sampleHeight(dir)

    const type = pickStructureType(topic, id)
    const tier = pickTier(bytes)
    const finalScale = KIT_UNIT_SIZE[type] * TIER_MULT[tier - 1]

    const structureRoot = new THREE.Group()
    const yaw = rng() * Math.PI * 2
    yawedTangent(dir, yaw, _yawScratch)
    orientOnSurface(structureRoot, dir, _yawScratch)
    structureRoot.position.copy(dir).multiplyScalar(groundR - 0.0005 * finalScale)

    const kitGroup = buildKit(type, settlement.race, tier, rng)
    kitGroup.scale.setScalar(animate ? finalScale * 0.05 : finalScale)
    structureRoot.add(kitGroup)

    const topicSprite = makeTopicSprite(truncateText(topic, 44))
    topicSprite.visible = false
    topicSprite.position.set(0, finalScale * 1.3, 0)
    applyLabelScale(topicSprite, TOPIC_LABEL_REF_DIST, TOPIC_LABEL_K, TOPIC_LABEL_MIN, TOPIC_LABEL_MAX)
    structureRoot.add(topicSprite)

    let scaffold = null
    if (animate) {
      scaffold = new THREE.Mesh(boxGeo(), scaffoldMat())
      scaffold.scale.setScalar(finalScale * 1.3)
      scaffold.position.set(0, finalScale * 0.5, 0)
      structureRoot.add(scaffold)
    }

    structuresGroup.add(structureRoot)

    // Invisible click target for the structure inspector (onStructureClick).
    const hitMesh = new THREE.Mesh(sphereGeo(), hitMat())
    hitMesh.visible = false
    hitMesh.position.copy(dir).multiplyScalar(groundR)
    hitMesh.scale.setScalar(STRUCT_HIT_RADIUS * 2) // sphereGeo radius 0.5 -> world radius STRUCT_HIT_RADIUS
    structuresGroup.add(hitMesh)

    const structure = {
      id,
      dir,
      groundR,
      type,
      tier,
      bytes,
      topic,
      lastActive,
      settlement,
      finalScale,
      structureRoot,
      kitGroup,
      scaffold,
      topicSprite,
      hitMesh,
      constructing: !!animate,
      constructionT: 0,
    }
    hitMesh.userData.structure = structure
    structureHitSpheres.push(hitMesh)
    settlement.structureDirs.push(dir)
    if (animate) constructingSet.add(structure)
    return structure
  }

  function updateStructureData(structure, topic, bytes, lastActive) {
    structure.lastActive = lastActive
    if (topic !== structure.topic) {
      structure.topic = topic
      refreshTopicSprite(structure.topicSprite, truncateText(topic, 44))
    }
    if (bytes !== structure.bytes) {
      structure.bytes = bytes
      const tier = pickTier(bytes)
      if (tier !== structure.tier) {
        structure.tier = tier
        structure.finalScale = KIT_UNIT_SIZE[structure.type] * TIER_MULT[tier - 1]
        if (!structure.constructing) structure.kitGroup.scale.setScalar(structure.finalScale)
        structure.topicSprite.position.set(0, structure.finalScale * 1.3, 0)
      }
    }
  }

  // --- agent ------------------------------------------------------------------

  function createAgentRecord(id, settlement, structure) {
    const rng = rngFromString(id + '~agent')
    const visual = buildPersonGroup(settlement.race)
    const visualGroup = new THREE.Group()
    visualGroup.add(visual)
    agentsGroup.add(visualGroup)

    const wanderPoints = [structure.dir.clone()]
    for (let i = 0; i < 3; i++) {
      wanderPoints.push(randomLandNear(planet, settlement.anchorDir, rngFromString(id + '~wander' + i), 0.045))
    }

    tangentBasis(structure.dir, _tb1, _tb2)

    return {
      id,
      structure,
      settlement,
      group: visualGroup,
      dir: structure.dir.clone(),
      forward: _tb1.clone(),
      targetDir: wanderPoints[1].clone(),
      targetIsHome: false,
      wanderPoints,
      rng,
      pauseTimer: 1 + rng() * 3,
      fadeScale: 1,
      arrivedHome: false,
      lastActive: Date.now(),
      bobPhase: rng() * Math.PI * 2,
      lastAction: null,
      bubbleSprite: null,
      bubbleText: '',
      sparkCooldown: Math.random() * SPARK_COOLDOWN_MIN,
    }
  }

  function createMinionRecord(id, index, settlement, structure) {
    const seed = id + '~minion' + index
    const rng = rngFromString(seed)
    const visual = buildPersonGroup(settlement.race)
    const visualGroup = new THREE.Group()
    visualGroup.add(visual)
    agentsGroup.add(visualGroup)

    const wanderPoints = [structure.dir.clone()]
    for (let i = 0; i < 3; i++) {
      wanderPoints.push(randomLandNear(planet, settlement.anchorDir, rngFromString(seed + '~wander' + i), 0.045))
    }
    const start = randomLandNear(planet, settlement.anchorDir, rngFromString(seed + '~start'), 0.045)

    tangentBasis(structure.dir, _tb1, _tb2)

    return {
      group: visualGroup,
      dir: start.clone(),
      forward: _tb1.clone(),
      targetDir: wanderPoints[1].clone(),
      targetIsHome: false,
      wanderPoints,
      rng,
      pauseTimer: rng() * 2,
      bobPhase: rng() * Math.PI * 2,
    }
  }

  function pickNextTarget(agent) {
    if (agent.rng() < 0.28) {
      agent.targetDir.copy(agent.wanderPoints[0])
      agent.targetIsHome = true
    } else {
      const idx = 1 + Math.floor(agent.rng() * (agent.wanderPoints.length - 1))
      agent.targetDir.copy(agent.wanderPoints[idx])
      agent.targetIsHome = false
    }
  }

  function updateAgent(agent, dt, nowMs) {
    const st = agent.structure
    const home = st.dir
    const age = nowMs - agent.lastActive

    let phase
    if (st.constructing) phase = 'hammer'
    else if (age < WORKING_MAX_MS) phase = 'work'
    else if (age < AGENT_MAX_MS) phase = 'idle'
    else phase = 'despawn'

    if (phase !== 'despawn' && agent.fadeScale < 1) agent.fadeScale = Math.min(1, agent.fadeScale + dt * 2)

    let bob = 0
    let hammering = false

    if (phase === 'hammer') {
      const arrived = stepToward(agent.dir, home, AGENT_SPEED * dt * 2.2)
      if (arrived) {
        bob = Math.sin(simTime * 20 + agent.bobPhase) * BOB_HAMMER
        hammering = true
      } else {
        updateAgentForward(agent, home)
        bob = Math.sin(simTime * 9 + agent.bobPhase) * BOB_WALK
      }
    } else if (phase === 'work') {
      if (agent.pauseTimer > 0) {
        agent.pauseTimer -= dt
        bob = Math.sin(simTime * 20 + agent.bobPhase) * BOB_HAMMER
        hammering = true
      } else {
        const arrived = stepToward(agent.dir, agent.targetDir, AGENT_SPEED * dt)
        if (arrived) {
          if (agent.targetIsHome) agent.pauseTimer = 3 + agent.rng() * 5
          else pickNextTarget(agent)
        } else {
          updateAgentForward(agent, agent.targetDir)
        }
        bob = Math.sin(simTime * 9 + agent.bobPhase) * BOB_WALK
      }
    } else if (phase === 'idle') {
      const arrived = stepToward(agent.dir, home, AGENT_SPEED * dt * 1.4)
      if (!arrived) updateAgentForward(agent, home)
      bob = Math.sin(simTime * 4 + agent.bobPhase) * BOB_IDLE
    } else {
      if (!agent.arrivedHome) {
        const arrived = stepToward(agent.dir, home, AGENT_SPEED * dt * 1.4)
        if (arrived) agent.arrivedHome = true
        else updateAgentForward(agent, home)
        bob = Math.sin(simTime * 9 + agent.bobPhase) * BOB_WALK
      } else {
        agent.fadeScale = Math.max(0, agent.fadeScale - dt)
      }
    }

    const groundR = planet.sampleHeight(agent.dir)
    agent.group.position.copy(agent.dir).multiplyScalar(groundR + FOOT_LIFT + bob)
    orientOnSurface(agent.group, agent.dir, agent.forward)
    agent.group.scale.setScalar(PERSON_HEIGHT * agent.fadeScale)

    if (hammering) {
      agent.sparkCooldown -= dt
      if (agent.sparkCooldown <= 0) {
        agent.sparkCooldown = SPARK_COOLDOWN_MIN + Math.random() * SPARK_COOLDOWN_RANGE
        spawnSparkBurst(agent.group.position, agent.dir)
      }
    }

    updateAgentBubble(agent, phase)

    return phase === 'despawn' && agent.arrivedHome && agent.fadeScale <= 0.001
  }

  // Speech bubble: only while WORKING and only when the camera is close.
  // Canvas is redrawn only when the text actually changes.
  function updateAgentBubble(agent, phase) {
    const text = phase === 'work' ? agent.lastAction : null
    if (!text) {
      if (agent.bubbleSprite) agent.bubbleSprite.visible = false
      return
    }
    if (!agent.bubbleSprite) {
      agent.bubbleSprite = makeBubbleSprite(truncateText(text, BUBBLE_MAX_CHARS))
      agent.bubbleText = text
      agentsGroup.add(agent.bubbleSprite)
    } else if (text !== agent.bubbleText) {
      agent.bubbleText = text
      refreshBubbleSprite(agent.bubbleSprite, truncateText(text, BUBBLE_MAX_CHARS))
    }
    const sprite = agent.bubbleSprite
    sprite.position.copy(agent.group.position).addScaledVector(agent.dir, BUBBLE_OFFSET)
    const dist = camera.position.distanceTo(sprite.position)
    const near = dist < BUBBLE_VISIBLE_DIST
    sprite.visible = near
    if (near) applyLabelScale(sprite, dist, TOPIC_LABEL_K, TOPIC_LABEL_MIN, TOPIC_LABEL_MAX)
  }

  // Subagent minions: lightweight, always-wandering, no work/hammer/despawn
  // phases of their own — existence is driven purely by ingest()'s pool sync.
  function updateMinion(m, dt) {
    let bob
    if (m.pauseTimer > 0) {
      m.pauseTimer -= dt
      bob = Math.sin(simTime * 9 + m.bobPhase) * BOB_IDLE
    } else {
      const arrived = stepToward(m.dir, m.targetDir, AGENT_SPEED * dt)
      if (arrived) {
        pickNextTarget(m)
        m.pauseTimer = 0.5 + m.rng() * 1.5
      } else {
        updateAgentForward(m, m.targetDir)
      }
      bob = Math.sin(simTime * 9 + m.bobPhase) * BOB_WALK
    }
    const groundR = planet.sampleHeight(m.dir)
    m.group.position.copy(m.dir).multiplyScalar(groundR + FOOT_LIFT * MINION_SCALE + bob * MINION_SCALE)
    orientOnSurface(m.group, m.dir, m.forward)
    m.group.scale.setScalar(PERSON_HEIGHT * MINION_SCALE)
  }

  // --- data ingest --------------------------------------------------------------

  function ingest(sessions) {
    const now = Date.now()
    for (let i = 0; i < sessions.length; i++) {
      try {
        const s = sessions[i]
        if (!s || typeof s.id !== 'string' || !s.id) {
          warnIngestSkip('missing/invalid id')
          continue
        }
        if (typeof s.project !== 'string' || !s.project) {
          warnIngestSkip('missing/invalid project')
          continue
        }
        const id = s.id
        const project = s.project
        const topic = typeof s.topic === 'string' ? s.topic : ''
        const lastActive = Number.isFinite(s.lastActive) ? s.lastActive : now
        const bytes = Number.isFinite(s.bytes) ? s.bytes : 0
        const lastAction = typeof s.lastAction === 'string' && s.lastAction ? s.lastAction : null
        const subagents = Number.isFinite(s.subagents) ? clamp(Math.floor(s.subagents), 0, 20) : 0

        let settlement = settlements.get(project)
        if (!settlement) {
          settlement = createSettlementRecord(project)
          settlements.set(project, settlement)
        }

        let structure = structures.get(id)
        if (!structure) {
          const isNew = !knownIds.has(id)
          knownIds.add(id)
          const animate = isNew && now - lastActive < CONSTRUCTION_NEW_MAX_MS
          structure = createStructureRecord(id, settlement, topic, bytes, lastActive, animate)
          structures.set(id, structure)
        } else {
          updateStructureData(structure, topic, bytes, lastActive)
        }

        if (now - lastActive < AGENT_MAX_MS) {
          let agent = agents.get(id)
          if (!agent) {
            agent = createAgentRecord(id, settlement, structure)
            agents.set(id, agent)
          }
          agent.lastActive = lastActive
          agent.lastAction = lastAction
        }

        const wantMinions = Math.min(subagents, MINION_MAX)
        let minionPool = minions.get(id)
        if (!minionPool) {
          minionPool = []
          minions.set(id, minionPool)
        }
        while (minionPool.length < wantMinions) {
          minionPool.push(createMinionRecord(id, minionPool.length, settlement, structure))
        }
        while (minionPool.length > wantMinions) {
          const m = minionPool.pop()
          agentsGroup.remove(m.group)
        }
      } catch (e) {
        // Keep the world stable even if one session entry is malformed.
        warnIngestSkip('exception: ' + e)
      }
    }
  }

  async function poll() {
    try {
      const res = await fetch('/api/sessions')
      if (!res || !res.ok) {
        warnPoll('bad response' + (res ? ' (status ' + res.status + ')' : ''))
        return
      }
      const data = await res.json()
      if (Array.isArray(data)) ingest(data)
    } catch (e) {
      // Server may briefly 500 — ignore silently, try again next poll.
      warnPoll('fetch/parse failed: ' + e)
    }
  }
  poll()

  // --- click-to-visit -----------------------------------------------------------

  let downPos = null
  let downId = null

  function onPointerDown(e) {
    downPos = { x: e.clientX, y: e.clientY }
    downId = e.pointerId
  }

  function onPointerUp(e) {
    const p = downPos
    downPos = null
    if (!p || e.pointerId !== downId) return
    const dx = e.clientX - p.x
    const dy = e.clientY - p.y
    if (Math.sqrt(dx * dx + dy * dy) >= CLICK_MOVE_THRESHOLD) return

    const rect = domElement.getBoundingClientRect()
    ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1)
    raycaster.setFromCamera(ndc, camera)

    // Structures are tested first: a hit opens the inspector and never
    // triggers the settlement fly-to underneath it.
    const structHits = raycaster.intersectObjects(structureHitSpheres, false)
    const structure = structHits.length ? structHits[0].object.userData.structure : null
    if (structure) {
      const st = structure.settlement
      const payload = {
        id: structure.id,
        project: st ? st.project : null,
        topic: structure.topic,
        bytes: structure.bytes,
        lastActive: structure.lastActive,
        type: structure.type,
        tier: structure.tier,
        settlementName: st ? st.name : null,
        race: st ? st.race : null,
      }
      for (let i = 0; i < structureClickCallbacks.length; i++) {
        try {
          structureClickCallbacks[i](payload)
        } catch (err) {
          // A misbehaving subscriber shouldn't break click handling.
          if (!warnedStructureClickCb) {
            warnedStructureClickCb = true
            console.warn('[planet] world.js: structure-click subscriber degraded — a registered callback threw: ' + err)
          }
        }
      }
      return
    }

    const hits = raycaster.intersectObjects(hitSpheres, false)
    if (!hits.length) return
    const settlement = hits[0].object.userData.settlement
    if (!settlement) return

    const currentDist = camera.position.length()
    tween.from.copy(camera.position)
    tween.to.copy(settlement.anchorDir).multiplyScalar(Math.max(1.3, 0.45 * currentDist))
    tween.t = 0
    tween.active = true
  }

  function onStructureClick(cb) {
    if (typeof cb === 'function') structureClickCallbacks.push(cb)
  }

  domElement.addEventListener('pointerdown', onPointerDown)
  domElement.addEventListener('pointerup', onPointerUp)

  // --- frame update ---------------------------------------------------------

  function update(dt) {
    simTime += dt
    pollTimer += dt
    if (pollTimer >= POLL_INTERVAL) {
      pollTimer = 0
      poll()
    }

    for (const settlement of settlements.values()) {
      // scale by distance to the label itself, so close-ups get signposts,
      // not billboards
      const d = settlement.labelSprite.position.distanceTo(camera.position)
      applyLabelScale(settlement.labelSprite, d, SETTLEMENT_LABEL_K, SETTLEMENT_LABEL_MIN, SETTLEMENT_LABEL_MAX)
    }

    for (const st of constructingSet) {
      st.constructionT += dt / CONSTRUCTION_DURATION
      const t = Math.min(1, st.constructionT)
      const eased = smoothstep(0, 1, t)
      st.kitGroup.scale.setScalar(lerp(st.finalScale * 0.05, st.finalScale, eased))
      if (t >= 1) {
        st.constructing = false
        if (st.scaffold) {
          st.structureRoot.remove(st.scaffold)
          st.scaffold = null
        }
        constructingSet.delete(st)
      }
    }

    labelThrottle -= dt
    if (labelThrottle <= 0) {
      labelThrottle = LABEL_THROTTLE
      // Only the nearest few topics get a label — a 100-building city would
      // otherwise be a wall of text.
      const inRange = []
      for (const st of structures.values()) {
        const d = st.structureRoot.position.distanceTo(camera.position)
        st.topicSprite.visible = false
        if (d < TOPIC_VISIBLE_DIST) inRange.push({ st, d })
      }
      inRange.sort((a, b) => a.d - b.d)
      for (const { st, d } of inRange.slice(0, 12)) {
        st.topicSprite.visible = true
        applyLabelScale(st.topicSprite, d, TOPIC_LABEL_K, TOPIC_LABEL_MIN, TOPIC_LABEL_MAX)
      }
    }

    const nowMs = Date.now()
    for (const [id, agent] of agents) {
      const remove = updateAgent(agent, dt, nowMs)
      if (remove) {
        agentsGroup.remove(agent.group)
        if (agent.bubbleSprite) {
          agentsGroup.remove(agent.bubbleSprite)
          agent.bubbleSprite.material.map.dispose()
          agent.bubbleSprite.material.dispose()
        }
        agents.delete(id)
      }
    }

    for (const pool of minions.values()) {
      for (let i = 0; i < pool.length; i++) updateMinion(pool[i], dt)
    }

    updateSparks(dt)

    if (tween.active) {
      tween.t += dt / TWEEN_DURATION
      const t = Math.min(1, tween.t)
      camera.position.lerpVectors(tween.from, tween.to, smoothstep(0, 1, t))
      if (t >= 1) tween.active = false
    }

    stats.settlements = settlements.size
    stats.structures = structures.size
    stats.agents = agents.size

    if (structures.size !== townLightCount) rebuildTownLights()
  }

  // Read-only settlement summaries for UI (sidebar/legend).
  function list() {
    const counts = new Map()
    for (const a of agents.values()) {
      counts.set(a.settlement.project, (counts.get(a.settlement.project) || 0) + 1)
    }
    return Array.from(settlements.values()).map((s) => ({
      project: s.project,
      name: s.name,
      basename: s.basenameRaw,
      race: s.race,
      structures: s.structureDirs.length,
      agents: counts.get(s.project) || 0,
    }))
  }

  // Fly the camera to a settlement — same tween as clicking it in the scene.
  function visit(project) {
    const s = settlements.get(project)
    if (!s) return false
    tween.from.copy(camera.position)
    tween.to.copy(s.anchorDir).multiplyScalar(Math.max(1.3, 0.45 * camera.position.length()))
    tween.t = 0
    tween.active = true
    return true
  }

  return { group, update, stats, list, visit, _tween: tween, onStructureClick }
}
