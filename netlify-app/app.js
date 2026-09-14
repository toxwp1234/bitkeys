"use strict";
import { dopamine } from "./dopamine.js?v=2";
const $ = (s) => document.querySelector(s);
const stage = $("#stage");

// ---------- candidate history (IndexedDB): funded finds persist across scans & sessions ----------
const CANDIDATE_DB = "cuvre-candidates";
const CANDIDATE_STORE = "found";
let candidateDB = null;
function initCandidateDB() {
  return new Promise((resolve) => {
    try {
      const r = indexedDB.open(CANDIDATE_DB, 1);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains(CANDIDATE_STORE)) {
          const store = db.createObjectStore(CANDIDATE_STORE, { keyPath: "id", autoIncrement: true });
          store.createIndex("timestamp", "timestamp", { unique: false });
        }
      };
      r.onsuccess = () => { candidateDB = r.result; resolve(); };
      r.onerror = () => resolve();
    } catch (e) { resolve(); }
  });
}
function saveCandidateToHistory(addr, sats, priv) {
  if (!candidateDB) return;
  try {
    candidateDB.transaction(CANDIDATE_STORE, "readwrite").objectStore(CANDIDATE_STORE)
      .add({ addr, sats, priv: priv.toString(16).padStart(64, "0"), timestamp: Date.now() });
  } catch (e) {}
}
function getCandidateHistory(limit = 10) {
  if (!candidateDB) return Promise.resolve([]);
  return new Promise((resolve) => {
    try {
      const req = candidateDB.transaction(CANDIDATE_STORE, "readonly").objectStore(CANDIDATE_STORE).index("timestamp").getAll();
      req.onsuccess = () => resolve((req.result || []).reverse().slice(0, limit));
      req.onerror = () => resolve([]);
    } catch (e) { resolve([]); }
  });
}

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
let patches = [];                 // {x,y,c} solid scanned squares (current session, teal)
let seen = new Set();             // dedup "x,y,c"
let grayPatches = [];             // territory carried over from soft resets (drawn gray)
let graySeen = new Set();
let lastResetTime = 0, resetPending = false;   // 1× soft / 2× (<500ms) hard reset
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
let frameCount = 0, lastFpsUpdate = 0, currentFps = 60;
function updateFps(now) {
  if (now - lastFpsUpdate >= 1000) {
    currentFps = frameCount;
    frameCount = 0;
    lastFpsUpdate = now;
    const fpsEl = $("#fpsCounter");
    if (fpsEl) {
      const color = currentFps >= 50 ? "var(--accent)" : currentFps >= 30 ? "#e0b155" : "#f0616d";
      fpsEl.style.color = color;
      fpsEl.textContent = currentFps + " fps";
    }
  }
}
function render() { if (pending) return; pending = true; requestAnimationFrame((now) => {
  frameCount++;
  updateFps(now);
  pending = false;
  draw();
}); }

function draw() {
  // adaptive grid: one line per cell when zoomed in; snaps to whole patches (then groups
  // of patches) as cells shrink, so at max zoom-out the grid reads as patch boundaries.
  let gs = cellPx, cpl = 1;
  if (gs < 9) { cpl = penC; gs = cpl * cellPx; while (gs < 9) { cpl *= 2; gs *= 2; } }
  const cplB = BigInt(Math.max(1, Math.round(cpl)));
  const phX = (Number(viewX % cplB) * cellPx + subX) % gs;
  const phY = (Number(viewY % cplB) * cellPx + subY) % gs;
  grid.style.backgroundSize = gs + "px " + gs + "px";
  grid.style.backgroundPosition = (-phX) + "px " + (-phY) + "px";

  const w = stage.clientWidth, h = stage.clientHeight;
  tctx.clearRect(0, 0, w, h);
  // territory from past (soft-reset) sessions — desaturated gray, "we've been here"
  tctx.fillStyle = raw ? "#7a7a7a" : "rgba(102,106,116,0.5)";
  for (const p of grayPatches) {
    const sx = Number(p.x - viewX) * cellPx - subX;
    const sy = Number(p.y - viewY) * cellPx - subY;
    const s = p.c * cellPx;
    if (sx > w || sy > h || sx + s < 0 || sy + s < 0) continue;
    tctx.fillRect(sx, sy, s, s);
  }
  // current session — bright teal, drawn on top
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
  // static centre crosshair (drawn on the canvas — ::after doesn't render on <canvas>)
  mmctx.globalAlpha = 0.4; mmctx.strokeStyle = "#f7931a"; mmctx.lineWidth = 1;
  mmctx.beginPath();
  mmctx.moveTo(MM / 2, 0); mmctx.lineTo(MM / 2, MM);
  mmctx.moveTo(0, MM / 2); mmctx.lineTo(MM, MM / 2);
  mmctx.stroke(); mmctx.globalAlpha = 1;
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

  const precEl = $("#precisionInfo");
  if (precEl && cellPx > 0) precEl.textContent = "cell: " + (cellPx / 28).toFixed(2) + "×";

  const sx = Number(x - viewX) * cellPx - subX;
  const sy = Number(y - viewY) * cellPx - subY;
  const s = penC * cellPx;
  cursor.style.width = s + "px"; cursor.style.height = s + "px";
  cursor.style.transform = `translate(${sx}px,${sy}px)`;
}

