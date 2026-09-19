"use strict";
import { dopamine } from "./dopamine.js?v=2";
import { PALETTES, DEFAULT_PALETTE, DEFAULT_GRID, rampOf, paletteById, rgba } from "./palettes.js";
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
const dot = $("#dot");
// Offscreen heat canvas: no longer an on-screen minimap, it only feeds the share card.
const mm = $("#minimap-heatmap");
const mmctx = mm.getContext("2d");
const MM = mm.width, MMb = BigInt(MM);
const TWO256 = 2n ** 256n;

const clampB = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const clampN = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// ---------- state ----------
const aX = 128n, aY = 128n;   // the map IS the Bitcoin keyspace; there is nothing to configure
let W = 2n ** aX, H = 2n ** aY;
let cellPx = 28;
let gliding = false, travelTimer = 0;   // true while a smooth approach is in flight
let home = null, homeArmed = false;    // the checkpoint, and "the next map click plants it"
let gridOn = true;
let raw = false;
let lastScan = null;
let landing = null;        // last teleport target
let landingStale = false;  // true once you have scanned somewhere else since landing
let viewX = 0n, viewY = 0n, subX = 0, subY = 0;
let penC = 16;
let patches = [];                 // {x,y,c} solid scanned squares (current session, teal)
let seen = new Set();             // dedup "x,y,c"
let grayPatches = [];             // territory carried over from soft resets (drawn gray)
let graySeen = new Set();
// Squares other players dug on this tile: {x,y,c,h,color}. Handed over by multiplayer.js, drawn
// and nothing else — never counted, never saved, never exported, gone when you leave the tile.
// peerBusy is the square each of them is drilling RIGHT NOW, so nobody spends a minute scanning
// 65,536 keys somebody else is already halfway through.
let peerPatches = [], peerBusy = [], peerPatchMode = "faded";
let lastResetTime = 0, resetPending = false;   // 1× soft / 2× (<500ms) hard reset
let heatImg = mmctx.createImageData(MM, MM);
let keysScanned = 0;
let mouse = { x: 40, y: 40, inside: false };
let mp = null;                    // multiplayer, once it has loaded (see the end of the file)

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

// The heat layer is a DATA layer: it is repainted only when a patch is added or the
// territory is rebuilt — never on camera moves.
function flushHeat() {
  mmctx.putImageData(heatImg, 0, 0);
  mmctx.globalAlpha = 0.4; mmctx.strokeStyle = "#f7931a"; mmctx.lineWidth = 1;
  mmctx.beginPath();
  mmctx.moveTo(MM / 2, 0); mmctx.lineTo(MM / 2, MM);
  mmctx.moveTo(0, MM / 2); mmctx.lineTo(MM, MM / 2);
  mmctx.stroke(); mmctx.globalAlpha = 1;
}

function fillHeatBg() {
  const d = heatImg.data;
  for (let i = 0; i < d.length; i += 4) { d[i] = 10; d[i + 1] = 12; d[i + 2] = 16; d[i + 3] = 255; }
}
fillHeatBg();
flushHeat();

function resize() {
  const w = stage.clientWidth, h = stage.clientHeight;
  const dpr = window.devicePixelRatio || 1;
  trail.width = w * dpr; trail.height = h * dpr; trail.style.width = w + "px"; trail.style.height = h + "px";
  tctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  render();
}

// Fold the sub-pixel offset into the BigInt cell origin — NON-iteratively, so it stays O(1)
// no matter how far you zoom out. At deep zoom-out (cellPx < 1) a sub-cell offset is smaller
// than a pixel and therefore invisible, so we fold it away entirely and keep the offset at 0
// (the old while-loop would spin billions of times here and hang the tab).
function normalize() {
  if (cellPx <= 0) return;
  if (cellPx >= 1) {                                 // zoomed in / mid — keep exact sub-pixel offset
    let n = Math.floor(subX / cellPx);
    if (n) { subX -= n * cellPx; viewX += BigInt(n); }
    n = Math.floor(subY / cellPx);
    if (n) { subY -= n * cellPx; viewY += BigInt(n); }
  } else {                                            // deep zoom-out — sub-cell precision is invisible
    if (subX) { const n = BigInt(Math.round(subX / cellPx)); if (viewX + n >= 0n) { viewX += n; subX = 0; } }
    if (subY) { const n = BigInt(Math.round(subY / cellPx)); if (viewY + n >= 0n) { viewY += n; subY = 0; } }
  }
  // Origin/end clamp: the travel that would push past the keyspace stays in the PIXEL
  // offset instead of being thrown away. That leftover inset is exactly the void, so it
  // survives a pan and the elastic return has something to interpolate.
  if (viewX < 0n) { subX += Number(viewX) * cellPx; viewX = 0n; }
  if (viewY < 0n) { subY += Number(viewY) * cellPx; viewY = 0n; }
  if (viewX > W) { subX += Number(viewX - W) * cellPx; viewX = W; }
  if (viewY > H) { subY += Number(viewY - H) * cellPx; viewY = H; }
}

// ---------- rendering ----------
// The divisions come from one STATIC pool: 2^n keys per cell. Which two of them are on
// screen is picked by the pen, so that always:   sub < pen <= main
// i.e. the main cell is the smallest static level the pen can fill in one stroke, and the
// sub cell is the next one down — the slots you see filling up inside it.
// Zoom stays continuous. When the pair would get too dense to read, BOTH levels coarsen
// together by the same power of two, so the 2x relationship (and the sub grid) never dies.
// MAIN is the smallest static cell the pen fits in: 2^ceil(log2(penC)).
// SUB divides the PEN itself: s = the largest POWER OF TWO that divides penC (capped at
// penC/2 so there is always something to see inside the main cell).
// Power of two and a divisor of the pen, so s divides BOTH the pen and the main cell:
//   pen 120 -> s = 8   pen = 15 cells, main = 16 cells, the gap is exactly 1 cell
//   pen  96 -> s = 32  pen =  3 cells, main =  4 cells, gap 1 cell
//   pen  39 -> s = 1   pen = 39 cells, main = 64 cells, gap 25 cells
//   pen 128 -> s = 64  pen =  2 cells, main =  2 cells, no gap
// Nothing ever divides unevenly, so no main cell ends in a ragged part-square strip —
// that stray sliver was what looked broken at pen 39 under the old delta-factoring rule.
// s never changes with zoom, so a stroke has the same geometry wherever you drew it.
const GRID_MAIN_MIN_PX = 10, GRID_MAIN_SPLIT_PX = 22, GRID_SUB_MIN_PX = 4;
let gridShift = 0, gridDiv = 1n, gridSubDiv = 0n;
function penMainExp() { return Math.max(0, Math.ceil(Math.log2(Math.max(1, penC)))); }
function penSubCell() {
  let s = 1;
  while (penC % (s * 2) === 0 && s * 2 < penC) s *= 2;
  return s;
}
function gridLevels() {
  const base = penMainExp();
  const sub = penSubCell();
  const at = (n) => cellPx * Math.pow(2, n);
  // The pen cell is only the STARTING rung. From there main walks the powers of two in
  // both directions: up when a cell drops under 10px (zoom-out stays seamless), and now
  // also DOWN when a cell clears 22px, so zooming in keeps splitting it instead of
  // leaving one huge square on screen. It stops splitting at the sub cell — below that
  // the two grids would collide.
  let j = gridShift;
  if (base + j < 0) j = -base;                   // a smaller pen must not drag main below one key
  while (base + j < 400 && !(at(base + j) >= GRID_MAIN_MIN_PX)) j++;
  while (base + j - 1 >= 0 && at(base + j - 1) >= GRID_MAIN_SPLIT_PX) j--;   // down to 1 key
  gridShift = j;
  // Zoomed in far enough, main can end up FINER than the pen's sub cell. Then the roles
  // swap: the bigger of the two is the structural line, the smaller is the quiet one
  // inside it, so there are always exactly two nested grids and never an inverted pair.
  const mainExp = base + j, subExp = Math.round(Math.log2(sub));
  return { coarseExp: Math.max(mainExp, subExp), fineCells: Math.pow(2, Math.min(mainExp, subExp)) };
}
// The lattice takes its colour from the active theme too — the map should feel like one
// thing, not a themed trail under a fixed amber cage. Rebuilt in setPalette(), not per frame.
let gridColor = DEFAULT_GRID;
let GRID_MAIN_IMG = "", GRID_SUB_RGBA = "", GRID_EDGE_RGBA = "";
function buildGridColors() {
  GRID_MAIN_IMG = "linear-gradient(to right," + rgba(gridColor, .32) + " 1px,transparent 1px)," +
                  "linear-gradient(to bottom," + rgba(gridColor, .32) + " 1px,transparent 1px)";
  GRID_SUB_RGBA = rgba(gridColor, .13);
  GRID_EDGE_RGBA = rgba(gridColor, .55);
}
buildGridColors();
const subImgFor = (p) => {
  const a = Math.max(0, p - 1) + "px", b = p + "px", c = GRID_SUB_RGBA;
  const stops = (dir) => "repeating-linear-gradient(to " + dir +
    ",transparent 0,transparent " + a + "," + c + " " + a + "," + c + " " + b + ")";
  return stops("right") + "," + stops("bottom");
};
let gridImg = "";
const lastFrame = { grid: null, clip: null };
// While an image is being rendered: exportScale replaces the screen DPR (so edges snap to the
// export's own pixels), and exportClean hides everything that is UI rather than map — the
// home checkpoint, the landing marker, the dashed in-flight outline.
let exportScale = 0, exportClean = false;   // what draw() last put on screen — read by snapshotMap()

let pending = false;
// Counting how MANY frames went out measures how much happened, not how fast we are. This
// renderer is event-driven — it draws when something moves and stays idle otherwise — so a
// perfectly smooth map with one peer cursor easing across it honestly produced eight frames
// that second, and "8 fps" is a true number answering a question nobody asked.
// What is worth showing is the COST of a frame: how many we could sustain if we drew back to
// back. That is the number that falls when the map gets heavy, which is the only moment this
// counter earns its place in the header. Smoothed, and capped at the 60 Hz the browser will
// hand us anyway — beyond that the figure would just be measuring an empty draw.
const FPS_CEIL = 60;
let frameCost = 1000 / FPS_CEIL, shownFps = 0;
function updateFps(ms) {
  frameCost += (ms - frameCost) * 0.15;              // EMA: one expensive frame is not the headline
  const el = $("#fpsCounter");
  if (!el) return;
  const rate = clampN(Math.round(1000 / Math.max(frameCost, 1000 / FPS_CEIL)), 1, FPS_CEIL);
  if (rate === shownFps) return;                     // the header is rewritten only when it changes
  shownFps = rate;
  el.style.color = rate >= 50 ? "var(--accent)" : rate >= 30 ? "#e0b155" : "#f0616d";
  el.textContent = rate + " fps";
  el.title = "how many redraws a second the map could sustain (a redraw currently costs "
           + frameCost.toFixed(1) + " ms). It does not count idle time: the map only draws when something moves.";
}
function render() { if (pending) return; pending = true; requestAnimationFrame(() => {
  pending = false;
  const t0 = performance.now();
  draw();
  updateFps(performance.now() - t0);
}); }

