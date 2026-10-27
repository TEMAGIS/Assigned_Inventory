// ---------------------------------------------------------------------------
// "My items" — what's assigned to me. A holder can look at it, confirm it is
// correct ("Yes, I have this"), say "I don't have this", and update the
// location. Works well on a phone.
// ---------------------------------------------------------------------------

import { CONFIG } from "./config.js";
import { esc, $ } from "./shared/util.js";
import { openModal, toast } from "./shared/ui.js";
import { S, I, U, itemTitle, itemMakeModel, placeText, groupsFor, fmtYmd, needsAttention, isRetired, personName } from "./state.js";
import { updateInventory } from "./edits.js";
import { logAndWarn } from "./activity.js";
import { locationFormHTML, mountLocation } from "./location.js";
import { openDrawer } from "./drawer.js";
import { canReport, canConfirm, reportProblem, openReportFor, confirmOne, confirmAll, lastConfirmation } from "./problems.js";

export const myItems = () => S.inv.filter((r) => S.me && String(r[I.assignedTo] || "") === String(S.me[U.edison]) && (r[I.tag] || r[I.item]));

export function initMine() {
  $("#screen-mine").addEventListener("click", (e) => {
    const b = e.target.closest("[data-m]");
    if (!b) return;
    const row = S.invByOid.get(Number(b.dataset.oid));
    if (b.dataset.m === "loc") return updateLocation(row);
    if (b.dataset.m === "open") return openDrawer(row._oid);
    if (b.dataset.m === "problem") return reportProblem(row);
    if (b.dataset.m === "confirm") return confirmOne(row);
    if (b.dataset.m === "confirm-all") return confirmAll(myItems());
  });
  S.render.mine = renderMine;
}

export function renderMine() {
  const rows = myItems();
  const todo = rows.filter((r) => canConfirm(r) && !lastConfirmation(r));
  const done = rows.filter((r) => lastConfirmation(r)).length;
  const bar = !rows.length || !S.problems.confUrl ? "" : `<div class="card confirm-bar" style="display:flex;gap:.8rem;align-items:center;justify-content:space-between;flex-wrap:wrap">
      <div><b>${todo.length ? `${todo.length} of ${rows.length} still to confirm` : done === rows.length ? "All confirmed" : "Nothing else to confirm"}</b><div class="sub">Check that each item below is with you. ${done ? `${done} confirmed.` : ""}</div></div>
      ${todo.length ? `<button type="button" class="btn-primary" data-m="confirm-all">Confirm all ${todo.length}</button>` : ""}</div>`;
  $("#screen-mine").innerHTML = `
    <div class="mine-wrap">
      <h2 style="margin-bottom:.2rem">My items</h2>
      <p class="sub" style="margin-top:0">Items assigned to you (${esc(personName(S.me[U.edison]))}). Please check that this list is correct.</p>
      ${bar}
      ${rows.map((r) => `<div class="card mine-card">
        <div style="display:flex;justify-content:space-between;gap:.6rem;align-items:flex-start">
          <div><div class="mono sub">${esc(r[I.tag] || "—")}</div><b>${esc(itemTitle(r))}</b><div class="sub">${esc(itemMakeModel(r))}</div></div>
          ${openReportFor(r) ? `<span class="status-pill st-pending" title="${esc(openReportFor(r).problem)}">Told the Inventory team you don't have it</span>` : lastConfirmation(r) ? `<span class="status-pill st-ok" title="Confirmed by ${esc(lastConfirmation(r).confirmed_by)}">Confirmed ${esc(fmtYmd(lastConfirmation(r).confirmed_date))}</span>` : needsAttention(r) ? `<span class="status-pill st-pending">${esc(r[I.status])}</span>` : ""}</div>
        <dl class="kv" style="margin:.5rem 0"><dt>Location</dt><dd>${esc(placeText(r) || "—")}</dd>${r[I.dateAssigned] ? `<dt>Since</dt><dd>${esc(fmtYmd(r[I.dateAssigned]))}</dd>` : ""}</dl>
        <div class="drawer-actions">
          ${canConfirm(r) && !lastConfirmation(r) ? `<button type="button" class="btn-primary" data-m="confirm" data-oid="${r._oid}">Yes, I have this</button>` : ""}
          ${canReport(r) ? `<button type="button" data-m="problem" data-oid="${r._oid}">I don't have this</button>` : ""}
          ${!S.readonly && groupsFor(r).location ? `<button type="button" data-m="loc" data-oid="${r._oid}">Update location</button>` : ""}
          <button type="button" data-m="open" data-oid="${r._oid}">Details &amp; photos</button>
        </div></div>`).join("") || `<p class="empty">Nothing is assigned to you right now.</p>`}
    </div>`;
}

function updateLocation(row) {
  const m = openModal({
    title: `Update location: ${itemTitle(row)}`,
    body: `<div id="ul-loc">${locationFormHTML({ idp: "ul", showMap: true })}</div>`,
    buttons: [
      { label: "Cancel" },
      {
        label: "Save location", kind: "primary",
        action: async () => {
          const { attrs, geometry } = loc.read();
          const changed = {};
          for (const [f, v] of Object.entries(attrs)) {
            const same = typeof v === "number" ? Number(row[f]) === v : String(row[f] ?? "") === String(v ?? "");
            if (!same) changed[f] = v;
          }
          if (!Object.keys(changed).length) return;
          await updateInventory([{ row, attrs: changed, geometry }]);
          await logAndWarn([{ type: "Location updated", row, fromId: row[I.assignedTo] || "", note: [attrs[I.place], attrs[I.room], attrs[I.city]].filter(Boolean).join(", ") }]);
          toast("Location updated.", "success");
          S.actions.refresh();
        },
      },
    ],
  });
  const loc = mountLocation(m.el.querySelector("#ul-loc"), row, { editable: true, showMap: true });
  const oc = m.close;
  m.close = () => { loc.destroy(); oc(); };
}
