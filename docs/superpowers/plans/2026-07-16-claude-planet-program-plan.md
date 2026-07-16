# Claude Planet — Program Plan (v0.9 DRAFT, pending adversarial audit)

> **For agentic workers:** This is the PROGRAM plan (milestones, gates, budgets).
> Execution happens milestone-by-milestone: at each milestone start, write a
> just-in-time execution plan in the superpowers:writing-plans bite-sized task
> format, then implement via superpowers:subagent-driven-development with
> sonnet subagents. Do not build ahead of the active milestone.

**Goal:** Evolve Claude Planet from a beautiful toy into a high-fidelity,
always-running desktop world that visualizes all Claude Code activity as a
living civilization — without ever breaking the fast build loop.

**Architecture:** Vite + three.js app, session data from `~/.claude/projects`
transcripts (no database until M7), deterministic world derived from (seed,
project, session-id) hashes. Migration path: minimal Electron shell early →
TSL material port on the WebGL bridge → WebGPURenderer flip → compute-shader
flagships (ocean/clouds/erosion) → shell plumbing → living-world features.

**Tech stack:** three.js 0.185+ (WebGLRenderer → WebGPURenderer + TSL),
Electron (shell), Vite (dev/build), Node ESM backend modules (scanner,
resume), CC0 assets (ambientCG, Kenney/Quaternius), sonnet subagents for all
construction, Fable session as architect/integrator/verifier.

---

## 0. Operating model (standing rules)

- **Roles:** Fable session = architecture, contracts, integration, live
  verification, PR management. Sonnet subagents = ALL construction, on
  disjoint file sets with contracts pinned in their prompts.
- **Workflow:** one branch + draft PR per milestone batch → `gh pr ready` →
  self-merge. No review gate (solo project, user-approved).
- **Verification protocol (every milestone, before merge):**
  1. `node --check` on all touched files; `npm test` green.
  2. Live drive in the running app; screenshots at 5 standard viewpoints:
     full-orbit, mid-zoom coast, ground-level sunlit, night city, storm.
  3. Perf probe: `renderer.info` draw calls + a 5s frame-time sample ≥ 55fps
     on the dev machine at 1680×1050.
  4. Determinism spot-check: reload twice, same seed → same world.
- **Budget currency:** 1 unit = one sonnet builder run (observed today:
  100k–290k tokens, median ~130k). Estimates below are in builder-runs; the
  audit should challenge them.
- **Change control:** after audit + user sign-off, this plan is v1.0. Scope
  changes = PR editing this file with a one-line rationale in the commit.

## 0.5 Art direction (user call, 2026-07-16): medieval × steampunk

- **Base world = deeply medieval:** stone keeps, timber halls, thatch, banners,
  torchlight. The terrain/nature stack stays natural-stylized.
- **Steampunk = the language of activity.** Progress and scale express as
  machinery: active/large sessions sprout brass gearworks, steam vents, glass
  observatory domes, pressure tanks; the busiest projects earn tesla-spire /
  great-engine landmarks. Steam & smoke plumes join city lights as the "this
  place is alive" signal.
- **Race flavor:** dwarves = full industrial steampunk (pistons, chimneys,
  riveted brass); humans = medieval with clockwork guild-craft (astrolabes,
  brass trim); elves = organic medieval, steampunk only as elegant filigree;
  orcs = scrap-punk (bolted iron, black smoke).
- **Palette accents:** brass #b0793a / copper #c98d4a / aged-bronze patina
  #5e7d6a over the existing muted-saturated base.
- **Dragons are canon** (not a rare easter egg): at least one resident dragon
  with a mountain lair from M8; appearances tied to milestones/events.
- **Airships over ships:** the M8 traversal layer becomes dirigibles on
  great-circle routes between related settlements, steam trails behind.
- **M2 asset implication:** base buildings from CC0 medieval packs
  (Kenney/Quaternius); steampunk detailing as procedural bolt-on kit parts
  (gears/pipes/tanks/domes) since quality CC0 steampunk packs are scarce —
  audit should pressure-test this assumption.

## 1. Current state (baseline, 2026-07-16)

