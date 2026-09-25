import { useState, useEffect, useRef } from 'react'
import BeamPropagationMode from './components/BeamPropagationMode'
import { readProjectZip } from './utils/projectZip'
import { parsePropagationsJson, serializePropagationsJson } from './utils/propagationsJson'
import './App.css'

const LS_PROPS   = 'beamProp_v1'
const LS_PROJECT = 'beamProp_project_v1'
const LS_THEME   = 'beamProp_theme'

function loadJson(key) {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : null
  } catch { return null }
}

function loadTheme() {
  try {
    const saved = localStorage.getItem(LS_THEME)
    if (saved === 'dark' || saved === 'light') return saved
  } catch {}
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export default function App() {
  const _props = loadJson(LS_PROPS)
  const [propagations,      setPropagations]      = useState(() => _props?.propagations ?? {})
  const [activePropagation, setActivePropagation] = useState(() => _props?.activePropagation ?? null)
  // The designer project that "Import…" reads from (an uploaded .zip, or an
  // opened cloud project).
  const [project, setProject] = useState(() => loadJson(LS_PROJECT))
  const [theme, setTheme] = useState(loadTheme)
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)
  const [dragActive, setDragActive] = useState(false)
  // Propagations found in an upload while the sandbox already has some:
  // { fileName, propagations } until the user picks replace / add / cancel.
  const [pendingProps, setPendingProps] = useState(null)

  const propagationModeRef = useRef(null)
  const jsonInputRef = useRef(null)
  const dragDepth = useRef(0)

  useEffect(() => { document.documentElement.dataset.theme = theme }, [theme])
  useEffect(() => {
    try { localStorage.setItem(LS_THEME, theme) } catch {}
  }, [theme])
  useEffect(() => {
    try { localStorage.setItem(LS_PROPS, JSON.stringify({ propagations, activePropagation })) } catch {}
  }, [propagations, activePropagation])
  useEffect(() => {
    // A project with large custom symbols can exceed the localStorage quota;
    // the session still works, it just won't survive a reload.
    try {
      if (project) localStorage.setItem(LS_PROJECT, JSON.stringify(project))
      else localStorage.removeItem(LS_PROJECT)
    } catch {}
  }, [project])

  function replacePropagations(parsed) {
    setPropagations(parsed)
    setActivePropagation(Object.keys(parsed)[0] ?? null)
  }
  function addPropagations(parsed) {
    setPropagations(prev => ({ ...prev, ...parsed }))
    const first = Object.keys(parsed)[0]
    if (first) setActivePropagation(first)
  }
  function offerPropagations(fileName, parsed) {
    if (!Object.keys(parsed).length) return
    if (Object.keys(propagations).length) setPendingProps({ fileName, propagations: parsed })
    else replacePropagations(parsed)
  }

  const projectFromZip = (file, { elements, beamPaths, symbolDefs }) => ({
    name: file.name.replace(/\.zip$/i, ''), elements, beamPaths, symbolDefs,
  })

  // Loads a designer project purely as the source for "Import…": its layout is
  // read and any propagations in the zip are ignored, so nothing you have open
  // is touched. Resolves true when there are beam paths to pick from.
  async function loadProjectForImport(file) {
    try {
      const parsed = await readProjectZip(file)
      if (!Object.keys(parsed.beamPaths).length) {
        setError(`No beam paths found in ${file.name} — is it an Optical Table Designer project .zip with at least one beam path?`)
        return false
      }
      setError(null); setNotice(null)
      setProject(projectFromZip(file, parsed))
      return true
    } catch (e) {
      setError('Load project failed: ' + e.message)
      return false
    }
  }

  async function loadZip(file) {
    try {
      const { elements, beamPaths, symbolDefs, propagations: parsed } = await readProjectZip(file)
      setError(null)
      setProject(projectFromZip(file, { elements, beamPaths, symbolDefs }))
      const nPaths = Object.keys(beamPaths).length
      const nProps = Object.keys(parsed).length
      setNotice(`Loaded ${file.name}: ${elements.length} elements, ${nPaths} beam path${nPaths === 1 ? '' : 's'}`
        + (nProps ? `, ${nProps} propagation${nProps === 1 ? '' : 's'}.` : '.'))
      offerPropagations(file.name, parsed)
    } catch (e) { setError('Load project failed: ' + e.message) }
  }

  function loadPropagationsJson(file) {
    const reader = new FileReader()
    reader.onload = e => {
      try {
        const parsed = parsePropagationsJson(e.target.result)
        if (!Object.keys(parsed).length) throw new Error('no propagations found in the file')
        setError(null)
        offerPropagations(file.name, parsed)
      } catch (err) { setError('Invalid propagations.json: ' + err.message) }
    }
    reader.readAsText(file)
  }

  function downloadPropagations() {
    const blob = new Blob([serializePropagationsJson(propagations)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url; a.download = 'propagations.json'; a.click()
    URL.revokeObjectURL(url)
  }

  // Cmd/Ctrl+S downloads the propagations. Always claim the shortcut, even with
  // nothing to save, so the browser's own "Save page" dialog never appears.
  useEffect(() => {
    function onKey(e) {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 's') {
        e.preventDefault()
        if (Object.keys(propagations).length) downloadPropagations()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  })

  function handleFile(file) {
    if (!file) return
    const ext = file.name.toLowerCase().split('.').pop()
    if (ext === 'zip') loadZip(file)
    else if (ext === 'json') loadPropagationsJson(file)
    else setError(`Unsupported file "${file.name}" — upload a project .zip or a propagations.json.`)
  }

  // ── Drag-and-drop upload ────────────────────────────────────────────────
  const hasFiles = e => Array.from(e.dataTransfer?.types ?? []).includes('Files')
  function handleDragEnter(e) {
    if (!hasFiles(e)) return
    e.preventDefault(); dragDepth.current++; setDragActive(true)
  }
  function handleDragOver(e) { if (hasFiles(e)) e.preventDefault() }
  function handleDragLeave(e) {
    if (!hasFiles(e)) return
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (!dragDepth.current) setDragActive(false)
  }
  function handleDrop(e) {
    if (!hasFiles(e)) return
    e.preventDefault(); dragDepth.current = 0; setDragActive(false)
    Array.from(e.dataTransfer.files).forEach(handleFile)
  }

  function pickFile(ref, e) {
    handleFile(e.target.files[0])
    ref.current.value = ''
  }

  const nProps = Object.keys(propagations).length

  return (
    <div className="app"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {dragActive && <div className="drop-overlay">Drop a project .zip or propagations.json to upload</div>}
      <header className="app-header">
        <div>
          <span className="app-title"><img className="app-logo" src="/favicon.svg" alt="" />Beam Propagation</span>
          {project && (
            <span className="project-name-badge"
              title={`${project.elements.length} elements, ${Object.keys(project.beamPaths).length} beam paths`}>
              {project.name}
            </span>
          )}
        </div>
        <div className="header-controls">
          <button className="file-btn"
            onClick={() => setTheme(t => t === 'dark' ? 'light' : 'dark')}
            title="Toggle light / dark theme">
            {theme === 'dark' ? '☀ Light' : '☾ Dark'}
          </button>
          <a className="file-btn" href="https://github.com/henryando/OpticalDesigner/tree/main/webapp/beampropagation#readme"
            target="_blank" rel="noreferrer">GitHub Readme</a>
          <span className="hdr-sep" />
          <button className="file-btn file-btn-accent"
            onClick={() => propagationModeRef.current?.exportPdf()}
            disabled={!activePropagation}>Export PDF</button>
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

      <div className="app-body">
        <BeamPropagationMode
          ref={propagationModeRef}
          propagations={propagations}
          activePropagation={activePropagation}
          onSetPropagations={setPropagations}
          onSetActivePropagation={setActivePropagation}
          beamPaths={project?.beamPaths}
          elements={project?.elements ?? []}
          symbolDefs={project?.symbolDefs}
          onLoadProjectZip={loadProjectForImport}
          onUploadPropagationsClick={() => jsonInputRef.current.click()}
        />
      </div>

      {pendingProps && (
        <div className="modal-backdrop" onClick={() => setPendingProps(null)}>
          <div className="modal-box" onClick={e => e.stopPropagation()}>
            <div className="modal-title">Propagations in {pendingProps.fileName}</div>
            <p className="modal-text">
              It contains {Object.keys(pendingProps.propagations).length} propagation
              {Object.keys(pendingProps.propagations).length === 1 ? '' : 's'}, and you already have{' '}
              {nProps} open. Replace yours, or add these alongside them?
            </p>
            <div className="modal-actions">
              <button className="small-btn" onClick={() => setPendingProps(null)}>Skip</button>
              <button className="small-btn" onClick={() => { addPropagations(pendingProps.propagations); setPendingProps(null) }}>Add to current</button>
              <button className="small-btn" onClick={() => { replacePropagations(pendingProps.propagations); setPendingProps(null) }}>Replace current</button>
            </div>
          </div>
        </div>
      )}

      <input ref={jsonInputRef} type="file" accept=".json" style={{ display: 'none' }}
        onChange={e => pickFile(jsonInputRef, e)} />
    </div>
  )
}
