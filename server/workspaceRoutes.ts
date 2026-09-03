import { randomUUID } from 'node:crypto'
import { mkdir, unlink, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { Router } from 'express'
import multer from 'multer'
import { pinyin } from 'pinyin-pro'
import type { PoolClient } from 'pg'
import sanitizeHtml from 'sanitize-html'
import { z } from 'zod'
import { requireAdmin, requireAuth } from './auth.js'
import { config } from './config.js'
import { pool, withTransaction } from './db.js'

const router = Router()
const projectColors = ['#d94841', '#287a64', '#3367a8', '#9a6423', '#775595']
const statuses = ['待处理', '处理中', '待复测', '已修复', '不适用', '不解决'] as const
const priorities = ['P0', 'P1', 'P2', 'P3'] as const

router.use(requireAuth)

function validationError(error: z.ZodError) {
  return error.issues[0]?.message ?? '输入内容无效'
}

function cleanRichText(value: string) {
  return sanitizeHtml(value, {
    allowedTags: ['p', 'br', 'strong', 'em', 'h2', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'img', 'video', 'a'],
    allowedAttributes: {
      img: ['src', 'alt', 'title', 'data-name', 'data-type', 'data-size'],
      video: ['src', 'controls', 'preload', 'data-name', 'data-type', 'data-size'],
      a: ['href', 'title', 'download', 'data-attachment', 'data-name', 'data-type', 'data-size'],
    },
    allowedSchemes: ['http', 'https'],
    allowProtocolRelative: false,
  }) || '<p></p>'
}

function uploadFilenames(descriptions: string[]) {
  const filenames = new Set<string>()
  const pattern = /\/uploads\/([a-f0-9-]+\.[a-z0-9]{1,10})/gi
  descriptions.forEach((description) => {
    for (const match of description.matchAll(pattern)) filenames.add(match[1])
  })
  return [...filenames]
}

async function removeUploadFiles(filenames: string[]) {
  await Promise.all(filenames.map((filename) => unlink(join(config.uploadsDir, filename)).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') console.warn(`[uploads] unable to remove ${filename}: ${error.message}`)
  })))
}

function toIso(value: Date | string) {
  return new Date(value).toISOString()
}

export async function loadWorkspace() {
  const [projectsResult, issuesResult, activitiesResult, assigneesResult] = await Promise.all([
    pool.query(
      `SELECT p.id, p.project_key, p.name, p.description, p.color,
              COALESCE(ARRAY_AGG(u.display_name ORDER BY pm.joined_at) FILTER (WHERE u.id IS NOT NULL), ARRAY[]::varchar[]) AS members
       FROM projects p
       LEFT JOIN project_members pm ON pm.project_id = p.id
       LEFT JOIN app_users u ON u.id = pm.user_id AND u.active = TRUE
       GROUP BY p.id ORDER BY p.created_at ASC`,
    ),
    pool.query(
      `SELECT i.id AS database_id, i.issue_key, i.project_id, i.title, i.description, i.status, i.priority,
              i.module, i.environment, reporter.display_name AS reporter,
              modifier.display_name AS last_modified_by, i.created_at, i.updated_at
       FROM issues i
       JOIN app_users reporter ON reporter.id = i.reporter_id
       JOIN app_users modifier ON modifier.id = i.last_modified_by
       ORDER BY i.updated_at DESC`,
    ),
    pool.query(
      `SELECT a.id, a.issue_id, actor.display_name AS actor, a.action, a.detail, a.kind, a.created_at
       FROM issue_activities a
       JOIN app_users actor ON actor.id = a.actor_id
       ORDER BY a.created_at DESC`,
    ),
    pool.query(
      `SELECT ia.issue_id, ia.user_id, user_account.display_name AS name
       FROM issue_assignees ia
       JOIN app_users user_account ON user_account.id = ia.user_id
       ORDER BY ia.issue_id, ia.position, ia.assigned_at, user_account.display_name`,
    ),
  ])

  const activitiesByIssue = new Map<string, unknown[]>()
  for (const row of activitiesResult.rows) {
    const activities = activitiesByIssue.get(row.issue_id) ?? []
    activities.push({ id: row.id, actor: row.actor, action: row.action, detail: row.kind === 'commented' ? cleanRichText(row.detail) : row.detail, kind: row.kind, timestamp: toIso(row.created_at) })
    activitiesByIssue.set(row.issue_id, activities)
  }

  const assigneesByIssue = new Map<string, Array<{ id: string; name: string }>>()
  for (const row of assigneesResult.rows) {
    const assignees = assigneesByIssue.get(row.issue_id) ?? []
    assignees.push({ id: row.user_id, name: row.name })
    assigneesByIssue.set(row.issue_id, assignees)
  }

  const issuesByProject = new Map<string, unknown[]>()
  for (const row of issuesResult.rows) {
    const issues = issuesByProject.get(row.project_id) ?? []
    const assignees = assigneesByIssue.get(row.database_id) ?? []
    issues.push({
      id: row.issue_key,
      title: row.title,
      description: row.description,
      status: row.status,
      priority: row.priority,
      module: row.module,
      environment: row.environment,
      reporter: row.reporter,
      assigneeIds: assignees.map((assignee) => assignee.id),
      assignees: assignees.map((assignee) => assignee.name),
      assigneeId: assignees[0]?.id,
      assignee: assignees[0]?.name,
      lastModifiedBy: row.last_modified_by,
      createdAt: toIso(row.created_at),
      updatedAt: toIso(row.updated_at),
      activities: activitiesByIssue.get(row.database_id) ?? [],
    })
    issuesByProject.set(row.project_id, issues)
  }

  return {
    projects: projectsResult.rows.map((row) => ({
      id: row.id,
      key: row.project_key,
      name: row.name,
      description: row.description,
      color: row.color,
      members: row.members,
      issues: issuesByProject.get(row.id) ?? [],
    })),
  }
}

