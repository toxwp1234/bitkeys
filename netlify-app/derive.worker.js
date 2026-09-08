// Derives the addresses of the scanned patch, off the main thread.
import { deriveBlock } from "./derive.js?v=5";

self.onmessage = (e) => {
  const { id, k0, stride, cols, rows } = e.data;
  if (k0 === undefined || stride === undefined) return;   // ignore malformed messages
  const addrs = deriveBlock(BigInt(k0), BigInt(stride), cols, rows);
  self.postMessage({ id, addrs, cols });
};
