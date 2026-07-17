// Automated verification kit: five named camera viewpoints computed live
// from scene state, a headless simulation fast-forward, and a full sweep
// (screenshots + draw calls + fps + a determinism hash) so a build can be
// verified without a human clicking through the scene by hand. Wired by
// main.js as `window.__planet.verify` -- see docs/superpowers/plans/
// 2026-07-16-m0-execution-plan.md (Task A) for the contract this implements.
import * as THREE from 'three'

// ---------------------------------------------------------------------------
// Viewpoints (names fixed by the M0 execution plan)
// ---------------------------------------------------------------------------
const VIEWPOINT_NAMES = ['orbit', 'mid-coast', 'ground-sunlit', 'night-city', 'storm']

const ORBIT_R = 3.2 // orbit: camera at 3.2R on the sunlit side
const MID_COAST_R = 1.42 // mid-coast: 1.42R over a sunlit coastline
const GROUND_SUNLIT_OFFSET = 0.01 // ground-sunlit: surface + 0.01R
const GROUND_SUNLIT_LOOK_DIST = 0.08 // ground-sunlit: tangent distance the look target sits at
const NIGHT_CITY_R = 1.35 // night-city: 1.35R over the settlement
const STORM_R = 2.0 // storm: 2.0R over the active hurricane

// A candidate/settlement point counts as "sunlit" once its dot with the sun
// direction clears this floor -- comfortably past the grazing terminator.
const SUNLIT_MIN_DOT = 0.15
// A settlement counts as "night" once its dot with the sun direction drops
// below this -- a little past the terminator, not just barely dusk.
const NIGHT_DOT_THRESHOLD = -0.05

// Coastline search (mid-coast): land, close to sea level, sunlit. There's no
// existing "coast" probe elsewhere in the codebase to mirror, so this reuses
// planet.biomeAt's landT + planet.isLand exactly like the other probes do,
// just with a much tighter landT ceiling (near-shore, not "anywhere on land").
const COAST_LANDT_MAX = 0.1
const COAST_LANDT_WEIGHT = 2 // how strongly "closer to shore" beats "more sunlit" when scoring

// Grass search (ground-sunlit): thresholds mirrored verbatim from flora.js's
// buildGrass() scatter probe, so "grass" here means the same thing it means
// to the renderer.
const GRASS_MIN_LAND_T = 0.02
const GRASS_MAX_LAND_T = 0.75
const GRASS_MAX_SLOPE = 0.55
const GRASS_MAX_POLAR = 0.5

// Storm maturity + seek budget (storm viewpoint).
const STORM_MATURE_THRESHOLD = 0.5 // storms.getPrimary() strength considered "worth showing"
const STORM_SEEK_STEP = 15
const STORM_SEEK_CAP = 120 // seconds -- per Task A's "seekTime forward up to 120s"

// Night-city seek budget (fallback path only, when no settlement is already
// on the night side). sky.js doesn't export its day-length constant, so this
// is sized generously rather than tied to it.
const NIGHT_CITY_SEEK_STEP = 50
const NIGHT_CITY_SEEK_CAP = 1000

const SEEK_DT = 1 / 30
const FPS_SAMPLE_MS = 3000

// Deterministic sphere-scan resolution for the coast/grass searches.
// planet.biomeAt is documented "load-time use only -- not tuned for
// per-frame calls"; a gotoViewpoint resolution is exactly that: a rare,
// verify-triggered scan, never a render-loop call.
const LATTICE_N = 1500

// ---------------------------------------------------------------------------
// Module scratch -- reused everywhere below; nothing here allocates per call.
// ---------------------------------------------------------------------------
const _sunDirScratch = new THREE.Vector3()
const _stormDirScratch = new THREE.Vector3()
const _candidateDir = new THREE.Vector3()
const _resultDir = new THREE.Vector3()
const _biomeScratch = {}
const _hashPos = new THREE.Vector3()
const _tangentScratch = new THREE.Vector3()
const WORLD_UP = new THREE.Vector3(0, 1, 0)
const WORLD_X = new THREE.Vector3(1, 0, 0)

