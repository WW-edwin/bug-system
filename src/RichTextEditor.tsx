import { useEffect, useRef, useState } from 'react'
import { EditorContent, useEditor, type Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import { Bold, Code2, Heading2, Italic, List, ListOrdered, Quote, Redo2, Undo2 } from 'lucide-react'
import EvidenceUploadBox, { type EvidenceUploadBoxHandle } from './EvidenceUploadBox'
import { composeRichEvidenceContent, splitRichEvidenceContent, type EvidenceItem } from './issueDescription'

interface RichTextEditorProps {
  value: string
  onChange: (html: string) => void
  placeholder: string
  ariaLabel: string
  minHeight?: number
  uploadEvidence: (file: File, onProgress?: (progress: number) => void) => Promise<EvidenceItem>
}

function sameEvidence(left: EvidenceItem[], right: EvidenceItem[]) {
  return left.length === right.length && left.every((item, index) => item.url === right[index]?.url && item.name === right[index]?.name)
}

export default function RichTextEditor({ value, onChange, placeholder, ariaLabel, minHeight = 110, uploadEvidence }: RichTextEditorProps) {
  const initial = splitRichEvidenceContent(value)
  const editorRef = useRef<Editor | null>(null)
  const evidenceBoxRef = useRef<EvidenceUploadBoxHandle | null>(null)
  const evidenceRef = useRef<EvidenceItem[]>(initial.evidence)
  const [evidence, setEvidence] = useState<EvidenceItem[]>(initial.evidence)

  const editor = useEditor({
    extensions: [StarterKit, Placeholder.configure({ placeholder })],
    content: initial.contentHtml,
    editorProps: {
      attributes: { class: 'rich-editor-content', role: 'textbox', 'aria-label': ariaLabel },
      handlePaste: (_view, event) => {
        const files = Array.from(event.clipboardData?.items ?? [])
          .filter((item) => item.kind === 'file')
          .map((item) => item.getAsFile())
          .filter((file): file is File => Boolean(file))
        if (!files.length) return false
        event.preventDefault()
        void evidenceBoxRef.current?.addFiles(files)
        return true
      },
    },
    onUpdate: ({ editor: currentEditor }) => onChange(composeRichEvidenceContent(currentEditor.getHTML(), evidenceRef.current)),
  })

  useEffect(() => {
    editorRef.current = editor
    return () => { editorRef.current = null }
  }, [editor])

  useEffect(() => {
    if (!editor) return
    const next = splitRichEvidenceContent(value)
    if (editor.getHTML() !== next.contentHtml) editor.commands.setContent(next.contentHtml, { emitUpdate: false })
    if (!sameEvidence(evidenceRef.current, next.evidence)) {
      evidenceRef.current = next.evidence
      setEvidence(next.evidence)
    }
  }, [editor, value])

  function updateEvidence(nextEvidence: EvidenceItem[]) {
    evidenceRef.current = nextEvidence
    setEvidence(nextEvidence)
    onChange(composeRichEvidenceContent(editorRef.current?.getHTML() ?? '<p></p>', nextEvidence))
  }

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
    <div className="rich-editor" style={{ '--editor-min-height': `${minHeight}px` } as React.CSSProperties}>
      <div className="rich-editor-toolbar" aria-label="富文本工具栏">
        {tools.map((tool) => {
          const Icon = tool.icon
          return <button key={tool.title} type="button" className={tool.active ? 'active' : ''} onMouseDown={(event) => event.preventDefault()} onClick={tool.action} title={tool.title}><Icon size={15} /></button>
        })}
        <span className="toolbar-spacer" />
        <button type="button" disabled={!editor?.can().undo()} onMouseDown={(event) => event.preventDefault()} onClick={() => editor?.chain().focus().undo().run()} title="撤销"><Undo2 size={15} /></button>
        <button type="button" disabled={!editor?.can().redo()} onMouseDown={(event) => event.preventDefault()} onClick={() => editor?.chain().focus().redo().run()} title="重做"><Redo2 size={15} /></button>
      </div>
      <EditorContent editor={editor} />
      <div className="rich-editor-evidence">
        <EvidenceUploadBox ref={evidenceBoxRef} evidence={evidence} onChange={updateEvidence} uploadEvidence={uploadEvidence} compact />
      </div>
    </div>
  )
}
