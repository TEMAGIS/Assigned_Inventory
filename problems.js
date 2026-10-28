// ---------------------------------------------------------------------------
// "I don't have this" reports and inventory confirmations. A small separate
// service (TEMA_Assigned_Inventory_Problems, two tables) that EVERYONE may add
// to, including people who only have the view-only copies of the inventory.
//
//   Problems      one row per "I don't have this" report from a holder
//   Confirmations one row per item a holder confirms is correct
//
// Property staff don't handle repairs or other issues, so there is nothing
// else to report. Reports never change the inventory by themselves; a Property
// Officer works them on the Corrections tab and may return the item to stock.
// ---------------------------------------------------------------------------

import { CONFIG } from "./config.js";
import { esriRequest, queryAll, applyEdits, tableUrl, findServicesByTitle, itemServiceUrl, checkFieldNames } from "./shared/esri-client.js";
import { PROBLEMS_TABLE, CONFIRMATIONS_TABLE, fieldNames } from "./schema.js";
import { $, esc, newTxnId, fmtDateTime, matchesSearch, debounce } from "./shared/util.js";
import { toast, openModal } from "./shared/ui.js";
import { S, I, U, fullName, itemTitle, itemMakeModel, isRetired, personName, todayYmd, ymdToMs } from "./state.js";
import { personPicker, rememberAssignee } from "./pickers.js";
import { isPropertyOfficer, canWorkCorrections, ownsItem } from "./permissions.js";
import { updateInventory } from "./edits.js";
import { logAndWarn, createHostedService, addTablesToService } from "./activity.js";

// ---------------------------------------------------------------- discovery / loading
export async function discoverProblems() {
  const P = S.problems;
  P.url = P.confUrl = P.serviceUrl = P.error = "";
  try {
    let svc = (CONFIG.PROBLEMS_SERVICE_URL || "").replace(/\/+$/, "");
    if (!svc && CONFIG.PROBLEMS_ITEM_ID) { try { svc = await itemServiceUrl(CONFIG.PROBLEMS_ITEM_ID); } catch (e) { console.info("[problems] item lookup failed:", e.message); } }
    if (!svc) {
      const hits = await findServicesByTitle(CONFIG.PROBLEMS_SERVICE_TITLE);
      if (hits.length) svc = String(hits[0].url || "").replace(/\/+$/, "");
    }
    if (!svc) return P;
    const info = await esriRequest(svc, {}, { method: "GET" });
    const t = (info.tables || []).find((x) => String(x.name).toLowerCase() === PROBLEMS_TABLE.name.toLowerCase());
    P.serviceUrl = svc;
    const c = (info.tables || []).find((x) => String(x.name).toLowerCase() === CONFIRMATIONS_TABLE.name.toLowerCase());
    if (c) P.confUrl = tableUrl(svc, c.id);
    if (t) P.url = tableUrl(svc, t.id); else P.error = `Found the service but it has no “${PROBLEMS_TABLE.name}” table.`;
  } catch (err) {
    P.error = err.message;
    console.warn("[problems] could not locate the problems service:", err);
  }
  return P;
}

export async function loadProblems() {
  const P = S.problems;
  P.rows = []; P.conf = []; P.ready = false;
  if (!P.url) return;
  try {
    P.rows = await queryAll(P.url, { pageSize: CONFIG.FETCH_PAGE_SIZE });
    P.ready = true;
    checkFieldNames(P.url, "Problems", fieldNames(PROBLEMS_TABLE));
  } catch (err) {
    P.error = `Could not read the Problems table: ${err.message}`;
    console.warn(P.error);
  }
  if (P.confUrl) {
    try {
      P.conf = await queryAll(P.confUrl, { pageSize: CONFIG.FETCH_PAGE_SIZE });
      checkFieldNames(P.confUrl, "Confirmations", fieldNames(CONFIRMATIONS_TABLE));
    } catch (err) { console.warn("Could not read the Confirmations table:", err.message); P.confUrl = ""; }
  }
}

export async function loadProblemsAll() { await discoverProblems(); await loadProblems(); }

