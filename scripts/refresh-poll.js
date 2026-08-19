#!/usr/bin/env node
// Refreshes the open-poll records in data/bloom-data.json from Polis, via comhairle.
//
//   node scripts/refresh-poll.js --step <workflow-step-uuid>
//   node scripts/refresh-poll.js --step <uuid> --dry-run
//   node scripts/refresh-poll.js --from data/polis-snapshots/report-data-2026-08-18T….json
//
// Only two things in the file come from upstream: the per-group vote tallies on each
// poll record, and the opinion groups themselves. Everything else — tags, chips, place,
// text, the quote records, the themes — is editorial and is never written here. Where
// upstream and the file disagree about something editorial, this reports it and leaves
// it alone; deciding is a person's job.
//
// GET /tools/polis/report_data has no auth check on the comhairle side, so this needs
// no credentials and touches no personal data.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data', 'bloom-data.json');
const SNAPSHOTS = path.join(ROOT, 'data', 'polis-snapshots');
// The Bloom deployment, per bloom_charts/civic-os/templates/configmap.yaml, which sets
// this same API_URL + API_PREFIX for both the staging and production admin apps.
// Note comhairle.scot is a *different* comhairle instance and answers plausibly:
// pointing at it would refresh the report with another project's poll.
const DEFAULT_API = 'https://comhairle.bloomproject.us/api';

// Polis's own group ids are 0-based ints; the report has always called them A, B, …
// Same mapping as groupLabel() on the Civic OS side.
const keyForGroup = id => {
  if (!Number.isInteger(id) || id < 0 || id > 25) {
    throw new Error(`cannot name Polis group_id ${id} — expected an integer 0..25`);
  }
  return String.fromCharCode(65 + id);
};

// Thresholds match CONSENSUS_AGREE / CONSENSUS_DISAGREE in the Civic OS insights page.
// See build.js checkVoteIntegrity for why consensus is decided on unrounded fractions
// while gap and minAgree use the rounded ones — it is load-bearing, not an oversight.
const CONSENSUS_AGREE = 0.8;
const CONSENSUS_DISAGREE = 0.2;

// The display rounding, in one place: the merge stores it and the re-label aid prints it,
// and a group shown as 88% here has to be the 88% that lands in the file.
const pctOf = (agrees, n) => (n > 0 ? Math.round((agrees / n) * 100) : 0);

// Polis ranks representative statements by how *distinctively* a group votes on them,
// which includes statements the group is defined by rejecting — and comhairle keeps only
// the tid from each repness entry, dropping Polis's agree/disagree direction. So the list
// alone reads as self-contradictory: group C's contains both "the costs far outweigh any
// perceived benefit" and "data centers bring good-paying jobs", which it agrees with 88%
// and 0% respectively. The group's own percentage is what disambiguates it.
const groupVoteOn = (comment, groupId) => {
  const gv = comment && (comment.group_votes || []).find(v => v.group_id === groupId);
  if (!gv) return null;
  const n = gv.agrees + gv.disagrees + gv.passes;
  return { n, pct: pctOf(gv.agrees, n) };
};

function voteFor(comment, keys) {
  const byKey = {};
  for (const gv of comment.group_votes) byKey[keyForGroup(gv.group_id)] = gv;

  const vote = { total: 0 };
  const fracs = [], pcts = [];
  for (const k of keys) {
    const gv = byKey[k] || { agrees: 0, disagrees: 0, passes: 0 };
    const n = gv.agrees + gv.disagrees + gv.passes;
    // A group that cast no vote on a statement counts as 0% agreement rather than
    // undefined — how p144/p149 have been stored since the original import.
    const frac = n > 0 ? gv.agrees / n : 0;
    const pct = pctOf(gv.agrees, n);
    vote[k] = { a: gv.agrees, d: gv.disagrees, p: gv.passes, n, pct };
    vote.total += n;
    fracs.push(frac);
    pcts.push(pct);
  }
  vote.gap = Math.max(...pcts) - Math.min(...pcts);
  vote.minAgree = Math.min(...pcts);
  vote.consensus = fracs.every(f => f >= CONSENSUS_AGREE) ? 1
    : fracs.every(f => f < CONSENSUS_DISAGREE) ? -1 : 0;
  return vote;
}

