# Ground-detail texture sources (ambientCG)

Four ambientCG PBR material sets, 1K-JPG resolution, used for the terrain's
triplanar detail splat (`src/planet.js`, a TSL node material). All
four are CC0 (public domain):

> Yes. All assets are released under the Creative Commons CC0 license,
> making them free to use without attribution - even in commercial
> circumstances.
> — https://ambientcg.com/view?id=Grass004 (FAQ), license details:
>   https://docs.ambientcg.com/license/

## Sets

| Biome | Asset ID | Page | 1K-JPG zip |
|---|---|---|---|
| Grass | Grass004 | https://ambientcg.com/a/Grass004 | https://ambientcg.com/get?file=Grass004_1K-JPG.zip |
| Rock | Rock030 | https://ambientcg.com/a/Rock030 | https://ambientcg.com/get?file=Rock030_1K-JPG.zip |
| Sand/ground | Ground080 | https://ambientcg.com/a/Ground080 | https://ambientcg.com/get?file=Ground080_1K-JPG.zip |
| Snow | Snow006 | https://ambientcg.com/a/Snow006 | https://ambientcg.com/get?file=Snow006_1K-JPG.zip |

Each zip ships Color/NormalGL/NormalDX/Roughness/AmbientOcclusion/
Displacement JPGs plus `.blend`/`.mtlx`/`.usdc`/`.tres` material files. This
directory keeps ONLY the two maps the splat shader actually samples
(Color, NormalGL) — everything else in the zip is discarded, same
strip-to-what's-used approach as `public/models/SOURCES.md`.

## Files in this directory

| File | Source (in zip) | Size | Dimensions |
|---|---|---|---|
| `Grass004_1K-JPG_Color.jpg` | `Grass004_1K-JPG_Color.jpg` | 1,985,561 B | 1024x1024 |
| `Grass004_1K-JPG_NormalGL.jpg` | `Grass004_1K-JPG_NormalGL.jpg` | 2,339,612 B | 1024x1024 |
| `Rock030_1K-JPG_Color.jpg` | `Rock030_1K-JPG_Color.jpg` | 1,483,352 B | 1024x1024 |
| `Rock030_1K-JPG_NormalGL.jpg` | `Rock030_1K-JPG_NormalGL.jpg` | 2,528,233 B | 1024x1024 |
| `Ground080_1K-JPG_Color.jpg` | `Ground080_1K-JPG_Color.jpg` | 1,054,251 B | 1024x1024 |
| `Ground080_1K-JPG_NormalGL.jpg` | `Ground080_1K-JPG_NormalGL.jpg` | 1,513,641 B | 1024x1024 |
| `Snow_Color.jpg` | `Snow006_1K-JPG_Color.jpg` | 668,846 B | 1024x1024 |
| `Snow_NormalGL.jpg` | `Snow006_1K-JPG_NormalGL.jpg` | 2,081,501 B | 1024x1024 |

`Snow_Color.jpg`/`Snow_NormalGL.jpg` keep the pre-existing short name (the
Color map predates this file — added in `fffca2f`, verified byte-identical
to Snow006's own Color map by MD5 before writing this note); the NormalGL
companion follows the same `Snow_*` convention rather than the other three
sets' `<AssetId>_1K-JPG_*` convention, so the Color/NormalGL pair for each
biome is trivially greppable side by side.

## NormalGL vs NormalDX

ambientCG ships both OpenGL and DirectX normal-map conventions (the
green/Y channel is flipped between them). `NormalGL` is correct for
three.js/WebGL's convention (`+Y` up in tangent space) — using `NormalDX`
here would invert the perceived slope direction of every bump. Only
`NormalGL` is downloaded; `NormalDX` is discarded with the rest of the zip.

## Committed footprint

Color maps: ~5.2 MB (pre-existing, `fffca2f`). NormalGL maps added by the
M-POLISH surface-crispness pass: ~8.5 MB (`du -c` of the four `*NormalGL*`
+ `Snow_NormalGL.jpg` files above). Combined `public/textures/` footprint:
~13.6 MB.
