/**
 * Deterministic admission audit of one parsed `dsh-graph/v1` plan: pure
 * functions over the plan and an explicit {@link AuditEnvironment}, with no
 * I/O and no model call.
 * @module @deepseek-ai/dsh-experimental-graph-contract/audit
 */

import { RUN_CODE_NAME } from '@deepseek-ai/dsh-tools'
import { deepEqualJson } from '@deepseek-ai/dsh-util-values'
import type {
  GraphCheck,
  GraphNode,
  GraphNodeBudget,
  GraphNodeId,
  GraphNodeKind,
  GraphPlan,
  GraphRejection,
  GraphRejectionCode,
} from './types.ts'

/** Check family, severity, and fixed remedy of one rejection code. */
export interface RejectionRule {
  /** Invariant family. */
  readonly check: GraphCheck
  /** Whether the code blocks admission. */
  readonly severity: GraphRejection['severity']
  /** Fixed remedy text; it never names a way around the audit. */
  readonly remedy: string
}

/** Every rejection code in report order, with its rule. */
export const REJECTION_RULES: Readonly<Record<GraphRejectionCode, RejectionRule>> = {
  SCHEMA_INVALID: { check: 'schema', severity: 'reject', remedy: 'Fix the named field so the plan matches dsh-graph/v1, then audit again.' },
  CYCLE: { check: 'structure', severity: 'reject', remedy: 'Remove a dependency so the needs form a directed acyclic graph.' },
  ISOLATED_NODE: { check: 'closeness', severity: 'reject', remedy: 'Connect the node to the work that needs it, or remove it.' },
  NOT_CONSUMED: { check: 'closeness', severity: 'reject', remedy: 'Add an edge from this node to a node that uses its output, or remove it.' },
  MISSING_ANCHOR: { check: 'anchor', severity: 'reject', remedy: 'Add an anchor node with verify commands and an anchors edge to the work it constrains.' },
  VERIFIER_NOT_FRESH: { check: 'freshness', severity: 'reject', remedy: 'Give each verification node contextScope fresh-independent and reach it through verifies edges, not feeds edges from execution nodes.' },
  VERDICT_UNDECLARED: { check: 'freshness', severity: 'reject', remedy: 'Declare a required verdict property with enum ["pass", "fail"] in the verification node output.' },
  SYNTHESIS_BEFORE_VERIFY: { check: 'order', severity: 'reject', remedy: 'Make the synthesis node depend, directly or transitively, on a verification node.' },
  MISSING_HUMAN_GATE: { check: 'gates', severity: 'reject', remedy: 'Add a human_gate node before the step that is expensive to undo.' },
  MISSING_STOP_HANDOFF: { check: 'gates', severity: 'reject', remedy: 'Add a stop_handoff node that ends the plan with a handoff.' },
  WRITE_SCOPE_OVERLAP: { check: 'writes', severity: 'reject', remedy: 'Make the two write scopes disjoint, or order the two nodes with a dependency.' },
  CAPABILITY_UNVERIFIED: { check: 'capability', severity: 'reject', remedy: 'Declare only tools this deployment grants to graph nodes.' },
  BUDGET_EXCEEDED: { check: 'budget', severity: 'reject', remedy: 'Declare the missing budgets, lower node or retry budgets, or split the plan.' },
  INPUT_MAY_BE_ABSENT: { check: 'inputs', severity: 'reject', remedy: 'Add a fallback to the binding, or set mayFail false on the source node.' },
  EDGE_WITHOUT_ARTIFACT: { check: 'structure', severity: 'reject', remedy: 'Declare one edge with a non-blank artifact for every dependency.' },
  DEPTH_EXCEEDED: { check: 'depth', severity: 'reject', remedy: 'Do this work in the current loop; its agent nodes cannot be delegated from here.' },
  ACCEPTANCE_CHANGED: { check: 'freeze', severity: 'reject', remedy: 'Restore the acceptance list of the first version; acceptance is frozen after it.' },
  LINEAR_PLAN: { check: 'structure', severity: 'warn', remedy: 'A straight chain gains nothing from a graph; do the steps in the current loop.' },
}

/**
 * Build one finding from its code's fixed rule.
 * @param code - rejection code.
 * @param subject - node id, edge, tool, field path, or plan id.
 * @param detail - what is wrong.
 * @returns the complete finding.
 */
