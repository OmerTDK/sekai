// E2 — Parallax Occlusion Mapping (fake tessellation) for the terrain material.
//
// Self-contained, reusable TSL POM machinery over an ABSTRACT height function:
// this module knows nothing about biomes, the planet, or which texture feeds
// it. It ray-marches a heightfield in a single tangent-space plane and returns
// the parallax-CORRECTED UV that the caller uses to sample albedo / normal, so
// near bumps occlude far ones and the apparent surface parallax-shifts with the
// view. ZERO extra triangles; the caller gates the whole thing behind its own
// near-camera LOD branch so it costs nothing at orbit (see planet.js §5.2).
//
// SEKAI conventions honoured:
//  - TSL NodeMaterial only — no ShaderMaterial / onBeforeCompile / raw GLSL.
//    These functions emit nodes into the CURRENT shader-function stack (they are
//    meant to be called inside a colorNode/normalNode Fn(() => …)); the graph is
//    built ONCE and animated only via uniform() writes by the caller.
//  - BOTH backends compile: the march `Loop` trip count is the JS literal
//    `maxSteps` (a STATIC WGSL for-bound; a node/uniform bound would fail WGSL),
//    and every in-loop height fetch is EXPLICIT-LOD (`.level(0)`) because
//    implicit derivatives inside divergent control flow warn/fail on WGSL. No
//    pointUV, no per-instance vertex attributes, only `.select()`/math nodes.
//  - Determinism: pure function of the caller's inputs + a static texture. NO
//    RNG, no wall-clock time, no uTime anywhere in this file (grep-enforced for
//    the usual banned calls). The packed-height helper uses fixed luminance
//    weights + a fixed box blur, so it produces byte-identical output on every
//    machine.
import * as THREE from 'three/webgpu'
import { If, Loop, Break, float, mix } from 'three/tsl'

/**
 * Parallax Occlusion Mapping in a single tangent-space plane.
 * Steep-parallax linear search + one secant refinement. Height convention:
 * `heightTex` white = peak, black = valley; the ray's "depth from the top
 * surface" is `d = 1 - height`.
 *
 * @param {Object}  o
 * @param {Node}    o.heightTex        texture() node; height read as heightTex.sample(uv).level(0)[channel]
 * @param {Node}    o.uv               vec2 base UV, already scaled (pos * tileScale)
 * @param {Node}    o.viewDirTangent   vec3 view dir in THIS plane's tangent frame;
 *                                      .xy = in-plane, .z = along surface normal (toward camera, > 0)
 * @param {Node|number} o.scale        parallax depth in UV units (uniform() or const)
 * @param {number}  o.minSteps=8       steps when looking straight down
 * @param {number}  o.maxSteps=24      steps at grazing — MUST be a JS literal (static WGSL loop bound)
 * @param {Node}    o.lodFade          float [0..1]; scales depth AND step count. 0 ⇒ no displacement
 * @param {string}  o.channel='r'      which heightTex channel holds height (white = high)
 * @param {(uvNode)=>Node} [o.sampleHeight]  OPTIONAL override: (uv) => float height in [0..1]
 * @returns {Node} vec2 corrected UV
 */
