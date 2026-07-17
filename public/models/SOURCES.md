# M2 building-kit asset sources

Both packs confirmed CC0 (public domain). This directory keeps ONLY the parts
referenced by `src/buildings.js`'s recipe tables (`KENNEY_PARTS` /
`QUATERNIUS_PARTS`), with all original textures/materials stripped — every
part here carries geometry (position/normal/uv/index) only. `src/assets.js`
assigns its own flat per-part vertex-color tint at load time (see "Why
textures are stripped" below), so no image files are needed at all.

## Kenney — Fantasy Town Kit (2.0)

- Pack page: https://kenney.nl/assets/fantasy-town-kit
- Direct zip: https://kenney.nl/media/pages/assets/fantasy-town-kit/efe948d309-1754222374/kenney_fantasy-town-kit_2.0.zip
  (3.9 MB; the pack page's visible "Download" button is JS-driven so the href isn't in static HTML)
- License: CC0 1.0 Universal, per `License.txt` inside the zip:
  > License: (Creative Commons Zero, CC0) — http://creativecommons.org/publicdomain/zero/1.0/
  > You can use this content for personal, educational, and commercial purposes.
- Source format: `Models/GLB format/*.glb` (single-file GLB). Each part references an
  external `Textures/colormap.png` atlas — stripped (see below), never copied here.
- 27 parts used, in `kenney/` — walls (stone: wall-door/wall-block/wall-window-shutters/
  wall-window-glass; wood: wall-wood-door/wall-wood-block/wall-wood-window-shutters),
  roofs (roof-high-point/roof-high-gable/roof-high-corner-round/roof-corner-round/
  roof-flat/roof-gable/roof-gable-top), chimney-base/chimney, banner-red/banner-green,
  pillar-stone/pillar-wood, stairs-stone, fence-gate/hedge, overhang/planks/cart/stall.
  Used for ALL tier-1/tier-2 standard buildings (all 7 structure types), per the M2
  art verdict.

## Quaternius — Medieval Village MegaKit (Standard/free edition)

- Pack page: https://quaternius.com/packs/medievalvillage.html (download button opens a
  Google Drive folder, not scriptable without an interactive browser/auth)
- Direct zip (OpenGameArt.org CC0 mirror of the same free/standard kit):
  https://opengameart.org/sites/default/files/medieval_village_megakitstandard.zip
  (100 MB; pack page: https://opengameart.org/content/medieval-village-megakit)
- License: CC0 1.0 Universal, per `License_Standard.txt` inside the zip:
  > License: CC0 1.0 Universal (CC0 1.0) — Public Domain Dedication
  > https://creativecommons.org/publicdomain/zero/1.0/
  > Models by @Quaternius
- Source format: `glTF/*.gltf` + `*.bin` (separate JSON+binary; this pack doesn't ship a
  merged .glb), originally with 2K PBR textures (BaseColor/Normal/Roughness/ORM) —
  **dropped entirely** per the M2 art verdict (was 17MB, caused dark-face artifacts
  under this scene's lighting, and clashed with Kenney's flat-tint style).
- 6 parts used, in `quaternius/` — Wall_UnevenBrick_Door_Flat, Wall_UnevenBrick_Straight,
  Wall_UnevenBrick_Window_Wide_Flat, Roof_Wooden_2x1_Center, Prop_Chimney (the S5-spike
  validated house shell) + Roof_Tower_RoundTiles (tower-type grand cap, new for M2).
  Used ONLY for tier-3 grand landmarks (all 7 types share this wall+chimney shell;
  `tower` swaps in Roof_Tower_RoundTiles for a distinct silhouette).

## Why textures are stripped (both packs)

`src/assets.js` merges every part's raw geometry into shared `THREE.BatchedMesh`
instances and renders them with the app's own flat-shaded, vertex-colored materials
(matching every other structure in the world — see `src/buildings.js`'s
`stdMat`/`raceMat`). The original vendor materials/textures are never sampled, so
carrying them would only add dead weight: every `.gltf`/`.glb` here has had its
`images`/`textures`/`samplers` arrays removed, and `materials` reduced to `{name}`
only (Quaternius material names like `MI_WoodTrim`/`MI_Plaster`/`MI_UnevenBrick`/
`MI_RoundTiles` are kept and read at runtime as a color-role hint — see
`MATERIAL_NAME_ROLES` in `src/buildings.js`; Kenney's single generic "colormap"
material carries no such hint, so its parts are role-tagged by filename instead via
`KENNEY_PART_ROLES`). Stripped with `node --check`-clean, zero-dependency scripts
(GLB: manual chunk surgery preserving the BIN chunk byte-for-byte; glTF: plain JSON
edit) — not committed, one-off tooling only.

## Dragon — Quaternius "Dragon" (M2.5 resident dragon, `src/dragon.js`)

- Pack page: https://poly.pizza/m/VBvzjFIYws ("Dragon - Free Model By Quaternius",
  published Jul 11 2022; poly.pizza mirrors quaternius.com's CC0 catalog with direct
  single-file GLB downloads — the quaternius.com/itch.io pack pages themselves gate
  the actual download behind a Google Drive folder, not scriptable headlessly)
