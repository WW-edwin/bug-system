import { randomUUID } from 'node:crypto'

export interface DingTalkClientSettings {
  dryRun: boolean
  clientId: string
  clientSecret: string
  agentId: string
  corpId: string
  requestTimeoutMs: number
  workerPollMs: number
}

export interface IssueNotificationMessage {
  issueKey: string
  title: string
  priority: string
  project: string
  module: string
  environment: string
  reporter: string
  assignees: string[]
  url: string
}

export interface DingTalkUser {
  userId: string
  unionId: string | null
  name: string
  active: boolean
}

export interface DingTalkSendResult {
  failedUserIds: string[]
  forbiddenUserIds: string[]
  invalidUserIds: string[]
  readUserIds: string[]
  unreadUserIds: string[]
}

type FetchLike = typeof fetch

const retryableBusinessCodes = new Set([
  '-1',
  '88',
  '500',
  '90005',
  '90006',
  '90008',
  '90010',
  '90014',
  '90018',
  '90019',
  '143103',
  '143104',
  '143203',
  '143204',
  '1430003',
])

export class DingTalkApiError extends Error {
  readonly code: string
  readonly httpStatus?: number
  readonly retryable: boolean
  readonly outcomeUnknown: boolean

  constructor(message: string, options: { code?: string; httpStatus?: number; retryable?: boolean; outcomeUnknown?: boolean } = {}) {
    super(message)
    this.name = 'DingTalkApiError'
    this.code = options.code ?? 'DINGTALK_ERROR'
    this.httpStatus = options.httpStatus
    this.retryable = options.retryable ?? false
    this.outcomeUnknown = options.outcomeUnknown ?? false
  }
}

function compactText(value: string, maxLength = 160) {
  return value.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, maxLength)
}

function markdownText(value: string, maxLength = 160) {
  return compactText(value, maxLength).replace(/([\\`*_\[\]()#>|])/g, '\\$1')
}

export function buildIssueActionCard(message: IssueNotificationMessage) {
  const issueKey = markdownText(message.issueKey, 40)
  const title = markdownText(message.title, 240)
  const lines = [
    `### TraceBug 新缺陷 · [${markdownText(message.priority, 8)}] ${issueKey}`,
    '',
    `**${title}**`,
    '',
    `- 项目：${markdownText(message.project, 100)}`,
    `- 模块：${markdownText(message.module, 100)}`,
    `- 环境：${markdownText(message.environment, 160)}`,
    `- 创建人：${markdownText(message.reporter, 80)}`,
    `- 负责人：${message.assignees.map((name) => markdownText(name, 80)).join('、')}`,
  ]
  return {
    msgtype: 'action_card',
    action_card: {
      title: `TraceBug 新缺陷 · [${compactText(message.priority, 8)}] ${compactText(message.issueKey, 40)}`,
      markdown: lines.join('\n'),
      single_title: '查看缺陷',
      single_url: message.url,
    },
  }
}

function toStringArray(value: unknown) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean)
  if (typeof value === 'string') return value.split(',').map((item) => item.trim()).filter(Boolean)
  return []
}

function businessCode(body: Record<string, unknown>) {
  const value = body.errcode ?? body.code
  if (value === undefined || value === null) return null
  return String(value)
}

export class DingTalkClient {
  private accessToken: { value: string; expiresAt: number } | null = null
  private nextRequestAt = 0

  constructor(private readonly settings: DingTalkClientSettings, private readonly fetchImpl: FetchLike = fetch) {}

