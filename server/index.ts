import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import compression from 'compression'
import cookieParser from 'cookie-parser'
import express, { type NextFunction, type Request, type Response } from 'express'
import helmet from 'helmet'
import { attachUser, requireSameOrigin } from './auth.js'
import authRoutes from './authRoutes.js'
import { config, isProduction } from './config.js'
import { initializeDatabase, pool } from './db.js'
import workspaceRoutes from './workspaceRoutes.js'

const app = express()

if (isProduction) app.set('trust proxy', 1)
app.disable('x-powered-by')
app.use(helmet({
  ...(!config.secureCookies ? {
    crossOriginOpenerPolicy: false,
    originAgentCluster: false,
    strictTransportSecurity: false,
  } : {}),
  contentSecurityPolicy: {
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      'img-src': ["'self'", 'data:', 'blob:'],
      ...(!config.secureCookies ? { 'upgrade-insecure-requests': null } : {}),
    },
  },
}))
app.use(compression())
app.use(express.json({ limit: '2mb' }))
app.use(cookieParser())
app.use(requireSameOrigin)
app.use(attachUser)

app.get('/api/health', async (_request, response) => {
  await pool.query('SELECT 1')
  response.json({ status: 'ok' })
})
app.use('/api/auth', authRoutes)
app.use('/api', workspaceRoutes)

await mkdir(config.uploadsDir, { recursive: true })
app.use('/uploads', express.static(config.uploadsDir, { fallthrough: false, maxAge: isProduction ? '30d' : 0 }))

if (existsSync(config.clientDistDir)) {
  app.use(express.static(config.clientDistDir, { index: false, maxAge: isProduction ? '1h' : 0 }))
  app.use((request, response, next) => {
    if (request.method !== 'GET' || request.path.startsWith('/api/') || request.path.startsWith('/uploads/')) return next()
    response.sendFile(join(config.clientDistDir, 'index.html'))
  })
}

app.use('/api', (_request, response) => response.status(404).json({ error: '接口不存在' }))
app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
  const message = error instanceof Error ? error.message : '服务器内部错误'
  const status = Number((error as { status?: number; statusCode?: number })?.status ?? (error as { statusCode?: number })?.statusCode ?? 500)
  console.error(error)
  if (message.includes('File too large')) return response.status(413).json({ error: '图片不能超过 5MB' })
  if (status >= 400 && status < 500) return response.status(status).json({ error: status === 404 ? '资源不存在' : message })
  response.status(500).json({ error: isProduction ? '服务器内部错误' : message })
})

await initializeDatabase()
const server = app.listen(config.port, '0.0.0.0', () => {
  console.log(`TraceBug server listening on http://0.0.0.0:${config.port}`)
})

async function shutdown(signal: string) {
  console.log(`${signal} received, shutting down`)
  server.close(async () => {
    await pool.end()
    process.exit(0)
  })
  setTimeout(() => process.exit(1), 10_000).unref()
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
