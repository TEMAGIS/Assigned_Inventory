// ---------------------------------------------------------------------------
// Problem reports. A small separate service (TEMA_Assigned_Inventory_Problems)
// that EVERYONE may add to — including people who only have the view-only copies
// of the inventory. Property Officers work the queue on the Problems tab.
//
// A report never changes the inventory by itself when the reporter is view-only.
// When the reporter CAN edit the item (Property Officer / in-scope Manager /
// the holder with edit access) the item is also marked "Needs repair", as before.
// Resolving a report (Property Officer) can set the item's status back.
// ---------------------------------------------------------------------------

import { CONFIG } from "./config.js";
import { esriRequest, queryAll, applyEdits, tableUrl, findServicesByTitle, itemServiceUrl, checkFieldNames } from "./shared/esri-client.js";
import { PROBLEMS_TABLE, PROBLEM_STATUSES, fieldNames } from "./schema.js";
import { $, esc, newTxnId, fmtDateTime, matchesSearch, debounce } from "./shared/util.js";
import { toast, openModal } from "./shared/ui.js";
import { S, I, U, fullName, itemTitle, itemMakeModel, groupsFor, isRetired, needsAttention, personName, statusOptions } from "./state.js";
import { isPropertyOfficer } from "./permissions.js";
import { updateInventory } from "./edits.js";
import { logAndWarn, createHostedService } from "./activity.js";

// ---------------------------------------------------------------- discovery / loading
export async function discoverProblems() {
  const P = S.problems;
  P.url = P.serviceUrl = P.error = "";
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
    if (t) P.url = tableUrl(svc, t.id); else P.error = `Found the service but it has no “${PROBLEMS_TABLE.name}” table.`;
  } catch (err) {
    P.error = err.message;
    console.warn("[problems] could not locate the problems service:", err);
  }
  return P;
}

export async function loadProblems() {
  const P = S.problems;
  P.rows = []; P.ready = false;
  if (!P.url) return;
  try {
    P.rows = await queryAll(P.url, { pageSize: CONFIG.FETCH_PAGE_SIZE });
    P.ready = true;
    checkFieldNames(P.url, "Problems", fieldNames(PROBLEMS_TABLE));
  } catch (err) {
    P.error = `Could not read the Problems table: ${err.message}`;
    console.warn(P.error);
  }
}

export async function loadProblemsAll() { await discoverProblems(); await loadProblems(); }

// ---------------------------------------------------------------- helpers
export const isOpenReport = (p) => String(p.status || "Open") !== "Resolved";
export const openReports = () => S.problems.rows.filter(isOpenReport);
export const openReportFor = (row) => S.problems.rows.find((p) => isOpenReport(p) && String(p.tag_number || "") === String(row[I.tag] || "") && row[I.tag]);
const isMine = (row) => S.me && row[I.assignedTo] && String(row[I.assignedTo]) === String(S.me[U.edison]);

/** May the signed-in person report a problem on this item right now? */
export function canReport(row) {
  if (!S.me || isRetired(row)) return false;
  if (S.readonly && !S.viewOnly) return false; // a ?readonly=1 link
  const allowed = S.viewOnly ? isMine(row) : groupsFor(row).problem;
  if (!allowed) return false;
  if (S.problems.url) return !openReportFor(row);
  return !S.viewOnly && !needsAttention(row); // no Problems service yet: the old "mark the item" behaviour
}

const reportAttrs = (row, note) => ({
  report_id: newTxnId().replace(/^TXN/, "PRB"),
  tag_number: String(row[I.tag] || "").slice(0, 255),
  item_desc: [itemTitle(row), itemMakeModel(row)].filter(Boolean).join(" · ").slice(0, 255),
  category: String(row[I.category] || "").slice(0, 60),
  problem: note.slice(0, 500),
  report_date: Date.now(),
  reported_by: (fullName(S.me) || S.profile?.fullName || "").slice(0, 150),
  reported_by_edison_id: String(S.me[U.edison] || "").slice(0, 40),
  reported_by_email: String(S.me[U.email] || S.profile?.email || "").toLowerCase().slice(0, 150),
  reported_by_section: String(S.me[U.section] || "").slice(0, 80),
  holder_name: row[I.assignedTo] ? personName(row[I.assignedTo]).slice(0, 150) : "",
  status: "Open",
});

