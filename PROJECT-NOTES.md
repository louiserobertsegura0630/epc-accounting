# Project notes: decisions, history and what's next

The *why* behind the setup. `CLAUDE.md` has the *how*: links, deploying, structure and rules. Read both before changing things.

Last updated: 2026-11-17.

---

## 1. Where things live

| Thing | Where |
|---|---|
| Code (master copy) | GitHub `louiserobertsegura0630/epc-accounting`, branch `main` |
| Code (working copy) | Owner's Mac: `~/epc-accounting`. Run `git pull` first, every time |
| Live website | https://epc-inventory-system.web.app (Firebase Hosting, auto-deployed from `main`) |
| Database + login | Firebase project `inventory-system-1fb4d` (Firestore + Auth), **free Spark plan** |
| Chat assistant API | Hostinger VPS `187.127.124.15` (Coolify), Docker container `epc-chat`, https://epc-chat.187-127-124-15.sslip.io |
| Anthropic API key | Only on the VPS in `/etc/epc-chat.env` (root-only). Never in code, git or chat |

---

## 2. Decisions and why

### Hosting and deploys
- **We stayed on Firebase** (not Hostinger) for the website and database. Moving data off Firestore would mean rewriting the backend, and Hostinger can't host Firestore.
- **Auto-deploy:** merging into `main` deploys the site in about a minute (GitHub Actions). Every pull request gets a 7-day preview link. A collaborator only needs GitHub access.

### Firebase plan: staying on free Spark, on purpose
- The owner declined the **Blaze** (pay-as-you-go) plan. Billing budgets only send alerts; they don't stop charges.
- On Spark, Firestore gives **50,000 reads per day** for the whole project. When they run out, reads fail until **midnight US Pacific (about 4:00 PM Philippine time)**. That works as a free hard cap. The Reports page shows "Daily Firestore read limit reached" when it happens.
- **Consequence:** no Firebase Cloud Functions. Anything server-side runs on the Hostinger VPS.

### Reports and Generate buttons
- Pages load **nothing** until **Generate Report** is clicked, because each load costs reads. Tabs and date presets never load by themselves.
- Reports has **one** Generate Report button, next to the dates.
- Every load shows a **loading pop-up**. The Reports pop-up shows the percentage.
- Dates use the **local** (Philippine) date, not UTC. The old UTC code shifted every date back one day.
- Long ranges are read month by month, side by side. The load only times out after 45s with no progress (hard cap 3 minutes).

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
2. **Cut Firestore reads in reports.** Several report tabs read **whole collections** on every Generate (all purchases, all expenses, the full Product Master, about 4,700 docs). Proposed fixes:
   - query by the selected dates;
   - stop loading the full Product Master just for names and categories;
   - reuse data already loaded this session.

   This is the real reason the free 50,000 reads/day run out.
3. Phone layout: the sidebar keeps its width on small screens on every page. This was true before the redesign and hasn't been fixed yet.

---

## 4. Working style the owner prefers
- Plain, simple explanations, as if to a 10-year-old.
- Show a **preview link** before making big visual changes live; merge when the owner says "merge".
- Never ask for, or accept, passwords or API keys in chat. Keys go straight into the server (`setup-vps.sh` reads them hidden).
