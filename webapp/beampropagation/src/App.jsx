import { useState, useEffect, useRef } from 'react'
import BeamPropagationMode from './components/BeamPropagationMode'
import AuthPanel from './components/AuthPanel'
import CloudProjectsModal from './components/CloudProjectsModal'
import { readProjectZip } from './utils/projectZip'
import { visibleElements } from './utils/projectContext'
import { parsePropagationsCsv, serializePropagationsCsv } from './utils/propagationCsv'
import { propagationsFromFileShape } from './utils/propagationModel'
import { DEFAULT_SYMBOL_DEFS } from './utils/symbols'
import { supabase } from './supabaseClient'
import {
  fetchCloudProject, insertCloudProject, updateCloudProjectPropagations,
} from './utils/cloudProjects'
import './App.css'

const LS_PROPS   = 'beamProp_v1'
const LS_PROJECT = 'beamProp_project_v1'
const LS_THEME   = 'beamProp_theme'
const LS_CLOUD   = 'beamProp_current_cloud_project'

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

  // ── Cloud projects — optional, only active when Supabase is configured ────
  const [session,                setSession]                = useState(null)
  const [authModalOpen,          setAuthModalOpen]          = useState(false)
  const [cloudProjectsModalOpen, setCloudProjectsModalOpen] = useState(false)
  const [cloudMenuOpen,          setCloudMenuOpen]          = useState(false)
  // {id, name, updatedAt} of the cloud project last opened / saved to. Kept in
  // localStorage so "Save to Cloud (update)" survives a reload.
  const [currentCloudProject, setCurrentCloudProject] = useState(() => loadJson(LS_CLOUD))
  const [cloudBusy,           setCloudBusy]           = useState(false)
  const [saveToCloudPromptOpen, setSaveToCloudPromptOpen] = useState(false)
  const [saveToCloudName,       setSaveToCloudName]       = useState('')
  // Someone saved the open cloud project since it was loaded: {updatedByEmail, updatedAt}.
  const [cloudConflict, setCloudConflict] = useState(null)
  // Generic "are you sure": {title, text, confirmLabel, onConfirm}.
  const [confirm, setConfirm] = useState(null)

  const propagationModeRef = useRef(null)
  const zipInputRef = useRef(null)
  const csvInputRef = useRef(null)
  const cloudMenuRef = useRef(null)
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
  useEffect(() => {
    try {
      if (currentCloudProject) localStorage.setItem(LS_CLOUD, JSON.stringify(currentCloudProject))
      else localStorage.removeItem(LS_CLOUD)
    } catch {}
  }, [currentCloudProject])

  // Track the logged-in Supabase user, if any. A no-op when Supabase isn't
  // configured (`supabase` is null) — every cloud control is then hidden.
  useEffect(() => {
    if (!supabase) return
    supabase.auth.getSession().then(({ data }) => setSession(data.session))
    const { data: sub } = supabase.auth.onAuthStateChange((_event, sess) => setSession(sess))
    return () => sub.subscription.unsubscribe()
  }, [])

  useEffect(() => {
    if (!cloudMenuOpen) return
    function onDown(e) {
      if (cloudMenuRef.current && !cloudMenuRef.current.contains(e.target)) setCloudMenuOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [cloudMenuOpen])

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

  function loadPropagationsCsv(file) {
    const reader = new FileReader()
    reader.onload = e => {
      try {
        const parsed = parsePropagationsCsv(e.target.result)
        if (!Object.keys(parsed).length) throw new Error('no propagations found in the file')
        setError(null)
        offerPropagations(file.name, parsed)
      } catch (err) { setError('Invalid propagations.csv: ' + err.message) }
    }
    reader.readAsText(file)
  }

  function downloadPropagations() {
    const blob = new Blob([serializePropagationsCsv(propagations)], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url; a.download = 'propagations.csv'; a.click()
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
    else if (ext === 'csv') loadPropagationsCsv(file)
    else setError(`Unsupported file "${file.name}" — upload a project .zip or a propagations.csv.`)
  }

  // ── Cloud projects ───────────────────────────────────────────────────────
  // Load a fetched cloud project: its propagations replace the current ones,
  // and its elements / beam paths / symbols become the source for Import….
  function applyCloudProject(proj) {
    const st = proj.state ?? {}
    const parsed = propagationsFromFileShape(st.propagations)
    setPropagations(parsed)
    setActivePropagation(st.activePropagation in parsed ? st.activePropagation : (Object.keys(parsed)[0] ?? null))
    setProject({
      name: proj.name,
      elements: visibleElements(st.elements, st.overrides, st.layers),
      beamPaths: st.beamPaths ?? {},
      symbolDefs: st.symbolDefs ?? { ...DEFAULT_SYMBOL_DEFS },
    })
    setCurrentCloudProject({ id: proj.id, name: proj.name, updatedAt: proj.updatedAt })
    setCloudProjectsModalOpen(false)
    setCloudConflict(null)
    setError(null)
    const nPaths = Object.keys(st.beamPaths ?? {}).length
    setNotice(`Opened cloud project "${proj.name}": ${Object.keys(parsed).length} propagation${Object.keys(parsed).length === 1 ? '' : 's'}, ${nPaths} beam path${nPaths === 1 ? '' : 's'}.`)
  }

  // Errors are thrown so the project-list modal can show them inline.
  async function openCloudProjectById(id) {
    const proj = await fetchCloudProject(id)
    if (!Object.keys(propagations).length) { applyCloudProject(proj); return }
    setCloudProjectsModalOpen(false)
    setConfirm({
      title: `Open "${proj.name}"?`,
      text: `Its propagations replace the ${Object.keys(propagations).length} you have open. Plots that aren't saved anywhere else will be lost.`,
      confirmLabel: 'Open',
      onConfirm: () => applyCloudProject(proj),
    })
  }

  async function saveNewCloudProject(name) {
    if (!session) return
    setCloudBusy(true); setError(null)
    try {
      const saved = await insertCloudProject(name, propagations, activePropagation, session.user)
      setCurrentCloudProject(saved)
      setSaveToCloudPromptOpen(false)
      setNotice(`Saved to the cloud as "${saved.name}".`)
    } catch (e) { setError('Save to cloud failed: ' + e.message) }
    finally { setCloudBusy(false) }
  }

  // Writes the propagations into the open cloud project. The row is re-read
  // first so anything changed in the designer since it was opened is kept, and
  // if it has been saved by someone else the write waits on the user's choice.
  async function updateCurrentCloudProject(force = false) {
    if (!session || !currentCloudProject) return
    setCloudBusy(true); setError(null)
    try {
      const latest = await fetchCloudProject(currentCloudProject.id)
      if (!force && latest.updatedAt !== currentCloudProject.updatedAt) {
        setCloudConflict({ updatedByEmail: latest.updatedByEmail, updatedAt: latest.updatedAt })
        return
      }
      const saved = await updateCloudProjectPropagations(
        latest.id, latest.name, latest.state, propagations, activePropagation, session.user)
      setCurrentCloudProject(saved)
      setCloudConflict(null)
      setNotice(`Saved to cloud project "${saved.name}".`)
    } catch (e) { setError('Save to cloud failed: ' + e.message) }
    finally { setCloudBusy(false) }
  }

  async function loadLatestCloudVersion() {
    if (!currentCloudProject) return
    setCloudBusy(true)
    try { applyCloudProject(await fetchCloudProject(currentCloudProject.id)) }
    catch (e) { setError('Reload from cloud failed: ' + e.message) }
    finally { setCloudBusy(false) }
  }

  async function logOutCloud() {
    if (!supabase) return
    await supabase.auth.signOut()
    setCurrentCloudProject(null)
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
      {dragActive && <div className="drop-overlay">Drop a project .zip or propagations.csv to upload</div>}
      <header className="app-header">
        <div>
          <span className="app-title"><img className="app-logo" src="/favicon.svg" alt="" />Beam Propagation</span>
          {project && project.name !== currentCloudProject?.name && (
            <span className="project-name-badge"
              title={`${project.elements.length} elements, ${Object.keys(project.beamPaths).length} beam paths`}>
              {project.name}
            </span>
          )}
          {currentCloudProject && <span className="project-name-badge">☁ {currentCloudProject.name}</span>}
        </div>
        <div className="header-controls">
          <button className="file-btn" onClick={() => zipInputRef.current.click()}
            title="Load an Optical Table Designer project .zip — makes its beam paths available to Import…">
            Upload Project (.zip)
          </button>
          <button className="file-btn" onClick={() => csvInputRef.current.click()}
            title="Load propagations saved earlier (propagations.csv)">
            Upload Propagations
          </button>
          <button className="file-btn" onClick={downloadPropagations} disabled={!nProps}
            title="Save all propagations as propagations.csv (Cmd/Ctrl+S)">
            Download Propagations
          </button>
          {supabase && (<>
            <span className="hdr-sep" />
            {!session ? (
              <button className="file-btn" onClick={() => setAuthModalOpen(true)}
                title="Log in to save and open projects in the cloud">Log in</button>
            ) : (
              <div className="file-menu" ref={cloudMenuRef}>
                <button className="file-btn" onClick={() => setCloudMenuOpen(o => !o)}>☁ Cloud ▾</button>
                {cloudMenuOpen && (
                  <div className="file-menu-dropdown">
                    <div className="file-menu-label">{session.user.email}</div>
                    <button className="file-menu-item"
                      onClick={() => { setCloudProjectsModalOpen(true); setCloudMenuOpen(false) }}>Open Cloud Project…</button>
                    <button className="file-menu-item"
                      onClick={() => { setSaveToCloudName(currentCloudProject?.name ?? project?.name ?? ''); setSaveToCloudPromptOpen(true); setCloudMenuOpen(false) }}>Save to Cloud…</button>
                    {currentCloudProject && (
                      <button className="file-menu-item" disabled={cloudBusy}
                        onClick={() => { updateCurrentCloudProject(); setCloudMenuOpen(false) }}>Save to Cloud (update)</button>
                    )}
                    <div className="file-menu-sep" />
                    <button className="file-menu-item" onClick={() => { logOutCloud(); setCloudMenuOpen(false) }}>Log out</button>
                  </div>
                )}
              </div>
            )}
          </>)}
          <span className="hdr-sep" />
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
          projectName={project?.name}
          onLoadProjectZip={loadProjectForImport}
        />
      </div>

      {authModalOpen && <AuthPanel onClose={() => setAuthModalOpen(false)} />}
      {cloudProjectsModalOpen && (
        <CloudProjectsModal
          currentCloudProjectId={currentCloudProject?.id}
          onOpen={openCloudProjectById}
          onClose={() => setCloudProjectsModalOpen(false)} />
      )}

      {saveToCloudPromptOpen && (
        <div className="modal-backdrop" onClick={() => setSaveToCloudPromptOpen(false)}>
          <div className="modal-box" onClick={e => e.stopPropagation()}>
            <div className="modal-title">Save to Cloud</div>
            <p className="modal-text">
              Saves your {nProps} propagation{nProps === 1 ? '' : 's'} as a new cloud project
              you can open here or in the Optical Table Designer.
            </p>
            <form onSubmit={e => { e.preventDefault(); if (saveToCloudName.trim()) saveNewCloudProject(saveToCloudName) }}>
              <input className="snap-input" style={{ width: '100%', marginBottom: 12 }} autoFocus
                placeholder="Project name" value={saveToCloudName}
                onChange={e => setSaveToCloudName(e.target.value)} />
              <div className="modal-actions">
                <button type="button" className="small-btn" onClick={() => setSaveToCloudPromptOpen(false)}>Cancel</button>
                <button type="submit" className="small-btn" disabled={cloudBusy || !saveToCloudName.trim()}>
                  {cloudBusy ? 'Saving…' : 'Save'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {cloudConflict && (
        <div className="modal-backdrop">
          <div className="modal-box">
            <div className="modal-title">Cloud project changed</div>
            <p className="modal-text">
              "{currentCloudProject?.name}" was saved{cloudConflict.updatedByEmail ? ` by ${cloudConflict.updatedByEmail}` : ''} at{' '}
              {new Date(cloudConflict.updatedAt).toLocaleString()}, after you opened it.
              Overwriting replaces its propagations with yours; anything else in the project
              (elements, beam paths, settings) is kept as it is now.
            </p>
            <div className="modal-actions">
              <button className="small-btn" onClick={() => setCloudConflict(null)}>Cancel</button>
              <button className="small-btn" disabled={cloudBusy} onClick={loadLatestCloudVersion}>Load their version</button>
              <button className="small-btn" disabled={cloudBusy} onClick={() => updateCurrentCloudProject(true)}>Overwrite propagations</button>
            </div>
          </div>
        </div>
      )}

      {confirm && (
        <div className="modal-backdrop" onClick={() => setConfirm(null)}>
          <div className="modal-box" onClick={e => e.stopPropagation()}>
            <div className="modal-title">{confirm.title}</div>
            <p className="modal-text">{confirm.text}</p>
            <div className="modal-actions">
              <button className="small-btn" onClick={() => setConfirm(null)}>Cancel</button>
              <button className="small-btn" onClick={() => { confirm.onConfirm(); setConfirm(null) }}>{confirm.confirmLabel}</button>
            </div>
          </div>
        </div>
      )}

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

      <input ref={zipInputRef} type="file" accept=".zip" style={{ display: 'none' }}
        onChange={e => pickFile(zipInputRef, e)} />
      <input ref={csvInputRef} type="file" accept=".csv" style={{ display: 'none' }}
        onChange={e => pickFile(csvInputRef, e)} />
    </div>
  )
}
