# EPC Accounting Portal

Internal accounting web app for EPC Commercial Corporation. Vanilla HTML/CSS/JS (no framework, no build step) backed by Firebase (Firestore + Auth).

**Also read `PROJECT-NOTES.md`**: the decisions behind this setup (free Spark plan, the chat assistant on the Hostinger VPS, the design system, limits), lessons learned, ideas agreed but not built yet, and how the owner likes to work.

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

The chat API runs on the **Hostinger VPS**, not Firebase (the Firebase project stays on the free Spark plan):
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

- `index.html` redirects to `pages/`. Shared code lives in `assets/app.js` and `assets/style.css`. The Firebase web config is in `assets/app.js`.
- `pages/` holds one HTML page per module (dashboard, purchases, sales, supplies, reports, etc.).
- `firestore.rules`, `firestore.indexes.json`: security rules and indexes.
- Root `*.js` and `scripts/` are Node admin scripts (`firebase-admin`): backups, restores, exports, user creation. They never deploy.
- `chat-server/`: the chat assistant API that runs on the Hostinger VPS. Kept out of Hosting by the `chat-server/**` ignore rule.

## Dashboard: Sales Pulse, season theme, logo intro

- `pages/dashboard-sales.js` + `dashboard-sales.css`: the **Sales Pulse** loads by itself on page open (the rest of the dashboard still waits for Generate Report). It reads the last 92 `salesDaily` day-docs (one read each), keeps them in `sessionStorage` for 30 minutes, and hands them to `dashboard.js` (`primeSalesCache`) so Product Performance reuses them. Profit is revenue minus recorded cost, so it is overstated for products with no cost yet.
- `pages/dashboard-season.js`: season theme, logo intro and bell tune. The season comes from today's date (script in the head of `dashboard.html`): Sep–Dec Christmas, Jan 1–15 New Year, Feb 1–14 Valentine's, Mar–May summer, Jun–Aug rainy. Preview one with `dashboard.html?season=christmas`. The intro shows once per browser session; Effects and Sound buttons remember the choice in `localStorage`. Sound is made with Web Audio (no audio files), and browsers block it until the user has clicked on the site.
- Chart colours: `EPC_CHART_PASTEL` in `assets/app.js` recolours every chart. A dataset with `__epcPastel: true` keeps its own colours.

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
4. **Mind the costs.** The Firebase project is on the free Spark plan (50,000 Firestore reads per day for everything). Don't add anything that reads whole collections or polls in a loop; estimate reads and any third-party charges and tell the owner before building.
5. **Test locally**, then before any push run `git status` and `git diff --cached` and confirm no `.env`, key, token or credentials file or value is staged.
6. **Pushing:** the owner pushes the branch from their Mac (`git push -u origin <branch>`), then asks the GitHub-connected Claude session to open the PR, check it and merge. Do not merge without the owner saying so.
7. **Document it:** add the integration to this file (what it does, where the key lives: name only, never the value) and to `PROJECT-NOTES.md`.

## Secrets

- Never commit or deploy the service-account keys (`serviceAccountKey*.json`, `*firebase-adminsdk*.json`) or `new-project-web-config.txt`. They exist only locally in the project root, and they are gitignored and listed in the hosting ignore list.
- `backup/` and `exports/` hold real business data and are gitignored.
