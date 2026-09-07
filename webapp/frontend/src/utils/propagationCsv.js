// propagations.csv — one row per beam-propagation sandbox. Nested arrays
// (optics, test points, source path) are JSON-encoded into single columns so
// the file stays flat and human-readable.
//
// Columns:
//   Name, Split XY, Wavelength nm, Distance mm,
//   w0x um, div_x mrad, w0y um, div_y mrad,
//   Optics JSON, Test Points JSON, Source JSON

function csvEscape(v) {
  const s = String(v ?? '')
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
function csvUnescape(s) {
  if (s.startsWith('"') && s.endsWith('"')) {
    return s.slice(1, -1).replace(/""/g, '"')
  }
  return s
}
// Minimal CSV row parser that respects quoted fields.
function parseRow(line) {
  const out = []
  let cur = '', inQ = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (inQ) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++ }
      else if (c === '"') inQ = false
      else cur += c
    } else {
      if (c === ',') { out.push(cur); cur = '' }
      else if (c === '"' && !cur) inQ = true
      else cur += c
    }
  }
  out.push(cur)
  return out
}

// Waists are 1/e² intensity RADII in mm.
const HEADER = [
  'Name', 'Split XY', 'Wavelength nm', 'Distance mm',
  'w0x mm', 'div_x mrad', 'w0y mm', 'div_y mrad',
  'Optics JSON', 'Test Points JSON', 'Source JSON',
]

export function serializePropagationsCsv(propagations) {
  const rows = [HEADER.join(',')]
  for (const p of Object.values(propagations)) {
    const row = [
      p.name ?? '',
      p.splitXY ? 'TRUE' : 'FALSE',
      p.wavelength_nm ?? 1064,
      p.distance_mm ?? 500,
      p.w0x_mm ?? 0.25,
      p.divx_mrad ?? 0,
      p.w0y_mm ?? p.w0x_mm ?? 0.25,
      p.divy_mrad ?? p.divx_mrad ?? 0,
      JSON.stringify(p.optics ?? []),
      JSON.stringify(p.testPoints ?? []),
      JSON.stringify(p.source ?? null),
    ].map(csvEscape).join(',')
    rows.push(row)
  }
  return rows.join('\n')
}

export function parsePropagationsCsv(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim())
  if (!lines.length) return {}
  const [, ...body] = lines // drop header
  const out = {}
  for (const line of body) {
    const cells = parseRow(line).map(c => csvUnescape(c))
    const [name, split, lam, dist, w0x, divx, w0y, divy, opticsJSON, tpJSON, srcJSON] = cells
    if (!name) continue
    let optics = [], testPoints = [], source = null
    try { optics = JSON.parse(opticsJSON || '[]') } catch { optics = [] }
    try { testPoints = JSON.parse(tpJSON || '[]') } catch { testPoints = [] }
    try { source = JSON.parse(srcJSON || 'null') } catch { source = null }
    const id = crypto.randomUUID()
    out[id] = {
      id,
      name,
      splitXY: /^true$/i.test(split),
      wavelength_nm: parseFloat(lam) || 1064,
      distance_mm: parseFloat(dist) || 500,
      w0x_mm: parseFloat(w0x) || 0.25,
      divx_mrad: parseFloat(divx) || 0,
      w0y_mm: parseFloat(w0y) || 0.25,
      divy_mrad: parseFloat(divy) || 0,
      optics,
      testPoints,
      source,
    }
  }
  return out
}
