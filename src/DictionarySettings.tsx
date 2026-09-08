import { useEffect, useId, useRef, useState } from 'react'
import { AlertCircle, ArrowDown, ArrowUp, Check, CircleHelp, Plus, Settings2, Trash2 } from 'lucide-react'
import type { DictionaryDraft, DictionaryKind, DictionaryVersions, IssueDictionaries } from './types'
import './dictionary-settings.css'

interface DictionarySettingsProps {
  dictionaries: IssueDictionaries
  versions: DictionaryVersions
  onSave: (kind: DictionaryKind, version: number, items: DictionaryDraft[]) => Promise<void>
  onDirtyChange?: (dirty: boolean) => void
}

const dictionaryKinds: DictionaryKind[] = ['priority', 'environment', 'status']
const dictionaryCopy: Record<DictionaryKind, { title: string; description: string }> = {
  priority: { title: '优先级', description: '设置缺陷的优先级名称与展示顺序，越靠前的优先级越高。' },
  environment: { title: '环境', description: '维护缺陷发生的环境，方便提交与筛选缺陷。' },
  status: { title: '状态', description: '维护缺陷的处理状态，并标记哪些状态代表处理已结束。' },
}
const MAX_ITEMS = 100
const MAX_LABEL_LENGTH = 40

function copyItems(dictionaries: IssueDictionaries, kind: DictionaryKind): DictionaryDraft[] {
  return dictionaries[kind].map(({ value, label, active, isDefault, isTerminal }) => ({ value, label, active, isDefault, isTerminal }))
}

function validateItems(items: DictionaryDraft[], kind: DictionaryKind, dictionaries: IssueDictionaries) {
  const labels = new Set<string>()
  for (let index = 0; index < items.length; index += 1) {
    const original = items[index].value ? dictionaries[kind].find((item) => item.value === items[index].value) : undefined
    const unchanged = original?.label === items[index].label
    const label = unchanged ? items[index].label : items[index].label.trim()
    if (!label.trim()) return `请填写第 ${index + 1} 项的名称。`
    if (!unchanged && label.length > MAX_LABEL_LENGTH) return `名称不能超过 ${MAX_LABEL_LENGTH} 个字符。`
    const normalized = label.trim().toLocaleLowerCase()
    if (labels.has(normalized)) return `名称“${label}”重复，请使用不同的名称。`
    labels.add(normalized)
  }
  if (!items.some((item) => item.active)) return '请至少保留一个启用的选项。'
  if (items.filter((item) => item.isDefault).length !== 1 || items.some((item) => item.isDefault && !item.active)) {
    return '请从启用的选项中选择一个默认值。'
  }
  if (kind === 'status' && items.some((item) => item.isDefault && item.isTerminal)) return '新建缺陷的默认状态不能是已结束状态。'
  return ''
}

