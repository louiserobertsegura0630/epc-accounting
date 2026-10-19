# EPC Accounting Portal

Internal accounting web app for EPC Commercial Corporation. Vanilla HTML/CSS/JS (no framework, no build step) backed by Firebase (Firestore + Auth).

## Links

| What | URL |
|---|---|
| Live site | https://epc-inventory-system.web.app |
| Firebase console | https://console.firebase.google.com/project/inventory-system-1fb4d |
| GitHub repo | https://github.com/louiserobert921/epc-accounting |

- Firebase project: `inventory-system-1fb4d` (alias `default` in `.firebaserc`). Old project alias `old` → `palo-grocerette-accounting` (no longer used).
- Hosting site `epc-inventory-system` is mapped to deploy target `app`. The project also has a default site, https://inventory-system-1fb4d.web.app, which is not the one we deploy to.
- `package.json` still lists `louiserobertsegura0630/epc-accounting` as its repo URL. That repo is an old copy, last pushed June 2026. The real remote is `louiserobert921/epc-accounting` (see `git remote -v`).
- GitHub login: `gh` has two accounts, and the active one (`louiserobertsegura0630`) can't see the real repo ("Repository not found"). Push with the `louiserobert921` login for that one command:
  ```sh
  GH_TOKEN=$(gh auth token --user louiserobert921) git -c credential.helper= -c 'credential.helper=!gh auth git-credential' push origin main
  ```

## Deploying (going live)

Hosting is Firebase Hosting (Classic). It serves the repo root (`public: "."`); the ignore list in `firebase.json` keeps out keys, scripts, backups and `*.js` at the root. There is no CI, so deploys are run by hand from this machine.

1. Work on a feature branch, push it to GitHub, and merge it into `main`.
2. Check out `main` and pull, so the live site matches `main`.
3. Deploy:
   ```sh
   npx -y firebase-tools@latest login            # first time only
   npx -y firebase-tools@latest deploy --only hosting:app
   ```
   - Firestore rules/indexes changed: `npx -y firebase-tools@latest deploy --only firestore`
4. Check https://epc-inventory-system.web.app (hard refresh).

Local preview: `npx -y firebase-tools@latest emulators:start` (hosting on port 5050, Firestore on port 8080).

Node note: the local Node is v25. firebase-tools warns that it supports Node 20/22/24, but the commands still work.

## Structure

- `index.html` redirects to `pages/`. Shared code lives in `assets/app.js` and `assets/style.css`. The Firebase web config is in `assets/app.js`.
- `pages/` holds one HTML page per module (dashboard, purchases, sales, supplies, reports, etc.).
- `firestore.rules`, `firestore.indexes.json`: security rules and indexes.
- Root `*.js` and `scripts/` are Node admin scripts (`firebase-admin`): backups, restores, exports, user creation. They never deploy.

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
