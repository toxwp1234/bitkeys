"use strict";
// ---------- multiplayer, phase 1: see where the other players are ----------
// Only a cursor goes over the wire: which key it is on, the brush size, a name and a colour.
// Nothing you scan, flag or find is shared.
//
// Two channels, because the free Supabase plan prices them very differently:
//   Broadcast  live movement. Counted per RECIPIENT (one send to 5 players = 6 messages) against
//              a 2M/month quota, so it is sent only while the pointer actually moves, at most
//              every SEND_EVERY ms, and never while you sit still.
//   Presence   who is online, plus a SETTLED position so someone who just joined can see a
//              player who is not moving. Capped at 20 presence messages per second for the
//              whole project, so it is re-tracked only once movement stops, and rarely.
// The receiving side interpolates between updates, so ~3 updates a second still reads as smooth.
import { SUPABASE_URL, SUPABASE_KEY } from "./multiplayer-config.js";

const SUPABASE_JS = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.116.0/+esm";
const SEND_EVERY = 300;        // ms between movement broadcasts, at most
const SETTLE = 1500;           // ms of stillness before the presence position is refreshed
const RETRACK_EVERY = 5000;    // ms between presence updates, at most
const HIDDEN_GRACE = 30000;    // a background tab lets go of its connection after this long
const EASE_MS = 90;            // interpolation time constant on the receiving side
const NAME_MAX = 20;
const ME_STORE = "cuvre-player-v1";
// Never the app's own orange: that is YOUR cursor.
const COLORS = ["#4fb3ff", "#3fd68a", "#ff6b9a", "#b58cff", "#ffd84f", "#4fe0d2", "#ff8a5c", "#c7e05a"];

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const ID_RE = /^[a-z0-9]{6,24}$/;
const HEX_RE = /^[0-9a-f]{1,32}$/;

function randomId() {
  const b = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(b, (v) => v.toString(16).padStart(2, "0")).join("");
}

// The id is per page load, not persisted: two tabs of one browser must be two players, and a
// reload is simply a leave and a join. Name and colour are what persist.
const myId = randomId();
function loadMe() {
  let s = null;
  try { s = JSON.parse(localStorage.getItem(ME_STORE) || "null"); } catch (e) {}
  const name = s && typeof s.name === "string" && s.name.trim() ? s.name.trim().slice(0, NAME_MAX) : "anon-" + myId.slice(0, 4);
  const color = s && Number.isInteger(s.color) && s.color >= 0 && s.color < COLORS.length ? s.color
    : parseInt(myId.slice(4, 6), 16) % COLORS.length;
  return { name, color };
}
function saveMe(me) { try { localStorage.setItem(ME_STORE, JSON.stringify(me)); } catch (e) {} }

// ---------- transports: the same four calls over Supabase, or over a same-browser channel ----------
async function supabaseTransport(room, cb) {
  const { createClient } = await import(SUPABASE_JS);
  const client = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  let ch = null, live = false, meta = null;
  function open() {
    ch = client.channel(room, { config: { presence: { key: myId }, broadcast: { self: false } } });
    ch.on("presence", { event: "sync" }, () => {
      const out = {};
      const state = ch.presenceState();
      for (const k in state) { const list = state[k]; if (list && list.length) out[k] = list[list.length - 1]; }
      cb.peers(out);
    });
    ch.on("broadcast", { event: "pos" }, (m) => cb.move(m && m.payload));
    ch.subscribe((status) => {
      live = status === "SUBSCRIBED";
      if (live && meta) ch.track(meta);             // (re)joined: say who we are and where
      cb.status(live ? "online" : status === "CLOSED" ? "offline" : "retrying");
    });
  }
  return {
    // Never send before the join has landed: supabase-js would quietly fall back to a REST call,
    // which costs the same message and arrives out of order.
    join(m) { meta = m; if (!ch) { cb.status("connecting"); open(); } else if (live) ch.track(m); },
    update(m) { meta = m; if (live) ch.track(m); },
    move(p) { if (live) ch.send({ type: "broadcast", event: "pos", payload: p }); },
    leave() { if (ch) { const c = ch; ch = null; live = false; client.removeChannel(c); } cb.peers({}); },
  };
}

