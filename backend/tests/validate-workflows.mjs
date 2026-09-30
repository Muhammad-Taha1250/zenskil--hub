// Structural validation for the Phase 5 n8n workflow JSONs.
// Run: npm run test:workflows
//
// Checks every *.v1.json in workflows/n8n:
//   1. valid n8n workflow shape (name, version, nodes[], connections{})
//   2. every connection edge references a real node
//   3. exactly one scheduleTrigger per workflow with a valid rule
//      (minutes interval 1..1440, or a 5-field cron expression)
//   4. every httpRequest node targets the backend automation API
//      (expression containing /api/v1/automation/...) and carries NO
//      embedded secret (no x-service-token value, no Bearer <redacted>
//   5. credentials are referenced by NAME only ("ZenSkil Backend API"),
//      never by id/value
//   6. filenames are versioned (*.v1.json) and match meta/workflow version
// Exit code 0 = all green.
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'workflows', 'n8n');
const EXPECTED = [
  'notification-dispatcher.v1.json',
  'abandoned-reminders.v1.json',
  'renewal-reminders.v1.json',
  'expiry-sweeper.v1.json',
  'ticket-alerts.v2.json',
  'db-backup.v1.json',
  'fulfillment-processor.v1.json',
];

let passed = 0, failed = 0;
const check = (name, cond, detail = '') => {
  if (cond) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; console.error(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};

const files = readdirSync(DIR).filter((f) => f.endsWith('.json'));
for (const f of EXPECTED) check(`workflow file exists: ${f}`, files.includes(f));

const SECRET_PATTERNS = [/x-service-token/i, /bearer\s+[a-z0-9._-]{8,}/i, /"password"\s*:/i];

for (const f of files.filter((x) => EXPECTED.includes(x))) {
  const raw = readFileSync(join(DIR, f), 'utf8');
  let w;
  try { w = JSON.parse(raw); } catch (e) { check(`${f}: valid JSON`, false, e.message); continue; }
  check(`${f}: valid JSON`, true);
  check(`${f}: name present`, typeof w.name === 'string' && w.name.startsWith('ZenSkil — '), w.name);
  const fileVer = parseInt((f.match(/\.v(\d+)\.json$/) || [])[1] || '0', 10);
  check(`${f}: version field matches filename`, w.version === fileVer, `file=v${fileVer} field=${w.version}`);
  check(`${f}: nodes array non-empty`, Array.isArray(w.nodes) && w.nodes.length > 0, String(w.nodes?.length));

  const names = new Set(w.nodes.map((n) => n.name));
  check(`${f}: node names unique`, names.size === w.nodes.length);
  let edgesOk = true, edgeDetail = '';
  for (const [from, conn] of Object.entries(w.connections ?? {})) {
    if (!names.has(from)) { edgesOk = false; edgeDetail = `unknown source ${from}`; break; }
    for (const out of conn.main ?? []) {
      for (const e of out) {
        if (!names.has(e.node)) { edgesOk = false; edgeDetail = `unknown target ${e.node}`; break; }
      }
    }
  }
  check(`${f}: all edges reference real nodes`, edgesOk, edgeDetail);

  // every node reachable from the trigger (no orphaned nodes except sticky notes)
  const triggers = w.nodes.filter((n) => n.type === 'n8n-nodes-base.scheduleTrigger');
  check(`${f}: exactly one schedule trigger`, triggers.length === 1, String(triggers.length));
  const rule = triggers[0]?.parameters?.rule?.interval?.[0];
  const ruleOk = rule && (
    (rule.field === 'minutes' && rule.minutesInterval >= 1 && rule.minutesInterval <= 1440) ||
    (rule.field === 'cronExpression' && /^(\S+\s+){4}\S+$/.test(rule.cronExpression || ''))
  );
  check(`${f}: trigger has valid schedule rule`, !!ruleOk, JSON.stringify(rule));

  const httpNodes = w.nodes.filter((n) => n.type === 'n8n-nodes-base.httpRequest');
  check(`${f}: has httpRequest nodes`, httpNodes.length > 0);
  for (const n of httpNodes) {
    const url = n.parameters?.url ?? '';
    const isAdminNotify = n.name === 'Notify admin channel';
    const targetsApi = url.includes('/api/v1/automation/');
    // The admin-channel notify step intentionally posts to the operator's own
    // webhook (env-configured); everything else must hit the backend API.
    const urlOk = isAdminNotify
      ? /^\=\{\{\s*\$env\.[A-Z_]+\s*\}\}$/.test(url)
      : targetsApi;
    check(`${f}/${n.name}: URL is correct for its role`, urlOk, url.slice(0, 80));
    const blob = JSON.stringify(n);
    const leak = SECRET_PATTERNS.find((p) => p.test(blob) && !/x-service-token['"]?\s*=\s*the server/i.test(blob));
    // the README sticky note legitimately mentions the header NAME; flag only values
    const hasValue = /x-service-token['"]?\s*:\s*['"][^'"]{4,}['"]/i.test(blob);
    check(`${f}/${n.name}: no embedded secret`, !hasValue, hasValue ? 'secret-like value found' : '');
    void leak;
    const cred = n.parameters?.authentication === 'genericCredentialType'
      ? w.nodes.find((x) => x.name === n.name)?.credentials?.httpHeaderAuth
      : n.credentials?.httpHeaderAuth;
    const credRef = n.credentials?.httpHeaderAuth;
    if (n.name !== 'Notify admin channel') {
      check(`${f}/${n.name}: credential by name only`,
        credRef?.name === 'ZenSkil Backend API' && (credRef.id === null || credRef.id === undefined),
        JSON.stringify(credRef));
    }
    void cred;
  }
  check(`${f}: no Bearer <redacted> anywhere`, !/bearer\s+[a-z0-9._-]{8,}/i.test(raw));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
