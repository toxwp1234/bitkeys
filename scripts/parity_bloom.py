"""Generate a parity oracle so the JS reader can be proven bit-for-bit identical to
src/bloom.py ON THE REAL FILTER (not a toy one).

Writes data/bloom_chunks/parity.json (served at /bloom/parity.json) with:
  * digests : {address: blake2b-16 hex}  -> isolates the hash from the index/bit logic
  * expected: {address: bool}            -> Python BloomFilter.__contains__ as oracle,
                                            for hundreds of real members + ~1000 near-miss
                                            non-members (one-char mutations).

The JS side loads the production filter via bloom.js and asserts contains(a)==expected[a]
for every address, and blake2b(a)==digests[a] for the sampled ones.
"""
from __future__ import annotations

import hashlib
import json
import os
import random
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from src.bloom import BloomFilter          # noqa: E402
from src.build_db import _rows             # noqa: E402

SNAPSHOT = "data/Latest_Bitcoin_Addresses.tsv.gz"
BLOOM = "data/wallets_1e-4.bloom"
OUT = "data/bloom_chunks/parity.json"
B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"

N_MEMBERS = 400
N_NONMEMBERS = 1200


def sample_members(n: int):
    """Spread the sample across the snapshot instead of taking a biased prefix."""
    out = []
    step = 5000
    for i, (addr, _bal) in enumerate(_rows(SNAPSHOT)):
        if i % step == 0:
            out.append(addr)
            if len(out) >= n:
                break
    return out


def mutate(addr: str) -> str:
    """Flip one base58 char -> a valid-length address almost certainly not in the set."""
    i = random.randrange(len(addr))
    c = addr[i]
    repl = random.choice(B58)
    while repl == c:
        repl = random.choice(B58)
    return addr[:i] + repl + addr[i + 1:]


def main() -> int:
    bloom = BloomFilter.load(BLOOM)
    print(f"[parity] loaded {BLOOM}: size_bits={bloom.size_bits:,} k={bloom.num_hashes}")

    members = sample_members(N_MEMBERS)
    print(f"[parity] sampled {len(members)} members")

    nonmembers = []
    seen = set(members)
    while len(nonmembers) < N_NONMEMBERS and members:
        cand = mutate(random.choice(members))
        if cand not in seen:
            seen.add(cand)
            nonmembers.append(cand)

    expected, digests = {}, {}
    n_true = 0
    for a in members + nonmembers:
        hit = a.encode() in bloom
        expected[a] = hit
        if a in nonmembers and hit:
            n_true += 1
    # a few explicit blake2b-16 vectors (incl. classic KAT inputs) to isolate the hash
    for a in members[:20] + ["", "abc", "The quick brown fox jumps over the lazy dog"]:
        digests[a] = hashlib.blake2b(a.encode(), digest_size=16).hexdigest()

    # sanity the oracle itself
    mem_all_true = all(expected[a] for a in members)
    print(f"[parity] members all present: {mem_all_true}  (must be True)")
    print(f"[parity] non-member false-positives: {n_true}/{len(nonmembers)} "
          f"(~{len(nonmembers) * 1.2e-4:.2f} expected at fp 1.2e-4)")

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w") as f:
        json.dump({"size_bits": bloom.size_bits, "num_hashes": bloom.num_hashes,
                   "digests": digests, "expected": expected}, f)
    print(f"[parity] wrote {OUT}: {len(expected)} membership + {len(digests)} digest vectors")
    return 0 if mem_all_true else 1


if __name__ == "__main__":
    sys.exit(main())
