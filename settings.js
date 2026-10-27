// ---------------------------------------------------------------------------
// Settings (Property Officer): the Section / Category / Status dropdown lists,
// the log service, and a read-only view of the region office presets.
// Lists are stored in the Lists table of the log service (like TEMAzon's
// Settings tab); until a list is saved, config.js defaults + values already in
// the data are used, so nothing breaks.
// ---------------------------------------------------------------------------

import { CONFIG } from "./config.js";
import { esc, $ } from "./shared/util.js";
import { toast, openModal } from "./shared/ui.js";
import { applyEdits } from "./shared/esri-client.js";
import { S, U, I, sectionOptions, categoryOptions, statusOptions } from "./state.js";
import { createLogService, discoverLog, loadActivity, loadLists } from "./activity.js";
import { canManageSettings } from "./permissions.js";
import { openLegacyImport } from "./legacy.js";
import { createProblemsService, loadProblemsAll } from "./problems.js";

const LISTS = [
  { key: "section", title: "Sections", hint: "Used for people and the “Section” filter.", values: sectionOptions, usage: (v) => S.users.filter((u) => u[U.section] === v).length, unit: "people" },
  { key: "category", title: "Item categories", hint: "Suggested when adding or editing an item (you can still type something new).", values: categoryOptions, usage: (v) => S.inv.filter((r) => r[I.category] === v).length, unit: "items" },
  { key: "status", title: "Item statuses", hint: "Suggested status values. Words like “repair” or “retired” are recognised for the tiles (see config.js).", values: statusOptions, usage: (v) => S.inv.filter((r) => r[I.status] === v).length, unit: "items" },
];
const draft = {}; // key -> string[] being edited

export function initSettings() {
  $("#screen-set").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-s]");
    if (!b) return;
    const key = b.dataset.key;
    if (["add", "del", "up", "down"].includes(b.dataset.s)) LISTS.forEach((L) => syncDraft(L.key)); // keep unsaved typing in every list
    switch (b.dataset.s) {
      case "add": draft[key].push(""); renderSettings(); $(`#set-${key} li:last-child input`)?.focus(); break;
      case "del": draft[key].splice(Number(b.dataset.i), 1); renderSettings(); break;
      case "up": case "down": {
        const i = Number(b.dataset.i), j = b.dataset.s === "up" ? i - 1 : i + 1;
        if (j >= 0 && j < draft[key].length) [draft[key][i], draft[key][j]] = [draft[key][j], draft[key][i]];
        renderSettings(); break;
      }
      case "reset": delete draft[key]; renderSettings(); break;
      case "save": return saveList(key, b);
      case "create-log": return createLog(b);
      case "recheck": return recheck(b);
      case "legacy": return openLegacyImport();
      case "create-problems": return createProblems(b);
      case "recheck-problems": return recheckProblems(b);
    }
  });
  S.render.set = renderSettings;
}

function syncDraft(key) {
  const inputs = [...document.querySelectorAll(`#set-${key} input`)];
  if (inputs.length) draft[key] = inputs.map((i) => i.value);
}

