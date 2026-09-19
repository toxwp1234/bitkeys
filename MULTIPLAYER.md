# Multiplayer — goal, current state, next step

Handoff note for whoever (human or agent) picks this branch up on another machine.
Everything below is about `netlify-app/` — the static site that is the actual game.

## The goal

Turn the keyspace map into a place where you can tell other people are there, without
giving up free static hosting.

1. **Phase 1 — cursors (DONE, this branch).** Everyone sees everyone else's cursor,
   brush square and name, live.
2. **Phase 2 — a shared map (NEXT, not started).** Revealed blocks (scanned patches) are
   shared: you see where other players have already dug, and they see where you have.
3. **Phase 3 — meeting another player (LATER, ideas only).** When two players end up in
   the same spot on the map, they open a direct WebRTC peer-to-peer link (Supabase used
   only for signalling) and trade things we do NOT want broadcast to everybody — e.g.
   locally explored fragments, or whatever the meeting mechanic turns out to be.

## Hard constraints — do not break these

- **No backend of our own, no build step.** The site is plain HTML/JS served as files.
  `netlify.toml` has an empty build command. Do not introduce npm, bundlers or Netlify
  Functions. Third-party libraries come in as ESM from a CDN (jsDelivr), pinned to a
  version, or vendored under `netlify-app/vendor/`.
- **Netlify must not build.** The owner is low on Netlify credits. Every commit message
  (merge commits included) ends with `[skip ci] [skip netlify]`. Test locally instead.
- **Supabase free tier is the budget.** See the numbers below and design for them.
- **Never commit a Supabase secret / service_role key.** Only the publishable (anon) key
  belongs in the client, and even that lives in `multiplayer-config.js`, which ships empty
  in git until someone fills it in.

## Supabase free tier — the numbers that shape the design

| Limit | Free plan |
| --- | --- |
| Realtime messages | 2,000,000 / month |
| How they count | **per recipient**: one broadcast to 5 players = 6 messages |
| Concurrent connections | 200 |
| Messages per second | 100 |
| Presence messages per second | 20 (whole project) |
| Broadcast payload | 256 KB |
| Postgres database | 500 MB |

Practical consequence: never send on a timer. Send on change, throttled, and stop entirely
when nothing is happening. Two players moving their mice non-stop cost roughly 50k
messages an hour.

## Phase 1 — what is already built

Files (all under `netlify-app/`):

| File | Role |
| --- | --- |
| `multiplayer.js` | the whole feature: transports, peer state, rendering, header UI |
| `multiplayer-config.js` | Supabase Project URL + publishable key; **empty = multiplayer off** |
| `app.js` | ~25 added lines at the end: dynamic `import()` + the `game` bridge object |
| `index.html` | `#peers` layer styles, the `online N` header stat, the `#peerMenu` popover |

How it hangs together:

- `app.js` loads `multiplayer.js` with a **dynamic import, last, wrapped in `.catch()`**.
  A missing config, a blocked CDN or a bug in multiplayer can never take the map down.
  Keep it that way.
- The map exposes exactly one object and nothing else:
  `{ stage, W, H, isLocal, cellPx(), pointer(), project(x, y, fx, fy), travelTo(x, y) }`.
  `pointer()` returns the key under the cursor (`BigInt x, y` + sub-cell fraction + brush
  size + `parked`); `project()` turns a key back into stage pixels. All map internals
  (`viewX`, `subX`, zoom, BigInt maths) stay inside `app.js`.
- `multiplayer.js` returns `{ layout, pointerMoved }`. `draw()` calls `layout()` so peers
  follow the camera; `positionCursor()` calls `pointerMoved()`, which is throttled inside.
- **Two transports behind one four-call interface** (`join / update / move / leave`):
  - **Supabase** — Broadcast (event `pos`) for movement, Presence for who is online plus a
    settled position so a fresh joiner sees players who are standing still.
  - **BroadcastChannel** — localhost only, when no keys are configured (or `?mp=local`).
    Tabs of one browser see each other, zero Supabase messages. This is the free test rig.
  Adding a new feature means adding a call to **both** transports, or the local test rig
  stops representing production.
