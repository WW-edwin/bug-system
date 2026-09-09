import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

test('issue permissions distinguish administrators, creators, assignees and unrelated members', {
  skip: process.env.TRACEBUG_PERMISSIONS_TEST !== 'true', timeout: 75_000,
}, async (t) => {
  const { config } = await import('../server/config.js')
  assert.deepEqual([config.pgHost, config.pgPort, config.pgDatabase], ['127.0.0.1', 5434, 'tracebug_local'])
  assert.equal(process.env.DATABASE_URL, undefined)
  const saved = { ...config, dingtalk: { ...config.dingtalk } }
  const { Pool } = await import('pg')
  const control = new Pool({ host: config.pgHost, port: config.pgPort, database: 'postgres', user: config.pgUser, password: config.pgPassword })
  const database = 'tracebug_permissions_' + randomBytes(8).toString('hex')
  assert.match(database, /^tracebug_permissions_[a-f0-9]{16}$/)
  const marker = 'SELFTEST-' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14).replace(/^(\d{8})/, '$1-')
  const ledger = { marker, database, users: [] as string[], issues: [] as string[], projects: [] as string[], uploads: [] as string[] }
  let createdDatabase = false
  let fixture: import('pg').Pool | undefined
  let server: Server | undefined
  let uploads = ''
  const originalFetch = globalThis.fetch
  try {
    await control.query(`CREATE DATABASE "${database}"`)
    createdDatabase = true
    config.pgDatabase = database
    config.sessionCookieName = 'tb_sid_permissions_test'
    config.secureCookies = false
    config.dingtalk.enabled = false
    config.dingtalk.dryRun = true
    uploads = await mkdtemp(join(tmpdir(), 'tracebug-permissions-uploads-'))
    config.uploadsDir = uploads
    const { pool, initializeDatabase } = await import('../server/db.js')
    fixture = pool
    assert.equal((await pool.query('SELECT current_database() AS name')).rows[0].name, database)
    await initializeDatabase()
    const { attachUser, requireSameOrigin, createSession, sessionCookieName } = await import('../server/auth.js')
    const { hashPassword } = await import('../server/password.js')
    const { default: workspaceRoutes } = await import('../server/workspaceRoutes.js')
    const { default: settingsRoutes } = await import('../server/notificationRuleRoutes.js')
    const { default: express } = await import('express')
    const { default: cookieParser } = await import('cookie-parser')
    const app = express()
    app.use(express.json(), cookieParser(), requireSameOrigin, attachUser)
    app.use('/api/settings/notification-rules', settingsRoutes)
    app.use('/api', workspaceRoutes)
    app.use((error: unknown, _req: unknown, res: import('express').Response, _next: unknown) => {
      res.status(Number((error as { status?: number })?.status ?? 500)).json({ error: error instanceof Error ? error.message : 'error' })
    })
    server = app.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port
    config.publicOrigin = config.publicAppOrigin = base
    globalThis.fetch = (input, init) => {
      assert.equal(new URL(input instanceof Request ? input.url : String(input)).origin, base, 'real DingTalk and other external requests are forbidden')
      return originalFetch(input, init)
    }
    async function call(path: string, cookie?: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') {
      const response = await fetch(base + '/api' + path, { method, headers: {
        Origin: base, ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) })
      return { status: response.status, body: await response.json() }
    }
    async function user(name: string, role: 'admin' | 'member', pending = false) {
      const id = randomUUID()
      await pool.query('INSERT INTO app_users (id,display_name,email,password_hash,role,password_setup_required) VALUES ($1,$2,$3,$4,$5,$6)',
        [id, name, marker + '-' + id.slice(0, 6) + '@example.invalid', await hashPassword(randomBytes(24).toString('hex')), role, pending])
      ledger.users.push(id)
      return { id, name, cookie: sessionCookieName + '=' + (await createSession(id)).token }
    }
    const admin = await user('权限探针管理员', 'admin')
    const creator = await user('权限探针创建人', 'member')
    const assignee = await user('权限探针负责人', 'member')
    const unrelated = await user('权限探针无关人', 'member')
    const pendingAdmin = await user('权限探针待设密管理', 'admin', true)
    const project = await call('/projects', creator.cookie, { key: 'PERM', name: marker })
    assert.equal(project.status, 201)
    const projectId = project.body.project.id as string
    ledger.projects.push(projectId)
    async function issue(reporter = creator, owners = [assignee.id], description = '<p>原始内容</p>') {
      const response = await call('/projects/' + projectId + '/issues', reporter.cookie, { title: marker, description, assigneeIds: owners })
      assert.equal(response.status, 201, JSON.stringify(response.body))
      const key = response.body.issue.id as string
      const id = (await pool.query('SELECT id FROM issues WHERE issue_key=$1', [key])).rows[0].id as string
      ledger.issues.push(id)
      return { key, id }
    }
    async function snapshot(ids: string[]) {
      return {
        issues: (await pool.query('SELECT * FROM issues WHERE id=ANY($1::uuid[]) ORDER BY id', [ids])).rows,
        owners: (await pool.query('SELECT * FROM issue_assignees WHERE issue_id=ANY($1::uuid[]) ORDER BY issue_id,user_id', [ids])).rows,
        activities: (await pool.query('SELECT * FROM issue_activities WHERE issue_id=ANY($1::uuid[]) ORDER BY id', [ids])).rows,
        notifications: (await pool.query('SELECT * FROM notification_outbox WHERE aggregate_id=ANY($1::uuid[]) ORDER BY id', [ids])).rows,
      }
    }
    const allFields = { title: marker + '-改', description: '<p>新的问题描述</p>', status: '处理中', priority: 'P2',
      module: '权限验收模块', environment: '正式环境', assigneeIds: [assignee.id, unrelated.id] }

    await t.test('administrators, creators and assignees may edit every editable field; unrelated members cannot', async () => {
      for (const actor of [admin, creator, assignee]) {
        const target = await issue()
        assert.notEqual(admin.id, creator.id)
        assert.notEqual(admin.id, assignee.id)
        const response = await call('/issues/' + target.key, actor.cookie, allFields, 'PATCH')
        assert.equal(response.status, 200, actor.name)
        const stored = (await pool.query('SELECT * FROM issues WHERE id=$1', [target.id])).rows[0]
        for (const field of ['title', 'description', 'status', 'priority', 'module', 'environment'] as const) assert.equal(stored[field], allFields[field])
        assert.equal(stored.reporter_id, creator.id)
        assert.equal(stored.last_modified_by, actor.id)
        assert.deepEqual((await pool.query('SELECT user_id FROM issue_assignees WHERE issue_id=$1 ORDER BY position', [target.id])).rows.map((row) => row.user_id), allFields.assigneeIds)
      }
      const target = await issue()
      const before = await snapshot([target.id])
      assert.equal((await call('/issues/' + target.key, unrelated.cookie, allFields, 'PATCH')).status, 403)
      assert.deepEqual(await snapshot([target.id]), before)
      assert.equal((await call('/issues/' + target.key, unrelated.cookie, { status: '待处理' }, 'PATCH')).status, 403, 'unchanged saves do not bypass edit authorization')
    })

    await t.test('single-status and batch-status edits follow the same four-role policy', async () => {
      for (const actor of [admin, creator, assignee, unrelated]) {
        const first = await issue()
        const second = await issue()
        const allowed = actor !== unrelated
        const single = await call('/issues/' + first.key, actor.cookie, { status: '处理中' }, 'PATCH')
        assert.equal(single.status, allowed ? 200 : 403, actor.name)
        const batch = await call('/issues/batch/status', actor.cookie, { issueIds: [first.key, second.key], status: '待复测' }, 'PATCH')
        assert.equal(batch.status, allowed ? 200 : 403, actor.name)
        if (allowed) {
          assert.equal(batch.body.updatedCount, 2)
          assert.ok(batch.body.issues.every((item: { status: string }) => item.status === '待复测'))
        } else assert.ok((await snapshot([first.id, second.id])).issues.every((row) => row.status === '待处理'))
      }
    })

    await t.test('a batch containing an unauthorized issue is rejected atomically for an ordinary member', async () => {
      const own = await issue()
      const forbidden = await issue(unrelated, [assignee.id])
      const before = await snapshot([own.id, forbidden.id])
      assert.equal((await call('/issues/batch/status', creator.cookie, { issueIds: [own.key, forbidden.key], status: '处理中' }, 'PATCH')).status, 403)
      assert.deepEqual(await snapshot([own.id, forbidden.id]), before)
      const override = await call('/issues/batch/status', admin.cookie, { issueIds: [own.key, forbidden.key], status: '处理中' }, 'PATCH')
      assert.equal(override.status, 200)
      assert.equal(override.body.updatedCount, 2)
    })

    await t.test('assignees and unrelated members cannot delete or remove attached evidence and comments', async () => {
      async function upload(label: string) {
        const form = new FormData()
        form.set('file', new Blob([marker + '-' + label], { type: 'text/plain' }), label + '.txt')
        const response = await fetch(base + '/api/uploads', { method: 'POST', headers: { Origin: base, Cookie: creator.cookie }, body: form })
        assert.equal(response.status, 201)
        const file = await response.json()
        const path = join(uploads, basename(file.url))
        ledger.uploads.push(path)
        return { ...file, path }
      }
      const attached = await upload('issue-proof')
      const commented = await upload('comment-proof')
      const target = await issue(creator, [assignee.id], `<p><a href="${attached.url}" data-attachment="true">附件</a></p>`)
      assert.equal((await call('/issues/' + target.key + '/comments', assignee.cookie, { comment: `<p><a href="${commented.url}" data-attachment="true">评论附件</a></p>` })).status, 201)
      const before = await snapshot([target.id])
      const beforeFiles = await Promise.all([readFile(attached.path, 'utf8'), readFile(commented.path, 'utf8')])
      for (const actor of [assignee, unrelated]) {
        assert.equal((await call('/issues/' + target.key, actor.cookie, undefined, 'DELETE')).status, 403, actor.name)
        assert.deepEqual(await snapshot([target.id]), before)
        assert.deepEqual(await Promise.all([readFile(attached.path, 'utf8'), readFile(commented.path, 'utf8')]), beforeFiles)
      }
      assert.equal((await call('/issues/' + target.key, creator.cookie, undefined, 'DELETE')).status, 200)
      assert.equal((await pool.query('SELECT id FROM issues WHERE id=$1', [target.id])).rowCount, 0)
      assert.equal((await pool.query('SELECT id FROM issue_activities WHERE issue_id=$1', [target.id])).rowCount, 0)
      for (const path of [attached.path, commented.path]) await assert.rejects(access(path), (error: unknown) => (error as { code?: string }).code === 'ENOENT')
    })

    await t.test('administrators may delete another creator’s issue without being assigned', async () => {
      const target = await issue()
      assert.equal((await call('/issues/' + target.key, admin.cookie, undefined, 'DELETE')).status, 200)
      assert.equal((await pool.query('SELECT id FROM issues WHERE id=$1', [target.id])).rowCount, 0)
      assert.equal((await call('/issues/' + target.key, admin.cookie, undefined, 'DELETE')).status, 404)
    })

    await t.test('anonymous and pending-password sessions cannot use any issue mutation privilege', async () => {
      const deniedCreate = await call('/projects/' + projectId + '/issues', pendingAdmin.cookie, { title: marker, assigneeIds: [pendingAdmin.id] })
      assert.equal(deniedCreate.status, 403)
      assert.equal(deniedCreate.body.code, 'PASSWORD_SETUP_REQUIRED')
      const existing = await issue()
      const before = await snapshot([existing.id])
      for (const [cookie, expected] of [[undefined, 401], [pendingAdmin.cookie, 403]] as const) {
        const responses = [
          await call('/issues/' + existing.key, cookie, allFields, 'PATCH'),
          await call('/issues/batch/status', cookie, { issueIds: [existing.key], status: '处理中' }, 'PATCH'),
          await call('/issues/' + existing.key, cookie, undefined, 'DELETE'),
        ]
        for (const response of responses) {
          assert.equal(response.status, expected)
          if (expected === 403) assert.equal(response.body.code, 'PASSWORD_SETUP_REQUIRED')
        }
      }
      assert.deepEqual(await snapshot([existing.id]), before)
    })

    await t.test('administrator status edits still create the configured notification events once', async () => {
      const target = await issue()
      const second = await issue()
      const settings = await call('/settings/notification-rules', admin.cookie)
      assert.equal(settings.status, 200)
      const savedRules = await call('/settings/notification-rules', admin.cookie, { version: settings.body.version, rules: [
        { id: randomUUID(), name: marker, enabled: true, trigger: 'status_changed', targetStatus: '处理中', recipients: ['reporter', 'assignee'] },
      ] }, 'PUT')
      assert.equal(savedRules.status, 200)
      config.dingtalk.enabled = true
      try {
        assert.equal((await call('/issues/' + target.key, admin.cookie, { status: '处理中' }, 'PATCH')).status, 200)
        const firstEvent = (await pool.query('SELECT * FROM notification_outbox WHERE aggregate_id=$1', [target.id])).rows
        assert.equal(firstEvent.length, 1)
        assert.equal(firstEvent[0].payload.updatedBy, admin.name)
        const deliveryIds = (await pool.query('SELECT app_user_id FROM notification_deliveries WHERE outbox_id=$1 ORDER BY app_user_id', [firstEvent[0].id])).rows.map((row) => row.app_user_id)
        assert.deepEqual(deliveryIds, [creator.id, assignee.id].sort())
        assert.equal(deliveryIds.includes(admin.id), false, 'administrator acting on an issue is not automatically added as recipient')
        const batch = await call('/issues/batch/status', admin.cookie, { issueIds: [target.key, second.key], status: '处理中' }, 'PATCH')
        assert.equal(batch.status, 200)
        assert.equal(batch.body.updatedCount, 1)
        assert.equal((await pool.query('SELECT id FROM notification_outbox WHERE aggregate_id=ANY($1::uuid[])', [[target.id, second.id]])).rowCount, 2)
      } finally { config.dingtalk.enabled = false }
    })
    t.diagnostic(JSON.stringify({ ...ledger, externalMessages: 0 }))
  } finally {
    if (server) { server.closeAllConnections(); await new Promise<void>((resolve) => server!.close(() => resolve())) }
    globalThis.fetch = originalFetch
    if (fixture) await fixture.end()
    Object.assign(config, saved)
    try {
      if (createdDatabase) {
        for (let attempt = 0; attempt < 20; attempt += 1) {
          if ((await control.query('SELECT COUNT(*)::int AS count FROM pg_stat_activity WHERE datname=$1', [database])).rows[0].count === 0) break
          await delay(50)
        }
        await control.query(`DROP DATABASE "${database}"`)
        assert.equal((await control.query('SELECT datname FROM pg_database WHERE datname=$1', [database])).rowCount, 0)
      }
      if (uploads) { await rm(uploads, { recursive: true, force: true }); await assert.rejects(access(uploads)) }
      t.diagnostic(JSON.stringify({ marker, database, cleanup: 'passed', remainingDatabases: 0, remainingUploads: 0, configuredDatabaseUntouched: true }))
    } finally { await control.end() }
  }
})
