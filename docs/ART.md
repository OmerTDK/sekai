# ART.md — Claude Planet Art Direction

**Status:** binding once approved — owner sign-off pending (M-LD milestone, see `docs/superpowers/plans/2026-07-16-claude-planet-program-plan.md`). Every terrain/water/cloud/camera JIT plan from M3 onward must cite this file. Rules tagged **(PROPOSED)** are this doc's own extrapolation beyond what's built or already owner-approved — flag them in review, don't treat them as settled.

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
- Coastline drama: (PROPOSED) fjords/bays/archipelago moments are a deliberate minority, not the default — most coast should be simple bays; a fjord or archipelago cluster earns its place as a landmark, at most a couple per continent. Today's baseline coast is jitter-softened only, not fjord-warped — exactly what the M-LD terrain-recipe spike (program plan item 2) is for.
- Mountains read as chains, not bumps: ridged noise is masked to a narrow band around its own zero-crossing (`BELT_BAND_WIDTH=0.32`) so ranges wind across the land instead of scattering peaks uniformly. (PROPOSED) branching spurs off a main chain are a future refinement, not yet built.
- Land coverage target: ~30–40% of the sphere (tuned in `planet.js`). (PROPOSED) readable landmass count at orbit: roughly 4–9 distinct major landmasses per visible hemisphere — one supercontinent or a field of confetti-islands both fail the silhouette rule above.
- Biome/snow band crispness: every hard-looking edge (shoreline, snowline, polar cap) is a `smoothstep` ramp spanning enough of the underlying noise field that no two adjacent mesh vertices land on opposite sides of it — the shipped shoreline comment states this exactly: *"band must span >= 2 vertex steps or the shoreline aliases into sawteeth"* (`planet.js`). Any new band must be tuned the same way, never left as a hard threshold.

*Refs: [Wikipedia — Monument Valley (video game)](https://en.wikipedia.org/wiki/Monument_Valley_(video_game)) (sculpted minimal geometry) · [Wikipedia — Bad North](https://en.wikipedia.org/wiki/Bad_North) / [Medium — Stålberg & Meredith on Bad North](https://medium.com/subpixelfilms-com/a-minimal-brand-of-madness-oskar-st%C3%A5lberg-and-richard-meredith-on-the-development-of-bad-north-514d5cf1a7a1) (readable-at-a-glance islands) · GDC 2017 BotW talk (§2.2) on using mountain flow/mist to express distance*

## 4. Water

- **Orbit:** deep sapphire (`#2d6f9e`) with graded shelves — shallow water brightens/cools over shoals so continental shelves read as a lighter halo around land against `#22303a` open deep water.
- **Mid:** shelf banding must stay visible — this is the zoom where "graded shelf" actually reads (confirmed live at the `mid-coast` viewpoint).
- **Close:** animated surface (three summed traveling sine swells) is the only life at this zoom. (PROPOSED) shore foam is a future layer (M5b, not yet built) — until then the shoreline stays a flat color band; don't over-detail it today.
- **Glint discipline:** ocean roughness is tuned *"low enough for a glint, high enough not to blow out a hemisphere"* (`planet.js` comment) — a real day-1 bug, fixed in `057bca1` ("soften ocean glint; tame bloom threshold"). Checkable rule: a specular highlight stays a small, localized bright patch that moves with the sun — never a wash covering a whole visible ocean face. Real sunglint from orbit is exactly this kind of bounded "bright patch or streak," and only where water is glass-smooth — rough water scatters it away entirely.

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

## 7. Camera & motion feel (mostly PROPOSED — precedes the M-LD camera spike)

Today's camera has no dedicated "feel" layer yet; these are reference-derived targets, grounded in easing patterns already used elsewhere in the app.

- (PROPOSED) Near-surface floor: today's only floor is a hard `controls.minDistance = 1.06R` clamp, no terrain-following. Once close-up navigation exists, the camera should never clip below local ground height.
- Ease curves: every animated transition already in the app uses `smoothstep`, never linear — click-to-visit tween (1.1s), construction grow-in, cloud/storm fades. (PROPOSED) camera moves must use this same curve family; no linear pans, no instant cuts.
- Rotate/zoom already slow down near the surface (`clamp((dist-1)*0.55, 0.02, 1)` / `clamp((dist-1)*0.8, 0.12, 1)`, `main.js`). (PROPOSED) extend this to FOV: widen slightly at orbit for a "planet in your hand" feel, narrow slightly at ground level for intimacy — always eased, never a hard cut.
- (PROPOSED) Visit-swoop arc: today's click-to-visit is a straight `lerpVectors` chord through space, not a flight path. A cinematic swoop should loft outward first, arc over, then descend — never a straight line cutting through the planet's own volume.
- Nothing snaps: the one non-negotiable inherited from the rest of the app — every value that changes (position, opacity, scale) already eases somewhere else in this codebase; new camera work must not be the first thing here that jumps.
- (PROPOSED, observed 2026-07-17) Label/bubble density: screenshotting `orbit` and `night-city` live today shows settlement name-plates and agent speech bubbles overlapping into unreadable text soup once a settlement gets busy — settlement labels have no count/density thinning (only topic labels are capped at 12-nearest). This violates the North Star's "readable at every zoom" and should be fixed alongside camera work, not left to camera framing alone.

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
