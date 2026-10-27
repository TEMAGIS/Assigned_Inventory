// ---------------------------------------------------------------------------
// Item drawer: who has it (with Assign / Transfer / Return right there), the
// item's details (view, or edit what your role allows), photos, and its history.
// ---------------------------------------------------------------------------

import { CONFIG } from "./config.js";
import { esc, $, fmtDateTime } from "./shared/util.js";
import { openModal, toast, confirmDialog } from "./shared/ui.js";
import { listAttachments, attachmentUrl, addAttachment, deleteAttachments } from "./shared/esri-client.js";
import {
  S, I, personName, userById, fullName, initials, itemTitle, itemMakeModel, groupsFor, fmtYmd, msToYmd,
  isRetired, needsAttention, placeText, categoryOptions, statusOptions, ownerName, ownerOptions,
} from "./state.js";
import { updateInventory } from "./edits.js";
import { logAndWarn, historyFor } from "./activity.js";
import { openAssignDialog, openReturnDialog } from "./assign.js";
import { locationFormHTML, mountLocation } from "./location.js";
import { canEditAnything } from "./permissions.js";
import { auditsFor } from "./audit.js";
import { canReport, canConfirm, reportProblem, openReportFor, confirmOne, lastConfirmation } from "./problems.js";

let cur = null; // { oid, editing, loc, photos }

export const isDrawerOpen = () => !!cur;

export function openDrawer(oid, { edit = false } = {}) {
  const row = S.invByOid.get(Number(oid));
  if (!row) return;
  cur = { oid: row._oid, editing: !!edit, loc: null, photos: null };
  render();
  loadPhotos();
  loadAuditPhotos();
}

export function closeDrawer() {
  if (cur?.loc) cur.loc.destroy();
  cur = null;
  $("#drawer-host").innerHTML = "";
}

export function refreshDrawer() {
  if (!cur) return;
  if (!S.invByOid.get(cur.oid)) return closeDrawer();
  if (cur.editing) return; // never clobber an in-progress edit
  render();
  paintPhotos();
  paintAudit();
}

const statusPill = (r) => {
  const s = String(r[I.status] || "");
  if (!s) return "";
  const cls = isRetired(r) ? "st-muted" : needsAttention(r) ? "st-pending" : "st-ok";
  return `<span class="status-pill ${cls}">${esc(s)}</span>`;
};

