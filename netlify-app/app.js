"use strict";
const $ = (s) => document.querySelector(s);
const stage = $("#stage");
const grid = $("#grid");
const trail = $("#trail");
const tctx = trail.getContext("2d");
const cursor = $("#cursor");
const mm = $("#minimap");
const mmctx = mm.getContext("2d");
const MM = mm.width, MMb = BigInt(MM);
const TWO256 = 2n ** 256n;

const clampB = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const clampN = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// ---------- state ----------
let aX = 128n, aY = 128n;
let W = 2n ** aX, H = 2n ** aY;
let cellPx = 28, minCell = 1.2, maxCell = 160;
let raw = false;
let lastScan = null;
let landing = null;   // last teleport target, drawn as a red marker
let viewX = 0n, viewY = 0n, subX = 0, subY = 0;
let penC = 16;
let patches = [];                 // {x,y,c} solid scanned squares
let seen = new Set();             // dedup "x,y,c"
let heatImg = mmctx.createImageData(MM, MM);
let keysScanned = 0;
let mouse = { x: 40, y: 40, inside: false };

const kAt = (x, y) => y * W + x + 1n;
const toMMx = (x) => Number((x * MMb) / W);
const toMMy = (y) => Number((y * MMb) / H);
// compact display for huge numbers: 0x1a2b…f9c0
const shortHex = (v, head = 6, tail = 6) => {
  const h = v.toString(16);
  return h.length <= head + tail + 1 ? "0x" + h : "0x" + h.slice(0, head) + "…" + h.slice(-tail);
};
// position along an axis as a percentage (BigInt-safe, 4 decimals)
const pctOf = (v, span) => (Number((v * 1000000n) / span) / 10000).toFixed(4) + "%";

function fillHeatBg() {
  const d = heatImg.data;
  for (let i = 0; i < d.length; i += 4) { d[i] = 10; d[i + 1] = 12; d[i + 2] = 16; d[i + 3] = 255; }
}
fillHeatBg();

function resize() {
  const w = stage.clientWidth, h = stage.clientHeight;
  const dpr = window.devicePixelRatio || 1;
  trail.width = w * dpr; trail.height = h * dpr; trail.style.width = w + "px"; trail.style.height = h + "px";
  tctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  render();
}

function normalize() {
  while (subX >= cellPx) { subX -= cellPx; viewX += 1n; }
  while (subX < 0) { subX += cellPx; viewX -= 1n; }
  while (subY >= cellPx) { subY -= cellPx; viewY += 1n; }
  while (subY < 0) { subY += cellPx; viewY -= 1n; }
  if (viewX < 0n) { viewX = 0n; subX = 0; }
  if (viewY < 0n) { viewY = 0n; subY = 0; }
  if (viewX > W) viewX = W;
  if (viewY > H) viewY = H;
}

// ---------- rendering ----------
let pending = false;
function render() { if (pending) return; pending = true; requestAnimationFrame(() => { pending = false; draw(); }); }

function draw() {
  grid.style.backgroundSize = cellPx + "px " + cellPx + "px";
  grid.style.backgroundPosition = (-subX) + "px " + (-subY) + "px";

  const w = stage.clientWidth, h = stage.clientHeight;
  tctx.clearRect(0, 0, w, h);
  tctx.fillStyle = raw ? "#000000" : "#1f6f88";
  for (const p of patches) {
    const sx = Number(p.x - viewX) * cellPx - subX;
    const sy = Number(p.y - viewY) * cellPx - subY;
    const s = p.c * cellPx;
    if (sx > w || sy > h || sx + s < 0 || sy + s < 0) continue;
    tctx.fillRect(sx, sy, s, s);
  }
  if (landing) {   // red marker: where you just teleported
    const lx = Number(landing.x - viewX) * cellPx - subX;
    const ly = Number(landing.y - viewY) * cellPx - subY;
    const s = Math.max(penC * cellPx, 10);
    tctx.fillStyle = "rgba(240,97,109,0.18)"; tctx.fillRect(lx, ly, s, s);
    tctx.strokeStyle = "#f0616d"; tctx.lineWidth = 2; tctx.strokeRect(lx + 0.5, ly + 0.5, s - 1, s - 1);
  }
  drawMinimap();
  positionCursor();
  scheduleSave();
}

