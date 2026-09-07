// Beam Propagation mode — a full-page sandbox for Gaussian beam propagation.
// PROTOTYPE — the physics is real (complex q-parameter, ABCD for thin lenses,
// separate x/y axes with cylindrical support), but the UI is intentionally
// minimal so the piece is easy to iterate on.

import { useMemo, useState, useRef } from 'react'
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
  return out
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
function BeamPlot({ traces, events, testPoints, zTotal, height = 220, title }) {
  const W = 720, H = height, PAD_L = 52, PAD_R = 16, PAD_T = 26, PAD_B = 34
  const plotW = W - PAD_L - PAD_R, plotH = H - PAD_T - PAD_B
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
    <svg className="prop-plot" width={W} height={H}>
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

      {/* y ticks */}
      {[0, 0.25, 0.5, 0.75, 1].map(f => {
        const w = f * maxW
        return (
          <g key={`y${f}`}>
            <line x1={PAD_L - 3} y1={yOf(w)} x2={PAD_L} y2={yOf(w)} stroke="var(--text-muted)" />
            <text x={PAD_L - 6} y={yOf(w)} textAnchor="end" dominantBaseline="middle"
              fontSize={10} fill="var(--text-muted)">{w.toFixed(2)}</text>
          </g>
        )
      })}
      {/* x ticks */}
      {[0, 0.25, 0.5, 0.75, 1].map(f => {
        const z = f * zTotal
        return (
          <g key={`x${f}`}>
            <line x1={xOf(z)} y1={PAD_T + plotH} x2={xOf(z)} y2={PAD_T + plotH + 3} stroke="var(--text-muted)" />
            <text x={xOf(z)} y={PAD_T + plotH + 15} textAnchor="middle"
              fontSize={10} fill="var(--text-muted)">{z.toFixed(0)}</text>
          </g>
        )
      })}
      <text x={PAD_L + plotW / 2} y={H - 6} textAnchor="middle" fontSize={11} fill="var(--text-muted)">z (mm)</text>
      <text x={14} y={PAD_T + plotH / 2} textAnchor="middle" fontSize={11} fill="var(--text-muted)"
        transform={`rotate(-90 14 ${PAD_T + plotH / 2})`}>w (mm, radius)</text>

      {/* Optic markers + icons */}
      {events.map((ev, i) => {
        const isLens = ev.kind === 'lens'
        const isNegative = isLens && Number(ev.f) < 0
        const cx = xOf(ev.z_mm)
        const labelText = `${ev.elementLabel ?? ev.label ?? 'L'}${
          isLens && ev.shape && ev.shape !== 'spherical' ? ` (${ev.shape})` : ''
        }${isLens && Number.isFinite(ev.f) && ev.f !== 0 ? `  f=${ev.f}mm` : ''}`
        const stroke = isLens ? '#e0b040' : 'var(--text-muted)'
        return (
          <g key={`e${i}`}>
            <line x1={cx} y1={PAD_T + LENS_H + 4} x2={cx} y2={PAD_T + plotH}
              stroke={stroke} strokeDasharray="4 3" strokeWidth={1}
              opacity={isLens ? 0.6 : 0.3} />
            {isLens && !isNegative ? (
              // Real biconvex lens SVG from the component library, sized to fit.
              <image href="/symbols/b-lens1.svg"
                x={cx - LENS_W / 2} y={iconTop}
                width={LENS_W} height={LENS_H}
                preserveAspectRatio="xMidYMid meet" />
            ) : isLens ? (
              // Biconcave glyph for negative f — inverse arcs.
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
            <text x={cx} y={iconTop - 4} textAnchor="middle" fontSize={10}
              fill={stroke}>{labelText}</text>
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
    </svg>
  )
}

// ── Main mode component ────────────────────────────────────────────────────
export default function BeamPropagationMode({
  propagations: propagationsRaw, activePropagation,
  onSetPropagations, onSetActivePropagation, onExit,
  beamPaths, elements, symbolDefs,
}) {
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

  function setActive(id) { onSetActivePropagation(id) }
  function mutate(patch) {
    if (!p) return
    onSetPropagations({ ...propagations, [p.id]: { ...p, ...patch } })
  }
  function mutateOptic(idx, patch) {
    if (!p) return
    const optics = p.optics.map((o, i) => i === idx ? { ...o, ...patch } : o)
    mutate({ optics })
  }
  function addOptic() {
    const optic = { id: crypto.randomUUID(), kind: 'lens', z_mm: 0, f_mm: 100, shape: 'spherical', label: 'L' + ((p?.optics?.length ?? 0) + 1) }
    mutate({ optics: [...(p?.optics ?? []), optic] })
  }
  function removeOptic(idx) {
    mutate({ optics: p.optics.filter((_, i) => i !== idx) })
  }
  function addTestPoint() {
    const tp = { id: crypto.randomUUID(), z_mm: 0, label: 't' + ((p?.testPoints?.length ?? 0) + 1) }
    mutate({ testPoints: [...(p?.testPoints ?? []), tp] })
  }
  function removeTestPoint(idx) {
    mutate({ testPoints: p.testPoints.filter((_, i) => i !== idx) })
  }
  function newPropagation() {
    const np = makeDefaultPropagation(`Propagation ${ids.length + 1}`)
    onSetPropagations({ ...propagations, [np.id]: np })
    setActive(np.id)
  }
  function deletePropagation(id) {
    const { [id]: _drop, ...rest } = propagations
    onSetPropagations(rest)
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
      const fFromEl = Number(el?.f_mm)
      optics.push({
        id: crypto.randomUUID(),
        kind: isLens ? 'lens' : 'passthrough',
        z_mm: z,
        f_mm: Number.isFinite(fFromEl) ? fFromEl : 0,
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
    onSetPropagations({ ...propagations, [np.id]: np })
    setActive(np.id)
    setImportOpen(false)
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
    // passthrough — gets a marker at its z.
    const events = optics.map(o => ({
      z_mm: o.z_mm,
      kind: o.kind,       // 'lens' | 'passthrough'
      label: o.label,
      elementLabel: o.elementLabel,
      f: o.f_mm,
      shape: o.shape ?? 'spherical',
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
                    onBlur={() => { onSetPropagations({ ...propagations, [id]: { ...propagations[id], name: renameVal.trim() || propagations[id].name } }); setRenamingId(null) }}
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
              <label className="prop-field">λ (nm)
                <NumberField style={{ width: 80 }} value={p.wavelength_nm} fallback={1064}
                  onCommit={v => mutate({ wavelength_nm: v })} /></label>
              <label className="prop-field">Distance (mm)
                <NumberField style={{ width: 90 }} value={p.distance_mm} fallback={500}
                  onCommit={v => mutate({ distance_mm: v })} /></label>
              {p.source && (<span className="prop-source">Imported from {p.source.pathName}</span>)}
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
                      <th>Kind</th><th>Label</th><th>z (mm)</th><th>f (mm)</th>
                      <th>Shape</th><th>Element</th><th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleOptics.map(([o, i]) => {
                      const isLens = o.kind === 'lens'
                      return (
                        <tr key={o.id} className={isLens ? '' : 'passthrough'}>
                          <td>
                            <select className="snap-input" value={o.kind}
                              onChange={e => mutateOptic(i, { kind: e.target.value })}>
                              <option value="lens">Lens</option>
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
                          <td>{isLens ? (
                            <select className="snap-input" value={o.shape ?? 'spherical'}
                              onChange={e => mutateOptic(i, { shape: e.target.value })}>
                              <option value="spherical">Spherical</option>
                              <option value="cylX" disabled={!p.splitXY}>Cyl. x</option>
                              <option value="cylY" disabled={!p.splitXY}>Cyl. y</option>
                            </select>
                          ) : <span className="dim">—</span>}</td>
                          <td className="el-meta">
                            {o.elementLabel ?? ''}{o.elementType ? ` · ${o.elementType}` : ''}
                          </td>
                          <td><button className="small-btn" onClick={() => removeOptic(i)}>✕</button></td>
                        </tr>
                      )
                    })}
                    {(!p.optics || !p.optics.length) && (
                      <tr><td colSpan={7} className="dim" style={{ textAlign: 'center', padding: 8 }}>
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
              <div className="prop-plot-wrap">
                {p.splitXY && !p.combinedXY ? (
                  <>
                    <BeamPlot title="x axis"
                      traces={[{ points: compute.trace.traceX, color: '#61afef', label: 'x' }]}
                      events={compute.trace.events}
                      testPoints={p.testPoints ?? []} zTotal={compute.trace.zTotal} />
                    <BeamPlot title="y axis"
                      traces={[{ points: compute.trace.traceY, color: '#e06c75', label: 'y' }]}
                      events={compute.trace.events}
                      testPoints={p.testPoints ?? []} zTotal={compute.trace.zTotal} />
                  </>
                ) : p.splitXY ? (
                  <BeamPlot
                    traces={[
                      { points: compute.trace.traceX, color: '#61afef', label: 'x' },
                      { points: compute.trace.traceY, color: '#e06c75', label: 'y' },
                    ]}
                    events={compute.trace.events}
                    testPoints={p.testPoints ?? []} zTotal={compute.trace.zTotal} />
                ) : (
                  <BeamPlot
                    traces={[{ points: compute.trace.traceX, color: '#61afef', label: 'w' }]}
                    events={compute.trace.events}
                    testPoints={p.testPoints ?? []} zTotal={compute.trace.zTotal} />
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
                        <th style={{ paddingLeft: 12 }}>Kind</th><th>Label</th><th>z (mm)</th>
                        <th>w{p.splitXY ? '_x' : ''} (mm)</th>
                        {p.splitXY && <th>w_y (mm)</th>}
                        <th>Element</th>
                      </tr>
                    </thead>
                    <tbody>
                      {compute.rows.map((r, i) => {
                        // "Kind" shows the actual element style when the optic
                        // was imported from a designer path — so mirrors read
                        // "mirror", photodetectors read "photodetector", etc.
                        // Fallback: "lens" / "pass-through" / "test point" for
                        // rows without a designer origin.
                        const kindLabel = r.elementType?.trim()
                          ? r.elementType.trim()
                          : (r.kind === 'test' ? 'test point'
                             : r.kind === 'lens' ? 'lens' : 'pass-through')
                        return (
                          <tr key={i} className={r.kind === 'element' ? 'passthrough' : ''}>
                            <td style={{ paddingLeft: 12 }}>{kindLabel}</td>
                            <td>{r.label}</td>
                            <td>{r.z_mm.toFixed(1)}</td>
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
}
