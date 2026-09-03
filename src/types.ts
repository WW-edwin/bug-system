export type IssueStatus = '待处理' | '处理中' | '待复测' | '已修复' | '不适用' | '不解决'
export type Priority = 'P0' | 'P1' | 'P2' | 'P3'

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
}

export interface Session {
  id: string
  email: string
  name: string
  role: 'admin' | 'member'
}
