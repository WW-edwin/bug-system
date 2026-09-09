import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import { pool } from './db.js'
import { lockDictionaries } from './dictionaries.js'

export type NotificationRecipientRole = 'assignee' | 'reporter'
export interface NotificationRule {
  id: string
  name: string
  enabled: boolean
  trigger: 'created' | 'status_changed'
  targetStatus: string | null
  recipients: NotificationRecipientRole[]
}
export interface NotificationRuleSettings {
  version: number
  rules: NotificationRule[]
  updatedAt: string
  updatedBy: string | null
}

export const notificationRulesUpdateSchema = z.object({
  version: z.number().int().positive(),
  rules: z.array(z.object({
    id: z.string().uuid('规则编号无效').optional(),
    name: z.string().trim().min(1, '请填写规则名称').max(80, '规则名称不能超过 80 个字符'),
    enabled: z.boolean(),
    trigger: z.enum(['created', 'status_changed']),
    targetStatus: z.string().min(1).max(160).nullable(),
    recipients: z.array(z.enum(['assignee', 'reporter']))
      .min(1, '请至少选择一类接收人').max(2)
      .refine((roles) => new Set(roles).size === roles.length, '接收人类型不能重复'),
  }).strict()).max(50, '最多配置 50 条通知规则'),
}).strict()

function fail(message: string, status = 400): never { throw Object.assign(new Error(message), { status }) }

export async function loadNotificationRuleSettings(query: Pool | PoolClient = pool): Promise<NotificationRuleSettings> {
  const result = await query.query(`SELECT s.version, s.rules, s.updated_at, u.display_name AS updated_by_name
    FROM notification_rule_settings s LEFT JOIN app_users u ON u.id = s.updated_by WHERE s.id = 1`)
  const row = result.rows[0]
  if (!row) throw new Error('通知规则尚未初始化')
  return { version: row.version, rules: row.rules, updatedAt: new Date(row.updated_at).toISOString(), updatedBy: row.updated_by_name }
}

export async function saveNotificationRuleSettings(client: PoolClient, actorId: string, input: z.infer<typeof notificationRulesUpdateSchema>) {
  // Dictionary writers lock these rows too. Validate targets against the same dictionary snapshot as the save.
  const { dictionaries } = await lockDictionaries(client)
  const current = await client.query('SELECT version FROM notification_rule_settings WHERE id = 1 FOR UPDATE')
  if (current.rows[0]?.version !== input.version) fail('通知规则已被其他管理员更新，请重新加载后再保存', 409)
  const ids = new Set<string>()
  const rules: NotificationRule[] = input.rules.map((rule) => {
    const id = rule.id ?? randomUUID()
    if (ids.has(id)) fail('规则编号不能重复')
    ids.add(id)
    if (rule.trigger === 'created' && rule.targetStatus !== null) fail('新建缺陷规则不需要设置流转目标状态')
    if (rule.trigger === 'status_changed') {
      const target = dictionaries.status.find((item) => item.value === rule.targetStatus)
      if (!target) fail('请选择系统中存在的目标状态')
      if (rule.enabled && !target.active) fail(`目标状态“${target.label}”已停用，请选择启用状态或关闭这条规则`)
    }
    return { ...rule, id, recipients: (['assignee', 'reporter'] as const).filter((role) => rule.recipients.includes(role)) }
  })
  await client.query(`UPDATE notification_rule_settings SET rules = $1::jsonb, version = version + 1,
    updated_by = $2, updated_at = NOW() WHERE id = 1`, [JSON.stringify(rules), actorId])
  return loadNotificationRuleSettings(client)
}
