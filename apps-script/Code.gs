/**
 * PalGenoPedia Volunteer Portal — Apps Script backend.
 *
 * Deploy as a Web App: Execute as "Me", Access "Anyone". Identity is NOT
 * enforced by that platform-level access setting (it's set to Anyone on
 * purpose — see README) but independently, in every request, by verifying
 * the Google ID token the frontend sends and checking it against the
 * Volunteers allow-list sheet.
 */

// --- Configuration ---------------------------------------------------------

// One entry per portal section. spreadsheetId/sheetName must point at the
// exact same spreadsheet + tab tools/build_records.py already reads for that
// section — never invent a new one. Fill these in from the main repo's
// PIPELINE.md / tools/apps-script/github-sync-fix.gs before deploying.
const SPREADSHEETS = {
  hospitals: {
    spreadsheetId: "REPLACE_WITH_HOSPITALS_SPREADSHEET_ID",
    sheetName: "Incidents",
  },
};

// Spreadsheet + tab holding the volunteer allow-list. One email per row in
// column A. A coordinator maintains this directly.
const VOLUNTEERS_SPREADSHEET_ID = "REPLACE_WITH_VOLUNTEERS_SPREADSHEET_ID";
const VOLUNTEERS_SHEET_NAME = "Volunteers";

// Google OAuth client ID the frontend signs in with (config.js). ID tokens
// are only accepted if their `aud` claim matches this.
const OAUTH_CLIENT_ID = "REPLACE_WITH_CLIENT_ID.apps.googleusercontent.com";

// Column mapping — must match PIPELINE.md's incident schema exactly so a
// submitted row is indistinguishable from a manually typed one. Adjust the
// header names on the right if a sheet's actual headers differ.
const COLUMN_MAP = {
  starting_date: "starting_date",
  ending_date: "ending_date",
  attack_type: "attack_type",
  description: "full_discription", // sic — matches the live (misspelled) header
  source_url_1: "source_url_1",
  source_url_2: "source_url_2",
  civilians_killed: "civilians_killed",
  civilians_injured: "civilians_injured",
  added_by: "added_by",
  submission_id: "submission_id",
};

const FACILITY_NAME_COLUMN = "facility_name"; // adjust to the real header
const FACILITY_ID_COLUMN = "facility_id"; // adjust to the real header, or reuse facility_name if there's no separate id

// --- Entry points ------------------------------------------------------