// ---------- scanning (client-side, on click only) ----------
const worker = new Worker("derive.worker.js?v=8", { type: "module" });
// One row-major mapping index -> private key, shared by the patch click handler and the
// Bloom candidate path, so a "funded" address can never be paired with the wrong key.
const keyAt = (i, scan) => scan.k0 + BigInt(Math.floor(i / scan.cols)) * scan.W + BigInt(i % scan.cols);
const DISPLAY_CAP = 2048;  // max rows rendered in the list; the stream checks far more than we display
let scanId = 0, pendingScan = null, scanActive = false, firstAddr = null, scanT0 = 0;

function scanAt(x, y) {
  const key = x + "," + y + "," + penC;
  const k0 = kAt(x, y);
  const kh = $("#kHex");
  kh.textContent = shortHex(k0, 8, 8);
  kh.title = "0x" + k0.toString(16);
  // paint the patch instantly (optimistic); keysScanned now ticks up as the stream checks
  if (!seen.has(key)) {
    seen.add(key);
    patches.push({ x, y, c: penC });
    const mi = (toMMy(y) * MM + toMMx(x)) * 4;
    if (mi >= 0 && mi < heatImg.data.length) { heatImg.data[mi] = 31; heatImg.data[mi + 1] = 111; heatImg.data[mi + 2] = 136; }
  }
  $("#mPatches").textContent = patches.length.toLocaleString("en-US");
  render();
  // stream the WHOLE patch: pen n -> n*n keys, derived + bloom-checked in chunks, off-thread.
  // No cap — the machine goes as far/fast as it can; a new click cancels the running scan.
  const id = ++scanId;
  pendingScan = { id, k0, W, cols: penC, total: penC * penC, checkedSoFar: 0 };
  lastScan = { k0, W, cols: penC };
  scanActive = true;
  balGen++; balBatch = { gen: balGen, total: 0, done: 0, funded: 0, failed: 0 };  // fresh balance session
  firstAddr = null;
  lastBalanceProvider = null; lastBalanceTimestamp = null;   // no API provenance until one actually answers
  startScanUI(penC * penC);
  worker.postMessage({ type: "scan", id, k0: k0.toString(), stride: W.toString(), cols: penC, rows: penC });
}

// live balance for a single address (only when pen == 1). No single free explorer
// sustains 1 req/s forever (they throttle bursts / cap daily), so we RACE several
// public providers in parallel and take the first that answers — a dead or slow one
// (e.g. mempool timing out) can no longer stall the whole check. A provider that
// rate-limits is put on a cooldown and skipped next time. Result is tagged so the UI
// can tell "confirmed empty (0 BTC)" apart from "couldn't check (limit)" — never alike.
const esploraSat = (j) => {
  const c = j.chain_stats, m = j.mempool_stats;
  return (c.funded_txo_sum - c.spent_txo_sum) + (m.funded_txo_sum - m.spent_txo_sum);
};
const PROVIDERS = [
  { name: "blockstream", url: (a) => "https://blockstream.info/api/address/" + a, parse: esploraSat },
  { name: "mempool",     url: (a) => "https://mempool.space/api/address/" + a,    parse: esploraSat },
  { name: "blockchain",  url: (a) => "https://blockchain.info/balance?cors=true&active=" + a, parse: (j, a) => j[a].final_balance },
  { name: "blockchair",  url: (a) => "https://api.blockchair.com/bitcoin/dashboards/address/" + a, parse: (j, a) => j.data[a].address.balance },
];
const RL_CODES = new Set([429, 430, 402, 403, 503]);

