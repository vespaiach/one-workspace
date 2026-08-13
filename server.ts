import { createServer, type Server } from 'node:http'
import next from 'next'
import { logger } from './lib/logger'

const dev = process.env.NODE_ENV !== 'production'
const hostname = process.env.HOSTNAME ?? '0.0.0.0'
const port = Number.parseInt(process.env.PORT ?? '3000', 10)
const app = next({ dev, hostname, port, quiet: !dev })
const handle = app.getRequestHandler()

// Socket.IO attaches to httpServer before listen() in the realtime slice.
const httpServer: Server = createServer((request, response) => {
  void handle(request, response)
})

let shuttingDown = false

function shutdown(signal: string) {
  if (shuttingDown) return
  shuttingDown = true
  logger.info('Web server stopping', { signal })
  httpServer.close((error) => {
    void app
      .close()
      .then(() => {
        if (error) {
          logger.error('Web server shutdown failed', { errorName: error.name })
          process.exitCode = 1
        }
      })
      .catch((closeError: unknown) => {
        logger.error('Next.js shutdown failed', {
          errorName: closeError instanceof Error ? closeError.name : 'UnknownError',
        })
        process.exitCode = 1
      })
  })
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

void app.prepare().then(() => {
  httpServer.listen(port, hostname, () => {
    logger.info('Web server started', { hostname, port })
  })
})
