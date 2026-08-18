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
  both the minification and the validity check. An optional `check` on the `BLOCKS` entry
  runs against the parsed data for invariants the parse cannot see.

Adding a data file means adding a `BLOCKS` entry *and* a matching
`<script type="application/json" id="...">` element in the template. The build fails
loudly on a missing source file, a missing placeholder, an unreplaced placeholder,
invalid JSON, or a failed `check`.

Two different escapes stop injected content from closing its own tag, and they are not
interchangeable. JSON gets every `<` rewritten as `\u003c` — safe because it is all
inside string literals. Source cannot take that blanket treatment (`a < b` would break), so
only the exact sequence `</script` / `</style` is neutralized to `<\/…`, which is
inert in every position JS or CSS actually allows it.

`dist/` is gitignored and rebuilt from scratch every time — never edit it, and never commit
it. Only what lands in `dist/` is public, which is why repo sources can stay in the repo.

## Architecture

`index.template.html` is markup only (~100 lines). All app code is **`src/app.js`** (~475
lines, one function) and all styling is **`src/app.css`** (~450 lines). There is no bundler,
framework, or module system — plain DOM APIs and a few helpers (the `$` / `el` / `esc`
trio at the top of app.js). Keep it that way; new UI goes in these same files.

`src/app.js` is sectioned by banner comments following the level structure below. If it is
ever split into real ES modules, note that the top-level reassigned `let`s (`scrollRaf`,
`l1Scroll`, `carouselTimers`) are shared across those section boundaries, and an imported
binding cannot be reassigned — each would need an owning module or a shared state object.

Three nested levels, all in the one page:

- **L1 (`#l1`)** — theme grid, one block per theme, built by `buildL1()`.
- **L2 (`#l2`)** — one theme: a "What we learned" table of contents (`buildToc()`), a
  per-insight carousel of statement cards (`buildInsights()`, data from
  `bloom-insights.json`), and a flat "All Statements" list (`buildAllStatements()`) — all
  poll statements, sorted by %-agreement. Session quotes have no UI path here (see Data
  below). `renderL2()` computes the theme's polls and builds all three sections.
- **L3 (`#l3`)** — statement detail modal, `open()` / `close()` / `page(±1)`, keyboard
  Esc/←/→. A statement's card can appear twice on the page (its insight carousel and All
  Statements); `open()` marks every `.icard[data-rid]` instance selected.

**Routing** is the URL hash: `#/{themeKey}`, handled by `route()` on `hashchange` (a
trailing segment, e.g. from an old bookmarked link, is parsed but ignored). Navigation is
done by assigning `location.hash`, not by calling render functions directly.

Tunable constants sit near the top of the script with comments: `DIFFERENCE_MIN_GAP` /
`CONSENSUS_MIN_AGREE` (thresholds behind the consensus/difference pill in `pillInfoFor()`).

## Data

`data/bloom-data.json` — `{ themes, records, groups }`.

- `themes[]`: `key` (URL slug and lookup key in `byKey`), `short`/`full`, `color` (drives
  the `--c` CSS custom property and the `theme-color` meta), and `tags[]` — the tags whose
  presence puts a record in this theme.
- `records[]`: `kind` is `poll` or `quote`. Poll records have `vote` with per-group `A`/`B`
  tallies plus derived `gap`, `minAgree`, `consensus`; quote records have `vote: null`.
  **Quote records currently have no UI path at all** — `quotesOf()` is still defined and the
  L1 tally/legend still counts them, but L2 only ever builds poll statements. They stay in
  the data (not dropped) for a future feature. `origin` is
  `participant` | `cocap_seed` | `listening_session` and selects the avatar emoji
  (`emojiFor()`); `chips[]` is raw ALL-CAPS metadata (demographics, session, date)
  title-cased at render time by `titleCaseChip()`. `tags[]` is described below.
- `groups`: labels for Polis groups A (skeptic-leaning) and B (optimist-leaning).

`data/bloom-insights.json` — keyed by theme `key`, an ordered list of `{ claim, direction,
ids }` per theme (6 of 8 themes have entries; `access`/`privacy` don't, and render the L2
shell without a TOC/insights section). `ids` are full `bloom-data.json` record ids.
`direction` (`agree`/`disagree`/`divided`/`mixed`) plus `claim` feed `claimPhrase()`, which
generates both the TOC line and the carousel headline. `ids` can reference a record outside
the insight's own theme under the tag model (documented in the file's own `_readme`);
`renderL2()` appends any such record to the theme's paging order so it still opens and pages
in L3, without counting toward "All Statements". `build.js`'s `checkInsightIdsResolve`
fails the build if an id doesn't resolve against `bloom-data.json`.

### Themes are derived from tags

A record has no `theme` field. It belongs to **every** theme listing one of its tags, so
membership is derived (`recsOf()` in app.js) and **overlapping** — 10 records currently
sit in two themes, so the per-theme counts sum to 133 across 122 distinct records.

`themes[].tags` is the whole specification; nothing labels a tag as one kind or another.
22 of the 30 tags are listed by some theme. The other 8 — `Youth`, `AI Companies`,
`Government / Public Sector`, `Economic Benefit`, `Distribution of Public Benefits`,
`Positive Effects`, `Indigenous`, `Medicine` — are listed by none. They still render as
chips in the L3 modal, they just don't place a record. They went unlisted because they
name the actor, population or valence rather than the subject: `Youth` sits on statements
about therapy, chat-log privacy and the incoming workforce, none of which is schooling.

**Adding a record means giving it at least one tag some theme lists.** A record whose
tags no theme claims doesn't land in the wrong place, it vanishes from the report — so
`build.js` fails the build on it (`checkEveryRecordReachable`). Adding a *new* tag that
should place records means adding it to a theme's `tags` too, or it stays decorative.

Per-theme counts are derived at render time (`pollsOf()` / `quotesOf()`); there is
nothing to keep in sync when records are added or removed.

`data/theme-descriptions.json` — editorial prose keyed by theme `key`, rendered under the L2
header. Its `_readme` field documents provenance. Percentages in these descriptions are
hand-written and **not** recomputed by the app; verify any number you change against the
underlying statement.

Three fields are currently read by nothing: `themes[].full` (the long name — readers only
ever see `short`), `records[].source` and `records[].inReport`.
