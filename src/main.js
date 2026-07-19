import * as THREE from 'three/webgpu'
import { pass, renderOutput, interleavedGradientNoise, screenCoordinate, vec4, float } from 'three/tsl'
import { bloom } from 'three/addons/tsl/display/BloomNode.js'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { createPlanet } from './planet.js'
import { createSky } from './sky.js'
import { createWorld } from './world.js'
import { createAirships } from './airships.js'
import { createBirds } from './birds.js'
import { createCameraFeel } from './cameraFeel.js'
import { createDragon } from './dragon.js'
import { createFlora } from './flora.js'
import { createEvents } from './events.js'
import { createVerifyKit } from './verifykit.js'
import { createWind } from './wind.js'
import { createStorms } from './storms.js'
import { createFloods } from './flood.js'
import { createSeaIce } from './seaice.js'
import { createSeaLife } from './sealife.js'
import { createTrails } from './trails.js'
import { createWeather } from './weather.js'
import { createOcean } from './ocean.js'
import { createVolcanoes } from './volcano.js'
import { createWildlife } from './wildlife.js'
import { createCaravans } from './caravans.js'
import { createMeteors } from './meteor.js'
import { createCivSim } from './civsim.js'
import { createCivRender } from './civrender.js'
import { createEarthquakes } from './earthquake.js'
import { createHerald } from './herald.js'
import { createRoads } from './roads.js'
import { createAtmosphereScattering } from './atmosphere.js'
import { createVolumetricClouds } from './clouds.js'
import { createUI } from './ui.js'
import { clamp, fantasyName } from './util.js'

const SEED = new URLSearchParams(location.search).get('seed') ?? 'aetherion-1'

// Default to the WebGL2 backend (WebGPURenderer's WebGL2 path — M3's proven
// host where EVERY material renders). True WebGPU is opt-in via ?renderer=webgpu:
// it works broadly (M4 flip verified) but a few TSL materials still hit
// per-material WGSL compile gaps on the WebGPU backend (custom vertex attributes
// like birds' wingSide, point-sprite coords) that don't exist on WebGL2 — those
// are being hardened before WebGPU becomes the default. All shaders are TSL and
// post is node PostProcessing, so both backends render the same scene code.
const forceWebGL = new URLSearchParams(location.search).get('renderer') !== 'webgpu'
const renderer = new THREE.WebGPURenderer({ antialias: true, forceWebGL })
renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
renderer.setSize(innerWidth, innerHeight)
renderer.toneMapping = THREE.ACESFilmicToneMapping
document.body.appendChild(renderer.domElement)
await renderer.init()
console.log(`[sekai] renderer backend: ${renderer.backend?.isWebGPUBackend ? 'WebGPU' : 'WebGL2'}`)

const scene = new THREE.Scene()
const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.005, 300)
camera.position.set(0, 1.1, 3.2)

const planet = createPlanet(SEED)
scene.add(planet.group)

const sky = createSky(SEED)
scene.add(sky.group)

// Controls exist before the world so cameraFeel can be threaded into
// createWorld's click-to-visit path.
const controls = new OrbitControls(camera, renderer.domElement)
controls.enableDamping = true
controls.dampingFactor = 0.07
controls.enablePan = false
controls.minDistance = 1.06
controls.maxDistance = 9

const cameraFeel = createCameraFeel(planet, camera, controls)

const world = createWorld(planet, camera, renderer.domElement, renderer, cameraFeel, sky)
scene.add(world.group)

const birds = createBirds(planet, SEED)
scene.add(birds.group)

const flora = createFlora(planet, camera, SEED)
scene.add(flora.group)

const wind = createWind(planet, camera, SEED)
scene.add(wind.group)

const storms = createStorms(planet, camera, SEED)
scene.add(storms.group)

const floods = createFloods(planet, storms, SEED)
scene.add(floods.group)

const events = createEvents(world, camera)
scene.add(events.group)

const dragon = createDragon(planet, world, SEED)
scene.add(dragon.group)

