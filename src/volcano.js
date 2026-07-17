// Active volcanoes: 2-4 basalt cones seated on the planet's tallest peaks,
// each running its own seeded eruption cycle -- a long DORMANT hush, a
// pre-eruption SMOKING wisp of grey ash from the crater, a violent ERUPTION
// (glowing emissive lava pooling in the crater and running a short tongue
// down one flank, a tall dark ash column, and a spray of hot embers), then a
// slow COOLING back to dark rock and dormancy. The lava "heals" every cycle:
// its glow fades to zero as the volcano cools (THE COVENANT -- the eruption is
// additive spectacle, it never scars terrain or touches session structures).
//
// Contract (pinned): export function createVolcanoes(planet, seed) ->
// { group, update(dt) }.
//
// Rendering (WebGPURenderer / TSL NodeMaterial host, see
// docs/spikes/2026-07-17-s1-tsl-webgpu.md). THREE small draw calls:
//   1. ONE InstancedMesh for every cone -- a shared LatheGeometry basalt cone
//      carrying a per-VERTEX `lava` attribute (crater floor + a down-slope
//      flow channel, painted at build) and a per-INSTANCE `glow` attribute
//      (0..GLOW_PEAK, the only thing rewritten per frame). The material's
//      emissiveNode = lavaTint * lava * glow, so the lava glows >1.0 exactly
//      where painted, exactly as bright as the cycle says -- and the existing
//      threshold bloom (main.js: bloom(scenePass, 0.3, 0.7, 1.0)) catches it.
//   2. ONE grey ash Points pool (normal blending -- vapour/ash, not glow),
//      pattern-copied from world.js's steam-plume pool.
//   3. ONE ember Points pool (ADDITIVE blending, colour values >1.0 so bloom
//      lights them, like sky.js's >1 sun headroom).
//
// LAWS: fully deterministic -- placement and every cycle timing/particle
// jitter come from rngFromString streams; sim time is accumulated from dt.
// No Math.random / Date.now anywhere. No per-frame allocation in update()
// (module-scope scratch + preallocated ring-buffer pools).
import * as THREE from 'three/webgpu'
import { attribute, color, vec3, mix } from 'three/tsl'
import { rngFromString, clamp, lerp, smoothstep } from './util.js'
import { tangentBasis } from './placement.js'

// ---------------------------------------------------------------------------
// Placement.
// ---------------------------------------------------------------------------
const MAX_VOLCANOES = 4
const MIN_VOLCANOES = 2
const PEAK_SAMPLE_TRIES = 2500 // seeded random dirs scanned for tall peaks
const PEAK_MIN_SEPARATION = 0.55 // rad -- volcanoes never cluster on one massif
const HILLCLIMB_ITERS = 6 // refine each peak toward its local summit
const HILLCLIMB_RADIUS = 0.03 // rad -- ring step for the climb
const HILLCLIMB_PROBES = 8

// ---------------------------------------------------------------------------
// Cone geometry (shared by every instance; the flow channel points down local
// +X, which each instance's own seeded orientation carries to an arbitrary
// world bearing -- like real lava picking a channel).
// ---------------------------------------------------------------------------
const CONE_BASE_R = 0.03 // world units -- footprint radius at the mountain
const CONE_RIM_R = 0.014 // crater rim radius
const CONE_HEIGHT = 0.028 // rim height above the cone base
const CRATER_DEPTH = 0.012 // how far the crater floor sits below the rim
const CONE_SINK = 0.008 // embed the base into the peak so no seam floats
const LATHE_SEGMENTS = 28
const FLOW_HALF_ANGLE = 0.5 // rad -- angular half-width of the lava flow tongue

// ---------------------------------------------------------------------------
// Basalt + lava colour. Lava emissive peaks well above 1.0 so the scene-
// threshold bloom lights it; basalt is a dark, flat volcanic rock.
// ---------------------------------------------------------------------------
const BASALT_COLOR = 0x2c2622
const LAVA_DARK = new THREE.Vector3(0.7, 0.12, 0.03) // cooler crust / flow edges
const LAVA_BRIGHT = new THREE.Vector3(1.25, 0.78, 0.3) // molten core
const GLOW_PEAK = 3.2 // peak per-instance emissive multiplier during eruption

