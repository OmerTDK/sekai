# M5a — Atmospheric Scattering (Rayleigh / Mie) — Implementation Spec

**Arc:** M5a · **Wave:** wave/m3-tsl · **Owner-direction:** `docs/ART.md` §2 (Sky & night, "limb, layered atmosphere color", NASA ISS sunset ref) · **Status:** design, not yet built.

---

## 1. Goal — how it looks and behaves

Give Aemunis a believable **atmospheric limb** — the thin, layered crescent of colored air you see hugging a planet's edge from orbit (NASA ISS sunset ref, cited in ART.md §"Sky & night") — plus **aerial perspective**: distant terrain hazing toward atmosphere-blue, warming to amber near the day/night terminator.

Two coupled phenomena, one physical cause (single-scattering of sunlight through the air shell):

1. **The limb over space.** Around the planet's silhouette, a graded band: deep-space-blue high up, thickening through cyan to a warm amber/orange arc exactly where the view ray grazes the atmosphere *toward* the low sun — the sunrise/sunset crescent. It sweeps around the disc as the sun orbits (900 s day, `SUN_ORBIT_RATE` in `sky.js`). It **blooms** (feeds the existing bloom pass, so the lit limb glows).
2. **Aerial perspective over terrain.** As the camera dives from orbit (9R) toward the surface (1.06R), far mountains and coastline pick up a scattering-tinted haze — bluer looking away from the sun, warmer looking toward it — that fades correctly as you approach. Near the terminator the haze reddens (long optical path, Rayleigh strips blue).

**Register:** stylized-realistic, *not* photoreal. ART.md is explicit — the atmosphere must stay restrained ("Atmosphere rim stays faint on purpose … do not overdrive this"). Physically-*inspired* falloff and hue, hand-tuned amplitude. Existing rim tint `#7db8ff` and sun `#fff2d8` are the anchor palette.

**Non-negotiable preservation:** starfield, milky-way skybox, nebulae, cloud decks, moons, aurora, meteors, and the >1.0-headroom bloom sun all render exactly as today. The effect only *adds* in-scattered light where an eye ray actually crosses the air shell; it never repaints empty sky.

---

## 2. Technical approach (grounded in three 0.185.1 TSL/WebGPU)

### 2.1 Vehicle choice — and why not the two obvious ones

