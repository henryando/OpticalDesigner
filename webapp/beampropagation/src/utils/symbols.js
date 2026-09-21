// ── Library symbol definitions ──────────────────────────────────────────────
// Each entry: { href, w, h, displayH, orientation?, labelClearance? }
// displayH: target rendered height in SVG canvas pixels
// orientation: additional fixed rotation (degrees) applied to the symbol
// Keys are matched exactly first, then as globs (see lookupSymbolDef).
// This baseline is kept in sync with webapp/example_files/settings.json so
// example projects and a fresh install describe the same defaults.
export const DEFAULT_SYMBOL_DEFS = {
  '*coupler*':   { href: '/symbols/b-coupler.svg',   w: 17.754, h: 23.427, displayH: 10, orientation: 0 },
  '*mirror*':    { href: '/symbols/b-mir.svg',       w: 10.671, h: 29.096, displayH: 11 },
  '*pbs*':       { href: '/symbols/b-bsp.svg',       w: 23.427, h: 23.427, displayH: 6  },
  '*waveplate*': { href: '/symbols/b-wpyel.svg',     w: 5,      h: 23.428, displayH: 9  },
  '*hwp*':       { href: '/symbols/b-wpyel.svg',     w: 5,      h: 23.428, displayH: 9  },
  '*qwp*':       { href: '/symbols/b-wpred.svg',     w: 5.002,  h: 23.428, displayH: 9  },
  '*lens*':      { href: '/symbols/b-lens1.svg',     w: 6.418,  h: 23.426, displayH: 9  },
  '*pd*':        { href: '/symbols/e-pd1.svg',       w: 16.34,  h: 23.428, displayH: 8  },
  '*laser*':     { href: '/symbols/c-laser1.svg',    w: 12,     h: 12,     displayH: 24, labelClearance: 10 },
  '*dump*':      { href: '/symbols/b-dump.svg',      w: 20,     h: 20,     displayH: 20 },
  '*aom*':       { href: '/symbols/c-aom.svg',       w: 15,     h: 15,     displayH: 13, labelClearance: 7.5 },
  '*polarizer*': { href: '/symbols/b-bspcube.svg',   w: 11,     h: 11,     displayH: 11 },
  '*isolator*':  { href: '/symbols/c-isolator.svg',  w: 11,     h: 11,     displayH: 11 },
  '*cell*':      { href: '/symbols/b-crystalcc.svg', w: 11,     h: 11,     displayH: 11 },
  '*sampler*':   { href: '/symbols/b-bspcube.svg',   w: 11,     h: 11,     displayH: 11 },
  '*iris*':      { href: '/symbols/h-iris.svg',      w: 11,     h: 11,     displayH: 11 },
  '*shutter*':   { href: '/symbols/h-shutter.svg',   w: 11,     h: 11,     displayH: 11, orientation: 0 },
  '*fiber*':     { href: '/symbols/c-fiber.svg',     w: 11,     h: 11,     displayH: 14, labelClearance: 7 },
  '*eom*':       { href: '/symbols/c-eom2.svg',      w: 11,     h: 11,     displayH: 11 },
  'd-mirror':    { href: '/symbols/b-mir.svg',       w: 7,      h: 7,      displayH: 7  },
}

export const AVAILABLE_SYMBOLS = [
  'b-bsp.svg','b-bspcube.svg','b-coupler.svg','b-credit.svg',
  'b-crystalcc.svg','b-crystalfc.svg','b-crystalff.svg','b-diccube.svg',
  'b-dicgrn.svg','b-dicred.svg','b-dump.svg','b-grat.svg',
  'b-lens1.svg','b-lens2.svg','b-lens3.svg','b-mir.svg',
  'b-mirc.svg','b-mircpzt.svg','b-mirpzt.svg','b-npro.svg',
  'b-phase.svg','b-wpgn.svg','b-wpred.svg','b-wpyel.svg',
  'c-aom.svg','c-diodegrn.svg','c-eom1.svg','c-eom2.svg',
  'c-fiber.svg','c-fibercoupl.svg','c-flip.svg','c-isolator.svg',
  'c-laser1.svg','c-laser2.svg','c-mirpzt3ax.svg','c-modeclean.svg',
  'c-modecleanpzt.svg','c-opacc.svg','c-opaccplates.svg','c-opacfplates.svg',
  'c-opafc.svg','c-opaff.svg','c-opaffplates.svg','c-opakerr.svg',
  'c-opared.svg','c-rotator.svg','e-amp.svg','e-computer.svg',
  'e-diff.svg','e-frq1.svg','e-frq2.svg','e-hipass.svg',
  'e-hvampleft.svg','e-hvampright.svg','e-lopass.svg','e-mix.svg',
  'e-pd1.svg','e-pd2.svg','e-pdgrn1.svg','e-pdgrn2.svg',
  'e-qpd.svg','e-servoleft.svg','e-servoright.svg','e-spekki.svg',
  'e-sum.svg','e-sumdiff.svg','e-wincam.svg','h-fabryperot.svg',
  'h-fibercoupl.svg','h-iris.svg','h-lenstube.svg','h-shutter.svg',
  'h_prismpair.svg',
]

// Convert any CSS color (name or hex) to a hex string for <input type="color">
const _cvs = typeof document !== 'undefined' ? document.createElement('canvas') : null
if (_cvs) { _cvs.width = 1; _cvs.height = 1 }

export function colorToHex(color) {
  if (!_cvs) return '#888888'
  if (color && /^#[0-9a-fA-F]{6}$/.test(color)) return color
  try {
    const ctx = _cvs.getContext('2d')
    ctx.clearRect(0, 0, 1, 1)
    ctx.fillStyle = color
    ctx.fillRect(0, 0, 1, 1)
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data
    return `#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${b.toString(16).padStart(2,'0')}`
  } catch { return '#888888' }
}
