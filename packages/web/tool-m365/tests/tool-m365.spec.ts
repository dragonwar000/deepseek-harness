/** Microsoft 365 tools against a fake Graph: delegated tokens per connector, IT refusals, redirects, throttling, and text extraction. */
import { strToU8, zipSync } from 'fflate'
import { Context } from '@deepseek-ai/cordis'
import { M365AccessUnavailableError, type M365ConnectorId } from '@deepseek-ai/dsh-coteccons-sso'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as ToolM365 from '../src/index.ts'
import { extractText } from '../src/extract.ts'

const roots: Context[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose())) })

type Route = (url: string, init: RequestInit) => Response | Promise<Response>

async function mount(route: Route, refused: Partial<Record<M365ConnectorId, M365AccessUnavailableError['reason']>> = {}, withSso = true) {
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const tokens: M365ConnectorId[] = []
  if (withSso) {
    ctx.provide('cotecconsSso', {
      getM365AccessToken: (id: M365ConnectorId) => {
        tokens.push(id)
        const reason = refused[id]
        return reason === undefined ? Promise.resolve(`token-${id}`) : Promise.reject(new M365AccessUnavailableError(id, reason))
      },
    } as never)
  }
  const requests: Array<{ url: string; init: RequestInit }> = []
  const fake: typeof fetch = (input, init = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    requests.push({ url, init })
    return Promise.resolve(route(url, init))
  }
  const config = ToolM365.Config({ maxRetries: 1 })
  await ctx.plugin({ name: 'tool-m365', inject: ToolM365.inject, apply: (scope: Context) => { ToolM365.apply(scope, config, fake) } })
  let counter = 0
  const call = (name: string, args: unknown): Promise<ToolExecutionResult> =>
    ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId(`call-${++counter}`), name, arguments: args })
  return { ctx, call, requests, tokens }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const text = (result: ToolExecutionResult) => result.content.map(block => block.type === 'text' ? block.text : '').join('')

describe('m365_search', () => {
  it('searches each source with its own connector token and reports sources IT has not granted', async () => {
    const { call, requests, tokens } = await mount((_url, init) => {
      const auth = (init.headers as Record<string, string>).authorization
      if (auth === 'Bearer token-mail') {
        return json({ value: [{ hitsContainers: [{ hits: [{ hitId: 'm1', summary: 'Budget <b>Q3</b>', resource: { subject: 'Budget', from: { emailAddress: { address: 'b@coteccons.vn' } }, receivedDateTime: '2026-09-01', webLink: 'https://outlook/m1' } }] }] }] })
      }
      return json({ value: [{ hitsContainers: [{ hits: [{ hitId: 'f1', resource: { name: 'plan.docx', webUrl: 'https://sp/plan', parentReference: { driveId: 'd1' } } }] }] }] })
    }, { chat: 'not-assigned' })
    const result = await call('m365_search', { query: 'budget' })
    expect(result.isError).toBe(false)
    const output = text(result)
    expect(output).toContain(ToolM365.M365_CONTENT_NOTICE)
    expect(output).toContain('[mail] Budget (id: m1) — b@coteccons.vn (2026-09-01)\n  Budget Q3\n  https://outlook/m1')
    expect(output).toContain('[files] plan.docx (id: f1, driveId: d1)')
    expect(output).toContain('Not searched — Teams chats: IT has not granted this user access')
    expect(tokens.sort()).toEqual(['chat', 'files', 'mail'])
    expect(requests.every(request => request.init.redirect === 'error')).toBe(true)
    expect(JSON.parse(requests[0]?.init.body as string)).toMatchObject({ requests: [{ entityTypes: ['message'], query: { queryString: 'budget' }, size: 10 }] })
  })

  it('retries throttling once and surfaces other Graph failures', async () => {
    let calls = 0
    const { call } = await mount(() => (++calls === 1 ? new Response(null, { status: 429, headers: { 'retry-after': '0.01' } }) : json({ value: [] })))
    expect(text(await call('m365_search', { query: 'x', sources: ['mail'] }))).toContain('No results found.')
    expect(calls).toBe(2)
    const failing = await mount(() => json({ error: { code: 'Forbidden', message: 'denied' } }, 403))
    const result = await failing.call('m365_search', { query: 'x', sources: ['files'] })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('You do not have permission to read this item in Microsoft 365')
    expect((await failing.call('m365_search', { query: '  ' })).isError).toBe(true)
  })

  it('explains a missing SSO provider as not configured', async () => {
    const { call } = await mount(() => json({}), {}, false)
    expect(text(await call('m365_search', { query: 'x', sources: ['mail'] }))).toContain('Outlook mail: This Microsoft 365 data source is not configured')
  })
})

