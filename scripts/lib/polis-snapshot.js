// A snapshot is one fetch of comhairle's GET /tools/polis/report_data — plus, for a report
// configured for it, the poll's participation report (see participation-report.js) —
// saved as the raw layer everything downstream is built from:
//
//   { "source": { api, workflowStepId, fetchedAt, participationReport?: { conversationId, workflowId } },
//     "reportData": { comments, groups, … },
//     "participationReport"?: { totalParticipants, ageRanges, … } }
//
// It is validated when it is written and again whenever it is read, so a snapshot that
// reaches a later stage is known to be well-formed, whether or not it was edited by hand
// in between.
const fs = require('fs');
const path = require('path');
const { REPORTS } = require('./config');
const { validateParticipationReport } = require('./participation-report');

const snapshotsDir = slug => path.join(REPORTS, slug, 'polis-snapshots');

// The report names Polis groups A, B, C… by id.
const MAX_GROUPS = 26;

// The stamp is fetchedAt as ISO with ':' and '.' made filename-safe, so the names sort
// as text in fetch order.
const snapshotFileName = fetchedAt => `report-data-${fetchedAt.replace(/[:.]/g, '-')}.json`;
const SNAPSHOT_FILE = /^report-data-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z\.json$/;

function latestSnapshot(slug) {
  const dir = snapshotsDir(slug);
  const names = fs.existsSync(dir) ? fs.readdirSync(dir).filter(n => SNAPSHOT_FILE.test(n)).sort() : [];
  return names.length ? path.join(dir, names[names.length - 1]) : null;
}

const isObject = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const isCount = n => Number.isInteger(n) && n >= 0;
const isText = s => typeof s === 'string' && s.trim() !== '';
const isNumberOrNull = x => x === null || (typeof x === 'number' && Number.isFinite(x));

// Who is in which group, and where each participant sits on the opinion map. Nothing
// downstream uses it, and snapshots are committed to a public repo, so it is not kept.
// Everything else passes through untouched, including fields comhairle adds later.
function stripParticipantData(response) {
  if (!isObject(response)) return response;
  const { participants, ...rest } = response;
  if (Array.isArray(rest.groups)) {
    rest.groups = rest.groups.map(g => {
      if (!isObject(g)) return g;
      const { members, ...group } = g;
      return group;
    });
  }
  return rest;
}

