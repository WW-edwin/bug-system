import 'dotenv/config'
import { randomUUID } from 'node:crypto'
import { cp, mkdir, readFile, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Pool, type PoolClient } from 'pg'
import { schemaSql } from '../server/schema.js'
import { hashPassword } from '../server/password.js'

type SnapshotUser = {
  id: string
  email: string | null
  name: string
  role: 'admin' | 'member'
  active: boolean
  createdAt: string
}

type SnapshotActivity = {
  actor: string
  action: string
  detail: string
  timestamp: string
  kind: 'created' | 'changed' | 'commented'
}

type SnapshotIssue = {
  id: string
  title: string
  description: string
  status: string
  priority: string
  module: string
  environment: string
  reporter: string
  lastModifiedBy: string
  createdAt: string
  updatedAt: string
  activities: SnapshotActivity[]
}

type SnapshotProject = {
  id: string
  key: string
  name: string
  description: string
  color: string
  members: string[]
  issues: SnapshotIssue[]
}

const snapshotDirectory = resolve(process.argv[2] ?? '')
if (!process.argv[2]) throw new Error('Usage: npx tsx tools/import-snapshot.ts <snapshot-directory>')
if (process.env.PGDATABASE !== 'tracebug_local') throw new Error('Import is restricted to PGDATABASE=tracebug_local')

const workspace = JSON.parse(await readFile(resolve(snapshotDirectory, 'workspace.json'), 'utf8')) as { projects: SnapshotProject[] }
const directory = JSON.parse(await readFile(resolve(snapshotDirectory, 'users.json'), 'utf8')) as { users: SnapshotUser[] }
const adminEmail = process.env.LOCAL_ADMIN_EMAIL?.toLowerCase()
const adminName = process.env.LOCAL_ADMIN_NAME
const adminPassword = process.env.LOCAL_ADMIN_PASSWORD
if (!adminEmail || !adminName || !adminPassword) throw new Error('LOCAL_ADMIN_EMAIL, LOCAL_ADMIN_NAME and LOCAL_ADMIN_PASSWORD are required')

const pool = new Pool({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT),
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.POSTGRES_PASSWORD,
})

const client = await pool.connect()
const userIds = new Map<string, string>()

function normalizeStatus(status: string) {
  const normalized = status === '待验证' ? '待复测' : status === '已关闭' ? '不适用' : status
  if (!['待处理', '处理中', '待复测', '已解决', '不适用', '待优化'].includes(normalized)) {
    throw new Error(`Unsupported issue status in snapshot: ${status}`)
  }
  return normalized
}

function normalizeActivityDetail(activity: SnapshotActivity) {
  if (activity.kind !== 'changed' || activity.action !== '更新了状态') return activity.detail
  return activity.detail.replaceAll('待验证', '待复测').replaceAll('已关闭', '不适用')
}

async function ensureUser(db: PoolClient, name: string) {
  const existing = userIds.get(name.toLocaleLowerCase())
  if (existing) return existing
  const id = randomUUID()
  await db.query(
    `INSERT INTO app_users (id, display_name, role, active, created_at, updated_at)
     VALUES ($1, $2, 'member', TRUE, NOW(), NOW())`,
    [id, name],
  )
  userIds.set(name.toLocaleLowerCase(), id)
  return id
}

try {
  await client.query(schemaSql)
  await client.query('BEGIN')
  await client.query('TRUNCATE issue_activities, issues, issue_counters, project_members, projects, app_sessions, app_users CASCADE')

  const localAdminHash = await hashPassword(adminPassword)
  for (const user of directory.users) {
    const isLocalAdmin = user.email?.toLowerCase() === adminEmail || user.name === adminName
    await client.query(
      `INSERT INTO app_users (id, email, display_name, password_hash, role, active, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
      [user.id, user.email?.toLowerCase() ?? null, user.name, isLocalAdmin ? localAdminHash : null, isLocalAdmin ? 'admin' : user.role, user.active, user.createdAt],
    )
    userIds.set(user.name.toLocaleLowerCase(), user.id)
  }

  let adminId = userIds.get(adminName.toLocaleLowerCase())
  if (!adminId) {
    adminId = randomUUID()
    await client.query(
      `INSERT INTO app_users (id, email, display_name, password_hash, role, active)
       VALUES ($1, $2, $3, $4, 'admin', TRUE)`,
      [adminId, adminEmail, adminName, localAdminHash],
    )
    userIds.set(adminName.toLocaleLowerCase(), adminId)
  }

  for (const project of workspace.projects) {
    await client.query(
      `INSERT INTO projects (id, project_key, name, description, color, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())`,
      [project.id, project.key, project.name, project.description, project.color, adminId],
    )
    for (const memberName of project.members) {
      const userId = await ensureUser(client, memberName)
      await client.query('INSERT INTO project_members (project_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [project.id, userId])
    }

    const counters = new Map<string, number>()
    for (const issue of project.issues) {
      const issueId = randomUUID()
      const reporterId = await ensureUser(client, issue.reporter)
      const modifierId = await ensureUser(client, issue.lastModifiedBy)
      await client.query(
        `INSERT INTO issues (id, issue_key, project_id, title, description, status, priority, module, environment,
          reporter_id, last_modified_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [issueId, issue.id, project.id, issue.title, issue.description, normalizeStatus(issue.status), issue.priority, issue.module, issue.environment, reporterId, modifierId, issue.createdAt, issue.updatedAt],
      )
      for (const activity of issue.activities) {
        const actorId = await ensureUser(client, activity.actor)
        await client.query(
          `INSERT INTO issue_activities (id, issue_id, actor_id, action, detail, kind, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [randomUUID(), issueId, actorId, activity.action, normalizeActivityDetail(activity), activity.kind, activity.timestamp],
        )
      }
      const match = issue.id.match(/-([0-9]{4})-([0-9]+)$/)
      if (match) counters.set(match[1], Math.max(counters.get(match[1]) ?? 0, Number(match[2])))
    }
    for (const [monthDay, value] of counters) {
      await client.query('INSERT INTO issue_counters (project_id, month_day, value) VALUES ($1, $2, $3)', [project.id, monthDay, value])
    }
  }

  await client.query('COMMIT')
} catch (error) {
  await client.query('ROLLBACK')
  throw error
} finally {
  client.release()
  await pool.end()
}

const uploadDirectory = resolve(process.env.UPLOAD_DIR ?? 'local-data/uploads')
await rm(uploadDirectory, { recursive: true, force: true })
await mkdir(uploadDirectory, { recursive: true })
await cp(resolve(snapshotDirectory, 'uploads'), uploadDirectory, { recursive: true })

console.log(JSON.stringify({ users: userIds.size, projects: workspace.projects.length, issues: workspace.projects.reduce((count, project) => count + project.issues.length, 0), uploads: uploadDirectory }))
