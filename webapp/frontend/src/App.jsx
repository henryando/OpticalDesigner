import { useState, useMemo, useEffect, useRef } from 'react'
import JSZip from 'jszip'
import OpticalCanvas from './components/OpticalCanvas'
import Sidebar from './components/Sidebar'
import SpreadsheetModal from './components/SpreadsheetModal'
import AuthPanel from './components/AuthPanel'
import CloudProjectsModal from './components/CloudProjectsModal'
import { DEFAULT_SYMBOL_DEFS } from './utils/symbols'
import {
  parseElementsCsv, serializeElementsCsv,
  parseBeamPathsCsv, serializeBeamPathsCsv,
  parseBgObjectsCsv, serializeBgObjectsCsv,
} from './utils/csvUtils'
import { supabase } from './supabaseClient'
import {
  fetchCloudProject, insertCloudProject, updateCloudProject, getCloudProjectUpdatedAt,
} from './utils/cloudProjects'
import './App.css'

const DEFAULT_CONFIG = { table_length: 55, table_width: 85, origin_x: 0, origin_y: 0 }

async function triggerSave(blob, suggestedName, mimeType, ext) {
  if ('showSaveFilePicker' in window) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName,
        types: [{ description: ext.toUpperCase() + ' file', accept: { [mimeType]: ['.' + ext] } }],
      })
      const w = await handle.createWritable()
      await w.write(blob); await w.close()
      return
    } catch (e) { if (e.name === 'AbortError') return }
  }
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = suggestedName; a.click()
  URL.revokeObjectURL(url)
}

function loadLocalState() {
  try {
    const raw = localStorage.getItem('optDesign_v1')
    if (!raw) return null
    return JSON.parse(raw)
  } catch { return null }
}

function loadCurrentProjectInfo() {
  try {
    const raw = localStorage.getItem('optDesign_current_project')
    return raw ? JSON.parse(raw) : null
  } catch { return null }
}

function loadSavedProjects() {
  try {
    const raw = localStorage.getItem('optDesign_projects')
    return raw ? JSON.parse(raw) : {}
  } catch { return {} }
}

// Merge any layer names found in elements into an existing layers map
function syncLayersFromElements(elems, existingLayers) {
  const updated = { ...existingLayers }
  ;(elems ?? []).forEach(el => {
    const name = el.Layer || 'Default'
    if (!(name in updated)) updated[name] = true
  })
  return updated
}

// Suggest a free label near the collided one, e.g. "O-12" -> "O-12_2"
function suggestAltLabel(label, usedLabels) {
  let i = 2, candidate = `${label}_${i}`
  while (usedLabels.has(candidate)) { i++; candidate = `${label}_${i}` }
  return candidate
}

// Enforce label uniqueness over a list of elements, renaming any duplicate after the
// first with the _2/_3 scheme. `seedLabels` are labels already taken elsewhere (e.g.
// the elements currently in the project, when appending). Duplicates can arrive from
// a hand-edited CSV as well as from a collision with existing elements, so every
// ingestion path runs through here.
function dedupeElementLabels(elems, seedLabels = []) {
  const used = new Set(seedLabels)
  const renamed = []
  const out = (elems ?? []).map(el => {
    if (!used.has(el.label)) { used.add(el.label); return el }
    const candidate = suggestAltLabel(el.label, used)
    used.add(candidate)
    renamed.push([el.label, candidate])
    return { ...el, label: candidate }
  })
  return { elements: out, renamed }
}

// Guess which CSV a dropped file is from its name — 'elements' | 'paths' | 'objects' | null
function inferCsvKindFromName(filename) {
  const name = filename.toLowerCase()
  if (/element/.test(name)) return 'elements'
  if (/beam|path/.test(name)) return 'paths'
  if (/background|object|^bg[-_.]/.test(name)) return 'objects'
  return null
}

// Fall back to sniffing the header row for a known column signature
function inferCsvKindFromHeader(text) {
  const firstLine = (text.split(/\r?\n/).find(l => l.trim() && !l.trim().startsWith('#')) || '')
  const cols = firstLine.split(',').map(c => c.trim().toLowerCase())
  if (cols.includes('label') && cols.includes('type')) return 'elements'
  if (cols.includes('src') && cols.includes('dest')) return 'paths'
  if (cols.includes('group') && cols.includes('x1')) return 'objects'
  return null
}

