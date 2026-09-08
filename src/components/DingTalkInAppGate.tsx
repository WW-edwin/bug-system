import { type ReactNode, useEffect, useRef, useState } from 'react'
import { AlertCircle, Bug, RefreshCw, ShieldCheck } from 'lucide-react'
import { api } from '../api'
import { createDingTalkInAppAttempt, inAppErrorCode, type DingTalkInAppAttempt } from '../dingtalkInApp'
import { AuthPageLayout, DingTalkBindingPage, dingTalkErrorMessage, dingTalkReturnTo } from './DingTalkAuth'

type GateMode = 'checking' | 'failed' | 'binding' | 'workspace' | 'account'
export interface InAppWorkspaceControls {
  forceAccountLogin: boolean
  onLoggedOut: () => void
  onRetryDingTalk: () => void
}

function replaceReturnTo(returnTo: string, binding = false) {
  const url = new URL(returnTo, window.location.origin)
  if (url.origin !== window.location.origin || url.pathname !== '/') throw new Error('Invalid return path')
  url.searchParams.delete('dingtalk')
  url.searchParams.delete('dingtalk_error')
  if (binding) url.searchParams.set('dingtalk', 'bind')
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
}

export function DingTalkInAppGate({ bindingRequested, children }: { bindingRequested: boolean; children: (controls: InAppWorkspaceControls) => ReactNode }) {
  const [mode, setMode] = useState<GateMode>(bindingRequested ? 'binding' : 'checking')
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [fallback, setFallback] = useState<'account' | 'browser' | null>(null)
  const taskRef = useRef<{ attempt: number; task: DingTalkInAppAttempt } | null>(null)
  const fallbackRef = useRef(false)

  useEffect(() => {
    if (mode !== 'checking') return
    if (taskRef.current?.attempt !== attempt) taskRef.current = { attempt, task: createDingTalkInAppAttempt(dingTalkReturnTo()) }
    const task = taskRef.current.task
    let mounted = true
    void task.subscribe().then((result) => {
      if (!mounted) return
      replaceReturnTo(result.returnTo, result.needsBinding)
      setMode(result.needsBinding ? 'binding' : 'workspace')
    }).catch((loginError) => {
      if (!mounted) return
      setError(dingTalkErrorMessage(inAppErrorCode(loginError)))
      setMode('failed')
    })
    return () => { mounted = false; task.release() }
  }, [mode, attempt])

  function retry() {
    if (fallbackRef.current || mode === 'checking') return
    setError('')
    setAttempt((value) => value + 1)
    setMode('checking')
  }

  async function useFallback(target: 'account' | 'browser') {
    if (fallbackRef.current) return
    fallbackRef.current = true
    setFallback(target)
    setError('')
    try {
      await taskRef.current?.task.cancel()
      await api.cancelDingTalkBinding(AbortSignal.timeout(5000))
      await api.logout(AbortSignal.timeout(5000))
      if (target === 'browser') {
        window.location.assign(`/api/auth/dingtalk/start?returnTo=${encodeURIComponent(dingTalkReturnTo())}`)
        return
      }
      replaceReturnTo(dingTalkReturnTo())
      setMode('account')
    } catch {
      setError('暂时无法安全切换登录方式，请稍后重试。')
    }
    fallbackRef.current = false
    setFallback(null)
  }

  if (mode === 'binding') return <DingTalkBindingPage
    onAuthenticated={(returnTo) => { replaceReturnTo(returnTo); setMode('workspace') }}
    onCancelled={async (returnTo) => { await api.logout(AbortSignal.timeout(5000)); replaceReturnTo(returnTo); setMode('account') }}
    onRetryInApp={() => { replaceReturnTo(dingTalkReturnTo()); retry() }}
  />

  if (mode === 'workspace' || mode === 'account') return children({
    forceAccountLogin: mode === 'account',
    onLoggedOut: () => setMode('account'),
    onRetryDingTalk: retry,
  })

  return <AuthPageLayout><section className="login-form dingtalk-in-app-gate">
    <div className="login-mobile-brand"><span className="brand-mark"><Bug size={20} /></span><span>TraceBug</span></div>
    <div className="login-kicker">DINGTALK ACCESS</div>
    <h1>{mode === 'checking' ? '正在验证钉钉身份' : '钉钉免登未完成'}</h1>
    <p>{mode === 'checking' ? '正在确认当前钉钉账号，请稍候。' : '可以重新验证当前账号，或选择其他登录方式。'}</p>
    {mode === 'checking' ? <div className="dingtalk-identity-card" role="status"><RefreshCw className="dingtalk-auth-spinner" size={21} /><span>验证完成后将打开你的工作台</span></div> : <>
      <div className="dingtalk-identity-card expired" role="alert"><AlertCircle size={20} /><span>{error}</span></div>
      <button className="primary-button login-button" type="button" disabled={Boolean(fallback)} onClick={retry}><ShieldCheck size={18} />重试钉钉免登</button>
      <button className="secondary-button dingtalk-login-button dingtalk-fallback-button" type="button" disabled={Boolean(fallback)} onClick={() => void useFallback('account')}>{fallback === 'account' ? '正在切换…' : '改用账号登录'}</button>
      <button className="dingtalk-binding-cancel" type="button" disabled={Boolean(fallback)} onClick={() => void useFallback('browser')}>{fallback === 'browser' ? '正在前往授权…' : '改用钉钉扫码授权'}</button>
    </>}
  </section></AuthPageLayout>
}
