import { useState, useEffect, useRef } from 'react'
import { colorToHex, AVAILABLE_SYMBOLS } from '../utils/symbols'
import './Sidebar.css'

const SNAP_PRESETS = [0.25, 0.5, 1, 2]

// ── Tiny color swatch that doubles as a color picker ──────────────────────────
function ColorSwatch({ color, onChange, size = 10 }) {
  return (
    <label className="color-swatch" style={{ width: size, height: size, background: color }} title="Change color">
      <input type="color" value={colorToHex(color)} onChange={e => onChange(e.target.value)} />
    </label>
  )
}

export default function Sidebar({
  // Beam paths
  beamPaths, visiblePaths, onToggle, onToggleAll,
  onAddPath, onDeletePath, onSetPathColor, onRenamePath,
  // Beam path editing
  selectedLabels, selectedElement, allMetaKeys, onUpdateElement, onRenameElement,
  editingPath, onSetEditingPath, onDeleteEdge,
  // Background objects
  bgGroups, visibleBg, onToggleBg, onToggleAllBg,
  onAddBgGroup, onDeleteBgGroup, onSetBgGroupColor, onSetBgGroupStroke, onRenameBgGroup,
  editingBgGroup, onSetEditingBgGroup, onDeleteBgEdge, onUpdateBgEdge,
  onAddBgLabel, onDeleteBgLabel, onUpdateBgLabel,
  pendingBgLabelText, onSetPendingBgLabelText,
  // Background images
  bgImages, onAddBgImage, onDeleteBgImage, onUpdateBgImage, onRenameBgImage,
  editingBgImage, onSetEditingBgImage,
  // Config + settings
  config, onConfigChange,
  settings, onSettingsChange,
  // Symbol defs
  symbolDefs, onAddSymbolDef, onUpdateSymbolDef, onDeleteSymbolDef, onRenameSymbolDef,
  // Elements list + add
  elements, onSelectElement,
  onAddElement, lastAddedTypeRef,
  addElemAt, onAddElemAtDone,
  // Layers
  layers, activeLayer,
  onSetActiveLayer, onAddLayer, onDeleteLayer, onSetLayerVisible, onRenameLayer,
  sidebarWidth,
  // Sidebar tab: optionally controlled by the parent so keyboard shortcuts
  // (N in particular) can flip us to the Elements tab in the same update as
  // their other state, without depending on a cross-boundary effect.
  tab: controlledTab, onTabChange,
}) {
  const [localTab, setLocalTab] = useState('paths')
  const tab = controlledTab ?? localTab
  const setTab = onTabChange ?? setLocalTab

  // Beam path add form
  const [addingPath, setAddingPath] = useState(false)
  const [newPathName,  setNewPathName]  = useState('')
  const [newPathColor, setNewPathColor] = useState('#4a90d9')

  // Bg group add form
  const [addingBg,     setAddingBg]     = useState(false)
  const [newBgName,    setNewBgName]    = useState('')
  const [newBgColor,   setNewBgColor]   = useState('#888888')
  const [newBgStroke,  setNewBgStroke]  = useState(2)

  // Rename state
  const [renamingPath, setRenamingPath] = useState(null)
  const [renamePathVal, setRenamePathVal] = useState('')
  const [renamingBg,   setRenamingBg]   = useState(null)
  const [renameBgVal,  setRenameBgVal]  = useState('')
  const [renamingBgImg, setRenamingBgImg] = useState(null)
  const [renameBgImgVal, setRenameBgImgVal] = useState('')
  const bgImageFileRef = useRef(null)

  // Symbol def add / rename
  const [addingSymbol,    setAddingSymbol]    = useState(false)
  const [newSymType,      setNewSymType]      = useState('')
  const [newSymHref,      setNewSymHref]      = useState('b-mir.svg')
  const [newSymW,         setNewSymW]         = useState(null)
  const [newSymH,         setNewSymH]         = useState(null)
  const [newSymDisplayH,  setNewSymDisplayH]  = useState(11)
  const [editingSymType,  setEditingSymType]  = useState(null)
  const [renamingSymType, setRenamingSymType] = useState(null)
  const [renameSymVal,    setRenameSymVal]    = useState('')

  // Add element form
  const [addingElement, setAddingElement] = useState(false)
  const [newElemType,   setNewElemType]   = useState('')
  const [newElemLabel,  setNewElemLabel]  = useState('')
  const [newElemX,      setNewElemX]      = useState(null)
  const [newElemY,      setNewElemY]      = useState(null)

  // Layers
  const [addingLayer,    setAddingLayer]    = useState(false)
  const [newLayerName,   setNewLayerName]   = useState('')
  const [renamingLayer,  setRenamingLayer]  = useState(null)
  const [renameLayerVal, setRenameLayerVal] = useState('')

  // Triggered by N key from canvas
  useEffect(() => {
    if (!addElemAt) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- syncing the add-element form from an external trigger (N key on canvas), not derived render state
    setNewElemLabel(addElemAt.label)
    setNewElemType(addElemAt.type)
    setNewElemX(addElemAt.x)
    setNewElemY(addElemAt.y)
    setAddingElement(true)
    setTab('elements')
    onAddElemAtDone?.()
  }, [addElemAt]) // eslint-disable-line react-hooks/exhaustive-deps

  // Elements tab filter
  const [elemFilter, setElemFilter] = useState('')

  function set(key, val) { onSettingsChange({ ...settings, [key]: val }) }
  function setNum(key, val) { const v = parseFloat(val); if (!isNaN(v) && v > 0) set(key, v) }
  // Variant for settings where 0 is meaningful (e.g. beam offset 0 = no fan-out).
  function setNumZeroOk(key, val) { const v = parseFloat(val); if (!isNaN(v) && v >= 0) set(key, v) }
  function setConfig(key, val) {
    const v = parseFloat(val)
    if (isNaN(v)) return
    const isOrigin = key === 'origin_x' || key === 'origin_y'
    if (isOrigin || v > 0) onConfigChange({ ...config, [key]: v })
  }

  const pathNames  = Object.keys(beamPaths)
  const allOn      = pathNames.every(n => visiblePaths[n])
  const allOff     = pathNames.every(n => !visiblePaths[n])
  const bgNames    = Object.keys(bgGroups ?? {})
  const allBgOn    = bgNames.every(n => visibleBg?.[n])
  const allBgOff   = bgNames.every(n => !visibleBg?.[n])

  function commitAddPath() {
    const name = newPathName.trim()
    if (!name) return
    onAddPath(name, newPathColor)
    setNewPathName(''); setAddingPath(false)
  }

  function commitAddBg() {
    const name = newBgName.trim()
    if (!name) return
    onAddBgGroup(name, newBgColor, newBgStroke)
    setNewBgName(''); setAddingBg(false)
  }

  function commitAddSymbol() {
    const type = newSymType.trim().toLowerCase()
    if (!type) return
    const isCustom = newSymHref.startsWith('data:')
    const href = isCustom ? newSymHref : `/symbols/${newSymHref}`
    const w = isCustom && newSymW ? newSymW : newSymDisplayH
    const h = isCustom && newSymH ? newSymH : newSymDisplayH
    onAddSymbolDef(type, { href, w, h, displayH: newSymDisplayH })
    setNewSymType(''); setNewSymHref('b-mir.svg'); setNewSymW(null); setNewSymH(null); setAddingSymbol(false)
  }

  // Custom entries: symbolDefs that use uploaded (data URL) SVGs
  const customEntries = Object.entries(symbolDefs)
    .filter(([, def]) => def.href?.startsWith('data:'))
    .map(([type, def]) => ({ label: type, href: def.href, w: def.w, h: def.h }))

  return (
    <aside className="sidebar" style={{ fontSize: `${settings.uiFontSize ?? 12}px`, width: sidebarWidth ?? 280 }}>
      <div className="sidebar-tabs">
        <button className={`sidebar-tab ${tab === 'paths'    ? 'active' : ''}`} onClick={() => setTab('paths')}>Paths</button>
        <button className={`sidebar-tab ${tab === 'elements' ? 'active' : ''}`} onClick={() => setTab('elements')}>Elements</button>
        <button className={`sidebar-tab ${tab === 'objects'  ? 'active' : ''}`} onClick={() => setTab('objects')}>Objects</button>
        <button className={`sidebar-tab ${tab === 'settings' ? 'active' : ''}`} onClick={() => setTab('settings')}>Settings</button>
      </div>

      <div className="sidebar-body">
      {/* ── Paths tab ─────────────────────────────────────────────────────── */}
      {tab === 'paths' && (
        <>
          <section className="sidebar-section">
            <div className="sidebar-section-header">
              <span>Beam Paths</span>
              <div className="toggle-all-btns">
                <button onClick={() => onToggleAll(true)}  disabled={allOn}  className="small-btn">All</button>
                <button onClick={() => onToggleAll(false)} disabled={allOff} className="small-btn">None</button>
                <button onClick={() => setAddingPath(p => !p)} className="small-btn">+</button>
              </div>
            </div>

            {addingPath && (
              <div className="add-group-form">
                <input className="snap-input add-name-input" placeholder="Path name"
                  value={newPathName} onChange={e => setNewPathName(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') commitAddPath(); if (e.key === 'Escape') setAddingPath(false) }}
                  autoFocus />
                <ColorSwatch color={newPathColor} onChange={setNewPathColor} size={16} />
                <button className="small-btn" onClick={commitAddPath}>Add</button>
                <button className="small-btn" onClick={() => setAddingPath(false)}>✕</button>
              </div>
            )}

            <ul className="path-list">
              {pathNames.map(name => {
                const { color } = beamPaths[name]
                const on        = visiblePaths[name]
                const isEditing = name === editingPath
                const isRenaming = renamingPath === name
                return (
                  <li key={name} className={`path-item ${on ? 'on' : 'off'} ${isEditing ? 'editing' : ''}`}>
                    <ColorSwatch color={color} onChange={c => onSetPathColor(name, c)} />
                    {isRenaming ? (
                      <input className="snap-input" style={{ flex: 1 }}
                        value={renamePathVal}
                        onChange={e => setRenamePathVal(e.target.value)}
                        onBlur={() => { onRenamePath(name, renamePathVal); setRenamingPath(null) }}
                        onKeyDown={e => {
                          if (e.key === 'Enter') { onRenamePath(name, renamePathVal); setRenamingPath(null) }
                          if (e.key === 'Escape') setRenamingPath(null)
                        }}
                        autoFocus />
                    ) : (
                      <span className="path-name"
                        onClick={() => onToggle(name)}
                        onDoubleClick={() => { setRenamingPath(name); setRenamePathVal(name) }}
                        title="Double-click to rename">{name}</span>
                    )}
                    <button
                      className={`path-edit-btn ${isEditing ? 'active' : ''}`}
                      title={isEditing ? 'Stop editing' : 'Edit edges'}
                      onClick={() => onSetEditingPath(isEditing ? null : name)}
                    >✎</button>
                    <button className="path-delete-btn" title="Delete path"
                      onClick={() => onDeletePath(name)}>✕</button>
                  </li>
                )
              })}
            </ul>
          </section>

          {/* Beam path edge editor */}
          {editingPath && beamPaths[editingPath] && (
            <section className="sidebar-section path-edit-panel">
              <div className="sidebar-section-header">
                <span style={{ color: beamPaths[editingPath].color }}>● {editingPath}</span>
                <button className="small-btn" onClick={() => onSetEditingPath(null)}>Done</button>
              </div>
              <p className="path-edit-hint">Click src → dest on canvas to add · click edge to delete</p>
              <ul className="edge-list">
                {(beamPaths[editingPath].edges ?? []).map(([src, dest], i) => (
                  <li key={i} className="edge-item">
                    <span className="edge-label">{src} → {dest}</span>
                    <button className="edge-delete" onClick={() => onDeleteEdge(i)}>✕</button>
                  </li>
                ))}
                {!(beamPaths[editingPath].edges ?? []).length && (
                  <li className="edge-empty">No edges yet</li>
                )}
              </ul>
            </section>
          )}


          <section className="sidebar-section sidebar-hint">
            <p>Scroll to zoom · Drag canvas to pan</p>
            <p>Click to select · drag to move · double-click name to rename</p>
            <p>Del = hide (In Design = FALSE) · Shift+Del = delete from file</p>
          </section>
        </>
      )}

      {/* ── Elements tab ──────────────────────────────────────────────────── */}
      {tab === 'elements' && (
        <>
          <section className="sidebar-section">
            <div className="sidebar-section-header">
              <span>Add Element</span>
              <span style={{ color: 'var(--text-muted)', fontSize: 10, fontWeight: 400 }}>N key at cursor</span>
              <button className="small-btn" onClick={() => {
                const ox = config.origin_x ?? 0, oy = config.origin_y ?? 0
                const cx = ox + config.table_length / 2, cy = oy + config.table_width / 2
                setNewElemType(lastAddedTypeRef?.current || '')
                setNewElemLabel('')
                setNewElemX(Math.round(cx * 2) / 2)
                setNewElemY(Math.round(cy * 2) / 2)
                setAddingElement(p => !p)
              }}>+</button>
            </div>
            {addingElement && (() => {
              const trimmedLabel = newElemLabel.trim()
              const isDupLabel = !!trimmedLabel && (elements ?? []).some(el => el.label === trimmedLabel)
              const canAdd = !!newElemType.trim() && !isDupLabel

              function commitAdd() {
                if (!canAdd) return
                const type = newElemType.trim()
                // Inherit the last-selected element's rotation if it's the same type.
                const inheritOrient = selectedElement
                  && (selectedElement.type ?? '').toLowerCase().trim() === type.toLowerCase()
                  ? (selectedElement.orientation ?? 0)
                  : 0
                onAddElement({ type, label: trimmedLabel || undefined,
                  x: newElemX, y: newElemY, orientation: inheritOrient })
                setAddingElement(false)
              }
              function kd(e) {
                if (e.key === 'Enter') commitAdd()
                if (e.key === 'Escape') setAddingElement(false)
              }
              return (
                <div className="add-group-form" style={{ flexDirection: 'column', gap: 4 }}>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <input className="snap-input" style={{
                        width: 70, flexShrink: 0,
                        borderColor: isDupLabel ? '#e06c75' : undefined,
                      }}
                      placeholder="O-number" value={newElemLabel}
                      onChange={e => setNewElemLabel(e.target.value)} onKeyDown={kd} />
                    <input className="snap-input add-name-input" placeholder="Type (e.g. mirror)"
                      value={newElemType} onChange={e => setNewElemType(e.target.value)} onKeyDown={kd}
                      autoFocus />
                  </div>
                  {isDupLabel && (
                    <span style={{ fontSize: 10, color: '#e06c75' }}>
                      O-number "{trimmedLabel}" is already in use
                    </span>
                  )}
                  <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                    <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                      ({newElemX?.toFixed(1)}, {newElemY?.toFixed(1)})
                    </span>
                    <button className="small-btn" onClick={commitAdd} disabled={!canAdd}>Add</button>
                    <button className="small-btn" onClick={() => setAddingElement(false)}>✕</button>
                  </div>
                </div>
              )
            })()}
          </section>

          <section className="sidebar-section">
            <div className="sidebar-section-header">
              <span>Layers</span>
              <button className="small-btn" onClick={() => { setAddingLayer(p => !p); setNewLayerName('') }}>+</button>
            </div>
            {addingLayer && (
              <div className="add-group-form">
                <input className="snap-input add-name-input" placeholder="Layer name"
                  value={newLayerName} onChange={e => setNewLayerName(e.target.value)}
                  autoFocus
                  onKeyDown={e => {
                    if (e.key === 'Enter') { onAddLayer(newLayerName); setAddingLayer(false); setNewLayerName('') }
                    if (e.key === 'Escape') setAddingLayer(false)
                  }} />
                <button className="small-btn" onClick={() => { onAddLayer(newLayerName); setAddingLayer(false); setNewLayerName('') }}>Add</button>
                <button className="small-btn" onClick={() => setAddingLayer(false)}>✕</button>
              </div>
            )}
            <ul className="layer-list">
              {Object.entries(layers ?? {}).map(([name, visible]) => (
                <li key={name} className={`layer-item ${name === activeLayer ? 'layer-item-active' : ''}`}>
                  <input type="radio" name="activeLayer" checked={name === activeLayer}
                    onChange={() => onSetActiveLayer(name)}
                    title="Set as active layer" />
                  <input type="checkbox" checked={visible !== false}
                    onChange={e => onSetLayerVisible(name, e.target.checked)}
                    title="Toggle visibility" />
                  {renamingLayer === name
                    ? <input className="snap-input layer-rename-input"
                        value={renameLayerVal}
                        autoFocus
                        onChange={e => setRenameLayerVal(e.target.value)}
                        onBlur={() => { onRenameLayer(name, renameLayerVal); setRenamingLayer(null) }}
                        onKeyDown={e => {
                          if (e.key === 'Enter') { onRenameLayer(name, renameLayerVal); setRenamingLayer(null) }
                          if (e.key === 'Escape') setRenamingLayer(null)
                        }} />
                    : <span className="layer-name"
                        onDoubleClick={() => { setRenamingLayer(name); setRenameLayerVal(name) }}>
                        {name}
                      </span>
                  }
                  {Object.keys(layers).length > 1 && (
                    <button className="small-btn layer-del-btn" onClick={() => onDeleteLayer(name)} title="Delete layer">✕</button>
                  )}
                </li>
              ))}
            </ul>
          </section>

          <section className="sidebar-section" style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            {(() => {
              const all = elements ?? []
              const hiddenCount = all.filter(el => el.in_design === false).length
              return (
                <div className="sidebar-section-header">
                  <span>All Elements ({all.length}{hiddenCount > 0 ? `, ${hiddenCount} hidden` : ''})</span>
                </div>
              )
            })()}
            <input className="snap-input" style={{ margin: '2px 0 4px', width: '100%', boxSizing: 'border-box' }}
              placeholder="Filter by label or type…"
              value={elemFilter}
              onChange={e => setElemFilter(e.target.value)} />
            <ul className="elem-list">
              {(elements ?? [])
                .filter(el => {
                  if (!elemFilter.trim()) return true
                  const q = elemFilter.toLowerCase()
                  return el.label.toLowerCase().includes(q) || (el.type || '').toLowerCase().includes(q)
                })
                .map(el => {
                  const isSel = selectedLabels?.has(el.label)
                  const inDesign = el.in_design !== false
                  return (
                    <li key={el.label}
                      className={`elem-item ${isSel ? 'selected' : ''} ${!inDesign ? 'elem-hidden' : ''}`}
                      onClick={e => onSelectElement(el.label, e.shiftKey)}>
                      <input type="checkbox" className="elem-indesign-check"
                        checked={inDesign}
                        onChange={e => onUpdateElement(el.label, 'in_design', e.target.checked)}
                        onClick={e => e.stopPropagation()} />
                      <span className="elem-label">{el.label}</span>
                      <span className="elem-type">{el.type}</span>
                    </li>
                  )
                })}
            </ul>
          </section>

          <section className="sidebar-section sidebar-hint">
            <p>Click to select · Shift+click for multi-select</p>
            <p>P = set properties (e.g. Layer) on all selected</p>
            <p>Del = hide (In Design = FALSE) · Shift+Del = delete from file</p>
          </section>
        </>
      )}

      {/* ── Objects tab ───────────────────────────────────────────────────── */}
      {tab === 'objects' && (
        <>
          <section className="sidebar-section">
            <div className="sidebar-section-header">
              <span>Background Objects</span>
              <div className="toggle-all-btns">
                <button onClick={() => onToggleAllBg(true)}  disabled={allBgOn}  className="small-btn">All</button>
                <button onClick={() => onToggleAllBg(false)} disabled={allBgOff} className="small-btn">None</button>
                <button onClick={() => setAddingBg(p => !p)} className="small-btn">+</button>
              </div>
            </div>

            {addingBg && (
              <div className="add-group-form">
                <input className="snap-input add-name-input" placeholder="Group name"
                  value={newBgName} onChange={e => setNewBgName(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') commitAddBg(); if (e.key === 'Escape') setAddingBg(false) }}
                  autoFocus />
                <ColorSwatch color={newBgColor} onChange={setNewBgColor} size={16} />
                <input className="snap-input" type="number" min="0.5" max="20" step="0.5"
                  value={newBgStroke} onChange={e => setNewBgStroke(parseFloat(e.target.value) || 2)}
                  title="Stroke width" style={{ width: 36 }} />
                <button className="small-btn" onClick={commitAddBg}>Add</button>
                <button className="small-btn" onClick={() => setAddingBg(false)}>✕</button>
              </div>
            )}

            <ul className="path-list">
              {bgNames.map(name => {
                const { color, strokeWidth = 2 } = bgGroups[name]
                const on         = visibleBg?.[name]
                const isEditing  = name === editingBgGroup
                const isRenaming = renamingBg === name
                return (
                  <li key={name} className={`path-item ${on ? 'on' : 'off'} ${isEditing ? 'editing' : ''}`}>
                    <ColorSwatch color={color} onChange={c => onSetBgGroupColor(name, c)} />
                    {isRenaming ? (
                      <input className="snap-input" style={{ flex: 1 }}
                        value={renameBgVal}
                        onChange={e => setRenameBgVal(e.target.value)}
                        onBlur={() => { onRenameBgGroup(name, renameBgVal); setRenamingBg(null) }}
                        onKeyDown={e => {
                          if (e.key === 'Enter') { onRenameBgGroup(name, renameBgVal); setRenamingBg(null) }
                          if (e.key === 'Escape') setRenamingBg(null)
                        }}
                        autoFocus />
                    ) : (
                      <span className="path-name"
                        onClick={() => onToggleBg(name)}
                        onDoubleClick={() => { setRenamingBg(name); setRenameBgVal(name) }}
                        title="Double-click to rename">{name}</span>
                    )}
                    <input className="stroke-input" type="number" min="0.5" max="20" step="0.5"
                      value={strokeWidth}
                      onChange={e => onSetBgGroupStroke(name, parseFloat(e.target.value) || 1)}
                      title="Stroke width" />
                    <button
                      className={`path-edit-btn ${isEditing ? 'active' : ''}`}
                      title={isEditing ? 'Stop editing' : 'Edit edges'}
                      onClick={() => onSetEditingBgGroup(isEditing ? null : name)}
                    >✎</button>
                    <button className="path-delete-btn" title="Delete group"
                      onClick={() => onDeleteBgGroup(name)}>✕</button>
                  </li>
                )
              })}
            </ul>
          </section>

          {/* Bg group edge editor */}
          {editingBgGroup && bgGroups?.[editingBgGroup] && (
            <section className="sidebar-section path-edit-panel">
              <div className="sidebar-section-header">
                <span style={{ color: bgGroups[editingBgGroup].color }}>● {editingBgGroup}</span>
                <button className="small-btn" onClick={() => onSetEditingBgGroup(null)}>Done</button>
              </div>
              <p className="path-edit-hint">Click two points on canvas · click edge to delete · edit coords below</p>
              <ul className="edge-list">
                {(bgGroups[editingBgGroup].edges ?? []).map(([x1, y1, x2, y2], i) => (
                  <li key={i} className="edge-item bg-edge-item">
                    <div className="bg-coord-row">
                      <CoordInput label="x1" val={x1} onChange={v => onUpdateBgEdge(editingBgGroup, i, { x1: v })} />
                      <CoordInput label="y1" val={y1} onChange={v => onUpdateBgEdge(editingBgGroup, i, { y1: v })} />
                      <span className="coord-arrow">→</span>
                      <CoordInput label="x2" val={x2} onChange={v => onUpdateBgEdge(editingBgGroup, i, { x2: v })} />
                      <CoordInput label="y2" val={y2} onChange={v => onUpdateBgEdge(editingBgGroup, i, { y2: v })} />
                    </div>
                    <button className="edge-delete" onClick={() => onDeleteBgEdge(editingBgGroup, i)}>✕</button>
                  </li>
                ))}
                {!(bgGroups[editingBgGroup].edges ?? []).length && (
                  <li className="edge-empty">No edges yet</li>
                )}
              </ul>

              {/* Text labels */}
              <div style={{ marginTop: 8, borderTop: '1px solid var(--border-side)', paddingTop: 6 }}>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>Text labels</div>
                <div style={{ display: 'flex', gap: 4 }}>
                  <input className="snap-input" style={{ flex: 1 }}
                    placeholder="type text, then Place"
                    value={pendingBgLabelText ?? ''}
                    onChange={e => onSetPendingBgLabelText?.(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Escape') onSetPendingBgLabelText?.(null) }} />
                  <button className="small-btn"
                    disabled={!pendingBgLabelText?.trim()}
                    title="Arm placement: next canvas click drops the text">
                    {pendingBgLabelText?.trim() ? '↳ click canvas' : 'Place'}
                  </button>
                </div>
                <ul className="edge-list" style={{ marginTop: 4 }}>
                  {(bgGroups[editingBgGroup].labels ?? []).map((lab, i) => (
                    <li key={i} className="edge-item bg-edge-item">
                      <div className="bg-coord-row">
                        <div className="coord-field" style={{ flex: 1, minWidth: 60 }}>
                          <span className="coord-label">text</span>
                          <input className="coord-input" style={{ width: '100%', textAlign: 'left' }}
                            value={lab.text}
                            onChange={e => onUpdateBgLabel(editingBgGroup, i, { text: e.target.value })} />
                        </div>
                        <CoordInput label="x" val={lab.x} onChange={v => onUpdateBgLabel(editingBgGroup, i, { x: v })} />
                        <CoordInput label="y" val={lab.y} onChange={v => onUpdateBgLabel(editingBgGroup, i, { y: v })} />
                      </div>
                      <button className="edge-delete" onClick={() => onDeleteBgLabel(editingBgGroup, i)}>✕</button>
                    </li>
                  ))}
                </ul>
              </div>
            </section>
          )}

          <section className="sidebar-section sidebar-hint">
            <p>✎ to enter draw mode</p>
            <p>Click two points to draw a line · click line to delete</p>
          </section>

          {/* ── Background images ─────────────────────────────────────────── */}
          <section className="sidebar-section">
            <div className="sidebar-section-header">
              <span>Background Images</span>
              <button className="small-btn" onClick={() => bgImageFileRef.current?.click()}>+</button>
            </div>

            {/* Hidden file picker; onChange reads the file, measures the source
                image's aspect ratio (needed so widthIn controls width and height
                follows the original picture), and hands off to onAddBgImage. */}
            <input ref={bgImageFileRef} type="file" accept="image/*"
              style={{ display: 'none' }}
              onChange={e => {
                const file = e.target.files?.[0]
                if (!file) return
                const reader = new FileReader()
                reader.onload = ev => {
                  const href = ev.target.result
                  const probe = new Image()
                  probe.onload = () => {
                    const aspect = probe.naturalWidth
                      ? probe.naturalHeight / probe.naturalWidth
                      : 1
                    const base = file.name.replace(/\.[^.]+$/, '') || 'image'
                    onAddBgImage(base, href, aspect)
                  }
                  probe.src = href
                }
                reader.readAsDataURL(file)
                e.target.value = ''
              }} />

            {Object.keys(bgImages ?? {}).length === 0 && (
              <p style={{ color: 'var(--text-muted)', fontSize: 11, margin: '4px 0' }}>
                None yet. Click + to add a reference image.
              </p>
            )}

            <ul className="path-list">
              {Object.entries(bgImages ?? {}).map(([name, img]) => (
                <li key={name} className="path-item" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <input type="checkbox" checked={img.visible !== false}
                      onChange={e => onUpdateBgImage(name, { visible: e.target.checked })} />
                    <img src={img.href} alt=""
                      style={{ width: 22, height: 22, objectFit: 'contain',
                               background: 'var(--bg-item)', borderRadius: 2 }} />
                    {renamingBgImg === name ? (
                      <input className="snap-input" style={{ flex: 1 }}
                        value={renameBgImgVal} autoFocus
                        onChange={e => setRenameBgImgVal(e.target.value)}
                        onBlur={() => {
                          onRenameBgImage(name, renameBgImgVal); setRenamingBgImg(null)
                        }}
                        onKeyDown={e => {
                          if (e.key === 'Enter') { onRenameBgImage(name, renameBgImgVal); setRenamingBgImg(null) }
                          if (e.key === 'Escape') setRenamingBgImg(null)
                        }} />
                    ) : (
                      <span style={{ flex: 1, fontSize: 11, cursor: 'pointer' }}
                        onDoubleClick={() => { setRenamingBgImg(name); setRenameBgImgVal(name) }}>
                        {name}
                      </span>
                    )}
                    <button className={`small-btn ${editingBgImage === name ? 'active' : ''}`}
                      title={editingBgImage === name ? 'Done editing' : 'Edit position/size on canvas'}
                      onClick={() => onSetEditingBgImage?.(editingBgImage === name ? null : name)}>
                      {editingBgImage === name ? '✓' : '✎'}
                    </button>
                    <button className="small-btn" onClick={() => onDeleteBgImage(name)}>✕</button>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr auto 1fr',
                                gap: 4, marginTop: 4, alignItems: 'center', fontSize: 10 }}>
                    <span>X</span>
                    <input className="snap-input" type="number" step="0.5"
                      value={Number(img.x).toFixed(2)}
                      onChange={e => onUpdateBgImage(name, { x: parseFloat(e.target.value) || 0 })} />
                    <span>Y</span>
                    <input className="snap-input" type="number" step="0.5"
                      value={Number(img.y).toFixed(2)}
                      onChange={e => onUpdateBgImage(name, { y: parseFloat(e.target.value) || 0 })} />
                    <span>W</span>
                    <input className="snap-input" type="number" step="0.5" min="0.1"
                      value={Number(img.widthIn).toFixed(2)}
                      onChange={e => {
                        const w = parseFloat(e.target.value)
                        if (w > 0) onUpdateBgImage(name, { widthIn: w })
                      }} />
                    <span>α</span>
                    <input type="range" min="0" max="1" step="0.05"
                      value={img.opacity ?? 1}
                      onChange={e => onUpdateBgImage(name, { opacity: parseFloat(e.target.value) })}
                      title={`${Math.round((img.opacity ?? 1) * 100)}%`} />
                    <span>θ</span>
                    <input className="snap-input" type="number" step="15"
                      value={Number(img.rotation ?? 0).toFixed(0)}
                      onChange={e => onUpdateBgImage(name, { rotation: parseFloat(e.target.value) || 0 })}
                      title="Rotation (degrees, clockwise)" />
                  </div>
                  <div style={{ display: 'flex', gap: 4, marginTop: 4, fontSize: 10 }}>
                    <button className={`small-btn ${img.flipX ? 'active' : ''}`}
                      style={{ flex: 1 }}
                      onClick={() => onUpdateBgImage(name, { flipX: !img.flipX })}
                      title="Flip horizontally">Flip ↔</button>
                    <button className={`small-btn ${img.flipY ? 'active' : ''}`}
                      style={{ flex: 1 }}
                      onClick={() => onUpdateBgImage(name, { flipY: !img.flipY })}
                      title="Flip vertically">Flip ↕</button>
                  </div>
                </li>
              ))}
            </ul>
            {Object.keys(bgImages ?? {}).length > 0 && (
              <p style={{ color: 'var(--text-muted)', fontSize: 10, margin: '4px 0 0' }}>
                ✎ to edit on canvas · drag body to move, corner handle to resize
              </p>
            )}
          </section>
        </>
      )}

      {/* ── Settings tab ──────────────────────────────────────────────────── */}
      {tab === 'settings' && (
        <>
          <section className="sidebar-section">
            <div className="sidebar-section-header"><span>Appearance</span></div>
            <label className="setting-toggle">
              <input type="checkbox" checked={settings.darkMode}
                onChange={e => set('darkMode', e.target.checked)} />
              <span>Dark mode</span>
            </label>
            <div className="setting-row" style={{ marginTop: 6 }}>
              <span className="setting-label">UI font size</span>
              <div className="snap-presets">
                {[10, 11, 12, 13, 14, 16].map(v => (
                  <button key={v}
                    className={`snap-btn ${(settings.uiFontSize ?? 12) === v ? 'active' : ''}`}
                    onClick={() => set('uiFontSize', v)}>{v}</button>
                ))}
              </div>
            </div>
          </section>

          <section className="sidebar-section">
            <div className="sidebar-section-header"><span>Canvas Scale (px/in)</span></div>
            <div className="setting-row">
              <span className="setting-label">Scale</span>
              <input className="snap-input" type="number" min="1" max="50" step="1"
                value={settings.scale}
                onChange={e => setNum('scale', e.target.value)} />
            </div>
          </section>

          <section className="sidebar-section">
            <div className="sidebar-section-header"><span>Table Size (in)</span></div>
            {/* Labels reflect the canvas axis each dimension controls; the
                underlying config keys stay `table_length` / `table_width` for
                CSV/JSON round-trip with the existing file format. */}
            <div className="setting-row">
              <span className="setting-label">Width (horiz)</span>
              <input className="snap-input" type="number" min="1" step="1"
                value={config.table_length}
                onChange={e => setConfig('table_length', e.target.value)} />
            </div>
            <div className="setting-row">
              <span className="setting-label">Length (vert)</span>
              <input className="snap-input" type="number" min="1" step="1"
                value={config.table_width}
                onChange={e => setConfig('table_width', e.target.value)} />
            </div>
            <div className="setting-row">
              <span className="setting-label">Origin X</span>
              <input className="snap-input" type="number" step="0.5"
                value={config.origin_x ?? 0}
                onChange={e => setConfig('origin_x', e.target.value)} />
              <span className="setting-unit">in</span>
            </div>
            <div className="setting-row">
              <span className="setting-label">Origin Y</span>
              <input className="snap-input" type="number" step="0.5"
                value={config.origin_y ?? 0}
                onChange={e => setConfig('origin_y', e.target.value)} />
              <span className="setting-unit">in</span>
            </div>
          </section>

          <section className="sidebar-section">
            <div className="sidebar-section-header"><span>Grid</span></div>
            <label className="setting-toggle">
              <input type="checkbox" checked={settings.showGrid !== false}
                onChange={e => set('showGrid', e.target.checked)} />
              <span>Show grid</span>
            </label>
            <label className="setting-toggle">
              <input type="checkbox" checked={settings.showBoundingBox !== false}
                onChange={e => set('showBoundingBox', e.target.checked)} />
              <span>Show table bounding box</span>
            </label>
            <label className="setting-toggle">
              <input type="checkbox" checked={settings.showCoords ?? false}
                onChange={e => set('showCoords', e.target.checked)} />
              <span>Show axis labels</span>
            </label>
            <div className="setting-row" style={{ marginTop: 4 }}>
              <span className="setting-label">Line width</span>
              <input className="snap-input" type="number" min="0.1" max="5" step="0.1"
                value={settings.gridLineWidth}
                onChange={e => setNum('gridLineWidth', e.target.value)} />
            </div>
          </section>

          <section className="sidebar-section">
            <div className="sidebar-section-header"><span>Beam Paths</span></div>
            <div className="setting-row">
              <span className="setting-label">Overlap offset</span>
              <input className="snap-input" type="number" min="0" max="20" step="0.5"
                value={settings.beamSpacing ?? 1}
                onChange={e => setNumZeroOk('beamSpacing', e.target.value)} />
            </div>
            <p style={{ fontSize: 10, color: 'var(--text-muted)', margin: '4px 0 0' }}>
              Perpendicular gap between beams sharing the same two elements. 0 = no offset.
            </p>
            <label className="setting-toggle" style={{ marginTop: 6 }}>
              <input type="checkbox" checked={settings.showBeamArrows ?? false}
                onChange={e => set('showBeamArrows', e.target.checked)} />
              <span>Show direction arrows</span>
            </label>
            <label className="setting-toggle">
              <input type="checkbox" checked={settings.dimNonPathInEditMode ?? false}
                onChange={e => set('dimNonPathInEditMode', e.target.checked)} />
              <span>Dim other elements in edit mode</span>
            </label>
            {settings.showBeamArrows && (
              <div className="setting-row">
                <span className="setting-label">Arrow size</span>
                <input className="snap-input" type="number" min="0.1" max="20" step="0.25"
                  value={settings.beamArrowSize ?? 1}
                  onChange={e => setNum('beamArrowSize', e.target.value)} />
                <span className="setting-unit">×</span>
              </div>
            )}
          </section>

          <section className="sidebar-section">
            <div className="sidebar-section-header"><span>Move Snap</span></div>
            <div className="setting-row">
              <span className="setting-label">Spacing</span>
              <div className="snap-presets">
                {SNAP_PRESETS.map(v => (
                  <button key={v}
                    className={`snap-btn ${settings.snapSpacing === v ? 'active' : ''}`}
                    onClick={() => set('snapSpacing', v)}>
                    {v}
                  </button>
                ))}
              </div>
            </div>
            <div className="setting-row">
              <span className="setting-label">Custom</span>
              <input className="snap-input" type="number" min="0.1" max="10" step="0.25"
                value={settings.snapSpacing}
                onChange={e => setNum('snapSpacing', e.target.value)} />
              <span className="setting-unit">in</span>
            </div>
          </section>

          <section className="sidebar-section">
            <div className="sidebar-section-header"><span>Element Labels</span></div>
            <label className="setting-toggle">
              <input type="checkbox" checked={settings.showONumber}
                onChange={e => set('showONumber', e.target.checked)} />
              <span>Show O-number</span>
            </label>
            <label className="setting-toggle">
              <input type="checkbox" checked={settings.showType}
                onChange={e => set('showType', e.target.checked)} />
              <span>Show type label</span>
            </label>
            <label className="setting-toggle">
              <input type="checkbox" checked={settings.showAnnotation ?? false}
                onChange={e => set('showAnnotation', e.target.checked)} />
              <span>Show annotation</span>
            </label>
          </section>

          <section className="sidebar-section">
            <div className="sidebar-section-header"><span>PDF Export</span></div>
            <div className="setting-row">
              <span className="setting-label">Font size</span>
              <input className="snap-input" type="number" min="1" max="20" step="0.5"
                value={settings.pdfFontSize ?? 4}
                onChange={e => setNum('pdfFontSize', e.target.value)} />
              <span className="setting-unit">pt</span>
            </div>
            <div className="setting-row">
              <span className="setting-label">Label Y offset</span>
              <input className="snap-input" type="number" step="0.5"
                value={settings.pdfLabelYOffset ?? 0}
                onChange={e => { const v = parseFloat(e.target.value); if (!isNaN(v)) set('pdfLabelYOffset', v) }} />
              <span className="setting-unit">px</span>
            </div>
            <p style={{ fontSize: 10, color: 'var(--text-muted)', margin: '4px 0 0' }}>
              Positive = labels pulled down toward icons. Use if PDF labels feel farther from icons than on-canvas.
            </p>
          </section>

          {/* Optics Styles */}
          <section className="sidebar-section">
            <div className="sidebar-section-header">
              <span>Optics Styles</span>
              <button className="small-btn" onClick={() => setAddingSymbol(p => !p)}>+</button>
            </div>

            {addingSymbol && (
              <div className="symbol-add-form">
                <div className="setting-row">
                  <span className="setting-label">Type name</span>
                  <input className="snap-input" style={{ flex: 1 }} placeholder="e.g. aom"
                    value={newSymType} onChange={e => setNewSymType(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') commitAddSymbol(); if (e.key === 'Escape') setAddingSymbol(false) }}
                    autoFocus />
                </div>
                <div className="setting-row">
                  <span className="setting-label">SVG file</span>
                  <SVGPicker value={newSymHref}
                    onChange={(val, meta) => { setNewSymHref(val); if (meta) { setNewSymW(meta.w); setNewSymH(meta.h) } }}
                    customEntries={customEntries} />
                </div>
                <div className="setting-row">
                  <span className="setting-label">Height (px)</span>
                  <input className="snap-input" type="number" min="1" max="60" step="0.5"
                    value={newSymDisplayH} onChange={e => setNewSymDisplayH(parseFloat(e.target.value) || 11)} />
                </div>
                <div className="setting-row" style={{ justifyContent: 'flex-end', gap: 4 }}>
                  <button className="small-btn" onClick={commitAddSymbol}>Add</button>
                  <button className="small-btn" onClick={() => setAddingSymbol(false)}>Cancel</button>
                </div>
              </div>
            )}

            <div className="sym-list">
              {Object.entries(symbolDefs).map(([type, def]) => (
                <SymbolRow key={type} type={type} def={def}
                  editing={editingSymType === type}
                  renaming={renamingSymType === type}
                  renameVal={renameSymVal}
                  onRenameValChange={setRenameSymVal}
                  onStartRename={() => { setRenamingSymType(type); setRenameSymVal(type) }}
                  onCommitRename={() => { onRenameSymbolDef(type, renameSymVal); setRenamingSymType(null) }}
                  onCancelRename={() => setRenamingSymType(null)}
                  onStartEdit={() => setEditingSymType(type)}
                  onStopEdit={() => setEditingSymType(null)}
                  onUpdate={patch => onUpdateSymbolDef(type, patch)}
                  onDelete={() => { onDeleteSymbolDef(type); if (editingSymType === type) setEditingSymType(null) }}
                  customEntries={customEntries}
                />
              ))}
            </div>
          </section>
        </>
      )}
      </div>{/* end sidebar-body */}
      {/* ── Persistent selected-element panel ──────────────────────────────── */}
      {selectedLabels?.size === 1 && selectedElement && (
        <section className="sidebar-section sidebar-selected-panel">
          <div className="sidebar-section-header"><span>Selected — {selectedElement.label}</span></div>
          <div className="element-detail">
            <table className="detail-table">
              <tbody>
                <tr>
                  <td>O-number</td>
                  <td><FieldInput value={selectedElement.label}
                    onChange={v => onRenameElement(selectedElement.label, v)} /></td>
                </tr>
                <tr>
                  <td>Type</td>
                  <td><FieldInput value={selectedElement.type ?? ''} onChange={v => onUpdateElement(selectedElement.label, 'type', v)} /></td>
                </tr>
                <tr>
                  <td>X</td>
                  <td><FieldInput value={selectedElement.x} type="number" onChange={v => onUpdateElement(selectedElement.label, 'x', v)} /></td>
                </tr>
                <tr>
                  <td>Y</td>
                  <td><FieldInput value={selectedElement.y} type="number" onChange={v => onUpdateElement(selectedElement.label, 'y', v)} /></td>
                </tr>
                <tr>
                  <td>Orient</td>
                  <td><FieldInput value={selectedElement.orientation ?? 0} type="number" suffix="°" onChange={v => onUpdateElement(selectedElement.label, 'orientation', v)} /></td>
                </tr>
                <tr>
                  <td>In Design</td>
                  <td>
                    <input type="checkbox"
                      checked={selectedElement.in_design !== false}
                      onChange={e => onUpdateElement(selectedElement.label, 'in_design', e.target.checked)}
                      style={{ accentColor: 'var(--accent-bright)', cursor: 'pointer' }} />
                  </td>
                </tr>
                <tr>
                  <td>Layer</td>
                  <td>
                    <select className="snap-input" style={{ width: '100%', fontSize: 11 }}
                      value={selectedElement.Layer || 'Default'}
                      onChange={e => onUpdateElement(selectedElement.label, 'Layer', e.target.value)}>
                      {Object.keys(layers ?? {}).map(name => (
                        <option key={name} value={name}>{name}</option>
                      ))}
                    </select>
                  </td>
                </tr>
                {(allMetaKeys ?? []).map(k => (
                  <tr key={k}>
                    <td>{k}</td>
                    <td><FieldInput value={selectedElement[k] ?? ''} onChange={v => onUpdateElement(selectedElement.label, k, v)} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      {selectedLabels?.size > 1 && (
        <section className="sidebar-section sidebar-selected-panel">
          <div className="sidebar-section-header"><span>Selected</span></div>
          <div style={{ color: 'var(--text-muted)', fontSize: '0.9em', padding: '2px 0' }}>
            {selectedLabels.size} elements selected
          </div>
        </section>
      )}
    </aside>
  )
}

// ── Generic editable field for element detail panel ───────────────────────────
function FieldInput({ value, onChange, type = 'text', suffix }) {
  const [local, setLocal] = useState(String(value ?? ''))
  const [focused, setFocused] = useState(false)

  const isBool = typeof value === 'boolean'
  const isBoolStr = !isBool && typeof value === 'string' && (value === 'TRUE' || value === 'FALSE')

  if (isBool) {
    return (
      <input type="checkbox" checked={value}
        onChange={e => onChange(e.target.checked)}
        style={{ accentColor: 'var(--accent-bright)', cursor: 'pointer' }} />
    )
  }
  if (isBoolStr) {
    return (
      <input type="checkbox" checked={value === 'TRUE'}
        onChange={e => onChange(e.target.checked ? 'TRUE' : 'FALSE')}
        style={{ accentColor: 'var(--accent-bright)', cursor: 'pointer' }} />
    )
  }

  const display = focused ? local : String(value ?? '')
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
      <input
        className="coord-input"
        style={{ width: type === 'number' ? 52 : '100%', flex: type === 'text' ? 1 : undefined }}
        type={type}
        value={display}
        onChange={e => setLocal(e.target.value)}
        onFocus={() => { setLocal(String(value ?? '')); setFocused(true) }}
        onBlur={() => { setFocused(false); onChange(local) }}
        onKeyDown={e => { if (e.key === 'Enter') e.target.blur() }}
      />
      {suffix && <span style={{ color: 'var(--text-muted)', fontSize: 10 }}>{suffix}</span>}
    </span>
  )
}

// ── Coordinate input for bg edges ─────────────────────────────────────────────
function CoordInput({ label, val, onChange }) {
  const [localVal, setLocalVal] = useState(String(val))
  const [focused, setFocused] = useState(false)
  const display = focused ? localVal : String(val)
  return (
    <div className="coord-field">
      <span className="coord-label">{label}</span>
      <input className="coord-input"
        value={display}
        onChange={e => setLocalVal(e.target.value)}
        onFocus={() => { setLocalVal(String(val)); setFocused(true) }}
        onBlur={() => { setFocused(false); const v = parseFloat(localVal); if (!isNaN(v)) onChange(v) }}
        onKeyDown={e => { if (e.key === 'Enter') { e.target.blur() } }}
      />
    </div>
  )
}

// ── SVG dimension parser ──────────────────────────────────────────────────────
function parseSvgDimensions(svgText) {
  try {
    const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml')
    const svg = doc.documentElement
    const vb = svg.getAttribute('viewBox')
    if (vb) {
      const parts = vb.trim().split(/[\s,]+/)
      if (parts.length >= 4) {
        const w = parseFloat(parts[2]), h = parseFloat(parts[3])
        if (!isNaN(w) && !isNaN(h) && w > 0 && h > 0) return { w, h }
      }
    }
    const w = parseFloat(svg.getAttribute('width'))
    const h = parseFloat(svg.getAttribute('height'))
    if (!isNaN(w) && !isNaN(h) && w > 0 && h > 0) return { w, h }
  } catch {}
  return { w: 24, h: 24 }
}

// ── SVG symbol picker ─────────────────────────────────────────────────────────
function SVGPicker({ value, onChange, customEntries = [] }) {
  const [open, setOpen] = useState(false)
  const [pos, setPos]   = useState({ top: 0, left: 0 })
  const btnRef  = useRef(null)
  const fileRef = useRef(null)

  const isDataUrl = value?.startsWith('data:')
  const previewSrc   = isDataUrl ? value : `/symbols/${value}`
  const displayLabel = isDataUrl ? 'custom' : value

  function openPicker() {
    const rect = btnRef.current.getBoundingClientRect()
    const popW = 256
    const popH = 320
    const top  = rect.bottom + 4 + popH > window.innerHeight ? rect.top - popH - 4 : rect.bottom + 4
    const left = Math.min(rect.left, window.innerWidth - popW - 8)
    setPos({ top, left })
    setOpen(true)
  }

  useEffect(() => {
    if (!open) return
    function onDown(e) {
      if (!e.target.closest('.svg-picker-popover') && !btnRef.current?.contains(e.target))
        setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  function handleUpload(e) {
    const file = e.target.files[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = ev => {
      const svgText = ev.target.result
      const dims = parseSvgDimensions(svgText)
      const b64 = btoa(unescape(encodeURIComponent(svgText)))
      onChange(`data:image/svg+xml;base64,${b64}`, dims)
      setOpen(false)
    }
    reader.readAsText(file)
    e.target.value = ''
  }

  return (
    <div style={{ flex: 1, minWidth: 0 }}>
      <button ref={btnRef} className="sym-select"
        style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer', width: '100%', textAlign: 'left' }}
        onClick={() => open ? setOpen(false) : openPicker()}>
        <img src={previewSrc} className="sym-preview" style={{ width: 16, height: 16, flexShrink: 0 }} alt={displayLabel} />
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{displayLabel}</span>
        <span style={{ color: 'var(--text-muted)', fontSize: '0.75em' }}>▾</span>
      </button>
      {open && (
        <div className="svg-picker-popover" style={{
          position: 'fixed', top: pos.top, left: pos.left, zIndex: 600,
          width: 256, maxHeight: 320, overflowY: 'auto',
          background: 'var(--bg-sidebar)', border: '1px solid var(--border-side)',
          borderRadius: 5, padding: 6, boxShadow: '0 4px 16px #0006',
        }}>
          <div style={{ marginBottom: 6 }}>
            <button className="small-btn" style={{ width: '100%' }}
              onClick={() => fileRef.current.click()}>Upload SVG…</button>
            <input ref={fileRef} type="file" accept=".svg,image/svg+xml" style={{ display: 'none' }}
              onChange={handleUpload} />
          </div>
          {customEntries.length > 0 && (
            <>
              <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 3 }}>Custom</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 4, marginBottom: 6 }}>
                {customEntries.map(({ label, href, w, h }) => (
                  <button key={label} onClick={() => { onChange(href, { w, h }); setOpen(false) }} title={label}
                    style={{
                      background: href === value ? 'var(--accent)' : 'var(--bg-item)',
                      border: `1px solid ${href === value ? 'var(--accent-bright)' : 'transparent'}`,
                      borderRadius: 3, padding: 4, cursor: 'pointer',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}>
                    <img src={href} className="sym-preview" style={{ width: 22, height: 22 }} alt={label} />
                  </button>
                ))}
              </div>
              <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 3 }}>Built-in</div>
            </>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 4 }}>
            {AVAILABLE_SYMBOLS.map(s => (
              <button key={s} onClick={() => { onChange(s, null); setOpen(false) }} title={s}
                style={{
                  background: s === value ? 'var(--accent)' : 'var(--bg-item)',
                  border: `1px solid ${s === value ? 'var(--accent-bright)' : 'transparent'}`,
                  borderRadius: 3, padding: 4, cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                <img src={`/symbols/${s}`} className="sym-preview" style={{ width: 22, height: 22 }} alt={s} />
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Optics style row ──────────────────────────────────────────────────────────
function SymbolRow({ type, def, editing, renaming, renameVal, onRenameValChange,
    onStartRename, onCommitRename, onCancelRename, onStartEdit, onStopEdit, onUpdate, onDelete, customEntries }) {
  return (
    <div className={`sym-row ${editing ? 'editing' : ''}`}>
      <img className="sym-preview" src={def.href} alt={type} />
      {renaming ? (
        <input className="snap-input" style={{ flex: 1, minWidth: 0 }}
          value={renameVal}
          onChange={e => onRenameValChange(e.target.value)}
          onBlur={onCommitRename}
          onKeyDown={e => {
            if (e.key === 'Enter') onCommitRename()
            if (e.key === 'Escape') onCancelRename()
          }}
          autoFocus />
      ) : (
        <span className="sym-type" title="Double-click to rename" onDoubleClick={onStartRename}>{type}</span>
      )}
      <button className={`path-edit-btn ${editing ? 'active' : ''}`}
        onClick={() => editing ? onStopEdit() : onStartEdit()}>✎</button>
      <button className="path-delete-btn" onClick={onDelete}>✕</button>
      {editing && (
        <div className="sym-edit-panel">
          <div className="setting-row">
            <span className="setting-label">SVG file</span>
            <SVGPicker
              value={def.href?.startsWith('data:') ? def.href : def.href?.replace('/symbols/', '') ?? ''}
              onChange={(val, meta) => {
                if (val?.startsWith('data:')) {
                  const patch = { href: val }
                  if (meta) { patch.w = meta.w; patch.h = meta.h }
                  onUpdate(patch)
                } else {
                  onUpdate({ href: `/symbols/${val}` })
                }
              }}
              customEntries={customEntries ?? []}
            />
          </div>
          <div className="setting-row">
            <span className="setting-label">Height (px)</span>
            <input className="snap-input" type="number" min="1" max="60" step="0.5"
              value={def.displayH}
              onChange={e => { const v = parseFloat(e.target.value); if (!isNaN(v) && v > 0) onUpdate({ displayH: v }) }} />
          </div>
          <div className="setting-row">
            <span className="setting-label">Orientation</span>
            <input className="snap-input" type="number" min="-360" max="360" step="45"
              value={def.orientation ?? 0}
              onChange={e => { const v = parseFloat(e.target.value); if (!isNaN(v)) onUpdate({ orientation: v }) }} />
            <span className="setting-unit">°</span>
          </div>
          <div className="setting-row">
            <span className="setting-label">Label clearance</span>
            <input className="snap-input" type="number" step="0.5"
              value={def.labelClearance ?? 6}
              onChange={e => { const v = parseFloat(e.target.value); if (!isNaN(v)) onUpdate({ labelClearance: v }) }} />
            <span className="setting-unit">px</span>
          </div>
        </div>
      )}
    </div>
  )
}
