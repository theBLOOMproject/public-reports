# utah-ai data notes

## counties.json

Utah's 29 counties, from
<https://cdn.jsdelivr.net/npm/us-atlas@3/counties-10m.json> (U.S. Census Bureau geometry,
republished by us-atlas), filtered to FIPS-`49` and converted TopoJSON → GeoJSON.

The source is TopoJSON: shared borders are stored once as delta-encoded integer arcs plus
a scale/translate transform, and each county references arc indices, negative meaning
"traverse backwards". Converting means applying the transform, accumulating the deltas
into absolute lng/lat, and stitching each ring's arcs while dropping the endpoint the
adjoining arc repeats. Keep only `id` (the FIPS code) and `properties.name`.

Running that same decode over FIPS-`41` reproduces `data/central-oregon-ai/counties.json`
byte for byte, so both reports' geometry is demonstrably the same source. That's the check
to run if this ever needs redoing.

The file must hold the whole state, not just the counties with participants — the map
derives its zoomed-out limit from the full collection, so a trimmed file would cap how far
you can zoom out.

## participant-locations.json

One marker per county that has participants: 24 of the 29. Built from the newest snapshot
in `polis-snapshots/`, which carries `participationReport.zipcodeCounts` — bare
`zip: count` pairs, no location of any kind.

Steps:

1. **Zip → coordinate.** From the Census ZCTA Gazetteer,
   <https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2023_Gazetteer/2023_Gaz_zcta_national.zip>
   (tab-separated; `GEOID` plus `INTPTLAT`/`INTPTLONG`). All 121 in-state zips resolve.
2. **Coordinate → county.** By point-in-polygon against `counties.json` itself, not a
   separate zip-to-county crosswalk, so the county a marker names always matches the
   polygon it sits on. Validated against Central Oregon's hand-researched counties: 11
   of 11, including Antelope, the one place outside that report's home region.
3. **Sum per county**, then place each marker at the county's Census internal point from
   <https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2023_Gazetteer/2023_Gaz_counties_national.zip>.

Of 124 zips, 121 are in Utah and cover 591 of 598 participants. `other` is the remaining
7: four people in three out-of-state zips (two Bay Area, one Puerto Rico) and three who
gave no zip at all. `total` is the snapshot's `totalParticipants`.

The five counties with nobody in them are Garfield, Kane, Millard, Morgan and Wayne.

### Why the internal point

Not the area centroid: Utah's county lines run out across the Great Salt Lake and Davis
County is 49% water, so its centroid lands on open water. The Census internal point is
guaranteed to sit inside the county and is placed on land.

Not the population-weighted centre of each county's own respondents either: those all pull
toward the I-15 corridor, dragging neighbouring counties' markers together. Davis and Weber
end up 27px apart at a 900×600 whole-state fit, against 40px from the internal point.

Redoing this after a fresh snapshot means redoing all three steps — nothing here reads the
snapshot automatically.

## report.json → map

`homeCounties` lists the 24 counties that have participants, so the map's region tint reads
as "counties we heard from" and the five empty ones stay clear. **Add a county here if a
later snapshot puts participants in it**, or its marker will render untinted. Every FIPS
listed must exist in `counties.json` or the build fails.

`dotRadius` is `4/28`. That is the only min/max leaving no overlapping markers at either a
900×600 or a 380×560 whole-state fit; the 13/70 default that Central Oregon uses leaves 6
and 10. The Wasatch Front counties are physically small and adjacent, so there is very
little room — Davis and Weber centres are only 40px apart on desktop and 32px on mobile.
Re-check overlaps before changing these.

## demographics.json → actual

Placeholders. These need real Utah population shares per category before the report is
trustworthy — the modal shows them beside the poll's own numbers as the comparison, so
wrong actuals read as a finding rather than as missing data.

## Known rough edges

- The 20 counties under 20 participants are near-indistinguishable in size. The marker
  radius scale is linear on count, calibrated for Central Oregon where Bend was 51% of the
  report; Utah's long tail needs a curve, which is not yet per-report the way `dotRadius`
  is.
- Davis County's marker sits on Antelope Island, out in the Great Salt Lake. It is
  genuinely that county's internal point, but well west of where its people live.
- `static/` still holds Central Oregon's photographs (`sisters_title.webp`,
  `sisters_bg.webp`), and `report.json` still says "400+" and "over 400 residents" against
  598 actual participants.
