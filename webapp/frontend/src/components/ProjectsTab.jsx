// The "Projects" sidebar tab: switches between projects, split into two
// lists — Local Storage (every project in this browser) and Cloud Storage
// (the subset also linked to a shared cloud project, plus any cloud project
// not yet pulled into this browser). Local Storage always shows everything,
// including cloud-linked projects, with a per-item sync icon.
//
// Unlike Beam Propagation's rail, a project here is never "bundled" with
// others — one project is exactly one cloud_projects row, so syncing,
// deleting, etc. only ever touch that one row.
import { useEffect, useRef, useState } from 'react'
import { supabase } from '../supabaseClient'
import AuthPanel from './AuthPanel'
import {
  listCloudProjects, fetchCloudProject, getCloudProjectUpdatedAt,
  insertCloudProject, updateCloudProject, deleteCloudProject,
} from '../utils/cloudProjects'
import { mergeCloudState } from '../utils/cloudMerge'
import { stableStringify } from '../utils/stableStringify'
import { buildProjectZipBlob, buildProjectsZipBlob, safeProjectName, downloadBlob } from '../utils/projectZipExport'
import './ProjectsTab.css'

const REMOTE_POLL_MS = 30_000
const LOCAL_POLL_MS = 2_000
const LS_KEY = 'optDesign_projects'

function loadProjects() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) ?? '{}') } catch { return {} }
}
function saveProjects(projects) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(projects)) } catch {}
}

// Background-image hrefs legitimately differ between the local (data: URL)
// and cloud-synced (cloud:<path>) forms even when the image itself hasn't
// changed, so the dirty-check compares everything about them except href.
function comparableState(state) {
  const { bgImages, ...rest } = state ?? {}
  const bgMeta = Object.fromEntries(Object.entries(bgImages ?? {}).map(([k, v]) => {
    const { href, ...meta } = v ?? {}
    return [k, meta]
  }))
  return { ...rest, bgImages: bgMeta }
}
// The project's name lives outside `state`, but a rename should still count
// as a change to sync — fold it into what gets fingerprinted.
function fingerprintProject(name, state) {
  return stableStringify({ name, state: comparableState(state) })
}

const STATUS_INFO = {
  'in-sync':  { glyph: '✓', title: 'In sync with the cloud' },
  ahead:      { glyph: '↑', title: 'Ahead of the cloud — click to push your changes' },
  behind:     { glyph: '↓', title: 'Behind the cloud — click to pull the newer version' },
  conflict:   { glyph: '!', title: 'Out of sync — both sides changed. Click to resolve.' },
  checking:   { glyph: '…', title: 'Checking sync status…' },
}

function SyncBadge({ status, busy, onClick }) {
  if (!status) return null
  const info = STATUS_INFO[status]
  return (
    <button type="button" className={`sync-btn ${status}`}
      disabled={busy || status === 'checking'}
      title={busy ? 'Working…' : info.title}
      onClick={e => { e.stopPropagation(); onClick() }}>
      {busy ? '…' : info.glyph}
    </button>
  )
}

