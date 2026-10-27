// ---------------------------------------------------------------------------
// People tab + Add user. A person's page shows everything they hold, with
// Return buttons, and an "+ Assign item" shortcut. Property Officers can add and
// edit people; Managers get a read-only view.
// ---------------------------------------------------------------------------

import { CONFIG } from "./config.js";
import { esc, $, matchesSearch, debounce } from "./shared/util.js";
import { openModal, toast, confirmDialog } from "./shared/ui.js";
import { searchOrgMembers, listAttachments, attachmentUrl, addAttachment } from "./shared/esri-client.js";
import {
  S, I, U, fullName, initials, isUserActive, itemTitle, itemMakeModel, placeText, fmtYmd, sectionOptions, isRetired, reindexUsers,
} from "./state.js";
import { addUsers, updateUsers, userAttrs, updateInventory } from "./edits.js";
import { logAndWarn, activityFor } from "./activity.js";
import { openReturnDialog, openAssignDialog } from "./assign.js";
import { canEditPeople, hasSectionAccess } from "./permissions.js";

const P = { sel: null, q: "", filter: "all" };
const heldBy = (u) => S.inv.filter((r) => String(r[I.assignedTo] || "") === String(u[U.edison]));
const byName = (a, b) => (a[U.last] || fullName(a)).localeCompare(b[U.last] || fullName(b)) || fullName(a).localeCompare(fullName(b));

export function initPeople() {
  const el = $("#screen-ppl");
  el.addEventListener("input", debounce((e) => {
    if (e.target.id === "ppl-q") { P.q = e.target.value; renderList(); }
  }, 120));
  el.addEventListener("click", (e) => {
    const li = e.target.closest("[data-p]");
    if (li) { P.sel = li.dataset.p; return renderPeople(); }
    const f = e.target.closest("[data-pf]");
    if (f) { P.filter = f.dataset.pf; return renderPeople(); }
    const b = e.target.closest("[data-pa]");
    if (!b) return;
    const u = S.usersByEdison.get(P.sel);
    switch (b.dataset.pa) {
      case "add": return openAddUser();
      case "import": return S.actions.openImportUsers?.();
      case "assign": return openPickItems(u);
      case "return-all": return openReturnDialog(heldBy(u));
      case "return": { const r = S.invByOid.get(Number(b.dataset.oid)); return openReturnDialog([r]); }
      case "edit": return openEditUser(u);
      case "item": return S.actions.openDrawer?.(Number(b.dataset.oid));
    }
  });
  S.render.ppl = renderPeople;
}

function filteredUsers() {
  return S.users
    .filter((u) => matchesSearch([fullName(u), u[U.email], u[U.edison], u[U.section]], P.q))
    .filter((u) => {
      switch (P.filter) {
        case "managers": return [CONFIG.ROLE_MANAGER, CONFIG.ROLE_PROPERTY_OFFICER].includes(u[U.permissions]) || hasSectionAccess(u);
        case "none": return isUserActive(u) && heldBy(u).length === 0;
        case "inactive": return !isUserActive(u);
        default: return true;
      }
    })
    .sort(byName);
}

export function renderPeople() {
  const el = $("#screen-ppl");
  const edit = canEditPeople(S.me) && !S.readonly;
  if (!el.querySelector(".ent-layout")) {
    el.innerHTML = `
      <div class="toolbar"><h2>People</h2><span class="spacer"></span>
        ${edit ? `<button type="button" data-pa="import">Import CSV</button><button type="button" class="btn-primary" data-pa="add">+ Add user</button>` : ""}</div>
      <div class="ent-layout">
        <aside class="ent-side">
          <div class="pill-row" id="ppl-filters"></div>
          <input id="ppl-q" type="search" placeholder="Find a person…" aria-label="Find a person" autocomplete="off" />
          <ul class="ent-list" id="ppl-list"></ul>
        </aside>
        <section class="ent-detail" id="ppl-detail"></section>
      </div>`;
  }
  $("#ppl-filters").innerHTML = [["all", "Everyone"], ["managers", "Managers"], ["none", "With no items"], ["inactive", "Inactive"]]
    .map(([k, l]) => `<button type="button" class="pill${P.filter === k ? " active" : ""}" data-pf="${k}">${l}</button>`).join("");
  renderList();
  renderDetail();
}

