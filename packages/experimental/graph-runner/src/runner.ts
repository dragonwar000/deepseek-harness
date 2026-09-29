/**
 * One graph run over an admitted plan version: list scheduling within
 * `maxConcurrent`, each agent node a fresh one-shot subagent with the node's
 * tool allowlist and output schema, anchors and verify commands through the
 * shell seam, human gates through approval on the calling agent, and every
 * status change a `graph/node` event on the calling session. A node is
 * `executed` only with proof: its verify commands passed, a verification
 * node passed it, or a human granted its gate.
 * @module @deepseek-ai/dsh-experimental-graph-runner/runner
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { needSatisfied, nodeFingerprints, runsAsAgent } from '@deepseek-ai/dsh-experimental-graph-contract'
import type {
  GraphNode,
  GraphNodeBasis,
  GraphNodeCheck,
  GraphNodeId,
  GraphNodeKind,
  GraphNodeStatus,
  GraphPlan,
  GraphRecoveryState,
  GraphRoute,
  GraphRunId,
  GraphStopReason,
} from '@deepseek-ai/dsh-experimental-graph-contract'
import type { GraphTask } from '@deepseek-ai/dsh-experimental-graph-projection'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ShellExecRequest, ShellExecSpec, ShellRunResult } from '@deepseek-ai/dsh-shell'
import type { SubagentResult, SubagentRun, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { nodePrompt } from './prompt.ts'
import type { PromptInput } from './prompt.ts'
import type { WriteScopes } from './write-scope.ts'

/** The shell operations the runner uses; `ShellExecutor` satisfies it structurally. */
export interface RunShell {
  /**
   * Fill implementation defaults into one request.
   * @param request - the verify command with the runner's timeout, signal, and working directory.
   * @returns the resolved spec.
   */
  resolve(request: ShellExecRequest): ShellExecSpec
  /**
   * Start one resolved command.
   * @param spec - the spec returned by {@link RunShell.resolve}.
   * @returns a handle whose `result()` settles with the outcome.
   */
  execute(spec: ShellExecSpec): Promise<{ result(): Promise<ShellRunResult> }>
}

/** The approval operation the runner uses; `ApprovalService` satisfies it structurally. */
export interface RunApproval {
  /**
   * Ask the human answerer.
   * @param request - the calling agent, tool identity, reason, and signal.
   * @returns the outcome; only `allowed-once` grants.
   */
  request(request: ApprovalRequest): Promise<ApprovalOutcome>
}

/** The subagent operation the runner uses; `SubagentRuntime` satisfies it structurally. */
export interface RunSubagents {
  /**
   * Start one one-shot child.
   * @param name - provider name.
   * @param request - the child's brief and restrictions.
   * @returns the run handle; its `result` never rejects for a child failure.
   */
  start(name: string, request: SubagentStartRequest): Promise<SubagentRun>
}

/** Services a run uses. */
export interface RunServices {
  /** Subagent seam. */
  readonly subagents: RunSubagents
  /** Shell seam; absent makes every verify command fail. */
  readonly shell: RunShell | undefined
  /** Approval seam; absent makes every human gate `unavailable`. */
  readonly approval: RunApproval | undefined
  /** Write-scope registry shared with the fs listeners. */
  readonly scopes: WriteScopes
}

/** Validated runner settings. */
export interface RunSettings {
  /** Runner mode, recorded on `graph/run`. */
  readonly mode: 'shadow' | 'enforce'
  /** Subagent provider for agent nodes. */
  readonly provider: string
  /** Nodes running at once. */
  readonly maxConcurrent: number
  /** Agent-node dispatches per run; 0 is unlimited. */
  readonly maxDispatches: number
  /** Wall time per run in milliseconds; 0 is unlimited. */
  readonly maxWallMs: number
  /** Timeout per verify command. */
  readonly verifyTimeoutMs: number
  /** Characters of command output kept per check. */
  readonly outputTailChars: number
  /** Human gate timeout in milliseconds; 0 waits for the run signal only. */
  readonly humanTimeoutMs: number
}

