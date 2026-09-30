'use client';

/**
 * Browser-side helper for calling the backend through the Next.js proxy.
 * The JWT lives in an httpOnly cookie and is attached server-side, so the
 * browser never sees any token.
 *
 * CSRF (Phase 10, double-submit): state-changing requests carry the
 * X-CSRF-Token header. The token is fetched once from GET /api/auth/csrf
 * (which also sets the readable csrf_token cookie the server compares
 * against). On a csrf_mismatch 403 the cached token is discarded, a fresh
 * one is fetched, and the request is retried exactly once.
 */
export interface ApiResult<T = any> {
  ok: boolean;
  status: number;
  data: T;
}

const CSRF_HEADER = 'X-CSRF-Token';
const SAFE_METHODS = new Set(['GET', 'HEAD']);

let csrfToken: string | null = null;

async function fetchCsrfToken(): Promise<string | null> {
  try {
    const res = await fetch('/api/auth/csrf', { credentials: 'same-origin' });
    if (!res.ok) return null;
    const data = await res.json().catch(() => ({}));
    return typeof data?.csrfToken === 'string' ? data.csrfToken : null;
  } catch {
    return null;
  }
}

async function ensureCsrfToken(): Promise<string | null> {
  if (!csrfToken) csrfToken = await fetchCsrfToken();
  return csrfToken;
}

/** Exposed for non-proxy Next routes that also require CSRF (e.g. logout). */
export async function getCsrfToken(): Promise<string | null> {
  return ensureCsrfToken();
}

function isStateChanging(init: RequestInit): boolean {
  const method = (init.method || 'GET').toUpperCase();
  return !SAFE_METHODS.has(method);
}

async function doFetch<T>(path: string, init: RequestInit): Promise<ApiResult<T>> {
  const headers: Record<string, string> = {
    ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    ...((init.headers as Record<string, string>) || {}),
  };
  if (isStateChanging(init)) {
    const token = await ensureCsrfToken();
    if (token && !headers[CSRF_HEADER]) headers[CSRF_HEADER] = token;
  }
  const res = await fetch(`/api/admin-proxy/${path.replace(/^\/+/, '')}`, {
    ...init,
    headers,
  });
  let data: any = null;
  const ct = res.headers.get('content-type') || '';
  try {
    data = ct.includes('application/json') ? await res.json() : await res.text();
  } catch {
    data = null;
  }
  return { ok: res.ok, status: res.status, data };
}

export async function api<T = any>(
  path: string,
  init: RequestInit = {},
): Promise<ApiResult<T>> {
  const first = await doFetch<T>(path, init);
  // Stale cached token (e.g. after logout cleared the cookie): refresh once.
  if (
    !first.ok &&
    first.status === 403 &&
    (first.data as any)?.code === 'csrf_mismatch' &&
    isStateChanging(init)
  ) {
    csrfToken = await fetchCsrfToken();
    return doFetch<T>(path, init);
  }
  return first;
}

/** Extract a human-readable error message from a backend error payload. */
export function errMsg(data: any, fallback = 'Request failed'): string {
  if (!data) return fallback;
  if (typeof data === 'string') return data;
  if (Array.isArray(data.message)) return data.message.join('; ');
  if (typeof data.message === 'string') return data.message;
  if (typeof data.error === 'string') return data.error;
  return fallback;
}
