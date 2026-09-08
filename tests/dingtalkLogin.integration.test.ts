import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import test from 'node:test'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

// Explicit opt-in: this test only uses the dedicated local DingTalk database and a fake provider.
test('DingTalk OAuth and existing-account association integration', {
  skip: process.env.TRACEBUG_DINGTALK_AUTH_TEST !== 'true',
  timeout: 60_000,
}, async (t) => {
  const { config } = await import('../server/config.js')
  assert.deepEqual([config.pgHost, config.pgPort, config.pgDatabase], ['127.0.0.1', 5434, 'tracebug_local'], 'dedicated local database required')
  assert.equal(process.env.DATABASE_URL, undefined, 'DATABASE_URL must not override the guarded database')
  const originalCookieName = config.sessionCookieName
  config.sessionCookieName = 'tb_sid_dingtalk_integration'
  const expectedSessionCookie = config.sessionCookieName
  const expectedFlowCookie = `${expectedSessionCookie}_dingtalk_flow`
  const { pool } = await import('../server/db.js')
  const { hashPassword } = await import('../server/password.js')
  const { attachUser, requireSameOrigin } = await import('../server/auth.js')
  const { default: authRoutes } = await import('../server/authRoutes.js')
  const { createDingTalkAuthRouter } = await import('../server/dingtalkAuthRoutes.js')
  const { default: express } = await import('express')
  const { default: cookieParser } = await import('cookie-parser')
  const marker = 'SELFTEST-' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14).replace(/^(\d{8})/, '$1-')
  const hash = (value: string) => createHash('sha256').update(value).digest('hex')
  const ledger = { marker, userIds: [] as string[], projectIds: [] as string[], issueIds: [] as string[], activityIds: [] as string[], flowIds: [] as string[] }
  const originalConfig = { ...config, dingtalk: { ...config.dingtalk }, dingtalkLogin: { ...config.dingtalkLogin } }
  let server: Server | undefined
  let base = ''
  let providerCalls = 0
  const corpId = marker + '-corp'
  const identity = (suffix: string, corp = corpId) => ({ corpId: corp, userId: marker + '-' + suffix, unionId: marker + '-union-' + suffix, name: '自测钉钉员工' })
  const providerIdentities = { primary: identity('primary'), race: identity('race'), outside: identity('outside', marker + '-other-corp'), denied: identity('denied') }
  const password = randomBytes(24).toString('base64url')
  const cookies = (response: Response) => response.headers.getSetCookie()
  const sessionCookie = (response: Response) => cookies(response).find((value) => value.startsWith(expectedSessionCookie + '='))?.split(';')[0]
  async function request(path: string, cookie?: string, body?: unknown, origin = base) {
    assert.ok(path.startsWith('/') && !path.startsWith('//'))
    return fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST', redirect: 'manual',
      headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000),
    })
  }
  type Flow = { id: string; state: string; cookie: string }
  async function start(returnTo = '/') {
    const response = await request('/api/auth/dingtalk/start?returnTo=' + encodeURIComponent(returnTo))
    assert.equal(response.status, 302)
    const target = new URL(response.headers.get('location')!)
    assert.equal(target.origin, 'https://login.dingtalk.com')
    assert.equal(target.searchParams.get('redirect_uri'), base + '/api/auth/dingtalk/callback')
    const state = target.searchParams.get('state')!
    assert.match(state, /^[A-Za-z0-9_-]{43}$/)
    const setCookie = cookies(response).find((value) => value.startsWith(expectedFlowCookie + '='))!
    assert.match(setCookie, /; HttpOnly/i)
    assert.match(setCookie, /; SameSite=Lax/i)
    assert.match(setCookie, /; Path=\/api\/auth\/dingtalk(?:;|$)/i)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    const cookie = setCookie.split(';')[0]
    const row = (await pool.query('SELECT id, state_hash, browser_hash FROM dingtalk_login_flows WHERE state_hash = $1', [hash(state)])).rows[0]
    assert.ok(row)
    ledger.flowIds.push(row.id)
    assert.equal(row.browser_hash, hash(cookie.slice(cookie.indexOf('=') + 1)))
    assert.notEqual(row.state_hash, state)
    return { id: row.id as string, state, cookie }
  }
  const callback = (flow: Flow, code = 'primary', state = flow.state, cookie = flow.cookie) => request(
    '/api/auth/dingtalk/callback?' + new URLSearchParams({ state, authCode: code }), cookie,
  )
  const bind = (flow: Flow, name: string, suppliedPassword = password) => request('/api/auth/dingtalk/bind', flow.cookie, { name, password: suppliedPassword })
  async function assertAnonymous(response: Response) {
    assert.equal(sessionCookie(response), undefined)
    assert.equal((await (await request('/api/auth/me')).json()).user, null)
  }
  async function createUser(role: 'admin' | 'member', emailSync = false) {
    const id = randomUUID()
    const han = '一二三四五六七八九十甲乙丙丁戊己'
    const name = '自测' + id.replaceAll('-', '').split('').map((char) => han[parseInt(char, 16)]).join('')
    await pool.query(`INSERT INTO app_users (id, display_name, email, password_hash, role,
      dingtalk_corp_id, dingtalk_user_id, dingtalk_union_id, dingtalk_binding_source, dingtalk_sync_status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`, [id, name, marker + '-' + id.slice(0, 8) + '@example.invalid',
      await hashPassword(password), role, emailSync ? corpId : null, emailSync ? providerIdentities.primary.userId : null,
      emailSync ? providerIdentities.primary.unionId : null, emailSync ? 'email_sync' : null, emailSync ? 'matched' : 'unmatched'])
    ledger.userIds.push(id)
    return { id, name }
  }
  try {
    // /start expires old flows; refuse to run while any unrelated flow could be affected.
    assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM dingtalk_login_flows')).rows[0].count, 0, 'finish existing OAuth attempts before this isolated test')
    config.secureCookies = false
    Object.assign(config.dingtalk, { enabled: false, dryRun: true, clientId: 'SELFTEST-client', clientSecret: 'SELFTEST-secret', corpId, requestTimeoutMs: 1000 })
    Object.assign(config.dingtalkLogin, { enabled: true, allowedUserIds: [providerIdentities.primary.userId, providerIdentities.race.userId, providerIdentities.outside.userId] })
    const app = express()
    app.use(express.json(), cookieParser(), requireSameOrigin, attachUser)
    app.use('/api/auth/dingtalk', createDingTalkAuthRouter({
      async exchangeCode(code) {
        providerCalls += 1
        assert.ok(Object.hasOwn(providerIdentities, code), 'only fake authorization codes are allowed')
        return providerIdentities[code as keyof typeof providerIdentities]
      },
    }))
    app.use('/api/auth', authRoutes)
    app.use((error: unknown, _req: unknown, res: import('express').Response, _next: unknown) => {
      t.diagnostic('Unexpected integration server error: ' + (error instanceof Error ? error.message : 'unknown'))
      res.status(500).json({ error: 'integration server failure' })
    })
    server = app.listen(0, '127.0.0.1')
    await once(server, 'listening')
    base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port
    config.publicOrigin = config.publicAppOrigin = base
    config.dingtalkLogin.callbackUrl = base + '/api/auth/dingtalk/callback'

    const admin = await createUser('admin', true)
    const competitorA = await createUser('member')
    const competitorB = await createUser('member')
    const projectId = randomUUID()
    await pool.query('INSERT INTO projects (id, project_key, name, color, created_by) VALUES ($1, $2, $3, $4, $5)', [projectId, 'ST' + randomBytes(3).toString('hex'), marker, '#2563eb', admin.id])
    ledger.projectIds.push(projectId)
    const issueId = randomUUID()
    await pool.query(`INSERT INTO issues (id, issue_key, project_id, title, status, priority, reporter_id, assignee_id, last_modified_by)
      VALUES ($1, $2, $3, $4, '待处理', 'P2', $5, $5, $5)`, [issueId, marker + '-1', projectId, marker + ' 历史归属', admin.id])
    ledger.issueIds.push(issueId)
    await pool.query('INSERT INTO issue_assignees (issue_id, user_id) VALUES ($1, $2)', [issueId, admin.id])
    const activityId = randomUUID()
    await pool.query("INSERT INTO issue_activities (id, issue_id, actor_id, action, kind) VALUES ($1, $2, $3, $4, 'created')", [activityId, issueId, admin.id, marker])
    ledger.activityIds.push(activityId)
    t.diagnostic(JSON.stringify({ ...ledger, flowIds: undefined }))

    await t.test('browser-bound one-time state and email notification bindings require account proof', async () => {
      const deepLink = '/?issue=' + encodeURIComponent(marker + '-1') + '&view=issues'
      const flow = await start(deepLink)
      const other = await start('https://outside.invalid/')
      assert.notEqual(flow.state, other.state)
      assert.notEqual(flow.cookie, other.cookie)
      assert.equal((await pool.query('SELECT return_to FROM dingtalk_login_flows WHERE id = $1', [other.id])).rows[0].return_to, '/')
      await request('/api/auth/dingtalk/cancel', other.cookie, {})
      await assertAnonymous(await callback(flow, 'primary', randomBytes(32).toString('base64url')))
      await assertAnonymous(await callback(flow, 'primary', flow.state, other.cookie))
      assert.equal(providerCalls, 0)
      const authorized = await callback(flow)
      assert.equal(new URL(authorized.headers.get('location')!).searchParams.get('dingtalk'), 'bind')
      await assertAnonymous(authorized)
      assert.equal(providerCalls, 1)
      await assertAnonymous(await callback(flow))
      assert.equal(providerCalls, 1, 'callback replay must not call provider')
      assert.equal((await (await request('/api/auth/dingtalk/pending', flow.cookie)).json()).pending.name, '自测钉钉员工')
      assert.equal((await request('/api/auth/dingtalk/bind', flow.cookie, { name: admin.name, password }, 'https://outside.invalid')).status, 403)
      const before = (await pool.query('SELECT * FROM app_users WHERE id = $1', [admin.id])).rows[0]
      assert.equal((await bind(flow, admin.name, 'incorrect-password')).status, 401)
      assert.deepEqual((await pool.query('SELECT * FROM app_users WHERE id = $1', [admin.id])).rows[0], before)
      assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM dingtalk_login_identities WHERE app_user_id = $1', [admin.id])).rows[0].count, 0)
      const associated = await bind(flow, admin.name)
      assert.equal(associated.status, 200)
      const body = await associated.json()
      assert.equal(body.user.id, admin.id)
      assert.equal(body.user.role, 'admin')
      assert.equal(body.returnTo, deepLink)
      assert.ok(sessionCookie(associated))
      assert.ok(cookies(associated).every((value) => !value.startsWith('tb_sid=')), 'association must not replace a production cookie')
      assert.equal((await (await request('/api/auth/me', sessionCookie(associated))).json()).user.id, admin.id)
      const wrongEnvironmentCookie = sessionCookie(associated)!.replace(expectedSessionCookie + '=', 'tb_sid=')
      assert.equal((await (await request('/api/auth/me', wrongEnvironmentCookie)).json()).user, null, 'production cookie name must not authenticate in staging')
      const after = (await pool.query('SELECT id, role, password_hash, dingtalk_binding_source FROM app_users WHERE id = $1', [admin.id])).rows[0]
      assert.deepEqual(after, { id: admin.id, role: 'admin', password_hash: before.password_hash, dingtalk_binding_source: 'self_service' })
      const history = (await pool.query(`SELECT i.reporter_id, i.assignee_id, i.last_modified_by, a.actor_id, ia.user_id
        FROM issues i JOIN issue_activities a ON a.issue_id = i.id JOIN issue_assignees ia ON ia.issue_id = i.id WHERE i.id = $1`, [issueId])).rows[0]
      assert.deepEqual(Object.values(history), Array(5).fill(admin.id))
      assert.equal((await pool.query("SELECT COUNT(*)::int AS count FROM dingtalk_binding_audit WHERE app_user_id = $1 AND source = 'self_service'", [admin.id])).rows[0].count, 1)
    })

    await t.test('verified DingTalk login creates a session without asking for the old password', async () => {
      const result = await callback(await start('/?issue=' + marker + '-1'))
      assert.equal(result.status, 303)
      assert.equal(new URL(result.headers.get('location')!).searchParams.get('issue'), marker + '-1')
      assert.equal(new URL(result.headers.get('location')!).searchParams.has('dingtalk'), false)
      assert.ok(sessionCookie(result))
      const user = (await (await request('/api/auth/me', sessionCookie(result))).json()).user
      assert.equal(user.id, admin.id)
      assert.equal(user.role, 'admin')
      const logout = await request('/api/auth/logout', sessionCookie(result) + '; tb_sid=production-cookie-must-survive', {})
      assert.equal(logout.status, 200)
      assert.ok(cookies(logout).some((value) => value.startsWith(expectedSessionCookie + '=')))
      assert.ok(cookies(logout).every((value) => !value.startsWith('tb_sid=')), 'staging logout must not clear the production cookie')
    })

    await t.test('pilot allowlist, enterprise restriction and disabled local account are enforced', async () => {
      for (const [code, expected] of [['denied', 'not_allowed'], ['outside', 'company_required']]) {
        const response = await callback(await start(), code)
        assert.equal(new URL(response.headers.get('location')!).searchParams.get('dingtalk_error'), expected)
        await assertAnonymous(response)
      }
      await pool.query('UPDATE app_users SET active = FALSE WHERE id = $1', [admin.id])
      const disabled = await callback(await start())
      assert.equal(new URL(disabled.headers.get('location')!).searchParams.get('dingtalk_error'), 'account_disabled')
      await assertAnonymous(disabled)
    })

    await t.test('expired and cancelled proof cannot bind a local account', async () => {
      const expired = await start()
      await callback(expired, 'race')
      await pool.query("UPDATE dingtalk_login_flows SET expires_at = NOW() - INTERVAL '1 second' WHERE id = $1", [expired.id])
      assert.equal((await bind(expired, competitorA.name)).status, 410)
      const cancelled = await start()
      await callback(cancelled, 'race')
      assert.equal((await request('/api/auth/dingtalk/cancel', cancelled.cookie, {})).status, 200)
      assert.equal((await bind(cancelled, competitorA.name)).status, 410)
      assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM dingtalk_login_identities WHERE app_user_id = $1', [competitorA.id])).rows[0].count, 0)
    })

    await t.test('concurrent association of one DingTalk identity can succeed for only one local user', async () => {
      const a = await start()
      const b = await start()
      await callback(a, 'race')
      await callback(b, 'race')
      const results = await Promise.all([bind(a, competitorA.name), bind(b, competitorB.name)])
      assert.deepEqual(results.map((result) => result.status).sort(), [200, 409])
      const identities = await pool.query('SELECT app_user_id FROM dingtalk_login_identities WHERE corp_id = $1 AND dingtalk_user_id = $2', [corpId, providerIdentities.race.userId])
      assert.equal(identities.rowCount, 1)
      assert.ok([competitorA.id, competitorB.id].includes(identities.rows[0].app_user_id))
      assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM dingtalk_binding_audit WHERE app_user_id = ANY($1::uuid[])', [[competitorA.id, competitorB.id]])).rows[0].count, 1)
    })
  } finally {
    if (server) {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()))
    }
    try {
      // Exact IDs only, reverse dependencies; no uploads or notifications are created by this test.
      await pool.query('DELETE FROM dingtalk_login_flows WHERE id = ANY($1::uuid[])', [ledger.flowIds])
      await pool.query('DELETE FROM dingtalk_binding_audit WHERE app_user_id = ANY($1::uuid[]) OR actor_user_id = ANY($1::uuid[])', [ledger.userIds])
      await pool.query('DELETE FROM dingtalk_login_identities WHERE app_user_id = ANY($1::uuid[])', [ledger.userIds])
      await pool.query('DELETE FROM app_sessions WHERE user_id = ANY($1::uuid[])', [ledger.userIds])
      await pool.query('DELETE FROM projects WHERE id = ANY($1::uuid[])', [ledger.projectIds])
      await pool.query('DELETE FROM app_users WHERE id = ANY($1::uuid[])', [ledger.userIds])
      const counts = await pool.query(`SELECT
        (SELECT COUNT(*)::int FROM app_users WHERE id = ANY($1::uuid[])) AS users,
        (SELECT COUNT(*)::int FROM projects WHERE id = ANY($2::uuid[])) AS projects,
        (SELECT COUNT(*)::int FROM issues WHERE id = ANY($3::uuid[])) AS issues,
        (SELECT COUNT(*)::int FROM issue_activities WHERE id = ANY($4::uuid[])) AS activities,
        (SELECT COUNT(*)::int FROM issue_assignees WHERE issue_id = ANY($3::uuid[])) AS assignees,
        (SELECT COUNT(*)::int FROM dingtalk_login_flows WHERE id = ANY($5::uuid[])) AS flows,
        (SELECT COUNT(*)::int FROM dingtalk_login_identities WHERE app_user_id = ANY($1::uuid[])) AS identities,
        (SELECT COUNT(*)::int FROM dingtalk_binding_audit WHERE app_user_id = ANY($1::uuid[])) AS audits,
        (SELECT COUNT(*)::int FROM app_sessions WHERE user_id = ANY($1::uuid[])) AS sessions,
        (SELECT COUNT(*)::int FROM notification_outbox WHERE aggregate_id = ANY($3::uuid[])) AS notifications`,
      [ledger.userIds, ledger.projectIds, ledger.issueIds, ledger.activityIds, ledger.flowIds])
      assert.ok(Object.values(counts.rows[0]).every((count) => count === 0), 'SELFTEST records must have zero residue')
      t.diagnostic(JSON.stringify({ marker, cleanup: counts.rows[0], providerCalls, flowIds: ledger.flowIds }))
    } finally {
      Object.assign(config, originalConfig)
      config.sessionCookieName = originalCookieName
      await pool.end()
    }
  }
})
