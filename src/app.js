(() => {
'use strict';

const J = id => JSON.parse(document.getElementById(id).textContent);
const DATA = J('bloom-data');
const DESC = J('theme-descriptions');
const INSIGHTS = J('bloom-insights');
const GROUP_INFO = J('group-info');
const GROUP_STATEMENTS = J('group-statements');
const CONSENSUS_STATEMENTS = J('consensus-statements');
const PARTICIPANT_LOCATIONS = J('participant-locations');
const DEMOGRAPHICS = J('demographics');
const OREGON_COUNTIES = J('oregon-counties');

const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
const $ = s => document.querySelector(s);
const el = (t, c, x) => { const n = document.createElement(t); if (c) n.className = c; if (x != null) n.textContent = x; return n; };
const esc = s => s.replace(/[&<>]/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[m]));
// title-cases a raw ALL-CAPS chip (e.g. demographic tags), with one special
// case: a bare "or" stays uppercase right after a comma — that's the Oregon
// abbreviation ("Bend, OR"), not the conjunction ("White or Caucasian").
const titleCaseChip = s => s.toLowerCase().replace(/\b\w+/g, (word, offset, str) => {
  if (word === 'or') return str.slice(0, offset).trimEnd().endsWith(',') ? 'OR' : 'or';
  return word.charAt(0).toUpperCase() + word.slice(1);
});

// experimental: represent each poll statement in the lane as a person
// matching who submitted it — gender + age bucket picks the base emoji,
// race picks a Fitzpatrick skin-tone modifier. Non-participant (seeded)
// statements aren't tied to any one person, so they get a seed emoji.
const EMOJI_OLD_AGE = new Set(['55-64', '65+']);
const EMOJI_SKIN_TONE = { 'WHITE OR CAUCASIAN': '🏻', 'NATIVE AMERICAN': '🏽' };
const emojiFor = r => {
  if (r.origin !== 'participant') return '🌱';
  const old = r.chips.some(c => EMOJI_OLD_AGE.has(c));
  const gender = r.chips.find(c => c === 'FEMALE' || c === 'MALE' || c === 'OTHER');
  const tone = EMOJI_SKIN_TONE[r.chips.find(c => EMOJI_SKIN_TONE[c])] || '';
  const base = gender === 'FEMALE' ? (old ? '👵' : '👩')
    : gender === 'MALE' ? (old ? '👴' : '👨')
    : (old ? '🧓' : '🧑');
  return base + tone;
};

const byKey = {};
DATA.themes.forEach(t => byKey[t.key] = t);
// borrowed for the demographics modal's row swatches — no per-category color of
// its own, so it cycles through the same palette the theme grid already uses
const THEME_COLORS = DATA.themes.map(t => t.color);
const byId = {};
DATA.records.forEach(r => byId[r.id] = r);
// A theme *is* the records carrying any of its tags — membership is derived, not
// stored, so a statement that spans two subjects belongs to both themes.
const recsOf = t => DATA.records.filter(r => r.tags.some(g => t.tags.includes(g)));
const pollsOf = t => recsOf(t).filter(r => r.vote);
const quotesOf = t => recsOf(t).filter(r => !r.vote);
// Opinion groups come from Polis's clustering, which re-runs as votes arrive: both
// how many there are and which is which can change between refreshes. Nothing here
// may assume two, or assume that "A" means what it meant last time — the labels are
// data, reapplied editorially after each refresh. Order is DATA.groups' order.
const groupsOf = v => DATA.groups.map(g => ({ ...g, ...v[g.key] }));
// The List tab's key row expands each square's letter into what that group means.
// Labels read "Group A · skeptic-leaning" and the letter is already on the square,
// so show only the part that carries meaning. A refresh resets labels to a bare
// "Group A", which falls through unchanged — the missing editorial pass stays visible
// rather than being papered over with an empty string.
const groupTag = g => {
  const label = g.label.trim();
  const prefix = 'Group ' + g.key;
  if (!label.toLowerCase().startsWith(prefix.toLowerCase())) return label;
  // Separator is whatever the editor typed — "Group A · skeptics", "Group A: skeptics",
  // "Group A (skeptics)" all reduce to the same thing.
  const rest = label.slice(prefix.length)
    .replace(/^[\s·:—–-]+/, '')
    .replace(/^\((.*)\)$/, '$1')
    .trim();
  return rest ? rest.charAt(0).toUpperCase() + rest.slice(1) : label;
};
const countLabel = (np, nq) =>
  `${np} statement${np === 1 ? '' : 's'} · ${nq} quote${nq === 1 ? '' : 's'}`;

// a short, human phrase for who said it — gender + place, drawn straight
// from the real chip data (no fabricated demographics). Falls back
// gracefully for host-seeded statements or participants missing a chip.
const demoLineFor = r => {
  if (r.origin === 'cocap_seed') return 'Host statement';
  const gender = r.chips.find(c => c === 'FEMALE' || c === 'MALE' || c === 'OTHER');
  const who = gender === 'FEMALE' ? 'Woman' : gender === 'MALE' ? 'Man' : 'Person';
  return r.place ? `${who} from ${r.place}` : (gender ? who : 'Community member');
};

const DIFFERENCE_OVER_GAP = 33;
const CONSENSUS_OVER_AGREE = 66;
const CONSENSUS_UNDER_AGREE = 33;

// the card's per-group %-agree readout is colored by how high it is,
// not by which group it belongs to: 0-33 red, 33-67 amber, 67-100 green
const tierColorFor = pct => pct >= 67 ? 'var(--agree)' : pct >= 33 ? 'var(--amber)' : 'var(--disagree)';

// shared by the statement modal's pill and the new statement card's pill
const pillInfoFor = v => {
  const maxAgree = v.minAgree + v.gap;   // gap is max − min, so the ceiling needs no field
  if (v.gap > DIFFERENCE_OVER_GAP)
    return { cls: 'difference', icon: 'static/difference.svg', label: 'DIFFERENCE (' + v.gap + ' PTS)' };
  if (v.minAgree > CONSENSUS_OVER_AGREE)
    return { cls: 'consensus', icon: 'static/consensus.svg', label: 'CONSENSUS (' + v.minAgree + '% AGREE)' };
  if (maxAgree < CONSENSUS_UNDER_AGREE)
    return { cls: 'consensus-against', icon: 'static/consensus.svg', label: 'CONSENSUS (' + maxAgree + '% AGREE)' };
  return { cls: 'neutral', icon: null, label: v.minAgree + '% AGREE' };
};

// turns a claim + hand-assigned direction into TOC/headline copy. Some
// claims are already written as "People disagree about whether X" —
// those are used verbatim (with the verb emphasized) rather than
// double-wrapped in another "People X that…" template.
const CLAIM_VERB_RE = /^People (agree|disagree)\b/i;
const claimPhrase = (claim, direction) => {
  const m = claim.match(CLAIM_VERB_RE);
  if (m) {
    const verb = m[1].toLowerCase(), rest = claim.slice(m[0].length);
    return {
      toc: 'People ' + verb.toUpperCase() + rest,
      head: 'People <em class="ic-' + verb + '">' + verb + '</em>' + rest + '.',
    };
  }
  const firstWord = claim.match(/^\S+/)[0];
  const lead = /^[A-Z]{2,}$/.test(firstWord.replace(/[^A-Za-z]/g, ''))
    ? claim : claim.charAt(0).toLowerCase() + claim.slice(1);
  const TOC_LEAD = { agree: 'AGREE that', disagree: 'DISAGREE that', divided: 'are DIVIDED on whether', mixed: 'are MIXED on whether' };
  const HEAD = {
    agree: 'People generally <em class="ic-agree">agree</em> that ' + lead + '.',
    disagree: 'People generally <em class="ic-disagree">disagree</em> that ' + lead + '.',
    divided: 'People are <em>divided</em> over whether ' + lead + '.',
    mixed: 'People have <em>mixed</em> views on whether ' + lead + '.',
  };
  return { toc: 'People ' + (TOC_LEAD[direction] || TOC_LEAD.mixed) + ' ' + lead, head: HEAD[direction] || HEAD.mixed };
};

const state = { theme: null, sel: -1, layout: [] };
let scrollRaf = null, l1Scroll = 0;
let carouselTimers = [];
let demogSvg = null, demogWorld = null, demogMarkersG = null, demogProjection = null,
  demogPath = null, demogZoom = null, demogResizeTimer = null;

/* ─── LEVEL 0 ─────────────────────────────────────────── */
// The ordered sequence of intro pages shown before the theme grid, each a
// plain <main class="introPage" id="..."> in the template. This array is
// the single source of truth for that order: route() shows/hides by walking
// it, and NAV_SEQUENCE (see #pageBar) is this order with 'themes' appended —
// so reordering, inserting, or removing a page is a one-line change here
// (plus adding/removing the matching markup), never a hunt through route().
const INTRO_PAGES = [
  { key: 'title', id: 'l0-title' },
  { key: 'demogs', id: 'l0-demogs' },
  { key: 'groups', id: 'l0-groups' },
  { key: 'consensus', id: 'l0-consensus' },
];

// participant-locations.json's cities become clickable markers over real
// Oregon county geometry (data/oregon-counties.json, sourced from the U.S.
// Census Bureau — see its own _readme), rendered and panned/zoomed by
// vendored D3 (vendor/d3-custom.min.js — d3-geo for the projection/path
// generator, d3-zoom for the gesture engine; see that file's own header for
// exactly which modules and why). Marker radius is scaled by sqrt of count
// rather than count itself — Bend outnumbers Prineville 8 to 1, and a linear
// scale would render that as a barely-visible speck next to a blob.
const TRI_COUNTY_FIPS = new Set(['41017', '41013', '41031']);   // Deschutes, Crook, Jefferson
const DEMOG_MAX_ZOOM_IN = 8;        // tunable: multiple of the home (city-cluster) fit scale
const DEMOG_RESET_DURATION = 500;   // ms
const DEMOG_MIN_R = 13, DEMOG_MAX_R = 70;

// One-time DOM/data-binding setup. The projection isn't fit to real pixel
// dimensions yet at this point — #l0-demogs may still be display:none — that
// happens in fitDemogMap(), driven by a ResizeObserver so it naturally fires
// once the page becomes visible, on every real resize, and across the 660px
// breakpoint, all through one mechanism.
function initDemogMap() {
  demogSvg = d3.select('#demogSvg');
  demogSvg.append('rect').attr('class', 'demogBg');
  demogWorld = demogSvg.append('g').attr('class', 'demogWorld');
  demogMarkersG = demogSvg.append('g').attr('class', 'demogMarkers');

  demogProjection = d3.geoMercator();
  demogPath = d3.geoPath(demogProjection);

  demogWorld.selectAll('path')
    .data(OREGON_COUNTIES.features, d => d.id)
    .join('path')
    .attr('class', d => 'demogCounty' + (TRI_COUNTY_FIPS.has(d.id) ? ' inRegion' : ''));

  // SVG has no cross-element z-index for plain shapes — paint order is DOM
  // order, full stop. So dots/labels/hover-tooltips live in three separate
  // layers (all dots, then all labels, then all hover tooltips) rather than
  // interleaved per-city groups: that's what guarantees every label paints
  // above every dot and every hover tooltip paints above everything, even
  // one city's stuff over a different city's much bigger overlapping dot,
  // regardless of which city happens to come first in the data. All three
  // layers' groups share the .demogCity class (keyed to the same city
  // objects) so sizing/positioning/zoom code can keep treating "a city's
  // stuff" uniformly.
  const cityClass = d => 'demogCity' + (d.major ? '' : ' minor');
  const dotsLayer = demogMarkersG.append('g').attr('class', 'demogDotsLayer');
  const labelsLayer = demogMarkersG.append('g').attr('class', 'demogLabelsLayer');
  const hoverLayer = demogMarkersG.append('g').attr('class', 'demogHoverLayer');

  const dotGroups = dotsLayer.selectAll('g')
    .data(PARTICIPANT_LOCATIONS.cities, d => d.name)
    .join('g')
    .attr('class', cityClass);
  dotGroups.append('circle').attr('class', 'demogDot');

  const labelGroups = labelsLayer.selectAll('g')
    .data(PARTICIPANT_LOCATIONS.cities, d => d.name)
    .join('g')
    .attr('class', cityClass);
  // paint order within a label = DOM order too: pill background, then text
  labelGroups.append('rect').attr('class', 'demogLabelBg');
  labelGroups.append('text').attr('class', 'demogDotLabel').attr('y', 4).text(d => d.name);

  // hover/tap info tooltip: name on top, count below — see updateDemogHoverLayout()
  const hoverGroups = hoverLayer.selectAll('g')
    .data(PARTICIPANT_LOCATIONS.cities, d => d.name)
    .join('g')
    .attr('class', cityClass);
  hoverGroups.append('rect').attr('class', 'demogHoverBg');
  hoverGroups.append('text').attr('class', 'demogHoverName').text(d => d.name);
  hoverGroups.append('text').attr('class', 'demogHoverCount')
    .text(d => d.count + (d.count === 1 ? ' person' : ' people'));

  updateDemogDotSizes();
  updateDemogHoverLayout();

  // hover reveals the tooltip on desktop; click/tap does the same (and is
  // the only way to reach it on touch, which has no hover state) — both
  // funnel through the same show/hide-all-others functions
  [dotGroups, labelGroups, hoverGroups].forEach(sel => {
    sel.on('pointerenter', (event, d) => demogHoverShow(d));
    sel.on('pointerleave', (event, d) => demogHoverHide(d));
    sel.on('click', (event, d) => { event.stopPropagation(); demogHoverShow(d); });
  });
  demogSvg.select('.demogBg').on('click', () => demogHoverShow(null));

  demogZoom = d3.zoom().on('zoom', demogZoomed);
  demogSvg.call(demogZoom);
  demogSvg.on('dblclick.zoom', null);   // double-tap/dblclick-to-zoom wasn't asked for

  const ro = new ResizeObserver(() => {
    clearTimeout(demogResizeTimer);
    demogResizeTimer = setTimeout(() => {
      const box = $('#demogMap').getBoundingClientRect();
      fitDemogMap(box.width, box.height);
    }, 220);
  });
  ro.observe($('#demogMap'));
}

// Linear: radius is a straight ratio of count to the largest city's count
// (Bend), not compressed toward the top the way sqrt would — settled on
// after live A/B'ing both against the base size via a since-removed dev panel.
const DEMOG_LABEL_OVERLAP = 10;   // px the label pill tucks into the dot's edge
const DEMOG_LABEL_PAD_X = 9, DEMOG_LABEL_PAD_Y = 5;   // pill padding around the text

function updateDemogDotSizes() {
  const maxN = Math.max(...PARTICIPANT_LOCATIONS.cities.map(c => c.count));
  // d.r lives on the shared city objects (data-joined into both layers by
  // the same key), so computing it once here is visible to both below
  PARTICIPANT_LOCATIONS.cities.forEach(d => {
    d.r = DEMOG_MIN_R + (DEMOG_MAX_R - DEMOG_MIN_R) * (d.count / maxN);
  });
  demogMarkersG.selectAll('.demogDotsLayer .demogDot').attr('r', d => d.r.toFixed(1));
  demogMarkersG.selectAll('.demogLabelsLayer .demogCity').each(function (d) {
    const g = d3.select(this);
    const text = g.select('.demogDotLabel').attr('x', d.r - DEMOG_LABEL_OVERLAP);
    // getBBox() reads the text's own rendered geometry, independent of the
    // svg's current viewBox/zoom transform, so this is safe to call before
    // fitDemogMap() has ever run
    const box = text.node().getBBox();
    g.select('.demogLabelBg')
      .attr('x', box.x - DEMOG_LABEL_PAD_X)
      .attr('y', box.y - DEMOG_LABEL_PAD_Y)
      .attr('width', box.width + DEMOG_LABEL_PAD_X * 2)
      .attr('height', box.height + DEMOG_LABEL_PAD_Y * 2)
      .attr('rx', box.height / 2 + DEMOG_LABEL_PAD_Y);
  });
}

// Fits the projection to the home view, then derives the zoom's pan/scale
// bounds from the FULL 36-county collection's projected bounds — this is
// what makes "zoom all the way out" land on the real Oregon outline rather
// than an arbitrary crop. A resize always resets to the home view rather
// than trying to preserve an equivalent pan/zoom at the new size.
function fitDemogMap(w, h) {
  if (w <= 0 || h <= 0) return;   // page still hidden — nothing to measure yet
  demogSvg.attr('viewBox', `0 0 ${w} ${h}`);

  // The home view fits the city POINTS, not the tri-county polygons — the
  // county shapes include a lot of empty land the report doesn't care about;
  // fitting to where the markers actually sit keeps the default view focused
  // on the cities themselves rather than the wider region. PAD leaves room
  // for marker radius/labels at the fitted extent's edges; TOP_OFFSET pushes
  // the cluster down so it doesn't sit directly under the eyebrow text
  // overlaid at the top of the page.
  const PAD = 100;   // bigger PAD = more surrounding context fit into view = more zoomed out
  const TOP_OFFSET = h * 0.16;
  const cityPoints = {
    type: 'FeatureCollection',
    features: PARTICIPANT_LOCATIONS.cities.map(c => (
      { type: 'Feature', geometry: { type: 'Point', coordinates: [c.lng, c.lat] } }
    )),
  };
  // fitExtent's first argument is an extent [[x0,y0],[x1,y1]] (unlike
  // fitSize, which wants a plain [width,height] — see the note this file
  // used to carry on that exact mixup) — used here specifically because it
  // lets the fitted extent be inset/offset, not just sized.
  demogProjection.fitExtent([[PAD, PAD + TOP_OFFSET], [w - PAD, h - PAD]], cityPoints);
  demogWorld.selectAll('path').attr('d', demogPath);

  demogMarkersG.selectAll('.demogCity').each(d => {
    // d3-geo takes points as [lng, lat] — the reverse of these field names'
    // own reading order (see participant-locations.json's _readme)
    d.projected = demogProjection([d.lng, d.lat]);
  });

  const [[x0, y0], [x1, y1]] = demogPath.bounds(OREGON_COUNTIES);
  const kMin = Math.min(w / (x1 - x0), h / (y1 - y0));
  demogZoom.scaleExtent([kMin, DEMOG_MAX_ZOOM_IN])
    .translateExtent([[x0, y0], [x1, y1]])
    .extent([[0, 0], [w, h]]);

  demogSvg.call(demogZoom.transform, d3.zoomIdentity);
}

// below this scale (relative to the k=1 home view), major-city labels fade
// out so a zoomed-out view reads as dots-in-context rather than a wall of
// overlapping pill labels — tunable
const DEMOG_LABEL_MIN_ZOOM = 0.6;
// the 7 smaller places (data/participant-locations.json's non-major cities)
// stay label-less until you've zoomed in past this — tunable
const DEMOG_MINOR_LABEL_MIN_ZOOM = 1.8;

function demogZoomed(event) {
  demogWorld.attr('transform', event.transform);
  demogMarkersG.classed('labelsHidden', event.transform.k < DEMOG_LABEL_MIN_ZOOM);
  demogMarkersG.classed('minorLabelsShown', event.transform.k >= DEMOG_MINOR_LABEL_MIN_ZOOM);
  // markers are repositioned individually, never given the group transform
  // itself — that's what keeps .demogDot's radius and .demogDotLabel's
  // font-size a fixed screen size at every zoom level, unlike a plain
  // uniform-scale approach
  demogMarkersG.selectAll('.demogCity').attr('transform', d => {
    const [x, y] = event.transform.apply(d.projected);
    return `translate(${x},${y})`;
  });
}

function resetDemogMap() {
  demogHoverShow(null);
  const sel = REDUCED ? demogSvg : demogSvg.transition().duration(DEMOG_RESET_DURATION);
  sel.call(demogZoom.transform, d3.zoomIdentity);
}

/* ─── DEMOGRAPHICS MAP — hover/tap info tooltip ───────── */
// Positions each city's two-line tooltip (name + count) at the same anchor
// the plain label pill uses (see DEMOG_LABEL_OVERLAP), just taller since
// it's two lines. Unions the two text lines' own bboxes rather than reading
// the group's bbox — the group also contains .demogHoverBg, which starts at
// a phantom 0×0 at the origin before this runs and would otherwise skew
// the union on the very first layout pass.
function updateDemogHoverLayout() {
  demogMarkersG.selectAll('.demogHoverLayer .demogCity').each(function (d) {
    const g = d3.select(this);
    const x = d.r - DEMOG_LABEL_OVERLAP;
    const nameBox = g.select('.demogHoverName').attr('x', x).attr('y', 0).node().getBBox();
    const countBox = g.select('.demogHoverCount').attr('x', x).attr('y', 21).node().getBBox();
    const bx = Math.min(nameBox.x, countBox.x);
    const by = Math.min(nameBox.y, countBox.y);
    const bx2 = Math.max(nameBox.x + nameBox.width, countBox.x + countBox.width);
    const by2 = Math.max(nameBox.y + nameBox.height, countBox.y + countBox.height);
    g.select('.demogHoverBg')
      .attr('x', bx - DEMOG_LABEL_PAD_X)
      .attr('y', by - DEMOG_LABEL_PAD_Y)
      .attr('width', (bx2 - bx) + DEMOG_LABEL_PAD_X * 2)
      .attr('height', (by2 - by) + DEMOG_LABEL_PAD_Y * 2)
      .attr('rx', 10);
  });
}

// Only ever one city's tooltip showing at a time — .classed() with a
// per-datum predicate clears every other city's .hovered in the same pass.
// city === null (the map background, or resetDemogMap) hides all of them.
function demogHoverShow(city) {
  demogMarkersG.selectAll('.demogHoverLayer .demogCity').classed('hovered', d => d === city);
}
function demogHoverHide(city) {
  demogMarkersG.selectAll('.demogHoverLayer .demogCity')
    .filter(d => d === city)
    .classed('hovered', false);
}

/* ─── DEMOGRAPHICS DETAIL MODAL ───────────────────────── */
// data/demographics.json's own _readme has the derivation: each category's
// breakdown is a share of only the respondents who answered that question,
// not of everyone — the modal's copy spells that denominator out per tab.
const dstate = { key: DEMOGRAPHICS.categories[0].key };

function openDemog() {
  dstate.key = DEMOGRAPHICS.categories[0].key;
  buildDemogTabs();
  renderDemogTab();
  $('#ddetail').classList.add('on');
  $('#ddetail').setAttribute('aria-hidden', 'false');
  $('#dCloseb').focus({ preventScroll: true });
}

function closeDemog() {
  $('#ddetail').classList.remove('on');
  $('#ddetail').setAttribute('aria-hidden', 'true');
}

function buildDemogTabs() {
  const wrap = $('#ddTabs');
  wrap.innerHTML = '';
  DEMOGRAPHICS.categories.forEach(cat => {
    const b = el('button', null, cat.label.toUpperCase());
    b.type = 'button';
    b.setAttribute('role', 'tab');
    b.dataset.key = cat.key;
    b.setAttribute('aria-pressed', cat.key === dstate.key ? 'true' : 'false');
    b.onclick = () => { dstate.key = cat.key; renderDemogTab(); };
    wrap.append(b);
  });
}

function renderDemogTab() {
  const cat = DEMOGRAPHICS.categories.find(c => c.key === dstate.key);
  document.querySelectorAll('#ddTabs button').forEach(b =>
    b.setAttribute('aria-pressed', b.dataset.key === dstate.key ? 'true' : 'false'));
  $('#dcName').textContent = cat.label;

  const body = $('#dCardbody');
  body.innerHTML = '';
  body.scrollTop = 0;

  const pctAnswered = Math.round(cat.answered / DEMOGRAPHICS.total * 100);
  const intro = el('p', 'ddIntro');
  intro.innerHTML = `<b>${pctAnswered}%</b> of respondents provided this information. `
    + `Of those <b>${cat.answered}</b> people that provided this information, here is the breakdown:`;
  body.append(intro);

  const list = el('div', 'ddList');
  cat.breakdown.forEach((row, i) => {
    const r = el('div', 'ddRow');
    r.style.setProperty('--rc', THEME_COLORS[i % THEME_COLORS.length]);
    r.style.setProperty('--pct', row.pct + '%');
    r.append(el('span', 'ddSwatch'));
    r.append(el('span', 'ddLabel', row.label));
    r.append(el('span', 'ddPct', row.pct + '%'));
    list.append(r);
  });
  body.append(list);
}

// group-info.json is a hand-maintained snapshot (see its own _readme for
// provenance and staleness caveats) — bloom-data.json's own groups[] never
// carries participant counts, since refresh-poll.js deliberately avoids
// storing cluster sizes that go stale the moment Polis reclusters.
const groupByKey = {};
DATA.groups.forEach(g => groupByKey[g.key] = g);
// group-info's per-key extras (participants/color/description) merged onto
// bloom-data.json's own {key, label} — shared by the bubble list and the
// detail modal so both always agree on a group's display name/color.
const groupInfoOf = key => ({ ...groupByKey[key], ...(GROUP_INFO[key] || {}) });

function buildGroups() {
  const wrap = $('#groupBubbles');
  const groups = DATA.groups.map(g => groupInfoOf(g.key));
  groups.forEach(g => {
    const row = el('button', 'gbubble');
    row.type = 'button';
    row.dataset.key = g.key;
    row.setAttribute('aria-label', groupTag(g) + ': ' + (g.participants || 0) + ' people — see defining statements');
    row.style.setProperty('--c', g.color || 'var(--home)');
    row.append(el('div', 'gName', groupTag(g)));
    row.append(el('div', 'gCount', (g.participants || 0) + ' people'));
    if (g.tagline) row.append(el('p', 'gTagline', g.tagline));
    row.onclick = () => openGroup(g.key);
    wrap.append(row);
  });
}

/* ─── GROUP DETAIL MODAL ──────────────────────────────── */
// Page 0 is the hand-written description (see group-info.json's _readme);
// pages 1..N are group-statements.json's defining statements, most
// representative first. Deliberately its own small state/open/close/page
// set rather than reusing L3's — the content shape (a generated blurb vs.
// a themed statement card) is different enough that sharing would mean
// branching L3's open() on what kind of thing it's showing.
const gstate = { key: null, page: 0 };

function openGroup(key) {
  gstate.key = key;
  gstate.page = 0;
  const g = groupInfoOf(key);
  document.querySelectorAll('.gbubble.sel').forEach(n => n.classList.remove('sel'));
  document.querySelector(`.gbubble[data-key="${key}"]`)?.classList.add('sel');
  $('#gdetail').style.setProperty('--c', g.color || 'var(--home)');
  $('#gcName').textContent = groupTag(g);
  renderGroupPage();
  $('#gdetail').classList.add('on');
  $('#gdetail').setAttribute('aria-hidden', 'false');
  $('#gCloseb').focus({ preventScroll: true });
}

function closeGroup() {
  $('#gdetail').classList.remove('on');
  $('#gdetail').setAttribute('aria-hidden', 'true');
  document.querySelector('.gbubble.sel')?.classList.remove('sel');
  gstate.key = null;
}

function pageGroup(d) {
  const total = 1 + (GROUP_STATEMENTS[gstate.key] || []).length;
  const i = gstate.page + d;
  if (i >= 0 && i < total) { gstate.page = i; renderGroupPage(); }
}

function renderGroupPage() {
  const g = groupInfoOf(gstate.key);
  const stmts = GROUP_STATEMENTS[gstate.key] || [];
  const total = 1 + stmts.length;
  const body = $('#gCardbody');
  body.innerHTML = '';
  body.scrollTop = 0;

  if (gstate.page === 0) {
    const wrap = el('div', 'gdDesc');
    wrap.append(el('p', 'gdText', g.description || ''));
    body.append(wrap);
  } else {
    const r = byId[stmts[gstate.page - 1].id];
    const quotewrap = el('div', 'quotewrap');
    quotewrap.append(el('blockquote', null, '“' + r.text + '”'));
    body.append(quotewrap);
    // same per-group agree% numbers L3 shows for any statement (via
    // groupsOf(), so the two never drift), but its own presentation: no
    // "Group A/B/C" prefix (groupTag() — this modal's own header already
    // says which group it is), no disagree/pass/agree legend, and the
    // group the modal is about sorted first with a visibly thicker bar
    // rather than sitting wherever DATA.groups' own A/B/C order puts it.
    const m = el('div', 'meta');
    const p = el('section');
    p.append(el('h4', null, 'Open Poll Responses'));
    p.append(el('div', 'gdVoteCount', r.vote.total + ' votes'));
    const rows = groupsOf(r.vote);
    rows.sort((a, b) => (a.key === gstate.key) === (b.key === gstate.key) ? 0 : a.key === gstate.key ? -1 : 1);
    rows.forEach(gr => {
      const row = el('div', gr.key === gstate.key ? 'grow current' : 'grow');
      const top = el('div', 'top');
      top.append(el('span', null, groupTag(gr)));
      top.append(el('b', null, gr.pct + '% agree'));
      row.append(top);
      const bar = el('div', 'bar');
      const tot = Math.max(1, gr.n);
      [['d', gr.d], ['p', gr.p], ['a', gr.a]].forEach(([cls, v]) => {
        const i2 = el('i', cls);
        i2.style.flex = (v / tot) + ' 0 0';
        if (!v) i2.style.display = 'none';
        bar.append(i2);
      });
      row.append(bar);
      p.append(row);
    });
    m.append(p);
    body.append(m);
  }

  $('#gPos').innerHTML = (gstate.page + 1) + ' <em>|</em> ' + total;
  $('#gPrev').disabled = gstate.page === 0;
  $('#gNext').disabled = gstate.page === total - 1;
}

/* ─── L0 — CONSENSUS ──────────────────────────────────── */
// nudgeApart() and the .lcard/.lBar* styles this page renders with were
// the List tab's, removed along with the L2 tab system; the Consensus
// page is now their only consumer, so they live here rather than in a
// shared layer that no longer has a second caller.
function nudgeApart(xs, minGap, lo, hi) {
  const order = xs.map((x, i) => i).sort((a, b) => xs[a] - xs[b]);
  const out = xs.slice();
  order.forEach((i, n) => {
    out[i] = n === 0 ? Math.max(lo, xs[i]) : Math.max(xs[i], out[order[n - 1]] + minGap);
  });
  for (let n = order.length - 1; n >= 0; n--) {
    const i = order[n];
    const limit = n === order.length - 1 ? hi : out[order[n + 1]] - minGap;
    out[i] = Math.max(lo, Math.min(out[i], limit));
  }
  return out;
}

function buildConsensus() {
  const lane = $('#consensusLane');
  lane.innerHTML = '';
  const records = CONSENSUS_STATEMENTS.ids.map(id => byId[id]).filter(Boolean);
  state.layout = { items: records.map(r => ({ rec: r })) };

  records.forEach((r, idx) => {
    const card = el('button', 'lcard');
    card.dataset.i = idx;

    const who = el('div', 'lWho');
    who.append(el('span', 'lEmoji', emojiFor(r)));
    const demoWrap = el('div', 'lDemoWrap');
    const demoChips = r.chips.filter(c => c.toLowerCase() !== 'not provided');
    const demoText = r.origin === 'cocap_seed'
      ? 'Host statement'
      : (demoChips.length ? demoChips.map(titleCaseChip).join(', ') : 'Anonymous');
    const demoTrack = el('span', 'lDemoTrack');
    demoTrack.append(el('span', null, demoText));
    demoWrap.append(demoTrack);
    who.append(demoWrap);
    card.append(who);

    card.append(el('p', 'lText', '“' + r.text + '”'));

    const labels = el('div', 'lBarLabels');
    const { cls, icon, label } = pillInfoFor(r.vote);
    const pill = el('div', 'who ' + cls);
    const pillAv = el('span', 'av');
    if (icon) pillAv.innerHTML = `<img src="${icon}" alt="">`;
    pill.append(pillAv, el('span', 'txt', label));
    labels.append(el('span', null, '<- Disagree (0%)'), pill, el('span', null, 'Agree (100%) ->'));
    card.append(labels);
    const barWrap = el('div', 'lBar');
    const track = el('div', 'lBarTrack');
    if (DATA.groups.length > 3) track.classList.add('tight');
    const edgeLo = el('span', 'lBarEdge lo', '0%');
    const edgeHi = el('span', 'lBarEdge hi', '100%');
    const mid = el('div', 'lBarMid');
    const line = el('div', 'lBarLine');
    const groups = groupsOf(r.vote);
    const squares = groups.map(g => el('div', 'lBarSq', g.key));
    track.append(edgeLo, edgeHi, mid, line, ...squares);
    barWrap.append(track);
    card.append(barWrap);

    card.onclick = () => open(idx);
    lane.append(card);

    const SQ = parseFloat(getComputedStyle(track).getPropertyValue('--sq')) || 26;
    const HALF_SQ = SQ / 2;
    const w = track.clientWidth;
    const xFor = pct => HALF_SQ + (w - HALF_SQ * 2) * Math.max(0, Math.min(100, pct)) / 100;
    const xs = groups.map(g => xFor(g.pct));
    const placed = nudgeApart(xs, SQ + 2, HALF_SQ, w - HALF_SQ);
    squares.forEach((sq, i) => sq.style.left = placed[i] + 'px');
    line.style.left = Math.min(...xs) + 'px';
    line.style.width = (Math.max(...xs) - Math.min(...xs)) + 'px';

    if (!REDUCED && demoTrack.scrollWidth > demoWrap.clientWidth) {
      const singleW = demoTrack.firstChild.getBoundingClientRect().width;
      const dupe = el('span', null, demoText);
      dupe.setAttribute('aria-hidden', 'true');
      demoTrack.append(dupe);
      const gapPx = parseFloat(getComputedStyle(demoTrack).columnGap) || 0;
      const dist = singleW + gapPx;
      demoTrack.style.setProperty('--marquee-dist', `-${dist}px`);
      demoTrack.style.setProperty('--marquee-dur', Math.max(4, dist / 34) + 's');
      demoTrack.classList.add('marquee');
    }
  });
}

/* ─── LEVEL 1 ─────────────────────────────────────────── */
function buildL1() {
  const wrap = $('#blocks');
  DATA.themes.forEach((t, ti) => {
    const b = el('button', 'theme-block');
    const np = pollsOf(t).length, nq = quotesOf(t).length, n = np + nq;
    b.style.setProperty('--c', t.color);
    b.setAttribute('aria-label', `${t.short}: ${n} perspectives`);
    b.append(el('span', 'arrow', '→'));
    b.append(el('h2', null, t.short));
    b.append(el('div', 'count label', countLabel(np, nq)));
    const tal = el('div', 'tally');
    tal.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < n; i++) {
      const c = el('i', i >= np ? 'q' : null);
      c.style.animationDelay = (ti * 70 + i * 16) + 'ms';
      tal.append(c);
    }
    b.append(tal);
    b.onclick = () => { l1Scroll = scrollY; location.hash = '#/' + t.key; };
    wrap.append(b);
  });
}

