import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CheckCircle2, CircleAlert, FileText, Film, Files, Image as ImageIcon, Maximize2, Paperclip, Trash2, Upload, X } from 'lucide-react'
import { ImagePreviewDialog, prepareEvidenceFile, VideoPreviewDialog } from './ImageTools'
import type { EvidenceItem } from './issueDescription'

const acceptedEvidence = 'image/*,video/mp4,video/webm,video/quicktime,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.md,.zip,.7z,.rar'

export interface EvidenceUploadBoxHandle {
  addFiles: (files: File[]) => Promise<void>
}

interface EvidenceUploadBoxProps {
  evidence: EvidenceItem[]
  onChange: (evidence: EvidenceItem[]) => void
  uploadEvidence: (file: File, onProgress?: (progress: number) => void) => Promise<EvidenceItem>
  compact?: boolean
}

type UploadStatus = 'preparing' | 'uploading' | 'success' | 'error'

interface UploadTask {
  id: string
  name: string
  kind: EvidenceItem['kind']
  size: number
  previewUrl: string
  progress: number
  status: UploadStatus
  error?: string
  uploadedUrl?: string
}

interface UploadNotice {
  type: 'success' | 'warning' | 'error'
  message: string
}

interface VideoPreview {
  src: string
  name: string
  initialTime: number
  autoPlay: boolean
}

