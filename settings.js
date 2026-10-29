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
import { S, U, I, regionList, sectionOptions, statusOptions, ownerOptions, isBlankRow } from "./state.js";
import { loadLists } from "./activity.js";
import { canManageSettings, ownsCode } from "./permissions.js";
import { openLegacyImport } from "./legacy.js";
import { addTextFieldToLayer, updateFieldDomain } from "./activity.js";
import { getLayerInfo, itemSharing } from "./shared/esri-client.js";
import { confirmDialog } from "./shared/ui.js";

const LISTS = [
  { key: "section", title: "Sections", hint: "Used for people and the “Section” filter.", values: sectionOptions, usage: (v) => S.users.filter((u) => u[U.section] === v).length, unit: "people" },
  { key: "status", title: "Item statuses", hint: "Suggested status values. Words like “repair” or “retired” are recognised for the tiles (see config.js).", values: statusOptions, usage: (v) => S.inv.filter((r) => r[I.status] === v).length, unit: "items" },
];
const sharingCache = new Map(); // item id -> { access, groups } | { error } (fetched once per page load)
const ACCESS_LABEL = { private: "Private (owner only)", shared: "Shared with groups", org: "Whole organization", public: "Public" };
const sharingHtml = (s) => {
  if (!s) return `<span class="sub">Loading…</span>`;
  if (s.error) return `<span class="sub" title="${esc(s.error)}">Not visible to your account</span>`;
  const parts = [];
  if (s.access && s.access !== "shared") parts.push(`<span class="tag tag-muted">${esc(ACCESS_LABEL[s.access] || s.access)}</span>`);
  if (s.groups === null) parts.push(`<span class="sub">Groups not visible to your account</span>`);
  else parts.push(...s.groups.map((t) => `<span class="tag">${esc(t)}</span>`));
  if (!parts.length) parts.push(`<span class="sub">Not shared with any group</span>`);
  return `<span style="display:flex;gap:.3rem;flex-wrap:wrap">${parts.join("")}</span>`;
};
function loadSharing(ids) {
  ids.forEach(async (id) => {
    if (!sharingCache.has(id)) sharingCache.set(id, await itemSharing(id));
    document.querySelectorAll(`[data-share="${id}"]`).forEach((td) => { td.innerHTML = sharingHtml(sharingCache.get(id)); });
  });
}
const draft = {}; // key -> string[] being edited
let regionDraft = null; // region offices being edited
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
      case "legacy": return openLegacyImport();
      case "reg-add": syncRegions(); regionDraft.push({ name: "", address: "", city: "", state: "TN", zip: "", county: "", lat: null, lng: null }); renderSettings(); break;
      case "reg-del": syncRegions(); regionDraft.splice(Number(b.dataset.i), 1); renderSettings(); break;
      case "reg-reset": regionDraft = null; renderSettings(); break;
      case "reg-find": syncRegions(); return findPin(Number(b.dataset.i), b);
      case "reg-save": return saveRegions(b);
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
  const legacyCard = `<div class="card"><h2>Legacy history</h2>
    <p class="sub">Bring the old webhook assignment history into the Activity log, so every item's History shows its full past. Only real changes of holder are imported; you see a preview first, and it is safe to run again.</p>
    <button type="button" data-s="legacy" ${A.url ? "" : "disabled title=\"Needs the log service\""}>Import legacy history…</button></div>`;
  const srcRows = Object.values(CONFIG.ITEM_IDS || {}).map((x) => `<tr><td>${esc(x.label)}</td><td class="mono">${esc(x.id)}</td><td data-share="${esc(x.id)}">${sharingHtml(sharingCache.get(x.id))}</td><td><a href="${esc(CONFIG.ARCGIS_PORTAL_URL)}/home/item.html?id=${esc(x.id)}" target="_blank" rel="noopener">Open item</a></td></tr>`).join("");
  const sourcesCard = `<div class="card"><h2>Data sources</h2>
    <p class="sub">The editable ArcGIS Online items this app reads and writes. People who only need to view inventory use view-only copies instead of these. Backups: <code>backup_inventory.py</code>.</p>
    <div class="table-wrap"><table class="grid"><thead><tr><th>Layer</th><th>Item ID</th><th>Shared with</th><th></th></tr></thead><tbody>${srcRows}</tbody></table></div></div>`;
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
  const regs = regionDraft || (regionDraft = regionList().map((r) => ({ ...r })));
  const rin = (i, k, w, ph = "") => `<input class="set-input" data-reg="${i}" data-k="${k}" value="${esc(regs[i][k] ?? "")}" ${w ? `style="width:${w}"` : ""} placeholder="${ph}" aria-label="${k} for region ${i + 1}" />`;
  const regionCard = `<div class="card"><h2>Office addresses</h2>
    <p class="sub">The offices people can pick as an item's region. Choosing one fills in the address and map pin. Add, edit or delete offices here; changes affect new choices only, items already saved keep their address. ${A.listsUrl ? "" : "<b>Needs the log service to save.</b>"}</p>
    <div class="table-wrap"><table class="grid" id="set-regions"><thead><tr><th>Office</th><th>Address</th><th>City</th><th>State</th><th>Zip</th><th>County</th><th></th></tr></thead><tbody>
      ${regs.map((r, i) => `<tr>
        <td>${rin(i, "name", "8rem", "e.g. East")}</td><td>${rin(i, "address", "15rem")}</td><td>${rin(i, "city", "9rem")}</td><td>${rin(i, "state", "3rem")}</td><td>${rin(i, "zip", "5rem")}</td><td>${rin(i, "county", "9rem")}</td>
        <td class="row-actions"><button type="button" class="icon-btn" data-s="reg-del" data-i="${i}" aria-label="Delete office">&times;</button></td></tr>`).join("")
        || `<tr><td colspan="7" class="empty">No offices. Add one.</td></tr>`}
    </tbody></table></div>
    <div class="set-actions"><button type="button" data-s="reg-add">+ Add office</button><span class="spacer"></span>
      <button type="button" data-s="reg-reset">Discard changes</button>
      <button type="button" class="btn-primary" data-s="reg-save" ${A.listsUrl ? "" : "disabled title=\"Needs the log service\""}>Save offices</button></div></div>`;
  el.innerHTML = `<p class="sub" style="max-width:48rem">Dropdown lists are edited here instead of in <code>config.js</code>.</p>
    ${accessCard}
    ${legacyCard}
    ${sourcesCard}
    <div class="set-grid">${listCards}</div>
    ${regionCard}`;
  loadSharing(Object.values(CONFIG.ITEM_IDS || {}).map((x) => x.id));
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

