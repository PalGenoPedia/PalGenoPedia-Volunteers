/**
 * PalGenoPedia Volunteer Portal — Apps Script backend.
 *
 * Deploy as a Web App: Execute as "Me", Access "Anyone". Identity is NOT
 * enforced by that platform-level access setting (it's set to Anyone on
 * purpose — see README) but independently, in every request, by verifying
 * the Google ID token the frontend sends and checking it against the
 * Volunteers allow-list sheet.
 *
 * Facility matching uses `facility_name`, never `facility_id`/`id`. Per
 * PIPELINE.md in the main repo, those id columns are formulas that count
 * non-blank rows and are NOT stable — deleting one row shifts every id below
 * it. Names are the real key the rest of the site is built on.
 */

// --- Configuration ---------------------------------------------------------

// One entry per portal section, mirroring PIPELINE.md's spreadsheet table
// exactly. Never invent a new spreadsheet ID here — copy from PIPELINE.md.
const SPREADSHEETS = {
  hospitals: {
    spreadsheetId: "1JUJTf0sdPo4o-DluzuwjMOMAc6Fhe4k9kFv-UIXyMg4",
    facilitiesSheet: "Hospital_facilities",
    incidentsSheet: "Hospital_incidents",
  },
  universities: {
    spreadsheetId: "1USy-ZPTwzio49_yKkkc-5WPOscIBDa5tetRZ8NTWZFo",
    facilitiesSheet: "University_facilities",
    incidentsSheet: "University_incidents",
  },
  schools: {
    spreadsheetId: "1NuD4YMqCwUZyCDE4r0xHyzBdWod9WFH-cEuN6eP7LWw",
    facilitiesSheet: "Schools_facilities",
    incidentsSheet: "Schools_incidents",
  },
  "religious-sites": {
    spreadsheetId: "1_zn0gHo2XlEoQFHtPwNxJG6pFvYiK9WbYiR-6thxj7A",
    // sic — the tab is spelled "Religous" (missing the "i") in the live
    // sheet; PIPELINE.md flags this as load-bearing, do not "fix" it here.
    facilitiesSheet: "Religous_facilities",
    incidentsSheet: "Religous_incidents",
  },
};

// Spreadsheet + tab holding the volunteer allow-list. Column A: email,
// column B: role — blank/"volunteer" (submit only), "editor" (can also
// edit existing incidents), or "admin" (editor privileges plus the
// activity log). A coordinator maintains this directly.
const VOLUNTEERS_SPREADSHEET_ID = "1eAaU37vq3EszdzsHWoa-ln0DNouQX3It0-VkWK1vUss";
const VOLUNTEERS_SHEET_NAME = "Volunteers";

// Google OAuth client ID the frontend signs in with (config.js). ID tokens
// are only accepted if their `aud` claim matches this.
const OAUTH_CLIENT_ID = "1017482285870-q0dl90l30asn736kad0u7qbucopj209a.apps.googleusercontent.com";

// --- Archive-priorities dashboard (editor role) --------------------------
// The main site repo. The portal reads data/source-domains.json (the domain
// inventory the archiver emits) and commits data/archive-policy.json back.
const MAIN_REPO = { owner: "PalGenoPedia", repo: "PalGenoPedia", branch: "main" };

// Two namespaces: "source" (article/report links) and "media" (video_url /
// image_url). Each has its own inventory (read) + policy (write) file.
const POLICY_FILES = {
  source: { policy: "data/archive-policy.json", domains: "data/source-domains.json" },
  media: { policy: "data/media-policy.json", domains: "data/media-domains.json" },
};
function policyFiles_(kind) {
  return POLICY_FILES[kind] || POLICY_FILES.source;
}

const ARCHIVE_PRIORITIES = ["high", "normal", "skip"];
const ARCHIVE_METHODS = ["wayback", "archivetoday", "archivebox", "manual"];

// Fine-grained PAT — repo access limited to PalGenoPedia/PalGenoPedia,
// permission Contents: Read and write, nothing else. Stored in
// Project Settings -> Script properties as GITHUB_TOKEN. NEVER inline it here
// (see README -> "Archive priorities").
function githubToken_() {
  const t = PropertiesService.getScriptProperties().getProperty("GITHUB_TOKEN");
  if (!t) throw new PortalError("config_error", "GITHUB_TOKEN script property is not set.");
  return t;
}

// Facilities-tab headers.
const FACILITY_NAME_COL = "name";

