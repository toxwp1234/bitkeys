"use strict";
// ---------- multiplayer: see the other players, and what they have dug ----------
// Two levels, because the keyspace is 2^128 wide and a global channel for everything would be
// both useless and unaffordable:
//
//   LOBBY   one channel for the whole game, Presence only. Who is online, their name, colour and
//           a settled position, so the players popover can say "fly there →". This is how you
//           find anybody at all in a space where nobody is ever accidentally nearby.
//   TILE    one channel per TILE of the map (2^TILE_BITS keys a side). You are on exactly one at
//           a time, the one you are looking at. It carries the live cursors and the dug blocks.
//           Four players standing in the same place share ONE channel — no pair-wise mesh.
//
// "Near each other" therefore means "on the same tile", which is also literally "on the same
// channel": there is no separate proximity check to keep in sync with the traffic.
//
// Free-plan pricing shapes all of it. Broadcast is counted per RECIPIENT against 2M/month, so:
// nothing is ever sent on a timer, movement goes out at most every SEND_EVERY ms and only while
// the pointer really moves, and NOTHING at all is sent while you are alone on your tile.
// Presence is capped at 20 messages/second project-wide, so it is re-tracked only once movement
// has stopped, and rarely.
//
// Blocks other players dug are display only: they are drawn, they are not yours. They never
// touch keysScanned, the found counter or pen progression, they are not saved, and they live
// only as long as you stay on that tile.
import { SUPABASE_URL, SUPABASE_KEY } from "./multiplayer-config.js";

const SUPABASE_JS = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.116.0/+esm";
const SEND_EVERY = 300;        // ms between movement broadcasts, at most
const SETTLE = 1500;           // ms of stillness before the presence position is refreshed
const RETRACK_EVERY = 5000;    // ms between presence updates, at most
const HIDDEN_GRACE = 30000;    // a background tab lets go of its connection after this long
const EASE_MS = 90;            // interpolation time constant on the receiving side
const NAME_MAX = 20;
const ME_STORE = "cuvre-player-v1";
const ALPHA_STORE = "cuvre-peer-alpha-v1";
// How other players' squares are painted on your map. "faded" and "solid" both carry the owner's
// colour, so you can always tell whose ground you are looking at; "palette" drops that and runs
// them through your own heat ramp exactly like your own squares, which is the only way the map
// reads as one picture instead of two. The app owns the ramp, so the choice is passed to it.
const PEER_MODES = ["faded", "solid", "palette"];
const BUSY_TTL = 60000;        // forget a peer's "digging here" marker if nothing ends it
const MAX_BRUSH = 1000000;     // the app's own brush cap once the slider is unlocked (app.js penCap)
// A tile is 2^64 keys a side — 1.8e19 of them across the map, so two players share one only
// when they meant to, and once they do it takes a deliberate journey to leave it again.
// It is deliberately huge: at any but the deepest zoom, one screen pixel is already millions of
// keys, so a small tile would change under the cursor faster than a channel can be subscribed.
const TILE_BITS = 64n;
const TILE_SPAN = Math.pow(2, 64);   // the same size as a float, to compare against the viewport
const TILE_SETTLE = 1200;      // ms on a new tile before we actually switch channel (no flapping)
const BULK_CHUNK = 600;        // blocks per bulk message — the payload cap is 256 KB
const PEER_PATCH_CAP = 4000;   // per peer, per tile; a flood cannot grow our memory without bound
const REPLY_DELAY = 400;       // ms to coalesce "someone new arrived, send them my blocks"
const EVENTS = ["pos", "dig", "bulk", "busy"];
// Never the app's own orange: that is YOUR cursor.
const COLORS = ["#4fb3ff", "#3fd68a", "#ff6b9a", "#b58cff", "#ffd84f", "#4fe0d2", "#ff8a5c", "#c7e05a"];

