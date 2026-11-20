# Site-wide Offline mode (one button, staged, incognito look)

Date: 2026-11-20. Status: short design for the owner's approval. Follows the read-budget work (`2026-11-20-read-budget-and-offline-design.md`).

## Why

The owner wants one button, **Switch to offline mode**, that first makes sure the copy on this browser is complete (the download, with its dates box and read cost), then puts the **whole site** on that copy: 0 database reads on every page, and a visibly different look, like a browser in incognito, so nobody forgets they are offline. The current per-page Offline tick on Reports, plus separate Download and Load buttons, is replaced.

## Approaches considered

1. Teach every page to read the saved copy when offline: precise, but ~15 files and any missed page silently keeps reading. Not chosen.
2. **Chosen: a gate at the database layer.** Firebase's own offline storage is turned on, and in offline mode the site's single read wrapper (`EPCReads.watchFirestore`) asks Firebase to answer every read **from its local cache** (`get({ source: 'cache' })`), which costs 0 reads. Every page is covered at once. The download fills the cache because it reads through the same SDK.
3. Block reads while offline and convert pages one by one: a stepping stone to 1. Not chosen.

## Design

- **Firebase cache on.** `configureFirestoreDB` (assets/app.js) calls `db.settings({ cacheSizeBytes: firebase.firestore.CACHE_SIZE_UNLIMITED })` then `db.enablePersistence({ synchronizeTabs: true })` before any read. If persistence is refused (private window, old browser), the site still works online; offline mode then covers only Reports, the Dashboard day store and the saved copies, and the banner says "limited".
- **One flag.** `localStorage` `epc_offline` = `'1'`, read in `assets/reads.js` at load into `window.EPC_OFFLINE` (reads.js loads before app.js, so every page has it early). `<html data-offline>` is set at the same moment so the theme applies before paint.
- **Reads while offline.** The `get` wrapper calls the original with `{ source: 'cache' }` and counts nothing. `firestoreCount` / `firestoreSum` return `null` without a network call (their callers already handle `null`). `EPCSaved.rows` and `EPCDays.docs` default `offline` to the flag. Writes are untouched (they need the internet but cost no reads).
- **The button.** In the sidebar, above Logout: **Switch to offline mode**. Click: stage 1, if the copy is not complete (no sales days saved on this browser, or the saved copies are missing), run the same download flow as Download all data (dates box, cost confirm, reads) but without writing a file; stage 2, set the flag and reload the page. While offline the same button reads **Switch back online** and clears the flag. Both are one click; no tick box anywhere.
- **The look.** `html[data-offline]` overrides the colour tokens: dark grey sidebar and page background, muted cards, grey accent for buttons, plus a fixed banner at the top: "Offline mode: reading the copy saved on this browser, 0 database reads. Days or records not saved here are missing." with the Switch back button. Every cost line reads "0 reads (offline)".
- **Reports.** The Offline tick, Download all data and Load from file leave the page; the "Saved copy" row goes. The missing-days notice stays. **Settings** keeps Download all data and Load from file in its "Your saved data" card, for files and other computers.
- **Pages whose data is not in the cache** (the Sales page's raw receipts, audit log, payroll, employees) show whatever the cache has, usually nothing, plus the banner's wording; they are not converted.
- Docs: CLAUDE.md (offline mode section replaces the Reports Offline bullet; the read-counter rule gains "offline reads come from the cache"), PROJECT-NOTES.md.

## Non-goals

- Editing records offline without internet. Writes still need a connection.
- Making the Sales page's raw receipt lists available offline.

## Left to the builder

- Exact colours of the offline theme (keep the existing design tokens; aim for "incognito": dark neutral greys, no teal/lime).
- The "copy is complete" test for stage 1: a day store with at least one sales day and saved copies for the core lists.
- Tests: Node tests for the flag/wrapper logic with fakes (`get` called with `{ source: 'cache' }` when offline, counts 0; online unchanged).
