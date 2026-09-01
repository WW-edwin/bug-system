import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { EditorContent, useEditor, type Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Image from '@tiptap/extension-image'
import Placeholder from '@tiptap/extension-placeholder'
import {
  Bold,
  Code2,
  Heading2,
  ImagePlus,
  Italic,
  List,
  ListOrdered,
  Quote,
  Redo2,
  Undo2,
  X,
} from 'lucide-react'

interface RichTextEditorProps {
  value: string
  onChange: (html: string) => void
  placeholder: string
  ariaLabel: string
  minHeight?: number
  uploadImage: (file: File) => Promise<string>
}

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

export function toRichTextHtml(value: string) {
  if (!value) return '<p></p>'
  if (/<[a-z][\s\S]*>/i.test(value)) return value
  return value
    .split(/\n{2,}/)
    .map((block) => `<p>${escapeHtml(block).replaceAll('\n', '<br>')}</p>`)
    .join('')
}

async function prepareImageFile(file: File) {
  if (file.type === 'image/gif') return file
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw new Error('仅支持 JPG、PNG、GIF 和 WebP 图片')

  const image = await createImageBitmap(file)
  const maxEdge = 1280
  const ratio = Math.min(1, maxEdge / Math.max(image.width, image.height))
  const width = Math.max(1, Math.round(image.width * ratio))
  const height = Math.max(1, Math.round(image.height * ratio))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('无法处理图片')
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, width, height)
  context.drawImage(image, 0, 0, width, height)
  image.close()
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((result) => result ? resolve(result) : reject(new Error('无法处理图片')), 'image/jpeg', 0.78)
  })
  return new File([blob], `${file.name.replace(/\.[^.]+$/, '') || 'image'}.jpg`, { type: 'image/jpeg' })
}

export default function RichTextEditor({ value, onChange, placeholder, ariaLabel, minHeight = 150, uploadImage }: RichTextEditorProps) {
  const editorRef = useRef<Editor | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [processingImages, setProcessingImages] = useState(false)
  const [imageError, setImageError] = useState('')
  const [previewSrc, setPreviewSrc] = useState<string | null>(null)

  async function insertImageFiles(files: File[]) {
    if (!files.length) return
    setProcessingImages(true)
    setImageError('')
    try {
      const sources = await Promise.all(files.map(async (file) => uploadImage(await prepareImageFile(file))))
      sources.forEach((src) => editorRef.current?.chain().focus().setImage({ src }).run())
    } catch (error) {
      setImageError(error instanceof Error ? error.message : '图片上传失败')
    } finally {
      setProcessingImages(false)
    }
  }

  const editor = useEditor({
    extensions: [
      StarterKit,
      Image.configure({ allowBase64: true }),
      Placeholder.configure({ placeholder }),
    ],
    content: toRichTextHtml(value),
    editorProps: {
      attributes: {
        class: 'rich-editor-content',
        role: 'textbox',
        'aria-label': ariaLabel,
      },
      handlePaste: (_view, event) => {
        const files = Array.from(event.clipboardData?.items ?? [])
          .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
          .map((item) => item.getAsFile())
          .filter((file): file is File => Boolean(file))
        if (!files.length) return false
        event.preventDefault()
        void insertImageFiles(files)
        return true
      },
    },
    onUpdate: ({ editor: currentEditor }) => onChange(currentEditor.getHTML()),
  })

  useEffect(() => {
    editorRef.current = editor
    return () => {
      editorRef.current = null
    }
  }, [editor])

  useEffect(() => {
    if (!editor) return
    const nextValue = toRichTextHtml(value)
    if (editor.getHTML() !== nextValue) editor.commands.setContent(nextValue, { emitUpdate: false })
  }, [editor, value])

  useEffect(() => {
    if (!previewSrc) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') setPreviewSrc(null)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [previewSrc])

  const tools = [
    { title: '粗体', icon: Bold, active: editor?.isActive('bold'), action: () => editor?.chain().focus().toggleBold().run() },
    { title: '斜体', icon: Italic, active: editor?.isActive('italic'), action: () => editor?.chain().focus().toggleItalic().run() },
    { title: '二级标题', icon: Heading2, active: editor?.isActive('heading', { level: 2 }), action: () => editor?.chain().focus().toggleHeading({ level: 2 }).run() },
    { title: '无序列表', icon: List, active: editor?.isActive('bulletList'), action: () => editor?.chain().focus().toggleBulletList().run() },
    { title: '有序列表', icon: ListOrdered, active: editor?.isActive('orderedList'), action: () => editor?.chain().focus().toggleOrderedList().run() },
    { title: '引用', icon: Quote, active: editor?.isActive('blockquote'), action: () => editor?.chain().focus().toggleBlockquote().run() },
    { title: '代码块', icon: Code2, active: editor?.isActive('codeBlock'), action: () => editor?.chain().focus().toggleCodeBlock().run() },
  ]

  return (
    <>
    <div
      className={`rich-editor ${processingImages ? 'processing' : ''}`}
      style={{ '--editor-min-height': `${minHeight}px` } as React.CSSProperties}
      onClick={(event) => {
        const target = event.target
        if (target instanceof HTMLImageElement) {
          event.preventDefault()
          setPreviewSrc(target.src)
        }
      }}
    >
      <div className="rich-editor-toolbar" aria-label="富文本工具栏">
        {tools.map((tool) => {
          const Icon = tool.icon
          return <button key={tool.title} type="button" className={tool.active ? 'active' : ''} onMouseDown={(event) => event.preventDefault()} onClick={tool.action} title={tool.title}><Icon size={15} /></button>
        })}
        <span className="toolbar-separator" />
        <button type="button" onClick={() => fileInputRef.current?.click()} title="插入图片"><ImagePlus size={15} /></button>
        <span className="toolbar-spacer" />
        <button type="button" disabled={!editor?.can().undo()} onMouseDown={(event) => event.preventDefault()} onClick={() => editor?.chain().focus().undo().run()} title="撤销"><Undo2 size={15} /></button>
        <button type="button" disabled={!editor?.can().redo()} onMouseDown={(event) => event.preventDefault()} onClick={() => editor?.chain().focus().redo().run()} title="重做"><Redo2 size={15} /></button>
        <input
          ref={fileInputRef}
          className="visually-hidden"
          type="file"
          accept="image/*"
          multiple
          tabIndex={-1}
          onChange={(event) => {
            void insertImageFiles(Array.from(event.target.files ?? []))
            event.target.value = ''
          }}
        />
      </div>
      <EditorContent editor={editor} />
      {processingImages && <div className="rich-editor-processing">正在处理图片</div>}
      {imageError && <div className="rich-editor-error" role="alert">{imageError}</div>}
    </div>
    {previewSrc && createPortal(
      <div className="image-preview-layer" role="dialog" aria-modal="true" aria-label="图片预览">
        <button className="image-preview-backdrop" type="button" aria-label="点击遮罩关闭图片预览" onClick={() => setPreviewSrc(null)} />
        <figure className="image-preview-figure"><img src={previewSrc} alt="缺陷描述大图" /></figure>
        <button className="image-preview-close" type="button" onClick={() => setPreviewSrc(null)} title="关闭图片预览"><X size={21} /></button>
      </div>,
      document.body,
    )}
    </>
  )
}
