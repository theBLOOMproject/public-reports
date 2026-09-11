// data/config.json is the registry of reports: which exist, whether each is published,
// which Polis workflow step its poll lives at, and — for a report that pulls them from
// comhairle — which conversation and workflow its demographics come from. The build and
// the pipeline scripts both read it through here, so it is validated in one place.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const REPORTS = path.join(ROOT, 'data');
const CONFIG = path.join(REPORTS, 'config.json');
// The slug is a URL path segment, so it is held to characters that never need encoding.
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function loadConfig() {
  const file = path.relative(ROOT, CONFIG);
  let config;
  try {
    config = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  } catch (err) {
    throw new Error(`cannot read ${file}: ${err.message}`);
  }
  const reports = config && config.reports;
  if (!reports || typeof reports !== 'object' || Array.isArray(reports)) {
    throw new Error(`${file}: "reports" must be an object keyed by slug`);
  }

  const problems = [];
  for (const [slug, report] of Object.entries(reports)) {
    const say = msg => problems.push(`${slug}: ${msg}`);
    if (!report || typeof report !== 'object' || Array.isArray(report)) {
      say('must be an object');
      continue;
    }
    if (!SLUG.test(slug)) {
      say('a slug is its URL path, so it must be lowercase letters, digits and single hyphens');
    }
    if (!fs.existsSync(path.join(REPORTS, slug, 'report.json'))) {
      say(`no data/${slug}/report.json`);
    }
    if (typeof report.published !== 'boolean') say('"published" must be true or false');
    if (report.polis !== undefined) {
      const step = report.polis && report.polis.workflowStepId;
      if (typeof step !== 'string' || !UUID.test(step)) {
        say('"polis.workflowStepId" must be a workflow step uuid');
      }
    }
    if (report.demographics !== undefined) {
      for (const k of ['conversationId', 'workflowId']) {
        const id = report.demographics && report.demographics[k];
        if (typeof id !== 'string' || !UUID.test(id)) say(`"demographics.${k}" must be a uuid`);
      }
    }
  }
  if (!Object.keys(reports).length) problems.push('no reports listed');
  if (problems.length) throw new Error(`${file}:\n    ${problems.join('\n    ')}`);
  return config;
}

function stepIdFor(config, slug) {
  const report = config.reports[slug];
  if (!report) {
    throw new Error(`no report "${slug}" in ${path.relative(ROOT, CONFIG)}. `
      + `Reports: ${Object.keys(config.reports).join(', ')}`);
  }
  if (!report.polis) {
    throw new Error(`report "${slug}" has no polis.workflowStepId in ${path.relative(ROOT, CONFIG)}`);
  }
  return report.polis.workflowStepId;
}

// Where comhairle's participation report for this report's poll lives, or null for a
// report whose demographics aren't pulled from comhairle.
function demographicsFor(config, slug) {
  const report = config.reports[slug];
  const d = report && report.demographics;
  return d ? { conversationId: d.conversationId, workflowId: d.workflowId } : null;
}

module.exports = { ROOT, REPORTS, loadConfig, stepIdFor, demographicsFor };
