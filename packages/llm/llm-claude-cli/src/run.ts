/**
 * One Claude Code CLI invocation, spawned through `ctx.subprocess` and always torn down.
 *
 * Shared by the catalog probe and the adapter so there is one teardown ladder in the package:
 * `terminate()`, then `waitForExit()`, then `await done`. The caller owns the deadline, which it
 * passes as the spec's `signal`, because the subprocess seam deliberately carries no timeout.
 */

import type { SubprocessHandle, SubprocessRuntime, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { lineSplitter } from './wire.ts'
import type { ClaudeCliRequestSpec } from './types.ts'

/** How much of the CLI's stderr is kept for a failure message. */
const STDERR_LIMIT_BYTES = 8 * 1024

/**
 * The one subprocess-seam method a run needs, taken structurally rather than as the whole service,
 * following the out-of-process subagent providers: the plugin passes `ctx.subprocess.spawn` bound to
 * its service, and a test passes a scripted stand-in without standing up a Cordis service.
 */
export type SpawnChild = (spec: SubprocessSpawnSpec) => SubprocessHandle

/** The seam's executable resolver, taken the same way. */
export type ResolveExecutable = SubprocessRuntime['resolveExecutable']

/**
 * Read a stream the stdio disposition in this file always produces.
 * @param value - the seam's optional stream or reader.
 * @param what - the name used in the failure, if the seam and this file ever disagree.
 * @returns the stream.
 */
function required<T>(value: T | undefined, what: string): T {
  /* v8 ignore next -- every disposition this file requests produces the stream it then reads */
  if (value === undefined) throw new Error(`llm-claude-cli: the subprocess seam provided no ${what}`)
  return value
}

/** What a run needs from its host beyond the planned spec. */
export interface CliRunDeps {
  readonly spawn: SpawnChild
  /**
   * Working directory for the child. A fixed, empty, non-repository directory: the CLI adds its own
   * working-directory and git-branch line to the request, and a constant empty directory keeps that
   * line constant and free of anything about the user's project.
   */
  readonly cwd: string
  readonly graceMs: number
}

/** A started CLI run: its line stream, its stderr tail, and its teardown. */
export interface CliRun {
  /** Complete stdout lines, in order, until the child's stdout ends. */
  lines(): AsyncGenerator<string>
  /** Whatever the child wrote to stderr so far, for a failure message. */
  stderrTail(): string
  /** Terminate the child, wait for its managed range to empty, and await its outcome. */
  dispose(): Promise<void>
}

/**
 * Spawn one planned CLI invocation.
 * @param deps - the spawn function, working directory, and termination grace.
 * @param spec - the planned argv, environment overlay, and optional single stdin line.
 * @param signal - the caller's deadline and cancellation, forwarded to the seam.
 * @returns the run's line stream, stderr tail, and teardown.
 */
export function startCliRun(deps: CliRunDeps, spec: ClaudeCliRequestSpec, signal: AbortSignal): CliRun {
  const handle: SubprocessHandle = deps.spawn({
    argv: [...spec.argv],
    cwd: deps.cwd,
    // stderr is collected rather than inherited: the CLI's diagnostics belong in a failure message,
    // never mixed into the Harness's own output.
    stdio: {
      stdin: spec.stdinPayload === null ? 'ignore' : 'pipe',
      stdout: 'pipe',
      stderr: { maxBytes: STDERR_LIMIT_BYTES },
    },
    graceMs: deps.graceMs,
    env: { ...spec.env },
    signal,
  })
  const payload = spec.stdinPayload
  if (payload !== null) {
    const stdin = required(handle.stdin, 'stdin for a piped child')
    // A child that exits before reading closes the pipe; that is an outcome, not a run failure.
    stdin.on('error', () => {})
    stdin.end(payload)
  }
  return {
    async *lines() {
      const split = lineSplitter()
      for await (const chunk of required(handle.stdout, 'stdout for a piped child')) {
        for (const line of split(String(chunk))) yield line
      }
    },
    stderrTail: () => required(handle.collected.stderr, 'collected stderr').readFrom(0).text,
    dispose: async () => {
      handle.terminate()
      await handle.waitForExit()
      await handle.done
    },
  }
}

/**
 * Run one invocation to completion and return its collected stdout.
 * @param deps - the spawn function, working directory, and termination grace.
 * @param spec - the planned invocation.
 * @param signal - the caller's deadline and cancellation.
 * @returns the child's full stdout, plus its stderr tail for a failure message.
 */
export async function collectCliRun(
  deps: CliRunDeps,
  spec: ClaudeCliRequestSpec,
  signal: AbortSignal,
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  const run = startCliRun(deps, spec, signal)
  try {
    const lines: string[] = []
    for await (const line of run.lines()) lines.push(line)
    return { stdout: lines.join('\n'), stderr: run.stderrTail() }
  }
  finally {
    await run.dispose()
  }
}

/**
 * Run one invocation until a visitor accepts a line, then stop the child immediately.
 * @param deps - the spawn function, working directory, and termination grace.
 * @param spec - the planned invocation.
 * @param signal - the caller's deadline and cancellation.
 * @param accept - called per stdout line; the first non-`undefined` return ends the run.
 * @returns the accepted value, or `undefined` when stdout ended first, plus the stderr tail.
 */
export async function firstCliAnswer<T>(
  deps: CliRunDeps,
  spec: ClaudeCliRequestSpec,
  signal: AbortSignal,
  accept: (line: string) => T | undefined,
): Promise<{ readonly value: T | undefined; readonly stderr: string }> {
  const run = startCliRun(deps, spec, signal)
  try {
    for await (const line of run.lines()) {
      const value = accept(line)
      if (value !== undefined) return { value, stderr: run.stderrTail() }
    }
    return { value: undefined, stderr: run.stderrTail() }
  }
  finally {
    await run.dispose()
  }
}