// Localhost without a Supabase project: tabs of this browser find each other. Presence is
// rebuilt by hand — hello on join, a heartbeat, bye on leave, and a timeout for tabs that die.
function localTransport(room, cb) {
  const bc = new BroadcastChannel("cuvre-mp:" + room);
  const peers = new Map();                          // id -> { meta, seen }
  let meta = null, beat = 0;
  const emit = () => { const out = {}; for (const [id, p] of peers) out[id] = p.meta; cb.peers(out); };
  bc.onmessage = (e) => {
    const m = e.data;
    if (!m || m.id === myId || !ID_RE.test(m.id || "")) return;
    if (m.t === "meta" || m.t === "hello") {
      peers.set(m.id, { meta: m.meta, seen: Date.now() }); emit();
      if (m.t === "hello" && meta) bc.postMessage({ t: "meta", id: myId, meta });   // introduce ourselves back
    } else if (m.t === "pos") {
      const p = peers.get(m.id); if (p) p.seen = Date.now();
      cb.move(m.pos);
    } else if (m.t === "bye") { if (peers.delete(m.id)) emit(); }
  };
  return {
    join(m) {
      meta = m; bc.postMessage({ t: "hello", id: myId, meta: m });
      clearInterval(beat);
      beat = setInterval(() => {
        if (meta) bc.postMessage({ t: "meta", id: myId, meta });
        let gone = false;
        for (const [id, p] of peers) if (Date.now() - p.seen > 7000) { peers.delete(id); gone = true; }
        if (gone) emit();
      }, 2500);
      cb.status("local");
    },
    update(m) { meta = m; bc.postMessage({ t: "meta", id: myId, meta: m }); },
    move(p) { bc.postMessage({ t: "pos", id: myId, pos: p }); },
    leave() { clearInterval(beat); beat = 0; bc.postMessage({ t: "bye", id: myId }); peers.clear(); cb.peers({}); },
  };
}

