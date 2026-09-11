// The data checks: invariants across a report's files that parsing alone can't see.
// build.js runs them on every build, merge-snapshot.js on what it is about to write, and
// scripts/validate-data.js on demand, so a hand edit can be checked without a build.
//
// Each check reports through say.error (the report can't be trusted as built) or say.warn
// (it builds, but something needs an editorial look), and never prints or throws itself —
// what to do about a finding is the caller's call.
const fs = require('fs');
const path = require('path');
const { ROOT, REPORTS } = require('./config');

const isObject = x => x !== null && typeof x === 'object' && !Array.isArray(x);

// Theme membership is derived: a record belongs to every theme that lists one of its
// tags. A record carrying no tag any theme claims does not land somewhere wrong — it
// drops out of the report altogether, silently.
//
// This used to fail the build, on the reasoning that a silent disappearance is worse
// than a loud stop. But the invariant it protected was never a property of the data:
// the original spreadsheet had untagged rows, and every record only satisfies this
// today because the tags were hand-backfilled when themes moved from a fixed field to
// derived membership. A refresh pulls in new Polis statements, which arrive untagged
// by definition — tags are editorial and exist nowhere upstream. So this warns, and
// tagging the named records is the editorial follow-up.
function checkEveryRecordReachable(data, file, ctx, say) {
  const claimed = new Set(data.themes.flatMap(t => t.tags));
  const orphans = data.records.filter(r => !r.tags.some(tag => claimed.has(tag)));
  if (orphans.length) {
    say.warn(`${file}: ${orphans.length} record(s) carry no tag claimed by `
      + `any theme and will appear under no theme at all: ${orphans.map(r => r.id).join(', ')}`);
  }
}

const VOTE_DERIVED = ['total', 'gap', 'minAgree'];

function checkVoteIntegrity(data, file, ctx, say) {
  const problems = [];
  if (!Array.isArray(data.groups) || data.groups.length === 0) {
    return say.error(`${file}: "groups" must be a non-empty array of {key, label}`);
  }
  const keys = data.groups.map(g => g.key);
  if (new Set(keys).size !== keys.length) {
    return say.error(`${file}: duplicate group key in [${keys.join(', ')}]`);
  }

  for (const r of data.records) {
    if (!r.vote) continue;
    const v = r.vote;
    const note = msg => problems.push(`${r.id}: ${msg}`);

    const has = Object.keys(v).filter(k => !VOTE_DERIVED.includes(k));
    const unknown = has.filter(k => !keys.includes(k));
    const missing = keys.filter(k => !v[k]);
    // Usually this means a statement was left behind by a recluster: its tallies were
    // computed over a group set the file no longer declares, and nothing can recompute
    // them, so naming both sets is the only useful thing to say.
    if (unknown.length || missing.length) {
      note(`vote has tallies for [${has.join(', ')}], but the declared groups are `
        + `[${keys.join(', ')}]`);
    }
  }

  // One bad group key trips every record, so cap the list — the first few say
  // what is wrong and the count says how far it spread.
  if (problems.length) {
    const SHOWN = 12;
    const shown = problems.slice(0, SHOWN);
    if (problems.length > SHOWN) shown.push(`… and ${problems.length - SHOWN} more`);
    say.error(`${file}: ${problems.length} vote inconsistency(ies):\n    `
      + shown.join('\n    '));
  }
}

// bloom-insights' ids reference bloom-data records by id; a typo or a record
// getting renumbered/removed would otherwise fail silently at runtime (a
// dead carousel card, or — if it's the *only* id in an entry — a whole
// insight vanishing).
function checkInsightIdsResolve(insights, file, { bloomData }, say) {
  const knownIds = new Set(bloomData.records.map(r => r.id));
  const bad = [];
  for (const [theme, entries] of Object.entries(insights)) {
    entries.forEach(e => e.ids.forEach(id => { if (!knownIds.has(id)) bad.push(`${theme}: ${id}`); }));
  }
  if (bad.length) say.error(`${file}: id(s) not found in bloom-data.json: ${bad.join(', ')}`);
}

// Keep in sync with MIN_GROUP_VOTES in src/app.js — there is no module boundary
// between this and the app (app.js is inlined verbatim as a raw block), so the
// constant is duplicated on purpose rather than parsed back out of the source.
const MIN_GROUP_VOTES = 8;

