// Scoped PMREM environment for high-metalness building materials ONLY (M-LD
// env-lighting follow-on to the M-WX material-distinction pass). Builds a
// small offscreen scene approximating OUR sky — a vertex-colored gradient
// hemisphere from ART.md's own palette plus a sun-glow sphere at the sun's
// direction — and PMREM-bakes it into a texture. This is a STATIC capture,
// baked once at load time and never re-rendered: no live sky animation is
// worth chasing here, since it only feeds subtle metal reflections, not the
// visible sky itself.
//
// THE S5 PASTEL-WASH LESSON (do not re-learn this): never assign the result
// to `scene.environment`. That relights every material in the scene,
// including every low-metalness matte building/terrain surface, and washes
// the whole picture pastel-pale under ACES tonemapping — confirmed by the
// spikes/s5 spike, which is why that spike (and this file) assigns the PMREM
// texture to individual `material.envMap` instead, scoped to metalness>0.3
// materials only. See spikes/s5/scene.js's own comment on this for the
// original finding.
import * as THREE from 'three/webgpu'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'

// Fixed sun-direction fallback — mirrors src/sky.js's own SUN_DIR invariant
// ("Other modules assume this exact sun direction — do not change",
// src/sky.js) and spikes/s5/scene.js's own copy of the same constant. Used
// whenever no live `sky` handle is available (or it throws) — acceptable
// because this capture never re-renders anyway, so it never needs to track
// the sun's live orbit; it only needs a plausible, fixed highlight direction
// for brass/copper bolt-ons to catch.
const FALLBACK_SUN_DIR = new THREE.Vector3(1, 0.45, 0.9).normalize()

// ART.md §2.1 "Sky & night" palette (src/sky.js's own HemisphereLight sky/
// ground colors + sun tint) — reused here so metal reflections tie into THIS
// world's actual palette instead of a generic neutral room. This is the
// custom capture evaluated against RoomEnvironment below (see loadout
// decision in the M-WX builder report); RoomEnvironment stays as the
// fallback path if the custom scene ever fails to build.
const SKY_TOP = new THREE.Color('#9db8ff')
const SKY_BOTTOM = new THREE.Color('#3a3128')
const SUN_GLOW = new THREE.Color('#fff2d8')
const CAPTURE_RADIUS = 10
const SUN_GLOW_DIST = 9
const SUN_GLOW_RADIUS = 1.35
const PMREM_SIGMA = 0.04 // matches spikes/s5's own boltOnEnvMap sigma

/** A small offscreen scene: an inward-facing gradient-sky sphere (vertex
 * colors, no lights needed — MeshBasicMaterial) plus a bright sun-glow
 * sphere positioned along `sunDir`, giving brass/copper bolt-ons a
 * plausible directional highlight a flat RoomEnvironment can never provide
 * (a neutral room has no bright spot at all). */
function buildSkyCaptureScene(sunDir) {
  const scene = new THREE.Scene()

  const geo = new THREE.SphereGeometry(CAPTURE_RADIUS, 24, 16)
  geo.scale(-1, 1, 1) // inward-facing, so the camera (at the origin) sees the inside
  const posAttr = geo.attributes.position
  const count = posAttr.count
  const colors = new Float32Array(count * 3)
  const c = new THREE.Color()
  for (let i = 0; i < count; i++) {
    const t = THREE.MathUtils.clamp((posAttr.getY(i) / CAPTURE_RADIUS) * 0.5 + 0.5, 0, 1)
    c.copy(SKY_BOTTOM).lerp(SKY_TOP, t)
    colors[i * 3] = c.r
    colors[i * 3 + 1] = c.g
    colors[i * 3 + 2] = c.b
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  const skyMat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false })
  scene.add(new THREE.Mesh(geo, skyMat))

  const sunMesh = new THREE.Mesh(
    new THREE.SphereGeometry(SUN_GLOW_RADIUS, 12, 8),
    new THREE.MeshBasicMaterial({ color: SUN_GLOW, fog: false }),
  )
  sunMesh.position.copy(sunDir).multiplyScalar(SUN_GLOW_DIST)
  scene.add(sunMesh)

  return scene
}

/**
 * createEnvironment(renderer, sky) -> { envMap, apply(material, intensity), dispose() }
 *
 * `sky` is optional (the current world.js -> assets.js call site doesn't
 * wire the live sky object through yet — a follow-up integration task, not
 * blocking here since the capture is static regardless). When present and
 * it exposes `getSunDir(out)` (src/sky.js's own contract), the capture's
 * sun-glow direction is read from it ONCE at build time; otherwise (or if
 * that call throws) FALLBACK_SUN_DIR is used. Either way this never
 * re-renders — callers should treat the returned envMap as a permanent,
 * static resource for the lifetime of the app.
 */
export function createEnvironment(renderer, sky) {
  const sunDir = FALLBACK_SUN_DIR.clone()
  if (sky && typeof sky.getSunDir === 'function') {
    try {
      sky.getSunDir(sunDir)
    } catch (err) {
      console.warn('[planet] env: sky.getSunDir() failed, using the fixed fallback sun direction —', err)
      sunDir.copy(FALLBACK_SUN_DIR)
    }
  }

  const pmrem = new THREE.PMREMGenerator(renderer)
  let envMap
  try {
    envMap = pmrem.fromScene(buildSkyCaptureScene(sunDir), PMREM_SIGMA).texture
  } catch (err) {
    console.warn('[planet] env: custom sky-gradient capture failed, falling back to RoomEnvironment —', err)
    envMap = pmrem.fromScene(new RoomEnvironment(), PMREM_SIGMA).texture
  }
  pmrem.dispose()

  function apply(material, intensity) {
    material.envMap = envMap
    material.envMapIntensity = intensity
  }

  function dispose() {
    envMap.dispose()
  }

  return { envMap, apply, dispose }
}
