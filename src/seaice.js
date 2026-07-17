// Sea ice: a polar freeze mask over the ocean -- two matte white-blue cap
// sheets (north + south) sitting a hair above sea level, with a torn,
// noise-driven edge, thin pressure-crack lines, slight blue-green tint
// variation, and a sparse ring of small floes drifting slowly along the
// edge. Everything is derived from `seed` (+ planet's own deterministic
// height/land field), so the same seed always regrows the same ice.
//
// Contract (pinned, docs/superpowers/plans/2026-07-17-m-wx-jit.md, builder
// B2): createSeaIce(planet, seed) -> { group, update(dt) }.
//
// Geometry pattern borrows storms.js's "bounded sphere patch" idea, but
// simplified: unlike a storm (which roams anywhere on the globe and needs
// its own re-centered, rotatable patch), a polar cap never moves, so a
// plain THREE.SphereGeometry sector anchored at each pole (phiLength=2*PI,
// thetaLength=CAP_THETA) is enough -- no per-frame re-centering, no
// orientation quaternion for the sheets themselves.
//
// Shading is a MeshStandardMaterial + onBeforeCompile (matching planet.js's
// own terrain/ocean pattern, not a raw ShaderMaterial) so the ice picks up
// the scene's real lights (sun/hemi/moon, sky.js) automatically -- this
// module never needs a sun direction of its own.
//
// Three draw calls total: north sheet, south sheet, one shared InstancedMesh
// of drifting floes.
import * as THREE from 'three/webgpu'
import { SEA_LEVEL, rngFromString, makeNoise3D, fbm, ridged, clamp, lerp, smoothstep } from './util.js'

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

// -- cap geometry --
// Mesh coverage half-angle from each pole. planet.js's own polar-snow band
// (biomeAt().polar) sits around |y| ~ 0.86 +/- 0.07 with a further +/-0.04
// smoothstep skirt -- roughly theta 14-41 degrees from the pole. This
// module's own noise-driven edge (below) targets a similar band but needs
// generous headroom beyond it: edge jitter and the slow "breathing" wobble
// can both push the visible boundary further out, and the mesh's own hard
// boundary must never be the thing the camera actually sees.
const CAP_THETA = 0.96 // rad, ~55 degrees
const CAP_WIDTH_SEGMENTS = 96
const CAP_HEIGHT_SEGMENTS = 32
const SHEET_RADIUS = SEA_LEVEL + 0.0008 // never z-fights the ocean shell at SEA_LEVEL

// -- edge noise (matched to planet.js's CAP_SCALE=2.6 polar field so the ice
// edge visually agrees with where terrain snow starts) --
const EDGE_SCALE = 2.6
const EDGE_JITTER_SCALE = 11 // higher-freq wobble on top of the base threshold -> torn, not one smooth wave
const ICE_CAP_BASE = 0.83
const ICE_CAP_AMP = 0.07
const ICE_EDGE_JITTER_AMP = 0.035
const ICE_EDGE_SOFT = 0.05 // half-width (in |y|) of the density ramp -- also the room "breathing" wobbles within

// -- pressure cracks: ridged noise thresholded near its own peak traces thin,
// connected crack-like lines -- the cheap route the plan calls for. Bounds
// measured empirically against this exact noise stack (20k-sample check
// against CRACK_SCALE, 4 octaves): p50~0.48, p90~0.71, p95~0.76, p99~0.84,
// observed max~0.95 -- naive "looks like a fraction" bounds like 0.86/0.97
// sit past the p99.8 percentile and render as effectively invisible. --
const CRACK_SCALE = 15
const CRACK_LO = 0.62
const CRACK_HI = 0.82
const CRACK_STRENGTH = 0.55

// -- tint variation --
const TINT_SCALE = 3.2

// -- baked texture: R=crack, G=edge density (read by the material's own
// built-in alphaMap, green-channel convention -- see storms.js's own
// critical comment on this), B=tint. One bake per hemisphere at build time
// only, never rebaked. --
const TEX_SIZE = 512

