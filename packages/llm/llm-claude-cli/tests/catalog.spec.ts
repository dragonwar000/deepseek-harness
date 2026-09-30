import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LlmError } from '@deepseek-ai/dsh-llm'
import {
  CLI_CATALOG_UNAVAILABLE,
  CLI_MISSING,
  CLI_NOT_AUTHENTICATED,
  ClaudeCliCatalog,
} from '../src/catalog.ts'
import { AUTH_SIGNED_OUT, catalogLine, FakeCli, MODEL_ROWS } from './harness.ts'
import type { FakeCliScript } from './harness.ts'

let root: string
let home: string | undefined

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-claude-cli-'))
  home = '/accounts/claude/one'
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** A catalog over a scripted CLI, with every deadline short enough to fail fast. */
function build(script: FakeCliScript = {}) {
  const cli = new FakeCli(script)
  const catalog = new ClaudeCliCatalog({
    spawn: cli.spawn,
    resolveExecutable: cli.resolveExecutable,
    cliPath: 'claude',
    extraArgs: [],
    workingDirectory: join(root, 'cwd'),
    authTimeoutMs: 400,
    catalogTimeoutMs: 400,
    graceMs: 10,
    accountHome: () => home,
  })
  return { cli, catalog }
}

/** Await a rejection and return it, so several fields of one error can be asserted. */
async function rejection(promise: Promise<unknown>): Promise<LlmError> {
  const error = await promise.then(() => undefined, (value: unknown) => value)
  if (!(error instanceof LlmError)) throw new Error(`expected an LlmError, got ${String(error)}`)
  return error
}