const USAGE = `
Refreshes the open-poll records in data/bloom-data.json from Polis, via comhairle.

  node scripts/refresh-poll.js --step <workflow-step-uuid> [options]
  node scripts/refresh-poll.js --from <snapshot.json> [options]

Options
  --step <uuid>   Polis workflow step to fetch. This is the id comhairle knows the
                  poll by; the Insights page uses the same one.
  --from <file>   Merge a saved payload instead of fetching. Every live run leaves one
                  in data/polis-snapshots/, dry runs included, so this applies exactly
                  the payload you reviewed rather than re-fetching a moved-on poll.
                  Snapshots hold only the fields this script reads; a full payload
                  fetched by hand works too.
  --api <url>     comhairle base URL. Default: ${DEFAULT_API}
                  Local backend is usually http://localhost:3000.
                  Check this before a real run — pointing at the wrong environment
                  refreshes the published report with plausible but wrong numbers.
  --dry-run       Report what would change and leave data/bloom-data.json alone. Still
                  saves the snapshot, and prints the --from line that applies it.
  -h, --help      Show this.

What it writes
  Only the per-group vote tallies on each poll record, and the groups[] array. Tags,
  chips, place, text, the quote records and the themes are editorial: where upstream
  disagrees, it tells you and changes nothing.

  Group labels are reset to plain "Group A", because Polis re-clusters as votes arrive
  and an inherited label is a claim about a cluster that may no longer be the same one.
  Each cluster's size and representative statements are printed to help re-label them.

After a run
  node build.js        — new statements arrive untagged and are named in a warning
                         until you tag them; they show under no theme meanwhile.
  Then check the hand-written percentages in data/theme-descriptions.json, which
  nothing recomputes.
`.trim();

function parseArgs(argv) {
  const args = { dryRun: false, api: DEFAULT_API, step: null, from: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '-h' || a === '--help') args.help = true;
    else if (a === '--step') args.step = argv[++i];
    else if (a === '--api') args.api = argv[++i];
    else if (a === '--from') args.from = argv[++i];
    else throw new Error(`unknown argument ${a}\n\n${USAGE}`);
  }
  if (args.help) return args;
  for (const [flag, value] of [['--step', args.step], ['--api', args.api], ['--from', args.from]]) {
    if (value === undefined) throw new Error(`${flag} needs a value\n\n${USAGE}`);
  }
  if (!args.step && !args.from) {
    throw new Error(`need --step <workflow-step-uuid> or --from <file>\n\n${USAGE}`);
  }
  if (args.step && args.from) {
    throw new Error(`--step and --from are alternatives: one fetches, the other reads a file`);
  }
  return args;
}

// The endpoint returns a good deal this report has no use for: participant PCA positions,
// overall vote counts, Polis's own consensus and divisiveness scores, and the base-cluster
// id lists. Snapshots keep only what this script reads — the tallies it merges, and the
// cluster sizes and representative statements the re-label aid prints — so a saved payload
// says plainly what it is for. Anything needed later gets added here and re-fetched.
//
// Applied on read as well as on write, so merging a snapshot and merging the live response
// it came from cannot diverge, and a full payload fetched by hand still works.
const germane = payload => ({
  comments: (payload.comments || []).map(c => ({
    tid: c.tid,
    text: c.text,
    is_seed: c.is_seed,
    group_votes: (c.group_votes || []).map(gv => ({
      group_id: gv.group_id,
      agrees: gv.agrees,
      disagrees: gv.disagrees,
      passes: gv.passes,
    })),
  })),
  groups: (payload.groups || []).map(g => ({
    group_id: g.group_id,
    total_members: g.total_members,
    representative_comments: (g.representative_comments || [])
      .map(rc => ({ tid: rc.tid, text: rc.text })),
  })),
});