// An insight is an editorial claim citing specific statements as its evidence. When
// a cited statement has a group too thin to report on, the app flags that group's
// %-agree number with a low-data marker — so the carousel illustrating the claim
// quietly leans on a thin group. The code can't tell whether the claim or the
// citation should change, so it names them and leaves it to the editorial pass. Ids
// that don't resolve are checkInsightIdsResolve's to report, so they're skipped here.
function checkInsightVoteDepth(insights, file, { bloomData }, say) {
  const keys = bloomData.groups.map(g => g.key);
  const byId = new Map(bloomData.records.map(r => [r.id, r]));
  const thin = [];
  for (const [theme, entries] of Object.entries(insights)) {
    entries.forEach(e => e.ids.forEach(id => {
      const r = byId.get(id);
      if (!r || !r.vote) return;   // quotes carry no vote data
      const ns = keys.map(k => r.vote[k].n);
      if (Math.min(...ns) < MIN_GROUP_VOTES) thin.push(`${theme}: ${id} (groups ${ns.join('/')})`);
    }));
  }
  if (thin.length) {
    say.warn(`${file}: ${thin.length} insight-cited statement(s) have a group `
      + `under ${MIN_GROUP_VOTES} votes and will show a low-data flag:\n    `
      + thin.join('\n    '));
  }
}

// group-info.json is a hand-maintained snapshot (participant counts, display color) keyed
// by group key, kept separate from bloom-data.json's own groups[] because merge-snapshot.js
// deliberately never persists cluster sizes there (see its comment on why). A refresh that
// regroups — a different number of keys, or the same keys meaning different clusters — makes
// this file stale in a way nothing here can detect; it can only catch a key mismatch.
function checkGroupInfoKeys(info, file, { bloomData }, say) {
  const groupKeys = bloomData.groups.map(g => g.key);
  const infoKeys = Object.keys(info);
  const missing = groupKeys.filter(k => !infoKeys.includes(k));
  const extra = infoKeys.filter(k => !groupKeys.includes(k));
  if (missing.length || extra.length) {
    say.warn(`${file}: out of sync with bloom-data.json's groups `
      + `[${groupKeys.join(', ')}]`
      + (missing.length ? ` — missing entries for [${missing.join(', ')}]` : '')
      + (extra.length ? `; stale entries for [${extra.join(', ')}] no longer in bloom-data.json` : ''));
  }
}

// group-statements.json's ids reference bloom-data records by id; a typo or a record
// getting renumbered/removed would otherwise fail silently at runtime (a dead defining-
// statement page).
function checkGroupStatementIdsResolve(statements, file, { bloomData }, say) {
  const knownIds = new Set(bloomData.records.map(r => r.id));
  const bad = [];
  for (const [group, entries] of Object.entries(statements)) {
    entries.forEach(e => { if (!knownIds.has(e.id)) bad.push(`${group}: ${e.id}`); });
  }
  if (bad.length) say.warn(`${file}: id(s) not found in bloom-data.json: ${bad.join(', ')}`);
}

// consensus-statements.json's ids reference bloom-data records by id, same
// deal as group-statements.json's — a typo or a renumbered/removed record
// would otherwise fail silently at runtime (a Consensus card that never
// renders instead of an error at build time).
function checkConsensusIdsResolve(consensus, file, { bloomData }, say) {
  const knownIds = new Set(bloomData.records.map(r => r.id));
  const bad = consensus.ids.filter(id => !knownIds.has(id));
  if (bad.length) say.warn(`${file}: id(s) not found in bloom-data.json: ${bad.join(', ')}`);
}

// participant-locations.json's per-city counts plus 'other' are meant to add up to
// 'total' (every row in the source CSV, mapped or not) — catches a hand-edit to one
// number that forgets the others, which the parse alone can't see.
function checkParticipantLocationTotals(loc, file, ctx, say) {
  const mapped = loc.cities.reduce((s, c) => s + c.count, 0) + loc.other;
  if (mapped !== loc.total) {
    say.warn(`${file}: cities[].count + other (${mapped}) does not equal `
      + `total (${loc.total})`);
  }
}

