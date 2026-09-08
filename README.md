# cuvre — Bitcoin keyspace explorer & funded-address checker

**Live demo → [bitkeys.kifit.pl](https://bitkeys.kifit.pl)**

An interactive, zoomable map of *every private key Bitcoin could ever have* — all
2²⁵⁶ of them — plus a fast checker that tells you whether any address currently
holds a balance, over a snapshot of **56 million funded addresses**.

It's built to make one idea tangible: the Bitcoin keyspace is so vast that
guessing a funded key is physically impossible (~10⁻⁴¹ per try). You can walk the
map, scan patches, and watch real addresses stream out — every one empty.

> Reads only public, on-chain data. It never generates, guesses, or handles
> anyone's private keys, and it is deliberately not a "find lost coins" tool.

---

## What this project demonstrates

| Area | In this repo |
|---|---|
| **Applied cryptography** | secp256k1 point math, ECDSA, P2PKH/bech32 address derivation — implemented from the group law, not a black-box library |
| **Performance engineering** | Bloom filter + SQLite two-tier lookup; Montgomery batch inversion; a build-time B-tree lesson that cut load time from *hours* to minutes |
| **Data engineering** | streaming ingest of a 1.6 GB gzip snapshot into an indexed 5.4 GB store, RAM-flat |
| **Frontend / graphics** | a pannable/zoomable 2²⁵⁶-cell canvas map using `BigInt` coordinates, a live minimap with teleport, and a Web Worker so the UI never blocks |
| **Product & honesty** | a viral-shaped toy that teaches scale instead of selling false hope |

---

## Two apps in one repo

### 1. Funded-address checker (`src/`, `web/`)
Paste any address → instant "funded / empty" + balance.

```
address → validate (base58 / bech32) → Bloom filter (RAM) → SQLite (exact)
```

The **Bloom filter** ([src/bloom.py](src/bloom.py)) answers ~99.99% of queries
(random addresses aren't funded) entirely from RAM in ~40 µs — no disk touch.
Only a hit falls through to SQLite for the exact balance. Custom implementation:
optimal sizing, one BLAKE2b digest split into *k* positions
(Kirsch–Mitzenmacher), `mmap`-backed for instant startup.

**A real engineering lesson, kept in the history:** the first build used a
`WITHOUT ROWID` table keyed by address. Because the snapshot is sorted by
*balance*, that forced 56M random B-tree inserts and crawled. Switching to a
plain table + a single post-load `CREATE INDEX` (one external merge sort) cut the
build dramatically. See [src/build_db.py](src/build_db.py).

### 2. Keyspace map (`netlify-app/`) — the live demo
A **backend-free**, client-side map of the whole key space.

- Each cell is one private key. **Click** a patch → a Web Worker derives its real
  P2PKH addresses in the browser (`@noble/secp256k1` + `@noble/hashes`) with no
  network round-trip; the patch paints instantly (optimistic rendering).
- Pan / zoom over a sub-pixel view model, a **minimap** with click-to-teleport
  (one click jumps ~2²⁵⁵ keys), a **Random** jump, and shareable position via
  `?x=…&y=…` in the URL.
- Click any derived address to reveal the exact number it came from.
- All EC math runs on the visitor's machine, so the server does zero crypto and
  the page scales to any number of users. Progress persists in `localStorage`.

---

## Tech stack
Python (FastAPI, SQLite, stdlib crypto) · vanilla JS + Canvas + Web Workers +
`BigInt` · `@noble` crypto (client-side) · deployed static on Netlify.

## Run it

```bash
# checker (needs a snapshot in data/ — see netlify-app/README.md for sources)
pip install -r requirements.txt
python -m src.build_db data/<snapshot>.tsv.gz --db data/wallets.db --bloom data/wallets.bloom --unit btc
python -m uvicorn src.api:app --port 8000        # http://127.0.0.1:8000

# keyspace map (static, no backend)
python scripts/serve_static.py                   # http://127.0.0.1:8001
```

## Layout
```
src/           Bloom + SQLite engine, address validation, secp256k1 derivation, FastAPI
web/           checker UI + server-assisted explorer
netlify-app/   standalone client-side keyspace map (the live demo)
scripts/       sample generator, benchmark, static server
```
