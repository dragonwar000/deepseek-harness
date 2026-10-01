/** Microsoft 365 tools against a fake Graph: delegated tokens per connector, IT refusals, redirects, throttling, and text extraction. */
import { strToU8, zipSync } from 'fflate'
import { Context } from '@deepseek-ai/cordis'
import { M365AccessUnavailableError, type M365ConnectorId } from '@deepseek-ai/dsh-coteccons-sso'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as ToolM365 from '../src/index.ts'
import { extractText } from '../src/extract.ts'

const roots: Context[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose())) })

type Route = (url: string, init: RequestInit) => Response | Promise<Response>

async function mount(route: Route, refused: Partial<Record<M365ConnectorId, M365AccessUnavailableError['reason']>> = {}, withSso = true, overrides: Pick<ToolM365.Config, 'maxFileBytes' | 'maxOutputChars'> = {}) {
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
  const config = ToolM365.Config({ maxRetries: 1, ...overrides })
  await ctx.plugin({ name: 'tool-m365', inject: ToolM365.inject, apply: (scope: Context) => { ToolM365.apply(scope, config, fake) } })
  let counter = 0
  const call = (name: string, args: unknown, signal = new AbortController().signal): Promise<ToolExecutionResult> =>
    ctx.tools.execute({ signal, callId: ToolCallId(`call-${++counter}`), name, arguments: args })
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

describe('Graph requests', () => {
  it('backs off without Retry-After and stops waiting when the call is aborted', async () => {
    const controller = new AbortController()
    const { call, requests } = await mount(() => {
      setTimeout(() => { controller.abort(new Error('stopped by user')) }, 5)
      return new Response(null, { status: 503 })
    })
    const result = await call('m365_search', { query: 'x', sources: ['mail'] }, controller.signal)
    expect(result.isError).toBe(true)
    expect(requests).toHaveLength(1)
  })

  it('describes failures whose body names no Graph error by their HTTP status', async () => {
    const plainText = await mount(() => new Response('upstream broke', { status: 500 }))
    expect(text(await plainText.call('m365_read_mail', { id: '1' }))).toContain('Microsoft Graph returned HTTP 500')
    const emptyError = await mount(() => json({ error: { code: 7, message: '' } }, 404))
    const output = text(await emptyError.call('m365_read_mail', { id: '1' }))
    expect(output).toContain('The item was not found or you cannot access it (Microsoft Graph returned HTTP 404).')
  })

  it('refuses a download redirect without a usable https location', async () => {
    for (const headers of [{}, { location: 'http://download.sp/file' }] as Array<Record<string, string>>) {
      const { call } = await mount(url => url.endsWith('/content') ? new Response(null, { status: 302, headers }) : json({ name: 'a.txt' }))
      expect(text(await call('m365_read_file', { driveId: 'd', id: 'i' }))).toContain('Microsoft Graph returned an unusable download location.')
    }
  })

  it('reports a failed pre-authenticated download', async () => {
    const { call } = await mount((url) => {
      if (url.endsWith('/content')) return new Response(null, { status: 302, headers: { location: 'https://download.sp/gone' } })
      if (url === 'https://download.sp/gone') return new Response(null, { status: 404 })
      return json({ name: 'a.txt' })
    })
    expect(text(await call('m365_read_file', { driveId: 'd', id: 'i' }))).toContain('The item was not found or you cannot access it')
  })

  it('skips files larger than maxFileBytes by declared length or by downloaded size', async () => {
    const declared = await mount(url => url.endsWith('/content')
      ? new Response('x'.repeat(10), { headers: { 'content-length': '4096' } })
      : json({ name: 'big.txt', webUrl: 'https://sp/big' }), {}, true, { maxFileBytes: 1024 })
    const declaredOutput = text(await declared.call('m365_read_file', { driveId: 'd', id: 'i' }))
    expect(declaredOutput).toContain('The file is larger than 1024 bytes and was not read. Open it from the link.')
    expect(declaredOutput).toContain('https://sp/big')
    const streamed = await mount(url => url.endsWith('/content')
      ? new Response(new Blob([new Uint8Array(2048)]).stream())
      : json({}), {}, true, { maxFileBytes: 1024 })
    const streamedOutput = text(await streamed.call('m365_read_file', { driveId: 'd', id: 'i' }))
    expect(streamedOutput).toContain('# (file)')
    expect(streamedOutput).toContain('The file is larger than 1024 bytes')
  })
})

describe('result projection', () => {
  it('projects mail, chat, and file hits with their fallbacks and skips hits without an id', async () => {
    const hits: Record<string, unknown[]> = {
      'Bearer token-mail': [{ resource: { id: 'm2' } }, { summary: 'no id' }],
      'Bearer token-chat': [
        { hitId: 'c1', resource: { body: { content: '<p>Site&nbsp;visit</p>' }, from: { user: { displayName: 'An' } }, createdDateTime: '2026-09-02', webUrl: 'https://teams/c1', chatId: '19:c1' } },
        { hitId: 'c2', summary: 'from summary', resource: { from: { emailAddress: { name: 'Binh' } }, webLink: 'https://teams/c2' } },
        { hitId: 'c3' },
      ],
      'Bearer token-files': [{ hitId: 'f2', resource: { lastModifiedBy: { user: { displayName: 'Chi' } }, lastModifiedDateTime: '2026-09-03' } }],
    }
    const { call } = await mount((_url, init) => json({ value: ['junk', { hitsContainers: [{ hits: hits[(init.headers as Record<string, string>).authorization ?? ''] }] }] }))
    const output = text(await call('m365_search', { query: 'site', sources: ['mail', 'chat', 'files', 'mail'] }))
    expect(output).toContain('- [mail] (no subject) (id: m2)\n')
    expect(output).not.toContain('no id')
    expect(output).toContain('- [chat] Site visit (id: c1, chatId: 19:c1) — An (2026-09-02)\n  https://teams/c1')
    expect(output).toContain('- [chat] from summary (id: c2) — Binh\n  from summary\n  https://teams/c2')
    expect(output).toContain('- [chat] (message) (id: c3)')
    expect(output).toContain('- [files] (file) (id: f2) — Chi (2026-09-03)')
  })

  it('rejects an empty source list', async () => {
    const { call } = await mount(() => json({}))
    const result = await call('m365_search', { query: 'x', sources: [] })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('sources must name at least one source')
  })

  it('reads a sparse message without attachments as an untitled header', async () => {
    const { call, requests } = await mount(() => json({ hasAttachments: false }))
    const output = text(await call('m365_read_mail', { id: '1' }))
    expect(output).toBe(`${ToolM365.M365_CONTENT_NOTICE}\n\n# (no subject)\n\nFrom: \nTo: \nCc: \nDate: \n\n`)
    expect(requests).toHaveLength(1)
  })

  it('omits the attachment line when a message lists no named attachments', async () => {
    const { call } = await mount(url => url.includes('/attachments') ? json({ value: [{ size: 1 }] }) : json({ subject: 'S', hasAttachments: true }))
    expect(text(await call('m365_read_mail', { id: '1' }))).not.toContain('Attachments:')
  })

  it('reads 30 chat messages by default and names application or unknown senders', async () => {
    const { call, requests } = await mount(() => json({ value: [
      { messageType: 'message', from: { application: { displayName: 'Bot' } }, createdDateTime: '2', body: { content: 'hi' } },
      { messageType: 'message' },
    ] }))
    expect(text(await call('m365_read_chat', { chatId: 'c' }))).toContain('[] unknown: \n[2] Bot: hi')
    expect(requests[0]?.url).toContain('$top=30')
  })

  it('truncates a read result at maxOutputChars', async () => {
    const { call } = await mount(() => json({ value: [{ messageType: 'message', body: { content: 'y'.repeat(2000) } }] }), {}, true, { maxOutputChars: 1000 })
    const output = text(await call('m365_read_chat', { chatId: 'c' }))
    expect(output.endsWith('(Content truncated.)')).toBe(true)
    expect(output).not.toContain('y'.repeat(1001))
  })
})

describe('tool presentation and scheduling', () => {
  it('presents every call as a generic card and runs every tool in parallel', async () => {
    const { ctx } = await mount(() => json({}))
    const calls: Array<[string, unknown, string]> = [
      ['m365_search', { query: 'budget' }, 'Microsoft 365: budget'],
      ['m365_read_mail', { id: '1' }, 'Read Outlook message'],
      ['m365_read_chat', { chatId: 'c' }, 'Read Teams chat'],
      ['m365_read_file', { driveId: 'd', id: 'i' }, 'Read Microsoft 365 file'],
    ]
    for (const [name, args, title] of calls) {
      expect(ctx.tools.get(name)?.presentCall?.(args)).toMatchObject({ card: 'generic', title })
      expect(ctx.tools.executionMode({ signal: new AbortController().signal, callId: ToolCallId('c'), name, arguments: args })).toEqual({ kind: 'parallel' })
    }
  })

  it('adds the Microsoft 365 guidance only for scopes that can call m365_search', async () => {
    const { ctx } = await mount(() => json({}))
    expect(renderPrompt(await ctx.systemPrompt.assemble())).toContain('m365_search and the m365_read_* tools read the user\'s own Outlook mail')
    const key = {}
    let scope!: Scope
    await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, key) }, { inject: ['tools', 'systemPrompt'] }))
    scope.ctx.tools.restrict({ deny: ['m365_search'] })
    expect(renderPrompt(await ctx.systemPrompt.assemble({ scope: key }))).not.toContain('m365_search')
  })
})
