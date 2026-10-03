/**
 * The route as a composition actually boots it: the real Loader, the real package name the Base
 * Bundle row names, and the real `llm` and `sessions` services beside it.
 *
 * Only the process boundary is scripted. Everything the row depends on to mount — the plugin's
 * schemastery `Config`, the dormant registration, the directory entry, and the tool-emulation path
 * with its session record — is exercised through the Loader rather than through a direct
 * `ctx.plugin` call, so a row that would not load in a shipped profile fails here.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context, FiberState } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import type { ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it } from 'vitest'
import ClaudeCliRoute, { PREAMBLE_TEMPLATE } from '../src/index.ts'
import { FakeAiAccount, FakeCli, FakeSubprocessRuntime, streamLines } from './harness.ts'
import type { FakeCliScript } from './harness.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Boot one YAML composition with the shipped package names resolved to this checkout. */
async function loadYaml(
  lines: readonly string[],
  options: { readonly script?: FakeCliScript; readonly account?: string } = {},
): Promise<{ ctx: Context; cli: FakeCli }> {
  root = await mkdtemp(join(tmpdir(), 'dsh-claude-cli-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [...lines, ''].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = `${pathToFileURL(root).href}/`
  const cli = new FakeCli(options.script ?? {})
  // The subprocess seam and the AI Account provider stand in for a real CLI and a real sign-in;
  // everything the row itself declares still travels through the Loader.
  await ctx.plugin(FakeSubprocessRuntime, cli)
  if (options.account !== undefined) await ctx.plugin(FakeAiAccount, { home: options.account })
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-llm-claude-cli', ClaudeCliRoute],
  ])
  // Only `import` is reached: the Loader resolves a row's package name through this one method, so
  // the stub declares the two members it uses and asserts to the loader shape rather than to
  // `unknown`.
  const internal: Pick<ModuleLoaderV2, 'version' | 'import'> = {
    version: 'v2',
    import: (specifier: string) => {
      const module = modules.get(specifier)
      if (module === undefined) throw new Error(`unexpected Loader import: ${specifier}`)
      return Promise.resolve(module)
    },
  }
  ctx.loader.internal = internal as ModuleLoaderV2
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return { ctx, cli }
}

/** The YAML a profile patch writes to enable the Base Bundle's disabled row. */
function composition(config: readonly string[] = []): readonly string[] {
  return [
    "- name: '@deepseek-ai/dsh-llm'",
    "- name: '@deepseek-ai/dsh-session'",
    "- name: '@deepseek-ai/dsh-llm-claude-cli'",
    '  id: llm-claude-cli',
    ...(config.length === 0 ? [] : ['  config:', ...config.map(line => `    ${line}`)]),
  ]
}

describe('real Loader composition', () => {
  it('loads the shipped row and leaves the route dormant with no Claude account', async () => {
    const { ctx } = await loadYaml(composition(['cliPath: claude', 'maxConcurrent: 2']))
    const unloaded = [...ctx.loader.entries()]
      .filter(entry => entry.fiber === undefined && !entry.disabled)
      .map(entry => entry.options.name)
    expect(unloaded).toEqual([])
    expect(ctx.llm.listProviders()).toEqual([])
    // Dormant, but addressable: Settings can reach the route before anyone signs in.
    expect(ctx.llm.listConfigurableProviders()).toEqual([
      expect.objectContaining({ provider: 'claude-cli', settingsNs: 'llm-claude-cli' }),
    ])
  })

  it('serves a tool-declaring turn through the loaded row and logs the emulated run', async () => {
    const { ctx } = await loadYaml(
      composition(['toolCallRetries: 0']),
      {
        account: '/accounts/claude/one',
        script: {
          inference: () => streamLines('```dsh-tool-call\n{"name":"read_file","arguments":{"path":"/a"}}\n```'),
        },
      },
    )
    expect(ctx.llm.listProviders()).toEqual([{ id: 'claude-cli', name: 'Claude (Claude Code CLI)' }])
    const session = ctx.sessions.create()
    const chunks: StreamChunk[] = []
    for await (const chunk of ctx.llm.stream({
      provider: 'claude-cli',
      model: 'opus',
      tools: [{ name: 'read_file', description: 'Read a file', parameters: { type: 'object' } }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'read /a' }] }],
      sessionId: session.id,
    })) chunks.push(chunk)
    const call = chunks.find(chunk => chunk.type === 'tool-call-delta')
    expect(call?.type === 'tool-call-delta' && call.name).toBe('read_file')
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
    const logged = session.snapshotEvents().filter(event => event.type === 'llm/cli-tool-emulation')
    expect(logged.map(event => event.data.template)).toEqual([PREAMBLE_TEMPLATE])
  })

  it('leaves the row unloaded when its extraArgs would change how the CLI authenticates', async () => {
    // Fail loud at load: the row must not mount and then meet the flag on a user's first message.
    const { ctx } = await loadYaml(composition(['extraArgs:', '  - --bare']))
    const row = [...ctx.loader.entries()].find(entry => entry.options.id === 'llm-claude-cli')
    expect(row?.fiber?.state).not.toBe(FiberState.ACTIVE)
    // The row contributed nothing: no route and no Settings entry to reach a broken one through.
    expect(ctx.llm.listConfigurableProviders()).toEqual([])
    expect(ctx.llm.listProviders()).toEqual([])
  })

  it('names the forbidden flag when the plugin is applied directly', async () => {
    const ctx = new Context()
    context = ctx
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(FakeSubprocessRuntime, new FakeCli())
    await expect(ctx.plugin(ClaudeCliRoute, { extraArgs: ['--bare'] })).rejects.toThrow(/--bare/)
  })
})
