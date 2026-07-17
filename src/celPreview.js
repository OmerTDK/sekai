// Anime / cel-shading PREVIEW post-process (behind the architect's ?cel=1 flag).
//
// This is a SCREEN-SPACE preview meant to show the *direction* of an anime
// cel look -- not true per-material toon lighting (that's a later full pass).
// It returns a single TSL node to drop into `post.outputNode`, composed
// entirely from three's SHIPPED display nodes so nothing bespoke can rot.
//
// Pipeline note that drives the whole design: with THREE.PostProcessing
// (aka RenderPipeline) the scene `pass` renders with NoToneMapping in the
// working (linear) color space, and ACES tone mapping + sRGB are applied
// *after* whatever we assign to `post.outputNode` (RenderPipeline wraps it
// in `renderOutput(...)` because `outputColorTransform` defaults to true).
// => The color we operate on here is HDR-LINEAR (sun/sky/emissives go >1.0).
//    So we must NOT posterize raw luminance (bands would collapse in shadow
//    and vanish in the >1 highlights). Instead we Reinhard-normalize luma to
//    [0,1), band that, then rescale RGB to hit the banded luma -- which keeps
//    hue/chroma intact (no channel-independent RGB posterize = no color shift).
//    We also return HDR-linear color and let the pipeline tone-map it, exactly
//    like the default look, so bloom-headroom (>1.0 sky) still blooms.
//
// Composition order (documented per contract):
//   1. Cel band   -> hue-preserving luminance posterize (the cel steps)
//   2. Contrast   -> spread the bands apart around a linear mid-grey pivot
//   3. Saturation -> punchy anime palette
//   4. Ink lines  -> Sobel edge-detect the scene luminance, composite dark
//                    outlines OVER the cel color (the signature)
//   5. Bloom      -> added LAST, sourced from the ORIGINAL hdr scene pass so
//                    the sun/emissives glow exactly as in the default look
//                    (matches main.js: bloom is the final additive term).
//
// Godrays were considered and SKIPPED: GodraysNode needs a light-source
// screen position + an occlusion/depth setup that can't be supplied from a
// pure post pass without touching the scene -- out of scope for a preview.

import { bloom } from 'three/addons/tsl/display/BloomNode.js'
import { sobel } from 'three/addons/tsl/display/SobelOperatorNode.js'
import { float, vec3, vec4, mix, smoothstep, luminance, saturation, posterize } from 'three/tsl'

// ---- Tuning knobs (architect tweaks these for the verdict) -----------------

// Cel banding: how many hard luminance steps. 4-5 reads as classic anime cel.
const BAND_COUNT = 4

// Palette punch.
const SATURATION = 1.4 // >1 super-saturates (1 = untouched)
const CONTRAST = 1.12 // spread bands apart; keep gentle, banding already adds punch
const CONTRAST_PIVOT = 0.18 // linear mid-grey the contrast pivots around

// Ink outlines. Sobel returns a luminance-gradient magnitude G; we threshold it
// into an ink mask and darken the cel color toward OUTLINE_COLOR by OUTLINE_STRENGTH.
// NOTE: G is measured in HDR-linear luminance space, so these thresholds are the
// most likely thing to need an eyeball tweak (see report).
const OUTLINE_STRENGTH = 0.35 // max darkening the ink applies (0..1 toward OUTLINE_COLOR)
const OUTLINE_THRESHOLD = 0.3 // gradient magnitude where an edge starts to ink
const OUTLINE_SOFTNESS = 0.4 // ramp width above the threshold (anti-aliases the line)
const OUTLINE_COLOR = 0.015 // near-black ink (linear); tone-maps to a dark line

// Bloom: identical params to the default look so the glow is unchanged.
const BLOOM_STRENGTH = 0.3
const BLOOM_RADIUS = 0.7
const BLOOM_THRESHOLD = 1.0

const EPS = 1e-4

/**
 * Build the anime cel-shaded output node.
 *
 * @param {import('three/webgpu').Node} scenePass - the PassNode from pass(scene, camera).
 * @param {import('three/webgpu').Scene} _scene - accepted for API stability (unused).
 * @param {import('three/webgpu').Camera} _camera - accepted for API stability (unused).
 * @param {import('three/webgpu').Renderer} _renderer - accepted for API stability (unused;
 *        Sobel derives its own texel size from the pass texture).
 * @returns {import('three/webgpu').Node} a vec4 node for `post.outputNode`.
 */
export function buildCelOutputNode(scenePass, _scene, _camera, _renderer) {
  // Scene color as a texture node (canonical sobel/bloom input; HDR-linear rgb).
  const sceneColor = scenePass.getTextureNode()
  const rgb = sceneColor.rgb

  // --- 1. Cel band: hue-preserving luminance posterize ----------------------
  // Reinhard-normalize HDR luma into [0,1) so bands are perceptual & bounded,
  // band it with the shipped posterize, center the bands (+half step) so we
  // don't crush to pure black / blow to pure white, then invert back to a luma
  // target and rescale rgb to hit it -> hard cel steps with the hue preserved.
  const luma = luminance(rgb).max(EPS)
  const t = luma.div(luma.add(1.0)) // 0..1
  const tBanded = posterize(t, float(BAND_COUNT)).add(0.5 / BAND_COUNT) // centered steps
  const lumaBanded = tBanded.div(tBanded.oneMinus()) // inverse Reinhard (bounded, no /0)
  let cel = rgb.mul(lumaBanded.div(luma)) // preserve hue: uniform rgb rescale

  // --- 2. Contrast: extrapolate around a linear mid-grey pivot ---------------
  cel = mix(vec3(CONTRAST_PIVOT), cel, CONTRAST).max(0.0)

  // --- 3. Saturation: vivid anime palette -----------------------------------
  cel = saturation(cel, SATURATION)

  // --- 4. Ink outlines: Sobel edge magnitude -> dark line over the cel color -
  // Sobel edge-detects scene luminance; G is in .r. Smoothstep gives a clean
  // anti-aliased ~1px ink mask; mix darkens the cel color toward the ink color.
  const edge = sobel(sceneColor).r
  const ink = smoothstep(OUTLINE_THRESHOLD, OUTLINE_THRESHOLD + OUTLINE_SOFTNESS, edge).mul(OUTLINE_STRENGTH)
  const inked = mix(cel, vec3(OUTLINE_COLOR), ink)

  // --- 5. Bloom LAST, from the original HDR pass (unchanged glow) ------------
  const bloomPass = bloom(scenePass, BLOOM_STRENGTH, BLOOM_RADIUS, BLOOM_THRESHOLD)

  // Return HDR-linear vec4; the pipeline tone-maps + sRGB-converts it after.
  return vec4(inked.max(0.0), 1.0).add(bloomPass)
}
