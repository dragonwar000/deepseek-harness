import { describe, expect, it } from 'vitest'
import {
  assertAllowedExtraArgs,
  CATALOG_REQUEST_ID,
  FORBIDDEN_ARGS,
  launchFingerprint,
  resolveAuthSpec,
  resolveCatalogSpec,
  resolveInferenceSpec,
  resolveVersionSpec,
} from '../src/launch.ts'
import { claudeCliModelId } from '../src/types.ts'
import type { ClaudeCliLaunch } from '../src/types.ts'

const LAUNCH: ClaudeCliLaunch = {
  executable: '/usr/local/bin/claude',
  extraArgs: [],
  accountHome: '/home/ai-accounts/claude/abc',
}

/** Read the value that follows a flag, so a test never depends on argv order. */
function valueOf(argv: readonly string[], flag: string): string | undefined {
  return argv[argv.indexOf(flag) + 1]
}

describe('resolveInferenceSpec', () => {
  it('disables every tool, replaces the system prompt, and pins the model', () => {
    const { argv } = resolveInferenceSpec(LAUNCH, {
      model: claudeCliModelId('opus'),
      system: 'Be terse.',
      sessionId: 'e2c1',
    })
    expect(argv[0]).toBe('/usr/local/bin/claude')
    expect(valueOf(argv, '--tools')).toBe('')
    expect(valueOf(argv, '--disallowedTools')).toBe('mcp__*')
    expect(argv).toContain('--strict-mcp-config')
    expect(valueOf(argv, '--setting-sources')).toBe('')
    expect(valueOf(argv, '--model')).toBe('opus')
    expect(valueOf(argv, '--session-id')).toBe('e2c1')
    expect(valueOf(argv, '--system-prompt')).toBe('Be terse.')
    expect(valueOf(argv, '--output-format')).toBe('stream-json')
    expect(valueOf(argv, '--input-format')).toBe('stream-json')
    expect(valueOf(argv, '--permission-prompts')).toBe('none')
    expect(argv).toContain('--print')
    expect(argv).toContain('--verbose')
    expect(argv).toContain('--include-partial-messages')
    expect(argv).toContain('--no-session-persistence')
    expect(argv).toContain('--disable-slash-commands')
  })

  it('omits --system-prompt when the request carries none, and never sends a forbidden flag', () => {
    const { argv } = resolveInferenceSpec(LAUNCH, {
      model: claudeCliModelId('sonnet'),
      system: undefined,
      sessionId: 'e2c1',
    })
    expect(argv).not.toContain('--system-prompt')
    for (const flag of FORBIDDEN_ARGS) expect(argv).not.toContain(flag)
  })

  it('points the CLI at the account directory and adds nothing else to the environment', () => {
    const spec = resolveInferenceSpec(LAUNCH, {
      model: claudeCliModelId('opus'),
      system: undefined,
      sessionId: 'e2c1',
    })
    expect(spec.env).toEqual({ CLAUDE_CONFIG_DIR: '/home/ai-accounts/claude/abc' })
    expect(spec.stdinPayload).toBeNull()
  })

  it('adds no environment entry when no account is registered', () => {
    const spec = resolveInferenceSpec({ ...LAUNCH, accountHome: undefined }, {
      model: claudeCliModelId('opus'),
      system: undefined,
      sessionId: 'e2c1',
    })
    expect(spec.env).toEqual({})
  })

  it('appends configured extra args after the fixed ones', () => {
    const { argv } = resolveInferenceSpec({ ...LAUNCH, extraArgs: ['--effort', 'high'] }, {
      model: claudeCliModelId('opus'),
      system: undefined,
      sessionId: 'e2c1',
    })
    expect(argv.slice(-2)).toEqual(['--effort', 'high'])
  })
})

describe('resolveCatalogSpec', () => {
  it('writes exactly one list_models control request and reads the stream protocol', () => {
    const spec = resolveCatalogSpec(LAUNCH)
    expect(valueOf(spec.argv, '--input-format')).toBe('stream-json')
    expect(valueOf(spec.argv, '--tools')).toBe('')
    expect(spec.argv).not.toContain('--model')
    expect(JSON.parse(spec.stdinPayload ?? '')).toEqual({
      type: 'control_request',
      request_id: CATALOG_REQUEST_ID,
      request: { subtype: 'list_models' },
    })
    expect(spec.env).toEqual({ CLAUDE_CONFIG_DIR: '/home/ai-accounts/claude/abc' })
  })

  it('carries the configured extra args so a probe lists under the same install as a run', () => {
    expect(resolveCatalogSpec({ ...LAUNCH, extraArgs: ['--effort', 'low'] }).argv.slice(-2))
      .toEqual(['--effort', 'low'])
  })
})

describe('resolveAuthSpec', () => {
  it('asks the CLI for its own login state and writes nothing to stdin', () => {
    const spec = resolveAuthSpec(LAUNCH)
    expect(spec.argv).toEqual(['/usr/local/bin/claude', 'auth', 'status', '--json'])
    expect(spec.stdinPayload).toBeNull()
    expect(spec.env).toEqual({ CLAUDE_CONFIG_DIR: '/home/ai-accounts/claude/abc' })
  })
})

describe('resolveVersionSpec', () => {
  it('asks the CLI for its version without naming an account', () => {
    const spec = resolveVersionSpec(LAUNCH)
    expect(spec.argv).toEqual(['/usr/local/bin/claude', '--version'])
    expect(spec.env).toEqual({})
    expect(spec.stdinPayload).toBeNull()
  })
})

describe('launchFingerprint', () => {
  it('changes with the executable, the extra args, and the reported version', () => {
    const base = launchFingerprint(LAUNCH, '2.1.285')
    expect(base).toMatch(/^[0-9a-f]{64}$/)
    expect(launchFingerprint(LAUNCH, '2.1.285')).toBe(base)
    expect(launchFingerprint({ ...LAUNCH, executable: '/opt/claude' }, '2.1.285')).not.toBe(base)
    expect(launchFingerprint({ ...LAUNCH, extraArgs: ['--effort', 'high'] }, '2.1.285')).not.toBe(base)
    expect(launchFingerprint(LAUNCH, '2.1.286')).not.toBe(base)
  })

  it('leaves the account directory out, since the cache keys on that separately', () => {
    expect(launchFingerprint({ ...LAUNCH, accountHome: '/other' }, '2.1.285'))
      .toBe(launchFingerprint(LAUNCH, '2.1.285'))
  })
})

describe('assertAllowedExtraArgs', () => {
  it('names the flag it refuses and why the run cannot carry it', () => {
    expect(() => { assertAllowedExtraArgs(['--effort', 'high']) }).not.toThrow()
    expect(() => { assertAllowedExtraArgs([]) }).not.toThrow()
    expect(() => { assertAllowedExtraArgs(['--bare']) }).toThrow(/--bare/)
    expect(() => { assertAllowedExtraArgs(['--effort', 'high', '--betas', 'x']) }).toThrow(/--betas/)
  })
})

describe('claudeCliModelId', () => {
  it('brands a CLI-reported id without changing it', () => {
    expect(claudeCliModelId('claude-opus-5')).toBe('claude-opus-5')
  })
})
