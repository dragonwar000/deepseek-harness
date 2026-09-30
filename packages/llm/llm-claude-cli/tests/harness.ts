import { Readable } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import { AiAccount } from '@deepseek-ai/dsh-ai-account'
import type {
  AiAccountId,
  AiAccountKind,
  AiAccountSignInId,
  AiAccountsView,
} from '@deepseek-ai/dsh-ai-account'
import { SubprocessExecutableNotFoundError, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type {
  SubprocessHandle,
  SubprocessOutputReader,
  SubprocessSpawnSpec,
  SubprocessTerminalEnvironment,
  SubprocessTerminalHandle,
  SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import type { ResolveExecutable, SpawnChild } from '../src/run.ts'

/** Which question one spawn is asking the CLI, read from its argv. */
export type CliCall = 'auth' | 'version' | 'catalog' | 'inference'

/**
 * What a scripted CLI answers, per question rather than per spawn order, so a test that changes how
 * many probes run does not have to renumber a queue.
 */
export interface FakeCliScript {
  /** `auth status --json` stdout, by account directory. */
  readonly auth?: (home: string | undefined) => string
  /** `--version` stdout. */
  readonly version?: string
  /** `list_models` stdout lines, by account directory; `undefined` answers nothing. */
  readonly catalog?: (home: string | undefined) => readonly string[] | undefined
  /** One inference run's stdout lines. */
  readonly inference?: (spec: SubprocessSpawnSpec) => readonly string[]
  /** stderr for every child. */
  readonly stderr?: string
  /** Questions whose child leaves stdout open, so the caller's deadline must end the run. */
  readonly hang?: readonly CliCall[]
  /** `resolveExecutable` reports a miss. */
  readonly missing?: true
  /** `resolveExecutable` fails for a reason that is not a missing executable. */
  readonly resolveError?: Error
  /** The child's stdin raises an error, as it does when the child exits before reading. */
  readonly stdinError?: true
}

/** One recorded spawn, for asserting argv, environment, stdin, and teardown. */
export interface RecordedSpawn {
  readonly spec: SubprocessSpawnSpec
  readonly call: CliCall
  /** Whatever the caller wrote to stdin. */
  stdin: string
  terminateCalls: number
  waitForExitCalls: number
  doneAwaited: boolean
}

/** Classify one spawn by the argv the launch planner produced. */
function classify(argv: readonly string[]): CliCall {
  if (argv.includes('auth')) return 'auth'
  if (argv.includes('--version')) return 'version'
  return argv.includes('--model') ? 'inference' : 'catalog'
}

/** A scripted stand-in for the two subprocess-seam methods this package uses. */
export class FakeCli {
  readonly spawns: RecordedSpawn[] = []
  private readonly script: FakeCliScript

  constructor(script: FakeCliScript = {}) {
    this.script = script
  }

  /** The seam's `resolveExecutable`, resolving to a fake absolute path or reporting a miss. */
  readonly resolveExecutable: ResolveExecutable = (command) => {
    if (this.script.resolveError !== undefined) return Promise.reject(this.script.resolveError)
    return this.script.missing === true
      ? Promise.reject(new SubprocessExecutableNotFoundError(`not found: ${command}`))
      : Promise.resolve(`/fake/bin/${command}`)
  }

  /** Every spawn that asked one question. */
  callsOf(call: CliCall): readonly RecordedSpawn[] {
    return this.spawns.filter(spawn => spawn.call === call)
  }

  /** The seam's `spawn`, answering according to what the argv asks. */
  readonly spawn: SpawnChild = (spec) => {
    const call = classify(spec.argv)
    const record: RecordedSpawn = {
      spec,
      call,
      stdin: '',
      terminateCalls: 0,
      waitForExitCalls: 0,
      doneAwaited: false,
    }
    this.spawns.push(record)
    const home = spec.env?.['CLAUDE_CONFIG_DIR']
    const stdout = this.script.hang?.includes(call) === true
      ? new Readable({ read() {} })
      : Readable.from(this.answer(call, home, spec).map(line => `${line}\n`))
    // The real seam starts termination when the spec's signal fires; a scripted child must too, or a
    // deadline test would hang instead of failing. An already-aborted signal never fires an event,
    // so that case is handled directly.
    if (spec.signal?.aborted === true) stdout.push(null)
    else spec.signal?.addEventListener('abort', () => { stdout.push(null) }, { once: true })
    const stderrText = this.script.stderr ?? ''
    const stderrReader: SubprocessOutputReader = {
      readFrom: from => ({ text: stderrText.slice(from), nextOffset: stderrText.length, lossy: false }),
    }
    const stdin = {
      on: (event: string, handler: (error: Error) => void) => {
        if (event === 'error' && this.script.stdinError === true) handler(new Error('EPIPE'))
        return stdin
      },
      end: (payload: string) => { record.stdin += payload },
    }
    return {
      stdin: stdin as never,
      stdout,
      stderr: undefined,
      control: undefined,
      collected: { stderr: stderrReader },
      get done() {
        record.doneAwaited = true
        return Promise.resolve({ exitCode: 0, signal: null })
      },
      terminate: () => {
        record.terminateCalls += 1
        stdout.push(null)
      },
      waitForExit: () => {
        record.waitForExitCalls += 1
        return Promise.resolve(true)
      },
    }
  }

  /** The lines this scripted CLI writes for one question. */
  private answer(call: CliCall, home: string | undefined, spec: SubprocessSpawnSpec): readonly string[] {
    switch (call) {
      case 'auth': return [(this.script.auth ?? (() => AUTH_SIGNED_IN))(home)]
      case 'version': return [this.script.version ?? '2.1.285 (Claude Code)']
      case 'catalog':
        return (this.script.catalog ?? (() => [catalogLine(MODEL_ROWS)]))(home)
          ?? ['{"type":"system","subtype":"init"}']
      case 'inference': return (this.script.inference ?? (() => streamLines('ok')))(spec)
    }
  }
}

/** Verbatim shape of a signed-in `claude auth status --json` answer. */
export const AUTH_SIGNED_IN = '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","subscriptionType":"max"}'
/** Verbatim shape of the answer for a configuration directory with no login. */
export const AUTH_SIGNED_OUT = '{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty"}'

/**
 * One inference run against a configuration directory with no login, as Claude Code 2.1.285 writes
 * it: a synthetic assistant message carrying the error kind, then a result whose subtype is
 * `success` with `is_error` set. The result line is verbatim from a failed Desktop turn.
 */
export const SIGNED_OUT_RUN: readonly string[] = [
  '{"type":"system","subtype":"init","session_id":"c9"}',
  '{"type":"assistant","message":{"model":"<synthetic>","role":"assistant","stop_reason":"stop_sequence","content":[{"type":"text","text":"Not logged in · Please run /login"}]},"error":"authentication_failed","is_api_error_message":true}',
  '{"type":"result","subtype":"success","is_error":true,"result":"Not logged in · Please run /login","duration_ms":59}',
]

/**
 * Build one `list_models` control response line.
 * @param models - rows to report.
 * @returns the JSON line the CLI would write.
 */
export function catalogLine(models: readonly object[]): string {
  return JSON.stringify({
    type: 'control_response',
    response: { subtype: 'success', request_id: 'dsh-claude-cli-models', response: { models } },
  })
}

/** Two plausible rows, enough for catalog and adapter assertions. */
export const MODEL_ROWS: readonly object[] = [
  {
    value: 'opus',
    resolvedModel: 'claude-opus-5-5',
    displayName: 'Opus 5.5',
    description: 'For complex work and everyday tasks',
    supportedEffortLevels: ['low', 'high'],
    isDefault: true,
  },
  { value: 'haiku', resolvedModel: 'claude-haiku-4-5', displayName: 'Haiku 4.5' },
]

/**
 * Build one CLI inference run's stdout: one text block and a successful result.
 * @param text - the assistant text the model produced.
 * @returns the lines the CLI would write.
 */
export function streamLines(text: string): readonly string[] {
  return [
    '{"type":"system","subtype":"init","session_id":"c9"}',
    '{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}}',
    JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    }),
    '{"type":"stream_event","event":{"type":"content_block_stop","index":0}}',
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      stop_reason: 'end_turn',
      result: text,
      usage: { input_tokens: 11, output_tokens: 3 },
    }),
  ]
}

