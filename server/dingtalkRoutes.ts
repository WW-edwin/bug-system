import { randomUUID } from 'node:crypto'
import { Router } from 'express'
import { z } from 'zod'
import { requireAdmin } from './auth.js'
import { config } from './config.js'
import { DingTalkClient } from './dingtalkClient.js'
import { pool, withTransaction } from './db.js'
import { wakeDingTalkNotificationWorker } from './dingtalkNotifications.js'

const router = Router()
const client = new DingTalkClient(config.dingtalk)
const userIdSchema = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9._:@-]+$/, '钉钉 userId 格式无效')

router.use(requireAdmin)

const employeeSelect = `SELECT id, email, display_name AS name, role, active, created_at AS "createdAt",
  dingtalk_user_id AS "dingtalkUserId", dingtalk_sync_status AS "dingtalkStatus",
  dingtalk_bound_at AS "dingtalkBoundAt"
  FROM app_users`

router.get('/status', async (_request, response) => {
  const [deliveryCounts, outboxCounts, recentFailures] = await Promise.all([
    pool.query('SELECT status, COUNT(*)::int AS count FROM notification_deliveries GROUP BY status ORDER BY status'),
    pool.query('SELECT status, COUNT(*)::int AS count FROM notification_outbox GROUP BY status ORDER BY status'),
    pool.query(
      `SELECT d.id, o.issue_key AS "issueKey", u.display_name AS "userName", d.status,
              d.last_error_code AS "errorCode", d.last_error_message AS "errorMessage", d.updated_at AS "updatedAt"
       FROM notification_deliveries d
       JOIN notification_outbox o ON o.id = d.outbox_id
       JOIN app_users u ON u.id = d.app_user_id
       WHERE d.status IN ('unknown', 'failed_permanent', 'dead_letter')
       ORDER BY d.updated_at DESC LIMIT 20`,
    ),
  ])
  response.json({
    enabled: config.dingtalk.enabled,
    dryRun: config.dingtalk.dryRun,
    configured: Boolean(config.dingtalk.clientId && config.dingtalk.clientSecret && config.dingtalk.agentId && config.dingtalk.corpId),
    deliveryCounts: deliveryCounts.rows,
    outboxCounts: outboxCounts.rows,
    recentFailures: recentFailures.rows,
  })
})

router.patch('/users/:id/binding', async (request, response) => {
  const parsed = z.object({ userId: userIdSchema }).safeParse(request.body)
  if (!parsed.success) return response.status(400).json({ error: parsed.error.issues[0]?.message ?? '钉钉 userId 无效' })
  if (config.dingtalk.dryRun) {
    return response.status(409).json({ error: 'Dry Run 只验证通知流程，不保存钉钉账号绑定' })
  }
  if (!config.dingtalk.dryRun && (!config.dingtalk.clientId || !config.dingtalk.clientSecret || !config.dingtalk.corpId)) {
    return response.status(409).json({ error: '请先在服务端配置钉钉 Client ID、Client Secret 和 Corp ID' })
  }

  try {
    const dingUser = await client.validateUser(parsed.data.userId)
    if (!dingUser.active) return response.status(409).json({ error: '该钉钉用户已停用' })
    const result = await withTransaction(async (db) => {
      const target = await db.query('SELECT id FROM app_users WHERE id = $1 AND active = TRUE FOR UPDATE', [request.params.id])
      if (!target.rowCount) return null
      await db.query(
        `UPDATE app_users SET dingtalk_corp_id = $1, dingtalk_user_id = $2, dingtalk_union_id = $3,
           dingtalk_bound_at = NOW(), dingtalk_binding_version = dingtalk_binding_version + 1,
           dingtalk_sync_status = 'matched', updated_at = NOW() WHERE id = $4`,
        [config.dingtalk.corpId || 'dry-run', dingUser.userId, dingUser.unionId, request.params.id],
      )
      await db.query(
        `INSERT INTO dingtalk_binding_audit
           (id, app_user_id, actor_user_id, action, dingtalk_corp_id, dingtalk_user_id)
         VALUES ($1, $2, $3, 'bound', $4, $5)`,
        [randomUUID(), request.params.id, request.auth!.user.id, config.dingtalk.corpId || 'dry-run', dingUser.userId],
      )
      return db.query(`${employeeSelect} WHERE id = $1`, [request.params.id])
    })
    if (!result) return response.status(404).json({ error: '用户不存在' })
    response.json({ user: result.rows[0], verifiedName: dingUser.name })
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code === '23505') return response.status(409).json({ error: '该钉钉账号已绑定到其他用户' })
    const message = error instanceof Error ? error.message : '钉钉用户验证失败'
    response.status(502).json({ error: message })
  }
})

router.delete('/users/:id/binding', async (request, response) => {
  const updated = await withTransaction(async (db) => {
    const current = await db.query<{ dingtalk_corp_id: string | null; dingtalk_user_id: string | null }>(
      'SELECT dingtalk_corp_id, dingtalk_user_id FROM app_users WHERE id = $1 AND active = TRUE FOR UPDATE',
      [request.params.id],
    )
    if (!current.rowCount) return false
    await db.query(
      `UPDATE app_users SET dingtalk_corp_id = NULL, dingtalk_user_id = NULL, dingtalk_union_id = NULL,
         dingtalk_bound_at = NULL, dingtalk_binding_version = dingtalk_binding_version + 1,
         dingtalk_sync_status = 'unmatched', updated_at = NOW() WHERE id = $1`,
      [request.params.id],
    )
    await db.query(
      `INSERT INTO dingtalk_binding_audit
         (id, app_user_id, actor_user_id, action, dingtalk_corp_id, dingtalk_user_id)
       VALUES ($1, $2, $3, 'unbound', $4, $5)`,
      [randomUUID(), request.params.id, request.auth!.user.id, current.rows[0].dingtalk_corp_id, current.rows[0].dingtalk_user_id],
    )
    return true
  })
  if (!updated) return response.status(404).json({ error: '用户不存在' })
  response.status(204).end()
})

router.post('/deliveries/:id/retry', async (request, response) => {
  const result = await pool.query(
    `UPDATE notification_deliveries SET status = 'retryable', next_attempt_at = NOW(),
       lease_owner = NULL, lease_until = NULL, last_error_code = NULL, last_error_message = NULL, updated_at = NOW()
     WHERE id = $1 AND status IN ('unknown', 'failed_permanent', 'dead_letter', 'skipped_unmapped', 'skipped_stale')
     RETURNING outbox_id`,
    [request.params.id],
  )
  if (!result.rowCount) return response.status(409).json({ error: '该通知当前不可重试' })
  wakeDingTalkNotificationWorker()
  response.status(202).json({ queued: true })
})

export default router
