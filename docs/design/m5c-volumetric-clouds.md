# M5c — Volumetric Clouds + Volumetric Hurricane

**Wave:** M5 · **three:** 0.185.1 · **Host:** `WebGPURenderer({ forceWebGL: true })` (WebGL2 backend; M4 flip to true WebGPU imminent) · **Status:** design spec (do not implement from this doc without architect sign-off on the perf gate in §7).

Grounding sources cited inline: the S1 TSL spike (`docs/spikes/2026-07-17-s1-tsl-webgpu.md`), `docs/ART.md §2.5/§5`, and the real 0.185.1 API surface verified in `node_modules/three` (symbol-existence greps + `examples/jsm/tsl/display/GodraysNode.js`, which is the canonical screen-space-raymarch-in-a-post-node pattern this design copies).

---

## 1. Goal — how it looks & behaves

Replace the two 2.5D cloud shells (`src/sky.js` `createClouds`: `lowerMesh` R=1.075, `upperMesh` R=1.09, alpha-mapped `SphereGeometry` billboards faking thickness with a toward-sun offset alpha sample) with **genuinely raymarched volumetric clouds** occupying a spherical atmosphere shell `[Rin=1.075 … Rout=1.11]` (Rout stays under the atmosphere rim at 1.11, per ART.md §3 rebasing). And promote the hurricane (`src/storms.js`) from a flat spinning alpha patch to a **true rotating 3D density feature** — an eye/eyewall/log-spiral column embedded in the same volume, so its overshooting-top casts real self-shadow and its eye is a real hole you can see the ocean through.

**Look (ART.md §5, binding):**
- Structure over blobs — coverage still domain-warped fbm banded into an equatorial belt + mid-latitude storm tracks; the volume adds vertical relief (flat cumulus bases, cauliflower tops, wispy eroded edges) the shells can't fake.
- Stylized-but-realistic, white-dominant, **never glowing** (ART.md §2.4: ambient decks must never glow). Silver-blue self-shadow tint `#b9c4d4` reused from the current shell shading.
- **Ambient coverage cut ~70%:** current calibrated lower 0.20 / upper 0.09 (≈0.29 combined) drops to a **~0.09 combined target** (`targetCoverage` lower ≈0.07, cirrus band ≈0.03). Rationale: a raymarched deck at 0.29 reads as an oppressive overcast and murders the framerate (density = march cost); ART.md §5's "sparse beats dense" plus the hero-hurricane doctrine wants near-clear ambient skies so the storm is the sky's hero object.
- The hurricane is the one dense feature: dense white overshoot, dark eye, bright eyewall ring, ragged log-spiral feeder bands — the ISS-photo look storms.js already targets, now with parallax and self-shadow.

**Behaves:** clouds drift (same slow seeded rotation as today), fade out on approach so the civ layer is never fogged at ground level (ART.md §5 fade rule: full at 2.4R → thin by 1.35R; hurricane gone by 1.6R), and the hurricane spins + drifts + spins-up/dissipates exactly as its lifecycle already dictates — the volume just reads its existing per-frame state.

---

## 2. Technical approach (grounded in the real 0.185.1 TSL/WebGPU API)

### 2.1 Architecture: a custom post-process raymarch node (the GodraysNode pattern)

The clouds are **one screen-space raymarch pass** inserted into the existing `PostProcessing` chain in `main.js`, not scene geometry. This is the exact shape of `three/addons/tsl/display/GodraysNode.js` (read end-to-end for this spec):

- A `class CloudsNode extends TempNode` (import `TempNode`, `NodeMaterial`, `QuadMesh`, `RenderTarget`, `RendererUtils` from `three/webgpu`).
- Owns a **quarter-res `RenderTarget`** (`this.resolutionScale = 0.5` → half per axis = quarter pixels; GodraysNode uses exactly this field and `setSize()` rounds `resolutionScale * drawingBufferSize`). `{ depthBuffer: false }`.
- `updateBefore(frame)` (with `this.updateBeforeType = NodeUpdateType.FRAME`) does the save/restore dance — `RendererUtils.resetRendererState` → `renderer.setRenderTarget(rt)` → `_quadMesh.render(renderer)` → `RendererUtils.restoreRendererState` — verbatim from GodraysNode's `updateBefore`. This is the **single extra draw call** the feature adds at quarter-res.
- `getTextureNode()` returns `passTexture(this, rt.texture)` (verified export `passTexture` in `three.tsl.js`) for compositing.
- `setup(builder)` builds the march as a `Fn(() => { … })` assigned to `this._material.fragmentNode` — build ONCE (S1 spike §6: structural node graphs cost a ~140 ms recompile; animate only through `uniform()` writes, never node swaps).