export default function App() {
  const _ls = useMemo(() => loadLocalState(), [])

  const [elements,     setElements]     = useState(() => _ls?.elements     ?? [])
  const [config,       setConfig]       = useState(() => _ls?.config ? { ...DEFAULT_CONFIG, ..._ls.config } : DEFAULT_CONFIG)
  const [beamPaths,    setBeamPaths]    = useState(() => _ls?.beamPaths    ?? {})
  const [visiblePaths, setVisiblePaths] = useState(() => _ls?.visiblePaths ?? {})
  const [bgGroups,     setBgGroups]     = useState(() => _ls?.bgGroups     ?? {})
  const [visibleBg,    setVisibleBg]    = useState(() => _ls?.visibleBg    ?? {})
  // Images placed as background layers. Each entry: {href, x, y, widthIn, opacity, visible}
  const [bgImages,     setBgImages]     = useState(() => _ls?.bgImages     ?? {})
  const [error,        setError]        = useState(null)
  const [notice,       setNotice]       = useState(null)

  const [selectedLabels, setSelectedLabels] = useState(() => new Set())
  const [overrides,  setOverrides]  = useState(() => _ls?.overrides  ?? {})
  const [history,    setHistory]    = useState([])
  const [editingPath,    setEditingPath]    = useState(null)
  const [editingBgGroup, setEditingBgGroup] = useState(null)
  const [editingBgImage, setEditingBgImage] = useState(null)
  // When set, the next click in bg-group edit mode places this text as a label
  // rather than starting/finishing an edge.
  const [pendingBgLabelText, setPendingBgLabelText] = useState(null)

  const [symbolDefs, setSymbolDefs] = useState(() => _ls?.symbolDefs ?? { ...DEFAULT_SYMBOL_DEFS })

  const [settings, setSettings] = useState(() => _ls?.settings ?? {
    snapSpacing:      0.5,
    showONumber:      false,
    showType:         false,
    showAnnotation:   true,
    darkMode:         false,
    showGrid:         true,
    showBoundingBox:  true,
    showCoords:       true,
    gridLineWidth:    0.5,
    beamSpacing:      1.5,
    scale:            10,
    uiFontSize:       12,
    pdfFontSize:      4,
    pdfLabelYOffset:  0,
    showBeamArrows:   true,
    beamArrowSize:    0.6,
    highlightOrphans: false,
    dimNonPathInEditMode: false,
  })

  const [searchOpen,  setSearchOpen]  = useState(false)
  const [searchQuery, setSearchQuery] = useState('')

  const [addElemAt,    setAddElemAt]    = useState(null)
  // Sidebar tab lives at App level so keyboard shortcuts (e.g. N) can flip to
  // the right tab in the same synchronous update that queues their other state.
  const [sidebarTab,   setSidebarTab]   = useState('paths')
  const [sidebarWidth, setSidebarWidth] = useState(() => _ls?.sidebarWidth ?? 280)
  const [fileMenuOpen, setFileMenuOpen] = useState(false)
  const [viewMenuOpen, setViewMenuOpen] = useState(false)
  const [transformMenuOpen, setTransformMenuOpen] = useState(false)
  const [viewModal,    setViewModal]    = useState(null) // 'elements' | 'paths' | 'objects'

  const [layers,      setLayers]      = useState(() => {
    const base = _ls?.layers ?? { Default: true }
    return syncLayersFromElements(_ls?.elements, base)
  })
  const [activeLayer, setActiveLayer] = useState(() => _ls?.activeLayer ?? 'Default')

  const [currentProjectId,   setCurrentProjectId]   = useState(() => loadCurrentProjectInfo()?.id   ?? null)
  const [currentProjectName, setCurrentProjectName] = useState(() => loadCurrentProjectInfo()?.name ?? null)
  const [projectsModalOpen,  setProjectsModalOpen]  = useState(false)
  // Bumped whenever the localStorage projects dict changes (add / delete /
  // rename), so the Switch-Project modal — which reads from localStorage
  // directly — re-renders instead of showing a stale list.
  const [projectsListVersion, setProjectsListVersion] = useState(0)
  // Inline-rename state for the Switch Project modal.
  const [renamingProjId, setRenamingProjId] = useState(null)
  const [renameProjVal, setRenameProjVal]   = useState('')
  const [newProjPromptOpen,  setNewProjPromptOpen]  = useState(false)
  const [newProjName,        setNewProjName]        = useState('')
  const [saveAsPromptOpen,   setSaveAsPromptOpen]   = useState(false)
  const [saveAsProjName,     setSaveAsProjName]     = useState('')
  const [dupProjPromptOpen,  setDupProjPromptOpen]  = useState(false)
  const [dupProjName,        setDupProjName]        = useState('')

  // ── Cloud projects — optional, only active when Supabase is configured. Each
  // account's cloud projects are private to it (owner-scoped RLS); a team
  // that wants a shared pool logs everyone into the same account.
  const [session,                 setSession]                 = useState(null)
  const [authModalOpen,           setAuthModalOpen]           = useState(false)
  const [cloudProjectsModalOpen,  setCloudProjectsModalOpen]  = useState(false)
  const [currentCloudProject,     setCurrentCloudProject]     = useState(null) // {id, name, updatedAt}
  const [cloudBusy,               setCloudBusy]               = useState(false)
  const [cloudError,              setCloudError]              = useState(null)
  const [cloudConflict,           setCloudConflict]           = useState(null) // {updatedByEmail, updatedAt}
  const [saveToCloudPromptOpen,   setSaveToCloudPromptOpen]   = useState(false)
  const [saveToCloudName,         setSaveToCloudName]         = useState('')
  const [uploadConflict,     setUploadConflict]     = useState(null) // { kind: 'elements'|'paths'|'objects', parsed, parsedCfg }
  const [labelCollisionPrompt, setLabelCollisionPrompt] = useState(null) // { parsed, parsedCfg, count }
  const [manualRelabel,        setManualRelabel]        = useState(null) // { parsed, parsedCfg, resolvedLabels, queue, step, usedLabels, value }
  const [dragActive,   setDragActive]   = useState(false)
  const [dropAmbiguous, setDropAmbiguous] = useState(null) // { file }
  const [zipUpload,     setZipUpload]     = useState(null) // { fileName, settingsText, elemText, pathsText, bgText, customSvgMap }
  const [zipStage,      setZipStage]      = useState(null) // 'choose' | 'newName' | null
  const [zipNewName,    setZipNewName]    = useState('')
  const [zipSettingsPrompt, setZipSettingsPrompt] = useState(null) // { next }
  const [bulkEdit,      setBulkEdit]      = useState(null) // { enabled: {key:bool}, values: {key:val} }

  const searchInputRef   = useRef(null)
  const cursorPosRef     = useRef({ x: 0, y: 0 })
  const canvasRef        = useRef(null)
  const elemFileRef      = useRef(null)
  const pathFileRef      = useRef(null)
  const bgFileRef        = useRef(null)
  const settingsFileRef  = useRef(null)
  const zipFileRef       = useRef(null)
  const lastAddedTypeRef = useRef('')
  const lastAddedOrientationRef = useRef(0)
  const persistTimer     = useRef(null)
  const dragCounterRef   = useRef(0)
  const fileMenuRef      = useRef(null)
  const viewMenuRef      = useRef(null)
  const transformMenuRef = useRef(null)

  // Persist state to localStorage (debounced)
  useEffect(() => {
    clearTimeout(persistTimer.current)
    persistTimer.current = setTimeout(() => {
      try {
        localStorage.setItem('optDesign_v1', JSON.stringify({
          elements, overrides, beamPaths, bgGroups, visiblePaths, visibleBg,
          bgImages,
          settings, config, symbolDefs, sidebarWidth, layers, activeLayer,
        }))
      } catch {}
    }, 800)
  }, [elements, overrides, beamPaths, bgGroups, visiblePaths, visibleBg, bgImages, settings, config, symbolDefs, sidebarWidth, layers, activeLayer])

  useEffect(() => {
    document.documentElement.dataset.theme = settings.darkMode ? 'dark' : 'light'
  }, [settings.darkMode])

  // Track the logged-in Supabase user, if any. When Supabase isn't
  // configured (`supabase` is null), this is a no-op and every cloud UI
  // element stays hidden — see the header/File-menu render below.
  useEffect(() => {
    if (!supabase) return
    supabase.auth.getSession().then(({ data }) => setSession(data.session))
    const { data: sub } = supabase.auth.onAuthStateChange((_event, sess) => setSession(sess))
    return () => sub.subscription.unsubscribe()
  }, [])

  // ── Derived state ──────────────────────────────────────────────────────────
  // All elements with overrides merged — used for the sidebar list (includes hidden)
  const allMergedElements = useMemo(() =>
    elements.map(el => {
      const ov = overrides[el.label]
      return ov ? { ...el, ...ov } : el
    }),
    [elements, overrides]
  )

  // Only elements with in_design !== false AND whose layer is visible — rendered on canvas
  const effectiveElements = useMemo(() =>
    allMergedElements.filter(el => {
      if (el.in_design === false) return false
      return layers[el.Layer || 'Default'] !== false
    }),
    [allMergedElements, layers]
  )

  const searchHighlights = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    if (!searchOpen || !q) return null
    const hits = new Set()
    effectiveElements.forEach(el => {
      if (el.label.toLowerCase().includes(q) || (el.type || '').toLowerCase().includes(q))
        hits.add(el.label)
    })
    return hits
  }, [searchOpen, searchQuery, effectiveElements])

  const selectedElement = useMemo(() => {
    const primary = [...selectedLabels][0] ?? null
    return allMergedElements.find(el => el.label === primary) ?? null
  }, [allMergedElements, selectedLabels])

  const allMetaKeys = useMemo(() => {
    const coreKeys = new Set(['label', 'type', 'x', 'y', 'orientation', 'in_design', 'Setup Location', 'Layer'])
    // Annotation is a first-class default field: always list it, even if no
    // element has a value set, so the column shows up in every view.
    const keys = ['Annotation']; const seen = new Set(keys)
    elements.forEach(el => Object.keys(el).forEach(k => {
      if (!coreKeys.has(k) && !seen.has(k)) { seen.add(k); keys.push(k) }
    }))
    return keys
  }, [elements])

  // ── Unified history ────────────────────────────────────────────────────────
  // Each entry snapshots all three mutable data layers.
  const MAX_HISTORY = 100

  function pushHistory() {
    setHistory(h => [...h.slice(-(MAX_HISTORY - 1)), { elements, overrides, beamPaths, bgGroups, bgImages }])
  }

  function undo() {
    if (!history.length) return
    const prev = history[history.length - 1]
    setElements(prev.elements)
    setOverrides(prev.overrides)
    setBeamPaths(prev.beamPaths)
    setBgGroups(prev.bgGroups)
    if (prev.bgImages != null) setBgImages(prev.bgImages)
    setHistory(h => h.slice(0, -1))
  }

  function handleSelectLabel(label, shiftKey) {
    if (label === null) { setSelectedLabels(new Set()); return }
    if (shiftKey) {
      setSelectedLabels(prev => {
        const next = new Set(prev)
        if (next.has(label)) next.delete(label); else next.add(label)
        return next
      })
    } else {
      setSelectedLabels(prev =>
        prev.size === 1 && prev.has(label) ? new Set() : new Set([label])
      )
    }
  }

  useEffect(() => {
    function onKeyDown(e) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault()
        setSearchOpen(true)
        setTimeout(() => searchInputRef.current?.focus(), 0)
        return
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        saveProject()
        return
      }
      // Checked before the text-field guard so Escape closes the bulk-edit modal
      // even while a field inside it has focus.
      if (e.key === 'Escape' && bulkEdit) {
        e.preventDefault()
        setBulkEdit(null)
        return
      }
      const tag = document.activeElement?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !e.shiftKey) {
        e.preventDefault(); undo()
      }
      if ((e.key === 'n' || e.key === 'N') && !e.metaKey && !e.ctrlKey) {
        e.preventDefault()
        const snap = settings.snapSpacing ?? 0.5
        const rx = Math.round(cursorPosRef.current.x / snap) * snap
        const ry = Math.round(cursorPosRef.current.y / snap) * snap
        setSidebarTab('elements')
        setAddElemAt({ x: rx, y: ry, label: nextOLabel(elements), type: lastAddedTypeRef.current || '' })
      }
      if ((e.key === 'p' || e.key === 'P') && !e.metaKey && !e.ctrlKey) {
        e.preventDefault()
        openBulkEdit()
      }
      // D: quick-add a new element at the cursor reusing the previously used
      // type — no form step. Rotation prefers the selected element when its
      // type matches; otherwise falls back to the last-added element's rotation.
      if ((e.key === 'd' || e.key === 'D') && !e.metaKey && !e.ctrlKey) {
        const type = lastAddedTypeRef.current
        if (!type) return
        e.preventDefault()
        const snap = settings.snapSpacing ?? 0.5
        const rx = Math.round(cursorPosRef.current.x / snap) * snap
        const ry = Math.round(cursorPosRef.current.y / snap) * snap
        const selEls = elements.filter(el => selectedLabels.has(el.label))
        const typeLC = type.toLowerCase().trim()
        const inheritOrient =
          (selEls.length === 1 && (selEls[0].type ?? '').toLowerCase().trim() === typeLC)
            ? (selEls[0].orientation ?? 0)
            : (lastAddedOrientationRef.current ?? 0)
        addElement({ type, x: rx, y: ry, orientation: inheritOrient })
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [history, elements, selectedLabels, addElement, settings.snapSpacing, undo, saveProject, openBulkEdit, bulkEdit])

  useEffect(() => {
    if (!fileMenuOpen) return
    function onDown(e) {
      if (!fileMenuRef.current?.contains(e.target)) setFileMenuOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [fileMenuOpen])

  useEffect(() => {
    if (!viewMenuOpen) return
    function onDown(e) {
      if (!viewMenuRef.current?.contains(e.target)) setViewMenuOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [viewMenuOpen])

  useEffect(() => {
    if (!transformMenuOpen) return
    function onDown(e) {
      if (!transformMenuRef.current?.contains(e.target)) setTransformMenuOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [transformMenuOpen])

  // ── Element edit helpers ───────────────────────────────────────────────────
  function startEdit()  { pushHistory() }

  function updateEdit(label, patch) {
    setOverrides(ov => ({ ...ov, [label]: { ...(ov[label] ?? {}), ...patch } }))
  }

  // Soft delete: set in_design=false, hides from canvas but kept in elements list
  function deleteSelected() {
    if (!selectedLabels.size) return
    pushHistory()
    setOverrides(ov => {
      const next = { ...ov }
      selectedLabels.forEach(label => {
        next[label] = { ...(next[label] ?? {}), in_design: false }
      })
      return next
    })
    setSelectedLabels(new Set())
  }

  // Hard delete: remove from elements array entirely
  function hardDeleteSelected() {
    if (!selectedLabels.size) return
    pushHistory()
    setElements(els => els.filter(el => !selectedLabels.has(el.label)))
    setOverrides(ov => {
      const next = { ...ov }
      selectedLabels.forEach(label => { delete next[label] })
      return next
    })
    setSelectedLabels(new Set())
  }

  function nextOLabel(elems) {
    const nums = elems.map(el => { const m = el.label.match(/^O-(\d+(?:\.\d+)?)$/); return m ? parseFloat(m[1]) : 0 })
    return `O-${nums.length ? Math.floor(Math.max(...nums)) + 1 : 1}`
  }

  function addElement({ type, x, y, orientation = 0, label: providedLabel }) {
    const label = providedLabel?.trim() || nextOLabel(elements)
    // Last line of defence: the add form validates as you type, but no caller may
    // create a second element sharing an O-number.
    if (elements.some(el => el.label === label)) {
      setError(`O-number "${label}" is already in use — choose a different one.`)
      return
    }
    lastAddedTypeRef.current = type
    lastAddedOrientationRef.current = orientation
    pushHistory()
    const newEl = { label, type, x, y, orientation, in_design: true, Layer: activeLayer, Annotation: '' }
    setElements(els => [...els, newEl])
    setSelectedLabels(new Set([label]))
  }

  function updateElementField(label, key, value) {
    pushHistory()
    let parsed = value
    if (key === 'x' || key === 'y' || key === 'orientation') {
      const n = parseFloat(value); if (isNaN(n)) return; parsed = n
    }
    setOverrides(ov => ({ ...ov, [label]: { ...(ov[label] ?? {}), [key]: parsed } }))
  }

  // ── Bulk property edit (P key) ─────────────────────────────────────────────
  // Seeds each field from the first selected element so the form shows current
  // values; only fields the user ticks are written to the whole selection.
  function openBulkEdit() {
    if (!selectedLabels.size) return
    const first = allMergedElements.find(el => selectedLabels.has(el.label))
    const values = {
      Layer:       first?.Layer || activeLayer || 'Default',
      type:        first?.type ?? '',
      orientation: first?.orientation ?? 0,
      in_design:   first?.in_design !== false,
    }
    allMetaKeys.forEach(k => { values[k] = first?.[k] ?? '' })
    setBulkEdit({ enabled: {}, values })
  }

  function applyBulkEdit() {
    if (!bulkEdit) return
    const { enabled, values } = bulkEdit
    const patch = {}
    for (const key of Object.keys(values)) {
      if (!enabled[key]) continue
      if (key === 'orientation') {
        const n = parseFloat(values[key])
        if (isNaN(n)) continue
        patch[key] = n
      } else {
        patch[key] = values[key]
      }
    }
    if (!Object.keys(patch).length) { setBulkEdit(null); return }
    pushHistory()
    setOverrides(ov => {
      const next = { ...ov }
      selectedLabels.forEach(label => {
        next[label] = { ...(next[label] ?? {}), ...patch }
      })
      return next
    })
    setBulkEdit(null)
  }

  useEffect(() => {
    if (searchHighlights?.size) canvasRef.current?.centerOn(searchHighlights)
  }, [searchHighlights])

  // ── Global project transforms ──────────────────────────────────────────────
  // rotateCW / rotateCCW: rotate the whole scene ±90° around the table centre
  //   and swap table_length ↔ table_width, keeping the (old) centre put.
  // flipH / flipV:        mirror across the vertical / horizontal centre axis.
  // Element orientations, background-object coords, and background-image
  // centres+rotations+flip flags are all updated; beam paths reference labels
  // so they follow automatically.
  function transformProject(kind) {
    const ox = config.origin_x ?? 0
    const oy = config.origin_y ?? 0
    // Rotations pivot around the table's origin corner so origin stays put.
    // Flips still use the table centre so mirrored content lands inside the box.
    const cx = ox + (config.table_length ?? 55) / 2
    const cy = oy + (config.table_width  ?? 85) / 2
    let mapPt, mapAngle, imgAngle, imgFlipDelta = { x: false, y: false }
    let swapDims = false
    // Coerce every input to a Number so a legacy string field can't turn
    // arithmetic into string concatenation.
    const N = v => { const n = Number(v); return Number.isFinite(n) ? n : 0 }
    if (kind === 'rotateCW') {
      mapPt = (x, y) => ({ x: ox + (N(y) - oy), y: oy - (N(x) - ox) })
      mapAngle = a => N(a) - 90
      // Background images use the raw SVG rotate() angle, which visually
      // rotates opposite to the element convention. Negate so they turn the
      // same visible direction as elements.
      imgAngle = a => N(a) + 90
      swapDims = true
    } else if (kind === 'rotateCCW') {
      mapPt = (x, y) => ({ x: ox - (N(y) - oy), y: oy + (N(x) - ox) })
      mapAngle = a => N(a) + 90
      imgAngle = a => N(a) - 90
      swapDims = true
    } else if (kind === 'flipH') {
      mapPt = (x, y) => ({ x: 2 * cx - N(x), y: N(y) })
      mapAngle = a => 180 - N(a)
      // For images the rotation stays; mirror is applied via the flipX flag
      // (scale(-1,1) after rotate in the render transform).
      imgAngle = a => N(a)
      imgFlipDelta = { x: true, y: false }
    } else if (kind === 'flipV') {
      mapPt = (x, y) => ({ x: N(x), y: 2 * cy - N(y) })
      mapAngle = a => -N(a)
      imgAngle = a => N(a)
      imgFlipDelta = { x: false, y: true }
    } else return

    pushHistory()

    setElements(es => es.map(el => {
      const p = mapPt(el.x, el.y)
      return { ...el, x: p.x, y: p.y, orientation: mapAngle(el.orientation) }
    }))

    // Overrides shadow base element fields at render time — any x, y, or
    // orientation override must also be transformed, or the element visually
    // ignores the rotation/flip. Rotate the effective (merged) position so
    // the result is consistent even when the override touches only one axis,
    // and store both x and y so the base y can't leak through post-rotation.
    setOverrides(ovs => {
      const out = {}
      for (const [label, ov] of Object.entries(ovs)) {
        const nov = { ...ov }
        if (nov.x != null || nov.y != null) {
          const base = elements.find(e => e.label === label)
          const ex = nov.x != null ? nov.x : (base?.x ?? 0)
          const ey = nov.y != null ? nov.y : (base?.y ?? 0)
          const p = mapPt(ex, ey)
          nov.x = p.x
          nov.y = p.y
        }
        if (nov.orientation != null) nov.orientation = mapAngle(nov.orientation)
        out[label] = nov
      }
      return out
    })

    setBgGroups(groups => {
      const out = {}
      for (const [name, g] of Object.entries(groups)) {
        out[name] = {
          ...g,
          edges: (g.edges ?? []).map(([x1, y1, x2, y2]) => {
            const a = mapPt(x1, y1), b = mapPt(x2, y2)
            return [a.x, a.y, b.x, b.y]
          }),
          labels: (g.labels ?? []).map(l => {
            const p = mapPt(l.x, l.y)
            return { ...l, x: p.x, y: p.y }
          }),
        }
      }
      return out
    })

    setBgImages(imgs => {
      const out = {}
      for (const [name, img] of Object.entries(imgs)) {
        const h = img.widthIn * img.aspect
        const p = mapPt(img.x + img.widthIn / 2, img.y + h / 2)
        out[name] = {
          ...img,
          x: p.x - img.widthIn / 2,
          y: p.y - h / 2,
          rotation: imgAngle(img.rotation ?? 0),
          flipX: imgFlipDelta.x ? !(img.flipX ?? false) : (img.flipX ?? false),
          flipY: imgFlipDelta.y ? !(img.flipY ?? false) : (img.flipY ?? false),
        }
      }
      return out
    })

    if (swapDims) {
      setConfig(c => ({
        ...c,
        table_length: c.table_width,
        table_width:  c.table_length,
        // origin stays put — rotations pivot around it.
      }))
    }
  }

  function startSidebarResize(e) {
    e.preventDefault()
    const startX = e.clientX
    const startW = sidebarWidth
    const onMove = ev => setSidebarWidth(Math.max(180, Math.min(600, startW + (startX - ev.clientX))))
    const onUp   = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp) }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  // ── Beam path helpers ──────────────────────────────────────────────────────
  function addEdge(src, dest) {
    if (!editingPath) return
    pushHistory()
    setBeamPaths(bp => {
      const path = bp[editingPath]
      if (!path) return bp
      return { ...bp, [editingPath]: { ...path, edges: [...(path.edges ?? []), [src, dest]] } }
    })
  }

  function deleteEdge(edgeIndex) {
    if (!editingPath) return
    pushHistory()
    setBeamPaths(bp => {
      const path = bp[editingPath]
      if (!path) return bp
      return { ...bp, [editingPath]: { ...path, edges: (path.edges ?? []).filter((_, i) => i !== edgeIndex) } }
    })
  }

  function addBeamPath(name, color) {
    if (!name || beamPaths[name]) return
    pushHistory()
    setBeamPaths(bp => ({ ...bp, [name]: { color, edges: [] } }))
    setVisiblePaths(vp => ({ ...vp, [name]: true }))
  }

  function deleteBeamPath(name) {
    pushHistory()
    setBeamPaths(bp => { const n = { ...bp }; delete n[name]; return n })
    setVisiblePaths(vp => { const n = { ...vp }; delete n[name]; return n })
    if (editingPath === name) setEditingPath(null)
  }

  function setPathColor(name, color) {
    setBeamPaths(bp => ({ ...bp, [name]: { ...bp[name], color } }))
  }

  // ── Layer helpers ──────────────────────────────────────────────────────────
  function addLayer(name) {
    const trimmed = name.trim()
    if (!trimmed || trimmed in layers) return
    setLayers(l => ({ ...l, [trimmed]: true }))
  }

  function deleteLayer(name) {
    if (Object.keys(layers).length <= 1) return
    const fallback = Object.keys(layers).find(k => k !== name) || 'Default'
    if (activeLayer === name) setActiveLayer(fallback)
    setElements(els => els.map(el =>
      (el.Layer || 'Default') === name ? { ...el, Layer: fallback } : el
    ))
    setOverrides(ov => {
      const n = { ...ov }
      for (const [label, patch] of Object.entries(n)) {
        if (patch.Layer === name) n[label] = { ...patch, Layer: fallback }
      }
      return n
    })
    setLayers(l => { const n = { ...l }; delete n[name]; return n })
  }

  function setLayerVisible(name, visible) {
    setLayers(l => ({ ...l, [name]: visible }))
  }

  function renameLayer(oldName, newName) {
    const trimmed = newName.trim()
    if (!trimmed || trimmed === oldName || trimmed in layers) return
    setElements(els => els.map(el =>
      (el.Layer || 'Default') === oldName ? { ...el, Layer: trimmed } : el
    ))
    setOverrides(ov => {
      const n = { ...ov }
      for (const [label, patch] of Object.entries(n)) {
        if (patch.Layer === oldName) n[label] = { ...patch, Layer: trimmed }
      }
      return n
    })
    setLayers(l => {
      const n = {}
      for (const [k, v] of Object.entries(l)) n[k === oldName ? trimmed : k] = v
      return n
    })
    if (activeLayer === oldName) setActiveLayer(trimmed)
  }

  // ── Project helpers ────────────────────────────────────────────────────────
  function captureProjectState() {
    return { elements, overrides, beamPaths, bgGroups, visiblePaths, visibleBg,
             bgImages,
             settings, config, symbolDefs, sidebarWidth, layers, activeLayer }
  }

  function applyProjectState(s) {
    if (s.elements     != null) setElements(s.elements)
    if (s.overrides    != null) setOverrides(s.overrides)
    if (s.beamPaths    != null) setBeamPaths(s.beamPaths)
    if (s.bgGroups     != null) setBgGroups(s.bgGroups)
    if (s.visiblePaths != null) setVisiblePaths(s.visiblePaths)
    if (s.visibleBg    != null) setVisibleBg(s.visibleBg)
    if (s.bgImages     != null) setBgImages(s.bgImages)
    if (s.settings     != null) setSettings(prev => ({ ...prev, ...s.settings }))
    if (s.config       != null) setConfig(s.config)
    if (s.symbolDefs   != null) setSymbolDefs(s.symbolDefs)
    if (s.sidebarWidth != null) setSidebarWidth(s.sidebarWidth)
    if (s.layers       != null) setLayers(s.layers)
    if (s.activeLayer  != null) setActiveLayer(s.activeLayer)
    setSelectedLabels(new Set())
    setHistory([])
  }

  function saveProjectSlot(name, id, stateOverride) {
    const trimmed = name.trim() || 'Untitled'
    const pid = id ?? crypto.randomUUID()
    const projects = loadSavedProjects()
    projects[pid] = { name: trimmed, savedAt: Date.now(), state: stateOverride ?? captureProjectState() }
    localStorage.setItem('optDesign_projects', JSON.stringify(projects))
    localStorage.setItem('optDesign_current_project', JSON.stringify({ id: pid, name: trimmed }))
    setCurrentProjectId(pid)
    setCurrentProjectName(trimmed)
    setCurrentCloudProject(null)
    setProjectsListVersion(v => v + 1)
  }

  function openProjectById(id) {
    const projects = loadSavedProjects()
    const project = projects[id]
    if (!project) return
    applyProjectState(project.state)
    localStorage.setItem('optDesign_current_project', JSON.stringify({ id, name: project.name }))
    setCurrentProjectId(id)
    setCurrentProjectName(project.name)
    setCurrentCloudProject(null)
    setProjectsModalOpen(false)
  }

  function renameProjectById(id, newName) {
    const trimmed = newName.trim()
    if (!trimmed) return
    const projects = loadSavedProjects()
    if (!projects[id]) return
    if (projects[id].name === trimmed) return
    projects[id] = { ...projects[id], name: trimmed }
    localStorage.setItem('optDesign_projects', JSON.stringify(projects))
    if (currentProjectId === id) {
      localStorage.setItem('optDesign_current_project', JSON.stringify({ id, name: trimmed }))
      setCurrentProjectName(trimmed)
    }
    setProjectsListVersion(v => v + 1)
  }

  function deleteProjectById(id) {
    const projects = loadSavedProjects()
    delete projects[id]
    localStorage.setItem('optDesign_projects', JSON.stringify(projects))
    if (currentProjectId === id) {
      localStorage.removeItem('optDesign_current_project')
      setCurrentProjectId(null)
      setCurrentProjectName(null)
    }
    setProjectsListVersion(v => v + 1)
  }

  function startNewProject(name) {
    const trimmed = name.trim() || 'Untitled'
    applyProjectState({
      elements: [], overrides: {}, beamPaths: {}, bgGroups: {},
      visiblePaths: {}, visibleBg: {}, bgImages: {},
      config: DEFAULT_CONFIG,
      symbolDefs: { ...DEFAULT_SYMBOL_DEFS },
      layers: { Default: true }, activeLayer: 'Default',
    })
    localStorage.removeItem('optDesign_current_project')
    setCurrentProjectId(null)
    setCurrentProjectName(trimmed)
    setCurrentCloudProject(null)
    setNewProjPromptOpen(false)
    setNewProjName('')
  }

  // ── Cloud project helpers ──────────────────────────────────────────────────
  // Mirror the local-slot helpers above, routed through Supabase instead of
  // localStorage. A project is either a local slot, a cloud project, or
  // neither — opening/starting one clears the other's identity, same as the
  // local helpers already do for each other.
  async function openCloudProjectById(id) {
    setCloudError(null)
    const proj = await fetchCloudProject(id)
    applyProjectState(proj.state)
    localStorage.removeItem('optDesign_current_project')
    setCurrentProjectId(null)
    setCurrentProjectName(null)
    setCurrentCloudProject({ id: proj.id, name: proj.name, updatedAt: proj.updatedAt })
    setCloudProjectsModalOpen(false)
  }

  async function saveNewCloudProject(name) {
    if (!session) return
    setCloudBusy(true); setCloudError(null)
    try {
      const saved = await insertCloudProject(name, captureProjectState(), session.user)
      setCurrentProjectId(null)
      setCurrentProjectName(null)
      localStorage.removeItem('optDesign_current_project')
      setCurrentCloudProject(saved)
      setSaveToCloudPromptOpen(false)
      setSaveToCloudName('')
    } catch (e) {
      setCloudError(e.message)
    } finally {
      setCloudBusy(false)
    }
  }

  // Updates the currently-open cloud project, unless someone else saved it
  // since it was loaded — in which case a conflict prompt is shown instead
  // (see cloudConflict state) and the write is held until the user decides.
  async function updateCurrentCloudProject(force = false) {
    if (!session || !currentCloudProject) return
    setCloudBusy(true); setCloudError(null)
    try {
      if (!force) {
        const latest = await getCloudProjectUpdatedAt(currentCloudProject.id)
        if (latest.updatedAt !== currentCloudProject.updatedAt) {
          setCloudConflict(latest)
          return
        }
      }
      const saved = await updateCloudProject(
        currentCloudProject.id, currentCloudProject.name, captureProjectState(), session.user
      )
      setCurrentCloudProject(saved)
      setCloudConflict(null)
    } catch (e) {
      setCloudError(e.message)
    } finally {
      setCloudBusy(false)
    }
  }

  async function logOutCloud() {
    if (!supabase) return
    await supabase.auth.signOut()
    setCurrentCloudProject(null)
  }

  function renameBeamPath(oldName, newName) {
    const trimmed = newName.trim()
    if (!trimmed || trimmed === oldName || beamPaths[trimmed]) return
    pushHistory()
    setBeamPaths(bp => {
      const next = {}
      Object.entries(bp).forEach(([k, v]) => { next[k === oldName ? trimmed : k] = v })
      return next
    })
    setVisiblePaths(vp => {
      const next = {}
      Object.entries(vp).forEach(([k, v]) => { next[k === oldName ? trimmed : k] = v })
      return next
    })
    if (editingPath === oldName) setEditingPath(trimmed)
  }

  // ── Background object helpers ──────────────────────────────────────────────
  function addBgGroup(name, color, strokeWidth) {
    if (!name || bgGroups[name]) return
    pushHistory()
    setBgGroups(g => ({ ...g, [name]: { color, strokeWidth, edges: [] } }))
    setVisibleBg(v => ({ ...v, [name]: true }))
  }

  function deleteBgGroup(name) {
    pushHistory()
    setBgGroups(g => { const n = { ...g }; delete n[name]; return n })
    setVisibleBg(v => { const n = { ...v }; delete n[name]; return n })
    if (editingBgGroup === name) setEditingBgGroup(null)
  }

  function setBgGroupColor(name, color) {
    setBgGroups(g => ({ ...g, [name]: { ...g[name], color } }))
  }

  function renameBgGroup(oldName, newName) {
    const trimmed = newName.trim()
    if (!trimmed || trimmed === oldName || bgGroups[trimmed]) return
    pushHistory()
    setBgGroups(g => {
      const next = {}
      Object.entries(g).forEach(([k, v]) => { next[k === oldName ? trimmed : k] = v })
      return next
    })
    setVisibleBg(v => {
      const next = {}
      Object.entries(v).forEach(([k, val]) => { next[k === oldName ? trimmed : k] = val })
      return next
    })
    if (editingBgGroup === oldName) setEditingBgGroup(trimmed)
  }

  function setBgGroupStroke(name, sw) {
    setBgGroups(g => ({ ...g, [name]: { ...g[name], strokeWidth: sw } }))
  }

  function addBgEdge(groupName, x1, y1, x2, y2) {
    pushHistory()
    setBgGroups(g => {
      const grp = g[groupName]
      if (!grp) return g
      return { ...g, [groupName]: { ...grp, edges: [...grp.edges, [x1, y1, x2, y2]] } }
    })
  }

  function deleteBgEdge(groupName, idx) {
    pushHistory()
    setBgGroups(g => {
      const grp = g[groupName]
      if (!grp) return g
      return { ...g, [groupName]: { ...grp, edges: grp.edges.filter((_, i) => i !== idx) } }
    })
  }

  function updateBgEdge(groupName, idx, patch) {
    pushHistory()
    setBgGroups(g => {
      const grp = g[groupName]
      if (!grp) return g
      const edges = grp.edges.map((e, i) => i === idx ? [
        patch.x1 ?? e[0], patch.y1 ?? e[1], patch.x2 ?? e[2], patch.y2 ?? e[3],
      ] : e)
      return { ...g, [groupName]: { ...grp, edges } }
    })
  }

  // Text labels attached to a bg group. Each entry: { x, y, text, fontSize? }.
  function addBgLabel(groupName, x, y, text) {
    if (!text?.trim()) return
    pushHistory()
    setBgGroups(g => {
      const grp = g[groupName]
      if (!grp) return g
      const labels = [...(grp.labels ?? []), { x, y, text: text.trim() }]
      return { ...g, [groupName]: { ...grp, labels } }
    })
  }

  function deleteBgLabel(groupName, idx) {
    pushHistory()
    setBgGroups(g => {
      const grp = g[groupName]
      if (!grp?.labels) return g
      return { ...g, [groupName]: { ...grp, labels: grp.labels.filter((_, i) => i !== idx) } }
    })
  }

  function updateBgLabel(groupName, idx, patch) {
    pushHistory()
    setBgGroups(g => {
      const grp = g[groupName]
      if (!grp?.labels) return g
      const labels = grp.labels.map((l, i) => i === idx ? { ...l, ...patch } : l)
      return { ...g, [groupName]: { ...grp, labels } }
    })
  }

  // ── Background image helpers ───────────────────────────────────────────────
  // Each entry: { href: dataURL, x, y, widthIn (inches), aspect, rotation (deg), flipX, flipY, opacity, visible }
  // Height falls out of widthIn * aspect at render time, so aspect follows the
  // source file's pixels — resizing preserves the picture instead of stretching it.
  function addBgImage(name, dataURL, aspect) {
    const trimmed = (name || 'image').trim()
    if (bgImages[trimmed]) {
      // Auto-name collisions — the sidebar can rename after the fact.
      let i = 2, candidate = `${trimmed} ${i}`
      while (bgImages[candidate]) { i++; candidate = `${trimmed} ${i}` }
      return addBgImage(candidate, dataURL, aspect)
    }
    pushHistory()
    const cx = (config.origin_x ?? 0) + (config.table_length ?? 55) / 2
    const cy = (config.origin_y ?? 0) + (config.table_width ?? 85) / 2
    const widthIn = Math.min(10, (config.table_length ?? 55) / 4)
    setBgImages(g => ({
      ...g,
      [trimmed]: {
        href: dataURL,
        x: cx - widthIn / 2,
        y: cy - (widthIn * aspect) / 2,
        widthIn,
        aspect,
        rotation: 0,
        flipX: false,
        flipY: false,
        opacity: 0.6,
        visible: true,
      },
    }))
    return trimmed
  }

  function updateBgImage(name, patch) {
    setBgImages(g => (g[name] ? { ...g, [name]: { ...g[name], ...patch } } : g))
  }

  function deleteBgImage(name) {
    pushHistory()
    setBgImages(g => { const n = { ...g }; delete n[name]; return n })
  }

  function renameBgImage(oldName, newName) {
    const trimmed = newName.trim()
    if (!trimmed || trimmed === oldName || bgImages[trimmed]) return
    pushHistory()
    setBgImages(g => {
      const next = {}
      Object.entries(g).forEach(([k, v]) => { next[k === oldName ? trimmed : k] = v })
      return next
    })
  }

  // ── Symbol def helpers ─────────────────────────────────────────────────────
  function addSymbolDef(typeName, def) {
    setSymbolDefs(d => ({ ...d, [typeName.toLowerCase()]: def }))
  }

  function updateSymbolDef(typeName, patch) {
    setSymbolDefs(d => ({ ...d, [typeName]: { ...d[typeName], ...patch } }))
  }

  function deleteSymbolDef(typeName) {
    setSymbolDefs(d => { const n = { ...d }; delete n[typeName]; return n })
  }

  function renameSymbolDef(oldKey, newKey) {
    const trimmed = newKey.trim().toLowerCase()
    if (!trimmed || trimmed === oldKey || symbolDefs[trimmed]) return
    setSymbolDefs(d => {
      const next = {}
      Object.entries(d).forEach(([k, v]) => { next[k === oldKey ? trimmed : k] = v })
      return next
    })
  }

  // ── Settings save / load ──────────────────────────────────────────────────
  async function saveSettingsJSON() {
    const data = JSON.stringify({ settings, config, symbolDefs }, null, 2)
    await triggerSave(new Blob([data], { type: 'application/json' }), 'settings.json', 'application/json', 'json')
  }

  function loadSettingsFile(file) {
    if (!file) return
    const reader = new FileReader()
    reader.onload = e => {
      try {
        const { settings: s, config: c, symbolDefs: sd } = JSON.parse(e.target.result)
        if (s)  setSettings(prev => ({ ...prev, ...s }))
        if (c)  setConfig(c)
        if (sd) setSymbolDefs(sd)
      } catch (err) { setError('Invalid settings file: ' + err.message) }
    }
    reader.readAsText(file)
    settingsFileRef.current.value = ''
  }

  // ── Project save / load (ZIP) ─────────────────────────────────────────────
  async function saveProject() {
    try {
      const zip = new JSZip()

      // Write uploaded SVGs as files; replace data URL hrefs with file paths in settings
      const processedSymbolDefs = {}
      const usedSlugs = new Set()
      for (const [type, def] of Object.entries(symbolDefs)) {
        if (def.href?.startsWith('data:')) {
          let slug = type.replace(/[^a-z0-9._-]/gi, '_').toLowerCase()
          if (usedSlugs.has(slug)) {
            let i = 2; while (usedSlugs.has(`${slug}_${i}`)) i++; slug = `${slug}_${i}`
          }
          usedSlugs.add(slug)
          const path = `symbols/${slug}.svg`
          const [, b64] = def.href.split(',')
          zip.file(path, b64, { base64: true })
          processedSymbolDefs[type] = { ...def, href: `/${path}` }
        } else {
          processedSymbolDefs[type] = def
        }
      }

      // Extract image data URLs to their own files, mirroring the pattern used
      // for custom symbol SVGs. Keeps the settings/manifest JSON small and lets
      // people peek inside a project archive with `unzip -l`.
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
          const path = `background_images/${slug}.${ext}`
          const [, b64] = img.href.split(',')
          zip.file(path, b64, { base64: true })
          processedBgImages[name] = { ...img, href: `/${path}` }
        } else {
          processedBgImages[name] = img
        }
      }

      zip.file('settings.json', JSON.stringify({
        settings, config, symbolDefs: processedSymbolDefs, layers, activeLayer,
        bgImages: processedBgImages,
      }, null, 2))
      if (elements.length)               zip.file('elements.csv',           serializeElementsCsv(elements, overrides, config))
      if (Object.keys(beamPaths).length) zip.file('beam_paths.csv',         serializeBeamPathsCsv(beamPaths))
      if (Object.keys(bgGroups).length)  zip.file('background_objects.csv', serializeBgObjectsCsv(bgGroups))
      const blob = await zip.generateAsync({ type: 'blob' })
      const zipName = currentProjectName
        ? currentProjectName.replace(/[^a-z0-9_\-. ]/gi, '_').trim() + '.zip'
        : 'project.zip'
      await triggerSave(blob, zipName, 'application/zip', 'zip')
    } catch (e) { if (e.name !== 'AbortError') setError('Save project failed: ' + e.message) }
  }

  // ── Project ZIP upload: new-project vs. overwrite-current wizard ──────────
  async function handleProjectZipFile(file) {
    if (!file) return
    try {
      const zip = await JSZip.loadAsync(file)

      // Read custom SVG files from the ZIP's symbols/ folder
      const customSvgMap = {}
      await Promise.all(
        Object.keys(zip.files)
          .filter(name => name.startsWith('symbols/') && name.endsWith('.svg'))
          .map(async name => {
            const b64 = await zip.files[name].async('base64')
            customSvgMap[`/${name}`] = `data:image/svg+xml;base64,${b64}`
          })
      )
      // ... and background-image files, keyed by the same "/path" convention
      // so the settings.json manifest can point back at them by reference.
      const bgImageMap = {}
      await Promise.all(
        Object.keys(zip.files)
          .filter(n => n.startsWith('background_images/'))
          .map(async name => {
            const ext = name.split('.').pop().toLowerCase()
            const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext}`
            const b64 = await zip.files[name].async('base64')
            bgImageMap[`/${name}`] = `data:${mime};base64,${b64}`
          })
      )

      const readZipFile = async name => {
        const f = zip.file(name); return f ? await f.async('string') : null
      }
      const [settingsText, elemText, pathsText, bgText] = await Promise.all([
        readZipFile('settings.json'),
        readZipFile('elements.csv'),
        readZipFile('beam_paths.csv'),
        readZipFile('background_objects.csv'),
      ])
      setError(null)
      setZipUpload({ fileName: file.name, settingsText, elemText, pathsText, bgText, customSvgMap, bgImageMap })
      setZipStage('choose')
    } catch (e) {
      setError('Load project failed: ' + e.message)
      zipFileRef.current.value = ''
    }
  }

  function cancelZipUpload() {
    setZipUpload(null)
    setZipStage(null)
    setZipNewName('')
    zipFileRef.current.value = ''
  }

  function finishZipUpload() {
    setZipUpload(null)
    setZipStage(null)
    zipFileRef.current.value = ''
  }

  // "Open as New Project": full replace, then persisted as a new, separately-named slot
  function applyZipAsNewProject(name) {
    const trimmed = name.trim() || 'Untitled'
    const { settingsText, elemText, pathsText, bgText, customSvgMap, bgImageMap } = zipUpload

    let newSettings = { ...settings }, newConfig = DEFAULT_CONFIG, newSymbolDefs = { ...DEFAULT_SYMBOL_DEFS }
    let newLayers = { Default: true }, newActiveLayer = 'Default'
    let newBgImages = {}
    if (settingsText) {
      try {
        const { settings: s, config: c, symbolDefs: sd, layers: l, activeLayer: al,
                bgImages: bi } = JSON.parse(settingsText)
        if (s)  newSettings = { ...newSettings, ...s }
        if (c)  newConfig = c
        if (l)  newLayers = l
        if (al) newActiveLayer = al
        if (sd) {
          newSymbolDefs = {}
          for (const [type, def] of Object.entries(sd)) {
            newSymbolDefs[type] = customSvgMap[def.href] ? { ...def, href: customSvgMap[def.href] } : def
          }
        }
        if (bi) {
          for (const [k, img] of Object.entries(bi)) {
            newBgImages[k] = bgImageMap[img.href] ? { ...img, href: bgImageMap[img.href] } : img
          }
        }
      } catch {}
    }

    let newElements = []
    if (elemText) {
      const { elements: parsed, config: parsedCfg } = parseElementsCsv(elemText)
      const { elements: deduped, renamed } = dedupeElementLabels(parsed)
      newElements = deduped
      if (parsedCfg && !settingsText) newConfig = parsedCfg
      newLayers = syncLayersFromElements(deduped, newLayers)
      reportRenamedLabels(renamed)
    }

    let newBeamPaths = {}, newVisiblePaths = {}
    if (pathsText) {
      const { beamPaths: parsed } = parseBeamPathsCsv(pathsText)
      newBeamPaths = parsed
      Object.keys(parsed).forEach(k => { newVisiblePaths[k] = true })
    }

    let newBgGroups = {}, newVisibleBg = {}
    if (bgText) {
      const { bgGroups: parsed } = parseBgObjectsCsv(bgText)
      newBgGroups = parsed
      Object.keys(parsed).forEach(k => { newVisibleBg[k] = true })
    }

    const newState = {
      elements: newElements, overrides: {}, beamPaths: newBeamPaths, bgGroups: newBgGroups,
      visiblePaths: newVisiblePaths, visibleBg: newVisibleBg, bgImages: newBgImages,
      settings: newSettings, config: newConfig,
      symbolDefs: newSymbolDefs, sidebarWidth, layers: newLayers, activeLayer: newActiveLayer,
    }
    applyProjectState(newState)
    saveProjectSlot(trimmed, null, newState)
    cancelZipUpload()
  }

  // "Overwrite Current Project": elements, paths, objects, then settings — one decision at a time
  function startZipOverwriteFlow() {
    setZipStage(null)
    advanceZipQueue(['elements', 'paths', 'objects', 'settings'])
  }

  function advanceZipQueue(queue) {
    if (!queue.length) { finishZipUpload(); return }
    const [kind, ...rest] = queue
    const next = () => advanceZipQueue(rest)

    if (kind === 'settings') {
      if (!zipUpload.settingsText) { next(); return }
      setZipSettingsPrompt({ next })
      return
    }

    if (kind === 'elements') {
      if (!zipUpload.elemText) { next(); return }
      const { elements: parsed, config: parsedCfg, error: err } = parseElementsCsv(zipUpload.elemText)
      if (err && !parsed.length) { setError(err); next(); return }
      if (elements.length) setUploadConflict({ kind: 'elements', parsed, parsedCfg, next })
      else { applyElementsUpload(parsed, parsedCfg, false); next() }
      return
    }
    if (kind === 'paths') {
      if (!zipUpload.pathsText) { next(); return }
      const { beamPaths: parsed } = parseBeamPathsCsv(zipUpload.pathsText)
      if (Object.keys(beamPaths).length) setUploadConflict({ kind: 'paths', parsed, next })
      else { applyPathsUpload(parsed, false); next() }
      return
    }
    if (kind === 'objects') {
      if (!zipUpload.bgText) { next(); return }
      const { bgGroups: parsed, error: err } = parseBgObjectsCsv(zipUpload.bgText)
      if (err) { setError(err); next(); return }
      if (Object.keys(bgGroups).length) setUploadConflict({ kind: 'objects', parsed, next })
      else { applyBgUpload(parsed, false); next() }
    }
  }

  function applyZipSettings() {
    const { next } = zipSettingsPrompt
    const { settingsText, customSvgMap, bgImageMap } = zipUpload
    try {
      const { settings: s, config: c, symbolDefs: sd, layers: l, activeLayer: al,
              bgImages: bi } = JSON.parse(settingsText)
      if (s)  setSettings(prev => ({ ...prev, ...s }))
      if (c)  setConfig(c)
      if (l)  setLayers(l)
      if (al) setActiveLayer(al)
      if (sd) {
        const resolved = {}
        for (const [type, def] of Object.entries(sd)) {
          resolved[type] = customSvgMap[def.href] ? { ...def, href: customSvgMap[def.href] } : def
        }
        setSymbolDefs(resolved)
      }
      if (bi) {
        const resolved = {}
        for (const [k, img] of Object.entries(bi)) {
          resolved[k] = bgImageMap[img.href] ? { ...img, href: bgImageMap[img.href] } : img
        }
        setBgImages(resolved)
      }
    } catch {}
    setZipSettingsPrompt(null)
    next()
  }

  function skipZipSettings() {
    const { next } = zipSettingsPrompt
    setZipSettingsPrompt(null)
    next()
  }

  // ── File I/O ───────────────────────────────────────────────────────────────
  function loadElementsFile(file) {
    if (!file) return
    const reader = new FileReader()
    reader.onload = e => {
      const { elements: parsed, config: parsedCfg, error: parseErr } = parseElementsCsv(e.target.result)
      if (parseErr && !parsed.length) { setError(parseErr); return }
      setError(null)
      if (elements.length) setUploadConflict({ kind: 'elements', parsed, parsedCfg })
      else applyElementsUpload(parsed, parsedCfg, false)
    }
    reader.readAsText(file)
    elemFileRef.current.value = ''
  }

  function loadPathsFile(file) {
    if (!file) return
    const reader = new FileReader()
    reader.onload = e => {
      const { beamPaths: parsed } = parseBeamPathsCsv(e.target.result)
      if (Object.keys(beamPaths).length) setUploadConflict({ kind: 'paths', parsed })
      else applyPathsUpload(parsed, false)
    }
    reader.readAsText(file)
    pathFileRef.current.value = ''
  }

  function loadBgFile(file) {
    if (!file) return
    const reader = new FileReader()
    reader.onload = e => {
      const { bgGroups: parsed, error: parseErr } = parseBgObjectsCsv(e.target.result)
      if (parseErr) { setError(parseErr); return }
      if (Object.keys(bgGroups).length) setUploadConflict({ kind: 'objects', parsed })
      else applyBgUpload(parsed, false)
    }
    reader.readAsText(file)
    bgFileRef.current.value = ''
  }

  // Appending re-labels any incoming element whose label collides with an existing one.
  function applyElementsUpload(parsed, parsedCfg, append) {
    if (append) {
      pushHistory()
      const { elements: relabeled, renamed } = dedupeElementLabels(parsed, elements.map(el => el.label))
      setElements(els => [...els, ...relabeled])
      setLayers(prev => syncLayersFromElements(parsed, prev))
      reportRenamedLabels(renamed)
    } else {
      // A replace still has to guard against duplicates *within* the uploaded file.
      const { elements: deduped, renamed } = dedupeElementLabels(parsed)
      setElements(deduped)
      if (parsedCfg) setConfig(parsedCfg)
      setLayers(prev => syncLayersFromElements(deduped, prev))
      setSelectedLabels(new Set()); setOverrides({}); setHistory([])
      reportRenamedLabels(renamed)
    }
    setUploadConflict(null)
  }

  // Tell the user when an import silently had to rename rows to keep O-numbers unique.
  function reportRenamedLabels(renamed) {
    if (!renamed?.length) return
    const shown = renamed.slice(0, 5).map(([from, to]) => `${from} → ${to}`).join(', ')
    const more = renamed.length > 5 ? `, and ${renamed.length - 5} more` : ''
    setNotice(`Renamed ${renamed.length} duplicate O-number${renamed.length !== 1 ? 's' : ''} in the imported file: ${shown}${more}.`)
  }

  // Appending merges edges into any path with a matching name, otherwise adds the path.
  function applyPathsUpload(parsed, append) {
    if (append) {
      pushHistory()
      setBeamPaths(bp => {
        const next = { ...bp }
        Object.entries(parsed).forEach(([name, data]) => {
          next[name] = next[name]
            ? { ...next[name], edges: [...(next[name].edges ?? []), ...(data.edges ?? [])] }
            : data
        })
        return next
      })
      setVisiblePaths(vp => {
        const next = { ...vp }
        Object.keys(parsed).forEach(name => { if (!(name in next)) next[name] = true })
        return next
      })
    } else {
      setBeamPaths(parsed)
      setEditingPath(null)
      const vis = {}; Object.keys(parsed).forEach(k => { vis[k] = true })
      setVisiblePaths(vis)
    }
    setUploadConflict(null)
  }

  // Appending merges edges into any group with a matching name, otherwise adds the group.
  function applyBgUpload(parsed, append) {
    if (append) {
      pushHistory()
      setBgGroups(g => {
        const next = { ...g }
        Object.entries(parsed).forEach(([name, data]) => {
          next[name] = next[name]
            ? { ...next[name], edges: [...(next[name].edges ?? []), ...(data.edges ?? [])] }
            : data
        })
        return next
      })
      setVisibleBg(v => {
        const next = { ...v }
        Object.keys(parsed).forEach(name => { if (!(name in next)) next[name] = true })
        return next
      })
    } else {
      setBgGroups(parsed)
      setEditingBgGroup(null)
      const vis = {}; Object.keys(parsed).forEach(k => { vis[k] = true })
      setVisibleBg(vis)
    }
    setUploadConflict(null)
  }

  // `next`, when present, continues a multi-file project-ZIP upload after this decision.
  function resolveUploadConflict(append) {
    if (!uploadConflict) return
    const { kind, parsed, parsedCfg, next } = uploadConflict
    if (kind === 'elements' && append) {
      const existingLabels = new Set(elements.map(el => el.label))
      const collidingCount = parsed.filter(el => existingLabels.has(el.label)).length
      if (collidingCount > 0) {
        setUploadConflict(null)
        setLabelCollisionPrompt({ parsed, parsedCfg, count: collidingCount, next })
        return
      }
    }
    if (kind === 'elements') applyElementsUpload(parsed, parsedCfg, append)
    else if (kind === 'paths') applyPathsUpload(parsed, append)
    else if (kind === 'objects') applyBgUpload(parsed, append)
    next?.()
  }

  function dismissUploadConflict() {
    const next = uploadConflict?.next
    setUploadConflict(null)
    next?.()
  }

  // ── O-number collision resolution (element append only) ───────────────────
  function autoResolveLabelCollisions() {
    const { parsed, parsedCfg, next } = labelCollisionPrompt
    setLabelCollisionPrompt(null)
    applyElementsUpload(parsed, parsedCfg, true)
    next?.()
  }

  function dismissLabelCollisionPrompt() {
    const next = labelCollisionPrompt?.next
    setLabelCollisionPrompt(null)
    next?.()
  }

  function startManualLabelResolve() {
    const { parsed, parsedCfg, next } = labelCollisionPrompt
    const usedLabels = new Set(elements.map(el => el.label))
    const queue = []
    parsed.forEach((el, i) => { if (usedLabels.has(el.label)) queue.push(i) })
    setLabelCollisionPrompt(null)
    const firstIdx = queue[0]
    setManualRelabel({
      parsed, parsedCfg, next,
      resolvedLabels: parsed.map(el => el.label),
      queue, step: 0, usedLabels,
      value: suggestAltLabel(parsed[firstIdx].label, usedLabels),
    })
  }

  function confirmManualRelabelStep() {
    if (!manualRelabel) return
    const { parsed, parsedCfg, next, resolvedLabels, queue, step, usedLabels, value } = manualRelabel
    const trimmed = value.trim()
    if (!trimmed || usedLabels.has(trimmed)) return
    const nextUsed = new Set(usedLabels); nextUsed.add(trimmed)
    const nextResolved = [...resolvedLabels]; nextResolved[queue[step]] = trimmed
    const nextStep = step + 1
    if (nextStep >= queue.length) {
      const finalElements = parsed.map((el, i) => ({ ...el, label: nextResolved[i] }))
      setManualRelabel(null)
      applyElementsUpload(finalElements, parsedCfg, true)
      next?.()
      return
    }
    setManualRelabel({
      parsed, parsedCfg, next, resolvedLabels: nextResolved, queue, step: nextStep, usedLabels: nextUsed,
      value: suggestAltLabel(parsed[queue[nextStep]].label, nextUsed),
    })
  }

  function dismissManualRelabel() {
    const next = manualRelabel?.next
    setManualRelabel(null)
    next?.()
  }

  // ── Drag-and-drop upload ────────────────────────────────────────────────────
  function applyInferredCsv(kind, file) {
    if (kind === 'elements') loadElementsFile(file)
    else if (kind === 'paths') loadPathsFile(file)
    else if (kind === 'objects') loadBgFile(file)
  }

  function handleDroppedFile(file) {
    const ext = file.name.toLowerCase().split('.').pop()
    if (ext === 'zip')  { handleProjectZipFile(file); return }
    if (ext === 'json') { loadSettingsFile(file); return }
    if (ext !== 'csv') { setError(`Unsupported file "${file.name}" — drop a .csv, .json, or .zip file.`); return }

    const byName = inferCsvKindFromName(file.name)
    if (byName) { applyInferredCsv(byName, file); return }

    const reader = new FileReader()
    reader.onload = e => {
      const byHeader = inferCsvKindFromHeader(e.target.result)
      if (byHeader) applyInferredCsv(byHeader, file)
      else setDropAmbiguous({ file })
    }
    reader.readAsText(file)
  }

  // dataTransfer.types is unreliable across browsers on dragover — Safari and
  // some Chrome versions omit 'Files' during hover and only add it on drop.
  // Missing preventDefault on dragover lets the browser's default kick in
  // (opening JSON in a new tab). Just always preventDefault on both events
  // and let handleDrop filter to actual files.
  function handleDragEnter(e) {
    e.preventDefault()
    dragCounterRef.current++
    setDragActive(true)
  }
  function handleDragOver(e) {
    e.preventDefault()
  }
  function handleDragLeave(e) {
    e.preventDefault()
    dragCounterRef.current = Math.max(0, dragCounterRef.current - 1)
    if (dragCounterRef.current === 0) setDragActive(false)
  }
  function handleDrop(e) {
    e.preventDefault()
    dragCounterRef.current = 0
    setDragActive(false)
    Array.from(e.dataTransfer.files || []).forEach(handleDroppedFile)
  }

  async function saveElementsCSV() {
    const csv = serializeElementsCsv(elements, overrides, config)
    await triggerSave(new Blob([csv], { type: 'text/csv' }), 'elements.csv', 'text/csv', 'csv')
  }

  async function savePathsCSV() {
    const csv = serializeBeamPathsCsv(beamPaths)
    await triggerSave(new Blob([csv], { type: 'text/csv' }), 'beam_paths.csv', 'text/csv', 'csv')
  }

  async function saveBgCSV() {
    const csv = serializeBgObjectsCsv(bgGroups)
    await triggerSave(new Blob([csv], { type: 'text/csv' }), 'background_objects.csv', 'text/csv', 'csv')
  }

  async function handleExportPDF() {
    try { await canvasRef.current?.exportPDF(currentProjectName) }
    catch (e) { setError('PDF export failed: ' + e.message) }
  }

  function togglePath(name) { setVisiblePaths(v => ({ ...v, [name]: !v[name] })) }
  function toggleAll(val) {
    const vis = {}; Object.keys(beamPaths).forEach(k => { vis[k] = val })
    setVisiblePaths(vis)
  }
  function toggleBgGroup(name) { setVisibleBg(v => ({ ...v, [name]: !v[name] })) }
  function toggleAllBg(val) {
    const vis = {}; Object.keys(bgGroups).forEach(k => { vis[k] = val })
    setVisibleBg(vis)
  }

  // ── Spreadsheet view data ──────────────────────────────────────────────────
  const elemRows = useMemo(() =>
    allMergedElements.map(el => ({ ...el, _key: el.label })),
    [allMergedElements]
  )

  const elemColumns = useMemo(() => [
    { key: 'label',       label: 'Label',     width: 70  },
    { key: 'type',        label: 'Type',       width: 150 },
    { key: 'x',           label: 'X',          type: 'number', width: 60  },
    { key: 'y',           label: 'Y',          type: 'number', width: 60  },
    { key: 'orientation', label: 'Orient °',   type: 'number', width: 60  },
    { key: 'in_design',   label: 'In Design',  type: 'boolean', width: 70 },
    { key: 'Layer',       label: 'Layer',       width: 100 },
    ...allMetaKeys.map(k => ({ key: k, label: k, width: 110, headerEditable: true })),
  ], [allMetaKeys])

  const beamPathRows = useMemo(() => {
    const rows = []
    Object.entries(beamPaths).sort(([a], [b]) => a.localeCompare(b)).forEach(([name, { color, edges }]) => {
      ;(edges ?? []).forEach(([src, dest], idx) => {
        rows.push({ _key: `${name}__${idx}`, _pathName: name, _edgeIdx: idx, name, color, src, dest })
      })
    })
    return rows
  }, [beamPaths])

  const PATH_COLUMNS = [
    { key: 'name',  label: 'Name',  width: 150, readOnly: true, dim: true },
    { key: 'color', label: 'Color', type: 'color', width: 50, readOnly: true },
    { key: 'src',   label: 'Src',   width: 80  },
    { key: 'dest',  label: 'Dest',  width: 80  },
  ]

  const bgObjectRows = useMemo(() => {
    const rows = []
    Object.entries(bgGroups).sort(([a], [b]) => a.localeCompare(b)).forEach(([group, { color, strokeWidth, edges }]) => {
      ;(edges ?? []).forEach(([x1, y1, x2, y2], idx) => {
        rows.push({ _key: `${group}__${idx}`, _groupName: group, _edgeIdx: idx, group, color, strokeWidth: strokeWidth ?? 2, x1, y1, x2, y2 })
      })
    })
    return rows
  }, [bgGroups])

  const BG_COLUMNS = [
    { key: 'group',       label: 'Group',  width: 130, readOnly: true, dim: true },
    { key: 'color',       label: 'Color',  type: 'color',  width: 50, readOnly: true },
    { key: 'strokeWidth', label: 'Stroke', type: 'number', width: 58 },
    { key: 'x1', label: 'x1', type: 'number', width: 70 },
    { key: 'y1', label: 'y1', type: 'number', width: 70 },
    { key: 'x2', label: 'x2', type: 'number', width: 70 },
    { key: 'y2', label: 'y2', type: 'number', width: 70 },
  ]

  // ── Spreadsheet edit handlers ──────────────────────────────────────────────
  function renameElement(oldLabel, newLabel) {
    const trimmed = newLabel.trim()
    if (trimmed === oldLabel) return
    // Previously these rejections were silent, so a duplicate rename looked like
    // nothing happened. Say why instead.
    if (!trimmed) {
      setError('An O-number cannot be blank.')
      return
    }
    if (elements.some(el => el.label === trimmed)) {
      setError(`O-number "${trimmed}" is already in use — rename that element first.`)
      return
    }
    pushHistory()
    setElements(els => els.map(el => el.label === oldLabel ? { ...el, label: trimmed } : el))
    setOverrides(ov => {
      const n = { ...ov }
      if (n[oldLabel]) { n[trimmed] = n[oldLabel]; delete n[oldLabel] }
      return n
    })
    setSelectedLabels(prev => {
      const next = new Set(prev)
      if (next.has(oldLabel)) { next.delete(oldLabel); next.add(trimmed) }
      return next
    })
    // Beam path edges reference elements by label — repoint them, or the edge
    // dangles and the beam silently vanishes from the diagram.
    setBeamPaths(bp => {
      let changed = false
      const next = {}
      for (const [name, path] of Object.entries(bp)) {
        const edges = (path.edges ?? []).map(([s, d]) => {
          if (s !== oldLabel && d !== oldLabel) return [s, d]
          changed = true
          return [s === oldLabel ? trimmed : s, d === oldLabel ? trimmed : d]
        })
        next[name] = { ...path, edges }
      }
      return changed ? next : bp
    })
  }

  const CORE_COL_SET = new Set(['label', 'type', 'x', 'y', 'orientation', 'in_design'])

  function addMetaColumn(key) {
    const trimmed = key.trim()
    if (!trimmed || CORE_COL_SET.has(trimmed.toLowerCase()) || allMetaKeys.includes(trimmed)) return
    pushHistory()
    setElements(els => els.map(el => ({ ...el, [trimmed]: el[trimmed] ?? '' })))
  }

  function renameMetaColumn(oldKey, newKey) {
    const trimmed = newKey.trim()
    if (!trimmed || trimmed === oldKey || CORE_COL_SET.has(trimmed.toLowerCase()) || allMetaKeys.includes(trimmed)) return
    pushHistory()
    setElements(els => els.map(el => {
      if (!(oldKey in el)) return el
      const { [oldKey]: val, ...rest } = el
      return { ...rest, [trimmed]: val }
    }))
    setOverrides(ov => {
      const n = {}
      for (const [label, patch] of Object.entries(ov)) {
        if (oldKey in patch) {
          const { [oldKey]: val, ...rest } = patch
          n[label] = { ...rest, [trimmed]: val }
        } else {
          n[label] = patch
        }
      }
      return n
    })
  }

  function deleteMetaColumn(key) {
    pushHistory()
    setElements(els => els.map(el => { const { [key]: _, ...rest } = el; return rest }))
    setOverrides(ov => {
      const n = {}
      for (const [label, patch] of Object.entries(ov)) {
        const { [key]: _, ...rest } = patch
        n[label] = rest
      }
      return n
    })
  }

  function handleElemCellChange(row, key, value) {
    if (key === 'label') renameElement(row.label, value)
    else updateElementField(row.label, key, value)
  }

  function handleElemDeleteRow(row) {
    pushHistory()
    setElements(els => els.filter(el => el.label !== row.label))
    setOverrides(ov => { const n = { ...ov }; delete n[row.label]; return n })
    setSelectedLabels(prev => { const next = new Set(prev); next.delete(row.label); return next })
  }

  function handleElemAddRow() {
    const label = nextOLabel(elements)
    const ox = config.origin_x ?? 0, oy = config.origin_y ?? 0
    addElement({ type: '', x: Math.round((ox + config.table_length / 2) * 2) / 2, y: Math.round((oy + config.table_width / 2) * 2) / 2, label })
  }

  function handlePathCellChange(row, key, value) {
    const { _pathName, _edgeIdx } = row
    if (key === 'color') {
      pushHistory()
      setBeamPaths(bp => ({ ...bp, [_pathName]: { ...bp[_pathName], color: value } }))
    } else if (key === 'name' && value.trim() && value.trim() !== _pathName) {
      const trimmed = value.trim()
      const edge = (beamPaths[_pathName]?.edges ?? [])[_edgeIdx] ?? ['', '']
      const oldEdgesAfter = (beamPaths[_pathName]?.edges ?? []).filter((_, i) => i !== _edgeIdx)
      const isNewPath = !beamPaths[trimmed]
      pushHistory()
      setBeamPaths(bp => {
        const n = { ...bp }
        const kept = (n[_pathName]?.edges ?? []).filter((_, i) => i !== _edgeIdx)
        if (!kept.length) delete n[_pathName]; else n[_pathName] = { ...n[_pathName], edges: kept }
        if (!n[trimmed]) n[trimmed] = { color: row.color, edges: [] }
        n[trimmed] = { ...n[trimmed], edges: [...n[trimmed].edges, edge] }
        return n
      })
      if (isNewPath)          setVisiblePaths(v => ({ ...v, [trimmed]: true }))
      if (!oldEdgesAfter.length) setVisiblePaths(v => { const n = { ...v }; delete n[_pathName]; return n })
    } else if (key === 'src' || key === 'dest') {
      pushHistory()
      setBeamPaths(bp => {
        const path = bp[_pathName]
        const edges = [...(path?.edges ?? [])]
        const [s, d] = edges[_edgeIdx] ?? ['', '']
        edges[_edgeIdx] = key === 'src' ? [value, d] : [s, value]
        return { ...bp, [_pathName]: { ...path, edges } }
      })
    }
  }

  function handlePathDeleteRow(row) {
    const { _pathName, _edgeIdx } = row
    pushHistory()
    setBeamPaths(bp => {
      const path = bp[_pathName]
      if (!path) return bp
      return { ...bp, [_pathName]: { ...path, edges: (path.edges ?? []).filter((_, i) => i !== _edgeIdx) } }
    })
  }

  function handlePathAddRow() {
    const names = Object.keys(beamPaths).sort()
    pushHistory()
    if (!names.length) {
      setBeamPaths(bp => ({ ...bp, 'New Path': { color: '#4a90d9', edges: [['', '']] } }))
      setVisiblePaths(v => ({ ...v, 'New Path': true }))
    } else {
      const first = names[0]
      setBeamPaths(bp => ({ ...bp, [first]: { ...bp[first], edges: [...(bp[first].edges ?? []), ['', '']] } }))
    }
  }

  function handleBgCellChange(row, key, value) {
    const { _groupName, _edgeIdx } = row
    if (key === 'color') {
      pushHistory(); setBgGroupColor(_groupName, value)
    } else if (key === 'strokeWidth') {
      pushHistory(); setBgGroupStroke(_groupName, parseFloat(value) || 1)
    } else if (key === 'group' && value.trim() && value.trim() !== _groupName) {
      const trimmed = value.trim()
      const edge = (bgGroups[_groupName]?.edges ?? [])[_edgeIdx] ?? [0, 0, 0, 0]
      const oldEdgesAfter = (bgGroups[_groupName]?.edges ?? []).filter((_, i) => i !== _edgeIdx)
      const isNewGroup = !bgGroups[trimmed]
      pushHistory()
      setBgGroups(g => {
        const n = { ...g }
        const kept = (n[_groupName]?.edges ?? []).filter((_, i) => i !== _edgeIdx)
        if (!kept.length) delete n[_groupName]; else n[_groupName] = { ...n[_groupName], edges: kept }
        if (!n[trimmed]) n[trimmed] = { color: row.color, strokeWidth: row.strokeWidth, edges: [] }
        n[trimmed] = { ...n[trimmed], edges: [...n[trimmed].edges, edge] }
        return n
      })
      if (isNewGroup)           setVisibleBg(v => ({ ...v, [trimmed]: true }))
      if (!oldEdgesAfter.length) setVisibleBg(v => { const n = { ...v }; delete n[_groupName]; return n })
    } else if (['x1', 'y1', 'x2', 'y2'].includes(key)) {
      updateBgEdge(_groupName, _edgeIdx, { [key]: parseFloat(value) || 0 })
    }
  }

  function handleBgDeleteRow(row) { deleteBgEdge(row._groupName, row._edgeIdx) }

  function handleBgAddRow() {
    const names = Object.keys(bgGroups).sort()
    if (!names.length) {
      pushHistory()
      setBgGroups(g => ({ ...g, 'New Group': { color: '#888888', strokeWidth: 2, edges: [[0, 0, 0, 0]] } }))
      setVisibleBg(v => ({ ...v, 'New Group': true }))
    } else {
      addBgEdge(names[0], 0, 0, 0, 0)
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="app"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {dragActive && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 500,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'color-mix(in srgb, var(--bg-sidebar) 85%, transparent)',
          border: '3px dashed var(--accent-bright)', boxSizing: 'border-box',
          pointerEvents: 'none', fontSize: 18, fontWeight: 600, color: 'var(--text)',
        }}>
          Drop a .csv, .json, or .zip file to upload
        </div>
      )}
      <header className="app-header">
        <span className="app-title">👁️ Optical Table Designer</span>
        {currentProjectName && <span className="project-name-badge">{currentProjectName}</span>}
        {currentCloudProject && <span className="project-name-badge">☁ {currentCloudProject.name}</span>}
        <div className="header-controls">
          <a className="file-btn" href="https://github.com/henryando/OpticalDesigner" target="_blank" rel="noreferrer">GitHub</a>
          {supabase && (
            session ? (
              <>
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{session.user.email}</span>
                <button className="file-btn" onClick={logOutCloud}>Log out</button>
              </>
            ) : (
              <button className="file-btn" onClick={() => setAuthModalOpen(true)}>Log in</button>
            )
          )}
          <div className="file-menu" ref={fileMenuRef}>
            <button className="file-btn" onClick={() => setFileMenuOpen(o => !o)}>File ▾</button>
            {fileMenuOpen && (
              <div className="file-menu-dropdown">
                <div className="file-menu-label">Upload</div>
                <button className="file-menu-item" onClick={() => { elemFileRef.current.click(); setFileMenuOpen(false) }}>Upload Elements…</button>
                <button className="file-menu-item" onClick={() => { pathFileRef.current.click(); setFileMenuOpen(false) }}>Upload Paths…</button>
                <button className="file-menu-item" onClick={() => { bgFileRef.current.click(); setFileMenuOpen(false) }}>Upload Objects…</button>
                <button className="file-menu-item" onClick={() => { settingsFileRef.current.click(); setFileMenuOpen(false) }}>Upload Settings…</button>
                <button className="file-menu-item" onClick={() => { zipFileRef.current.click(); setFileMenuOpen(false) }}>Upload Project…</button>
                <div className="file-menu-sep" />
                <div className="file-menu-label">Download</div>
                <button className="file-menu-item" onClick={() => { saveElementsCSV(); setFileMenuOpen(false) }} disabled={!effectiveElements.length}>Download Elements</button>
                <button className="file-menu-item" onClick={() => { savePathsCSV(); setFileMenuOpen(false) }} disabled={!Object.keys(beamPaths).length}>Download Paths</button>
                <button className="file-menu-item" onClick={() => { saveBgCSV(); setFileMenuOpen(false) }} disabled={!Object.keys(bgGroups).length}>Download Objects</button>
                <button className="file-menu-item" onClick={() => { saveSettingsJSON(); setFileMenuOpen(false) }}>Download Settings</button>
                <button className="file-menu-item" onClick={() => { saveProject(); setFileMenuOpen(false) }}>Download Project</button>
                <div className="file-menu-sep" />
                <div className="file-menu-label">Projects</div>
                <button className="file-menu-item" onClick={() => { setNewProjName(''); setNewProjPromptOpen(true); setFileMenuOpen(false) }}>New Project…</button>
                <button className="file-menu-item" onClick={() => { setProjectsModalOpen(true); setFileMenuOpen(false) }}>Switch Project…</button>
                <button className="file-menu-item" onClick={() => { setSaveAsProjName(currentProjectName ?? ''); setSaveAsPromptOpen(true); setFileMenuOpen(false) }}>Rename Project…</button>
                <button className="file-menu-item" onClick={() => { setDupProjName(currentProjectName ? `${currentProjectName} copy` : ''); setDupProjPromptOpen(true); setFileMenuOpen(false) }}>Save Project As…</button>
                {supabase && (
                  <>
                    <div className="file-menu-sep" />
                    <div className="file-menu-label">Cloud</div>
                    {!session ? (
                      <button className="file-menu-item" onClick={() => { setAuthModalOpen(true); setFileMenuOpen(false) }}>Log in to use Cloud Projects…</button>
                    ) : (
                      <>
                        <button className="file-menu-item" onClick={() => { setCloudError(null); setCloudProjectsModalOpen(true); setFileMenuOpen(false) }}>Open Cloud Project…</button>
                        <button className="file-menu-item" onClick={() => { setSaveToCloudName(currentCloudProject?.name ?? currentProjectName ?? ''); setCloudError(null); setSaveToCloudPromptOpen(true); setFileMenuOpen(false) }}>Save to Cloud…</button>
                        {currentCloudProject && (
                          <button className="file-menu-item" disabled={cloudBusy}
                            onClick={() => { updateCurrentCloudProject(); setFileMenuOpen(false) }}>Save to Cloud (update)</button>
                        )}
                      </>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
          <div className="file-menu" ref={viewMenuRef}>
            <button className="file-btn" onClick={() => setViewMenuOpen(o => !o)}>View ▾</button>
            {viewMenuOpen && (
              <div className="file-menu-dropdown">
                <button className="file-menu-item" onClick={() => { setViewModal('elements'); setViewMenuOpen(false) }}>Elements</button>
                <button className="file-menu-item" onClick={() => { setViewModal('paths'); setViewMenuOpen(false) }}>Beam Paths</button>
                <button className="file-menu-item" onClick={() => { setViewModal('objects'); setViewMenuOpen(false) }}>Background Objects</button>
                <div className="file-menu-sep" />
                <button className="file-menu-item"
                  onClick={() => setSettings(prev => ({ ...prev, highlightOrphans: !prev.highlightOrphans }))}>
                  {settings.highlightOrphans ? '✓ ' : '  '}Highlight orphaned elements
                </button>
              </div>
            )}
          </div>
          <div className="file-menu" ref={transformMenuRef}>
            <button className="file-btn" onClick={() => setTransformMenuOpen(o => !o)}>Transform ▾</button>
            {transformMenuOpen && (
              <div className="file-menu-dropdown">
                <div className="file-menu-label">Rotate whole project</div>
                <button className="file-menu-item" onClick={() => { transformProject('rotateCCW'); setTransformMenuOpen(false) }}>↺ Rotate 90° left</button>
                <button className="file-menu-item" onClick={() => { transformProject('rotateCW');  setTransformMenuOpen(false) }}>↻ Rotate 90° right</button>
                <div className="file-menu-sep" />
                <div className="file-menu-label">Flip whole project</div>
                <button className="file-menu-item" onClick={() => { transformProject('flipH'); setTransformMenuOpen(false) }}>↔ Flip horizontal</button>
                <button className="file-menu-item" onClick={() => { transformProject('flipV'); setTransformMenuOpen(false) }}>↕ Flip vertical</button>
              </div>
            )}
          </div>
          <span className="hdr-sep" />
          <button className="file-btn file-btn-accent" onClick={handleExportPDF} disabled={!effectiveElements.length}>Export PDF</button>
        </div>
      </header>

      {error && (
        <div className="gen-banner gen-banner-error">
          <pre>{error}</pre>
          <button onClick={() => setError(null)}>✕</button>
        </div>
      )}

      {notice && (
        <div className="gen-banner">
          <pre>{notice}</pre>
          <button onClick={() => setNotice(null)}>✕</button>
        </div>
      )}

      {cloudError && (
        <div className="gen-banner gen-banner-error">
          <pre>{cloudError}</pre>
          <button onClick={() => setCloudError(null)}>✕</button>
        </div>
      )}

      <div className="app-body" style={{ position: 'relative' }}>
        {searchOpen && (
          <div style={{
            position: 'absolute', top: 8, right: 8, zIndex: 200,
            display: 'flex', alignItems: 'center', gap: 6,
            background: 'var(--bg-sidebar)', border: '1px solid var(--border-side)',
            borderRadius: 5, padding: '4px 8px', boxShadow: '0 2px 8px #0004',
          }}>
            <input ref={searchInputRef}
              className="snap-input"
              style={{ width: 200 }}
              placeholder="Search label or type…"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Escape') { setSearchOpen(false); setSearchQuery('') }
              }} />
            {searchHighlights && (
              <span style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                {searchHighlights.size} match{searchHighlights.size !== 1 ? 'es' : ''}
              </span>
            )}
            <button className="small-btn" onClick={() => { setSearchOpen(false); setSearchQuery('') }}>✕</button>
          </div>
        )}
        <OpticalCanvas
          ref={canvasRef}
          elements={effectiveElements}
          beamPaths={beamPaths}
          visiblePaths={visiblePaths}
          bgGroups={bgGroups}
          visibleBg={visibleBg}
          config={config}
          selectedLabels={selectedLabels}
          selectedElement={selectedElement}
          onSelectLabel={handleSelectLabel}
          onSelectLabels={setSelectedLabels}
          onStartEdit={startEdit}
          onUpdateEdit={updateEdit}
          onDeleteSelected={deleteSelected}
          onHardDeleteSelected={hardDeleteSelected}
          editingPath={editingPath}
          onAddEdge={addEdge}
          onDeleteEdge={deleteEdge}
          onSetEditingPath={setEditingPath}
          editingBgGroup={editingBgGroup}
          onAddBgEdge={addBgEdge}
          onDeleteBgEdge={deleteBgEdge}
          onAddBgLabel={addBgLabel}
          onDeleteBgLabel={deleteBgLabel}
          pendingBgLabelText={pendingBgLabelText}
          onSetPendingBgLabelText={setPendingBgLabelText}
          onSetEditingBgGroup={setEditingBgGroup}
          bgImages={bgImages}
          onUpdateBgImage={updateBgImage}
          onStartBgImageEdit={pushHistory}
          editingBgImage={editingBgImage}
          onSetEditingBgImage={setEditingBgImage}
          symbolDefs={symbolDefs}
          settings={settings}
          searchHighlights={searchHighlights}
          onCursorMove={pos => { cursorPosRef.current = pos }}
        />
        <div
          onMouseDown={startSidebarResize}
          style={{
            width: 4, flexShrink: 0, cursor: 'col-resize', zIndex: 10,
            background: 'transparent', transition: 'background 0.15s',
          }}
          onMouseEnter={e => e.currentTarget.style.background = 'var(--accent-bright)'}
          onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
        />
        <Sidebar
          sidebarWidth={sidebarWidth}
          beamPaths={beamPaths}
          visiblePaths={visiblePaths}
          onToggle={togglePath}
          onToggleAll={toggleAll}
          onAddPath={addBeamPath}
          onDeletePath={deleteBeamPath}
          onSetPathColor={setPathColor}
          onRenamePath={renameBeamPath}
          selectedLabels={selectedLabels}
          selectedElement={selectedElement}
          allMetaKeys={allMetaKeys}
          onUpdateElement={updateElementField}
          onRenameElement={renameElement}
          editingPath={editingPath}
          onSetEditingPath={setEditingPath}
          onDeleteEdge={deleteEdge}
          bgGroups={bgGroups}
          visibleBg={visibleBg}
          onToggleBg={toggleBgGroup}
          onToggleAllBg={toggleAllBg}
          onAddBgGroup={addBgGroup}
          onDeleteBgGroup={deleteBgGroup}
          onSetBgGroupColor={setBgGroupColor}
          onSetBgGroupStroke={setBgGroupStroke}
          onRenameBgGroup={renameBgGroup}
          editingBgGroup={editingBgGroup}
          onSetEditingBgGroup={setEditingBgGroup}
          onDeleteBgEdge={deleteBgEdge}
          onUpdateBgEdge={updateBgEdge}
          onAddBgLabel={addBgLabel}
          onDeleteBgLabel={deleteBgLabel}
          onUpdateBgLabel={updateBgLabel}
          pendingBgLabelText={pendingBgLabelText}
          onSetPendingBgLabelText={setPendingBgLabelText}
          bgImages={bgImages}
          onAddBgImage={addBgImage}
          onDeleteBgImage={deleteBgImage}
          onUpdateBgImage={updateBgImage}
          onRenameBgImage={renameBgImage}
          editingBgImage={editingBgImage}
          onSetEditingBgImage={setEditingBgImage}
          config={config}
          onConfigChange={setConfig}
          settings={settings}
          onSettingsChange={setSettings}
          symbolDefs={symbolDefs}
          onAddSymbolDef={addSymbolDef}
          onUpdateSymbolDef={updateSymbolDef}
          onDeleteSymbolDef={deleteSymbolDef}
          onRenameSymbolDef={renameSymbolDef}
          onSelectElement={handleSelectLabel}
          elements={allMergedElements}
          onAddElement={addElement}
          lastAddedTypeRef={lastAddedTypeRef}
          addElemAt={addElemAt}
          onAddElemAtDone={() => setAddElemAt(null)}
          tab={sidebarTab}
          onTabChange={setSidebarTab}
          layers={layers}
          activeLayer={activeLayer}
          onSetActiveLayer={setActiveLayer}
          onAddLayer={addLayer}
          onDeleteLayer={deleteLayer}
          onSetLayerVisible={setLayerVisible}
          onRenameLayer={renameLayer}
        />
      </div>

      {viewModal === 'elements' && (
        <SpreadsheetModal title="Elements" columns={elemColumns} rows={elemRows}
          onCellChange={handleElemCellChange} onDeleteRow={handleElemDeleteRow} onAddRow={handleElemAddRow}
          onRenameColumn={renameMetaColumn} onDeleteColumn={deleteMetaColumn} onAddColumn={addMetaColumn}
          onClose={() => setViewModal(null)} />
      )}
      {viewModal === 'paths' && (
        <SpreadsheetModal title="Beam Paths" columns={PATH_COLUMNS} rows={beamPathRows}
          onCellChange={handlePathCellChange} onDeleteRow={handlePathDeleteRow} onAddRow={handlePathAddRow}
          onClose={() => setViewModal(null)} />
      )}
      {viewModal === 'objects' && (
        <SpreadsheetModal title="Background Objects" columns={BG_COLUMNS} rows={bgObjectRows}
          onCellChange={handleBgCellChange} onDeleteRow={handleBgDeleteRow} onAddRow={handleBgAddRow}
          onClose={() => setViewModal(null)} />
      )}

      {/* ── New Project prompt ──────────────────────────────────────────────── */}
      {newProjPromptOpen && (
        <div className="modal-backdrop" onClick={() => setNewProjPromptOpen(false)}>
          <div className="modal-box" onClick={e => e.stopPropagation()}>
            <div className="modal-title">New Project</div>
            <input className="snap-input" style={{ width: '100%', boxSizing: 'border-box' }}
              placeholder="Project name"
              value={newProjName}
              onChange={e => setNewProjName(e.target.value)}
              autoFocus
              onKeyDown={e => {
                if (e.key === 'Enter') startNewProject(newProjName)
                if (e.key === 'Escape') setNewProjPromptOpen(false)
              }} />
            <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
              <button className="small-btn" onClick={() => startNewProject(newProjName)}>Create</button>
              <button className="small-btn" onClick={() => setNewProjPromptOpen(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Save As Project prompt ───────────────────────────────────────────── */}
      {saveAsPromptOpen && (
        <div className="modal-backdrop" onClick={() => setSaveAsPromptOpen(false)}>
          <div className="modal-box" onClick={e => e.stopPropagation()}>
            <div className="modal-title">Rename Project</div>
            <input className="snap-input" style={{ width: '100%', boxSizing: 'border-box' }}
              placeholder="Project name"
              value={saveAsProjName}
              onChange={e => setSaveAsProjName(e.target.value)}
              autoFocus
              onKeyDown={e => {
                if (e.key === 'Enter') { saveProjectSlot(saveAsProjName, currentProjectId); setSaveAsPromptOpen(false) }
                if (e.key === 'Escape') setSaveAsPromptOpen(false)
              }} />
            <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
              <button className="small-btn" onClick={() => { saveProjectSlot(saveAsProjName, currentProjectId); setSaveAsPromptOpen(false) }}>Rename</button>
              <button className="small-btn" onClick={() => setSaveAsPromptOpen(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Save Project As (duplicate) prompt ───────────────────────────────── */}
      {dupProjPromptOpen && (
        <div className="modal-backdrop" onClick={() => setDupProjPromptOpen(false)}>
          <div className="modal-box" onClick={e => e.stopPropagation()}>
            <div className="modal-title">Save Project As</div>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '4px 0 8px' }}>
              Creates a new project with the current files, leaving the original project untouched.
            </p>
            <input className="snap-input" style={{ width: '100%', boxSizing: 'border-box' }}
              placeholder="Project name"
              value={dupProjName}
              onChange={e => setDupProjName(e.target.value)}
              autoFocus
              onKeyDown={e => {
                if (e.key === 'Enter') { saveProjectSlot(dupProjName, null); setDupProjPromptOpen(false) }
                if (e.key === 'Escape') setDupProjPromptOpen(false)
              }} />
            <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
              <button className="small-btn" onClick={() => { saveProjectSlot(dupProjName, null); setDupProjPromptOpen(false) }}>Save</button>
              <button className="small-btn" onClick={() => setDupProjPromptOpen(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Save to Cloud (insert new) prompt ────────────────────────────────── */}
      {saveToCloudPromptOpen && (
        <div className="modal-backdrop" onClick={() => !cloudBusy && setSaveToCloudPromptOpen(false)}>
          <div className="modal-box" onClick={e => e.stopPropagation()}>
            <div className="modal-title">Save to Cloud</div>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '4px 0 8px' }}>
              Creates a new cloud project saved to this account.
            </p>
            <input className="snap-input" style={{ width: '100%', boxSizing: 'border-box' }}
              placeholder="Project name"
              value={saveToCloudName}
              onChange={e => setSaveToCloudName(e.target.value)}
              autoFocus
              onKeyDown={e => {
                if (e.key === 'Enter') saveNewCloudProject(saveToCloudName)
                if (e.key === 'Escape') setSaveToCloudPromptOpen(false)
              }} />
            <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
              <button className="small-btn" disabled={cloudBusy} onClick={() => saveNewCloudProject(saveToCloudName)}>
                {cloudBusy ? 'Saving…' : 'Save'}
              </button>
              <button className="small-btn" disabled={cloudBusy} onClick={() => setSaveToCloudPromptOpen(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Cloud save conflict (someone else saved since we loaded) ────────── */}
      {cloudConflict && (
        <div className="modal-backdrop" onClick={() => setCloudConflict(null)}>
          <div className="modal-box" onClick={e => e.stopPropagation()}>
            <div className="modal-title">Cloud project changed</div>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '4px 0 12px' }}>
              Updated by {cloudConflict.updatedByEmail || 'someone else'} at{' '}
              {new Date(cloudConflict.updatedAt).toLocaleString()}, since you loaded it.
            </p>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button className="small-btn" onClick={() => updateCurrentCloudProject(true)}>Overwrite their changes</button>
              <button className="small-btn" onClick={() => { setCloudConflict(null); openCloudProjectById(currentCloudProject.id) }}>Reload their version</button>
              <button className="small-btn" onClick={() => setCloudConflict(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {authModalOpen && <AuthPanel onClose={() => setAuthModalOpen(false)} />}

      {cloudProjectsModalOpen && (
        <CloudProjectsModal
          currentCloudProjectId={currentCloudProject?.id ?? null}
          onOpen={openCloudProjectById}
          onClose={() => setCloudProjectsModalOpen(false)}
        />
      )}

      {/* ── Open Project modal ───────────────────────────────────────────────── */}
      {projectsModalOpen && (() => {
        const projects = loadSavedProjects()
        const entries = Object.entries(projects).sort(([, a], [, b]) => b.savedAt - a.savedAt)
        return (
          <div className="modal-backdrop" onClick={() => setProjectsModalOpen(false)}>
            <div className="modal-box modal-box-wide" onClick={e => e.stopPropagation()}>
              <div className="modal-title">Switch Project</div>
              {entries.length === 0
                ? <p style={{ color: 'var(--text-muted)', fontSize: 12, margin: '8px 0' }}>No saved projects.</p>
                : (
                  <ul className="project-list">
                    {entries.map(([id, proj]) => {
                      const isRenaming = renamingProjId === id
                      const commitRename = () => {
                        renameProjectById(id, renameProjVal)
                        setRenamingProjId(null)
                      }
                      return (
                      <li key={id} className={`project-item ${id === currentProjectId ? 'project-item-current' : ''}`}>
                        {isRenaming ? (
                          <div className="project-item-name" style={{ display: 'flex', alignItems: 'center' }}>
                            <input className="snap-input" style={{ flex: 1 }}
                              value={renameProjVal}
                              autoFocus
                              onChange={e => setRenameProjVal(e.target.value)}
                              onBlur={commitRename}
                              onKeyDown={e => {
                                if (e.key === 'Enter') commitRename()
                                if (e.key === 'Escape') setRenamingProjId(null)
                              }} />
                          </div>
                        ) : (
                          <button className="project-item-name"
                            onClick={() => openProjectById(id)}
                            onDoubleClick={e => { e.stopPropagation(); setRenamingProjId(id); setRenameProjVal(proj.name) }}
                            title="Click to open · double-click to rename">
                            <span className="project-item-label">{proj.name}</span>
                            <span className="project-item-date">{new Date(proj.savedAt).toLocaleString()}</span>
                          </button>
                        )}
                        <button className="small-btn" title="Rename"
                          onClick={() => { setRenamingProjId(id); setRenameProjVal(proj.name) }}>✎</button>
                        <button className="small-btn project-item-del" title="Delete"
                          onClick={() => deleteProjectById(id)}>✕</button>
                      </li>
                      )
                    })}
                  </ul>
                )
              }
              <button className="small-btn" style={{ marginTop: 8 }} onClick={() => setProjectsModalOpen(false)}>Close</button>
            </div>
          </div>
        )
      })()}

      {/* ── Upload conflict (replace vs. append) prompt ─────────────────────── */}
      {uploadConflict && (() => {
        const label = uploadConflict.kind === 'elements' ? 'elements'
          : uploadConflict.kind === 'paths' ? 'beam paths' : 'background objects'
        return (
          <div className="modal-backdrop" onClick={dismissUploadConflict}>
            <div className="modal-box" onClick={e => e.stopPropagation()}>
              <div className="modal-title">Project already has {label}</div>
              <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '4px 0 12px' }}>
                Replace the current {label} with the uploaded file, or append the uploaded {label} to what's already there?
              </p>
              <div style={{ display: 'flex', gap: 6 }}>
                <button className="small-btn" onClick={() => resolveUploadConflict(true)}>Append</button>
                <button className="small-btn" onClick={() => resolveUploadConflict(false)}>Replace</button>
                <button className="small-btn" onClick={dismissUploadConflict}>{uploadConflict.next ? 'Skip' : 'Cancel'}</button>
              </div>
            </div>
          </div>
        )
      })()}

      {/* ── O-number collision: auto vs. manual resolve ─────────────────────── */}
      {labelCollisionPrompt && (
        <div className="modal-backdrop" onClick={dismissLabelCollisionPrompt}>
          <div className="modal-box" onClick={e => e.stopPropagation()}>
            <div className="modal-title">Label collisions found</div>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '4px 0 12px' }}>
              {labelCollisionPrompt.count} uploaded element{labelCollisionPrompt.count !== 1 ? 's' : ''} share a label with an existing element.
              Auto-resolve renames them automatically (e.g. O-12 → O-12_2), or resolve each one manually.
            </p>
            <div style={{ display: 'flex', gap: 6 }}>
              <button className="small-btn" onClick={autoResolveLabelCollisions}>Auto-resolve</button>
              <button className="small-btn" onClick={startManualLabelResolve}>Resolve manually</button>
              <button className="small-btn" onClick={dismissLabelCollisionPrompt}>{labelCollisionPrompt.next ? 'Skip' : 'Cancel'}</button>
            </div>
          </div>
        </div>
      )}

      {/* ── O-number collision: manual, one-at-a-time relabel ────────────────── */}
      {manualRelabel && (() => {
        const trimmedVal = manualRelabel.value.trim()
        const isDup = trimmedVal !== '' && manualRelabel.usedLabels.has(trimmedVal)
        const isEmpty = trimmedVal === ''
        const idx = manualRelabel.queue[manualRelabel.step]
        const originalLabel = manualRelabel.parsed[idx].label
        const isLast = manualRelabel.step + 1 >= manualRelabel.queue.length
        return (
          <div className="modal-backdrop" onClick={dismissManualRelabel}>
            <div className="modal-box" onClick={e => e.stopPropagation()}>
              <div className="modal-title">Resolve label {manualRelabel.step + 1} of {manualRelabel.queue.length}</div>
              <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '4px 0 8px' }}>
                "{originalLabel}" already exists in the project. Choose a new label for the uploaded element.
              </p>
              <input className="snap-input" style={{ width: '100%', boxSizing: 'border-box' }}
                value={manualRelabel.value}
                autoFocus
                onChange={e => setManualRelabel(mr => ({ ...mr, value: e.target.value }))}
                onKeyDown={e => {
                  if (e.key === 'Enter' && !isDup && !isEmpty) confirmManualRelabelStep()
                  if (e.key === 'Escape') dismissManualRelabel()
                }} />
              {isDup && <div style={{ color: '#e06c75', fontSize: 11, marginTop: 4 }}>That label is already taken.</div>}
              <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                <button className="small-btn" disabled={isDup || isEmpty} onClick={confirmManualRelabelStep}>
                  {isLast ? 'Finish' : 'Next'}
                </button>
                <button className="small-btn" onClick={dismissManualRelabel}>Cancel</button>
              </div>
            </div>
          </div>
        )
      })()}

      {/* ── Dropped CSV of unclear type ──────────────────────────────────────── */}
      {dropAmbiguous && (
        <div className="modal-backdrop" onClick={() => setDropAmbiguous(null)}>
          <div className="modal-box" onClick={e => e.stopPropagation()}>
            <div className="modal-title">What kind of file is "{dropAmbiguous.file.name}"?</div>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '4px 0 12px' }}>
              Couldn't tell from the file name or contents — choose what to upload it as.
            </p>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button className="small-btn" onClick={() => { applyInferredCsv('elements', dropAmbiguous.file); setDropAmbiguous(null) }}>Elements</button>
              <button className="small-btn" onClick={() => { applyInferredCsv('paths', dropAmbiguous.file); setDropAmbiguous(null) }}>Beam Paths</button>
              <button className="small-btn" onClick={() => { applyInferredCsv('objects', dropAmbiguous.file); setDropAmbiguous(null) }}>Background Objects</button>
              <button className="small-btn" onClick={() => setDropAmbiguous(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Bulk property edit (P) ───────────────────────────────────────────── */}
      {bulkEdit && (() => {
        const count = selectedLabels.size
        const toggle = key => setBulkEdit(b => ({ ...b, enabled: { ...b.enabled, [key]: !b.enabled[key] } }))
        // Editing a value implies intent to apply it, so tick the box automatically —
        // otherwise an edited-but-unticked field would be silently ignored on Apply.
        const setVal = (key, v) => setBulkEdit(b => ({
          ...b,
          values:  { ...b.values,  [key]: v },
          enabled: { ...b.enabled, [key]: true },
        }))
        const anyEnabled = Object.values(bulkEdit.enabled).some(Boolean)

        const row = (key, label, control) => (
          <label key={key} style={{
            display: 'grid', gridTemplateColumns: '18px 90px 1fr', alignItems: 'center',
            gap: 8, marginBottom: 6, fontSize: 12,
            opacity: bulkEdit.enabled[key] ? 1 : 0.55,
          }}>
            <input type="checkbox" checked={!!bulkEdit.enabled[key]} onChange={() => toggle(key)} />
            <span>{label}</span>
            {control}
          </label>
        )

        return (
          <div className="modal-backdrop" onClick={() => setBulkEdit(null)}>
            <div className="modal-box" onClick={e => e.stopPropagation()}>
              <div className="modal-title">Set properties on {count} element{count !== 1 ? 's' : ''}</div>
              <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '4px 0 12px' }}>
                Tick a property to apply it to the whole selection. Unticked properties are left alone.
              </p>

              {row('Layer', 'Layer', (
                <select className="snap-input" value={bulkEdit.values.Layer} autoFocus
                  onChange={e => setVal('Layer', e.target.value)}>
                  {Object.keys(layers).map(name => <option key={name} value={name}>{name}</option>)}
                </select>
              ))}

              {row('type', 'Type', (
                <input className="snap-input" value={bulkEdit.values.type}
                  onChange={e => setVal('type', e.target.value)} />
              ))}

              {row('orientation', 'Orientation °', (
                <input className="snap-input" type="number" value={bulkEdit.values.orientation}
                  onChange={e => setVal('orientation', e.target.value)} />
              ))}

              {row('in_design', 'In Design', (
                <select className="snap-input" value={bulkEdit.values.in_design ? 'true' : 'false'}
                  onChange={e => setVal('in_design', e.target.value === 'true')}>
                  <option value="true">TRUE (visible)</option>
                  <option value="false">FALSE (hidden)</option>
                </select>
              ))}

              {allMetaKeys.length > 0 && (
                <div style={{ borderTop: '1px solid var(--border-side)', margin: '10px 0 8px', paddingTop: 8 }}>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>Custom columns</div>
                  {allMetaKeys.map(k => row(k, k, (
                    <input className="snap-input" value={bulkEdit.values[k] ?? ''}
                      onChange={e => setVal(k, e.target.value)} />
                  )))}
                </div>
              )}

              <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
                <button className="small-btn" disabled={!anyEnabled} onClick={applyBulkEdit}>
                  Apply to {count}
                </button>
                <button className="small-btn" onClick={() => setBulkEdit(null)}>Cancel</button>
              </div>
            </div>
          </div>
        )
      })()}

      {/* ── Project ZIP upload: new project vs. overwrite current ────────────── */}
      {zipUpload && zipStage === 'choose' && (() => {
        const present = [
          zipUpload.elemText     && 'elements',
          zipUpload.pathsText    && 'beam paths',
          zipUpload.bgText       && 'background objects',
          zipUpload.settingsText && 'settings',
        ].filter(Boolean)
        return (
          <div className="modal-backdrop" onClick={cancelZipUpload}>
            <div className="modal-box" onClick={e => e.stopPropagation()}>
              <div className="modal-title">Upload project "{zipUpload.fileName}"</div>
              <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '4px 0 12px' }}>
                Contains: {present.length ? present.join(', ') : 'no recognised files'}.
                Open it as a separate new project, or merge it into the current project one file at a time?
              </p>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <button className="small-btn" disabled={!present.length}
                  onClick={() => { setZipNewName(zipUpload.fileName.replace(/\.zip$/i, '')); setZipStage('newName') }}>
                  Open as New Project…
                </button>
                <button className="small-btn" disabled={!present.length} onClick={startZipOverwriteFlow}>
                  Overwrite Current Project…
                </button>
                <button className="small-btn" onClick={cancelZipUpload}>Cancel</button>
              </div>
            </div>
          </div>
        )
      })()}

      {zipUpload && zipStage === 'newName' && (
        <div className="modal-backdrop" onClick={cancelZipUpload}>
          <div className="modal-box" onClick={e => e.stopPropagation()}>
            <div className="modal-title">Name the new project</div>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '4px 0 8px' }}>
              The uploaded files become a new project, saved separately from the current one.
            </p>
            <input className="snap-input" style={{ width: '100%', boxSizing: 'border-box' }}
              placeholder="Project name"
              value={zipNewName}
              autoFocus
              onChange={e => setZipNewName(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') applyZipAsNewProject(zipNewName)
                if (e.key === 'Escape') cancelZipUpload()
              }} />
            <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
              <button className="small-btn" onClick={() => applyZipAsNewProject(zipNewName)}>Create</button>
              <button className="small-btn" onClick={() => setZipStage('choose')}>Back</button>
              <button className="small-btn" onClick={cancelZipUpload}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Project ZIP overwrite: settings step ─────────────────────────────── */}
      {zipSettingsPrompt && (
        <div className="modal-backdrop" onClick={skipZipSettings}>
          <div className="modal-box" onClick={e => e.stopPropagation()}>
            <div className="modal-title">Overwrite settings?</div>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '4px 0 12px' }}>
              The uploaded project includes settings (canvas scale, table size, grid, symbol library, layers).
              Apply them, or keep the current settings?
            </p>
            <div style={{ display: 'flex', gap: 6 }}>
              <button className="small-btn" onClick={applyZipSettings}>Overwrite settings</button>
              <button className="small-btn" onClick={skipZipSettings}>Keep current</button>
            </div>
          </div>
        </div>
      )}

      <input ref={elemFileRef} type="file" accept=".csv" style={{ display: 'none' }}
        onChange={e => loadElementsFile(e.target.files[0])} />
      <input ref={pathFileRef} type="file" accept=".csv" style={{ display: 'none' }}
        onChange={e => loadPathsFile(e.target.files[0])} />
      <input ref={bgFileRef}   type="file" accept=".csv" style={{ display: 'none' }}
        onChange={e => loadBgFile(e.target.files[0])} />
      <input ref={settingsFileRef} type="file" accept=".json" style={{ display: 'none' }}
        onChange={e => loadSettingsFile(e.target.files[0])} />
      <input ref={zipFileRef} type="file" accept=".zip" style={{ display: 'none' }}
        onChange={e => handleProjectZipFile(e.target.files[0])} />
    </div>
  )
}
