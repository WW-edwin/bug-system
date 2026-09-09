import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

test('DingTalk employee onboarding requires a one-time password before business access', {
  skip: process.env.TRACEBUG_ONBOARDING_TEST !== 'true', timeout: 75_000,
}, async (t) => {
  const { config } = await import('../server/config.js')
  assert.deepEqual([config.pgHost, config.pgPort, config.pgDatabase], ['127.0.0.1', 5434, 'tracebug_local'])
  assert.equal(process.env.DATABASE_URL, undefined)
  const savedConfig = { ...config, dingtalk: { ...config.dingtalk }, dingtalkLogin: { ...config.dingtalkLogin } }
  const { Pool } = await import('pg')
  const databaseName = 'tracebug_onboarding_' + randomBytes(8).toString('hex')
  assert.match(databaseName, /^tracebug_onboarding_[a-f0-9]{16}$/)
  const control = new Pool({ host: config.pgHost, port: config.pgPort, user: config.pgUser, password: config.pgPassword, database: 'postgres' })
  let fixture: import('pg').Pool | undefined
  let databaseCreated = false
  let server: Server | undefined
  const originalFetch = globalThis.fetch
  const marker = 'SELFTEST-' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14).replace(/^(\d{8})/, '$1-')
  const ledger = { marker, databaseName, users: [] as string[], flows: [] as string[], projects: [] as string[], issues: [] as string[] }
  const corpId = marker + '-corp'
  const password = randomBytes(24).toString('base64url')
  const identity = (key: string, name: string, extras: Record<string, unknown> = {}) => ({
    corpId, userId: marker + '-' + key, unionId: marker + '-union-' + key, name, ...extras,
  })
  const providerData: Record<string, ReturnType<typeof identity>> = {
    first: identity('first', 'New Joiner', { sys: true, sys_level: 1, role: 'admin', token: 'secret-never-persist', refreshToken: 'secret-never-persist' }),
    full: identity('full', '资料员工', { orgEmail: 'Org.Employee@kando.com.cn', email: 'other@kando.com.cn', mobile: '13800000000',
      avatarUrl: 'https://images.example.test/avatar.png', jobNumber: 'EMP-22', departmentIds: [1, 25], accessToken: 'secret-never-persist' }),
    chinese: identity('chinese', '无邮箱员工'), concurrent: identity('concurrent', 'Concurrent Joiner'),
    collision: identity('collision', '原有管理员', { email: 'existing@kando.com.cn' }),
    otherEmail: identity('different', '另一个钉钉员工', { email: 'org.employee@kando.com.cn' }),
    outsider: identity('outside', '外部员工', { corpId: 'other-corp' }),
    paused: identity('paused', '停用员工'), placeholder: identity('placeholder', '无密码档案'),
    pilotDenied: identity('pilot-denied', '非试用人员'), waiting: identity('waiting', '等待设置员工'),
  }
  let providerCalls = 0
  const hash = (value: string) => createHash('sha256').update(value).digest('hex')
  try {
    await control.query(`CREATE DATABASE "${databaseName}"`)
    databaseCreated = true
    config.pgDatabase = databaseName
    config.sessionCookieName = 'tb_sid_onboarding_test'
    config.secureCookies = false
    Object.assign(config.dingtalk, { enabled: false, dryRun: true, clientId: 'test-client', clientSecret: 'test-secret', corpId, requestTimeoutMs: 1000 })
    Object.assign(config.dingtalkLogin, { enabled: true, scope: 'company', autoRegister: true, allowedUserIds: [] })
    const { pool, initializeDatabase } = await import('../server/db.js')
    fixture = pool
    assert.equal((await pool.query('SELECT current_database() AS name')).rows[0].name, databaseName)
    await initializeDatabase()
    const { attachUser, requireSameOrigin, sessionCookieName } = await import('../server/auth.js')
    const { hashPassword, verifyPassword } = await import('../server/password.js')
    const { default: authRoutes } = await import('../server/authRoutes.js')
    const { default: workspaceRoutes } = await import('../server/workspaceRoutes.js')
    const { default: settingsRoutes } = await import('../server/notificationRuleRoutes.js')
    const { default: dingtalkRoutes } = await import('../server/dingtalkRoutes.js')
    const { createDingTalkAuthRouter } = await import('../server/dingtalkAuthRoutes.js')
    const { default: express } = await import('express')
    const { default: cookieParser } = await import('cookie-parser')
    const provider = { async exchangeCode(code: string) {
      providerCalls += 1
      assert.ok(Object.hasOwn(providerData, code), 'only synthetic authorization codes may be consumed')
      return providerData[code]
    } }
    let oauthRouter = createDingTalkAuthRouter(provider)
    const resetOAuthLimiter = () => { oauthRouter = createDingTalkAuthRouter(provider) }
    const app = express()
    app.use(express.json(), cookieParser(), requireSameOrigin, attachUser)
    app.use('/api/auth', authRoutes)
    app.use('/api/auth/dingtalk', (req, res, next) => oauthRouter(req, res, next))
    app.use('/api/dingtalk', dingtalkRoutes)
    app.use('/api/settings/notification-rules', settingsRoutes)
    app.use('/api', workspaceRoutes)
    app.use((error: unknown, _req: unknown, res: import('express').Response, _next: unknown) => {
      res.status(Number((error as { status?: number })?.status ?? 500)).json({ error: error instanceof Error ? error.message : 'error' })
    })
    server = app.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port
    config.publicOrigin = config.publicAppOrigin = base
    config.dingtalkLogin.callbackUrl = base + '/api/auth/dingtalk/callback'
    globalThis.fetch = (input, init) => {
      assert.equal(new URL(input instanceof Request ? input.url : String(input)).origin, base, 'external requests are forbidden')
      return originalFetch(input, init)
    }
    const sessionCookie = (response: Response) => response.headers.getSetCookie().find((cookie) => cookie.startsWith(sessionCookieName + '='))?.split(';')[0]
    async function call(path: string, cookie?: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') {
      return fetch(base + '/api' + path, { method, redirect: 'manual', headers: {
        Origin: base, ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(12000) })
    }
    const me = async (cookie?: string) => (await (await call('/auth/me', cookie)).json()).user
    type Flow = { id: string; state: string; cookie: string }
    async function start(returnTo = '/') {
      const response = await call('/auth/dingtalk/start?returnTo=' + encodeURIComponent(returnTo))
      assert.equal(response.status, 302)
      const state = new URL(response.headers.get('location')!).searchParams.get('state')!
      const cookie = response.headers.getSetCookie().find((item) => item.startsWith(sessionCookieName + '_dingtalk_flow='))!.split(';')[0]
      const id = (await pool.query('SELECT id FROM dingtalk_login_flows WHERE state_hash=$1', [hash(state)])).rows[0].id as string
      ledger.flows.push(id)
      return { id, state, cookie }
    }
    const callback = (flow: Flow, code: string) => call('/auth/dingtalk/callback?' + new URLSearchParams({ state: flow.state, authCode: code }), flow.cookie)
    async function oauth(code: string, returnTo = '/') {
      const flow = await start(returnTo)
      const response = await callback(flow, code)
      assert.equal(response.status, 303)
      const cookie = sessionCookie(response)
      const user = await me(cookie)
      if (user && !ledger.users.includes(user.id)) ledger.users.push(user.id)
      return { flow, response, cookie, user, target: new URL(response.headers.get('location')!) }
    }
    const setup = (cookie: string | undefined, suppliedPassword = password, confirmPassword = suppliedPassword) => call('/auth/password/setup', cookie, { password: suppliedPassword, confirmPassword })
    async function localUser(name: string, options: { role?: string; active?: boolean; password?: boolean; email?: string | null } = {}) {
      const id = randomUUID()
      await pool.query('INSERT INTO app_users (id,display_name,email,password_hash,role,active) VALUES ($1,$2,$3,$4,$5,$6)',
        [id, name, options.email ?? null, options.password === false ? null : await hashPassword(password), options.role ?? 'member', options.active ?? true])
      ledger.users.push(id)
      return id
    }
    let first: Awaited<ReturnType<typeof oauth>>
    let full: Awaited<ReturnType<typeof oauth>>
    let readyCookie: string
    let administratorCookie: string

    await t.test('a new company employee is a pending member even if DingTalk says administrator; metadata is allowlisted', async () => {
      assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM app_users')).rows[0].count, 0)
      first = await oauth('first', '/?issue=TEST-OPEN&view=issues')
      assert.equal(first.target.searchParams.get('dingtalk'), 'password_setup')
      assert.equal(first.target.searchParams.get('issue'), 'TEST-OPEN')
      assert.equal(first.user.role, 'member')
      assert.equal(first.user.email, null)
      assert.equal(first.user.passwordSetupRequired, true)
      const row = (await pool.query('SELECT * FROM app_users WHERE id=$1', [first.user.id])).rows[0]
      assert.equal(row.password_hash, null)
      assert.equal(row.password_setup_required, true)
      assert.equal(row.dingtalk_binding_source, 'self_service')
      assert.equal(row.dingtalk_sync_status, 'matched')
      const stored = (await pool.query('SELECT profile FROM dingtalk_login_identities WHERE app_user_id=$1', [first.user.id])).rows[0].profile
      assert.deepEqual(stored, { corpId, userId: providerData.first.userId, unionId: providerData.first.unionId, name: 'New Joiner' })
      assert.equal((await pool.query("SELECT COUNT(*)::int AS count FROM dingtalk_binding_audit WHERE app_user_id=$1 AND source='self_service'", [first.user.id])).rows[0].count, 1)
      full = await oauth('full')
      assert.equal(full.user.email, 'org.employee@kando.com.cn')
      const profile = (await pool.query('SELECT profile FROM dingtalk_login_identities WHERE app_user_id=$1', [full.user.id])).rows[0].profile
      for (const field of ['email', 'orgEmail', 'mobile', 'avatarUrl', 'jobNumber', 'departmentIds']) assert.deepEqual(profile[field], providerData.full[field as keyof typeof providerData.full])
      assert.doesNotMatch(JSON.stringify(profile), /token|secret-never-persist/i)
      assert.equal((await pool.query("SELECT COUNT(*)::int AS count FROM app_users WHERE role='admin'")).rows[0].count, 0)
    })

    await t.test('pending status survives refresh/query removal and blocks business, profile and administrator APIs', async () => {
      await initializeDatabase()
      assert.equal((await me(first.cookie)).passwordSetupRequired, true)
      assert.equal((await (await call('/auth/me?ignored_query=1', first.cookie)).json()).user.passwordSetupRequired, true)
      const beforeAccounts = (await pool.query(`SELECT
        (SELECT COUNT(*)::int FROM app_users) AS users,
        (SELECT COUNT(*)::int FROM app_sessions) AS sessions`)).rows[0]
      const endpoints: Array<[string, unknown?, string?]> = [
        ['/workspace'], ['/user-options'], ['/dictionaries'], ['/settings/notification-rules'], ['/dingtalk/status'], ['/auth/users'],
        ['/auth/login', { name: 'New Joiner', password }, 'POST'],
        ['/auth/register', { name: '待设密身份抢注', email: 'pending-switch@kando.com.cn', password }, 'POST'],
        ['/auth/admin-contacts'], ['/auth/dingtalk/options'],
        ['/uploads', {}, 'POST'], ['/projects', { key: 'BLOCK', name: marker }, 'POST'],
        ['/auth/me', { name: '改名', email: 'rename@kando.com.cn' }, 'PATCH'],
        ['/auth/users/' + first.user.id + '/role', {}, 'PATCH'],
        ['/settings/notification-rules', { version: 1, rules: [] }, 'PUT'],
      ]
      for (const [path, body, method] of endpoints) {
        const response = await call(path, first.cookie, body, method)
        assert.equal(response.status, 403, path)
        assert.equal((await response.json()).code, 'PASSWORD_SETUP_REQUIRED', path)
      }
      assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM projects')).rows[0].count, 0)
      assert.equal((await pool.query('SELECT role FROM app_users WHERE id=$1', [first.user.id])).rows[0].role, 'member')
      assert.deepEqual((await pool.query(`SELECT
        (SELECT COUNT(*)::int FROM app_users) AS users,
        (SELECT COUNT(*)::int FROM app_sessions) AS sessions`)).rows[0], beforeAccounts)
    })

    await t.test('public registration cannot claim an auto-created profile or make the next registrant an administrator', async () => {
      const pending = await oauth('chinese')
      const claimed = await call('/auth/register', undefined, { name: '无邮箱员工', email: 'claim@kando.com.cn', password })
      assert.equal(claimed.status, 409)
      assert.equal((await pool.query('SELECT password_hash FROM app_users WHERE id=$1', [pending.user.id])).rows[0].password_hash, null)
      const registered = await call('/auth/register', undefined, { name: '后来注册员工', email: 'later@kando.com.cn', password })
      assert.equal(registered.status, 201)
      const registeredUser = (await registered.json()).user
      ledger.users.push(registeredUser.id)
      assert.equal(registeredUser.role, 'member')
      assert.equal((await call('/auth/register', undefined, { name: 'English Registration', email: 'english@kando.com.cn', password })).status, 400)
      assert.equal((await call('/auth/register', undefined, { name: '错误邮箱员工', email: 'other@example.invalid', password })).status, 400)
    })

    await t.test('password setup validates confirmation, revokes old sessions and supports no-email non-Chinese password login', async () => {
      resetOAuthLimiter()
      const secondPendingSession = await oauth('first')
      const before = (await pool.query('SELECT password_hash,password_setup_required FROM app_users WHERE id=$1', [first.user.id])).rows[0]
      for (const [value, confirmation] of [['12345', '12345'], ['x'.repeat(129), 'x'.repeat(129)], [password, password + 'x']]) {
        assert.equal((await setup(first.cookie, value, confirmation)).status, 400)
        assert.deepEqual((await pool.query('SELECT password_hash,password_setup_required FROM app_users WHERE id=$1', [first.user.id])).rows[0], before)
      }
      const result = await setup(first.cookie)
      assert.equal(result.status, 200)
      readyCookie = sessionCookie(result)!
      assert.equal((await result.json()).user.passwordSetupRequired, false)
      assert.notEqual(readyCookie, first.cookie)
      assert.equal(await me(first.cookie), null)
      assert.equal(await me(secondPendingSession.cookie), null)
      const stored = (await pool.query('SELECT password_hash,password_setup_required FROM app_users WHERE id=$1', [first.user.id])).rows[0]
      assert.equal(stored.password_setup_required, false)
      assert.notEqual(stored.password_hash, password)
      assert.equal(await verifyPassword(password, stored.password_hash), true)
      assert.equal((await call('/workspace', readyCookie)).status, 200)
      const local = await call('/auth/login', undefined, { name: 'New Joiner', password })
      assert.equal(local.status, 200)
      assert.equal((await local.json()).user.id, first.user.id)
      assert.equal((await setup(readyCookie, 'reset-attack')).status, 409)
      assert.equal((await setup(first.cookie, 'replay-attack')).status, 401)
      await initializeDatabase()
      assert.equal((await me(readyCookie)).passwordSetupRequired, false)
      const nextOAuth = await oauth('first')
      assert.equal(nextOAuth.user.id, first.user.id)
      assert.equal(nextOAuth.user.passwordSetupRequired, false)
      assert.equal(nextOAuth.target.searchParams.has('dingtalk'), false)
    })

    await t.test('expired, revoked and concurrently reused onboarding sessions cannot reset passwords', async () => {
      resetOAuthLimiter()
      const expired = await oauth('full')
      await pool.query("UPDATE app_sessions SET expires_at=NOW()-INTERVAL '1 second' WHERE token_hash=$1", [hash(expired.cookie!.split('=')[1])])
      assert.equal((await setup(expired.cookie)).status, 401)
      const revoked = await oauth('full')
      assert.equal((await call('/auth/logout', revoked.cookie, {})).status, 200)
      assert.equal((await setup(revoked.cookie)).status, 401)
      const pending = await oauth('full')
      const responses = await Promise.all([setup(pending.cookie, 'race-password-1'), setup(pending.cookie, 'race-password-2')])
      assert.equal(responses.filter((response) => response.status === 200).length, 1)
      assert.ok(responses.filter((response) => response.status !== 200).every((response) => [401, 409].includes(response.status)))
      const row = (await pool.query('SELECT password_hash,password_setup_required FROM app_users WHERE id=$1', [full.user.id])).rows[0]
      assert.equal(row.password_setup_required, false)
      assert.equal(Number(await verifyPassword('race-password-1', row.password_hash)) + Number(await verifyPassword('race-password-2', row.password_hash)), 1)
      assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM app_sessions WHERE user_id=$1', [full.user.id])).rows[0].count, 1)
    })

    await t.test('revocation while setup waits for the user lock is rechecked inside the transaction', async () => {
      const pending = await oauth('waiting')
      const lock = await pool.connect()
      try {
        await lock.query('BEGIN')
        await lock.query('SELECT id FROM app_users WHERE id=$1 FOR UPDATE', [pending.user.id])
        let finished = false
        const setting = setup(pending.cookie).finally(() => { finished = true })
        await delay(100)
        assert.equal(finished, false)
        assert.equal((await call('/auth/logout', pending.cookie, {})).status, 200)
        await lock.query('COMMIT')
        assert.equal((await setting).status, 401)
        const row = (await pool.query('SELECT password_hash,password_setup_required FROM app_users WHERE id=$1', [pending.user.id])).rows[0]
        assert.deepEqual(row, { password_hash: null, password_setup_required: true })
      } finally { await lock.query('ROLLBACK'); lock.release() }
    })

    await t.test('concurrent OAuth callbacks create one account and profile; callbacks are single-use', async () => {
      resetOAuthLimiter()
      const a = await start()
      const b = await start()
      const responses = await Promise.all([callback(a, 'concurrent'), callback(b, 'concurrent')])
      assert.ok(responses.every((response) => response.status === 303))
      const userA = await me(sessionCookie(responses[0]))
      const userB = await me(sessionCookie(responses[1]))
      assert.equal(userA.id, userB.id)
      ledger.users.push(userA.id)
      assert.equal(userA.role, 'member')
      assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM dingtalk_login_identities WHERE dingtalk_user_id=$1', [providerData.concurrent.userId])).rows[0].count, 1)
      assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM dingtalk_binding_audit WHERE app_user_id=$1', [userA.id])).rows[0].count, 1)
      const before = providerCalls
      const replay = await callback(a, 'concurrent')
      assert.equal(new URL(replay.headers.get('location')!).searchParams.get('dingtalk_error'), 'expired')
      assert.equal(providerCalls, before)
      providerData.concurrent = identity('concurrent', 'Concurrent Joiner', { jobNumber: 'UPDATED-EMP', mobile: '13900000000' })
      assert.equal((await oauth('concurrent')).user.id, userA.id)
      const profile = (await pool.query('SELECT profile FROM dingtalk_login_identities WHERE app_user_id=$1', [userA.id])).rows[0].profile
      assert.equal(profile.jobNumber, 'UPDATED-EMP')
    })

    await t.test('email, name and notification collisions require old-account proof and preserve registered UUID and role', async () => {
      resetOAuthLimiter()
      const beforeFull = (await pool.query('SELECT * FROM app_users WHERE id=$1', [full.user.id])).rows[0]
      const denied = await oauth('otherEmail')
      assert.equal(denied.cookie, undefined)
      assert.equal(denied.target.searchParams.get('dingtalk_error'), 'identity_conflict')
      assert.deepEqual((await pool.query('SELECT * FROM app_users WHERE id=$1', [full.user.id])).rows[0], beforeFull)
      assert.equal((await pool.query('SELECT id FROM dingtalk_login_identities WHERE dingtalk_user_id=$1', [providerData.otherEmail.userId])).rowCount, 0)
      const existingId = await localUser('原有管理员', { role: 'admin', email: 'existing@kando.com.cn' })
      await pool.query(`UPDATE app_users SET dingtalk_corp_id=$1,dingtalk_user_id=$2,dingtalk_union_id=$3,
        dingtalk_binding_source='email_sync',dingtalk_sync_status='matched' WHERE id=$4`,
      [corpId, providerData.collision.userId, providerData.collision.unionId, existingId])
      const original = (await pool.query('SELECT * FROM app_users WHERE id=$1', [existingId])).rows[0]
      const proof = await oauth('collision')
      assert.equal(proof.target.searchParams.get('dingtalk'), 'bind')
      assert.equal(proof.cookie, undefined)
      assert.equal((await call('/auth/dingtalk/bind', proof.flow.cookie, { name: '原有管理员', password: 'incorrect-password' })).status, 401)
      assert.deepEqual((await pool.query('SELECT * FROM app_users WHERE id=$1', [existingId])).rows[0], original)
      const bound = await call('/auth/dingtalk/bind', proof.flow.cookie, { name: '原有管理员', password })
      assert.equal(bound.status, 200)
      administratorCookie = sessionCookie(bound)!
      const user = (await bound.json()).user
      assert.equal(user.id, existingId)
      assert.equal(user.role, 'admin')
      assert.equal((await pool.query('SELECT password_hash FROM app_users WHERE id=$1', [existingId])).rows[0].password_hash, original.password_hash)
      assert.equal((await oauth('collision')).user.id, existingId)
    })

    await t.test('administrators can reset email-less accounts without clearing onboarding; a queued old-password login cannot survive setup', async () => {
      assert.equal((await call('/auth/users/' + first.user.id + '/password', administratorCookie, { password: 'admin-reset-ready' }, 'PATCH')).status, 200)
      const readyLogin = await call('/auth/login', undefined, { name: 'New Joiner', password: 'admin-reset-ready' })
      assert.equal(readyLogin.status, 200)
      assert.equal((await readyLogin.json()).user.passwordSetupRequired, false)
      const pendingId = (await pool.query('SELECT id FROM app_users WHERE display_name=$1', ['等待设置员工'])).rows[0].id
      assert.equal((await call('/auth/users/' + pendingId + '/password', administratorCookie, { password: 'temporary-pending' }, 'PATCH')).status, 200)
      assert.equal((await pool.query('SELECT password_setup_required FROM app_users WHERE id=$1', [pendingId])).rows[0].password_setup_required, true)
      const temporaryLogin = await call('/auth/login', undefined, { name: '等待设置员工', password: 'temporary-pending' })
      assert.equal(temporaryLogin.status, 200)
      assert.equal((await temporaryLogin.json()).user.passwordSetupRequired, true)
      const temporaryCookie = sessionCookie(temporaryLogin)!
      assert.equal((await call('/workspace', temporaryCookie)).status, 403)
      const lock = await pool.connect()
      try {
        await lock.query('BEGIN')
        await lock.query('SELECT id FROM app_users WHERE id=$1 FOR UPDATE', [pendingId])
        const setting = setup(temporaryCookie, 'final-password-self')
        let setupWaiting = false
        for (let attempt = 0; attempt < 30; attempt += 1) {
          const waiting = await pool.query(`SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
            AND wait_event_type='Lock' AND query LIKE $1`, ['%FROM app_users WHERE id = $1 FOR UPDATE%'])
          if (waiting.rowCount) { setupWaiting = true; break }
          await delay(20)
        }
        assert.equal(setupWaiting, true, 'setup must obtain the user lock before the old-password login')
        const staleLogin = call('/auth/login', undefined, { name: '等待设置员工', password: 'temporary-pending' })
        await delay(100)
        await lock.query('COMMIT')
        assert.equal((await setting).status, 200)
        assert.equal((await staleLogin).status, 401)
        assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM app_sessions WHERE user_id=$1', [pendingId])).rows[0].count, 1)
        assert.equal(await me(temporaryCookie), null)
      } finally { await lock.query('ROLLBACK'); lock.release() }
    })

    await t.test('pilot limits, foreign enterprises, disabled accounts and passwordless placeholders fail closed', async () => {
      resetOAuthLimiter()
      config.dingtalkLogin.scope = 'pilot'
      config.dingtalkLogin.allowedUserIds = [providerData.first.userId]
      assert.equal((await oauth('pilotDenied')).target.searchParams.get('dingtalk_error'), 'not_allowed')
      config.dingtalkLogin.scope = 'company'
      assert.equal((await oauth('outsider')).target.searchParams.get('dingtalk_error'), 'company_required')
      const disabledId = await localUser('停用员工', { active: false })
      const placeholderId = await localUser('无密码档案', { password: false })
      assert.equal((await oauth('paused')).target.searchParams.get('dingtalk_error'), 'account_disabled')
      assert.equal((await oauth('placeholder')).target.searchParams.get('dingtalk_error'), 'identity_conflict')
      assert.equal((await pool.query('SELECT app_user_id FROM dingtalk_login_identities WHERE app_user_id=ANY($1::uuid[])', [[disabledId, placeholderId]])).rowCount, 0)
      config.dingtalkLogin.autoRegister = false
      const notOpened = await oauth('pilotDenied')
      assert.equal(notOpened.target.searchParams.get('dingtalk'), 'bind')
      assert.equal(notOpened.cookie, undefined)
      assert.equal((await pool.query('SELECT id FROM dingtalk_login_identities WHERE dingtalk_user_id=$1', [providerData.pilotDenied.userId])).rowCount, 0)
    })
    t.diagnostic(JSON.stringify({ ...ledger, providerCalls, externalRequests: 0 }))
  } finally {
    if (server) {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server!.close(() => resolve()))
    }
    globalThis.fetch = originalFetch
    if (fixture) await fixture.end()
    Object.assign(config, savedConfig)
    try {
      if (databaseCreated) {
        for (let attempt = 0; attempt < 20; attempt += 1) {
          if ((await control.query('SELECT COUNT(*)::int AS count FROM pg_stat_activity WHERE datname=$1', [databaseName])).rows[0].count === 0) break
          await delay(50)
        }
        await control.query(`DROP DATABASE "${databaseName}"`)
        assert.equal((await control.query('SELECT datname FROM pg_database WHERE datname=$1', [databaseName])).rowCount, 0)
        t.diagnostic(JSON.stringify({ marker, databaseName, cleanup: 'passed', remaining: 0, configuredDatabaseUntouched: true }))
      }
    } finally { await control.end() }
  }
})