/** One run request. */
export interface RunRequest {
  /** The calling agent: parent of every node subagent and owner of every event. */
  readonly agent: Agent
  /** The `graph_run` call, named on approval requests. */
  readonly callId: ToolCallId
  /** Cancellation of the `graph_run` call. */
  readonly signal: AbortSignal
  /** Run id. */
  readonly runId: GraphRunId
  /** Admitted plan. */
  readonly plan: GraphPlan
  /** Its version. */
  readonly version: number
  /** Projected task graph of that version before this run. */
  readonly task: GraphTask
  /** Run inputs by name. */
  readonly inputs: Readonly<Record<string, JsonValue>>
  /** Routes recorded with the admitted version. */
  readonly routes: readonly GraphRoute[]
}

/** One node after the run. */
export interface RunNodeResult {
  /** Node id. */
  readonly id: GraphNodeId
  /** Node kind. */
  readonly kind: GraphNodeKind
  /** Final status. */
  readonly status: GraphNodeStatus
  /** Dispatches in this version. */
  readonly attempt: number
  /** Basis of the final status. */
  readonly basis?: GraphNodeBasis
  /** Output of the final attempt. */
  readonly output?: JsonValue
  /** Reason of the final status. */
  readonly detail?: string
}

/** Run outcome. */
export interface RunOutcome {
  /** Why the run stopped. */
  readonly stopReason: GraphStopReason
  /** What the stop means for the caller. */
  readonly detail: string
  /** Every node in plan order. */
  readonly nodes: RunNodeResult[]
}

/** Fixed caller guidance per stop reason. */
export const STOP_DETAILS: Readonly<Record<GraphStopReason, string>> = {
  GOAL_MET: 'Every node finished with proof, or is a final report.',
  NO_FURTHER_WORK: 'No node can run: an unverified result needs a verification node or verify commands, or a node waits on one that did not finish.',
  NO_PROGRESS: 'A node failed after its retries and its dependents were skipped. Fix the plan and audit a new version with graph_audit; nodes whose fingerprint does not change are carried over.',
  BUDGET: 'The run budget stopped dispatching. Call graph_run again to continue from the recorded state.',
  HUMAN_STOPPED: 'A human gate was not granted, or the run was cancelled.',
  ADMISSION_REFUSED: 'The plan has no runnable admitted version; audit it with graph_audit.',
  MAX_ROUNDS: 'The plan reached the version limit; stop replanning and report the state to the user.',
}

const TERMINAL_KINDS: ReadonlySet<GraphNodeKind> = new Set(['synthesis', 'stop_handoff'])

/** Runner-local node state; optional fields accept `undefined` so changes pass them through. */
interface NodeState {
  status: GraphNodeStatus
  recoveryState: GraphRecoveryState
  attempt: number
  revision: number
  interrupted: boolean
  basis?: GraphNodeBasis | undefined
  output?: JsonValue | undefined
  detail?: string | undefined
}

/** One status change; absent fields keep the recovery state and attempt, and clear basis, output, and detail. */
interface Change {
  status: GraphNodeStatus
  basis?: GraphNodeBasis | undefined
  recoveryState?: GraphRecoveryState | undefined
  attempt?: number | undefined
  childSession?: SessionId | undefined
  output?: JsonValue | undefined
  checks?: GraphNodeCheck[] | undefined
  carriedFrom?: number | undefined
  violations?: string[] | undefined
  detail?: string | undefined
}

/**
 * Read a map entry the caller has proved present.
 * @param map - lookup table.
 * @param key - a key known to be present.
 * @returns the value.
 */
function must<K, V>(map: ReadonlyMap<K, V>, key: K): V {
  const value = map.get(key)
  /* v8 ignore next -- the runner reads only node ids of the admitted, acyclic plan it seeded every map from. */
  if (value === undefined) throw new Error(`graph runner: no entry for ${String(key)}`)
  return value
}

