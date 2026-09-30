/**
 * Prompt-level tool-call emulation. The preamble is pinned verbatim because it is model-visible
 * text, and every rejection path is exercised because model output is untrusted.
 */
import type { StreamChunk, ToolSchema } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import {
  buildToolPreamble,
  correctionNotice,
  PREAMBLE_TEMPLATE,
  readToolCall,
  ReplyScanner,
  resolveToolPlan,
  TOOL_CALL_FENCE,
  TOOL_CALL_LIMIT,
  TOOL_CALL_MALFORMED,
  TOOL_CALL_TOO_LARGE,
  TOOL_CALL_TRUNCATED,
  TOOL_CALL_UNFENCED,
  TOOL_CALL_UNKNOWN_TOOL,
  ToolCallEmulator,
} from '../src/emulate.ts'
import type { EmulationLimits, ReplySegment, ToolPlan } from '../src/emulate.ts'

const READ_FILE: ToolSchema = {
  name: 'read_file',
  description: 'Read a file from the workspace.',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
}

const BASH: ToolSchema = {
  name: 'bash',
  description: 'Run a shell command.',
  parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
}

const CONFIG = {
  toolCalls: 'prompt',
  toolCallMaxCalls: 4,
  toolCallMaxBytes: 32_768,
  toolCallRetries: 1,
  toolCallLenient: true,
} as const

const LIMITS: EmulationLimits = { maxCalls: 4, maxBytes: 32_768 }

/** The prompt plan a test emulator reads a reply against. */
function plan(tools: readonly ToolSchema[] = [READ_FILE], limits: EmulationLimits = LIMITS, lenient = true) {
  return {
    kind: 'prompt',
    tools,
    preamble: buildToolPreamble(tools, limits),
    limits,
    retries: 1,
    lenient,
  } as const satisfies Extract<ToolPlan, { kind: 'prompt' }>
}

/** A scanner reading a reply strictly against the given bounds, with both test tools declared. */
function scan(limits: EmulationLimits = LIMITS): ReplyScanner {
  return new ReplyScanner({ limits, tools: [READ_FILE, BASH], lenient: false })
}

/** The same scanner with lenient reading on, which is the route's default. */
function scanLeniently(limits: EmulationLimits = LIMITS): ReplyScanner {
  return new ReplyScanner({ limits, tools: [READ_FILE, BASH], lenient: true })
}

/** Feed a reply through a scanner one character at a time, as the slowest stream would deliver it. */
function scanByCharacter(text: string, scanner: ReplyScanner): readonly ReplySegment[] {
  return [...[...text].flatMap(char => scanner.push(char)), ...scanner.finish()]
}

/** The text a run of segments hands over, joined. */
function textOf(segments: readonly ReplySegment[]): string {
  return segments.map(segment => segment.kind === 'text' ? segment.text : '').join('')
}

/** The tools the recorded session declared that its rejected reply called. */
const READ: ToolSchema = {
  name: 'read',
  description: 'Read a file.',
  parameters: { type: 'object', properties: { file_path: { type: 'string' }, limit: { type: 'number' } }, required: ['file_path'] },
}

/**
 * The reply a real `opus` run returned through the CLI: three calls, each a bare object followed by
 * a closing fence, with no `dsh-tool-call` opener line. Whitespace, member spacing, and fences are
 * as recorded; only the checkout prefix of the paths is shortened to `/repo`.
 */
const RECORDED_REPLY = '\n{"name": "read", "arguments": {"file_path": "/repo/packages/web/tool-web/src/search.ts"}}\n```\n\n\n'
  + '{"name": "read", "arguments": {"file_path": "/repo/packages/credentials/coteccons-sso-msal/tests/sso.spec.ts", "limit": 90}}\n```\n\n\n'
  + '{"name": "bash", "arguments": {"command": "git status --short | head; git log --oneline -1; ls packages/client/ui-settings-coteccons-sso/src/client; wc -l packages/client/ui-settings-coteccons-sso/src/client/*", "description": "Check git state and UI files", "workdir": "/repo"}}\n```'

/** The deltas the CLI delivered the first recorded call in, which split it mid-member. */
const RECORDED_DELTAS = ['\n{', '"name":', ' "read", "arguments":', ' {"file_path": "/', 'repo', '/packages/web/', 'tool-web/src/search.ts"}}\n```']

/** Feed one reply through an emulator as a single CLI text block. */
function reply(text: string, emulator: ToolCallEmulator): readonly StreamChunk[] {
  const chunks: StreamChunk[] = [
    ...emulator.push({ type: 'block-start', index: 0, blockType: 'text' }),
    ...emulator.push({ type: 'text-delta', index: 0, text }),
    ...emulator.push({ type: 'block-end', index: 0, block: { type: 'text', text } }),
    ...emulator.push({ type: 'usage', usage: { inputTokens: 1, outputTokens: 2 } }),
    ...emulator.push({ type: 'finish', reason: { kind: 'stop' } }),
  ]
  return chunks
}