export default function DictionarySettings({ dictionaries, versions, onSave, onDirtyChange }: DictionarySettingsProps) {
  const tabId = useId()
  const onDirtyChangeRef = useRef(onDirtyChange)
  onDirtyChangeRef.current = onDirtyChange
  const [kind, setKind] = useState<DictionaryKind>('priority')
  const [items, setItems] = useState<DictionaryDraft[]>(() => copyItems(dictionaries, 'priority'))
  const [baseline, setBaseline] = useState(() => JSON.stringify(copyItems(dictionaries, 'priority')))
  const [version, setVersion] = useState(versions.priority)
  const [pendingKind, setPendingKind] = useState<DictionaryKind | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const dirty = JSON.stringify(items) !== baseline
  const copy = dictionaryCopy[kind]
  const activeCount = items.filter((item) => item.active).length

  useEffect(() => {
    onDirtyChange?.(dirty || busy)
  }, [dirty, busy, onDirtyChange])

  useEffect(() => () => onDirtyChangeRef.current?.(false), [])

  useEffect(() => {
    if (dirty || busy) return
    const latest = copyItems(dictionaries, kind)
    setItems(latest)
    setBaseline(JSON.stringify(latest))
    setVersion(versions[kind])
  }, [dictionaries, versions, kind, dirty, busy])

  useEffect(() => {
    if (!dirty && !busy) return
    function warnBeforeLeaving(event: BeforeUnloadEvent) {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warnBeforeLeaving)
    return () => window.removeEventListener('beforeunload', warnBeforeLeaving)
  }, [dirty, busy])

  function restore(nextKind = kind) {
    const latest = copyItems(dictionaries, nextKind)
    setKind(nextKind)
    setItems(latest)
    setBaseline(JSON.stringify(latest))
    setVersion(versions[nextKind])
    setPendingKind(null)
    setError('')
    setNotice('')
  }

  function changeKind(nextKind: DictionaryKind) {
    if (nextKind === kind || busy) return
    if (dirty) {
      setPendingKind(nextKind)
      return
    }
    restore(nextKind)
  }

  function updateItem(index: number, patch: Partial<DictionaryDraft>) {
    setItems((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item))
    setError('')
    setNotice('')
  }

  function setDefault(index: number) {
    setItems((current) => current.map((item, itemIndex) => ({ ...item, isDefault: itemIndex === index })))
    setError('')
    setNotice('')
  }

  function moveItem(index: number, direction: -1 | 1) {
    const destination = index + direction
    if (destination < 0 || destination >= items.length) return
    setItems((current) => {
      const next = [...current]
      ;[next[index], next[destination]] = [next[destination], next[index]]
      return next
    })
    setError('')
    setNotice('')
  }

  async function save() {
    const validation = validateItems(items, kind, dictionaries)
    if (validation) {
      setError(validation)
      setNotice('')
      return
    }
    const submitted = items.map((item) => {
      const original = item.value ? dictionaries[kind].find((entry) => entry.value === item.value) : undefined
      return { ...item, label: original?.label === item.label ? item.label : item.label.trim() }
    })
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await onSave(kind, version, submitted)
      setItems(submitted)
      setBaseline(JSON.stringify(submitted))
      setPendingKind(null)
      setNotice(`${copy.title}设置已保存。`)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存失败，请稍后重试。')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="dictionary-settings" aria-labelledby={`${tabId}-heading`}>
      <header className="dictionary-settings-heading">
        <span className="dictionary-settings-mark" aria-hidden="true"><Settings2 size={22} /></span>
        <div>
          <h1 id={`${tabId}-heading`}>后台设置</h1>
          <p>全局缺陷字典 · 统一管理所有项目的可选值</p>
        </div>
      </header>

      <div className="dictionary-settings-card">
        <div className="dictionary-tabs" role="tablist" aria-label="缺陷字典">
          {dictionaryKinds.map((tabKind, index) => (
            <button
              key={tabKind}
              type="button"
              role="tab"
              id={`${tabId}-tab-${tabKind}`}
              aria-controls={`${tabId}-panel`}
              aria-selected={kind === tabKind}
              tabIndex={kind === tabKind ? 0 : -1}
              disabled={busy}
              onClick={() => changeKind(tabKind)}
              onKeyDown={(event) => {
                let nextIndex = index
                if (event.key === 'ArrowRight') nextIndex = (index + 1) % dictionaryKinds.length
                else if (event.key === 'ArrowLeft') nextIndex = (index + dictionaryKinds.length - 1) % dictionaryKinds.length
                else if (event.key === 'Home') nextIndex = 0
                else if (event.key === 'End') nextIndex = dictionaryKinds.length - 1
                else return
                event.preventDefault()
                changeKind(dictionaryKinds[nextIndex])
                if (!dirty) document.getElementById(`${tabId}-tab-${dictionaryKinds[nextIndex]}`)?.focus()
              }}
            >
              {dictionaryCopy[tabKind].title}
              <span>{dictionaries[tabKind].length}</span>
            </button>
          ))}
        </div>

        <div id={`${tabId}-panel`} role="tabpanel" aria-labelledby={`${tabId}-tab-${kind}`} aria-busy={busy}>
          <div className="dictionary-section-heading">
            <div>
              <h2>{copy.title}<span>{activeCount} 项已启用</span></h2>
              <p>{copy.description}</p>
            </div>
            <button type="button" className="secondary-button dictionary-add" disabled={busy || items.length >= MAX_ITEMS} onClick={() => {
              setItems((current) => [...current, { label: '', active: true, isDefault: current.length === 0, isTerminal: false }])
              setError('')
              setNotice('')
            }}><Plus size={15} />新增{copy.title}</button>
          </div>

          {pendingKind && (
            <div className="dictionary-switch-warning" role="alert">
              <div><AlertCircle size={17} /><span>当前{copy.title}有未保存的修改。切换到{dictionaryCopy[pendingKind].title}前，请先保存或放弃修改。</span></div>
              <div className="dictionary-warning-actions">
                <button type="button" className="secondary-button" onClick={() => setPendingKind(null)}>继续编辑</button>
                <button type="button" className="secondary-button" onClick={() => restore(pendingKind)}>放弃并切换</button>
              </div>
            </div>
          )}

          <div className="dictionary-table-wrap">
            <table className={`dictionary-table${kind === 'status' ? ' dictionary-table-status' : ''}`}>
              <thead><tr>
                <th scope="col" className="dictionary-order">排序</th>
                <th scope="col">名称</th>
                <th scope="col" className="dictionary-enabled">启用</th>
                <th scope="col" className="dictionary-default">默认值</th>
                {kind === 'status' && <th scope="col" className="dictionary-terminal">处理已结束</th>}
                <th scope="col" className="dictionary-actions">操作</th>
              </tr></thead>
              <tbody>{items.map((item, index) => (
                <tr key={item.value ?? `new-${index}`} className={item.active ? '' : 'dictionary-row-inactive'}>
                  <td className="dictionary-order" data-label="排序"><span className="dictionary-row-number">{String(index + 1).padStart(2, '0')}</span></td>
                  <td className="dictionary-name" data-label="名称">
                    <input
                      aria-label={`${copy.title}名称 ${index + 1}`}
                      title={item.label}
                      value={item.label}
                      maxLength={MAX_LABEL_LENGTH}
                      placeholder={`输入${copy.title}名称`}
                      disabled={busy}
                      onChange={(event) => updateItem(index, { label: event.target.value })}
                    />
                    {!item.value && <span className="dictionary-new-label">新增</span>}
                  </td>
                  <td className="dictionary-enabled" data-label="启用">
                    <label className="dictionary-checkbox" title={item.isDefault ? '默认值必须启用，请先选择其他默认值' : undefined}>
                      <input type="checkbox" aria-label={`启用${item.label || `第 ${index + 1} 项`}`} checked={item.active} disabled={busy || item.isDefault} onChange={(event) => updateItem(index, { active: event.target.checked })} />
                      <span>{item.active ? '已启用' : '已停用'}</span>
                    </label>
                  </td>
                  <td className="dictionary-default" data-label="默认值">
                    <label className="dictionary-radio" title={kind === 'status' && item.isTerminal ? '新建缺陷的默认状态不能是已结束状态' : undefined}>
                      <input type="radio" name={`${tabId}-default-${kind}`} aria-label={`将${item.label || `第 ${index + 1} 项`}设为默认值`} checked={item.isDefault} disabled={busy || !item.active || (kind === 'status' && item.isTerminal)} onChange={() => setDefault(index)} />
                      <span>{item.isDefault ? '默认' : '设为默认'}</span>
                    </label>
                  </td>
                  {kind === 'status' && <td className="dictionary-terminal" data-label="处理已结束">
                    <label className="dictionary-checkbox" title={item.isDefault ? '默认状态必须为未结束状态，请先选择其他默认值' : undefined}>
                      <input type="checkbox" aria-label={`${item.label || `第 ${index + 1} 项`}为已结束状态`} checked={item.isTerminal} disabled={busy || item.isDefault} onChange={(event) => updateItem(index, { isTerminal: event.target.checked })} />
                      <span>{item.isTerminal ? '已结束' : '未结束'}</span>
                    </label>
                  </td>}
                  <td className="dictionary-actions" data-label="操作"><div className="dictionary-row-actions">
                    <button type="button" aria-label={`上移${item.label || `第 ${index + 1} 项`}`} title="上移" disabled={busy || index === 0} onClick={() => moveItem(index, -1)}><ArrowUp size={15} /></button>
                    <button type="button" aria-label={`下移${item.label || `第 ${index + 1} 项`}`} title="下移" disabled={busy || index === items.length - 1} onClick={() => moveItem(index, 1)}><ArrowDown size={15} /></button>
                    {!item.value && <button type="button" className="dictionary-remove" aria-label={`移除新增${item.label || `第 ${index + 1} 项`}`} title={item.isDefault ? '请先选择其他默认值' : '移除此新增项'} disabled={busy || item.isDefault} onClick={() => {
                      setItems((current) => current.filter((_, itemIndex) => itemIndex !== index))
                      setError('')
                      setNotice('')
                    }}><Trash2 size={15} /></button>}
                  </div></td>
                </tr>
              ))}</tbody>
            </table>
          </div>

          <div className="dictionary-help">
            <CircleHelp size={16} aria-hidden="true" />
            <div>
              <p>停用后不再提供该选项供新建或修改时选择，已有缺陷仍保留原值。默认值用于新建缺陷，需保持启用。</p>
              {kind === 'status' && <p>标记为“处理已结束”的状态会计入概览的完成统计，并从个人中心待处理列表中移出。默认状态必须为未结束状态。</p>}
            </div>
          </div>

          {error && <div className="dictionary-feedback dictionary-error" role="alert"><AlertCircle size={17} /><div><p>{error}</p><small>当前修改尚未保存；点击“取消修改”可载入最新设置。</small></div></div>}
          {notice && <div className="dictionary-feedback dictionary-success" role="status"><Check size={17} /><p>{notice}</p></div>}

          <footer className="dictionary-save-bar">
            <span className={dirty ? 'dictionary-unsaved' : ''}>{busy ? '正在保存…' : dirty ? '有未保存的修改' : '修改后将应用于所有项目'}</span>
            <div>
              <button type="button" className="secondary-button" disabled={busy || (!dirty && !error)} onClick={() => restore()}>取消修改</button>
              <button type="button" className="primary-button" disabled={busy || !dirty} onClick={() => void save()}>{busy ? '保存中…' : '保存设置'}</button>
            </div>
          </footer>
        </div>
      </div>
    </section>
  )
}