// ---------------------------------------------------------------- report dialog
export function reportProblem(row) {
  const willMark = !S.viewOnly && groupsFor(row).problem && !needsAttention(row);
  const hasService = !!S.problems.url;
  openModal({
    title: `Report a problem: ${itemTitle(row)}`,
    body: `<p class="sub" style="margin-top:0">${hasService ? "This sends a report to the Property Officers." : ""}
      ${willMark ? `It also marks the item <b>${esc(CONFIG.STATUS_PROBLEM_VALUE)}</b> and records your note in its history.` : ""}</p>
      <label>What's wrong?<textarea id="pb-note" rows="3" maxlength="500" placeholder="e.g. screen cracked, battery won't charge"></textarea></label>`,
    buttons: [
      { label: "Cancel" },
      {
        label: "Report problem", kind: "primary",
        action: async (m) => {
          const note = m.el.querySelector("#pb-note").value.trim();
          if (!note) throw new Error("Please describe the problem.");
          if (!hasService && !willMark) throw new Error("Problem reporting isn't set up yet. Ask a Property Officer.");
          if (hasService) {
            const attrs = reportAttrs(row, note);
            const res = await applyEdits(S.problems.url, { adds: [{ attributes: attrs }] });
            S.problems.rows.push({ ...attrs, _oid: res.addResults?.[0]?.objectId, OBJECTID: res.addResults?.[0]?.objectId });
          }
          if (willMark) {
            const old = row[I.status] || "";
            try {
              await updateInventory([{ row, attrs: { [I.status]: CONFIG.STATUS_PROBLEM_VALUE } }]);
              await logAndWarn([{ type: "Problem reported", row, fromId: row[I.assignedTo] || "", note: `${note}${old ? ` (was: ${old})` : ""}` }]);
            } catch (err) {
              toast(`Your report was sent, but the item couldn't be marked: ${err.message}`, "error", 8000);
            }
          }
          toast("Problem reported.", "success");
          S.actions.refresh();
        },
      },
    ],
  });
}

// ---------------------------------------------------------------- Problems tab (Property Officer)
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
    if (b.dataset.pr === "progress") return setProgress(p);
  });
  S.render.prob = renderProblems;
}

export function renderProblems() {
  const el = $("#screen-prob");
  const P = S.problems;
  if (!isPropertyOfficer(S.me)) { el.innerHTML = `<p class="empty">Only a Property Officer can work the problem queue.</p>`; return; }
  if (!P.url) {
    el.innerHTML = `<div class="banner banner-warn" style="flex-direction:column;align-items:flex-start"><b>Problem reports aren't set up yet.</b>
      <span>${esc(P.error || "")} Create the service in <b>Settings → Problem reports</b> (takes a few seconds).</span></div>`;
    return;
  }
  el.innerHTML = `<div class="toolbar">
      <input id="pr-q" type="search" placeholder="Search tag, person, problem…" value="${esc(PF.q)}" aria-label="Search reports" autocomplete="off" />
      <select id="pr-status" aria-label="Show"><option value="open" ${PF.status === "open" ? "selected" : ""}>Open &amp; in progress</option><option value="resolved" ${PF.status === "resolved" ? "selected" : ""}>Resolved</option><option value="all" ${PF.status === "all" ? "selected" : ""}>All</option></select>
      <span class="spacer"></span><span id="pr-count" class="sub"></span></div>
    <div class="table-wrap tall"><table class="grid"><thead><tr><th>Reported</th><th>Tag</th><th>Item</th><th>Reported by</th><th>Problem</th><th>Status</th><th></th></tr></thead><tbody id="pr-body"></tbody></table></div>`;
  renderRows();
}

