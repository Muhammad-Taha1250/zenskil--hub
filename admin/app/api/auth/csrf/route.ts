import { NextResponse } from 'next/server';
import { issueCsrfToken, setCsrfCookie } from '@/lib/csrf';

/**
 * GET /api/auth/csrf
 *
 * Issues a fresh double-submit CSRF token: sets it as the readable
 * `csrf_token` cookie and returns it in the body. The browser-side
 * api-client (lib/api-client.ts) fetches this once and echoes the token in
 * the X-CSRF-Token header on every state-changing request.
 */
export async function GET() {
  const token = issueCsrfToken();
  const res = NextResponse.json({ csrfToken: token });
  setCsrfCookie(res, token);
  return res;
}