function renderList() {
  const list = filteredUsers();
  if (!P.sel || !S.usersByEdison.get(P.sel)) P.sel = list[0] ? String(list[0][U.edison]) : null;
  $("#ppl-list").innerHTML = list.map((u) => {
    const n = heldBy(u).length;
    return `<li><button type="button" class="ent-item${String(u[U.edison]) === P.sel ? " active" : ""}" data-p="${esc(u[U.edison])}">
      <span><b>${esc(fullName(u)) || "(no name)"}</b></span><span class="pill-n">${isUserActive(u) ? n : "inactive"}</span>
      <span class="sub">${esc(u[U.section] || "No section")}</span></button></li>`;
  }).join("") || `<li class="empty">No one matches.</li>`;
}

function renderDetail() {
  const host = $("#ppl-detail");
  const u = P.sel ? S.usersByEdison.get(P.sel) : null;
  if (!u) { host.innerHTML = `<p class="empty">Select a person.</p>`; return; }
  const held = heldBy(u).sort((a, b) => String(a[I.tag]).localeCompare(String(b[I.tag])));
  const active = isUserActive(u);
  const edit = canEditPeople(S.me) && !S.readonly;
  const assign = !S.readonly && active;
  const hist = S.activity.url ? activityFor(u[U.edison]).slice(0, 8) : [];
  host.innerHTML = `
    <div class="ent-head">
      <div class="who" style="gap:.8rem"><span class="av lg">${esc(initials(fullName(u)))}</span>
        <div><h2>${esc(fullName(u))}</h2><div class="sub">${esc(u[U.email] || "no email")} · Edison ${esc(u[U.edison])}</div></div></div>
      <div style="display:flex;gap:.4rem;flex-wrap:wrap">
        ${assign ? `<button type="button" class="btn-primary" data-pa="assign">+ Assign item</button>` : ""}
        ${assign && held.length ? `<button type="button" data-pa="return-all">Return all</button>` : ""}
        ${edit ? `<button type="button" data-pa="edit">Edit person</button>` : ""}
      </div></div>
    <div class="pill-row" style="margin-bottom:.6rem"><span class="tag">${esc(u[U.permissions] || "No role")}</span><span class="tag tag-muted">${esc(u[U.section] || "No section")}</span>${hasSectionAccess(u) ? `<span class="tag">Section access</span>` : ""}${active ? "" : `<span class="tag tag-restricted">Inactive</span>`}</div>
    ${!active && held.length ? `<div class="banner banner-warn">This person is inactive but still holds ${held.length} item(s).${assign || edit ? ` <button type="button" class="btn-sm" data-pa="return-all">Return them all</button>` : ""}</div>` : ""}
    <h3>Items held (${held.length})</h3>
    <div class="table-wrap"><table class="grid"><thead><tr><th>Tag</th><th>Item</th><th>Since</th><th>Location</th><th></th></tr></thead><tbody>
      ${held.map((r) => `<tr tabindex="0"><td class="mono"><a href="#" data-pa="item" data-oid="${r._oid}">${esc(r[I.tag] || "—")}</a></td><td>${esc(itemTitle(r))} <span class="sub">${esc(itemMakeModel(r))}</span></td>
        <td>${esc(fmtYmd(r[I.dateAssigned]))}</td><td class="sub">${esc(placeText(r))}</td>
        <td class="row-actions">${!S.readonly ? `<button type="button" data-pa="return" data-oid="${r._oid}">Return</button>` : ""}</td></tr>`).join("")
        || `<tr><td colspan="5" class="empty">Nothing assigned.</td></tr>`}
    </tbody></table></div>
    ${hist.length ? `<h3>Recent activity</h3><ul class="timeline">${hist.map((h) => `<li><b>${esc(h.activity_type)}</b> — ${esc(h.tag_number)} ${esc(h.item_desc)}<div class="sub">${new Date(h.activity_date).toLocaleDateString()} · by ${esc(h.performed_by)}${h.note ? ` · ${esc(h.note)}` : ""}</div></li>`).join("")}</ul>` : ""}`;
}

