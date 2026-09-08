import { FormEvent, useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Activity,
  AlertCircle,
  ArrowRight,
  BarChart3,
  Boxes,
  Bug,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleDot,
  Columns3,
  FolderKanban,
  History,
  KeyRound,
  LayoutList,
  ListChecks,
  LogOut,
  Mail,
  Menu,
  MessageSquare,
  MonitorCog,
  Plus,
  RefreshCw,
  Search,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  UserRound,
  Users,
  X,
} from 'lucide-react'
import { api, ApiError, type CreateIssueInput, type EmployeeAccount, type UserOption } from './api'
import { defaultDictionaries, DictionaryContext, mergeWorkspaceData, useDictionaries } from './dictionaries'
import DictionarySettings from './DictionarySettings'
import EvidenceUploadBox from './EvidenceUploadBox'
import { ImagePreviewDialog } from './ImageTools'
import RichTextEditor from './RichTextEditor'
import { composeIssueDescription, hasRichEvidenceContent, splitIssueDescription, type EvidenceItem } from './issueDescription'
import type { Activity as IssueActivity, Issue, IssueStatus, Priority, Project, Session, WorkspaceData } from './types'
import type { DictionaryDraft, DictionaryKind } from './types'

type Section = 'personal' | 'overview' | 'issues' | 'activity' | 'members' | 'settings'
type IssueView = 'list' | 'board'
type IssuePageSize = 20 | 50 | 100
const REFRESH_INTERVAL_MS = 10 * 60 * 1000
const ISSUE_TITLE_MAX_LENGTH = 40
const ACTIVITY_PAGE_SIZE = 100
const PROJECTS_PER_PAGE = 6
const ISSUE_PAGE_SIZES: IssuePageSize[] = [20, 50, 100]
const APP_TIME_ZONE = 'Asia/Shanghai'
const LAST_PROJECT_KEY_PREFIX = 'tracebug:last-project:'

function issueAssigneeIds(issue: Issue) {
  const legacyIssue = issue as Issue & { assigneeId?: string }
  return issue.assigneeIds?.length ? issue.assigneeIds : legacyIssue.assigneeId ? [legacyIssue.assigneeId] : []
}

function issueAssigneeNames(issue: Issue) {
  const legacyIssue = issue as Issue & { assignee?: string }
  return issue.assignees?.length ? issue.assignees : legacyIssue.assignee ? [legacyIssue.assignee] : []
}

function canModifyIssue(issue: Issue, currentUser: Session) {
  return issue.reporter === currentUser.name || issueAssigneeIds(issue).includes(currentUser.id)
}

function lastProjectStorageKey(userId: string) {
  return `${LAST_PROJECT_KEY_PREFIX}${userId}`
}

function rememberProject(userId: string, projectId: string) {
  try {
    if (projectId) localStorage.setItem(lastProjectStorageKey(userId), projectId)
    else localStorage.removeItem(lastProjectStorageKey(userId))
  } catch { /* Browsing mode may block local storage. */ }
}

function restoreProject(userId: string, projects: Project[]) {
  let storedProjectId = ''
  try { storedProjectId = localStorage.getItem(lastProjectStorageKey(userId)) ?? '' } catch { /* Use the first available project. */ }
  const projectId = projects.some((project) => project.id === storedProjectId) ? storedProjectId : (projects[0]?.id ?? '')
  rememberProject(userId, projectId)
  return projectId
}

const statusStyles: Record<IssueStatus, { color: string; background: string; border: string }> = {
  待处理: { color: '#861e1a', background: '#ffd9d6', border: '#f04438' },
  处理中: { color: '#861f50', background: '#ffd4e5', border: '#e83e8c' },
  待复测: { color: '#6f4c00', background: '#ffe8a3', border: '#d99a00' },
  已修复: { color: '#145c34', background: '#d2f4dc', border: '#2fb66d' },
  不适用: { color: '#343a42', background: '#e5e7eb', border: '#7b8491' },
  不解决: { color: '#174a9c', background: '#dce8ff', border: '#3b82f6' },
}

function statusStyle(status: IssueStatus) {
  const style = statusStyles[status] ?? { color: '#345575', background: '#e5edf6', border: '#7395b7' }
  return {
    '--status-color': style.color,
    '--status-bg': style.background,
    '--status-border': style.border,
  } as React.CSSProperties
}

async function uploadEvidence(file: File, onProgress?: (progress: number) => void) {
  return api.uploadEvidence(file, onProgress)
}

function formatDate(value: string, includeYear = false) {
  if (!value) return '未设置'
  const date = new Date(value)
  return new Intl.DateTimeFormat('zh-CN', {
    ...(includeYear ? { year: 'numeric' as const } : {}),
    month: '2-digit',
    day: '2-digit',
    hour: value.length > 10 ? '2-digit' : undefined,
    minute: value.length > 10 ? '2-digit' : undefined,
    hour12: false,
  }).format(date)
}

function activityDateKey(value: string | Date) {
  const date = value instanceof Date ? value : new Date(value)
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: APP_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)
  const year = parts.find((part) => part.type === 'year')?.value ?? ''
  const month = parts.find((part) => part.type === 'month')?.value ?? ''
  const day = parts.find((part) => part.type === 'day')?.value ?? ''
  return `${year}-${month}-${day}`
}

