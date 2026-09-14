# Candidate Shelf & History Feature

## Problem Solved

Finds are lost when the user clicks elsewhere to keep exploring — no way to track
"potentials" found before, which feels like missing out / losing data.

## Solution

### 1. Candidate Shelf (bottom persistent panel)
Persistent floating shelf at the bottom of the screen showing the last 10 funded finds.
- Shows: address (truncated), timestamp, sats balance
- Survives clicks elsewhere (doesn't disappear)
- Click any chip to re-verify that wallet
- "Clear" button to empty the shelf
- Auto-hides when empty

### 2. Candidate History (IndexedDB)
Funded finds are automatically saved to the browser's IndexedDB.
- Per record: `{ id, addr, sats, priv (hex), timestamp }`
- Survives browser/tab close (persistent)
- Manual clear via the shelf UI

## Technical Implementation

- **Database:** `cuvre-candidates` · **Object store:** `found` (keyPath `id`, autoIncrement)
- **Index:** `timestamp` (chronological retrieval; newest first)
- **Frontend (app.js):** `initCandidateDB()`, `saveCandidateToHistory(addr, sats, priv)`,
  `getCandidateHistory(limit)`, `updateCandidateShelf()`; wired into `reportBalance` on a
  confirmed funded result, and re-populated on load.

## Design Decisions

- **Bottom panel:** doesn't cover the map or balance card; unobtrusive but persistent.
- **Only funded finds are stored** (sat > 0, API-confirmed) — the shelf stays a clean list
  of real leads, not thousands of Bloom false-positives.
- **Max 10 shown:** most recent is most relevant; full history remains in IndexedDB.

## Testing Checklist

```
[x] Funded find -> appears on shelf immediately
[x] Click new patch -> shelf doesn't disappear
[x] Click candidate chip -> re-checks that wallet
[x] Refresh page -> shelf data persists (loaded from IndexedDB)
[x] Clear button -> empties shelf + IndexedDB
[x] No console errors on candidate save/load
```

**Status:** Production-ready · **Files:** `netlify-app/app.js`, `netlify-app/index.html`