// ---------- the game-facing side ----------
// game: { stage, W, H, isLocal, pointer() -> {x,y,fx,fy,c,parked},
//         project(x, y, fx, fy) -> [px, py], cellPx(), travelTo(x, y) }
export async function initMultiplayer(game) {
  const configured = !!(SUPABASE_URL && SUPABASE_KEY);
  const forceLocal = new URLSearchParams(location.search).get("mp") === "local";
  const useLocal = game.isLocal && (forceLocal || !configured) && typeof BroadcastChannel === "function";
  if (!configured && !useLocal) return null;         // production without keys: no UI, no traffic

  const me = loadMe();
  const peers = new Map();                           // id -> peer
  const layer = document.createElement("div");
  layer.id = "peers";
  game.stage.appendChild(layer);
  // ---- header: online count + the players popover ----
  const wrap = document.getElementById("statOnlineWrap");
  const count = document.getElementById("statOnline");
  const menu = document.getElementById("peerMenu");
  const list = document.getElementById("pmList");
  const nameIn = document.getElementById("pmName");
  const meDot = document.getElementById("pmMeDot");
  const statusEl = document.getElementById("pmStatus");
  const STATUS_TEXT = {
    connecting: ["…", "var(--muted)", "connecting to the lobby…"],
    online: [null, "#4fb98a", "connected"],
    local: [null, "#e0b155", "local test mode — only other tabs of this browser (no Supabase)"],
    retrying: ["…", "#e0b155", "connection lost, retrying…"],
    paused: ["zz", "var(--muted)", "paused while the tab was in the background"],
    offline: ["off", "#f0616d", "multiplayer unavailable"],
  };
  let status = "connecting";
  let seq = 0;

  // ---- incoming ----
  function parsePos(p) {
    if (!p || typeof p !== "object" || typeof p.x !== "string" || typeof p.y !== "string") return null;
    if (!HEX_RE.test(p.x) || !HEX_RE.test(p.y)) return null;
    const x = BigInt("0x" + p.x), y = BigInt("0x" + p.y);
    if (x >= game.W || y >= game.H) return null;
    const f = (v) => (Number.isFinite(v) ? clamp(v, 0, 0.999) : 0);
    return { x, y, fx: f(p.fx), fy: f(p.fy), c: clamp(Math.floor(Number(p.c)) || 1, 1, 1000000),
             parked: !!p.parked, s: Number.isFinite(p.s) ? p.s : 0 };
  }
  function makePeer(id) {
    const el = document.createElement("div");
    el.className = "peer";
    el.innerHTML = '<div class="peer-pen"></div><div class="peer-dot"></div><div class="peer-tag"><span class="peer-arrow">➤</span><span class="peer-name"></span></div>';
    layer.appendChild(el);
    return { id, el, pen: el.firstChild, tag: el.lastChild, arrow: el.querySelector(".peer-arrow"), nameEl: el.querySelector(".peer-name"),
             name: "", color: -1, pos: null, ox: 0, oy: 0, s: -1, tw: 0, th: 0 };
  }
  function setPos(peer, pos) {
    if (!pos || pos.s < peer.s) return;              // a settled presence position older than the live one
    if (peer.pos) {
      // Keep the peer where it is on screen and ease the difference out, in KEY units so a zoom
      // mid-glide stays correct. A jump of more than a couple of screens is a teleport: snap.
      const ox = Number(peer.pos.x - pos.x) + peer.pos.fx - pos.fx + peer.ox;
      const oy = Number(peer.pos.y - pos.y) + peer.pos.fy - pos.fy + peer.oy;
      const span = (game.stage.clientWidth + game.stage.clientHeight) * 2 / game.cellPx();
      const far = !Number.isFinite(ox) || !Number.isFinite(oy) || Math.abs(ox) > span || Math.abs(oy) > span;
      peer.ox = far ? 0 : ox; peer.oy = far ? 0 : oy;
    }
    peer.pos = pos; peer.s = pos.s;
    animate();
  }
  function onPeers(state) {
    const alive = new Set();
    for (const id in state) {
      const m = state[id];
      if (id === myId || !ID_RE.test(id) || !m || typeof m !== "object") continue;
      alive.add(id);
      let peer = peers.get(id);
      if (!peer) { peer = makePeer(id); peers.set(id, peer); }
      const name = typeof m.name === "string" && m.name.trim() ? m.name.trim().slice(0, NAME_MAX) : "anon";
      if (name !== peer.name) { peer.name = name; peer.nameEl.textContent = name; peer.tw = 0; }   // textContent: names are untrusted
      const color = Number.isInteger(m.color) && m.color >= 0 && m.color < COLORS.length ? m.color : 0;
      if (color !== peer.color) { peer.color = color; peer.el.style.setProperty("--pc", COLORS[color]); }
      setPos(peer, parsePos(m));
    }
    for (const [id, peer] of peers) if (!alive.has(id)) { peer.el.remove(); peers.delete(id); }
    layout();
    renderStatus();
  }
  function onMove(p) {
    if (!p || typeof p.id !== "string") return;
    const peer = peers.get(p.id);                    // unknown until presence has introduced it
    if (peer) setPos(peer, parsePos(p));
  }

  // ---- drawing ----
  // The pen origin is derived exactly the way the app snaps its own brush, so a peer's square
  // sits on the grid where their click would actually dig.
  function penOrigin(pos) {
    const c = BigInt(pos.c);
    let s = 1; while (pos.c % (s * 2) === 0 && s * 2 < pos.c) s *= 2;
    const q = BigInt(s);
    const x = clamp(pos.x, 0n, game.W - c > 0n ? game.W - c : 0n), y = clamp(pos.y, 0n, game.H - c > 0n ? game.H - c : 0n);
    return [(x / q) * q, (y / q) * q];
  }
  function layout() {
    const w = game.stage.clientWidth, h = game.stage.clientHeight, cell = game.cellPx();
    for (const peer of peers.values()) {
      const p = peer.pos;
      if (!p) { peer.el.style.display = "none"; continue; }
      let [px, py] = game.project(p.x, p.y, p.fx + peer.ox, p.fy + peer.oy);
      if (!Number.isFinite(px) || !Number.isFinite(py)) { peer.el.style.display = "none"; continue; }
      peer.el.style.display = "block";
      const off = px < 0 || py < 0 || px > w || py > h;
      peer.el.classList.toggle("edge", off);
      peer.el.classList.toggle("parked", p.parked);
      if (off) {
        // Off screen: pin it to the border, pointing the way. The keyspace is 2^128 wide; without
        // this nobody would ever find anyone.
        const cx = w / 2, cy = h / 2;
        const ang = Math.atan2(py - cy, px - cx);
        if (!peer.tw) { peer.tw = peer.tag.offsetWidth; peer.th = peer.tag.offsetHeight; }   // the whole chip stays inside
        px = clamp(px, peer.tw / 2 + 6, w - peer.tw / 2 - 6); py = clamp(py, peer.th / 2 + 6, h - peer.th / 2 - 6);
        peer.arrow.style.transform = "rotate(" + ang + "rad)";
        peer.el.style.transform = "translate(" + px + "px," + py + "px)";
        continue;
      }
      peer.el.style.transform = "translate(" + px + "px," + py + "px)";
      const size = p.c * cell;
      if (!p.parked && size >= 6 && size < 4 * (w + h)) {
        const [ox, oy] = penOrigin(p);
        const [qx, qy] = game.project(ox, oy, peer.ox, peer.oy);
        peer.pen.style.display = "block";
        peer.pen.style.transform = "translate(" + (qx - px) + "px," + (qy - py) + "px)";
        peer.pen.style.width = peer.pen.style.height = size + "px";
      } else peer.pen.style.display = "none";
    }
  }
  let raf = 0, lastT = 0;
  function animate() {
    if (raf) return;
    lastT = performance.now();
    raf = requestAnimationFrame(function step(now) {
      raf = 0;
      const k = Math.exp(-(now - lastT) / EASE_MS);
      lastT = now;
      const eps = 0.3 / Math.max(game.cellPx(), 1e-300);   // under a third of a pixel is done
      let moving = false;
      for (const peer of peers.values()) {
        peer.ox *= k; peer.oy *= k;
        if (Math.abs(peer.ox) < eps) peer.ox = 0;
        if (Math.abs(peer.oy) < eps) peer.oy = 0;
        if (peer.ox || peer.oy) moving = true;
      }
      layout();
      if (moving) raf = requestAnimationFrame(step);
    });
  }

  // ---- outgoing ----
  let lastSig = "", lastSend = 0, trailTimer = 0, settleTimer = 0, lastTrack = 0, trackedSig = "";
  let current = null;
  function snapshot() {
    const p = game.pointer();
    const cell = game.cellPx();
    const q = cell >= 8 ? 16 : 1;                    // sub-key precision only once a key is big enough to see
    const fx = Math.floor(p.fx * q) / q, fy = Math.floor(p.fy * q) / q;
    const out = { x: p.x.toString(16), y: p.y.toString(16), fx, fy, c: p.c, parked: !!p.parked };
    return { out, sig: out.x + "," + out.y + "," + fx + "," + fy + "," + out.c + "," + out.parked };
  }
  const metaOf = () => (current ? { ...current, name: me.name, color: me.color } : { name: me.name, color: me.color });
  function flush() {
    trailTimer = 0;
    if (!transport || !joined) return;
    const { out, sig } = snapshot();
    if (sig === lastSig) return;
    lastSig = sig; lastSend = performance.now();
    current = { ...out, s: ++seq };
    transport.move({ id: myId, ...current });
    clearTimeout(settleTimer);
    settleTimer = setTimeout(settle, SETTLE);
  }
  function settle() {
    settleTimer = 0;
    if (!transport || !joined || lastSig === trackedSig) return;
    const wait = RETRACK_EVERY - (performance.now() - lastTrack);
    if (wait > 0) { settleTimer = setTimeout(settle, wait); return; }
    trackedSig = lastSig; lastTrack = performance.now();
    transport.update(metaOf());
  }
  // called by the app whenever its pointer or camera may have moved — cheap when nothing did
  function pointerMoved() {
    if (!joined || trailTimer) return;
    const wait = SEND_EVERY - (performance.now() - lastSend);
    if (wait <= 0) flush(); else trailTimer = setTimeout(flush, wait);
  }

  // ---- connection lifecycle ----
  let transport = null, joined = false, hideTimer = 0;
  const cb = { peers: onPeers, move: onMove, status: (s) => { status = s; renderStatus(); } };
  renderStatus();                                    // "…" while supabase-js downloads
  try {
    transport = useLocal ? localTransport("dev", cb)
                         : await supabaseTransport(game.isLocal ? "keyspace-dev" : "keyspace", cb);
  } catch (e) {
    status = "offline"; renderStatus();
    console.warn("multiplayer unavailable:", e);
    return null;
  }
  function join() {
    if (joined) return;
    joined = true;
    const { out, sig } = snapshot();
    current = { ...out, s: ++seq }; lastSig = trackedSig = sig; lastTrack = performance.now();
    transport.join(metaOf());
  }
  function leave(paused) {
    if (!joined) return;
    joined = false;
    clearTimeout(trailTimer); trailTimer = 0; clearTimeout(settleTimer); settleTimer = 0;
    transport.leave();
    if (paused) { status = "paused"; renderStatus(); }
  }
  // A tab in the background still holds one of the free plan's 200 connections. Give it back
  // after a while and rejoin the moment the tab is looked at again.
  document.addEventListener("visibilitychange", () => {
    clearTimeout(hideTimer);
    if (document.hidden) hideTimer = setTimeout(() => leave(true), HIDDEN_GRACE);
    else join();
  });
  window.addEventListener("pagehide", () => leave(false));
  window.addEventListener("pageshow", (e) => { if (e.persisted && !document.hidden) join(); });   // back from the bfcache
  join();

  // ---- header: the online count and the players popover ----
  function renderStatus() {
    if (!wrap) return;
    wrap.hidden = false;
    const [txt, color, desc] = STATUS_TEXT[status] || STATUS_TEXT.offline;
    const n = peers.size + 1;
    count.textContent = txt || String(n);
    count.style.color = color;
    wrap.title = desc + (txt ? "" : " · " + n + " player" + (n > 1 ? "s" : "") + " on the map (you included) — click for the list");
    statusEl.textContent = desc + (txt ? "" : " · " + n + " online");
    if (!menu.hidden) renderList();
  }
  function renderList() {
    list.textContent = "";
    if (!peers.size) {
      const empty = document.createElement("div");
      empty.className = "pm-empty";
      empty.textContent = status === "local" ? "open this page in another tab to see a second player" : "nobody else here yet";
      list.appendChild(empty);
      return;
    }
    const w = game.stage.clientWidth, h = game.stage.clientHeight;
    for (const peer of peers.values()) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "pm-row";
      const dot = document.createElement("span");
      dot.className = "pm-dot"; dot.style.background = COLORS[peer.color] || COLORS[0];
      const nm = document.createElement("span");
      nm.className = "pm-name"; nm.textContent = peer.name;
      const where = document.createElement("span");
      where.className = "pm-where";
      if (peer.pos) {
        const [px, py] = game.project(peer.pos.x, peer.pos.y, peer.pos.fx, peer.pos.fy);
        where.textContent = px >= 0 && py >= 0 && px <= w && py <= h ? "on screen" : "fly there →";
        row.addEventListener("click", () => { openMenu(false); game.travelTo(peer.pos.x, peer.pos.y); });
      } else { where.textContent = "—"; row.disabled = true; }
      row.append(dot, nm, where);
      list.appendChild(row);
    }
  }
  function openMenu(on) {
    menu.hidden = !on;
    wrap.classList.toggle("on", on);
    if (!on) return;
    const r = wrap.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - menu.offsetWidth - 8)) + "px";
    menu.style.top = r.bottom + 8 + "px";
    nameIn.value = me.name;
    renderList();
  }
  function syncMe() {
    meDot.style.background = COLORS[me.color];
    meDot.title = "your colour — click to change";
  }
  wrap.addEventListener("click", (e) => { e.stopPropagation(); openMenu(menu.hidden); });
  document.addEventListener("click", (e) => { if (!menu.hidden && !menu.contains(e.target)) openMenu(false); });
  window.addEventListener("keydown", (e) => { if (e.key === "Escape" && !menu.hidden) openMenu(false); });
  // Name and colour are rare, deliberate changes: they go out straight away, not on the settle timer.
  nameIn.addEventListener("change", () => {
    const v = nameIn.value.trim().slice(0, NAME_MAX);
    me.name = v || "anon-" + myId.slice(0, 4);
    nameIn.value = me.name;
    saveMe(me);
    if (joined) { lastTrack = performance.now(); transport.update(metaOf()); }
  });
  nameIn.addEventListener("keydown", (e) => { if (e.key === "Enter") nameIn.blur(); });
  meDot.addEventListener("click", () => {
    me.color = (me.color + 1) % COLORS.length;
    saveMe(me); syncMe();
    if (joined) { lastTrack = performance.now(); transport.update(metaOf()); }
  });
  syncMe();
  renderStatus();

  return { layout, pointerMoved };
}
