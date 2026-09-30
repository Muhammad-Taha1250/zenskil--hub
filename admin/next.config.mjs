const isProd = process.env.NODE_ENV === 'production';

/**
 * Security headers for the admin panel (Phase 10).
 *
 * - Strict-Transport-Security: production only. In dev the panel is served
 *   over plain HTTP on localhost; emitting HSTS there would pin HTTPS for
 *   localhost in the browser and break local development.
 * - X-Frame-Options DENY: the panel is never embedded. DENY (not
 *   SAMEORIGIN) because there is no legitimate framing use case, and DENY
 *   is the strictest option — clickjacking the admin panel must be
 *   impossible, not merely same-origin.
 * - X-Content-Type-Options nosniff: blocks MIME-sniffing drive-bys.
 * - Referrer-Policy same-origin: the admin URL (and any tokens in query
 *   strings) must never leak to third parties via Referer.
 * - Permissions-Policy: the panel needs no camera/mic/geolocation; deny
 *   them all so a compromised dependency can't silently request them.
 */
const securityHeaders = [
  ...(isProd
    ? [
        {
          key: 'Strict-Transport-Security',
          value: 'max-age=63072000; includeSubDomains; preload',
        },
      ]
    : []),
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'same-origin' },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), payment=()',
  },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async headers() {
    return [
      {
        source: '/:path*',
        headers: securityHeaders,
      },
    ];
  },
};
export default nextConfig;
