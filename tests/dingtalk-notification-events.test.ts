import assert from 'node:assert/strict'
import test from 'node:test'
import type { PoolClient } from 'pg'
import { config } from '../server/config.js'
import { buildIssueActionCard } from '../server/dingtalkClient.js'
import type { DictionaryData } from '../server/dictionaries.js'
import { enqueueIssueEventNotification, isCurrentNotificationRecipient, issueNotificationEventKey, planIssueNotificationRecipients } from '../server/dingtalkNotifications.js'
import type { NotificationRule, NotificationRuleSettings } from '../server/notificationRules.js'

const rule = (overrides: Partial<NotificationRule> = {}): NotificationRule => ({
  id: 'rule-created', name: '新缺陷通知', enabled: true, trigger: 'created', targetStatus: null, recipients: ['assignee'], ...overrides,
})
const event = { trigger: 'created' as const, status: 'status-initial', reporterId: 'reporter', assigneeIds: ['one', 'two', 'one'] }

test('default created rule selects assigned users only and deduplicates their IDs', () => {
  assert.deepEqual(planIssueNotificationRecipients([rule()], event), {
    ruleIds: ['rule-created'], recipients: [{ userId: 'one', roles: ['assignee'] }, { userId: 'two', roles: ['assignee'] }],
  })
  assert.deepEqual(planIssueNotificationRecipients([rule()], { ...event, assigneeIds: [] }).recipients, [])
})

test('matching rules merge recipient roles per user and disabled or unrelated rules contribute nothing', () => {
  const plan = planIssueNotificationRecipients([
    rule(), rule({ id: 'reporter-rule', recipients: ['reporter', 'assignee'] }),
    rule({ id: 'off', enabled: false, recipients: ['reporter'] }),
    rule({ id: 'status-rule', trigger: 'status_changed', targetStatus: event.status, recipients: ['reporter'] }),
  ], { ...event, reporterId: 'one' })
  assert.deepEqual(plan, { ruleIds: ['rule-created', 'reporter-rule'], recipients: [
    { userId: 'one', roles: ['assignee', 'reporter'] }, { userId: 'two', roles: ['assignee'] },
  ] })
})

test('status rules match stable target values only on an actual transition', () => {
  const rules = [rule({ trigger: 'status_changed', targetStatus: 'stable-done-id', recipients: ['reporter'] })]
  const changed = { ...event, trigger: 'status_changed' as const, previousStatus: 'stable-open-id', status: 'stable-done-id' }
  assert.deepEqual(planIssueNotificationRecipients(rules, changed).recipients, [{ userId: 'reporter', roles: ['reporter'] }])
  assert.deepEqual(planIssueNotificationRecipients(rules, { ...changed, previousStatus: changed.status }).recipients, [])
  assert.deepEqual(planIssueNotificationRecipients(rules, { ...changed, previousStatus: undefined }).recipients, [])
  assert.deepEqual(planIssueNotificationRecipients(rules, { ...changed, status: '完成' }).recipients, [])
})

test('an event is idempotent while repeated transitions of the same issue remain distinct', () => {
  assert.equal(issueNotificationEventKey('created', 'issue-1'), issueNotificationEventKey('created', 'issue-1', 'ignored'))
  assert.equal(issueNotificationEventKey('status_changed', 'issue-1', 'activity-1'), issueNotificationEventKey('status_changed', 'issue-1', 'activity-1'))
  const repeated = ['a-to-b-1', 'b-to-a', 'a-to-b-2'].map((activityId) => issueNotificationEventKey('status_changed', 'issue-1', activityId))
  assert.equal(new Set(repeated).size, 3)
  assert.throws(() => issueNotificationEventKey('status_changed', 'issue-1'), /缺少事件编号/)
})

test('recipient validity depends on event roles, including a reporter who is not an assignee', () => {
  assert.equal(isCurrentNotificationRecipient(['reporter'], { assignee: false, reporter: true }), true)
  assert.equal(isCurrentNotificationRecipient(['assignee', 'reporter'], { assignee: false, reporter: true }), true)
  assert.equal(isCurrentNotificationRecipient(['assignee'], { assignee: false, reporter: true }), false)
  assert.equal(isCurrentNotificationRecipient(['reporter'], { assignee: true, reporter: false }), false)
  assert.equal(isCurrentNotificationRecipient(['assignee', 'reporter'], { assignee: false, reporter: false }), false)
  assert.equal(isCurrentNotificationRecipient([], { assignee: true, reporter: true }), false)
})

