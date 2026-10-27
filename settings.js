// ---------------------------------------------------------------------------
// Settings (Inventory Administrator): the Section / Category / Status dropdown lists,
// the log service, and a read-only view of the region office presets.
// Lists are stored in the Lists table of the log service (like TEMAzon's
// Settings tab); until a list is saved, config.js defaults + values already in
// the data are used, so nothing breaks.
// ---------------------------------------------------------------------------

import { CONFIG } from "./config.js";
import { esc, $ } from "./shared/util.js";
import { toast, openModal } from "./shared/ui.js";
import { applyEdits } from "./shared/esri-client.js";
import { S, U, I, sectionOptions, categoryOptions, statusOptions, ownerOptions, isBlankRow } from "./state.js";
import { createLogService, discoverLog, loadActivity, loadLists } from "./activity.js";
import { canManageSettings, ownsCode } from "./permissions.js";
import { openLegacyImport } from "./legacy.js";
import { addTextFieldToLayer, updateFieldDomain } from "./activity.js";
import { getLayerInfo } from "./shared/esri-client.js";
import { confirmDialog } from "./shared/ui.js";
import { createProblemsService, addConfirmationsTable, loadProblemsAll } from "./problems.js";

const LISTS = [
  { key: "section", title: "Sections", hint: "Used for people and the “Section” filter.", values: sectionOptions, usage: (v) => S.users.filter((u) => u[U.section] === v).length, unit: "people" },
  { key: "category", title: "Item categories", hint: "Suggested when adding or editing an item (you can still type something new).", values: categoryOptions, usage: (v) => S.inv.filter((r) => r[I.category] === v).length, unit: "items" },
  { key: "status", title: "Item statuses", hint: "Suggested status values. Words like “repair” or “retired” are recognised for the tiles (see config.js).", values: statusOptions, usage: (v) => S.inv.filter((r) => r[I.status] === v).length, unit: "items" },
];
const draft = {}; // key -> string[] being edited
let ownerDraft = null; // property owner list being edited: [{code, name, old}]

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
      case "add-conf": return addConf(b);
      case "add-owner-field": return addOwnerField(b);
      case "owner-add": syncOwners(); ownerDraft.push({ code: "", name: "", old: false }); renderSettings(); $("#set-owners li:last-child input")?.focus(); break;
      case "owner-del": syncOwners(); return removeOwner(Number(b.dataset.i));
      case "owner-reset": ownerDraft = null; renderSettings(); break;
      case "owner-save": return saveOwners(b);
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
  if (!canManageSettings(S.me)) { el.innerHTML = `<p class="empty">Only an Inventory Administrator can change settings.</p>`; return; }
  const A = S.activity;
  const logCard = `<div class="card"><h2>Log service</h2>
    ${A.url
      ? `<p class="banner banner-ok" style="margin-top:.5rem">Connected — history is being recorded. <span class="sub">${esc(A.serviceUrl)}</span></p>
         <p class="sub">${A.listsUrl ? "The Lists table is available, so the dropdown lists below can be saved." : "The service has no Lists table, so dropdown lists can't be saved."}</p>`
      : `<p class="banner banner-warn" style="margin-top:.5rem">${esc(A.error || "Not found yet.")} History isn't being recorded.</p>
         <p>Creates a small hosted service called <b>${esc(CONFIG.ACTIVITY_SERVICE_TITLE)}</b> in your ArcGIS content with two tables (Activity, Lists). You need an account that can publish content.</p>
         <button type="button" class="btn-primary" data-s="create-log">Create the log service</button>`}
    <p class="sub">Sharing: share the log service with the same group as the Inventory and Users layers and turn <b>editing on</b>, so section editors and everyone else can record their changes.</p>
    <button type="button" data-s="recheck">Check again</button></div>`;
  const PR = S.problems;
  const problemsCard = `<div class="card"><h2>Confirmations &amp; corrections</h2>
    <p class="sub">Holders can confirm their inventory is correct, or say “I don't have this”. Nothing else is reported; Inventory Administrators don't handle repairs or other issues.</p>
    ${PR.url
      ? `<p class="banner banner-ok" style="margin-top:.5rem">Connected — corrections are collected here. <span class="sub">${esc(PR.serviceUrl)}</span></p>
         ${PR.confUrl ? `<p class="banner banner-ok">Confirmations table found.</p>`
           : `<p class="banner banner-warn">The service has no Confirmations table yet, so people can't confirm their items.</p>
              <button type="button" class="btn-primary" data-s="add-conf">Add the confirmations table</button>`}`
      : `<p class="banner banner-warn" style="margin-top:.5rem">${esc(PR.error || "Not found yet.")} Nobody can confirm or report until it exists.</p>
         <p>Creates a small hosted service called <b>${esc(CONFIG.PROBLEMS_SERVICE_TITLE)}</b> with two tables (Problems, Confirmations). People with view-only access use it for their own items.</p>
         <button type="button" class="btn-primary" data-s="create-problems">Create the service</button>`}
    <p class="sub">Sharing: share it with the same group as the inventory layers and turn <b>editing on</b>, so everyone, including view-only people, can add rows. Then paste the item ID into <code>PROBLEMS_ITEM_ID</code> in <code>config.js</code> (optional; otherwise it's found by title).</p>
    <button type="button" data-s="recheck-problems">Check again</button></div>`;
  const owners = ownerOptions();
  const inUse = (code) => S.inv.filter((r) => String(r[I.propertyOwner] || "").toLowerCase() === String(code).toLowerCase()).length;
  const people = (code) => S.users.filter((u) => ownsCode(u, code)).length;
  const ownerDraftList = ownerDraft || (ownerDraft = S.propertyOwners.map((o) => ({ ...o, old: true })));
  const unset = S.inv.filter((r) => !String(r[I.propertyOwner] || "").trim() && !isBlankRow(r)).length;
  const accessCard = `<div class="card"><h2>Property owners</h2>
    <p class="sub">Each item has a <b>property owner</b> (the section responsible for it). People listed as owners of a section can assign, transfer, return and update the location of its items, including unassigned ones. Adding items and editing their details stays with Inventory Administrators. Pick a person's sections under People → Edit person.</p>
    ${S.ownerDomainEditable
      ? `<ul class="set-list" id="set-owners">${ownerDraftList.map((o, i) => `<li class="set-row">
          ${o.old ? `<span class="set-input" style="flex:1">${esc(o.name)}</span>` : `<input class="set-input" data-new="${i}" value="${esc(o.name)}" maxlength="80" aria-label="New property owner name" placeholder="New section name" />`}
          <span class="sub set-used">${o.old ? `${inUse(o.code)} item${inUse(o.code) === 1 ? "" : "s"} · ${people(o.code)} owner${people(o.code) === 1 ? "" : "s"}` : "new"}</span>
          <button type="button" class="icon-btn" data-s="owner-del" data-i="${i}" aria-label="Remove">&times;</button></li>`).join("")}</ul>
        <div class="set-actions"><button type="button" data-s="owner-add">+ Add</button><span class="spacer"></span>
          <button type="button" data-s="owner-reset">Discard changes</button>
          <button type="button" class="btn-primary" data-s="owner-save" ${S.viewOnly ? "disabled title=\"Needs the editable Inventory layer\"" : ""}>Save list</button></div>
        <p class="sub">${unset} item${unset === 1 ? " has" : "s have"} no owner yet. Only Inventory Administrators can assign those. Removing a value that items still use leaves those items with a code that no longer has a name, so reassign them first. Names of existing values are changed in ArcGIS Online (Inventory layer → Data → Fields → property_owner → Display).</p>`
      : `<p class="banner banner-warn">The Inventory layer's <code>${esc(CONFIG.INV.propertyOwner)}</code> field has no list of values, so there is nothing to edit here.</p>`}
    ${S.usersHasOwnerField
      ? `<p class="banner banner-ok">Ready — the Users layer has the <code>${esc(CONFIG.USR.propertyOwnerOf)}</code> field.</p>`
      : `<p class="banner banner-warn">The Users layer has no <code>${esc(CONFIG.USR.propertyOwnerOf)}</code> field yet, so people can't be made property owners.</p>
         ${S.viewOnly ? `<p class="sub">Open the app with an account that can edit the layer to add it.</p>` : `<button type="button" class="btn-primary" data-s="add-owner-field">Add the field to the Users layer</button>`}`}
    <p class="sub">The app only decides which buttons to offer. Property owners still need <b>edit access</b> to the Inventory layer in ArcGIS Online to save anything. If people use view copies of the Users layer, add the new field to that view too (item → Visualization → Fields).</p></div>`;
  const AU = S.audit;
  const auditCard = `<div class="card"><h2>Photo audit</h2>
    ${AU.url ? `<p class="banner banner-ok">Connected — ${AU.rows.length} audit${AU.rows.length === 1 ? "" : "s"}, matched to items by tag number.</p>`
      : `<p class="banner banner-warn">${esc(AU.error || "Not loaded.")} Check that your account can see the Inventory_Photo_Audit item.</p>`}
    <p class="sub">Read only. The item panel shows each item's latest audits with their photos, and the Inventory tab has a <b>Last audit</b> column and a <b>No photo audit</b> tile. Audits are matched on the first filled field of: ${esc(CONFIG.AUDIT.tag.join(", "))}.</p></div>`;
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
    ${auditCard}
    ${accessCard}
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
    toast("Service created.", "success");
    await loadProblemsAll();
    S.problems.serviceUrl = S.problems.serviceUrl || res.url;
    S.actions.refresh();
    renderSettings();
    openModal({
      title: "One more step: share it",
      body: `<p><b>${esc(CONFIG.PROBLEMS_SERVICE_TITLE)}</b> was created in your ArcGIS content (item ID <code>${esc(res.itemId || "see the item page")}</code>). So everyone can confirm their items and report:</p>
        <ol><li>Open it in ArcGIS Online → <b>Share</b> → choose the same group you used for the inventory layers.</li>
        <li><b>Settings → Editing</b> → turn editing on (people can add and update records; the app only lets Inventory Administrators correct reports).</li></ol>
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

async function addConf(btn) {
  btn.disabled = true;
  try {
    await addConfirmationsTable();
    toast("Confirmations table added.", "success");
    await loadProblemsAll();
    S.actions.refresh();
  } catch (err) {
    toast(`Couldn't add it: ${err.message}. You need to be the owner of the service.`, "error", 10000);
  }
  renderSettings();
}

