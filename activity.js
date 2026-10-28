// ---------------------------------------------------------------------------
// Activity log — the app's own history (TEMAzon's "Transactions" idea).
// Every assign / return / transfer / add / location or status change writes one
// row to the Activity table in the log service, from this app, right after the
// inventory edit succeeds. No webhook is involved.
//
// The log lives in its own small hosted service (Activity + Lists tables). The
// app finds it by title, or by CONFIG.ACTIVITY_SERVICE_URL. If it doesn't exist
// yet everything else still works; history is simply not recorded, and a
// Inventory Administrator can create it from Settings.
//
// The inventory edit and the log write are two separate services, so they can't
// be one transaction: if the log write fails after the edit succeeded, the user
// is told clearly and the edit stands.
// ---------------------------------------------------------------------------

import { CONFIG } from "./config.js";
import * as auth from "./shared/arcgis-auth.js";
import { esriRequest, queryAll, applyEdits, tableUrl, findServicesByTitle, checkFieldNames, itemServiceUrl } from "./shared/esri-client.js";
import { ACTIVITY_TABLE, LISTS_TABLE, ACTIVITY_TYPES, toTableDefinition, fieldNames } from "./schema.js";
import { $, esc, newTxnId, fmtDateTime, toCSV, downloadText, matchesSearch, debounce } from "./shared/util.js";
import { toast, openModal } from "./shared/ui.js";
import { S, I, U, personName, fullName, itemTitle, itemMakeModel, userById } from "./state.js";
import { canManageSettings } from "./permissions.js";

const newId = () => newTxnId().replace(/^TXN/, "ACT");

/** Locates the log service and its two tables. Never throws; sets S.activity.error instead. */
export async function discoverLog() {
  const A = S.activity;
  A.url = A.listsUrl = A.serviceUrl = A.error = "";
  try {
    let svc = (CONFIG.ACTIVITY_SERVICE_URL || "").replace(/\/+$/, "");
    if (!svc) {
      // By item ID first (works whatever the item is titled); view-only people use the view copy.
      const id = S.viewOnly ? CONFIG.VIEW_ITEM_IDS?.log : CONFIG.ITEM_IDS?.log?.id;
      if (id) { try { svc = await itemServiceUrl(id); } catch (err) { console.info("[activity] log item lookup failed, trying by title:", err.message); } }
    }
    if (!svc) {
      const hits = await findServicesByTitle(CONFIG.ACTIVITY_SERVICE_TITLE);
      if (hits.length) svc = String(hits[0].url || "").replace(/\/+$/, "");
    }
    if (!svc) return A;
    const info = await esriRequest(svc, {}, { method: "GET" });
    const find = (name) => (info.tables || []).find((t) => String(t.name).toLowerCase() === name.toLowerCase());
    const act = find(ACTIVITY_TABLE.name);
    const lists = find(LISTS_TABLE.name);
    A.serviceUrl = svc;
    if (act) A.url = tableUrl(svc, act.id);
    if (lists) A.listsUrl = tableUrl(svc, lists.id);
    if (!act) A.error = `Found the log service but it has no “${ACTIVITY_TABLE.name}” table.`;
  } catch (err) {
    A.error = err.message;
    console.warn("[activity] could not locate the log service:", err);
  }
  return A;
}

export async function loadActivity() {
  const A = S.activity;
  A.rows = [];
  A.ready = false;
  if (!A.url) return;
  try {
    A.rows = await queryAll(A.url, { pageSize: CONFIG.FETCH_PAGE_SIZE });
    A.ready = true;
    checkFieldNames(A.url, "Activity", fieldNames(ACTIVITY_TABLE));
  } catch (err) {
    A.error = `Could not read the Activity table: ${err.message}`;
    console.warn(A.error);
  }
}

/** Dropdown lists (Sections / Categories / Statuses) from the Lists table, if it exists. */
/** Region offices live in three kinds of Lists rows: region (name), reg_addr ("Name|address|city|state|zip"), reg_geo ("Name|county|lat|lng"). */
export function parseRegions(rows) {
  const by = (n) => rows.filter((r) => r.list_name === n);
  const addr = new Map(by("reg_addr").map((r) => { const [name, address, city, state, zip] = String(r.value || "").split("|"); return [name, { address, city, state, zip }]; }));
  const geo = new Map(by("reg_geo").map((r) => { const [name, county, lat, lng] = String(r.value || "").split("|"); return [name, { county, lat: lat === "" ? null : Number(lat), lng: lng === "" ? null : Number(lng) }]; }));
  return by("region").filter((r) => String(r.value || "").trim())
    .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0))
    .map((r) => { const name = String(r.value).trim(); return { name, address: "", city: "", state: "", zip: "", county: "", lat: null, lng: null, ...(addr.get(name) || {}), ...(geo.get(name) || {}) }; });
}

