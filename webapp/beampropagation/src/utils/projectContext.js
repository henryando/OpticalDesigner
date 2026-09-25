// Elements the designer's canvas would show: overrides merged in, and anything
// marked not In Design, or on a hidden layer, left out.
export function visibleElements(elements, overrides, layers) {
  return (elements ?? [])
    .map(el => overrides?.[el.label] ? { ...el, ...overrides[el.label] } : el)
    .filter(el => el.in_design !== false && layers?.[el.Layer || 'Default'] !== false)
}

// Drop any beam-path edge that touches a label not present in the visible
// element set (soft-deleted / not In Design / on a hidden layer). Those
// elements aren't actually on the table, so the path picker shouldn't offer
// routes through them. A path left with no edges is dropped entirely.
export function beamPathsThroughVisibleElements(beamPaths, visibleEls) {
  const visible = new Set((visibleEls ?? []).map(el => el.label))
  const out = {}
  for (const [name, path] of Object.entries(beamPaths ?? {})) {
    const edges = (path.edges ?? []).filter(([a, b]) => visible.has(a) && visible.has(b))
    if (edges.length) out[name] = { ...path, edges }
  }
  return out
}