// Incidents-tab headers — must match PIPELINE.md's incident schema exactly
// so a submitted row is indistinguishable from a manually typed one.
const INC = {
  facilityName: "facility_name",
  facilityId: "facility_id", // best-effort only, copied from the facilities tab if present — never matched on
  startingDate: "starting_date",
  endingDate: "ending_date",
  attackType: "attack_type",
  description: "full_discription", // sic — matches the live (misspelled) header
  sourceUrl1: "source_url_1",
  sourceUrl2: "source_url_2",
  imageUrl: "image_url",
  videoUrl: "video_url",
  civiliansKilled: "civilians_killed",
  civiliansInjured: "civilians_injured",
  addedBy: "added_by",
  // Additive column, not in PIPELINE.md's schema — add a `submission_id`
  // header to the incidents tab so reviewers can trace a row back to its
  // portal submission even after incident_id shifts under it later.
  submissionId: "submission_id",
  // Additive, optional — filled in only on an edit, never on first submit.
  lastEditedBy: "last_edited_by",
  lastEditedAt: "last_edited_at",
};

// --- Entry points ------------------------------------------------------

function doGet(e) {
  return withErrorHandling(() => {
    const volunteer = requireVolunteer(e.parameter.token);
    const action = e.parameter.action;

    if (action === "whoami") {
      return jsonResponse({ email: volunteer.email, isEditor: volunteer.isEditor, isAdmin: volunteer.isAdmin });
    }
    if (action === "facilities") {
      return jsonResponse({ facilities: listFacilities(e.parameter.section) });
    }
    if (action === "incidents") {
      return jsonResponse({
        incidents: listIncidents(e.parameter.section, e.parameter.facility),
      });
    }
    if (action === "activity_log") {
      if (!volunteer.isAdmin) throw new PortalError("not_authorized", "Only admins can view the activity log.");
      return jsonResponse({ entries: listActivityLog(200) });
    }
    if (action === "archive_policy") {
      if (!volunteer.isEditor) throw new PortalError("not_authorized", "Only editors can manage archive priorities.");
      return jsonResponse(getArchivePolicy(e.parameter.kind));
    }
    return jsonResponse({ error: "unknown_action", message: "Unknown action: " + action + ". The deployed script may be out of date." });
  });
}

function doPost(e) {
  return withErrorHandling(() => {
    const body = JSON.parse(e.postData.contents);
    const volunteer = requireVolunteer(body.token);

    if (body.action === "submit_incident") {
      return jsonResponse(submitIncident(body, volunteer.email));
    }
    if (body.action === "update_incident") {
      return jsonResponse(updateIncident(body, volunteer));
    }
    if (body.action === "set_archive_policy") {
      return jsonResponse(setArchivePolicy(body, volunteer));
    }
    if (body.action === "set_archived_url") {
      return jsonResponse(setArchivedUrl(body, volunteer));
    }
    return jsonResponse({ error: "unknown_action", message: "Unknown action: " + body.action + ". The deployed script may be out of date." });
  });
}

// --- Auth ------------------------------------------------------------------

// Returns { email, role, isEditor, isAdmin }. Throws not_approved_volunteer
// for anyone not on the allow-list at all, regardless of role. "admin"
// implies editor privileges as well as the activity log.
function requireVolunteer(idToken) {
  if (!idToken) throw new PortalError("not_approved_volunteer", "Missing token.");

  const email = verifyIdToken(idToken);
  const roles = getVolunteerRoles();
  const role = roles.get(email.toLowerCase());
  if (role === undefined) {
    throw new PortalError("not_approved_volunteer", email + " is not an approved volunteer.");
  }
  return {
    email: email,
    role: role,
    isEditor: role === "editor" || role === "admin",
    isAdmin: role === "admin",
  };
}

// Verifies a Google-issued ID token via Google's tokeninfo endpoint rather
// than Session.getActiveUser(), because the frontend is a different origin
// and this deployment's Access is "Anyone" (see README for why).
function verifyIdToken(idToken) {
  const res = UrlFetchApp.fetch(
    "https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(idToken),
    { muteHttpExceptions: true }
  );
  if (res.getResponseCode() !== 200) {
    throw new PortalError("invalid_token", "Could not verify sign-in. Please sign in again.");
  }
  const info = JSON.parse(res.getContentText());
  if (info.aud !== OAUTH_CLIENT_ID) {
    throw new PortalError("invalid_token", "Token was not issued for this app.");
  }
  if (!info.email_verified || info.email_verified === "false") {
    throw new PortalError("invalid_token", "Email is not verified on this Google account.");
  }
  return info.email;
}

