// Gaussian beam propagation via the complex q-parameter formalism.
// All distances in mm, wavelength in mm (nm × 1e-6), waist radius in mm.
//
// q      = z + i·zR                 (position from waist + Rayleigh range)
// w(z)²  = -λ / (π · Im(1/q))       (beam radius)
// R(z)   = 1 / Re(1/q)              (wavefront radius of curvature)
// zR     = π w0² / λ
//
// Elements are applied via ABCD:
//   Free space L:    A=1, B=L, C=0, D=1
//   Thin lens f:     A=1, B=0, C=-1/f, D=1
// Both act on q as:  q' = (A·q + B) / (C·q + D)

const NM_PER_MM = 1e6

// Simple complex-number helpers (real, imag).
function cAdd(a, b)  { return { re: a.re + b.re, im: a.im + b.im } }
function cSub(a, b)  { return { re: a.re - b.re, im: a.im - b.im } }
function cMul(a, b)  { return { re: a.re * b.re - a.im * b.im, im: a.re * b.im + a.im * b.re } }
function cDiv(a, b)  {
  const d = b.re * b.re + b.im * b.im
  return { re: (a.re * b.re + a.im * b.im) / d, im: (a.im * b.re - a.re * b.im) / d }
}
function cScale(a, s){ return { re: a.re * s, im: a.im * s } }

// Initial q from a waist located at z=0 with radius w0 (mm) at wavelength λ_mm.
export function qFromWaist(w0_mm, lambda_mm) {
  const zR = Math.PI * w0_mm * w0_mm / lambda_mm
  return { re: 0, im: zR }
}

// Propagate q through free space of length L (mm).
export function propagateFreeSpace(q, L) {
  return { re: q.re + L, im: q.im }
}

// Propagate q through a thin lens of focal length f (mm).
// Uses 1/q' = 1/q - 1/f  (equivalent to the ABCD form).
export function propagateThinLens(q, f) {
  const invQ = cDiv({ re: 1, im: 0 }, q)
  const newInvQ = cSub(invQ, { re: 1 / f, im: 0 })
  return cDiv({ re: 1, im: 0 }, newInvQ)
}

// Apply a prism-pair (anamorphic afocal telescope) with magnification M
// along one axis. Spatial size scales by M and divergence by 1/M, which on
// the q-parameter is q → M²·q. The other axis is unchanged; call this only
// on the affected axis's q.
export function propagatePrismPair(q, M) {
  const s = M * M
  return { re: q.re * s, im: q.im * s }
}

// Beam radius (mm) from q.
export function radiusFromQ(q, lambda_mm) {
  const invQ = cDiv({ re: 1, im: 0 }, q)
  const w2 = -lambda_mm / (Math.PI * invQ.im)
  return w2 > 0 ? Math.sqrt(w2) : NaN
}

// Wavefront radius of curvature (mm) from q. Positive = converging away from
// waist. Returns Infinity at the waist.
export function curvatureRadiusFromQ(q) {
  const invQ = cDiv({ re: 1, im: 0 }, q)
  return invQ.re === 0 ? Infinity : 1 / invQ.re
}

// Convert wavelength nm → mm.
export function nmToMm(nm) { return nm / NM_PER_MM }
// Convert waist µm → mm.
export function umToMm(um) { return um / 1e3 }
export function mmToUm(mm) { return mm * 1e3 }
// Convert milliradian → radian.
export function mradToRad(mrad) { return mrad / 1000 }

// Initial q at z=0 for a beam whose waist sits at z=zWaist with radius w0.
// Uses q(0) = q(zWaist) − zWaist  and  q(zWaist) = i·zR (pure waist).
export function qFromWaistPosition(w0_mm, zWaist_mm, lambda_mm) {
  const zR = Math.PI * w0_mm * w0_mm / lambda_mm
  return { re: -zWaist_mm, im: zR }
}

