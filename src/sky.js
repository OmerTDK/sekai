// Stars, atmosphere, clouds, moons and all scene lighting for the stylized
// planet. Everything here is deterministic from the seed string — same seed,
// same sky, every launch. This module owns every light in the scene.
import * as THREE from 'three/webgpu'
import {
  uniform,
  texture,
  attribute,
  uv,
  pointUV,
  vertexColor,
  positionWorld,
  normalWorld,
  cameraPosition,
  vec2,
  vec3,
  float,
  mix,
  smoothstep as tslSmoothstep,
  select,
  materialReference,
  Fn,
} from 'three/tsl'
import { makeNoise3D, fbm, rngFromString, clamp, lerp, smoothstep } from './util.js'

const Y_AXIS = new THREE.Vector3(0, 1, 0)

// Other modules assume this exact sun direction — do not change.
const SUN_DIR = new THREE.Vector3(1, 0.45, 0.9).normalize()

// -------------------------------------------------------------- eclipses --
// A moon eclipses the sun when its world direction from the planet lines up
// with the sun's. Threshold is in dot-product space (1 = perfectly aligned):
// 0.9975 ~= 4.05 deg separation (onset), 0.9997 ~= 1.4 deg (full). Generous
// on purpose — see createSky() update() for the frequency this produces.
const ECLIPSE_ALIGN_LOW = 0.9975
const ECLIPSE_ALIGN_HIGH = 0.9997

// SUMMON-WEATHER (god-controls): triggerEclipse() re-aims moon 0's orbit so its
// great circle passes through the CURRENT sun direction, parking the moon this
// many radians "before" the sun along its own motion so the eclipse begins
// within a frame or two and then deepens to full as the moon slides onto the
// sun. 0.07 rad (~4deg) is right at the ECLIPSE_ALIGN_LOW onset edge (acos of
// 0.9975), so it starts almost immediately without snapping straight to a full
// corona.
const ECLIPSE_TRIGGER_LEAD = 0.07

const SUN_BASE_INTENSITY = 2.3
const SUN_ECLIPSE_INTENSITY = SUN_BASE_INTENSITY * 0.35
const HEMI_BASE_INTENSITY = 0.62
const HEMI_ECLIPSE_INTENSITY = HEMI_BASE_INTENSITY * 0.6
const SUN_BASE_COLOR = new THREE.Color('#fff2d8')
const SUN_ECLIPSE_TINT = new THREE.Color('#ffd0b0')

const CORONA_BASE_SCALE = 9
const CORONA_MAX_SCALE = CORONA_BASE_SCALE * 1.6
const CORONA_MAX_OPACITY = 0.85

const TWO_PI = Math.PI * 2

