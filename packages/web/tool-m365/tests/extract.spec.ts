/** Text extraction from OneDrive/SharePoint file bytes: Word parts, Excel cell kinds, and XML entities. */
import { strToU8, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { extractText } from '../src/extract.ts'

describe('extractText', () => {
  it('decodes numeric character references in Office text runs', () => {
    const docx = zipSync({ 'word/document.xml': strToU8('<w:p><w:r><w:t xml:space="preserve">Caf&#233; &lt;3&gt; &quot;a&quot; &apos;b&apos; &amp;</w:t></w:r></w:p>') })
    expect(extractText('menu.DOCX', docx)).toBe('Café <3> "a" \'b\' &')
  })

  it('reads a Word package without a document part as empty text', () => {
    expect(extractText('empty.docx', zipSync({ 'docProps/core.xml': strToU8('<cp/>') }))).toBe('')
  })

  it('reads Excel sheets in order with shared, inline, empty, and literal cells', () => {
    const xlsx = zipSync({
      'xl/sharedStrings.xml': strToU8('<sst><si><t>Only</t></si></sst>'),
      'xl/worksheets/sheet10.xml': strToU8('<row r="1"><c r="A1"><v>10</v></c></row>'),
      'xl/worksheets/sheet2.xml': strToU8('<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>7</v></c>'
        + '<c r="C1" t="inlineStr"><is><t>Inline &amp; text</t></is></c><c r="D1"/><c r="E1" t="str"><v>a &lt; b</v></c></row>'),
    })
    expect(extractText('book.xlsx', xlsx)).toBe('## Sheet 2\nOnly\t\tInline & text\t\ta < b\n\n## Sheet 10\n10')
  })

  it('reads an Excel workbook without shared strings', () => {
    const xlsx = zipSync({ 'xl/worksheets/sheet1.xml': strToU8('<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>5</v></c></row>') })
    expect(extractText('numbers.xlsx', xlsx)).toBe('## Sheet 1\n\t5')
  })
})
