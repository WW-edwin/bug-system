import 'dotenv/config'
import { resolve } from 'node:path'

const port = Number(process.env.PORT ?? 3001)
const sessionHours = Number(process.env.SESSION_TTL_HOURS ?? 12)
const publicOrigin = process.env.PUBLIC_ORIGIN?.replace(/\/$/, '') ?? ''

function envFlag(name: string, fallback: boolean) {
  const value = process.env[name]
  if (value === undefined) return fallback
  return value.toLowerCase() === 'true'
}

export const config = {
  port,
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://tracebug:tracebug@127.0.0.1:5432/tracebug',
  pgHost: process.env.PGHOST ?? '127.0.0.1',
  pgPort: Number(process.env.PGPORT ?? 5432),
  pgDatabase: process.env.PGDATABASE ?? 'tracebug',
  pgUser: process.env.PGUSER ?? 'tracebug',
  pgPassword: process.env.PGPASSWORD ?? process.env.POSTGRES_PASSWORD,
  nodeEnv: process.env.NODE_ENV ?? 'development',
  publicOrigin,
  publicAppOrigin: publicOrigin.split(',')[0]?.trim().replace(/\/$/, '') ?? '',
  appTimeZone: process.env.APP_TIMEZONE ?? 'Asia/Shanghai',
  sessionTtlMs: sessionHours * 60 * 60 * 1000,
  uploadsDir: resolve(process.env.UPLOAD_DIR ?? 'uploads'),
  clientDistDir: resolve('dist'),
  secureCookies: process.env.COOKIE_SECURE === 'true' || (!process.env.COOKIE_SECURE && process.env.PUBLIC_ORIGIN?.startsWith('https://') === true),
  companyEmailDomain: (process.env.COMPANY_EMAIL_DOMAIN ?? 'kando.com.cn').toLowerCase(),
  dingtalk: {
    enabled: envFlag('DINGTALK_ENABLED', false),
    dryRun: envFlag('DINGTALK_DRY_RUN', true),
    clientId: process.env.DINGTALK_CLIENT_ID ?? '',
    clientSecret: process.env.DINGTALK_CLIENT_SECRET ?? '',
    agentId: process.env.DINGTALK_AGENT_ID ?? '',
    corpId: process.env.DINGTALK_CORP_ID ?? '',
    requestTimeoutMs: Number(process.env.DINGTALK_REQUEST_TIMEOUT_MS ?? 5_000),
    workerPollMs: Number(process.env.DINGTALK_WORKER_POLL_MS ?? 2_000),
    retryUnknown: envFlag('DINGTALK_RETRY_UNKNOWN', false),
  },
}

export const isProduction = config.nodeEnv === 'production'