// ---------------------------------------------------------------------------
// FNV-1a 32-bit
// ---------------------------------------------------------------------------
function fnv1a(str) {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

// ---------------------------------------------------------------------------
// Fibonacci-sphere scan lattice, built once and cached -- pure geometry, not
// seeded off the world, so it's stable across reloads and calls.
// ---------------------------------------------------------------------------
let _lattice = null
function getLattice() {
  if (_lattice) return _lattice
  const arr = new Float32Array(LATTICE_N * 3)
  const golden = Math.PI * (3 - Math.sqrt(5))
  for (let i = 0; i < LATTICE_N; i++) {
    const y = 1 - (i / (LATTICE_N - 1)) * 2
    const radius = Math.sqrt(Math.max(0, 1 - y * y))
    const theta = golden * i
    arr[i * 3] = Math.cos(theta) * radius
    arr[i * 3 + 1] = y
    arr[i * 3 + 2] = Math.sin(theta) * radius
  }
  _lattice = arr
  return arr
}

/** Arbitrary unit tangent at a point on the unit sphere (same trick as
 * world.js's tangentBasis / flora.js's plantedMatrix). */
function tangentAt(dir, out) {
  const ref = Math.abs(dir.y) > 0.95 ? WORLD_X : WORLD_UP
  out.crossVectors(ref, dir).normalize()
}

/** Scans the lattice for the sunlit, near-shore land point that best reads
 * as "coastline": on land, landT within COAST_LANDT_MAX of sea level, and
 * lit. Writes the winning direction into `out`; returns false (leaving `out`
 * untouched) if nothing qualifies. */
function findCoastDir(planet, sunDir, out) {
  const lattice = getLattice()
  let bestScore = -Infinity
  let found = false
  for (let i = 0; i < LATTICE_N; i++) {
    _candidateDir.set(lattice[i * 3], lattice[i * 3 + 1], lattice[i * 3 + 2])
    if (!planet.isLand(_candidateDir)) continue
    planet.biomeAt(_candidateDir, _biomeScratch)
    if (_biomeScratch.landT > COAST_LANDT_MAX) continue
    const sunlit = _candidateDir.dot(sunDir)
    if (sunlit < SUNLIT_MIN_DOT) continue
    const score = sunlit - _biomeScratch.landT * COAST_LANDT_WEIGHT
    if (score > bestScore) {
      bestScore = score
      out.copy(_candidateDir)
      found = true
    }
  }
  return found
}

/** Scans the lattice for the most brightly-lit point that reads as "grass"
 * under flora.js's own thresholds. Writes into `out`; returns false (leaving
 * `out` untouched) if nothing qualifies. */
function findGrassDir(planet, sunDir, out) {
  const lattice = getLattice()
  let bestSunlit = -Infinity
  let found = false
  for (let i = 0; i < LATTICE_N; i++) {
    _candidateDir.set(lattice[i * 3], lattice[i * 3 + 1], lattice[i * 3 + 2])
    if (!planet.isLand(_candidateDir)) continue
    planet.biomeAt(_candidateDir, _biomeScratch)
    if (_biomeScratch.landT < GRASS_MIN_LAND_T || _biomeScratch.landT > GRASS_MAX_LAND_T) continue
    if (_biomeScratch.slope >= GRASS_MAX_SLOPE) continue
    if (_biomeScratch.polar >= GRASS_MAX_POLAR) continue
    const sunlit = _candidateDir.dot(sunDir)
    if (sunlit < SUNLIT_MIN_DOT) continue
    if (sunlit > bestSunlit) {
      bestSunlit = sunlit
      out.copy(_candidateDir)
      found = true
    }
  }
  return found
}

/** Every settlement currently in the scene, read off world.group's own
 * hit-sphere userData (the same records world.js itself uses for
 * click-to-visit) instead of a separately maintained list -- so this can
 * never drift from what's actually placed. */
function collectSettlements(worldGroup) {
  const list = []
  const seen = new Set()
  worldGroup.traverse((obj) => {
    const s = obj.userData && obj.userData.settlement
    if (s && !seen.has(s.project)) {
      seen.add(s.project)
      list.push(s)
    }
  })
  return list
}

/** FNV-1a over every settlement anchor + structure root's world position,
 * sorted by a stable "type:id" key so build/poll order never affects the
 * hash. Positions are read via matrixWorld (not the stored dir*radius
 * numbers) so the hash reflects what's actually placed in the scene graph. */
function determinismHash(scene, worldGroup) {
  scene.updateMatrixWorld(true)
  const entries = []
  worldGroup.traverse((obj) => {
    const ud = obj.userData
    if (ud && ud.settlement) {
      obj.getWorldPosition(_hashPos)
      entries.push({
        key: 'settlement:' + ud.settlement.project,
        x: _hashPos.x,
        y: _hashPos.y,
        z: _hashPos.z,
      })
    } else if (ud && ud.structure) {
      const root = ud.structure.structureRoot || obj
      root.getWorldPosition(_hashPos)
      entries.push({ key: 'structure:' + ud.structure.id, x: _hashPos.x, y: _hashPos.y, z: _hashPos.z })
    }
  })
  if (entries.length === 0) {
    console.warn(
      '[planet] verifykit: determinismHash found zero settlement/structure anchors -- world may not be loaded yet',
    )
  }
  entries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  let str = ''
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]
    // Normalize -0 -> 0 so two logically-identical positions never hash
    // differently just because one arrived at -0 via float subtraction.
    const x = e.x === 0 ? 0 : e.x
    const y = e.y === 0 ? 0 : e.y
    const z = e.z === 0 ? 0 : e.z
    str += e.key + ':' + x.toFixed(5) + ',' + y.toFixed(5) + ',' + z.toFixed(5) + ';'
  }
  return fnv1a(str)
}

