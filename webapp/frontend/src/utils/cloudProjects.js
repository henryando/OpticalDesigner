import { supabase } from '../supabaseClient'

const TABLE = 'cloud_projects'
const BUCKET = 'project-images'

// ── Background-image extraction / rehydration ───────────────────────────────
// Mirrors the data-URL-extraction pattern used for ZIP export/import
// (App.jsx's saveProject / handleProjectZipFile): the in-memory shape always
// uses data: URLs, and only the persisted form (ZIP file, or here, the DB
// row + Storage bucket) uses an external reference. Cloud-loaded projects are
// therefore indistinguishable from local ones once back in React state.

function extFromMime(mime) {
  const sub = mime.split('/')[1] || 'png'
  return sub === 'jpeg' ? 'jpg' : sub
}

// Uploads any data:image/... hrefs in bgImages to Storage under this
// project's id, replacing them with a "cloud:<path>" reference. Returns a
// new bgImages object; does not mutate the input.
async function extractBgImages(bgImages, projectId) {
  const out = {}
  const usedSlugs = new Set()
  for (const [name, img] of Object.entries(bgImages ?? {})) {
    if (img.href?.startsWith('data:image/')) {
      const mime = img.href.slice(5, img.href.indexOf(';'))
      const ext = extFromMime(mime)
      let slug = name.replace(/[^a-z0-9._-]/gi, '_').toLowerCase()
      if (usedSlugs.has(slug)) {
        let i = 2; while (usedSlugs.has(`${slug}_${i}`)) i++; slug = `${slug}_${i}`
      }
      usedSlugs.add(slug)
      const path = `${projectId}/${slug}.${ext}`
      const blob = await (await fetch(img.href)).blob()
      const { error } = await supabase.storage.from(BUCKET).upload(path, blob, {
        contentType: mime, upsert: true,
      })
      if (error) throw error
      out[name] = { ...img, href: `cloud:${path}` }
    } else {
      out[name] = img
    }
  }
  return out
}

// Downloads any cloud:<path> hrefs in bgImages back into data: URLs. Returns
// a new bgImages object; does not mutate the input.
async function hydrateBgImages(bgImages) {
  const out = {}
  for (const [name, img] of Object.entries(bgImages ?? {})) {
    if (img.href?.startsWith('cloud:')) {
      const path = img.href.slice('cloud:'.length)
      const { data, error } = await supabase.storage.from(BUCKET).download(path)
      if (error) throw error
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(reader.result)
        reader.onerror = reject
        reader.readAsDataURL(data)
      })
      out[name] = { ...img, href: dataUrl }
    } else {
      out[name] = img
    }
  }
  return out
}

// ── Cloud project CRUD ───────────────────────────────────────────────────────

// List every shared cloud project, newest-saved first. Deliberately selects
// only small columns — never the whole `state` — so this stays cheap
// regardless of how large individual projects get. The few content fields
// below are worth the extra bytes: they tell a real designer project apart
// from a row the Beam Propagation app created purely to hold propagations
// (blank elements/paths/objects) — pulling one of those into the designer
// would produce an empty project, so it shouldn't be listed as if it were one.
export async function listCloudProjects() {
  const { data, error } = await supabase
    .from(TABLE)
    .select('id, name, updated_at, updated_by_email, elements:state->elements, beamPaths:state->beamPaths, bgGroups:state->bgGroups, bgImages:state->bgImages')
    .order('updated_at', { ascending: false })
  if (error) throw error
  return data.map(row => ({
    id: row.id, name: row.name, updatedAt: row.updated_at, updatedByEmail: row.updated_by_email,
    hasDesignerContent: (row.elements?.length ?? 0) > 0
      || Object.keys(row.beamPaths ?? {}).length > 0
      || Object.keys(row.bgGroups ?? {}).length > 0
      || Object.keys(row.bgImages ?? {}).length > 0,
  }))
}

// Fetch one project and rehydrate its background images to data: URLs so the
// returned state can be passed straight into applyProjectState().
export async function fetchCloudProject(id) {
  const { data, error } = await supabase
    .from(TABLE)
    .select('id, name, state, updated_at, updated_by_email')
    .eq('id', id)
    .single()
  if (error) throw error
  const bgImages = await hydrateBgImages(data.state?.bgImages)
  return {
    id: data.id,
    name: data.name,
    state: { ...data.state, bgImages },
    updatedAt: data.updated_at,
    updatedByEmail: data.updated_by_email,
  }
}

// Cheap staleness check ahead of an update-save — avoids re-fetching (and
// re-downloading images for) the whole row just to compare a timestamp.
export async function getCloudProjectUpdatedAt(id) {
  const { data, error } = await supabase
    .from(TABLE)
    .select('updated_at, updated_by_email')
    .eq('id', id)
    .single()
  if (error) throw error
  return { updatedAt: data.updated_at, updatedByEmail: data.updated_by_email }
}

export async function insertCloudProject(name, state, user) {
  const id = crypto.randomUUID()
  const bgImages = await extractBgImages(state.bgImages, id)
  const row = {
    id, name: name.trim() || 'Untitled',
    state: { ...state, bgImages },
    created_by: user.id, created_by_email: user.email,
    updated_by: user.id, updated_by_email: user.email,
  }
  const { data, error } = await supabase.from(TABLE).insert(row).select('updated_at').single()
  if (error) throw error
  return { id, name: row.name, updatedAt: data.updated_at }
}

export async function updateCloudProject(id, name, state, user) {
  const bgImages = await extractBgImages(state.bgImages, id)
  const row = {
    name: name.trim() || 'Untitled',
    state: { ...state, bgImages },
    updated_by: user.id, updated_by_email: user.email,
  }
  const { data, error } = await supabase.from(TABLE).update(row).eq('id', id).select('updated_at').single()
  if (error) throw error
  return { id, name: row.name, updatedAt: data.updated_at }
}

export async function deleteCloudProject(id) {
  const { error } = await supabase.from(TABLE).delete().eq('id', id)
  if (error) throw error
}
