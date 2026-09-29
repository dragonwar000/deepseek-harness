import { describe, expect, it } from 'vitest'
import { graphNodeId, parsePlan } from '@deepseek-ai/dsh-experimental-graph-contract'
import type { GraphPlan } from '@deepseek-ai/dsh-experimental-graph-contract'
import { INTERRUPTED_NOTE, nodePrompt } from '../src/prompt.ts'

function plan(): GraphPlan {
  const parsed = parsePlan({
    format: 'dsh-graph/v1', id: 'ship', level: 'L2', goal: 'Ship the fix',
    nodes: [
      { id: 'build', kind: 'execution', instruction: '  Fix the parser  ', tools: ['read', 'edit'], writes: ['src'] },
      { id: 'check', kind: 'verification', instruction: 'Check the fix', needs: ['build'], tools: ['read'], contextScope: 'fresh-independent',
        output: { type: 'object', properties: { verdict: { type: 'string', enum: ['pass', 'fail'] } }, required: ['verdict'], additionalProperties: false } },
      { id: 'report', kind: 'synthesis', instruction: 'Summarize', needs: ['check'] },
    ],
    edges: [
      { from: 'build', to: 'check', relation: 'verifies', artifact: 'src/' },
      { from: 'check', to: 'report', relation: 'feeds', artifact: 'verdict' },
    ],
    deliverable: 'Shipped', acceptance: ['pnpm test passes', 'no new warnings'],
  })
  if (!parsed.ok) throw new Error('fixture plan must parse')
  return parsed.plan
}

function node(graph: GraphPlan, id: string) {
  const found = graph.nodes.find(entry => entry.id === graphNodeId(id))
  if (found === undefined) throw new Error(`no node ${id}`)
  return found
}

describe('nodePrompt', () => {
  it('briefs an execution node with its inputs, tools, and write scope only', () => {
    const graph = plan()
    expect(nodePrompt(graph, 2, node(graph, 'build'), [{ name: 'ticket', source: 'run input ticket', value: 'BUG-1' }], false)).toBe([
      'You are node "build" (execution) of graph plan "ship" version 2.',
      'Plan goal: Ship the fix',
      '',
      'Assignment:',
      'Fix the parser',
      '',
      'Inputs, already produced upstream; do not look for more:',
      '- ticket (from run input ticket): "BUG-1"',
      'Tools: use only read, edit.',
      'Writes: modify only paths under src.',
      '',
      'Finish by calling the structured output tool with the declared fields.',
    ].join('\n'))
  })

  it('briefs a verification node with artifacts, acceptance, and the verdict rule', () => {
    const graph = plan()
    const text = nodePrompt(graph, 1, node(graph, 'check'), [], false)
    expect(text).toContain('Inputs: none.')
    expect(text).toContain('Writes: do not modify any file.')
    expect(text).toContain('Artifacts to check yourself, as they are now: src/ (from build).')
    expect(text).toContain('Acceptance criteria:\n- pnpm test passes\n- no new warnings')
    expect(text).toContain('Set verdict to "pass" only when every criterion holds for these artifacts; otherwise set it to "fail".')
  })

  it('names missing inputs, no tools, no declared artifacts, and an interrupted attempt', () => {
    const graph = plan()
    const report = nodePrompt(graph, 1, node(graph, 'report'), [{ name: 'verdict', source: 'check field verdict', value: undefined }], true)
    expect(report).toContain('- verdict (from check field verdict): not provided')
    expect(report).toContain('Tools: none; work from the inputs.')
    expect(report).toContain(INTERRUPTED_NOTE)
    const lone = { ...node(graph, 'check'), id: graphNodeId('lone') }
    expect(nodePrompt(graph, 1, lone, [], false)).toContain('Artifacts to check yourself, as they are now: none declared.')
  })
})