/* ─── LEVEL 2 ─────────────────────────────────────────── */
function renderL2() {
  const t = state.theme;
  document.documentElement.style.setProperty('--c', t.color);
  $('#l2').style.setProperty('--c', t.color);
  $('#l3').style.setProperty('--c', t.color);
  document.querySelector('meta[name="theme-color"]')?.remove();
  const mc = el('meta'); mc.name = 'theme-color'; mc.content = t.color; document.head.append(mc);

  $('#t-title').textContent = t.short;
  const polls = pollsOf(t).sort((a, b) => b.vote.minAgree - a.vote.minAgree || b.vote.total - a.vote.total);
  $('#t-count').textContent = polls.length + ' statement' + (polls.length === 1 ? '' : 's');
  const d = (DESC.themes && DESC.themes[t.key]) || {};
  $('#t-desc').textContent = d.description || '';

  const i = DATA.themes.indexOf(t);
  const nx = DATA.themes[(i + 1) % DATA.themes.length];
  $('#nextT').innerHTML = 'Go to <b>' + esc(nx.short) + '</b> →';
  $('#nextT').onclick = () => { location.hash = '#/' + nx.key; };

  // paging order for L3 = this theme's own polls, plus any insight-cited
  // record that isn't (e.g. a statement cross-tagged elsewhere under the
  // current tag model) — appended so its carousel card still opens/pages,
  // without counting toward "All Statements"
  const pollIdSet = new Set(polls.map(r => r.id));
  const insights = INSIGHTS[t.key] || [];
  const layoutRecs = polls.slice();
  const seen = new Set(pollIdSet);
  insights.forEach(ins => ins.ids.forEach(id => {
    const r = byId[id];
    if (r && !seen.has(r.id)) { seen.add(r.id); layoutRecs.push(r); }
  }));
  state.layout = { items: layoutRecs.map(r => ({ rec: r })) };

  buildToc(t, insights, polls.length);
  buildInsights(t, insights);
  buildAllStatements(t, pollIdSet);
}