// query one provider -> "ok" | "ratelimited" | "unreachable".
// hard 4s timeout so a downed explorer can't hold a slot open forever; with the
// parallel race below, a live provider usually answers in well under a second anyway.
async function tryProvider(p, addr) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 4000);
  try {
    const res = await fetch(p.url(addr), { signal: ctl.signal });
    if (!res.ok) return { status: RL_CODES.has(res.status) ? "ratelimited" : "unreachable" };
    const sat = p.parse(await res.json(), addr);
    if (Number.isFinite(sat)) return { status: "ok", sat };
    return { status: "unreachable" };            // 200 but shape we didn't understand — do NOT treat as 0
  } catch (e) { return { status: "unreachable" }; }
  finally { clearTimeout(t); }
}

// -> { status: "ok", sat } | { status: "ratelimited" } | { status: "error" }
// Query every live provider AT ONCE and resolve on the first real balance. A single
// slow/dead endpoint (mempool has been timing out) used to add its full timeout to
// every check because providers were tried one after another; racing them means the
// wait is only as long as the fastest healthy provider (~0.1–0.5s).
async function liveBalance(addr) {
  const now = Date.now();
  const active = PROVIDERS.filter((p) => !(p.cooldownUntil && now < p.cooldownUntil));
  if (!active.length) return { status: "ratelimited" };   // everything is cooling down
  let sawRateLimit = active.length < PROVIDERS.length;     // some were skipped on cooldown
  return await new Promise((resolve) => {
    let pending = active.length, settled = false;
    active.forEach(async (p) => {
      const r = await tryProvider(p, addr);
      if (settled) return;
      if (r.status === "ok") {                          // first good answer wins
        settled = true;
        lastBalanceProvider = p.name; lastBalanceTimestamp = Date.now();
        return resolve(r);
      }
      if (r.status === "ratelimited") { p.cooldownUntil = Date.now() + 60000; sawRateLimit = true; }
      if (--pending === 0) resolve({ status: sawRateLimit ? "ratelimited" : "error" });
    });
  });
}

let btcPrice = 0;
fetch("https://api.coinbase.com/v2/prices/BTC-USD/spot")
  .then((r) => r.json())
  .then((d) => { btcPrice = parseFloat(d && d.data && d.data.amount) || 0; })
  .catch(() => {});
let balGen = 0;   // bump to supersede any in-flight / queued balance check
let lastBalanceProvider = null, lastBalanceTimestamp = null;
// a private key is a 256-bit scalar -> Bitcoin shows it as 64 hex chars (zero-padded)
const privHex = (priv) => priv == null ? "" : "0x" + priv.toString(16).padStart(64, "0");

