// Derives just the sample addresses we display, off the main thread.
import { deriveSample } from "./derive.js?v=3";

self.onmessage = (e) => {
  const { id, k0, count } = e.data;
  self.postMessage({ id, addrs: deriveSample(BigInt(k0), count || 12) });
};