export function createSky(seed) {
  const group = new THREE.Group()

  const skybox = createSkybox(seed)
  group.add(skybox.mesh)
  group.add(createStarfield(seed))
  group.add(createNebulae(seed))
  group.add(createAtmosphere())
  const sunSprite = createSunSprite()
  group.add(sunSprite)

  // Eclipse corona: a soft additive ring-glow sprite that lives behind the
  // sun sprite and only becomes visible as the eclipse factor rises.
  let corona = null
  try {
    corona = createCoronaSprite()
    group.add(corona)
  } catch (err) {
    console.warn(
      '[planet] sky: corona degraded — sprite failed to build, eclipses will render without the corona flourish',
      err,
    )
    corona = null // corona is a flourish — the sun/eclipse lighting still works without it
  }

  const clouds = createClouds(seed)
  group.add(clouds.lowerMesh, clouds.upperMesh)

  const lights = createLights()
  group.add(lights.sun, lights.target, lights.hemi, lights.moonFill)

  const moons = createMoons(seed)
  for (const moon of moons) group.add(moon.pivot)

  // Aurora curtains: two wavy ribbons per pole, seeded shape baked once at
  // build time, shaded live (flow + night-side gating) each frame.
  let aurora = null
  try {
    aurora = createAurora(seed)
    group.add(aurora.group)
  } catch (err) {
    console.warn(
      '[planet] sky: aurora degraded — curtains failed to build, night sky will render without aurora',
      err,
    )
    aurora = null
  }

  // Shooting-star pool: five reusable streaks, each on its own seeded timer.
  let meteors = null
  try {
    meteors = createMeteors(seed)
    group.add(meteors.group)
  } catch (err) {
    console.warn(
      '[planet] sky: meteors degraded — shooting-star pool failed to build, no meteors this session',
      err,
    )
    meteors = null
  }

  // Day/night cycle: the sun sweeps a full orbit every ~15 minutes so every
  // settlement gets its dawn (with a fixed sun, half the world would live in
  // eternal night).
  const SUN_ORBIT_RATE = (Math.PI * 2) / 900

  // Fast-time control: the sun's per-frame advance is multiplied by this
  // (default 1 = the ~15-min day above). setSunSpeed(60) makes a full day
  // take ~15s so the terminator sweeps visibly and the night side (city
  // lights/aurora) lights up. Purely a time-of-day scrub — no material or
  // default-behavior change; every downstream visual already reads from the
  // sun's live position each frame, so speeding that up is all it takes.
  let sunSpeed = 1

  // SUMMON-WEATHER aurora burst: seconds remaining on the current triggerAurora()
  // boost (0 = no burst). Counted down in update() and mapped onto the aurora's
  // uBoost uniform there. Accumulated from dt only — no Date.now/wall clock.
  let auroraBoostTimer = 0

  // Per-frame scratch vectors (reused every call — no per-frame allocation).
  const _sunDirScratch = new THREE.Vector3()
  const _moonDirScratch = new THREE.Vector3()
  const _invQuatScratch = new THREE.Quaternion()
  const _localDirScratch = new THREE.Vector3()
  const _shadowM4Scratch = new THREE.Matrix4()

  // Scratch for triggerEclipse() (user-triggered, not per-frame — hoisted only
  // to avoid leaving garbage behind on each god-control click).
  const _eclSunScratch = new THREE.Vector3()
  const _eclRefScratch = new THREE.Vector3()
  const _eclTangentScratch = new THREE.Vector3()
  const _eclNormalScratch = new THREE.Vector3()
  const _eclBasisScratch = new THREE.Matrix4()

  function update(dt /* sec */, camera /* THREE.PerspectiveCamera */) {
    clouds.lowerMesh.rotateOnWorldAxis(clouds.lowerAxis, clouds.lowerRate * dt)
    clouds.upperMesh.rotateOnWorldAxis(clouds.upperAxis, clouds.upperRate * dt)
    for (const moon of moons) moon.pivot.rotateY(moon.rate * dt)

    const sunAngle = SUN_ORBIT_RATE * dt * sunSpeed
    lights.sun.position.applyAxisAngle(Y_AXIS, sunAngle)
    sunSprite.position.applyAxisAngle(Y_AXIS, sunAngle)
    lights.moonFill.position.copy(lights.sun.position).multiplyScalar(-1)

    // Solar eclipses: e is recomputed from scratch every frame (never
    // stored), so every visual response below is just e's current value —
    // no eclipse-start/eclipse-end state machine, it simply tracks alignment.
    _sunDirScratch.copy(lights.sun.position).normalize()

    // 2.5D cloud shading (M-SKY): each shell rotates on its OWN independent
    // axis/rate (see lowerAxis/upperAxis above), so the sun's direction in
    // "shell-local UV space" has to be recomputed per shell, every frame —
    // see applyStormClearing's injected fragment block for how uSunUV gets
    // consumed (offset-sample the alphaMap toward it to fake a bit of cloud
    // thickness/self-shadowing without a real raymarch).
    _invQuatScratch.copy(clouds.lowerMesh.quaternion).invert()
    _localDirScratch.copy(_sunDirScratch).applyQuaternion(_invQuatScratch)
    localDirToUV(_localDirScratch, clouds.lowerSunUniforms.uSunUV.value)
    // Cloud-shadows-on-terrain contract (M-SKY, architect-pinned — see
    // getCloudShadowUniforms below): reuse the SAME world->local rotation
    // for planet.js's shader uniform instead of building it twice.
    _shadowM4Scratch.makeRotationFromQuaternion(_invQuatScratch)
    cloudShadowUniforms.uCloudMat.value.setFromMatrix4(_shadowM4Scratch)
    cloudShadowUniforms.uCloudTex.value = clouds.lowerMesh.material.alphaMap

    _invQuatScratch.copy(clouds.upperMesh.quaternion).invert()
    _localDirScratch.copy(_sunDirScratch).applyQuaternion(_invQuatScratch)
    localDirToUV(_localDirScratch, clouds.upperSunUniforms.uSunUV.value)

    let eclipseFactor = 0
    for (const moon of moons) {
      moon.mesh.getWorldPosition(_moonDirScratch).normalize()
      const alignment = _moonDirScratch.dot(_sunDirScratch)
      const e = smoothstep(ECLIPSE_ALIGN_LOW, ECLIPSE_ALIGN_HIGH, alignment)
      if (e > eclipseFactor) eclipseFactor = e
    }
    lights.sun.intensity = lerp(SUN_BASE_INTENSITY, SUN_ECLIPSE_INTENSITY, eclipseFactor)
    lights.hemi.intensity = lerp(HEMI_BASE_INTENSITY, HEMI_ECLIPSE_INTENSITY, eclipseFactor)
    lights.sun.color.copy(SUN_BASE_COLOR).lerp(SUN_ECLIPSE_TINT, eclipseFactor)
    if (corona) {
      corona.position.copy(sunSprite.position)
      const coronaScale = lerp(CORONA_BASE_SCALE, CORONA_MAX_SCALE, eclipseFactor)
      corona.scale.set(coronaScale, coronaScale, 1)
      corona.material.opacity = CORONA_MAX_OPACITY * eclipseFactor
    }

    // Aurora: one shared clock + sun direction drives all curtain meshes;
    // the shader itself gates brightness to the night side per-fragment.
    if (aurora) {
      aurora.uniforms.uTime.value += dt
      aurora.uniforms.uSunDir.value.copy(_sunDirScratch)
      // SUMMON-WEATHER burst: decay the boost from AURORA_BOOST_MAX back to 1
      // over AURORA_BOOST_DURATION. Only a uniform value write — the node graph
      // never changes (no ~140ms recompile hitch).
      if (auroraBoostTimer > 0) {
        auroraBoostTimer = Math.max(0, auroraBoostTimer - dt)
        const t = auroraBoostTimer / AURORA_BOOST_DURATION
        aurora.uniforms.uBoost.value = 1 + (AURORA_BOOST_MAX - 1) * t
      } else if (aurora.uniforms.uBoost.value !== 1) {
        aurora.uniforms.uBoost.value = 1
      }
    }

    // Fade the cloud deck away as the camera dives toward the surface, so
    // close-up views of settlements aren't fogged out. Full deck from 2.4R
    // out, thin wisps by 1.35R.
    const dist = camera.position.length()
    const fade = smoothstep(1.35, 2.4, dist)
    clouds.lowerMesh.material.opacity = 0.88 * Math.max(fade, 0.08)
    clouds.upperMesh.material.opacity = 0.5 * Math.max(fade, 0.05)
    // Cloud shadows on terrain use the RAW fade (reaching true 0), not the
    // deck's own floored opacity above — a strongly-darkened ground patch
    // under a barely-visible wisp at ground level would read as a bug, not
    // a feature, so shadows fade out completely by the same 1.35R point.
    cloudShadowUniforms.uCloudShadowOn.value = fade

    // Shooting stars: five independently-timed slots. Steady-state cost per
    // slot is one counter compare — geometry/material are only touched on
    // the (multi-second) transitions between waiting and active.
    if (meteors) {
      for (const meteor of meteors.meteors) {
        meteor.timer += dt
        if (meteor.active) {
          const t = meteor.timer / meteor.phaseDuration
          if (t >= 1) {
            scheduleMeteorWait(meteor)
          } else {
            const envelope =
              t < METEOR_FLASH_FRACTION
                ? smoothstep(0, METEOR_FLASH_FRACTION, t)
                : 1 - smoothstep(METEOR_FLASH_FRACTION, 1, t)
            meteor.line.material.opacity = envelope
          }
        } else if (meteor.timer >= meteor.phaseDuration) {
          activateMeteor(meteor)
        }
      }
    }
  }

  // Current sun direction (unit vector), written into `out` — used by other
  // modules (e.g. the sun-seeking hurricane).
  function getSunDir(out) {
    return out.copy(lights.sun.position).normalize()
  }

  // Hurricane clears the ambient cloud deck around itself; main.js feeds the
  // storm's position + intensity here each frame.
  function setStormClearing(dir, strength) {
    stormClearUniforms.uStormDir.value.copy(dir)
    stormClearUniforms.uStormOn.value = strength
  }

  // M-WX weather hook (B3, pinned contract): CPU-side cloud-cover sample at
  // an arbitrary world DIRECTION, 0..1, read from the lower deck's own
  // already-baked coverage field (see makeCloudTexture/createClouds) — NO
  // GPU readback, no new noise calls. Mirrors the lower shell's live drift
  // (rotateOnWorldAxis in update() above) via its current quaternion, the
  // SAME world-dir -> shell-local -> UV path update() already uses for
  // uSunUV/cloud-shadow (see localDirToUV's doc comment) — so "is it cloudy
  // here" always agrees with what's actually rendered overhead, moving deck
  // included. Cheap (one quaternion invert + one vector rotate per call).
  let _coverageWarned = false
  const _coverQuatScratch = new THREE.Quaternion()
  const _coverDirScratch = new THREE.Vector3()
  const _coverUVScratch = new THREE.Vector2()
  function sampleCloudCover(dir) {
    const cov = clouds.lowerCoverage
    if (!cov) {
      if (!_coverageWarned) {
        _coverageWarned = true
        console.warn('[planet] sky: cloud coverage data unavailable — sampleCloudCover always returns 0')
      }
      return 0
    }
    _coverQuatScratch.copy(clouds.lowerMesh.quaternion).invert()
    _coverDirScratch.copy(dir).normalize().applyQuaternion(_coverQuatScratch)
    localDirToUV(_coverDirScratch, _coverUVScratch)
    const w = clouds.lowerCoverageWidth
    const h = clouds.lowerCoverageHeight
    // Invert localDirToUV's own u = 1 - x/(w-1), v = 1 - y/(h-1) mapping
    // (see that function's doc comment) back to the field's row-major (x,y).
    const xf = (1 - _coverUVScratch.x) % 1
    const yf = 1 - _coverUVScratch.y
    const x = clamp(Math.round(xf * (w - 1)), 0, w - 1)
    const y = clamp(Math.round(yf * (h - 1)), 0, h - 1)
    return cov[y * w + x]
  }

  // skyboxBakeMs: debug/verification handle only (read via
  // window.__planet.sky.skyboxBakeMs) — confirms the ≤1.5s bake budget
  // without adding a new console.log convention (this codebase only warns).
  // Cloud decks live inside the sky group alongside stars/atmosphere, so a
  // clean per-deck visibility toggle (for the UI feature panel) beats hiding
  // the whole group. Rotation/shadow updates keep running while hidden — the
  // meshes just aren't drawn — so re-showing is seamless.
  function setCloudsVisible(on) {
    clouds.lowerMesh.visible = on
    clouds.upperMesh.visible = on
  }
  function getCloudsVisible() {
    return clouds.lowerMesh.visible
  }

  // Fast-sun time control (owner request): scale the sun's per-frame orbital
  // advance. 1 = default (~15-min day); 60 => ~15s day. Coerced to a finite,
  // non-negative number so a stray UI value can't NaN-poison the sun's
  // position (which many other modules read). 0 freezes the sun.
  function setSunSpeed(multiplier) {
    const m = Number(multiplier)
    sunSpeed = Number.isFinite(m) && m >= 0 ? m : 1
  }
  function getSunSpeed() {
    return sunSpeed
  }

  // SUMMON-WEATHER (god-controls): force a bright aurora burst. Reuses the
  // existing aurora curtains — just kicks the shared uBoost uniform to its peak;
  // update() ramps it back to 1 over AURORA_BOOST_DURATION. Calling again
  // re-arms (refreshes) the burst. No-op (safely) if the aurora degraded at
  // build time.
  function triggerAurora() {
    if (!aurora) return
    auroraBoostTimer = AURORA_BOOST_DURATION
    aurora.uniforms.uBoost.value = AURORA_BOOST_MAX
  }

  // SUMMON-WEATHER (god-controls): force a solar eclipse to begin soon. Reuses
  // the existing eclipse system (which just tracks moon<->sun alignment every
  // frame) by re-aiming moon 0 — the guaranteed-eclipser — so its orbital great
  // circle passes through the current sun direction, then parking it
  // ECLIPSE_TRIGGER_LEAD radians "before" the sun along its own motion. The
  // moon's normal per-frame rotateY then slides it straight onto the sun,
  // crossing ECLIPSE_ALIGN_LOW within a frame or two and deepening to a full
  // corona at closest approach. No new state machine — update()'s existing
  // alignment scan does the rest. Uses only the CURRENT sun direction (no
  // Date.now/Math.random); scratch is hoisted so this makes no lasting garbage.
  function triggerEclipse() {
    if (!moons || moons.length === 0) return
    const moon = moons[0]
    const s = _eclSunScratch.copy(lights.sun.position).normalize()
    // Any unit vector perpendicular to the sun — the moon's approach tangent /
    // second orbit-basis axis. Avoids the degenerate case near the poles.
    const ref = Math.abs(s.y) < 0.9 ? Y_AXIS : _eclRefScratch.set(1, 0, 0)
    const e2 = _eclTangentScratch.copy(ref).addScaledVector(s, -ref.dot(s)).normalize()
    const c1 = _eclNormalScratch.crossVectors(e2, s) // e2 x s -> proper right-handed basis
    // Rotation whose columns are (xHat->s, yHat->c1, zHat->e2): moon 0's local
    // orbit circle in the XZ plane now maps to the great circle through the sun.
    _eclBasisScratch.makeBasis(s, c1, e2)
    moon.pivot.quaternion.setFromRotationMatrix(_eclBasisScratch)
    moon.pivot.rotateY(-ECLIPSE_TRIGGER_LEAD) // back off so it slides INTO the sun, not onto it
  }

  return {
    group,
    update,
    getSunDir,
    setStormClearing,
    sampleCloudCover,
    setCloudsVisible,
    getCloudsVisible,
    setSunSpeed,
    getSunSpeed,
    triggerAurora,
    triggerEclipse,
    skyboxBakeMs: skybox.bakeMs,
  }
}

