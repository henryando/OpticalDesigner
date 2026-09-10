// Beam Propagation mode — a full-page sandbox for Gaussian beam propagation.
// PROTOTYPE — the physics is real (complex q-parameter, ABCD for thin lenses,
// separate x/y axes with cylindrical support), but the UI is intentionally
// minimal so the piece is easy to iterate on.

import { useMemo, useState, useRef, useEffect, useImperativeHandle, forwardRef } from 'react'
import {
  qFromBeam, sampleWofZ2D, radiusFromQ, propagateFreeSpace, propagateThinLens,
  nmToMm, mradToRad,
} from '../utils/gaussian'
import { serializePropagationsCsv } from '../utils/propagationCsv'
import ElementShape from './ElementShape'
import './BeamPropagationMode.css'

const INCH_MM = 25.4
const DEFAULT_LAMBDA_NM = 1064
const DEFAULT_W0_MM = 0.25

// A number input that keeps a local string while the user is editing so
// they can delete every character freely; only commits (via onCommit) on
// blur / Enter. An empty commit falls back to `fallback`.
function NumberField({ value, onCommit, step, min, max, style, fallback = 0 }) {
  const [local, setLocal] = useState(String(value ?? ''))
  const [focused, setFocused] = useState(false)
  const shown = focused ? local : String(value ?? '')
  function commit() {
    const raw = local.trim()
    if (raw === '') { onCommit(fallback); setLocal(String(fallback)); return }
    const n = parseFloat(raw)
    if (Number.isFinite(n)) { onCommit(n); setLocal(String(n)) }
    else                    { setLocal(String(value ?? '')) }
  }
  return (
    <input className="snap-input" type="number"
      style={style} step={step} min={min} max={max}
      value={shown}
      onChange={e => setLocal(e.target.value)}
      onFocus={() => { setLocal(String(value ?? '')); setFocused(true) }}
      onBlur={() => { setFocused(false); commit() }}
      onKeyDown={e => { if (e.key === 'Enter') e.target.blur() }} />
  )
}

// ── Default new propagation ────────────────────────────────────────────────
// Waists are stored as 1/e² intensity RADII in mm (standard Gaussian
// convention). optics kind: 'lens' (contributes ABCD) or 'passthrough'
// (identity — used for non-lens elements imported from a designer path).
function makeDefaultPropagation(name = 'New propagation') {
  return {
    id: crypto.randomUUID(),
    name,
    splitXY: false,
    combinedXY: true,        // when splitXY: overlay x + y on one plot vs stack two.
    hidePassthroughOnPlot: false,
    hidePassthroughInTable: false,
    plotWidth: 720,
    plotHeight: 240,
    wavelength_nm: DEFAULT_LAMBDA_NM,
    distance_mm: 500,
    w0x_mm: DEFAULT_W0_MM, divx_mrad: 0,
    w0y_mm: DEFAULT_W0_MM, divy_mrad: 0,
    optics: [],
    testPoints: [],
    source: null,
  }
}

// Backward-compat: previous prototype stored w0 in µm as w0x_um / w0y_um.
// Convert on read so old localStorage / project files still load.
function normalizePropagation(p) {
  if (!p) return p
  const out = { ...p }
  if (out.w0x_mm == null && out.w0x_um != null) out.w0x_mm = out.w0x_um / 1000
  if (out.w0y_mm == null && out.w0y_um != null) out.w0y_mm = out.w0y_um / 1000
  delete out.w0x_um; delete out.w0y_um
  if (out.w0x_mm == null) out.w0x_mm = DEFAULT_W0_MM
  if (out.w0y_mm == null) out.w0y_mm = out.w0x_mm
  if (out.combinedXY == null) out.combinedXY = true
  if (out.hidePassthroughOnPlot == null) out.hidePassthroughOnPlot = false
  if (out.hidePassthroughInTable == null) out.hidePassthroughInTable = false
  if (out.plotWidth == null)  out.plotWidth = 720
  if (out.plotHeight == null) out.plotHeight = 240
  return out
}

// ── Focal-length inference from a designer element ─────────────────────────
// Tries, in order:
//   1. The element's f_mm field (numeric).
//   2. A "Focal Length" custom column (string with optional units).
//   3. The Annotation field, parsed for "f=<num><unit>" or a bare "<num><unit>".
// Supported units: mm (default), cm, m, in. Returns NaN if nothing matched.
function inferFocalLengthMm(el) {
  if (!el) return NaN
  const num = Number(el.f_mm)
  if (Number.isFinite(num)) return num
  const candidates = [
    el['Focal Length'], el['focal length'], el['focal_length'], el.f,
    el.Annotation, el.annotation,
  ].filter(s => typeof s === 'string' && s.trim())
  for (const raw of candidates) {
    const parsed = parseLengthMm(raw)
    if (Number.isFinite(parsed)) return parsed
  }
  return NaN
}

