# God-Controls & Triggers — implementation spec

Wave: `wave/m3-tsl` · Arc: interactive spectacle ("god-controls") · three.js **0.185.1**, `WebGPURenderer({forceWebGL:true})` + TSL nodes + node `PostProcessing`.

## 1. Goal — what it looks like and how it behaves

The owner gets a small **GOD** panel (sibling of the existing feature-panel, same `vp-btn`/`feature-panel` idiom in `src/ui.js`) exposing four spectacles. All are **user-driven interactive triggers** — explicitly exempt from the seed-determinism rule, though every visual we generate is still seeded (no `Math.random`/`Date.now`), and none of them ever move or destroy a session structure (THE COVENANT).

- **Fast-sun / time-of-day** (cheapest, highest delight — ship first). A speed slider (Reverse · Pause · 1× · 30× · 120× · 600×) multiplies the sun's existing orbit rate. The terminator visibly sweeps across Aemunis; as each face rolls into night the town-lights (`world.js` `townLights`, additive, bloom-haloed) and the night-gated **aurora** light up on their own — no new geometry, just a faster sun. At 600× a full day is ~1.5s.
- **Meteor strike on click.** Arm the tool, click the globe: a bright streak falls from the sky-sphere to the picked surface point, a fireball flash punches (screen-flash + additive >1.0 emissive that bloom catches), then a **scorched crater decal** conforms to the surface and **heals** (fades out) over ~15s — a covenant-honoring, non-destructive scar. Optionally auto-fired by a real `git` force-push/revert at the offending settlement.
- **Summon-weather.** Three buttons: **conjure a hurricane** (force-spawn `storms.js`), **call an aurora** (pulse the existing curtains bright for ~20s), **trigger an eclipse** (force the sun-dim/corona envelope `sky.js` already drives from moon alignment).

## 2. Technical approach — grounded in the real 0.185.1 API

Everything reuses machinery already in the tree; **no new TSL node classes are required**. Evidence from source read this session:

- `src/sky.js` imports `uniform, texture, Fn, …` from `three/tsl` (lines 5–21) and drives all live shading by writing `.value` on `uniform()` nodes each frame. The aurora already owns `{ uTime: uniform(0), uSunDir: uniform(vec3) }` (createAurora, ~L1424) and gates brightness night-side per-fragment via `auroraSmoothstepSafe(0.1,-0.25, positionWorld·uSunDir)` (~L1403). Adding a `uBoost = uniform(1)` multiplier into that fragment is a one-line node change + one `.value` write.
- The sun orbit is `const SUN_ORBIT_RATE = (Math.PI*2)/900`, consumed once as `SUN_ORBIT_RATE * dt` (sky.js L114/L128). Fast-sun = a module-instance `let sunSpeed = 1` factored into that product. Eclipse is **already** recomputed from scratch every frame with no state machine (L158–L173: `eclipseFactor` → `lights.sun.intensity/color`, `lights.hemi.intensity`, corona scale/opacity) — a forced-eclipse envelope just `Math.max`es into `eclipseFactor`.
- **Impact flash** uses the tree's proven trick, not post-graph surgery: the M3 `bloom(scenePass, 0.3, 0.7, 1.0)` in `main.js` (L114–117) blooms any color >1.0 (the comment on L112 calls out "the >1.0-color bloom-headroom trick the sky relies on"). A fireball = additive `Sprite`/quad with emissive color pushed past 1.0. Context7 (`/mrdoob/three.js`, webgpu_tsl_vfx_tornado / volume_fire) confirms the current idiom: `MeshBasicNodeMaterial` with `outputNode = Fn(() => vec4(color.mul(N), alpha))()` and time-driven `uniform` fades — available if we want a nicer fireball, but a plain additive sprite is enough. The **full-screen white punch** is a CSS overlay `<div>` opacity-animated in `ui.js` — **0 draw calls**.
- **Meteor streak** mirrors the ambient shooting-stars already in sky.js: additive `LineBasicMaterial` `THREE.Line`, `frustumCulled=false`, positions rewritten in place (createMeteor, ~L1481; envelope logic L206–210).
- **Healing crater** reuses the surface-conforming patch pattern that already sits convincingly on displaced terrain: `storms.js buildPatch()` (L154) / the `flood.js` patch which "always heals" by draining over `FLOOD_DRAIN_TIME` (flood.js L261). Crater = a dark scorch alpha patch anchored at the impact world-dir, tracking `planet.group`'s live quaternion each frame (same world-dir→shell path floods/clouds use), opacity fading 1→0 over ~15s. **No terrain displacement** — purely an overlay, which is what keeps it cheap and covenant-safe.
- **Hurricane** — `storms.js` already has `spawn(slot)` + two slots (A active, B dormant, L424–434) and `pickStormOrigin(rng, planet)` (L306). `summonStorm()` = force-`spawn` a slot immediately from a fresh seeded counter.

