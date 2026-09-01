import 'dotenv/config'
import { resolve } from 'node:path'

const port = Number(process.env.PORT ?? 3001)
const sessionHours = Number(process.env.SESSION_TTL_HOURS ?? 12)

export const config = {
  port,
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://tracebug:tracebug@127.0.0.1:5432/tracebug',
  pgHost: process.env.PGHOST ?? '127.0.0.1',
  pgPort: Number(process.env.PGPORT ?? 5432),
  pgDatabase: process.env.PGDATABASE ?? 'tracebug',
  pgUser: process.env.PGUSER ?? 'tracebug',
  pgPassword: process.env.PGPASSWORD ?? process.env.POSTGRES_PASSWORD,
  nodeEnv: process.env.NODE_ENV ?? 'development',
  publicOrigin: process.env.PUBLIC_ORIGIN?.replace(/\/$/, '') ?? '',
  appTimeZone: process.env.APP_TIMEZONE ?? 'Asia/Shanghai',
  sessionTtlMs: sessionHours * 60 * 60 * 1000,
  uploadsDir: resolve(process.env.UPLOAD_DIR ?? 'uploads'),
  clientDistDir: resolve('dist'),
  secureCookies: process.env.COOKIE_SECURE === 'true' || (!process.env.COOKIE_SECURE && process.env.PUBLIC_ORIGIN?.startsWith('https://') === true),
  companyEmailDomain: (process.env.COMPANY_EMAIL_DOMAIN ?? 'kando.com.cn').toLowerCase(),
}

export const isProduction = config.nodeEnv === 'production'
