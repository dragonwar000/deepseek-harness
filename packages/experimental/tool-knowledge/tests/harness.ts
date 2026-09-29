/** Agent-level harness: fs tools, the wiki store, approval, and the knowledge tools, driven by a scripted model. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as KnowledgeInvariant from '@deepseek-ai/dsh-experimental-knowledge/invariant'
import WikiFilesystemKnowledge from '@deepseek-ai/dsh-experimental-knowledge-wiki-filesystem'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import * as FsPolicy from '@deepseek-ai/dsh-fs-observation-policy'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import * as ToolKnowledge from '../src/index.ts'
import type { Config } from '../src/index.ts'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

/** Harness options. */
export interface HarnessOptions {
  files?: Record<string, string>
  calls?: { name: string; args: object }[]
  config?: Config
  approval?: ApprovalOutcome
  sessionCwd?: boolean
  before?: (ctx: Context) => void
}

/** A finished run. */
export interface Run {
  ctx: Context
  agent: Agent
  dir: string
  /** Fiber of the tool-knowledge plugin. */
  tools: Fiber
}

const dirs: string[] = []

/**
 * Remove every workspace the harness created.
 */
export function cleanup(): void {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
}

/**
 * Mount the stack, run one user turn with the scripted calls, and wait for idle.
 * @param options - files, calls, tool config, approval outcome.
 * @returns the context, the agent, and the workspace directory.
 */
export async function run(options: HarnessOptions = {}): Promise<Run> {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tool-knowledge-'))
  dirs.push(dir)
  for (const [path, content] of Object.entries(options.files ?? {})) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), content)
  }
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  // Every applied knowledge/write these tests produce must cite a successful tool/result of its session.
  await ctx.plugin(KnowledgeInvariant)
  await ctx.plugin(LocalFileSystem, { cwd: dir })
  await ctx.plugin(FsPolicy)
  await ctx.plugin(ToolFs)
  await ctx.plugin(WikiFilesystemKnowledge, {})
  if (options.approval !== undefined) {
    await ctx.plugin(ApprovalService)
    const outcome = options.approval
    ctx.on('approval/request', () => Promise.resolve<ApprovalOutcome>(outcome))
  }
  const tools = await ctx.plugin(ToolKnowledge, options.config ?? {})
  options.before?.(ctx)
  ctx.llm.registerAdapter(['mock'], new MockAdapter([
    ...(options.calls ?? []).map((call, index) => toolCallResponse(`c${index}`, call.name, call.args)),
    textResponse('done'),
  ]))
  const agent = await ctx.agentLoop.create(SessionId('lead'), { provider: 'mock', model: 'mock' }, options.sessionCwd === true ? { cwd: dir } : {})
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'record what you learned' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  return { ctx, agent, dir, tools }
}

/**
 * Tool results in order.
 * @param agent - finished agent.
 * @returns text and error flag of each result.
 */
export function results(agent: Agent): { text: string; isError: boolean; seq: number }[] {
  return agent.session.snapshotEvents().flatMap(event => (event.type === 'tool/result'
    ? [{ text: event.data.message.content.map(block => (block.type === 'text' ? block.text : '')).join(''), isError: event.data.message.isError === true, seq: event.seq }]
    : []))
}

/**
 * Logged `knowledge/write` records.
 * @param agent - finished agent.
 * @returns the records.
 */
export function writes(agent: Agent): SessionEvent<'knowledge/write'>['data'][] {
  return agent.session.snapshotEvents().flatMap(event => (event.type === 'knowledge/write' ? [event.data] : []))
}

/**
 * Page text with frontmatter lines and a body.
 * @param fields - frontmatter lines.
 * @param body - body text.
 * @returns the file text.
 */
export function page(fields: string[], body = ''): string {
  return `---\n${fields.join('\n')}\n---\n\n${body}\n`
}
