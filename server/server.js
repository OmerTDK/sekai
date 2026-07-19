// The standalone local web server the packaged Sekai.app runs as a child
// process: serves the vite-built dist/ static site plus the /api/*
// endpoints (via the shared router in server/api.js) on 127.0.0.1 at a
// kernel-assigned port, and hands that port back to the Electron main
// process over stdout.
//
// Zero npm dependencies: node:http, node:fs, node:path, node:url only.
// ESM entry, no exports — a runnable script.

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'

// PATH fix for Finder-launched GUI apps: a double-clicked .app inherits a
// minimal PATH (no /opt/homebrew/bin, sometimes not even /usr/local/bin),
// which breaks gitinfo.js's execFile('git'/'gh') and resume.js's
// execFile('osascript'). Prepend the common bin dirs before anything else
// runs.
process.env.PATH = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
  process.env.PATH || '',
]
  .filter(Boolean)
  .join(':')

import { handleApi } from './api.js'

const SEKAI_DIST = process.env.SEKAI_DIST
if (!SEKAI_DIST) {
  console.error('[server] SEKAI_DIST env var is required (absolute path to the built dist/ web root)')
  process.exit(1)
}
const distRoot = path.resolve(SEKAI_DIST)
const SEKAI_HOST = process.env.SEKAI_HOST || '127.0.0.1'
const SEKAI_PORT = process.env.SEKAI_PORT || '0'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
  '.wasm': 'application/wasm',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8',
}

function serveStatic(req, res) {
  let p = decodeURIComponent((req.url || '/').split('?')[0])
  if (p === '' || p === '/') p = '/index.html'

  const filePath = path.join(distRoot, path.normalize(p))
  if (!filePath.startsWith(distRoot + path.sep) && filePath !== distRoot) {
    res.statusCode = 403
    res.end('forbidden')
    return
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.statusCode = 404
      res.end('not found')
      return
    }
    const ext = path.extname(filePath).toLowerCase()
    res.setHeader('content-type', MIME[ext] || 'application/octet-stream')
    fs.createReadStream(filePath).pipe(res)
  })
}

const server = http.createServer(async (req, res) => {
  try {
    if (await handleApi(req, res)) return
    serveStatic(req, res)
  } catch (e) {
    res.statusCode = 500
    res.end(String(e))
  }
})

// Bind 127.0.0.1 ONLY — never 0.0.0.0 — the /api/resume + git endpoints must
// not be reachable off-box.
server.listen(Number(SEKAI_PORT), SEKAI_HOST, () => {
  process.stdout.write('SEKAI_LISTENING ' + server.address().port + '\n')
})

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    server.close(() => process.exit(0))
  })
}
