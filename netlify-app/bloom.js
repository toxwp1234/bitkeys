// Client-side reader for the cuvre Bloom filter. Mirrors src/bloom.py bit-for-bit:
//   digest = blake2b(addr_utf8, digest_size=16)
//   h1 = u64le(digest[0:8]);  h2 = u64le(digest[8:16]) | 1
//   idx_i = (h1 + i*h2) % size_bits   for i in 0..k-1     (BigInt: h1+i*h2 exceeds 2^53)
//   member iff every idx bit is 1;    bit = bits[idx>>3] & (1<<(idx&7))   (LSB-first)
//
// The 126 MB filter is served as N parts (+ manifest.json). We DON'T concatenate:
// parts stay as separate Uint8Arrays and byte access is routed to the right part, so
// peak memory is the filter size itself, not double. Parts are cached in IndexedDB so
// a return visit never re-downloads 126 MB (survives HTTP-cache eviction).

import { blake2b } from "./vendor/blake2b.js";

const enc = new TextEncoder();
const PART_TIMEOUT_MS = 30000;
const PART_RETRIES = 3;

let ready = false;
let SIZE_BITS = 0, K = 0, HEADER = 20, CHUNK = 0, TOTAL = 0;
let PARTS = null;                 // Uint8Array[] in order; PARTS[0] includes the 20-B header

export function isReady() { return ready; }
export function params() { return { size_bits: SIZE_BITS, k: K, header: HEADER, chunk: CHUNK, total: TOTAL, parts: PARTS ? PARTS.length : 0 }; }

// little-endian u64 -> BigInt, from a digest at offset o
function u64le(d, o) {
  let r = 0n;
  for (let i = 7; i >= 0; i--) r = (r << 8n) | BigInt(d[o + i]);
  return r;
}
// absolute file byte f -> the byte, located in its part (no concatenation).
// Every part except the last is exactly CHUNK bytes (validated in load()).
function fileByte(f) {
  const ci = (f / CHUNK) | 0;
  return PARTS[ci][f - ci * CHUNK];
}

export function contains(addr) {
  if (!ready) return false;
  const d = blake2b(enc.encode(addr), null, 16);   // Uint8Array(16)
  const h1 = u64le(d, 0);
  const h2 = u64le(d, 8) | 1n;
  const m = BigInt(SIZE_BITS);
  for (let i = 0; i < K; i++) {
    const idx = Number((h1 + BigInt(i) * h2) % m);
    if ((fileByte((idx >>> 3) + HEADER) & (1 << (idx & 7))) === 0) return false;
  }
  return true;
}

// ---- IndexedDB best-effort cache (keyed by base+part name) ----
function idbOpen() {
  return new Promise((res) => {
    try {
      const r = indexedDB.open("cuvre-bloom", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("parts");
      r.onsuccess = () => res(r.result);
      r.onerror = () => res(null);
    } catch (e) { res(null); }
  });
}
function idbGet(db, key) {
  return new Promise((res) => {
    if (!db) return res(null);
    try { const t = db.transaction("parts").objectStore("parts").get(key);
      t.onsuccess = () => res(t.result || null); t.onerror = () => res(null);
    } catch (e) { res(null); }
  });
}
function idbPut(db, key, val) {
  return new Promise((res) => {
    if (!db) return res();
    try { const t = db.transaction("parts", "readwrite").objectStore("parts").put(val, key);
      t.onsuccess = () => res(); t.onerror = () => res();
    } catch (e) { res(); }
  });
}

async function fetchPart(base, part, onDelta) {
  let lastErr;
  for (let attempt = 0; attempt < PART_RETRIES; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), PART_TIMEOUT_MS);
    let counted = 0;
    try {
      const res = await fetch(base + part.name, { signal: ctl.signal, cache: "no-store" });
      if (!res.ok) throw new Error(part.name + " HTTP " + res.status);
      const buf = new Uint8Array(part.bytes);
      let off = 0;
      const reader = res.body && res.body.getReader ? res.body.getReader() : null;
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (off + value.length > part.bytes) throw new Error(part.name + " overflow");
          buf.set(value, off); off += value.length;
          counted += value.length; onDelta(value.length);
        }
      } else {
        const ab = new Uint8Array(await res.arrayBuffer());
        buf.set(ab, 0); off = ab.length; counted += off; onDelta(off);
      }
      clearTimeout(timer);
      if (off !== part.bytes) throw new Error(`${part.name}: got ${off} bytes, expected ${part.bytes}`);
      return buf;
    } catch (e) {
      clearTimeout(timer);
      onDelta(-counted);                 // roll back this attempt's progress
      lastErr = e;
    }
  }
  throw new Error(`failed to load ${part.name} after ${PART_RETRIES} tries: ${lastErr && lastErr.message}`);
}

// Load the whole filter. base e.g. "/bloom/" (local) or the jsDelivr URL (prod).
// onProgress(loadedBytes, totalBytes) is called as bytes arrive.
export async function load(base, onProgress) {
  onProgress = onProgress || (() => {});
  const man = await (await fetch(base + "manifest.json", { cache: "no-store" })).json();

  SIZE_BITS = man.size_bits; K = man.num_hashes; HEADER = man.header_bytes;
  CHUNK = man.chunk_bytes; TOTAL = man.total_bytes;
  const parts = man.parts;

  // structural validation BEFORE any download
  const bitBytes = Math.ceil(SIZE_BITS / 8);
  if (HEADER + bitBytes !== TOTAL) throw new Error(`manifest: header+ceil(size_bits/8)=${HEADER + bitBytes} != total_bytes=${TOTAL}`);
  const sum = parts.reduce((a, p) => a + p.bytes, 0);
  if (sum !== TOTAL) throw new Error(`manifest: parts sum ${sum} != total_bytes ${TOTAL}`);
  for (let i = 0; i < parts.length - 1; i++) {
    if (parts[i].bytes !== CHUNK) throw new Error(`part ${i} is ${parts[i].bytes}, must equal chunk_bytes ${CHUNK} (fileByte() assumes uniform chunks)`);
  }

  const db = await idbOpen();
  const cacheKey = (p) => base + p.name + ":" + p.bytes;
  let loaded = 0;
  const bump = (d) => { loaded += d; onProgress(loaded, TOTAL); };

  const buffers = await Promise.all(parts.map(async (p) => {
    const key = cacheKey(p);
    const cached = await idbGet(db, key);
    if (cached && cached.byteLength === p.bytes) { bump(p.bytes); return new Uint8Array(cached); }
    const buf = await fetchPart(base, p, bump);
    idbPut(db, key, buf.buffer);        // fire-and-forget cache write
    return buf;
  }));

  // header (from part 0) must agree with the manifest — two sources of truth reconciled
  const h = buffers[0];
  const magic = String.fromCharCode(...h.subarray(0, 8));
  if (magic !== "CUVREBL1") throw new Error("bloom: bad magic '" + magic + "'");
  const dv = new DataView(h.buffer, h.byteOffset, 20);
  const hdrSizeBits = Number(dv.getBigUint64(8, true));
  const hdrK = dv.getUint32(16, true);
  if (hdrSizeBits !== SIZE_BITS) throw new Error(`header size_bits ${hdrSizeBits} != manifest ${SIZE_BITS}`);
  if (hdrK !== K) throw new Error(`header k ${hdrK} != manifest ${K}`);

  PARTS = buffers;
  ready = true;
  return params();
}
