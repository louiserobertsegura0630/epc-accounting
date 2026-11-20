# EPC Accounting Portal

Internal accounting web app for EPC Commercial Corporation. Vanilla HTML/CSS/JS (no framework, no build step) backed by Firebase (Firestore + Auth).

**Also read `PROJECT-NOTES.md`**: the decisions behind this setup (Firebase plan: Blaze since November 2026, the chat assistant on the Hostinger VPS, the design system, limits), lessons learned, ideas agreed but not built yet, and how the owner likes to work.

## Links

| What | URL |
|---|---|
| Live site | https://epc-inventory-system.web.app |
| Firebase console | https://console.firebase.google.com/project/inventory-system-1fb4d |
| GitHub repo | https://github.com/louiserobertsegura0630/epc-accounting |

- Firebase project: `inventory-system-1fb4d` (alias `default` in `.firebaserc`). Old project alias `old` → `palo-grocerette-accounting` (no longer used).
- Hosting site `epc-inventory-system` is mapped to deploy target `app`. The project also has a default site, https://inventory-system-1fb4d.web.app, which is not the one we deploy to.
- GitHub: the repo is `louiserobertsegura0630/epc-accounting` (`origin`). It moved there from `louiserobert921/epc-accounting` in November 2026; that old copy is still the `louiserobert921` remote. Push normally with `git push`.

## Deploying (going live)

Hosting is Firebase Hosting (Classic). It serves the repo root (`public: "."`); the ignore list in `firebase.json` keeps out keys, scripts, backups and `*.js` at the root.

Deploys are automatic (GitHub Actions, set up with `firebase init hosting:github`):
- `.github/workflows/firebase-hosting-merge.yml`: every push to `main` deploys to the live site. It takes about a minute; check the **Actions** tab on GitHub.
- `.github/workflows/firebase-hosting-pull-request.yml`: every pull request gets a temporary preview URL, posted on the PR.
- Both use the GitHub secret `FIREBASE_SERVICE_ACCOUNT_INVENTORY_SYSTEM_1FB4D` (service account `github-action-1259227875`, Firebase Hosting admin). The committed `firebase.json` (target `app`) and `.firebaserc` send it to the `epc-inventory-system` site.

So the steps are:
1. Work on a feature branch, push it to GitHub, open a pull request.
2. Merge it into `main`. The live site updates by itself.
3. Check https://epc-inventory-system.web.app (hard refresh).

The workflows deploy hosting only (the chat API runs on the Hostinger VPS, see AI assistant below). When Firestore rules/indexes change, deploy them by hand: `npx -y firebase-tools@latest deploy --only firestore`. A manual hosting deploy still works if ever needed: `npx -y firebase-tools@latest deploy --only hosting:app`.

## AI assistant (chatbot)

A floating "EPC Assistant" chat button appears on every signed-in page (`initChatWidget` in `assets/app.js`, styles at the end of `assets/style.css`). It stays hidden if `EPC_CHAT_URL` in `assets/app.js` is empty; it is set to `https://epc-chat.187-127-124-15.sslip.io/api/chat`.