// illustrative "computational cost" flavor text for a checked address (not a real figure)
function calcEntropy(sats) {
  if (sats === 0) return { bits: 0, cost: 0, desc: "empty" };
  const bits = Math.log2(sats) + 256;
  const cost = bits * 0.000000001 * 0.12;
  return { bits: bits.toFixed(1), cost: cost.toFixed(2), desc: "checked" };
}
function setBalCard(state, addr, sat, priv) {
  const card = $("#balanceCard"); card.className = "balcard " + state;
  const addrField = $("#balAddrField"), keyField = $("#balKeyField"), gotCap = $("#balGotCap");
  $("#balAddr").textContent = addr || "";
  addrField.style.display = addr ? "block" : "none";
  const key = privHex(priv);
  $("#balKey").textContent = key;
  keyField.style.display = key ? "block" : "none";
  const link = $("#balLink");
  if (addr) { link.style.display = "inline"; link.href = "https://blockstream.info/address/" + addr; }
  else link.style.display = "none";
  if (state === "checking") { $("#balState").textContent = "checking live balance…"; gotCap.style.display = "none"; $("#balBtc").textContent = "…"; $("#balUsd").textContent = ""; return; }
  // "limit"/"error": balance is UNKNOWN — never render this as 0 BTC / empty, that would be misleading
  if (state === "limit") { $("#balState").textContent = "not checked — API limit reached, try again in a moment"; gotCap.style.display = "none"; $("#balBtc").textContent = "balance unknown"; $("#balUsd").textContent = ""; return; }
  if (state === "error") { $("#balState").textContent = "not checked — explorer unreachable, try again"; gotCap.style.display = "none"; $("#balBtc").textContent = "balance unknown"; $("#balUsd").textContent = ""; return; }
  const btc = sat / 1e8;
  gotCap.style.display = "block";
  $("#balBtc").textContent = btc.toFixed(8) + " BTC";
  $("#balUsd").textContent = btcPrice ? "≈ $" + (btc * btcPrice).toLocaleString("en-US", { maximumFractionDigits: 2 }) : "";
  $("#balState").textContent = state === "funded" ? "★ funded wallet" : "empty wallet";

  // provenance strip: only when a live API actually answered (never for a bloom-only empty)
  const metaEl = $("#balMeta");
  if (Number.isFinite(sat) && lastBalanceProvider) {
    metaEl.style.display = "block";
    if (lastBalanceProvider) $("#balSourceName").textContent = lastBalanceProvider;
    if (lastBalanceTimestamp) $("#balTimestamp").textContent = new Date(lastBalanceTimestamp).toLocaleTimeString() + " UTC";
    const entropyDiv = $("#entropyDisplay");
    if (sat === 0) { entropyDiv.style.display = "none"; }
    else {
      const ent = calcEntropy(sat);
      entropyDiv.innerHTML = `<div class="entropy-meter">
        <div class="label">computational cost to verify</div>
        <div class="stat"><span>~${ent.bits} bits entropy</span><span class="value">$${ent.cost} USD equiv</span></div>
      </div>`;
      entropyDiv.style.display = "block";
    }
  } else {
    metaEl.style.display = "none";
    $("#entropyDisplay").style.display = "none";
  }

  // dopamine feedback: reveal pulse + tone, scaled by balance (only on a resolved balance)
  if (Number.isFinite(sat)) dopamine.reveal($("#balBtc"), sat);
}
function resetBalCard() {
  balGen++; $("#balanceCard").className = "balcard idle";
  $("#balState").textContent = "click a wallet to check its live balance";
  $("#balGotCap").style.display = "none";
  $("#balBtc").textContent = "— BTC"; $("#balUsd").textContent = "";
  $("#balAddr").textContent = ""; $("#balAddrField").style.display = "none";
  $("#balKey").textContent = ""; $("#balKeyField").style.display = "none";
  $("#balLink").style.display = "none";
  $("#balMeta").style.display = "none"; $("#entropyDisplay").style.display = "none";
}

// bottom shelf: the most recent funded finds, persistent across scans/clicks/sessions
async function updateCandidateShelf() {
  const history = await getCandidateHistory(10);
  const shelfItems = $("#shelfItems");
  shelfItems.innerHTML = "";
  if (!history.length) { $("#candidateShelf").classList.remove("show"); return; }
  history.forEach((c) => {
    const timeStr = new Date(c.timestamp).toLocaleTimeString();
    const satsDisplay = c.sats > 0 ? `<span class="sat">+${(c.sats / 1e8).toFixed(8)} BTC</span>` : "";
    const chip = document.createElement("div");
    chip.className = "candidate-chip";
    chip.innerHTML = `${c.addr.slice(0, 12)}…<span class="time">${timeStr}</span>${satsDisplay}`;
    chip.addEventListener("click", () => { try { showBalance(c.addr, BigInt("0x" + c.priv)); } catch (e) {} });
    shelfItems.appendChild(chip);
  });
  $("#candidateCount").textContent = history.length;
  $("#candidateShelf").classList.add("show");
}
// ---------- rate-limited balance-check QUEUE ----------
// The Bloom filter flags candidate wallets; each is confirmed via the live API, but
// explorers rate-limit, so we DRAIN the queue at <= 1 call/s. A patch that yields 4
// candidates spreads over ~4s instead of firing 4 calls at once (no rate-limit error).
// Every new scan/click bumps `balGen`, so pending checks from an abandoned patch are
// dropped BEFORE they spend a slot — the queue can never pile up across clicks.
const BAL_INTERVAL = 1000;                          // ms between live calls (<= 1/s)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let balQueue = [];                                  // [{addr, priv, gen}]
let balDraining = false, balNextSlot = 0;
let balBatch = { gen: -1, total: 0, done: 0, funded: 0, failed: 0 };

// The single entry point for every balance check. A row click / pen-1 cell is just a
// batch of one; a Bloom patch passes all its candidates at once. Returns immediately —
// results trickle in as slots free up, so the click itself always feels instant.
function checkBalances(items) {                     // items: [{addr, priv}]
  const gen = ++balGen;                             // supersede any earlier batch outright
  balQueue = items.map((it) => ({ addr: it.addr, priv: it.priv, i: it.i, gen }));
  balBatch = { gen, total: items.length, done: 0, funded: 0, failed: 0 };
  if (!items.length) { resetBalCard(); return; }
  if (items.length === 1) setBalCard("checking", items[0].addr, null, items[0].priv);
  else renderBatch();                              // instant "checking N…" the moment you click
  if (!balDraining) drainBalance();
}
function showBalance(addr, priv) { checkBalances([{ addr, priv }]); }   // single wallet