// ---------------------------------------------------------------- helpers --

/** Uniform random point on the unit sphere via the z = 2u-1 method. */
function randomOnUnitSphere(rng, out = new THREE.Vector3()) {
  const z = 2 * rng() - 1
  const t = rng() * Math.PI * 2
  const r = Math.sqrt(Math.max(0, 1 - z * z))
  return out.set(r * Math.cos(t), r * Math.sin(t), z)
}

/** Box-Muller gaussian sample, mean 0. */
function gaussian(rng, sigma = 1) {
  const u1 = Math.max(rng(), 1e-9)
  const u2 = rng()
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(Math.PI * 2 * u2) * sigma
}

/** A seeded great-circle basis {normal, u, v}, shared by the milky-way band
 * and the nebula patches so the patches sit convincingly inside the band. */
function bandBasis(seed) {
  const rng = rngFromString(seed + ':band')
  const normal = randomOnUnitSphere(rng)
  const ref = Math.abs(normal.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)
  const u = new THREE.Vector3().crossVectors(ref, normal).normalize()
  const v = new THREE.Vector3().crossVectors(normal, u).normalize()
  return { normal, u, v }
}

/** A point at angular distance `phi` (radians) from the great circle defined
 * by {normal, u, v}, at circle-angle `theta`. Always unit length. */
function pointNearGreatCircle(normal, u, v, theta, phi, out = new THREE.Vector3()) {
  out.copy(u).multiplyScalar(Math.cos(theta)).addScaledVector(v, Math.sin(theta))
  out.multiplyScalar(Math.cos(phi)).addScaledVector(normal, Math.sin(phi))
  return out.normalize()
}

/** Local-space unit direction -> this file's SphereGeometry UV convention,
 * for the default full-sphere case (phiStart=0, thetaStart=0, thetaLength=PI,
 * phiLength=2*PI — i.e. the cloud shells, NOT the storm patch's partial
 * sweep). Matches THREE's own SphereGeometry formula exactly (see
 * node_modules/three/src/geometries/SphereGeometry.js): a vertex at
 * colatitude theta (0 at +Y pole) and azimuth phi has stored uv
 * (phi/(2*PI), 1 - theta/PI), and x = -sin(theta)*cos(phi),
 * z = sin(theta)*sin(phi) -> theta = acos(y), phi = atan2(z, -x).
 * Used for the cloud shells' per-frame sun-UV uniform (2.5D shading below)
 * and documented again in getCloudShadowUniforms() for planet.js to
 * replicate in GLSL (a 3x3/4x4 matrix alone can't express this — it's
 * fundamentally nonlinear — so the matrix only carries the ROTATION part,
 * this formula finishes the direction->UV step). */
function localDirToUV(dir, out) {
  const theta = Math.acos(clamp(dir.y, -1, 1))
  let phi = Math.atan2(dir.z, -dir.x)
  if (phi < 0) phi += TWO_PI
  return out.set(phi / TWO_PI, 1 - theta / Math.PI)
}

function makeRadialCanvasTexture(stops, size = 128) {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  for (const [offset, color] of stops) g.addColorStop(offset, color)
  ctx.fillStyle = g
  ctx.fillRect(0, 0, size, size)
  return new THREE.CanvasTexture(canvas)
}

// ----------------------------------------------------------------- skybox --
// Baked backdrop (M-SKY): the point-based star layers below (core/band/
// bright) are a flat scatter of dots — cheap-looking on their own. This
// bakes a single, rich equirectangular texture ONCE per seed (milky-way
// band density following the SAME great-circle basis the point band and
// nebulae use, dust-lane dark filaments carved by a second/independent fbm,
// blue-white-core-to-warm-rim color grading, and a handful of baked soft
// star-glow blobs) and maps it onto a giant sphere drawn FIRST every frame
// via a very negative renderOrder + disabled depth test/write — the
// standard three.js "skybox" trick, so it always sits behind literally
// everything else regardless of its numeric radius vs. the point stars'
// (88-90). This AUGMENTS the point layers (kept for parallax twinkle on
// top), it doesn't retire them — both together read far less flat than
// either alone.
const SKYBOX_RADIUS = 85
const SKYBOX_TEX_WIDTH = 2048 // >= 2K effective resolution, per the M-SKY brief
const SKYBOX_TEX_HEIGHT = 1024
const SKYBOX_BAKE_BUDGET_MS = 1500

// Cache in-module; regeneration only per seed (M-SKY requirement) — a canvas
// bake is comparatively expensive, and createSky() has no other reason to
// ever rebuild the same seed's skybox twice.
let _skyboxCache = null // { seed, texture, bakeMs }

/** Cheap deterministic 0..1 hash of two ints + a salt — NOT simplex noise,
 * just a scrambled integer avalanche. Used for the fine pointlike star
 * sprinkle, where a full fbm() call per texel (2M+ texels) would be
 * needless cost for something that's supposed to look like sparse noise
 * anyway. */
function hashTexel(ix, iy, salt) {
  let h = (ix * 374761393 + iy * 668265263 + salt * 2246822519) | 0
  h = (h ^ (h >>> 13)) * 1274126177
  h = h ^ (h >>> 16)
  return (h >>> 0) / 4294967296
}

/** Builds the baked skybox's equirect canvas. Reuses the exact dir<->(row,
 * col) convention makeCloudTexture (below) already ships with, so the band
 * lines up with bandBasis(seed) the same way the point-based milky-way band
 * and nebulae do. */
function buildSkyboxTexture(seed) {
  const t0 = performance.now()
  const width = SKYBOX_TEX_WIDTH
  const height = SKYBOX_TEX_HEIGHT
  const { normal } = bandBasis(seed)
  const densityNoise = makeNoise3D(seed + ':skybox-density')
  const dustNoise = makeNoise3D(seed + ':skybox-dust')
  const rng = rngFromString(seed + ':skybox-bright')

  const coreColor = new THREE.Color('#dce6ff') // blue-white galactic core
  const rimColor = new THREE.Color('#ffcf9e') // warm amber rim
  const voidColor = new THREE.Color('#03040a') // near-black space — never pure black, avoids crushed banding
  const bandTint = new THREE.Color()
  const px = new THREE.Color()
  const dir = new THREE.Vector3()

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  const img = ctx.createImageData(width, height)
  const data = img.data

  for (let y = 0; y < height; y++) {
    const vCanvas = y / (height - 1)
    const lat = (0.5 - vCanvas) * Math.PI
    const cosLat = Math.cos(lat)
    const sinLat = Math.sin(lat)
    const row = y * width
    for (let x = 0; x < width; x++) {
      const uCanvas = x / (width - 1)
      const lon = (uCanvas - 0.5) * TWO_PI
      dir.set(cosLat * Math.cos(lon), sinLat, cosLat * Math.sin(lon))

      // Angular distance from the milky-way great circle (SAME basis as the
      // point-based band/nebulae) via the plane's signed distance -> phi.
      const phi = Math.asin(clamp(dir.dot(normal), -1, 1))
      const bandFalloff = Math.exp(-(phi * phi) / (2 * 0.22 * 0.22))

      // Layered star density: a mid-freq fbm clumps the band into drifts
      // instead of a uniform gaussian sausage.
      const clump = fbm(densityNoise, dir.x * 2.6, dir.y * 2.6, dir.z * 2.6, 4, 2.1, 0.5) * 0.5 + 0.5
      let density = bandFalloff * lerp(0.55, 1.15, clump)

      // Dust lanes: a SECOND, independent mid-freq fbm that CARVES dark
      // filaments out of the band (negative space) instead of adding
      // brightness — real Milky Way photos read this way: dark lanes
      // threading a bright core, never erased to zero.
      const dustN = fbm(dustNoise, dir.x * 4.2 + 11.3, dir.y * 4.2 - 5.1, dir.z * 4.2 + 2.7, 4, 2.15, 0.5)
      const dustMask = 1 - smoothstep(0.08, 0.42, dustN) * 0.82
      density = clamp(density * dustMask, 0, 1)

      // Color grade: blue-white toward the dense core, warm amber toward
      // the rim/off-band sky, per real galactic-core photography.
      bandTint.copy(coreColor).lerp(rimColor, 1 - smoothstep(0.3, 1, density))
      px.copy(voidColor).lerp(bandTint, smoothstep(0, 0.85, density))

      // Fine pointlike star sprinkle — cheap hash, no extra noise calls.
      // Denser/brighter inside the band than off it.
      const starChance = lerp(0.0006, 0.006, density)
      if (hashTexel(x, y, 1) > 1 - starChance) {
        const b = lerp(0.5, 1.0, hashTexel(x, y, 2))
        px.r = Math.min(1, px.r + b)
        px.g = Math.min(1, px.g + b * 0.98)
        px.b = Math.min(1, px.b + b * 0.94)
      }

      const idx = (row + x) * 4
      data[idx] = Math.round(clamp(px.r, 0, 1) * 255)
      data[idx + 1] = Math.round(clamp(px.g, 0, 1) * 255)
      data[idx + 2] = Math.round(clamp(px.b, 0, 1) * 255)
      data[idx + 3] = 255
    }
  }
  ctx.putImageData(img, 0, 0)

  // A handful of soft, larger glow blobs for the brightest few stars, baked
  // straight into the canvas via the 2D API (same radial-gradient technique
  // makeRadialCanvasTexture uses for sprites elsewhere in this file — here
  // it's painted directly instead of built as a separate texture/sprite).
  // CanvasTexture data is byte-clamped to [0,1] — this can never itself
  // cross the bloom threshold (ART.md 2.5), so no extra dimming is needed
  // to stay inside the bloom budget.
  const glowCount = 5 + Math.floor(rng() * 4) // 5-8
  for (let i = 0; i < glowCount; i++) {
    const gx = Math.floor(rng() * width)
    const gy = Math.floor(rng() * height)
    const r = lerp(10, 22, rng())
    const warm = rng() < 0.4
    const rgb = warm ? '255,224,180' : '255,255,255'
    // Draw at gx and, near the u=0/1 seam, also at the wrapped-around copy
    // so a glow straddling the equirect edge doesn't clip.
    const offsets = [0]
    if (gx - r < 0) offsets.push(width)
    if (gx + r > width) offsets.push(-width)
    for (const off of offsets) {
      const g = ctx.createRadialGradient(gx + off, gy, 0, gx + off, gy, r)
      g.addColorStop(0, `rgba(${rgb},0.9)`)
      g.addColorStop(0.35, `rgba(${rgb},0.35)`)
      g.addColorStop(1, `rgba(${rgb},0)`)
      ctx.fillStyle = g
      ctx.fillRect(gx + off - r, gy - r, r * 2, r * 2)
    }
  }

  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.ClampToEdgeWrapping

  const bakeMs = performance.now() - t0
  if (bakeMs > SKYBOX_BAKE_BUDGET_MS) {
    console.warn(
      '[planet] sky: baked skybox generation took ' +
        bakeMs.toFixed(0) +
        'ms, over the ' +
        SKYBOX_BAKE_BUDGET_MS +
        'ms budget',
    )
  }
  return { texture: tex, bakeMs }
}

