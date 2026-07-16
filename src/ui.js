// Sidebar + legend UI: a settlement browser (filter, click-to-visit) and a
// collapsible legend explaining race glyphs/colors and building types.
// Pure DOM — no THREE here. The world module is only touched through its
// public contract: world.stats / world.list() / world.visit(project).
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

const REFRESH_INTERVAL = 2 // seconds between throttled settlement-row refreshes
const STORAGE_KEY = 'planet-sidebar-collapsed'
const FLASH_MS = 450

export function createUI(world) {
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

  function signatureOf(data) {
    // Cheap order-independent change signature over the fields rows depend on.
    const parts = data.map((s) => s.project + '|' + s.name + '|' + s.basename + '|' + s.race + '|' + s.structures + '|' + s.agents)
    parts.sort()
    return parts.join('\n')
  }

  function sortedFiltered() {
    const q = filterInput.value.trim().toLowerCase()
    let rows = q ? latestData.filter((s) => s.name.toLowerCase().includes(q) || s.basename.toLowerCase().includes(q)) : latestData.slice()
    rows.sort((a, b) => {
      const activeA = a.agents > 0 ? 1 : 0
      const activeB = b.agents > 0 ? 1 : 0
      if (activeA !== activeB) return activeB - activeA
      return b.structures - a.structures
    })
    return rows
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

  return { update }
}