// ---------- assign from the person side ----------
function openPickItems(u) {
  const avail = S.inv.filter((r) => !r[I.assignedTo] && !isRetired(r) && (r[I.tag] || r[I.item]));
  const m = openModal({
    title: `Assign items to ${fullName(u)}`,
    body: `<input id="pk-q" type="search" placeholder="Filter available items…" style="width:100%;margin-bottom:.6rem" autocomplete="off" />
      <div class="sel-list tall" id="pk-list"></div><p class="sub" id="pk-count"></p>`,
    buttons: [
      { label: "Cancel" },
      {
        label: "Continue", kind: "primary",
        action: (mm) => {
          const oids = [...mm.el.querySelectorAll("#pk-list input:checked")].map((c) => Number(c.value));
          if (!oids.length) throw new Error("Tick at least one item.");
          const rows = oids.map((o) => S.invByOid.get(o));
          setTimeout(() => openAssignDialog(rows, { person: u }), 0);
        },
      },
    ],
  });
  const paint = () => {
    const q = m.el.querySelector("#pk-q").value;
    const rows = avail.filter((r) => matchesSearch([r[I.tag], r[I.item], r[I.make], r[I.model], r[I.category], r[I.serial]], q)).slice(0, 200);
    m.el.querySelector("#pk-list").innerHTML = rows.map((r) => `<label class="check" style="margin:.15rem 0"><input type="checkbox" value="${r._oid}" /> <span class="mono">${esc(r[I.tag] || "—")}</span> ${esc(itemTitle(r))} <span class="sub">${esc(itemMakeModel(r))}</span></label>`).join("") || `<span class="sub">Nothing available.</span>`;
    m.el.querySelector("#pk-count").textContent = `${avail.length} item(s) available`;
  };
  m.el.querySelector("#pk-q").addEventListener("input", debounce(paint, 100));
  paint();
}

