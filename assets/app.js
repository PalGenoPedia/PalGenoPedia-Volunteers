// Volunteer portal SPA. No framework, no build step — matches the main
// site's philosophy. All state lives in module-level vars; navigation is
// just swapping which <template> is cloned into #app.

const CONFIG = window.PORTAL_CONFIG;
const appEl = document.getElementById("app");
const idToken = sessionStorage.getItem("portal_id_token");

if (!idToken) {
  window.location.href = "index.html";
}

document.getElementById("signout").addEventListener("click", () => {
  sessionStorage.removeItem("portal_id_token");
  window.location.href = "index.html";
});

let state = {
  sections: CONFIG.SECTIONS,
  currentSection: null,
  facilities: [],
  currentFacility: null,
  incidents: [],
  isEditor: false,
  isAdmin: false,
};

// Must match the <option> list in app.html's #incident-form exactly — the
// edit form is built dynamically in JS and has no template of its own.
const ATTACK_TYPES = [
  "Airstrike",
  "Shelling",
  "Siege / access denial",
  "Raid / incursion",
  "Sniper fire",
  "Detention of staff or patients",
  "Other",
];

async function apiGet(params) {
  const url = new URL(CONFIG.API_URL);
  url.searchParams.set("token", idToken);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString());
  return handleApiResponse(res);
}

async function apiPost(body) {
  // Apps Script Web Apps don't handle CORS preflights well, so this must
  // stay a "simple request": no custom headers, text/plain body that the
  // backend itself parses as JSON.
  const res = await fetch(CONFIG.API_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ token: idToken, ...body }),
  });
  return handleApiResponse(res);
}

async function handleApiResponse(res) {
  let payload;
  try {
    payload = await res.json();
  } catch (e) {
    throw new Error("The server returned an unexpected response. Please try again.");
  }
  if (!res.ok || payload.error) {
    if (payload.error === "not_approved_volunteer") {
      sessionStorage.removeItem("portal_id_token");
      window.location.href = "index.html?denied=1";
      throw new Error("Not an approved volunteer.");
    }
    throw new Error(payload.message || "Request failed.");
  }
  return payload;
}

function render(templateId) {
  const tpl = document.getElementById(templateId);
  appEl.innerHTML = "";
  appEl.appendChild(tpl.content.cloneNode(true));
}

function el(role, root = appEl) {
  return root.querySelector(`[data-role="${role}"]`);
}

// --- Screens ---------------------------------------------------------

function showSections() {
  state.currentSection = null;
  render("tpl-sections");
  const grid = el("sections");
  for (const section of state.sections) {
    const btn = document.createElement("button");
    btn.className = "section-card";
    btn.textContent = section.label;
    btn.addEventListener("click", () => showFacilities(section));
    grid.appendChild(btn);
  }
}

async function showFacilities(section) {
  state.currentSection = section;
  render("tpl-facilities");
  el("section-title").textContent = section.label;
  const listEl = el("facility-list");
  listEl.innerHTML = '<p class="muted">Loading facilities…</p>';
  el("back-to-sections").addEventListener("click", showSections);

  try {
    const data = await apiGet({ action: "facilities", section: section.id });
    state.facilities = data.facilities || [];
    renderFacilityList(state.facilities);
  } catch (e) {
    listEl.innerHTML = `<p class="error">${escapeHtml(e.message)}</p>`;
  }

  el("facility-filter").addEventListener("input", (evt) => {
    const q = evt.target.value.trim().toLowerCase();
    renderFacilityList(state.facilities.filter((f) => f.name.toLowerCase().includes(q)));
  });
}

function renderFacilityList(facilities) {
  const listEl = el("facility-list");
  listEl.innerHTML = "";
  if (facilities.length === 0) {
    listEl.innerHTML = '<p class="muted">No facilities found.</p>';
    return;
  }
  for (const facility of facilities) {
    const row = document.createElement("button");
    row.className = "facility-row";
    row.innerHTML = `<span>${escapeHtml(facility.name)}</span>
      <span class="count">${facility.incidentCount} incident${facility.incidentCount === 1 ? "" : "s"}</span>`;
    row.addEventListener("click", () => showFacilityDetail(facility));
    listEl.appendChild(row);
  }
}