/** Counts real animation frames over `durationMs` of wall-clock time via
 * requestAnimationFrame, running alongside (not instead of) the normal
 * renderer.setAnimationLoop app loop already driving main.js. */
function sampleFps(durationMs) {
  return new Promise((resolve) => {
    let frames = 0
    const start = performance.now()
    function tick() {
      frames++
      const elapsed = performance.now() - start
      if (elapsed >= durationMs) resolve((frames * 1000) / elapsed)
      else requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
}

// ---------------------------------------------------------------------------
// createVerifyKit
// ---------------------------------------------------------------------------
export function createVerifyKit(handles) {
  // `controls` is part of the handles contract but intentionally unused:
  // gotoViewpoint drives camera.position/lookAt directly and must never
  // touch controls.target (see requirement below), so there is nothing to
  // read or write on it here.
  const { scene, camera, composer, renderer, planet, sky, world, birds, flora, wind, storms } = handles
  // M-WX modules — optional so an older embed of the kit still works; each is
  // pumped in seekTime only if present, matching the real render loop.
  const { seaIce, weather, seaLife, trails, floods } = handles

  // Headless sim fast-forward: fixed dt=1/30 steps, exactly main.js's update
  // order (minus ui.update/controls.update -- neither is part of this kit's
  // handles, and neither owns simulation state), then 3 renders so whatever
  // called this sees the jumped-to state. Zero allocations in the loop body:
  // every call below reuses module-level scratch.
  function seekTime(seconds) {
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) {
      console.warn(
        '[planet] verifykit: seekTime called with invalid seconds (' + seconds + '); treating as 0',
      )
      seconds = 0
    }
    const steps = Math.round(seconds / SEEK_DT)
    for (let i = 0; i < steps; i++) {
      planet.update(SEEK_DT)
      sky.update(SEEK_DT, camera)
      world.update(SEEK_DT)
      birds.update(SEEK_DT, camera)
      flora.update(SEEK_DT)
      wind.update(SEEK_DT)
      storms.update(SEEK_DT, sky.getSunDir(_sunDirScratch))
      sky.setStormClearing(_stormDirScratch, storms.getPrimary(_stormDirScratch))
      if (floods) floods.update(SEEK_DT)
      if (seaIce) seaIce.update(SEEK_DT)
      if (weather) weather.update(SEEK_DT, camera)
      if (seaLife) seaLife.update(SEEK_DT, camera)
      if (trails) trails.update(SEEK_DT)
    }
    composer.render()
    composer.render()
    composer.render()
  }

  // -- viewpoint resolvers, one per fixed name --------------------------

  function resolveOrbit() {
    sky.getSunDir(_sunDirScratch)
    camera.position.copy(_sunDirScratch).multiplyScalar(ORBIT_R)
    camera.lookAt(0, 0, 0)
    return { name: 'orbit', fallback: false }
  }

  function resolveMidCoast() {
    const sunDir = sky.getSunDir(_sunDirScratch)
    const found = findCoastDir(planet, sunDir, _resultDir)
    if (!found) {
      console.warn(
        '[planet] verifykit: no sunlit coastline found for mid-coast viewpoint; using fallback position',
      )
      _resultDir.copy(sunDir)
    }
    camera.position.copy(_resultDir).multiplyScalar(MID_COAST_R)
    camera.lookAt(0, 0, 0)
    return { name: 'mid-coast', fallback: !found }
  }

  function resolveGroundSunlit() {
    const sunDir = sky.getSunDir(_sunDirScratch)
    const found = findGrassDir(planet, sunDir, _resultDir)
    if (!found) {
      console.warn(
        '[planet] verifykit: no sunlit grass found for ground-sunlit viewpoint; using fallback position',
      )
      _resultDir.copy(sunDir)
    }
    const h = planet.sampleHeight(_resultDir)
    camera.position.copy(_resultDir).multiplyScalar(h + GROUND_SUNLIT_OFFSET)
    tangentAt(_resultDir, _tangentScratch)
    camera.lookAt(
      camera.position.x + _tangentScratch.x * GROUND_SUNLIT_LOOK_DIST,
      camera.position.y + _tangentScratch.y * GROUND_SUNLIT_LOOK_DIST,
      camera.position.z + _tangentScratch.z * GROUND_SUNLIT_LOOK_DIST,
    )
    return { name: 'ground-sunlit', fallback: !found }
  }

  function resolveNightCity() {
    const sunDir = sky.getSunDir(_sunDirScratch)
    const settlements = collectSettlements(world.group)

    if (settlements.length === 0) {
      console.warn(
        '[planet] verifykit: no settlements exist yet; using a fallback anti-solar viewpoint for night-city',
      )
      camera.position.copy(sunDir).multiplyScalar(-NIGHT_CITY_R)
      camera.lookAt(0, 0, 0)
      return { name: 'night-city', fallback: true }
    }

    // Primary rule: the settlement with the most structures that is
    // *currently* on the night side.
    let best = null
    let bestCount = -1
    for (let i = 0; i < settlements.length; i++) {
      const s = settlements[i]
      if (s.anchorDir.dot(sunDir) < NIGHT_DOT_THRESHOLD && s.structureDirs.length > bestCount) {
        bestCount = s.structureDirs.length
        best = s
      }
    }

    let fallback = false
    if (!best) {
      // Fallback: any settlement (the largest one, deterministically) plus
      // seekTime forward until it reaches night.
      fallback = true
      bestCount = -1
      for (let i = 0; i < settlements.length; i++) {
        const s = settlements[i]
        if (s.structureDirs.length > bestCount) {
          bestCount = s.structureDirs.length
          best = s
        }
      }
      console.warn(
        '[planet] verifykit: no settlement currently on the night side; seeking forward to ' +
          best.name +
          "'s night",
      )
      let elapsed = 0
      let dot = best.anchorDir.dot(sky.getSunDir(_sunDirScratch))
      while (elapsed < NIGHT_CITY_SEEK_CAP && dot >= NIGHT_DOT_THRESHOLD) {
        const step = Math.min(NIGHT_CITY_SEEK_STEP, NIGHT_CITY_SEEK_CAP - elapsed)
        seekTime(step)
        elapsed += step
        dot = best.anchorDir.dot(sky.getSunDir(_sunDirScratch))
      }
      if (dot >= NIGHT_DOT_THRESHOLD) {
        console.warn(
          '[planet] verifykit: settlement ' +
            best.name +
            ' never reached night within the seek budget; using its current (lit) position',
        )
      }
    }

    camera.position.copy(best.anchorDir).multiplyScalar(NIGHT_CITY_R)
    camera.lookAt(0, 0, 0)
    return { name: 'night-city', fallback }
  }

  function resolveStorm() {
    let strength = storms.getPrimary(_stormDirScratch)
    if (strength < STORM_MATURE_THRESHOLD) {
      let elapsed = 0
      while (elapsed < STORM_SEEK_CAP && strength < STORM_MATURE_THRESHOLD) {
        const step = Math.min(STORM_SEEK_STEP, STORM_SEEK_CAP - elapsed)
        seekTime(step)
        elapsed += step
        strength = storms.getPrimary(_stormDirScratch)
      }
    }

    let fallback = false
    if (strength > 0) {
      if (strength < STORM_MATURE_THRESHOLD) {
        console.warn(
          '[planet] verifykit: storm viewpoint using an immature storm after seeking ' + STORM_SEEK_CAP + 's',
        )
        fallback = true
      }
      camera.position.copy(_stormDirScratch).multiplyScalar(STORM_R)
    } else {
      console.warn(
        '[planet] verifykit: no active storm found after seeking ' +
          STORM_SEEK_CAP +
          's; using a fallback viewpoint',
      )
      fallback = true
      camera.position.copy(sky.getSunDir(_stormDirScratch)).multiplyScalar(STORM_R)
    }
    camera.lookAt(0, 0, 0)
    return { name: 'storm', fallback }
  }

  function gotoViewpoint(name) {
    if (name === 'orbit') return resolveOrbit()
    if (name === 'mid-coast') return resolveMidCoast()
    if (name === 'ground-sunlit') return resolveGroundSunlit()
    if (name === 'night-city') return resolveNightCity()
    if (name === 'storm') return resolveStorm()
    console.warn('[planet] verifykit: unknown viewpoint "' + name + '", falling back to orbit')
    resolveOrbit()
    return { name, fallback: true }
  }

  function listViewpoints() {
    return VIEWPOINT_NAMES.slice()
  }

  async function sweep() {
    const shots = {}
    const drawCalls = {}
    const fallbacks = []

    for (let i = 0; i < VIEWPOINT_NAMES.length; i++) {
      const name = VIEWPOINT_NAMES[i]
      try {
        const res = gotoViewpoint(name)
        if (res && res.fallback) fallbacks.push(name)
        // renderer.info resets per render pass, and the composer's last pass
        // is a 1-call fullscreen quad — read scene stats from a direct render
        // FIRST, then composer.render() for the tone-mapped shot.
        renderer.render(scene, camera)
        drawCalls[name] = renderer.info.render.calls
        composer.render()
        shots[name] = renderer.domElement.toDataURL('image/jpeg', 0.7)
      } catch (err) {
        console.warn('[planet] verifykit: viewpoint "' + name + '" failed: ' + String(err) + '; shot omitted')
        shots[name] = null
        drawCalls[name] = 0
        fallbacks.push(name)
      }
    }

    const fps = await sampleFps(FPS_SAMPLE_MS)
    const hash = determinismHash(scene, world.group)

    return { shots, drawCalls, fps, determinismHash: hash, fallbacks }
  }

  return { gotoViewpoint, seekTime, sweep, listViewpoints }
}
