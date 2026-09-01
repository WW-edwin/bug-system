import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { NextFunction, Request, Response } from 'express'
import type { PoolClient } from 'pg'
import { config } from './config.js'
import { pool } from './db.js'

export const sessionCookieName = 'tb_sid'

function hashToken(token: string) {
  return createHash('sha256').update(token).digest('hex')
}

export async function createSession(userId: string, client?: PoolClient) {
  const token = randomBytes(32).toString('base64url')
  const expiresAt = new Date(Date.now() + config.sessionTtlMs)
  const query = client ?? pool
  await query.query(
    'INSERT INTO app_sessions (id, user_id, token_hash, expires_at) VALUES ($1, $2, $3, $4)',
    [randomUUID(), userId, hashToken(token), expiresAt],
  )
  return { token, expiresAt }
}

export function setSessionCookie(response: Response, token: string, expiresAt: Date) {
  response.cookie(sessionCookieName, token, {
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: 'strict',
    path: '/',
    expires: expiresAt,
  })
}

export function clearSessionCookie(response: Response) {
  response.clearCookie(sessionCookieName, {
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: 'strict',
    path: '/',
  })
}

export async function attachUser(request: Request, _response: Response, next: NextFunction) {
  try {
    const token = request.cookies?.[sessionCookieName]
    if (!token) return next()
    const result = await pool.query(
      `SELECT s.id AS session_id, u.id, u.email, u.display_name, u.role
       FROM app_sessions s
       JOIN app_users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.expires_at > NOW() AND u.active = TRUE
         AND u.email IS NOT NULL AND u.password_hash IS NOT NULL`,
      [hashToken(token)],
    )
    const row = result.rows[0]
    if (row) {
      request.auth = {
        sessionId: row.session_id,
        user: { id: row.id, email: row.email, name: row.display_name, role: row.role },
      }
    }
    next()
  } catch (error) {
    next(error)
  }
}

export function requireAuth(request: Request, response: Response, next: NextFunction) {
  if (!request.auth) return response.status(401).json({ error: '请先登录' })
  next()
}

export function requireAdmin(request: Request, response: Response, next: NextFunction) {
  if (!request.auth) return response.status(401).json({ error: '请先登录' })
  if (request.auth.user.role !== 'admin') return response.status(403).json({ error: '需要管理员权限' })
  next()
}

export function requireSameOrigin(request: Request, response: Response, next: NextFunction) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) return next()
  const origin = request.get('origin')
  if (!origin) return next()
  const requestOrigin = `${request.protocol}://${request.get('host')}`
  const configuredOrigins = config.publicOrigin.split(',').map((value) => value.trim()).filter(Boolean)
  if (origin !== requestOrigin && !configuredOrigins.includes(origin)) return response.status(403).json({ error: '请求来源无效' })
  next()
}