// ---------- add user ----------
export function openAddUser(prefillText = "", done = null) {
  if (!canEditPeople(S.me) || S.readonly) return toast("Only a Property Officer can add users.", "error");
  const guess = splitName(prefillText);
  const m = openModal({
    title: "Add user",
    body: `
      <label>Find in ArcGIS Online <span class="hint">(optional — fills in name and email)</span>
        <div class="combo"><input id="au-find" placeholder="Start typing a name or email…" autocomplete="off" /><ul id="au-found" hidden></ul></div></label>
      <div class="two-col">
        <label>First name<input id="au-first" value="${esc(guess.first)}" /></label>
        <label>Last name<input id="au-last" value="${esc(guess.last)}" /></label>
        <label>Email<input id="au-email" type="email" /></label>
        <label>Edison ID<input id="au-edison" /></label>
        <label>Section<select id="au-section"><option value="">—</option>${sectionOptions().map((s) => `<option>${esc(s)}</option>`).join("")}</select></label>
        <label>Role<select id="au-role">${CONFIG.ROLES.map((r) => `<option>${esc(r)}</option>`).join("")}</select></label>
      </div>
      <label>Supervisor <span class="hint">(optional — pick a name)</span>
        <select id="au-sup"><option value="">—</option>${S.users.filter(isUserActive).sort(byName).map((x) => `<option value="${esc(x[U.edison])}">${esc(fullName(x))}</option>`).join("")}</select></label>`,
    buttons: [
      { label: "Cancel" },
      { label: "Save & add another", close: false, action: (mm) => save(mm, true) },
      { label: "Save", kind: "primary", close: false, action: (mm) => save(mm, false) },
    ],
  });
  const g = (id) => m.el.querySelector("#" + id);
  const find = g("au-find"), found = g("au-found");
  const search = debounce(async () => {
    const hits = await searchOrgMembers(find.value);
    found.innerHTML = hits.map((h, i) => `<li data-i="${i}"><span class="av">${esc(initials(h.fullName))}</span><span>${esc(h.fullName)}<br><span class="sub">${esc(h.email || h.username)}</span></span></li>`).join("");
    found.hidden = !hits.length;
    found._hits = hits;
  }, 300);
  find.addEventListener("input", search);
  found.addEventListener("mousedown", (e) => {
    const li = e.target.closest("[data-i]");
    if (!li) return;
    e.preventDefault();
    const h = found._hits[Number(li.dataset.i)];
    const n = splitName(h.fullName);
    g("au-first").value = n.first; g("au-last").value = n.last; g("au-email").value = h.email || "";
    find.value = h.fullName; found.hidden = true;
    (h.email ? g("au-edison") : g("au-email")).focus();
  });
  find.addEventListener("blur", () => setTimeout(() => (found.hidden = true), 150));

  async function save(mm, again) {
    const v = { first: g("au-first").value, last: g("au-last").value, email: g("au-email").value, edison: g("au-edison").value,
      section: g("au-section").value, role: g("au-role").value, supervisor: g("au-sup").value };
    const problem = validateUser(v, null);
    if (problem) throw new Error(problem);
    const [row] = await addUsers([userAttrs(v)]);
    await logAndWarn([{ type: "User added", tag: "", desc: `${fullName(row)} (${v.role})`, toId: v.edison, note: v.section }]);
    toast(`Added ${fullName(row)}.`, "success");
    S.actions.refresh();
    m.close();
    if (done) done(row);
    else if (again) openAddUser();
    return false;
  }
  return m;
}
S.actions.openAddUser = openAddUser;

