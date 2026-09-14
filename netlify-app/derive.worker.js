// Derives every private key in the scanned patch, encodes each to its address, and tests
// it against the Bloom filter — all off the main thread and STREAMED in chunks so the UI
// never freezes no matter how large the pen. A newer scan cancels the running one.
import { deriveBlock } from "./derive.js?v=5";
import * as bloom from "./bloom.js?v=1";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DISPLAY = 2048;   // addresses sent up for the on-screen sample list
const CHUNK = 2048;     // keys derived+checked per step (bounds cancel latency ~150ms)
let currentScan = 0;

self.onmessage = async (e) => {
  const d = e.data;

  if (d.type === "loadBloom") {
    try {
      const p = await bloom.load(d.base, (loaded, total) => self.postMessage({ type: "bloomProgress", loaded, total }));
      self.postMessage({ type: "bloomReady", params: p });
    } catch (err) { self.postMessage({ type: "bloomError", error: String((err && err.message) || err) }); }
    return;
  }

  if (d.type === "calc") {                         // key -> address (single, for the modal)
    const a = deriveBlock(BigInt(d.k0), 1n, 1, 1);
    self.postMessage({ type: "calcResult", id: d.id, addr: a[0] });
    return;
  }

  if (d.type === "cancel") { currentScan++; return; }   // stop the running scan loop (reset)

  if (d.type === "scan") {
    const id = ++currentScan;
    const k0 = BigInt(d.k0), stride = BigInt(d.stride), cols = d.cols, rows = d.rows;
    const total = cols * rows;
    const on = bloom.isReady();
    let checked = 0, foundCount = 0, sent = false, displaySent = false, lastPost = 0;
    const display = [];

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c += CHUNK) {
        if (id !== currentScan) return;            // a newer scan superseded this one — stop
        const cc = Math.min(CHUNK, cols - c);
        const block = deriveBlock(k0 + BigInt(r) * stride + BigInt(c), 1n, cc, 1);  // cc consecutive keys
        const candidates = [];
        if (on) for (let j = 0; j < cc; j++) if (bloom.contains(block[j])) candidates.push({ i: r * cols + (c + j), addr: block[j] });
        checked += cc; foundCount += candidates.length;
        for (let j = 0; j < cc && display.length < DISPLAY; j++) display.push(block[j]);

        const now = performance.now();
        const sendDisplay = !displaySent && (display.length >= DISPLAY);
        if (candidates.length || sendDisplay || !sent || now - lastPost > 90) {
          lastPost = now;
          self.postMessage({ type: "scanProgress", id, checked, total, cols, foundCount, candidates,
                             display: sendDisplay ? display.slice() : null, bloomOn: on });
          sent = true; if (sendDisplay) displaySent = true;
        }
        await sleep(0);                             // yield so a cancel/new scan can be delivered
      }
    }
    self.postMessage({ type: "scanDone", id, checked, total, foundCount, bloomOn: on,
                       display: displaySent ? null : display });
    return;
  }
};
