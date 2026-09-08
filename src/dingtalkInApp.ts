import { api, ApiError, type DingTalkClientDiagnostic, type DingTalkInAppResult } from './api'

export function isDingTalkClient() {
  // This only selects the client bridge. The server independently verifies identity.
  return /DingTalk/i.test(navigator.userAgent)
}

class InAppLoginError extends Error {
  constructor(readonly code: string) { super(code) }
}

export function inAppErrorCode(error: unknown) {
  if (error instanceof InAppLoginError || error instanceof ApiError) return error.code ?? 'provider_failed'
  return 'provider_failed'
}

function abortable<T>(promise: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new InAppLoginError('cancelled'))
    if (signal.aborted) { abort(); return }
    signal.addEventListener('abort', abort, { once: true })
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

function clientBridgeFacts() {
  const nativeWindow = window as Window & { dingtalk?: { platform?: { invokeAPI?: unknown } } }
  let hasContainerId = false
  try { hasContainerId = Boolean((JSON.parse(window.name) as { containerId?: unknown })?.containerId) } catch { /* Never retain or send window.name. */ }
  return { hasPcBridge: typeof nativeWindow.dingtalk?.platform?.invokeAPI === 'function', hasContainerId }
}

function safeSdkCode(error: unknown) {
  if (!error || typeof error !== 'object') return undefined
  const source = error as Record<string, unknown>
  for (const candidate of [source.errorCode, source.errCode, source.code]) {
    if ((typeof candidate === 'string' || typeof candidate === 'number') && /^-?\d{1,9}$/.test(String(candidate))) return String(candidate)
  }
  return undefined
}

async function requestClientCode(corpId: string, signal: AbortSignal, diagnostic: DingTalkClientDiagnostic) {
  Object.assign(diagnostic, clientBridgeFacts())
  const sdk = await abortable(import('./dingtalkClientSdk'), signal).catch(() => {
    throw signal.aborted ? signal.reason : new InAppLoginError('client_bridge_failed')
  })
  if (signal.aborted) throw signal.reason
  diagnostic.stage = 'bridge_ready'
  const platform = sdk.environment.platform
  diagnostic.platform = ['pc', 'ios', 'android', 'harmony', 'notInDingTalk'].includes(platform)
    ? platform as DingTalkClientDiagnostic['platform'] : 'unknown'
  if (platform === 'notInDingTalk') {
    diagnostic.sdkCode = '4040'
    throw new InAppLoginError('client_bridge_failed')
  }
  return abortable(new Promise<string>((resolve, reject) => {
    let settled = false
    const fail = (error?: unknown) => {
      if (settled || signal.aborted) return
      settled = true
      const sdkCode = safeSdkCode(error)
      if (sdkCode) diagnostic.sdkCode = sdkCode
      reject(new InAppLoginError('client_bridge_failed'))
    }
    const success = (result: { code?: string } | null | undefined) => {
      if (signal.aborted || settled) return
      if (typeof result?.code === 'string' && result.code.trim() && result.code.length <= 2048) {
        settled = true
        resolve(result.code)
      } else {
        diagnostic.stage = 'missing_code'
        fail()
      }
    }
    try {
      diagnostic.stage = 'request_code'
      // The modular SDK waits for its bridge internally. Its Promise also exposes
      // initialization failures that dd.ready's callback-only wrapper can hide.
      const input = { corpId, onSuccess: success, onFail: fail }
      const result = sdk.requestAuthCode(input)
      if (result && typeof result.then === 'function') void result.then(success, fail)
    } catch (error) { fail(error) }
  }), signal)
}

export interface DingTalkInAppAttempt {
  subscribe: () => Promise<DingTalkInAppResult>
  release: () => void
  cancel: () => Promise<void>
}

export function createDingTalkInAppAttempt(returnTo: string): DingTalkInAppAttempt {
  const controller = new AbortController()
  let task: Promise<DingTalkInAppResult> | undefined
  let subscribers = 0
  let releaseTimer: ReturnType<typeof setTimeout> | undefined
  let deadline: ReturnType<typeof setTimeout> | undefined
  let finished = false

  function armDeadline(milliseconds: number, code = 'provider_timeout') {
    clearTimeout(deadline)
    deadline = setTimeout(() => controller.abort(new InAppLoginError(code)), milliseconds)
  }

  async function run() {
    let started = false
    let flowState: string | undefined
    const diagnostic: DingTalkClientDiagnostic = { stage: 'sdk_load' }
    try {
      armDeadline(12000)
      const options = await abortable(api.dingTalkLoginOptions(controller.signal), controller.signal)
      if (!options.inAppAvailable) throw new InAppLoginError('unavailable')
      started = true
      const flow = await abortable(api.startDingTalkInApp(returnTo, controller.signal), controller.signal)
      flowState = flow.state
      armDeadline(12000, 'client_bridge_timeout')
      const code = await requestClientCode(flow.corpId, controller.signal, diagnostic)
      if (controller.signal.aborted) throw controller.signal.reason
      // Server completion verifies enterprise membership through several provider calls.
      armDeadline(25000)
      const result = await abortable(api.completeDingTalkInApp({ state: flow.state, code }, controller.signal), controller.signal)
      if (!result.needsBinding && !result.user) throw new InAppLoginError('provider_failed')
      return result
    } catch (error) {
      clearTimeout(deadline)
      let reported = false
      if (flowState && error instanceof InAppLoginError && ['client_bridge_failed', 'client_bridge_timeout'].includes(error.code)) {
        try {
          await api.reportDingTalkClientError({ state: flowState, diagnostic }, AbortSignal.timeout(3000))
          reported = true
        } catch { /* A failed diagnostic report must not leave the flow active. */ }
      }
      if (started && !reported) {
        try { await api.cancelDingTalkBinding(AbortSignal.timeout(3000)) } catch { /* Explicit retry/fallback clears the flow again. */ }
      }
      throw error
    } finally {
      clearTimeout(deadline)
      finished = true
    }
  }

  return {
    subscribe() {
      clearTimeout(releaseTimer)
      subscribers += 1
      task ??= run()
      return task
    },
    release() {
      subscribers -= 1
      // React StrictMode releases and re-subscribes within this tick. A genuine
      // unmount stops pending SDK callbacks before they can submit an auth code.
      releaseTimer = setTimeout(() => { if (!subscribers && !finished) controller.abort(new InAppLoginError('cancelled')) }, 0)
    },
    async cancel() {
      if (!finished) controller.abort(new InAppLoginError('cancelled'))
      await task?.catch(() => undefined)
    },
  }
}