async function showFacilityDetail(facility) {
  state.currentFacility = facility;
  render("tpl-facility-detail");
  el("facility-title").textContent = facility.name;
  el("back-to-facilities").addEventListener("click", () => showFacilities(state.currentSection));

  const incidentListEl = el("incident-list");
  incidentListEl.innerHTML = '<p class="muted">Loading incidents…</p>';

  try {
    const data = await apiGet({
      action: "incidents",
      section: state.currentSection.id,
      facility: facility.id,
    });
    state.incidents = (data.incidents || []).sort((a, b) => (a.date < b.date ? 1 : -1));
    el("incident-count").textContent = `(${state.incidents.length})`;
    renderIncidentList(state.incidents);
  } catch (e) {
    incidentListEl.innerHTML = `<p class="error">${escapeHtml(e.message)}</p>`;
  }

  wireForm(facility);
}

function renderIncidentList(incidents) {
  const listEl = el("incident-list");
  listEl.innerHTML = "";
  if (incidents.length === 0) {
    listEl.innerHTML = '<p class="muted">No recorded incidents yet for this facility.</p>';
    return;
  }
  for (const incident of incidents) {
    const row = document.createElement("div");
    row.className = "incident-row";

    const summary = document.createElement("div");
    summary.innerHTML = `<div class="date">${escapeHtml(incident.date)} — ${escapeHtml(incident.attackType || "")}</div>
      <div class="small">${escapeHtml(truncate(incident.description || "", 160))}</div>`;
    row.appendChild(summary);

    if (state.isEditor) {
      const editBtn = document.createElement("button");
      editBtn.type = "button";
      editBtn.className = "link-btn small";
      editBtn.textContent = "Edit";
      editBtn.addEventListener("click", () => startEditIncident(row, incident));
      row.appendChild(editBtn);
    }

    listEl.appendChild(row);
  }
}

// Replaces one incident row with an inline, pre-filled edit form. Editor
// role only (see state.isEditor / the "Edit" button in renderIncidentList).
function startEditIncident(rowEl, incident) {
  const facility = state.currentFacility;
  rowEl.innerHTML = "";

  const form = document.createElement("form");
  form.className = "edit-form";

  const field = (label, name, type, value) => {
    const wrapper = document.createElement("label");
    wrapper.textContent = label;
    const input = document.createElement("input");
    input.type = type;
    input.name = name;
    input.value = value || "";
    wrapper.appendChild(input);
    form.appendChild(wrapper);
    return input;
  };

  field("Date", "starting_date", "date", incident.date).required = true;
  field("End date", "ending_date", "date", incident.endingDate);

  const typeLabel = document.createElement("label");
  typeLabel.textContent = "Attack type";
  const typeSelect = document.createElement("select");
  typeSelect.name = "attack_type";
  typeSelect.required = true;
  for (const t of ATTACK_TYPES) {
    const opt = document.createElement("option");
    opt.textContent = t;
    if (t === incident.attackType) opt.selected = true;
    typeSelect.appendChild(opt);
  }
  typeLabel.appendChild(typeSelect);
  form.appendChild(typeLabel);

  const descLabel = document.createElement("label");
  descLabel.textContent = "Summary / full account";
  const descArea = document.createElement("textarea");
  descArea.name = "description";
  descArea.rows = 4;
  descArea.value = incident.description || "";
  descLabel.appendChild(descArea);
  form.appendChild(descLabel);

  field("Source URL", "source_url_1", "url", incident.sourceUrl1).required = true;
  field("Additional source URL", "source_url_2", "url", incident.sourceUrl2);
  field("Image URL", "image_url", "url", incident.imageUrl);
  field("Video URL", "video_url", "url", incident.videoUrl);
  field("Civilians killed", "civilians_killed", "number", incident.civiliansKilled);
  field("Civilians injured", "civilians_injured", "number", incident.civiliansInjured);

  const saveBtn = document.createElement("button");
  saveBtn.type = "submit";
  saveBtn.textContent = "Save changes";
  form.appendChild(saveBtn);

  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "link-btn";
  cancelBtn.textContent = "Cancel";
  cancelBtn.addEventListener("click", () => showFacilityDetail(facility));
  form.appendChild(cancelBtn);

  const errorEl = document.createElement("p");
  errorEl.className = "error";
  errorEl.hidden = true;
  form.appendChild(errorEl);

  form.addEventListener("submit", async (evt) => {
    evt.preventDefault();
    saveBtn.disabled = true;
    errorEl.hidden = true;
    try {
      await apiPost({
        action: "update_incident",
        section: state.currentSection.id,
        facility: facility.id,
        row: incident.row,
        fields: Object.fromEntries(new FormData(form).entries()),
      });
      showFacilityDetail(facility);
    } catch (e) {
      errorEl.hidden = false;
      errorEl.textContent = e.message;
      saveBtn.disabled = false;
    }
  });

  rowEl.appendChild(form);
}

