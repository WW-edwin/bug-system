import { config } from '../server/config.js'
import { initializeDatabase, pool } from '../server/db.js'

if (config.pgDatabase !== 'tracebug_local') {
  throw new Error(`拒绝执行：数据库必须是 tracebug_local，当前是 ${config.pgDatabase}`)
}

await initializeDatabase()
const [tables, columns, constraints, outboxForeignKeys] = await Promise.all([
  pool.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND (table_name LIKE 'notification_%' OR table_name = 'dingtalk_binding_audit')
     ORDER BY table_name`,
  ),
  pool.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'app_users' AND column_name LIKE 'dingtalk_%'
     ORDER BY column_name`,
  ),
  pool.query<{ conname: string }>(
    `SELECT conname FROM pg_constraint
     WHERE conname IN ('app_users_dingtalk_identity_pair_check', 'app_users_dingtalk_sync_status_check')
     ORDER BY conname`,
  ),
  pool.query<{ conname: string }>(
    `SELECT conname FROM pg_constraint
     WHERE conrelid = 'notification_outbox'::regclass AND contype = 'f'`,
  ),
])

if (tables.rowCount !== 4 || columns.rowCount !== 6 || constraints.rowCount !== 2 || outboxForeignKeys.rowCount !== 0) {
  throw new Error('钉钉通知 Schema 验证失败')
}

console.log(JSON.stringify({
  database: config.pgDatabase,
  tables: tables.rows.map((row) => row.table_name),
  userColumns: columns.rows.map((row) => row.column_name),
  constraints: constraints.rows.map((row) => row.conname),
  outboxForeignKeys: outboxForeignKeys.rows.map((row) => row.conname),
}, null, 2))
await pool.end()
