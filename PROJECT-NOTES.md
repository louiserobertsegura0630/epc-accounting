# Project notes: decisions, history and what's next

The *why* behind the setup. `CLAUDE.md` has the *how*: links, deploying, structure and rules. Read both before changing things.

Last updated: 2026-11-18.

---

## 1. Where things live

| Thing | Where |
|---|---|
| Code (master copy) | GitHub `louiserobertsegura0630/epc-accounting`, branch `main` |
| Code (working copy) | Owner's Mac: `~/epc-accounting`. Run `git pull` first, every time |
| Live website | https://epc-inventory-system.web.app (Firebase Hosting, auto-deployed from `main`) |
| Database + login | Firebase project `inventory-system-1fb4d` (Firestore + Auth), **Blaze (pay-as-you-go) plan since 2026-11-20**, budget alert set |
| Chat assistant API | Hostinger VPS `187.127.124.15` (Coolify), Docker container `epc-chat`, https://epc-chat.187-127-124-15.sslip.io |
| Anthropic API key | Only on the VPS in `/etc/epc-chat.env` (root-only). Never in code, git or chat |

---

## 2. Decisions and why

### Hosting and deploys
- **We stayed on Firebase** (not Hostinger) for the website and database. Moving data off Firestore would mean rewriting the backend, and Hostinger can't host Firestore.
- **Auto-deploy:** merging into `main` deploys the site in about a minute (GitHub Actions). Every pull request gets a 7-day preview link. A collaborator only needs GitHub access.

### Firebase plan: Blaze (pay-as-you-go) since 2026-11-20
- Until 2026-11-20 the project stayed on the free Spark plan on purpose. That day the 50,000 free reads were used up before 9 AM by pages that still read the whole raw `salesData` collection, and the owner switched to **Blaze** so work could continue. Billing account "Firebase Payment", card on the owner's personal Google profile, budget alert set in the upgrade dialog (a few US dollars a month; alerts only, not a cap). Firebase also offers **spend caps** under Budgets that pause a service at the budget; the owner may set one.
- Blaze keeps the **50,000 free reads per day**; beyond that Firestore charges about US$0.06 per 100,000 reads (about ₱0.35 per 10,000). The site shows the per-browser spend beside every Generate button, confirms big loads, and warns with the peso cost when a load goes beyond the free reads (see CLAUDE.md "Read counter and cost lines"). The same day's work (branch `read-budget`) removed every whole-collection read of raw sales, so a normal day is a few hundred reads.
- The chat assistant stays on the Hostinger VPS (no Cloud Functions needed); nothing else moved to paid services.

### Offline mode (site-wide, 2026-11-20)
- One sidebar button, **Switch to offline mode**, chosen by the owner over a per-page tick: it fills the browser's copy first if needed (dates box + read cost), then every page reads from Firebase's local cache (0 reads) and the site turns dark grey with a banner, "like incognito", so nobody forgets. Download all data / Load from file live on Settings only. See CLAUDE.md "Offline mode, site-wide".

### Reports and Generate buttons
- Pages load **nothing** until **Generate Report** is clicked, because each load costs reads. Tabs and date presets never load by themselves.
- Reports has **one** Generate Report button, next to the dates. Beside it is a small **Reload all data** button for the rare case that a report looks out of date.
- Every load shows a **loading pop-up**. The Reports pop-up shows the percentage.
- Dates use the **local** (Philippine) date, not UTC. The old UTC code shifted every date back one day.
- Long ranges are read month by month, side by side. The load only times out after 45s with no progress (hard cap 3 minutes).

### Saved copies (cutting Firestore reads), built 2026-11-18
- **Why:** one Generate click on the Dashboard read about 12,000 records and one on Reports about 5,000 to 10,000, because they read whole collections every time. A handful of clicks used up the day.
- **What we chose:** each browser keeps a saved copy of those collections and only fetches records that changed since (the same idea as the Sales Pulse). After the first load, a Generate click costs a few dozen reads.
- **Why not "load only the chosen dates":** older records store their dates in different fields and formats, and the Tax and Cash Flow tabs need records outside the chosen dates. Filtering in the database risked silently dropping records from accounting totals. A saved copy keeps every figure exactly as before.
- **The cost of this choice:** every place the site saves a purchase, expense, supply, e-sales record or product must stamp it (`epcStamp` in `assets/app.js`). If a stamp is ever missed, other browsers show the old value until **Reload all data** is clicked or the copy turns 7 days old. Deleting a record makes each browser read that collection again once.
- **First load per browser** still reads everything once (about the same as one old Generate click). So does a new computer, a new browser, or a different person signing in.
- **Fixed along the way:** the Sales Pulse's check for deleted sales uploads never ran, because the Firebase build the site loads has no `count()`. It now uses the site's own `firestoreCount`, so a deleted upload disappears from the Sales Pulse at the next check instead of staying until Refresh.
- **Fixed along the way:** Reports used the purchases list left behind by the Purchases page in that browser (only the rows that page had on screen). It now always uses all purchases, so Purchases, Tax and Cash Flow totals in Reports may be higher than before.

### Sales analysis in Reports, built 2026-11-18
- The owner liked the Sales Pulse and asked for more sales statistics under Reports (KPIs, offtake), each with an "i" that explains it.
- It sits in **Reports → Sales → Sales analysis**, beside the old view (now called Overview), so nothing the team already uses moved.
- **Plain-word definitions** are part of the feature: every card, chart, table and non-obvious column has an "i".
- **Its sales total can be higher than the Overview's.** The Overview leaves out products with no cost; the analysis counts every sale and says what share has a cost. Decide later whether the Overview should count every sale too.
- Comparisons are against the same number of days just before the chosen dates. This costs one extra read per day, only on Generate Report in the Sales tab.
- "AK" was never identified (the owner may have misheard it). Not built: stock-based figures (days of stock left, sell-through), because stock on hand is not loaded by Reports; and anything per receipt or customer, which the sales files do not contain.

