/** Optional blank text is equivalent to omission; required and typed values retain validation. */
export function normalizePhoneActionArguments(
  schema: Record<string, unknown>,
  args: Record<string, unknown>,
  preserveBlankFields: readonly string[] = [],
): Record<string, unknown> {
  const properties = schema.properties as Record<string, { type?: unknown }> | undefined
  const required = new Set(Array.isArray(schema.required) ? schema.required : [])
  let normalized = args
  for (const [key, value] of Object.entries(args)) {
    if (properties?.[key]?.type !== 'string' || required.has(key) || preserveBlankFields.includes(key) || typeof value !== 'string' || value.trim()) continue
    if (normalized === args) normalized = { ...args }
    delete normalized[key]
  }
  return normalized
}
