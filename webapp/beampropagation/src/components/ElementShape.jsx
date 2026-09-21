// SVG shapes for optical element types.
// Shapes using library SVGs are centered at (0,0) via x/y offsets.
// Fallback geometric shapes are used for types without a library symbol.
import { DEFAULT_SYMBOL_DEFS } from '../utils/symbols'

// ── Symbol lookup with glob-wildcard fallback ────────────────────────────────
// Keys in defs are tried as exact match first, then as glob patterns (* → .*)
export function lookupSymbolDef(defs, normalized) {
  if (defs[normalized] !== undefined) return defs[normalized]
  for (const [key, def] of Object.entries(defs)) {
    try {
      const pattern = key
        .replace(/[.+?^${}()|[\]\\]/g, '\\$&') // escape regex specials
        .replace(/\*/g, '.*')                    // * becomes wildcard
      if (new RegExp(`^${pattern}$`, 'i').test(normalized)) return def
    } catch { continue }
  }
  return null
}

// ── Fallback geometric shapes ────────────────────────────────────────────────
const R = 4

function BeamDump({ selected }) {
  return <circle r={R} fill={selected ? '#ff6b6b' : '#bf616a'} />
}
function Post({ selected, selColor }) {
  return <circle r={R * 0.5} fill="none" stroke={selected ? selColor : '#4c566a'} strokeWidth={1.5} />
}
function Iris({ selected, selColor }) {
  return (
    <g>
      <circle r={R} fill="none" stroke={selected ? selColor : '#81a1c1'} strokeWidth={1.5} />
      <circle r={R * 0.4} fill="none" stroke={selected ? selColor : '#81a1c1'} strokeWidth={1} />
    </g>
  )
}
function Unknown({ selected, selColor }) {
  return (
    <circle r={R * 0.6}
      fill={selected ? `${selColor}44` : '#2a3a4a'}
      stroke={selected ? selColor : '#4a6a8a'} strokeWidth={1} />
  )
}

const FALLBACK_SHAPES = {
  'beam dump':               BeamDump,
  'water-cooled beam dump':  BeamDump,
  post:                      Post,
  iris:                      Iris,
  'generic circle':          Unknown,
}

// ── SVG image helper ─────────────────────────────────────────────────────────
function SymbolImage({ def, selected, dark }) {
  const dH = def.displayH
  const dW = (def.w / def.h) * dH
  return (
    <>
      <image
        href={def.href}
        x={-dW / 2} y={-dH / 2}
        width={dW} height={dH}
        style={{ imageRendering: 'crisp-edges' }}
      />
      {selected && (
        <rect
          x={-dW / 2 - 2} y={-dH / 2 - 2}
          width={dW + 4} height={dH + 4}
          fill="none" stroke={dark ? '#fff8' : '#0007'} strokeWidth={1} strokeDasharray="3 2" rx={1}
        />
      )}
    </>
  )
}

// ── Main export ──────────────────────────────────────────────────────────────
export default function ElementShape({ type, orientation, selected, symbolDefs, dark = false }) {
  const defs = symbolDefs ?? DEFAULT_SYMBOL_DEFS
  const normalized = (type || '').toLowerCase().trim()
  const angle = orientation || 0
  const selColor = dark ? '#fff' : '#1a2a3a'

  const symDef = lookupSymbolDef(defs, normalized)
  if (symDef) {
    return (
      <g transform={`rotate(${180 - angle + (symDef.orientation ?? 0)})`}>
        <SymbolImage def={symDef} selected={selected} dark={dark} />
      </g>
    )
  }

  const FallbackComponent = FALLBACK_SHAPES[normalized] || Unknown
  return (
    <g transform={`rotate(${180 - angle})`}>
      <FallbackComponent selected={selected} selColor={selColor} />
      {selected && <circle r={R + 3} fill="none" stroke={`${selColor}88`} strokeWidth={1} strokeDasharray="3 2" />}
    </g>
  )
}