Shipped and merged (PR #1): seeded terrain (welded icosphere, biome bands:
desert/savanna/grass/forest/tundra/snow, CC0 texture splatting, per-pixel
detail), ocean (swell + glint), sky (stars/milky way/nebulae, 2 moons,
domain-warped cloud shells, sun orbit + moonlight, storm-clearing moat),
hurricanes (single, sun-seeking, planet-scale, spiral texture), flora (trees,
rocks; grass disabled by user verdict), wind streaks, birds, session scanner
(topics, ai-title, cache, tests), civilization layer (29 settlements, 250+
structures, 7 building types, 4 races, workers with states, construction,
city lights), sidebar+legend UI, click/UI fly-to, Dock launcher app, vignette
+ bloom. In flight on `planet-v1` (PR #2 draft): eclipses/aurora/meteors,
worker speech bubbles + sparks + subagent minions, building inspector +
resume endpoint + cmd-K + photo mode, minimal Electron shell.

Known debt: onBeforeCompile string-injection shaders (5 sites) — scheduled
for deletion in M3; primitive kit-bash buildings — replaced in M2; vite dev
server doubles as app backend — replaced in M7.

## 2. Milestones

### M0 — Land Batch-1 (IN FLIGHT)
- **Scope:** integrate + verify the 4 in-flight builders' work; merge PR #2.
- **Exit:** all Batch-1 features pass the verification protocol; eclipse
  frequency observed ≥ 1 per 30 min of sim time; "Resume session" opens
  Terminal and resumes the correct session (manually verified once).
- **Est:** already spent; +0 builder-runs (integration only). 1 session.

### M1 — Minimal Electron shell (moved early; user call)
- **Scope:** `npm run app` → Electron window (backgroundThrottling:false),
  spawns dev server if absent; Dock launcher repointed to Electron; browser
  path + `planet` alias keep working.
- **Explicit non-goals:** packaging/signing, auto-update, SQLite, watchers.
- **Exit:** planet animates while window is unfocused/hidden for 10 min
  (HUD clock advances); dev hot-reload works inside the shell; Chrome can
  still open the same URL for verification.
- **Risks:** Electron download size in repo tooling only (devDep). None
  architectural.
- **Est:** 1 builder-run (already launched) + glue. 1 short session.

### M2 — Beauty batch (assets + data-driven charm + time-lapse)
- **Scope:**
  1. **S4 spike first:** BatchedMesh with ~20k instances of GLTF low-poly
     parts — measure draw calls + fps. GO if ≥55fps.
  2. Replace kit-bash buildings + trees with curated CC0 packs
     (Kenney/Quaternius), per-race material palettes, tier = model variant.
  3. Git-driven charm: commit fireworks, PR monuments, error thunderclouds
     (data via `git log`/`gh` per project cwd, polled server-side).
  4. Model-tier architecture (transcript model ids → building style).
  5. Wonders at milestone counts (100/250/500 sessions).
  6. Time-lapse mode: timeline scrubber replaying structure appearance by
     transcript mtime order (client-side; no new data).
- **Exit:** settlement close-up screenshot is "screenshot-worthy" (user
  judgment); fireworks fire on a real commit within 60s; time-lapse replays
  the full history in ≤ 60s smoothly; fps budget holds.
- **Risks:** GLTF asset licensing hygiene (CC0 only, recorded in DESIGN.md);
  git polling cost per project (mitigate: only settlements with active
  sessions, 60s interval).
- **Est:** 6–8 builder-runs. 2 sessions.

### M3 — TSL port (kill the shader hacks) [GATE: S1]
- **Scope:** S1 spike: cloud-moat material ported to TSL running via
  `WebGLRenderer.setNodesHandler(WebGLNodesHandler)` alongside legacy
  materials. GO criteria: renders identically (screenshot diff), no fps
  regression >10%, coexists with untouched materials. Then port, one PR
  each: terrain splat → ocean swell → grass-wind (dormant) → aurora →
  storm/cloud materials. Delete every onBeforeCompile site.
- **Exit:** `grep -r onBeforeCompile src/` returns zero; visual parity at
  all 5 standard viewpoints; fps within 10% of baseline.
- **Risks:** bridge limitations bite (no compile(), fog quirks, instancing
  edge cases — flora uses InstancedMesh custom attrs!). Mitigation: S1
  explicitly tests an instanced custom-attribute material second.
  Fallback: A″ (stay WebGL2, keep hacks, fragment-shader flagships).
- **Est:** 1 spike + 5–6 builder-runs. 2 sessions.

### M4 — Renderer flip + post stack [GATE: S2]
- **Scope:** S2 spike: WebGPURenderer boots the scene with TSL materials
  from M3; measure fps. Then: flip renderer, rebuild post (bloom → TSL
  postprocessing, AgX tone mapping), fix regressions, keep a
  `?renderer=webgl` escape hatch for one milestone.
- **Exit:** WebGPU is default; all 5 viewpoints verified; fps ≥ WebGL
  baseline −10%; escape hatch works.
- **Risks:** WebGPU adapter issues on user's machine (unlikely, Apple
  Silicon Chrome/Electron); subtle color/tone shifts (accept + regrade).
- **Est:** 1 spike + 2–3 builder-runs. 1–2 sessions.

### M5 — Compute flagships (sequential, each its own PR)
- **Order:** (a) atmospheric scattering → (b) FFT ocean + foam →
  (c) volumetric clouds + hurricane (ambient cover cut ~70%) →
  (d) GPU erosion bake + rivers.
  Rationale: scattering is standalone + biggest whole-planet win; ocean next
  (bounded surface); clouds hardest visually; erosion changes terrain data
  contracts (sampleHeight) so it goes last.
- **Exit per flagship:** side-by-side before/after screenshots approved by
  user; fps ≥ 55 sustained at mid-zoom; determinism preserved (erosion bake
  cached to disk keyed by seed).
- **Risks:** clouds perf (mitigate: quarter-res raymarch + upsample,
  cap steps); erosion invalidates settlement placements (mitigate:
  placement re-derives from the SAME baked heightmap — bake becomes the
  single source of truth for sampleHeight).
