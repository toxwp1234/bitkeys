"""Split a .bloom into <=100 MB git-safe chunks + a manifest, for serving the
whole filter from a public GitHub repo via the jsDelivr CDN (CORS-clean, unmetered).

Git rejects single files > 100 MB, and jsDelivr is happiest well under that, so we
cut the filter into ~20 MB parts. The browser fetches every part in parallel and
concatenates them back into the exact original bytes before parsing the header.

Usage:
    python scripts/split_bloom.py data/wallets_1e-4.bloom \
        --out data/bloom_chunks --chunk-mb 20
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import struct
import sys

_HEADER = struct.Struct("<8sQI")   # magic, size_bits, num_hashes  (matches src/bloom.py)


def split(src: str, out_dir: str, chunk_mb: int) -> None:
    os.makedirs(out_dir, exist_ok=True)
    total = os.path.getsize(src)
    chunk = chunk_mb * 1024 * 1024
    base = os.path.basename(src)

    with open(src, "rb") as f:
        magic, size_bits, k = _HEADER.unpack(f.read(_HEADER.size))
        if magic != b"CUVREBL1":
            raise SystemExit(f"{src}: not a cuvre bloom file")
        f.seek(0)
        parts, idx = [], 0
        while True:
            buf = f.read(chunk)
            if not buf:
                break
            name = f"{base}.part{idx:03d}"
            with open(os.path.join(out_dir, name), "wb") as w:
                w.write(buf)
            parts.append({"name": name, "bytes": len(buf),
                          "sha256": hashlib.sha256(buf).hexdigest()[:16]})
            idx += 1

    manifest = {
        "file": base,
        "total_bytes": total,
        "size_bits": size_bits,
        "num_hashes": k,
        "header_bytes": _HEADER.size,
        "chunk_bytes": chunk,
        "parts": parts,
    }
    with open(os.path.join(out_dir, "manifest.json"), "w") as m:
        json.dump(manifest, m, indent=2)

    print(f"[split] {src} ({total/1024/1024:.1f} MB) -> {len(parts)} parts of <= {chunk_mb} MB")
    for p in parts:
        print(f"        {p['name']}  ({p['bytes']/1024/1024:.1f} MB)")
    print(f"[split] manifest.json written to {out_dir}/")
    print(f"[split] header: size_bits={size_bits:,}  k={k}")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Split a cuvre .bloom into git-safe chunks.")
    ap.add_argument("src")
    ap.add_argument("--out", default="data/bloom_chunks")
    ap.add_argument("--chunk-mb", type=int, default=20)
    a = ap.parse_args(argv)
    split(a.src, a.out, a.chunk_mb)
    return 0


if __name__ == "__main__":
    sys.exit(main())
