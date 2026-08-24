# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A single-page interactive report on a Bloom Project's public engagement. Currently this repo
has both code and data; the data is for the Oregon COCAP engagement - six listening sessions plus
one open Polis-style poll. It is published as a static GitHub Pages site — `main` deploys on push via
`.github/workflows/pages.yml`.

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
`vendor/d3-custom.min.js` is not an exception: it is a checked-in file, inlined like any
other source, never resolved or fetched.

## Build model

`build.js` is a simple, 0-dependency script that creates the single-page app in dist/index.html

`dist/` is gitignored and rebuilt from scratch every time — never edit it, and never commit
it. Only what lands in `dist/` is public, which is why repo sources can stay in the repo.

## Architecture

`index.template.html` - markup only - app code and JSON data is injected in here by build.js. 

`src/app.js` - Application code

`data/` - All Data, editorial content, etc

`vendor/d3-custom.min.js` - a checked-in subset of d3 (geo + zoom) used by the
Demographics map, so the published page still makes no network requests

An ordered run of intro pages comes before the theme grid: **Title → Demographics →
Opinion Groups → Consensus**. 

Demographics is an interactive county map with a marker per city, plus a modal breaking
down age/political/gender/race. Opinion Groups is a card per cluster, each opening a paged
modal of that group's defining statements. Consensus is a card stack of hand-picked
statements. Title is still a placeholder.

Then three nested pages, bundled as one Single Page App

- **Landing Page (`#l1`)** — theme grid, one block per theme`.
- **Single Theme Page (`#l2`)** — one theme: a "What we learned" table of contents, a
  per-insight carousel of statement cards, and a flat "All Statements" list — all
  poll statements, sorted by %-agreement. Session quotes have no UI path here (see Data
  below). 
- **L3 (`#l3`)** — statement detail modal, keyboard Esc/←/→. A statement's card can appear 
- twice on the page (its insight carousel and All Statements)

**Routing** is the URL hash, handled by `route()` on `hashchange`. The bare root is the
homepage (the first intro page); each intro page has its own key (`#/demogs`, `#/groups`,
`#/consensus`), the theme grid lives at `#/themes`, and a single theme at `#/{themeKey}`
(a trailing segment, e.g. from an old bookmarked link, is parsed but ignored). An
unrecognized key falls back to the homepage. Navigation is done by assigning
`location.hash`, not by calling render functions directly.

## Data

`data/bloom-data.json` — `{ themes, records, groups }`.

- `themes[]`: defines the themes and which tags, when applied to statements, pull them into the theme
- `records[]`: holds statements and quotes
- `groups[]`: the poll's opinion clusters, in render order

`data/bloom-insights.json` — Editorial content revolving around insights. Keyed by theme.
`direction` (`agree`/`disagree`/`divided`/`mixed`) - Top-level consensus category

`data/group-info.json` — per opinion group: participant count, color, tagline and a
hand-written description, for the Opinion Groups page and its modal. Hand-maintained; `refresh-poll.js`
never touches it.

`data/group-statements.json` — per opinion group, the statements that most define it, in
rank order, feeding the rest of that group's modal.

`data/consensus-statements.json` — the statement ids shown on the Consensus page, in order.

`data/demographics.json` — the Demographics detail modal, one category per tab.

`data/participant-locations.json` — cities with participant counts and real lat/lng for the
Demographics map, plus an `other` bucket for every zip not broken out. Note that d3-geo
takes points as `[lng, lat]` — the reverse of these fields' reading order.

`data/oregon-counties.json` — GeoJSON for all 36 Oregon counties, from the U.S. Census
Bureau via `us-atlas`. All 36 are kept, not just the three Central Oregon ones, so the
map's zoomed-out bound is the real state outline.

Each of these carries its own `_readme` recording where its numbers came from.

### Themes are derived from tags

A record has no `theme` field. It belongs to **every** theme listing one of its tags, so
membership is derived.

A record whose tags no theme claims vanishes from the report — this will produce a build warning.

Note: the themes are canonical to this repository, and are not (currently) pulled out of Comhairle. 

### Refreshing the poll

`node scripts/refresh-poll.js --step <workflow-step-uuid>` rewrites every poll record's
`vote` and the `groups` array from Polis, via comhairle's
`GET /tools/polis/report_data` (that route has no auth check, so no credentials are
involved). `--help` documents every flag.

Every live fetch saves the payload to `data/polis-snapshots/`. These can be committed
if desired. 

**Dry runs** review with `--dry-run`, then apply that exact
file with `--from`. 

    node scripts/refresh-poll.js --step <uuid> --dry-run     # reports, and names the snapshot
    node scripts/refresh-poll.js --from data/polis-snapshots/report-data-<stamp>.json

The refresh touches **only** `vote` and `groups`. Tags, chips, place, text, the quote records and
the themes are editorial, and where upstream disagrees the script reports and moves on:

- **New statements** are appended in tid order with `tags: []` and no chips. They build,
  with a warning, and show under no theme until tagged.
- **Statements gone from Polis** are left in place — their tags exist nowhere else, so
  removal is a person's call. 
- **Changed statement text** is reported in full, never applied. Differences that are
  only whitespace are counted but not listed — Polis returns trailing newlines and
  non-breaking spaces that nobody typed, and eight of them per run would drown the one
  that matters.
- **Group labels are reset** to plain "Group A", because an inherited label is a claim
  about a cluster that may no longer be the same one. To make re-labelling possible the
  script prints each cluster's size and the statements Polis says most distinguish it,
  each with that group's own agree% — repness ranks by distinctiveness, so a listed
  statement may be one the group is defined by *rejecting*, and comhairle drops Polis's
  agree/disagree direction. Without the percentage the list reads as self-contradictory.

Records are matched by `id === "p" + tid`, so ids are stable across refreshes.

Three things a refresh silently invalidates, all editorial follow-ups: the hand-written
percentages in `theme-descriptions.json`; `DIFFERENCE_OVER_GAP` — it was calibrated on
two groups, and `max − min` widens mechanically as clusters are added; and the participant
counts in `group-info.json`, which need a fresh clustering run to re-derive.
