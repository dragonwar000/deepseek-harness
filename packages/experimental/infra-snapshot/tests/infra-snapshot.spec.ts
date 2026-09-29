import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import ShellExecutor from '@deepseek-ai/dsh-shell'
import type { ShellExecRequest, ShellExecSpec, ShellExecution } from '@deepseek-ai/dsh-shell'
import * as InfraSnapshot from '@deepseek-ai/dsh-experimental-infra-snapshot'

/** Shell double whose `sandboxMode` getter reports a fixed mode; `resolve`/`execute` are unused by this plugin. */
class FixedSandboxShell extends ShellExecutor {
  override get sandboxMode(): 'read-only' {
    return 'read-only'
  }

  resolve(_request: ShellExecRequest): ShellExecSpec {
    throw new Error('unused in this test')
  }

  execute(_spec: ShellExecSpec): Promise<ShellExecution> {
    throw new Error('unused in this test')
  }
}

async function harness(config: InfraSnapshot.Config, mountShell = false): Promise<Context> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  if (mountShell) await ctx.plugin(FixedSandboxShell)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(InfraSnapshot, config)
  return ctx
}

function snapshots(agent: Agent): InfraSnapshot.InfraSnapshot[] {
  return agent.session.snapshotEvents()
    .filter((e): e is SessionEvent<'infra/snapshot'> => e.type === 'infra/snapshot')
    .map(e => e.data)
}

describe('infra-snapshot', () => {
  it('appends one infra/snapshot per created agent', async () => {
    const ctx = await harness({})
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    const found = snapshots(agent)
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ node: process.version, platform: process.platform, arch: process.arch, sandboxMode: 'none' })
    expect(found[0]!.cpus).toBeGreaterThan(0)
    expect(found[0]!.totalMemMb).toBeGreaterThan(0)
  })

  it('reads sandboxMode from a mounted shell instead of falling back to none', async () => {
    const ctx = await harness({}, true)
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    expect(snapshots(agent)[0]).toMatchObject({ sandboxMode: 'read-only' })
  })

  describe('sources filter', () => {
    it('appends nothing for a creation source absent from `sources`', async () => {
      const ctx = await harness({ sources: ['resume'] })
      const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
      expect(snapshots(agent)).toEqual([])
    })

    it('appends for a creation source present in `sources`', async () => {
      const ctx = await harness({ sources: ['startup'] })
      const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
      expect(snapshots(agent)).toHaveLength(1)
    })
  })
})
