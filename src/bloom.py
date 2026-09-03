"""A compact, mmap-friendly Bloom filter.

The filter is the "fast NO" layer: membership is checked entirely in RAM,
so the vast majority of addresses (which are NOT funded) are rejected without
ever touching the SQLite file on disk. Only a positive (or a rare false
positive) falls through to the exact lookup.

Design notes:
  * Sizing follows the standard optimal formulas for a target false-positive
    rate p over n expected items.
  * k bit positions per item are derived from a single 128-bit BLAKE2b digest
    using the Kirsch-Mitzenmacher double-hashing trick (h1 + i*h2), so we only
    hash once per item instead of k times.
  * The bit array is a flat byte buffer, persisted with a tiny header so the
    query side can mmap it read-only and share pages across processes.
"""

from __future__ import annotations

import hashlib
import math
import mmap
import struct

_MAGIC = b"CUVREBL1"
_HEADER = struct.Struct("<8sQI")  # magic, size_bits, num_hashes


class BloomFilter:
    __slots__ = ("size_bits", "num_hashes", "bits", "_mm", "_fh")

    def __init__(self, size_bits: int, num_hashes: int, bits=None):
        self.size_bits = size_bits
        self.num_hashes = num_hashes
        num_bytes = (size_bits + 7) // 8
        self.bits = bytearray(num_bytes) if bits is None else bits
        self._mm = None
        self._fh = None

    @classmethod
    def for_capacity(cls, n: int, fp_rate: float) -> "BloomFilter":
        """Build an empty filter sized for n items at the given FP rate."""
        n = max(1, n)
        size_bits = math.ceil(-n * math.log(fp_rate) / (math.log(2) ** 2))
        num_hashes = max(1, round((size_bits / n) * math.log(2)))
        return cls(size_bits, num_hashes)

    def _indices(self, item: bytes):
        digest = hashlib.blake2b(item, digest_size=16).digest()
        h1 = int.from_bytes(digest[:8], "little")
        h2 = int.from_bytes(digest[8:], "little") | 1  # odd -> better spread
        m = self.size_bits
        for i in range(self.num_hashes):
            yield (h1 + i * h2) % m

    def add(self, item: bytes) -> None:
        bits = self.bits
        for idx in self._indices(item):
            bits[idx >> 3] |= 1 << (idx & 7)

    def __contains__(self, item: bytes) -> bool:
        bits = self.bits
        for idx in self._indices(item):
            if not (bits[idx >> 3] & (1 << (idx & 7))):
                return False
        return True

    def save(self, path: str) -> None:
        with open(path, "wb") as f:
            f.write(_HEADER.pack(_MAGIC, self.size_bits, self.num_hashes))
            f.write(self.bits)

    @classmethod
    def load(cls, path: str, use_mmap: bool = True) -> "BloomFilter":
        fh = open(path, "rb")
        magic, size_bits, num_hashes = _HEADER.unpack(fh.read(_HEADER.size))
        if magic != _MAGIC:
            fh.close()
            raise ValueError(f"{path}: not a cuvre bloom file")
        if use_mmap:
            mm = mmap.mmap(fh.fileno(), 0, access=mmap.ACCESS_READ)
            bits = memoryview(mm)[_HEADER.size:]
            obj = cls(size_bits, num_hashes, bits=bits)
            obj._mm = mm
            obj._fh = fh
            return obj
        data = bytearray(fh.read())
        fh.close()
        return cls(size_bits, num_hashes, bits=data)

    def close(self) -> None:
        if self._mm is not None:
            self.bits = None
            self._mm.close()
            self._mm = None
        if self._fh is not None:
            self._fh.close()
            self._fh = None

    @property
    def size_mb(self) -> float:
        return self.size_bits / 8 / 1024 / 1024