function getSkyboxTexture(seed) {
  if (_skyboxCache && _skyboxCache.seed === seed) return _skyboxCache
  const built = buildSkyboxTexture(seed)
  _skyboxCache = { seed, texture: built.texture, bakeMs: built.bakeMs }
  return _skyboxCache
}

function createSkybox(seed) {
  const cached = getSkyboxTexture(seed)
  const geo = new THREE.SphereGeometry(SKYBOX_RADIUS, 48, 32)
  const mat = new THREE.MeshBasicMaterial({
    map: cached.texture,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
  })
  const mesh = new THREE.Mesh(geo, mat)
  mesh.renderOrder = -1000 // always drawn first — a true backdrop, independent of radius vs. the point-star shells
  mesh.matrixAutoUpdate = false // static: never moves after creation
  mesh.updateMatrix()
  return { mesh, bakeMs: cached.bakeMs }
}

// ------------------------------------------------------------------ stars --

function createStarfield(seed) {
  const group = new THREE.Group()
  group.add(createCoreStars(seed))
  group.add(createMilkyWayBand(seed))
  group.add(createBrightStars(seed))
  return group
}

function createCoreStars(seed) {
  const rng = rngFromString(seed + ':stars-core')
  const count = 9000
  const radius = 90
  const positions = new Float32Array(count * 3)
  const colors = new Float32Array(count * 3)
  const p = new THREE.Vector3()
  const warm = new THREE.Color('#ffd9a0')
  const cool = new THREE.Color('#aac4ff')
  const c = new THREE.Color()
  for (let i = 0; i < count; i++) {
    randomOnUnitSphere(rng, p).multiplyScalar(radius)
    positions[i * 3] = p.x
    positions[i * 3 + 1] = p.y
    positions[i * 3 + 2] = p.z

    const roll = rng()
    if (roll < 0.075) c.copy(warm)
    else if (roll < 0.15) c.copy(cool)
    else c.set('#ffffff')
    c.multiplyScalar(lerp(0.35, 1.05, rng()))
    colors[i * 3] = c.r
    colors[i * 3 + 1] = c.g
    colors[i * 3 + 2] = c.b
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  const mat = new THREE.PointsMaterial({
    size: 1.6,
    sizeAttenuation: false,
    vertexColors: true,
    transparent: true,
    depthWrite: false,
  })
  return new THREE.Points(geo, mat)
}

function createMilkyWayBand(seed) {
  const rng = rngFromString(seed + ':stars-band')
  const { normal, u, v } = bandBasis(seed)
  const count = 4500
  const radius = 89
  const sigma = 0.13
  const positions = new Float32Array(count * 3)
  const colors = new Float32Array(count * 3)
  const dir = new THREE.Vector3()
  const tint = new THREE.Color('#dce6ff')
  const c = new THREE.Color()
  for (let i = 0; i < count; i++) {
    const theta = rng() * Math.PI * 2
    const phi = gaussian(rng, sigma)
    pointNearGreatCircle(normal, u, v, theta, phi, dir).multiplyScalar(radius)
    positions[i * 3] = dir.x
    positions[i * 3 + 1] = dir.y
    positions[i * 3 + 2] = dir.z

    c.copy(tint).multiplyScalar(lerp(0.12, 0.45, rng()))
    colors[i * 3] = c.r
    colors[i * 3 + 1] = c.g
    colors[i * 3 + 2] = c.b
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  const mat = new THREE.PointsMaterial({
    size: 1.3,
    sizeAttenuation: false,
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    opacity: 0.85,
  })
  return new THREE.Points(geo, mat)
}

function createBrightStars(seed) {
  const rng = rngFromString(seed + ':stars-bright')
  const count = 40
  const radius = 88
  const positions = new Float32Array(count * 3)
  const colors = new Float32Array(count * 3)
  const p = new THREE.Vector3()
  const warm = new THREE.Color('#ffd9a0')
  const cool = new THREE.Color('#aac4ff')
  const c = new THREE.Color()
  for (let i = 0; i < count; i++) {
    randomOnUnitSphere(rng, p).multiplyScalar(radius)
    positions[i * 3] = p.x
    positions[i * 3 + 1] = p.y
    positions[i * 3 + 2] = p.z

    const roll = rng()
    if (roll < 0.2) c.copy(warm)
    else if (roll < 0.4) c.copy(cool)
    else c.set('#ffffff')
    // A bloom post-pass may run on top of this scene later — leave a little
    // headroom above 1.0 so the brightest stars have something to bloom.
    c.multiplyScalar(lerp(1.05, 1.35, rng()))
    colors[i * 3] = c.r
    colors[i * 3 + 1] = c.g
    colors[i * 3 + 2] = c.b
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  const map = makeRadialCanvasTexture(
    [
      [0, 'rgba(255,255,255,1)'],
      [0.25, 'rgba(255,255,255,0.85)'],
      [0.6, 'rgba(255,255,255,0.25)'],
      [1, 'rgba(255,255,255,0)'],
    ],
    64,
  )
  // Node-material port of the classic PointsMaterial recipe above. The old
  // fixed-function pipeline sampled `map` at the WebGL point-sprite's own
  // gl_PointCoord (see three.js's map_particle_fragment chunk: `vec2 uv = (
  // uvTransform * vec3( gl_PointCoord.x, 1.0 - gl_PointCoord.y, 1 ) ).xy`),
  // never a geometry UV attribute -- this Points geometry only carries
  // position/color. NodeMaterial's default `map` wiring instead defaults to
  // the generic uv() attribute node, which doesn't exist here and fires
  // "THREE.AttributeNode: Vertex attribute uv not found on geometry." pointUV
  // is TSL's dedicated accessor for that same gl_PointCoord-derived
  // coordinate (WebGL-backend only, which this renderer always uses --
  // forceWebGL: true) -- the direct replacement for the old per-sprite uv.
  const mat = new THREE.PointsNodeMaterial({
    size: 3,
    sizeAttenuation: false,
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  })
  const mapSample = texture(map, pointUV)
  mat.colorNode = vertexColor().mul(mapSample.rgb)
  mat.opacityNode = mapSample.a
  return new THREE.Points(geo, mat)
}

// --------------------------------------------------------------- nebulae --

/** A few large, very faint tinted patches sitting in/near the milky-way
 * band — just enough dust to make the sky feel less empty. */
function createNebulae(seed) {
  const group = new THREE.Group()
  const rng = rngFromString(seed + ':nebulae')
  const { normal, u, v } = bandBasis(seed)
  const palette = ['#7d5fc0', '#4fb0a0', '#8a6fd0']
  const count = 2 + Math.floor(rng() * 2) // 2 or 3
  const dir = new THREE.Vector3()

  for (let i = 0; i < count; i++) {
    const theta = rng() * Math.PI * 2
    const phi = gaussian(rng, 0.35)
    pointNearGreatCircle(normal, u, v, theta, phi, dir)
    const dist = lerp(55, 82, rng())

    const hex = palette[Math.floor(rng() * palette.length)]
    const col = new THREE.Color(hex)
    const rgb = `${Math.round(col.r * 255)},${Math.round(col.g * 255)},${Math.round(col.b * 255)}`
    const map = makeRadialCanvasTexture(
      [
        [0, `rgba(${rgb},0.9)`],
        [0.4, `rgba(${rgb},0.4)`],
        [1, `rgba(${rgb},0)`],
      ],
      128,
    )
    const mat = new THREE.SpriteMaterial({
      map,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
      opacity: lerp(0.05, 0.1, rng()),
    })
    const sprite = new THREE.Sprite(mat)
    sprite.position.copy(dir).multiplyScalar(dist)
    sprite.scale.setScalar(lerp(38, 62, rng()))
    group.add(sprite)
  }
  return group
}

// ------------------------------------------------------------ atmosphere --

function createAtmosphere() {
  const geo = new THREE.SphereGeometry(1.11, 64, 48)
  // View-angle fresnel rim glow, ported from the original raw GLSL shader to a
  // TSL node material (raw string-shader materials error under WebGPURenderer).
  // glowColor/power/intensity were uniforms but are never written in update();
  // kept as uniform() handles to mirror the original's uniform surface. The
  // rim uses world-space view direction and normal — abs() makes the BackSide
  // normal's sign irrelevant, exactly as the GLSL abs(dot(...)) did.
  const glowColor = uniform(new THREE.Color('#7db8ff'))
  const power = uniform(3.2)
  const intensity = uniform(0.75) // faint overall — do not overdrive this
  const viewDir = cameraPosition.sub(positionWorld).normalize()
  const rim = viewDir.dot(normalWorld.normalize()).abs().oneMinus().clamp(0, 1).pow(power)
  const mat = new THREE.MeshBasicNodeMaterial({
    side: THREE.BackSide,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  })
  mat.colorNode = glowColor
  mat.opacityNode = rim.mul(intensity)
  return new THREE.Mesh(geo, mat)
}

function createSunSprite() {
  const map = makeRadialCanvasTexture(
    [
      [0, 'rgba(255,255,255,1)'],
      [0.18, 'rgba(255,244,214,0.95)'],
      [0.45, 'rgba(255,214,140,0.35)'],
      [1, 'rgba(255,200,120,0)'],
    ],
    128,
  )
  const mat = new THREE.SpriteMaterial({
    map,
    color: new THREE.Color(1.3, 1.22, 1.05), // slight >1.0 headroom for bloom
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  })
  const sprite = new THREE.Sprite(mat)
  sprite.scale.set(7, 7, 1)
  sprite.position.copy(SUN_DIR).multiplyScalar(80)
  return sprite
}

/** The "ring of light" flourish during a solar eclipse: a soft, faintly
 * ring-shaped additive glow (dim core, bright band around ~0.35-0.55 of the
 * sprite radius) that sits behind the sun sprite and is invisible
 * (opacity 0) outside of an eclipse — see update()'s eclipseFactor. */
function createCoronaSprite() {
  const map = makeRadialCanvasTexture(
    [
      [0, 'rgba(255,214,160,0.12)'],
      [0.32, 'rgba(255,214,160,0.85)'],
      [0.55, 'rgba(255,190,120,0.45)'],
      [1, 'rgba(255,180,100,0)'],
    ],
    128,
  )
  const mat = new THREE.SpriteMaterial({
    map,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    opacity: 0,
  })
  const sprite = new THREE.Sprite(mat)
  sprite.scale.set(CORONA_BASE_SCALE, CORONA_BASE_SCALE, 1)
  sprite.renderOrder = -1 // draws before (visually "behind") the sun sprite
  return sprite
}

// ----------------------------------------------------------------- clouds --

/** Two-stage Quilez-style domain warp for filaments/swirls, evaluated purely
 * as a function of the sphere DIRECTION (so the equirect seam at +/-180
 * stays invisible):
 *   q = fbm(dir*s1), r = fbm(dir*s1 + q*k), final = fbm(dir*s2 + r*k2)
 * Before any of that, the direction's latitude (y) component is stretched
 * relative to x/z so structures elongate along parallels (trade-wind
 * streaks). The final value is then biased by a couple of seeded cosine
 * bands over latitude so density favors the equatorial belt and the
 * mid-latitude storm tracks over the subtropical gaps between them. */
function warpedCloudField(noise3, dir, lat, cfg) {
  const sx = dir.x
  const sy = dir.y * cfg.latStretch
  const sz = dir.z

  const q = fbm(
    noise3,
    sx * cfg.warpScale + 2.1,
    sy * cfg.warpScale - 6.4,
    sz * cfg.warpScale + 4.9,
    cfg.warpOctaves,
    2.05,
    0.5,
  )
  const r = fbm(
    noise3,
    sx * cfg.warpScale + q * cfg.warpStrength - 3.7,
    sy * cfg.warpScale + q * cfg.warpStrength + 8.1,
    sz * cfg.warpScale + q * cfg.warpStrength - 1.3,
    cfg.warpOctaves,
    2.05,
    0.5,
  )
  const n = fbm(
    noise3,
    sx * cfg.scale + r * cfg.warpStrength2,
    sy * cfg.scale + r * cfg.warpStrength2,
    sz * cfg.scale + r * cfg.warpStrength2,
    cfg.octaves,
    2.05,
    0.5,
  )

  // Equatorial belt + mirrored mid-latitude storm tracks with subtropical
  // gaps in between: a broad equator-to-pole taper plus a 3x-frequency
  // cosine that carves the subtropical dip / storm-track bump, seeded phase
  // so the bands sit differently from planet to planet.
  const latN = lat / (Math.PI / 2)
  const band =
    0.5 +
    cfg.bandAmp1 * Math.cos(latN * Math.PI) +
    cfg.bandAmp2 * Math.cos(latN * Math.PI * 3 + cfg.bandPhase)

  return clamp(n * 0.5 + 0.5 + (band - cfg.bandBias) * cfg.bandStrength, 0, 1)
}

/** Mean soft-thresholded coverage of an already-sampled field — cheap (no
 * noise calls), so calibrateThreshold can afford several passes over it. */
function meanCoverage(field, threshold, edge) {
  let sum = 0
  for (let i = 0; i < field.length; i++) sum += smoothstep(threshold - edge, threshold + edge, field[i])
  return sum / field.length
}

/** Bisects on the already-sampled field for the threshold whose mean
 * coverage lands on `target`. Coverage is monotonically non-increasing in
 * threshold, so plain bisection converges in a handful of steps; fully
 * deterministic and silent, and cheap since it never re-touches the noise
 * functions — those were already baked into `field` once. */
function calibrateThreshold(field, edge, target) {
  let lo = 0.02
  let hi = 0.98
  let mid = 0.5
  for (let i = 0; i < 6; i++) {
    mid = (lo + hi) / 2
    if (meanCoverage(field, mid, edge) > target) lo = mid
    else hi = mid
  }
  return mid
}

/** Builds one cloud layer's alpha texture on a 2048x1024 equirect canvas.
 * Samples the warped/banded field (see warpedCloudField) once per texel at
 * the sphere DIRECTION, auto-calibrates the coverage threshold against
 * `cfg.targetCoverage` (see calibrateThreshold), then rasterizes. Returns
 * the texture PLUS the same coverage values already computed for it (0..1,
 * row-major, same width/height) — M-WX weather reads this CPU-side via
 * sampleCloudCover() below instead of re-deriving coverage or doing a GPU
 * readback; `field` is reused in place for this (each entry overwritten
 * with its own post-threshold alpha right after it's read, so this adds no
 * extra allocation over the pre-M-WX version of this function). */
function makeCloudTexture(noise3, cfg) {
  const { width, height, edge, targetCoverage } = cfg
  const dir = new THREE.Vector3()
  const field = new Float32Array(width * height)

  for (let y = 0; y < height; y++) {
    const v = y / (height - 1)
    const lat = (0.5 - v) * Math.PI
    const cosLat = Math.cos(lat)
    const sinLat = Math.sin(lat)
    const rowOffset = y * width
    for (let x = 0; x < width; x++) {
      const u = x / (width - 1)
      const lon = (u - 0.5) * Math.PI * 2
      dir.set(cosLat * Math.cos(lon), sinLat, cosLat * Math.sin(lon))
      field[rowOffset + x] = warpedCloudField(noise3, dir, lat, cfg)
    }
  }

  const threshold = calibrateThreshold(field, edge, targetCoverage)

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  const img = ctx.createImageData(width, height)
  const data = img.data
  for (let i = 0; i < field.length; i++) {
    const a = smoothstep(threshold - edge, threshold + edge, field[i])
    const idx = i * 4
    // alphaMap samples the GREEN channel — write coverage into RGB and keep
    // alpha opaque, otherwise canvas premultiplication turns the texture
    // into a full-planet milky veil.
    const g = Math.round(clamp(a, 0, 1) * 255)
    data[idx] = g
    data[idx + 1] = g
    data[idx + 2] = g
    data[idx + 3] = 255
    field[i] = a // reuse: field[i] is only read once above, safe to overwrite with the final 0..1 coverage
  }
  ctx.putImageData(img, 0, 0)

  const tex = new THREE.CanvasTexture(canvas)
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.ClampToEdgeWrapping
  return { tex, coverage: field, width, height }
}

// Shared by both cloud shells: the hurricane clears a moat in the ambient
// deck around itself (subsidence ring), driven every frame from main.js.
const stormClearUniforms = {
  uStormDir: uniform(new THREE.Vector3(1, 0, 0)),
  uStormOn: uniform(0),
}

// M-SKY cloud-shadows-on-terrain contract (architect-pinned): planet.js's
// terrain-splat node graph imports getCloudShadowUniforms() (lazily/guarded —
// see planet.js) and samples the LOWER cloud deck's own alpha texture along
// each fragment's world direction to darken the ground beneath it. The
// returned object keeps its keys but the values are now TSL nodes (M3 port):
// uCloudTex is a texture() node (its .value is the alphaMap), uCloudMat and
// uCloudShadowOn are uniform() nodes (Matrix3 / float). planet.js's own TSL
// port consumes them as nodes; their .value is written each frame in update().
//   - uCloudTex: the lower shell's own alphaMap (same texture that's
//     actually rendered overhead — coverage/shape never drifts from what's
//     visible in the sky).
//   - uCloudMat: WORLD-direction -> LOWER-SHELL-LOCAL-direction rotation
//     (Matrix3), rebuilt fresh every frame in update() from the shell's live
//     quaternion — NEVER from .matrixWorld, which three.js only refreshes
//     during the renderer's own matrix pass, AFTER this module's update()
//     already ran for the frame (one frame of lag). A 3x3/4x4 matrix alone
//     cannot express the FULL world-dir -> UV mapping (equirect projection
//     is nonlinear — acos/atan2), so this carries only the linear (rotation)
//     part; the consumer finishes the nonlinear step itself, with THIS EXACT
//     formula (matches localDirToUV above / this file's own SphereGeometry
//     convention): given localDir = normalize(uCloudMat * worldDir),
//       theta = acos(localDir.y)
//       phi   = atan(localDir.z, -localDir.x)      // wrap negative phi by +2*PI
//       uv    = vec2(phi / TWO_PI, 1.0 - theta / PI)
//   - uCloudShadowOn: the SAME 1.35R-2.4R camera-distance fade the cloud
//     deck's own opacity uses (the raw fade, not the deck's floored
//     opacity — see update()'s cloud-fade block) so ground shadows fade
//     fully to 0 at ground level instead of lingering under a barely-visible
//     wisp.
// Module-level (like stormClearUniforms above), not per-createSky-instance:
// this app only ever builds one sky, and planet.js imports the getter
// directly rather than reaching through the createSky() instance.
const cloudShadowUniforms = {
  uCloudTex: texture(null),
  uCloudMat: uniform(new THREE.Matrix3()),
  uCloudShadowOn: uniform(0),
}

export function getCloudShadowUniforms() {
  return cloudShadowUniforms
}

/** Applies BOTH cloud-shell shader extensions as TSL node composition on the
 * shell's MeshStandardNodeMaterial (ported from the old single string-injection
 * hook, which WebGPURenderer ignores): the storm-moat clearing plus M-SKY 2.5D
 * sun shading. Returns this MATERIAL's own {uSunUV} uniform() handle — needed
 * per-material, not shared, since the two shells rotate on independent
 * axes/rates and so have different sun directions in their own local UV space
 * at any given moment (see update()).
 *
 * Node mapping of the old GLSL injections:
 *  - vCloudWorld (world position varying)  -> positionWorld
 *  - vAlphaMapUv (alphaMap UV)             -> uv() (alphaMap has no transform)
 *  - texture2D(alphaMap, uv).g             -> texture(alphaMap, uv).g
 *  - diffuseColor.a *= ...                 -> opacityNode
 *  - diffuseColor.rgb *= ...               -> colorNode (albedo, then lit)
 * The green-channel read (project gotcha) is reproduced explicitly with .g;
 * the built-in alphaMap alpha path (materialOpacity) is bypassed because
 * opacityNode is set, so coverage is applied exactly once. */
function applyStormClearing(mat) {
  const uSunUV = uniform(new THREE.Vector2(0, 0))
  const alphaTex = mat.alphaMap
  const vUv = uv()
  const ownDensity = texture(alphaTex, vUv).g // alphaMap coverage lives in the GREEN channel

  // Storm-moat clearing: the hurricane clears a moat in the ambient deck
  // around itself. Full clear inside ~0.3 rad of the eye, feathering out to
  // ~0.55 rad. cosAng uses the fragment's world position.
  const cosAng = positionWorld.normalize().dot(stormClearUniforms.uStormDir)
  const clearT = tslSmoothstep(0.85, 0.955, cosAng)
  const stormFactor = clearT.mul(stormClearUniforms.uStormOn).oneMinus()

  // M-SKY 2.5D shading: a second alphaMap sample offset TOWARD the sun (in
  // this shell's own UV space, uSunUV — see update()) fakes a bit of cloud
  // thickness without a real raymarch. High density both here AND toward the
  // sun -> this fragment sits on the shadowed base of a thicker mass; low
  // density toward the sun but cloud here -> a sun-facing rim highlight.
  const du0 = uSunUV.x.sub(vUv.x)
  const du = du0.sub(du0.add(0.5).floor()) // shortest wrap around the circular U seam
  const toSun = vec2(du, uSunUV.y.sub(vUv.y))
  const toSunLen = toSun.length()
  const sunDirUv = select(toSunLen.greaterThan(1e-5), toSun.div(toSunLen), vec2(1, 0))
  const sunSample = texture(alphaTex, vUv.add(sunDirUv.mul(0.018))).g
  const shadowT = tslSmoothstep(0.18, 0.7, sunSample).mul(ownDensity)
  const edgeT = tslSmoothstep(0.05, 0.4, sunSample).oneMinus().mul(ownDensity)
  const shadeTint = vec3(0.7255, 0.7686, 0.8314) // #b9c4d4

  // Base albedo is white (material color); tint toward shade under self-shadow,
  // lift slightly on sun-facing rims, then clamp white-dominant so clouds never
  // glow (ART.md 2.5/8). Lighting is applied on top by the standard material.
  mat.colorNode = mix(vec3(1, 1, 1), shadeTint, shadowT.mul(0.6))
    .mul(edgeT.mul(0.08).add(1))
    .min(vec3(1, 1, 1))

  // Final alpha = live deck opacity (materialReference tracks material.opacity,
  // faded per frame in update()) * green-channel coverage * storm moat.
  mat.opacityNode = materialReference('opacity', 'float', mat).mul(ownDensity).mul(stormFactor)

  return { uSunUV }
}

function createClouds(seed) {
  const width = 2048
  const height = 1024

  const lowerNoise = makeNoise3D(seed + ':clouds-lower')
  const lowerBake = makeCloudTexture(lowerNoise, {
    width,
    height,
    // Broken cumulus fields + frontal filaments: smaller cells, sharper
    // edges, a moderate warp for cluster-boundary curl.
    scale: 3.6,
    warpScale: 1.3,
    warpStrength: 0.6,
    warpStrength2: 0.22,
    warpOctaves: 2,
    octaves: 4,
    latStretch: 2.6,
    bandAmp1: 0.15,
    bandAmp2: 0.35,
    bandBias: 0.55,
    bandStrength: 0.28,
    bandPhase: rngFromString(seed + ':clouds-bands-lower')() * Math.PI * 2,
    edge: 0.07,
    // M-SKY coverage cut: 0.27 -> ~0.20 (ART.md band 15-25% total with the
    // upper deck's 0.09 below).
    targetCoverage: 0.2,
  })
  const lowerTex = lowerBake.tex
  // Publish the lower deck's alpha texture to the cloud-shadow contract now,
  // before any warm-up render, so planet.js's node graph never binds a null
  // sampler when it consumes getCloudShadowUniforms().uCloudTex. update()
  // re-points .value each frame per the contract documented above.
  cloudShadowUniforms.uCloudTex.value = lowerTex
  const lowerMesh = new THREE.Mesh(
    new THREE.SphereGeometry(1.075, 64, 32),
    new THREE.MeshStandardNodeMaterial({
      color: 0xffffff,
      alphaMap: lowerTex,
      transparent: true,
      depthWrite: false,
      roughness: 1,
      metalness: 0,
      opacity: 0.88,
    }),
  )

  const upperNoise = makeNoise3D(seed + ':clouds-upper')
  const upperBake = makeCloudTexture(upperNoise, {
    width,
    height,
    // Thin elongated cirrus streaks: strong longitudinal stretch, very soft
    // threshold, low density, and only a whisper of warp so the streaks
    // stay long instead of curling into cumulus-like clumps.
    scale: 4.0,
    warpScale: 1.3,
    warpStrength: 0.18,
    warpStrength2: 0.08,
    warpOctaves: 2,
    octaves: 3,
    latStretch: 4.0,
    bandAmp1: 0.15,
    bandAmp2: 0.35,
    bandBias: 0.55,
    bandStrength: 0.22,
    bandPhase: rngFromString(seed + ':clouds-bands-upper')() * Math.PI * 2,
    edge: 0.16,
    // M-SKY coverage cut: 0.13 -> ~0.09 (ART.md band 15-25% total).
    targetCoverage: 0.09,
  })
  const upperTex = upperBake.tex
  const upperMesh = new THREE.Mesh(
    new THREE.SphereGeometry(1.09, 64, 32),
    new THREE.MeshStandardNodeMaterial({
      color: 0xffffff,
      alphaMap: upperTex,
      transparent: true,
      depthWrite: false,
      roughness: 1,
      metalness: 0,
      opacity: 0.5,
    }),
  )

  const lowerSunUniforms = applyStormClearing(lowerMesh.material)
  const upperSunUniforms = applyStormClearing(upperMesh.material)

  const rng = rngFromString(seed + ':clouds-axis')
  const tiltedAxis = () => new THREE.Vector3(rng() - 0.5, 1.6, rng() - 0.5).normalize()
  const lowerAxis = tiltedAxis()
  const upperAxis = tiltedAxis()
  lowerMesh.rotation.y = rng() * Math.PI * 2
  upperMesh.rotation.y = rng() * Math.PI * 2

  return {
    lowerMesh,
    upperMesh,
    lowerAxis,
    upperAxis,
    lowerRate: 0.006,
    upperRate: -0.0035, // retrograde
    lowerSunUniforms,
    upperSunUniforms,
    // M-WX weather hook: the lower deck's own baked coverage field (see
    // makeCloudTexture) — precipitation gates off THIS deck only (broken
    // cumulus/frontal filaments), never the upper cirrus deck, which
    // physically doesn't rain. Read CPU-side by sampleCloudCover() below.
    lowerCoverage: lowerBake.coverage,
    lowerCoverageWidth: lowerBake.width,
    lowerCoverageHeight: lowerBake.height,
  }
}

// ------------------------------------------------------------------ lights --

function createLights() {
  const sun = new THREE.DirectionalLight(SUN_BASE_COLOR, SUN_BASE_INTENSITY)
  sun.position.copy(SUN_DIR).multiplyScalar(10)
  const target = new THREE.Object3D() // stays at the origin: the planet
  sun.target = target

  const hemi = new THREE.HemisphereLight(
    new THREE.Color('#9db8ff'),
    new THREE.Color('#3a3128'),
    HEMI_BASE_INTENSITY,
  )

  // Cool "moonlight" fill from the anti-solar direction so the night side
  // reads silvery-blue instead of black. Kept in opposition in update().
  const moonFill = new THREE.DirectionalLight(new THREE.Color('#8fa8d8'), 0.5)
  moonFill.position.copy(SUN_DIR).multiplyScalar(-10)
  moonFill.target = target

  return { sun, hemi, moonFill, target }
}

// ------------------------------------------------------------------ moons --

/** Per-vertex color on a small sphere: seeded 3D fbm sampled at the vertex
 * direction, so it reads as either pale crater mottling or a faint
 * lavender/teal tint depending on `kind`. */
function buildMoonMesh(seed, radius, kind) {
  const noise3 = makeNoise3D(`${seed}:moon-${kind}`)
  const geo = new THREE.SphereGeometry(radius, 32, 24)
  const posAttr = geo.attributes.position
  const count = posAttr.count
  const colors = new Float32Array(count * 3)
  const p = new THREE.Vector3()
  const col = new THREE.Color()
  const lav = new THREE.Color('#b9a8d9')
  const teal = new THREE.Color('#8fd0c9')

  for (let i = 0; i < count; i++) {
    p.fromBufferAttribute(posAttr, i).normalize()
    const n = fbm(noise3, p.x * 3.2, p.y * 3.2, p.z * 3.2, 4, 2.1, 0.5)

    if (kind === 'crater') {
      const dark = smoothstep(0.05, 0.55, n * 0.5 + 0.5)
      const grey = lerp(0.78, 0.4, dark)
      col.setRGB(grey, grey, grey * 0.98)
    } else {
      const t = smoothstep(-0.4, 0.4, n)
      const tint = lav.clone().lerp(teal, t)
      const base = 0.72
      col.setRGB(base, base, base).lerp(tint, 0.4)
    }

    colors[i * 3] = col.r
    colors[i * 3 + 1] = col.g
    colors[i * 3 + 2] = col.b
  }

  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 })
  return new THREE.Mesh(geo, mat)
}

// The sun's declination (angle of its direction above/below the planet's
// equatorial XZ plane) is fixed forever: SUN_DIR only orbits the Y axis in
// update(), and Y-axis rotation preserves the y-component of a vector, so
// asin(SUN_DIR.y) never changes. Used by createMoons() below.
const SUN_DECLINATION = Math.asin(SUN_DIR.y) // ~= 0.3228 rad (~18.49 deg)

/** Small moons on inclined, seeded circular orbits. Each orbit is a pivot
 * Object3D tilted once at creation; advancing it each frame with rotateY
 * spins the (fixed) tilted axis, sweeping the moon around the planet.
 *
 * Eclipse-guarantee geometry (moon 0, 'crater'): pivot.quaternion tilts the
 * orbit's plane by `tiltAngle` about a horizontal axis, which is the
 * standard orbital-inclination case — the moon's own declination oscillates
 * across exactly [-tiltAngle, +tiltAngle] once per orbit. An eclipse needs
 * the moon's declination to reach the sun's fixed SUN_DECLINATION at the
 * same moment its azimuth (orbital phase) matches the sun's, so a moon whose
 * max declination (tiltAngle) never reaches SUN_DECLINATION can NEVER
 * eclipse, at any time, for that seed — tiltAngle was previously free in
 * lerp(0.15, 0.55) rad (8.6-31.5 deg), a range that dips below
 * SUN_DECLINATION (~18.49 deg) often enough that ~12% of seeds rolled BOTH
 * moons under it (measured via node simulation, real three.js math, dt=1/30:
 * seeds 'x' and 'planet-9000' in a 20-seed sample never eclipse, in 3
 * sim-hours or any amount of sim-time — median was only 2 eclipses/3h across
 * 20 seeds incl. default 'aetherion-1', which itself got 7 with max alignment
 * 0.999999).
 * Fix: clamp moon 0's tiltAngle to [SUN_DECLINATION + 0.01, SUN_DECLINATION +
 * 0.08] rad — always comfortably above SUN_DECLINATION, so its declination
 * band always straddles the sun's twice per orbit, for every seed, forever.
 * A margin sweep (50/80/200-seed pools) picked this 0.01-0.08 rad band as the
 * strongest frequency (wider or tighter bands, or ones abutting
 * SUN_DECLINATION, tested worse) while keeping a real ~4.6 deg seeded spread
 * rather than one fixed tilt. Measured after the fix (same 20-seed sample,
 * dt=1/30, 3 sim-hours): median 6 eclipses/3h, 0/20 seeds stuck at zero, and
 * 52/114 (46%) of eclipses reach the FULL 0.9997 threshold (coronas actually
 * bloom, not just grazing onsets) — comfortably clears the ~1-per-45-sim-min
 * target. Moon 1 ('tinted') is untouched — stays fully free for variety. */
function createMoons(seed) {
  const specs = [
    { name: 'crater', distance: 2.6, kind: 'crater' },
    { name: 'tinted', distance: 3.8, kind: 'tinted' },
  ]

  return specs.map((spec, index) => {
    const rng = rngFromString(`${seed}:moon-${spec.name}`)
    const radius = lerp(0.05, 0.09, rng())
    const distance = spec.distance * lerp(0.95, 1.05, rng())
    const rate = lerp(0.01, 0.02, rng())

    const pivot = new THREE.Object3D()
    const tiltAxis = new THREE.Vector3(rng() - 0.5, 0, rng() - 0.5).normalize()
    const tiltAngle =
      index === 0 ? lerp(SUN_DECLINATION + 0.01, SUN_DECLINATION + 0.08, rng()) : lerp(0.15, 0.55, rng())
    pivot.quaternion.setFromAxisAngle(tiltAxis, tiltAngle)
    pivot.rotateY(rng() * Math.PI * 2) // random starting phase

    const mesh = buildMoonMesh(seed, radius, spec.kind)
    mesh.position.set(distance, 0, 0)
    pivot.add(mesh)

    // `mesh` (not just `pivot`) is kept so update() can read the moon's true
    // world direction via getWorldPosition — needed for eclipse alignment.
    return { pivot, mesh, rate }
  })
}

// ------------------------------------------------------------------ aurora --

const AURORA_STEPS = 128
const AURORA_SHELL_R0 = 1.12
const AURORA_SHELL_R1 = AURORA_SHELL_R0 + 0.05
const AURORA_BASE_ANG_RADIUS = 0.35 // radians from the pole

// SUMMON-WEATHER (god-controls): triggerAurora() multiplies every curtain's
// alpha by uBoost, ramped from AURORA_BOOST_MAX back down to 1 over
// AURORA_BOOST_DURATION seconds (a bright burst that decays). The night-side
// gate is left intact — this just over-drives the curtains where they already
// show, it doesn't paint aurora onto the day side.
const AURORA_BOOST_DURATION = 20 // seconds
const AURORA_BOOST_MAX = 3.2 // peak alpha multiplier at the start of a burst

// TSL ports of the aurora fragment's GLSL helpers (built once, reused by all
// four curtain graphs). hash1/noise1 are the original 1D value-noise pair;
// auroraSmoothstepSafe reproduces the manual smoothstep that stays defined for
// reversed edges (a > b) — the night-side gate calls it with a=0.1, b=-0.25,
// a case GLSL's (and TSL's) built-in smoothstep leaves undefined.
const auroraHash1 = Fn(([n]) => n.sin().mul(43758.5453123).fract())
const auroraNoise1 = Fn(([x]) => {
  const i = x.floor().toVar()
  const f = x.fract().toVar()
  const u = f.mul(f).mul(float(3).sub(f.mul(2)))
  return mix(auroraHash1(i), auroraHash1(i.add(1)), u)
})
function auroraSmoothstepSafe(a, b, x) {
  const t = x
    .sub(a)
    .div(b - a)
    .clamp(0, 1)
  return t.mul(t).mul(float(3).sub(t.mul(2)))
}

/** One wavy curtain ribbon: a 129x2-vertex parametric strip circling the
 * pole at ~AURORA_BASE_ANG_RADIUS, radius perturbed per-column by a seeded
 * fbm sampled at (cos theta, sin theta) so the wobble closes seamlessly at
 * the theta=0/2pi seam. Shape is baked once here; the shader animates only
 * color flow + night-side visibility (see fragment shader below). */
function buildAuroraCurtain(seed, poleSign, ringIndex, uniforms) {
  const noise3 = makeNoise3D(`${seed}:aurora:${poleSign > 0 ? 'n' : 's'}:${ringIndex}`)
  const angRadius0 = AURORA_BASE_ANG_RADIUS + (ringIndex - 0.5) * 0.07
  const waveFreq = 2.2
  const waveAmp = 0.06

  const cols = AURORA_STEPS + 1
  const positions = new Float32Array(cols * 2 * 3)
  const grads = new Float32Array(cols * 2)
  const alongs = new Float32Array(cols * 2)
  const dir = new THREE.Vector3()

  for (let i = 0; i < cols; i++) {
    const theta = (i / AURORA_STEPS) * Math.PI * 2
    const wob = fbm(
      noise3,
      Math.cos(theta) * waveFreq,
      Math.sin(theta) * waveFreq,
      ringIndex * 4.1 + 2.3,
      3,
      2.15,
      0.5,
    )
    const angRadius = angRadius0 + wob * waveAmp
    const sinA = Math.sin(angRadius)
    const cosA = Math.cos(angRadius)
    dir.set(sinA * Math.cos(theta), cosA * poleSign, sinA * Math.sin(theta))

    for (let row = 0; row < 2; row++) {
      const vi = i * 2 + row
      const shellR = row === 0 ? AURORA_SHELL_R0 : AURORA_SHELL_R1
      positions[vi * 3] = dir.x * shellR
      positions[vi * 3 + 1] = dir.y * shellR
      positions[vi * 3 + 2] = dir.z * shellR
      grads[vi] = row
      alongs[vi] = i / AURORA_STEPS
    }
  }

  const indices = []
  for (let i = 0; i < AURORA_STEPS; i++) {
    const a = i * 2
    const b = i * 2 + 1
    const c = (i + 1) * 2
    const d = (i + 1) * 2 + 1
    indices.push(a, c, b, b, c, d)
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geo.setAttribute('grad', new THREE.BufferAttribute(grads, 1))
  geo.setAttribute('along', new THREE.BufferAttribute(alongs, 1))
  geo.setIndex(indices)

  // Shape is baked above; the node graph animates only color flow + night-side
  // visibility, driven by the shared uniform() handles (uTime, uSunDir). Ported
  // from the original raw GLSL shader (which errors under WebGPURenderer).
  // grad/along are read as per-vertex attributes (auto-varying to the fragment);
  // the old vWorldPos varying (modelMatrix * position) becomes positionWorld.
  const vGrad = attribute('grad', 'float')
  const vAlong = attribute('along', 'float')
  const gradC = vGrad.clamp(0, 1)
  const col = mix(vec3(0.302, 1.0, 0.651), vec3(0.69, 0.486, 1.0), gradC) // #4dffa6 -> #b07cff

  const w1 = auroraNoise1(vAlong.mul(9).add(uniforms.uTime.mul(0.55)))
  const w2 = auroraNoise1(vAlong.mul(3.5).sub(uniforms.uTime.mul(0.22)).add(11.3))
  const waves = w1.mul(0.6).add(w2.mul(0.4))

  // Soft fade at the ribbon's top/bottom edges instead of a hard cut.
  const edgeFade = gradC.mul(Math.PI).sin()
  // Night-side only: fades out approaching the sunlit terminator.
  const nightFade = auroraSmoothstepSafe(0.1, -0.25, positionWorld.normalize().dot(uniforms.uSunDir))

  const alpha = float(0.35)
    .mul(mix(float(0.25), float(1.0), waves))
    .mul(edgeFade)
    .mul(nightFade)
    .mul(uniforms.uBoost) // 1 normally; triggerAurora() ramps this up for a burst

  const mat = new THREE.MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  })
  mat.colorNode = col
  mat.opacityNode = alpha

  return new THREE.Mesh(geo, mat)
}

