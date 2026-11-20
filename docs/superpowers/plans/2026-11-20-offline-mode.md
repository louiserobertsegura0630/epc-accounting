# Site-wide Offline mode: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One sidebar button switches the whole site to reading Firebase's local cache (0 reads) after making sure the copy is complete, with an incognito-style look while offline.

**Architecture:** Firestore persistence is enabled in `configureFirestoreDB`. The flag `epc_offline` is read by `assets/reads.js` at load into `window.EPC_OFFLINE` and `<html data-offline>`. The existing read wrapper (`EPCReads.watchGet`) passes `{ source: 'cache' }` to every `get()` while offline and counts nothing; the REST count helpers return `null` offline. `assets/offline.js` (new) owns the button, the staged switch and the banner; `assets/datafile.js` exposes its download flow without the file write. Reports loses its per-page controls.

**Tech Stack:** Vanilla JS, Firebase compat 10.13.2 (`enablePersistence({ synchronizeTabs: true })`, `CACHE_SIZE_UNLIMITED`), `node --test`.

**Spec:** `docs/superpowers/specs/2026-11-20-offline-mode-design.md`

## Global Constraints

- Branch `read-budget`; the owner pushes. Cache tag `?v=20261120-offline` on every changed .js/.css, in every page that loads it.
- `assets/reads.js` loads before `app.js` on every page; `assets/offline.js` loads after `app.js` on every page that has a sidebar (every page that loads `app.js` except `login.html`).
- No new read on page open. The flag is read from `localStorage` only.
- Plain wording. Banner text exactly: "Offline mode: reading the copy saved on this browser, 0 database reads. Days or records not saved here are missing."

## Review Focus

1. **Persistence refused** (private window, second tab without `synchronizeTabs`): the site must still work online, and offline mode must say "limited" instead of failing. (Task 2: `enablePersistence` errors are caught; Task 3 banner wording when `EPCOffline.persistenceOk === false`.)
2. **A cache miss while offline**: a `get({ source: 'cache' })` for a document never read rejects with `unavailable`; pages must show their normal error notice, not crash. (Task 1 test `offline get rejects like the SDK and counts nothing`; gates already catch errors.)
3. **Switching while the copy is empty**: stage 1 must run the download and stop if the user cancels or the quota pop-up says wait. (Task 3 test `switchOn runs the fill first and stops on cancel`.)
4. **Counts while offline**: `firestoreCount` returning `null` must not force a full reload in `EPCSaved.sync` (it is skipped offline anyway) and must leave the Purchases totals as "Only the N loaded rows". (Task 2 check.)
5. **Theme before paint**: `data-offline` must be set by `reads.js` in `<head>`-order, not after `DOMContentLoaded`, or pages flash the normal colours. (Task 3 manual check by the owner; code sets it synchronously at script load.)

---

### Task 1: Flag and cache-only reads in `EPCReads`

**Files:** Modify `assets/reads.js`, `tests/reads.test.js`.

**Interfaces:** `EPCReads.offline() -> boolean` (reads `window.EPC_OFFLINE`); at load: `window.EPC_OFFLINE = localStorage.epc_offline === '1'` and `document.documentElement.dataset.offline = '1'` when true. `watchGet` wrapper: when offline, `original.call(this, { source: 'cache' })` (merging into an existing options arg) and no `spent`.

- [ ] Tests: `offline get asks the cache and counts nothing` (fake proto records its args; `EPCReads._init({ offline: () => true })` → args `[{ source: 'cache' }]`, `used()` stays 0); `online get is unchanged`; `offline get rejects like the SDK and counts nothing`.
- [ ] Run, see them fail. Implement. Run, pass. Commit `Offline: cache-only reads behind one flag`.

### Task 2: Firestore persistence and offline-aware helpers in `app.js`

**Files:** Modify `assets/app.js` (`configureFirestoreDB`, `firestoreCount`, `firestoreSum`, `EPCSaved.rows` default, `EPCReportGate` quota call), `assets/days.js` (`docs` default `offline` from the flag).

- [ ] `configureFirestoreDB`: before `settings`, `db.settings({ experimentalAutoDetectLongPolling: true, cacheSizeBytes: firebase.firestore.CACHE_SIZE_UNLIMITED, merge: true })`; then once, `db.enablePersistence({ synchronizeTabs: true }).then(() => { window.EPC_PERSISTENCE = true; }).catch(err => { window.EPC_PERSISTENCE = false; console.warn('[Firestore] offline storage unavailable:', err.code); })`.
- [ ] `firestoreCount` / `firestoreSum`: `if (window.EPC_OFFLINE) return null;` first.
- [ ] `EPCSaved.rows(name, { force, offline = !!window.EPC_OFFLINE })`; `EPCDays.docs(..., { offline = !!global.EPC_OFFLINE })`.
- [ ] `node --check`, `npm test`. Commit `Offline: Firebase local storage on; counts and saved copies follow the flag`.

### Task 3: The button, the staged switch, the banner and the theme

**Files:** Create `assets/offline.js`, `tests/offline.test.js`; modify `assets/datafile.js` (export `fill(range)`: `askRange` + `loadEverything` without writing a file), `assets/app.js` (sidebar footer: `<button class="btn-offline" id="epc-offline-btn"></button>` above Logout), `assets/style.css` (theme + banner + button), every `pages/*.html` with a sidebar (script tag).

**Interfaces:** `EPCOffline.isOn()`, `EPCOffline.copyComplete() -> Promise<boolean>` (sales days in `EPCDays.cachedDates('salesDaily')` not empty and `EPCSaved.meta()` has `purchases` and `productMaster`), `EPCOffline.switchOn({ fill }) -> Promise<boolean>` (if `!copyComplete()` await `fill()`; false if fill returns false; else set flag and `location.reload()`), `EPCOffline.switchOff()`. `fill` defaults to `EPCDataFile.fill`. Banner built on DOMContentLoaded when on; button label "Switch to offline mode" / "Switch back online".

- [ ] Tests (fakes injected via `EPCOffline._init`): `switchOn runs the fill first and stops on cancel`; `switchOn skips the fill when the copy is complete`; `switchOff clears the flag`.
- [ ] Run, fail; implement; pass.
- [ ] Theme: `html[data-offline] { --page-bg:#1f2326; --card-bg:#2a2f33; --card-border:#3a4046; --sidebar-bg:#15181b; --primary:#4b5563; --t-ink:#e5e7eb; --t-panel:rgba(42,47,51,.9); color-scheme: dark; }` plus text colour overrides for `body`, `.summary-card`, tables; a fixed top banner `.epc-offline-banner` with the exact text and the switch-back button; `.btn-offline` styled like `.btn-logout` with a grey outline. Keep contrast readable; it is a working mode, not decoration.
- [ ] Add `<script src="../assets/offline.js?v=20261120-offline">` after `app.js` on every sidebar page; bump tags. Commit `Offline: sidebar switch, staged fill, banner and incognito theme`.

### Task 4: Reports and Settings cleanup, docs

**Files:** Modify `pages/reports.html` (remove the "Saved copy" row), `pages/reports.js` (remove the `rep-offline` switch wiring; keep `renderOfflineNote` and `window.EPC_OFFLINE` use; `applyOfflineSwitch` becomes: disable Reload all data while offline), `pages/reports.css` (drop `.report-saved-row`), `pages/settings.html` (card text: mention the sidebar button), `CLAUDE.md`, `PROJECT-NOTES.md`.

- [ ] Edits above; `node --check`; `npm test`; grep for `rep-offline` → none. Commit `Offline: Reports keeps only the notice; docs`.
