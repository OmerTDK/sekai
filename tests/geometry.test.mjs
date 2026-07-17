// Plain node test script for merge-built / procedural geometry sanity checks —
// no test framework, no extra npm deps (just three, already a dependency).
// Run with: node tests/geometry.test.mjs   (from the repo root, so the bare
// 'three' specifier and the relative src/ imports both resolve).
//
// Regression this guards against: a silent mergeGeometries() failure in
// flora.js used to ship canopy-less "stump" trees (trunk only, ~40-70 verts)
// with no error at all — see the M0 program plan's silent-fallback rule and
// "geometry sanity asserts" requirement. These are the class of check
// (non-zero vertex/index counts, non-degenerate bounding boxes) that would
// have caught it immediately.
import assert from 'node:assert'
import * as THREE from 'three'
import { buildTreeGeometry, buildRockGeometry, buildBladeGeometry } from '../src/flora.js'
import { rngFromString } from '../src/util.js'
import {
  buildTower,
  buildHall,
  buildFarm,
  buildBarracks,
  buildObservatory,
  buildLibrary,
  buildForge,
  buildKit,
} from '../src/world.js'

const EPS = 1e-6

let assertionCount = 0
/** assert.ok wrapper that also tallies how many checks actually ran, for the pass summary. */
function ok(cond, msg) {
  assertionCount++
  assert.ok(cond, msg)
}

function assertFinitePositions(geo, label) {
  const pos = geo.attributes && geo.attributes.position
  ok(!!pos, label + ': geometry has no position attribute')
  for (let i = 0; i < pos.array.length; i++) {
    ok(Number.isFinite(pos.array[i]), label + ': position component at index ' + i + ' is not finite (' + pos.array[i] + ')')
  }
}

function assertNonDegenerateBox(box, label) {
  ok(
    Number.isFinite(box.min.x) &&
      Number.isFinite(box.min.y) &&
      Number.isFinite(box.min.z) &&
      Number.isFinite(box.max.x) &&
      Number.isFinite(box.max.y) &&
      Number.isFinite(box.max.z),
    label + ': bounding box is not finite (min=' + JSON.stringify(box.min) + ' max=' + JSON.stringify(box.max) + ')'
  )
  const size = new THREE.Vector3()
  box.getSize(size)
  ok(size.x > EPS, label + ': bounding box degenerate on X axis (size.x=' + size.x + ')')
  ok(size.y > EPS, label + ': bounding box degenerate on Y axis (size.y=' + size.y + ')')
  ok(size.z > EPS, label + ': bounding box degenerate on Z axis (size.z=' + size.z + ')')
}

// ---------------------------------------------------------------------------
// Tree geometry — the stump regression. A real tree (trunk cylinder + 2
// icosahedron canopy blobs) merges to several hundred verts; a merge failure
// that silently falls back to the bare trunk lands around 40-70.
// ---------------------------------------------------------------------------
{
  const { geo, unitHeight } = buildTreeGeometry()
  ok(geo.attributes.position.count > 150, 'tree geometry: expected > 150 vertices (stump regression), got ' + geo.attributes.position.count)
  ok(Number.isFinite(unitHeight) && unitHeight > 0, 'tree geometry: unitHeight must be a finite positive number, got ' + unitHeight)
  geo.computeBoundingBox()
  assertNonDegenerateBox(geo.boundingBox, 'tree geometry')
  assertFinitePositions(geo, 'tree geometry')
}

// ---------------------------------------------------------------------------
// Rock geometry (exported alongside the tree builder per the task spec).
// ---------------------------------------------------------------------------
{
  const rockGeo = buildRockGeometry()
  ok(rockGeo.attributes.position.count > 0, 'rock geometry: expected > 0 vertices, got ' + rockGeo.attributes.position.count)
  rockGeo.computeBoundingBox()
  assertNonDegenerateBox(rockGeo.boundingBox, 'rock geometry')
  assertFinitePositions(rockGeo, 'rock geometry')
}

// ---------------------------------------------------------------------------
// Blade geometry — grass is disabled (GRASS_ENABLED = false in flora.js) but
// the builder must still produce sane, finite geometry.
// ---------------------------------------------------------------------------
{
  const bladeGeo = buildBladeGeometry()
  ok(bladeGeo.attributes.position.count > 0, 'blade geometry: expected > 0 vertices, got ' + bladeGeo.attributes.position.count)
  assertFinitePositions(bladeGeo, 'blade geometry')
}

// ---------------------------------------------------------------------------
// Structure kits — every kit x every race, and (via buildKit) every kit x
// race x tier, must build a Group with >= 1 mesh, a positive total vertex
// count, and a finite, non-degenerate combined bounding box.
// ---------------------------------------------------------------------------
const KIT_BUILDERS = {
  tower: buildTower,
  hall: buildHall,
  farm: buildFarm,
  barracks: buildBarracks,
  observatory: buildObservatory,
  library: buildLibrary,
  forge: buildForge,
}
const KIT_TYPES = Object.keys(KIT_BUILDERS)
const RACES = ['human', 'elf', 'dwarf', 'orc']
const TIERS = [1, 2, 3]

function countMeshesAndVerts(group) {
  let meshCount = 0
  let vertexTotal = 0
  group.traverse((obj) => {
    if (obj.isMesh) {
      meshCount++
      const posAttr = obj.geometry && obj.geometry.attributes && obj.geometry.attributes.position
      if (posAttr) vertexTotal += posAttr.count
    }
  })
  return { meshCount, vertexTotal }
}

// Direct builder calls (the exact named exports the task asks for).
for (const type of KIT_TYPES) {
  for (const race of RACES) {
    const label = 'direct builder ' + type + '/' + race
    const rng = rngFromString('geometry-test:direct:' + type + ':' + race)
    const needsRng = type === 'farm' || type === 'forge'
    const g = needsRng ? KIT_BUILDERS[type](race, rng) : KIT_BUILDERS[type](race)
    ok(g instanceof THREE.Group, label + ': must return a THREE.Group')
    const { meshCount, vertexTotal } = countMeshesAndVerts(g)
    ok(meshCount >= 1, label + ': expected >= 1 mesh, got ' + meshCount)
    ok(vertexTotal > 0, label + ': expected > 0 total vertices, got ' + vertexTotal)
  }
}

// Full buildKit combos, including the tier-3 banner-pole addition.
for (const type of KIT_TYPES) {
  for (const race of RACES) {
    for (const tier of TIERS) {
      const label = 'buildKit ' + type + '/' + race + '/tier' + tier
      const rng = rngFromString('geometry-test:kit:' + type + ':' + race + ':' + tier)
      const g = buildKit(type, race, tier, rng)
      ok(g instanceof THREE.Group, label + ': must return a THREE.Group')

      const { meshCount, vertexTotal } = countMeshesAndVerts(g)
      ok(meshCount >= 1, label + ': expected >= 1 mesh, got ' + meshCount)
      ok(vertexTotal > 0, label + ': expected > 0 total vertices, got ' + vertexTotal)

      g.updateMatrixWorld(true)
      const box = new THREE.Box3().setFromObject(g)
      assertNonDegenerateBox(box, label)
    }
  }
}

console.log(
  'geometry.test: ' +
    assertionCount +
    ' assertions passed (tree + rock + blade geometry; ' +
    KIT_TYPES.length * RACES.length +
    ' direct kit builders; ' +
    KIT_TYPES.length * RACES.length * TIERS.length +
    ' buildKit type/race/tier combos)'
)