function syncOwners() {
  if (!ownerDraft) return;
  document.querySelectorAll("#set-owners input[data-new]").forEach((inp) => { const o = ownerDraft[Number(inp.dataset.new)]; if (o) o.name = inp.value; });
}

async function removeOwner(i) {
  const o = ownerDraft[i];
  if (o.old) {
    const items = S.inv.filter((r) => String(r[I.propertyOwner] || "").toLowerCase() === String(o.code).toLowerCase()).length;
    const ppl = S.users.filter((u) => ownsCode(u, o.code)).length;
    if (items || ppl) {
      const yes = await confirmDialog({ title: `Remove ${o.name}?`, message: `${items} item${items === 1 ? "" : "s"} and ${ppl} person${ppl === 1 ? "" : "s"} still use it. They keep the old code, but it will no longer have a name here. Remove it from the list anyway? (Nothing changes until you press Save list.)`, confirmLabel: "Remove" });
      if (!yes) return;
    }
  }
  ownerDraft.splice(i, 1);
  renderSettings();
}

async function saveOwners(btn) {
  syncOwners();
  const list = ownerDraft.map((o) => ({ ...o, name: o.name.trim() })).filter((o) => o.old || o.name);
  if (list.some((o) => !o.name)) return toast("Every owner needs a name.", "error");
  const names = list.map((o) => o.name.toLowerCase());
  if (new Set(names).size !== names.length) return toast("Two owners have the same name.", "error");
  btn.disabled = true;
  try {
    const info = await getLayerInfo(CONFIG.INVENTORY_LAYER_URL);
    const f = info.fields.find((x) => x.name === I.propertyOwner);
    if (!f) throw new Error(`The Inventory layer has no ${I.propertyOwner} field.`);
    const max = f.length || 255;
    const codes = new Set(list.filter((o) => o.old).map((o) => String(o.code).toLowerCase()));
    const out = list.map((o) => {
      if (o.old) return { name: o.name, code: o.code };
      let code = o.name.slice(0, max), n = 2;
      while (codes.has(code.toLowerCase())) code = o.name.slice(0, Math.max(1, max - String(n).length - 1)) + "-" + n++;
      codes.add(code.toLowerCase());
      return { name: o.name, code };
    });
    const domain = { type: "codedValue", name: (f.domain && f.domain.name) || "property_owner", codedValues: out };
    await updateFieldDomain(CONFIG.INVENTORY_LAYER_URL, I.propertyOwner, domain);
    S.propertyOwners = out.map((o) => ({ code: String(o.code), name: String(o.name) })).sort((a, b) => a.name.localeCompare(b.name));
    ownerDraft = null;
    toast("Property owners saved.", "success");
    S.actions.refresh();
  } catch (err) {
    toast(`Couldn't save the list: ${err.message}. You need to own the Inventory layer.`, "error", 10000);
    btn.disabled = false;
    return;
  }
  renderSettings();
}

async function addOwnerField(btn) {
  btn.disabled = true;
  try {
    await addTextFieldToLayer(CONFIG.USERS_LAYER_URL, CONFIG.USR.propertyOwnerOf, "Property owner of", 255);
    S.usersHasOwnerField = true;
    toast("Field added. Pick a person's property owner sections under People → Edit person.", "success", 8000);
  } catch (err) {
    toast(`Couldn't add the field: ${err.message}. You need to own the Users layer.`, "error", 10000);
  }
  renderSettings();
}