function drawMinimap() {
  mmctx.putImageData(heatImg, 0, 0);
  const vw = stage.clientWidth / cellPx, vh = stage.clientHeight / cellPx;
  const rx = toMMx(viewX), ry = toMMy(viewY);
  const rw = Math.max(3, Number((BigInt(Math.ceil(vw)) * MMb) / W));
  const rh = Math.max(3, Number((BigInt(Math.ceil(vh)) * MMb) / H));
  mmctx.strokeStyle = "#f7931a"; mmctx.lineWidth = 1.5;
  mmctx.strokeRect(rx + 0.5, ry + 0.5, Math.min(rw, MM), Math.min(rh, MM));
}

function cellUnder(mx, my) {
  const fx = (mx + subX) / cellPx, fy = (my + subY) / cellPx;
  let x = viewX + BigInt(Math.floor(fx));
  let y = viewY + BigInt(Math.floor(fy));
  const c = BigInt(penC);
  x = clampB(x, 0n, W - c > 0n ? W - c : 0n);
  y = clampB(y, 0n, H - c > 0n ? H - c : 0n);
  return [x, y];
}

function positionCursor() {
  if (!mouse.inside) { cursor.style.display = "none"; return; }
  cursor.style.display = "block";
  const [x, y] = cellUnder(mouse.x, mouse.y);
  const loc = $("#loc");
  loc.innerHTML =
    `X ${pctOf(x, W)} <span style="color:var(--muted)">${shortHex(x, 5, 4)}</span><br>` +
    `Y ${pctOf(y, H)} <span style="color:var(--muted)">${shortHex(y, 5, 4)}</span>`;
  loc.title = "x 0x" + x.toString(16) + "\ny 0x" + y.toString(16);
  const sx = Number(x - viewX) * cellPx - subX;
  const sy = Number(y - viewY) * cellPx - subY;
  const s = penC * cellPx;
  cursor.style.width = s + "px"; cursor.style.height = s + "px";
  cursor.style.transform = `translate(${sx}px,${sy}px)`;
}

// ---------- scanning (client-side, on click only) ----------
const worker = new Worker("derive.worker.js?v=5", { type: "module" });
const DERIVE_CAP = 2048;   // max wallets derived+shown per patch (keeps huge pens snappy)
let scanId = 0, pendingScan = null;

function scanAt(x, y) {
  const key = x + "," + y + "," + penC;
  const k0 = kAt(x, y);
  const kh = $("#kHex");
  kh.textContent = shortHex(k0, 8, 8);
  kh.title = "0x" + k0.toString(16);
  // optimistic: paint the patch + counters instantly, whatever the pen size
  if (!seen.has(key)) {
    seen.add(key);
    patches.push({ x, y, c: penC });
    keysScanned += penC * penC;
    const mi = (toMMy(y) * MM + toMMx(x)) * 4;
    if (mi >= 0 && mi < heatImg.data.length) { heatImg.data[mi] = 31; heatImg.data[mi + 1] = 111; heatImg.data[mi + 2] = 136; }
  }
  $("#mScanned").textContent = keysScanned.toLocaleString("en-US");
  $("#mPatches").textContent = patches.length.toLocaleString("en-US");
  $("#kFrac").textContent = fracExplored();
  render();
  // derive the actual patch cells (1:1): pen n -> n*n wallets, capped for huge pens
  const rowsToDerive = Math.min(penC, Math.max(1, Math.floor(DERIVE_CAP / penC)));
  const id = ++scanId;
  pendingScan = { id, k0, W, cols: penC, total: penC * penC };
  worker.postMessage({ id, k0: k0.toString(), stride: W.toString(), cols: penC, rows: rowsToDerive });
}

// live balance for a single address (only when pen == 1) via a public block explorer.
// mempool.space became unreachable, so we use blockstream.info (Esplora API — identical
// chain_stats/mempool_stats schema) as the primary, with blockchain.info as a fallback.
async function liveBalance(addr) {
  try {
    const r = await (await fetch("https://blockstream.info/api/address/" + addr)).json();
    const c = r.chain_stats, m = r.mempool_stats;
    return (c.funded_txo_sum - c.spent_txo_sum) + (m.funded_txo_sum - m.spent_txo_sum);
  } catch (e) { /* fall through to secondary provider */ }
  try {
    const r = await (await fetch("https://blockchain.info/balance?cors=true&active=" + addr)).json();
    const e = r[addr];
    if (e && typeof e.final_balance === "number") return e.final_balance;
  } catch (e) { /* both providers failed */ }
  return null;
}

