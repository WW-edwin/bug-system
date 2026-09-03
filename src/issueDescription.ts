function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

export type EvidenceKind = 'image' | 'video' | 'file'

export interface EvidenceItem {
  url: string
  name: string
  type: string
  kind: EvidenceKind
  size?: number
}

export function toRichTextHtml(value: string) {
  if (!value) return '<p></p>'
  if (/<[a-z][\s\S]*>/i.test(value)) return value
  return value
    .split(/\n{2,}/)
    .map((block) => `<p>${escapeHtml(block).replaceAll('\n', '<br>')}</p>`)
    .join('')
}

function evidenceHtml(item: EvidenceItem, index: number) {
  const url = escapeHtml(item.url)
  const name = escapeHtml(item.name || `证据 ${index + 1}`)
  const type = escapeHtml(item.type || 'application/octet-stream')
  const size = item.size ? ` data-size="${item.size}"` : ''
  if (item.kind === 'image') return `<img src="${url}" alt="${name}" data-name="${name}" data-type="${type}"${size}>`
  if (item.kind === 'video') return `<video src="${url}" controls preload="metadata" data-name="${name}" data-type="${type}"${size}></video>`
  return `<a href="${url}" data-attachment="file" data-name="${name}" data-type="${type}"${size} download>${name}</a>`
}

export function composeEvidenceHtml(evidence: EvidenceItem[]) {
  return evidence.map(evidenceHtml).join('')
}

export function composeIssueDescription(description: string, evidence: EvidenceItem[]) {
  return `${composeEvidenceHtml(evidence)}${description.trim() ? toRichTextHtml(description.trim()) : '<p></p>'}`
}

function evidenceFromDocument(documentValue: Document) {
  const evidence: EvidenceItem[] = []
  documentValue.body.querySelectorAll('img, video, a[data-attachment="file"]').forEach((node, index) => {
    const tag = node.tagName.toLowerCase()
    const url = node.getAttribute(tag === 'a' ? 'href' : 'src')
    if (url && tag === 'img') evidence.push({ url, name: node.getAttribute('data-name') || node.getAttribute('alt') || `图片 ${index + 1}`, type: node.getAttribute('data-type') || 'image/jpeg', kind: 'image', size: Number(node.getAttribute('data-size')) || undefined })
    if (url && tag === 'video') evidence.push({ url, name: node.getAttribute('data-name') || `视频 ${index + 1}`, type: node.getAttribute('data-type') || 'video/mp4', kind: 'video', size: Number(node.getAttribute('data-size')) || undefined })
    if (url && tag === 'a') evidence.push({ url, name: node.getAttribute('data-name') || node.textContent?.trim() || `文件 ${index + 1}`, type: node.getAttribute('data-type') || 'application/octet-stream', kind: 'file', size: Number(node.getAttribute('data-size')) || undefined })
    node.remove()
  })
  return evidence
}

export function splitIssueDescription(value: string) {
  const documentValue = new DOMParser().parseFromString(toRichTextHtml(value), 'text/html')
  const evidence = evidenceFromDocument(documentValue)
  documentValue.body.querySelectorAll('br').forEach((lineBreak) => lineBreak.replaceWith('\n'))
  documentValue.body.querySelectorAll('li').forEach((item) => {
    item.prepend('• ')
    item.append('\n')
  })
  documentValue.body.querySelectorAll('p, h1, h2, h3, blockquote, pre, div').forEach((block) => block.append('\n'))
  const description = (documentValue.body.textContent ?? '')
    .replaceAll('\u00a0', ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { evidence, description }
}

export function splitRichEvidenceContent(value: string) {
  const documentValue = new DOMParser().parseFromString(toRichTextHtml(value), 'text/html')
  const evidence = evidenceFromDocument(documentValue)
  const contentHtml = documentValue.body.innerHTML.trim() || '<p></p>'
  return { evidence, contentHtml }
}

export function composeRichEvidenceContent(contentHtml: string, evidence: EvidenceItem[]) {
  return `${composeEvidenceHtml(evidence)}${contentHtml || '<p></p>'}`
}

export function hasRichEvidenceContent(value: string) {
  const parsed = splitRichEvidenceContent(value)
  const documentValue = new DOMParser().parseFromString(parsed.contentHtml, 'text/html')
  return Boolean(documentValue.body.textContent?.trim() || parsed.evidence.length)
}