function openRecord(r) {
  const idx = state.layout.items.findIndex(it => it.rec.id === r.id);
  if (idx > -1) open(idx);
}

/* the statement card — used by both the insight carousels and the
   full All Statements stack */
function buildCard(r) {
  const card = el('button', 'icard');
  card.dataset.rid = r.id;

  const { cls, icon, label } = pillInfoFor(r.vote);
  const pill = el('div', 'who ' + cls);
  const av = el('span', 'av');
  if (icon) av.innerHTML = `<img src="${icon}" alt="">`;
  pill.append(av, el('span', 'txt', label));
  card.append(pill);

  card.append(el('p', 'icText', '“' + r.text + '”'));

  const who = el('div', 'icWho');
  who.append(el('span', 'icAv', emojiFor(r)));
  who.append(el('span', 'icDemo', demoLineFor(r)));
  card.append(who);

  const stats = el('div', 'icStats');
  groupsOf(r.vote).forEach(g => {
    const pct = Math.max(0, Math.min(100, g.pct));
    const color = tierColorFor(pct);
    const stat = el('div', 'icStat');
    const val = el('div', 'icVal', g.pct + '%');
    val.style.color = color;
    stat.append(val);
    stat.append(el('div', 'icLabel', groupTag(g)));
    const track = el('div', 'icBarTrack');
    const fill = el('div', 'icBarFill');
    fill.style.width = pct + '%';
    fill.style.background = color;
    track.append(fill);
    stat.append(track);
    stats.append(stat);
  });
  card.append(stats);

  card.onclick = () => openRecord(r);
  return card;
}

