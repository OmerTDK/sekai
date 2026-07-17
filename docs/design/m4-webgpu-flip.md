# M4 — Flip to the true WebGPU backend

**Wave:** M4 (renderer backend flip) · **three:** 0.185.1 · **Vite:** 8.1.5
**Depends on:** M3 (all `onBeforeCompile`/raw-`ShaderMaterial` ports to TSL are complete)
**Grounding spike:** `docs/spikes/2026-07-17-s1-tsl-webgpu.md` (S1) — the flip already boots a
real `WebGPUBackend` on this machine.
**Status:** design only — do NOT implement from this doc; it is the fan-out spec.

---

## 0. TL;DR

M3 already runs the whole app on `WebGPURenderer` — but pinned to the WebGL2 backend via
`forceWebGL: true`. **M4 is the one-line flip: stop forcing WebGL so the same renderer picks the
real WebGPU backend when the machine has it.** Because every shader is already TSL and the post
chain is already node `PostProcessing`, *no scene code changes*. The entire risk surface is
**parity** (does it look/behave byte-for-byte the same on the WebGPU backend as on WebGL2?) and
**graceful degradation** (machines without WebGPU must still run). This doc specifies: the flip
mechanism, a kept-for-one-milestone `?renderer=webgl` escape hatch, the parity test matrix
(bloom + the >1.0 HDR headroom being the headline), and the TSL/backend constructs that are known
to diverge between the two backends.

---

## 1. Goal + how it looks / behaves

**Goal:** run Sekai on the real WebGPU backend by default, falling back to WebGL2 only when WebGPU
is unavailable, with **zero visible change** to the rendered world.

**How it looks:** identical. The success criterion is *invisibility* — a user (and the verifykit
determinism hash + draw-call count) cannot tell which backend rendered the frame. The sun and the
brightest stars keep their soft bloom halo; the atmosphere rim still glows; oceans, terrain splat,
flora sway, birds, dragon, airships, storms, floods, sea-ice all render exactly as in M3.

**How it behaves:** on boot, `renderer.init()` negotiates the backend. WebGPU present → WebGPU
backend. WebGPU absent (older Chrome, headless CI, `?renderer=webgl`) → WebGL2 backend, same as
M3. One console line reports which backend won, for support triage. Everything downstream
(`await renderer.init()` gating, PMREM capture, the first render, `setAnimationLoop` +
`post.renderAsync()`) is unchanged — it was already written async-first in M3.

**The one behavioral risk worth naming up front:** the WebGPU backend's *first* use of any
pipeline compiles asynchronously (S1 §6: ~140 ms for a structural node build). M3's load-time
material warmup already covers this; M4 must confirm the warmup still runs before the first
*visible* frame on the WebGPU path (not just the WebGL2 path it was tuned on).

---

## 2. Concrete technical approach (grounded in the real 0.185.1 API)

### 2.1 The flip itself

`WebGPURenderer` (exported from `three/webgpu`) already chooses its backend inside `init()`. With
`forceWebGL: true` it constructs a `WebGLBackend` (`three/webgpu` →
`src/renderers/webgl-fallback/WebGLBackend.js`, `this.isWebGLBackend = true`,
`coordinateSystem === WebGLCoordinateSystem`). Drop the flag and it attempts a `WebGPUBackend`
first, falling back to WebGL2 automatically if `navigator.gpu` / adapter request fails. S1 §4
confirmed both outcomes are live on this hardware: `forceWebGL:false` + `init()` →
`backend.isWebGPUBackend === true`.

So the mechanical change is: **stop hard-coding `forceWebGL: true`; make it conditional on the
escape hatch (§2.2).** Everything else — TSL materials, `pass()`, `bloom()`, `PostProcessing`,
`renderAsync()` — is backend-agnostic three code and does not change.

### 2.2 Escape hatch: `?renderer=webgl` → `forceWebGL: true` (kept ONE milestone)

Mirror the existing `?seed=` pattern (`new URLSearchParams(location.search).get('seed')` in
`main.js:25`). Read `?renderer` once, resolve a boolean, pass it to the constructor:

```js
// forceWebGL is true only when explicitly requested; otherwise let init() pick WebGPU,
// which itself falls back to WebGL2 if the machine lacks WebGPU.
const forceWebGL = new URLSearchParams(location.search).get('renderer') === 'webgl'
const renderer = new THREE.WebGPURenderer({ antialias: true, forceWebGL })
```

This gives three tiers: (a) default → WebGPU, auto-fallback to WebGL2; (b) `?renderer=webgl` →
pinned WebGL2 (the M3 host, byte-for-byte); (c) machine with no WebGPU → WebGL2 automatically.
**Lifespan:** the hatch is a *safety net for the flip milestone only*. Delete `?renderer=webgl`
and the `forceWebGL` plumbing at the end of M5 once the WebGPU path has soaked — three's own
built-in WebGPU→WebGL2 auto-fallback already covers machines without WebGPU permanently, so the
manual pin has no long-term job. Record this deletion as an M5 ponytail-debt item.

### 2.3 Why bloom + the >1.0 HDR headroom is backend-independent (the headline parity claim)

The headroom trick relies on the scene pass keeping color values **above 1.0** so bloom's
threshold-1.0 luminance high-pass has something to select. This is not a backend behavior — it is
a render-target *type*, chosen by three at the node level and identical on both backends:

- **`PassNode`'s render target defaults to `HalfFloatType`** — `three` source
  `src/nodes/display/PassNode.js:246`: `new RenderTarget(w, h, { type: HalfFloatType, ...options })`.
  So `pass(scene, camera)` (main.js:115) captures the sun/stars' >1.0 emissive values without
  clamping on *either* backend.
- **`BloomNode`'s internal bright/blur targets are also `HalfFloatType`** —
  `examples/jsm/tsl/display/BloomNode.js:155,163,170` (`RenderTarget(..., { type: HalfFloatType })`).
  The luminance high-pass (`luminosityHighPass`, line 12–15) is `smoothstep(threshold, threshold+
  smoothWidth, luminance(input.rgb))` — with `threshold = 1.0`, only >1.0 pixels bloom. Same node,
  same math, both backends.
- **Tone mapping stays correct through post**: `PostProcessing` applies an implicit output color
  transform (`RenderOutputNode`, `src/nodes/display/RenderOutputNode.js:119` — reads
  `context.toneMapping`, honoring `renderer.toneMapping = ACESFilmicToneMapping` set at main.js:33)
  as the final composite step. `bloom` is added *before* that transform in linear space
  (`post.outputNode = scenePass.add(bloomPass)`, main.js:117), so the additive bloom happens in HDR
  linear and the ACES + sRGB encode happens once at the end — identical node graph on both backends.

**Conclusion:** the sky's deliberate >1.0 headroom (`sky.js:659–660` stars ×1.05–1.35;
`sky.js:773` sun `Color(1.3,1.22,1.05)`) survives the flip because HalfFloat + threshold-1.0 +
node tone-map are three-level constructs, not backend features. **This is a claim to *verify*, not
assume** (§4) — half-float *linear filtering* and MSAA resolve are the two places a backend can
still differ.

### 2.4 TSL / backend constructs that CAN diverge between WebGL2 and WebGPU

Grounded in the two backend sources; these are the real watch-items:

1. **Coordinate system / NDC depth range.** `WebGLBackend.coordinateSystem === WebGLCoordinateSystem`
   (z ∈ [-1,1]); `WebGPUBackend` uses `WebGPUCoordinateSystem` (z ∈ [0,1]) —
   `WebGLBackend.js:304`. TSL's built-in projection nodes handle this transparently, but **any
   hand-authored clip-space / NDC / raw-depth math** in a ported shader will read differently.
   Audit target: anything using `positionNDC`, custom depth comparisons, or `viewZ`↔depth
   conversions (fog, soft particles, depth-fade in floods/ocean/storms).