describe('resolveToolPlan', () => {
  it('needs no emulation for a request that declares no tools', () => {
    expect(resolveToolPlan(undefined, CONFIG)).toEqual({ kind: 'none' })
    expect(resolveToolPlan([], CONFIG)).toEqual({ kind: 'none' })
  })

  it('refuses instead of emulating when the deployment asked for the refusal', () => {
    expect(resolveToolPlan([READ_FILE], { ...CONFIG, toolCalls: 'refuse' })).toEqual({ kind: 'refuse' })
  })

  it('carries the preamble, the declared tools, the stated bounds, and the retry budget', () => {
    const resolved = resolveToolPlan([READ_FILE, BASH], CONFIG)
    expect(resolved.kind).toBe('prompt')
    if (resolved.kind !== 'prompt') return
    expect(resolved.tools).toEqual([READ_FILE, BASH])
    expect(resolved.limits).toEqual({ maxCalls: 4, maxBytes: 32_768 })
    expect(resolved.retries).toBe(1)
    expect(resolved.lenient).toBe(true)
    expect(resolveToolPlan([READ_FILE], { ...CONFIG, toolCallLenient: false })).toMatchObject({ lenient: false })
    expect(resolved.preamble).toBe(buildToolPreamble([READ_FILE, BASH], LIMITS))
  })
})