function buildToc(t, insights, npolls) {
  const toc = $('#toc');
  const list = $('#tocList');
  list.innerHTML = '';
  toc.hidden = !insights.length;
  if (!insights.length) return;

  insights.forEach((ins, i) => {
    const { toc: line } = claimPhrase(ins.claim, ins.direction);
    const item = el('button', 'tocItem');
    item.append(el('span', null, line));
    item.append(el('span', 'arrow', '→'));
    item.onclick = () => document.getElementById('insight-' + t.key + '-' + i)
      ?.scrollIntoView({ behavior: REDUCED ? 'auto' : 'smooth', block: 'start' });
    list.append(item);
  });
  const seeAll = el('button', 'tocSeeAll', `See all ${npolls} statement${npolls === 1 ? '' : 's'} →`);
  seeAll.onclick = () => $('#allStatements')
    ?.scrollIntoView({ behavior: REDUCED ? 'auto' : 'smooth', block: 'start' });
  list.append(seeAll);
}

// carousels auto-advance to the next card every 5-10s (staggered per
// carousel so several on the page don't all shift in lockstep), and stop
// for good the moment someone actually touches/scrolls/wheels one —
// re-rendering the page (theme switch) clears every outstanding timer
function stopCarouselAutoplay() {
  carouselTimers.forEach(clearInterval);
  carouselTimers = [];
}
function attachCarouselAutoplay(carousel) {
  const cards = [...carousel.children];
  if (REDUCED || cards.length < 2) return;
  let idx = 0;
  const timer = setInterval(() => {
    idx = (idx + 1) % cards.length;
    // scroll only the carousel's own horizontal axis — scrollIntoView (even
    // with block:'nearest') can still nudge the page's vertical scroll,
    // which reads as the whole viewport jumping around on its own
    const card = cards[idx];
    const left = card.offsetLeft - (carousel.clientWidth - card.clientWidth) / 2;
    carousel.scrollTo({ left, behavior: 'smooth' });
  }, 5000 + Math.random() * 5000);
  carouselTimers.push(timer);
  const stop = () => {
    clearInterval(timer);
    ['pointerdown', 'wheel', 'touchstart'].forEach(e => carousel.removeEventListener(e, stop));
  };
  ['pointerdown', 'wheel', 'touchstart'].forEach(e => carousel.addEventListener(e, stop, { passive: true }));
}

