import { createHash, randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { config } from './config.js'
import { DingTalkApiError, DingTalkClient, type DingTalkSendResult, type IssueNotificationMessage, validateDingTalkSettings } from './dingtalkClient.js'
import { pool, withTransaction } from './db.js'

const MAX_SEND_ATTEMPTS = 5
const MAX_RESULT_CHECKS = 10
const ATTEMPT_LEASE_MS = 60_000

type DeliveryStatus =
  | 'pending'
  | 'leased'
  | 'provider_accepted'
  | 'provider_succeeded'
  | 'retryable'
  | 'unknown'
  | 'failed_permanent'
  | 'dead_letter'
  | 'skipped_unmapped'
  | 'skipped_stale'

interface IssueNotificationPayload {
  issueKey: string
  title: string
  priority: string
  project: string
  module: string
  environment: string
  reporter: string
  assignees: string[]
}

interface ClaimedBatch {
  attemptId: string
  outboxId: string
  deliveryIds: string[]
  userIds: string[]
  attemptCounts: number[]
  payload: IssueNotificationPayload
}

interface AcceptedAttempt {
  id: string
  outboxId: string
  deliveryIds: string[]
  userIds: string[]
  taskId: string
  checkCount: number
}

export interface NotificationQueueResult {
  state: 'disabled' | 'queued' | 'partial' | 'skipped'
  queued: number
  unmapped: number
}

function errorSummary(error: unknown) {
  if (error instanceof DingTalkApiError) {
    return { code: error.code, message: error.message.slice(0, 500), retryable: error.retryable, outcomeUnknown: error.outcomeUnknown }
  }
  return { code: 'UNEXPECTED_ERROR', message: error instanceof Error ? error.message.slice(0, 500) : '未知错误', retryable: false, outcomeUnknown: false }
}

export function notificationRetryDelayMs(attemptCount: number) {
  const delays = [5_000, 30_000, 120_000, 600_000, 3_600_000]
  return delays[Math.min(Math.max(attemptCount - 1, 0), delays.length - 1)]
}

export function classifyDingTalkRecipient(result: DingTalkSendResult, userId: string, attemptCount: number): {
  status: DeliveryStatus
  errorCode: string | null
  errorMessage: string | null
  retryDelayMs: number
} {
  if (result.invalidUserIds.includes(userId)) {
    return { status: 'failed_permanent', errorCode: 'INVALID_USER_ID', errorMessage: '钉钉返回无效用户', retryDelayMs: 0 }
  }
  if (result.forbiddenUserIds.includes(userId)) {
    return {
      status: attemptCount >= MAX_SEND_ATTEMPTS ? 'dead_letter' : 'retryable',
      errorCode: 'PROVIDER_FORBIDDEN',
      errorMessage: '钉钉因频率、配额或重复内容限制未发送',
      retryDelayMs: 10 * 60_000,
    }
  }
  if (result.failedUserIds.includes(userId)) {
    return {
      status: attemptCount >= MAX_SEND_ATTEMPTS ? 'dead_letter' : 'retryable',
      errorCode: 'PROVIDER_SEND_FAILED',
      errorMessage: '钉钉返回发送失败',
      retryDelayMs: notificationRetryDelayMs(attemptCount),
    }
  }
  if (result.readUserIds.includes(userId) || result.unreadUserIds.includes(userId)) {
    return { status: 'provider_succeeded', errorCode: null, errorMessage: null, retryDelayMs: 0 }
  }
  return {
    status: 'unknown',
    errorCode: 'RECIPIENT_RESULT_MISSING',
    errorMessage: '钉钉发送结果未包含该负责人',
    retryDelayMs: 0,
  }
}

function issueUrl(issueKey: string) {
  const url = new URL(config.publicAppOrigin || 'http://127.0.0.1:4173')
  url.searchParams.set('issue', issueKey)
  return url.toString()
}

async function syncOutboxStatus(client: PoolClient, outboxId: string) {
  const result = await client.query<{ status: DeliveryStatus }>(
    'SELECT status FROM notification_deliveries WHERE outbox_id = $1',
    [outboxId],
  )
  const statuses = result.rows.map((row) => row.status)
  const active = new Set<DeliveryStatus>(['pending', 'leased', 'provider_accepted', 'retryable'])
  const attention = new Set<DeliveryStatus>(['unknown', 'failed_permanent', 'dead_letter'])
  const skipped = new Set<DeliveryStatus>(['skipped_unmapped', 'skipped_stale'])
  let status: 'pending' | 'processing' | 'provider_succeeded' | 'partial' | 'attention_required' | 'skipped'
  if (!statuses.length) status = 'skipped'
  else if (statuses.every((value) => value === 'pending')) status = 'pending'
  else if (statuses.some((value) => active.has(value))) status = 'processing'
  else if (statuses.some((value) => attention.has(value))) status = 'attention_required'
  else if (statuses.every((value) => value === 'provider_succeeded')) status = 'provider_succeeded'
  else if (statuses.every((value) => skipped.has(value))) status = 'skipped'
  else status = 'partial'
  await client.query(
    `UPDATE notification_outbox
     SET status = $1::varchar, completed_at = CASE WHEN $1::varchar IN ('provider_succeeded', 'partial', 'attention_required', 'skipped') THEN NOW() ELSE NULL END
     WHERE id = $2`,
    [status, outboxId],
  )
}

export async function enqueueIssueCreatedNotification(client: PoolClient, input: {
  issueId: string
  issueKey: string
  title: string
  priority: string
  project: string
  module: string
  environment: string
  reporter: string
  assigneeIds: string[]
  assigneeNames: string[]
}): Promise<NotificationQueueResult> {
  if (!config.dingtalk.enabled) return { state: 'disabled', queued: 0, unmapped: 0 }

  const users = await client.query<{
    id: string
    dingtalk_corp_id: string | null
    dingtalk_user_id: string | null
    dingtalk_binding_version: number
    dingtalk_sync_status: string
  }>(
    `SELECT id, dingtalk_corp_id, dingtalk_user_id, dingtalk_binding_version, dingtalk_sync_status
     FROM app_users WHERE id = ANY($1::uuid[])`,
    [input.assigneeIds],
  )
  const userById = new Map(users.rows.map((user) => [user.id, user]))
  const outboxId = randomUUID()
  const payload: IssueNotificationPayload = {
    issueKey: input.issueKey,
    title: input.title,
    priority: input.priority,
    project: input.project,
    module: input.module,
    environment: input.environment,
    reporter: input.reporter,
    assignees: input.assigneeNames,
  }
  await client.query(
    `INSERT INTO notification_outbox (id, event_type, aggregate_id, issue_key, payload)
     VALUES ($1, 'issue.created', $2, $3, $4::jsonb)`,
    [outboxId, input.issueId, input.issueKey, JSON.stringify(payload)],
  )

  let queued = 0
  let unmapped = 0
  for (const appUserId of input.assigneeIds) {
    const user = userById.get(appUserId)
    const dryRunUserId = `dry-run:${appUserId}`
    const mapped = config.dingtalk.dryRun || Boolean(
      user?.dingtalk_corp_id === config.dingtalk.corpId
      && user?.dingtalk_user_id
      && user?.dingtalk_sync_status === 'matched',
    )
    const status: DeliveryStatus = mapped ? 'pending' : 'skipped_unmapped'
    if (mapped) queued += 1
    else unmapped += 1
    await client.query(
      `INSERT INTO notification_deliveries
         (id, outbox_id, app_user_id, dingtalk_corp_id, dingtalk_user_id, dingtalk_binding_version, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        randomUUID(),
        outboxId,
        appUserId,
        config.dingtalk.dryRun ? (config.dingtalk.corpId || 'dry-run') : user?.dingtalk_corp_id,
        config.dingtalk.dryRun ? dryRunUserId : user?.dingtalk_user_id,
        user?.dingtalk_binding_version ?? 0,
        status,
      ],
    )
  }
  await syncOutboxStatus(client, outboxId)
  return {
    state: queued === 0 ? 'skipped' : unmapped > 0 ? 'partial' : 'queued',
    queued,
    unmapped,
  }
}

async function recoverExpiredLeases() {
  await withTransaction(async (client) => {
    const attempts = await client.query<{
      id: string
      outbox_id: string
      delivery_ids: string[]
      state: 'prepared' | 'in_flight' | 'provider_accepted'
      provider_task_id: string | null
    }>(
      `SELECT id, outbox_id, delivery_ids, state, provider_task_id
       FROM notification_attempts
       WHERE state IN ('prepared', 'in_flight', 'provider_accepted')
         AND lease_until IS NOT NULL AND lease_until < NOW()
       ORDER BY prepared_at
       FOR UPDATE SKIP LOCKED LIMIT 100`,
    )
    const touched = new Set<string>()
    for (const attempt of attempts.rows) {
      touched.add(attempt.outbox_id)
      if (attempt.state === 'prepared') {
        await client.query(
          `UPDATE notification_deliveries SET status = 'pending', attempt_count = GREATEST(attempt_count - 1, 0),
             lease_owner = NULL, lease_until = NULL, updated_at = NOW()
           WHERE id = ANY($1::uuid[]) AND status = 'leased'`,
          [attempt.delivery_ids],
        )
        await client.query(
          `UPDATE notification_attempts SET state = 'completed', outcome = 'prepared_lease_expired', finished_at = NOW(), lease_until = NULL WHERE id = $1`,
          [attempt.id],
        )
      } else if (attempt.state === 'in_flight' && !attempt.provider_task_id) {
        await client.query(
          `UPDATE notification_deliveries SET status = 'unknown', lease_owner = NULL, lease_until = NULL,
             last_error_code = 'UNKNOWN_SEND_RESULT', last_error_message = '发送调用开始后进程中断，无法确认钉钉是否受理', updated_at = NOW()
           WHERE id = ANY($1::uuid[])`,
          [attempt.delivery_ids],
        )
        await client.query(
          `UPDATE notification_attempts SET state = 'unknown', outcome = 'worker_interrupted', finished_at = NOW(), lease_until = NULL WHERE id = $1`,
          [attempt.id],
        )
      } else {
        await client.query(
          `UPDATE notification_attempts SET lease_until = NULL, next_check_at = COALESCE(next_check_at, NOW()) WHERE id = $1`,
          [attempt.id],
        )
      }
    }
    for (const outboxId of touched) await syncOutboxStatus(client, outboxId)
  })
}

async function claimPendingBatch(workerId: string): Promise<ClaimedBatch | null> {
  return withTransaction(async (client) => {
    const outboxResult = await client.query<{ id: string; aggregate_id: string; payload: IssueNotificationPayload }>(
      `SELECT o.id, o.aggregate_id, o.payload
       FROM notification_outbox o
       WHERE EXISTS (
         SELECT 1 FROM notification_deliveries d
         WHERE d.outbox_id = o.id AND d.status IN ('pending', 'retryable') AND d.next_attempt_at <= NOW()
       )
       ORDER BY o.created_at
       FOR UPDATE SKIP LOCKED LIMIT 1`,
    )
    const outbox = outboxResult.rows[0]
    if (!outbox) return null

    const deliveries = await client.query<{
      id: string
      app_user_id: string
      attempt_count: number
      active: boolean
      current_assignee: boolean
      issue_exists: boolean
      dingtalk_corp_id: string | null
      dingtalk_user_id: string | null
      dingtalk_binding_version: number
      dingtalk_sync_status: string
    }>(
      `SELECT d.id, d.app_user_id, d.attempt_count, u.active,
              EXISTS (SELECT 1 FROM issues i WHERE i.id = $2) AS issue_exists,
              EXISTS (SELECT 1 FROM issue_assignees ia WHERE ia.issue_id = $2 AND ia.user_id = d.app_user_id) AS current_assignee,
              u.dingtalk_corp_id, u.dingtalk_user_id, u.dingtalk_binding_version, u.dingtalk_sync_status
       FROM notification_deliveries d
       JOIN app_users u ON u.id = d.app_user_id
       WHERE d.outbox_id = $1 AND d.status IN ('pending', 'retryable') AND d.next_attempt_at <= NOW()
       ORDER BY d.created_at
       FOR UPDATE OF d SKIP LOCKED LIMIT 50`,
      [outbox.id, outbox.aggregate_id],
    )

    const valid: Array<{ id: string; userId: string; attemptCount: number }> = []
    for (const delivery of deliveries.rows) {
      if (!delivery.issue_exists || !delivery.active || !delivery.current_assignee) {
        await client.query(
          `UPDATE notification_deliveries SET status = 'skipped_stale', lease_owner = NULL, lease_until = NULL,
             last_error_code = 'STALE_RECIPIENT', last_error_message = 'Bug 已删除、用户已停用或已不再是当前负责人', updated_at = NOW()
           WHERE id = $1`,
          [delivery.id],
        )
        continue
      }
      const userId = config.dingtalk.dryRun ? `dry-run:${delivery.app_user_id}` : delivery.dingtalk_user_id
      const corpMatches = config.dingtalk.dryRun || delivery.dingtalk_corp_id === config.dingtalk.corpId
      if (!userId || !corpMatches || (!config.dingtalk.dryRun && delivery.dingtalk_sync_status !== 'matched')) {
        await client.query(
          `UPDATE notification_deliveries SET status = 'skipped_unmapped', lease_owner = NULL, lease_until = NULL,
             last_error_code = 'UNMAPPED_USER', last_error_message = '负责人没有有效的钉钉绑定', updated_at = NOW()
           WHERE id = $1`,
          [delivery.id],
        )
        continue
      }
      await client.query(
        `UPDATE notification_deliveries SET dingtalk_corp_id = $1, dingtalk_user_id = $2,
           dingtalk_binding_version = $3, status = 'leased', attempt_count = attempt_count + 1,
           lease_owner = $4, lease_until = NOW() + ($5 * INTERVAL '1 millisecond'), updated_at = NOW()
         WHERE id = $6`,
        [config.dingtalk.dryRun ? (config.dingtalk.corpId || 'dry-run') : delivery.dingtalk_corp_id, userId, delivery.dingtalk_binding_version, workerId, ATTEMPT_LEASE_MS, delivery.id],
      )
      valid.push({ id: delivery.id, userId, attemptCount: delivery.attempt_count + 1 })
    }
    if (!valid.length) {
      await syncOutboxStatus(client, outbox.id)
      return null
    }

    const attemptId = randomUUID()
    const fingerprint = createHash('sha256').update(JSON.stringify({ outboxId: outbox.id, userIds: valid.map((item) => item.userId), payload: outbox.payload })).digest('hex')
    await client.query(
      `INSERT INTO notification_attempts
         (id, outbox_id, delivery_ids, recipient_user_ids, request_fingerprint, state, lease_until)
       VALUES ($1, $2, $3::uuid[], $4::text[], $5, 'prepared', NOW() + ($6 * INTERVAL '1 millisecond'))`,
      [attemptId, outbox.id, valid.map((item) => item.id), valid.map((item) => item.userId), fingerprint, ATTEMPT_LEASE_MS],
    )
    await syncOutboxStatus(client, outbox.id)
    return {
      attemptId,
      outboxId: outbox.id,
      deliveryIds: valid.map((item) => item.id),
      userIds: valid.map((item) => item.userId),
      attemptCounts: valid.map((item) => item.attemptCount),
      payload: outbox.payload,
    }
  })
}

async function finishSendFailure(batch: ClaimedBatch, error: unknown) {
  const summary = errorSummary(error)
  await withTransaction(async (client) => {
    const retryUnknown = summary.outcomeUnknown && config.dingtalk.retryUnknown && Math.max(...batch.attemptCounts) === 1
    for (const [index, deliveryId] of batch.deliveryIds.entries()) {
      const exhausted = batch.attemptCounts[index] >= MAX_SEND_ATTEMPTS
      const status: DeliveryStatus = summary.outcomeUnknown
        ? retryUnknown ? 'retryable' : 'unknown'
        : summary.retryable ? exhausted ? 'dead_letter' : 'retryable'
          : 'failed_permanent'
      const delay = summary.outcomeUnknown && retryUnknown ? 120_000 : notificationRetryDelayMs(batch.attemptCounts[index])
      await client.query(
        `UPDATE notification_deliveries SET status = $1, next_attempt_at = NOW() + ($2 * INTERVAL '1 millisecond'),
           lease_owner = NULL, lease_until = NULL, last_error_code = $3, last_error_message = $4, updated_at = NOW()
         WHERE id = $5`,
        [status, delay, summary.code, summary.message, deliveryId],
      )
    }
    await client.query(
      `UPDATE notification_attempts SET state = $1, outcome = $2, provider_error_code = $3,
         response_summary = $4::jsonb, finished_at = NOW(), lease_until = NULL WHERE id = $5`,
      [summary.outcomeUnknown && !retryUnknown ? 'unknown' : 'completed', summary.outcomeUnknown ? retryUnknown ? 'unknown_retry_scheduled' : 'unknown' : summary.retryable ? 'retryable_error' : 'permanent_error', summary.code, JSON.stringify(summary), batch.attemptId],
    )
    await syncOutboxStatus(client, batch.outboxId)
  })
}

async function persistProviderAccepted(batch: ClaimedBatch, taskId: string) {
  const delays = [0, 100, 500, 2_000, 5_000]
  let lastError: unknown
  for (const delayMs of delays) {
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs))
    try {
      const persisted = await withTransaction(async (client) => {
        const result = await client.query(
          `UPDATE notification_attempts SET state = 'provider_accepted', provider_task_id = $1,
             next_check_at = NOW() + INTERVAL '3 seconds', lease_until = NULL
           WHERE id = $2 AND state = 'in_flight' RETURNING id`,
          [taskId, batch.attemptId],
        )
        if (!result.rowCount) return false
        await client.query(
          `UPDATE notification_deliveries SET status = 'provider_accepted', lease_owner = NULL, lease_until = NULL, updated_at = NOW()
           WHERE id = ANY($1::uuid[]) AND status = 'leased'`,
          [batch.deliveryIds],
        )
        await syncOutboxStatus(client, batch.outboxId)
        return true
      })
      if (persisted) return true
      lastError = new Error('发送尝试已不处于 in_flight 状态')
      break
    } catch (error) {
      lastError = error
    }
  }
  console.error(`[dingtalk] provider accepted task but task_id persistence failed: ${lastError instanceof Error ? lastError.message : 'unknown database error'}`)
  return false
}

async function sendBatch(client: DingTalkClient, batch: ClaimedBatch) {
  let message: IssueNotificationMessage
  try {
    message = { ...batch.payload, url: issueUrl(batch.payload.issueKey) }
  } catch (error) {
    await finishSendFailure(batch, error)
    return
  }
  const inFlight = await pool.query(
    `UPDATE notification_attempts SET state = 'in_flight', sent_at = NOW(), lease_until = NOW() + ($1 * INTERVAL '1 millisecond')
     WHERE id = $2 AND state = 'prepared' RETURNING id`,
    [ATTEMPT_LEASE_MS, batch.attemptId],
  )
  if (!inFlight.rowCount) return
  let taskId: string
  try {
    const sent = await client.sendIssueNotification(batch.userIds, message)
    taskId = sent.taskId
  } catch (error) {
    await finishSendFailure(batch, error)
    return
  }
  if (!await persistProviderAccepted(batch, taskId)) return
}

async function claimAcceptedAttempt(): Promise<AcceptedAttempt | null> {
  return withTransaction(async (client) => {
    const result = await client.query<{
      id: string
      outbox_id: string
      delivery_ids: string[]
      recipient_user_ids: string[]
      provider_task_id: string
      check_count: number
    }>(
      `SELECT id, outbox_id, delivery_ids, recipient_user_ids, provider_task_id, check_count
       FROM notification_attempts
       WHERE state = 'provider_accepted' AND next_check_at <= NOW()
         AND (lease_until IS NULL OR lease_until < NOW())
       ORDER BY next_check_at
       FOR UPDATE SKIP LOCKED LIMIT 1`,
    )
    const attempt = result.rows[0]
    if (!attempt) return null
    await client.query(
      `UPDATE notification_attempts SET lease_until = NOW() + ($1 * INTERVAL '1 millisecond') WHERE id = $2`,
      [ATTEMPT_LEASE_MS, attempt.id],
    )
    return {
      id: attempt.id,
      outboxId: attempt.outbox_id,
      deliveryIds: attempt.delivery_ids,
      userIds: attempt.recipient_user_ids,
      taskId: attempt.provider_task_id,
      checkCount: attempt.check_count,
    }
  })
}

async function rescheduleResultCheck(attempt: AcceptedAttempt, error?: unknown) {
  const summary = error ? errorSummary(error) : null
  const nextCount = attempt.checkCount + 1
  if (nextCount >= MAX_RESULT_CHECKS || (summary && !summary.retryable)) {
    await withTransaction(async (client) => {
      await client.query(
        `UPDATE notification_deliveries SET status = 'unknown', lease_owner = NULL, lease_until = NULL,
           last_error_code = $1, last_error_message = $2, updated_at = NOW()
         WHERE id = ANY($3::uuid[])`,
        [summary?.code ?? 'RESULT_CHECK_EXHAUSTED', summary?.message ?? '钉钉发送结果查询超过上限', attempt.deliveryIds],
      )
      await client.query(
        `UPDATE notification_attempts SET state = 'unknown', outcome = 'result_unknown', check_count = $1,
           provider_error_code = $2, response_summary = $3::jsonb, finished_at = NOW(), lease_until = NULL WHERE id = $4`,
        [nextCount, summary?.code, JSON.stringify(summary ?? { code: 'RESULT_CHECK_EXHAUSTED' }), attempt.id],
      )
      await syncOutboxStatus(client, attempt.outboxId)
    })
    return
  }
  const delay = Math.min(5_000 * 2 ** attempt.checkCount, 300_000)
  await pool.query(
    `UPDATE notification_attempts SET check_count = $1, next_check_at = NOW() + ($2 * INTERVAL '1 millisecond'),
       provider_error_code = $3, response_summary = $4::jsonb, lease_until = NULL WHERE id = $5`,
    [nextCount, delay, summary?.code, JSON.stringify(summary), attempt.id],
  )
}

async function checkAcceptedAttempt(client: DingTalkClient, attempt: AcceptedAttempt) {
  try {
    const progress = await client.getSendProgress(attempt.taskId)
    if (progress.status !== 2) {
      await rescheduleResultCheck(attempt)
      return
    }
    const result = await client.getSendResult(attempt.taskId, attempt.userIds)
    await withTransaction(async (db) => {
      let nonSuccessCount = 0
      let unclassifiedCount = 0
      for (const [index, deliveryId] of attempt.deliveryIds.entries()) {
        const userId = attempt.userIds[index]
        const current = await db.query<{ attempt_count: number }>('SELECT attempt_count FROM notification_deliveries WHERE id = $1 FOR UPDATE', [deliveryId])
        if (!current.rowCount) continue
        const classified = classifyDingTalkRecipient(result, userId, current.rows[0].attempt_count)
        if (classified.status !== 'provider_succeeded') nonSuccessCount += 1
        if (classified.errorCode === 'RECIPIENT_RESULT_MISSING') unclassifiedCount += 1
        const nextAttemptAt = new Date(Date.now() + classified.retryDelayMs)
        await db.query(
          `UPDATE notification_deliveries SET status = $1, next_attempt_at = $2, lease_owner = NULL, lease_until = NULL,
             last_error_code = $3, last_error_message = $4, updated_at = NOW() WHERE id = $5`,
          [classified.status, nextAttemptAt, classified.errorCode, classified.errorMessage, deliveryId],
        )
      }
      await db.query(
        `UPDATE notification_attempts SET state = 'completed', outcome = $1, response_summary = $2::jsonb,
           finished_at = NOW(), lease_until = NULL WHERE id = $3`,
        [nonSuccessCount ? 'partial' : 'provider_succeeded', JSON.stringify({ failed: result.failedUserIds.length, forbidden: result.forbiddenUserIds.length, invalid: result.invalidUserIds.length, read: result.readUserIds.length, unread: result.unreadUserIds.length, unclassified: unclassifiedCount }), attempt.id],
      )
      await syncOutboxStatus(db, attempt.outboxId)
    })
  } catch (error) {
    await rescheduleResultCheck(attempt, error)
  }
}

export class DingTalkNotificationWorker {
  private readonly client = new DingTalkClient(config.dingtalk)
  private readonly workerId = `tracebug-${process.pid}-${randomUUID()}`
  private timer: NodeJS.Timeout | null = null
  private activeRun: Promise<void> | null = null
  private stopping = false

  start() {
    validateDingTalkSettings(config.dingtalk, config.dingtalk.enabled, config.publicAppOrigin)
    if (!config.dingtalk.enabled) {
      console.log('[dingtalk] notifications disabled')
      return
    }
    console.log(`[dingtalk] notification worker started mode=${config.dingtalk.dryRun ? 'dry-run' : 'live'}`)
    this.timer = setInterval(() => this.wake(), config.dingtalk.workerPollMs)
    this.timer.unref()
    this.wake()
  }

  wake() {
    if (this.stopping || this.activeRun) return
    this.activeRun = this.runCycle()
      .catch((error) => console.error(`[dingtalk] worker cycle failed: ${error instanceof Error ? error.message : 'unknown error'}`))
      .finally(() => { this.activeRun = null })
  }

  private async runCycle() {
    await recoverExpiredLeases()
    for (let index = 0; index < 10; index += 1) {
      const accepted = await claimAcceptedAttempt()
      if (accepted) {
        await checkAcceptedAttempt(this.client, accepted)
        continue
      }
      const batch = await claimPendingBatch(this.workerId)
      if (!batch) break
      await sendBatch(this.client, batch)
    }
  }

  async stop() {
    this.stopping = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    await this.activeRun
  }
}

let worker: DingTalkNotificationWorker | null = null

export function startDingTalkNotificationWorker() {
  worker = new DingTalkNotificationWorker()
  worker.start()
  return worker
}

export function wakeDingTalkNotificationWorker() {
  worker?.wake()
}
