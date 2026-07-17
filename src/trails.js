// Footprint decal trails behind walking agents -- "the honest version of
// snow deformation" (M-WX program plan): rather than actually deforming the
// terrain mesh, a walker crossing snow ground stamps a tiny dark oval decal
// into its wake. ONE ring-buffer InstancedMesh (ONE draw call, ~600
// instances); each stamp fades out over ~25s via a per-instance shader
// alpha fade (uTime uniform - stampTime attribute, no per-frame CPU/GPU
// buffer re-upload needed for the fade itself), then its slot recycles
// oldest-first.
//
// Everything about WHEN/WHERE a print lands is derived from
// world.forEachWalker's live agent positions plus planet's own
// deterministic height/biome fields; the only "randomness" (print
// size/rotation jitter) is rngFromString/hash01 keyed off (seed, walker id,
// per-walker stamp index), so the same walk history always reproduces the
// same trail -- no Math.random/Date.now anywhere in this file.
//
// Contract (pinned, docs/superpowers/plans/2026-07-17-m-wx-jit.md, builder
// B5): createTrails(planet, world, seed) -> { group, update(dt) }. Closest
// existing pattern: flora.js's tree/rock contact-blob InstancedMesh (a flat
// circle, non-uniformly scaled per instance, lifted off the terrain along
// its own placement direction) -- this file reuses that same geometry/
// placement idea for the footprint ovals themselves.
import * as THREE from 'three/webgpu'
import { rngFromString, hash01, smoothstep } from './util.js'

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------
const POOL_SIZE = 600 // ring-buffer capacity; oldest-first overwrite once full

// -- contract-pinned thresholds --
const STAMP_MIN_ANGLE = 0.0009 // rad moved since the walker's last stamp before a new print lands
const SURFACE_LIFT = 0.0006 // radial lift above sampleHeight, dodges z-fighting
const SNOW_POLAR_MIN = 0.45 // biomeAt().polar gate

// Squared-chord stand-in for the true great-circle angle above -- see
// flora.js's createSpacingGrid comment: chord and arc length agree to
// within ~1e-8 relative error at scales this small, so no acos() is needed.
const STAMP_MIN_ANGLE_SQ = STAMP_MIN_ANGLE * STAMP_MIN_ANGLE

// Upper bound on a single accepted step: comfortably above any real
// walking distance (AGENT_SPEED=0.01 rad/s in world.js, x2.2 at its
// fastest approach gait, even under a generous frame-hitch dt, tops out
// around 0.0044 rad) but well below a same-id despawn/respawn reset or a
// cross-settlement jump (structures alone are spaced >=0.012 rad apart,
// placement.js STRUCT_MIN_SEP). Guards against painting one bogus footprint
// across open space when a walker's position resets underneath the same id.
const STAMP_MAX_ANGLE = 0.01
const STAMP_MAX_ANGLE_SQ = STAMP_MAX_ANGLE * STAMP_MAX_ANGLE

// Mirrors planet.js's own peak-snow smoothstep(0.74, 0.86, landT) band
// exactly (terrainColorAt's `peakT`), so a footprint only ever stamps on
// ground planet.js itself would actually paint white. The smoothstep
// midpoint (landT=0.8, weight 0.5) is treated as "solidly snow", matching
// how SNOW_POLAR_MIN treats biomeAt().polar as a boolean-ish gate.
//
// In today's world this branch is effectively dormant for agents
// specifically: settlement anchors, structures, and every wander point are
// all placed via findLandAnchor/findStructureSpot/randomLandNear
// (placement.js), which enforce sampleHeight < SEA_LEVEL + 0.03
// (MAX_BUILD_HEIGHT) -- i.e. landT capped around ~0.45, well under this
// band's floor of 0.74. Kept anyway because the contract explicitly asks
// for it, it costs nothing extra once biomeAt has already been sampled for
// the polar check, and it's the correct behavior if a future mountain
// settlement ever lands higher.
const SNOW_PEAK_LO = 0.74
const SNOW_PEAK_HI = 0.86
const SNOW_PEAK_MIN_WEIGHT = 0.5

const FADE_DURATION = 25 // seconds for a print to fade fully out

// -- print shape (not contract-pinned -- tuned by feel against BLADE_HEIGHT/
// PERSON_HEIGHT in flora.js/world.js) --
const PRINT_LEN = 0.0008 // instance scale radius along the direction of travel
const PRINT_WID = 0.00038 // instance scale radius across the direction of travel
const PRINT_SIZE_JITTER = 0.2 // +/- fraction, seeded per stamp
const PRINT_YAW_JITTER = 0.22 // rad, +/- rotation noise around the surface normal, seeded per stamp
const SIDE_OFFSET = 0.0006 // rad-ish tangent offset, alternated left/right per stamp so prints read as steps

