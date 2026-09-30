'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Admin sign-in. The backend POST /api/v1/auth/login accepts
 * { email, password, totpCode? } — totpCode is required when the admin has
 * 2FA enabled. If the first attempt fails with a two-factor error, the
 * 6-digit code field is revealed and the same endpoint is retried.
 */
export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [needTotp, setNeedTotp] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          password,
          ...(needTotp && totpCode ? { totpCode } : {}),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        router.push('/');
        router.refresh();
        return;
      }
      const msg =
        typeof data?.message === 'string'
          ? data.message
          : 'Sign-in failed. Check your credentials.';
      if (/two-factor/i.test(msg) && !needTotp) {
        setNeedTotp(true);
        setError('Two-factor authentication required — enter your 6-digit code.');
      } else {
        setError(msg);
      }
    } catch {
      setError('Could not reach the server. Is it running?');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <div className="card login-card">
        <div className="brandline">ZenSkil Hub</div>
        <div className="tagline">Admin panel — sign in to continue</div>
        {error && <div className="alert error">{error}</div>}
        <form onSubmit={submit}>
          <div className="field">
            <label htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          <div className="field">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
          {needTotp && (
            <div className="field">
              <label htmlFor="totp">Two-factor code</label>
              <input
                id="totp"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="6-digit code"
                maxLength={6}
                value={totpCode}
                onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, ''))}
                required
              />
              <div className="hint">From your authenticator app.</div>
            </div>
          )}
          <button className="btn" type="submit" disabled={busy} style={{ width: '100%' }}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  );
}
