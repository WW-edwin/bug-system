import assert from 'node:assert/strict'
import { defaultDictionaries, mergeWorkspaceData } from '../src/dictionaries.js'
import type { WorkspaceData } from '../src/types.js'

// Simulate a slow workspace refresh arriving after a dictionary save. Other categories
// and project data from that refresh must still be accepted when they are newer.
const saved: WorkspaceData = {
  projects: [],
  dictionaries: { ...defaultDictionaries, status: [{ ...defaultDictionaries.status[0], label: '刚保存的状态' }] },
  dictionaryVersions: { status: 3, priority: 1, environment: 1 },
}
const slowResponse: WorkspaceData = {
  projects: [{ id: 'refreshed-project', key: 'TEST', name: '最新项目', description: '', color: '#123456', members: [], issues: [] }],
  dictionaries: { ...defaultDictionaries, priority: [{ ...defaultDictionaries.priority[0], label: '另一管理员的优先级' }] },
  dictionaryVersions: { status: 2, priority: 2, environment: 1 },
}
const merged = mergeWorkspaceData(saved, slowResponse)
assert.equal(merged.dictionaries!.status[0].label, '刚保存的状态')
assert.equal(merged.dictionaryVersions!.status, 3)
assert.equal(merged.dictionaries!.priority[0].label, '另一管理员的优先级')
assert.equal(merged.dictionaryVersions!.priority, 2)
assert.equal(merged.projects[0].id, 'refreshed-project')
assert.equal(slowResponse.dictionaryVersions!.status, 2, 'Do not mutate incoming snapshots')
assert.equal(saved.dictionaryVersions!.priority, 1, 'Do not mutate previously saved state')
console.log('Passed: delayed refresh preserves newer dictionary saves and accepts newer categories.')
