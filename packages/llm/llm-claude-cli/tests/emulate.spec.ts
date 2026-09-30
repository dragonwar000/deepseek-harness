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
  TOOL_CALL_UNKNOWN_TOOL,
  ToolCallEmulator,
} from '../src/emulate.ts'
import type { EmulationLimits, ToolPlan } from '../src/emulate.ts'

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
} as const

const LIMITS: EmulationLimits = { maxCalls: 4, maxBytes: 32_768 }

/** The prompt plan a test emulator reads a reply against. */
function plan(tools: readonly ToolSchema[] = [READ_FILE], limits: EmulationLimits = LIMITS) {
  return {
    kind: 'prompt',
    tools,
    preamble: buildToolPreamble(tools, limits),
    limits,
    retries: 1,
  } as const satisfies Extract<ToolPlan, { kind: 'prompt' }>
}

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
    expect(resolved.preamble).toBe(buildToolPreamble([READ_FILE, BASH], LIMITS))
  })
})

describe('buildToolPreamble', () => {
  it('renders the pinned wording the model reads, verbatim', () => {
    // Pinned on purpose: this is model-visible text, and the wording is what makes an emulated call
    // parseable. Changing it changes what the model sees, so it changes PREAMBLE_TEMPLATE too.
    expect(buildToolPreamble([READ_FILE], LIMITS)).toBe([
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
      '- `name` is spelled exactly as listed below. No other tool exists.',
      '- `arguments` is a JSON object. The harness passes it to the tool, which checks it against the `parameters` schema below and reports a violation to you.',
      '- Each block holds that one JSON object and nothing else, under 32768 bytes.',
      '- At most 4 blocks in one reply.',
      '- A reply that calls a tool contains no text outside its blocks, and ends at the closing fence of its last block.',
      '- Never write a tool result yourself. The harness runs the tool and sends you its real result in the next message; anything you write after a block is discarded.',
      '',
      'When no tool is needed, reply with ordinary text and no such block.',
      '',
      '### Tools',
      '',
      '#### read_file',
      '',
      'Read a file from the workspace.',
      '',
      '`parameters`:',
      '',
      '```json',
      '{"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}',
      '```',
    ].join('\n'))
    expect(PREAMBLE_TEMPLATE).toBe('dsh-tool-call/1')
    expect(TOOL_CALL_FENCE).toBe('dsh-tool-call')
  })

  it('states the bounds it will enforce, so a rejection is never a surprise', () => {
    const text = buildToolPreamble([READ_FILE], { maxCalls: 2, maxBytes: 4_096 })
    expect(text).toContain('under 4096 bytes')
    expect(text).toContain('At most 2 blocks')
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
    const scanner = new ReplyScanner(LIMITS)
    expect(scanner.push('Hello ')).toEqual([{ kind: 'text', text: 'Hello ' }])
    // The trailing backticks could still become the fence opener, so they wait.
    expect(scanner.push('there``')).toEqual([{ kind: 'text', text: 'there' }])
    expect(scanner.push('x')).toEqual([{ kind: 'text', text: '``x' }])
    expect(scanner.finish()).toEqual([])
    expect(scanner.failure).toBeUndefined()
  })

  it('releases a held partial fence when the reply ends', () => {
    const scanner = new ReplyScanner(LIMITS)
    expect(scanner.push('done ``')).toEqual([{ kind: 'text', text: 'done ' }])
    expect(scanner.finish()).toEqual([{ kind: 'text', text: '``' }])
  })

  it('splits a fenced call out of the surrounding prose', () => {
    const scanner = new ReplyScanner(LIMITS)
    const segments = [
      ...scanner.push('Let me read it.\n\n```dsh-tool-call\n{"name":"read_file","arg'),
      ...scanner.push('uments":{"path":"/etc/hosts"}}\n```\nDone.'),
      ...scanner.finish(),
    ]
    expect(segments).toEqual([
      { kind: 'text', text: 'Let me read it.\n\n' },
      { kind: 'call', raw: '{"name":"read_file","arguments":{"path":"/etc/hosts"}}' },
      { kind: 'text', text: '\nDone.' },
    ])
  })

  it('reads two consecutive calls from one reply', () => {
    const scanner = new ReplyScanner(LIMITS)
    const segments = scanner.push(
      '```dsh-tool-call\n{"name":"read_file","arguments":{"path":"a"}}\n```\n\n'
      + '```dsh-tool-call\n{"name":"read_file","arguments":{"path":"b"}}\n```',
    )
    expect(segments.filter(segment => segment.kind === 'call')).toHaveLength(2)
  })

  it('keeps collecting past a fence inside a string argument', () => {
    const scanner = new ReplyScanner(LIMITS)
    const raw = '{"name":"read_file","arguments":{"path":"x","body":"```js\\ncode\\n```"}}'
    const segments = scanner.push(`\`\`\`dsh-tool-call\n${raw}\n\`\`\``)
    expect(segments).toEqual([{ kind: 'call', raw }])
  })

  it('names a reply that ended inside an unterminated block', () => {
    const scanner = new ReplyScanner(LIMITS)
    scanner.push('```dsh-tool-call\n{"name":"read_file","argu')
    expect(scanner.finish()).toEqual([])
    expect(scanner.failure?.code).toBe(TOOL_CALL_TRUNCATED)
    expect(scanner.failure?.message).toMatch(/unterminated tool-call block/)
    // A scanner that already failed produces nothing more rather than guessing.
    expect(scanner.push('more')).toEqual([])
    expect(scanner.finish()).toEqual([])
  })

  it('names a closed block whose contents never became one JSON object', () => {
    const scanner = new ReplyScanner(LIMITS)
    scanner.push('```dsh-tool-call\nname = read_file\n```')
    scanner.finish()
    expect(scanner.failure?.code).toBe(TOOL_CALL_MALFORMED)
    expect(scanner.failure?.message).toMatch(/did not hold one JSON object/)
  })

  it('names a block that outgrew the byte cap instead of buffering without end', () => {
    const scanner = new ReplyScanner({ maxCalls: 4, maxBytes: 32 })
    scanner.push(`\`\`\`dsh-tool-call\n{"name":"read_file","arguments":{"path":"${'x'.repeat(64)}"`)
    expect(scanner.failure?.code).toBe(TOOL_CALL_TOO_LARGE)
    expect(scanner.failure?.message).toMatch(/exceeded 32 bytes/)
  })

  it('names a reply carrying more blocks than the cap allows', () => {
    const scanner = new ReplyScanner({ maxCalls: 1, maxBytes: 32_768 })
    const block = '```dsh-tool-call\n{"name":"read_file","arguments":{}}\n```\n'
    const segments = scanner.push(block + block)
    expect(segments.filter(segment => segment.kind === 'call')).toHaveLength(1)
    expect(scanner.failure?.code).toBe(TOOL_CALL_LIMIT)
    expect(scanner.failure?.message).toMatch(/more than 1 tool-call blocks/)
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

  it('leaves a non-stop finish alone even when a call was reported', () => {
    const emulator = new ToolCallEmulator(plan())
    emulator.push({ type: 'block-start', index: 0, blockType: 'text' })
    emulator.push({ type: 'text-delta', index: 0, text: '```dsh-tool-call\n{"name":"read_file"}\n```' })
    expect(emulator.calls).toBe(1)
    expect(emulator.push({ type: 'finish', reason: { kind: 'max-tokens' } }))
      .toEqual([{ type: 'finish', reason: { kind: 'max-tokens' } }])
  })
})
