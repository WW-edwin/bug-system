import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { config } from './config.js'
import { DingTalkApiError, DingTalkClient, type DingTalkDirectorySnapshot, type DingTalkDirectoryUser } from './dingtalkClient.js'
import { pool, withTransaction } from './db.js'

type BindingSource = 'manual' | 'email_sync' | 'self_service' | null

export interface SyncAppUser {
  id: string
  name: string
  email: string | null
  dingtalkCorpId: string | null
  dingtalkUserId: string | null
  dingtalkUnionId: string | null
  dingtalkStatus: 'matched' | 'unmatched' | 'conflict' | 'disabled'
  dingtalkSource: BindingSource
  dingtalkBindingVersion: number
}

export type BindingPlanItem =
  | { kind: 'matched'; appUser: SyncAppUser; directoryUser: DingTalkDirectoryUser }
  | { kind: 'manual_kept'; appUser: SyncAppUser }
  | { kind: 'unmatched'; appUser: SyncAppUser; reason: string }
  | { kind: 'conflict'; appUser: SyncAppUser; reason: string }

export interface DingTalkSyncResult {
  runId: string
  departmentsScanned: number
  directoryUsers: number
  directoryUsersWithEmail: number
  appUsers: number
  matched: number
  updated: number
  unmatched: number
  conflicts: number
  manualKept: number
  unmatchedUsers: Array<{ id: string; name: string; email: string | null; reason: string }>
  conflictUsers: Array<{ id: string; name: string; email: string | null; reason: string }>
  completedAt: string
}

export class DingTalkSyncError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'DingTalkSyncError'
  }
}

export function normalizeDirectoryEmail(value: string | null | undefined) {
  const normalized = value?.trim().toLowerCase() ?? ''
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) ? normalized : ''
}

export function planDingTalkEmailBindings(appUsers: SyncAppUser[], directoryUsers: DingTalkDirectoryUser[]): BindingPlanItem[] {
  const activeDirectoryUsers = new Map(directoryUsers.filter((user) => user.active).map((user) => [user.userId, user]))
  const usersByEmail = new Map<string, Set<string>>()
  for (const user of activeDirectoryUsers.values()) {
    const emails = new Set([normalizeDirectoryEmail(user.email), normalizeDirectoryEmail(user.orgEmail)].filter(Boolean))
    for (const email of emails) {
      const userIds = usersByEmail.get(email) ?? new Set<string>()
      userIds.add(user.userId)
      usersByEmail.set(email, userIds)
    }
  }

  const protectedBindings = new Map<string, string>()
  for (const appUser of appUsers) {
    if (appUser.dingtalkUserId && appUser.dingtalkSource && appUser.dingtalkSource !== 'email_sync') {
      protectedBindings.set(appUser.dingtalkUserId, appUser.id)
    }
  }

  const tentative = new Map<string, string>()
  const initial = new Map<string, BindingPlanItem>()
  for (const appUser of appUsers) {
    if (appUser.dingtalkUserId && appUser.dingtalkSource && appUser.dingtalkSource !== 'email_sync') {
      initial.set(appUser.id, { kind: 'manual_kept', appUser })
      continue
    }
    const email = normalizeDirectoryEmail(appUser.email)
    if (!email) {
      initial.set(appUser.id, { kind: 'unmatched', appUser, reason: '系统账号缺少有效邮箱' })
      continue
    }
    const candidates = [...(usersByEmail.get(email) ?? [])]
    if (!candidates.length) {
      initial.set(appUser.id, { kind: 'unmatched', appUser, reason: '钉钉通讯录没有相同邮箱' })
      continue
    }
    if (candidates.length > 1) {
      initial.set(appUser.id, { kind: 'conflict', appUser, reason: '同一邮箱对应多个钉钉用户' })
      continue
    }
    const candidateId = candidates[0]
    const protectedOwner = protectedBindings.get(candidateId)
    if (protectedOwner && protectedOwner !== appUser.id) {
      initial.set(appUser.id, { kind: 'conflict', appUser, reason: '钉钉用户已被受保护绑定占用' })
      continue
    }
    tentative.set(appUser.id, candidateId)
  }

  const ownersByDingTalkUser = new Map<string, string[]>()
  for (const [appUserId, dingTalkUserId] of tentative) {
    const owners = ownersByDingTalkUser.get(dingTalkUserId) ?? []
    owners.push(appUserId)
    ownersByDingTalkUser.set(dingTalkUserId, owners)
  }
  for (const [appUserId, dingTalkUserId] of tentative) {
    const appUser = appUsers.find((user) => user.id === appUserId)!
    if ((ownersByDingTalkUser.get(dingTalkUserId)?.length ?? 0) > 1) {
      initial.set(appUserId, { kind: 'conflict', appUser, reason: '多个系统账号匹配到同一钉钉用户' })
      continue
    }
    initial.set(appUserId, { kind: 'matched', appUser, directoryUser: activeDirectoryUsers.get(dingTalkUserId)! })
  }
  return appUsers.map((user) => initial.get(user.id)!)
}