function doGet(e) {
  return withErrorHandling(() => {
    const email = requireVolunteer(e.parameter.token);
    const action = e.parameter.action;

    if (action === "whoami") {
      return jsonResponse({ email: email });
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
    const email = requireVolunteer(body.token);

    if (body.action !== "submit_incident") {
      return jsonResponse({ error: "unknown_action" });
    }
    return jsonResponse(submitIncident(body, email));
  });
}

// --- Auth ------------------------------------------------------------------

function requireVolunteer(idToken) {
  if (!idToken) throw new PortalError("not_approved_volunteer", "Missing token.");

  const email = verifyIdToken(idToken);
  const allowList = getAllowListEmails();
  if (allowList.indexOf(email.toLowerCase()) === -1) {
    throw new PortalError("not_approved_volunteer", email + " is not an approved volunteer.");
  }
  return email;
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

function getAllowListEmails() {
  const sheet = SpreadsheetApp.openById(VOLUNTEERS_SPREADSHEET_ID).getSheetByName(VOLUNTEERS_SHEET_NAME);
  const values = sheet.getRange(1, 1, sheet.getLastRow(), 1).getValues();
  return values
    .map((row) => String(row[0]).trim().toLowerCase())
    .filter((v) => v && v.includes("@"));
}

// --- Reads ------------------------------------------------------------

function listFacilities(sectionId) {
  const { rows, headers } = readSection(sectionId);
  const nameIdx = headers.indexOf(FACILITY_NAME_COLUMN);
  const idIdx = headers.indexOf(FACILITY_ID_COLUMN);
  if (nameIdx === -1) throw new PortalError("config_error", "Facility name column not found.");

  const counts = new Map();
  for (const row of rows) {
    const name = String(row[nameIdx] || "").trim();
    if (!name) continue;
    const id = idIdx !== -1 ? String(row[idIdx] || "").trim() : name;
    const key = id || name;
    if (!counts.has(key)) counts.set(key, { id: key, name: name, incidentCount: 0 });
    counts.get(key).incidentCount++;
  }
  return Array.from(counts.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function listIncidents(sectionId, facilityId) {
  const { rows, headers } = readSection(sectionId);
  const nameIdx = headers.indexOf(FACILITY_NAME_COLUMN);
  const idIdx = headers.indexOf(FACILITY_ID_COLUMN);
  const dateIdx = headers.indexOf(COLUMN_MAP.starting_date);
  const typeIdx = headers.indexOf(COLUMN_MAP.attack_type);
  const descIdx = headers.indexOf(COLUMN_MAP.description);

  return rows
    .filter((row) => {
      const key = idIdx !== -1 ? String(row[idIdx] || "").trim() : String(row[nameIdx] || "").trim();
      return key === facilityId;
    })
    .map((row) => ({
      date: formatDate(row[dateIdx]),
      attackType: typeIdx !== -1 ? String(row[typeIdx] || "") : "",
      description: descIdx !== -1 ? String(row[descIdx] || "") : "",
    }));
}

function readSection(sectionId) {
  const config = SPREADSHEETS[sectionId];
  if (!config) throw new PortalError("unknown_section", "Unknown section: " + sectionId);
  const sheet = SpreadsheetApp.openById(config.spreadsheetId).getSheetByName(config.sheetName);
  const values = sheet.getDataRange().getValues();
  const headers = values[0].map((h) => String(h).trim());
  return { headers: headers, rows: values.slice(1) };
}

// --- Writes -----------------------------------------------------------

function submitIncident(body, email) {
  const config = SPREADSHEETS[body.section];
  if (!config) throw new PortalError("unknown_section", "Unknown section: " + body.section);

  const fields = body.fields || {};
  validateSubmission(fields);

  const sheet = SpreadsheetApp.openById(config.spreadsheetId).getSheetByName(config.sheetName);
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map((h) => String(h).trim());

  // Append a blank row and let the sheet's own id/incident_id formulas fill
  // themselves in, exactly like a manually typed row — never write those
  // columns directly (see PIPELINE.md).
  const newRow = new Array(headers.length).fill("");

  const setByHeader = (headerName, value) => {
    const idx = headers.indexOf(headerName);
    if (idx !== -1) newRow[idx] = value;
  };

  setByHeader(FACILITY_NAME_COLUMN, getFacilityName(config, body.facility));
  if (headers.indexOf(FACILITY_ID_COLUMN) !== -1) setByHeader(FACILITY_ID_COLUMN, body.facility);
  setByHeader(COLUMN_MAP.starting_date, fields.starting_date || "");
  setByHeader(COLUMN_MAP.ending_date, fields.ending_date || "");
  setByHeader(COLUMN_MAP.attack_type, fields.attack_type || "");
  setByHeader(COLUMN_MAP.description, fields.description || "");
  setByHeader(COLUMN_MAP.source_url_1, fields.source_url_1 || "");
  setByHeader(COLUMN_MAP.source_url_2, fields.source_url_2 || "");
  setByHeader(COLUMN_MAP.civilians_killed, fields.civilians_killed || "");
  setByHeader(COLUMN_MAP.civilians_injured, fields.civilians_injured || "");
  setByHeader(COLUMN_MAP.added_by, email);
  setByHeader(COLUMN_MAP.submission_id, body.submissionId || "");

  try {
    sheet.appendRow(newRow);
  } catch (err) {
    notifyCoordinatorOfFailure(email, body, err);
    throw new PortalError("append_failed", "Could not save the incident. Please try again or contact a coordinator.");
  }

  logSubmission(email, body);
  return { ok: true };
}

function getFacilityName(config, facilityId) {
  const sheet = SpreadsheetApp.openById(config.spreadsheetId).getSheetByName(config.sheetName);
  const values = sheet.getDataRange().getValues();
  const headers = values[0].map((h) => String(h).trim());
  const nameIdx = headers.indexOf(FACILITY_NAME_COLUMN);
  const idIdx = headers.indexOf(FACILITY_ID_COLUMN);
  for (const row of values.slice(1)) {
    const key = idIdx !== -1 ? String(row[idIdx] || "").trim() : String(row[nameIdx] || "").trim();
    if (key === facilityId) return String(row[nameIdx] || "");
  }
  // Facility not already present in the sheet — fall back to the id itself
  // rather than failing the submission outright.
  return facilityId;
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
    const sheet = SpreadsheetApp.openById(VOLUNTEERS_SPREADSHEET_ID).getSheetByName("SubmissionLog")
      || SpreadsheetApp.openById(VOLUNTEERS_SPREADSHEET_ID).insertSheet("SubmissionLog");
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
