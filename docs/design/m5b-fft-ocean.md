# M5b — Moving Ocean: spherical Gerstner swell + shore/crest foam

**Arc:** M5b (owner's top water request — "water isn't moving, no waves")
**Branch:** `wave/m3-tsl`
**Status:** design spec — do not implement from this doc alone; fan out the build tasks below.

---

## 1. Goal — how it looks and behaves

Replace the effectively-static stylized water on the planet's ocean shell with a
**visibly moving ocean**: long rolling swell that travels across the sphere, sharpened
crests, and **white foam** where waves break on low coasts and along steep crests.

Behaviour the owner should see:

- **Swell that moves.** Broad wavefronts sweep across the ocean surface continuously.
  Today the ocean displaces along its normal by `±0.00027` of a unit-radius planet
  (`src/planet.js:825`) — that is sub-pixel at every camera distance, so the water reads
  as glass. M5b lifts geometric amplitude into the **0.003–0.008** range (visible at the
  `minDistance 1.06` skim distance) while staying inside the stylized-realistic look.
- **Crest sharpening.** Gerstner horizontal displacement pinches crests and broadens
  troughs, so waves have shape, not just a sine bob.
- **Shore foam.** A moving, lapping white band where the ocean meets shallow coast
  (driven by the existing `aDepth` seafloor-depth attribute → 0 at shoreline).
- **Crest foam.** Thin white highlights on the steepest wave crests out in open water.
- **Calms with distance.** From the whole-planet view the ocean settles (amplitude and
  foam fade out) so distant waves never shimmer/alias into noise; detail returns as you
  descend toward the surface.

The existing fresnel / depth-absorption / coast-glow colour treatment is **preserved and
ported** — M5b adds motion and foam on top of that established look, it does not restyle
the water palette.

---

## 2. Technical approach (grounded in the real three.js 0.185.1 TSL/WebGPU API)

### 2.1 Decision: Gerstner-in-position-node now, FFT-via-compute deferred to M4

The task asks whether to do a GPU **FFT (Tessendorf) height field** via TSL
`compute()` / `StorageBufferNode`, or a cheaper **sum-of-Gerstner-waves** in the position
node. The deciding constraint is the current backend.

**The app runs `WebGPURenderer({ forceWebGL: true })` today** (`src/main.js:30`; M4 will
delete `forceWebGL`). I checked what `compute()` actually does on that backend:

- `compute()` and `storage()` exist — `src/nodes/gpgpu/ComputeNode.js:291`
  (`export const compute = ( node, count, workgroupSize )`) and
  `src/nodes/accessors/StorageBufferNode.js:405` (`export const storage = ...`).
- **But on the WebGL fallback, `WebGLBackend.compute()` is emulated with transform
  feedback over `GL.POINTS`** — `src/renderers/webgl-fallback/WebGLBackend.js:887`
  (`compute(...)`), driving `gl.beginTransformFeedback(gl.POINTS)` /
  `endTransformFeedback` at lines 919–951. That path updates **1-D storage buffers** only.
- A real ocean iFFT needs **storage textures with ping-pong butterfly passes** (RG-float
  read/write across log₂N passes). WebGL2 has no storage textures; the transform-feedback
  emulation cannot express the butterfly. So **a true GPU FFT is not viable on the shipping
  backend.** It becomes practical only after the M4 flip to the native WebGPU backend,
  where `StorageTextureNode` (`src/nodes/accessors/StorageTextureNode.js`) ping-pong works.

**Therefore M5b ships a spherical sum-of-Gerstner-waves computed entirely in the material's
`positionNode` / `normalNode` / `colorNode`.** It is pure TSL vertex/fragment math — no
compute pass, identical on the WebGL fallback and the future WebGPU backend, and it stays
**one draw call**. The FFT path is documented as the M4+ upgrade (§6).

### 2.2 Mapping a planar wave field onto a full sphere (the core problem)

The ocean is a full `SphereGeometry(SEA_LEVEL, 128, 96)` at planet scale
(`src/planet.js:739`, `SEA_LEVEL = 1.0`). A UV-parameterised wave field would tear at the
sphere's poles and seam. The seam-free trick: **evaluate waves in 3-D object space** and
resolve Gerstner's horizontal term in the **local tangent plane**.

For each wave `i` with a seeded 3-D unit direction `Dᵢ`, wavenumber `kᵢ`, amplitude `Aᵢ`,
speed `cᵢ`, steepness `Qᵢ`, at a surface point with `P = positionLocal`,
`N = normalize(positionLocal)`:

```
phaseᵢ = kᵢ · dot(Dᵢ, P) + cᵢ · uTime
Tᵢ     = normalize( Dᵢ − N * dot(Dᵢ, N) )      // Dᵢ projected into the tangent plane
disp  += N  * ( Aᵢ * sin(phaseᵢ) )             // vertical bob
       + Tᵢ * ( Qᵢ * Aᵢ * cos(phaseᵢ) )        // Gerstner crest pinch, tangential
```

`positionNode = positionLocal.add(disp)`. Because phase is a 3-D dot product against
object-space position, wavefronts are seamless planar slabs cutting the sphere — exactly
the current swell construction (`src/planet.js:806–825`), but promoted to real amplitude
and given the tangential Gerstner term. TSL confirmed available: `dot`, `cross`, `length`,
`normalize`, `mix`, `step`, `sin`/`cos`, `positionLocal`, `normalLocal`
(all imported already in `planet.js:9–29`; `cross`/`length`/`dFdx`/`dFdy` at
`src/nodes/math/MathNode.js:935/737/767/777`, `tangentLocal` at
`src/nodes/accessors/Tangent.js:22`, `time` uniform at `src/nodes/utils/Timer.js:10`).

**Wave set (seeded):** 4 long swell waves (large wavelength, low `Q`) + 2 short "chop"
waves (short wavelength, higher `Q`) — 6 total. Wavelengths are floored to **≥ ~2 vertex
spacings** (≈ 0.05 rad on the 128×96 sphere) so geometric waves never sub-sample into
facet noise; all higher frequency lives in the normal, not the geometry (§2.3).

### 2.3 Normals — analytic, via finite differences of the displacement `Fn`

`NodeMaterial` exposes `normalNode` (`src/materials/nodes/NodeMaterial.js:166`, consumed at
`:937`). Displacing `positionNode` does **not** auto-update the shading normal, so M5b
supplies one. Wrap the displacement as a reusable TSL `Fn(dir → dispVec)` and reconstruct
the normal by finite differences in the tangent plane:

```
build a stable tangent basis (U, V) at N:                 // pole-safe
  U = normalize( cross(N, axis) )   axis = |N.y|<0.99 ? (0,1,0) : (1,0,0)
  V = cross(N, U)
P  = P0 + disp(P0)
Pu = (P0 + ε·U) + disp(P0 + ε·U)
Pv = (P0 + ε·V) + disp(P0 + ε·V)
normalNode = normalize( cross(Pu − P, Pv − P) )
```

Three evaluations of a 6-wave `Fn` on ~12.5k vertices is trivial. High-frequency
"sparkle" (the fine surface the geometry can't carry) is added in the fragment as a
**procedural TSL micro-normal** (two scrolling value-noise layers perturbing `normalWorld`)
— chosen over a normal-map texture upload to keep the module self-contained and
deterministic (no asset dependency). `WaterMesh.js` (`examples/jsm/objects/WaterMesh.js`)
is the reference for the scrolling-normal look, though its planar `reflector()` mirror is
not usable on a sphere.

### 2.4 Foam (fragment `colorNode`)

Foam is a white overlay mixed over the ported water colour:

- **Shore foam:** `shoreMask = smoothstep(0.10, 0.0, aDepth)` — `aDepth` already carries
  normalized seafloor depth (0 at shoreline, `src/planet.js:759`). Modulate by scrolling
  value-noise and by wave phase so the band laps in and out rather than sitting static.
- **Crest foam:** approximate the Gerstner Jacobian fold with the summed vertical term:
  `crestMask = smoothstep(crestHi, crestHi+w, heightSum)` where `heightSum = ΣAᵢsin(phaseᵢ)`
  is returned alongside the displacement from the shared `Fn`.
- `foam = saturate(shoreMask * shoreNoise + crestMask)`; `colour = mix(water, FOAM_WHITE, foam)`.

### 2.5 Altitude LOD

`update(dt, camera)` reads `alt = camera.position.length() − 1` and writes one uniform
`uWaveLOD ∈ [0,1]` (`smoothstep`: full at `alt ≲ 0.3` skim, → 0 by `alt ≳ 3`). `uWaveLOD`
scales geometric amplitude, foam intensity, and micro-normal strength, so the distant
planet reads as a calm sphere (where waves would be sub-pixel and shimmer anyway) and full
detail returns on descent. Amplitude is **additionally faded to zero as `aDepth → 0`** so
crests shrink in the shallows — physically correct *and* it keeps displaced crests from
poking through the thin coastline (covenant/coast-read protection, §4).

---

## 3. New / changed files + module contracts

### NEW: `src/ocean.js`
Owns the ocean mesh + material end to end (extracted from the `planet.js` ocean block).

```js
// createOcean(sampleHeight, opts) -> { mesh, material, update }
//   sampleHeight: (THREE.Vector3 dir) => number   // terrain height sampler from planet.js
//   opts: { seed: string }
// returns:
//   mesh:     THREE.Mesh   (SphereGeometry(SEA_LEVEL,128,96), one draw call)
//   material: THREE.MeshStandardNodeMaterial
//   update(dt, camera): advances uTime, sets uWaveLOD from camera altitude
export function createOcean(sampleHeight, { seed }) { /* ... */ }
```

Responsibilities: build geometry; **bake the `aDepth` (and legacy `color`) attributes** from
`sampleHeight` (moved verbatim from `planet.js:747–767`); build the material with the
Gerstner `positionNode`, finite-diff `normalNode`, foam `colorNode`; seed the wave set
deterministically from `seed`; expose `update`. Preserve `transparent/opacity/roughness/
metalness/emissive` values from `planet.js:769–782`.

### CHANGED: `src/planet.js`
- Delete the ocean block (`:738–866`: geometry+attribute bake, `oceanMat`, swell
  `positionNode`, `colorNode`, `uTime`, `waterElapsed`).
- `import { createOcean } from './ocean.js'`; construct `const ocean = createOcean(sampleHeight, { seed })`;
  `group.add(ocean.mesh)` (replaces `group.add(oceanMesh)` at `:870`).
- In `update(dt, camera)` (signature gains `camera`) call `ocean.update(dt, camera)` in
  place of the old `waterElapsed/uTime` lines (`:877–885`). Cloud-shadow-on-water is out of
  scope for M5b — terrain keeps its cloud shadows; the ocean's `uCloudShadow*` plumbing is
  **not** carried into `ocean.js` (simplification; re-add later if wanted).

### CHANGED: `src/main.js`
- One line: `planet.update(dt)` → `planet.update(dt, camera)` (`:199`) to thread camera for
  LOD. No other integration points move; still `post.renderAsync()`, still one bloom pass.

---

## 4. Determinism, covenant, performance

**Determinism.** Wave directions/amplitudes/wavelengths/speeds are derived from the planet
`seed` via the existing seeded hashing in `util.js` — same seed, same ocean. The animation
clock `uTime` is **presentation-only**: it accumulates `dt` and drives visuals, never world
state. The determinism covenant governs *world state* (settlements, structures, git-derived
data must come from seed + session/git, no `Math.random`/`Date.now`) — a frame-rate-driven
water clock is outside that boundary, exactly as the current `waterElapsed` already is
(`planet.js:863,878`). No `Math.random`/`Date.now` is introduced.

**Covenant (simulation may never destroy/move session structures).** The ocean is a passive
render shell. It **reads** the static terrain-derived `aDepth` attribute only; it **writes**
nothing to world state, session structures, or any other module. Crest displacement is
clamped to zero at the shoreline (`aDepth → 0`, §2.5) so no wave geometrically overlaps or
visually swallows a coastal structure. Zero covenant surface.

**Performance (target: hold 54 draw calls, ~11 ms budget, M5 Pro).**
- **Draw calls unchanged.** The ocean stays exactly **one mesh / one draw call**. No compute
  dispatch, no extra passes, no reflection buffer. 54 → 54.
- **Vertex cost:** 6-wave Gerstner × 3 evaluations (position + 2 finite-diff offsets) over
  ~12.5k vertices ≈ a few hundred K sin/cos — well under ~0.5 ms.
- **Fragment cost:** fresnel + 3-stop depth (already shipping) + two value-noise layers
  (micro-normal) + foam noise, over the same ocean pixels as today — ≈ 0.3–0.6 ms.
- **No new memory/uploads:** procedural noise, no normal-map texture. Geometry unchanged
  (~12.5k verts). Net well inside the 11 ms headroom.

---

## 5. Build-task breakdown (ordered, fan-outable)

File-level tasks are independent; contract in §3 is the interface between them.

1. **T1 — `src/ocean.js` scaffold + attribute bake.** New module: geometry
   `SphereGeometry(SEA_LEVEL,128,96)`, port `aDepth`/`color` baking from `planet.js:747–767`,
   `MeshStandardNodeMaterial` with ported constants, return `{ mesh, material, update }`
   with a no-op `update`. *(foundation — everyone depends on this)*
2. **T2 — `ocean.js` Gerstner `positionNode`.** Seeded 6-wave set (4 swell + 2 chop) from
   `seed`; shared `Fn(P → { disp, heightSum })` implementing the spherical Gerstner of §2.2;
   `positionNode = positionLocal.add(disp)`; wavelengths floored to ≥2 vertex spacings.
   *(depends T1)*
3. **T3 — `ocean.js` analytic `normalNode`.** Pole-safe tangent basis + finite-diff of the
   T2 `Fn` (§2.3); optional procedural micro-normal layers for close-up sparkle.
   *(depends T2)*
4. **T4 — `ocean.js` foam + water `colorNode`.** Port fresnel/depth/coast-glow look from
   `planet.js:827–861`; add shore foam (`aDepth`) + crest foam (`heightSum`) per §2.4.
   *(depends T1; parallel to T2/T3)*
5. **T5 — `ocean.js` `update(dt, camera)` + LOD.** Advance `uTime`; compute `uWaveLOD` from
   camera altitude; wire LOD + shoreline fade into amplitude/foam/micro-normal (§2.5).
   *(depends T2–T4)*
6. **T6 — `src/planet.js` integration.** Remove old ocean block (`:738–866`), compose
   `createOcean`, forward `ocean.update(dt, camera)`, widen `update` signature. *(depends
   on T1's contract; can start against the stub)*
7. **T7 — `src/main.js` camera threading.** `planet.update(dt, camera)` (`:199`). *(depends
   T6; one line)*
8. **T8 — perf + determinism verify.** Confirm 54 draw calls unchanged and frame time via
   the existing `verifykit.js`; confirm two runs of the same seed produce identical wave
   params; capture a skim-distance + whole-planet screenshot for the owner. *(depends T7)*

---

## 6. Risks + fallback

- **[Biggest risk] Geometry too coarse for crisp waves at the skim distance.** The 128×96
  sphere gives ~0.05 rad vertex spacing; at `minDistance 1.06` short chop waves can facet or
  alias against the flat-shaded aesthetic. *Mitigations, in order:* (a) keep all
  high-frequency detail in the normal/micro-normal, not the geometry, and floor geometric
  wavelengths to ≥2 vertex spacings (already in T2); (b) if still coarse, raise ocean
  tessellation to **256×128** (~65k verts, still one draw call, still cheap) — verify in T8;
  (c) accept slightly softer close-up waves — the owner's ask is "moving water + waves +
  foam", which (a) already satisfies.
- **Finite-diff normal artifacts / pole degeneracy.** Wrong tangent basis at the poles
  flips normals. *Mitigation:* the `|N.y|<0.99 ? Y : X` axis switch in §2.3; if it still
  glitches, fall back to perturbing `normalLocal` by the analytic tangential slope only
  (cheaper, slightly flatter shading).
- **Transparency ordering vs. displaced crests over thin coasts.** *Mitigation:* the
  `aDepth → 0` amplitude fade (T5) removes crests exactly where the ocean is thinnest.

**Fallback if the ideal proves too costly:** ship the **cheapest owner-visible win** — keep
the 6-wave Gerstner `positionNode` at visible amplitude and the shore-foam band, but drop
the finite-diff `normalNode` (use the existing approximate normal + micro-normal only) and
crest foam. That still delivers "moving water with waves and coastal foam" at essentially
zero risk.

**Upgrade path (M4+, native WebGPU backend):** replace the analytic Gerstner sum with a real
**Tessendorf iFFT ocean** — spectrum → ping-pong butterfly in `StorageTextureNode`
(`src/nodes/accessors/StorageTextureNode.js`) driven by `compute()`
(`src/nodes/gpgpu/ComputeNode.js:291`), sampled tri-planar/spherically onto this same mesh.
Not attempted on the `forceWebGL` fallback because its `compute()` is transform-feedback over
`GL.POINTS` (`WebGLBackend.js:887,919–951`) — 1-D buffers only, no storage-texture butterfly.
The §3 module contract is unchanged by that swap: only the internals of `ocean.js` change.
