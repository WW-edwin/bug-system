import { api, ApiError, type DingTalkInAppResult } from './api'

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

async function requestClientCode(corpId: string, signal: AbortSignal) {
  const module = await abortable(import('dingtalk-jsapi'), signal).catch(() => {
    throw signal.aborted ? signal.reason : new InAppLoginError('client_bridge_failed')
  })
  const dd = module.default ?? module
  if (signal.aborted) throw signal.reason
  return abortable(new Promise<string>((resolve, reject) => {
    let invoked = false
    const fail = () => reject(new InAppLoginError('client_bridge_failed'))
    const success = (result: { code?: string }) => {
      if (signal.aborted) return
      if (typeof result.code === 'string' && result.code.trim() && result.code.length <= 2048) resolve(result.code)
      else fail()
    }
    try {
      dd.ready(() => {
        if (signal.aborted || invoked) return
        invoked = true
        try {
          // The official package accepts callbacks and returns a Promise. Both feed
          // this single result, without persisting or logging the one-use code.
          const input = { corpId, onSuccess: success, onFail: fail }
          const result = dd.runtime.permission.requestAuthCode(input)
          if (result && typeof result.then === 'function') void result.then(success, fail)
        } catch { fail() }
      })
    } catch { fail() }
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
    try {
      armDeadline(12000)
      const options = await abortable(api.dingTalkLoginOptions(controller.signal), controller.signal)
      if (!options.inAppAvailable) throw new InAppLoginError('unavailable')
      started = true
      const flow = await abortable(api.startDingTalkInApp(returnTo, controller.signal), controller.signal)
      armDeadline(12000, 'client_bridge_timeout')
      const code = await requestClientCode(flow.corpId, controller.signal)
      if (controller.signal.aborted) throw controller.signal.reason
      // Server completion verifies enterprise membership through several provider calls.
      armDeadline(25000)
      const result = await abortable(api.completeDingTalkInApp({ state: flow.state, code }, controller.signal), controller.signal)
      if (!result.needsBinding && !result.user) throw new InAppLoginError('provider_failed')
      return result
    } catch (error) {
      clearTimeout(deadline)
      if (started) {
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