function buildInsights(t, insights) {
  const wrap = $('#insightsWrap');
  stopCarouselAutoplay();
  wrap.innerHTML = '';
  insights.forEach((ins, i) => {
    const records = ins.ids.map(id => byId[id]).filter(Boolean);
    if (!records.length) return;
    const section = el('section', 'insight');
    section.id = 'insight-' + t.key + '-' + i;
    const { head } = claimPhrase(ins.claim, ins.direction);
    const h2 = el('h2', 'insightHead');
    h2.innerHTML = head;
    section.append(h2);
    const carousel = el('div', 'carousel');
    records.forEach(r => carousel.append(buildCard(r)));
    section.append(carousel);
    wrap.append(section);
    attachCarouselAutoplay(carousel);
  });
}

function buildAllStatements(t, pollIdSet) {
  const list = $('#allList');
  list.innerHTML = '';
  const polls = state.layout.items.map(it => it.rec).filter(r => pollIdSet.has(r.id));
  polls.forEach(r => list.append(buildCard(r)));
  $('#laneEnd').textContent = polls.length + ' statement' + (polls.length === 1 ? '' : 's') + ' in this theme';
}

/* ─── LEVEL 3 ─────────────────────────────────────────── */
function open(idx) {
  state.sel = idx;
  const it = state.layout.items[idx];
  const r = it.rec;

  // a statement's card can appear twice on the page (once in its
  // insight's carousel, once in All Statements) — mark every instance.
  // .lcard is the Consensus page's card, indexed rather than id-keyed;
  // neither class ever appears on the other's page, so both run safely.
  document.querySelectorAll('.icard.sel, .lcard.sel').forEach(n => n.classList.remove('sel'));
  document.querySelectorAll(`.icard[data-rid="${r.id}"]`).forEach(n => n.classList.add('sel'));
  document.querySelector(`.lcard[data-i="${idx}"]`)?.classList.add('sel');

  // consensus / difference / plain-agreement indicator — polls only,
  // quotes carry no vote data so the pill is hidden for those
  const who = $('#who');
  who.hidden = !r.vote;
  if (r.vote) {
    const { cls, icon, label } = pillInfoFor(r.vote);
    who.className = 'who ' + cls;
    $('#whoAv').innerHTML = icon ? `<img src="${icon}" alt="">` : '';
    $('#whoTxt').textContent = label;
  }

  const q = $('#s-text');
  q.textContent = '“' + r.text + '”';
  q.style.setProperty('--qs', '30px');

  // meta panel
  const m = $('#s-meta');
  m.innerHTML = '';
  const src = el('section');
  src.append(el('h4', null, 'Source'));
  const sv = el('p', 'src', r.source);
  const info = r.origin === 'cocap_seed'
    ? 'Host statement'
    : (r.chips.length ? r.chips : ['Anonymous']).map(titleCaseChip).join(', ');
  sv.append(el('small', null, 'Participant: ' + info));
  src.append(sv);
  m.append(src);

  if (r.vote) {
    const p = el('section');
    p.append(el('h4', null, 'Open poll responses · ' + r.vote.total + ' votes'));
    groupsOf(r.vote).forEach(g => {
      const row = el('div', 'grow');
      const top = el('div', 'top');
      top.append(el('span', null, g.label));
      const bb = el('b', null, g.pct + '% agree'); top.append(bb);
      row.append(top);
      const bar = el('div', 'bar');
      const tot = Math.max(1, g.n);
      [['d', g.d], ['p', g.p], ['a', g.a]].forEach(([cls, v]) => {
        const i2 = el('i', cls);
        i2.style.flex = (v / tot) + ' 0 0';
        if (!v) i2.style.display = 'none';
        bar.append(i2);
      });
      row.append(bar);
      p.append(row);
    });
    const key = el('div', 'barkey');
    [['d', 'Disagree'], ['p', 'Pass'], ['a', 'Agree']].forEach(([c, l]) => {
      const s = el('span'); s.append(el('i', c)); s.append(document.createTextNode(l)); key.append(s);
    });
    p.append(key);
    m.append(p);
  }

  if (r.tags.length) {
    const s = el('section');
    s.append(el('h4', null, 'Tags'));
    const w = el('div', 'tags');
    r.tags.forEach(tg => w.append(el('i', null, tg)));
    s.append(w);
    m.append(s);
  }

  const n = state.layout.items.length;
  $('#pos').innerHTML = (idx + 1) + ' <em>|</em> ' + n;
  $('#prev').disabled = idx === 0;
  $('#next').disabled = idx === n - 1;

  document.body.classList.add('reading');
  $('#l3').classList.add('on');
  $('#l3').setAttribute('aria-hidden', 'false');
  $('#cardbody').scrollTop = 0;
  autoScroll();
  $('#closeb').focus({ preventScroll: true });
}