  private agentIdNumber() {
    const value = Number(this.settings.agentId)
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new DingTalkApiError('DINGTALK_AGENT_ID 必须是有效的正整数', { code: 'INVALID_AGENT_ID' })
    }
    return value
  }

  private async requestJson<T extends Record<string, unknown>>(
    url: string,
    init: RequestInit,
    options: { mayHaveSideEffects?: boolean } = {},
  ): Promise<T> {
    const scheduledAt = Math.max(Date.now(), this.nextRequestAt)
    this.nextRequestAt = scheduledAt + 100
    if (scheduledAt > Date.now()) await new Promise((resolve) => setTimeout(resolve, scheduledAt - Date.now()))
    let response: Response
    try {
      response = await this.fetchImpl(url, {
        ...init,
        signal: AbortSignal.timeout(this.settings.requestTimeoutMs),
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : '网络请求失败'
      throw new DingTalkApiError(`钉钉网络请求失败：${message}`, {
        code: 'NETWORK_ERROR',
        retryable: true,
        outcomeUnknown: options.mayHaveSideEffects === true,
      })
    }

    const body = await response.json().catch(() => ({})) as T
    if (!response.ok) {
      throw new DingTalkApiError(`钉钉接口返回 HTTP ${response.status}`, {
        code: `HTTP_${response.status}`,
        httpStatus: response.status,
        retryable: response.status === 429 || response.status >= 500,
        outcomeUnknown: options.mayHaveSideEffects === true && response.status >= 500,
      })
    }

    const code = businessCode(body)
    if (code && code !== '0') {
      const detail = typeof body.errmsg === 'string' ? body.errmsg : typeof body.message === 'string' ? body.message : '业务错误'
      throw new DingTalkApiError(`钉钉接口错误 ${code}：${compactText(detail, 300)}`, {
        code,
        httpStatus: response.status,
        retryable: retryableBusinessCodes.has(code),
      })
    }
    return body
  }

  private async token() {
    if (this.settings.dryRun) return 'dry-run-token'
    if (this.accessToken && this.accessToken.expiresAt - 5 * 60_000 > Date.now()) return this.accessToken.value
    const body = await this.requestJson<{ accessToken?: unknown; expireIn?: unknown }>(
      'https://api.dingtalk.com/v1.0/oauth2/accessToken',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appKey: this.settings.clientId, appSecret: this.settings.clientSecret }),
      },
    )
    const value = typeof body.accessToken === 'string' ? body.accessToken : ''
    const expiresIn = Number(body.expireIn ?? 7200)
    if (!value) throw new DingTalkApiError('钉钉 accessToken 响应缺少 accessToken', { code: 'INVALID_TOKEN_RESPONSE' })
    this.accessToken = { value, expiresAt: Date.now() + Math.max(60, expiresIn) * 1000 }
    return value
  }

  private async postOapi<T extends Record<string, unknown>>(
    path: string,
    body: Record<string, unknown>,
    options: { mayHaveSideEffects?: boolean } = {},
    retryAuth = true,
  ): Promise<T> {
    const token = await this.token()
    try {
      return await this.requestJson<T>(
        `https://oapi.dingtalk.com${path}?access_token=${encodeURIComponent(token)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
        options,
      )
    } catch (error) {
      if (retryAuth && error instanceof DingTalkApiError && ['40014', '42001'].includes(error.code)) {
        this.accessToken = null
        return this.postOapi<T>(path, body, options, false)
      }
      throw error
    }
  }

  async validateUser(userId: string): Promise<DingTalkUser> {
    if (this.settings.dryRun) {
      return { userId, unionId: null, name: `Dry Run ${userId}`, active: true }
    }
    const body = await this.postOapi<{ result?: Record<string, unknown> }>('/topapi/v2/user/get', {
      language: 'zh_CN',
      userid: userId,
    })
    const result = body.result ?? {}
    const returnedUserId = typeof result.userid === 'string' ? result.userid : ''
    if (!returnedUserId) throw new DingTalkApiError('钉钉用户详情响应缺少 userId', { code: 'INVALID_USER_RESPONSE' })
    return {
      userId: returnedUserId,
      unionId: typeof result.unionid === 'string' ? result.unionid : null,
      name: typeof result.name === 'string' ? result.name : returnedUserId,
      active: result.active === true || result.active === 'true',
    }
  }

  async sendIssueNotification(userIds: string[], message: IssueNotificationMessage) {
    if (this.settings.dryRun) return { taskId: `dry-run-${randomUUID()}` }
    const body = await this.postOapi<{ task_id?: unknown }>(
      '/topapi/message/corpconversation/asyncsend_v2',
      {
        agent_id: this.agentIdNumber(),
        userid_list: userIds.join(','),
        to_all_user: false,
        msg: buildIssueActionCard(message),
      },
      { mayHaveSideEffects: true },
    )
    if (body.task_id === undefined || body.task_id === null) {
      throw new DingTalkApiError('钉钉发送响应缺少 task_id', { code: 'INVALID_SEND_RESPONSE', outcomeUnknown: true })
    }
    return { taskId: String(body.task_id) }
  }

  async getSendProgress(taskId: string) {
    if (this.settings.dryRun) return { status: 2, percent: 100 }
    const body = await this.postOapi<{ progress?: Record<string, unknown> }>(
      '/topapi/message/corpconversation/getsendprogress',
      { agent_id: this.agentIdNumber(), task_id: Number(taskId) },
    )
    return {
      status: Number(body.progress?.status ?? -1),
      percent: Number(body.progress?.progress_in_percent ?? 0),
    }
  }

  async getSendResult(taskId: string, expectedUserIds: string[]): Promise<DingTalkSendResult> {
    if (this.settings.dryRun) {
      return { failedUserIds: [], forbiddenUserIds: [], invalidUserIds: [], readUserIds: [...expectedUserIds], unreadUserIds: [] }
    }
    const body = await this.postOapi<{ send_result?: Record<string, unknown> }>(
      '/topapi/message/corpconversation/getsendresult',
      { agent_id: this.agentIdNumber(), task_id: Number(taskId) },
    )
    const result = body.send_result ?? {}
    const forbiddenFromDetails = Array.isArray(result.forbidden_list)
      ? result.forbidden_list.flatMap((item) => {
        if (!item || typeof item !== 'object') return []
        const record = item as Record<string, unknown>
        const userId = record.userid ?? record.userId
        return userId ? [String(userId)] : []
      })
      : []
    return {
      failedUserIds: toStringArray(result.failed_user_id_list),
      forbiddenUserIds: [...new Set([...toStringArray(result.forbidden_user_id_list), ...forbiddenFromDetails])],
      invalidUserIds: toStringArray(result.invalid_user_id_list),
      readUserIds: toStringArray(result.read_user_id_list),
      unreadUserIds: toStringArray(result.unread_user_id_list),
    }
  }
}

export function validateDingTalkSettings(settings: DingTalkClientSettings, enabled: boolean, publicAppOrigin: string) {
  if (!enabled) return
  if (!Number.isFinite(settings.requestTimeoutMs) || settings.requestTimeoutMs < 1_000 || settings.requestTimeoutMs > 30_000) {
    throw new Error('DINGTALK_REQUEST_TIMEOUT_MS 必须在 1000 到 30000 之间')
  }
  if (!Number.isFinite(settings.workerPollMs) || settings.workerPollMs < 500 || settings.workerPollMs > 60_000) {
    throw new Error('DINGTALK_WORKER_POLL_MS 必须在 500 到 60000 之间')
  }
  if (settings.dryRun) return
  const missing = [
    ['DINGTALK_CLIENT_ID', settings.clientId],
    ['DINGTALK_CLIENT_SECRET', settings.clientSecret],
    ['DINGTALK_AGENT_ID', settings.agentId],
    ['DINGTALK_CORP_ID', settings.corpId],
    ['PUBLIC_ORIGIN', publicAppOrigin],
  ].filter(([, value]) => !value).map(([name]) => name)
  if (missing.length) throw new Error(`钉钉通知已启用，但缺少配置：${missing.join(', ')}`)
  const agentId = Number(settings.agentId)
  if (!/^\d+$/.test(settings.agentId) || !Number.isSafeInteger(agentId) || agentId <= 0) {
    throw new Error('DINGTALK_AGENT_ID 必须是有效的正整数')
  }
  try {
    const url = new URL(publicAppOrigin)
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) throw new Error('invalid protocol')
  } catch {
    throw new Error('PUBLIC_ORIGIN 必须是有效的绝对 HTTP(S) 地址')
  }
}
