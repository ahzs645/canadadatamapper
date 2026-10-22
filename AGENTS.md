# canadadatamapper Agent Instructions

- Commit only deploy snapshots under `datascrapers/**/output`. Raw downloads go in `cache/` (git-ignored).
- Snapshots must be deterministic: sorted features and arrays, no generation timestamps, gzip via
  `deterministicGzip`. Record both the gzip and the uncompressed JSON sha256 in the manifest; Node's zlib
  can compress differently per CPU architecture, so compare the JSON digest across machines.
- Use the publisher's own open-data endpoint. Do not scrape third-party viewers of the same data,
  and respect their `robots.txt`. ertyu.org's tower map is ISED's site extract and disallows automated clients.
- Never publish licensee contact columns (names, phones, emails). Validators must fail if they appear.
- After changing an output, push here first, then move the `vendor/canadadatamapper` pointer in PGMaps
  and run `npm run data:sync-from-bcdatamapper` there.