export function renderSettings() {
  const el = $("#screen-set");
  if (!canManageSettings(S.me)) { el.innerHTML = `<p class="empty">Only a Property Officer can change settings.</p>`; return; }
  const A = S.activity;
  const logCard = `<div class="card"><h2>Log service</h2>
    ${A.url
      ? `<p class="banner banner-ok" style="margin-top:.5rem">Connected — history is being recorded. <span class="sub">${esc(A.serviceUrl)}</span></p>
         <p class="sub">${A.listsUrl ? "The Lists table is available, so the dropdown lists below can be saved." : "The service has no Lists table, so dropdown lists can't be saved."}</p>`
      : `<p class="banner banner-warn" style="margin-top:.5rem">${esc(A.error || "Not found yet.")} History isn't being recorded.</p>
         <p>Creates a small hosted service called <b>${esc(CONFIG.ACTIVITY_SERVICE_TITLE)}</b> in your ArcGIS content with two tables (Activity, Lists). You need an account that can publish content.</p>
         <button type="button" class="btn-primary" data-s="create-log">Create the log service</button>`}
    <p class="sub">Sharing: share the log service with the same group as the Inventory and Users layers and turn <b>editing on</b>, so Managers and Non-Managers can record their changes.</p>
    <button type="button" data-s="recheck">Check again</button></div>`;
  const PR = S.problems;
  const problemsCard = `<div class="card"><h2>Problem reports</h2>
    ${PR.url
      ? `<p class="banner banner-ok" style="margin-top:.5rem">Connected — reports are collected here. <span class="sub">${esc(PR.serviceUrl)}</span></p>`
      : `<p class="banner banner-warn" style="margin-top:.5rem">${esc(PR.error || "Not found yet.")} Nobody can report problems until it exists.</p>
         <p>Creates a small hosted service called <b>${esc(CONFIG.PROBLEMS_SERVICE_TITLE)}</b> with one table. People with view-only access use it to report a problem on items assigned to them.</p>
         <button type="button" class="btn-primary" data-s="create-problems">Create the problem-reports service</button>`}
    <p class="sub">Sharing: share it with the same group as the inventory layers and turn <b>editing on</b>, so everyone, including view-only people, can add a report. Then paste the item ID into <code>PROBLEMS_ITEM_ID</code> in <code>config.js</code> (optional; otherwise it's found by title).</p>
    <button type="button" data-s="recheck-problems">Check again</button></div>`;
  const legacyCard = `<div class="card"><h2>Legacy history</h2>
    <p class="sub">Bring the old webhook assignment history into the Activity log, so every item's History shows its full past. Only real changes of holder are imported; you see a preview first, and it is safe to run again.</p>
    <button type="button" data-s="legacy" ${A.url ? "" : "disabled title=\"Needs the log service\""}>Import legacy history…</button></div>`;
  const srcRows = Object.values(CONFIG.ITEM_IDS || {}).map((x) => `<tr><td>${esc(x.label)}</td><td class="mono">${esc(x.id)}</td><td><a href="${esc(CONFIG.ARCGIS_PORTAL_URL)}/home/item.html?id=${esc(x.id)}" target="_blank" rel="noopener">Open item</a></td></tr>`).join("");
  const sourcesCard = `<div class="card"><h2>Data sources</h2>
    <p class="sub">The editable ArcGIS Online items this app reads and writes. People who only need to view inventory use view-only copies instead of these. Backups: <code>backup_inventory.py</code>.</p>
    <div class="table-wrap"><table class="grid"><thead><tr><th>Layer</th><th>Item ID</th><th></th></tr></thead><tbody>${srcRows}</tbody></table></div></div>`;
  const listCards = LISTS.map((L) => {
    if (!draft[L.key]) draft[L.key] = [...(S.lists.stored[L.key] ? S.lists[L.key] : L.values())];
    const vals = draft[L.key];
    return `<div class="card"><h2>${L.title}</h2><p class="sub">${L.hint}</p>
      <ul class="set-list" id="set-${L.key}">${vals.map((v, i) => `<li class="set-row">
        <input class="set-input" value="${esc(v)}" maxlength="80" aria-label="${esc(L.title)} value ${i + 1}" />
        <span class="sub set-used">${v ? `${L.usage(v)} ${L.unit}` : ""}</span>
        <button type="button" class="icon-btn" data-s="up" data-key="${L.key}" data-i="${i}" ${i === 0 ? "disabled" : ""} aria-label="Move up">↑</button>
        <button type="button" class="icon-btn" data-s="down" data-key="${L.key}" data-i="${i}" ${i === vals.length - 1 ? "disabled" : ""} aria-label="Move down">↓</button>
        <button type="button" class="icon-btn" data-s="del" data-key="${L.key}" data-i="${i}" aria-label="Remove">&times;</button></li>`).join("")}</ul>
      <div class="set-actions"><button type="button" data-s="add" data-key="${L.key}">+ Add</button><span class="spacer"></span>
        <button type="button" data-s="reset" data-key="${L.key}">Discard changes</button>
        <button type="button" class="btn-primary" data-s="save" data-key="${L.key}" ${A.listsUrl ? "" : "disabled title=\"Needs the log service\""}>Save list</button></div>
      <p class="sub">Removing a value only affects what's suggested from now on; existing people and items keep what they have.</p></div>`;
  }).join("");
  const presets = Object.entries(CONFIG.REGION_LOCATION_PRESETS).map(([r, p]) => `<tr><td>${esc(r)}</td><td>${esc(p.address)}, ${esc(p.city)}, ${esc(p.state)} ${esc(p.zip)}</td><td>${esc(p.county)}</td></tr>`).join("");
  el.innerHTML = `<p class="sub" style="max-width:48rem">Dropdown lists are edited here instead of in <code>config.js</code>.</p>
    ${logCard}
    ${problemsCard}
    ${legacyCard}
    ${sourcesCard}
    <div class="set-grid">${listCards}</div>
    <div class="card"><h2>Region office addresses</h2><p class="sub">Choosing a region fills in these addresses and the map pin. They live in <code>config.js</code> (<code>REGION_LOCATION_PRESETS</code>) — edit them there if an office moves.</p>
      <div class="table-wrap"><table class="grid"><thead><tr><th>Region</th><th>Address</th><th>County</th></tr></thead><tbody>${presets}</tbody></table></div></div>`;
}

