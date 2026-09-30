/**
 * Mount the Claude Code and Codex subagent providers for the default AI Account of each kind.
 * Each provider instance receives the default account's CLI configuration directory through
 * its `env` overlay (`CLAUDE_CONFIG_DIR` or `CODEX_HOME`), so the official product CLI runs
 * with that account's own stored login. A kind without a default account has no provider.
 *
 * @module @deepseek-ai/dsh-subagent-ai-account
 */
import type { Context, Fiber } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { AiAccountKind } from '@deepseek-ai/dsh-ai-account'
import * as claudeCode from '@deepseek-ai/dsh-subagent-claude-code'
import * as codex from '@deepseek-ai/dsh-subagent-codex'

export const name = 'subagent-ai-account'
export const inject = ['aiAccount']

/** Provider row configuration for each product; the account directory is layered over each `env`. */
export interface Config {
  /** `@deepseek-ai/dsh-subagent-claude-code` configuration for the default Claude account (provider name defaults to `claude-code`). */
  claudeCode?: claudeCode.Config
  /** `@deepseek-ai/dsh-subagent-codex` configuration for the default ChatGPT account (provider name defaults to `codex`). */
  codex?: codex.Config
}

export const Config: z<Config> = z.object({
  claudeCode: claudeCode.Config,
  codex: codex.Config,
})

/** One product provider bound to one account kind. */
interface ProductBinding {
  readonly kind: AiAccountKind
  readonly plugin: typeof claudeCode | typeof codex
  readonly homeEnv: 'CLAUDE_CONFIG_DIR' | 'CODEX_HOME'
  readonly config: claudeCode.Config | codex.Config
}

/**
 * Keep one provider fiber per kind mounted for the current default account, replacing it when the default changes.
 * @param ctx - plugin context that owns the provider fibers.
 * @param binding - product plugin, account kind, and provider configuration.
 */
function bind(ctx: Context, binding: ProductBinding): void {
  let mounted: { readonly home: string; readonly fiber: Fiber } | undefined
  const sync = (): void => {
    const home = ctx.aiAccount.defaultHome(binding.kind)
    if (home === mounted?.home) return
    void mounted?.fiber.dispose()
    mounted = undefined
    if (home === undefined) return
    const env = Object.assign({}, binding.config.env, { [binding.homeEnv]: home })
    mounted = { home, fiber: ctx.plugin(binding.plugin, Object.assign({}, binding.config, { env })) }
  }
  ctx.on('ai-account/default-changed', (kind) => { if (kind === binding.kind) sync() })
  sync()
}

/**
 * Bind both product providers to the default AI Accounts.
 * @param ctx - context carrying the AI Account service.
 * @param config - per-product provider configuration.
 */
export function apply(ctx: Context, config: Config): void {
  bind(ctx, { kind: 'claude', plugin: claudeCode, homeEnv: 'CLAUDE_CONFIG_DIR', config: config.claudeCode ?? {} })
  bind(ctx, { kind: 'chatgpt', plugin: codex, homeEnv: 'CODEX_HOME', config: config.codex ?? {} })
}
