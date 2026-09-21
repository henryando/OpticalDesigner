// Elements the designer's canvas would show: overrides merged in, and anything
// marked not In Design, or on a hidden layer, left out.
export function visibleElements(elements, overrides, layers) {
  return (elements ?? [])
    .map(el => overrides?.[el.label] ? { ...el, ...overrides[el.label] } : el)
    .filter(el => el.in_design !== false && layers?.[el.Layer || 'Default'] !== false)
}
