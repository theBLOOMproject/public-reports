(() => {
'use strict';

const J = id => JSON.parse(document.getElementById(id).textContent);
const DATA = J('bloom-data');
const DESC = J('theme-descriptions');
const INSIGHTS = J('bloom-insights');
const GROUP_INFO = J('group-info');
const GROUP_STATEMENTS = J('group-statements');

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

/* ─── LEVEL 0 ─────────────────────────────────────────── */
// The ordered sequence of intro pages shown before the theme grid, each a
// plain <main class="introPage" id="..."> in the template. This array is
// the single source of truth for that order: route() shows/hides by walking
// it, the initial redirect below targets its first entry, and each page's
// .introNext arrow is wired to whichever entry comes right after its own —
// so reordering, inserting, or removing a page is a one-line change here
// (plus adding/removing the matching markup), never a hunt through route().
const INTRO_PAGES = [
  { key: 'title', id: 'l0-title' },
  { key: 'demogs', id: 'l0-demogs' },
  { key: 'groups', id: 'l0-groups' },
];

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
  const maxN = Math.max(...groups.map(g => g.participants || 0), 1);
  groups.forEach(g => {
    const row = el('button', 'gbubble');
    row.type = 'button';
    row.dataset.key = g.key;
    row.setAttribute('aria-label', groupTag(g) + ': ' + (g.participants || 0) + ' people — see defining statements');
    row.style.setProperty('--c', g.color || 'var(--home)');
    const scale = Math.sqrt((g.participants || 0) / maxN);
    const size = Math.round(84 + scale * 90);   // ~84–174px, scaled by relative headcount
    const av = el('div', 'gAv');
    av.style.setProperty('--sz', size + 'px');
    row.append(av);
    const label = el('div', 'gLabel');
    label.append(el('div', 'gName', groupTag(g)));
    label.append(el('div', 'gCount', (g.participants || 0) + ' people'));
    row.append(label);
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
    wrap.append(el('div', 'gdKicker label', 'Quick Description'));
    wrap.append(el('p', 'gdText', g.description || ''));
    body.append(wrap);
  } else {
    const r = byId[stmts[gstate.page - 1].id];
    const quotewrap = el('div', 'quotewrap');
    quotewrap.append(el('blockquote', null, '“' + r.text + '”'));
    body.append(quotewrap);
    // same per-group agree% breakdown L3 shows for any statement — reused
    // verbatim via groupsOf() so the two never drift apart in presentation
    const m = el('div', 'meta');
    const p = el('section');
    p.append(el('h4', null, 'Open poll responses · ' + r.vote.total + ' votes'));
    groupsOf(r.vote).forEach(gr => {
      const row = el('div', 'grow');
      const top = el('div', 'top');
      top.append(el('span', null, gr.label));
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
    const key = el('div', 'barkey');
    [['d', 'Disagree'], ['p', 'Pass'], ['a', 'Agree']].forEach(([c, l]) => {
      const s = el('span'); s.append(el('i', c)); s.append(document.createTextNode(l)); key.append(s);
    });
    p.append(key);
    m.append(p);
    body.append(m);
  }

  $('#gPos').innerHTML = (gstate.page + 1) + ' <em>|</em> ' + total;
  $('#gPrev').disabled = gstate.page === 0;
  $('#gNext').disabled = gstate.page === total - 1;
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
  // insight's carousel, once in All Statements) — mark every instance
  document.querySelectorAll('.icard.sel').forEach(n => n.classList.remove('sel'));
  document.querySelectorAll(`.icard[data-rid="${r.id}"]`).forEach(n => n.classList.add('sel'));

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

/* ─── ROUTING ─────────────────────────────────────────── */
// The homepage is the bare root ("" / "#/") — the theme grid moved to its
// own named route, #/themes, rather than squatting on root the way it used
// to. "" resolves to INTRO_PAGES[0] (title) below, same as any unrecognized
// key: an unknown link falls back to the actual homepage, not the grid.
function route() {
  // no mode segment anymore — split()[0] also means an old bookmarked
  // #/{themeKey}/map (or /list, /quotes) link still lands on the right
  // theme; the trailing segment is simply ignored.
  const key = location.hash.replace(/^#\/?/, '').split('/')[0];

  if (key === 'themes') {
    close();
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
    // only Groups is a white page — this is what keeps the desktop gutter
    // matched to whichever intro page is actually showing (see app.css)
    document.body.classList.toggle('groups-page', intro.key === 'groups');
    INTRO_PAGES.forEach(p => { $('#' + p.id).style.display = p === intro ? '' : 'none'; });
    $('#l1').style.display = 'none';
    $('#l2').classList.remove('on');
    $('#l2').setAttribute('aria-hidden', 'true');
    document.title = 'Bloom — A Conversation on AI in Central Oregon';
    document.documentElement.style.setProperty('--c', 'var(--home)');
    state.theme = null;
    return;
  }
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
buildGroups();
buildL1();
// each .introNext just advances to whatever INTRO_PAGES says comes after
// its own page — reordering/adding a page here needs no per-button wiring
INTRO_PAGES.forEach((p, i) => {
  const btn = document.querySelector(`#${p.id} .introNext`);
  const next = INTRO_PAGES[i + 1];
  // past the last intro page (Groups), "next" is the theme grid, at its own
  // named route rather than root — root is the homepage now, not the grid
  if (btn) btn.onclick = () => { location.hash = next ? '#/' + next.key : '#/themes'; };
});
$('#back').onclick = () => { location.hash = '#/themes'; };
$('#closeb').onclick = close;
$('#scrim').onclick = close;
$('#prev').onclick = () => page(-1);
$('#next').onclick = () => page(1);
$('#gCloseb').onclick = closeGroup;
$('#gscrim').onclick = closeGroup;
$('#gPrev').onclick = () => pageGroup(-1);
$('#gNext').onclick = () => pageGroup(1);
addEventListener('keydown', e => {
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
