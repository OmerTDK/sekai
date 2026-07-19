// AMBIENT SOUND — procedural WebAudio ambience: layered wind (filtered
// noise), ocean surge (slower filtered noise) and a faint settlement-
// activity bed. Pure WebAudio + DOM — no THREE, no scene object (non-scene
// module, herald.js-style).
//
// Contract (pinned): export function createAmbientSound(seed) ->
//   { start(), toggleMute(), setMuted(on), isMuted(), update(dt, camera, world) }
//
// Autoplay policy: the AudioContext is built and resumed lazily, strictly
// inside start() — which the UI's mute button calls from within its click
// handler (the required user gesture). Nothing is created, connected or
// played before that call, so this stays autoplay-policy safe. start() is
// idempotent — later calls just make sure a suspended context resumes.
//
// Determinism: the only randomness is the seeded white-noise buffer, filled
// from an rngFromString(seed+':ambient:noise') loop (NOT Math.random). All
// gain modulation thereafter reads live camera altitude + world.stats.agents
// and eases toward targets with the presentation dt — no Math.random,
// no Date.now, anywhere in this module.
import { rngFromString, clamp, lerp, SEA_LEVEL } from './util.js'

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------
const NOISE_SECONDS = 4 // length of the seeded looping noise buffer
const MUTE_STORAGE_KEY = 'planet-ambient-muted'
const MUTE_RAMP_SECONDS = 0.4 // setTargetAtTime time constant — no clicks/pops
const GAIN_EASE_RATE = 2.2 // per-second lerp rate toward modulation targets (no snap)

const MASTER_GAIN = 0.55 // overall ambience ceiling when unmuted

// Wind rises with camera altitude (camera.position.length()).
const WIND_ALT_MIN = 1.1
const WIND_ALT_MAX = 6.0
const WIND_GAIN_MIN = 0.06
const WIND_GAIN_MAX = 0.24

// Ocean/surf rises as the camera nears the surface.
const OCEAN_ALT_MIN = SEA_LEVEL
const OCEAN_ALT_MAX = SEA_LEVEL + 0.6
const OCEAN_GAIN_MIN = 0.02
const OCEAN_GAIN_MAX = 0.22

// Activity bed rises with the number of agents currently at work.
const ACTIVITY_AGENTS_MAX = 40
const ACTIVITY_GAIN_MAX = 0.1

function audioCtorAvailable() {
  return typeof window !== 'undefined' && !!(window.AudioContext || window.webkitAudioContext)
}

// Default to muted: nothing can play before the user's first gesture anyway,
// so a fresh session starts "silent" and the first mute-button click (which
// calls start() then toggleMute()) is what fades ambience in.
function readPersistedMuted() {
  try {
    const raw = window.localStorage.getItem(MUTE_STORAGE_KEY)
    if (raw === 'true') return true
    if (raw === 'false') return false
  } catch {
    /* localStorage unavailable (private mode, embedded webview, etc.) */
  }
  return true
}

function writePersistedMuted(on) {
  try {
    window.localStorage.setItem(MUTE_STORAGE_KEY, on ? 'true' : 'false')
  } catch {
    /* best-effort only — mute still works for this session */
  }
}

// Fill one seeded looping white-noise buffer — NOT Math.random.
function buildNoiseBuffer(ctx, seed) {
  const length = Math.max(1, Math.round(NOISE_SECONDS * ctx.sampleRate))
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate)
  const data = buffer.getChannelData(0)
  const rng = rngFromString(`${seed}:ambient:noise`)
  for (let i = 0; i < length; i++) data[i] = rng() * 2 - 1
  return buffer
}

