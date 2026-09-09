import 'dotenv/config'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { Pool } from 'pg'
import type { DictionaryData, DictionaryEntry, DictionaryKind } from '../server/dictionaries.js'
import { schemaSql } from '../server/schema.js'

// Runs only against a newly created disposable loopback database; never touches the configured database.
const host = process.env.PGHOST ?? '127.0.0.1'
assert.ok(['127.0.0.1', 'localhost', '::1'].includes(host), 'Integration tests require a local PostgreSQL host')
assert.ok(!process.env.DATABASE_URL, 'Unset DATABASE_URL to avoid using a non-local database')
const databaseName = `tracebug_dictionary_api_${Date.now()}_${process.pid}`
assert.match(databaseName, /^tracebug_dictionary_api_\d+_\d+$/)
const connection = { host, port: Number(process.env.PGPORT ?? 5433), user: process.env.PGUSER ?? 'tracebug', password: process.env.PGPASSWORD ?? process.env.POSTGRES_PASSWORD }
const control = new Pool({ ...connection, database: 'postgres' })
const fixture = new Pool({ ...connection, database: databaseName })
const marker = `SELFTEST-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`
const port = 3192
const baseUrl = `http://127.0.0.1:${port}`
let processHandle: ChildProcess | undefined
let output = ''
let databaseCreated = false
let assertions = 0

async function startApi() {
  output = ''
  processHandle = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: process.cwd(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DATABASE_URL: '', PGDATABASE: databaseName, PORT: String(port), NODE_ENV: 'development', COOKIE_SECURE: 'false', UPLOAD_DIR: 'local-data/uploads' },
  })
  processHandle.stdout?.on('data', (data) => { output += data.toString() })
  processHandle.stderr?.on('data', (data) => { output += data.toString() })
  for (let attempt = 0; attempt < 80; attempt++) {
    if (processHandle.exitCode !== null) throw new Error(`Fixture API exited: ${output}`)
    if (output.includes(`TraceBug server listening on http://0.0.0.0:${port}`)) return
    await delay(100)
  }
  throw new Error(`Fixture API did not start: ${output}`)
}

async function stopApi() {
  if (processHandle && processHandle.exitCode === null) {
    const exited = once(processHandle, 'exit')
    processHandle.kill()
    await Promise.race([exited, delay(12_000).then(() => { processHandle?.kill('SIGKILL') })])
  }
  processHandle = undefined
}