export function rejection(code: GraphRejectionCode, subject: string, detail: string): GraphRejection {
  const rule = REJECTION_RULES[code]
  return { check: rule.check, code, severity: rule.severity, subject, detail, remedy: rule.remedy }
}

/** What the audit may know about the deployment and the plan's history. */
export interface AuditEnvironment {
  /** Tool names a node may declare (graph-contract `allowedTools`). */
  readonly allowedTools: ReadonlySet<string>
  /**
   * Whether a global tool with this name is registered now.
   * @param name - tool name.
   * @returns true when the registry resolves it in the global view.
   */
  readonly isRegisteredTool: (name: string) => boolean
  /** Run limits per kind; 0 means unlimited. */
  readonly runBudget: Readonly<Required<GraphNodeBudget>>
  /** Caller delegation depth and the subagent depth limit; undefined when no subagent service is mounted. */
  readonly depth: { readonly current: number; readonly max: number } | undefined
  /** Acceptance frozen by the first parsed version of this plan id. */
  readonly frozenAcceptance: readonly string[] | undefined
}

/** Audit outcome; `order` and `waves` are absent when structure errors or a cycle prevent them. */
export interface AuditResult {
  /** Findings in rule order, then subject order. */
  readonly rejections: GraphRejection[]
  /** A topological order, declaration order inside each wave. */
  readonly order: GraphNodeId[] | undefined
  /** Nodes that can run together, wave by wave. */
  readonly waves: GraphNodeId[][] | undefined
}

const AGENT_KINDS: ReadonlySet<GraphNodeKind> = new Set(['execution', 'verification', 'reducer', 'synthesis', 'stop_handoff'])
const TERMINAL_KINDS: ReadonlySet<GraphNodeKind> = new Set(['synthesis', 'stop_handoff'])
const BUDGET_KINDS: readonly (keyof GraphNodeBudget)[] = ['steps', 'tokens', 'wallMs']
const CODE_RANK: ReadonlyMap<string, number> = new Map(Object.keys(REJECTION_RULES).map((code, index) => [code, index]))

/**
 * Read a map entry the caller has proved present.
 * @param map - lookup table.
 * @param key - a key known to be present.
 * @returns the value.
 */
function must<K, V>(map: ReadonlyMap<K, V>, key: K): V {
  const value = map.get(key)
  /* v8 ignore next -- callers look up only ids that structureRejections or the wave order proved present. */
  if (value === undefined) throw new Error(`graph audit: no entry for ${String(key)}`)
  return value
}

/**
 * Whether a node runs as a subagent.
 * @param node - plan node.
 * @returns false for `anchor` and `human_gate`, which run no agent.
 */
export function runsAsAgent(node: GraphNode): boolean {
  return AGENT_KINDS.has(node.kind)
}

/**
 * Whether two normalized write prefixes overlap.
 * @param left - one prefix.
 * @param right - another prefix.
 * @returns true when equal or one contains the other.
 */
export function scopesOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)
}

/**
 * The next wave: unplaced nodes whose every need is placed.
 * @param plan - the plan.
 * @param known - every declared node id.
 * @param placed - ids already in earlier waves.
 * @returns the wave, in declaration order.
 */
function nextWave(plan: GraphPlan, known: ReadonlySet<GraphNodeId>, placed: ReadonlySet<GraphNodeId>): GraphNodeId[] {
  return plan.nodes
    .filter(node => !placed.has(node.id) && node.needs.every(need => known.has(need) && placed.has(need)))
    .map(node => node.id)
}

/**
 * Layer the plan by needs. Nodes on a cycle, or needing an undeclared node, never join a wave.
 * @param plan - the plan.
 * @returns waves of nodes that can run together.
 */
export function planWaves(plan: GraphPlan): GraphNodeId[][] {
  const known = new Set(plan.nodes.map(node => node.id))
  const placed = new Set<GraphNodeId>()
  const waves: GraphNodeId[][] = []
  let wave = nextWave(plan, known, placed)
  while (wave.length > 0) {
    for (const id of wave) placed.add(id)
    waves.push(wave)
    wave = nextWave(plan, known, placed)
  }
  return waves
}

/**
 * A topological order and the nodes it cannot place.
 * @param plan - the plan.
 * @returns the flattened waves and the remaining node ids in declaration order.
 */
