// ---------------------------------------------------------------------------
// Inventory tab: tiles, search + filters, a sortable table with one-click row
// actions, bulk selection, and a "scan or type a tag" box.
// ---------------------------------------------------------------------------

import { CONFIG } from "./config.js";
import { isConfirmed, lastConfirmation } from "./problems.js";
import { lastAudit } from "./audit.js";
import { esc, $, matchesSearch, debounce, toCSV, downloadText } from "./shared/util.js";
import { toast, confirmDialog } from "./shared/ui.js";
import {
  S, I, U, fullName, personName, userById, itemTitle, itemMakeModel, placeText, groupsFor, realInv,
  isRetired, needsAttention, categoryOptions, sectionOptions, regionOptions, fmtYmd, msToYmd, initials, ownerName, ownerOptions,
} from "./state.js";
import { canAddInventory, canBulkImport, isLimitedUser, canEditOthers } from "./permissions.js";
import { openAssignDialog, openReturnDialog } from "./assign.js";
import { openAddItem } from "./additem.js";
import { openDrawer } from "./drawer.js";

const F = { q: "", cat: "", region: "", section: "", owner: "", tile: "all", sort: "recent", dir: -1, shown: CONFIG.ROWS_PER_PAGE };
const sel = new Set(); // selected object ids
let built = false;

export function applyUrlFilters(params) {
  const want = (params.get("section") || "").trim().toLowerCase();
  if (want) {
    const hit = sectionOptions().find((s) => s.toLowerCase() === want);
    if (hit) F.section = hit;
    else console.warn(`[url params] section "${params.get("section")}" is not a known section — ignored.`);
  }
}

export function initInventory() {
  const el = $("#screen-inv");
  el.addEventListener("input", debounce((e) => {
    if (e.target.id === "inv-q") { F.q = e.target.value; F.shown = CONFIG.ROWS_PER_PAGE; renderRows(); }
  }, 120));
  el.addEventListener("change", (e) => {
    const id = e.target.id;
    if (id === "inv-cat") F.cat = e.target.value;
    else if (id === "inv-region") F.region = e.target.value;
    else if (id === "inv-section") F.section = e.target.value;
    else if (id === "inv-owner") F.owner = e.target.value;
    else if (e.target.dataset.chk) { const o = Number(e.target.dataset.chk); e.target.checked ? sel.add(o) : sel.delete(o); return renderRows(); }
    else if (id === "inv-selall") { const rows = visibleRows(); rows.forEach((r) => (e.target.checked ? sel.add(r._oid) : sel.delete(r._oid))); return renderRows(); }
    else return;
    F.shown = CONFIG.ROWS_PER_PAGE;
    renderRows();
  });
  el.addEventListener("keydown", (e) => { if (e.target.id === "inv-scan" && e.key === "Enter") { e.preventDefault(); onScan(e.target); } });
  el.addEventListener("click", (e) => {
    const t = e.target;
    const tile = t.closest("[data-tile]");
    if (tile) { F.tile = tile.dataset.tile; F.shown = CONFIG.ROWS_PER_PAGE; return renderRows(); }
    const th = t.closest("[data-sort]");
    if (th) { F.dir = F.sort === th.dataset.sort ? -F.dir : 1; F.sort = th.dataset.sort; return renderRows(); }
    const a = t.closest("[data-act]");
    if (a) {
      const row = S.invByOid.get(Number(a.dataset.oid));
      e.stopPropagation();
      if (a.dataset.act === "assign") return openAssignDialog([row]);
      if (a.dataset.act === "transfer") return openAssignDialog([row], { transfer: true });
      if (a.dataset.act === "return") return openReturnDialog([row]);
    }
    if (t.id === "inv-add") return openAddItem();
    if (t.id === "inv-import") return S.actions.openImportItems?.();
    if (t.id === "inv-export") return exportCsv();
    if (t.id === "bulk-clear") { sel.clear(); return renderRows(); }
    if (t.id === "bulk-assign") return openAssignDialog(selectedRows());
    if (t.id === "bulk-return") return openReturnDialog(selectedRows());
    if (t.id === "inv-more") { F.shown += CONFIG.ROWS_PER_PAGE; return renderRows(); }
    if (t.id === "inv-clear") { Object.assign(F, { q: "", cat: "", region: "", section: "", owner: "", tile: "all" }); return renderInventory(true); }
    if (t.dataset.chk || t.id === "inv-selall" || t.closest(".chk")) return; // checkbox cell clicks never open the drawer
    const tr = t.closest("tr[data-oid]");
    if (tr) openDrawer(Number(tr.dataset.oid));
  });
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.matches("tr[data-oid]")) openDrawer(Number(e.target.dataset.oid));
  });
  S.render.inv = () => renderInventory();
}

