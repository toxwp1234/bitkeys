"""Build the lookup artifacts from a funded-address snapshot.

Input : a (optionally gzipped) TSV of  <address>\t<balance_in_satoshi>
        e.g. Blockchair's `blockchair_bitcoin_addresses_latest.tsv.gz`.
Output: - <db>     an indexed SQLite table  addresses(address, balance)
        - <bloom>  a Bloom filter over every funded address

Both are streamed, so RAM stays flat regardless of snapshot size.

Usage:
    python -m src.build_db data/sample.tsv --db data/wallets.db \
        --bloom data/wallets.bloom --expected 50000000 --fp 1e-6
"""

from __future__ import annotations

import argparse
import gzip
import io
import os
import sqlite3
import sys
import time

from .bloom import BloomFilter


def _open_maybe_gzip(path: str) -> io.TextIOBase:
    if path.endswith(".gz"):
        return io.TextIOWrapper(gzip.open(path, "rb"), encoding="utf-8", errors="replace")
    return open(path, "r", encoding="utf-8", errors="replace")


SATS_PER_BTC = 100_000_000


def _split(line: str):
    if "," in line:
        return line.split(",")
    if "\t" in line:
        return line.split("\t")
    return line.split()


def _to_sats(tok: str, unit: str):
    """Return an integer satoshi balance, or None if unparseable/zero.

    Sources differ: Blockchair stores integer satoshi, the GitHub/HF dumps
    store decimal BTC. `auto` treats a value with a '.' as BTC, else satoshi.
    """
    tok = tok.strip()
    try:
        if unit == "sat":
            sats = int(tok)
        elif unit == "btc":
            sats = round(float(tok) * SATS_PER_BTC)
        else:  # auto
            sats = int(tok) if tok.isdigit() else round(float(tok) * SATS_PER_BTC)
    except ValueError:
        return None
    return sats if sats > 0 else None


def _rows(path: str, unit: str = "auto"):
    """Yield (address, balance_sat) skipping headers/blank/zero-balance lines."""
    with _open_maybe_gzip(path) as fh:
        for line in fh:
            line = line.rstrip("\n")
            if not line:
                continue
            parts = _split(line)
            if len(parts) < 2:
                continue
            address = parts[0].strip()
            balance = _to_sats(parts[1], unit)
            if balance is None:
                continue  # header row, zero balance, or malformed
            yield address, balance


def build(src: str, db_path: str, bloom_path: str,
          expected: int = 50_000_000, fp_rate: float = 1e-6,
          batch: int = 50_000, unit: str = "auto") -> None:
    os.makedirs(os.path.dirname(db_path) or ".", exist_ok=True)
    for stale in (db_path, bloom_path):
        if os.path.exists(stale):
            os.remove(stale)

    bloom = BloomFilter.for_capacity(expected, fp_rate)
    print(f"[bloom] sized for {expected:,} items @ fp={fp_rate:g} "
          f"-> {bloom.size_mb:.1f} MB, k={bloom.num_hashes}")

    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA journal_mode=OFF")
    conn.execute("PRAGMA synchronous=OFF")
    conn.execute("PRAGMA temp_store=MEMORY")
    conn.execute("PRAGMA cache_size=-262144")  # ~256 MB page cache for the index build
    # Plain rowid table: inserts are sequential appends (fast). The address
    # index is built once, after loading, via an external merge sort -- far
    # cheaper than maintaining a sorted B-tree across 50M random inserts.
    conn.execute("CREATE TABLE addresses (address TEXT NOT NULL, balance INTEGER)")

    t0 = time.perf_counter()
    n = 0
    buf: list[tuple[str, int]] = []
    for address, balance in _rows(src, unit):
        bloom.add(address.encode())
        buf.append((address, balance))
        n += 1
        if len(buf) >= batch:
            conn.executemany("INSERT INTO addresses VALUES (?, ?)", buf)
            buf.clear()
            if n % 1_000_000 == 0:
                rate = n / (time.perf_counter() - t0)
                print(f"[load] {n:,} rows  ({rate:,.0f}/s)")
    if buf:
        conn.executemany("INSERT INTO addresses VALUES (?, ?)", buf)

    conn.commit()
    print(f"[load] {n:,} rows inserted in {time.perf_counter() - t0:.1f}s")

    ti = time.perf_counter()
    print("[index] building address index (one-time external sort)...")
    conn.execute("CREATE INDEX idx_address ON addresses(address)")
    conn.commit()
    print(f"[index] done in {time.perf_counter() - ti:.1f}s")
    conn.execute("CREATE TABLE meta (key TEXT PRIMARY KEY, value INTEGER)")
    conn.execute("INSERT INTO meta VALUES ('count', ?)", (n,))
    conn.commit()
    conn.close()
    bloom.save(bloom_path)

    dt = time.perf_counter() - t0
    db_mb = os.path.getsize(db_path) / 1024 / 1024
    print(f"[done] {n:,} funded addresses in {dt:.1f}s")
    print(f"       db    = {db_path}  ({db_mb:.1f} MB)")
    print(f"       bloom = {bloom_path}  ({bloom.size_mb:.1f} MB)")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Build cuvre lookup artifacts.")
    ap.add_argument("src", help="snapshot .tsv or .tsv.gz")
    ap.add_argument("--db", default="data/wallets.db")
    ap.add_argument("--bloom", default="data/wallets.bloom")
    ap.add_argument("--expected", type=int, default=50_000_000,
                    help="expected #addresses (Bloom sizing)")
    ap.add_argument("--fp", type=float, default=1e-6, help="target false-positive rate")
    ap.add_argument("--unit", choices=["auto", "sat", "btc"], default="auto",
                    help="balance unit in the snapshot (auto detects per row)")
    args = ap.parse_args(argv)
    build(args.src, args.db, args.bloom, args.expected, args.fp, unit=args.unit)
    return 0


if __name__ == "__main__":
    sys.exit(main())
