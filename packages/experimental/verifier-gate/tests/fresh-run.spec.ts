import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentProvider, SubagentResult, SubagentRun, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import { freshProviderProblem, runFresh } from '../src/fresh-run.ts'
import type { FreshRunRequest, FreshRunStarter } from '../src/fresh-run.ts'

const CAPABILITIES = { agentOptions: true, outputSchema: true, depthLimit: true, toolFilter: true, persona: true }

function provider(overrides: Partial<Pick<SubagentProvider, 'inheritsParentContext' | 'capabilities'>> = {}): SubagentProvider {
  return {
    name: 'p',
    capabilities: CAPABILITIES,
    inheritsParentContext: false,
    ...overrides,
    start: () => Promise.reject(new Error('unused')),
  }
}

function request(overrides: Partial<FreshRunRequest> = {}): FreshRunRequest {
  return {
    provider: 'p',
    label: 'probe',
    parent: {} as Agent,
    prompt: [{ type: 'text', text: 'judge' }],
    persona: 'reviewer',
    toolFilter: { allow: [] },
    outputSchema: { type: 'object' },
    timeoutMs: 1000,
    signal: new AbortController().signal,
    ...overrides,
  }
}

/** A starter whose one run settles through `settle`; it records the start request and disposal. */
function starter(settle: (signal: AbortSignal) => Promise<SubagentResult>): {
  start: FreshRunStarter
  seen: { request?: SubagentStartRequest; disposed: boolean }
} {
  const seen: { request?: SubagentStartRequest; disposed: boolean } = { disposed: false }
  const start: FreshRunStarter = {
    start(_name, startRequest) {
      seen.request = startRequest
      const run: SubagentRun = {
        id: SessionId('child'),
        localAgent: undefined,
        result: settle(startRequest.signal),
        dispose: () => {
          seen.disposed = true
          return Promise.resolve()
        },
      }
      return Promise.resolve(run)
    },
  }
  return { start, seen }
}

describe('runFresh', () => {
  it('starts a fresh structured child with the requested composition and disposes it', async () => {
    const { start, seen } = starter(() => Promise.resolve({ output: [], stopReason: 'completed', structured: { verdict: 'ok' } }))
    const caller = new AbortController()
    const outcome = await runFresh(start, request({ signal: caller.signal }))
    expect(outcome).toEqual({ kind: 'settled', childId: 'child', stopReason: 'completed', structured: { verdict: 'ok' } })
    expect(seen.request).toMatchObject({
      label: 'probe',
      prompt: [{ type: 'text', text: 'judge' }],
      persona: 'reviewer',
      toolFilter: { allow: [] },
      outputSchema: { type: 'object' },
    })
    expect(seen.request).not.toHaveProperty('agentOptions')
    expect(seen.request?.signal).not.toBe(caller.signal)
    expect(seen.disposed).toBe(true)
  })

  it('forwards agent options when the caller sets them', async () => {
    const { start, seen } = starter(() => Promise.resolve({ output: [], stopReason: 'completed' }))
    const outcome = await runFresh(start, request({ agentOptions: { maxTokens: 64 } }))
    expect(outcome).toEqual({ kind: 'settled', childId: 'child', stopReason: 'completed', structured: undefined })
    expect(seen.request?.agentOptions).toEqual({ maxTokens: 64 })
  })

  it('cancels the child when the time limit expires', async () => {
    const { start } = starter(signal => new Promise((resolve) => {
      signal.addEventListener('abort', () => { resolve({ output: [], stopReason: 'aborted' }) }, { once: true })
    }))
    expect(await runFresh(start, request({ timeoutMs: 10 }))).toMatchObject({ kind: 'settled', stopReason: 'aborted' })
  })

  it('cancels the child when the caller aborts', async () => {
    const { start } = starter(signal => new Promise((resolve) => {
      signal.addEventListener('abort', () => { resolve({ output: [], stopReason: 'aborted' }) }, { once: true })
    }))
    const caller = new AbortController()
    const pending = runFresh(start, request({ signal: caller.signal, timeoutMs: 60_000 }))
    caller.abort()
    expect(await pending).toMatchObject({ kind: 'settled', stopReason: 'aborted' })
  })

  it('settles a start rejection as a start failure', async () => {
    const failing: FreshRunStarter = { start: () => Promise.reject(new Error('no subagent provider registered for "p"')) }
    expect(await runFresh(failing, request())).toEqual({
      kind: 'failed',
      stage: 'start',
      message: 'Error: no subagent provider registered for "p"',
    })
  })

  it('settles a result rejection as a result failure after disposing the run', async () => {
    const { start, seen } = starter(() => Promise.reject(new Error('transport lost')))
    expect(await runFresh(start, request())).toEqual({ kind: 'failed', stage: 'result', message: 'Error: transport lost', childId: 'child' })
    expect(seen.disposed).toBe(true)
  })
})

describe('freshProviderProblem', () => {
  it('accepts a fresh provider with every needed capability', () => {
    expect(freshProviderProblem(provider(), true)).toBeUndefined()
  })

  it('rejects a provider that starts children with the parent conversation', () => {
    expect(freshProviderProblem(provider({ inheritsParentContext: true }), false))
      .toBe('provider "p" starts children with the parent conversation')
  })

  it('names every missing capability', () => {
    const lacking = provider({ capabilities: { ...CAPABILITIES, outputSchema: false, persona: false, agentOptions: false } })
    expect(freshProviderProblem(lacking, false)).toBe('provider "p" lacks outputSchema, persona')
    expect(freshProviderProblem(lacking, true)).toBe('provider "p" lacks outputSchema, persona, agentOptions')
  })
})
