# Read budget, Product Master on demand, offline Reports and data file: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop any page from reading the whole raw `salesData` collection, show the read cost of every load before the click, and let Reports run from the browser's saved copy, which can be downloaded to a file and loaded back.

**Architecture:** Two new shared files hold the logic: `assets/reads.js` (`EPCReads`: per-browser read counter, estimates, cost line, confirm pop-up) and `assets/days.js` (`EPCDays`: one reader for `salesDaily`/`inventoryDaily` day docs with a per-user IndexedDB day store, offline reads and file export/import). `assets/app.js` keeps `EPCSaved`, which gains three collections and an `offline` option; its shared loaders (`loadProductMasterFromFirestore` etc.) switch to `EPCSaved.rows`, which moves most pages off whole-collection reads in one place. Pages then only wire a Generate button with an estimate.

**Tech Stack:** Vanilla JS, Firebase compat SDK 10.13.2, IndexedDB, Node 25 built-in `node:test` for the pure logic (`node --test tests/`).

**Spec:** `docs/superpowers/specs/2026-11-20-read-budget-and-offline-design.md`

## Global Constraints

- Branch `read-budget`, never commit to `main`. The owner pushes.
- No `query.count()`; use `firestoreCount(query, label)` (returns `null` when it cannot count).
- Free quota 50,000 reads/day, reset at midnight US Pacific; reuse `EPCQuota`'s `nextReset` logic (expose it as `EPCQuota.nextReset(ms)`).
- Every site write to a collection in `EPCSaved.SOURCES` must wrap data in `epcStamp(...)` (adds `changedAt`). `salesDaily`/`inventoryDaily` stamp `lastUpdated` instead.
- Bump the `?v=` cache tag on every changed `.js`/`.css` in every page that loads it, to `20261120-reads`.
- No page-open read that was not there before; no read without a `EPCReads.spent` report.
- Pop-up threshold 1,000 reads; limit 50,000. Cost line copy: `≈ 2 reads · 1,240 used today on this browser` (singular `read` for 1; thousands separators).
- Plain wording in the UI.
- Both new files must load in Node (`module.exports` when `module` exists) and in the browser (`window.EPCReads` / `window.EPCDays`); they must not touch `document` at load time.

## Review Focus

1. **Quota day rollover while a page is open.** A browser left open past 4 PM must restart its count at 0 on the next `spent` or `used` call, not keep yesterday's total. (Task 1 test `used resets after the day boundary`.)
2. **A query that returns no documents.** Firestore bills 1 read for an empty result; `spent(0)` must count 1. (Task 1 test `countSnap counts an empty snapshot as 1`.)
3. **Saved copy for another user.** `estimate` must treat a copy saved by a different uid as absent (full-load estimate), as `EPCSaved` does. (Task 1 test `estimate ignores a copy saved for another user`.)
4. **Offline with a partial day store.** A range where some days are missing must still render, list exactly the missing dates and make zero Firebase calls. (Task 3 test `offline lists missing days` and Task 9 manual check.)
5. **Load from file with the wrong account.** A file whose `uid` differs from the signed-in user is refused with the exact message and writes nothing. (Task 10 test `importFile refuses another user's file`.)

---

### Task 1: `EPCReads` core: counter and estimate

