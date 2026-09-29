/**
 * Write-scope enforcement for node subagents: a write or edit by a tracked
 * child session outside its node's `writes` prefixes is a violation.
 * @module @deepseek-ai/dsh-experimental-graph-runner/write-scope
 */

import { isAbsolute, relative } from 'node:path'
import { normalizeWriteScope } from '@deepseek-ai/dsh-experimental-graph-contract'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'

/**
 * Why one write falls outside a node's write scopes.
 * @param writes - the node's normalized prefixes.
 * @param cwd - the session working directory.
 * @param displayPath - the resolved target path as the fs seam shows it.
 * @returns the violation text, or undefined when the path is inside a prefix.
 */
export function writeViolation(writes: readonly string[], cwd: string | undefined, displayPath: string): string | undefined {
  let candidate = displayPath
  if (isAbsolute(displayPath)) {
    if (cwd === undefined) return `${displayPath} is absolute and the session has no working directory`
    candidate = relative(cwd, displayPath)
  }
  const scope = normalizeWriteScope(candidate)
  if (scope === undefined) return `${displayPath} is outside the workspace`
  if (writes.some(prefix => scope === prefix || scope.startsWith(`${prefix}/`))) return undefined
  return writes.length === 0
    ? `${displayPath} is written by a node that declares no write scope`
    : `${displayPath} is outside the write scopes ${writes.join(', ')}`
}

/** One tracked child. */
interface Tracked {
  readonly writes: readonly string[]
  readonly cwd: string | undefined
  readonly violations: string[]
}

/** Child sessions currently running a node, with the writes they may make. */
export class WriteScopes {
  private readonly children = new Map<SessionId, Tracked>()

  /**
   * Start tracking one child session.
   * @param child - the child session id.
   * @param writes - the node's normalized prefixes.
   * @param cwd - the working directory writes resolve against.
   */
  track(child: SessionId, writes: readonly string[], cwd: string | undefined): void {
    this.children.set(child, { writes, cwd, violations: [] })
  }

  /**
   * Stop tracking one child session.
   * @param child - the child session id.
   * @returns the violations it made; empty when it was not tracked.
   */
  release(child: SessionId): string[] {
    const tracked = this.children.get(child)
    this.children.delete(child)
    return tracked === undefined ? [] : tracked.violations
  }

  /**
   * Check one write by the fs seam's actor and record a violation.
   * @param actor - the tool execution the fs seam passes; its agent's session identifies the child.
   * @param displayPath - the resolved target path.
   * @returns the violation, or undefined when the actor is not a tracked child or the path is allowed.
   */
  check(actor: object | undefined, displayPath: string): string | undefined {
    // The fs seam passes the executing ToolRunContext; fs-observation-policy reads it the same way.
    // tsgolint treats object as assignable to the weak actor type, while tsc still requires the structural cast for property access.
    // oxlint-disable-next-line typescript/no-unnecessary-type-assertion -- The analyzers disagree on this weak type.
    const child = (actor as { agent?: Pick<Agent, 'session'> } | undefined)?.agent?.session.header.id
    const tracked = child === undefined ? undefined : this.children.get(child)
    if (tracked === undefined) return undefined
    const violation = writeViolation(tracked.writes, tracked.cwd, displayPath)
    if (violation !== undefined) tracked.violations.push(violation)
    return violation
  }
}