The chat API runs on the **Hostinger VPS**, not Firebase (chosen while the Firebase project was on the free Spark plan; it stays there):
- Code: `chat-server/server.js` (Node, no framework). It verifies the user's Firebase ID token with Google's public keys, allows only the portal's own web addresses (CORS: the live site and `epc-inventory-system--*.web.app` previews), limits each user to 30 questions per 10 minutes, and calls Claude (`claude-haiku-5-5`, low effort; chosen for cost) with the Anthropic SDK.
- **The Anthropic API key lives only on the VPS** in `/etc/epc-chat.env` (root-only). Never put it in the website code, git, or a chat.
- Setup or update (as root on the VPS, from a copy of the `chat-server/` folder): `bash setup-vps.sh`. It asks for the key without echoing it and prints the chat API address to put in `EPC_CHAT_URL`.
- **Our VPS (187.127.124.15) runs Coolify**, whose Traefik (`coolify-proxy`) owns ports 80/443 and serves other apps (Supabase, n8n, etc.). The script detects this and runs the chat server as the Docker container `epc-chat` on the `coolify` network (no public port; node:22-alpine, read-only, app mounted from `/opt/epc-chat`) and adds one route file, `/data/coolify/proxy/dynamic/epc-chat.yaml`, for `epc-chat.187-127-124-15.sslip.io` with Let's Encrypt. Nothing Coolify manages is edited. On a VPS without Coolify it uses Node + Caddy as a systemd service instead.
- Copying the folder from a Mac: `scp -r chat-server root@<VPS-IP>:/root/`
- Logs on the VPS: `docker logs -f epc-chat` (Coolify mode) or `journalctl -u epc-chat -f` (plain mode). Each answer logs the user id and token counts.
- **Data lookups** (`chat-server/data-tools.js`): Claude can call read-only tools `get_sales` (salesDaily, ≤31 days), `get_purchases` and `get_expenses` (≤92 days, ≤500 records) and `find_product` (Product Master by exact item code). They read Firestore's REST API **with the signed-in user's own ID token**, so security rules apply as in the portal; no service-account key is used and nothing is written.
- **"Ask about this report"**: after Generate Report, the Reports page (`reportChatSummary` in `pages/reports.js`) and the Dashboard share a compact JSON summary of what they already loaded (per-day sales, top/slowest products, expenses, purchases by supplier, etc.) through `window.EPCChatContext` in `assets/app.js`. The chat panel shows "📊 Using: …" with a "Use it" switch, and the server passes it to Claude as a `<report_data>` block (≤160k chars). No extra Firestore reads.
- **Daily limits** (Philippine date, in memory, reset on restart): 20 data questions per person and 200 for the whole team (`DATA_LIMIT_USER` / `DATA_LIMIT_TOTAL` in `/etc/epc-chat.env`). How-to questions don't count. The same 30-questions-per-10-minutes limit per person also applies.
- The system prompt in `chat-server/server.js` lists the pages, so update it (and re-run `setup-vps.sh`) when pages are added or renamed.
- `chat-server/` is kept out of Firebase Hosting by the `chat-server/**` ignore rule.

Local preview: `npx -y firebase-tools@latest emulators:start` (hosting on port 5050, Firestore on port 8080).

Node note: the local Node is v25. firebase-tools warns that it supports Node 20/22/24, but the commands still work.

## Structure

- `index.html` redirects to `pages/`. Shared code lives in `assets/app.js` and `assets/style.css`, plus `assets/reads.js` (read counter, loaded before `app.js`), `assets/days.js` (day docs reader) and `assets/datafile.js` (download / load the saved data). The Firebase web config is in `assets/app.js`.
- `tests/`: Node tests for the pure shared logic (`npm test`).
- `pages/` holds one HTML page per module (dashboard, purchases, sales, supplies, reports, etc.).
- `firestore.rules`, `firestore.indexes.json`: security rules and indexes.
- Root `*.js` and `scripts/` are Node admin scripts (`firebase-admin`): backups, restores, exports, user creation. They never deploy.
- `chat-server/`: the chat assistant API that runs on the Hostinger VPS. Kept out of Hosting by the `chat-server/**` ignore rule.

## Dashboard: Sales Pulse, season theme, logo intro

