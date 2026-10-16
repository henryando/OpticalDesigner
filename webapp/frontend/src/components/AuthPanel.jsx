import { useState } from 'react'
import { supabase } from '../supabaseClient'

// Simple email/password login/signup form for the optional shared-cloud
// feature. Reuses the app's existing modal/input/button CSS classes so it
// looks native alongside the local-project prompts in App.jsx. Pass `inline`
// to render just the form (no backdrop/title) for embedding directly in a
// page, e.g. at the top of the Projects tab's Cloud Storage list.
//
// Modes:
//   'signin' | 'signup'   — the two normal entry points.
//   'forgot'              — collect an email, send a password-reset mail.
//   'reset'               — set a new password after the user clicked the
//                           reset link. Opened automatically from the
//                           Projects tab when Supabase emits a
//                           PASSWORD_RECOVERY auth event.
export default function AuthPanel({ onClose, inline = false, initialMode = 'signin' }) {
  const [mode, setMode]         = useState(initialMode)
  const [email, setEmail]       = useState('')
  const [password, setPassword] = useState('')
  const [error, setError]       = useState(null)
  const [notice, setNotice]     = useState(null)
  const [busy, setBusy]         = useState(false)

  async function submit(e) {
    e.preventDefault()
    setError(null); setNotice(null)
    const trimmedEmail = email.trim()
    setBusy(true)
    try {
      if (mode === 'signin') {
        if (!trimmedEmail || !password) { setError('Enter an email and password.'); return }
        const { error: err } = await supabase.auth.signInWithPassword({ email: trimmedEmail, password })
        if (err) throw err
        onClose()
      } else if (mode === 'signup') {
        if (!trimmedEmail || !password) { setError('Enter an email and password.'); return }
        // Pin the confirmation-email redirect to the origin the user signed
        // up from so the link in their inbox lands back on this deployment
        // (not whatever "Site URL" the Supabase project happens to default
        // to). The exact origin must also be listed in the Supabase project's
        // Authentication → URL Configuration → Redirect URLs allow-list.
        const { data, error: err } = await supabase.auth.signUp({
          email: trimmedEmail,
          password,
          options: { emailRedirectTo: window.location.origin },
        })
        if (err) throw err
        if (data.session) onClose()
        else setNotice('Check your email to confirm the account, then log in.')
      } else if (mode === 'forgot') {
        if (!trimmedEmail) { setError('Enter the email on your account.'); return }
        // Supabase emits a PASSWORD_RECOVERY auth event when the user lands
        // back on the app via the link in this email; ProjectsTab listens
        // for it and reopens the panel in 'reset' mode so the user can set
        // a new password without having to navigate anywhere.
        const { error: err } = await supabase.auth.resetPasswordForEmail(trimmedEmail, {
          redirectTo: window.location.origin,
        })
        if (err) throw err
        setNotice('If an account with that email exists, a reset link has been sent. Click the link in the email to set a new password.')
      } else if (mode === 'reset') {
        if (!password) { setError('Enter a new password.'); return }
        if (password.length < 6) { setError('Password must be at least 6 characters.'); return }
        const { error: err } = await supabase.auth.updateUser({ password })
        if (err) throw err
        setNotice('Password updated. You are now signed in.')
        // Short delay so the user can read the confirmation before the modal closes.
        setTimeout(() => onClose(), 1200)
      }
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  function switchMode(next) {
    setMode(next); setError(null); setNotice(null); setPassword('')
  }

  const titles = {
    signin: 'Log in',
    signup: 'Sign up',
    forgot: 'Reset password',
    reset:  'Choose a new password',
  }
  const submitLabels = {
    signin: 'Log in',
    signup: 'Sign up',
    forgot: 'Send reset email',
    reset:  'Set new password',
  }

  const form = (
    <>
      {!inline && <div className="modal-title">{titles[mode]}</div>}
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 8, width: inline ? '100%' : 260 }}>
        {mode !== 'reset' && (
          <input className="snap-input" style={{ width: '100%', boxSizing: 'border-box' }}
            type="email" placeholder="Email" autoFocus={!inline}
            value={email} onChange={e => setEmail(e.target.value)} autoComplete="email" />
        )}
        {(mode === 'signin' || mode === 'signup' || mode === 'reset') && (
          <input className="snap-input" style={{ width: '100%', boxSizing: 'border-box' }}
            type="password"
            placeholder={mode === 'reset' ? 'New password' : 'Password'}
            autoFocus={mode === 'reset'}
            value={password} onChange={e => setPassword(e.target.value)}
            autoComplete={mode === 'signin' ? 'current-password' : 'new-password'} />
        )}
        {error  && <div style={{ fontSize: 12, color: '#ff6b6b' }}>{error}</div>}
        {notice && <div style={{ fontSize: 12, color: 'var(--text)' }}>{notice}</div>}
        <div style={{ display: 'flex', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
          <button type="submit" className="small-btn" disabled={busy}>
            {busy ? 'Working…' : submitLabels[mode]}
          </button>
          {mode === 'signin' && (
            <button type="button" className="small-btn" disabled={busy}
              onClick={() => switchMode('forgot')}>Forgot password?</button>
          )}
          {!inline && <button type="button" className="small-btn" onClick={onClose}>Cancel</button>}
        </div>
      </form>
      {/* Mode-switch links, matched to the current mode. */}
      {mode === 'signin' && (
        <button type="button" className="small-btn" style={{ marginTop: 10, width: '100%' }}
          onClick={() => switchMode('signup')}>Need an account? Sign up</button>
      )}
      {mode === 'signup' && (
        <button type="button" className="small-btn" style={{ marginTop: 10, width: '100%' }}
          onClick={() => switchMode('signin')}>Have an account? Log in</button>
      )}
      {mode === 'forgot' && (
        <button type="button" className="small-btn" style={{ marginTop: 10, width: '100%' }}
          onClick={() => switchMode('signin')}>Back to log in</button>
      )}
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
