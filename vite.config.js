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
      },
    },
  ],
})
