#!/usr/bin/env node
// Builds the deployable site into dist/.
//
//   node build.js               every report in data/config.json
//   node build.js --published   only those marked published — what the deploy builds
//
// Each report lives in data/<slug>/, and its slug is the URL path it publishes at. For
// each, fills the report's copy (its report.json) into
// index.template.html and inlines src/app.css, src/app.js and the report's JSON, producing
// a single self-contained dist/<slug>/index.html with the shared static/ and the report's
// own static/ copied alongside it. The dist/ root gets a redirect stub instead, since the
// published site's root belongs to the main Bloom site, not to any one report.
// dist/ is gitignored and rebuilt on every deploy; only what lands in dist/ is
// published, so repo sources stay out of the public site.
//
// Every report's data is checked first (scripts/lib/validate-data.js): warnings are
// printed, and any error fails the build.
const fs = require('fs');
const path = require('path');
const { loadConfig } = require('./scripts/lib/config');
const { validateReport } = require('./scripts/lib/validate-data');

const ROOT = __dirname;
const TEMPLATE = path.join(ROOT, 'index.template.html');
const REPORTS = path.join(ROOT, 'data');
const SHARED_STATIC = path.join(ROOT, 'static');
const DIST = path.join(ROOT, 'dist');
const SITE_ORIGIN = 'https://report.bloomproject.us';
const REDIRECT_TO = 'https://bloom-project.org/';

// Placeholder id -> { file, kind }. Every id needs a matching <!--INJECT:{id}-->
// in index.template.html; for 'json' blocks the id is also the <script> element id
// the app reads the data back out of.
//
//   json — a file in the report's own data/<slug>/, parsed (so a syntax error fails
//          the build), then re-serialized minified
//   raw  — a repo-relative source inlined verbatim at the placeholder; for
//          app-css/app-js/d3-vendor that's inside the <style>/<script> tag the
//          template wraps them in
const BLOCKS = {
  'app-css': { file: 'src/app.css', kind: 'raw' },
  'd3-vendor': { file: 'vendor/d3-custom.min.js', kind: 'raw' },
  'theme-descriptions': { file: 'theme-descriptions.json', kind: 'json' },
  'bloom-data': { file: 'bloom-data.json', kind: 'json' },
  'bloom-insights': { file: 'bloom-insights.json', kind: 'json' },
  'group-info': { file: 'group-info.json', kind: 'json' },
  'group-statements': { file: 'group-statements.json', kind: 'json' },
  'consensus-statements': { file: 'consensus-statements.json', kind: 'json' },
  'participant-locations': { file: 'participant-locations.json', kind: 'json' },
  'counties': { file: 'counties.json', kind: 'json' },
  'demographics': { file: 'demographics.json', kind: 'json' },
  'app-js': { file: 'src/app.js', kind: 'raw' },
};

// report.json leaves under these prefixes are read by src/app.js rather than placed in
// the template, so no placeholder is expected to use them.
const READ_BY_APP = ['map.'];

// JSON destined for an inline <script> must not contain a literal '<', or a
// "</script>" inside any string value would close the tag early. Rewriting it as
// a < escape is still valid JSON and parses back to the same string.
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

function renderBlock({ file, kind }, dir) {
  // The placeholder sits on its own line between the open and close tags, so the
  // source file's own trailing newline would double up. Drop it; the files keep it.
  if (kind === 'raw') return escapeSourceForTag(readSource(path.join(ROOT, file)).replace(/\n$/, ''));
  const data = readJson(path.join(dir, file));
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

function listReports({ publishedOnly }) {
  const { reports } = loadConfig();
  const unlisted = fs.readdirSync(REPORTS, { withFileTypes: true })
    .filter(d => d.isDirectory() && !reports[d.name]).map(d => d.name);
  if (unlisted.length) {
    console.warn(`WARNING data/config.json does not list [${unlisted.join(', ')}] — not built`);
  }
  const slugs = Object.keys(reports).filter(slug => !publishedOnly || reports[slug].published).sort();
  if (!slugs.length) {
    throw new Error(`data/config.json lists no ${publishedOnly ? 'published ' : ''}reports`);
  }
  return slugs;
}

function parseArgs(argv) {
  const args = { publishedOnly: false };
  for (const a of argv) {
    if (a === '--published') args.publishedOnly = true;
    else throw new Error(`unknown argument ${a} — the only option is --published`);
  }
  return args;
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

function checkData(slug) {
  const { errors, warnings } = validateReport(slug);
  for (const w of warnings) console.warn(`  WARNING ${w}`);
  if (errors.length) {
    throw new Error(`data/${slug} has ${errors.length} error(s):\n  ${errors.join('\n  ')}`);
  }
}

function buildReport(template, slug) {
  const dir = path.join(REPORTS, slug);
  const reportFile = path.join(dir, 'report.json');
  const report = readJson(reportFile);
  const derived = { slug, shareUrl: `${SITE_ORIGIN}/${slug}` };

  console.log(`${slug}:`);
  checkStaticClash(slug);
  checkData(slug);
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
    inject(id, renderBlock(block, dir), label);
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

function build(args) {
  const template = fs.readFileSync(TEMPLATE, 'utf8');
  // Every report is rendered and checked before dist/ is touched, so one bad report
  // fails the build without leaving a half-written dist/ behind.
  const built = listReports(args).map(slug => ({ slug, html: buildReport(template, slug) }));

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
  build(parseArgs(process.argv.slice(2)));
} catch (err) {
  console.error(`build failed: ${err.message}`);
  process.exit(1);
}
