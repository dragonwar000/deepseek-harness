/**
 * Projects one Harness request onto what the Claude Code CLI's streaming input accepts.
 *
 * The CLI is conversational, not stateless: every `{"type":"user",…}` line written to stdin starts
 * a turn and the CLI supplies the assistant side itself. An `{"type":"assistant",…}` line is
 * ignored — verified against Claude Code 2.1.285, where injecting one and then asking about it
 * produced a fresh answer to the first user message rather than a continuation. So a request whose
 * history holds more than one message is rendered as a transcript inside a single user turn; a
 * single-message request is sent verbatim, with no wrapper at all.
 *
 * This is a projection, the same kind every adapter performs, and it is a pure function of the
 * request the session log already holds.
 */

import type { ContentBlock, RequestMessage } from '@deepseek-ai/dsh-llm'

/** Role labels used by the transcript projection. */
const ROLE_LABEL: Readonly<Record<string, string>> = {
  user: 'User',
  assistant: 'Assistant',
  system: 'System',
  developer: 'Developer',
  tool: 'Tool result',
}

/** Label under which a correction notice is appended, so the model can tell it from the user. */
const NOTICE_LABEL = 'Harness'

/** Render one content block as the text the CLI can carry. */
function blockText(block: ContentBlock): string | undefined {
  switch (block.type) {
    case 'text': return block.text
    case 'reasoning':
      // Reasoning is the model's own prior thinking; replaying it as user text would present it as
      // something the user said.
      return undefined
    case 'tool-call':
      return `[tool call ${block.name} ${block.arguments}]`
    case 'image':
    case 'file':
      // Request assembly has already projected attachments to handle text in a sibling text block,
      // so the structured reference itself carries nothing more to send.
      return undefined
    case 'tool-addition':
    case 'tool-removal':
      // Tool declaration churn: this route refuses requests that declare tools at all.
      return undefined
    /* v8 ignore next 3 -- reachable only for a block a plugin outside this build contributed to the
       merge-extensible `ContentBlockMap`, which the union requires this arm to accept. */
    default:
      return undefined
  }
}

/** Join one message's blocks into its text, dropping the blocks that carry none. */
function messageText(message: RequestMessage): string {
  return message.content.map(blockText).filter(text => text !== undefined).join('\n\n')
}

/**
 * Render the request's messages as the stdin lines for one CLI run.
 * @param messages - the request's assembled messages, in conversation order.
 * @param notice - a correction notice appended under its own label, for a retried run.
 * @returns newline-terminated JSON lines to write to the CLI's stdin.
 * @throws Error when no message carries any text, since the CLI has no turn to run.
 */
export function stdinLines(messages: readonly RequestMessage[], notice?: string): string {
  const body = messages.length === 1 && messages[0] !== undefined
    ? messageText(messages[0])
    : messages
      .map(message => ({ label: ROLE_LABEL[message.role] ?? message.role, body: messageText(message) }))
      .filter(entry => entry.body.length > 0)
      .map(entry => `${entry.label}: ${entry.body}`)
      .join('\n\n')
  if (body.trim().length === 0) {
    throw new Error('the request carried no text the Claude Code CLI could be given')
  }
  const text = notice === undefined ? body : `${body}\n\n${NOTICE_LABEL}: ${notice}`
  return `${JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
  })}\n`
}

/** The system prompt and the stdin payload of one planned CLI run. */
export interface ProjectedRequest {
  /** Text for `--system-prompt`, or `undefined` when the request carries no system prompt at all. */
  readonly system: string | undefined
  /** The one stdin line the run writes. */
  readonly stdinPayload: string
}

/**
 * Project one request onto the CLI's system slot and its single user turn.
 *
 * A loop-built request leaves `GenerateOptions.system` undefined and carries its system prompt as
 * the leading system-role message instead. That message is hoisted into `--system-prompt` here, so
 * the Harness prompt always replaces the CLI's own rather than arriving as a labelled paragraph
 * inside the user turn with Claude Code's prompt still in force above it.
 * @param messages - the request's assembled messages, in conversation order.
 * @param system - the request's one-shot system prompt, when it has one.
 * @param preamble - tool-call emulation text appended after the system prompt, when emulating.
 * @param notice - a correction notice for a retried run.
 * @returns the system prompt text and the stdin payload.
 * @throws Error when no message is left to send, since the CLI has no turn to run.
 */
export function projectRequest(
  messages: readonly RequestMessage[],
  system: string | undefined,
  preamble: string | undefined,
  notice: string | undefined,
): ProjectedRequest {
  const first = messages[0]
  const leading = system === undefined && first?.role === 'system' ? first : undefined
  const head = leading === undefined ? system : messageText(leading)
  const rest = leading === undefined ? messages : messages.slice(1)
  const composed = [head, preamble]
    .filter((part): part is string => part !== undefined && part.length > 0)
    .join('\n\n')
  return {
    system: composed.length === 0 ? undefined : composed,
    stdinPayload: stdinLines(rest, notice),
  }
}
