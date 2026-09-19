# Multiplayer — goal, current state, next step

Handoff note for whoever (human or agent) picks this branch up on another machine.
Everything below is about `netlify-app/` — the static site that is the actual game.

## The goal

Turn the keyspace map into a place where you can tell other people are there, without
giving up free static hosting.

1. **Phase 1 — cursors (DONE).** Everyone sees everyone else's cursor, brush square and name.
2. **Phase 2 — meeting, and sharing what you dug (DONE, this branch).** When two players are in
   the same place they see each other's cursors *and* each other's dug blocks. Nothing is stored
   anywhere: what you see is what the people currently standing next to you are sending you.
3. **Phase 3 — trading (LATER, ideas only).** Two players in the same spot open a direct WebRTC
   peer-to-peer link (Supabase only for signalling) and trade things we do NOT want broadcast to
   everybody — e.g. locally explored fragments, or whatever the meeting mechanic turns out to be.

An earlier draft of phase 2 had the dug blocks stored in Supabase Postgres, so a block stayed on
the map after the player who dug it left. That was dropped deliberately: blocks now live for the
session, between players who are actually present. **There is no database and no SQL** — no
tables, no RLS, no migration, nothing to wipe.

## Hard constraints — do not break these

- **No backend of our own, no build step.** The site is plain HTML/JS served as files.
  `netlify.toml` has an empty build command. Do not introduce npm, bundlers or Netlify
  Functions. Third-party libraries come in as ESM from a CDN (jsDelivr), pinned to a
  version, or vendored under `netlify-app/vendor/`.
- **Netlify must not build.** The owner is low on Netlify credits. Every commit message
  (merge commits included) ends with `[skip ci] [skip netlify]`. Test locally instead.
- **Supabase free tier is the budget.** See the numbers below and design for them.
- **Never commit a Supabase secret / service_role key.** It belongs to a backend and this site
  has none, so it has no business existing in the client at all. The publishable (anon) key is
  public by design — it ships to every browser that opens the page, which is why it lives in
  `multiplayer-config.js` in the repo. Protection comes from the project's own Realtime settings,
  never from hiding that string.

## Supabase free tier — the numbers that shape the design

| Limit | Free plan |
| --- | --- |
| Realtime messages | 2,000,000 / month |
| How they count | **per recipient**: one broadcast to 5 players = 6 messages |
| Concurrent connections | 200 |
| Messages per second | 100 |
| Presence messages per second | 20 (whole project) |
| Broadcast payload | 256 KB |

Practical consequence: never send on a timer. Send on change, throttled, stop entirely when
nothing is happening — and send nothing at all when nobody is near enough to receive it.

## How it works

Files (all under `netlify-app/`):

| File | Role |
| --- | --- |
| `multiplayer.js` | the whole feature: transports, channels, peer state, rendering, header UI |
| `multiplayer-config.js` | Supabase Project URL + publishable key; **empty = multiplayer off** |
| `app.js` | ~35 added lines: the `game` bridge object, the peer-block draw pass, `mp.dug()` |
| `index.html` | `#peers` layer styles, the `online N` header stat, the `#peerMenu` popover |

### Two levels of channel

- **Lobby** — one channel for the whole game (`keyspace`, or `keyspace-dev` on localhost),
  **Presence only**. Who is online, their name, colour and a settled position. In a 2^128-wide
  map nobody is ever accidentally near anybody, so this list — and the `fly there →` button in
  the popover — is the only way to find another player at all.
- **Region** — one channel per TILE of the map, `keyspace-t<x>_<y>`. You are on exactly one at a
  time, the one you are looking at, and it carries the live cursors and the dug blocks. Four
  players in the same place share **one** channel; there is no pair-wise mesh to book-keep.

"Near each other" therefore means "on the same tile", which is also literally "on the same
channel". There is no separate proximity check that could drift out of sync with the traffic,
and an incoming message cannot have come from anywhere else.

### Which tile you are on

- A tile is **2^64 keys a side** (`TILE_BITS`), so there are 1.8e19 of them. Two players share one
  only because they travelled to each other, and once they have, it takes a deliberate journey to
  leave it again.
- The tile is taken from the **camera**, never from the cursor. Zoomed out, one screen pixel is
  already 10^36 keys, so a cursor-derived tile would change faster than a channel can subscribe.
  (This was the first version and it was unusable — see `game.view()` in `app.js`.)
- Zoomed out far enough that the **screen is wider than a whole tile**, you are nowhere in
  particular: we hold no region channel, draw no cursors, and cost nothing. The header says
  *zoom in to meet anyone*. You have to actually be somewhere to be somewhere with someone.
- A tile change only takes effect after `TILE_SETTLE` (1.2 s) on the new tile, so skimming a
  border does not resubscribe.

### Sharing the dug blocks

- A shared block is three numbers: `x`, `y` and the brush size `c`. Nothing else — no key, no
  balance, no candidate, no count of what you flagged.