/**
 * Keep only the defined entries of a record.
 * @param value - record whose entries may be undefined.
 * @returns the record without undefined entries.
 */
function defined<T extends Record<string, unknown>>(value: T): Partial<{ [K in keyof T]: Exclude<T[K], undefined> }> {
  const entries = Object.entries(value).filter(([, item]) => item !== undefined)
  return Object.fromEntries(entries) as Partial<{ [K in keyof T]: Exclude<T[K], undefined> }>
}

/**
 * One property of a JSON object output.
 * @param output - node output.
 * @param field - property name.
 * @returns the property, or undefined when the output is absent or not an object.
 */
function fieldOf(output: JsonValue | undefined, field: string): JsonValue | undefined {
  if (typeof output !== 'object' || output === null || Array.isArray(output)) return undefined
  return output[field]
}

/**
 * Execute one admitted plan version until nothing can run.
 * @param services - subagent, shell, approval, and write-scope services.
 * @param settings - validated runner settings.
 * @param request - the calling agent, the plan, its projected state, and the run inputs.
 * @returns the stop reason with its fixed guidance and every node's final state.
 */
export async function runGraph(services: RunServices, settings: RunSettings, request: RunRequest): Promise<RunOutcome> {
  const { agent, plan, version, task, runId, signal } = request
  const cwd = agent.session.header.cwd
  const fingerprints = nodeFingerprints(plan)
  const nodes = new Map(plan.nodes.map(node => [node.id, node]))
  const state = new Map<GraphNodeId, NodeState>(task.nodes.map(view => [view.id, {
    status: view.status,
    recoveryState: view.recoveryState,
    attempt: view.attempt,
    revision: view.revision,
    interrupted: false,
    basis: view.basis,
    output: view.output,
    detail: view.detail,
  }]))
  const controller = new AbortController()
  const runSignal = AbortSignal.any([signal, controller.signal])
  let dispatches = 0
  // Flags the scheduler reads after node work settles; an object keeps them observable across the closures that set them.
  const stop = { budgetHit: false, humanRefused: false }

  function change(id: GraphNodeId, next: Change): void {
    const current = must(state, id)
    const updated: NodeState = {
      status: next.status,
      recoveryState: next.recoveryState ?? current.recoveryState,
      attempt: next.attempt ?? current.attempt,
      revision: current.revision + 1,
      interrupted: next.status === 'running' ? false : current.interrupted,
      basis: next.basis,
      output: next.output,
      detail: next.detail,
    }
    state.set(id, updated)
    agent.session.append('graph/node', {
      runId,
      planId: plan.id,
      version,
      nodeId: id,
      status: updated.status,
      recoveryState: updated.recoveryState,
      attempt: updated.attempt,
      revision: updated.revision,
      fingerprint: must(fingerprints, id),
      ...defined({
        basis: next.basis,
        childSession: next.childSession,
        output: next.output,
        checks: next.checks,
        carriedFrom: next.carriedFrom,
        violations: next.violations !== undefined && next.violations.length > 0 ? next.violations : undefined,
        detail: next.detail,
      }),
    })
  }

  async function runCheck(command: string): Promise<GraphNodeCheck> {
    const shell = services.shell
    if (shell === undefined) return { command, exitCode: null, timedOut: false, outputTail: 'the shell service is not mounted' }
    try {
      const spec = shell.resolve({ command, timeoutMs: settings.verifyTimeoutMs, signal: runSignal, ...defined({ workdir: cwd }) })
      const execution = await shell.execute(spec)
      const result = await execution.result()
      return { command, exitCode: result.exitCode, timedOut: result.timedOut, outputTail: `${result.stdout.text}\n${result.stderr.text}`.slice(-settings.outputTailChars) }
    } catch (error) {
      return { command, exitCode: null, timedOut: false, outputTail: String(error) }
    }
  }

  async function verify(commands: readonly string[]): Promise<GraphNodeCheck[]> {
    const checks: GraphNodeCheck[] = []
    for (const command of commands) {
      const check = await runCheck(command)
      checks.push(check)
      if (check.exitCode !== 0) break
    }
    return checks
  }

  function failureOf(checks: readonly GraphNodeCheck[]): string | undefined {
    const failed = checks.find(check => check.exitCode !== 0)
    return failed === undefined ? undefined : `verify command failed: ${failed.command}`
  }

  function inputsOf(node: GraphNode): PromptInput[] {
    return node.inputs.map((binding) => {
      if (binding.from === 'run') return { name: binding.name, source: `run input ${binding.field}`, value: request.inputs[binding.field] }
      const upstream = must(state, binding.from)
      const value = upstream.status === 'failed' ? binding.fallback : fieldOf(upstream.output, binding.field)
      return { name: binding.name, source: `${binding.from} field ${binding.field}`, value }
    })
  }

  async function runAnchor(node: GraphNode): Promise<void> {
    change(node.id, { status: 'running', attempt: must(state, node.id).attempt + 1 })
    const checks = await verify(node.verify)
    const failed = failureOf(checks)
    if (failed === undefined) change(node.id, { status: 'executed', basis: 'predicate', checks })
    else change(node.id, { status: 'failed', checks, detail: failed })
  }

  async function ask(node: GraphNode): Promise<ApprovalOutcome> {
    const approval = services.approval
    if (approval === undefined) return 'unavailable'
    const gateSignal = settings.humanTimeoutMs > 0 ? AbortSignal.any([runSignal, AbortSignal.timeout(settings.humanTimeoutMs)]) : runSignal
    return approval.request({ agent, toolName: 'graph_run', callId: request.callId, reason: `Graph plan ${plan.id} node ${node.id}: ${node.instruction}`, signal: gateSignal })
  }

  async function runGate(node: GraphNode): Promise<void> {
    change(node.id, { status: 'waiting_human', attempt: must(state, node.id).attempt + 1 })
    const outcome = await ask(node)
    if (outcome === 'allowed-once') {
      change(node.id, { status: 'executed', basis: 'human' })
      return
    }
    if (runSignal.aborted) {
      change(node.id, { status: 'cancelled', detail: 'the run stopped while the gate was waiting' })
      return
    }
    stop.humanRefused = true
    change(node.id, { status: 'failed', detail: `the human gate was not granted: ${outcome}` })
  }

  function settleVerification(node: GraphNode, child: SessionId, violations: string[], output: JsonValue, checks: GraphNodeCheck[]): void {
    const failed = failureOf(checks)
    const verified = plan.edges.filter(edge => edge.to === node.id && edge.relation === 'verifies').map(edge => edge.from)
    const base = { childSession: child, violations, output, checks }
    if (fieldOf(output, 'verdict') === 'pass' && failed === undefined) {
      change(node.id, { ...base, status: 'executed', basis: checks.length > 0 ? 'predicate' : 'verifier' })
      for (const id of verified) {
        const upstream = must(state, id)
        if (upstream.status === 'unverified') change(id, { status: 'executed', basis: 'verifier', output: upstream.output, detail: `verified by ${node.id}` })
      }
      return
    }
    change(node.id, { ...base, status: 'failed_retryable', detail: failed ?? 'the verdict was fail' })
    for (const id of verified) {
      if (must(state, id).status === 'unverified') change(id, { status: 'failed_retryable', detail: `rejected by verification ${node.id}` })
    }
  }

  async function settle(node: GraphNode, child: SessionId, result: SubagentResult, violations: string[]): Promise<void> {
    const base = { childSession: child, violations }
    if (result.stopReason !== 'completed') {
      if (runSignal.aborted) {
        change(node.id, stop.budgetHit ? { ...base, status: 'ready', detail: 'paused by the run budget' } : { ...base, status: 'cancelled', detail: 'the run was cancelled' })
        return
      }
      const diagnostic = result.diagnostic === undefined ? '' : `: ${result.diagnostic}`
      change(node.id, { ...base, status: 'failed_retryable', detail: `the node agent stopped with ${result.stopReason}${diagnostic}` })
      return
    }
    const problems = validateJsonSchemaValue(node.output, result.structured)
    if (problems.length > 0) {
      change(node.id, { ...base, status: 'failed_retryable', detail: `the output does not match the declared schema: ${problems.join('; ')}` })
      return
    }
    // validateJsonSchemaValue accepted it against an object-rooted schema, so it is a JSON object.
    const output = result.structured as JsonValue
    const checks = await verify(node.verify)
    if (node.kind === 'verification') {
      settleVerification(node, child, violations, output, checks)
      return
    }
    const failed = failureOf(checks)
    if (failed !== undefined) change(node.id, { ...base, status: 'failed_retryable', output, checks, detail: failed })
    else if (checks.length > 0) change(node.id, { ...base, status: 'executed', basis: 'predicate', output, checks })
    else change(node.id, { ...base, status: 'unverified', basis: 'agentReported', output })
  }

  async function runAgent(node: GraphNode): Promise<void> {
    const current = must(state, node.id)
    const recoveryState: GraphRecoveryState = current.status === 'failed_retryable' || current.status === 'cancelled' ? 'retried' : current.recoveryState
    const interrupted = current.interrupted
    change(node.id, { status: 'running', attempt: current.attempt + 1, recoveryState })
    const route = node.category === undefined ? undefined : request.routes.find(entry => entry.category === node.category)
    if (node.category !== undefined && route === undefined) {
      change(node.id, { status: 'failed', detail: `no route is recorded for category ${node.category}` })
      return
    }
    let child: SubagentRun
    try {
      child = await services.subagents.start(settings.provider, {
        label: `graph ${plan.id} node ${node.id}`,
        prompt: [{ type: 'text', text: nodePrompt(plan, version, node, inputsOf(node), interrupted) }],
        parent: agent,
        signal: runSignal,
        toolFilter: { allow: [...node.tools] },
        outputSchema: node.output,
        ...route === undefined ? {} : { agentOptions: { provider: route.provider, model: route.model } },
      })
    } catch (error) {
      change(node.id, { status: 'failed_retryable', detail: `the node agent could not start: ${String(error)}` })
      return
    }
    services.scopes.track(child.id, node.writes, cwd)
    try {
      const result = await child.result
      await settle(node, child.id, result, services.scopes.release(child.id))
    } finally {
      services.scopes.release(child.id)
      await child.dispose()
    }
  }

  async function dispatch(node: GraphNode): Promise<void> {
    switch (node.kind) {
      case 'anchor': return runAnchor(node)
      case 'human_gate': return runGate(node)
      case 'execution':
      case 'verification':
      case 'reducer':
      case 'synthesis':
      case 'stop_handoff': return runAgent(node)
      /* v8 ignore next -- GraphNodeKind is closed; the schema admits only the kinds above. */
      default: return assertNever(node.kind)
    }
  }

  function dispatchable(node: GraphNode): boolean {
    const current = must(state, node.id)
    const open = current.status === 'pending' || current.status === 'ready' || current.status === 'cancelled'
    const retry = current.status === 'failed_retryable' && current.attempt <= node.retryBudget
    const status = new Map([...state].map(([id, entry]) => [id, entry.status]))
    return (open || retry) && node.needs.every(need => needSatisfied(plan, status, node.id, need))
  }

  function finished(node: GraphNode): boolean {
    const status = must(state, node.id).status
    if (status === 'executed') return true
    if (status === 'failed') return node.mayFail
    return status === 'unverified' && TERMINAL_KINDS.has(node.kind)
  }

  function stopReasonOf(): GraphStopReason {
    if (signal.aborted || stop.humanRefused) return 'HUMAN_STOPPED'
    if (stop.budgetHit) return 'BUDGET'
    if (plan.nodes.some(node => must(state, node.id).status === 'failed' && !node.mayFail)) return 'NO_PROGRESS'
    return plan.nodes.every(finished) ? 'GOAL_MET' : 'NO_FURTHER_WORK'
  }

  function skipBlocked(): void {
    let changed = true
    while (changed) {
      changed = false
      for (const node of plan.nodes) {
        const status = must(state, node.id).status
        if (status !== 'pending' && status !== 'ready' && status !== 'cancelled') continue
        const blocker = node.needs.find((need) => {
          const upstream = must(state, need).status
          return upstream === 'skipped' || (upstream === 'failed' && !must(nodes, need).mayFail)
        })
        if (blocker === undefined) continue
        change(node.id, { status: 'skipped', detail: `needs ${blocker}, which did not finish` })
        changed = true
      }
    }
  }

  agent.session.append('graph/run', { runId, planId: plan.id, version, phase: 'start', mode: settings.mode })
  for (const node of plan.nodes) {
    const status = must(state, node.id).status
    if (status === 'running') {
      change(node.id, { status: 'failed_retryable', basis: 'sessionExited', detail: 'interrupted: the previous run ended while this node was running' })
      state.set(node.id, { ...must(state, node.id), interrupted: true })
    } else if (status === 'waiting_human') {
      change(node.id, { status: 'cancelled', detail: 'interrupted: the previous run ended while this gate was waiting' })
    }
  }
  const carry = task.carry
  if (task.runs.length === 0 && carry !== null) {
    for (const node of plan.nodes) {
      const fingerprint = must(fingerprints, node.id)
      const same = carry.nodes.find(entry => entry.nodeId === node.id && entry.fingerprint === fingerprint)
      if (same !== undefined) {
        change(node.id, { status: 'executed', basis: same.basis, output: same.output, carriedFrom: carry.version, detail: `carried from version ${carry.version}` })
      } else if (carry.nodes.some(entry => entry.nodeId === node.id)) {
        state.set(node.id, { ...must(state, node.id), recoveryState: 'patched' })
      }
    }
  }

  const timer = settings.maxWallMs > 0
    ? setTimeout(() => {
      stop.budgetHit = true
      controller.abort('graph run wall-time budget')
    }, settings.maxWallMs)
    : undefined
  const inFlight = new Map<GraphNodeId, Promise<void>>()
  try {
    let active = true
    while (active) {
      for (const node of plan.nodes) {
        const current = must(state, node.id)
        if (current.status === 'failed_retryable' && current.attempt > node.retryBudget && !inFlight.has(node.id)) {
          change(node.id, { status: 'failed', detail: current.detail })
        }
      }
      if (!stop.humanRefused && !runSignal.aborted) {
        for (const node of plan.nodes) {
          if (inFlight.size >= settings.maxConcurrent) break
          if (inFlight.has(node.id) || !dispatchable(node)) continue
          if (runsAsAgent(node) && settings.maxDispatches > 0 && dispatches >= settings.maxDispatches) {
            stop.budgetHit = true
            continue
          }
          if (runsAsAgent(node)) dispatches += 1
          const work = dispatch(node)
            .catch((error: unknown) => {
              const status = must(state, node.id).status
              change(node.id, { status: status === 'running' ? 'failed_retryable' : 'failed', detail: `runner error: ${String(error)}` })
            })
            .finally(() => inFlight.delete(node.id))
          inFlight.set(node.id, work)
        }
      }
      if (inFlight.size === 0) active = false
      else await Promise.race(inFlight.values())
    }
  } finally {
    clearTimeout(timer)
  }

  if (stopReasonOf() === 'NO_PROGRESS') skipBlocked()
  const stopReason = stopReasonOf()
  const detail = STOP_DETAILS[stopReason]
  agent.session.append('graph/run', { runId, planId: plan.id, version, phase: 'stop', mode: settings.mode, stopReason, detail })
  return {
    stopReason,
    detail,
    nodes: plan.nodes.map((node) => {
      const final = must(state, node.id)
      const optional = defined({ basis: final.basis, output: final.output, detail: final.detail })
      return { id: node.id, kind: node.kind, status: final.status, attempt: final.attempt, ...optional }
    }),
  }
}
