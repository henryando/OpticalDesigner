import { useState } from 'react'
import { supabase } from '../supabaseClient'

// Simple email/password login/signup form for the optional shared-cloud
// feature. Reuses the app's existing modal/input/button CSS classes so it
// looks native alongside the local-project prompts in App.jsx. Pass `inline`
// to render just the form (no backdrop/title) for embedding directly in a
// page, e.g. at the top of the Projects tab's Cloud Storage list.
export default function AuthPanel({ onClose, inline = false }) {
  const [mode, setMode]         = useState('signin') // 'signin' | 'signup'
  const [email, setEmail]       = useState('')
  const [password, setPassword] = useState('')
  const [error, setError]       = useState(null)
  const [notice, setNotice]     = useState(null)
  const [busy, setBusy]         = useState(false)

  async function submit(e) {
    e.preventDefault()
    setError(null); setNotice(null)
    const trimmedEmail = email.trim()
    if (!trimmedEmail || !password) { setError('Enter an email and password.'); return }
    setBusy(true)
    try {
      if (mode === 'signin') {
        const { error: err } = await supabase.auth.signInWithPassword({ email: trimmedEmail, password })
        if (err) throw err
        onClose()
      } else {
        const { data, error: err } = await supabase.auth.signUp({ email: trimmedEmail, password })
        if (err) throw err
        if (data.session) onClose()
        else setNotice('Check your email to confirm the account, then log in.')
      }
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const form = (
    <>
      {!inline && <div className="modal-title">{mode === 'signin' ? 'Log in' : 'Sign up'}</div>}
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 8, width: inline ? '100%' : 260 }}>
        <input className="snap-input" style={{ width: '100%', boxSizing: 'border-box' }}
          type="email" placeholder="Email" autoFocus={!inline}
          value={email} onChange={e => setEmail(e.target.value)} autoComplete="email" />
        <input className="snap-input" style={{ width: '100%', boxSizing: 'border-box' }}
          type="password" placeholder="Password"
          value={password} onChange={e => setPassword(e.target.value)}
          autoComplete={mode === 'signin' ? 'current-password' : 'new-password'} />
        {error  && <div style={{ fontSize: 12, color: '#ff6b6b' }}>{error}</div>}
        {notice && <div style={{ fontSize: 12, color: 'var(--text)' }}>{notice}</div>}
        <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
          <button type="submit" className="small-btn" disabled={busy}>
            {busy ? 'Working…' : mode === 'signin' ? 'Log in' : 'Sign up'}
          </button>
          {!inline && <button type="button" className="small-btn" onClick={onClose}>Cancel</button>}
        </div>
      </form>
      <button type="button" className="small-btn" style={{ marginTop: 10, width: '100%' }}
        onClick={() => { setMode(m => m === 'signin' ? 'signup' : 'signin'); setError(null); setNotice(null) }}>
        {mode === 'signin' ? 'Need an account? Sign up' : 'Have an account? Log in'}
      </button>
    </>
  )

  if (inline) return form

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-box" onClick={e => e.stopPropagation()}>
        {form}
      </div>
    </div>
  )
}
