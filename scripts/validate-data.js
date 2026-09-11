#!/usr/bin/env node
// Runs the data checks over reports without building them — for checking a hand edit.
//
//   node scripts/validate-data.js               every report in data/config.json
//   node scripts/validate-data.js utah-ai       just the ones named
//   node scripts/validate-data.js --published   only those marked published
const { loadConfig } = require('./lib/config');
const { validateReport } = require('./lib/validate-data');

const USAGE = `
Checks reports' data files for problems parsing alone can't see: statement ids that
don't resolve, vote tallies that don't match the declared groups, demographics labels
with no population share, and the like. The same checks run on every build and before
every merge.

  node scripts/validate-data.js [<slug>…] [options]

  <slug>          Reports to check: keys of data/config.json. Default: all of them.

Options
  --published     Only reports marked published — what the deploy builds.
  -h, --help      Show this.

Exits 1 if any report has an error. Warnings are printed but don't fail.
`.trim();

function parseArgs(argv) {
  const args = { slugs: [], publishedOnly: false, help: false };
  for (const a of argv) {
    if (a === '-h' || a === '--help') args.help = true;
    else if (a === '--published') args.publishedOnly = true;
    else if (a.startsWith('-')) throw new Error(`unknown option ${a}\n\n${USAGE}`);
    else args.slugs.push(a);
  }
  return args;
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
  } else {
    const { reports } = loadConfig();
    const unknown = args.slugs.filter(s => !reports[s]);
    if (unknown.length) {
      throw new Error(`no report [${unknown.join(', ')}] in data/config.json. `
        + `Reports: ${Object.keys(reports).join(', ')}`);
    }
    const slugs = (args.slugs.length ? args.slugs : Object.keys(reports).sort())
      .filter(slug => !args.publishedOnly || reports[slug].published);

    let failed = false;
    for (const slug of slugs) {
      let result;
      try {
        result = validateReport(slug);
      } catch (err) {
        result = { errors: [err.message], warnings: [] };
      }
      const { errors, warnings } = result;
      console.log(`${slug}: ${errors.length ? 'FAILED' : 'ok'}`
        + (warnings.length ? ` (${warnings.length} warning(s))` : ''));
      for (const e of errors) console.log(`  ERROR ${e}`);
      for (const w of warnings) console.log(`  WARNING ${w}`);
      if (errors.length) failed = true;
    }
    if (failed) process.exit(1);
  }
} catch (err) {
  console.error(`validate failed: ${err.message}`);
  process.exit(1);
}
