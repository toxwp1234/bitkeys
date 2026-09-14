# Run locally

The keyspace map + Bloom "funded-check" runs fully client-side. The 126 MB filter is
shipped as 7 chunks in `data/bloom_chunks/` (already in this repo).

## Start

```
python scripts/serve_local.py
```

Then open **http://127.0.0.1:8001**

`serve_local.py` serves the app at `/` and the Bloom filter parts at `/bloom/` (the app
auto-loads the filter in the background and caches it in the browser's IndexedDB, so it is
instant on the next visit). Needs Python 3 — no other dependencies.

## Notes
- The filter is `wallets_1e-4.bloom` (≈56.2M funded Bitcoin addresses, false-positive
  rate ≈1.2e-4). To rebuild it from a fresh snapshot:
  `python scripts/build_bloom.py <snapshot.tsv.gz> --out data/wallets_1e-4.bloom --fp 1e-4`
  then `python scripts/split_bloom.py data/wallets_1e-4.bloom --out data/bloom_chunks`.
- On a deployed (non-localhost) site the app fetches the filter from jsDelivr instead of
  `/bloom/` (see `BLOOM_BASE` in `netlify-app/app.js`).
