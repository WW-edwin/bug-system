import type { Issue, Priority, Project, Session, WorkspaceData } from './types'

export interface EmployeeAccount {
  id: string
  email: string | null
  name: string
  role: 'admin' | 'member'
  active: boolean
  createdAt: string
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
  createProject: (input: Pick<Project, 'name' | 'key' | 'description'>) => request<{ project: Project }>('/api/projects', { method: 'POST', body: JSON.stringify(input) }),
  deleteProject: (projectId: string) => request<void>(`/api/projects/${encodeURIComponent(projectId)}`, { method: 'DELETE' }),
  createIssue: (projectId: string, input: Omit<Issue, 'id' | 'createdAt' | 'updatedAt' | 'activities' | 'reporter' | 'lastModifiedBy'>) => request<{ issue: Issue }>(`/api/projects/${encodeURIComponent(projectId)}/issues`, { method: 'POST', body: JSON.stringify(input) }),
  updateIssue: (issueId: string, input: Partial<Pick<Issue, 'title' | 'description' | 'status' | 'priority' | 'module'>>) => request<{ issue: Issue }>(`/api/issues/${encodeURIComponent(issueId)}`, { method: 'PATCH', body: JSON.stringify(input) }),
  comment: (issueId: string, comment: string) => request<{ issue: Issue }>(`/api/issues/${encodeURIComponent(issueId)}/comments`, { method: 'POST', body: JSON.stringify({ comment }) }),
  deleteIssue: (issueId: string) => request<void>(`/api/issues/${encodeURIComponent(issueId)}`, { method: 'DELETE' }),
  uploadImage: async (file: File) => {
    const form = new FormData()
    form.append('image', file)
    return request<{ url: string }>('/api/uploads', { method: 'POST', body: form })
  },
  users: () => request<{ users: EmployeeAccount[] }>('/api/auth/users'),
  promoteUser: (id: string) => request<{ user: EmployeeAccount }>(`/api/auth/users/${encodeURIComponent(id)}/role`, { method: 'PATCH' }),
  resetUserPassword: (id: string, password: string) => request<void>(`/api/auth/users/${encodeURIComponent(id)}/password`, { method: 'PATCH', body: JSON.stringify({ password }) }),
  deleteUser: (id: string) => request<void>(`/api/auth/users/${encodeURIComponent(id)}`, { method: 'DELETE' }),
}

export type CreateIssueInput = {
  title: string
  description: string
  status: '待处理'
  priority: Priority
  module: string
  environment: string
}
