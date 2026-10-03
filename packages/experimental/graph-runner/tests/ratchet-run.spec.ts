import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { Agent } from '@deepseek-ai/dsh-agent'
import * as GraphContract from '@deepseek-ai/dsh-experimental-graph-contract'
import * as GraphProjection from '@deepseek-ai/dsh-experimental-graph-projection'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ShellExecRequest, ShellExecSpec, ShellRunResult } from '@deepseek-ai/dsh-shell'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import * as GraphRunner from '../src/index.ts'
import type { RunShell } from '../src/runner.ts'
import { audit, l2Plan, nodeRecords, run, structured, turn } from './harness.ts'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A shell that runs every command with `sh -c` in its working directory, so metrics, verify commands, and removals are real. */
function realShell(): RunShell {
  return {
    resolve(request: ShellExecRequest): ShellExecSpec {
      return {
        command: request.command,
        workdir: request.workdir ?? process.cwd(),
        timeoutMs: request.timeoutMs ?? 10_000,
        onExpiry: 'kill',
        stdoutMaxBytes: 65_536,
        sandboxPolicy: undefined,
      }
    },
    async execute(spec: ShellExecSpec) {
      const outcome = spawnSync('sh', ['-c', spec.command], { cwd: spec.workdir, encoding: 'utf8' })
      const result: ShellRunResult = {
        exitCode: outcome.status,
        signal: null,
        timedOut: false,
        aborted: false,
        timeoutMs: spec.timeoutMs,
        stdout: { text: outcome.stdout, truncated: false },
        stderr: { text: outcome.stderr, truncated: false },
      }
      return { result: async () => result }
    },
  }
}

interface Setup {
  /** Run with the file service mounted; false leaves the ratchet without files. */
  files?: boolean
  mode?: 'enforce' | 'shadow'
  metric?: string
  verify?: string[]
  retry?: number
}

/**
 * Mount the plan runner over a real workspace and a real shell, with a scripted model.
 * @param script - model responses, the lead's first and the children's after.
 * @param setup - the ratchet and plan options.
 * @returns the lead agent and the workspace root.
 */
async function setup(script: StreamChunk[][], setup: Setup = {}): Promise<{ agent: Agent; root: string }> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-graph-ratchet-'))
  roots.push(root)
  mkdirSync(join(root, 'src'))
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(spawn, { providerName: 'spawn' })
  if (setup.files !== false) await ctx.plugin(LocalFileSystem, { cwd: root })
  ctx.provide('shell', realShell())
  ctx.tools.register(defineContentToolFixture({ name: 'read', description: 'read', parameters: {}, async execute() { return [{ type: 'text', text: 'ok' }] } }))
  ctx.tools.register(defineContentToolFixture({
    name: 'scribble',
    description: 'writes one workspace file',
    parameters: {},
    async execute(args) {
      const { path, content } = args as { path: string; content: string }
      await ctx.fs.writeText(await ctx.fs.resolve(path, { cwd: root }), content)
      return [{ type: 'text', text: `wrote ${path}` }]
    },
  }))
  await ctx.plugin(GraphContract, {
    mode: 'enforce',
    assumption: 'multi-unit plans need a deterministic audit',
    allowedTools: ['read', 'probe', 'scribble'],
    routes: [],
  })
  await ctx.plugin(GraphProjection)
  await ctx.plugin(GraphRunner, {
    mode: setup.mode ?? 'enforce',
    assumption: 'node agents report completion without proof unless a verifier or a command confirms it',
    maxConcurrent: 1,
    ratchetMetric: setup.metric ?? 'wc -l < src/a.txt',
    ratchetDirection: 'max',
  })
  ctx.llm.registerAdapter(['mock'], new MockAdapter(script))
  const agent = await ctx.agentLoop.create(SessionId('lead'), { provider: 'mock', model: 'mock' }, { cwd: root })
  return { agent, root }
}

/**
 * The fixture plan: an anchor that passes, then the build node whose verify always fails.
 * @param options - build node retries, verify commands, and tools.
 * @returns the plan.
 */
function plan(options: { retry?: number; verify?: string[] } = {}): Record<string, unknown> {
  const built = l2Plan({ buildVerify: options.verify ?? ['false'], buildRetry: options.retry ?? 2, buildTools: ['scribble'] })
  const nodes = built['nodes'] as Record<string, unknown>[]
  nodes[0]!['verify'] = ['true']
  return built
}