- Traffic discipline already in place: movement at most every 300 ms and only when the
  pointer actually moved; presence re-tracked only after 1.5 s of stillness and at most
  every 5 s; a background tab drops its connection after 30 s and rejoins when visible.
- Receivers interpolate between updates in **key space** (not pixels), so a zoom mid-glide
  stays correct; a jump larger than a couple of screens snaps instead of sliding.
- Channel name is `keyspace` in production and `keyspace-dev` on localhost, so testing
  never shows up for real players.
- Everything incoming is treated as untrusted: ids and 128-bit coordinates are regex- and
  range-checked, names are capped and written with `textContent`, colours are an index into
  a fixed palette. Keep this when adding fields.
- Shared today: cursor position, brush size, name, colour. **Nothing that is scanned,
  flagged or found is shared**, and the popover promises the player exactly that.

### Running it

```
python scripts/serve_local.py      # http://127.0.0.1:8001 — app + Bloom filter parts
```

- **Free mode (no Supabase):** leave `multiplayer-config.js` empty and open the page in two
  windows of the *same* browser. Header shows `ONLINE 2` in amber ("local test mode").
  Two windows, not two tabs — a background tab disconnects after 30 s on purpose.
- **Real mode:** paste the Project URL and publishable key into `multiplayer-config.js`
  (Supabase dashboard → Project Settings → API), then open the page in **two different
  browsers** (Chrome + Firefox). Local mode cannot cross browsers, so if they see each
  other it is genuinely going through Supabase. Header shows `ONLINE 2` in green.
  Supabase dashboard → Realtime → Inspector, channel `keyspace-dev`, shows the raw traffic.
- Supabase needs no tables for phase 1. Public channels must be allowed
  (Realtime → Settings); there is no auth, so channels are public.

## Phase 2 — shared revealed blocks (the next job)

**Decided:**

- The map is a **shared world stored in Supabase Postgres**, not only a peer-to-peer
  exchange: a block stays visible after the player who dug it goes offline.
- A stored block is: **brush size, x, y, number of flagged keys** (in `app.js` terms a
  patch `{c, x, y, h}` — `h` is what tints the square).
- Other players' blocks are **display only**. They must NOT count toward your
  `keysScanned`, your `found` counter or your pen progression (`creditDig`). Your own
  progress stays yours.

**Open questions — decide with the owner before writing SQL:**

1. **Loading.** The map is 2^128 × 2^128, so "fetch all blocks" only works while the
   table is small. Region queries need a sane key: store x/y as fixed-width hex text
   (32 chars, so lexicographic order = numeric order) or as `bytea`, and query the visible
   rectangle; or bucket blocks into coarse tiles and fetch tile by tile. Postgres has no
   128-bit integer type — `numeric` works but indexes poorly compared to fixed-width text.
2. **Live updates.** Postgres Changes (every insert costs one message per subscriber) vs
   Broadcast on the existing channel plus a REST read on load. Broadcast is cheaper and we
   already have the channel.
3. **Write abuse.** With the anon key, anybody can insert. Options: rate limit in a
   Postgres trigger, constrain the shape (brush size must be a power of two, `h` must be
   plausible for the area), or accept it while the game is small and keep a wipe script.
4. **Storage.** A row is ~100–150 bytes with index overhead, so 500 MB is roughly 3 million
   blocks. Worth a cap or a dedupe on (x, y, c).
5. **Rendering.** `app.js` draws `patches` (yours, heat-tinted) and `grayPatches` (your old
   territory, gray). Other players' blocks want a third list with its own look — tinted by
   the owner's colour is the obvious choice, and it must not be included in `Save as PNG`
   unless we decide it should be.

## Phase 3 — meeting a player (ideas, nothing decided)

WebRTC full mesh is fine for 2–6 players in one spot; Supabase only carries the offer /
answer / ICE candidates. Mechanic ideas floated so far: trade explored fragments, a bonus
for digging the same spot together, mutual verification of a find, beacons left behind for
offline players, a "who you have met" graph.

## Git conventions in this repo

- Work on a feature branch (`multiplayer-cursors` is the current one), then merge to `main`.
- Commit subject line, then a body of bullet points explaining *why*, and the subject ends
  with `[skip ci] [skip netlify]`.
- Commits made by an agent end with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
