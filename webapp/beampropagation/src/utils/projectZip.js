// Reads an Optical Table Designer project .zip (File ▸ Download Project) and
// pulls out what beam propagation needs: the elements, beam paths and symbol
// definitions used by "Import…", plus any propagations.json bundled with it.
import JSZip from 'jszip'
import { DEFAULT_SYMBOL_DEFS } from './symbols'
import { parseElementsCsv, parseBeamPathsCsv } from './csvUtils'
import { visibleElements, beamPathsThroughVisibleElements } from './projectContext'
import { parsePropagationsJson } from './propagationsJson'

export async function readProjectZip(file) {
  const zip = await JSZip.loadAsync(file)
  const readText = async name => {
    const f = zip.file(name); return f ? await f.async('string') : null
  }

  // Custom symbols are embedded under symbols/ and referenced from
  // settings.json by "/symbols/<file>.svg"; inline them as data URLs.
  const customSvgMap = {}
  await Promise.all(
    Object.keys(zip.files)
      .filter(name => name.startsWith('symbols/') && name.endsWith('.svg'))
      .map(async name => {
        const b64 = await zip.files[name].async('base64')
        customSvgMap[`/${name}`] = `data:image/svg+xml;base64,${b64}`
      })
  )

  const [settingsText, elemText, pathsText, propText] = await Promise.all([
    readText('settings.json'),
    readText('elements.csv'),
    readText('beam_paths.csv'),
    readText('propagations.json'),
  ])
  if (!elemText && !pathsText && !propText) {
    throw new Error('No elements.csv, beam_paths.csv or propagations.json found — is this an Optical Table Designer project .zip?')
  }

  let symbolDefs = { ...DEFAULT_SYMBOL_DEFS }
  let layers = {}
  if (settingsText) {
    const { symbolDefs: sd, layers: l } = JSON.parse(settingsText)
    if (l) layers = l
    if (sd) {
      symbolDefs = {}
      for (const [type, def] of Object.entries(sd)) {
        symbolDefs[type] = customSvgMap[def.href] ? { ...def, href: customSvgMap[def.href] } : def
      }
    }
  }

  const parsed = elemText ? parseElementsCsv(elemText).elements : []
  const elements = visibleElements(parsed, null, layers)
  const rawBeamPaths = pathsText ? parseBeamPathsCsv(pathsText).beamPaths : {}
  const beamPaths = beamPathsThroughVisibleElements(rawBeamPaths, elements)
  const propagations = propText ? parsePropagationsJson(propText) : {}

  return { elements, beamPaths, symbolDefs, propagations }
}
