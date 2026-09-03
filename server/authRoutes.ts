import { randomUUID } from 'node:crypto'
import { Router } from 'express'
import { rateLimit } from 'express-rate-limit'
import { z } from 'zod'
import { clearSessionCookie, createSession, requireAdmin, setSessionCookie } from './auth.js'
import { config } from './config.js'
import { pool, withTransaction } from './db.js'
import { hashPassword, verifyPassword } from './password.js'

const router = Router()
const realName = z.string().trim().min(1, '请输入真实姓名').max(80, '姓名不能超过 80 个字符').regex(/^\p{Script=Han}+$/u, '真实姓名只能包含中文')
const password = z.string().min(6, '密码至少 6 个字符').max(128, '密码不能超过 128 个字符')
const loginSchema = z.object({ name: realName, password })
const registerSchema = loginSchema.extend({
  email: z.string().trim().email('请输入有效的公司邮箱').max(254),
})

function validationError(error: z.ZodError) {
  return error.issues[0]?.message ?? '输入内容无效'
}

function isCompanyEmail(email: string) {
  const normalized = email.trim().toLowerCase()
  return normalized.endsWith('@' + config.companyEmailDomain)
    && normalized.slice(0, -config.companyEmailDomain.length - 1).length > 0
}

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_request, response) => response.status(429).json({ error: '操作过于频繁，请稍后再试' }),
})

router.post('/register', authLimiter, async (request, response) => {
  const parsed = registerSchema.safeParse(request.body)
  if (!parsed.success) return response.status(400).json({ error: validationError(parsed.error) })
  const email = parsed.data.email.toLowerCase()
  if (!isCompanyEmail(email)) return response.status(400).json({ error: '仅允许使用 @' + config.companyEmailDomain + ' 公司邮箱' })

  try {
    const result = await withTransaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock($1)', [8042601])
      const emailResult = await client.query('SELECT id FROM app_users WHERE LOWER(email) = $1', [email])
      if (emailResult.rowCount) return { conflict: '该公司邮箱已注册' } as const

      const nameResult = await client.query(
        'SELECT id, email, password_hash, role, active FROM app_users WHERE LOWER(display_name) = LOWER($1) FOR UPDATE',
        [parsed.data.name],
      )
      const passwordHash = await hashPassword(parsed.data.password)
      let user
      if (nameResult.rowCount) {
        const existing = nameResult.rows[0]
        if (existing.email || existing.password_hash) return { conflict: '该真实姓名已注册' } as const
        if (!existing.active) return { conflict: '该员工身份已停用' } as const
        const updated = await client.query(
          'UPDATE app_users SET email = $1, password_hash = $2, updated_at = NOW() WHERE id = $3 RETURNING id, email, display_name, role',
          [email, passwordHash, existing.id],
        )
        user = updated.rows[0]
      } else {
        const count = await client.query('SELECT COUNT(*)::int AS count FROM app_users WHERE email IS NOT NULL AND password_hash IS NOT NULL AND active = TRUE')
        const role = count.rows[0].count === 0 ? 'admin' : 'member'
        const created = await client.query(
          'INSERT INTO app_users (id, email, display_name, password_hash, role) VALUES ($1, $2, $3, $4, $5) RETURNING id, email, display_name, role',
          [randomUUID(), email, parsed.data.name, passwordHash, role],
        )
        user = created.rows[0]
      }
      const session = await createSession(user.id, client)
      return {
        session,
        user: { id: user.id, email: user.email, name: user.display_name, role: user.role as 'admin' | 'member' },
      }
    })

    if ('conflict' in result) return response.status(409).json({ error: result.conflict })
    setSessionCookie(response, result.session.token, result.session.expiresAt)
    response.status(201).json({ user: result.user })
  } catch (error) {
    if ((error as { code?: string }).code === '23505') return response.status(409).json({ error: '邮箱或真实姓名已注册' })
    throw error
  }
})