function draw() {
  // Two lattices. The PEN lattice is the one that matters: those are the exact squares the
  // brush snaps into, so patches tile edge to edge and structures line up. It groups up in
  // powers of two once a pen square would be too small to read. Under it sits the faint
  // per-cell grid, drawn only once a single key is big enough to see.
  const { coarseExp, fineCells } = gridLevels();
  const mainExp = coarseExp, sub = fineCells;
  const mainPitch = cellPx * Math.pow(2, mainExp);
  const subPitch = cellPx * sub;
  const dB = 2n ** BigInt(mainExp);                // both layers share the main cell's box
  const phX = (Number(viewX % dB) * cellPx + subX) % mainPitch;
  const phY = (Number(viewY % dB) * cellPx + subY) % mainPitch;
  const box = mainPitch + "px " + mainPitch + "px";
  const pos = (-phX) + "px " + (-phY) + "px";
  const imgs = [GRID_MAIN_IMG];                    // first = painted on top
  gridDiv = 2n ** BigInt(mainExp);
  gridSubDiv = 0n;
  if (!gliding && subPitch >= GRID_SUB_MIN_PX && subPitch < mainPitch) {   // gradient re-raster is the cost of a deep zoom; skip it in flight
    imgs.push(subImgFor(subPitch));
    gridSubDiv = BigInt(sub);
  }
  // Lines off: an EMPTY background-image just falls back to the stylesheet's own #grid rule,
  // so it has to be an explicit "none". The background colour and the keyspace clip stay.
  if (!gridOn) imgs.length = 0;
  const sizes = [], poss = [];
  for (let i = 0; i < imgs.length; i++) { sizes.push(box, box); poss.push(pos, pos); }
  const img = imgs.length ? imgs.join(",") : "none";
  lastFrame.grid = { on: imgs.length > 0, mainPitch, subPitch, phX, phY, sub: imgs.length > 1 };
  if (img !== gridImg) { grid.style.backgroundImage = img; gridImg = img; }
  grid.style.backgroundSize = sizes.join(",");
  grid.style.backgroundPosition = poss.join(",");

  const w = stage.clientWidth, h = stage.clientHeight;
  tctx.clearRect(0, 0, w, h);

  // ---- keyspace bounds ----------------------------------------------------
  // The grid is a repeating CSS pattern, so on its own it tiles forever — including
  // past the last key, where the cursor is already clamped. That mismatch reads as an
  // invisible wall at max zoom-out. Compute where [0,0]..[W,H] actually lands on screen
  // and cut everything outside it: the grid is clipped, the void is shaded, and the
  // boundary gets a visible frame.
  // Screen pixels are clamped to a margin around the viewport because when zoomed in,
  // W * cellPx is ~1e40 and raw values that big make unusable CSS / canvas coords.
  const clampPx = (v, hi) => (!Number.isFinite(v) || v > hi + 2000) ? hi + 2000 : (v < -2000 ? -2000 : v);
  const kx1 = clampPx(-Number(viewX) * cellPx - subX, w);
  const ky1 = clampPx(-Number(viewY) * cellPx - subY, h);
  const kx2 = clampPx(kx1 + Number(W) * cellPx, w);
  const ky2 = clampPx(ky1 + Number(H) * cellPx, h);

  const clipL = Math.max(0, kx1), clipT = Math.max(0, ky1);
  const clipR = Math.min(w, kx2), clipB = Math.min(h, ky2);
  lastFrame.clip = { l: clipL, t: clipT, r: clipR, b: clipB };
  grid.style.clipPath =
    `polygon(${clipL}px ${clipT}px, ${clipR}px ${clipT}px, ${clipR}px ${clipB}px, ${clipL}px ${clipB}px)`;

  // out-of-bounds void
  const iy1 = Math.max(0, ky1), iy2 = Math.min(h, ky2);
  tctx.fillStyle = raw ? "#e8e8e8" : "rgba(5,6,8,0.92)";
  if (ky1 > 0) tctx.fillRect(0, 0, w, ky1);
  if (ky2 < h) tctx.fillRect(0, ky2, w, h - ky2);
  if (kx1 > 0) tctx.fillRect(0, iy1, kx1, Math.max(0, iy2 - iy1));
  if (kx2 < w) tctx.fillRect(kx2, iy1, w - kx2, Math.max(0, iy2 - iy1));
  // Draw a patch at its TRUE size. When you're zoomed far enough out that it would be
  // smaller than a pixel it is simply not drawn — at that scale it is genuinely invisible,
  // which is the honest thing to show (no fake "painted" specks floating in empty space).
  // Edges are snapped to whole DEVICE pixels (the canvas carries a devicePixelRatio
  // transform, so rounding in CSS pixels is not enough). A fractional fillRect antialiases
  // its border, and two of those meeting leave a visible seam down the join — patches that
  // touch in key space have to touch on screen with nothing between them.
  const dpr = exportScale || window.devicePixelRatio || 1;
  const snap = (v) => Math.round(v * dpr) / dpr;
  function drawPatch(p) {
    const s = p.c * cellPx;
    if (s < 1) return;
    const sx = Number(p.x - viewX) * cellPx - subX;
    const sy = Number(p.y - viewY) * cellPx - subY;
    if (sx > w || sy > h || sx + s < 0 || sy + s < 0) return;
    const x0 = snap(sx), y0 = snap(sy);
    tctx.fillRect(x0, y0, Math.max(1 / dpr, snap(sx + s) - x0), Math.max(1 / dpr, snap(sy + s) - y0));
  }
  // everything that lives in the keyspace is clipped to it, so a patch or the landing
  // marker can never bleed into the void.
  tctx.save();
  tctx.beginPath();
  tctx.rect(clipL, clipT, clipR - clipL, clipB - clipT);
  tctx.clip();
  // Other players' territory, underneath everything of ours. Left out of the PNG export — that
  // picture is your map.
  if (!raw) for (const p of peerPatches) { tctx.fillStyle = peerFill(p); drawPatch(p); }
  // territory from past (soft-reset) sessions — desaturated gray, "we've been here"
  tctx.fillStyle = raw ? "#7a7a7a" : "rgba(102,106,116,0.5)";
  for (const p of grayPatches) drawPatch(p);
  // current session, drawn on top — tinted by how many candidates the patch turned up
  if (raw) { tctx.fillStyle = "#000000"; for (const p of patches) drawPatch(p); }
  else for (const p of patches) { tctx.fillStyle = patchFill(p); drawPatch(p); }
  // The square currently under the drill: an outline only. It is not painted until the scan
  // finishes, but a 65,536-key dig takes a while and a click with no feedback at all reads
  // as a dead click.
  const q = !exportClean && scanActive && pendingScan && pendingScan.pending;
  if (q && !raw) {
    const sz = q.c * cellPx;
    const sx = Number(q.x - viewX) * cellPx - subX, sy = Number(q.y - viewY) * cellPx - subY;
    if (sz >= 3 && sx <= w && sy <= h && sx + sz >= 0 && sy + sz >= 0) {
      tctx.save();
      tctx.setLineDash([4, 3]);
      tctx.strokeStyle = GRID_EDGE_RGBA;
      tctx.lineWidth = 1;
      tctx.strokeRect(sx + 0.5, sy + 0.5, sz - 1, sz - 1);
      tctx.restore();
    }
  }
  // Somebody else's drill, live. Same dashed square as your own so the shape already means
  // "being scanned, not finished", but in their colour and with a faint wash, because the whole
  // point is to be noticed from across the map before you click the same ground.
  if (!raw && !exportClean && peerBusy.length) {
    tctx.save();
    tctx.setLineDash([5, 4]);
    tctx.lineWidth = 2;
    for (const b of peerBusy) {
      const sz = b.c * cellPx;
      const sx = Number(b.x - viewX) * cellPx - subX, sy = Number(b.y - viewY) * cellPx - subY;
      if (!(sz >= 3) || sx > w || sy > h || sx + sz < 0 || sy + sz < 0) continue;
      tctx.fillStyle = withAlpha(b.color, 0.12);
      tctx.fillRect(sx, sy, sz, sz);
      tctx.strokeStyle = b.color;
      tctx.strokeRect(sx + 1, sy + 1, sz - 2, sz - 2);
    }
    tctx.restore();
  }
  if (home && !exportClean) {   // the checkpoint — same one-key shape as the landing marker, but white
    const hx = Number(home.x - viewX) * cellPx - subX;
    const hy = Number(home.y - viewY) * cellPx - subY;
    const s = Math.max(cellPx, 10);
    tctx.fillStyle = "rgba(255,255,255,0.22)";
    tctx.fillRect(hx, hy, s, s);
    tctx.strokeStyle = "#f4f7fa";
    tctx.lineWidth = 2;
    tctx.strokeRect(hx + 0.5, hy + 0.5, s - 1, s - 1);
  }
  if (landing && !exportClean) {   // where you teleported: one key, red while it is the live target
    const lx = Number(landing.x - viewX) * cellPx - subX;
    const ly = Number(landing.y - viewY) * cellPx - subY;
    const s = Math.max(cellPx, 10);
    tctx.fillStyle = landingStale ? "rgba(139,147,163,0.16)" : "rgba(240,97,109,0.18)";
    tctx.fillRect(lx, ly, s, s);
    tctx.strokeStyle = landingStale ? "#8b93a3" : "#f0616d";
    tctx.lineWidth = 2;
    tctx.strokeRect(lx + 0.5, ly + 0.5, s - 1, s - 1);
  }
  tctx.restore();
  // edge of the keyspace — the hard limit the cursor is clamped to
  if (kx2 > kx1 && ky2 > ky1) {
    tctx.strokeStyle = raw ? "#000000" : GRID_EDGE_RGBA;
    tctx.lineWidth = 1.5;
    tctx.strokeRect(kx1 + 0.5, ky1 + 0.5, kx2 - kx1, ky2 - ky1);
  }
  positionCursor();
  if (mp) mp.layout();          // other players follow the camera
  updateZoomUI();
  scheduleSave();
}