async function call(path: string, { method = 'GET', cookie = '', body, status = 200 }: { method?: string; cookie?: string; body?: unknown; status?: number } = {}) {
  const response = await fetch(baseUrl + '/api' + path, {
    method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const data = await response.json() as any
  assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(data)}`)
  assertions++
  return { data, cookie: response.headers.get('set-cookie')?.split(';')[0] ?? '' }
}

async function register(name: string, suffix: string) {
  return call('/auth/register', { method: 'POST', status: 201, body: { name, email: `${marker}-${suffix}@${process.env.COMPANY_EMAIL_DOMAIN ?? 'kando.com.cn'}`, password: `fixture-${randomUUID()}` } })
}

function items(data: DictionaryData, kind: DictionaryKind) {
  return data.dictionaries[kind].map(({ value, label, active, isDefault, isTerminal, weight, showInPersonal }) => ({ value, label, active, isDefault, isTerminal, weight, showInPersonal }))
}

type UpdateItem = Omit<DictionaryEntry, 'position' | 'value' | 'weight' | 'showInPersonal'> & {
  value?: string
  weight?: number
  showInPersonal?: boolean
}

try {
  await control.query(`CREATE DATABASE "${databaseName}"`)
  databaseCreated = true
  // Seed the previous production schema, including one old status and a free-text environment.
  const dictionaryMigrationStart = schemaSql.indexOf('ALTER TABLE issues DROP CONSTRAINT IF EXISTS issues_status_check;')
  assert.ok(dictionaryMigrationStart > 0, 'Unable to locate dictionary migration')
  const previousSchema = schemaSql.slice(0, dictionaryMigrationStart)
  await fixture.query(previousSchema)
  await fixture.query(`ALTER TABLE issues ALTER COLUMN status TYPE VARCHAR(16);
    ALTER TABLE issues ALTER COLUMN priority TYPE CHAR(2);
    ALTER TABLE issues ADD CONSTRAINT issues_status_check CHECK(status IN ('待处理','处理中','待验证','已修复'));
    ALTER TABLE issues ADD CONSTRAINT issues_priority_check CHECK(priority IN ('P0','P1','P2','P3'));`)
  const legacyUser = randomUUID()
  const legacyProject = randomUUID()
  const legacyIssue = randomUUID()
  const longLegacyEnvironment = `  ${'历史环境名称'.repeat(10)}  `
  await fixture.query('INSERT INTO app_users(id,display_name) VALUES($1,$2)', [legacyUser, '历史自测人员'])
  await fixture.query('INSERT INTO projects(id,project_key,name,color,created_by) VALUES($1,$2,$3,$4,$5)', [legacyProject, 'HIST', marker, '#3367a8', legacyUser])
  await fixture.query("INSERT INTO issues(id,issue_key,project_id,title,status,priority,environment,reporter_id,assignee_id,last_modified_by) VALUES($1,'HIST-0001-001',$2,$3,'待验证','P1','历史部署',$4,$4,$4)", [legacyIssue, legacyProject, marker, legacyUser])
  await fixture.query("INSERT INTO issues(id,issue_key,project_id,title,status,priority,environment,reporter_id,assignee_id,last_modified_by) VALUES($1,'HIST-0001-002',$2,$3,'待处理','P1',$4,$5,$5,$5)", [randomUUID(), legacyProject, marker, longLegacyEnvironment, legacyUser])
  await fixture.query("INSERT INTO issue_activities(id,issue_id,actor_id,action,detail,kind) VALUES($1,$2,$3,'更新了状态','待处理 → 待验证','changed')", [randomUUID(), legacyIssue, legacyUser])
  // First reach the f592852 production schema, then customize its dictionary settings.
  // The new migration must retain that exact configured order and every pre-existing field.
  const weightsMigrationStart = schemaSql.indexOf('-- Dictionary weights and personal visibility are initialized once')
  assert.ok(weightsMigrationStart > dictionaryMigrationStart, 'Unable to locate weights migration')
  await fixture.query(schemaSql.slice(0, weightsMigrationStart))
  await fixture.query(`UPDATE issue_dictionary_entries SET position = CASE value WHEN 'P3' THEN 0 WHEN 'P0' THEN 8 WHEN 'P1' THEN 8 ELSE 30 END,
    label = CASE value WHEN 'P3' THEN '迁移前低级别' ELSE label END WHERE kind = 'priority';
    UPDATE issue_dictionary_sets SET version = CASE kind WHEN 'status' THEN 7 WHEN 'priority' THEN 12 ELSE 3 END;`)
  const configuredEntries = (await fixture.query('SELECT * FROM issue_dictionary_entries ORDER BY kind, position, value')).rows
  const configuredVersions = (await fixture.query('SELECT kind, version FROM issue_dictionary_sets ORDER BY kind')).rows
  const issuesBeforeMigration = (await fixture.query('SELECT * FROM issues ORDER BY id')).rows
  const activitiesBeforeMigration = (await fixture.query('SELECT * FROM issue_activities ORDER BY id')).rows
  await startApi()
  const migratedEntries = (await fixture.query('SELECT * FROM issue_dictionary_entries ORDER BY kind, weight DESC, position, value')).rows
  assert.deepEqual(migratedEntries.map(({ weight: _weight, show_in_personal: _show, ...entry }) => entry), configuredEntries, 'Weight migration preserves configured labels, flags, positions and ordering')
  for (const entry of migratedEntries) {
    assert.ok(Number.isInteger(entry.weight) && entry.weight >= 0 && entry.weight <= 999999)
    assert.equal(entry.show_in_personal, entry.kind === 'status' && !entry.is_terminal)
  }
  assert.deepEqual((await fixture.query('SELECT kind, version FROM issue_dictionary_sets ORDER BY kind')).rows, configuredVersions.map((entry) => ({ ...entry, version: entry.version + 1 })), 'Migration invalidates each optimistic version exactly once')
  assert.deepEqual((await fixture.query('SELECT * FROM issues ORDER BY id')).rows, issuesBeforeMigration)
  assert.deepEqual((await fixture.query('SELECT * FROM issue_activities ORDER BY id')).rows, activitiesBeforeMigration)
  assert.equal((await fixture.query("SELECT COUNT(*)::integer AS count FROM app_migrations WHERE name = 'issue-dictionary-weights-v1'")).rows[0].count, 1)
  await call('/dictionaries', { status: 401 })
  await call('/dictionaries/status', { method: 'PUT', body: {}, status: 401 })
  const admin = await register('字典测试管理', 'admin')
  const member = await register('字典测试成员', 'member')
  const outsider = await register('字典测试其他', 'outsider')
  assert.equal(admin.data.user.role, 'admin')
  assert.equal(member.data.user.role, 'member')
  let data = (await call('/dictionaries', { cookie: admin.cookie })).data as DictionaryData
  const workspace = (await call('/workspace', { cookie: member.cookie })).data
  assert.deepEqual(workspace.dictionaries, data.dictionaries)
  assert.deepEqual(workspace.dictionaryVersions, data.dictionaryVersions)
  const migratedIssue = workspace.projects[0].issues.find((issue: any) => issue.id === 'HIST-0001-001')
  assert.equal(migratedIssue.status, '待复测')
  assert.equal(migratedIssue.activities[0].detail, '待处理 → 待复测')
  assert.equal(data.dictionaries.environment.find((entry) => entry.value === '历史部署')?.active, false)
  assert.equal(data.dictionaries.status.filter((entry) => entry.isTerminal).length, 3)
  assert.equal(data.dictionaries.status.find((entry) => entry.isDefault)?.value, '待处理')
  assert.equal(data.dictionaries.priority.find((entry) => entry.isDefault)?.value, 'P1')
  assert.equal(data.dictionaries.environment.find((entry) => entry.isDefault)?.value, '测试环境')

  async function put(kind: DictionaryKind, nextItems: UpdateItem[], status = 200, cookie = admin.cookie, version = data.dictionaryVersions[kind]) {
    const result = await call(`/dictionaries/${kind}`, { method: 'PUT', cookie, body: { version, items: nextItems }, status })
    if (status === 200) data = result.data
    return result.data
  }

  await put('status', items(data, 'status'), 403, member.cookie)
  await call('/dictionaries/unknown', { method: 'PUT', cookie: admin.cookie, body: {}, status: 400 })
  await put('status', items(data, 'status').slice(1), 400)
  await put('status', [...items(data, 'status'), { value: 'unknown', label: '未知', active: true, isDefault: false, isTerminal: false }], 400)
  await put('status', items(data, 'status').map((entry) => ({ ...entry, isDefault: false })), 400)
  await put('status', items(data, 'status').map((entry) => ({ ...entry, active: false })), 400)
  await put('status', items(data, 'status').map((entry) => ({ ...entry, isTerminal: true })), 400)
  await put('priority', [...items(data, 'priority'), { label: ' p1 ', active: true, isDefault: false, isTerminal: false }], 400)
  await put('priority', [...items(data, 'priority'), { label: 'x'.repeat(41), active: true, isDefault: false, isTerminal: false }], 400)
  await put('environment', items(data, 'environment').map((entry) => ({ ...entry, isTerminal: true })), 400)
  for (const kind of ['priority', 'environment'] as const) {
    await put(kind, items(data, kind).map((entry) => ({ ...entry, showInPersonal: true })), 400)
  }
  for (const weight of [null, '20', 0.5, -1, 1000000]) {
    await call('/dictionaries/status', { method: 'PUT', cookie: admin.cookie, body: { version: data.dictionaryVersions.status, items: items(data, 'status').map((entry, index) => index === 0 ? { ...entry, weight } : entry) }, status: 400 })
  }
  for (const showInPersonal of [null, 'true', 1]) {
    await call('/dictionaries/status', { method: 'PUT', cookie: admin.cookie, body: { version: data.dictionaryVersions.status, items: items(data, 'status').map((entry, index) => index === 0 ? { ...entry, showInPersonal } : entry) }, status: 400 })
  }
  await put('status', [items(data, 'status')[0], ...items(data, 'status')], 400)
  await put('status', [...items(data, 'status'), ...Array.from({ length: 95 }, (_, index) => ({ label: `超过上限${index}`, active: true, isDefault: false, isTerminal: false }))], 400)
  const beforeRejected = (await call('/dictionaries', { cookie: admin.cookie })).data
  assert.deepEqual(beforeRejected, data, 'Rejected updates must be atomic')

  // Status visibility is independent from completed, active and default flags.
  await put('status', items(data, 'status').map((entry) => ({ ...entry, showInPersonal: ['已修复', '不适用'].includes(entry.value), active: entry.value === '不适用' ? false : entry.active })))
  assert.equal(data.dictionaries.status.find((entry) => entry.isDefault)?.showInPersonal, false, 'A default status may be hidden from personal issues')
  assert.equal(data.dictionaries.status.find((entry) => entry.value === '已修复')?.showInPersonal, true, 'A terminal status may appear in personal issues')
  assert.equal(data.dictionaries.status.find((entry) => entry.value === '不适用')?.showInPersonal, true, 'An inactive status may appear for existing assigned issues')
  const visibilityBeforeLegacySave = data.dictionaries.status.map(({ value, showInPersonal }) => ({ value, showInPersonal }))
  await put('status', items(data, 'status').map(({ weight: _weight, showInPersonal: _show, ...entry }) => entry))
  assert.deepEqual(data.dictionaries.status.map(({ value, showInPersonal }) => ({ value, showInPersonal })), visibilityBeforeLegacySave, 'Old clients must not reset configured visibility')

  await put('priority', [...items(data, 'priority').map((entry) => ({ ...entry, label: entry.value === 'P1' ? '高优先级' : entry.label, isDefault: false })), { label: '  紧急处理  ', active: true, isDefault: true, isTerminal: false, weight: 999999 }].reverse())
  const priorityKey = data.dictionaries.priority.find((entry) => entry.label === '紧急处理')!.value
  assert.match(priorityKey, /^[0-9a-f-]{36}$/)
  assert.equal(data.dictionaries.priority[0].value, priorityKey)
  assert.equal(data.dictionaries.priority[0].weight, 999999)
  const weightedPriorityOrder = data.dictionaries.priority.map(({ value, weight }) => ({ value, weight }))
  await put('priority', items(data, 'priority').map(({ weight: _weight, showInPersonal: _show, ...entry }) => entry).reverse())
  assert.deepEqual(data.dictionaries.priority.map(({ value, weight }) => ({ value, weight })), weightedPriorityOrder, 'Legacy reordering cannot replace explicitly configured weights')
  // Equal weights retain submitted position as a deterministic dictionary menu fallback.
  const reversedEnvironmentOrder = data.dictionaries.environment.map((entry) => entry.value).reverse()
  await put('environment', items(data, 'environment').map((entry) => ({ ...entry, weight: 0 })).reverse())
  assert.ok(data.dictionaries.environment.every((entry) => entry.weight === 0 && entry.showInPersonal === false))
  assert.deepEqual(data.dictionaries.environment.map((entry) => entry.value), reversedEnvironmentOrder)
  await put('status', [...items(data, 'status').map((entry) => ({ ...entry, isDefault: false })), { label: '待优化', active: true, isDefault: true, isTerminal: false }, { label: '完成验收', active: true, isDefault: false, isTerminal: true }])
  const statusKey = data.dictionaries.status.find((entry) => entry.label === '待优化')!.value
  const terminalKey = data.dictionaries.status.find((entry) => entry.label === '完成验收')!.value
  assert.equal(data.dictionaries.status.find((entry) => entry.value === statusKey)?.weight, 0, 'Old clients can add entries with safe default weight')
  assert.equal(data.dictionaries.status.find((entry) => entry.value === statusKey)?.showInPersonal, true, 'Legacy new nonterminal status retains personal visibility')
  assert.equal(data.dictionaries.status.find((entry) => entry.value === terminalKey)?.showInPersonal, false, 'Legacy new terminal status retains hidden visibility')
  await put('environment', [...items(data, 'environment').map((entry) => ({ ...entry, isDefault: false })), { label: '预发布环境', active: true, isDefault: true, isTerminal: false }])
  const environmentKey = data.dictionaries.environment.find((entry) => entry.label === '预发布环境')!.value
  assert.equal(data.dictionaries.environment.find((entry) => entry.value === longLegacyEnvironment)?.label, longLegacyEnvironment, 'Unchanged historical labels retain whitespace and full length')
  const oldVersion = data.dictionaryVersions.priority
  await put('priority', items(data, 'priority'))
  await put('priority', items(data, 'priority'), 409, admin.cookie, oldVersion)
  const competingBody = { version: data.dictionaryVersions.priority, items: items(data, 'priority') }
  const competing = await Promise.all([1, 2].map(() => fetch(baseUrl + '/api/dictionaries/priority', { method: 'PUT', headers: { Cookie: admin.cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(competingBody) })))
  assert.deepEqual(competing.map((response) => response.status).sort(), [200, 409])
  data = (await call('/dictionaries', { cookie: admin.cookie })).data

  const project = (await call('/projects', { method: 'POST', cookie: member.cookie, body: { name: marker, key: 'DICT' }, status: 201 })).data.project
  const createBody = { title: marker, assigneeIds: [member.data.user.id] }
  const first = (await call(`/projects/${project.id}/issues`, { method: 'POST', cookie: member.cookie, body: createBody, status: 201 })).data.issue
  assert.equal(first.status, statusKey)
  assert.equal(first.priority, priorityKey)
  assert.equal(first.environment, environmentKey)
  assert.ok(first.activities[0].detail.includes('紧急处理'))
  assert.ok(!first.activities[0].detail.includes(priorityKey))
  await call(`/projects/${project.id}/issues`, { method: 'POST', cookie: member.cookie, body: { ...createBody, environment: '历史部署' }, status: 400 })
  await call(`/projects/${project.id}/issues`, { method: 'POST', cookie: member.cookie, body: { ...createBody, status: 'unknown' }, status: 400 })
  const second = (await call(`/projects/${project.id}/issues`, { method: 'POST', cookie: member.cookie, body: { ...createBody, status: '待处理', priority: 'P1', environment: '测试环境' }, status: 201 })).data.issue
  await call(`/issues/${first.id}`, { method: 'PATCH', cookie: outsider.cookie, body: { status: terminalKey }, status: 403 })
  await call('/issues/batch/status', { method: 'PATCH', cookie: outsider.cookie, body: { issueIds: [first.id], status: terminalKey }, status: 403 })
  const administratorBatch = (await call('/issues/batch/status', { method: 'PATCH', cookie: admin.cookie, body: { issueIds: [first.id], status: terminalKey } })).data
  assert.equal(administratorBatch.updatedCount, 1)
  await call(`/issues/${first.id}`, { method: 'PATCH', cookie: admin.cookie, body: { status: statusKey } })
  const changed = (await call(`/issues/${second.id}`, { method: 'PATCH', cookie: member.cookie, body: { priority: priorityKey, environment: environmentKey } })).data.issue
  assert.equal(changed.environment, environmentKey)
  assert.ok(changed.activities.some((activity: any) => activity.action === '更新了环境' && activity.detail === '测试环境 → 预发布环境'))
  assert.ok(changed.activities.some((activity: any) => activity.action === '更新了优先级' && activity.detail === '高优先级 → 紧急处理'))
  const batch = (await call('/issues/batch/status', { method: 'PATCH', cookie: member.cookie, body: { issueIds: [first.id, second.id], status: terminalKey } })).data
  assert.equal(batch.updatedCount, 2)
  assert.ok(batch.issues.every((issue: any) => issue.status === terminalKey))
  assert.ok(batch.issues[0].activities.some((activity: any) => activity.detail === '待优化 → 完成验收'))

  const beforeRename = await fixture.query('SELECT i.*, (SELECT COUNT(*) FROM issue_activities a WHERE a.issue_id=i.id)::integer AS activity_count FROM issues i WHERE issue_key=$1', [first.id])
  await put('priority', items(data, 'priority').map((entry) => ({ ...entry, label: entry.value === priorityKey ? '最高优先级' : entry.label })))
  const afterRename = await fixture.query('SELECT i.*, (SELECT COUNT(*) FROM issue_activities a WHERE a.issue_id=i.id)::integer AS activity_count FROM issues i WHERE issue_key=$1', [first.id])
  assert.deepEqual(afterRename.rows, beforeRename.rows, 'Dictionary rename must not mutate stored issue or activities')
  for (const kind of ['status', 'priority', 'environment'] as const) {
    const disabledKey = { status: terminalKey, priority: priorityKey, environment: environmentKey }[kind]
    const fallbackKey = { status: '待处理', priority: 'P1', environment: '测试环境' }[kind]
    await put(kind, items(data, kind).map((entry) => ({ ...entry, active: entry.value === disabledKey ? false : entry.active, isDefault: entry.value === fallbackKey })))
  }
  await call(`/issues/${first.id}`, { method: 'PATCH', cookie: member.cookie, body: { title: marker + '-编辑', status: terminalKey, priority: priorityKey, environment: environmentKey } })
  await call('/issues/batch/status', { method: 'PATCH', cookie: member.cookie, body: { issueIds: [first.id], status: terminalKey }, status: 400 })
  const third = (await call(`/projects/${project.id}/issues`, { method: 'POST', cookie: member.cookie, body: createBody, status: 201 })).data.issue
  assert.equal(third.status, '待处理')
  assert.equal(third.priority, 'P1')
  assert.equal(third.environment, '测试环境')
  for (const [kind, value] of Object.entries({ status: terminalKey, priority: priorityKey, environment: environmentKey })) {
    await call(`/issues/${third.id}`, { method: 'PATCH', cookie: member.cookie, body: { [kind]: value }, status: 400 })
    await call(`/projects/${project.id}/issues`, { method: 'POST', cookie: member.cookie, body: { ...createBody, [kind]: value }, status: 400 })
  }

  // Verify locks serialize dictionary disable and issue changes, avoiding acceptance of stale values.
  const lockingClient = await fixture.connect()
  try {
    await lockingClient.query('BEGIN')
    await lockingClient.query("SELECT kind FROM issue_dictionary_sets WHERE kind='status' FOR UPDATE")
    let pendingFinished = false
    const pending = call(`/issues/${third.id}`, { method: 'PATCH', cookie: member.cookie, body: { status: '处理中' }, status: 400 }).finally(() => { pendingFinished = true })
    await delay(150)
    assert.equal(pendingFinished, false, 'Issue update should wait for dictionary lock')
    await lockingClient.query("UPDATE issue_dictionary_entries SET active=FALSE WHERE kind='status' AND value='处理中'")
    await lockingClient.query('COMMIT')
    await pending
  } finally {
    await lockingClient.query('ROLLBACK')
    lockingClient.release()
  }

  const dictionariesBeforeRestart = (await call('/dictionaries', { cookie: admin.cookie })).data
  // New labels resembling legacy statuses must not be rewritten at each startup.
  await stopApi()
  await startApi()
  const dictionariesAfterRestart = (await call('/dictionaries', { cookie: admin.cookie })).data
  assert.deepEqual(dictionariesAfterRestart, dictionariesBeforeRestart)
  assert.equal(dictionariesAfterRestart.dictionaries.status.find((entry: DictionaryEntry) => entry.value === statusKey).label, '待优化')
  const persisted = (await call('/workspace', { cookie: member.cookie })).data.projects.find((entry: any) => entry.id === project.id).issues.find((entry: any) => entry.id === first.id)
  assert.equal(persisted.priority, priorityKey)
  assert.equal(persisted.status, terminalKey)
  assert.equal(persisted.environment, environmentKey)
  // A migrated installation can contain over 100 old free-text environments. Editing
  // remains possible while growth beyond the existing count is rejected.
  await fixture.query(`INSERT INTO issue_dictionary_entries(kind,value,label,active,is_default,is_terminal,position)
    SELECT 'environment', '历史扩展-' || n, '历史扩展-' || n, FALSE, FALSE, FALSE, 200+n
    FROM generate_series(1,101) AS n`)
  data = (await call('/dictionaries', { cookie: admin.cookie })).data
  const oversizedCount = data.dictionaries.environment.length
  assert.ok(oversizedCount > 100)
  await put('environment', items(data, 'environment').map((entry) => ({ ...entry, label: entry.value === '测试环境' ? '  本地回归环境  ' : entry.label })))
  assert.equal(data.dictionaries.environment.find((entry) => entry.value === '测试环境')?.label, '本地回归环境')
  assert.equal(data.dictionaries.environment.find((entry) => entry.value === longLegacyEnvironment)?.label, longLegacyEnvironment)
  await put('environment', [...items(data, 'environment'), { label: '超过历史容量', active: true, isDefault: false, isTerminal: false }], 400)
  assert.equal(data.dictionaries.environment.length, oversizedCount)
  console.log(JSON.stringify({ result: 'passed', requestsChecked: assertions, coverage: ['baseline and f592852 weight migration preserve configured data/order/history', 'one-time version invalidation', 'admin authorization', 'weight boundaries/type validation and atomicity', 'independent terminal/inactive/default personal visibility', 'legacy-client weight/visibility preservation', 'weighted ordering and deterministic ties', 'rename/defaults', 'optimistic concurrency', 'dynamic issue create/edit/batch', 'disabled values and historical editing', 'dictionary versus issue locking', 'weight and visibility restart persistence', 'oversized historical dictionaries and exact legacy labels'] }))
} finally {
  await stopApi()
  await fixture.end()
  if (databaseCreated) {
    await control.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`)
    const leftovers = await control.query('SELECT datname FROM pg_database WHERE datname=$1', [databaseName])
    assert.equal(leftovers.rowCount, 0, 'Disposable test database was not removed')
    console.log(JSON.stringify({ cleanup: 'passed', database: databaseName, remaining: 0 }))
  }
  await control.end()
}
