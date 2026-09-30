import { cookies } from 'next/headers';

export const COOKIE_NAME =
  process.env.ZENSKILL_ADMIN_COOKIE || 'zenskill_admin_token';

export interface SessionAdmin {
  id: string;
  email: string;
  role: string;
}

export interface Session {
  token: string;
  admin: SessionAdmin;
}

/**
 * Reads the admin JWT from the httpOnly session cookie and decodes its
 * payload (base64url, no signature verification). The backend is the RBAC
 * authority; this is only used to personalize the UI / hide nav items.
 */
export function getSession(): Session | null {
  const token = cookies().get(COOKIE_NAME)?.value;
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1], 'base64url').toString('utf8'),
    );
    if (!payload?.sub || !payload?.role) return null;
    return {
      token,
      admin: {
        id: String(payload.sub),
        email: String(payload.email ?? ''),
        role: String(payload.role),
      },
    };
  } catch {
    return null;
  }
}

export function backendBase(): string {
  return (process.env.ZENSKILL_API_BASE_URL || 'http://localhost:3000').replace(
    /\/+$/,
    '',
  );
}