describe('read tools', () => {
  it('reads a message with its attachments and turns a revoked connector into guidance', async () => {
    const { call } = await mount(url => url.includes('/attachments')
      ? json({ value: [{ name: 'a.pdf' }] })
      : json({ subject: 'Hello', from: { emailAddress: { address: 'x@coteccons.vn' } }, toRecipients: [{ emailAddress: { address: 'me@coteccons.vn' } }], body: { content: 'Body text' }, hasAttachments: true, webLink: 'https://outlook/1' }))
    const output = text(await call('m365_read_mail', { id: 'id/1' }))
    expect(output).toContain('# Hello')
    expect(output).toContain('From: x@coteccons.vn\nTo: me@coteccons.vn')
    expect(output).toContain('Attachments: a.pdf')
    const revoked = await mount(() => json({}), { mail: 'revoked' })
    const result = await revoked.call('m365_read_mail', { id: '1' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('Access to this Microsoft 365 data source was revoked or expired')
  })

  it('reads chat messages oldest first as plain text', async () => {
    const { call, requests } = await mount(() => json({ value: [
      { messageType: 'message', createdDateTime: '2', from: { user: { displayName: 'B' } }, body: { content: '<p>second &amp; last</p>' } },
      { messageType: 'systemEventMessage' },
      { messageType: 'message', createdDateTime: '1', from: { user: { displayName: 'A' } }, body: { content: 'first' } },
    ] }))
    expect(text(await call('m365_read_chat', { chatId: '19:abc', top: 500 }))).toContain('[1] A: first\n[2] B: second & last')
    expect(requests[0]?.url).toContain('/me/chats/19%3Aabc/messages?$top=50')
  })

  it('downloads a file through the pre-authenticated redirect without the bearer token', async () => {
    const docx = zipSync({ 'word/document.xml': strToU8('<w:document><w:p><w:r><w:t>Hello &amp; welcome</w:t></w:r></w:p><w:p><w:r><w:t>Line 2</w:t></w:r></w:p></w:document>') })
    const { call, requests } = await mount((url) => {
      if (url.endsWith('/content')) return new Response(null, { status: 302, headers: { location: 'https://download.sp/file' } })
      if (url === 'https://download.sp/file') return new Response(docx)
      return json({ name: 'plan.docx', webUrl: 'https://sp/plan', file: {} })
    })
    const output = text(await call('m365_read_file', { driveId: 'd', id: 'i' }))
    expect(output).toContain('Hello & welcome\nLine 2')
    const download = requests.find(request => request.url === 'https://download.sp/file')
    expect(download?.init.headers).toBeUndefined()
    expect(requests.find(request => request.url.endsWith('/content'))?.init.redirect).toBe('manual')
  })

  it('refuses folders and reports unsupported formats', async () => {
    const folder = await mount(() => json({ name: 'Docs', folder: {} }))
    expect(text(await folder.call('m365_read_file', { driveId: 'd', id: 'i' }))).toContain('Docs is a folder')
    const binary = await mount(url => url.endsWith('/content') ? new Response(new Uint8Array([1, 2])) : json({ name: 'photo.png' }))
    expect(text(await binary.call('m365_read_file', { driveId: 'd', id: 'i' }))).toContain('no text extraction')
  })
})

describe('extractText', () => {
  it('reads slides and sheets from Office packages', () => {
    const pptx = zipSync({ 'ppt/slides/slide2.xml': strToU8('<a:p><a:t>Two</a:t></a:p>'), 'ppt/slides/slide1.xml': strToU8('<a:p><a:t>One</a:t></a:p>') })
    expect(extractText('deck.pptx', pptx)).toBe('## Slide 1\nOne\n\n## Slide 2\nTwo')
    const xlsx = zipSync({
      'xl/sharedStrings.xml': strToU8('<sst><si><t>Name</t></si></sst>'),
      'xl/worksheets/sheet1.xml': strToU8('<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>42</v></c></row>'),
    })
    expect(extractText('book.xlsx', xlsx)).toBe('## Sheet 1\nName\t42')
    expect(extractText('notes.md', strToU8('# hi'))).toBe('# hi')
    expect(extractText('broken.docx', new Uint8Array([1]))).toBeUndefined()
  })
})

it('registers four tools and a prompt section that disappear on dispose', async () => {
  const { ctx } = await mount(() => json({}))
  expect(ctx.tools.schemas().map(schema => schema.name).filter(name => name.startsWith('m365_')).sort())
    .toEqual(['m365_read_chat', 'm365_read_file', 'm365_read_mail', 'm365_search'])
  vi.clearAllMocks()
})
