import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { COOKIE_NAME, backendBase } from '@/lib/auth';
import { verifyCsrfRequest } from '@/lib/csrf';

/**
 * Thin proxy: /api/admin-proxy/<path>?query -> <backend>/api/v1/<path>?query
 *
 * The admin JWT is read from the httpOnly session cookie and forwarded as
 * `Authorization: Bearer <jwt>`. Browser JS never sees the token, and tokens
 * are never logged. Backend is the RBAC authority: 401/403 from upstream
 * are passed straight through.
 *
 * CSRF (Phase 10): state-changing methods require the double-submit token
 * (X-CSRF-Token header == csrf_token cookie). Mismatches are rejected with
 * 403 here — the backend is never called.
 *
 * Binary responses (e.g. payment proof downloads) are streamed through with
 * their content-type preserved.
 */
async function forward(
  req: NextRequest,
  path: string[],
): Promise<NextResponse> {
  if (req.method !== 'GET' && req.method !== 'HEAD' && !verifyCsrfRequest(req)) {
    return NextResponse.json(
      { message: 'CSRF validation failed', code: 'csrf_mismatch' },
      { status: 403 },
    );
  }

  const token = cookies().get(COOKIE_NAME)?.value;
  if (!token) {
    return NextResponse.json({ message: 'Not signed in' }, { status: 401 });
  }

  const target =
    `${backendBase()}/api/v1/${path.map(encodeURIComponent).join('/')}` +
    (req.nextUrl.search || '');

  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  const contentType = req.headers.get('content-type');
  if (contentType) headers['content-type'] = contentType;

  const init: RequestInit = { method: req.method, headers };
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const buf = await req.arrayBuffer();
    if (buf.byteLength > 0) init.body = Buffer.from(buf);
  }

  let upstream: Response;
  try {
    upstream = await fetch(target, init);
  } catch {
    return NextResponse.json(
      { message: 'Backend unreachable — is the API server running?' },
      { status: 502 },
    );
  }

  const body = await upstream.arrayBuffer();
  const out = new NextResponse(body, { status: upstream.status });
  const outCt = upstream.headers.get('content-type');
  if (outCt) out.headers.set('content-type', outCt);
  return out;
}

type Ctx = { params: { path: string[] } };

export async function GET(req: NextRequest, ctx: Ctx) {
  return forward(req, ctx.params.path);
}
export async function POST(req: NextRequest, ctx: Ctx) {
  return forward(req, ctx.params.path);
}
export async function PATCH(req: NextRequest, ctx: Ctx) {
  return forward(req, ctx.params.path);
}
export async function PUT(req: NextRequest, ctx: Ctx) {
  return forward(req, ctx.params.path);
}
export async function DELETE(req: NextRequest, ctx: Ctx) {
  return forward(req, ctx.params.path);
}
