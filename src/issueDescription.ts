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

export function composeIssueDescription(description: string, images: string[]) {
  const imageHtml = images.map((src, index) => `<img src="${escapeHtml(src)}" alt="问题截图 ${index + 1}">`).join('')
  return `${imageHtml}${description.trim() ? toRichTextHtml(description.trim()) : '<p></p>'}`
}

export function splitIssueDescription(value: string) {
  const documentValue = new DOMParser().parseFromString(toRichTextHtml(value), 'text/html')
  const images = Array.from(documentValue.body.querySelectorAll('img'))
    .map((image) => image.getAttribute('src'))
    .filter((src): src is string => Boolean(src))
  documentValue.body.querySelectorAll('img').forEach((image) => image.remove())
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
  return { images, description }
}