// --- Admin activity log --------------------------------------------------

async function showAdminLog() {
  render("tpl-admin-log");
  el("back-to-sections").addEventListener("click", showSections);

  const body = el("log-body");
  body.innerHTML = '<tr><td colspan="6" class="muted">Loading…</td></tr>';

  try {
    const data = await apiGet({ action: "activity_log" });
    const entries = data.entries || [];
    body.innerHTML = "";
    if (entries.length === 0) {
      body.innerHTML = '<tr><td colspan="6" class="muted">No activity yet.</td></tr>';
      return;
    }
    for (const entry of entries) {
      const tr = document.createElement("tr");
      const cells = [
        formatTimestamp(entry.timestamp),
        entry.email,
        entry.action,
        entry.section,
        entry.facility,
        entry.reference,
      ];
      for (const value of cells) {
        const td = document.createElement("td");
        td.textContent = value;
        tr.appendChild(td);
      }
      body.appendChild(tr);
    }
  } catch (e) {
    body.innerHTML = `<tr><td colspan="6" class="error">${escapeHtml(e.message)}</td></tr>`;
  }
}

function formatTimestamp(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

// --- Form / duplicate check -------------------------------------------

function wireForm(facility) {
  const form = el("incident-form");
  const dateInput = form.querySelector('[name="starting_date"]');
  const dupWarning = el("dup-warning");

  dateInput.addEventListener("change", () => {
    const match = findNearbyIncident(dateInput.value);
    if (match) {
      dupWarning.hidden = false;
      dupWarning.textContent =
        `Possible duplicate: an incident is already recorded on ${match.date}` +
        (match.attackType ? ` (${match.attackType})` : "") +
        ". Check the list on the left before submitting.";
    } else {
      dupWarning.hidden = true;
    }
  });

  form.addEventListener("submit", async (evt) => {
    evt.preventDefault();
    const submitBtn = form.querySelector('button[type="submit"]');
    const errorEl = el("submit-error");
    const successEl = el("submit-success");
    errorEl.hidden = true;
    successEl.hidden = true;
    submitBtn.disabled = true;

    const formData = new FormData(form);
    const payload = {
      action: "submit_incident",
      section: state.currentSection.id,
      facility: facility.id,
      submissionId: crypto.randomUUID(),
      fields: Object.fromEntries(formData.entries()),
    };

    try {
      await apiPost(payload);
      successEl.hidden = false;
      form.reset();
      dupWarning.hidden = true;
      // Refresh the incident list so the volunteer sees their own submission
      // reflected immediately (also re-sharpens the duplicate check).
      showFacilityDetail(facility);
    } catch (e) {
      errorEl.hidden = false;
      errorEl.textContent = e.message;
      submitBtn.disabled = false;
    }
  });
}

function findNearbyIncident(dateStr) {
  if (!dateStr) return null;
  const target = new Date(dateStr).getTime();
  const oneDay = 24 * 60 * 60 * 1000;
  return state.incidents.find((incident) => {
    const d = new Date(incident.date).getTime();
    return !Number.isNaN(d) && Math.abs(d - target) <= oneDay;
  });
}

// --- Utilities ----------------------------------------------------------

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function truncate(str, n) {
  return str.length > n ? str.slice(0, n) + "…" : str;
}

// --- Boot -----------------------------------------------------------------

(async function init() {
  try {
    const data = await apiGet({ action: "whoami" });
    state.isEditor = !!data.isEditor;
    state.isAdmin = !!data.isAdmin;
    const badge = state.isAdmin ? " (admin)" : state.isEditor ? " (editor)" : "";
    document.getElementById("whoami").textContent = data.email + badge;
    if (state.isAdmin) {
      const adminLink = document.getElementById("admin-link");
      adminLink.hidden = false;
      adminLink.addEventListener("click", showAdminLog);
    }
    showSections();
  } catch (e) {
    appEl.innerHTML = `<p class="error">${escapeHtml(e.message)}</p>`;
  }
})();
