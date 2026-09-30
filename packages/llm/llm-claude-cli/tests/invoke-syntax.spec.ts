/**
 * Claude's native XML function-call syntax, read out of reply text. Model output is untrusted, so
 * every way the text can fall short of one complete element naming a declared tool is exercised.
 */
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { readInvokeSyntax } from '../src/invoke-syntax.ts'

const EDIT: ToolSchema = {
  name: 'edit',
  description: 'Replace text in a file.',
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string' },
      new_string: { type: 'string' },
      replace_all: { type: 'boolean' },
      line: { type: 'integer' },
      ratio: { type: 'number' },
      ranges: { type: 'array' },
      options: { type: 'object' },
      mode: { enum: ['fast', 'safe'] },
      untyped: true,
    },
  },
}

/** A tool whose schema declares no properties at all. */
const PING: ToolSchema = { name: 'ping', description: 'Check liveness.', parameters: { type: 'object' } }

const TOOLS: ReadonlyMap<string, ToolSchema> = new Map([[EDIT.name, EDIT], [PING.name, PING]])

/** The vendor's namespace prefix, written on some replies. */
const NS = 'antml:'

/** Read text against the two test tools. */
function read(text: string) {
  return readInvokeSyntax(text, TOOLS)
}

describe('readInvokeSyntax', () => {
  it('reads one complete element into the JSON call a block would have held', () => {
    const text = '<invoke name="edit"> <parameter name="file_path">/a.md</parameter> </invoke>'
    expect(read(`${text} and more`)).toEqual({
      kind: 'complete',
      name: 'edit',
      length: text.length,
      call: '{"name":"edit","arguments":{"file_path":"/a.md"}}',
    })
  })

  it('keeps a string parameter verbatim, including newlines, backticks, pipes, and angle brackets', () => {
    const body = '| `a` | b < c |\n\n  <parameter>not one</parameter> </invoke is not the end\n'
    const reading = read(`<invoke name="edit">\n<parameter name="new_string">${body}</parameter>\n</invoke>`)
    expect(reading.kind === 'complete' && JSON.parse(reading.call ?? '{}')).toEqual({
      name: 'edit',
      arguments: { new_string: body },
    })
  })

  it('parses a parameter the tool declares as a number, integer, boolean, array, or object', () => {
    const reading = read(
      '<invoke name="edit"><parameter name="replace_all">true</parameter><parameter name="line">30</parameter>'
      + '<parameter name="ratio"> 0.5 </parameter><parameter name="ranges">[1, 2]</parameter>'
      + '<parameter name="options">{"dry": true}</parameter></invoke>',
    )
    expect(reading.kind === 'complete' && JSON.parse(reading.call ?? '{}')).toEqual({
      name: 'edit',
      arguments: { replace_all: true, line: 30, ratio: 0.5, ranges: [1, 2], options: { dry: true } },
    })
  })

  it('reads an element with no parameters as a call with empty arguments', () => {
    expect(read('<invoke name="ping"></invoke>')).toEqual({
      kind: 'complete',
      name: 'ping',
      length: 29,
      call: '{"name":"ping","arguments":{}}',
    })
  })

  it('reads the namespaced spelling, and counts a function_calls tag before the element', () => {
    const text = `<${NS}function_calls>\n<${NS}invoke name="edit">\n<${NS}parameter name="line">7</${NS}parameter>\n</${NS}invoke>`
    expect(text).toContain(NS)
    expect(read(`${text}\n</${NS}function_calls>`)).toEqual({
      kind: 'complete',
      name: 'edit',
      length: text.length,
      call: '{"name":"edit","arguments":{"line":7}}',
    })
  })

  it.each([
    ['a body that is not JSON for a declared number', '<parameter name="line">thirty</parameter>'],
    ['a parameter the tool does not declare', '<parameter name="elsewhere">x</parameter>'],
    ['a parameter whose schema declares no type', '<parameter name="mode">fast</parameter>'],
    ['a parameter whose schema is not an object', '<parameter name="untyped">x</parameter>'],
    ['a parameter written twice', '<parameter name="line">1</parameter><parameter name="line">2</parameter>'],
  ])('reports a complete element without a call for %s', (_label, parameters) => {
    expect(read(`<invoke name="edit">${parameters}</invoke>`)).toMatchObject({ kind: 'complete', name: 'edit', call: undefined })
  })

  it('reports no call for a parameter on a tool that declares no properties', () => {
    expect(read('<invoke name="ping"><parameter name="x">1</parameter></invoke>'))
      .toMatchObject({ kind: 'complete', name: 'ping', call: undefined })
  })

  it.each([
    ['a lone angle bracket', '<'],
    ['the start of the element name', '<inv'],
    ['the start of the wrapper name', '<function_c'],
    ['an opening tag with no closing bracket yet', '<invoke name="edit"'],
    ['a wrapper tag with no closing bracket yet', '<function_calls'],
    ['a wrapper with nothing under it yet', '<function_calls>\n'],
    ['a wrapper with the start of an element under it', '<function_calls>\n<inv'],
  ])('waits on %s without naming a tool', (_label, text) => {
    expect(read(text)).toEqual({ kind: 'partial', name: undefined })
  })

  it.each([
    ['an element with no parameter yet', '<invoke name="edit">'],
    ['a parameter whose opening tag is still arriving', '<invoke name="edit"> <parameter name="li'],
    ['a parameter whose body is still arriving', '<invoke name="edit"> <parameter name="line">3'],
    ['a parameter closed with nothing after it yet', '<invoke name="edit"> <parameter name="line">3</parameter> '],
    ['text where a parameter should be', '<invoke name="edit"> stray text </invoke>'],
  ])('waits on %s, naming the declared tool', (_label, text) => {
    expect(read(text)).toEqual({ kind: 'partial', name: 'edit' })
  })

  it.each([
    ['another tag', '<div class="a">'],
    ['a comparison', '< 3'],
    ['a longer tag name', '<invoker name="edit">'],
    ['an element with no name attribute', '<invoke>'],
    ['an element naming an undeclared tool', '<invoke name="widget"> <parameter name="a">1</parameter> </invoke>'],
    ['a wrapper followed by prose', '<function_calls> is the wrapper.'],
    ['a longer wrapper name', '<function_callsX>'],
  ])('reads %s as ordinary text', (_label, text) => {
    expect(read(text)).toEqual({ kind: 'text' })
  })
})
