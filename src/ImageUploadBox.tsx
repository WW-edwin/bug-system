import { useRef, useState } from 'react'
import { ImagePlus, Images, LoaderCircle, Trash2 } from 'lucide-react'
import { ImagePreviewDialog, prepareImageFile } from './ImageTools'

interface ImageUploadBoxProps {
  images: string[]
  onChange: (images: string[]) => void
  uploadImage: (file: File) => Promise<string>
}

export default function ImageUploadBox({ images, onChange, uploadImage }: ImageUploadBoxProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [processing, setProcessing] = useState(false)
  const [error, setError] = useState('')
  const [previewSrc, setPreviewSrc] = useState<string | null>(null)

  async function addFiles(files: File[]) {
    if (!files.length || processing) return
    setProcessing(true)
    setError('')
    try {
      const sources = await Promise.all(files.map(async (file) => uploadImage(await prepareImageFile(file))))
      onChange([...images, ...sources])
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : '图片上传失败')
    } finally {
      setProcessing(false)
    }
  }

  function clipboardImages(items: DataTransferItemList | undefined) {
    return Array.from(items ?? [])
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file))
  }

  return (
    <>
      <div
        className={`image-upload-box ${processing ? 'processing' : ''}`}
        role="group"
        aria-label="问题截图"
        tabIndex={0}
        onPaste={(event) => {
          event.preventDefault()
          void addFiles(clipboardImages(event.clipboardData?.items))
        }}
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault()
          void addFiles(Array.from(event.dataTransfer.files).filter((file) => file.type.startsWith('image/')))
        }}
      >
        <div className="image-upload-toolbar">
          <span><Images size={16} />{images.length} 张图片</span>
          <button type="button" onClick={() => fileInputRef.current?.click()} disabled={processing} title="上传图片"><ImagePlus size={17} /></button>
          <input
            ref={fileInputRef}
            className="visually-hidden"
            type="file"
            accept="image/*"
            multiple
            tabIndex={-1}
            onChange={(event) => {
              void addFiles(Array.from(event.target.files ?? []))
              event.target.value = ''
            }}
          />
        </div>
        {images.length ? (
          <div className="image-upload-grid">
            {images.map((src, index) => (
              <figure key={`${src}-${index}`}>
                <button className="image-upload-preview" type="button" onClick={() => setPreviewSrc(src)} title="查看大图"><img src={src} alt={`问题截图 ${index + 1}`} /></button>
                <button className="image-upload-remove" type="button" onClick={() => onChange(images.filter((_, itemIndex) => itemIndex !== index))} title={`删除问题截图 ${index + 1}`}><Trash2 size={15} /></button>
              </figure>
            ))}
          </div>
        ) : (
          <div className="image-upload-empty"><Images size={24} /><span>暂无问题截图</span></div>
        )}
        {processing && <div className="image-upload-processing" aria-live="polite"><LoaderCircle size={15} />正在处理图片</div>}
        {error && <div className="image-upload-error" role="alert">{error}</div>}
      </div>
      {previewSrc && <ImagePreviewDialog src={previewSrc} onClose={() => setPreviewSrc(null)} />}
    </>
  )
}
