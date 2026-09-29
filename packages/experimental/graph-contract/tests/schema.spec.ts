import { describe, expect, it } from 'vitest'
import { canonicalJson, planSha } from '../src/digest.ts'
import { normalizeWriteScope, parsePlan } from '../src/schema.ts'

const SUMMARY_OUTPUT = { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'], additionalProperties: false }

function minimal(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: 'dsh-graph/v1',
    id: 'ship',
    level: 'L1',
    goal: 'Ship one change',
    nodes: [{ id: 'build', kind: 'execution', instruction: 'Make the change', output: SUMMARY_OUTPUT, writes: ['./src/'] }],
    deliverable: 'The change',
    acceptance: ['tests pass'],
    ...extra,
  }
}

describe('parsePlan', () => {
  it('fills node defaults and normalizes write scopes', () => {
    const parsed = parsePlan(minimal())
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.plan.runInputs).toEqual([])
    expect(parsed.plan.edges).toEqual([])
    expect(parsed.plan.nodes[0]).toMatchObject({
      needs: [], inputs: [], tools: [], writes: ['src'], verify: [], budget: {},
      retryBudget: 0, contextScope: 'execution-only', mayFail: false,
    })
  })

  it('gives a node without output an empty closed object schema', () => {
    const parsed = parsePlan(minimal({ nodes: [{ id: 'build', kind: 'execution', instruction: 'x' }] }))
    expect(parsed.ok && parsed.plan.nodes[0]?.output).toEqual({ type: 'object', properties: {}, additionalProperties: false })
  })

  it('rejects harness-owned node fields as unknown keys', () => {
    const parsed = parsePlan(minimal({ nodes: [{ id: 'build', kind: 'execution', instruction: 'x', status: 'executed' }] }))
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.planId).toBe('ship')
    expect(parsed.rejections).toEqual([expect.objectContaining({ code: 'SCHEMA_INVALID', check: 'schema', severity: 'reject', subject: 'plan.nodes[0]' })])
    expect(parsed.rejections[0]?.detail).toMatch(/status/)
  })

  it('rejects a plan-level version field and a cycleGuard on an edge', () => {
    const parsed = parsePlan(minimal({ version: 2, edges: [{ from: 'build', to: 'build', relation: 'feeds', artifact: 'x', cycleGuard: { maxIterations: 2 } }] }))
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.rejections.map(entry => entry.subject)).toEqual(expect.arrayContaining(['plan', 'plan.edges[0]']))
  })

  it.each([
    ['reserved node id', { nodes: [{ id: 'run', kind: 'execution', instruction: 'x' }] }, 'plan.nodes[0].id'],
    ['upper-case plan id', { id: 'Ship' }, 'plan.id'],
    ['non-object output schema', { nodes: [{ id: 'build', kind: 'execution', instruction: 'x', output: { type: 'string' } }] }, 'plan.nodes[0].output'],
    ['escaping write scope', { nodes: [{ id: 'build', kind: 'execution', instruction: 'x', writes: ['../etc'] }] }, 'plan.nodes[0].writes[0]'],
    ['blank instruction', { nodes: [{ id: 'build', kind: 'execution', instruction: '  ' }] }, 'plan.nodes[0].instruction'],
    ['repeated need', { nodes: [{ id: 'build', kind: 'execution', instruction: 'x', needs: ['a', 'a'] }] }, 'plan.nodes[0].needs'],
    ['wrong format', { format: 'dsh-graph/v2' }, 'plan.format'],
    ['empty acceptance', { acceptance: [] }, 'plan.acceptance'],
  ])('reports %s at its path', (_label, extra, subject) => {
    const parsed = parsePlan(minimal(extra))
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.rejections.map(entry => entry.subject)).toContain(subject)
  })

  it('reads no plan id from input without a valid one', () => {
    for (const input of ['text', null, { id: 'Bad Id' }, { goal: 'no id' }]) {
      const parsed = parsePlan(input)
      expect(parsed.ok).toBe(false)
      if (!parsed.ok) expect(parsed.planId).toBeUndefined()
    }
  })
})

describe('normalizeWriteScope', () => {
  it.each([
    ['./src/', 'src'],
    ['docs\\api', 'docs/api'],
    ['a/b', 'a/b'],
    ['', undefined],
    ['/abs', undefined],
    ['C:/x', undefined],
    ['a/./b', undefined],
    ['a//b', undefined],
  ])('%s → %s', (input, expected) => {
    expect(normalizeWriteScope(input)).toBe(expected)
  })
})

describe('digest', () => {
  it('ignores key order and changes with content', () => {
    expect(planSha({ b: [1, { d: true, c: null }], a: 'x' })).toBe(planSha({ a: 'x', b: [1, { c: null, d: true }] }))
    expect(planSha({ a: 'x' })).not.toBe(planSha({ a: 'y' }))
    expect(planSha('x')).toMatch(/^[0-9a-f]{64}$/)
    expect(canonicalJson({ b: 1, a: [true, 'x'] })).toBe('{"a":[true,"x"],"b":1}')
  })
})
