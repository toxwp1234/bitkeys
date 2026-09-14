"""Build ONLY the Bloom filter (no SQLite) from a snapshot, at a chosen FP rate.

The exact-balance SQLite DB does not depend on the false-positive rate, so to
change the filter's precision/size we only need to re-hash the addresses into a
new bit array -- far cheaper than a full `build_db` run (no 5.4 GB DB rewrite).

Usage:
    python scripts/build_bloom.py data/Latest_Bitcoin_Addresses.tsv.gz \
        --out data/wallets_1e-4.bloom --expected 55000000 --fp 1e-4
"""
from __future__ import annotations

import argparse
import os
import sys
import time

# make `src` importable when run as a plain script from the repo root
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src.bloom import BloomFilter        # noqa: E402
from src.build_db import _rows           # noqa: E402  (reuse the same row parser)


def build_bloom(src: str, out: str, expected: int, fp: float, unit: str = "auto") -> None:
    bloom = BloomFilter.for_capacity(expected, fp)
    print(f"[bloom] sized for {expected:,} items @ fp={fp:g} "
          f"-> {bloom.size_mb:.1f} MB, k={bloom.num_hashes}", flush=True)

    tmp = out + ".tmp"
    t0 = time.perf_counter()
    n = 0
    for address, _bal in _rows(src, unit):
        bloom.add(address.encode())
        n += 1
        if n % 5_000_000 == 0:
            rate = n / (time.perf_counter() - t0)
            print(f"[add] {n:,} addresses  ({rate:,.0f}/s)", flush=True)

    bloom.save(tmp)
    os.replace(tmp, out)   # atomic: never leave a half-written .bloom in place
    dt = time.perf_counter() - t0
    mb = os.path.getsize(out) / 1024 / 1024
    print(f"[done] {n:,} addresses -> {out}  ({mb:.1f} MB) in {dt:.1f}s", flush=True)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Build only the cuvre Bloom filter.")
    ap.add_argument("src", help="snapshot .tsv or .tsv.gz")
    ap.add_argument("--out", default="data/wallets_1e-4.bloom")
    ap.add_argument("--expected", type=int, default=55_000_000,
                    help="expected #addresses (Bloom sizing)")
    ap.add_argument("--fp", type=float, default=1e-4, help="target false-positive rate")
    ap.add_argument("--unit", choices=["auto", "sat", "btc"], default="auto")
    a = ap.parse_args(argv)
    build_bloom(a.src, a.out, a.expected, a.fp, a.unit)
    return 0


if __name__ == "__main__":
    sys.exit(main())
