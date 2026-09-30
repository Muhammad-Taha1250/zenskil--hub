import { NextRequest, NextResponse } from 'next/server';
import { COOKIE_NAME, getSession } from '@/lib/auth';
import { CSRF_COOKIE, verifyCsrfRequest } from '@/lib/csrf';

/**
 * Clears the admin session cookie. CSRF-protected (logout CSRF would let an
 * attacker sign the victim out — a nuisance, but cheap to prevent).
 */
export async function POST(req: NextRequest) {
  if (!verifyCsrfRequest(req)) {
    return NextResponse.json(
      { message: 'CSRF validation failed', code: 'csrf_mismatch' },
      { status: 403 },
    );
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set(COOKIE_NAME, '', {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
  // The CSRF token is not a session, but rotate it anyway so a token
  // captured from a previous session can never be replayed.
  res.cookies.set(CSRF_COOKIE, '', { path: '/', maxAge: 0 });
  return res;
}

/** Returns the signed-in admin's claims decoded from the session JWT. */
export async function GET() {
  const session = getSession();
  if (!session) {
    return NextResponse.json({ message: 'Not signed in' }, { status: 401 });
  }
  return NextResponse.json({ admin: session.admin });
}