function syncRegions() {
  if (!regionDraft) return;
  document.querySelectorAll("#set-regions input[data-reg]").forEach((inp) => { const r = regionDraft[Number(inp.dataset.reg)]; if (r) r[inp.dataset.k] = inp.value; });
}

async function findPin(i, btn) {
  const r = regionDraft[i];
  const q = [r.address, r.city, r.state, r.zip].filter((x) => String(x || "").trim()).join(", ");
  if (!q) return toast("Enter an address first.", "error");
  btn.disabled = true;
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`);
    const hit = (await res.json())[0];
    if (!hit) throw new Error("No match for that address.");
    r.lat = Number(Number(hit.lat).toFixed(6)); r.lng = Number(Number(hit.lon).toFixed(6));
    toast("Pin found. Save regions to keep it.", "success");
  } catch (err) { toast(`Couldn't find it: ${err.message}`, "error"); }
  renderSettings();
}

async function saveRegions(btn) {
  syncRegions();
  const regs = regionDraft.map((r) => ({ ...r, name: String(r.name || "").trim() })).filter((r) => r.name || r.address);
  const bad = (m) => toast(m, "error", 7000);
  const names = regs.map((r) => r.name.toLowerCase());
  if (regs.some((r) => !r.name)) return bad("Every office needs a name.");
  if (new Set(names).size !== names.length) return bad("Two offices have the same name.");
  if (regs.some((r) => /[|]/.test(Object.values(r).join("")))) return bad('Please don\'t use the "|" character.');
  const num = (v) => (v === null || v === undefined || String(v).trim() === "" ? null : Number(v));
  for (const r of regs) {
    r.lat = num(r.lat); r.lng = num(r.lng);
    if ((r.lat !== null && !Number.isFinite(r.lat)) || (r.lng !== null && !Number.isFinite(r.lng))) return bad(`${r.name}: latitude and longitude must be numbers.`);
  }
  const addrV = (r) => [r.name, r.address, r.city, r.state, r.zip].map((x) => String(x || "").trim()).join("|");
  const geoV = (r) => [r.name, String(r.county || "").trim(), r.lat ?? "", r.lng ?? ""].join("|");
  if (regs.some((r) => addrV(r).length > 80 || geoV(r).length > 80)) return bad("An address is too long to store (about 60 characters including the name, city, state and zip).");
  btn.disabled = true;
  // Map pins are looked up automatically for new or changed addresses (best effort).
  const before = new Map(regionList().map((r) => [r.name, [r.address, r.city, r.state, r.zip].join("|")]));
  for (const r of regs) {
    const now = [r.address, r.city, r.state, r.zip].join("|");
    if (!String(r.address || "").trim() || (r.lat !== null && r.lng !== null && before.get(r.name) === now)) continue;
    try {
      const q = [r.address, r.city, r.state, r.zip].filter((x) => String(x || "").trim()).join(", ");
      const hit = (await (await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`)).json())[0];
      if (hit) { r.lat = Number(Number(hit.lat).toFixed(6)); r.lng = Number(Number(hit.lon).toFixed(6)); }
    } catch { /* pin stays as it was; the address still saves */ }
  }
  try {
    const existing = (S.lists.rows || []).filter((r) => ["region", "reg_addr", "reg_geo"].includes(r.list_name));
    await applyEdits(S.activity.listsUrl, {
      deletes: existing.map((r) => r._oid),
      adds: regs.flatMap((r, i) => [
        { attributes: { list_name: "region", value: r.name, sort_order: i + 1 } },
        { attributes: { list_name: "reg_addr", value: addrV(r), sort_order: i + 1 } },
        { attributes: { list_name: "reg_geo", value: geoV(r), sort_order: i + 1 } },
      ]),
    });
    await loadLists();
    regionDraft = null;
    toast("Offices saved.", "success");
    S.actions.refresh();
    renderSettings();
  } catch (err) { toast(err.message, "error", 8000); btn.disabled = false; }
}
