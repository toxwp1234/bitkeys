# What's New: Candidate Shelf & Persistent History

## The Problem You Had

```
Scenario:
1. You scan patch, find 6 candidates ★
2. You see: "85,264 · 11,553/s · 6 candidates ★"
3. You click different area to explore
4. Those 6 candidates disappear
5. You feel like you missed something

Result: Anxiety + "what if that wallet was funded?"
```

## The Solution

### **Candidate Shelf**
- Persistent floating panel at bottom of screen
- Shows last 10 funded finds
- **Doesn't disappear when you click elsewhere**
- Click any candidate to verify it instantly
- "Clear" button to empty when you want

### **Auto-Save to History**
- Every funded find is automatically saved to IndexedDB (`cuvre-candidates`)
- Persists even if you close the browser
- Full audit trail: timestamp + address + amount + private key

**Result:** Zero anxiety. You never lose a lead.

---

## How It Works

- A scan streams the patch; the Bloom filter flags candidates, the API confirms them.
- When a find is **confirmed funded** (sat > 0), it is saved to IndexedDB and shown on the shelf.
- The shelf persists across new scans, map clicks, tab switches and browser restarts.
- Click a chip → re-verifies that wallet's live balance.

---

## Files Changed

- `netlify-app/index.html` — shelf panel + styling + scan stats sub-line
- `netlify-app/app.js` — IndexedDB storage + shelf render/update + clear

**Performance Impact:** Negligible (async IndexedDB, DOM updates only on a find).

**Status:** Live and working. No breaking changes.