// Floating right-click / "⋯" context menu. `items` is an array of
// { label, onClick, danger?, disabled?, sep? (renders a separator instead) }.
function ContextMenu({ x, y, items, onClose }) {
  const ref = useRef(null)
  useEffect(() => {
    function onDown(e) { if (!ref.current?.contains(e.target)) onClose() }
    function onKey(e) { if (e.key === 'Escape') onClose() }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [onClose])
  const style = { left: Math.min(x, window.innerWidth - 200), top: Math.min(y, window.innerHeight - 8 - items.length * 28) }
  return (
    <div className="proj-context-menu" style={style} ref={ref}>
      {items.map((it, i) => it.sep
        ? <div className="proj-context-sep" key={i} />
        : (
          <button key={i} className={`proj-context-item ${it.danger ? 'danger' : ''}`}
            disabled={it.disabled}
            onClick={() => { onClose(); it.onClick() }}>
            {it.label}
          </button>
        ))}
    </div>
  )
}

export default function ProjectsTab({
  currentProjectId,
  captureProjectState, applyProjectState,
  setCurrentProjectName,
  openProjectById, renameProjectById, deleteProjectById, startNewProject, saveProjectSlot,
  onUploadProjectClick,
}) {
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem('optDesign_projPanelCollapsed') === '1' } catch { return false }
  })
  useEffect(() => { try { localStorage.setItem('optDesign_projPanelCollapsed', collapsed ? '1' : '0') } catch {} }, [collapsed])

  const [width, setWidth] = useState(() => {
    try { return Number(localStorage.getItem('optDesign_projPanelWidth')) || 240 } catch { return 240 }
  })
  useEffect(() => { try { localStorage.setItem('optDesign_projPanelWidth', String(width)) } catch {} }, [width])
  const [resizing, setResizing] = useState(false)
  function startResize(e) {
    e.preventDefault()
    const startX = e.clientX
    const startW = width
    setResizing(true)
    const onMove = ev => setWidth(Math.max(180, Math.min(500, startW + (ev.clientX - startX))))
    const onUp   = () => {
      setResizing(false)
      document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  const [projects, setProjects] = useState(loadProjects)
  // The current project's own state gets autosaved into its slot every
  // ~800ms elsewhere (App.jsx); poll localStorage so this tab's sync status
  // and "last saved" times track that without needing the whole live state
  // threaded down as props.
  useEffect(() => {
    const t = setInterval(() => setProjects(loadProjects()), LOCAL_POLL_MS)
    return () => clearInterval(t)
  }, [])
  function refreshProjects() { setProjects(loadProjects()) }
  function persist(next) { saveProjects(next); setProjects(next) }

  const [session, setSession] = useState(null)
  useEffect(() => {
    if (!supabase) return
    supabase.auth.getSession().then(({ data }) => setSession(data.session))
    // Supabase re-validates the session on window focus, which can fire this
    // callback with a transient null session before the real one comes back —
    // observed as the Cloud Storage list emptying out on unfocus/refocus.
    // Only an explicit sign-out should actually clear it.
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      if (s) setSession(s)
      else if (event === 'SIGNED_OUT') setSession(null)
    })
    return () => sub.subscription.unsubscribe()
  }, [])

  // Live status for every cloud project this account has. Keyed by
  // cloud_projects row id.
  const [remoteRows, setRemoteRows] = useState([])
  const [remoteStatus, setRemoteStatus] = useState({})
  const [remoteError, setRemoteError] = useState(null)
  async function refreshRemote() {
    if (!supabase || !session) return
    try {
      const rows = await listCloudProjects()
      setRemoteRows(rows)
      const next = {}
      rows.forEach(r => { next[r.id] = { updatedAt: r.updatedAt, updatedByEmail: r.updatedByEmail, name: r.name } })
      setRemoteStatus(next)
      setRemoteError(null)
    } catch (e) { setRemoteError(e.message) }
  }
  useEffect(() => {
    if (!session) { setRemoteRows([]); setRemoteStatus({}); return }
    refreshRemote()
    const t = setInterval(refreshRemote, REMOTE_POLL_MS)
    return () => clearInterval(t)
  }, [session?.user?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const [busyIds, setBusyIds] = useState(() => new Set())
  function setBusy(id, v) {
    setBusyIds(prev => { const n = new Set(prev); v ? n.add(id) : n.delete(id); return n })
  }
  async function runOp(id, fn) {
    setBusy(id, true)
    try { await fn() } catch (e) { setBanner({ kind: 'error', text: e.message }) }
    finally { setBusy(id, false) }
  }

  const [renamingId, setRenamingId] = useState(null)
  const [renameVal, setRenameVal] = useState('')
  const [menu, setMenu] = useState(null)
  const [confirmDlg, setConfirmDlg] = useState(null)
  const [saveToCloudPrompt, setSaveToCloudPrompt] = useState(null) // { id, name }
  const [banner, setBanner] = useState(null)
  const [authOpen, setAuthOpen] = useState(false)

  const ids = Object.keys(projects)

  function commitRename(id) {
    const trimmed = renameVal.trim()
    if (trimmed) { renameProjectById(id, trimmed); refreshProjects() }
    setRenamingId(null)
  }

  function syncStatusOf(proj) {
    if (!proj.cloud) return null
    const localDirty = fingerprintProject(proj.name, proj.state) !== proj.cloud.syncedFingerprint
    const remote = remoteStatus[proj.cloud.id]
    if (!remote) return 'checking'
    const remoteChanged = remote.updatedAt !== proj.cloud.syncedUpdatedAt
    if (!localDirty && !remoteChanged) return 'in-sync'
    if (localDirty && !remoteChanged) return 'ahead'
    if (!localDirty && remoteChanged) return 'behind'
    return 'conflict'
  }

  function cloudMetaFor(id, name, state, cloudId, updatedAt) {
    return { id: cloudId, syncedAt: Date.now(), syncedUpdatedAt: updatedAt, syncedFingerprint: fingerprintProject(name, state) }
  }

  // ── Push / pull ───────────────────────────────────────────────────────────
  // Returns 'ok' or 'conflict' (remote changed since our last sync — the
  // caller routes to the conflict dialog rather than clobbering it).
  async function pushProject(id, { force = false } = {}) {
    const proj = projects[id]
    if (!force) {
      const latest = await getCloudProjectUpdatedAt(proj.cloud.id)
      if (latest.updatedAt !== proj.cloud.syncedUpdatedAt) {
        setRemoteStatus(prev => ({ ...prev, [proj.cloud.id]: { updatedAt: latest.updatedAt, updatedByEmail: latest.updatedByEmail, name: proj.name } }))
        return 'conflict'
      }
    }
    const state = (id === currentProjectId) ? captureProjectState() : proj.state
    const saved = await updateCloudProject(proj.cloud.id, proj.name, state, session.user)
    const next = { ...projects, [id]: { ...proj, state, savedAt: Date.now(), cloud: cloudMetaFor(id, proj.name, state, proj.cloud.id, saved.updatedAt) } }
    persist(next)
    setRemoteStatus(prev => ({ ...prev, [proj.cloud.id]: { updatedAt: saved.updatedAt, updatedByEmail: session.user.email, name: saved.name } }))
    return 'ok'
  }

  async function pullProject(id) {
    const proj = projects[id]
    const remote = await fetchCloudProject(proj.cloud.id)
    const next = { ...projects, [id]: { name: remote.name, savedAt: Date.now(), state: remote.state, cloud: cloudMetaFor(id, remote.name, remote.state, remote.id, remote.updatedAt) } }
    persist(next)
    if (id === currentProjectId) { applyProjectState(remote.state); setCurrentProjectName(remote.name) }
    setRemoteStatus(prev => ({ ...prev, [proj.cloud.id]: { updatedAt: remote.updatedAt, updatedByEmail: remote.updatedByEmail, name: remote.name } }))
  }

  // Pulls a cloud project this browser hasn't seen yet into a brand-new slot.
  function pullRemoteRow(row) {
    runOp(row.id, async () => {
      const remote = await fetchCloudProject(row.id)
      const pid = crypto.randomUUID()
      const next = { ...projects, [pid]: { name: remote.name, savedAt: Date.now(), state: remote.state, cloud: cloudMetaFor(pid, remote.name, remote.state, remote.id, remote.updatedAt) } }
      persist(next)
      setRemoteStatus(prev => ({ ...prev, [row.id]: { updatedAt: remote.updatedAt, updatedByEmail: remote.updatedByEmail, name: remote.name } }))
      setBanner({ kind: 'notice', text: `Pulled "${remote.name}" into Local Storage.` })
    })
  }

  async function mergeProject(id) {
    const proj = projects[id]
    const remote = await fetchCloudProject(proj.cloud.id)
    const localState = (id === currentProjectId) ? captureProjectState() : proj.state
    const { state, errors } = mergeCloudState(localState, remote.state)
    if (errors.length) {
      setBanner({ kind: 'error', text: `Merge couldn't complete cleanly: ${errors.join('; ')}. Try Keep mine or Use theirs instead.` })
      return
    }
    const saved = await updateCloudProject(remote.id, proj.name, state, session.user)
    const next = { ...projects, [id]: { ...proj, state, savedAt: Date.now(), cloud: cloudMetaFor(id, proj.name, state, remote.id, saved.updatedAt) } }
    persist(next)
    if (id === currentProjectId) applyProjectState(state)
    setRemoteStatus(prev => ({ ...prev, [remote.id]: { updatedAt: saved.updatedAt, updatedByEmail: session.user.email, name: saved.name } }))
  }

  function openConflictDialog(id) {
    const proj = projects[id]
    setConfirmDlg({
      title: 'Out of sync with the cloud',
      text: `"${proj.name}" has changed here, and its cloud project has also changed since the last sync. Which should win?`,
      buttons: [
        { label: 'Keep mine (overwrite cloud)', onClick: () => runOp(id, () => pushProject(id, { force: true })) },
        { label: 'Use cloud version (discard mine)', onClick: () => runOp(id, () => pullProject(id)) },
        { label: 'Merge…', onClick: () => runOp(id, () => mergeProject(id)) },
        { label: 'Cancel', onClick: () => {} },
      ],
    })
  }

  function handleSyncClick(id) {
    const proj = projects[id]
    const status = syncStatusOf(proj)
    if (!proj.cloud || status === 'checking' || busyIds.has(id)) return
    if (status === 'in-sync') { setBanner({ kind: 'notice', text: `"${proj.name}" is already in sync.` }); return }
    if (status === 'conflict') { openConflictDialog(id); return }
    if (status === 'behind') { runOp(id, () => pullProject(id)); return }
    runOp(id, async () => { const r = await pushProject(id); if (r === 'conflict') openConflictDialog(id) })
  }

  async function commitMoveToCloud(id, name) {
    const trimmed = name.trim() || 'Untitled'
    const proj = projects[id]
    const state = (id === currentProjectId) ? captureProjectState() : proj.state
    setBusy(id, true)
    try {
      const saved = await insertCloudProject(trimmed, state, session.user)
      const next = { ...projects, [id]: { ...proj, name: trimmed, state, cloud: cloudMetaFor(id, trimmed, state, saved.id, saved.updatedAt) } }
      persist(next)
      if (id === currentProjectId) setCurrentProjectName(trimmed)
      setRemoteStatus(prev => ({ ...prev, [saved.id]: { updatedAt: saved.updatedAt, updatedByEmail: session.user.email, name: trimmed } }))
      setSaveToCloudPrompt(null)
    } catch (e) { setBanner({ kind: 'error', text: e.message }) }
    finally { setBusy(id, false) }
  }

  function askMoveToLocal(id) {
    const proj = projects[id]
    setConfirmDlg({
      title: 'Move out of the cloud?',
      text: `This deletes the shared cloud copy of "${proj.name}" — anyone else using this login loses access to it. The project itself stays right here, in this browser.`,
      buttons: [
        { label: 'Move to Local', danger: true, onClick: () => runOp(id, () => commitMoveToLocal(id)) },
        { label: 'Cancel', onClick: () => {} },
      ],
    })
  }
  async function commitMoveToLocal(id) {
    const proj = projects[id]
    const cloudId = proj.cloud.id
    await deleteCloudProject(cloudId)
    const next = { ...projects, [id]: { ...proj, cloud: null } }
    persist(next)
    setRemoteStatus(prev => { const n = { ...prev }; delete n[cloudId]; return n })
    setRemoteRows(prev => prev.filter(r => r.id !== cloudId))
  }

  function askDelete(id) {
    const proj = projects[id]
    if (!proj.cloud) { deleteProjectById(id); refreshProjects(); return }
    setConfirmDlg({
      title: `Delete "${proj.name}"?`,
      text: `It's linked to a shared cloud project.`,
      buttons: [
        { label: 'Delete local copy only', onClick: () => { deleteProjectById(id); refreshProjects() } },
        { label: 'Delete everywhere', danger: true, onClick: () => runOp(id, () => commitDeleteEverywhere(id)) },
        { label: 'Cancel', onClick: () => {} },
      ],
    })
  }
  async function commitDeleteEverywhere(id) {
    const proj = projects[id]
    const cloudId = proj.cloud.id
    await deleteCloudProject(cloudId)
    setRemoteRows(prev => prev.filter(r => r.id !== cloudId))
    setRemoteStatus(prev => { const n = { ...prev }; delete n[cloudId]; return n })
    deleteProjectById(id)
    refreshProjects()
  }
  function deleteRemoteRow(row) {
    runOp(row.id, async () => {
      await deleteCloudProject(row.id)
      setRemoteRows(prev => prev.filter(r => r.id !== row.id))
      setRemoteStatus(prev => { const n = { ...prev }; delete n[row.id]; return n })
    })
  }

  function duplicate(id) {
    const proj = projects[id]
    const state = (id === currentProjectId) ? captureProjectState() : proj.state
    const newId = saveProjectSlot(`${proj.name} copy`, null, state)
    refreshProjects()
    return newId
  }

  async function downloadOne(id) {
    try {
      const proj = projects[id]
      const state = (id === currentProjectId) ? captureProjectState() : proj.state
      downloadBlob(await buildProjectZipBlob(state), `${safeProjectName(proj.name)}.zip`)
    } catch (e) { setBanner({ kind: 'error', text: e.message }) }
  }
  async function downloadMany(idList) {
    try {
      const list = idList.map(i => ({
        name: projects[i].name,
        state: (i === currentProjectId) ? captureProjectState() : projects[i].state,
      }))
      downloadBlob(await buildProjectsZipBlob(list), 'projects.zip')
    } catch (e) { setBanner({ kind: 'error', text: e.message }) }
  }

  async function logOut() {
    if (!supabase) return
    await supabase.auth.signOut()
  }

  function openMenu(e, items) {
    e.preventDefault(); e.stopPropagation()
    setMenu({ x: e.clientX, y: e.clientY, items })
  }

  function itemMenuFor(id) {
    const proj = projects[id]
    const status = syncStatusOf(proj)
    return [
      { label: 'Open', onClick: () => { openProjectById(id); refreshProjects() } },
      { label: 'Rename', onClick: () => { setRenamingId(id); setRenameVal(proj.name) } },
      { label: 'Duplicate', onClick: () => duplicate(id) },
      { label: 'Download…', onClick: () => downloadOne(id) },
      { sep: true },
      ...(supabase ? (proj.cloud
        ? [
            { label: 'Sync now', disabled: !status || status === 'in-sync' || status === 'checking', onClick: () => handleSyncClick(id) },
            { label: 'Move to Local…', onClick: () => askMoveToLocal(id) },
          ]
        : [{ label: 'Move to Cloud…', disabled: !session, onClick: () => setSaveToCloudPrompt({ id, name: proj.name }) }]
      ) : []),
      { sep: true },
      { label: 'Delete…', danger: true, onClick: () => askDelete(id) },
    ]
  }

  // A cloud-linked project shows only in Cloud Storage — showing it in both
  // sections said the same thing twice.
  const localIds = ids.filter(i => !projects[i].cloud)
  const cloudIds = ids.filter(i => projects[i].cloud)
  const knownCloudIds = new Set(cloudIds.map(i => projects[i].cloud.id))
  // Rows with no real designer content are pure Beam Propagation containers —
  // pulling one would produce an empty project, so don't list it as if it wouldn't.
  const remoteOnlyRows = remoteRows.filter(r => !knownCloudIds.has(r.id) && r.hasDesignerContent)

  function ItemRow(id) {
    const proj = projects[id]
    const active = id === currentProjectId
    const status = syncStatusOf(proj)
    const busy = busyIds.has(id)
    return (
      <li key={id} className={`proj-item ${active ? 'active' : ''}`}
        onContextMenu={e => openMenu(e, itemMenuFor(id))}>
        {renamingId === id ? (
          <input className="snap-input" style={{ flex: 1 }} value={renameVal}
            autoFocus onChange={e => setRenameVal(e.target.value)}
            onBlur={() => commitRename(id)}
            onKeyDown={e => { if (e.key === 'Enter') commitRename(id); if (e.key === 'Escape') setRenamingId(null) }} />
        ) : (
          <>
            <SyncBadge status={status} busy={busy} onClick={() => handleSyncClick(id)} />
            <button className="proj-item-name"
              onClick={() => { openProjectById(id); refreshProjects() }}
              onDoubleClick={() => { setRenamingId(id); setRenameVal(proj.name) }}
              title="Click to open · double-click to rename · right-click for more">
              <span>{proj.name}</span>
              <span className="proj-item-date">{new Date(proj.savedAt).toLocaleString()}</span>
            </button>
          </>
        )}
        <button className="small-btn" title="Download" onClick={() => downloadOne(id)}>⇩</button>
        <button className="small-btn" title="More…" onClick={e => openMenu(e, itemMenuFor(id))}>⋯</button>
      </li>
    )
  }

  if (collapsed) {
    return (
      <aside className="proj-panel collapsed">
        <button className="proj-panel-collapsed-strip" onClick={() => setCollapsed(false)} title="Show projects">
          <span>»</span>
          <span className="proj-vert-label">Projects</span>
        </button>
      </aside>
    )
  }

  return (
    <aside className="proj-panel" style={{ width, transition: resizing ? 'none' : undefined }}>
      <div className="proj-panel-resize" onMouseDown={startResize} />
      <div className="proj-panel-head">
        <span>Projects</span>
        <button className="proj-collapse-btn" onClick={() => setCollapsed(true)} title="Hide projects">«</button>
      </div>

      {banner && (
        <div className={`proj-banner ${banner.kind}`}>
          <span>{banner.text}</span>
          <button onClick={() => setBanner(null)}>✕</button>
        </div>
      )}

      <div className="proj-panel-scroll">
        <div className="proj-section-heading">Local Storage</div>
        <div className="proj-actions">
          <button className="small-btn"
            onClick={() => { startNewProject(`Untitled ${localIds.length + 1}`); refreshProjects() }}>+ New</button>
          <button className="small-btn" onClick={onUploadProjectClick}
            title="Load an Optical Table Designer project .zip">Upload</button>
          {localIds.length > 0 && (
            <button className="small-btn" style={{ flex: 1 }} onClick={() => downloadMany(localIds)}>⇩ Download all</button>
          )}
        </div>
        <ul className="proj-list">
          {localIds.map(ItemRow)}
          {localIds.length === 0 && (
            <li className="proj-empty">No projects yet — click <b>+ New</b>.</li>
          )}
        </ul>
        <p className="proj-note">
          Local Storage projects live in this browser's cache — they'll disappear if you clear its site data, and won't follow you to another browser or device. Use Cloud Storage, or Download, for a durable copy.
        </p>

        <div className="proj-section-heading">Cloud Storage</div>
        {!supabase ? (
          <p className="proj-note">Cloud storage isn't configured for this deployment — Local Storage still works fully.</p>
        ) : (
          <>
            <div className="proj-section proj-cloud-account">
              {!session ? (
                <button className="small-btn" style={{ width: '100%' }} onClick={() => setAuthOpen(true)}>Sign in</button>
              ) : (
                <>
                  <span className="email">{session.user.email}</span>
                  <button className="small-btn" onClick={logOut}>Log out</button>
                </>
              )}
            </div>
            {session && (
              <>
                <div className="proj-actions">
                  <button className="small-btn" onClick={refreshRemote} title="Check for changes made elsewhere">⟳ Refresh</button>
                  {cloudIds.length > 0 && (
                    <button className="small-btn" style={{ flex: 1 }} onClick={() => downloadMany(cloudIds)}>⇩ Download all</button>
                  )}
                </div>
                {remoteError && <div className="proj-banner error"><span>{remoteError}</span></div>}
                <ul className="proj-list">
                  {cloudIds.map(ItemRow)}
                  {remoteOnlyRows.map(row => (
                    <li key={row.id} className="proj-item remote-only"
                      onContextMenu={e => openMenu(e, [
                        { label: 'Pull to Local Storage', onClick: () => pullRemoteRow(row) },
                        { sep: true },
                        { label: 'Delete from cloud…', danger: true, onClick: () => setConfirmDlg({
                            title: `Delete "${row.name}" from the cloud?`,
                            text: 'It has not been pulled into this browser, so nothing local is affected — but anyone else using this login loses access to it.',
                            buttons: [
                              { label: 'Delete from cloud', danger: true, onClick: () => deleteRemoteRow(row) },
                              { label: 'Cancel', onClick: () => {} },
                            ],
                          }) },
                      ])}>
                      <SyncBadge status="checking" busy={busyIds.has(row.id)} onClick={() => {}} />
                      <button className="proj-item-name" onClick={() => pullRemoteRow(row)}
                        title="Not yet in this browser — click to pull it into Local Storage">
                        <span>{row.name}</span>
                      </button>
                      <span className="proj-item-sub">not pulled</span>
                      <button className="small-btn" title="Pull to Local Storage" disabled={busyIds.has(row.id)}
                        onClick={() => pullRemoteRow(row)}>⇩</button>
                    </li>
                  ))}
                  {cloudIds.length === 0 && remoteOnlyRows.length === 0 && (
                    <li className="proj-empty">No cloud projects yet. Right-click a Local Storage project and choose <b>Move to Cloud…</b>.</li>
                  )}
                </ul>
                <p className="proj-note">
                  Shared with anyone logged in as this account. Pulled projects are also kept in Local Storage.
                </p>
              </>
            )}
          </>
        )}
      </div>

      {authOpen && <AuthPanel onClose={() => setAuthOpen(false)} />}

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}

      {confirmDlg && (
        <div className="modal-backdrop" onClick={() => setConfirmDlg(null)}>
          <div className="modal-box" onClick={e => e.stopPropagation()}>
            <div className="modal-title">{confirmDlg.title}</div>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '4px 0 12px' }}>{confirmDlg.text}</p>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {confirmDlg.buttons.map((b, i) => (
                <button key={i} className="small-btn" style={b.danger ? { color: '#ff8080' } : undefined}
                  onClick={() => { b.onClick(); setConfirmDlg(null) }}>{b.label}</button>
              ))}
            </div>
          </div>
        </div>
      )}

      {saveToCloudPrompt && (
        <div className="modal-backdrop" onClick={() => setSaveToCloudPrompt(null)}>
          <div className="modal-box" onClick={e => e.stopPropagation()}>
            <div className="modal-title">Move to Cloud</div>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '4px 0 8px' }}>
              Saves this project to your account under the name below.
            </p>
            <form onSubmit={e => { e.preventDefault(); if (saveToCloudPrompt.name.trim()) commitMoveToCloud(saveToCloudPrompt.id, saveToCloudPrompt.name) }}>
              <input className="snap-input" style={{ width: '100%', marginBottom: 12, boxSizing: 'border-box' }} autoFocus
                placeholder="Cloud project name" value={saveToCloudPrompt.name}
                onChange={e => setSaveToCloudPrompt(prev => ({ ...prev, name: e.target.value }))} />
              <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                <button type="button" className="small-btn" onClick={() => setSaveToCloudPrompt(null)}>Cancel</button>
                <button type="submit" className="small-btn" disabled={busyIds.has(saveToCloudPrompt.id) || !saveToCloudPrompt.name.trim()}>
                  {busyIds.has(saveToCloudPrompt.id) ? 'Saving…' : 'Move to Cloud'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </aside>
  )
}