2. **Half-float linear filtering.** WebGL2 needs `OES_texture_float_linear`
   (`WebGLBackend.js:262` requests it) to linearly sample the HalfFloat bloom/pass targets; on a
   backend where it's unavailable, blur reads as nearest → subtly blockier bloom. WebGPU filters
   `rgba16float` natively. Parity check: compare bloom softness at a fixed sun viewpoint.
3. **MSAA resolve.** `antialias: true` → 4 samples default on both, but the resolve paths differ
   (WebGL uses `WEBGL_multisampled_render_to_texture` / blit, `WebGLBackend.js:390`; WebGPU uses
   native multisample resolve). Edge AA on terrain silhouettes and thin geometry (labels, banner
   poles, airship rigging) is the thing to eyeball.
4. **Precision.** WebGL2 GLSL defaults can land at `mediump` for some varyings; WGSL is `f32`
   throughout. Watch banding in the atmosphere fresnel gradient and the ocean depth falloff.
5. **`renderer.backend.gl` disappears.** The verifykit's *synchronous* pixel readback path
   (S1 §9: `candidate.backend.gl.readPixels(...)`) exists **only** on the WebGL backend
   (`WebGLBackend.getContext()`, line 457). On the WebGPU backend there is no `.gl`; readback must
   use the async `readRenderTargetPixelsAsync` (which S1 §9 flagged as hanging under *WebGL2*-backed
   Chrome, but is the correct path under a *real* WebGPU device). This is a tooling parity item, not
   a visual one.
6. **`toDataURL` canvas screenshot.** Already best-effort/swallowed (`verifykit.js:250`); WebGPU
   composites off the default drawing buffer, so it stays null on the WebGPU path — expected, not a
   regression. Draw-calls + determinism hash remain the load-bearing verification signals.

---

## 3. New / changed files + module contracts

M4 is deliberately tiny in `src/` — the whole point of M3 was to front-load the shader work so the
flip is nearly a no-op. **Do not touch scene/material code.**

### 3.1 `src/main.js` (changed — the only required src edit)

- **Line 30 → conditional `forceWebGL`** per §2.2. New local `forceWebGL` derived from
  `?renderer`. Constructor: `new THREE.WebGPURenderer({ antialias: true, forceWebGL })`.
- **After `await renderer.init()` (line 35)** — add a single backend-report line:
  ```js
  const backendName = renderer.backend?.isWebGPUBackend ? 'webgpu' : 'webgl2'
  console.info(`[sekai] renderer backend: ${backendName}${forceWebGL ? ' (forced)' : ''}`)
  ```
  Also expose on the dev handle: `window.__planet.backend = backendName` (extend the object at
  main.js:143). Cheap, and it makes the parity harness assertible.
- **Nothing else in main.js changes** — `PostProcessing`, `pass`, `bloom`, the update loop, and
  `post.renderAsync()` are all backend-agnostic.

**Contract:** the boot sequence, the exported `window.__planet` shape, and the `setAnimationLoop`
signature are unchanged except for the added `backend` string field.

### 3.2 `src/verifykit.js` (changed — parity-aware readback)

- **`sweep()` return** gains `backend: renderer.backend?.isWebGPUBackend ? 'webgpu' : 'webgl2'`
  so a sweep result records which backend produced its hash/draw-calls/fps.
- **Guard any `.backend.gl` synchronous readback** behind `isWebGLBackend`; on WebGPU either skip
  pixel readback (keep draw-calls + hash as the signal) or route through
  `renderer.readRenderTargetPixelsAsync` from a `RenderTarget`. **Contract preserved:**
  `{ shots, drawCalls, fps, determinismHash, fallbacks, backend }` — additive only.

### 3.3 `docs/verification/m4-parity.md` (new — test protocol, doc not code)

The parity matrix of §4 written as a runnable checklist (two-backend A/B via `?renderer=webgl`).
Not shipped code; lives in docs.

### 3.4 Explicitly NOT changed

`planet.js`, `sky.js`, `world.js`, `flora.js`, `birds.js`, `dragon.js`, `airships.js`, `storms.js`,
`flood.js`, `seaice.js`, `sealife.js`, `weather.js`, `trails.js`, `assets.js`, `env.js` — all TSL
already, all backend-agnostic. If the flip reveals a *visual* divergence in one of these, that is a
**§4 finding to be fixed in a follow-up task**, not part of the flip edit.

