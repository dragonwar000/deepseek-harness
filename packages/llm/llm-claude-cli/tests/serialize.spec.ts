import { describe, expect, it } from 'vitest'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, RequestMessage } from '@deepseek-ai/dsh-llm'
import { projectRequest, stdinLines } from '../src/serialize.ts'

/** The text of one stdin payload. */
function payloadText(line: string): string {
  expect(line.endsWith('\n')).toBe(true)
  const parsed = JSON.parse(line.trim()) as {
    type: string
    message: { role: string; content: { type: string; text: string }[] }
  }
  expect(parsed.type).toBe('user')
  expect(parsed.message.role).toBe('user')
  expect(parsed.message.content).toHaveLength(1)
  expect(parsed.message.content[0]?.type).toBe('text')
  return parsed.message.content[0]?.text ?? ''
}

/** The text the CLI would be handed for one request. */
function sent(messages: readonly RequestMessage[]): string {
  return payloadText(stdinLines(messages))
}

/** A user turn carrying arbitrary blocks. */
function turn(role: RequestMessage['role'], content: readonly ContentBlock[]): RequestMessage {
  return { role, content } as RequestMessage
}

const image: ContentBlock = {
  type: 'image',
  attachment: { attachmentId: AttachmentId('a1'), mediaType: 'image/png', bytes: 4, width: 1, height: 1 },
}

const file: ContentBlock = {
  type: 'file',
  attachment: { attachmentId: AttachmentId('f1'), name: 'notes.txt', bytes: 3 },
}


describe('stdinLines', () => {
  it('sends a single message verbatim, with no transcript labels', () => {
    expect(sent([turn('user', [{ type: 'text', text: 'just this' }])])).toBe('just this')
  })

  it('labels every role when the request carries a conversation', () => {
    expect(sent([
      turn('system', [{ type: 'text', text: 'be terse' }]),
      turn('user', [{ type: 'text', text: 'hello' }]),
      turn('assistant', [{ type: 'text', text: 'hi' }]),
      turn('tool', [{ type: 'text', text: 'exit 0' }]),
      turn('developer', [{ type: 'text', text: 'tools changed' }]),
    ])).toBe('System: be terse\n\nUser: hello\n\nAssistant: hi\n\nTool result: exit 0\n\nDeveloper: tools changed')
  })

  it('falls back to the raw role name for a role it has no label for', () => {
    expect(sent([
      turn('user', [{ type: 'text', text: 'a' }]),
      turn('auditor' as RequestMessage['role'], [{ type: 'text', text: 'b' }]),
    ])).toBe('User: a\n\nauditor: b')
  })

  it('renders a tool call the model previously made, so the transcript stays readable', () => {
    expect(sent([
      turn('user', [{ type: 'text', text: 'run it' }]),
      turn('assistant', [{ type: 'tool-call', id: ToolCallId('c1'), name: 'bash', arguments: '{"cmd":"ls"}' }]),
    ])).toBe('User: run it\n\nAssistant: [tool call bash {"cmd":"ls"}]')
  })

  it('leaves out the blocks that carry no text of their own', () => {
    expect(sent([
      turn('user', [
        image,
        file,
        { type: 'text', text: 'see the attachment handle above' },
      ]),
      turn('assistant', [{ type: 'reasoning', text: 'the model own prior thinking' }]),
      turn('developer', [{ type: 'tool-addition', toolName: 'bash' }]),
      turn('developer', [{ type: 'tool-removal', toolName: 'bash' }]),
    ])).toBe('User: see the attachment handle above')
  })

  it('joins several text blocks of one message with a blank line', () => {
    expect(sent([turn('user', [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }])]))
      .toBe('one\n\ntwo')
  })

  it('refuses a request with no text the CLI could be given', () => {
    expect(() => stdinLines([])).toThrow(/no text/)
    expect(() => stdinLines([turn('user', [{ type: 'text', text: '  \n ' }])])).toThrow(/no text/)
    expect(() => stdinLines([turn('user', [image]), turn('assistant', [{ type: 'reasoning', text: 'x' }])]))
      .toThrow(/no text/)
  })

  it('appends a correction notice under its own label, so the model can tell it from the user', () => {
    expect(payloadText(stdinLines([turn('user', [{ type: 'text', text: 'read it' }])], 'try again')))
      .toBe('read it\n\nHarness: try again')
  })
})

describe('projectRequest', () => {
  it('sends a one-shot system prompt as the CLI system prompt', () => {
    const projected = projectRequest(
      [turn('user', [{ type: 'text', text: 'hello' }])],
      'be terse',
      undefined,
      undefined,
    )
    expect(projected.system).toBe('be terse')
    expect(payloadText(projected.stdinPayload)).toBe('hello')
  })

  it('hoists a loop-built leading system message into the CLI system prompt', () => {
    // A loop request leaves `system` undefined; without the hoist the Harness prompt would arrive as
    // a labelled paragraph inside the user turn with Claude Code's own prompt still in force.
    const projected = projectRequest(
      [
        turn('system', [{ type: 'text', text: 'You are DeepSeek Harness.' }]),
        turn('user', [{ type: 'text', text: 'hello' }]),
      ],
      undefined,
      undefined,
      undefined,
    )
    expect(projected.system).toBe('You are DeepSeek Harness.')
    expect(payloadText(projected.stdinPayload)).toBe('hello')
  })

  it('leaves the leading system message in the transcript when the request also carries one', () => {
    const projected = projectRequest(
      [
        turn('system', [{ type: 'text', text: 'from history' }]),
        turn('user', [{ type: 'text', text: 'hello' }]),
      ],
      'from the caller',
      undefined,
      undefined,
    )
    expect(projected.system).toBe('from the caller')
    expect(payloadText(projected.stdinPayload)).toBe('System: from history\n\nUser: hello')
  })

  it('appends the emulation preamble after the system prompt', () => {
    const projected = projectRequest(
      [turn('user', [{ type: 'text', text: 'hello' }])],
      'be terse',
      '## Tool calls',
      undefined,
    )
    expect(projected.system).toBe('be terse\n\n## Tool calls')
  })

  it('makes the preamble the whole system prompt when the request carries none', () => {
    const projected = projectRequest(
      [turn('user', [{ type: 'text', text: 'hello' }])],
      undefined,
      '## Tool calls',
      undefined,
    )
    expect(projected.system).toBe('## Tool calls')
  })

  it('sends no system prompt at all when neither the request nor emulation supplies one', () => {
    const projected = projectRequest(
      [turn('user', [{ type: 'text', text: 'hello' }])],
      undefined,
      undefined,
      undefined,
    )
    expect(projected.system).toBeUndefined()
  })

  it('carries a correction notice into the retried run', () => {
    const projected = projectRequest(
      [turn('user', [{ type: 'text', text: 'read it' }])],
      undefined,
      '## Tool calls',
      'try again',
    )
    expect(payloadText(projected.stdinPayload)).toBe('read it\n\nHarness: try again')
  })

  it('refuses a request whose only message was the hoisted system prompt', () => {
    expect(() => projectRequest(
      [turn('system', [{ type: 'text', text: 'be terse' }])],
      undefined,
      undefined,
      undefined,
    )).toThrow(/no text/)
  })
})
