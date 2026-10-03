import { describe, expect, it } from 'vitest'
import type { LlmFailure, StreamChunk } from '@deepseek-ai/dsh-llm'
import { CLI_NOT_AUTHENTICATED, notAuthenticatedFailure } from '../src/catalog.ts'
import { ClaudeCliStreamDecoder, decodeAuthStatus, decodeModelRows, lineSplitter } from '../src/wire.ts'

/** The failure the adapter hands the decoder for a registered account whose login lapsed. */
const SIGNED_OUT = notAuthenticatedFailure('/accounts/claude/one')

/** Verbatim rows from Claude Code 2.1.285's `list_models` answer. */
const CATALOG_LINE = JSON.stringify({
  type: 'control_response',
  response: {
    subtype: 'success',
    request_id: 'dsh-claude-cli-models',
    response: {
      models: [
        {
          value: 'default',
          resolvedModel: 'claude-opus-5',
          displayName: 'Default (recommended)',
          description: 'Opus 5 · Best for everyday, complex tasks',
          supportsEffort: true,
          supportedEffortLevels: ['low', 'high', 'xhigh'],
        },
        {
          value: 'haiku',
          resolvedModel: 'claude-haiku-4-5-20251001',
          displayName: 'Haiku 4.5',
          description: 'Fastest for quick answers',
        },
      ],
    },
  },
})

const control = (response: object): string => JSON.stringify({ type: 'control_response', response })

/** Feed several lines and collect everything they produced. */
function drain(decoder: ClaudeCliStreamDecoder, lines: readonly string[]): StreamChunk[] {
  return lines.flatMap(line => [...decoder.push(line)])
}

/** The failure a terminal error finish carries. */
const failureOf = (finish: Extract<StreamChunk, { type: 'finish' }>): LlmFailure => {
  if (finish.reason.kind !== 'error') throw new Error('expected an error finish')
  return finish.reason.failure
}

const finishOf = (chunks: readonly StreamChunk[]): Extract<StreamChunk, { type: 'finish' }> => {
  const last = chunks.at(-1)
  if (last?.type !== 'finish') throw new Error('expected a terminal finish chunk')
  return last
}

