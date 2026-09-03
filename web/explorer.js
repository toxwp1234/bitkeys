"use strict";
const $ = (s) => document.querySelector(s);
const canvas = $("#canvas");
const ctx = canvas.getContext("2d");
const mm = $("#minimap");
const mmctx = mm.getContext("2d");
const MM = mm.width;

// ---------- BigInt helpers ----------
function isqrt(n) {
  if (n < 2n) return n;
  let x = n, y = (x + 1n) >> 1n;
  while (y < x) { x = y; y = (x + n / x) >> 1n; }
  return x;
}
function ceilSqrt(n) { const r = isqrt(n); return r * r < n ? r + 1n : r; }
function clampB(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
function clampN(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
const TWO256 = 2n ** 256n;
const MMb = BigInt(MM);

// ---------- state ----------
let rangeStart = 1n, rangeEnd = TWO256, T = rangeEnd - rangeStart;
let W = ceilSqrt(T), H = (T + W - 1n) / W;
let cellPx = 26, minCell = 2, maxCell = 160;
let viewGx = 0n, viewGy = 0n, subX = 0, subY = 0;
let cursorGx = 0n, cursorGy = 0n, cursorC = 8;
let visCols = 0, visRows = 0;
let hits = new Map();
let scanned = new Set();
const TRAIL_CAP = 500000;
let totalChecked = 0, totalHits = 0;
let dragging = false, lastX = 0, lastY = 0;
let scanTimer = null, lastMouse = null;

// minimap heat as an offscreen ImageData (updated incrementally, blitted once/frame)
const heatImg = mmctx.createImageData(MM, MM);
function fillHeatBg() {
  const d = heatImg.data;
  for (let i = 0; i < d.length; i += 4) { d[i] = 10; d[i + 1] = 12; d[i + 2] = 16; d[i + 3] = 255; }
}
fillHeatBg();

const kAt = (gx, gy) => rangeStart + gy * W + gx;
const toMMx = (gx) => Number((gx * MMb) / W);
const toMMy = (gy) => Number((gy * MMb) / H);

function computeMinCell() {
  const r = canvas.getBoundingClientRect();
  minCell = Math.max(1.5, Math.sqrt((r.width * r.height) / 90000));
}

function normalize() {
  while (subX >= cellPx) { subX -= cellPx; viewGx += 1n; }
  while (subX < 0) { subX += cellPx; viewGx -= 1n; }
  while (subY >= cellPx) { subY -= cellPx; viewGy += 1n; }
  while (subY < 0) { subY += cellPx; viewGy -= 1n; }
  if (viewGx < 0n) { viewGx = 0n; subX = 0; }
  if (viewGy < 0n) { viewGy = 0n; subY = 0; }
  if (viewGx > W) viewGx = W;
  if (viewGy > H) viewGy = H;
}

function resize() {
  const r = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = r.width * dpr; canvas.height = r.height * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  computeMinCell();
  if (cellPx < minCell) cellPx = minCell;
  requestDraw();
}

// rAF-coalesced rendering: never draw more than once per frame
let drawPending = false;
function requestDraw() {
  if (drawPending) return;
  drawPending = true;
  requestAnimationFrame(() => { drawPending = false; draw(); });
}

function draw() {
  const r = canvas.getBoundingClientRect();
  const w = r.width, h = r.height;
  ctx.clearRect(0, 0, w, h);
  visCols = Math.ceil((w + subX) / cellPx) + 1;
  visRows = Math.ceil((h + subY) / cellPx) + 1;

  const remX = W - viewGx, remY = H - viewGy;
  const rxMax = remX > BigInt(visCols) ? visCols : Number(remX);
  const ryMax = remY > BigInt(visRows) ? visRows : Number(remY);
  const cw = Math.max(1, cellPx - (cellPx > 6 ? 1 : 0));
  const doHits = hits.size > 0;
  const doTrail = scanned.size > 0 && cellPx >= 6;   // trail invisible when tiny -> skip

  ctx.fillStyle = "#12151b";
  for (let ry = 0; ry < ryMax; ry++) {
    const py = ry * cellPx - subY;
    if (!doHits && !doTrail) {                        // fast path: uniform field
      for (let rx = 0; rx < rxMax; rx++) ctx.fillRect(rx * cellPx - subX, py, cw, cw);
      continue;
    }
    const gyStr = "," + (viewGy + BigInt(ry)).toString();
    for (let rx = 0; rx < rxMax; rx++) {
      const px = rx * cellPx - subX;
      const key = (viewGx + BigInt(rx)).toString() + gyStr;
      if (doHits && hits.has(key)) ctx.fillStyle = "#3fb950";
      else if (doTrail && scanned.has(key)) ctx.fillStyle = "#1f4a5c";
      else ctx.fillStyle = "#12151b";
      ctx.fillRect(px, py, cw, cw);
    }
  }

  const cpx = Number(cursorGx - viewGx) * cellPx - subX;
  const cpy = Number(cursorGy - viewGy) * cellPx - subY;
  const size = cursorC * cellPx;
  ctx.fillStyle = "rgba(247,147,26,0.10)"; ctx.fillRect(cpx, cpy, size, size);
  ctx.strokeStyle = "#f7931a"; ctx.lineWidth = 2;
  ctx.strokeRect(cpx + 0.5, cpy + 0.5, size - 1, size - 1);

  drawMinimap();
  updateReadouts();
}

function drawMinimap() {
  mmctx.putImageData(heatImg, 0, 0);
  const vx = toMMx(viewGx), vy = toMMy(viewGy);
  const vw = Math.max(3, Number((BigInt(Math.max(1, visCols)) * MMb) / W));
  const vh = Math.max(3, Number((BigInt(Math.max(1, visRows)) * MMb) / H));
  mmctx.strokeStyle = "#f7931a"; mmctx.lineWidth = 1.5;
  mmctx.strokeRect(vx + 0.5, vy + 0.5, Math.min(vw, MM), Math.min(vh, MM));
  mmctx.fillStyle = "#ffd591";
  mmctx.fillRect(toMMx(cursorGx) - 1, toMMy(cursorGy) - 1, 3, 3);
}

function updateReadouts() {
  const n = visCols * visRows;
  $("#kScreen").textContent = n.toLocaleString("en-US") + " keys  ≈ 2^" + Math.log2(Math.max(1, n)).toFixed(1);
}

function cursorFromMouse(mx, my) {
  const fx = (mx + subX) / cellPx, fy = (my + subY) / cellPx;
  let gx = viewGx + BigInt(Math.floor(fx));
  let gy = viewGy + BigInt(Math.floor(fy));
  const cc = BigInt(cursorC);
  gx = clampB(gx, 0n, W - cc > 0n ? W - cc : 0n);
  gy = clampB(gy, 0n, H - cc > 0n ? H - cc : 0n);
  return [gx, gy];
}

// Address derivation runs in a worker (off the main thread). We paint the trail
// optimistically the instant addresses come back, and fire the funded-check in
// the background -- a hit is a ~10^-41 event, so we never make the UI wait on it.
const worker = new Worker("derive.worker.js", { type: "module" });
let scanId = 0, pending = null;

function scanCursor() {
  const k0 = kAt(cursorGx, cursorGy);
  const id = ++scanId;
  pending = { id, gx: cursorGx, gy: cursorGy, c: cursorC };
  $("#kHex").textContent = "0x" + k0.toString(16);
  worker.postMessage({ id, k0: k0.toString(), stride: W.toString(), cols: cursorC, rows: cursorC });
}

worker.onmessage = (e) => {
  const { id, addrs, cols, rows } = e.data;
  if (!pending || pending.id !== id) return;         // a newer scan superseded this
  const gx = pending.gx, gy = pending.gy;

  totalChecked += addrs.length;
  $("#mChecked").textContent = totalChecked.toLocaleString("en-US");
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++)
      addTrail(gx + BigInt(c), gy + BigInt(r));
  $("#samples").innerHTML = addrs.slice(0, 6).map((a) => `<div class="row">${a}</div>`).join("");
  $("#kFrac").textContent = fracExplored();
  requestDraw();

  fetch("/api/check_batch", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ addresses: addrs }),
  }).then((r) => r.json()).then((d) => {
    if (!d || !d.hits || !d.hits.length) return;
    for (const h of d.hits) {
      const c = h.i % cols, r = (h.i - c) / cols;
      hits.set((gx + BigInt(c)) + "," + (gy + BigInt(r)), h.balance_btc);
      totalHits++;
    }
    $("#mHits").textContent = totalHits.toLocaleString("en-US");
    requestDraw();
  }).catch(() => {});
};

