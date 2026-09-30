'use client';

import { useEffect, useState } from 'react';
import { api, errMsg } from '@/lib/api-client';
import { formatDateTime } from '@/lib/format';
import { PageHead, Badge, Loading, Empty, useRole, canWrite } from '@/components/ui';

/**
 * Coupons.
 * Backend: GET /api/v1/coupons, POST /api/v1/coupons
 * { code, type: 'PERCENT'|'FIXED', value, maxUses?, validFrom?, validTo? },
 * PATCH /api/v1/coupons/:id/active { isActive }. Writes: OWNER/FINANCE.
 */
export default function CouponsPage() {
  const role = useRole();
  const canEdit = canWrite(role, ['OWNER', 'FINANCE']);
  const [coupons, setCoupons] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [showNew, setShowNew] = useState(false);
  const [code, setCode] = useState('');
  const [type, setType] = useState<'PERCENT' | 'FIXED'>('PERCENT');
  const [value, setValue] = useState('');
  const [maxUses, setMaxUses] = useState('');
  const [validFrom, setValidFrom] = useState('');
  const [validTo, setValidTo] = useState('');
  const [busy, setBusy] = useState(false);

  async function load() {
    setLoading(true);
    setError('');
    const r = await api<any[]>('coupons');
    if (r.ok) setCoupons(r.data || []);
    else setError(errMsg(r.data, 'Failed to load coupons'));
    setLoading(false);
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function create() {
    if (!code.trim() || !value) {
      setError('Code and value are required.');
      return;
    }
    setBusy(true);
    const body: Record<string, unknown> = {
      code: code.trim().toUpperCase(),
      type,
      value: Number(value),
    };
    if (maxUses) body.maxUses = Number(maxUses);
    if (validFrom) body.validFrom = new Date(validFrom).toISOString();
    if (validTo) body.validTo = new Date(validTo).toISOString();
    const r = await api('coupons', { method: 'POST', body: JSON.stringify(body) });
    setBusy(false);
    if (!r.ok) {
      setError(errMsg(r.data, 'Create failed'));
      return;
    }
    setShowNew(false);
    setCode('');
    setValue('');
    setMaxUses('');
    setValidFrom('');
    setValidTo('');
    setNotice('Coupon created.');
    await load();
  }

  async function setActive(id: string, isActive: boolean) {
    const r = await api(`coupons/${id}/active`, {
      method: 'PATCH',
      body: JSON.stringify({ isActive }),
    });
    if (!r.ok) setError(errMsg(r.data, 'Update failed'));
    else {
      setNotice(isActive ? 'Coupon activated.' : 'Coupon deactivated.');
      await load();
    }
  }

  return (
    <>
      <PageHead
        title="Coupons"
        sub="Discount codes. PERCENT value = %; FIXED value = paisa."
        actions={canEdit && <button className="btn" onClick={() => setShowNew(!showNew)}>+ New coupon</button>}
      />
      {error && <div className="alert error">{error}</div>}
      {notice && <div className="alert ok">{notice}</div>}

      {showNew && canEdit && (
        <div className="card" style={{ marginBottom: 14 }}>
          <h2>New coupon</h2>
          <div className="form-row">
            <div className="field">
              <label>Code</label>
              <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="WELCOME10" className="mono" />
            </div>
            <div className="field">
              <label>Type</label>
              <select value={type} onChange={(e) => setType(e.target.value as any)}>
                <option value="PERCENT">PERCENT (%)</option>
                <option value="FIXED">FIXED (paisa)</option>
              </select>
            </div>
          </div>
          <div className="form-row">
            <div className="field">
              <label>Value</label>
              <input type="number" min={1} value={value} onChange={(e) => setValue(e.target.value)} />
              <div className="hint">{type === 'PERCENT' ? 'e.g. 10 = 10% off' : 'e.g. 83000 = PKR 830.00 off'}</div>
            </div>
            <div className="field">
              <label>Max uses (optional)</label>
              <input type="number" min={1} value={maxUses} onChange={(e) => setMaxUses(e.target.value)} />
            </div>
          </div>
          <div className="form-row">
            <div className="field">
              <label>Valid from (optional)</label>
              <input type="datetime-local" value={validFrom} onChange={(e) => setValidFrom(e.target.value)} />
            </div>
            <div className="field">
              <label>Valid to (optional)</label>
              <input type="datetime-local" value={validTo} onChange={(e) => setValidTo(e.target.value)} />
            </div>
          </div>
          <div className="btn-row">
            <button className="btn" disabled={busy} onClick={create}>{busy ? 'Creating…' : 'Create'}</button>
            <button className="btn secondary" onClick={() => setShowNew(false)}>Cancel</button>
          </div>
        </div>
      )}

      <div className="card">
        {loading ? <Loading /> : coupons.length === 0 ? <Empty text="No coupons." /> : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr><th>Code</th><th>Type</th><th>Value</th><th>Uses</th><th>Valid</th><th>Status</th>{canEdit && <th></th>}</tr>
              </thead>
              <tbody>
                {coupons.map((c) => (
                  <tr key={c.id}>
                    <td className="mono"><strong>{c.code}</strong></td>
                    <td>{c.type}</td>
                    <td>{c.type === 'PERCENT' ? `${c.value}%` : `PKR ${(c.value / 100).toFixed(2)}`}</td>
                    <td>{c.usedCount ?? 0}{c.maxUses ? ` / ${c.maxUses}` : ''}</td>
                    <td style={{ fontSize: 12 }}>
                      {c.validFrom ? formatDateTime(c.validFrom) : '—'} → {c.validTo ? formatDateTime(c.validTo) : '—'}
                    </td>
                    <td><Badge value={c.isActive ? 'ACTIVE' : 'DRAFT'} /></td>
                    {canEdit && (
                      <td>
                        <button
                          className="btn secondary small"
                          onClick={() => setActive(c.id, !c.isActive)}
                        >
                          {c.isActive ? 'Deactivate' : 'Activate'}
                        </button>
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
  );
}
