# keyspace map — static (Netlify)

A backend-free, client-side map of the entire Bitcoin private-key space. Everything
runs in the browser: addresses are derived in a Web Worker with `@noble/secp256k1`
+ `@noble/hashes` (vendored under `vendor/`). No server, no API calls.

## How it works
- The grid is a CSS repeating background (GPU-composited) so panning is buttery.
- **Hover** just moves the cursor box — it does not compute anything.
- **Click** scans the patch under the cursor: the worker derives every P2PKH
  address in that square and shows them. Scanned patches stay lit as a trail.
- **Drag** to pan, **scroll** to zoom, **click the minimap** to teleport.
- Range is set per axis: `X = 2^a` columns, `Y = 2^b` rows (default 2¹²⁸ × 2¹²⁸ = 2²⁵⁶).
- No funded-check: a hit is a ~10⁻⁴¹ event, so the app is honest that it is a
  scale visualization, not a coin finder. (A check could be added later via a
  small bloom filter or an optional API — deliberately omitted here.)

## Deploy to Netlify
This folder is the whole site — no build step.

- **Drag-and-drop:** zip or drag this `netlify-app` folder onto the Netlify
  "Deploys" page. Done.
- **Git:** point a Netlify site at the repo and set publish directory to
  `netlify-app` (build command empty). `netlify.toml` here already sets
  `publish = "."` and the correct `.mjs` content-type.

## Local preview
Module workers need HTTP (not file://). From the repo root:

    python scripts/serve_static.py    # serves netlify-app on http://127.0.0.1:8001

## Files
    index.html         layout + styles
    app.js             map: pan/zoom, click-to-scan, minimap, per-axis range
    derive.js          client-side key -> P2PKH address (secp256k1 + hashes + base58)
    derive.worker.js   runs derivation off the main thread
    vendor/            @noble/secp256k1 + @noble/hashes (self-contained ESM)
    multiplayer.js     other players' cursors (Supabase Realtime, loaded lazily from jsDelivr)
    multiplayer-config.js   Supabase project URL + publishable key (empty = multiplayer off)

## Multiplayer (phase 1: cursors)
Still no backend: the browser talks to Supabase Realtime directly, Netlify only serves files.
Fill in `multiplayer-config.js` (Project URL + publishable/anon key — both public by design) and
players see each other's cursors, an "online" count in the header, and a list to fly to anyone.

- Movement goes over **Broadcast**, only while the pointer moves, at most every 300 ms.
- **Presence** carries who is online plus a settled position, refreshed at most every 5 s.
- A background tab disconnects after 30 s and rejoins when you look at it again.
- On localhost the channel is `keyspace-dev`, so testing never shows up in production.
- On localhost **without** keys (or with `?mp=local`) two tabs of the same browser see each
  other through a `BroadcastChannel` — no Supabase project, no messages spent.
