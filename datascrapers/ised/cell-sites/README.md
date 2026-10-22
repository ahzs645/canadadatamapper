# ISED cell sites

Every site licensees report to ISED for their terrestrial spectrum licences —
the same data the [Canadian Cellular Towers Map](https://www.ertyu.org/steven_nikkel/cancellsites.html)
draws — as one point per site.

```bash
npm run ised:cell-sites:sync              # download and rebuild
npm run ised:cell-sites:sync -- --if-changed   # skip when ISED has not republished
npm run ised:cell-sites:sync -- --zip ~/Downloads/Site_Data_Extract_FX.zip
npm run ised:cell-sites:validate
```

## Source

- `Site_Data_Extract_FX.zip` from ISED's Spectrum Management System,
  [Download SMS data](https://ised-isde.canada.ca/site/spectrum-management-system/en/spectrum-management-system-data/download-sms-data).
  Republished monthly; the extract date is the file's `Last-Modified`.
- Open Government Licence – Canada. Attribution is in `output/manifest.json`.
- Do not scrape ertyu.org instead. It renders this extract as PNG tiles, and its
  `robots.txt` disallows automated and AI clients.
- `TAFL_LTAF.zip` (the authorization extract) is **not** the source: it lists
  cellular spectrum licences as service areas with no coordinates.

## Size

| | |
| --- | --- |
| Download | ~65 MB zip |
| CSV | ~1.2 GB, ~2.04 M rows (one per antenna/frequency) |
| Snapshot | ~55 k sites, ~1.7 MB gzipped (~23 MB GeoJSON) |
| Runtime | ~10 s after download |

Only the snapshot and manifest are committed. The download goes to the
git-ignored `cache/ised/`. Git history of `output/` is the month-by-month
archive, since ISED serves only the current extract.

## Method

- A site is the set of rows whose latitude/longitude agree to 5 decimal places
  (~1 m). Operators sharing a mast land on one point; two masts on one rooftop
  stay separate.
- Licensee legal names fold into brands (`operatorFor`): Fido → Rogers, Bell MTS
  → Bell, "Videotron Ltd. dba Freedom Mobile" → Freedom. The full name list per
  brand is in the manifest's `licensees`. The Railway Association of Canada
  files ~5.9 k sites; they are railway radio, not public cellular.
- `bands` are ISED `licence_category` codes: `CELL` 850, `PCS`/`PCSG` 1900,
  `AWS`/`AWS-3`/`AWS-4`, `600B`, `MBS` 700, `BRS` 2500, `WCS` 2300,
  `3500B`, `3800B`, `WBS` 3650, `BWA24`/`BWA38`/`FCFS38` millimetre wave.
- `siteTypes`: `O` outdoor, `I` indoor (DAS, stadiums, malls).
  `structureTypes` are kept as filed (`T`, `R`, `P`, `O`, `S`, `M`); `T`
  tower and `R` rooftop are clear from the data, the rest are not decoded here.
- `heightM` is the tallest reported structure height at the site;
  `lastChanged` the latest `date_last_changed`.
- Rows with unparseable coordinates, or a shifted column count (~120 a month),
  are rejected and counted in `manifest.rows.rejected`.
- Contact name, phone and email columns are never read. `validate-output.mjs`
  fails if any reach the snapshot.
- ISED's own file contains U+FFFD in some French place names (e.g. "Montr�a");
  they are passed through rather than guessed at.

Sites are what licensees report, not measured coverage.
