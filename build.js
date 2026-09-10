#!/usr/bin/env node
// Builds the deployable site into dist/.
//
//   node build.js
//
// Every directory under data/ is one report, and its name is the report's slug — the URL
// path it publishes at. For each, fills the report's copy (its report.json) into
// index.template.html and inlines src/app.css, src/app.js and the report's JSON, producing
// a single self-contained dist/<slug>/index.html with the shared static/ and the report's
// own static/ copied alongside it. The dist/ root gets a redirect stub instead, since the
// published site's root belongs to the main Bloom site, not to any one report.
// dist/ is gitignored and rebuilt on every deploy; only what lands in dist/ is
// published, so repo sources stay out of the public site.
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const TEMPLATE = path.join(ROOT, 'index.template.html');
const REPORTS = path.join(ROOT, 'data');
const SHARED_STATIC = path.join(ROOT, 'static');
const DIST = path.join(ROOT, 'dist');
const SITE_ORIGIN = 'https://report.bloomproject.us';
const REDIRECT_TO = 'https://bloom-project.org/';
// The slug is a URL path segment, so it is held to characters that never need encoding.
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

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

// bloom-insights' ids reference bloom-data records by id; a typo or a record
// getting renumbered/removed would otherwise fail silently at runtime (a
// dead carousel card, or — if it's the *only* id in an entry — a whole
// insight vanishing).
function checkInsightIdsResolve(insights, file, bloomData) {
  const knownIds = new Set(bloomData.records.map(r => r.id));
  const bad = [];
  for (const [theme, entries] of Object.entries(insights)) {
    entries.forEach(e => e.ids.forEach(id => { if (!knownIds.has(id)) bad.push(`${theme}: ${id}`); }));
  }
  if (bad.length) throw new Error(`${file}: id(s) not found in bloom-data.json: ${bad.join(', ')}`);
}

// group-info.json is a hand-maintained snapshot (participant counts, display color) keyed
// by group key, kept separate from bloom-data.json's own groups[] because refresh-poll.js
// deliberately never persists cluster sizes there (see its comment on why). A refresh that
// regroups — a different number of keys, or the same keys meaning different clusters — makes
// this file stale in a way nothing here can detect; it can only catch a key mismatch.
function checkGroupInfoKeys(info, file, { bloomData }) {
  const groupKeys = bloomData.groups.map(g => g.key);
  const infoKeys = Object.keys(info);
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
// statement page).
function checkGroupStatementIdsResolve(statements, file, { bloomData }) {
  const knownIds = new Set(bloomData.records.map(r => r.id));
  const bad = [];
  for (const [group, entries] of Object.entries(statements)) {
    entries.forEach(e => { if (!knownIds.has(e.id)) bad.push(`${group}: ${e.id}`); });
  }
  if (bad.length) console.warn(`  WARNING ${file}: id(s) not found in bloom-data.json: ${bad.join(', ')}`);
}

// consensus-statements.json's ids reference bloom-data records by id, same
// deal as group-statements.json's — a typo or a renumbered/removed record
// would otherwise fail silently at runtime (a Consensus card that never
// renders instead of an error at build time).
function checkConsensusIdsResolve(consensus, file, { bloomData }) {
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

// counties.json's home counties (report.json's map.homeCounties) are the Demographics
// map's home view — without them there's nothing to render on load, so a missing one
// throws rather than warns.
function checkCountiesShape(geo, file, { slug, report }) {
  const home = report.map && report.map.homeCounties;
  if (!home || !Object.keys(home).length) {
    throw new Error(`data/${slug}/report.json: map.homeCounties must map at least one `
      + 'county FIPS id to its name');
  }
  const ids = new Set(geo.features.map(f => f.id));
  const missing = Object.keys(home).filter(id => !ids.has(id));
  if (missing.length) {
    throw new Error(`${file}: missing home county FIPS id(s) [${missing.join(', ')}] `
      + 'named in report.json');
  }
}

// Keep in sync with MIN_GROUP_VOTES in src/app.js — there is no module boundary
// between build.js and the app (app.js is inlined verbatim as a raw block), so the
// constant is duplicated on purpose rather than parsed back out of the source.
const MIN_GROUP_VOTES = 8;

// An insight is an editorial claim citing specific statements as its evidence. When
// a cited statement has a group too thin to report on, the app flags that group's
// %-agree number with a low-data marker — so the carousel illustrating the claim
// quietly leans on a thin group. The code can't tell whether the claim or the
// citation should change, so it names them and leaves it to the editorial pass. Runs
// after checkInsightIdsResolve, which has already established that every id resolves.
function checkInsightVoteDepth(insights, file, bloomData) {
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
    console.warn(`  WARNING ${file}: ${thin.length} insight-cited statement(s) have a group `
      + `under ${MIN_GROUP_VOTES} votes and will show a low-data flag:\n    `
      + thin.join('\n    '));
  }
}

// Placeholder id -> { file, kind }. Every id needs a matching <!--INJECT:{id}-->
// in index.template.html; for 'json' blocks the id is also the <script> element id
// the app reads the data back out of.
//
//   json — a file in the report's own data/<slug>/, parsed (so a syntax error fails
//          the build), then re-serialized minified
//   raw  — a repo-relative source inlined verbatim at the placeholder; for
//          app-css/app-js/d3-vendor that's inside the <style>/<script> tag the
//          template wraps them in
//
// An optional 'check' runs against the parsed JSON for invariants the parse can't see,
// given the report's { slug, report, bloomData }; it may warn (and let the build
// through) or throw.
const BLOCKS = {
  'app-css': { file: 'src/app.css', kind: 'raw' },
  'd3-vendor': { file: 'vendor/d3-custom.min.js', kind: 'raw' },
  'theme-descriptions': { file: 'theme-descriptions.json', kind: 'json' },
  'bloom-data': {
    file: 'bloom-data.json',
    kind: 'json',
    check: (data, file) => { checkEveryRecordReachable(data, file); checkVoteIntegrity(data, file); },
  },
  'bloom-insights': {
    file: 'bloom-insights.json',
    kind: 'json',
    check: (insights, file, { bloomData }) => {
      checkInsightIdsResolve(insights, file, bloomData);
      checkInsightVoteDepth(insights, file, bloomData);
    },
  },
  'group-info': { file: 'group-info.json', kind: 'json', check: checkGroupInfoKeys },
  'group-statements': { file: 'group-statements.json', kind: 'json', check: checkGroupStatementIdsResolve },
  'consensus-statements': { file: 'consensus-statements.json', kind: 'json', check: checkConsensusIdsResolve },
  'participant-locations': {
    file: 'participant-locations.json',
    kind: 'json',
    check: checkParticipantLocationTotals,
  },
  'counties': {
    file: 'counties.json',
    kind: 'json',
    check: checkCountiesShape,
  },
  'demographics': {
    file: 'demographics.json',
    kind: 'json',
    check: checkDemographicsAnswered,
  },
  'app-js': { file: 'src/app.js', kind: 'raw' },
};

// report.json leaves under these prefixes are read by src/app.js rather than placed in
// the template, so no placeholder is expected to use them.
const READ_BY_APP = ['map.'];

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

// Enough for element text and the template's double-quoted attributes alike.
const escapeHtml = s => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function readSource(abs) {
  try {
    return fs.readFileSync(abs, 'utf8');
  } catch (err) {
    throw new Error(`cannot read ${path.relative(ROOT, abs)}: ${err.message}`);
  }
}

function readJson(abs) {
  const raw = readSource(abs);
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`${path.relative(ROOT, abs)} is not valid JSON: ${err.message}`);
  }
}