// ---------------------------------------------------------------------------
// Eruption cycle (seconds). Phases: 0 DORMANT, 1 SMOKING, 2 ERUPTION,
// 3 COOLING. Every duration is drawn from the volcano's own rng.
// ---------------------------------------------------------------------------
const DORMANT = 0
const SMOKING = 1
const ERUPTION = 2
const COOLING = 3

const DORMANT_MIN = 35
const DORMANT_MAX = 90
const SMOKING_MIN = 6
const SMOKING_MAX = 14
const ERUPTION_MIN = 5
const ERUPTION_MAX = 12
const COOLING_MIN = 10
const COOLING_MAX = 22

const FLICKER_FREQ = 9 // rad/s -- molten-lava shimmer during eruption

// ---------------------------------------------------------------------------
// Ash Points pool (grey, normal blending -- vapour/ash, never glow). One
// shared ring buffer across every volcano, world.js steam-plume style.
// ---------------------------------------------------------------------------
const ASH_POOL = 320
const ASH_SIZE = 9 // screen-space px (sizeAttenuation: false)
const ASH_RISE_SMOKE = 0.03 // world units/s outward while merely smoking
const ASH_RISE_ERUPT = 0.08 // ...and while erupting -- a tall column
const ASH_DRIFT = 0.009 // lateral wander
const ASH_JITTER = 0.002 // emit-point scatter across the crater mouth
const ASH_TTL_MIN = 3.5
const ASH_TTL_MAX = 6
const ASH_INTERVAL = 0.12 // base seconds/puff, scaled down by intensity
const ASH_FADE_IN = 0.25
const ASH_PEAK_ALPHA = 0.55
const ASH_SMOKE_GREY = 0.6 // light steam-grey wisp (smoking phase)
const ASH_ERUPT_GREY = 0.32 // dark dense ash (eruption)

// ---------------------------------------------------------------------------
// Ember Points pool (additive, colour >1 for bloom). Hot fragments flung from
// the crater on eruption, arcing back under a gentle pull toward the planet.
// ---------------------------------------------------------------------------
const EMBER_POOL = 220
const EMBER_SIZE = 4.5
const EMBER_SPEED = 0.09 // outward launch speed
const EMBER_SPREAD = 0.05 // lateral launch speed spread
const EMBER_GRAVITY = 0.06 // world units/s^2 pull toward planet centre (arcs)
const EMBER_TTL_MIN = 1.0
const EMBER_TTL_MAX = 2.0
const EMBER_INTERVAL = 0.035 // seconds/ember during eruption
const EMBER_FADE_IN = 0.06
const EMBER_PEAK_ALPHA = 1.0
const EMBER_R = 2.6 // >1 -> bloom
const EMBER_G = 1.0
const EMBER_B = 0.25

const TAU = Math.PI * 2
const UP = new THREE.Vector3(0, 1, 0)

// ---------------------------------------------------------------------------
// Module-scope scratch (write-before-read only, never carries state between
// calls -- same convention as sealife.js / flood.js). Reused across every
// volcano and both particle pools, which update sequentially, not concurrently.
// ---------------------------------------------------------------------------
const _t1 = new THREE.Vector3()
const _t2 = new THREE.Vector3()
const _emitPos = new THREE.Vector3()
const _vel = new THREE.Vector3()
const _pos = new THREE.Vector3()
const _quat = new THREE.Quaternion()
const _mat = new THREE.Matrix4()
const _scaleOne = new THREE.Vector3(1, 1, 1)

let warnedPeaks = false

// ---------------------------------------------------------------------------
// Placement helpers (build-time only -- allocation here is fine).
// ---------------------------------------------------------------------------
function randomUnit(rng, out) {
  const z = rng() * 2 - 1
  const t = rng() * TAU
  const r = Math.sqrt(Math.max(0, 1 - z * z))
  return out.set(r * Math.cos(t), r * Math.sin(t), z)
}