/** Two wavy curtains per pole (4 total), all driven by one shared
 * {uTime, uSunDir} uniform pair updated once per frame in update(). */
function createAurora(seed) {
  const uniforms = {
    uTime: uniform(0),
    uSunDir: uniform(new THREE.Vector3(1, 0, 0)),
    // Alpha multiplier for the SUMMON-WEATHER aurora burst (see triggerAurora
    // in createSky()); 1 = the normal, untriggered aurora.
    uBoost: uniform(1),
  }
  const group = new THREE.Group()
  for (const poleSign of [1, -1]) {
    for (let ringIndex = 0; ringIndex < 2; ringIndex++) {
      group.add(buildAuroraCurtain(seed, poleSign, ringIndex, uniforms))
    }
  }
  return { group, uniforms }
}

// ------------------------------------------------------------- meteors --

const METEOR_COUNT = 5
const METEOR_RADIUS = 70
const METEOR_FLASH_FRACTION = 0.18 // fraction of the active phase spent drawing on

/** Parks a meteor back in its (long) waiting phase. */
function scheduleMeteorWait(meteor) {
  meteor.active = false
  meteor.timer = 0
  meteor.phaseDuration = lerp(6, 20, meteor.rng())
  meteor.line.material.opacity = 0
}

/** Respawns a meteor "elsewhere": a short chord along a random great circle
 * on the r=METEOR_RADIUS sky sphere, bright head fading additively (via
 * vertex color, not alpha) to a dark tail. Geometry is mutated in place. */