const selectedRows = () => [...sel].map((o) => S.invByOid.get(o)).filter(Boolean);

function matchesTile(r) {
  switch (F.tile) {
    case "assigned": return !!r[I.assignedTo];
    case "available": return !r[I.assignedTo] && !isRetired(r);
    case "attention": return needsAttention(r);
    case "unaud": return !isRetired(r) && !!r[I.tag] && !lastAudit(r, I.tag);
    case "unconf": return !!r[I.assignedTo] && !isRetired(r) && !isConfirmed(r);
    default: return true;
  }
}

function filtered() {
  return realInv().filter((r) => {
    if (!matchesTile(r)) return false;
    if (F.cat && r[I.category] !== F.cat) return false;
    if (F.region && r[I.region] !== F.region) return false;
    if (F.owner) {
      const o = String(r[I.propertyOwner] || "").trim().toLowerCase();
      if (F.owner === "__none") { if (o) return false; } else if (o !== F.owner.toLowerCase()) return false;
    }
    if (F.section) { const u = userById(r[I.assignedTo]); if (!u || u[U.section] !== F.section) return false; }
    if (F.q && !matchesSearch([r[I.tag], r[I.serial], r[I.item], r[I.make], r[I.model], r[I.category], r[I.description], r[I.place], r[I.room], personName(r[I.assignedTo]), ownerName(r[I.propertyOwner])], F.q)) return false;
    return true;
  });
}

const sorters = {
  recent: (a, b) => (Number(b[I.editDate]) || 0) - (Number(a[I.editDate]) || 0) || String(a[I.tag]).localeCompare(String(b[I.tag]), undefined, { numeric: true }),
  tag: (a, b) => String(a[I.tag] || "").localeCompare(String(b[I.tag] || ""), undefined, { numeric: true }),
  item: (a, b) => itemTitle(a).localeCompare(itemTitle(b)) || itemMakeModel(a).localeCompare(itemMakeModel(b)),
  status: (a, b) => String(a[I.status] || "").localeCompare(String(b[I.status] || "")),
  who: (a, b) => personName(a[I.assignedTo]).localeCompare(personName(b[I.assignedTo])),
  owner: (a, b) => ownerName(a[I.propertyOwner]).localeCompare(ownerName(b[I.propertyOwner])),
  place: (a, b) => placeText(a).localeCompare(placeText(b)),
};
function visibleRows() {
  const rows = filtered();
  const fn = sorters[F.sort] || sorters.recent;
  rows.sort((a, b) => F.dir * fn(a, b) * (F.sort === "recent" ? -1 : 1));
  return rows;
}

const showAudit = () => !!S.audit.url && !isLimitedUser(S.me);
const showConf = () => !!S.problems.confUrl && !isLimitedUser(S.me);
const canMultiSelect = () => !S.readonly && canEditOthers(S.me);