/** Unit dir `dist` rad from `center` along `bearing`, using center's tangent basis. */
function ringDir(center, bearing, dist, out) {
  tangentBasis(center, _t1, _t2)
  const cb = Math.cos(bearing)
  const sb = Math.sin(bearing)
  const tx = _t1.x * cb + _t2.x * sb
  const ty = _t1.y * cb + _t2.y * sb
  const tz = _t1.z * cb + _t2.z * sb
  const cd = Math.cos(dist)
  const sd = Math.sin(dist)
  return out.set(center.x * cd + tx * sd, center.y * cd + ty * sd, center.z * cd + tz * sd).normalize()
}

/** Nudge `dir` toward its local summit (a few ring probes, greedy ascent). */
function hillClimb(planet, dir) {
  const probe = new THREE.Vector3()
  let best = planet.sampleHeight(dir)
  for (let it = 0; it < HILLCLIMB_ITERS; it++) {
    let moved = false
    for (let p = 0; p < HILLCLIMB_PROBES; p++) {
      ringDir(dir, (p / HILLCLIMB_PROBES) * TAU, HILLCLIMB_RADIUS, probe)
      const h = planet.sampleHeight(probe)
      if (h > best) {
        best = h
        dir.copy(probe)
        moved = true
      }
    }
    if (!moved) break
  }
  return best
}

/** The `count` tallest, well-separated peaks -- deterministic from `rng`. */
function findVolcanoPeaks(planet, rng, count) {
  const candidates = []
  for (let i = 0; i < PEAK_SAMPLE_TRIES; i++) {
    const dir = new THREE.Vector3()
    randomUnit(rng, dir)
    candidates.push({ dir, h: planet.sampleHeight(dir) })
  }
  candidates.sort((a, b) => b.h - a.h)

  const chosen = []
  for (let i = 0; i < candidates.length && chosen.length < count; i++) {
    const c = candidates[i]
    let tooClose = false
    for (let j = 0; j < chosen.length; j++) {
      // dot > cos(sep) means the angular gap is smaller than the minimum
      if (c.dir.dot(chosen[j].dir) > Math.cos(PEAK_MIN_SEPARATION)) {
        tooClose = true
        break
      }
    }
    if (tooClose) continue
    hillClimb(planet, c.dir)
    chosen.push(c)
  }

  if (chosen.length < count && !warnedPeaks) {
    warnedPeaks = true
    console.warn(
      '[planet] volcano.js: peak search degraded -- fewer well-separated tall peaks than requested; shipping ' +
        chosen.length,
    )
  }
  return chosen
}

// ---------------------------------------------------------------------------
// Cone geometry: a LatheGeometry basalt cone with a dished crater, plus a
// per-vertex `lava` attribute painting the crater floor and one down-slope
// flow tongue (local +X). flatShading gives the faceted, stylised look that
// matches the planet's own terrain.
// ---------------------------------------------------------------------------
function buildConeGeometry() {
  const craterFloorY = CONE_HEIGHT - CRATER_DEPTH
  // Bottom outer edge -> mid slope -> rim -> down the inner wall -> crater
  // floor -> floor centre. Revolved around Y.
  const profile = [
    new THREE.Vector2(CONE_BASE_R, 0),
    new THREE.Vector2(CONE_BASE_R * 0.62, CONE_HEIGHT * 0.55),
    new THREE.Vector2(CONE_RIM_R, CONE_HEIGHT),
    new THREE.Vector2(CONE_RIM_R * 0.62, craterFloorY + CRATER_DEPTH * 0.35),
    new THREE.Vector2(CONE_RIM_R * 0.28, craterFloorY),
    new THREE.Vector2(0.0, craterFloorY + CRATER_DEPTH * 0.04),
  ]
  const geo = new THREE.LatheGeometry(profile, LATHE_SEGMENTS)

  const posAttr = geo.attributes.position
  const n = posAttr.count
  const lava = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const x = posAttr.getX(i)
    const y = posAttr.getY(i)
    const z = posAttr.getZ(i)
    const r = Math.sqrt(x * x + z * z)

    // Crater interior: hottest at the floor centre (r~0), zero at the rim.
    let crater = 0
    if (y > CONE_HEIGHT * 0.68) crater = smoothstep(CONE_RIM_R, CONE_RIM_R * 0.2, r)

    // Flow tongue: a wedge down local +X, strong just under the rim, fading
    // out toward the base -- a short molten channel breaching one flank.
    const az = Math.abs(Math.atan2(z, x)) // 0 along +X
    const wedge = smoothstep(FLOW_HALF_ANGLE, FLOW_HALF_ANGLE * 0.35, az)
    const along = smoothstep(CONE_HEIGHT * 0.12, CONE_HEIGHT * 0.9, y)
    const flow = wedge * along

    lava[i] = clamp(Math.max(crater, flow), 0, 1)
  }
  geo.setAttribute('lava', new THREE.BufferAttribute(lava, 1))
  geo.computeVertexNormals()
  geo.computeBoundingSphere()
  return geo
}

