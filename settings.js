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