- **On arriving** on a tile you broadcast a `bulk` of your own blocks in it (an empty one still
  goes out: it is also "hello"). Anyone already there answers with one `bulk` of their own,
  addressed with `re: <your id>`. That `re` is what stops the two sides bouncing bulks off each
  other forever — the whole exchange is two messages.
- **After that**, each block you dig goes out as a single `dig` — and only if somebody is
  actually on your tile. Alone, the feature is completely silent.
- Blocks you receive are **display only**: drawn under your own territory, tinted with the
  owner's colour, and left out of `Save as PNG`. They never touch `keysScanned`, the found
  counter or pen progression (`creditDig`), they are never saved, and they are dropped the moment
  that player leaves your tile or you leave it yourself.
- Everything incoming is untrusted. Ids and 128-bit coordinates are regex- and range-checked, a
  brush size must be a power of two, names are capped and written with `textContent`, colours are
  an index into a fixed palette, and a peer can hold at most `PEER_PATCH_CAP` blocks. The worst a
  liar can do is paint squares on your screen until you walk away. Keep it that way when adding
  fields.

### The rest of the machinery

- `app.js` loads `multiplayer.js` with a **dynamic import, last, wrapped in `.catch()`**.
  A missing config, a blocked CDN or a bug in multiplayer can never take the map down. Keep it
  that way.
- The map exposes exactly one object and nothing else:
  `{ stage, W, H, isLocal, cellPx(), pointer(), view(), project(), travelTo(), myPatches(),
  showPeerPatches() }`. All map internals (`viewX`, `subX`, zoom, BigInt maths) stay in `app.js`.
- `multiplayer.js` returns `{ layout, pointerMoved, dug }`. `draw()` calls `layout()` so peers
  follow the camera *and* so a zoom with the mouse held still still changes your tile;
  `positionCursor()` calls `pointerMoved()`; `commitPatch()` calls `dug()`.
- **Two transports behind one interface.** A transport hands out channels, each
  `{ track(meta), send(event, payload), close() }`, reporting through
  `{ presence, message, status }`:
  - **Supabase** — Presence for who is there, Broadcast for `pos`, `dig` and `bulk`. supabase-js
    multiplexes every channel over one websocket, so lobby + region is still one connection.
  - **BroadcastChannel** — localhost only, when no keys are configured (or `?mp=local`). Tabs of
    one browser see each other, zero Supabase messages.
  Adding a feature means adding an **event**, never a third transport — otherwise the local test
  rig stops representing production.
- Traffic discipline: movement at most every 300 ms and only when the pointer really moved and
  only when somebody is on your tile; presence re-tracked only after 1.5 s of stillness and at
  most every 5 s; a background tab drops its connection after 30 s and rejoins when visible.
- Receivers interpolate between updates in **key space** (not pixels), so a zoom mid-glide stays
  correct; a jump larger than a couple of screens snaps instead of sliding.

### Running it

```
python scripts/serve_local.py      # http://127.0.0.1:8001 — app + Bloom filter parts
```

- **Real mode:** the keys are in `multiplayer-config.js`, so the page uses Supabase even on
  localhost (channel `keyspace-dev`). Open it in **two different browsers** (Chrome + Firefox);
  if they see each other it is genuinely going through Supabase. Supabase dashboard → Realtime →
  Inspector shows the raw traffic.
- **Free mode:** add `?mp=local` on localhost and two tabs of the *same* browser see each other
  over BroadcastChannel, without spending a single Supabase message. Cross-browser cannot work in
  this mode — that is the point of it.
- **To actually meet:** both players must be zoomed in (the header will say *zoom in to meet
  anyone* otherwise) and on the same tile. The reliable way is one player using `fly there →` in
  the players popover.
- `?mpdebug=1` narrates the channel work in the console: which region channel you are on and
  every block in and out.
- Supabase needs no tables. Public channels must be allowed (Realtime → Settings); there is no
  auth, so channels are public.

#### A bug that is not a bug

"Firefox could not see Chrome, but Chrome saw itself" was simply `multiplayer-config.js` being
empty: with no keys, localhost falls back to BroadcastChannel, which is same-browser only. Two
Chrome windows found each other, Firefox was alone. With the keys filled in it goes through
Supabase and crosses browsers.

## Phase 3 — trading (ideas, nothing decided)

WebRTC full mesh is fine for 2–6 players in one spot; Supabase only carries the offer / answer /
ICE candidates, and the region channel is already the obvious place to do that signalling.
Mechanic ideas floated so far: trade explored fragments, a bonus for digging the same spot
together, mutual verification of a find, beacons left behind for offline players, a "who you have
met" graph.

Worth deciding at the same time: whether anything should ever outlive the session. Today nothing
does, and that is what keeps this whole feature free of a database.

## Git conventions in this repo

- Work on a feature branch (`multiplayer-cursors` is the current one), then merge to `main`.
- Commit subject line, then a body of bullet points explaining *why*, and the subject ends
  with `[skip ci] [skip netlify]`.
- Commits made by an agent end with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