- Direct GLB (poly.pizza CDN): https://static.poly.pizza/9714f533-5d2d-4cfd-b8f1-c8dfff64a672.glb
  (268,896 bytes as downloaded)
- License: CC0 1.0 ("Public Domain (CC0)" / `"Licence":"CC0 1.0"` in the page's own
  model metadata), author Quaternius (https://quaternius.com/).
- Source format: single-file GLB, FBX/GLTF origin. Already had **zero embedded
  images/textures/samplers** — materials ship as flat `pbrMetallicRoughness.
  baseColorFactor` values only (role-named `Eyes`/`Main`/`Belly`/`Claws`/`Wings`), so
  there was nothing to strip on that front (unlike the Kenney/Quaternius building
  packs above). `src/dragon.js` overrides these material colors at load time — flat
  dark crimson `#6e2b2b` body/wings/belly, brass `#b0793a` claws — same "tint at
  runtime, not baked into the asset" convention `assets.js` uses for buildings.
- Geometry: 2 meshes (`Eyes`, `Dragon`), **1,344 triangles** total — well under the
  M2.5 spec's ≤3k budget. Fully rigged: `DragonArmature` skin with 37 nodes (Body/
  Neck/Head/Face, 4-joint Wing1-4 chains ×2, 2-joint legs ×2, 4-segment tail) and 5
  animation clips (`Attack`/`Attack2`/`Death`/`Flying`/`Hit`) in the original.
- Stripped to `dragon/dragon.glb` with a one-off, zero-dependency Python script
  (`node --check`-equivalent care, not committed): kept **only the `Flying` clip**
  (the other 4 are unused by `dragon.js`'s state machine — see its "Event hook for
  later" comment if a future milestone-appearance flourish wants `Attack` back) and
  removed `extras.fromFBX` debug metadata recursively; the BIN chunk (mesh/skin/
  keyframe data) is preserved byte-for-byte, same "chunk surgery" approach as the
  Kenney/Quaternius stripping above. 268,896 → 252,052 bytes.
- Why a rigged GLB instead of the buildings pipeline's merge-to-BatchedMesh
  approach: this is one hand-placed, animated, single-instance actor (not thousands
  of static instanced parts), so `dragon.js` loads it directly via `GLTFLoader` and
  drives the skeleton with `THREE.AnimationMixer` (weight-blended against the
  loader's own captured bind pose for the takeoff/landing wing fold — see
  `dragon.js` for the per-state weight/timeScale choreography) rather than routing
  through `assets.js`'s position/normal-only merge path.

## Committed footprint

`du -sh public/models` → 664K total (kenney/ 396K, quaternius/ 268K — the latter
dominated by `Roof_Tower_RoundTiles.bin` at 203K, the one higher-detail piece, used
once as shared BatchedMesh geometry so its cost does not scale with instance count).
Well under the <5MB budget; the original Quaternius textures alone were 17MB.
`dragon/` adds 246K (`dragon.glb`, 252,052 bytes) — one hand-placed rigged actor,
not instanced, so its cost doesn't scale with world size either.
