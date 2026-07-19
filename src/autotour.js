// AUTO-TOUR — a seeded cinematic camera path that visits notable settlements
// in a deterministic order, dwelling with a gentle auto-rotate at each stop
// before flying to the next, and looping forever until a user takes the
// wheel back. Pure camera/OrbitControls choreography (no THREE, no scene
// object — exempt from the WebGPU/TSL engine constraint, same as
// herald.js/events.js's non-scene modules).
//
// Flight itself is entirely delegated to cameraFeel.js (the M-LD swoop),
// which already cancels its own in-flight arc on a canvas pointerdown; this
// module rides on top of that and additionally halts its OWN state machine
// on the same pointerdown, so a user drag both cancels the flight AND stops
// the tour in one gesture — no fighting, no re-issued flyTo chasing the
// user's own input.
//
// Determinism (COVENANT-safe, presentation only): the visiting order is a
// seeded Fisher–Yates shuffle over world.getAnchors(), weighted toward
// 'notable' settlements by pre-sorting on structure count before the
// shuffle. No Math.random/Date.now anywhere; dwell timing is the ordinary
// presentation dt clock, same as every other sim-owned prop in this app.
import { rngFromString } from './util.js'

const TOUR_STOPS_MAX = 8 // cap the tour to the N most 'notable' settlements (by structure count)
const DWELL_SECONDS = 6 // seconds spent lingering, slowly auto-rotating, at each stop
const DWELL_AUTOROTATE_SPEED = 0.3 // gentle cinematic spin while dwelling (OrbitControls' own units)

// Fisher–Yates in place, driven by a seeded rng() -> [0,1) generator (never Math.random).
function seededShuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    const tmp = arr[i]
    arr[i] = arr[j]
    arr[j] = tmp
  }
}

// `planet` is accepted (and unused) to keep the signature stable per the
// module contract — every call site passes it positionally alongside
// world/cameraFeel/controls/camera.
export function createAutoTour(_planet, world, cameraFeel, controls, camera, seed) {
  let running = false
  let tourStops = [] // [{ project, name, anchorDir, structures, race }, ...] this run's seeded order
  let index = 0
  let phase = 'fly' // 'fly' | 'dwell'
  let dwellTimer = 0
  let savedAutoRotate = false
  let savedAutoRotateSpeed = controls.autoRotateSpeed

  // Issue the flight to the current stop and enter the FLY phase. Called
  // once per stop (on start() and whenever DWELL completes) -- update()
  // itself never re-issues flyTo, it only watches cameraFeel.isFlying().
  function issueFlyToCurrent() {
    const stop = tourStops[index]
    const arriveDist = Math.max(1.3, 0.45 * camera.position.length())
    cameraFeel.flyTo(stop.anchorDir, arriveDist) // anchorDir is a LIVE unit vector -- flyTo only reads/copies it, never mutates
    phase = 'fly'
  }

  function start() {
    if (running) return
    const anchors = world.getAnchors ? world.getAnchors() : []
    if (!anchors || anchors.length === 0) return // no settlements yet -- no-op, isRunning stays false

    // Weight 'notable' toward higher structure counts: sort desc, take the
    // top N, THEN shuffle those with the seeded rng -- so the tour favors
    // the biggest holds while still varying the order deterministically.
    const sorted = anchors.slice().sort((a, b) => b.structures - a.structures)
    const top = sorted.slice(0, Math.min(TOUR_STOPS_MAX, sorted.length))
    seededShuffle(top, rngFromString(seed + ':autotour'))
    tourStops = top

    index = 0
    savedAutoRotate = controls.autoRotate
    savedAutoRotateSpeed = controls.autoRotateSpeed
    running = true
    issueFlyToCurrent()
  }

  function stop() {
    if (!running) return
    running = false
    controls.autoRotate = savedAutoRotate
    controls.autoRotateSpeed = savedAutoRotateSpeed
  }

  function toggle() {
    if (running) stop()
    else start()
  }

  function isRunning() {
    return running
  }

  function update(dt) {
    if (!running) return

    if (phase === 'fly') {
      if (cameraFeel.isFlying()) return // still en route -- wait
      phase = 'dwell'
      dwellTimer = DWELL_SECONDS
      controls.autoRotate = true
      controls.autoRotateSpeed = DWELL_AUTOROTATE_SPEED
      return
    }

    // phase === 'dwell'
    dwellTimer -= dt
    if (dwellTimer <= 0) {
      controls.autoRotate = false
      index = (index + 1) % tourStops.length
      issueFlyToCurrent() // sets phase back to 'fly'
    }
  }

  // Any user drag on the canvas stops the tour outright (cameraFeel already
  // cancels its own in-flight arc on this same event -- see cameraFeel.js).
  controls.domElement.addEventListener('pointerdown', stop)

  return { start, stop, toggle, isRunning, update }
}
