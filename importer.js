// ---------------------------------------------------------------------------
// CSV import for items and people (Inventory Administrator). Same promise as TEMAzon:
// nothing is written until you have seen a preview and click Apply.
//
//   Items  — matched by Tag. New tag = new item. Existing tag = update; if the
//            Assigned To column differs it is an assign / transfer / return and
//            is written to Activity like any other.
//   People — matched by Edison ID. New ID = new person.
// A column that is in the file is applied to every row (a blank cell clears the
// value); a column that is missing is left alone.
// ---------------------------------------------------------------------------

import { CONFIG } from "./config.js";
import { esc, parseCSV, toCSV, downloadText, $ } from "./shared/util.js";
import { openModal, toast } from "./shared/ui.js";
import { S, I, U, regionPreset, regionOptions, fullName, userById, isUserActive, todayYmd, ymdToMs, msToYmd, personName, itemTitle } from "./state.js";
import { addInventory, updateInventory, addUsers, updateUsers, userAttrs, presetFor } from "./edits.js";
import { logActivity } from "./activity.js";
import { validateUser } from "./people.js";
import { canBulkImport, roleLabel } from "./permissions.js";

const norm = (h) => String(h || "").toLowerCase().replace(/[^a-z0-9]/g, "");
const pick = (header, names) => header.findIndex((h) => names.includes(h));

function parseDate(s) {
  const v = String(s || "").trim();
  if (!v) return { ms: null };
  let m = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return { ms: ymdToMs(`${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`) };
  m = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) {
    const y = m[3].length === 2 ? "20" + m[3] : m[3];
    return { ms: ymdToMs(`${y}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`) };
  }
  return { error: `"${v}" isn't a date (use YYYY-MM-DD or M/D/YYYY)` };
}

// ---------------------------------------------------------------- generic dialog
function importDialog({ title, template, templateName, hint, build, summary, previewRows, apply, applyLabel }) {
  if (!canBulkImport(S.me) || S.readonly) return toast("Only an Inventory Administrator can import.", "error");
  let plan = null;
  const m = openModal({
    title,
    wide: true,
    body: `
      <div class="banner banner-info" style="margin-top:0"><span>${hint} <a href="#" id="im-tpl">Download a template</a></span></div>
      <label>Choose a CSV file<input type="file" id="im-file" accept=".csv,text/csv" /></label>
      <div id="im-preview"></div>`,
    buttons: [
      { label: "Cancel" },
      {
        label: applyLabel, kind: "primary", id: "im-apply",
        action: async (mm) => { if (!plan) throw new Error("Choose a file first."); await apply(plan); },
      },
    ],
  });
  const btn = m.el.querySelector("#im-apply");
  btn.disabled = true;
  m.el.querySelector("#im-tpl").addEventListener("click", (e) => { e.preventDefault(); downloadText(templateName, template); });
  m.el.querySelector("#im-file").addEventListener("change", async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const out = m.el.querySelector("#im-preview");
    try {
      plan = build(await f.text());
      const ok = plan.actionable;
      out.innerHTML = `${summary(plan)}
        ${plan.errors.length ? `<h3>Rows with problems (skipped)</h3><div class="table-wrap" style="max-height:180px"><table class="grid"><tbody>${plan.errors.slice(0, 100).map((x) => `<tr><td>Row ${x.rowNo}</td><td>${esc(x.id || "")}</td><td class="neg">${esc(x.msg)}</td></tr>`).join("")}</tbody></table></div>` : ""}
        ${plan.rows.length ? `<h3>Preview</h3><div class="table-wrap" style="max-height:300px">${previewRows(plan)}</div>` : ""}`;
      btn.disabled = !ok;
      btn.textContent = ok ? `${applyLabel} (${ok})` : applyLabel;
    } catch (err) {
      plan = null; btn.disabled = true;
      out.innerHTML = `<div class="form-error">${esc(err.message)}</div>`;
    }
  });
}