// ---------------------------------------------------------------- helpers
export const isOpenReport = (p) => String(p.status || "Open") !== "Resolved";
/** Reports this person may work: all for an Inventory Administrator, else those on items owned by their sections. */
export const myReports = () => {
  if (isPropertyOfficer(S.me)) return S.problems.rows;
  return S.problems.rows.filter((p) => {
    const row = S.inv.find((r) => r[I.tag] && String(r[I.tag]) === String(p.tag_number));
    return !!row && ownsItem(S.me, row);
  });
};
export const openReports = () => myReports().filter(isOpenReport);
export const openReportFor = (row) => S.problems.rows.find((p) => isOpenReport(p) && String(p.tag_number || "") === String(row[I.tag] || "") && row[I.tag]);
const isMine = (row) => S.me && row[I.assignedTo] && String(row[I.assignedTo]) === String(S.me[U.edison]);
const settled = () => !(S.readonly && !S.viewOnly); // a ?readonly=1 link can't write anything

/** The holder may say "I don't have this" once per item until an Inventory Administrator answers. */
export function canReport(row) {
  if (!S.me || isRetired(row) || !settled() || !isMine(row)) return false;
  return !!S.problems.url && !openReportFor(row);
}

/** The holder may confirm an item that has no open "I don't have this" report. */
export function canConfirm(row) {
  if (!S.me || isRetired(row) || !settled() || !isMine(row)) return false;
  return !!S.problems.confUrl && !openReportFor(row);
}

/** Latest confirmation for this item by its current holder, made since it was assigned. */
export function lastConfirmation(row) {
  if (!row[I.tag] || !row[I.assignedTo]) return null;
  const since = Number(row[I.dateAssigned]) || 0;
  let best = null;
  for (const c of S.problems.conf) {
    if (String(c.tag_number || "") !== String(row[I.tag]) || String(c.confirmed_by_edison_id || "") !== String(row[I.assignedTo])) continue;
    if ((c.confirmed_date || 0) < since) continue;
    if (!best || c.confirmed_date > best.confirmed_date) best = c;
  }
  return best;
}
export const isConfirmed = (row) => !!lastConfirmation(row);

const who = () => ({
  by: (fullName(S.me) || S.profile?.fullName || "").slice(0, 150),
  id: String(S.me[U.edison] || "").slice(0, 40),
  email: String(S.me[U.email] || S.profile?.email || "").toLowerCase().slice(0, 150),
  section: String(S.me[U.section] || "").slice(0, 80),
});
const descOf = (row) => [itemTitle(row), itemMakeModel(row)].filter(Boolean).join(" · ").slice(0, 255);

const reportAttrs = (row, note) => {
  const w = who();
  return {
    report_id: newTxnId().replace(/^TXN/, "PRB"),
    tag_number: String(row[I.tag] || "").slice(0, 255),
    item_desc: descOf(row),
    category: String(row[I.category] || "").slice(0, 60),
    problem: note.slice(0, 500),
    report_date: Date.now(),
    reported_by: w.by, reported_by_edison_id: w.id, reported_by_email: w.email, reported_by_section: w.section,
    holder_name: row[I.assignedTo] ? personName(row[I.assignedTo]).slice(0, 150) : "",
    status: "Open",
  };
};

// ---------------------------------------------------------------- confirm my inventory
/** Records "yes, I have this" for each row. */
export async function confirmItems(rows) {
  const list = rows.filter(canConfirm);
  if (!list.length) throw new Error("Nothing to confirm.");
  const w = who(), now = Date.now();
  const adds = list.map((row, i) => ({
    attributes: {
      confirmation_id: newTxnId().replace(/^TXN/, "CNF") + "-" + (i + 1),
      tag_number: String(row[I.tag] || "").slice(0, 255),
      item_desc: descOf(row),
      category: String(row[I.category] || "").slice(0, 60),
      confirmed_date: now,
      confirmed_by: w.by, confirmed_by_edison_id: w.id, confirmed_by_email: w.email, confirmed_by_section: w.section,
    },
  }));
  const res = await applyEdits(S.problems.confUrl, { adds });
  adds.forEach((a, i) => S.problems.conf.push({ ...a.attributes, _oid: res.addResults?.[i]?.objectId, OBJECTID: res.addResults?.[i]?.objectId }));
  return list.length;
}