describe('decodeModelRows', () => {
  it('reads the CLI catalog and keeps the effort levels the CLI reports', () => {
    const answer = decodeModelRows(CATALOG_LINE)
    const rows = answer?.kind === 'rows' ? answer.rows : undefined
    expect(rows?.map(row => row.id)).toEqual(['default', 'haiku'])
    expect(rows?.[0]?.displayName).toBe('Default (recommended)')
    expect(rows?.[0]?.resolvedModel).toBe('claude-opus-5')
    expect(rows?.[0]?.efforts).toEqual([
      { id: 'low', name: 'Low' },
      { id: 'high', name: 'High' },
      { id: 'xhigh', name: 'Extra high' },
    ])
    expect(rows?.[1]?.efforts).toEqual([])
    expect(rows?.[1]?.description).toBe('Fastest for quick answers')
  })

  it('marks the row the CLI calls default', () => {
    const answer = decodeModelRows(control({
      subtype: 'success',
      request_id: 'dsh-claude-cli-models',
      response: { models: [{ value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus', isDefault: true }] },
    }))
    const rows = answer?.kind === 'rows' ? answer.rows : undefined
    expect(rows?.[0]?.isDefault).toBe(true)
    expect(rows?.[0]?.description).toBeUndefined()
  })

  it('ignores lines that are not the answer to this probe', () => {
    expect(decodeModelRows('{"type":"system","subtype":"init"}')).toBeUndefined()
    expect(decodeModelRows('not json')).toBeUndefined()
    expect(decodeModelRows('')).toBeUndefined()
    expect(decodeModelRows('null')).toBeUndefined()
    expect(decodeModelRows(control({ subtype: 'success', request_id: 'someone-else', response: { models: [] } })))
      .toBeUndefined()
  })

  it('reports a refusal verbatim so the picker can show the CLI own words', () => {
    expect(decodeModelRows(control({
      subtype: 'error',
      request_id: 'dsh-claude-cli-models',
      error: 'Unsupported control request subtype: list_models',
    }))).toEqual({ kind: 'refused', reason: 'Unsupported control request subtype: list_models' })
  })

  it('names an unreadable payload and an empty catalog as refusals', () => {
    for (const response of [
      { subtype: 'success', request_id: 'dsh-claude-cli-models', response: { models: [{ value: '' }] } },
      { subtype: 'success', request_id: 'dsh-claude-cli-models', response: { models: [] } },
      { subtype: 'error', request_id: 'dsh-claude-cli-models', error: 17 },
    ]) {
      const answer = decodeModelRows(control(response))
      expect(answer?.kind).toBe('refused')
      expect(answer?.kind === 'refused' && answer.reason).toMatch(/cannot read/)
    }
  })
})

describe('decodeAuthStatus', () => {
  it('reads the CLI own answer for both states', () => {
    expect(decodeAuthStatus('{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","subscriptionType":"max"}'))
      .toEqual({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' })
    expect(decodeAuthStatus('{"loggedIn":false,"authMethod":"none"}'))
      .toEqual({ loggedIn: false, authMethod: 'none', subscriptionType: undefined })
  })

  it('reports output it cannot read rather than guessing a state', () => {
    expect(decodeAuthStatus('')).toBeUndefined()
    expect(decodeAuthStatus('{"loggedIn":"yes"}')).toBeUndefined()
    expect(decodeAuthStatus('command not found: claude')).toBeUndefined()
  })
})

describe('ClaudeCliStreamDecoder', () => {
  it('turns one CLI run into reasoning, text, usage, and exactly one finish', () => {
    const decoder = new ClaudeCliStreamDecoder(SIGNED_OUT)
    const chunks = drain(decoder, [
      '{"type":"system","subtype":"init","session_id":"c9"}',
      '{"type":"stream_event","event":{"type":"message_start","message":{"model":"claude-haiku-4-5"}}}',
      '{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}}',
      '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"weighing"}}}',
      '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"abc"}}}',
      '{"type":"stream_event","event":{"type":"content_block_stop","index":0}}',
      '{"type":"stream_event","event":{"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}}',
      '{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Three "}}}',
      '{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"items."}}}',
      '{"type":"stream_event","event":{"type":"content_block_stop","index":1}}',
      '{"type":"stream_event","event":{"type":"message_stop"}}',
      '{"type":"result","subtype":"success","is_error":false,"result":"Three items.","stop_reason":"end_turn","usage":{"input_tokens":433,"output_tokens":45,"cache_read_input_tokens":12,"cache_creation_input_tokens":7,"output_tokens_details":{"thinking_tokens":35}}}',
    ])
    expect(chunks.filter(chunk => chunk.type === 'block-start').map(chunk => chunk.blockType))
      .toEqual(['reasoning', 'text'])
    expect(chunks.filter(chunk => chunk.type === 'reasoning-delta').map(chunk => chunk.text)).toEqual(['weighing'])
    expect(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text)).toEqual(['Three ', 'items.'])
    expect(chunks.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block)).toEqual([
      { type: 'reasoning', text: 'weighing' },
      { type: 'text', text: 'Three items.' },
    ])
    // dsh token counts are disjoint: inputTokens excludes both cache columns.
    expect(chunks.find(chunk => chunk.type === 'usage')).toEqual({
      type: 'usage',
      usage: { inputTokens: 433, outputTokens: 45, cacheReadTokens: 12, cacheWriteTokens: 7, reasoningTokens: 35 },
    })
    expect(finishOf(chunks).reason).toEqual({ kind: 'stop' })
    expect(decoder.resultSeen).toBe(true)
  })

  it('reports usage without the optional counters the CLI omitted', () => {
    const decoder = new ClaudeCliStreamDecoder(SIGNED_OUT)
    const chunks = decoder.push('{"type":"result","subtype":"success","is_error":false,"stop_reason":"end_turn","usage":{"input_tokens":2,"output_tokens":5}}')
    expect(chunks.find(chunk => chunk.type === 'usage')).toEqual({
      type: 'usage',
      usage: { inputTokens: 2, outputTokens: 5 },
    })
  })

  it('omits the usage chunk when the CLI reported none', () => {
    const decoder = new ClaudeCliStreamDecoder(SIGNED_OUT)
    const chunks = decoder.push('{"type":"result","subtype":"success","is_error":false,"stop_reason":"end_turn"}')
    expect(chunks.some(chunk => chunk.type === 'usage')).toBe(false)
    expect(finishOf(chunks).reason).toEqual({ kind: 'stop' })
  })

  it('maps max_tokens to the max-tokens finish reason', () => {
    const decoder = new ClaudeCliStreamDecoder(SIGNED_OUT)
    const chunks = decoder.push('{"type":"result","subtype":"success","is_error":false,"stop_reason":"max_tokens","usage":{"input_tokens":1,"output_tokens":1}}')
    expect(finishOf(chunks).reason).toEqual({ kind: 'max-tokens' })
  })

  it('maps the CLI own error result to a named failure and never a silent stop', () => {
    const decoder = new ClaudeCliStreamDecoder(SIGNED_OUT)
    const finish = finishOf(decoder.push('{"type":"result","subtype":"error_during_execution","is_error":true,"stop_reason":null}'))
    expect(failureOf(finish)).toEqual({
      message: 'the Claude Code CLI ended the run with error_during_execution',
      code: 'PROVIDER',
    })
  })

  it('names the signed-out account, and where to sign in, for the result a signed-out CLI writes', () => {
    const decoder = new ClaudeCliStreamDecoder(SIGNED_OUT)
    // Verbatim from the Desktop failure: Claude Code 2.1.285 against a signed-out directory.
    const finish = finishOf(decoder.push('{"type":"result","subtype":"success","is_error":true,"result":"Not logged in · Please run /login","duration_ms":59}'))
    expect(failureOf(finish)).toEqual({
      message: 'The registered Claude account is signed out. Open Settings, AI Account, and sign in to Claude again; the Claude Code CLI performs the sign-in and keeps the credential. The CLI reported: Not logged in · Please run /login',
      code: CLI_NOT_AUTHENTICATED,
    })
  })

  it('reads the signed-out state from the error kind the CLI attaches to its assistant message', () => {
    const decoder = new ClaudeCliStreamDecoder(SIGNED_OUT)
    const finish = finishOf(drain(decoder, [
      '{"type":"assistant","message":{"model":"<synthetic>","role":"assistant","content":[{"type":"text","text":"Failed to authenticate. API Error: 403 Your API key does not have permission to use the specified resource."}]},"error":"authentication_failed","is_api_error_message":true}',
      '{"type":"result","subtype":"success","is_error":true,"api_error_status":403,"terminal_reason":"api_error","stop_reason":"stop_sequence","result":"Failed to authenticate. API Error: 403 Your API key does not have permission to use the specified resource."}',
    ]))
    expect(failureOf(finish)).toEqual({
      message: `${SIGNED_OUT.message} The CLI reported: Failed to authenticate. API Error: 403 Your API key does not have permission to use the specified resource.`,
      code: CLI_NOT_AUTHENTICATED,
      status: 403,
    })
  })

  it('reads the signed-out state from a 401 status when the result carries nothing else', () => {
    const decoder = new ClaudeCliStreamDecoder(SIGNED_OUT)
    const finish = finishOf(decoder.push('{"type":"result","subtype":"success","is_error":true,"api_error_status":401,"result":""}'))
    expect(failureOf(finish)).toEqual({ message: SIGNED_OUT.message, code: CLI_NOT_AUTHENTICATED, status: 401 })
  })

  it('classifies a rate-limited run as RATE_LIMIT and keeps the CLI own words', () => {
    const decoder = new ClaudeCliStreamDecoder(SIGNED_OUT)
    const finish = finishOf(drain(decoder, [
      '{"type":"assistant","message":{"model":"<synthetic>","role":"assistant","content":[{"type":"text","text":"API Error: Request rejected (429) · This request would exceed your rate limit."}]},"error":"rate_limit","is_api_error_message":true}',
      '{"type":"result","subtype":"success","is_error":true,"api_error_status":429,"terminal_reason":"api_error","stop_reason":"stop_sequence","result":"API Error: Request rejected (429) · This request would exceed your rate limit."}',
    ]))
    expect(failureOf(finish)).toEqual({
      message: 'Claude Code CLI: API Error: Request rejected (429) · This request would exceed your rate limit.',
      code: 'RATE_LIMIT',
      status: 429,
    })
  })

  it('classifies a rate limit the CLI reports with no HTTP status, as a subscription limit is', () => {
    const decoder = new ClaudeCliStreamDecoder(SIGNED_OUT)
    const finish = finishOf(drain(decoder, [
      '{"type":"assistant","message":{"content":[]},"error":"rate_limit","is_api_error_message":true}',
      '{"type":"result","subtype":"success","is_error":true,"api_error_status":null,"result":"You\'ve hit your limit"}',
    ]))
    expect(failureOf(finish)).toEqual({ message: 'Claude Code CLI: You\'ve hit your limit', code: 'RATE_LIMIT' })
  })

  it('classifies an overloaded or failing API as SERVER', () => {
    const overloaded = finishOf(drain(new ClaudeCliStreamDecoder(SIGNED_OUT), [
      '{"type":"assistant","message":{"content":[]},"error":"server_error","is_api_error_message":true}',
      '{"type":"result","subtype":"success","is_error":true,"api_error_status":529,"terminal_reason":"api_error","stop_reason":"stop_sequence","result":"API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again in a moment."}',
    ]))
    expect(failureOf(overloaded)).toEqual({
      message: 'Claude Code CLI: API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again in a moment.',
      code: 'SERVER',
      status: 529,
    })
    const kindOnly = finishOf(drain(new ClaudeCliStreamDecoder(SIGNED_OUT), [
      '{"type":"assistant","message":{"content":[]},"error":"overloaded"}',
      '{"type":"result","subtype":"success","is_error":true,"result":"Overloaded"}',
    ]))
    expect(failureOf(kindOnly)).toEqual({ message: 'Claude Code CLI: Overloaded', code: 'SERVER' })
    const statusOnly = finishOf(new ClaudeCliStreamDecoder(SIGNED_OUT)
      .push('{"type":"result","subtype":"success","is_error":true,"api_error_status":500,"result":"API Error: 500 Internal server error."}'))
    expect(failureOf(statusOnly)).toEqual({
      message: 'Claude Code CLI: API Error: 500 Internal server error.',
      code: 'SERVER',
      status: 500,
    })
    const rateStatusOnly = finishOf(new ClaudeCliStreamDecoder(SIGNED_OUT)
      .push('{"type":"result","subtype":"success","is_error":true,"api_error_status":429,"result":"Too many requests"}'))
    expect(failureOf(rateStatusOnly).code).toBe('RATE_LIMIT')
  })

  it('keeps PROVIDER, with the CLI own words, for a failure no retry code fits', () => {
    const billing = finishOf(drain(new ClaudeCliStreamDecoder(SIGNED_OUT), [
      '{"type":"assistant","message":{"content":[{"type":"text","text":"Credit balance is too low"}]},"error":"billing_error","is_api_error_message":true}',
      '{"type":"result","subtype":"success","is_error":true,"api_error_status":400,"terminal_reason":"api_error","stop_reason":"stop_sequence","result":"Credit balance is too low"}',
    ]))
    expect(failureOf(billing)).toEqual({
      message: 'Claude Code CLI: Credit balance is too low',
      code: 'PROVIDER',
      status: 400,
    })
    const model = finishOf(drain(new ClaudeCliStreamDecoder(SIGNED_OUT), [
      '{"type":"assistant","message":{"content":[]},"error":"model_not_found","is_api_error_message":true}',
      '{"type":"result","subtype":"success","is_error":true,"api_error_status":404,"result":"There\'s an issue with the selected model (claude-haiku-4-5-20251001). It may not exist or you may not have access to it. Run --model to pick a different model."}',
    ]))
    expect(failureOf(model).code).toBe('PROVIDER')
    expect(failureOf(model).message).toMatch(/^Claude Code CLI: There's an issue with the selected model/)
  })

  it('does not mistake advice that mentions /login for a signed-out account', () => {
    const finish = finishOf(drain(new ClaudeCliStreamDecoder(SIGNED_OUT), [
      '{"type":"assistant","message":{"content":[]},"error":"invalid_request","is_api_error_message":true}',
      '{"type":"result","subtype":"success","is_error":true,"api_error_status":400,"result":"Claude Opus is not available with the Claude Pro plan. If you have updated your subscription plan recently, run /logout and /login for the plan to take effect."}',
    ]))
    expect(failureOf(finish).code).toBe('PROVIDER')
  })

  it('quotes the errors list of an error subtype, which carries no result text', () => {
    const decoder = new ClaudeCliStreamDecoder(SIGNED_OUT)
    const finish = finishOf(decoder.push('{"type":"result","subtype":"error_max_turns","is_error":true,"stop_reason":null,"errors":["Reached maximum number of turns (1)","second"]}'))
    expect(failureOf(finish)).toEqual({
      message: 'Claude Code CLI: Reached maximum number of turns (1); second',
      code: 'PROVIDER',
    })
  })

  it('says the CLI gave no reason rather than naming a successful subtype as the failure', () => {
    const decoder = new ClaudeCliStreamDecoder(SIGNED_OUT)
    const finish = finishOf(decoder.push('{"type":"result","subtype":"success","is_error":true,"result":"  "}'))
    expect(failureOf(finish)).toEqual({
      message: 'the Claude Code CLI reported a failed run and gave no reason',
      code: 'PROVIDER',
    })
  })

  it('quotes the CLI text as one bounded line with no terminal control sequences', () => {
    const decoder = new ClaudeCliStreamDecoder(SIGNED_OUT)
    const text = `\u001B[31mAPI Error\u001B[0m:\n\tfirst\r\nsecond \u0007${'x'.repeat(600)}`
    const finish = finishOf(decoder.push(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: text })))
    const message = failureOf(finish).message
    expect(message).toBe(`Claude Code CLI: API Error: first second ${'x'.repeat(476)}…`)
    expect(message).not.toMatch(/[\u0000-\u001F\u007F]/)
  })

  it('ignores result fields of a type it does not expect instead of failing to read the result', () => {
    const decoder = new ClaudeCliStreamDecoder(SIGNED_OUT)
    const finish = finishOf(drain(decoder, [
      '{"type":"assistant","error":{"kind":"rate_limit"}}',
      '{"type":"result","subtype":"success","is_error":true,"api_error_status":"429","errors":"none","result":"Something failed"}',
    ]))
    expect(failureOf(finish)).toEqual({ message: 'Claude Code CLI: Something failed', code: 'PROVIDER' })
  })

  it('reports a clean stop after an assistant message that carried an error kind', () => {
    const decoder = new ClaudeCliStreamDecoder(SIGNED_OUT)
    const finish = finishOf(drain(decoder, [
      '{"type":"assistant","message":{"content":[]},"error":"rate_limit"}',
      '{"type":"result","subtype":"success","is_error":false,"stop_reason":"end_turn"}',
    ]))
    expect(finish.reason).toEqual({ kind: 'stop' })
  })

  it('treats an unreadable result as a named failure', () => {
    const decoder = new ClaudeCliStreamDecoder(SIGNED_OUT)
    const finish = finishOf(decoder.push('{"type":"result","subtype":"success"}'))
    expect(finish.reason.kind === 'error' && finish.reason.failure.message).toMatch(/cannot read/)
    expect(decoder.resultSeen).toBe(true)
  })

  it('closes every block the CLI left open, in index order, when the run ends', () => {
    const decoder = new ClaudeCliStreamDecoder(SIGNED_OUT)
    const chunks = drain(decoder, [
      '{"type":"stream_event","event":{"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}}',
      '{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"second"}}}',
      '{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}}',
      '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"first"}}}',
      '{"type":"result","subtype":"success","is_error":false,"stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1}}',
    ])
    expect(chunks.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block))
      .toEqual([{ type: 'reasoning', text: 'first' }, { type: 'text', text: 'second' }])
  })

  it('reports a stream that ended without a result rather than finishing clean', () => {
    const decoder = new ClaudeCliStreamDecoder(SIGNED_OUT)
    decoder.push('{"type":"system","subtype":"init"}')
    const finish = finishOf(decoder.finish())
    expect(finish.reason.kind).toBe('error')
    expect(finish.reason.kind === 'error' && finish.reason.failure.code).toBe('TRANSPORT')
    expect(decoder.resultSeen).toBe(false)
  })

  it('adds nothing on finish once the result arrived', () => {
    const decoder = new ClaudeCliStreamDecoder(SIGNED_OUT)
    decoder.push('{"type":"result","subtype":"success","is_error":false,"stop_reason":"end_turn"}')
    expect(decoder.finish()).toEqual([])
  })

  it('ignores the messages and events that carry no harness meaning', () => {
    const decoder = new ClaudeCliStreamDecoder(SIGNED_OUT)
    expect(decoder.push('{"type":"rate_limit_event","rate_limit_info":{"status":"allowed"}}')).toEqual([])
    expect(decoder.push('{"type":"assistant","message":{"content":[]}}')).toEqual([])
    expect(decoder.push('{"type":"system","subtype":"thinking_tokens","estimated_tokens":9}')).toEqual([])
    expect(decoder.push('{"type":"stream_event","event":{"type":"message_delta","delta":{}}}')).toEqual([])
    expect(decoder.push('{"type":"stream_event"}')).toEqual([])
    expect(decoder.push('{"type":"stream_event","event":null}')).toEqual([])
    expect(decoder.push('')).toEqual([])
    expect(decoder.push('not json')).toEqual([])
    expect(decoder.push('"a string"')).toEqual([])
  })

  it('drops a content block type it has no representation for', () => {
    const decoder = new ClaudeCliStreamDecoder(SIGNED_OUT)
    expect(decoder.push('{"type":"stream_event","event":{"type":"content_block_start","index":4,"content_block":{"type":"tool_use"}}}')).toEqual([])
    // With no open block, later events for that index produce nothing either.
    expect(decoder.push('{"type":"stream_event","event":{"type":"content_block_delta","index":4,"delta":{"type":"text_delta","text":"x"}}}')).toEqual([])
    expect(decoder.push('{"type":"stream_event","event":{"type":"content_block_stop","index":4}}')).toEqual([])
  })

  it('ignores block events whose index or delta it cannot use', () => {
    const decoder = new ClaudeCliStreamDecoder(SIGNED_OUT)
    expect(decoder.push('{"type":"stream_event","event":{"type":"content_block_start","content_block":{"type":"text"}}}')).toEqual([])
    expect(decoder.push('{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"x"}}}')).toEqual([])
    expect(decoder.push('{"type":"stream_event","event":{"type":"content_block_stop"}}')).toEqual([])
    decoder.push('{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}}')
    expect(decoder.push('{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":""}}}')).toEqual([])
    expect(decoder.push('{"type":"stream_event","event":{"type":"content_block_delta","index":0}}')).toEqual([])
    expect(decoder.push('{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"citations_delta"}}}')).toEqual([])
  })
})

describe('lineSplitter', () => {
  it('joins partial chunks and holds an unterminated tail', () => {
    const split = lineSplitter()
    expect(split('{"a":1}\n{"b":')).toEqual(['{"a":1}'])
    expect(split('2}\n')).toEqual(['{"b":2}'])
    expect(split('')).toEqual([])
    expect(split('x\ny\n')).toEqual(['x', 'y'])
    // A chunk with no line break at all completes nothing and is held whole.
    expect(split('tail without a break')).toEqual([])
    expect(split('\n')).toEqual(['tail without a break'])
  })
})