/**
 * A `ctx.subprocess` provider backed by one `FakeCli`, mounted with `ctx.plugin(…, cli)` so a
 * composition test exercises the real service seam without a real child process.
 */
export class FakeSubprocessRuntime extends SubprocessRuntime {
  private readonly cli: FakeCli

  constructor(ctx: Context, cli: FakeCli) {
    super(ctx)
    this.cli = cli
  }

  override resolveExecutable(
    command: string,
    env?: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<string> {
    return this.cli.resolveExecutable(command, env, signal)
  }

  override spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    return this.cli.spawn(spec)
  }

  override terminalEnvironment(): Promise<SubprocessTerminalEnvironment> {
    throw new Error('the fake subprocess runtime serves no terminals')
  }

  override spawnTerminal(_spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    throw new Error('the fake subprocess runtime serves no terminals')
  }
}

/** The account state a `FakeAiAccount` reports, which a test moves between assertions. */
export interface FakeAccountState {
  home: string | undefined
  /** Report a provider that cannot read its own accounts. */
  throws?: true
}

/**
 * A `ctx.aiAccount` provider whose default Claude home a test can move, mounted with
 * `ctx.plugin(…, state)` so disposing its fiber exercises the route losing the provider.
 */
export class FakeAiAccount extends AiAccount {
  private readonly state: FakeAccountState

  constructor(ctx: Context, state: FakeAccountState) {
    super(ctx)
    this.state = state
  }

  override defaultHome(kind: AiAccountKind): string | undefined {
    if (this.state.throws === true) {
      throw new Error('the AI Account provider could not read its accounts')
    }
    return kind === 'claude' ? this.state.home : undefined
  }

  override getState(): Promise<AiAccountsView> {
    throw new Error('the fake AI Account provider answers only defaultHome')
  }

  override startSignIn(_kind: AiAccountKind): Promise<AiAccountsView> {
    throw new Error('the fake AI Account provider answers only defaultHome')
  }

  override cancelSignIn(_id: AiAccountSignInId): Promise<AiAccountsView> {
    throw new Error('the fake AI Account provider answers only defaultHome')
  }

  override submitSignInCode(_id: AiAccountSignInId, _code: string): Promise<AiAccountsView> {
    throw new Error('the fake AI Account provider answers only defaultHome')
  }

  override setDefault(_id: AiAccountId): Promise<AiAccountsView> {
    throw new Error('the fake AI Account provider answers only defaultHome')
  }

  override remove(_id: AiAccountId): Promise<AiAccountsView> {
    throw new Error('the fake AI Account provider answers only defaultHome')
  }

  override watch(_signal: AbortSignal): AsyncIterable<AiAccountsView> {
    throw new Error('the fake AI Account provider answers only defaultHome')
  }
}