export function createAmbientSound(seed) {
  let muted = readPersistedMuted()

  if (!audioCtorAvailable()) {
    // Safe no-op module — no WebAudio support in this environment.
    return {
      start() {},
      toggleMute() {},
      setMuted() {},
      isMuted: () => muted,
      update() {},
    }
  }

  let ctx = null
  let started = false
  let masterGain = null
  let windGain = null
  let oceanGain = null
  let activityGain = null

  // Eased (smoothed) current gain values — chase the modulation targets
  // every update() rather than snapping to them.
  let windCurrent = 0
  let oceanCurrent = 0
  let activityCurrent = 0

  function applyMasterGain(instant) {
    if (!masterGain) return
    const target = muted ? 0 : MASTER_GAIN
    if (instant) {
      masterGain.gain.value = target
    } else {
      masterGain.gain.setTargetAtTime(target, ctx.currentTime, MUTE_RAMP_SECONDS)
    }
  }

  function start() {
    if (started) {
      if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {})
      return
    }
    started = true

    try {
      const Ctor = window.AudioContext || window.webkitAudioContext
      ctx = new Ctor()

      const noise = buildNoiseBuffer(ctx, seed)

      masterGain = ctx.createGain()
      masterGain.gain.value = 0 // real target applied by applyMasterGain below — no pop
      masterGain.connect(ctx.destination)

      // --- wind: breathy high-passed noise ---
      const windSource = ctx.createBufferSource()
      windSource.buffer = noise
      windSource.loop = true
      const windFilter = ctx.createBiquadFilter()
      windFilter.type = 'highpass'
      windFilter.frequency.value = 500
      windFilter.Q.value = 0.5
      windGain = ctx.createGain()
      windGain.gain.value = 0
      windSource.connect(windFilter).connect(windGain).connect(masterGain)
      windSource.start(0)

      // --- ocean: low-passed rumbling noise ---
      const oceanSource = ctx.createBufferSource()
      oceanSource.buffer = noise
      oceanSource.loop = true
      const oceanFilter = ctx.createBiquadFilter()
      oceanFilter.type = 'lowpass'
      oceanFilter.frequency.value = 400
      oceanFilter.Q.value = 0.4
      oceanGain = ctx.createGain()
      oceanGain.gain.value = 0
      oceanSource.connect(oceanFilter).connect(oceanGain).connect(masterGain)
      oceanSource.start(0)

      // --- activity: a faint, narrow-band settlement bed ---
      const activitySource = ctx.createBufferSource()
      activitySource.buffer = noise
      activitySource.loop = true
      const activityFilter = ctx.createBiquadFilter()
      activityFilter.type = 'bandpass'
      activityFilter.frequency.value = 900
      activityFilter.Q.value = 1.2
      activityGain = ctx.createGain()
      activityGain.gain.value = 0
      activitySource.connect(activityFilter).connect(activityGain).connect(masterGain)
      activitySource.start(0)

      if (ctx.state === 'suspended') ctx.resume().catch(() => {})
      applyMasterGain(true)
    } catch {
      // WebAudio init failed (policy/hardware/embedded webview) — stay a
      // silent no-op from here on; `started` stays true so we don't retry
      // building a half-connected graph every click.
      ctx = null
      masterGain = null
      windGain = null
      oceanGain = null
      activityGain = null
    }
  }

  function setMuted(on) {
    muted = !!on
    writePersistedMuted(muted)
    if (started && ctx) applyMasterGain(false)
  }

  function toggleMute() {
    setMuted(!muted)
  }

  function isMuted() {
    return muted
  }

  function update(dt, camera, world) {
    if (!started || !ctx || !windGain || !oceanGain || !activityGain) return

    const ease = clamp(dt * GAIN_EASE_RATE, 0, 1)

    const camDist = camera && camera.position ? camera.position.length() : WIND_ALT_MIN

    const windT = clamp((camDist - WIND_ALT_MIN) / (WIND_ALT_MAX - WIND_ALT_MIN), 0, 1)
    const windTarget = lerp(WIND_GAIN_MIN, WIND_GAIN_MAX, windT)
    windCurrent = lerp(windCurrent, windTarget, ease)
    windGain.gain.value = windCurrent

    const oceanT = clamp((OCEAN_ALT_MAX - camDist) / (OCEAN_ALT_MAX - OCEAN_ALT_MIN), 0, 1)
    const oceanTarget = lerp(OCEAN_GAIN_MIN, OCEAN_GAIN_MAX, oceanT)
    oceanCurrent = lerp(oceanCurrent, oceanTarget, ease)
    oceanGain.gain.value = oceanCurrent

    const agents = world && world.stats ? world.stats.agents : 0
    const activityT = clamp(agents / ACTIVITY_AGENTS_MAX, 0, 1)
    const activityTarget = activityT * ACTIVITY_GAIN_MAX
    activityCurrent = lerp(activityCurrent, activityTarget, ease)
    activityGain.gain.value = activityCurrent
  }

  return { start, toggleMute, setMuted, isMuted, update }
}