---

## 4. Parity test protocol (what to test, and how)

**Method:** the `?renderer=webgl` hatch *is* the A/B rig. Load the same seed twice —
`?seed=aetherion-1&renderer=webgl` (WebGL2 baseline, == M3) and `?seed=aetherion-1` (WebGPU) — and
compare. Determinism is sacred, so both runs share identical world state; any pixel difference is
purely a backend rendering difference.

| # | Parity check | How to verify | Pass criterion |
|---|---|---|---|
| P1 | **Draw calls unchanged** | `verify.sweep().drawCalls` on both backends | Identical, still 54 |
| P2 | **Determinism hash unchanged** | `verify.sweep().determinismHash` both backends | Byte-identical (world state is backend-independent by covenant) |
| P3 | **Bloom present on sun** | `orbit`/sun viewpoint, both backends, side-by-side | Sun halo visually matches; no clamp/loss on WebGPU |
| P4 | **>1.0 HDR headroom alive** | Star-field night viewpoint; brightest stars (`sky.js` ×1.05–1.35) | Brightest stars bloom on WebGPU exactly as WebGL2 |
| P5 | **Bloom softness (half-float linear filter)** | Fixed sun frame, zoom on halo gradient | No blockiness on WebGPU vs WebGL2 |
| P6 | **Tone mapping identical** | Mid-coast daylit frame | ACES look matches; no double/no tone-map |
| P7 | **MSAA edge AA** | Terrain silhouette + banner poles + airship rigging | Edge quality comparable |
| P8 | **Depth-fade correctness (NDC)** | Ocean shoreline depth falloff, flood edges, storm volume | No z-range artifact on WebGPU |
| P9 | **No first-frame compile hitch** | Cold load on WebGPU, watch first visible frame | Warmup covers it; no ~140 ms stall visible |
| P10 | **Fallback works** | Force no-WebGPU (or CI headless) | Auto-lands on WebGL2, boots, renders |
| P11 | **fps within budget** | `verify.sweep().fps` on WebGPU at real scene scale | Frame time inside the ~11 ms M5-Pro budget headroom |

**Automation:** drive P1/P2/P11 headlessly via `window.__planet.verify.sweep()` and
`window.__planet.backend` in Chrome (claude-in-chrome). P3–P8 need a human eyeball on the A/B pair
(the S1 spike's §9 warns pixel readback is unreliable under WebGL2-backed Chrome, so the visual
checks are deliberately kept manual). Capture the A/B into `docs/verification/m4-parity.md`.

---

## 5. Determinism + covenant + performance

- **Determinism (sacred):** the flip touches *rendering only*. World state derives from
  seed + session/git data (no `Math.random`/`Date.now` in state) and is computed identically
  regardless of backend — hence P2 must be byte-identical across backends. **No new entropy is
  introduced by M4**; the backend choice is deterministic given the machine's WebGPU support and the
  `?renderer` param, and the choice never feeds world state.
- **Covenant (never destroy/move session structures):** M4 is renderer plumbing; it does not touch
  placement, `world.js`, or any structure lifecycle. The covenant is untouched by construction —
  and P2's hash equality is the standing proof that structures are unmoved.
