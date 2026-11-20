# Read budget, Product Master on demand, offline Reports and data file

Date: 2026-11-20. Status: reviewed by a builder check; owner's answers folded in; awaiting the owner's approval.

## Why

On 2026-11-20 the free Firestore allowance (50,000 reads per day, Spark plan) was
used up before 8:31 AM Philippine time, and the owner could not run a
year-to-date Income Statement on Reports, which itself costs well under 1,000
reads. The culprits are pages that still read whole collections on open or on
Generate, above all the raw `salesData` collection (430,000+ records as of
July 2026; one open of Product Master is about nine days of allowance).

The owner wants three things:

1. **Nothing heavy loads by itself.** Product Master loads on demand (a Generate
   button), and every page that loads data shows, before the click, how many
   reads it will cost against the daily limit.
2. **Reports can work offline** from the copy the browser already keeps.
3. **The data can be downloaded as a file and loaded back** on another
   computer, so a new browser does not pay a full first load.

The owner chose: read counts are **per browser only** (no shared team counter),
and **way 2** for the warnings: an always-visible cost line beside each
Generate button, and a confirm pop-up only when a click is big.

## Goals

- No page reads the whole raw `salesData` or `underReviewData` collection
  anymore. Units sold and revenue per product come from the per-day sales
  summaries (`salesDaily`, `products` map per day: `name`, `units`, `revenue`,
  and after cost matching `unit_cost`, `cost`, `profit`; category comes from
  the Product Master saved copy, as Reports does). The Sales page's paged,
  limited reads and writes of `salesData`/`underReviewData` are out of scope.
- The `salesDaily` day docs are the complete record of sales: the current
  importer writes every line there (see section 3, "Under Review is legacy").
- Every data load on the site goes through the shared loader in
  `assets/app.js` (`EPCSaved.rows` for whole collections, the day-doc readers
  for `salesDaily`/`inventoryDaily`), so it is counted and estimated.
- Before any Generate click the user sees "≈ N reads · M used today on this
  browser". If N is over 1,000 or M + N would pass 50,000, a confirm pop-up
  appears first.
- Reports gets an **Offline** switch: use the saved copy only, no Firebase
  calls, and say which days in the range are missing.
- **Download all data** writes one file with all saved copies and all loaded
  day summaries; **Load from file** fills a browser's saved copies from it.

## Non-goals

- A shared, team-wide read counter (rejected by the owner: per browser only).
- Knowing the true reads used today. Firebase does not expose it to the
  website. The count is this browser's own spend since the last reset.
- Offline editing. Pages that add or change records still need Firebase.
- Rebuilding the Product Master "replace all" save (listed in PROJECT-NOTES
  as future work; out of scope here).
- Any change to the chat server.

## Anti-goals (would make this a failure even if it works)

- A pop-up on every routine click. The pop-up must be rare (big loads only).
- Any new read that runs on page open without a click.
- The data file ever reaching git, Firebase Hosting or any outside service.
- Totals that silently differ from today's figures because `salesData` rows
  were replaced by day summaries. Where a figure cannot be derived from the
  summaries, the page must say so rather than show a smaller number.

## Constraints (from the project)

- Vanilla HTML/CSS/JS, no build step, Firebase compat SDK 10.13.2 (no
  `query.count()`; use `firestoreCount`).
- Free Spark plan, 50,000 reads per day for everyone, reset at midnight US
  Pacific (about 4 PM Manila). `EPCQuota.nextReset` already computes it.
- Saved copies live in IndexedDB `epc-cache`, per signed-in user
  (`EPCSaved` in `assets/app.js`, `SOURCES` list). Every site write to a
  covered collection must use `epcStamp(...)`.
- Day documents (`salesDaily`, `inventoryDaily`) are read one per day; both
  importers stamp `lastUpdated`.
- Bump the `?v=` cache tag on every changed `.js`/`.css`.
- Work on a branch, never on `main`; the owner pushes and asks for the merge.
- Plain wording in the UI, as if to a 10-year-old.

## Approaches considered

**Way 1: confirm pop-up before every click.** Matches "all should have
warnings" literally, but a pop-up for a 2-read click dozens of times a day
trains people to click OK blindly. Rejected.