export function planOrder(plan: GraphPlan): { readonly order: GraphNodeId[]; readonly cyclic: GraphNodeId[] } {
  const order = planWaves(plan).flat()
  const placed = new Set(order)
  return { order, cyclic: plan.nodes.filter(node => !placed.has(node.id)).map(node => node.id) }
}

/**
 * Duplicate ids and dangling references; any finding here stops the audit.
 * @param plan - the parsed plan.
 * @returns `SCHEMA_INVALID` findings.
 */
function structureRejections(plan: GraphPlan): GraphRejection[] {
  const out: GraphRejection[] = []
  const nodes = new Map<GraphNodeId, GraphNode>()
  plan.nodes.forEach((node, index) => {
    if (nodes.has(node.id)) out.push(rejection('SCHEMA_INVALID', `nodes[${index}].id`, `node id ${node.id} is declared more than once`))
    else nodes.set(node.id, node)
  })
  for (const node of plan.nodes) {
    for (const need of node.needs) {
      if (!nodes.has(need)) out.push(rejection('SCHEMA_INVALID', `${node.id}.needs`, `needs undeclared node ${need}`))
    }
    for (const binding of node.inputs) {
      const subject = `${node.id}.inputs.${binding.name}`
      if (binding.from === 'run') {
        if (!plan.runInputs.includes(binding.field)) out.push(rejection('SCHEMA_INVALID', subject, `run input ${binding.field} is not declared in runInputs`))
        continue
      }
      const source = nodes.get(binding.from)
      if (source === undefined || !node.needs.includes(binding.from)) {
        out.push(rejection('SCHEMA_INVALID', subject, `binds to ${binding.from}, which is not in needs`))
      } else if (source.output.properties?.[binding.field] === undefined) {
        out.push(rejection('SCHEMA_INVALID', subject, `${binding.from} declares no output property ${binding.field}`))
      } else if (plan.edges.some(edge => edge.from === binding.from && edge.to === node.id
        && edge.allowedFields !== undefined && !edge.allowedFields.includes(binding.field))) {
        out.push(rejection('SCHEMA_INVALID', subject, `the edge ${binding.from}->${node.id} does not allow field ${binding.field}`))
      }
    }
  }
  const seen = new Set<string>()
  plan.edges.forEach((edge, index) => {
    const subject = `edges[${index}]`
    const target = nodes.get(edge.to)
    if (!nodes.has(edge.from) || target === undefined) {
      out.push(rejection('SCHEMA_INVALID', subject, `edge ${edge.from}->${edge.to} names an undeclared node`))
    } else if (!target.needs.includes(edge.from)) {
      out.push(rejection('SCHEMA_INVALID', subject, `edge ${edge.from}->${edge.to} is not listed in ${edge.to}.needs`))
    }
    const key = `${edge.from} ${edge.to} ${edge.relation}`
    if (seen.has(key)) out.push(rejection('SCHEMA_INVALID', subject, `edge ${edge.from}->${edge.to} (${edge.relation}) is declared more than once`))
    seen.add(key)
  })
  return out
}

/**
 * Dependents of every node.
 * @param plan - a plan whose needs are all declared.
 * @returns node id → ids that need it, in declaration order.
 */
function dependentsOf(plan: GraphPlan): ReadonlyMap<GraphNodeId, GraphNodeId[]> {
  const dependents = new Map<GraphNodeId, GraphNodeId[]>(plan.nodes.map(node => [node.id, []]))
  for (const node of plan.nodes) {
    for (const need of node.needs) must(dependents, need).push(node.id)
  }
  return dependents
}

/**
 * Transitive needs of every node.
 * @param plan - an acyclic plan.
 * @param order - its topological order.
 * @returns node id → every node it depends on.
 */
function ancestorsOf(plan: GraphPlan, order: readonly GraphNodeId[]): ReadonlyMap<GraphNodeId, ReadonlySet<GraphNodeId>> {
  const nodes = new Map(plan.nodes.map(node => [node.id, node]))
  const ancestors = new Map<GraphNodeId, Set<GraphNodeId>>()
  for (const id of order) {
    const set = new Set<GraphNodeId>()
    for (const need of must(nodes, id).needs) {
      set.add(need)
      for (const ancestor of must(ancestors, need)) set.add(ancestor)
    }
    ancestors.set(id, set)
  }
  return ancestors
}

