import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'

export async function prepareImageFile(file: File) {
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

export function ImagePreviewDialog({ src, onClose }: { src: string; onClose: () => void }) {
  useEffect(() => {
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [onClose])

  return createPortal(
    <div className="image-preview-layer" role="dialog" aria-modal="true" aria-label="图片预览">
      <button className="image-preview-backdrop" type="button" aria-label="点击遮罩关闭图片预览" onClick={onClose} />
      <figure className="image-preview-figure"><img src={src} alt="缺陷描述大图" /></figure>
      <button className="image-preview-close" type="button" onClick={onClose} title="关闭图片预览"><X size={21} /></button>
    </div>,
    document.body,
  )
}