function autoScroll() {
  cancelAnimationFrame(scrollRaf);
  const w = $('#cardbody');
  if (REDUCED) return;
  // only creep through a long statement — never scroll on into the metadata
  const limit = () => Math.max(0, Math.min(
    w.scrollHeight - w.clientHeight,
    $('.quotewrap').offsetHeight - w.clientHeight + 20));
  let stopped = false;
  const stop = () => { stopped = true; cancelAnimationFrame(scrollRaf); off(); };
  const off = () => ['wheel', 'touchstart', 'pointerdown', 'keydown'].forEach(e => w.removeEventListener(e, stop));
  ['wheel', 'touchstart', 'pointerdown', 'keydown'].forEach(e => w.addEventListener(e, stop, { passive: true }));

  const t0 = performance.now();
  const step = now => {
    if (stopped || !$('#l3').classList.contains('on')) return off();
    const over = limit();
    if (over < 6) return off();
    if (now - t0 > 1800) w.scrollTop = Math.min(over, (now - t0 - 1800) * 0.016);
    if (w.scrollTop >= over - 1) return off();
    scrollRaf = requestAnimationFrame(step);
  };
  scrollRaf = requestAnimationFrame(step);
}

function close() {
  cancelAnimationFrame(scrollRaf);
  document.body.classList.remove('reading');
  $('#l3').classList.remove('on');
  $('#l3').setAttribute('aria-hidden', 'true');
  const s = document.querySelector('.icard.sel');
  s?.classList.remove('sel');
  s?.focus({ preventScroll: true });
  state.sel = -1;
}
const page = d => {
  const i = state.sel + d;
  if (i >= 0 && i < state.layout.items.length) open(i);
};

