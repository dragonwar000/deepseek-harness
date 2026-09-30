/** Default-account provider mounting: one product provider per kind, remounted when the default changes. */
import { Context } from '@deepseek-ai/cordis'
import type { AiAccountKind } from '@deepseek-ai/dsh-ai-account'
import { afterEach, expect, it, vi } from 'vitest'

interface Mount { readonly product: string; readonly config: Record<string, unknown>; disposed: boolean }
const mounts = vi.hoisted((): Mount[] => [])

/** Stand-in product plugin that records the configuration each mount received. */
async function product(label: string) {
  const { default: z } = await import('@deepseek-ai/schemastery')
  return {
    name: label,
    inject: [],
    Config: z.object({ providerName: z.string().default(label), env: z.dict(z.string()), permissionMode: z.string() }),
    apply(ctx: Context, config: Record<string, unknown>) {
      const mount: Mount = { product: label, config, disposed: false }
      mounts.push(mount)
      ctx.effect(() => () => { mount.disposed = true })
    },
  }
}
vi.mock('@deepseek-ai/dsh-subagent-claude-code', async () => product('claude-code'))
vi.mock('@deepseek-ai/dsh-subagent-codex', async () => product('codex'))

const { apply, Config, inject, name } = await import('../src/index.ts')

const roots: Context[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
  mounts.length = 0
})

function fixture(initial: Partial<Record<AiAccountKind, string>>) {
  const homes = new Map(Object.entries(initial))
  const ctx = new Context()
  roots.push(ctx)
  ctx.provide('aiAccount', { defaultHome: (kind: AiAccountKind) => homes.get(kind) } as never)
  /** Change one default and let the provider fibers it starts or stops settle. */
  const change = async (kind: AiAccountKind, home: string | undefined) => {
    if (home === undefined) homes.delete(kind)
    else homes.set(kind, home)
    ctx.emit('ai-account/default-changed', kind)
    await new Promise(resolve => setImmediate(resolve))
  }
  return { ctx, change }
}

const live = () => mounts.filter(mount => !mount.disposed).map(({ product, config }) => ({ product, config }))

it('declares the account service as its only injection', () => {
  expect({ name, inject }).toEqual({ name: 'subagent-ai-account', inject: ['aiAccount'] })
  expect(Config({})).toMatchObject({ claudeCode: { providerName: 'claude-code' }, codex: { providerName: 'codex' } })
})

it('mounts each product only for a kind with a default account and layers the account directory over env', async () => {
  const { ctx } = fixture({ claude: '/accounts/claude/a' })
  await ctx.plugin({ name, inject, apply }, { claudeCode: { providerName: 'claude-code', env: { KEEP: '1' }, permissionMode: 'plan' } })
  expect(live()).toEqual([
    { product: 'claude-code', config: { providerName: 'claude-code', env: { KEEP: '1', CLAUDE_CONFIG_DIR: '/accounts/claude/a' }, permissionMode: 'plan' } },
  ])
})

it('remounts on a default change, ignores other kinds and unchanged homes, and unmounts on removal', async () => {
  const { ctx, change } = fixture({})
  const fiber = await ctx.plugin({ name, inject, apply }, {})
  expect(live()).toEqual([])
  await change('chatgpt', '/accounts/codex/a')
  expect(live()).toEqual([{ product: 'codex', config: { providerName: 'codex', env: { CODEX_HOME: '/accounts/codex/a' } } }])
  await change('chatgpt', '/accounts/codex/a')
  await change('claude', undefined)
  expect(mounts).toHaveLength(1)
  await change('chatgpt', '/accounts/codex/b')
  expect(mounts.map(mount => mount.disposed)).toEqual([true, false])
  expect(live()).toEqual([{ product: 'codex', config: { providerName: 'codex', env: { CODEX_HOME: '/accounts/codex/b' } } }])
  await change('chatgpt', undefined)
  expect(live()).toEqual([])
  await change('claude', '/accounts/claude/a')
  await fiber.dispose()
  expect(live()).toEqual([])
})