export function parallaxOcclusion({
  heightTex,
  uv,
  viewDirTangent,
  scale,
  minSteps = 8,
  maxSteps = 24,
  lodFade,
  channel = 'r',
  sampleHeight,
}) {
  // Height accessor. Default = explicit-LOD single-channel fetch (WGSL-safe, §6);
  // callers pass `sampleHeight` for per-biome packed blends (one fetch, dotted
  // with the biome weights) — see planet.js §5.2.
  const H = sampleHeight ?? ((p) => heightTex.sample(p).level(0)[channel])

  // Depth fades to 0 with the LOD gate → relief eases in (no pop) and vanishes
  // where the caller's branch is dark. lodFade is REQUIRED in practice (planet
  // passes dNear); guard against an accidental omission so the graph still builds.
  const fade = lodFade ?? float(1)
  const depth = float(scale).mul(fade).toVar()

  // Clamp the along-normal component so grazing views don't divide by ~0 and
  // smear the UV across the whole tile (silhouette blow-up guard, §7 risk 1d).
  const vz = viewDirTangent.z.max(0.15).toVar()

  // View-angle-adaptive step count: grazing (vz→0.15) → ~maxSteps, top-down
  // (vz→1) → minSteps. The Loop's STATIC bound stays `maxSteps`; this only drives
  // the runtime early-exit and the per-step ray-depth increment.
  const nSteps = mix(float(maxSteps), float(minSteps), vz).toVar()
  const layerStep = float(1).div(nSteps).toVar() // ray-depth increment per step

  // Total UV travel from surface(0) to bottom(1) is (view.xy / view.z) * depth.
  const uvMax = viewDirTangent.xy.div(vz).mul(depth).toVar()
  const duv = uvMax.mul(layerStep).toVar()

  const curUv = uv.toVar()
  const curLayer = float(0).toVar() // ray depth 0..1
  const curD = H(curUv).oneMinus().toVar() // heightfield depth = 1 - height
  const prevUv = curUv.toVar()
  const prevLayer = curLayer.toVar()
  const prevD = curD.toVar()

  // STATIC bound `maxSteps` (JS literal) → WGSL `for` with a constant trip count.
  // Runtime early-exit via the adaptive `nSteps` and the surface-crossing test.
  Loop(maxSteps, ({ i }) => {
    // Stop once the ray has descended to/through the heightfield surface, or once
    // we've taken the adaptive step count.
    If(curLayer.greaterThanEqual(curD).or(float(i).greaterThanEqual(nSteps)), () => {
      Break()
    })
    prevUv.assign(curUv)
    prevLayer.assign(curLayer)
    prevD.assign(curD)
    curUv.assign(curUv.sub(duv))
    curLayer.assign(curLayer.add(layerStep))
    curD.assign(H(curUv).oneMinus())
  })

  // One secant step between prev (ray above the surface) and cur (ray below it):
  // find where f(x) = heightfieldDepth(x) - rayDepth(x) crosses zero.
  const after = curD.sub(curLayer) // <= 0 at/after the crossing
  const before = prevD.sub(prevLayer) // >  0 before the crossing
  const t = after.div(after.sub(before).max(1e-5)) // in [0..1]
  return mix(curUv, prevUv, t) // corrected UV
}

/**
 * OPTIONAL soft self-shadow. Marches a few steps from the parallax hit toward
 * the light in the same tangent frame; if the heightfield rises above the
 * straight light ray the point is occluded → darken. Separate export so the main
 * POM keeps exactly the requested signature and self-shadow can be omitted with
 * zero cost. Off by default until the sun uniform is wired (planet.js §5.4).
 *
 * @param {Object}  o
 * @param {Node}    o.heightTex        texture() node (same convention as above)
 * @param {Node}    o.uv               vec2 UV of the parallax HIT (from parallaxOcclusion)
 * @param {Node}    o.lightDirTangent  vec3 light dir in this plane's tangent frame (.z toward light, > 0)
 * @param {Node|number} [o.hitDepth]   ray depth 0..1 at the hit; if omitted, derived as 1 - height(uv)
 * @param {Node|number} o.scale        parallax depth in UV units (same as the POM call)
 * @param {number}  o.steps=6          march steps — MUST be a JS literal (static WGSL loop bound)
 * @param {Node}    o.lodFade          float [0..1]; fades the shadow with the rest of the effect
 * @param {string}  o.channel='r'      height channel
 * @param {(uvNode)=>Node} [o.sampleHeight]  OPTIONAL height override (same as the POM call)
 * @param {number}  o.strength=0.35    max darkening; visibility stays in [1-strength, 1]
 * @returns {Node} float visibility in [1-strength .. 1] (1 = fully lit)
 */
export function parallaxSoftShadow({
  heightTex,
  uv,
  lightDirTangent,
  hitDepth,
  scale,
  steps = 6,
  lodFade,
  channel = 'r',
  sampleHeight,
  strength = 0.35,
}) {
  const H = sampleHeight ?? ((p) => heightTex.sample(p).level(0)[channel])
  const fade = lodFade ?? float(1)
  const depth = float(scale).mul(fade).toVar()

  // Depth of the hit below the top surface (0 = top .. 1 = bottom).
  const startDepth =
    hitDepth === undefined || hitDepth === null ? H(uv).oneMinus().toVar() : float(hitDepth).toVar()

  // Clamp the along-normal light component (grazing-light UV blow-up guard).
  const lz = lightDirTangent.z.max(0.15).toVar()
  // Full UV travel from the hit UP to the top surface, along the light ray.
  const uvToTop = lightDirTangent.xy.div(lz).mul(depth).mul(startDepth).toVar()

  const occ = float(0).toVar()
  // STATIC bound `steps` (JS literal) → constant-trip WGSL for-loop; explicit LOD.
  Loop(steps, ({ i }) => {
    const f = float(i).add(1).div(steps) // (0 .. 1]
    const rayDepth = startDepth.mul(f.oneMinus()) // rises from the hit toward the top
    const sUv = uv.add(uvToTop.mul(f)) // march toward the light
    const hfDepth = H(sUv).oneMinus() // heightfield depth at sUv
    // Positive where the heightfield surface sits ABOVE the light ray → blocks it.
    occ.assign(occ.max(rayDepth.sub(hfDepth)))
  })

  // Visibility multiplier in [1-strength, 1], faded out with the LOD gate.
  const shadow = occ.clamp(0, 1).mul(fade)
  return shadow
    .mul(strength)
    .oneMinus()
    .clamp(1 - strength, 1)
}

