/**
 * The brief a node's fresh subagent receives: its role, the plan goal, its
 * instruction, its resolved inputs, its tool and write limits, and for a
 * verification node the artifacts, acceptance criteria, and verdict rule.
 * Earlier failure traces are never included.
 * @module @deepseek-ai/dsh-experimental-graph-runner/prompt
 */

import type { GraphNode, GraphPlan } from '@deepseek-ai/dsh-experimental-graph-contract'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** One resolved input line. */
export interface PromptInput {
  /** Input name. */
  readonly name: string
  /** Where it came from, as shown to the node. */
  readonly source: string
  /** The value, or undefined when the source produced none. */
  readonly value: JsonValue | undefined
}

/** Added to the brief of the first attempt after an interrupted one. */
export const INTERRUPTED_NOTE = 'A previous attempt of this node stopped before it finished; inspect the workspace for partial changes before acting.'

/**
 * Build one node brief.
 * @param plan - the admitted plan.
 * @param version - its version.
 * @param node - the node to brief.
 * @param inputs - resolved inputs in binding order.
 * @param interrupted - whether the previous attempt was interrupted.
 * @returns the prompt text.
 */
export function nodePrompt(
  plan: GraphPlan,
  version: number,
  node: GraphNode,
  inputs: readonly PromptInput[],
  interrupted: boolean,
): string {
  const lines = [
    `You are node "${node.id}" (${node.kind}) of graph plan "${plan.id}" version ${version}.`,
    `Plan goal: ${plan.goal}`,
    '',
    'Assignment:',
    node.instruction.trim(),
    '',
  ]
  if (inputs.length === 0) lines.push('Inputs: none.')
  else {
    lines.push('Inputs, already produced upstream; do not look for more:')
    for (const input of inputs) {
      lines.push(`- ${input.name} (from ${input.source}): ${input.value === undefined ? 'not provided' : JSON.stringify(input.value)}`)
    }
  }
  lines.push(node.tools.length === 0 ? 'Tools: none; work from the inputs.' : `Tools: use only ${node.tools.join(', ')}.`)
  lines.push(node.writes.length === 0 ? 'Writes: do not modify any file.' : `Writes: modify only paths under ${node.writes.join(', ')}.`)
  if (node.kind === 'verification') {
    const artifacts = plan.edges
      .filter(edge => edge.to === node.id && edge.relation === 'verifies')
      .map(edge => `${edge.artifact} (from ${edge.from})`)
    lines.push(
      '',
      `Artifacts to check yourself, as they are now: ${artifacts.length === 0 ? 'none declared' : artifacts.join('; ')}.`,
      'Acceptance criteria:',
      ...plan.acceptance.map(criterion => `- ${criterion}`),
      'Set verdict to "pass" only when every criterion holds for these artifacts; otherwise set it to "fail".',
    )
  }
  if (interrupted) lines.push('', INTERRUPTED_NOTE)
  lines.push('', 'Finish by calling the structured output tool with the declared fields.')
  return lines.join('\n')
}
