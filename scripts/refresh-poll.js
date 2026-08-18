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
const DEFAULT_API = 'https://bloom.comhairle.scot/api';

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
    const pct = Math.round(frac * 100);
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
  --api <url>     comhairle base URL. Default: ${DEFAULT_API}
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

async function loadPayload({ api, step, from }) {
  if (from) {
    const file = path.resolve(from);
    console.log(`reading ${path.relative(ROOT, file)}`);
    return { payload: JSON.parse(fs.readFileSync(file, 'utf8')), snapshot: null };
  }
  const url = `${api}/tools/polis/report_data?workflow_step_id=${encodeURIComponent(step)}`;
  console.log(`fetching ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → ${res.status} ${res.statusText}`);
  const text = await res.text();
  // Every live fetch is saved, dry run included. Partly so a surprising number later can
  // be traced to the payload that produced it — but mostly so that reviewing a dry run
  // and then applying it are the same payload. People vote continuously, so a second
  // fetch is a different poll, and "apply what I just reviewed" has to mean --from.
  fs.mkdirSync(SNAPSHOTS, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(SNAPSHOTS, `report-data-${stamp}.json`);
  fs.writeFileSync(file, text);
  const snapshot = path.relative(ROOT, file);
  console.log(`saved ${snapshot}`);
  return { payload: JSON.parse(text), snapshot };
}

const clip = (s, n) => (s.length <= n ? s : s.slice(0, n - 1) + '…');
const heading = t => console.log(`\n${t}\n${'─'.repeat(t.length)}`);

function main(args, payload, snapshot) {
  const data = JSON.parse(fs.readFileSync(DATA, 'utf8'));
  const before = data.groups.map(g => g.key);

  const groups = [...payload.groups].sort((a, b) => a.group_id - b.group_id);
  const keys = groups.map(g => keyForGroup(g.group_id));
  // Polis re-clusters as votes arrive, so which cluster is "the skeptics" can change
  // between refreshes. Labels are reset to plain names rather than carried over — an
  // inherited label is a claim about a cluster that may no longer be the same one.
  data.groups = groups.map(g => ({
    key: keyForGroup(g.group_id),
    label: `Group ${keyForGroup(g.group_id)}`,
    members: g.total_members,
  }));

  const byId = new Map(data.records.map(r => [r.id, r]));
  const updated = [], added = [], textDiffs = [];
  const seen = new Set();

  for (const c of payload.comments) {
    const id = 'p' + c.tid;
    seen.add(id);
    const vote = voteFor(c, keys);
    const rec = byId.get(id);
    if (rec) {
      if (JSON.stringify(rec.vote) !== JSON.stringify(vote)) updated.push(id);
      rec.vote = vote;
      if (rec.text !== c.text) textDiffs.push({ id, was: rec.text, now: c.text });
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
  console.log('  Labels have been reset. To re-apply meaning, here is each cluster:');
  for (const g of groups) {
    const key = keyForGroup(g.group_id);
    console.log(`\n  Group ${key} — ${g.total_members} members`);
    for (const rc of (g.representative_comments || []).slice(0, 3)) {
      console.log(`    · ${clip(rc.text, 100)}`);
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
    console.log('    Left in place — their tags exist nowhere else, so removal is your call.');
    // Their tallies are for the old clusters and there is no upstream data to redo them
    // with, so the file now describes two different group worlds at once. build.js
    // catches that; say so here rather than letting the next build look like a bug.
    if (regrouped) {
      console.log('    Their votes were counted over the OLD clusters and cannot be');
      console.log('    recomputed. "node build.js" will fail naming them until you either');
      console.log('    remove them or get them back into the poll.');
    }
  }
  if (textDiffs.length) {
    console.log(`  ${textDiffs.length} statement(s) whose text differs upstream (not applied):`);
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
