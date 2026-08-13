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

// Placeholder id -> { file, kind }. Every id needs a matching <!--INJECT:{id}-->
// in index.template.html; for 'json' blocks the id is also the <script> element id
// the app reads the data back out of.
//
//   json — parsed (so a syntax error fails the build), then re-serialized minified
//   raw  — inlined verbatim into the <style> / <script> tag that wraps it
const BLOCKS = {
  'app-css': { file: 'src/app.css', kind: 'raw' },
  'theme-descriptions': { file: 'data/theme-descriptions.json', kind: 'json' },
  'bloom-data': { file: 'data/bloom-data.json', kind: 'json' },
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

function renderBlock({ file, kind }) {
  const raw = readSource(file);
  // The placeholder sits on its own line between the open and close tags, so the
  // source file's own trailing newline would double up. Drop it; the files keep it.
  if (kind === 'raw') return escapeSourceForTag(raw.replace(/\n$/, ''));
  try {
    // No indent argument to stringify — that is the minification.
    return escapeJsonForScriptTag(JSON.stringify(JSON.parse(raw)));
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${err.message}`);
  }
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