**Way 2 (chosen): cost line always visible, pop-up only when big.** A small
line beside each Generate button shows "≈ N reads · M used today on this
browser" and updates before the click. A confirm pop-up appears only when N >
1,000 or M + N > 50,000. First loads on a new browser get the pop-up, routine
clicks do not.

**Way 3: count only after the fact.** A spend counter with no estimate. Cheap,
but does not warn before the click, which is the point. Rejected.

## Design

### 1. Read counter and estimate (`EPCReads` in `assets/app.js`)

- `EPCReads.spent(n, label)`: adds `n` to this browser's count for the current
  quota day, stored in `localStorage` as `epc_reads` = `{ day: <reset ms>,
  total, byLabel }`. When `Date.now()` is past `day`, the count starts again
  at 0 (same reset clock as `EPCQuota`).
- My call: the counter is the browser's **whole** spend, not only the gated
  loads. Besides the shared paths below, every remaining `.get()` in `pages/`
  and `assets/` (Sales page paged reads, Purchases limited queries, Inventory
  Tracking day pages and per-date queries, Product Master per-item queries,
  Audit Log, Employees, Payroll, Dashboard inventory by date) reports
  `EPCReads.spent(snap.size || 1, label)` right after it resolves, and each
  `firestoreCount` or aggregate call reports 1 per 1,000 counted. The sweep
  is one step in the order of work (grep `.get()` and `aggregate`), and
  CLAUDE.md states the rule for new code.
- Every Firestore read path in `assets/app.js` reports its real document count:
  `EPCSaved` (full load: docs returned; sync: changed docs + 1 for the count +
  1 per extra 1,000 records), `firestoreCount` (1 per 1,000 records counted, at
  least 1), the Reports day-doc readers and the Dashboard Sales Pulse reader
  (docs returned, and the day-count check). A query that returns 0 documents
  still costs 1 read; count it as 1.
- `EPCReads.estimate(parts)`: returns `{ reads, breakdown }` for a planned
  load without touching Firebase. `parts` is a list of:
  - `{ saved: '<name>' }`: 2 if a saved copy exists for the signed-in user
    and is under 7 days old (change check + count), plus 1 per extra 1,000
    records in the copy; otherwise the last known record count for that
    collection (kept in `localStorage` `epc_counts` from the last full load
    or count), or the fallback figures below when the browser has never seen
    it.
  - `{ days: '<collection>', from, to }`: the number of calendar days in the
    range not already in this page view's day cache (Reports
    `_reportDayCache`, Dashboard IndexedDB pack), plus 2 for the "did any
    day change" check when the days are cached.
  - `{ fixed: n }`: a plain number for anything else.
- Fallback figures when nothing is known yet (first ever load on a browser):
  `productMaster` 5,000, `inventoryData` 8,000, `itemCost` 5,000,
  `purchases` 3,000, `expenses` 2,000, `suppliesData` 1,000, `eSalesRecords`
  1,000, `suppliers` 200, `expenseAccounts` 100, day docs 1 per day. The
  builder refreshes these from a quick count script before shipping; they
  only matter until the first load stores real counts.
- `EPCReads.line(el, parts)`: writes "≈ 2 reads · 1,240 used today on this
  browser" into `el`. "reads" is singular for 1. Over 1,000 the number shows
  with a thousands separator. The line is refreshed when the page's date
  inputs change and after every load.
