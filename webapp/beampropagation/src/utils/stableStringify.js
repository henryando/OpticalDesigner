// A JSON.stringify that sorts object keys at every level, so two
// deeply-equal objects always serialize identically regardless of property
// insertion order. This matters for cloud sync-status fingerprints: a
// freshly captured project state has whatever key order its literal was
// written in, but the same content fetched back from Postgres's `jsonb`
// column is not guaranteed to preserve that order — plain JSON.stringify
// would then see the two as "different" even with zero real edits.
export function stableStringify(value) {
  if (value === undefined) return undefined
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(v => stableStringify(v) ?? 'null').join(',')}]`
  const keys = Object.keys(value).filter(k => value[k] !== undefined).sort()
  return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`
}
