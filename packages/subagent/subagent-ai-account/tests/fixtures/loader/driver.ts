#!/usr/bin/env node
/** Boot the headless profile with the AI Account provider Bundle and report the mounted providers and tools. */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-ai-account'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-tools'
import { bootProductionProfile } from '../../../../../test-support/loader-smoke/tests/fixtures/production-profile.ts'

const configPath = process.argv[2]
const bundlePatchPath = process.argv[3]
if (configPath === undefined || bundlePatchPath === undefined) {
  throw new Error('AI Account Loader composition driver requires config and Bundle patch paths')
}

const root = mkdtempSync(join(tmpdir(), 'dsh-ai-account-loader-'))
process.env.AI_ACCOUNT_FIXTURE_ROOT = root
const claude = '00000000-0000-4000-8000-000000000001'
const chatgpt = '00000000-0000-4000-8000-000000000002'
writeFileSync(join(root, 'accounts.json'), JSON.stringify({
  version: 1,
  accounts: [
    { id: claude, kind: 'claude', email: 'claude@example.com', plan: 'max', createdAt: 1 },
    { id: chatgpt, kind: 'chatgpt', email: null, plan: null, createdAt: 2 },
  ],
  defaults: { claude },
}))

let starts = 0
const ctx = await bootProductionProfile({
  binName: 'subagent-ai-account-loader-composition',
  profile: 'headless',
  overlayPaths: [
    resolveConfigPath(bundlePatchPath, undefined),
    resolveConfigPath(configPath, undefined),
  ],
  prepare: (hostCtx) => {
    hostCtx.on('subagent/start', () => { starts += 1 })
  },
})

/** @returns the product providers and delegation tools registered right now. */
function observe() {
  const tools = ctx.tools.schemas().map(schema => schema.name)
  return {
    providers: ctx.subagents.list().filter(name => name === 'claude-code' || name === 'codex').sort(),
    tools: tools.filter(name => name === 'subagent_claude_code' || name === 'subagent_codex').sort(),
  }
}

/** Wait until provider and tool registration settles after a default change. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve))
}

try {
  const initial = observe()
  await ctx.aiAccount.setDefault(chatgpt as never)
  await settle()
  const withCodex = observe()
  await ctx.aiAccount.setDefault(claude as never)
  await settle()
  const unchanged = observe()
  process.stdout.write(`${JSON.stringify({
    initial,
    withCodex,
    unchanged,
    codexHome: ctx.aiAccount.defaultHome('chatgpt') === join(root, 'codex', chatgpt),
    starts,
  })}\n`)
} finally {
  await ctx.fiber.dispose()
  rmSync(root, { recursive: true, force: true })
}
