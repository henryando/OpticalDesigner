// Parsers for the designer files needed to import beam paths (elements.csv,
// beam_paths.csv). Kept in sync with webapp/frontend/src/utils/csvUtils.js.

function parseCSVLine(line) {
  const fields = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { field += '"'; i++ }
      else { inQuotes = !inQuotes }
    } else if (ch === ',' && !inQuotes) {
      fields.push(field); field = ''
    } else {
      field += ch
    }
  }
  fields.push(field)
  return fields
}

// ── Elements ──────────────────────────────────────────────────────────────────

const ELEM_COL_ALIASES = {
  'label': 'label', 'o-number': 'label', 'o number': 'label',
  'type': 'type',
  'position x': 'x', 'pos x': 'x', 'x': 'x',
  'position y': 'y', 'pos y': 'y', 'y': 'y',
  'orientation': 'orientation', 'orient': 'orientation', 'angle': 'orientation',
  'in design': 'in_design',
}
const REQUIRED = ['label', 'type', 'x', 'y']

export function parseElementsCsv(text) {
  const allLines = text.split(/\r?\n/)

  let config = null
  const cfgLine = allLines.find(l => l.trimStart().startsWith('# config:'))
  if (cfgLine) {
    config = {}
    cfgLine.replace(/^.*# config:/, '').split(',').forEach(pair => {
      const [k, v] = pair.trim().split('=')
      if (k && v) config[k.trim()] = parseFloat(v.trim())
    })
  }

  const dataLines = allLines.filter(l => !l.trimStart().startsWith('#') && l.trim())
  if (dataLines.length === 0) return { elements: [], config, error: 'Empty file' }

  const headers = parseCSVLine(dataLines[0]).map(h => h.trim())
  const colIdx = {}
  const extraCols = []
  headers.forEach((h, i) => {
    const canonical = ELEM_COL_ALIASES[h.toLowerCase()]
    if (canonical && !(canonical in colIdx)) colIdx[canonical] = i
    else if (h) extraCols.push({ name: h, index: i })
  })

  const missing = REQUIRED.filter(k => !(k in colIdx))
  if (missing.length) return { elements: [], config, error: `Missing columns: ${missing.join(', ')}` }

  let elements = []
  for (let i = 1; i < dataLines.length; i++) {
    const row = parseCSVLine(dataLines[i])
    const label = (row[colIdx.label] ?? '').trim()
    if (!label) continue
    const xStr = (row[colIdx.x] ?? '').trim()
    const yStr = (row[colIdx.y] ?? '').trim()
    if (!xStr || !yStr) continue
    const x = parseFloat(xStr), y = parseFloat(yStr)
    if (isNaN(x) || isNaN(y)) continue
    const orientRaw = colIdx.orientation != null ? (row[colIdx.orientation] ?? '').trim() : ''
    const orientation = orientRaw ? (parseFloat(orientRaw) || 0) : 0
    const rawLabel = label.replace(/\.0$/, '')
    const normalizedLabel = /^\d+(\.\d+)?$/.test(rawLabel) ? `O-${rawLabel}` : rawLabel
    const type = (row[colIdx.type] ?? '').trim()
    // Parse in_design: "Breadboard" (legacy Setup Location) or "TRUE" → true, everything else → false
    let in_design = true
    if (colIdx.in_design != null) {
      const raw = (row[colIdx.in_design] ?? '').trim().toLowerCase()
      in_design = raw === 'true' || raw === 'breadboard'
    }
    const meta = {}
    extraCols.forEach(({ name, index }) => {
      meta[name] = (row[index] ?? '').trim()
    })
    elements.push({ label: normalizedLabel, type, x, y, orientation, in_design, ...meta })
  }

  if (!config && elements.length > 0) {
    const xs = elements.map(e => e.x), ys = elements.map(e => e.y)
    const pad = 4
    config = {
      table_length: Math.ceil(Math.max(...xs) - Math.min(...xs) + 2 * pad),
      table_width:  Math.ceil(Math.max(...ys) - Math.min(...ys) + 2 * pad),
    }
    // Center origin so that min coordinate = 0
    const x0 = Math.min(...xs), y0 = Math.min(...ys)
    if (Math.abs(x0) > 0.01 || Math.abs(y0) > 0.01) {
      elements = elements.map(el => ({ ...el, x: el.x - x0, y: el.y - y0 }))
    }
  }

  return { elements, config }
}

// ── Beam paths ────────────────────────────────────────────────────────────────
//
// CSV format: Name,Color,Src,Dest — one row per edge, sorted by name.
//   Name,Color,Src,Dest
//   Cs MOT,#e06c75,O-17,O-98
//   Li H Imaging,#61afef,O-527,O-502
//
// Legacy column-pair format is still accepted on load.

export function parseBeamPathsCsv(text) {
  const allLines = text.split(/\r?\n/).filter(l => l.trim())
  const dataLines = allLines.filter(l => !l.trimStart().startsWith('#'))
  if (!dataLines.length) return { beamPaths: {} }

  const headers = parseCSVLine(dataLines[0]).map(h => h.trim())
  const headersLow = headers.map(h => h.toLowerCase())

  // New row-based format: Name, Color, Src, Dest
  if (headersLow.includes('name') && headersLow.includes('src') && headersLow.includes('dest')) {
    const ni = headersLow.indexOf('name')
    const ci = headersLow.indexOf('color')
    const si = headersLow.indexOf('src')
    const di = headersLow.indexOf('dest')
    const beamPaths = {}
    for (let i = 1; i < dataLines.length; i++) {
      const row = parseCSVLine(dataLines[i])
      const name = (row[ni] ?? '').trim()
      if (!name) continue
      const src  = (row[si] ?? '').trim()
      const dest = (row[di] ?? '').trim()
      if (!src || !dest) continue
      if (!beamPaths[name]) {
        beamPaths[name] = { color: ci >= 0 ? (row[ci] ?? '').trim() || 'gray' : 'gray', edges: [] }
      }
      beamPaths[name].edges.push([src, dest])
    }
    return { beamPaths }
  }

  // Legacy column-pair format: optional "# colors:" comment, alternating src/dest columns
  const colorMap = {}
  const colorLine = allLines.find(l => l.trimStart().startsWith('# colors:'))
  if (colorLine) {
    colorLine.replace(/^.*# colors:/, '').split(',').forEach(pair => {
      const eq = pair.indexOf('=')
      if (eq > 0) {
        const name = pair.slice(0, eq).trim()
        const color = pair.slice(eq + 1).trim()
        if (name && color) colorMap[name] = color
      }
    })
  }
  const pathNames = []
  const srcIdx = {}, destIdx = {}
  headers.forEach((h, i) => {
    if (h.endsWith(' src'))  { const n = h.slice(0, -4).trim(); srcIdx[n]  = i; if (!pathNames.includes(n)) pathNames.push(n) }
    if (h.endsWith(' dest')) { const n = h.slice(0, -5).trim(); destIdx[n] = i; if (!pathNames.includes(n)) pathNames.push(n) }
  })
  const beamPaths = {}
  pathNames.forEach(name => {
    const si = srcIdx[name], di = destIdx[name]
    if (si == null || di == null) return
    const edges = []
    for (let i = 1; i < dataLines.length; i++) {
      const row = parseCSVLine(dataLines[i])
      const src  = (row[si] ?? '').trim()
      const dest = (row[di] ?? '').trim()
      if (src && dest) edges.push([src, dest])
    }
    beamPaths[name] = { color: colorMap[name] ?? 'gray', edges }
  })
  return { beamPaths }
}