// Small, deterministic per-race flavor layered on top of the seeded jitter
// above -- dwarves/orcs press a heavier tread, elves a lighter one. Purely
// a taste call, not contract-pinned: delete this table and the one `* raceMul`
// use below to drop it without touching anything else.
const RACE_PRINT_MULT = { human: 1, elf: 0.87, dwarf: 1.15, orc: 1.1 }

const SWEEP_INTERVAL = 4 // sim-seconds between walker-map eviction sweeps
const STALE_AFTER = 4 // sim-seconds unseen before a walker record is evicted

const COLOR_PRINT = 0x33404d // muted charcoal-blue
const PRINT_ALPHA = 0.42 // <= 0.5 per ART.md

const STAMP_TIME_UNSET = -1e6 // sentinel so never-stamped slots fade-shader to alpha 0 from frame one

// ---------------------------------------------------------------------------
// Shared scratch for composeFootMatrix (module-level, mirrors flora.js's
// module-level _t1/_t2/_pos/... -- safe to reuse because everything in this
// file runs synchronously on one thread, never re-entrantly).
// ---------------------------------------------------------------------------
const _fmRight = new THREE.Vector3()
const _fmFwd = new THREE.Vector3()
const _fmRightJ = new THREE.Vector3()
const _fmFwdJ = new THREE.Vector3()
const _fmBasis = new THREE.Matrix4()
const _fmQuat = new THREE.Quaternion()
const _fmPos = new THREE.Vector3()
const _fmScale = new THREE.Vector3()

/**
 * Composes one footprint instance's transform into `out`. `dir` is the
 * exact surface direction the print sits at (already offset to its side of
 * the path and renormalized -- see stampPrint below); `radius` is that
 * direction's sampled ground height + SURFACE_LIFT. `fwd` is the walker's
 * tangent-plane motion direction (unit length, already orthogonal to the
 * walker's own dir -- see processWalkerInner). Local +Y plants along the
 * surface normal (`dir` itself -- the same sphere-normal approximation
 * flora.js's plantedMatrix uses), local +Z along `fwd` rotated by the
 * seeded yaw jitter `yawJ`, so sLen/sWid scale the oval's long axis to the
 * direction of travel.
 */
function composeFootMatrix(out, dir, radius, fwd, yawJ, sLen, sWid) {
  _fmRight.crossVectors(dir, fwd).normalize()
  _fmFwd.crossVectors(_fmRight, dir).normalize() // re-orthogonalize against dir exactly
  const cy = Math.cos(yawJ)
  const sy = Math.sin(yawJ)
  _fmRightJ.set(
    _fmRight.x * cy + _fmFwd.x * sy,
    _fmRight.y * cy + _fmFwd.y * sy,
    _fmRight.z * cy + _fmFwd.z * sy,
  )
  _fmFwdJ.set(
    _fmFwd.x * cy - _fmRight.x * sy,
    _fmFwd.y * cy - _fmRight.y * sy,
    _fmFwd.z * cy - _fmRight.z * sy,
  )
  _fmBasis.makeBasis(_fmRightJ, dir, _fmFwdJ)
  _fmQuat.setFromRotationMatrix(_fmBasis)
  _fmPos.copy(dir).multiplyScalar(radius)
  _fmScale.set(sWid, 1, sLen)
  out.compose(_fmPos, _fmQuat, _fmScale)
}

/** True if biomeAt's output describes ground planet.js would itself paint snow. */
function isSnowGround(biome) {
  if (biome.polar > SNOW_POLAR_MIN) return true
  return smoothstep(SNOW_PEAK_LO, SNOW_PEAK_HI, biome.landT) > SNOW_PEAK_MIN_WEIGHT
}

// A tiny flat oval -- the same low-poly-circle-lying-flat trick as flora.js's
// buildBlobGeometry, non-uniformly scaled per instance (see composeFootMatrix)
// to elongate along each print's own direction of travel.
function buildPrintGeometry() {
  const geo = new THREE.CircleGeometry(1, 8)
  geo.rotateX(-Math.PI / 2) // lie flat: default +Z-facing circle -> +Y-facing
  return geo
}

