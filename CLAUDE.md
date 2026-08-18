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

node scripts/refresh-poll.js --help                   # options, and what it will/won't touch
node scripts/refresh-poll.js --step <uuid>            # pull fresh votes from Polis
node scripts/refresh-poll.js --step <uuid> --dry-run  # report what would change; snapshot it
node scripts/refresh-poll.js --from <snapshot.json>   # apply a saved payload, no network
```

No package.json, no dependencies, no test suite, no linter. Node is used only for
`build.js` and `scripts/refresh-poll.js` (stdlib `fs`/`path`, plus the global `fetch`).

## Build model

`build.js` string-replaces `<!--INJECT:{id}-->` placeholders in `index.template.html`,
writes `dist/index.html`, copies `static/`, and touches `.nojekyll`. The output is one
self-contained file — no external CSS or JS requests.

The `BLOCKS` map in `build.js` binds each placeholder id to a source file and a `kind`:

- `raw` (`src/app.css`, `src/app.js`) — inlined verbatim into the wrapping `<style>` /
  `<script>` tag, minus the file’s own trailing newline.
- `json` (`data/*.json`) — parsed, then re-serialized without indentation; that parse *is*
  both the minification and the validity check. An optional `check` on the `BLOCKS` entry
  runs against the parsed data for invariants the parse cannot see; a check may warn and
  let the build through (`checkEveryRecordReachable`) or throw (`checkVoteIntegrity`).

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

`index.template.html` is markup only (~105 lines). All app code is **`src/app.js`** (~815
lines, one function) and all styling is **`src/app.css`** (~680 lines). There is no bundler,
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

- `themes[]`: `key` (URL slug and lookup key in `byKey`), `short`/`full`, `color` (drives
  the `--c` CSS custom property and the `theme-color` meta), and `tags[]` — the tags whose
  presence puts a record in this theme.
- `records[]`: `kind` is `poll` or `quote`. Poll records have `vote` with one tally block
  per group key (`vote.A`, `vote.B`, …) plus derived `total`, `gap`, `minAgree` and
  `consensus`; quote records have `vote: null` and are therefore only ever reachable via
  the Quotes tab. `origin` is
  `participant` | `cocap_seed` | `listening_session` and selects the avatar emoji
  (`emojiFor()`); `chips[]` is raw ALL-CAPS metadata (demographics, session, date)
  title-cased at render time by `titleCaseChip()`. `tags[]` is described below.
- `groups[]`: the poll's opinion clusters, in render order — `key` (the `vote` key and the
  letter on the square), `label` (editorial, shown in the L3 modal and expanded into the
  List tab's key row by `groupTag()`), `members`. **However many Polis returns**: it
  re-clusters as votes arrive, so neither the count nor the meaning of any one letter is
  stable across refreshes. Nothing in `app.js` may assume two. See "Refreshing the poll".

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
`build.js` names it in a warning (`checkEveryRecordReachable`) and builds anyway. Adding a
*new* tag that should place records means adding it to a theme's `tags` too, or it stays
decorative.

That check used to fail the build. It doesn't, because the invariant was never a property
of the data: the source spreadsheet had untagged rows, and every record satisfies it today
only because the tags were hand-backfilled in b410daf when themes moved from a fixed
`theme` field to derived membership. Statements arriving from a refresh have no tags at
all — tags are editorial and exist nowhere upstream, least of all in comhairle's
`polis_statement_aux.themes`, which is **not** canonical for this report.

Per-theme counts are derived at render time (`pollsOf()` / `quotesOf()`); there is
nothing to keep in sync when records are added or removed.

`data/theme-descriptions.json` — editorial prose keyed by theme `key`, rendered under the L2
header. Its `_readme` field documents provenance. Percentages in these descriptions are
hand-written and **not** recomputed by the app; verify any number you change against the
underlying statement.

Three fields are currently read by nothing: `themes[].full` (the long name — readers only
ever see `short`), `records[].source` and `records[].inReport`. (`groups` used to be a
fourth; the group labels were hardcoded in `app.js` until the N-cluster work, which meant
editing them changed nothing on screen.)

### Refreshing the poll

`node scripts/refresh-poll.js --step <workflow-step-uuid>` rewrites every poll record's
`vote` and the `groups` array from Polis, via comhairle's
`GET /tools/polis/report_data` (that route has no auth check, so no credentials are
involved). `--help` documents every flag.

Every live fetch saves the raw payload to `data/polis-snapshots/` — kept in the repo as the
provenance record, never published (only `dist/` ships), and applied with `--from`. **Dry
runs snapshot too, which is the point:** review with `--dry-run`, then apply that exact
file with `--from`. Fetching a second time for the real run would merge a poll that has
moved on since you read the report, so "apply what I reviewed" has to mean `--from`.

    node scripts/refresh-poll.js --step <uuid> --dry-run     # reports, and names the snapshot
    node scripts/refresh-poll.js --from data/polis-snapshots/report-data-<stamp>.json

The two writes are `data/bloom-data.json` and that snapshot; there are no other side
effects. Snapshots are not gitignored and accumulate.

It touches **only** `vote` and `groups`. Tags, chips, place, text, the quote records and
the themes are editorial, and where upstream disagrees the script reports and moves on:

- **New statements** are appended in tid order with `tags: []` and no chips. They build,
  with a warning, and show under no theme until tagged.
- **Statements gone from Polis** are left in place — their tags exist nowhere else, so
  removal is a person's call. If the cluster count also changed, their votes were counted
  over the old groups and can't be recomputed; `checkVoteIntegrity` then fails the build
  naming them, which is the intended forcing function.
- **Changed statement text** is reported in full, never applied.
- **Group labels are reset** to plain "Group A", because an inherited label is a claim
  about a cluster that may no longer be the same one. The script prints each cluster's size
  and representative statements to make re-labelling possible.

Records are matched by `id === "p" + tid`, so ids are stable across refreshes.

Two things a refresh silently invalidates, both editorial follow-ups: the hand-written
percentages in `theme-descriptions.json`, and `DIFFERENCE_MIN_GAP` — it was calibrated on
two groups, and `max − min` widens mechanically as clusters are added.

The derived fields are recomputed identically by the script and by `checkVoteIntegrity`,
and reproduce the original import exactly. The rounding is deliberately not uniform:
`pct` is rounded for display and `gap`/`minAgree` are computed from those rounded values,
but `consensus` is decided on the **unrounded** fractions — `p4`'s group B is 19.81%, which
displays as 20 yet is genuinely below the 20% threshold. A group that cast no votes counts
as 0% rather than undefined (`p144`, `p149`).