// ?mpdebug=1 narrates the channel work in the console: which region channel you are on and every
// block that goes out or comes in. Silent otherwise, so it costs production nothing.
const DBG = new URLSearchParams(location.search).has("mpdebug");
const dbg = (...a) => { if (DBG) console.log("[mp]", ...a); };

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
function loadAlphaMode() {
  let s = null;
  try { s = localStorage.getItem(ALPHA_STORE); } catch (e) {}
  return PEER_MODES.indexOf(s) >= 0 ? s : "faded";
}

// ---------- transports ----------
// One interface, two implementations. A transport hands out CHANNELS; each channel is
// { track(meta), send(event, payload), close() } and reports back through
// { presence(state), message(event, payload), status(s) }. Everything above this line is
// written once and runs over either. Adding a feature means adding an event, not a transport.
async function supabaseTransport() {
  const { createClient } = await import(SUPABASE_JS);
  const client = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  return {
    // supabase-js multiplexes every channel over ONE websocket, so the lobby and the tile
    // together still cost a single one of the free plan's 200 connections.
    channel(room, h) {
      let live = false, meta = null;
      const ch = client.channel(room, { config: { presence: { key: myId }, broadcast: { self: false } } });
      ch.on("presence", { event: "sync" }, () => {
        const out = {};
        const state = ch.presenceState();
        for (const k in state) { const list = state[k]; if (list && list.length) out[k] = list[list.length - 1]; }
        h.presence(out);
      });
      for (const ev of EVENTS) ch.on("broadcast", { event: ev }, (m) => h.message(ev, m && m.payload));
      ch.subscribe((status) => {
        live = status === "SUBSCRIBED";
        if (live && meta) ch.track(meta);            // (re)joined: say who we are and where
        h.status(live ? "online" : status === "CLOSED" ? "offline" : "retrying");
      });
      return {
        track(m) { meta = m; if (live) ch.track(m); },
        // Never send before the join has landed: supabase-js would quietly fall back to a REST
        // call, which costs the same message and arrives out of order.
        send(ev, p) { if (live) ch.send({ type: "broadcast", event: ev, payload: p }); },
        close() { live = false; client.removeChannel(ch); },
      };
    },
    close() { client.removeAllChannels(); },
  };
}

// Localhost without a Supabase project: tabs of this browser find each other. Presence is
// rebuilt by hand — hello on join, a heartbeat, bye on leave, and a timeout for tabs that die.
function localTransport() {
  return {
    channel(room, h) {
      const bc = new BroadcastChannel("cuvre-mp:" + room);
      const peers = new Map();                       // id -> { meta, seen }
      let meta = null, beat = 0;
      const emit = () => { const out = {}; for (const [id, p] of peers) out[id] = p.meta; h.presence(out); };
      bc.onmessage = (e) => {
        const m = e.data;
        if (!m || m.id === myId || !ID_RE.test(m.id || "")) return;
        if (m.t === "meta" || m.t === "hello") {
          peers.set(m.id, { meta: m.meta, seen: Date.now() }); emit();
          if (m.t === "hello" && meta) bc.postMessage({ t: "meta", id: myId, meta });   // introduce ourselves back
        } else if (m.t === "ev") {
          const p = peers.get(m.id); if (p) p.seen = Date.now();
          h.message(m.ev, m.payload);
        } else if (m.t === "bye") { if (peers.delete(m.id)) emit(); }
      };
      beat = setInterval(() => {
        if (meta) bc.postMessage({ t: "meta", id: myId, meta });
        let gone = false;
        for (const [id, p] of peers) if (Date.now() - p.seen > 7000) { peers.delete(id); gone = true; }
        if (gone) emit();
      }, 2500);
      // Asynchronously, so a caller can finish wiring the handle up before it is told it is live.
      setTimeout(() => h.status("local"), 0);
      return {
        track(m) { const first = !meta; meta = m; bc.postMessage({ t: first ? "hello" : "meta", id: myId, meta: m }); },
        send(ev, p) { bc.postMessage({ t: "ev", ev, id: myId, payload: p }); },
        close() { clearInterval(beat); bc.postMessage({ t: "bye", id: myId }); bc.close(); peers.clear(); },
      };
    },
    close() {},
  };
}

