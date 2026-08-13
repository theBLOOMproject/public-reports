(() => {
'use strict';

const J = id => JSON.parse(document.getElementById(id).textContent);
const DATA = J('bloom-data');
const DESC = J('theme-descriptions');

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
const recsOf = t => DATA.records.filter(r => r.theme === t.n);

// The Map tab's one axis over the poll statements. List mode reuses this
// same score to sort its cards, just renders them differently. Session
// quotes carry no vote, so they only ever appear under the Quotes tab.
const MODES = {
  map: { score: r => r.vote.minAgree, max: () => 100, tick: v => v + '% AGREE' }
};
// short readout for the scrub pill — the axis row already spells the unit out in full
const SCRUB_TICK = { map: v => v + '%' };
const SCRUB_INSET = 70;   // px reserved on the left of the lane so squares clear the scrub pill

// thresholds for the statement-card indicator pill (consensus/difference/neutral)
const DIFFERENCE_MIN_GAP = 35;    // group-to-group gap (points) counted as a real split
const CONSENSUS_MIN_AGREE = 65;   // minAgree (%) counted as both groups genuinely on board

// shared by the statement modal's pill and the List card's bar-top pill
const pillInfoFor = v => {
  if (v.gap >= DIFFERENCE_MIN_GAP)
    return { cls: 'difference', icon: 'static/difference.svg', label: 'DIFFERENCE (' + v.gap + ' PTS)' };
  if (v.minAgree >= CONSENSUS_MIN_AGREE)
    return { cls: 'consensus', icon: 'static/consensus.svg', label: 'CONSENSUS (' + v.minAgree + '% PRO)' };
  return { cls: 'neutral', icon: null, label: v.minAgree + '% AGREE' };
};

const state = { theme: null, mode: 'list', sel: -1, layout: [] };
let bubbleTimer = null, scrollRaf = null, l1Scroll = 0, kivTimer = null, scrubRaf = null;
let listAsc = false;   // List tab sort direction — toggled by the "Switch order" button
// square placement is randomized (jittered scatter, collision avoidance), so it's
// computed once per theme/mode and cached — revisiting, switching modes back and
// forth, or a resize (e.g. mobile browser chrome collapsing) must not reshuffle it
const layoutCache = {};

/* ─── LEVEL 1 ─────────────────────────────────────────── */
function buildL1() {
  const wrap = $('#blocks');
  DATA.themes.forEach((t, ti) => {
    const b = el('button', 'theme-block');
    b.style.setProperty('--c', t.color);
    b.setAttribute('aria-label', `${t.short}: ${t.poll + t.quotes} perspectives`);
    b.append(el('span', 'arrow', '→'));
    b.append(el('h2', null, t.short));
    const n = t.poll + t.quotes;
    b.append(el('div', 'count label',
      `${t.poll} statement${t.poll === 1 ? '' : 's'} · ${t.quotes} quote${t.quotes === 1 ? '' : 's'}`));
    const tal = el('div', 'tally');
    tal.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < n; i++) {
      const c = el('i', i >= t.poll ? 'q' : null);
      c.style.animationDelay = (ti * 70 + i * 16) + 'ms';
      tal.append(c);
    }
    b.append(tal);
    b.onclick = () => { l1Scroll = scrollY; location.hash = '#/' + t.key; };
    wrap.append(b);
  });
}

/* ─── LAYOUT ──────────────────────────────────────────── */
function computeLayout(theme, mode) {
  // session quotes live in their own Quotes tab now — only poll statements
  // ever get plotted on the lane's axis
  const M = MODES[mode];
  const polls = recsOf(theme).filter(r => r.vote).sort((a, b) => M.score(b) - M.score(a) || b.vote.total - a.vote.total);

  const smax = M.max(polls);
  const W = $('#lane').clientWidth || 360;
  const TOP = 40, BOT = 54;
  const axisH = Math.max(300, polls.length * 62);
  const height = TOP + axisH + BOT;

  const MAXSQ = Math.max(46, Math.min(68, innerHeight * 0.09));
  const placed = [];

  const put = (r, y, size) => {
    let x = 0, ok = false;
    for (let k = 0; k < 18 && !ok; k++) {
      x = SCRUB_INSET + 6 + Math.random() * Math.max(1, W - size - 12 - SCRUB_INSET);
      ok = !placed.some(p =>
        Math.abs(p.y + p.size / 2 - (y + size / 2)) < (p.size + size) / 2 + 7 &&
        Math.abs(p.x + p.size / 2 - (x + size / 2)) < (p.size + size) / 2 + 7);
    }
    const item = { rec: r, x, y, size };
    placed.push(item);
    return item;
  };

  polls.forEach(r => {
    const sc = Math.max(0, Math.min(100, M.score(r) / smax * 100));
    const size = Math.round(32 + (MAXSQ - 32) * Math.sqrt(Math.min(r.vote.total, 250) / 250));
    put(r, TOP + (1 - sc / 100) * axisH - size / 2, size);
  });

  placed.sort((a, b) => a.y - b.y);   // paging follows the lane, top to bottom
  return { items: placed, height, TOP, axisH, W, smax };
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
  $('#t-count').textContent =
    `${t.poll} statement${t.poll === 1 ? '' : 's'} · ${t.quotes} quote${t.quotes === 1 ? '' : 's'}`;
  const d = (DESC.themes && DESC.themes[t.key]) || {};
  $('#t-desc').textContent = d.description || '';

  const i = DATA.themes.indexOf(t);
  const nx = DATA.themes[(i + 1) % DATA.themes.length];
  $('#nextT').innerHTML = 'Go to <b>' + esc(nx.short) + '</b> →';
  $('#nextT').onclick = () => { location.hash = '#/' + nx.key; };

  document.querySelectorAll('.pills button').forEach(b =>
    b.setAttribute('aria-pressed', String(b.dataset.mode === state.mode)));

  if (state.mode === 'quotes') drawQuotes();
  else if (state.mode === 'list') drawList();
  else drawLane();
}

// how far down the nav + pills bar together push everything below them —
// shared by anything that sticks just underneath both (minimap, order bar)
const chromeH = () => $('.l2nav').offsetHeight + $('.pills').offsetHeight;

// ~3 lines of the card's quote font, word-truncated with our own ellipsis
// (a line-clamp is also set in CSS as a safety net for narrower screens)
const QUOTE_CLIP = 185;
function clip(text, max) {
  const words = text.split(/\s+/);
  let s = '', i = 0;
  while (i < words.length && (s + (s ? ' ' : '') + words[i]).length <= max) s += (s ? ' ' : '') + words[i++];
  return i < words.length ? s + '…' : s;
}

function drawQuotes() {
  clearInterval(bubbleTimer);
  updatePreview([]);   // no scrub/axis in quotes mode, so nothing can be "hit"
  const lane = $('#lane');
  lane.innerHTML = '';
  lane.classList.remove('listView');
  lane.classList.add('quotesList');
  lane.style.height = '';
  const quotes = recsOf(state.theme).filter(r => !r.vote);
  state.layout = { items: quotes.map(r => ({ rec: r })) };

  quotes.forEach((r, idx) => {
    const card = el('button', 'qcard');
    card.dataset.i = idx;
    card.append(el('div', 'qeyebrow label', r.source));
    card.append(el('p', 'qtext', '“' + clip(r.text, QUOTE_CLIP) + '”'));
    card.onclick = () => open(idx);
    lane.append(card);
  });

  $('#laneEnd').textContent = quotes.length
    ? quotes.length + ' quote' + (quotes.length === 1 ? '' : 's') + ' in this theme'
    : 'No session quotes recorded for this theme';
}

// LIST mode — same poll statements and ordering as the Map tab, just
// laid out as a plain card stack (à la Quotes) instead of scattered on
// an axis: full untruncated text, an emoji icon, and a tiered score pill.
function drawList() {
  clearInterval(bubbleTimer);
  updatePreview([]);   // no scrub/axis in list mode, so nothing can be "hit"
  const lane = $('#lane');
  lane.innerHTML = '';
  lane.classList.remove('quotesList');
  lane.classList.add('listView');
  lane.style.height = '';
  const M = MODES.map;
  const dir = listAsc ? -1 : 1;
  const polls = recsOf(state.theme).filter(r => r.vote)
    .sort((a, b) => dir * (M.score(b) - M.score(a)) || b.vote.total - a.vote.total);
  state.layout = { items: polls.map(r => ({ rec: r })) };

  const topRow = el('div', 'listTop');
  const orderBtn = el('button', 'orderSwitch', 'Switch order');
  orderBtn.onclick = () => { listAsc = !listAsc; drawList(); };
  const key = el('div', 'listKey');
  key.append(
    el('span', 'lKeySq', 'A'), document.createTextNode('= Skeptics;'),
    el('span', 'lKeySq', 'B'), document.createTextNode('= Optimists'));
  topRow.append(orderBtn, key);
  lane.append(topRow);
  const setTopRowTop = () => { topRow.style.top = chromeH() + 'px'; };
  setTopRowTop();
  document.fonts.ready.then(setTopRowTop);   // web-font swap can nudge pills' height by a px after first paint

  polls.forEach((r, idx) => {
    const card = el('button', 'lcard');
    card.dataset.i = idx;

    // eyebrow: who said it — emoji plus their demographic chips (or
    // "Host statement" for COCAP-seeded statements with no participant)
    const who = el('div', 'lWho');
    who.append(el('span', 'lEmoji', emojiFor(r)));
    const demoWrap = el('div', 'lDemoWrap');
    // "Not Provided" is a placeholder for a field the participant skipped,
    // not a real demographic — drop it rather than display it verbatim
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

    // bottom viz: each group's agree% mapped onto a disagree→agree track.
    // Labels live in the card's normal flow, uncolored; only the track
    // itself (line, squares, midpoint) sits inside the tinted bar.
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
    const edgeLo = el('span', 'lBarEdge lo', '0%');
    const edgeHi = el('span', 'lBarEdge hi', '100%');
    const mid = el('div', 'lBarMid');
    const line = el('div', 'lBarLine');
    const sqA = el('div', 'lBarSq', 'A');
    const sqB = el('div', 'lBarSq', 'B');
    track.append(edgeLo, edgeHi, mid, line, sqA, sqB);
    barWrap.append(track);
    card.append(barWrap);

    card.onclick = () => open(idx);
    lane.append(card);

    // the two squares + connecting line need the track's real rendered
    // width, so this only makes sense once the card is actually in the DOM
    const HALF_SQ = 13;
    const w = track.clientWidth;
    const xFor = pct => HALF_SQ + (w - HALF_SQ * 2) * Math.max(0, Math.min(100, pct)) / 100;
    const xA = xFor(r.vote.A.pct), xB = xFor(r.vote.B.pct);
    sqA.style.left = xA + 'px';
    sqB.style.left = xB + 'px';
    line.style.left = Math.min(xA, xB) + 'px';
    line.style.width = Math.abs(xA - xB) + 'px';

    // marquee the demographic line only if it's actually too long to fit,
    // and only if the user hasn't asked for reduced motion
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

  $('#laneEnd').textContent = polls.length + ' perspectives in this theme';
}

function drawLane() {
  const lane = $('#lane');
  lane.innerHTML = '';
  lane.classList.remove('quotesList', 'listView');
  const key = state.theme.key + '/' + state.mode;
  const L = layoutCache[key] || (layoutCache[key] = computeLayout(state.theme, state.mode));
  state.layout = L;
  lane.style.height = L.height + 'px';

  // scrub and minimap both anchor at the top score line and stick
  // independently at their own offsets — each needs the whole (very
  // tall) .lane as its containing block for that to hold for the full
  // scroll, so both stay direct children of .lane rather than sharing
  // a short wrapper. minimap is pulled back up to the same y via a
  // negative margin sized to scrub's own fixed height (--scrub-h) —
  // not a measured one, since scrub's pill text isn't set until
  // updateScrub() runs further down, which would measure it empty.
  const scrub = el('div', 'scrub');
  scrub.style.marginTop = L.TOP + 'px';
  scrub.setAttribute('aria-hidden', 'true');
  const pill = el('span', 'pill'); pill.id = 'scrubVal';
  scrub.append(pill, el('span', 'line'));
  lane.append(scrub);

  const mini = el('div', 'minimap');
  mini.style.marginTop = 'calc(-1 * var(--scrub-h))';
  mini.setAttribute('aria-hidden', 'true');
  // sticks below both headers (nav + pills); fills the rest of the
  // viewport, but never taller than the axis it's condensing. Set once
  // now and again on the next frame — on a cold first paint the nav/
  // pills heights can read a px short before layout fully settles.
  const sizeMini = () => {
    const topOffset = chromeH();
    const available = innerHeight - topOffset - 24;
    mini.style.top = topOffset + 'px';
    mini.style.height = Math.max(120, Math.min(available, L.axisH)) + 'px';
  };
  sizeMini();
  document.fonts.ready.then(sizeMini);   // web-font swap can nudge pills' height by a px after first paint
  L.items.forEach(it => {
    const frac = Math.max(0, Math.min(1, (it.y - L.TOP) / L.axisH));
    const tick = el('i');
    tick.style.top = (frac * 100) + '%';
    mini.append(tick);
  });
  const marker = el('div', 'now'); marker.id = 'miniNow';
  mini.append(marker);
  lane.append(mini);

  // axis
  const tick = MODES[state.mode].tick;
  [100, 75, 50, 25, 0].forEach(v => {
    const row = el('div', 'axisrow');
    row.style.top = (L.TOP + (1 - v / 100) * L.axisH) + 'px';
    row.append(el('span', null, tick(Math.round(L.smax * v / 100))));
    lane.append(row);
  });
  // squares
  L.items.forEach((it, idx) => {
    const b = el('button', 'sq');
    b.style.cssText = `left:${it.x}px;top:${it.y}px;width:${it.size}px;height:${it.size}px`;
    b.dataset.i = idx;
    b.setAttribute('aria-label', 'Poll statement: ' + it.rec.text.slice(0, 70) + '…');
    const f = el('span', 'face', emojiFor(it.rec));
    f.style.fontSize = Math.round(it.size * 0.56) + 'px';
    if (!REDUCED) {
      f.style.setProperty('--dur', (2.2 + Math.random() * 1.7).toFixed(2) + 's');
      f.style.setProperty('--del', (-Math.random() * 5).toFixed(2) + 's');
    } else { f.style.animation = 'none'; }
    b.append(f);
    b.onclick = () => open(idx);
    // hovering (mouse/trackpad users) also surfaces the preview, same as
    // the scrub crossing it — pause the auto-cycle while hovered, then
    // hand control back to whatever the indicator actually reflects
    b.addEventListener('mouseenter', () => previewHover(idx));
    b.addEventListener('mouseleave', previewHoverEnd);
    lane.append(b);
  });

  $('#laneEnd').textContent = L.items.length + ' perspectives in this theme';

  // startBubbles();   // ambient preview bubbles — suppressed for now, not removed
  updateScrub();
}

/* ─── SCRUB ───────────────────────────────────────────── */
// The scrub's own position is native CSS sticky — it just lives at the
// max line until the scroll would carry it above mid-screen, then holds
// there. All this does is read back wherever the browser actually put
// it and label it with the axis value at that point.
function updateScrub() {
  if (!$('#l2').classList.contains('on') || !state.layout) return;
  const L = state.layout;
  const scrub = $('#lane .scrub');
  const line = $('#lane .scrub .line');
  if (!scrub || !line) return;
  const laneTop = $('#lane').getBoundingClientRect().top;
  const localY = scrub.getBoundingClientRect().top - laneTop;
  const frac = Math.max(0, Math.min(1, 1 - (localY - L.TOP) / L.axisH));
  const val = Math.round(L.smax * frac);
  $('#scrubVal').textContent = SCRUB_TICK[state.mode](val);

  // highlight whichever square(s) the line is actually crossing
  const lineRect = line.getBoundingClientRect();
  const lineY = lineRect.top + lineRect.height / 2 - laneTop;
  const hitIdxs = [];
  document.querySelectorAll('#lane .sq').forEach(n => {
    const idx = +n.dataset.i;
    const it = L.items[idx];
    const hit = lineY >= it.y && lineY <= it.y + it.size;
    n.classList.toggle('hit', hit);
    if (hit) hitIdxs.push(idx);
  });
  updatePreview(hitIdxs);

  // mirror the same position onto the minimap's "you are here" marker
  const marker = $('#miniNow');
  if (marker) marker.style.top = ((1 - frac) * 100) + '%';
}
addEventListener('scroll', () => {
  if (scrubRaf) return;
  scrubRaf = requestAnimationFrame(() => { scrubRaf = null; updateScrub(); });
}, { passive: true });

/* ─── STATEMENT PREVIEW (bottom sheet) ───────────────────
   Previews whichever statement(s) the scrub line is crossing. Slides
   up from the bottom the first time it has something to show, then —
   per design — never slides away again: it just fades to transparent
   when nothing's currently highlighted, and back in when something is.
   With more than one hit at once, it cycles between them. */
let previewShown = false, previewTimer = null, previewCycle = 0, previewHovering = false;
const PREVIEW_CLIP = 120;   // ~2 lines at the card's text size

function revealPreview() {
  const wrap = $('#statPreview');
  wrap.classList.remove('empty');
  if (!previewShown) {
    previewShown = true;
    wrap.hidden = false;
    requestAnimationFrame(() => wrap.classList.add('shown'));
  }
}

function updatePreview(hitIdxs) {
  if (previewHovering) return;   // hover has taken the wheel — leave it alone
  const wrap = $('#statPreview');
  if (!hitIdxs.length) {
    clearInterval(previewTimer);
    if (previewShown) wrap.classList.add('empty');
    return;
  }
  revealPreview();

  previewCycle %= hitIdxs.length;
  renderPreviewItem(hitIdxs[previewCycle]);

  clearInterval(previewTimer);
  if (hitIdxs.length > 1) {
    previewTimer = setInterval(() => {
      previewCycle = (previewCycle + 1) % hitIdxs.length;
      renderPreviewItem(hitIdxs[previewCycle]);
    }, 5000);
  }
}

function renderPreviewItem(idx) {
  const r = state.layout.items[idx].rec;
  const v = r.vote;
  $('#spAv').textContent = emojiFor(r);
  $('#spEyebrow').textContent = v.minAgree + '% AGREEMENT';
  $('#spText').textContent = clip(r.text, PREVIEW_CLIP);
  $('#spCard').onclick = () => open(idx);
}

// hovering a circle previews it directly, overriding the scrub-driven
// cycling until the mouse leaves, at which point updateScrub() takes
// the wheel back and restores whatever the indicator actually reflects
function previewHover(idx) {
  previewHovering = true;
  clearInterval(previewTimer);
  revealPreview();
  renderPreviewItem(idx);
}
function previewHoverEnd() {
  previewHovering = false;
  updateScrub();
}

/* ─── AMBIENT PREVIEW BUBBLES ─────────────────────────── */
const bubbles = [];
function startBubbles() {
  clearInterval(bubbleTimer);
  bubbles.splice(0).forEach(b => b.remove());
  $('#lane').classList.remove('bubbling');
  if (REDUCED) return;
  bubbleTimer = setInterval(tick, 5000);
  setTimeout(tick, 1400);

  function tick() {
    if (!$('#l2').classList.contains('on') || $('#l3').classList.contains('on')) return;
    const nodes = [...document.querySelectorAll('.sq')].filter(n => {
      const r = n.getBoundingClientRect();
      return r.top > 40 && r.bottom < innerHeight - 20;
    });
    if (!nodes.length) return;

    // two or three at once, in and out together
    const pool = nodes.slice().sort(() => Math.random() - .5);
    const count = Math.min(pool.length, 2 + (Math.random() < .5 ? 1 : 0));
    const made = [];
    for (const n of pool) {
      if (made.length >= count) break;
      const it = state.layout.items[+n.dataset.i];
      if (made.some(m => Math.abs(m.it.y - it.y) < 46)) continue;   // no crowding
      const words = it.rec.text.split(/\s+/);
      let s = '', i = 0;
      while (i < words.length && (s + words[i]).length < 40) s += (s ? ' ' : '') + words[i++];
      const bub = el('div', 'bubble', '“' + s + (i < words.length ? '…' : '') + '”');
      bub.style.top = (it.y + it.size * .34) + 'px';           // sits over the square
      // clamp against the bubble's own CSS max-width (210px) — not a
      // guess at its rendered width — so it can never push past either
      // edge of the lane and force mobile browsers to zoom the page out
      const left = Math.max(4, Math.min(it.x + it.size * .3, state.layout.W - 214));
      bub.style.left = left + 'px';
      $('#lane').append(bub);
      made.push({ it, n });
      bubbles.push(bub);
    }
    if (!made.length) return;
    const lane = $('#lane');
    lane.classList.add('bubbling');
    made.forEach(m => m.n.classList.add('hl'));
    requestAnimationFrame(() => bubbles.forEach(b => b.classList.add('in')));
    setTimeout(() => {
      const batch = bubbles.splice(0);
      batch.forEach(b => b.classList.remove('in'));
      lane.classList.remove('bubbling');
      made.forEach(m => m.n.classList.remove('hl'));
      setTimeout(() => batch.forEach(b => b.remove()), 340);
    }, 3200);
  }
}

/* ─── LEVEL 3 ─────────────────────────────────────────── */
function open(idx) {
  state.sel = idx;
  const it = state.layout.items[idx];
  const r = it.rec;
  const t = state.theme;

  const itemSel = state.mode === 'quotes' ? '.qcard' : state.mode === 'list' ? '.lcard' : '.sq';
  document.querySelectorAll(itemSel + '.sel').forEach(n => n.classList.remove('sel'));
  document.querySelector(`${itemSel}[data-i="${idx}"]`)?.classList.add('sel');

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
    [['A', 'Group A (skeptic-leaning)'], ['B', 'Group B (optimist-leaning)']].forEach(([k, lab]) => {
      const g = r.vote[k], row = el('div', 'grow');
      const top = el('div', 'top');
      top.append(el('span', null, lab));
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
  if (state.mode === 'map') keepInView(it);
  $('#closeb').focus({ preventScroll: true });
}

// Slide the lane so the chosen square sits in the strip of colour left
// visible above the centred card.
function keepInView(it) {
  const laneTop = $('#lane').offsetTop;
  const strip = Math.max(40, document.querySelector('.card').getBoundingClientRect().top);
  const want = Math.max(9, (strip - it.size) / 2);
  const top = Math.max(0, laneTop + it.y - want);
  scrollTo({ top, behavior: REDUCED ? 'auto' : 'smooth' });
  // smooth scrolling doesn't always land exactly — nudge once it settles
  const settle = () => {
    const n = document.querySelector('.sq.sel');
    if (n && Math.abs(n.getBoundingClientRect().top - want) > 3)
      scrollTo({ top, behavior: 'auto' });
  };
  clearTimeout(kivTimer);
  if ('onscrollend' in window) addEventListener('scrollend', settle, { once: true });
  else kivTimer = setTimeout(settle, 620);
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
  clearTimeout(kivTimer);
  cancelAnimationFrame(scrollRaf);
  document.body.classList.remove('reading');
  $('#l3').classList.remove('on');
  $('#l3').setAttribute('aria-hidden', 'true');
  const s = document.querySelector('.sq.sel, .qcard.sel, .lcard.sel');
  s?.classList.remove('sel');
  s?.focus({ preventScroll: true });
  state.sel = -1;
}
const page = d => {
  const i = state.sel + d;
  if (i >= 0 && i < state.layout.items.length) open(i);
};

/* ─── ROUTING ─────────────────────────────────────────── */
function route() {
  const parts = location.hash.replace(/^#\/?/, '').split('/');
  const key = parts[0], mode = parts[1];
  const t = byKey[key];
  if (!t) {
    clearInterval(bubbleTimer); close();
    const back = state.theme !== null;
    $('#l2').classList.remove('on');
    $('#l2').setAttribute('aria-hidden', 'true');
    $('#l1').style.display = '';
    document.title = 'Bloom — A Conversation on AI in Central Oregon';
    document.documentElement.style.setProperty('--c', 'var(--home)');
    state.theme = null;
    if (back) scrollTo({ top: l1Scroll, behavior: 'auto' });
    return;
  }
  const themeChanged = state.theme !== t;
  const changed = themeChanged || (mode && mode !== state.mode);
  state.theme = t;
  if (mode && (MODES[mode] || mode === 'quotes' || mode === 'list')) state.mode = mode;
  else if (themeChanged) state.mode = 'list';   // every theme starts on List unless the link says otherwise
  $('#l1').style.display = 'none';
  $('#l2').classList.add('on');
  $('#l2').setAttribute('aria-hidden', 'false');
  document.title = t.short + ' — Bloom';
  if (state.sel > -1) close();
  renderL2();
  if (changed) scrollTo({ top: 0, behavior: 'auto' });
}

/* ─── WIRE UP ─────────────────────────────────────────── */
buildL1();
$('#back').onclick = () => { location.hash = '#/'; };
$('#closeb').onclick = close;
$('#scrim').onclick = close;
$('#prev').onclick = () => page(-1);
$('#next').onclick = () => page(1);
document.querySelectorAll('.pills button').forEach(b => b.onclick = () => {
  state.mode = b.dataset.mode;
  location.hash = '#/' + state.theme.key + '/' + state.mode;
  renderL2();
});
addEventListener('keydown', e => {
  if (!$('#l3').classList.contains('on')) return;
  if (e.key === 'Escape') { close(); e.preventDefault(); }
  if (e.key === 'ArrowRight') { page(1); e.preventDefault(); }
  if (e.key === 'ArrowLeft') { page(-1); e.preventDefault(); }
});
addEventListener('hashchange', route);

let rw;
addEventListener('resize', () => {
  clearTimeout(rw);
  rw = setTimeout(() => {
    if (!$('#l2').classList.contains('on')) return;
    const s = state.sel;
    if (state.mode === 'quotes') drawQuotes();
    else if (state.mode === 'list') drawList();
    else drawLane();
    if (s > -1) open(s);
  }, 220);
});

route();
})();
