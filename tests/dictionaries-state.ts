import assert from 'node:assert/strict'
import { defaultDictionaries, dictionaryHelpers, mergeWorkspaceData } from '../src/dictionaries.js'
import type { Issue, IssueDictionaries, WorkspaceData } from '../src/types.js'

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

const weighted: IssueDictionaries = {
  status: [
    { ...defaultDictionaries.status[0], value: 'low', weight: 0, showInPersonal: false },
    { ...defaultDictionaries.status[1], value: 'tie-a', weight: 100 },
    { ...defaultDictionaries.status[2], value: 'tie-b', weight: 100 },
    { ...defaultDictionaries.status[3], value: 'done-visible', weight: 200, showInPersonal: true, active: false },
  ],
  priority: [
    { ...defaultDictionaries.priority[0], value: 'low', weight: 0 },
    { ...defaultDictionaries.priority[1], value: 'high', weight: 100 },
  ],
  environment: [
    { ...defaultDictionaries.environment[0], value: 'env-low', weight: 0 },
    { ...defaultDictionaries.environment[1], value: 'env-high', weight: 999999 },
  ],
}
const helper = dictionaryHelpers(weighted)
const issue = (id: string, status: string, priority: string, updatedAt: string, environment = 'env-low') => ({ id, status, priority, updatedAt, environment } as Issue)
const recent = '2026-09-08T12:00:00Z'
const older = '2026-09-08T11:00:00Z'
const fixtures = [
  issue('low-status', 'low', 'high', recent),
  issue('low-priority', 'tie-a', 'low', recent),
  issue('priority-wins', 'tie-b', 'high', older),
  issue('env-must-not-win', 'tie-a', 'low', older, 'env-high'),
  issue('status-wins', 'done-visible', 'low', older),
]
assert.deepEqual([...fixtures].sort(helper.compareIssues).map(item => item.id), ['status-wins', 'priority-wins', 'low-priority', 'env-must-not-win', 'low-status'])
assert.deepEqual(helper.activeValues('environment'), ['env-high', 'env-low'])
assert.deepEqual(helper.values('status'), ['done-visible', 'tie-a', 'tie-b', 'low'])
assert.equal(helper.showInPersonal('done-visible'), true, 'Inactive terminal statuses can still show historical assigned issues')
assert.equal(helper.isTerminal('done-visible'), true, 'Visibility does not change completion classification')
assert.equal(helper.showInPersonal('low'), false, 'Unfinished statuses may be hidden')
assert.equal(helper.showInPersonal('unknown'), false, 'Only explicitly selected statuses are shown')
assert.ok(helper.compareIssues(issue('a', 'tie-a', 'high', recent), issue('b', 'tie-b', 'high', recent)) < 0, 'Equal weights and update time use issue ID tie breaker, not status row order')
assert.equal(weighted.status[0].value, 'low', 'Sorting must not mutate source dictionaries')
console.log('Passed: numeric weight precedence, timestamp/ID ties, environment option order and independent personal visibility.')