function errorDetails(error: unknown) {
  if (error instanceof DingTalkSyncError || error instanceof DingTalkApiError) {
    return { code: error.code, message: error.message.slice(0, 500) }
  }
  return { code: 'SYNC_FAILED', message: error instanceof Error ? error.message.slice(0, 500) : '钉钉邮箱同步失败' }
}

async function loadAppUsers(client: PoolClient) {
  const result = await client.query<{
    id: string
    name: string
    email: string | null
    dingtalk_corp_id: string | null
    dingtalk_user_id: string | null
    dingtalk_union_id: string | null
    dingtalk_sync_status: SyncAppUser['dingtalkStatus']
    dingtalk_binding_source: BindingSource
    dingtalk_binding_version: number
  }>(
    `SELECT id, display_name AS name, email, dingtalk_corp_id, dingtalk_user_id, dingtalk_union_id,
            dingtalk_sync_status, dingtalk_binding_source, dingtalk_binding_version
     FROM app_users WHERE active = TRUE ORDER BY created_at FOR UPDATE`,
  )
  return result.rows.map((row): SyncAppUser => ({
    id: row.id,
    name: row.name,
    email: row.email,
    dingtalkCorpId: row.dingtalk_corp_id,
    dingtalkUserId: row.dingtalk_user_id,
    dingtalkUnionId: row.dingtalk_union_id,
    dingtalkStatus: row.dingtalk_sync_status,
    dingtalkSource: row.dingtalk_binding_source,
    dingtalkBindingVersion: row.dingtalk_binding_version,
  }))
}

async function releaseAutoBinding(client: PoolClient, user: SyncAppUser, actorUserId: string, nextStatus: 'unmatched' | 'conflict') {
  if (user.dingtalkUserId) {
    await client.query(
      `INSERT INTO dingtalk_binding_audit
         (id, app_user_id, actor_user_id, action, dingtalk_corp_id, dingtalk_user_id, source)
       VALUES ($1, $2, $3, 'unbound', $4, $5, 'email_sync')`,
      [randomUUID(), user.id, actorUserId, user.dingtalkCorpId, user.dingtalkUserId],
    )
  }
  await client.query(
    `UPDATE app_users SET dingtalk_corp_id = NULL, dingtalk_user_id = NULL, dingtalk_union_id = NULL,
       dingtalk_bound_at = NULL, dingtalk_binding_source = NULL, dingtalk_sync_status = $1,
       dingtalk_binding_version = dingtalk_binding_version + 1,
       dingtalk_last_synced_at = NOW(), updated_at = NOW() WHERE id = $2`,
    [nextStatus, user.id],
  )
}