async function loadPayload({ api, step, from }) {
  if (from) {
    const file = path.resolve(from);
    console.log(`reading ${path.relative(ROOT, file)}`);
    return { payload: germane(JSON.parse(fs.readFileSync(file, 'utf8'))), snapshot: null };
  }
  const url = `${api}/tools/polis/report_data?workflow_step_id=${encodeURIComponent(step)}`;
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
  if (!res.ok) {
    const body = (await res.text()).trim();
    throw new Error(`${url}\n  → ${res.status} ${res.statusText}`
      + (body ? `\n  ${clip(body, 300)}` : '')
      + (res.status === 404 ? '\n  A 404 here usually means the step id belongs to a '
        + 'different environment than --api points at.' : ''));
  }
  const text = await res.text();
  // Every live fetch is saved, dry run included. Partly so a surprising number later can
  // be traced to the payload that produced it — but mostly so that reviewing a dry run
  // and then applying it are the same payload. People vote continuously, so a second
  // fetch is a different poll, and "apply what I just reviewed" has to mean --from.
  fs.mkdirSync(SNAPSHOTS, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(SNAPSHOTS, `report-data-${stamp}.json`);
  const snapshot = path.relative(ROOT, file);

  let payload;
  try {
    payload = germane(JSON.parse(text));
  } catch (e) {
    // Keep the unparseable body rather than dropping it — what the server actually said
    // is the only evidence of what went wrong.
    fs.writeFileSync(file, text);
    throw new Error(`${url} did not return JSON: ${e.message}\n  body saved to ${snapshot}`);
  }
  // Re-indented rather than saved verbatim: these sit in the repo to be read and diffed
  // against each other, and one 57KB line is neither.
  fs.writeFileSync(file, JSON.stringify(payload, null, 2) + '\n');
  console.log(`saved ${snapshot}`);
  return { payload, snapshot };
}

const clip = (s, n) => (s.length <= n ? s : s.slice(0, n - 1) + '…');

// Polis hands back some statements with a trailing newline, a non-breaking space where
// the file has a plain one, or a doubled space — differences nobody typed and nobody can
// see. Comparing raw text reports eight of those on a real refresh, which is exactly how
// a report gets ignored on the run that has something real in it. Compare normalized.
const normalizeText = t => t.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();

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
const heading = t => console.log(`\n${t}\n${'─'.repeat(t.length)}`);

function main(args, payload, snapshot) {
  const data = JSON.parse(fs.readFileSync(DATA, 'utf8'));
  const before = data.groups.map(g => g.key);

  const groups = [...payload.groups].sort((a, b) => a.group_id - b.group_id);
  const keys = groups.map(g => keyForGroup(g.group_id));
  // Polis re-clusters as votes arrive, so which cluster is "the skeptics" can change
  // between refreshes. Labels are reset to plain names rather than carried over — an
  // inherited label is a claim about a cluster that may no longer be the same one.
  // Cluster sizes are deliberately not stored: nothing in the report renders them, and a
  // stale count in the data file is worse than no count. They are printed below instead,
  // where they are actually needed — deciding what each cluster should be called.
  data.groups = groups.map(g => ({
    key: keyForGroup(g.group_id),
    label: `Group ${keyForGroup(g.group_id)}`,
  }));

  const byId = new Map(data.records.map(r => [r.id, r]));
  const updated = [], added = [], textDiffs = [];
  const seen = new Set();
  let whitespaceOnly = 0;

  for (const c of payload.comments) {
    const id = 'p' + c.tid;
    seen.add(id);
    const vote = voteFor(c, keys);
    const rec = byId.get(id);
    if (rec) {
      if (JSON.stringify(rec.vote) !== JSON.stringify(vote)) updated.push(id);
      rec.vote = vote;
      if (rec.text !== c.text) {
        if (normalizeText(rec.text) === normalizeText(c.text)) whitespaceOnly++;
        else textDiffs.push({ id, was: rec.text, now: c.text });
      }
      continue;
    }
    added.push({
      id,
      kind: 'poll',
      text: c.text,
      origin: c.is_seed ? 'cocap_seed' : 'participant',
      place: null,
      chips: c.is_seed ? ['SEED STATEMENT'] : [],
      vote,
      source: 'Open Poll',
      tags: [],
      inReport: false,
    });
  }

  const missing = data.records.filter(r => r.vote && !seen.has(r.id));

  // New statements slot into the poll block in tid order; the quote block that follows
  // is never touched. Existing records keep their positions either way.
  if (added.length) {
    const polls = data.records.filter(r => r.vote);
    const rest = data.records.filter(r => !r.vote);
    const tid = r => Number(r.id.slice(1));
    data.records = [...polls, ...added].sort((a, b) => tid(a) - tid(b)).concat(rest);
  }

  const regrouped = before.length !== keys.length;

  heading('Opinion groups');
  if (regrouped) {
    console.log(`  !! Polis returned ${keys.length} cluster(s); the file had ${before.length}.`);
    console.log('     Every statement\'s gap/minAgree/consensus is now computed over a');
    console.log('     different number of groups — the numbers in theme-descriptions.json');
    console.log('     and the DIFFERENCE_MIN_GAP threshold both want a second look.');
  }
  console.log('  Labels have been reset. To re-apply meaning, here is each cluster —');
  console.log('  the statements Polis says most distinguish it, and how it voted on them:');
  const commentByTid = new Map(payload.comments.map(c => [c.tid, c]));
  for (const g of groups) {
    const key = keyForGroup(g.group_id);
    console.log(`\n  Group ${key} — ${g.total_members} members`);
    // All of them, untruncated: this is the evidence someone re-labels the cluster
    // from, and the qualifier that decides what a group means is as often at the end
    // of a statement as the start.
    // Text normalized for display only — some statements carry a trailing newline
    // upstream, which prints as a stray blank line in the middle of the list.
    for (const rc of g.representative_comments || []) {
      const v = groupVoteOn(commentByTid.get(rc.tid), g.group_id);
      const stat = v
        ? `${String(v.pct).padStart(3)}% agree (${String(v.n).padStart(3)} votes)`
        : ' '.repeat(23);
      console.log(`    ${stat}  ${normalizeText(rc.text)}`);
    }
  }

  heading('Changes');
  console.log(`  ${updated.length} statement(s) with changed vote tallies`);
  console.log(`  ${added.length} new statement(s)`);
  if (added.length) {
    for (const r of added) console.log(`    + ${r.id} (${r.origin}) ${clip(r.text, 80)}`);
    console.log('    These arrived with no tags — tag them, or they appear under no theme.');
    if (added.some(r => r.origin === 'participant')) {
      console.log('    Participant statements also arrived with no demographic chips.');
    }
  }
  if (missing.length) {
    console.log(`  ${missing.length} statement(s) in the file are no longer in Polis:`);
    for (const r of missing) console.log(`    ? ${r.id} ${clip(r.text, 80)}`);
    if (regrouped) {
      console.log('    Their votes were counted over the OLD clusters and cannot be');
      console.log('    recomputed. "node build.js" will fail naming them until you either');
      console.log('    remove them or get them back into the poll.');
    }
  }
  if (whitespaceOnly) {
    console.log(`  ${whitespaceOnly} statement(s) differ from upstream only in whitespace `
      + '(trailing newlines, non-breaking spaces) — ignored, nothing to decide.');
  }
  if (textDiffs.length) {
    console.log(`  ${textDiffs.length} statement(s) whose wording differs upstream (not applied):`);
    // Not clipped: the wording that changed is as often at the end as the start.
    for (const d of textDiffs) {
      console.log(`    ~ ${d.id}\n        file:  ${d.was}\n        polis: ${d.now}`);
    }
  }

  if (args.dryRun) {
    console.log('\n--dry-run: data/bloom-data.json not written.');
    if (snapshot) {
      console.log('Apply exactly this payload — not whatever the poll looks like by then — with:');
      console.log(`  node scripts/refresh-poll.js --from ${snapshot}`);
    }
    return;
  }
  fs.writeFileSync(DATA, JSON.stringify(data, null, 2) + '\n');
  console.log(`\nwrote ${path.relative(ROOT, DATA)} — run "node build.js" next.`);
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return console.log(USAGE);
  const { payload, snapshot } = await loadPayload(args);
  main(args, payload, snapshot);
})().catch(err => {
  console.error(`refresh failed: ${err.message}`);
  process.exit(1);
});