### Design (Design system v4)
- Soft mint background, white rounded cards, **dark teal** accents and a light sidebar, matching the "Pharmacy" reference design. Only the **EPC logo and company name** stay as brand.
- Font **Figtree** everywhere. All sizes are rem tokens in `assets/style.css` ("Design system v4"):

  | Token | Size | Used for |
  |---|---|---|
  | `--fs-2xs` | 12px | sidebar section labels, badges (the smallest allowed) |
  | `--fs-xs` | 13px | KPI trend line |
  | `--fs-sm` | 14px | helper and secondary text, table headers |
  | `--fs-md` | 15px | buttons, inputs |
  | `--fs-base` | 16px | body text, tables, sidebar |
  | `--fs-lg` | 20px | card titles |
  | `--fs-2xl` | 30px | page titles, KPI numbers |

- **Controls are at least 44px tall.** The exception is virtual-scroll tables (Inventory, Sales, Purchases, Supplies): they keep **38px rows** because their scripts position rows by that height, so their in-row buttons are 32px.
- Grey description lines under titles are replaced by an **"i" icon** with a hover tooltip ("less text").
- Charts get pastel 3D-style bars from a shared Chart.js plugin in `assets/app.js`. Motion respects "reduce motion".

### Chat assistant ("EPC Assistant")
- **Model:** `claude-haiku-5-5` at low effort, **chosen for cost**. It was Opus 5.5 at first; the owner switched to Haiku. Estimate: about ₱0.02–₱0.15 per question.
- **Runs on the VPS, not Firebase**, because of the Spark decision above. The VPS runs **Coolify**, whose Traefik owns ports 80/443 for other apps (Supabase, n8n, a student KPI app). So the chat runs as a Docker container on the `coolify` network, with **one** Traefik route file: `/data/coolify/proxy/dynamic/epc-chat.yaml`. Never edit Coolify-managed files.
- **Security:**
  - Only signed-in portal users can use it (Firebase ID token verified).
  - Only the portal's own web addresses can call it (CORS).
  - 30 questions per 10 minutes per person.
- **Three ways it answers:**
  1. **How-to and accounting/tax help:** no data needed.
  2. **"Ask about this report":** after Generate Report, the Reports page and the Dashboard send a compact summary of what they already loaded. That's **zero extra Firestore reads**. This is the main way to get insights for management.
  3. **Data lookups:** when no report is open, read-only tools read Firestore **with the user's own login**. Daily limits: **20 data questions per person and 200 for the team** (Philippine date). Ranges are capped (sales ≤ 31 days, purchases/expenses ≤ 92 days and ≤ 500 records). If Firebase's free reads are used up, it says so and doesn't count the question.
- **Updating the VPS** after any change in `chat-server/`, from the Mac:
  ```sh
  cd ~/epc-accounting && git checkout main && git pull && scp -r chat-server root@187.127.124.15:/root/ && ssh -t root@187.127.124.15 'bash /root/chat-server/setup-vps.sh'
  ```
  Press Enter for the web address, and Enter to keep the saved key. Health check: https://epc-chat.187-127-124-15.sslip.io/health should show `{"ok":true}`.
- **Lesson learned:** firebase-admin 14 has no `admin.apps` / `admin.auth()`. Use `firebase-admin/app` and `firebase-admin/auth`.

---

## 3. Ideas agreed but NOT built yet

1. **Click any row → details panel** (all pages). Planned as one shared side panel:
   - **Details:** every field of the record.
   - **Source:** file name, upload time, uploader, or "added by hand".
   - **Stats:** rank and share within the rows already loaded, e.g. "#3 of 412 products by sales ₱".
   - **Zero extra reads:** compare only against loaded rows; all-time ranks would be too expensive.
   - Source info exists for inventory, e-sales and uploads; older purchases and expenses may lack it.
   - The owner hasn't picked yet: all pages at once, or Sales, Inventory and Product Master first.
2. **Cut Firestore reads on the other pages: done (November 2026, branch `read-budget`).** No page reads the raw `salesData` or `underReviewData` collections anymore; Product Master, Potential Revenue and the Income Statement use the per-day sales summaries, the list pages use the saved copies, and every Generate button shows its read cost first (see CLAUDE.md "Read counter and cost lines"). Still open:
   - **Product Master "replace all" saves** (`syncProductMasterToFirestore`): read, delete and rewrite all ~4,700 products.
   - The raw `salesData` (430,000+ records) and `underReviewData` collections, and the Under Review tab on the Sales page, are legacy: only the Sales page itself still reads them (paged). They could be archived and deleted later (owner's call).
   - `FALLBACK` in `assets/reads.js` holds guessed record counts; run `node scripts/count-collections.js` after a 4 PM reset and paste the real ones.
3. Phone layout: the sidebar keeps its width on small screens on every page. This was true before the redesign and hasn't been fixed yet.

---

## 4. Working style the owner prefers
- Plain, simple explanations, as if to a 10-year-old.
- Show a **preview link** before making big visual changes live; merge when the owner says "merge".
- Never ask for, or accept, passwords or API keys in chat. Keys go straight into the server (`setup-vps.sh` reads them hidden).