function parseLengthMm(text) {
  // Prefer "f = 100 mm" pattern; fall back to any leading "<num><unit>".
  const m = /f\s*=\s*(-?\d+(?:\.\d+)?)\s*(mm|cm|m|in|")?/i.exec(text)
    || /(-?\d+(?:\.\d+)?)\s*(mm|cm|m|in|")\b/i.exec(text)
  if (!m) return NaN
  const n = parseFloat(m[1])
  if (!Number.isFinite(n)) return NaN
  const unit = (m[2] || 'mm').toLowerCase()
  if (unit === 'mm') return n
  if (unit === 'cm') return n * 10
  if (unit === 'm')  return n * 1000
  if (unit === 'in' || unit === '"') return n * 25.4
  return NaN
}

// ── Path finding on directed beam-path edges ───────────────────────────────
// Return every simple path from src → dst (no repeated nodes, capped at 50
// to keep it bounded).
function findAllSimplePaths(edges, src, dst) {
  const adj = new Map()
  for (const [a, b] of edges) {
    if (!adj.has(a)) adj.set(a, [])
    adj.get(a).push(b)
  }
  const paths = []
  const visited = new Set([src])
  const stack = [src]
  function dfs(node) {
    if (paths.length >= 50) return
    if (node === dst) { paths.push([...stack]); return }
    for (const nx of adj.get(node) ?? []) {
      if (visited.has(nx)) continue
      visited.add(nx); stack.push(nx)
      dfs(nx)
      stack.pop(); visited.delete(nx)
    }
  }
  dfs(src)
  return paths
}

// ── Import graph picker modal ──────────────────────────────────────────────
function ImportGraphModal({ beamPaths, elements, symbolDefs, onClose, onImport }) {
  const pathNames = Object.keys(beamPaths ?? {})
  const [pathName, setPathName] = useState(pathNames[0] ?? '')
  const path = beamPaths?.[pathName]
  const edges = path?.edges ?? []

  // Nodes on the path = union of endpoints, in first-encounter order.
  const nodes = useMemo(() => {
    const seen = new Set(), list = []
    for (const [a, b] of edges) {
      for (const n of [a, b]) if (!seen.has(n)) { seen.add(n); list.push(n) }
    }
    return list
  }, [edges])
  const elById = useMemo(() => {
    const m = {}; (elements ?? []).forEach(e => { m[e.label] = e }); return m
  }, [elements])

  const [srcLabel, setSrcLabel] = useState(null)
  const [dstLabel, setDstLabel] = useState(null)
  // If start/end give multiple paths, user picks one from candidatePaths.
  const [candidatePaths, setCandidatePaths] = useState(null)
  // Which candidate is being hovered — highlights that path on the graph.
  const [hoveredCandidate, setHoveredCandidate] = useState(null)
  // Per-user display toggles on the graph.
  const [showIcon, setShowIcon]           = useState(true)
  const [showLabel, setShowLabel]         = useState(true)
  const [showType, setShowType]           = useState(true)
  const [showAnnotation, setShowAnnotation] = useState(true)
  // Pan / zoom state for the graph. Applied via <g transform="…">.
  const [view, setView] = useState({ k: 1, tx: 0, ty: 0 })
  const panRef = useRef(null)   // { startX, startY, tx0, ty0 } while dragging

  // Fit-to-view for the graph.
  const positions = useMemo(() => {
    const pts = nodes.map(l => elById[l]).filter(Boolean)
    if (!pts.length) return { map: {}, view: { minX: 0, minY: 0, w: 1, h: 1 } }
    const xs = pts.map(p => p.x), ys = pts.map(p => p.y)
    const minX = Math.min(...xs), maxX = Math.max(...xs)
    const minY = Math.min(...ys), maxY = Math.max(...ys)
    const pad = Math.max(1, Math.max(maxX - minX, maxY - minY) * 0.1)
    const view = { minX: minX - pad, minY: minY - pad,
                   w: (maxX - minX) + 2 * pad, h: (maxY - minY) + 2 * pad }
    const map = {}
    for (const p of pts) map[p.label] = { x: p.x, y: p.y }
    return { map, view }
  }, [nodes, elById])

  const W = 520, H = 320
  const sx = x => ((x - positions.view.minX) / positions.view.w) * W
  // y grows down on canvas; nodes are laid out with physical y-up, so flip.
  const sy = y => H - ((y - positions.view.minY) / positions.view.h) * H

  function handleNodeClick(label) {
    if (candidatePaths) { setCandidatePaths(null) }
    if (!srcLabel) { setSrcLabel(label); return }
    if (!dstLabel && label !== srcLabel) {
      setDstLabel(label)
      const paths = findAllSimplePaths(edges, srcLabel, label)
      if (paths.length === 0) return           // no path — user resets by clicking again
      if (paths.length === 1) { finish(paths[0]); return }
      setCandidatePaths(paths)
      return
    }
    // Third click resets.
    setSrcLabel(label); setDstLabel(null); setCandidatePaths(null)
  }

  function finish(nodeSeq) {
    const distances_mm = []
    for (let i = 1; i < nodeSeq.length; i++) {
      const a = elById[nodeSeq[i - 1]], b = elById[nodeSeq[i]]
      if (!a || !b) return
      const dIn = Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2)
      distances_mm.push(dIn * INCH_MM)
    }
    onImport({ pathName, nodes: nodeSeq, distances_mm })
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-box modal-box-wide" onClick={e => e.stopPropagation()} style={{ maxWidth: 620 }}>
        <div className="modal-title">Import from beam path</div>

        <div style={{ display: 'flex', gap: 6, alignItems: 'center', margin: '4px 0' }}>
          <label>Path</label>
          <select className="snap-input" value={pathName}
            onChange={e => { setPathName(e.target.value); setSrcLabel(null); setDstLabel(null); setCandidatePaths(null) }}>
            {pathNames.map(n => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>

        {!edges.length ? (
          <p style={{ color: 'var(--text-muted)' }}>This path has no edges yet.</p>
        ) : (() => {
          // Set of edges (as "src dst") belonging to the hovered candidate,
          // so we can highlight them and their nodes on the graph.
          const highlightPath = hoveredCandidate != null && candidatePaths
            ? candidatePaths[hoveredCandidate] : null
          const highlightEdges = new Set()
          const highlightNodes = new Set()
          if (highlightPath) {
            for (let i = 1; i < highlightPath.length; i++) {
              highlightEdges.add(`${highlightPath[i - 1]} ${highlightPath[i]}`)
              highlightNodes.add(highlightPath[i - 1]); highlightNodes.add(highlightPath[i])
            }
          }
          return (
            <>
              {/* Display toggles + status line */}
              <div className="imp-toolbar">
                <span className="imp-legend" style={{ marginRight: 8 }}>
                  {srcLabel
                    ? (dstLabel
                        ? `Start: ${srcLabel} · End: ${dstLabel}`
                        : `Start: ${srcLabel} — click end node`)
                    : 'Click a node to set the start, then another to set the end.'}
                </span>
                <span style={{ flex: 1 }} />
                <label className="imp-toggle"><input type="checkbox" checked={showIcon}
                  onChange={e => setShowIcon(e.target.checked)} /> icon</label>
                <label className="imp-toggle"><input type="checkbox" checked={showLabel}
                  onChange={e => setShowLabel(e.target.checked)} /> label</label>
                <label className="imp-toggle"><input type="checkbox" checked={showType}
                  onChange={e => setShowType(e.target.checked)} /> type</label>
                <label className="imp-toggle"><input type="checkbox" checked={showAnnotation}
                  onChange={e => setShowAnnotation(e.target.checked)} /> annotation</label>
                <button className="small-btn" title="Reset zoom / pan"
                  onClick={() => setView({ k: 1, tx: 0, ty: 0 })}>Reset view</button>
              </div>
              <svg className="imp-graph" width={W} height={H}
                onWheel={e => {
                  e.preventDefault()
                  const svg = e.currentTarget
                  const rect = svg.getBoundingClientRect()
                  const mx = e.clientX - rect.left
                  const my = e.clientY - rect.top
                  const factor = Math.exp(-e.deltaY * 0.0015)
                  setView(v => {
                    const k2 = Math.min(8, Math.max(0.2, v.k * factor))
                    const s = k2 / v.k
                    return { k: k2, tx: mx - (mx - v.tx) * s, ty: my - (my - v.ty) * s }
                  })
                }}
                onMouseDown={e => {
                  // Drag on empty background to pan; skip if the click is on a node group.
                  if (e.target.closest('g[data-node]')) return
                  panRef.current = { startX: e.clientX, startY: e.clientY, tx0: view.tx, ty0: view.ty }
                }}
                onMouseMove={e => {
                  if (!panRef.current) return
                  const { startX, startY, tx0, ty0 } = panRef.current
                  setView(v => ({ ...v, tx: tx0 + (e.clientX - startX), ty: ty0 + (e.clientY - startY) }))
                }}
                onMouseUp={() => { panRef.current = null }}
                onMouseLeave={() => { panRef.current = null }}
              >
                <defs>
                  <marker id="imp-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                    <path d="M0,0 L10,5 L0,10 Z" fill="var(--text-muted)" />
                  </marker>
                  <marker id="imp-arrow-hi" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                    <path d="M0,0 L10,5 L0,10 Z" fill="#e0b040" />
                  </marker>
                </defs>
                <g transform={`translate(${view.tx} ${view.ty}) scale(${view.k})`}>
                {edges.map(([a, b], i) => {
                  const A = positions.map[a], B = positions.map[b]
                  if (!A || !B) return null
                  const hi = highlightEdges.has(`${a} ${b}`)
                  return (
                    <line key={i} x1={sx(A.x)} y1={sy(A.y)} x2={sx(B.x)} y2={sy(B.y)}
                      stroke={hi ? '#e0b040' : 'var(--text-muted)'}
                      strokeWidth={(hi ? 2.4 : 1.2) / view.k}
                      markerEnd={hi ? 'url(#imp-arrow-hi)' : 'url(#imp-arrow)'}
                      opacity={highlightPath && !hi ? 0.2 : 0.85} />
                  )
                })}
                {nodes.map(l => {
                  const P = positions.map[l]
                  if (!P) return null
                  const isSrc = l === srcLabel, isDst = l === dstLabel
                  const hi = highlightNodes.has(l)
                  const el = elById[l]
                  const type = el?.type ?? ''
                  const annot = el?.Annotation ?? ''
                  const bgFill = isSrc ? '#4a9fff44' : isDst ? '#e0b04044'
                                : hi ? '#e0b04022' : null
                  return (
                    <g key={l} data-node="1" style={{ cursor: 'pointer' }}
                       onClick={() => handleNodeClick(l)}
                       opacity={highlightPath && !hi ? 0.35 : 1}>
                      {bgFill && (
                        <rect x={sx(P.x) - 15} y={sy(P.y) - 15} width={30} height={30}
                          rx={4} fill={bgFill} />
                      )}
                      {showIcon && (
                        <g transform={`translate(${sx(P.x)},${sy(P.y)}) scale(0.9)`}>
                          <ElementShape type={type} orientation={el?.orientation} selected={false}
                            symbolDefs={symbolDefs} dark={true} />
                        </g>
                      )}
                      {/* Text sizes and label offsets divided by the zoom
                          factor so labels stay the same visual size (and stay
                          at the same visual distance from the icon) as the
                          user zooms. The zoom stays useful for the icons and
                          layout, without labels blowing up or shrinking. */}
                      {showLabel && (
                        <text x={sx(P.x)} y={sy(P.y) - 15 / view.k} textAnchor="middle"
                          fontSize={11 / view.k}
                          fontWeight={600} fill="var(--text)">{l}</text>
                      )}
                      {showType && type && (
                        <text x={sx(P.x)} y={sy(P.y) + 22 / view.k} textAnchor="middle"
                          fontSize={9 / view.k}
                          fill="var(--text-muted)">{type}</text>
                      )}
                      {showAnnotation && annot && (
                        <text x={sx(P.x)} y={sy(P.y) + 33 / view.k} textAnchor="middle"
                          fontSize={9 / view.k}
                          fill="var(--text-muted)" fontStyle="italic">{annot}</text>
                      )}
                    </g>
                  )
                })}
                </g>
              </svg>

              {candidatePaths && (
                <div style={{ marginTop: 8 }}>
                  <div className="imp-legend">
                    {candidatePaths.length} paths from {srcLabel} to {dstLabel} — hover to preview, click Import:
                  </div>
                  <ul className="imp-candidates">
                    {candidatePaths.map((p, i) => (
                      <li key={i}
                        className={hoveredCandidate === i ? 'hover' : ''}
                        onMouseEnter={() => setHoveredCandidate(i)}
                        onMouseLeave={() => setHoveredCandidate(prev => prev === i ? null : prev)}>
                        <button className="small-btn" onClick={() => finish(p)}>Import</button>
                        <span className="imp-cand-path">{p.join(' → ')}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )
        })()}

        <div style={{ marginTop: 8, textAlign: 'right' }}>
          <button className="small-btn" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  )
}

// ── Plot ───────────────────────────────────────────────────────────────────
// Renders one or two beam-radius traces on a single SVG. Each optic is
// drawn as either a real biconvex lens SVG (positive f), a small biconcave
// icon (negative f), or a faint dot marker (passthrough).
// ── Symbol SVG inlining for PDF export ─────────────────────────────────────
// svg2pdf can't follow href on <image> tags, so decorative lens SVGs would
// otherwise vanish from the export. Fetch each href once, cache the parsed
// content, and replace <image> with a <g transform="translate(x,y) scale(sx,sy)">
// wrapping the source SVG's paths.
const _symbolCache = new Map()
async function loadSymbolSvg(href) {
  if (_symbolCache.has(href)) return _symbolCache.get(href)
  const p = fetch(href).then(r => r.text()).then(txt => {
    const doc = new DOMParser().parseFromString(txt, 'image/svg+xml')
    return doc.documentElement
  }).catch(() => null)
  _symbolCache.set(href, p)
  return p
}
// Fallback used when we can't inline a symbol — a tinted rect placeholder
// so the plot doesn't just have a blank spot where a lens should be.
function placeholderForImage(im) {
  const x = parseFloat(im.getAttribute('x') || 0)
  const y = parseFloat(im.getAttribute('y') || 0)
  const w = parseFloat(im.getAttribute('width')  || 12)
  const h = parseFloat(im.getAttribute('height') || 34)
  const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
  rect.setAttribute('x', x); rect.setAttribute('y', y)
  rect.setAttribute('width', w); rect.setAttribute('height', h)
  rect.setAttribute('rx', 2)
  rect.setAttribute('fill', '#e0b04022')
  rect.setAttribute('stroke', '#e0b040')
  return rect
}
async function inlineSymbolImages(root) {
  const imgs = [...root.querySelectorAll('image')]
  await Promise.all(imgs.map(async im => {
    const href = im.getAttribute('href') || im.getAttribute('xlink:href') || ''
    if (!href) { im.replaceWith(placeholderForImage(im)); return }
    let src
    try { src = await loadSymbolSvg(href) } catch { src = null }
    if (!src || src.tagName !== 'svg') { im.replaceWith(placeholderForImage(im)); return }
    // Read the source SVG's viewBox — may have a non-zero origin.
    let vx = 0, vy = 0, sw = 0, sh = 0
    const vb = src.getAttribute('viewBox')
    if (vb) {
      const p = vb.trim().split(/[,\s]+/).map(parseFloat)
      if (p.length >= 4 && p.every(Number.isFinite)) [vx, vy, sw, sh] = p
    }
    if (!sw) sw = parseFloat(src.getAttribute('width'))  || 10
    if (!sh) sh = parseFloat(src.getAttribute('height')) || 10
    // Target rectangle from the <image>'s x/y/width/height, uniform scale
    // ("meet"-style) matching preserveAspectRatio default.
    const ix = parseFloat(im.getAttribute('x') || 0)
    const iy = parseFloat(im.getAttribute('y') || 0)
    const iw = parseFloat(im.getAttribute('width')  || sw)
    const ih = parseFloat(im.getAttribute('height') || sh)
    const scale = Math.min(iw / sw, ih / sh)
    const offX = ix + (iw - sw * scale) / 2 - vx * scale
    const offY = iy + (ih - sh * scale) / 2 - vy * scale
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g')
    g.setAttribute('transform', `translate(${offX},${offY}) scale(${scale})`)
    // Promote inline stop-color / stop-opacity styles to attributes — svg2pdf
    // reads them from attributes, not from parsed CSS.
    src.querySelectorAll('stop').forEach(stop => {
      const s = stop.getAttribute('style') || ''
      const color   = s.match(/stop-color\s*:\s*([^;]+)/)?.[1]?.trim()
      const opacity = s.match(/stop-opacity\s*:\s*([^;]+)/)?.[1]?.trim()
      if (color   && !stop.hasAttribute('stop-color'))   stop.setAttribute('stop-color',   color)
      if (opacity && !stop.hasAttribute('stop-opacity')) stop.setAttribute('stop-opacity', opacity)
    })
    // Copy every element child (skip comments and text). Also skip any nested
    // <image> — svg2pdf can't render raster embeds, and they'd otherwise
    // silently break the whole clone.
    for (const child of [...src.children]) {
      if (child.tagName?.toLowerCase() === 'image') continue
      g.appendChild(child.cloneNode(true))
    }
    im.replaceWith(g)
  }))
}

// Given a maximum value, return "nice" round ticks from 0 to max at 1/2/5
// steps of a power of 10 (matches how humans axis-label — always ends in
// integers or a single decimal, never something like 1.28).
function niceTicks(maxValue, targetCount = 5) {
  if (!Number.isFinite(maxValue) || maxValue <= 0) return [0]
  const rough = maxValue / targetCount
  const mag = Math.pow(10, Math.floor(Math.log10(rough)))
  const norm = rough / mag
  let step
  if (norm < 1.5)      step = 1
  else if (norm < 3.5) step = 2
  else if (norm < 7.5) step = 5
  else                 step = 10
  step *= mag
  const ticks = []
  for (let t = 0; t <= maxValue + step * 0.0001; t += step) {
    // Guard against floating drift so labels like 0.30000000004 don't show.
    ticks.push(Math.round(t / step) * step)
  }
  return ticks
}
function tickLabel(v, step) {
  // Pick just enough decimals to distinguish adjacent ticks. For step >= 1,
  // no decimals; step 0.1 → 1 decimal; step 0.01 → 2 decimals; and so on.
  if (step >= 1)     return v.toFixed(0)
  if (step >= 0.1)   return v.toFixed(1)
  if (step >= 0.01)  return v.toFixed(2)
  return v.toFixed(3)
}

function BeamPlot({ traces, events, testPoints, zTotal, width = 720, height = 240, title, onDragOptic, onResize }) {
  const W = Math.max(360, width), H = Math.max(160, height)
  const PAD_L = 52, PAD_R = 16, PAD_B = 34
  const PAD_T_BASE = 42
  // ── Label-collision layout ──────────────────────────────────────────────
  // Assign each optic a "row" so no two labels overlap horizontally. Greedy
  // first-fit: sort by z, place at the lowest row whose extents so far don't
  // collide with the new label's horizontal footprint. Grow PAD_T by one
  // row-height for each extra row used so labels always fit above the plot.
  // Each label is TWO lines tall (label + f=Xmm), so the row spacing has to
  // clear both lines plus a gap. 22 px = 11 px per line × 2.
  const ROW_H = 22              // vertical spacing between label rows (px)
  const CHAR_W = 5.5            // rough per-character width at fontSize=10
  const eventLayout = (() => {
    const rowByIndex = new Array(events.length).fill(0)
    const rows = []             // rows[r] = array of [xMin, xMax] extents
    const xForZ = z => PAD_L + (z / Math.max(1e-6, zTotal)) * (W - PAD_L - PAD_R)
    // Sort indices by z but write rowByIndex back at the original position.
    const order = events.map((_, i) => i).sort((a, b) => events[a].z_mm - events[b].z_mm)
    for (const i of order) {
      const ev = events[i]
      const line1 = ev.elementLabel ?? ev.label ?? 'L'
      const line2 = (ev.kind === 'lens' && Number.isFinite(Number(ev.f)) && Number(ev.f) !== 0)
        ? `f=${ev.f}mm` : ''
      const charW = Math.max(line1.length, line2.length)
      const half = charW * CHAR_W / 2 + 3
      const cx = xForZ(ev.z_mm)
      const xMin = cx - half, xMax = cx + half
      let r = 0
      for (;; r++) {
        const bucket = rows[r] || (rows[r] = [])
        const collides = bucket.some(([a, b]) => !(xMax < a || xMin > b))
        if (!collides) { bucket.push([xMin, xMax]); break }
      }
      rowByIndex[i] = r
    }
    return { rowByIndex, maxRow: rows.length ? rows.length - 1 : 0 }
  })()
  const PAD_T = PAD_T_BASE + eventLayout.maxRow * ROW_H
  const plotW = W - PAD_L - PAD_R, plotH = H - PAD_T - PAD_B
  const svgRef = useRef(null)
  const resizeRef = useRef(null)
  // Drag state (mutable ref, not React state, so drag doesn't spam re-renders):
  //   { opticId, startClientX, startClientY, startZ, startF, axis }
  // axis: null (undecided) | 'x' (change z) | 'y' (change f)
  const dragRef = useRef(null)
  // Convert screen x (in SVG local coords) to a physical z in mm.
  const xToZ = px => Math.max(0, Math.min(zTotal, (px - PAD_L) / plotW * zTotal))
  // Vertical drag → focal-length change. Positive dy (dragging DOWN) shortens
  // the focal length; positive up lengthens it. Scale is chosen so a full
  // plot-height drag roughly halves / doubles a typical focal length.
  const F_PER_PIXEL = 2   // mm of f per pixel of vertical drag
  const AXIS_LOCK_PX = 4  // move this far to lock a direction
  function onSvgMouseMove(e) {
    // Plot resize drag takes precedence.
    const r = resizeRef.current
    if (r) {
      const nw = Math.max(360, r.startW + (e.clientX - r.startClientX))
      const nh = Math.max(160, r.startH + (e.clientY - r.startClientY))
      onResize?.(nw, nh)
      return
    }
    const d = dragRef.current
    if (!d) return
    const rect = svgRef.current?.getBoundingClientRect()
    if (!rect) return
    const dx = e.clientX - d.startClientX
    const dy = e.clientY - d.startClientY
    // Lock a direction on the first meaningful movement.
    if (!d.axis) {
      if (Math.abs(dx) < AXIS_LOCK_PX && Math.abs(dy) < AXIS_LOCK_PX) return
      d.axis = Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y'
    }
    if (d.axis === 'x') {
      const localX = e.clientX - rect.left
      onDragOptic?.(d.opticId, { z_mm: xToZ(localX) })
    } else if (d.axis === 'y' && Number.isFinite(d.startF)) {
      // Up = larger f, down = smaller.
      const newF = d.startF - dy * F_PER_PIXEL
      onDragOptic?.(d.opticId, { f_mm: Math.round(newF * 10) / 10 })
    }
  }
  function endDrag() { dragRef.current = null; resizeRef.current = null }
  // Pick a y-axis maximum that fits the widest sample across all traces
  // with a small headroom so the beam never touches the top edge.
  const dataMax = Math.max(0.01, ...traces.flatMap(t =>
    t.points.map(p => p.w_mm).filter(Number.isFinite)))
  const maxW = dataMax * 1.08
  const xOf = z => PAD_L + (z / Math.max(1e-6, zTotal)) * plotW
  const yOf = w => PAD_T + plotH - (w / maxW) * plotH
  const linePathOf = pts => pts.map((p, i) =>
    `${i ? 'L' : 'M'}${xOf(p.z_mm).toFixed(2)},${yOf(p.w_mm).toFixed(2)}`).join(' ')

  const LENS_W = 12, LENS_H = 34
  const iconTop = PAD_T + 4

  return (
    <svg className="prop-plot" width={W} height={H} ref={svgRef}
      onMouseMove={onSvgMouseMove} onMouseUp={endDrag} onMouseLeave={endDrag}>
      {/* title + legend row */}
      {title && (
        <text x={PAD_L} y={14} fontSize={12} fill="var(--text)" fontWeight={600}>{title}</text>
      )}
      {traces.length > 1 && (
        <g>
          {traces.map((t, i) => (
            <g key={i} transform={`translate(${W - PAD_R - 90 - i * 66}, 14)`}>
              <line x1={0} y1={-4} x2={16} y2={-4} stroke={t.color} strokeWidth={2} />
              <text x={22} y={0} fontSize={11} fill="var(--text-muted)">{t.label}</text>
            </g>
          ))}
        </g>
      )}

      {/* axis lines */}
      <line x1={PAD_L} y1={PAD_T + plotH} x2={PAD_L + plotW} y2={PAD_T + plotH} stroke="var(--text-muted)" />
      <line x1={PAD_L} y1={PAD_T} x2={PAD_L} y2={PAD_T + plotH} stroke="var(--text-muted)" />

      {/* y ticks — snap to nice round values (1, 2, 5 × 10ⁿ) */}
      {(() => {
        const ticks = niceTicks(maxW)
        const step = ticks.length > 1 ? ticks[1] - ticks[0] : 1
        return ticks.map(w => (
          <g key={`y${w}`}>
            <line x1={PAD_L - 3} y1={yOf(w)} x2={PAD_L} y2={yOf(w)} stroke="var(--text-muted)" />
            <text x={PAD_L - 6} y={yOf(w)} textAnchor="end" dominantBaseline="middle"
              fontSize={10} fill="var(--text-muted)">{tickLabel(w, step)}</text>
          </g>
        ))
      })()}
      {/* x ticks — snap to nice round values as well */}
      {(() => {
        const ticks = niceTicks(zTotal)
        const step = ticks.length > 1 ? ticks[1] - ticks[0] : 1
        return ticks.map(z => (
          <g key={`x${z}`}>
            <line x1={xOf(z)} y1={PAD_T + plotH} x2={xOf(z)} y2={PAD_T + plotH + 3} stroke="var(--text-muted)" />
            <text x={xOf(z)} y={PAD_T + plotH + 15} textAnchor="middle"
              fontSize={10} fill="var(--text-muted)">{tickLabel(z, step)}</text>
          </g>
        ))
      })()}
      <text x={PAD_L + plotW / 2} y={H - 6} textAnchor="middle" fontSize={11} fill="var(--text-muted)">z (mm)</text>
      <text x={14} y={PAD_T + plotH / 2} textAnchor="middle" fontSize={11} fill="var(--text-muted)"
        transform={`rotate(-90 14 ${PAD_T + plotH / 2})`}>w (mm, radius)</text>

      {/* Optic markers + icons — labels are split onto two lines
          (label + shape, then f=Xmm) so long labels don't collide with
          adjacent lenses. Lenses can be dragged horizontally to change z. */}
      {events.map((ev, i) => {
        const isLens = ev.kind === 'lens'
        const isNegative = isLens && Number(ev.f) < 0
        const cx = xOf(ev.z_mm)
        const line1 = `${ev.elementLabel ?? ev.label ?? 'L'}${
          isLens && ev.shape && ev.shape !== 'spherical' ? ` (${ev.shape})` : ''
        }`
        const line2 = (isLens && Number.isFinite(ev.f) && ev.f !== 0)
          ? `f=${ev.f}mm` : ''
        const stroke = isLens ? '#e0b040' : 'var(--text-muted)'
        const draggable = !!onDragOptic && ev.opticId != null
        const beginDrag = draggable ? (e => {
          e.stopPropagation(); e.preventDefault()
          dragRef.current = {
            opticId: ev.opticId,
            startClientX: e.clientX,
            startClientY: e.clientY,
            startZ: ev.z_mm,
            startF: Number(ev.f),
            axis: null,   // decided on first mousemove
          }
        }) : undefined
        return (
          <g key={`e${i}`}>
            <line x1={cx} y1={PAD_T + LENS_H + 4} x2={cx} y2={PAD_T + plotH}
              stroke={stroke} strokeDasharray="4 3" strokeWidth={1}
              opacity={isLens ? 0.6 : 0.3} />
            {isLens && !isNegative ? (
              <image href="/symbols/b-lens1.svg"
                x={cx - LENS_W / 2} y={iconTop}
                width={LENS_W} height={LENS_H}
                preserveAspectRatio="xMidYMid meet" />
            ) : isLens ? (
              (() => {
                const rx = LENS_W / 2, ry = LENS_H / 2, ccy = iconTop + ry
                return (
                  <path d={`M ${cx - rx},${ccy - ry} Q ${cx + rx},${ccy} ${cx - rx},${ccy + ry}
                            M ${cx + rx},${ccy - ry} Q ${cx - rx},${ccy} ${cx + rx},${ccy + ry}`}
                    fill="none" stroke="#e0b040" strokeWidth={1.6} />
                )
              })()
            ) : (
              <circle cx={cx} cy={iconTop + LENS_H / 2} r={3} fill="var(--text-muted)" opacity={0.55} />
            )}
            {/* Two-line label — rowOffset stacks labels vertically when
                adjacent optics would otherwise collide. */}
            {(() => {
              const row = eventLayout.rowByIndex[i] ?? 0
              const rowOffset = row * ROW_H
              return (
                <>
                  <text x={cx} y={iconTop - 15 - rowOffset} textAnchor="middle" fontSize={10}
                    fill={stroke}>{line1}</text>
                  {line2 && (
                    <text x={cx} y={iconTop - 4 - rowOffset} textAnchor="middle" fontSize={10}
                      fill={stroke}>{line2}</text>
                  )}
                </>
              )
            })()}
            {/* Drag hit-zone: invisible rect over the icon + a bit of padding.
                Horizontal drag → z, vertical drag → f. The first ~4 px of
                movement decides which axis the drag is locked to. */}
            {draggable && isLens && (
              <rect x={cx - LENS_W / 2 - 3} y={iconTop - 2}
                width={LENS_W + 6} height={LENS_H + 4}
                fill="transparent" style={{ cursor: 'move' }}
                onMouseDown={beginDrag}>
                <title>Drag ← → to change z · drag ↑ ↓ to change f</title>
              </rect>
            )}
          </g>
        )
      })}
      {/* Test points */}
      {testPoints.map((tp, i) => (
        <g key={`t${i}`}>
          <line x1={xOf(tp.z_mm)} y1={PAD_T} x2={xOf(tp.z_mm)} y2={PAD_T + plotH}
            stroke="#5cc46a" strokeDasharray="2 4" strokeWidth={1} opacity={0.75} />
          <text x={xOf(tp.z_mm)} y={PAD_T + plotH + 26} textAnchor="middle" fontSize={10}
            fill="#5cc46a">{tp.label ?? `t${i + 1}`}</text>
        </g>
      ))}

      {/* Beam radius traces (drawn last so they sit above dashed lines) */}
      {traces.map((t, i) => (
        <path key={`tr${i}`} d={linePathOf(t.points)}
          fill="none" stroke={t.color} strokeWidth={1.8}
          strokeLinejoin="round" strokeLinecap="round" />
      ))}
      {/* Resize handle in the bottom-right corner. Drag to zoom the plot. */}
      {onResize && (
        <g style={{ cursor: 'nwse-resize' }}
           onMouseDown={e => {
             e.stopPropagation(); e.preventDefault()
             resizeRef.current = {
               startClientX: e.clientX, startClientY: e.clientY,
               startW: W, startH: H,
             }
           }}>
          <rect x={W - 14} y={H - 14} width={14} height={14} fill="transparent" />
          <path d={`M${W - 3},${H - 12} L${W - 12},${H - 3} M${W - 3},${H - 6} L${W - 6},${H - 3}`}
            stroke="var(--text-muted)" strokeWidth={1} fill="none" opacity={0.7} />
        </g>
      )}
    </svg>
  )
}

// ── Main mode component ────────────────────────────────────────────────────
const BeamPropagationMode = forwardRef(function BeamPropagationMode({
  propagations: propagationsRaw, activePropagation,
  onSetPropagations, onSetActivePropagation, onExit,
  beamPaths, elements, symbolDefs,
}, ref) {
  const [importOpen, setImportOpen] = useState(false)
  const [renamingId, setRenamingId] = useState(null)
  const [renameVal, setRenameVal]   = useState('')
  const [showPassthroughOptics, setShowPassthroughOptics] = useState(false)

  // Normalise any legacy µm-based propagations to mm on read.
  const propagations = useMemo(() => {
    const out = {}
    for (const [id, entry] of Object.entries(propagationsRaw ?? {})) {
      out[id] = normalizePropagation(entry)
    }
    return out
  }, [propagationsRaw])

  const ids = Object.keys(propagations)
  const activeId = activePropagation && propagations[activePropagation] ? activePropagation : (ids[0] ?? null)
  const p = activeId ? propagations[activeId] : null

  // ── Local undo stack ─────────────────────────────────────────────────────
  // Snapshots the whole propagations map on every user-driven change. A short
  // debounce coalesces rapid keystrokes (e.g. typing a name, dragging a lens)
  // into a single history entry so Cmd/Ctrl+Z jumps meaningful distances.
  // Version state is bumped on each snapshot / undo so the toolbar can show
  // an accurate "disabled" state for the button.
  const historyRef = useRef([])
  const lastSnapAtRef = useRef(0)
  const [, setHistoryVersion] = useState(0)
  const MAX_HISTORY = 100
  const COALESCE_MS = 500
  function snapshotIfDue() {
    const now = Date.now()
    if (historyRef.current.length === 0 || now - lastSnapAtRef.current > COALESCE_MS) {
      historyRef.current = [
        ...historyRef.current.slice(-MAX_HISTORY + 1),
        propagationsRaw,
      ]
      lastSnapAtRef.current = now
      setHistoryVersion(v => v + 1)
    }
  }
  function snapshotNow() {
    historyRef.current = [
      ...historyRef.current.slice(-MAX_HISTORY + 1),
      propagationsRaw,
    ]
    lastSnapAtRef.current = Date.now()
    setHistoryVersion(v => v + 1)
  }
  function commitProps(next) { snapshotIfDue(); onSetPropagations(next) }
  function commitPropsDiscrete(next) { snapshotNow(); onSetPropagations(next) }
  function undo() {
    const h = historyRef.current
    if (!h.length) return
    onSetPropagations(h[h.length - 1])
    historyRef.current = h.slice(0, -1)
    // Force the next mutation to start a fresh coalesce window.
    lastSnapAtRef.current = 0
    setHistoryVersion(v => v + 1)
  }
  // Cmd / Ctrl + Z while the mode is mounted.
  useEffect(() => {
    function onKey(e) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !e.shiftKey) {
        const tag = document.activeElement?.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
        e.preventDefault()
        undo()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [propagationsRaw])

  function setActive(id) { onSetActivePropagation(id) }
  function mutate(patch) {
    if (!p) return
    commitProps({ ...propagations, [p.id]: { ...p, ...patch } })
  }
  function mutateOptic(idx, patch) {
    if (!p) return
    const optics = p.optics.map((o, i) => i === idx ? { ...o, ...patch } : o)
    mutate({ optics })
  }
  function mutateOpticById(id, patch) {
    if (!p) return
    const optics = p.optics.map(o => o.id === id ? { ...o, ...patch } : o)
    mutate({ optics })
  }
  // Discrete operations use commitPropsDiscrete so each add/remove is its
  // own undo step even when they happen in rapid succession.
  function mutateDiscrete(patch) {
    if (!p) return
    commitPropsDiscrete({ ...propagations, [p.id]: { ...p, ...patch } })
  }
  function addOptic() {
    const optic = { id: crypto.randomUUID(), kind: 'lens', z_mm: 0, f_mm: 100, shape: 'spherical', label: 'L' + ((p?.optics?.length ?? 0) + 1) }
    mutateDiscrete({ optics: [...(p?.optics ?? []), optic] })
  }
  function removeOptic(idx) {
    mutateDiscrete({ optics: p.optics.filter((_, i) => i !== idx) })
  }
  function addTestPoint() {
    const tp = { id: crypto.randomUUID(), z_mm: 0, label: 't' + ((p?.testPoints?.length ?? 0) + 1) }
    mutateDiscrete({ testPoints: [...(p?.testPoints ?? []), tp] })
  }
  function removeTestPoint(idx) {
    mutateDiscrete({ testPoints: p.testPoints.filter((_, i) => i !== idx) })
  }
  function newPropagation() {
    const np = makeDefaultPropagation(`Propagation ${ids.length + 1}`)
    commitPropsDiscrete({ ...propagations, [np.id]: np })
    setActive(np.id)
  }
  function deletePropagation(id) {
    const { [id]: _drop, ...rest } = propagations
    commitPropsDiscrete(rest)
    if (activeId === id) setActive(Object.keys(rest)[0] ?? null)
  }

  // ── Import from designer beam path ───────────────────────────────────────
  function acceptImport({ pathName, nodes, distances_mm }) {
    // Build optics list. Each node becomes an optic marker at its cumulative z.
    // Elements whose type contains "lens" become editable lenses (f seeded
    // from element.f_mm if set). Others are passthrough — greyed out in the
    // UI, no f prompt, identity in the physics.
    const elById = {}; elements.forEach(e => { elById[e.label] = e })
    const optics = []
    let z = 0
    for (let i = 0; i < nodes.length; i++) {
      if (i > 0) z += distances_mm[i - 1]
      const el = elById[nodes[i]]
      const type = (el?.type ?? '').toLowerCase()
      const isLens = type.includes('lens')
      const fInferred = isLens ? inferFocalLengthMm(el) : NaN
      optics.push({
        id: crypto.randomUUID(),
        kind: isLens ? 'lens' : 'passthrough',
        z_mm: z,
        f_mm: Number.isFinite(fInferred) ? fInferred : 0,
        shape: 'spherical',
        label: nodes[i],
        elementLabel: nodes[i],
        elementType: el?.type ?? '',
      })
    }
    const np = makeDefaultPropagation(`Imported: ${pathName}`)
    np.optics = optics
    np.distance_mm = Math.max(500, z + 50)
    np.source = { pathName, nodes, distances_mm }
    commitPropsDiscrete({ ...propagations, [np.id]: np })
    setActive(np.id)
    setImportOpen(false)
  }

  // ── Reimport: refresh distances + focal lengths from the current designer ─
  // Preserves the source path + node sequence, plus any user-added optics
  // that aren't tied to a designer element. If the source path is missing
  // or a node label no longer exists, fall through to the ordinary import
  // modal so the user can re-select a start / end.
  function reimport() {
    if (!p || !p.source) return
    const { pathName, nodes } = p.source
    const path = beamPaths?.[pathName]
    const elById = {}; elements.forEach(e => { elById[e.label] = e })
    const stillValid = !!path && nodes.every(l => elById[l])
    if (!stillValid) {
      setImportOpen(true)   // let the user pick fresh start/end
      return
    }
    // Recompute cumulative distances from current element positions.
    const distances_mm = []
    for (let i = 1; i < nodes.length; i++) {
      const a = elById[nodes[i - 1]], b = elById[nodes[i]]
      const dIn = Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2)
      distances_mm.push(dIn * INCH_MM)
    }
    // Rebuild the imported optics (matched by elementLabel), preserving id,
    // label, and any user-toggled kind. Fresh f and elementType.
    const importedLabels = new Set(nodes)
    const opticByLabel = new Map()
    for (const o of (p.optics ?? [])) {
      if (o.elementLabel && importedLabels.has(o.elementLabel)) {
        opticByLabel.set(o.elementLabel, o)
      }
    }
    const nextImported = []
    let z = 0
    for (let i = 0; i < nodes.length; i++) {
      if (i > 0) z += distances_mm[i - 1]
      const el = elById[nodes[i]]
      const type = (el?.type ?? '').toLowerCase()
      const looksLikeLens = type.includes('lens')
      const fInferred = looksLikeLens ? inferFocalLengthMm(el) : NaN
      const prev = opticByLabel.get(nodes[i])
      nextImported.push({
        id: prev?.id ?? crypto.randomUUID(),
        // Preserve manual kind switches (e.g. user marked something as a lens),
        // but default to lens/passthrough by type when there was no prior optic.
        kind: prev?.kind ?? (looksLikeLens ? 'lens' : 'passthrough'),
        z_mm: z,
        f_mm: Number.isFinite(fInferred) ? fInferred
              : (prev?.kind === 'lens' ? (prev.f_mm ?? 0) : 0),
        shape: prev?.shape ?? 'spherical',
        label: prev?.label ?? nodes[i],
        elementLabel: nodes[i],
        elementType: el?.type ?? '',
      })
    }
    // Keep any user-added optics (no elementLabel or one outside the source
    // node set) at their current z, appended after the refreshed sequence.
    const kept = (p.optics ?? []).filter(o =>
      !o.elementLabel || !importedLabels.has(o.elementLabel))
    const nextOptics = [...nextImported, ...kept]
    commitPropsDiscrete({
      ...propagations,
      [p.id]: {
        ...p,
        optics: nextOptics,
        distance_mm: Math.max(p.distance_mm ?? 0, z + 50),
        source: { pathName, nodes, distances_mm },
      },
    })
  }

  // ── Build the propagation trace ──────────────────────────────────────────
  const compute = useMemo(() => {
    if (!p) return null
    const lambda_mm = nmToMm(p.wavelength_nm)
    const w0x = p.w0x_mm
    const w0y = p.splitXY ? p.w0y_mm : p.w0x_mm
    const divx = mradToRad(p.divx_mrad)
    const divy = mradToRad(p.splitXY ? p.divy_mrad : p.divx_mrad)
    const qx0 = qFromBeam(w0x, divx, lambda_mm)
    const qy0 = qFromBeam(w0y, divy, lambda_mm)

    // Sort optics by z, keep those inside [0, distance_mm].
    const optics = [...(p.optics ?? [])]
      .filter(o => o.z_mm >= 0 && o.z_mm <= p.distance_mm)
      .sort((a, b) => a.z_mm - b.z_mm)

    // Steps: free-space between lens optics. Pass-through elements don't
    // contribute a step but are surfaced as plot events.
    const steps = []
    let cursor = 0
    for (const o of optics) {
      if (o.kind === 'lens') {
        if (o.z_mm > cursor) steps.push({ kind: 'space', L: o.z_mm - cursor })
        steps.push({ kind: 'lens', f: o.f_mm, shape: o.shape ?? 'spherical',
                    label: o.label, elementLabel: o.elementLabel })
        cursor = o.z_mm
      }
    }
    if (p.distance_mm > cursor) steps.push({ kind: 'space', L: p.distance_mm - cursor })

    const trace = sampleWofZ2D(steps, qx0, qy0, lambda_mm)

    // Build unified event list for the plot: every optic — lens or
    // passthrough — gets a marker at its z. Passthroughs are filtered out
    // when the propagation's Hide pass-through on plot flag is on.
    const events = optics
      .filter(o => !p.hidePassthroughOnPlot || o.kind === 'lens')
      .map(o => ({
        z_mm: o.z_mm,
        kind: o.kind,       // 'lens' | 'passthrough'
        label: o.label,
        elementLabel: o.elementLabel,
        f: o.f_mm,
        shape: o.shape ?? 'spherical',
        opticId: o.id,      // for drag-updates by id (indices shift with sort)
      }))

    // Per-optic + per-test-point q sampling (independent replay for accuracy).
    function beamAt(z_mm) {
      let qx = qx0, qy = qy0, z = 0
      for (const o of optics) {
        if (o.z_mm > z_mm) break
        const dz = o.z_mm - z
        qx = propagateFreeSpace(qx, dz); qy = propagateFreeSpace(qy, dz); z += dz
        if (o.kind !== 'lens') continue
        const shape = o.shape ?? 'spherical'
        if (shape === 'spherical' || shape === 'cylX') qx = propagateThinLens(qx, o.f_mm)
        if (shape === 'spherical' || shape === 'cylY') qy = propagateThinLens(qy, o.f_mm)
      }
      const dz = z_mm - z
      qx = propagateFreeSpace(qx, dz); qy = propagateFreeSpace(qy, dz)
      return { wx_mm: radiusFromQ(qx, lambda_mm), wy_mm: radiusFromQ(qy, lambda_mm) }
    }
    const opticRows = optics.map(o => {
      const b = beamAt(o.z_mm)
      return { kind: o.kind === 'lens' ? 'lens' : 'element',
               label: o.label, elementLabel: o.elementLabel, elementType: o.elementType,
               z_mm: o.z_mm, f_mm: o.f_mm, shape: o.shape ?? 'spherical', ...b }
    })
    const tpRows = (p.testPoints ?? []).map(tp => ({
      kind: 'test', label: tp.label, z_mm: tp.z_mm, ...beamAt(tp.z_mm),
    }))
    const rows = [...opticRows, ...tpRows].sort((a, b) => a.z_mm - b.z_mm)
    return { trace: { ...trace, events }, rows, optics }
  }, [p])

  function downloadPropagationsCsv() {
    const text = serializePropagationsCsv(propagations)
    const blob = new Blob([text], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url; a.download = 'propagations.csv'; a.click()
    URL.revokeObjectURL(url)
  }

  // ── PDF export ────────────────────────────────────────────────────────────
  // Renders the active propagation's plot(s) plus the parameter table into a
  // landscape-letter PDF via jspdf + svg2pdf. Loaded on demand.
  const plotWrapRef = useRef(null)
  async function exportPropagationPdf() {
    if (!p || !compute) return
    const [{ default: jsPDF }, { svg2pdf }] = await Promise.all([
      import('jspdf'), import('svg2pdf.js'),
    ])
    const doc = new jsPDF({ orientation: 'l', unit: 'mm', format: 'letter' })
    const pageW = doc.internal.pageSize.getWidth()
    const pageH = doc.internal.pageSize.getHeight()

    // Title + summary — plain ASCII only. jsPDF's built-in Helvetica has
    // no Greek letters (lambda), no subscripts (w0 as w₀), and no middle
    // dot; using them here previously rendered as tofu / dropped glyphs.
    doc.setFontSize(14); doc.setFont('helvetica', 'bold')
    doc.text(p.name || 'Beam propagation', 12, 14)
    doc.setFont('helvetica', 'normal'); doc.setFontSize(10)
    const metaParts = [
      `wavelength = ${p.wavelength_nm} nm`,
      `distance = ${p.distance_mm} mm`,
      p.splitXY
        ? `w0 (x,y) = ${p.w0x_mm}, ${p.w0y_mm} mm     div (x,y) = ${p.divx_mrad}, ${p.divy_mrad} mrad`
        : `w0 = ${p.w0x_mm} mm     div = ${p.divx_mrad} mrad`,
    ]
    doc.text(metaParts.join('     '), 12, 20)
    if (p.source) {
      doc.setTextColor(120)
      doc.text(`Imported from: ${p.source.pathName}`, 12, 26)
      doc.setTextColor(0)
    }

    // Plots
    const svgs = plotWrapRef.current?.querySelectorAll('svg.prop-plot') ?? []
    let y = 30
    const plotDrawWmm = pageW - 24
    const plotDrawHmm = 76
    for (const svg of svgs) {
      if (y + plotDrawHmm > pageH - 12) { doc.addPage(); y = 12 }
      // Clone so we can strip <image> tags svg2pdf may struggle with. The
      // lens icons are only decorative here; keep them as tiny outlined
      // rectangles for a fully vector output.
      const clone = svg.cloneNode(true)
      // Give svg2pdf a font it actually knows. Its built-in font table
      // resolves 'sans-serif' → 'helvetica'; without this, text ends up in
      // the default 'times' font at the wrong metrics, so labels don't sit
      // where we placed them.
      const styleEl = document.createElementNS('http://www.w3.org/2000/svg', 'style')
      styleEl.textContent = 'text { font-family: sans-serif }'
      clone.insertBefore(styleEl, clone.firstChild)
      // svg2pdf doesn't resolve CSS variables (var(--text-muted) etc.), so
      // any element whose stroke/fill was a var() renders invisible. Copy
      // the LIVE element's computed color onto its clone. Doing this for
      // every element (not just var() ones) also flattens any theme-driven
      // colors that get injected via the stylesheet cascade.
      // svg2pdf's color parser only handles hex + a handful of named
      // colors — rgb(...) tends to fall back to black. Explicit hex fills
      // (trace colors, lens gold, test-point green) should pass through
      // untouched; only var(--...) references (which svg2pdf can't resolve
      // at all) need to be replaced with the browser's resolved computed
      // color, converted to hex.
      function rgbToHex(s) {
        if (!s) return s
        if (s.startsWith('#')) return s
        const m = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?/i.exec(s)
        if (!m) return s
        const to2 = n => Math.max(0, Math.min(255, parseInt(n, 10))).toString(16).padStart(2, '0')
        const base = `#${to2(m[1])}${to2(m[2])}${to2(m[3])}`
        if (m[4] == null) return base
        const a = Math.max(0, Math.min(1, parseFloat(m[4])))
        if (a >= 0.999) return base
        return base + Math.round(a * 255).toString(16).padStart(2, '0')
      }
      const srcAll = svg.querySelectorAll('*')
      const dstAll = clone.querySelectorAll('*')
      for (let idx = 0; idx < srcAll.length && idx < dstAll.length; idx++) {
        const src = srcAll[idx], dst = dstAll[idx]
        for (const attr of ['stroke', 'fill']) {
          const orig = dst.getAttribute(attr)
          if (orig && orig.includes('var(')) {
            const resolved = getComputedStyle(src)[attr]
            if (resolved && resolved !== 'none') dst.setAttribute(attr, rgbToHex(resolved))
          }
        }
        // React sets fontSize via inline style; svg2pdf reads the font-size
        // attribute. Copy it over if only the style form is present.
        if (dst.tagName === 'text' && !dst.hasAttribute('font-size')) {
          const fs = getComputedStyle(src).fontSize
          if (fs) dst.setAttribute('font-size', parseFloat(fs))
        }
      }
      // svg2pdf uses the SVG's viewBox to map its coordinate space to the
      // target rect. The live plot has raw width/height but no viewBox, so
      // set one from the current width/height (or fall back to 720x240) —
      // otherwise it gets drawn at raw px which massively overshoots the
      // target width in mm.
      const rawW = parseFloat(svg.getAttribute('width'))  || 720
      const rawH = parseFloat(svg.getAttribute('height')) || 240
      if (!clone.getAttribute('viewBox')) {
        clone.setAttribute('viewBox', `0 0 ${rawW} ${rawH}`)
      }
      // Scale the target height to preserve the plot's aspect ratio.
      const drawHmm = Math.min(plotDrawHmm, plotDrawWmm * (rawH / rawW))
      clone.setAttribute('width',  String(plotDrawWmm))
      clone.setAttribute('height', String(drawHmm))
      // Inline every <image href="/symbols/*.svg"> so its content ends up
      // in the PDF as vector geometry instead of being referenced externally
      // (svg2pdf can't follow the href to an off-page file).
      await inlineSymbolImages(clone)
      // svg2pdf requires the SVG to be in the DOM.
      clone.style.cssText = 'position:absolute;left:-99999px;top:0'
      document.body.appendChild(clone)
      if (y + drawHmm > pageH - 12) {
        // If the aspect correction pushed the plot off the page, start fresh.
        document.body.removeChild(clone)
        doc.addPage(); y = 12
        document.body.appendChild(clone)
      }
      try {
        await svg2pdf(clone, doc, { x: 12, y, width: plotDrawWmm, height: drawHmm })
      } finally { document.body.removeChild(clone) }
      y += drawHmm + 4
    }

    // Parameter table
    if (y + 20 > pageH - 12) { doc.addPage(); y = 12 }
    doc.setFontSize(11); doc.setFont('helvetica', 'bold')
    doc.text('Beam parameters', 12, y); y += 5
    doc.setFontSize(9)
    const cols = p.splitXY
      ? ['Role', 'Label', 'z (mm)', 'f (mm)', 'w_x (mm)', 'w_y (mm)', 'Element']
      : ['Role', 'Label', 'z (mm)', 'f (mm)', 'w (mm)', 'Element']
    const colX = p.splitXY
      ? [12, 60, 100, 130, 158, 190, 220]
      : [12, 60, 100, 130, 160, 200]
    cols.forEach((c, i) => doc.text(c, colX[i], y))
    y += 2
    doc.setDrawColor(180); doc.line(12, y, pageW - 12, y)
    y += 4
    doc.setFont('helvetica', 'normal')
    const rowsForPdf = compute.rows.filter(r => !p.hidePassthroughInTable || r.kind !== 'element')
    for (const r of rowsForPdf) {
      const kindLabel = r.elementType?.trim()
        ? r.elementType.trim()
        : (r.kind === 'test' ? 'test point'
           : r.kind === 'lens' ? 'lens' : 'pass-through')
      const wx = Number.isFinite(r.wx_mm) ? r.wx_mm.toFixed(4) : '—'
      const wy = Number.isFinite(r.wy_mm) ? r.wy_mm.toFixed(4) : '—'
      const f  = r.kind === 'lens' && Number.isFinite(r.f_mm) && r.f_mm !== 0
                 ? r.f_mm.toFixed(1) : ''
      const vals = p.splitXY
        ? [kindLabel, r.label, r.z_mm.toFixed(1), f, wx, wy, r.elementLabel ?? '']
        : [kindLabel, r.label, r.z_mm.toFixed(1), f, wx, r.elementLabel ?? '']
      vals.forEach((v, i) => doc.text(String(v), colX[i], y))
      y += 4.6
      if (y > pageH - 12) { doc.addPage(); y = 12 }
    }

    const safe = (p.name || 'propagation').replace(/[/\\?%*:|"<>]/g, '_').trim() || 'propagation'
    doc.save(`${safe}.pdf`)
  }

  // Expose the exporter so the top-bar Export PDF button (rendered by App)
  // can call it. Re-registered on every render so it always sees fresh state.
  useImperativeHandle(ref, () => ({
    exportPdf: exportPropagationPdf,
    canExport: !!p && !!compute,
  }))

  return (
    <div className="prop-mode">
      {/* ── Left rail: propagations list ── */}
      <aside className="prop-rail">
        <div className="prop-rail-head">
          <button className="file-btn" onClick={onExit}>← Designer</button>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{ids.length} plot{ids.length === 1 ? '' : 's'}</span>
        </div>
        <div className="prop-rail-actions">
          <button className="small-btn" style={{ flex: 1 }} onClick={newPropagation}>+ New</button>
          <button className="small-btn" onClick={() => setImportOpen(true)} title="Import from beam path"
            disabled={!Object.keys(beamPaths ?? {}).length}>Import…</button>
        </div>
        <ul className="prop-rail-list">
          {ids.map(id => {
            const item = propagations[id]
            const active = id === activeId
            return (
              <li key={id} className={`prop-rail-item ${active ? 'active' : ''}`}>
                {renamingId === id ? (
                  <input className="snap-input" style={{ flex: 1 }} value={renameVal}
                    autoFocus onChange={e => setRenameVal(e.target.value)}
                    onBlur={() => { commitPropsDiscrete({ ...propagations, [id]: { ...propagations[id], name: renameVal.trim() || propagations[id].name } }); setRenamingId(null) }}
                    onKeyDown={e => { if (e.key === 'Enter') e.target.blur(); if (e.key === 'Escape') setRenamingId(null) }} />
                ) : (
                  <button className="prop-rail-name"
                    onClick={() => setActive(id)}
                    onDoubleClick={() => { setRenamingId(id); setRenameVal(item.name) }}
                    title="Click to open · double-click to rename">{item.name}</button>
                )}
                <button className="small-btn" title="Rename"
                  onClick={() => { setRenamingId(id); setRenameVal(item.name) }}>✎</button>
                <button className="small-btn" title="Delete"
                  onClick={() => deletePropagation(id)}>✕</button>
              </li>
            )
          })}
          {ids.length === 0 && (
            <li className="prop-rail-empty">No propagations yet — click <b>+ New</b> or <b>Import…</b>.</li>
          )}
        </ul>
        <div className="prop-rail-foot">
          <button className="small-btn" style={{ width: '100%' }} onClick={downloadPropagationsCsv}
            disabled={!ids.length}>Download propagations.csv</button>
        </div>
      </aside>

      {/* ── Main pane ── */}
      <main className="prop-main">
        {!p ? (
          <p className="empty">Create a new propagation or import from a beam path.</p>
        ) : (
          <>
            {/* Header */}
            <div className="prop-header">
              <input className="prop-name"
                value={p.name} onChange={e => mutate({ name: e.target.value })} />
              <label className="prop-field"><input type="checkbox" checked={p.splitXY}
                onChange={e => mutate({ splitXY: e.target.checked })} /> Split x / y</label>
              {p.splitXY && (
                <label className="prop-field"><input type="checkbox" checked={p.combinedXY}
                  onChange={e => mutate({ combinedXY: e.target.checked })} /> Overlay on one plot</label>
              )}
              <label className="prop-field"><input type="checkbox" checked={p.hidePassthroughOnPlot ?? false}
                onChange={e => mutate({ hidePassthroughOnPlot: e.target.checked })} /> Hide pass-through on plot</label>
              <label className="prop-field"><input type="checkbox" checked={p.hidePassthroughInTable ?? false}
                onChange={e => mutate({ hidePassthroughInTable: e.target.checked })} /> Hide pass-through in table</label>
              <label className="prop-field">λ (nm)
                <NumberField style={{ width: 80 }} value={p.wavelength_nm} fallback={1064}
                  onCommit={v => mutate({ wavelength_nm: v })} /></label>
              <label className="prop-field">Distance (mm)
                <NumberField style={{ width: 90 }} value={p.distance_mm} fallback={500}
                  onCommit={v => mutate({ distance_mm: v })} /></label>
              {p.source && (
                <>
                  <span className="prop-source">Imported from {p.source.pathName}</span>
                  <button className="small-btn" onClick={reimport}
                    title="Refresh distances and focal lengths from the current designer state">
                    ↻ Reimport
                  </button>
                </>
              )}
              <span style={{ flex: 1 }} />
              <button className="small-btn" onClick={undo}
                disabled={historyRef.current.length === 0}
                title="Undo last change (Cmd/Ctrl+Z)">↶ Undo</button>
            </div>

            {/* Initial beam */}
            <div className="prop-section">
              <div className="prop-section-title">
                Initial beam at z = 0
                <small style={{ marginLeft: 8, color: 'var(--text-muted)' }}>
                  · w₀ is the 1/e² intensity RADIUS, in mm
                </small>
              </div>
              <div className="prop-section-body">
                <div className="prop-row">
                  <label className="prop-field">w₀{p.splitXY ? ' (x)' : ''} (mm)
                    <NumberField style={{ width: 90 }} step="0.01"
                      value={p.w0x_mm} fallback={DEFAULT_W0_MM}
                      onCommit={v => mutate({ w0x_mm: v })} /></label>
                  <label className="prop-field">div{p.splitXY ? ' (x)' : ''} (mrad)
                    <NumberField style={{ width: 80 }} step="0.1"
                      value={p.divx_mrad} fallback={0}
                      onCommit={v => mutate({ divx_mrad: v })} /></label>
                  {p.splitXY && (
                    <>
                      <label className="prop-field">w₀ (y) (mm)
                        <NumberField style={{ width: 90 }} step="0.01"
                          value={p.w0y_mm} fallback={DEFAULT_W0_MM}
                          onCommit={v => mutate({ w0y_mm: v })} /></label>
                      <label className="prop-field">div (y) (mrad)
                        <NumberField style={{ width: 80 }} step="0.1"
                          value={p.divy_mrad} fallback={0}
                          onCommit={v => mutate({ divy_mrad: v })} /></label>
                    </>
                  )}
                </div>
              </div>
            </div>

            {/* Optics */}
            {(() => {
              const allOptics = p.optics ?? []
              const passthroughCount = allOptics.filter(o => o.kind !== 'lens').length
              // Preserve the original index so mutateOptic / removeOptic still
              // point at the right entry after filtering out passthrough rows.
              const visibleOptics = showPassthroughOptics
                ? allOptics.map((o, i) => [o, i])
                : allOptics.map((o, i) => [o, i]).filter(([o]) => o.kind === 'lens')
              return (
            <div className="prop-section">
              <div className="prop-section-title">Optics</div>
              <div className="prop-section-body">
                <div className="prop-actions">
                  <button className="small-btn" onClick={addOptic}>+ Add lens</button>
                  {passthroughCount > 0 && (
                    <label className="imp-toggle" style={{ marginLeft: 6 }}>
                      <input type="checkbox" checked={showPassthroughOptics}
                        onChange={e => setShowPassthroughOptics(e.target.checked)} />
                      {' '}Show pass-through ({passthroughCount})
                    </label>
                  )}
                </div>
                <table className="prop-table">
                  <thead>
                    <tr>
                      <th>Role</th><th>Label</th><th>z (mm)</th><th>f (mm)</th>
                      <th>Element</th><th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleOptics.map(([o, i]) => {
                      const isLens = o.kind === 'lens'
                      // Combined "Role" value: lens-spherical / lens-cylX /
                      // lens-cylY / passthrough. Reads current kind+shape
                      // and writes both on change.
                      const role = !isLens ? 'passthrough'
                        : (o.shape === 'cylX' ? 'lens-cylX'
                          : o.shape === 'cylY' ? 'lens-cylY'
                          : 'lens-spherical')
                      function setRole(next) {
                        if (next === 'passthrough') mutateOptic(i, { kind: 'passthrough' })
                        else if (next === 'lens-cylX') mutateOptic(i, { kind: 'lens', shape: 'cylX' })
                        else if (next === 'lens-cylY') mutateOptic(i, { kind: 'lens', shape: 'cylY' })
                        else mutateOptic(i, { kind: 'lens', shape: 'spherical' })
                      }
                      return (
                        <tr key={o.id} className={isLens ? '' : 'passthrough'}>
                          <td>
                            <select className="snap-input" style={{ minWidth: 130 }}
                              value={role}
                              onChange={e => setRole(e.target.value)}>
                              <option value="lens-spherical">Lens</option>
                              <option value="lens-cylX" disabled={!p.splitXY}>Lens (Cyl. X)</option>
                              <option value="lens-cylY" disabled={!p.splitXY}>Lens (Cyl. Y)</option>
                              <option value="passthrough">Pass-through</option>
                            </select>
                          </td>
                          <td><input className="snap-input" style={{ width: 70 }}
                            value={o.label} onChange={e => mutateOptic(i, { label: e.target.value })} /></td>
                          <td><NumberField style={{ width: 80 }} value={o.z_mm} fallback={0}
                            onCommit={v => mutateOptic(i, { z_mm: v })} /></td>
                          <td>{isLens ? (
                            <NumberField style={{ width: 80 }} value={o.f_mm} fallback={0}
                              onCommit={v => mutateOptic(i, { f_mm: v })} />
                          ) : <span className="dim">—</span>}</td>
                          <td className="el-meta">
                            {o.elementLabel ?? ''}{o.elementType ? ` · ${o.elementType}` : ''}
                          </td>
                          <td><button className="small-btn" onClick={() => removeOptic(i)}>✕</button></td>
                        </tr>
                      )
                    })}
                    {(!p.optics || !p.optics.length) && (
                      <tr><td colSpan={6} className="dim" style={{ textAlign: 'center', padding: 8 }}>
                        No optics — add one above or import from a beam path.
                      </td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
              )
            })()}

            {/* Test points */}
            <div className="prop-section">
              <div className="prop-section-title">Test points</div>
              <div className="prop-section-body">
                <div className="prop-actions">
                  <button className="small-btn" onClick={addTestPoint}>+ Add test point</button>
                </div>
                <table className="prop-table">
                  <thead><tr><th>Label</th><th>z (mm)</th><th></th></tr></thead>
                  <tbody>
                    {(p.testPoints ?? []).map((tp, i) => (
                      <tr key={tp.id}>
                        <td><input className="snap-input" style={{ width: 120 }}
                          value={tp.label} onChange={e => mutate({ testPoints: p.testPoints.map((t, j) => j === i ? { ...t, label: e.target.value } : t) })} /></td>
                        <td><NumberField style={{ width: 90 }} value={tp.z_mm} fallback={0}
                          onCommit={v => mutate({ testPoints: p.testPoints.map((t, j) => j === i ? { ...t, z_mm: v } : t) })} /></td>
                        <td><button className="small-btn" onClick={() => removeTestPoint(i)}>✕</button></td>
                      </tr>
                    ))}
                    {(!p.testPoints || !p.testPoints.length) && (
                      <tr><td colSpan={3} className="dim" style={{ textAlign: 'center', padding: 8 }}>
                        No test points.
                      </td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Plot(s) */}
            {compute && (
              <div className="prop-plot-wrap" ref={plotWrapRef}>
                {p.splitXY && !p.combinedXY ? (
                  <>
                    <BeamPlot title="x axis"
                      traces={[{ points: compute.trace.traceX, color: '#61afef', label: 'x' }]}
                      events={compute.trace.events}
                      testPoints={p.testPoints ?? []} zTotal={compute.trace.zTotal}
                      width={p.plotWidth} height={p.plotHeight}
                      onResize={(w, h) => mutate({ plotWidth: w, plotHeight: h })}
                      onDragOptic={(id, patch) => mutateOpticById(id, patch)} />
                    <BeamPlot title="y axis"
                      traces={[{ points: compute.trace.traceY, color: '#e06c75', label: 'y' }]}
                      events={compute.trace.events}
                      testPoints={p.testPoints ?? []} zTotal={compute.trace.zTotal}
                      width={p.plotWidth} height={p.plotHeight}
                      onResize={(w, h) => mutate({ plotWidth: w, plotHeight: h })}
                      onDragOptic={(id, patch) => mutateOpticById(id, patch)} />
                  </>
                ) : p.splitXY ? (
                  <BeamPlot
                    traces={[
                      { points: compute.trace.traceX, color: '#61afef', label: 'x' },
                      { points: compute.trace.traceY, color: '#e06c75', label: 'y' },
                    ]}
                    events={compute.trace.events}
                    testPoints={p.testPoints ?? []} zTotal={compute.trace.zTotal}
                    onDragOptic={(id, patch) => mutateOpticById(id, patch)} />
                ) : (
                  <BeamPlot
                    traces={[{ points: compute.trace.traceX, color: '#61afef', label: 'w' }]}
                    events={compute.trace.events}
                    testPoints={p.testPoints ?? []} zTotal={compute.trace.zTotal}
                    onDragOptic={(id, patch) => mutateOpticById(id, patch)} />
                )}
              </div>
            )}

            {/* Parameters table */}
            {compute && (
              <div className="prop-section">
                <div className="prop-section-title">
                  Beam parameters
                  <small style={{ marginLeft: 8, color: 'var(--text-muted)' }}>
                    · w in mm (1/e² radius)
                  </small>
                </div>
                <div className="prop-section-body" style={{ padding: 0 }}>
                  <table className="prop-table">
                    <thead>
                      <tr>
                        <th style={{ paddingLeft: 12 }}>Role</th><th>Label</th><th>z (mm)</th>
                        <th>f (mm)</th>
                        <th>w{p.splitXY ? '_x' : ''} (mm)</th>
                        {p.splitXY && <th>w_y (mm)</th>}
                        <th>Element</th>
                      </tr>
                    </thead>
                    <tbody>
                      {compute.rows
                        .filter(r => !p.hidePassthroughInTable || r.kind !== 'element')
                        .map((r, i) => {
                        // "Role" shows the actual element style when the optic
                        // was imported from a designer path — so mirrors read
                        // "mirror", photodetectors read "photodetector", etc.
                        // Fallback: "lens" / "pass-through" / "test point" for
                        // rows without a designer origin. Cylindrical lenses
                        // get a shape suffix.
                        const shapeSuffix = r.kind === 'lens' && r.shape && r.shape !== 'spherical'
                          ? ` (${r.shape === 'cylX' ? 'cyl. x' : 'cyl. y'})` : ''
                        const roleLabel = r.elementType?.trim()
                          ? r.elementType.trim() + shapeSuffix
                          : (r.kind === 'test' ? 'test point'
                             : r.kind === 'lens' ? 'lens' + shapeSuffix : 'pass-through')
                        return (
                          <tr key={i} className={r.kind === 'element' ? 'passthrough' : ''}>
                            <td style={{ paddingLeft: 12 }}>{roleLabel}</td>
                            <td>{r.label}</td>
                            <td>{r.z_mm.toFixed(1)}</td>
                            <td>{r.kind === 'lens' && Number.isFinite(r.f_mm) && r.f_mm !== 0
                                  ? r.f_mm.toFixed(1) : (r.kind === 'lens' ? '—' : '')}</td>
                            <td>{Number.isFinite(r.wx_mm) ? r.wx_mm.toFixed(4) : '—'}</td>
                            {p.splitXY && <td>{Number.isFinite(r.wy_mm) ? r.wy_mm.toFixed(4) : '—'}</td>}
                            <td className="el-meta">{r.elementLabel ?? ''}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </>
        )}
      </main>

      {importOpen && (
        <ImportGraphModal
          beamPaths={beamPaths}
          elements={elements}
          symbolDefs={symbolDefs}
          onClose={() => setImportOpen(false)}
          onImport={acceptImport}
        />
      )}
    </div>
  )
})
export default BeamPropagationMode
