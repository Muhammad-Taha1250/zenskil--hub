'use client';

import { useEffect, useState } from 'react';
import { api, errMsg } from '@/lib/api-client';
import { PageHead, Loading, Empty, useRole, canWrite } from '@/components/ui';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * Settings + business hours.
 * Backend: GET /api/v1/settings, POST /api/v1/settings { key, value, description? } (OWNER),
 *          GET /api/v1/settings/business-hours,
 *          PATCH /api/v1/settings/business-hours { dayOfWeek, openTime?, closeTime?, isClosed? } (OWNER).
 */
export default function SettingsPage() {
  const role = useRole();
  const canWriteSettings = canWrite(role, ['OWNER']);
  const [settings, setSettings] = useState<any[]>([]);
  const [hours, setHours] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [editKey, setEditKey] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [hoursDraft, setHoursDraft] = useState<Record<number, { openTime: string; closeTime: string; isClosed: boolean }>>({});

  async function load() {
    setLoading(true);
    setError('');
    const [s, h] = await Promise.all([api<any[]>('settings'), api<any[]>('settings/business-hours')]);
    if (s.ok) setSettings(s.data || []);
    else setError(errMsg(s.data, 'Failed to load settings'));
    if (h.ok) {
      const rows = h.data || [];
      setHours(rows);
      const draft: Record<number, any> = {};
      for (const r of rows) {
        draft[r.dayOfWeek] = {
          openTime: r.openTime || '09:00',
          closeTime: r.closeTime || '21:00',
          isClosed: !!r.isClosed,
        };
      }
      setHoursDraft(draft);
    }
    setLoading(false);
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function startEdit(key: string, value: unknown) {
    setEditKey(key);
    setEditValue(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  }

  async function saveSetting() {
    if (!editKey) return;
    let value: unknown = editValue;
    try {
      value = JSON.parse(editValue);
    } catch {
      /* keep as string */
    }
    setBusy(true);
    const r = await api('settings', {
      method: 'POST',
      body: JSON.stringify({ key: editKey, value }),
    });
    setBusy(false);
    if (!r.ok) {
      setError(errMsg(r.data, 'Save failed'));
      return;
    }
    setEditKey(null);
    setNotice(`Setting "${editKey}" updated.`);
    await load();
  }

  async function saveHours(dayOfWeek: number) {
    const d = hoursDraft[dayOfWeek];
    if (!d) return;
    setBusy(true);
    const r = await api('settings/business-hours', {
      method: 'PATCH',
      body: JSON.stringify({
        dayOfWeek,
        openTime: d.isClosed ? null : d.openTime,
        closeTime: d.isClosed ? null : d.closeTime,
        isClosed: d.isClosed,
      }),
    });
    setBusy(false);
    if (!r.ok) setError(errMsg(r.data, 'Business hours update failed'));
    else {
      setNotice(`${DAYS[dayOfWeek]} hours updated.`);
      await load();
    }
  }

  return (
    <>
      <PageHead
        title="Settings"
        sub="System settings (OWNER can edit) and business hours (Asia/Karachi)."
      />
      {error && <div className="alert error">{error}</div>}
      {notice && <div className="alert ok">{notice}</div>}

      {loading ? (
        <Loading />
      ) : (
        <>
          <div className="card" style={{ marginBottom: 14 }}>
            <h2>Business hours</h2>
            {hours.length === 0 ? (
              <Empty text="No business hours configured." />
            ) : (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr><th>Day</th><th>Open</th><th>Close</th><th>Closed</th>{canWriteSettings && <th></th>}</tr>
                  </thead>
                  <tbody>
                    {hours.map((h) => {
                      const d = hoursDraft[h.dayOfWeek];
                      return (
                        <tr key={h.dayOfWeek}>
                          <td><strong>{DAYS[h.dayOfWeek]}</strong></td>
                          <td>
                            {canWriteSettings && d ? (
                              <input
                                type="text"
                                value={d.openTime}
                                disabled={d.isClosed}
                                onChange={(e) =>
                                  setHoursDraft({ ...hoursDraft, [h.dayOfWeek]: { ...d, openTime: e.target.value } })
                                }
                                style={{ width: 80 }}
                                placeholder="HH:MM"
                              />
                            ) : (
                              h.openTime || '—'
                            )}
                          </td>
                          <td>
                            {canWriteSettings && d ? (
                              <input
                                type="text"
                                value={d.closeTime}
                                disabled={d.isClosed}
                                onChange={(e) =>
                                  setHoursDraft({ ...hoursDraft, [h.dayOfWeek]: { ...d, closeTime: e.target.value } })
                                }
                                style={{ width: 80 }}
                                placeholder="HH:MM"
                              />
                            ) : (
                              h.closeTime || '—'
                            )}
                          </td>
                          <td>
                            {canWriteSettings && d ? (
                              <input
                                type="checkbox"
                                checked={d.isClosed}
                                onChange={(e) =>
                                  setHoursDraft({ ...hoursDraft, [h.dayOfWeek]: { ...d, isClosed: e.target.checked } })
                                }
                              />
                            ) : (
                              h.isClosed ? 'Yes' : 'No'
                            )}
                          </td>
                          {canWriteSettings && (
                            <td>
                              <button className="btn secondary small" disabled={busy} onClick={() => saveHours(h.dayOfWeek)}>
                                Save
                              </button>
                            </td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="card">
            <h2>System settings</h2>
            {!canWriteSettings && (
              <div className="alert info">Editing settings requires the OWNER role.</div>
            )}
            {settings.length === 0 ? (
              <Empty text="No settings." />
            ) : (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr><th>Key</th><th>Value</th><th>Description</th>{canWriteSettings && <th></th>}</tr>
                  </thead>
                  <tbody>
                    {settings.map((s) => (
                      <tr key={s.key}>
                        <td className="mono"><strong>{s.key}</strong></td>
                        <td style={{ maxWidth: 320 }}>
                          {editKey === s.key ? (
                            <textarea
                              value={editValue}
                              onChange={(e) => setEditValue(e.target.value)}
                              style={{ minHeight: 90, fontFamily: 'monospace', fontSize: 12 }}
                            />
                          ) : (
                            <pre className="mono" style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                              {typeof s.value === 'string' ? s.value : JSON.stringify(s.value, null, 1)?.slice(0, 300)}
                            </pre>
                          )}
                        </td>
                        <td style={{ fontSize: 12, color: '#66727f' }}>{s.description || '—'}</td>
                        {canWriteSettings && (
                          <td style={{ whiteSpace: 'nowrap' }}>
                            {editKey === s.key ? (
                              <>
                                <button className="btn small" disabled={busy} onClick={saveSetting}>
                                  Save
                                </button>{' '}
                                <button className="btn secondary small" onClick={() => setEditKey(null)}>
                                  Cancel
                                </button>
                              </>
                            ) : (
                              <button className="btn secondary small" onClick={() => startEdit(s.key, s.value)}>
                                Edit
                              </button>
                            )}
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </>
  );
}
