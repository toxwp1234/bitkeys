"""The lookup engine: Bloom fast-path in front of an exact SQLite lookup.

    address --> [structural validation] --> [Bloom filter in RAM] --> [SQLite]

Most queries stop at the Bloom filter (a random/unused address is almost never
present), so they never touch disk. A hit -- or a rare Bloom false positive --
is resolved exactly against SQLite, which also returns the balance.
"""

from __future__ import annotations

import sqlite3
import time
from dataclasses import dataclass, asdict

from .bloom import BloomFilter
from .validate import is_valid_btc_address

SATS_PER_BTC = 100_000_000


@dataclass
class Result:
    address: str
    valid: bool
    funded: bool
    balance_sat: int
    balance_btc: float
    source: str          # where the answer came from: invalid | bloom | db | db-fp
    lookup_us: float

    def as_dict(self):
        return asdict(self)


class Checker:
    def __init__(self, db_path: str, bloom_path: str):
        self.conn = sqlite3.connect(db_path, check_same_thread=False)
        self.conn.execute("PRAGMA query_only=ON")
        self._select = "SELECT balance FROM addresses WHERE address=?"
        self.bloom = BloomFilter.load(bloom_path, use_mmap=True)

    def check(self, address: str) -> Result:
        t0 = time.perf_counter()

        if not is_valid_btc_address(address):
            return self._done(address, False, False, 0, "invalid", t0)

        if address.encode() not in self.bloom:
            return self._done(address, True, False, 0, "bloom", t0)

        row = self.conn.execute(self._select, (address,)).fetchone()
        if row is None:
            return self._done(address, True, False, 0, "db-fp", t0)
        return self._done(address, True, True, row[0], "db", t0)

    @staticmethod
    def _done(address, valid, funded, sat, source, t0) -> Result:
        return Result(
            address=address,
            valid=valid,
            funded=funded,
            balance_sat=sat,
            balance_btc=sat / SATS_PER_BTC,
            source=source,
            lookup_us=(time.perf_counter() - t0) * 1e6,
        )

    def lookup(self, address: str):
        """Lean funded-check for already-valid addresses (keyspace scan).

        Returns balance in satoshi if funded, else None. Skips validation.
        """
        if address.encode() not in self.bloom:
            return None
        row = self.conn.execute(self._select, (address,)).fetchone()
        return row[0] if row else None

    def stats(self) -> dict:
        try:
            count = self.conn.execute("SELECT value FROM meta WHERE key='count'").fetchone()[0]
        except sqlite3.OperationalError:
            count = self.conn.execute("SELECT COUNT(*) FROM addresses").fetchone()[0]
        return {
            "funded_addresses": count,
            "bloom_size_mb": round(self.bloom.size_mb, 1),
            "bloom_hashes": self.bloom.num_hashes,
        }

    def close(self):
        self.conn.close()
        self.bloom.close()
