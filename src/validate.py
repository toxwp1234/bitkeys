"""Lightweight Bitcoin address validation (no third-party deps).

Supports the address types that actually appear in a funded-address snapshot:
  * P2PKH  / P2SH   -> Base58Check  (prefixes '1' and '3')
  * P2WPKH / P2WSH  -> Bech32       (prefix 'bc1', witness v0)
  * P2TR            -> Bech32m      (prefix 'bc1p', witness v1)

Validation is structural: it confirms the encoding and checksum are correct,
so we never waste a database lookup on a typo'd or malformed string.
"""

from __future__ import annotations

import hashlib

_B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
_B58_INDEX = {c: i for i, c in enumerate(_B58_ALPHABET)}


def _b58check_valid(addr: str) -> bool:
    if not (26 <= len(addr) <= 35):
        return False
    num = 0
    for ch in addr:
        val = _B58_INDEX.get(ch)
        if val is None:
            return False
        num = num * 58 + val
    raw = num.to_bytes(25, "big") if num else b""
    # account for leading '1's -> leading zero bytes
    pad = len(addr) - len(addr.lstrip("1"))
    raw = b"\x00" * pad + num.to_bytes((num.bit_length() + 7) // 8, "big")
    if len(raw) != 25:
        return False
    payload, checksum = raw[:-4], raw[-4:]
    digest = hashlib.sha256(hashlib.sha256(payload).digest()).digest()
    return digest[:4] == checksum


_BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"
_BECH32_CONST = 1
_BECH32M_CONST = 0x2BC830A3


def _bech32_polymod(values) -> int:
    generators = (0x3B6A57B2, 0x26508E6D, 0x1EA119FA, 0x3D4233DD, 0x2A1462B3)
    chk = 1
    for v in values:
        top = chk >> 25
        chk = ((chk & 0x1FFFFFF) << 5) ^ v
        for i, g in enumerate(generators):
            if (top >> i) & 1:
                chk ^= g
    return chk


def _bech32_hrp_expand(hrp: str):
    return [ord(c) >> 5 for c in hrp] + [0] + [ord(c) & 31 for c in hrp]


def _bech32_valid(addr: str) -> bool:
    addr_low = addr.lower()
    if addr != addr_low and addr != addr.upper():
        return False  # mixed case not allowed
    addr = addr_low
    pos = addr.rfind("1")
    if pos < 1 or pos + 7 > len(addr) or len(addr) > 90:
        return False
    hrp, data_part = addr[:pos], addr[pos + 1:]
    if hrp != "bc":
        return False
    try:
        data = [_BECH32_CHARSET.index(c) for c in data_part]
    except ValueError:
        return False
    if not data:
        return False
    witver = data[0]
    const = _bech32_polymod(_bech32_hrp_expand(hrp) + data)
    expected = _BECH32M_CONST if witver >= 1 else _BECH32_CONST
    return const == expected and 0 <= witver <= 16


def is_valid_btc_address(addr: str) -> bool:
    if not addr:
        return False
    if addr[0] in "13":
        return _b58check_valid(addr)
    if addr[:3].lower() == "bc1":
        return _bech32_valid(addr)
    return False
