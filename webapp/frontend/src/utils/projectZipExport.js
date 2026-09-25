// Builds a downloadable project .zip from a captured project state (the same
// shape App.jsx's captureProjectState() / applyProjectState() use — elements,
// beamPaths, bgGroups, settings, config, symbolDefs, layers, bgImages, etc.),
// independent of live React state. Used both for the top-bar "Download
// Project" (the live, currently-open project) and for the Projects tab,
// which needs to download any listed project — including ones that aren't
// currently open — straight from its stored state.
import JSZip from 'jszip'
import {
  serializeElementsCsv, serializeBeamPathsCsv, serializeBgObjectsCsv,
} from './csvUtils'

// Writes one project's files into `zip`, under `prefix` (a folder path
// ending in "/", or "" for the zip root). Mirrors App.jsx's old inline
// saveProject() exactly, generalized to take a state object instead of
// reading live component state.
function addProjectFilesToZip(zip, state, prefix = '') {
  const {
    elements = [], overrides = {}, beamPaths = {}, bgGroups = {},
    settings = {}, config, symbolDefs = {},
    layers, activeLayer, bgImages = {},
  } = state ?? {}

  const processedSymbolDefs = {}
  const usedSlugs = new Set()
  for (const [type, def] of Object.entries(symbolDefs)) {
    if (def.href?.startsWith('data:')) {
      let slug = type.replace(/[^a-z0-9._-]/gi, '_').toLowerCase()
      if (usedSlugs.has(slug)) {
        let i = 2; while (usedSlugs.has(`${slug}_${i}`)) i++; slug = `${slug}_${i}`
      }
      usedSlugs.add(slug)
      const path = `${prefix}symbols/${slug}.svg`
      const [, b64] = def.href.split(',')
      zip.file(path, b64, { base64: true })
      processedSymbolDefs[type] = { ...def, href: `/${path.slice(prefix.length)}` }
    } else {
      processedSymbolDefs[type] = def
    }
  }

  const processedBgImages = {}
  const usedImgSlugs = new Set()
  for (const [name, img] of Object.entries(bgImages)) {
    if (img.href?.startsWith('data:image/')) {
      const mime = img.href.slice(5, img.href.indexOf(';'))
      const ext = mime.split('/')[1] === 'jpeg' ? 'jpg' : mime.split('/')[1]
      let slug = name.replace(/[^a-z0-9._-]/gi, '_').toLowerCase()
      if (usedImgSlugs.has(slug)) {
        let i = 2; while (usedImgSlugs.has(`${slug}_${i}`)) i++; slug = `${slug}_${i}`
      }
      usedImgSlugs.add(slug)
      const path = `${prefix}background_images/${slug}.${ext}`
      const [, b64] = img.href.split(',')
      zip.file(path, b64, { base64: true })
      processedBgImages[name] = { ...img, href: `/${path.slice(prefix.length)}` }
    } else {
      processedBgImages[name] = img
    }
  }

  zip.file(`${prefix}settings.json`, JSON.stringify({
    settings, config, symbolDefs: processedSymbolDefs, layers, activeLayer,
    bgImages: processedBgImages,
  }, null, 2))
  if (elements.length)                  zip.file(`${prefix}elements.csv`,           serializeElementsCsv(elements, overrides, config))
  if (Object.keys(beamPaths).length)    zip.file(`${prefix}beam_paths.csv`,         serializeBeamPathsCsv(beamPaths))
  if (Object.keys(bgGroups).length)     zip.file(`${prefix}background_objects.csv`, serializeBgObjectsCsv(bgGroups))
}

// A project name → a safe, non-empty filename/folder component.
export function safeProjectName(name) {
  const cleaned = (name || '').replace(/[^a-z0-9_\-. ]/gi, '_').trim()
  return cleaned || 'project'
}

export async function buildProjectZipBlob(state) {
  const zip = new JSZip()
  addProjectFilesToZip(zip, state, '')
  return await zip.generateAsync({ type: 'blob' })
}

// `projects` is [{ name, state }, …]. Each becomes its own top-level folder
// in one combined zip, named after the project (de-duplicated if two
// projects share a name).
export async function buildProjectsZipBlob(projects) {
  const zip = new JSZip()
  const used = new Set()
  for (const { name, state } of projects) {
    let folder = safeProjectName(name)
    if (used.has(folder)) {
      let i = 2; while (used.has(`${folder}_${i}`)) i++; folder = `${folder}_${i}`
    }
    used.add(folder)
    addProjectFilesToZip(zip, state, `${folder}/`)
  }
  return await zip.generateAsync({ type: 'blob' })
}

// Plain anchor-click download — used for the Projects tab's per-project and
// download-all buttons. (The top-bar "Download Project" keeps using
// App.jsx's triggerSave(), which prefers the File System Access save picker
// when the browser supports it.)
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = filename; a.click()
  URL.revokeObjectURL(url)
}
