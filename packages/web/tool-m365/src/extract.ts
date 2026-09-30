/**
 * Plain-text extraction for files read from OneDrive and SharePoint: UTF-8 text formats pass through, and the
 * text runs of Word, PowerPoint, and Excel Open XML packages are read from their XML parts.
 */
import { strFromU8, unzipSync } from 'fflate'

const TEXT_EXTENSIONS = new Set(['txt', 'md', 'csv', 'tsv', 'json', 'xml', 'html', 'htm', 'yaml', 'yml', 'log', 'ts', 'js', 'py', 'sql'])

/**
 * Decode the XML character entities Office writes.
 * @param text - XML text content.
 * @returns decoded text.
 */
function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, '\'')
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&')
}

/**
 * Collect the text of every element with the given tag.
 * @param xml - XML document.
 * @param tag - qualified element name such as `w:t`.
 * @returns the decoded text runs.
 */
function runs(xml: string, tag: string): string[] {
  const pattern = new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>`, 'g')
  return [...xml.matchAll(pattern)].map(match => decodeEntities(match[1] ?? ''))
}

/**
 * Read Word paragraphs as lines.
 * @param files - unzipped package parts.
 * @returns document text.
 */
function word(files: Record<string, Uint8Array>): string {
  const part = files['word/document.xml']
  if (part === undefined) return ''
  return strFromU8(part).split(/<\/w:p>/).map(paragraph => runs(paragraph, 'w:t').join('')).filter(line => line.length > 0).join('\n')
}

/**
 * Read slide text in slide order.
 * @param files - unzipped package parts.
 * @returns one block per slide.
 */
function powerPoint(files: Record<string, Uint8Array>): string {
  const slides = Object.keys(files)
    .map(name => /^ppt\/slides\/slide(\d+)\.xml$/.exec(name))
    .filter(match => match !== null)
    .sort((a, b) => Number(a[1]) - Number(b[1]))
  return slides.map((match) => {
    const xml = strFromU8(files[match[0]] as Uint8Array)
    return `## Slide ${match[1]}\n${xml.split(/<\/a:p>/).map(paragraph => runs(paragraph, 'a:t').join('')).filter(line => line.length > 0).join('\n')}`
  }).join('\n\n')
}

/**
 * Read an Excel workbook's shared strings and inline cell values sheet by sheet.
 * @param files - unzipped package parts.
 * @returns one block per sheet with tab-separated rows.
 */
function excel(files: Record<string, Uint8Array>): string {
  const sharedPart = files['xl/sharedStrings.xml']
  const shared = sharedPart === undefined
    ? []
    : strFromU8(sharedPart).split(/<\/si>/).slice(0, -1).map(item => runs(item, 't').join(''))
  const sheets = Object.keys(files)
    .map(name => /^xl\/worksheets\/sheet(\d+)\.xml$/.exec(name))
    .filter(match => match !== null)
    .sort((a, b) => Number(a[1]) - Number(b[1]))
  return sheets.map((match) => {
    const xml = strFromU8(files[match[0]] as Uint8Array)
    const rows = [...xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)].map((row) => {
      const cells = [...(row[1] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)].map((cell) => {
        const attributes = cell[1] ?? ''
        const body = cell[2] ?? ''
        const value = /<v>([^<]*)<\/v>/.exec(body)?.[1]
        if (/\bt="s"/.test(attributes) && value !== undefined) return shared[Number(value)] ?? ''
        if (/\bt="inlineStr"/.test(attributes)) return runs(body, 't').join('')
        return value === undefined ? '' : decodeEntities(value)
      })
      return cells.join('\t')
    })
    return `## Sheet ${match[1]}\n${rows.join('\n')}`
  }).join('\n\n')
}

/**
 * Extract readable text from a file's bytes.
 * @param name - file name; its extension selects the format.
 * @param bytes - file content.
 * @returns the text, or `undefined` when the format has no text extraction.
 */
export function extractText(name: string, bytes: Uint8Array): string | undefined {
  const extension = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  if (TEXT_EXTENSIONS.has(extension)) return new TextDecoder().decode(bytes)
  if (!['docx', 'pptx', 'xlsx'].includes(extension)) return undefined
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(bytes)
  } catch (_corrupt: unknown) {
    // A damaged or encrypted Office package has no readable parts; report it as unsupported.
    return undefined
  }
  if (extension === 'docx') return word(files)
  if (extension === 'pptx') return powerPoint(files)
  return excel(files)
}
