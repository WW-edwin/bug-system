import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import { pool } from './db.js'

export const dictionaryKinds = ['status', 'priority', 'environment'] as const
export type DictionaryKind = typeof dictionaryKinds[number]
export type DictionaryEntry = {
  value: string
  label: string
  active: boolean
  isDefault: boolean
  isTerminal: boolean
  weight: number
  showInPersonal: boolean
  position: number
}

export type DictionaryData = {
  dictionaries: Record<DictionaryKind, DictionaryEntry[]>
  dictionaryVersions: Record<DictionaryKind, number>
}

const dictionaryNames: Record<DictionaryKind, string> = { status: '状态', priority: '优先级', environment: '环境' }
export const dictionaryValueSchema = z.string().min(1, '请选择有效的字典值').max(160)
export const dictionaryUpdateSchema = z.object({
  version: z.number().int().positive(),
  deletedValues: z.array(dictionaryValueSchema).max(5000, '单次删除项过多')
    .refine((values) => new Set(values).size === values.length, '删除项不能重复').default([]),
  items: z.array(z.object({
    value: dictionaryValueSchema.optional(),
    label: z.string().min(1, '请输入字典名称').max(160),
    active: z.boolean(),
    isDefault: z.boolean(),
    isTerminal: z.boolean().default(false),
    weight: z.number().int().min(0).max(999999).optional(),
    showInPersonal: z.boolean().optional(),
  })).min(1, '至少保留一个字典项'),
})

function fail(message: string, status = 400): never {
  throw Object.assign(new Error(message), { status })
}

export async function loadDictionaries(query: Pool | PoolClient = pool): Promise<DictionaryData> {
  // A single statement keeps the rows and their optimistic version in the same snapshot.
  const result = await query.query(
    `SELECT s.kind, s.version, e.value, e.label, e.active, e.is_default, e.is_terminal, e.weight, e.show_in_personal, e.position
     FROM issue_dictionary_sets s
     JOIN issue_dictionary_entries e ON e.kind = s.kind
     ORDER BY s.kind, e.weight DESC, e.position, e.value`,
  )
  const dictionaries: DictionaryData['dictionaries'] = { status: [], priority: [], environment: [] }
  const dictionaryVersions: DictionaryData['dictionaryVersions'] = { status: 1, priority: 1, environment: 1 }
  for (const row of result.rows) {
    const kind = row.kind as DictionaryKind
    dictionaryVersions[kind] = row.version
    dictionaries[kind].push({ value: row.value, label: row.label, active: row.active, isDefault: row.is_default, isTerminal: row.is_terminal, weight: row.weight, showInPersonal: row.show_in_personal, position: row.position })
  }
  return { dictionaries, dictionaryVersions }
}

export async function lockDictionaries(client: PoolClient) {
  // Always lock dictionaries before issues/projects; shared locks permit concurrent issue edits.
  await client.query('SELECT kind FROM issue_dictionary_sets ORDER BY kind FOR SHARE')
  return loadDictionaries(client)
}

export function resolveDictionaryValue(data: DictionaryData, kind: DictionaryKind, value?: string, unchangedValue?: string) {
  const items = data.dictionaries[kind]
  if (value === undefined) {
    const defaultItem = items.find((item) => item.active && item.isDefault)
    if (!defaultItem) fail(`${dictionaryNames[kind]}没有可用默认值，请联系管理员`)
    return defaultItem.value
  }
  const item = items.find((entry) => entry.value === value)
  if (!item || (!item.active && value !== unchangedValue)) fail(`${dictionaryNames[kind]}不存在或已停用，请刷新后重新选择`)
  return item.value
}

export function dictionaryLabel(data: DictionaryData, kind: DictionaryKind, value: string) {
  return data.dictionaries[kind].find((entry) => entry.value === value)?.label ?? value
}

