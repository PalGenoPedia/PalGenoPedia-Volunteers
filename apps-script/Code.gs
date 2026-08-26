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
// column B: role ("editor" or blank/"volunteer"). A coordinator maintains
// this directly — add a row to grant access, set column B to "editor" to
// let that person also edit existing incidents, not just submit new ones.
const VOLUNTEERS_SPREADSHEET_ID = "1eAaU37vq3EszdzsHWoa-ln0DNouQX3It0-VkWK1vUss";
const VOLUNTEERS_SHEET_NAME = "Volunteers";

// Google OAuth client ID the frontend signs in with (config.js). ID tokens
// are only accepted if their `aud` claim matches this.
const OAUTH_CLIENT_ID = "1017482285870-q0dl90l30asn736kad0u7qbucopj209a.apps.googleusercontent.com";

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
      return jsonResponse({ email: volunteer.email, isEditor: volunteer.isEditor });
    }
    if (action === "facilities") {
      return jsonResponse({ facilities: listFacilities(e.parameter.section) });
    }
    if (action === "incidents") {
      return jsonResponse({
        incidents: listIncidents(e.parameter.section, e.parameter.facility),
      });
    }
    return jsonResponse({ error: "unknown_action" });
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
    return jsonResponse({ error: "unknown_action" });
  });
}

// --- Auth ------------------------------------------------------------------

// Returns { email, isEditor }. Throws not_approved_volunteer for anyone not
// on the allow-list at all, editor or not.
function requireVolunteer(idToken) {
  if (!idToken) throw new PortalError("not_approved_volunteer", "Missing token.");

  const email = verifyIdToken(idToken);
  const roles = getVolunteerRoles();
  const role = roles.get(email.toLowerCase());
  if (role === undefined) {
    throw new PortalError("not_approved_volunteer", email + " is not an approved volunteer.");
  }
  return { email: email, isEditor: role === "editor" };
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

// Map<lowercased email, "editor" | "volunteer">. Column B blank or anything
// other than "editor" (case-insensitive) counts as a plain volunteer.
function getVolunteerRoles() {
  const sheet = SpreadsheetApp.openById(VOLUNTEERS_SPREADSHEET_ID).getSheetByName(VOLUNTEERS_SHEET_NAME);
  const values = sheet.getRange(1, 1, sheet.getLastRow(), 2).getValues();
  const roles = new Map();
  for (const row of values) {
    const email = String(row[0] || "").trim().toLowerCase();
    if (!email || !email.includes("@")) continue;
    const role = String(row[1] || "").trim().toLowerCase() === "editor" ? "editor" : "volunteer";
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
  // column, never padded) and insert immediately after it. Google Sheets
  // auto-extends a formula into a newly inserted row sitting inside its
  // dragged range — the same thing that happens when a human inserts a row
  // by hand — so id/incident_id fill in correctly.
  const lastDataRow = findLastDataRow(incidentsSheet, headers);
  incidentsSheet.insertRowAfter(lastDataRow);
  const newRowNumber = lastDataRow + 1;

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
    setCell(INC.civiliansKilled, fields.civilians_killed || "");
    setCell(INC.civiliansInjured, fields.civilians_injured || "");
    setCell(INC.addedBy, email);
    setCell(INC.submissionId, body.submissionId || "");
  } catch (err) {
    notifyCoordinatorOfFailure(email, body, err);
    throw new PortalError("append_failed", "Could not save the incident. Please try again or contact a coordinator.");
  }

  logSubmission(email, body);
  return { ok: true };
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
  setCell(INC.civiliansKilled, fields.civilians_killed || "");
  setCell(INC.civiliansInjured, fields.civilians_injured || "");
  setCell(INC.lastEditedBy, volunteer.email);
  setCell(INC.lastEditedAt, new Date());

  logSubmission(volunteer.email, {
    section: body.section,
    facility: body.facility,
    submissionId: "(edit of row " + rowNumber + ")",
  });
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
  const required = ["starting_date", "attack_type", "description", "source_url_1"];
  for (const field of required) {
    if (!fields[field] || String(fields[field]).trim() === "") {
      throw new PortalError("validation_failed", "Missing required field: " + field);
    }
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fields.starting_date)) {
    throw new PortalError("validation_failed", "starting_date must be YYYY-MM-DD.");
  }
  for (const urlField of ["source_url_1", "source_url_2"]) {
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

// --- Audit log + failure notification ----------------------------------

function logSubmission(email, body) {
  try {
    const ss = SpreadsheetApp.openById(VOLUNTEERS_SPREADSHEET_ID);
    const sheet = ss.getSheetByName("SubmissionLog") || ss.insertSheet("SubmissionLog");
    sheet.appendRow([new Date(), email, body.section, body.facility, body.submissionId]);
  } catch (err) {
    // Audit logging is best-effort; never let it fail the actual submission.
  }
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
