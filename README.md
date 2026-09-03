# cuvre

Efficient lookup of whether a Bitcoin address currently holds a balance — over
a **56-million-address** snapshot, with sub-millisecond queries and a clean web
UI. Reads only public blockchain data.

![status](https://img.shields.io/badge/addresses-56.2M-orange) ![python](https://img.shields.io/badge/python-3.14-blue)

---

## What it does

Paste any Bitcoin address (`1…`, `3…`, `bc1…`) and instantly learn whether it is
funded and by how much. The interesting part is *how fast* that answer comes back
across 56M addresses, using a two-layer lookup engine.

## Architecture

```
   address
     │
     ▼
 ┌──────────────┐   invalid   ┌──────────────────────────────┐
 │  validate    │ ──────────▶ │ reject (checksum / format)    │
 │ base58 / bech32│           └──────────────────────────────┘
 └──────┬───────┘
        │ valid
        ▼
 ┌──────────────┐  not present  ┌──────────────────────────────┐
 │ Bloom filter │ ────────────▶ │ "not funded"  (RAM only,      │
 │  (188 MB RAM)│               │  never touches disk) ~40 µs   │
 └──────┬───────┘               └──────────────────────────────┘
        │ maybe present
        ▼
 ┌──────────────┐
 │   SQLite     │  exact balance (or resolves a rare false positive)
 │  (5.4 GB)    │
 └──────────────┘
```

The Bloom filter is the "fast NO" layer. A random/unused address is almost never
in the set, so **~99.99% of queries are answered from RAM** without a disk read.
Only a hit — or a rare Bloom false positive — falls through to SQLite for the
exact balance.

## Numbers

| Metric | Value |
|---|---|
| Funded addresses | 56,200,457 |
| Bloom filter | 188.5 MB in RAM, k=20, target FP 1e-6 |
| SQLite database | 5.4 GB (indexed) |
| Negative lookup (Bloom) | ~40 µs, no disk |
| Positive lookup (SQLite) | ~0.3–1.7 ms cold, faster warm |
| Throughput (single thread) | ~42,000 checks/s |
| Build time | ~37 min one-time (load + index) |

## Design decisions

- **Custom Bloom filter** ([src/bloom.py](src/bloom.py)) — sized with the standard
  `m = -n·ln p / (ln2)²`, `k = (m/n)·ln2` formulas; k bit positions come from a
  single BLAKE2b digest via Kirsch-Mitzenmacher double hashing (`h1 + i·h2`), so
  each item is hashed once, not k times. Persisted with a small header and
  `mmap`-ed read-only at query time so pages are shared and startup is instant.
- **Rowid table + post-load index** ([src/build_db.py](src/build_db.py)) — the
  snapshot is sorted by balance, not address. A first attempt using a
  `WITHOUT ROWID` table (address as primary key) forced 56M random B-tree
  inserts and crawled. Switching to a plain table (sequential appends) plus a
  single `CREATE INDEX` afterwards (one external merge sort) cut build time
  dramatically.
- **Streaming ingest** — the 1.6 GB `.gz` is parsed line-by-line, so RAM stays
  flat regardless of snapshot size. The parser auto-detects delimiter (CSV/TSV)
  and balance unit (integer satoshi vs decimal BTC, incl. scientific notation).
- **Zero third-party deps in the engine** — Bloom, validation, and DB build use
  only the standard library; FastAPI/uvicorn are only for the web layer.

## Keyspace explorer

A second page (`/explorer.html`) turns the checker into a visual sandbox over the
**private-key space**. Each grid cell is one private key `k`; hovering the cursor
square derives the real P2PKH address for every key inside it (`k·G → hash`) and
checks it against the funded set. Drag to pan, scroll to zoom, or set a custom
range `2ᵃ … 2ᵇ`.

Coordinates are full 256-bit `BigInt`; the grid is row-major (`k = start + y·W + x`,
`W = ⌈√range⌉`). Address derivation runs **client-side in a Web Worker**
(`@noble/secp256k1` + `@noble/hashes`, vendored under `web/vendor/`): the cursor
block is derived in the browser at ~10,000 addr/s with no network round-trip, the
trail is painted optimistically the instant it returns, and the funded-check is
fired in the background to `POST /api/check_batch` (a hit is ~10⁻⁴¹, so the UI
never waits on it). This pushes all EC work onto each visitor's machine, so the
server does zero elliptic-curve math and the page scales to many users.

Navigation is game-like: pan/zoom over a sub-pixel view model, a **minimap** of
the whole range with a viewport box, explored-heat trail, and click-to-teleport
(one click ≈ jumps 2²⁵⁵ keys). It is honest about being a *scale* visualization,
not a treasure hunt: a hit will never appear, and that is the lesson.

## Data source

`Latest_Bitcoin_Addresses.tsv.gz` from the public
[Pymmdrza/Rich-Address-Wallet](https://github.com/Pymmdrza/Rich-Address-Wallet/releases)
GitHub release (CSV: `address,balance` in BTC). Any `address,balance` dump works
— e.g. Blockchair or a BigQuery export of `crypto_bitcoin.balances`.

## Usage

```bash
pip install -r requirements.txt

# 1. get a snapshot into data/  (see Data source)

# 2. build the lookup artifacts (SQLite + Bloom)
python -m src.build_db data/Latest_Bitcoin_Addresses.tsv.gz \
    --db data/wallets.db --bloom data/wallets.bloom \
    --expected 55000000 --fp 1e-6 --unit btc

# 3. run the web app
python -m uvicorn src.api:app --host 127.0.0.1 --port 8000
#    open http://127.0.0.1:8000/
```

Try it without a snapshot using synthetic data:

```bash
python scripts/make_sample.py --n 100000 --out data/sample.tsv
python -m src.build_db data/sample.tsv --db data/wallets.db --bloom data/wallets.bloom --expected 100001
python -m scripts.bench
```

## API

| Endpoint | Returns |
|---|---|
| `GET /api/check?address=…` | `{valid, funded, balance_btc, balance_sat, source, lookup_us}` |
| `GET /api/stats` | dataset + filter stats |
| `GET /api/health` | liveness |

`source` tells you which layer answered: `invalid`, `bloom` (RAM), `db` (funded),
or `db-fp` (Bloom false positive, absent in DB).

## Legality

cuvre reads only public, on-chain data — it derives an address from user input
and looks it up in a published balance snapshot. It does not generate, guess, or
handle private keys.

## Layout

```
src/bloom.py       custom Bloom filter (mmap, double hashing)
src/validate.py    base58check + bech32/bech32m validation
src/build_db.py    snapshot -> SQLite + Bloom (streaming)
src/checker.py     validate -> bloom -> sqlite engine
src/api.py         FastAPI + static frontend
web/               dark-mode dashboard
scripts/           sample generator + benchmark
```
