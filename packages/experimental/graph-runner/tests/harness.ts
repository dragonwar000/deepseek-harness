/** Shared harness: a real agent loop, the real spawn provider, a scripted model, a scripted shell. */

import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { FsTargetKey } from '@deepseek-ai/dsh-fs'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ShellExecRequest, ShellExecSpec, ShellRunResult } from '@deepseek-ai/dsh-shell'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { STRUCTURED_OUTPUT_TOOL } from '@deepseek-ai/dsh-subagent-in-process-driver'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import * as GraphContract from '@deepseek-ai/dsh-experimental-graph-contract'
import type { GraphNodeRecord, GraphRunRecord } from '@deepseek-ai/dsh-experimental-graph-contract'
import * as GraphProjection from '@deepseek-ai/dsh-experimental-graph-projection'
import * as GraphRunner from '../src/index.ts'
import type { Config } from '../src/index.ts'
import type { RunShell } from '../src/runner.ts'
import { MockAdapter, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

export const VERDICT = { type: 'object', properties: { verdict: { type: 'string', enum: ['pass', 'fail'] } }, required: ['verdict'], additionalProperties: false }
export const SUMMARY = { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'], additionalProperties: false }

/** Options of the L2 fixture plan: anchor → build → fresh check → report. */
export interface PlanOptions {
  buildInstruction?: string
  buildVerify?: string[]
  buildRetry?: number
  checkRetry?: number
  buildTools?: string[]
  gate?: boolean
  checkVerify?: string[]
  specMayFail?: boolean
  buildInputs?: Record<string, unknown>[]
  runInputs?: string[]
  buildCategory?: string
}

/** Output of an anchor that declares a path it would report. */
export const PATH = { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false }

export function l2Plan(options: PlanOptions = {}): Record<string, unknown> {
  const gate = options.gate === true
  return {
    format: 'dsh-graph/v1', id: 'ship', level: 'L2', goal: 'Ship the fix', runInputs: options.runInputs ?? [],
    nodes: [
      { id: 'spec', kind: 'anchor', instruction: 'The spec exists', verify: ['check-spec'], output: PATH, mayFail: options.specMayFail ?? false },
      {
        id: 'build', kind: 'execution', instruction: options.buildInstruction ?? 'Fix the parser', needs: ['spec'],
        tools: options.buildTools ?? ['read'], writes: ['src'], verify: options.buildVerify ?? [], output: SUMMARY, retryBudget: options.buildRetry ?? 0,
        inputs: options.buildInputs ?? [],
        ...options.buildCategory === undefined ? {} : { category: options.buildCategory },
      },
      { id: 'check', kind: 'verification', instruction: 'Check the fix', needs: ['build'], tools: ['read'], contextScope: 'fresh-independent', output: VERDICT, retryBudget: options.checkRetry ?? 0, verify: options.checkVerify ?? [] },
      ...gate ? [{ id: 'approve', kind: 'human_gate', instruction: 'Approve the release', needs: ['check'] }] : [],
      {
        id: 'report', kind: 'synthesis', instruction: 'Summarize the result', needs: [gate ? 'approve' : 'check'],
        inputs: gate ? [] : [{ name: 'verdict', from: 'check', field: 'verdict' }], output: SUMMARY,
      },
    ],
    edges: [
      { from: 'spec', to: 'build', relation: 'anchors', artifact: 'SPEC.md' },
      { from: 'build', to: 'check', relation: 'verifies', artifact: 'src/' },
      ...gate
        ? [{ from: 'check', to: 'approve', relation: 'feeds', artifact: 'verdict' }, { from: 'approve', to: 'report', relation: 'hands_off', artifact: 'approval' }]
        : [{ from: 'check', to: 'report', relation: 'feeds', artifact: 'verdict' }],
    ],
    deliverable: 'A verified fix', acceptance: ['pnpm test passes'],
  }
}

export const audit = (id: string, plan: Record<string, unknown>): StreamChunk[] => toolCallResponse(id, 'graph_audit', { plan })
export const run = (id: string, args: object = { plan_id: 'ship' }): StreamChunk[] => toolCallResponse(id, 'graph_run', args)
export const structured = (id: string, value: object): StreamChunk[] => toolCallResponse(id, STRUCTURED_OUTPUT_TOOL, value)

/** A shell whose commands exit with the scripted code (default 0), recording each command. */
export interface ScriptedShell extends RunShell {
  readonly commands: string[]
}

export function scriptedShell(exitCodes: Readonly<Record<string, number>>): ScriptedShell {
  const commands: string[] = []
  return {
    commands,
    resolve(request: ShellExecRequest): ShellExecSpec {
      return { command: request.command, workdir: request.workdir ?? '/work', timeoutMs: request.timeoutMs ?? 1000, onExpiry: 'kill', stdoutMaxBytes: 65536, sandboxPolicy: undefined }
    },
    async execute(spec: ShellExecSpec) {
      commands.push(spec.command)
      const exitCode = exitCodes[spec.command] ?? 0
      const result: ShellRunResult = {
        exitCode, signal: null, timedOut: false, aborted: false, timeoutMs: spec.timeoutMs,
        stdout: { text: `ran ${spec.command}`, truncated: false },
        stderr: { text: exitCode === 0 ? '' : 'FAIL', truncated: false },
      }
      return { result: async () => result }
    },
  }
}

export interface HarnessOptions {
  runner?: Partial<Config>
  approval?: ApprovalOutcome | 'none'
  shell?: Readonly<Record<string, number>>
  contract?: boolean
  contractMode?: 'shadow' | 'enforce'
  routes?: { category: string; provider: string; model: string }[]
  projection?: boolean
}

/** A mounted harness: context, lead agent, scripted shell, and the probe tool's outcomes. */
export interface Harness {
  ctx: Context
  agent: Agent
  shell: ScriptedShell
  probes: string[]
}

export async function harness(script: StreamChunk[][], options: HarnessOptions = {}): Promise<Harness> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(spawn, { providerName: 'spawn' })
  ctx.tools.register(defineContentToolFixture({ name: 'read', description: 'read', parameters: {}, async execute() { return [{ type: 'text', text: 'ok' }] } }))
  const probes: string[] = []
  ctx.tools.register(defineContentToolFixture({
    name: 'probe',
    description: 'writes site/out.txt through the fs write-intent seam',
    parameters: {},
    async execute(_args, exec) {
      try {
        await ctx.waterfall('fs/write-intent', { targetKey: FsTargetKey('site/out.txt'), displayPath: 'site/out.txt' }, exec, () => undefined)
      } catch (error) {
        probes.push('denied')
        throw error
      }
      probes.push('allowed')
      return [{ type: 'text', text: 'wrote site/out.txt' }]
    },
  }))
  const shell = scriptedShell(options.shell ?? {})
  ctx.provide('shell', shell)
  const approval = options.approval
  if (approval !== undefined) {
    await ctx.plugin(ApprovalService)
    if (approval !== 'none') ctx.on('approval/request', () => Promise.resolve<ApprovalOutcome>(approval))
  }
  if (options.contract !== false) {
    await ctx.plugin(GraphContract, { mode: options.contractMode ?? 'enforce', assumption: 'multi-unit plans need a deterministic audit', allowedTools: ['read', 'probe'], routes: options.routes ?? [] })
  }
  if (options.projection !== false) await ctx.plugin(GraphProjection)
  await ctx.plugin(GraphRunner, {
    mode: 'enforce',
    assumption: 'node agents report completion without proof unless a verifier or a command confirms it',
    maxConcurrent: 1,
    ...options.runner,
  })
  ctx.llm.registerAdapter(['mock'], new MockAdapter(script))
  const agent = await ctx.agentLoop.create(SessionId('lead'), { provider: 'mock', model: 'mock' })
  return { ctx, agent, shell, probes }
}

export async function turn(agent: Agent, text = 'run the plan'): Promise<void> {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await agent.whenIdle()
}

export function nodeRecords(agent: Agent): GraphNodeRecord[] {
  return agent.session.snapshotEvents().flatMap(event => (event.type === 'graph/node' ? [event.data] : []))
}

export function runRecords(agent: Agent): GraphRunRecord[] {
  return agent.session.snapshotEvents().flatMap(event => (event.type === 'graph/run' ? [event.data] : []))
}

export function toolTexts(agent: Agent): string[] {
  return agent.session.snapshotEvents().flatMap(event => (event.type === 'tool/result'
    ? [event.data.message.content.map(block => (block.type === 'text' ? block.text : '')).join('')]
    : []))
}

export function trail(agent: Agent): string[] {
  return nodeRecords(agent).map(record => `${record.nodeId}:${record.status}${record.basis === undefined ? '' : `(${record.basis})`}`)
}
