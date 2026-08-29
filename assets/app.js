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
  histEvents: [],
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

// Top-level: three categories. "Archiving Portal" is editor-only.
function showHome() {
  state.currentSection = null;
  render("tpl-home");
  const grid = el("home-cats");
  const cats = [
    { label: "War Crimes", desc: "Universities, hospitals, schools, religious sites — document current incidents.", go: showSections },
    { label: "Historical War Crimes", desc: "Massacres and pre-October-2023 events. Being built — wired later.", go: showHistorical },
  ];
  if (state.isEditor) {
    cats.push({ label: "Archiving Portal", desc: "Source (resource) and media archiving priorities.", go: showArchivingHome });
  }
  for (const c of cats) {
    const btn = document.createElement("button");
    btn.className = "section-card";
    btn.innerHTML = `<strong>${escapeHtml(c.label)}</strong><span class="muted small">${escapeHtml(c.desc)}</span>`;
    btn.addEventListener("click", c.go);
    grid.appendChild(btn);
  }
}

const HIST_EVENT_TYPES = [
  "Massacre", "Ethnic cleansing", "Forced displacement", "Village destruction",
  "Bombing / shelling", "Siege", "Other",
];

// Historical event fields, in form order. [name, label, type, required]
// type: "text" | "date" | "textarea" | "select"
const HIST_FIELDS = [
  ["event_name", "Event name", "text", true],
  ["event_type", "Event type", "select", false],
  ["date_start", "Start date", "date", true],
  ["date_end", "End date", "date", false],
  ["date_context", "Date context (e.g. 'Under British Mandate')", "text", false],
  ["location_historical", "Location — historical name", "text", true],
  ["location_current", "Location — current name", "text", false],
  ["location_lat", "Latitude", "text", false],
  ["location_lng", "Longitude", "text", false],
  ["perpetrators", "Perpetrator(s)", "text", false],
  ["classification", "Legal classification", "text", false],
  ["deaths", "Deaths (free text, e.g. '≈107–250')", "text", false],
  ["injured", "Injured (free text)", "text", false],
  ["forced_displacement", "Forced displacement (free text)", "text", false],
  ["summary_para_1", "Summary — paragraph 1", "textarea", true],
  ["summary_para_2", "Summary — paragraph 2", "textarea", false],
  ["summary_para_3", "Summary — paragraph 3", "textarea", false],
  ["source_name", "Source — name / citation", "text", false],
  ["source_link", "Source — URL", "url", false],
];

async function showHistorical() {
  render("tpl-historical");
  el("back-to-home").addEventListener("click", showHome);

  const listEl = el("hist-list");
  listEl.innerHTML = '<p class="muted">Loading events…</p>';
  try {
    const data = await apiGet({ action: "hist_events" });
    state.histEvents = (data.events || []).sort((a, b) => (a.dateStart < b.dateStart ? 1 : -1));
    el("hist-count").textContent = `(${state.histEvents.length})`;
    renderHistList(state.histEvents);
  } catch (e) {
    listEl.innerHTML = `<p class="error">${escapeHtml(e.message)}</p>`;
  }

  buildHistForm(el("hist-form"), {});
  el("hist-form").addEventListener("submit", async (evt) => {
    evt.preventDefault();
    const btn = evt.target.querySelector('button[type="submit"]');
    const errEl = el("hist-error");
    const okEl = el("hist-success");
    errEl.hidden = okEl.hidden = true;
    btn.disabled = true;
    try {
      await apiPost({
        action: "submit_hist_event",
        submissionId: crypto.randomUUID(),
        fields: Object.fromEntries(new FormData(evt.target).entries()),
      });
      okEl.hidden = false;
      showHistorical(); // reload list + reset form
    } catch (e) {
      errEl.hidden = false;
      errEl.textContent = e.message;
      btn.disabled = false;
    }
  });
}