## 3. New / changed files & module contracts

**NEW `src/meteors.js`** — `createMeteorStrike(planet, camera, world, seed) → { group, update(dt), strike(worldDir), strikeAtPointer(clientX, clientY) }`
- `strikeAtPointer` raycasts against `planet` mesh (world already owns a raycaster idiom); on hit → `strike(hitDir)`. `strike(dir)` starts one transient strike record: streak (0→~0.6s), flash sprite (peak then fade ~0.3s), crater patch (fade over `CRATER_HEAL_S≈15`). Seeded from `seed + ':meteorstrike:' + counter++` (crater texture jitter, debris). Pooled — at most ~2 concurrent strikes; steady-state cost = one counter compare.

**CHANGED `src/sky.js`** — add to the returned object:
- `setSunSpeed(mult)` / `getSunSpeed()` — clamps to e.g. `[-8, 600]`; `0` = pause, negatives run time backward.
- `pulseAurora(strength = 3, durationS = 20)` — ramps `uBoost.value` up then decays (envelope in `update`).
- `triggerEclipse(durationS = 8)` — sets a forced-eclipse envelope `max`ed into `eclipseFactor`; optionally slews the nearest moon's `pivot` toward alignment during the window for a visible disc-crossing (stretch).

**CHANGED `src/storms.js`** — add `summonStorm(originDir?)` to the return object (currently `{ group, update, getPrimary }`): force-`spawn` an inactive slot now, seeded off `spawnCounter`.

**CHANGED `src/ui.js`** — new GOD panel built with the existing `makeVpBtn`/`feature-panel` pattern (a `⚡` vp-button toggles it, like `featuresBtn` L845). Rows: sun-speed slider, "☄ Meteor" arm-toggle (arms a one-shot canvas `pointerdown` → `hooks.strikeMeteor(x,y)`), "🌀 Hurricane", "🌌 Aurora", "🌑 Eclipse". Calls new `hooks.*`. Owns the CSS screen-flash overlay div + `flashScreen()`.

**CHANGED `src/ui.css`** — `#god-panel`, `.god-slider`, `#god-flash` (fixed, `pointer-events:none`, additive white, opacity-transition).

**CHANGED `src/main.js`** — integration points:
- After `storms`/`world` exist: `const meteors = createMeteorStrike(planet, camera, world, SEED); scene.add(meteors.group)`.
- In the loop (after `storms.update`): `meteors.update(dt)`.
- Extend the `createUI(world, hooks)` hooks object with: `setSunSpeed: sky.setSunSpeed`, `getSunSpeed: sky.getSunSpeed`, `strikeMeteor:(x,y)=>meteors.strikeAtPointer(x,y)`, `summonStorm: storms.summonStorm`, `callAurora: sky.pulseAurora`, `triggerEclipse: sky.triggerEclipse`. Add `meteors` to `window.__planet` and the verifykit bag.

**CHANGED (optional) `server/gitinfo.js` + `src/events.js`** — emit a new event `kind:'revert'` (or `'force-push'`, detected via reflog/`--force` heuristic; today gitinfo emits only `commit`/`pr-merged`). `events.ingest` routes it through a new `onCataclysm(anchorDir)` callback wired in main.js to `meteors.strike`.

