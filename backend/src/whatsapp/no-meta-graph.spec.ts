// Build-enforced guard: the Meta Cloud API integration is fully removed.
// Fails the build if any Meta Graph endpoint or Meta-only configuration
// creeps back into runtime source, tests, workflow docs, or env templates.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Roots scanned relative to the repo root (this spec file excluded).
const BACKEND = resolve(__dirname, '..', '..');
const ROOTS: Array<{ dir: string; ext: RegExp }> = [
  { dir: join(BACKEND, 'src'), ext: /\.(ts|js)$/ }, // runtime source
  { dir: join(BACKEND, 'tests'), ext: /\.ts$/ }, // e2e suites
  { dir: BACKEND, ext: /^\.env\.example$/ }, // backend env template
  { dir: resolve(BACKEND, '..', 'workflows'), ext: /\.(md|json)$/ }, // n8n docs
  { dir: resolve(BACKEND, '..'), ext: /^\.env\.example$/ }, // root env template
];
const FORBIDDEN: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /graph\.facebook\.com/, label: 'Meta Graph API URL' },
  { pattern: /WHATSAPP_ACCESS_TOKEN/, label: 'Meta access token env var' },
  { pattern: /WHATSAPP_PHONE_NUMBER_ID/, label: 'Meta phone number id env var' },
  { pattern: /WHATSAPP_APP_SECRET/, label: 'Meta app secret env var' },
  { pattern: /WHATSAPP_VERIFY_TOKEN/, label: 'Meta verify token env var' },
  { pattern: /WHATSAPP_BUSINESS_ACCOUNT_ID/, label: 'Meta business account id env var' },
  { pattern: /WHATSAPP_API_VERSION/, label: 'Meta API version env var' },
  { pattern: /MetaCloudClient/, label: 'Meta cloud client class' },
  { pattern: /normalizePayload|normalizeStatuses/, label: 'Meta payload normalizer' },
  { pattern: /DO NOT SEND UNTIL APPROVED BY META/, label: 'obsolete Meta approval instruction' },
];

function* walk(dir: string, ext: RegExp): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules') continue;
      yield* walk(full, ext);
    } else if (ext.test(entry) && !entry.endsWith('.spec.ts')) {
      yield full;
    }
  }
}

describe('no-meta-graph (static cleanup guard)', () => {
  it('contains no Meta Graph API URLs or Meta-only config anywhere current', () => {
    const violations: string[] = [];
    for (const { dir, ext } of ROOTS) {
      for (const file of walk(dir, ext)) {
        const content = readFileSync(file, 'utf8');
        for (const { pattern, label } of FORBIDDEN) {
          if (pattern.test(content)) violations.push(`${file}: ${label}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