// ── Beam-profiler width conventions → 1/e² intensity RADIUS in mm ──────────
// Multiply a measured width by the corresponding factor to get the value
// used in the ISO 11146 propagation formula. Matches Li_TA_testing.py.
export const WIDTH_CONVERSIONS = {
  '1/e2_radius':      1.0,
  '1/e2_diameter':    0.5,
  'D4sigma_diameter': 0.5,
  'D4sigma_radius':   1.0,
  'FWHM':             1.0 / Math.sqrt(2 * Math.log(2)),
}

// Solve a 3×3 linear system by Cramer's rule. Returns null if singular.
function _solve3(M, r) {
  const d = (m) =>
      m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
    - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
    + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
  const det = d(M)
  if (!Number.isFinite(det) || Math.abs(det) < 1e-30) return null
  const M0 = [[r[0], M[0][1], M[0][2]], [r[1], M[1][1], M[1][2]], [r[2], M[2][1], M[2][2]]]
  const M1 = [[M[0][0], r[0], M[0][2]], [M[1][0], r[1], M[1][2]], [M[2][0], r[2], M[2][2]]]
  const M2 = [[M[0][0], M[0][1], r[0]], [M[1][0], M[1][1], r[1]], [M[2][0], M[2][1], r[2]]]
  return [d(M0) / det, d(M1) / det, d(M2) / det]
}

