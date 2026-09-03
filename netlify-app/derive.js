// Client-side Bitcoin address derivation (P2PKH compressed) on secp256k1.
// Runs entirely in the browser so the cursor scan needs no server round-trip.
import { ProjectivePoint } from "./vendor/secp256k1.js";
import { ripemd160 } from "./vendor/ripemd160.js";
import { sha256 } from "./vendor/sha256.js";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58(bytes) {
  let num = 0n;
  for (const b of bytes) num = (num << 8n) + BigInt(b);
  let out = "";
  while (num > 0n) { const r = Number(num % 58n); out = B58[r] + out; num /= 58n; }
  for (const b of bytes) { if (b === 0) out = "1" + out; else break; }
  return out;
}

function p2pkhFromPub(pub) {
  const h = ripemd160(sha256(pub));           // hash160
  const payload = new Uint8Array(25);
  payload[0] = 0x00;
  payload.set(h, 1);
  const chk = sha256(sha256(payload.subarray(0, 21)));
  payload.set(chk.subarray(0, 4), 21);
  return base58(payload);
}

export function deriveAddress(k) {
  return p2pkhFromPub(ProjectivePoint.BASE.multiply(k).toRawBytes(true));
}

// Contiguous row-major block: cell (c,r) = k0 + r*stride + c.
// Uses one full multiply per row start, then +G per column (cheap neighbour add).
export function deriveBlock(k0, stride, cols, rows) {
  const G = ProjectivePoint.BASE;
  const out = new Array(cols * rows);
  let rowP = G.multiply(k0);
  const rowStep = stride === 1n ? G : G.multiply(stride);
  for (let r = 0; r < rows; r++) {
    let p = rowP;
    for (let c = 0; c < cols; c++) {
      out[r * cols + c] = p2pkhFromPub(p.toRawBytes(true));
      if (c < cols - 1) p = p.add(G);
    }
    if (r < rows - 1) rowP = rowP.add(rowStep);
  }
  return out;
}
