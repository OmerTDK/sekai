import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { createPlanet } from './planet.js'
import { createSky } from './sky.js'
import { createWorld } from './world.js'
import { createBirds } from './birds.js'
import { createFlora } from './flora.js'
import { createWind } from './wind.js'
import { createStorms } from './storms.js'
import { createUI } from './ui.js'
import { clamp, fantasyName } from './util.js'

const SEED = new URLSearchParams(location.search).get('seed') ?? 'aetherion-1'

const renderer = new THREE.WebGLRenderer({ antialias: true })
renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
renderer.setSize(innerWidth, innerHeight)
renderer.toneMapping = THREE.ACESFilmicToneMapping
document.body.appendChild(renderer.domElement)

const scene = new THREE.Scene()
const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.005, 300)
camera.position.set(0, 1.1, 3.2)

const planet = createPlanet(SEED)
scene.add(planet.group)

const sky = createSky(SEED)
scene.add(sky.group)

const world = createWorld(planet, camera, renderer.domElement)
scene.add(world.group)

const birds = createBirds(SEED)
scene.add(birds.group)

const flora = createFlora(planet, camera, SEED)
scene.add(flora.group)

const wind = createWind(planet, camera, SEED)
scene.add(wind.group)

const storms = createStorms(planet, camera, SEED)
scene.add(storms.group)

// Cinematic pass: subtle bloom lifts the sun, atmosphere rim and emissives.
const composer = new EffectComposer(renderer)
composer.addPass(new RenderPass(scene, camera))
composer.addPass(new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.3, 0.7, 1.0))
composer.addPass(new OutputPass())

const controls = new OrbitControls(camera, renderer.domElement)
controls.enableDamping = true
controls.dampingFactor = 0.07
controls.enablePan = false
controls.minDistance = 1.06
controls.maxDistance = 9

document.querySelector('#title .planet-name').textContent = fantasyName(SEED)
const statsEl = document.getElementById('stats')

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(innerWidth, innerHeight)
  composer.setSize(innerWidth, innerHeight)
})

// Dev handle for poking the live scene from the console.
const ui = createUI(world)

window.__planet = { scene, camera, planet, sky, world, birds, flora, wind, storms, ui, renderer, composer, controls }

const clock = new THREE.Clock()
const sunDirScratch = new THREE.Vector3()
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
  birds.update(dt)
  flora.update(dt)
  wind.update(dt)
  storms.update(dt, sky.getSunDir(sunDirScratch))
  ui.update(dt)
  controls.update()

  hudTimer -= dt
  if (hudTimer <= 0) {
    hudTimer = 0.5
    const s = world.stats
    statsEl.textContent = `${s.settlements} settlements · ${s.structures} structures\n${s.agents} agent${s.agents === 1 ? '' : 's'} at work`
  }

  composer.render()
})