function validateSnapshot(snapshot) {
  if (!isObject(snapshot)) return ['not a JSON object'];
  if (!('source' in snapshot) && !('reportData' in snapshot) && Array.isArray(snapshot.comments)) {
    return ['this is an older, trimmed snapshot with no record of where it came from — '
      + 'fetch a fresh one with scripts/fetch-snapshot.js'];
  }

  const problems = [];
  const { source, reportData } = snapshot;
  if (!isObject(source)) {
    problems.push('no "source" block saying where and when this was fetched');
  } else {
    for (const k of ['api', 'workflowStepId', 'fetchedAt']) {
      if (!isText(source[k])) problems.push(`source.${k} is missing`);
    }
  }
  if ('participationReport' in snapshot) {
    const ids = isObject(source) && source.participationReport;
    if (!isObject(ids) || !isText(ids.conversationId) || !isText(ids.workflowId)) {
      problems.push('source.participationReport must say which conversationId and workflowId it came from');
    }
    problems.push(...validateParticipationReport(snapshot.participationReport));
  }
  if (!isObject(reportData)) {
    problems.push('no "reportData" object');
    return problems;
  }

  const groups = Array.isArray(reportData.groups) ? reportData.groups : [];
  const comments = Array.isArray(reportData.comments) ? reportData.comments : [];
  if (!groups.length) {
    problems.push('"groups" must be a non-empty array — has Polis clustered this conversation yet?');
  }
  if (!comments.length) problems.push('"comments" must be a non-empty array');

  const groupIds = new Set();
  groups.forEach((g, i) => {
    if (!isObject(g)) return problems.push(`groups[${i}]: not an object`);
    const at = `group ${JSON.stringify(g.group_id)}`;
    if (!isCount(g.group_id)) problems.push(`groups[${i}]: group_id is not a non-negative integer`);
    else if (groupIds.has(g.group_id)) problems.push(`${at}: duplicate group_id`);
    else groupIds.add(g.group_id);
    if (!Number.isInteger(g.total_members) || g.total_members < 1) {
      problems.push(`${at}: total_members ${JSON.stringify(g.total_members)} is not a positive integer`);
    }
    if (!Array.isArray(g.representative_comments)) {
      problems.push(`${at}: representative_comments is not an array`);
    }
  });
  if (groups.length > MAX_GROUPS) {
    problems.push(`${groups.length} groups — the report can only name ${MAX_GROUPS} (A–Z)`);
  }
  const ids = [...groupIds].sort((a, b) => a - b);
  if (ids.some((id, i) => id !== i)) {
    problems.push(`group_ids [${ids.join(', ')}] should run 0..${ids.length - 1} with no gaps`);
  }

  const counts = (v, at) => {
    if (!isObject(v)) return problems.push(`${at}: missing`);
    for (const k of ['agrees', 'disagrees', 'passes']) {
      if (!isCount(v[k])) problems.push(`${at}: ${k} ${JSON.stringify(v[k])} is not a count`);
    }
  };
  const tids = new Set();
  comments.forEach((c, i) => {
    if (!isObject(c)) return problems.push(`comments[${i}]: not an object`);
    const at = isCount(c.tid) ? `tid ${c.tid}` : `comments[${i}]`;
    if (!isCount(c.tid)) problems.push(`${at}: tid is not a non-negative integer`);
    else if (tids.has(c.tid)) problems.push(`${at}: duplicate tid`);
    else tids.add(c.tid);
    if (!isText(c.text)) problems.push(`${at}: text is empty`);
    if (typeof c.is_seed !== 'boolean') problems.push(`${at}: is_seed is not true/false`);
    counts(c.overall_votes, `${at} overall_votes`);
    if (!Array.isArray(c.group_votes)) {
      problems.push(`${at}: group_votes is not an array`);
    } else {
      const voted = new Set();
      for (const gv of c.group_votes) {
        const gat = `${at} group_votes`;
        if (!isObject(gv)) { problems.push(`${gat}: entry is not an object`); continue; }
        if (!groupIds.has(gv.group_id)) problems.push(`${gat}: votes for unknown group ${JSON.stringify(gv.group_id)}`);
        else if (voted.has(gv.group_id)) problems.push(`${gat}: group ${gv.group_id} appears twice`);
        voted.add(gv.group_id);
        counts(gv, `${gat} for group ${gv.group_id}`);
      }
    }
    for (const k of ['group_informed_consensus', 'divisiveness']) {
      if (!isNumberOrNull(c[k])) problems.push(`${at}: ${k} ${JSON.stringify(c[k])} is not a number or null`);
    }
  });

  for (const g of groups) {
    if (!isObject(g) || !Array.isArray(g.representative_comments)) continue;
    for (const rc of g.representative_comments) {
      if (!isObject(rc) || !tids.has(rc.tid)) {
        problems.push(`group ${g.group_id}: representative statement tid `
          + `${JSON.stringify(rc && rc.tid)} is not among the comments`);
      }
    }
  }
  return problems;
}

// One structural fault can repeat on every comment, so cap the list: the first few say
// what is wrong and the count says how far it spread.
function formatProblems(problems) {
  const SHOWN = 20;
  const shown = problems.slice(0, SHOWN);
  if (problems.length > SHOWN) shown.push(`… and ${problems.length - SHOWN} more`);
  return '    ' + shown.join('\n    ');
}

function readSnapshot(file, label = file) {
  let snapshot;
  try {
    snapshot = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`cannot read ${label}: ${err.message}`);
  }
  const problems = validateSnapshot(snapshot);
  if (problems.length) {
    throw new Error(`${label} is not a valid snapshot:\n${formatProblems(problems)}`);
  }
  return snapshot;
}

module.exports = {
  snapshotsDir, snapshotFileName, latestSnapshot, stripParticipantData, validateSnapshot, formatProblems, readSnapshot,
};
