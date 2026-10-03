/**
 * Renders a tool's `parameters` JSON Schema as the compact type notation the emulation preamble
 * lists, which is shorter than the schema's own JSON; the package README records the measurement.
 *
 * The notation covers the schema keywords the Harness's tools use: `type`, `properties`,
 * `required`, `items`, `enum`, and a one-line `description` on a property. It states exactly what
 * those keywords state and nothing else, so a schema that uses any other keyword, or any of these
 * in a way the notation cannot state, is not rendered here at all and the caller lists its JSON
 * Schema verbatim instead. Nothing is approximated.
 */

import { isRecord } from './json.ts'

/** Scalar JSON Schema types, written in the notation by their own name. */
const SCALAR_TYPES: ReadonlySet<unknown> = new Set(['string', 'number', 'integer', 'boolean', 'null'])

/** A property name the notation writes bare; any other is written as a JSON string. */
const BARE_NAME = /^[A-Za-z_$][\w$]*$/u

/** Whether a schema node carries no keyword besides `description` and the ones named. */
function hasOnly(node: Record<string, unknown>, keywords: readonly string[]): boolean {
  return Object.keys(node).every(keyword => keyword === 'description' || keywords.includes(keyword))
}

/** Render an `enum` node as a union of its literal values. */
function renderEnum(node: Record<string, unknown>): string | undefined {
  const values = node['enum']
  if (!hasOnly(node, ['type', 'enum']) || !Array.isArray(values) || values.length === 0) return undefined
  const literal = values.every(value => value === null || ['string', 'number', 'boolean'].includes(typeof value))
  return literal ? values.map(value => JSON.stringify(value)).join(' | ') : undefined
}

/** Render an `array` node as its item type followed by `[]`. */
function renderArray(node: Record<string, unknown>, indent: string): string | undefined {
  const items = node['items']
  // An item description has no member line to sit on, so a schema carrying one is not rendered.
  if (!hasOnly(node, ['type', 'items']) || !isRecord(items) || 'description' in items) return undefined
  const item = renderNode(items, indent)
  if (item === undefined) return undefined
  return 'enum' in items ? `(${item})[]` : `${item}[]`
}

/** Render one property as a member line: its name, `?` when optional, its type, its description. */
function renderMember(name: string, schema: unknown, required: boolean, indent: string): string | undefined {
  if (!isRecord(schema)) return undefined
  const description = schema['description'] ?? ''
  if (typeof description !== 'string' || description.includes('\n')) return undefined
  const type = renderNode(schema, indent)
  if (type === undefined) return undefined
  const written = BARE_NAME.test(name) ? name : JSON.stringify(name)
  return `${indent}${written}${required ? '' : '?'}: ${type}${description.length === 0 ? '' : ` // ${description}`}`
}

/** Render an `object` node as its member lines between braces. */
function renderObject(node: Record<string, unknown>, indent: string): string | undefined {
  const properties = node['properties'] ?? {}
  const required = node['required'] ?? []
  // `additionalProperties: true` states the JSON Schema default, so leaving it out states the same.
  // `false` closes the object, which the notation cannot state.
  const open = node['additionalProperties'] ?? true
  if (
    !hasOnly(node, ['type', 'properties', 'required', 'additionalProperties'])
    || !isRecord(properties)
    || !Array.isArray(required)
    || !required.every(name => typeof name === 'string' && Object.hasOwn(properties, name))
    || open !== true
  ) {
    return undefined
  }
  const members = Object.entries(properties)
    .map(([name, schema]) => renderMember(name, schema, required.includes(name), `${indent}  `))
  if (members.includes(undefined)) return undefined
  return members.length === 0 ? '{}' : `{\n${members.join('\n')}\n${indent}}`
}

/** Render one schema node, ignoring its own `description`, which belongs to the member line above it. */
function renderNode(node: Record<string, unknown>, indent: string): string | undefined {
  if ('enum' in node) return renderEnum(node)
  const type = node['type']
  if (type === 'object') return renderObject(node, indent)
  if (type === 'array') return renderArray(node, indent)
  return SCALAR_TYPES.has(type) && hasOnly(node, ['type']) ? String(type) : undefined
}

/**
 * Render a tool's `parameters` schema as the type of its `arguments` object.
 * @param parameters - the tool's JSON Schema for its arguments.
 * @returns the type text, or `undefined` when the schema says something this notation cannot state,
 *   in which case the caller must list the schema itself.
 */
export function renderArgumentsType(parameters: Record<string, unknown>): string | undefined {
  // A description of the arguments object as a whole has no member line to sit on either.
  return parameters['type'] === 'object' && !('description' in parameters)
    ? renderObject(parameters, '')
    : undefined
}
