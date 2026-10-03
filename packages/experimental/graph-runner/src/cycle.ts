/**
 * Pure helpers of cycle-edge decisions: the metric a command reports, the
 * plateau rule, and the output a fired edge sends back to its target.
 * @module @deepseek-ai/dsh-experimental-graph-runner/cycle
 */

import type { GraphCycleGuard } from '@deepseek-ai/dsh-experimental-graph-contract'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/**
 * The metric value one metric command reports.
 * @param stdout - the command's standard output.
 * @param exitCode - its exit code, or null when it did not exit.
 * @returns the last non-empty stdout line, trimmed, or `exit <code>` when the command did not exit 0.
 */
export function metricOf(stdout: string, exitCode: number | null): string {
  if (exitCode !== 0) return `exit ${String(exitCode)}`
  const lines = stdout.split('\n').map(line => line.trim()).filter(line => line !== '')
  return lines.at(-1) ?? ''
}

/**
 * Whether a loop metric stopped changing.
 * @param earlier - metric values of the edge's earlier decisions, oldest first.
 * @param metric - the value read now.
 * @param after - `cycleGuard.plateauAfter`.
 * @returns true when the last `after + 1` values, this one included, are all equal.
 */
export function plateaued(earlier: readonly string[], metric: string, after: number): boolean {
  const window = [...earlier, metric].slice(-(after + 1))
  return window.length === after + 1 && window.every(value => value === metric)
}

/**
 * The plateau rule of a guard.
 * @param guard - the cycle guard; the plan schema sets `plateauAfter` and `metricCommand` together.
 * @returns the metric command and `plateauAfter`, or undefined for a loop without a metric.
 */
export function plateauOf(guard: GraphCycleGuard): { readonly command: string; readonly after: number } | undefined {
  const { metricCommand, plateauAfter } = guard
  return metricCommand === undefined || plateauAfter === undefined ? undefined : { command: metricCommand, after: plateauAfter }
}

/**
 * The output a fired edge sends back.
 * @param output - the `from` node's output.
 * @param fields - the edge's `allowedFields`; undefined sends everything.
 * @returns the object output limited to `fields`, or the output unchanged when it is not an object.
 */
export function sentBack(output: JsonValue | undefined, fields: readonly string[] | undefined): JsonValue | undefined {
  if (fields === undefined || typeof output !== 'object' || output === null || Array.isArray(output)) return output
  return Object.fromEntries(Object.entries(output).filter(([key]) => fields.includes(key)))
}