function edgeRejections(plan: GraphPlan): GraphRejection[] {
  const out: GraphRejection[] = []
  for (const node of plan.nodes) {
    for (const need of node.needs) {
      if (!plan.edges.some(edge => edge.from === need && edge.to === node.id)) {
        out.push(rejection('EDGE_WITHOUT_ARTIFACT', `${need}->${node.id}`, 'this dependency has no declared edge, so no artifact crosses it'))
      }
    }
  }
  for (const edge of plan.edges) {
    if (edge.artifact.trim() === '') out.push(rejection('EDGE_WITHOUT_ARTIFACT', `${edge.from}->${edge.to}`, 'edge artifact is blank'))
  }
  return out
}

function closenessRejections(
  plan: GraphPlan,
  dependents: ReadonlyMap<GraphNodeId, GraphNodeId[]>,
  order: readonly GraphNodeId[],
): GraphRejection[] {
  if (plan.nodes.length === 1) return []
  const isolated = new Set(plan.nodes
    .filter(node => node.needs.length === 0 && must(dependents, node.id).length === 0)
    .map(node => node.id))
  const out = [...isolated].map(id => rejection('ISOLATED_NODE', id, 'no node needs it and it needs no node'))
  const kinds = new Map(plan.nodes.map(node => [node.id, node.kind]))
  const sinks = order.filter(id => !isolated.has(id) && must(dependents, id).length === 0)
  const terminal = plan.nodes.some(node => TERMINAL_KINDS.has(node.kind))
  const unconsumed = terminal ? sinks.filter(id => !TERMINAL_KINDS.has(must(kinds, id))) : sinks.slice(0, -1)
  const detail = terminal
    ? 'its output reaches no node, and only synthesis or stop_handoff nodes may end the plan'
    : 'its output reaches no node, and a plan without a synthesis node may end in one sink only'
  return [...out, ...unconsumed.map(id => rejection('NOT_CONSUMED', id, detail))]
}

function anchorRejections(plan: GraphPlan): GraphRejection[] {
  const out = plan.nodes
    .filter(node => node.kind === 'anchor' && node.verify.length === 0)
    .map(node => rejection('MISSING_ANCHOR', node.id, 'an anchor must be a predicate, and this one declares no verify command'))
  const anchored = plan.nodes.some(node => node.kind === 'anchor' && node.verify.length > 0
    && plan.edges.some(edge => edge.from === node.id && edge.relation === 'anchors'))
  if (plan.level !== 'L1' && !anchored) {
    out.push(rejection('MISSING_ANCHOR', plan.id, `a ${plan.level} plan needs an anchor node with verify commands and an outgoing anchors edge`))
  }
  return out
}

function declaresVerdict(node: GraphNode): boolean {
  const values = node.output.properties?.['verdict']?.enum ?? []
  return (node.output.required ?? []).includes('verdict') && values.includes('pass') && values.includes('fail')
}

function freshnessRejections(plan: GraphPlan): GraphRejection[] {
  const out: GraphRejection[] = []
  const kinds = new Map(plan.nodes.map(node => [node.id, node.kind]))
  const verifications = plan.nodes.filter(node => node.kind === 'verification')
  for (const node of verifications) {
    if (node.contextScope !== 'fresh-independent') out.push(rejection('VERIFIER_NOT_FRESH', node.id, 'the verification node starts with execution-only context'))
    for (const edge of plan.edges) {
      if (edge.to === node.id && edge.relation === 'feeds' && kinds.get(edge.from) === 'execution') {
        out.push(rejection('VERIFIER_NOT_FRESH', `${edge.from}->${node.id}`, 'the verification node is fed an execution report'))
      }
    }
    if (!declaresVerdict(node)) out.push(rejection('VERDICT_UNDECLARED', node.id, 'the output does not require verdict with enum ["pass", "fail"]'))
  }
  if (plan.level !== 'L1' && verifications.length === 0) {
    out.push(rejection('VERIFIER_NOT_FRESH', plan.id, `a ${plan.level} plan needs a verification node`))
  }
  return out
}

function orderRejections(plan: GraphPlan, ancestors: ReadonlyMap<GraphNodeId, ReadonlySet<GraphNodeId>>): GraphRejection[] {
  const kinds = new Map(plan.nodes.map(node => [node.id, node.kind]))
  return plan.nodes
    .filter(node => node.kind === 'synthesis' && ![...must(ancestors, node.id)].some(id => kinds.get(id) === 'verification'))
    .map(node => rejection('SYNTHESIS_BEFORE_VERIFY', node.id, 'no verification node precedes this synthesis node'))
}

