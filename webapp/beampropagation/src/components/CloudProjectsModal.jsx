import { useEffect, useState } from 'react'
import { listCloudProjects, deleteCloudProject } from '../utils/cloudProjects'

// Lists the logged-in account's cloud projects and lets you open or delete
// one. Kept as its own modal rather than a tab on the local "Switch Project"
// modal: unlike that modal, this one is async (loading/error state) and has
// no local-storage equivalent to piggyback on.
export default function CloudProjectsModal({ currentCloudProjectId, onOpen, onClose }) {
  const [projects, setProjects] = useState(null) // null = loading
  const [error, setError]       = useState(null)
  const [busyId, setBusyId]     = useState(null)

  function refresh() {
    listCloudProjects()
      .then(list => { setProjects(list); setError(null) })
      .catch(e => setError(e.message))
  }

  useEffect(() => { refresh() }, [])

  async function handleOpen(id) {
    setBusyId(id); setError(null)
    try {
      await onOpen(id)
    } catch (e) {
      setError(e.message)
    } finally {
      setBusyId(null)
    }
  }

  async function handleDelete(id) {
    setBusyId(id); setError(null)
    try {
      await deleteCloudProject(id)
      refresh()
    } catch (e) {
      setError(e.message)
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-box modal-box-wide" onClick={e => e.stopPropagation()}>
        <div className="modal-title">Open Cloud Project</div>
        <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '4px 0 8px' }}>
          Projects saved to this account, including Optical Table Designer projects — opening one
          loads its beam paths for Import… and its propagations. Only visible to whoever is logged in as this account.
        </p>
        {error && <div style={{ fontSize: 12, color: '#ff6b6b', margin: '4px 0 8px' }}>{error}</div>}
        {projects === null
          ? <p style={{ color: 'var(--text-muted)', fontSize: 12, margin: '8px 0' }}>Loading…</p>
          : projects.length === 0
            ? <p style={{ color: 'var(--text-muted)', fontSize: 12, margin: '8px 0' }}>No cloud projects yet.</p>
            : (
              <ul className="project-list">
                {projects.map(p => (
                  <li key={p.id} className={`project-item ${p.id === currentCloudProjectId ? 'project-item-current' : ''}`}>
                    <button className="project-item-name" disabled={busyId === p.id}
                      onClick={() => handleOpen(p.id)} title="Click to open">
                      <span className="project-item-label">{p.name}</span>
                      <span className="project-item-date">
                        {new Date(p.updatedAt).toLocaleString()}{p.updatedByEmail ? ` · ${p.updatedByEmail}` : ''}
                      </span>
                    </button>
                    <button className="small-btn project-item-del" title="Delete" disabled={busyId === p.id}
                      onClick={() => handleDelete(p.id)}>✕</button>
                  </li>
                ))}
              </ul>
            )
        }
        <button className="small-btn" style={{ marginTop: 8 }} onClick={onClose}>Close</button>
      </div>
    </div>
  )
}