// ---------------------------------------------------------------- items
const ITEM_COLS = [
  { f: "tag", names: ["tag", "tagnumber", "tagno"] },
  { f: "item", names: ["item", "itemname"] },
  { f: "category", names: ["category", "itemcategory"] },
  { f: "make", names: ["make", "manufacturer"] },
  { f: "model", names: ["model"] },
  { f: "serial", names: ["serial", "serialnumber"] },
  { f: "status", names: ["status"] },
  { f: "description", names: ["description", "notes"] },
  { f: "region", names: ["region"] },
  { f: "place", names: ["building", "placename", "place", "location"] },
  { f: "room", names: ["room"] },
];
const ITEM_ATTR = { tag: I.tag, item: I.item, category: I.category, make: I.make, model: I.model, serial: I.serial, status: I.status, description: I.description, region: I.region, place: I.place, room: I.room };

function resolveAssignee(text) {
  const v = String(text || "").trim();
  if (!v) return { id: "" };
  const l = v.toLowerCase();
  const u = S.users.find((x) => String(x[U.edison]).toLowerCase() === l)
    || S.users.find((x) => String(x[U.email] || "").toLowerCase() === l)
    || (() => { const hits = S.users.filter((x) => fullName(x).toLowerCase() === l); return hits.length === 1 ? hits[0] : null; })();
  if (!u) return { error: `No user found for "${v}" (use Edison ID or email)` };
  if (!isUserActive(u)) return { error: `${fullName(u)} is inactive` };
  return { id: String(u[U.edison]) };
}

function buildItemsPlan(text) {
  const grid = parseCSV(text);
  if (grid.length < 2) throw new Error("That file has no data rows.");
  const header = grid[0].map(norm);
  const col = {};
  ITEM_COLS.forEach((c) => { const i = pick(header, c.names); if (i >= 0) col[c.f] = i; });
  const assignCol = pick(header, ["assignedto", "assignedtoedisonid", "assignee", "edisonid", "assignedtoemail", "person"]);
  const dateCol = pick(header, ["dateassigned", "assigneddate"]);
  if (col.tag === undefined) throw new Error('The file needs a "Tag" column.');

  const plan = { rows: [], errors: [], adds: 0, updates: 0, assigns: 0, returns: 0, unchanged: 0, actionable: 0 };
  const byTag = new Map(S.inv.filter((r) => r[I.tag]).map((r) => [String(r[I.tag]).trim().toLowerCase(), r]));
  const seen = new Set();
  const today = ymdToMs(todayYmd());

  for (let r = 1; r < grid.length; r++) {
    const cells = grid[r];
    const rowNo = r + 1;
    const cell = (f) => String(cells[col[f]] ?? "").trim();
    const tag = cell("tag");
    const fail = (msg) => plan.errors.push({ rowNo, id: tag, msg });
    if (!tag) { fail("Tag is blank"); continue; }
    const key = tag.toLowerCase();
    if (seen.has(key)) { fail("Tag appears more than once in the file"); continue; }
    seen.add(key);
    const existing = byTag.get(key) || null;

    const attrs = {};
    if (!existing) attrs[I.tag] = tag;
    const notes = [];
    for (const c of ITEM_COLS) {
      if (c.f === "tag" || col[c.f] === undefined) continue;
      const v = cell(c.f);
      if (!existing || String(existing[ITEM_ATTR[c.f]] ?? "").trim() !== v) { if (existing || v) attrs[ITEM_ATTR[c.f]] = v; if (existing) notes.push(c.f); }
    }
    let geometry;
    if (attrs[I.region] && regionPreset(attrs[I.region]) && (!existing || !existing[I.address])) {
      const p = presetFor(attrs[I.region]);
      Object.assign(attrs, p.attrs); geometry = p.geometry;
    }
    if (col.region !== undefined && attrs[I.region] && !regionOptions().includes(attrs[I.region])) { fail(`Region "${attrs[I.region]}" isn't one of ${regionOptions().join(", ")}`); continue; }

    // assignment
    let toId, kind = "";
    if (assignCol >= 0) {
      const res = resolveAssignee(cells[assignCol]);
      if (res.error) { fail(res.error); continue; }
      toId = res.id;
      const cur = existing && existing[I.assignedTo] ? String(existing[I.assignedTo]) : "";
      if (toId !== cur) {
        kind = !toId ? "Returned" : cur ? "Transferred" : "Assigned";
        attrs[I.assignedTo] = toId || null;
        if (!toId) attrs[I.dateAssigned] = null;
        else if (dateCol >= 0) {
          const d = parseDate(cells[dateCol]);
          if (d.error) { fail(d.error); continue; }
          attrs[I.dateAssigned] = d.ms ?? today;
        } else attrs[I.dateAssigned] = today;
      } else if (dateCol >= 0 && toId) {
        const d = parseDate(cells[dateCol]);
        if (d.error) { fail(d.error); continue; }
        if (d.ms && d.ms !== existing[I.dateAssigned]) attrs[I.dateAssigned] = d.ms;
      }
    }
    if (!existing && !attrs[I.item] && !attrs[I.category]) { fail("New item needs an Item or a Category"); continue; }
    const hasChange = Object.keys(attrs).length > 0;
    if (existing && !hasChange) { plan.unchanged++; continue; }
    const rowPlan = { rowNo, tag, existing, attrs, geometry, kind, notes, isNew: !existing, toId: toId || "" };
    plan.rows.push(rowPlan);
    if (rowPlan.isNew) plan.adds++; else if (notes.length || (!kind && hasChange)) plan.updates++;
    if (kind === "Returned") plan.returns++; else if (kind) plan.assigns++;
    plan.actionable++;
  }
  return plan;
}

