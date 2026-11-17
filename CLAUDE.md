# EPC Accounting Portal

Internal accounting web app for EPC Commercial Corporation. Vanilla HTML/CSS/JS (no framework, no build step) backed by Firebase (Firestore + Auth).

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
- The assistant can't see the company's records; it explains the portal and accounting/tax topics. The system prompt in `chat-server/server.js` lists the pages, so update it (and re-run `setup-vps.sh`) when pages are added or renamed.
- `chat-server/` is kept out of Firebase Hosting by the `chat-server/**` ignore rule.

Local preview: `npx -y firebase-tools@latest emulators:start` (hosting on port 5050, Firestore on port 8080).

Node note: the local Node is v25. firebase-tools warns that it supports Node 20/22/24, but the commands still work.

## Structure

- `index.html` redirects to `pages/`. Shared code lives in `assets/app.js` and `assets/style.css`. The Firebase web config is in `assets/app.js`.
- `pages/` holds one HTML page per module (dashboard, purchases, sales, supplies, reports, etc.).
- `firestore.rules`, `firestore.indexes.json`: security rules and indexes.
- Root `*.js` and `scripts/` are Node admin scripts (`firebase-admin`): backups, restores, exports, user creation. They never deploy.
- `chat-server/`: the chat assistant API that runs on the Hostinger VPS. Kept out of Hosting by the `chat-server/**` ignore rule.

## Rule: adding a field means wiring it everywhere

When a field is added to any form, wire it through end to end in the same change, without being asked:
- **Form:** reset (Add), save into the record, and load back on Edit.
- **The module's own records:** table column, search, column filter and CSV export.
- **Imports/ledgers:** map it in any import parser or ledger columns for that record type (e.g. `PURCHASE_LEDGER_COLUMNS` in `pages/purchases.js`). Reuse an existing field key if imports already store one (e.g. purchases already had `salesInvoiceNumber`).
- **Other pages that list that record type one row at a time** (grep for `DB.get('<collection>')`), e.g. the EWT table in `pages/tax-monitoring.js`. Pages that only add up totals (income statement, reports) need nothing.
- Fix hardcoded `colspan` counts, and bump the `?v=` cache tag on every changed `.js`/`.css`.

## Secrets

- Never commit or deploy the service-account keys (`serviceAccountKey*.json`, `*firebase-adminsdk*.json`) or `new-project-web-config.txt`. They exist only locally in the project root, and they are gitignored and listed in the hosting ignore list.
- `backup/` and `exports/` hold real business data and are gitignored.