let btcPrice = 0;
fetch("https://api.coinbase.com/v2/prices/BTC-USD/spot")
  .then((r) => r.json())
  .then((d) => { btcPrice = parseFloat(d && d.data && d.data.amount) || 0; })
  .catch(() => {});
let balToken = 0;
function setBalCard(state, addr, sat) {
  const card = $("#balanceCard"); card.className = "balcard " + state;
  $("#balAddr").textContent = addr || "";
  const link = $("#balLink");
  if (addr) { link.style.display = "inline"; link.href = "https://blockstream.info/address/" + addr; }
  else link.style.display = "none";
  if (state === "checking") { $("#balState").textContent = "checking live balance…"; $("#balBtc").textContent = "…"; $("#balUsd").textContent = ""; return; }
  if (state === "error") { $("#balState").textContent = "check failed (rate limit) — click again"; $("#balBtc").textContent = "—"; $("#balUsd").textContent = ""; return; }
  const btc = sat / 1e8;
  $("#balBtc").textContent = btc.toFixed(8) + " BTC";
  $("#balUsd").textContent = btcPrice ? "≈ $" + (btc * btcPrice).toLocaleString("en-US", { maximumFractionDigits: 2 }) : "";
  $("#balState").textContent = state === "funded" ? "★ funded wallet" : "empty wallet";
}
function resetBalCard() {
  balToken++; $("#balanceCard").className = "balcard idle";
  $("#balState").textContent = "click a wallet to check its live balance";
  $("#balBtc").textContent = "— BTC"; $("#balUsd").textContent = "";
  $("#balAddr").textContent = ""; $("#balLink").style.display = "none";
}
function showBalance(addr) {
  const token = ++balToken;
  setBalCard("checking", addr, null);
  liveBalance(addr).then((sat) => {
    if (token !== balToken) return;                 // a newer click superseded this
    setBalCard(sat === null ? "error" : (sat > 0 ? "funded" : "empty"), addr, sat);
  });
}

worker.onmessage = (e) => {
  const { id, addrs } = e.data;
  if (pendingCalc && id === pendingCalc.id) {
    $("#calcOut").innerHTML = "0x" + pendingCalc.k.toString(16) + "<br>↳ " + addrs[0];
    pendingCalc = null; return;
  }
  if (!pendingScan || pendingScan.id !== id) return;
  lastScan = { k0: pendingScan.k0, W: pendingScan.W, cols: pendingScan.cols };
  $("#addrs").innerHTML = addrs.map((a, i) => `<div class="row" data-i="${i}">${a}</div>`).join("");
  $("#addrCount").textContent = addrs.length < pendingScan.total
    ? addrs.length.toLocaleString("en-US") + " of " + pendingScan.total.toLocaleString("en-US")
    : addrs.length.toLocaleString("en-US");
  $("#picked").textContent = "";
  if (pendingScan.cols === 1 && addrs[0]) showBalance(addrs[0]);   // pen 1 -> auto-check
  else resetBalCard();
};

function fracExplored() {
  const pct = Number(BigInt(keysScanned) * 10n ** 40n / TWO256) / 1e40 * 100;
  return pct === 0 ? "0 %" : pct.toExponential(3) + " %";
}

// ---------- interaction: hover moves cursor, drag pans, click scans ----------
let down = false, moved = false, lx = 0, ly = 0;
stage.addEventListener("mouseenter", () => { mouse.inside = true; });
stage.addEventListener("mouseleave", () => { mouse.inside = false; positionCursor(); });
stage.addEventListener("mousedown", (e) => { down = true; moved = false; lx = e.clientX; ly = e.clientY; });
window.addEventListener("mouseup", (e) => {
  if (down && !moved) {
    const r = stage.getBoundingClientRect();
    const [x, y] = cellUnder(e.clientX - r.left, e.clientY - r.top);
    scanAt(x, y);
  }
  down = false;
});
stage.addEventListener("mousemove", (e) => {
  const r = stage.getBoundingClientRect();
  mouse.x = e.clientX - r.left; mouse.y = e.clientY - r.top; mouse.inside = true;
  if (down) {
    const dx = e.clientX - lx, dy = e.clientY - ly;
    if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
    subX -= dx; subY -= dy; lx = e.clientX; ly = e.clientY; normalize();
    render();
  } else {
    positionCursor();
  }
});
stage.addEventListener("wheel", (e) => {
  e.preventDefault();
  const r = stage.getBoundingClientRect();
  const mx = e.clientX - r.left, my = e.clientY - r.top;
  const fx = (mx + subX) / cellPx, fy = (my + subY) / cellPx;
  const ax = viewX + BigInt(Math.floor(fx)), afx = fx - Math.floor(fx);
  const ay = viewY + BigInt(Math.floor(fy)), afy = fy - Math.floor(fy);
  cellPx = clampN(cellPx * (e.deltaY < 0 ? 1.2 : 1 / 1.2), minCell, maxCell);
  viewX = ax; subX = afx * cellPx - mx;
  viewY = ay; subY = afy * cellPx - my;
  normalize(); render();
}, { passive: false });

