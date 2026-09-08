import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { Router, type Request, type Response } from 'express'
import { rateLimit } from 'express-rate-limit'
import { z } from 'zod'
import { clearSessionCookie, createSession, setSessionCookie } from './auth.js'
import { config } from './config.js'
import { pool, withTransaction } from './db.js'
import { DingTalkLoginClient, DingTalkLoginError, type DingTalkLoginIdentity } from './dingtalkLoginClient.js'
import { verifyPassword } from './password.js'
import { wakeDingTalkNotificationWorker } from './dingtalkNotifications.js'

const flowCookie = config.sessionCookieName === 'tb_sid' ? 'tb_dingtalk_flow' : `${config.sessionCookieName}_dingtalk_flow`
const flowLifetimeMs = 10 * 60_000
const opaqueToken = /^[A-Za-z0-9_-]{43}$/
const accountProof = z.object({
  name: z.string().trim().min(1).max(80),
  password: z.string().min(6).max(128),
}).strict()
const identitySchema = z.object({
  corpId: z.string().min(1).max(128), userId: z.string().min(1).max(128),
  unionId: z.string().min(1).max(128), name: z.string().min(1).max(200),
})

class LoginFlowError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) { super(message) }
}

function hash(value: string) { return createHash('sha256').update(value).digest('hex') }

// TraceBug routes through the root page and query parameters. Never accept an external callback target.
export function safeDingTalkReturnTo(value: unknown) {
  if (typeof value !== 'string' || value.length > 4096 || !value.startsWith('/') || /[\\\r\n]/.test(value)) return '/'
  try {
    const target = new URL(value, 'https://tracebug.invalid')
    if (target.origin !== 'https://tracebug.invalid' || target.pathname !== '/') return '/'
    for (const key of ['dingtalk', 'dingtalk_error', 'authCode', 'code', 'state']) target.searchParams.delete(key)
    return '/' + target.search
  } catch { return '/' }
}

export function dingTalkLoginAvailable() {
  if (!config.dingtalkLogin.enabled || !config.dingtalkLogin.allowedUserIds.length
    || !config.dingtalk.clientId || !config.dingtalk.clientSecret || !config.dingtalk.corpId) return false
  try {
    const callback = new URL(config.dingtalkLogin.callbackUrl)
    const origin = new URL(config.publicAppOrigin)
    return ['http:', 'https:'].includes(callback.protocol)
      && callback.origin === origin.origin && !callback.username && !callback.password
      && callback.pathname === '/api/auth/dingtalk/callback' && !callback.search && !callback.hash
      && (!config.secureCookies || callback.protocol === 'https:')
      && Number.isFinite(config.dingtalk.requestTimeoutMs)
      && config.dingtalk.requestTimeoutMs >= 1000 && config.dingtalk.requestTimeoutMs <= 30_000
  } catch { return false }
}

function setFlowCookie(response: Response, value: string, expiresAt: Date) {
  response.cookie(flowCookie, value, {
    httpOnly: true, secure: config.secureCookies, sameSite: 'lax',
    path: '/api/auth/dingtalk', expires: expiresAt,
  })
}

function clearFlowCookie(response: Response) {
  response.clearCookie(flowCookie, {
    httpOnly: true, secure: config.secureCookies, sameSite: 'lax', path: '/api/auth/dingtalk',
  })
}

function browserHash(cookies: Record<string, unknown> | undefined) {
  const value = cookies?.[flowCookie]
  return typeof value === 'string' && opaqueToken.test(value) ? hash(value) : null
}

function assertAllowed(identity: DingTalkLoginIdentity) {
  if (identity.corpId !== config.dingtalk.corpId) throw new LoginFlowError('company_required', '请使用本公司钉钉账号', 403)
  if (!config.dingtalkLogin.allowedUserIds.includes(identity.userId)) {
    throw new LoginFlowError('not_allowed', '当前账号尚未开通钉钉登录试用资格', 403)
  }
}

function redirectResult(response: Response, returnTo: string, kind?: 'dingtalk' | 'dingtalk_error', value?: string) {
  const target = new URL(safeDingTalkReturnTo(returnTo), config.publicAppOrigin || 'http://localhost')
  if (kind && value) target.searchParams.set(kind, value)
  // The configured frontend origin also supports callbacks reached directly through the API server.
  response.redirect(303, target.toString())
}