## 4. Determinism · covenant · performance

- **Determinism.** Sun *angle* is already real-time-accumulated (not seeded) in shipped code — pre-existing and correct for a day/night cycle; the speed multiplier is an interactive control, exempt. All *generated* visuals (crater texture, debris, forced-storm origin) derive from `seed + ':' + counter`, advancing seeded RNGs only — **no `Math.random`/`Date.now`**. World state (settlements/structures) is never touched by any trigger.
- **Covenant.** No trigger moves or removes a structure. The crater is a **non-destructive overlay decal that heals** (fades to nothing, like floods drain) — it never displaces terrain and never edits the structure graph. Auto-cataclysm anchors *near* a settlement for spectacle but does not modify it.
- **Performance (target: 54 draw calls, ~11 ms headroom on M5 Pro).** Steady-state cost of all four features when idle ≈ **0** (uniform reads / counter compares). Fast-sun adds nothing — same per-frame work, just larger `dt·rate`. Aurora pulse & forced eclipse = one extra `uniform.value` write each. Meteor strike is transient: +1 line + +1 flash sprite for <1s, +1 crater mesh for ~15s → peak **+2–3 draw calls**, well inside budget; screen-flash is CSS (0 draw calls). Pool caps concurrent strikes at ~2.

## 5. Build-task breakdown (fan-out ready)

Tasks **A–D are fully parallel** (disjoint files). E and F are integration (depend on A–D contracts). G is optional.

1. **Task A — `src/sky.js` god-hooks** (one file, do all three together to avoid 3-way conflict): `setSunSpeed/getSunSpeed` (factor `sunSpeed` into `SUN_ORBIT_RATE*dt`); aurora `uBoost` uniform + `pulseAurora`; forced-eclipse envelope + `triggerEclipse`. Ship fast-sun first — it's the money shot.
2. **Task B — `src/storms.js`**: add `summonStorm(originDir?)` to the return object.
3. **Task C — `src/meteors.js`** (NEW, largest): streak + flash sprite + healing crater patch; `createMeteorStrike` signature above. Reuse `buildPatch`/flood-drain and ambient-meteor line idioms.
4. **Task D — `src/ui.css`**: `#god-panel`, `.god-slider`, `#god-flash`.
5. **Task E — `src/ui.js`**: GOD panel + slider + `flashScreen`, wired to `hooks.*` (depends on A/B/C contract names, D classes).
6. **Task F — `src/main.js`**: instantiate meteors, extend hooks, loop `meteors.update`, `__planet`/verifykit wiring (depends on A/B/C/E).
7. **Task G (optional) — `server/gitinfo.js` + `src/events.js`**: `revert`/`force-push` event kind → `onCataclysm` → `meteors.strike`.

## 6. Risks & fallback

- **Biggest risk — the healing crater on displaced, rotating terrain.** Aemunis's surface is vertex-displaced (planet.js), so a flat decal can float/clip on mountains, and it must read as "scorched, healing" without looking like it damaged a nearby structure. **Mitigation:** build it exactly like the flood patch (which already sits convincingly on displaced terrain and heals), keep it small-radius, purely additive-dark alpha, no displacement. **Fallback:** if conforming still clips badly, drop to a flat ground-hugging ring sprite billboarded to the surface normal + a short additive debris puff — skip the conforming decal entirely; the flash + streak carry the spectacle, and the ring still "heals" by fading.
- **Secondary risk — force-push/revert detection (Task G).** `gitinfo.js` has no reflog/force heuristic today and false positives would fire random meteors. Keep G optional and behind a conservative heuristic; the **click path is the primary, reliable trigger** and ships without it.
- **Fast-sun at extreme speeds** could make eclipse/aurora strobe. Clamp max to 600× and, if strobing shows, ease `sunSpeed` changes over ~0.3s rather than stepping.
