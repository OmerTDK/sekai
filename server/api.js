// Single source of truth for the three /api/* routes, shared by the Vite dev
// middleware (vite.config.js) and the packaged standalone server
// (server/server.js) so dev and prod behave byte-identically.
//
// Zero npm dependencies: only this repo's own scan.js/gitinfo.js/resume.js.

import { scanSessions } from './scan.js'
import { gitEvents } from './gitinfo.js'
import { handleResume } from './resume.js'

// Handles req if its path is one of the three known API routes, and returns
// whether it did (true = response already written, caller must not touch
// res further; false = not an api route, caller should fall through to
// static serving / vite's `next()`).
export async function handleApi(req, res) {
  const path = (req.url || '').split('?')[0]

  if (path === '/api/sessions') {
    try {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(await scanSessions()))
    } catch (e) {
      res.statusCode = 500
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ error: String(e) }))
    }
    return true
  }

  if (path === '/api/events') {
    try {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(await gitEvents()))
    } catch (e) {
      res.statusCode = 500
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ error: String(e) }))
    }
    return true
  }

  if (path === '/api/resume') {
    try {
      if (req.method === 'POST') {
        // handleResume sets its own content-type + status and calls
        // res.end itself — nothing more to write here.
        await handleResume(req, res)
      } else {
        res.statusCode = 405
        res.end()
      }
    } catch (e) {
      res.statusCode = 500
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ error: String(e) }))
    }
    return true
  }

  return false
}