- **Performance (target: 54 draw calls, ~11 ms headroom on M5 Pro):**
  - Draw calls **must stay 54** — the flip changes the backend, not the scene graph or the post
    chain (P1 guards this).
  - The WebGPU backend generally *reduces* CPU command-submission cost at real scene scale relative
    to WebGL2 (S1 §6 explicitly frames its high forceWebGL micro-timing as submit-bound overhead
    that "amortizes under real GPU-bound loads"). Expect frame time to hold or improve; P11 confirms
    against the ~11 ms budget at true scene scale — **do not trust the S1 micro-numbers**, profile
    the real app.
  - **Node-recompile hitch (S1 §6, the one real perf watch-item):** never swap node structure per
    frame; animate only via `uniform()` writes (already the app's discipline). M4 adds nothing that
    recompiles. The only concern is that the WebGPU backend's *first* pipeline build for each
    material is async ~140 ms — **P9 must confirm M3's load-time warmup render runs on the WebGPU
    path before the first visible frame.** If warmup was only ever exercised on WebGL2, extend it to
    an awaited `renderer.compileAsync(scene, camera)` (or one off-screen `await post.renderAsync()`)
    during load, before revealing the canvas.

---

## 6. Build-task breakdown (ordered, fan-out-ready)

Small wave — the surface is intentionally minimal. Tasks T1–T3 are independent-ish (T2/T3 read T1's
`backend` field but can be built against the contract in parallel); T4–T5 are verification.

- **T1 — `src/main.js`: the flip + escape hatch + backend report.**
  Conditional `forceWebGL` from `?renderer=webgl`; backend-name console line; `window.__planet.backend`.
  (§3.1) — *the load-bearing edit; one file.*
- **T2 — `src/main.js` (or a tiny `src/warmup.js` helper): guarantee WebGPU-path first-frame warmup.**
  Ensure an awaited `compileAsync`/off-screen `renderAsync` runs before the first visible frame on
  the WebGPU backend (§5, P9). Can be folded into T1 if the reviewer prefers one main.js edit.
- **T3 — `src/verifykit.js`: parity-aware readback + `backend` in sweep result.**
  Guard `.backend.gl` behind `isWebGLBackend`; add `backend` to the `sweep()` return. (§3.2)
- **T4 — `docs/verification/m4-parity.md`: the P1–P11 protocol as a runnable A/B checklist.** (§3.3, §4)
- **T5 — Execute the parity sweep** (claude-in-chrome): run both `?renderer=webgl` and default,
  fill the P1–P11 results, attach the A/B captures, sign off GO/NO-GO. Depends on T1–T4.

---

## 7. Risks + fallback

| Risk | Likelihood | Mitigation / fallback |
|---|---|---|
| **A ported TSL shader looks subtly different on WebGPU** (NDC depth, precision, half-float filter, MSAA) — §2.4 items 1–4 | Medium — this is *the* M4 risk | Caught by P3–P8. Fix the specific node (e.g. clamp a depth-fade, force a filter, bump precision). **Fallback: keep `?renderer=webgl` as the shippable default until the divergence is fixed** — the app is fully functional on WebGL2, so a parity bug delays the *default*, never the release. |
| WebGPU first-frame ~140 ms compile stalls the reveal | Low (warmup exists) | P9 + T2 awaited warmup before canvas reveal. |
| Auto-fallback to WebGL2 fails to boot on some machine | Low | P10; `?renderer=webgl` forces the known-good M3 host. |
| Verifykit readback breaks on WebGPU (no `.gl`) | Medium (tooling only) | T3 guards it; draw-calls + determinism hash remain the load-bearing signals, both backend-independent. |
| fps regresses at real scale on some GPU | Low (backend usually helps) | P11; if it regresses, `?renderer=webgl` is the escape valve while profiling. |

**Overall fallback posture:** M4 is *reversible by a URL param*. Because the WebGL2 host (M3) and
the WebGPU backend run the identical TSL/node code, the escape hatch is not a degraded mode — it is
the M3 baseline. If WebGPU parity is not clean, ship with WebGL2 as the effective default
(default-boot still *attempts* WebGPU for machines where it's clean) and burn down the P3–P8
findings before removing the hatch in M5. The flip cannot block the release; at worst it slips the
*default backend*.

---

## 8. Single biggest risk

**A ported TSL shader that rendered correctly on the WebGL2 backend renders *subtly wrong* on the
real WebGPU backend** — most likely via the NDC depth-range difference (§2.4 #1) hitting a
depth-fade, or half-float linear-filtering / MSAA-resolve differences softening bloom or edges
differently. It is insidious because M3 signed off *only* on WebGL2, so these divergences are
literally untested until the flip. The entire P3–P8 visual A/B protocol exists to surface it, and
the `?renderer=webgl` hatch exists so that finding one delays the default, never the ship.
