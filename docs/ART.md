# ART.md — Claude Planet Art Direction (v1, binding)

**Status:** v1 — binding, owner-approved direction (Omer, 2026-07-17; M-LD milestone, see `docs/superpowers/plans/2026-07-16-claude-planet-program-plan.md`). Every terrain/water/cloud/camera JIT plan from M3 onward must cite this file. A handful of rules remain tagged **(PROPOSED)** — this doc's own extrapolation beyond what M-LD actually spiked or the owner verdicted; treat only those as flagged-not-settled, everything else below is binding.

**How to check a rule:** open `http://localhost:5173`, run `window.__planet.verify.gotoViewpoint(name)` for `orbit` / `mid-coast` / `ground-sunlit` / `night-city` / `storm` (`src/verifykit.js`), screenshot, compare against the rule below.

---

## 1. North star

This planet is a cozy-epic miniature fantasy world you hold in your hands, not a simulation you get lost in — medieval stone-and-banner civilization sprouting brass-and-steam machinery wherever a session is busy. It must read clearly at every zoom, from a jewel spinning in a starfield down to one dwarf hammering outside a forge. Wonder comes from craft and scale contrast — a whole world, walkable — not from photorealism.

*Refs: [Mobius Digital — Changing the Outer Wilds Art Style](https://www.mobiusdigitalgames.com/news/changing-the-outer-wilds-art-style) · [80.lv — Dissecting the Art Style of Outer Wilds](https://80.lv/articles/dissecting-the-art-style-of-outer-wilds) · [TweakTown — BotW art-style explained](https://www.tweaktown.com/news/63954/legend-zelda-breath-wild-art-style-explained/index.html)*

## 2. Palette & grading

### 2.1 As-built palette

**Terrain & water** (`src/planet.js`)

| Element | Hex | | Element | Hex |
|---|---|---|---|---|
| Beach | `#d5c188` | | Snow | `#edf2f6` |
| Grass | `#78a35b` | | Seafloor, shallow→deep | `#b8a97e`→`#22303a` |
| Dry grass/savanna | `#b0a35c` | | Ocean surface (base/emissive) | `#2d6f9e`/`#123a5e` |
| Desert | `#d9bd7f` | | Ocean surface, shallow tint | base ×(1.06,1.16,1.14) |
| Forest | `#46703f` | | Rock | `#8a8274` |
| Tundra scrub | `#8f9682` | | | |

Seafloor color shows through the translucent ocean surface material — two
separate layers, not one "ocean deep" hex.

**Neutral building materials** (`src/buildings.js`) — wood `#8a6242` ·
whitewash `#e8e0cc` · stone `#8a8274` (same hex as terrain rock — buildings
share the terrain's own rock hue) · dark trim `#2a2420` · thatch `#c9a94a` ·
field crop A/B `#8ea34f`/`#c7a24a`

**Race trim** (`src/buildings.js` `RACE_PALETTES`) — role × race:

| Role | Human | Elf | Dwarf | Orc |
|---|---|---|---|---|
| cloth | `#3b5c8c` | `#3f7a4a` | `#8c3f2e` | `#5a5f66` |
| roof | `#4a6f9e` | `#4f8f5a` | `#9c4a30` | `#4f5359` |
| banner | `#2f4d78` | `#2f5f3a` | `#7a2f22` | `#3f4348` |
| skin | `#d9a066` | `#e8caa4` | `#c97b5a` | `#6d8f4e` |
| accent (glow) | `#3b5c8c` | `#5aa868` | `#c9622f` | `#9fb15c` |

**Steampunk & signal accents** — brass `#b0793a` · copper `#c98d4a` · aged-bronze patina `#5e7d6a` (§0.5 spec — not yet used in code, reserved for aged-metal wear) · forge ember `#ff7733`/emissive `#ff5a22` · hammer spark `#ffb347` · firework gold `#ffd76a` · town light `#ffc66e`

**Sky & night** (`src/sky.js`) — sun `#fff2d8` (eclipse tint `#ffd0b0`) · hemisphere sky/ground `#9db8ff`/`#3a3128` · moonlight fill `#8fa8d8` · atmosphere rim `#7db8ff` · aurora base/top `#4dffa6`/`#b07cff`

### 2.2 Value hierarchy by zoom

- **Orbit** (~3.2R out to `controls.maxDistance`=9R): only planet-scale masses read — continent silhouettes, ocean sapphire, ice caps, cloud coverage, the hurricane. No single building is legible; only a settlement's glow/label cluster signals "something is here."
- **Mid** (~1.35–1.6R, `mid-coast`/`night-city`): biome bands and coastline shape read; a settlement resolves as a small structure cluster (day) or a warm light huddle (night); banners/accents are not yet legible.
- **Ground** (`ground-sunlit`, surface+0.01R): individual structures, race palette, tiny people, sparks, brass/copper bolt-ons — the only zoom meant to show full accent saturation up close.

*Refs: three-tier close/mid/far distance treatment reported at GDC 2017's ["Breaking Conventions with BotW"](https://archive.org/details/gdc-2017-breaking-conventions-with-the-legend-of-zelda-breath-of-the-wild) · [Krasamo — Monument Valley I & II design](https://www.krasamo.com/game-design-inspiration-monument-valley-i-and-ii/) (pastel masses, jewel accents)*

### 2.3 Saturation rule (HSL, measured from the palette above)

- Large-area natural fields stay muted: grass/forest/rock/tundra sit at **9–35% saturation**; desert/beach/ocean run warmer (**40–56%**) but are never emissive.
- Race trim (cloth/roof/banner) sits **30–62% saturation** — a visible flag of color, still not glowing.
- Only emissive/additive elements (embers, sparks, fireworks, town lights, aurora) hit **100% saturation** — allowed only because they're small-screen-area, per §2.5.
- Checkable rule of thumb: a color covering >5% of the screen at a given zoom must not also be on the 100%-saturation glow list.

*Refs: [Game Developer — how Shedworks refined Sable's readability](https://www.gamedeveloper.com/marketing/how-shedworks-refined-the-art-of-sable-in-pursuit-of-readability) (flat colors, muted fields, landmarks pop) · [Cook & Becker — Sable: Exploration Through Line-Art](https://www.cookandbecker.com/en/article/170/sable-exploration-through-line-art.html) (Moebius, soft earthy palette)*

### 2.4 Night grade

- The dark side reads silvery-blue, never black — moonlight fill (`#8fa8d8`) opposite the sun keeps it lit (lesson paid for in `d5c0a3e`).
- Town lights (`#ffc66e`, additive) are the settlement "alive" signal at night; steam/smoke plumes join them per the program plan's §0.5 once built.

### 2.5 Bloom budget

- Mechanism: `UnrealBloomPass(strength=0.3, radius=0.7, threshold=1.0)` over ACES-filmic tonemapping (`src/main.js`) — only colors deliberately authored with **>1.0 headroom** (sun sprite `×(1.3,1.22,1.05)`, bright stars `×1.05–1.35`) cross the threshold and bloom.
- **May glow:** sun, bright stars, town-light windows, hammer sparks, forge embers, fireworks, aurora, brass/copper finials and accent dots. (PROPOSED) pipes glow faintly once built; (PROPOSED) the hurricane's eye gets a soft glow to sell it as the sky's hero object.
- **Must never glow:** terrain surface (any biome), the ocean body, ambient cloud decks, snow. Atmosphere rim stays faint on purpose (`intensity: 0.75 // faint overall — do not overdrive this`, `src/sky.js`).

## 3. Terrain shape language

- Silhouette over detail: a landmass must be identifiable by outline alone at orbit zoom — texture/noise detail is a close-up-only layer (triplanar splat fades in only within ~1.7R of the surface).
- **Coastline drama (binding, M-LD terrain verdict — B+C+D, Omer 2026-07-17):** fjord/archipelago frequency is now law, not a proposal — a deliberate MINORITY, not the default: most coast stays simple bays, a fjord or archipelago cluster earns its place as a landmark, at most a couple per continent. Recipe parameters (`spikes/ld-terrain/recipes.js`): fjord-warp (B) domain-warps the continent mask's sample coordinates with mid-frequency vector noise at warp strength 0.2, scale 2.6 (spec range 0.15–0.25) — only the coastline folds, the ~30–40% land-coverage budget below is untouched; archipelago arcs (C) add a second, higher-frequency continent-mask band (scale 4.4) gated to a near-shore fringe (raw continent-noise band centered 0.08 ± 0.09), so islands cluster off real coastlines instead of scattering across open ocean. Ships in the M-LD implementation wave; `planet.js` today still runs the jitter-softened baseline coast.
- Mountains read as chains, not bumps: ridged noise is masked to a narrow band around its own zero-crossing (`BELT_BAND_WIDTH=0.32`) so ranges wind across the land instead of scattering peaks uniformly. **Dramatic relief (binding, M-LD terrain verdict — recipe D):** mountain rise ×1.8 (`MOUNTAIN_RISE` 0.03→0.054), ridge crests sharpened by a power-1.6 curve on the ridged-noise value (narrows peaks, deepens flanks), valleys carved by inverted-ridge subtraction (depth 0.016) between ranges, and a steeper coastal shelf (transition narrowed to continent-mask 0.4–0.62, vs. baseline's full-range falloff) for mild cliffs at the shore. A fifth candidate, mesa/plateau terracing, was spiked alongside B–D and rejected as underdelivering. (PROPOSED) branching spurs off a main chain remain a further future refinement, not built or verdicted.
- **Height-cap consequence (binding, M-LD terrain verdict — the integration cost of recipe D's relief):** `HEIGHT_MAX` rises 1.045→1.06, with `LAND_COLOR_RANGE`/`WATER_COLOR_RANGE` recomputed off the new budget rather than left stale. Every shell that sits just above the surface rebases to keep clearance over the taller terrain: cloud shells 1.055/1.07 → ~1.075/1.09, storm patch 1.062 → ~1.08, atmosphere 1.09 → ~1.11, and the bird altitude band raised above the new peaks. Settlement layout will reshuffle at coasts (`isLand` changes where the warped/archipelago coastline moves) — accepted, this is still a pre-1.0 world.
- Land coverage target: ~30–40% of the sphere (tuned in `planet.js`). (PROPOSED) readable landmass count at orbit: roughly 4–9 distinct major landmasses per visible hemisphere — one supercontinent or a field of confetti-islands both fail the silhouette rule above.
- Biome/snow band crispness: every hard-looking edge (shoreline, snowline, polar cap) is a `smoothstep` ramp spanning enough of the underlying noise field that no two adjacent mesh vertices land on opposite sides of it — the shipped shoreline comment states this exactly: *"band must span >= 2 vertex steps or the shoreline aliases into sawteeth"* (`planet.js`). Any new band must be tuned the same way, never left as a hard threshold.

*Refs: [Wikipedia — Monument Valley (video game)](https://en.wikipedia.org/wiki/Monument_Valley_(video_game)) (sculpted minimal geometry) · [Wikipedia — Bad North](https://en.wikipedia.org/wiki/Bad_North) / [Medium — Stålberg & Meredith on Bad North](https://medium.com/subpixelfilms-com/a-minimal-brand-of-madness-oskar-st%C3%A5lberg-and-richard-meredith-on-the-development-of-bad-north-514d5cf1a7a1) (readable-at-a-glance islands) · GDC 2017 BotW talk (§2.2) on using mountain flow/mist to express distance*

## 4. Water

Binding as of the M-LD water verdict (Omer, 2026-07-17): **hybrid graded-fresnel base + stylized-banded shoreline accent**, stylized-leaning — owner "really liked the stylized look," so err graphic over photoreal when tuning either layer (`spikes/ld-water/scene.js` treatments 2+3). Ships in the M-LD implementation wave; today's live ocean is still the Current+ recipe in §2.1 (`#2d6f9e`/`#123a5e`) until then.
- **Orbit/Mid — graded-fresnel base:** deep sapphire (grazing-angle fresnel) graded against turquoise (looking straight down; fresnel falloff `pow(1-V·up, 3.0)`), plus a 3-stop depth-absorption gradient doing the shallow→deep color work. Continental shelves still read as a lighter halo around land against open deep water — the pre-verdict rule survives, just re-grounded in the new material. Shelf banding must stay visible at the `mid-coast` viewpoint; the hybrid must not lose this.
- **Shoreline — stylized-banded accent:** the smooth fresnel gradient hands off to 3–4 hard posterized depth bands with slow band-edge wobble right at the coast, a flat low-gloss surface (roughness 0.7, well above the open-water base), a noise-modulated animated coast-glow band (~55% blend), and a pale coast outline blended in at ~40% close to shore — never pure white. This is the "err graphic" layer.
- **Close:** animated surface (three summed traveling sine swells) is still the base life at this zoom. Shore foam remains a future layer (M5b, not yet built) — but "flat color band" is no longer the shoreline's resting state once the M-LD wave ships: the posterized/outline accent above already carries it, foam adds on top later rather than being what makes the shoreline read.
- **Glint discipline:** ocean roughness stays tuned *"low enough for a glint, high enough not to blow out a hemisphere"* (`planet.js` comment) — a real day-1 bug, fixed in `057bca1` ("soften ocean glint; tame bloom threshold"). The stylized layer tightens this further: glint collapses to a manual sun-dot highlight (specular power ~220 — a genuinely tight point, not a wash) rather than relying on PBR roughness response alone. Checkable rule unchanged: a specular highlight stays a small, localized bright patch that moves with the sun — never a wash covering a whole visible ocean face; real sunglint from orbit is exactly this kind of bounded "bright patch or streak," only where water is glass-smooth.
- **Camera consequence:** the water spike's own camera never let the view dip under the water plane — formalized as the min-elevation clamp near water in §7's skim law, not left to per-scene luck.

*Refs: [NASA Earth Observatory — The Science of Sunglint](https://science.nasa.gov/earth/earth-observatory/the-science-of-sunglint-84333/) · [Wikipedia — Sunglint](https://en.wikipedia.org/wiki/Sunglint)*

## 5. Clouds & weather

- Sparse beats dense: current calibrated coverage is lower-deck 27% / upper-deck (cirrus) 13% (`97368d6`). Target band for this doc is **15–25%** total ambient coverage — (PROPOSED) the lower deck should come down a few points to land inside that band; the upper deck already fits.
- Structure over blobs: clouds are domain-warped fbm (two-stage Quilez-style warp), banded by latitude into an equatorial belt + mirrored mid-latitude storm tracks — never a uniform scatter. The warp is what turns noise into filaments/swirls instead of cauliflower blobs.
- The hurricane is the sky's hero object: exactly one at a time by design (`SECOND_STORM_CHANCE=0`), sun-seeking so it's always on the lit hemisphere, built from a real eye / eyewall / log-spiral-rainband structure matching hurricane satellite photography.
- The fade rule: clouds must never hide the civilization layer at mid zoom. Ambient decks fade from full opacity at 2.4R down to thin wisps (never fully to zero) by 1.35R; the storm fades out even closer, gone by 1.6R, so it never blocks a ground-level view.

*Refs: [NASA — Sunset from the ISS](https://science.nasa.gov/earth/earth-observatory/sunset-from-the-international-space-station-44267/) (limb, layered atmosphere color) · [NOAA/NESDIS — Guide to Satellite Images of Hurricanes](https://www.nesdis.noaa.gov/news/guide-understanding-satellite-images-of-hurricanes) · [NASA Earth Observatory — Staring Into Ian's Eye](https://earthobservatory.nasa.gov/images/150427/staring-into-ians-eye)*

## 6. Civilization & steampunk expression

Restating the program plan's §0.5 as checkable rules:

- Base reads medieval first: stone, timber, whitewash, thatch, banners — steampunk is never the base language, only an overlay.
- Steam/smoke = activity, not decoration: plumes and glow scale with how busy/large a session is; a quiet settlement should look almost purely medieval.
- Machinery density is race-coded and checkable against `BOLT_ON_KINDS_BY_RACE` (`buildings.js`): dwarf = gear+pipe+tank+2nd-gear (full industrial) · human = gear+pipe (medieval-clockwork) · orc = pipe+tank+2nd-gear (scrap-punk) · elf = gear only (organic + brass filigree).
- Brass/copper/patina appear ONLY on machinery bolt-ons and civic monuments — never as a building's primary wall/roof material.
- Asset tiering (S5 verdict, resolved 2026-07-17): Kenney parts for all standard tier-1/2 buildings; Quaternius reserved for grand tier-3 landmarks only, one shared shell per `GRAND_RECIPES`.
- Dragons and airships (M2.5) follow the same rule: resident/lair objects are landmarks, not ambient clutter — one dragon, airship routes between real git-remote-derived settlement pairs.

*Ref: [Medium — Bad North interview](https://medium.com/subpixelfilms-com/a-minimal-brand-of-madness-oskar-st%C3%A5lberg-and-richard-meredith-on-the-development-of-bad-north-514d5cf1a7a1) — a settlement's activity/character should be readable without moving the camera.*

## 7. Camera & motion feel (M-LD camera verdict, Omer 2026-07-17 — binding)

These are no longer targets — the M-LD camera spike ran, Omer picked swoop-for-visits + skim-near-ground, and the parameters below are measured from the approved GIF packet, grounded in easing patterns already used elsewhere in the app. Ships in the M-LD implementation wave; today's code is still the pre-verdict baseline described inline below.

- **Skim floor + roll (binding):** today's only floor is a hard `controls.minDistance = 1.06R` clamp with no terrain-following — that stays as the ambient orbit/zoom backstop, but close-up "skim near ground" navigation gets a real terrain-following floor: `sampleHeight(dir) + 0.008`, smoothed at gain `0.12` so it doesn't jitter with terrain noise — the camera never clips below local ground height; a banked roll eased up to a `0.18 rad` cap sells the sense of skimming rather than gliding flat. **Min-elevation clamp near water:** the floor never tracks the seafloor beneath the ocean surface — near water it clamps to at least sea level, the same "never dip under the water plane" lesson the water spike's own camera already enforced (§4).
- Ease curves: every animated transition already in the app uses `smoothstep`, never linear — click-to-visit tween (1.1s), construction grow-in, cloud/storm fades. The swoop below is the first camera motion to join this family, via `easeInOutCubic` (same anti-linear spirit, different curve); no linear pans, no instant cuts, anywhere camera work touches from here on.
- **Visit swoop (binding):** today's click-to-visit is still a straight `lerpVectors` chord through space (`world.js`, `TWEEN_DURATION=1.1`s) — not a flight path. Decided replacement: `easeInOutCubic` timing; an arc of `0.35·sin(πt)` lofted outward from the straight chord, peaking at the swoop's midpoint and zero at both ends, so it lofts out and settles instead of cutting through the planet's own volume; FOV eases `45→52→45` across the swoop — widens mid-flight to sell speed/altitude, returns to the app's baseline 45° on arrival.
- Rotate/zoom already slow down near the surface (`clamp((dist-1)*0.55, 0.02, 1)` / `clamp((dist-1)*0.8, 0.12, 1)`, `main.js`) — unchanged by this verdict; the swoop's FOV curve above is the decided answer to the earlier open question of whether FOV should move too.
- Nothing snaps: the one non-negotiable inherited from the rest of the app — every value that changes (position, opacity, scale) already eases somewhere else in this codebase; the swoop and skim above must not be the first camera work here that jumps.
- **Open defect (assigned: M2 exit polish), observed 2026-07-17:** screenshotting `orbit` and `night-city` live today shows settlement name-plates and agent speech bubbles overlapping into unreadable text soup once a settlement gets busy — settlement labels have no count/density thinning (only topic labels are capped at 12-nearest). This violates the North Star's "readable at every zoom" and should be fixed alongside camera work, not left to camera framing alone; it is not part of the M-LD camera verdict above and is tracked separately.

*Refs: [Mobius Digital — Changing the Outer Wilds Art Style](https://www.mobiusdigitalgames.com/news/changing-the-outer-wilds-art-style) (handheld-planet feel) · [Medium — Bad North interview](https://medium.com/subpixelfilms-com/a-minimal-brand-of-madness-oskar-st%C3%A5lberg-and-richard-meredith-on-the-development-of-bad-north-514d5cf1a7a1) ("never send the camera two kilometers away" to track the action)*

## 8. Anti-rules (lessons already paid for — do not re-learn these)

- No per-vertex value jitter on smooth-shaded terrain — it reads as triangle mosaic, not texture (`planet.js`: *"Value jitter killed... Clean fields win"*).
- No visible triangulation — `IcosahedronGeometry` is non-indexed; always `mergeVertices()` before displacing/shading smooth (lesson from `09c6be3`, "Kill triangle mosaic for real").
- Terrain is smooth-shaded; scattered props (rocks/trees) are flat-shaded low-poly — that contrast is deliberate style, not an inconsistency to "fix" by matching one to the other.
- No billboard labels — labels scale by camera-to-label world distance (`applyLabelScale`, `labels.js`) so close-ups get signposts, not constant-screen-size UI chrome.
- No dense cloud whitewash — `alphaMap` samples the GREEN channel; writing coverage into alpha instead veils the whole planet in milk (real bug, fixed in `057bca1`). Any new alpha-mapped layer must respect this.
- No 70k-blade grass noise — individual grass blades read as visual noise at this planet's scale; disabled by owner verdict (`GRASS_ENABLED = false`, `flora.js`, lesson from `09c6be3`). Do not silently re-enable without a fresh verdict.
- No unmotivated glow — every emissive/bloom source must be on the §2.5 approved list; a new glow needs a reason (activity, event, machinery), not just "it looks nice."
- No hemisphere-blowout glint — see §4; a specular highlight is a patch, never a wash.
- No motion blur — ruled out by the 2026-07-17 technique audit before it was ever built: a swoop/skim camera selling speed via directional blur would smear exactly the crisp silhouettes the north star needs sharp at every zoom; speed reads through the arc + FOV widen instead (§7).
- Outline/ink stylization (toon outlines, ink-wash edges) — owner question, default SKIP: the 2026-07-17 technique audit left this open rather than rejecting it outright; don't add it speculatively, wait for an explicit verdict.
- No stacked tone changes — lighting/tone alterations (SSAO, LUT grades, vignette, near-camera shadow map, and anything else that touches the grade) land one variable at a time, each after a fresh screenshot baseline, per the M-LD technique audit's sequencing rule for everything queued after this wave ships.
