// Beam Propagation mode — a full-page sandbox for Gaussian beam propagation.
// PROTOTYPE — the physics is real (complex q-parameter, ABCD for thin lenses,
// separate x/y axes with cylindrical support), but the UI is intentionally
// minimal so the piece is easy to iterate on.

import { useMemo, useState } from 'react'
import {
  qFromBeam, sampleWofZ2D, radiusFromQ, propagateFreeSpace, propagateThinLens,
  nmToMm, umToMm, mmToUm, mradToRad,
} from '../utils/gaussian'
import { serializePropagationsCsv } from '../utils/propagationCsv'

const INCH_MM = 25.4
const DEFAULT_LAMBDA_NM = 1064
const DEFAULT_W0_UM = 250

// ── Default new propagation ────────────────────────────────────────────────
function makeDefaultPropagation(name = 'New propagation') {
  return {
    id: crypto.randomUUID(),
    name,
    splitXY: false,
    wavelength_nm: DEFAULT_LAMBDA_NM,
    distance_mm: 500,
    w0x_um: DEFAULT_W0_UM, divx_mrad: 0,
    w0y_um: DEFAULT_W0_UM, divy_mrad: 0,
    optics: [],           // [{id, kind:'lens', z_mm, f_mm, shape:'spherical'|'cylX'|'cylY', label, elementLabel?}]
    testPoints: [],       // [{id, z_mm, label}]
    source: null,         // { pathName, nodes: [labels], distances_mm: [between consecutive] }
  }
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
function ImportGraphModal({ beamPaths, elements, onClose, onImport }) {
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
        ) : (
          <>
            <p style={{ color: 'var(--text-muted)', fontSize: 11, margin: '4px 0' }}>
              {srcLabel
                ? (dstLabel
                    ? `Start: ${srcLabel} · End: ${dstLabel}`
                    : `Start: ${srcLabel} — click end node`)
                : 'Click a node to set the start, then another to set the end.'}
            </p>
            <svg width={W} height={H} style={{ background: 'var(--bg-item)', border: '1px solid var(--border-side)', borderRadius: 3 }}>
              {/* edges as arrows */}
              <defs>
                <marker id="imp-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                  <path d="M0,0 L10,5 L0,10 Z" fill="var(--text-muted)" />
                </marker>
              </defs>
              {edges.map(([a, b], i) => {
                const A = positions.map[a], B = positions.map[b]
                if (!A || !B) return null
                return (
                  <line key={i} x1={sx(A.x)} y1={sy(A.y)} x2={sx(B.x)} y2={sy(B.y)}
                    stroke="var(--text-muted)" strokeWidth={1.2} markerEnd="url(#imp-arrow)" opacity={0.7} />
                )
              })}
              {/* nodes */}
              {nodes.map(l => {
                const P = positions.map[l]
                if (!P) return null
                const isSrc = l === srcLabel, isDst = l === dstLabel
                return (
                  <g key={l} style={{ cursor: 'pointer' }} onClick={() => handleNodeClick(l)}>
                    <circle cx={sx(P.x)} cy={sy(P.y)} r={9}
                      fill={isSrc ? '#4a9fff' : isDst ? '#e0b040' : 'var(--bg-input)'}
                      stroke={isSrc || isDst ? '#111' : 'var(--text)'} strokeWidth={1.4} />
                    <text x={sx(P.x)} y={sy(P.y) - 12} textAnchor="middle" fontSize={11}
                      fill="var(--text)">{l}</text>
                  </g>
                )
              })}
            </svg>

            {candidatePaths && (
              <div style={{ marginTop: 8 }}>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>
                  {candidatePaths.length} paths from {srcLabel} to {dstLabel} — pick one:
                </div>
                <ul style={{ listStyle: 'none', padding: 0, maxHeight: 140, overflow: 'auto' }}>
                  {candidatePaths.map((p, i) => (
                    <li key={i} style={{ padding: 4, borderBottom: '1px solid var(--border-side)' }}>
                      <button className="small-btn" onClick={() => finish(p)}>Import</button>
                      <span style={{ marginLeft: 8, fontFamily: 'monospace' }}>{p.join(' → ')}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}

        <div style={{ marginTop: 8, textAlign: 'right' }}>
          <button className="small-btn" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  )
}

// ── Plot (one axis) ────────────────────────────────────────────────────────
function AxisPlot({ trace, events, testPoints, zTotal, color, label, height = 200 }) {
  const W = 640, H = height, PAD_L = 46, PAD_R = 12, PAD_T = 14, PAD_B = 30
  const plotW = W - PAD_L - PAD_R, plotH = H - PAD_T - PAD_B
  const maxW = Math.max(0.01, ...trace.map(p => p.w_mm).filter(Number.isFinite))
  const xOf = z => PAD_L + (z / Math.max(1e-6, zTotal)) * plotW
  const yOf = w => PAD_T + plotH - (w / maxW) * plotH
  const linePath = trace.map((p, i) =>
    `${i ? 'L' : 'M'}${xOf(p.z_mm).toFixed(2)},${yOf(p.w_mm).toFixed(2)}`).join(' ')

  return (
    <svg width={W} height={H} style={{ background: 'var(--bg-item)', border: '1px solid var(--border-side)', borderRadius: 3 }}>
      <text x={PAD_L + 4} y={PAD_T + 12} fontSize={11} fill="var(--text-muted)">{label}</text>
      <line x1={PAD_L} y1={PAD_T + plotH} x2={PAD_L + plotW} y2={PAD_T + plotH} stroke="var(--text-muted)" />
      <line x1={PAD_L} y1={PAD_T} x2={PAD_L} y2={PAD_T + plotH} stroke="var(--text-muted)" />
      {[0, 0.25, 0.5, 0.75, 1].map(f => {
        const w = f * maxW
        return (
          <g key={`y${f}`}>
            <line x1={PAD_L - 3} y1={yOf(w)} x2={PAD_L} y2={yOf(w)} stroke="var(--text-muted)" />
            <text x={PAD_L - 5} y={yOf(w)} textAnchor="end" dominantBaseline="middle"
              fontSize={10} fill="var(--text-muted)">{w.toFixed(2)}</text>
          </g>
        )
      })}
      {[0, 0.25, 0.5, 0.75, 1].map(f => {
        const z = f * zTotal
        return (
          <g key={`x${f}`}>
            <line x1={xOf(z)} y1={PAD_T + plotH} x2={xOf(z)} y2={PAD_T + plotH + 3} stroke="var(--text-muted)" />
            <text x={xOf(z)} y={PAD_T + plotH + 14} textAnchor="middle"
              fontSize={10} fill="var(--text-muted)">{z.toFixed(0)}</text>
          </g>
        )
      })}
      <text x={PAD_L + plotW / 2} y={H - 3} textAnchor="middle" fontSize={11} fill="var(--text-muted)">z (mm)</text>
      <text x={12} y={PAD_T + plotH / 2} textAnchor="middle" fontSize={11} fill="var(--text-muted)"
        transform={`rotate(-90 12 ${PAD_T + plotH / 2})`}>w (mm)</text>

      {events.map((ev, i) => (
        <g key={`e${i}`}>
          <line x1={xOf(ev.z_mm)} y1={PAD_T} x2={xOf(ev.z_mm)} y2={PAD_T + plotH}
            stroke="#e0b040" strokeDasharray="3 3" strokeWidth={1} opacity={0.7} />
          <text x={xOf(ev.z_mm)} y={PAD_T - 2} textAnchor="middle" fontSize={10}
            fill="#e0b040">{ev.elementLabel ?? ev.label ?? 'L'}{ev.shape && ev.shape !== 'spherical' ? ` (${ev.shape})` : ''}</text>
        </g>
      ))}
      {testPoints.map((tp, i) => (
        <g key={`t${i}`}>
          <line x1={xOf(tp.z_mm)} y1={PAD_T} x2={xOf(tp.z_mm)} y2={PAD_T + plotH}
            stroke="#5cc46a" strokeDasharray="2 4" strokeWidth={1} opacity={0.7} />
          <text x={xOf(tp.z_mm)} y={PAD_T + plotH + 26} textAnchor="middle" fontSize={10}
            fill="#5cc46a">{tp.label ?? `t${i + 1}`}</text>
        </g>
      ))}

      <path d={linePath} fill="none" stroke={color} strokeWidth={1.6} />
    </svg>
  )
}

// ── Main mode component ────────────────────────────────────────────────────
export default function BeamPropagationMode({
  propagations, activePropagation,
  onSetPropagations, onSetActivePropagation, onExit,
  beamPaths, elements,
}) {
  const [importOpen, setImportOpen] = useState(false)
  const [renamingId, setRenamingId] = useState(null)
  const [renameVal, setRenameVal]   = useState('')

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
    // f_mm defaults to element's f_mm if present, else 0 (identity, "not a lens").
    const elById = {}; elements.forEach(e => { elById[e.label] = e })
    const optics = []
    let z = 0
    for (let i = 0; i < nodes.length; i++) {
      if (i > 0) z += distances_mm[i - 1]
      const el = elById[nodes[i]]
      const fFromEl = Number(el?.f_mm)
      optics.push({
        id: crypto.randomUUID(),
        kind: 'lens',
        z_mm: z,
        f_mm: Number.isFinite(fFromEl) ? fFromEl : 0,
        shape: 'spherical',
        label: nodes[i],
        elementLabel: nodes[i],
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
    const w0x = umToMm(p.w0x_um)
    const w0y = umToMm(p.splitXY ? p.w0y_um : p.w0x_um)
    const divx = mradToRad(p.divx_mrad)
    const divy = mradToRad(p.splitXY ? p.divy_mrad : p.divx_mrad)
    const qx0 = qFromBeam(w0x, divx, lambda_mm)
    const qy0 = qFromBeam(w0y, divy, lambda_mm)

    // Sort optics by z, keep those inside [0, distance_mm].
    const optics = [...(p.optics ?? [])]
      .filter(o => o.z_mm >= 0 && o.z_mm <= p.distance_mm)
      .sort((a, b) => a.z_mm - b.z_mm)

    // Steps: alternating free-space + lens.
    const steps = []
    let cursor = 0
    for (const o of optics) {
      if (o.z_mm > cursor) steps.push({ kind: 'space', L: o.z_mm - cursor })
      steps.push({ kind: 'lens', f: o.f_mm, shape: o.shape ?? 'spherical', label: o.label, elementLabel: o.elementLabel })
      cursor = o.z_mm
    }
    if (p.distance_mm > cursor) steps.push({ kind: 'space', L: p.distance_mm - cursor })

    const trace = sampleWofZ2D(steps, qx0, qy0, lambda_mm)

    // Per-optic + per-test-point q sampling (independent replay for accuracy).
    function beamAt(z_mm) {
      let qx = qx0, qy = qy0, z = 0
      for (const o of optics) {
        if (o.z_mm > z_mm) break
        const dz = o.z_mm - z
        qx = propagateFreeSpace(qx, dz); qy = propagateFreeSpace(qy, dz); z += dz
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
      return { kind: 'optic', label: o.label, elementLabel: o.elementLabel, z_mm: o.z_mm,
               f_mm: o.f_mm, shape: o.shape ?? 'spherical', ...b }
    })
    const tpRows = (p.testPoints ?? []).map(tp => ({
      kind: 'test', label: tp.label, z_mm: tp.z_mm, ...beamAt(tp.z_mm),
    }))
    const rows = [...opticRows, ...tpRows].sort((a, b) => a.z_mm - b.z_mm)
    return { trace, rows, optics }
  }, [p])

  function downloadPropagationsCsv() {
    const text = serializePropagationsCsv(propagations)
    const blob = new Blob([text], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url; a.download = 'propagations.csv'; a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', background: 'var(--bg)', overflow: 'hidden' }}>
      {/* ── Left column: propagations list ── */}
      <aside style={{ width: 220, borderRight: '1px solid var(--border-side)', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: 8, display: 'flex', gap: 4, alignItems: 'center' }}>
          <button className="file-btn" onClick={onExit}>← Designer</button>
        </div>
        <div style={{ padding: 8, display: 'flex', gap: 4 }}>
          <button className="small-btn" style={{ flex: 1 }} onClick={newPropagation}>+ New</button>
          <button className="small-btn" onClick={() => setImportOpen(true)} title="Import from beam path"
            disabled={!Object.keys(beamPaths ?? {}).length}>Import…</button>
        </div>
        <ul style={{ listStyle: 'none', padding: 0, margin: 0, overflowY: 'auto', flex: 1 }}>
          {ids.map(id => {
            const item = propagations[id]
            const active = id === activeId
            return (
              <li key={id} style={{ padding: 4, display: 'flex', alignItems: 'center', gap: 4,
                background: active ? 'var(--accent-soft, #234)' : undefined }}>
                {renamingId === id ? (
                  <input className="snap-input" style={{ flex: 1 }} value={renameVal}
                    autoFocus onChange={e => setRenameVal(e.target.value)}
                    onBlur={() => { onSetPropagations({ ...propagations, [id]: { ...propagations[id], name: renameVal.trim() || propagations[id].name } }); setRenamingId(null) }}
                    onKeyDown={e => { if (e.key === 'Enter') e.target.blur(); if (e.key === 'Escape') setRenamingId(null) }} />
                ) : (
                  <button className="path-item-name" style={{ flex: 1, textAlign: 'left', background: 'none', border: 'none', color: 'inherit', cursor: 'pointer' }}
                    onClick={() => setActive(id)}
                    onDoubleClick={() => { setRenamingId(id); setRenameVal(item.name) }}>
                    {item.name}
                  </button>
                )}
                <button className="small-btn" title="Rename"
                  onClick={() => { setRenamingId(id); setRenameVal(item.name) }}>✎</button>
                <button className="small-btn" title="Delete"
                  onClick={() => deletePropagation(id)}>✕</button>
              </li>
            )
          })}
          {ids.length === 0 && (
            <li style={{ padding: 8, color: 'var(--text-muted)', fontSize: 11 }}>No propagations yet.</li>
          )}
        </ul>
        <div style={{ padding: 8 }}>
          <button className="small-btn" style={{ width: '100%' }} onClick={downloadPropagationsCsv}
            disabled={!ids.length}>Download propagations.csv</button>
        </div>
      </aside>

      {/* ── Main area ── */}
      <main style={{ flex: 1, overflow: 'auto', padding: 12 }}>
        {!p ? (
          <p style={{ color: 'var(--text-muted)' }}>Create a new propagation or import from a beam path.</p>
        ) : (
          <>
            {/* Header row */}
            <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
              <input className="snap-input" style={{ fontSize: 15, minWidth: 200 }}
                value={p.name} onChange={e => mutate({ name: e.target.value })} />
              <label><input type="checkbox" checked={p.splitXY}
                onChange={e => mutate({ splitXY: e.target.checked })} /> Split x/y</label>
              <label>λ (nm) <input className="snap-input" type="number" style={{ width: 80 }}
                value={p.wavelength_nm}
                onChange={e => mutate({ wavelength_nm: parseFloat(e.target.value) || 1064 })} /></label>
              <label>Distance (mm) <input className="snap-input" type="number" style={{ width: 90 }}
                value={p.distance_mm}
                onChange={e => mutate({ distance_mm: parseFloat(e.target.value) || 500 })} /></label>
              {p.source && (
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                  Imported from: {p.source.pathName}
                </span>
              )}
            </div>

            {/* Initial beam */}
            <fieldset style={{ marginTop: 10 }}>
              <legend style={{ fontSize: 11, color: 'var(--text-muted)' }}>Initial beam at z = 0</legend>
              <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                <label>w₀{p.splitXY ? ' (x)' : ''} (µm) <input className="snap-input" type="number" style={{ width: 80 }}
                  value={p.w0x_um} onChange={e => mutate({ w0x_um: parseFloat(e.target.value) || 1 })} /></label>
                <label>div{p.splitXY ? ' (x)' : ''} (mrad) <input className="snap-input" type="number" step="0.1" style={{ width: 80 }}
                  value={p.divx_mrad} onChange={e => mutate({ divx_mrad: parseFloat(e.target.value) || 0 })} /></label>
                {p.splitXY && (
                  <>
                    <label>w₀ (y) (µm) <input className="snap-input" type="number" style={{ width: 80 }}
                      value={p.w0y_um} onChange={e => mutate({ w0y_um: parseFloat(e.target.value) || 1 })} /></label>
                    <label>div (y) (mrad) <input className="snap-input" type="number" step="0.1" style={{ width: 80 }}
                      value={p.divy_mrad} onChange={e => mutate({ divy_mrad: parseFloat(e.target.value) || 0 })} /></label>
                  </>
                )}
              </div>
            </fieldset>

            {/* Optics list */}
            <fieldset style={{ marginTop: 10 }}>
              <legend style={{ fontSize: 11, color: 'var(--text-muted)' }}>Optics</legend>
              <button className="small-btn" onClick={addOptic}>+ Add optic</button>
              <table style={{ width: '100%', fontSize: 11, marginTop: 6, borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ color: 'var(--text-muted)', textAlign: 'left' }}>
                    <th>Label</th><th>z (mm)</th><th>f (mm)</th><th>Shape</th><th>Element</th><th></th>
                  </tr>
                </thead>
                <tbody>
                  {(p.optics ?? []).map((o, i) => (
                    <tr key={o.id} style={{ borderTop: '1px solid var(--border-side)' }}>
                      <td><input className="snap-input" style={{ width: 70 }}
                        value={o.label} onChange={e => mutateOptic(i, { label: e.target.value })} /></td>
                      <td><input className="snap-input" type="number" style={{ width: 80 }}
                        value={o.z_mm} onChange={e => mutateOptic(i, { z_mm: parseFloat(e.target.value) || 0 })} /></td>
                      <td><input className="snap-input" type="number" style={{ width: 80 }}
                        value={o.f_mm} onChange={e => mutateOptic(i, { f_mm: parseFloat(e.target.value) || 0 })} /></td>
                      <td>
                        <select className="snap-input" value={o.shape ?? 'spherical'}
                          onChange={e => mutateOptic(i, { shape: e.target.value })}
                          disabled={!p.splitXY && (o.shape === 'spherical' || !o.shape)}>
                          <option value="spherical">Spherical</option>
                          <option value="cylX" disabled={!p.splitXY}>Cyl. x</option>
                          <option value="cylY" disabled={!p.splitXY}>Cyl. y</option>
                        </select>
                      </td>
                      <td style={{ color: 'var(--text-muted)', fontSize: 10 }}>{o.elementLabel ?? ''}</td>
                      <td><button className="small-btn" onClick={() => removeOptic(i)}>✕</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </fieldset>

            {/* Test points */}
            <fieldset style={{ marginTop: 10 }}>
              <legend style={{ fontSize: 11, color: 'var(--text-muted)' }}>Test points</legend>
              <button className="small-btn" onClick={addTestPoint}>+ Add test point</button>
              <table style={{ width: '100%', fontSize: 11, marginTop: 6, borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ color: 'var(--text-muted)', textAlign: 'left' }}>
                    <th>Label</th><th>z (mm)</th><th></th>
                  </tr>
                </thead>
                <tbody>
                  {(p.testPoints ?? []).map((tp, i) => (
                    <tr key={tp.id} style={{ borderTop: '1px solid var(--border-side)' }}>
                      <td><input className="snap-input" style={{ width: 100 }}
                        value={tp.label} onChange={e => mutate({ testPoints: p.testPoints.map((t, j) => j === i ? { ...t, label: e.target.value } : t) })} /></td>
                      <td><input className="snap-input" type="number" style={{ width: 80 }}
                        value={tp.z_mm} onChange={e => mutate({ testPoints: p.testPoints.map((t, j) => j === i ? { ...t, z_mm: parseFloat(e.target.value) || 0 } : t) })} /></td>
                      <td><button className="small-btn" onClick={() => removeTestPoint(i)}>✕</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </fieldset>

            {/* Plots */}
            {compute && (
              <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
                {p.splitXY ? (
                  <>
                    <AxisPlot trace={compute.trace.traceX} events={compute.trace.events}
                      testPoints={p.testPoints ?? []} zTotal={compute.trace.zTotal}
                      color="#61afef" label="x axis" />
                    <AxisPlot trace={compute.trace.traceY} events={compute.trace.events}
                      testPoints={p.testPoints ?? []} zTotal={compute.trace.zTotal}
                      color="#e06c75" label="y axis" />
                  </>
                ) : (
                  <AxisPlot trace={compute.trace.traceX} events={compute.trace.events}
                    testPoints={p.testPoints ?? []} zTotal={compute.trace.zTotal}
                    color={'#61afef'} label="beam radius" />
                )}
              </div>
            )}

            {/* Parameters table */}
            {compute && (
              <table style={{ marginTop: 10, width: '100%', fontSize: 11, borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ color: 'var(--text-muted)', textAlign: 'left' }}>
                    <th>Kind</th><th>Label</th><th>z (mm)</th>
                    <th>w{p.splitXY ? '_x' : ''} (µm)</th>
                    {p.splitXY && <th>w_y (µm)</th>}
                    <th>Element</th>
                  </tr>
                </thead>
                <tbody>
                  {compute.rows.map((r, i) => (
                    <tr key={i} style={{ borderTop: '1px solid var(--border-side)' }}>
                      <td>{r.kind}</td>
                      <td>{r.label}</td>
                      <td>{r.z_mm.toFixed(1)}</td>
                      <td>{Number.isFinite(r.wx_mm) ? mmToUm(r.wx_mm).toFixed(1) : '—'}</td>
                      {p.splitXY && <td>{Number.isFinite(r.wy_mm) ? mmToUm(r.wy_mm).toFixed(1) : '—'}</td>}
                      <td style={{ color: 'var(--text-muted)' }}>{r.elementLabel ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
      </main>

      {importOpen && (
        <ImportGraphModal
          beamPaths={beamPaths}
          elements={elements}
          onClose={() => setImportOpen(false)}
          onImport={acceptImport}
        />
      )}
    </div>
  )
}
