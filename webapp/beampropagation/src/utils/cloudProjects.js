// Cloud storage shares the Optical Table Designer's Supabase backend: the same
// accounts, the same cloud_projects table, the same owner-scoped RLS. A row's
// `state` is the designer's whole project; this app only ever reads it and
// replaces its `propagations` / `activePropagation`, so it never disturbs the
// elements, beam paths, settings or images stored alongside.
import { supabase } from '../supabaseClient'
import { DEFAULT_SYMBOL_DEFS } from './symbols'
import { propagationsToFileShape } from './propagationModel'

const TABLE = 'cloud_projects'

// A project with nothing in it but propagations. The designer's
// applyProjectState leaves any key that is missing untouched, so a row without
// these would inherit whichever project was open when it was loaded.
function blankDesignerState() {
  return {
    elements: [], overrides: {}, beamPaths: {}, bgGroups: {},
    visiblePaths: {}, visibleBg: {}, bgImages: {},
    config: { table_length: 21, table_width: 34, origin_x: 0, origin_y: 0 },
    symbolDefs: { ...DEFAULT_SYMBOL_DEFS },
    layers: { Default: true }, activeLayer: 'Default',
  }
}

const propagationFields = (propagations, activePropagation) => ({
  propagations: propagationsToFileShape(propagations),
  activePropagation: activePropagation ?? null,
})

// Small columns only — never the whole `state` — so listing stays cheap
// however large individual projects get. `propagations` is the one part of
// `state` worth the extra bytes: this app only cares about rows that
// actually have some (a designer project nobody has ever added a
// propagation to has nothing for this app to pull, and shouldn't clutter
// its Cloud Storage as if it did).
export async function listCloudProjects() {
  const { data, error } = await supabase
    .from(TABLE)
    .select('id, name, updated_at, updated_by_email, propagations:state->propagations')
    .order('updated_at', { ascending: false })
  if (error) throw error
  return data.map(row => ({
    id: row.id, name: row.name, updatedAt: row.updated_at, updatedByEmail: row.updated_by_email,
    hasPropagations: Object.keys(row.propagations ?? {}).length > 0,
  }))
}

// The raw designer state. Background images stay as "cloud:<path>" references —
// nothing here displays them, and they must be written back unchanged.
export async function fetchCloudProject(id) {
  const { data, error } = await supabase
    .from(TABLE)
    .select('id, name, state, updated_at, updated_by_email')
    .eq('id', id)
    .single()
  if (error) throw error
  return {
    id: data.id, name: data.name, state: data.state,
    updatedAt: data.updated_at, updatedByEmail: data.updated_by_email,
  }
}

export async function insertCloudProject(name, propagations, activePropagation, user) {
  const id = crypto.randomUUID()
  const row = {
    id, name: name.trim() || 'Untitled',
    state: { ...blankDesignerState(), ...propagationFields(propagations, activePropagation) },
    created_by: user.id, created_by_email: user.email,
    updated_by: user.id, updated_by_email: user.email,
  }
  const { data, error } = await supabase.from(TABLE).insert(row).select('updated_at').single()
  if (error) throw error
  return { id, name: row.name, updatedAt: data.updated_at }
}

// `latestState` is the row's current state, fetched just before saving, so
// changes made in the designer since this project was opened are kept.
export async function updateCloudProjectPropagations(id, name, latestState, propagations, activePropagation, user) {
  const row = {
    name,
    state: { ...latestState, ...propagationFields(propagations, activePropagation) },
    updated_by: user.id, updated_by_email: user.email,
  }
  const { data, error } = await supabase.from(TABLE).update(row).eq('id', id).select('updated_at').single()
  if (error) throw error
  return { id, name, updatedAt: data.updated_at }
}

export async function deleteCloudProject(id) {
  const { error } = await supabase.from(TABLE).delete().eq('id', id)
  if (error) throw error
}
