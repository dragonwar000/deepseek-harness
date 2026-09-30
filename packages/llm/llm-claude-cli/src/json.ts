/** JSON value helpers shared by the modules that read untrusted model text and tool schemas. */

/**
 * Tell a decoded JSON object from every other decoded JSON value.
 * @param value - a value `JSON.parse` returned, or a member of one.
 * @returns whether it is an object with readable members, which excludes `null` and arrays.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