// Map<lowercased email, "admin" | "editor" | "volunteer">. Column B blank
// or anything other than "editor"/"admin" (case-insensitive) counts as a
// plain volunteer.
function getVolunteerRoles() {
  const sheet = SpreadsheetApp.openById(VOLUNTEERS_SPREADSHEET_ID).getSheetByName(VOLUNTEERS_SHEET_NAME);
  const values = sheet.getRange(1, 1, sheet.getLastRow(), 2).getValues();
  const roles = new Map();
  for (const row of values) {
    const email = String(row[0] || "").trim().toLowerCase();
    if (!email || !email.includes("@")) continue;
    const rawRole = String(row[1] || "").trim().toLowerCase();
    const role = rawRole === "admin" ? "admin" : rawRole === "editor" ? "editor" : "volunteer";
    roles.set(email, role);
  }
  return roles;
}

// --- Reads ------------------------------------------------------------

function listFacilities(sectionId) {
  const config = requireSectionConfig(sectionId);
  const facilitiesSheet = SpreadsheetApp.openById(config.spreadsheetId).getSheetByName(config.facilitiesSheet);
  const facilityValues = facilitiesSheet.getDataRange().getValues();
  const facilityHeaders = facilityValues[0].map((h) => String(h).trim());
  const nameIdx = facilityHeaders.indexOf(FACILITY_NAME_COL);
  if (nameIdx === -1) throw new PortalError("config_error", "Facility name column not found.");

  const names = facilityValues
    .slice(1)
    .map((row) => String(row[nameIdx] || "").trim())
    .filter((name) => name);

  const counts = countIncidentsByFacility(config);

  return names
    .map((name) => ({ id: name, name: name, incidentCount: counts.get(name) || 0 }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function countIncidentsByFacility(config) {
  const { rows, headers } = readIncidentsSheet(config);
  const nameIdx = headers.indexOf(INC.facilityName);
  const counts = new Map();
  for (const row of rows) {
    const name = String(row[nameIdx] || "").trim();
    if (!name) continue;
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  return counts;
}

function listIncidents(sectionId, facilityName) {
  const config = requireSectionConfig(sectionId);
  const { rows, headers } = readIncidentsSheet(config);
  const nameIdx = headers.indexOf(INC.facilityName);
  const dateIdx = headers.indexOf(INC.startingDate);
  const endIdx = headers.indexOf(INC.endingDate);
  const typeIdx = headers.indexOf(INC.attackType);
  const descIdx = headers.indexOf(INC.description);
  const src1Idx = headers.indexOf(INC.sourceUrl1);
  const src2Idx = headers.indexOf(INC.sourceUrl2);
  const imageIdx = headers.indexOf(INC.imageUrl);
  const videoIdx = headers.indexOf(INC.videoUrl);
  const killedIdx = headers.indexOf(INC.civiliansKilled);
  const injuredIdx = headers.indexOf(INC.civiliansInjured);

  const col = (row, idx) => (idx !== -1 ? String(row[idx] || "") : "");

  const result = [];
  rows.forEach((row, i) => {
    if (String(row[nameIdx] || "").trim() !== facilityName) return;
    result.push({
      // Sheet row number (1-indexed, header is row 1). Round-tripped back
      // by an editor's update request to identify which row to overwrite —
      // never persisted, never used as a stable id across requests.
      row: i + 2,
      date: formatDate(row[dateIdx]),
      endingDate: endIdx !== -1 ? formatDate(row[endIdx]) : "",
      attackType: col(row, typeIdx),
      description: col(row, descIdx),
      sourceUrl1: col(row, src1Idx),
      sourceUrl2: col(row, src2Idx),
      imageUrl: col(row, imageIdx),
      videoUrl: col(row, videoIdx),
      civiliansKilled: col(row, killedIdx),
      civiliansInjured: col(row, injuredIdx),
    });
  });
  return result;
}

function readIncidentsSheet(config) {
  const sheet = SpreadsheetApp.openById(config.spreadsheetId).getSheetByName(config.incidentsSheet);
  const values = sheet.getDataRange().getValues();
  const headers = values[0].map((h) => String(h).trim());
  return { headers: headers, rows: values.slice(1) };
}

function requireSectionConfig(sectionId) {
  const config = SPREADSHEETS[sectionId];
  if (!config) throw new PortalError("unknown_section", "Unknown section: " + sectionId);
  return config;
}

// --- Writes -----------------------------------------------------------

function submitIncident(body, email) {
  const config = requireSectionConfig(body.section);
  const fields = body.fields || {};
  validateSubmission(fields);

  const facilityName = body.facility;
  if (!facilityName) throw new PortalError("validation_failed", "Missing facility.");

  const incidentsSheet = SpreadsheetApp.openById(config.spreadsheetId).getSheetByName(config.incidentsSheet);
  const headers = incidentsSheet.getRange(1, 1, 1, incidentsSheet.getLastColumn()).getValues()[0].map((h) => String(h).trim());

  // Deliberately NOT sheet.appendRow(): that method appends after the last
  // row with content in ANY column of the whole sheet, and these sheets
  // carry formula columns (id/incident_id, translation tabs) dragged far
  // past the real data as padding — a cell holding a formula counts as
  // "content" even when it displays blank. appendRow lands past all of
  // that, disconnected from the real incidents and past wherever the id
  // formula was dragged to, which is why a submitted incident could show up
  // far below the real rows with no incident_id at all.
  //
  // Instead: find the last row with a real facility_name (the actual data
  // column, never padded) and insert immediately after it, then explicitly
  // copy that row's formula cells (id, incident_id, and anything else
  // formula-driven) down into the new row. Note this does NOT happen
  // automatically — the Sheets UI's "auto-extend a formula into a newly
  // inserted row" behavior is a client-side convenience, not something
  // Apps Script's insertRowAfter() replicates on its own.
  const lastDataRow = findLastDataRow(incidentsSheet, headers);
  incidentsSheet.insertRowAfter(lastDataRow);
  const newRowNumber = lastDataRow + 1;
  copyFormulaCells(incidentsSheet, lastDataRow, newRowNumber, headers.length);

  const setCell = (headerName, value) => {
    const idx = headers.indexOf(headerName);
    if (idx !== -1) incidentsSheet.getRange(newRowNumber, idx + 1).setValue(value);
  };

  try {
    setCell(INC.facilityName, facilityName);
    setCell(INC.facilityId, lookupFacilityId(config, facilityName)); // best-effort, not used for matching
    setCell(INC.startingDate, fields.starting_date || "");
    setCell(INC.endingDate, fields.ending_date || "");
    setCell(INC.attackType, fields.attack_type || "");
    setCell(INC.description, fields.description || "");
    setCell(INC.sourceUrl1, fields.source_url_1 || "");
    setCell(INC.sourceUrl2, fields.source_url_2 || "");
    setCell(INC.imageUrl, fields.image_url || "");
    setCell(INC.videoUrl, fields.video_url || "");
    setCell(INC.civiliansKilled, fields.civilians_killed || "");
    setCell(INC.civiliansInjured, fields.civilians_injured || "");
    setCell(INC.addedBy, email);
    setCell(INC.submissionId, body.submissionId || "");
  } catch (err) {
    notifyCoordinatorOfFailure(email, body, err);
    throw new PortalError("append_failed", "Could not save the incident. Please try again or contact a coordinator.");
  }

  logSubmission(email, "submit", body.section, body.facility, body.submissionId || "");
  return { ok: true };
}

// Copies every formula cell (id, incident_id, or anything else
// formula-driven) into targetRow, one column at a time. For each column,
// finds the nearest row that actually has a live formula there — checking
// upward from lastDataRow first, then downward past targetRow if nothing
// turned up above. Both directions matter here: the real, hand-entered
// incident rows can be plain typed text with no formula at all (that's
// what the live Hospital_incidents sheet turned out to have), while a
// formula pattern like `id`/`incident_id`'s running counter may only exist
// as pre-dragged padding further down the sheet, past any real data.
// copyTo() adjusts relative references the same way a manual drag-down
// would, regardless of how far or which direction the source row is from
// the target. Plain-value columns are left untouched here — the caller
// writes those explicitly via setCell.
function copyFormulaCells(sheet, lastDataRow, targetRow, numCols) {
  const sheetMaxRow = sheet.getMaxRows();
  for (let c = 1; c <= numCols; c++) {
    const sourceRow =
      findFormulaSourceRowUpward(sheet, c, lastDataRow) ||
      findFormulaSourceRowDownward(sheet, c, targetRow + 1, sheetMaxRow);
    if (sourceRow) {
      sheet.getRange(sourceRow, c).copyTo(sheet.getRange(targetRow, c));
    }
  }
}

// Nearest row at or above searchFromRow (down to row 2) whose cell in this
// column holds a live formula. Returns null if none of them do.
function findFormulaSourceRowUpward(sheet, col, searchFromRow) {
  if (searchFromRow < 2) return null;
  const formulas = sheet.getRange(2, col, searchFromRow - 1, 1).getFormulas();
  for (let i = formulas.length - 1; i >= 0; i--) {
    if (formulas[i][0]) return i + 2;
  }
  return null;
}

// Nearest row at or below searchFromRow whose cell in this column holds a
// live formula. Capped at a few thousand rows past searchFromRow so a
// sheet with no formula at all anywhere doesn't force a huge read.
function findFormulaSourceRowDownward(sheet, col, searchFromRow, maxRow) {
  if (searchFromRow > maxRow) return null;
  const numRows = Math.min(maxRow - searchFromRow + 1, 5000);
  const formulas = sheet.getRange(searchFromRow, col, numRows, 1).getFormulas();
  for (let i = 0; i < formulas.length; i++) {
    if (formulas[i][0]) return searchFromRow + i;
  }
  return null;
}

// Last row where the facility_name column actually has a value — unlike
// sheet.getLastRow(), this ignores padding rows further down that only
// contain a dragged formula in some other column.
function findLastDataRow(sheet, headers) {
  const nameIdx = headers.indexOf(INC.facilityName);
  if (nameIdx === -1) return sheet.getLastRow();
  const values = sheet.getRange(2, nameIdx + 1, sheet.getMaxRows() - 1, 1).getValues();
  let last = 1; // header row, if the sheet is otherwise empty
  for (let i = 0; i < values.length; i++) {
    if (String(values[i][0] || "").trim() !== "") last = i + 2;
  }
  return last;
}

// Overwrites an existing incident row in place. Restricted to volunteers
// with the "editor" role. The row number came from a listIncidents() call
// the client made earlier; before writing, re-read that row and confirm it
// still belongs to the expected facility, so a row that shifted (someone
// else inserted/deleted rows in between) fails loudly instead of silently
// overwriting the wrong incident.
function updateIncident(body, volunteer) {
  if (!volunteer.isEditor) {
    throw new PortalError("not_authorized", "Only approved editors can update existing incidents.");
  }
  const config = requireSectionConfig(body.section);
  const fields = body.fields || {};
  validateSubmission(fields);

  const rowNumber = Number(body.row);
  if (!rowNumber || rowNumber < 2) {
    throw new PortalError("validation_failed", "Missing or invalid row reference.");
  }

  const incidentsSheet = SpreadsheetApp.openById(config.spreadsheetId).getSheetByName(config.incidentsSheet);
  const headers = incidentsSheet.getRange(1, 1, 1, incidentsSheet.getLastColumn()).getValues()[0].map((h) => String(h).trim());
  const nameIdx = headers.indexOf(INC.facilityName);

  const existingRow = incidentsSheet.getRange(rowNumber, 1, 1, headers.length).getValues()[0];
  if (nameIdx === -1 || String(existingRow[nameIdx] || "").trim() !== body.facility) {
    throw new PortalError(
      "row_mismatch",
      "This incident has changed since you loaded it (maybe another edit landed first). Please refresh and try again."
    );
  }

  const setCell = (headerName, value) => {
    const idx = headers.indexOf(headerName);
    if (idx !== -1) incidentsSheet.getRange(rowNumber, idx + 1).setValue(value);
  };

  setCell(INC.startingDate, fields.starting_date || "");
  setCell(INC.endingDate, fields.ending_date || "");
  setCell(INC.attackType, fields.attack_type || "");
  setCell(INC.description, fields.description || "");
  setCell(INC.sourceUrl1, fields.source_url_1 || "");
  setCell(INC.sourceUrl2, fields.source_url_2 || "");
  setCell(INC.imageUrl, fields.image_url || "");
  setCell(INC.videoUrl, fields.video_url || "");
  setCell(INC.civiliansKilled, fields.civilians_killed || "");
  setCell(INC.civiliansInjured, fields.civilians_injured || "");
  setCell(INC.lastEditedBy, volunteer.email);
  setCell(INC.lastEditedAt, new Date());

  logSubmission(volunteer.email, "edit", body.section, body.facility, "row " + rowNumber);
  return { ok: true };
}

// Best-effort only — per PIPELINE.md this id is a formula and can be stale
// the moment it's read. Never used to look anything up, only carried along
// for a reviewer's convenience.
function lookupFacilityId(config, facilityName) {
  const facilitiesSheet = SpreadsheetApp.openById(config.spreadsheetId).getSheetByName(config.facilitiesSheet);
  const values = facilitiesSheet.getDataRange().getValues();
  const headers = values[0].map((h) => String(h).trim());
  const nameIdx = headers.indexOf(FACILITY_NAME_COL);
  const idIdx = headers.indexOf("id");
  if (idIdx === -1) return "";
  for (const row of values.slice(1)) {
    if (String(row[nameIdx] || "").trim() === facilityName) return row[idIdx];
  }
  return "";
}

function validateSubmission(fields) {
  const required = ["starting_date", "attack_type", "source_url_1"];
  for (const field of required) {
    if (!fields[field] || String(fields[field]).trim() === "") {
      throw new PortalError("validation_failed", "Missing required field: " + field);
    }
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fields.starting_date)) {
    throw new PortalError("validation_failed", "starting_date must be YYYY-MM-DD.");
  }
  for (const urlField of ["source_url_1", "source_url_2", "image_url", "video_url"]) {
    const value = fields[urlField];
    if (value && !/^https?:\/\/\S+$/.test(value)) {
      throw new PortalError("validation_failed", urlField + " must be a valid URL.");
    }
  }
  for (const numField of ["civilians_killed", "civilians_injured"]) {
    const value = fields[numField];
    if (value && (isNaN(value) || Number(value) < 0)) {
      throw new PortalError("validation_failed", numField + " must be a non-negative number.");
    }
  }
}

// --- Archive-priorities dashboard --------------------------------------

// GET the inventory (*-domains.json) + current rules (*-policy.json) for a
// namespace ("source" | "media"), merged into what the dashboard table needs.
function getArchivePolicy(kind) {
  const files = policyFiles_(kind);
  const inv = githubGetContent_(files.domains);
  const pol = githubGetContent_(files.policy);
  const domains = (inv.json && inv.json.domains) || {};
  const policy = (pol.json && pol.json.domains) || {};

  const list = Object.keys(domains).map(function (d) {
    const row = domains[d] || {};
    return {
      domain: d,
      count: Number(row.count) || 0,
      sample: String(row.sample || ""),
      archived: Number(row.archived) || 0,
      pending: Number(row.pending) || 0,
      deferred: Number(row.deferred) || 0,
      primary: Number(row.primary) || 0,
      secondary: Number(row.secondary) || 0,
      video: Number(row.video) || 0,
      image: Number(row.image) || 0,
      urls: Array.isArray(row.urls) ? row.urls : [],
    };
  });

  return {
    kind: kind === "media" ? "media" : "source",
    domains: list,
    policy: policy,
    enums: { priority: ARCHIVE_PRIORITIES, method: ARCHIVE_METHODS },
    note: inv.json ? "" : ("The domain inventory isn't published yet — the main repo's build workflow generates " + files.domains + "."),
  };
}

// Apply one or more { domain, priority, method } changes to a namespace's
// *-policy.json in the main repo (body.kind selects source|media). Editor role
// only. Re-reads the file (for its sha) immediately before writing, and retries
// once on a concurrent-edit conflict.
function setArchivePolicy(body, volunteer) {
  if (!volunteer.isEditor) {
    throw new PortalError("not_authorized", "Only editors can manage archive priorities.");
  }
  const files = policyFiles_(body.kind);
  const changes = body.changes || [{ domain: body.domain, priority: body.priority, method: body.method }];
  if (!changes.length) throw new PortalError("validation_failed", "No changes given.");
  changes.forEach(function (c) {
    if (!c.domain || String(c.domain).indexOf(".") === -1) {
      throw new PortalError("validation_failed", "Bad domain: " + c.domain);
    }
    if (ARCHIVE_PRIORITIES.indexOf(c.priority) === -1) {
      throw new PortalError("validation_failed", "Bad priority: " + c.priority);
    }
    if (ARCHIVE_METHODS.indexOf(c.method) === -1) {
      throw new PortalError("validation_failed", "Bad method: " + c.method);
    }
  });

  const kind = body.kind === "media" ? "media" : "source";
  for (let attempt = 0; attempt < 2; attempt++) {
    const cur = githubGetContent_(files.policy);
    const doc = cur.json && typeof cur.json === "object" ? cur.json : {};
    if (!doc.domains || typeof doc.domains !== "object") doc.domains = {};

    changes.forEach(function (c) {
      doc.domains[String(c.domain).toLowerCase()] = { priority: c.priority, method: c.method };
    });

    const sorted = {};
    Object.keys(doc.domains).sort().forEach(function (k) { sorted[k] = doc.domains[k]; });
    doc.domains = sorted;
    doc.version = 1;
    doc.updated = Utilities.formatDate(new Date(), "Etc/UTC", "yyyy-MM-dd");
    doc.updated_by = volunteer.email;

    const label = changes.length === 1
      ? changes[0].domain + " → " + changes[0].priority + "/" + changes[0].method
      : changes.length + " domains";

    try {
      githubPutContent_(files.policy, doc, cur.sha,
        kind + "-policy: " + label + " (" + volunteer.email + ")");
    } catch (err) {
      if (err.code === "policy_conflict" && attempt === 0) continue;
      throw err;
    }

    changes.forEach(function (c) {
      logSubmission(volunteer.email, kind + "-policy", "-", c.domain, c.priority + "/" + c.method);
    });
    return { ok: true, updated: doc.updated };
  }
  throw new PortalError("policy_conflict", "Another edit landed first — reload and try again.");
}

// Record a hand-made archive snapshot for one URL in data/archived-links.json.
// Editor role only. Sets status "archived" + manual:true so the weekly archiver
// leaves it alone and the generated pages show a 🕰 link to `archive_url`.
function setArchivedUrl(body, volunteer) {
  if (!volunteer.isEditor) {
    throw new PortalError("not_authorized", "Only editors can record archive links.");
  }
  const url = String(body.url || "").trim().replace(/\/$/, "").split("#")[0];
  const snap = String(body.archive_url || "").trim();
  if (!/^https?:\/\/\S+$/.test(url)) throw new PortalError("validation_failed", "Bad source URL.");
  if (!/^https?:\/\/\S+$/.test(snap)) throw new PortalError("validation_failed", "Archive link must be a full http(s) URL.");

  const STATE_PATH = "data/archived-links.json";
  for (let attempt = 0; attempt < 2; attempt++) {
    const cur = githubGetContent_(STATE_PATH);
    const doc = cur.json && typeof cur.json === "object" ? cur.json : {};
    const prev = doc[url] && typeof doc[url] === "object" ? doc[url] : {};
    doc[url] = {
      status: "archived",
      wayback: snap,
      method: "manual",
      manual: true,
      manual_by: volunteer.email,
      checked: Utilities.formatDate(new Date(), "Etc/UTC", "yyyy-MM-dd"),
      social: prev.social || false,
    };
    const sorted = {};
    Object.keys(doc).sort().forEach(function (k) { sorted[k] = doc[k]; });

    try {
      githubPutContent_(STATE_PATH, sorted, cur.sha,
        "archived-links: manual snapshot (" + volunteer.email + ")");
    } catch (err) {
      if (err.code === "policy_conflict" && attempt === 0) continue;
      throw err;
    }
    logSubmission(volunteer.email, "manual-archive", "-", url, snap);
    return { ok: true, url: url, snap: snap };
  }
  throw new PortalError("policy_conflict", "archived-links.json changed under us — reload and retry.");
}

// --- GitHub Contents API (main repo) ----------------------------------

function githubHeaders_() {
  return {
    Authorization: "token " + githubToken_(),
    Accept: "application/vnd.github+json",
    "User-Agent": "PalGenoPedia-Volunteer-Portal",
  };
}

// { json, sha } for a repo file. json is null (sha null) on 404. Throws on any
// other non-200.
function githubGetContent_(path) {
  const url = "https://api.github.com/repos/" + MAIN_REPO.owner + "/" + MAIN_REPO.repo +
    "/contents/" + path + "?ref=" + encodeURIComponent(MAIN_REPO.branch);
  const res = UrlFetchApp.fetch(url, { headers: githubHeaders_(), muteHttpExceptions: true });
  const code = res.getResponseCode();
  if (code === 404) return { json: null, sha: null };
  if (code !== 200) {
    throw new PortalError("github_error", "GitHub GET " + path + " -> " + code + " " + res.getContentText().slice(0, 300));
  }
  const meta = JSON.parse(res.getContentText());
  // GitHub wraps the base64 payload at 60 chars with newlines — strip whitespace
  // before decoding or Utilities.base64Decode throws.
  const b64 = String(meta.content || "").replace(/\s+/g, "");
  const text = b64 ? Utilities.newBlob(Utilities.base64Decode(b64)).getDataAsString() : "";
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
  return { json: json, sha: meta.sha };
}

// PUT a JSON object to a repo file. Pass sha=null to create. Maps GitHub's
// stale-sha conflict (409/422) to PortalError "policy_conflict".
function githubPutContent_(path, obj, sha, message) {
  const url = "https://api.github.com/repos/" + MAIN_REPO.owner + "/" + MAIN_REPO.repo +
    "/contents/" + path;
  const payload = {
    message: message,
    content: Utilities.base64Encode(JSON.stringify(obj, null, 1), Utilities.Charset.UTF_8),
    branch: MAIN_REPO.branch,
  };
  if (sha) payload.sha = sha;
  const res = UrlFetchApp.fetch(url, {
    method: "put",
    headers: githubHeaders_(),
    contentType: "application/json",
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });
  const code = res.getResponseCode();
  if (code === 409 || code === 422) {
    throw new PortalError("policy_conflict", "The policy file changed under us.");
  }
  if (code !== 200 && code !== 201) {
    throw new PortalError("github_error", "GitHub PUT " + path + " -> " + code + " " + res.getContentText().slice(0, 300));
  }
  return JSON.parse(res.getContentText());
}

// --- Audit log + failure notification ----------------------------------

// Fixed column order: Timestamp, Volunteer email, Action, Section,
// Facility, Reference. Read positionally by listActivityLog() below — this
// tab is internal-only, not part of PIPELINE.md's schema, so there's no
// header-name convention to match.
function logSubmission(email, actionType, section, facility, reference) {
  try {
    const ss = SpreadsheetApp.openById(VOLUNTEERS_SPREADSHEET_ID);
    const sheet = ss.getSheetByName("SubmissionLog") || ss.insertSheet("SubmissionLog");
    sheet.appendRow([new Date(), email, actionType, section, facility, reference]);
  } catch (err) {
    // Audit logging is best-effort; never let it fail the actual submission.
  }
}

// Most recent `limit` entries from the audit log, newest first. Admin-only
// (see doGet's "activity_log" action).
function listActivityLog(limit) {
  const sheet = SpreadsheetApp.openById(VOLUNTEERS_SPREADSHEET_ID).getSheetByName("SubmissionLog");
  if (!sheet || sheet.getLastRow() < 1) return [];

  const numRows = sheet.getLastRow();
  const values = sheet.getRange(1, 1, numRows, 6).getValues();
  const entries = values
    .map((row) => ({
      timestamp: row[0] instanceof Date ? row[0].toISOString() : String(row[0] || ""),
      email: String(row[1] || ""),
      action: String(row[2] || ""),
      section: String(row[3] || ""),
      facility: String(row[4] || ""),
      reference: String(row[5] || ""),
    }))
    .filter((entry) => entry.email.includes("@")); // drop the header row / any blank rows
  entries.reverse();
  return entries.slice(0, limit);
}

function notifyCoordinatorOfFailure(email, body, err) {
  try {
    MailApp.sendEmail(
      Session.getEffectiveUser().getEmail(),
      "Volunteer portal: submission failed",
      "Volunteer: " + email + "\nSection: " + body.section + "\nFacility: " + body.facility +
        "\nSubmission ID: " + body.submissionId + "\nError: " + err
    );
  } catch (mailErr) {
    // Best-effort notification only.
  }
}

// --- Helpers --------------------------------------------------------

function PortalError(code, message) {
  this.code = code;
  this.message = message;
}
PortalError.prototype = Object.create(Error.prototype);

function withErrorHandling(fn) {
  try {
    return fn();
  } catch (err) {
    const code = err.code || "internal_error";
    const message = err.message || String(err);
    return jsonResponse({ error: code, message: message });
  }
}

function jsonResponse(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(ContentService.MimeType.JSON);
}

function formatDate(value) {
  if (value instanceof Date) {
    return Utilities.formatDate(value, "Etc/UTC", "yyyy-MM-dd");
  }
  return String(value || "");
}