function renderHistList(events) {
  const listEl = el("hist-list");
  listEl.innerHTML = "";
  if (events.length === 0) {
    listEl.innerHTML = '<p class="muted">No events recorded yet.</p>';
    return;
  }
  for (const ev of events) {
    const row = document.createElement("div");
    row.className = "incident-row";
    const s = document.createElement("div");
    s.innerHTML = `<div class="date">${escapeHtml(ev.name)}</div>
      <div class="small">${escapeHtml(ev.dateStart || ev.dateEnd || "")}${ev.type ? " — " + escapeHtml(ev.type) : ""} · ${escapeHtml(truncate(ev.summary1 || "", 140))}</div>`;
    row.appendChild(s);
    if (state.isEditor) {
      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "link-btn small";
      edit.textContent = "Edit";
      edit.addEventListener("click", () => startEditHistEvent(row, ev));
      row.appendChild(edit);
    }
    listEl.appendChild(row);
  }
}

// Builds the field set into `form` (used for both the new-event form and the
// inline edit form). `values` pre-fills.
function buildHistForm(form, values) {
  form.innerHTML = "";
  for (const [name, label, type, required] of HIST_FIELDS) {
    const wrap = document.createElement("label");
    wrap.textContent = label + (required ? " *" : "");
    let input;
    if (type === "textarea") {
      input = document.createElement("textarea");
      input.rows = 3;
    } else if (type === "select") {
      input = document.createElement("select");
      const blank = document.createElement("option");
      blank.value = "";
      blank.textContent = "Select…";
      input.appendChild(blank);
      for (const t of HIST_EVENT_TYPES) {
        const o = document.createElement("option");
        o.value = t;
        o.textContent = t;
        input.appendChild(o);
      }
    } else {
      input = document.createElement("input");
      input.type = type;
    }
    input.name = name;
    if (required) input.required = true;
    if (values[name] != null) {
      if (input.tagName === "SELECT") input.value = values[name];
      else input.value = values[name];
    }
    wrap.appendChild(input);
    form.appendChild(wrap);
  }
  const submit = document.createElement("button");
  submit.type = "submit";
  submit.textContent = "Submit event";
  form.appendChild(submit);
}

function startEditHistEvent(rowEl, ev) {
  rowEl.innerHTML = "";
  const form = document.createElement("form");
  form.className = "edit-form";
  // Map the list-event shape back to form field names.
  buildHistForm(form, {
    event_name: ev.name, event_type: ev.type, date_start: ev.dateStart, date_end: ev.dateEnd,
    date_context: ev.dateContext, location_historical: ev.locHistorical, location_current: ev.locCurrent,
    location_lat: ev.lat, location_lng: ev.lng, perpetrators: ev.perpetrators,
    classification: ev.classification, deaths: ev.deaths, injured: ev.injured,
    forced_displacement: ev.displacement, summary_para_1: ev.summary1,
    summary_para_2: ev.summary2, summary_para_3: ev.summary3,
  });
  form.querySelector('button[type="submit"]').textContent = "Save changes";
  // The source_* fields don't apply to an edit — drop them.
  ["source_name", "source_link"].forEach((n) => {
    const f = form.querySelector(`[name="${n}"]`);
    if (f && f.parentElement) f.parentElement.remove();
  });

  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "link-btn";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", showHistorical);
  form.appendChild(cancel);

  const errEl = document.createElement("p");
  errEl.className = "error";
  errEl.hidden = true;
  form.appendChild(errEl);

  form.addEventListener("submit", async (evt) => {
    evt.preventDefault();
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    errEl.hidden = true;
    try {
      await apiPost({
        action: "update_hist_event",
        row: ev.row,
        name: ev.name,
        fields: Object.fromEntries(new FormData(form).entries()),
      });
      showHistorical();
    } catch (e) {
      errEl.hidden = false;
      errEl.textContent = e.message;
      btn.disabled = false;
    }
  });
  rowEl.appendChild(form);
}

function showArchivingHome() {
  render("tpl-archiving-home");
  el("back-to-home").addEventListener("click", showHome);
  el("go-resources").addEventListener("click", () => showPolicy("source"));
  el("go-media").addEventListener("click", () => showPolicy("media"));
}