// counties.json's home counties (report.json's map.homeCounties) are the Demographics
// map's home view — without them there's nothing to render on load, so a missing one
// is an error rather than a warning.
function checkCountiesShape(geo, file, { slug, report }, say) {
  const home = report.map && report.map.homeCounties;
  if (!home || !Object.keys(home).length) {
    return say.error(`data/${slug}/report.json: map.homeCounties must map at least one `
      + 'county FIPS id to its name');
  }
  const ids = new Set(geo.features.map(f => f.id));
  const missing = Object.keys(home).filter(id => !ids.has(id));
  if (missing.length) {
    say.error(`${file}: missing home county FIPS id(s) [${missing.join(', ')}] `
      + 'named in report.json');
  }
}

// demographics.json pairs two halves by label: poll, which merge-snapshot.js rewrites
// from comhairle, and actual, the hand-maintained population shares. A poll row with no
// actual would render a blank ACTUAL cell. An actual with no poll row is fine: it's a
// group nobody in the poll belongs to, and the modal shows it at 0%.
function checkDemographics(demo, file, ctx, say) {
  const { poll, actual } = demo;
  if (!isObject(poll) || !Array.isArray(poll.categories)) {
    return say.error(`${file}: "poll" must hold "total" and "categories"`);
  }
  if (!isObject(actual)) {
    return say.error(`${file}: "actual" must be an object keyed by category`);
  }

  // answered can't exceed the shared total — catches a hand edit to one category that
  // forgets the total was for all of them.
  const tooMany = poll.categories.filter(c => c.answered > poll.total);
  if (tooMany.length) {
    say.warn(`${file}: categor(y/ies) with answered > total (${poll.total}): `
      + tooMany.map(c => `${c.key} (${c.answered})`).join(', '));
  }

  const keys = poll.categories.map(c => c.key);
  const unknown = Object.keys(actual).filter(k => !keys.includes(k));
  if (unknown.length) {
    say.error(`${file}: actual has categor(y/ies) [${unknown.join(', ')}] that poll does not — `
      + `poll has [${keys.join(', ')}]`);
  }
  for (const cat of poll.categories) {
    const shares = isObject(actual[cat.key]) ? actual[cat.key] : {};
    const notNumbers = Object.entries(shares)
      .filter(([, v]) => typeof v !== 'number' || !Number.isFinite(v)).map(([label]) => label);
    if (notNumbers.length) {
      say.error(`${file}: actual.${cat.key} values that aren't numbers: ${notNumbers.join(', ')}`);
    }
    const missing = cat.breakdown.map(r => r.label).filter(label => !(label in shares));
    if (missing.length) {
      say.error(`${file}: actual.${cat.key} has no entry for poll label(s): `
        + missing.map(l => JSON.stringify(l)).join(', '));
    }
  }
}

// Every file below depends on bloom-data.json being sound, which is why it goes first and
// a problem there stops the rest.
const CHECKS = [
  ['bloom-data.json', [checkEveryRecordReachable, checkVoteIntegrity]],
  ['bloom-insights.json', [checkInsightIdsResolve, checkInsightVoteDepth]],
  ['group-info.json', [checkGroupInfoKeys]],
  ['group-statements.json', [checkGroupStatementIdsResolve]],
  ['consensus-statements.json', [checkConsensusIdsResolve]],
  ['participant-locations.json', [checkParticipantLocationTotals]],
  ['counties.json', [checkCountiesShape]],
  ['demographics.json', [checkDemographics]],
];

function readJson(abs) {
  let raw;
  try {
    raw = fs.readFileSync(abs, 'utf8');
  } catch (err) {
    throw new Error(`cannot read ${path.relative(ROOT, abs)}: ${err.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`${path.relative(ROOT, abs)} is not valid JSON: ${err.message}`);
  }
}

// overrides maps a file name to data to check in place of what's on disk — how the merge
// checks what it's about to write before writing it. An unreadable or unparseable file
// throws: there's nothing to check.
function validateReport(slug, overrides = {}) {
  const dir = path.join(REPORTS, slug);
  const load = name => (name in overrides ? overrides[name] : readJson(path.join(dir, name)));
  const errors = [], warnings = [];
  const say = { error: m => errors.push(m), warn: m => warnings.push(m) };
  const ctx = { slug, report: load('report.json'), bloomData: load('bloom-data.json') };

  for (const [name, checks] of CHECKS) {
    const data = name === 'bloom-data.json' ? ctx.bloomData : load(name);
    const file = `data/${slug}/${name}`;
    for (const check of checks) check(data, file, ctx, say);
    if (name === 'bloom-data.json' && errors.length) break;
  }
  return { errors, warnings };
}

module.exports = { validateReport };