// -- land mask (vertex attribute, height-based soft coastal fade) --
const LAND_FADE_LO = SEA_LEVEL + 0.0005
const LAND_FADE_HI = SEA_LEVEL + 0.0035

// -- material colors (ART.md-muted white-blue -- see builder report for the
// HSL check) --
const ICE_BASE_COLOR = 0xdbe7ec
const ICE_TINT_COLOR = 0xb8d6d2
const CRACK_COLOR = 0x566b76

// -- "breathing" extent drift: alphaTest itself wobbles slowly within the
// texture's own soft edge band -- no shader recompile (alphaTest is a plain
// uniform refresh once HAS_ALPHATEST is compiled in, see three's
// WebGLMaterials.js), just a per-frame material property nudge. --
const ICE_ALPHATEST_BASE = 0.5
const BREATHE_PERIOD = 260 // seconds -- "over minutes", per spec
const BREATHE_AMPLITUDE = 0.035
const BREATHE_RATE = (Math.PI * 2) / BREATHE_PERIOD
const BREATHE_PHASE_SOUTH = 2.1 // rad -- so the two poles don't pulse in lockstep

// -- floes --
const FLOE_COUNT = 96
const FLOE_SIDES = 9 // low-poly irregular plate
const FLOE_MIN_SCALE = 0.006
const FLOE_MAX_SCALE = 0.013
const FLOE_RADIUS = SEA_LEVEL + 0.0012 // above the sheets -- never z-fights them
const FLOE_THETA_LO = CAP_THETA * 0.45
const FLOE_THETA_HI = CAP_THETA * 1.05
// Sheet visibility is gated by alphaTest around ICE_ALPHATEST_BASE (0.5,
// breathing +/-BREATHE_AMPLITUDE) against this SAME density field -- so a
// floe accepted above ~0.465 could occasionally sit UNDER the opaque sheet
// (visually swallowed, since floe and sheet read almost the same pale
// color). Keeping FLOE_EDGE_HI safely below that floor means every floe
// lands in water the sheet itself never covers, reading as a distinct chip
// against open ocean rather than disappearing into the pack.
const FLOE_EDGE_LO = 0.03 // accept candidates in the "broken up" fringe of the density field...
const FLOE_EDGE_HI = 0.4 // ...not deep pack (and always below the sheet's own alphaTest floor)
const FLOE_MIN_SPACING = 0.025 // rad-ish angular gap -- rejects near-duplicate placements
const FLOE_TRIES_CAP = 6000
const FLOE_DRIFT_RATE_MIN = 0.00025 // rad/s -- "very slowly"
const FLOE_DRIFT_RATE_MAX = 0.0007
const FLOE_WOBBLE_AMP_BASE = 0.015 // rad, slow colatitude bob -- organic, non-circular drift
const FLOE_WOBBLE_RATE_MIN = 0.02
const FLOE_WOBBLE_RATE_MAX = 0.05
const FLOE_SPIN_RATE_MAX = 0.03 // rad/s, slow own-axis tumble
const FLOE_COLOR_JITTER = 0.12

// ---------------------------------------------------------------------------
// Silent-fallback rule: every degradation warns exactly once (shared across
// both hemispheres -- a shader-chunk mismatch would hit both identically,
// since they run the exact same onBeforeCompile function).
// ---------------------------------------------------------------------------
let warnedIceShader = false

// Guarded shader-chunk injection -- throws if the anchor wasn't found (three
// version drift). Same idea as planet.js's own injectShaderChunk, ported
// locally since that one isn't exported.
function injectChunk(src, marker, code) {
  const out = src.replace(marker, marker + '\n' + code)
  if (out === src) throw new Error('seaice.js: injection point "' + marker + '" not found')
  return out
}