// The one point the map orbits: where you just teleported, if it is on screen, otherwise
// the middle of the stage. Both the zoom buttons and the parked pen use it, so zooming
// always closes in on the thing you are looking at.
function focusPoint() {
  const w = stage.clientWidth || 0, h = stage.clientHeight || 0;
  if (landing) {
    const lx = Number(landing.x - viewX) * cellPx - subX;
    const ly = Number(landing.y - viewY) * cellPx - subY;
    if (Number.isFinite(lx) && Number.isFinite(ly) && lx >= 0 && ly >= 0 && lx <= w && ly <= h) return [lx, ly];
  }
  return [w / 2, h / 2];
}

// Centre the keyspace whenever it is smaller than the stage on that axis, so the whole
// map always sits in the middle instead of flush against the origin.
function centerKeyspace() {
  const w = stage.clientWidth, h = stage.clientHeight;
  const kw = Number(W) * cellPx, kh = Number(H) * cellPx;
  if (kw <= w) { viewX = 0n; subX = -(w - kw) / 2; }
  if (kh <= h) { viewY = 0n; subY = -(h - kh) / 2; }
}

// ---------- candidate heat ----------
// Every patch remembers how many of its keys the Bloom filter flagged — the ones that get
// sent to the balance API — and the colour is driven by that COUNT, not by density.
// Density was working against you: a big brush scans more keys, so a real find got divided
// by a bigger area and came out paler than a lucky small patch. Count does the opposite,
// which is the point — dig wide, turn up more, and the square says so.
let paletteId = DEFAULT_PALETTE;
let HEAT_RAMP = rampOf(paletteById(paletteId));
function setPalette(id) {
  const pal = paletteById(id);
  paletteId = pal.id;
  HEAT_RAMP = rampOf(pal);
  gridColor = pal.grid || DEFAULT_GRID;
  buildGridColors();
  gridImg = "";                 // the background-image cache keys on the string, so drop it
  render();
  positionCursor();
}

// Each hit has to move the colour less than the one before it, but never so little that you
// cannot see it. log1p does exactly that: the first find is a jump, the tenth is a nudge, and
// nothing ever lands on the same colour twice. HEAT_FULL is where the ramp runs out — chosen
// so the whole plausible range is spent on it (a 2^8 brush is 65,536 keys, and at the filter's
// ~1.2e-4 false-positive rate that is ~8 candidates on an ordinary dig).
const HEAT_FULL = 24;
const HEAT_DENOM = Math.log1p(HEAT_FULL);
function patchHeat(p) {
  const h = p.h || 0;
  return h > 0 ? clampN(Math.log1p(h) / HEAT_DENOM, 0, 1) : 0;
}
function patchFill(p) { return heatColor(patchHeat(p), 1); }
// "#rrggbb" -> "rgba(r,g,b,a)". The parse is cached because a peer square asks for it on every
// frame and there are only ever eight player colours.
const RGB_CACHE = new Map();
function withAlpha(hex, a) {
  let rgb = RGB_CACHE.get(hex);
  if (!rgb) {
    const h = typeof hex === "string" && /^#[0-9a-f]{6}$/i.test(hex) ? hex : "#4fb3ff";
    rgb = parseInt(h.slice(1, 3), 16) + "," + parseInt(h.slice(3, 5), 16) + "," + parseInt(h.slice(5, 7), 16);
    RGB_CACHE.set(hex, rgb);
  }
  return "rgba(" + rgb + "," + a + ")";
}
// How another player's finished square is painted. Their colour keeps ownership legible; the
// palette option gives that up on purpose, so a patch somebody else dug is coloured by what it
// turned up exactly like one of yours and the map reads as a single picture.
function peerFill(p) {
  if (peerPatchMode === "palette") return patchFill(p);
  return withAlpha(p.color, peerPatchMode === "solid" ? 1 : 0.28);
}
function heatColor(t, alpha, lift) {
  let i = 0;
  while (i < HEAT_RAMP.length - 2 && t > HEAT_RAMP[i + 1][0]) i++;
  const [t0, c0] = HEAT_RAMP[i], [t1, c1] = HEAT_RAMP[i + 1];
  const u = t1 > t0 ? clampN((t - t0) / (t1 - t0), 0, 1) : 0;
  const ch = (k) => {
    const v = c0[k] + (c1[k] - c0[k]) * u;
    return Math.round(lift ? v + (255 - v) * lift : v);
  };
  return "rgba(" + ch(0) + "," + ch(1) + "," + ch(2) + "," + alpha + ")";
}

// Which scanned patch is under the cursor. Cached on the snapped cell (plus the patch count,
// so a fresh scan invalidates it) — the list is walked only when you move to a new square,
// not on every frame.
let hoverCell = "", hoverPatch = null;
function patchAt(x, y) {
  const k = x + "," + y + "," + patches.length;
  if (k === hoverCell) return hoverPatch;
  hoverCell = k; hoverPatch = null;
  for (let i = patches.length - 1; i >= 0; i--) {
    const p = patches[i], c = BigInt(p.c);
    if (x >= p.x && x < p.x + c && y >= p.y && y < p.y + c) { hoverPatch = p; break; }
  }
  return hoverPatch;
}

// keyspace rect in stage pixels — the single source of truth for the void
function keyRect() {
  const kx1 = -Number(viewX) * cellPx - subX;
  const ky1 = -Number(viewY) * cellPx - subY;
  return { kx1, ky1, kx2: kx1 + Number(W) * cellPx, ky2: ky1 + Number(H) * cellPx };
}
const inVoid = (mx, my, k) => (mx < k.kx1 || mx > k.kx2 || my < k.ky1 || my > k.ky2);

// Snaps to the SUB grid — the small squares you can actually see — so a stroke always
// starts on a visible line, at every zoom, whatever the pen size is.
function cellUnder(mx, my) {
  const fx = (mx + subX) / cellPx, fy = (my + subY) / cellPx;
  let x = viewX + BigInt(Math.floor(fx));
  let y = viewY + BigInt(Math.floor(fy));
  const c = BigInt(penC);
  x = clampB(x, 0n, W - c > 0n ? W - c : 0n);
  y = clampB(y, 0n, H - c > 0n ? H - c : 0n);
  const q = BigInt(Math.max(1, penSubCell()));       // fixed by the pen, never by the zoom
  return [(x / q) * q, (y / q) * q];                 // x,y >= 0 here, so this floors
}

function positionCursor() {
  const w = stage.clientWidth, h = stage.clientHeight;
  const parked = !mouse.inside;
  const [fx, fy] = parked ? focusPoint() : [0, 0];
  const mx = parked ? fx : mouse.x;
  const my = parked ? fy : mouse.y;

  // The pen box is hidden; the dot is the whole pointer now.
  dot.style.display = parked ? "none" : "block";
  if (!parked) {
    dot.style.transform = `translate(${mouse.x}px,${mouse.y}px)`;
    dot.classList.toggle("dot-void", inVoid(mx, my, keyRect()));
  }

  if (mp) mp.pointerMoved();     // throttled inside; a no-op when nothing moved
  const [x, y] = cellUnder(mx, my);
  // The full key under the cursor, not a truncated one — a 256-bit number with its middle
  // cut out is not a number you can do anything with. Guarded so the DOM is not rewritten
  // on every frame the cursor happens to sit still.
  const hx = "0x" + x.toString(16), hy = "0x" + y.toString(16);
  if (hx !== posShown.x) { posShown.x = hx; $("#posX").textContent = hx; }
  if (hy !== posShown.y) { posShown.y = hy; $("#posY").textContent = hy; }
  const loc = $("#loc");
  const hp = patchAt(x, y);
  loc.innerHTML =
    `X ${pctOf(x, W)} <span style="color:var(--muted)">${shortHex(x, 5, 4)}</span><br>` +
    `Y ${pctOf(y, H)} <span style="color:var(--muted)">${shortHex(y, 5, 4)}</span>` +
    (hp ? `<br><span style="color:${heatColor(patchHeat(hp), 1, 0.3)}">■</span> ` +
          `${hp.h.toLocaleString("en-US")} / ${(hp.c * hp.c).toLocaleString("en-US")} ` +
          `<span style="color:var(--muted)">flagged</span>` : "");
  loc.title = "x 0x" + x.toString(16) + "\ny 0x" + y.toString(16);

  const precEl = $("#precisionInfo");
  if (precEl && cellPx > 0) precEl.textContent = "cell: " + (cellPx / 28).toFixed(2) + "×";

  // Highlight exactly the keys this click would paint: penC x penC cells at the snapped
  // origin, drawn at TRUE size so what lights up is what gets scanned.
  const { kx1, ky1, kx2, ky2 } = keyRect();
  const size = Math.max(penC * cellPx, 2);
  const px = Number(x - viewX) * cellPx - subX;
  const py = Number(y - viewY) * cellPx - subY;
  if (!Number.isFinite(px) || !Number.isFinite(py) || px > w || py > h || px + size < 0 || py + size < 0) {
    cursor.style.display = "none";
    return;
  }
  cursor.style.display = "block";
  cursor.classList.toggle("cursor-void", !parked && inVoid(mx, my, { kx1, ky1, kx2, ky2 }));
  cursor.style.width = size + "px";
  cursor.style.height = size + "px";
  cursor.style.transform = `translate(${px}px,${py}px)`;
}

// ---------- scanning (client-side, on click only) ----------
const worker = new Worker("derive.worker.js?v=8", { type: "module" });
// One row-major mapping index -> private key, shared by the patch click handler and the
// Bloom candidate path, so a "funded" address can never be paired with the wrong key.
const keyAt = (i, scan) => scan.k0 + BigInt(Math.floor(i / scan.cols)) * scan.W + BigInt(i % scan.cols);
const DISPLAY_CAP = 2048;  // max rows rendered in the list; the stream checks far more than we display
let scanId = 0, pendingScan = null, scanActive = false, firstAddr = null, scanT0 = 0;
let scanRevealed = false;   // reveal the scan's result number ONCE, after every potential is checked
let verifyDone = false;     // fire the box-hide + completion chime exactly once per scan

