import type { Issue, Priority, Project, Session, WorkspaceData } from './types'
import type { EvidenceItem } from './issueDescription'

export interface EmployeeAccount {
  id: string
  email: string | null
  name: string
  role: 'admin' | 'member'
  active: boolean
  createdAt: string
  dingtalkUserId: string | null
  dingtalkStatus: 'matched' | 'unmatched' | 'conflict' | 'disabled'
  dingtalkBoundAt: string | null
}

export interface NotificationQueueResult {
  state: 'disabled' | 'queued' | 'partial' | 'skipped'
  queued: number
  unmapped: number
}

export interface DingTalkIntegrationStatus {
  enabled: boolean
  dryRun: boolean
  configured: boolean
}

export interface UserOption {
  id: string
  name: string
  pinyin: string
  initials: string
}

export class ApiError extends Error {
  status: number

  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

async function request<T>(url: string, options: RequestInit = {}): Promise<T> {
  const method = (options.method ?? 'GET').toUpperCase()
  const response = await fetch(url, {
    credentials: 'same-origin',
    cache: 'no-store',
    ...options,
    headers: {
      ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...(method === 'GET' ? { 'Cache-Control': 'no-cache' } : {}),
      ...options.headers,
    },
  })
  if (response.status === 204) return undefined as T
  const body = await response.json().catch(() => ({})) as { error?: string }
  if (!response.ok) throw new ApiError(body.error ?? '请求失败', response.status)
  return body as T
}

export const api = {
  me: () => request<{ user: Session | null }>('/api/auth/me'),
  login: (input: { name: string; password: string }) => request<{ user: Session }>('/api/auth/login', { method: 'POST', body: JSON.stringify(input) }),
  register: (input: { email: string; name: string; password: string }) => request<{ user: Session }>('/api/auth/register', { method: 'POST', body: JSON.stringify(input) }),
  logout: () => request<void>('/api/auth/logout', { method: 'POST' }),
  workspace: () => request<WorkspaceData>('/api/workspace'),
  userOptions: () => request<{ users: UserOption[] }>('/api/user-options'),
  createProject: (input: Pick<Project, 'name' | 'key' | 'description'>) => request<{ project: Project }>('/api/projects', { method: 'POST', body: JSON.stringify(input) }),
  deleteProject: (projectId: string) => request<void>(`/api/projects/${encodeURIComponent(projectId)}`, { method: 'DELETE' }),
  createIssue: (projectId: string, input: CreateIssueInput) => request<{ issue: Issue; notification?: NotificationQueueResult }>(`/api/projects/${encodeURIComponent(projectId)}/issues`, { method: 'POST', body: JSON.stringify(input) }),
  updateIssue: (issueId: string, input: Partial<Pick<Issue, 'title' | 'description' | 'status' | 'priority' | 'module' | 'assigneeIds'>>) => request<{ issue: Issue }>(`/api/issues/${encodeURIComponent(issueId)}`, { method: 'PATCH', body: JSON.stringify(input) }),
  comment: (issueId: string, comment: string) => request<{ issue: Issue }>(`/api/issues/${encodeURIComponent(issueId)}/comments`, { method: 'POST', body: JSON.stringify({ comment }) }),
  deleteIssue: (issueId: string) => request<void>(`/api/issues/${encodeURIComponent(issueId)}`, { method: 'DELETE' }),
  uploadEvidence: (file: File, onProgress?: (progress: number) => void) => new Promise<EvidenceItem>((resolve, reject) => {
    const form = new FormData()
    form.append('file', file)
    const xhr = new XMLHttpRequest()
    xhr.open('POST', '/api/uploads')
    xhr.responseType = 'json'
    xhr.withCredentials = true
    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return
      onProgress?.(Math.min(99, Math.round((event.loaded / event.total) * 100)))
    }
    xhr.onload = () => {
      const body = (xhr.response ?? {}) as EvidenceItem & { error?: string }
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress?.(100)
        resolve(body)
        return
      }
      reject(new ApiError(body.error ?? '证据上传失败', xhr.status))
    }
    xhr.onerror = () => reject(new ApiError('网络连接异常，证据上传失败', 0))
    xhr.onabort = () => reject(new ApiError('证据上传已取消', 0))
    xhr.ontimeout = () => reject(new ApiError('证据上传超时，请重试', 0))
    onProgress?.(0)
    xhr.send(form)
  }),
  users: () => request<{ users: EmployeeAccount[] }>('/api/auth/users'),
  promoteUser: (id: string) => request<{ user: EmployeeAccount }>(`/api/auth/users/${encodeURIComponent(id)}/role`, { method: 'PATCH' }),
  resetUserPassword: (id: string, password: string) => request<void>(`/api/auth/users/${encodeURIComponent(id)}/password`, { method: 'PATCH', body: JSON.stringify({ password }) }),
  deleteUser: (id: string) => request<void>(`/api/auth/users/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  dingTalkStatus: () => request<DingTalkIntegrationStatus>('/api/dingtalk/status'),
  bindDingTalkUser: (id: string, userId: string) => request<{ user: EmployeeAccount; verifiedName: string }>(`/api/dingtalk/users/${encodeURIComponent(id)}/binding`, { method: 'PATCH', body: JSON.stringify({ userId }) }),
  unbindDingTalkUser: (id: string) => request<void>(`/api/dingtalk/users/${encodeURIComponent(id)}/binding`, { method: 'DELETE' }),
}

export type CreateIssueInput = {
  title: string
  description: string
  status: '待处理'
  priority: Priority
  module: string
  environment: string
  assigneeIds: string[]
}