async function clearAutoBinding(client: PoolClient, item: Extract<BindingPlanItem, { kind: 'unmatched' | 'conflict' }>, actorUserId: string) {
  const user = item.appUser
  const nextStatus = item.kind === 'conflict' ? 'conflict' : 'unmatched'
  if (user.dingtalkSource === 'email_sync' && user.dingtalkUserId) {
    await releaseAutoBinding(client, user, actorUserId, nextStatus)
    return true
  }
  const managedBySync = user.dingtalkSource === 'email_sync'
  const changed = managedBySync || user.dingtalkStatus !== nextStatus
  await client.query(
    `UPDATE app_users SET dingtalk_binding_source = CASE WHEN $1 THEN NULL ELSE dingtalk_binding_source END,
       dingtalk_sync_status = $2,
       dingtalk_binding_version = dingtalk_binding_version + CASE WHEN $3 THEN 1 ELSE 0 END,
       dingtalk_last_synced_at = NOW(), updated_at = CASE WHEN $3 THEN NOW() ELSE updated_at END
     WHERE id = $4`,
    [managedBySync, nextStatus, changed, user.id],
  )
  return changed
}

async function applyMatchedBinding(client: PoolClient, item: Extract<BindingPlanItem, { kind: 'matched' }>, actorUserId: string) {
  const { appUser: user, directoryUser } = item
  const identityChanged = user.dingtalkCorpId !== config.dingtalk.corpId
    || user.dingtalkUserId !== directoryUser.userId
    || user.dingtalkUnionId !== directoryUser.unionId
    || user.dingtalkSource !== 'email_sync'
  const changed = identityChanged || user.dingtalkStatus !== 'matched'
  await client.query(
    `UPDATE app_users SET dingtalk_corp_id = $1, dingtalk_user_id = $2, dingtalk_union_id = $3,
       dingtalk_bound_at = CASE WHEN $4 THEN NOW() ELSE COALESCE(dingtalk_bound_at, NOW()) END,
       dingtalk_binding_source = 'email_sync', dingtalk_sync_status = 'matched',
       dingtalk_binding_version = dingtalk_binding_version + CASE WHEN $5 THEN 1 ELSE 0 END,
       dingtalk_last_synced_at = NOW(), updated_at = CASE WHEN $5 THEN NOW() ELSE updated_at END
     WHERE id = $6`,
    [config.dingtalk.corpId, directoryUser.userId, directoryUser.unionId, identityChanged, changed, user.id],
  )
  if (identityChanged) {
    await client.query(
      `INSERT INTO dingtalk_binding_audit
         (id, app_user_id, actor_user_id, action, dingtalk_corp_id, dingtalk_user_id, source)
       VALUES ($1, $2, $3, 'bound', $4, $5, 'email_sync')`,
      [randomUUID(), user.id, actorUserId, config.dingtalk.corpId, directoryUser.userId],
    )
  }
  return changed
}