function scanAt(x, y) {
  if (landing && (landing.x !== x || landing.y !== y)) landingStale = true;
  try { dopamine.initAudio(); } catch (e) {}         // unlock the AudioContext within this click gesture
  const key = x + "," + y + "," + penC;
  const k0 = kAt(x, y);
  const kh = $("#kHex");
  kh.textContent = shortHex(k0, 8, 8);
  kh.title = "0x" + k0.toString(16);
  // Nothing is painted yet. The patch lands only once the scan actually finishes (see
  // commitPatch) — clicking used to colour the square immediately, which meant you could
  // spray the map faster than a single key could be checked and end up with territory you
  // never scanned. A click that gets cancelled by the next click leaves no trace at all.
  render();
  // stream the WHOLE patch: pen n -> n*n keys, derived + bloom-checked in chunks, off-thread.
  // No cap — the machine goes as far/fast as it can; a new click cancels the running scan.
  const id = ++scanId;
  pendingScan = { id, k0, W, cols: penC, total: penC * penC, checkedSoFar: 0,
                  pending: { x, y, c: penC, key } };   // becomes a real patch at scanDone
  lastScan = { k0, W, cols: penC };
  scanActive = true;
  if (mp && mp.digging) mp.digging(pendingScan.pending);   // claim the square while it is being drilled
  balGen++; balBatch = { gen: balGen, total: 0, done: 0, funded: 0, failed: 0, scan: true };  // fresh balance session
  scanRevealed = false; verifyDone = false; hideChecking();   // fresh scan: nothing revealed / verified yet
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
let balBatch = { gen: -1, total: 0, done: 0, funded: 0, failed: 0, scan: false };

// ---- live "checking a potential key" module (between the balance card and the metrics) ----
// Shows ONLY while a scan's Bloom candidates are being verified: animated dots + the key
// currently in flight + a "X / Y potential verified" counter that keeps climbing. The wait
// itself (<=1 API call/s) becomes the feedback, so 40 candidates over ~40s never feel dead.
function showChecking(key) {
  const box = $("#checkingBox"); if (box) box.style.display = "block";
  const k = $("#chkKey");
  if (k) { k.textContent = key; k.classList.remove("tick"); void k.offsetWidth; k.classList.add("tick"); }
  updateCheckingCount();
  const prog = balBatch.total ? balBatch.done / balBatch.total : 0;
  try { dopamine.tick(prog); } catch (e) {}          // rising "pluck" per key — the satisfying cadence
}
function updateCheckingCount() {
  const d = $("#chkDone"), t = $("#chkTotal"), bar = $("#chkBar");
  if (d) d.textContent = balBatch.done.toLocaleString("en-US");
  if (t) t.textContent = balBatch.total.toLocaleString("en-US");
  if (bar) bar.style.width = (balBatch.total ? Math.min(100, balBatch.done / balBatch.total * 100) : 0) + "%";
}
function hideChecking() { const box = $("#checkingBox"); if (box) box.style.display = "none"; }
// fire the "all potentials verified" finish (hide box + celebratory chime) exactly once per scan
function finishVerification() {
  if (verifyDone) return;
  verifyDone = true;
  hideChecking();
  if (balBatch.total > 0) { try { dopamine.chime(); } catch (e) {} }
}

// The single entry point for every balance check. A row click / pen-1 cell is just a
// batch of one; a Bloom patch passes all its candidates at once. Returns immediately —
// results trickle in as slots free up, so the click itself always feels instant.
function checkBalances(items) {                     // items: [{addr, priv}]
  const gen = ++balGen;                             // supersede any earlier batch outright
  balQueue = items.map((it) => ({ addr: it.addr, priv: it.priv, i: it.i, gen }));
  balBatch = { gen, total: items.length, done: 0, funded: 0, failed: 0, scan: false };
  hideChecking();                                   // a manual click is not a scan — no live checking box
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
    if (balBatch.scan) showChecking(shortHex(job.priv, 10, 8));   // live: the potential key in flight
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
  if (b.scan) updateCheckingCount();               // climb the "X / Y potential verified" counter live
  if (funded) {                                     // the prize takes the card — and is saved forever
    b.funded++; setBalCard("funded", job.addr, res.sat, job.priv);
    saveCandidateToHistory(job.addr, res.sat, job.priv); updateCandidateShelf();
  } else {
    if (res.status !== "ok") b.failed++;
    // reveal the honest 0 BTC number ONLY once every potential key has actually been checked
    if (!b.funded && !scanActive && b.done >= b.total && !scanRevealed) { scanRevealed = true; finishBatch(b); }
  }
  if (b.scan && !scanActive && b.done >= b.total) finishVerification();   // last potential resolved -> box done
}

worker.onmessage = (e) => {
  const msg = e.data;
  // ---- Bloom lifecycle ----
  if (msg.type === "bloomProgress") {
    const pct = msg.total ? Math.floor(msg.loaded / msg.total * 100) : 0;
    setFilterStatus(pct + "%", "var(--muted)", "downloading the Bloom filter — " + pct + "%");
    return;
  }
  if (msg.type === "bloomReady") {
    bloomReady = true;
    setFilterStatus("ready", "#4fb98a", "Bloom filter loaded — scans flag candidate wallets");
    return;
  }
  if (msg.type === "bloomError") {                      // transient? retry once — but say so
    if (!bloomRetried) {
      bloomRetried = true;
      setFilterStatus("retrying", "#e0b155", "filter download failed, retrying: " + msg.error);
      setTimeout(() => worker.postMessage({ type: "loadBloom", base: BLOOM_BASE }), 4000);
    } else {
      setFilterStatus("offline", "#f0616d", "Bloom filter unavailable — scans cannot flag candidates. " + msg.error);
    }
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
    commitPatch(msg.checked, msg.foundCount);
    if (msg.display) renderPatchList(msg.display, msg.total, msg.bloomOn);
    scanActive = false;
    if (mp && mp.digging) mp.digging(null);        // a no-op when commitPatch already announced it
    render(); scheduleSave();
    finishScanUI();
    return;
  }
};

// A patch exists once its scan has run to the end — not before. It carries how many keys the
// Bloom filter flagged (h) and how many were actually checked (n), which is what tints it.
// A cancelled scan commits nothing, so it costs no territory and earns no dig.
function commitPatch(checked, found) {
  const q = pendingScan && pendingScan.pending;
  if (!q) return;
  pendingScan.pending = null;
  const p = { x: q.x, y: q.y, c: q.c, h: found | 0, n: checked | 0 };
  const old = patches.find((o) => o.c === p.c && o.x === p.x && o.y === p.y);
  if (old) { old.h = p.h; old.n = p.n; }          // re-dug the same square: refresh, do not duplicate
  else {
    seen.add(q.key);
    patches.push(p);
    creditDig();
    const mi = (toMMy(p.y) * MM + toMMx(p.x)) * 4;
    if (mi >= 0 && mi < heatImg.data.length) { heatImg.data[mi] = 31; heatImg.data[mi + 1] = 111; heatImg.data[mi + 2] = 136; }
    flushHeat();
  }
  $("#mPatches").textContent = patches.length.toLocaleString("en-US");
  refreshStats();
  render();
  if (mp && mp.dug) mp.dug(p);          // tell whoever is standing here with us
}

// keysScanned ticks up honestly as the stream confirms keys (never the fictional pen²)
function tickChecked(checked) {
  const delta = checked - pendingScan.checkedSoFar;
  if (delta <= 0) return;
  pendingScan.checkedSoFar = checked;
  keysScanned += delta;
  $("#mScanned").textContent = keysScanned.toLocaleString("en-US");
  $("#kFrac").textContent = fracExplored();
  setStat("keys", keysScanned.toLocaleString("en-US"));
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
  setStat("rate", rate.toLocaleString("en-US") + "/s");
  $("#balState").textContent = bloomOn ? "scanning patch…" : "loading filter…";
  $("#balUsd").textContent = "of " + total.toLocaleString("en-US") + " · " + rate.toLocaleString("en-US") + "/s"
    + (found ? " · " + found.toLocaleString("en-US") + " candidate" + (found > 1 ? "s" : "") + " ★" : "");
}
function finishScanUI() {
  $("#scanBarWrap").style.display = "none";
  setStat("rate", "0/s");                      // idle means idle, not "whatever the last burst hit"
  if (balBatch.done >= balBatch.total) {                // every potential already resolved by scan-end
    if (balBatch.scan) finishVerification();            // hide the checking box + chime (once)
    if (!balBatch.funded && !scanRevealed) { scanRevealed = true; showBloomEmpty2(); }
  } else if (!balBatch.funded) {                        // potentials still being fetched — DON'T claim 0 BTC yet
    // This used to print total - done, so a scan that turned up 100 candidates and had
    // verified 87 of them announced "13 potential keys" — the backlog, read as the find.
    $("#balState").textContent = "verifying " + balBatch.done.toLocaleString("en-US") + " / "
      + balBatch.total.toLocaleString("en-US") + " potential keys…";
    // the honest number reveals in reportBalance the moment the last potential resolves
  }
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

// ---------- elastic return: a click in the void pulls the map back ----------
// Only subX/subY (pixel offsets) are interpolated — never viewX/viewY. normalize() folds
// each step into the BigInt origin, so no float math ever touches a 10^38 magnitude.
let elasticRAF = 0, elDX = 0, elDY = 0;
function stopElastic() { if (elasticRAF) { cancelAnimationFrame(elasticRAF); elasticRAF = 0; } elDX = elDY = 0; }
function elasticStep() {
  elasticRAF = 0;
  const kx = elDX * 0.22, ky = elDY * 0.22;          // lerp toward the edge
  const sx = Math.abs(elDX) < 0.5 ? elDX : kx;
  const sy = Math.abs(elDY) < 0.5 ? elDY : ky;
  subX += sx; subY += sy; elDX -= sx; elDY -= sy;
  normalize(); render();
  if (Math.abs(elDX) >= 0.5 || Math.abs(elDY) >= 0.5) elasticRAF = requestAnimationFrame(elasticStep);
}
function elasticReturn() {
  const w = stage.clientWidth, h = stage.clientHeight;
  const { kx1, ky1, kx2, ky2 } = keyRect();
  const kw = kx2 - kx1, kh = ky2 - ky1;
  // nearest resting place for the keyspace: flush against the edge you drifted past,
  // or dead-centre when the whole space is smaller than the stage
  const tx = kw <= w ? (w - kw) / 2 : (kx1 > 0 ? 0 : (kx2 < w ? w - kw : kx1));
  const ty = kh <= h ? (h - kh) / 2 : (ky1 > 0 ? 0 : (ky2 < h ? h - kh : ky1));
  elDX = clampN(kx1 - tx, -w, w);
  elDY = clampN(ky1 - ty, -h, h);
  if (!Number.isFinite(elDX) || !Number.isFinite(elDY)) { stopElastic(); return; }
  if (Math.abs(elDX) < 0.5 && Math.abs(elDY) < 0.5) { stopElastic(); return; }
  if (!elasticRAF) elasticRAF = requestAnimationFrame(elasticStep);
}

// ---------- interaction: hover moves cursor, drag pans, click scans ----------
let down = false, moved = false, lx = 0, ly = 0;
stage.addEventListener("mouseenter", () => { mouse.inside = true; });
stage.addEventListener("mouseleave", () => { mouse.inside = false; positionCursor(); });
stage.addEventListener("mousedown", (e) => {
  if (e.target.closest("#zoomCtl, #zoomScale")) return;   // clicks on the overlay controls aren't map scans
  stopZoom();                                             // grabbing the map cancels any approach in flight
  down = true; moved = false; lx = e.clientX; ly = e.clientY;
});
window.addEventListener("mouseup", (e) => {
  if (down && !moved) {
    const r = stage.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    if (inVoid(mx, my, keyRect())) elasticReturn();   // clicked the void: pull the map back
    else if (homeArmed) { const [x, y] = cellUnder(mx, my); setHome(x, y); }
    else { const [x, y] = cellUnder(mx, my); scanAt(x, y); }
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
// ---------- zoom: discrete snapped levels + a separate whole-space view ----------
// cellPx is always penC x a fixed multiplier, so a cell, the pen square and the grid
// lattice are whole numbers of pixels at every level — nothing lands on a half pixel.
// Below the last level the ladder ends and the map jumps to the whole-space view, where
// the grid is sub-pixel anyway and the void / edges / elastic return take over.
// Continuous zoom: cellPx = BASE_CELL * zoomLevel, any float. Deliberately NOT tied to
// the pen — changing the brush must not move or rescale the map.
const BASE_CELL = 16;
const ZOOM_SPEED = 1.15;                 // per wheel notch
const MAX_ZOOM = 32;
let zoomLevel = 1.0;
let isWholeSpaceMode = false;
let zoomLabelShown = "";

// The floor is the cell size at which the WHOLE keyspace fits — not a constant. A fixed
// 0.001 would still leave 2^128 keys a factor of ~10^33 too wide to ever reach the edges,
// and it would be wrong again the moment the axis size changes in the header.
function wholeSpaceCell() {
  // A stage narrower than its own padding would make the fit zero or negative, and a zero
  // floor turns every zoom ratio into Infinity. Never let the usable box fall under a pixel.
  const vw = Math.max(1, (stage.clientWidth || 800) - 40), vh = Math.max(1, (stage.clientHeight || 600) - 40);
  const fit = Math.min(vw / Number(W), vh / Number(H));
  return fit > 0 ? fit : Number.MIN_VALUE;
}
function minZoom() { return wholeSpaceCell() / BASE_CELL; }

// How close an automatic approach settles — Random, Go To, and the dive out of whole space.
// Not "one key fills the screen", but the scale of the brush you are holding: roughly eight
// pen squares across the short side of the stage, so the framing looks the same whichever
// preset you picked. A pen that is not one of the 1..8 presets has no scale of its own, so it
// falls back to preset 6. The wheel is untouched — it still goes all the way in.
const APPROACH_EXP = 6, APPROACH_SQUARES = 8;
function approachZoom() {
  const n = Math.log2(penC);
  const exp = Number.isInteger(n) && n >= 1 && n <= 8 ? n : APPROACH_EXP;
  const short = Math.min(stage.clientWidth || 800, stage.clientHeight || 600);
  const pxPerKey = short / APPROACH_SQUARES / Math.pow(2, exp);
  return clampN(pxPerKey / BASE_CELL, minZoom(), MAX_ZOOM);
}

function updateZoomDisplay() {
  const el = $("#zoomLevel");
  if (!el) return;
  const key = (isWholeSpaceMode ? "w" : "z") + ":" + cellPx + ":" + gridDiv + ":" + gridSubDiv;
  if (key === zoomLabelShown) return;                 // draw() calls this every frame
  zoomLabelShown = key;
  const head = isWholeSpaceMode ? "whole"
    : cellPx >= 1 ? cellPx.toFixed(1) + " px" : cellPx.toPrecision(2) + " px";
  const n = (v) => v <= 1 ? "1" : (v < 1e6 ? v.toLocaleString("en-US") : fmtBig(v));
  const d = Number(gridDiv), sd = Number(gridSubDiv);
  const div = n(d) + " / " + (sd ? n(sd) : "–") + (d <= 1 ? " key" : " keys");
  el.innerHTML = head + '<div style="font-size:9px;color:var(--muted);margin-top:2px">cell · '
               + div + "</div>";
  el.style.color = isWholeSpaceMode ? "var(--accent)" : "var(--text)";
  el.title = (isWholeSpaceMode ? "whole space" : "zoom " + zoomLevel.toPrecision(3) + "x") + "\n" + (cellPx >= 1
    ? "1 key = " + (cellPx < 10 ? cellPx.toFixed(1) : Math.round(cellPx)) + " px"
    : "1 px ≈ " + fmtBig(1 / cellPx) + " keys");
}

// ---------- smooth approach ----------
// Not an animation in the keyframe sense: the map keeps drawing exactly what it always
// draws, we just walk zoomLevel there instead of jumping. The walk is GEOMETRIC (each
// frame multiplies) because that is what reads as constant speed to the eye across 35
// orders of magnitude, and the camera centre is a BigInt lerp, so crossing 10^38 keys
// costs the same as crossing ten.
let glideRAF = 0;
function stopGlide() {
  if (glideRAF) { cancelAnimationFrame(glideRAF); glideRAF = 0; }
  if (travelTimer) { clearTimeout(travelTimer); travelTimer = 0; }
  gliding = false;
}
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

function keyAtPixel(mx, my) {
  const ax = Number.isFinite(mx) ? mx : stage.clientWidth / 2;
  const ay = Number.isFinite(my) ? my : stage.clientHeight / 2;
  return [clampB(viewX + BigInt(Math.floor((ax + subX) / cellPx)), 0n, W),
          clampB(viewY + BigInt(Math.floor((ay + subY) / cellPx)), 0n, H)];
}
// the key you are closing in on: the landing marker if it is live, else the middle
function focusKey() { return landing ? [landing.x, landing.y] : keyAtPixel(); }
// No normalize() here on purpose. At whole-space zoom it folds the pixel offset back into
// the BigInt through a float divide (subX / cellPx ~ 1e40), which keeps only 53 bits and
// silently zeroes the bottom ~80 bits of the coordinate — that is what made every random
// landing end in a run of zeros. viewX stays exactly the key we were given.
function centerOnKey(cx, cy) {
  viewX = cx; subX = -stage.clientWidth / 2;
  viewY = cy; subY = -stage.clientHeight / 2;
}
function glide(o) {
  stopGlide();
  gliding = true;
  const z0 = zoomLevel, z1 = clampN(o.zoom, minZoom(), MAX_ZOOM);
  const [sx, sy] = keyAtPixel();
  // Pulling all the way out means the keyspace CENTRE ends up in the middle of the stage,
  // so that is what we walk toward. Holding the key you happened to be over instead leaves
  // the map hanging off one side for the whole trip and then snapping into place on the
  // last frame — which is the "it keeps trying to fit and can't" flicker.
  const toWhole = z1 <= minZoom() * 1.0001;
  const tx = o.cx !== undefined ? clampB(o.cx, 0n, W) : (toWhole ? W / 2n : sx);
  const ty = o.cy !== undefined ? clampB(o.cy, 0n, H) : (toWhole ? H / 2n : sy);
  const dx = Number(tx - sx), dy = Number(ty - sy);
  const lr = Math.log(z1 / z0);
  if (!Number.isFinite(lr)) {                      // degenerate scale: nothing to walk, just be there
    zoomLevel = z1; cellPx = BASE_CELL * z1; isWholeSpaceMode = true;
    centerKeyspace(); render(); updateZoomDisplay();
    gliding = false; if (o.then) o.then(); return;
  }
  if (Math.abs(lr) < 1e-9 && !dx && !dy) { gliding = false; if (o.then) o.then(); return; }
  // longer trip, longer glide — but never so long that it feels like waiting
  const ms = o.ms || clampN(280 + 70 * Math.abs(lr / Math.LN2), 300, 1300);
  const t0 = performance.now();
  const step = (now) => {
    glideRAF = 0;
    const done = now - t0 >= ms;
    const e = easeInOut(clampN((now - t0) / ms, 0, 1));
    zoomLevel = done ? z1 : z0 * Math.exp(lr * e);
    cellPx = BASE_CELL * zoomLevel;
    isWholeSpaceMode = zoomLevel <= minZoom() * 1.0001;
    // The in-flight positions go through a float (dx is a Number), so only the LAST frame
    // may decide where we actually are — it uses the untouched BigInt target.
    if (done) centerOnKey(tx, ty);
    else centerOnKey(sx + BigInt(Math.round(dx * e)), sy + BigInt(Math.round(dy * e)));
    if (isWholeSpaceMode) centerKeyspace();
    render(); updateZoomDisplay(); positionCursor();
    if (!done) glideRAF = requestAnimationFrame(step);
    else { gliding = false; if (o.then) o.then(); }
  };
  glideRAF = requestAnimationFrame(step);
}

// Pull all the way out first (the further in you are, the longer that takes), put the
// marker down so you can see where you are headed, hold for a beat, then descend slowly.
// The descent is deliberately unhurried: every frame at this scale is expensive, and a
// long ease hides that far better than a short one.
function travelTo(cx, cy, mark) {
  stopZoom();
  const lo = minZoom();
  const out = clampN(240 + 40 * Math.abs(Math.log2(zoomLevel / lo)), 240, 900);
  glide({ zoom: lo, ms: out, then: () => {
    if (mark !== false) { landing = { x: cx, y: cy }; landingStale = false; }
    render();
    travelTimer = setTimeout(() => {              // 0.7 s to actually see the point on the whole map
      travelTimer = 0;
      glide({ zoom: approachZoom(), cx, cy, ms: 2600 });
    }, 700);
  } });
}

// Re-scale around (mx,my), keeping the key under that point pinned to the same pixel.
function applyZoom(mx, my) {
  stopGlide();
  const ax = Number.isFinite(mx) ? mx : stage.clientWidth / 2;
  const ay = Number.isFinite(my) ? my : stage.clientHeight / 2;
  const fx = (ax + subX) / cellPx, fy = (ay + subY) / cellPx;
  const kx = viewX + BigInt(Math.floor(fx)), ky = viewY + BigInt(Math.floor(fy));
  const rx = fx - Math.floor(fx), ry = fy - Math.floor(fy);
  const lo = minZoom();
  zoomLevel = clampN(zoomLevel, lo, MAX_ZOOM);
  cellPx = BASE_CELL * zoomLevel;
  isWholeSpaceMode = zoomLevel <= lo * 1.0001;
  viewX = kx; subX = rx * cellPx - ax;
  viewY = ky; subY = ry * cellPx - ay;
  normalize();
  // Zooming near an edge used to force the map flush against that edge on the same frame, and
  // to jump dead-centre the instant the whole keyspace fitted. Both are correct resting places
  // and both were reached in one step, which is what made a zoom by the border snap around
  // under the cursor. They are the SAME resting places the elastic return already knows, so
  // hand it the job: the key under the pointer stays pinned, and the map eases home behind it.
  elasticReturn();
  render();
  updateZoomDisplay();
}
// From whole space a single 1.15x notch is invisible — you'd need ~240 of them to see a
// key. So the first step in out of max zoom-out is a smooth approach to 1x instead.
function zoomIn(mx, my) {
  if (isWholeSpaceMode) { const [cx, cy] = keyAtPixel(mx, my); glide({ zoom: approachZoom(), cx, cy }); return; }
  zoomLevel = Math.min(MAX_ZOOM, zoomLevel * ZOOM_SPEED); applyZoom(mx, my);
}
function zoomOut(mx, my) { zoomLevel = Math.max(minZoom(), zoomLevel / ZOOM_SPEED); applyZoom(mx, my); }

function enterWholeSpace() {
  zoomLevel = minZoom();
  cellPx = BASE_CELL * zoomLevel;
  isWholeSpaceMode = true;
  stopElastic(); stopGlide();
  centerKeyspace();
  render();
  updateZoomDisplay();
}
function zoomFit() { enterWholeSpace(); }
function toggleWholeSpace() {
  if (isWholeSpaceMode) { const [cx, cy] = focusKey(); glide({ zoom: approachZoom(), cx, cy }); }
  else glide({ zoom: minZoom() });
}
// restore: derive the zoom from the saved cell size
function syncZoomIndex() {
  zoomLevel = clampN((cellPx > 0 ? cellPx : BASE_CELL) / BASE_CELL, minZoom(), MAX_ZOOM);
  cellPx = BASE_CELL * zoomLevel;
  isWholeSpaceMode = zoomLevel <= minZoom() * 1.0001;
}
function stopZoom() { stopElastic(); stopGlide(); }

// where the +/- buttons zoom toward: the landing marker, else the middle of the map
function zoomFocus() { return focusPoint(); }
// ---------- zoom scale indicator (how deep are we?) ----------
const SUP = { "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹", "-": "⁻" };
const sup = (n) => String(n).split("").map((c) => SUP[c] || c).join("");
function fmtBig(n) {
  if (n < 1000) return Math.round(n).toLocaleString("en-US");
  const e = Math.floor(Math.log10(n));
  return (n / Math.pow(10, e)).toFixed(1) + "×10" + sup(e);
}
function updateZoomUI() {
  updateZoomDisplay();
  const det = $("#zsDetail");
  if (det) det.textContent = cellPx >= 1
    ? "1 key = " + (cellPx < 10 ? cellPx.toFixed(1) : Math.round(cellPx)) + " px"
    : "1 px ~ " + fmtBig(1 / cellPx) + " keys";
}
// Bound to the stage, not window: the sidebar (address list, candidate shelf) still scrolls.
stage.addEventListener("wheel", (e) => {
  if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;
  e.preventDefault();
  const r = stage.getBoundingClientRect();
  const mx = e.clientX - r.left, my = e.clientY - r.top;
  if (e.deltaY > 0) zoomOut(mx, my); else zoomIn(mx, my);
}, { passive: false });

// ---------- controls ----------
// ---------- smart reset: 1× soft (gray tiles + zero the count) · 2× fast (full wipe) ----------
function showResetToast(msg) {
  const t = $("#resetToast"); if (!t) return;
  t.textContent = msg; t.classList.add("show");
  clearTimeout(t._timer); t._timer = setTimeout(() => t.classList.remove("show"), 1700);
}
function cancelActiveWork() {                     // drop any in-flight scan + queued balance checks
  scanId++; pendingScan = null; scanActive = false; balGen++;
  if (mp && mp.digging) mp.digging(null);         // take our marker off everyone else's map
  worker.postMessage({ type: "cancel" });
  hideChecking();                                  // tear down the live checking box on cancel/reset
}
function handleSoftReset() {
  for (const p of patches) {                      // current territory becomes gray "we've been here"
    const k = p.x + "," + p.y + "," + p.c;
    if (!graySeen.has(k)) { graySeen.add(k); grayPatches.push(p); }
  }
  patches = []; seen.clear(); keysScanned = 0;
  cancelActiveWork(); resetBalCard();
  $("#mScanned").textContent = "0"; $("#mPatches").textContent = "0"; $("#kFrac").textContent = fracExplored();
  refreshStats();
  render();
  clearTimeout(saveTimer); saveState();            // persist immediately — don't rely on the rAF-debounced save
  showResetToast("soft reset — " + grayPatches.length.toLocaleString("en-US") + " patches kept as territory");
}
function handleHardReset() {                       // nuclear: nothing survives
  patches = []; seen.clear(); grayPatches = []; graySeen.clear(); keysScanned = 0;
  cancelActiveWork(); resetBalCard(); fillHeatBg(); flushHeat();
  if (candidateDB) { try { candidateDB.transaction(CANDIDATE_STORE, "readwrite").objectStore(CANDIDATE_STORE).clear(); } catch (e) {} }
  updateCandidateShelf();
  $("#mScanned").textContent = "0"; $("#mPatches").textContent = "0"; $("#kFrac").textContent = "0 %";
  refreshStats();
  render();
  clearTimeout(saveTimer); saveState();            // persist immediately — don't rely on the rAF-debounced save
  showResetToast("hard reset — clean slate");
}
function handleResetClick() {
  const now = Date.now();
  if (resetPending && now - lastResetTime < 500) { resetPending = false; askWipe(); return; }   // the wipe is the one step with no undo — ask first
  resetPending = true; lastResetTime = now;
  setTimeout(() => { resetPending = false; }, 500);
  handleSoftReset();
}
$("#clear").addEventListener("click", handleResetClick);
const wipeModal = $("#wipeModal");
function askWipe() { wipeModal.style.display = "flex"; }
function closeWipe() { wipeModal.style.display = "none"; }
$("#wipeNo").addEventListener("click", closeWipe);
$("#wipeYes").addEventListener("click", () => { closeWipe(); handleHardReset(); });
wipeModal.addEventListener("click", (e) => { if (e.target === wipeModal) closeWipe(); });
// ---------- progression: the brush is earned ----------
// You start on 2^1. Ten fresh patches dug WITH your biggest brush unlock the next one, all the
// way to 2^8; ten more at 2^8 unlock the slider and the exact field. Re-clicking a patch you
// already scanned does not count — only new ground. Progression is persisted, and a reset does
// not touch it: a reset clears the trail, not what you earned walking it.
const PEN_START_EXP = 1, PEN_TOP_EXP = 8, DIGS_PER_UNLOCK = 10;
let penExp = PEN_START_EXP;   // highest unlocked preset
let penDigs = 0;              // fresh patches dug at that preset since the last unlock
let penFree = false;          // slider + exact field earned
const penCap = () => (penFree ? 1000000 : Math.pow(2, penExp));

function setPen(v) {
  // Pen and zoom are unrelated: the brush changes size, the map does not move or rescale.
  penC = clampN(Math.round(v) || 16, 1, penCap());
  $("#pen").value = penC;
  $("#penRange").value = clampN(penC, 1, 110);   // slider tops out at 110; the exact field is free
  $("#penVal").textContent = penC.toLocaleString("en-US");
  $("#penWarn").style.display = penC * penC > 16384 ? "inline" : "none";
  syncPenPow();
  render();
  positionCursor();
}
// The 1..8 buttons are 2^n presets — lit in BTC orange only when the pen is exactly that
// power, dimmed while still locked, and the next one fills up as you dig toward it.
const penPowBtns = Array.from(document.querySelectorAll("#penPow button"));
function syncPenPow() {
  const n = Math.log2(penC), exact = Number.isInteger(n);
  for (const b of penPowBtns) {
    const e = Number(b.dataset.pow);
    const locked = !penFree && e > penExp;
    const next = !penFree && e === penExp + 1;
    b.classList.toggle("on", exact && e === n);
    b.classList.toggle("locked", locked);
    b.classList.toggle("next", next);
    b.disabled = locked;
    b.title = locked
      ? "locked — dig " + DIGS_PER_UNLOCK + " patches with pen " + Math.pow(2, penExp)
      : "pen " + Math.pow(2, e);
    if (next) b.style.setProperty("--pg", Math.round(penDigs / DIGS_PER_UNLOCK * 100) + "%");
    else b.style.removeProperty("--pg");
  }
  $("#penRange").disabled = !penFree;
  $("#pen").disabled = !penFree;
  const q = $("#penQuest");
  if (q) {
    const left = DIGS_PER_UNLOCK - penDigs;
    const html = penFree
      ? "every brush unlocked · slider free"
      : "dig <b>" + left + "</b> more with pen <b>" + Math.pow(2, penExp) + "</b> → "
        + (penExp < PEN_TOP_EXP ? "pen " + Math.pow(2, penExp + 1) : "the slider");
    // Dragging the slider fires setPen() on every pixel, and innerHTML is a parse each time
    // even when the sentence is identical — which is exactly when the brush feels sticky.
    if (html !== q._html) { q._html = html; q.innerHTML = html; }
  }
}
// called once per FRESH patch — re-digging old ground is not progress
function creditDig() {
  if (penFree || penC !== Math.pow(2, penExp)) return;
  if (++penDigs < DIGS_PER_UNLOCK) { syncPenPow(); return; }
  penDigs = 0;
  if (penExp < PEN_TOP_EXP) { penExp++; showResetToast("pen " + Math.pow(2, penExp) + " unlocked"); }
  else { penFree = true; showResetToast("slider unlocked — any brush size is yours"); }
  syncPenPow();
}
for (const b of penPowBtns) b.addEventListener("click", () => {
  const e = Number(b.dataset.pow);
  if (!penFree && e > penExp) return;
  setPen(Math.pow(2, e));
});
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
      aX: aX.toString(), aY: aY.toString(), penC, cellPx, penExp, penDigs, penFree,
      viewX: viewX.toString(), viewY: viewY.toString(), subX, subY,
      keysScanned, gridOn, paletteId,
      home: home ? [home.x.toString(), home.y.toString()] : null,
      patches: kept.map((p) => [p.x.toString(), p.y.toString(), p.c, p.h || 0, p.n || 0]),
      grayPatches: grayPatches.slice(-PATCH_CAP).map((p) => [p.x.toString(), p.y.toString(), p.c, p.h || 0, p.n || 0]),
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
  flushHeat();
}
function loadState() {
  let s;
  try { s = JSON.parse(localStorage.getItem(STORE) || "null"); } catch (e) { s = null; }
  if (!s) return false;
  try {
    penExp = clampN(s.penExp | 0 || PEN_START_EXP, PEN_START_EXP, PEN_TOP_EXP);
    penDigs = clampN(s.penDigs | 0, 0, DIGS_PER_UNLOCK - 1);
    penFree = !!s.penFree;
    penC = s.penC || 16; cellPx = s.cellPx || 28;   // axes are fixed; an old save's aX/aY is ignored
    viewX = BigInt(s.viewX || "0"); viewY = BigInt(s.viewY || "0");
    subX = s.subX || 0; subY = s.subY || 0;
    keysScanned = s.keysScanned || 0;
    gridOn = s.gridOn !== false;
    setPalette(s.paletteId || DEFAULT_PALETTE);
    home = s.home ? { x: BigInt(s.home[0]), y: BigInt(s.home[1]) } : null;
    patches = (s.patches || []).map(([x, y, c, h, n]) => ({ x: BigInt(x), y: BigInt(y), c, h: h || 0, n: n || 0 }));
    for (const p of patches) seen.add(p.x + "," + p.y + "," + p.c);
    grayPatches = (s.grayPatches || []).map(([x, y, c, h, n]) => ({ x: BigInt(x), y: BigInt(y), c, h: h || 0, n: n || 0 }));
    for (const p of grayPatches) graySeen.add(p.x + "," + p.y + "," + p.c);
    rebuildHeat();
    $("#penVal").textContent = penC;   // setPen() below applies the progression cap and syncs the inputs
    $("#penWarn").style.display = penC > 48 ? "inline" : "none";
    $("#mScanned").textContent = keysScanned.toLocaleString("en-US");
    $("#mPatches").textContent = patches.length.toLocaleString("en-US");
    $("#kFrac").textContent = fracExplored();
    return true;
  } catch (e) { /* corrupt state — start fresh */ return false; }
}

// ---------- shareable result card (client-side image, no backend) ----------
// ---------- map snapshot ----------
// The map on screen is two layers: #trail is a canvas (patches, void, border, markers) and can
// be copied straight across, but the grid is a CSS background — there are no pixels to read.
// So the grid is repainted here from the exact numbers draw() used for that frame (pitch,
// phase, colour, clip), line for line, and the trail is laid over it. The pen square and the
// on-map badges are DOM, not canvas, and are deliberately left out — a result, not a cursor.
function snapshotMap(scale) {
  const w = stage.clientWidth, h = stage.clientHeight;
  const S = scale || window.devicePixelRatio || 1;
  // Re-render the trail at S rather than stretching the on-screen copy: a stretched canvas is
  // blurry, a re-rendered one is sharp at any size. The visible canvas is borrowed for one
  // synchronous frame and put back by resize() before anything can paint it.
  trail.width = Math.round(w * S); trail.height = Math.round(h * S);
  tctx.setTransform(S, 0, 0, S, 0, 0);
  exportScale = S; exportClean = true;
  try { draw(); } finally { exportScale = 0; exportClean = false; }

  const c = document.createElement("canvas");
  c.width = trail.width; c.height = trail.height;
  const g = c.getContext("2d");
  g.scale(S, S);
  g.fillStyle = raw ? "#ffffff" : "#0a0c10";
  g.fillRect(0, 0, w, h);
  // The grid is a CSS background — no pixels to copy — so it is repainted from the exact
  // numbers draw() used for this frame. The CSS main layer puts its 1px line at the START of
  // each tile, the sub layer at the END of each sub period; reproduced as-is.
  const G = lastFrame.grid, K = lastFrame.clip;
  if (G && G.on && K && K.r > K.l && K.b > K.t && G.mainPitch > 0) {
    g.save();
    g.beginPath(); g.rect(K.l, K.t, K.r - K.l, K.b - K.t); g.clip();
    const lines = (pitch, offset, color) => {
      if (!(pitch >= 2)) return;
      g.fillStyle = color;
      for (let x = -G.phX + offset; x < w; x += pitch) if (x > -2) g.fillRect(Math.round(x * S) / S, 0, 1, h);
      for (let y = -G.phY + offset; y < h; y += pitch) if (y > -2) g.fillRect(0, Math.round(y * S) / S, w, 1);
    };
    if (G.sub) lines(G.subPitch, G.subPitch - 1, GRID_SUB_RGBA);
    lines(G.mainPitch, 0, rgba(gridColor, .32));
    g.restore();
  }
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.drawImage(trail, 0, 0);

  resize();                                        // on-screen canvas back to the screen DPR
  return c;
}

// shrink a font until the text fits the width it has, instead of running off the card
function fitFont(g, text, weight, size, maxW, family) {
  let px = size;
  do { g.font = weight + " " + px + "px " + family; } while (g.measureText(text).width > maxW && --px > 10);
  return px;
}

async function makeCard() {
  const CW = 1200, CH = 630, SANS = "Inter, system-ui, sans-serif";
  const c = document.createElement("canvas");
  c.width = CW; c.height = CH;
  const g = c.getContext("2d");
  g.fillStyle = "#0d0f13"; g.fillRect(0, 0, CW, CH);

  // right half: the map exactly as it was, cover-cropped around its centre
  const MX = 620, MY = 40, MW = 540, MH = 550, R = 18;
  const shot = snapshotMap(Math.max(2, window.devicePixelRatio || 1));
  const scale = Math.max(MW / shot.width, MH / shot.height);
  const sw = MW / scale, sh = MH / scale;
  g.save();
  g.beginPath();
  if (g.roundRect) g.roundRect(MX, MY, MW, MH, R); else g.rect(MX, MY, MW, MH);
  g.clip();
  g.drawImage(shot, (shot.width - sw) / 2, (shot.height - sh) / 2, sw, sh, MX, MY, MW, MH);
  g.restore();
  g.strokeStyle = "#262c38"; g.lineWidth = 2;
  g.beginPath();
  if (g.roundRect) g.roundRect(MX, MY, MW, MH, R); else g.rect(MX, MY, MW, MH);
  g.stroke();

  // left half: the numbers
  const LX = 64, LW = MX - LX - 48;
  g.fillStyle = "#f7931a"; g.beginPath(); g.arc(LX + 18, 86, 18, 0, 7); g.fill();
  g.fillStyle = "#1a1204"; g.font = "700 22px " + SANS; g.textAlign = "center"; g.fillText("₿", LX + 18, 94);
  g.textAlign = "left";
  g.fillStyle = "#e6e9ef"; g.font = "600 24px " + SANS; g.fillText("Bitcoin Keyspace", LX + 48, 94);

  const keys = keysScanned.toLocaleString("en-US");
  g.fillStyle = "#e6e9ef"; fitFont(g, keys, "600", 104, LW, SANS); g.fillText(keys, LX - 4, 268);
  g.fillStyle = "#8b93a3"; g.font = "400 30px " + SANS; g.fillText("private keys explored", LX, 314);

  const stats = patches.length.toLocaleString("en-US") + " patches · " + statsFound().toLocaleString("en-US") + " flagged · 0 held Bitcoin";
  g.fillStyle = "#e6e9ef"; fitFont(g, stats, "500", 26, LW, SANS); g.fillText(stats, LX, 388);

  g.fillStyle = "#f7931a"; fitFont(g, "odds of ever finding one: ~10⁻⁴¹", "500", 30, LW, SANS);
  g.fillText("odds of ever finding one: ~10⁻⁴¹", LX, 470);
  g.fillStyle = "#8b93a3"; g.font = "400 22px " + SANS;
  g.fillText("2²⁵⁶ keys exist. You cannot brute-force this.", LX, 540);
  g.fillText("That's the point.", LX, 572);

  return await new Promise((res) => c.toBlob(res, "image/png"));
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
const cardName = () => "bitcoin-keyspace-" + new Date().toISOString().slice(0, 10) + ".png";

// Save as PNG is the map and nothing else — no card, no text — rendered so its long side is
// ~4096px (never below the screen's own DPR, never above 6x, to stay inside canvas limits).
const EXPORT_LONG_SIDE = 4096;
$("#savePng").addEventListener("click", async () => {
  const w = stage.clientWidth, h = stage.clientHeight;
  const S = clampN(EXPORT_LONG_SIDE / Math.max(w, h), window.devicePixelRatio || 1, 6);
  const c = snapshotMap(S);
  const blob = await new Promise((res) => c.toBlob(res, "image/png"));
  downloadBlob(blob, "bitcoin-keyspace-map-" + new Date().toISOString().slice(0, 10) + ".png");
});
$("#share").addEventListener("click", async () => {
  const blob = await makeCard();
  const file = new File([blob], cardName(), { type: "image/png" });
  const text = `I explored ${keysScanned.toLocaleString("en-US")} Bitcoin private keys on the keyspace map and found exactly 0. Odds of a hit: ~10^-41.`;
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], text }); return; } catch (e) { /* fall through */ }
  }
  downloadBlob(blob, cardName());
});

