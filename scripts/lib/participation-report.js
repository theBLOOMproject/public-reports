// The participation report is comhairle's
// GET /conversation/{conversationId}/workflow/{workflowId}/participation_report: the
// demographics of a poll's participants, as one count per answer, per question. A
// snapshot carries it raw as participationReport; merge-snapshot.js turns it into
// demographics.json's poll half.
//
// Each question's rows include one with value null: consented participants who skipped
// it. Non-consented participants appear in no row at all — only in totalParticipants.

// comhairle's field for each question, the category name its rows carry, and the key and
// tab label demographics.json gives it — in the modal's tab order.
const CATEGORIES = [
  { field: 'ageRanges', category: 'age_range', key: 'age', label: 'Age' },
  { field: 'politicalParty', category: 'political_party', key: 'political', label: 'Political' },
  { field: 'gender', category: 'gender', key: 'gender', label: 'Gender' },
  { field: 'ethnicity', category: 'ethnicity', key: 'ethnicity', label: 'Race / Ethnicity' },
];

const isObject = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const isCount = n => Number.isInteger(n) && n >= 0;
const isText = s => typeof s === 'string' && s.trim() !== '';

const sumOf = rows => rows.reduce((s, r) => s + r.count, 0);

// Everyone who consented to share demographics: every question's rows, skips included,
// add up to it. Validation guarantees they all agree.
const consentedCount = report => sumOf(report[CATEGORIES[0].field]);

function validateParticipationReport(report) {
  const at = 'participationReport';
  if (!isObject(report)) return [`${at} is not an object`];
  // comhairle's main branch replaces the per-question fields with one "categories" map
  // keyed by question slug. Say so plainly rather than list every missing field.
  if ('categories' in report) {
    return [`${at} is in comhairle's newer shape (a "categories" map) — `
      + 'scripts/lib/participation-report.js needs updating to read it'];
  }

  const problems = [];
  if (!isCount(report.totalParticipants)) {
    problems.push(`${at}.totalParticipants ${JSON.stringify(report.totalParticipants)} is not a count`);
  }

  const sums = [];
  for (const { field, category } of CATEGORIES) {
    const rows = report[field];
    if (!Array.isArray(rows)) {
      problems.push(`${at}.${field} is not an array`);
      continue;
    }
    const seen = new Set();
    let ok = true;
    rows.forEach((r, i) => {
      const rat = `${at}.${field}[${i}]`;
      if (!isObject(r)) { ok = false; return problems.push(`${rat}: not an object`); }
      if (r.category !== category) {
        problems.push(`${rat}: category ${JSON.stringify(r.category)}, expected "${category}"`);
      }
      if (r.value !== null && !isText(r.value)) problems.push(`${rat}: value is neither text nor null`);
      else if (seen.has(r.value)) problems.push(`${rat}: value ${JSON.stringify(r.value)} appears twice`);
      seen.add(r.value);
      if (!isCount(r.count)) { ok = false; problems.push(`${rat}: count ${JSON.stringify(r.count)} is not a count`); }
    });
    if (ok) sums.push([field, sumOf(rows)]);
  }

  const zips = report.zipcodeCounts;
  if (!isObject(zips)) {
    problems.push(`${at}.zipcodeCounts is not an object`);
  } else {
    // Snapshots are committed to a public repo: anything but a zip code here is free text
    // someone typed, and doesn't belong there.
    const badKeys = Object.keys(zips).filter(k => !/^\d{5}$/.test(k));
    if (badKeys.length) problems.push(`${at}.zipcodeCounts has ${badKeys.length} key(s) that aren't 5-digit zip codes`);
    const badCounts = Object.entries(zips).filter(([, n]) => !isCount(n));
    if (badCounts.length) problems.push(`${at}.zipcodeCounts has ${badCounts.length} value(s) that aren't counts`);
    if (!badCounts.length) sums.push(['zipcodeCounts', Object.values(zips).reduce((s, n) => s + n, 0)]);
  }

  // Every consented participant is counted once per question (skips as null) and has a
  // zip, so these all describe the same people. If they disagree, something upstream
  // changed what it counts.
  if (new Set(sums.map(([, n]) => n)).size > 1) {
    problems.push(`${at}: totals disagree — ${sums.map(([f, n]) => `${f} ${n}`).join(', ')}`);
  } else if (sums.length && isCount(report.totalParticipants) && report.totalParticipants < sums[0][1]) {
    problems.push(`${at}: totalParticipants ${report.totalParticipants} is less than the `
      + `${sums[0][1]} consented participants counted per question`);
  }
  return problems;
}

module.exports = { CATEGORIES, consentedCount, validateParticipationReport };
