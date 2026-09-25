// Two-way merge of a local project state with a remote (cloud) one, used by
// the Projects tab when a cloud-linked project is "out of sync" (both sides
// changed since the last sync) and the user picks Merge instead of just
// keeping one side wholesale.

// Deep-equal via JSON — good enough for the plain data blobs we merge.
function jsonEq(a, b) { try { return JSON.stringify(a) === JSON.stringify(b) } catch { return false } }

// For each keyed collection: adds items that only one side has; on a real
// conflict (same key, different content) records an error and keeps the
// local value. Settings / config / symbolDefs are taken from local (the
// user's current working state) — they're rarely worth conflict-resolving.
// Returns { state, errors: string[] }. Callers should surface errors and let
// the user re-choose if the merge wasn't clean.
export function mergeCloudState(local, remote) {
  const errors = []
  function mergeDict(name, l, r, formatKey = k => k) {
    const out = { ...(r ?? {}) }
    for (const [k, lv] of Object.entries(l ?? {})) {
      if (!(k in out)) { out[k] = lv; continue }
      if (!jsonEq(lv, out[k])) {
        errors.push(`${name} "${formatKey(k)}" was edited on both sides`)
      }
      out[k] = lv     // prefer local on conflict; error is surfaced above
    }
    return out
  }
  // Elements is an array; key by label for the merge, then flatten back.
  const lEls = {}, rEls = {}
  ;(local.elements ?? []).forEach(el => { lEls[el.label] = el })
  ;(remote.elements ?? []).forEach(el => { rEls[el.label] = el })
  const merged = { ...rEls }
  for (const [k, lv] of Object.entries(lEls)) {
    if (!(k in merged)) { merged[k] = lv; continue }
    if (!jsonEq(lv, merged[k])) errors.push(`Element "${k}" was edited on both sides`)
    merged[k] = lv
  }
  return {
    state: {
      elements:      Object.values(merged),
      overrides:     { ...(remote.overrides ?? {}), ...(local.overrides ?? {}) },
      beamPaths:     mergeDict('Beam path',         local.beamPaths,     remote.beamPaths),
      bgGroups:      mergeDict('Background group',  local.bgGroups,      remote.bgGroups),
      bgImages:      mergeDict('Background image',  local.bgImages,      remote.bgImages),
      visiblePaths:  { ...(remote.visiblePaths ?? {}), ...(local.visiblePaths ?? {}) },
      visibleBg:     { ...(remote.visibleBg ?? {}),    ...(local.visibleBg ?? {}) },
      // Take local for these — merging settings / configuration rarely helps.
      settings:    local.settings,
      config:      local.config,
      symbolDefs:  local.symbolDefs,
      sidebarWidth: local.sidebarWidth,
      layers:      local.layers,
      activeLayer: local.activeLayer,
    },
    errors,
  }
}
