# E2 — terrain CLOSE-UP DETAIL (fake tessellation via Parallax Occlusion Mapping)

E2 makes the ground show real-looking relief when the camera skims near the
surface — cobbles, rock ridges, wind ripples that occlude and parallax-shift
correctly with view angle — with **ZERO extra triangles** and **ZERO cost when
zoomed out**. It does this per-pixel in the fragment shader (Parallax Occlusion
Mapping, POM: a heightmap ray-march), layered on top of the detail-normal maps
that planet.js already ships, and gated by the *same* near-camera LOD fade
(`dNear`) the existing detail layers use — so at orbit distance the whole thing
dynamic-branches off and does not exist.

True hardware tessellation does **not** exist in WebGL2 or WebGPU (no tessellation
shader stage in either target), so "add real micro-geometry" is off the table by
platform. POM is the standard fake: it moves the *apparent* surface per pixel
without touching the mesh. E2 keeps every binding convention — TSL NodeMaterial
only (no ShaderMaterial / onBeforeCompile / raw GLSL), graph built ONCE and
animated by `uniform()` writes only, deterministic (no `Math.random`/`Date.now`),
and compiling on BOTH WebGL2 (default) and true WebGPU (`?renderer=webgpu`).

---

## 1. Ladder evaluation + recommendation

Evaluated cheapest-first. planet.js state as of this spec: the terrain material
already has a full triplanar albedo splat (`uDetailOn`), a triplanar detail-**normal**
splat (`uNormalOn`), a mid-zoom macro layer, and cloud shadows — all gated by a
near-camera fade `dNear` (colorNode line 654 / normalNode line 717).

| # | Rung | New tris | Cost when zoomed OUT | Gives silhouette/occlusion? | Verdict |
|---|------|----------|----------------------|-----------------------------|---------|
| 1 | Detail **normal** maps | 0 | 0 (already `dNear`-gated) | No — shading tilt only, flat at grazing | **Already shipped** — E2's base layer, not new work |
| 2 | **Parallax Occlusion Mapping** | 0 | 0 (dynamic-branched off `dNear`) | Yes — per-pixel parallax + interior occlusion + optional self-shadow | **RECOMMENDED — primary of E2** |
| 3 | Base-mesh density bump (icosa 128→160+) | +global tris everywhere | **Negative** — pays tris/mem/fps at orbit too, for no close-up parallax | Rejected for E2's goal |
| 4 | Min-zoom clamp | 0 | 0 | N/A — hides the problem by forbidding the skim | Rejected (contradicts the epic) |

**Reasoning.**

- **(1) Detail normal maps** are the cheapest possible relief and are *already
  in planet.js* (`uNormalOn`, whiteout-triplanar `triplanarNormalSample`). They
  tilt the shaded normal so the surface catches light like it has bumps — but a
  normal map is a lighting trick, not a geometry trick: there is **no parallax,
  no interior occlusion, and it goes visually flat exactly at the grazing angles
  a surface skim produces** (the worst case for this epic). Keep it as the base
  layer; E2 rides on top of it. Zero new work here.

- **(2) POM — recommended.** A per-pixel heightmap ray-march that offsets the
  sampled UV so near bumps occlude far ones and the apparent surface parallaxes
  as the camera moves — the exact cue a normal map lacks. It adds **no
  triangles**, and because it lives *inside the existing `If(dNear > eps)`
  branch*, the GPU's dynamic branching skips every texture fetch when the camera
  is not near the surface → **literally zero cost when zoomed out** (same
  mechanism the shipped albedo/normal detail already uses). Step count is
  view-angle-adaptive (8 top-down → 24 grazing) so it spends work only where the
  effect is visible. This is the one rung that actually satisfies the epic's
  literal ask ("real-looking relief on skim, zero tris, zero cost at orbit").

- **(3) Base-mesh density bump** is the wrong tool: raising `IcosahedronGeometry`
  detail multiplies triangles across the *entire* planet — paying memory and
  vertex cost at orbit, where nothing is close enough to benefit — and *still*
  produces smooth interpolation between verts, i.e. no sub-mesh relief and no
  parallax. E1 already flags 128→160 as a *measured* escape hatch for making
  carved river valleys mesh-resolvable; that is a macro-relief concern, unrelated
  to E2's per-pixel close-up. Not E2's mechanism.

- **(4) Min-zoom clamp** is a camera constraint, not relief. It "fixes" the flat
  skim by forbidding the skim — the opposite of this epic, whose entire point is
  that skimming the surface looks good. Keep at most a trivial safety floor
  (already present: `controls` slow near the surface, main.js line 296) and move
  on.