function activateMeteor(meteor) {
  const rng = meteor.rng
  const p = randomOnUnitSphere(rng)
  const raw = randomOnUnitSphere(rng)
  const tangent = raw.addScaledVector(p, -raw.dot(p)).normalize()
  const halfLen = lerp(0.025, 0.05, rng())

  const head = p.clone().addScaledVector(tangent, halfLen).normalize().multiplyScalar(METEOR_RADIUS)
  const tail = p.clone().addScaledVector(tangent, -halfLen).normalize().multiplyScalar(METEOR_RADIUS)

  const posAttr = meteor.line.geometry.attributes.position
  posAttr.setXYZ(0, head.x, head.y, head.z)
  posAttr.setXYZ(1, tail.x, tail.y, tail.z)
  posAttr.needsUpdate = true

  const colAttr = meteor.line.geometry.attributes.color
  const brightness = lerp(1.1, 1.6, rng())
  colAttr.setXYZ(0, brightness, brightness * 0.97, brightness * 0.9)
  colAttr.setXYZ(1, 0, 0, 0)
  colAttr.needsUpdate = true

  meteor.active = true
  meteor.timer = 0
  meteor.phaseDuration = lerp(0.55, 0.85, rng())
}

function createMeteor(seed, index) {
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3))
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(6), 3))
  const mat = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    opacity: 0,
  })
  const line = new THREE.Line(geo, mat)
  line.frustumCulled = false // geometry is rewritten in place on respawn

  const meteor = {
    line,
    rng: rngFromString(`${seed}:meteor:${index}`),
    active: false,
    timer: 0,
    phaseDuration: 0,
  }
  scheduleMeteorWait(meteor)
  return meteor
}

/** Pool of METEOR_COUNT reusable streaks; each is independently timed from
 * its own seeded rng (rngFromString(seed+':meteor:'+n)), advancing that
 * generator every time it respawns — deterministic, no Math.random/Date.now. */
function createMeteors(seed) {
  const group = new THREE.Group()
  const meteors = []
  for (let i = 0; i < METEOR_COUNT; i++) {
    const meteor = createMeteor(seed, i)
    meteors.push(meteor)
    group.add(meteor.line)
  }
  return { group, meteors }
}