const airships = createAirships(planet, world, SEED)
scene.add(airships.group)

// M-WX weather & life.
const seaIce = createSeaIce(planet, SEED)
scene.add(seaIce.group)

const weather = createWeather(planet, sky, SEED)
scene.add(weather.group)

const seaLife = createSeaLife(planet, SEED)
scene.add(seaLife.group)

const trails = createTrails(planet, world, SEED)
scene.add(trails.group)

// --- World-sim wave --------------------------------------------------------
// Animated ocean replaces planet.js's static ocean: hide the old one (found by
// its unique aDepth attribute) and add the moving-water sphere on top.
planet.group.traverse((o) => {
  if (o.isMesh && o.geometry && o.geometry.attributes && o.geometry.attributes.aDepth) o.visible = false
})
const ocean = createOcean(planet, camera, SEED)
scene.add(ocean.mesh)

const volcanoes = createVolcanoes(planet, SEED)
scene.add(volcanoes.group)

const wildlife = createWildlife(planet, SEED)
scene.add(wildlife.group)

const caravans = createCaravans(planet, world, SEED)
scene.add(caravans.group)

const meteors = createMeteors(planet, SEED)
scene.add(meteors.group)

const earthquakes = createEarthquakes(planet, camera, SEED)
scene.add(earthquakes.group)

const roads = createRoads(planet, world, SEED)
scene.add(roads.group)

// The Aemunis Herald — a DOM chronicle ticker (no scene object).
const herald = createHerald(world, SEED)

// NPC civilizations must not overlap session settlements (the covenant), whose
// anchors world populates asynchronously — snapshot after the same settle delay
// airships/caravans use, then build the seeded civ layer.
let civRender = null
setTimeout(() => {
  const anchorsByProject = new Map()
  world.group.traverse((o) => {
    const s = o.userData && o.userData.settlement
    if (s && s.anchorDir) anchorsByProject.set(s.project, s.anchorDir)
  })
  const civSim = createCivSim(planet, SEED, Array.from(anchorsByProject.values()))
  civRender = createCivRender(planet, civSim, SEED)
  scene.add(civRender.group)
  window.__planet.civSim = civSim
  window.__planet.civRender = civRender
}, 6500)

// Git charm: commits become fireworks, merged PRs become monuments.
async function pollEvents() {
  try {
    const res = await fetch('/api/events')
    if (res.ok) events.ingest(await res.json())
  } catch {
    /* server may be mid-restart; next poll catches up */
  }
}
pollEvents()
setInterval(pollEvents, 60_000)

// Cinematic pass: subtle bloom lifts the sun, atmosphere rim and emissives.
// M3: node PostProcessing replaces EffectComposer (which WebGPURenderer can't
// run). Same UnrealBloom params (strength 0.3, radius 0.7, threshold 1.0);
// the >1.0-color bloom-headroom trick the sky relies on is preserved by
// bloom's threshold. Tone mapping still applies via renderer.toneMapping.
const post = new THREE.PostProcessing(renderer)
const scenePass = pass(scene, camera)
const scenePassDepth = scenePass.getTextureNode('depth')
// M5a atmospheric scattering, then M5c volumetric clouds, composited over the
// scene before bloom: scene → scattering → clouds → bloom.
const atmo = createAtmosphereScattering(SEED, camera)
const atmoNode = atmo.node(scenePass, scenePassDepth)
const clouds = createVolumetricClouds(scenePass, camera, {
  getSunDir: (o) => sky.getSunDir(o),
  storms,
  planet,
  sky,
})
sky.setCloudsVisible(false) // volumetric clouds replace the 2.5D shells
const cloudComposite = clouds.compositeOver(atmoNode)
const bloomPass = bloom(cloudComposite, 0.3, 0.7, 1.0)

