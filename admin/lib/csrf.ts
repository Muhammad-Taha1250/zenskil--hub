import { randomBytes, timingSafeEqual } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';

/**
 * Double-submit CSRF for the admin panel (Phase 10).
 *
 * The admin session lives in an httpOnly cookie, so every state-changing
 * request through /api/admin-proxy (and the session-clear route) must also
 * carry a CSRF token issued by GET /api/auth/csrf:
 *   - the token is set as a READABLE (non-httpOnly) `csrf_token` cookie and
 *     returned in the response body;
 *   - the browser echoes it back in the `X-CSRF-Token` header;
 *   - the server rejects (403, no backend call) unless header == cookie.
 *
 * Why this works: a cross-site attacker can make the browser SEND cookies
 * but cannot READ them (same-origin policy), so they cannot learn the token
 * value to put in the header. Combined with SameSite=lax on the session
 * cookie (top-level GET navigations only; POSTs never carry it cross-site),
 * forged state changes are blocked. See /tmp/csrf-note.md for the
 * justification of double-submit vs. synchronizer tokens.
 */
export const CSRF_COOKIE = 'csrf_token';
export const CSRF_HEADER = 'x-csrf-token';

export function issueCsrfToken(): string {
  return randomBytes(32).toString('base64url');
}

export function setCsrfCookie(res: NextResponse, token: string): void {
  res.cookies.set(CSRF_COOKIE, token, {
    httpOnly: false, // intentionally readable: the client echoes it in a header
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 8, // matches the 8h backend JWT lifetime
    secure: process.env.NODE_ENV === 'production',
  });
}

/** Constant-time comparison of the submitted header against the cookie. */
export function verifyCsrfRequest(req: NextRequest): boolean {
  const cookie = req.cookies.get(CSRF_COOKIE)?.value;
  const header = req.headers.get(CSRF_HEADER);
  if (!cookie || !header) return false;
  const a = Buffer.from(cookie);
  const b = Buffer.from(header);
  return a.length === b.length && timingSafeEqual(a, b);
}
