export type DingTalkLoginIdentity = {
  corpId: string
  userId: string
  unionId: string
  name: string
}

export interface DingTalkLoginClientSettings {
  clientId: string
  clientSecret: string
  corpId: string
  requestTimeoutMs: number
}

const errorMessages = {
  LOGIN_NOT_CONFIGURED: '钉钉登录配置不完整，请联系管理员',
  INVALID_AUTH_CODE: '钉钉授权码无效，请重新发起登录',
  AUTH_CODE_REJECTED: '钉钉授权已失效或被拒绝，请重新发起登录',
  PROVIDER_PERMISSION_DENIED: '钉钉应用尚未获得所需身份权限，请联系管理员',
  PROVIDER_UNAVAILABLE: '钉钉身份服务暂时不可用，请稍后重试',
  PROVIDER_REJECTED: '钉钉身份验证未通过，请联系管理员检查应用配置和权限',
  PROVIDER_INVALID_RESPONSE: '钉钉返回的身份信息不完整，暂时无法登录',
  REQUEST_TIMEOUT: '钉钉身份验证超时，请重新发起登录',
  NOT_CORP_MEMBER: '当前钉钉账号不是本企业内部成员，无法登录',
  INACTIVE_USER: '当前钉钉企业账号尚未激活，无法登录',
  IDENTITY_MISMATCH: '钉钉身份信息校验不一致，无法登录',
} as const

export type DingTalkLoginErrorCode = keyof typeof errorMessages

export class DingTalkLoginError extends Error {
  constructor(readonly code: DingTalkLoginErrorCode) {
    super(errorMessages[code])
    this.name = 'DingTalkLoginError'
  }
}

type JsonObject = Record<string, unknown>
type RequestStage = 'user-token' | 'user-profile' | 'corp-token' | 'corp-member' | 'corp-profile'

function objectValue(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DingTalkLoginError('PROVIDER_INVALID_RESPONSE')
  }
  return value as JsonObject
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim()) {
    throw new DingTalkLoginError('PROVIDER_INVALID_RESPONSE')
  }
  return value
}

function isSuccessCode(value: unknown) {
  return value === 0 || value === '0'
}

function providerError(stage: RequestStage, code: unknown, httpStatus: number): DingTalkLoginError {
  if (httpStatus === 429 || httpStatus >= 500) return new DingTalkLoginError('PROVIDER_UNAVAILABLE')
  if (httpStatus === 403) return new DingTalkLoginError('PROVIDER_PERMISSION_DENIED')
  if ((stage === 'corp-member' || stage === 'corp-profile') && ['60121', '60103'].includes(String(code))) {
    return new DingTalkLoginError('NOT_CORP_MEMBER')
  }
  if (stage === 'user-token') return new DingTalkLoginError('AUTH_CODE_REJECTED')
  return new DingTalkLoginError('PROVIDER_REJECTED')
}

/** OAuth login deliberately has no notification dry-run or synthetic identity path. */
export class DingTalkLoginClient {
  constructor(private readonly settings: DingTalkLoginClientSettings, private readonly fetchImpl: typeof fetch = fetch) {}

  private async requestJson(url: string, init: RequestInit, stage: RequestStage, legacy = false): Promise<JsonObject> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.settings.requestTimeoutMs)
    try {
      const response = await this.fetchImpl(url, { ...init, redirect: 'error', signal: controller.signal })
      if (!response.ok) throw providerError(stage, undefined, response.status)
      let value: unknown
      try {
        value = await response.json()
      } catch {
        if (controller.signal.aborted) throw new DingTalkLoginError('REQUEST_TIMEOUT')
        throw new DingTalkLoginError('PROVIDER_INVALID_RESPONSE')
      }
      const body = objectValue(value)
      if (legacy && !Object.hasOwn(body, 'errcode')) throw new DingTalkLoginError('PROVIDER_INVALID_RESPONSE')
      for (const key of ['errcode', 'code']) {
        if (Object.hasOwn(body, key) && !isSuccessCode(body[key])) throw providerError(stage, body[key], response.status)
      }
      if (body.success === false) throw providerError(stage, undefined, response.status)
      return body
    } catch (error) {
      if (error instanceof DingTalkLoginError) throw error
      // Provider error bodies, URLs, tokens and underlying network errors never escape this client.
      if (controller.signal.aborted) throw new DingTalkLoginError('REQUEST_TIMEOUT')
      throw new DingTalkLoginError('PROVIDER_UNAVAILABLE')
    } finally {
      clearTimeout(timeout)
    }
  }

  private post(url: string, body: JsonObject, stage: RequestStage, legacy = false) {
    return this.requestJson(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, stage, legacy)
  }

  async exchangeCode(authCode: string): Promise<DingTalkLoginIdentity> {
    const { clientId, clientSecret, corpId, requestTimeoutMs } = this.settings
    if (![clientId, clientSecret, corpId].every((value) => typeof value === 'string' && value.trim() && value === value.trim())
      || !Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 30_000) {
      throw new DingTalkLoginError('LOGIN_NOT_CONFIGURED')
    }
    if (typeof authCode !== 'string' || !authCode.trim() || authCode !== authCode.trim() || authCode.length > 4096) {
      throw new DingTalkLoginError('INVALID_AUTH_CODE')
    }

    const userTokenBody = await this.post('https://api.dingtalk.com/v1.0/oauth2/userAccessToken', {
      clientId,
      clientSecret,
      code: authCode,
      grantType: 'authorization_code',
    }, 'user-token')
    const userToken = requiredString(userTokenBody.accessToken)
    const profile = await this.requestJson('https://api.dingtalk.com/v1.0/contact/users/me', {
      method: 'GET',
      headers: { 'x-acs-dingtalk-access-token': userToken },
    }, 'user-profile')
    const unionId = requiredString(profile.unionId)

    // This internal application's token scopes both directory lookups to its enterprise.
    const corpTokenBody = await this.post('https://api.dingtalk.com/v1.0/oauth2/accessToken', {
      appKey: clientId,
      appSecret: clientSecret,
    }, 'corp-token')
    const corpToken = encodeURIComponent(requiredString(corpTokenBody.accessToken))
    const memberBody = await this.post(`https://oapi.dingtalk.com/topapi/user/getbyunionid?access_token=${corpToken}`, {
      unionid: unionId,
    }, 'corp-member', true)
    const member = objectValue(memberBody.result)
    const userId = requiredString(member.userid)
    // The official legacy SDK defines 0 as internal employee and 1 as external contact.
    if (!Object.hasOwn(member, 'contact_type')) throw new DingTalkLoginError('PROVIDER_INVALID_RESPONSE')
    if (member.contact_type !== 0 && member.contact_type !== '0') throw new DingTalkLoginError('NOT_CORP_MEMBER')

    const detailBody = await this.post(`https://oapi.dingtalk.com/topapi/v2/user/get?access_token=${corpToken}`, {
      userid: userId,
      language: 'zh_CN',
    }, 'corp-profile', true)
    const detail = objectValue(detailBody.result)
    if (requiredString(detail.userid) !== userId || requiredString(detail.unionid) !== unionId) {
      throw new DingTalkLoginError('IDENTITY_MISMATCH')
    }
    if (detail.active !== true && detail.active !== 'true') throw new DingTalkLoginError('INACTIVE_USER')
    return { corpId, userId, unionId, name: requiredString(detail.name) }
  }
}
