import { type FormEvent, type ReactNode, useEffect, useRef, useState } from 'react'
import { AlertCircle, ArrowRight, Bug, KeyRound, Link2, RefreshCw, ShieldCheck, UserRound, X } from 'lucide-react'
import { api, ApiError, type DingTalkLoginOptions, type DingTalkPendingIdentity } from '../api'

export function dingTalkReturnTo() {
  const url = new URL(window.location.href)
  url.searchParams.delete('dingtalk')
  url.searchParams.delete('dingtalk_error')
  return `${url.pathname}${url.search}${url.hash}`
}

function returnToApp(returnTo: string) {
  const url = new URL(returnTo, window.location.origin)
  window.location.replace(url.origin === window.location.origin && !url.pathname.startsWith('/api/')
    ? `${url.pathname}${url.search}${url.hash}`
    : '/')
}

export function dingTalkErrorMessage(code: string | null) {
  if (!code) return ''
  const messages: Record<string, string> = {
    cancelled: '已取消钉钉授权，你可以重新尝试或使用账号登录。',
    expired: '钉钉授权已过期，请重新发起钉钉登录。',
    unavailable: '钉钉登录暂未开放，请使用账号登录。',
    not_allowed: '当前钉钉账号暂未开放登录权限，请联系管理员。',
    company_required: '请使用本公司钉钉账号登录。',
    identity_conflict: '钉钉身份与已有账号关联冲突，请联系管理员确认。',
    account_disabled: '关联的 Bug 系统账号已停用，请联系管理员。',
    provider_failed: '暂时无法完成钉钉身份验证，请稍后重试或使用账号登录。',
    permission_required: '钉钉应用尚未开通所需的身份信息权限，请联系应用管理员。',
    provider_timeout: '钉钉身份验证超时，请重新登录或暂时使用账号登录。',
  }
  return Object.hasOwn(messages, code) ? messages[code] : '钉钉登录未完成，请重新尝试或使用账号登录。'
}

export function DingTalkAuthNotice({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return <div className="dingtalk-auth-notice" role="alert"><AlertCircle size={19} /><p>{message}</p><button type="button" aria-label="关闭钉钉登录提示" onClick={onDismiss}><X size={18} /></button></div>
}

export function AuthPageLayout({ children }: { children: ReactNode }) {
  return <main className="login-shell">
    <section className="login-visual" aria-label="TraceBug 品牌展示">
      <img src="/qa-workspace.jpg" alt="摆放着编程设备的软件研发工作台" />
      <div className="login-visual-shade" />
      <div className="login-brand"><span className="brand-mark brand-mark-light"><Bug size={22} strokeWidth={2.2} /></span><span>TraceBug</span></div>
      <div className="login-visual-meta"><span>QUALITY OPERATIONS</span><strong>问题可见，责任清晰。</strong><small>内部系统 · 2026</small></div>
    </section>
    <section className="login-panel">{children}</section>
  </main>
}

export function DingTalkLoginButton({ disabled = false, onStarting, label = '钉钉登录' }: { disabled?: boolean; onStarting?: () => void; label?: string }) {
  const [options, setOptions] = useState<DingTalkLoginOptions | null>(null)
  const [loading, setLoading] = useState(true)
  const [starting, setStarting] = useState(false)
  const startingRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    void api.dingTalkLoginOptions()
      .then((result) => { if (!cancelled) setOptions(result) })
      .catch(() => { if (!cancelled) setOptions({ enabled: false, available: false }) })
      .finally(() => { if (!cancelled) setLoading(false) })
    function restorePage() { startingRef.current = false; setStarting(false) }
    window.addEventListener('pageshow', restorePage)
    return () => { cancelled = true; window.removeEventListener('pageshow', restorePage) }
  }, [])

  function start() {
    if (disabled || startingRef.current || !options?.enabled || !options.available) return
    startingRef.current = true
    setStarting(true)
    onStarting?.()
    window.location.assign(`/api/auth/dingtalk/start?returnTo=${encodeURIComponent(dingTalkReturnTo())}`)
  }

  const unavailable = !options?.enabled || !options.available
  return <div className="dingtalk-login-entry">
    <button className="secondary-button dingtalk-login-button" type="button" disabled={disabled || loading || starting || unavailable} onClick={start} aria-describedby="dingtalk-login-hint">
      <ShieldCheck size={18} />{starting ? '正在前往钉钉…' : loading ? '正在检查钉钉登录…' : label}<ArrowRight size={17} />
    </button>
    <p id="dingtalk-login-hint">{loading ? '正在检查登录服务' : unavailable ? '钉钉登录暂未开放，请使用账号登录' : '使用公司钉钉身份，首次登录需关联已有账号'}</p>
  </div>
}

