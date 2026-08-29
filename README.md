# PalGenoPedia Volunteer Contribution Portal

Login-gated portal where volunteers document incidents through a structured
form instead of editing Google Sheets directly. Submissions land in the same
spreadsheets the existing PalGenoPedia sync already reads via
`tools/build_records.py`.

Two areas:

- **War Crimes** — Hospitals, Universities, Schools, Religious Sites: the four
  facility-incident sections that share one schema (facility → incidents).
- **Historical Events** — a sub-page with two record sets: *Current Genocide*
  (Oct 2023 →) and *Historical War Crimes* (Nakba 1948 → 2022), each writing to
  its own workbook. Pick a set → its event list → select an event to see its
  saved data and **append** more Details rows, or "+ Document a new event".
  Reviewers build out the timeline / legal analysis in the sheet.

Plus an editor-only **Archiving Portal** (source + media domain policy).

## How it works

Two pieces, no new database:

1. **Frontend** — this repo, a static site (no build step) deployed via
   GitHub Pages to a subdomain, e.g. `contribute.palgenopedia.org`. Handles
   Google Sign-In (Google Identity Services) and all the UI: section picker,
   facility list with live incident counts, per-facility incident list
   (the duplicate check) and the new-incident form; the Historical Events
   era pages, per-event pages and add-details / new-event forms; and the
   editor-only archiving dashboards.
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
  blank (or `volunteer`) for someone who can only submit new incidents,
  `editor` for someone who can also edit incidents already in the sheet, or
  `admin` for someone who additionally gets the in-portal activity log
  (`admin` includes editor privileges). A coordinator maintains this
  directly. Put its spreadsheet ID into `VOLUNTEERS_SPREADSHEET_ID` in
  `Code.gs`.
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

## Activity log (admin role)

Every submission, edit, and archive-policy change is written to the
`SubmissionLog` tab in the admin spreadsheet, one row per action:
`Timestamp, Volunteer email, Action ("submit"/"edit"/"source-policy"/
"media-policy"/"manual-archive"), Section, Facility, Reference`. `admin`-role volunteers see this as a live "Activity log" view
in the portal itself (top bar → **Activity log**), most recent 200 entries,
newest first — pulled straight from that tab via a `doGet` action gated on
`isAdmin`, same non-authoritative-UI-check-plus-real-backend-check pattern
as the editor role above.

Non-admins (including editors) don't see the "Activity log" link and get
`error: "not_authorized"` if they call the endpoint directly. Nothing
about this changes what gets logged or when — it's a read-only view onto
data the backend was already writing.

## Archive priorities (editor role)

The main site archives cited source URLs to the Wayback Machine
(`tools/archive_links.py` + `.github/workflows/archive-links.yml` in the main
repo). That run is **opt-in per source domain** — it only touches a domain an
editor has configured here.

Editors (and admins) get two top-bar views:

- **Archive priorities** — article / report sources (`source_url_1`, the main
  citation; `source_url_2`, comma-separated secondary sources; historical
  `source_link`).
- **Media archiving** — `video_url` and `image_url`. Separate because media
  needs a different approach (Wayback can't capture video; the real answer is
  the planned ArchiveBox + yt-dlp job, so most media domains stay `manual`).

Each lists every domain found in that namespace with its URL count and current
archive status. **Click a domain** to expand every URL under it with its
per-URL status (archived / pending / queued / not yet); any URL that isn't
archived gets an inline field to paste a **hand-made snapshot link**
(archive.today, a manual Wayback save, …). That writes
`{status: "archived", method: "manual", manual: true}` into
`data/archived-links.json`, the generated pages then show a 🕰 link to it, and
the weekly archiver skips it forever after.

Per domain the editor sets:

- **Priority** — `High` / `Normal` / `Skip`. The weekly archiver does High
  domains first; Skip (and any unconfigured domain) is left alone.
- **Method** — `Wayback Machine` / `archive.today` / `ArchiveBox` / `Manual`.
  Only `Wayback` is automated today; the others are recorded as "deferred to
  <method>" and listed in `data/archive-deferred.txt` in the main repo for the
  planned ArchiveBox layer. Set social-media domains (`x.com`, `facebook.com`)
  to `archive.today` — Wayback just gets a login wall for those.

### How it's wired

- Each view reads a **`data/*-domains.json`** inventory from the main repo
  (`source-domains.json` / `media-domains.json` — the archiver regenerates both
  on every CSV change) for the domain list + counts.
