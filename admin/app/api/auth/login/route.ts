import { NextRequest, NextResponse } from 'next/server';
import { COOKIE_NAME, backendBase } from '@/lib/auth';

/**
 * POST /api/auth/login { email, password, totpCode? }
 *
 * Forwards to the backend POST /api/v1/auth/login. On success the returned
 * accessToken is stored in an httpOnly cookie; the token value is never
 * exposed to browser JS.
 */
export async function POST(req: NextRequest) {
  const { email, password, totpCode } = await req.json().catch(() => ({}));

  let upstream: Response;
  try {
    upstream = await fetch(`${backendBase()}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        password,
        ...(totpCode ? { totpCode } : {}),
      }),
    });
  } catch {
    return NextResponse.json(
      { message: 'Backend unreachable — is the API server running?' },
      { status: 502 },
    );
  }

  const data = await upstream.json().catch(() => ({}));
  if (!upstream.ok || !data?.accessToken) {
    return NextResponse.json(data, { status: upstream.status });
  }

  const res = NextResponse.json({ admin: data.admin });
  res.cookies.set(COOKIE_NAME, data.accessToken, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    // Phase 10: matches the backend JWT absolute lifetime (JWT_EXPIRES_IN,
    // default 8h). A longer-lived cookie would just keep sending an expired
    // token; a shorter one would sign the admin out early. Keep them equal.
    maxAge: 60 * 60 * 8, // 8h session = backend JWT lifetime
    secure: process.env.NODE_ENV === 'production',
  });
  return res;
}