// ---------- go to / teleport + shareable URL position ----------
function goTo(cx, cy) {
  stopZoom();
  cx = clampB(cx, 0n, W); cy = clampB(cy, 0n, H);
  const vc = Math.floor(stage.clientWidth / cellPx / 2) || 0;
  const vr = Math.floor(stage.clientHeight / cellPx / 2) || 0;
  viewX = clampB(cx - BigInt(vc), 0n, W);
  viewY = clampB(cy - BigInt(vr), 0n, H);
  landing = { x: cx, y: cy };
  landingStale = false;
  subX = 0; subY = 0; normalize(); centerKeyspace(); render();
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
// ?dev=1 — every brush preset and the free slider straight away, for testing something that
// needs a big pen without digging thirty patches to earn one. It flips the same flags the
// progression would have flipped, so like any other unlock it stays in the save afterwards.
function applyDevMode() {
  if (new URLSearchParams(location.search).get("dev") !== "1") return;
  penExp = PEN_TOP_EXP; penDigs = 0; penFree = true;
  setPen(Math.pow(2, PEN_TOP_EXP));
  showResetToast("dev mode — every brush unlocked");
  scheduleSave();
}
// cryptographically-random BigInt in [0, maxExclusive)
function randBig(maxExclusive) {
  const bits = maxExclusive.toString(2).length;
  const bytes = Math.ceil(bits / 8) || 1;
  const arr = crypto.getRandomValues(new Uint8Array(bytes));
  let v = 0n; for (const b of arr) v = (v << 8n) + BigInt(b);
  return v % maxExclusive;
}
// Random is a trip, not a teleport. It keeps whatever brush you are holding — the pen is what
// decides how close the trip ends, so resetting it here would make every landing look the same.
$("#rand").addEventListener("click", () => { travelTo(randBig(W), randBig(H)); });
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
  goErr(""); travelTo(x, y);
});
$("#gok").addEventListener("click", () => {
  const b = $("#base").value;
  const k = parseVal($("#gk").value, b), max = W * H;
  if (k === null) return goErr("Invalid key for base “" + b + "”.");
  if (k < 1n || k > max) return goErr("Key out of range (1 … 2^" + (aX + aY) + ").");
  goErr(""); const i = k - 1n; travelTo(i % W, i / W);
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
// Pinned to the commit that shipped the chunks, not to a branch: a commit URL is immutable, so
// jsDelivr can cache it forever and can never hand out a manifest from one version with parts
// from another. The old value pointed at a tag (bloom-v1) that was never created and a folder
// (bloom/) that does not exist — every production load 404'd, silently, and every scan found 0.
// If the filter is ever rebuilt, bump this to the commit that ships the new chunks.
const BLOOM_COMMIT = "99a865b0bdceb18f8207e9a7c80a39e8fd1e3964";
const BLOOM_BASE = IS_LOCAL
  ? "/bloom/"
  : "https://cdn.jsdelivr.net/gh/toxwp1234/bitkeys@" + BLOOM_COMMIT + "/data/bloom_chunks/";
let bloomReady = false, bloomRetried = false;
// The filter's state is on screen now. It used to load with no UI at all, which is exactly how a
// broken URL went unnoticed: no candidates, no colour, and nothing saying why.
function setFilterStatus(text, color, title) {
  const el = $("#statFilter"); if (!el) return;
  if (el.textContent !== text) el.textContent = text;
  el.style.color = color || "";
  const wrap = $("#statFilterWrap"); if (wrap) wrap.title = title || "";
}
setFilterStatus("loading", "var(--muted)", "downloading the Bloom filter (~126 MB, cached after the first visit)");
worker.postMessage({ type: "loadBloom", base: BLOOM_BASE });

// ---------- checkpoint + grid toggle ----------
// "Set home" does not plant anything by itself — it arms the next click on the map, so you
// pick the spot with the same gesture you scan with. Going home reuses the smooth approach
// but skips the red landing marker: the white checkpoint square is already the thing to look
// at, and two markers stacked on one key just read as a mess.
function setHome(x, y) {
  home = { x, y };
  homeArmed = false;
  syncHomeUI();
  render();
  scheduleSave();
  showResetToast("checkpoint set");
}
function syncHomeUI() {
  const set = $("#setHome"), go = $("#goHome");
  set.classList.toggle("arm", homeArmed);
  set.title = homeArmed ? "armed — click the map to plant the checkpoint (Esc cancels)"
                        : "click, then click the map to plant a checkpoint";
  go.disabled = !home;
}
$("#setHome").addEventListener("click", () => { homeArmed = !homeArmed; syncHomeUI(); });
$("#goHome").addEventListener("click", () => { if (home) travelTo(home.x, home.y, false); });
$("#gridToggle").addEventListener("click", () => {
  gridOn = !gridOn;
  $("#gridToggle").classList.toggle("on", gridOn);   // lit while the lines are showing
  render();
  clearTimeout(saveTimer); saveState();               // a toggle then a close should survive
});
// Escape disarms — see the global keydown handler below.

// ---------- theme menu ----------
// Back to a popover: one glyph in the row, the list on click. The list builds itself from
// palettes.js, so adding a palette there is still the whole job.
const themeMenu = $("#themeMenu");
function buildThemeMenu() {
  themeMenu.innerHTML = "";
  for (const pal of PALETTES) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "theme-row" + (pal.id === paletteId ? " on" : "");
    row.title = pal.note || pal.name;
    const bar = document.createElement("span");
    bar.className = "theme-bar";
    bar.style.background = "linear-gradient(90deg," + pal.colors.join(",") + ")";
    const label = document.createElement("span");
    label.className = "theme-name";
    label.textContent = pal.name;
    row.append(bar, label);
    row.addEventListener("click", () => { setPalette(pal.id); buildThemeMenu(); openThemeMenu(false); scheduleSave(); });
    themeMenu.append(row);
  }
}
function openThemeMenu(on) {
  themeMenu.hidden = !on;
  $("#themeBtn").classList.toggle("on", on);
}
$("#themeBtn").addEventListener("click", (e) => { e.stopPropagation(); openThemeMenu(themeMenu.hidden); });
document.addEventListener("click", (e) => { if (!themeMenu.hidden && !themeMenu.contains(e.target)) openThemeMenu(false); });

// ---------- header stats ----------
// The sidebar already carries these, but it scrolls and it is easy to lose. Up here they are
// always in frame. Each writer guards on "did the text actually change", because positionCursor
// runs every frame and the DOM should not.
let statShown = { keys: "", rate: "", found: "" };
function setStat(name, value) {
  if (statShown[name] === value) return;
  statShown[name] = value;
  const el = $("#stat" + name[0].toUpperCase() + name.slice(1));
  if (el) el.textContent = value;
}
const posShown = { x: "", y: "" };
function statsFound() {
  let n = 0;
  for (const p of patches) n += p.h || 0;
  return n;
}
function refreshStats() {
  setStat("keys", keysScanned.toLocaleString("en-US"));
  setStat("found", statsFound().toLocaleString("en-US"));
}

// ---------- intro overlay ----------
// The stage hides the OS pointer so the pen square is the only cursor. The intro lives INSIDE
// the stage, so it inherited that and the card felt unclickable — you were aiming blind at
// "Explore". While an overlay is up the real pointer comes back and the pen square steps out.
function showIntro(on) {
  $("#intro").classList.toggle("hidden", !on);
  stage.classList.toggle("overlay", on);
}
function hideIntro() { showIntro(false); try { localStorage.setItem("cuvre-intro-seen", "1"); } catch (e) {} }
$("#introGo").addEventListener("click", hideIntro);
$("#about").addEventListener("click", () => showIntro(true));
try { showIntro(localStorage.getItem("cuvre-intro-seen") !== "1"); } catch (e) { showIntro(true); }

window.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;
  if (e.key === "ArrowUp" || e.key === "w") { subY += cellPx; normalize(); render(); e.preventDefault(); }
  else if (e.key === "ArrowDown" || e.key === "s") { subY -= cellPx; normalize(); render(); e.preventDefault(); }
  else if (e.key === "ArrowLeft" || e.key === "a") { subX += cellPx; normalize(); render(); e.preventDefault(); }
  else if (e.key === "ArrowRight" || e.key === "d") { subX -= cellPx; normalize(); render(); e.preventDefault(); }
  else if (e.key === "+" || e.key === "=") { const [mx, my] = zoomFocus(); zoomIn(mx, my); e.preventDefault(); }
  else if (e.key === "-") { const [mx, my] = zoomFocus(); zoomOut(mx, my); e.preventDefault(); }
  else if (e.key === "h" || e.key === "H") { toggleWholeSpace(); e.preventDefault(); }
  else if (e.key === "Escape") { if (!themeMenu.hidden) openThemeMenu(false); if (homeArmed) { homeArmed = false; syncHomeUI(); } }
});

