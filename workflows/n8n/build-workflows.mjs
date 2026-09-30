// Builds the versioned n8n workflow JSONs for ZenSkil Hub Phase 5.
//
// Run: node build-workflows.mjs   (writes *.v1.json next to this script)
//
// Design: n8n is a THIN dispatcher. Every workflow fires on schedule, calls a
// backend /api/v1/automation/* endpoint with the service token, and loops over
// the returned candidates. All decisions (window/opt-in policy, reminder
// stages, idempotency) live in the backend and are covered by backend tests.
//
// Import: n8n → Workflows → ⋯ → Import from file. Then create the
// "ZenSkil Backend API" HTTP Header Auth credential (header x-service-token),
// and set env vars ZENSKILL_API_BASE_URL (+ ZENSKILL_ADMIN_ALERT_URL for
// ticket alerts) on the n8n instance.
import { writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const DIR = dirname(fileURLToPath(import.meta.url));
const BASE = '={{ $env.ZENSKILL_API_BASE_URL }}/api/v1/automation';
let seq = 0;
const nid = () => `node-${++seq}-${Math.random().toString(36).slice(2, 8)}`;

const CRED = { httpHeaderAuth: { id: null, name: 'ZenSkil Backend API' } };

function httpNode(name, method, url, extraParams = {}) {
  return {
    id: nid(),
    name,
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position: [0, 0],
    credentials: CRED,
    parameters: {
      method,
      url,
      authentication: 'genericCredentialType',
      genericAuthType: 'httpHeaderAuth',
      options: {},
      ...extraParams,
    },
    onError: 'continueErrorOutput',
  };
}

function scheduleNode(name, rule) {
  return {
    id: nid(),
    name,
    type: 'n8n-nodes-base.scheduleTrigger',
    typeVersion: 1.2,
    position: [0, 0],
    parameters: { rule: { interval: [rule] } },
  };
}

const everyMinutes = (m) => ({ field: 'minutes', minutesInterval: m });
const cron = (expr) => ({ field: 'cronExpression', cronExpression: expr });

function splitInBatches(name) {
  return {
    id: nid(), name, type: 'n8n-nodes-base.splitInBatches', typeVersion: 3,
    position: [0, 0], parameters: { batchSize: 1, options: {} },
  };
}

function ifTrue(name, leftValue) {
  return {
    id: nid(), name, type: 'n8n-nodes-base.if', typeVersion: 2.2, position: [0, 0],
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
        conditions: [{
          id: 'cond-1', leftValue,
          rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true },
        }],
        combinator: 'and',
      },
      options: {},
    },
  };
}

function stickyNote(name, content) {
  return {
    id: nid(), name, type: 'n8n-nodes-base.stickyNote', typeVersion: 1,
    position: [0, 0], parameters: { content, height: 320, width: 420, color: 4 },
  };
}

function layout(nodes) {
  nodes.forEach((n, i) => { n.position = [240 * i, n.position[1] || 300]; });
  return nodes;
}

// connections: list of [fromName, toName, outputIndex?]
function wire(nodes, edges) {
  const byName = Object.fromEntries(nodes.map((n) => [n.name, n]));
  const connections = {};
  for (const [from, to, outIdx = 0] of edges) {
    connections[from] ??= { main: [] };
    while (connections[from].main.length <= outIdx) connections[from].main.push([]);
    connections[from].main[outIdx].push({ node: to, type: 'main', index: 0 });
    if (!byName[from] || !byName[to]) throw new Error(`Unknown node in edge ${from} -> ${to}`);
  }
  return connections;
}

function workflow(name, notes, nodes, edges) {
  const all = [...notes, ...layout(nodes)];
  return {
    name,
    version: 1,
    nodes: all,
    connections: wire(nodes, edges),
    settings: { executionOrder: 'v1' },
    staticData: null,
    pinData: {},
    meta: {
      templateCredsSetupCompleted: false,
      zenskill: { phase: 5, workflowVersion: 1, backend: 'authoritative — n8n is a thin dispatcher' },
    },
  };
}

const NOTE_AUTH = stickyNote(
  'README — credentials',
  '## ZenSkil automation — setup\n' +
  '1. Create an **HTTP Header Auth** credential named `ZenSkil Backend API` ' +
  'with header `x-service-token` = the server\'s AUTOMATION_SERVICE_TOKEN.\n' +
  '2. Set env `ZENSKILL_API_BASE_URL` on this n8n instance ' +
  '(e.g. https://api.zenskill.example.com).\n' +
  '3. Activate the workflow. All business decisions live in the backend;\n' +
  'this workflow only schedules and dispatches.',
);

