'use client';

import { useEffect, useState } from 'react';
import { api, errMsg } from '@/lib/api-client';
import { formatPkr } from '@/lib/format';
import { PageHead, Badge, Loading, Empty, useRole, canWrite } from '@/components/ui';

interface Plan {
  id: string;
  name: string;
  durationMonths: number;
  durationDays: number;
  pricePaisa: number;
  isActive: boolean;
}
interface Product {
  id: string;
  slug: string;
  name: string;
  category: string;
  shortDescription?: string | null;
  longDescription?: string | null;
  fulfillmentNotes?: string | null;
  isActive: boolean;
  plans: Plan[];
}

const WRITE_ROLES = ['OWNER', 'FINANCE'];

/**
 * Catalog CRUD — products, plans, prices.
 * Backend: GET/POST /api/v1/catalog/products, PATCH /api/v1/catalog/products/:id,
 *          POST /api/v1/catalog/plans, PATCH /api/v1/catalog/plans/:id.
 * Writes are OWNER/FINANCE only. Changing a plan's price creates a
 * PRICE_CHANGE approval instead of applying immediately (backend rule).
 */
export default function CatalogPage() {
  const role = useRole();
  const canEdit = canWrite(role, WRITE_ROLES);
  const [products, setProducts] = useState<Product[]>([]);
  const [showInactive, setShowInactive] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [editing, setEditing] = useState<Product | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [planFor, setPlanFor] = useState<Product | null>(null);
  const [editingPlan, setEditingPlan] = useState<{ product: Product; plan: Plan } | null>(null);

  async function load(inactive: boolean) {
    setLoading(true);
    setError('');
    const r = await api<Product[]>(`catalog/products?activeOnly=${inactive ? 'false' : 'true'}`);
    if (r.ok) setProducts(r.data || []);
    else setError(errMsg(r.data, 'Failed to load catalog'));
    setLoading(false);
  }

  useEffect(() => {
    load(showInactive);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function saveProduct(p: Product, body: Record<string, unknown>) {
    const r = await api(`catalog/products/${p.id}`, { method: 'PATCH', body: JSON.stringify(body) });
    if (!r.ok) return errMsg(r.data, 'Save failed');
    setEditing(null);
    setNotice('Product updated.');
    await load(showInactive);
    return '';
  }

  async function createProduct(body: Record<string, unknown>) {
    const r = await api('catalog/products', { method: 'POST', body: JSON.stringify(body) });
    if (!r.ok) return errMsg(r.data, 'Create failed');
    setShowNew(false);
    setNotice('Product created.');
    await load(showInactive);
    return '';
  }

  async function savePlan(productId: string, planId: string | null, body: Record<string, unknown>) {
    const r = planId
      ? await api(`catalog/plans/${planId}`, { method: 'PATCH', body: JSON.stringify(body) })
      : await api('catalog/plans', { method: 'POST', body: JSON.stringify({ productId, ...body }) });
    if (!r.ok) return errMsg(r.data, 'Save failed');
    setEditingPlan(null);
    setPlanFor(null);
    setNotice(
      planId && body.pricePaisa !== undefined
        ? 'Price change submitted as a PRICE_CHANGE approval (needs a second admin).'
        : 'Plan saved.',
    );
    await load(showInactive);
    return '';
  }

  return (
    <>
      <PageHead
        title="Catalog"
        sub="Products, plans and prices. Price changes require a second admin's approval."
        actions={
          <>
            <label style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }}>
              <input
                type="checkbox"
                checked={showInactive}
                onChange={(e) => {
                  setShowInactive(e.target.checked);
                  load(e.target.checked);
                }}
              />
              Show inactive
            </label>
            {canEdit && (
              <button className="btn" onClick={() => setShowNew(true)}>
                + New product
              </button>
            )}
          </>
        }
      />
      {error && <div className="alert error">{error}</div>}
      {notice && <div className="alert ok">{notice}</div>}
      {loading ? (
        <Loading />
      ) : products.length === 0 ? (
        <Empty text="No products found." />
      ) : (
        <div className="grid" style={{ gap: 14 }}>
          {products.map((p) => (
            <div className="card" key={p.id}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h2 style={{ margin: 0 }}>
                  {p.name} <span className="mono" style={{ color: '#66727f' }}>/{p.slug}</span>
                </h2>
                <div className="btn-row" style={{ marginTop: 0 }}>
                  <Badge value={p.isActive ? 'ACTIVE' : 'DRAFT'} />
                  {canEdit && (
                    <button className="btn secondary small" onClick={() => setEditing(p)}>
                      Edit
                    </button>
                  )}
                </div>
              </div>
              <p style={{ color: '#66727f', margin: '6px 0' }}>
                {p.category}
                {p.shortDescription ? ` — ${p.shortDescription}` : ''}
              </p>
              {p.fulfillmentNotes && (
                <div className="alert info" style={{ margin: '8px 0' }}>
                  <strong>Fulfillment notes:</strong> {p.fulfillmentNotes}
                </div>
              )}
              <h3>Plans</h3>
              <table className="data">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Duration</th>
                    <th>Price</th>
                    <th>Status</th>
                    {canEdit && <th></th>}
                  </tr>
                </thead>
                <tbody>
                  {(p.plans || []).map((pl) => (
                    <tr key={pl.id}>
                      <td>{pl.name}</td>
                      <td>
                        {pl.durationMonths} mo ({pl.durationDays} days)
                      </td>
                      <td>{formatPkr(pl.pricePaisa)}</td>
                      <td>
                        <Badge value={pl.isActive ? 'ACTIVE' : 'DRAFT'} />
                      </td>
                      {canEdit && (
                        <td>
                          <button
                            className="btn secondary small"
                            onClick={() => setEditingPlan({ product: p, plan: pl })}
                          >
                            Edit
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
              {canEdit && (
                <div className="btn-row">
                  <button className="btn secondary small" onClick={() => setPlanFor(p)}>
                    + Add plan
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {editing && (
        <ProductForm
          title="Edit product"
          initial={editing}
          onClose={() => setEditing(null)}
          onSave={(b) => saveProduct(editing, b)}
        />
      )}
      {showNew && (
        <ProductForm
          title="New product"
          initial={null}
          onClose={() => setShowNew(false)}
          onSave={createProduct}
        />
      )}
      {(planFor || editingPlan) && (
        <PlanForm
          product={editingPlan ? editingPlan.product : planFor!}
          initial={editingPlan ? editingPlan.plan : null}
          onClose={() => {
            setPlanFor(null);
            setEditingPlan(null);
          }}
          onSave={(b) =>
            savePlan(
              editingPlan ? editingPlan.product.id : planFor!.id,
              editingPlan ? editingPlan.plan.id : null,
              b,
            )
          }
        />
      )}
    </>
  );
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div
      style={{
        position: 'fixed', inset: 0, background: 'rgba(15,23,34,.5)',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        padding: '40px 16px', zIndex: 50, overflowY: 'auto',
      }}
      onClick={onClose}
    >
      <div className="card" style={{ width: 560, maxWidth: '100%' }} onClick={(e) => e.stopPropagation()}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

function ProductForm({
  title, initial, onClose, onSave,
}: {
  title: string;
  initial: Product | null;
  onClose: () => void;
  onSave: (b: Record<string, unknown>) => Promise<string>;
}) {
  const [slug, setSlug] = useState(initial?.slug ?? '');
  const [name, setName] = useState(initial?.name ?? '');
  const [category, setCategory] = useState(initial?.category ?? '');
  const [shortDescription, setShort] = useState(initial?.shortDescription ?? '');
  const [longDescription, setLong] = useState(initial?.longDescription ?? '');
  const [fulfillmentNotes, setNotes] = useState(initial?.fulfillmentNotes ?? '');
  const [isActive, setIsActive] = useState(initial?.isActive ?? true);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr('');
    const body: Record<string, unknown> = { name, category };
    if (shortDescription) body.shortDescription = shortDescription;
    if (longDescription) body.longDescription = longDescription;
    if (fulfillmentNotes) body.fulfillmentNotes = fulfillmentNotes;
    if (initial) body.isActive = isActive;
    else {
      body.slug = slug;
      body.category = category;
    }
    const msg = await onSave(body);
    setBusy(false);
    if (msg) setErr(msg);
  }

  return (
    <Modal title={title} onClose={onClose}>
      {err && <div className="alert error">{err}</div>}
      <form onSubmit={submit}>
        {!initial && (
          <div className="field">
            <label>Slug (unique, URL-safe)</label>
            <input value={slug} onChange={(e) => setSlug(e.target.value)} required />
          </div>
        )}
        <div className="form-row">
          <div className="field">
            <label>Name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} required />
          </div>
          <div className="field">
            <label>Category</label>
            <input value={category} onChange={(e) => setCategory(e.target.value)} required />
          </div>
        </div>
        <div className="field">
          <label>Short description</label>
          <input value={shortDescription} onChange={(e) => setShort(e.target.value)} />
        </div>
        <div className="field">
          <label>Long description</label>
          <textarea value={longDescription} onChange={(e) => setLong(e.target.value)} />
        </div>
        <div className="field">
          <label>Fulfillment notes</label>
          <textarea
            value={fulfillmentNotes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="What the customer receives — shown in the fulfillment task queue"
          />
          <div className="hint">This is the H-5 mechanism: staff see these notes on every fulfillment task.</div>
        </div>
        {initial && (
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
            <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
            Active
          </label>
        )}
        <div className="btn-row">
          <button className="btn" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
          <button className="btn secondary" type="button" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}

function PlanForm({
  product, initial, onClose, onSave,
}: {
  product: Product;
  initial: Plan | null;
  onClose: () => void;
  onSave: (b: Record<string, unknown>) => Promise<string>;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [durationMonths, setMonths] = useState(String(initial?.durationMonths ?? 1));
  const [durationDays, setDays] = useState(String(initial?.durationDays ?? 30));
  const [pricePkr, setPricePkr] = useState(
    initial ? String(initial.pricePaisa / 100) : '',
  );
  const [isActive, setIsActive] = useState(initial?.isActive ?? true);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr('');
    const body: Record<string, unknown> = {
      name,
      durationMonths: Number(durationMonths),
      durationDays: Number(durationDays),
      pricePaisa: Math.round(Number(pricePkr) * 100),
    };
    if (initial) body.isActive = isActive;
    const msg = await onSave(body);
    setBusy(false);
    if (msg) setErr(msg);
  }

  return (
    <Modal title={`${initial ? 'Edit' : 'New'} plan — ${product.name}`} onClose={onClose}>
      {err && <div className="alert error">{err}</div>}
      {initial && (
        <div className="alert warn">
          Changing the price does <strong>not</strong> apply immediately — it creates a
          PRICE_CHANGE approval that a different admin must decide.
        </div>
      )}
      <form onSubmit={submit}>
        <div className="field">
          <label>Plan name</label>
          <input value={name} onChange={(e) => setName(e.target.value)} required />
        </div>
        <div className="form-row">
          <div className="field">
            <label>Duration (months)</label>
            <input type="number" min={1} value={durationMonths} onChange={(e) => setMonths(e.target.value)} required />
          </div>
          <div className="field">
            <label>Duration (days)</label>
            <input type="number" min={1} value={durationDays} onChange={(e) => setDays(e.target.value)} required />
          </div>
        </div>
        <div className="field">
          <label>Price (PKR)</label>
          <input
            type="number" min={0.01} step="0.01" value={pricePkr}
            onChange={(e) => setPricePkr(e.target.value)} required
          />
        </div>
        {initial && (
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
            <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
            Active
          </label>
        )}
        <div className="btn-row">
          <button className="btn" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
          <button className="btn secondary" type="button" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}
