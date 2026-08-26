# PalGenoPedia Volunteer Contribution Portal

Login-gated portal where volunteers document incidents through a structured
form instead of editing Google Sheets directly. Submissions land in the same
spreadsheets the existing PalGenoPedia sync already reads via
`tools/build_records.py`.

Covers Hospitals, Universities, Schools, and Religious Sites — the four
facility-incident sections that share one schema. Massacres/historical
events are still out of scope (see below); that needs its own form
template and a sync gap closed first, per the architecture plan's phased
rollout.

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

- In a new Google Sheet ("Volunteer Portal — Admin" or similar — separate
  from the four content spreadsheets), create the Apps Script project (
  Extensions → Apps Script) and paste in `apps-script/Code.gs` and
  `apps-script/appsscript.json` (or use `clasp push` — see below).
- In that same admin spreadsheet, add a `Volunteers` tab: column A is the
  allowed volunteer's email, one per row; column B is their role — leave
  blank (or `volunteer`) for someone who can only submit new incidents, or
  set `editor` for someone who can also edit incidents already in the
  sheet. A coordinator maintains this directly. Put its spreadsheet ID into
  `VOLUNTEERS_SPREADSHEET_ID` in `Code.gs`.
- `SPREADSHEETS` in `Code.gs` already points at the four real workbooks
  (Hospitals, Universities, Schools, Religious Sites) per `PIPELINE.md` in
  the main repo — do not repoint these to a different spreadsheet.
- **Add new columns to each of the four incidents tabs**
  (`Hospital_incidents`, `University_incidents`, `Schools_incidents`,
  `Religous_incidents` — note the missing "i", that's the real tab name):
  `submission_id`, `last_edited_by`, `last_edited_at`. All additive (see
  Data contract below) — none of them touch anything `build_records.py`
  reads.
- The Apps Script project needs edit access to the admin spreadsheet and all
  four content workbooks — either run it under a Google account that already
  has editor access to all of them, or have each workbook shared with
  whichever account owns the script.
- Deploy → New deployment → **Web app** → Execute as: **Me** → Who has
  access: **Anyone** (not "Anyone with Google account" — see architecture
  note above for why). Copy the deployment URL into `config.js`.
- Optional local dev: `npm i -g @google/clasp`, `clasp login`, `clasp clone
  <scriptId>` into `apps-script/`, then `clasp push` to sync edits.

### 3. Frontend

- Edit `config.js` with the Web App URL and OAuth client ID.
- Edit `CNAME` to the real subdomain.
- Push to GitHub, enable Pages on this repo (branch `main`, root), point the
  subdomain's DNS `CNAME` record at `<org>.github.io`.

## Data contract

Matches `PIPELINE.md` in the main repo exactly — see the `INC` column map in
`apps-script/Code.gs`. Each section's facilities and incidents live in two
tabs of the same workbook (e.g. `Hospital_facilities` /
`Hospital_incidents`); a new incident is appended to the incidents tab,
matched to its facility by `facility_name`.

**Matching is by name, never by id.** `PIPELINE.md` documents that
`id`/`incident_id`/`facility_id` are formulas that count non-blank rows and
are not stable — deleting one row shifts every id below it, which already
repointed 25 hospital URLs once. The portal reads/writes `facility_name` as
the join key everywhere; `facility_id` is copied onto a new row only as a
best-effort convenience value, never used to look anything up.

The backend never invents an `id`/`incident_id` for a new row either — it
appends a blank row and lets the sheet's own formula derive those, exactly
like a manually typed row. It does write a `submission_id` (UUID, generated
client-side) into a dedicated column so a reviewer can trace a row back to
its portal submission even after `incident_id` shifts. That column must be
added to each of the four incidents tabs once, manually, before this goes
live.

## Editing existing incidents

Volunteers with the `editor` role (set in column B of the `Volunteers` tab —
see Setup above) get an **Edit** button on each incident in the facility
detail view, alongside the passive duplicate-check list. It opens an inline
form pre-filled with that incident's current values.

The row to overwrite is identified by its sheet row number, captured when
the incident list loaded. Before writing, the backend re-reads that row and
confirms it still belongs to the expected facility — if it doesn't (e.g.
someone else's edit or a manual row insert/deletion landed in between), the
request fails with a clear "please refresh and try again" error instead of
silently overwriting the wrong incident. `last_edited_by`/`last_edited_at`
are stamped on every edit, alongside whatever `added_by` already says — an
edit never touches `added_by`, `reviewed_by`, or the sheet's own
`id`/`incident_id` formulas.

Non-editor volunteers don't see the Edit button at all, and the backend
rejects an `update_incident` request from a non-editor regardless
(`error: "not_authorized"`) — the UI check is a convenience, not the
actual boundary.

## Explicitly out of scope

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