// ---------------------------------------------------------------- 1. dispatcher
{
  const t = scheduleNode('Every 5 minutes', everyMinutes(5));
  const fetch = httpNode('Fetch pending notifications', 'GET', `${BASE}/notifications/pending?limit=50`);
  const loop = splitInBatches('Loop notifications');
  const send = httpNode('Dispatch notification', 'POST', `${BASE}/notifications/={{ $json.id }}/dispatch`);
  const done = stickyNote('Done', 'SplitInBatches "done" output ends the run.');
  const nodes = [t, fetch, loop, send];
  const edges = [
    [t.name, fetch.name],
    [fetch.name, loop.name],
    [loop.name, send.name],
    [send.name, loop.name],          // main output → next batch
  ];
  // error output of send → back to loop (skips the failed item, continues)
  const wf = workflow('ZenSkil — Notification Dispatcher', [NOTE_AUTH], nodes, edges);
  wf.connections[send.name].main.push([{ node: loop.name, type: 'main', index: 0 }]);
  writeFileSync(join(DIR, 'notification-dispatcher.v1.json'), JSON.stringify(wf, null, 2) + '\n');
}

// ------------------------------------------------------- 2. abandoned reminders
{
  const t = scheduleNode('Every 30 minutes', everyMinutes(30));
  const fetch = httpNode('Fetch abandonment candidates', 'GET', `${BASE}/orders/abandoned?limit=100`);
  const loop = splitInBatches('Loop candidates');
  const send = httpNode('Send abandonment reminder', 'POST', `${BASE}/orders/={{ $json.id }}/abandonment-reminder`);
  const nodes = [t, fetch, loop, send];
  const wf = workflow('ZenSkil — Abandoned Order Reminders', [NOTE_AUTH], nodes, [
    [t.name, fetch.name],
    [fetch.name, loop.name],
    [loop.name, send.name],
    [send.name, loop.name],
  ]);
  wf.connections[send.name].main.push([{ node: loop.name, type: 'main', index: 0 }]);
  writeFileSync(join(DIR, 'abandoned-reminders.v1.json'), JSON.stringify(wf, null, 2) + '\n');
}

// --------------------------------------------------------- 3. renewal reminders
{
  const t = scheduleNode('Daily 09:00 Asia/Karachi', cron('0 9 * * *'));
  const fetch = httpNode('Fetch renewal candidates', 'GET', `${BASE}/subscriptions/renewal-candidates?limit=200`);
  const loop = splitInBatches('Loop candidates');
  const send = httpNode('Send renewal reminder', 'POST', `${BASE}/subscriptions/={{ $json.subscriptionId }}/renewal-reminder`);
  const nodes = [t, fetch, loop, send];
  const wf = workflow('ZenSkil — Renewal Reminders', [NOTE_AUTH], nodes, [
    [t.name, fetch.name],
    [fetch.name, loop.name],
    [loop.name, send.name],
    [send.name, loop.name],
  ]);
  wf.connections[send.name].main.push([{ node: loop.name, type: 'main', index: 0 }]);
  writeFileSync(join(DIR, 'renewal-reminders.v1.json'), JSON.stringify(wf, null, 2) + '\n');
}

// ------------------------------------------------------------ 4. expiry sweeper
{
  const t = scheduleNode('Every 15 minutes', everyMinutes(15));
  const run = httpNode('Run expiry sweeper', 'POST', `${BASE}/subscriptions/sweeper/run`);
  const note = stickyNote(
    'Idempotent',
    'The sweeper is idempotent: ACTIVE→EXPIRING_SOON at 7d, →EXPIRED after ' +
    'expiry+grace. It also runs in-process every 15 min; this workflow is a ' +
    'second trigger and is safe to overlap.',
  );
  const wf = workflow('ZenSkil — Subscription Expiry Sweeper', [NOTE_AUTH, note], [t, run], [
    [t.name, run.name],
  ]);
  writeFileSync(join(DIR, 'expiry-sweeper.v1.json'), JSON.stringify(wf, null, 2) + '\n');
}

