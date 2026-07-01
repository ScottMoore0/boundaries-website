# PRONI catalogue search — Cloudflare D1 deploy runbook

The PRONI search box (`/browse/#/proni`) calls the Pages Function
`functions/_api/proni/search.js`, which queries a Cloudflare **D1** database
(SQLite + FTS5) bound as **`PRONI_DB`**. The code ships with the site; the D1
database must be provisioned once in the Cloudflare account.

## Artifacts (built by `scripts/build-proni-d1.py`)

From the combined detail set (leaves + enriched containers, 1,538,177 records):

- `D:\PRONI\eCatalogue\proni.sqlite` — local SQLite (for local dev / testing)
- `D:\PRONI\eCatalogue\proni-d1.sql.gz` — schema + batched INSERTs for D1 import
  (~190 MB uncompressed, 1,923 INSERT statements)

Rebuild any time:

```bash
python scripts/build-proni-d1.py \
  --src D:/PRONI/eCatalogue/detail-combined-with-containers-20260701.jsonl \
  --sqlite D:/PRONI/eCatalogue/proni.sqlite \
  --sql D:/PRONI/eCatalogue/proni-d1.sql.gz
```

## One-time deploy

```bash
# 1. Create the D1 database (note the returned database_id)
npx wrangler d1 create proni-catalogue

# 2. Import the data (gunzip first — wrangler import wants plain .sql)
gunzip -k D:/PRONI/eCatalogue/proni-d1.sql.gz
npx wrangler d1 import proni-catalogue --remote --file=D:/PRONI/eCatalogue/proni-d1.sql
# If the single import is rejected for size/time, split by INSERT and import in parts:
#   split -l 400 --additional-suffix=.sql proni-d1.sql part_   (keep the header with part_aa)

# 3. Verify
npx wrangler d1 execute proni-catalogue --remote --command \
  "SELECT count(*) FROM proni;"
npx wrangler d1 execute proni-catalogue --remote --command \
  "SELECT ref, title FROM proni WHERE proni MATCH 'antrim minute*' ORDER BY bm25(proni) LIMIT 3;"
```

## Bind the database to the Pages project

The Function reads `context.env.PRONI_DB`. Add the binding in the Cloudflare
dashboard: **Pages → (civgraph project) → Settings → Functions → D1 database
bindings** →

- Variable name: `PRONI_DB`
- D1 database: `proni-catalogue`

(Add it to both Production and Preview environments.) The site's Functions are
dashboard/git-managed — no `wrangler.toml` is required.

## Local end-to-end test (optional)

```bash
# seed a local D1 and serve functions + static site together
npx wrangler d1 execute proni-catalogue --local --file=D:/PRONI/eCatalogue/proni-d1.sql
npx wrangler pages dev . --d1 PRONI_DB=proni-catalogue
# then open the printed URL + /browse/#/proni and search
```

## Notes

- Schema: a base table `proni` (with a `UNIQUE(ref)` index) plus an
  external-content FTS5 table `proni_fts` over `ref`, `title`, `dates`. The base
  table stores the display/link columns (`slug`, `level`, `parent`,
  `parent_slug`, `has_children`, `fond`) and backs both the FTS index and the
  exact-reference lookup. The import ends with
  `INSERT INTO proni_fts(proni_fts) VALUES('rebuild');` to build the index.
- Query building (`buildMatch` in the Function): free text is tokenised on
  non-alphanumerics, terms are ANDed, and the final term is a prefix match for
  search-as-you-type. A reference like `BG/1` becomes the terms `bg AND 1`.
- Exact-reference fast path: any whitespace-free query is also looked up as a
  literal reference via the unique index (`WHERE ref = UPPER(q)`) and, when it
  hits, is returned first — so `BG/1` / `D1071` resolve to that exact node ahead
  of full-text descendants.
- To refresh after re-scraping, rebuild the SQL and re-import (drop/recreate the
  table or import into a new D1 and re-point the binding).
