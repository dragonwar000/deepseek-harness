/**
 * The compact type notation the emulation preamble lists a tool's arguments in. It is model-visible
 * text, so its rendering is pinned, and every schema it cannot state exactly must be refused rather
 * than approximated.
 */
import { describe, expect, it } from 'vitest'
import { renderArgumentsType } from '../src/arguments-type.ts'

describe('renderArgumentsType', () => {
  it('renders members, optional marks, descriptions, enums, arrays, and nested objects', () => {
    expect(renderArgumentsType({
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command to run.' },
        timeoutMs: { type: 'number' },
        retries: { type: 'integer', description: '' },
        background: { type: 'boolean', description: 'Run detached.' },
        mode: { type: 'string', enum: ['read', 'write'], description: 'Access wanted.' },
        levels: { type: 'array', items: { enum: [1, 2, null, true] } },
        tags: { type: 'array', items: { type: 'string' }, description: 'Labels.' },
        'x-trace': { type: 'null' },
        options: {
          type: 'array',
          description: 'Choices.',
          items: {
            type: 'object',
            additionalProperties: true,
            properties: {
              label: { type: 'string', description: 'Shown to the user.' },
              meta: { type: 'object' },
            },
            required: ['label'],
          },
        },
      },
      required: ['command', 'mode'],
    })).toBe([
      '{',
      '  command: string // The command to run.',
      '  timeoutMs?: number',
      '  retries?: integer',
      '  background?: boolean // Run detached.',
      '  mode: "read" | "write" // Access wanted.',
      '  levels?: (1 | 2 | null | true)[]',
      '  tags?: string[] // Labels.',
      '  "x-trace"?: null',
      '  options?: {',
      '    label: string // Shown to the user.',
      '    meta?: {}',
      '  }[] // Choices.',
      '}',
    ].join('\n'))
  })

  it('renders a tool that takes no arguments as an empty object', () => {
    expect(renderArgumentsType({ type: 'object', properties: {} })).toBe('{}')
    expect(renderArgumentsType({ type: 'object' })).toBe('{}')
  })

  it.each([
    ['a schema that is not an object type', { type: 'string' }],
    ['a description of the arguments as a whole', { type: 'object', description: 'All of it.', properties: {} }],
    ['a closed object', { type: 'object', properties: {}, additionalProperties: false }],
    ['a schema-valued additionalProperties', { type: 'object', additionalProperties: { type: 'string' } }],
    ['an object keyword outside the notation', { type: 'object', properties: {}, minProperties: 1 }],
    ['properties that are not an object', { type: 'object', properties: [] }],
    ['a required list that is not an array', { type: 'object', properties: {}, required: 'a' }],
    ['a required name that is not a string', { type: 'object', properties: {}, required: [1] }],
    ['a required name with no property', { type: 'object', properties: {}, required: ['toString'] }],
    ['a property that is not a schema object', { type: 'object', properties: { a: true } }],
    ['a description that is not a string', { type: 'object', properties: { a: { type: 'string', description: 1 } } }],
    ['a description spanning lines', { type: 'object', properties: { a: { type: 'string', description: 'x\ny' } } }],
    ['a scalar keyword outside the notation', { type: 'object', properties: { a: { type: 'string', pattern: '^x' } } }],
    ['a type the notation does not know', { type: 'object', properties: { a: { type: ['string', 'null'] } } }],
    ['a property with no type', { type: 'object', properties: { a: {} } }],
    ['an array without items', { type: 'object', properties: { a: { type: 'array' } } }],
    ['an array keyword outside the notation', { type: 'object', properties: { a: { type: 'array', items: { type: 'string' }, minItems: 1 } } }],
    ['an item description', { type: 'object', properties: { a: { type: 'array', items: { type: 'string', description: 'One.' } } } }],
    ['items the notation cannot state', { type: 'object', properties: { a: { type: 'array', items: { type: 'string', format: 'uri' } } } }],
    ['an enum that is not a list', { type: 'object', properties: { a: { enum: 'x' } } }],
    ['an empty enum', { type: 'object', properties: { a: { enum: [] } } }],
    ['an enum of non-literals', { type: 'object', properties: { a: { enum: [{ x: 1 }] } } }],
    ['an enum keyword outside the notation', { type: 'object', properties: { a: { enum: ['x'], default: 'x' } } }],
    ['a nested object the notation cannot state', { type: 'object', properties: { a: { type: 'object', additionalProperties: false } } }],
  ])('refuses %s, so the schema is listed verbatim instead', (_label, schema) => {
    expect(renderArgumentsType(schema)).toBeUndefined()
  })
})