test('status card includes readable transition, actor and business context without Markdown injection', () => {
  const card = buildIssueActionCard({
    issueKey: 'ST-0909-001', title: '测试缺陷', priority: '需要优先处理的等级', project: '测试项目', module: '模块', environment: '集成环境',
    reporter: '张三', assignees: ['李四'], trigger: 'status_changed', previousStatus: '待处理', status: '**已验证**', updatedBy: '王五',
    url: 'https://tracebug.example.test/?issue=ST-0909-001',
  })
  assert.equal(card.action_card.title, '测试项目 · [需要优先处理的等级] ST-0909-001')
  assert.equal(card.action_card.markdown.split('\n')[0], '### 测试项目 · [需要优先处理的等级] ST-0909-001')
  assert.match(card.action_card.markdown, /待处理 → \\\*\\\*已验证\\\*\\\*/)
  assert.match(card.action_card.markdown, /更新人：王五/)
  assert.match(card.action_card.markdown, /创建人：张三/)
  assert.match(card.action_card.markdown, /负责人：李四/)
  assert.equal(card.action_card.single_url, 'https://tracebug.example.test/?issue=ST-0909-001')
})

const dictionaryEntry = (value: string, label: string) => ({ value, label, active: true, isDefault: false, isTerminal: false, weight: 0, showInPersonal: false, position: 0 })
const dictionaries: DictionaryData = {
  dictionaryVersions: { status: 1, priority: 1, environment: 1 },
  dictionaries: {
    status: [dictionaryEntry('open-id', '待处理'), dictionaryEntry('done-id', '已验收')],
    priority: [dictionaryEntry('priority-id', '紧急')], environment: [dictionaryEntry('environment-id', '测试环境')],
  },
}
const settings = (rules: NotificationRule[]): NotificationRuleSettings => ({ version: 7, rules, updatedAt: '2026-09-09T00:00:00Z', updatedBy: null })

function eventDatabase(options: { active?: boolean; mapped?: boolean; snapshot?: NotificationRuleSettings; duplicate?: boolean } = {}) {
  const writes: Array<{ sql: string; values: unknown[] }> = []
  let ruleReads = 0
  const client = { async query(sql: string, values: unknown[] = []) {
    if (sql.includes('FROM notification_rule_settings')) {
      ruleReads += 1
      return { rows: [{ version: 7, rules: options.snapshot?.rules ?? [rule()], updated_at: new Date(), updated_by_name: null }], rowCount: 1 }
    }
    if (sql.includes('FROM issues i JOIN projects')) return { rows: [{ id: 'issue-1', issue_key: 'ST-0909-001', title: '缺陷', status: 'done-id', priority: 'priority-id',
      project: '项目', module: '模块', environment: 'environment-id', reporter_id: 'one', reporter: '张三', updated_by: '王五' }], rowCount: 1 }
    if (sql.includes('FROM issue_assignees')) return { rows: [{ id: 'one', name: '张三' }, { id: 'two', name: '李四' }], rowCount: 2 }
    if (sql.includes('FROM app_users')) return { rows: ['one', 'two'].map((id) => ({ id, active: options.active ?? true,
      dingtalk_corp_id: 'test-corp', dingtalk_user_id: options.mapped === false ? null : 'ding-' + id, dingtalk_binding_version: 1,
      dingtalk_sync_status: options.mapped === false ? 'unmatched' : 'matched' })), rowCount: 2 }
    writes.push({ sql, values })
    if (sql.includes('INSERT INTO notification_outbox')) return { rows: options.duplicate ? [] : [{ id: 'outbox-1' }], rowCount: options.duplicate ? 0 : 1 }
    if (sql.includes('INSERT INTO notification_deliveries') || sql.includes('UPDATE notification_outbox')) return { rows: [], rowCount: 1 }
    if (sql.includes('SELECT status FROM notification_deliveries')) return { rows: writes.filter((write) => write.sql.includes('INSERT INTO notification_deliveries')).map((write) => ({ status: write.values[7] })), rowCount: 2 }
    throw new Error('unexpected event query')
  } } as unknown as PoolClient
  return { client, writes, get ruleReads() { return ruleReads } }
}