// ---------------------------------------------------------------------------
// Silent-fallback rule: every graceful-degradation path warns exactly once.
// ---------------------------------------------------------------------------
let warnedFootFade = false
let warnedWalkerProcessing = false
let warnedForEachWalker = false

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------
export function createTrails(planet, world, seed) {
  const geo = buildPrintGeometry()
  geo.setAttribute(
    'stampTime',
    new THREE.InstancedBufferAttribute(new Float32Array(POOL_SIZE).fill(STAMP_TIME_UNSET), 1),
  )
  const stampTimeAttr = geo.attributes.stampTime

  const mat = new THREE.MeshBasicMaterial({
    color: COLOR_PRINT,
    transparent: true,
    opacity: PRINT_ALPHA,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  })

  // Per-instance age fade: a stampTime attribute + a small vertex/fragment
  // shader tweak (uTime uniform ticks every frame, no buffer re-upload
  // needed for the fade itself -- only a fresh stamp touches the instance
  // buffers). Guarded exactly like flora.js's grass-wind/tree-sway shaders:
  // a failed injection falls back to constant alpha (prints still stamp,
  // place, and recycle correctly; they just don't fade until their ring
  // slot gets overwritten by a later stamp).
  let fadeUniforms = null
  mat.customProgramCacheKey = () => 'trails-footprint-fade-v1'
  mat.onBeforeCompile = (shader) => {
    try {
      shader.uniforms.uTime = { value: 0 }
      shader.uniforms.uFadeDuration = { value: FADE_DURATION }
      shader.vertexShader =
        'uniform float uTime;\nuniform float uFadeDuration;\nattribute float stampTime;\nvarying float vFootAlpha;\n' +
        shader.vertexShader
      const patchedVert = shader.vertexShader.replace(
        '#include <begin_vertex>',
        [
          '#include <begin_vertex>',
          'float footAge = uTime - stampTime;',
          'vFootAlpha = 1.0 - clamp(footAge / uFadeDuration, 0.0, 1.0);',
        ].join('\n'),
      )
      if (patchedVert === shader.vertexShader)
        throw new Error('trails.js: footprint vertex injection point not found')
      shader.vertexShader = patchedVert

      shader.fragmentShader = 'varying float vFootAlpha;\n' + shader.fragmentShader
      const patchedFrag = shader.fragmentShader.replace(
        '#include <color_fragment>',
        ['#include <color_fragment>', 'diffuseColor.a *= vFootAlpha;'].join('\n'),
      )
      if (patchedFrag === shader.fragmentShader)
        throw new Error('trails.js: footprint fragment injection point not found')
      shader.fragmentShader = patchedFrag

      fadeUniforms = shader.uniforms
    } catch (err) {
      fadeUniforms = null
      if (!warnedFootFade) {
        warnedFootFade = true
        console.warn(
          '[planet] trails.js: footprint fade degraded — onBeforeCompile shader injection failed, prints render at constant alpha and only disappear when their ring slot recycles: ' +
            err,
        )
      }
    }
  }

  const mesh = new THREE.InstancedMesh(geo, mat, POOL_SIZE)
  mesh.frustumCulled = false // global, sparse decals scattered planet-wide -- no single bounding sphere fits well; 600 tiny instances is cheap regardless

  // Defense in depth: every slot starts at zero scale (fully degenerate,
  // renders nothing) regardless of whether the fade shader above compiled.
  // Without this, a shader-compile failure would leave frame-one instance
  // matrices at InstancedMesh's default all-zero Float32Array, which is a
  // singular matrix -- undefined rendering, not just "wrong size". The only
  // way a slot becomes visible from here is stampPrint() giving it a real
  // transform.
  const zeroMat = new THREE.Matrix4().makeScale(0, 0, 0)
  for (let i = 0; i < POOL_SIZE; i++) mesh.setMatrixAt(i, zeroMat)
  mesh.instanceMatrix.needsUpdate = true

  const group = new THREE.Group()
  group.add(mesh)

  // -- live state ----------------------------------------------------------
  const records = new Map() // walker id -> { lastDir, side, seenAt, stampSeq } -- mutated in place, never recreated per frame
  let simTime = 0
  let sweepTimer = 0
  let nextSlot = 0

  // -- per-frame scratch (zero allocation in steady state) -----------------
  const _curDir = new THREE.Vector3()
  const _deltaDir = new THREE.Vector3()
  const _fwdDir = new THREE.Vector3()
  const _biomeScratch = {}
  const _stampSide = new THREE.Vector3()
  const _stampOffsetDir = new THREE.Vector3()
  const _stampMat = new THREE.Matrix4()

  function stampPrint(dir, fwd, race, rec, id) {
    const slot = nextSlot
    nextSlot = (nextSlot + 1) % POOL_SIZE

    const jr = rngFromString(seed + ':trail:' + id + ':' + rec.stampSeq)
    const yawJ = (jr() * 2 - 1) * PRINT_YAW_JITTER
    const sizeJ = 1 + (jr() * 2 - 1) * PRINT_SIZE_JITTER
    const raceMul = RACE_PRINT_MULT[race] || 1

    // Offset to the alternating side of the path, then resample ground
    // height at the offset spot -- same "shift in the tangent plane,
    // renormalize, resample" convention flora.js's grass jitter uses.
    _stampSide.crossVectors(dir, fwd).normalize()
    _stampOffsetDir
      .copy(dir)
      .addScaledVector(_stampSide, rec.side * SIDE_OFFSET)
      .normalize()
    const groundR = planet.sampleHeight(_stampOffsetDir) + SURFACE_LIFT

    composeFootMatrix(
      _stampMat,
      _stampOffsetDir,
      groundR,
      fwd,
      yawJ,
      PRINT_LEN * sizeJ * raceMul,
      PRINT_WID * sizeJ * raceMul,
    )

    mesh.setMatrixAt(slot, _stampMat)
    mesh.instanceMatrix.needsUpdate = true
    stampTimeAttr.array[slot] = simTime
    stampTimeAttr.needsUpdate = true
  }

  function processWalkerInner(id, dir, race) {
    let rec = records.get(id)
    if (!rec) {
      // First sighting: nothing to compare against yet -- just anchor the
      // tracker (dir copied out, never the live reference) and wait.
      records.set(id, {
        lastDir: dir.clone(),
        side: hash01(seed + ':trail-side:' + id) < 0.5 ? -1 : 1,
        seenAt: simTime,
        stampSeq: 0,
      })
      return
    }
    rec.seenAt = simTime

    _curDir.copy(dir) // copy immediately -- never retain the live reference
    _deltaDir.copy(_curDir).sub(rec.lastDir)
    const moveSq = _deltaDir.lengthSq()
    if (moveSq < STAMP_MIN_ANGLE_SQ) return
    if (moveSq > STAMP_MAX_ANGLE_SQ) {
      // Implausible single-step jump (agent despawned/respawned under the
      // same id, or a home-position reset) -- resync without painting a
      // false footprint across open space.
      rec.lastDir.copy(_curDir)
      return
    }

    _fwdDir.copy(_deltaDir).addScaledVector(_curDir, -_deltaDir.dot(_curDir)) // project out any radial component
    const fwdLenSq = _fwdDir.lengthSq()
    if (fwdLenSq < 1e-14) {
      rec.lastDir.copy(_curDir)
      return
    }
    _fwdDir.multiplyScalar(1 / Math.sqrt(fwdLenSq))

    // Expensive call (planet.js flags biomeAt as "not tuned for per-frame
    // calls") -- only reached after the cheap movement gate above, so it
    // runs at roughly the stamp rate, not the frame rate.
    planet.biomeAt(_curDir, _biomeScratch)
    if (!isSnowGround(_biomeScratch)) {
      rec.lastDir.copy(_curDir) // still advance the tracker so leaving+reentering snow doesn't burst-stamp
      return
    }

    stampPrint(_curDir, _fwdDir, race, rec, id)
    rec.lastDir.copy(_curDir)
    rec.side = -rec.side
    rec.stampSeq++
  }

  // One try/catch boundary around the whole per-walker body: a single bad
  // walker (or a future planet.js/world.js contract change) degrades to
  // "this walker stamps no prints this frame" instead of breaking the loop
  // for every other walker.
  function processWalker(id, dir, race) {
    try {
      processWalkerInner(id, dir, race)
    } catch (err) {
      if (!warnedWalkerProcessing) {
        warnedWalkerProcessing = true
        console.warn('[planet] trails.js: footprint stamping degraded for one or more walkers — ' + err)
      }
    }
  }

  function update(dt) {
    simTime += dt
    if (fadeUniforms) fadeUniforms.uTime.value = simTime

    try {
      world.forEachWalker(processWalker)
    } catch (err) {
      if (!warnedForEachWalker) {
        warnedForEachWalker = true
        console.warn(
          '[planet] trails.js: world.forEachWalker unavailable — footprint trails disabled: ' + err,
        )
      }
    }

    sweepTimer += dt
    if (sweepTimer >= SWEEP_INTERVAL) {
      sweepTimer = 0
      for (const [id, rec] of records) {
        if (simTime - rec.seenAt > STALE_AFTER) records.delete(id)
      }
    }
  }

  return { group, update }
}
