"""Derive a Bitcoin address from a private key on secp256k1 (pure Python).

Used by the keyspace explorer: a grid cell is a private key `k`, and to know
whether that "wallet" holds anything we derive its P2PKH (compressed) address
and look it up. No third-party crypto deps -- just the group law we worked out.

This is intentionally the reference/simple implementation. It is fast enough to
check the few hundred cells under the cursor on demand; it is NOT meant for
mass brute-force (which is physically hopeless anyway).
"""

from __future__ import annotations

import hashlib

# secp256k1 domain parameters
P = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F
N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
GX = 0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798
GY = 0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8
G = (GX, GY)

_B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def _inv(x: int) -> int:
    return pow(x, P - 2, P)


def _add(Pt, Qt):
    if Pt is None:
        return Qt
    if Qt is None:
        return Pt
    x1, y1 = Pt
    x2, y2 = Qt
    if x1 == x2 and (y1 + y2) % P == 0:
        return None
    if Pt == Qt:
        m = (3 * x1 * x1) * _inv(2 * y1) % P
    else:
        m = (y2 - y1) * _inv(x2 - x1) % P
    x3 = (m * m - x1 - x2) % P
    y3 = (m * (x1 - x3) - y1) % P
    return (x3, y3)


def scalar_mul(k: int, Pt=G):
    """k * Pt via double-and-add."""
    R = None
    while k > 0:
        if k & 1:
            R = _add(R, Pt)
        Pt = _add(Pt, Pt)
        k >>= 1
    return R


def _b58check(payload: bytes) -> str:
    chk = hashlib.sha256(hashlib.sha256(payload).digest()).digest()[:4]
    num = int.from_bytes(payload + chk, "big")
    out = ""
    while num > 0:
        num, rem = divmod(num, 58)
        out = _B58[rem] + out
    pad = len(payload + chk) - len((payload + chk).lstrip(b"\x00"))
    return "1" * pad + out


def compressed_pubkey(k: int) -> bytes:
    x, y = scalar_mul(k)
    prefix = b"\x02" if y % 2 == 0 else b"\x03"
    return prefix + x.to_bytes(32, "big")


def hash160(data: bytes) -> bytes:
    return hashlib.new("ripemd160", hashlib.sha256(data).digest()).digest()


def _compressed_from_point(pt) -> bytes:
    x, y = pt
    return (b"\x02" if y % 2 == 0 else b"\x03") + x.to_bytes(32, "big")


def _p2pkh_from_point(pt) -> str:
    return _b58check(b"\x00" + hash160(_compressed_from_point(pt)))


def p2pkh_address(k: int) -> str:
    """Compressed-pubkey P2PKH address (starts with '1') for private key k."""
    return _p2pkh_from_point(scalar_mul(k))


def _batch_inverse(vals):
    """Invert many field elements with a single modular exponentiation.

    Montgomery's trick: build prefix products, invert the last one, then walk
    back multiplying out. Turns N modinvs (N expensive pow calls) into 1 pow
    plus ~3N multiplications. Callers must ensure no value is zero.
    """
    n = len(vals)
    prefix = [1] * (n + 1)
    for i, v in enumerate(vals):
        prefix[i + 1] = prefix[i] * v % P
    acc = pow(prefix[n], P - 2, P)
    res = [0] * n
    for i in range(n - 1, -1, -1):
        res[i] = prefix[i] * acc % P
        acc = acc * vals[i] % P
    return res


def scan_block_fast(k0: int, stride: int, cols: int, rows: int):
    """Same output as scan_block, but batches the field inversions.

    cell(c, r) = k0 + r*stride + c, and its point is
        rowBase[r] + cG[c]   where rowBase[r] = (k0 + r*stride)*G, cG[c] = c*G.
    The rowBase and cG chains are cheap (cols+rows adds); the rows*(cols-1)
    cell additions are independent, so all their inversions collapse into one
    via Montgomery. Yields (c, r, k, address).
    """
    P0 = scalar_mul(k0)
    Rg = scalar_mul(stride)

    rowBase = [None] * rows
    rowBase[0] = P0
    for r in range(1, rows):
        rowBase[r] = _add(rowBase[r - 1], Rg)

    cG = [None] * cols            # cG[0] = identity (0*G)
    if cols > 1:
        cG[1] = G
    for c in range(2, cols):
        cG[c] = _add(cG[c - 1], G)

    pts = [[None] * cols for _ in range(rows)]
    for r in range(rows):
        pts[r][0] = rowBase[r]

    pairs, dens, specials = [], [], []
    for r in range(rows):
        A = rowBase[r]
        for c in range(1, cols):
            B = cG[c]
            if A is None:
                pts[r][c] = B
            elif A[0] == B[0]:
                specials.append((r, c))      # equal x: doubling/inverse, rare
            else:
                pairs.append((r, c))
                dens.append((B[0] - A[0]) % P)

    for (r, c), inv in zip(pairs, _batch_inverse(dens) if dens else []):
        A, B = rowBase[r], cG[c]
        m = (B[1] - A[1]) * inv % P
        x3 = (m * m - A[0] - B[0]) % P
        pts[r][c] = (x3, (m * (A[0] - x3) - A[1]) % P)
    for (r, c) in specials:
        pts[r][c] = _add(rowBase[r], cG[c])

    for r in range(rows):
        k_row = k0 + r * stride
        for c in range(cols):
            yield c, r, k_row + c, _p2pkh_from_point(pts[r][c])


def scan_block(k0: int, stride: int, cols: int, rows: int):
    """Derive addresses for a contiguous row-major block of the keyspace.

    Cell (c, r) has private key  k0 + r*stride + c.  Instead of a full
    double-and-add per cell, compute k0*G once and reach neighbours by a single
    point addition: +G along a row, +stride*G between rows. Yields
    (c, r, k, address).
    """
    stepG = G                      # +1 in key space
    rowG = scalar_mul(stride)      # +stride in key space (one full mul)
    P = scalar_mul(k0)             # top-left cell (one full mul)
    for r in range(rows):
        rowP = P
        k_row = k0 + r * stride
        for c in range(cols):
            yield c, r, k_row + c, _p2pkh_from_point(rowP)
            if c < cols - 1:
                rowP = _add(rowP, stepG)
        if r < rows - 1:
            P = _add(P, rowG)


if __name__ == "__main__":
    # known test vectors for k = 1
    assert p2pkh_address(1) == "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH", p2pkh_address(1)
    print("k=1 ->", p2pkh_address(1), "OK")
    print("k=2 ->", p2pkh_address(2))