function splitName(text) {
  const parts = String(text || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return { first: parts[0] || "", last: "" };
  return { first: parts.slice(0, -1).join(" "), last: parts[parts.length - 1] };
}

/** Returns an error message, or "" when the person data is acceptable. `existing` = the row being edited. */
export function validateUser(v, existing) {
  if (!String(v.edison || "").trim()) return "Edison ID is required.";
  if (!String(v.first || "").trim() && !String(v.last || "").trim()) return "Enter a name.";
  const dupId = S.users.find((u) => u !== existing && String(u[U.edison]).trim() === String(v.edison).trim());
  if (dupId) return `Edison ID ${v.edison} already belongs to ${fullName(dupId)}.`;
  const email = String(v.email || "").trim().toLowerCase();
  if (email) {
    const dupEmail = S.users.find((u) => u !== existing && String(u[U.email] || "").trim().toLowerCase() === email);
    if (dupEmail) return `${v.email} is already used by ${fullName(dupEmail)}.`;
  }
  if (v.supervisor && String(v.supervisor) === String(v.edison)) return "A person can't be their own supervisor.";
  return "";
}

// ---------- edit user ----------
function openEditUser(u) {
  const m = openModal({
    title: `Edit ${fullName(u)}`,
    body: `
      <div class="two-col">
        <label>First name<input id="eu-first" value="${esc(u[U.first])}" /></label>
        <label>Last name<input id="eu-last" value="${esc(u[U.last])}" /></label>
        <label>Email<input id="eu-email" type="email" value="${esc(u[U.email])}" /></label>
        <label>Edison ID<input id="eu-edison" value="${esc(u[U.edison])}" /></label>
        <label>Section<select id="eu-section"><option value="">—</option>${sectionOptions().map((s) => `<option ${s === u[U.section] ? "selected" : ""}>${esc(s)}</option>`).join("")}</select></label>
        <label>Role<select id="eu-role">${CONFIG.ROLES.map((r) => `<option ${r === u[U.permissions] ? "selected" : ""}>${esc(r)}</option>`).join("")}</select></label>
      </div>
      <label>Supervisor<select id="eu-sup"><option value="">—</option>${S.users.filter((x) => x !== u && (isUserActive(x) || String(x[U.edison]) === String(u[U.supervisor]))).sort(byName).map((x) => `<option value="${esc(x[U.edison])}" ${String(x[U.edison]) === String(u[U.supervisor]) ? "selected" : ""}>${esc(fullName(x))}</option>`).join("")}</select></label>
      <label class="check"><input type="checkbox" id="eu-active" ${isUserActive(u) ? "checked" : ""} /> Active</label>
      ${S.usersHasAccessField ? `<label class="check"><input type="checkbox" id="eu-secacc" ${hasSectionAccess(u) ? "checked" : ""} /> <span>Section inventory access: can assign, transfer, return, update and <b>add</b> inventory for their section and direct reports</span></label>` : ""}
      <details class="more"><summary>Other info (notes, image, QR code)</summary>
        <label style="margin-top:.6rem">Notes<textarea id="eu-desc" rows="2">${esc(u[U.description])}</textarea></label>
        <label>Image URL<input id="eu-img" value="${esc(u[U.imageUrl])}" /></label>
        <div><span class="hint">QR code</span><img id="eu-qr" class="qr-preview" alt="QR code" hidden /><input type="file" id="eu-qr-file" accept="image/*" /></div>
      </details>`,
    buttons: [
      { label: "Cancel" },
      {
        label: "Save", kind: "primary",
        action: async (mm) => {
          const g = (id) => mm.el.querySelector("#" + id);
          const v = { first: g("eu-first").value, last: g("eu-last").value, email: g("eu-email").value, edison: g("eu-edison").value,
            section: g("eu-section").value, role: g("eu-role").value, supervisor: g("eu-sup").value, active: g("eu-active").checked };
          const problem = validateUser(v, u);
          if (problem) throw new Error(problem);
          const wasActive = isUserActive(u);
          const oldId = String(u[U.edison]);
          if (g("eu-secacc")) v.sectionAccess = g("eu-secacc").checked;
          v.description = g("eu-desc").value;
          v.imageUrl = g("eu-img").value;
          const attrs = userAttrs(v);
          const qrFile = g("eu-qr-file").files[0];
          const held = heldBy(u);
          // Changing an Edison ID would orphan assignments: carry them over in the same save.
          if (String(attrs[U.edison]) !== oldId && held.length) {
            await updateInventory(held.map((row) => ({ row, attrs: { [I.assignedTo]: attrs[U.edison] } })));
          }
          await updateUsers([{ row: u, attrs }]);
          if (qrFile) {
            try { await addAttachment(CONFIG.USERS_LAYER_URL, u._oid, qrFile); } catch (e) { toast(`Saved, but the QR code image failed: ${e.message}`, "error", 8000); }
          }
          await logAndWarn([{ type: "User changed", tag: "", desc: `${fullName(u)} (${v.role})`, toId: attrs[U.edison], note: v.active === false ? "Marked inactive" : "" }]);
          toast("Saved.", "success");
          P.sel = String(attrs[U.edison]);
          S.actions.refresh();
          if (wasActive && v.active === false) {
            const still = heldBy(u);
            if (still.length) {
              const yes = await confirmDialog({ title: "Return their items?", message: `${fullName(u)} is now inactive but still holds ${still.length} item(s). Return them to stock now?`, confirmLabel: "Return items" });
              if (yes) setTimeout(() => openReturnDialog(still, { reason: "Person marked inactive" }), 0);
            }
          }
        },
      },
    ],
  });
  // show the current QR code image, if the person has one
  listAttachments(CONFIG.USERS_LAYER_URL, u._oid).then((atts) => {
    const qr = atts.find((a) => /qr/i.test(a.name || "")) || atts.find((a) => /^image\//i.test(a.contentType || ""));
    const img = m.el.querySelector("#eu-qr");
    if (qr && img) { img.src = attachmentUrl(CONFIG.USERS_LAYER_URL, u._oid, qr.id); img.hidden = false; }
  }).catch(() => {});
  return m;
}
