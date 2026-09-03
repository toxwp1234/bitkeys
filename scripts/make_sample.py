"""Generate a synthetic funded-address snapshot for local testing.

Produces valid P2PKH (Base58Check) addresses with correct checksums, plus the
real genesis-block address, so the whole build+lookup pipeline can be exercised
without downloading the multi-GB production snapshot.

    python scripts/make_sample.py --n 100000 --out data/sample.tsv
"""

from __future__ import annotations

import argparse
import hashlib
import os
import random

_B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def b58encode(b: bytes) -> str:
    num = int.from_bytes(b, "big")
    out = ""
    while num > 0:
        num, rem = divmod(num, 58)
        out = _B58[rem] + out
    pad = len(b) - len(b.lstrip(b"\x00"))
    return "1" * pad + out


def p2pkh(h160: bytes) -> str:
    payload = b"\x00" + h160
    checksum = hashlib.sha256(hashlib.sha256(payload).digest()).digest()[:4]
    return b58encode(payload + checksum)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=100_000)
    ap.add_argument("--out", default="data/sample.tsv")
    ap.add_argument("--seed", type=int, default=1)
    args = ap.parse_args()

    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    rng = random.Random(args.seed)

    with open(args.out, "w", encoding="utf-8") as f:
        f.write("address\tbalance\n")  # header, mimics real dumps
        # real genesis coinbase address (famously funded, unspendable)
        f.write("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa\t5000000000\n")
        for _ in range(args.n):
            addr = p2pkh(rng.randbytes(20))
            balance = rng.randint(1, 5_000_000_000)
            f.write(f"{addr}\t{balance}\n")

    print(f"wrote {args.n + 1:,} rows -> {args.out}")


if __name__ == "__main__":
    main()