**Files:**
- Create: `assets/reads.js`
- Create: `tests/reads.test.js`
- Modify: `assets/app.js:138-146` (expose `nextReset` on `EPCQuota`'s return object)

**Interfaces:**
- Consumes: `EPCQuota.nextReset(fromMs) -> resetMs` (existing function, newly exported).
- Produces (all on `EPCReads`):
  - `spent(n, label) -> void`: adds `max(1, n)` to today's count; persists `localStorage['epc_reads'] = { day, total, byLabel }` where `day` is the reset ms for the current quota day.
  - `countSnap(snap, label) -> snap`: `spent(snap.size || 1, label)`, returns `snap` for chaining.
  - `used() -> number`: today's total (0 after the day boundary).
  - `estimate(parts, state) -> { reads, breakdown: [{ label, reads, note }] }`: `parts` as in the spec; `state` is `{ uid, saved: { name: { uid, at, count } }, counts: { name: n }, daysCached: Set<string> }`, built by `EPCReads.state()` in the browser (Task 2) and passed directly in tests.
  - `FALLBACK = { productMaster: 5000, inventoryData: 8000, itemCost: 5000, purchases: 3000, expenses: 2000, suppliesData: 1000, eSalesRecords: 1000, suppliers: 200, expenseAccounts: 100 }`.
  - `shouldConfirm(reads, used) -> boolean`: `reads > 1000 || used + reads > 50000`.
  - `format(reads, used) -> string`: the cost line text.
  - `daysBetween(from, to) -> string[]`: inclusive `YYYY-MM-DD` list.
  - Internals take injectable `now()` and `storage` (object with `getItem`/`setItem`) via `EPCReads._init({ now, storage, nextReset })` for tests.

- [ ] **Step 1: Write the failing tests** in `tests/reads.test.js` (`node:test`, `assert/strict`). Use a fake storage (`Map`-backed), `nextReset = ms => DAY_END` constant, and `now` as a mutable variable.

```js
test('spent accumulates and used reads it back', ...)   // spent(2,'a'); spent(3,'b') -> used() === 5, byLabel a:2 b:3
test('countSnap counts an empty snapshot as 1', ...)   // countSnap({ size: 0 }) -> used() === 1
test('used resets after the day boundary', ...)        // spent(5); now = DAY_END + 1; used() === 0
test('estimate: saved copy present costs 2 (+1 per extra 1,000)', ...)  // saved count 2500 -> 2 + 2 = 4, note 'change check'
test('estimate ignores a copy saved for another user', ...)  // saved uid 'other' -> uses counts.productMaster (4700)
test('estimate uses FALLBACK when nothing is known', ...)    // -> 5000 for productMaster
test('estimate: days not cached cost 1 each, cached range costs 2', ...) // from 2026-11-01 to 2026-11-10 with 3 cached -> 7; all cached -> 2
test('estimate: fixed parts add up', ...)
test('shouldConfirm thresholds', ...)   // (1000, 0) false; (1001, 0) true; (10, 49995) true
test('format wording', ...)   // (1, 0) -> '≈ 1 read · 0 used today on this browser'; (12000, 1240) -> '≈ 12,000 reads · 1,240 used today on this browser'
test('daysBetween is inclusive and zero-padded', ...)  // ('2026-01-30','2026-02-02') -> 4 dates
```

- [ ] **Step 2: Run** `node --test tests/` **and confirm every test fails** with "Cannot find module" or "is not a function".

- [ ] **Step 3: Implement `assets/reads.js`** as an IIFE assigned to `EPCReads` with the interface above. Saved-copy age rule: a copy older than 7 days counts as absent (same `MAX_AGE_MS` as `EPCSaved`). `estimate` saved-part note text: `'change check'` when the copy is used, `'first load on this browser'` otherwise.

- [ ] **Step 4: Run** `node --test tests/` **and confirm all pass.**

- [ ] **Step 5: Expose `nextReset`** by adding it to `EPCQuota`'s returned object in `assets/app.js` (`return { report, ok, isQuotaError, resetText, nextReset, active: ... }`).

- [ ] **Step 6: Commit** `git add assets/reads.js tests/reads.test.js assets/app.js && git commit -m "Reads: per-browser read counter and estimate (EPCReads)"`.

---

### Task 2: Count every read, cost line and confirm on Generate buttons

**Files:**
- Modify: `assets/reads.js` (browser-only parts: `state()`, `line()`, `confirm()`)
- Modify: `assets/app.js` (`EPCSaved`, `firestoreCount`, `firestoreSum`, `EPCReportGate.wire`, `_runAggregationRest` callers)
- Modify: `assets/style.css` (append `.epc-cost-line`, `.epc-confirm` styles next to `.epc-quota` at line 1567)
- Modify: `pages/reports.js` (`readDailyRollupDocs`, line 96; `loadSalesPriorInflow`; `db.collection('salesDaily')` at line 2431), `pages/dashboard-sales.js` (`fetchPack`, `syncPack`), `pages/dashboard.js` (lines 102, 130, 151)
- Modify: every `.get()` / aggregate call left in `pages/*.js` and `assets/*.js` (the sweep)
- Modify: every `pages/*.html` that loads `app.js`: add `<script src="../assets/reads.js?v=20261120-reads"></script>` on the line before `app.js`, and bump `app.js` and `style.css` tags.

**Interfaces:**
- Produces:
  - `EPCReads.state() -> Promise<state>`: reads IndexedDB `saved:*` entries' `{ uid, at, count: Object.keys(docs).length }` (via a new `EPCSaved.meta() -> Promise<{ name: { uid, at, count } }>`), `localStorage['epc_counts']`, and the current uid.
  - `EPCReads.line(el, partsFn) -> Promise<void>`: writes `format(estimate.reads, used())` into `el`; `partsFn` returns `parts`.
  - `EPCReads.confirm(parts) -> Promise<boolean>`: no pop-up when `!shouldConfirm`; otherwise the modal described in the spec (buttons **Load anyway** / **Not now**; when `EPCQuota.active()` the primary is **Wait until <reset time>** and resolves false).
  - `EPCReportGate.wire` options `estimate: () => parts` and `costLine: '<element id>'`. The gate calls `EPCReads.line` at wire time, after each `load`, and whenever `window.dispatchEvent(new Event('epc-cost-change'))` fires (pages fire it when their date inputs change); before `load()` it awaits `EPCReads.confirm(parts)` and returns without loading on false.
  - `EPCSaved.meta()` as above; `EPCSaved` stores `epc_counts[name]` after every full load or count.
  - Rule for the sweep: right after any `await <query>.get()`, `EPCReads.countSnap(snap, '<file>:<what>')`; after `firestoreCount`/`firestoreSum`, `EPCReads.spent(Math.max(1, Math.ceil((result || 0) / 1000)), label)` (done once inside those helpers, not at call sites).

- [ ] **Step 1: Count inside the shared helpers.** `firestoreCount` and `firestoreSum` call `EPCReads.spent` on success. `EPCSaved.fetchAll` counts `snap.size`; `sync` counts `changed.size || 1`. `readDailyRollupDocs` counts each month snapshot. Dashboard Sales Pulse `fetchPack`/`syncPack` count their snapshots.

- [ ] **Step 2: The sweep.** Run `grep -n "\.get()" pages/*.js assets/*.js | grep -v "DB.get\|\.get('\|localStorage"` and add `countSnap` after every Firestore `.get()` not yet counted. Expected: zero uncounted Firestore `.get()` calls remain (re-run the grep and read each hit).

- [ ] **Step 3: Gate options, cost line and confirm.** Implement `state`, `line`, `confirm` in `assets/reads.js`; extend `EPCReportGate.wire`. Style `.epc-cost-line` like `.gen-status` (muted, 0.875rem) and the confirm like `.epc-loading-card`.

- [ ] **Step 4: First two cost lines.** Reports: `<span id="rep-cost-line" class="epc-cost-line"></span>` after `rep-gen-status` in `pages/reports.html`; both report buttons pass `costLine: 'rep-cost-line'` and `estimate` = saved parts for the active tab's `REPORT_TAB_COLLECTIONS` plus `{ days: 'salesDaily'|'inventoryDaily', from, to }` for range-scoped ones (Reload all data: `counts`-based parts, i.e. a full load). Fire `epc-cost-change` on date input change and tab switch. Dashboard: same beside its Generate button with the day-range parts it already knows.

- [ ] **Step 5: Manual check in the emulator** (`npx -y firebase-tools@latest emulators:start`): open Reports, the line shows `≈ N reads · 0 used today on this browser`; click Generate; the line's "used" rises by the real count; set a 3-year custom range and confirm the pop-up appears with the breakdown. Note the numbers seen.

- [ ] **Step 6: Commit** `git commit -am "Reads: count every Firestore read, cost line and confirm on Generate"`.

---

### Task 3: `EPCDays`: one reader for day docs, with a per-user day store

**Files:**
- Create: `assets/days.js`
- Create: `tests/days.test.js`
- Modify: `pages/reports.js` (replace `readDailyRollupDocs`, `salesRollupRows`, `inventoryRollupRows`, `_reportDayCache` with `EPCDays`), `pages/reports.html`, every `pages/*.html` that will use it (add `<script src="../assets/days.js?v=20261120-reads">` after `app.js`)

**Interfaces:**
- Produces (on `EPCDays`):
  - `docs(collection, from, to, { offline = false } = {}) -> Promise<{ days: { date: data }, missing: string[] }>`: `collection` is `'salesDaily'` or `'inventoryDaily'`. Online: returns stored days for the range after a sync (`where('lastUpdated', '>', newestStamp)` plus `firestoreCount(where(documentId(), '>=', from).where(documentId(), '<=', to))`; a count mismatch refetches the range month by month as `readDailyRollupDocs` did). Days never read are fetched month by month. Offline: store only, `missing` = calendar days in range not in the store (only days that exist in Firestore can be known online, so offline `missing` lists dates in the range absent from the store, and the caller words it "not in the saved copy").
  - `all(collection, opts) -> Promise<same>`: `from = await firstDay(collection)`, `to = today (Manila)`.
  - `firstDay(collection) -> Promise<string>`: `orderBy(documentId()).limit(1)`, cached in `localStorage['epc_first_day:<collection>']`.
  - `salesRows(days) -> row[]` and `inventoryRows(days) -> row[]`: the current `salesRollupRows` / `inventoryRollupRows` logic over `{ date: data }`.
  - `estimateParts(collection, from, to) -> parts`: `[{ days: collection, from, to }]` using the store's known dates (so `EPCReads.estimate` can price it); `EPCReads.state().daysCached` reads the store's key list.
  - `exportAll() -> Promise<{ salesDaily: {date: data}, inventoryDaily: {...} }>` and `importAll(obj) -> Promise<void>` (used by Task 10).
  - Store: IndexedDB `epc-cache`/`kv`, key `days:<collection>`, value `{ v: 1, uid, stamp: {s,n}, days: { date: data } }`, Timestamp fields encoded like `EPCSaved` (reuse its `encode`/`decode` by exposing `EPCSaved._codec = { encode, decode }`).
  - Pure helpers for tests: `monthParts(from, to) -> [[from, to], ...]` (current logic), `missingDays(days, from, to) -> string[]`, `newestStamp(days) -> {s,n}|null`.

- [ ] **Step 1: Write the failing tests** in `tests/days.test.js`: `monthParts splits across months and years` (2025-12-15 → 2026-02-03 gives 3 parts with the right bounds), `missingDays lists dates absent from the store`, `offline lists missing days` (call `docs` with an injected fake store and `offline: true`; assert no fake-db method was called and `missing` equals the gaps), `newestStamp picks the latest lastUpdated`.

- [ ] **Step 2: Run** `node --test tests/` **and confirm the new tests fail.**

- [ ] **Step 3: Implement `assets/days.js`.** Dependencies injected through `EPCDays._init({ db, store, firestoreCount, reads, now })` with browser defaults; the store interface is `{ get(key), put(key, value) }` backed by the same `cacheStore` pattern as `EPCSaved`.

- [ ] **Step 4: Run** `node --test tests/` **and confirm all pass.**

- [ ] **Step 5: Reports uses it.** `fetchSalesRollupRows`/`fetchInventoryRollupRows` call `EPCDays.docs(...)` then `salesRows`/`inventoryRows`; delete `readDailyRollupDocs`, `_reportDayCache`, `salesRollupRows`, `inventoryRollupRows` from `reports.js`; `loadSalesPreviousPeriod` and `loadSalesPriorInflow` go through `EPCDays.docs` too. Generate Report must still show fresh data (sync runs on every call); "Reload all data" passes `{ force: true }` which drops the store for the range before fetching.

- [ ] **Step 6: Manual check:** Reports year-to-date figures are unchanged from before the change (compare the Overview totals with the numbers noted in Task 2 Step 5); a second Generate costs 2–3 reads on the cost line.

- [ ] **Step 7: Commit** `git commit -am "Days: shared salesDaily/inventoryDaily reader with a saved day store"`.

---

### Task 4: Shared loaders on saved copies; three more collections stamped

**Files:**
- Modify: `assets/app.js` (`SOURCES`, `loadProductMasterFromFirestore` 1269, `loadSuppliersFromFirestore` 1335, `loadInventoryFromFirestore` 1344, `loadSupplierListFromFirestore` 1730, `replaceProductMasterInFirestore` 1231 stays)
- Modify (stamping): `pages/chart-of-accounts.js:65,67,77,89`, `pages/expenses.js:82`, `pages/suppliers.js:45`, `pages/inventory-tracking.js:898,1218,2731,3072,3090`, `pages/product-master.js` (`syncInventoryAssignmentInBackground` batch updates at ~596)

**Interfaces:**
- Produces: `SOURCES` gains `inventoryData: {}`, `suppliers: {}`, `expenseAccounts: {}`. The four loaders return the same row shapes as today but from `EPCSaved.rows(name)`; `loadProductMasterFromFirestore(orderByField)` sorts in JS by that field. `EPCSaved.rows(name, { force, offline })` (`offline` is wired in Task 9; accept and ignore for now).

- [ ] **Step 1: Switch the four loaders** to `EPCSaved.rows`. Keep `DB.set(...)` mirrors and `cacheProductMasterRows` as they are. `loadSupplierListFromFirestore(storeKey)` uses `EPCSaved` only for `'suppliers'`; other store keys keep the direct read (counted).

- [ ] **Step 2: Stamp every write** listed above with `epcStamp(...)`. Re-run `grep -rnE "collection\('(inventoryData|suppliers|expenseAccounts)'\)" pages assets | grep -E "\.(add|set|update)\(" | grep -v epcStamp` and confirm no hits; also check `batch.update(doc.ref, ...)` sites on those collections by reading `product-master.js` around line 596.

- [ ] **Step 3: Manual check:** open Suppliers twice; the second open's cost line shows about 2 reads. Add a supplier in one browser; in a second browser profile open Suppliers: the new supplier appears (sync by `changedAt`).

- [ ] **Step 4: Commit** `git commit -am "Saved copies: inventory, suppliers and expense accounts; shared loaders use them"`.

---

### Task 5: Product Master on demand

**Files:**
- Modify: `pages/product-master.js` (init block 891-922, `rebuildProductStockIndex` 46-61, `deleteProductMasterRows` 340-362, `syncSalesDataCategoryInBackground` 562-578), `pages/product-master.html` (toolbar near line 30, catalog view at 53)

**Interfaces:**
- Consumes: `EPCSaved.rows('productMaster'|'inventoryData'|'suppliers')` through the Task 4 loaders; `EPCDays.all('salesDaily')`, `EPCDays.salesRows`; `EPCReportGate.wire({ estimate, costLine })`.
- Produces: `_pmSalesRows` built from `EPCDays.salesRows(days)` (rows carry `itemCode`, `unitsSold`), so `rebuildProductStockIndex` is unchanged.

- [ ] **Step 1: HTML.** Add `<button class="btn btn-primary" id="pm-generate-btn" type="button">Generate</button>` and `<span id="pm-cost-line" class="epc-cost-line"></span>` to the toolbar; add `<div class="report-empty-state" id="pm-empty-state">Click <strong>Generate</strong> to load the products.</div>` before the table; the table and search are hidden until loaded (toggle a `pm-loaded` class on `#product-catalog-view`).

- [ ] **Step 2: Load on demand.** Replace the page-open `Promise.all([...])` with `EPCReportGate.wire({ button: 'pm-generate-btn', costLine: 'pm-cost-line', status: null, estimate: () => [{ saved: 'suppliers' }, { saved: 'productMaster' }, { saved: 'inventoryData' }, ...EPCDays.estimateParts('salesDaily', firstDay, today)], load })` where `load` runs the same four loads with the `salesData` read replaced by `EPCDays.all('salesDaily')` → `EPCDays.salesRows`, then the existing `.then` body. `openProductFromURL()` (deep links from other pages) triggers the gate's `run()` once instead of waiting for a click. The page-open `getProductMaster(); ... renderTable()` lines stay (they draw the local mirror, no reads).

- [ ] **Step 3: Delete without re-reading.** `deleteProductMasterRows`: build `documents` from `products` with `_firestoreId` (`db.collection('productMaster').doc(id)` refs), and for selected products without an id, from the saved copy (`EPCSaved.rows('productMaster')`, matching by code). Remove the `db.collection('productMaster').get()`.

- [ ] **Step 4: Remove `syncSalesDataCategoryInBackground`** and its call (it updates raw `salesData`, which nothing reads; `backfillSalesCategories` in Reports takes category from the Product Master).

- [ ] **Step 5: Manual check:** page open makes no Firestore read (cost line "used" does not move); Generate shows the pop-up on the first load (over 1,000) with "Sales days: first load on this browser, about N"; after it, units sold and on hand match the numbers the page showed before this change for three products you note beforehand; a second Generate is about 8 reads.

- [ ] **Step 6: Commit** `git commit -am "Product Master: load on Generate from saved copies and sales days"`.

---

### Task 6: Potential Revenue and Income Statement on the day summaries

**Files:**
- Modify: `pages/potential-revenue.js` (`watchSalesOutgoing` 131-136, `watchPotentialProductMaster` 138-144, gate at 782-796), `pages/potential-revenue.html:28-29`
- Modify: `pages/income-statement.js` (`loadISData` 12-30, `renderIS` 38-95, gate 139-145), `pages/income-statement.html` (lines 56-75 revenue block)

**Interfaces:**
- Consumes: `EPCDays.all('salesDaily')`, `EPCDays.docs('salesDaily', from, to)`, `EPCDays.salesRows`, `EPCSaved.rows('purchases')`, Task 4 loaders.

- [ ] **Step 1: Potential Revenue.** `watchSalesOutgoing` becomes `EPCDays.all('salesDaily')` → `applySalesOutgoing(EPCDays.salesRows(days))` (rows have `itemCode`, `unitsSold`, `totalRevenue`, `date`, `unitCost`, `totalCost`, `productName`, which `saleToOutgoingRow` and `salesRevenueValue` already read). `watchPotentialProductMaster` uses `loadProductMasterFromFirestore()`. Gate gets `costLine: 'potential-cost-line'` (new span after `potential-gen-status`) and `estimate` = saved parts for `inventoryData`, `productMaster` plus `EPCDays.estimateParts('salesDaily', firstDay, today)`.

- [ ] **Step 2: Income Statement.** `loadISData` loads `EPCDays.docs('salesDaily', '<period>-01', '<period>-31')` and `EPCSaved.rows('purchases')` for the selected month; `_isReviewRows` is removed. `renderIS`: `revenue = Σ products[code].revenue`, `cogs = Σ products[code].cost` where present; the pending note reads `Σ awaitingCostItemCount` / `Σ awaitingCostRevenue` over the month's docs and says `N items (₱X revenue) have no cost yet. COGS and Gross Profit are understated until costs are matched on Inventory Tracking.`; `netRevenue` = `revenue`. HTML: delete the Gross revenue, Discounts and SR/PWD rows; rename the remaining row **Revenue** (`id="is-net-revenue"` keeps its id). The month picker `change` fires `epc-cost-change`; the gate gets `costLine: 'is-cost-line'` and `estimate: () => EPCDays.estimateParts('salesDaily', monthStart, monthEnd)` plus `{ saved: 'purchases' }`, `{ saved: 'expenses' }`.

- [ ] **Step 3: Manual check:** Potential Revenue's average selling price for three products matches the Sales analysis (Reports) for an all-time range; Income Statement Revenue for last month equals Reports' Sales analysis "Sales" for the same month.

- [ ] **Step 4: Commit** `git commit -am "Potential Revenue and Income Statement: day summaries instead of raw sales"`.

---

### Task 7: List pages on saved copies, with cost lines

**Files:**
- Modify: `pages/expenses.js:20-30,126-133`, `pages/supplies.js:76-86,272-282`, `pages/suppliers.js` (page-open load, and the delete at 398 to use `_firestoreId`s), `pages/chart-of-accounts.js:40-55,126-138`, `pages/tax-monitoring.js:352-356`, `pages/e-sales.js:93-96`, and each page's `.html` (a `<span id="<page>-cost-line" class="epc-cost-line">` in the toolbar)

**Interfaces:**
- Consumes: `EPCSaved.rows(name)` for `expenses`, `expenseAccounts`, `suppliesData`, `suppliers`, `eSalesRecords`; `EPCReads.line(el, partsFn)` directly (these pages load on open, no gate).

- [ ] **Step 1: Replace each `db.collection(name).get()`** listed with `EPCSaved.rows(name)`, keeping the row mapping (`id`/`_firestoreId` fields) and `DB.set` mirrors. The seeded-marker doc in `expenseAccounts` is filtered by id as today.

- [ ] **Step 2: Cost line** on each page: `EPCReads.line(el, () => [{ saved: '<name>' }, ...])` at load and after each save/delete.

- [ ] **Step 3: Manual check:** each page opens with about 2 reads on the second open; adding a record on one page shows up on Reports (stamped) and on a second browser profile.

- [ ] **Step 4: Commit** `git commit -am "List pages: load from saved copies with a cost line"`.

---

### Task 8: Inventory Tracking and imports

**Files:**
- Modify: `pages/inventory-tracking.js` (`matchSalesCostsFromInventory` 3267-3290; delete `countInventorySalesRows`, `fetchSalesRowsForInventoryRematch`, `rematchInventoryAgainstSales`, `setInventorySalesRematchProgress`, `hideInventorySalesRematchProgress`, `INVENTORY_SALES_REMATCH_PAGE_SIZE` and the listener at 1894: the button no longer exists in the HTML, so this is dead code), `pages/inventory-tracking.html:35`
- Modify: `assets/import-mapper.js:423-435` (`loadInventoryCostMap`)

- [ ] **Step 1: Cost matching.** `itemCost` from `EPCSaved.rows('itemCost')` (unit costs only, already in `SOURCES`); candidate days from `db.collection('salesDaily').where('awaitingCostItemCount', '>', 0).get()` (counted). Wire `btn-match-costs` through `EPCReads.confirm([{ saved: 'itemCost' }, { fixed: lastKnownAwaitingDays || 50 }])` and a cost line `inv-cost-line` beside it; store the awaiting-day count in `localStorage['epc_counts']` under `awaitingDays` after each run.

- [ ] **Step 2: Delete the dead Re-match Sales code** listed above. Confirm with `grep -n "rematchInventoryAgainstSales\|salesData" pages/inventory-tracking.js` → no hits.

- [ ] **Step 3: Imports.** `loadInventoryCostMap(db)` builds its map from `EPCSaved.rows('inventoryData')`.

- [ ] **Step 4: Manual check:** Match Sales Costs on a test day marked awaiting applies the cost and the day's `awaitingCostItemCount` drops; the sales import still fills costs.

- [ ] **Step 5: Commit** `git commit -am "Inventory Tracking: cost matching from saved copies; drop dead raw-sales re-match"`.

---

### Task 9: Offline mode on Reports

**Files:**
- Modify: `assets/app.js` (`EPCSaved.rows` option `offline`), `assets/days.js` (already supports `offline`), `pages/reports.js`, `pages/reports.html:51-53`, `assets/style.css`
- Modify: `tests/reads.test.js` (one test: `format` with `offline: true` returns `'0 reads (offline)'`)

**Interfaces:**
- Produces: `EPCSaved.rows(name, { offline: true })` returns the saved copy without any Firebase call, or throws `Error('No saved copy of <name> on this browser. Turn Offline off, or Load from file.')`. `EPCReads.format(reads, used, { offline })`. `window.EPC_OFFLINE` boolean, read from `localStorage['epc_offline'] === '1'`, toggled by the switch.

- [ ] **Step 1: Test** for `format(..., { offline: true })`; run, see it fail; implement; pass.

- [ ] **Step 2: Offline in the loaders.** `EPCSaved.load(name, force, offline)`: when `offline`, skip `sync`/`fetchAll`. `EPCDays.docs` already handles `offline`. Reports passes `offline: window.EPC_OFFLINE` everywhere it loads; `loadReportItemCostMap` too.

- [ ] **Step 3: Switch and notice.** `<label class="epc-switch"><input type="checkbox" id="rep-offline"> Offline (saved copy only)</label>` after Reload all data; Reload all data is disabled while on. After Generate, when `missing.length`, show above the report: `Offline: N days not in the saved copy (<up to 10 dates, Manila short form>, …)`. Cost line shows `0 reads (offline)`. Quota errors cannot occur offline; do not call `EPCQuota.report` for offline loads.

- [ ] **Step 4: Manual check:** with DevTools set to Offline, Generate Report renders year to date from the store; the notice lists exactly the days never loaded; the counter's "used" does not move.

- [ ] **Step 5: Commit** `git commit -am "Reports: Offline mode from the saved copy"`.

---

### Task 10: Download all data and Load from file

**Files:**
- Modify: `assets/days.js` (`exportAll`, `importAll` already named in Task 3), `assets/app.js` (`EPCSaved.exportAll() -> { name: saved }`, `EPCSaved.importAll(obj)`), new `assets/datafile.js` (`EPCDataFile`), `tests/datafile.test.js`, `pages/reports.html`, `pages/settings.html` (a third card **Your saved data**), `.gitignore`, `firebase.json` ignore list
- Load `datafile.js` on `reports.html` and `settings.html` only.

**Interfaces:**
- Produces (on `EPCDataFile`):
  - `build(uid, saved, days, now) -> { v: 1, uid, at, saved, days }` (pure).
  - `describe(file) -> { records, days, from, to }` (pure; counts per saved copy and date range of `days.salesDaily`).
  - `validate(file, uid) -> { ok: true } | { ok: false, reason }` (pure): `reason` is `'This file was downloaded by another account.'` on uid mismatch, `'This is not an EPC data file.'` when `v !== 1`.
  - `download() -> Promise<void>`: builds from `EPCSaved.exportAll()` + `EPCDays.exportAll()` and saves `epc-data-<yyyy-mm-dd>.json` via `<a download>`.
  - `load(fileInput) -> Promise<void>`: reads the chosen file, `validate`, `confirm` with `describe` counts, then `EPCSaved.importAll` + `EPCDays.importAll`.

- [ ] **Step 1: Tests** in `tests/datafile.test.js`: `build has version 1 and the uid`, `describe counts records and the day range`, `importFile refuses another user's file` (`validate` returns the exact reason and the fake store is untouched), `validate rejects an unknown version`.

- [ ] **Step 2: Run, fail, implement `assets/datafile.js`, pass.**

- [ ] **Step 3: Buttons.** Reports toolbar: **Download all data** (`rep-download-data`, tooltip from `describe`) and **Load from file** (`rep-load-data`, a hidden `<input type="file" accept="application/json">`). Settings: the same two in a new card. Both call `EPCDataFile`.

- [ ] **Step 4: Ignore rules.** Add `epc-data-*.json` to `.gitignore` and to `firebase.json` hosting `ignore`.

- [ ] **Step 5: Manual check:** Download on browser A; in a fresh browser profile B signed in as the same user, Load from file, then Generate Report in Offline mode shows the same year-to-date totals as A. Loading A's file while signed in as another user shows the exact refusal text.

- [ ] **Step 6: Commit** `git commit -am "Data file: download all saved data and load it on another browser"`.

---

### Task 11: Fallback counts, cache tags and docs

**Files:**
- Create: `scripts/count-collections.js` (admin SDK, reads `serviceAccountKey*.json` locally, prints `count()` per collection in `FALLBACK` and `salesDaily`/`inventoryDaily` day counts; run after the daily reset)
- Modify: `assets/reads.js` (`FALLBACK` values from the script's output), all `pages/*.html` cache tags (`20261120-reads` on every changed `.js`/`.css`), `CLAUDE.md`, `PROJECT-NOTES.md`

- [ ] **Step 1: Run** `node scripts/count-collections.js` (after 4 PM Manila) and paste the figures into `FALLBACK`; run `node --test tests/` → pass.

- [ ] **Step 2: Cache tags.** `grep -rn "?v=" pages/*.html | grep -v 20261120-reads` lists only files this branch did not change.

- [ ] **Step 3: Docs.** `CLAUDE.md`: new section "Read counter and cost lines" (rule: every Firestore read reports `EPCReads.countSnap`/`spent`; every Generate has an `estimate`), "Day docs: `EPCDays`", update "Saved copies" covered list and the per-page notes (Product Master on Generate; Income Statement single Revenue line; Offline mode; data file; Under Review is legacy). `PROJECT-NOTES.md`: move "Cut Firestore reads on the other pages" to done; note that raw `salesData`/`underReviewData` are no longer read by any page and could be archived and deleted later (owner's call).

- [ ] **Step 4: Final check.** `node --test tests/` passes; `git status` shows no `.env`, keys or `epc-data-*.json`; every page opens in the emulator without console errors.

- [ ] **Step 5: Commit** `git commit -am "Docs and cache tags for the read budget work"`.