// ---------------------------------------------------------------------------
// Per-hemisphere noise fields -- shared by the texture bake AND floe
// placement below, so the floes always cluster on the SAME edge the sheet
// itself actually renders.
// ---------------------------------------------------------------------------
function makeEdgeFields(seed, hemiLabel) {
  const nBase = makeNoise3D(seed + ':seaice:' + hemiLabel + ':edgebase')
  const nJitter = makeNoise3D(seed + ':seaice:' + hemiLabel + ':edgejitter')
  const nCrack = makeNoise3D(seed + ':seaice:' + hemiLabel + ':crack')
  const nTint = makeNoise3D(seed + ':seaice:' + hemiLabel + ':tint')

  // 0..1: how "iced" direction (x,y,z) is -- 0 open ocean, 1 solid pack.
  // Same two-layer recipe as planet.js's own cap noise (base threshold +
  // low-freq wobble), plus a second, higher-frequency jitter layer so the
  // boundary reads as torn rather than one smooth wave.
  function density(x, y, z) {
    const base = fbm(nBase, x * EDGE_SCALE, y * EDGE_SCALE, z * EDGE_SCALE, 3, 2.0, 0.5)
    const jitter = fbm(
      nJitter,
      x * EDGE_JITTER_SCALE,
      y * EDGE_JITTER_SCALE,
      z * EDGE_JITTER_SCALE,
      3,
      2.0,
      0.5,
    )
    const threshold = ICE_CAP_BASE + base * ICE_CAP_AMP + jitter * ICE_EDGE_JITTER_AMP
    return smoothstep(threshold - ICE_EDGE_SOFT, threshold + ICE_EDGE_SOFT, Math.abs(y))
  }

  // 0..1 thin ridged-noise crack lines, gated by density so cracks never
  // show past the torn edge.
  function crackMaskAt(x, y, z, dens) {
    const raw = ridged(nCrack, x * CRACK_SCALE, y * CRACK_SCALE, z * CRACK_SCALE, 4, 2.1, 0.55)
    return smoothstep(CRACK_LO, CRACK_HI, raw) * dens
  }

  // 0..1 low-frequency blue-green tint variation.
  function tintAt(x, y, z) {
    return fbm(nTint, x * TINT_SCALE, y * TINT_SCALE, z * TINT_SCALE, 3, 2.0, 0.5) * 0.5 + 0.5
  }

  return { density, crackMaskAt, tintAt }
}

// ---------------------------------------------------------------------------
// Texture bake (once per hemisphere, at build time only). Texel -> direction
// uses the EXACT theta/phi formula SphereGeometry's own UV generation uses
// (u=phi/phiLength, v=1-(theta-thetaStart)/thetaLength -- see three's
// SphereGeometry.js), so the baked content lines up with the actual mesh
// vertices' UVs.
// ---------------------------------------------------------------------------
function bakeIceTexture(fields, thetaStart, thetaLength) {
  const canvas = document.createElement('canvas')
  canvas.width = TEX_SIZE
  canvas.height = TEX_SIZE
  const ctx = canvas.getContext('2d')
  const img = ctx.createImageData(TEX_SIZE, TEX_SIZE)
  const data = img.data

  for (let py = 0; py < TEX_SIZE; py++) {
    const vParam = 1 - (py + 0.5) / TEX_SIZE
    const theta = thetaStart + vParam * thetaLength
    const sinT = Math.sin(theta)
    const cosT = Math.cos(theta)
    const row = py * TEX_SIZE
    for (let px = 0; px < TEX_SIZE; px++) {
      const phi = ((px + 0.5) / TEX_SIZE) * Math.PI * 2
      const x = -sinT * Math.cos(phi)
      const y = cosT
      const z = sinT * Math.sin(phi)

      const dens = fields.density(x, y, z)
      const crack = fields.crackMaskAt(x, y, z, dens)
      const tint = fields.tintAt(x, y, z)

      const idx = (row + px) * 4
      data[idx] = Math.round(clamp(crack, 0, 1) * 255)
      data[idx + 1] = Math.round(clamp(dens, 0, 1) * 255)
      data[idx + 2] = Math.round(clamp(tint, 0, 1) * 255)
      // CRITICAL (matches storms.js's own comment on its hurricane texture):
      // keep alpha opaque, or canvas premultiplication corrupts the R/G/B
      // channels we're using as plain data, not display color.
      data[idx + 3] = 255
    }
  }
  ctx.putImageData(img, 0, 0)
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.NoColorSpace // data channels (crack/density/tint), not sRGB color
  return tex
}

