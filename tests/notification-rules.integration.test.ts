import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import test from 'node:test'
import type { AddressInfo } from 'node:net'

test('administrator notification rules drive issue events and durable deliveries', {
  skip: process.env.TRACEBUG_NOTIFICATION_TEST !== 'true', timeout: 90_000,
}, async (t) => {
  const { config } = await import('../server/config.js')
  assert.deepEqual([config.pgHost, config.pgPort, config.pgDatabase], ['127.0.0.1', 5434, 'tracebug_local'])
  assert.equal(process.env.DATABASE_URL, undefined)
  const { pool } = await import('../server/db.js')
  const { hashPassword } = await import('../server/password.js')
  const { attachUser, requireSameOrigin, createSession, sessionCookieName } = await import('../server/auth.js')
  const { default: authRoutes } = await import('../server/authRoutes.js')
  const { default: settingsRoutes } = await import('../server/notificationRuleRoutes.js')
  const { default: workspaceRoutes } = await import('../server/workspaceRoutes.js')
  const { startDingTalkNotificationWorker } = await import('../server/dingtalkNotifications.js')
  const { default: express } = await import('express')
  const { default: cookieParser } = await import('cookie-parser')
  const marker = 'SELFTEST-' + Date.now()
  const userIds: string[] = []
  const projectIds: string[] = []
  const originalSettings = (await pool.query('SELECT * FROM notification_rule_settings WHERE id = 1')).rows[0]
  assert.ok(originalSettings)
  assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM notification_outbox')).rows[0].count, 0, 'only an isolated empty notification database is allowed')
  const savedConfig = { publicOrigin: config.publicOrigin, publicAppOrigin: config.publicAppOrigin, dingtalk: { ...config.dingtalk } }
  const originalFetch = globalThis.fetch
  const app = express()
  app.use(express.json(), cookieParser(), requireSameOrigin, attachUser)
  app.use('/api/auth', authRoutes)
  app.use('/api/settings/notification-rules', settingsRoutes)
  app.use('/api', workspaceRoutes)
  app.use((error: unknown, _req: unknown, response: import('express').Response, _next: unknown) => {
    response.status(Number((error as { status?: number })?.status ?? 500)).json({ error: error instanceof Error ? error.message : 'error' })
  })
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port
  config.publicOrigin = config.publicAppOrigin = base
  Object.assign(config.dingtalk, { enabled: true, dryRun: true, clientId: '', clientSecret: '', corpId: '', agentId: '', workerPollMs: 50 })
  // Every external network request is forbidden in this process, including accidental live messages.
  globalThis.fetch = (input, init) => {
    const address = input instanceof Request ? input.url : String(input)
    assert.equal(new URL(address).origin, base, 'integration test must never call DingTalk')
    return originalFetch(input, init)
  }
  let worker: ReturnType<typeof startDingTalkNotificationWorker> | undefined
  async function call(path: string, cookie?: string, method = 'GET', body?: unknown) {
    const response = await fetch(base + path, { method, redirect: 'manual', headers: {
      Origin: base, ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    return { status: response.status, body: await response.json() }
  }
  async function user(name: string, role: string) {
    const id = randomUUID()
    await pool.query('INSERT INTO app_users (id, display_name, email, password_hash, role) VALUES ($1,$2,$3,$4,$5)',
      [id, name, marker + '-' + id.slice(0, 6) + '@example.invalid', await hashPassword(randomBytes(20).toString('hex')), role])
    userIds.push(id)
    return { id, cookie: sessionCookieName + '=' + (await createSession(id)).token }
  }
  let settings: { version: number; rules: Array<Record<string, unknown>> }
  async function save(rules: Array<Record<string, unknown>>, cookie: string) {
    const result = await call('/api/settings/notification-rules', cookie, 'PUT', { version: settings.version, rules })
    assert.equal(result.status, 200, JSON.stringify(result.body))
    settings = result.body
    return result.body
  }
  function rule(trigger: 'created' | 'status_changed', recipients: string[], targetStatus: string | null = null, enabled = true) {
    return { id: randomUUID(), name: marker + '-' + trigger, enabled, trigger, targetStatus, recipients }
  }
  const outboxes = async (issueId: string) => (await pool.query('SELECT * FROM notification_outbox WHERE aggregate_id = $1 ORDER BY created_at, id', [issueId])).rows
  const deliveries = async (outboxId: string) => (await pool.query('SELECT * FROM notification_deliveries WHERE outbox_id = $1 ORDER BY app_user_id', [outboxId])).rows
  try {
    const admin = await user('规则验收管理员', 'admin')
    const owner = await user('规则验收负责人', 'member')
    const other = await user('规则验收其他人', 'member')
    const project = await call('/api/projects', admin.cookie, 'POST', { key: 'ST' + randomBytes(2).toString('hex'), name: marker, description: 'notification rules integration' })
    assert.equal(project.status, 201)
    const projectId = project.body.project.id as string
    projectIds.push(projectId)
    async function create(assigneeIds = [owner.id], cookie = admin.cookie) {
      const result = await call('/api/projects/' + projectId + '/issues', cookie, 'POST', {
        title: marker, description: '<p>规则验收</p>', assigneeIds,
      })
      assert.equal(result.status, 201, JSON.stringify(result.body))
      const id = (await pool.query('SELECT id FROM issues WHERE issue_key = $1', [result.body.issue.id])).rows[0].id as string
      return { id, key: result.body.issue.id as string, response: result.body }
    }
    const initial = await call('/api/settings/notification-rules', admin.cookie)
    assert.equal(initial.status, 200)
    settings = initial.body
    const target = initial.body.statuses.find((entry: { value: string }) => entry.value === '待复测')
    assert.ok(target)
    const originStatus = initial.body.statuses.find((entry: { isDefault: boolean }) => entry.isDefault).value as string

    await t.test('only administrators manage rules, initial behavior remains new issue to assignees', async () => {
      assert.equal((await call('/api/settings/notification-rules')).status, 401)
      assert.equal((await call('/api/settings/notification-rules', owner.cookie)).status, 403)
      assert.equal((await call('/api/settings/notification-rules', owner.cookie, 'PUT', { version: settings.version, rules: [] })).status, 403)
      assert.equal(settings.rules.length, 1)
      assert.equal(settings.rules[0].trigger, 'created')
      assert.deepEqual(settings.rules[0].recipients, ['assignee'])
      const issue = await create()
      assert.equal(issue.response.issue.status, originStatus)
      const events = await outboxes(issue.id)
      assert.equal(events.length, 1)
      assert.equal(events[0].event_type, 'issue.created')
      assert.deepEqual((await deliveries(events[0].id)).map((row) => row.app_user_id), [owner.id])
    })

    await t.test('rule saves are durable, versioned, validated, and accept an empty disabled configuration', async () => {
      const staleVersion = settings.version
      const chosen = [rule('created', ['assignee', 'reporter']), rule('status_changed', ['reporter'], target.value)]
      const result = await save(chosen, admin.cookie)
      assert.equal(result.version, staleVersion + 1)
      assert.equal(result.updatedBy, '规则验收管理员')
      assert.equal(result.deliveryMode, 'dry_run')
      assert.deepEqual((await call('/api/settings/notification-rules', admin.cookie)).body.rules, chosen)
      assert.equal((await call('/api/settings/notification-rules', admin.cookie, 'PUT', { version: staleVersion, rules: [] })).status, 409)
      const badRules = [
        [rule('created', [])], [rule('status_changed', ['reporter'])], [rule('status_changed', ['reporter'], 'not-a-status')],
        [rule('created', ['admin'])], [rule('created', ['reporter'], target.value)],
        [{ ...chosen[0], name: '' }], [{ ...chosen[0], enabled: 'true' }], [chosen[0], chosen[0]],
      ]
      for (const rules of badRules) {
        assert.equal((await call('/api/settings/notification-rules', admin.cookie, 'PUT', { version: settings.version, rules })).status, 400)
        assert.equal((await call('/api/settings/notification-rules', admin.cookie)).body.version, settings.version)
      }
      await save([], admin.cookie)
      const issue = await create()
      assert.equal((await outboxes(issue.id)).length, 0)
      await save([rule('created', ['assignee'], null, false)], admin.cookie)
      const muted = await create()
      assert.equal((await outboxes(muted.id)).length, 0)
    })

    await t.test('recipients are unioned across rules and creator/assignee overlap is deduplicated', async () => {
      await save([rule('created', ['assignee']), rule('created', ['reporter']), rule('created', ['assignee', 'reporter'])], admin.cookie)
      const issue = await create([owner.id, other.id])
      const event = (await outboxes(issue.id))[0]
      assert.deepEqual((await deliveries(event.id)).map((row) => row.app_user_id).sort(), [admin.id, owner.id, other.id].sort())
      const overlap = await create([admin.id])
      const shared = await deliveries((await outboxes(overlap.id))[0].id)
      assert.equal(shared.length, 1)
      assert.deepEqual([...shared[0].recipient_roles].sort(), ['assignee', 'reporter'])
    })

    await t.test('single and batch transitions queue once per actual event, including returning to a previous status', async () => {
      await save([rule('status_changed', ['reporter'], target.value), rule('status_changed', ['assignee'], target.value)], admin.cookie)
      const issue = await create()
      const second = await create()
      assert.equal((await outboxes(issue.id)).length, 0)
      assert.equal((await call('/api/issues/' + issue.key, admin.cookie, 'PATCH', { title: marker + '改' })).status, 200)
      assert.equal((await outboxes(issue.id)).length, 0)
      assert.equal((await call('/api/issues/' + issue.key, admin.cookie, 'PATCH', { status: target.value })).status, 200)
      assert.equal((await outboxes(issue.id)).length, 1)
      assert.equal((await call('/api/issues/' + issue.key, admin.cookie, 'PATCH', { status: target.value })).status, 200)
      assert.equal((await outboxes(issue.id)).length, 1)
      assert.equal((await call('/api/issues/' + issue.key, admin.cookie, 'PATCH', { status: originStatus })).status, 200)
      assert.equal((await call('/api/issues/' + issue.key, admin.cookie, 'PATCH', { status: target.value })).status, 200)
      const repeat = await outboxes(issue.id)
      assert.equal(repeat.length, 2)
      assert.equal(new Set(repeat.map((event) => event.event_key)).size, 2)
      assert.ok(repeat.every((event) => event.event_type === 'issue.status_changed'))
      const batch = await call('/api/issues/batch/status', admin.cookie, 'PATCH', { issueIds: [issue.key, second.key], status: target.value })
      assert.equal(batch.status, 200)
      assert.equal(batch.body.updatedCount, 1)
      assert.equal((await outboxes(issue.id)).length, 2)
      assert.equal((await outboxes(second.id)).length, 1)
      const recipients = await deliveries((await outboxes(second.id))[0].id)
      assert.deepEqual(recipients.map((row) => row.app_user_id).sort(), [admin.id, owner.id].sort())
      const failure = await call('/api/issues/batch/status', admin.cookie, 'PATCH', { issueIds: [second.key, 'MISSING-ISSUE'], status: originStatus })
      assert.equal(failure.status, 404)
      assert.equal((await pool.query('SELECT status FROM issues WHERE id=$1', [second.id])).rows[0].status, target.value)
      assert.equal((await outboxes(second.id)).length, 1)
    })

    await t.test('disabled dictionary targets cannot enable rules; renamed labels retain the same target identity', async () => {
      const custom = randomUUID()
      await pool.query("INSERT INTO issue_dictionary_entries (kind,value,label,active,is_default,is_terminal,position,weight,show_in_personal) VALUES ('status',$1,$2,FALSE,FALSE,FALSE,100,0,TRUE)", [custom, marker])
      try {
        assert.equal((await call('/api/settings/notification-rules', admin.cookie, 'PUT', { version: settings.version, rules: [rule('status_changed', ['reporter'], custom)] })).status, 400)
        await save([rule('status_changed', ['reporter'], custom, false)], admin.cookie)
        await pool.query("UPDATE issue_dictionary_entries SET active=TRUE,label='自定义验收状态' WHERE kind='status' AND value=$1", [custom])
        await save([rule('status_changed', ['reporter'], custom)], admin.cookie)
        const issue = await create()
        assert.equal((await call('/api/issues/' + issue.key, admin.cookie, 'PATCH', { status: custom })).status, 200)
        const event = (await outboxes(issue.id))[0]
        assert.equal(event.payload.status, '自定义验收状态')
        assert.equal((await deliveries(event.id))[0].app_user_id, admin.id)
        await call('/api/issues/' + issue.key, admin.cookie, 'PATCH', { status: originStatus })
        await save([], admin.cookie)
      } finally {
        await pool.query("DELETE FROM issue_dictionary_entries WHERE kind='status' AND value=$1", [custom])
      }
    })

    await t.test('global transport switch and missing account mappings do not send messages', async () => {
      await save([rule('created', ['reporter'])], admin.cookie)
      config.dingtalk.enabled = false
      const disabled = await create()
      assert.equal((await outboxes(disabled.id)).length, 0)
      config.dingtalk.enabled = true
      config.dingtalk.dryRun = false
      const unmapped = await create()
      const row = (await deliveries((await outboxes(unmapped.id))[0].id))[0]
      assert.equal(row.status, 'skipped_unmapped')
      config.dingtalk.dryRun = true
    })

    await t.test('the worker delivers reporter snapshots, skips stale assignees, and ignores later rule edits', async () => {
      await save([rule('created', ['assignee', 'reporter'])], admin.cookie)
      const issue = await create([owner.id])
      const event = (await outboxes(issue.id))[0]
      await call('/api/issues/' + issue.key, admin.cookie, 'PATCH', { assigneeIds: [other.id] })
      await save([], admin.cookie)
      config.dingtalk.workerPollMs = 500
      worker = startDingTalkNotificationWorker()
      const deadline = Date.now() + 20_000
      let statuses: Record<string, string> = {}
      do {
        statuses = Object.fromEntries((await deliveries(event.id)).map((row) => [row.app_user_id, row.status]))
        if (statuses[admin.id] === 'provider_succeeded' && statuses[owner.id] === 'skipped_stale') break
        await new Promise((resolve) => setTimeout(resolve, 200))
      } while (Date.now() < deadline)
      assert.equal(statuses[admin.id], 'provider_succeeded', 'creator must not be skipped merely for not being an assignee')
      assert.equal(statuses[owner.id], 'skipped_stale')
      assert.equal(statuses[other.id], undefined, 'later assignee must not be silently added to the old event')
    })
  } finally {
    await worker?.stop()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    globalThis.fetch = originalFetch
    Object.assign(config, savedConfig)
    try {
      await pool.query('UPDATE notification_rule_settings SET version=$1,rules=$2::jsonb,updated_by=$3,updated_at=$4 WHERE id=1',
        [originalSettings.version, JSON.stringify(originalSettings.rules), originalSettings.updated_by, originalSettings.updated_at])
      await pool.query('DELETE FROM notification_outbox WHERE aggregate_id IN (SELECT id FROM issues WHERE project_id=ANY($1::uuid[]))', [projectIds])
      await pool.query('DELETE FROM projects WHERE id=ANY($1::uuid[])', [projectIds])
      await pool.query('DELETE FROM app_users WHERE id=ANY($1::uuid[])', [userIds])
      const remaining = await pool.query(`SELECT
        (SELECT COUNT(*)::int FROM app_users WHERE id=ANY($1::uuid[])) AS users,
        (SELECT COUNT(*)::int FROM projects WHERE id=ANY($2::uuid[])) AS projects,
        (SELECT COUNT(*)::int FROM notification_outbox WHERE payload::text LIKE $3) AS notifications`, [userIds, projectIds, '%' + marker + '%'])
      assert.ok(Object.values(remaining.rows[0]).every((value) => value === 0))
      t.diagnostic(JSON.stringify({ marker, userIds, projectIds, cleanup: remaining.rows[0], externalMessages: 0 }))
    } finally { await pool.end() }
  }
})