export async function updateDictionary(client: PoolClient, kind: DictionaryKind, input: z.infer<typeof dictionaryUpdateSchema>) {
  const versionResult = await client.query('SELECT version FROM issue_dictionary_sets WHERE kind = $1 FOR UPDATE', [kind])
  if (versionResult.rows[0]?.version !== input.version) fail('字典已被其他管理员更新，请刷新后重试', 409)
  const currentData = await loadDictionaries(client)
  const current = new Map(currentData.dictionaries[kind].map((item) => [item.value, item]))
  if (input.items.length > Math.max(100, current.size)) fail('每类字典最多 100 项；超出上限的历史字典只能修改已有项')
  const preparedItems = input.items.map((item) => ({
    ...item,
    // Retain exact imported labels when untouched; normalize only a newly entered name.
    label: item.value !== undefined && current.get(item.value)?.label === item.label ? item.label : item.label.trim(),
    // Old browser tabs omit these fields. Retain administrator settings on existing values.
    weight: item.weight ?? (item.value ? current.get(item.value)?.weight : undefined) ?? 0,
    showInPersonal: item.showInPersonal ?? (item.value ? current.get(item.value)?.showInPersonal : undefined) ?? (kind === 'status' && !item.isTerminal),
  }))
  const values = new Set<string>()
  const labels = new Set<string>()
  for (const item of preparedItems) {
    if (item.value !== undefined) {
      if (!current.has(item.value)) fail('包含不存在的字典项，请刷新后重试')
      if (values.has(item.value)) fail('字典项不能重复')
      values.add(item.value)
    }
    // Old imported free-text environments may exceed 40 characters. Only unchanged legacy labels are retained.
    if (item.label.length > 40 && (!item.value || current.get(item.value)?.label !== item.label)) fail('字典名称不能超过 40 个字符')
    if (!item.label.trim()) fail('请输入字典名称')
    const normalizedLabel = item.label.trim().toLocaleLowerCase()
    if (labels.has(normalizedLabel)) fail('字典名称不能重复')
    labels.add(normalizedLabel)
    if (item.isDefault && !item.active) fail('默认项必须启用')
    if (kind !== 'status' && item.isTerminal) fail('只有状态可以设为结束状态')
    if (kind !== 'status' && item.showInPersonal) fail('只有状态可以设置在个人中心展示')
    if (item.isDefault && item.isTerminal) fail('默认状态不能是结束状态')
  }
  // Omission alone is not deletion: older clients must not accidentally remove entries.
  const deleted = new Set(input.deletedValues)
  for (const value of deleted) {
    if (!current.has(value)) fail('包含不存在的删除项，请刷新后重试')
    if (values.has(value)) fail('同一字典项不能同时保留和删除')
  }
  if ([...current.keys()].some((value) => !values.has(value) && !deleted.has(value))) fail('不能省略已有字典项，请通过删除按钮明确选择要删除的项')
  if (!preparedItems.some((item) => item.active)) fail('至少保留一个启用的字典项')
  if (preparedItems.filter((item) => item.isDefault).length !== 1) fail('必须设置且只能设置一个默认项')

  if (deleted.size) {
    // kind is a validated enum, and all issue writers take this dictionary's shared lock first.
    const references = await client.query<{ value: string; count: number }>(
      `SELECT ${kind} AS value, COUNT(*)::int AS count FROM issues WHERE ${kind} = ANY($1::varchar[]) GROUP BY ${kind}`,
      [[...deleted]],
    )
    if (references.rowCount) {
      const detail = references.rows.map((row) => `“${current.get(row.value)!.label}”（${row.count} 条缺陷）`).join('、')
      fail(`无法删除正在被缺陷使用的${dictionaryNames[kind]}：${detail}。请先调整关联缺陷，或将字典项停用`)
    }
    if (kind === 'status') {
      // Rule writers also take the dictionary lock, so save/delete cannot race into a dangling target.
      const rules = await client.query<{ target: string; count: number }>(
        `SELECT r->>'targetStatus' AS target, COUNT(*)::int AS count
         FROM notification_rule_settings s CROSS JOIN LATERAL jsonb_array_elements(s.rules) r
         WHERE r->>'trigger' = 'status_changed' AND r->>'targetStatus' = ANY($1::text[])
         GROUP BY r->>'targetStatus'`, [[...deleted]],
      )
      if (rules.rowCount) {
        const detail = rules.rows.map((row) => `“${current.get(row.target)!.label}”（${row.count} 条通知规则）`).join('、')
        fail(`无法删除正在被通知规则使用的状态：${detail}。请先修改或删除关联规则；停用规则仍保留关联`)
      }
    }
    await client.query('DELETE FROM issue_dictionary_entries WHERE kind = $1 AND value = ANY($2::varchar[])', [kind, [...deleted]])
  }

  await client.query('UPDATE issue_dictionary_entries SET is_default = FALSE WHERE kind = $1', [kind])
  for (const [position, item] of preparedItems.entries()) {
    await client.query(
      `INSERT INTO issue_dictionary_entries(kind, value, label, active, is_default, is_terminal, position, weight, show_in_personal)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (kind, value) DO UPDATE SET label = EXCLUDED.label, active = EXCLUDED.active,
         is_default = EXCLUDED.is_default, is_terminal = EXCLUDED.is_terminal, position = EXCLUDED.position,
         weight = EXCLUDED.weight, show_in_personal = EXCLUDED.show_in_personal`,
      [kind, item.value ?? randomUUID(), item.label, item.active, item.isDefault, item.isTerminal, position, item.weight, item.showInPersonal],
    )
  }
  await client.query('UPDATE issue_dictionary_sets SET version = version + 1, updated_at = NOW() WHERE kind = $1', [kind])
  return loadDictionaries(client)
}
