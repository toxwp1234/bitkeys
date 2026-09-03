// Derives a block of addresses off the main thread so the UI never stutters.
import { deriveBlock } from "./derive.js";

self.onmessage = (e) => {
  const { id, k0, stride, cols, rows } = e.data;
  const addrs = deriveBlock(BigInt(k0), BigInt(stride), cols, rows);
  self.postMessage({ id, addrs, cols, rows });
};
