import * as THREE from 'three/webgpu'
import { pass } from 'three/tsl'
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
import { createUI } from './ui.js'
import { clamp, fantasyName } from './util.js'

const SEED = new URLSearchParams(location.search).get('seed') ?? 'aetherion-1'

// M3: WebGPURenderer on the forceWebGL host (WebGL2 backend today; the M4
// flip is deleting forceWebGL). Init is async — everything downstream that
// touches the renderer (asset PMREM capture, first render) waits on it.
const renderer = new THREE.WebGPURenderer({ antialias: true, forceWebGL: true })
renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
renderer.setSize(innerWidth, innerHeight)
renderer.toneMapping = THREE.ACESFilmicToneMapping
document.body.appendChild(renderer.domElement)
await renderer.init()

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
const bloomPass = bloom(scenePass, 0.3, 0.7, 1.0)
post.outputNode = scenePass.add(bloomPass)

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
  floods.update(dt)
  events.update(dt)
  dragon.update(dt, sky.getSunDir(sunDirScratch))
  airships.update(dt)
  seaIce.update(dt)
  weather.update(dt, camera)
  seaLife.update(dt, camera)
  trails.update(dt)
  ui.update(dt)
  cameraFeel.update(dt)
  controls.update()

  hudTimer -= dt
  if (hudTimer <= 0) {
    hudTimer = 0.5
    const s = world.stats
    statsEl.textContent = `${s.settlements} settlements · ${s.structures} structures\n${s.agents} agent${s.agents === 1 ? '' : 's'} at work`
  }

  post.renderAsync()
})
