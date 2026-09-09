import 'dotenv/config'
import assert from 'node:assert/strict'
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { Pool } from 'pg'

// Runs browser checks in a brand-new local database, never the configured app DB.
const pgPort = Number(process.env.PGPORT ?? 5433)
assert.equal(process.env.PGHOST ?? '127.0.0.1', '127.0.0.1', 'UI tests require local PostgreSQL')
assert.equal(pgPort, 5433, 'UI tests require the dedicated local PostgreSQL instance')
const database = `tracebug_dictionary_ui_${Date.now()}`
assert.match(database, /^tracebug_dictionary_ui_\d+$/)
const pool = new Pool({ host: '127.0.0.1', port: pgPort, database: 'postgres', user: process.env.PGUSER ?? 'tracebug', password: process.env.PGPASSWORD ?? process.env.POSTGRES_PASSWORD })
const apiPort = 3191
const webPort = 4191
const children: ChildProcess[] = []
const outputs: string[] = []
let created = false
let uploadDir = ''

function launch(args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(child)
  child.stdout?.on('data', (chunk) => outputs.push(chunk.toString()))
  child.stderr?.on('data', (chunk) => outputs.push(chunk.toString()))
  return child
}

async function ready(url: string, child: ChildProcess) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Test server exited (${child.exitCode})`)
    try { if ((await fetch(url)).ok) return } catch { /* Server is starting. */ }
    await new Promise((done) => setTimeout(done, 150))
  }
  throw new Error(`Test server did not become ready: ${url}`)
}

try {
  await pool.query(`CREATE DATABASE "${database}"`)
  created = true
  uploadDir = await mkdtemp(join(tmpdir(), 'tracebug-dictionary-ui-uploads-'))
  const env = { ...process.env, DATABASE_URL: '', PGHOST: '127.0.0.1', PGPORT: String(pgPort), PGDATABASE: database, PORT: String(apiPort), NODE_ENV: 'development', PUBLIC_ORIGIN: `http://127.0.0.1:${apiPort}`, COOKIE_SECURE: 'false', UPLOAD_DIR: uploadDir, VITE_API_PROXY: `http://127.0.0.1:${apiPort}`, TEST_BASE_URL: `http://127.0.0.1:${webPort}`, TEST_DISPOSABLE_DATABASE: database, PYTHONIOENCODING: 'utf-8' }
  const api = launch(['--import', 'tsx', 'server/index.ts'], env)
  await ready(`http://127.0.0.1:${apiPort}/api/health`, api)
  const web = launch(['node_modules/vite/bin/vite.js', '--port', String(webPort), '--strictPort'], env)
  await ready(`${env.TEST_BASE_URL}/api/health`, web)
  const python = spawn(process.env.PYTHON ?? 'python', [resolve('tests/dictionaries-ui.py')], { env, windowsHide: true, stdio: 'inherit' })
  const code = await new Promise<number | null>((done, reject) => { python.on('error', reject); python.on('exit', done) })
  assert.equal(code, 0, 'Dictionary UI probes failed')
} catch (error) {
  console.error(outputs.join('').slice(-5000))
  throw error
} finally {
  for (const child of children.reverse()) {
    if (child.exitCode !== null || !child.pid) continue
    if (process.platform === 'win32') {
      try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }) } catch { /* Already exited. */ }
    } else child.kill('SIGTERM')
  }
  if (created) {
    await pool.query(`DROP DATABASE "${database}" WITH (FORCE)`)
    const residual = await pool.query('SELECT 1 FROM pg_database WHERE datname = $1', [database])
    assert.equal(residual.rowCount, 0)
    console.log(`Cleanup verified: disposable database ${database} absent.`)
  }
  await pool.end()
  if (uploadDir) await rm(uploadDir, { recursive: true, force: true })
}