function hideIntroPages() {
  INTRO_PAGES.forEach(p => { $('#' + p.id).style.display = 'none'; });
}

/* ─── TOP PAGE BAR ────────────────────────────────────── */
// One shared #pageBar (see index.template.html) rather than markup
// duplicated per page. Label text per step; NAV_SEQUENCE (INTRO_PAGES'
// own order, plus 'themes' tacked on the end) is what Back/Next walk —
// 'title' is deliberately absent from the labels, since the bar doesn't
// show there at all, but present in the sequence so Back from 'demogs'
// still has somewhere to go.
const NAV_BAR_LABELS = {
  demogs: 'Who participated?',
  groups: 'Opinion Groups',
  consensus: 'Consensus',
  themes: 'Data Explorer',
};
const NAV_SEQUENCE = INTRO_PAGES.map(p => p.key).concat('themes');
// the X/Y step count and progress fill are against just the bar-visible
// steps, not the full NAV_SEQUENCE (which also carries 'title')
const NAV_BAR_STEPS = NAV_SEQUENCE.filter(k => NAV_BAR_LABELS[k]);
let navBarShown = false, navBarRevealTimer = null;

// Called from every route() branch with that branch's actual resolved page
// key (not the raw, possibly-empty hash key) — a key with no label (title,
// or any L2 theme key) hides the bar; the reveal is delayed and only ever
// plays once per hidden→shown transition, matching "slides in once, then
// stays" rather than re-animating on every step between bar pages.
function updateNavBar(key) {
  const bar = $('#pageBar');
  const label = NAV_BAR_LABELS[key];
  if (!label) {
    bar.classList.remove('shown');
    document.body.classList.remove('navBarOn');
    bar.setAttribute('aria-hidden', 'true');
    clearTimeout(navBarRevealTimer);
    navBarShown = false;
    return;
  }
  const stepNum = NAV_BAR_STEPS.indexOf(key) + 1;
  $('#pageBarStep').textContent = stepNum + '/' + NAV_BAR_STEPS.length;
  $('#pageBarLabel').textContent = label;
  $('#pageBarProgressFill').style.width = (stepNum / NAV_BAR_STEPS.length * 100) + '%';
  $('#pageBarNext').disabled = NAV_SEQUENCE.indexOf(key) === NAV_SEQUENCE.length - 1;
  bar.setAttribute('aria-hidden', 'false');
  if (!navBarShown) {
    navBarShown = true;
    clearTimeout(navBarRevealTimer);
    navBarRevealTimer = setTimeout(() => {
      bar.classList.add('shown');
      document.body.classList.add('navBarOn');
    }, 500);
  }
}

