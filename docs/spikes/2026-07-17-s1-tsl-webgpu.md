# S1 — TSL / WebGPURenderer(forceWebGL) host: design + provisional read

**Date:** 2026-07-17 · **Wave:** M3 (renderer migration) · **three:** 0.185.1 · **Vite:** 8.1.5
**Spike page (local, gitignored):** `spikes/s1-tsl/index.html` → served at `/spikes/s1-tsl/index.html`
**Author:** S1 spike builder · **Status:** provisional read; FINAL GO/NO-GO is the architect's call after running the page in Chrome.

> This doc records the mechanism design and a **provisional GO**. It was exercised end-to-end in an
> automated Chrome (via the browser extension) and every hard question below returned real data —
> but the architect should still load the page interactively to eyeball visual quality and to sanity
> the fps story in the real app. The verdict logic and all numbers here come from `window.__S1`.

---

## 1. The decision this settles

The rejected path (`WebGLRenderer` + `WebGLNodesHandler` bridge) forbids **shared instanced-mesh geometry**
and `compile()` — fatal for us, since the app is built on `BatchedMesh` and many `InstancedMesh` with
per-instance custom attributes. The candidate path is to adopt **`WebGPURenderer({ forceWebGL: true })`**
(from `three/webgpu`) as the incremental host: it runs TSL `NodeMaterial`s on a WebGL2 backend today, and
the eventual "flip to WebGPU" is just deleting `forceWebGL: true`.

**The spike proves the candidate host works for our three hardest geometry cases.**

---

## 2. Mechanism finding (the forceWebGL host path)

- `new WebGPURenderer({ forceWebGL: true })` → after `await renderer.init()`,
  `renderer.backend.isWebGPUBackend === false` and `renderer.backend.constructor.name === "WebGLBackend"`.
  **Confirmed:** forceWebGL yields a real WebGL2 backend, exactly the incremental host we want.
- **The flip works in principle here too:** `new WebGPURenderer({ forceWebGL: false })` + `init()` booted a
  **`WebGPUBackend` (`isWebGPUBackend === true`) in this environment.** So dropping `forceWebGL` is a live
  path on this machine. (On CI/headless Chromes that lack WebGPU this will simply not boot — that is data,
  not a failure; the forceWebGL host is unaffected either way.)