export async function syncDingTalkUsersByEmail(client: DingTalkClient, actorUserId: string): Promise<DingTalkSyncResult> {
  if (config.dingtalk.dryRun) throw new DingTalkSyncError('DRY_RUN_SYNC_DISABLED', 'Dry Run 不会写入邮箱绑定')
  const runId = randomUUID()
  await pool.query(
    `INSERT INTO dingtalk_sync_runs (id, initiated_by, status) VALUES ($1, $2, 'running')`,
    [runId, actorUserId],
  )
  let snapshot: DingTalkDirectorySnapshot | null = null
  try {
    snapshot = await client.listDirectoryUsers()
    const directoryUsersWithEmail = snapshot.users.filter((user) => normalizeDirectoryEmail(user.email) || normalizeDirectoryEmail(user.orgEmail)).length
    if (!directoryUsersWithEmail) {
      throw new DingTalkSyncError('DIRECTORY_EMAIL_UNAVAILABLE', '钉钉没有返回任何邮箱，请开通 fieldEmail 权限并确认通讯录已填写邮箱')
    }
    const result = await withTransaction(async (db) => {
      const lock = await db.query<{ locked: boolean }>('SELECT pg_try_advisory_xact_lock($1) AS locked', [8042603])
      if (!lock.rows[0]?.locked) throw new DingTalkSyncError('SYNC_IN_PROGRESS', '已有钉钉邮箱同步正在执行')
      const appUsers = await loadAppUsers(db)
      const plan = planDingTalkEmailBindings(appUsers, snapshot!.users)
      const updatedUserIds = new Set<string>()
      const released = new Set<string>()
      for (const item of plan) {
        const desiredUserId = item.kind === 'matched' ? item.directoryUser.userId : null
        if (item.appUser.dingtalkSource === 'email_sync' && item.appUser.dingtalkUserId && item.appUser.dingtalkUserId !== desiredUserId) {
          await releaseAutoBinding(db, item.appUser, actorUserId, item.kind === 'conflict' ? 'conflict' : 'unmatched')
          released.add(item.appUser.id)
          updatedUserIds.add(item.appUser.id)
        }
      }
      for (const item of plan) {
        if (item.kind === 'matched') {
          const adjusted = released.has(item.appUser.id)
            ? { ...item, appUser: { ...item.appUser, dingtalkCorpId: null, dingtalkUserId: null, dingtalkUnionId: null, dingtalkStatus: 'unmatched' as const, dingtalkSource: null } }
            : item
          if (await applyMatchedBinding(db, adjusted, actorUserId)) updatedUserIds.add(item.appUser.id)
        } else if (item.kind === 'unmatched' || item.kind === 'conflict') {
          if (released.has(item.appUser.id)) continue
          if (await clearAutoBinding(db, item, actorUserId)) updatedUserIds.add(item.appUser.id)
        }
      }
      const completedAt = new Date().toISOString()
      const syncResult: DingTalkSyncResult = {
        runId,
        departmentsScanned: snapshot!.departmentsScanned,
        directoryUsers: snapshot!.users.length,
        directoryUsersWithEmail,
        appUsers: appUsers.length,
        matched: plan.filter((item) => item.kind === 'matched').length,
        updated: updatedUserIds.size,
        unmatched: plan.filter((item) => item.kind === 'unmatched').length,
        conflicts: plan.filter((item) => item.kind === 'conflict').length,
        manualKept: plan.filter((item) => item.kind === 'manual_kept').length,
        unmatchedUsers: plan.filter((item): item is Extract<BindingPlanItem, { kind: 'unmatched' }> => item.kind === 'unmatched').map((item) => ({ id: item.appUser.id, name: item.appUser.name, email: item.appUser.email, reason: item.reason })),
        conflictUsers: plan.filter((item): item is Extract<BindingPlanItem, { kind: 'conflict' }> => item.kind === 'conflict').map((item) => ({ id: item.appUser.id, name: item.appUser.name, email: item.appUser.email, reason: item.reason })),
        completedAt,
      }
      await db.query(
        `UPDATE dingtalk_sync_runs SET status = 'succeeded', departments_scanned = $1, directory_users = $2,
           directory_users_with_email = $3, app_users = $4, matched = $5, updated = $6, unmatched = $7,
           conflicts = $8, manual_kept = $9, details = $10::jsonb, completed_at = $11 WHERE id = $12`,
        [syncResult.departmentsScanned, syncResult.directoryUsers, syncResult.directoryUsersWithEmail, syncResult.appUsers, syncResult.matched, syncResult.updated, syncResult.unmatched, syncResult.conflicts, syncResult.manualKept, JSON.stringify({ unmatchedUsers: syncResult.unmatchedUsers, conflictUsers: syncResult.conflictUsers }), completedAt, runId],
      )
      return syncResult
    })
    return result
  } catch (error) {
    const detail = errorDetails(error)
    await pool.query(
      `UPDATE dingtalk_sync_runs SET status = 'failed', departments_scanned = $1, directory_users = $2,
         directory_users_with_email = $3, error_code = $4, error_message = $5, completed_at = NOW() WHERE id = $6`,
      [snapshot?.departmentsScanned ?? 0, snapshot?.users.length ?? 0, snapshot?.users.filter((user) => normalizeDirectoryEmail(user.email) || normalizeDirectoryEmail(user.orgEmail)).length ?? 0, detail.code, detail.message, runId],
    ).catch((updateError) => console.error(`[dingtalk] unable to persist sync failure: ${updateError instanceof Error ? updateError.message : 'unknown database error'}`))
    throw error
  }
}
