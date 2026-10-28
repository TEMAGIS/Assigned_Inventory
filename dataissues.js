// ---------------------------------------------------------------------------
// Data problems tab (Inventory Administrator): checks every inventory record
// against simple rules and lists what needs correcting. Nothing is changed
// here; click a row to open the item and fix it. The list recomputes after
// every edit, so fixed records drop out.
// ---------------------------------------------------------------------------

import { CONFIG } from "./config.js";
import { esc, $, toCSV, downloadText, matchesSearch } from "./shared/util.js";
import { S, I, U, itemTitle, isBlankRow, isRetired, ownerName, ownerOptions, personName } from "./state.js";
import { isPropertyOfficer } from "./permissions.js";

const txt = (v) => String(v ?? "");
const blank = (v) => !txt(v).trim();
const HIGH = "High", MED = "Medium", LOW = "Low";

const RULES = [
  { id: "dup-tag", pri: HIGH, title: "Duplicate tag number", fix: "Keep one record; renumber or delete the others.", test: (r, c) => !blank(r[I.tag]) && c.tags.get(txt(r[I.tag]).trim().toLowerCase()) > 1 },
  { id: "no-tag", pri: HIGH, title: "No tag number", fix: "Add the tag, or delete the record if it is a leftover.", test: (r) => blank(r[I.tag]) },
  { id: "tag-space", pri: HIGH, title: "Tag has leading or trailing spaces", fix: "Trim the spaces so the tag matches scans.", test: (r) => !blank(r[I.tag]) && txt(r[I.tag]) !== txt(r[I.tag]).trim() },
  { id: "inactive-assigned", pri: HIGH, title: "Inactive but still assigned", fix: "Return it to stock, or set the status back to Active.", test: (r) => !blank(r[I.assignedTo]) && /inactive/i.test(txt(r[I.status])) },
  { id: "orphan-assignee", pri: HIGH, title: "Assigned to someone not in the Users list", fix: "Fix the Edison ID, add the person, or return the item to stock.", test: (r, c) => !blank(r[I.assignedTo]) && !c.users.has(txt(r[I.assignedTo]).trim()) },
  { id: "inactive-person", pri: HIGH, title: "Assigned to an inactive person", fix: "Transfer it or return it to stock.", test: (r, c) => { const u = c.users.get(txt(r[I.assignedTo]).trim()); return !!u && !["yes", "y", "true"].includes(txt(u[U.active]).trim().toLowerCase()); } },
  { id: "no-status", pri: HIGH, title: "Status blank", fix: "Set Active or Inactive.", test: (r) => blank(r[I.status]) },
  { id: "no-reason", pri: HIGH, title: "Inactive with no status reason", fix: "Pick a reason (Surplus, Transfer, Lost or Damaged, Return to Vendor, Disposed, Recalled).", test: (r) => /inactive/i.test(txt(r[I.status])) && blank(r[I.statusReason]) },
  { id: "no-owner", pri: HIGH, title: "Property owner not set", fix: "Choose the owning section; until then only Inventory Administrators can assign it.", test: (r) => blank(r[I.propertyOwner]) },
  { id: "owner-space", pri: HIGH, title: "Property owner has trailing spaces", fix: "Re-pick the owner so the value is clean.", test: (r) => !blank(r[I.propertyOwner]) && (txt(r[I.propertyOwner]) !== txt(r[I.propertyOwner]).trim() || txt(r[I.propertyOwner]).includes(" ")) },
  { id: "owner-unknown", pri: MED, title: "Property owner not in the owner list", fix: "Pick a listed owner, or add it in Settings → Property owners.", test: (r, c) => !blank(r[I.propertyOwner]) && c.ownerCodes.size > 0 && !c.ownerCodes.has(txt(r[I.propertyOwner]).trim().toLowerCase()) },
  { id: "no-category", pri: HIGH, title: "Category blank", fix: `Set the category to ${CONFIG.DEFAULT_CATEGORY}.`, test: (r) => blank(r[I.category]) },
  { id: "no-item", pri: HIGH, title: "Item blank", fix: "Enter what the item is.", test: (r) => blank(r[I.item]) },
  { id: "reason-active", pri: MED, title: "Active but has a status reason", fix: "Clear the reason, or set the status to Inactive.", test: (r) => /^active$/i.test(txt(r[I.status]).trim()) && !blank(r[I.statusReason]) },
  { id: "no-make", pri: MED, title: "Make blank", fix: "Enter the make.", test: (r) => blank(r[I.make]) },
  { id: "no-model", pri: MED, title: "Model blank", fix: "Enter the model.", test: (r) => blank(r[I.model]) },
  { id: "no-recv", pri: MED, title: "Original reception date blank", fix: "Enter the date received.", test: (r) => !r[I.receiving] },
  { id: "qty", pri: MED, title: "Quantity blank or 0", fix: "Set a quantity (normally 1).", test: (r) => r[I.quantity] === null || r[I.quantity] === undefined || r[I.quantity] === "" || Number(r[I.quantity]) === 0 },
  { id: "dup-serial", pri: MED, title: "Duplicate serial number", fix: "Check whether the item was entered twice or the serial was mistyped.", test: (r, c) => !blank(r[I.serial]) && c.serials.get(txt(r[I.serial]).trim().toLowerCase()) > 1 },
  { id: "no-date", pri: MED, title: "Assigned but no date assigned", fix: "Set the date assigned (confirmations depend on it).", test: (r) => !blank(r[I.assignedTo]) && !r[I.dateAssigned] },
  { id: "date-only", pri: MED, title: "Date assigned but nobody assigned", fix: "Clear the date, or restore the assignee.", test: (r) => blank(r[I.assignedTo]) && !!r[I.dateAssigned] && !/inactive/i.test(txt(r[I.status])) },
  { id: "no-location", pri: MED, title: "No location (region and building both blank)", fix: "Enter a region and/or location.", test: (r) => blank(r[I.region]) && blank(r[I.place]) },
  { id: "no-coords", pri: LOW, title: "No map coordinates", fix: "Pick a region (fills the pin) or place a pin.", test: (r) => r[I.lat] === null || r[I.lat] === undefined || r[I.lat] === "" },
];
const PRI_ORDER = { [HIGH]: 0, [MED]: 1, [LOW]: 2 };
const PRI_CLASS = { [HIGH]: "st-bad", [MED]: "st-pending", [LOW]: "st-muted" };