// ---------- on-screen zoom controls ----------
$("#zIn").addEventListener("click", () => { const [mx, my] = zoomFocus(); zoomIn(mx, my); });
$("#zOut").addEventListener("click", () => { const [mx, my] = zoomFocus(); zoomOut(mx, my); });
$("#zMax").addEventListener("click", () => { const [mx, my] = zoomFocus(); zoomLevel = MAX_ZOOM; applyZoom(mx, my); });
$("#zFit").addEventListener("click", toggleWholeSpace);   // whole space <-> 1x

$("#clearShelf").addEventListener("click", () => {
  if (!candidateDB) return;
  try { candidateDB.transaction(CANDIDATE_STORE, "readwrite").objectStore(CANDIDATE_STORE).clear(); updateCandidateShelf(); } catch (e) {}
});

window.addEventListener("resize", () => { if (isWholeSpaceMode) zoomFit(); resize(); });
const hadSave = loadState();
if (hadSave) syncZoomIndex();  // land the restored cellPx on a rung of the ladder
else {                         // first visit: open on the whole-space overview
  viewX = 0n; viewY = 0n; subX = 0; subY = 0; isWholeSpaceMode = true;
}
setPen(penC);                   // clamp a restored brush to what is actually unlocked, and paint the presets
syncHomeUI();
buildThemeMenu();
refreshStats();
$("#gridToggle").classList.toggle("on", gridOn);
resize();
if (isWholeSpaceMode) zoomFit();
updateZoomDisplay();
applyURLGoto();
applyDevMode();
initCandidateDB().then(() => updateCandidateShelf());   // populate the shelf from prior sessions