export async function loadLists() {
  S.lists = { section: [], category: [], status: [], stored: {}, rows: [], regions: [] };
  if (!S.activity.listsUrl) return;
  try {
    const rows = await queryAll(S.activity.listsUrl, { pageSize: CONFIG.FETCH_PAGE_SIZE });
    S.lists.rows = rows;
    for (const name of ["section", "category", "status"]) {
      const vals = rows
        .filter((r) => r.list_name === name && String(r.value || "").trim())
        .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0) || String(a.value).localeCompare(String(b.value)))
        .map((r) => String(r.value).trim());
      S.lists[name] = vals;
      S.lists.stored[name] = vals.length > 0;
    }
    S.lists.regions = parseRegions(rows);
  } catch (err) {
    console.warn("[lists] could not read the Lists table — using config.js defaults:", err);
  }
}

/**
 * Builds one Activity attribute set.
 * @param {{type:string, row?:object, fromId?:string, toId?:string, note?:string, tag?:string, desc?:string}} e
 */
export function activityAttrs(e) {
  const row = e.row || {};
  const to = e.toId ? userById(e.toId) : null;
  const from = e.fromId ? userById(e.fromId) : null;
  return {
    activity_id: newId(),
    activity_type: e.type,
    activity_date: Date.now(),
    tag_number: String(e.tag ?? row[I.tag] ?? "").slice(0, 255),
    item_desc: String(e.desc ?? ([itemTitle(row), itemMakeModel(row)].filter(Boolean).join(" · "))).slice(0, 255),
    category: String(row[I.category] || "").slice(0, 60),
    from_edison_id: e.fromId ? String(e.fromId) : "",
    from_name: e.fromName || (e.fromId ? personName(e.fromId) : ""),
    to_edison_id: e.toId ? String(e.toId) : "",
    to_name: e.toName || (e.toId ? personName(e.toId) : ""),
    to_section: to ? String(to[U.section] || "").slice(0, 80) : from ? String(from[U.section] || "").slice(0, 80) : "",
    region: String(e.region ?? row[I.region] ?? "").slice(0, 40),
    performed_by: fullName(S.me) || S.profile?.fullName || "",
    performed_by_email: String((S.me && S.me[U.email]) || S.profile?.email || "").toLowerCase(),
    note: String(e.note || "").slice(0, 500),
  };
}

/**
 * Writes activity rows. Never throws. Returns {ok, skipped, error}.
 * Callers show a warning when ok is false and skipped is false.
 */
export async function logActivity(entries) {
  const list = (Array.isArray(entries) ? entries : [entries]).filter(Boolean);
  if (!list.length) return { ok: true };
  if (S.viewOnly) return { ok: false, skipped: true, error: "View-only access." };
  if (!S.activity.url) return { ok: false, skipped: true, error: "The log service isn't set up yet." };
  try {
    const attrs = list.map(activityAttrs);
    const res = await applyEdits(S.activity.url, { adds: attrs.map((a) => ({ attributes: a })) });
    attrs.forEach((a, i) => S.activity.rows.push({ ...a, _oid: res.addResults?.[i]?.objectId }));
    return { ok: true };
  } catch (err) {
    console.warn("[activity] log write failed:", err);
    return { ok: false, error: err.message };
  }
}

/** Standard follow-up after an edit: log it and warn (don't fail) if logging didn't work. */
export async function logAndWarn(entries) {
  const r = await logActivity(entries);
  if (!r.ok && !r.skipped) {
    toast(`Saved, but the history entry could not be recorded (${r.error}). Tell an Inventory Administrator.`, "error", 9000);
  }
  return r;
}

export const historyFor = (tag) =>
  S.activity.rows
    .filter((a) => String(a.tag_number || "") === String(tag || ""))
    .sort((a, b) => (b.activity_date || 0) - (a.activity_date || 0));

export const activityFor = (edisonId) =>
  S.activity.rows
    .filter((a) => String(a.to_edison_id) === String(edisonId) || String(a.from_edison_id) === String(edisonId))
    .sort((a, b) => (b.activity_date || 0) - (a.activity_date || 0));