function renderBlock({ file, kind, check }, ctx) {
  // The placeholder sits on its own line between the open and close tags, so the
  // source file's own trailing newline would double up. Drop it; the files keep it.
  if (kind === 'raw') return escapeSourceForTag(readSource(path.join(ROOT, file)).replace(/\n$/, ''));
  const abs = path.join(ctx.dir, file);
  const data = readJson(abs);
  if (check) check(data, path.relative(ROOT, abs), ctx);
  // No indent argument to stringify — that is the minification.
  return escapeJsonForScriptTag(JSON.stringify(data));
}

const leafPaths = (obj, prefix = '') => Object.entries(obj).flatMap(([k, v]) =>
  v && typeof v === 'object' ? leafPaths(v, `${prefix}${k}.`) : [`${prefix}${k}`]);

// The report's copy lands in the template at {{dotted.path}} placeholders into
// report.json, plus the build's own derived slug and shareUrl. Values are HTML-escaped,
// except under a key ending in "Html", which goes in verbatim so the copy can carry
// inline markup — safe only because report.json is editorial and checked in. This runs
// before any block is injected, so a "{{" inside app code or data is never taken for a
// placeholder.
function substituteCopy(template, report, derived, file) {
  const copy = { ...report, ...derived };
  const used = new Set();
  const html = template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
    const value = key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), copy);
    if (typeof value !== 'string' && typeof value !== 'number') {
      throw new Error(`${file}: index.template.html uses {{${key}}}, which is not a string here`);
    }
    used.add(key);
    return key.endsWith('Html') ? String(value) : escapeHtml(value);
  });
  const unused = leafPaths(report)
    .filter(k => !used.has(k) && !READ_BY_APP.some(prefix => k.startsWith(prefix)));
  if (unused.length) {
    console.warn(`  WARNING ${file}: not used by index.template.html: ${unused.join(', ')}`);
  }
  return html;
}

