import assert from 'node:assert/strict'
import test from 'node:test'
import { buildIssueActionCard, DingTalkApiError, DingTalkClient, type DingTalkClientSettings, validateDingTalkSettings } from '../server/dingtalkClient.js'
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
