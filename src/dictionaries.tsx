import { createContext, useContext, useMemo } from 'react'
import { environmentOrder, priorityOrder, statusOrder } from './data'
import type { DictionaryKind, Issue, IssueDictionaries, WorkspaceData } from './types'

export const defaultDictionaries: IssueDictionaries = {
  status: statusOrder.map((value, position) => ({ value, label: value, active: true, position, isDefault: value === '待处理', isTerminal: ['已修复', '不适用', '不解决'].includes(value) })),
  priority: priorityOrder.map((value, position) => ({ value, label: value, active: true, position, isDefault: value === 'P1', isTerminal: false })),
  environment: environmentOrder.map((value, position) => ({ value, label: value, active: true, position, isDefault: value === '测试环境', isTerminal: false })),
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

export function useDictionaries() {
  const dictionaries = useContext(DictionaryContext)
  return useMemo(() => {
    const label = (kind: DictionaryKind, value: string) => dictionaries[kind].find((item) => item.value === value)?.label ?? value
    const activeValues = (kind: DictionaryKind) => dictionaries[kind].filter((item) => item.active).map((item) => item.value)
    // Keep inactive/historical values in filters and boards so no existing issue disappears.
    const values = (kind: DictionaryKind, historical: string[] = []) => Array.from(new Set([...dictionaries[kind].map((item) => item.value), ...historical]))
    const defaultValue = (kind: DictionaryKind) => dictionaries[kind].find((item) => item.active && item.isDefault)?.value ?? activeValues(kind)[0] ?? ''
    const isTerminal = (value: string) => dictionaries.status.find((item) => item.value === value)?.isTerminal ?? false
    const compareIssues = (left: Issue, right: Issue) => {
      for (const kind of ['status', 'priority'] as const) {
        const rank = (value: string) => { const index = dictionaries[kind].findIndex((item) => item.value === value); return index < 0 ? Number.MAX_SAFE_INTEGER : index }
        const difference = rank(left[kind]) - rank(right[kind])
        if (difference) return difference
      }
      return Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || left.id.localeCompare(right.id, 'zh-CN')
    }
    return { dictionaries, label, activeValues, values, defaultValue, isTerminal, compareIssues }
  }, [dictionaries])
}