router.post('/login', authLimiter, async (request, response) => {
  const parsed = loginSchema.safeParse(request.body)
  if (!parsed.success) return response.status(400).json({ error: validationError(parsed.error) })
  const result = await pool.query(
    'SELECT id, email, display_name, password_hash, role, active FROM app_users WHERE LOWER(display_name) = LOWER($1)',
    [parsed.data.name],
  )
  const row = result.rows[0]
  const valid = row?.active && row.email && row.password_hash && await verifyPassword(parsed.data.password, row.password_hash)
  if (!valid) {
    console.warn('[auth] login failed name=' + parsed.data.name + ' ip=' + request.ip)
    return response.status(401).json({ error: '真实姓名或密码错误，请先完成注册' })
  }
  const session = await createSession(row.id)
  setSessionCookie(response, session.token, session.expiresAt)
  response.json({ user: { id: row.id, email: row.email, name: row.display_name, role: row.role } })
})

router.post('/logout', async (request, response) => {
  if (request.auth) await pool.query('DELETE FROM app_sessions WHERE id = $1', [request.auth.sessionId])
  clearSessionCookie(response)
  response.json({ loggedOut: true })
})

router.get('/me', (request, response) => {
  response.json({ user: request.auth?.user ?? null })
})

router.get('/users', requireAdmin, async (_request, response) => {
  const result = await pool.query(
    `SELECT id, email, display_name AS name, role, active, created_at AS "createdAt",
            dingtalk_user_id AS "dingtalkUserId", dingtalk_sync_status AS "dingtalkStatus",
            dingtalk_bound_at AS "dingtalkBoundAt"
     FROM app_users WHERE active = TRUE ORDER BY created_at ASC`,
  )
  response.json({ users: result.rows })
})

router.patch('/users/:id/role', requireAdmin, async (request, response) => {
  const result = await pool.query(
    `UPDATE app_users SET role = 'admin', updated_at = NOW() WHERE id = $1 AND active = TRUE
     RETURNING id, email, display_name AS name, role, active, created_at AS "createdAt",
               dingtalk_user_id AS "dingtalkUserId", dingtalk_sync_status AS "dingtalkStatus",
               dingtalk_bound_at AS "dingtalkBoundAt"`,
    [request.params.id],
  )
  if (!result.rowCount) return response.status(404).json({ error: '用户不存在' })
  response.json({ user: result.rows[0] })
})

router.patch('/users/:id/password', requireAdmin, async (request, response) => {
  const parsed = z.object({ password }).safeParse(request.body)
  if (!parsed.success) return response.status(400).json({ error: validationError(parsed.error) })
  const user = await pool.query('SELECT id, email FROM app_users WHERE id = $1 AND active = TRUE', [request.params.id])
  if (!user.rowCount) return response.status(404).json({ error: '用户不存在' })
  if (!user.rows[0].email) return response.status(409).json({ error: '该用户尚未完成注册' })
  const passwordHash = await hashPassword(parsed.data.password)
  await withTransaction(async (client) => {
    await client.query('UPDATE app_users SET password_hash = $1, updated_at = NOW() WHERE id = $2', [passwordHash, request.params.id])
    await client.query('DELETE FROM app_sessions WHERE user_id = $1', [request.params.id])
  })
  response.json({ updated: true })
})

router.delete('/users/:id', requireAdmin, async (request, response) => {
  if (request.params.id === request.auth!.user.id) return response.status(400).json({ error: '不能删除当前登录的管理员' })
  const deleted = await withTransaction(async (client) => {
    const result = await client.query('UPDATE app_users SET active = FALSE, updated_at = NOW() WHERE id = $1 AND active = TRUE RETURNING id', [request.params.id])
    if (!result.rowCount) return false
    await client.query('DELETE FROM app_sessions WHERE user_id = $1', [request.params.id])
    return true
  })
  if (!deleted) return response.status(404).json({ error: '用户不存在' })
  response.json({ deleted: true })
})

export default router
