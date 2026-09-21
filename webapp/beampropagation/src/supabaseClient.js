import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

// Cloud features (login, shared projects) are entirely optional — when the
// env vars aren't set (local clone without Supabase configured, or a build
// that omitted them), every caller feature-detects on this being null and
// the app falls back to local-only behavior with no errors.
export const supabase = (url && anonKey) ? createClient(url, anonKey) : null
