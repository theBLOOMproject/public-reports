# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A single-page interactive report on the Bloom Project's public engagement (COCAP, Central
Oregon): six listening sessions plus one open Polis-style poll, sorted into eight themes.
It is published as a static GitHub Pages site — `main` deploys on push via
`.github/workflows/pages.yml`.

Note: this repo lives under `~/projects/bloom/` alongside the Civic OS subprojects, but it
is unrelated to them — the parent `CLAUDE.md` does not apply here.

## Commands

```sh
node build.js                                  # build dist/
node build.js && (cd dist && python3 -m http.server 8000)   # local preview at :8000
```

No package.json, no dependencies, no test suite, no linter. Node is used only for
`build.js` (stdlib `fs`/`path`).

## Build model

`build.js` string-replaces `<!--INJECT:{id}-->` placeholders in `index.template.html`,
writes `dist/index.html`, copies `static/`, and touches `.nojekyll`. The output is one
self-contained file — no external CSS or JS requests.

The `BLOCKS` map in `build.js` binds each placeholder id to a source file and a `kind`:

- `raw` (`src/app.css`, `src/app.js`) — inlined verbatim into the wrapping `<style>` /
  `<script>` tag, minus the file’s own trailing newline.
- `json` (`data/*.json`) — parsed, then re-serialized without indentation; that parse *is*
  both the minification and the validity check.

Adding a data file means adding a `BLOCKS` entry *and* a matching
`<script type="application/json" id="...">` element in the template. The build fails
loudly on a missing source file, a missing placeholder, an unreplaced placeholder, or
invalid JSON.

Two different escapes stop injected content from closing its own tag, and they are not
interchangeable. JSON gets every `<` rewritten as `\u003c` — safe because it is all
inside string literals. Source cannot take that blanket treatment (`a < b` would break), so
only the exact sequence `</script` / `</style` is neutralized to `<\/…`, which is
inert in every position JS or CSS actually allows it.

`dist/` is gitignored and rebuilt from scratch every time — never edit it, and never commit
it. Only what lands in `dist/` is public, which is why repo sources can stay in the repo.

## Architecture

`index.template.html` is markup only (~105 lines). All app code is **`src/app.js`** (~770
lines, one function) and all styling is **`src/app.css`** (~675 lines). There is no bundler,
framework, or module system — plain DOM APIs and a few helpers (the `$` / `el` / `esc`
trio at the top of app.js). Keep it that way; new UI goes in these same files.

`src/app.js` is sectioned by banner comments following the level structure below. If it is
ever split into real ES modules, note that the top-level reassigned `let`s (`bubbleTimer`,
`scrollRaf`, `scrubRaf`, `kivTimer`, `l1Scroll`, `listAsc`, the `preview*` flags) are shared
across those section boundaries, and an imported binding cannot be reassigned — each would
need an owning module or a shared state object.

Three nested levels, all in the one page:

- **L1 (`#l1`)** — theme grid, one block per theme, built by `buildL1()`.
- **L2 (`#l2`)** — one theme, with three tabs ("modes"): `map` (statements scattered on a
  vertical %-agreement axis), `list` (same statements and ordering as a card stack), and
  `quotes` (session quotes, which carry no vote). `renderL2()` dispatches to `drawLane()` /
  `drawList()` / `drawQuotes()`.
- **L3 (`#l3`)** — statement detail modal, `open()` / `close()` / `page(±1)`, keyboard
  Esc/←/→.

**Routing** is the URL hash: `#/{themeKey}/{mode}`, handled by `route()` on `hashchange`.
Navigation is done by assigning `location.hash`, not by calling render functions directly.

**Map-mode layout** is computed in `computeLayout()` — y from the score, size from vote
total, x randomly jittered with collision avoidance. Because x is random, layouts are
cached in `layoutCache` keyed by `theme/mode`; resizes and revisits must reuse the cache so
squares never reshuffle. The scroll-linked **scrub** line reads out the score at the current
scroll position, highlights the squares it crosses, and feeds the bottom-sheet **preview**
and the minimap marker (`updateScrub()`, rAF-throttled).

Tunable constants sit near the top of the script with comments: `MODES` (the map axis
scoring), `DIFFERENCE_MIN_GAP` / `CONSENSUS_MIN_AGREE` (thresholds behind the
consensus/difference pill in `pillInfoFor()`), `SCRUB_INSET`, and the clip lengths
`QUOTE_CLIP` / `PREVIEW_CLIP`.

## Data

`data/bloom-data.json` — `{ themes, records, groups }`.

- `themes[]`: `n` (1-based id used by `record.theme`), `key` (URL slug and lookup key in
  `byKey`), `short`/`full`, `color` (drives the `--c` CSS custom property and the
  `theme-color` meta), and precomputed `poll`/`quotes` counts shown in the header.
- `records[]`: `kind` is `poll` or `quote`. Poll records have `vote` with per-group `A`/`B`
  tallies plus derived `gap`, `minAgree`, `consensus`; quote records have `vote: null` and
  are therefore only ever reachable via the Quotes tab. `origin` is
  `participant` | `cocap_seed` | `listening_session` and selects the avatar emoji
  (`emojiFor()`); `chips[]` is raw ALL-CAPS metadata (demographics, session, date)
  title-cased at render time by `titleCaseChip()`.
- `groups`: labels for Polis groups A (skeptic-leaning) and B (optimist-leaning).

`data/theme-descriptions.json` — editorial prose keyed by theme `key`, rendered under the L2
header. Its `_readme` field documents provenance. Percentages in these descriptions are
hand-written and **not** recomputed by the app; verify any number you change against the
underlying statement.

Counts in `themes[].poll`/`.quotes` are likewise stored, not derived — keep them in sync
when adding or removing records.