function publicErrorCode(error: unknown) {
  if (error instanceof LoginFlowError) return error.code
  const code = (error as { code?: string })?.code
  if (code === 'NOT_CORP_MEMBER' || code === 'INACTIVE_USER') return 'company_required'
  if (code === 'IDENTITY_MISMATCH') return 'identity_conflict'
  if (code === 'AUTH_CODE_REJECTED' || code === 'INVALID_AUTH_CODE') return 'expired'
  if (code === 'PROVIDER_PERMISSION_DENIED') return 'permission_required'
  if (code === 'REQUEST_TIMEOUT') return 'provider_timeout'
  return 'provider_failed'
}

type UserRow = { id: string; email: string; display_name: string; role: 'admin' | 'member'; active: boolean; password_hash: string | null }
function publicUser(user: UserRow) { return { id: user.id, email: user.email, name: user.display_name, role: user.role } }

async function finishIdentity(flowId: string, browser: string, identity: DingTalkLoginIdentity, kind: 'oauth' | 'in_app') {
  assertAllowed(identity)
  return withTransaction(async (db) => {
    const current = await db.query(`SELECT id FROM dingtalk_login_flows WHERE id = $1
      AND browser_hash = $2 AND flow_kind = $3 AND status = 'exchanging' AND expires_at > NOW() FOR UPDATE`, [flowId, browser, kind])
    if (!current.rowCount) throw new LoginFlowError('expired', '钉钉授权已失效，请重新登录', 410)
    const identities = await db.query<UserRow & { corp_id: string; dingtalk_user_id: string; union_id: string }>(
      `SELECT u.*, di.corp_id, di.dingtalk_user_id, di.union_id FROM dingtalk_login_identities di
       JOIN app_users u ON u.id = di.app_user_id
       WHERE di.corp_id = $1 AND (di.dingtalk_user_id = $2 OR di.union_id = $3) FOR UPDATE OF u, di`,
      [identity.corpId, identity.userId, identity.unionId])
    const user = identities.rows[0]
    if (user) {
      if (identities.rowCount !== 1 || user.dingtalk_user_id !== identity.userId || user.union_id !== identity.unionId) {
        throw new LoginFlowError('identity_conflict', '钉钉身份关联存在冲突，请联系管理员')
      }
      if (!user.active || !user.email) throw new LoginFlowError('account_disabled', '该系统账号已停用，请联系管理员', 403)
      const session = await createSession(user.id, db)
      await db.query('DELETE FROM dingtalk_login_flows WHERE id = $1', [flowId])
      return { session, user: publicUser(user) }
    }
    await db.query(`UPDATE dingtalk_login_flows SET status = 'ready', identity = $1::jsonb WHERE id = $2`,
      [JSON.stringify(identity), flowId])
    return { session: null, user: null }
  })
}

function logFailure(error: unknown) {
  console.warn('[dingtalk-login] authorization failed:', JSON.stringify(error instanceof DingTalkLoginError
    ? error.safeDiagnostic()
    : { code: error instanceof LoginFlowError ? error.code : 'INTERNAL_ERROR', stage: 'local-identity' }))
}

function hasSameAppOrigin(request: Request) {
  const origin = request.get('origin')
  return Boolean(origin && (origin === config.publicAppOrigin || origin === `${request.protocol}://${request.get('host')}`))
}

type LoginProvider = Pick<DingTalkLoginClient, 'exchangeCode'> & Partial<Pick<DingTalkLoginClient, 'exchangeInAppCode'>>

