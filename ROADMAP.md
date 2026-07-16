# Roadmap

Standards are high. Nothing here is speculative filler — everything below is
approved direction (2026-07-16). Ordered by batch, not by wish.

## Batch 1 — features on current stack (in progress)
- [ ] Solar eclipses: moon/sun alignment dims the sun, corona flare, light drama
- [ ] Aurora curtains over the polar caps at night; shooting stars; rare comet
- [ ] Live worker theater: active workers hammer with sparks + speech bubbles
      showing what the session is actually doing right now
- [ ] Subagent armies: sessions that spawn subagents show extra mini-workers
- [ ] Building inspector: click a building → session card (title, date, size,
      duration) with **Resume session** (opens Terminal, `claude --resume <id>`)
- [ ] Cmd-K palette: fuzzy-jump to any settlement/session
- [ ] Photo mode: hide UI, slow auto-orbit (doubles as screensaver)

## Batch 2 — the beauty session
- [ ] Asset-pack settlements: replace primitive kit-bash buildings/trees with
      curated CC0 low-poly packs (Kenney / Quaternius), per-race palettes
- [ ] Commit fireworks, PR monuments, error thunderclouds (git/gh integration)
- [ ] Model-tier architecture (Fable/Opus = spires, Haiku = huts)
- [ ] Wonders at milestones (Colossus at 500 sessions, lighthouse, sky-spire)
- [ ] Time-lapse mode: scrub a timeline, watch the civilization build itself
      (derives from transcript mtimes — no new data needed)

## Batch 3 — Planet 2.0 replatforming
- [ ] Migrate to three.js WebGPURenderer + TSL node materials (kills all
      onBeforeCompile string hacks; unlocks compute shaders)
- [ ] Tessendorf FFT ocean + shore foam + fresnel depth grading
- [ ] Raymarched volumetric clouds & hurricane (weather-map driven; ambient
      coverage cut hard — sparse volumetrics beat dense decals)
- [ ] Bruneton-style atmospheric scattering (real sunsets, aerial perspective)
- [ ] GPU hydraulic erosion bake per seed → drainage valleys, rivers, waterfalls
- [ ] Chunked LOD terrain (cube-sphere quadtree)
- [ ] Electron/Tauri shell + SQLite session index + FSEvents watcher
      (spike WebGPU-in-Tauri early; Electron is the safe fallback)

## Batch 4 — the living world
- [ ] Ships & trade routes between related projects (shared remotes)
- [ ] Ruins for deleted projects; migration caravans for renamed ones
- [ ] Seasons tied to the real calendar; volcano; the wyvern
- [ ] Whales, fish schools, herds; birds scatter near the camera
- [ ] Ambient sound design (wind/waves/hammering/thunder, mixed by zoom)
- [ ] Poster export ("my year in sessions"), auto-tour, share GIFs

## Standing quality bar
- Deterministic from seed. 60fps on Apple Silicon. No visible triangle
  mosaics, no texture mush, no billboard labels. Every feature verified live
  in the running app before it's called done.
