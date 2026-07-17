import { defineConfig } from 'vite'

export default defineConfig({
  server: { open: true },
  plugins: [
    {
      name: 'claude-session-api',
      configureServer(server) {
        server.middlewares.use('/api/sessions', async (req, res) => {
          res.setHeader('content-type', 'application/json')
          try {
            const { scanSessions } = await import('./server/scan.js')
            res.end(JSON.stringify(await scanSessions()))
          } catch (e) {
            res.statusCode = 500
            res.end(JSON.stringify({ error: String(e) }))
          }
        })
        server.middlewares.use('/api/resume', async (req, res) => {
          if (req.method !== 'POST') {
            res.statusCode = 405
            res.end()
            return
          }
          try {
            const { handleResume } = await import('./server/resume.js')
            handleResume(req, res)
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