describe('buildToolPreamble', () => {
  it('renders the pinned wording the model reads, verbatim', () => {
    // Pinned on purpose: this is model-visible text, and the wording is what makes an emulated call
    // parseable. Changing it changes what the model sees, so it changes PREAMBLE_TEMPLATE too.
    const report: ToolSchema = {
      name: 'write_report',
      description: 'Write a report.',
      // `minItems` is a keyword the type notation cannot state, so this schema is listed verbatim.
      parameters: { type: 'object', properties: { rows: { type: 'array', minItems: 1 } } },
    }
    expect(buildToolPreamble([READ_FILE, report], LIMITS)).toBe([
      '## Tool calls',
      '',
      'The harness running this conversation executes tools for you, and reads your calls out of your reply text. Only the tools listed below exist.',
      '',
      'To call a tool, emit a fenced block whose info string is `dsh-tool-call`, holding one JSON object with the members `name` and `arguments`:',
      '',
      '```dsh-tool-call',
      '{"name": "<a tool name from the list below>", "arguments": {}}',
      '```',
      '',
      'The harness rejects a reply that breaks any of these, names which one, and asks you again:',
      '',
      '- The block opens with the line ```dsh-tool-call and closes with the line ```. It is the only way to call a tool: a JSON object outside such a block is not a call, and neither are XML tags such as `<invoke>` or `<function_calls>`.',
      '- `name` is spelled exactly as listed below. No other tool exists.',
      '- `arguments` is a JSON object. The harness passes it to the tool, which checks it against the type listed below and reports a violation to you.',
      '- Each block holds that one JSON object and nothing else, under 32768 bytes.',
      '- At most 4 blocks in one reply.',
      '- A reply that calls a tool contains no text outside its blocks, and ends at the closing fence of its last block.',
      '- Never write a tool result yourself. The harness runs the tool and sends you its real result in the next message; anything you write after a block is discarded.',
      '',
      'When no tool is needed, reply with ordinary text and no such block.',
      '',
      '### Tools',
      '',
      'Each tool lists the type of its `arguments`: `?` marks a member that may be left out, and the text after `//` describes the member.',
      '',
      '#### read_file',
      '',
      'Read a file from the workspace.',
      '',
      'arguments: {',
      '  path: string',
      '}',
      '',
      '#### write_report',
      '',
      'Write a report.',
      '',
      'arguments, as JSON Schema: {"type":"object","properties":{"rows":{"type":"array","minItems":1}}}',
    ].join('\n'))
    expect(PREAMBLE_TEMPLATE).toBe('dsh-tool-call/2')
    expect(TOOL_CALL_FENCE).toBe('dsh-tool-call')
  })

  it('states the bounds it will enforce, so a rejection is never a surprise', () => {
    const text = buildToolPreamble([READ_FILE], { maxCalls: 2, maxBytes: 4_096 })
    expect(text).toContain('under 4096 bytes')
    expect(text).toContain('At most 2 blocks')
  })

  it('shows the model no fenced block except the one it must write', () => {
    const text = buildToolPreamble([READ_FILE, BASH], LIMITS)
    expect(text.match(/^```.*$/gmu)).toEqual(['```dsh-tool-call', '```'])
  })

  it('lists every declared tool in request order', () => {
    const text = buildToolPreamble([BASH, READ_FILE], LIMITS)
    expect(text.indexOf('#### bash')).toBeLessThan(text.indexOf('#### read_file'))
  })
})

describe('correctionNotice', () => {
  it('tells the model no tool ran and what to do instead', () => {
    expect(correctionNotice({ code: TOOL_CALL_MALFORMED, message: 'It was not JSON.' })).toBe(
      'Your previous reply was rejected and no tool ran. It was not JSON. Answer the last message again, following the tool-call format exactly.',
    )
  })
})

describe('ReplyScanner', () => {
  it('streams plain text and holds back only what could still open a fence', () => {
    const scanner = scan()
    expect(scanner.push('Hello ')).toEqual([{ kind: 'text', text: 'Hello ' }])
    // The trailing backticks could still become the fence opener, so they wait.
    expect(scanner.push('there``')).toEqual([{ kind: 'text', text: 'there' }])
    expect(scanner.push('x')).toEqual([{ kind: 'text', text: '``x' }])
    expect(scanner.finish()).toEqual([])
    expect(scanner.failure).toBeUndefined()
  })

  it('releases a held partial fence when the reply ends', () => {
    const scanner = scan()
    expect(scanner.push('done ``')).toEqual([{ kind: 'text', text: 'done ' }])
    expect(scanner.finish()).toEqual([{ kind: 'text', text: '``' }])
  })

  it('splits a fenced call out of the surrounding prose', () => {
    const scanner = scan()
    const segments = [
      ...scanner.push('Let me read it.\n\n```dsh-tool-call\n{"name":"read_file","arg'),
      ...scanner.push('uments":{"path":"/etc/hosts"}}\n```\nDone.'),
      ...scanner.finish(),
    ]
    expect(segments).toEqual([
      { kind: 'text', text: 'Let me read it.\n\n' },
      { kind: 'call', raw: '{"name":"read_file","arguments":{"path":"/etc/hosts"}}', lenient: false },
      { kind: 'text', text: '\nDone.' },
    ])
  })

  it('reads two consecutive calls from one reply', () => {
    const scanner = scan()
    const segments = scanner.push(
      '```dsh-tool-call\n{"name":"read_file","arguments":{"path":"a"}}\n```\n\n'
      + '```dsh-tool-call\n{"name":"read_file","arguments":{"path":"b"}}\n```',
    )
    expect(segments.filter(segment => segment.kind === 'call')).toHaveLength(2)
  })

  it('keeps collecting past a fence inside a string argument', () => {
    const scanner = scan()
    const raw = '{"name":"read_file","arguments":{"path":"x","body":"```js\\ncode\\n```"}}'
    const segments = scanner.push(`\`\`\`dsh-tool-call\n${raw}\n\`\`\``)
    expect(segments).toEqual([{ kind: 'call', raw, lenient: false }])
  })

  it('names a reply that ended inside an unterminated block', () => {
    const scanner = scan()
    scanner.push('```dsh-tool-call\n{"name":"read_file","argu')
    expect(scanner.finish()).toEqual([])
    expect(scanner.failure?.code).toBe(TOOL_CALL_TRUNCATED)
    expect(scanner.failure?.message).toMatch(/unterminated tool-call block/)
    // A scanner that already failed produces nothing more rather than guessing.
    expect(scanner.push('more')).toEqual([])
    expect(scanner.finish()).toEqual([])
  })

  it('names a closed block whose contents never became one JSON object', () => {
    const scanner = scan()
    scanner.push('```dsh-tool-call\nname = read_file\n```')
    scanner.finish()
    expect(scanner.failure?.code).toBe(TOOL_CALL_MALFORMED)
    expect(scanner.failure?.message).toMatch(/did not hold one JSON object/)
  })

  it('names a block that outgrew the byte cap instead of buffering without end', () => {
    const scanner = scan({ maxCalls: 4, maxBytes: 32 })
    scanner.push(`\`\`\`dsh-tool-call\n{"name":"read_file","arguments":{"path":"${'x'.repeat(64)}"`)
    expect(scanner.failure?.code).toBe(TOOL_CALL_TOO_LARGE)
    expect(scanner.failure?.message).toMatch(/exceeded 32 bytes/)
  })

  it('names a reply carrying more blocks than the cap allows', () => {
    const scanner = scan({ maxCalls: 1, maxBytes: 32_768 })
    const block = '```dsh-tool-call\n{"name":"read_file","arguments":{}}\n```\n'
    const segments = scanner.push(block + block)
    expect(segments.filter(segment => segment.kind === 'call')).toHaveLength(1)
    expect(scanner.failure?.code).toBe(TOOL_CALL_LIMIT)
    expect(scanner.failure?.message).toMatch(/more than 1 tool-call blocks/)
  })

  it('rejects a call written as a bare object, instead of releasing it as text', () => {
    const scanner = scan()
    expect(scanner.push('{"name": "read_file", "arguments": {"path": "/a"}}')).toEqual([])
    expect(scanner.finish()).toEqual([])
    expect(scanner.failure).toEqual({
      code: TOOL_CALL_UNFENCED,
      message: 'A call to `read_file` was written outside a tool-call block: {"name": "read_file", "arguments": {"path": "/a"}}. '
        + 'The harness reads a call only from a block that opens with the line ```dsh-tool-call and closes with the line ```.',
    })
  })

  it('rejects a call whose block lost its opener line, and takes the closing fence with it', () => {
    const scanner = scan()
    const segments = [...scanner.push('\n{"name":"bash","arguments":{"command":"ls"}}\n```\n'), ...scanner.finish()]
    expect(segments).toEqual([{ kind: 'text', text: '\n' }])
    expect(scanner.failure?.code).toBe(TOOL_CALL_UNFENCED)
    expect(scanner.failure?.message).toContain('{"name":"bash","arguments":{"command":"ls"}} ```.')
  })

  it.each(['json', '', 'tool_call', 'python'])('rejects a call inside a block opened with the info string "%s"', (info) => {
    const scanner = scan()
    const segments = scanByCharacter(`\`\`\`${info}\n{"name":"read_file","arguments":{}}\n\`\`\``, scanner)
    // The opener line is held with the object, so nothing was released and a correction run can
    // still replace the whole reply.
    expect(segments).toEqual([])
    expect(scanner.failure?.code).toBe(TOOL_CALL_UNFENCED)
  })

  it('rejects a call whose members are written arguments-first', () => {
    const scanner = scan()
    scanByCharacter('{ "arguments": {"path": "/a"}, "name": "read_file" }', scanner)
    expect(scanner.failure?.code).toBe(TOOL_CALL_UNFENCED)
    expect(scanner.failure?.message).toMatch(/^A call to `read_file` was written outside/)
  })

  it('rejects a call nested inside a JSON wrapper the model invented', () => {
    const scanner = scan()
    const segments = scanByCharacter('{"tool_calls": [{"name":"bash","arguments":{}}]}', scanner)
    expect(textOf(segments)).toBe('{"tool_calls": [')
    expect(scanner.failure?.code).toBe(TOOL_CALL_UNFENCED)
  })

  it('rejects an unfenced call that the reply ended inside', () => {
    const scanner = scan()
    expect(scanByCharacter('{"name":"bash","arguments":{"command":"ls', scanner)).toEqual([])
    expect(scanner.failure?.code).toBe(TOOL_CALL_UNFENCED)
    expect(scanner.failure?.message).toMatch(/^A call to `bash` was written outside/)
  })

  it('rejects an unfenced call that outgrew the byte cap, and holds no more than the cap', () => {
    const scanner = scan({ maxCalls: 4, maxBytes: 64 })
    expect(scanner.push(`{"name":"bash","arguments":{"command":"${'x'.repeat(20)}`)).toEqual([])
    expect(scanner.failure).toBeUndefined()
    expect(scanner.push('y'.repeat(8))).toEqual([])
    expect(scanner.failure?.code).toBe(TOOL_CALL_UNFENCED)
  })

  it('does not take three backticks that start another opener line as the closing fence', () => {
    const scanner = scan()
    scanner.push('{"name":"bash","arguments":{}}\n```json\n')
    expect(scanner.failure?.message).toContain('{"name":"bash","arguments":{}}. The harness')
  })

  it('discards an unfenced call written after an accepted one, as it does any text there', () => {
    const scanner = scan()
    const segments = [
      ...scanner.push('```dsh-tool-call\n{"name":"bash","arguments":{}}\n```\n{"name":"bash","arguments":{}}\n```'),
      ...scanner.finish(),
    ]
    expect(segments).toEqual([
      { kind: 'call', raw: '{"name":"bash","arguments":{}}', lenient: false },
      { kind: 'text', text: '\n' },
      { kind: 'text', text: '{"name":"bash","arguments":{}}\n```' },
    ])
    expect(scanner.failure).toBeUndefined()
  })

  it('reads a fenced call that follows an object which is not a call', () => {
    const scanner = scan()
    const reply = '{"name":"widget","arguments":{}}\n```dsh-tool-call\n{"name":"bash","arguments":{}}\n```'
    expect([...scanner.push(reply), ...scanner.finish()]).toEqual([
      { kind: 'text', text: '{"name":"widget","arguments":{}}\n' },
      { kind: 'call', raw: '{"name":"bash","arguments":{}}', lenient: false },
    ])
  })

  it.each([
    ['an object naming a tool the request never declared', 'Send this body:\n\n{"name": "widget", "arguments": {"size": 2}}\n'],
    ['a declared name with no arguments member', 'The manifest is {"name": "bash", "version": "5.2"}.'],
    ['a fenced JSON example that is not a call', 'Example:\n\n```json\n{\n  "name": "my-package",\n  "version": "1.0.0"\n}\n```\n'],
    ['a fenced JSON example opening with another member', '```json\n{"compilerOptions": {"strict": true}}\n```'],
    ['code blocks in other languages', '```ts\nconst call = { name: \'bash\', arguments: {} }\n```\n\n```\n$ ls\n```\n'],
    ['JSON inside prose explaining code', 'The parser expects `{"arguments": [1, 2]}` and `{"name": 7}` here, or {"name": "x\\"y", "arguments": {}}.'],
    ['braces that balance around text that is not JSON', 'In the template {"name": bash, "arguments": none} is a placeholder.'],
    ['an escaped call quoted inside a string', 'It logs "{\\"name\\":\\"bash\\",\\"arguments\\":{}}" verbatim.'],
    ['an unfinished object and a lone fence at the end', 'Truncated: {"name": "ba'],
    ['an object opening that never completes a member', 'A set literal {"na'],
    ['a fence line with nothing under it', 'Trailing fence:\n```\n   '],
    ['four backticks', '````\n{"name":"widget"}\n````'],
    ['an info string that never reaches its newline', 'Write ```json and then the object.'],
    ['an unfinished arguments-first object', '{"arguments": {"a": 1}, "note": "no name'],
  ])('passes through %s unchanged', (_label, reply) => {
    const whole = scan()
    expect(textOf([...whole.push(reply), ...whole.finish()])).toBe(reply)
    expect(whole.failure).toBeUndefined()
    const streamed = scan()
    expect(textOf(scanByCharacter(reply, streamed))).toBe(reply)
    expect(streamed.failure).toBeUndefined()
  })

  it.each([
    ['a block opened with the json info string', '```json\n{"name":"bash","arguments":{"command":"ls"}}\n```'],
    ['a block opened with no info string', '```\n{"name":"bash","arguments":{"command":"ls"}}\n```\n'],
    ['a bare object followed by a closing fence', '\n{"name":"bash","arguments":{"command":"ls"}}\n```'],
  ])('accepts %s when reading leniently', (_label, reply) => {
    const expected = [{ kind: 'call', raw: '{"name":"bash","arguments":{"command":"ls"}}', lenient: true }]
    const whole = scanLeniently()
    expect([...whole.push(reply), ...whole.finish()].filter(segment => segment.kind === 'call')).toEqual(expected)
    expect(whole.failure).toBeUndefined()
    const streamed = scanLeniently()
    expect(scanByCharacter(reply, streamed).filter(segment => segment.kind === 'call')).toEqual(expected)
  })

  it.each([
    ['a bare object with no fence after it', '{"name":"bash","arguments":{}}'],
    ['a block opened with any other info string', '```tool_call\n{"name":"bash","arguments":{}}\n```'],
    ['a json block that never closes', '```json\n{"name":"bash","arguments":{}}\n'],
    ['an object carrying a member beyond name and arguments', '```json\n{"name":"bash","arguments":{},"id":"1"}\n```'],
    ['arguments that are not an object', '{"name":"bash","arguments":"ls"}\n```'],
  ])('still rejects %s when reading leniently', (_label, reply) => {
    const scanner = scanLeniently()
    expect([...scanner.push(reply), ...scanner.finish()]).toEqual([])
    expect(scanner.failure?.code).toBe(TOOL_CALL_UNFENCED)
  })

  it('counts leniently accepted calls against the same cap as fenced ones', () => {
    const scanner = scanLeniently({ maxCalls: 2, maxBytes: 32_768 })
    const segments = scanner.push(
      '{"name":"bash","arguments":{}}\n```\n'
      + '```dsh-tool-call\n{"name":"bash","arguments":{}}\n```\n'
      + '```json\n{"name":"bash","arguments":{}}\n```\n',
    )
    expect(segments.filter(segment => segment.kind === 'call').map(segment => segment.lenient)).toEqual([true, false])
    expect(scanner.failure?.code).toBe(TOOL_CALL_LIMIT)
  })

  it('releases an object as text once its name is complete and is not a declared tool', () => {
    const scanner = scan()
    expect(scanner.push('{"name": "my-pack')).toEqual([])
    expect(scanner.push('age", "version"')).toEqual([{ kind: 'text', text: '{"name": "my-package", "version"' }])
  })

  it('releases an oversized object that names no tool rather than holding it without end', () => {
    const scanner = scan({ maxCalls: 4, maxBytes: 16 })
    const reply = `{"arguments": {"blob": "${'x'.repeat(32)}`
    expect(textOf(scanner.push(reply))).toBe(reply)
    expect(scanner.failure).toBeUndefined()
  })

  it('releases a fence line once the first character under it is not an object', () => {
    const scanner = scan()
    expect(scanner.push('```json\n')).toEqual([])
    expect(scanner.push('[')).toEqual([{ kind: 'text', text: '```json\n[' }])
  })
})

describe('readToolCall', () => {
  it('accepts a declared tool and re-serializes its arguments', () => {
    expect(readToolCall('{"name":"read_file","arguments":{"path":"/a"}}', [READ_FILE])).toEqual({
      kind: 'call',
      call: { name: 'read_file', arguments: '{"path":"/a"}' },
    })
  })

  it('treats absent arguments as an empty object', () => {
    expect(readToolCall('{"name":"read_file"}', [READ_FILE])).toEqual({
      kind: 'call',
      call: { name: 'read_file', arguments: '{}' },
    })
    expect(readToolCall('{"name":"read_file","arguments":null}', [READ_FILE])).toEqual({
      kind: 'call',
      call: { name: 'read_file', arguments: '{}' },
    })
  })

  it('forwards arguments that break the tool schema rather than repairing or dropping them', () => {
    // The Harness tool layer owns `parameters` conformance and reports a violation to the model as a
    // tool result. This boundary checks structure only, and never edits what the model wrote.
    expect(readToolCall('{"name":"read_file","arguments":{"wrong":1}}', [READ_FILE])).toEqual({
      kind: 'call',
      call: { name: 'read_file', arguments: '{"wrong":1}' },
    })
  })

  it('names text that is not JSON at all', () => {
    const result = readToolCall('name = read_file', [READ_FILE])
    expect(result.kind === 'failure' && result.failure.code).toBe(TOOL_CALL_MALFORMED)
    expect(result.kind === 'failure' && result.failure.message).toMatch(/was not JSON/)
  })

  it('names JSON that is not one object', () => {
    const array = readToolCall('[{"name":"read_file"}]', [READ_FILE])
    expect(array.kind === 'failure' && array.failure.message).toMatch(/held an array/)
    const scalar = readToolCall('"read_file"', [READ_FILE])
    expect(scalar.kind === 'failure' && scalar.failure.message).toMatch(/held a non-object/)
  })

  it('names a block with no usable name', () => {
    const result = readToolCall('{"arguments":{}}', [READ_FILE])
    expect(result.kind === 'failure' && result.failure.code).toBe(TOOL_CALL_MALFORMED)
    expect(result.kind === 'failure' && result.failure.message).toMatch(/no `name` string/)
    expect(readToolCall('{"name":""}', [READ_FILE]).kind).toBe('failure')
  })

  it('names a tool the request never declared, and lists the ones it did', () => {
    const result = readToolCall('{"name":"web_search","arguments":{}}', [READ_FILE, BASH])
    expect(result.kind === 'failure' && result.failure.code).toBe(TOOL_CALL_UNKNOWN_TOOL)
    expect(result.kind === 'failure' && result.failure.message)
      .toBe('No tool named `web_search` is available. The available tools are: read_file, bash.')
  })

  it('names arguments that are not a JSON object', () => {
    const result = readToolCall('{"name":"read_file","arguments":"/a"}', [READ_FILE])
    expect(result.kind === 'failure' && result.failure.code).toBe(TOOL_CALL_MALFORMED)
    expect(result.kind === 'failure' && result.failure.message).toMatch(/were not a JSON object/)
    expect(readToolCall('{"name":"read_file","arguments":[1]}', [READ_FILE]).kind).toBe('failure')
  })

  it('bounds the excerpt it quotes from an oversized reply', () => {
    const result = readToolCall(`"${'x'.repeat(500)}"`, [READ_FILE])
    expect(result.kind === 'failure' && result.failure.message.length).toBeLessThan(300)
    expect(result.kind === 'failure' && result.failure.message).toMatch(/…/)
  })
})

describe('ToolCallEmulator', () => {
  it('passes a plain answer through as text with a clean finish', () => {
    const emulator = new ToolCallEmulator(plan())
    const chunks = reply('Three items.', emulator)
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'Three items.' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'Three items.' } },
      { type: 'usage', usage: { inputTokens: 1, outputTokens: 2 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    expect(emulator.calls).toBe(0)
    expect(emulator.failure).toBeUndefined()
  })

  it('accumulates successive deltas into one text block', () => {
    const emulator = new ToolCallEmulator(plan())
    const chunks = [
      ...emulator.push({ type: 'block-start', index: 0, blockType: 'text' }),
      ...emulator.push({ type: 'text-delta', index: 0, text: 'Three ' }),
      ...emulator.push({ type: 'text-delta', index: 0, text: 'items.' }),
      ...emulator.push({ type: 'block-end', index: 0, block: { type: 'text', text: 'Three items.' } }),
    ]
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'Three ' },
      { type: 'text-delta', index: 0, text: 'items.' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'Three items.' } },
    ])
  })

  it('turns one fenced block into a real tool call and reports the tool-calls finish', () => {
    const emulator = new ToolCallEmulator(plan())
    const chunks = reply('```dsh-tool-call\n{"name":"read_file","arguments":{"path":"/a"}}\n```', emulator)
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      {
        type: 'tool-call-delta',
        index: 0,
        id: 'claude-cli-0',
        name: 'read_file',
        argumentsDelta: '{"path":"/a"}',
      },
      {
        type: 'block-end',
        index: 0,
        block: { type: 'tool-call', id: 'claude-cli-0', name: 'read_file', arguments: '{"path":"/a"}' },
      },
      { type: 'usage', usage: { inputTokens: 1, outputTokens: 2 } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ])
    expect(emulator.calls).toBe(1)
  })

  it('keeps prose written before a call and drops what the model invented after it', () => {
    const emulator = new ToolCallEmulator(plan())
    const chunks = reply(
      'Let me read it.\n```dsh-tool-call\n{"name":"read_file","arguments":{"path":"/a"}}\n```\n'
      + 'The first line is `##`.',
      emulator,
    )
    expect(chunks.filter(chunk => chunk.type === 'text-delta'))
      .toEqual([{ type: 'text-delta', index: 0, text: 'Let me read it.\n' }])
    expect(chunks.filter(chunk => chunk.type === 'tool-call-delta')).toHaveLength(1)
    // The text block closes before the call block opens, so the assembled message keeps their order.
    expect(chunks.map(chunk => chunk.type)).toEqual([
      'block-start', 'text-delta', 'block-end',
      'block-start', 'tool-call-delta', 'block-end',
      'usage', 'finish',
    ])
    expect(emulator.discardedChars).toBe('\nThe first line is `##`.'.length)
  })

  it('reports two calls from one reply at distinct indexes', () => {
    const emulator = new ToolCallEmulator(plan())
    const chunks = reply(
      '```dsh-tool-call\n{"name":"read_file","arguments":{"path":"a"}}\n```\n\n'
      + '```dsh-tool-call\n{"name":"read_file","arguments":{"path":"b"}}\n```',
      emulator,
    )
    const calls = chunks.filter(chunk => chunk.type === 'tool-call-delta')
    expect(calls.map(call => call.index)).toEqual([0, 1])
    expect(calls.map(call => call.id)).toEqual(['claude-cli-0', 'claude-cli-1'])
    expect(emulator.calls).toBe(2)
  })

  it('remaps a reasoning block and leaves its text alone', () => {
    const emulator = new ToolCallEmulator(plan())
    const chunks = [
      ...emulator.push({ type: 'block-start', index: 0, blockType: 'reasoning' }),
      ...emulator.push({ type: 'reasoning-delta', index: 0, text: 'weighing' }),
      ...emulator.push({ type: 'block-end', index: 0, block: { type: 'reasoning', text: 'weighing' } }),
      ...emulator.push({ type: 'block-start', index: 1, blockType: 'text' }),
      ...emulator.push({ type: 'text-delta', index: 1, text: 'Done.' }),
    ]
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: 'weighing' },
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'weighing' } },
      { type: 'block-start', index: 1, blockType: 'text' },
      { type: 'text-delta', index: 1, text: 'Done.' },
    ])
  })

  it('names an unknown tool and refuses to report a call for it', () => {
    const emulator = new ToolCallEmulator(plan())
    const chunks = reply('```dsh-tool-call\n{"name":"web_search","arguments":{}}\n```', emulator)
    expect(chunks.some(chunk => chunk.type === 'tool-call-delta')).toBe(false)
    expect(emulator.failure?.code).toBe(TOOL_CALL_UNKNOWN_TOOL)
    expect(emulator.committed).toBe(false)
    expect(chunks.at(-1)).toEqual({
      type: 'finish',
      reason: { kind: 'error', failure: emulator.failure },
    })
  })

  it('names a truncated block when the CLI result arrives mid-fence', () => {
    const emulator = new ToolCallEmulator(plan())
    const partial = '```dsh-tool-call\n{"name":"read_file"'
    const chunks = reply(partial, emulator)
    expect(emulator.failure?.code).toBe(TOOL_CALL_TRUNCATED)
    expect(emulator.committed).toBe(false)
    expect(chunks.at(-1)?.type).toBe('finish')
  })

  it('stops reading a reply once one block is rejected', () => {
    const emulator = new ToolCallEmulator(plan())
    reply(
      '```dsh-tool-call\n{"name":"web_search","arguments":{}}\n```\n'
      + '```dsh-tool-call\n{"name":"read_file","arguments":{}}\n```',
      emulator,
    )
    // The whole reply is rejected, so the later block is not reported either; nothing runs.
    expect(emulator.calls).toBe(0)
    expect(emulator.failure?.code).toBe(TOOL_CALL_UNKNOWN_TOOL)
  })

  it('marks itself committed once text has been handed over, so no retry can replace it', () => {
    const emulator = new ToolCallEmulator(plan())
    emulator.push({ type: 'block-start', index: 0, blockType: 'text' })
    expect(emulator.committed).toBe(false)
    emulator.push({ type: 'text-delta', index: 0, text: 'Reading.\n' })
    expect(emulator.committed).toBe(true)
    emulator.push({ type: 'text-delta', index: 0, text: '```dsh-tool-call\n{"name":"nope"}\n```' })
    expect(emulator.failure?.code).toBe(TOOL_CALL_UNKNOWN_TOOL)
    expect(emulator.committed).toBe(true)
  })

  it('reads the three calls of the recorded opener-less reply when lenient reading is on', () => {
    const emulator = new ToolCallEmulator(plan([READ, BASH]))
    const chunks = reply(RECORDED_REPLY, emulator)
    expect(chunks.some(chunk => chunk.type === 'text-delta')).toBe(false)
    expect(chunks.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block)).toEqual([
      {
        type: 'tool-call',
        id: 'claude-cli-0',
        name: 'read',
        arguments: '{"file_path":"/repo/packages/web/tool-web/src/search.ts"}',
      },
      {
        type: 'tool-call',
        id: 'claude-cli-1',
        name: 'read',
        arguments: '{"file_path":"/repo/packages/credentials/coteccons-sso-msal/tests/sso.spec.ts","limit":90}',
      },
      {
        type: 'tool-call',
        id: 'claude-cli-2',
        name: 'bash',
        arguments: '{"command":"git status --short | head; git log --oneline -1; ls packages/client/ui-settings-coteccons-sso/src/client; wc -l packages/client/ui-settings-coteccons-sso/src/client/*","description":"Check git state and UI files","workdir":"/repo"}',
      },
    ])
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
    expect(emulator.calls).toBe(3)
    expect(emulator.lenientCalls).toBe(3)
    // Only the blank lines between the calls were dropped.
    expect(emulator.discardedChars).toBe(6)
  })

  it('counts no lenient call for a reply that used the fence', () => {
    const emulator = new ToolCallEmulator(plan())
    reply('```dsh-tool-call\n{"name":"read_file","arguments":{}}\n```', emulator)
    expect(emulator.calls).toBe(1)
    expect(emulator.lenientCalls).toBe(0)
  })

  it('never hands the recorded opener-less reply to the user as text when lenient reading is off', () => {
    const emulator = new ToolCallEmulator(plan([READ, BASH], LIMITS, false))
    const chunks = reply(RECORDED_REPLY, emulator)
    expect(chunks.some(chunk => chunk.type === 'text-delta' || chunk.type === 'block-start')).toBe(false)
    expect(emulator.failure?.code).toBe(TOOL_CALL_UNFENCED)
    // Nothing was handed over, so the adapter can still replace the reply with a correction run.
    expect(emulator.committed).toBe(false)
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'error', failure: emulator.failure } })
  })

  it('holds the recorded reply back while it streams, delta by delta', () => {
    const emulator = new ToolCallEmulator(plan([READ, BASH], LIMITS, false))
    emulator.push({ type: 'block-start', index: 0, blockType: 'text' })
    for (const text of RECORDED_DELTAS) {
      expect(emulator.push({ type: 'text-delta', index: 0, text })).toEqual([])
    }
    // The closing fence is only known to be one when the next character is not an info string.
    expect(emulator.failure).toBeUndefined()
    expect(emulator.push({ type: 'text-delta', index: 0, text: '\n\n\n{' })).toEqual([])
    expect(emulator.committed).toBe(false)
    expect(emulator.failure?.code).toBe(TOOL_CALL_UNFENCED)
  })

  it('names an unfenced call as the terminal failure once prose before it was handed over', () => {
    const emulator = new ToolCallEmulator(plan())
    const chunks = reply('Reading it.\n\n{"name":"read_file","arguments":{"path":"/a"}}', emulator)
    expect(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text)).toEqual(['Reading it.\n\n'])
    expect(emulator.committed).toBe(true)
    const finish = chunks.at(-1)
    expect(finish?.type === 'finish' && finish.reason.kind === 'error' && finish.reason.failure.code)
      .toBe(TOOL_CALL_UNFENCED)
  })

  it('drops the whitespace a reply opened with when a call follows it', () => {
    const emulator = new ToolCallEmulator(plan())
    const chunks = reply('\n\n```dsh-tool-call\n{"name":"read_file","arguments":{}}\n```', emulator)
    expect(chunks.map(chunk => chunk.type)).toEqual(['block-start', 'tool-call-delta', 'block-end', 'usage', 'finish'])
    expect(emulator.discardedChars).toBe(0)
  })

  it('keeps the whitespace an answer opened with once text follows it', () => {
    const emulator = new ToolCallEmulator(plan())
    const chunks = [
      ...emulator.push({ type: 'block-start', index: 0, blockType: 'text' }),
      ...emulator.push({ type: 'text-delta', index: 0, text: '\n' }),
      ...emulator.push({ type: 'text-delta', index: 0, text: ' Three.' }),
    ]
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: '\n Three.' },
    ])
  })

  it('hands over a reply that was whitespace and nothing else as written', () => {
    const emulator = new ToolCallEmulator(plan())
    const chunks = reply(' \n', emulator)
    expect(chunks.slice(0, 3)).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: ' \n' },
      { type: 'block-end', index: 0, block: { type: 'text', text: ' \n' } },
    ])
  })

  it('passes an answer that quotes a JSON example through unchanged', () => {
    const emulator = new ToolCallEmulator(plan())
    const answer = 'Send this body:\n\n```json\n{"name": "widget", "arguments": {"size": 2}}\n```\n'
    const chunks = reply(answer, emulator)
    expect(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join('')).toBe(answer)
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('leaves a non-stop finish alone even when a call was reported', () => {
    const emulator = new ToolCallEmulator(plan())
    emulator.push({ type: 'block-start', index: 0, blockType: 'text' })
    emulator.push({ type: 'text-delta', index: 0, text: '```dsh-tool-call\n{"name":"read_file"}\n```' })
    expect(emulator.calls).toBe(1)
    expect(emulator.push({ type: 'finish', reason: { kind: 'max-tokens' } }))
      .toEqual([{ type: 'finish', reason: { kind: 'max-tokens' } }])
  })
})
