#!/usr/bin/env node
// Builds the deployable site into dist/.
//
//   node build.js
//
// Inlines src/app.css, src/app.js and data/*.json into index.template.html to
// produce a single self-contained dist/index.html, and copies the static assets
// alongside it. dist/ is gitignored and rebuilt on every deploy; only what lands
// in dist/ is published, so repo sources stay out of the public site.
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const TEMPLATE = path.join(ROOT, 'index.template.html');
const DIST = path.join(ROOT, 'dist');
const OUTPUT = path.join(DIST, 'index.html');

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
function checkEveryRecordReachable(data, file) {
  const claimed = new Set(data.themes.flatMap(t => t.tags));
  const orphans = data.records.filter(r => !r.tags.some(tag => claimed.has(tag)));
  if (orphans.length) {
    console.warn(`  WARNING ${file}: ${orphans.length} record(s) carry no tag claimed by `
      + `any theme and will appear under no theme at all: ${orphans.map(r => r.id).join(', ')}`);
  }
}

const VOTE_DERIVED = ['total', 'gap', 'minAgree'];

function checkVoteIntegrity(data, file) {
  const problems = [];
  if (!Array.isArray(data.groups) || data.groups.length === 0) {
    throw new Error(`${file}: "groups" must be a non-empty array of {key, label}`);
  }
  const keys = data.groups.map(g => g.key);
  if (new Set(keys).size !== keys.length) {
    throw new Error(`${file}: duplicate group key in [${keys.join(', ')}]`);
  }

  for (const r of data.records) {
    if (!r.vote) continue;
    const v = r.vote;
    const say = msg => problems.push(`${r.id}: ${msg}`);

    const has = Object.keys(v).filter(k => !VOTE_DERIVED.includes(k));
    const unknown = has.filter(k => !keys.includes(k));
    const missing = keys.filter(k => !v[k]);
    // Usually this means a statement was left behind by a recluster: its tallies were
    // computed over a group set the file no longer declares, and nothing can recompute
    // them, so naming both sets is the only useful thing to say.
    if (unknown.length || missing.length) {
      say(`vote has tallies for [${has.join(', ')}], but the declared groups are `
        + `[${keys.join(', ')}]`);
    }
  }

  // One bad group key trips every record, so cap the list — the first few say
  // what is wrong and the count says how far it spread.
  if (problems.length) {
    const SHOWN = 12;
    const shown = problems.slice(0, SHOWN);
    if (problems.length > SHOWN) shown.push(`… and ${problems.length - SHOWN} more`);
    throw new Error(`${file}: ${problems.length} vote inconsistency(ies):\n    `
      + shown.join('\n    '));
  }
}

const loadBloomData = () =>
  JSON.parse(fs.readFileSync(path.join(ROOT, 'data/bloom-data.json'), 'utf8'));

// bloom-insights' ids reference bloom-data records by id; a typo or a record
// getting renumbered/removed would otherwise fail silently at runtime (a
// dead carousel card, or — if it's the *only* id in an entry — a whole
// insight vanishing).
function checkInsightIdsResolve(insights, file, bloomData) {
  const knownIds = new Set(bloomData.records.map(r => r.id));
  const bad = [];
  for (const [theme, entries] of Object.entries(insights)) {
    if (theme.startsWith('_')) continue;
    entries.forEach(e => e.ids.forEach(id => { if (!knownIds.has(id)) bad.push(`${theme}: ${id}`); }));
  }
  if (bad.length) throw new Error(`${file}: id(s) not found in bloom-data.json: ${bad.join(', ')}`);
}

// group-info.json is a hand-maintained snapshot (participant counts, display color) keyed
// by group key, kept separate from bloom-data.json's own groups[] because refresh-poll.js
// deliberately never persists cluster sizes there (see its comment on why). A refresh that
// regroups — a different number of keys, or the same keys meaning different clusters — makes
// this file stale in a way nothing here can detect; it can only catch a key mismatch.
function checkGroupInfoKeys(info, file) {
  const bloomData = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/bloom-data.json'), 'utf8'));
  const groupKeys = bloomData.groups.map(g => g.key);
  const infoKeys = Object.keys(info).filter(k => !k.startsWith('_'));
  const missing = groupKeys.filter(k => !infoKeys.includes(k));
  const extra = infoKeys.filter(k => !groupKeys.includes(k));
  if (missing.length || extra.length) {
    console.warn(`  WARNING ${file}: out of sync with bloom-data.json's groups `
      + `[${groupKeys.join(', ')}]`
      + (missing.length ? ` — missing entries for [${missing.join(', ')}]` : '')
      + (extra.length ? `; stale entries for [${extra.join(', ')}] no longer in bloom-data.json` : ''));
  }
}