// Fit the ideal-Gaussian propagation curve
//     w(z)² = w0² · (1 + ((z − z0)/zR)²),   zR = π·w0² / λ
// to (z, w) samples. Two free parameters: w0, z0.
//
// Approach: seed from an unconstrained quadratic LS on w² (closed form,
// linear in a,b,c), then refine with a few Gauss-Newton iterations on the
// 2-parameter model. Gauss-Newton because the M²=1 constraint couples the
// curvature to w0 nonlinearly — the 3-parameter fit alone would relax that
// coupling.
//
// Returns { ok, warnings, error?, w0_mm, z0_mm, zR_mm, r_squared, n }.
// ok=true when a real (finite, positive) w0 and finite z0 were found.
// w_mm is a 1/e² intensity RADIUS.
export function fitBeamWaist({ z_mm, w_mm, lambda_mm }) {
  const pts = []
  for (let i = 0; i < z_mm.length; i++) {
    const z = z_mm[i], w = w_mm[i]
    if (Number.isFinite(z) && Number.isFinite(w) && w > 0) pts.push([z, w])
  }
  if (pts.length < 2) {
    return { ok: false, error: 'need at least 2 valid (z, w) points', warnings: [], n: pts.length }
  }
  // ── Initial guess ──────────────────────────────────────────────────────
  // Try the unconstrained quadratic first; if it gives a concave-up parabola
  // with a real minimum, use its vertex. Otherwise fall back to the smallest
  // measured w and its z.
  let u = null, z0 = null       // u ≡ w0²
  if (pts.length >= 3) {
    let S0 = 0, S1 = 0, S2 = 0, S3 = 0, S4 = 0
    let Sy = 0, Syz = 0, Syz2 = 0
    for (const [z, w] of pts) {
      const y = w * w
      const z2 = z * z, z3 = z2 * z, z4 = z2 * z2
      S0 += 1; S1 += z; S2 += z2; S3 += z3; S4 += z4
      Sy += y; Syz += y * z; Syz2 += y * z2
    }
    const sol = _solve3([[S0, S1, S2], [S1, S2, S3], [S2, S3, S4]], [Sy, Syz, Syz2])
    if (sol && sol[2] > 0) {
      const [a, b, c] = sol
      z0 = -b / (2 * c)
      const uMin = a - (b * b) / (4 * c)                 // implied w0² from parabola minimum
      const uDiv = (lambda_mm * lambda_mm) / (Math.PI * Math.PI * c)  // implied w0² from divergence
      // Prefer the parabola minimum when it's positive; otherwise use the
      // divergence-implied value (always positive when c > 0).
      u = uMin > 0 ? uMin : uDiv
    }
  }
  if (u === null || !Number.isFinite(u) || u <= 0 || !Number.isFinite(z0)) {
    let iMin = 0
    for (let i = 1; i < pts.length; i++) if (pts[i][1] < pts[iMin][1]) iMin = i
    u = pts[iMin][1] * pts[iMin][1]
    z0 = pts[iMin][0]
  }

  // ── Gauss-Newton refinement on the 2-parameter model ──────────────────
  //   f(z; u, z0) = u + (λ² / π² / u) · (z − z0)²
  //   ∂f/∂u  = 1 − (λ² / π² / u²) · (z − z0)²
  //   ∂f/∂z0 = −2 · (λ² / π² / u) · (z − z0)
  const k2 = (lambda_mm / Math.PI) ** 2
  const warnings = []
  let converged = false
  for (let iter = 0; iter < 30; iter++) {
    let JtJ_uu = 0, JtJ_uz = 0, JtJ_zz = 0
    let Jtr_u  = 0, Jtr_z  = 0
    for (const [z, w] of pts) {
      const dz = z - z0
      const y  = w * w
      const pred = u + (k2 * dz * dz) / u
      const r  = y - pred
      const df_du  = 1 - (k2 * dz * dz) / (u * u)
      const df_dz0 = -2 * k2 * dz / u
      JtJ_uu += df_du * df_du
      JtJ_uz += df_du * df_dz0
      JtJ_zz += df_dz0 * df_dz0
      Jtr_u  += df_du * r
      Jtr_z  += df_dz0 * r
    }
    const det = JtJ_uu * JtJ_zz - JtJ_uz * JtJ_uz
    if (!Number.isFinite(det) || Math.abs(det) < 1e-30) break
    const dU  = (JtJ_zz * Jtr_u - JtJ_uz * Jtr_z) / det
    const dZ0 = (JtJ_uu * Jtr_z - JtJ_uz * Jtr_u) / det
    // Damp the update if it would make u non-positive.
    let step = 1
    while (u + step * dU <= 0 && step > 1e-6) step *= 0.5
    u  += step * dU
    z0 += step * dZ0
    if (Math.abs(dU) / (Math.abs(u) + 1e-12) + Math.abs(dZ0) / (Math.abs(z0) + 1) < 1e-10) {
      converged = true
      break
    }
  }
  if (!converged) warnings.push('fit did not fully converge (values may still be reasonable)')
  if (!(u > 0)) warnings.push('fit failed to find a positive waist radius')

  const w0 = u > 0 ? Math.sqrt(u) : NaN
  const zR = u > 0 ? (Math.PI * u) / lambda_mm : NaN

  // R² on w² residuals.
  let ymean = 0
  for (const [, w] of pts) ymean += w * w
  ymean /= pts.length
  let ss_res = 0, ss_tot = 0
  for (const [z, w] of pts) {
    const y = w * w
    const dz = z - z0
    const pred = u + (k2 * dz * dz) / u
    ss_res += (y - pred) * (y - pred)
    ss_tot += (y - ymean) * (y - ymean)
  }
  const r_squared = ss_tot > 0 ? 1 - ss_res / ss_tot : NaN

  const ok = Number.isFinite(w0) && Number.isFinite(z0) && !warnings.length
  return { ok, warnings, w0_mm: w0, z0_mm: z0, zR_mm: zR, r_squared, n: pts.length }
}

// Initial q from local beam radius w (mm) and local divergence half-angle
// θ (rad, positive = expanding). Uses the identity θ_local = w/R, so
//    1/q = θ/w  -  i · λ/(π w²)
// θ = 0 collapses to the pure-waist form (radius w0 at z=0).
export function qFromBeam(w_mm, theta_rad, lambda_mm) {
  const invR = w_mm === 0 ? 0 : theta_rad / w_mm
  const invIm = -lambda_mm / (Math.PI * w_mm * w_mm)
  return cDiv({ re: 1, im: 0 }, { re: invR, im: invIm })
}

