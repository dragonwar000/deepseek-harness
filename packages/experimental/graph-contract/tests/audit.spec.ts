import { describe, expect, it } from 'vitest'
import { auditPlan, planOrder, planWaves, REJECTION_RULES, routesFor, runsAsAgent, scopesOverlap } from '../src/audit.ts'
import type { AuditEnvironment } from '../src/audit.ts'
import { parsePlan } from '../src/schema.ts'
import type { GraphPlan, GraphRejection, GraphRejectionCode } from '../src/types.ts'

interface NodeInput {
  id: string
  kind: string
  instruction: string
  needs?: string[]
  inputs?: { name: string; from: string; field: string; fallback?: string }[]
  output?: Record<string, unknown>
  tools?: string[]
  writes?: string[]
  verify?: string[]
  budget?: { steps?: number; tokens?: number; wallMs?: number }
  retryBudget?: number
  contextScope?: string
  mayFail?: boolean
  category?: string
}
interface EdgeInput { from: string; to: string; relation: string; artifact: string; allowedFields?: string[] }
interface PlanInput {
  format: string
  id: string
  level: string
  goal: string
  runInputs?: string[]
  nodes: NodeInput[]
  edges: EdgeInput[]
  deliverable: string
  acceptance: string[]
}

const VERDICT_OUTPUT = {
  type: 'object',
  properties: { verdict: { type: 'string', enum: ['pass', 'fail'] }, notes: { type: 'string' } },
  required: ['verdict'],
  additionalProperties: false,
}
const SUMMARY_OUTPUT = { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'], additionalProperties: false }
const BUDGET = { steps: 20, tokens: 40_000, wallMs: 600_000 }

/** A valid L2 diamond: anchor → two parallel executions → fresh verification → synthesis. */
function diamond(): PlanInput {
  return {
    format: 'dsh-graph/v1',
    id: 'ship',
    level: 'L2',
    goal: 'Ship the parser fix with its documentation',
    nodes: [
      { id: 'spec', kind: 'anchor', instruction: 'The spec file exists', verify: ['test -f SPEC.md'] },
      { id: 'build', kind: 'execution', instruction: 'Fix the parser', needs: ['spec'], tools: ['read', 'edit'], writes: ['src'], output: SUMMARY_OUTPUT, budget: { ...BUDGET } },
      { id: 'docs', kind: 'execution', instruction: 'Document the fix', needs: ['spec'], tools: ['read', 'edit'], writes: ['docs'], output: SUMMARY_OUTPUT, budget: { ...BUDGET } },
      { id: 'check', kind: 'verification', instruction: 'Check the fix against the spec', needs: ['build', 'docs'], tools: ['read'], contextScope: 'fresh-independent', output: VERDICT_OUTPUT, budget: { ...BUDGET } },
      { id: 'report', kind: 'synthesis', instruction: 'Summarize the verified result', needs: ['check'], inputs: [{ name: 'verdict', from: 'check', field: 'verdict' }], budget: { ...BUDGET } },
    ],
    edges: [
      { from: 'spec', to: 'build', relation: 'anchors', artifact: 'SPEC.md' },
      { from: 'spec', to: 'docs', relation: 'anchors', artifact: 'SPEC.md' },
      { from: 'build', to: 'check', relation: 'verifies', artifact: 'src/' },
      { from: 'docs', to: 'check', relation: 'verifies', artifact: 'docs/' },
      { from: 'check', to: 'report', relation: 'feeds', artifact: 'verdict' },
    ],
    deliverable: 'A verified parser fix with documentation',
    acceptance: ['pnpm test passes', 'the docs describe the fix'],
  }
}

/** A two-node L1 chain. */
function chain(): PlanInput {
  return {
    format: 'dsh-graph/v1',
    id: 'chain',
    level: 'L1',
    goal: 'Two steps in order',
    nodes: [
      { id: 'first', kind: 'execution', instruction: 'Do the first step', tools: ['read'], output: SUMMARY_OUTPUT },
      { id: 'second', kind: 'execution', instruction: 'Do the second step', needs: ['first'], tools: ['read'] },
    ],
    edges: [{ from: 'first', to: 'second', relation: 'hands_off', artifact: 'summary' }],
    deliverable: 'Both steps done',
    acceptance: ['second step finished'],
  }
}

function node(plan: PlanInput, id: string): NodeInput {
  const found = plan.nodes.find(entry => entry.id === id)
  if (found === undefined) throw new Error(`no node ${id}`)
  return found
}

const ENV: AuditEnvironment = {
  allowedTools: new Set(['read', 'edit']),
  isRegisteredTool: () => true,
  runBudget: { steps: 0, tokens: 0, wallMs: 0 },
  depth: { current: 0, max: 1 },
  frozenAcceptance: undefined,
  routes: new Map(),
}

function parsed(input: PlanInput): GraphPlan {
  const result = parsePlan(input)
  if (!result.ok) throw new Error(JSON.stringify(result.rejections))
  return result.plan
}

function audit(input: PlanInput, env: Partial<AuditEnvironment> = {}): GraphRejection[] {
  return auditPlan(parsed(input), { ...ENV, ...env }).rejections
}

describe('auditPlan admission', () => {
  it('admits the L2 diamond with its order and waves', () => {
    const result = auditPlan(parsed(diamond()), ENV)
    expect(result.rejections).toEqual([])
    expect(result.order).toEqual(['spec', 'build', 'docs', 'check', 'report'])
    expect(result.waves).toEqual([['spec'], ['build', 'docs'], ['check'], ['report']])
  })

  it('admits a single-node L1 plan and a lone anchor without depth or closeness findings', () => {
    const single = chain()
    single.nodes = [{ id: 'only', kind: 'execution', instruction: 'Do it', tools: ['read'] }]
    single.edges = []
    expect(audit(single)).toEqual([])
    const anchorOnly = chain()
    anchorOnly.nodes = [{ id: 'gate', kind: 'anchor', instruction: 'Tests exist', verify: ['test -d tests'] }]
    anchorOnly.edges = []
    expect(audit(anchorOnly, { depth: { current: 5, max: 1 } })).toEqual([])
  })

  it('warns LINEAR_PLAN for an L1 chain without requiring anchors or verification', () => {
    const result = audit(chain())
    expect(result).toEqual([expect.objectContaining({ code: 'LINEAR_PLAN', severity: 'warn', subject: 'chain' })])
  })

  it('accepts a declared run input binding and an unchanged frozen acceptance', () => {
    const plan = diamond()
    plan.runInputs = ['ticket']
    node(plan, 'build').inputs = [{ name: 'ticket', from: 'run', field: 'ticket' }]
    expect(audit(plan, { frozenAcceptance: ['pnpm test passes', 'the docs describe the fix'] })).toEqual([])
  })

  it('accepts a mayFail source when the binding has a fallback', () => {
    const plan = diamond()
    node(plan, 'build').mayFail = true
    node(plan, 'check').inputs = [{ name: 'summary', from: 'build', field: 'summary', fallback: 'no summary' }]
    expect(audit(plan)).toEqual([])
  })
})

describe('auditPlan rejections', () => {
  it('routes categories only through configured routes and only on agent nodes', () => {
    const coding = { category: 'coding', provider: 'deepseek', model: 'deepseek-v4-pro', reliability: 'unverified' as const }
    const plan = diamond()
    node(plan, 'build').category = 'coding'
    node(plan, 'docs').category = 'review'
    node(plan, 'spec').category = 'coding'
    const found = audit(plan, { routes: new Map([['coding', coding]]) })
      .filter(entry => entry.code === 'CAPABILITY_UNVERIFIED')
      .map(entry => [entry.subject, entry.detail])
    expect(found).toEqual([
      ['docs:category', 'no route is configured for category review'],
      ['spec:category', 'anchor nodes run no agent, so they take no category'],
    ])
    expect(routesFor(parsed(plan), new Map([['coding', coding]]))).toEqual([coding])
  })

  it.each<[GraphRejectionCode, (plan: PlanInput) => void, Partial<AuditEnvironment>]>([
    ['CYCLE', (plan) => {
      node(plan, 'spec').needs = ['report']
      plan.edges.push({ from: 'report', to: 'spec', relation: 'feeds', artifact: 'loop' })
    }, {}],
    ['ISOLATED_NODE', (plan) => { plan.nodes.push({ id: 'stray', kind: 'execution', instruction: 'Unrelated work', tools: ['read'] }) }, {}],
    ['NOT_CONSUMED', (plan) => {
      plan.nodes.push({ id: 'extra', kind: 'execution', instruction: 'Side work', needs: ['spec'], tools: ['read'] })
      plan.edges.push({ from: 'spec', to: 'extra', relation: 'anchors', artifact: 'SPEC.md' })
    }, {}],
    ['MISSING_ANCHOR', (plan) => { node(plan, 'spec').verify = [] }, {}],
    ['VERIFIER_NOT_FRESH', (plan) => { node(plan, 'check').contextScope = 'execution-only' }, {}],
    ['VERDICT_UNDECLARED', (plan) => {
      node(plan, 'check').output = { type: 'object', properties: { verdict: { type: 'string', enum: ['pass', 'fail'] } }, additionalProperties: false }
    }, {}],
    ['SYNTHESIS_BEFORE_VERIFY', (plan) => {
      const report = node(plan, 'report')
      report.needs = ['build']
      report.inputs = []
      plan.edges = plan.edges.filter(edge => edge.to !== 'report')
      plan.edges.push({ from: 'build', to: 'report', relation: 'feeds', artifact: 'summary' })
    }, {}],
    ['MISSING_HUMAN_GATE', (plan) => { plan.level = 'L3' }, {}],
    ['MISSING_STOP_HANDOFF', (plan) => { plan.level = 'L3' }, {}],
    ['WRITE_SCOPE_OVERLAP', (plan) => { node(plan, 'docs').writes = ['src/api'] }, {}],
    ['CAPABILITY_UNVERIFIED', (plan) => { node(plan, 'build').tools = ['read', 'bash'] }, {}],
    ['BUDGET_EXCEEDED', () => undefined, { runBudget: { steps: 0, tokens: 100_000, wallMs: 0 } }],
    ['INPUT_MAY_BE_ABSENT', (plan) => {
      node(plan, 'build').mayFail = true
      node(plan, 'check').inputs = [{ name: 'summary', from: 'build', field: 'summary' }]
    }, {}],
    ['EDGE_WITHOUT_ARTIFACT', (plan) => { plan.edges[0]!.artifact = '  ' }, {}],
    ['DEPTH_EXCEEDED', () => undefined, { depth: { current: 1, max: 1 } }],
    ['ACCEPTANCE_CHANGED', () => undefined, { frozenAcceptance: ['something else'] }],
  ])('rejects %s with its fixed rule', (code, mutate, env) => {
    const plan = diamond()
    mutate(plan)
    const found = audit(plan, env).filter(entry => entry.code === code)
    expect(found.length).toBeGreaterThan(0)
    expect(found[0]).toMatchObject({ severity: 'reject', check: REJECTION_RULES[code].check, remedy: REJECTION_RULES[code].remedy })
  })

  it('reports structure errors alone and computes no order', () => {
    const plan = diamond()
    node(plan, 'docs').id = 'build'
    const result = auditPlan(parsed(plan), ENV)
    expect(result.order).toBeUndefined()
    expect(result.waves).toBeUndefined()
    expect(new Set(result.rejections.map(entry => entry.code))).toEqual(new Set(['SCHEMA_INVALID']))
    expect(result.rejections).toContainEqual(expect.objectContaining({ subject: 'nodes[2].id' }))
  })

  it.each<[string, (plan: PlanInput) => void, string]>([
    ['an unknown need', (plan) => { node(plan, 'check').needs = ['build', 'docs', 'ghost'] }, 'check.needs'],
    ['an undeclared run input', (plan) => { node(plan, 'build').inputs = [{ name: 'ticket', from: 'run', field: 'ticket' }] }, 'build.inputs.ticket'],
    ['a binding to a node outside needs', (plan) => { node(plan, 'report').inputs = [{ name: 'summary', from: 'build', field: 'summary' }] }, 'report.inputs.summary'],
    ['a binding to an undeclared output property', (plan) => { node(plan, 'report').inputs = [{ name: 'notes', from: 'check', field: 'missing' }] }, 'report.inputs.notes'],
    ['a binding to a source without output properties', (plan) => {
      node(plan, 'check').output = { type: 'object', additionalProperties: true }
    }, 'report.inputs.verdict'],
    ['a binding to a field the edge does not allow', (plan) => { plan.edges[4] = { ...plan.edges[4]!, allowedFields: ['notes'] } }, 'report.inputs.verdict'],
    ['an edge that is not a need', (plan) => { plan.edges.push({ from: 'spec', to: 'report', relation: 'constrains', artifact: 'SPEC.md' }) }, 'edges[5]'],
    ['an edge to an unknown node', (plan) => { plan.edges.push({ from: 'spec', to: 'ghost', relation: 'constrains', artifact: 'SPEC.md' }) }, 'edges[5]'],
    ['a repeated edge', (plan) => { plan.edges.push({ from: 'spec', to: 'build', relation: 'anchors', artifact: 'SPEC.md' }) }, 'edges[5]'],
  ])('rejects %s as SCHEMA_INVALID', (_label, mutate, subject) => {
    const plan = diamond()
    mutate(plan)
    expect(audit(plan)).toContainEqual(expect.objectContaining({ code: 'SCHEMA_INVALID', subject }))
  })

  it('names every missing edge and every anchor without a predicate', () => {
    const plan = diamond()
    plan.edges = plan.edges.filter(edge => edge.from !== 'docs')
    node(plan, 'spec').verify = []
    const found = audit(plan)
    expect(found).toContainEqual(expect.objectContaining({ code: 'EDGE_WITHOUT_ARTIFACT', subject: 'docs->check' }))
    expect(found.filter(entry => entry.code === 'MISSING_ANCHOR').map(entry => entry.subject)).toEqual(['ship', 'spec'])
  })

  it('allows one sink without a terminal node and rejects the other sinks', () => {
    const plan = chain()
    plan.nodes.push({ id: 'third', kind: 'execution', instruction: 'Do a parallel step', needs: ['first'], tools: ['read'] })
    plan.edges.push({ from: 'first', to: 'third', relation: 'hands_off', artifact: 'summary' })
    expect(audit(plan)).toEqual([expect.objectContaining({ code: 'NOT_CONSUMED', subject: 'second' })])
  })

  it('requires a verification node from L2 and a fresh one fed only through verifies edges', () => {
    const noVerifier = diamond()
    node(noVerifier, 'check').kind = 'reducer'
    expect(audit(noVerifier)).toContainEqual(expect.objectContaining({ code: 'VERIFIER_NOT_FRESH', subject: 'ship' }))
    const fed = diamond()
    fed.edges[2]!.relation = 'feeds'
    expect(audit(fed)).toContainEqual(expect.objectContaining({ code: 'VERIFIER_NOT_FRESH', subject: 'build->check' }))
  })

  it('requires a declared verdict even when the output has no properties', () => {
    const plan = diamond()
    node(plan, 'check').output = { type: 'object', additionalProperties: true }
    node(plan, 'report').inputs = []
    expect(audit(plan)).toContainEqual(expect.objectContaining({ code: 'VERDICT_UNDECLARED', subject: 'check' }))
  })

  it('names why each tool is unverified', () => {
    const plan = diamond()
    node(plan, 'build').tools = ['run_code']
    node(plan, 'docs').tools = ['read', 'edit']
    node(plan, 'spec').tools = ['read']
    const found = audit(plan, { isRegisteredTool: name => name !== 'edit' })
      .filter(entry => entry.code === 'CAPABILITY_UNVERIFIED')
      .map(entry => [entry.subject, entry.detail])
    expect(found).toEqual([
      ['build:run_code', 'run_code is the PTC transport, not a node tool'],
      ['docs:edit', 'no global tool with this name is registered'],
      ['spec', 'anchor nodes run no agent, so they take no tools'],
    ])
    expect(audit(diamond(), { depth: undefined })).toContainEqual(expect.objectContaining({ code: 'CAPABILITY_UNVERIFIED', subject: 'subagents' }))
  })

  it('prices budgets per attempt, sums steps and tokens, and takes the critical path for wall time', () => {
    expect(audit(diamond(), { runBudget: { steps: 80, tokens: 160_000, wallMs: 1_800_000 } })).toEqual([])
    const tight = audit(diamond(), { runBudget: { steps: 79, tokens: 0, wallMs: 1_700_000 } }).map(entry => entry.subject)
    expect(tight).toEqual(['budget.steps', 'budget.wallMs'])
    const retried = diamond()
    node(retried, 'build').retryBudget = 1
    expect(audit(retried, { runBudget: { steps: 0, tokens: 199_999, wallMs: 0 } })).toContainEqual(expect.objectContaining({ subject: 'budget.tokens', detail: 'worst case 200000 tokens exceeds the run limit 199999' }))
    const unbounded = diamond()
    node(unbounded, 'report').budget = {}
    expect(audit(unbounded, { runBudget: { steps: 0, tokens: 1_000_000, wallMs: 0 } }).map(entry => entry.subject)).toEqual(['report.budget.tokens'])
  })

  it('accepts an L3 plan that declares a human gate and a stop handoff', () => {
    const plan = diamond()
    plan.level = 'L3'
    plan.nodes.push(
      { id: 'approve', kind: 'human_gate', instruction: 'Approve the report', needs: ['report'] },
      { id: 'handoff', kind: 'stop_handoff', instruction: 'Hand the result off', needs: ['approve'], budget: { ...BUDGET } },
    )
    plan.edges.push(
      { from: 'report', to: 'approve', relation: 'feeds', artifact: 'report' },
      { from: 'approve', to: 'handoff', relation: 'hands_off', artifact: 'approval' },
    )
    expect(audit(plan)).toEqual([])
  })

  it('orders findings by rule order, then by subject', () => {
    const plan = diamond()
    plan.level = 'L3'
    node(plan, 'build').tools = ['bash']
    node(plan, 'docs').tools = ['bash']
    expect(audit(plan).map(entry => `${entry.code}:${entry.subject}`)).toEqual([
      'MISSING_HUMAN_GATE:ship',
      'MISSING_STOP_HANDOFF:ship',
      'CAPABILITY_UNVERIFIED:build:bash',
      'CAPABILITY_UNVERIFIED:docs:bash',
    ])
  })
})

describe('graph helpers', () => {
  it('layers waves, drops cyclic and dangling nodes, and orders them', () => {
    expect(planWaves(parsed(diamond()))).toEqual([['spec'], ['build', 'docs'], ['check'], ['report']])
    const cyclic = diamond()
    node(cyclic, 'spec').needs = ['report']
    cyclic.edges.push({ from: 'report', to: 'spec', relation: 'feeds', artifact: 'loop' })
    expect(planOrder(parsed(cyclic))).toEqual({ order: [], cyclic: ['spec', 'build', 'docs', 'check', 'report'] })
    const dangling = diamond()
    node(dangling, 'report').needs = ['check', 'ghost']
    expect(planWaves(parsed(dangling))).toEqual([['spec'], ['build', 'docs'], ['check']])
  })

  it('classifies agent nodes and overlapping prefixes', () => {
    const plan = parsed(diamond())
    expect(plan.nodes.map(runsAsAgent)).toEqual([false, true, true, true, true])
    expect(scopesOverlap('src', 'src/api')).toBe(true)
    expect(scopesOverlap('src/api', 'src')).toBe(true)
    expect(scopesOverlap('src', 'src')).toBe(true)
    expect(scopesOverlap('src', 'srcx')).toBe(false)
  })
})
