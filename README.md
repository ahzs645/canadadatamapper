# canadadatamapper

National (Canada-wide) data scrapers for [PGMaps](https://github.com/ahzs645/PGMaps),
the sibling of [bcdatamapper](https://github.com/ahzs645/bcdatamapper).

Each scraper lives in `datascrapers/<publisher>/<dataset>/` and commits a small,
deterministic deploy snapshot to its `output/` folder. Raw downloads stay in the
git-ignored `cache/`. PGMaps checks this repository out at
`vendor/canadadatamapper` and copies the `output/` folders into its
`public/data` when it builds.

| Dataset | Scraper | PGMaps path | Refresh |
| --- | --- | --- | --- |
| ISED cell sites | `datascrapers/ised/cell-sites` | `/data/canada/cell-sites/` | Monthly workflow |

```bash
npm test
npm run ised:cell-sites:sync -- --if-changed
npm run ised:cell-sites:validate
```

Node 20 or newer, and `unzip` on the PATH. No npm dependencies.
