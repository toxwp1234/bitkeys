"""Correctness checks + throughput benchmark for the lookup engine."""

from __future__ import annotations

import random
import time

from src.checker import Checker
from scripts.make_sample import p2pkh

checker = Checker("data/wallets.db", "data/wallets.bloom")
print("stats:", checker.stats())
print()

cases = [
    ("genesis (funded)", "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa"),
    ("valid, not funded", p2pkh(bytes(range(20)))),          # deterministic, not in set
    ("invalid checksum", "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfXX"),
    ("garbage", "not-an-address"),
    ("bech32 taproot", "bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr"),
]
for label, addr in cases:
    r = checker.check(addr)
    print(f"{label:22} | valid={r.valid!s:5} funded={r.funded!s:5} "
          f"btc={r.balance_btc:<12.8f} src={r.source:8} {r.lookup_us:7.1f} us")

print("\n--- throughput: 200k random (unfunded) lookups ---")
rng = random.Random(42)
probe = [p2pkh(rng.randbytes(20)) for _ in range(200_000)]
t0 = time.perf_counter()
hits = sum(checker.check(a).funded for a in probe)
dt = time.perf_counter() - t0
print(f"{len(probe):,} lookups in {dt:.2f}s -> {len(probe)/dt:,.0f} checks/s  (hits={hits})")

checker.close()