// -------------------------------------------------------------- 5. ticket alerts
{
  const t = scheduleNode('Every 5 minutes', everyMinutes(5));
  const fetch = httpNode('Fetch unalerted tickets', 'GET', `${BASE}/support/tickets/alerts?limit=50`);
  const loop = splitInBatches('Loop tickets');
  const claim = httpNode('Claim ticket alert', 'POST', `${BASE}/support/tickets/={{ $json.id }}/alert`);
  const isClaimed = ifTrue('Claimed by this run?', '={{ $json.claimed }}');
  // Phase 6: claiming only ENQUEUES the alert in the backend outbox; this
  // step triggers durable delivery with retry (in-process cron is the safety
  // net). n8n no longer POSTs to the admin channel directly — the backend
  // owns ZENSKILL_ADMIN_ALERT_URL.
  const process = httpNode('Process alert outbox', 'POST', `${BASE}/support/alerts/process?limit=50`);
  const note = stickyNote(
    'Admin channel',
    'Point env ZENSKILL_ADMIN_ALERT_URL at your admin channel (Slack webhook, ' +
    'Telegram bot, or email service) — the BACKEND reads it, not n8n. ' +
    'Claiming a ticket only ENQUEUES an alert in the admin_alert_outbox table; ' +
    'the backend delivers it with backoff (1m→5m→30m→2h→8h, max 5 attempts) ' +
    'via the in-process cron and the "Process alert outbox" step. ' +
    'Monitor: GET /api/v1/automation/support/alerts/outbox.',
  );
  const nodes = [t, fetch, loop, claim, isClaimed, process];
  const wf = workflow('ZenSkil — Ticket Alerts', [NOTE_AUTH, note], nodes, [
    [t.name, fetch.name],
    [fetch.name, loop.name],
    [loop.name, claim.name],
    [claim.name, isClaimed.name],
    [isClaimed.name, process.name, 0],  // true → process outbox
    [isClaimed.name, loop.name, 1],     // false → next ticket
    [process.name, loop.name],
  ]);
  wf.connections[claim.name].main.push([{ node: loop.name, type: 'main', index: 0 }]); // claim error → next
  wf.version = 2;
  writeFileSync(join(DIR, 'ticket-alerts.v2.json'), JSON.stringify(wf, null, 2) + '\n');
}

// ----------------------------------------------------------------- 6. db-backup
{
  const t = scheduleNode('Nightly 02:00 Asia/Karachi', cron('0 2 * * *'));
  const run = httpNode('Run database backup', 'POST', `${BASE}/maintenance/db-backup`, { timeout: 600000 });
  const ok = ifTrue('Backup succeeded?', '={{ $json.file }}');
  const note = stickyNote(
    'Backups',
    'The backend runs pg_dump → gzip into BACKUP_DIR and keeps the newest ' +
    'BACKUP_RETENTION_COUNT files (default 7). This workflow only triggers ' +
    'it. Verify restores with the Phase 12 restore drill (BACKUP.md).',
  );
  const wf = workflow('ZenSkil — Nightly DB Backup', [NOTE_AUTH, note], [t, run, ok], [
    [t.name, run.name],
    [run.name, ok.name],
  ]);
  writeFileSync(join(DIR, 'db-backup.v1.json'), JSON.stringify(wf, null, 2) + '\n');
}

console.log('Wrote 6 workflow JSONs to', DIR);

// ---------------------------------------------------- 7. fulfillment processor
// Phase 8: the fulfillment worker is idempotent — PENDING tasks are claimed
// atomically (exactly one winner per task) and run through the provider. The
// manual provider defers every task to the admin task queue; future API
// providers execute automatically.
{
  const t = scheduleNode('Every 5 minutes', everyMinutes(5));
  const run = httpNode('Run fulfillment worker', 'POST', `${BASE}/fulfillment/process`);
  const note = stickyNote(
    'Idempotent',
    'PENDING tasks are claimed atomically (exactly one winner per task). ' +
    'The manual provider defers every task to the admin queue. It also runs ' +
    'in-process every 5 min; this workflow is a second trigger and is safe ' +
    'to overlap.',
  );
  const wf = workflow('ZenSkil — Fulfillment Worker', [NOTE_AUTH, note], [t, run], [
    [t.name, run.name],
  ]);
  wf.meta.zenskill.phase = 8;
  writeFileSync(join(DIR, 'fulfillment-processor.v1.json'), JSON.stringify(wf, null, 2) + '\n');
  console.log('Wrote fulfillment-processor.v1.json to', DIR);
}