// Sample two independent axes (x, y) simultaneously. Each step is:
//   { kind: 'space', L: mm, label? }
//   { kind: 'lens',  f: mm, shape: 'spherical' | 'cylX' | 'cylY',
//                   label?, elementLabel? }
//   { kind: 'prism-pair', mag: number, axis: 'x' | 'y',
//                   label?, elementLabel? }
// spherical lens acts on both axes; cylX only on qx; cylY only on qy.
// Prism pair applies q → M²·q on its axis only.
// Returns { traceX, traceY, events, qxFinal, qyFinal, zTotal }.
export function sampleWofZ2D(steps, qx0, qy0, lambda_mm, samplesPerSpace = 120) {
  const traceX = [], traceY = [], events = []
  let qx = qx0, qy = qy0, z = 0
  traceX.push({ z_mm: 0, w_mm: radiusFromQ(qx, lambda_mm) })
  traceY.push({ z_mm: 0, w_mm: radiusFromQ(qy, lambda_mm) })
  for (const step of steps) {
    if (step.kind === 'space') {
      const n = Math.max(2, samplesPerSpace)
      for (let i = 1; i <= n; i++) {
        const dz = (step.L * i) / n
        traceX.push({ z_mm: z + dz, w_mm: radiusFromQ(propagateFreeSpace(qx, dz), lambda_mm) })
        traceY.push({ z_mm: z + dz, w_mm: radiusFromQ(propagateFreeSpace(qy, dz), lambda_mm) })
      }
      qx = propagateFreeSpace(qx, step.L)
      qy = propagateFreeSpace(qy, step.L)
      z += step.L
    } else if (step.kind === 'lens') {
      const shape = step.shape ?? 'spherical'
      if (shape === 'spherical' || shape === 'cylX') qx = propagateThinLens(qx, step.f)
      if (shape === 'spherical' || shape === 'cylY') qy = propagateThinLens(qy, step.f)
      events.push({ z_mm: z, kind: 'lens', label: step.label, elementLabel: step.elementLabel, f: step.f, shape })
      traceX.push({ z_mm: z, w_mm: radiusFromQ(qx, lambda_mm) })
      traceY.push({ z_mm: z, w_mm: radiusFromQ(qy, lambda_mm) })
    } else if (step.kind === 'prism-pair') {
      const M = step.mag ?? 1
      if (step.axis === 'y') qy = propagatePrismPair(qy, M)
      else                    qx = propagatePrismPair(qx, M)
      events.push({ z_mm: z, kind: 'prism-pair', axis: step.axis === 'y' ? 'y' : 'x',
                    mag: M, label: step.label, elementLabel: step.elementLabel })
      traceX.push({ z_mm: z, w_mm: radiusFromQ(qx, lambda_mm) })
      traceY.push({ z_mm: z, w_mm: radiusFromQ(qy, lambda_mm) })
    }
  }
  return { traceX, traceY, events, qxFinal: qx, qyFinal: qy, zTotal: z }
}

// A propagation "step" describes one operation along the path:
//   { kind: 'space', L: mm, label?: string, elementLabel?: string }
//   { kind: 'lens',  f: mm, label?: string, elementLabel?: string }
// Return a densely sampled w(z) trace suitable for plotting.
//
// steps: array as above
// q0:    starting q-parameter
// lambda_mm: wavelength in mm
// samplesPerSpace: how many free-space samples per segment (min 2)
export function sampleWofZ(steps, q0, lambda_mm, samplesPerSpace = 40) {
  const trace = []          // { z_mm, w_mm }
  const events = []         // { z_mm, kind, label, elementLabel, f? }
  let q = q0
  let z = 0
  trace.push({ z_mm: z, w_mm: radiusFromQ(q, lambda_mm) })
  for (const step of steps) {
    if (step.kind === 'space') {
      const n = Math.max(2, samplesPerSpace)
      for (let i = 1; i <= n; i++) {
        const dz = (step.L * i) / n
        const qi = propagateFreeSpace(q, dz)
        trace.push({ z_mm: z + dz, w_mm: radiusFromQ(qi, lambda_mm) })
      }
      q = propagateFreeSpace(q, step.L)
      z += step.L
    } else if (step.kind === 'lens') {
      q = propagateThinLens(q, step.f)
      events.push({ z_mm: z, kind: 'lens', label: step.label, elementLabel: step.elementLabel, f: step.f })
      trace.push({ z_mm: z, w_mm: radiusFromQ(q, lambda_mm) })
    }
  }
  return { trace, events, qFinal: q, zTotal: z }
}
