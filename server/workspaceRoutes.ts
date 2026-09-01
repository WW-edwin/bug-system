import { randomUUID } from 'node:crypto'
import { mkdir, unlink, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { Router } from 'express'
import multer from 'multer'
import sanitizeHtml from 'sanitize-html'
import { z } from 'zod'
import { requireAdmin, requireAuth } from './auth.js'
import { config } from './config.js'
import { pool, withTransaction } from './db.js'

const router = Router()
const projectColors = ['#d94841', '#287a64', '#3367a8', '#9a6423', '#775595']
const statuses = ['待处理', '处理中', '待复测', '已解决', '不适用', '待优化'] as const
const priorities = ['P0', 'P1', 'P2', 'P3'] as const

router.use(requireAuth)

function validationError(error: z.ZodError) {
  return error.issues[0]?.message ?? '输入内容无效'
}

function cleanRichText(value: string) {
  return sanitizeHtml(value, {
    allowedTags: ['p', 'br', 'strong', 'em', 'h2', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'img'],
    allowedAttributes: { img: ['src', 'alt', 'title'] },
    allowedSchemes: ['http', 'https'],
    allowProtocolRelative: false,
  }) || '<p></p>'
}

function uploadFilenames(descriptions: string[]) {
  const filenames = new Set<string>()
  const pattern = /\/uploads\/([a-f0-9-]+\.(?:jpg|png|gif|webp))/gi
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
  const [projectsResult, issuesResult, activitiesResult] = await Promise.all([
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
  ])

  const activitiesByIssue = new Map<string, unknown[]>()
  for (const row of activitiesResult.rows) {
    const activities = activitiesByIssue.get(row.issue_id) ?? []
    activities.push({ id: row.id, actor: row.actor, action: row.action, detail: row.detail, kind: row.kind, timestamp: toIso(row.created_at) })
    activitiesByIssue.set(row.issue_id, activities)
  }

  const issuesByProject = new Map<string, unknown[]>()
  for (const row of issuesResult.rows) {
    const issues = issuesByProject.get(row.project_id) ?? []
    issues.push({
      id: row.issue_key,
      title: row.title,
      description: row.description,
      status: row.status,
      priority: row.priority,
      module: row.module,
      environment: row.environment,
      reporter: row.reporter,
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
    const descriptions = await client.query('SELECT description FROM issues WHERE project_id = $1', [request.params.projectId])
    await client.query('DELETE FROM projects WHERE id = $1', [request.params.projectId])
    return uploadFilenames(descriptions.rows.map((row) => row.description))
  })
  if (!result) return response.status(404).json({ error: '项目不存在' })
  await removeUploadFiles(result)
  response.json({ deleted: true })
})

const issueSchema = z.object({
  title: z.string().trim().min(1, '请输入缺陷标题').max(240),
  description: z.string().max(100_000).default('<p></p>'),
  status: z.enum(statuses).default('待处理'),
  priority: z.enum(priorities),
  module: z.string().trim().max(100).default('未分类'),
  environment: z.string().trim().max(160).default('未注明'),
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
      `INSERT INTO issues (id, issue_key, project_id, title, description, status, priority, module, environment, reporter_id, last_modified_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)`,
      [issueId, key, request.params.projectId, parsed.data.title, cleanRichText(parsed.data.description), parsed.data.status, parsed.data.priority, parsed.data.module || '未分类', parsed.data.environment || '未注明', request.auth!.user.id],
    )
    await client.query(
      `INSERT INTO issue_activities (id, issue_id, actor_id, action, detail, kind)
       VALUES ($1, $2, $3, '创建了缺陷', $4, 'created')`,
      [randomUUID(), issueId, request.auth!.user.id, `优先级 ${parsed.data.priority} · 创建人 ${request.auth!.user.name}`],
    )
    await client.query(
      'INSERT INTO project_members (project_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [request.params.projectId, request.auth!.user.id],
    )
    return key
  })
  if (!issueKey) return response.status(404).json({ error: '项目不存在' })
  response.status(201).json({ issue: await findIssue(issueKey) })
})

