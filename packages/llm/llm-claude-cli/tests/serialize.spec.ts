import { describe, expect, it } from 'vitest'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, RequestMessage } from '@deepseek-ai/dsh-llm'
import { stdinLines } from '../src/serialize.ts'

/** The text the CLI would be handed for one request. */
function sent(messages: readonly RequestMessage[]): string {
  const line = stdinLines(messages)
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
})
