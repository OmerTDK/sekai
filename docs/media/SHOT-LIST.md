# README GIF shot-list

The curated GIFs the README embeds. Recorded via browser automation at
`seed=aetherion-1`, WebGL2 backend, ~1280×720, 6–8s loops, palette-optimized to
<4 MB each, saved here as `docs/media/<name>.gif`. `gallery/` stays the raw WIP
archive; this directory holds only the polished set.

Common preamble for every shot: fixed seed, photo/clean-plate mode (hide the
sidebar + HUD), let the scene settle, then record.

## hero-globe-spin.gif
Full globe in the starfield. Orbit distance ~2.6, `controls.autoRotate = true;
controls.autoRotateSpeed = 0.4`, capture one clean ~7 s revolution slice.

## dive-to-ocean.gif
Scripted dolly from orbit (~r 3) down to a coastal skim (~r 1.08) over open
water, ending on the Gerstner swell + breaking shore foam. Ease in/out over 6 s,
`controls.target` at origin.

## raid-battle.gif
An E-SIM raid. Frame the camera low over a raider→target pair (read the
battlefield dir off `window.__planet.warSim.raids`), seek the war clock into the
clashing window, capture the armies clashing and the banners/scorch appearing.
The conflict is additive and heals (the covenant).

## weather-hurricane.gif
Oblique frame of a volumetric hurricane — eye, eyewall, rain. Summon/seek a
mature storm via the ⚡ god panel, ~8 s.

## fast-sun-daynight.gif
`window.__planet.sky.setSunSpeed(600)` (or the ⚡ god-panel sun slider), framed
on the night side so the terminator sweeps across, town-lights and aurora
igniting. ~6 s / ~4 sweeps, then reset sun speed to 1.

## dragon-airships.gif
Frame the dragon's lair on the tallest peak (read `window.__planet.dragon`
position) with an airship cruising a nearby route, ~8 s.