// ---------- the game-facing side ----------
// game: { stage, W, H, isLocal, pointer() -> {x,y,fx,fy,c,parked},
//         project(x, y, fx, fy) -> [px, py], cellPx(), travelTo(x, y),
//         myPatches() -> [{x,y,c,h}], showPeerPatches(list) }
export async function initMultiplayer(game) {
  const configured = !!(SUPABASE_URL && SUPABASE_KEY);
  const forceLocal = new URLSearchParams(location.search).get("mp") === "local";
  const useLocal = game.isLocal && (forceLocal || !configured) && typeof BroadcastChannel === "function";
  if (!configured && !useLocal) return null;         // production without keys: no UI, no traffic

  const me = loadMe();
  let alphaMode = loadAlphaMode();                   // how solid other players' squares are drawn
  const peers = new Map();                           // id -> peer (everyone online, lobby-wide)
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
  const alphaBtns = Array.from(document.querySelectorAll("#pmAlpha button"));
  const listLabel = document.getElementById("pmListLabel");
  const listHint = document.getElementById("pmListHint");
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

  // ---- incoming: cursors ----
  function parsePos(p) {
    if (!p || typeof p !== "object" || typeof p.x !== "string" || typeof p.y !== "string") return null;
    if (!HEX_RE.test(p.x) || !HEX_RE.test(p.y)) return null;
    const x = BigInt("0x" + p.x), y = BigInt("0x" + p.y);
    if (x >= game.W || y >= game.H) return null;
    const f = (v) => (Number.isFinite(v) ? clamp(v, 0, 0.999) : 0);
    return { x, y, fx: f(p.fx), fy: f(p.fy), c: clamp(Math.floor(Number(p.c)) || 1, 1, MAX_BRUSH),
             parked: !!p.parked, s: Number.isFinite(p.s) ? p.s : 0 };
  }
  function makePeer(id) {
    const el = document.createElement("div");
    el.className = "peer";
    el.innerHTML = '<div class="peer-pen"></div><div class="peer-dot"></div><div class="peer-tag"><span class="peer-arrow">➤</span><span class="peer-name"></span></div>';
    layer.appendChild(el);
    return { id, el, pen: el.firstChild, tag: el.lastChild, arrow: el.querySelector(".peer-arrow"), nameEl: el.querySelector(".peer-name"),
             name: "", color: -1, pos: null, ox: 0, oy: 0, s: -1, tw: 0, th: 0, near: false };
  }
  function peerFor(id) {
    let peer = peers.get(id);
    if (!peer) { peer = makePeer(id); peers.set(id, peer); }
    return peer;
  }
  function applyMeta(peer, m) {
    const name = typeof m.name === "string" && m.name.trim() ? m.name.trim().slice(0, NAME_MAX) : "anon";
    if (name !== peer.name) { peer.name = name; peer.nameEl.textContent = name; peer.tw = 0; }   // textContent: names are untrusted
    const color = Number.isInteger(m.color) && m.color >= 0 && m.color < COLORS.length ? m.color : 0;
    if (color !== peer.color) { peer.color = color; peer.el.style.setProperty("--pc", COLORS[color]); pushPatches(); pushBusy(); }
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
  // The lobby owns the roster: it is the only thing that creates and removes players.
  function onLobbyPeers(state) {
    const alive = new Set();
    for (const id in state) {
      const m = state[id];
      if (id === myId || !ID_RE.test(id) || !m || typeof m !== "object") continue;
      alive.add(id);
      const peer = peerFor(id);
      applyMeta(peer, m);
      setPos(peer, parsePos(m));
    }
    for (const [id, peer] of peers) if (!alive.has(id)) { peer.el.remove(); peers.delete(id); forgetPeerPatches(id); }
    layout();
    renderStatus();
  }
  // The tile channel owns who is NEAR: only those get a cursor drawn and exchange blocks.
  function onTilePeers(state) {
    const near = new Set();
    for (const id in state) {
      const m = state[id];
      if (id === myId || !ID_RE.test(id) || !m || typeof m !== "object") continue;
      near.add(id);
      const peer = peerFor(id);
      applyMeta(peer, m);                            // usable even if the lobby sync is lagging
      if (!peer.near) peer.near = true;
      setPos(peer, parsePos(m));
    }
    for (const [id, peer] of peers) {
      if (near.has(id) || !peer.near) continue;
      peer.near = false;                             // walked off our tile: cursor and blocks go
      forgetPeerPatches(id);
    }
    nearIds = near;
    layout();
    renderStatus();
  }
  function onMove(p) {
    if (!p || typeof p.id !== "string") return;
    const peer = peers.get(p.id);                    // unknown until presence has introduced it
    if (peer && peer.near) setPos(peer, parsePos(p));
  }

  // ---- incoming: dug blocks ----
  // Everything here is untrusted. A block is four numbers and nothing else; it is drawn and never
  // counted, so the worst a liar can do is paint squares on your screen until you leave the tile.
  const peerPatches = new Map();                     // id -> Map("xhex,yhex,c" -> {x,y,c,h})
  const peerBusy = new Map();                        // id -> {x,y,c,at} — the square they are drilling NOW
  let nearIds = new Set();
  const colorOf = (id) => { const p = peers.get(id); return COLORS[p && p.color >= 0 ? p.color : 0]; };
  function parseSquare(xs, ys, c) {
    if (typeof xs !== "string" || typeof ys !== "string" || !HEX_RE.test(xs) || !HEX_RE.test(ys)) return null;
    const n = Math.floor(Number(c));
    // A brush is NOT a power of two. The 1..8 presets are, but the slider that unlocks after them
    // hands out any whole number up to the app's own cap — so this used to silently drop every
    // square and every drill marker from anyone digging at, say, 586, and the sender had no way
    // to tell. Range is the only shape rule there is; the coordinate checks and PEER_PATCH_CAP
    // do the rest.
    if (!Number.isFinite(n) || n < 1 || n > MAX_BRUSH) return null;
    const x = BigInt("0x" + xs), y = BigInt("0x" + ys);
    if (x >= game.W || y >= game.H) return null;
    return { key: xs + "," + ys + "," + n, x, y, c: n };
  }
  function parsePatch(a) {
    if (!Array.isArray(a) || a.length < 3) return null;
    const p = parseSquare(a[0], a[1], a[2]);
    if (!p) return null;
    // h is how many keys the sender's Bloom filter flagged in that square. It is what tints the
    // square in your own palette, and it is a count of maybes — no key, no address, no balance.
    const h = Math.floor(Number(a[3]));
    p.h = Number.isFinite(h) && h > 0 ? Math.min(h, p.c * p.c) : 0;
    return p;
  }
  function takePatches(id, arr) {
    if (!Array.isArray(arr) || !arr.length) return false;
    let mine = peerPatches.get(id);
    if (!mine) { mine = new Map(); peerPatches.set(id, mine); }
    let added = false;
    for (const a of arr) {
      if (mine.size >= PEER_PATCH_CAP) break;
      const p = parsePatch(a);
      if (!p) continue;
      const old = mine.get(p.key);
      if (old && old.h === p.h) continue;
      mine.set(p.key, p);
      added = true;
    }
    return added;
  }
  function forgetPeerPatches(id) {
    const had = peerPatches.delete(id);
    if (peerBusy.delete(id)) pushBusy();
    if (had) pushPatches();
  }
  // The owner's colour is attached here rather than stored per square, so a peer changing colour
  // — or you changing how their ground is painted — is one push, not a sweep.
  function pushPatches() {
    if (!game.showPeerPatches) return;
    const out = [];
    for (const [id, mine] of peerPatches) {
      const color = colorOf(id);
      for (const p of mine.values()) out.push({ x: p.x, y: p.y, c: p.c, h: p.h, color });
    }
    dbg("squares on map:", out.length);
    game.showPeerPatches(out, alphaMode);
  }
  function pushBusy() {
    if (!game.showPeerBusy) return;
    const now = Date.now();
    const out = [];
    for (const [id, b] of peerBusy) {
      if (now - b.at > BUSY_TTL) { peerBusy.delete(id); continue; }   // a scan that never reported back
      out.push({ x: b.x, y: b.y, c: b.c, color: colorOf(id) });
    }
    dbg("drills on map:", out.length);
    game.showPeerBusy(out);
  }
  function clearPeerPatches() {
    if (peerPatches.size) { peerPatches.clear(); pushPatches(); }
    if (peerBusy.size) { peerBusy.clear(); pushBusy(); }
  }

  // My own blocks inside the tile I am on, as the wire sees them.
  function myTilePatches(tx, ty) {
    const out = [];
    const src = (game.myPatches && game.myPatches()) || [];
    for (const p of src) {
      if ((p.x >> TILE_BITS) !== tx || (p.y >> TILE_BITS) !== ty) continue;
      out.push([p.x.toString(16), p.y.toString(16), p.c, p.h || 0]);
    }
    return out;
  }
  // Sent when we arrive on a tile, and again — once, addressed with `re` — when somebody else
  // arrives after us. `re` is what stops the two sides bouncing bulks off each other forever.
  function sendBulk(re) {
    if (!tileCh || tileX === null) return;
    const all = myTilePatches(tileX, tileY);
    for (let i = 0; i < all.length || i === 0; i += BULK_CHUNK) {
      const ps = all.slice(i, i + BULK_CHUNK);
      if (!ps.length && i > 0) break;
      dbg("bulk ->", ps.length + " blocks", re ? "(reply to " + re + ")" : "(arrival)");
      // A drill already running when somebody arrives has no other way of reaching them: `busy`
      // went out once, before they were on the channel. So the greeting carries it too.
      const b = i === 0 && myBusy ? [myBusy.x.toString(16), myBusy.y.toString(16), myBusy.c] : null;
      tileCh.send("bulk", { id: myId, re: re || "", ps, b });
    }
  }
  let replyTimer = 0, served = new Set();
  function serveNewcomer(id) {
    if (served.has(id)) return;
    served.add(id);
    if (replyTimer) return;
    replyTimer = setTimeout(() => { replyTimer = 0; sendBulk(id); }, REPLY_DELAY);
  }
  // Being ON the tile channel is the proximity check — a message cannot reach us from anywhere
  // else — so there is no second "is this peer near?" test here to drift out of sync with it.
  function onBulk(p) {
    dbg("bulk <-", p && p.id, (p && p.ps && p.ps.length) + " blocks", p && p.re ? "(reply)" : "(arrival)");
    if (!p || typeof p.id !== "string" || !ID_RE.test(p.id) || p.id === myId) return;
    if (takePatches(p.id, p.ps)) pushPatches();
    const b = Array.isArray(p.b) ? parseSquare(p.b[0], p.b[1], p.b[2]) : null;
    if (b) { peerBusy.set(p.id, { x: b.x, y: b.y, c: b.c, at: Date.now() }); pushBusy(); }
    if (p.re === myId) served.add(p.id);                       // this WAS the answer to our arrival
    else serveNewcomer(p.id);                                    // they just arrived — hand them ours
  }
  function onDig(p) {
    dbg("dig <-", p && p.x + "," + p.y);
    if (!p || typeof p.id !== "string" || !ID_RE.test(p.id) || p.id === myId) return;
    // A finished square is its own "I am done here" — no second message needed to take the
    // drilling marker down.
    if (peerBusy.delete(p.id)) pushBusy();
    if (takePatches(p.id, [[p.x, p.y, p.c, p.h]])) pushPatches();
  }
  function onBusy(p) {
    if (!p || typeof p.id !== "string" || !ID_RE.test(p.id) || p.id === myId) return;
    const q = p.x === undefined ? null : parseSquare(p.x, p.y, p.c);
    dbg("busy <-", p.id, q ? q.x + "," + q.y : "cleared");
    if (q) peerBusy.set(p.id, { x: q.x, y: q.y, c: q.c, at: Date.now() });
    else if (!peerBusy.delete(p.id)) return;
    pushBusy();
  }
  // Called by the app when a scan of ours has committed. Free when nobody is watching.
  function dug(patch) {
    myBusy = null;                                   // the dig message below says it for us
    if (!tileCh || !joined || !nearIds.size) return;
    if ((patch.x >> TILE_BITS) !== tileX || (patch.y >> TILE_BITS) !== tileY) return;
    dbg("dig ->", patch.x + "," + patch.y, "c" + patch.c);
    tileCh.send("dig", { id: myId, x: patch.x.toString(16), y: patch.y.toString(16), c: patch.c, h: patch.h || 0 });
  }
  // Called the moment a scan STARTS, and with null when one is abandoned. Two people digging the
  // same square is the one thing this whole feature exists to prevent, and a 65,536-key dig is
  // long enough that "it will show up when it finishes" is far too late to be useful.
  let myBusy = null;
  function digging(q) {
    if (!q) {
      if (!myBusy) return;
      myBusy = null;
      if (tileCh && joined && nearIds.size) tileCh.send("busy", { id: myId });
      return;
    }
    if ((q.x >> TILE_BITS) !== tileX || (q.y >> TILE_BITS) !== tileY) { myBusy = null; return; }
    myBusy = q;
    if (!tileCh || !joined || !nearIds.size) return;
    dbg("busy ->", q.x + "," + q.y, "c" + q.c);
    tileCh.send("busy", { id: myId, x: q.x.toString(16), y: q.y.toString(16), c: q.c });
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
    // The camera moving is what changes which region you are in — a zoom with the mouse held
    // still counts. layout() runs on every frame the map redraws, which is exactly that.
    if (joined) checkTile();
    const w = game.stage.clientWidth, h = game.stage.clientHeight, cell = game.cellPx();
    for (const peer of peers.values()) {
      const p = peer.pos;
      // Only players on our tile are drawn. Everyone else exists in the popover, which is how
      // you go and find them; painting an arrow for a player 2^100 keys away is noise.
      if (!p || !peer.near) { peer.el.style.display = "none"; continue; }
      let [px, py] = game.project(p.x, p.y, p.fx + peer.ox, p.fy + peer.oy);
      if (!Number.isFinite(px) || !Number.isFinite(py)) { peer.el.style.display = "none"; continue; }
      peer.el.style.display = "block";
      const off = px < 0 || py < 0 || px > w || py > h;
      peer.el.classList.toggle("edge", off);
      peer.el.classList.toggle("parked", p.parked);
      if (off) {
        // Off screen but on our tile: pin it to the border, pointing the way.
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
    if (!joined) return;
    const { out, sig } = snapshot();
    if (sig === lastSig) return;
    lastSig = sig; lastSend = performance.now();
    current = { ...out, s: ++seq };
    // Alone on the tile? Then a broadcast has no recipients and buys nothing. Presence still
    // carries the settled position, so whoever arrives later sees where we are standing.
    if (tileCh && nearIds.size) tileCh.send("pos", { id: myId, ...current });
    clearTimeout(settleTimer);
    settleTimer = setTimeout(settle, SETTLE);
  }
  function settle() {
    settleTimer = 0;
    if (!joined || lastSig === trackedSig) return;
    const wait = RETRACK_EVERY - (performance.now() - lastTrack);
    if (wait > 0) { settleTimer = setTimeout(settle, wait); return; }
    trackedSig = lastSig; lastTrack = performance.now();
    const m = metaOf();
    if (lobbyCh) lobbyCh.track(m);
    if (tileCh) tileCh.track(m);
  }
  // called by the app whenever its pointer or camera may have moved — cheap when nothing did
  function pointerMoved() {
    if (!joined) return;
    checkTile();
    if (trailTimer) return;
    const wait = SEND_EVERY - (performance.now() - lastSend);
    if (wait <= 0) flush(); else trailTimer = setTimeout(flush, wait);
  }

  // ---- tiles: which channel we belong on ----
  const base = game.isLocal ? "keyspace-dev" : "keyspace";
  let tileCh = null, tileX = null, tileY = null, tileTimer = 0;
  // Which tile we are on is decided by the CAMERA, never by the cursor: the cursor crosses
  // 10^36 keys per pixel when you are zoomed out, and a channel cannot follow that. Zoomed out
  // far enough that the screen is wider than a whole tile, you are nowhere in particular —
  // there is no "here" to share, so we hold no tile channel at all and cost nothing.
  function tileOf() {
    const v = game.view();
    if (!v || !(v.span < TILE_SPAN)) return [null, null];
    return [v.cx >> TILE_BITS, v.cy >> TILE_BITS];
  }
  function openTile(tx, ty) {
    if (tileCh) { tileCh.close(); tileCh = null; }
    for (const peer of peers.values()) peer.near = false;
    nearIds = new Set();
    clearPeerPatches();
    served = new Set();
    clearTimeout(replyTimer); replyTimer = 0;
    tileX = tx; tileY = ty;
    layout();
    if (tx === null) { dbg("openTile none"); renderStatus(); return; }   // looking at the whole map: nowhere to be
    const room = base + "-t" + tx.toString(16) + "_" + ty.toString(16);
    dbg("openTile", room);
    const mine = tileCh = transport.channel(room, {
      presence: onTilePeers,
      message: (ev, p) => {
        if (ev === "pos") onMove(p);
        else if (ev === "dig") onDig(p);
        else if (ev === "bulk") onBulk(p);
        else if (ev === "busy") onBusy(p);
      },
      status: (s) => { if ((s === "online" || s === "local") && tileCh === mine) sendBulk(""); },
    });
    tileCh.track(metaOf());
  }
  // Switching channel costs a subscribe and a bulk, so a cursor skimming over a tile border must
  // not do it. Only a tile we are still on after TILE_SETTLE ms counts.
  function checkTile() {
    const [tx, ty] = tileOf();
    if (tx === tileX && ty === tileY) { clearTimeout(tileTimer); tileTimer = 0; return; }
    if (tileTimer) return;
    tileTimer = setTimeout(() => {
      tileTimer = 0;
      const [nx, ny] = tileOf();
      if (nx !== tileX || ny !== tileY) openTile(nx, ny);
    }, TILE_SETTLE);
  }

  // ---- connection lifecycle ----
  let transport = null, lobbyCh = null, joined = false, hideTimer = 0;
  renderStatus();                                    // "…" while supabase-js downloads
  try {
    transport = useLocal ? localTransport() : await supabaseTransport();
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
    lobbyCh = transport.channel(base, {
      presence: onLobbyPeers,
      message: () => {},                             // the lobby is presence only, by design
      status: (s) => { status = s; renderStatus(); },
    });
    lobbyCh.track(metaOf());
    const [tx, ty] = tileOf();
    openTile(tx, ty);
  }
  function leave(paused) {
    if (!joined) return;
    joined = false;
    clearTimeout(trailTimer); trailTimer = 0;
    clearTimeout(settleTimer); settleTimer = 0;
    clearTimeout(tileTimer); tileTimer = 0;
    clearTimeout(replyTimer); replyTimer = 0;
    if (tileCh) { tileCh.close(); tileCh = null; }
    if (lobbyCh) { lobbyCh.close(); lobbyCh = null; }
    tileX = tileY = null;
    nearIds = new Set();
    for (const peer of peers.values()) peer.el.remove();
    peers.clear();
    clearPeerPatches();
    layout();
    if (paused) { status = "paused"; }
    renderStatus();
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
    const near = nearIds.size;
    count.textContent = txt || String(n);
    count.style.color = color;
    // Zoomed out far enough and you are nowhere in particular, so there is nobody to be "here"
    // with. Say so, otherwise an empty map reads as a broken connection.
    const where = near ? " · " + near + " here with you"
      : tileX === null && status === "online" ? " · zoom in to meet anyone" : "";
    wrap.title = desc + (txt ? "" : " · " + n + " player" + (n > 1 ? "s" : "") + " on the map (you included)" + where + " — click for the list");
    statusEl.textContent = desc + (txt ? "" : " · " + n + " online" + where);
    if (!menu.hidden) renderList();
  }
  function renderList() {
    list.textContent = "";
    if (listLabel) listLabel.textContent = peers.size ? "players · " + peers.size + " besides you" : "players";
    if (listHint) listHint.hidden = !peers.size;
    if (!peers.size) {
      const empty = document.createElement("div");
      empty.className = "pm-empty";
      empty.textContent = status === "local" ? "open this page in another tab to see a second player"
        : tileX === null ? "zoom in first — at this distance nobody is anywhere in particular"
        : "nobody else here yet";
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
      if (peer.pos) {
        const [px, py] = game.project(peer.pos.x, peer.pos.y, peer.pos.fx, peer.pos.fy);
        const onScreen = peer.near && px >= 0 && py >= 0 && px <= w && py <= h;
        // The right-hand chip is the whole affordance: a row that only said "on screen" gave
        // no hint that clicking it flies you across 2^128 keys.
        where.className = onScreen ? "pm-here" : "pm-go";
        where.textContent = onScreen ? "● here" : "fly there →";
        row.title = (peer.near ? "on your patch of the map — you can see each other's cursors and squares"
                               : "elsewhere on the map") + " · click to fly to " + peer.name;
        row.addEventListener("click", () => { openMenu(false); game.travelTo(peer.pos.x, peer.pos.y); });
      } else { where.className = "pm-go"; where.textContent = "—"; row.disabled = true; }
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
  const MODE_TITLE = {
    faded: "their colour, faded — your own territory reads first",
    solid: "their colour, solid — you can still tell whose ground it is",
    palette: "your own palette, tinted by what the square turned up — the map reads as one picture, "
           + "but nothing on it says who dug what",
  };
  function syncAlpha() {
    for (const b of alphaBtns) {
      b.classList.toggle("on", b.dataset.alpha === alphaMode);
      b.title = MODE_TITLE[b.dataset.alpha] || "";
    }
  }
  for (const b of alphaBtns) b.addEventListener("click", () => {
    const m = b.dataset.alpha;
    if (m === alphaMode || PEER_MODES.indexOf(m) < 0) return;
    alphaMode = m;
    try { localStorage.setItem(ALPHA_STORE, alphaMode); } catch (e) {}
    syncAlpha();
    pushPatches();
  });
  wrap.addEventListener("click", (e) => { e.stopPropagation(); openMenu(menu.hidden); });
  document.addEventListener("click", (e) => { if (!menu.hidden && !menu.contains(e.target)) openMenu(false); });
  window.addEventListener("keydown", (e) => { if (e.key === "Escape" && !menu.hidden) openMenu(false); });
  // Name and colour are rare, deliberate changes: they go out straight away, not on the settle timer.
  function trackNow() {
    if (!joined) return;
    lastTrack = performance.now();
    const m = metaOf();
    if (lobbyCh) lobbyCh.track(m);
    if (tileCh) tileCh.track(m);
  }
  nameIn.addEventListener("change", () => {
    const v = nameIn.value.trim().slice(0, NAME_MAX);
    me.name = v || "anon-" + myId.slice(0, 4);
    nameIn.value = me.name;
    saveMe(me);
    trackNow();
  });
  nameIn.addEventListener("keydown", (e) => { if (e.key === "Enter") nameIn.blur(); });
  meDot.addEventListener("click", () => {
    me.color = (me.color + 1) % COLORS.length;
    saveMe(me); syncMe();
    trackNow();
  });
  syncMe();
  syncAlpha();
  renderStatus();

  return { layout, pointerMoved, dug, digging };
}
