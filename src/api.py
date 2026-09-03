"""FastAPI wrapper around the lookup engine + static frontend.

Run:
    uvicorn src.api:app --reload
Then open http://127.0.0.1:8000/

Env overrides:
    CUVRE_DB     (default data/wallets.db)
    CUVRE_BLOOM  (default data/wallets.bloom)
"""

from __future__ import annotations

import os
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Query
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .checker import Checker
from .derive import scan_block_fast as scan_block, N as CURVE_N

DB_PATH = os.environ.get("CUVRE_DB", "data/wallets.db")
BLOOM_PATH = os.environ.get("CUVRE_BLOOM", "data/wallets.bloom")
WEB_DIR = Path(__file__).resolve().parent.parent / "web"

state: dict = {}


@asynccontextmanager
async def lifespan(app: FastAPI):
    state["checker"] = Checker(DB_PATH, BLOOM_PATH)
    yield
    state["checker"].close()


app = FastAPI(title="cuvre", description="Bitcoin funded-address checker", lifespan=lifespan)


@app.get("/api/check")
def check(address: str = Query(..., min_length=1, max_length=100)):
    return state["checker"].check(address.strip()).as_dict()


@app.get("/api/stats")
def stats():
    return state["checker"].stats()


class CheckBatchReq(BaseModel):
    addresses: list[str]


@app.post("/api/check_batch")
def check_batch(req: CheckBatchReq):
    """Funded-check a batch of client-derived addresses (no server EC work)."""
    checker = state["checker"]
    addrs = req.addresses[:30000]
    hits = []
    for i, a in enumerate(addrs):
        sat = checker.lookup(a)
        if sat is not None:
            hits.append({"i": i, "balance_btc": sat / 1e8})
    return {"checked": len(addrs), "hits": hits}


class ScanReq(BaseModel):
    start: str          # decimal private key of the block's top-left cell
    stride: str         # decimal row stride (grid width in key space)
    cols: int
    rows: int


@app.post("/api/scan")
def scan(req: ScanReq):
    try:
        k0 = int(req.start)
        stride = int(req.stride)
    except ValueError:
        return JSONResponse({"error": "start/stride must be integers"}, status_code=400)
    cols = max(1, min(req.cols, 160))
    rows = max(1, min(req.rows, 160))
    if cols * rows > 25600:
        return JSONResponse({"error": "block too large (max 25600 cells)"}, status_code=400)
    if k0 < 1:
        k0 = 1

    checker = state["checker"]
    t0 = time.perf_counter()
    hits = []
    sample = []
    checked = 0
    for c, r, k, addr in scan_block(k0, stride, cols, rows):
        if k >= CURVE_N:
            continue
        checked += 1
        if len(sample) < 6:
            sample.append({"k_hex": format(k, "x"), "address": addr})
        sat = checker.lookup(addr)
        if sat is not None:
            hits.append({"c": c, "r": r, "k": str(k),
                         "address": addr, "balance_btc": sat / 1e8})
    return {"checked": checked, "hits": hits, "sample": sample,
            "ms": round((time.perf_counter() - t0) * 1000, 1)}


@app.get("/api/health")
def health():
    return {"ok": True}


if WEB_DIR.is_dir():
    app.mount("/", StaticFiles(directory=str(WEB_DIR), html=True), name="web")
else:
    @app.get("/")
    def root():
        return JSONResponse({"note": "web/ not found; API only", "try": "/api/check?address=..."})
