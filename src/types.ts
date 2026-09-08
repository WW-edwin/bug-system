export type IssueStatus = string
export type Priority = string

export type DictionaryKind = 'priority' | 'environment' | 'status'
export interface DictionaryEntry {
  value: string
  label: string
  active: boolean
  isDefault: boolean
  isTerminal: boolean
  weight: number
  showInPersonal: boolean
  position: number
}
export type DictionaryDraft = Omit<DictionaryEntry, 'value' | 'position'> & { value?: string }
export type IssueDictionaries = Record<DictionaryKind, DictionaryEntry[]>
export type DictionaryVersions = Record<DictionaryKind, number>
export interface DictionaryResponse {
  dictionaries: IssueDictionaries
  dictionaryVersions: DictionaryVersions
}

export interface Activity {
  id: string
  actor: string
  action: string
  detail: string
  timestamp: string
  kind: 'created' | 'changed' | 'commented'
}

export interface Issue {
  id: string
  title: string
  description: string
  status: IssueStatus
  priority: Priority
  module: string
  reporter: string
  assigneeIds: string[]
  assignees: string[]
  lastModifiedBy: string
  createdAt: string
  updatedAt: string
  environment: string
  activities: Activity[]
}

export interface Project {
  id: string
  key: string
  name: string
  description: string
  color: string
  members: string[]
  issues: Issue[]
}

export interface WorkspaceData {
  projects: Project[]
  dictionaries?: IssueDictionaries
  dictionaryVersions?: DictionaryVersions
}

export interface Session {
  id: string
  email: string
  name: string
  role: 'admin' | 'member'
}
