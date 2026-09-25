// The left rail: switches between propagations, split into two lists —
// Local Storage (everything in this browser) and Cloud Storage (the subset
// that's also linked to a shared cloud project, plus any cloud projects not
// yet pulled into this browser). Local Storage always shows everything,
// including cloud-linked items, per-item sync status shown as a small badge.
//
// A "cloud project" (a row in the shared cloud_projects table) can hold
// several propagations at once — e.g. one pulled from the Optical Table
// Designer, or several saved together from here. Propagations that share a
// cloud project are a "bundle": syncing, or deleting-everywhere, any one of
// them acts on the whole bundle, since they all live in the same row.
import { useEffect, useRef, useState } from 'react'
import { supabase } from '../supabaseClient'
import AuthPanel from './AuthPanel'
import {
  listCloudProjects, fetchCloudProject, insertCloudProject,
  updateCloudProjectPropagations, deleteCloudProject,
} from '../utils/cloudProjects'
import { propagationsFromFileShape, fingerprintPropagation } from '../utils/propagationModel'
import { serializePropagationsJson } from '../utils/propagationsJson'

const REMOTE_POLL_MS = 30_000

function triggerJsonDownload(map, filename) {
  const blob = new Blob([serializePropagationsJson(map)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click()
  URL.revokeObjectURL(url)
}
function safeName(name) { return (name || 'propagation').replace(/[/\\?%*:|"<>]/g, '_').trim() || 'propagation' }

// Sync-status dot: ✓ in sync, ↑ needs push, ↓ needs pull, ! conflict, … unknown.
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
  // Keep it on-screen if opened near the bottom-right edge.
  const style = { left: Math.min(x, window.innerWidth - 190), top: Math.min(y, window.innerHeight - 8 - items.length * 28) }
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

export default function ProjectsRail({
  propagations, activeId, setActive, commitPropsDiscrete,
  onNewPropagation, onUploadPropagationsClick,
}) {
  function deleteLocalOnly(id) {
    const { [id]: _drop, ...rest } = propagations
    commitPropsDiscrete(rest)
    if (activeId === id) setActive(Object.keys(rest)[0] ?? null)
  }

  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem('beamProp_railCollapsed') === '1' } catch { return false }
  })
  useEffect(() => { try { localStorage.setItem('beamProp_railCollapsed', collapsed ? '1' : '0') } catch {} }, [collapsed])

  const [width, setWidth] = useState(() => {
    try { return Number(localStorage.getItem('beamProp_railWidth')) || 240 } catch { return 240 }
  })
  useEffect(() => { try { localStorage.setItem('beamProp_railWidth', String(width)) } catch {} }, [width])
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

  // Live status for every cloud project this account has, refreshed on a
  // timer plus whenever we push/pull. Keyed by cloud_projects row id.
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

  const [renamingId, setRenamingId] = useState(null)
  const [renameVal, setRenameVal] = useState('')
  const [menu, setMenu] = useState(null) // { x, y, items }
  const [confirmDlg, setConfirmDlg] = useState(null) // { title, text, buttons: [{label, onClick, danger}] }
  const [saveToCloudPrompt, setSaveToCloudPrompt] = useState(null) // { id, name }
  const [banner, setBanner] = useState(null) // { kind: 'error'|'notice', text }
  const [authOpen, setAuthOpen] = useState(false)

  const ids = Object.keys(propagations)

  function commitRename(id) {
    const trimmed = renameVal.trim()
    if (trimmed) commitPropsDiscrete({ ...propagations, [id]: { ...propagations[id], name: trimmed } })
    setRenamingId(null)
  }

  function syncStatusOf(prop) {
    if (!prop.cloud) return null
    const localDirty = fingerprintPropagation(prop) !== prop.cloud.syncedFingerprint
    const remote = remoteStatus[prop.cloud.id]
    if (!remote) return 'checking'
    const remoteChanged = remote.updatedAt !== prop.cloud.syncedUpdatedAt
    if (!localDirty && !remoteChanged) return 'in-sync'
    if (localDirty && !remoteChanged) return 'ahead'
    if (!localDirty && remoteChanged) return 'behind'
    return 'conflict'
  }

  // ── Cloud bundle push / pull — the unit of sync is the whole cloud project,
  // since that's the row being written or read. ──────────────────────────
  async function pushBundle(cloudId) {
    const latest = await fetchCloudProject(cloudId)
    const siblingIds = ids.filter(i => propagations[i].cloud?.id === cloudId)
    const bundle = {}; siblingIds.forEach(i => { bundle[i] = propagations[i] })
    const activeInBundle = siblingIds.includes(activeId) ? activeId : (siblingIds[0] ?? null)
    const saved = await updateCloudProjectPropagations(
      latest.id, latest.name, latest.state, bundle, activeInBundle, session.user)
    const patch = {}
    siblingIds.forEach(i => {
      patch[i] = { ...propagations[i], cloud: {
        id: cloudId, projectName: saved.name, syncedAt: Date.now(),
        syncedUpdatedAt: saved.updatedAt, syncedFingerprint: fingerprintPropagation(propagations[i]),
      } }
    })
    commitPropsDiscrete({ ...propagations, ...patch })
    setRemoteStatus(prev => ({ ...prev, [cloudId]: { updatedAt: saved.updatedAt, updatedByEmail: session.user.email, name: saved.name } }))
  }

  async function pullBundle(cloudId) {
    const remote = await fetchCloudProject(cloudId)
    const pulled = propagationsFromFileShape(remote.state.propagations)
    const patch = {}
    for (const [pid, p] of Object.entries(pulled)) {
      patch[pid] = { ...p, cloud: {
        id: cloudId, projectName: remote.name, syncedAt: Date.now(),
        syncedUpdatedAt: remote.updatedAt, syncedFingerprint: fingerprintPropagation(p),
      } }
    }
    // Siblings that used to belong to this bundle but were deleted server-side.
    const staleSiblings = ids.filter(i => propagations[i].cloud?.id === cloudId && !(i in pulled))
    const next = { ...propagations, ...patch }
    staleSiblings.forEach(i => delete next[i])
    commitPropsDiscrete(next)
    if (!activeId || staleSiblings.includes(activeId)) {
      const firstPulled = Object.keys(pulled)[0]
      if (firstPulled) setActive(firstPulled)
    }
    setRemoteStatus(prev => ({ ...prev, [cloudId]: { updatedAt: remote.updatedAt, updatedByEmail: remote.updatedByEmail, name: remote.name } }))
    return Object.keys(pulled).length
  }

  async function runSync(id, direction) {
    const prop = propagations[id]
    setBusy(id, true)
    try {
      if (direction === 'push') await pushBundle(prop.cloud.id)
      else await pullBundle(prop.cloud.id)
    } catch (e) { setBanner({ kind: 'error', text: e.message }) }
    finally { setBusy(id, false) }
  }

  function handleSyncClick(id) {
    const prop = propagations[id]
    const status = syncStatusOf(prop)
    if (!prop.cloud || status === 'checking' || busyIds.has(id)) return
    if (status === 'in-sync') { setBanner({ kind: 'notice', text: `"${prop.name}" is already in sync.` }); return }
    if (status === 'conflict') {
      setConfirmDlg({
        title: 'Out of sync with the cloud',
        text: `"${prop.name}" has changed here, and its cloud project has also changed since the last sync. Which should win?`,
        buttons: [
          { label: 'Keep mine (overwrite cloud)', onClick: () => runSync(id, 'push') },
          { label: 'Use cloud version (discard mine)', onClick: () => runSync(id, 'pull') },
          { label: 'Cancel', onClick: () => {} },
        ],
      })
      return
    }
    runSync(id, status === 'ahead' ? 'push' : 'pull')
  }

  async function pullRemoteRow(row) {
    setBusy(row.id, true)
    try {
      const n = await pullBundle(row.id)
      setBanner({ kind: 'notice', text: `Pulled ${n} propagation${n === 1 ? '' : 's'} from "${row.name}" into Local Storage.` })
    } catch (e) { setBanner({ kind: 'error', text: e.message }) }
    finally { setBusy(row.id, false) }
  }

  async function commitMoveToCloud(id, name) {
    const prop = propagations[id]
    setBusy(id, true)
    try {
      const saved = await insertCloudProject(name, { [id]: prop }, id, session.user)
      const patch = { [id]: { ...prop, cloud: {
        id: saved.id, projectName: saved.name, syncedAt: Date.now(),
        syncedUpdatedAt: saved.updatedAt, syncedFingerprint: fingerprintPropagation(prop),
      } } }
      commitPropsDiscrete({ ...propagations, ...patch })
      setRemoteStatus(prev => ({ ...prev, [saved.id]: { updatedAt: saved.updatedAt, updatedByEmail: session.user.email, name: saved.name } }))
      setSaveToCloudPrompt(null)
    } catch (e) { setBanner({ kind: 'error', text: e.message }) }
    finally { setBusy(id, false) }
  }

  function askMoveToLocal(id) {
    const prop = propagations[id]
    const cloudId = prop.cloud.id
    const siblings = ids.filter(i => propagations[i].cloud?.id === cloudId && i !== id)
    setConfirmDlg({
      title: 'Move out of the cloud?',
      text: `This deletes the shared cloud copy of "${prop.name}" — anyone else using this login loses access to it. The propagation itself stays right here, in this browser.`
        + (siblings.length
          ? ` It shares that cloud project with ${siblings.length} other propagation${siblings.length === 1 ? '' : 's'} (${siblings.map(i => propagations[i].name).join(', ')}), which ${siblings.length === 1 ? 'is' : 'are'} deleted from the cloud too — they stay here as local copies.`
          : ''),
      buttons: [
        { label: 'Move to Local', danger: true, onClick: () => commitMoveToLocal(id) },
        { label: 'Cancel', onClick: () => {} },
      ],
    })
  }
  async function commitMoveToLocal(id) {
    const prop = propagations[id]
    const cloudId = prop.cloud.id
    const siblings = ids.filter(i => propagations[i].cloud?.id === cloudId)
    setBusy(id, true)
    try {
      await deleteCloudProject(cloudId)
      const patch = {}
      siblings.forEach(i => { patch[i] = { ...propagations[i], cloud: null } })
      commitPropsDiscrete({ ...propagations, ...patch })
      setRemoteStatus(prev => { const n = { ...prev }; delete n[cloudId]; return n })
      setRemoteRows(prev => prev.filter(r => r.id !== cloudId))
    } catch (e) { setBanner({ kind: 'error', text: e.message }) }
    finally { setBusy(id, false) }
  }

  function askDelete(id) {
    const prop = propagations[id]
    if (!prop.cloud) { deleteLocalOnly(id); return }
    const cloudId = prop.cloud.id
    const siblings = ids.filter(i => propagations[i].cloud?.id === cloudId && i !== id)
    setConfirmDlg({
      title: `Delete "${prop.name}"?`,
      text: `It's linked to a shared cloud project.`
        + (siblings.length ? ` (shared with ${siblings.length} other propagation${siblings.length === 1 ? '' : 's'}: ${siblings.map(i => propagations[i].name).join(', ')})` : ''),
      buttons: [
        { label: 'Delete local copy only', onClick: () => deleteLocalOnly(id) },
        { label: 'Delete everywhere', danger: true, onClick: () => commitDeleteEverywhere(id) },
        { label: 'Cancel', onClick: () => {} },
      ],
    })
  }
  async function commitDeleteEverywhere(id) {
    const prop = propagations[id]
    const cloudId = prop.cloud.id
    const siblings = ids.filter(i => propagations[i].cloud?.id === cloudId && i !== id)
    setBusy(id, true)
    try {
      if (!siblings.length) {
        await deleteCloudProject(cloudId)
        setRemoteRows(prev => prev.filter(r => r.id !== cloudId))
        setRemoteStatus(prev => { const n = { ...prev }; delete n[cloudId]; return n })
      } else {
        const latest = await fetchCloudProject(cloudId)
        const bundle = {}; siblings.forEach(i => { bundle[i] = propagations[i] })
        await updateCloudProjectPropagations(latest.id, latest.name, latest.state, bundle, siblings[0], session.user)
      }
      deleteLocalOnly(id)
    } catch (e) { setBanner({ kind: 'error', text: e.message }) }
    finally { setBusy(id, false) }
  }
  async function deleteRemoteRow(row) {
    setBusy(row.id, true)
    try {
      await deleteCloudProject(row.id)
      setRemoteRows(prev => prev.filter(r => r.id !== row.id))
      setRemoteStatus(prev => { const n = { ...prev }; delete n[row.id]; return n })
    } catch (e) { setBanner({ kind: 'error', text: e.message }) }
    finally { setBusy(row.id, false) }
  }

  function duplicate(id) {
    const src = propagations[id]
    const copy = { ...src, id: crypto.randomUUID(), name: `${src.name || 'Propagation'} copy`, cloud: null }
    commitPropsDiscrete({ ...propagations, [copy.id]: copy })
    setActive(copy.id)
  }

  function downloadOne(id) {
    triggerJsonDownload({ [id]: propagations[id] }, `${safeName(propagations[id].name)}.json`)
  }
  function downloadMany(idList, filename) {
    const m = {}; idList.forEach(i => { m[i] = propagations[i] })
    triggerJsonDownload(m, filename)
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
    const prop = propagations[id]
    const status = syncStatusOf(prop)
    return [
      { label: 'Open', onClick: () => setActive(id) },
      { label: 'Rename', onClick: () => { setRenamingId(id); setRenameVal(prop.name) } },
      { label: 'Duplicate', onClick: () => duplicate(id) },
      { label: 'Download…', onClick: () => downloadOne(id) },
      { sep: true },
      ...(supabase ? (prop.cloud
        ? [
            { label: 'Sync now', disabled: !status || status === 'in-sync' || status === 'checking', onClick: () => handleSyncClick(id) },
            { label: 'Move to Local…', onClick: () => askMoveToLocal(id) },
          ]
        : [{ label: 'Move to Cloud…', disabled: !session, onClick: () => { setSaveToCloudPrompt({ id, name: prop.name }) } }]
      ) : []),
      { sep: true },
      { label: 'Delete…', danger: true, onClick: () => askDelete(id) },
    ]
  }

  // A cloud-linked propagation shows only in Cloud Storage — showing it in
  // both sections said the same thing twice.
  const localIds = ids.filter(i => !propagations[i].cloud)
  const cloudIds = ids.filter(i => propagations[i].cloud)
  const knownCloudIds = new Set(cloudIds.map(i => propagations[i].cloud.id))
  // Rows without any propagations are designer projects irrelevant to this
  // app — pulling one would bring in nothing, so don't list it as if it would.
  const remoteOnlyRows = remoteRows.filter(r => !knownCloudIds.has(r.id) && r.hasPropagations)

  function ItemRow(id) {
    const prop = propagations[id]
    const active = id === activeId
    const status = syncStatusOf(prop)
    const busy = busyIds.has(id)
    return (
      <li key={id} className={`prop-rail-item ${active ? 'active' : ''}`}
        onContextMenu={e => openMenu(e, itemMenuFor(id))}>
        {renamingId === id ? (
          <input className="snap-input" style={{ flex: 1 }} value={renameVal}
            autoFocus onChange={e => setRenameVal(e.target.value)}
            onBlur={() => commitRename(id)}
            onKeyDown={e => { if (e.key === 'Enter') commitRename(id); if (e.key === 'Escape') setRenamingId(null) }} />
        ) : (
          <>
            <SyncBadge status={status} busy={busy} onClick={() => handleSyncClick(id)} />
            <button className="prop-rail-name"
              onClick={() => setActive(id)}
              onDoubleClick={() => { setRenamingId(id); setRenameVal(prop.name) }}
              title="Click to open · double-click to rename · right-click for more">
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{prop.name}</span>
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
      <aside className="prop-rail collapsed">
        <button className="prop-rail-collapsed-strip" onClick={() => setCollapsed(false)} title="Show propagations">
          <span>»</span>
          <span className="rail-vert-label">Propagations</span>
        </button>
      </aside>
    )
  }

  return (
    <aside className="prop-rail" style={{ width, transition: resizing ? 'none' : undefined }}>
      <div className="prop-rail-resize" onMouseDown={startResize} />
      <div className="prop-rail-head">
        <span style={{ fontSize: 12, fontWeight: 600 }}>Propagations</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{ids.length} plot{ids.length === 1 ? '' : 's'}</span>
          <button className="rail-collapse-btn" onClick={() => setCollapsed(true)} title="Hide this panel">«</button>
        </span>
      </div>

      {banner && (
        <div className={`rail-banner ${banner.kind}`}>
          <span>{banner.text}</span>
          <button onClick={() => setBanner(null)}>✕</button>
        </div>
      )}

      {/* Local Storage and Cloud Storage are both always shown, one above
          the other, rather than behind a tab switch. */}
      <div className="rail-scroll">
        <div className="rail-section-heading">Local Storage</div>
        <div className="prop-rail-actions">
          <button className="small-btn" onClick={onNewPropagation}>+ New</button>
          <button className="small-btn" onClick={onUploadPropagationsClick}
            title="Load propagations saved earlier (propagations.json)">Upload</button>
          {localIds.length > 0 && (
            <button className="small-btn" style={{ flex: 1 }}
              onClick={() => downloadMany(localIds, 'propagations.json')}>⇩ Download all</button>
          )}
        </div>
        <ul className="prop-rail-list">
          {localIds.map(ItemRow)}
          {localIds.length === 0 && (
            <li className="prop-rail-empty">No propagations yet — click <b>+ New</b>, or <b>Upload</b> a propagations.json.</li>
          )}
        </ul>
        <p className="rail-note">
          Local Storage projects live in this browser's cache — they'll disappear if you clear its site data, and won't follow you to another browser or device. Use Cloud Storage, or Download, for a durable copy.
        </p>

        <div className="rail-section-heading">Cloud Storage</div>
        {!supabase ? (
          <p className="rail-note">Cloud storage isn't configured for this deployment — Local Storage still works fully.</p>
        ) : (
          <>
            <div className="rail-section rail-cloud-account">
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
                <div className="prop-rail-actions">
                  <button className="small-btn" onClick={refreshRemote} title="Check for changes made elsewhere">⟳ Refresh</button>
                  {cloudIds.length > 0 && (
                    <button className="small-btn" style={{ flex: 1 }}
                      onClick={() => downloadMany(cloudIds, 'propagations.json')}>⇩ Download all</button>
                  )}
                </div>
                {remoteError && <div className="rail-banner error"><span>{remoteError}</span></div>}
                <ul className="prop-rail-list">
                  {cloudIds.map(ItemRow)}
                  {remoteOnlyRows.map(row => (
                    <li key={row.id} className="prop-rail-item remote-only"
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
                      <button className="prop-rail-name" onClick={() => pullRemoteRow(row)}
                        title="Not yet in this browser — click to pull it into Local Storage">
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{row.name}</span>
                      </button>
                      <span className="rail-item-sub">not pulled</span>
                      <button className="small-btn" title="Pull to Local Storage" disabled={busyIds.has(row.id)}
                        onClick={() => pullRemoteRow(row)}>⇩</button>
                    </li>
                  ))}
                  {cloudIds.length === 0 && remoteOnlyRows.length === 0 && (
                    <li className="prop-rail-empty">No cloud projects yet. Right-click a Local Storage propagation and choose <b>Move to Cloud…</b>.</li>
                  )}
                </ul>
                <p className="rail-note">
                  Shared with anyone logged in as this account — including in the Optical Table Designer, which sees these as regular projects. Pulled propagations are also kept in Local Storage.
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
            <p className="modal-text">{confirmDlg.text}</p>
            <div className="modal-actions" style={{ flexWrap: 'wrap' }}>
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
            <p className="modal-text">Creates a new cloud project holding just this propagation, saved to your account.</p>
            <form onSubmit={e => { e.preventDefault(); if (saveToCloudPrompt.name.trim()) commitMoveToCloud(saveToCloudPrompt.id, saveToCloudPrompt.name) }}>
              <input className="snap-input" style={{ width: '100%', marginBottom: 12, boxSizing: 'border-box' }} autoFocus
                placeholder="Cloud project name" value={saveToCloudPrompt.name}
                onChange={e => setSaveToCloudPrompt(prev => ({ ...prev, name: e.target.value }))} />
              <div className="modal-actions">
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
