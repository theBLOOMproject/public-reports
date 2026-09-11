#!/usr/bin/env node
// Fetches one report's Polis results from comhairle — and, when the report's
// data/config.json entry names a demographics source, its poll's participation report —
// and saves them as one snapshot in data/<slug>/polis-snapshots/: the first step of the
// data pipeline. It reads nothing but data/config.json and writes nothing but the snapshot.
//
//   node scripts/fetch-snapshot.js <slug>
//
// Neither GET /tools/polis/report_data nor .../participation_report has an auth check on
// the comhairle side, so this needs no credentials.
const fs = require('fs');
const path = require('path');
const { ROOT, loadConfig, stepIdFor, demographicsFor } = require('./lib/config');
const {
  snapshotsDir, snapshotFileName, stripParticipantData, validateSnapshot, formatProblems,
} = require('./lib/polis-snapshot');
const { CATEGORIES, consentedCount } = require('./lib/participation-report');

// The Bloom deployment, per bloom_charts/civic-os/templates/configmap.yaml, which sets
// this same API_URL + API_PREFIX for both the staging and production admin apps.
// Note comhairle.scot is a *different* comhairle instance and answers plausibly:
// pointing at it would snapshot another project's poll.
const DEFAULT_API = 'https://comhairle.bloomproject.us/api';

const USAGE = `
Fetches one report's Polis results — and its poll's participation report, if
data/config.json says where it lives — from comhairle and saves them as one
validated snapshot in data/<slug>/polis-snapshots/.

  node scripts/fetch-snapshot.js <slug> [options]

  <slug>          The report to fetch: a key of data/config.json, whose
                  polis.workflowStepId says which poll to fetch, and whose
                  optional demographics block says which participation report.

Options
  --api <url>     comhairle base URL. Default: ${DEFAULT_API}
                  Local backend is usually http://localhost:3000.
  -h, --help      Show this.

What it writes
  One new snapshot: comhairle's Polis response, minus participant-level data (group
  membership and opinion-map positions); its participation report, which is aggregate
  counts only; and a record of where and when they were fetched. If either response
  fails validation, nothing is written.

After a run
  node scripts/merge-snapshot.js <slug> --dry-run
`.trim();

function parseArgs(argv) {
  const args = { api: DEFAULT_API, report: null, help: false };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') args.help = true;
    else if (a === '--api') args.api = argv[++i];
    else if (a.startsWith('-')) throw new Error(`unknown option ${a}\n\n${USAGE}`);
    else positional.push(a);
  }
  if (args.help) return args;
  if (args.api === undefined) throw new Error(`--api needs a value\n\n${USAGE}`);
  if (positional.length !== 1) {
    throw new Error(`need exactly one report slug, got ${positional.length}\n\n${USAGE}`);
  }
  [args.report] = positional;
  return args;
}

const clip = (s, n) => (s.length <= n ? s : s.slice(0, n - 1) + '…');

// Turn Node's terse network error codes into the thing you actually need to do.
function hintFor(code) {
  if (!code) return '';
  if (String(code).includes('CERT')) {
    return '\n  That host\'s TLS certificate is not trusted. A "Kubernetes Ingress'
      + '\n  Controller Fake Certificate" means nothing is routed for that hostname —'
      + '\n  check --api. If the certificate is genuinely self-signed and you trust the'
      + '\n  host, point NODE_EXTRA_CA_CERTS at its CA rather than disabling verification.';
  }
  if (code === 'ENOTFOUND') return '\n  That hostname does not resolve — check --api.';
  if (code === 'ECONNREFUSED') return '\n  Nothing is listening there — is the backend up?';
  return '';
}

async function fetchJson(url, notFoundHint) {
  console.log(`fetching ${url}`);
  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    // Node reports every network-level failure as a bare "fetch failed" and hides the
    // reason in .cause, which is useless when the answer is "that host has no route
    // for this name" or "you are pointed at the wrong environment".
    const code = e.cause && (e.cause.code || e.cause.message);
    throw new Error(`could not reach ${url}\n  ${code || e.message}${hintFor(code)}`);
  }
  // The status line alone hides the body, and comhairle puts the actual explanation
  // there — "Workflow Step not found" for an id this server has never heard of.
  const text = await res.text();
  if (!res.ok) {
    const body = text.trim();
    throw new Error(`${url}\n  → ${res.status} ${res.statusText}`
      + (body ? `\n  ${clip(body, 300)}` : '')
      + (res.status === 404 ? `\n  ${notFoundHint}` : ''));
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`${url} did not return JSON: ${e.message}\n  ${clip(text.trim(), 300)}`);
  }
}

const fetchReportData = (api, step) => fetchJson(
  `${api}/tools/polis/report_data?workflow_step_id=${encodeURIComponent(step)}`,
  'A 404 here usually means the step id belongs to a different environment than --api points at.');

const fetchParticipationReport = (api, { conversationId, workflowId }) => fetchJson(
  `${api}/conversation/${encodeURIComponent(conversationId)}`
    + `/workflow/${encodeURIComponent(workflowId)}/participation_report`,
  'A 404 here usually means the conversation or workflow id belongs to a different '
    + 'environment than --api points at.');

function summarize(snapshot) {
  const { comments, groups } = snapshot.reportData;
  const seeds = comments.filter(c => c.is_seed).length;
  console.log(`  ${comments.length} statements (${seeds} seed, ${comments.length - seeds} participant)`);
  console.log(`  ${groups.length} opinion groups: `
    + groups.map(g => `${String.fromCharCode(65 + g.group_id)} ${g.total_members}`).join(', ')
    + ' members');

  const pr = snapshot.participationReport;
  if (!pr) return;
  const answered = field => pr[field].filter(r => r.value !== null).reduce((s, r) => s + r.count, 0);
  console.log(`  demographics from ${consentedCount(pr)} of ${pr.totalParticipants} participants `
    + `(the rest didn't consent); answered: `
    + CATEGORIES.map(c => `${c.key} ${answered(c.field)}`).join(', '));
  console.log(`  ${Object.keys(pr.zipcodeCounts).length} distinct zip codes`);
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return console.log(USAGE);
  const config = loadConfig();
  const step = stepIdFor(config, args.report);
  const demographics = demographicsFor(config, args.report);

  const fetchedAt = new Date().toISOString();
  const snapshot = {
    source: { api: args.api, workflowStepId: step, fetchedAt },
    reportData: stripParticipantData(await fetchReportData(args.api, step)),
  };
  if (demographics) {
    snapshot.source.participationReport = demographics;
    snapshot.participationReport = await fetchParticipationReport(args.api, demographics);
  }
  const problems = validateSnapshot(snapshot);
  if (problems.length) {
    throw new Error(`comhairle's response is not a usable snapshot — nothing written:\n`
      + formatProblems(problems));
  }

  const dir = snapshotsDir(args.report);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, snapshotFileName(fetchedAt));
  // Indented rather than one long line: these sit in the repo to be read and diffed
  // against each other.
  fs.writeFileSync(file, JSON.stringify(snapshot, null, 2) + '\n');
  console.log(`saved ${path.relative(ROOT, file)}`);
  summarize(snapshot);
})().catch(err => {
  console.error(`fetch failed: ${err.message}`);
  process.exit(1);
});