- `EPCReads.confirm(parts)`: resolves `true` without asking when the estimate
  is ≤ 1,000 and `used + estimate` ≤ 50,000. Otherwise shows the site's
  standard modal (same style as the loading pop-up) with: the estimate, the
  used count, the 50,000 limit, the reset time (`EPCQuota.resetText()`), one
  line per part of the breakdown in plain words ("Products: first load on
  this browser, about 4,700"), and buttons **Load anyway** / **Not now**.
  If the quota is already hit today (`EPCQuota.active()`), the pop-up says so
  and the primary button is **Wait until 4 PM** (closes).
- `EPCReportGate.wire` gains two options: `estimate: () => parts` and
  `costLine: '<element id>'`. The gate draws the line at wire time and before
  each run, and calls `EPCReads.confirm` before `load()`; a "Not now" leaves
  the button idle.

### 2. Pages moved onto the shared loader

Each page below loses its own `db.collection(...).get()` on open, gets a
Generate (or keeps its existing one) wired through `EPCReportGate` with an
estimate and a cost line, and reads through `EPCSaved.rows` or the day-doc
readers. Collections added to `SOURCES`: `inventoryData`, `suppliers`,
`expenseAccounts`. Every site write to those three gets `epcStamp(...)`
(grep for `.add(`, `.set(`, `.update(` and batch writes on them, including
`assets/app.js`, `pages/inventory-tracking.js`, `pages/suppliers.js`,
`pages/chart-of-accounts.js`, `pages/product-master.js`,
`assets/import-mapper.js`).

| Page | Today | After |
|---|---|---|
| Product Master | On open: all raw `salesData`, all `inventoryData`, all `productMaster`, all `suppliers` | Nothing on open. A **Generate** button loads products, inventory and suppliers from saved copies, and units sold from `salesDaily` day docs (see 3). Search and the table work only after Generate; before it, the table area shows "Click Generate to load the products" and the cost line. Add/Edit/Delete of a product still works after Generate. My call: Delete finds its documents in the saved copy (`_firestoreId`) instead of re-reading all products (`deleteProductMasterRows` today reads the whole collection); the per-item-code queries on category edit stay but are counted; any read-heavy action over 1,000 estimated reads goes through `EPCReads.confirm` like a Generate. |
| Potential Revenue | On Generate: all raw `salesData`, all `productMaster`, all `inventoryData` | Same figures from saved copies and `salesDaily` day docs over a date range (see 3). |
| Income Statement | On open: all raw `salesData` and `underReviewData` | Revenue for the chosen month from `salesDaily` day docs of that month (one read per day) through `EPCDays`. Owner's decision (2026-11-20): one **Revenue** line; the Gross revenue, Discounts, SR/PWD discounts and Net revenue lines are removed, as is any under-review figure (remove the labels, do not show 0). The "pending cost entry" note is rebuilt from the day docs' `awaitingCostItemCount` / `awaitingCostRevenue`. COGS covers only costed products, as in Reports. Purchases from the saved copy. Loads on a Generate button with the month picker, not on open. |
| Expenses, Supplies, Suppliers, Chart of Accounts, Tax Monitoring, E-Sales | Whole collection on open | Same data from `EPCSaved.rows`. These pages are lists people edit, so they keep loading on open (no Generate button), but through the saved copy: about 2 reads instead of the whole collection. Each page shows the cost line near its title or toolbar ("≈ 2 reads · …") so the owner can see it, with no pop-up unless the first-load estimate is over 1,000. |
| Inventory Tracking, cost matching | All `itemCost` and all `salesDaily` days | `itemCost` from the saved copy. Days from `salesDaily.where('awaitingCostItemCount', '>', 0)` (needs no new index: single-field). Cost line and confirm on the matching button. |
| Inventory Tracking, **Re-match Sales** button (`rematchInventoryAgainstSales`) | Pages through all raw `salesData` to derive one Outgoing row per sale and the per-item average selling price | Owner's decision (2026-11-20): rebuild from `salesDaily` through `EPCDays` for the page's date window: one derived Outgoing row per product per day (not per sale), average selling price = revenue ÷ units over that window. Cost line and confirm on the button. |
| Imports (`assets/import-mapper.js`) | All `inventoryData` for the cost map | `inventoryData` from the saved copy. |

### 3. Units sold without raw `salesData`

Product Master shows units sold, units out and on hand per product; Potential
Revenue needs units and revenue per product for its average selling price.
Both are sums over days. They take the sales days from `salesDaily` through
the same month-split reader Reports uses (move `readDailyRollupDocs` and
`salesRollupRows` from `pages/reports.js` into `assets/app.js` as
`EPCDays.sales(from, to)` and reuse them in Reports too), with an in-page day
cache so switching pages in one session does not pay twice.

**Units on hand** (owner's decision, 2026-11-20): on hand stays "all units
received minus all units ever sold". So Product Master and Potential Revenue
load **every** `salesDaily` day from the earliest day to today through
`EPCDays`, and `EPCDays` keeps every day it has read in the per-user
IndexedDB day store (`days:salesDaily`, see Offline mode). After the first
load on a browser, a later load fetches only days whose `lastUpdated` is
newer than the newest stamp in the store, plus 1 read to count the days
(deleted uploads), the same way the Dashboard Sales Pulse does: about 2
reads. The first load costs one read per day of history, and the cost line
says so before the click. The earliest day is found with one query:
`orderBy(documentId()).limit(1)`, cached in `localStorage` `epc_first_sales_day`.
The pages show all-time units sold and on hand; no date pickers are added.

**Under Review is legacy.** The current sales importer (`importSales` in
`assets/import-mapper.js`) writes every imported line into `salesDaily`,
matched or not, and nothing creates `underReviewData` records anymore. The
Under Review tab on the Sales page holds leftovers from the old importer; its
Re-match button moves them into raw `salesData`, which no report reads. Both
stay untouched (the Sales page is out of scope). No sale is missing from the
day summaries, so no merge helper or backfill script is needed.

### 4. Offline mode on Reports

- A switch **Offline (saved copy only)** beside Reload all data, remembered in
  `localStorage` `epc_offline`. The cost line shows "0 reads (offline)" while
  it is on.
- While on, Generate Report makes no Firebase call: `EPCSaved.rows` returns
  the saved copy as is (new option `{ offline: true }`; if there is no copy it
  throws "No saved copy of <name> on this browser. Turn Offline off, or Load
  from file."), and the day-doc readers take days from a new per-user
  IndexedDB store `days:<collection>` that every online day read also fills
  (keyed by date; doc data as stored). Days not in the store are listed in a
  notice above the report: "Offline: 3 days missing from the saved copy (Nov
  4, Nov 12, Nov 18)". The report still renders with what it has.
- The Dashboard Sales Pulse already works from its own saved pack; it is not
  changed.
- The quota bar is not shown for offline loads (they cannot hit it).

### 5. Download all data / Load from file

- **Download all data** (button beside Reload all data on Reports, also on
  Settings): writes `epc-data-<yyyy-mm-dd>.json` to the browser's downloads
  (`<a download>`). Content: `{ v: 1, uid, at, saved: { <name>: <saved copy as
  stored> }, days: { salesDaily: {date: doc}, inventoryDaily: {...} } }`.
  Only the saved copies and day stores present on this browser go in; the
  button's tooltip says how many records and days it will contain and the
  date range of the days. It makes no Firebase call; to get a complete file
  the owner runs Reload all data and a long-range Generate first (the cost
  line tells the price).
- **Load from file**: `<input type="file">`. Checks `v` and that `uid` matches
  the signed-in user (a different user's file is refused with "This file was
  downloaded by another account"). Writes the saved copies and day stores
  into IndexedDB, replacing what is there. Then the normal "fetch only what
  changed" sync runs on the next load. A confirm shows the file's record
  counts and date before writing.
- The file is business data: no code path uploads it anywhere; add
  `epc-data-*.json` to `.gitignore` and the hosting ignore list in
  `firebase.json` in case it lands in the repo folder.

### 6. Docs

- `CLAUDE.md`: new sections for `EPCReads` (rule: any new Firestore read must
  report its count and have an estimate part), the Product Master Generate
  flow, Offline mode and the data file. Update the "Saved copies" section's
  covered list. Remove raw `salesData` from any description of page reads.
- `PROJECT-NOTES.md`: move "Cut Firestore reads on the other pages" from
  ideas to done, note what is left (Product Master replace-all save).
- Chat server system prompt: no page added or renamed, no change.

## Left to the builder

- Exact look of the cost line and pop-up (follow the existing quota bar and
  loading pop-up styles in `assets/style.css`).
- How the Product Master page keeps Add/Edit/Delete working after Generate
  (the saved copy must be updated or re-synced after a write; the existing
  `epcStamp` + sync covers other browsers; this browser should patch its
  in-memory rows as it does today).
- Where `EPCDays` keeps its in-page cache and how Reports' `_reportDayCache`
  merges into it.
- Order of work: 1 counter, estimate and the `.get()` counting sweep,
  2 `EPCDays` (shared day reader + day store), 3 Product Master and Potential Revenue,
  4 Income Statement, 5 the list pages, 6 Inventory cost matching, Re-match
  Sales and imports, 7 Offline, 8 Download/Load, 9 docs. Each step is a commit; the site must work after every step.
- Tests: there is no test framework. The builder adds a small Node script
  under `scripts/` that exercises `EPCReads.estimate` and the day-range
  maths with fake saved state, and checks each page by hand in the local
  emulator (`npx -y firebase-tools@latest emulators:start`).