function addTrail(gx, gy) {
  const key = gx + "," + gy;
  if (!scanned.has(key)) {
    scanned.add(key);
    if (scanned.size > TRAIL_CAP) scanned.delete(scanned.keys().next().value);
  }
  const idx = (toMMy(gy) * MM + toMMx(gx)) * 4;
  if (idx >= 0 && idx < heatImg.data.length) {
    heatImg.data[idx] = 31; heatImg.data[idx + 1] = 74; heatImg.data[idx + 2] = 92;
  }
}

function fracExplored() {
  const pct = Number(BigInt(totalChecked) * 10n ** 40n / TWO256) / 1e40 * 100;
  return pct === 0 ? "0.0000000000 %" : pct.toExponential(4) + " %";
}
function scheduleScan() { clearTimeout(scanTimer); scanTimer = setTimeout(scanCursor, 120); }

// ---------- main-canvas interaction ----------
canvas.addEventListener("mousedown", (e) => { dragging = true; lastX = e.clientX; lastY = e.clientY; });
window.addEventListener("mouseup", () => { dragging = false; });
canvas.addEventListener("mousemove", (e) => {
  const r = canvas.getBoundingClientRect();
  const mx = e.clientX - r.left, my = e.clientY - r.top;
  if (dragging) {
    subX -= (e.clientX - lastX); subY -= (e.clientY - lastY);
    lastX = e.clientX; lastY = e.clientY; normalize();
  }
  lastMouse = [mx, my];
  [cursorGx, cursorGy] = cursorFromMouse(mx, my);
  requestDraw(); scheduleScan();
});
canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  const r = canvas.getBoundingClientRect();
  const mx = e.clientX - r.left, my = e.clientY - r.top;
  if (e.shiftKey) {
    setCursorSize(cursorC + (e.deltaY < 0 ? 1 : -1));
    [cursorGx, cursorGy] = cursorFromMouse(mx, my);
    requestDraw(); scheduleScan();
    return;
  }
  const fx = (mx + subX) / cellPx, fy = (my + subY) / cellPx;
  const anchGx = viewGx + BigInt(Math.floor(fx)), anchFx = fx - Math.floor(fx);
  const anchGy = viewGy + BigInt(Math.floor(fy)), anchFy = fy - Math.floor(fy);
  cellPx = clampN(cellPx * (e.deltaY < 0 ? 1.15 : 1 / 1.15), minCell, maxCell);
  viewGx = anchGx; subX = anchFx * cellPx - mx;
  viewGy = anchGy; subY = anchFy * cellPx - my;
  normalize();
  [cursorGx, cursorGy] = cursorFromMouse(mx, my);
  requestDraw(); scheduleScan();
}, { passive: false });

