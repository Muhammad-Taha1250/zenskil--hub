'use client';

import { useEffect, useState } from 'react';
import { api, errMsg } from '@/lib/api-client';
import { PageHead, Loading } from '@/components/ui';

/**
 * My account — TOTP 2FA enrolment.
 * Backend: POST /api/v1/auth/totp/setup -> { secret, otpauthUrl },
 *          POST /api/v1/auth/totp/enable { secret, code },
 *          POST /api/v1/auth/totp/disable { password, code }.
 */
export default function AccountPage() {
  const [admin, setAdmin] = useState<any>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [setup, setSetup] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  async function load() {
    // Backend GET /api/v1/auth/me returns the full admin record (incl. totpEnabled).
    const r = await api<{ admin: any }>('auth/me');
    if (r.ok) setAdmin(r.data.admin);
  }

  useEffect(() => {
    load();
  }, []);

  async function beginSetup() {
    setError('');
    setBusy(true);
    const r = await api<{ secret: string; otpauthUrl: string }>('auth/totp/setup', { method: 'POST' });
    setBusy(false);
    if (!r.ok) setError(errMsg(r.data, 'Setup failed'));
    else {
      setSetup(r.data);
      setNotice('Scan the secret into your authenticator app, then confirm with a code.');
    }
  }

  async function enable() {
    if (!setup || !/^\d{6}$/.test(code)) {
      setError('Enter the 6-digit code from your authenticator app.');
      return;
    }
    setBusy(true);
    const r = await api('auth/totp/enable', {
      method: 'POST',
      body: JSON.stringify({ secret: setup.secret, code }),
    });
    setBusy(false);
    if (!r.ok) setError(errMsg(r.data, 'Enable failed — check the code and retry'));
    else {
      setSetup(null);
      setCode('');
      setNotice('Two-factor authentication is now ENABLED for your account.');
      await load();
    }
  }

  async function disable() {
    if (!password || !/^\d{6}$/.test(code)) {
      setError('Password and a 6-digit code are required to disable 2FA.');
      return;
    }
    setBusy(true);
    const r = await api('auth/totp/disable', {
      method: 'POST',
      body: JSON.stringify({ password, code }),
    });
    setBusy(false);
    if (!r.ok) setError(errMsg(r.data, 'Disable failed'));
    else {
      setPassword('');
      setCode('');
      setNotice('Two-factor authentication is now DISABLED for your account.');
      await load();
    }
  }

  return (
    <>
      <PageHead title="My account" sub="Your admin profile and two-factor authentication." />
      {error && <div className="alert error">{error}</div>}
      {notice && <div className="alert ok">{notice}</div>}
      {!admin ? (
        <Loading />
      ) : (
        <div className="grid cols-2">
          <div className="card">
            <h2>Profile</h2>
            <dl className="kv">
              <dt>Email</dt>
              <dd>{admin.email}</dd>
              <dt>Role</dt>
              <dd>{admin.role}</dd>
              <dt>2FA enabled</dt>
              <dd>{admin.totpEnabled ? 'Yes' : 'No'}</dd>
            </dl>
          </div>
          <div className="card">
            <h2>Two-factor authentication</h2>
            {!setup ? (
              <>
                <p style={{ color: '#66727f' }}>
                  {admin.totpEnabled
                    ? '2FA is enabled. To disable it you need your password plus a current code.'
                    : '2FA is not enabled. Enrol now to protect this account.'}
                </p>
                {!admin.totpEnabled ? (
                  <button className="btn" disabled={busy} onClick={beginSetup}>
                    {busy ? 'Starting…' : 'Start 2FA enrolment'}
                  </button>
                ) : (
                  <>
                    <div className="field">
                      <label>Password</label>
                      <input
                        type="password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        autoComplete="current-password"
                      />
                    </div>
                    <div className="field">
                      <label>Current 6-digit code</label>
                      <input
                        type="text"
                        inputMode="numeric"
                        maxLength={6}
                        value={code}
                        onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                      />
                    </div>
                    <button className="btn danger" disabled={busy} onClick={disable}>
                      {busy ? 'Working…' : 'Disable 2FA'}
                    </button>
                  </>
                )}
              </>
            ) : (
              <>
                <div className="field">
                  <label>Secret — enter manually in your authenticator app</label>
                  <pre className="dump">{setup.secret}</pre>
                </div>
                <div className="field">
                  <label>otpauth URL</label>
                  <pre className="dump" style={{ wordBreak: 'break-all', whiteSpace: 'pre-wrap' }}>
                    {setup.otpauthUrl}
                  </pre>
                </div>
                <div className="field">
                  <label>Confirm with a 6-digit code</label>
                  <input
                    type="text"
                    inputMode="numeric"
                    maxLength={6}
                    value={code}
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                  />
                </div>
                <div className="btn-row">
                  <button className="btn" disabled={busy} onClick={enable}>
                    {busy ? 'Verifying…' : 'Enable 2FA'}
                  </button>
                  <button className="btn secondary" onClick={() => setSetup(null)}>
                    Cancel
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
