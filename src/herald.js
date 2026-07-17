// THE AEMUNIS HERALD — a fantasy news ticker that narrates the user's REAL
// activity as a medieval chronicle. Pure DOM/UI (no THREE, no 3D materials —
// exempt from the WebGPU/TSL engine constraint). It owns a single slim strip
// pinned to the top-centre of the screen, scoped under #aemunis-herald with an
// injected <style> so it can never collide with ui.css. Every ~8-12s it fades
// one chronicle line out and the next one in.
//
// Lines are woven from REAL data, never invented:
//   • world data  — world.list() settlements (name/race/structure count) and
//                    world.stats (settlements / structures / agents at work).
//   • git events  — polled from /api/events (the same endpoint main.js polls;
//                    shape: { project, kind:'commit'|'pr-merged', id, title }).
//                    Commits and merged PRs become chronicle lines tied to the
//                    settlement they belong to.
//
// Phrasing is deterministic where it can be: an event's line is chosen by a
// hash of its id, and ambient world lines are seeded from `seed` + a counter,
// so the same activity narrates the same way on every launch. No Math.random,
// no Date.now — all cadence is accumulated from dt.
import { rngFromString, hash01 } from './util.js'

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------
const HERALD_ID = 'aemunis-herald'
const FADE_SECONDS = 0.6 // fade-in / fade-out duration
const HOLD_MIN = 8 // seconds a line stays fully visible (before its fade-out)
const HOLD_MAX = 12
const POLL_INTERVAL = 30 // seconds between /api/events polls (main polls 60s)
const MAX_EVENT_QUEUE = 12 // cap queued event-lines so a first big poll can't flood
const MAX_SEEN = 400 // cap the dedupe set so it can't grow without bound

// Flavour vocabulary, keyed by the four world races.
const RACEWORD = {
  human: ['masons', 'freeholders', 'banner-folk'],
  elf: ['wardens', 'grove-singers', 'star-scribes'],
  dwarf: ['smiths', 'stone-wrights', 'deep-delvers'],
  orc: ['warhosts', 'iron-drummers', 'tuskclans'],
}
const HALLWORD = ['halls', 'towers', 'holds', 'roofs', 'hearths']

function pick(arr, r) {
  return arr[Math.floor(r * arr.length) % arr.length]
}

function raceword(race, r) {
  return pick(RACEWORD[race] || RACEWORD.human, r)
}

// Best-effort display name for a project path: prefer the live settlement's
// fantasy name, else fall back to a tidied basename ("the tmp-clans").
function displayName(world, project, settlementsByProject) {
  const s = settlementsByProject.get(project)
  if (s && s.name) return s.name
  const base = project.split('/').filter(Boolean).pop() || project
  return base.replace(/[-_]+/g, ' ')
}

// ---------------------------------------------------------------------------
// Chronicle-line generators (all pure — take data, return a string)
// ---------------------------------------------------------------------------
function commitLine(name, race, title, r) {
  const rw = raceword(race, r)
  const t = (title || '').trim()
  const templates = [
    `By lantern-light the ${rw} of ${name} set another stone`,
    `${name}'s ${rw} raised a new work overnight`,
    `Word spreads through ${name} of labour freshly done`,
  ]
  if (t) {
    templates.push(`The chroniclers of ${name} inscribe: “${t}”`)
    templates.push(`In ${name} a deed is sealed — “${t}”`)
  }
  return pick(templates, r)
}

function mergeLine(name, race, title, r) {
  const rw = raceword(race, r)
  const t = (title || '').trim()
  const templates = [
    `A merge bridged the roads to ${name}; the ${rw} rejoice`,
    `Two roads became one at ${name}`,
    `The ${rw} of ${name} joined sundered ways this day`,
  ]
  if (t) templates.push(`The great work “${t}” is sealed at ${name}`)
  return pick(templates, r)
}

// Ambient lines from the live world state, seeded by `seed` + counter so they
// cycle deterministically rather than randomly.
function ambientLine(world, seed, counter, settlements) {
  const r = rngFromString(`${seed}:herald:ambient:${counter}`)
  const s = world.stats
  const roll = r() // one draw picks the template family

  if (settlements.length && roll < 0.5) {
    const chosen = settlements[Math.floor(r() * settlements.length) % settlements.length]
    const rw = raceword(chosen.race, r())
    const hall = pick(HALLWORD, r())
    const n = chosen.structures
    if (n <= 0) return `${chosen.name}, a young ${chosen.race} holding of ${rw}, takes root`
    return `${chosen.name}, a ${chosen.race} hold of ${n} ${hall}, keeps its ${rw} at watch`
  }

  if (s.agents > 0 && roll < 0.78) {
    const souls = s.agents === 1 ? 'a lone soul stirs' : `${s.agents} souls stir`
    return `Across the realm, ${s.structures} ${pick(HALLWORD, r())} stand and ${souls} at their labours`
  }

  if (s.settlements > 0) {
    return `${s.settlements} holds stand against the night; the chronicle keeps their names`
  }
  return `The realm lies still; the Herald keeps watch for the first stone laid`
}