**Recommendation: implement (2) POM, layered on the already-shipped (1) normal
maps, gated by the existing `dNear` altitude-LOD fade.** Deliverables below.

---

## 2. New file — `src/pom.js`

A self-contained, reusable TSL POM node the terrain material calls. It knows
nothing about biomes, textures, or the planet — pure POM machinery over an
abstract height function — so it is trivially testable and reusable (E-SIM
craters, roads, etc. could reuse it later).

### 2.1 Exported contract

```js
// src/pom.js
import { Fn, If, Loop, Break, float, vec2, mix } from 'three/tsl'

/**
 * Parallax Occlusion Mapping in a single tangent-space plane.
 * Ray-marches a heightfield and returns the CORRECTED (parallax-shifted) UV
 * that the caller then uses to sample albedo / normal.
 *
 * All in-loop height fetches MUST be explicit-LOD (level 0) — see §6 (both-
 * backend safety). Returns a vec2 UV node; the graph is built once.
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
 * @param {(uvNode)=>Node} [o.sampleHeight]  OPTIONAL override: (uv) => float height in [0..1].
 *                                      When supplied, used instead of heightTex[channel]
 *                                      (this is how per-biome packed height is fed — see §4.2).
 * @returns {Node} vec2 corrected UV
 */
export function parallaxOcclusion({
  heightTex, uv, viewDirTangent, scale,
  minSteps = 8, maxSteps = 24, lodFade, channel = 'r', sampleHeight,
}) { /* … §2.2 … */ }

/**
 * OPTIONAL soft self-shadow. Marches a few steps from the parallax hit toward
 * the light; returns a [0..1] visibility multiplier (1 = lit, <1 = in a crevice).
 * Separate export so the main POM stays exactly the requested signature and
 * self-shadow can be omitted with zero cost. 4–6 steps, same static-bound rule.
 *
 * @returns {Node} float visibility in [0..1]
 */
export function parallaxSoftShadow({
  heightTex, uv, lightDirTangent, hitDepth, scale,
  steps = 6, lodFade, channel = 'r', sampleHeight, strength = 0.35,
}) { /* … §2.3 … */ }

/**
 * Tiny heightmap-generation helper (§4). Reads N already-decoded source images
 * (grayscale _Displacement, OR the Color maps as a zero-download luminance
 * fallback) and packs them into ONE RGBA DataTexture — channel k = source k's
 * height — so POM does ONE fetch per march step and blends per-biome via
 * dot(rgba, biomeW). Deterministic: fixed luminance weights + fixed separable
 * blur, no RNG, no time.
 *
 * @param {Object} o
 * @param {HTMLImageElement[]|ImageBitmap[]} o.sources  length ≤ 4, in biome order [grass,rock,sand,snow]
 * @param {number} o.size=512     packed texture edge (downsample OK; height is low-freq)
 * @param {number} o.blur=1       separable box-blur radius in texels (0 = none)
 * @param {boolean} o.fromColor=false  true ⇒ derive height = luminance (Color fallback);
 *                                     false ⇒ sources already ARE height (Displacement)
 * @returns {THREE.DataTexture}   RGBA8, RepeatWrapping, NoColorSpace, needsUpdate=true
 */
export function buildPackedHeightTexture({ sources, size = 512, blur = 1, fromColor = false }) { /* … §4 … */ }
```

### 2.2 `parallaxOcclusion` body (reference implementation)

Steep-parallax linear search + one secant refinement. Height convention:
`heightTex` white = peak, black = valley; ray "depth from top surface" is
`d = 1 - height`.