const updateSchema = z.object({
  title: z.string().trim().min(1).max(240).optional(),
  description: z.string().max(100_000).optional(),
  status: z.enum(statuses).optional(),
  priority: z.enum(priorities).optional(),
  module: z.string().trim().min(1).max(100).optional(),
}).refine((value) => Object.keys(value).length > 0, '没有需要更新的字段')

router.patch('/issues/:issueKey', async (request, response) => {
  const parsed = updateSchema.safeParse(request.body)
  if (!parsed.success) return response.status(400).json({ error: validationError(parsed.error) })
  const updated = await withTransaction(async (client) => {
    const currentResult = await client.query('SELECT * FROM issues WHERE issue_key = $1 FOR UPDATE', [request.params.issueKey])
    if (!currentResult.rowCount) return false
    const current = currentResult.rows[0]
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
    if (!activities.length) return true
    await client.query(
      `UPDATE issues SET title = COALESCE($1, title), description = COALESCE($2, description),
       status = COALESCE($3, status), priority = COALESCE($4, priority), module = COALESCE($5, module),
       last_modified_by = $6, updated_at = NOW() WHERE id = $7`,
      [next.title, next.description, next.status, next.priority, next.module, request.auth!.user.id, current.id],
    )
    for (const activity of activities) {
      await client.query(
        `INSERT INTO issue_activities (id, issue_id, actor_id, action, detail, kind)
         VALUES ($1, $2, $3, $4, $5, 'changed')`,
        [randomUUID(), current.id, request.auth!.user.id, activity.action, activity.detail],
      )
    }
    await client.query(
      'INSERT INTO project_members (project_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [current.project_id, request.auth!.user.id],
    )
    return true
  })
  if (!updated) return response.status(404).json({ error: '缺陷不存在' })
  response.json({ issue: await findIssue(request.params.issueKey) })
})

router.post('/issues/:issueKey/comments', async (request, response) => {
  const parsed = z.object({ comment: z.string().trim().min(1, '请输入评论').max(5_000) }).safeParse(request.body)
  if (!parsed.success) return response.status(400).json({ error: validationError(parsed.error) })
  const updated = await withTransaction(async (client) => {
    const result = await client.query('SELECT id, project_id FROM issues WHERE issue_key = $1 FOR UPDATE', [request.params.issueKey])
    if (!result.rowCount) return false
    const issue = result.rows[0]
    await client.query('UPDATE issues SET last_modified_by = $1, updated_at = NOW() WHERE id = $2', [request.auth!.user.id, issue.id])
    await client.query(
      `INSERT INTO issue_activities (id, issue_id, actor_id, action, detail, kind)
       VALUES ($1, $2, $3, '添加了评论', $4, 'commented')`,
      [randomUUID(), issue.id, request.auth!.user.id, parsed.data.comment],
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
    await client.query('DELETE FROM issues WHERE id = $1', [issue.rows[0].id])
    return uploadFilenames([issue.rows[0].description])
  })
  if (!result) return response.status(404).json({ error: '缺陷不存在' })
  await removeUploadFiles(result)
  response.json({ deleted: true })
})

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
})

function detectImage(buffer: Buffer) {
  if (buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return { ext: '.jpg', type: 'image/jpeg' }
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { ext: '.png', type: 'image/png' }
  if (buffer.subarray(0, 6).toString('ascii').match(/^GIF8[79]a$/)) return { ext: '.gif', type: 'image/gif' }
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return { ext: '.webp', type: 'image/webp' }
  return null
}

router.post('/uploads', upload.single('image'), async (request, response) => {
  if (!request.file) return response.status(400).json({ error: '请选择图片' })
  const image = detectImage(request.file.buffer)
  if (!image) return response.status(400).json({ error: '仅支持 JPG、PNG、GIF 和 WebP 图片' })
  await mkdir(config.uploadsDir, { recursive: true })
  const filename = `${randomUUID()}${image.ext || extname(request.file.originalname)}`
  await writeFile(`${config.uploadsDir}/${filename}`, request.file.buffer, { flag: 'wx' })
  response.status(201).json({ url: `/uploads/${filename}` })
})

export default router
