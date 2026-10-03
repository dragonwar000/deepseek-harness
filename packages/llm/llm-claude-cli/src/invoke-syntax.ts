/**
 * Reads Claude's native XML function-call syntax out of reply text.
 *
 * A model served through the CLI sometimes writes the syntax it uses when a provider accepts a
 * `tools` field — an `<invoke name="…">` element holding `<parameter name="…">` elements, sometimes
 * inside `<function_calls>` — instead of the `dsh-tool-call` block the preamble asks for. This
 * module recognizes that text and turns a complete element into the JSON such a block would have
 * held. Whether the call is then accepted or rejected is the scanner's decision, not this module's.
 *
 * A parameter body is raw text, not JSON: it is kept verbatim for a parameter the tool declares as
 * a string, and parsed as JSON for one it declares as a number, integer, boolean, object, or array.
 * A parameter the tool does not declare a single such type for cannot be converted without a guess,
 * so the element is then reported without a call.
 */

import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import { isRecord } from './json.ts'

/** The vendor's namespace prefix, which the model writes on some replies and omits on others. */
const NAMESPACE = 'antml:'

/** How the element and its wrapper can start, without and with the namespace prefix. */
const INVOKE_TAGS = ['<invoke', `<${NAMESPACE}invoke`] as const
const WRAPPER_TAGS = ['<function_calls', `<${NAMESPACE}function_calls`] as const

const WRAPPER_OPEN = /^<(?:antml:)?function_calls\s*>\s*/u
const INVOKE_OPEN = /^<(?:antml:)?invoke\s+name="[^"]*"\s*>/u
const INVOKE_CLOSE = /^\s*<\/(?:antml:)?invoke>/u
const PARAMETER_OPEN = /^\s*<(?:antml:)?parameter\s+name="[^"]*"\s*>/u
/**
 * The closing tag that ends a parameter body: the first one followed by another parameter or by the
 * end of the element, so a body that itself contains a closing tag is not cut short at it.
 */
const PARAMETER_CLOSE = /<\/(?:antml:)?parameter>(?=\s*<(?:(?:antml:)?parameter\s|\/(?:antml:)?invoke>))/u

/** Declared parameter types whose body is JSON rather than verbatim text. */
const JSON_TYPES: ReadonlySet<unknown> = new Set(['number', 'integer', 'boolean', 'object', 'array'])

/** What the text at one `<` turned out to be. */
export type InvokeReading =
  /** Not an XML call to a declared tool: ordinary text. */
  | { readonly kind: 'text' }
  /**
   * May still become a call as more of the reply arrives. `name` is the declared tool it calls,
   * once its opening tag is complete.
   */
  | { readonly kind: 'partial'; readonly name: string | undefined }
  /**
   * One complete element calling a declared tool, spanning `length` characters including a
   * `<function_calls>` opening tag directly before it. `call` is the JSON object a `dsh-tool-call`
   * block would have held, or `undefined` when a parameter could not be converted without a guess.
   */
  | { readonly kind: 'complete'; readonly name: string; readonly length: number; readonly call: string | undefined }

const TEXT: InvokeReading = { kind: 'text' }
const UNNAMED: InvokeReading = { kind: 'partial', name: undefined }

/** Whether `text` starts with one of `tags`, or is so far only the beginning of one. */
function opens(text: string, tags: readonly string[]): boolean {
  return tags.some(tag => text.startsWith(tag) || tag.startsWith(text))
}

/** The value of the one quoted attribute in an opening tag. */
function attribute(tag: string): string {
  return tag.slice(tag.indexOf('"') + 1, tag.lastIndexOf('"'))
}

/**
 * Convert one parameter body to the value the tool declares for it.
 * @returns the value, or `undefined` when the declared type is missing or the body is not that type.
 */
function convert(type: unknown, body: string): unknown {
  if (type === 'string') return body
  if (!JSON_TYPES.has(type)) return undefined
  try {
    return JSON.parse(body)
  }
  catch {
    // The tool declares a JSON type and the model wrote something else; nothing is guessed from it.
    return undefined
  }
}

/** Build the JSON call from the parameters of one element, or `undefined` when one cannot be converted. */
function toCall(tool: ToolSchema, parameters: readonly (readonly [string, string])[]): string | undefined {
  const properties = tool.parameters['properties']
  const values = new Map<string, unknown>()
  for (const [name, body] of parameters) {
    const schema = isRecord(properties) ? properties[name] : undefined
    const value = values.has(name) || !isRecord(schema) ? undefined : convert(schema['type'], body)
    if (value === undefined) return undefined
    values.set(name, value)
  }
  return JSON.stringify({ name: tool.name, arguments: Object.fromEntries(values) })
}

/** Read text that may be one `<invoke>` element. */
function readInvoke(text: string, tools: ReadonlyMap<string, ToolSchema>): InvokeReading {
  if (!opens(text, INVOKE_TAGS)) return TEXT
  const open = INVOKE_OPEN.exec(text)?.[0]
  // Without a `>` the opening tag is still arriving; with one, it is some other tag.
  if (open === undefined) return text.includes('>') ? TEXT : UNNAMED
  const tool = tools.get(attribute(open))
  if (tool === undefined) return TEXT
  const parameters: (readonly [string, string])[] = []
  for (let at = open.length; ;) {
    const rest = text.slice(at)
    const end = INVOKE_CLOSE.exec(rest)?.[0]
    if (end !== undefined) {
      return { kind: 'complete', name: tool.name, length: at + end.length, call: toCall(tool, parameters) }
    }
    const header = PARAMETER_OPEN.exec(rest)?.[0]
    const close = header === undefined ? null : PARAMETER_CLOSE.exec(rest.slice(header.length))
    if (header === undefined || close === null) return { kind: 'partial', name: tool.name }
    parameters.push([attribute(header), rest.slice(header.length, header.length + close.index)])
    at += header.length + close.index + close[0].length
  }
}

/**
 * Read text that starts with `<` as XML function-call syntax.
 * @param text - the unreleased reply text from one `<` onward.
 * @param tools - the tools the request declared, by name.
 * @returns what the text is; only an element naming a declared tool is ever a call.
 */
export function readInvokeSyntax(text: string, tools: ReadonlyMap<string, ToolSchema>): InvokeReading {
  const wrapper = WRAPPER_OPEN.exec(text)?.[0]
  if (wrapper === undefined) {
    return opens(text, WRAPPER_TAGS) && !text.includes('>') ? UNNAMED : readInvoke(text, tools)
  }
  const inner = readInvoke(text.slice(wrapper.length), tools)
  return inner.kind === 'complete' ? { ...inner, length: wrapper.length + inner.length } : inner
}
