#!/usr/bin/env node
// Builds the deployable site into dist/.
//
//   node build.js
//
// Injects data/*.json into index.template.html to produce dist/index.html, and
// copies the static assets alongside it. dist/ is gitignored and rebuilt on
// every deploy; only what lands in dist/ is published, so repo sources stay
// out of the public site.
//
// Edit index.template.html for app changes and data/*.json for data changes.

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const TEMPLATE = path.join(ROOT, 'index.template.html');
const DIST = path.join(ROOT, 'dist');
const OUTPUT = path.join(DIST, 'index.html');

// Placeholder id -> source file. Ids match the <script> element ids in the template.
const BLOCKS = {
  'theme-descriptions': 'data/theme-descriptions.json',
  'bloom-data': 'data/bloom-data.json',
};

// JSON destined for an inline <script> must not contain a literal '<', or a
// "</script>" inside any string value would close the tag early. Escaping it as
// < is still valid JSON and parses back to the same string.
const escapeForScriptTag = json => json.replace(/</g, '\\u003c');

function readJson(relPath) {
  const abs = path.join(ROOT, relPath);
  let raw;
  try {
    raw = fs.readFileSync(abs, 'utf8');
  } catch (err) {
    throw new Error(`cannot read ${relPath}: ${err.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`${relPath} is not valid JSON: ${err.message}`);
  }
}

function build() {
  let html = fs.readFileSync(TEMPLATE, 'utf8');

  for (const [id, relPath] of Object.entries(BLOCKS)) {
    const placeholder = `<!--INJECT:${id}-->`;
    if (!html.includes(placeholder)) {
      throw new Error(`${placeholder} not found in index.template.html`);
    }
    // No indent argument to stringify — that is the minification.
    const minified = escapeForScriptTag(JSON.stringify(readJson(relPath)));
    html = html.replace(placeholder, () => minified);
    console.log(`  ${relPath} -> #${id} (${minified.length} bytes)`);
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