const itemSummary = (p) => `<div class="tiles" style="margin-top:.8rem">
  <div class="tile"><div class="tile-n">${p.adds}</div><div class="tile-l">New items</div></div>
  <div class="tile"><div class="tile-n">${p.updates}</div><div class="tile-l">Updated</div></div>
  <div class="tile"><div class="tile-n">${p.assigns}</div><div class="tile-l">Assigned / transferred</div></div>
  <div class="tile"><div class="tile-n">${p.returns}</div><div class="tile-l">Returned</div></div>
  <div class="tile"><div class="tile-n">${p.unchanged}</div><div class="tile-l">Unchanged</div></div>
  <div class="tile tile-bad"><div class="tile-n">${p.errors.length}</div><div class="tile-l">Problems</div></div></div>`;

const itemPreview = (p) => `<table class="grid"><thead><tr><th>Row</th><th>Tag</th><th>What will happen</th></tr></thead><tbody>${p.rows.slice(0, 200).map((r) => {
  const bits = [];
  if (r.isNew) bits.push(`<span class="status-pill st-ok">New item</span>`);
  else if (r.notes.length) bits.push(`<span class="status-pill st-muted">Update ${esc(r.notes.join(", "))}</span>`);
  if (r.kind) bits.push(`<span class="status-pill ${r.kind === "Returned" ? "st-muted" : "st-pending"}">${r.kind}${r.toId ? ` → ${esc(personName(r.toId))}` : r.existing ? ` (from ${esc(personName(r.existing[I.assignedTo]))})` : ""}</span>`);
  return `<tr><td>${r.rowNo}</td><td class="mono">${esc(r.tag)}</td><td>${bits.join(" ")}</td></tr>`;
}).join("")}</tbody></table>${p.rows.length > 200 ? `<p class="sub" style="padding:.4rem">…and ${p.rows.length - 200} more.</p>` : ""}`;

async function applyItems(plan) {
  const adds = plan.rows.filter((r) => r.isNew);
  const upd = plan.rows.filter((r) => !r.isNew);
  const entries = [];
  const created = adds.length ? await addInventory(adds.map((r) => ({ attrs: r.attrs, geometry: r.geometry }))) : [];
  adds.forEach((r, i) => {
    entries.push({ type: "Added", row: created[i], note: "CSV import" });
    if (r.kind === "Assigned") entries.push({ type: "Assigned", row: created[i], toId: r.toId, note: "CSV import" });
  });
  const prev = new Map(upd.map((r) => [r, r.existing[I.assignedTo] ? String(r.existing[I.assignedTo]) : ""]));
  if (upd.length) await updateInventory(upd.map((r) => ({ row: r.existing, attrs: r.attrs, geometry: r.geometry })));
  for (const r of upd) {
    if (r.kind) entries.push({ type: r.kind, row: r.existing, fromId: prev.get(r), toId: r.toId, note: "CSV import" });
    if (r.notes.length) entries.push({ type: "Edited", row: r.existing, note: `CSV import: ${r.notes.join(", ")}`.slice(0, 480) });
  }
  const res = await logActivity(entries);
  toast(`Import applied: ${adds.length} added, ${upd.length} updated.${res.ok || res.skipped ? "" : " History could not be written: " + res.error}`, res.ok || res.skipped ? "success" : "error", 8000);
  S.actions.refresh();
}