describe('ClaudeCliCatalog.rows', () => {
  it('lists the models the CLI reports, in the CLI order', async () => {
    const rows = await build().catalog.rows()
    expect(rows.map(row => row.id)).toEqual(['opus', 'haiku'])
    expect(rows[0]?.displayName).toBe('Opus 5.5')
    expect(rows[0]?.efforts.map(effort => effort.id)).toEqual(['low', 'high'])
    expect(rows[0]?.isDefault).toBe(true)
    expect(rows[1]?.efforts).toEqual([])
  })

  it('asks the login state before it asks for models', async () => {
    const { cli, catalog } = build()
    await catalog.rows()
    expect(cli.spawns.map(spawn => spawn.call)).toEqual(['version', 'auth', 'catalog'])
    expect(cli.callsOf('auth')[0]?.spec.argv.slice(1)).toEqual(['auth', 'status', '--json'])
  })

  it('points every run at the account directory and adds nothing else to the environment', async () => {
    const { cli, catalog } = build()
    await catalog.rows()
    expect(cli.callsOf('auth')[0]?.spec.env).toEqual({ CLAUDE_CONFIG_DIR: '/accounts/claude/one' })
    expect(cli.callsOf('catalog')[0]?.spec.env).toEqual({ CLAUDE_CONFIG_DIR: '/accounts/claude/one' })
  })

  it('writes exactly one list_models control request to the probe', async () => {
    const { cli, catalog } = build()
    await catalog.rows()
    expect(JSON.parse(cli.callsOf('catalog')[0]?.stdin ?? '')).toEqual({
      type: 'control_request',
      request_id: 'dsh-claude-cli-models',
      request: { subtype: 'list_models' },
    })
    expect(cli.callsOf('auth')[0]?.stdin).toBe('')
  })

  it('uses the account directory only as an environment value, never as a path it reads or enters', async () => {
    // The directory does not exist: a listing that succeeds proves nothing inside it was opened.
    home = join(root, 'absent', 'account')
    const { cli, catalog } = build()
    expect((await catalog.rows()).length).toBe(2)
    for (const spawn of cli.spawns) {
      expect(spawn.spec.argv.join(' ')).not.toContain(home)
      expect(spawn.spec.cwd).not.toBe(home)
    }
  })

  it('creates its fixed working directory and runs every probe there', async () => {
    const { cli, catalog } = build()
    await catalog.rows()
    expect((await stat(join(root, 'cwd'))).isDirectory()).toBe(true)
    for (const spawn of cli.spawns) expect(spawn.spec.cwd).toBe(join(root, 'cwd'))
  })

  it('fails loud with CLI_MISSING and names the configured path', async () => {
    const error = await rejection(build({ missing: true }).catalog.rows())
    expect(error.code).toBe(CLI_MISSING)
    expect(error.message).toMatch(/cliPath/)
    expect(error.message).toMatch(/claude/)
  })

  it('re-raises a resolver failure that is not a missing executable', async () => {
    const boom = new Error('EACCES: permission denied')
    await expect(build({ resolveError: boom }).catalog.rows()).rejects.toBe(boom)
  })

  it('survives a child whose stdin closes before it reads the probe request', async () => {
    expect((await build({ stdinError: true }).catalog.rows()).map(row => row.id)).toEqual(['opus', 'haiku'])
  })

  it('fails loud with CLI_NOT_AUTHENTICATED and says where to sign in', async () => {
    const error = await rejection(build({ auth: () => AUTH_SIGNED_OUT }).catalog.rows())
    expect(error.code).toBe(CLI_NOT_AUTHENTICATED)
    expect(error.message).toMatch(/Settings, AI Account/)
    expect(error.message).toMatch(/signed out/)
  })

  it('says no account is registered when no account has a default', async () => {
    home = undefined
    const error = await rejection(build({ auth: () => AUTH_SIGNED_OUT }).catalog.rows())
    expect(error.message).toMatch(/No Claude account is registered/)
  })

  it('fails loud when the login answer cannot be read, quoting the CLI stderr', async () => {
    const error = await rejection(
      build({ auth: () => 'command not found: claude', stderr: 'claude: killed' }).catalog.rows(),
    )
    expect(error.code).toBe(CLI_NOT_AUTHENTICATED)
    expect(error.message).toMatch(/claude: killed/)
  })

  it('fails loud with CLI_CATALOG_UNAVAILABLE when the CLI refuses list_models', async () => {
    const refusal = JSON.stringify({
      type: 'control_response',
      response: {
        subtype: 'error',
        request_id: 'dsh-claude-cli-models',
        error: 'Unsupported control request subtype: list_models',
      },
    })
    const error = await rejection(build({ catalog: () => [refusal] }).catalog.rows())
    expect(error.code).toBe(CLI_CATALOG_UNAVAILABLE)
    expect(error.message).toMatch(/Unsupported control request subtype/)
  })

  it('fails loud rather than returning an empty catalog when the CLI answers nothing', async () => {
    const error = await rejection(build({ catalog: () => undefined, stderr: 'no control channel' }).catalog.rows())
    expect(error.code).toBe(CLI_CATALOG_UNAVAILABLE)
    expect(error.message).toMatch(/listed no models/)
    expect(error.message).toMatch(/no control channel/)
  })

  it('terminates and joins every probe process, on success and on failure', async () => {
    const { cli, catalog } = build()
    await catalog.rows()
    for (const spawn of cli.spawns) {
      expect(spawn.terminateCalls).toBe(1)
      expect(spawn.waitForExitCalls).toBe(1)
      expect(spawn.doneAwaited).toBe(true)
    }
    const failing = build({ auth: () => AUTH_SIGNED_OUT })
    await failing.catalog.rows().catch(() => undefined)
    expect(failing.cli.callsOf('auth')[0]?.terminateCalls).toBe(1)
    expect(failing.cli.callsOf('auth')[0]?.doneAwaited).toBe(true)
  })

  it('ends a run whose child never answers, and still tears it down', async () => {
    const { cli, catalog } = build({ hang: ['auth'] })
    const error = await rejection(catalog.rows())
    expect(error.code).toBe(CLI_NOT_AUTHENTICATED)
    expect(cli.spawns[0]?.terminateCalls).toBe(1)
    expect(cli.spawns[0]?.doneAwaited).toBe(true)
  })

  it('honours the caller cancellation', async () => {
    const controller = new AbortController()
    const { cli, catalog } = build({ hang: ['auth'] })
    const pending = rejection(catalog.rows(controller.signal))
    controller.abort()
    expect((await pending).code).toBe(CLI_NOT_AUTHENTICATED)
    expect(cli.spawns[0]?.spec.signal?.aborted).toBe(true)
  })
})