/** { blanks: rows, byRule: Map(ruleId -> rows) } over the current inventory. */
export function computeIssues() {
  const real = S.inv.filter((r) => !isBlankRow(r));
  const tags = new Map(), serials = new Map();
  for (const r of real) {
    const t = txt(r[I.tag]).trim().toLowerCase(); if (t) tags.set(t, (tags.get(t) || 0) + 1);
    const s = txt(r[I.serial]).trim().toLowerCase(); if (s && !["n/a", "na", "none", "unknown"].includes(s)) serials.set(s, (serials.get(s) || 0) + 1);
  }
  const c = {
    tags, serials,
    users: new Map(S.users.filter((u) => u[U.edison]).map((u) => [txt(u[U.edison]).trim(), u])),
    ownerCodes: new Set(ownerOptions().map((o) => txt(o.code).trim().toLowerCase())),
  };
  const byRule = new Map(RULES.map((x) => [x.id, []]));
  for (const r of real) for (const x of RULES) if (x.test(r, c)) byRule.get(x.id).push(r);
  return { blanks: S.inv.filter(isBlankRow), byRule };
}

export const highIssueCount = () => {
  const { byRule } = computeIssues();
  return RULES.filter((x) => x.pri === HIGH).reduce((n, x) => n + byRule.get(x.id).length, 0);
};

const F = { rule: "", q: "", shown: 200 };
let cache = null;

export function initDataIssues() {
  const el = $("#screen-dat");
  el.addEventListener("click", (e) => {
    const rule = e.target.closest("[data-rule]");
    if (rule) { F.rule = F.rule === rule.dataset.rule ? "" : rule.dataset.rule; F.shown = 200; return renderDataIssues(); }
    const row = e.target.closest("[data-oid]");
    if (row) return S.actions.openDrawer(Number(row.dataset.oid));
    if (e.target.id === "dat-more") { F.shown += 200; return paintRows(); }
    if (e.target.id === "dat-export") return exportCsv();
  });
  el.addEventListener("input", (e) => { if (e.target.id === "dat-q") { F.q = e.target.value; F.shown = 200; paintRows(); } });
  S.render.dat = renderDataIssues;
}