// ---------------------------------------------------------------------------
// Cap geometry: a plain sphere sector anchored at the pole, plus a per-vertex
// land-mask attribute (soft height-based fade) sampled once at build time --
// the cheapest correct way to keep ice off dry land without a live per-frame
// terrain lookup.
// ---------------------------------------------------------------------------
function buildCapGeometry(planet, thetaStart, thetaLength) {
  const geo = new THREE.SphereGeometry(
    SHEET_RADIUS,
    CAP_WIDTH_SEGMENTS,
    CAP_HEIGHT_SEGMENTS,
    0,
    Math.PI * 2,
    thetaStart,
    thetaLength,
  )
  const pos = geo.attributes.position
  const count = pos.count
  const land = new Float32Array(count)
  const d = new THREE.Vector3()
  for (let i = 0; i < count; i++) {
    d.set(pos.getX(i), pos.getY(i), pos.getZ(i)).normalize()
    const h = planet.sampleHeight(d)
    land[i] = 1 - smoothstep(LAND_FADE_LO, LAND_FADE_HI, h)
  }
  geo.setAttribute('aLand', new THREE.BufferAttribute(land, 1))
  geo.computeBoundingSphere()
  return geo
}

// ---------------------------------------------------------------------------
// Material: matte MeshStandardMaterial (roughness 1, no specular glint --
// same recipe as terrain/rocks) with an onBeforeCompile extension for the
// crack/tint color mix and the land-mask discard. `alphaMap` (three's
// built-in mechanism) already carries the edge density in its green channel
// and drives `alphaTest` discard for the torn edge -- see bakeIceTexture and
// storms.js's own "alphaMap samples the GREEN channel" comment. Guarded:
// falls back to a flat ICE_BASE_COLOR sheet (still land-masked, since the
// base alphaMap/alphaTest discard keeps working either way -- only the
// cracks/tint/coastline-softening extras are lost) if shader-chunk
// injection ever fails.
// ---------------------------------------------------------------------------
function buildIceMaterial(texture) {
  const material = new THREE.MeshStandardMaterial({
    color: ICE_BASE_COLOR,
    roughness: 1,
    metalness: 0,
    flatShading: false, // smooth cap, crisp texture-driven edge -- matches terrainMat's own convention
    alphaMap: texture,
    alphaTest: ICE_ALPHATEST_BASE,
  })

  const iceUniforms = {
    uIceBase: { value: new THREE.Color(ICE_BASE_COLOR) },
    uIceTint: { value: new THREE.Color(ICE_TINT_COLOR) },
    uCrackColor: { value: new THREE.Color(CRACK_COLOR) },
  }
  material.customProgramCacheKey = () => 'seaice-sheet-v1'
  material.onBeforeCompile = (shader) => {
    try {
      Object.assign(shader.uniforms, iceUniforms)

      let vs = shader.vertexShader
      vs = injectChunk(vs, '#include <common>', 'attribute float aLand;\nvarying float vLand;')
      vs = injectChunk(vs, '#include <begin_vertex>', 'vLand = aLand;')
      shader.vertexShader = vs

      let fs = shader.fragmentShader
      fs = injectChunk(
        fs,
        '#include <common>',
        [
          'varying float vLand;',
          'uniform vec3 uIceBase;',
          'uniform vec3 uIceTint;',
          'uniform vec3 uCrackColor;',
        ].join('\n'),
      )
      fs = injectChunk(
        fs,
        '#include <color_fragment>',
        [
          '{',
          '  vec4 iceTex = texture2D( alphaMap, vAlphaMapUv );',
          '  vec3 tinted = mix( uIceBase, uIceTint, iceTex.b );',
          '  diffuseColor.rgb = mix( tinted, uCrackColor, iceTex.r * ' + CRACK_STRENGTH.toFixed(4) + ' );',
          '}',
        ].join('\n'),
      )
      fs = injectChunk(fs, '#include <alphamap_fragment>', 'diffuseColor.a *= vLand;')
      shader.fragmentShader = fs
    } catch (err) {
      if (!warnedIceShader) {
        warnedIceShader = true
        console.warn(
          '[planet] seaice.js: ice sheet shader degraded — onBeforeCompile injection failed, ice renders as a flat matte color with no cracks, tint variation, or coastline softening: ' +
            err,
        )
      }
    }
  }
  return material
}