// ---------- minimap teleport ----------
let mmDown = false;
function mmJump(e) {
  const r = mm.getBoundingClientRect();
  const px = clampN((e.clientX - r.left) / r.width, 0, 1);
  const py = clampN((e.clientY - r.top) / r.height, 0, 1);
  const vw = Math.floor(stage.clientWidth / cellPx / 2), vh = Math.floor(stage.clientHeight / cellPx / 2);
  viewX = clampB((W * BigInt(Math.round(px * MM))) / MMb - BigInt(vw), 0n, W);
  viewY = clampB((H * BigInt(Math.round(py * MM))) / MMb - BigInt(vh), 0n, H);
  subX = 0; subY = 0; normalize(); render();
}
mm.addEventListener("mousedown", (e) => { mmDown = true; mmJump(e); });
mm.addEventListener("mousemove", (e) => { if (mmDown) mmJump(e); });
window.addEventListener("mouseup", () => { mmDown = false; });

// ---------- controls ----------
$("#apply").addEventListener("click", () => {
  aX = BigInt(clampN(parseInt($("#ax").value) || 128, 1, 255));
  aY = BigInt(clampN(parseInt($("#ay").value) || 128, 1, 255));
  W = 2n ** aX; H = 2n ** aY;
  viewX = 0n; viewY = 0n; subX = 0; subY = 0; cellPx = 28;
  patches = []; seen.clear(); keysScanned = 0; fillHeatBg();
  $("#mScanned").textContent = "0"; $("#mPatches").textContent = "0"; $("#kFrac").textContent = "0 %";
  $("#addrs").innerHTML = ""; $("#kHex").textContent = "— click the map —";
  setPen(parseInt($("#pen").value) || 16);
});
$("#clear").addEventListener("click", () => {
  patches = []; seen.clear(); keysScanned = 0; fillHeatBg();
  $("#mScanned").textContent = "0"; $("#mPatches").textContent = "0"; $("#kFrac").textContent = "0 %";
  render();
});
// Zoom auto-adapts to the pen: if the pen would cover most of the view, zoom out
// so it stays a manageable patch (fixes "pen 100 covers everything").
function autofitZoom() {
  const md = Math.min(stage.clientWidth, stage.clientHeight);
  if (penC * cellPx > md * 0.6) cellPx = clampN(md * 0.45 / penC, minCell, maxCell);
  render();
}
function setPen(v) {
  penC = clampN(Math.round(v) || 16, 1, 128);
  $("#pen").value = penC;
  $("#penRange").value = clampN(penC, 10, 40);
  $("#penVal").textContent = penC;
  $("#penWarn").style.display = penC > 48 ? "inline" : "none";
  autofitZoom();
  positionCursor();
}
$("#pen").addEventListener("input", (e) => setPen(parseInt(e.target.value)));
$("#penRange").addEventListener("input", (e) => setPen(parseInt(e.target.value)));
$("#raw").addEventListener("change", (e) => { raw = e.target.checked; document.body.classList.toggle("raw", raw); render(); });

