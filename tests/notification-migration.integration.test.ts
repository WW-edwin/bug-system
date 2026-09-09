import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import test from 'node:test'

test('legacy notification queues migrate without losing deliveries or blocking later state events', {
  skip: process.env.TRACEBUG_NOTIFICATION_TEST !== 'true', timeout: 60_000,
}, async (t) => {
  const { config } = await import('../server/config.js')
  assert.deepEqual([config.pgHost, config.pgPort, config.pgDatabase], ['127.0.0.1', 5434, 'tracebug_local'])
  assert.equal(process.env.DATABASE_URL, undefined, 'DATABASE_URL cannot override the disposable database guard')
  const { Pool } = await import('pg')
  const { schemaSql } = await import('../server/schema.js')
  const marker = 'SELFTEST-' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14).replace(/^(\d{8})/, '$1-')
  const databaseName = 'tracebug_notification_migration_' + randomBytes(8).toString('hex')
  assert.match(databaseName, /^tracebug_notification_migration_[a-f0-9]{16}$/)
  const connection = { host: config.pgHost, port: config.pgPort, user: config.pgUser, password: config.pgPassword, connectionTimeoutMillis: 8000 }
  const control = new Pool({ ...connection, database: 'postgres' })
  const fixture = new Pool({ ...connection, database: databaseName })
  let created = false
  const userId = randomUUID()
  const projectId = randomUUID()
  const issueIds = [randomUUID(), randomUUID()]
  const outboxIds = [randomUUID(), randomUUID()]
  const deliveryIds = [randomUUID(), randomUUID()]
  const activityIds = [randomUUID(), randomUUID(), randomUUID()]
  const statusOutboxIds = [randomUUID(), randomUUID(), randomUUID()]
  const duplicate = (error: unknown) => (error as { code?: string }).code === '23505'
  try {
    await control.query(`CREATE DATABASE "${databaseName}"`)
    created = true
    const legacyBoundary = schemaSql.indexOf('CREATE TABLE IF NOT EXISTS notification_rule_settings (')
    assert.ok(legacyBoundary > 0, 'notification schema boundary must exist')
    await fixture.query(schemaSql.slice(0, legacyBoundary))
    // Exact previous notification shape: no event_key and no recipient_roles.
    await fixture.query(`CREATE TABLE notification_outbox (
      id UUID PRIMARY KEY, event_type VARCHAR(40) NOT NULL, aggregate_id UUID NOT NULL, issue_key VARCHAR(40) NOT NULL,
      payload JSONB NOT NULL, status VARCHAR(32) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','processing','provider_succeeded','partial','attention_required','skipped')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), completed_at TIMESTAMPTZ,
      UNIQUE (event_type, aggregate_id)
    );
    CREATE TABLE notification_deliveries (
      id UUID PRIMARY KEY, outbox_id UUID NOT NULL REFERENCES notification_outbox(id) ON DELETE CASCADE,
      app_user_id UUID NOT NULL REFERENCES app_users(id), dingtalk_corp_id VARCHAR(128), dingtalk_user_id VARCHAR(128),
      dingtalk_binding_version INTEGER NOT NULL DEFAULT 0, status VARCHAR(32) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','leased','provider_accepted','provider_succeeded','retryable','unknown','failed_permanent','dead_letter','skipped_unmapped','skipped_stale')),
      attempt_count INTEGER NOT NULL DEFAULT 0, next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), lease_owner VARCHAR(128),
      lease_until TIMESTAMPTZ, last_error_code VARCHAR(80), last_error_message VARCHAR(500),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE (outbox_id, app_user_id)
    );`)
    await fixture.query('INSERT INTO app_users (id, display_name, email) VALUES ($1,$2,$3)', [userId, marker + ' 用户', marker + '@example.invalid'])
    await fixture.query('INSERT INTO projects (id,project_key,name,color,created_by) VALUES ($1,$2,$3,$4,$5)', [projectId, 'MIGRATE', marker, '#3367a8', userId])
    for (const [index, issueId] of issueIds.entries()) {
      await fixture.query(`INSERT INTO issues (id,issue_key,project_id,title,status,priority,reporter_id,assignee_id,last_modified_by)
        VALUES ($1,$2,$3,$4,'待处理','P1',$5,$5,$5)`, [issueId, marker + '-' + index, projectId, marker, userId])
      const payload = { issueKey: marker + '-' + index, title: marker + ' 历史事件', priority: 'P1', project: marker,
        reporter: '历史创建人', assignees: ['历史负责人'], module: '历史模块', environment: '历史环境' }
      await fixture.query(`INSERT INTO notification_outbox (id,event_type,aggregate_id,issue_key,payload,status,created_at,completed_at)
        VALUES ($1,'issue.created',$2,$3,$4::jsonb,$5,'2026-09-01T01:02:03Z',$6)`,
      [outboxIds[index], issueId, marker + '-' + index, JSON.stringify(payload), index === 0 ? 'processing' : 'provider_succeeded', index === 0 ? null : '2026-09-01T01:03:03Z'])
      await fixture.query(`INSERT INTO notification_deliveries
        (id,outbox_id,app_user_id,dingtalk_corp_id,dingtalk_user_id,dingtalk_binding_version,status,attempt_count,next_attempt_at,last_error_code,last_error_message)
        VALUES ($1,$2,$3,$4,$5,3,$6,2,'2026-09-01T01:04:03Z',$7,$8)`,
      [deliveryIds[index], outboxIds[index], userId, marker + '-corp', marker + '-ding-user', index === 0 ? 'retryable' : 'provider_succeeded',
        index === 0 ? 'PROVIDER_FORBIDDEN' : null, index === 0 ? '历史重试信息' : null])
    }
    const beforeOutboxes = (await fixture.query('SELECT * FROM notification_outbox ORDER BY id')).rows
    const beforeDeliveries = (await fixture.query('SELECT * FROM notification_deliveries ORDER BY id')).rows
    assert.equal((await fixture.query("SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND ((table_name='notification_outbox' AND column_name='event_key') OR (table_name='notification_deliveries' AND column_name='recipient_roles'))")).rowCount, 0)
    assert.equal((await fixture.query("SELECT 1 FROM pg_constraint WHERE conrelid='notification_outbox'::regclass AND conname='notification_outbox_event_type_aggregate_id_key'")).rowCount, 1)
    await fixture.query(schemaSql)

    await t.test('existing payload, IDs, mapping, timestamps, retry state and completion state are preserved', async () => {
      const migratedOutboxes = (await fixture.query('SELECT * FROM notification_outbox ORDER BY id')).rows
      assert.deepEqual(migratedOutboxes.map(({ event_key: _key, ...row }) => row), beforeOutboxes)
      for (const row of migratedOutboxes) assert.equal(row.event_key, 'issue.created:' + row.aggregate_id)
      const migratedDeliveries = (await fixture.query('SELECT * FROM notification_deliveries ORDER BY id')).rows
      assert.deepEqual(migratedDeliveries.map(({ recipient_roles: _roles, ...row }) => row), beforeDeliveries)
      for (const row of migratedDeliveries) assert.deepEqual(row.recipient_roles, ['assignee'])
      assert.equal((await fixture.query("SELECT 1 FROM pg_constraint WHERE conrelid='notification_outbox'::regclass AND conname='notification_outbox_event_type_aggregate_id_key'")).rowCount, 0)
      assert.equal((await fixture.query("SELECT is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name='notification_outbox' AND column_name='event_key'")).rows[0].is_nullable, 'NO')
    })

    await t.test('legacy created events remain idempotent and repeated transitions have distinct durable keys', async () => {
      await assert.rejects(fixture.query(`INSERT INTO notification_outbox (id,event_type,event_key,aggregate_id,issue_key,payload)
        VALUES ($1,'issue.created',$2,$3,$4,'{}'::jsonb)`, [randomUUID(), 'issue.created:' + issueIds[0], issueIds[0], marker + '-0']), duplicate)
      const transitions = [['待处理', '待复测'], ['待复测', '待处理'], ['待处理', '待复测']]
      for (const [index, [previousStatus, status]] of transitions.entries()) {
        await fixture.query("INSERT INTO issue_activities (id,issue_id,actor_id,action,detail,kind) VALUES ($1,$2,$3,'更新了状态',$4,'changed')",
          [activityIds[index], issueIds[0], userId, previousStatus + ' → ' + status])
        await fixture.query(`INSERT INTO notification_outbox (id,event_type,event_key,aggregate_id,issue_key,payload)
          VALUES ($1,'issue.status_changed',$2,$3,$4,$5::jsonb)`,
        [statusOutboxIds[index], 'issue.status_changed:' + activityIds[index], issueIds[0], marker + '-0', JSON.stringify({ previousStatus, status })])
      }
      const events = (await fixture.query("SELECT event_key,payload FROM notification_outbox WHERE aggregate_id=$1 AND event_type='issue.status_changed' ORDER BY created_at,id", [issueIds[0]])).rows
      assert.equal(events.length, 3)
      assert.equal(new Set(events.map((event) => event.event_key)).size, 3)
      assert.equal(events.filter((event) => event.payload.previousStatus === '待处理' && event.payload.status === '待复测').length, 2)
      await assert.rejects(fixture.query(`INSERT INTO notification_outbox (id,event_type,event_key,aggregate_id,issue_key,payload)
        VALUES ($1,'issue.status_changed',$2,$3,$4,'{}'::jsonb)`, [randomUUID(), 'issue.status_changed:' + activityIds[0], issueIds[0], marker + '-0']), duplicate)
      await fixture.query(`INSERT INTO notification_deliveries (id,outbox_id,app_user_id) VALUES ($1,$2,$3)`, [randomUUID(), statusOutboxIds[0], userId])
      assert.deepEqual((await fixture.query('SELECT recipient_roles FROM notification_deliveries WHERE outbox_id=$1', [statusOutboxIds[0]])).rows[0].recipient_roles, ['assignee'])
      await assert.rejects(fixture.query(`INSERT INTO notification_deliveries (id,outbox_id,app_user_id,recipient_roles)
        VALUES ($1,$2,$3,ARRAY['reporter'])`, [randomUUID(), statusOutboxIds[0], userId]), duplicate)
    })

    await t.test('reapplying the schema preserves migrated queues, custom rules and new role snapshots', async () => {
      await fixture.query(`INSERT INTO notification_deliveries (id,outbox_id,app_user_id,recipient_roles)
        VALUES ($1,$2,$3,ARRAY['assignee','reporter'])`, [randomUUID(), statusOutboxIds[1], userId])
      const customRules = [{ id: randomUUID(), name: marker, enabled: false, trigger: 'created', targetStatus: null, recipients: ['reporter'] }]
      await fixture.query('UPDATE notification_rule_settings SET version=9,rules=$1::jsonb,updated_by=$2 WHERE id=1', [JSON.stringify(customRules), userId])
      const before = {
        outbox: (await fixture.query('SELECT * FROM notification_outbox ORDER BY id')).rows,
        deliveries: (await fixture.query('SELECT * FROM notification_deliveries ORDER BY id')).rows,
        settings: (await fixture.query('SELECT * FROM notification_rule_settings')).rows,
      }
      await fixture.query(schemaSql)
      assert.deepEqual((await fixture.query('SELECT * FROM notification_outbox ORDER BY id')).rows, before.outbox)
      assert.deepEqual((await fixture.query('SELECT * FROM notification_deliveries ORDER BY id')).rows, before.deliveries)
      assert.deepEqual((await fixture.query('SELECT * FROM notification_rule_settings')).rows, before.settings)
    })
    t.diagnostic(JSON.stringify({ marker, databaseName, userId, projectId, issueIds, outboxIds, deliveryIds, activityIds, statusOutboxIds, externalMessages: 0 }))
  } finally {
    await fixture.end()
    try {
      if (created) {
        await control.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`)
        assert.equal((await control.query('SELECT datname FROM pg_database WHERE datname=$1', [databaseName])).rowCount, 0)
        t.diagnostic(JSON.stringify({ marker, databaseName, cleanup: 'passed', remaining: 0, configuredDatabaseUntouched: true }))
      }
    } finally { await control.end() }
  }
})
