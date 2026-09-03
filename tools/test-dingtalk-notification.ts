import { config } from '../server/config.js'
import { DingTalkClient, validateDingTalkSettings } from '../server/dingtalkClient.js'

const testUserId = process.env.DINGTALK_TEST_USER_ID || (config.dingtalk.dryRun ? 'dry-run-test-user' : '')
if (!testUserId) throw new Error('请在本地 .env 中设置 DINGTALK_TEST_USER_ID')

validateDingTalkSettings(config.dingtalk, true, config.publicAppOrigin)
const client = new DingTalkClient(config.dingtalk)
const baseUrl = new URL(config.publicAppOrigin || 'http://127.0.0.1:4173')
baseUrl.searchParams.set('issue', 'DING-TEST-001')

const sent = await client.sendIssueNotification([testUserId], {
  issueKey: 'DING-TEST-001',
  title: '钉钉工作通知联调测试',
  priority: 'P2',
  project: 'TraceBug 集成验证',
  module: '钉钉通知',
  environment: config.dingtalk.dryRun ? 'Dry Run' : '真实钉钉测试组织',
  reporter: '系统联调',
  assignees: ['测试负责人'],
  url: baseUrl.toString(),
})

console.log(`[dingtalk-test] accepted taskId=${sent.taskId} mode=${config.dingtalk.dryRun ? 'dry-run' : 'live'}`)
const progress = await client.getSendProgress(sent.taskId)
console.log(`[dingtalk-test] progress status=${progress.status} percent=${progress.percent}`)
if (progress.status === 2) {
  const result = await client.getSendResult(sent.taskId, [testUserId])
  console.log(`[dingtalk-test] result failed=${result.failedUserIds.length} forbidden=${result.forbiddenUserIds.length} invalid=${result.invalidUserIds.length} read=${result.readUserIds.length} unread=${result.unreadUserIds.length}`)
}