function renderBatch() {
  const b = balBatch;
  $("#balanceCard").className = "balcard checking";
  $("#balGotCap").style.display = "none";
  $("#balAddrField").style.display = "none"; $("#balKeyField").style.display = "none";
  $("#balLink").style.display = "none";
  $("#balBtc").textContent = b.done + "/" + b.total; $("#balUsd").textContent = "";
  $("#balState").textContent = "checking candidate wallets…" + (b.funded ? " · " + b.funded + " funded ★" : "");
}
function finishBatch(b) {
  showBloomEmpty2();                                   // full card + satisfying 0 BTC reveal
}
async function drainBalance() {
  balDraining = true;
  while (balQueue.length) {
    const job = balQueue.shift();
    if (job.gen !== balGen) continue;              // abandoned patch — skip, no slot spent
    const wait = Math.max(0, balNextSlot - Date.now());
    if (wait) await sleep(wait);
    if (job.gen !== balGen) continue;              // superseded while waiting
    balNextSlot = Math.max(Date.now(), balNextSlot) + BAL_INTERVAL;   // reserve this call's 1s slot
    const res = await liveBalance(job.addr);
    if (job.gen !== balGen) continue;              // superseded during the request
    reportBalance(job, res);
  }
  balDraining = false;
}
// A user only ever sees "funded" when the API confirms sat > 0 — a Bloom false-positive
// resolves to sat 0 here and is dropped silently, never shown as a hit.
function setRowState(i, state) {                   // "checking" | "miss" | "hit"
  const row = $('#addrs .row[data-i="' + i + '"]');
  if (row) { row.classList.remove("checking", "miss", "hit"); row.classList.add(state); }
}
function reportBalance(job, res) {
  const b = balBatch;
  const funded = res.status === "ok" && res.sat > 0;
  if (job.i != null) setRowState(job.i, funded ? "hit" : "miss");
  if (!scanActive && b.total <= 1) {               // manual single check (row click)
    const state = res.status === "ok" ? (funded ? "funded" : "empty")
                : res.status === "ratelimited" ? "limit" : "error";
    setBalCard(state, job.addr, res.sat, job.priv);
    if (funded) { saveCandidateToHistory(job.addr, res.sat, job.priv); updateCandidateShelf(); }
    return;
  }
  b.done++;
  if (funded) {                                     // the prize takes the card — and is saved forever
    b.funded++; setBalCard("funded", job.addr, res.sat, job.priv);
    saveCandidateToHistory(job.addr, res.sat, job.priv); updateCandidateShelf();
  } else {
    if (res.status !== "ok") b.failed++;
    if (b.funded) return;                           // a funded hit already owns the card
    if (!scanActive && b.done >= b.total) finishBatch(b);   // all candidates verified, none funded
  }
}

worker.onmessage = (e) => {
  const msg = e.data;
  // ---- Bloom lifecycle ----
  if (msg.type === "bloomProgress") return;             // silent background load, no UI
  if (msg.type === "bloomReady") { bloomReady = true; return; }
  if (msg.type === "bloomError") {                      // transient? retry once, quietly
    if (!bloomRetried) { bloomRetried = true; setTimeout(() => worker.postMessage({ type: "loadBloom", base: BLOOM_BASE }), 4000); }
    return;
  }
  if (msg.type === "calcResult") {                      // key -> address modal
    if (pendingCalc && msg.id === pendingCalc.id) { $("#calcOut").innerHTML = "0x" + pendingCalc.k.toString(16) + "<br>↳ " + msg.addr; pendingCalc = null; }
    return;
  }

  // ---- streamed scan ----
  if (msg.type === "scanProgress") {
    if (!pendingScan || msg.id !== pendingScan.id) return;
    tickChecked(msg.checked);
    if (msg.display) renderPatchList(msg.display, msg.total, msg.bloomOn);
    updateScanUI(msg.checked, msg.total, msg.foundCount, msg.bloomOn);
    if (msg.candidates && msg.candidates.length) {      // stream candidates into the throttled API queue
      msg.candidates.forEach((c) => setRowState(c.i, "checking"));
      enqueueBalances(msg.candidates.map((c) => ({ addr: c.addr, priv: keyAt(c.i, lastScan), i: c.i })));
    }
    return;
  }
  if (msg.type === "scanDone") {
    if (!pendingScan || msg.id !== pendingScan.id) return;
    tickChecked(msg.checked);
    if (msg.display) renderPatchList(msg.display, msg.total, msg.bloomOn);
    scanActive = false;
    finishScanUI();
    return;
  }
};

