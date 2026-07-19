// Sidebar + legend UI: a settlement browser (filter, click-to-visit) and a
// collapsible legend explaining race glyphs/colors and building types.
// Also: a building-inspector card (click a structure in the scene), a cmd-k
// jump-to-settlement palette, and a photo-mode toggle for clean screenshots.
// Pure DOM — no THREE here. The world module is only touched through its
// public contract: world.stats / world.list() / world.visit(project) /
// world.onStructureClick(cb) (optional — guarded, may not exist).
//
// All DOM is created and owned by this module inside a single container
// appended to document.body; index.html only supplies the CSS for it.

// Kept in sync by hand with src/world.js's RACE_GLYPHS / RACE_PALETTES.accent.
const RACE_GLYPHS = { human: '⚑', elf: '✦', dwarf: '⚒', orc: '⚔' }
const RACE_COLORS = { human: '#3b5c8c', elf: '#5aa868', dwarf: '#c9622f', orc: '#9fb15c' }
const RACE_ORDER = ['human', 'elf', 'dwarf', 'orc']

// Plain-language mirror of src/world.js's TYPE_RULES / FALLBACK_TYPES.
const BUILDING_LEGEND = [
  ['barracks', 'bugfix/debug sessions'],
  ['farm', 'data & SQL'],
  ['observatory', 'research'],
  ['library', 'docs & writing'],
  ['forge', 'deploys & infra'],
  ['hall', 'UI & design'],
  ['tower', 'everything else'],
]

// Mirror of src/world.js's pickTier() bands, in plain language for the inspector.
const TIER_LABELS = { 1: 'humble', 2: 'established', 3: 'grand' }

const REFRESH_INTERVAL = 2 // seconds between throttled settlement-row refreshes
const STORAGE_KEY = 'planet-sidebar-collapsed'
const FLASH_MS = 450
const RESUME_RESET_MS = 2000 // ms the inspector's "opening terminal…" button state is held

