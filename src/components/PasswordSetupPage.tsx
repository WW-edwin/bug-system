import { type FormEvent, useRef, useState } from 'react'
import { Bug, Check, Eye, EyeOff, KeyRound, LogOut, ShieldCheck } from 'lucide-react'
import { api, ApiError } from '../api'
import type { Session } from '../types'
import { AuthPageLayout, dingTalkReturnTo } from './DingTalkAuth'
import './password-setup.css'

export default function PasswordSetupPage({ user }: { user: Session }) {
  const [returnTo] = useState(() => {
    const destination = new URL(dingTalkReturnTo(), window.location.origin)
    return destination.origin === window.location.origin && destination.pathname === '/'
      ? `${destination.pathname}${destination.search}${destination.hash}` : '/'
  })
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [visible, setVisible] = useState(false)
  const [action, setAction] = useState<'save' | 'logout' | null>(null)
  const [error, setError] = useState('')
  const [sessionExpired, setSessionExpired] = useState(false)
  const inFlightRef = useRef(false)

  async function save(event: FormEvent) {
    event.preventDefault()
    if (inFlightRef.current || sessionExpired) return
    if (password.length < 6 || password.length > 128) return setError('密码长度应为 6 至 128 个字符。')
    if (password !== confirmation) return setError('两次输入的密码不一致，请重新确认。')
    inFlightRef.current = true
    setAction('save')
    setError('')
    try {
      const result = await api.setupPassword({ password, confirmPassword: confirmation })
      if (result.user.passwordSetupRequired) throw new Error('密码设置尚未完成，请重试。')
      setPassword('')
      setConfirmation('')
      window.location.replace(returnTo)
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) {
        setSessionExpired(true)
        setPassword('')
        setConfirmation('')
        setError('登录已过期，请退出后重新使用钉钉登录。')
      } else setError(cause instanceof Error ? cause.message : '密码设置失败，请稍后重试。')
      inFlightRef.current = false
      setAction(null)
    }
  }

  async function logout() {
    if (inFlightRef.current) return
    inFlightRef.current = true
    setAction('logout')
    setError('')
    try {
      await api.logout()
      setPassword('')
      setConfirmation('')
      window.location.replace(returnTo)
    } catch {
      setError('退出登录未完成，请稍后重试。')
      inFlightRef.current = false
      setAction(null)
    }
  }

  return <AuthPageLayout><form className="login-form password-setup-form" onSubmit={save} noValidate>
    <div className="login-mobile-brand"><span className="brand-mark"><Bug size={20} /></span><span>TraceBug</span></div>
    <div className="login-kicker">COMPLETE YOUR ACCOUNT</div>
    <h1>设置登录密码</h1>
    <p>完成这一步，即可进入缺陷工作台。</p>
    <div className="dingtalk-identity-card password-setup-identity"><ShieldCheck size={23} /><div><span>你的 Bug 系统账号</span><strong>{user.name}</strong>{user.email && <span>{user.email}</span>}</div></div>
    <p className="password-setup-help">以后也可以使用真实姓名“{user.name}”和此密码登录。请先完成密码设置，再继续使用系统。</p>
    <label htmlFor="setup-password">登录密码</label>
    <div className={`login-input ${error ? 'has-error' : ''}`}><KeyRound size={18} /><input id="setup-password" type={visible ? 'text' : 'password'} value={password} disabled={Boolean(action) || sessionExpired} onChange={(event) => { setPassword(event.target.value); setError('') }} autoComplete="new-password" autoFocus placeholder="6 至 128 个字符" minLength={6} maxLength={128} /><button className="password-visibility-button" type="button" aria-label={visible ? '隐藏密码' : '显示密码'} aria-pressed={visible} disabled={Boolean(action)} onClick={() => setVisible((value) => !value)}>{visible ? <EyeOff size={18} /> : <Eye size={18} />}</button></div>
    <label htmlFor="setup-password-confirm">确认密码</label>
    <div className={`login-input ${error ? 'has-error' : ''}`}><KeyRound size={18} /><input id="setup-password-confirm" type={visible ? 'text' : 'password'} value={confirmation} disabled={Boolean(action) || sessionExpired} onChange={(event) => { setConfirmation(event.target.value); setError('') }} autoComplete="new-password" placeholder="再次输入登录密码" minLength={6} maxLength={128} /></div>
    <div className="field-message password-setup-error" role={error ? 'alert' : undefined}>{error || ' '}</div>
    <button className="primary-button login-button" type="submit" disabled={Boolean(action) || sessionExpired}><Check size={18} />{action === 'save' ? '正在保存…' : '保存密码并进入系统'}</button>
    <button className="password-setup-logout" type="button" disabled={Boolean(action)} onClick={() => void logout()}><LogOut size={16} />{action === 'logout' ? '正在退出…' : '退出登录'}</button>
  </form></AuthPageLayout>
}
