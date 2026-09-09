import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { AlertCircle, Bell, Check, CircleHelp, Plus, RefreshCw, Settings2, Trash2 } from 'lucide-react'
import { api, ApiError, type NotificationRule, type NotificationRuleSettingsResponse } from './api'
import DictionarySettings from './DictionarySettings'
import type { DictionaryDraft, DictionaryEntry, DictionaryKind, DictionaryVersions, IssueDictionaries } from './types'
import './notification-rule-settings.css'

const MAX_RULES = 50
const MAX_NAME_LENGTH = 80

interface SettingsViewProps {
  dictionaries: IssueDictionaries
  versions: DictionaryVersions
  onSave: (kind: DictionaryKind, version: number, items: DictionaryDraft[], deletedValues?: string[]) => Promise<void>
  onDirtyChange: (dirty: boolean) => void
}

export default function SettingsView(props: SettingsViewProps) {
  const id = useId()
  const [tab, setTab] = useState<'dictionary' | 'notifications'>(() => new URLSearchParams(window.location.search).get('settings') === 'notifications' ? 'notifications' : 'dictionary')
  const [busy, setBusy] = useState(false)
  const dirtyRef = useRef(false)
  const onDirtyRef = useRef(props.onDirtyChange)
  onDirtyRef.current = props.onDirtyChange
  const reportDirty = useCallback((dirty: boolean) => {
    dirtyRef.current = dirty
    onDirtyRef.current(dirty)
  }, [])

  function changeTab(next: typeof tab) {
    if (next === tab || busy) return
    if (dirtyRef.current && !window.confirm('后台设置有未保存的修改，确定放弃并切换吗？')) return
    reportDirty(false)
    setTab(next)
  }

  return <section className="system-settings-view">
    <div className="system-settings-tabs" role="tablist" aria-label="后台设置分类">
      {([{ value: 'dictionary', label: '缺陷字典', icon: Settings2 }, { value: 'notifications', label: '通知规则', icon: Bell }] as const).map(({ value, label, icon: Icon }) => <button
        key={value} id={`${id}-tab-${value}`} type="button" role="tab" aria-selected={tab === value}
        aria-controls={`${id}-panel`} tabIndex={tab === value ? 0 : -1} disabled={busy}
        onClick={() => changeTab(value)} onKeyDown={(event) => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
          event.preventDefault()
          const next = event.key === 'Home' ? 'dictionary' : event.key === 'End' ? 'notifications' : value === 'dictionary' ? 'notifications' : 'dictionary'
          changeTab(next)
          if (!dirtyRef.current) document.getElementById(`${id}-tab-${next}`)?.focus()
        }}><Icon size={17} />{label}</button>)}
    </div>
    <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-tab-${tab}`}>
      {tab === 'dictionary'
        ? <DictionarySettings dictionaries={props.dictionaries} versions={props.versions} onSave={props.onSave} onDirtyChange={reportDirty} />
        : <NotificationRuleSettings sharedStatuses={props.dictionaries.status} sharedStatusVersion={props.versions.status} onDirtyChange={reportDirty} onBusyChange={setBusy} />}
    </div>
  </section>
}

function copyRules(rules: NotificationRule[]) {
  return rules.map((rule) => ({ ...rule, recipients: [...rule.recipients] }))
}

function newRuleId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  // LAN deployments may use HTTP, where randomUUID is unavailable. The browser
  // still provides secure random bytes without changing the application's URL.
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const value = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`
}