function listReports() {
  const slugs = fs.readdirSync(REPORTS, { withFileTypes: true })
    .filter(d => d.isDirectory()).map(d => d.name).sort();
  if (!slugs.length) throw new Error('data/ has no report directories');
  for (const slug of slugs) {
    if (!SLUG.test(slug)) {
      throw new Error(`data/${slug}: a report directory's name is its URL slug, so it must be `
        + 'lowercase letters, digits and single hyphens');
    }
    if (!fs.existsSync(path.join(REPORTS, slug, 'report.json'))) {
      throw new Error(`data/${slug}: no report.json — every directory in data/ is built as a report`);
    }
  }
  return slugs;
}

// A report's static/ is merged into a copy of the shared one, so a name in both would
// have one silently overwrite the other.
function checkStaticClash(slug) {
  const own = path.join(REPORTS, slug, 'static');
  if (!fs.existsSync(own)) return;
  const clash = fs.readdirSync(own).filter(name => fs.existsSync(path.join(SHARED_STATIC, name)));
  if (clash.length) {
    throw new Error(`data/${slug}/static/: [${clash.join(', ')}] also in the shared static/`);
  }
}

function buildReport(template, slug) {
  const dir = path.join(REPORTS, slug);
  const reportFile = path.join(dir, 'report.json');
  const report = readJson(reportFile);
  const derived = { slug, shareUrl: `${SITE_ORIGIN}/${slug}` };
  const ctx = { slug, dir, report, bloomData: readJson(path.join(dir, 'bloom-data.json')) };

  console.log(`${slug}:`);
  checkStaticClash(slug);
  let html = substituteCopy(template, report, derived, path.relative(ROOT, reportFile));

  const inject = (id, content, label) => {
    const placeholder = `<!--INJECT:${id}-->`;
    if (!html.includes(placeholder)) {
      throw new Error(`${placeholder} not found in index.template.html`);
    }
    html = html.replace(placeholder, () => content);
    console.log(`  ${label} -> #${id} (${content.length} bytes)`);
  };
  inject('report', escapeJsonForScriptTag(JSON.stringify({ ...report, ...derived })),
    path.relative(ROOT, reportFile));
  for (const [id, block] of Object.entries(BLOCKS)) {
    const label = block.kind === 'raw' ? block.file : path.relative(ROOT, path.join(dir, block.file));
    inject(id, renderBlock(block, ctx), label);
  }

  const leftover = html.match(/<!--INJECT:[^>]*-->/);
  if (leftover) throw new Error(`unreplaced placeholder ${leftover[0]}`);
  return html;
}

// Pages serves static files only — it cannot issue a 301 — so the site root and every
// unmatched path get this stub instead. location.replace rather than an href assignment:
// it leaves no history entry, so Back does not land the visitor right back on the redirect.
function redirectStub() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Bloom Project</title>
<meta name="robots" content="noindex">
<link rel="canonical" href="${REDIRECT_TO}">
<meta http-equiv="refresh" content="0; url=${REDIRECT_TO}">
<script>location.replace(${JSON.stringify(REDIRECT_TO)});</script>
</head>
<body><p>Redirecting to <a href="${REDIRECT_TO}">bloom-project.org</a>.</p></body>
</html>
`;
}

function build() {
  const template = fs.readFileSync(TEMPLATE, 'utf8');
  // Every report is rendered and checked before dist/ is touched, so one bad report
  // fails the build without leaving a half-written dist/ behind.
  const built = listReports().map(slug => ({ slug, html: buildReport(template, slug) }));

  fs.rmSync(DIST, { recursive: true, force: true });
  for (const { slug, html } of built) {
    const siteDir = path.join(DIST, slug);
    fs.mkdirSync(siteDir, { recursive: true });
    fs.writeFileSync(path.join(siteDir, 'index.html'), html);
    fs.cpSync(SHARED_STATIC, path.join(siteDir, 'static'), { recursive: true });
    const own = path.join(REPORTS, slug, 'static');
    if (fs.existsSync(own)) fs.cpSync(own, path.join(siteDir, 'static'), { recursive: true });
  }
  // Belt and braces: dist/ is published via the Actions artifact, which does not
  // run Jekyll, but this keeps the output correct if the source ever changes back.
  fs.writeFileSync(path.join(DIST, '.nojekyll'), '');

  const stub = redirectStub();
  fs.writeFileSync(path.join(DIST, 'index.html'), stub);
  fs.writeFileSync(path.join(DIST, '404.html'), stub);

  for (const { slug, html } of built) {
    console.log(`built dist/${slug}/index.html (${Buffer.byteLength(html)} bytes)`);
  }
  console.log(`  dist/{index,404}.html -> ${REDIRECT_TO}`);
}

try {
  build();
} catch (err) {
  console.error(`build failed: ${err.message}`);
  process.exit(1);
}
