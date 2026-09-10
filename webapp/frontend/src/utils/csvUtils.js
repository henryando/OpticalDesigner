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

function csvEscape(val) {
  const s = String(val ?? '')
  return s.includes(',') || s.includes('"') || s.includes('\n')
    ? `"${s.replace(/"/g, '""')}"` : s
}

const CORE_KEYS = new Set(['label', 'type', 'x', 'y', 'orientation', 'id', '_softDeleted', 'in_design', 'labelPos'])

// elements: raw elements array; overrides: current overrides map; config: table config
export function serializeElementsCsv(elements, overrides, config) {
  if (!elements.length) return ''

  // Merge overrides into each element (include soft-deleted, exclude truly hard-deleted)
  const rows = elements.map(el => {
    const ov = overrides?.[el.label] ?? {}
    return { ...el, ...ov, _softDeleted: undefined }
  })

  // Collect all extra keys in order (preserve order from first element seen).
  // Annotation is a first-class default field: always include it, even if no
  // element has a value set, so the column round-trips through export/import.
  const extraKeys = []
  const seen = new Set()
  const forced = ['Annotation']
  forced.forEach(k => { seen.add(k); extraKeys.push(k) })
  rows.forEach(el => Object.keys(el).forEach(k => {
    if (!CORE_KEYS.has(k) && !seen.has(k)) { seen.add(k); extraKeys.push(k) }
  }))

  const lines = []
  if (config) {
    const cfgParts = Object.entries(config).map(([k, v]) => `${k}=${v}`)
    lines.push(`# config: ${cfgParts.join(',')}`)
  }
  lines.push(['Label', 'Type', 'Position x', 'Position y', 'Orientation', 'In Design', ...extraKeys].join(','))
  rows.forEach(el => {
    const inDesign = el.in_design === false ? 'FALSE' : 'TRUE'
    lines.push([el.label, el.type ?? '', el.x, el.y, el.orientation ?? 0, inDesign,
      ...extraKeys.map(k => csvEscape(el[k] ?? ''))].join(','))
  })
  return lines.join('\n')
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

export function serializeBeamPathsCsv(beamPaths) {
  const names = Object.keys(beamPaths).sort()
  if (!names.length) return ''
  const rows = ['Name,Color,Src,Dest']
  names.forEach(name => {
    const { color = 'gray', edges = [] } = beamPaths[name]
    edges.forEach(([src, dest]) => {
      rows.push([csvEscape(name), csvEscape(color), csvEscape(src), csvEscape(dest)].join(','))
    })
  })
  return rows.join('\n')
}

// ── Background objects ────────────────────────────────────────────────────────

export function parseBgObjectsCsv(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim() && !l.trimStart().startsWith('#'))
  if (!lines.length) return { bgGroups: {} }

  const headers = parseCSVLine(lines[0]).map(h => h.trim().toLowerCase())
  const gi  = headers.indexOf('group')
  const ci  = headers.indexOf('color')
  const si  = headers.indexOf('strokewidth')
  const x1i = headers.indexOf('x1')
  const y1i = headers.indexOf('y1')
  const x2i = headers.indexOf('x2')
  const y2i = headers.indexOf('y2')
  if (gi < 0 || x1i < 0 || y1i < 0 || x2i < 0 || y2i < 0)
    return { bgGroups: {}, error: 'Missing required columns (Group, x1, y1, x2, y2)' }

  const bgGroups = {}
  for (let i = 1; i < lines.length; i++) {
    const row  = parseCSVLine(lines[i])
    const name = (row[gi] ?? '').trim()
    if (!name) continue
    const x1 = parseFloat(row[x1i] ?? ''), y1 = parseFloat(row[y1i] ?? '')
    const x2 = parseFloat(row[x2i] ?? ''), y2 = parseFloat(row[y2i] ?? '')
    if (isNaN(x1) || isNaN(y1) || isNaN(x2) || isNaN(y2)) continue
    if (!bgGroups[name]) {
      bgGroups[name] = {
        color:       (row[ci] ?? '').trim() || '#888888',
        strokeWidth: parseFloat(row[si] ?? '') || 2,
        edges: [],
      }
    }
    bgGroups[name].edges.push([x1, y1, x2, y2])
  }
  return { bgGroups }
}

export function serializeBgObjectsCsv(bgGroups) {
  const rows = ['Group,Color,StrokeWidth,x1,y1,x2,y2']
  Object.entries(bgGroups).forEach(([name, { color, strokeWidth, edges }]) => {
    edges.forEach(([x1, y1, x2, y2]) => {
      rows.push([csvEscape(name), color, strokeWidth, x1, y1, x2, y2].join(','))
    })
  })
  return rows.join('\n')
}