function formatBytes(value?: number) {
  if (!value) return ''
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

function fileKind(file: File): EvidenceItem['kind'] {
  if (file.type.startsWith('image/')) return 'image'
  if (file.type.startsWith('video/')) return 'video'
  return 'file'
}

function taskStatus(task: UploadTask) {
  if (task.status === 'preparing') return '正在处理'
  if (task.status === 'uploading') return '正在上传'
  if (task.status === 'success') return '上传成功'
  return '上传失败'
}

const EvidenceUploadBox = forwardRef<EvidenceUploadBoxHandle, EvidenceUploadBoxProps>(function EvidenceUploadBox({ evidence, onChange, uploadEvidence, compact = false }, ref) {
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const previewUrlsRef = useRef(new Set<string>())
  const [processing, setProcessing] = useState(false)
  const [tasks, setTasks] = useState<UploadTask[]>([])
  const [notice, setNotice] = useState<UploadNotice | null>(null)
  const [previewSrc, setPreviewSrc] = useState<string | null>(null)
  const [previewVideo, setPreviewVideo] = useState<VideoPreview | null>(null)

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(null), 2800)
    return () => window.clearTimeout(timer)
  }, [notice])

  useEffect(() => () => {
    previewUrlsRef.current.forEach((url) => URL.revokeObjectURL(url))
    previewUrlsRef.current.clear()
  }, [])

  function updateTask(id: string, next: Partial<UploadTask>) {
    setTasks((current) => current.map((task) => task.id === id ? { ...task, ...next } : task))
  }

  function removeTaskIds(ids: Set<string>) {
    setTasks((current) => current.filter((task) => {
      if (!ids.has(task.id)) return true
      URL.revokeObjectURL(task.previewUrl)
      previewUrlsRef.current.delete(task.previewUrl)
      return false
    }))
  }

  async function addFiles(files: File[]) {
    if (!files.length || processing) return
    const batch = files.map((file, index) => {
      const previewUrl = URL.createObjectURL(file)
      previewUrlsRef.current.add(previewUrl)
      return {
        file,
        task: {
          id: `${Date.now()}-${index}-${file.name}`,
          name: file.name,
          kind: fileKind(file),
          size: file.size,
          previewUrl,
          progress: 0,
          status: 'preparing' as const,
        },
      }
    })
    setProcessing(true)
    setNotice(null)
    setTasks((current) => {
      current.forEach((task) => {
        URL.revokeObjectURL(task.previewUrl)
        previewUrlsRef.current.delete(task.previewUrl)
      })
      return batch.map(({ task }) => task)
    })
    const results = await Promise.allSettled(batch.map(async ({ file, task }) => {
      try {
        const prepared = await prepareEvidenceFile(file)
        updateTask(task.id, { name: prepared.name, status: 'uploading', progress: 0 })
        const uploaded = await uploadEvidence(prepared, (progress) => updateTask(task.id, { status: 'uploading', progress }))
        updateTask(task.id, { status: 'success', progress: 100, uploadedUrl: uploaded.url })
        return { uploaded, taskId: task.id }
      } catch (uploadError) {
        const message = uploadError instanceof Error ? uploadError.message : '证据上传失败'
        updateTask(task.id, { status: 'error', error: message })
        throw uploadError
      }
    }))
    const fulfilled = results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : [])
    const uploaded = fulfilled.map((result) => result.uploaded)
    const successfulTaskIds = new Set(fulfilled.map((result) => result.taskId))
    const failedCount = results.length - uploaded.length
    if (uploaded.length) {
      onChange([...evidence, ...uploaded])
    }
    if (!failedCount) {
      setNotice({ type: 'success', message: `${uploaded.length} 项证据上传成功` })
      window.setTimeout(() => removeTaskIds(successfulTaskIds), 650)
    } else if (uploaded.length) {
      setNotice({ type: 'warning', message: `${uploaded.length} 项上传成功，${failedCount} 项上传失败` })
      window.setTimeout(() => removeTaskIds(successfulTaskIds), 650)
    } else {
      setNotice({ type: 'error', message: `${failedCount} 项证据上传失败，请检查后重试` })
    }
    setProcessing(false)
  }

  useImperativeHandle(ref, () => ({ addFiles }), [evidence, processing, uploadEvidence])

  function clipboardFiles(items: DataTransferItemList | undefined) {
    return Array.from(items ?? [])
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file))
  }

  const uploadedTaskUrls = new Set(tasks.flatMap((task) => task.uploadedUrl ? [task.uploadedUrl] : []))
  const evidenceUrls = new Set(evidence.map((item) => item.url))
  const visibleEvidence = evidence.map((item, index) => ({ item, index })).filter(({ item }) => !uploadedTaskUrls.has(item.url))
  const visibleCount = evidence.length + tasks.filter((task) => task.status !== 'error' && (!task.uploadedUrl || !evidenceUrls.has(task.uploadedUrl))).length

  return (
    <>
      <div
        className={`evidence-upload-box ${compact ? 'compact' : ''} ${processing ? 'processing' : ''}`}
        role="group"
        aria-label="证据"
        tabIndex={0}
        onPaste={(event) => {
          const files = clipboardFiles(event.clipboardData?.items)
          if (!files.length) return
          event.preventDefault()
          void addFiles(files)
        }}
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault()
          void addFiles(Array.from(event.dataTransfer.files))
        }}
      >
        <div className="evidence-upload-toolbar">
          <span><Paperclip size={16} />{visibleCount} 项证据</span>
          <button type="button" onClick={() => fileInputRef.current?.click()} disabled={processing} title="上传证据"><Upload size={17} /></button>
          <input
            ref={fileInputRef}
            className="visually-hidden"
            type="file"
            accept={acceptedEvidence}
            multiple
            tabIndex={-1}
            onChange={(event) => {
              void addFiles(Array.from(event.target.files ?? []))
              event.target.value = ''
            }}
          />
        </div>
        {(tasks.length || evidence.length) ? (
          <div className="evidence-upload-grid">
            {tasks.map((task) => (
              <article className={`evidence-item evidence-${task.kind} evidence-uploading-item ${task.status}`} key={task.id} aria-label={`${task.name} ${taskStatus(task)}`}>
                {task.kind === 'image' && <div className="evidence-image-preview evidence-local-preview"><img src={task.previewUrl} alt={task.name} /></div>}
                {task.kind === 'video' && <video src={task.previewUrl} muted preload="metadata" aria-label={task.name} />}
                {task.kind === 'file' && <div className="evidence-file-link evidence-file-pending"><FileText size={22} /><span><strong>{task.name}</strong>{task.size > 0 && <small>{formatBytes(task.size)}</small>}</span></div>}
                <div className="evidence-item-meta">
                  {task.kind === 'image' ? <ImageIcon size={13} /> : task.kind === 'video' ? <Film size={13} /> : <Files size={13} />}
                  <span title={task.name}>{task.name}</span>
                </div>
                <div className="evidence-inline-progress">
                  <div className="evidence-progress-copy"><span>{taskStatus(task)}</span><b>{task.status === 'preparing' ? '处理中' : `${task.progress}%`}</b></div>
                  <div className="evidence-progress-track" role="progressbar" aria-label={`${task.name} 上传进度`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={task.progress}>
                    <span style={{ width: `${task.progress}%` }} />
                  </div>
                  {task.error && <small title={task.error}>{task.error}</small>}
                </div>
                {task.status === 'error' && <button className="evidence-remove" type="button" onClick={() => removeTaskIds(new Set([task.id]))} title="移除失败记录"><X size={14} /></button>}
              </article>
            ))}
            {visibleEvidence.map(({ item, index }) => (
              <article className={`evidence-item evidence-${item.kind}`} key={`${item.url}-${index}`}>
                {item.kind === 'image' && <button className="evidence-image-preview" type="button" onClick={() => setPreviewSrc(item.url)} title="查看大图"><img src={item.url} alt={item.name} /></button>}
                {item.kind === 'video' && <><video src={item.url} controls preload="metadata" aria-label={item.name} /><button className="evidence-video-expand" type="button" onClick={(event) => {
                  const video = event.currentTarget.parentElement?.querySelector('video')
                  const autoPlay = Boolean(video && !video.paused)
                  const initialTime = video?.currentTime ?? 0
                  video?.pause()
                  setPreviewVideo({ src: item.url, name: item.name, initialTime, autoPlay })
                }} title={`放大播放 ${item.name}`}><Maximize2 size={14} /><span>放大</span></button></>}
                {item.kind === 'file' && <a className="evidence-file-link" href={item.url} download={item.name} title={`下载 ${item.name}`}><FileText size={22} /><span><strong>{item.name}</strong>{item.size && <small>{formatBytes(item.size)}</small>}</span></a>}
                <div className="evidence-item-meta">
                  {item.kind === 'image' ? <ImageIcon size={13} /> : item.kind === 'video' ? <Film size={13} /> : <Files size={13} />}
                  <span title={item.name}>{item.name}</span>
                </div>
                <button className="evidence-remove" type="button" onClick={() => onChange(evidence.filter((_, itemIndex) => itemIndex !== index))} title={`删除证据 ${index + 1}`}><Trash2 size={15} /></button>
              </article>
            ))}
          </div>
        ) : (
          <div className="evidence-upload-empty"><Paperclip size={24} /><span>暂无证据</span><small>支持图片、视频和常用文件</small></div>
        )}
      </div>
      {previewSrc && <ImagePreviewDialog src={previewSrc} onClose={() => setPreviewSrc(null)} />}
      {previewVideo && <VideoPreviewDialog {...previewVideo} onClose={() => setPreviewVideo(null)} />}
      {notice && createPortal(
        <div className={`upload-result-notice ${notice.type}`} role={notice.type === 'success' ? 'status' : 'alert'} aria-live="polite">
          <span>{notice.type === 'success' ? <CheckCircle2 size={19} /> : <CircleAlert size={19} />}</span>
          <strong>{notice.message}</strong>
          <button type="button" onClick={() => setNotice(null)} title="关闭上传提示"><X size={15} /></button>
        </div>,
        document.body,
      )}
    </>
  )
})

export default EvidenceUploadBox
