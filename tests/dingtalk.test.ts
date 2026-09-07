import assert from 'node:assert/strict'
import test from 'node:test'
import { buildIssueActionCard, DingTalkApiError, DingTalkClient, type DingTalkClientSettings, validateDingTalkSettings } from '../server/dingtalkClient.js'
import { planDingTalkEmailBindings, type SyncAppUser } from '../server/dingtalkDirectorySync.js'
import { classifyDingTalkRecipient, notificationRetryDelayMs } from '../server/dingtalkNotifications.js'

const settings: DingTalkClientSettings = {
  dryRun: false,
  clientId: 'client-id',
  clientSecret: 'client-secret',
  agentId: '12345',
  corpId: 'corp-id',
  requestTimeoutMs: 5_000,
  workerPollMs: 2_000,
}

const message = {
  issueKey: 'WEB-0903-001',
  title: '登录失败\n**不应注入 Markdown**',
  priority: 'P1',
  project: '客户门户',
  module: '登录',
  environment: '测试环境',
  reporter: '张三',
  assignees: ['李四', '王五'],
  url: 'https://tracebug.example.test/?issue=WEB-0903-001',
}

test('buildIssueActionCard creates a compact actionable message', () => {
  const card = buildIssueActionCard(message)
  assert.equal(card.msgtype, 'action_card')
  assert.equal(card.action_card.single_title, '查看缺陷')
  assert.equal(card.action_card.single_url, message.url)
  assert.match(card.action_card.markdown, /WEB-0903-001/)
  assert.doesNotMatch(card.action_card.markdown, /登录失败\n/)
  assert.match(card.action_card.markdown, /李四、王五/)
})

test('DingTalkClient caches the access token across sends', async () => {
  const calls: string[] = []
  const mockFetch: typeof fetch = async (input) => {
    const url = String(input)
    calls.push(url)
    if (url.includes('/oauth2/accessToken')) {
      return new Response(JSON.stringify({ accessToken: 'token-value', expireIn: 7200 }), { status: 200 })
    }
    return new Response(JSON.stringify({ errcode: 0, task_id: 123456 }), { status: 200 })
  }
  const client = new DingTalkClient(settings, mockFetch)
  await client.sendIssueNotification(['user-1'], message)
  await client.sendIssueNotification(['user-1'], message)
  assert.equal(calls.filter((url) => url.includes('/oauth2/accessToken')).length, 1)
  assert.equal(calls.filter((url) => url.includes('/asyncsend_v2')).length, 2)
})

test('business rate-limit errors are retryable without an unknown outcome', async () => {
  const mockFetch: typeof fetch = async (input) => {
    const url = String(input)
    if (url.includes('/oauth2/accessToken')) {
      return new Response(JSON.stringify({ accessToken: 'token-value', expireIn: 7200 }), { status: 200 })
    }
    return new Response(JSON.stringify({ errcode: 143104, errmsg: 'rate limited' }), { status: 200 })
  }
  const client = new DingTalkClient(settings, mockFetch)
  await assert.rejects(
    client.sendIssueNotification(['user-1'], message),
    (error: unknown) => error instanceof DingTalkApiError && error.retryable && !error.outcomeUnknown,
  )
})

test('network failure during send is marked as an unknown outcome', async () => {
  const mockFetch: typeof fetch = async (input) => {
    const url = String(input)
    if (url.includes('/oauth2/accessToken')) {
      return new Response(JSON.stringify({ accessToken: 'token-value', expireIn: 7200 }), { status: 200 })
    }
    throw new Error('connection reset')
  }
  const client = new DingTalkClient(settings, mockFetch)
  await assert.rejects(
    client.sendIssueNotification(['user-1'], message),
    (error: unknown) => error instanceof DingTalkApiError && error.retryable && error.outcomeUnknown,
  )
})

test('notificationRetryDelayMs is bounded', () => {
  assert.equal(notificationRetryDelayMs(1), 5_000)
  assert.equal(notificationRetryDelayMs(3), 120_000)
  assert.equal(notificationRetryDelayMs(99), 3_600_000)
})

test('an expected recipient missing from the provider result stays unknown', () => {
  const result = {
    failedUserIds: [],
    forbiddenUserIds: [],
    invalidUserIds: [],
    readUserIds: ['user-1'],
    unreadUserIds: [],
  }
  assert.equal(classifyDingTalkRecipient(result, 'user-1', 1).status, 'provider_succeeded')
  const missing = classifyDingTalkRecipient(result, 'user-2', 1)
  assert.equal(missing.status, 'unknown')
  assert.equal(missing.errorCode, 'RECIPIENT_RESULT_MISSING')
})

test('live settings reject an invalid Agent ID and PUBLIC_ORIGIN', () => {
  assert.throws(
    () => validateDingTalkSettings({ ...settings, agentId: 'not-a-number' }, true, 'https://tracebug.example.test'),
    /DINGTALK_AGENT_ID/,
  )
  assert.throws(
    () => validateDingTalkSettings(settings, true, 'http://'),
    /PUBLIC_ORIGIN/,
  )
})