// ---------------------------------------------------------------------------
// Creating the log service (Settings → button). Same createService →
// addToDefinition sequence as TEMAzon's Setup page.
// ---------------------------------------------------------------------------

const adminUrl = (u) => u.replace("/rest/services/", "/rest/admin/services/");

/** Adds tables to an existing hosted service (publisher / owner account needed). */
export async function addTablesToService(serviceUrl, specs) {
  await esriRequest(`${adminUrl(serviceUrl.replace(/\/+$/, ""))}/addToDefinition`, {
    addToDefinition: JSON.stringify({ tables: specs.map(toTableDefinition) }),
  });
}

/** Adds one optional text field to an existing hosted layer (owner / admin account needed). */
export async function addTextFieldToLayer(layerUrl, name, alias, length = 10) {
  await esriRequest(`${adminUrl(layerUrl.replace(/\/+$/, ""))}/addToDefinition`, {
    addToDefinition: JSON.stringify({ fields: [{ name, type: "esriFieldTypeString", alias, length, nullable: true, editable: true, domain: null, defaultValue: null, sqlType: "sqlTypeOther" }] }),
  });
}

/** Replaces the coded-value domain of one field on a hosted layer (owner / admin account needed). */
export async function updateFieldDomain(layerUrl, fieldName, domain) {
  await esriRequest(`${adminUrl(layerUrl.replace(/\/+$/, ""))}/updateDefinition`, {
    updateDefinition: JSON.stringify({ fields: [{ name: fieldName, domain }] }),
  });
}

/** Creates a small hosted service with the given tables. Returns {url, itemId}. */
export async function createHostedService({ title, description, specs, tracking }) {
  const profile = await auth.fetchProfile();
  const username = (profile && profile.username) || auth.getUsername();
  const createParameters = {
    name: title,
    serviceDescription: description,
    hasStaticData: false,
    maxRecordCount: 2000,
    supportedQueryFormats: "JSON",
    capabilities: "Create,Delete,Query,Update,Editing",
    allowGeometryUpdates: true,
    units: "esriMeters",
    xssPreventionInfo: { xssPreventionEnabled: true, xssPreventionRule: "input", xssInputRule: "rejectInvalid" },
  };
  const created = await esriRequest(`${CONFIG.ARCGIS_PORTAL_URL}/sharing/rest/content/users/${encodeURIComponent(username)}/createService`, {
    createParameters: JSON.stringify(createParameters),
    outputType: "featureService",
    description,
    snippet: description,
    tags: "TEMA,assigned inventory",
  });
  const svc = String(created.serviceurl || created.encodedServiceURL || "").replace(/\/+$/, "");
  if (!svc) throw new Error("ArcGIS did not return a service URL.");
  await addTablesToService(svc, specs);
  try {
    await esriRequest(`${adminUrl(svc)}/updateDefinition`, { updateDefinition: JSON.stringify({ editorTrackingInfo: tracking }) });
  } catch (err) {
    console.warn("Editor tracking not enabled (optional):", err);
  }
  return { url: svc, itemId: created.itemId || created.serviceItemId };
}

export async function createLogService() {
  const res = await createHostedService({
    title: CONFIG.ACTIVITY_SERVICE_TITLE,
    description: "Assigned Inventory Console: activity history and dropdown lists",
    specs: [ACTIVITY_TABLE, LISTS_TABLE],
    tracking: { enableEditorTracking: true, enableOwnershipAccessControl: false, allowOthersToUpdate: true, allowOthersToDelete: true, allowOthersToQuery: true },
  });
  CONFIG.ACTIVITY_SERVICE_URL = res.url; // use it immediately; later sessions find it by item ID / title
  return res;
}

// ---------------------------------------------------------------------------
// Activity tab
// ---------------------------------------------------------------------------

const AF = { q: "", type: "", from: "", to: "" };

export function initActivity() {
  const el = $("#screen-act");
  el.addEventListener("input", debounce((e) => {
    if (e.target.id === "act-q") { AF.q = e.target.value; renderActivityRows(); }
  }, 150));
  el.addEventListener("change", (e) => {
    if (e.target.id === "act-type") AF.type = e.target.value;
    else if (e.target.id === "act-from") AF.from = e.target.value;
    else if (e.target.id === "act-to") AF.to = e.target.value;
    else return;
    renderActivityRows();
  });
  el.addEventListener("click", (e) => {
    if (e.target.id === "act-export") exportActivity();
    const t = e.target.closest("[data-tag]");
    if (t) S.actions.openItemByTag?.(t.dataset.tag);
  });
  S.render.act = renderActivity;
}

