# E-DEPLOY — repo hygiene, README, GIF shot-list, and clean-Electron deployment acceptance

Final ship-hygiene wave for Sekai (the sessions-as-civilization 3D planet). It closes the single biggest gap — there is NO README.md — by writing a full, properly grouped README with hero + inline GIF placeholders, feature list, tech stack, run instructions, how-it-works (sessions→civilization, deterministic-from-transcripts, the covenant), roadmap/status, and CC0 credits. It makes a low-risk structure call: KEEP src/ FLAT (37 modules, but main.js is architect-owned with ~35 relative imports plus intra-src cross-imports — any regroup is high-risk, near-zero benefit at ship) and document the module map instead. It creates docs/media/ for curated README GIFs (distinct from gallery/, the WIP archive kept forever), delivers an exact browser-automation GIF SHOT-LIST (6 scenes, each with camera setup via verifykit.gotoViewpoint + god-control triggers) for the architect to record, fixes one stale doc reference (public/textures/SOURCES.md still cites onBeforeCompile — the codebase is now 100% TSL), and delivers a 'clean Electron app' deployment checklist that flags the real packaging decision: electron/main.cjs today loads the Vite DEV server, so a distributable needs either bundled node+vite-spawn or a `vite build` dist served locally.

GIF SHOT-LIST (recorded by the architect via browser automation at seed=aetherion-1, forceWebGL/WebGL2 backend, 1280x720, ~6-8s loops, optimized to <4MB each, saved to docs/media/): (1) hero-globe-spin.gif — full globe in starfield; `verify.gotoViewpoint('orbit')` then `controls.autoRotate=true; controls.autoRotateSpeed=0.4`, one ~7s revolution slice, loop-clean. (2) dive-to-ocean.gif — scripted dolly from orbit radius ~3 down to ~1.08 over a coast, ending on Gerstner swell + breaking foam; tween camera.position toward `verify.gotoViewpoint('mid-coast')`'s target over 6s (ease in/out), keep controls.target at origin. (3) raid-battle.gif — NPC-civ conflict; `verify.seekTime(t)` to a war/raid window between two adjacent civs (read positions off window.__planet.civSim/civRender), camera framed low over the two settlements; the conflict is additive and heals (covenant). (4) weather-hurricane.gif — `verify.gotoViewpoint('storm')` (auto-seeks a mature storm), oblique frame of the volumetric hurricane eye + eyewall + rain, 8s. (5) fast-sun-daynight.gif — `verify.gotoViewpoint('night-city')` then drive the god-control sun speed to 600x (window.__planet.sky.setSunSpeed(600) if the god-hooks shipped, else the ⚡ GOD panel slider); 6s captures ~4 terminator sweeps with town-lights + aurora igniting night-side; reset speed to 1 after. (6) dragon-airships.gif — frame the dragon's lair on the tallest peak (read window.__planet.dragon world position), capturing the dragon in Flying state + an airship cruising a nearby route, 8s. Each shot: fixed seed, disable the HUD/sidebar via photo mode (ui photo-mode toggle) for a clean plate, record with mcp gif_creator, drop into docs/media/ under the exact filename the README embeds.

## New files

### `README.md`
The repo front door — currently missing entirely. Full project README rendered on GitHub: title + one-liner, hero GIF, what-it-is, grouped feature list with inline GIFs, tech stack, run instructions (browser + desktop), how-it-works, repository layout (flat module map), roadmap/status, CC0 credits, license note.