| Candidate | Verdict |
|---|---|
| **`SkyMesh.js`** (shipped, `three/addons/objects/SkyMesh.js`) — TSL Preetham dome | **Reject as the vehicle.** It is a *ground-observer* sky dome (`positionWorld - cameraPosition` direction, zenith-length optical depth). Aemunis is viewed **from space** (camera 1.06R–9R, planet at origin, R≈1). A Preetham dome would paint full-screen daylight-blue *behind* the planet, destroying the starfield/galaxy backdrop. **We do reuse its exact scattering constants and phase functions as the source of truth** (see 2.3). |
| **Analytic back-side atmosphere shell** (a `SphereGeometry(~1.15)`, like today's fresnel `createAtmosphere`) | **Reject as sole vehicle.** `camera.minDistance = 1.06` puts the camera *inside* a 1.15R shell on close dives — back-side faces fall behind the near plane and the limb inverts. Cannot express aerial-perspective extinction of the terrain behind it without a second front pass. |
| **Screen-space single-scattering post pass** (reconstruct world ray from depth, analytically intersect ground sphere R=1 and air-top sphere R≈1.15, integrate Rayleigh+Mie, composite over the beauty buffer) | **Chosen.** One pass yields *both* the limb (rays that miss ground still cross the air chord) *and* aerial perspective (rays that hit ground integrate camera→ground). Robust to camera inside **or** outside the shell. Idiomatic: the app already runs node `PostProcessing` (`pass` + `bloom`), so we slot in one more node before bloom. |

### 2.2 The node-PostProcessing depth pass — exact API (grounded)

The pattern is proven by the shipped depth-consuming passes in `node_modules/three/examples/jsm/tsl/display/`:

- **Depth texture from the scene pass:** `scenePass.getTextureNode('depth')` — documented in `GTAONode.js` line 25 (`const scenePassDepth = scenePass.getTextureNode( 'depth' )`). `pass(scene, camera)` (already called in `main.js:115`) is a `PassNode` that exposes color and `'depth'` MRT outputs.
- **World-position reconstruction:** `getViewPosition( uv, depth, cameraProjectionMatrixInverse )` (imported from `three/tsl`; used in `GodraysNode.js:449` and `GTAONode.js:348`), then `cameraMatrixWorld.mul( viewPosition )` → world position (`GodraysNode.js:450`).
- **Depth linearization guard:** copy `GodraysNode.js` `sampleDepth` (lines 357–371) — branch on `builder.renderer.logarithmicDepthBuffer` using `logarithmicDepthToViewZ` / `viewZToPerspectiveDepth` (all exported from `three/tsl`). Our renderer is non-logarithmic today, so depth is used directly, but keep the guard for the M4 backend flip.
- **Ray-sphere intersection:** hand-written TSL (`dot`/`sub`/`sqrt`/`max`), analogous to `Raymarching.js`'s `hitBox` slab test (`three/addons/tsl/utils/Raymarching.js`) but for two concentric spheres. Returns `(tNear, tFar)` of the air shell along the eye ray.
- **Fixed-step integration:** `Loop( N, ... )` from `three/tsl` (used across GodraysNode/GTAONode). **N = 4 uniform steps** — deterministic, no blue-noise dither needed for a thin shell, so no companion blur pass.

**Two implementation shapes** (builder picks the simpler that compiles clean):
- **(Preferred) inline node function.** `atmosphereScattering(sceneColorNode, sceneDepthNode, camera, sunUniforms)` returns a composited color node built with an `Fn(() => …)`. No extra `RenderTarget`, runs at full res fused into the existing `scenePass → bloom` chain. Cheapest; **zero net render targets**.
- **(Fallback) `TempNode` subclass** modeled beat-for-beat on `GodraysNode` (`QuadMesh`, `RenderTarget({depthBuffer:false})`, `RendererUtils.resetRendererState`, `passTexture`, `NodeUpdateType.FRAME`, `setup(builder)` → texture node). Use only if the inline node cannot see the pass's camera-matrix uniforms cleanly.

### 2.3 The scattering math (reused constants, re-parameterized geometry)

Lift **verbatim** from `SkyMesh.js` (cite in code comments):
- `totalRayleigh = vec3(5.804542996261093e-6, 1.3562911419845635e-5, 3.0265902468824876e-5)` (`SkyMesh.js:173`) — β_R hue is what makes sky blue / sunset red; keep the ratio, scale amplitude by a seeded uniform.
- Rayleigh phase `3/(16π)·(1+cos²θ)` (`SkyMesh.js:240,264`) and Mie Henyey-Greenstein `1/(4π)·(1-g²)/(1+g²-2g·cosθ)^1.5` (`SkyMesh.js:242,269–271`), with `mieDirectionalG≈0.8` giving the forward amber lobe at the terminator.

Re-parameterize for planetary radii (this is the part SkyMesh does *not* do):
- Planet ground radius `Rg = 1.0`; atmosphere top `Rt = 1.15` (clears terrain `HEIGHT_MAX=1.06` and cloud shells ~1.09, per ART.md §height-cap). Exponential density `exp(-(r-Rg)/H)`, scale height `H` seeded.
- Optical depth from a 4-tap trapezoid along the eye chord; extinction `Fex = exp(-(βR·τR + βM·τM))`; in-scatter `Lin = sunColor · (βR·phaseR + βM·phaseM) · (1 - Fex)` (structure mirrors `SkyMesh.js:256–275`, but integrated over the *segment* camera→min(ground hit, air exit)).
- **Composite:** `out = sceneColor * mix(1.0, Fex, aerialStrength) + Lin`. The `mix` with an `aerialStrength` uniform lets us keep extinction near-off for the additive sun sprite / star pixels (they carry `depth == far`, no ground hit → integrate only the thin exit chord → negligible dimming) while still hazing terrain.

### 2.4 Preservation mechanics (why nothing breaks)

- **Stars/skybox/sun sprite write no depth** (`MeshBasicMaterial{depthWrite:false}` in `createSkybox`; `SpriteMaterial{depthWrite:false}` in `createSunSprite`). Their pixels read `depth == far`. Rays that also miss the air shell get `Lin=0, Fex=1` → pixel untouched. Rays through the limb get a *small additive* `Lin` only → stars behind the limb glow faintly, exactly the ISS look, and the bloom sun's amber halo is enhanced, not dimmed.
- **Bloom order:** insert the atmosphere node **before** bloom so the lit limb blooms: `bloom(atmoNode, 0.3, 0.7, 1.0)`, `post.outputNode = atmoNode.add(bloomPass)` (replacing `main.js:116–117`). Bloom threshold 1.0 unchanged — limb amplitude is tuned to sit just under 1.0 except at the sun-grazing crescent, preserving the headroom trick.
- **Old fresnel rim** (`createAtmosphere`, `sky.js:737`) is superseded. Keep the mesh but drop its `intensity` uniform to ~0 when the pass is active (it becomes the WebGL/no-depth **fallback**, see §6). Net mesh count unchanged.

---

## 3. New / changed files & module contracts

### NEW — `src/atmosphere.js`
```js
// createAtmosphereScattering(seed) -> {
//   node(sceneColorNode, sceneDepthNode, camera, sunUniforms) -> Node  // composited color
//   update(dt)                        // no-op today; reserved for animated turbidity
//   params                            // seeded {rayleigh, mieG, mieCoeff, scaleHeight, Rt, aerialStrength, tint}
//   setEnabled(on)                    // toggles pass vs. fresnel-fallback (UI + WebGL path)
// }
// sunUniforms: { dir: uniform(Vector3), color: uniform(Color), intensity: uniform(float) }
// All params from rngFromString(seed+':atmo'); NO Math.random / Date.now.
```
Ground radius `Rg=1`, `Rt` and density from `params`. Pure render module — reads uniforms, owns no world state, touches no session structures (Covenant-inert by construction).

### CHANGED — `src/sky.js` (additive, ~15 lines)
Expose the live sun as shared uniform nodes so the pass tracks the orbit:
```js
// new, alongside getSunDir:
function getSunUniforms() { return sunUniforms }   // { dir, color, intensity }
```
In `update()` (after `sky.js:167`, where `lights.sun` color/intensity are already set), write the existing `_sunDirScratch`, `lights.sun.color`, `lights.sun.intensity` into `sunUniforms.*.value`. Zero new per-frame allocation (reuse `_sunDirScratch`). Add `getSunUniforms` to the returned object (`sky.js:283`). Reduce `createAtmosphere` fresnel `intensity` to a `setEnabled`-gated value.

### CHANGED — `src/main.js` (post-chain, ~5 lines)
```js
import { createAtmosphereScattering } from './atmosphere.js'
const atmo = createAtmosphereScattering(SEED)
const scenePass = pass(scene, camera)
const scenePassDepth = scenePass.getTextureNode('depth')
const atmoNode = atmo.node(scenePass, scenePassDepth, camera, sky.getSunUniforms())
const bloomPass = bloom(atmoNode, 0.3, 0.7, 1.0)
post.outputNode = atmoNode.add(bloomPass)
// window.__planet.atmosphere = atmo   // dev handle + verifykit wiring
```
No animation-loop change required (uniforms driven inside `sky.update`). Optionally add `atmo.update(dt)` if animated turbidity lands.

### CHANGED — `src/verifykit.js` / `src/ui.js` (optional, thin)
Add an `atmosphere` toggle to the feature panel (mirrors `setCloudsVisible`) and let verifykit screenshot the `orbit` + `ground-sunlit` viewpoints with the pass on/off for the determinism-hash + draw-call assertion.

---

## 4. Determinism · Covenant · Performance

- **Determinism.** Every tunable (β amplitude, Mie g, scale height, `Rt`, tint, aerial strength) derives from `rngFromString(seed + ':atmo')` — same seed, same atmosphere. No `Math.random`/`Date.now`. Fixed 4-tap loop (no time- or `Date`-seeded jitter). The only time input is the sun *orbit*, which is already the app's deterministic animation clock; the scattering **look at a given sun position is a pure function** of the sun uniform. Screen-space `screenCoordinate` dither is deliberately **not** used, so nothing depends on viewport/frame state either.
- **Covenant.** `atmosphere.js` is a pure post-process reading uniforms and the depth buffer; it creates, moves, or destroys **no** scene objects and never touches `world`/session structures. Structurally incapable of violating the Covenant.
- **Performance (target: hold 54 draw calls, ≥11 ms headroom on M5 Pro).**
  - **Draw calls: net 0.** Inline-node shape adds no render target and no new draw call (fused into the existing fullscreen post chain); if the `TempNode` fallback is used it adds exactly 1 quad, offset by retiring the fresnel atmosphere mesh (−1). Budget preserved.
  - **GPU cost:** one full-res fullscreen fragment pass, 4 taps × (2 `exp` + 2 phase evals) + one depth fetch + one ray-sphere solve. Est. **<0.4 ms at 1440p** on M5 Pro — well inside headroom.
  - **Bandwidth:** reads existing depth + color MRT already produced by `pass`; no extra buffers in the inline shape.

---

## 5. Build-task breakdown (fan-out ready — one file each where possible)

1. **`src/atmosphere.js` — seeded params + module skeleton.** `createAtmosphereScattering(seed)`, `rngFromString(seed+':atmo')` param block, `setEnabled`, `update` no-op, `getParams`. Returns a **passthrough** `node()` (returns `sceneColorNode` unchanged) so it integrates before the shader exists. *(no deps)*
2. **`src/atmosphere.js` — ray-sphere + depth reconstruction TSL.** Add the two-sphere intersection helper and the `getViewPosition`→world-position block (copy `sampleDepth` log-depth guard from `GodraysNode.js:357–371`). Unit-check against a known ray. *(after 1)*
3. **`src/atmosphere.js` — scattering integrand.** Port `totalRayleigh`, Rayleigh + Mie HG phase from `SkyMesh.js`; 4-tap optical-depth `Loop`; `Fex`/`Lin`; final composite `sceneColor*mix(1,Fex,aerial)+Lin`. *(after 2)*
4. **`src/sky.js` — sun uniform contract.** Add `sunUniforms`, populate in `update()`, export `getSunUniforms`; gate fresnel `intensity` behind `setEnabled`. Independent of 1–3. *(parallel)*
5. **`src/main.js` — post-chain wiring.** Insert `atmoNode` before `bloom`, rewire `outputNode`, add `window.__planet.atmosphere`. *(after 1 + 4; works with passthrough node)*
6. **`src/ui.js` + `src/verifykit.js` — toggle + verification.** Feature-panel toggle; verifykit draw-call/determinism assertion on/off at `orbit` + `ground-sunlit`. *(after 5)*
7. **Tuning pass.** Amplitude/scale-height/tint against ART.md ("faint", `#7db8ff` anchor) at the five verifykit viewpoints; confirm bloom headroom + star preservation by screenshot diff. *(last)*

Tasks 1→2→3 are serial within one file (assign one builder); 4 runs fully parallel; 5–7 gate on the above.

---

## 6. Risks & fallback

**Biggest risk — depth-MRT availability/precision on the forceWebGL (WebGL2) backend.** `scenePass.getTextureNode('depth')` + `getViewPosition` are proven on the WebGPU node path (GTAO/DoF/Godrays all ship it), but this app runs `WebGPURenderer({forceWebGL:true})` **today**, and depth-texture MRT wiring or precision (camera `far=300`, planet at ~1–9R) could differ from the true WebGPU backend arriving at M4. Secondary risk: the additive limb subtly dimming the >1.0 bloom sun via the extinction term.

**Mitigations / fallback ladder:**
1. Keep the `aerialStrength` `mix` so extinction can be dialed toward 0 (pure additive in-scatter) — removes any sun-dimming and any dependence on precise linear depth; the limb still reads because it needs only the ray-vs-air-shell chord, **not** the scene depth.
2. If depth reconstruction is unusable on WebGL2, ship the **limb-only** variant: the same integrand evaluated with `depth = far` everywhere (analytic air-chord, no ground occlusion). Loses aerial-perspective haze but keeps the headline sunrise/sunset limb, at zero depth dependency. Re-enable full aerial perspective at the M4 WebGPU flip.
3. Hard fallback: `setEnabled(false)` restores today's fresnel rim (`createAtmosphere`) untouched — no regression, the app looks exactly as it does now.