async function saveList(key, btn) {
  syncDraft(key);
  const vals = [...new Set(draft[key].map((v) => v.trim()).filter(Boolean))];
  if (!vals.length) return toast("Add at least one value (or discard your changes).", "error");
  btn.disabled = true;
  try {
    const existing = (S.lists.rows || []).filter((r) => r.list_name === key);
    await applyEdits(S.activity.listsUrl, {
      deletes: existing.map((r) => r._oid),
      adds: vals.map((v, i) => ({ attributes: { list_name: key, value: v.slice(0, 80), sort_order: i + 1 } })),
    });
    await loadLists();
    delete draft[key];
    toast("List saved.", "success");
    S.actions.refresh();
    renderSettings();
  } catch (err) { toast(err.message, "error", 8000); btn.disabled = false; }
}

async function createLog(btn) {
  btn.disabled = true;
  try {
    const res = await createLogService();
    toast("Log service created.", "success");
    await discoverLog();
    S.activity.serviceUrl = S.activity.serviceUrl || res.url;
    await loadActivity();
    await loadLists();
    S.actions.refresh();
    renderSettings();
    openModal({
      title: "One more step: share the log",
      body: `<p>The log service <b>${esc(CONFIG.ACTIVITY_SERVICE_TITLE)}</b> was created in your ArcGIS content. For everyone else's changes to be recorded:</p>
        <ol><li>Open it in ArcGIS Online (item page) → <b>Share</b> → choose the same group you used for the Inventory and Users layers.</li>
        <li><b>Settings → Editing</b> → make sure editing is on (adds allowed).</li></ol>
        <p class="sub">Until then, only you will be able to record or see history.</p>`,
      buttons: [{ label: "Got it", kind: "primary" }],
    });
  } catch (err) {
    toast(`Couldn't create it: ${err.message}`, "error", 10000);
    btn.disabled = false;
  }
}

async function recheck(btn) {
  btn.disabled = true;
  await discoverLog();
  await loadActivity();
  await loadLists();
  S.actions.refresh();
  renderSettings();
}

async function createProblems(btn) {
  btn.disabled = true;
  try {
    const res = await createProblemsService();
    toast("Problem-reports service created.", "success");
    await loadProblemsAll();
    S.problems.serviceUrl = S.problems.serviceUrl || res.url;
    S.actions.refresh();
    renderSettings();
    openModal({
      title: "One more step: share it",
      body: `<p><b>${esc(CONFIG.PROBLEMS_SERVICE_TITLE)}</b> was created in your ArcGIS content (item ID <code>${esc(res.itemId || "see the item page")}</code>). So everyone can report problems:</p>
        <ol><li>Open it in ArcGIS Online → <b>Share</b> → choose the same group you used for the inventory layers.</li>
        <li><b>Settings → Editing</b> → turn editing on (people can add and update records; the app only lets Property Officers resolve them).</li></ol>
        <p class="sub">Optionally paste the item ID into <code>PROBLEMS_ITEM_ID</code> in <code>config.js</code>.</p>`,
      buttons: [{ label: "Got it", kind: "primary" }],
    });
  } catch (err) {
    toast(`Couldn't create it: ${err.message}`, "error", 10000);
    btn.disabled = false;
  }
}

async function recheckProblems(btn) {
  btn.disabled = true;
  await loadProblemsAll();
  S.actions.refresh();
  renderSettings();
}