export async function confirmOne(row) {
  try { await confirmItems([row]); toast("Thanks — confirmed.", "success"); S.actions.refresh(); }
  catch (err) { toast(`Couldn't save your confirmation: ${err.message}`, "error", 8000); }
}

export function confirmAll(rows) {
  const list = rows.filter(canConfirm);
  if (!list.length) return toast("Nothing left to confirm.", "info");
  openModal({
    title: `Confirm ${list.length} item${list.length > 1 ? "s" : ""}`,
    body: `<p class="sub" style="margin-top:0">You're saying that you have each of these.</p>
      <div class="sel-list">${list.map((r) => `<div class="sel-line"><span class="mono">${esc(r[I.tag] || "—")}</span> ${esc(itemTitle(r))}</div>`).join("")}</div>
      <p class="sub">If one of them isn't with you, cancel and use “I don't have this” on that item first.</p>`,
    buttons: [
      { label: "Cancel" },
      {
        label: `Yes, I have these`, kind: "primary",
        action: async () => { const n = await confirmItems(list); toast(`${n} item${n > 1 ? "s" : ""} confirmed.`, "success"); S.actions.refresh(); },
      },
    ],
  });
}

// ---------------------------------------------------------------- "I don't have this"
export function reportProblem(row) {
  openModal({
    title: `I don't have this: ${itemTitle(row)}`,
    body: `<p class="sub" style="margin-top:0"><span class="mono">${esc(row[I.tag] || "")}</span> is listed as yours. This tells the Inventory Administrators you don't have it, so they can correct the record.</p>
      <label>What happened? <span class="hint">(helps them find it)</span><textarea id="pb-note" rows="3" maxlength="500" placeholder="e.g. returned it to supply in March; moved to Jane Smith; never received it"></textarea></label>`,
    buttons: [
      { label: "Cancel" },
      {
        label: "Send to the Inventory team", kind: "primary",
        action: async (m) => {
          const note = m.el.querySelector("#pb-note").value.trim();
          if (!note) throw new Error("Please say what happened to it.");
          if (!S.problems.url) throw new Error("Reporting isn't set up yet. Ask an Inventory Administrator.");
          const attrs = reportAttrs(row, note);
          const res = await applyEdits(S.problems.url, { adds: [{ attributes: attrs }] });
          S.problems.rows.push({ ...attrs, _oid: res.addResults?.[0]?.objectId, OBJECTID: res.addResults?.[0]?.objectId });
          toast("Sent. The Inventory Administrators will correct your list.", "success");
          S.actions.refresh();
        },
      },
    ],
  });
}

// ---------------------------------------------------------------- Problems tab (Inventory Administrator)
const PF = { status: "open", q: "" };

export function initProblems() {
  const el = $("#screen-prob");
  el.addEventListener("input", debounce((e) => { if (e.target.id === "pr-q") { PF.q = e.target.value; renderRows(); } }, 150));
  el.addEventListener("change", (e) => { if (e.target.id === "pr-status") { PF.status = e.target.value; renderRows(); } });
  el.addEventListener("click", (e) => {
    const t = e.target.closest("[data-tag]");
    if (t) { e.preventDefault(); return S.actions.openItemByTag?.(t.dataset.tag); }
    const b = e.target.closest("[data-pr]");
    if (!b) return;
    const p = S.problems.rows.find((x) => String(x._oid) === b.dataset.id);
    if (!p) return;
    if (b.dataset.pr === "resolve") return resolveDialog(p);
  });
  S.render.prob = renderProblems;
}