// ---------- minimap teleport ----------
let mmDrag = false;
function mmJump(e) {
  const r = mm.getBoundingClientRect();
  const px = clampN((e.clientX - r.left) / r.width, 0, 1);
  const py = clampN((e.clientY - r.top) / r.height, 0, 1);
  const tgx = (W * BigInt(Math.round(px * MM))) / MMb;
  const tgy = (H * BigInt(Math.round(py * MM))) / MMb;
  viewGx = clampB(tgx - BigInt(Math.floor(visCols / 2)), 0n, W);
  viewGy = clampB(tgy - BigInt(Math.floor(visRows / 2)), 0n, H);
  subX = 0; subY = 0; normalize(); requestDraw();
}
mm.addEventListener("mousedown", (e) => { mmDrag = true; mmJump(e); });
mm.addEventListener("mousemove", (e) => { if (mmDrag) mmJump(e); });
window.addEventListener("mouseup", () => { mmDrag = false; });

// ---------- controls ----------
function setCursorSize(v) {
  cursorC = clampN(Math.round(v), 1, 128);
  $("#csize").value = cursorC; $("#csizeVal").textContent = cursorC;
}
$("#csize").addEventListener("input", (e) => {
  setCursorSize(parseInt(e.target.value));
  if (lastMouse) [cursorGx, cursorGy] = cursorFromMouse(lastMouse[0], lastMouse[1]);
  requestDraw(); scheduleScan();
});
$("#mode").addEventListener("change", (e) => {
  const custom = e.target.value === "custom";
  $("#fa").style.display = custom ? "" : "none";
  $("#fb").style.display = custom ? "" : "none";
});
$("#apply").addEventListener("click", applyRange);
$("#clearTrail").addEventListener("click", () => {
  scanned.clear(); hits.clear(); fillHeatBg(); totalChecked = 0; totalHits = 0;
  $("#mChecked").textContent = "0"; $("#mHits").textContent = "0"; requestDraw();
});

function applyRange() {
  const mode = $("#mode").value;
  setCursorSize(parseInt($("#csize").value) || 8);
  if (mode === "full") { rangeStart = 1n; rangeEnd = TWO256; }
  else {
    let a = clampB(BigInt(parseInt($("#expa").value) || 1), 1n, 255n);
    let b = clampB(BigInt(parseInt($("#expb").value) || 2), 2n, 256n);
    if (b <= a) b = a + 1n;
    rangeStart = 2n ** a; rangeEnd = 2n ** b;
  }
  T = rangeEnd - rangeStart; W = ceilSqrt(T); H = (T + W - 1n) / W;
  viewGx = 0n; viewGy = 0n; subX = 0; subY = 0; cursorGx = 0n; cursorGy = 0n;
  cellPx = 26; if (cellPx < minCell) cellPx = minCell;
  hits.clear(); scanned.clear(); fillHeatBg(); totalChecked = 0; totalHits = 0;
  $("#mChecked").textContent = "0"; $("#mHits").textContent = "0"; requestDraw();
}

window.addEventListener("resize", resize);
computeMinCell();
applyRange();
resize();