function renderRows() {
  const body = $("#pr-body");
  if (!body) return;
  const all = S.problems.rows;
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
    <td>${esc(p.problem)}${p.resolution ? `<div class="sub">Resolved: ${esc(p.resolution)}${p.resolved_by ? ` — ${esc(p.resolved_by)}` : ""}</div>` : ""}</td>
    <td><span class="status-pill ${isOpenReport(p) ? (p.status === "In progress" ? "st-pending" : "st-bad") : "st-ok"}">${esc(p.status || "Open")}</span></td>
    <td class="row-actions">${isOpenReport(p) ? `${p.status === "In progress" ? "" : `<button type="button" data-pr="progress" data-id="${esc(p._oid)}">Start</button>`}<button type="button" class="btn-primary" data-pr="resolve" data-id="${esc(p._oid)}">Resolve…</button>` : ""}</td></tr>`).join("")
    || `<tr><td colspan="7" class="empty">No reports here.</td></tr>`;
}

async function updateReport(p, attrs) {
  await applyEdits(S.problems.url, { updates: [{ attributes: { OBJECTID: p._oid, ...attrs } }] });
  Object.assign(p, attrs);
}

async function setProgress(p) {
  try { await updateReport(p, { status: "In progress" }); renderProblems(); S.actions.refresh(); }
  catch (err) { toast(err.message, "error", 8000); }
}

function resolveDialog(p) {
  const row = S.inv.find((r) => r[I.tag] && String(r[I.tag]) === String(p.tag_number));
  const flagged = row && needsAttention(row);
  const backTo = statusOptions().find((s) => !new RegExp(CONFIG.STATUS_ATTENTION_PATTERN, "i").test(s) && !new RegExp(CONFIG.STATUS_RETIRED_PATTERN, "i").test(s)) || CONFIG.STATUS_DEFAULTS[0];
  openModal({
    title: `Resolve: ${p.item_desc || p.tag_number}`,
    body: `<p class="sub" style="margin-top:0"><b>${esc(p.tag_number)}</b> — ${esc(p.reported_by)}: “${esc(p.problem)}”</p>
      <label>What was done?<textarea id="rs-note" rows="3" maxlength="500" placeholder="e.g. replaced battery, returned to stock"></textarea></label>
      ${flagged ? `<label class="check"><input type="checkbox" id="rs-status" checked /> Set the item's status back to <b>${esc(backTo)}</b> (now “${esc(row[I.status])}”)</label>` : ""}`,
    buttons: [
      { label: "Cancel" },
      {
        label: "Mark resolved", kind: "primary",
        action: async (m) => {
          const note = m.el.querySelector("#rs-note").value.trim();
          if (!note) throw new Error("Please say what was done.");
          await updateReport(p, { status: "Resolved", resolved_by: fullName(S.me), resolved_date: Date.now(), resolution: note.slice(0, 500) });
          let statusNote = "";
          if (flagged && m.el.querySelector("#rs-status")?.checked) {
            try { await updateInventory([{ row, attrs: { [I.status]: backTo } }]); statusNote = ` Status set to ${backTo}.`; }
            catch (err) { toast(`Report resolved, but the item status couldn't be changed: ${err.message}`, "error", 8000); }
          }
          if (row) await logAndWarn([{ type: "Problem resolved", row, fromId: row[I.assignedTo] || "", note: `${note}${statusNote}` }]);
          toast("Report resolved.", "success");
          S.actions.refresh();
        },
      },
    ],
  });
}

// ---------------------------------------------------------------- create the service (Settings)
export async function createProblemsService() {
  const res = await createHostedService({
    title: CONFIG.PROBLEMS_SERVICE_TITLE,
    description: "Assigned Inventory Console: problem reports",
    specs: [PROBLEMS_TABLE],
    // Everyone can add and see reports; only the person who made one can delete it.
    tracking: { enableEditorTracking: true, enableOwnershipAccessControl: true, allowOthersToQuery: true, allowOthersToUpdate: true, allowOthersToDelete: false },
  });
  CONFIG.PROBLEMS_SERVICE_URL = res.url;
  return res;
}
