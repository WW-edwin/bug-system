import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { access, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, join, sep } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

test('multipart upload names retain browser Unicode and declared encodings through saved issue evidence', {
  skip: process.env.TRACEBUG_UPLOAD_TEST !== 'true', timeout: 60_000,
}, async (t) => {
  const { config } = await import('../server/config.js')
  assert.deepEqual([config.pgHost, config.pgPort, config.pgDatabase], ['127.0.0.1', 5433, 'tracebug_local'])
  assert.ok(!process.env.DATABASE_URL, 'test requires local PostgreSQL with no database URL override')
  const savedConfig = { ...config, dingtalk: { ...config.dingtalk } }
  const { Pool } = await import('pg')
  const control = new Pool({ host: config.pgHost, port: config.pgPort, database: 'postgres', user: config.pgUser, password: config.pgPassword })
  const database = 'tracebug_uploads_' + randomBytes(8).toString('hex')
  assert.match(database, /^tracebug_uploads_[a-f0-9]{16}$/)
  const marker = 'SELFTEST-' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14).replace(/^(\d{8})/, '$1-')
  const ledger = { marker, database, users: [] as string[], projects: [] as string[], issues: [] as string[], uploadedNames: [] as string[] }
  let createdDatabase = false
  let fixture: import('pg').Pool | undefined
  let uploadDir = ''
  let server: Server | undefined
  const originalFetch = globalThis.fetch
  try {
    await control.query(`CREATE DATABASE "${database}"`)
    createdDatabase = true
    config.pgDatabase = database
    config.sessionCookieName = 'tb_sid_upload_filename_test'
    config.secureCookies = false
    config.dingtalk.enabled = false
    config.dingtalk.dryRun = true
    uploadDir = await mkdtemp(join(tmpdir(), 'tracebug-upload-filenames-'))
    config.uploadsDir = uploadDir
    const { pool, initializeDatabase } = await import('../server/db.js')
    fixture = pool
    assert.equal((await pool.query('SELECT current_database() AS name')).rows[0].name, database)
    await initializeDatabase()
    const { attachUser, requireSameOrigin, createSession, sessionCookieName } = await import('../server/auth.js')
    const { hashPassword } = await import('../server/password.js')
    const { default: workspaceRoutes } = await import('../server/workspaceRoutes.js')
    const { default: express } = await import('express')
    const { default: cookieParser } = await import('cookie-parser')
    const app = express()
    app.use(express.json(), cookieParser(), requireSameOrigin, attachUser)
    app.use('/api', workspaceRoutes)
    app.use((error: unknown, _req: unknown, res: import('express').Response, _next: unknown) => {
      res.status(Number((error as { status?: number })?.status ?? 500)).json({ error: error instanceof Error ? error.message : 'error' })
    })
    server = app.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port
    config.publicOrigin = config.publicAppOrigin = base
    globalThis.fetch = (input, init) => {
      assert.equal(new URL(input instanceof Request ? input.url : String(input)).origin, base, 'test cannot send messages or requests to an external service')
      return originalFetch(input, init)
    }
    const userId = randomUUID()
    await pool.query('INSERT INTO app_users (id,display_name,email,password_hash,role) VALUES($1,$2,$3,$4,\'admin\')',
      [userId, marker + ' 上传验收', marker + '@example.invalid', await hashPassword(randomBytes(24).toString('hex'))])
    ledger.users.push(userId)
    const cookie = sessionCookieName + '=' + (await createSession(userId)).token
    const headers = { Origin: base, Cookie: cookie }
    type Evidence = { url: string; name: string; type: string; kind: string; size: number }
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6GxkAAAAASUVORK5CYII=', 'base64')
    const video = Buffer.from([0, 0, 0, 24, 102, 116, 121, 112, 109, 112, 52, 50, 0, 0, 0, 0, 109, 112, 52, 50, 105, 115, 111, 109])
    const zip = Buffer.from([0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
    const cases = [
      { name: '页面截图_中文.png', bytes: png, kind: 'image', type: 'image/png' },
      { name: '测试视频_录屏.mp4', bytes: video, kind: 'video', type: 'video/mp4' },
      { name: '缺陷说明_中文.txt', bytes: Buffer.from('SELFTEST 文件内容'), kind: 'file', type: 'text/plain' },
      { name: '验收报告.pdf', bytes: Buffer.from('%PDF-1.4\n% SELFTEST\n%%EOF'), kind: 'file', type: 'application/pdf' },
      { name: '中文表格.xlsx', bytes: zip, kind: 'file', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
      { name: '中英_report_v2_😀.txt', bytes: Buffer.from('SELFTEST emoji'), kind: 'file', type: 'text/plain' },
      { name: 'café résumé naïve.txt', bytes: Buffer.from('SELFTEST accent'), kind: 'file', type: 'text/plain' },
      { name: 'ascii-report_2026.txt', bytes: Buffer.from('SELFTEST ASCII'), kind: 'file', type: 'text/plain' },
      { name: '截图🎉_v2.png', bytes: png, kind: 'image', type: 'image/png' },
    ]
    const uploaded: Evidence[] = []
    async function verifyStored(evidence: Evidence, expectedBytes: Uint8Array) {
      assert.match(evidence.url, /^\/uploads\/[a-f0-9-]{36}\.[a-z0-9]+$/)
      const path = join(uploadDir, basename(evidence.url))
      assert.ok((await realpath(path)).startsWith((await realpath(uploadDir)) + sep))
      assert.deepEqual(await readFile(path), Buffer.from(expectedBytes))
      assert.equal(evidence.size, expectedBytes.byteLength)
    }
    async function upload(name: string, bytes: Uint8Array, field = 'file') {
      const body = new FormData()
      body.set(field, new Blob([new Uint8Array(bytes)]), name)
      const response = await fetch(base + '/api/uploads', { method: 'POST', headers, body })
      const evidence = await response.json() as Evidence
      assert.equal(response.status, 201, JSON.stringify(evidence))
      ledger.uploadedNames.push(evidence.name)
      return evidence
    }
    async function extendedFilename(declaration: string) {
      const boundary = 'SELFTEST-' + randomBytes(12).toString('hex')
      const body = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="fallback.txt"; filename*=${declaration}\r\nContent-Type: text/plain\r\n\r\nSELFTEST extended name\r\n--${boundary}--\r\n`, 'ascii')
      const response = await fetch(base + '/api/uploads', { method: 'POST', headers: { ...headers, 'Content-Type': 'multipart/form-data; boundary=' + boundary }, body })
      const evidence = await response.json() as Evidence
      assert.equal(response.status, 201, JSON.stringify(evidence))
      ledger.uploadedNames.push(evidence.name)
      return evidence
    }
    const encodedParameter = (value: string) => encodeURIComponent(value).replace(/['()*]/g, (character) => '%' + character.charCodeAt(0).toString(16).toUpperCase())
    async function api(path: string, body?: unknown) {
      const response = await fetch(base + '/api' + path, { method: body === undefined ? 'GET' : 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
      const data = await response.json()
      assert.ok(response.ok, JSON.stringify(data))
      return data
    }

    await t.test('browser FormData preserves Chinese image, video, documents, emoji, mixed and accented names', async () => {
      for (const input of cases) {
        const evidence = await upload(input.name, input.bytes)
        assert.equal(evidence.name, input.name)
        assert.equal(evidence.kind, input.kind)
        assert.equal(evidence.type, input.type)
        await verifyStored(evidence, input.bytes)
        uploaded.push(evidence)
      }
      const legacyImageField = await upload('旧图片字段_中文.png', png, 'image')
      assert.equal(legacyImageField.name, '旧图片字段_中文.png')
      await verifyStored(legacyImageField, png)
      uploaded.push(legacyImageField)
    })

    await t.test('explicit UTF-8 and ISO-8859-1 filename parameters are decoded once using their declared charset', async () => {
      const utf8Name = '明确编码_中文😀.txt'
      const utf8 = await extendedFilename("UTF-8''" + encodedParameter(utf8Name))
      assert.equal(utf8.name, utf8Name)
      const latin = await extendedFilename("ISO-8859-1''caf%E9%20r%E9sum%E9.txt")
      assert.equal(latin.name, 'café résumé.txt')
      for (const evidence of [utf8, latin]) {
        await verifyStored(evidence, Buffer.from('SELFTEST extended name'))
        uploaded.push(evidence)
      }
    })

    await t.test('saved issue and comment attachment metadata retains the returned original names', async () => {
      assert.equal(uploaded.length, cases.length + 3)
      const escape = (text: string) => text.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
      const content = uploaded.map((item) => {
        const attrs = `data-name="${escape(item.name)}" data-type="${escape(item.type)}" data-size="${item.size}"`
        return item.kind === 'image' ? `<p><img src="${item.url}" alt="${escape(item.name)}" ${attrs}></p>`
          : item.kind === 'video' ? `<p><video src="${item.url}" controls ${attrs}></video></p>`
            : `<p><a href="${item.url}" data-attachment="true" ${attrs}>${escape(item.name)}</a></p>`
      }).join('')
      const project = (await api('/projects', { key: 'UPLOAD', name: marker })).project
      ledger.projects.push(project.id)
      const issue = (await api('/projects/' + project.id + '/issues', { title: marker, description: content, assigneeIds: [userId] })).issue
      ledger.issues.push(issue.id)
      await api('/issues/' + issue.id + '/comments', { comment: content })
      const workspace = await api('/workspace')
      const saved = workspace.projects.find((entry: { id: string }) => entry.id === project.id).issues.find((entry: { id: string }) => entry.id === issue.id)
      const comment = saved.activities.find((entry: { kind: string }) => entry.kind === 'commented')
      const stored = (await pool.query('SELECT id,description FROM issues WHERE issue_key=$1', [issue.id])).rows[0]
      const storedComment = (await pool.query("SELECT detail FROM issue_activities WHERE issue_id=$1 AND kind='commented'", [stored.id])).rows[0].detail
      for (const evidence of uploaded) {
        const metadata = `data-name="${escape(evidence.name)}"`
        for (const richText of [saved.description, comment.detail, stored.description, storedComment]) assert.ok(richText.includes(metadata), evidence.name)
      }
    })

    await t.test('Unicode decoding retains path stripping and unsafe-name sanitization', async () => {
      for (const filename of ['../目录/中文附件.txt', 'C:\\目录\\中文附件.txt']) {
        const evidence = await upload(filename, Buffer.from('SELFTEST path'))
        assert.equal(evidence.name, '中文附件.txt')
        await verifyStored(evidence, Buffer.from('SELFTEST path'))
      }
      const unsafeName = '中文<>:"|?*\u0001附件.txt'
      const evidence = await extendedFilename("UTF-8''" + encodedParameter(unsafeName))
      assert.doesNotMatch(evidence.name, /[\u0000-\u001f<>:"/\\|?*]/)
      assert.ok(evidence.name.endsWith('附件.txt'))
      assert.ok(evidence.name.includes('中文'))
      await verifyStored(evidence, Buffer.from('SELFTEST extended name'))
    })
    t.diagnostic(JSON.stringify({ ...ledger, externalRequests: 0 }))
  } finally {
    if (server) { server.closeAllConnections(); await new Promise<void>((resolve) => server!.close(() => resolve())) }
    globalThis.fetch = originalFetch
    if (fixture) await fixture.end()
    Object.assign(config, savedConfig)
    try {
      if (createdDatabase) {
        for (let attempt = 0; attempt < 20; attempt += 1) {
          if ((await control.query('SELECT COUNT(*)::int AS count FROM pg_stat_activity WHERE datname=$1', [database])).rows[0].count === 0) break
          await delay(50)
        }
        await control.query(`DROP DATABASE "${database}"`)
        assert.equal((await control.query('SELECT datname FROM pg_database WHERE datname=$1', [database])).rowCount, 0)
      }
      if (uploadDir) { await rm(uploadDir, { recursive: true, force: true }); await assert.rejects(access(uploadDir)) }
      t.diagnostic(JSON.stringify({ marker, database, cleanup: 'passed', remainingDatabases: 0, remainingUploads: 0, configuredDatabaseUntouched: true }))
    } finally { await control.end() }
  }
})