// keysScanned ticks up honestly as the stream confirms keys (never the fictional pen²)
function tickChecked(checked) {
  const delta = checked - pendingScan.checkedSoFar;
  if (delta <= 0) return;
  pendingScan.checkedSoFar = checked;
  keysScanned += delta;
  $("#mScanned").textContent = keysScanned.toLocaleString("en-US");
  $("#kFrac").textContent = fracExplored();
}

// on-screen sample of the scanned addresses (the stream checks far more than this)
function renderPatchList(addrs, total, bloomOn) {
  firstAddr = addrs[0] || null;
  const shown = Math.min(addrs.length, DISPLAY_CAP);
  const base = bloomOn ? "miss" : "";                   // ✕ = checked, not found
  let html = "";
  for (let i = 0; i < shown; i++)
    html += `<div class="row ${base}" data-i="${i}" style="--d:${i}"><span class="dot"></span><span class="ra">${addrs[i]}</span></div>`;
  $("#addrs").innerHTML = html;
  $("#addrCount").textContent = "showing " + shown.toLocaleString("en-US") + " of " + total.toLocaleString("en-US");
  $("#picked").textContent = "";
  $("#expandPatch").style.display = "block";
  setExpandLabel();
  if (!$("#patchBox").hidden) runScan();
}

// ---- the satisfying "waiting" screen: a live progress card while the machine grinds ----
function startScanUI(total) {
  scanT0 = performance.now();
  const card = $("#balanceCard"); card.className = "balcard scanning";
  $("#balGotCap").style.display = "none"; $("#balAddrField").style.display = "none";
  $("#balKeyField").style.display = "none"; $("#balLink").style.display = "none";
  $("#balMeta").style.display = "none"; $("#entropyDisplay").style.display = "none";
  $("#balState").textContent = "scanning patch…";
  $("#balBtc").textContent = "0";
  $("#balUsd").textContent = "of " + total.toLocaleString("en-US") + " wallets";
  $("#scanBarWrap").style.display = "block"; $("#scanBarFill").style.width = "0%";
}
function updateScanUI(checked, total, found, bloomOn) {
  if (balBatch.funded) return;                          // a real hit owns the card — never cover it
  const card = $("#balanceCard"); if (!card.classList.contains("scanning")) card.className = "balcard scanning";
  $("#scanBarWrap").style.display = "block";
  $("#scanBarFill").style.width = (total ? Math.min(100, checked / total * 100) : 100).toFixed(3) + "%";
  $("#balBtc").textContent = checked.toLocaleString("en-US");
  const rate = Math.round(checked / Math.max(0.001, (performance.now() - scanT0) / 1000));
  if ($("#scanStats")) $("#scanStats").textContent = found ? found.toLocaleString("en-US") + " potential ★" : "—";
  if ($("#scanRate")) $("#scanRate").textContent = rate.toLocaleString("en-US") + "/s";
  $("#balState").textContent = bloomOn ? "scanning patch…" : "loading filter…";
  $("#balUsd").textContent = "of " + total.toLocaleString("en-US") + " · " + rate.toLocaleString("en-US") + "/s"
    + (found ? " · " + found.toLocaleString("en-US") + " candidate" + (found > 1 ? "s" : "") + " ★" : "");
}
function finishScanUI() {
  $("#scanBarWrap").style.display = "none";
  if (balBatch.funded) return;                          // keep the funded prize on screen
  if (balBatch.done >= balBatch.total) showBloomEmpty2();   // nothing pending / nothing funded -> 0 BTC reveal
  else $("#balState").textContent = "verifying " + (balBatch.total - balBatch.done) + " candidate(s)…";
}
// full card + satisfying 0 BTC reveal for an all-empty patch
function showBloomEmpty2() {
  setBalCard("empty", firstAddr, 0, firstAddr ? keyAt(0, lastScan) : null);
}
// append candidates to the CURRENT scan's balance session (no supersede, unlike checkBalances)
function enqueueBalances(items) {
  const gen = balBatch.gen;
  items.forEach((it) => balQueue.push({ addr: it.addr, priv: it.priv, i: it.i, gen }));
  balBatch.total += items.length;
  if (!balDraining) drainBalance();
}
// expandable patch list (collapsed by default) + live-scan sweep across the rows
function setExpandLabel() {
  $("#expandPatch").textContent = ($("#patchBox").hidden ? "▾ " : "▴ ") + "wallets in patch (" + $("#addrCount").textContent + ")";
}
function runScan() {                                   // restart the CSS stagger animation
  const list = $("#addrs");
  list.classList.remove("scanning"); void list.offsetWidth; list.classList.add("scanning");
}
$("#expandPatch").addEventListener("click", () => {
  const box = $("#patchBox");
  box.hidden = !box.hidden;
  setExpandLabel();
  if (!box.hidden) runScan();
});

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
  patches = []; seen.clear(); grayPatches = []; graySeen.clear(); keysScanned = 0; fillHeatBg();
  $("#mScanned").textContent = "0"; $("#mPatches").textContent = "0"; $("#kFrac").textContent = "0 %";
  $("#addrs").innerHTML = ""; $("#kHex").textContent = "— click the map —";
  setPen(parseInt($("#pen").value) || 16);
});
// ---------- smart reset: 1× soft (gray tiles + zero the count) · 2× fast (full wipe) ----------
function showResetToast(msg) {
  const t = $("#resetToast"); if (!t) return;
  t.textContent = msg; t.classList.add("show");
  clearTimeout(t._timer); t._timer = setTimeout(() => t.classList.remove("show"), 1700);
}
function cancelActiveWork() {                     // drop any in-flight scan + queued balance checks
  scanId++; pendingScan = null; scanActive = false; balGen++;
  worker.postMessage({ type: "cancel" });
}
function handleSoftReset() {
  for (const p of patches) {                      // current territory becomes gray "we've been here"
    const k = p.x + "," + p.y + "," + p.c;
    if (!graySeen.has(k)) { graySeen.add(k); grayPatches.push(p); }
  }
  patches = []; seen.clear(); keysScanned = 0;
  cancelActiveWork(); resetBalCard();
  $("#mScanned").textContent = "0"; $("#mPatches").textContent = "0"; $("#kFrac").textContent = fracExplored();
  render();
  clearTimeout(saveTimer); saveState();            // persist immediately — don't rely on the rAF-debounced save
  showResetToast("soft reset — " + grayPatches.length.toLocaleString("en-US") + " patches kept as territory");
}
function handleHardReset() {                       // nuclear: nothing survives
  patches = []; seen.clear(); grayPatches = []; graySeen.clear(); keysScanned = 0;
  cancelActiveWork(); resetBalCard(); fillHeatBg();
  if (candidateDB) { try { candidateDB.transaction(CANDIDATE_STORE, "readwrite").objectStore(CANDIDATE_STORE).clear(); } catch (e) {} }
  updateCandidateShelf();
  $("#mScanned").textContent = "0"; $("#mPatches").textContent = "0"; $("#kFrac").textContent = "0 %";
  render();
  clearTimeout(saveTimer); saveState();            // persist immediately — don't rely on the rAF-debounced save
  showResetToast("hard reset — clean slate");
}
function handleResetClick() {
  const now = Date.now();
  if (resetPending && now - lastResetTime < 500) { resetPending = false; handleHardReset(); return; }
  resetPending = true; lastResetTime = now;
  setTimeout(() => { resetPending = false; }, 500);
  handleSoftReset();
}
$("#clear").addEventListener("click", handleResetClick);
// Zoom is pen-relative. Max zoom-OUT is set so a whole pen×pen patch collapses to ~2px
// (a "pixel"); max zoom-IN keeps a single cell big. Changing the pen reframes the view so
// one patch fills ~45% of the smaller side — the zoom always adapts to the pen.
const PATCH_MIN_PX = 2;        // a patch at max zoom-out
function minCellFor(pen) { return Math.max(0.02, PATCH_MIN_PX / pen); }
function penFitCell() {
  const md = Math.min(stage.clientWidth, stage.clientHeight) || 600;
  return clampN(md * 0.45 / penC, minCell, maxCell);
}
function setPen(v) {
  penC = clampN(Math.round(v) || 16, 1, 1000000);      // no ceiling but a sane guard; go as big as your machine allows
  $("#pen").value = penC;
  $("#penRange").value = clampN(penC, 1, 1000);
  $("#penVal").textContent = penC.toLocaleString("en-US");
  $("#penWarn").style.display = penC * penC > 16384 ? "inline" : "none";
  minCell = minCellFor(penC);
  cellPx = penFitCell();       // reframe: one patch ~45% of the view
  render();
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
      grayPatches: grayPatches.slice(-PATCH_CAP).map((p) => [p.x.toString(), p.y.toString(), p.c]),
    }));
  } catch (e) { /* private mode / quota — ignore */ }
  updateURL();
}
function rebuildHeat() {
  fillHeatBg();
  for (const p of grayPatches) {
    const mi = (toMMy(p.y) * MM + toMMx(p.x)) * 4;
    if (mi >= 0 && mi < heatImg.data.length) { heatImg.data[mi] = 90; heatImg.data[mi + 1] = 94; heatImg.data[mi + 2] = 104; }
  }
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
    grayPatches = (s.grayPatches || []).map(([x, y, c]) => ({ x: BigInt(x), y: BigInt(y), c }));
    for (const p of grayPatches) graySeen.add(p.x + "," + p.y + "," + p.c);
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
  worker.postMessage({ type: "calc", id, k0: k.toString() });
});
$("#addrs").addEventListener("click", (e) => {
  const row = e.target.closest(".row"); if (!row || !lastScan) return;
  const i = +row.dataset.i;                            // patch is row-major
  const key = keyAt(i, lastScan);
  const address = (row.querySelector(".ra") || row).textContent;
  $("#picked").innerHTML = address + " <span style='color:var(--muted)'>· address copied</span><br>↳ 0x" + key.toString(16);
  try { navigator.clipboard.writeText(address); } catch (e) {}
  showBalance(address, key);   // clicking any wallet also checks its live balance
});