function gateRejections(plan: GraphPlan): GraphRejection[] {
  if (plan.level !== 'L3') return []
  const out: GraphRejection[] = []
  if (!plan.nodes.some(node => node.kind === 'human_gate')) out.push(rejection('MISSING_HUMAN_GATE', plan.id, 'an L3 plan needs a human_gate node'))
  if (!plan.nodes.some(node => node.kind === 'stop_handoff')) out.push(rejection('MISSING_STOP_HANDOFF', plan.id, 'an L3 plan needs a stop_handoff node'))
  return out
}

function writeRejections(plan: GraphPlan, ancestors: ReadonlyMap<GraphNodeId, ReadonlySet<GraphNodeId>>): GraphRejection[] {
  const out: GraphRejection[] = []
  plan.nodes.forEach((left, index) => {
    for (const right of plan.nodes.slice(index + 1)) {
      if (must(ancestors, left.id).has(right.id) || must(ancestors, right.id).has(left.id)) continue
      const pairs = left.writes.flatMap(a => right.writes.filter(b => scopesOverlap(a, b)).map(b => `${a} overlaps ${b}`))
      if (pairs.length > 0) out.push(rejection('WRITE_SCOPE_OVERLAP', `${left.id},${right.id}`, `${pairs.join('; ')}, and the two nodes can run in the same wave`))
    }
  })
  return out
}

/**
 * Why one declared tool cannot be granted.
 * @param tool - tool name.
 * @param env - audit environment.
 * @returns the reason, or undefined when the tool is granted.
 */
function toolProblem(tool: string, env: AuditEnvironment): string | undefined {
  if (tool === RUN_CODE_NAME) return 'run_code is the PTC transport, not a node tool'
  if (!env.allowedTools.has(tool)) return 'not in the graph tool allowlist of this deployment'
  if (!env.isRegisteredTool(tool)) return 'no global tool with this name is registered'
  return undefined
}

function capabilityRejections(plan: GraphPlan, env: AuditEnvironment): GraphRejection[] {
  const out: GraphRejection[] = []
  for (const node of plan.nodes) {
    if (!runsAsAgent(node) && node.tools.length > 0) out.push(rejection('CAPABILITY_UNVERIFIED', node.id, `${node.kind} nodes run no agent, so they take no tools`))
    for (const tool of node.tools) {
      const problem = toolProblem(tool, env)
      if (problem !== undefined) out.push(rejection('CAPABILITY_UNVERIFIED', `${node.id}:${tool}`, problem))
    }
  }
  if (env.depth === undefined && plan.nodes.some(runsAsAgent)) {
    out.push(rejection('CAPABILITY_UNVERIFIED', 'subagents', 'no subagent service is mounted, so no agent node can run'))
  }
  return out
}

function depthRejections(plan: GraphPlan, env: AuditEnvironment): GraphRejection[] {
  const depth = env.depth
  if (depth === undefined || !plan.nodes.some(runsAsAgent) || depth.current + 1 <= depth.max) return []
  return [rejection('DEPTH_EXCEEDED', plan.id, `agent nodes would run at delegation depth ${depth.current + 1}, and the limit is ${depth.max}`)]
}

function inputRejections(plan: GraphPlan): GraphRejection[] {
  const nodes = new Map(plan.nodes.map(node => [node.id, node]))
  const out: GraphRejection[] = []
  for (const node of plan.nodes) {
    for (const binding of node.inputs) {
      if (binding.from === 'run' || binding.fallback !== undefined) continue
      if (must(nodes, binding.from).mayFail) {
        out.push(rejection('INPUT_MAY_BE_ABSENT', `${node.id}.inputs.${binding.name}`, `${binding.from} may fail and the binding has no fallback`))
      }
    }
  }
  return out
}

function freezeRejections(plan: GraphPlan, env: AuditEnvironment): GraphRejection[] {
  const frozen = env.frozenAcceptance
  if (frozen === undefined || deepEqualJson(plan.acceptance, frozen)) return []
  return [rejection('ACCEPTANCE_CHANGED', plan.id, 'acceptance differs from the list the first version froze')]
}

