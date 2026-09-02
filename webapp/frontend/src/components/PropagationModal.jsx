// Gaussian beam propagation viewer for a single beam path.
// PROTOTYPE — plumbing and physics; UI is minimal and unstyled.
//
// The modal walks the selected path (start-index → end-index across the
// path's edges), turns element positions into free-space segments in mm,
// applies a thin-lens step at each element with a numeric focal length,
// and plots w(z) alongside a table of q, w, R at each element.

import { useMemo, useState, useEffect } from 'react'
import {
  qFromWaist, sampleWofZ, radiusFromQ, curvatureRadiusFromQ,
  nmToMm, umToMm,
} from '../utils/gaussian'

const INCH_MM = 25.4

// Build the ordered list of element labels traversed by a path's edges.
// Consecutive edges are assumed contiguous: [A,B], [B,C], [C,D] → [A,B,C,D].
function pathOrder(edges) {
  if (!edges?.length) return []
  const out = [edges[0][0]]
  for (const [, dest] of edges) out.push(dest)
  return out
}

// distance between two elements in inches
function distIn(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y
  return Math.sqrt(dx * dx + dy * dy)
}

export default function PropagationModal({
  pathName, path, elements, onClose, onUpdatePath, onUpdateElement,
}) {
  const order = useMemo(() => pathOrder(path?.edges ?? []), [path])
  const elById = useMemo(() => {
    const m = {}; (elements ?? []).forEach(e => { m[e.label] = e }); return m
  }, [elements])
  const orderedEls = order.map(l => elById[l]).filter(Boolean)

  const [startIdx, setStartIdx] = useState(0)
  const [endIdx,   setEndIdx]   = useState(Math.max(0, orderedEls.length - 1))
  useEffect(() => { setEndIdx(Math.max(0, orderedEls.length - 1)) }, [orderedEls.length])

  const wavelength = path?.wavelength_nm ?? 1064
  const w0 = path?.w0_um ?? 250

  const subEls = orderedEls.slice(startIdx, endIdx + 1)

  // Turn the sub-path into propagation steps.
  const steps = useMemo(() => {
    const s = []
    for (let i = 0; i < subEls.length; i++) {
      const el = subEls[i]
      if (i > 0) {
        const L = distIn(el, subEls[i - 1]) * INCH_MM
        s.push({ kind: 'space', L, label: `${subEls[i - 1].label}→${el.label}` })
      }
      const f = Number(el.f_mm)
      if (Number.isFinite(f) && f !== 0) {
        s.push({ kind: 'lens', f, elementLabel: el.label, label: `lens f=${f}mm` })
      }
    }
    return s
  }, [subEls])

  const lambda_mm = nmToMm(wavelength)
  const w0_mm = umToMm(w0)
  const q0 = qFromWaist(w0_mm, lambda_mm)
  const { trace, events, zTotal } = useMemo(
    () => sampleWofZ(steps, q0, lambda_mm),
    [steps, q0.im, lambda_mm],
  )

  // Plot dims
  const W = 640, H = 260, PAD_L = 44, PAD_R = 14, PAD_T = 14, PAD_B = 32
  const plotW = W - PAD_L - PAD_R
  const plotH = H - PAD_T - PAD_B
  const maxW_mm = Math.max(0.01, ...trace.map(p => p.w_mm).filter(Number.isFinite))
  const xOf = z => PAD_L + (z / Math.max(1e-6, zTotal)) * plotW
  const yOf = w => PAD_T + plotH - (w / maxW_mm) * plotH
  const linePath = trace.map((p, i) => `${i ? 'L' : 'M'}${xOf(p.z_mm).toFixed(2)},${yOf(p.w_mm).toFixed(2)}`).join(' ')

  // Sample q at each element in the sub-path for a small table.
  const perElement = useMemo(() => {
    const rows = []
    let z = 0, q = q0
    for (let i = 0; i < subEls.length; i++) {
      const el = subEls[i]
      if (i > 0) {
        const L = distIn(el, subEls[i - 1]) * INCH_MM
        q = { re: q.re + L, im: q.im }
        z += L
      }
      const w = radiusFromQ(q, lambda_mm)
      const R = curvatureRadiusFromQ(q)
      rows.push({ label: el.label, z_mm: z, w_mm: w, R_mm: R, f: el.f_mm ?? '' })
      const f = Number(el.f_mm)
      if (Number.isFinite(f) && f !== 0) {
        const invQ = { re: 1 / (q.re * q.re + q.im * q.im) * q.re, im: -q.im / (q.re * q.re + q.im * q.im) }
        const newInv = { re: invQ.re - 1 / f, im: invQ.im }
        const d = newInv.re * newInv.re + newInv.im * newInv.im
        q = { re: newInv.re / d, im: -newInv.im / d }
      }
    }
    return rows
  }, [subEls, q0.im, lambda_mm])

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-box modal-box-wide" onClick={e => e.stopPropagation()}
        style={{ maxWidth: 760 }}>
        <div className="modal-title">Beam propagation — {pathName}</div>

        {orderedEls.length < 2 ? (
          <p style={{ color: 'var(--text-muted)' }}>
            Need at least two connected elements on the path.
          </p>
        ) : (
          <>
            {/* Path inputs */}
            <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr auto 1fr', gap: 6, alignItems: 'center', margin: '6px 0' }}>
              <label>λ (nm)</label>
              <input className="snap-input" type="number" step="1" min="1"
                value={wavelength}
                onChange={e => onUpdatePath(pathName, { wavelength_nm: parseFloat(e.target.value) || 1064 })} />
              <label>w₀ (µm)</label>
              <input className="snap-input" type="number" step="10" min="1"
                value={w0}
                onChange={e => onUpdatePath(pathName, { w0_um: parseFloat(e.target.value) || 250 })} />
              <label>Start</label>
              <select className="snap-input" value={startIdx}
                onChange={e => setStartIdx(Math.min(parseInt(e.target.value, 10), endIdx))}>
                {orderedEls.map((el, i) => <option key={i} value={i}>{el.label}</option>)}
              </select>
              <label>End</label>
              <select className="snap-input" value={endIdx}
                onChange={e => setEndIdx(Math.max(parseInt(e.target.value, 10), startIdx))}>
                {orderedEls.map((el, i) => <option key={i} value={i}>{el.label}</option>)}
              </select>
            </div>

            {/* Plot */}
            <svg width={W} height={H} style={{ background: 'var(--bg-item)', border: '1px solid var(--border-side)', borderRadius: 3 }}>
              {/* axes */}
              <line x1={PAD_L} y1={PAD_T + plotH} x2={PAD_L + plotW} y2={PAD_T + plotH} stroke="var(--text-muted)" />
              <line x1={PAD_L} y1={PAD_T} x2={PAD_L} y2={PAD_T + plotH} stroke="var(--text-muted)" />
              {/* y ticks */}
              {[0, 0.25, 0.5, 0.75, 1].map(f => {
                const w = f * maxW_mm
                return (
                  <g key={f}>
                    <line x1={PAD_L - 3} y1={yOf(w)} x2={PAD_L} y2={yOf(w)} stroke="var(--text-muted)" />
                    <text x={PAD_L - 5} y={yOf(w)} textAnchor="end" dominantBaseline="middle"
                      fontSize={10} fill="var(--text-muted)">{w.toFixed(2)}</text>
                  </g>
                )
              })}
              {/* x ticks */}
              {[0, 0.25, 0.5, 0.75, 1].map(f => {
                const z = f * zTotal
                return (
                  <g key={f}>
                    <line x1={xOf(z)} y1={PAD_T + plotH} x2={xOf(z)} y2={PAD_T + plotH + 3} stroke="var(--text-muted)" />
                    <text x={xOf(z)} y={PAD_T + plotH + 15} textAnchor="middle"
                      fontSize={10} fill="var(--text-muted)">{z.toFixed(0)}</text>
                  </g>
                )
              })}
              <text x={PAD_L + plotW / 2} y={H - 4} textAnchor="middle" fontSize={11} fill="var(--text-muted)">z (mm)</text>
              <text x={12} y={PAD_T + plotH / 2} textAnchor="middle" fontSize={11} fill="var(--text-muted)"
                transform={`rotate(-90 12 ${PAD_T + plotH / 2})`}>w (mm)</text>

              {/* lens markers */}
              {events.filter(ev => ev.kind === 'lens').map((ev, i) => (
                <g key={i}>
                  <line x1={xOf(ev.z_mm)} y1={PAD_T} x2={xOf(ev.z_mm)} y2={PAD_T + plotH}
                    stroke="#e0b040" strokeDasharray="3 3" strokeWidth={1} opacity={0.7} />
                  <text x={xOf(ev.z_mm)} y={PAD_T - 2} textAnchor="middle" fontSize={10}
                    fill="#e0b040">{ev.elementLabel}</text>
                </g>
              ))}

              {/* w(z) trace */}
              <path d={linePath} fill="none" stroke={path?.color ?? '#61afef'} strokeWidth={1.5} />
            </svg>

            {/* Per-element table */}
            <table style={{ marginTop: 8, width: '100%', fontSize: 11, borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ color: 'var(--text-muted)', textAlign: 'left' }}>
                  <th>Element</th>
                  <th>z (mm)</th>
                  <th>w (mm)</th>
                  <th>R (mm)</th>
                  <th>f (mm)</th>
                </tr>
              </thead>
              <tbody>
                {perElement.map((r, i) => (
                  <tr key={i} style={{ borderTop: '1px solid var(--border-side)' }}>
                    <td>{r.label}</td>
                    <td>{r.z_mm.toFixed(1)}</td>
                    <td>{Number.isFinite(r.w_mm) ? r.w_mm.toFixed(3) : '—'}</td>
                    <td>{Number.isFinite(r.R_mm) ? r.R_mm.toFixed(0) : '∞'}</td>
                    <td>
                      <input className="snap-input" type="number" step="1"
                        style={{ width: 70 }}
                        value={elById[r.label]?.f_mm ?? ''}
                        placeholder="—"
                        onChange={e => {
                          const v = e.target.value
                          onUpdateElement(r.label, 'f_mm', v === '' ? undefined : parseFloat(v))
                        }} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <p style={{ color: 'var(--text-muted)', fontSize: 10, marginTop: 6 }}>
              Prototype: assumes thin lenses, small-angle propagation, waist at Start. All lens
              elements with a numeric f (mm) contribute an ABCD step; other elements are pass-through.
            </p>
          </>
        )}

        <div style={{ marginTop: 8, textAlign: 'right' }}>
          <button className="small-btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}