- **Dual-build reality (important):** the classic `onBeforeCompile` / `ShaderChunk` / `#include` machinery is
  **NOT present in `three/webgpu`**. So the baseline (today's app) imports from `three`, and the candidate
  imports from `three/webgpu` + `three/tsl`. Under `WebGPURenderer`, `onBeforeCompile` is simply **ignored** —
  a material with an `onBeforeCompile` customization renders as its **base, uncustomized** form (no error,
  silent loss of the effect). **Implication for M3: every one of the ~31 `onBeforeCompile` sites + ~5 raw
  `ShaderMaterial`s must be ported to TSL before it renders correctly. You cannot run half onBeforeCompile /
  half TSL inside one `WebGPURenderer`.**

---

## 3. Exact TSL import surface that resolved under Vite

These are the literal lines that resolved and ran (three 0.185.1, Vite 8.1.5):

```js
// baseline (classic WebGLRenderer + onBeforeCompile) — the app's current world
import * as THREE from 'three'

// candidate host + node materials
import * as GPU from 'three/webgpu'
//   GPU.WebGPURenderer, GPU.MeshStandardNodeMaterial, GPU.MeshBasicNodeMaterial,
//   GPU.PostProcessing, GPU.InstancedMesh, GPU.BatchedMesh, GPU.RenderTarget,
//   GPU.ACESFilmicToneMapping, GPU.Scene/Mesh/…  (three/webgpu is a superset of core)

// TSL operators / node factories
import { attribute, positionGeometry, positionLocal, normalLocal, uniform, color, float, vec3 } from 'three/tsl'
```

Resolution is via `three`'s package `exports`: `"./webgpu" → build/three.webgpu.js`,
`"./tsl" → build/three.tsl.js`, `"./addons/*" → examples/jsm/*`. No Vite alias or config change needed.
Note `three/webgpu` and plain `three` are **separate module instances** — never pass a geometry/material
built by one into the other (`instanceof` differs). Each renderer builds its own scene.

---

## 4. Results (from `window.__S1`, observed in Chrome)

| Question                                                      | Result                                                             |
| ------------------------------------------------------------ | ------------------------------------------------------------------ |
| `backend.isWebGPUBackend` under forceWebGL:true              | **`false` (WebGLBackend)** — WebGL2 backend confirmed              |
| **Case A** — welded sphere, per-fragment noise + vtx displace | **Renders under candidate** (TSL `colorNode`+`positionNode`)       |
| **Case B (CRUX)** — InstancedMesh per-instance attr → vtx sway | **per-instance attribute WORKS** (see §5)                          |
| **Case C** — BatchedMesh + NodeMaterial                       | **Renders under candidate, no error** (per-instance color honored) |
| Flip test — `forceWebGL:false` boots WebGPU here             | **Yes** (`WebGPUBackend`, `isWebGPUBackend:true`)                  |
| Post-processing (EffectComposer/UnrealBloom)                 | Not supported under WebGPURenderer — node replacement in §7        |

**fps (submit-bound micro-timing, ADVISORY only — see §6):** ms/frame baseline → candidate:
A `0.010 → 0.048`, B `0.009 → 0.045`, C `0.018 → 0.065`.
**Rebuild hitch:** candidate node-recompile spike **≈ 138–142 ms** (steady ≈ 0); baseline GLSL relink ≈ 0 ms.

**Provisional verdict: GO.** Every mechanism gate passes (WebGL2 backend; per-instance attributes correct;
BatchedMesh supported). The one real watch-item is the node-recompile hitch (§6).

---

## 5. The crux, proven (Case B — per-instance attribute → vertex sway)

This is the case the rejected bridge could not do. The TSL port of `flora.js`'s tree-sway recipe:

```js
const mat = new GPU.MeshStandardNodeMaterial({ color: 0x6f9d55, roughness: 0.9, metalness: 0 })
const uTime = uniform(0) // advance uTime.value each frame — mirrors the app's captured shader.uniforms.uTime
const phase = attribute('phase', 'float') // reads the per-instance InstancedBufferAttribute
const swayT = positionGeometry.y.div(CONE_H).clamp(0, 1)
const wob = uTime.mul(1.1).add(phase).sin().mul(SWAY_AMP)
mat.positionNode = positionGeometry.add(vec3(swayT.mul(swayT).mul(wob), 0, 0))
// instanceMatrix is applied by the renderer AFTER positionNode, so output local (pre-instance) space.
```

**How it was proven (airtight, not eyeballed):** a **zero-phase discriminator**. At a fixed `uTime`, render
→ hash; then set every `phase` value to 0 (`attr.array.fill(0); attr.needsUpdate = true`) → render → hash;
then restore. Result: `zeroingChangedImage === true` **and** `restoreReverted === true`. Zeroing the
per-instance attribute changes the rendered image and restoring it reverts exactly — so the attribute is
genuinely **read per-instance**, not defaulted. `perInstanceAttrWorks: true`.

> Caveat recorded in the data: the naive "render at two `uTime` values and compare" check reads **false** for
> a large random-phase field — the aggregate silhouette of 10 000 randomly-phased cones is statistically
> time-invariant (law of large numbers). That is why the discriminator (which breaks the symmetry) is the
> authoritative test, and why `window.__S1.caseB.swayAnimatesUnderCandidate` may show `false` while
> `perInstanceAttrWorks` is `true`. Not a failure.

---

## 6. Performance read (honest framing)

**The fps numbers are submit-bound micro-timing and are ADVISORY, not a verdict gate.** They are N
back-to-back `render()` calls timed with `performance.now()` at a fixed 900×560 size. At spike scale the
GPU keeps up trivially, so what's measured is **CPU command-submission cost**, where `WebGPURenderer` has a
higher fixed per-call overhead than `WebGLRenderer` (hence the large deltas on sub-0.1 ms frames). That
overhead **amortizes** under real GPU-bound loads. **Do not read the raw delta% as the real-app gap** —
profile fps in the actual app/scene before trusting it. (The verdict therefore gates on _mechanism_, not on
these deltas.)

**The rebuild hitch is the one number that matters here, and it is real:** structurally changing a node
graph mid-run (reassigning `colorNode`/`positionNode`, or `material.needsUpdate = true`) triggers a
**~140 ms** async node/pipeline recompile — measured via awaited `renderAsync` so the async compile is
included. That is ~8 frames at 60 fps. **M3/M4 guidance: build every node graph once, up front; never swap
node structure per frame; animate exclusively through `uniform()` value writes** (as `flora`/`birds`/ocean
already do with `uTime`). Warm every material with one off-screen render during load so the first visible
frame never pays compile cost.

---

## 7. M4 post-processing replacement (exact API)

`EffectComposer` / `RenderPass` / `UnrealBloomPass` / `OutputPass` are `WebGLRenderer`-only and **do not run
under `WebGPURenderer`.** The node-based replacement (all present in this install; `bloom` verified in
`three/examples/jsm/tsl/display/BloomNode.js`, `PostProcessing` exported from `three/webgpu`):

```js
import { PostProcessing } from 'three/webgpu'
import { pass, mrt, output, emissive } from 'three/tsl'
import { bloom } from 'three/addons/tsl/display/BloomNode.js'

const post = new PostProcessing(renderer)
const scenePass = pass(scene, camera)
const scene = scenePass.getTextureNode()
// current app uses UnrealBloomPass(vec2, 0.3, 0.7, 1.0) → strength 0.3, radius 0.7, threshold 1.0
const bloomPass = bloom(scene, 0.3, 0.7, 1.0)
post.outputNode = scene.add(bloomPass) // additive composite; tone mapping via renderer.toneMapping

// per frame, replacing composer.render():
post.renderAsync()
```

**Selective / emissive-only bloom (sun, rim, emissives — matches today's intent):** use an MRT emissive pass:

```js
scenePass.setMRT(mrt({ output, emissive }))
const bloomPass = bloom(scenePass.getTextureNode('emissive'), 0.3, 0.7, 1.0)
post.outputNode = scenePass.getTextureNode().add(bloomPass)
```

`OutputPass`'s tone-map/sRGB step is handled by the renderer's output transform (`renderer.toneMapping`
still applies through `PostProcessing`); no separate pass needed.

---

## 8. Porting gotchas (onBeforeCompile → TSL) — M3 builder guidance

1. **Per-instance attributes:** `attribute('name', 'float' | 'vec3')` reads an `InstancedBufferAttribute`
   directly. Confirmed for `flora` (`phase`, `treePhase`) and `birds` (`flapWave`/`flapCycle` vec3s, plus the
   per-vertex `wingSide`). This is the whole reason the candidate host clears the bar.
2. **Vertex displacement:** `material.positionNode = positionGeometry.add(displacement)`. Output is
   **local, pre-instance** space; the renderer applies `instanceMatrix` after. Use `positionGeometry` (raw
   geometry position) where the GLSL used `position` (e.g. the sway height factor `position.y`).
3. **Per-fragment color:** `material.colorNode = <node>` replaces base albedo; lighting still applies —
   the direct analog of writing `diffuseColor.rgb` in a `<color_fragment>` injection.
4. **Animate via uniforms, never node swaps.** `const u = uniform(0); u.value = t` each frame mirrors the
   app's captured `shader.uniforms.uTime`. Structural node changes cost the ~140 ms recompile (§6). There is
   no direct `customProgramCacheKey` analog — node materials cache by graph structure, so keep graphs static.
5. **Constructor options carry over:** `MeshStandardNodeMaterial({ vertexColors, flatShading, side,
   transparent, opacity, roughness, metalness, map, … })` all accepted — the app's material configs port
   as-is; only the shader customization moves from string injection to node composition.
6. **Terrain (planet.js) splat chain:** the many `#include` injection points (`<common>`, `<color_fragment>`,
   `<normal_fragment_maps>`, `<roughnessmap_fragment>`, …) become **node composition**, not string surgery.
   Use `texture(tex, uv)` nodes for the triplanar samples and `mx_noise_float(pos.mul(freq))` for fbm-like
   noise (real gradient-noise node; the spike used matched sine-noise only to keep the A/B fps comparison
   fair). Normal-map perturbation → `normalNode`. Build-time vertex displacement (the icosahedron bake) stays
   build-time and is unchanged.
7. **Ocean swell:** `positionNode = positionGeometry.add(normalLocal.mul(swell))`; the fresnel/depth fragment
   → `colorNode` using `positionWorld` + `cameraPosition` nodes.
8. **BatchedMesh:** renders under the candidate with `MeshStandardNodeMaterial`; per-instance `setColorAt`
   is honored. **Gotcha (reconfirmed loudly):** `BatchedMesh` requires **consistent indexing across all
   added geometries** — mixing indexed (Box/Cylinder) with non-indexed polyhedra (Icosahedron/Dodecahedron)
   throws `"All geometries must consistently have index"`. `assets.js` already normalizes this before merge;
   keep doing so.
9. **Silent-degradation trap:** because un-ported `onBeforeCompile` materials render as their base form with
   **no error** under `WebGPURenderer`, the M3 "everything still looks right" check must be **visual**, not
   just "it runs." A missing port looks like a flat/undecorated surface, not a crash.

---

## 9. Tooling gotchas hit while building the spike (so M3 doesn't relearn them)

- **`WebGPURenderer.readRenderTargetPixelsAsync` does not resolve in this WebGL2-backed Chrome** — it hangs
  indefinitely (even with rAF live). Its signature also differs from `WebGLRenderer.readRenderTargetPixels`
  (it takes **no** output buffer and **returns** the pixels; passing a buffer throws "Invalid value used as
  weak map key"). For any tooling/test that needs a candidate pixel readback, use the **synchronous** path:
  `candidate.backend.gl.readPixels(...)` from a `RenderTarget`'s framebuffer, which `render()` leaves bound.
  Direct canvas readback fails (`preserveDrawingBuffer:false` and WebGPURenderer composites elsewhere).
- **fps must be self-measured with back-to-back `render()` + `performance.now()`, never rAF** — a
  backgrounded tab suspends rAF. Warm up first so first-frame compile never pollutes steady state.

---

## 10. Provisional recommendation

**GO (provisional).** Criteria and how each landed:

| Criterion                                                   | Result                        |
| ----------------------------------------------------------- | ----------------------------- |
| forceWebGL yields a WebGL2 backend (incremental host holds) | **PASS** (`WebGLBackend`)     |
| Per-instance attributes correct (the crux)                  | **PASS** (zero-phase proof)   |
| BatchedMesh + NodeMaterial supported                        | **PASS** (renders, no error)  |
| Candidate fps within 10% of baseline                        | **N/A here** — advisory (§6)  |
| Rebuild hitch acceptable                                    | **WATCH** — ~140 ms (§6)      |

The mechanism is sound and the migration is unblocked from a capability standpoint. The two things that are
**not** settled by this spike and need the architect's attention: (1) **real-app fps** (the micro-timing here
is submit-bound and unrepresentative — profile the ported scene), and (2) a **plan for the ~140 ms node
recompile hitch** (precompile/warm all materials at load; forbid per-frame node-structure changes).

**FINAL GO/NO-GO is the architect's call** after loading `spikes/s1-tsl/index.html` in Chrome, reading
`window.__S1`, and confirming the side-by-side visual quality. `window.__S1` keys: `meta`, `imports`,
`backend`, `caseA`, `caseB` (incl. `motionDetail.discriminator`), `caseC`, `rebuildHitch`, `flip`, `postFX`,
`summary`. A `window.__S1kit` handle (renderers, scenes, namespaces) is also exposed for interactive poking.
