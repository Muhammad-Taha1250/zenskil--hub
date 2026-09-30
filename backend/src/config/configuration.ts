// Typed application configuration. All secrets come from the environment;
// nothing sensitive is hard-coded. See /../.env.example at the repo root.

export interface JwtConfig {
  secret: string;
  expiresIn: string;
}

export interface CorsConfig {
  origins: string[];
}

export interface ThrottleConfig {
  ttlMs: number;
  limit: number;
}

export interface WhatsAppConfig {
  /** Filesystem dir for Baileys multi-file auth state (default './baileys_auth'). Must persist across restarts or the QR must be re-scanned on every boot. */
  authDir: string;
  /** Max outbound messages per customer per rolling hour (anti-spam, T14). */
  maxPerCustomerPerHour: number;
}

export interface AiConfig {
  provider: string; // e.g. "openai" | "anthropic" | "none"
  apiKey?: string;
  model?: string;
  embeddingModel?: string;
}

export interface BackupConfig {
  /** age recipients for backup encryption (comma-separated BACKUP_AGE_RECIPIENTS); empty => plaintext with loud warning. */
  ageRecipients: string[];
}

export interface BusinessConfig {
  /** Hours after confirmation before an unpaid order may be auto-cancelled. */
  paymentWindowHours: number;
  /** Abandoned-order reminder thresholds (hours after order confirmation). */
  abandonedReminder1Hours: number;
  abandonedReminder2Hours: number;
  /** Days before expiry to send renewal reminders. */
  renewalReminderDays: number[];
  /** Days after expiry before a subscription is marked EXPIRED. */
  expiryGraceDays: number;
  /** Days before expiry a subscription becomes EXPIRING_SOON. */
  expiringSoonDays: number;
  /** Default ticket auto-close after resolution (days). */
  ticketAutoCloseDays: number;
}

export interface AppConfig {
  nodeEnv: 'development' | 'staging' | 'production';
  port: number;
  apiPrefix: string;
  databaseUrl: string;
  jwt: JwtConfig;
  cors: CorsConfig;
  throttle: ThrottleConfig;
  whatsapp: WhatsAppConfig;
  ai: AiConfig;
  business: BusinessConfig;
  backup: BackupConfig;
  logLevel: string;
}

function csv(value: string | undefined, fallback: string[]): string[] {
  if (!value) return fallback;
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function num(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`Invalid numeric env value: ${value}`);
  return n;
}

export default (): AppConfig => ({
  nodeEnv: (process.env.NODE_ENV as AppConfig['nodeEnv']) || 'development',
  port: num(process.env.PORT, 3000),
  apiPrefix: process.env.API_PREFIX || 'api/v1',
  databaseUrl: process.env.DATABASE_URL || '',
  jwt: {
    secret: process.env.JWT_SECRET || '',
    expiresIn: process.env.JWT_EXPIRES_IN || '8h',
  },
  cors: {
    origins: csv(process.env.CORS_ORIGINS, ['http://localhost:3001']),
  },
  throttle: {
    ttlMs: num(process.env.RATE_LIMIT_TTL_MS, 60_000),
    limit: num(process.env.RATE_LIMIT_MAX, 120),
  },
  whatsapp: {
    authDir: process.env.BAILEYS_AUTH_DIR || './baileys_auth',
    maxPerCustomerPerHour: num(process.env.WHATSAPP_MAX_PER_CUSTOMER_PER_HOUR, 30),
  },
  ai: {
    provider: process.env.AI_PROVIDER || 'none',
    apiKey: process.env.AI_API_KEY || undefined,
    model: process.env.AI_MODEL || undefined,
    embeddingModel: process.env.AI_EMBEDDING_MODEL || undefined,
  },
  business: {
    paymentWindowHours: num(process.env.PAYMENT_WINDOW_HOURS, 72),
    abandonedReminder1Hours: num(process.env.ABANDONED_REMINDER_1_HOURS, 2),
    abandonedReminder2Hours: num(process.env.ABANDONED_REMINDER_2_HOURS, 24),
    renewalReminderDays: csv(process.env.RENEWAL_REMINDER_DAYS, ['7', '3', '1']).map(Number),
    expiryGraceDays: num(process.env.EXPIRY_GRACE_DAYS, 3),
    expiringSoonDays: num(process.env.EXPIRING_SOON_DAYS, 7),
    ticketAutoCloseDays: num(process.env.TICKET_AUTO_CLOSE_DAYS, 7),
  },
  backup: {
    ageRecipients: csv(process.env.BACKUP_AGE_RECIPIENTS, []),
  },
  logLevel: process.env.LOG_LEVEL || 'info',
});