```js
export function parallaxOcclusion({
  heightTex, uv, viewDirTangent, scale,
  minSteps = 8, maxSteps = 24, lodFade, channel = 'r', sampleHeight,
}) {
  const H = sampleHeight ?? ((p) => heightTex.sample(p).level(0)[channel]) // explicit LOD — §6

  // Depth fades to 0 with LOD → smooth fade-in (no pop) and no visible effect
  // where the caller's branch is dark. lodFade defaults handled by caller.
  const depth = float(scale).mul(lodFade).toVar()

  // Clamp the along-normal component so grazing views don't divide by ~0 and
  // smear the UV across the whole tile (silhouette blow-up guard).
  const vz = viewDirTangent.z.max(0.15).toVar()

  // View-angle-adaptive step count: grazing (vz small) → maxSteps, top-down → minSteps.
  const nSteps = mix(float(maxSteps), float(minSteps), vz).toVar()
  const layerStep = nSteps.reciprocal().toVar()               // ray-depth increment per step

  // Total UV travel from surface(0) to bottom(1) is (view.xy / view.z) * depth.
  const uvMax = viewDirTangent.xy.div(vz).mul(depth).toVar()
  const duv = uvMax.mul(layerStep).toVar()

  const curUv    = uv.toVar()
  const curLayer = float(0).toVar()                            // ray depth 0..1
  const curD     = H(curUv).oneMinus().toVar()                 // heightfield depth = 1 - height
  const prevUv   = curUv.toVar()
  const prevLayer= curLayer.toVar()
  const prevD    = curD.toVar()

  // STATIC bound maxSteps (JS literal) → WGSL `for` with constant trip count.
  // Runtime early-exit via nSteps and the surface-crossing test.
  Loop(maxSteps, ({ i }) => {
    If(curLayer.greaterThanEqual(curD).or(float(i).greaterThanEqual(nSteps)), () => { Break() })
    prevUv.assign(curUv); prevLayer.assign(curLayer); prevD.assign(curD)
    curUv.assign(curUv.sub(duv))
    curLayer.assign(curLayer.add(layerStep))
    curD.assign(H(curUv).oneMinus())
  })

  // One secant step between prev (ray above surface) and cur (ray below).
  const after  = curD.sub(curLayer)
  const before = prevD.sub(prevLayer)
  const t = after.div(after.sub(before).max(float(1e-5)))
  return mix(curUv, prevUv, t)                                 // corrected UV
}
```

Notes for the builder:
- Confirm the **sign** of `viewDirTangent.xy` against the live image; if relief
  parallaxes the wrong way, negate `uvMax` (convention depends on whether the
  tangent view points surface→camera or camera→surface). One visual check.
- Confirm the exact TSL loop/break API for r185 (`Loop(count, ({ i }) => …)` +
  `Break()`; some builds spell it `Loop({ start, end }, …)` or `.break()`). The
  invariant that MUST hold: the loop's **trip-count argument is a JS number**
  (`maxSteps`), never a uniform/node — that is what keeps WGSL happy (§6).
- `.select()`/`.max()`/`mix()` are all pure-math nodes (no dynamic texture
  indexing), safe on both backends.

### 2.3 `parallaxSoftShadow` (optional, cheap)

After the hit, march a few steps from the hit UV toward the light (in the same
tangent frame). If the heightfield rises above the straight light ray, the point
is occluded → darken. 4–6 steps, static bound, explicit LOD. Returns visibility
`1 - strength*occlusion` clamped to `[1-strength, 1]`. Gated by `lodFade` so it
vanishes with the rest of the effect. Off by default until the sun uniform is
wired (§5.4).

---

## 3. Where the heightmap comes from

POM needs a **heightfield**, and `public/textures/` currently ships only Color +
NormalGL (no `_Displacement`). Two clean sources; recommend the first, fall back
to the second with zero downloads.

**Primary — re-fetch the four ambientCG `_Displacement` maps.** `SOURCES.md`
documents that each already-sourced CC0 set (`Grass004`, `Rock030`, `Ground080`,
`Snow006`) ships a `_Displacement` JPG in the same 1K-JPG zip — it was simply
discarded during the strip-to-what's-used pass. These ARE authentic height data
(grayscale, 1024²), the correct input for POM. Four small grayscale JPGs
(~0.3–0.8 MB each) → **+~2–3 MB** footprint, loaded exactly like the existing
Color/Normal maps (same `TextureLoader`, `RepeatWrapping`, `NoColorSpace`,
`anisotropy 8`), gated by a new `uPomOn`.

**Fallback — derive height from the LOCAL Color maps (zero new download).**
`buildPackedHeightTexture({ sources: [grassColor…], fromColor: true })` computes
`height = luminance(rgb)` per texel. Lower fidelity (albedo ≠ height — dark grass
blades can read as pits), flagged as such, but needs **no new asset**. Good enough
for "fake relief" and a safe degrade if the +footprint is rejected.

**Per-biome vs. single map — the cost decision.** Sampling four biome heightmaps
per march step (4 fetches × up-to-24 steps × 2 material slots) is far too
expensive. Two viable shapes, one fetch/step each:

- **Single shared heightmap (lean first increment).** Use ONE map — `Rock030`'s
  displacement reads as generic rocky micro-relief and is legible under every
  biome at a skim. `heightTex = rockHeightNode`, `H(uv) = heightTex.sample(uv).level(0).r`.
  No packing, no canvas, one small download, one fetch/step. Ship POM with this.