### 2.2 The march (verified TSL primitives — all present in `three.tsl.js`)

Per screen pixel of the quarter-res target:

1. **Reconstruct the world-space view ray from the beauty pass's depth** so clouds correctly occlude behind the planet limb, airships, and the dragon — no separate depth sort, the depth buffer does it. GodraysNode's exact recipe: `depth = depthNode.sample(uv).r` → `getViewPosition(uv, depth, cameraProjectionMatrixInverse)` → `cameraMatrixWorld.mul(viewPosition)` = world hit point; ray dir = `normalize(worldHit − cameraPosition)`, `tMax = distance(camera, worldHit)`. (`getViewPosition`, `passTexture`, `screenCoordinate`, `interleavedGradientNoise` all verified present.)
2. **Ray/shell intersection (analytic, no march to find entry):** two ray-vs-sphere solves against `Rin` and `Rout` (planet centered at origin, radius 1) give `[tNear, tFar]` inside the cloud shell; clamp `tFar` to the depth `tMax` (planet/geometry occlusion). If the segment is empty → early-out `vec4(0)`. This is the empty-space skip that makes an ~all-clear sky nearly free.
3. **Fixed step cap:** `const STEPS = 32` primary samples across `[tNear,tFar]` (uniform-capped — **under forceWebGL, `Loop(n, …)` compiles to a bounded/unrolled GLSL loop; the count MUST be a compile-time constant or a capped uniform**, never data-dependent). `Loop(STEPS, ({ i }) => { … })` with an `If(transmittance.lessThan(0.01), () => { Break() })` early terminate (`Loop`/`Break`/`If` all verified). Adaptive: bigger `tFar−tNear` (grazing the limb) → larger step, capped.
4. **Blue-noise temporal jitter** on the ray start offset to hide banding at 32 steps: `interleavedGradientNoise(screenCoordinate.add(uFrameJitter))` where `uFrameJitter` is a per-frame seeded scalar uniform (see §4 — must be a benign dither, not world state). This is the same jitter GodraysNode imports.
5. **Density sample** at each step's world position `p` (see §2.3).
6. **Lighting:** cheap **Beer–Powder** — instead of a nested light-march (too costly under WebGL2), take **≤6 short steps toward `sunDir`** accumulating density → `lightTransmittance = exp(−σ·d)`; combine with a powder term for the dark-edge look. Sun colour/intensity from `sky.getSunDir()` + the existing sun uniforms. Ambient = hemisphere tint. Front-to-back accumulate colour·(1−T) and `T *= exp(−σ·stepLen)`.
7. Output `vec4(scatteredColor, 1−T)` (premultiplied optional).

### 2.3 Density field — weather-map driven, hurricane-injected

