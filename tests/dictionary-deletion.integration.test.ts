import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import type { DictionaryData, DictionaryKind } from '../server/dictionaries.js'

test('dictionary deletion is explicit, authorized, reference-safe and serialized with issue/rule writers', {
  skip: process.env.TRACEBUG_NOTIFICATION_TEST !== 'true', timeout: 75_000,
}, async (t) => {
  const { config } = await import('../server/config.js')
  assert.deepEqual([config.pgHost, config.pgPort, config.pgDatabase], ['127.0.0.1', 5434, 'tracebug_local'])
  assert.equal(process.env.DATABASE_URL, undefined)
  const savedConfig = { ...config, dingtalk: { ...config.dingtalk } }
  const { Pool } = await import('pg')
  const { schemaSql } = await import('../server/schema.js')
  const databaseName = 'tracebug_dictionary_deletion_' + randomBytes(8).toString('hex')
  assert.match(databaseName, /^tracebug_dictionary_deletion_[a-f0-9]{16}$/)
  const control = new Pool({ host: config.pgHost, port: config.pgPort, user: config.pgUser, password: config.pgPassword, database: 'postgres' })
  let databaseCreated = false
  let fixture: import('pg').Pool | undefined
  let server: Server | undefined
  const originalFetch = globalThis.fetch
  const marker = 'SELFTEST-' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14).replace(/^(\d{8})/, '$1-')
  const ledger = { marker, databaseName, users: [] as string[], projects: [] as string[], issues: [] as string[], dictionaries: [] as string[] }
  try {
    await control.query(`CREATE DATABASE "${databaseName}"`)
    databaseCreated = true
    config.pgDatabase = databaseName
    config.dingtalk.enabled = false
    config.dingtalk.dryRun = true
    const { pool } = await import('../server/db.js')
    fixture = pool
    assert.equal((await pool.query('SELECT current_database() AS name')).rows[0].name, databaseName)
    await pool.query(schemaSql)
    const { attachUser, requireSameOrigin, createSession, sessionCookieName } = await import('../server/auth.js')
    const { hashPassword } = await import('../server/password.js')
    const { updateDictionary, dictionaryUpdateSchema, lockDictionaries } = await import('../server/dictionaries.js')
    const { saveNotificationRuleSettings, notificationRulesUpdateSchema } = await import('../server/notificationRules.js')
    const { default: workspaceRoutes } = await import('../server/workspaceRoutes.js')
    const { default: ruleRoutes } = await import('../server/notificationRuleRoutes.js')
    const { default: express } = await import('express')
    const { default: cookieParser } = await import('cookie-parser')
    const app = express()
    app.use(express.json(), cookieParser(), requireSameOrigin, attachUser)
    app.use('/api/settings/notification-rules', ruleRoutes)
    app.use('/api', workspaceRoutes)
    app.use((error: unknown, _req: unknown, res: import('express').Response, _next: unknown) => {
      res.status(Number((error as { status?: number })?.status ?? 500)).json({ error: error instanceof Error ? error.message : 'error' })
    })
    server = app.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port
    config.publicOrigin = config.publicAppOrigin = base
    globalThis.fetch = (input, init) => {
      assert.equal(new URL(input instanceof Request ? input.url : String(input)).origin, base, 'no external requests are permitted')
      return originalFetch(input, init)
    }
    async function user(role: 'admin' | 'member') {
      const id = randomUUID()
      await pool.query('INSERT INTO app_users (id,display_name,email,password_hash,role) VALUES ($1,$2,$3,$4,$5)',
        [id, marker + '-' + role, marker + '-' + role + '@example.invalid', await hashPassword(randomBytes(20).toString('hex')), role])
      ledger.users.push(id)
      return { id, cookie: sessionCookieName + '=' + (await createSession(id)).token }
    }
    const admin = await user('admin')
    const member = await user('member')
    async function call(path: string, body?: unknown, cookie: string | null = admin.cookie, method = body === undefined ? 'GET' : 'PUT') {
      const response = await fetch(base + '/api' + path, { method, headers: {
        Origin: base, ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000) })
      return { status: response.status, body: await response.json() }
    }
    const data = async () => (await call('/dictionaries')).body as DictionaryData
    const items = (current: DictionaryData, kind: DictionaryKind) => current.dictionaries[kind].map(({ value, label, active, isDefault, isTerminal, weight, showInPersonal }) => ({ value, label, active, isDefault, isTerminal, weight, showInPersonal }))
    async function deletion(kind: DictionaryKind, value: string) {
      const current = await data()
      return { version: current.dictionaryVersions[kind], items: items(current, kind).filter((entry) => entry.value !== value), deletedValues: [value] }
    }
    let sequence = 0
    async function add(kind: DictionaryKind) {
      const current = await data()
      const label = marker + '-' + ++sequence
      const response = await call('/dictionaries/' + kind, { version: current.dictionaryVersions[kind], items: [
        ...items(current, kind), { label, active: true, isDefault: false, isTerminal: false, weight: 0, showInPersonal: false },
      ] })
      assert.equal(response.status, 200, JSON.stringify(response.body))
      const entry = (response.body as DictionaryData).dictionaries[kind].find((item) => item.label === label)!
      assert.ok(entry)
      ledger.dictionaries.push(entry.value)
      return entry
    }
    const rulesData = async () => (await call('/settings/notification-rules')).body
    const rule = (value: string, enabled = true) => ({ id: randomUUID(), name: marker, enabled, trigger: 'status_changed', targetStatus: value, recipients: ['reporter'] })
    async function saveRules(rules: unknown[]) {
      const current = await rulesData()
      const response = await call('/settings/notification-rules', { version: current.version, rules })
      assert.equal(response.status, 200, JSON.stringify(response.body))
    }
    const project = await call('/projects', { key: 'DELETE', name: marker }, admin.cookie, 'POST')
    assert.equal(project.status, 201)
    const projectId = project.body.project.id as string
    ledger.projects.push(projectId)
    async function createIssue(extra: Record<string, string> = {}) {
      const response = await call('/projects/' + projectId + '/issues', { title: marker, assigneeIds: [member.id], ...extra }, admin.cookie, 'POST')
      if (response.status === 201) ledger.issues.push(response.body.issue.id)
      return response
    }
    const snapshot = async () => ({ entries: (await pool.query('SELECT * FROM issue_dictionary_entries ORDER BY kind,value')).rows,
      versions: (await pool.query('SELECT * FROM issue_dictionary_sets ORDER BY kind')).rows })

    await t.test('unused entries in every dictionary can be deleted by administrators with exactly one version increment', async () => {
      for (const kind of ['status', 'priority', 'environment'] as const) {
        const entry = await add(kind)
        const body = await deletion(kind, entry.value)
        assert.equal((await call('/dictionaries/' + kind, body, null)).status, 401)
        assert.equal((await call('/dictionaries/' + kind, body, member.cookie)).status, 403)
        const response = await call('/dictionaries/' + kind, body)
        assert.equal(response.status, 200)
        assert.equal(response.body.dictionaryVersions[kind], body.version + 1)
        assert.equal(response.body.dictionaries[kind].some((item: { value: string }) => item.value === entry.value), false)
        assert.equal((await pool.query('SELECT value FROM issue_dictionary_entries WHERE kind=$1 AND value=$2', [kind, entry.value])).rowCount, 0)
      }
    })

    await t.test('ambiguous or invalid deletion requests leave the entire dictionary transaction unchanged', async () => {
      const entry = await add('status')
      const current = await data()
      const prepared = await deletion('status', entry.value)
      const allItems = items(current, 'status')
      const badBodies = [
        { version: prepared.version, items: prepared.items },
        { ...prepared, deletedValues: [entry.value, entry.value] },
        { ...prepared, items: allItems, deletedValues: [randomUUID()] },
        { ...prepared, items: allItems },
        { ...prepared, items: prepared.items.map((item) => ({ ...item, isDefault: false })) },
        { ...prepared, items: [], deletedValues: allItems.map((item) => item.value) },
        { ...prepared, items: prepared.items.map((item) => ({ ...item, active: false, isDefault: false })) },
      ]
      const before = await snapshot()
      for (const body of badBodies) {
        assert.equal((await call('/dictionaries/status', body)).status, 400)
        assert.deepEqual(await snapshot(), before)
      }
    })

    await t.test('an unused old default can be deleted when the same save selects another default', async () => {
      const current = await data()
      const oldDefault = current.dictionaries.priority.find((entry) => entry.isDefault)!
      const nextDefault = current.dictionaries.priority.find((entry) => entry.value !== oldDefault.value && entry.active)!
      const body = await deletion('priority', oldDefault.value)
      body.items = body.items.map((entry) => ({ ...entry, isDefault: entry.value === nextDefault.value }))
      const response = await call('/dictionaries/priority', body)
      assert.equal(response.status, 200)
      assert.equal(response.body.dictionaries.priority.find((entry: { isDefault: boolean }) => entry.isDefault).value, nextDefault.value)
      assert.equal(response.body.dictionaries.priority.some((entry: { value: string }) => entry.value === oldDefault.value), false)
    })

    await t.test('current issue references prevent deletion of statuses, priorities and environments atomically', async () => {
      const status = await add('status')
      const priority = await add('priority')
      const environment = await add('environment')
      const issue = await createIssue({ status: status.value, priority: priority.value, environment: environment.value })
      assert.equal(issue.status, 201)
      for (const [kind, entry] of [['status', status], ['priority', priority], ['environment', environment]] as const) {
        const before = await snapshot()
        const response = await call('/dictionaries/' + kind, await deletion(kind, entry.value))
        assert.equal(response.status, 400)
        assert.ok(response.body.error.includes(entry.label))
        assert.match(response.body.error, /1 条缺陷/)
        assert.deepEqual(await snapshot(), before)
      }
    })

    await t.test('both enabled and disabled notification rules retain references that prevent status deletion', async () => {
      const entry = await add('status')
      for (const enabled of [true, false]) {
        await saveRules([rule(entry.value, enabled), rule(entry.value, false)])
        const before = await snapshot()
        const response = await call('/dictionaries/status', await deletion('status', entry.value))
        assert.equal(response.status, 400)
        assert.ok(response.body.error.includes(entry.label))
        assert.match(response.body.error, /2 条通知规则/)
        assert.deepEqual(await snapshot(), before)
      }
      await saveRules([])
    })

    await t.test('historical activity text and completed notification snapshots survive deletion and restart', async () => {
      const entry = await add('status')
      const issue = await createIssue()
      assert.equal(issue.status, 201)
      const issueId = (await pool.query('SELECT id FROM issues WHERE issue_key=$1', [issue.body.issue.id])).rows[0].id
      const activityId = randomUUID()
      const outboxId = randomUUID()
      const text = '历史状态：' + entry.label
      const payload = { status: entry.label, historicalValue: entry.value, title: marker }
      await pool.query("INSERT INTO issue_activities (id,issue_id,actor_id,action,detail,kind) VALUES ($1,$2,$3,'更新了状态',$4,'changed')", [activityId, issueId, admin.id, text])
      await pool.query("INSERT INTO notification_outbox (id,event_type,event_key,aggregate_id,issue_key,payload,status,completed_at) VALUES ($1,'issue.status_changed',$2,$3,$4,$5::jsonb,'provider_succeeded',NOW())",
        [outboxId, 'issue.status_changed:' + activityId, issueId, issue.body.issue.id, JSON.stringify(payload)])
      assert.equal((await call('/dictionaries/status', await deletion('status', entry.value))).status, 200)
      const before = await snapshot()
      await pool.query(schemaSql)
      assert.deepEqual(await snapshot(), before)
      assert.equal((await pool.query('SELECT detail FROM issue_activities WHERE id=$1', [activityId])).rows[0].detail, text)
      assert.deepEqual((await pool.query('SELECT payload FROM notification_outbox WHERE id=$1', [outboxId])).rows[0].payload, payload)
      assert.equal((await pool.query("SELECT value FROM issue_dictionary_entries WHERE kind='status' AND value=$1", [entry.value])).rowCount, 0)
    })

    await t.test('concurrent saves from one version have exactly one winner', async () => {
      const entry = await add('environment')
      const body = await deletion('environment', entry.value)
      const responses = await Promise.all([call('/dictionaries/environment', body), call('/dictionaries/environment', body)])
      assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409])
      assert.equal((await data()).dictionaryVersions.environment, body.version + 1)
    })

    await t.test('deletion winning the lock makes waiting issue and rule writes reject the removed value', async () => {
      for (const writer of ['issue', 'rule'] as const) {
        const entry = await add('status')
        const body = await deletion('status', entry.value)
        const currentRules = await rulesData()
        const lock = await pool.connect()
        try {
          await lock.query('BEGIN')
          await lock.query("SELECT kind FROM issue_dictionary_sets WHERE kind='status' FOR UPDATE")
          let finished = false
          const pending = (writer === 'issue' ? createIssue({ status: entry.value })
            : call('/settings/notification-rules', { version: currentRules.version, rules: [rule(entry.value)] })).finally(() => { finished = true })
          await delay(100)
          assert.equal(finished, false)
          await updateDictionary(lock, 'status', dictionaryUpdateSchema.parse(body))
          await lock.query('COMMIT')
          assert.equal((await pending).status, 400)
          assert.equal((await pool.query('SELECT id FROM issues WHERE status=$1', [entry.value])).rowCount, 0)
          assert.equal((await pool.query("SELECT 1 FROM notification_rule_settings s CROSS JOIN LATERAL jsonb_array_elements(s.rules) r WHERE r->>'targetStatus'=$1", [entry.value])).rowCount, 0)
        } finally { await lock.query('ROLLBACK'); lock.release() }
      }
    })

    await t.test('issue and rule writers winning the lock make waiting deletions observe the new references', async () => {
      for (const writer of ['issue', 'rule'] as const) {
        const entry = await add('status')
        const body = await deletion('status', entry.value)
        const lock = await pool.connect()
        try {
          await lock.query('BEGIN')
          const current = await lockDictionaries(lock)
          if (writer === 'issue') {
            const priority = current.dictionaries.priority.find((item) => item.isDefault)!.value
            const environment = current.dictionaries.environment.find((item) => item.isDefault)!.value
            const key = 'LOCK-' + randomBytes(5).toString('hex')
            await lock.query(`INSERT INTO issues (id,issue_key,project_id,title,status,priority,environment,reporter_id,assignee_id,last_modified_by)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,$8)`, [randomUUID(), key, projectId, marker, entry.value, priority, environment, admin.id])
            ledger.issues.push(key)
          } else {
            const currentRules = await rulesData()
            await saveNotificationRuleSettings(lock, admin.id, notificationRulesUpdateSchema.parse({ version: currentRules.version, rules: [rule(entry.value, false)] }))
          }
          let finished = false
          const pending = call('/dictionaries/status', body).finally(() => { finished = true })
          await delay(100)
          assert.equal(finished, false)
          await lock.query('COMMIT')
          const response = await pending
          assert.equal(response.status, 400)
          assert.match(response.body.error, writer === 'issue' ? /1 条缺陷/ : /1 条通知规则/)
          assert.equal((await pool.query("SELECT value FROM issue_dictionary_entries WHERE kind='status' AND value=$1", [entry.value])).rowCount, 1)
        } finally { await lock.query('ROLLBACK'); lock.release() }
      }
    })
    t.diagnostic(JSON.stringify({ ...ledger, externalMessages: 0 }))
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
        assert.equal((await control.query('SELECT current_database() AS name')).rows[0].name, 'postgres')
        for (let attempt = 0; attempt < 20; attempt += 1) {
          const connections = (await control.query('SELECT COUNT(*)::int AS count FROM pg_stat_activity WHERE datname=$1', [databaseName])).rows[0].count
          if (connections === 0) break
          await delay(50)
        }
        assert.equal((await control.query('SELECT COUNT(*)::int AS count FROM pg_stat_activity WHERE datname=$1', [databaseName])).rows[0].count, 0, 'all fixture connections must close before dropping the temporary database')
        await control.query(`DROP DATABASE "${databaseName}"`)
        assert.equal((await control.query('SELECT datname FROM pg_database WHERE datname=$1', [databaseName])).rowCount, 0)
        t.diagnostic(JSON.stringify({ marker, databaseName, cleanup: 'passed', remaining: 0, configuredDatabaseUntouched: true }))
      }
    } finally { await control.end() }
  }
})