export function openImportItems() {
  importDialog({
    title: "Import items from CSV",
    hint: "Columns: <b>Tag</b> (required), Item, Category, Make, Model, Serial, Status, Description, Assigned To (Edison ID or email), Date Assigned, Region, Building, Room.",
    template: toCSV([{}], ["Tag", "Item", "Category", "Make", "Model", "Serial", "Status", "Description", "Assigned To", "Date Assigned", "Region", "Building", "Room"].map((l) => ({ label: l, get: () => "" }))),
    templateName: "assigned-inventory-items-template.csv",
    build: buildItemsPlan, summary: itemSummary, previewRows: itemPreview, apply: applyItems, applyLabel: "Apply",
  });
}

// ---------------------------------------------------------------- people
function buildUsersPlan(text) {
  const grid = parseCSV(text);
  if (grid.length < 2) throw new Error("That file has no data rows.");
  const h = grid[0].map(norm);
  const c = {
    edison: pick(h, ["edisonid", "edison", "id"]), first: pick(h, ["firstname", "first"]), last: pick(h, ["lastname", "last"]),
    name: pick(h, ["name", "fullname"]), email: pick(h, ["email", "emailaddress"]), section: pick(h, ["section", "temasection"]),
    role: pick(h, ["role", "permissions", "permission"]), sup: pick(h, ["supervisor", "supervisorid", "supervisoredisonid"]), active: pick(h, ["active"]),
  };
  if (c.edison < 0) throw new Error('The file needs an "Edison ID" column.');
  const plan = { rows: [], errors: [], adds: 0, updates: 0, unchanged: 0, actionable: 0 };
  const seen = new Set();
  const seenEmail = new Set();
  for (let r = 1; r < grid.length; r++) {
    const cells = grid[r];
    const rowNo = r + 1;
    const g = (i) => (i >= 0 ? String(cells[i] ?? "").trim() : undefined);
    const edison = g(c.edison);
    const fail = (msg) => plan.errors.push({ rowNo, id: edison, msg });
    if (!edison) { fail("Edison ID is blank"); continue; }
    if (seen.has(edison)) { fail("Edison ID appears more than once in the file"); continue; }
    seen.add(edison);
    const existing = S.usersByEdison.get(edison) || null;
    const v = {
      edison,
      first: g(c.first), last: g(c.last), email: g(c.email), section: g(c.section), role: g(c.role), supervisor: g(c.sup),
      active: c.active >= 0 ? !/^(no|n|false|0)$/i.test(g(c.active)) : undefined,
    };
    if (c.name >= 0 && v.first === undefined && v.last === undefined) {
      const parts = g(c.name).split(/\s+/).filter(Boolean);
      v.first = parts.slice(0, -1).join(" ") || parts[0] || ""; v.last = parts.length > 1 ? parts[parts.length - 1] : "";
    }
    if (v.role !== undefined && v.role !== "") {
      const hit = CONFIG.ROLES.find((x) => x.toLowerCase() === v.role.toLowerCase() || roleLabel(x).toLowerCase() === v.role.toLowerCase());
      if (!hit) { fail(`Role "${v.role}" must be one of: ${CONFIG.ROLES.map(roleLabel).join(", ")}`); continue; }
      v.role = hit;
    }
    // fill unspecified fields from the existing person so validation and the write see a whole record
    const merged = {
      edison,
      first: v.first ?? (existing ? existing[U.first] : ""), last: v.last ?? (existing ? existing[U.last] : ""),
      email: v.email ?? (existing ? existing[U.email] : ""), section: v.section ?? (existing ? existing[U.section] : ""),
      role: v.role || (existing ? existing[U.permissions] : CONFIG.ROLE_NON_MANAGER),
      supervisor: v.supervisor ?? (existing ? existing[U.supervisor] : ""),
      active: v.active ?? (existing ? isUserActive(existing) : true),
    };
    const problem = validateUser(merged, existing);
    if (problem) { fail(problem); continue; }
    const em = String(merged.email || "").toLowerCase();
    if (em && seenEmail.has(em)) { fail("Email appears more than once in the file"); continue; }
    if (em) seenEmail.add(em);
    const attrs = userAttrs(merged);
    if (existing) {
      const changed = Object.entries(attrs).filter(([f, val]) => String(existing[f] ?? "") !== String(val ?? "")).map(([f]) => f);
      if (!changed.length) { plan.unchanged++; continue; }
      plan.rows.push({ rowNo, edison, existing, attrs, changed, isNew: false });
      plan.updates++;
    } else { plan.rows.push({ rowNo, edison, attrs, isNew: true }); plan.adds++; }
    plan.actionable++;
  }
  return plan;
}
const userSummary = (p) => `<div class="tiles" style="margin-top:.8rem">
  <div class="tile"><div class="tile-n">${p.adds}</div><div class="tile-l">New people</div></div>
  <div class="tile"><div class="tile-n">${p.updates}</div><div class="tile-l">Updated</div></div>
  <div class="tile"><div class="tile-n">${p.unchanged}</div><div class="tile-l">Unchanged</div></div>
  <div class="tile tile-bad"><div class="tile-n">${p.errors.length}</div><div class="tile-l">Problems</div></div></div>`;