`densityAt(p)` where `p` is a world point in the shell:
- `dir = normalize(p)`, `h = (length(p) − Rin) / (Rout − Rin)` ∈ [0,1] (height in shell).
- **Coverage** from a **2D equirect weather map** sampled at `dir` (same acos/atan2 → uv projection sky.js documents in `getCloudShadowUniforms`). This map is the SAME per-seed coverage field `makeCloudTexture` already bakes — reuse it as a `Data`/`CanvasTexture` so ambient shape is deterministic and identical to what `planet.js` reads for ground shadows (§3 keeps that contract intact). Sampled via `texture(weatherMap, uv)` node.
- **Height gradient:** `heightShape = coverage.remap()` × a "round bottom, eroded top" profile `smoothstep(0,0.2,h) * (1 − smoothstep(0.6,1,h))` so bases are flat and tops billow — the vertical structure the 2.5D shell physically cannot have.
- **Detail erosion:** subtract high-freq `mx_fractal_noise_float(p * detailFreq)` and a `mx_worley_noise_float` billow term (both verified present in `three.tsl.js`) to carve cauliflower/wisp edges. `p` includes the drift offset (a `uCloudDrift` uniform advanced per frame — same slow rate as today's shell rotation) so the deck moves.
- **Hurricane injection (the true volumetric feature):** transform `dir` into the storm's local frame with a `uStormFrame` mat3 uniform (built each frame from `storm.dir` + `storm.spinAngle` — storms.js already computes `orientQuat·spinQuat`, §3), convert to the storm's polar `(r,θ)`, and evaluate the SAME analytic `discDensity(r,θ)` + `bandDensity(r,θ)` recipe storms.js already has in JS — ported to TSL nodes — scaled by `uStormStrength` (the existing `lifecycleOpacity`/`getPrimary` value) and a tall height profile (overshooting top: eyewall reaches `h≈0.9`, eye punched to 0). This replaces the flat patch; the eye becomes a real hole, the eyewall a real 3D ring. Feeds MAX-combined into ambient coverage.

### 2.4 Composite (depth-aware upsample, before bloom)

The quarter-res result is upsampled and blended over the beauty pass **using the beauty depth** to fix edges at the limb/airship silhouettes: `depthAwareBlend(scenePassColor, cloudColor, scenePassDepth, camera, {…})` from `three/addons/tsl/display/depthAwareBlend.js` (present in the addon dir — this is precisely what GodraysNode's docstring recommends for compositing a low-res raymarch). Optional pre-blend `bilateralBlur` (`three/addons/tsl/display/BilateralBlurNode.js`) to knock down jitter noise. The composited scene then feeds the existing `bloom(…, 0.3, 0.7, 1.0)` unchanged, preserving the >1.0 bloom-headroom contract (ART.md §2.5). Clouds are white-clamped so they never trip the bloom threshold (ART.md §2.4).

### 2.5 The forceWebGL constraint (critical, M5c-specific)

- **No compute / no `Storage3DTexture` this wave.** Compute shaders and storage textures are WebGPU-backend only; under `forceWebGL` (WebGL2) `renderer.computeAsync` is unavailable. So the detail volume is **evaluated procedurally in-shader** (`mx_fractal_noise_float`/`mx_worley_noise_float`) or baked **CPU-side** into a `Data3DTexture`/2D map — NOT compute-baked. (Post-M4 flip: the detail can migrate to a compute-baked `Storage3DTexture` sampled via `texture3D` — verified present — for a big speed win; called out in §6 as the upgrade path, deliberately out of scope now.)
- `Loop` counts are compile-time constants (see §2.2.3).
- The `pass()` node in `main.js` already exists; add `scenePass.getDepthNode()` / `getLinearDepthNode()` (both verified on the pass node) as the depth source — no new render of the scene.

---

## 3. New/changed files + module contracts

### NEW — `src/clouds.js`
```js
// createVolumetricClouds(sky, storms, scenePass, camera, renderer, seed) → {
//   node,                 // CloudsNode (a TempNode) — its getTextureNode() is composited in main.js
//   update(dt, camera),   // advances uCloudDrift, uFrameJitter, sun uniforms, storm-frame uniforms; reads sky.getSunDir()/storms state
//   setVolumetricEnabled(on),   // fallback toggle (see §6) — swaps between volumetric deck and 2.5D shells
//   getWeatherMap(),      // the equirect coverage Data/CanvasTexture (identity-shared with sky's lower-deck field)
// }
// class CloudsNode extends TempNode { constructor(depthNode, camera, uniforms); setup(); updateBefore(); getTextureNode(); setSize(); }
```
Determinism: weather map + all shape params derive from `seed`; the storm injection reads storms.js's already-deterministic state.

### CHANGED — `src/main.js` (integration points, all named)
- Import `createVolumetricClouds`.
- After `const scenePass = pass(scene, camera)` and before the bloom line, build the clouds node from `scenePass.getTextureNode()` + `scenePass.getDepthNode()`:
  ```js
  const clouds = createVolumetricClouds(sky, storms, scenePass, camera, renderer, SEED)
  const cloudComposite = depthAwareBlend(scenePass.getTextureNode(), clouds.node.getTextureNode(), scenePass.getDepthNode(), camera, {...})
  const bloomPass = bloom(cloudComposite, 0.3, 0.7, 1.0)
  post.outputNode = cloudComposite.add(bloomPass)
  ```
- In the animation loop, call `clouds.update(dt, camera)` **after** `storms.update(...)` and `sky.setStormClearing(...)` (so storm frame + sun are current). Add `clouds` to `window.__planet` and the verifykit handle.
- **Warm-up render** once during load (S1 §6) so the ~140 ms node compile never hits a visible frame.

### CHANGED — `src/sky.js`
- Keep `makeCloudTexture` / coverage bake / `getCloudShadowUniforms` / `sampleCloudCover` / `setStormClearing` **unchanged** — the weather map and the planet.js cloud-shadow contract and the M-WX precipitation hook all still read the lower-deck coverage field. **This is the key coexistence win: the volumetric deck samples the identical equirect coverage map, so ground shadows and rendered clouds never drift.**
- `createClouds` retains the 2.5D shells but they become the **fallback path** (built, hidden by default when volumetric is on; `setCloudsVisible` already exists). Reduce `targetCoverage` per §1 (lower 0.20→~0.07, upper 0.09→~0.03) — the volumetric deck reads the same reduced field.
- Export the weather-map texture (or expose via a getter) so clouds.js shares the exact instance.

### CHANGED — `src/storms.js`
- Add a `getVolumetricState(out)` (or extend `getPrimary`) exposing what the injection needs each frame: `dir`, the `spinAngle`, `spinSign`, `strength`, and the storm's radii/scale — enough to build `uStormFrame` (mat3) + feed `discDensity`/`bandDensity` in TSL. The JS `discDensity`/`bandDensity`/`makeHurricaneTexture` constants (EYE_R, WALL_R, CORE_R, ARM_*) are the source of truth; the TSL port mirrors them. The flat patch mesh stays as the fallback storm (hidden when volumetric on).

### UNCHANGED — `src/planet.js`
- Its cloud-shadow consumer (`getCloudShadowUniforms` → `uCloudMat`/`uCloudShadowOn`/`cloudTexNode`) is untouched. It keeps sampling the lower-deck equirect coverage; the volumetric deck is built from that same map, so the contract holds with zero planet.js changes.

---

## 4. Determinism · Covenant · Performance

**Determinism (sacred):** Coverage map, drift rate, detail-noise seeds, hurricane track/texture — all from `seed` + storm spawn counter, exactly as today. The ONE non-deterministic input is `uFrameJitter` (blue-noise temporal dither). It is legal because: (a) it perturbs only sub-pixel ray-start offsets in a **render pass**, never any world-state variable; (b) it must be derived from a frame counter, NOT `Math.random`/`Date.now` (use an incrementing integer uniform); (c) nothing reads the cloud pass back into simulation. World state stays bit-reproducible; only the anti-banding dither differs frame-to-frame, which is the intended behaviour of temporal jitter.

**Covenant (simulation may never destroy/move session structures):** trivially satisfied — clouds.js is a pure read-only render pass. It reads sky/storm/camera state and the depth buffer; it writes only its own RenderTarget. It touches no `world`/session geometry, moves nothing, deletes nothing.

**Performance (target: hold the ~54 draw calls / ~11 ms M5 Pro budget):**
- **+1 draw call** (the quarter-res QuadMesh) + the composite (folded into the existing post chain). Net draw-call impact ≈ +1, well within budget; it *removes* the 2 shell draws + 2 storm-patch draws when volumetric is on (net ≈ −3).
- Cost drivers and mitigations: **quarter-res** (¼ the rays) · **32-step cap + early transmittance break** · **analytic shell entry** (no search march) · **empty-space skip** (all-clear sky = 1 texture fetch + bail) · **≤6-step Beer light** (no nested light march) · **depth clamp** (planet fills most of the screen, so most rays have a tiny or empty `[tNear,tFar]`). The ~70% coverage cut is itself a perf lever — sparse sky = most rays hit near-zero density and break early.
- Budget line to defend at the §7 gate: **≤ ~2.0 ms/frame at orbit on the M5 Pro under forceWebGL.** If it can't hold that, take the §6 fallback.
- No per-frame allocation; no per-frame node-graph mutation (S1 §6 law). All animation via `uniform()` writes.

---

## 5. Build-task breakdown (ordered, fan-out-ready)

Each task is one file/unit where possible; T1–T3 are independent and can start in parallel.

1. **T1 — Weather map extraction (`sky.js`).** Expose the lower-deck coverage field as a shared `Data`/`Canvas` equirect texture + getter; apply the ~70% coverage cut (`targetCoverage` lower≈0.07, upper≈0.03). Keep `getCloudShadowUniforms`/`sampleCloudCover` identical. *No dependency.*
2. **T2 — Storm volumetric state (`storms.js`).** Add `getVolumetricState(out)` (dir, spinAngle, spinSign, strength, radii). Do not touch the existing flat-patch path. *No dependency.*
3. **T3 — `CloudsNode` skeleton (`clouds.js`).** `TempNode` subclass modeled on GodraysNode: quarter-res RT, QuadMesh, `updateBefore` save/restore, `getTextureNode`/`setSize`, a trivial `setup()` that outputs a flat test colour where the shell is hit. Prove the pass renders + composites. *No dependency (stub uniforms).*
4. **T4 — Ray/shell + depth reconstruction (`clouds.js`, on T3).** `getViewPosition`→world hit, ray-sphere `[tNear,tFar]`, depth clamp, empty-space early-out. Output shell-thickness as greyscale to verify occlusion against the planet limb.
5. **T5 — Density field: ambient (`clouds.js`, on T1+T4).** Sample weather map at `dir`, height gradient, `mx_fractal_noise_float`/`mx_worley_noise_float` erosion, drift uniform. Front-to-back `Loop(32)` accumulation + transmittance break.
6. **T6 — Lighting (`clouds.js`, on T5).** ≤6-step Beer + powder toward `sunDir`; ambient hemisphere tint; white-clamp; silver-blue shadow tint. Wire sun uniforms from `sky.getSunDir()`.
7. **T7 — Hurricane injection (`clouds.js`, on T2+T5).** TSL port of `discDensity`+`bandDensity`; `uStormFrame` mat3 from storm state; eye-hole + tall eyewall height profile; MAX-combine with ambient; scale by strength.
8. **T8 — Blue-noise jitter + composite (`clouds.js`+`main.js`, on T5).** `interleavedGradientNoise` ray-start dither with frame-counter uniform; `depthAwareBlend` (+ optional `bilateralBlur`) into the post chain; warm-up render.
9. **T9 — Fade + fallback toggle (`clouds.js`+`main.js`+`ui.js`).** Camera-distance fade (2.4R→1.35R ambient, 1.6R hurricane); `setVolumetricEnabled` swapping volumetric ↔ 2.5D shells; UI/verifykit hook. *On T3–T8.*

---

## 6. Risks + fallback

**Biggest risk — perf at planet scale under forceWebGL.** A per-pixel raymarch of a planet-wrapping shell is the single most expensive thing this app would do, and the WebGL2 backend is the worst case for it: `Loop` unrolls, there's no compute to pre-bake the volume, and MaterialX noise nodes are not cheap. Even quarter-res, 32×~6 density evals across a full-screen sky could blow the ~11 ms budget on grazing-limb views where `[tNear,tFar]` is longest. Secondary risks: (a) the ~140 ms node-recompile hitch if any graph structure changes at runtime (mitigate: build once, warm up, animate via uniforms only — S1 §6); (b) quarter-res + jitter artefacts at the planet limb (mitigate: `depthAwareBlend` + `bilateralBlur`); (c) the M4 flip changing loop/compute behaviour underneath the node (re-profile after flip).

**Fallback (scoped, ship-safe): keep the 2.5D ambient shells, go volumetric for the hurricane ONLY.** The ambient deck reverts to the existing (coverage-cut) `lowerMesh`/`upperMesh` shells — cheap, proven, already satisfies the planet.js shadow contract. The volumetric march runs **only inside a tight screen-space bounding circle around the storm's projected position** (a few % of the screen), so its cost is bounded regardless of planet scale, while still delivering the hero payoff: a real rotating eye/eyewall column with parallax and self-shadow. This is a clean `setVolumetricEnabled('hurricane-only')` mode (T9), and it's the recommended default if T-perf fails the §7 gate. Post-M4, revisit full-sky volumetric with a compute-baked `Storage3DTexture` detail volume (the §2.5 upgrade path).

**Perf gate (§7 handshake):** land T3–T6 behind the fallback flag, profile at orbit + grazing-limb on the M5 Pro. Full-sky volumetric ships only if it holds ≤~2 ms; otherwise ship hurricane-only.