export function DingTalkBindingPage() {
  const [pending, setPending] = useState<DingTalkPendingIdentity | null>(null)
  const [loading, setLoading] = useState(true)
  const [attempt, setAttempt] = useState(0)
  const [expired, setExpired] = useState(false)
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [action, setAction] = useState<'bind' | 'cancel' | 'restart' | null>(null)
  const actionRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    void api.dingTalkPendingIdentity()
      .then((result) => {
        if (cancelled) return
        setPending(result.pending)
        setExpired(!result.pending || !Number.isFinite(Date.parse(result.pending.expiresAt)) || Date.parse(result.pending.expiresAt) <= Date.now())
      })
      .catch((loadError) => { if (!cancelled) setError(loadError instanceof Error ? loadError.message : '暂时无法读取钉钉身份，请重试') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [attempt])

  useEffect(() => {
    if (!pending || expired) return
    const timer = window.setTimeout(() => { setExpired(true); setPassword('') }, Math.max(0, Date.parse(pending.expiresAt) - Date.now()))
    return () => window.clearTimeout(timer)
  }, [pending, expired])

  useEffect(() => {
    function restorePage() { actionRef.current = false; setAction(null) }
    window.addEventListener('pageshow', restorePage)
    return () => window.removeEventListener('pageshow', restorePage)
  }, [])

  async function bind(event: FormEvent) {
    event.preventDefault()
    if (actionRef.current || !pending || expired) return
    if (!name.trim() || !password) return setError('请输入原 Bug 系统账号的真实姓名和密码')
    actionRef.current = true
    setAction('bind')
    setError('')
    try {
      const result = await api.completeDingTalkBinding({ name: name.trim(), password })
      setPassword('')
      returnToApp(result.returnTo)
    } catch (bindError) {
      if (bindError instanceof ApiError && bindError.status === 410) { setExpired(true); setPassword('') }
      setError(bindError instanceof Error ? bindError.message : '账号关联失败，请稍后重试')
      actionRef.current = false
      setAction(null)
    }
  }

  async function cancel() {
    if (actionRef.current) return
    actionRef.current = true
    setAction('cancel')
    setError('')
    try {
      const result = await api.cancelDingTalkBinding()
      setPassword('')
      returnToApp(result.returnTo)
    } catch (cancelError) {
      setError(cancelError instanceof Error ? cancelError.message : '暂时无法返回，请重试')
      actionRef.current = false
      setAction(null)
    }
  }

  return <AuthPageLayout>
    <form className="login-form dingtalk-binding-form" onSubmit={bind}>
      <div className="login-mobile-brand"><span className="brand-mark"><Bug size={20} /></span><span>TraceBug</span></div>
      <div className="login-kicker">DINGTALK ACCESS</div>
      <h1>关联已有账号</h1>
      <p>只需首次验证，之后即可使用钉钉登录。</p>
      {loading ? <div className="dingtalk-identity-card" role="status"><RefreshCw size={20} /><span>正在确认钉钉身份…</span></div>
        : expired ? <div className="dingtalk-identity-card expired" role="status"><AlertCircle size={20} /><div><strong>钉钉授权已过期</strong><span>请重新登录钉钉后再关联账号。</span></div></div>
          : pending ? <div className="dingtalk-identity-card"><ShieldCheck size={23} /><div><span>已验证公司钉钉身份</span><strong>{pending.name}</strong></div></div> : null}
      {!loading && pending && !expired && <>
        <p className="dingtalk-binding-help">输入你原有的 Bug 系统账号，保留项目权限和历史记录。系统不会仅凭同名或邮箱自动合并账号。</p>
        <label htmlFor="binding-name">原 Bug 系统真实姓名</label>
        <div className={`login-input ${error ? 'has-error' : ''}`}><UserRound size={18} /><input id="binding-name" value={name} onChange={(event) => { setName(event.target.value); setError('') }} autoFocus autoComplete="username" placeholder="请输入原账号的真实姓名" disabled={Boolean(action)} /></div>
        <label htmlFor="binding-password">原 Bug 系统密码</label>
        <div className={`login-input ${error ? 'has-error' : ''}`}><KeyRound size={18} /><input id="binding-password" type="password" value={password} onChange={(event) => { setPassword(event.target.value); setError('') }} autoComplete="current-password" placeholder="请输入原账号的密码" disabled={Boolean(action)} /></div>
      </>}
      <div className="field-message dingtalk-binding-error" role={error ? 'alert' : undefined}>{error || ' '}</div>
      {!loading && pending && !expired && <button className="primary-button login-button" type="submit" disabled={Boolean(action)}><Link2 size={18} />{action === 'bind' ? '正在关联…' : '确认关联并登录'}</button>}
      {!loading && expired && <DingTalkLoginButton label="重新钉钉登录" disabled={Boolean(action)} onStarting={() => { actionRef.current = true; setAction('restart') }} />}
      {!loading && !pending && !expired && <button className="secondary-button dingtalk-login-button" type="button" onClick={() => setAttempt((value) => value + 1)} disabled={Boolean(action)}><RefreshCw size={17} />重新读取身份</button>}
      <button className="dingtalk-binding-cancel" type="button" disabled={Boolean(action)} onClick={() => void cancel()}>{action === 'cancel' ? '正在返回…' : '暂不关联，返回系统'}</button>
    </form>
  </AuthPageLayout>
}