const userPreview = (p) => `<table class="grid"><thead><tr><th>Row</th><th>Edison ID</th><th>Name</th><th>Role</th><th>What will happen</th></tr></thead><tbody>${p.rows.slice(0, 200).map((r) =>
  `<tr><td>${r.rowNo}</td><td class="mono">${esc(r.edison)}</td><td>${esc(r.attrs[U.full])}</td><td>${esc(r.attrs[U.permissions])}</td>
   <td>${r.isNew ? `<span class="status-pill st-ok">New person</span>` : `<span class="status-pill st-muted">Update ${esc(r.changed.map((f) => Object.keys(U).find((k) => U[k] === f) || f).join(", "))}</span>`}</td></tr>`).join("")}</tbody></table>`;
async function applyUsers(plan) {
  const adds = plan.rows.filter((r) => r.isNew);
  const upd = plan.rows.filter((r) => !r.isNew);
  if (adds.length) await addUsers(adds.map((r) => r.attrs));
  if (upd.length) await updateUsers(upd.map((r) => ({ row: r.existing, attrs: r.attrs })));
  const entries = [
    ...adds.map((r) => ({ type: "User added", tag: "", desc: `${r.attrs[U.full]} (${r.attrs[U.permissions]})`, toId: r.edison, note: "CSV import" })),
    ...upd.map((r) => ({ type: "User changed", tag: "", desc: `${r.attrs[U.full]} (${r.attrs[U.permissions]})`, toId: r.edison, note: "CSV import" })),
  ];
  await logActivity(entries);
  toast(`Import applied: ${adds.length} added, ${upd.length} updated.`, "success");
  S.actions.refresh();
}
export function openImportUsers() {
  importDialog({
    title: "Import people from CSV",
    hint: "Columns: <b>Edison ID</b> (required), First Name, Last Name (or Name), Email, Section, Role, Supervisor (Edison ID), Active.",
    template: toCSV([{}], ["Edison ID", "First Name", "Last Name", "Email", "Section", "Role", "Supervisor", "Active"].map((l) => ({ label: l, get: () => "" }))),
    templateName: "assigned-inventory-people-template.csv",
    build: buildUsersPlan, summary: userSummary, previewRows: userPreview, apply: applyUsers, applyLabel: "Apply",
  });
}

S.actions.openImportItems = openImportItems;
S.actions.openImportUsers = openImportUsers;
