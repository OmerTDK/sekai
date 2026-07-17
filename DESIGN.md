# Sekai

A living fantasy planet on your desktop, populated by your Claude Code sessions.
Launch it, and a stylized world floats in a starfield: continents, snowy poles,
oceans with drifting cloud decks, birds riding the wind, moons overhead. Every
Claude Code session you've ever run is a building somewhere on it. Every session
running *right now* is a tiny person, out there working on it.

Not Earth. Its own world — the name is generated from the seed.

## How sessions become a world

The app reads Claude Code's own transcript files (`~/.claude/projects/**/*.jsonl`)
— no hooks, no setup, nothing to install into your workflow. That history is the
world's memory: **buildings persist forever because the transcripts do.**

| In your terminal | On the planet |
|---|---|
| A project (working directory) | A **settlement**, always at the same spot on the same continent |
| One session | One **building** in that settlement, labeled with the session's topic |
| Session topic keywords | Building type — bugfixing → barracks, data/SQL → farm, research → observatory, docs → library, deploys → forge, UI → hall, else towers |
| Session length (transcript size) | Building tier: tent-humble → house → grand (banner on a pole) |
| Session active in the last few minutes | A tiny **person** walking around the settlement, hammering on their building |
| A brand-new session | Construction: scaffolding up, building rises from the ground |
| Project identity | A fantasy **race** (human / elf / dwarf / orc) — colors, name suffix: *Clooverdbtforge*, *Datapipedell*, *Tmpgash* |

Everything is placed deterministically by hashing project paths and session ids
against a seeded terrain — the same world comes back every launch. Change the
seed (`?seed=anything` in the URL) and you get a brand-new planet, buildings
re-settled onto it.

## What it looks like

- **Terrain**: procedural continents from seeded noise, ridged mountain chains,
  irregular snowy polar caps, flat-shaded faceted look — realistic shapes,
  stylized surface (Monument Valley meets a space photo).
- **Ocean**: translucent, gently swelling, deep-to-shelf color falloff.
- **Sky**: ~10k stars + a milky-way band, fresnel atmosphere rim glow, two
  drifting cloud shells, a visible sun, and two small moons on inclined orbits.
- **Life**: bird flocks in V-formation gliding between the peaks and the clouds;
  people in race colors going about their work.
- **Camera**: grab-and-spin globe, zoom from "jewel in space" down to
  street level. Click a settlement label to fly there.

## Architecture (all local, zero cloud)

```
npm start  →  Vite dev server  →  browser tab
                   │
                   ├─ /api/sessions  ← server/scan.js reads ~/.claude/projects/*/*.jsonl
                   │                   (topic, project cwd, mtime, size; cached, capped)
                   └─ the app (vanilla JS + three.js)
                        src/main.js    scene, camera, controls, HUD wiring
                        src/util.js    seeded hashing/noise — the determinism contract
                        src/planet.js  terrain + ocean   { sampleHeight, isLand }
                        src/sky.js     stars, clouds, atmosphere, moons, lighting
                        src/world.js   settlements, buildings, people, labels, click-to-visit
                        src/birds.js   flocks
```

No database. The transcript files are the persistence; positions are pure
functions of (seed, project, session id). Client polls `/api/sessions` every 4s.

Ground detail textures (`public/textures/`) are CC0 materials from
[ambientCG](https://ambientcg.com) (Grass004, Rock030, Ground080, Snow006),
triplanar-mapped and blended per-pixel by biome weights.

Decisions, for the record: browser app over Electron/Tauri (a tab is enough; a
Tauri shell is the upgrade if a dock icon is ever wanted). Vanilla three.js over
react-three-fiber (no UI framework needed). Sessions detected by file mtime —
an idle-but-open session eventually reads as "away", which is fine and even
thematically honest.

## Future ideas (parked, roughly in order of joy-per-effort)

- **Ships**: when a project's sessions reference another project's settlement
  across the sea, a little ship sails between harbors with a wake.
- **Day/night cycle** with glowing windows and city lights on the night side.
- **Weather**: hurricane spirals in the cloud layer, thunderstorms over
  settlements whose sessions hit errors.
- **A rare wyvern** circling one mountain range (it IS a fantasy planet).
- **Aurora** over the poles.
- **Commit fireworks**; chimney smoke rate = tokens burned.
- **Roads** inside settlements; population = subagent count.
- **Time-lapse**: replay the world being built session by session.
- **Ambient sound**: wind, waves, distant hammering.
- **Menu-bar/Tauri build**, screensaver mode (slow auto-orbit already fits).