function render() {
  if (!cur) return;
  if (cur.loc) { cur.loc.destroy(); cur.loc = null; }
  const row = S.invByOid.get(cur.oid);
  const g = groupsFor(row);
  const assigned = row[I.assignedTo] ? userById(row[I.assignedTo]) : null;
  const assignedName = row[I.assignedTo] ? personName(row[I.assignedTo]) : "";
  const can = !S.readonly;
  const hist = historyFor(row[I.tag]);

  const assignCard = `
    <div class="card assign">
      <div class="sub" style="margin-bottom:.3rem">ASSIGNED TO</div>
      ${assignedName
        ? `<div class="who"><span class="av lg">${esc(initials(assignedName))}</span><div><b>${esc(assignedName)}</b>
             <div class="sub">${esc((assigned && assigned[CONFIG.USR.section]) || "")}${row[I.dateAssigned] ? ` · since ${esc(fmtYmd(row[I.dateAssigned]))}` : ""}</div></div></div>`
        : `<div class="unassigned">${isRetired(row) ? "Retired — not assignable" : "Not assigned"}</div>`}
      <div class="drawer-actions">
        ${can && g.assignment && !isRetired(row)
          ? assignedName
            ? `<button type="button" class="btn-sm" data-d="transfer">Transfer…</button><button type="button" class="btn-sm" data-d="return">Return to stock</button>`
            : `<button type="button" class="btn-sm btn-primary" data-d="assign">Assign…</button>`
          : ""}
        ${canConfirm(row) && !lastConfirmation(row) ? `<button type="button" class="btn-sm btn-primary" data-d="confirm">Yes, I have this</button>` : ""}
        ${canReport(row) ? `<button type="button" class="btn-sm" data-d="problem">I don't have this</button>` : ""}
        ${openReportFor(row) ? `<div class="sub" style="width:100%">${esc(openReportFor(row).reported_by)} says they don't have this item: ${esc(openReportFor(row).problem)}</div>` : ""}
        ${lastConfirmation(row) ? `<div class="sub" style="width:100%">Confirmed by ${esc(lastConfirmation(row).confirmed_by)} on ${esc(fmtYmd(lastConfirmation(row).confirmed_date))}</div>` : assignedName && S.problems.confUrl && !isRetired(row) ? `<div class="sub" style="width:100%">Not yet confirmed by ${esc(assignedName)}</div>` : ""}
      </div>
    </div>`;

  const details = cur.editing ? editForm(row, g) : `
    <div class="card">
      <dl class="kv">
        <dt>Category</dt><dd>${esc(row[I.category] || "—")}</dd>
        <dt>Property owner</dt><dd>${row[I.propertyOwner] ? esc(ownerName(row[I.propertyOwner])) : `<span class="sub">Not set</span>`}</dd>
        <dt>Make / model</dt><dd>${esc(itemMakeModel(row) || "—")}</dd>
        <dt>Serial</dt><dd>${esc(row[I.serial] || "—")}</dd>
        <dt>Location</dt><dd>${esc(placeText(row) || "—")}${row[I.address] ? `<div class="sub">${esc([row[I.address], row[I.city], row[I.state], row[I.zip]].filter(Boolean).join(", "))}</div>` : ""}</dd>
        ${row[I.description] ? `<dt>Description</dt><dd>${esc(row[I.description])}</dd>` : ""}
      </dl>
      ${can && canEditAnything(g) ? `<button type="button" class="btn-sm" data-d="edit" style="margin-top:.6rem">Edit details${g.identity ? "" : " / location"}</button>` : ""}
    </div>`;

  $("#drawer-host").innerHTML = `
    <div class="scrim" data-d="close"></div>
    <aside class="drawer" role="dialog" aria-label="Item details">
      <header>
        <div style="flex:1;min-width:0"><div class="mono sub">${esc(row[I.tag] || "(no tag)")}</div><h2>${esc(itemTitle(row))}</h2><div class="sub">${esc(itemMakeModel(row))}</div></div>
        ${statusPill(row)}<button type="button" class="icon-btn" data-d="close" aria-label="Close">&times;</button>
      </header>
      <div class="body">
        ${assignCard}
        ${details}
        <h3>Photos</h3>
        <div id="photo-grid" class="photo-grid"></div>
        <p class="sub" id="photo-note"></p>
        ${can && canEditAnything(g) ? `<label class="btn-like"><input type="file" id="photo-file" accept="image/*" multiple hidden />+ Add photo</label>` : ""}
        ${S.audit.url ? `<h3>Photo audits</h3><div id="audit-box"><span class="sub">Loading…</span></div>` : ""}
        <h3>History</h3>
        ${S.activity.url
          ? `<ul class="timeline">${hist.map((h) => `<li><b>${esc(h.activity_type)}</b>${h.to_name || h.from_name ? ` — ${h.activity_type === "Transferred" ? `${esc(h.from_name)} → ${esc(h.to_name)}` : esc(h.to_name || h.from_name)}` : ""}
              <div class="sub">${esc(fmtDateTime(h.activity_date))} · by ${esc(h.performed_by)}${h.note ? ` · ${esc(h.note)}` : ""}</div></li>`).join("") || `<li class="sub">No history recorded for this item yet.</li>`}</ul>`
          : `<p class="sub">History isn't set up yet (Settings → Log service).</p>`}
      </div>
      ${cur.editing ? `<footer><button type="button" data-d="cancel-edit">Cancel</button><button type="button" class="btn-primary" data-d="save">Save changes</button></footer>` : ""}
    </aside>`;

  if (cur.editing) {
    const form = $("#drawer-form");
    const fieldsets = form.querySelector("[data-loc]");
    if (fieldsets) cur.loc = mountLocation(fieldsets, row, { editable: g.location });
  }
  paintAudit();
}

function editForm(row, g) {
  const cats = categoryOptions();
  const stats = statusOptions();
  const idFields = `
    <fieldset ${g.identity ? "" : "disabled"}><legend>Item${g.identity ? "" : " (view only)"}</legend>
      <label>Tag number<input name="tag" value="${esc(row[I.tag])}" required maxlength="255" /></label>
      <div class="two-col"><label>Category<input name="category" list="dl-cat" value="${esc(row[I.category])}" /></label><label>Item<input name="item" value="${esc(row[I.item])}" /></label></div>
      <div class="two-col"><label>Make<input name="make" value="${esc(row[I.make])}" /></label><label>Model<input name="model" value="${esc(row[I.model])}" /></label></div>
      <div class="two-col"><label>Serial number<input name="serial" value="${esc(row[I.serial])}" /></label><label>Status<input name="status" list="dl-stat" value="${esc(row[I.status])}" /></label></div>
      <label>Description<textarea name="description" rows="2">${esc(row[I.description])}</textarea></label>
      <label>Property owner<select name="owner"><option value="">(not set)</option>${ownerOptions().map((o) => `<option value="${esc(o.code)}" ${String(row[I.propertyOwner] || "").toLowerCase() === String(o.code).toLowerCase() ? "selected" : ""}>${esc(o.name)}</option>`).join("")}</select></label>
      <datalist id="dl-cat">${cats.map((c) => `<option value="${esc(c)}">`).join("")}</datalist>
      <datalist id="dl-stat">${stats.map((c) => `<option value="${esc(c)}">`).join("")}</datalist>
    </fieldset>`;
  const locSet = g.location
    ? `<fieldset><legend>Location</legend><div data-loc>${locationFormHTML({ idp: "dl" })}</div></fieldset>` : "";
  return `<form id="drawer-form" class="card" onsubmit="return false">${idFields}${locSet}</form>`;
}

// ---------- events ----------
$("#drawer-host").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-d]");
  if (!b || !cur) return;
  const row = S.invByOid.get(cur.oid);
  switch (b.dataset.d) {
    case "close": return closeDrawer();
    case "assign": return openAssignDialog([row]);
    case "transfer": return openAssignDialog([row], { transfer: true });
    case "return": return openReturnDialog([row]);
    case "problem": return reportProblem(row);
    case "confirm": return confirmOne(row);
    case "edit": cur.editing = true; return render();
    case "cancel-edit": cur.editing = false; return render(), paintPhotos();
    case "save": return saveEdits(row, b);
    case "del-photo": return deletePhoto(Number(b.dataset.id), row);
    case "photo": return openLightbox(b.dataset.src);
  }
});
$("#drawer-host").addEventListener("change", async (e) => {
  if (e.target.id !== "photo-file" || !cur) return;
  const row = S.invByOid.get(cur.oid);
  const files = [...e.target.files];
  e.target.value = "";
  const note = $("#photo-note");
  try {
    for (let i = 0; i < files.length; i++) {
      note.textContent = `Uploading ${i + 1} of ${files.length}…`;
      await addAttachment(CONFIG.INVENTORY_LAYER_URL, row._oid, files[i]);
    }
    note.textContent = "";
    await loadPhotos();
    toast("Photo added.", "success");
  } catch (err) { note.textContent = ""; toast(err.message, "error", 8000); }
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && cur && !document.querySelector(".modal-backdrop")) { if ($("#lightbox") && !$("#lightbox").hidden) closeLightbox(); else closeDrawer(); } });

// ---------- save details ----------
async function saveEdits(row, btn) {
  const form = $("#drawer-form");
  const g = groupsFor(row);
  const attrs = {};
  let geometry;
  const notes = [];
  let statusNote = "", locNote = "";

  if (g.identity) {
    const v = (n) => form.elements.namedItem(n).value.trim();
    if (!v("tag")) return toast("Tag number is required.", "error");
    const dup = S.inv.find((r) => r !== row && String(r[I.tag] || "").trim().toLowerCase() === v("tag").toLowerCase());
    if (dup) return toast(`Tag ${v("tag")} is already used by another item.`, "error");
    const map = { tag: I.tag, category: I.category, item: I.item, make: I.make, model: I.model, serial: I.serial, status: I.status, description: I.description, owner: I.propertyOwner };
    const labels = { tag: "tag", category: "category", item: "item", make: "make", model: "model", serial: "serial", description: "description" };
    for (const [k, f] of Object.entries(map)) {
      if (v(k) !== String(row[f] ?? "").trim()) {
        attrs[f] = v(k);
        if (k === "owner") notes.push(`property owner: ${ownerName(row[f]) || "(none)"} → ${ownerName(v(k)) || "(none)"}`);
        else if (k === "status") statusNote = `${row[f] || "(none)"} → ${v(k) || "(none)"}`;
        else notes.push(`${labels[k]}: ${row[f] || "(none)"} → ${v(k) || "(none)"}`);
      }
    }
  }
  if (g.location && cur.loc) {
    const r = cur.loc.read();
    const locAttrs = {};
    for (const [f, val] of Object.entries(r.attrs)) {
      const old = row[f];
      const same = typeof val === "number" ? Number(old) === val : String(old ?? "") === String(val ?? "");
      if (!same) locAttrs[f] = val;
    }
    if (Object.keys(locAttrs).length) {
      Object.assign(attrs, locAttrs);
      if (r.geometry) geometry = r.geometry;
      locNote = [r.attrs[I.place], r.attrs[I.room], r.attrs[I.city]].filter(Boolean).join(", ") || r.attrs[I.region] || "updated";
    }
  }
  if (!Object.keys(attrs).length) { cur.editing = false; render(); paintPhotos(); return toast("No changes to save."); }

  btn.disabled = true;
  try {
    await updateInventory([{ row, attrs, geometry }]);
    const entries = [];
    if (statusNote) entries.push({ type: "Status changed", row, fromId: row[I.assignedTo] || "", note: statusNote });
    if (notes.length) entries.push({ type: "Edited", row, fromId: row[I.assignedTo] || "", note: notes.join("; ").slice(0, 480) });
    if (locNote) entries.push({ type: "Location updated", row, fromId: row[I.assignedTo] || "", note: locNote });
    await logAndWarn(entries);
    toast("Saved.", "success");
    cur.editing = false;
    S.actions.refresh();
    render(); paintPhotos();
  } catch (err) {
    toast(err.message, "error", 8000);
  } finally { btn.disabled = false; }
}

// ---------- photo audits (read-only, from the Inventory_Photo_Audit layer) ----------
const AUDIT_SHOWN = 5;
async function loadAuditPhotos() {
  if (!cur || !S.audit.url) return;
  const oid = cur.oid;
  const row = S.invByOid.get(oid);
  const list = auditsFor(row[I.tag]).slice(0, AUDIT_SHOWN);
  cur.audit = {};
  paintAudit();
  await Promise.all(list.map(async (a) => {
    try { const att = await listAttachments(S.audit.url, a._oid); if (cur && cur.oid === oid) cur.audit[a._oid] = att; }
    catch { if (cur && cur.oid === oid) cur.audit[a._oid] = []; }
  }));
  if (cur && cur.oid === oid) paintAudit();
}
function paintAudit() {
  const box = $("#audit-box");
  if (!box || !cur) return;
  const row = S.invByOid.get(cur.oid);
  const all = auditsFor(row[I.tag]);
  if (!all.length) { box.innerHTML = `<span class="sub">${row[I.tag] ? "No photo audit on record for this tag." : "This item has no tag, so audits can't be matched."}</span>`; return; }
  box.innerHTML = all.slice(0, AUDIT_SHOWN).map((a) => {
    const att = (cur.audit || {})[a._oid];
    const photos = att === undefined ? `<span class="sub">Loading photos…</span>`
      : att.map((p) => {
          const url = attachmentUrl(S.audit.url, a._oid, p.id);
          return /^image\//i.test(p.contentType || "")
            ? `<div class="photo"><button type="button" class="photo-btn" data-d="photo" data-src="${esc(url)}"><img src="${esc(url)}" alt="${esc(p.name || "audit photo")}" loading="lazy" /></button></div>`
            : `<div class="photo"><a class="photo-file" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(p.name || "file")}</a></div>`;
        }).join("") || `<span class="sub">No photos attached.</span>`;
    return `<div class="card" style="margin-bottom:.5rem"><b>${esc(fmtDateTime(a._when))}</b><div class="sub">Audited by ${esc(a._by || "unknown")}</div><div class="photo-grid" style="margin-top:.4rem">${photos}</div></div>`;
  }).join("") + (all.length > AUDIT_SHOWN ? `<p class="sub">${all.length - AUDIT_SHOWN} older audit(s) not shown.</p>` : "");
}

// ---------- photos ----------
async function loadPhotos() {
  if (!cur) return;
  const oid = cur.oid;
  try {
    const list = await listAttachments(CONFIG.INVENTORY_LAYER_URL, oid);
    if (cur && cur.oid === oid) { cur.photos = list; paintPhotos(); }
  } catch (err) {
    if (cur) { cur.photos = []; paintPhotos(); $("#photo-note") && ($("#photo-note").textContent = "Photos unavailable (attachments may be off for this layer)."); }
  }
}
function paintPhotos() {
  const grid = $("#photo-grid");
  if (!grid || !cur) return;
  const row = S.invByOid.get(cur.oid);
  const can = !S.readonly && canEditAnything(groupsFor(row));
  const list = cur.photos || [];
  grid.innerHTML = list.map((a) => {
    const url = attachmentUrl(CONFIG.INVENTORY_LAYER_URL, row._oid, a.id);
    const isImg = /^image\//i.test(a.contentType || "");
    return `<div class="photo">${isImg
      ? `<button type="button" class="photo-btn" data-d="photo" data-src="${esc(url)}"><img src="${esc(url)}" alt="${esc(a.name || "photo")}" loading="lazy" /></button>`
      : `<a class="photo-file" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(a.name || "file")}</a>`}
      ${can ? `<button type="button" class="photo-del" data-d="del-photo" data-id="${a.id}" aria-label="Delete photo">&times;</button>` : ""}</div>`;
  }).join("") || (cur.photos ? `<span class="sub">No photos yet.</span>` : `<span class="sub">Loading…</span>`);
}
async function deletePhoto(id, row) {
  if (!(await confirmDialog({ title: "Delete photo", message: "Delete this photo? This can't be undone.", confirmLabel: "Delete", kind: "danger" }))) return;
  try { await deleteAttachments(CONFIG.INVENTORY_LAYER_URL, row._oid, [id]); await loadPhotos(); toast("Photo deleted."); }
  catch (err) { toast(err.message, "error", 8000); }
}
function openLightbox(src) { const lb = $("#lightbox"); $("#lightbox-img").src = src; lb.hidden = false; }
function closeLightbox() { $("#lightbox").hidden = true; $("#lightbox-img").removeAttribute("src"); }
$("#lightbox").addEventListener("click", closeLightbox);
