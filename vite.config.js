import { defineConfig } from 'vite'
import { handleApi } from './server/api.js'

export default defineConfig({
  server: { open: true },
  plugins: [
    {
      name: 'claude-session-api',
      configureServer(server) {
        // Dev and the packaged standalone server share ONE router (server/api.js)
        // so /api/sessions, /api/events and /api/resume behave byte-identically
        // in both. Anything else falls through to Vite's static/HMR handling.
        server.middlewares.use(async (req, res, next) => {
          try {
            if (!(await handleApi(req, res))) next()
          } catch (e) {
            res.statusCode = 500
            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify({ error: String(e) }))
          }
        })
      },
    },
  ],
})