// group-statements.json's ids reference bloom-data records by id; a typo or a record
// getting renumbered/removed would otherwise fail silently at runtime (a dead defining-
// statement page). Cross-check against bloom-data.json directly since a BLOCKS 'check'
// only sees its own file's parsed data.
function checkGroupStatementIdsResolve(statements, file) {
  const bloomData = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/bloom-data.json'), 'utf8'));
  const knownIds = new Set(bloomData.records.map(r => r.id));
  const bad = [];
  for (const [group, entries] of Object.entries(statements)) {
    if (group.startsWith('_')) continue;
    entries.forEach(e => { if (!knownIds.has(e.id)) bad.push(`${group}: ${e.id}`); });
  }
  if (bad.length) console.warn(`  WARNING ${file}: id(s) not found in bloom-data.json: ${bad.join(', ')}`);
}

// consensus-statements.json's ids reference bloom-data records by id, same
// deal as group-statements.json's — a typo or a renumbered/removed record
// would otherwise fail silently at runtime (a Consensus card that never
// renders instead of an error at build time).
function checkConsensusIdsResolve(consensus, file) {
  const bloomData = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/bloom-data.json'), 'utf8'));
  const knownIds = new Set(bloomData.records.map(r => r.id));
  const bad = consensus.ids.filter(id => !knownIds.has(id));
  if (bad.length) console.warn(`  WARNING ${file}: id(s) not found in bloom-data.json: ${bad.join(', ')}`);
}

// participant-locations.json's per-city counts plus 'other' are meant to add up to
// 'total' (every row in the source CSV, mapped or not) — catches a hand-edit to one
// number that forgets the others, which the parse alone can't see.
function checkParticipantLocationTotals(loc, file) {
  const mapped = loc.cities.reduce((s, c) => s + c.count, 0) + loc.other;
  if (mapped !== loc.total) {
    console.warn(`  WARNING ${file}: cities[].count + other (${mapped}) does not equal `
      + `total (${loc.total})`);
  }
}

// demographics.json's per-category answered count can't exceed the shared total —
// catches a hand-edit to one category that forgets the file's total was for all of
// them, which the parse alone can't see.
function checkDemographicsAnswered(demo, file) {
  const bad = demo.categories.filter(c => c.answered > demo.total);
  if (bad.length) {
    console.warn(`  WARNING ${file}: categor(y/ies) with answered > total (${demo.total}): `
      + bad.map(c => `${c.key} (${c.answered})`).join(', '));
  }
}

// oregon-counties.json's three Central Oregon counties (Deschutes/Crook/Jefferson)
// are the Demographics map's home view — without them there's nothing to render on
// load, so a missing one throws rather than warns, unlike the softer full-count check
// below (a future Census source update changing the county count is surprising but
// not fatal to the tri-county view).
const DEMOG_HOME_FIPS = ['41017', '41013', '41031'];
function checkOregonCountiesShape(geo, file) {
  const ids = new Set(geo.features.map(f => f.id));
  const missing = DEMOG_HOME_FIPS.filter(id => !ids.has(id));
  if (missing.length) {
    throw new Error(`${file}: missing required Central Oregon FIPS id(s) [${missing.join(', ')}]`);
  }
  if (geo.features.length !== 36) {
    console.warn(`  WARNING ${file}: expected 36 Oregon counties, found ${geo.features.length}`);
  }
}

// Keep in sync with MIN_GROUP_VOTES in src/app.js — there is no module boundary
// between build.js and the app (app.js is inlined verbatim as a raw block), so the
// constant is duplicated on purpose rather than parsed back out of the source.
const MIN_GROUP_VOTES = 10;

// An insight is an editorial claim citing specific statements as its evidence. When
// a cited statement has a group too thin to report on, the app renders it "not enough
// data" — so the carousel illustrating the claim quietly declines to support it. The
// code can't tell whether the claim or the citation should change, so it names them
// and leaves it to the editorial pass. Runs after checkInsightIdsResolve, which has
// already established that every id resolves.
function checkInsightVoteDepth(insights, file, bloomData) {
  const keys = bloomData.groups.map(g => g.key);
  const byId = new Map(bloomData.records.map(r => [r.id, r]));
  const thin = [];
  for (const [theme, entries] of Object.entries(insights)) {
    if (theme.startsWith('_')) continue;
    entries.forEach(e => e.ids.forEach(id => {
      const r = byId.get(id);
      if (!r || !r.vote) return;   // quotes carry no vote data
      const ns = keys.map(k => r.vote[k].n);
      if (Math.min(...ns) < MIN_GROUP_VOTES) thin.push(`${theme}: ${id} (groups ${ns.join('/')})`);
    }));
  }
  if (thin.length) {
    console.warn(`  WARNING ${file}: ${thin.length} insight-cited statement(s) have a group `
      + `under ${MIN_GROUP_VOTES} votes and will render as "not enough data":\n    `
      + thin.join('\n    '));
  }
}

