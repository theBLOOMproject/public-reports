#!/usr/bin/env node
// Merges a Polis snapshot (from scripts/fetch-snapshot.js) into the open-poll records in
// one report's data/<slug>/bloom-data.json — by default its latest snapshot.
//
//   node scripts/merge-snapshot.js <slug> --dry-run
//   node scripts/merge-snapshot.js <slug>
//   node scripts/merge-snapshot.js <slug> --from data/<slug>/polis-snapshots/report-data-….json
//
// Only two things in the file come from upstream: the per-group vote tallies on each
// poll record, and the opinion groups themselves. Everything else — tags, chips, place,
// text, the quote records, the themes — is editorial and is never written here. Where
// upstream and the file disagree about something editorial, this reports it and leaves
// it alone; deciding is a person's job.
const fs = require('fs');
const path = require('path');
const { ROOT, REPORTS, loadConfig, stepIdFor } = require('./lib/config');
const { latestSnapshot, readSnapshot } = require('./lib/polis-snapshot');

// Polis's own group ids are 0-based ints; the report has always called them A, B, …
// Same mapping as groupLabel() on the Civic OS side.
const keyForGroup = id => {
  if (!Number.isInteger(id) || id < 0 || id > 25) {
    throw new Error(`cannot name Polis group_id ${id} — expected an integer 0..25`);
  }
  return String.fromCharCode(65 + id);
};

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
  const pcts = [];
  for (const k of keys) {
    const gv = byKey[k] || { agrees: 0, disagrees: 0, passes: 0 };
    const n = gv.agrees + gv.disagrees + gv.passes;
    // A group that cast no vote on a statement counts as 0% agreement rather than
    // undefined — how p144/p149 have been stored since the original import.
    const pct = pctOf(gv.agrees, n);
    vote[k] = { a: gv.agrees, d: gv.disagrees, p: gv.passes, n, pct };
    vote.total += n;
    pcts.push(pct);
  }
  vote.gap = Math.max(...pcts) - Math.min(...pcts);
  vote.minAgree = Math.min(...pcts);
  return vote;
}

const USAGE = `
Merges a Polis snapshot into the open-poll records in one report's
data/<slug>/bloom-data.json.

  node scripts/merge-snapshot.js <slug> [options]

  <slug>          The report to merge into: a key of data/config.json.

Options
  --from <file>   The snapshot to merge. Default: the latest in
                  data/<slug>/polis-snapshots/. Either way it must have been fetched
                  from this report's configured Polis step.
  --dry-run       Report what would change and leave bloom-data.json alone.
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
  Then check the hand-written percentages in data/<slug>/theme-descriptions.json, which
  nothing recomputes.
`.trim();

function parseArgs(argv) {
  const args = { dryRun: false, report: null, from: null, help: false };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '-h' || a === '--help') args.help = true;
    else if (a === '--from') args.from = argv[++i];
    else if (a.startsWith('-')) throw new Error(`unknown option ${a}\n\n${USAGE}`);
    else positional.push(a);
  }
  if (args.help) return args;
  if (args.from === undefined) throw new Error(`--from needs a value\n\n${USAGE}`);
  if (positional.length !== 1) {
    throw new Error(`need exactly one report slug, got ${positional.length}\n\n${USAGE}`);
  }
  [args.report] = positional;
  return args;
}

// The latest snapshot is taken as-is: if it fails validation or belongs to another poll,
// the merge fails rather than falling back to an older one nobody chose.
function loadSnapshot(from, report) {
  const expected = stepIdFor(loadConfig(), report);
  const file = from || latestSnapshot(report);
  if (!file) {
    throw new Error(`data/${report}/polis-snapshots/ has no snapshots — `
      + `run: node scripts/fetch-snapshot.js ${report}`);
  }
  const abs = path.resolve(file);
  const rel = path.relative(ROOT, abs);
  const shown = rel.startsWith('..') ? abs : rel;
  const snapshot = readSnapshot(abs, shown);
  console.log(`${from ? 'reading' : 'latest snapshot:'} ${shown} `
    + `(fetched ${snapshot.source.fetchedAt})`);
  // Merged into another report, one poll's results would overwrite that report's votes
  // with a different poll's numbers.
  if (snapshot.source.workflowStepId !== expected) {
    throw new Error(`${shown} was fetched from Polis step ${snapshot.source.workflowStepId}, `
      + `but "${report}" is configured for ${expected}`);
  }
  return { snapshot, file: shown };
}

const clip = (s, n) => (s.length <= n ? s : s.slice(0, n - 1) + '…');

// Polis hands back some statements with a trailing newline, a non-breaking space where
// the file has a plain one, or a doubled space — differences nobody typed and nobody can
// see. Comparing raw text reports eight of those on a real refresh, which is exactly how
// a report gets ignored on the run that has something real in it. Compare normalized.
const normalizeText = t => t.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();

const heading = t => console.log(`\n${t}\n${'─'.repeat(t.length)}`);

function main(args, payload) {
  const data = JSON.parse(fs.readFileSync(args.dataFile, 'utf8'));
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

  const missing = data.records.filter(r => r.kind === 'poll' && !seen.has(r.id));

  // New statements slot into the poll block in tid order; the quote block that follows
  // is never touched. Existing records keep their positions either way.
  // `rest` is everything that isn't a statement rather than everything that is a
  // quote: these two arrays are reassembled into the whole file, so a record of
  // some future third kind has to fall through here, not vanish.
  if (added.length) {
    const statements = data.records.filter(r => r.kind === 'poll');
    const rest = data.records.filter(r => r.kind !== 'poll');
    const tid = r => Number(r.id.slice(1));
    data.records = [...statements, ...added].sort((a, b) => tid(a) - tid(b)).concat(rest);
  }

  const regrouped = before.length !== keys.length;

  heading('Opinion groups');
  if (regrouped) {
    console.log(`  !! Polis returned ${keys.length} cluster(s); the file had ${before.length}.`);
    console.log('     Every statement\'s gap/minAgree is now computed over a');
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

  const dataFile = path.relative(ROOT, args.dataFile);
  if (args.dryRun) {
    // Names the file even when it was picked as the latest, so applying it merges exactly
    // what was reviewed, even if another fetch lands in between.
    console.log(`\n--dry-run: ${dataFile} not written. Apply it with:`);
    console.log(`  node scripts/merge-snapshot.js ${args.report} --from ${args.snapshotFile}`);
    return;
  }
  fs.writeFileSync(args.dataFile, JSON.stringify(data, null, 2) + '\n');
  console.log(`\nwrote ${dataFile} — run "node build.js" next.`);
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
  } else {
    args.dataFile = path.join(REPORTS, args.report, 'bloom-data.json');
    const { snapshot, file } = loadSnapshot(args.from, args.report);
    args.snapshotFile = file;
    main(args, snapshot.reportData);
  }
} catch (err) {
  console.error(`merge failed: ${err.message}`);
  process.exit(1);
}