- Saving a row commits the matching **`data/*-policy.json`**
  (`archive-policy.json` / `media-policy.json`) to `PalGenoPedia/PalGenoPedia`
  via the GitHub Contents API — same mechanism as the sheet sync. The commit
  fires `archive-links.yml`.
- `doGet ?action=archive_policy&kind=source|media` and
  `doPost {action:"set_archive_policy", kind, …}` are both gated
  **server-side** on the editor role; the hidden top-bar buttons are UI
  convenience only.

### One-time setup

1. On the PalGenoPedia GitHub account, create a **fine-grained personal access
   token**:
   - **Repository access:** only `PalGenoPedia/PalGenoPedia`.
   - **Permissions:** `Contents` → **Read and write**. Nothing else.
   - Set an expiry and calendar a rotation.
2. In the portal's Apps Script project → **Project Settings** → **Script
   properties** → add `GITHUB_TOKEN` = that token.
   **Never** paste it into `Code.gs`.
3. Redeploy the Web App (a new deployment version).

`data/archive-policy.json` is created on the first save — nothing to seed.

## Historical War Crimes

The historical data lives in **two workbooks, same 6-tab structure**:
`Historical Events` (`1fTNCp…`, Nakba 1948 → 2022) and `Historical Events
(Ongoing)` (`1Wtn0b…`, current genocide, Oct 2023 →). `tools/merge_history.py`
in the main repo concatenates the two back into the flat CSVs `build_history.py`
reads.

### Navigation

The **Historical Events** Home card opens a sub-page (`showHistorical`,
`tpl-historical-home`) with two choices: *Current Genocide* (`era: "recent"` →
Ongoing workbook) and *Historical War Crimes* (`era: "pre"` → Historical
workbook). Picking one calls `showHistoricalEra(era)` → the **event list** for
that workbook plus a "+ Document a new event" button. The `era` rides along on
every historical GET/POST. `listHistEvents(era)` reads only that workbook (no
`era` = both, each row still tagged).

- **Select an event** → `showHistEvent(era, ev)` (`tpl-hist-event`): the saved
  `Events` row rendered read-only (facts table + summary paragraphs), the
  event's recorded `Details` rows grouped by category
  (`hist_event_details` → `listHistEventDetails(era, name)`), and an **add
  detail records** form — the same repeatable groups, posting
  `add_hist_details` → `addHistDetails()` → `appendHistDetails_(name, details,
  era, throwOnError=true)`. Add-only: existing rows are never touched. Editors
  also get an **Edit event fields** button here (`update_hist_event`).
- **+ Document a new event** → `showHistNewEvent(era)` (`tpl-hist-new`): the
  full event form + first Details rows, posting `submit_hist_event`. Appends an
  `Events` row via the same insert-and-drag-the-`id`-formula dance as
  `submitIncident` — stamps `author` + `added_by` = the volunteer, `last_updated`
  = today, `submission_id` — then appends the Details rows (best-effort).

The new-event form takes: name, type, dates, location (historical + current +
lat/lng), perpetrators, classification, casualty figures (free text — the sheet
stores `"≈107–250"` etc), three summary paragraphs, and repeatable Details rows
for `war_crime` findings, `source` (name + URL), `testimony` (quote +
attribution) and `casualty` / key facts (label + value + note).

Everything matches on `event_name`, never the running-counter `id` formula.

**One-time:** add a `submission_id` header column to the `Events` tab of **both**
workbooks (like the incidents tabs). Backend actions:
`doGet ?action=hist_events&era=`, `doGet ?action=hist_event_details&era=&name=`,
`doPost {action:"submit_hist_event", era}`,
`doPost {action:"add_hist_details", era, name, details}`,
`doPost {action:"update_hist_event", era}` (editor).
Log actions: `submit-hist` / `add-hist-details` / `edit-hist`.

Submissions reach the site on the **next `syncAll()`** (Sheet → CSV →
`build-records.yml` → `build_history.py`), same as the facility incidents.

## Explicitly out of scope

- Historical **Details** rows for `timeline`, `legal`, `historical_impact`,
  `commander` and `personality` — research/prose-heavy, still added by reviewers
  in the sheet. Editing or removing existing detail rows is also sheet-only.
- The "active" duplicate-warning banner (date ± 1 day + similar attack type).
  MVP ships the passive version: the volunteer sees the sorted incident list
  before the form, full stop.

## SEO / crawler isolation

- `robots.txt`: `Disallow: /` at this subdomain's root.
- `<meta name="robots" content="noindex, nofollow">` on every page.
- Every page requires a valid sign-in before rendering content.
- No link to this subdomain from the main site.
- This subdomain is never added to the main site's `sitemap.xml`.