**Contract:** Markdown document. Section order: H1 title + tagline; hero GIF (docs/media/hero-globe-spin.gif); 'What it is'; 'Features' with five H3 subsections — Terrain & ocean / Sky & atmosphere / Weather & life / World-sim (sessions -> civilization) / Conflict & cataclysm — each 4-8 bullets naming the real module, with one inline GIF per major group (dive-to-ocean, weather-hurricane, raid-battle, fast-sun-daynight, dragon-airships); 'Tech stack' (three.js r185 WebGPURenderer, TSL node materials, node PostProcessing, Vite + middleware API, Electron, zero-dep Node server); 'Run it' (npm install; npm start for browser at :5173; npm run app for desktop; ?seed= and ?renderer=webgpu URL params; Node 24 + Chromium); 'How it works' (the sessions->world mapping table copied from DESIGN.md, deterministic-from-transcripts, THE COVENANT); 'Repository layout' (flat src/ grouped conceptually into render/world/sim/weather with a note that files are flat and main.js owns the imports); 'Status & roadmap' (feature-complete epilogue; links ROADMAP.md + docs/superpowers/plans/ as historical); 'Credits' (CC0: ambientCG textures, Kenney Fantasy Town Kit, Quaternius Medieval Village + Dragon; three.js; simplex-noise; links to public/*/SOURCES.md); 'License'. Full copy-paste content is in buildTask BT1.

### `docs/media/`
New directory holding the curated README GIF assets. Distinct from gallery/ (the making-of/WIP archive kept forever by CONTRIBUTING rule) — docs/media/ holds only the polished, size-optimized GIFs the README embeds so they render on GitHub.

**Contract:** Directory. Will contain: hero-globe-spin.gif, dive-to-ocean.gif, raid-battle.gif, weather-hurricane.gif, fast-sun-daynight.gif, dragon-airships.gif — all produced by the architect's browser-automation recording pass per the SHOT-LIST, each <4MB, 1280x720, loop-clean. A .gitkeep + SHOT-LIST.md land first (BT2) so the dir exists and the recording plan is checked in before the binaries.

### `docs/media/SHOT-LIST.md`
The exact browser-automation recording plan for the six README GIFs — the architect follows this to record with mcp gif_creator. Checked-in doc, not a report.

**Contract:** Markdown. One H2 per shot (hero-globe-spin, dive-to-ocean, raid-battle, weather-hurricane, fast-sun-daynight, dragon-airships). Each shot lists: output filename, target seed (aetherion-1), backend (WebGL2/forceWebGL), resolution (1280x720), duration/loop, the exact verifykit/window.__planet calls for the camera setup, the trigger (god-control or seekTime), and the photo-mode/HUD-hide step. Common preamble: fixed seed, photo mode on, pixelRatio note. Full content in buildTask BT2.

### `docs/DEPLOYMENT.md`
The 'clean Electron app' acceptance checklist plus the packaging decision the architect must make (dev-server vs built dist). Turns the acceptance criteria into a checklist doc the packaging pass can tick.

**Contract:** Markdown. Sections: 'Pre-flight' (npm test + npm run build + CI green); 'Launch checks' (npm run app opens window, spawns dev server if absent, console prints [sekai] renderer backend: WebGL2, backgroundThrottling verified by unfocusing and confirming animation continues); 'UI surface' (HUD/stats/herald/sidebar/GOD panel present and interactive; Resume-session opens a Terminal running claude --resume; cmd-K palette works); 'Data' (reads ~/.claude/projects, degrades gracefully when empty); 'Known-benign console' (list); 'PACKAGING DECISION' (electron/main.cjs currently loads the Vite DEV server at localhost:5173 — for a distributable choose (a) ship node+vite and spawn it, or (b) point loadURL at a `vite build` dist via a bundled static file server / file://; note the public/ models+textures and three addons must be included; note node_modules is a worktree symlink so electron-builder must resolve the real tree); 'Bundle' (app name Sekai, icon, macOS hiddenInset titlebar, dock presence). Full content in buildTask BT3.

## Modified files

### `public/textures/SOURCES.md`
Fix the stale engine reference in the intro paragraph. Replace 'triplanar detail splat (`src/planet.js`, `terrainMat.onBeforeCompile`)' with 'triplanar detail splat (`src/planet.js`, a TSL node material)'. Rationale: the codebase migrated off onBeforeCompile/ShaderMaterial to TSL under WebGPURenderer (onBeforeCompile is banned and non-functional there); the parenthetical now describes machinery that no longer exists. Text-only doc fix, no code, no other lines touched.

### `DESIGN.md`
OPTIONAL (nice-to-have, low priority): add a one-line banner under the H1 pointing to the new front door, e.g. a blockquote '> New here? Start with the [README](README.md). This file is the deeper design rationale.' DESIGN.md predates the README and its intro overlaps it; the banner makes the README the canonical entry point without deleting the design history. Skip if scope-trimming.

## main.js wiring
N/A — E-DEPLOY changes no runtime code. src/main.js is untouched: no imports added, no scene.add() calls, no update(dt) lines. This wave is documentation, repository hygiene, and deployment acceptance only. The complete feature list documented in the README was read directly out of the existing main.js integration block (lines 5-34 imports, 59-161 create/scene.add, 293-342 update loop) and the 37 src/ module headers — nothing new is wired in. The only executable-surface touch is the architect's GIF recording pass, which drives the ALREADY-WIRED window.__planet.verify (gotoViewpoint/seekTime) and the existing ⚡ GOD-panel controls from the browser console; it adds no code.

## Determinism
No new world-state code is introduced, so there is nothing new to seed and no Math.random/Date.now is added anywhere. The README documents the existing determinism contract verbatim: every position is a pure function of (seed, project path, session id) hashed through src/util.js (rngFromString/hash01/makeNoise3D); the transcript files are the persistence (no database); the same seed (default 'aetherion-1', override via ?seed=) rebuilds the identical planet every launch. The GIF recording pass is itself deterministic-by-construction: it runs at a fixed seed on the WebGL2 backend and positions the camera through verifykit.gotoViewpoint (viewpoints computed live from scene state) and verifykit.seekTime (a presentation-only dt fast-forward — the ONLY allowed time source, accumulated in update(dt)); god-control triggers (meteor/earthquake/hurricane/aurora/eclipse/fast-sun) are the documented interactive exemption and every visual they emit is still seeded off seed+':'+counter, never Math.random. I verified the repo adds no banned calls: this wave writes only .md files.

## Covenant
N/A for a docs/hygiene wave — no simulation code is added or changed, so no session structure can be touched. Two documentation touchpoints reinforce the covenant rather than risk it: (1) the README's 'How it works' section states the covenant explicitly — session structures are immutable history; simulation, conflict, and cataclysm are ADDITIVE (they happen around the record, leave marks — decals, banners, ruins-props — and ALWAYS heal). (2) The GIF SHOT-LIST's raid-battle and cataclysm shots are recorded by driving god-controls / civ-sim that are themselves covenant-safe (meteor craters, floods, volcano lava, and NPC-civ conflict all fade/heal and never move or destroy a session building); the recording pass only reads world state and drives the camera. Nothing in this wave writes to world.js/civsim state.

## Risks
- STRUCTURE MOVE IS A TRAP (why we KEEP FLAT): src/main.js is architect-owned and carries ~35 relative imports (./planet.js ...), plus heavy intra-src cross-imports (world.js -> buildings/placement/labels/cameraFeel; flood.js -> storms; events/herald -> world; clouds -> storms/sky/planet; caravans/roads/trails/civrender -> world/planet). Regrouping into src/render|world|sim|weather would have to rewrite every one of those import paths AND the window.__planet/verifykit bags in one commit, with no functional payoff at ship time. Recommendation: KEEP FLAT, document the module map in the README. Do NOT attempt the move in this wave.
- PACKAGING GAP (highest deployment risk): electron/main.cjs loads the Vite DEV server (http://localhost:5173) and spawns `npm run dev` if it isn't running. That is fine for `npm run app` on the dev machine but NOT a self-contained distributable — a packaged .app would need node + the full dev toolchain present. Before shipping a real Electron build the architect must decide: (a) bundle node+vite and keep spawning dev, or (b) load a `vite build` dist (file:// or a tiny bundled static server) and drop the dev-server dependency. Flagged in docs/DEPLOYMENT.md; out of scope for a builder (electron/main.cjs is architect-only).
- node_modules is a SYMLINK to ~/sekai/node_modules (worktree convenience). electron-builder / any packaging step must resolve the REAL module tree, not follow/copy a dangling symlink; verify the packaged app contains three r185 + addons and simplex-noise.
- GIF weight vs README rendering: GitHub renders relative-path GIFs, but six unoptimized screen-captures could bloat the repo. Cap each at <4MB (1280x720, ~6-8s, palette-optimized) and commit only the curated docs/media/ set — never dump raw captures. gallery/ stays the archive; docs/media/ stays curated.
- Stale doc drift: public/textures/SOURCES.md still says the splat runs via `terrainMat.onBeforeCompile` — false since the TSL migration (onBeforeCompile is banned and non-functional under WebGPURenderer). One-line fix (BT4). Left unfixed it misleads any contributor reading asset provenance. Low risk, easy fix.
- README asset ordering: the README embeds docs/media/*.gif that do not exist until the architect records them. Land BT1 (README) + BT2 (SHOT-LIST + .gitkeep) together so the doc refers to a real directory; the GIFs fill in on the recording pass. Until then the img tags show broken-image placeholders — acceptable for an internal draft, but the README should NOT be presented as done until the six GIFs land.
- LICENSE: there is no LICENSE file and the repo is private/personal. The README's Credits/License section states the code is the owner's and the bundled art is CC0 (with per-pack SOURCES.md links); if the repo is ever made public, add an explicit LICENSE file — noted, not added, since it's an owner policy call.
- *.md is in .prettierignore, so README.md/DEPLOYMENT.md/SHOT-LIST.md are exempt from CI's `prettier --check .` — good (prose shouldn't be auto-formatted), but it also means malformed markdown won't be caught by CI. Proofread the README manually before merge.

## Acceptance
- README.md renders on GitHub with no broken sections: H1 tagline, hero GIF at top, the five feature H3 groups, tech stack, run instructions, how-it-works with the sessions->world table, repository layout, roadmap, credits, license — all present and correctly nested.
- Every relative link in the README resolves in the repo: docs/media/*.gif (6 files), ROADMAP.md, DESIGN.md, CONTRIBUTING.md, docs/superpowers/plans/, public/textures/SOURCES.md, public/models/SOURCES.md.
- All six curated GIFs exist in docs/media/, each <4MB, 1280x720, loop-clean, and visibly show their scene (globe spin; dive to breaking-foam ocean; a healing NPC-civ raid; volumetric hurricane eye; terminator sweep with town-lights/aurora; dragon + airship over the peak).
- `npm install && npm start` opens the app at http://localhost:5173, the planet renders, and the console prints `[sekai] renderer backend: WebGL2` with no red errors (only known-benign warns).
- `npm run app` opens a native Electron window titled 'Sekai' (spawning the dev server itself if it wasn't running), shows the same planet, and — with the window unfocused/hidden — the planet KEEPS animating (backgroundThrottling:false confirmed).
- `npm test` (scanner + geometry suites) and `npm run build` both pass clean, and CI (prettier --check, eslint, node --check, tests, build) is green on the PR.
- In the running app the GOD panel triggers work for the shot-list (meteor strike, hurricane summon, aurora/eclipse, sun-speed 600x) and the sidebar 'Resume session' opens a Terminal running `claude --resume`.
- public/textures/SOURCES.md no longer references onBeforeCompile — it describes the splat as a TSL node material in src/planet.js.
- docs/DEPLOYMENT.md exists and its 'PACKAGING DECISION' section is filled in with the chosen path (dev-server-spawn vs built-dist) before any distributable .app is produced.

## Build tasks

### BT1 — Write README.md (full front-door content)
files: README.md

Create README.md at the REPO ROOT (not in src/). Write the following complete markdown verbatim. It documents the existing app; do not invent features — every module named below is real (verified in src/ and main.js). Note *.md is in .prettierignore so this file is not auto-formatted; keep it clean by hand.

---

# Sekai

**A living fantasy planet, built from your Claude Code sessions.**

Launch it and a stylized world floats in a starfield — continents, snowy poles, oceans with breaking waves, drifting cloud decks, a resident dragon overhead. Every Claude Code session you have ever run is a building somewhere on it. Every session running *right now* is a tiny person out there, hammering on their building. Not Earth — its own world, its name generated from the seed.

![Sekai — the globe in space](docs/media/hero-globe-spin.gif)

## What it is

Sekai reads Claude Code's own transcript files (`~/.claude/projects/**/*.jsonl`) — no hooks, no setup, nothing to install into your workflow — and renders your entire session history as a persistent, deterministic 3D world. Projects become settlements; sessions become buildings; live sessions become working figures. Because the transcripts persist, the world persists: the same seed rebuilds the identical planet every launch. It runs in a browser tab (`npm start`) or as a desktop app (`npm run app`).

## Features

### Terrain & ocean
- Procedural continents from seeded 3D noise — ridged mountain chains, irregular snowy polar caps, a flat-shaded faceted look (realistic shapes, stylized surface). `planet.js`
- Per-biome triplanar detail splat blended from four CC0 PBR materials (grass / rock / ground / snow). `planet.js` + `public/textures`
- A visibly moving ocean: long rolling swell, crest-pinched Gerstner waves, and white foam where waves break on low coasts. `ocean.js`
- Polar sea ice — matte freeze caps with torn noise edges, pressure cracks, and drifting floes. `seaice.js`

![Dive to the ocean surface](docs/media/dive-to-ocean.gif)

### Sky & atmosphere
- ~10k stars and a milky-way band, a visible sun, and two small moons on inclined orbits. `sky.js`
- A day/night cycle — the terminator sweeps the globe; town-lights and a night-side aurora ignite on their own. `sky.js` + `world.js`
- Screen-space single-scattering atmosphere: the sunrise/sunset limb crescent and aerial-perspective haze over terrain. `atmosphere.js`
- Volumetric raymarched clouds and a true 3D hurricane with a punched eye you can see the ocean through. `clouds.js`
- Cinematic post: bloom over the sun/rim/emissives, plus an interleaved-gradient dither that kills banding in dark gradients. `main.js`

### Weather & life
- Camera-local snow and rain, driven by the sky's real cloud coverage and the ground biome (snow at the poles/altitude, rain elsewhere). `weather.js`
- Hurricanes that drift across the ocean, spin up, and dissipate over land — ISS-photo look — with coastal flooding at landfall that drains and heals. `storms.js` + `flood.js`
- Wind streaks that hug the terrain and race forward. `wind.js`
- Articulated low-poly birds flocking in V-formation, wings flapping in the vertex shader. `birds.js`
- Breath-of-the-Wild grass following the camera, plus a Poisson-scattered forest and rocks. `flora.js`
- Roaming wildlife herds grazing on grassland. `wildlife.js`
- Sea life — whale pods that spout and breach, dolphin pods porpoising along the coast. `sealife.js`

![A hurricane over the ocean](docs/media/weather-hurricane.gif)

### World-sim — sessions become a civilization
- Settlements = projects, buildings = sessions, tiny working people = sessions active in the last few minutes. Building type comes from the session's topic (bugfix → barracks, data → farm, research → observatory, docs → library, deploy → forge, UI → hall, else tower); tier comes from transcript size; race/palette comes from project identity. `world.js` + `buildings.js` + `assets.js`
- Every structure in the world renders from a handful of `BatchedMesh` draw calls using CC0 building kits. `assets.js`
- Footprint trails stamped in snow behind walking figures. `trails.js`
- Steampunk airships flying seeded great-circle routes between related settlements, mooring nose-first at dock masts. `airships.js`
- Trade caravans and coastal boats plodding along seeded routes. `caravans.js`
- Roads and bridges between related settlements, draped over the terrain. `roads.js`
- NPC civilizations in five distinct archetypes (desert adobe, seafaring docks, mountain holds, elven treehouses, brass towers) that coexist with — and never overlap — your session settlements. `civsim.js` + `civrender.js`
- A resident dragon living at a lair on the tallest peak. `dragon.js`
- Git charm: commits become fireworks, merged PRs become monuments. `events.js` + `server/gitinfo.js`
- The Aemunis Herald — a medieval-chronicle news ticker woven from your real session and git activity. `herald.js`
- Click a building for a session inspector, jump with a cmd-K palette, switch on photo mode, and resume a session in a fresh Terminal. `ui.js` + `server/resume.js`

![An NPC raid — additive, and it heals](docs/media/raid-battle.gif)

### Conflict & cataclysm (god-controls)
A small GOD panel exposes user-driven spectacle. All of it honors **the covenant** (below): it is additive, leaves marks, and always heals — it never moves or destroys a session building.
- Meteor strikes — a falling streak, a bloom-catching flash, and a scorch crater that cools and heals. `meteor.js`
- Earthquakes — an expanding shockwave ring, a dust puff, and a decaying camera shake. `earthquake.js`
- Volcanoes — seeded eruption cycles whose lava glow fades back to dark rock each cycle. `volcano.js`
- Fast-sun, summon-hurricane, call-aurora, trigger-eclipse. `sky.js` + `storms.js`

![Fast-sun: day, night, aurora](docs/media/fast-sun-daynight.gif)

![The dragon and an airship over the peak](docs/media/dragon-airships.gif)

## Tech stack
- **three.js r185 `WebGPURenderer`** — WebGL2 backend by default (the proven host where every material renders); true WebGPU is opt-in via `?renderer=webgpu`.
- **TSL node materials** — every shader is a `*NodeMaterial` built from `three/tsl` nodes; no GLSL, no `ShaderMaterial`, no `onBeforeCompile` (none of which run under `WebGPURenderer`). Node graphs are built once and animated only via `uniform()` writes.
- **Node `PostProcessing`** — bloom + dither, composited scene → scattering → clouds → bloom.
- **Vite** dev server with a tiny middleware API (`/api/sessions`, `/api/events`, `/api/resume`).
- **Electron** — the desktop shell (`backgroundThrottling:false`, so the planet never pauses).
- **Zero-dependency Node** for the server layer (`node:fs` / `node:child_process` only).

## Run it
```bash
npm install
npm start      # browser: opens http://localhost:5173
npm run app    # desktop: native Electron window (spawns the dev server if needed)
```
Requires Node 24 and a Chromium-based browser. URL params: `?seed=anything` for a brand-new planet, `?renderer=webgpu` to try the true-WebGPU backend.

## How it works
The app turns your terminal history into geography:

| In your terminal | On the planet |
|---|---|
| A project (working directory) | A **settlement**, always at the same spot |
| One session | One **building**, labeled with its topic |
| Session topic | Building type (barracks / farm / observatory / library / forge / hall / tower) |
| Session length | Building tier (tent → house → grand) |
| Session active now | A tiny **person** at work |
| A brand-new session | Construction: scaffolding, building rising |
| Project identity | A fantasy **race** — colors and name suffix |

Everything is placed deterministically by hashing project paths and session ids against seeded terrain (`src/util.js`). There is no database — **the transcript files are the persistence**, and positions are pure functions of `(seed, project, session id)`. The client polls `/api/sessions` for live activity.

**The covenant.** Session structures are immutable history. The simulation may never destroy, move, or overwrite them. Conflict and cataclysm are *additive*: they happen around the record, leave marks (decals, banners, ruins-props), and always heal.

## Repository layout
`src/` is intentionally **flat** — the modules group conceptually, but `main.js` (the one integration point) imports them by relative path, so they live side by side:

- **Render / terrain**: `planet` · `ocean` · `sky` · `atmosphere` · `clouds` · `env`
- **World-sim**: `world` · `buildings` · `assets` · `placement` · `labels` · `civsim` · `civrender` · `airships` · `caravans` · `roads` · `trails` · `events` · `herald` · `dragon`
- **Weather & life**: `weather` · `storms` · `flood` · `wind` · `seaice` · `birds` · `flora` · `wildlife` · `sealife`
- **Cataclysm**: `volcano` · `meteor` · `earthquake`
- **Shell / infra**: `main` · `ui` · `ui.css` · `cameraFeel` · `util` · `verifykit`
- **Server** (`server/`): `scan` (transcript scanner) · `gitinfo` (git events) · `resume` (resume a session)
- **Shell** (`electron/main.cjs`), **assets** (`public/models`, `public/textures` — see each folder's `SOURCES.md`).

See `DESIGN.md` for the design rationale and `CONTRIBUTING.md` for the engineering standards.

## Status & roadmap
Feature-complete. `ROADMAP.md` and `docs/superpowers/plans/` are kept as historical planning records (the roadmap is marked superseded — read it for the Godot/Tauri/Electron rationale, not for open work).

## Credits
All bundled art is **CC0 (public domain)**:
- Ground textures — [ambientCG](https://ambientcg.com) (Grass004, Rock030, Ground080, Snow006). See `public/textures/SOURCES.md`.
- Building kits — [Kenney Fantasy Town Kit](https://kenney.nl/assets/fantasy-town-kit) and [Quaternius Medieval Village MegaKit](https://quaternius.com). See `public/models/SOURCES.md`.
- Dragon — [Quaternius "Dragon"](https://quaternius.com) (CC0).

Built on [three.js](https://threejs.org) and [simplex-noise](https://github.com/jwagner/simplex-noise.js).

## License
The application code is the owner's; all bundled third-party assets are CC0 as credited above. (No open-source LICENSE file is included — this is a personal project.)

---

Write exactly that. Do not add a Claude/AI attribution footer of any kind.

### BT2 — Create docs/media/ with SHOT-LIST.md and .gitkeep
files: docs/media/SHOT-LIST.md, docs/media/.gitkeep

Create the directory docs/media/ (it does not exist yet). Add docs/media/.gitkeep (empty file) so the directory is tracked before the GIF binaries land. Then write docs/media/SHOT-LIST.md — the browser-automation recording plan the architect follows to produce the six README GIFs with the mcp gif_creator tool. This is a checked-in planning doc, not a report. Write this content:

---

# README GIF shot-list

Six curated GIFs embedded by README.md. Recorded via browser automation against the running dev server. These are the *polished* README assets — the WIP/making-of archive lives in `gallery/`, kept separate.

## Common setup (every shot)
- Seed: `aetherion-1` (the default — do NOT pass `?seed`). Backend: WebGL2 (default `forceWebGL`; do NOT pass `?renderer=webgpu`). Confirm the console logs `[sekai] renderer backend: WebGL2`.
- Resolution: 1280x720. Duration: 6-8s, loop-clean. Optimize each to <4MB (palette + frame-rate reduction).
- Turn ON photo mode (the ui.js photo-mode toggle) to hide the HUD/hint and get a clean plate; the sidebar/herald can be dismissed too.
- Drive the camera from the browser console via the already-wired handles: `window.__planet.verify` (`gotoViewpoint(name)`, `seekTime(t)`), `window.__planet.controls`, `window.__planet.camera`, `window.__planet.sky`, `window.__planet.dragon`, `window.__planet.civSim` / `window.__planet.civRender`.

## 1. hero-globe-spin.gif  (top of README)
- `window.__planet.verify.gotoViewpoint('orbit')`
- `const c = window.__planet.controls; c.autoRotate = true; c.autoRotateSpeed = 0.4`
- Record one clean ~7s revolution slice so the loop seams. Full globe in the starfield, terminator visible.

## 2. dive-to-ocean.gif  (Terrain & ocean)
- Start at `gotoViewpoint('orbit')`. Read the target of `gotoViewpoint('mid-coast')` (a sunlit coastline near the surface), then tween `camera.position` from orbit radius (~3) down to ~1.08 over that coast across 6s with an ease-in/out. Keep `controls.target` at the origin (never panned).
- The payoff frame: Gerstner swell and breaking white foam along the shore.

## 3. raid-battle.gif  (World-sim)
- NPC-civ conflict (additive, heals — the covenant). Use `window.__planet.civSim` to find two adjacent civs, and `window.__planet.verify.seekTime(t)` to fast-forward to a raid/war window between them.
- Frame the camera low over the two settlements (read positions off `civRender`). Show the conflict props and the mark healing back.

## 4. weather-hurricane.gif  (Weather & life)
- `window.__planet.verify.gotoViewpoint('storm')` — auto-seeks a mature storm. Nudge to an oblique angle if needed.
- 8s of the volumetric hurricane: dense core, dark eye, bright eyewall, rain beneath.

## 5. fast-sun-daynight.gif  (Conflict & cataclysm / god-controls)
- `window.__planet.verify.gotoViewpoint('night-city')`.
- Drive the sun fast: `window.__planet.sky.setSunSpeed(600)` if the god-hooks shipped, else open the ⚡ GOD panel and drag the sun-speed slider to 600x.
- 6s captures ~4 terminator sweeps; town-lights and the night-side aurora ignite. Reset with `setSunSpeed(1)` afterward.

## 6. dragon-airships.gif  (World-sim)
- Read the dragon lair from `window.__planet.dragon` (world position on the tallest peak) and frame the camera on it.
- 8s capturing the dragon in its Flying state plus an airship cruising a nearby route.

## After recording
Drop each file into `docs/media/` under the EXACT filename above (README.md embeds these paths). Verify each renders inline on GitHub and is <4MB.

---

Write exactly that.

### BT3 — Write docs/DEPLOYMENT.md (clean-Electron acceptance + packaging decision)
files: docs/DEPLOYMENT.md

Write docs/DEPLOYMENT.md — the 'clean Electron app' acceptance checklist and the one packaging decision the architect must make. Checked-in doc. Content:

---

# Deployment — clean Electron app

Checklist for shipping Sekai as a desktop app. Tick every box before producing a distributable.

## Pre-flight
- [ ] `npm test` green (scanner + geometry suites).
- [ ] `npm run build` clean.
- [ ] CI green on the PR (prettier --check, eslint, `node --check` sweep, tests, build).

## Launch checks (`npm run app`)
- [ ] A native window titled **Sekai** opens (1680x1050, macOS hiddenInset titlebar, dark `#04060c` background).
- [ ] If the dev server was not already running, the shell spawns it and waits (up to 30s), then loads it; if it never comes up, the window shows the plain-text fallback message instead of a blank screen.
- [ ] The planet renders and the console logs `[sekai] renderer backend: WebGL2`.
- [ ] **backgroundThrottling off**: unfocus / hide the window, wait, refocus — the planet kept animating the whole time (no pause/jump).

## UI surface
- [ ] Title, stats HUD, and the Aemunis Herald ticker are present.
- [ ] Sidebar (settlement browser + legend) opens; the ⚡ GOD panel triggers work (meteor, hurricane, aurora, eclipse, sun-speed).
- [ ] cmd-K jump-to-settlement palette works; photo mode toggles cleanly.
- [ ] **Resume session**: clicking it opens a new macOS Terminal window running `claude --resume <id>` in the project directory.

## Data
- [ ] The app reads `~/.claude/projects/**/*.jsonl` and builds settlements from real sessions.
- [ ] With an empty/absent projects dir it degrades gracefully (no crash; an empty-but-alive world).

## Known-benign console
- [ ] Backend log line (above). Any TSL/WebGPU warns that are documented-benign. No red errors, no uncaught exceptions.

## PACKAGING DECISION (resolve before building a distributable)
`electron/main.cjs` currently loads the **Vite dev server** at `http://localhost:5173` and spawns `npm run dev` if it is not running. That is correct for `npm run app` on a dev machine, but a shipped `.app` cannot assume node + the dev toolchain are present. Choose one:
- **(a) Ship dev-server-spawn** — bundle node and the dev deps, keep spawning `npm run dev`. Simplest code change, largest bundle, slowest cold start.
- **(b) Load a built dist** — run `vite build`, and point `loadURL` at the built output via a bundled tiny static server (or `file://`), dropping the dev-server dependency. Smaller, faster, but the middleware API (`/api/sessions`, `/api/events`, `/api/resume`) must be re-hosted by a small bundled server since Vite middleware won't be running.

Either way verify the bundle includes: three r185 + its addons, `simplex-noise`, and the `public/` assets (`models/`, `textures/`). Note `node_modules` in the worktree is a **symlink** to `~/sekai/node_modules` — electron-builder must resolve the real tree, not the symlink.

## Bundle
- [ ] App name **Sekai**, an app icon set, dock presence, the macOS menu (about/quit/reload/devtools/fullscreen) from `buildMenu()`.
- [ ] Chosen packaging path (a or b) recorded here: __________.

---

Write exactly that. `electron/main.cjs` and `src/main.js` are architect-only — do NOT edit them; this task only writes the doc.

### BT4 — Fix the stale onBeforeCompile reference in public/textures/SOURCES.md
files: public/textures/SOURCES.md

In public/textures/SOURCES.md, fix one stale engine reference. Find the intro sentence that reads: 'used for the terrain's triplanar detail splat (`src/planet.js`, `terrainMat.onBeforeCompile`). All four are CC0 (public domain):' and change the parenthetical so it reads: 'used for the terrain's triplanar detail splat (`src/planet.js`, a TSL node material). All four are CC0 (public domain):'. Rationale: the codebase migrated off `onBeforeCompile`/`ShaderMaterial` to TSL node materials under `WebGPURenderer` (where onBeforeCompile does not run) — the old parenthetical describes machinery that no longer exists. Change ONLY that parenthetical; leave every other line, table, and the file's byte-footprint notes untouched. Do not touch src/planet.js.