- `pages/dashboard-sales.js` + `dashboard-sales.css`: the **Sales Pulse** loads by itself on page open (the rest of the dashboard still waits for Generate Report). The first open on a browser reads the last 92 `salesDaily` day-docs (one read each) and saves them in IndexedDB (`epc-cache`, per signed-in user). After that it shows the saved copy and, at most every 10 minutes, fetches only day-docs whose `lastUpdated` is newer (sales import and cost matching both stamp it) plus a 1-read day count to catch deleted uploads: 2 reads when nothing changed. Any new code that writes `salesDaily` must set `lastUpdated`, or the dashboard will not notice it. The Refresh button reloads all days. It opens on the newest import; after Generate Report (or a date change once generated) `dashboard.js` calls `EPCSalesPulse.showDay(date)` and the pulse redraws for that day (or the last day with sales before it), with the newest import named in the caption. The days are handed to `dashboard.js` (`primeSalesCache`) so Product Performance reuses them. Sales imports are cost-blind, so profit and margin count only products that already have a cost; a day with no costs shows "No costs matched" instead of 100%.
- `pages/dashboard-season.js`: season theme, logo intro and bell tune. The season comes from today's date (script in the head of `dashboard.html`): Sep–Dec Christmas, Jan 1–15 New Year, Feb 1–14 Valentine's, Mar–May summer, Jun–Aug rainy. Preview one with `dashboard.html?season=christmas`. The intro shows once per browser session; Effects and Sound buttons remember the choice in `localStorage`. Sound is made with Web Audio (no audio files), and browsers block it until the user has clicked on the site.
- Chart colours: `EPC_CHART_PASTEL` in `assets/app.js` recolours every chart. A dataset with `__epcPastel: true` keeps its own colours.

## Saved copies: how Reports and the Dashboard keep reads low

Reading whole collections on every Generate click is what used up the free 50,000 daily reads. Now each browser keeps a saved copy and fetches only what changed.