// ---------- persistence (localStorage; survives reloads, stays on device) ----------
const STORE = "cuvre-keyspace-v1";
const PATCH_CAP = 5000;
let saveTimer = null;
function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(saveState, 400); }
function saveState() {
  try {
    const kept = patches.slice(-PATCH_CAP);
    localStorage.setItem(STORE, JSON.stringify({
      aX: aX.toString(), aY: aY.toString(), penC, cellPx,
      viewX: viewX.toString(), viewY: viewY.toString(), subX, subY,
      keysScanned,
      patches: kept.map((p) => [p.x.toString(), p.y.toString(), p.c]),
    }));
  } catch (e) { /* private mode / quota — ignore */ }
  updateURL();
}
function rebuildHeat() {
  fillHeatBg();
  for (const p of patches) {
    const mi = (toMMy(p.y) * MM + toMMx(p.x)) * 4;
    if (mi >= 0 && mi < heatImg.data.length) { heatImg.data[mi] = 31; heatImg.data[mi + 1] = 111; heatImg.data[mi + 2] = 136; }
  }
}
function loadState() {
  let s;
  try { s = JSON.parse(localStorage.getItem(STORE) || "null"); } catch (e) { s = null; }
  if (!s) return;
  try {
    aX = BigInt(s.aX); aY = BigInt(s.aY); penC = s.penC || 16; cellPx = s.cellPx || 28;
    W = 2n ** aX; H = 2n ** aY;
    viewX = BigInt(s.viewX || "0"); viewY = BigInt(s.viewY || "0");
    subX = s.subX || 0; subY = s.subY || 0;
    keysScanned = s.keysScanned || 0;
    patches = (s.patches || []).map(([x, y, c]) => ({ x: BigInt(x), y: BigInt(y), c }));
    for (const p of patches) seen.add(p.x + "," + p.y + "," + p.c);
    rebuildHeat();
    $("#ax").value = aX.toString(); $("#ay").value = aY.toString();
    $("#pen").value = penC; $("#penRange").value = clampN(penC, 10, 40); $("#penVal").textContent = penC;
    $("#penWarn").style.display = penC > 48 ? "inline" : "none";
    $("#mScanned").textContent = keysScanned.toLocaleString("en-US");
    $("#mPatches").textContent = patches.length.toLocaleString("en-US");
    $("#kFrac").textContent = fracExplored();
  } catch (e) { /* corrupt state — start fresh */ }
}

// ---------- shareable result card (client-side image, no backend) ----------
async function makeCard() {
  const c = document.createElement("canvas");
  c.width = 1200; c.height = 630;
  const g = c.getContext("2d");
  g.fillStyle = "#0d0f13"; g.fillRect(0, 0, 1200, 630);
  g.fillStyle = "#f7931a"; g.beginPath(); g.arc(90, 90, 34, 0, 7); g.fill();
  g.fillStyle = "#8b93a3"; g.font = "500 26px system-ui, sans-serif";
  g.fillText("cuvre · keyspace map", 140, 98);
  g.fillStyle = "#e6e9ef"; g.font = "600 120px system-ui, sans-serif";
  g.fillText(keysScanned.toLocaleString("en-US"), 80, 300);
  g.fillStyle = "#8b93a3"; g.font = "400 40px system-ui, sans-serif";
  g.fillText("private keys explored — and 0 held Bitcoin", 82, 360);
  g.fillStyle = "#f7931a"; g.font = "500 34px system-ui, sans-serif";
  g.fillText("odds of ever finding one: ~10⁻⁴¹", 82, 470);
  g.fillStyle = "#8b93a3"; g.font = "400 28px system-ui, sans-serif";
  g.fillText("2²⁵⁶ keys exist. You cannot brute-force this. That's the point.", 82, 530);
  g.drawImage(mm, 900, 90, 210, 210);
  return await new Promise((res) => c.toBlob(res, "image/png"));
}
$("#share").addEventListener("click", async () => {
  const blob = await makeCard();
  const file = new File([blob], "cuvre-keyspace.png", { type: "image/png" });
  const text = `I explored ${keysScanned.toLocaleString("en-US")} Bitcoin private keys on the keyspace map and found exactly 0. Odds of a hit: ~10^-41.`;
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], text }); return; } catch (e) { /* fall through */ }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = "cuvre-keyspace.png"; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
});