// ---------------------------------------------------------------------------
export function createHerald(world, seed) {
  // --- DOM (scoped id + injected <style>, never touches ui.css) -------------
  const style = document.createElement('style')
  style.id = `${HERALD_ID}-style`
  style.textContent = `
#${HERALD_ID}{
  position:fixed; top:14px; left:50%; transform:translateX(-50%);
  z-index:15; pointer-events:none; box-sizing:border-box;
  max-width:min(60vw,560px); padding:5px 16px;
  display:flex; align-items:center; gap:9px;
  font-family:ui-monospace,'SF Mono',Menlo,monospace;
  font-size:11px; line-height:1.35; letter-spacing:0.2px;
  color:rgba(233,224,205,0.72);
  background:rgba(14,16,22,0.42);
  border:1px solid rgba(233,224,205,0.10);
  border-radius:999px;
  backdrop-filter:blur(6px); -webkit-backdrop-filter:blur(6px);
  box-shadow:0 2px 14px rgba(0,0,0,0.28);
  user-select:none;
}
#${HERALD_ID} .herald-mark{
  flex:0 0 auto; color:rgba(198,150,74,0.72);
  font-size:12px; text-shadow:0 0 6px rgba(198,150,74,0.25);
}
#${HERALD_ID} .herald-line{
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
  transition:opacity 0.15s linear;
}
@media (max-width:640px){ #${HERALD_ID}{ display:none; } }
`
  document.head.appendChild(style)

  const root = document.createElement('div')
  root.id = HERALD_ID
  const mark = document.createElement('span')
  mark.className = 'herald-mark'
  mark.textContent = '❦'
  const lineEl = document.createElement('span')
  lineEl.className = 'herald-line'
  lineEl.textContent = 'The Aemunis Herald takes up the quill…'
  root.append(mark, lineEl)
  document.body.appendChild(root)

  // --- state ----------------------------------------------------------------
  const seen = new Set() // event ids already narrated
  const seenOrder = [] // FIFO to bound `seen`
  const eventQueue = [] // pending event-derived lines (strings), FIFO
  let ambientCounter = 0

  // fade / rotation state machine (all dt-driven; no timers, no allocations)
  let phase = 'hold' // 'in' | 'hold' | 'out'
  let opacity = 0
  let holdTimer = HOLD_MIN
  let lastOpacity = -1

  // poll cadence
  let pollTimer = 1 // first poll ~1s after start (settlements may still be empty; fine)
  let inFlight = false
  let destroyed = false

  function rememberSeen(id) {
    seen.add(id)
    seenOrder.push(id)
    if (seenOrder.length > MAX_SEEN) seen.delete(seenOrder.shift())
  }

  // Snapshot of live settlements keyed by project (world populates async).
  function settlementIndex() {
    const list = world.list ? world.list() : []
    const byProject = new Map()
    for (const s of list) byProject.set(s.project, s)
    return { list, byProject }
  }

  async function pollEvents() {
    if (inFlight) return
    inFlight = true
    try {
      const res = await fetch('/api/events')
      if (!res.ok) return
      const events = await res.json()
      if (!Array.isArray(events) || destroyed) return
      const { byProject } = settlementIndex()
      for (const e of events) {
        if (!e || typeof e.id !== 'string' || typeof e.project !== 'string') continue
        if (e.kind !== 'commit' && e.kind !== 'pr-merged') continue
        if (seen.has(e.id)) continue
        rememberSeen(e.id)
        if (eventQueue.length >= MAX_EVENT_QUEUE) continue // dedupe but don't flood
        const name = displayName(world, e.project, byProject)
        const s = byProject.get(e.project)
        const race = (s && s.race) || 'human'
        const r = hash01(e.id) // deterministic phrasing per event
        eventQueue.push(
          e.kind === 'commit' ? commitLine(name, race, e.title, r) : mergeLine(name, race, e.title, r),
        )
      }
    } catch {
      /* server may be mid-restart; next poll catches up */
    } finally {
      inFlight = false
    }
  }

  // Advance to the next line: event-derived first, else an ambient world line.
  function nextLine() {
    if (eventQueue.length) return eventQueue.shift()
    const { list } = settlementIndex()
    const line = ambientLine(world, seed, ambientCounter, list)
    ambientCounter++
    return line
  }

  function beginLine() {
    lineEl.textContent = nextLine()
    phase = 'in'
    opacity = 0
  }

  function update(dt) {
    if (destroyed) return

    // --- git-event polling (dt-driven cadence) ---
    pollTimer -= dt
    if (pollTimer <= 0) {
      pollTimer = POLL_INTERVAL
      pollEvents()
    }

    // --- fade / rotation state machine ---
    if (phase === 'in') {
      opacity += dt / FADE_SECONDS
      if (opacity >= 1) {
        opacity = 1
        phase = 'hold'
        holdTimer = HOLD_MIN + hash01(`${seed}:hold:${ambientCounter}`) * (HOLD_MAX - HOLD_MIN)
      }
    } else if (phase === 'hold') {
      holdTimer -= dt
      if (holdTimer <= 0) phase = 'out'
    } else {
      // 'out'
      opacity -= dt / FADE_SECONDS
      if (opacity <= 0) {
        opacity = 0
        beginLine()
      }
    }

    if (opacity !== lastOpacity) {
      lineEl.style.opacity = opacity.toFixed(3)
      lastOpacity = opacity
    }
  }

  function destroy() {
    destroyed = true
    root.remove()
    style.remove()
  }

  // Kick off with the opening line already fading in.
  beginLine()

  return { update, destroy }
}