function appUser(overrides: Partial<SyncAppUser> = {}): SyncAppUser {
  return {
    id: 'app-1',
    name: '张三',
    email: 'zhangsan@kando.com.cn',
    dingtalkCorpId: null,
    dingtalkUserId: null,
    dingtalkUnionId: null,
    dingtalkStatus: 'unmatched',
    dingtalkSource: null,
    dingtalkBindingVersion: 0,
    ...overrides,
  }
}

const directoryUser = {
  userId: 'ding-user-1',
  unionId: 'union-1',
  name: '张三',
  active: true,
  email: 'zhangsan@kando.com.cn',
  orgEmail: null,
}

test('email binding is case-insensitive and only accepts active DingTalk users', () => {
  const plan = planDingTalkEmailBindings(
    [appUser({ email: ' ZhangSan@KANDO.com.cn ' })],
    [directoryUser, { ...directoryUser, userId: 'inactive-user', active: false }],
  )
  assert.equal(plan[0].kind, 'matched')
  if (plan[0].kind === 'matched') assert.equal(plan[0].directoryUser.userId, 'ding-user-1')
})

test('duplicate directory emails are conflicts', () => {
  const plan = planDingTalkEmailBindings(
    [appUser()],
    [directoryUser, { ...directoryUser, userId: 'ding-user-2', unionId: 'union-2' }],
  )
  assert.equal(plan[0].kind, 'conflict')
})

test('manual bindings are protected from email sync', () => {
  const plan = planDingTalkEmailBindings(
    [appUser({ dingtalkCorpId: 'corp', dingtalkUserId: 'manual-user', dingtalkStatus: 'matched', dingtalkSource: 'manual' })],
    [directoryUser],
  )
  assert.equal(plan[0].kind, 'manual_kept')
})

test('a DingTalk user reserved by a protected binding cannot be auto-bound elsewhere', () => {
  const plan = planDingTalkEmailBindings(
    [
      appUser({ id: 'protected', email: 'other@kando.com.cn', dingtalkCorpId: 'corp', dingtalkUserId: 'ding-user-1', dingtalkStatus: 'matched', dingtalkSource: 'manual' }),
      appUser({ id: 'candidate' }),
    ],
    [directoryUser],
  )
  assert.equal(plan[0].kind, 'manual_kept')
  assert.equal(plan[1].kind, 'conflict')
})

test('two app emails that resolve to one DingTalk identity are both conflicts', () => {
  const plan = planDingTalkEmailBindings(
    [appUser({ id: 'primary' }), appUser({ id: 'alias', email: 'alias@kando.com.cn' })],
    [{ ...directoryUser, orgEmail: 'alias@kando.com.cn' }],
  )
  assert.deepEqual(plan.map((item) => item.kind), ['conflict', 'conflict'])
})

test('a stale email-sync binding becomes unmatched when its email disappears', () => {
  const plan = planDingTalkEmailBindings(
    [appUser({ dingtalkCorpId: 'corp', dingtalkUserId: 'old-user', dingtalkStatus: 'matched', dingtalkSource: 'email_sync' })],
    [],
  )
  assert.equal(plan[0].kind, 'unmatched')
})

test('directory traversal paginates departments and deduplicates users', async () => {
  const mockFetch: typeof fetch = async (input, init) => {
    const url = String(input)
    if (url.includes('/oauth2/accessToken')) {
      return new Response(JSON.stringify({ accessToken: 'token-value', expireIn: 7200 }), { status: 200 })
    }
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    if (url.includes('/department/listsubid')) {
      return new Response(JSON.stringify({ errcode: 0, result: { dept_id_list: body.dept_id === 1 ? [2] : [] } }), { status: 200 })
    }
    if (body.dept_id === 1 && body.cursor === 0) {
      return new Response(JSON.stringify({ errcode: 0, result: { list: [{ userid: directoryUser.userId, unionid: directoryUser.unionId, name: directoryUser.name, active: true, email: directoryUser.email }], has_more: true, next_cursor: 10 } }), { status: 200 })
    }
    if (body.dept_id === 1) {
      return new Response(JSON.stringify({ errcode: 0, result: { list: [{ userid: directoryUser.userId, unionid: directoryUser.unionId, name: directoryUser.name, active: true, org_email: 'org@kando.com.cn' }], has_more: false } }), { status: 200 })
    }
    return new Response(JSON.stringify({ errcode: 0, result: { list: [{ userid: 'ding-user-2', unionid: 'union-2', name: '李四', active: true, email: 'lisi@kando.com.cn' }], has_more: false } }), { status: 200 })
  }
  const client = new DingTalkClient(settings, mockFetch)
  const snapshot = await client.listDirectoryUsers()
  assert.equal(snapshot.departmentsScanned, 2)
  assert.equal(snapshot.users.length, 2)
  assert.equal(snapshot.users.find((user) => user.userId === 'ding-user-1')?.orgEmail, 'org@kando.com.cn')
})
