import { createContext, useContext, useMemo } from 'react'
import { environmentOrder, priorityOrder, statusOrder } from './data'
import type { DictionaryKind, Issue, IssueDictionaries, WorkspaceData } from './types'

export const defaultDictionaries: IssueDictionaries = {
  status: statusOrder.map((value, position) => ({ value, label: value, active: true, position, weight: (statusOrder.length - position - 1) * 10, showInPersonal: ['待处理', '处理中', '待复测'].includes(value), isDefault: value === '待处理', isTerminal: ['已修复', '不适用', '不解决'].includes(value) })),
  priority: priorityOrder.map((value, position) => ({ value, label: value, active: true, position, weight: (priorityOrder.length - position - 1) * 10, showInPersonal: false, isDefault: value === 'P1', isTerminal: false })),
  environment: environmentOrder.map((value, position) => ({ value, label: value, active: true, position, weight: (environmentOrder.length - position - 1) * 10, showInPersonal: false, isDefault: value === '测试环境', isTerminal: false })),
}

export const DictionaryContext = createContext<IssueDictionaries>(defaultDictionaries)

// A slow refresh must not undo a more recent dictionary save from this session.
export function mergeWorkspaceData(previous: WorkspaceData, incoming: WorkspaceData): WorkspaceData {
  if (!previous.dictionaries || !previous.dictionaryVersions) return incoming
  if (!incoming.dictionaries || !incoming.dictionaryVersions) return { ...incoming, dictionaries: previous.dictionaries, dictionaryVersions: previous.dictionaryVersions }
  const dictionaries = { ...incoming.dictionaries }
  const dictionaryVersions = { ...incoming.dictionaryVersions }
  for (const kind of ['priority', 'environment', 'status'] as const) {
    if (previous.dictionaryVersions[kind] > dictionaryVersions[kind]) {
      dictionaries[kind] = previous.dictionaries[kind]
      dictionaryVersions[kind] = previous.dictionaryVersions[kind]
    }
  }
  return { ...incoming, dictionaries, dictionaryVersions }
}

export function dictionaryHelpers(source: IssueDictionaries) {
  const dictionaries = Object.fromEntries(Object.entries(source).map(([kind, entries]) => [kind,
    [...entries].sort((left, right) => right.weight - left.weight || left.position - right.position || left.value.localeCompare(right.value)),
  ])) as IssueDictionaries
  const label = (kind: DictionaryKind, value: string) => dictionaries[kind].find((item) => item.value === value)?.label ?? value
  const activeValues = (kind: DictionaryKind) => dictionaries[kind].filter((item) => item.active).map((item) => item.value)
  // Keep inactive/historical values in filters and boards so no existing issue disappears.
  const values = (kind: DictionaryKind, historical: string[] = []) => Array.from(new Set([...dictionaries[kind].map((item) => item.value), ...historical]))
  const defaultValue = (kind: DictionaryKind) => dictionaries[kind].find((item) => item.active && item.isDefault)?.value ?? activeValues(kind)[0] ?? ''
  const isTerminal = (value: string) => dictionaries.status.find((item) => item.value === value)?.isTerminal ?? false
  const showInPersonal = (value: string) => dictionaries.status.find((item) => item.value === value)?.showInPersonal === true
  const compareIssues = (left: Issue, right: Issue) => {
    for (const kind of ['status', 'priority'] as const) {
      const weight = (value: string) => dictionaries[kind].find((item) => item.value === value)?.weight ?? -1
      const difference = weight(right[kind]) - weight(left[kind])
      if (difference) return difference
    }
    return Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || left.id.localeCompare(right.id, 'zh-CN')
  }
  return { dictionaries, label, activeValues, values, defaultValue, isTerminal, showInPersonal, compareIssues }
}

export function useDictionaries() {
  const dictionaries = useContext(DictionaryContext)
  return useMemo(() => dictionaryHelpers(dictionaries), [dictionaries])
}
