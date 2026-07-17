// Camera feel: the swoop-to-visit flight and the ground-skim terrain-
// following floor, both DECIDED with exact parameters at the M-LD camera
// verdict (docs/ART.md §7, binding — see also the program plan's M-LD camera
// verdict entry). Replaces world.js's old straight-chord click-to-visit
// tween with a real flight path (world.js keeps that old tween only as a
// fallback for when no cameraFeel instance is wired in); adds a soft floor
// so free orbiting near the surface never clips into terrain or dips under
// water.
//
// Camera ORIENTATION is intentionally untouched here. OrbitControls (see
// main.js) calls `camera.lookAt(controls.target)` at the end of every single
// controls.update() call, and controls.target is never moved anywhere in
// this app (enablePan=false, planet centered at the origin) — so the camera
// always looks at the planet center, every single frame, whether flying,
// skimming, or free-orbiting, regardless of what runs before it in the
// frame. Trying to set the camera's rotation/quaternion here would just be
// silently overwritten the moment controls.update() runs later in the same
// frame (main.js calls it last). ART.md's "look-at eases from current view
// direction to the target ground point" law falls out of this for free
// instead: flyTo's own arrival point sits on the ray from the planet center
// through the target ground point (arriveDist is a radial distance along
// targetDir), so looking at the center and looking at the ground point are
// the exact same ray at arrival; mid-flight, the arc sweeps the camera's
// overhead point from the start direction to the end direction, so "always
// look at center" already reads as the look-at easing across that same
// sweep. Same reasoning is why there's no banking/roll here (ART.md is
// explicit that free-orbit roll would fight OrbitControls' own lookAt).
import * as THREE from 'three/webgpu'
import { SEA_LEVEL, clamp, lerp, smoothstep } from './util.js'

const BASE_FOV = 45 // app baseline (main.js's PerspectiveCamera(45, ...)) -- every flight returns to exactly this
const FOV_PEAK_DELTA = 7 // 45 -> 52 -> 45 (ART.md §7 / M-LD camera verdict)
const ARC_FRACTION = 0.35 // outward loft, as a fraction of chord length, at the swoop's midpoint
const FLIGHT_MIN_DURATION = 2.2 // seconds -- short hops (M-LD camera verdict)
const FLIGHT_MAX_DURATION = 6.5 // seconds -- antipodal-ish hops

const FOV_RECOVER_DURATION = 0.4 // seconds -- eases an interrupted flight's FOV bump back to BASE_FOV (not part of ART.md's swoop envelope itself, since that only covers a completed flight; this is the "FOV eases back" half of the cancel law, so it borrows the app's standard smoothstep ease per ART.md §7's "nothing snaps" rule)

const SKIM_ACTIVE_DIST = 1.5 // radial distance below which the terrain-skim floor engages -- ART.md's own "mid" zoom tier starts ~1.35R (§2.2); a little headroom above that so the floor is already live before the camera is genuinely close, never a hard pop-on
const SKIM_HEIGHT_MARGIN = 0.008 // floor = sampleHeight(dir) + this (ART.md §7)
const SKIM_EASE_TARGET_MARGIN = 0.004 // eased-toward distance = floor + this (ART.md §7)
const SKIM_GAIN = 0.12 // ART.md §7 calls this a "gain," not a "rate" (contrast dragon.js's explicitly-dt-scaled "exponential chase rate (1/s)" constants) -- applied as a flat per-update() blend rather than dt-scaled, which is what actually damps sampleHeight's frame-to-frame jitter as camera direction drifts a hair; a dt-scaled reading of "0.12" would be far too sluggish to ever stop a mountain clip
const SKIM_WATER_MIN = SEA_LEVEL + 0.006 // never let the floor sink below this over ocean -- the water-spike lesson (ART.md §4/§7)

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
}