// ---------------------------------------------------------------------------
// createVolcanoes
// ---------------------------------------------------------------------------
export function createVolcanoes(planet, seed) {
  const group = new THREE.Group()

  // --- pick peaks + count --------------------------------------------------
  const placeRng = rngFromString(seed + ':volcanoes')
  const count = MIN_VOLCANOES + Math.floor(placeRng() * (MAX_VOLCANOES - MIN_VOLCANOES + 1))
  const peaks = findVolcanoPeaks(planet, placeRng, count)

  // --- cone InstancedMesh (draw call 1) ------------------------------------
  const coneGeo = buildConeGeometry()
  const glowArray = new Float32Array(MAX_VOLCANOES)
  const glowAttr = new THREE.InstancedBufferAttribute(glowArray, 1)
  glowAttr.setUsage(THREE.DynamicDrawUsage) // rewritten every frame
  coneGeo.setAttribute('glow', glowAttr)

  const coneMat = new THREE.MeshStandardNodeMaterial({
    color: BASALT_COLOR,
    flatShading: true,
    roughness: 0.9,
    metalness: 0.02,
  })
  // Emissive lava, built ONCE (S1 build-once/uniforms-only law): molten tint
  // scaled by the per-vertex lava mask and the per-instance glow. When glow
  // is 0 (dormant/cooled) the emissive is exactly 0 -> the lava has healed,
  // leaving plain dark basalt.
  const lavaMask = attribute('lava', 'float')
  const glowNode = attribute('glow', 'float')
  const lavaTint = mix(
    vec3(LAVA_DARK.x, LAVA_DARK.y, LAVA_DARK.z),
    vec3(LAVA_BRIGHT.x, LAVA_BRIGHT.y, LAVA_BRIGHT.z),
    lavaMask,
  )
  coneMat.emissiveNode = lavaTint.mul(lavaMask).mul(glowNode)
  coneMat.colorNode = color(BASALT_COLOR)

  const coneMesh = new THREE.InstancedMesh(coneGeo, coneMat, MAX_VOLCANOES)
  coneMesh.count = peaks.length
  coneMesh.frustumCulled = false // only a handful of instances; avoid stale bounds
  group.add(coneMesh)

  // --- volcano records + static instance transforms ------------------------
  const volcanoes = []
  for (let i = 0; i < peaks.length; i++) {
    const dir = peaks[i].dir.clone().normalize()
    const peakH = peaks[i].h
    const placeR = peakH - CONE_SINK // embed base into the mountain

    // Static instance matrix: base sits at placeR along dir, cone Y aligned
    // with the surface normal.
    _quat.setFromUnitVectors(UP, dir)
    _pos.copy(dir).multiplyScalar(placeR)
    _mat.compose(_pos, _quat, _scaleOne)
    coneMesh.setMatrixAt(i, _mat)

    const emitPos = dir.clone().multiplyScalar(placeR + CONE_HEIGHT * 0.85)
    const et1 = new THREE.Vector3()
    const et2 = new THREE.Vector3()
    tangentBasis(dir, et1, et2)

    const rng = rngFromString(seed + ':volcano:' + i)
    const v = {
      index: i,
      dir,
      emitPos,
      t1: et1,
      t2: et2,
      rng,
      phase: DORMANT,
      timer: 0,
      duration: 1,
      flickerPhase: rng() * TAU,
      ashTimer: 0,
      emberTimer: 0,
    }
    // Stagger the sequence so the volcanoes never erupt in lockstep; seed the
    // first two into visible activity for immediate life on load.
    if (i === 0) enterPhase(v, ERUPTION)
    else if (i === 1) enterPhase(v, SMOKING)
    else {
      enterPhase(v, DORMANT)
      v.timer = rng() * v.duration // desync the dormant clocks
    }
    volcanoes.push(v)
  }
  coneMesh.instanceMatrix.needsUpdate = true

  // --- ash Points pool (draw call 2) ---------------------------------------
  const ashPos = new Float32Array(ASH_POOL * 3)
  const ashCol = new Float32Array(ASH_POOL * 4) // RGBA -> true per-vertex alpha
  const ashVel = new Float32Array(ASH_POOL * 3)
  const ashAge = new Float32Array(ASH_POOL)
  const ashTtl = new Float32Array(ASH_POOL)
  let ashCursor = 0
  const ashGeo = new THREE.BufferGeometry()
  ashGeo.setAttribute('position', new THREE.BufferAttribute(ashPos, 3))
  ashGeo.setAttribute('color', new THREE.BufferAttribute(ashCol, 4))
  const ashMat = new THREE.PointsMaterial({
    size: ASH_SIZE,
    sizeAttenuation: false,
    vertexColors: true,
    transparent: true,
    opacity: 1,
    blending: THREE.NormalBlending, // ash/vapour, not glow
    depthWrite: false,
  })
  const ashPoints = new THREE.Points(ashGeo, ashMat)
  ashPoints.renderOrder = 1
  ashPoints.frustumCulled = false
  group.add(ashPoints)

  // --- ember Points pool (draw call 3) -------------------------------------
  const embPos = new Float32Array(EMBER_POOL * 3)
  const embCol = new Float32Array(EMBER_POOL * 4)
  const embVel = new Float32Array(EMBER_POOL * 3)
  const embAge = new Float32Array(EMBER_POOL)
  const embTtl = new Float32Array(EMBER_POOL)
  let embCursor = 0
  const embGeo = new THREE.BufferGeometry()
  embGeo.setAttribute('position', new THREE.BufferAttribute(embPos, 3))
  embGeo.setAttribute('color', new THREE.BufferAttribute(embCol, 4))
  const embMat = new THREE.PointsMaterial({
    size: EMBER_SIZE,
    sizeAttenuation: false,
    vertexColors: true,
    transparent: true,
    opacity: 1,
    blending: THREE.AdditiveBlending, // hot embers -> bloom
    depthWrite: false,
  })
  const embPoints = new THREE.Points(embGeo, embMat)
  embPoints.renderOrder = 2
  embPoints.frustumCulled = false
  group.add(embPoints)

  // --- particle spawn (ring-buffer slots; no allocation) -------------------
  function spawnAsh(v, intensity) {
    const slot = ashCursor
    ashCursor = (ashCursor + 1) % ASH_POOL
    const i3 = slot * 3
    const i4 = slot * 4
    const a = v.rng() * TAU
    const rise = lerp(ASH_RISE_SMOKE, ASH_RISE_ERUPT, intensity)
    _vel
      .copy(v.dir)
      .multiplyScalar(rise * (0.85 + v.rng() * 0.3))
      .addScaledVector(v.t1, Math.cos(a) * ASH_DRIFT)
      .addScaledVector(v.t2, Math.sin(a) * ASH_DRIFT)
    _emitPos
      .copy(v.emitPos)
      .addScaledVector(v.t1, (v.rng() - 0.5) * ASH_JITTER * 2)
      .addScaledVector(v.t2, (v.rng() - 0.5) * ASH_JITTER * 2)
    ashPos[i3] = _emitPos.x
    ashPos[i3 + 1] = _emitPos.y
    ashPos[i3 + 2] = _emitPos.z
    ashVel[i3] = _vel.x
    ashVel[i3 + 1] = _vel.y
    ashVel[i3 + 2] = _vel.z
    ashAge[slot] = 0
    ashTtl[slot] = lerp(ASH_TTL_MIN, ASH_TTL_MAX, v.rng())
    const g = lerp(ASH_SMOKE_GREY, ASH_ERUPT_GREY, intensity) * (0.9 + v.rng() * 0.15)
    ashCol[i4] = g
    ashCol[i4 + 1] = g
    ashCol[i4 + 2] = g
    ashCol[i4 + 3] = 0 // faded in by updateAsh
  }

  function spawnEmber(v) {
    const slot = embCursor
    embCursor = (embCursor + 1) % EMBER_POOL
    const i3 = slot * 3
    const i4 = slot * 4
    const a = v.rng() * TAU
    _vel
      .copy(v.dir)
      .multiplyScalar(EMBER_SPEED * (0.7 + v.rng() * 0.6))
      .addScaledVector(v.t1, Math.cos(a) * EMBER_SPREAD * (0.4 + v.rng() * 0.6))
      .addScaledVector(v.t2, Math.sin(a) * EMBER_SPREAD * (0.4 + v.rng() * 0.6))
    embPos[i3] = v.emitPos.x
    embPos[i3 + 1] = v.emitPos.y
    embPos[i3 + 2] = v.emitPos.z
    embVel[i3] = _vel.x
    embVel[i3 + 1] = _vel.y
    embVel[i3 + 2] = _vel.z
    embAge[slot] = 0
    embTtl[slot] = lerp(EMBER_TTL_MIN, EMBER_TTL_MAX, v.rng())
    const f = 0.75 + v.rng() * 0.5 // per-ember brightness scatter
    embCol[i4] = EMBER_R * f
    embCol[i4 + 1] = EMBER_G * f
    embCol[i4 + 2] = EMBER_B * f
    embCol[i4 + 3] = 0
  }

  function updateAsh(dt) {
    for (let slot = 0; slot < ASH_POOL; slot++) {
      const ttl = ashTtl[slot]
      if (ttl <= 0) continue
      const age = ashAge[slot] + dt
      const i3 = slot * 3
      const i4 = slot * 4
      if (age >= ttl) {
        ashTtl[slot] = 0
        ashCol[i4 + 3] = 0
        continue
      }
      ashAge[slot] = age
      ashPos[i3] += ashVel[i3] * dt
      ashPos[i3 + 1] += ashVel[i3 + 1] * dt
      ashPos[i3 + 2] += ashVel[i3 + 2] * dt
      const fadeIn = age < ASH_FADE_IN ? age / ASH_FADE_IN : 1
      ashCol[i4 + 3] = ASH_PEAK_ALPHA * fadeIn * (1 - age / ttl)
    }
    ashGeo.attributes.position.needsUpdate = true
    ashGeo.attributes.color.needsUpdate = true
  }

  function updateEmbers(dt) {
    for (let slot = 0; slot < EMBER_POOL; slot++) {
      const ttl = embTtl[slot]
      if (ttl <= 0) continue
      const age = embAge[slot] + dt
      const i3 = slot * 3
      const i4 = slot * 4
      if (age >= ttl) {
        embTtl[slot] = 0
        embCol[i4 + 3] = 0
        continue
      }
      embAge[slot] = age
      // gravity: pull the ember back toward the planet centre so it arcs
      _pos.set(embPos[i3], embPos[i3 + 1], embPos[i3 + 2])
      const len = _pos.length() || 1
      const g = EMBER_GRAVITY * dt
      embVel[i3] -= (_pos.x / len) * g
      embVel[i3 + 1] -= (_pos.y / len) * g
      embVel[i3 + 2] -= (_pos.z / len) * g
      embPos[i3] += embVel[i3] * dt
      embPos[i3 + 1] += embVel[i3 + 1] * dt
      embPos[i3 + 2] += embVel[i3 + 2] * dt
      const fadeIn = age < EMBER_FADE_IN ? age / EMBER_FADE_IN : 1
      embCol[i4 + 3] = EMBER_PEAK_ALPHA * fadeIn * (1 - age / ttl)
    }
    embGeo.attributes.position.needsUpdate = true
    embGeo.attributes.color.needsUpdate = true
  }

  // --- cycle -----------------------------------------------------------------
  let simTime = 0

  function updateVolcano(v, dt) {
    // Advance the phase clock (while-loop guards a dt larger than a phase).
    v.timer += dt
    while (v.timer >= v.duration) {
      v.timer -= v.duration
      advancePhase(v)
    }

    const t = clamp(v.timer / v.duration, 0, 1)
    let glow = 0
    let intensity = 0 // drives ash rate/darkness; 0 = no ash
    let embers = false

    switch (v.phase) {
      case DORMANT:
        glow = 0
        intensity = 0
        break
      case SMOKING:
        // a dull ember-red rises in the crater; a light steam-grey wisp
        glow = smoothstep(0, 1, t) * 0.4
        intensity = 0.2 + t * 0.15
        break
      case ERUPTION: {
        const ramp = smoothstep(0, 0.12, t) // fast spin-up
        const flick = 0.85 + 0.15 * Math.sin(simTime * FLICKER_FREQ + v.flickerPhase)
        glow = GLOW_PEAK * ramp * flick
        intensity = 1
        embers = true
        break
      }
      case COOLING:
        // molten crust darkens: glow fades to 0 (the lava heals), ash tapers
        glow = GLOW_PEAK * (1 - smoothstep(0, 1, t)) * 0.9
        intensity = (1 - t) * 0.6
        embers = t < 0.25 // a few last sparks
        break
    }

    glowArray[v.index] = glow

    if (intensity > 0) {
      v.ashTimer -= dt
      const interval = ASH_INTERVAL / (0.25 + intensity * 1.5)
      if (v.ashTimer <= 0) {
        v.ashTimer = interval
        spawnAsh(v, intensity)
      }
    }
    if (embers) {
      v.emberTimer -= dt
      if (v.emberTimer <= 0) {
        v.emberTimer = EMBER_INTERVAL
        spawnEmber(v)
      }
    }
  }

  function update(dt) {
    simTime += dt
    for (let i = 0; i < volcanoes.length; i++) updateVolcano(volcanoes[i], dt)
    glowAttr.needsUpdate = true
    updateAsh(dt)
    updateEmbers(dt)
  }

  return { group, update }
}

// ---------------------------------------------------------------------------
// Phase transitions (module-level so they don't re-close per volcano). Each
// entered phase draws its own seeded duration from the volcano's rng.
// ---------------------------------------------------------------------------
function enterPhase(v, phase) {
  v.phase = phase
  v.timer = 0
  switch (phase) {
    case DORMANT:
      v.duration = lerp(DORMANT_MIN, DORMANT_MAX, v.rng())
      break
    case SMOKING:
      v.duration = lerp(SMOKING_MIN, SMOKING_MAX, v.rng())
      break
    case ERUPTION:
      v.duration = lerp(ERUPTION_MIN, ERUPTION_MAX, v.rng())
      break
    case COOLING:
      v.duration = lerp(COOLING_MIN, COOLING_MAX, v.rng())
      break
  }
}

function advancePhase(v) {
  switch (v.phase) {
    case DORMANT:
      enterPhase(v, SMOKING)
      break
    case SMOKING:
      enterPhase(v, ERUPTION)
      break
    case ERUPTION:
      enterPhase(v, COOLING)
      break
    case COOLING:
      enterPhase(v, DORMANT)
      break
  }
}