async function findIssue(issueKey: string) {
  const workspace = await loadWorkspace()
  const issues = workspace.projects.flatMap((project) => project.issues) as Array<{ id: string; [key: string]: unknown }>
  return issues.find((issue) => issue.id === issueKey)
}

router.get('/workspace', async (_request, response) => {
  response.json(await loadWorkspace())
})

router.get('/user-options', async (_request, response) => {
  const result = await pool.query('SELECT id, display_name AS name FROM app_users WHERE active = TRUE ORDER BY display_name ASC')
  response.json({ users: result.rows.map((user) => ({
    ...user,
    pinyin: pinyin(user.name, { toneType: 'none' }).replace(/\s+/g, '').toLowerCase(),
    initials: pinyin(user.name, { pattern: 'first', toneType: 'none' }).replace(/\s+/g, '').toLowerCase(),
  })) })
})

const projectSchema = z.object({
  name: z.string().trim().min(1, '请输入项目名称').max(100),
  key: z.string().trim().min(2).max(8).regex(/^[A-Za-z0-9]+$/, '项目标识只能包含字母和数字'),
  description: z.string().trim().max(500).default(''),
})

router.post('/projects', async (request, response) => {
  const parsed = projectSchema.safeParse(request.body)
  if (!parsed.success) return response.status(400).json({ error: validationError(parsed.error) })
  try {
    const projectId = randomUUID()
    await withTransaction(async (client) => {
      const count = await client.query('SELECT COUNT(*)::int AS count FROM projects')
      const color = projectColors[count.rows[0].count % projectColors.length]
      await client.query(
        `INSERT INTO projects (id, project_key, name, description, color, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [projectId, parsed.data.key.toUpperCase(), parsed.data.name, parsed.data.description, color, request.auth!.user.id],
      )
      await client.query('INSERT INTO project_members (project_id, user_id) VALUES ($1, $2)', [projectId, request.auth!.user.id])
    })
    const workspace = await loadWorkspace()
    response.status(201).json({ project: workspace.projects.find((project) => project.id === projectId) })
  } catch (error) {
    if ((error as { code?: string }).code === '23505') return response.status(409).json({ error: '项目标识已存在' })
    throw error
  }
})

router.delete('/projects/:projectId', requireAdmin, async (request, response) => {
  const result = await withTransaction(async (client) => {
    const project = await client.query('SELECT id FROM projects WHERE id = $1 FOR UPDATE', [request.params.projectId])
    if (!project.rowCount) return null
    const descriptions = await client.query(
      `SELECT i.description AS content FROM issues i WHERE i.project_id = $1
       UNION ALL
       SELECT a.detail AS content FROM issue_activities a JOIN issues i ON i.id = a.issue_id WHERE i.project_id = $1 AND a.kind = 'commented'`,
      [request.params.projectId],
    )
    await client.query('DELETE FROM projects WHERE id = $1', [request.params.projectId])
    return uploadFilenames(descriptions.rows.map((row) => row.content))
  })
  if (!result) return response.status(404).json({ error: '项目不存在' })
  await removeUploadFiles(result)
  response.json({ deleted: true })
})

const assigneeIdsSchema = z.array(z.string().uuid('请选择有效的负责人'))
  .min(1, '请至少选择一名负责人')
  .max(50, '单个缺陷最多选择 50 名负责人')
  .transform((ids) => [...new Set(ids)])

async function loadAssigneeUsers(client: PoolClient, ids: string[], allowedInactiveIds: string[] = []) {
  const result = await client.query(
    `SELECT id, display_name
     FROM app_users
     WHERE id = ANY($1::uuid[]) AND (active = TRUE OR id = ANY($2::uuid[]))
     ORDER BY array_position($1::uuid[], id)`,
    [ids, allowedInactiveIds],
  )
  if (result.rows.length !== ids.length) {
    const error = Object.assign(new Error('负责人不存在或已停用'), { status: 400 })
    throw error
  }
  return result.rows as Array<{ id: string; display_name: string }>
}

function sameMemberSet(left: string[], right: string[]) {
  return left.length === right.length && left.every((id) => right.includes(id))
}

const issueSchema = z.object({
  title: z.string().trim().min(1, '请输入缺陷标题').max(40, '缺陷标题不能超过 40 个字符'),
  description: z.string().max(100_000).default('<p></p>'),
  status: z.enum(statuses).default('待处理'),
  priority: z.enum(priorities),
  module: z.string().trim().max(100).default('未分类'),
  environment: z.string().trim().max(160).default('未注明'),
  assigneeIds: assigneeIdsSchema,
})

function currentMonthDay() {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: config.appTimeZone, month: '2-digit', day: '2-digit' }).formatToParts(new Date())
  const month = parts.find((part) => part.type === 'month')!.value
  const day = parts.find((part) => part.type === 'day')!.value
  return `${month}${day}`
}

router.post('/projects/:projectId/issues', async (request, response) => {
  const parsed = issueSchema.safeParse(request.body)
  if (!parsed.success) return response.status(400).json({ error: validationError(parsed.error) })
  const issueKey = await withTransaction(async (client) => {
    const projectResult = await client.query('SELECT project_key FROM projects WHERE id = $1 FOR UPDATE', [request.params.projectId])
    if (!projectResult.rowCount) return null
    const assignees = await loadAssigneeUsers(client, parsed.data.assigneeIds)
    const monthDay = currentMonthDay()
    const counterResult = await client.query(
      `INSERT INTO issue_counters (project_id, month_day, value) VALUES ($1, $2, 1)
       ON CONFLICT (project_id, month_day) DO UPDATE SET value = issue_counters.value + 1
       RETURNING value`,
      [request.params.projectId, monthDay],
    )
    const key = `${projectResult.rows[0].project_key}-${monthDay}-${String(counterResult.rows[0].value).padStart(3, '0')}`
    const issueId = randomUUID()
    await client.query(
      `INSERT INTO issues (id, issue_key, project_id, title, description, status, priority, module, environment, reporter_id, assignee_id, last_modified_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $10)`,
      [issueId, key, request.params.projectId, parsed.data.title, cleanRichText(parsed.data.description), parsed.data.status, parsed.data.priority, parsed.data.module || '未分类', parsed.data.environment || '未注明', request.auth!.user.id, parsed.data.assigneeIds[0]],
    )
    for (const [position, assigneeId] of parsed.data.assigneeIds.entries()) {
      await client.query(
        'INSERT INTO issue_assignees (issue_id, user_id, position) VALUES ($1, $2, $3)',
        [issueId, assigneeId, position],
      )
    }
    await client.query(
      `INSERT INTO issue_activities (id, issue_id, actor_id, action, detail, kind)
       VALUES ($1, $2, $3, '创建了缺陷', $4, 'created')`,
      [randomUUID(), issueId, request.auth!.user.id, `优先级 ${parsed.data.priority} · 负责人 ${assignees.map((assignee) => assignee.display_name).join('、')} · 创建人 ${request.auth!.user.name}`],
    )
    await client.query(
      `INSERT INTO project_members (project_id, user_id)
       SELECT $1, member_id FROM unnest($2::uuid[]) AS member_id
       ON CONFLICT DO NOTHING`,
      [request.params.projectId, [...new Set([request.auth!.user.id, ...parsed.data.assigneeIds])]],
    )
    return key
  })
  if (!issueKey) return response.status(404).json({ error: '项目不存在' })
  response.status(201).json({ issue: await findIssue(issueKey) })
})

const updateSchema = z.object({
  title: z.string().trim().min(1).max(40, '缺陷标题不能超过 40 个字符').optional(),
  description: z.string().max(100_000).optional(),
  status: z.enum(statuses).optional(),
  priority: z.enum(priorities).optional(),
  module: z.string().trim().min(1).max(100).optional(),
  assigneeIds: assigneeIdsSchema.optional(),
}).refine((value) => Object.keys(value).length > 0, '没有需要更新的字段')

router.patch('/issues/:issueKey', async (request, response) => {
  const parsed = updateSchema.safeParse(request.body)
  if (!parsed.success) return response.status(400).json({ error: validationError(parsed.error) })
  const updated = await withTransaction(async (client) => {
    const currentResult = await client.query(
      'SELECT i.* FROM issues i WHERE i.issue_key = $1 FOR UPDATE OF i',
      [request.params.issueKey],
    )
    if (!currentResult.rowCount) return null
    const current = currentResult.rows[0]
    const currentAssigneeResult = await client.query(
      `SELECT user_account.id, user_account.display_name
       FROM issue_assignees ia
       JOIN app_users user_account ON user_account.id = ia.user_id
       WHERE ia.issue_id = $1
       ORDER BY ia.position, ia.assigned_at, user_account.display_name`,
      [current.id],
    )
    const currentAssignees = currentAssigneeResult.rows.length
      ? currentAssigneeResult.rows as Array<{ id: string; display_name: string }>
      : await loadAssigneeUsers(client, [current.assignee_id], [current.assignee_id])
    const currentAssigneeIds = currentAssignees.map((assignee) => assignee.id)
    const next = { ...parsed.data, description: parsed.data.description === undefined ? undefined : cleanRichText(parsed.data.description) }
    const activities: Array<{ action: string; detail: string }> = []
    const labels: Record<string, string> = { status: '状态', priority: '优先级', module: '所属模块' }
    for (const field of ['status', 'priority', 'module'] as const) {
      if (next[field] !== undefined && next[field] !== current[field]) {
        activities.push({ action: `更新了${labels[field]}`, detail: `${current[field]} → ${next[field]}` })
      }
    }
    if ((next.title !== undefined && next.title !== current.title) || (next.description !== undefined && next.description !== current.description)) {
      activities.push({ action: '编辑了缺陷内容', detail: '更新了标题或问题描述' })
    }
    let nextAssigneeIds: string[] | undefined
    if (next.assigneeIds !== undefined && !sameMemberSet(next.assigneeIds, currentAssigneeIds)) {
      const nextAssignees = await loadAssigneeUsers(client, next.assigneeIds, currentAssigneeIds)
      nextAssigneeIds = next.assigneeIds
      activities.push({
        action: '更新了负责人',
        detail: `${currentAssignees.map((assignee) => assignee.display_name).join('、')} → ${nextAssignees.map((assignee) => assignee.display_name).join('、')}`,
      })
    }
    if (!activities.length) return { removedFiles: [] as string[] }
    if (nextAssigneeIds) {
      await client.query('DELETE FROM issue_assignees WHERE issue_id = $1', [current.id])
      for (const [position, assigneeId] of nextAssigneeIds.entries()) {
        await client.query(
          'INSERT INTO issue_assignees (issue_id, user_id, position) VALUES ($1, $2, $3)',
          [current.id, assigneeId, position],
        )
      }
    }
    await client.query(
      `UPDATE issues SET title = COALESCE($1, title), description = COALESCE($2, description),
       status = COALESCE($3, status), priority = COALESCE($4, priority), module = COALESCE($5, module),
       assignee_id = COALESCE($6, assignee_id), last_modified_by = $7, updated_at = NOW() WHERE id = $8`,
      [next.title, next.description, next.status, next.priority, next.module, nextAssigneeIds?.[0], request.auth!.user.id, current.id],
    )
    for (const activity of activities) {
      await client.query(
        `INSERT INTO issue_activities (id, issue_id, actor_id, action, detail, kind)
         VALUES ($1, $2, $3, $4, $5, 'changed')`,
        [randomUUID(), current.id, request.auth!.user.id, activity.action, activity.detail],
      )
    }
    await client.query(
      `INSERT INTO project_members (project_id, user_id)
       SELECT $1, member_id FROM unnest($2::uuid[]) AS member_id
       ON CONFLICT DO NOTHING`,
      [current.project_id, [...new Set([request.auth!.user.id, ...(nextAssigneeIds ?? [])])]],
    )
    const removedFiles = next.description === undefined
      ? []
      : uploadFilenames([current.description]).filter((filename) => !uploadFilenames([next.description!]).includes(filename))
    return { removedFiles }
  })
  if (!updated) return response.status(404).json({ error: '缺陷不存在' })
  await removeUploadFiles(updated.removedFiles)
  response.json({ issue: await findIssue(request.params.issueKey) })
})

router.post('/issues/:issueKey/comments', async (request, response) => {
  const parsed = z.object({ comment: z.string().trim().min(1, '请输入评论').max(100_000) }).safeParse(request.body)
  if (!parsed.success) return response.status(400).json({ error: validationError(parsed.error) })
  const updated = await withTransaction(async (client) => {
    const result = await client.query('SELECT id, project_id FROM issues WHERE issue_key = $1 FOR UPDATE', [request.params.issueKey])
    if (!result.rowCount) return false
    const issue = result.rows[0]
    await client.query('UPDATE issues SET last_modified_by = $1, updated_at = NOW() WHERE id = $2', [request.auth!.user.id, issue.id])
    await client.query(
      `INSERT INTO issue_activities (id, issue_id, actor_id, action, detail, kind)
       VALUES ($1, $2, $3, '添加了评论', $4, 'commented')`,
      [randomUUID(), issue.id, request.auth!.user.id, cleanRichText(parsed.data.comment)],
    )
    await client.query('INSERT INTO project_members (project_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [issue.project_id, request.auth!.user.id])
    return true
  })
  if (!updated) return response.status(404).json({ error: '缺陷不存在' })
  response.status(201).json({ issue: await findIssue(request.params.issueKey) })
})

router.delete('/issues/:issueKey', async (request, response) => {
  const result = await withTransaction(async (client) => {
    const issue = await client.query('SELECT id, description FROM issues WHERE issue_key = $1 FOR UPDATE', [request.params.issueKey])
    if (!issue.rowCount) return null
    const comments = await client.query("SELECT detail FROM issue_activities WHERE issue_id = $1 AND kind = 'commented'", [issue.rows[0].id])
    await client.query('DELETE FROM issues WHERE id = $1', [issue.rows[0].id])
    return uploadFilenames([issue.rows[0].description, ...comments.rows.map((row) => row.detail)])
  })
  if (!result) return response.status(404).json({ error: '缺陷不存在' })
  await removeUploadFiles(result)
  response.json({ deleted: true })
})

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024, files: 1 },
})

function detectImage(buffer: Buffer) {
  if (buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return { ext: '.jpg', type: 'image/jpeg' }
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { ext: '.png', type: 'image/png' }
  if (buffer.subarray(0, 6).toString('ascii').match(/^GIF8[79]a$/)) return { ext: '.gif', type: 'image/gif' }
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return { ext: '.webp', type: 'image/webp' }
  return null
}

const fileTypes: Record<string, { type: string; signature: 'pdf' | 'zip' | 'ole' | '7z' | 'rar' | 'text' }> = {
  '.pdf': { type: 'application/pdf', signature: 'pdf' },
  '.docx': { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', signature: 'zip' },
  '.xlsx': { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', signature: 'zip' },
  '.pptx': { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', signature: 'zip' },
  '.doc': { type: 'application/msword', signature: 'ole' },
  '.xls': { type: 'application/vnd.ms-excel', signature: 'ole' },
  '.ppt': { type: 'application/vnd.ms-powerpoint', signature: 'ole' },
  '.txt': { type: 'text/plain', signature: 'text' },
  '.csv': { type: 'text/csv', signature: 'text' },
  '.md': { type: 'text/markdown', signature: 'text' },
  '.zip': { type: 'application/zip', signature: 'zip' },
  '.7z': { type: 'application/x-7z-compressed', signature: '7z' },
  '.rar': { type: 'application/vnd.rar', signature: 'rar' },
}

function matchesFileSignature(buffer: Buffer, signature: (typeof fileTypes)[string]['signature']) {
  if (signature === 'pdf') return buffer.subarray(0, 5).toString('ascii') === '%PDF-'
  if (signature === 'zip') return buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) || buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  if (signature === 'ole') return buffer.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))
  if (signature === '7z') return buffer.subarray(0, 6).equals(Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]))
  if (signature === 'rar') return buffer.subarray(0, 7).toString('binary') === 'Rar!\x1a\x07\x00' || buffer.subarray(0, 8).toString('binary') === 'Rar!\x1a\x07\x01\x00'
  return !buffer.subarray(0, Math.min(buffer.length, 8192)).includes(0)
}

function detectEvidence(file: Express.Multer.File) {
  const image = detectImage(file.buffer)
  if (image) return file.size <= 5 * 1024 * 1024 ? { ...image, kind: 'image' as const } : { error: '图片不能超过 5MB' }
  const extension = extname(file.originalname).toLowerCase()
  const isFtypVideo = file.buffer.subarray(4, 8).toString('ascii') === 'ftyp'
  const isWebm = file.buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))
  if ((extension === '.mp4' && isFtypVideo) || (extension === '.mov' && isFtypVideo) || (extension === '.webm' && isWebm)) {
    const type = extension === '.webm' ? 'video/webm' : extension === '.mov' ? 'video/quicktime' : 'video/mp4'
    return { ext: extension, type, kind: 'video' as const }
  }
  const fileType = fileTypes[extension]
  if (!fileType || !matchesFileSignature(file.buffer, fileType.signature)) return { error: '仅支持常见图片、MP4/WebM/MOV 视频、PDF、Office、文本、CSV 和压缩文件' }
  if (file.size > 20 * 1024 * 1024) return { error: '普通文件不能超过 20MB' }
  return { ext: extension, type: fileType.type, kind: 'file' as const }
}

function cleanOriginalName(value: string) {
  return basename(value).replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_').slice(0, 180) || '未命名文件'
}

router.post('/uploads', upload.fields([{ name: 'file', maxCount: 1 }, { name: 'image', maxCount: 1 }]), async (request, response) => {
  const fields = request.files as Record<string, Express.Multer.File[]> | undefined
  const file = fields?.file?.[0] ?? fields?.image?.[0]
  if (!file) return response.status(400).json({ error: '请选择证据文件' })
  const evidence = detectEvidence(file)
  if ('error' in evidence) return response.status(400).json({ error: evidence.error })
  await mkdir(config.uploadsDir, { recursive: true })
  const filename = `${randomUUID()}${evidence.ext}`
  await writeFile(join(config.uploadsDir, filename), file.buffer, { flag: 'wx' })
  response.status(201).json({ url: `/uploads/${filename}`, name: cleanOriginalName(file.originalname), type: evidence.type, kind: evidence.kind, size: file.size })
})

export default router