function showSections() {
  state.currentSection = null;
  render("tpl-sections");
  el("back-to-home").addEventListener("click", showHome);
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
  el("back-to-home").addEventListener("click", showHome);

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

// --- Archive priorities (editor role) ----------------------------------

const METHOD_LABELS = {
  wayback: "Wayback Machine",
  archivetoday: "archive.today",
  archivebox: "ArchiveBox",
  manual: "Manual",
};

// Ordered — first match wins. `needles` are matched against the domain (exact
// host, ".suffix", or plain substring). Used only to SUGGEST a method per row;
// the editor is free to pick anything. "News & other" is the fallback.
const DOMAIN_CATEGORIES = [
  { key: "social", label: "Social / video", method: "archivetoday",
    why: "Wayback usually captures a login wall — archive.today (or manual) handles these.",
    needles: ["x.com", "twitter.com", "facebook.com", "fb.com", "instagram.com", "tiktok.com",
              "threads.net", "t.me", "telegram", "youtube.com", "youtu.be", "threadreaderapp",
              "remix.aljazeera.com"] },
  { key: "un", label: "UN / intergovernmental", method: "wayback",
    why: "Stable institutional sites — Wayback captures them cleanly.",
    needles: ["un.org", ".un.org", "unrwa", "unocha", "ohchr", "who.int", "icrc.org", "ifrc.org",
              "reliefweb.int", "icc-cpi.int", "icj-cij.org", "insecurityinsight"] },
  { key: "rights", label: "Rights / humanitarian", method: "wayback",
    why: "NGO reports — Wayback is fine; consider ArchiveBox later for PDFs.",
    needles: ["hrw.org", "amnesty.org", "btselem", "pchrgaza", "mezan.org", "adalah.org", "addameer",
              "dci-palestine", "euromedmonitor", "phr.org.il", "map.org.uk", "msf.org",
              "doctorswithoutborders", "muslimaid", "muslimnetwork", "breakingthesilence", "peacenow",
              "forensic-architecture", "zochrot", "scholarsatrisk", "librarianswithpalestine",
              "theelders", "imeu.org", "palestinercs", "hebronrc", "mesana.org", "merip.org",
              "euro-med"] },
  { key: "gov", label: "Government / military", method: "wayback",
    why: "Official statements — Wayback, and worth a snapshot before they change.",
    needles: [".gov", ".gov.il", ".gov.ps", ".gov.uk", ".pna.ps", "mfa.gov.il", "idf.il", "inss.org.il",
              "terrorism-info", "history.state.gov", "nationalarchives", "moh.gov.ps", "mohe.pna.ps",
              "pcbs.gov.ps", "gov.il"] },
  { key: "academic", label: "Academic / reference", method: "wayback",
    why: "Wayback for the page; ArchiveBox later if the source is a PDF/dataset.",
    needles: [".edu", ".edu.", ".ac.", "jstor", "cambridge.org", "palestine-studies", "palquest",
              "britannica", "wikipedia", "jewishvirtuallibrary", "uchicago.edu", "georgetown.edu",
              "ncbi.nlm.nih.gov", "universityworldnews", "qou.edu", "gazaeducationsector",
              "gazahcsector"] },
  { key: "news", label: "News / other", method: "wayback",
    why: "Wayback handles most news sites; a few paywalled ones may need archive.today.",
    needles: [] },
];

function categoryOf(domain) {
  const d = String(domain).toLowerCase();
  for (const c of DOMAIN_CATEGORIES) {
    for (const n of c.needles) {
      if (n[0] === "." ? d.endsWith(n) || d.includes(n) : d === n || d.includes(n)) return c;
    }
  }
  return DOMAIN_CATEGORIES[DOMAIN_CATEGORIES.length - 1]; // news & other
}

async function showPolicy(kind) {
  const isMedia = kind === "media";
  render(isMedia ? "tpl-media-policy" : "tpl-archive-policy");
  el("back-to-archiving").addEventListener("click", showArchivingHome);

  const body = el("policy-body");
  body.innerHTML = '<tr><td colspan="6" class="muted">Loading domains…</td></tr>';

  let data;
  try {
    data = await apiGet({ action: "archive_policy", kind });
  } catch (e) {
    body.innerHTML = `<tr><td colspan="6" class="error">${escapeHtml(e.message)}</td></tr>`;
    return;
  }

  const enums = data.enums || { priority: ["high", "normal", "skip"], method: Object.keys(METHOD_LABELS) };
  const policy = data.policy || {};
  // Most-cited first (sort by URL count, descending).
  const rows = (data.domains || []).slice().sort((a, b) => b.count - a.count);

  if (data.note) {
    const p = el("policy-error");
    p.hidden = false;
    p.classList.add("muted");
    p.textContent = data.note;
  }

  // Default method for an unconfigured domain: media is manual (no reliable
  // auto-capture yet); sources follow the category recommendation.
  const defaultMethod = (domain) => (isMedia ? "manual" : categoryOf(domain).method);

  const URL_STATUS = {
    archived: "🕰 archived",
    requested: "⏳ pending",
    deferred: "🕰 queued",
    failed: "⚠ failed",
    new: "— not yet",
  };

  // The expandable per-domain URL list. Each URL shows its status; anything not
  // archived gets an inline field to paste a hand-made snapshot link.
  function makeDetailRow(row) {
    const tr = document.createElement("tr");
    tr.className = "policy-detail";
    const td = document.createElement("td");
    td.colSpan = 6;
    const ul = document.createElement("ul");
    ul.className = "policy-urls small";

    for (const item of row.urls) {
      const li = document.createElement("li");

      const st = document.createElement("span");
      st.className = "policy-url-status policy-url-" + item.status;
      st.textContent = URL_STATUS[item.status] || item.status;
      if (item.status === "deferred" && item.method) st.textContent = "🕰 " + item.method;
      if (item.manual) st.textContent += " (manual)";
      li.appendChild(st);

      li.appendChild(document.createTextNode(" "));
      const a = document.createElement("a");
      a.href = item.u; a.target = "_blank"; a.rel = "noopener noreferrer";
      a.textContent = item.u.replace(/^https?:\/\/(www\.)?/, "");
      li.appendChild(a);

      const role = document.createElement("span");
      role.className = "policy-url-role";
      role.textContent = item.role;
      li.appendChild(role);

      if (item.status === "archived" && item.snap) {
        const s = document.createElement("a");
        s.href = item.snap; s.target = "_blank"; s.rel = "noopener noreferrer";
        s.className = "policy-url-snap";
        s.textContent = "view snapshot ↗";
        li.appendChild(s);
      } else {
        // "+ add archived link" → reveals an input
        const add = document.createElement("button");
        add.type = "button";
        add.className = "link-btn small";
        add.textContent = "+ archived link";
        const inp = document.createElement("input");
        inp.type = "url";
        inp.placeholder = "https://archive.today/… or Wayback URL";
        inp.className = "policy-url-input";
        inp.hidden = true;
        const note = document.createElement("span");
        note.className = "small";
        add.addEventListener("click", () => {
          inp.hidden = !inp.hidden;
          if (!inp.hidden) inp.focus();
        });
        inp.addEventListener("keydown", async (ev) => {
          if (ev.key !== "Enter") return;
          const val = inp.value.trim();
          if (!/^https?:\/\/\S+$/.test(val)) { note.textContent = "needs a full URL"; note.className = "small error"; return; }
          inp.disabled = true; note.textContent = "Saving…"; note.className = "small muted";
          try {
            await apiPost({ action: "set_archived_url", url: item.u, archive_url: val });
            item.status = "archived"; item.snap = val; item.manual = true;
            st.textContent = "🕰 archived (manual)";
            st.className = "policy-url-status policy-url-archived";
            inp.remove(); add.remove(); note.remove();
            const s = document.createElement("a");
            s.href = val; s.target = "_blank"; s.rel = "noopener noreferrer";
            s.className = "policy-url-snap"; s.textContent = "view snapshot ↗";
            li.appendChild(s);
          } catch (e) {
            inp.disabled = false; note.textContent = e.message; note.className = "small error";
          }
        });
        li.appendChild(add);
        li.appendChild(inp);
        li.appendChild(note);
      }
      ul.appendChild(li);
    }
    td.appendChild(ul);
    tr.appendChild(td);
    return tr;
  }

  function makeRow(row) {
    const rule = policy[row.domain] || null;
    const tr = document.createElement("tr");
    tr.className = "policy-row" + (rule && rule.priority === "skip" ? " policy-row--skip" : "");

    const dom = document.createElement("td");
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "link-btn policy-domain";
    toggle.textContent = "▸ " + row.domain;
    let detail = null;
    toggle.addEventListener("click", () => {
      if (detail) { detail.remove(); detail = null; toggle.textContent = "▸ " + row.domain; return; }
      detail = makeDetailRow(row);
      tr.after(detail);
      toggle.textContent = "▾ " + row.domain;
    });
    dom.appendChild(toggle);
    tr.appendChild(dom);

    const count = document.createElement("td");
    count.textContent = row.count;
    if (isMedia) {
      count.title = `${row.video} video · ${row.image} image`;
    } else {
      count.title = `${row.primary} primary · ${row.secondary} secondary`;
    }
    tr.appendChild(count);

    const arch = document.createElement("td");
    arch.className = "small";
    arch.textContent =
      `${row.archived}✓` +
      (row.pending ? ` ${row.pending}⏳` : "") +
      (row.deferred ? ` ${row.deferred}→` : "");
    tr.appendChild(arch);

    const priSel = buildSelect(enums.priority, rule ? rule.priority : "", (v) => cap(v), "— set —");
    const metSel = buildSelect(enums.method, rule ? rule.method : defaultMethod(row.domain), (v) => METHOD_LABELS[v] || v);

    const priTd = document.createElement("td");
    priTd.appendChild(priSel);
    tr.appendChild(priTd);
    const metTd = document.createElement("td");
    metTd.appendChild(metSel);
    tr.appendChild(metTd);

    const statusTd = document.createElement("td");
    statusTd.className = "small";
    tr.appendChild(statusTd);

    async function save() {
      const priority = priSel.value;
      const method = metSel.value;
      if (!priority) return;
      priSel.disabled = metSel.disabled = true;
      statusTd.textContent = "Saving…";
      statusTd.className = "small muted";
      try {
        const res = await apiPost({ action: "set_archive_policy", kind, domain: row.domain, priority, method });
        policy[row.domain] = { priority, method };
        tr.classList.toggle("policy-row--skip", priority === "skip");
        statusTd.textContent = "Saved " + (res.updated || "");
        statusTd.className = "small policy-saved";
      } catch (e) {
        statusTd.textContent = e.message;
        statusTd.className = "small error";
      } finally {
        priSel.disabled = metSel.disabled = false;
      }
    }
    priSel.addEventListener("change", save);
    metSel.addEventListener("change", save);
    return tr;
  }

  function draw(q) {
    body.innerHTML = "";
    const list = q ? rows.filter((r) => r.domain.includes(q)) : rows;
    if (list.length === 0) {
      body.innerHTML = '<tr><td colspan="6" class="muted">No domains.</td></tr>';
      return;
    }
    for (const row of list) body.appendChild(makeRow(row));
  }

  draw("");
  el("policy-filter").addEventListener("input", (evt) => {
    draw(evt.target.value.trim().toLowerCase());
  });
}

function buildSelect(values, selected, labelFn, placeholder) {
  const sel = document.createElement("select");
  if (placeholder) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = placeholder;
    opt.disabled = true;
    opt.selected = !selected;
    sel.appendChild(opt);
  }
  for (const v of values) {
    const opt = document.createElement("option");
    opt.value = v;
    opt.textContent = labelFn ? labelFn(v) : v;
    if (v === selected) opt.selected = true;
    sel.appendChild(opt);
  }
  return sel;
}

function cap(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
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
    document.getElementById("brand-home").addEventListener("click", showHome);
    if (state.isAdmin) {
      const adminLink = document.getElementById("admin-link");
      adminLink.hidden = false;
      adminLink.addEventListener("click", showAdminLog);
    }
    showHome();
  } catch (e) {
    appEl.innerHTML = `<p class="error">${escapeHtml(e.message)}</p>`;
  }
})();
