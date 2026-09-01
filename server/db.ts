import { Pool, type PoolClient } from 'pg'
import { config } from './config.js'
import { schemaSql } from './schema.js'

export const pool = new Pool({
  ...(process.env.DATABASE_URL ? { connectionString: config.databaseUrl } : {
    host: config.pgHost,
    port: config.pgPort,
    database: config.pgDatabase,
    user: config.pgUser,
    password: config.pgPassword,
  }),
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 8_000,
})

export async function initializeDatabase() {
  await pool.query(schemaSql)
  await pool.query('DELETE FROM app_sessions WHERE expires_at <= NOW()')
  await pool.query('DELETE FROM app_sessions WHERE user_id IN (SELECT id FROM app_users WHERE email IS NULL OR password_hash IS NULL)')
}

export async function withTransaction<T>(work: (client: PoolClient) => Promise<T>) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await work(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}