export function createDingTalkAuthRouter(provider: LoginProvider = new DingTalkLoginClient(config.dingtalk)) {
  const router = Router()
  const startLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 30, standardHeaders: true, legacyHeaders: false,
    message: { error: '尝试次数过多，请稍后重试' } })
  const bindLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 10, standardHeaders: true, legacyHeaders: false,
    message: { error: '关联尝试次数过多，请稍后重试' } })
  router.use((_request, response, next) => {
    response.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' })
    next()
  })

  const inAppAvailable = () => config.dingtalkLogin.inAppEnabled && dingTalkLoginAvailable() && Boolean(provider.exchangeInAppCode)
  router.get('/options', (_request, response) => response.json({
    enabled: config.dingtalkLogin.enabled, available: dingTalkLoginAvailable(), inAppAvailable: inAppAvailable(),
  }))

  router.post('/in-app/start', startLimiter, async (request, response) => {
    if (!hasSameAppOrigin(request)) return response.status(403).json({ error: '请求来源无效，请从应用页面重新进入' })
    if (!inAppAvailable()) return response.status(503).json({ error: '钉钉内免登暂未开放，请使用账号登录' })
    const returnTo = safeDingTalkReturnTo(request.body?.returnTo)
    const state = randomBytes(32).toString('base64url')
    const browser = randomBytes(32).toString('base64url')
    const expiresAt = new Date(Date.now() + 3 * 60_000)
    await withTransaction(async (db) => {
      // A new native attempt must not expose the previous employee's session if DingTalk switched accounts.
      if (request.auth) await db.query('DELETE FROM app_sessions WHERE id = $1', [request.auth.sessionId])
      await db.query('DELETE FROM dingtalk_login_flows WHERE expires_at <= NOW() OR browser_hash = $1', [browserHash(request.cookies)])
      await db.query(`INSERT INTO dingtalk_login_flows (id, state_hash, browser_hash, return_to, status, flow_kind, expires_at)
        VALUES ($1, $2, $3, $4, 'pending', 'in_app', $5)`, [randomUUID(), hash(state), hash(browser), returnTo, expiresAt])
    })
    clearSessionCookie(response)
    setFlowCookie(response, browser, expiresAt)
    response.json({ state, corpId: config.dingtalk.corpId, clientId: config.dingtalk.clientId, expiresAt: expiresAt.toISOString() })
  })

  router.post('/in-app/complete', startLimiter, async (request, response) => {
    if (!hasSameAppOrigin(request)) return response.status(403).json({ error: '请求来源无效，请从应用页面重新进入' })
    if (!inAppAvailable()) return response.status(503).json({ error: '钉钉内免登暂未开放，请使用账号登录' })
    const parsed = z.object({ state: z.string().regex(opaqueToken), code: z.string().trim().min(1).max(4096).regex(/^[^\r\n]+$/) }).strict().safeParse(request.body)
    if (!parsed.success) return response.status(400).json({ error: '钉钉免登请求无效，请重新进入应用' })
    const browser = browserHash(request.cookies)
    if (!browser) return response.status(410).json({ error: '钉钉免登请求已失效，请重新进入应用', code: 'expired' })
    const claimed = await pool.query<{ id: string; return_to: string }>(`UPDATE dingtalk_login_flows SET status = 'exchanging'
      WHERE state_hash = $1 AND browser_hash = $2 AND flow_kind = 'in_app' AND status = 'pending'
      AND expires_at > NOW() RETURNING id, return_to`, [hash(parsed.data.state), browser])
    const flow = claimed.rows[0]
    if (!flow) return response.status(410).json({ error: '钉钉免登请求已失效，请重新进入应用', code: 'expired' })
    try {
      const identity = identitySchema.parse(await provider.exchangeInAppCode!(parsed.data.code))
      const result = await finishIdentity(flow.id, browser, identity, 'in_app')
      if (result.session) {
        setSessionCookie(response, result.session.token, result.session.expiresAt)
        clearFlowCookie(response)
      }
      response.json({ user: result.user, needsBinding: !result.session, returnTo: flow.return_to })
    } catch (error) {
      await pool.query('DELETE FROM dingtalk_login_flows WHERE id = $1', [flow.id])
      clearFlowCookie(response)
      logFailure(error)
      const status = error instanceof LoginFlowError ? error.status : 502
      const message = error instanceof LoginFlowError || error instanceof DingTalkLoginError ? error.message : '钉钉身份验证暂时失败，请重试或使用账号登录'
      response.status(status).json({ error: message, code: publicErrorCode(error) })
    }
  })

  router.get('/start', startLimiter, async (request, response) => {
    const returnTo = safeDingTalkReturnTo(request.query.returnTo)
    if (!dingTalkLoginAvailable()) return redirectResult(response, returnTo, 'dingtalk_error', 'unavailable')
    const state = randomBytes(32).toString('base64url')
    const browser = randomBytes(32).toString('base64url')
    const expiresAt = new Date(Date.now() + flowLifetimeMs)
    await pool.query('DELETE FROM dingtalk_login_flows WHERE expires_at <= NOW() OR browser_hash = $1', [browserHash(request.cookies)])
    await pool.query(`INSERT INTO dingtalk_login_flows (id, state_hash, browser_hash, return_to, status, expires_at)
      VALUES ($1, $2, $3, $4, 'pending', $5)`, [randomUUID(), hash(state), hash(browser), returnTo, expiresAt])
    setFlowCookie(response, browser, expiresAt)
    const authorization = new URL('https://login.dingtalk.com/oauth2/auth')
    authorization.searchParams.set('client_id', config.dingtalk.clientId)
    authorization.searchParams.set('redirect_uri', config.dingtalkLogin.callbackUrl)
    authorization.searchParams.set('response_type', 'code')
    authorization.searchParams.set('scope', 'openid')
    authorization.searchParams.set('prompt', 'consent')
    authorization.searchParams.set('state', state)
    response.redirect(302, authorization.toString())
  })

  router.get('/callback', startLimiter, async (request, response) => {
    if (!dingTalkLoginAvailable()) return redirectResult(response, '/', 'dingtalk_error', 'unavailable')
    const state = request.query.state
    const browser = browserHash(request.cookies)
    if (typeof state !== 'string' || !opaqueToken.test(state) || !browser) {
      return redirectResult(response, '/', 'dingtalk_error', 'expired')
    }
    // Claim the state before contacting DingTalk. A repeated or concurrent callback cannot reuse it.
    const claimed = await pool.query<{ id: string; return_to: string }>(`UPDATE dingtalk_login_flows
      SET status = 'exchanging' WHERE state_hash = $1 AND browser_hash = $2 AND status = 'pending'
      AND flow_kind = 'oauth' AND expires_at > NOW() RETURNING id, return_to`, [hash(state), browser])
    const flow = claimed.rows[0]
    if (!flow) return redirectResult(response, '/', 'dingtalk_error', 'expired')
    try {
      if (request.query.error) throw new LoginFlowError('cancelled', '已取消钉钉授权')
      const code = request.query.authCode
      if (typeof code !== 'string' || !code || code.length > 4096 || /[\r\n]/.test(code)) {
        throw new LoginFlowError('expired', '钉钉授权已失效，请重新登录')
      }
      const identity = identitySchema.parse(await provider.exchangeCode(code))
      const result = await finishIdentity(flow.id, browser, identity, 'oauth')
      if (result.session) {
        setSessionCookie(response, result.session.token, result.session.expiresAt)
        clearFlowCookie(response)
        return redirectResult(response, flow.return_to)
      }
      redirectResult(response, flow.return_to, 'dingtalk', 'bind')
    } catch (error) {
      await pool.query('DELETE FROM dingtalk_login_flows WHERE id = $1', [flow.id])
      clearFlowCookie(response)
      const code = publicErrorCode(error)
      logFailure(error)
      redirectResult(response, flow.return_to, 'dingtalk_error', code)
    }
  })

  router.get('/pending', async (request, response) => {
    if (!dingTalkLoginAvailable()) return response.json({ pending: null })
    const result = await pool.query<{ identity: DingTalkLoginIdentity; expires_at: Date }>(
      `SELECT identity, expires_at FROM dingtalk_login_flows WHERE browser_hash = $1
       AND status = 'ready' AND expires_at > NOW()`, [browserHash(request.cookies)])
    const flow = result.rows[0]
    if (!flow || !config.dingtalkLogin.allowedUserIds.includes(flow.identity.userId) || flow.identity.corpId !== config.dingtalk.corpId) {
      return response.json({ pending: null })
    }
    response.json({ pending: { name: flow.identity.name, expiresAt: flow.expires_at.toISOString() } })
  })

  router.post('/bind', bindLimiter, async (request, response) => {
    if (!dingTalkLoginAvailable()) return response.status(503).json({ error: '钉钉登录暂未开放' })
    const parsed = accountProof.safeParse(request.body)
    if (!parsed.success) return response.status(400).json({ error: '请输入原账号的真实姓名和密码' })
    try {
      const result = await withTransaction(async (db) => {
        const flows = await db.query<{ id: string; identity: DingTalkLoginIdentity; return_to: string }>(
          `SELECT id, identity, return_to FROM dingtalk_login_flows WHERE browser_hash = $1
           AND status = 'ready' AND expires_at > NOW() FOR UPDATE`, [browserHash(request.cookies)])
        const flow = flows.rows[0]
        if (!flow) throw new LoginFlowError('expired', '钉钉授权已过期，请重新授权', 410)
        const identity = identitySchema.parse(flow.identity)
        assertAllowed(identity)
        const users = await db.query<UserRow>('SELECT * FROM app_users WHERE LOWER(display_name) = LOWER($1) FOR UPDATE', [parsed.data.name])
        const user = users.rows[0]
        if (!user?.active || !user.email || !user.password_hash || !await verifyPassword(parsed.data.password, user.password_hash)) {
          throw new LoginFlowError('invalid_account', '原账号姓名或密码错误，请核对后重试', 401)
        }
        const conflicts = await db.query(`SELECT id FROM dingtalk_login_identities
          WHERE app_user_id = $1 OR (corp_id = $2 AND (dingtalk_user_id = $3 OR union_id = $4))`,
          [user.id, identity.corpId, identity.userId, identity.unionId])
        if (conflicts.rowCount) throw new LoginFlowError('identity_conflict', '该系统账号或钉钉身份已经关联，请重新使用钉钉登录或联系管理员')
        const occupied = await db.query(`SELECT id FROM app_users WHERE id <> $1
          AND dingtalk_corp_id = $2 AND dingtalk_user_id = $3`, [user.id, identity.corpId, identity.userId])
        if (occupied.rowCount) throw new LoginFlowError('identity_conflict', '该钉钉身份已关联其他员工，请联系管理员核对')
        await db.query(`INSERT INTO dingtalk_login_identities (id, app_user_id, corp_id, dingtalk_user_id, union_id)
          VALUES ($1, $2, $3, $4, $5)`, [randomUUID(), user.id, identity.corpId, identity.userId, identity.unionId])
        await db.query(`UPDATE app_users SET dingtalk_corp_id = $1, dingtalk_user_id = $2, dingtalk_union_id = $3,
          dingtalk_bound_at = NOW(), dingtalk_binding_version = dingtalk_binding_version + 1,
          dingtalk_sync_status = 'matched', dingtalk_binding_source = 'self_service', updated_at = NOW() WHERE id = $4`,
          [identity.corpId, identity.userId, identity.unionId, user.id])
        await db.query(`INSERT INTO dingtalk_binding_audit
          (id, app_user_id, actor_user_id, action, dingtalk_corp_id, dingtalk_user_id, source)
          VALUES ($1, $2, $2, 'bound', $3, $4, 'self_service')`, [randomUUID(), user.id, identity.corpId, identity.userId])
        const session = await createSession(user.id, db)
        await db.query('DELETE FROM dingtalk_login_flows WHERE id = $1', [flow.id])
        return { user: publicUser(user), session, returnTo: flow.return_to }
      })
      setSessionCookie(response, result.session.token, result.session.expiresAt)
      clearFlowCookie(response)
      wakeDingTalkNotificationWorker()
      response.json({ user: result.user, returnTo: result.returnTo })
    } catch (error) {
      if (error instanceof LoginFlowError) return response.status(error.status).json({ error: error.message, code: error.code })
      if ((error as { code?: string })?.code === '23505') return response.status(409).json({ error: '该钉钉身份或系统账号已被关联，请重新登录或联系管理员' })
      throw error
    }
  })

  router.post('/cancel', async (request, response) => {
    const result = await pool.query<{ return_to: string }>('DELETE FROM dingtalk_login_flows WHERE browser_hash = $1 RETURNING return_to', [browserHash(request.cookies)])
    clearFlowCookie(response)
    response.json({ cancelled: true, returnTo: safeDingTalkReturnTo(result.rows[0]?.return_to) })
  })
  return router
}

export default createDingTalkAuthRouter()