export function createCameraFeel(planet, camera, controls) {
  // --- flight state (set once per flyTo() call, read every update() while flying) ---
  let flying = false
  let elapsed = 0
  let duration = 1
  let chordLength = 0
  const startPos = new THREE.Vector3()
  const endPos = new THREE.Vector3()
  const targetDir = new THREE.Vector3()
  const chordDir = new THREE.Vector3()

  // --- FOV-recovery state (only used when a flight is cancelled mid-swoop;
  // a completed flight already returns FOV to BASE_FOV via its own sin
  // envelope in advanceFlight below) ---
  let recovering = false
  let recoverElapsed = 0
  let recoverFrom = BASE_FOV

  // Per-frame scratch, allocated once here and mutated in place on every
  // update() call -- zero per-frame allocation (ART.md).
  const _basePos = new THREE.Vector3()
  const _outward = new THREE.Vector3()
  const _dirScratch = new THREE.Vector3()

  function flyTo(targetDirUnitVec3, arriveDist) {
    startPos.copy(camera.position)
    targetDir.copy(targetDirUnitVec3).normalize() // defensive -- callers should already pass a unit vector
    endPos.copy(targetDir).multiplyScalar(arriveDist)
    chordLength = startPos.distanceTo(endPos)
    chordDir.copy(endPos).sub(startPos)
    if (chordLength > 1e-9) chordDir.divideScalar(chordLength)

    _dirScratch.copy(startPos).normalize()
    const angularDistance = Math.acos(clamp(_dirScratch.dot(targetDir), -1, 1))
    duration = lerp(FLIGHT_MIN_DURATION, FLIGHT_MAX_DURATION, angularDistance / Math.PI)

    elapsed = 0
    flying = true
    recovering = false
  }

  function isFlying() {
    return flying
  }

  // Any user input cancels the flight cleanly: position simply stops
  // advancing wherever it is, no forced completion and no snap-back: FOV
  // then eases back to BASE_FOV on its own short timer instead of jumping.
  function onPointerDown() {
    if (!flying) return
    flying = false
    recovering = true
    recoverElapsed = 0
    recoverFrom = camera.fov
  }
  controls.domElement.addEventListener('pointerdown', onPointerDown)

  function advanceFlight(dt) {
    elapsed += dt
    const rawT = clamp(elapsed / duration, 0, 1)
    const easedT = easeInOutCubic(rawT)
    _basePos.lerpVectors(startPos, endPos, easedT)

    // Arc loft: 0.35*sin(pi*rawT) of the chord length, zero at both ends,
    // peaking at the temporal midpoint -- a raw (unwarped) t is used here
    // rather than easedT so the loft (and the FOV envelope below, which
    // shares this same rawT-based sin bump) stays a clean, time-symmetric
    // hump regardless of how the position easing itself is shaped.
    //
    // Direction: the radial ("outward") reference at the current lerp point
    // — falling back to the flight's own start position on the antipodal/
    // equal-radius razor's edge, where the lerp point can pass through the
    // planet center and its own radial direction is undefined — projected
    // to be purely perpendicular to the chord (so the loft never also
    // stretches the endpoints apart, only bows the path between them).
    // ART.md's own words for why this is outward, not an arbitrary
    // perpendicular: "lofts out and settles instead of cutting through the
    // planet's own volume" -- only a center-outward push achieves that; a
    // chord between two near-sphere points dips toward the center, this
    // pushes the mid-flight point back away from it.
    const archMag = ARC_FRACTION * chordLength * Math.sin(Math.PI * rawT)
    camera.position.copy(_basePos)
    if (archMag > 1e-9) {
      _outward.copy(_basePos.lengthSq() > 1e-8 ? _basePos : startPos)
      _outward.addScaledVector(chordDir, -_outward.dot(chordDir))
      if (_outward.lengthSq() > 1e-8) {
        camera.position.addScaledVector(_outward.normalize(), archMag)
      }
      // else: a near-radial hop (chord ~ parallel to outward already) --
      // no well-defined perpendicular to loft along, and none is needed
      // (a purely radial chord never dips toward the center in the first
      // place), so the camera just stays on the plain lerp point this frame.
    }

    const fovEnvelope = Math.sin(Math.PI * rawT)
    camera.fov = BASE_FOV + FOV_PEAK_DELTA * fovEnvelope
    camera.updateProjectionMatrix()

    if (rawT >= 1) {
      flying = false
      camera.fov = BASE_FOV
      camera.updateProjectionMatrix()
    }
  }

  function advanceFovRecovery(dt) {
    recoverElapsed += dt
    const t = clamp(recoverElapsed / FOV_RECOVER_DURATION, 0, 1)
    camera.fov = lerp(recoverFrom, BASE_FOV, smoothstep(0, 1, t))
    camera.updateProjectionMatrix()
    if (t >= 1) {
      recovering = false
      camera.fov = BASE_FOV
    }
  }

  // SKIM law: a soft terrain-following floor for free orbiting near the
  // ground, active only when NOT flying (a swoop's own arc already keeps it
  // clear of terrain). floor = sampleHeight(dir) + 0.008, clamped up to
  // SEA_LEVEL+0.006 over ocean so the camera never dips under the visible
  // water plane either (the water-spike lesson, ART.md §4/§7). The eased-
  // toward target is max(currentDist, floor+0.004) -- a floor only ever
  // pushes the camera up/out, never pulls it in, so it can't fight the
  // user's own zoom over open ground.
  function enforceSkim() {
    const currentDist = camera.position.length()
    if (currentDist >= SKIM_ACTIVE_DIST) return

    _dirScratch.copy(camera.position).normalize()
    let floor = planet.sampleHeight(_dirScratch) + SKIM_HEIGHT_MARGIN
    if (!planet.isLand(_dirScratch)) floor = Math.max(floor, SKIM_WATER_MIN)

    const target = Math.max(currentDist, floor + SKIM_EASE_TARGET_MARGIN)
    const newDist = currentDist + (target - currentDist) * SKIM_GAIN
    camera.position.setLength(newDist)
  }

  function update(dt) {
    if (flying) {
      advanceFlight(dt)
      return
    }
    if (recovering) advanceFovRecovery(dt)
    enforceSkim()
  }

  return { flyTo, update, isFlying }
}