function navBarStep(delta) {
  const currentKey = location.hash.replace(/^#\/?/, '').split('/')[0] || 'title';
  const idx = NAV_SEQUENCE.indexOf(currentKey);
  const next = idx > -1 && NAV_SEQUENCE[idx + delta];
  if (next) location.hash = '#/' + next;
}

/* ─── ROUTING ─────────────────────────────────────────── */
// The homepage is the bare root ("" / "#/") — the theme grid moved to its
// own named route, #/themes, rather than squatting on root the way it used
// to. "" resolves to INTRO_PAGES[0] (title) below, same as any unrecognized
// key: an unknown link falls back to the actual homepage, not the grid.
function route() {
  // #gdetail/#ddetail are floating overlays independent of whichever page
  // opened them (unlike #l3, which route() already closes per-branch below)
  // — without this they'd stay visibly open over whatever page you navigate
  // to next, since nothing else ever closes them. The demog hover tooltip
  // doesn't need this — it's nested inside #l0-demogs, so hideIntroPages()
  // already hides it along with the rest of that page — but clearing its
  // state too avoids it appearing "already open" if you navigate back.
  closeGroup();
  closeDemog();
  demogHoverShow(null);
  // no mode segment anymore — split()[0] also means an old bookmarked
  // #/{themeKey}/map (or /list, /quotes) link still lands on the right
  // theme; the trailing segment is simply ignored.
  const key = location.hash.replace(/^#\/?/, '').split('/')[0];

  if (key === 'themes') {
    close();
    updateNavBar('themes');
    document.body.classList.remove('groups-page');
    const back = state.theme !== null;
    hideIntroPages();
    $('#l2').classList.remove('on');
    $('#l2').setAttribute('aria-hidden', 'true');
    $('#l1').style.display = '';
    document.title = 'Bloom — A Conversation on AI in Central Oregon';
    document.documentElement.style.setProperty('--c', 'var(--home)');
    state.theme = null;
    if (back) scrollTo({ top: l1Scroll, behavior: 'auto' });
    return;
  }

  const t = byKey[key];
  if (!t) {
    const intro = INTRO_PAGES.find(p => p.key === key) || INTRO_PAGES[0];
    close();
    updateNavBar(intro.key);
    // only Groups is a white page — this is what keeps the desktop gutter
    // matched to whichever intro page is actually showing (see app.css)
    document.body.classList.toggle('groups-page', intro.key === 'groups');
    INTRO_PAGES.forEach(p => { $('#' + p.id).style.display = p === intro ? '' : 'none'; });
    $('#l1').style.display = 'none';
    $('#l2').classList.remove('on');
    $('#l2').setAttribute('aria-hidden', 'true');
    document.title = 'Bloom — A Conversation on AI in Central Oregon';
    // consensus's L3-modal-via-buildConsensus() needs --c set to something
    // other than the shared --home every other intro page uses — green,
    // same token .who.consensus's own background already means "agreement"
    document.documentElement.style.setProperty('--c', intro.key === 'consensus' ? 'var(--agree)' : 'var(--home)');
    $('#l3').style.setProperty('--c', intro.key === 'consensus' ? 'var(--agree)' : 'var(--home)');
    state.theme = null;
    // built lazily, on first arrival rather than at page load — buildConsensus()
    // measures real layout (the demographic-chip marquee) which needs
    // #l0-consensus to actually be visible, not the display:none it'd still be
    // at WIRE UP time
    if (intro.key === 'consensus') {
      if (!$('#consensusLane').childElementCount) buildConsensus();
    }
    return;
  }
  updateNavBar(t.key);
  document.body.classList.remove('groups-page');
  const themeChanged = state.theme !== t;
  state.theme = t;
  hideIntroPages();
  $('#l1').style.display = 'none';
  $('#l2').classList.add('on');
  $('#l2').setAttribute('aria-hidden', 'false');
  document.title = t.short + ' — Bloom';
  if (state.sel > -1) close();
  renderL2();
  if (themeChanged) scrollTo({ top: 0, behavior: 'auto' });
}

/* ─── WIRE UP ─────────────────────────────────────────── */
initDemogMap();
buildGroups();
buildL1();
$('#back').onclick = () => { location.hash = '#/themes'; };
$('#closeb').onclick = close;
$('#scrim').onclick = close;
$('#prev').onclick = () => page(-1);
$('#next').onclick = () => page(1);
$('#gCloseb').onclick = closeGroup;
$('#gscrim').onclick = closeGroup;
$('#gPrev').onclick = () => pageGroup(-1);
$('#gNext').onclick = () => pageGroup(1);
$('#demogLink').onclick = openDemog;
$('#dCloseb').onclick = closeDemog;
$('#dscrim').onclick = closeDemog;
$('#demogReset').onclick = resetDemogMap;
$('#diveIn').onclick = () => { location.hash = '#/demogs'; };
$('#pageBarBack').onclick = () => navBarStep(-1);
$('#pageBarNext').onclick = () => navBarStep(1);
addEventListener('keydown', e => {
  if ($('#ddetail').classList.contains('on')) {
    if (e.key === 'Escape') { closeDemog(); e.preventDefault(); }
    return;
  }
  if ($('#gdetail').classList.contains('on')) {
    if (e.key === 'Escape') { closeGroup(); e.preventDefault(); }
    if (e.key === 'ArrowRight') { pageGroup(1); e.preventDefault(); }
    if (e.key === 'ArrowLeft') { pageGroup(-1); e.preventDefault(); }
    return;
  }
  if (!$('#l3').classList.contains('on')) return;
  if (e.key === 'Escape') { close(); e.preventDefault(); }
  if (e.key === 'ArrowRight') { page(1); e.preventDefault(); }
  if (e.key === 'ArrowLeft') { page(-1); e.preventDefault(); }
});
addEventListener('hashchange', route);

// no rewrite needed on a fresh visit — route() already resolves an empty
// hash to the homepage (the first intro page) on its own
route();
})();