describe('ClaudeCliCatalog caching', () => {
  const perAccount: FakeCliScript = {
    catalog: home => [catalogLine(home === '/accounts/claude/two'
      ? [{ value: 'sonnet', resolvedModel: 'claude-sonnet-5-5', displayName: 'Sonnet 5.5' }]
      : MODEL_ROWS)],
  }

  it('serves one catalog per account directory and never crosses them', async () => {
    const { cli, catalog } = build(perAccount)
    expect((await catalog.rows()).map(row => row.id)).toEqual(['opus', 'haiku'])
    expect((await catalog.rows()).map(row => row.id)).toEqual(['opus', 'haiku'])
    // The second listing re-checked the login but reused the cached rows.
    // A cache hit asks the CLI nothing at all, not even its login state.
    expect(cli.callsOf('catalog')).toHaveLength(1)
    expect(cli.callsOf('auth')).toHaveLength(1)
    home = '/accounts/claude/two'
    expect((await catalog.rows()).map(row => row.id)).toEqual(['sonnet'])
    expect(cli.callsOf('catalog')).toHaveLength(2)
  })

  it('probes the CLI version once per generation', async () => {
    const { cli, catalog } = build(perAccount)
    await catalog.rows()
    home = '/accounts/claude/two'
    await catalog.rows()
    expect(cli.callsOf('version')).toHaveLength(1)
  })

  it('re-lists after invalidate, which also re-resolves the executable and the version', async () => {
    const { cli, catalog } = build(perAccount)
    await catalog.rows()
    catalog.invalidate()
    expect((await catalog.rows()).map(row => row.id)).toEqual(['opus', 'haiku'])
    expect(cli.callsOf('catalog')).toHaveLength(2)
    expect(cli.callsOf('version')).toHaveLength(2)
  })

  it('re-lists when the CLI version changes under the same account', async () => {
    const cli = new FakeCli(perAccount)
    let version = '2.1.285'
    const catalog = new ClaudeCliCatalog({
      spawn: cli.spawn,
      resolveExecutable: cli.resolveExecutable,
      cliPath: 'claude',
      extraArgs: [],
      workingDirectory: join(root, 'cwd'),
      authTimeoutMs: 400,
      catalogTimeoutMs: 400,
      graceMs: 10,
      accountHome: () => home,
    })
    await catalog.rows()
    expect(cli.callsOf('catalog')).toHaveLength(1)
    // A CLI upgrade is only visible after the plugin generation restarts, which invalidate() stands
    // in for; the fingerprint is what makes the cached rows unusable afterwards.
    version = '2.2.0'
    catalog.invalidate()
    await catalog.rows()
    expect(cli.callsOf('catalog')).toHaveLength(2)
    expect(version).toBe('2.2.0')
  })
})

describe('ClaudeCliCatalog construction', () => {
  it('refuses a forbidden extra argument at construction', () => {
    const cli = new FakeCli()
    expect(() => new ClaudeCliCatalog({
      spawn: cli.spawn,
      resolveExecutable: cli.resolveExecutable,
      cliPath: 'claude',
      extraArgs: ['--bare'],
      workingDirectory: root,
      authTimeoutMs: 1,
      catalogTimeoutMs: 1,
      graceMs: 1,
      accountHome: () => undefined,
    })).toThrow(/--bare/)
  })
})

describe('ClaudeCliCatalog.launch', () => {
  it('reports the resolved executable, the extra args, and the account directory', async () => {
    const cli = new FakeCli()
    const catalog = new ClaudeCliCatalog({
      spawn: cli.spawn,
      resolveExecutable: cli.resolveExecutable,
      cliPath: 'claude',
      extraArgs: ['--effort', 'high'],
      workingDirectory: join(root, 'cwd'),
      authTimeoutMs: 400,
      catalogTimeoutMs: 400,
      graceMs: 10,
      accountHome: () => home,
    })
    expect(await catalog.launch()).toEqual({
      executable: '/fake/bin/claude',
      extraArgs: ['--effort', 'high'],
      accountHome: '/accounts/claude/one',
    })
  })

  it('resolves the executable once and reuses it', async () => {
    const { catalog } = build()
    await catalog.launch()
    await catalog.launch()
    expect((await catalog.launch()).executable).toBe('/fake/bin/claude')
  })

  it('reports no account directory when none has a default', async () => {
    home = undefined
    expect((await build().catalog.launch()).accountHome).toBeUndefined()
  })
})
