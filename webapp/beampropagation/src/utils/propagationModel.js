// Shape of a propagation as used in memory by this app, and the conversion to
// and from the shape stored in propagations.csv / cloud projects.
//
// In memory, test points are optics with kind 'test' so the UI has a single
// table. The Optical Table Designer's copy of this mode keeps them in a
// separate `testPoints` array, so files and cloud rows written from here split
// them back out (toFileShape) — that way plots move freely between the two.

export const DEFAULT_W0_MM = 0.25

// Beam size can be shown as the 1/e² intensity radius or diameter. Everything
// is stored as a radius in mm; `scale` converts stored → displayed.
export const WIDTH_MODES = {
  radius:   { scale: 1, symbol: 'w', name: 'radius' },
  diameter: { scale: 2, symbol: 'D', name: 'diameter' },
}
export function widthModeInfo(mode) { return WIDTH_MODES[mode] ?? WIDTH_MODES.radius }

// Backward-compat: previous prototype stored w0 in µm as w0x_um / w0y_um.
// Convert on read so old localStorage / project files still load. Also folds
// the designer's separate testPoints array into optics.
export function normalizePropagation(p) {
  if (!p) return p
  const out = { ...p }
  if (out.w0x_mm == null && out.w0x_um != null) out.w0x_mm = out.w0x_um / 1000
  if (out.w0y_mm == null && out.w0y_um != null) out.w0y_mm = out.w0y_um / 1000
  delete out.w0x_um; delete out.w0y_um
  if (out.w0x_mm == null) out.w0x_mm = DEFAULT_W0_MM
  if (out.w0y_mm == null) out.w0y_mm = out.w0x_mm
  if (out.splitXY == null) out.splitXY = false
  if (out.combinedXY == null) out.combinedXY = true
  if (out.hidePassthroughOnPlot == null) out.hidePassthroughOnPlot = false
  if (out.hidePassthroughInTable == null) out.hidePassthroughInTable = false
  if (out.plotWidth == null)  out.plotWidth = 720
  if (out.plotHeight == null) out.plotHeight = 240
  if (out.initMode == null)   out.initMode = 'beam'
  if (out.wxWaist_mm == null) out.wxWaist_mm = out.w0x_mm
  if (out.zxWaist_mm == null) out.zxWaist_mm = 0
  if (out.wyWaist_mm == null) out.wyWaist_mm = out.w0y_mm
  if (out.zyWaist_mm == null) out.zyWaist_mm = 0
  if (out.waistMeasurements === undefined) out.waistMeasurements = null
  if (!WIDTH_MODES[out.widthMode]) out.widthMode = 'radius'
  const legacyTestPoints = (out.testPoints ?? []).map((tp, i) => ({
    ...tp, id: tp.id ?? `tp-${i}`, kind: 'test',
  }))
  out.optics = [...(out.optics ?? []), ...legacyTestPoints]
  delete out.testPoints
  return out
}

// In-memory propagation → the shape written to files and cloud rows.
export function toFileShape(p) {
  const n = normalizePropagation(p)
  const isTest = o => o.kind === 'test'
  return {
    ...n,
    optics: n.optics.filter(o => !isTest(o)),
    testPoints: n.optics.filter(isTest).map(o => ({
      id: o.id, z_mm: o.z_mm, label: o.label,
      ...(o.enabled === false ? { enabled: false } : {}),
    })),
  }
}

export function propagationsToFileShape(propagations) {
  const out = {}
  for (const [id, p] of Object.entries(propagations ?? {})) out[id] = toFileShape(p)
  return out
}

export function propagationsFromFileShape(propagations) {
  const out = {}
  for (const [id, p] of Object.entries(propagations ?? {})) out[id] = normalizePropagation(p)
  return out
}