- **Packed RGBA per-biome (upgrade).** `buildPackedHeightTexture` packs the four
  maps into ONE RGBA texture (R=grass, G=rock, B=sand, A=snow). POM samples it
  once/step and the caller's `sampleHeight` override blends per-biome:
  `H(uv) = heightTex.sample(uv).level(0).dot(biomeWnorm)` — **one fetch, per-biome
  relief.** Same cost as the single map, better material coherence.

Recommend shipping the **single Rock030 map first** (smallest, fewest moving
parts, immediate visible win), then the **packed RGBA upgrade** as a follow-on
build unit. Both are the same `parallaxOcclusion` call — only the `heightTex` /
`sampleHeight` argument changes.

---

## 4. Heightmap-generation helper (`buildPackedHeightTexture`)

Only needed for the packed-per-biome path (and for the zero-download Color
fallback). Deterministic, no RNG, no time.

```js
export function buildPackedHeightTexture({ sources, size = 512, blur = 1, fromColor = false }) {
  const canvas = new OffscreenCanvas(size, size)          // or document.createElement('canvas')
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  const out = new Uint8Array(size * size * 4)             // RGBA, channel k = source k height
  const LUMA = [0.299, 0.587, 0.114]                      // fixed weights — deterministic

  sources.slice(0, 4).forEach((img, k) => {
    ctx.clearRect(0, 0, size, size)
    ctx.drawImage(img, 0, 0, size, size)                  // decode + downsample once
    const px = ctx.getImageData(0, 0, size, size).data
    for (let i = 0; i < size * size; i++) {
      const r = px[i*4], g = px[i*4+1], b = px[i*4+2]
      // Displacement maps are grayscale (r==g==b) so luminance == the value;
      // for Color fallback this derives a height proxy from albedo.
      out[i*4 + k] = fromColor ? Math.round(r*LUMA[0] + g*LUMA[1] + b*LUMA[2]) : r
    }
  })

  if (blur > 0) separableBoxBlurRGBA(out, size, size, blur) // fixed kernel, wrap columns/clamp rows

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
```