export function renderDataIssues() {
  const el = $("#screen-dat");
  if (!isPropertyOfficer(S.me)) { el.innerHTML = `<p class="empty">Only an Inventory Administrator can see data problems.</p>`; return; }
  cache = computeIssues();
  const total = RULES.reduce((n, x) => n + cache.byRule.get(x.id).length, 0);
  const rules = RULES.filter((x) => cache.byRule.get(x.id).length).sort((a, b) => PRI_ORDER[a.pri] - PRI_ORDER[b.pri] || cache.byRule.get(b.id).length - cache.byRule.get(a.id).length);
  el.innerHTML = `<p class="sub" style="max-width:52rem">Checks every record against the rules below. Click a problem to list its records, then click a record to open and fix it. Fixed records drop out of the list straight away. Records are never changed from this tab.</p>
    ${rules.length || cache.blanks.length ? "" : `<p class="banner banner-ok">No data problems found.</p>`}
    <div class="table-wrap"><table class="grid"><thead><tr><th>Priority</th><th>Problem</th><th>Records</th><th>What to do</th></tr></thead><tbody>
      ${rules.map((x) => `<tr data-rule="${x.id}" tabindex="0" class="${F.rule === x.id ? "row-sel" : ""}" style="cursor:pointer"><td><span class="status-pill ${PRI_CLASS[x.pri]}">${x.pri}</span></td><td>${esc(x.title)}</td><td><b>${cache.byRule.get(x.id).length}</b></td><td class="sub">${esc(x.fix)}</td></tr>`).join("")}
      ${cache.blanks.length ? `<tr><td><span class="status-pill st-muted">Info</span></td><td>Empty placeholder records (hidden in this app)</td><td><b>${cache.blanks.length}</b></td><td class="sub">Delete them in ArcGIS Online (Inventory layer → Data); the app can't delete records.</td></tr>` : ""}
    </tbody></table></div>
    <div class="toolbar" style="margin-top:1rem"><input id="dat-q" type="search" placeholder="Filter the list below by tag, item, person…" value="${esc(F.q)}" aria-label="Filter data problems" autocomplete="off" /><span class="spacer"></span><span id="dat-count" class="sub"></span>
      <button type="button" id="dat-export">Export all problems (CSV)</button></div>
    <div class="table-wrap tall"><table class="grid"><thead><tr><th>Tag</th><th>Item</th><th>Status</th><th>Property owner</th><th>Assigned to</th><th>Problems</th></tr></thead><tbody id="dat-body"></tbody></table></div>
    <div id="dat-foot" class="list-foot"></div>`;
  paintRows();
}

function problemsOf(map) { // oid -> [rule titles]
  const m = new Map();
  for (const x of RULES) for (const r of cache.byRule.get(x.id)) { if (!m.has(r._oid)) m.set(r._oid, []); m.get(r._oid).push(x); }
  return m;
}

function paintRows() {
  const body = $("#dat-body");
  if (!body || !cache) return;
  const per = problemsOf();
  let oids;
  if (F.rule) oids = cache.byRule.get(F.rule).map((r) => r._oid);
  else oids = [...per.keys()];
  let rows = oids.map((o) => S.invByOid.get(o)).filter(Boolean)
    .filter((r) => matchesSearch([r[I.tag], r[I.item], r[I.make], r[I.model], r[I.serial], personName(r[I.assignedTo]), ownerName(r[I.propertyOwner])], F.q));
  rows.sort((a, b) => Math.min(...per.get(a._oid).map((x) => PRI_ORDER[x.pri])) - Math.min(...per.get(b._oid).map((x) => PRI_ORDER[x.pri])) || txt(a[I.tag]).localeCompare(txt(b[I.tag]), undefined, { numeric: true }));
  const shown = rows.slice(0, F.shown);
  $("#dat-count").textContent = `${rows.length} record${rows.length === 1 ? "" : "s"}${F.rule ? " · " + RULES.find((x) => x.id === F.rule).title : ""}`;
  body.innerHTML = shown.map((r) => `<tr data-oid="${r._oid}" tabindex="0" style="cursor:pointer">
    <td class="mono">${esc(r[I.tag] || "—")}</td><td>${esc(itemTitle(r))} <span class="sub">${esc([r[I.make], r[I.model]].filter(Boolean).join(" "))}</span></td>
    <td>${esc(r[I.status] || "")}${r[I.statusReason] ? `<div class="sub">${esc(r[I.statusReason])}</div>` : ""}</td><td>${esc(ownerName(r[I.propertyOwner]))}</td><td>${esc(personName(r[I.assignedTo]) || (r[I.assignedTo] ? `(${r[I.assignedTo]})` : ""))}</td>
    <td class="sub">${per.get(r._oid).map((x) => esc(x.title)).join("; ")}</td></tr>`).join("") || `<tr><td colspan="6" class="empty">Nothing to show.</td></tr>`;
  $("#dat-foot").innerHTML = rows.length > shown.length ? `<button type="button" id="dat-more">Show ${Math.min(200, rows.length - shown.length)} more</button>` : "";
}

function exportCsv() {
  const out = [];
  for (const x of RULES) for (const r of cache.byRule.get(x.id)) out.push({ x, r });
  out.sort((a, b) => PRI_ORDER[a.x.pri] - PRI_ORDER[b.x.pri] || a.x.title.localeCompare(b.x.title));
  downloadText("inventory-data-problems.csv", toCSV(out, [
    { label: "Priority", get: (o) => o.x.pri }, { label: "Problem", get: (o) => o.x.title }, { label: "Tag", get: (o) => o.r[I.tag] },
    { label: "Item", get: (o) => o.r[I.item] }, { label: "Make", get: (o) => o.r[I.make] }, { label: "Model", get: (o) => o.r[I.model] }, { label: "Serial", get: (o) => o.r[I.serial] },
    { label: "Status", get: (o) => o.r[I.status] }, { label: "Status reason", get: (o) => o.r[I.statusReason] }, { label: "Property owner", get: (o) => ownerName(o.r[I.propertyOwner]) },
    { label: "Assigned to", get: (o) => personName(o.r[I.assignedTo]) || o.r[I.assignedTo] }, { label: "What to do", get: (o) => o.x.fix },
  ]));
}