function buildHemisphere(planet, seed, hemiLabel, hemiSign) {
  const thetaStart = hemiSign > 0 ? 0 : Math.PI - CAP_THETA
  const fields = makeEdgeFields(seed, hemiLabel)
  const texture = bakeIceTexture(fields, thetaStart, CAP_THETA)
  const geometry = buildCapGeometry(planet, thetaStart, CAP_THETA)
  const material = buildIceMaterial(texture)
  const mesh = new THREE.Mesh(geometry, material)
  return { mesh, material, fields }
}

// ---------------------------------------------------------------------------
// Floe geometry: ONE shared low-poly irregular flat plate (a jittered fan
// disc), reused by every instance -- variety comes from per-instance
// scale/rotation/color, the same trick flora.js's rock layer already relies
// on (one DodecahedronGeometry, instance transform does the rest).
// ---------------------------------------------------------------------------
function buildFloeGeometry(seed) {
  const rng = rngFromString(seed + ':seaice:floeshape')
  const positions = [0, 0, 0] // center vertex, index 0
  const normals = [0, 1, 0]
  for (let i = 0; i < FLOE_SIDES; i++) {
    const angle = (i / FLOE_SIDES) * Math.PI * 2
    const r = 0.55 + rng() * 0.45 // irregular silhouette, not a perfect circle
    positions.push(Math.cos(angle) * r, 0, Math.sin(angle) * r)
    normals.push(0, 1, 0)
  }
  const indices = []
  for (let i = 0; i < FLOE_SIDES; i++) {
    const cur = 1 + i
    const next = 1 + ((i + 1) % FLOE_SIDES)
    // (center, next, current): the winding that faces +Y (see module notes
    // in the report -- verified via the cross-product of the two edge
    // vectors from the center) so the plate is front-facing from above.
    indices.push(0, next, cur)
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
  // The floe material sets vertexColors:true so per-instance color jitter
  // (setColorAt, in buildFloes) can vary each floe -- but that only
  // MULTIPLIES a base geometry color, and an unpainted geometry has no
  // `color` attribute at all, which WebGL reads as (0,0,0) for a disabled
  // attribute -> every floe would render pure black regardless of instance
  // color. Paint a neutral white base (flora.js's paintFlatColor does the
  // same for rocks, just with a fixed hue baked in instead of white) so
  // material.color (the actual ice hue) and the per-instance jitter are the
  // only things left to determine the final tint.
  const colors = new Array((FLOE_SIDES + 1) * 3).fill(1)
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
  geo.setIndex(indices)
  return geo
}

// ---------------------------------------------------------------------------
// Floes: one InstancedMesh, placed once via seeded rejection sampling biased
// toward each hemisphere's own noise-driven edge band, then driven every
// frame by a purely analytic function of elapsed time (no stored velocity/
// position state) -- deterministic paths, zero per-frame allocation.
// ---------------------------------------------------------------------------
function buildFloes(planet, seed, fieldsByHemi) {
  const geometry = buildFloeGeometry(seed)
  const material = new THREE.MeshStandardMaterial({
    color: ICE_BASE_COLOR,
    vertexColors: true,
    flatShading: true, // scattered small prop -- deliberate contrast with the sheets' smooth shading (ART.md)
    roughness: 1,
    metalness: 0,
  })
  const mesh = new THREE.InstancedMesh(geometry, material, FLOE_COUNT)
  // Every instance moves every frame (unlike flora's static props), so hint
  // the driver this buffer is genuinely dynamic.
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  mesh.count = 0

  const rng = rngFromString(seed + ':seaice:floes')
  const cand = new THREE.Vector3()
  const instColor = new THREE.Color()

  // Per-floe analytic-drift constants, columnar (struct-of-arrays) so the
  // per-frame update loop below never allocates.
  const baseTheta = new Float32Array(FLOE_COUNT)
  const basePhi = new Float32Array(FLOE_COUNT)
  const hemiSignArr = new Float32Array(FLOE_COUNT)
  const driftRate = new Float32Array(FLOE_COUNT)
  const wobbleAmp = new Float32Array(FLOE_COUNT)
  const wobbleRate = new Float32Array(FLOE_COUNT)
  const wobblePhase = new Float32Array(FLOE_COUNT)
  const spinRate = new Float32Array(FLOE_COUNT)
  const spinPhase = new Float32Array(FLOE_COUNT)
  const scaleArr = new Float32Array(FLOE_COUNT)
  const acceptedX = new Float32Array(FLOE_COUNT)
  const acceptedY = new Float32Array(FLOE_COUNT)
  const acceptedZ = new Float32Array(FLOE_COUNT)

  const minDot = Math.cos(FLOE_MIN_SPACING)
  let count = 0

  for (let hemi = 0; hemi < 2; hemi++) {
    const hemiSign = hemi === 0 ? 1 : -1
    const fields = hemi === 0 ? fieldsByHemi.north : fieldsByHemi.south
    const target = Math.round((FLOE_COUNT * (hemi + 1)) / 2) // half each, remainder rolls onto the second hemisphere
    let tries = 0
    while (count < target && tries < FLOE_TRIES_CAP) {
      tries++
      const theta = lerp(FLOE_THETA_LO, FLOE_THETA_HI, rng())
      const phi = rng() * Math.PI * 2
      const s = Math.sin(theta)
      cand.set(-s * Math.cos(phi), hemiSign * Math.cos(theta), s * Math.sin(phi))
      if (planet.isLand(cand)) continue
      const dens = fields.density(cand.x, cand.y, cand.z)
      if (dens < FLOE_EDGE_LO || dens > FLOE_EDGE_HI) continue

      let clear = true
      for (let k = 0; k < count; k++) {
        if (cand.x * acceptedX[k] + cand.y * acceptedY[k] + cand.z * acceptedZ[k] > minDot) {
          clear = false
          break
        }
      }
      if (!clear) continue

      baseTheta[count] = theta
      basePhi[count] = phi
      hemiSignArr[count] = hemiSign
      // Circulation direction is constant per hemisphere (a coherent drift,
      // like a gyre), mirrored across the equator; only the RATE varies per
      // floe, for organic desync.
      driftRate[count] = lerp(FLOE_DRIFT_RATE_MIN, FLOE_DRIFT_RATE_MAX, rng()) * hemiSign
      wobbleAmp[count] = FLOE_WOBBLE_AMP_BASE * (0.5 + rng())
      wobbleRate[count] = lerp(FLOE_WOBBLE_RATE_MIN, FLOE_WOBBLE_RATE_MAX, rng())
      wobblePhase[count] = rng() * Math.PI * 2
      spinRate[count] = (rng() * 2 - 1) * FLOE_SPIN_RATE_MAX
      spinPhase[count] = rng() * Math.PI * 2
      scaleArr[count] = lerp(FLOE_MIN_SCALE, FLOE_MAX_SCALE, rng())

      const j = 1 - FLOE_COLOR_JITTER * 0.5 + rng() * FLOE_COLOR_JITTER
      instColor.setRGB(j, j, clamp(j * 1.03, 0, 4))
      mesh.setColorAt(count, instColor)

      acceptedX[count] = cand.x
      acceptedY[count] = cand.y
      acceptedZ[count] = cand.z
      count++
    }
  }
  mesh.count = count
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true

  // Per-frame scratch (zero allocation in steady state).
  const refY = new THREE.Vector3(0, 1, 0)
  const refX = new THREE.Vector3(1, 0, 0)
  const dir = new THREE.Vector3()
  const t1 = new THREE.Vector3()
  const t2 = new THREE.Vector3()
  const right = new THREE.Vector3()
  const fwd = new THREE.Vector3()
  const pos = new THREE.Vector3()
  const scaleVec = new THREE.Vector3()
  const quat = new THREE.Quaternion()
  const basis = new THREE.Matrix4()
  const mat4 = new THREE.Matrix4()

  // Orients + positions every floe from elapsed time alone (no stored
  // velocity/position) -- local +Y = surface normal (dir), yawed around
  // that axis. Same tangent-basis recipe as flora.js's plantedMatrix,
  // simplified: floes lie flat on the ocean sphere, no tilt term needed
  // (unlike terrain-planted trees/rocks, there's no local slope to lean
  // into).
  function update(elapsed) {
    for (let i = 0; i < count; i++) {
      const hemiSign = hemiSignArr[i]
      const theta = clamp(
        baseTheta[i] + Math.sin(elapsed * wobbleRate[i] + wobblePhase[i]) * wobbleAmp[i],
        0.02,
        CAP_THETA * 1.15,
      )
      const phi = basePhi[i] + driftRate[i] * elapsed
      const s = Math.sin(theta)
      dir.set(-s * Math.cos(phi), hemiSign * Math.cos(theta), s * Math.sin(phi))

      const ref = Math.abs(dir.y) > 0.95 ? refX : refY
      t1.crossVectors(ref, dir).normalize()
      t2.crossVectors(dir, t1).normalize()
      const yaw = spinPhase[i] + elapsed * spinRate[i]
      const cosY = Math.cos(yaw)
      const sinY = Math.sin(yaw)
      right.set(t1.x * cosY + t2.x * sinY, t1.y * cosY + t2.y * sinY, t1.z * cosY + t2.z * sinY)
      fwd.crossVectors(right, dir).normalize()
      right.crossVectors(dir, fwd).normalize()
      basis.makeBasis(right, dir, fwd)
      quat.setFromRotationMatrix(basis)
      pos.copy(dir).multiplyScalar(FLOE_RADIUS)
      scaleVec.setScalar(scaleArr[i])
      mat4.compose(pos, quat, scaleVec)
      mesh.setMatrixAt(i, mat4)
    }
    if (count > 0) mesh.instanceMatrix.needsUpdate = true
  }

  if (count > 0) {
    update(0)
    mesh.computeBoundingSphere()
  }

  return { mesh, update }
}

export function createSeaIce(planet, seed) {
  const group = new THREE.Group()

  const north = buildHemisphere(planet, seed, 'north', 1)
  const south = buildHemisphere(planet, seed, 'south', -1)
  group.add(north.mesh, south.mesh)

  const floes = buildFloes(planet, seed, { north: north.fields, south: south.fields })
  group.add(floes.mesh)

  let elapsed = 0
  function update(dt) {
    elapsed += dt
    north.material.alphaTest = ICE_ALPHATEST_BASE + Math.sin(elapsed * BREATHE_RATE) * BREATHE_AMPLITUDE
    south.material.alphaTest =
      ICE_ALPHATEST_BASE + Math.sin(elapsed * BREATHE_RATE + BREATHE_PHASE_SOUTH) * BREATHE_AMPLITUDE
    floes.update(elapsed)
  }

  return { group, update }
}