function relativeDate(value: string) {
  const diff = Date.now() - new Date(value).getTime()
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days} 天前`
  return formatDate(value)
}

function Login({ onAuthenticate }: { onAuthenticate: (mode: 'login' | 'register', input: { email?: string; name: string; password: string }) => Promise<void> }) {
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [showForgotPassword, setShowForgotPassword] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (mode === 'register' && !email.trim().toLowerCase().endsWith('@kando.com.cn')) return setError('请输入 @kando.com.cn 公司邮箱')
    if (!name.trim()) return setError('请输入真实姓名')
    if (mode === 'register' && !/^\p{Script=Han}+$/u.test(name.trim())) return setError('真实姓名只能包含中文')
    if (password.length < 6) return setError('密码至少 6 个字符')
    if (mode === 'register' && password !== confirmPassword) return setError('两次输入的密码不一致')
    setSubmitting(true)
    setError('')
    try {
      await onAuthenticate(mode, { email: email.trim().toLowerCase(), name: name.trim(), password })
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : '认证失败')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <>
      <main className="login-shell">
      <section className="login-visual" aria-label="TraceBug 品牌展示">
        <img src="/qa-workspace.jpg" alt="摆放着编程设备的软件研发工作台" />
        <div className="login-visual-shade" />
        <div className="login-brand">
          <span className="brand-mark brand-mark-light"><Bug size={22} strokeWidth={2.2} /></span>
          <span>TraceBug</span>
        </div>
        <div className="login-visual-meta">
          <span>QUALITY OPERATIONS</span>
          <strong>问题可见，责任清晰。</strong>
          <small>内部系统 · 2026</small>
        </div>
      </section>

      <section className="login-panel">
        <form className="login-form" onSubmit={submit}>
          <div className="login-mobile-brand">
            <span className="brand-mark"><Bug size={20} /></span>
            <span>TraceBug</span>
          </div>
          <div className="login-kicker">INTERNAL ACCESS</div>
          <h1>{mode === 'login' ? '进入缺陷工作台' : '注册员工账号'}</h1>
          <p>{mode === 'login' ? '使用真实姓名和密码登录。' : '仅限 KANDO 公司邮箱注册。'}</p>
          <div className="login-auth-tabs" role="tablist" aria-label="身份操作">
            <button type="button" role="tab" aria-selected={mode === 'login'} className={mode === 'login' ? 'active' : ''} onClick={() => { setMode('login'); setError('') }}>登录</button>
            <button type="button" role="tab" aria-selected={mode === 'register'} className={mode === 'register' ? 'active' : ''} onClick={() => { setMode('register'); setError('') }}>注册</button>
          </div>
          {mode === 'register' && <><label htmlFor="register-email">公司邮箱</label><div className={`login-input ${error ? 'has-error' : ''}`}><Mail size={18} /><input id="register-email" type="email" value={email} onChange={(event) => { setEmail(event.target.value); setError('') }} autoFocus autoComplete="email" placeholder="name@kando.com.cn" /></div></>}
          <label htmlFor="login-name">真实姓名</label>
          <div className={`login-input ${error ? 'has-error' : ''}`}><UserRound size={18} /><input id="login-name" value={name} onChange={(event) => { setName(event.target.value); setError('') }} autoFocus={mode === 'login'} autoComplete="name" placeholder="请输入真实姓名" /></div>
          <label htmlFor="login-password">密码</label>
          <div className={`login-input ${error ? 'has-error' : ''}`}><KeyRound size={18} /><input id="login-password" type="password" value={password} onChange={(event) => { setPassword(event.target.value); setError('') }} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} placeholder="至少 6 个字符" /></div>
          {mode === 'login' && <div className="forgot-password-row"><button type="button" onClick={() => setShowForgotPassword(true)}>忘记密码</button></div>}
          {mode === 'register' && <><label htmlFor="confirm-password">确认密码</label><div className={`login-input ${error ? 'has-error' : ''}`}><KeyRound size={18} /><input id="confirm-password" type="password" value={confirmPassword} onChange={(event) => { setConfirmPassword(event.target.value); setError('') }} autoComplete="new-password" placeholder="请再次输入密码" /></div></>}
          <div className="field-message" aria-live="polite">{error || ' '}</div>
          <button className="primary-button login-button" type="submit" disabled={submitting}>
            {mode === 'login' ? '登录系统' : '注册并进入'} <ArrowRight size={17} />
          </button>
          <div className="login-footnote">
            <span className="status-dot" />
            服务端共享数据
          </div>
        </form>
      </section>
      </main>
      {showForgotPassword && <ForgotPasswordModal onClose={() => setShowForgotPassword(false)} />}
    </>
  )
}

function Avatar({ name, size = 'normal' }: { name: string; size?: 'small' | 'normal' | 'large' }) {
  const displayName = name.trim() || '未命名'
  return <span className={`avatar avatar-${size}`} aria-label={displayName}>{displayName}</span>
}

function IssueTitleField({ value, onChange, ariaLabel, placeholder, autoFocus = false, variant = 'form' }: { value: string; onChange: (value: string) => void; ariaLabel: string; placeholder?: string; autoFocus?: boolean; variant?: 'form' | 'drawer' }) {
  function updateTitle(event: React.ChangeEvent<HTMLTextAreaElement>) {
    onChange(event.currentTarget.value.replace(/[\r\n]+/g, ' ').slice(0, ISSUE_TITLE_MAX_LENGTH))
  }

  return (
    <div className={`issue-title-field issue-title-field-${variant}`}>
      <textarea
        className={variant === 'drawer' ? 'issue-title-input' : 'issue-title-form-input'}
        aria-label={ariaLabel}
        autoFocus={autoFocus}
        rows={2}
        maxLength={ISSUE_TITLE_MAX_LENGTH}
        placeholder={placeholder}
        value={value}
        onChange={updateTitle}
      />
    </div>
  )
}

function StatusPill({ status }: { status: IssueStatus }) {
  const { label } = useDictionaries()
  return (
    <span className="status-pill" data-status={status} style={statusStyle(status)} title={label('status', status)}>
      <span />{label('status', status)}
    </span>
  )
}

function StatusSelect({ value, onChange, ariaLabel, variant = 'compact', disabled = false }: { value: IssueStatus; onChange: (status: IssueStatus) => void; ariaLabel: string; variant?: 'compact' | 'property'; disabled?: boolean }) {
  const { activeValues, label } = useDictionaries()
  const statusOrder = activeValues('status')
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState({ top: 0, left: 0, width: 184 })
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const menuId = useId()

  function openMenu() {
    if (disabled) return
    if (open) {
      setOpen(false)
      return
    }
    const rect = triggerRef.current?.getBoundingClientRect()
    if (rect) {
      const width = Math.max(184, rect.width)
      const menuHeight = Math.min(306, window.innerHeight - 16)
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))
      const preferredTop = rect.bottom + 6 + menuHeight <= window.innerHeight ? rect.bottom + 6 : rect.top - menuHeight - 6
      const top = Math.max(8, Math.min(preferredTop, window.innerHeight - menuHeight - 8))
      setPosition({ top, left, width })
    }
    setOpen(true)
  }

  useEffect(() => {
    if (!open) return
    function close(event: PointerEvent) {
      const target = event.target as Node
      if (!triggerRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false)
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setOpen(false)
        triggerRef.current?.focus()
      }
    }
    function closeOnViewportChange() {
      setOpen(false)
    }
    function closeOnPageScroll(event: Event) {
      if (event.target instanceof Node && menuRef.current?.contains(event.target)) return
      setOpen(false)
    }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', closeOnEscape)
    window.addEventListener('resize', closeOnViewportChange)
    const scrollTimer = window.setTimeout(() => window.addEventListener('scroll', closeOnPageScroll, true), 160)
    const timer = window.setTimeout(() => menuRef.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus(), 0)
    return () => {
      window.clearTimeout(timer)
      window.clearTimeout(scrollTimer)
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', closeOnEscape)
      window.removeEventListener('resize', closeOnViewportChange)
      window.removeEventListener('scroll', closeOnPageScroll, true)
    }
  }, [open])

  useEffect(() => {
    if (disabled) setOpen(false)
  }, [disabled])

  return (
    <>
      <div className={`status-select status-select-${variant}`} style={statusStyle(value)}>
        <button ref={triggerRef} className="status-select-trigger" type="button" aria-label={ariaLabel} aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? menuId : undefined} disabled={disabled} title={disabled ? '只有负责人或创建人可以修改' : undefined} onClick={openMenu} onKeyDown={(event) => {
          if (!open && (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ')) {
            event.preventDefault()
            openMenu()
          }
        }}>
          <span className="status-signal" />
          <strong>{label('status', value)}</strong>
          <ChevronDown size={15} />
        </button>
      </div>
      {open && createPortal(
        <div ref={menuRef} id={menuId} className="status-select-menu" role="listbox" aria-label={ariaLabel} style={{ top: position.top, left: position.left, width: position.width }} onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            setOpen(false)
            triggerRef.current?.focus()
          }
        }}>
          <div className="status-select-menu-label">缺陷状态</div>
          {statusOrder.map((status) => (
            <button type="button" role="option" aria-selected={status === value} key={status} style={statusStyle(status)} onClick={() => {
              setOpen(false)
              if (status !== value) onChange(status)
            }}>
              <span className="status-menu-signal" />
              <span>{label('status', status)}</span>
              {status === value && <Check size={15} />}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  )
}

function PriorityPill({ priority }: { priority: Priority }) {
  const { label } = useDictionaries()
  return <span className={`priority-pill priority-${priority.toLowerCase()}`} title={label('priority', priority)}>{label('priority', priority)}</span>
}

function ActivityDetail({ activity }: { activity: Pick<IssueActivity, 'detail' | 'kind'> }) {
  const [previewSrc, setPreviewSrc] = useState<string | null>(null)
  if (activity.kind !== 'commented') return <p>{activity.detail}</p>
  return (
    <>
      <div
        className="rich-activity-detail"
        onClick={(event) => {
          const target = event.target
          if (target instanceof HTMLImageElement) {
            event.preventDefault()
            setPreviewSrc(target.src)
          }
        }}
        dangerouslySetInnerHTML={{ __html: activity.detail }}
      />
      {previewSrc && <ImagePreviewDialog src={previewSrc} onClose={() => setPreviewSrc(null)} />}
    </>
  )
}

function ProjectSwitcher({
  projects,
  currentId,
  canDelete,
  onChange,
  onDelete,
  onNew,
}: {
  projects: Project[]
  currentId: string
  canDelete: boolean
  onChange: (id: string) => void
  onDelete: (project: Project) => void
  onNew: () => void
}) {
  const [open, setOpen] = useState(false)
  const [page, setPage] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const current = projects.find((project) => project.id === currentId) ?? projects[0]
  const pageCount = Math.max(1, Math.ceil(projects.length / PROJECTS_PER_PAGE))
  const visibleProjects = projects.slice(page * PROJECTS_PER_PAGE, (page + 1) * PROJECTS_PER_PAGE)

  useEffect(() => {
    setPage((currentPage) => Math.min(currentPage, pageCount - 1))
  }, [pageCount])

  useEffect(() => {
    if (!open) return
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', closeOnOutsidePointer)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [open])

  if (!current) return null

  function toggleMenu() {
    if (!open) {
      const currentIndex = projects.findIndex((project) => project.id === current.id)
      setPage(Math.max(0, Math.floor(currentIndex / PROJECTS_PER_PAGE)))
    }
    setOpen((value) => !value)
  }

  return (
    <div className="project-switcher" ref={rootRef}>
      <button className="project-current" onClick={toggleMenu} aria-expanded={open} aria-haspopup="menu">
        <span className="project-glyph" style={{ background: current.color }}>{current.key.slice(0, 1)}</span>
        <span className="project-current-copy"><small>当前项目</small><strong>{current.name}</strong></span>
        <ChevronDown size={16} />
      </button>
      {open && (
        <div className="project-menu" role="menu" aria-label="项目列表">
          <div className="project-menu-label">切换项目</div>
          {visibleProjects.map((project) => (
            <div className={`project-menu-row ${project.id === currentId ? 'active' : ''}`} key={project.id}>
              <button className="project-menu-select" onClick={() => { onChange(project.id); setOpen(false) }}>
                <span className="project-glyph small" style={{ background: project.color }}>{project.key.slice(0, 1)}</span>
                <span><strong>{project.name}</strong><small>{project.key} · {project.issues.length} 条</small></span>
                {project.id === currentId && <Check size={15} />}
              </button>
              {canDelete && <button className="project-menu-delete" onClick={() => { onDelete(project); setOpen(false) }} title={`删除项目 ${project.name}`}><Trash2 size={15} /></button>}
            </div>
          ))}
          <div className="project-menu-pagination" aria-label="项目分页">
            <button type="button" onClick={() => setPage((currentPage) => Math.max(0, currentPage - 1))} disabled={page === 0} aria-label="上一页" title="上一页"><ChevronLeft size={15} /></button>
            <span><strong>{page + 1}</strong> / {pageCount}</span>
            <button type="button" onClick={() => setPage((currentPage) => Math.min(pageCount - 1, currentPage + 1))} disabled={page === pageCount - 1} aria-label="下一页" title="下一页"><ChevronRight size={15} /></button>
          </div>
          <button className="project-menu-new" onClick={() => { onNew(); setOpen(false) }}>
            <Plus size={15} /> 新建项目
          </button>
        </div>
      )}
    </div>
  )
}

function Sidebar({
  session,
  projects,
  currentProjectId,
  section,
  mobileOpen,
  onProjectChange,
  onDeleteProject,
  onSectionChange,
  onNewProject,
  onOpenSettings,
  onLogout,
  onCloseMobile,
}: {
  session: Session
  projects: Project[]
  currentProjectId: string
  section: Section
  mobileOpen: boolean
  onProjectChange: (id: string) => void
  onDeleteProject: (project: Project) => void
  onSectionChange: (section: Section) => void
  onNewProject: () => void
  onOpenSettings: () => void
  onLogout: () => void
  onCloseMobile: () => void
}) {
  const { isTerminal } = useDictionaries()
  const assignedCount = projects.reduce((count, project) => count + project.issues.filter((issue) => issueAssigneeIds(issue).includes(session.id) && !isTerminal(issue.status)).length, 0)
  const items = [
    { id: 'overview' as const, label: '项目概览', icon: BarChart3 },
    { id: 'issues' as const, label: '缺陷中心', icon: CircleDot },
    { id: 'activity' as const, label: '变更动态', icon: Activity },
    ...(session.role === 'admin' ? [{ id: 'members' as const, label: '成员管理', icon: Users }] : []),
    ...(session.role === 'admin' ? [{ id: 'settings' as const, label: '后台设置', icon: SlidersHorizontal }] : []),
  ]
  return (
    <>
      {mobileOpen && <button className="sidebar-backdrop" aria-label="关闭导航" onClick={onCloseMobile} />}
      <aside className={`sidebar ${mobileOpen ? 'mobile-open' : ''}`}>
        <div className="sidebar-brand">
          <span className="brand-mark"><Bug size={20} strokeWidth={2.4} /></span>
          <span>TraceBug</span>
          <button className="icon-button sidebar-close" onClick={onCloseMobile} title="关闭导航"><X size={18} /></button>
        </div>
        <button className={`personal-center-button ${section === 'personal' ? 'active' : ''}`} onClick={() => { onSectionChange('personal'); onCloseMobile() }}>
          <span className="personal-center-icon"><UserRound size={18} /></span>
          <span><strong>个人中心</strong><small>负责 {assignedCount} 条缺陷</small></span>
          <ChevronRight size={16} />
        </button>
        <ProjectSwitcher projects={projects} currentId={currentProjectId} canDelete={session.role === 'admin'} onChange={onProjectChange} onDelete={onDeleteProject} onNew={onNewProject} />
        <nav className="main-nav" aria-label="主要导航">
          <div className="nav-label">工作区</div>
          {items.map((item) => {
            const Icon = item.icon
            return (
              <button key={item.id} className={section === item.id ? 'active' : ''} onClick={() => { onSectionChange(item.id); onCloseMobile() }}>
                <Icon size={17} />
                <span>{item.label}</span>
              </button>
            )
          })}
        </nav>
        <div className="sidebar-spacer" />
        <div className="sidebar-user">
          <Avatar name={session.name} />
          <button className="icon-button sidebar-settings-button" onClick={() => { onOpenSettings(); onCloseMobile() }} title="个人设置" aria-label="个人设置"><Settings size={16} /></button>
          {session.role === 'admin' && <small className="sidebar-role">管理员</small>}
          <button className="icon-button" onClick={onLogout} title="退出登录"><LogOut size={17} /></button>
        </div>
      </aside>
    </>
  )
}

function Header({
  project,
  section,
  refreshing,
  onMenu,
  onRefresh,
  onNewIssue,
}: {
  project: Project | undefined
  section: Section
  refreshing: boolean
  onMenu: () => void
  onRefresh: () => void
  onNewIssue: () => void
}) {
  const title = section === 'settings' ? '后台设置' : section === 'personal' ? '个人中心' : section === 'overview' ? '项目概览' : section === 'issues' ? '缺陷中心' : section === 'activity' ? '变更动态' : '成员管理'
  return (
    <header className="topbar">
      <button className="icon-button mobile-menu" onClick={onMenu} title="打开导航"><Menu size={19} /></button>
      <div className="breadcrumbs">
        {project && section !== 'personal' && section !== 'settings' && <><span>{project.name}</span><ChevronRight size={14} /></>}<strong>{title}</strong>
      </div>
      {section !== 'members' && section !== 'settings' && <div className="topbar-actions">
        <button className={`topbar-refresh ${refreshing ? 'refreshing' : ''}`} type="button" onClick={onRefresh} disabled={refreshing} aria-label={refreshing ? '正在刷新最新数据' : '刷新最新数据'} title="从数据库刷新最新数据"><RefreshCw size={17} /></button>
        {project && section !== 'personal' && <button className="primary-button compact" onClick={onNewIssue}><Plus size={16} /> 新建缺陷</button>}
      </div>}
    </header>
  )
}

function StatBlock({ label, value, detail, icon: Icon, tone }: { label: string; value: number | string; detail: string; icon: typeof AlertCircle; tone: string }) {
  return (
    <article className="stat-block">
      <div className="stat-icon" style={{ '--tone': tone } as React.CSSProperties}><Icon size={18} /></div>
      <div><span>{label}</span><strong>{value}</strong><small>{detail}</small></div>
    </article>
  )
}

function Overview({ project, onOpenIssue }: { project: Project; onOpenIssue: (id: string) => void }) {
  const { isTerminal, values, activeValues, label } = useDictionaries()
  const priorityOrder = values('priority', project.issues.map((issue) => issue.priority))
  const urgentPriority = activeValues('priority')[0]
  const active = project.issues.filter((issue) => !isTerminal(issue.status))
  const urgent = project.issues.filter((issue) => issue.priority === urgentPriority && !isTerminal(issue.status))
  const verifying = project.issues.filter((issue) => issue.status === '待复测')
  const resolved = project.issues.filter((issue) => isTerminal(issue.status))
  const completion = project.issues.length ? Math.round((resolved.length / project.issues.length) * 100) : 0
  const recent = [...project.issues].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).slice(0, 5)

  return (
    <div className="content page-enter">
      <div className="page-heading">
        <div><span className="eyebrow">{project.key} / PROJECT HEALTH</span><h1>{project.name}</h1><p>{project.description}</p></div>
        <div className="project-health"><span>本期完成率</span><strong>{completion}%</strong></div>
      </div>
      <section className="stats-grid" aria-label="项目指标">
        <StatBlock label="进行中" value={active.length} detail="尚未完成的事项" icon={Activity} tone="#2d6ca2" />
        <StatBlock label="紧急缺陷" value={urgent.length} detail={`当前未完成 ${label('priority', urgentPriority ?? '')}`} icon={AlertCircle} tone="#c43f38" />
        <StatBlock label={label('status', '待复测')} value={verifying.length} detail="需要测试确认" icon={CheckCircle2} tone="#a56820" />
        <StatBlock label="累计完成" value={resolved.length} detail={`共 ${project.issues.length} 条记录`} icon={Check} tone="#287a64" />
      </section>
      <section className="overview-grid">
        <div className="overview-panel priority-overview">
          <div className="panel-heading"><div><span className="eyebrow">DISTRIBUTION</span><h2>优先级分布</h2></div><SlidersHorizontal size={17} /></div>
          <div className="priority-bars">
            {priorityOrder.map((priority) => {
              const count = project.issues.filter((issue) => issue.priority === priority).length
              const width = project.issues.length ? Math.max((count / project.issues.length) * 100, count ? 8 : 0) : 0
              return (
                <div className="priority-bar-row" key={priority}>
                  <PriorityPill priority={priority} />
                  <div className="bar-track"><span className={`bar-${priority.toLowerCase()}`} style={{ width: `${width}%` }} /></div>
                  <strong>{count}</strong>
                </div>
              )
            })}
          </div>
        </div>
      </section>
      <section className="recent-section">
        <div className="section-heading"><div><span className="eyebrow">RECENTLY UPDATED</span><h2>最近更新</h2></div><span>{recent.length} 条</span></div>
        <div className="compact-issue-list">
          {recent.length ? recent.map((issue) => (
            <button key={issue.id} onClick={() => onOpenIssue(issue.id)}>
              <span className="issue-id">{issue.id}</span>
              <span className="issue-main"><strong>{issue.title}</strong><small>{issue.module} · {issue.lastModifiedBy}</small></span>
              <PriorityPill priority={issue.priority} />
              <StatusPill status={issue.status} />
              <time>{relativeDate(issue.updatedAt)}</time>
              <ChevronRight size={16} />
            </button>
          )) : <EmptyState compact />}
        </div>
      </section>
    </div>
  )
}

function EmptyState({ compact = false, onNew }: { compact?: boolean; onNew?: () => void }) {
  return (
    <div className={`empty-state ${compact ? 'compact-empty' : ''}`}>
      <span><Bug size={22} /></span>
      <strong>当前没有缺陷</strong>
      {!compact && onNew && <button className="secondary-button" onClick={onNew}><Plus size={15} /> 新建第一条</button>}
    </div>
  )
}

function MultiSelectFilter<T extends string>({
  label,
  options,
  selected,
  onChange,
  optionStyle,
  optionLabel = (option) => option,
}: {
  label: string
  options: readonly T[]
  selected: T[]
  onChange: (values: T[]) => void
  optionStyle?: (option: T) => React.CSSProperties
  optionLabel?: (option: T) => string
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    function close(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [])

  const buttonText = selected.length === 0 ? `全部${label}` : selected.length === 1 ? optionLabel(selected[0]) : `${label} ${selected.length}`
  return (
    <div className="multi-select-filter" ref={rootRef}>
      <button type="button" className={open ? 'open' : ''} onClick={() => setOpen((value) => !value)} aria-expanded={open} aria-label={`${label}筛选`}>
        <span>{buttonText}</span><ChevronDown size={15} />
      </button>
      {open && (
        <div className="multi-select-menu">
          <div className="multi-select-head"><strong>{label}</strong>{selected.length > 0 && <button type="button" onClick={() => onChange([])}>清除</button>}</div>
          {options.map((option) => {
            const checked = selected.includes(option)
            return (
              <label key={option}>
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => onChange(checked ? selected.filter((value) => value !== option) : [...selected, option])}
                />
                <span className="filter-check">{checked && <Check size={13} />}</span>
                <span className={optionStyle ? 'filter-option-tone' : undefined} style={optionStyle?.(option)}>{optionLabel(option)}</span>
              </label>
            )
          })}
        </div>
      )}
    </div>
  )
}

function memberSearchTerms(option: UserOption) {
  return `${option.name.toLowerCase()} ${option.pinyin} ${option.initials}`
}

function AssigneePicker({ options, value, onChange, fallbackNames = [] }: { options: UserOption[]; value: string[]; onChange: (ids: string[]) => void; fallbackNames?: string[] }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const rootRef = useRef<HTMLDivElement | null>(null)
  const searchRef = useRef<HTMLInputElement | null>(null)
  const mergedOptions = useMemo(() => {
    const optionById = new Map(options.map((option) => [option.id, option]))
    value.forEach((id, index) => {
      if (!optionById.has(id)) optionById.set(id, { id, name: fallbackNames[index] ?? '已停用成员', pinyin: '', initials: '' })
    })
    return [...value.map((id) => optionById.get(id)!), ...options.filter((option) => !value.includes(option.id))]
  }, [fallbackNames, options, value])
  const selectedOptions = value.map((id) => mergedOptions.find((option) => option.id === id)!).filter(Boolean)
  const normalizedQuery = query.trim().toLowerCase().replace(/\s+/g, '')
  const filtered = useMemo(() => mergedOptions.filter((option) => !normalizedQuery || memberSearchTerms(option).replace(/\s+/g, '').includes(normalizedQuery)), [mergedOptions, normalizedQuery])

  useEffect(() => {
    function close(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [])

  useEffect(() => {
    if (!open) return
    const timer = window.setTimeout(() => searchRef.current?.focus(), 0)
    return () => window.clearTimeout(timer)
  }, [open])

  return (
    <div className="assignee-picker" ref={rootRef}>
      <button type="button" className={open ? 'open' : ''} aria-label="负责人" aria-haspopup="listbox" aria-expanded={open} onClick={() => { setOpen((current) => !current); setQuery('') }}>
        {selectedOptions.length ? <span className="assignee-selected-list">{selectedOptions.map((option) => <Avatar name={option.name} size="small" key={option.id} />)}</span> : <span className="assignee-placeholder">请选择负责人</span>}
        <ChevronDown size={15} />
      </button>
      {open && <div className="assignee-menu">
        <div className="assignee-search"><Search size={15} /><input ref={searchRef} aria-label="筛选负责人" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="输入姓名、拼音或首字母" /></div>
        <div className="assignee-options" role="listbox" aria-label="负责人选项">
          {filtered.map((option) => {
            const selected = value.includes(option.id)
            const locked = selected && value.length === 1
            return <button type="button" role="option" aria-selected={selected} disabled={locked} title={locked ? '至少保留一名负责人' : undefined} key={option.id} onClick={() => onChange(selected ? value.filter((id) => id !== option.id) : [...value, option.id])}><Avatar name={option.name} size="small" />{selected && <Check size={14} />}</button>
          })}
          {!filtered.length && <div className="assignee-empty">未找到匹配成员</div>}
        </div>
        <div className="assignee-menu-footer">已选择 {value.length} 人</div>
      </div>}
    </div>
  )
}

function SelectionCheckbox({ checked, indeterminate = false, disabled = false, ariaLabel, title, onChange }: { checked: boolean; indeterminate?: boolean; disabled?: boolean; ariaLabel: string; title?: string; onChange: (checked: boolean) => void }) {
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (inputRef.current) inputRef.current.indeterminate = indeterminate
  }, [indeterminate])
  return <input ref={inputRef} className="issue-selection-checkbox" type="checkbox" checked={checked} disabled={disabled} aria-label={ariaLabel} title={title} onChange={(event) => onChange(event.target.checked)} />
}

function IssueTable({ issues, onOpen, onStatusChange, selectedIds, onSelectionChange, onSelectAll, canModify }: { issues: Issue[]; onOpen: (id: string) => void; onStatusChange: (id: string, status: IssueStatus) => void; selectedIds?: ReadonlySet<string>; onSelectionChange?: (id: string, selected: boolean) => void; onSelectAll?: (selected: boolean) => void; canModify?: (issue: Issue) => boolean }) {
  const { label } = useDictionaries()
  if (!issues.length) return <EmptyState />
  const selectable = selectedIds !== undefined && onSelectionChange !== undefined && onSelectAll !== undefined
  const modifiableIssues = canModify ? issues.filter(canModify) : issues
  const selectedCount = selectable ? modifiableIssues.filter((issue) => selectedIds.has(issue.id)).length : 0
  const allSelected = selectable && modifiableIssues.length > 0 && selectedCount === modifiableIssues.length
  return (
    <div className="issue-table-wrap">
      <table className={`issue-table${selectable ? ' selectable' : ''}`}>
        <thead><tr>{selectable && <th className="issue-select-cell" onClick={(event) => event.stopPropagation()}><SelectionCheckbox checked={allSelected} indeterminate={selectedCount > 0 && !allSelected} disabled={!modifiableIssues.length} ariaLabel="选择当前页可修改的缺陷" onChange={onSelectAll} /></th>}<th>编号</th><th>标题</th><th>状态</th><th>优先级</th><th>环境</th><th>最后修改人</th><th>更新时间</th></tr></thead>
        <tbody>
          {issues.map((issue) => (
            <tr className={selectable && selectedIds.has(issue.id) ? 'selected' : undefined} key={issue.id} onClick={() => onOpen(issue.id)} tabIndex={0} onKeyDown={(event) => event.key === 'Enter' && onOpen(issue.id)}>
              {selectable && <td className="issue-select-cell" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}><SelectionCheckbox checked={selectedIds.has(issue.id)} disabled={canModify ? !canModify(issue) : false} ariaLabel={`选择 ${issue.id}`} title={canModify && !canModify(issue) ? '只有负责人或创建人可以修改' : undefined} onChange={(selected) => onSelectionChange(issue.id, selected)} /></td>}
              <td><span className="issue-id">{issue.id}</span></td>
              <td>
                <div className="table-title">
                  <strong title={issue.title}>{issue.title}</strong>
                  <div className="issue-title-meta">
                    <span className="issue-meta-item module-meta" title={`模块：${issue.module}`}>
                      <Boxes size={13} aria-hidden="true" />
                      <span className="issue-meta-label">模块</span>
                      <b>{issue.module}</b>
                    </span>
                    <span className="issue-meta-item reporter-meta" title={`创建人：${issue.reporter}`}>
                      <UserRound size={13} aria-hidden="true" />
                      <span className="issue-meta-label">创建人</span>
                      <b>{issue.reporter}</b>
                    </span>
                  </div>
                </div>
              </td>
              <td onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
                <StatusSelect value={issue.status} onChange={(status) => onStatusChange(issue.id, status)} ariaLabel={`${issue.id} 状态`} disabled={canModify ? !canModify(issue) : false} />
              </td>
              <td><PriorityPill priority={issue.priority} /></td>
              <td><span className="environment-pill" data-environment={issue.environment} title={label('environment', issue.environment)}><MonitorCog size={13} /><span>{label('environment', issue.environment)}</span></span></td>
              <td><div className="assignee-cell"><Avatar name={issue.lastModifiedBy} size="small" /></div></td>
              <td><div className="date-cell"><span>{relativeDate(issue.updatedAt)}</span><small>{formatDate(issue.updatedAt)}</small></div></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function PersonalCenterView({ projects, currentUser, onOpenIssue, onStatusChange }: { projects: Project[]; currentUser: Session; onOpenIssue: (id: string) => void; onStatusChange: (id: string, status: IssueStatus) => void }) {
  const { isTerminal, compareIssues, values, label } = useDictionaries()
  const groups = useMemo(() => projects
    .map((project) => {
      const assignedIssues = project.issues
        .filter((issue) => issueAssigneeIds(issue).includes(currentUser.id) && !isTerminal(issue.status))
      return {
        project,
        issues: assignedIssues.sort(compareIssues),
        latestUpdate: Math.max(...assignedIssues.map((issue) => Date.parse(issue.updatedAt))),
      }
    })
    .filter((group) => group.issues.length > 0)
    .sort((left, right) => right.latestUpdate - left.latestUpdate), [currentUser.id, projects, isTerminal, compareIssues])
  const issues = groups.flatMap((group) => group.issues)
  const countStatus = (status: IssueStatus) => issues.filter((issue) => issue.status === status).length

  return (
    <div className="content content-personal page-enter">
      <div className="page-heading personal-heading">
        <div><span className="eyebrow">MY ASSIGNED ISSUES</span><h1>个人中心</h1><p>{currentUser.name}，你当前负责 {groups.length} 个项目中的 {issues.length} 条缺陷</p></div>
      </div>
      <section className="personal-summary" aria-label="个人缺陷汇总">
        <div><span>负责总数</span><strong>{issues.length}</strong></div>
        {values('status', issues.map((issue) => issue.status)).filter((status) => !isTerminal(status)).map((status) => <div key={status}><span>{label('status', status)}</span><strong>{countStatus(status)}</strong></div>)}
      </section>
      {groups.length ? <div className="personal-projects">
        {groups.map(({ project, issues: projectIssues }) => {
          return <section className="personal-project-group" key={project.id}>
            <header>
              <div><span className="project-glyph small" style={{ background: project.color }}>{project.key.slice(0, 1)}</span><span><strong>{project.name}</strong><small>{project.key}</small></span></div>
              <span>共 {projectIssues.length} 条待推进</span>
            </header>
            <IssueTable issues={projectIssues} onOpen={onOpenIssue} onStatusChange={onStatusChange} />
          </section>
        })}
      </div> : <div className="personal-empty"><span><UserRound size={24} /></span><strong>当前没有由你负责的缺陷</strong></div>}
    </div>
  )
}

function IssueBoard({ issues, onOpen }: { issues: Issue[]; onOpen: (id: string) => void }) {
  const { values } = useDictionaries()
  const statusOrder = values('status', issues.map((issue) => issue.status))
  return (
    <div className="board-scroll">
      <div className="issue-board" style={{ gridTemplateColumns: `repeat(${statusOrder.length}, minmax(214px, 1fr))` }}>
        {statusOrder.map((status) => {
          const items = issues.filter((issue) => issue.status === status)
          return (
            <section className="board-column" key={status}>
              <div className="board-column-header"><StatusPill status={status} /><span>{items.length}</span></div>
              <div className="board-column-items">
                {items.map((issue) => (
                  <button className="issue-card" key={issue.id} onClick={() => onOpen(issue.id)}>
                    <div><span className="issue-id">{issue.id}</span><PriorityPill priority={issue.priority} /></div>
                    <strong>{issue.title}</strong>
                    <small>{issue.module}</small>
                    <footer><Avatar name={issue.lastModifiedBy} size="small" /><time>{relativeDate(issue.updatedAt)}</time></footer>
                  </button>
                ))}
                {!items.length && <div className="board-empty">暂无事项</div>}
              </div>
            </section>
          )
        })}
      </div>
    </div>
  )
}

function IssuesView({
  project,
  currentUser,
  onOpenIssue,
  onNewIssue,
  onStatusChange,
  onBatchStatusChange,
}: {
  project: Project
  currentUser: Session
  onOpenIssue: (id: string) => void
  onNewIssue: () => void
  onStatusChange: (id: string, status: IssueStatus) => void
  onBatchStatusChange: (issueIds: string[], status: IssueStatus) => Promise<number>
}) {
  const [view, setView] = useState<IssueView>('list')
  const { values, activeValues, label, compareIssues } = useDictionaries()
  const statusOrder = values('status', project.issues.map((issue) => issue.status))
  const priorityOrder = values('priority', project.issues.map((issue) => issue.priority))
  const [query, setQuery] = useState('')
  const [statuses, setStatuses] = useState<IssueStatus[]>([])
  const [priorities, setPriorities] = useState<Priority[]>([])
  const [environments, setEnvironments] = useState<string[]>([])
  const [reporters, setReporters] = useState<string[]>([])
  const [selectedIssueIds, setSelectedIssueIds] = useState<Set<string>>(() => new Set())
  const [bulkStatus, setBulkStatus] = useState<IssueStatus | ''>('')
  const [showBatchConfirm, setShowBatchConfirm] = useState(false)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState<IssuePageSize>(20)
  const reporterOptions = useMemo(() => Array.from(new Set(project.issues.map((issue) => issue.reporter))).sort(), [project.issues])
  const environmentOptions = values('environment', project.issues.map((issue) => issue.environment))

  useEffect(() => {
    if (bulkStatus && !activeValues('status').includes(bulkStatus)) {
      setBulkStatus('')
      setShowBatchConfirm(false)
    }
  }, [activeValues, bulkStatus])

  useEffect(() => {
    setQuery('')
    setStatuses([])
    setPriorities([])
    setEnvironments([])
    setReporters([])
    setSelectedIssueIds(new Set())
    setBulkStatus('')
    setShowBatchConfirm(false)
    setPage(1)
  }, [project.id])

  const issues = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    return [...project.issues]
      .filter((issue) => statuses.length === 0 || statuses.includes(issue.status))
      .filter((issue) => priorities.length === 0 || priorities.includes(issue.priority))
      .filter((issue) => environments.length === 0 || environments.includes(issue.environment))
      .filter((issue) => reporters.length === 0 || reporters.includes(issue.reporter))
      .filter((issue) => !keyword || `${issue.id} ${issue.title} ${issue.module} ${label('environment', issue.environment)} ${label('status', issue.status)} ${label('priority', issue.priority)} ${issue.lastModifiedBy} ${issue.reporter} ${issueAssigneeNames(issue).join(' ')}`.toLowerCase().includes(keyword))
      .sort(compareIssues)
  }, [environments, priorities, project.issues, query, reporters, statuses, compareIssues, label])

  const pageCount = Math.max(1, Math.ceil(issues.length / pageSize))
  const currentPage = Math.min(page, pageCount)
  const pageIssues = useMemo(() => issues.slice((currentPage - 1) * pageSize, currentPage * pageSize), [currentPage, issues, pageSize])
  const modifiablePageIssues = useMemo(() => pageIssues.filter((issue) => canModifyIssue(issue, currentUser)), [currentUser, pageIssues])
  const pageStart = issues.length ? ((currentPage - 1) * pageSize) + 1 : 0
  const pageEnd = Math.min(currentPage * pageSize, issues.length)

  useEffect(() => {
    setPage((current) => Math.min(current, pageCount))
  }, [pageCount])

  useEffect(() => {
    setPage(1)
    setSelectedIssueIds(new Set())
    setBulkStatus('')
    setShowBatchConfirm(false)
  }, [query, statuses, priorities, environments, reporters, pageSize])

  useEffect(() => {
    const visibleIssueIds = new Set(modifiablePageIssues.map((issue) => issue.id))
    setSelectedIssueIds((current) => {
      const next = new Set([...current].filter((issueId) => visibleIssueIds.has(issueId)))
      return next.size === current.size ? current : next
    })
  }, [modifiablePageIssues])

  const selectedIssues = modifiablePageIssues.filter((issue) => selectedIssueIds.has(issue.id))
  const allVisibleSelected = modifiablePageIssues.length > 0 && selectedIssues.length === modifiablePageIssues.length

  function selectIssue(issueId: string, selected: boolean) {
    setSelectedIssueIds((current) => {
      if (selected && !modifiablePageIssues.some((issue) => issue.id === issueId)) return current
      const next = new Set(current)
      if (selected) next.add(issueId)
      else next.delete(issueId)
      return next
    })
  }

  function selectAll(selected: boolean) {
    setSelectedIssueIds(selected ? new Set(modifiablePageIssues.map((issue) => issue.id)) : new Set())
  }

  function resetBatchSelection() {
    setSelectedIssueIds(new Set())
    setBulkStatus('')
    setShowBatchConfirm(false)
  }

  function changePage(nextPage: number) {
    setPage(Math.min(pageCount, Math.max(1, nextPage)))
    resetBatchSelection()
  }

  function changePageSize(nextPageSize: IssuePageSize) {
    setPageSize(nextPageSize)
    setPage(1)
    resetBatchSelection()
  }

  function changeView(nextView: IssueView) {
    setView(nextView)
    if (nextView === 'board') {
      resetBatchSelection()
    }
  }

  async function confirmBatchStatusChange() {
    if (!bulkStatus || !selectedIssues.length) return
    await onBatchStatusChange(selectedIssues.map((issue) => issue.id), bulkStatus)
    setSelectedIssueIds(new Set())
    setBulkStatus('')
    setShowBatchConfirm(false)
  }

  return (
    <div className="content content-issues page-enter">
      <div className="issue-controls-sticky">
        <div className="issue-toolbar">
          <div className="toolbar-left">
            <div className="search-field"><Search size={17} /><input aria-label="搜索缺陷" placeholder="搜索编号、标题、模块、环境或人员" value={query} onChange={(event) => setQuery(event.target.value)} />{query && <button className="clear-search" onClick={() => setQuery('')} title="清空搜索"><X size={15} /></button>}</div>
            <MultiSelectFilter label="状态" options={statusOrder} selected={statuses} onChange={setStatuses} optionStyle={statusStyle} optionLabel={(value) => label('status', value)} />
            <MultiSelectFilter label="优先级" options={priorityOrder} selected={priorities} onChange={setPriorities} optionLabel={(value) => label('priority', value)} />
            <MultiSelectFilter label="环境" options={environmentOptions} selected={environments} onChange={setEnvironments} optionLabel={(value) => label('environment', value)} />
            <MultiSelectFilter label="创建人" options={reporterOptions} selected={reporters} onChange={setReporters} />
          </div>
          <div className="toolbar-right">
            {view === 'list' && modifiablePageIssues.length > 0 && <button className={`mobile-select-all${allVisibleSelected ? ' active' : ''}`} type="button" onClick={() => selectAll(!allVisibleSelected)} title={allVisibleSelected ? '清除当前页选择' : '选择当前页可修改的缺陷'}><ListChecks size={16} />{allVisibleSelected ? '清除选择' : '选择本页'}</button>}
            <span className="result-count">{issues.length} 条结果</span>
            <div className="view-toggle" aria-label="视图切换">
              <button className={view === 'list' ? 'active' : ''} onClick={() => changeView('list')} title="列表视图"><LayoutList size={16} /></button>
              <button className={view === 'board' ? 'active' : ''} onClick={() => changeView('board')} title="看板视图"><Columns3 size={16} /></button>
            </div>
          </div>
        </div>
        {view === 'list' && selectedIssues.length > 0 && <div className="bulk-status-bar" role="region" aria-label="批量修改缺陷状态">
          <div className="bulk-selection-summary"><CheckCircle2 size={18} /><strong>已选择 {selectedIssues.length} 条</strong><button type="button" onClick={() => selectAll(false)}>清除</button></div>
          <div className="bulk-status-actions"><select aria-label="批量目标状态" value={bulkStatus} onChange={(event) => setBulkStatus(event.target.value as IssueStatus | '')}><option value="">选择目标状态</option>{activeValues('status').map((status) => <option key={status} value={status}>{label('status', status)}</option>)}</select><button className="primary-button compact" type="button" disabled={!bulkStatus} onClick={() => setShowBatchConfirm(true)}><SlidersHorizontal size={16} /> 应用状态</button></div>
        </div>}
      </div>
      {view === 'list' ? <IssueTable issues={pageIssues} onOpen={onOpenIssue} onStatusChange={onStatusChange} selectedIds={selectedIssueIds} onSelectionChange={selectIssue} onSelectAll={selectAll} canModify={(issue) => canModifyIssue(issue, currentUser)} /> : <IssueBoard issues={pageIssues} onOpen={onOpenIssue} />}
      {issues.length > 0 && <nav className="issue-pagination" aria-label="缺陷分页">
        <label className="issue-page-size"><span>每页</span><span className="issue-page-size-control"><select aria-label="每页显示数量" value={pageSize} onChange={(event) => changePageSize(Number(event.target.value) as IssuePageSize)}>{ISSUE_PAGE_SIZES.map((size) => <option value={size} key={size}>{size} 条</option>)}</select><ChevronDown size={14} aria-hidden="true" /></span></label>
        <span className="issue-page-range">{pageStart}-{pageEnd} / {issues.length}</span>
        <div className="issue-page-controls"><button type="button" onClick={() => changePage(currentPage - 1)} disabled={currentPage === 1} aria-label="缺陷上一页" title="上一页"><ChevronLeft size={16} /></button><span>第 <strong>{currentPage}</strong> / {pageCount} 页</span><button type="button" onClick={() => changePage(currentPage + 1)} disabled={currentPage === pageCount} aria-label="缺陷下一页" title="下一页"><ChevronRight size={16} /></button></div>
      </nav>}
      {!project.issues.length && <button className="primary-button empty-create" onClick={onNewIssue}><Plus size={16} /> 新建缺陷</button>}
      {showBatchConfirm && bulkStatus && <BatchStatusModal issues={selectedIssues.map(({ id, status }) => ({ id, status }))} status={bulkStatus} onClose={() => setShowBatchConfirm(false)} onConfirm={confirmBatchStatusChange} />}
    </div>
  )
}

function ActivityView({ project, onOpenIssue }: { project: Project; onOpenIssue: (id: string) => void }) {
  const [selectedDate, setSelectedDate] = useState(() => activityDateKey(new Date()))
  const [page, setPage] = useState(1)
  const activities = useMemo(() => project.issues.flatMap((issue) => issue.activities.map((activity) => ({ ...activity, issue }))).sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp)), [project.issues])
  const filteredActivities = useMemo(() => activities.filter((activity) => activityDateKey(activity.timestamp) === selectedDate), [activities, selectedDate])
  const totalPages = Math.max(1, Math.ceil(filteredActivities.length / ACTIVITY_PAGE_SIZE))
  const pageActivities = filteredActivities.slice((page - 1) * ACTIVITY_PAGE_SIZE, page * ACTIVITY_PAGE_SIZE)
  const rangeStart = filteredActivities.length ? ((page - 1) * ACTIVITY_PAGE_SIZE) + 1 : 0
  const rangeEnd = Math.min(page * ACTIVITY_PAGE_SIZE, filteredActivities.length)

  useEffect(() => {
    setSelectedDate(activityDateKey(new Date()))
    setPage(1)
  }, [project.id])

  useEffect(() => {
    setPage((current) => Math.min(current, totalPages))
  }, [totalPages])

  return (
    <div className="content activity-page page-enter">
      <div className="page-heading"><div><span className="eyebrow">{project.key} / AUDIT LOG</span><h1>变更动态</h1><p>{project.name} 的完整缺陷操作记录</p></div></div>
      <div className="activity-filter-bar">
        <div className="activity-date-filter">
          <CalendarDays size={17} />
          <label><span>筛选日期</span><input type="date" aria-label="筛选变更日期" value={selectedDate} onChange={(event) => { setSelectedDate(event.target.value); setPage(1) }} /></label>
        </div>
        <button className="secondary-button compact activity-today-button" type="button" disabled={selectedDate === activityDateKey(new Date())} onClick={() => { setSelectedDate(activityDateKey(new Date())); setPage(1) }}>今天</button>
        <span className="activity-filter-result">{filteredActivities.length} 条记录</span>
      </div>
      <section className="activity-stream-full">
        <div className="activity-stream-head"><div><History size={17} /><strong>项目活动</strong></div><span>{rangeStart}-{rangeEnd} / {filteredActivities.length}</span></div>
        {pageActivities.length ? pageActivities.map((activity) => (
          <article className="activity-row" key={activity.id}>
            <Avatar name={activity.actor} />
            <div className="activity-row-main">
              <div><span>{activity.action}</span><button onClick={() => onOpenIssue(activity.issue.id)}>{activity.issue.id} · {activity.issue.title}</button></div>
              <ActivityDetail activity={activity} />
            </div>
            <time>{formatDate(activity.timestamp, true)}</time>
          </article>
        )) : <div className="activity-empty"><span><CalendarDays size={22} /></span><strong>所选日期暂无变更记录</strong></div>}
        {totalPages > 1 && <nav className="activity-pagination" aria-label="变更动态分页">
          <button type="button" disabled={page === 1} onClick={() => setPage((current) => Math.max(1, current - 1))}><ChevronLeft size={16} />上一页</button>
          <span>第 <strong>{page}</strong> / {totalPages} 页</span>
          <button type="button" disabled={page === totalPages} onClick={() => setPage((current) => Math.min(totalPages, current + 1))}>下一页<ChevronRight size={16} /></button>
        </nav>}
      </section>
    </div>
  )
}

function ModalShell({ title, subtitle, onClose, children, layerClassName = '' }: { title: string; subtitle: string; onClose: () => void; children: React.ReactNode; layerClassName?: string }) {
  return (
    <div className={`modal-layer${layerClassName ? ` ${layerClassName}` : ''}`} role="dialog" aria-modal="true" aria-label={title}>
      <button className="modal-backdrop" onClick={onClose} aria-label="关闭弹窗" />
      <section className="modal-card">
        <header><div><h2>{title}</h2><p>{subtitle}</p></div><button className="icon-button" onClick={onClose} title="关闭"><X size={18} /></button></header>
        {children}
      </section>
    </div>
  )
}

function ForgotPasswordModal({ onClose }: { onClose: () => void }) {
  const [admins, setAdmins] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    api.adminContacts()
      .then((result) => {
        if (!cancelled) setAdmins(result.admins)
      })
      .catch((loadError) => {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : '管理员名单加载失败')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [attempt])

  return (
    <ModalShell title="忘记密码" subtitle="账号登录协助" onClose={onClose} layerClassName="forgot-password-layer">
      <div className="forgot-password-content">
        {loading && <div className="admin-contact-state"><RefreshCw size={18} className="admin-contact-spinner" /><span>正在获取管理员名单</span></div>}
        {!loading && error && <div className="admin-contact-state error"><AlertCircle size={18} /><span>{error}</span><button type="button" onClick={() => setAttempt((value) => value + 1)}>重新加载</button></div>}
        {!loading && !error && admins.length > 0 && <><div className="admin-contact-intro"><ShieldCheck size={18} /><span>请联系以下管理员协助处理</span></div><div className="admin-contact-list">{admins.map((admin) => <div key={admin}><span className="admin-contact-icon"><UserRound size={15} /></span><span>请联系管理员 <strong>{admin}</strong></span></div>)}</div></>}
        {!loading && !error && admins.length === 0 && <div className="admin-contact-state"><AlertCircle size={18} /><span>当前暂无可联系的管理员</span></div>}
        <footer className="modal-actions"><button className="primary-button" type="button" onClick={onClose}>知道了</button></footer>
      </div>
    </ModalShell>
  )
}

function PersonalSettingsModal({ session, onClose, onSave }: { session: Session; onClose: () => void; onSave: (input: Pick<Session, 'name' | 'email'>) => Promise<void> }) {
  const [name, setName] = useState(session.name)
  const [email, setEmail] = useState(session.email)
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const normalizedName = name.trim()
  const normalizedEmail = email.trim().toLowerCase()
  const changed = normalizedName !== session.name || normalizedEmail !== session.email.toLowerCase()

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!normalizedName) return setError('请输入真实姓名')
    if (!/^\p{Script=Han}+$/u.test(normalizedName)) return setError('真实姓名只能包含中文')
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) return setError('请输入有效的公司邮箱')
    setSubmitting(true)
    setError('')
    try {
      await onSave({ name: normalizedName, email: normalizedEmail })
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : '个人信息更新失败')
      setSubmitting(false)
    }
  }

  const close = () => {
    if (!submitting) onClose()
  }

  return (
    <ModalShell title="个人设置" subtitle="更新账号基本信息" onClose={close} layerClassName="personal-settings-layer">
      <form className="personal-settings-form" onSubmit={submit}>
        <label><span>真实姓名</span><input autoFocus value={name} onChange={(event) => { setName(event.target.value); setError('') }} autoComplete="name" maxLength={80} /></label>
        <label><span>公司邮箱</span><input type="email" value={email} onChange={(event) => { setEmail(event.target.value); setError('') }} autoComplete="email" maxLength={254} /></label>
        <div className="personal-settings-role"><span>账号角色</span><strong>{session.role === 'admin' ? '管理员' : '成员'}</strong></div>
        <div className="modal-inline-error" aria-live="polite">{error}</div>
        <footer className="modal-actions"><button className="secondary-button" type="button" onClick={close} disabled={submitting}>取消</button><button className="primary-button" type="submit" disabled={submitting || !changed}><Check size={16} /> {submitting ? '正在保存' : '保存修改'}</button></footer>
      </form>
    </ModalShell>
  )
}

function BatchStatusModal({ issues, status, onClose, onConfirm }: { issues: Array<Pick<Issue, 'id' | 'status'>>; status: IssueStatus; onClose: () => void; onConfirm: () => Promise<void> }) {
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  async function confirm() {
    setSubmitting(true)
    setError('')
    try {
      await onConfirm()
    } catch (confirmError) {
      setError(confirmError instanceof Error ? confirmError.message : '批量更新失败')
      setSubmitting(false)
    }
  }

  const close = () => {
    if (!submitting) onClose()
  }

  return createPortal(
    <ModalShell title="批量修改状态" subtitle={`已选择 ${issues.length} 条缺陷`} onClose={close} layerClassName="batch-status-modal-layer">
      <div className="batch-status-confirm">
        <div className="batch-status-change"><span>目标状态</span><StatusPill status={status} /></div>
        <p>将所选 {issues.length} 条缺陷统一修改为目标状态。</p>
        {error && <div className="modal-inline-error">{error}</div>}
        <footer className="modal-actions"><button className="secondary-button" type="button" onClick={close} disabled={submitting}>取消</button><button className="primary-button" type="button" onClick={() => void confirm()} disabled={submitting}><Check size={16} /> {submitting ? '正在更新' : '确认修改'}</button></footer>
      </div>
    </ModalShell>,
    document.body,
  )
}

function ConfirmDeleteModal({ targetName, targetType, detail, onClose, onConfirm }: { targetName: string; targetType: '项目' | '缺陷' | '用户'; detail: string; onClose: () => void; onConfirm: () => Promise<void> }) {
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  async function confirm() {
    setSubmitting(true)
    setError('')
    try {
      await onConfirm()
    } catch (confirmError) {
      setError(confirmError instanceof Error ? confirmError.message : '删除失败')
      setSubmitting(false)
    }
  }

  return (
    <ModalShell title={`删除${targetType}`} subtitle="此操作无法撤销" onClose={onClose}>
      <div className="delete-confirm-body">
        <div className="delete-confirm-content">
          <div className="delete-confirm-icon"><Trash2 size={20} /></div>
          <div><strong>{targetName}</strong><p>{detail}</p></div>
        </div>
        {error && <div className="modal-inline-error">{error}</div>}
        <footer className="modal-actions delete-confirm-actions"><button className="secondary-button" type="button" onClick={onClose}>取消</button><button className="danger-button" type="button" onClick={() => void confirm()} disabled={submitting}><Trash2 size={16} /> 确认删除</button></footer>
      </div>
    </ModalShell>
  )
}

function NewProjectModal({ onClose, onCreate }: { onClose: () => void; onCreate: (project: Pick<Project, 'name' | 'key' | 'description'>) => void }) {
  const [name, setName] = useState('')
  const [key, setKey] = useState('')
  const [description, setDescription] = useState('')
  const cleanKey = key.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6)
  const valid = Boolean(name.trim() && cleanKey)
  return (
    <ModalShell title="新建项目" subtitle="创建独立的缺陷工作区" onClose={onClose}>
      <form onSubmit={(event) => { event.preventDefault(); if (valid) onCreate({ name: name.trim(), key: cleanKey, description: description.trim() }) }}>
        <div className="form-grid two-columns">
          <label><span>项目名称</span><input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：官网重构" /></label>
          <label><span>项目标识</span><input value={key} onChange={(event) => setKey(event.target.value.toUpperCase())} placeholder="例如：WEB" maxLength={6} /></label>
        </div>
        <label><span>项目描述</span><textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="简要说明项目范围" rows={3} /></label>
        <footer className="modal-actions"><button className="secondary-button" type="button" onClick={onClose}>取消</button><button className="primary-button" disabled={!valid} type="submit"><FolderKanban size={16} /> 创建项目</button></footer>
      </form>
    </ModalShell>
  )
}

function NewIssueModal({ project, currentUser, userOptions, onClose, onCreate }: { project: Project; currentUser: Session; userOptions: UserOption[]; onClose: () => void; onCreate: (issue: CreateIssueInput) => void }) {
  const { activeValues, defaultValue, label } = useDictionaries()
  const priorityOrder = activeValues('priority')
  const environmentOrder = activeValues('environment')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [evidence, setEvidence] = useState<EvidenceItem[]>([])
  const [priority, setPriority] = useState<Priority>(() => defaultValue('priority'))
  const [module, setModule] = useState('')
  const [environment, setEnvironment] = useState(() => defaultValue('environment'))
  const [assigneeIds, setAssigneeIds] = useState([currentUser.id])
  useEffect(() => {
    if (!activeValues('priority').includes(priority)) setPriority(defaultValue('priority'))
    if (!activeValues('environment').includes(environment)) setEnvironment(defaultValue('environment'))
  }, [activeValues, defaultValue, priority, environment])
  return (
    <ModalShell title="新建缺陷" subtitle={`${project.name} · 编号由服务端生成`} onClose={onClose}>
      <form onSubmit={(event) => { event.preventDefault(); if (title.trim() && assigneeIds.length) onCreate({ title: title.trim(), description: composeIssueDescription(description, evidence), priority, module: module.trim() || '未分类', environment, status: defaultValue('status'), assigneeIds }) }}>
        <label><span>标题</span><IssueTitleField value={title} onChange={setTitle} ariaLabel="缺陷标题" placeholder="用一句话说明问题" autoFocus /></label>
        <div className="modal-form-field issue-evidence-field"><span>证据</span><EvidenceUploadBox evidence={evidence} onChange={setEvidence} uploadEvidence={uploadEvidence} /></div>
        <label className="issue-description-field"><span>问题描述</span><textarea aria-label="问题描述" value={description} onChange={(event) => setDescription(event.target.value)} placeholder="描述现象、复现步骤和预期结果" rows={5} /></label>
        <div className="form-grid two-columns issue-settings-grid">
          <label><span>优先级</span><select value={priority} onChange={(event) => setPriority(event.target.value)}>{priorityOrder.map((item) => <option key={item} value={item}>{label('priority', item)}</option>)}</select></label>
          <label><span>环境</span><select aria-label="环境" value={environment} onChange={(event) => setEnvironment(event.target.value)}>{environmentOrder.map((item) => <option key={item} value={item}>{label('environment', item)}</option>)}</select></label>
          <label><span>模块</span><input value={module} onChange={(event) => setModule(event.target.value)} placeholder="例如：登录认证" /></label>
          <div className="assignee-form-field"><span>负责人</span><AssigneePicker options={userOptions} value={assigneeIds} onChange={setAssigneeIds} fallbackNames={[currentUser.name]} /></div>
        </div>
        <div className="automatic-modifier"><span>最后修改人</span><div><Avatar name={currentUser.name} size="small" /></div></div>
        <footer className="modal-actions"><button className="secondary-button" type="button" onClick={onClose}>取消</button><button className="primary-button" disabled={!title.trim() || !assigneeIds.length} type="submit"><Plus size={16} /> 创建缺陷</button></footer>
      </form>
    </ModalShell>
  )
}

function IssueDrawer({
  issue,
  currentUser,
  userOptions,
  onClose,
  onFieldChange,
  onSaveContent,
  onComment,
  onRequestDelete,
}: {
  issue: Issue
  currentUser: string
  userOptions: UserOption[]
  onClose: () => void
  onFieldChange: (field: 'status' | 'priority' | 'environment' | 'module' | 'assigneeIds', value: string | string[], label: string) => void
  onSaveContent: (title: string, description: string) => void
  onComment: (comment: string) => void
  onRequestDelete: () => void
}) {
  const savedContent = useMemo(() => splitIssueDescription(issue.description), [issue.description])
  const { activeValues, label } = useDictionaries()
  const priorityOrder = activeValues('priority')
  const environmentOrder = activeValues('environment')
  const [title, setTitle] = useState(issue.title)
  const [description, setDescription] = useState(savedContent.description)
  const [evidence, setEvidence] = useState(savedContent.evidence)
  const [comment, setComment] = useState('')
  const evidenceChanged = evidence.length !== savedContent.evidence.length || evidence.some((item, index) => item.url !== savedContent.evidence[index]?.url)
  const contentChanged = title.trim() !== issue.title || description !== savedContent.description || evidenceChanged

  useEffect(() => {
    setTitle(issue.title)
    const nextContent = splitIssueDescription(issue.description)
    setDescription(nextContent.description)
    setEvidence(nextContent.evidence)
    setComment('')
  }, [issue.id])

  return (
    <div className="drawer-layer" role="dialog" aria-modal="true" aria-label={`${issue.id} 详情`}>
      <button className="drawer-backdrop" onClick={onClose} aria-label="关闭详情" />
      <aside className="issue-drawer">
        <header className="drawer-header">
          <div><span className="issue-id">{issue.id}</span></div>
          <div className="drawer-header-actions"><button className="icon-button danger-icon" onClick={onRequestDelete} title="删除缺陷"><Trash2 size={17} /></button><button className="icon-button" onClick={onClose} title="关闭详情"><X size={19} /></button></div>
        </header>
        <div className="drawer-body">
          <section className="issue-content-edit">
            <IssueTitleField value={title} onChange={setTitle} ariaLabel="缺陷标题" variant="drawer" />
            <div className="issue-content-field"><span>证据</span><EvidenceUploadBox evidence={evidence} onChange={setEvidence} uploadEvidence={uploadEvidence} /></div>
            <label className="issue-content-description"><span>问题描述</span><textarea aria-label="缺陷描述" value={description} onChange={(event) => setDescription(event.target.value)} placeholder="填写问题现象、复现步骤和预期结果" rows={6} /></label>
            {contentChanged && <div className="save-content-bar"><span>内容有未保存的更改</span><button className="primary-button compact" onClick={() => onSaveContent(title.trim(), composeIssueDescription(description, evidence))} disabled={!title.trim()}><Check size={15} /> 保存</button></div>}
          </section>
          <section className="property-section">
            <h3>属性</h3>
            <div className="property-grid">
              <div className="status-property"><span>状态</span><StatusSelect value={issue.status} onChange={(status) => onFieldChange('status', status, '状态')} ariaLabel="状态" variant="property" /></div>
              <label><span>优先级</span><select value={issue.priority} onChange={(event) => onFieldChange('priority', event.target.value, '优先级')}>{!priorityOrder.includes(issue.priority) && <option value={issue.priority} disabled>{label('priority', issue.priority)}（已停用）</option>}{priorityOrder.map((item) => <option key={item} value={item}>{label('priority', item)}</option>)}</select></label>
              <label><span>运行环境</span><select value={issue.environment} onChange={(event) => onFieldChange('environment', event.target.value, '环境')}>{!environmentOrder.includes(issue.environment) && <option value={issue.environment} disabled>{label('environment', issue.environment)}（已停用）</option>}{environmentOrder.map((item) => <option key={item} value={item}>{label('environment', item)}</option>)}</select></label>
              <label><span>所属模块</span><input key={`${issue.id}-${issue.module}`} defaultValue={issue.module} onBlur={(event) => onFieldChange('module', event.target.value.trim() || '未分类', '所属模块')} /></label>
              <div className="property-assignee"><span>负责人</span><AssigneePicker options={userOptions} value={issueAssigneeIds(issue)} onChange={(ids) => onFieldChange('assigneeIds', ids, '负责人')} fallbackNames={issueAssigneeNames(issue)} /></div>
              <div className="static-property"><span>创建人</span><div><Avatar name={issue.reporter} size="small" /></div></div>
              <div className="static-property"><span>最后修改人</span><div><Avatar name={issue.lastModifiedBy} size="small" /></div></div>
              <div className="static-property"><span>最后更新时间</span><div className="static-time"><History size={15} /><span>{formatDate(issue.updatedAt, true)}</span></div></div>
            </div>
          </section>
          <section className="activity-section">
            <div className="activity-heading"><h3>活动记录</h3><span>{issue.activities.length}</span></div>
            <form className="comment-box" onSubmit={(event) => { event.preventDefault(); if (hasRichEvidenceContent(comment)) { onComment(comment); setComment('') } }}>
              <Avatar name={currentUser} />
              <div className="comment-composer"><RichTextEditor value={comment} onChange={setComment} placeholder="添加评论或处理说明" ariaLabel="评论内容" minHeight={96} uploadEvidence={uploadEvidence} /><button className="secondary-button compact" type="submit" disabled={!hasRichEvidenceContent(comment)}><MessageSquare size={15} /> 发布</button></div>
            </form>
            <div className="activity-timeline">
              {issue.activities.map((activity) => (
                <article key={activity.id}>
                  <div className={`timeline-icon ${activity.kind}`}>{activity.kind === 'commented' ? <MessageSquare size={14} /> : activity.kind === 'created' ? <Plus size={14} /> : <History size={14} />}</div>
                  <div className="timeline-content"><div><Avatar name={activity.actor} size="small" /><span>{activity.action}</span><time>{formatDate(activity.timestamp, true)}</time></div><ActivityDetail activity={activity} /></div>
                </article>
              ))}
            </div>
          </section>
        </div>
      </aside>
    </div>
  )
}

function AdminPasswordModal({ user, onClose, onComplete }: { user: EmployeeAccount; onClose: () => void; onComplete: () => void }) {
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (password.length < 6) return setError('密码至少 6 个字符')
    if (password !== confirmPassword) return setError('两次输入的密码不一致')
    setSubmitting(true)
    setError('')
    try {
      await api.resetUserPassword(user.id, password)
      onComplete()
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : '密码修改失败')
      setSubmitting(false)
    }
  }

  return (
    <ModalShell title="修改用户密码" subtitle={`${user.name} · ${user.email}`} onClose={onClose}>
      <form onSubmit={submit}>
        <label><span>新密码</span><input autoFocus type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" placeholder="至少 6 个字符" /></label>
        <label><span>确认新密码</span><input type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} autoComplete="new-password" placeholder="请再次输入密码" /></label>
        <div className="modal-inline-error" aria-live="polite">{error}</div>
        <footer className="modal-actions"><button className="secondary-button" type="button" onClick={onClose}>取消</button><button className="primary-button" type="submit" disabled={submitting}><KeyRound size={16} /> 更新密码</button></footer>
      </form>
    </ModalShell>
  )
}

function MembersView({ currentUser, onToast, refreshVersion }: { currentUser: Session; onToast: (message: string) => void; refreshVersion: number }) {
  const [users, setUsers] = useState<EmployeeAccount[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [passwordUser, setPasswordUser] = useState<EmployeeAccount | null>(null)
  const [deleteUser, setDeleteUser] = useState<EmployeeAccount | null>(null)

  useEffect(() => {
    let cancelled = false
    api.users()
      .then((result) => { if (!cancelled) { setUsers(result.users); setError('') } })
      .catch((loadError) => { if (!cancelled) setError(loadError instanceof Error ? loadError.message : '成员加载失败') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [refreshVersion])

  async function promote(user: EmployeeAccount) {
    setError('')
    try {
      const result = await api.promoteUser(user.id)
      setUsers((current) => current.map((item) => item.id === user.id ? result.user : item))
      onToast(`${user.name} 已任命为管理员`)
    } catch (promoteError) {
      setError(promoteError instanceof Error ? promoteError.message : '任命管理员失败')
    }
  }

  async function confirmDelete(user: EmployeeAccount) {
    await api.deleteUser(user.id)
    setUsers((current) => current.filter((item) => item.id !== user.id))
    setDeleteUser(null)
    onToast(`${user.name} 已删除`)
  }

  return (
    <div className="content members-page page-enter">
      <div className="page-heading members-heading"><div><span className="eyebrow">EMPLOYEE DIRECTORY</span><h1>成员管理</h1><p>{users.length} 位已登录员工</p></div></div>
      {error && <div className="page-error">{error}</div>}
      <div className="members-table-wrap">
        <table className="members-table">
          <thead><tr><th>员工</th><th>公司邮箱</th><th>角色</th><th>状态</th><th>注册时间</th><th>操作</th></tr></thead>
          <tbody>
            {users.map((user) => <tr key={user.id}><td><div className="member-identity"><Avatar name={user.name} />{user.id === currentUser.id && <small>当前</small>}</div></td><td>{user.email || '尚未注册'}</td><td><span className={`role-pill ${user.role}`}>{user.role === 'admin' ? '管理员' : '员工'}</span></td><td><span className="account-state"><i />{user.active ? '正常' : '停用'}</span></td><td>{formatDate(user.createdAt, true)}</td><td><div className="member-actions">{user.role === 'member' && <button className="icon-button" onClick={() => void promote(user)} title={`任命 ${user.name} 为管理员`}><ShieldCheck size={16} /></button>}{user.email && <button className="icon-button" onClick={() => setPasswordUser(user)} title={`修改 ${user.name} 的密码`}><KeyRound size={16} /></button>}{user.id !== currentUser.id && <button className="icon-button danger-icon" onClick={() => setDeleteUser(user)} title={`删除用户 ${user.name}`}><Trash2 size={16} /></button>}</div></td></tr>)}
          </tbody>
        </table>
        {!loading && users.length === 0 && <div className="members-empty">暂无成员</div>}
        {loading && <div className="members-empty">正在加载</div>}
      </div>
      {passwordUser && <AdminPasswordModal user={passwordUser} onClose={() => setPasswordUser(null)} onComplete={() => { setPasswordUser(null); onToast(`${passwordUser.name} 的密码已更新`) }} />}
      {deleteUser && <ConfirmDeleteModal targetType="用户" targetName={`${deleteUser.name}${deleteUser.email ? ` · ${deleteUser.email}` : ''}`} detail="删除后该用户将立即退出且无法再次登录，历史缺陷和操作记录中的姓名会保留。" onClose={() => setDeleteUser(null)} onConfirm={() => confirmDelete(deleteUser)} />}
    </div>
  )
}

function Toast({ message }: { message: string }) {
  return <div className="toast"><CheckCircle2 size={17} /> {message}</div>
}

function EmptyWorkspace({ onCreateProject }: { onCreateProject: () => void }) {
  return (
      <section className="empty-workspace-content">
        <div className="empty-workspace-icon"><FolderKanban size={28} /></div>
        <span className="eyebrow">WORKSPACE SETUP</span>
        <h1>创建第一个项目</h1>
        <button className="primary-button" onClick={onCreateProject}><Plus size={16} /> 新建项目</button>
      </section>
  )
}

function BootScreen({ error, onRetry }: { error?: string; onRetry?: () => void }) {
  return <main className="boot-screen"><span className="brand-mark"><Bug size={21} /></span>{error ? <><strong>服务暂时不可用</strong><p>{error}</p><button className="secondary-button" onClick={onRetry}>重新连接</button></> : <span className="boot-loader" aria-label="正在连接服务" />}</main>
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [data, setData] = useState<WorkspaceData>({ projects: [] })
  const [userOptions, setUserOptions] = useState<UserOption[]>([])
  const [currentProjectId, setCurrentProjectId] = useState('')
  const [section, setSection] = useState<Section>('issues')
  const [selectedIssueId, setSelectedIssueId] = useState<string | null>(null)
  const [showNewIssue, setShowNewIssue] = useState(false)
  const [showNewProject, setShowNewProject] = useState(false)
  const [showPersonalSettings, setShowPersonalSettings] = useState(false)
  const [projectToDelete, setProjectToDelete] = useState<Project | null>(null)
  const [issueToDelete, setIssueToDelete] = useState<Issue | null>(null)
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const [toast, setToast] = useState('')
  const [booting, setBooting] = useState(true)
  const [bootError, setBootError] = useState('')
  const [bootAttempt, setBootAttempt] = useState(0)
  const [refreshVersion, setRefreshVersion] = useState(0)
  const [manualRefreshing, setManualRefreshing] = useState(false)
  const lastRefreshAtRef = useRef(Date.now())
  const manualRefreshingRef = useRef(false)
  const dictionaryDirtyRef = useRef(false)
  const dictionaries = data.dictionaries ?? defaultDictionaries
  const dictionaryVersions = data.dictionaryVersions ?? { priority: 0, environment: 0, status: 0 }

  const currentProject = data.projects.find((project) => project.id === currentProjectId) ?? data.projects[0]
  const selectedIssue = data.projects.flatMap((project) => project.issues).find((issue) => issue.id === selectedIssueId) ?? null

  useEffect(() => {
    if (session?.role !== 'admin' && (section === 'settings' || section === 'members')) setSection('issues')
  }, [session?.role, section])

  useEffect(() => {
    if (!session || section !== 'settings') return
    let cancelled = false
    api.dictionaries().then((latest) => {
      if (!cancelled) setData((previous) => mergeWorkspaceData(previous, { ...previous, ...latest }))
    }).catch((error) => {
      if (!cancelled) showApiError(error)
    })
    return () => { cancelled = true }
  }, [session?.id, section])

  useEffect(() => {
    let cancelled = false
    async function bootstrap() {
      setBooting(true)
      setBootError('')
      try {
        const result = await api.me()
        if (!result.user) {
          return
        }
        const [workspace, directory] = await Promise.all([api.workspace(), api.userOptions()])
        if (cancelled) return
        setSession(result.user)
        setData((previous) => mergeWorkspaceData(previous, workspace))
        setUserOptions(directory.users)
        setCurrentProjectId(restoreProject(result.user.id, workspace.projects))
        lastRefreshAtRef.current = Date.now()
        setRefreshVersion((value) => value + 1)
      } catch (error) {
        if (cancelled) return
        setBootError(error instanceof Error ? error.message : '无法连接服务')
      } finally {
        if (!cancelled) setBooting(false)
      }
    }
    void bootstrap()
    return () => { cancelled = true }
  }, [bootAttempt])

  useEffect(() => {
    if (!session) return
    let cancelled = false
    let refreshing = false

    async function refreshAllData() {
      if (refreshing) return
      refreshing = true
      try {
        const [sessionResult, workspace, directory] = await Promise.all([api.me(), api.workspace(), api.userOptions()])
        if (cancelled) return
        if (!sessionResult.user) {
          setSession(null)
          setData({ projects: [] })
          setUserOptions([])
          setSelectedIssueId(null)
          setToast('登录已过期，请重新登录')
          return
        }
        const refreshedUser = sessionResult.user
        setSession(refreshedUser)
        setData((previous) => mergeWorkspaceData(previous, workspace))
        setUserOptions(directory.users)
        setCurrentProjectId((current) => {
          const projectId = workspace.projects.some((project) => project.id === current) ? current : restoreProject(refreshedUser.id, workspace.projects)
          rememberProject(refreshedUser.id, projectId)
          return projectId
        })
        setSelectedIssueId((current) => !current || workspace.projects.some((project) => project.issues.some((issue) => issue.id === current)) ? current : null)
        lastRefreshAtRef.current = Date.now()
        setRefreshVersion((value) => value + 1)
      } catch (error) {
        if (cancelled) return
        if (error instanceof ApiError && error.status === 401) {
          setSession(null)
          setData({ projects: [] })
          setUserOptions([])
          setSelectedIssueId(null)
          setToast('登录已过期，请重新登录')
        } else {
          setToast(error instanceof Error ? `自动刷新失败：${error.message}` : '自动刷新失败')
        }
      } finally {
        refreshing = false
      }
    }

    const timer = window.setInterval(() => void refreshAllData(), REFRESH_INTERVAL_MS)
    function refreshAfterSleep() {
      if (document.visibilityState === 'visible' && Date.now() - lastRefreshAtRef.current >= REFRESH_INTERVAL_MS) void refreshAllData()
    }
    document.addEventListener('visibilitychange', refreshAfterSleep)
    return () => {
      cancelled = true
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', refreshAfterSleep)
    }
  }, [session?.id])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(''), 2200)
    return () => window.clearTimeout(timer)
  }, [toast])

  function showApiError(error: unknown) {
    if (error instanceof ApiError && error.status === 401) {
      setSession(null)
      setData({ projects: [] })
      setUserOptions([])
      setSelectedIssueId(null)
      setToast('登录已过期，请重新登录')
      return
    }
    setToast(error instanceof Error ? error.message : '操作失败')
  }

  async function refreshNow() {
    if (manualRefreshingRef.current) return
    manualRefreshingRef.current = true
    setManualRefreshing(true)
    try {
      const [sessionResult, workspace, directory] = await Promise.all([api.me(), api.workspace(), api.userOptions()])
      if (!sessionResult.user) {
        setSession(null)
        setData({ projects: [] })
        setUserOptions([])
        setCurrentProjectId('')
        setSelectedIssueId(null)
        setToast('登录已过期，请重新登录')
        return
      }
      const refreshedUser = sessionResult.user
      setSession(refreshedUser)
      setData((previous) => mergeWorkspaceData(previous, workspace))
      setUserOptions(directory.users)
      setCurrentProjectId((current) => {
        const projectId = workspace.projects.some((project) => project.id === current) ? current : restoreProject(refreshedUser.id, workspace.projects)
        rememberProject(refreshedUser.id, projectId)
        return projectId
      })
      setSelectedIssueId((current) => !current || workspace.projects.some((project) => project.issues.some((issue) => issue.id === current)) ? current : null)
      lastRefreshAtRef.current = Date.now()
      setRefreshVersion((value) => value + 1)
      setToast('已获取数据库最新数据')
    } catch (error) {
      showApiError(error)
    } finally {
      manualRefreshingRef.current = false
      setManualRefreshing(false)
    }
  }

  async function authenticate(mode: 'login' | 'register', input: { email?: string; name: string; password: string }) {
    const authResult = mode === 'register'
      ? await api.register({ email: input.email ?? '', name: input.name, password: input.password })
      : await api.login({ name: input.name, password: input.password })
    const [workspace, directory] = await Promise.all([api.workspace(), api.userOptions()])
    setSession(authResult.user)
    setData((previous) => mergeWorkspaceData(previous, workspace))
    setUserOptions(directory.users)
    setCurrentProjectId(restoreProject(authResult.user.id, workspace.projects))
    lastRefreshAtRef.current = Date.now()
    setRefreshVersion((value) => value + 1)
  }

  async function logout() {
    if (!confirmLeavingDictionary()) return
    if (session && currentProjectId) rememberProject(session.id, currentProjectId)
    try { await api.logout() } catch { /* local state still needs to close */ }
    setSession(null)
    setData({ projects: [] })
    setUserOptions([])
    setCurrentProjectId('')
    setSelectedIssueId(null)
    setShowPersonalSettings(false)
    setSection('issues')
  }

  async function updateProfile(input: Pick<Session, 'name' | 'email'>) {
    const result = await api.updateProfile(input)
    setSession(result.user)
    setShowPersonalSettings(false)
    setToast('个人信息已更新')
    try {
      const [workspace, directory] = await Promise.all([api.workspace(), api.userOptions()])
      setData((previous) => mergeWorkspaceData(previous, workspace))
      setUserOptions(directory.users)
      setRefreshVersion((value) => value + 1)
      lastRefreshAtRef.current = Date.now()
    } catch {
      setToast('个人信息已更新，工作区将在下次刷新时同步')
    }
  }

  async function saveDictionary(kind: DictionaryKind, version: number, items: DictionaryDraft[]) {
    try {
      const result = await api.saveDictionary(kind, version, items)
      setData((previous) => mergeWorkspaceData(previous, { ...previous, ...result }))
      setToast('字典已保存')
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        const latest = await api.dictionaries()
        setData((previous) => mergeWorkspaceData(previous, { ...previous, ...latest }))
      }
      throw error
    }
  }

  function confirmLeavingDictionary() {
    return section !== 'settings' || !dictionaryDirtyRef.current || window.confirm('后台设置有未保存的修改，确定放弃并离开吗？')
  }

  function changeSection(next: Section) {
    if (next === section || confirmLeavingDictionary()) setSection(next)
  }

  function openProjectAction(action: () => void) {
    if (!confirmLeavingDictionary()) return
    if (section === 'settings') setSection('issues')
    action()
  }

  function switchProject(id: string) {
    setCurrentProjectId(id)
    if (session) rememberProject(session.id, id)
    setSelectedIssueId(null)
    if (section === 'personal') setSection('overview')
  }

  async function createProject(input: Pick<Project, 'name' | 'key' | 'description'>) {
    try {
      const result = await api.createProject(input)
      setData((previous) => ({ ...previous, projects: [...previous.projects, result.project] }))
      setCurrentProjectId(result.project.id)
      if (session) rememberProject(session.id, result.project.id)
      setSection('issues')
      setShowNewProject(false)
      setToast(`项目 ${result.project.name} 已创建`)
    } catch (error) {
      showApiError(error)
    }
  }

  async function deleteProject(project: Project) {
    try {
      await api.deleteProject(project.id)
      const remainingProjects = data.projects.filter((item) => item.id !== project.id)
      setData((previous) => ({ ...previous, projects: previous.projects.filter((item) => item.id !== project.id) }))
      if (currentProjectId === project.id) {
        const fallbackProjectId = remainingProjects[0]?.id ?? ''
        setCurrentProjectId(fallbackProjectId)
        if (session) rememberProject(session.id, fallbackProjectId)
      }
      setSelectedIssueId(null)
      setProjectToDelete(null)
      setSection('issues')
      setToast(`项目 ${project.name} 已删除`)
    } catch (error) {
      showApiError(error)
      throw error
    }
  }

  function replaceIssues(updatedIssues: Issue[]) {
    const issuesById = new Map(updatedIssues.map((issue) => [issue.id, issue]))
    setData((previous) => ({ ...previous, projects: previous.projects.map((project) => {
      const projectUpdates = project.issues.map((issue) => issuesById.get(issue.id)).filter((issue): issue is Issue => issue !== undefined)
      if (!projectUpdates.length) return project
      return {
        ...project,
        members: Array.from(new Set([...project.members, ...projectUpdates.flatMap((issue) => [...issueAssigneeNames(issue), issue.lastModifiedBy])])),
        issues: project.issues.map((issue) => issuesById.get(issue.id) ?? issue),
      }
    }) }))
  }

  function replaceIssue(updatedIssue: Issue) {
    replaceIssues([updatedIssue])
  }

  async function createIssue(input: CreateIssueInput) {
    if (!currentProject) return
    try {
      const result = await api.createIssue(currentProject.id, input)
      setData((previous) => ({ ...previous, projects: previous.projects.map((project) => project.id === currentProject.id ? { ...project, members: Array.from(new Set([...project.members, ...issueAssigneeNames(result.issue), result.issue.lastModifiedBy])), issues: [result.issue, ...project.issues] } : project) }))
      setShowNewIssue(false)
      setSelectedIssueId(null)
      setSection('issues')
      setToast(`${result.issue.id} 已创建`)
    } catch (error) {
      showApiError(error)
    }
  }

  async function updateIssueField(issueId: string, field: 'status' | 'priority' | 'environment' | 'module' | 'assigneeIds', value: string | string[], label: string) {
    try {
      const input = field === 'assigneeIds'
        ? { assigneeIds: value as string[] }
        : field === 'status'
          ? { status: value as IssueStatus }
          : field === 'priority'
            ? { priority: value as Priority }
            : field === 'environment'
              ? { environment: value as string }
              : { module: value as string }
      const result = await api.updateIssue(issueId, input)
      replaceIssue(result.issue)
      setToast(`${label}已更新`)
    } catch (error) { showApiError(error) }
  }

  async function updateIssueStatuses(issueIds: string[], status: IssueStatus) {
    try {
      const result = await api.updateIssueStatuses(issueIds, status)
      replaceIssues(result.issues)
      setToast(result.updatedCount ? `已批量更新 ${result.updatedCount} 条缺陷` : '所选缺陷已处于目标状态')
      return result.updatedCount
    } catch (error) {
      showApiError(error)
      throw error
    }
  }

  async function saveIssueContent(title: string, description: string) {
    if (!selectedIssueId) return
    try {
      const input = title === selectedIssue?.title ? { description } : { title, description }
      const result = await api.updateIssue(selectedIssueId, input)
      replaceIssue(result.issue)
      setToast('缺陷内容已保存')
    } catch (error) { showApiError(error) }
  }

  async function addComment(comment: string) {
    if (!selectedIssueId) return
    try {
      const result = await api.comment(selectedIssueId, comment)
      replaceIssue(result.issue)
      setToast('评论已发布')
    } catch (error) { showApiError(error) }
  }

  async function deleteIssue(issue: Issue) {
    try {
      await api.deleteIssue(issue.id)
      setData((previous) => ({ ...previous, projects: previous.projects.map((project) => ({ ...project, issues: project.issues.filter((item) => item.id !== issue.id) })) }))
      setSelectedIssueId(null)
      setIssueToDelete(null)
      setToast(`${issue.id} 已删除`)
    } catch (error) {
      showApiError(error)
      throw error
    }
  }

  if (booting) return <BootScreen />
  if (bootError) return <BootScreen error={bootError} onRetry={() => setBootAttempt((value) => value + 1)} />
  if (!session) return <Login onAuthenticate={authenticate} />
  return (
    <DictionaryContext.Provider value={dictionaries}>
    <div className="app-shell">
      <Sidebar
        session={session}
        projects={data.projects}
        currentProjectId={currentProject?.id ?? ''}
        section={section}
        mobileOpen={mobileNavOpen}
        onProjectChange={switchProject}
        onDeleteProject={(project) => openProjectAction(() => setProjectToDelete(project))}
        onSectionChange={changeSection}
        onNewProject={() => openProjectAction(() => setShowNewProject(true))}
        onOpenSettings={() => setShowPersonalSettings(true)}
        onLogout={() => void logout()}
        onCloseMobile={() => setMobileNavOpen(false)}
      />
      <div className="main-area">
        <Header project={currentProject} section={section} refreshing={manualRefreshing} onMenu={() => setMobileNavOpen(true)} onRefresh={() => void refreshNow()} onNewIssue={() => setShowNewIssue(true)} />
        {section === 'personal' && <PersonalCenterView projects={data.projects} currentUser={session} onOpenIssue={setSelectedIssueId} onStatusChange={(issueId, status) => updateIssueField(issueId, 'status', status, '状态')} />}
        {section === 'overview' && currentProject && <Overview project={currentProject} onOpenIssue={setSelectedIssueId} />}
        {section === 'issues' && currentProject && <IssuesView project={currentProject} currentUser={session} onOpenIssue={setSelectedIssueId} onNewIssue={() => setShowNewIssue(true)} onStatusChange={(issueId, status) => updateIssueField(issueId, 'status', status, '状态')} onBatchStatusChange={updateIssueStatuses} />}
        {section === 'activity' && currentProject && <ActivityView project={currentProject} onOpenIssue={setSelectedIssueId} />}
        {section === 'members' && session.role === 'admin' && <MembersView currentUser={session} onToast={setToast} refreshVersion={refreshVersion} />}
        {section === 'settings' && session.role === 'admin' && (data.dictionaries && data.dictionaryVersions
          ? <DictionarySettings dictionaries={dictionaries} versions={dictionaryVersions} onSave={saveDictionary} onDirtyChange={(dirty) => { dictionaryDirtyRef.current = dirty }} />
          : <div className="content" role="status">正在加载字典设置…</div>)}
        {!currentProject && section !== 'members' && section !== 'settings' && section !== 'personal' && <EmptyWorkspace onCreateProject={() => setShowNewProject(true)} />}
      </div>
      {showNewProject && <NewProjectModal onClose={() => setShowNewProject(false)} onCreate={createProject} />}
      {showNewIssue && currentProject && <NewIssueModal project={currentProject} currentUser={session} userOptions={userOptions} onClose={() => setShowNewIssue(false)} onCreate={createIssue} />}
      {showPersonalSettings && <PersonalSettingsModal session={session} onClose={() => setShowPersonalSettings(false)} onSave={updateProfile} />}
      {selectedIssue && <IssueDrawer issue={selectedIssue} currentUser={session.name} userOptions={userOptions} onClose={() => setSelectedIssueId(null)} onFieldChange={(field, value, label) => updateIssueField(selectedIssue.id, field, value, label)} onSaveContent={saveIssueContent} onComment={addComment} onRequestDelete={() => setIssueToDelete(selectedIssue)} />}
      {projectToDelete && <ConfirmDeleteModal targetType="项目" targetName={projectToDelete.name} detail={`项目中的 ${projectToDelete.issues.length} 条缺陷和全部活动记录也会被删除。`} onClose={() => setProjectToDelete(null)} onConfirm={() => deleteProject(projectToDelete)} />}
      {issueToDelete && <ConfirmDeleteModal targetType="缺陷" targetName={`${issueToDelete.id} · ${issueToDelete.title}`} detail="该缺陷的评论、变更历史和上传图片也会被删除。" onClose={() => setIssueToDelete(null)} onConfirm={() => deleteIssue(issueToDelete)} />}
      {toast && <Toast message={toast} />}
    </div>
    </DictionaryContext.Provider>
  )
}