// ---------- go to / teleport + shareable URL position ----------
function goTo(cx, cy) {
  cx = clampB(cx, 0n, W); cy = clampB(cy, 0n, H);
  const vc = Math.floor(stage.clientWidth / cellPx / 2) || 0;
  const vr = Math.floor(stage.clientHeight / cellPx / 2) || 0;
  viewX = clampB(cx - BigInt(vc), 0n, W);
  viewY = clampB(cy - BigInt(vr), 0n, H);
  landing = { x: cx, y: cy };
  subX = 0; subY = 0; normalize(); render();
}
function updateURL() {
  try {
    const cx = viewX + BigInt(Math.floor((stage.clientWidth / cellPx) / 2));
    const cy = viewY + BigInt(Math.floor((stage.clientHeight / cellPx) / 2));
    const u = new URL(location.href);
    u.searchParams.set("x", "0x" + cx.toString(16));
    u.searchParams.set("y", "0x" + cy.toString(16));
    history.replaceState(null, "", u.toString());
  } catch (e) {}
}
function applyURLGoto() {
  const p = new URLSearchParams(location.search);
  if (p.has("x") && p.has("y")) { try { goTo(BigInt(p.get("x")), BigInt(p.get("y"))); } catch (e) {} }
}
// cryptographically-random BigInt in [0, maxExclusive)
function randBig(maxExclusive) {
  const bits = maxExclusive.toString(2).length;
  const bytes = Math.ceil(bits / 8) || 1;
  const arr = crypto.getRandomValues(new Uint8Array(bytes));
  let v = 0n; for (const b of arr) v = (v << 8n) + BigInt(b);
  return v % maxExclusive;
}
$("#rand").addEventListener("click", () => goTo(randBig(W), randBig(H)));
// parse a value in the chosen base (auto understands 0x / 0b / decimal)
function parseVal(str, base) {
  str = (str || "").trim(); if (!str) return null;
  try {
    if (base === "hex") return BigInt(/^0x/i.test(str) ? str : "0x" + str);
    if (base === "bin") return BigInt(/^0b/i.test(str) ? str : "0b" + str);
    return BigInt(str);
  } catch (e) { return null; }
}
function goErr(msg) { const el = $("#goErr"); if (!msg) { el.style.display = "none"; return; } el.textContent = msg; el.style.display = "block"; }
$("#goxy").addEventListener("click", () => {
  const b = $("#base").value;
  const x = parseVal($("#gx").value, b), y = parseVal($("#gy").value, b);
  if (x === null || y === null) return goErr("Invalid number for base “" + b + "”.");
  if (x < 0n || x >= W) return goErr("x out of range (0 … 2^" + aX + " − 1).");
  if (y < 0n || y >= H) return goErr("y out of range (0 … 2^" + aY + " − 1).");
  goErr(""); goTo(x, y);
});
$("#gok").addEventListener("click", () => {
  const b = $("#base").value;
  const k = parseVal($("#gk").value, b), max = W * H;
  if (k === null) return goErr("Invalid key for base “" + b + "”.");
  if (k < 1n || k > max) return goErr("Key out of range (1 … 2^" + (aX + aY) + ").");
  goErr(""); const i = k - 1n; goTo(i % W, i / W);
});

// ---------- key -> address modal ----------
let calcId = 0, pendingCalc = null;
$("#calc").addEventListener("click", () => { $("#calcErr").textContent = ""; $("#calcOut").textContent = ""; $("#calcModal").style.display = "flex"; });
$("#calcClose").addEventListener("click", () => { $("#calcModal").style.display = "none"; });
$("#calcModal").addEventListener("click", (e) => { if (e.target === $("#calcModal")) $("#calcModal").style.display = "none"; });
$("#calcGo").addEventListener("click", () => {
  const k = parseVal($("#calcKey").value, $("#base").value), max = W * H;
  if (k === null) { $("#calcErr").textContent = "Invalid number for the selected base."; return; }
  if (k < 1n || k > max) { $("#calcErr").textContent = "Out of range (1 … 2^" + (aX + aY) + ")."; return; }
  $("#calcErr").textContent = ""; $("#calcOut").textContent = "computing…";
  const id = "c" + (++calcId); pendingCalc = { id, k };
  worker.postMessage({ id, k0: k.toString(), stride: "1", cols: 1, rows: 1 });
});
$("#addrs").addEventListener("click", (e) => {
  const row = e.target.closest(".row"); if (!row || !lastScan) return;
  const i = +row.dataset.i, cols = lastScan.cols;      // patch is row-major
  const key = lastScan.k0 + BigInt(Math.floor(i / cols)) * lastScan.W + BigInt(i % cols);
  const address = row.textContent;
  $("#picked").innerHTML = address + " <span style='color:var(--muted)'>· address copied</span><br>↳ 0x" + key.toString(16);
  try { navigator.clipboard.writeText(address); } catch (e) {}
  showBalance(address);   // clicking any wallet also checks its live balance
});

// ---------- intro overlay ----------
function hideIntro() { $("#intro").classList.add("hidden"); try { localStorage.setItem("cuvre-intro-seen", "1"); } catch (e) {} }
$("#introGo").addEventListener("click", hideIntro);
$("#about").addEventListener("click", () => $("#intro").classList.remove("hidden"));
try { if (localStorage.getItem("cuvre-intro-seen") === "1") $("#intro").classList.add("hidden"); } catch (e) {}

window.addEventListener("resize", resize);
loadState();
resize();
applyURLGoto();
