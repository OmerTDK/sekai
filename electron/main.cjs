'use strict'

// Minimal Electron shell for Claude Planet.
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
    title: 'Claude Planet',
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

async function boot() {
  let up = await probeOnce(DEV_URL)

  if (!up) {
    startDevServer()
    up = await waitForServer(DEV_URL, MAX_WAIT_MS)
  }

  const win = createWindow()

  if (up) {
    win.loadURL(DEV_URL)
  } else {
    showError(
      win,
      `Claude Planet could not reach the dev server at ${DEV_URL} after 30s. ` +
        'Start it manually with "npm run dev" and reload this window (Cmd+R).',
    )
  }
}

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
