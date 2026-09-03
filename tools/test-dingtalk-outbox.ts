import { setTimeout as delay } from 'node:timers/promises'
import { config } from '../server/config.js'
import { initializeDatabase, pool, withTransaction } from '../server/db.js'
import { DingTalkNotificationWorker, enqueueIssueCreatedNotification } from '../server/dingtalkNotifications.js'

if (config.pgDatabase !== 'tracebug_local') throw new Error(`拒绝执行：数据库必须是 tracebug_local，当前是 ${config.pgDatabase}`)
if (!config.dingtalk.enabled || !config.dingtalk.dryRun) throw new Error('本脚本只允许 DINGTALK_ENABLED=true 且 DINGTALK_DRY_RUN=true')

await initializeDatabase()
const issueResult = await pool.query<{
  id: string
  issue_key: string
  title: string
  priority: string
  project: string
  module: string
  environment: string
  reporter: string
  assignee_ids: string[]
  assignee_names: string[]
}>(
  `SELECT i.id, i.issue_key, i.title, i.priority, p.name AS project, i.module, i.environment,
          reporter.display_name AS reporter,
          ARRAY_AGG(assignee.id ORDER BY ia.position) AS assignee_ids,
          ARRAY_AGG(assignee.display_name ORDER BY ia.position) AS assignee_names
   FROM issues i
   JOIN projects p ON p.id = i.project_id
   JOIN app_users reporter ON reporter.id = i.reporter_id
   JOIN issue_assignees ia ON ia.issue_id = i.id
   JOIN app_users assignee ON assignee.id = ia.user_id
   WHERE NOT EXISTS (SELECT 1 FROM notification_outbox o WHERE o.event_type = 'issue.created' AND o.aggregate_id = i.id)
   GROUP BY i.id, p.name, reporter.display_name
   ORDER BY i.created_at DESC LIMIT 1`,
)
const issue = issueResult.rows[0]
if (!issue) throw new Error('本地数据库没有可用于 Dry Run 的 Bug')

let worker: DingTalkNotificationWorker | null = null
let outboxId: string | null = null
try {
  const queued = await withTransaction(async (client) => enqueueIssueCreatedNotification(client, {
    issueId: issue.id,
    issueKey: issue.issue_key,
    title: issue.title,
    priority: issue.priority,
    project: issue.project,
    module: issue.module,
    environment: issue.environment,
    reporter: issue.reporter,
    assigneeIds: issue.assignee_ids,
    assigneeNames: issue.assignee_names,
  }))
  const outbox = await pool.query<{ id: string }>(
    `SELECT id FROM notification_outbox WHERE event_type = 'issue.created' AND aggregate_id = $1`,
    [issue.id],
  )
  outboxId = outbox.rows[0]?.id ?? null
  if (!outboxId) throw new Error('Dry Run 未创建 Outbox')

  worker = new DingTalkNotificationWorker()
  worker.start()
  const deadline = Date.now() + 12_000
  let status = ''
  while (Date.now() < deadline) {
    const result = await pool.query<{ status: string }>('SELECT status FROM notification_outbox WHERE id = $1', [outboxId])
    status = result.rows[0]?.status ?? ''
    if (['provider_succeeded', 'partial', 'attention_required', 'skipped'].includes(status)) break
    await delay(250)
  }
  const details = await pool.query(
    `SELECT o.status AS outbox_status, d.status AS delivery_status, COUNT(DISTINCT a.id)::int AS attempts
     FROM notification_outbox o
     JOIN notification_deliveries d ON d.outbox_id = o.id
     LEFT JOIN notification_attempts a ON a.outbox_id = o.id
     WHERE o.id = $1 GROUP BY o.status, d.status ORDER BY d.status`,
    [outboxId],
  )
  console.log(JSON.stringify({ issueKey: issue.issue_key, queued, rows: details.rows }, null, 2))
  if (status !== 'provider_succeeded') throw new Error(`Dry Run Outbox 未成功，最终状态：${status || 'unknown'}`)
} finally {
  if (worker) await worker.stop()
  if (outboxId) await pool.query('DELETE FROM notification_outbox WHERE id = $1', [outboxId])
  await pool.end()
}