// Placeholder id -> { file, kind }. Every id needs a matching <!--INJECT:{id}-->
// in index.template.html; for 'json' blocks the id is also the <script> element id
// the app reads the data back out of.
//
//   json — parsed (so a syntax error fails the build), then re-serialized minified
//   raw  — inlined verbatim at the placeholder; for app-css/app-js/d3-vendor that's
//          inside the <style>/<script> tag the template wraps them in
//
// An optional 'check' runs against the parsed JSON for invariants the parse can't see;
// it may warn (and let the build through) or throw.
const BLOCKS = {
  'app-css': { file: 'src/app.css', kind: 'raw' },
  'd3-vendor': { file: 'vendor/d3-custom.min.js', kind: 'raw' },
  'theme-descriptions': { file: 'data/theme-descriptions.json', kind: 'json' },
  'bloom-data': {
    file: 'data/bloom-data.json',
    kind: 'json',
    check: (data, file) => { checkEveryRecordReachable(data, file); checkVoteIntegrity(data, file); },
  },
  'bloom-insights': {
    file: 'data/bloom-insights.json',
    kind: 'json',
    check: (insights, file) => {
      const bloomData = loadBloomData();
      checkInsightIdsResolve(insights, file, bloomData);
      checkInsightVoteDepth(insights, file, bloomData);
    },
  },
  'group-info': { file: 'data/group-info.json', kind: 'json', check: checkGroupInfoKeys },
  'group-statements': { file: 'data/group-statements.json', kind: 'json', check: checkGroupStatementIdsResolve },
  'consensus-statements': { file: 'data/consensus-statements.json', kind: 'json', check: checkConsensusIdsResolve },
  'participant-locations': {
    file: 'data/participant-locations.json',
    kind: 'json',
    check: checkParticipantLocationTotals,
  },
  'oregon-counties': {
    file: 'data/oregon-counties.json',
    kind: 'json',
    check: checkOregonCountiesShape,
  },
  'demographics': {
    file: 'data/demographics.json',
    kind: 'json',
    check: checkDemographicsAnswered,
  },
  'app-js': { file: 'src/app.js', kind: 'raw' },
};

// JSON destined for an inline <script> must not contain a literal '<', or a
// "</script>" inside any string value would close the tag early. Rewriting it as
// a \u003c escape is still valid JSON and parses back to the same string.
const escapeJsonForScriptTag = json => json.replace(/</g, '\\u003c');

// Source destined for an inline <style>/<script> can't take the same blanket
// treatment — '<' is meaningful in JS ("a < b"). Only the exact byte sequence
// that closes the tag needs neutralizing, and the backslash is inert everywhere
// it can legally appear in JS or CSS: inside a string "<\/script" is still
// "</script", and in a regex or comment it reads the same either way. Anywhere
// else in the grammar those characters aren't valid to begin with.
const escapeSourceForTag = src => src.replace(/<\/(script|style)/gi, '<\\/$1');

function readSource(relPath) {
  const abs = path.join(ROOT, relPath);
  try {
    return fs.readFileSync(abs, 'utf8');
  } catch (err) {
    throw new Error(`cannot read ${relPath}: ${err.message}`);
  }
}

function renderBlock({ file, kind, check }) {
  const raw = readSource(file);
  // The placeholder sits on its own line between the open and close tags, so the
  // source file's own trailing newline would double up. Drop it; the files keep it.
  if (kind === 'raw') return escapeSourceForTag(raw.replace(/\n$/, ''));
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${err.message}`);
  }
  if (check) check(data, file);
  // No indent argument to stringify — that is the minification.
  return escapeJsonForScriptTag(JSON.stringify(data));
}

function build() {
  let html = fs.readFileSync(TEMPLATE, 'utf8');

  for (const [id, block] of Object.entries(BLOCKS)) {
    const placeholder = `<!--INJECT:${id}-->`;
    if (!html.includes(placeholder)) {
      throw new Error(`${placeholder} not found in index.template.html`);
    }
    const content = renderBlock(block);
    html = html.replace(placeholder, () => content);
    console.log(`  ${block.file} -> #${id} (${content.length} bytes)`);
  }

  const leftover = html.match(/<!--INJECT:[^>]*-->/);
  if (leftover) throw new Error(`unreplaced placeholder ${leftover[0]}`);

  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(DIST, { recursive: true });
  fs.writeFileSync(OUTPUT, html);
  fs.cpSync(path.join(ROOT, 'static'), path.join(DIST, 'static'), { recursive: true });
  // Belt and braces: dist/ is published via the Actions artifact, which does not
  // run Jekyll, but this keeps the output correct if the source ever changes back.
  fs.writeFileSync(path.join(DIST, '.nojekyll'), '');

  console.log(`built dist/index.html (${Buffer.byteLength(html)} bytes)`);
}

try {
  build();
} catch (err) {
  console.error(`build failed: ${err.message}`);
  process.exit(1);
}