test('queued events snapshot one supplied rule version, recipient roles and dictionary labels', async () => {
  const original = { ...config.dingtalk }
  Object.assign(config.dingtalk, { enabled: true, dryRun: false, corpId: 'test-corp' })
  try {
    const database = eventDatabase()
    const snapshot = settings([rule({ trigger: 'status_changed', targetStatus: 'done-id', recipients: ['assignee', 'reporter'] })])
    const result = await enqueueIssueEventNotification(database.client, { issueId: 'issue-1', trigger: 'status_changed', activityId: 'activity-1', previousStatus: 'open-id', dictionaries, settings: snapshot })
    assert.deepEqual(result, { state: 'queued', queued: 2, unmapped: 0 })
    assert.equal(database.ruleReads, 0, 'a transaction-supplied batch snapshot must not be reloaded')
    const outbox = database.writes.find((write) => write.sql.includes('INSERT INTO notification_outbox'))!
    const payload = JSON.parse(String(outbox.values[5]))
    assert.equal(outbox.values[2], 'issue.status_changed:activity-1')
    assert.deepEqual([payload.previousStatus, payload.status, payload.priority, payload.environment], ['待处理', '已验收', '紧急', '测试环境'])
    assert.equal(payload.ruleVersion, 7)
    assert.deepEqual(payload.ruleIds, ['rule-created'])
    assert.equal(payload.updatedBy, '王五')
    const deliveries = database.writes.filter((write) => write.sql.includes('INSERT INTO notification_deliveries'))
    assert.deepEqual(deliveries.map((write) => [write.values[2], write.values[3]]), [['one', ['assignee', 'reporter']], ['two', ['assignee']]])
    snapshot.rules[0].recipients = ['reporter']
    snapshot.version = 8
    assert.equal(JSON.parse(String(outbox.values[5])).ruleVersion, 7)
    assert.deepEqual(deliveries[0].values[3], ['assignee', 'reporter'])
  } finally { Object.assign(config.dingtalk, original) }
})

test('unmatched rules and a disabled environment do not create outbox entries', async () => {
  const original = { ...config.dingtalk }
  try {
    config.dingtalk.enabled = true
    const unmatched = eventDatabase({ snapshot: settings([rule({ enabled: false })]) })
    assert.deepEqual(await enqueueIssueEventNotification(unmatched.client, { issueId: 'issue-1', trigger: 'created' }), { state: 'skipped', queued: 0, unmapped: 0 })
    assert.equal(unmatched.ruleReads, 1)
    assert.equal(unmatched.writes.length, 0)
    config.dingtalk.enabled = false
    const disabled = eventDatabase()
    assert.deepEqual(await enqueueIssueEventNotification(disabled.client, { issueId: 'issue-1', trigger: 'created' }), { state: 'disabled', queued: 0, unmapped: 0 })
    assert.equal(disabled.ruleReads, 0)
    assert.equal(disabled.writes.length, 0)
  } finally { Object.assign(config.dingtalk, original) }
})

test('missing mappings and inactive users are skipped even when selected by a rule', async () => {
  const original = { ...config.dingtalk }
  Object.assign(config.dingtalk, { enabled: true, dryRun: false, corpId: 'test-corp' })
  try {
    for (const [options, status, unmapped] of [[{ mapped: false }, 'skipped_unmapped', 2], [{ active: false }, 'skipped_stale', 0]] as const) {
      const database = eventDatabase(options)
      assert.deepEqual(await enqueueIssueEventNotification(database.client, { issueId: 'issue-1', trigger: 'created', dictionaries, settings: settings([rule()]) }), { state: 'skipped', queued: 0, unmapped })
      assert.ok(database.writes.filter((write) => write.sql.includes('INSERT INTO notification_deliveries')).every((write) => write.values[7] === status))
    }
  } finally { Object.assign(config.dingtalk, original) }
})

test('a previously queued event does not insert duplicate deliveries', async () => {
  const original = { ...config.dingtalk }
  Object.assign(config.dingtalk, { enabled: true, dryRun: true })
  try {
    const database = eventDatabase({ duplicate: true })
    assert.deepEqual(await enqueueIssueEventNotification(database.client, { issueId: 'issue-1', trigger: 'created', dictionaries, settings: settings([rule()]) }), { state: 'skipped', queued: 0, unmapped: 0 })
    assert.equal(database.writes.filter((write) => write.sql.includes('INSERT INTO notification_deliveries')).length, 0)
  } finally { Object.assign(config.dingtalk, original) }
})
