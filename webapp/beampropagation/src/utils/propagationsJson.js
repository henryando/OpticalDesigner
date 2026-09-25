// propagations.json — an array of plain propagation objects (one per
// beam-propagation sandbox). Optics, test points, source path and fit
// measurements are already plain JSON values in memory, so — unlike the CSV
// format this replaced — there's no column-flattening step: this is just the
// file shape (see propagationModel.js) written straight to disk.
//
// `id` is left out: it's this browser's own bookkeeping key, not part of the
// propagation's content, and a fresh one is always minted on load anyway (see
// parsePropagationsJson) so re-uploading the same file, or a file whose ids
// happen to collide with ones already in this browser, adds propagations
// rather than silently overwriting them.

import { toFileShape, normalizePropagation } from './propagationModel'

export function serializePropagationsJson(propagations) {
  const list = Object.values(propagations ?? {}).map(p => {
    const { id, ...rest } = toFileShape(p)
    return rest
  })
  return JSON.stringify(list, null, 2)
}

export function parsePropagationsJson(text) {
  const list = JSON.parse(text)
  if (!Array.isArray(list)) throw new Error('expected an array of propagations')
  const out = {}
  for (const p of list) {
    const id = crypto.randomUUID()
    out[id] = normalizePropagation({ ...p, id })
  }
  return out
}
