import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import process from 'node:process'

const [baseUrl, outputDirectory] = process.argv.slice(2)
if (!baseUrl || !outputDirectory) throw new Error('Usage: node tools/pull-online.mjs <base-url> <output-directory>')

const credentials = await new Promise((resolveInput, reject) => {
  let input = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    input += chunk
    const newline = input.indexOf('\n')
    if (newline < 0) return
    try {
      process.stdin.pause()
      resolveInput(JSON.parse(input.slice(0, newline).trim()))
    } catch (error) { reject(error) }
  })
})

const origin = baseUrl.replace(/\/$/, '')
const loginResponse = await fetch(`${origin}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: origin },
  body: JSON.stringify(credentials),
})
if (!loginResponse.ok) throw new Error(`Online login failed: ${loginResponse.status}`)

const cookie = loginResponse.headers.getSetCookie().map((value) => value.split(';', 1)[0]).join('; ')
const headers = { Cookie: cookie, Origin: origin }

async function getJson(path) {
  const response = await fetch(`${origin}${path}`, { headers })
  if (!response.ok) throw new Error(`Online read failed ${path}: ${response.status}`)
  return response.json()
}

const [workspace, userDirectory] = await Promise.all([
  getJson('/api/workspace'),
  getJson('/api/auth/users'),
])

const imagePaths = new Set()
for (const project of workspace.projects) {
  for (const issue of project.issues) {
    for (const match of issue.description.matchAll(/\/uploads\/[a-f0-9-]+\.(?:jpg|jpeg|png|gif|webp)/gi)) imagePaths.add(match[0])
  }
}

const destination = resolve(outputDirectory)
const uploadsDestination = resolve(destination, 'uploads')
await mkdir(uploadsDestination, { recursive: true })
const images = []
for (const imagePath of [...imagePaths].sort()) {
  const response = await fetch(`${origin}${imagePath}`, { headers })
  if (!response.ok) throw new Error(`Online image read failed ${imagePath}: ${response.status}`)
  const buffer = Buffer.from(await response.arrayBuffer())
  const filename = basename(imagePath)
  await writeFile(resolve(uploadsDestination, filename), buffer)
  images.push({ path: imagePath, filename, bytes: buffer.length, sha256: createHash('sha256').update(buffer).digest('hex') })
}

await Promise.all([
  writeFile(resolve(destination, 'workspace.json'), JSON.stringify(workspace, null, 2), 'utf8'),
  writeFile(resolve(destination, 'users.json'), JSON.stringify(userDirectory, null, 2), 'utf8'),
  writeFile(resolve(destination, 'manifest.json'), JSON.stringify({
    source: origin,
    exportedAt: new Date().toISOString(),
    counts: {
      users: userDirectory.users.length,
      projects: workspace.projects.length,
      issues: workspace.projects.reduce((count, project) => count + project.issues.length, 0),
      activities: workspace.projects.reduce((count, project) => count + project.issues.reduce((issueCount, issue) => issueCount + issue.activities.length, 0), 0),
      images: images.length,
    },
    images,
  }, null, 2), 'utf8'),
])

await fetch(`${origin}/api/auth/logout`, { method: 'POST', headers })
process.stdout.write(JSON.stringify({ destination, projects: workspace.projects.length, users: userDirectory.users.length, images: images.length }))
