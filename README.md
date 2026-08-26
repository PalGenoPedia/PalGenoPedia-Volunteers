# PalGenoPedia Volunteer Contribution Portal

Login-gated portal where volunteers document incidents through a structured
form instead of editing Google Sheets directly. Submissions land in the same
spreadsheets the existing PalGenoPedia sync already reads via
`tools/build_records.py`.

MVP scope (phase 1, per the architecture plan): **Hospitals only.**

## How it works

Two pieces, no new database:

1. **Frontend** — this repo, a static site (no build step) deployed via
   GitHub Pages to a subdomain, e.g. `contribute.palgenopedia.org`. Handles
   Google Sign-In (Google Identity Services) and all the UI: section picker,
   facility list with live incident counts, per-facility incident list
   (the duplicate check), and the new-incident form.
2. **Backend** — `apps-script/Code.gs`, a Google Apps Script project bound to
   the same spreadsheets the main site already syncs from. Deployed as a Web
   App. `doGet` serves facility lists / incident lists as JSON; `doPost`
   validates and appends a new row. It independently verifies the Google ID
   token sent by the frontend (via `https://oauth2.googleapis.com/tokeninfo`)
   against an allow-list — it does **not** rely on `Session.getActiveUser()`,
   because the frontend and backend are on different origins.

Why verify the ID token server-side instead of using Apps Script's built-in
"Anyone with a Google account" access + `Session.getActiveUser()`: that only
works when the browser navigates directly to the `script.google.com` URL.
Called cross-origin via `fetch()` from a GitHub Pages origin, an
auth-gated Apps Script deployment redirects to a Google login HTML page
instead of running `doGet`/`doPost`, which `fetch` can't read across
origins. Deploying with **Access: Anyone** (no Google-account requirement at
the platform level) and verifying identity ourselves inside the script
avoids that entirely, while still giving a hard, server-side identity check.

## Repo layout

```
index.html          Login page (Google Sign-In button)
app.html             Main app shell (section -> facility -> incidents -> form)
assets/app.js         All frontend logic; talks to the Apps Script Web App
assets/style.css       Shared styles
config.js              Non-secret config: Apps Script Web App URL, Google OAuth client ID
apps-script/Code.gs     Backend: doGet / doPost, token verification, sheet I/O
apps-script/appsscript.json   Apps Script manifest
CNAME                   GitHub Pages custom domain (edit before first deploy)
robots.txt               Disallow: / — keeps this subdomain out of search entirely
```

## Setup

### 1. Google Cloud OAuth client (for Google Sign-In)

- Create an OAuth 2.0 Client ID (Web application) in the Google Cloud project
  tied to PalGenoPedia's Google account.
- Authorized JavaScript origins: `https://contribute.palgenopedia.org` (and
  `http://localhost:8000` or similar for local testing).
- Put the client ID in `config.js`.

### 2. Apps Script backend

- In the target Google Sheet (or a bound script on one of the incident
  sheets), create a new Apps Script project and paste in `apps-script/Code.gs`
  and `apps-script/appsscript.json` (or use `clasp push` — see below).
- Add a `Volunteers` sheet/tab with one column of allowed volunteer emails —
  this is the allow-list a coordinator maintains directly.
- Set the `SPREADSHEETS` mapping at the top of `Code.gs` to point each
  section (`hospitals` for MVP) at its spreadsheet ID and tab name — mirror
  whatever `tools/apps-script/github-sync-fix.gs` already uses in the main
  repo, do not invent new IDs.
- Deploy → New deployment → **Web app** → Execute as: **Me** → Who has
  access: **Anyone**. Copy the deployment URL into `config.js`.
- Optional local dev: `npm i -g @google/clasp`, `clasp login`, `clasp clone
  <scriptId>` into `apps-script/`, then `clasp push` to sync edits.

### 3. Frontend

- Edit `config.js` with the Web App URL and OAuth client ID.
- Edit `CNAME` to the real subdomain.
- Push to GitHub, enable Pages on this repo (branch `main`, root), point the
  subdomain's DNS `CNAME` record at `<org>.github.io`.

## Data contract

Matches `PIPELINE.md` in the main repo exactly — see column mapping in
`apps-script/Code.gs` (`COLUMN_MAP`). The backend never invents an
`id`/`incident_id`; it appends a blank row and lets the sheet's own formula
derive those, exactly like a manually typed row. It does write a
`submission_id` (UUID, generated client-side) into a dedicated column so a
reviewer can trace a row back to its portal submission even after
`incident_id` shifts.

## Explicitly out of scope for this MVP

- Massacres/historical events (different schema entirely — needs its own
  form template, and the historical spreadsheet isn't in the sync's
  `SPREADSHEETS` array yet per `PIPELINE.md`).
- The "active" duplicate-warning banner (date ± 1 day + similar attack type).
  MVP ships the passive version: the volunteer sees the sorted incident list
  before the form, full stop.

## SEO / crawler isolation

- `robots.txt`: `Disallow: /` at this subdomain's root.
- `<meta name="robots" content="noindex, nofollow">` on every page.
- Every page requires a valid sign-in before rendering content.
- No link to this subdomain from the main site.
- This subdomain is never added to the main site's `sitemap.xml`.
