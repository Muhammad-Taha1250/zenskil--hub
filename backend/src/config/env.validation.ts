// Fail-fast environment validation. Called by ConfigModule before the app
// boots. Production refuses to start without DATABASE_URL and a strong
// JWT_SECRET; development warns instead of crashing on the secret.

export function validateEnv(config: Record<string, unknown>): Record<string, unknown> {
  const nodeEnv = (config.NODE_ENV as string) || 'development';
  const isProd = nodeEnv === 'production';

  const databaseUrl = config.DATABASE_URL as string | undefined;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required (see .env.example at the repo root).');
  }

  const jwtSecret = config.JWT_SECRET as string | undefined;
  if (isProd) {
    if (!jwtSecret || jwtSecret.length < 32) {
      throw new Error('JWT_SECRET must be set and at least 32 characters in production.');
    }
  } else if (!jwtSecret) {
    // eslint-disable-next-line no-console
    console.warn('[config] JWT_SECRET is not set — using an insecure dev default. Do not use in production.');
    config.JWT_SECRET = 'dev-only-insecure-secret-change-me-000000';
  }

  const port = Number(config.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT must be a valid port number, got: ${config.PORT}`);
  }

  return config;
}