export function renderProblems() {
  const el = $("#screen-prob");
  const P = S.problems;
  if (!canWorkCorrections(S.me)) { el.innerHTML = `<p class="empty">Only Inventory Administrators and property owners can work the corrections list.</p>`; return; }
  if (!P.url) {
    el.innerHTML = `<div class="banner banner-warn" style="flex-direction:column;align-items:flex-start"><b>Corrections and confirmations aren't set up yet.</b>
      <span>${esc(P.error || "")} Create the service in <b>Settings → Confirmations &amp; corrections</b> (takes a few seconds).</span></div>`;
    return;
  }
  el.innerHTML = `<div class="toolbar">
      <input id="pr-q" type="search" placeholder="Search tag, person, note…" value="${esc(PF.q)}" aria-label="Search corrections" autocomplete="off" />
      <select id="pr-status" aria-label="Show"><option value="open" ${PF.status === "open" ? "selected" : ""}>Waiting</option><option value="resolved" ${PF.status === "resolved" ? "selected" : ""}>Resolved</option><option value="all" ${PF.status === "all" ? "selected" : ""}>All</option></select>
      <span class="spacer"></span><span id="pr-count" class="sub"></span></div>
    <div class="table-wrap tall"><table class="grid"><thead><tr><th>Reported</th><th>Tag</th><th>Item</th><th>Holder who says they don't have it</th><th>What they said</th><th>Status</th><th></th></tr></thead><tbody id="pr-body"></tbody></table></div>`;
  renderRows();
}

function renderRows() {
  const body = $("#pr-body");
  if (!body) return;
  const all = myReports();
  const rows = all
    .filter((p) => (PF.status === "all" || (PF.status === "open" ? isOpenReport(p) : !isOpenReport(p)))
      && matchesSearch([p.tag_number, p.item_desc, p.reported_by, p.problem, p.resolution, p.holder_name], PF.q))
    .sort((a, b) => (b.report_date || 0) - (a.report_date || 0));
  $("#pr-count").textContent = `${rows.length} of ${all.length}`;
  body.innerHTML = rows.slice(0, 500).map((p) => `<tr>
    <td>${esc(fmtDateTime(p.report_date))}</td>
    <td><a href="#" class="mono" data-tag="${esc(p.tag_number)}">${esc(p.tag_number)}</a></td>
    <td>${esc(p.item_desc)}</td>
    <td>${esc(p.reported_by)}<div class="sub">${esc(p.reported_by_section || "")}</div></td>
    <td>${esc(p.problem)}${p.resolution ? `<div class="sub">Corrected: ${esc(p.resolution)}${p.resolved_by ? ` — ${esc(p.resolved_by)}` : ""}</div>` : ""}</td>
    <td><span class="status-pill ${isOpenReport(p) ? "st-bad" : "st-ok"}">${esc(p.status || "Open")}</span></td>
    <td class="row-actions">${isOpenReport(p) ? `<button type="button" class="btn-primary" data-pr="resolve" data-id="${esc(p._oid)}">Correct…</button>` : ""}</td></tr>`).join("")
    || `<tr><td colspan="7" class="empty">Nothing here.</td></tr>`;
}

async function updateReport(p, attrs) {
  await applyEdits(S.problems.url, { updates: [{ attributes: { OBJECTID: p._oid, ...attrs } }] });
  Object.assign(p, attrs);
}