// ---------------------------------------------------------------------------
// Heightmap-generation helper (§4). Deterministic — no RNG, no time.
// ---------------------------------------------------------------------------

// Fixed luminance weights (deterministic). Displacement maps are grayscale
// (r==g==b) so luminance == the value; for the Color fallback this derives a
// height proxy from albedo.
const LUMA = [0.299, 0.587, 0.114]

// Plain two-pass integer box blur over an RGBA byte buffer: wrap in X, clamp in
// Y (matching the sphere's equirect-free triplanar tiling). Fixed radius, no
// RNG. Runs once at load (size²·4·(2r+1) ops, trivial at 512²) so it favours
// obvious correctness over a sliding-window optimisation. Blurs in place; keeps
// the height low-frequency so POM's linear search doesn't alias.
function separableBoxBlurRGBA(data, w, h, radius) {
  if (radius <= 0) return
  const win = radius * 2 + 1
  const tmp = new Uint8Array(data.length)

  // Horizontal pass (wrap columns).
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4
      for (let c = 0; c < 4; c++) {
        let sum = 0
        for (let k = -radius; k <= radius; k++) {
          const xx = (((x + k) % w) + w) % w
          sum += data[(y * w + xx) * 4 + c]
        }
        tmp[o + c] = Math.round(sum / win)
      }
    }
  }

  // Vertical pass (clamp rows).
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4
      for (let c = 0; c < 4; c++) {
        let sum = 0
        for (let k = -radius; k <= radius; k++) {
          const yy = Math.min(h - 1, Math.max(0, y + k))
          sum += tmp[(yy * w + x) * 4 + c]
        }
        data[o + c] = Math.round(sum / win)
      }
    }
  }
}

// Grab a 2D canvas context, preferring OffscreenCanvas, falling back to a DOM
// canvas. `willReadFrequently` because we immediately getImageData.
function make2DContext(size) {
  if (typeof OffscreenCanvas !== 'undefined') {
    return new OffscreenCanvas(size, size).getContext('2d', { willReadFrequently: true })
  }
  const c = document.createElement('canvas')
  c.width = size
  c.height = size
  return c.getContext('2d', { willReadFrequently: true })
}

/**
 * Reads up to 4 already-decoded source images (grayscale _Displacement, OR the
 * Color maps as a zero-download luminance fallback) and packs them into ONE RGBA
 * DataTexture — channel k = source k's height — so POM does ONE fetch per march
 * step and blends per-biome via dot(rgba, biomeW). Deterministic: fixed
 * luminance weights + fixed separable blur, no RNG, no time.
 *
 * @param {Object} o
 * @param {(HTMLImageElement|ImageBitmap|HTMLCanvasElement)[]} o.sources  length ≤ 4, in biome order [grass,rock,sand,snow]
 * @param {number} o.size=512     packed texture edge (downsample OK; height is low-freq)
 * @param {number} o.blur=1       separable box-blur radius in texels (0 = none)
 * @param {boolean} o.fromColor=false  true ⇒ height = luminance (Color fallback);
 *                                     false ⇒ sources already ARE height (Displacement)
 * @returns {THREE.DataTexture}   RGBA8, RepeatWrapping, NoColorSpace, needsUpdate=true
 */
export function buildPackedHeightTexture({ sources, size = 512, blur = 1, fromColor = false }) {
  const ctx = make2DContext(size)
  const out = new Uint8Array(size * size * 4) // RGBA, channel k = source k height

  sources.slice(0, 4).forEach((img, k) => {
    ctx.clearRect(0, 0, size, size)
    ctx.drawImage(img, 0, 0, size, size) // decode + downsample once
    const px = ctx.getImageData(0, 0, size, size).data
    for (let i = 0; i < size * size; i++) {
      const r = px[i * 4]
      const g = px[i * 4 + 1]
      const b = px[i * 4 + 2]
      out[i * 4 + k] = fromColor ? Math.round(r * LUMA[0] + g * LUMA[1] + b * LUMA[2]) : r
    }
  })

  if (blur > 0) separableBoxBlurRGBA(out, size, size, blur)

  const tex = new THREE.DataTexture(out, size, size, THREE.RGBAFormat)
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.colorSpace = THREE.NoColorSpace
  tex.magFilter = THREE.LinearFilter
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.generateMipmaps = true
  tex.anisotropy = 8
  tex.needsUpdate = true
  return tex
}