// Debanding. The whole post chain runs at half-float (HDR), but the final canvas
// is 8-bit sRGB, so smooth dark gradients (sky, atmospheric scattering, deep
// ocean) quantize into visible bands — the "low-def water" artifact. Fix: apply
// tone-map + sRGB ourselves via renderOutput (so we own the last step), then add
// a sub-LSB interleaved-gradient-noise dither in that final display space. The
// noise makes each pixel cross the quantization boundary stochastically, turning
// hard bands into imperceptible grain.
// ponytail: single-sample IGN dither (~±0.5 LSB). If the very darkest tones still
// band, upgrade to a two-sample triangular-PDF (TPDF) dither at ±1 LSB.
post.outputColorTransform = false
const displayColor = renderOutput(cloudComposite.add(bloomPass))
const dither = interleavedGradientNoise(screenCoordinate).sub(0.5).mul(float(1).div(255))
post.outputNode = vec4(displayColor.rgb.add(dither), displayColor.a)

document.querySelector('#title .planet-name').textContent = fantasyName(SEED)
const statsEl = document.getElementById('stats')

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(innerWidth, innerHeight)
})

// Dev handle for poking the live scene from the console.
const ui = createUI(world, {
  resumeSession(id, project) {
    fetch('/api/resume', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, project }),
    }).catch(() => {})
  },
  setPhotoMode(on) {
    controls.autoRotate = on
    controls.autoRotateSpeed = 0.25
  },
})

window.__planet = {
  scene,
  camera,
  planet,
  sky,
  world,
  birds,
  flora,
  wind,
  storms,
  dragon,
  airships,
  floods,
  seaIce,
  weather,
  seaLife,
  trails,
  ocean,
  volcanoes,
  wildlife,
  caravans,
  meteors,
  earthquake: earthquakes,
  roads,
  herald,
  atmosphere: atmo,
  clouds,
  cameraFeel,
  ui,
  renderer,
  post,
  controls,
}
window.__planet.verify = createVerifyKit({
  scene,
  camera,
  post,
  renderer,
  controls,
  planet,
  sky,
  world,
  birds,
  flora,
  wind,
  storms,
  floods,
  seaIce,
  weather,
  seaLife,
  trails,
})

const clock = new THREE.Clock()
const sunDirScratch = new THREE.Vector3()
const stormDirScratch = new THREE.Vector3()
let hudTimer = 0

renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.1)

  // Slow rotation/zoom right down when skimming the surface.
  const dist = camera.position.length()
  controls.rotateSpeed = clamp((dist - 1) * 0.55, 0.02, 1)
  controls.zoomSpeed = clamp((dist - 1) * 0.8, 0.12, 1)

  planet.update(dt)
  sky.update(dt, camera)
  world.update(dt)
  birds.update(dt, camera)
  flora.update(dt)
  wind.update(dt)
  storms.update(dt, sky.getSunDir(sunDirScratch))
  sky.setStormClearing(stormDirScratch, storms.getPrimary(stormDirScratch))
  atmo.update(dt, sky.getSunDir(sunDirScratch))
  clouds.update(dt, camera)
  floods.update(dt)
  events.update(dt)
  dragon.update(dt, sky.getSunDir(sunDirScratch))
  airships.update(dt)
  seaIce.update(dt)
  weather.update(dt, camera)
  seaLife.update(dt, camera)
  trails.update(dt)
  ocean.update(dt)
  volcanoes.update(dt)
  wildlife.update(dt, camera)
  caravans.update(dt)
  meteors.update(dt)
  if (civRender) civRender.update(dt, camera)
  roads.update(dt)
  herald.update(dt)
  ui.update(dt)
  cameraFeel.update(dt)
  controls.update()
  // Earthquake camera shake is an additive offset that controls.update()
  // clears next frame, so it must run AFTER controls.update().
  earthquakes.update(dt)

  hudTimer -= dt
  if (hudTimer <= 0) {
    hudTimer = 0.5
    const s = world.stats
    statsEl.textContent = `${s.settlements} settlements · ${s.structures} structures\n${s.agents} agent${s.agents === 1 ? '' : 's'} at work`
  }

  post.renderAsync()
})