function resolveDialog(p) {
  const row = S.inv.find((r) => r[I.tag] && String(r[I.tag]) === String(p.tag_number));
  const holder = row && row[I.assignedTo] && String(row[I.assignedTo]) === String(p.reported_by_edison_id);
  const canMove = !!row && !isRetired(row);
  let person = null;
  const radio = (v, label, checked) => `<label class="check"><input type="radio" name="rs-act" value="${v}" ${checked ? "checked" : ""} /> <span>${label}</span></label>`;
  const m = openModal({
    title: `Correct: ${p.item_desc || p.tag_number}`,
    body: `<p class="sub" style="margin-top:0"><b>${esc(p.tag_number)}</b> — ${esc(p.reported_by)} says they don't have it: “${esc(p.problem)}”</p>
      ${holder ? "" : `<p class="sub">${row ? `It is no longer assigned to ${esc(p.reported_by)}${row[I.assignedTo] ? `; it is now with ${esc(personName(row[I.assignedTo]))}` : ""}.` : "The item wasn't found."}</p>`}
      <fieldset class="owner-pick"><legend>What happened to it?</legend>
        ${holder ? radio("return", `Return it to stock (remove it from ${esc(p.reported_by)}'s inventory)`, true) : ""}
        ${canMove ? radio("transfer", holder ? "Transfer it to someone else" : (row[I.assignedTo] ? "Transfer it to someone else" : "Assign it to someone"), false) : ""}
        ${radio("none", "Nothing to change in the inventory, just close the report", !holder)}
      </fieldset>
      <div id="rs-xfer" hidden>
        <label>Transfer to<div id="rs-person"></div></label>
        <div id="rs-card"></div>
        <label>Date assigned<input type="date" id="rs-date" value="${todayYmd()}" /></label>
      </div>
      <label>What was done? <span class="hint" id="rs-hint"></span><textarea id="rs-note" rows="3" maxlength="500" placeholder="e.g. found it with Jane Smith; confirmed returned in March"></textarea></label>`,
    buttons: [
      { label: "Cancel" },
      {
        label: "Mark corrected", kind: "primary",
        action: async (mm) => {
          const act = mm.el.querySelector('input[name="rs-act"]:checked')?.value || "none";
          let note = mm.el.querySelector("#rs-note").value.trim();
          if (act === "none" && !note) throw new Error("Please say what was done.");
          const prev = row && row[I.assignedTo] ? String(row[I.assignedTo]) : "";
          if (act === "return") {
            if (!note) note = `Returned to stock (${p.reported_by} reported not having it)`;
            await updateInventory([{ row, attrs: { [I.assignedTo]: null, [I.dateAssigned]: null } }]);
            await logAndWarn([{ type: "Returned", row, fromId: prev, note: `Reported not held: ${note}` }]);
          } else if (act === "transfer") {
            if (!person) throw new Error("Pick who it is going to.");
            const toId = String(person[U.edison]);
            if (toId === prev) throw new Error(`${fullName(person)} already has it.`);
            const ymd = mm.el.querySelector("#rs-date").value;
            if (!note) note = `Transferred to ${fullName(person)} (${p.reported_by} reported not having it)`;
            await updateInventory([{ row, attrs: { [I.assignedTo]: toId, [I.dateAssigned]: ymd ? ymdToMs(ymd) : null } }]);
            rememberAssignee(toId);
            await logAndWarn([{ type: prev ? "Transferred" : "Assigned", row, fromId: prev, toId, note: `Reported not held: ${note}` }]);
          }
          await updateReport(p, { status: "Resolved", resolved_by: fullName(S.me), resolved_date: Date.now(), resolution: note.slice(0, 500) });
          if (row && act === "none") await logAndWarn([{ type: "Report resolved", row, fromId: row[I.assignedTo] || "", note }]);
          toast(act === "transfer" ? `Transferred to ${fullName(person)} and marked corrected.` : "Marked corrected.", "success");
          S.actions.refresh();
        },
      },
    ],
  });
  const sync = () => {
    const act = m.el.querySelector('input[name="rs-act"]:checked')?.value;
    m.el.querySelector("#rs-xfer").hidden = act !== "transfer";
    m.el.querySelector("#rs-hint").textContent = act === "none" ? "(required)" : "(optional — filled in for you)";
  };
  m.el.querySelectorAll('input[name="rs-act"]').forEach((r) => r.addEventListener("change", sync));
  sync();
  personPicker(m.el.querySelector("#rs-person"), {
    onPick: (u) => {
      person = u;
      m.el.querySelector("#rs-card").innerHTML = u ? `<div class="sub" style="margin:.3rem 0">${esc(u[U.section] || "No section")} · ${esc(u[U.edison])}</div>` : "";
    },
  });
}

// ---------------------------------------------------------------- create the service (Settings)
const TRACKING = { enableEditorTracking: true, enableOwnershipAccessControl: true, allowOthersToQuery: true, allowOthersToUpdate: true, allowOthersToDelete: false };

export async function createProblemsService() {
  const res = await createHostedService({
    title: CONFIG.PROBLEMS_SERVICE_TITLE,
    description: "Assigned Inventory Console: I don't have this reports and inventory confirmations",
    specs: [PROBLEMS_TABLE, CONFIRMATIONS_TABLE],
    // Everyone can add and see rows; only the person who made one can delete it.
    tracking: TRACKING,
  });
  CONFIG.PROBLEMS_SERVICE_URL = res.url;
  return res;
}

/** For a service made before confirmations existed: adds the Confirmations table. */
export async function addConfirmationsTable() {
  if (!S.problems.serviceUrl) throw new Error("The reports service wasn't found.");
  await addTablesToService(S.problems.serviceUrl, [CONFIRMATIONS_TABLE]);
}