const scribble = (id: string, path: string, content: string): StreamChunk[] => toolCallResponse(id, 'scribble', { path, content })

/** One failed build attempt with its ratchet comparison, when it has one. */
interface FailedAttempt {
  attempt: number
  score: number | null | undefined
  action: string | undefined
  restored: number | undefined
  leftovers: string[] | undefined
}

/**
 * The build node's failed attempts in order.
 * @param agent - the lead agent whose session holds the node records.
 * @returns each attempt's number and its ratchet comparison.
 */
function failedAttempts(agent: Agent): FailedAttempt[] {
  return nodeRecords(agent)
    .filter(record => record.nodeId === 'build' && record.status === 'failed_retryable')
    .map(record => ({
      attempt: record.attempt,
      score: record.ratchet?.score,
      action: record.ratchet?.action,
      restored: record.ratchet?.restored,
      leftovers: record.ratchet?.leftovers,
    }))
}

describe('keep-best ratchet for graph node retries', () => {
  it('keeps the best attempt and returns the write scopes to it before each retry', async () => {
    const { agent, root } = await setup([
      audit('a', plan({ retry: 3 })), run('r'),
      scribble('s1', 'src/a.txt', 'one\ntwo\nthree\n'), structured('b1', { summary: 'three' }),
      scribble('s2', 'src/a.txt', 'one\n'), scribble('s3', 'src/extra.txt', 'x\n'), scribble('s4', 'src/a b.txt', 'y\n'), structured('b2', { summary: 'one' }),
      scribble('s5', 'src/a.txt', 'one\ntwo\n'), structured('b3', { summary: 'two' }),
      scribble('s6', 'src/a.txt', 'one\ntwo\nthree\nfour\nfive\n'), structured('b4', { summary: 'five' }),
      textResponse('done'),
    ])
    await turn(agent)
    expect(readFileSync(join(root, 'src/a.txt'), 'utf8')).toBe('one\ntwo\nthree\nfour\nfive\n')
    expect(existsSync(join(root, 'src/extra.txt'))).toBe(false)
    expect(existsSync(join(root, 'src/a b.txt'))).toBe(true)
    expect(failedAttempts(agent).map(entry => [entry.attempt, entry.score, entry.action, entry.restored, entry.leftovers])).toEqual([
      [1, 3, 'kept', 0, []],
      [2, 1, 'reverted', 2, ['src/a b.txt']],
      [3, 2, 'reverted', 1, ['src/a b.txt']],
      [4, 5, 'kept', 0, []],
    ])
    const best = nodeRecords(agent).filter(record => record.nodeId === 'build' && record.status === 'failed_retryable')
    expect(best.map(record => record.ratchet?.bestAttempt)).toEqual([1, 1, 1, 4])
    expect(nodeRecords(agent).find(record => record.nodeId === 'build' && record.status === 'failed')?.ratchet).toBeUndefined()
  })

  it('records the restores it would make without writing in shadow mode', async () => {
    const { agent, root } = await setup([
      audit('a', plan({ retry: 2 })), run('r'),
      scribble('s1', 'src/a.txt', 'one\ntwo\nthree\n'), structured('b1', { summary: 'three' }),
      scribble('s2', 'src/a.txt', 'one\n'), scribble('s3', 'src/extra.txt', 'x\n'), structured('b2', { summary: 'one' }),
      scribble('s4', 'src/a.txt', 'one\ntwo\n'), structured('b3', { summary: 'two' }),
      textResponse('done'),
    ], { mode: 'shadow' })
    await turn(agent)
    expect(readFileSync(join(root, 'src/a.txt'), 'utf8')).toBe('one\ntwo\n')
    expect(existsSync(join(root, 'src/extra.txt'))).toBe(true)
    expect(failedAttempts(agent).map(entry => entry.action)).toEqual(['kept', 'shadow', 'shadow'])
  })

  it('reverts an attempt whose metric command fails', async () => {
    const { agent, root } = await setup([
      audit('a', plan({ retry: 1 })), run('r'),
      scribble('s1', 'src/a.txt', 'one\ntwo\nthree\n'), structured('b1', { summary: 'three' }),
      scribble('s2', 'src/fail.txt', 'x\n'), structured('b2', { summary: 'failing' }),
      textResponse('done'),
    ], { metric: 'test ! -f src/fail.txt && wc -l < src/a.txt' })
    await turn(agent)
    expect(existsSync(join(root, 'src/fail.txt'))).toBe(false)
    expect(failedAttempts(agent).map(entry => [entry.attempt, entry.score, entry.action, entry.restored])).toEqual([[1, 3, 'kept', 0], [2, null, 'reverted', 1]])
  })

  it('keeps nothing and restores nothing when the metric prints no number', async () => {
    const { agent, root } = await setup([
      audit('a', plan({ retry: 2 })), run('r'),
      scribble('s1', 'src/a.txt', 'one\ntwo\n'), structured('b1', { summary: 'one' }),
      scribble('s2', 'src/extra.txt', 'x\n'), structured('b2', { summary: 'two' }),
      structured('b3', { summary: 'three' }),
      textResponse('done'),
    ], { metric: 'echo nope' })
    await turn(agent)
    expect(existsSync(join(root, 'src/extra.txt'))).toBe(true)
    expect(failedAttempts(agent).map(entry => [entry.score, entry.action])).toEqual([[null, 'skipped'], [null, 'skipped'], [null, 'skipped']])
  })

  it('skips keeping an attempt whose write scope holds text the snapshot cannot read', async () => {
    const verify = ["test -f src/blob.bin || printf '\\377\\376' > src/blob.bin; false"]
    const { agent } = await setup([
      audit('a', plan({ retry: 1, verify })), run('r'),
      scribble('s1', 'src/a.txt', 'one\n'), structured('b1', { summary: 'one' }),
      scribble('s2', 'src/a.txt', 'one\ntwo\n'), structured('b2', { summary: 'two' }),
      textResponse('done'),
    ])
    await turn(agent)
    expect(failedAttempts(agent).map(entry => [entry.score, entry.action])).toEqual([[1, 'skipped'], [2, 'skipped']])
  })

  it('returns a node that gives up to its best attempt when its last attempt never reached verification', async () => {
    const { agent, root } = await setup([
      audit('a', plan({ retry: 1 })), run('r'),
      scribble('s1', 'src/a.txt', 'one\ntwo\nthree\n'), structured('b1', { summary: 'three' }),
      scribble('s2', 'src/a.txt', 'one\n'), structured('b2', { summary: 7 }),
      textResponse('done'),
    ])
    await turn(agent)
    expect(readFileSync(join(root, 'src/a.txt'), 'utf8')).toBe('one\ntwo\nthree\n')
    const gaveUp = nodeRecords(agent).find(record => record.nodeId === 'build' && record.status === 'failed')
    expect(gaveUp?.ratchet).toMatchObject({ attempt: 2, bestAttempt: 1, bestScore: 3, action: 'reverted', restored: 1 })
  })

  it('does not measure a node without retries', async () => {
    const { agent, root } = await setup([
      audit('a', plan({ retry: 0 })), run('r'),
      scribble('s1', 'src/a.txt', 'one\ntwo\nthree\n'), structured('b1', { summary: 'three' }),
      textResponse('done'),
    ])
    await turn(agent)
    expect(readFileSync(join(root, 'src/a.txt'), 'utf8')).toBe('one\ntwo\nthree\n')
    const build = nodeRecords(agent).filter(record => record.nodeId === 'build')
    expect(build.map(record => record.status)).toEqual(['running', 'failed_retryable', 'failed'])
    expect(build.map(record => record.ratchet)).toEqual([undefined, undefined, undefined])
  })

  it('does not measure without a mounted file service', async () => {
    const { agent } = await setup([
      audit('a', plan({ retry: 1 })), run('r'),
      structured('b1', { summary: 'one' }),
      structured('b2', { summary: 'two' }),
      textResponse('done'),
    ], { files: false })
    await turn(agent)
    const build = nodeRecords(agent).filter(record => record.nodeId === 'build' && record.status === 'failed_retryable')
    expect(build).toHaveLength(2)
    expect(build.map(record => record.ratchet)).toEqual([undefined, undefined])
  })
})