// ---------- multiplayer (cursors and dug blocks of whoever is on your tile) ----------
// Loaded on its own and last, so a missing config, a blocked CDN or a bug in there can never
// take the map down with it. It sees the map only through these few functions.
import("./multiplayer.js?v=2")
  .then((m) => m.initMultiplayer({
    stage, W, H, isLocal: IS_LOCAL,
    cellPx: () => cellPx,
    // the key under the pointer — or, with the mouse off the map, the key it is orbiting
    pointer() {
      const parked = !mouse.inside;
      const [mx, my] = parked ? focusPoint() : [mouse.x, mouse.y];
      const ax = (mx + subX) / cellPx, ay = (my + subY) / cellPx;
      const ix = Math.floor(ax), iy = Math.floor(ay);
      return { x: clampB(viewX + BigInt(ix), 0n, W - 1n), y: clampB(viewY + BigInt(iy), 0n, H - 1n),
               fx: cellPx >= 1 ? ax - ix : 0, fy: cellPx >= 1 ? ay - iy : 0, c: penC, parked };
    },
    project: (x, y, fx, fy) => [(Number(x - viewX) + fx) * cellPx - subX, (Number(y - viewY) + fy) * cellPx - subY],
    travelTo: (x, y) => travelTo(x, y, false),
    // Where the CAMERA is and how much of the keyspace fits on screen. Multiplayer decides which
    // region channel you belong on from this, not from the cursor: one pixel can be 10^36 keys.
    view() {
      const w = stage.clientWidth, h = stage.clientHeight;
      const half = (n) => (cellPx > 0 && Number.isFinite(n / cellPx) ? BigInt(Math.floor(n / cellPx / 2)) : 0n);
      return { cx: clampB(viewX + half(w), 0n, W - 1n),
               cy: clampB(viewY + half(h), 0n, H - 1n),
               // A stage that has not been laid out yet is not "a very small view of the map";
               // it is no view at all, and must not read as one.
               span: cellPx > 0 && w > 0 ? w / cellPx : Infinity };
    },
    // what we have dug this session, and where to put what the others have dug
    myPatches: () => patches,
    showPeerPatches: (list, mode) => { peerPatches = list; peerPatchMode = mode || "faded"; render(); },
    showPeerBusy: (list) => { peerBusy = list; render(); },
  }))
  .then((api) => { mp = api; if (mp) mp.layout(); })
  .catch((e) => console.warn("multiplayer failed to load:", e));

