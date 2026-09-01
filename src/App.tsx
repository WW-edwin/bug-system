import { FormEvent, useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity,
  AlertCircle,
  ArrowRight,
  BarChart3,
  Boxes,
  Bug,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Columns3,
  FolderKanban,
  History,
  KeyRound,
  LayoutList,
  LogOut,
  Mail,
  Menu,
  MessageSquare,
  MonitorCog,
  Plus,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  UserRound,
  Users,
  X,
} from 'lucide-react'
import { api, ApiError, type EmployeeAccount } from './api'
import { environmentOrder, priorityOrder, statusOrder } from './data'
import ImageUploadBox from './ImageUploadBox'
import { composeIssueDescription, splitIssueDescription } from './issueDescription'
import type { Issue, IssueStatus, Priority, Project, Session, WorkspaceData } from './types'

type Section = 'overview' | 'issues' | 'activity' | 'members'
type IssueView = 'list' | 'board'
const REFRESH_INTERVAL_MS = 10 * 60 * 1000

const statusStyles: Record<IssueStatus, { color: string; background: string; border: string }> = {
  待处理: { color: '#9f2f2a', background: '#ffe9e7', border: '#f3c4bf' },
  处理中: { color: '#a32620', background: '#ffdedb', border: '#efa9a3' },
  待复测: { color: '#7c5b08', background: '#fff5d6', border: '#ead38b' },
  已解决: { color: '#267445', background: '#e8f6ec', border: '#b9dfc5' },
  不适用: { color: '#686b70', background: '#ffffff', border: '#d6d8dc' },
  待优化: { color: '#49617a', background: '#ffffff', border: '#cfd7df' },
}

function statusStyle(status: IssueStatus) {
  const style = statusStyles[status]
  return {
    '--status-color': style.color,
    '--status-bg': style.background,
    '--status-border': style.border,
  } as React.CSSProperties
}

async function uploadRichImage(file: File) {
  return (await api.uploadImage(file)).url
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
  )
}

function Avatar({ name, size = 'normal' }: { name: string; size?: 'small' | 'normal' | 'large' }) {
  const displayName = name.trim() || '未命名'
  return <span className={`avatar avatar-${size}`} aria-label={displayName}>{displayName}</span>
}

function StatusPill({ status }: { status: IssueStatus }) {
  return (
    <span className="status-pill" data-status={status} style={statusStyle(status)}>
      <span />{status}
    </span>
  )
}

function PriorityPill({ priority }: { priority: Priority }) {
  return <span className={`priority-pill priority-${priority.toLowerCase()}`}>{priority}</span>
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
  const current = projects.find((project) => project.id === currentId) ?? projects[0]
  if (!current) return null

  return (
    <div className="project-switcher">
      <button className="project-current" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <span className="project-glyph" style={{ background: current.color }}>{current.key.slice(0, 1)}</span>
        <span className="project-current-copy"><small>当前项目</small><strong>{current.name}</strong></span>
        <ChevronDown size={16} />
      </button>
      {open && (
        <div className="project-menu">
          <div className="project-menu-label">切换项目</div>
          {projects.map((project) => (
            <div className={`project-menu-row ${project.id === currentId ? 'active' : ''}`} key={project.id}>
              <button className="project-menu-select" onClick={() => { onChange(project.id); setOpen(false) }}>
                <span className="project-glyph small" style={{ background: project.color }}>{project.key.slice(0, 1)}</span>
                <span><strong>{project.name}</strong><small>{project.key} · {project.issues.length} 条</small></span>
                {project.id === currentId && <Check size={15} />}
              </button>
              {canDelete && <button className="project-menu-delete" onClick={() => { onDelete(project); setOpen(false) }} title={`删除项目 ${project.name}`}><Trash2 size={15} /></button>}
            </div>
          ))}
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
  onLogout: () => void
  onCloseMobile: () => void
}) {
  const items = [
    { id: 'overview' as const, label: '项目概览', icon: BarChart3 },
    { id: 'issues' as const, label: '缺陷中心', icon: CircleDot },
    { id: 'activity' as const, label: '变更动态', icon: Activity },
    ...(session.role === 'admin' ? [{ id: 'members' as const, label: '成员管理', icon: Users }] : []),
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
  onMenu,
  onNewIssue,
}: {
  project: Project
  section: Section
  onMenu: () => void
  onNewIssue: () => void
}) {
  const title = section === 'overview' ? '项目概览' : section === 'issues' ? '缺陷中心' : section === 'activity' ? '变更动态' : '成员管理'
  return (
    <header className="topbar">
      <button className="icon-button mobile-menu" onClick={onMenu} title="打开导航"><Menu size={19} /></button>
      <div className="breadcrumbs">
        <span>{project.name}</span><ChevronRight size={14} /><strong>{title}</strong>
      </div>
      {section !== 'members' && <button className="primary-button compact" onClick={onNewIssue}><Plus size={16} /> 新建缺陷</button>}
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
  const active = project.issues.filter((issue) => !['已解决', '不适用'].includes(issue.status))
  const urgent = project.issues.filter((issue) => issue.priority === 'P0' && !['已解决', '不适用'].includes(issue.status))
  const verifying = project.issues.filter((issue) => issue.status === '待复测')
  const resolved = project.issues.filter((issue) => ['已解决', '不适用'].includes(issue.status))
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
        <StatBlock label="紧急缺陷" value={urgent.length} detail="当前未完成 P0" icon={AlertCircle} tone="#c43f38" />
        <StatBlock label="等待复测" value={verifying.length} detail="需要测试确认" icon={CheckCircle2} tone="#a56820" />
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
}: {
  label: string
  options: readonly T[]
  selected: T[]
  onChange: (values: T[]) => void
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

  const buttonText = selected.length === 0 ? `全部${label}` : selected.length === 1 ? selected[0] : `${label} ${selected.length}`
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
                <span>{option}</span>
              </label>
            )
          })}
        </div>
      )}
    </div>
  )
}