- **Est:** 10–14 builder-runs. 4–6 sessions.

### M6 — Chunked LOD terrain
- **Scope:** cube-sphere quadtree, GPU-displaced patches from the M5 bake,
  crack-free stitching, streaming near camera; structures/flora unchanged
  (they sample the same height API).
- **Exit:** street-level coastline shows no polygonal silhouette at
  minDistance; full-orbit fps unchanged; memory < 1.5GB.
- **Risk:** biggest single engineering item in the program; if it slips, it
  slips alone (nothing depends on it).
- **Est:** 6–8 builder-runs. 2–3 sessions.

### M7 — Shell plumbing
- **Scope:** SQLite session index + FSEvents watcher (instant cold start,
  history analytics), packaged .app build (electron-builder, unsigned ok),
  auto-launch dev server retired in packaged mode (static build + local
  service), Dock launcher replaced by the packaged app.
- **Exit:** cold start < 3s to first frame; packaged app runs with the dev
  server off; scanner results identical to filesystem scan (test).
- **Est:** 4–5 builder-runs. 2 sessions.

### M8 — Living world
- **Scope:** airships & trade routes (medieval-steampunk traversal layer);
  ruins (deleted projects) + migration caravans (renamed); seasons (real
  calendar); volcano; resident dragon with lair + event appearances; whales/
  fish/herds; birds scatter; ambient sound; poster export; auto-tour.
- **Exit:** per-feature acceptance in its JIT plan; program complete.
- **Est:** 10–12 builder-runs. 3–4 sessions.

## 3. Dependency graph

```
M0 ─→ M1 ─→ M2 ──────────────┐
              │               ├─→ M8 (needs M2 assets; sound/tour anytime)
              └─→ M3 ─→ M4 ─→ M5 ─→ M6
                                └─→ M7 (independent of M5/M6; needs M4 only
                                        for packaged perf sanity — can start
                                        after M1 if sessions are spare)
```
Slack rule: M7 and parts of M8 are rainy-day work that can interleave when a
gate blocks the critical path.

## 4. Spike register (GO/NO-GO gates)

| Spike | Question | GO criteria | Owner | When |
|---|---|---|---|---|
| S1 | TSL-on-WebGL bridge viable incl. instanced custom attrs? | parity screenshots, fps −≤10%, coexists w/ legacy | 1 builder | M3 start |
| S2 | WebGPURenderer runs full scene at parity? | fps ≥ baseline−10%, no missing features | 1 builder | M4 start |
| S3 | Packaged Electron + WebGPU + watcher sane? | packaged app 60fps, watcher events < 1s | 1 builder | M7 start |
| S4 | BatchedMesh @ 20k GLTF instances? | ≥55fps, ≤ 30 draw calls for civ layer | 1 builder | M2 start |

## 5. Risk register (top items)

| # | Risk | L | I | Mitigation / trigger |
|---|---|---|---|---|
| 1 | TSL bridge fails on instanced/custom-attr materials | M | H | S1 tests it explicitly; fallback A″ (WebGL2 fragment-shader flagships) documented |
| 2 | Volumetric clouds can't hold 55fps | M | H | quarter-res march, step caps, blue-noise jitter; fallback: keep 2.5D shells + volumetric hurricane only |
| 3 | Erosion bake breaks placement determinism | M | M | bake = single height source; placements re-derive; version the bake file with seed+algo hash |
| 4 | Agent-written modules drift from contracts | M | M | contracts in prompts + integrator verification before merge (protocol §0) |
| 5 | Electron/WebGPU regression on OS update | L | M | `?renderer=webgl` escape hatch retained through M5 |
| 6 | Scope creep from feature brainstorms | H | M | new ideas go to ROADMAP "later" list, not into active milestone; plan changes via PR only |
| 7 | Token spend balloons | M | L | sonnet-only builders; budget column tracked per milestone in PR description |
| 8 | Session-transcript format changes upstream | L | H | scanner tests on real files each session; tolerant parsing already in place |

## 6. Budget summary

| Milestone | Builder-runs | Sessions |
|---|---|---|
| M0 | 0 (integration) | 1 |
| M1 | 1 (spent) | short |
| M2 | 6–8 | 2 |
| M3 | 6–7 | 2 |
| M4 | 3–4 | 1–2 |
| M5 | 10–14 | 4–6 |
| M6 | 6–8 | 2–3 |
| M7 | 4–5 | 2 |
| M8 | 10–12 | 3–4 |
| **Total** | **~46–59 runs** | **~18–22 sessions** |

## 7. Audit charter (what the adversarial audit must attack)

1. Sequencing errors (anything that should be earlier/later; hidden deps).
2. Technical claims (bridge, BatchedMesh, WebGPU perf, erosion approach).
3. Exit criteria that aren't actually measurable or are too weak.
4. Scope/YAGNI: what should be cut or demoted for a solo fun project.
5. Budget realism vs. observed builder-run data.
6. Process gaps: verification blind spots, agent-conflict risks, rollback.
