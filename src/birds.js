// Flocks of birds gliding between the peaks and the cloud deck.
import * as THREE from 'three'
import { rngFromString } from './util.js'

const FLOCKS = 6
const WING = 0.0032

export function createBirds(seed) {
  const group = new THREE.Group()
  const rng = rngFromString(seed + ':birds')
  const mat = new THREE.MeshBasicMaterial({ color: 0x1c2530, side: THREE.DoubleSide })
  const wingGeo = new THREE.PlaneGeometry(WING, WING * 0.38)
  wingGeo.translate(WING / 2, 0, 0) // pivot at wing root

  const flocks = []
  for (let f = 0; f < FLOCKS; f++) {
    const size = 5 + Math.floor(rng() * 6)
    const axis = new THREE.Vector3(rng() * 2 - 1, rng() * 2 - 1, rng() * 2 - 1).normalize()
    const start = new THREE.Vector3(rng() * 2 - 1, rng() * 2 - 1, rng() * 2 - 1).normalize()
    // keep the orbit plane roughly perpendicular to the start dir
    start.addScaledVector(axis, -start.dot(axis)).normalize()
    const flock = {
      axis,
      start,
      angle: rng() * Math.PI * 2,
      speed: 0.012 + rng() * 0.01,
      altitude: 1.058 + rng() * 0.014,
      phase: rng() * Math.PI * 2,
      birds: [],
    }
    for (let i = 0; i < size; i++) {
      const bird = new THREE.Group()
      const wingL = new THREE.Mesh(wingGeo, mat)
      const wingR = new THREE.Mesh(wingGeo, mat)
      wingR.rotation.y = Math.PI
      bird.add(wingL, wingR)
      // V formation: pairs fan out behind the leader
      const row = Math.ceil(i / 2)
      const side = i % 2 === 0 ? 1 : -1
      bird.userData = {
        wingL,
        wingR,
        back: row * WING * 1.5,
        side: side * row * WING * 1.2,
        flapPhase: rng() * Math.PI * 2,
        flapSpeed: 7 + rng() * 4,
      }
      group.add(bird)
      flock.birds.push(bird)
    }
    flocks.push(flock)
  }

  // scratch vectors — no per-frame allocation
  const pos = new THREE.Vector3()
  const fwd = new THREE.Vector3()
  const right = new THREE.Vector3()
  const q = new THREE.Quaternion()
  const m = new THREE.Matrix4()
  let t = 0

  function update(dt) {
    t += dt
    for (const fl of flocks) {
      fl.angle += fl.speed * dt
      pos.copy(fl.start).applyAxisAngle(fl.axis, fl.angle)
      fwd.crossVectors(fl.axis, pos).normalize()
      right.crossVectors(pos, fwd).normalize()
      const alt = fl.altitude + Math.sin(t * 0.4 + fl.phase) * 0.004
      m.makeBasis(right, pos, fwd)
      q.setFromRotationMatrix(m)
      for (const b of fl.birds) {
        const u = b.userData
        b.position
          .copy(pos)
          .multiplyScalar(alt)
          .addScaledVector(fwd, -u.back)
          .addScaledVector(right, u.side)
        b.quaternion.copy(q)
        const flap = Math.sin(t * u.flapSpeed + u.flapPhase) * 0.6
        u.wingL.rotation.z = flap
        u.wingR.rotation.z = -flap
      }
    }
  }

  return { group, update }
}
