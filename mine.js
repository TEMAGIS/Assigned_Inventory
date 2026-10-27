// ---------------------------------------------------------------------------
// "My items" — what's assigned to me, with a one-tap location update and a
// "report a problem" button. This is all a Non-Manager can change (it matches
// what the old "TEMA Assign Inventory" Survey123 form allowed), and it works
// well on a phone.
// ---------------------------------------------------------------------------

import { CONFIG } from "./config.js";
import { esc, $ } from "./shared/util.js";
import { openModal, toast } from "./shared/ui.js";
import { S, I, U, itemTitle, itemMakeModel, placeText, groupsFor, fmtYmd, needsAttention, isRetired, personName } from "./state.js";
import { updateInventory } from "./edits.js";
import { logAndWarn } from "./activity.js";
import { locationFormHTML, mountLocation } from "./location.js";
import { openDrawer } from "./drawer.js";
import { canReport, reportProblem, openReportFor } from "./problems.js";

export const myItems = () => S.inv.filter((r) => S.me && String(r[I.assignedTo] || "") === String(S.me[U.edison]) && (r[I.tag] || r[I.item]));

export function initMine() {
  $("#screen-mine").addEventListener("click", (e) => {
    const b = e.target.closest("[data-m]");
    if (!b) return;
    const row = S.invByOid.get(Number(b.dataset.oid));
    if (b.dataset.m === "loc") return updateLocation(row);
    if (b.dataset.m === "open") return openDrawer(row._oid);
    if (b.dataset.m === "problem") return reportProblem(row);
  });
  S.render.mine = renderMine;
}

export function renderMine() {
  const rows = myItems();
  $("#screen-mine").innerHTML = `
    <div class="mine-wrap">
      <h2 style="margin-bottom:.2rem">My items</h2>
      <p class="sub" style="margin-top:0">Items assigned to you (${esc(personName(S.me[U.edison]))}). Moved something? Update its location here.</p>
      ${rows.map((r) => `<div class="card mine-card">
        <div style="display:flex;justify-content:space-between;gap:.6rem;align-items:flex-start">
          <div><div class="mono sub">${esc(r[I.tag] || "—")}</div><b>${esc(itemTitle(r))}</b><div class="sub">${esc(itemMakeModel(r))}</div></div>
          ${openReportFor(r) ? `<span class="status-pill st-pending" title="${esc(openReportFor(r).problem)}">Problem reported · ${esc(openReportFor(r).status || "Open")}</span>` : needsAttention(r) ? `<span class="status-pill st-pending">${esc(r[I.status])}</span>` : ""}</div>
        <dl class="kv" style="margin:.5rem 0"><dt>Location</dt><dd>${esc(placeText(r) || "—")}</dd>${r[I.dateAssigned] ? `<dt>Since</dt><dd>${esc(fmtYmd(r[I.dateAssigned]))}</dd>` : ""}</dl>
        <div class="drawer-actions">
          ${!S.readonly && groupsFor(r).location ? `<button type="button" class="btn-primary" data-m="loc" data-oid="${r._oid}">Update location</button>` : ""}
          ${canReport(r) ? `<button type="button" data-m="problem" data-oid="${r._oid}">Report a problem</button>` : ""}
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