function NotificationRuleSettings({ sharedStatuses, sharedStatusVersion, onDirtyChange, onBusyChange }: {
  sharedStatuses: DictionaryEntry[]
  sharedStatusVersion: number
  onDirtyChange: (dirty: boolean) => void
  onBusyChange: (busy: boolean) => void
}) {
  const [snapshot, setSnapshot] = useState<NotificationRuleSettingsResponse | null>(null)
  const [rules, setRules] = useState<NotificationRule[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [reloadVersion, setReloadVersion] = useState(0)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [conflict, setConflict] = useState(false)
  const savingRef = useRef(false)
  const mountedRef = useRef(true)
  const [latestStatusSource, setLatestStatusSource] = useState({ statuses: sharedStatuses, version: sharedStatusVersion })
  const dirty = snapshot !== null && JSON.stringify(rules) !== JSON.stringify(snapshot.rules)
  const busy = loading || saving
  const statusSource = snapshot && snapshot.statusVersion > sharedStatusVersion
    ? { statuses: snapshot.statuses, version: snapshot.statusVersion }
    : { statuses: sharedStatuses, version: sharedStatusVersion }
  // Dictionary refreshes can advance while a rule response is in flight. Keep
  // the newest version independently of the editable rules and rule version.
  if (statusSource.version > latestStatusSource.version) setLatestStatusSource(statusSource)
  const statuses = statusSource.version >= latestStatusSource.version ? statusSource.statuses : latestStatusSource.statuses
  const defaultStatus = statuses.find((item) => item.active && item.isDefault)
  const activeCount = rules.filter((rule) => rule.enabled).length

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false; onDirtyChange(false); onBusyChange(false) }
  }, [onDirtyChange, onBusyChange])

  useEffect(() => { onDirtyChange(dirty || saving); onBusyChange(busy) }, [dirty, saving, busy, onDirtyChange, onBusyChange])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    void api.notificationRules().then((result) => {
      if (cancelled) return
      setSnapshot(result)
      setRules(copyRules(result.rules))
      setConflict(false)
      setNotice('')
    }).catch((cause) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : '通知规则加载失败，请重试。')
    }).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [reloadVersion])

  useEffect(() => {
    if (!dirty && !saving) return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty, saving])

  function updateRule(id: string, patch: Partial<NotificationRule>) {
    setRules((current) => current.map((rule) => rule.id === id ? { ...rule, ...patch } : rule))
    if (!conflict) setError('')
    setNotice('')
  }

  function reload() {
    if (busy || (dirty && !window.confirm('重新加载将放弃当前未保存的通知规则，确定继续吗？'))) return
    setReloadVersion((value) => value + 1)
  }

  async function save() {
    if (!snapshot || busy || savingRef.current || conflict) return
    for (let index = 0; index < rules.length; index += 1) {
      const rule = rules[index]
      if (!rule.name.trim()) return setError(`请填写第 ${index + 1} 条规则的名称。`)
      if (!rule.recipients.length) return setError(`“${rule.name.trim()}”至少需要选择一类接收者。`)
      if (rule.trigger === 'status_changed' && !rule.targetStatus) return setError(`请为“${rule.name.trim()}”选择目标状态。`)
      if (rule.trigger === 'status_changed' && !statuses.some((item) => item.value === rule.targetStatus)) return setError(`“${rule.name.trim()}”的目标状态已不可用，请重新选择或删除这条规则。`)
      if (rule.trigger === 'status_changed' && rule.enabled && !statuses.some((item) => item.value === rule.targetStatus && item.active)) {
        return setError(`“${rule.name.trim()}”的目标状态已停用，请选择启用的状态或停用这条规则。`)
      }
    }
    savingRef.current = true
    setSaving(true)
    setError('')
    setNotice('')
    try {
      const result = await api.saveNotificationRules(snapshot.version, rules.map((rule) => ({ ...rule, name: rule.name.trim(), targetStatus: rule.trigger === 'created' ? null : rule.targetStatus })))
      if (!mountedRef.current) return
      setSnapshot(result)
      setRules(copyRules(result.rules))
      setNotice('通知规则已保存，将用于之后发生的事件。')
    } catch (cause) {
      if (!mountedRef.current) return
      if (cause instanceof ApiError && cause.status === 409) {
        setConflict(true)
        setError('配置已被其他管理员修改，请重新加载后再编辑。当前修改尚未保存。')
      } else setError(cause instanceof Error ? cause.message : '保存失败，请稍后重试。')
    } finally {
      savingRef.current = false
      if (mountedRef.current) setSaving(false)
    }
  }

  return <section className="notification-rule-settings" aria-labelledby="notification-rule-heading" aria-busy={busy}>
    <header className="dictionary-settings-heading">
      <span className="dictionary-settings-mark" aria-hidden="true"><Bell size={22} /></span>
      <div><h1 id="notification-rule-heading">通知规则</h1><p>设置何时向谁发送钉钉通知 · 对所有项目生效</p></div>
    </header>
    {loading && !snapshot ? <div className="notification-load-state" role="status"><RefreshCw size={18} />正在加载通知规则…</div> : <>
      {error && <div className="notification-settings-message error" role="alert"><AlertCircle size={18} /><span>{error}</span>{(conflict || !snapshot) && <button className="secondary-button compact" type="button" disabled={busy} onClick={reload}>重新加载</button>}</div>}
      {notice && <div className="notification-settings-message success" role="status"><Check size={18} /><span>{notice}</span></div>}
      {snapshot && <>
        <div className={`notification-delivery-state ${snapshot.deliveryMode}`} role="status"><span className="notification-delivery-dot" />{snapshot.deliveryMode === 'live' ? '钉钉通知已启用' : snapshot.deliveryMode === 'dry_run' ? '当前为演练模式，不会发送真实消息' : '钉钉消息发送暂未启用，规则仍可预先配置'}</div>
        <div className="notification-rules-card">
          <div className="notification-section-heading"><div><h2>触发规则 <span>{activeCount} 条已启用 / 共 {rules.length} 条</span></h2><p>按实际业务事件通知对应人员。</p></div><button className="secondary-button" type="button" disabled={busy || rules.length >= MAX_RULES} onClick={() => {
            setRules((current) => [...current, { id: newRuleId(), name: '', enabled: true, trigger: 'created', targetStatus: null, recipients: ['assignee'] }])
            if (!conflict) setError('')
            setNotice('')
          }}><Plus size={16} />新增规则</button></div>
          {!rules.length && <div className="notification-rules-empty"><Bell size={27} /><strong>尚未配置通知规则</strong><p>保存空列表后，所有事件通知都将关闭。</p></div>}
          <div className="notification-rule-list">{rules.map((rule, index) => {
            const selectedStatus = statuses.find((item) => item.value === rule.targetStatus)
            const options = statuses
            return <article className={`notification-rule ${rule.enabled ? '' : 'inactive'}`} key={rule.id} aria-label={`通知规则 ${index + 1}`}>
              <div className="notification-rule-topline"><span className="notification-rule-number">{String(index + 1).padStart(2, '0')}</span><label className="notification-rule-name"><span>规则名称</span><input aria-label={`规则名称 ${index + 1}`} value={rule.name} maxLength={MAX_NAME_LENGTH} placeholder="例如：待复测时通知创建人" disabled={busy} onChange={(event) => updateRule(rule.id, { name: event.target.value })} /></label><label className="notification-rule-toggle"><input type="checkbox" aria-label={`启用规则 ${index + 1}`} checked={rule.enabled} disabled={busy} onChange={(event) => updateRule(rule.id, { enabled: event.target.checked })} /><span>{rule.enabled ? '已启用' : '已停用'}</span></label><button className="notification-rule-remove" type="button" aria-label={`删除规则 ${index + 1}`} disabled={busy} onClick={() => { setRules((current) => current.filter((item) => item.id !== rule.id)); setNotice(''); if (!conflict) setError('') }}><Trash2 size={17} /></button></div>
              <div className="notification-rule-fields">
                <label className="notification-rule-field"><span>触发事件</span><select aria-label={`触发事件 ${index + 1}`} value={rule.trigger} disabled={busy} onChange={(event) => updateRule(rule.id, { trigger: event.target.value as NotificationRule['trigger'], targetStatus: null })}><option value="created">新建缺陷</option><option value="status_changed">状态流转</option></select></label>
                <div className="notification-rule-field"><label htmlFor={`rule-status-${rule.id}`}>{rule.trigger === 'created' ? '新建默认状态' : '流转到'}</label>{rule.trigger === 'created'
                  ? <div className="notification-default-status" id={`rule-status-${rule.id}`}>{defaultStatus?.label ?? '未设置默认状态'}<span>跟随字典默认值</span></div>
                  : <select id={`rule-status-${rule.id}`} aria-label={`目标状态 ${index + 1}`} value={rule.targetStatus ?? ''} disabled={busy} onChange={(event) => updateRule(rule.id, { targetStatus: event.target.value || null })}><option value="">请选择目标状态</option>{rule.targetStatus && !selectedStatus && <option value={rule.targetStatus} disabled>原目标状态已不可用</option>}{options.map((item) => <option key={item.value} value={item.value} disabled={!item.active}>{item.label}{item.active ? '' : '（已停用）'}</option>)}</select>}</div>
                <fieldset className="notification-rule-recipients" disabled={busy}><legend>接收者</legend>{([{ value: 'assignee', label: '负责人' }, { value: 'reporter', label: '创建人' }] as const).map(({ value, label }) => <label key={value}><input type="checkbox" aria-label={`${label}接收通知 ${index + 1}`} checked={rule.recipients.includes(value)} onChange={(event) => updateRule(rule.id, { recipients: event.target.checked ? [...rule.recipients, value] : rule.recipients.filter((recipient) => recipient !== value) })} /><span>{label}</span></label>)}</fieldset>
              </div>
            </article>
          })}</div>
          <div className="notification-rule-help"><CircleHelp size={17} /><div><p>状态流转仅在状态实际变化时触发；重复保存相同状态不会通知。</p><p>负责人为多人时全部通知。负责人和创建人重合，或多条规则命中同一事件、同一人时，只发送一次。</p><p>保存后对新发生的事件生效，不补发历史通知。清空规则或停用全部规则可关闭事件通知。</p></div></div>
          <footer className="notification-rule-footer"><span>{dirty ? '有未保存的修改' : `已保存 · ${activeCount} 条规则启用`}</span><div><button className="secondary-button" type="button" disabled={busy || !dirty} onClick={() => { setRules(copyRules(snapshot.rules)); setNotice(''); if (!conflict) setError('') }}>取消修改</button><button className="primary-button" type="button" disabled={busy || !dirty || conflict} onClick={() => void save()}><Check size={16} />{saving ? '正在保存…' : '保存通知规则'}</button></div></footer>
        </div>
      </>}
    </>}
  </section>
}
