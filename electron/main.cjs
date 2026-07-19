'use strict'

// Minimal Electron shell for Sekai.
// Loads the Vite dev server in a native window; starts the dev server itself
// if it isn't already running. CommonJS on purpose: the project is
// "type": "module", but Electron's main process entry must be .cjs.

const { app, BrowserWindow, Menu } = require('electron')
const http = require('http')
const { spawn } = require('child_process')
const path = require('path')

const DEV_URL = process.env.PLANET_URL || 'http://localhost:5173'
const APP_DIR = path.join(__dirname, '..')
const PROBE_TIMEOUT_MS = 600
const POLL_INTERVAL_MS = 300
const MAX_WAIT_MS = 30000
const SERVER_START_TIMEOUT_MS = 15000

// The packaged app runs a bundled local server child (server/server.js) that
// serves the built dist/ + the /api/* endpoints. Kept module-scoped so the
// quit handlers can tear it down.
let serverChild = null

// Resolves true if `url` answers an HTTP request within PROBE_TIMEOUT_MS.
function probeOnce(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume() // drain + discard body so the socket can close cleanly
      resolve(true)
    })
    req.setTimeout(PROBE_TIMEOUT_MS, () => {
      req.destroy()
      resolve(false)
    })
    req.on('error', () => resolve(false))
  })
}

// Fires up `npm run dev` in the background, detached from this process so it
// keeps running (and the dev server keeps hot-reloading) independent of the
// Electron app's lifecycle.
function startDevServer() {
  spawn('npm', ['run', 'dev'], {
    cwd: APP_DIR,
    detached: true,
    stdio: 'ignore',
  }).unref()
}

async function waitForServer(url, maxWaitMs) {
  const deadline = Date.now() + maxWaitMs
  while (Date.now() < deadline) {
    if (await probeOnce(url)) return true
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }
  return false
}

function buildMenu() {
  const isMac = process.platform === 'darwin'

  const template = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'quit' }],
          },
        ]
      : []),
    {
      label: 'Edit',
      submenu: [{ role: 'copy' }, { role: 'paste' }],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'close' },
        ...(isMac ? [] : [{ type: 'separator' }, { role: 'quit' }]),
      ],
    },
  ]

  return Menu.buildFromTemplate(template)
}

function createWindow() {
  return new BrowserWindow({
    width: 1680,
    height: 1050,
    minWidth: 1100,
    title: 'Sekai',
    backgroundColor: '#04060c',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      // The whole point: keep the planet animating while unfocused/hidden.
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
}

function showError(win, message) {
  win.loadURL(`data:text/plain,${encodeURIComponent(message)}`)
}

// Packaged mode: spawn server/server.js as a Node child (the Electron binary run
// as Node via ELECTRON_RUN_AS_NODE — no system `node` needed), serving the built
// dist/ + /api/*. Resolves the kernel-assigned port from the child's
// 'SEKAI_LISTENING <port>' stdout sentinel.
function startPackagedServer() {
  return new Promise((resolve, reject) => {
    const distDir = path.join(__dirname, '..', 'dist')
    const serverEntry = path.join(__dirname, '..', 'server', 'server.js')
    serverChild = spawn(process.execPath, [serverEntry], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1', // set ONLY on this child — never process-wide
        SEKAI_DIST: distDir,
        SEKAI_HOST: '127.0.0.1',
        SEKAI_PORT: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    })
    let buf = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error('no SEKAI_LISTENING sentinel within timeout'))
    }, SERVER_START_TIMEOUT_MS)
    serverChild.stdout.setEncoding('utf8')
    serverChild.stdout.on('data', (chunk) => {
      buf += chunk
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        const m = line.match(/^SEKAI_LISTENING (\d+)/)
        if (m && !settled) {
          settled = true
          clearTimeout(timer)
          resolve(Number(m[1]))
        }
      }
    })
    serverChild.stderr.setEncoding('utf8')
    serverChild.stderr.on('data', (d) => console.error('[sekai-server]', d.trimEnd()))
    serverChild.on('exit', () => {
      serverChild = null
    })
    serverChild.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(err)
    })
  })
}

async function boot() {
  const win = createWindow()

  // Packaged: run the bundled server child and load its local origin. No
  // terminal, no separate `npm start`.
  if (app.isPackaged) {
    try {
      const port = await startPackagedServer()
      win.loadURL(`http://127.0.0.1:${port}`)
    } catch (err) {
      showError(win, 'Sekai server failed to start — run "npm run build" and relaunch.\n' + String(err))
    }
    return
  }

  // Dev: probe the Vite dev server, spawn it if down, then load it (keeps
  // `npm run app` and the `planet` alias working unchanged).
  let up = await probeOnce(DEV_URL)
  if (!up) {
    startDevServer()
    up = await waitForServer(DEV_URL, MAX_WAIT_MS)
  }
  if (up) {
    win.loadURL(DEV_URL)
  } else {
    showError(
      win,
      `Sekai could not reach the dev server at ${DEV_URL} after 30s. ` +
        'Start it manually with "npm run dev" and reload this window (Cmd+R).',
    )
  }
}

// Tear the server child down cleanly on quit so no orphan process lingers.
function killServerChild() {
  if (serverChild) {
    try {
      serverChild.kill('SIGTERM')
    } catch {
      /* already gone */
    }
    serverChild = null
  }
}
app.on('will-quit', killServerChild)

app.whenReady().then(() => {
  Menu.setApplicationMenu(buildMenu())
  boot()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) boot()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