function linearRejections(plan: GraphPlan, dependents: ReadonlyMap<GraphNodeId, GraphNodeId[]>): GraphRejection[] {
  if (plan.nodes.length < 2 || plan.nodes.some(node => node.kind === 'verification')) return []
  const chain = plan.nodes.every(node => node.needs.length <= 1 && must(dependents, node.id).length <= 1)
  return chain ? [rejection('LINEAR_PLAN', plan.id, 'every node has at most one dependency and one dependent')] : []
}

/**
 * Longest needs path, weighting agent nodes by their worst-case wall time.
 * @param plan - an acyclic plan.
 * @param order - its topological order.
 * @param cost - worst-case wall time per agent node.
 * @returns the critical-path wall time.
 */
function criticalPath(plan: GraphPlan, order: readonly GraphNodeId[], cost: ReadonlyMap<GraphNodeId, number>): number {
  const nodes = new Map(plan.nodes.map(node => [node.id, node]))
  const finish = new Map<GraphNodeId, number>()
  for (const id of order) {
    const start = Math.max(0, ...must(nodes, id).needs.map(need => must(finish, need)))
    finish.set(id, start + (cost.get(id) ?? 0))
  }
  return Math.max(0, ...finish.values())
}

function budgetRejections(plan: GraphPlan, env: AuditEnvironment, order: readonly GraphNodeId[]): GraphRejection[] {
  const out: GraphRejection[] = []
  const agents = plan.nodes.filter(runsAsAgent)
  for (const kind of BUDGET_KINDS) {
    const limit = env.runBudget[kind]
    if (limit === 0) continue
    const cost = new Map<GraphNodeId, number>()
    for (const node of agents) {
      const perAttempt = node.budget[kind]
      if (perAttempt === undefined) out.push(rejection('BUDGET_EXCEEDED', `${node.id}.budget.${kind}`, `the run limit is ${limit} ${kind} and the node declares no ${kind} budget`))
      else cost.set(node.id, perAttempt * (node.retryBudget + 1))
    }
    if (cost.size < agents.length) continue
    const worst = kind === 'wallMs' ? criticalPath(plan, order, cost) : [...cost.values()].reduce((sum, value) => sum + value, 0)
    if (worst > limit) out.push(rejection('BUDGET_EXCEEDED', `budget.${kind}`, `worst case ${worst} ${kind} exceeds the run limit ${limit}`))
  }
  return out
}

/**
 * Order findings by rule order, then by subject.
 * @param list - findings.
 * @returns a sorted copy.
 */
function sortRejections(list: readonly GraphRejection[]): GraphRejection[] {
  return [...list].sort((left, right) =>
    must(CODE_RANK, left.code) - must(CODE_RANK, right.code) || (left.subject < right.subject ? -1 : Number(left.subject > right.subject)))
}

/**
 * Audit one parsed plan. Structure errors stop the audit; a cycle skips the
 * checks that need an order (synthesis order, write waves, budgets).
 * @param plan - the parsed, normalized plan.
 * @param env - what the audit may know about the deployment and history.
 * @returns findings, and the order and waves when the plan is a DAG.
 */
export function auditPlan(plan: GraphPlan, env: AuditEnvironment): AuditResult {
  const structural = structureRejections(plan)
  if (structural.length > 0) return { rejections: sortRejections(structural), order: undefined, waves: undefined }
  const dependents = dependentsOf(plan)
  const { order, cyclic } = planOrder(plan)
  const acyclic = cyclic.length === 0
  const rejections: GraphRejection[] = [
    ...acyclic ? [] : [rejection('CYCLE', cyclic.join(','), `nodes ${cyclic.join(', ')} cannot be ordered by their needs`)],
    ...edgeRejections(plan),
    ...closenessRejections(plan, dependents, acyclic ? order : plan.nodes.map(node => node.id)),
    ...anchorRejections(plan),
    ...freshnessRejections(plan),
    ...gateRejections(plan),
    ...capabilityRejections(plan, env),
    ...depthRejections(plan, env),
    ...inputRejections(plan),
    ...freezeRejections(plan, env),
    ...linearRejections(plan, dependents),
  ]
  if (!acyclic) return { rejections: sortRejections(rejections), order: undefined, waves: undefined }
  const ancestors = ancestorsOf(plan, order)
  rejections.push(...orderRejections(plan, ancestors), ...writeRejections(plan, ancestors), ...budgetRejections(plan, env, order))
  return { rejections: sortRejections(rejections), order, waves: planWaves(plan) }
}