function IssueTable({ issues, onOpen, onStatusChange }: { issues: Issue[]; onOpen: (id: string) => void; onStatusChange: (id: string, status: IssueStatus) => void }) {
  if (!issues.length) return <EmptyState />
  return (
    <div className="issue-table-wrap">
      <table className="issue-table">
        <thead><tr><th>编号</th><th>标题</th><th>状态</th><th>优先级</th><th>环境</th><th>最后修改人</th><th>更新时间</th></tr></thead>
        <tbody>
          {issues.map((issue) => (
            <tr key={issue.id} onClick={() => onOpen(issue.id)} tabIndex={0} onKeyDown={(event) => event.key === 'Enter' && onOpen(issue.id)}>
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
                <div className="quick-status-select" data-status={issue.status} style={statusStyle(issue.status)}>
                  <span />
                  <select aria-label={`${issue.id} 状态`} value={issue.status} onChange={(event) => onStatusChange(issue.id, event.target.value as IssueStatus)}>
                    {statusOrder.map((status) => <option key={status}>{status}</option>)}
                  </select>
                </div>
              </td>
              <td><PriorityPill priority={issue.priority} /></td>
              <td><span className="environment-pill" data-environment={issue.environment} title={issue.environment}><MonitorCog size={13} /><span>{issue.environment}</span></span></td>
              <td><div className="assignee-cell"><Avatar name={issue.lastModifiedBy} size="small" /></div></td>
              <td><div className="date-cell"><span>{relativeDate(issue.updatedAt)}</span><small>{formatDate(issue.updatedAt)}</small></div></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function IssueBoard({ issues, onOpen }: { issues: Issue[]; onOpen: (id: string) => void }) {
  return (
    <div className="board-scroll">
      <div className="issue-board">
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
  onOpenIssue,
  onNewIssue,
  onStatusChange,
}: {
  project: Project
  onOpenIssue: (id: string) => void
  onNewIssue: () => void
  onStatusChange: (id: string, status: IssueStatus) => void
}) {
  const [view, setView] = useState<IssueView>('list')
  const [query, setQuery] = useState('')
  const [statuses, setStatuses] = useState<IssueStatus[]>([])
  const [priorities, setPriorities] = useState<Priority[]>([])
  const [environments, setEnvironments] = useState<string[]>([])
  const [reporters, setReporters] = useState<string[]>([])
  const reporterOptions = useMemo(() => Array.from(new Set(project.issues.map((issue) => issue.reporter))).sort(), [project.issues])
  const environmentOptions = useMemo(() => {
    const extras = Array.from(new Set(project.issues.map((issue) => issue.environment)))
      .filter((environment) => !environmentOrder.some((item) => item === environment))
      .sort()
    return [...environmentOrder, ...extras]
  }, [project.issues])

  useEffect(() => {
    setQuery('')
    setStatuses([])
    setPriorities([])
    setEnvironments([])
    setReporters([])
  }, [project.id])

  const issues = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    return [...project.issues]
      .filter((issue) => statuses.length === 0 || statuses.includes(issue.status))
      .filter((issue) => priorities.length === 0 || priorities.includes(issue.priority))
      .filter((issue) => environments.length === 0 || environments.includes(issue.environment))
      .filter((issue) => reporters.length === 0 || reporters.includes(issue.reporter))
      .filter((issue) => !keyword || `${issue.id} ${issue.title} ${issue.module} ${issue.environment} ${issue.lastModifiedBy} ${issue.reporter}`.toLowerCase().includes(keyword))
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
  }, [environments, priorities, project.issues, query, reporters, statuses])

  return (
    <div className="content content-issues page-enter">
      <div className="page-heading issues-heading">
        <div><span className="eyebrow">{project.key} / ISSUES</span><h1>缺陷中心</h1><p>{project.name} 当前共 {project.issues.length} 条记录</p></div>
      </div>
      <div className="issue-toolbar">
        <div className="toolbar-left">
          <div className="search-field"><Search size={17} /><input aria-label="搜索缺陷" placeholder="搜索编号、标题、模块、环境或人员" value={query} onChange={(event) => setQuery(event.target.value)} />{query && <button className="clear-search" onClick={() => setQuery('')} title="清空搜索"><X size={15} /></button>}</div>
          <MultiSelectFilter label="状态" options={statusOrder} selected={statuses} onChange={setStatuses} />
          <MultiSelectFilter label="优先级" options={priorityOrder} selected={priorities} onChange={setPriorities} />
          <MultiSelectFilter label="环境" options={environmentOptions} selected={environments} onChange={setEnvironments} />
          <MultiSelectFilter label="创建人" options={reporterOptions} selected={reporters} onChange={setReporters} />
        </div>
        <div className="toolbar-right">
          <span className="result-count">{issues.length} 条结果</span>
          <div className="view-toggle" aria-label="视图切换">
            <button className={view === 'list' ? 'active' : ''} onClick={() => setView('list')} title="列表视图"><LayoutList size={16} /></button>
            <button className={view === 'board' ? 'active' : ''} onClick={() => setView('board')} title="看板视图"><Columns3 size={16} /></button>
          </div>
        </div>
      </div>
      {view === 'list' ? <IssueTable issues={issues} onOpen={onOpenIssue} onStatusChange={onStatusChange} /> : <IssueBoard issues={issues} onOpen={onOpenIssue} />}
      {!project.issues.length && <button className="primary-button empty-create" onClick={onNewIssue}><Plus size={16} /> 新建缺陷</button>}
    </div>
  )
}

function ActivityView({ project, onOpenIssue }: { project: Project; onOpenIssue: (id: string) => void }) {
  const activities = project.issues.flatMap((issue) => issue.activities.map((activity) => ({ ...activity, issue }))).sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
  return (
    <div className="content activity-page page-enter">
      <div className="page-heading"><div><span className="eyebrow">{project.key} / AUDIT LOG</span><h1>变更动态</h1><p>{project.name} 的完整缺陷操作记录</p></div></div>
      <section className="activity-stream-full">
        <div className="activity-stream-head"><div><History size={17} /><strong>项目活动</strong></div><span>{activities.length} 条记录</span></div>
        {activities.length ? activities.map((activity) => (
          <article className="activity-row" key={activity.id}>
            <Avatar name={activity.actor} />
            <div className="activity-row-main">
              <div><span>{activity.action}</span><button onClick={() => onOpenIssue(activity.issue.id)}>{activity.issue.id} · {activity.issue.title}</button></div>
              <p>{activity.detail}</p>
            </div>
            <time>{formatDate(activity.timestamp, true)}</time>
          </article>
        )) : <EmptyState compact />}
      </section>
    </div>
  )
}

function ModalShell({ title, subtitle, onClose, children }: { title: string; subtitle: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="modal-layer" role="dialog" aria-modal="true" aria-label={title}>
      <button className="modal-backdrop" onClick={onClose} aria-label="关闭弹窗" />
      <section className="modal-card">
        <header><div><h2>{title}</h2><p>{subtitle}</p></div><button className="icon-button" onClick={onClose} title="关闭"><X size={18} /></button></header>
        {children}
      </section>
    </div>
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

function NewIssueModal({ project, currentUser, onClose, onCreate }: { project: Project; currentUser: string; onClose: () => void; onCreate: (issue: Omit<Issue, 'id' | 'createdAt' | 'updatedAt' | 'activities' | 'reporter' | 'lastModifiedBy'>) => void }) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [images, setImages] = useState<string[]>([])
  const [priority, setPriority] = useState<Priority>('P1')
  const [module, setModule] = useState('')
  const [environment, setEnvironment] = useState('测试环境')
  return (
    <ModalShell title="新建缺陷" subtitle={`${project.name} · 编号由服务端生成`} onClose={onClose}>
      <form onSubmit={(event) => { event.preventDefault(); if (title.trim()) onCreate({ title: title.trim(), description: composeIssueDescription(description, images), priority, module: module.trim() || '未分类', environment: environment.trim() || '未注明', status: '待处理' }) }}>
        <label><span>标题</span><input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} placeholder="用一句话说明问题" /></label>
        <div className="modal-form-field issue-image-field"><span>问题截图</span><ImageUploadBox images={images} onChange={setImages} uploadImage={uploadRichImage} /></div>
        <label className="issue-description-field"><span>问题描述</span><textarea aria-label="问题描述" value={description} onChange={(event) => setDescription(event.target.value)} placeholder="描述现象、复现步骤和预期结果" rows={5} /></label>
        <div className="form-grid three-columns">
          <label><span>优先级</span><select value={priority} onChange={(event) => setPriority(event.target.value as Priority)}>{priorityOrder.map((item) => <option key={item}>{item}</option>)}</select></label>
          <label><span>模块</span><input value={module} onChange={(event) => setModule(event.target.value)} placeholder="例如：登录认证" /></label>
          <label><span>环境</span><select aria-label="环境" value={environment} onChange={(event) => setEnvironment(event.target.value)}>{environmentOrder.map((item) => <option key={item}>{item}</option>)}</select></label>
        </div>
        <div className="automatic-modifier"><span>最后修改人</span><div><Avatar name={currentUser} size="small" /></div></div>
        <footer className="modal-actions"><button className="secondary-button" type="button" onClick={onClose}>取消</button><button className="primary-button" disabled={!title.trim()} type="submit"><Plus size={16} /> 创建缺陷</button></footer>
      </form>
    </ModalShell>
  )
}

function IssueDrawer({
  issue,
  currentUser,
  onClose,
  onFieldChange,
  onSaveContent,
  onComment,
  onRequestDelete,
}: {
  issue: Issue
  currentUser: string
  onClose: () => void
  onFieldChange: (field: 'status' | 'priority' | 'module', value: string, label: string) => void
  onSaveContent: (title: string, description: string) => void
  onComment: (comment: string) => void
  onRequestDelete: () => void
}) {
  const savedContent = useMemo(() => splitIssueDescription(issue.description), [issue.description])
  const [title, setTitle] = useState(issue.title)
  const [description, setDescription] = useState(savedContent.description)
  const [images, setImages] = useState(savedContent.images)
  const [comment, setComment] = useState('')
  const imagesChanged = images.length !== savedContent.images.length || images.some((src, index) => src !== savedContent.images[index])
  const contentChanged = title.trim() !== issue.title || description !== savedContent.description || imagesChanged

  useEffect(() => {
    setTitle(issue.title)
    const nextContent = splitIssueDescription(issue.description)
    setDescription(nextContent.description)
    setImages(nextContent.images)
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
            <input className="issue-title-input" aria-label="缺陷标题" value={title} onChange={(event) => setTitle(event.target.value)} />
            <div className="issue-content-field"><span>问题截图</span><ImageUploadBox images={images} onChange={setImages} uploadImage={uploadRichImage} /></div>
            <label className="issue-content-description"><span>问题描述</span><textarea aria-label="缺陷描述" value={description} onChange={(event) => setDescription(event.target.value)} placeholder="填写问题现象、复现步骤和预期结果" rows={6} /></label>
            {contentChanged && <div className="save-content-bar"><span>内容有未保存的更改</span><button className="primary-button compact" onClick={() => onSaveContent(title.trim(), composeIssueDescription(description, images))} disabled={!title.trim()}><Check size={15} /> 保存</button></div>}
          </section>
          <section className="property-section">
            <h3>属性</h3>
            <div className="property-grid">
              <label className="status-property"><span>状态</span><select data-status={issue.status} style={statusStyle(issue.status)} value={issue.status} onChange={(event) => onFieldChange('status', event.target.value, '状态')}>{statusOrder.map((item) => <option key={item}>{item}</option>)}</select></label>
              <label><span>优先级</span><select value={issue.priority} onChange={(event) => onFieldChange('priority', event.target.value, '优先级')}>{priorityOrder.map((item) => <option key={item}>{item}</option>)}</select></label>
              <label><span>所属模块</span><input key={`${issue.id}-${issue.module}`} defaultValue={issue.module} onBlur={(event) => onFieldChange('module', event.target.value.trim() || '未分类', '所属模块')} /></label>
              <div className="static-property"><span>报告人</span><div><Avatar name={issue.reporter} size="small" /></div></div>
              <div className="static-property"><span>最后修改人</span><div><Avatar name={issue.lastModifiedBy} size="small" /></div></div>
              <div className="static-property"><span>最后更新时间</span><div className="static-time"><History size={15} /><span>{formatDate(issue.updatedAt, true)}</span></div></div>
            </div>
            <div className="environment-row"><span>运行环境</span><strong>{issue.environment}</strong></div>
          </section>
          <section className="activity-section">
            <div className="activity-heading"><h3>活动记录</h3><span>{issue.activities.length}</span></div>
            <form className="comment-box" onSubmit={(event) => { event.preventDefault(); if (comment.trim()) { onComment(comment.trim()); setComment('') } }}>
              <Avatar name={currentUser} />
              <div><textarea value={comment} onChange={(event) => setComment(event.target.value)} placeholder="添加评论或处理说明" rows={2} /><button className="secondary-button compact" type="submit" disabled={!comment.trim()}><MessageSquare size={15} /> 发布</button></div>
            </form>
            <div className="activity-timeline">
              {issue.activities.map((activity) => (
                <article key={activity.id}>
                  <div className={`timeline-icon ${activity.kind}`}>{activity.kind === 'commented' ? <MessageSquare size={14} /> : activity.kind === 'created' ? <Plus size={14} /> : <History size={14} />}</div>
                  <div className="timeline-content"><div><Avatar name={activity.actor} size="small" /><span>{activity.action}</span><time>{formatDate(activity.timestamp, true)}</time></div><p>{activity.detail}</p></div>
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

function EmptyWorkspace({ session, section, refreshVersion, onCreateProject, onManageMembers, onLogout, onToast }: { session: Session; section: Section; refreshVersion: number; onCreateProject: () => void; onManageMembers: () => void; onLogout: () => void; onToast: (message: string) => void }) {
  return (
    <main className="empty-workspace-shell">
      <header className="empty-workspace-header">
        <div className="sidebar-brand"><span className="brand-mark"><Bug size={20} strokeWidth={2.4} /></span><span>TraceBug</span></div>
        <div className="empty-workspace-user"><Avatar name={session.name} />{session.role === 'admin' && <button className="icon-button" onClick={onManageMembers} title={section === 'members' ? '返回工作区' : '成员管理'}>{section === 'members' ? <FolderKanban size={17} /> : <Users size={17} />}</button>}<button className="icon-button" onClick={onLogout} title="退出登录"><LogOut size={17} /></button></div>
      </header>
      {section === 'members' ? <MembersView currentUser={session} onToast={onToast} refreshVersion={refreshVersion} /> : <section className="empty-workspace-content">
        <div className="empty-workspace-icon"><FolderKanban size={28} /></div>
        <span className="eyebrow">WORKSPACE SETUP</span>
        <h1>创建第一个项目</h1>
        <button className="primary-button" onClick={onCreateProject}><Plus size={16} /> 新建项目</button>
      </section>}
    </main>
  )
}

function BootScreen({ error, onRetry }: { error?: string; onRetry?: () => void }) {
  return <main className="boot-screen"><span className="brand-mark"><Bug size={21} /></span>{error ? <><strong>服务暂时不可用</strong><p>{error}</p><button className="secondary-button" onClick={onRetry}>重新连接</button></> : <span className="boot-loader" aria-label="正在连接服务" />}</main>
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [data, setData] = useState<WorkspaceData>({ projects: [] })
  const [currentProjectId, setCurrentProjectId] = useState('')
  const [section, setSection] = useState<Section>('issues')
  const [selectedIssueId, setSelectedIssueId] = useState<string | null>(null)
  const [showNewIssue, setShowNewIssue] = useState(false)
  const [showNewProject, setShowNewProject] = useState(false)
  const [projectToDelete, setProjectToDelete] = useState<Project | null>(null)
  const [issueToDelete, setIssueToDelete] = useState<Issue | null>(null)
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const [toast, setToast] = useState('')
  const [booting, setBooting] = useState(true)
  const [bootError, setBootError] = useState('')
  const [bootAttempt, setBootAttempt] = useState(0)
  const [refreshVersion, setRefreshVersion] = useState(0)
  const lastRefreshAtRef = useRef(Date.now())

  const currentProject = data.projects.find((project) => project.id === currentProjectId) ?? data.projects[0]
  const selectedIssue = currentProject?.issues.find((issue) => issue.id === selectedIssueId) ?? null

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
        const workspace = await api.workspace()
        if (cancelled) return
        setSession(result.user)
        setData(workspace)
        setCurrentProjectId(workspace.projects[0]?.id ?? '')
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
        const [sessionResult, workspace] = await Promise.all([api.me(), api.workspace()])
        if (cancelled) return
        if (!sessionResult.user) {
          setSession(null)
          setData({ projects: [] })
          setSelectedIssueId(null)
          setToast('登录已过期，请重新登录')
          return
        }
        setSession(sessionResult.user)
        setData(workspace)
        setCurrentProjectId((current) => workspace.projects.some((project) => project.id === current) ? current : (workspace.projects[0]?.id ?? ''))
        setSelectedIssueId((current) => !current || workspace.projects.some((project) => project.issues.some((issue) => issue.id === current)) ? current : null)
        lastRefreshAtRef.current = Date.now()
        setRefreshVersion((value) => value + 1)
      } catch (error) {
        if (cancelled) return
        if (error instanceof ApiError && error.status === 401) {
          setSession(null)
          setData({ projects: [] })
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
      setSelectedIssueId(null)
      setToast('登录已过期，请重新登录')
      return
    }
    setToast(error instanceof Error ? error.message : '操作失败')
  }

  async function authenticate(mode: 'login' | 'register', input: { email?: string; name: string; password: string }) {
    const authResult = mode === 'register'
      ? await api.register({ email: input.email ?? '', name: input.name, password: input.password })
      : await api.login({ name: input.name, password: input.password })
    const workspace = await api.workspace()
    setSession(authResult.user)
    setData(workspace)
    setCurrentProjectId(workspace.projects[0]?.id ?? '')
    lastRefreshAtRef.current = Date.now()
    setRefreshVersion((value) => value + 1)
  }

  async function logout() {
    try { await api.logout() } catch { /* local state still needs to close */ }
    setSession(null)
    setData({ projects: [] })
    setCurrentProjectId('')
    setSelectedIssueId(null)
    setSection('issues')
  }

  function switchProject(id: string) {
    setCurrentProjectId(id)
    setSelectedIssueId(null)
  }

  async function createProject(input: Pick<Project, 'name' | 'key' | 'description'>) {
    try {
      const result = await api.createProject(input)
      setData((previous) => ({ ...previous, projects: [...previous.projects, result.project] }))
      setCurrentProjectId(result.project.id)
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
      if (currentProjectId === project.id) setCurrentProjectId(remainingProjects[0]?.id ?? '')
      setSelectedIssueId(null)
      setProjectToDelete(null)
      setSection('issues')
      setToast(`项目 ${project.name} 已删除`)
    } catch (error) {
      showApiError(error)
      throw error
    }
  }

  function replaceIssue(updatedIssue: Issue) {
    setData((previous) => ({ ...previous, projects: previous.projects.map((project) => project.issues.some((issue) => issue.id === updatedIssue.id) ? { ...project, members: Array.from(new Set([...project.members, updatedIssue.lastModifiedBy])), issues: project.issues.map((issue) => issue.id === updatedIssue.id ? updatedIssue : issue) } : project) }))
  }

  async function createIssue(input: Omit<Issue, 'id' | 'createdAt' | 'updatedAt' | 'activities' | 'reporter' | 'lastModifiedBy'>) {
    if (!currentProject) return
    try {
      const result = await api.createIssue(currentProject.id, input)
      setData((previous) => ({ ...previous, projects: previous.projects.map((project) => project.id === currentProject.id ? { ...project, members: Array.from(new Set([...project.members, result.issue.lastModifiedBy])), issues: [result.issue, ...project.issues] } : project) }))
      setShowNewIssue(false)
      setSelectedIssueId(null)
      setSection('issues')
      setToast(`${result.issue.id} 已创建`)
    } catch (error) {
      showApiError(error)
    }
  }

  async function updateIssueField(issueId: string, field: 'status' | 'priority' | 'module', value: string, label: string) {
    try {
      const result = await api.updateIssue(issueId, { [field]: value })
      replaceIssue(result.issue)
      setToast(`${label}已更新`)
    } catch (error) { showApiError(error) }
  }

  async function saveIssueContent(title: string, description: string) {
    if (!selectedIssueId) return
    try {
      const result = await api.updateIssue(selectedIssueId, { title, description })
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
  if (!currentProject) return (
    <>
      <EmptyWorkspace session={session} section={section} refreshVersion={refreshVersion} onCreateProject={() => setShowNewProject(true)} onManageMembers={() => setSection((current) => current === 'members' ? 'issues' : 'members')} onLogout={() => void logout()} onToast={setToast} />
      {showNewProject && <NewProjectModal onClose={() => setShowNewProject(false)} onCreate={createProject} />}
      {toast && <Toast message={toast} />}
    </>
  )

  return (
    <div className="app-shell">
      <Sidebar
        session={session}
        projects={data.projects}
        currentProjectId={currentProject.id}
        section={section}
        mobileOpen={mobileNavOpen}
        onProjectChange={switchProject}
        onDeleteProject={setProjectToDelete}
        onSectionChange={setSection}
        onNewProject={() => setShowNewProject(true)}
        onLogout={() => void logout()}
        onCloseMobile={() => setMobileNavOpen(false)}
      />
      <div className="main-area">
        <Header project={currentProject} section={section} onMenu={() => setMobileNavOpen(true)} onNewIssue={() => setShowNewIssue(true)} />
        {section === 'overview' && <Overview project={currentProject} onOpenIssue={setSelectedIssueId} />}
        {section === 'issues' && <IssuesView project={currentProject} onOpenIssue={setSelectedIssueId} onNewIssue={() => setShowNewIssue(true)} onStatusChange={(issueId, status) => updateIssueField(issueId, 'status', status, '状态')} />}
        {section === 'activity' && <ActivityView project={currentProject} onOpenIssue={setSelectedIssueId} />}
        {section === 'members' && session.role === 'admin' && <MembersView currentUser={session} onToast={setToast} refreshVersion={refreshVersion} />}
      </div>
      {showNewProject && <NewProjectModal onClose={() => setShowNewProject(false)} onCreate={createProject} />}
      {showNewIssue && <NewIssueModal project={currentProject} currentUser={session.name} onClose={() => setShowNewIssue(false)} onCreate={createIssue} />}
      {selectedIssue && <IssueDrawer issue={selectedIssue} currentUser={session.name} onClose={() => setSelectedIssueId(null)} onFieldChange={(field, value, label) => updateIssueField(selectedIssue.id, field, value, label)} onSaveContent={saveIssueContent} onComment={addComment} onRequestDelete={() => setIssueToDelete(selectedIssue)} />}
      {projectToDelete && <ConfirmDeleteModal targetType="项目" targetName={projectToDelete.name} detail={`项目中的 ${projectToDelete.issues.length} 条缺陷和全部活动记录也会被删除。`} onClose={() => setProjectToDelete(null)} onConfirm={() => deleteProject(projectToDelete)} />}
      {issueToDelete && <ConfirmDeleteModal targetType="缺陷" targetName={`${issueToDelete.id} · ${issueToDelete.title}`} detail="该缺陷的评论、变更历史和上传图片也会被删除。" onClose={() => setIssueToDelete(null)} onConfirm={() => deleteIssue(issueToDelete)} />}
      {toast && <Toast message={toast} />}
    </div>
  )
}