// ---------- Bloom filter: auto-load in the background at startup ----------
// No UI: the filter downloads once, is cached in IndexedDB (instant on return visits),
// and is patched into worker memory silently. Until it's ready, scans fall back to the
// live API path. Local dev serves parts from /bloom/; production from jsDelivr.
const IS_LOCAL = location.hostname === "127.0.0.1" || location.hostname === "localhost";
const BLOOM_BASE = IS_LOCAL
  ? "/bloom/"
  : "https://cdn.jsdelivr.net/gh/toxwp1234/bitkeys@bloom-v1/bloom/";   // TODO: confirm tag/path at deploy
let bloomReady = false, bloomRetried = false;
worker.postMessage({ type: "loadBloom", base: BLOOM_BASE });

// ---------- intro overlay ----------
function hideIntro() { $("#intro").classList.add("hidden"); try { localStorage.setItem("cuvre-intro-seen", "1"); } catch (e) {} }
$("#introGo").addEventListener("click", hideIntro);
$("#about").addEventListener("click", () => $("#intro").classList.remove("hidden"));
try { if (localStorage.getItem("cuvre-intro-seen") === "1") $("#intro").classList.add("hidden"); } catch (e) {}

window.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;
  if (e.key === "ArrowUp" || e.key === "w") { subY += cellPx; normalize(); render(); e.preventDefault(); }
  else if (e.key === "ArrowDown" || e.key === "s") { subY -= cellPx; normalize(); render(); e.preventDefault(); }
  else if (e.key === "ArrowLeft" || e.key === "a") { subX += cellPx; normalize(); render(); e.preventDefault(); }
  else if (e.key === "ArrowRight" || e.key === "d") { subX -= cellPx; normalize(); render(); e.preventDefault(); }
  else if (e.key === "+" || e.key === "=") { cellPx = clampN(cellPx * 1.15, minCell, maxCell); normalize(); render(); e.preventDefault(); }
  else if (e.key === "-") { cellPx = clampN(cellPx / 1.15, minCell, maxCell); normalize(); render(); e.preventDefault(); }
});

$("#clearShelf").addEventListener("click", () => {
  if (!candidateDB) return;
  try { candidateDB.transaction(CANDIDATE_STORE, "readwrite").objectStore(CANDIDATE_STORE).clear(); updateCandidateShelf(); } catch (e) {}
});

window.addEventListener("resize", resize);
loadState();
minCell = minCellFor(penC);   // pen-relative max zoom-out, whether restored or default
resize();
applyURLGoto();
initCandidateDB().then(() => updateCandidateShelf());   // populate the shelf from prior sessions