export function createUI(world, hooks) {
  // hooks may be undefined (or partially populated) — always guard with a
  // typeof check before invoking either callback.
  const safeHooks = hooks || {}

  // --- shell ------------------------------------------------------------

  const root = document.createElement('div')
  root.id = 'planet-ui'
  document.body.appendChild(root)

  const sidebar = document.createElement('aside')
  sidebar.id = 'sidebar'
  root.appendChild(sidebar)

  const inner = document.createElement('div')
  inner.className = 'sidebar-inner'
  sidebar.appendChild(inner)

  // --- header -------------------------------------------------------------

  const header = document.createElement('div')
  header.className = 'sidebar-header'
  const headerTitle = document.createElement('span')
  headerTitle.className = 'sidebar-header-title'
  headerTitle.textContent = 'SETTLEMENTS'
  const headerCount = document.createElement('span')
  headerCount.className = 'sidebar-header-count'
  headerCount.textContent = '0'
  header.appendChild(headerTitle)
  header.appendChild(headerCount)
  inner.appendChild(header)

  // --- filter ---------------------------------------------------------------

  const filterWrap = document.createElement('div')
  filterWrap.className = 'sidebar-filter'
  const filterInput = document.createElement('input')
  filterInput.type = 'search'
  filterInput.className = 'sidebar-filter-input'
  filterInput.placeholder = 'filter…'
  filterInput.autocomplete = 'off'
  filterInput.spellcheck = false
  filterInput.setAttribute('aria-label', 'Filter settlements')
  filterWrap.appendChild(filterInput)
  inner.appendChild(filterWrap)

  // --- scroll region: settlement rows + legend ------------------------------

  const scroll = document.createElement('div')
  scroll.className = 'sidebar-scroll'
  inner.appendChild(scroll)

  const list = document.createElement('div')
  list.className = 'settlement-list'
  scroll.appendChild(list)

  const empty = document.createElement('div')
  empty.className = 'settlement-empty'
  scroll.appendChild(empty)

  // Row template, cloned per settlement (never touched by innerHTML).
  const rowTemplate = document.createElement('div')
  rowTemplate.className = 'settlement-row'
  {
    const glyph = document.createElement('span')
    glyph.className = 'row-glyph'

    const main = document.createElement('span')
    main.className = 'row-main'
    const name = document.createElement('span')
    name.className = 'row-name'
    const basename = document.createElement('span')
    basename.className = 'row-basename'
    main.appendChild(name)
    main.appendChild(basename)

    const meta = document.createElement('span')
    meta.className = 'row-meta'
    const structures = document.createElement('span')
    structures.className = 'row-structures'
    const agents = document.createElement('span')
    agents.className = 'row-agents'
    const dot = document.createElement('span')
    dot.className = 'row-dot'
    const agentCount = document.createElement('span')
    agentCount.className = 'row-agent-count'
    agents.appendChild(dot)
    agents.appendChild(agentCount)
    meta.appendChild(structures)
    meta.appendChild(agents)

    rowTemplate.appendChild(glyph)
    rowTemplate.appendChild(main)
    rowTemplate.appendChild(meta)
  }

  // --- legend (collapsible, open by default) --------------------------------

  const legend = document.createElement('details')
  legend.className = 'sidebar-legend'
  legend.open = true
  const legendSummary = document.createElement('summary')
  legendSummary.textContent = 'LEGEND'
  legend.appendChild(legendSummary)

  const racesGroup = document.createElement('div')
  racesGroup.className = 'legend-group'
  const racesTitle = document.createElement('div')
  racesTitle.className = 'legend-group-title'
  racesTitle.textContent = 'Races'
  racesGroup.appendChild(racesTitle)
  for (const race of RACE_ORDER) {
    const row = document.createElement('div')
    row.className = 'legend-race-row'

    const glyph = document.createElement('span')
    glyph.className = 'legend-glyph'
    glyph.textContent = RACE_GLYPHS[race]
    glyph.style.color = RACE_COLORS[race]

    const label = document.createElement('span')
    label.className = 'legend-label'
    label.textContent = race

    const chip = document.createElement('span')
    chip.className = 'legend-chip'
    chip.style.background = RACE_COLORS[race]

    row.appendChild(glyph)
    row.appendChild(label)
    row.appendChild(chip)
    racesGroup.appendChild(row)
  }
  legend.appendChild(racesGroup)

  const buildingsGroup = document.createElement('div')
  buildingsGroup.className = 'legend-group'
  const buildingsTitle = document.createElement('div')
  buildingsTitle.className = 'legend-group-title'
  buildingsTitle.textContent = 'Buildings'
  buildingsGroup.appendChild(buildingsTitle)
  for (const [type, meaning] of BUILDING_LEGEND) {
    const row = document.createElement('div')
    row.className = 'legend-building-row'
    const term = document.createElement('span')
    term.className = 'legend-term'
    term.textContent = type
    const dash = document.createElement('span')
    dash.className = 'legend-dash'
    dash.textContent = '—'
    const desc = document.createElement('span')
    desc.className = 'legend-desc'
    desc.textContent = meaning
    row.appendChild(term)
    row.appendChild(dash)
    row.appendChild(desc)
    buildingsGroup.appendChild(row)
  }
  for (const note of ['scaffold = under construction', 'green dot = working right now']) {
    const noteEl = document.createElement('div')
    noteEl.className = 'legend-note'
    noteEl.textContent = note
    buildingsGroup.appendChild(noteEl)
  }
  legend.appendChild(buildingsGroup)

  scroll.appendChild(legend)

  // --- collapse toggle --------------------------------------------------------

  const toggle = document.createElement('button')
  toggle.type = 'button'
  toggle.className = 'sidebar-toggle'
  toggle.setAttribute('aria-label', 'Toggle settlement sidebar')
  toggle.textContent = '‹'
  sidebar.appendChild(toggle)

  const railLabel = document.createElement('div')
  railLabel.className = 'sidebar-rail-label'
  railLabel.textContent = 'SETTLEMENTS'
  sidebar.appendChild(railLabel)

  let collapsed = false
  try {
    collapsed = localStorage.getItem(STORAGE_KEY) === '1'
  } catch (e) {
    collapsed = false // localStorage may be unavailable (private mode, etc).
  }

  function applyCollapsed() {
    sidebar.classList.toggle('collapsed', collapsed)
    toggle.setAttribute('aria-expanded', String(!collapsed))
  }
  applyCollapsed()

  toggle.addEventListener('click', () => {
    collapsed = !collapsed
    applyCollapsed()
    try {
      localStorage.setItem(STORAGE_KEY, collapsed ? '1' : '0')
    } catch (e) {
      // Ignore — persistence is a nicety, not a requirement.
    }
  })

  // --- settlement row rendering ------------------------------------------------

  let latestData = []
  let lastSignature = null // null (not '') so the very first refresh always renders
  // Declared here (not down in the time-lapse section) so refreshFromWorld —
  // which fires synchronously below, before that section runs — can read it.
  let timeLapseOn = false

  function signatureOf(data) {
    // Cheap order-independent change signature over the fields rows depend on.
    const parts = data.map(
      (s) => s.project + '|' + s.name + '|' + s.basename + '|' + s.race + '|' + s.structures + '|' + s.agents,
    )
    parts.sort()
    return parts.join('\n')
  }

  // Shared by the sidebar list and the cmd-k palette: filter by name/basename
  // (case-insensitive substring), settlements with active agents ranked
  // first, then by structure count. `limit` (optional) caps the result count.
  function filterAndRank(data, query, limit) {
    const q = query.trim().toLowerCase()
    let rows = q
      ? data.filter((s) => s.name.toLowerCase().includes(q) || s.basename.toLowerCase().includes(q))
      : data.slice()
    rows.sort((a, b) => {
      const activeA = a.agents > 0 ? 1 : 0
      const activeB = b.agents > 0 ? 1 : 0
      if (activeA !== activeB) return activeB - activeA
      return b.structures - a.structures
    })
    return typeof limit === 'number' ? rows.slice(0, limit) : rows
  }

  function sortedFiltered() {
    return filterAndRank(latestData, filterInput.value)
  }

  function fillRow(row, s) {
    const glyphEl = row.querySelector('.row-glyph')
    glyphEl.textContent = RACE_GLYPHS[s.race] || '?'
    glyphEl.style.color = RACE_COLORS[s.race] || '#cfd8e3'
    row.querySelector('.row-name').textContent = s.name
    row.querySelector('.row-basename').textContent = s.basename
    row.querySelector('.row-structures').textContent = String(s.structures)
    const agentsEl = row.querySelector('.row-agents')
    const countEl = row.querySelector('.row-agent-count')
    if (s.agents > 0) {
      agentsEl.classList.add('active')
      countEl.textContent = s.agents > 1 ? '×' + s.agents : ''
    } else {
      agentsEl.classList.remove('active')
      countEl.textContent = ''
    }
    row.dataset.project = s.project
  }

  function renderRows() {
    const scrollTop = scroll.scrollTop // preserve scroll across rebuilds
    const rows = sortedFiltered()

    list.textContent = '' // clear (no innerHTML — nothing here is user markup)
    for (const s of rows) {
      const row = rowTemplate.cloneNode(true)
      fillRow(row, s)
      list.appendChild(row)
    }

    empty.textContent = latestData.length ? 'no matches' : 'no settlements yet'
    empty.classList.toggle('hidden', rows.length > 0)
    headerCount.textContent = String(latestData.length)

    scroll.scrollTop = scrollTop
  }

  list.addEventListener('click', (e) => {
    const row = e.target.closest('.settlement-row')
    if (!row) return
    const project = row.dataset.project
    if (!project) return
    world.visit(project)
    row.classList.remove('flash')
    void row.offsetWidth // restart the flash animation even on rapid re-clicks
    row.classList.add('flash')
    setTimeout(() => row.classList.remove('flash'), FLASH_MS)
  })

  filterInput.addEventListener('input', renderRows) // live filter, no throttle

  // --- refresh scheduling -----------------------------------------------------

  function refreshFromWorld() {
    if (timeLapseOn) return // sidebar's live refresh is paused while scrubbing time-lapse history
    const data = world.list()
    const sig = signatureOf(data)
    if (sig === lastSignature) return // nothing changed — leave rows/scroll alone
    lastSignature = sig
    latestData = data
    renderRows()
  }

  // NOTE: main.js's render loop does not currently call ui.update(dt) (verified
  // by reading src/main.js — only planet/sky/world/birds/flora/wind/storms/
  // controls are pumped there). update(dt) below still throttles correctly to
  // the required ~2s cadence if/when it is wired in. In the meantime this
  // interval drives the same refresh so the sidebar doesn't sit stale/empty;
  // both paths share the signature guard above, so firing from both is
  // harmless (the second is just a no-op check).
  refreshFromWorld()
  setInterval(refreshFromWorld, REFRESH_INTERVAL * 1000)

  let refreshAccum = REFRESH_INTERVAL // fire on the first call too

  function update(dt) {
    refreshAccum += dt || 0
    if (refreshAccum < REFRESH_INTERVAL) return
    refreshAccum = 0
    refreshFromWorld()
  }

  // --- building inspector (right-side card, shown via world.onStructureClick) -

  const inspectorCard = document.createElement('div')
  inspectorCard.id = 'inspector-card'
  root.appendChild(inspectorCard)

  const inspectorTitle = document.createElement('div')
  inspectorTitle.className = 'inspector-title'
  inspectorCard.appendChild(inspectorTitle)

  const inspectorSettlementRow = document.createElement('div')
  inspectorSettlementRow.className = 'inspector-settlement-row'
  const inspectorGlyph = document.createElement('span')
  inspectorGlyph.className = 'inspector-glyph'
  const inspectorSettlementName = document.createElement('span')
  inspectorSettlementName.className = 'inspector-settlement-name'
  inspectorSettlementRow.appendChild(inspectorGlyph)
  inspectorSettlementRow.appendChild(inspectorSettlementName)
  inspectorCard.appendChild(inspectorSettlementRow)

  const inspectorType = document.createElement('div')
  inspectorType.className = 'inspector-detail'
  inspectorCard.appendChild(inspectorType)

  const inspectorDate = document.createElement('div')
  inspectorDate.className = 'inspector-detail'
  inspectorCard.appendChild(inspectorDate)

  const inspectorSize = document.createElement('div')
  inspectorSize.className = 'inspector-detail'
  inspectorCard.appendChild(inspectorSize)

  const inspectorSessionId = document.createElement('div')
  inspectorSessionId.className = 'inspector-session-id'
  inspectorCard.appendChild(inspectorSessionId)

  const inspectorActions = document.createElement('div')
  inspectorActions.className = 'inspector-actions'
  inspectorCard.appendChild(inspectorActions)

  const inspectorResumeBtn = document.createElement('button')
  inspectorResumeBtn.type = 'button'
  inspectorResumeBtn.className = 'inspector-btn inspector-resume-btn'
  inspectorResumeBtn.textContent = 'Resume session'
  inspectorActions.appendChild(inspectorResumeBtn)

  const inspectorCloseBtn = document.createElement('button')
  inspectorCloseBtn.type = 'button'
  inspectorCloseBtn.className = 'inspector-btn inspector-close-btn'
  inspectorCloseBtn.textContent = 'Close'
  inspectorActions.appendChild(inspectorCloseBtn)

  let inspectorInfo = null
  let resumeResetTimer = null

  function humanizeBytes(bytes) {
    const n = Number.isFinite(bytes) ? bytes : 0
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
    return (n / (1024 * 1024)).toFixed(2) + ' MB'
  }

  function resetResumeButton() {
    if (resumeResetTimer) {
      clearTimeout(resumeResetTimer)
      resumeResetTimer = null
    }
    inspectorResumeBtn.disabled = false
    inspectorResumeBtn.textContent = 'Resume session'
  }

  function openInspector(info) {
    if (!info) return
    inspectorInfo = info
    resetResumeButton() // cancel any pending "opening terminal…" reset from a previous structure

    inspectorTitle.textContent = info.topic || '(untitled)'

    inspectorGlyph.textContent = RACE_GLYPHS[info.race] || '?'
    inspectorGlyph.style.color = RACE_COLORS[info.race] || '#cfd8e3'
    inspectorSettlementName.textContent = info.settlementName || ''

    const tierLabel = TIER_LABELS[info.tier] || ''
    inspectorType.textContent = [info.type, tierLabel].filter(Boolean).join(' · ')

    const when = Number.isFinite(info.lastActive) ? new Date(info.lastActive) : null
    inspectorDate.textContent = when
      ? when.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
      : '—'

    inspectorSize.textContent = humanizeBytes(info.bytes)
    inspectorSessionId.textContent = info.id ? 'session ' + info.id : ''

    inspectorCard.classList.add('open') // re-opening while already open just swaps the content in place
  }

  function closeInspector() {
    inspectorCard.classList.remove('open')
    inspectorInfo = null
    resetResumeButton()
  }

  inspectorResumeBtn.addEventListener('click', () => {
    if (!inspectorInfo) return
    if (typeof safeHooks.resumeSession === 'function')
      safeHooks.resumeSession(inspectorInfo.id, inspectorInfo.project)
    inspectorResumeBtn.disabled = true
    inspectorResumeBtn.textContent = 'opening terminal…'
    if (resumeResetTimer) clearTimeout(resumeResetTimer)
    resumeResetTimer = setTimeout(resetResumeButton, RESUME_RESET_MS)
  })

  inspectorCloseBtn.addEventListener('click', closeInspector)

  if (typeof world.onStructureClick === 'function') {
    world.onStructureClick(openInspector)
  }

  // --- cmd-k palette (search + jump to a settlement) -------------------------

  const cmdkOverlay = document.createElement('div')
  cmdkOverlay.id = 'cmdk-overlay'
  cmdkOverlay.setAttribute('role', 'dialog')
  cmdkOverlay.setAttribute('aria-modal', 'true')
  root.appendChild(cmdkOverlay)

  const cmdkBox = document.createElement('div')
  cmdkBox.className = 'cmdk-box'
  cmdkOverlay.appendChild(cmdkBox)

  const cmdkInput = document.createElement('input')
  cmdkInput.type = 'search'
  cmdkInput.className = 'cmdk-input'
  cmdkInput.placeholder = 'Jump to a settlement…'
  cmdkInput.autocomplete = 'off'
  cmdkInput.spellcheck = false
  cmdkInput.setAttribute('aria-label', 'Jump to settlement')
  cmdkBox.appendChild(cmdkInput)

  const cmdkResults = document.createElement('div')
  cmdkResults.className = 'cmdk-results'
  cmdkBox.appendChild(cmdkResults)

  const cmdkEmpty = document.createElement('div')
  cmdkEmpty.className = 'settlement-empty'
  cmdkEmpty.textContent = 'no matches'
  cmdkBox.appendChild(cmdkEmpty)

  let paletteOpen = false
  let paletteSnapshot = [] // world.list() snapshot taken at open — results are re-derived from this per keystroke, never re-fetched
  let paletteRows = []
  let paletteSelected = 0

  function renderPaletteResults() {
    paletteRows = filterAndRank(paletteSnapshot, cmdkInput.value, 12)
    cmdkResults.textContent = ''
    for (let i = 0; i < paletteRows.length; i++) {
      const row = rowTemplate.cloneNode(true) // reuse the sidebar row template/styling
      fillRow(row, paletteRows[i])
      row.classList.add('cmdk-row')
      if (i === paletteSelected) row.classList.add('selected')
      cmdkResults.appendChild(row)
    }
    cmdkEmpty.classList.toggle('hidden', paletteRows.length > 0)
  }

  function highlightPaletteSelection() {
    const rows = cmdkResults.children
    for (let i = 0; i < rows.length; i++) rows[i].classList.toggle('selected', i === paletteSelected)
  }

  function movePaletteSelection(delta) {
    if (!paletteRows.length) return
    paletteSelected = (paletteSelected + delta + paletteRows.length) % paletteRows.length
    highlightPaletteSelection()
  }

  function selectPaletteActive() {
    const s = paletteRows[paletteSelected]
    if (!s) return
    world.visit(s.project)
    closePalette()
  }

  function openPalette() {
    paletteSnapshot = world.list()
    paletteSelected = 0
    cmdkInput.value = ''
    paletteOpen = true
    cmdkOverlay.classList.add('open')
    renderPaletteResults()
    cmdkInput.focus()
  }

  function closePalette() {
    paletteOpen = false
    cmdkOverlay.classList.remove('open')
    cmdkInput.blur()
  }

  cmdkOverlay.addEventListener('click', (e) => {
    if (e.target === cmdkOverlay) closePalette() // backdrop click, not the box itself
  })

  cmdkResults.addEventListener('click', (e) => {
    const row = e.target.closest('.cmdk-row')
    if (!row || !row.dataset.project) return
    world.visit(row.dataset.project)
    closePalette()
  })

  cmdkInput.addEventListener('input', () => {
    paletteSelected = 0
    renderPaletteResults()
  })

  // --- photo mode (hide chrome for clean screenshots) -------------------------

  const photoBtn = document.createElement('button')
  photoBtn.type = 'button'
  photoBtn.id = 'photo-mode-btn'
  photoBtn.title = 'Photo mode (h)'
  photoBtn.setAttribute('aria-label', 'Toggle photo mode')
  photoBtn.textContent = '📷'
  root.appendChild(photoBtn)

  let photoMode = false

  function setPhotoModeState(on) {
    photoMode = on
    document.body.classList.toggle('photo-mode', on)
    if (typeof safeHooks.setPhotoMode === 'function') safeHooks.setPhotoMode(on)
  }

  photoBtn.addEventListener('click', () => setPhotoModeState(!photoMode))

  // --- time-lapse mode (scrub history via world.setTimeFilter, optional API) --
  // Sibling API on world, landed independently — always typeof-guarded:
  //   world.setTimeFilter(cutoffMs|null) — null = live; cutoff = show only
  //     structures with lastActive <= cutoff.
  //   world.getTimeRange() -> { min, max } epoch ms.
  // If world.setTimeFilter is missing, the toggle button just stays hidden.

  const timeLapseSupported = typeof world.setTimeFilter === 'function'

  const PLAY_DURATION_MS = 45000 // target duration for a full min→max sweep
  const TIME_FILTER_THROTTLE_MS = 1000 / 30 // cap world.setTimeFilter calls to ~30/s

  const timeLapseBtn = document.createElement('button')
  timeLapseBtn.type = 'button'
  timeLapseBtn.id = 'timelapse-btn'
  timeLapseBtn.title = 'Time-lapse history'
  timeLapseBtn.setAttribute('aria-label', 'Toggle time-lapse history')
  timeLapseBtn.textContent = '⏳'
  if (!timeLapseSupported) timeLapseBtn.classList.add('hidden') // API not landed — stay hidden rather than error
  root.appendChild(timeLapseBtn)

  const timelineBar = document.createElement('div')
  timelineBar.id = 'timelapse-bar'
  root.appendChild(timelineBar)

  const timelineRow = document.createElement('div')
  timelineRow.className = 'timelapse-row'
  timelineBar.appendChild(timelineRow)

  const timelinePlayBtn = document.createElement('button')
  timelinePlayBtn.type = 'button'
  timelinePlayBtn.className = 'timelapse-play-btn'
  timelinePlayBtn.setAttribute('aria-label', 'Play time-lapse playback')
  timelinePlayBtn.textContent = '▶'
  timelineRow.appendChild(timelinePlayBtn)

  const timelineRange = document.createElement('input')
  timelineRange.type = 'range'
  timelineRange.className = 'timelapse-range'
  timelineRange.setAttribute('aria-label', 'Time-lapse scrubber')
  timelineRow.appendChild(timelineRange)

  const timelineCloseBtn = document.createElement('button')
  timelineCloseBtn.type = 'button'
  timelineCloseBtn.className = 'timelapse-close-btn'
  timelineCloseBtn.setAttribute('aria-label', 'Exit time-lapse')
  timelineCloseBtn.textContent = '✕'
  timelineRow.appendChild(timelineCloseBtn)

  const timelineLabel = document.createElement('div')
  timelineLabel.className = 'timelapse-label'
  timelineBar.appendChild(timelineLabel)

  let rangeMin = 0
  let rangeMax = 0
  let lastFilterCallTs = 0
  let playing = false
  let playRafId = null
  let playLastTs = null

  function formatTimeLabel(value) {
    const d = new Date(value)
    return isNaN(d.getTime()) ? '—' : d.toLocaleString()
  }

  // Throttled to ~30/s: pass force=true for discrete transitions (open, close,
  // the 'change' commit, and the final frame of playback) that must never be
  // dropped by the throttle window.
  function applyTimeFilter(value, force) {
    if (!timeLapseSupported) return
    const now = Date.now()
    if (!force && now - lastFilterCallTs < TIME_FILTER_THROTTLE_MS) return
    lastFilterCallTs = now
    world.setTimeFilter(value)
  }

  function setScrubberValue(value, force) {
    timelineRange.value = String(value)
    timelineLabel.textContent = formatTimeLabel(value) // unthrottled — ticks every call, incl. every rAF frame while playing
    applyTimeFilter(value, force)
  }

  function updatePlayButton() {
    timelinePlayBtn.textContent = playing ? '⏸' : '▶'
    timelinePlayBtn.setAttribute(
      'aria-label',
      playing ? 'Pause time-lapse playback' : 'Play time-lapse playback',
    )
  }

  function stopPlay() {
    playing = false
    updatePlayButton()
    if (playRafId != null) cancelAnimationFrame(playRafId)
    playRafId = null
    playLastTs = null
  }

  function playTick(ts) {
    if (!playing) return
    if (playLastTs == null) playLastTs = ts
    const dt = ts - playLastTs
    playLastTs = ts
    const rate = (rangeMax - rangeMin) / PLAY_DURATION_MS // units of sim-time per ms of real-time
    const value = Number(timelineRange.value) + rate * dt
    if (value >= rangeMax) {
      setScrubberValue(rangeMax, true)
      stopPlay() // reaching max auto-exits play state; bar stays open at 'now'
      return
    }
    setScrubberValue(value, false)
    playRafId = requestAnimationFrame(playTick)
  }

  function startPlay() {
    if (!timeLapseOn || rangeMax <= rangeMin) return
    if (Number(timelineRange.value) >= rangeMax) setScrubberValue(rangeMin, true) // restart from the start when already at 'now'
    playing = true
    updatePlayButton()
    playLastTs = null
    playRafId = requestAnimationFrame(playTick)
  }

  function openTimeLapse() {
    if (!timeLapseSupported || timeLapseOn) return

    let range = typeof world.getTimeRange === 'function' ? world.getTimeRange() : null
    if (!range || !Number.isFinite(range.min) || !Number.isFinite(range.max) || range.max <= range.min) {
      range = { min: Date.now() - 24 * 60 * 60 * 1000, max: Date.now() } // defensive fallback — missing/degenerate range
    }
    rangeMin = range.min
    rangeMax = range.max

    const span = Math.max(1, rangeMax - rangeMin)
    timelineRange.min = String(rangeMin)
    timelineRange.max = String(rangeMax)
    timelineRange.step = String(Math.max(1, span / 100)) // also gives native ←/→ arrow keys a 1%-of-range nudge

    timeLapseOn = true
    timeLapseBtn.classList.add('active')
    timelineBar.classList.add('open')
    document.body.classList.add('time-lapse')
    setScrubberValue(rangeMax, true) // start at 'now' — visually equivalent to live until scrubbed back
  }

  function closeTimeLapse() {
    if (!timeLapseOn) return
    stopPlay()
    timeLapseOn = false
    timeLapseBtn.classList.remove('active')
    timelineBar.classList.remove('open')
    document.body.classList.remove('time-lapse')
    if (typeof world.setTimeFilter === 'function') world.setTimeFilter(null)
  }

  timeLapseBtn.addEventListener('click', () => {
    if (timeLapseOn) closeTimeLapse()
    else openTimeLapse()
  })

  timelineCloseBtn.addEventListener('click', closeTimeLapse)

  timelinePlayBtn.addEventListener('click', () => {
    if (playing) stopPlay()
    else startPlay()
  })

  // Native range-input keyboard handling (←/→/Home/End) already nudges by
  // `step`, which openTimeLapse sets to 1% of the range — no custom key
  // handling needed for that requirement.
  timelineRange.addEventListener('input', () => {
    if (playing) stopPlay() // manual scrub takes over from playback
    setScrubberValue(Number(timelineRange.value), false)
  })

  timelineRange.addEventListener('change', () => {
    applyTimeFilter(Number(timelineRange.value), true) // force the final value through even if throttled mid-drag
  })

  // --- global keyboard shortcuts: cmd/ctrl+k, escape, h ------------------------

  function isTypingInField(target) {
    if (!target) return false
    return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable
  }

  document.addEventListener('keydown', (e) => {
    const key = e.key

    if ((key === 'k' || key === 'K') && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      if (paletteOpen) closePalette()
      else openPalette()
      return
    }

    if (key === 'Escape') {
      if (paletteOpen) closePalette()
      else if (godPanelOpen) toggleGodPanel(false)
      else if (featurePanelOpen) toggleFeaturePanel(false)
      else if (inspectorCard.classList.contains('open')) closeInspector()
      else if (timeLapseOn) closeTimeLapse()
      else if (photoMode) setPhotoModeState(false)
      return
    }

    if (paletteOpen) {
      if (key === 'ArrowDown') {
        e.preventDefault()
        movePaletteSelection(1)
      } else if (key === 'ArrowUp') {
        e.preventDefault()
        movePaletteSelection(-1)
      } else if (key === 'Enter') {
        e.preventDefault()
        selectPaletteActive()
      }
      return
    }

    if ((key === 'h' || key === 'H') && !isTypingInField(e.target)) {
      e.preventDefault()
      setPhotoModeState(!photoMode)
    }
  })

  // --- viewport controls: zoom + feature toggles ------------------------------
  // Zoom works by dispatching wheel events at the canvas — OrbitControls' own
  // dolly+damping path handles them, so the UI needs no direct controls ref.
  function zoomBy(deltaY) {
    const c = document.querySelector('canvas')
    if (c) c.dispatchEvent(new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true }))
  }

  const vpControls = document.createElement('div')
  vpControls.id = 'viewport-controls'

  function makeVpBtn(glyph, label, onClick) {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'vp-btn'
    b.textContent = glyph
    b.title = label
    b.setAttribute('aria-label', label)
    b.addEventListener('click', onClick)
    vpControls.appendChild(b)
    return b
  }

  const featuresBtn = makeVpBtn('🎛', 'Toggle features', () => toggleFeaturePanel())
  const godBtn = makeVpBtn('⚡', 'God controls', () => toggleGodPanel())
  makeVpBtn('+', 'Zoom in', () => zoomBy(-260))
  makeVpBtn('−', 'Zoom out', () => zoomBy(260))

  // E4: ambient mute, poster capture, auto-tour. All lazily/guard-read the live
  // module handles off window.__planet so the UI never hard-depends on them.
  const muteBtn = makeVpBtn('🔇', 'Ambient sound', () => {
    const a = window.__planet && window.__planet.ambientSound
    if (!a) return
    if (typeof a.start === 'function') a.start() // this click is the user gesture that unlocks WebAudio
    if (typeof a.toggleMute === 'function') a.toggleMute()
    const muted = typeof a.isMuted === 'function' ? a.isMuted() : true
    muteBtn.textContent = muted ? '🔇' : '🔊'
    muteBtn.classList.toggle('active', !muted)
  })
  makeVpBtn('🖼', 'Capture poster', () => {
    const p = window.__planet && window.__planet.poster
    if (p && typeof p.capture === 'function') p.capture(3)
  })
  const tourBtn = makeVpBtn('🎬', 'Auto-tour', () => {
    const t = window.__planet && window.__planet.autoTour
    if (!t || typeof t.toggle !== 'function') return
    t.toggle()
    const running = typeof t.isRunning === 'function' ? t.isRunning() : false
    tourBtn.classList.toggle('active', running)
  })
  root.appendChild(vpControls)

  // --- feature toggle panel ---------------------------------------------------
  // Each row flips `.visible` on a live scene group exposed via window.__planet.
  // Read lazily (the handle is populated just after createUI returns) and always
  // guarded, so a missing/renamed module simply yields an inert row.
  // Each feature exposes read()/write(on). Most just flip `.visible` on a live
  // scene group; clouds routes through sky's own toggle since the two cloud
  // decks share the sky group with the stars/atmosphere and can't be hidden
  // wholesale.
  function featureGroup(key) {
    const mod = window.__planet && window.__planet[key]
    return mod && mod.group ? mod.group : null
  }
  function groupFeature(key, label) {
    return {
      storageKey: key,
      label,
      read: () => {
        const g = featureGroup(key)
        return g ? g.visible : true
      },
      write: (on) => {
        const g = featureGroup(key)
        if (g) g.visible = on
      },
    }
  }
  const FEATURES = [
    groupFeature('flora', 'Trees & rocks'),
    groupFeature('birds', 'Birds'),
    {
      storageKey: 'clouds',
      label: 'Clouds',
      read: () => {
        const s = window.__planet && window.__planet.sky
        return s && s.getCloudsVisible ? s.getCloudsVisible() : true
      },
      write: (on) => {
        const s = window.__planet && window.__planet.sky
        if (s && s.setCloudsVisible) s.setCloudsVisible(on)
      },
    },
    groupFeature('storms', 'Hurricane'),
    groupFeature('weather', 'Rain & snow'),
    groupFeature('seaLife', 'Whales & dolphins'),
    groupFeature('trails', 'Footprints'),
    groupFeature('dragon', 'Dragon'),
    groupFeature('airships', 'Airships'),
    groupFeature('wind', 'Wind'),
  ]
  const FEATURE_STORAGE = 'planet-feature-'

  const featurePanel = document.createElement('div')
  featurePanel.id = 'feature-panel'
  featurePanel.classList.add('hidden')
  const featureTitle = document.createElement('div')
  featureTitle.className = 'feature-panel-title'
  featureTitle.textContent = 'FEATURES'
  featurePanel.appendChild(featureTitle)
  root.appendChild(featurePanel)

  function setFeature(f, on) {
    f.write(on)
    try {
      localStorage.setItem(FEATURE_STORAGE + f.storageKey, on ? '1' : '0')
    } catch {
      /* localStorage may be unavailable (private mode) */
    }
    if (f.row) f.row.classList.toggle('off', !on)
  }

  const featureRows = FEATURES.map((f) => {
    const row = document.createElement('button')
    row.type = 'button'
    row.className = 'feature-row'
    row.textContent = f.label
    row.setAttribute('aria-label', 'Toggle ' + f.label)
    row.addEventListener('click', () => setFeature(f, !f.read()))
    featurePanel.appendChild(row)
    f.row = row
    return f
  })

  function syncFeatureRows() {
    for (const f of featureRows) f.row.classList.toggle('off', !f.read())
  }

  // Apply any persisted "hidden" choices once the scene handles exist (the
  // __planet handle is assigned by main.js just after createUI returns).
  setTimeout(() => {
    for (const f of featureRows) {
      let saved
      try {
        saved = localStorage.getItem(FEATURE_STORAGE + f.storageKey)
      } catch {
        saved = null
      }
      if (saved === '0') setFeature(f, false)
    }
    syncFeatureRows()
  }, 1200)

  let featurePanelOpen = false
  function toggleFeaturePanel(force) {
    featurePanelOpen = typeof force === 'boolean' ? force : !featurePanelOpen
    featurePanel.classList.toggle('hidden', !featurePanelOpen)
    featuresBtn.classList.toggle('active', featurePanelOpen)
    if (featurePanelOpen) syncFeatureRows()
  }

  // --- GOD controls panel -----------------------------------------------------
  // Interactive spectacle triggers (owner request). Every handle is read
  // LAZILY off window.__planet and typeof-guarded, exactly like the feature
  // panel above — several are added by sibling builders this wave (meteors,
  // earthquake, storms.spawnStorm, sky.triggerAurora), so a missing handle
  // just makes the button an inert no-op rather than throwing. These are
  // user-driven, so target directions may vary per click; the search itself
  // is deterministic (a Fibonacci-sphere sweep advanced by a plain counter —
  // no Math.random / Date.now), and none of them ever touch a session
  // structure (THE COVENANT — additive spectacle only).

  // Scoped styles injected from JS (ui.css is not ours to edit). Mirrors the
  // #feature-panel look; sits just left of it so the two never overlap.
  const godStyle = document.createElement('style')
  godStyle.id = 'god-panel-styles'
  godStyle.textContent = `
#god-panel {
  position: fixed;
  right: 250px; /* clear of #feature-panel (right:58px, width:182px) */
  bottom: 58px;
  width: 190px;
  padding: 10px;
  border-radius: 12px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  background: rgba(8, 12, 20, 0.72);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.35);
  display: flex;
  flex-direction: column;
  gap: 6px;
  z-index: 21;
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
}
#god-panel.hidden { display: none; }
body.photo-mode #god-panel { visibility: hidden; }
.god-panel-title {
  font-size: 10px;
  letter-spacing: 0.14em;
  color: #8b97a6;
  margin-bottom: 2px;
  padding-left: 4px;
}
.god-sun {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 7px 8px 8px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.05);
}
.god-sun-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  font-size: 11px;
  color: #dfe6ee;
}
.god-sun-value { color: #ffd58a; font-size: 12px; }
.god-sun-controls { display: flex; align-items: center; gap: 8px; }
.god-slider {
  -webkit-appearance: none;
  appearance: none;
  flex: 1;
  height: 4px;
  border-radius: 2px;
  background: rgba(255, 255, 255, 0.14);
  cursor: pointer;
}
.god-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: #ffd58a;
  border: 2px solid rgba(255, 190, 120, 0.6);
  cursor: pointer;
}
.god-slider::-moz-range-thumb {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: #ffd58a;
  border: 2px solid rgba(255, 190, 120, 0.6);
  cursor: pointer;
}
.god-sun-reset {
  width: 24px;
  height: 24px;
  flex: none;
  padding: 0;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  background: rgba(255, 255, 255, 0.05);
  color: #dfe6ee;
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
}
.god-sun-reset:hover { background: rgba(255, 255, 255, 0.12); }
.god-btn {
  text-align: left;
  padding: 7px 9px;
  border-radius: 7px;
  border: 1px solid transparent;
  background: rgba(255, 255, 255, 0.05);
  color: #dfe6ee;
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 9px;
  transition: background 0.12s ease;
}
.god-btn:hover { background: rgba(255, 255, 255, 0.1); }
.god-btn:active { background: rgba(255, 255, 255, 0.16); }
`
  document.head.appendChild(godStyle)

  const godPanel = document.createElement('div')
  godPanel.id = 'god-panel'
  godPanel.classList.add('hidden')
  root.appendChild(godPanel)

  const godTitle = document.createElement('div')
  godTitle.className = 'god-panel-title'
  godTitle.textContent = 'GOD'
  godPanel.appendChild(godTitle)

  // --- fast-sun slider (log-ish 1×..600×) ---
  const SUN_MAX = 600
  const sliderToSpeed = (t) => Math.exp(t * Math.log(SUN_MAX)) // t 0..1 -> 1..600
  const speedToSlider = (sp) => Math.log(Math.max(1, sp)) / Math.log(SUN_MAX)
  const fmtSpeed = (sp) => (sp >= 10 ? String(Math.round(sp)) : String(Math.round(sp * 10) / 10)) + '×'

  function applySunSpeed(sp) {
    const s = window.__planet && window.__planet.sky
    if (s && typeof s.setSunSpeed === 'function') s.setSunSpeed(sp)
  }

  const godSun = document.createElement('div')
  godSun.className = 'god-sun'
  const godSunHead = document.createElement('div')
  godSunHead.className = 'god-sun-head'
  const godSunLabel = document.createElement('span')
  godSunLabel.textContent = 'time speed'
  const godSunValue = document.createElement('span')
  godSunValue.className = 'god-sun-value'
  godSunHead.appendChild(godSunLabel)
  godSunHead.appendChild(godSunValue)
  godSun.appendChild(godSunHead)

  const godSunControls = document.createElement('div')
  godSunControls.className = 'god-sun-controls'
  const godSlider = document.createElement('input')
  godSlider.type = 'range'
  godSlider.className = 'god-slider'
  godSlider.min = '0'
  godSlider.max = '1'
  godSlider.step = '0.001'
  godSlider.value = '0'
  godSlider.setAttribute('aria-label', 'Sun time speed')
  const godSunReset = document.createElement('button')
  godSunReset.type = 'button'
  godSunReset.className = 'god-sun-reset'
  godSunReset.textContent = '⟲'
  godSunReset.title = 'Reset time speed to 1×'
  godSunReset.setAttribute('aria-label', 'Reset time speed to 1x')
  godSunControls.appendChild(godSlider)
  godSunControls.appendChild(godSunReset)
  godSun.appendChild(godSunControls)
  godPanel.appendChild(godSun)

  function syncSunFromSlider(apply) {
    const sp = sliderToSpeed(Number(godSlider.value))
    godSunValue.textContent = fmtSpeed(sp)
    if (apply) applySunSpeed(sp)
  }
  godSlider.addEventListener('input', () => syncSunFromSlider(true))
  godSunReset.addEventListener('click', () => {
    godSlider.value = String(speedToSlider(1))
    syncSunFromSlider(true)
  })
  syncSunFromSlider(false) // seed the label; don't touch the sun until the user does

  // --- targeted triggers (meteor / earthquake / storm) ---
  // Pick a target world-direction: prefer a sunlit LAND point, else any land
  // point, else the point directly under the camera. THREE.Vector3 scratches
  // are obtained by cloning camera.position, so this module imports no THREE.
  let godTargetCounter = 0
  function computeTargetDir() {
    const p = window.__planet
    const camera = p && p.camera
    if (!camera || !camera.position) return null
    const planet = p && p.planet
    const sky = p && p.sky

    let sunDir = null
    if (sky && typeof sky.getSunDir === 'function') {
      sunDir = camera.position.clone()
      sky.getSunDir(sunDir)
    }

    if (planet && typeof planet.isLand === 'function') {
      const cand = camera.position.clone()
      const golden = Math.PI * (3 - Math.sqrt(5))
      let landFallback = null
      for (let i = 0; i < 96; i++) {
        const idx = godTargetCounter * 96 + i
        const t = (idx * 0.6180339887498949) % 1 // fractional golden ratio -> even latitude spread
        const y = 1 - 2 * t
        const r = Math.sqrt(Math.max(0, 1 - y * y))
        const theta = golden * idx
        cand.set(r * Math.cos(theta), y, r * Math.sin(theta)) // already unit-length
        if (!planet.isLand(cand)) continue
        if (!landFallback) landFallback = cand.clone()
        if (!sunDir || cand.dot(sunDir) > 0.15) {
          godTargetCounter++
          return cand.normalize()
        }
      }
      if (landFallback) {
        godTargetCounter++
        return landFallback.normalize()
      }
    }
    return camera.position.clone().normalize()
  }

  function targetedTrigger(mod, method) {
    const dir = computeTargetDir()
    if (!dir) return
    const p = window.__planet
    const m = p && p[mod]
    if (m && typeof m[method] === 'function') m[method](dir)
  }

  function makeGodBtn(label, onClick) {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'god-btn'
    b.textContent = label
    b.setAttribute('aria-label', label)
    b.addEventListener('click', onClick)
    godPanel.appendChild(b)
    return b
  }

  makeGodBtn('☄️ Meteor', () => targetedTrigger('meteors', 'strike'))
  makeGodBtn('⛰️ Earthquake', () => targetedTrigger('earthquake', 'trigger'))
  makeGodBtn('🌀 Summon storm', () => targetedTrigger('storms', 'spawnStorm'))
  makeGodBtn('🌌 Aurora', () => {
    const s = window.__planet && window.__planet.sky
    if (s && typeof s.triggerAurora === 'function') s.triggerAurora()
  })

  let godPanelOpen = false
  function toggleGodPanel(force) {
    godPanelOpen = typeof force === 'boolean' ? force : !godPanelOpen
    godPanel.classList.toggle('hidden', !godPanelOpen)
    godBtn.classList.toggle('active', godPanelOpen)
  }

  return { update }
}