/** Full re-render of the shell (option lists may have changed) then the rows. */
export function renderInventory(rebuild = false) {
  const el = $("#screen-inv");
  if (!built || rebuild) {
    built = true;
    const addOK = canAddInventory(S.me) && !S.readonly;
    el.innerHTML = `
      <div class="tiles" id="inv-tiles"></div>
      <div class="toolbar">
        <input id="inv-q" type="search" placeholder="Search tag, serial, item, person…" value="${esc(F.q)}" aria-label="Search inventory" autocomplete="off" />
        <select id="inv-cat" aria-label="Category"></select>
        <select id="inv-region" aria-label="Region"></select>
        ${ownerOptions().length ? `<select id="inv-owner" aria-label="Property owner" title="Section that owns the item"></select>` : ""}
        <select id="inv-section" aria-label="Assignee's section" title="Section of the person it is assigned to"></select>
        ${canMultiSelect() ? `<div class="scan" title="Scan a barcode or type a tag, then press Enter"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#124ea8" stroke-width="2" aria-hidden="true"><path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2M7 8v8M11 8v8M15 8v8"/></svg><input id="inv-scan" placeholder="Scan / type tag ↵" aria-label="Scan or type a tag number" autocomplete="off" /></div>` : ""}
        <span class="spacer"></span>
        <span id="inv-count" class="sub"></span>
        ${canBulkImport(S.me) && !S.readonly ? `<button type="button" id="inv-import">Import CSV</button>` : ""}
        <button type="button" id="inv-export">Export CSV</button>
        ${addOK ? `<button type="button" id="inv-add" class="btn-primary">+ Add item</button>` : ""}
      </div>
      <div id="inv-bulk"></div>
      <div class="table-wrap tall"><table class="grid" id="inv-table"><thead id="inv-head"></thead><tbody id="inv-body"></tbody></table></div>
      <div id="inv-foot" class="list-foot"></div>`;
  }
  const opt = (list, cur, all) => `<option value="">${all}</option>` + list.map((v) => `<option ${v === cur ? "selected" : ""}>${esc(v)}</option>`).join("");
  $("#inv-cat").innerHTML = opt(categoryOptions(), F.cat, "All categories");
  $("#inv-region").innerHTML = opt(regionOptions(), F.region, "All regions");
  if ($("#inv-owner")) $("#inv-owner").innerHTML = `<option value="">All property owners</option>` + ownerOptions().map((o) => `<option value="${esc(o.code)}" ${String(o.code).toLowerCase() === F.owner.toLowerCase() ? "selected" : ""}>${esc(o.name)}</option>`).join("") + `<option value="__none" ${F.owner === "__none" ? "selected" : ""}>Owner not set</option>`;
  $("#inv-section").innerHTML = opt(sectionOptions(), F.section, "All sections");
  renderRows();
}

function renderRows() {
  const all = realInv();
  const n = all.length;
  const a = all.filter((r) => r[I.assignedTo]).length;
  const av = all.filter((r) => !r[I.assignedTo] && !isRetired(r)).length;
  const w = all.filter(needsAttention).length;
  const tile = (k, num, label, cls = "") => `<button type="button" class="tile ${cls}${F.tile === k ? " tile-on" : ""}" data-tile="${k}"><div class="tile-n">${num}</div><div class="tile-l">${label}</div></button>`;
  $("#inv-tiles").innerHTML = tile("all", n, "Total items") + tile("assigned", a, "Assigned") + tile("available", av, "Available to assign") + tile("attention", w, "Needs attention", "tile-warn")
    + (showAudit() ? tile("unaud", all.filter((r) => !isRetired(r) && r[I.tag] && !lastAudit(r, I.tag)).length, "No photo audit") : "")
    + (showConf() ? tile("unconf", all.filter((r) => r[I.assignedTo] && !isRetired(r) && !isConfirmed(r)).length, "Not confirmed by holder") : "");

  const rows = visibleRows();
  const shown = rows.slice(0, F.shown);
  const multi = canMultiSelect();
  const th = (key, label) => `<th data-sort="${key}" class="sortable" title="Sort">${label}${F.sort === key ? (F.dir === 1 ? " ▲" : " ▼") : ""}</th>`;
  $("#inv-head").innerHTML = `<tr>${multi ? `<th class="chk"><input type="checkbox" id="inv-selall" aria-label="Select all shown" ${shown.length && shown.every((r) => sel.has(r._oid)) ? "checked" : ""} /></th>` : ""}
    ${th("tag", "Tag")}${th("item", "Item")}<th>Make / model</th>${th("status", "Status")}${th("who", "Assigned to")}${showConf() ? "<th>Confirmed</th>" : ""}${showAudit() ? "<th>Last audit</th>" : ""}${th("place", "Location")}${ownerOptions().length ? th("owner", "Owner") : ""}<th></th></tr>`;

  $("#inv-body").innerHTML = shown.map((r) => {
    const g = groupsFor(r);
    const retired = isRetired(r);
    const who = r[I.assignedTo] ? personName(r[I.assignedTo]) : "";
    const canAssign = !S.readonly && g.assignment && !retired;
    const st = String(r[I.status] || "");
    return `<tr data-oid="${r._oid}" tabindex="0" class="${sel.has(r._oid) ? "row-sel" : ""}${retired ? " row-inactive" : ""}">
      ${multi ? `<td class="chk"><input type="checkbox" data-chk="${r._oid}" aria-label="Select ${esc(r[I.tag] || "item")}" ${sel.has(r._oid) ? "checked" : ""} /></td>` : ""}
      <td class="mono">${esc(r[I.tag] || "—")}</td><td>${esc(itemTitle(r))}</td><td>${esc(itemMakeModel(r))}</td>
      <td>${st ? `<span class="status-pill ${retired ? "st-muted" : needsAttention(r) ? "st-pending" : "st-ok"}">${esc(st)}</span>` : ""}</td>
      <td>${who ? `<span class="who"><span class="av">${esc(initials(who))}</span>${esc(who)}</span>` : `<span class="unassigned">Unassigned</span>`}</td>
      ${showConf() ? `<td class="sub">${r[I.assignedTo] && !retired ? (lastConfirmation(r) ? esc(fmtYmd(lastConfirmation(r).confirmed_date)) : "—") : ""}</td>` : ""}
      ${showAudit() ? `<td class="sub">${lastAudit(r, I.tag) ? esc(fmtYmd(lastAudit(r, I.tag)._when)) : "—"}</td>` : ""}
      <td class="sub">${esc(placeText(r))}</td>
      ${ownerOptions().length ? `<td class="sub">${esc(ownerName(r[I.propertyOwner]))}</td>` : ""}
      <td class="row-actions">${canAssign ? (r[I.assignedTo]
        ? `<button type="button" data-act="transfer" data-oid="${r._oid}">Transfer</button><button type="button" data-act="return" data-oid="${r._oid}">Return</button>`
        : `<button type="button" class="btn-primary" data-act="assign" data-oid="${r._oid}">Assign</button>`) : ""}</td></tr>`;
  }).join("") || `<tr><td colspan="12" class="empty">Nothing matches. <button type="button" class="link-btn" id="inv-clear">Clear filters</button></td></tr>`;

  $("#inv-count").textContent = `${rows.length} of ${n}`;
  $("#inv-foot").innerHTML = (rows.length > shown.length ? `<button type="button" id="inv-more">Show ${Math.min(CONFIG.ROWS_PER_PAGE, rows.length - shown.length)} more</button> ` : "")
    + (S.blankHidden ? `<span class="sub">${S.blankHidden} empty placeholder record(s) in the layer are hidden.</span>` : "");

  const picked = selectedRows();
  $("#inv-bulk").innerHTML = picked.length
    ? `<div class="banner banner-info"><b>${picked.length} selected</b><span class="spacer"></span><button type="button" id="bulk-clear">Clear</button>
        <button type="button" id="bulk-return">Return to stock</button><button type="button" class="btn-primary" id="bulk-assign">Assign ${picked.length} to…</button></div>` : "";
}

async function onScan(input) {
  const raw = input.value.trim();
  const code = raw.toLowerCase();
  if (!code) return;
  input.value = "";
  const row = realInv().find((r) => String(r[I.tag] || "").trim().toLowerCase() === code)
    || realInv().find((r) => String(r[I.serial] || "").trim().toLowerCase() === code);
  if (!row) {
    if (canAddInventory(S.me) && !S.readonly) {
      if (await confirmDialog({ title: "Tag not found", message: `No item has the tag “${raw}”. Add it now?`, confirmLabel: "Add item" })) openAddItem({ tag: raw });
    } else toast(`No item with the tag “${raw}”.`, "error");
    return;
  }
  const g = groupsFor(row);
  if (!S.readonly && g.assignment && !isRetired(row)) openAssignDialog([row], { transfer: !!row[I.assignedTo] });
  else openDrawer(row._oid);
}

function exportCsv() {
  const rows = visibleRows();
  downloadText("assigned-inventory.csv", toCSV(rows, [
    { label: "Tag", get: (r) => r[I.tag] }, { label: "Serial", get: (r) => r[I.serial] }, { label: "Category", get: (r) => r[I.category] },
    { label: "Item", get: (r) => r[I.item] }, { label: "Make", get: (r) => r[I.make] }, { label: "Model", get: (r) => r[I.model] },
    { label: "Status", get: (r) => r[I.status] }, { label: "Description", get: (r) => r[I.description] },
    { label: "Assigned To (Edison ID)", get: (r) => r[I.assignedTo] }, { label: "Assigned To", get: (r) => personName(r[I.assignedTo]) },
    { label: "Date Assigned", get: (r) => msToYmd(r[I.dateAssigned]) },
    { label: "Last photo audit", get: (r) => (lastAudit(r, I.tag) ? fmtYmd(lastAudit(r, I.tag)._when) : "") },
    { label: "Confirmed by holder", get: (r) => (lastConfirmation(r) ? fmtYmd(lastConfirmation(r).confirmed_date) : "") }, { label: "Property owner", get: (r) => ownerName(r[I.propertyOwner]) }, { label: "Region", get: (r) => r[I.region] },
    { label: "Building", get: (r) => r[I.place] }, { label: "Room", get: (r) => r[I.room] }, { label: "Address", get: (r) => r[I.address] },
    { label: "City", get: (r) => r[I.city] }, { label: "State", get: (r) => r[I.state] }, { label: "Zip", get: (r) => r[I.zip] },
  ]));
}