`separableBoxBlurRGBA` is a plain two-pass integer box blur (wrap in X, clamp in
Y — matching the sphere's equirect-free triplanar tiling) with a fixed radius; it
keeps the height low-frequency so POM's linear search doesn't alias. No RNG.

The four source images are obtained the same way the material already loads
textures — either from `_Displacement` URLs (primary) or by reusing the Color
`Texture.image` after load (fallback). The helper runs ONCE; the resulting
`DataTexture` is dropped into the material's `pomHeightNode.value` and `uPomOn`
flips to 1 (a binding refresh, never a graph rebuild — spike §6 law).

---

## 5. EXACT planet.js integration

E2 touches only the **terrain material graph** (colorNode + normalNode) and adds
POM uniforms + one height texture. It does **not** touch `sampleHeight`, the mesh
build, ocean, or any exported API — so it is orthogonal to E1 (E1 changes how
*height is sampled/baked*; E2 changes how the *surface material* shades). They
compose cleanly (see §7, risk 6).

### 5.1 New imports + uniforms + height texture (near lines 5–29 and 540–619)

```js
// with the other 'three/tsl' imports (line 9): add nothing new that isn't already
// there for the helper — pom.js imports its own TSL nodes. planet.js just needs:
import { parallaxOcclusion } from './pom.js'
// (optional self-shadow) import { parallaxSoftShadow } from './pom.js'

// Alongside uDetailOn / uNormalOn (near line 548 / 580):
const uPomOn    = uniform(0)      // 0 until the height map(s) load — graceful, like uDetailOn
const uPomDepth = uniform(0.03)   // parallax depth in UV units (tile scale 80 ⇒ ~3.7e-4 world). TUNABLE
const pomHeightNode = texture(makePlaceholderTexture(THREE.NoColorSpace, [128,128,128,255]))

// Loader (mirror the existing detail-texture block, lines 553–572):
//  PRIMARY  : texLoader.load('/textures/Rock030_1K-JPG_Displacement.jpg', tex => {
//               tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.colorSpace = THREE.NoColorSpace
//               tex.anisotropy = 8; pomHeightNode.value = tex; uPomOn.value = 1 })
//  UPGRADE  : load the four _Displacement maps → buildPackedHeightTexture({sources})
//             → pomHeightNode.value = packed; uPomOn.value = 1   (one fetch/step, per-biome)
//  FALLBACK : buildPackedHeightTexture({ sources:[grass/rock/sand/snow Color .image], fromColor:true })
```

### 5.2 colorNode anchor (lines 653–672) — near-detail albedo block

The near-detail albedo currently reads (line 661):
`triplanarColor(grassTexNode, detailPos, bw, 80)…`. **POM is applied as a shared
object-space position offset `detailPosP` that replaces `detailPos` in the four
near-detail triplanar samples** — the existing `triplanarColor`/
`triplanarNormalSample` functions stay **unchanged**, they just receive a
parallax-shifted position. Minimal surface area.

```js
// INSIDE the existing  If(uDetailOn.greaterThan(0.5).and(dNear.greaterThan(0.003)))  block,
// BEFORE  const det = triplanarColor(grassTexNode, detailPos, bw, 80)…
const detailPosP = detailPos.toVar()
If(uPomOn.greaterThan(0.5), () => {
  // Object-space view dir. Group is unrotated at origin ⇒ object space ≡ world,
  // the SAME assumption the shipped cloud-shadow path already relies on
  // (line 697 treats detailPos as a world dir). cameraPosition is world.
  const V = cameraPosition.sub(detailPos).normalize().toVar()

  // Dominant triplanar axis (bw already = normalized |objNormal|). Pick ONE
  // plane → ONE march (not 3×). .select() = pure branch-free choice, WGSL-safe.
  const domX = bw.x.greaterThan(bw.y).and(bw.x.greaterThan(bw.z))
  const domY = bw.y.greaterThan(bw.x).and(bw.y.greaterThan(bw.z))

  // Per-plane base UV (matches triplanarColor's swizzles) and tangent view dir
  // (.xy = the plane's two world axes, .z = |V·axis| = along the plane normal).
  const SCALE = float(80)
  const uv0 = domX.select(detailPos.yz, domY.select(detailPos.xz, detailPos.xy)).mul(SCALE).toVar()
  const vt  = domX.select(vec3(V.y, V.z, V.x.abs()),
              domY.select(vec3(V.x, V.z, V.y.abs()),
                          vec3(V.x, V.y, V.z.abs()))).toVar()

  // Per-biome height sampled ONCE per step (packed path). Single-map path:
  // drop `sampleHeight` and pass channel:'r'.
  const bwN = biomeW.div(biomeW.x.add(biomeW.y).add(biomeW.z).add(biomeW.w).max(0.001))
  const uvP = parallaxOcclusion({
    heightTex: pomHeightNode, uv: uv0, viewDirTangent: vt,
    scale: uPomDepth, minSteps: 8, maxSteps: 24, lodFade: dNear,
    sampleHeight: (p) => pomHeightNode.sample(p).level(0).dot(bwN),  // packed RGBA · biomeW
  }).toVar()

  // Map the 2D UV correction back to a 3D object-space offset on the dominant
  // plane's two axes (Δpos = Δuv / tileScale) and shift the sample position.
  const duv = uvP.sub(uv0).div(SCALE)
  const off = domX.select(vec3(0, duv.x, duv.y),
              domY.select(vec3(duv.x, 0, duv.y),
                          vec3(duv.x, duv.y, 0)))
  detailPosP.assign(detailPos.add(off))
})

// Then the EXISTING four calls, with detailPos → detailPosP:
const det = triplanarColor(grassTexNode, detailPosP, bw, 80)
  .mul(biomeW.x)
  .add(triplanarColor(rockTexNode, detailPosP, bw, 80).mul(biomeW.y))
  .add(triplanarColor(sandTexNode, detailPosP, bw, 80).mul(biomeW.z))
  .add(triplanarColor(snowTexNode, detailPosP, bw, 80).mul(biomeW.w))
  .toVar()
// … rest of the block (wTot, mult, col.assign…) UNCHANGED.
```

Why a shared positional offset works: the dominant plane's two UV axes ARE two
world axes, so the 2D parallax shift is exactly a 3D offset in those axes; feeding
it to all three planes gives the dominant plane correct parallax while the two
low-weight planes get a harmless small shift (their blend weight is tiny where
they're non-dominant). It also means the **macro** and **cloud-shadow** layers
below keep using the un-shifted `detailPos` (correct — they are mid/far, POM must
not touch them).

### 5.3 normalNode anchor (lines 714–732) — near-detail normal block

Same recipe: inside the existing `If(uNormalOn.greaterThan(0.5).and(dNearNrm.greaterThan(0.003)))`
block, compute the **identical** `detailPosP` (recompute the march — it is a pure
function of the same camera/normal/texture inputs, so color and normal agree) and
change the four `triplanarNormalSample(…, detailPos, …)` calls (lines 721–725) to
`detailPosP`. This gives the perturbed normal the SAME parallax-shifted UV as the
albedo, so relief and shading line up.

- Cost: this is a **second** march (once per material slot). Near-camera only,
  dynamic-branched off at orbit. Budget in §7 risk 1; it is the top cost line.
- Optimization (documented, not required for v1): if profiling on the skim shows
  the second march hurts, drop `maxSteps` to ~16 in the normal slot, or use the
  single shared Rock030 map (one channel) there. The visual delta is minor
  because the normal map already carries most of the high-freq shading.

### 5.4 Optional self-shadow (lines 658–672 + update() lines 877–886)

If wired: add `const uSunDirObj = uniform(new THREE.Vector3())` and, in
`update(dt)`, write it from sky each frame — planet.js already imports from
sky.js and there is a `sky.getSunDir(out)` accessor used across the codebase
(verifykit/ui/storms). Since object space ≡ world, no transform is needed:
`update(dt)` gains `if (sunSource) uSunDirObj.value.copy(sunSource.getSunDir(_scratch))`.
Transform `uSunDirObj` into the dominant plane's tangent frame the same way as
`V`, call `parallaxSoftShadow({ … lightDirTangent, hitDepth, lodFade: dNear })`,
and multiply `col` by the returned visibility inside the near block. Keep it
**off by default** (`uPomShadowOn` uniform, 0 until explicitly enabled) to protect
the both-backend bring-up and the cost budget.

### 5.5 The LOD gate

`lodFade` passed to POM is the **existing** `dNear` (colorNode line 654) /
`dNearNrm` (normalNode line 717): `positionView.length().smoothstep(0.3,1.7).oneMinus()`.
It is 1 at the surface, ramps to 0 by ~1.7 view-units out. POM lives inside the
same `If(dNear > 0.003)` branch, so:
1. **Zero cost at orbit** — the branch isn't taken; the GPU skips all POM fetches
   (coherent per region, so the branch is cheap).
2. **No pop** — `scale.mul(lodFade)` shrinks the parallax depth to 0 across the
   fade band, so relief eases in instead of snapping on.
POM takes `lodFade` as a parameter (not a hard-coded `dNear`) so if E1/the
architect promotes the near-fade to a real `uniform()`, POM binds to it unchanged.

---

## 6. Determinism

POM is a pure function of camera pose, geometry, and static textures — **no RNG,
no `Date.now`, no `uTime`, no per-frame state.** The corrected UV depends only on
`cameraPosition`, `positionView`, `positionGeometry`, `normalLocal`, and the
height texture, so two loads at the same camera pose are **pixel-identical**.

`buildPackedHeightTexture` is deterministic: fixed luminance weights
`[0.299,0.587,0.114]`, a fixed-radius separable box blur, integer texel math —
identical bytes on every machine. **No `Math.random`/`Date.now` anywhere in
`src/pom.js`** (grep-enforced, same guardrail as E1's five new files). E2 adds no
seeds because POM is view-driven presentation, not world state — consistent with
util.js's seed discipline (world geometry stays seeded; the *view* of it is
deterministic-by-construction).

---

## 7. Risks

1. **Cost at grazing angles (top risk).** POM runs the march twice near-camera
   (colorNode + normalNode), up to `maxSteps=24` fetches each, and grazing views
   want the most steps exactly when the most pixels are near. Mitigations, all in
   this spec: (a) **single dominant-plane** march, not 3× triplanar; (b)
   **one fetch/step** (single map, or packed RGBA · biomeW); (c) `maxSteps` capped
   at 24 and a JS literal; (d) `vz = viewDirTangent.z.max(0.15)` clamps the
   grazing UV blow-up (bounded offset, no full-tile smear); (e) `lodFade` shrinks
   both depth and step count toward the fade edge; (f) the whole effect is
   dynamic-branched to zero outside the near band. If the skim still costs too
   much, the escape hatches are `maxSteps→16` in the normal slot and/or a
   `uPomMaxSteps` uniform for a quality slider. MEASURE fps on a full-screen skim
   on both backends before locking `maxSteps`.

2. **Texture availability.** No `_Displacement` maps are local today. Primary =
   re-fetch the four from the already-sourced CC0 sets (+~2–3 MB, update
   SOURCES.md). Fallback = zero-download Color-luminance packed height (lower
   fidelity, flagged). If NEITHER loads, `uPomOn` stays 0 and POM no-ops — the
   ground renders exactly as today (normal maps only), with a single warn — the
   same graceful-degradation contract as `uDetailOn`/`uNormalOn`.

3. **Both-backend WGSL safety.** (a) The march loop's trip count is the JS literal
   `maxSteps` → a WGSL `for` with a static bound (a node/uniform bound would fail
   WGSL compile); runtime early-exit is a `Break()` inside. (b) **All in-loop
   height fetches use explicit LOD** (`heightTex.sample(uv).level(0)`) — implicit
   derivatives inside divergent control flow warn/fail on WGSL; the FINAL
   albedo/normal samples (outside the loop) keep normal mipped+anisotropic
   sampling, unchanged. (c) No `pointUV`, no custom per-instance vertex attributes
   — POM uses only `positionGeometry`/`cameraPosition`/`normalLocal`/
   `attribute('biomeW')`, all already compiling on both backends in the shipped
   material. (d) Dominant-axis choice is `.select()` (branch-free), never dynamic
   texture indexing. (e) Graph is built ONCE — only `uPomOn`/`uPomDepth`/(sun)
   uniforms change per frame, so there is no 187 ms recompile hitch.

4. **Non-dominant-plane shift + triple points.** The shared 3D offset is exact for
   the dominant plane and approximate for the two low-weight planes; near 45°
   triple-points (where no axis dominates) the parallax weakens. Both are
   low-visibility (small blend weight / rare direction) and read as "slightly
   softer relief there," not as artifacts. Acceptable for fake relief.

5. **Silhouette is unchanged.** POM moves the *interior* apparent surface only;
   the mesh's actual edges (planet limb, hill horizons) stay smooth — POM cannot
   add silhouette geometry (that would need real tessellation, which the platform
   lacks). This is correct and expected for a ground skim (no hard object edges in
   frame); do not expect displaced horizons.

6. **Interaction with E1.** E1 rewrites `sampleHeight` to a baked grid and may make
   `createPlanet` async; E2 touches only the terrain *material* (colorNode/
   normalNode) and adds pom.js + a height texture. The two do not overlap in code
   — `detailPos = positionGeometry` is whatever the mesh was displaced to,
   regardless of whether that came from analytic or grid height. Merge order is
   free; if both land, keep E1's async signature and E2's material edits side by
   side. Flag for the architect at integration.

---

## 8. In-browser acceptance checks

- **Relief on skim.** Fly the camera to street level over rocky/grassy ground:
  the surface shows per-pixel bumps that **parallax-shift and occlude** as you
  orbit/translate — near bumps hide far ones; at grazing angle the relief
  elongates and casts interior occlusion. Clearly 3D, not a flat normal-map tilt.
- **Flat + zero-cost at orbit.** Zoom out to orbit: the ground returns to *exactly*
  the pre-E2 look (POM branch off, `dNear→0`), and frame time at orbit is
  unchanged vs. pre-E2 (POM fetches are gone — confirm no fps delta with the
  height map both present and absent).
- **No pop.** Dolly slowly through the `dNear` band (~0.3→1.7 view-units):
  relief eases in/out smoothly; no hard onset frame.
- **`?renderer=webgpu` parity.** Run once WebGL2 (default) and once true WebGPU:
  identical relief; read the console — **ZERO WGSL/TSL compile errors** from the
  terrain material, and no 187 ms per-material recompile hitch (graph built once).
- **Determinism.** Reload the same seed + same camera pose twice → the ground is
  pixel-stable. `grep -nE 'Math\.random|Date\.now' src/pom.js` returns nothing.
- **Graceful degrade.** In devtools, block the `_Displacement` request → `uPomOn`
  stays 0, ground renders as today (normal maps only), exactly one warn logged.
- **Self-shadow (only if wired).** Toggle `uPomShadowOn`: crevices gain soft
  contact shadow from the sun direction; toggling changes shading only, never
  geometry or silhouette; still zero errors on both backends.

---

## 9. buildTasks

Self-contained units. Ship BT-E2-1 → BT-E2-2 → BT-E2-3 for a working single-map
POM; BT-E2-4 and BT-E2-5 are optional upgrades.

### BT-E2-1 — `src/pom.js`: the reusable POM node (+ generation helper)
**produces:** `src/pom.js`

Create `src/pom.js` exporting `parallaxOcclusion({ heightTex, uv, viewDirTangent,
scale, minSteps=8, maxSteps=24, lodFade, channel='r', sampleHeight })` → vec2
corrected UV, implemented as the steep-parallax linear search + one secant step in
§2.2. HARD RULES: the `Loop` trip count is the JS literal `maxSteps` (never a
node/uniform); every in-loop height fetch is explicit-LOD
(`heightTex.sample(uv).level(0)[channel]`, or the `sampleHeight` override);
`vz = viewDirTangent.z.max(0.15)`; step count `mix(maxSteps,minSteps,vz)`; depth
`scale.mul(lodFade)`. Also export `parallaxSoftShadow(…)` (§2.3, 4–6 steps, same
rules, returns [1-strength,1] visibility) and `buildPackedHeightTexture({ sources,
size=512, blur=1, fromColor=false })` (§4, deterministic canvas pack → RGBA
DataTexture, RepeatWrapping/NoColorSpace, no RNG). Import only from `three` /
`three/tsl`. NO `Math.random`/`Date.now` (grep-clean). Confirm the r185 TSL
`Loop`/`Break` spelling and the `viewDirTangent.xy` parallax sign against a quick
visual. Node graph is pure — no per-frame state inside pom.js.

### BT-E2-2 — Heightmap asset(s) + SOURCES.md
**produces:** `public/textures/Rock030_1K-JPG_Displacement.jpg` (+ the other three
`_Displacement` maps if doing the packed upgrade), `public/textures/SOURCES.md`

Re-fetch the `_Displacement` 1K-JPG map(s) from the already-sourced ambientCG sets
(`Rock030` for the single-map ship; add `Grass004`, `Ground080`, `Snow006` for the
packed upgrade). Same CC0 sets, same strip-to-what's-used discipline. Update
`SOURCES.md`: add the `_Displacement` rows to the file table, note they feed E2's
POM height, and update the committed-footprint total. If the +footprint is
declined, SKIP the download and document that E2 uses the zero-download
Color-luminance fallback (`buildPackedHeightTexture({ fromColor:true })`) instead.

### BT-E2-3 — Wire POM into planet.js (single-map, both backends)
**produces:** `src/planet.js`

Add `import { parallaxOcclusion } from './pom.js'`. Add uniforms `uPomOn=uniform(0)`,
`uPomDepth=uniform(0.03)`, and `pomHeightNode = texture(placeholder)`; load
`/textures/Rock030_1K-JPG_Displacement.jpg` in a loader block mirroring the detail-
texture loader (RepeatWrapping, NoColorSpace, anisotropy 8), flipping `uPomOn=1`
on success (graceful warn on failure). In colorNode, inside the existing
`If(uDetailOn… .and(dNear…))` block (lines 658–672), compute `detailPosP` per §5.2
(object-space `V`, dominant-axis `.select()` for `uv0`/`vt`, `parallaxOcclusion`
with `lodFade: dNear`, map Δuv→3D offset) and change the four near `triplanarColor`
calls from `detailPos`→`detailPosP`. In normalNode (lines 718–732) recompute the
identical `detailPosP` and change the four `triplanarNormalSample` calls to
`detailPosP`. Leave macro + cloud-shadow layers on the un-shifted `detailPos`.
VERIFY: skim shows parallax relief; orbit is byte-identical to pre-E2 with no fps
delta; `?renderer=webgpu` renders identically with ZERO console compile errors and
no recompile hitch; blocking the height fetch degrades gracefully.

### BT-E2-4 — (upgrade) Packed per-biome heightmap
**produces:** `src/planet.js` (loader swap), depends on BT-E2-2 four maps

Replace the single-map load with the four `_Displacement` maps →
`buildPackedHeightTexture({ sources })` → `pomHeightNode.value = packed`, and pass
the `sampleHeight: (p) => pomHeightNode.sample(p).level(0).dot(bwN)` override to
`parallaxOcclusion` in both slots (bwN = normalized biomeW). One fetch/step,
per-biome relief. VERIFY relief now varies by biome (rocky vs. sandy vs. snowy
micro-texture) at the same cost; both backends clean.

### BT-E2-5 — (optional) POM self-shadow
**produces:** `src/planet.js` (uniform + update wiring)

Add `uPomShadowOn=uniform(0)` and `uSunDirObj=uniform(new THREE.Vector3())`; in
`update(dt)` copy `sky.getSunDir(_scratch)` into `uSunDirObj` (object space ≡
world). In colorNode's near block, transform `uSunDirObj` into the dominant plane's
tangent frame (as `V`), call `parallaxSoftShadow({ …, lodFade: dNear })`, and
multiply `col` by the returned visibility, all inside `If(uPomShadowOn.greaterThan(0.5))`.
Keep default OFF. VERIFY crevices gain soft sun-direction contact shadow, toggling
is shading-only, both backends stay error-free.