- `EPCSaved` in `assets/app.js`: `await EPCSaved.rows('<name>')` returns every record of a collection from a saved copy in IndexedDB (`epc-cache`, per signed-in user). Each call fetches only records stamped after the saved copy, plus a count to catch deletions: 2 reads when nothing changed (plus 1 per extra 1,000 records). The whole collection is read again only on the first load on a browser, when the count does not match (a record was deleted), when the copy is over 7 days old, or with `{ force: true }`.
- Covered: `purchases`, `expenses`, `suppliesData`, `eSalesRecords`, `productMaster`, `inventoryData`, `suppliers`, `expenseAccounts` (stamp field `changedAt`), `itemCost` (unit costs only, stamp `lastUpdated`) and `salesDayTotals` (one revenue figure per `salesDaily` day, for the Cash Flow opening balance).
- The shared loaders in `assets/app.js` (`loadProductMasterFromFirestore`, `loadSuppliersFromFirestore`, `loadInventoryFromFirestore`, `loadSupplierListFromFirestore` for `suppliers`) read from the saved copies, so every page that calls them is already cheap. `EPCSaved.rows(name, { offline: true })` returns the copy without any Firebase call (used by Reports' Offline mode) or throws "No saved copy of … on this browser".
- **Rule: every site write to `purchases`, `expenses`, `suppliesData`, `eSalesRecords`, `productMaster`, `inventoryData`, `suppliers` or `expenseAccounts` must wrap its data in `epcStamp(...)`** (adds `changedAt: serverTimestamp()`), including `.update()`, `.add()` and batch writes. A write without it is invisible to other browsers until their copy is reloaded. Deletes need nothing. `productMaster.lastUpdated` is a different thing (a cost date string): do not reuse it. Node admin scripts that write these collections should set `changedAt` too, or tell the owner to click **Reload all data**.
- **Dashboard daily summary** (`loadDashData` in `pages/dashboard.js`): purchases, supplies, e-sales and expenses come from `EPCSaved`; inventory reads only the selected day's `inventoryData` rows (by `dateDelivered`); it no longer reads the Product Master (sales days carry product names).
- **Day docs: `EPCDays`** (`assets/days.js`): the one reader for `salesDaily` and `inventoryDaily`. `await EPCDays.docs('salesDaily', from, to)` returns `{ days: { date: data }, missing }` from a per-user day store in IndexedDB (`days:<collection>`): days never read cost 1 read each (one query per month), a range read before costs about 2 (days changed since the newest `lastUpdated`, plus a day count that catches deleted uploads). `EPCDays.all('salesDaily')` reads from the first day ever (`orderBy(documentId()).limit(1)`, remembered in `localStorage`) to today. `EPCDays.salesRows(days)` / `inventoryRows(days)` expand day docs into the per-product-per-day rows the pages expect. `{ offline: true }` uses the store only and lists the days not in it. Both importers stamp `lastUpdated`; any new code that writes a day doc must too.
- **Reports** (`pages/reports.js`): whole collections and item costs come from `EPCSaved`; day docs come from `EPCDays`. **Generate Report** always shows fresh data. **Reload all data** beside it reads everything again and replaces the saved copies; it is the fix when a report looks out of date. In Offline mode (below) a notice above the report lists the days not in the saved copy and Reload all data is disabled.
- **Offline mode, site-wide** (`assets/offline.js`, button **Switch to offline mode** in the sidebar above Logout): stage 1, if the copy on this browser is not complete (no sales days in the day store, or purchases/products not saved) it runs the same download as Settings' Download all data (dates box, read cost, confirm) without writing a file; stage 2, it sets `localStorage` `epc_offline` = `1` and reloads. `assets/reads.js` reads the flag at load into `window.EPC_OFFLINE` and sets `<html data-offline>` before paint (dark grey "incognito" theme in `style.css`, banner at the top). While on, the read wrapper passes `{ source: 'cache' }` to every Firestore `get()`, so every page answers from Firebase's local cache (persistence is enabled in `configureFirestoreDB` with an unlimited cache; if the browser refuses it, `window.EPC_PERSISTENCE` is false and the banner says only Reports and the Dashboard have a copy), `firestoreCount`/`firestoreSum` return `null`, `EPCSaved.rows` and `EPCDays.docs` use their stores, and nothing is counted. Writes still go to Firebase. **Switch back online** clears the flag and reloads. The Sales page's raw receipts are not in the copy, so it shows little offline.
- **Download all data / Load from file** (`assets/datafile.js`, buttons on Settings only; `EPCDataFile.fill()` is the same download without the file, used by the Offline switch): Download first reads everything (every saved copy, every `salesDaily` and `inventoryDaily` day since the first upload, through `EPCSaved.rows` and `EPCDays.all`, with the cost confirmed first; in Offline mode it skips the reads) and writes one file `epc-data-<date>.json`, loaded back on another browser signed in as the same user (a file from another account is refused). It is real business data: `.gitignore` and the Hosting ignore list skip `epc-data-*.json`; nothing uploads it.
- **Product Master** loads nothing on open. **Generate** loads products, inventory and suppliers from the saved copies and units sold from every sales day through `EPCDays.all('salesDaily')`; on hand stays "all received minus all ever sold". A link with `?itemCode=` runs Generate by itself. **Potential Revenue** does the same on its Generate. **Income Statement** reads the chosen month's sales days and shows one Revenue line (no discount lines: the day docs hold none) and a pending-cost note from `awaitingCostItemCount`. Outside the Sales page itself, nothing reads the raw `salesData` or `underReviewData` collections anymore, and the automatic "re-match Under Review" after a new product or an inventory import is gone (it read every product and every under-review record). The Under Review tab on the Sales page is legacy (the current importer writes every line into `salesDaily`); its own button still works, and the Sales page still shows the raw rows' category, which Product Master edits no longer update.
- Reports now always use the full purchases list. Before, they used whatever rows the Purchases page had last left in this browser, so totals could be short.
- **Counting records:** the Firebase SDK build the site loads (compat 10.13.2) has no `query.count()`. Use `firestoreCount(query, label)` from `assets/app.js` (it returns `null` when it could not count). It understands `where()` filters but not `startAt`/`endAt`, so count a range of day docs with `where(documentId(), '>=', from)`.
- New pages that need a whole collection should use `EPCSaved.rows()` instead of `db.collection(name).get()`. To cover another collection, add it to `SOURCES` in `EPCSaved` and stamp all its writes.

## Reports: Sales analysis

The Sales tab in Reports has two views, switched by the **Overview / Sales analysis** buttons (`setSalesReportView` in `pages/reports.js`; the choice is remembered in `localStorage` as `epc_sales_report_view`).

- `pages/reports-sales.js` + `reports-sales.css` draw the analysis: 14 KPI cards (sales, units, average daily sales, offtake per day, average selling price, gross profit, margin, markup, products sold, sales per product, top 10 share, selling days, best day, sales with a cost), sales trend, day of the week, categories, ABC classes, biggest gains and drops, and a per-product offtake table (search, ABC filter, sort, CSV export).
- **No reads of its own.** It uses the sales days Generate Report already loaded (`REPORT_DATA.sales`) plus the same number of days just before (`salesPrevious`, loaded by `loadSalesPreviousPeriod` only when Generate Report is clicked on the Sales tab: one read per day, reused like the other day docs). Reached by switching tabs instead, it still shows, without the "vs before" comparisons.
- **It counts every sale, the Overview does not.** The Overview drops products that have no cost (`reportCostedSales`), so its Total Revenue can be lower. The analysis keeps them; profit, margin and markup use only the part with a cost, and the "Sales with a cost" card says how big that part is.
- A range that is still running (This Month) ends at the latest day with sales, and "before" means the same number of days right before the start date.
- **Definitions ("i" icons):** put an element with class `info-def` right after a label and `initInfoTips` in `assets/app.js` turns it into the icon. The wording lives in `DEF` at the top of `reports-sales.js`. Add a definition for every new figure.
- Not possible from the data: anything per receipt or per customer (basket size, number of transactions, busiest hours). Sales imports keep only product totals per day.

## Read counter and cost lines

`EPCReads` (`assets/reads.js`, loaded before `app.js` on every page) keeps this browser's own count of Firestore reads for the current quota day (`localStorage` `epc_reads`, reset at the same midnight US Pacific as the quota) and estimates what a load will cost before the click. Firebase does not tell the website how many reads the team used; the count is per browser only.

- **Every read is counted automatically:** `EPCReads.watchFirestore(firebase)` in `app.js` wraps the compat SDK's `Query`, `CollectionReference` and `DocumentReference` `.get()` (the compat build has no `AggregateQuery` class; counts go through the REST helper `_runAggregationRest`, which reports 1 per 1,000 counted). New code needs nothing unless it reads outside the SDK (then call `EPCReads.spent(n, label)`).
- **Cost line:** `EPCReportGate.wire({ ..., costLine: '<element id>', estimate: () => parts })` writes "≈ 2 reads · 1,240 used today on this browser" beside the button and repaints it on `epc-cost-change` (fire it when the page's dates change) and after every load. `parts` is a list of `{ saved: '<collection>' }` (2 reads when a saved copy exists, else the last known count or `FALLBACK`), `{ days: 'salesDaily', from, to }` (1 per day not in the day store, else 2) and `{ fixed: n, label, note }`. Pages without a gate call `EPCReads.line(el, partsFn)` directly.
- **Confirm pop-up:** the gate awaits `EPCReads.confirm(parts)` before loading; it asks only when the estimate is over 1,000 reads or would pass 50,000, and when the quota is already hit it offers "Wait until 4 PM". When part of a load falls beyond today's free 50,000 it says how many reads and the peso cost on the pay-as-you-go (Blaze) plan (`EPCReads.pesos`, about ₱0.35 per 10,000) and suggests Offline mode or Download all data; a bar on every page says the same once this browser has passed the free reads. **Every Generate button must pass an `estimate`.**
- `scripts/count-collections.js` (admin SDK, run after the daily reset) prints the real record counts to paste into `FALLBACK` in `assets/reads.js`; they only matter until a browser has stored its own counts (`localStorage` `epc_counts`).
- Tests: `npm test` runs `node --test tests/*.test.js` (pure logic of `reads.js`, `days.js`, `datafile.js` against fakes).

## Daily read limit warning

`EPCQuota` in `assets/app.js` shows a warning bar on every page when Firestore refuses reads with a quota error (on the Blaze plan this should no longer happen; reads beyond the free 50,000 a day are billed instead, and `EPCReads` warns about them), with the reset time (midnight US Pacific, about 4 PM Philippine time). The hit is saved in `localStorage` (`epc_quota_hit`) until the reset, so the bar shows again on each page load without spending a read; a load that works again clears it. New code that catches a Firestore load error must pass it to `EPCQuota.report(err)`. The Purchases cards mark their totals "Only the N loaded rows" when the full-range totals could not be fetched.

## Rule: adding a field means wiring it everywhere

When a field is added to any form, wire it through end to end in the same change, without being asked:
- **Form:** reset (Add), save into the record, and load back on Edit.
- **The module's own records:** table column, search, column filter and CSV export.
- **Imports/ledgers:** map it in any import parser or ledger columns for that record type (e.g. `PURCHASE_LEDGER_COLUMNS` in `pages/purchases.js`). Reuse an existing field key if imports already store one (e.g. purchases already had `salesInvoiceNumber`).
- **Other pages that list that record type one row at a time** (grep for `DB.get('<collection>')`), e.g. the EWT table in `pages/tax-monitoring.js`. Pages that only add up totals (income statement, reports) need nothing.
- Fix hardcoded `colspan` counts, and bump the `?v=` cache tag on every changed `.js`/`.css`.

## Rule: connecting a third-party app (API, service, integration)

When asked to connect to an outside app or service, follow this without being asked:
1. **Branch first.** `git pull` on `main`, then work on a new branch (`connect-<app>`). Never commit to `main` directly.
2. **Keys and passwords only in `.env`** in the project root (already gitignored). Read them from there. Never write a key into a code file, `firebase.json`, a commit, a log line or chat. If the user pastes a key into chat, tell them to rotate it.
3. **Never put a secret in website code** (`pages/`, `assets/`, any `.html`/`.js`/`.css` that Hosting serves). It is public: anyone can read it in their browser. Choose instead:
   - **The website needs the data**: add an endpoint on the VPS chat server (`chat-server/`, same pattern as `/api/chat`: verify the Firebase ID token, CORS for the portal only, rate limits). The key lives on the VPS in `/etc/epc-chat.env`, added there by hand, never via git.
   - **A one-off or scheduled job** (import, export, sync): a Node script in `scripts/` run from the owner's Mac (never deployed; reads `.env`).
   - **The service issues a public/browser key** meant for web pages (like the Firebase web config): it may go in website code.
4. **Mind the costs.** The Firebase project is on the Blaze plan: the first 50,000 Firestore reads per day are free for everything, beyond that about ₱0.35 per 10,000 reads. Don't add anything that reads whole collections or polls in a loop; estimate reads and any third-party charges and tell the owner before building.
5. **Test locally**, then before any push run `git status` and `git diff --cached` and confirm no `.env`, key, token or credentials file or value is staged.
6. **Pushing:** the owner pushes the branch from their Mac (`git push -u origin <branch>`), then asks the GitHub-connected Claude session to open the PR, check it and merge. Do not merge without the owner saying so.
7. **Document it:** add the integration to this file (what it does, where the key lives: name only, never the value) and to `PROJECT-NOTES.md`.

## Secrets

- Never commit or deploy the service-account keys (`serviceAccountKey*.json`, `*firebase-adminsdk*.json`) or `new-project-web-config.txt`. They exist only locally in the project root, and they are gitignored and listed in the hosting ignore list.
- `backup/` and `exports/` hold real business data and are gitignored.
