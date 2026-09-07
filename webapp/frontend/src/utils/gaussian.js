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
// spherical acts on both axes; cylX only on qx; cylY only on qy.
// Returns { traceX, traceY, events, qxFinal, qyFinal, zTotal }.
export function sampleWofZ2D(steps, qx0, qy0, lambda_mm, samplesPerSpace = 40) {
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