export function renderActivity() {
  const el = $("#screen-act");
  const A = S.activity;
  if (!A.url) {
    el.innerHTML = `<div class="banner banner-warn" style="flex-direction:column;align-items:flex-start">
      <b>History isn't set up yet.</b>
      <span>${esc(A.error || "Assignments still work, but nothing is being recorded.")} ${canManageSettings(S.me)
        ? `An Inventory Administrator can create the log in <b>Settings → Log service</b> (takes a few seconds).`
        : `Ask an Inventory Administrator to set it up in Settings.`}</span></div>`;
    return;
  }
  el.innerHTML = `
    <div class="toolbar">
      <input id="act-q" type="search" placeholder="Search tag, person, note…" value="${esc(AF.q)}" aria-label="Search activity" autocomplete="off" />
      <select id="act-type" aria-label="Type"><option value="">All types</option>${ACTIVITY_TYPES.map((t) => `<option ${t === AF.type ? "selected" : ""}>${esc(t)}</option>`).join("")}</select>
      <label class="inline">From <input id="act-from" type="date" value="${esc(AF.from)}" /></label>
      <label class="inline">To <input id="act-to" type="date" value="${esc(AF.to)}" /></label>
      <span class="spacer"></span><span id="act-count" class="sub"></span>
      <button type="button" id="act-export">Export CSV</button>
    </div>
    <div class="table-wrap tall"><table class="grid"><thead><tr><th>When</th><th>Type</th><th>Tag</th><th>Item</th><th>Person</th><th>By</th><th>Note</th></tr></thead><tbody id="act-body"></tbody></table></div>`;
  renderActivityRows();
}

const typeClass = (t) => ({ Assigned: "st-ok", Transferred: "st-pending", Returned: "st-muted", Added: "st-ok", "Problem reported": "st-bad", "Reported not held": "st-bad", "Report resolved": "st-ok" }[t] || "st-muted");
const personCell = (a) =>
  a.activity_type === "Transferred" ? `${esc(a.from_name)} → ${esc(a.to_name)}`
  : a.activity_type === "Returned" ? esc(a.from_name)
  : esc(a.to_name);

function filteredActivity() {
  const from = AF.from ? Date.parse(AF.from + "T00:00:00") : null;
  const to = AF.to ? Date.parse(AF.to + "T23:59:59") : null;
  return S.activity.rows
    .filter((a) => (!AF.type || a.activity_type === AF.type)
      && (!from || a.activity_date >= from) && (!to || a.activity_date <= to)
      && matchesSearch([a.tag_number, a.item_desc, a.to_name, a.from_name, a.performed_by, a.note, a.activity_type], AF.q))
    .sort((a, b) => (b.activity_date || 0) - (a.activity_date || 0));
}

function renderActivityRows() {
  const body = $("#act-body");
  if (!body) return;
  const rows = filteredActivity();
  $("#act-count").textContent = `${rows.length} of ${S.activity.rows.length}`;
  body.innerHTML = rows.slice(0, 500).map((a) => `<tr>
    <td>${esc(fmtDateTime(a.activity_date))}</td>
    <td><span class="status-pill ${typeClass(a.activity_type)}">${esc(a.activity_type)}</span></td>
    <td><a href="#" class="mono" data-tag="${esc(a.tag_number)}">${esc(a.tag_number)}</a></td>
    <td>${esc(a.item_desc)}</td><td>${personCell(a)}</td><td>${esc(a.performed_by)}</td><td class="sub">${esc(a.note)}</td></tr>`).join("")
    || `<tr><td colspan="7" class="empty">No activity matches.</td></tr>`;
  if (rows.length > 500) body.insertAdjacentHTML("beforeend", `<tr><td colspan="7" class="empty">Showing the newest 500 — narrow the filters or export the CSV for everything.</td></tr>`);
}

function exportActivity() {
  const rows = filteredActivity();
  downloadText("assigned-inventory-activity.csv", toCSV(rows, [
    { label: "Date", get: (a) => new Date(a.activity_date).toISOString() },
    { label: "Type", key: "activity_type" }, { label: "Tag", key: "tag_number" }, { label: "Item", key: "item_desc" },
    { label: "From", key: "from_name" }, { label: "To", key: "to_name" }, { label: "Section", key: "to_section" },
    { label: "Region", key: "region" }, { label: "By", key: "performed_by" }, { label: "Note", key: "note" },
  ]));
}
