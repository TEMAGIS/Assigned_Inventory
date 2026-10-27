// ---------------------------------------------------------------------------
// Assign / Transfer / Return — the three everyday actions, usable from a row, a
// bulk selection, the item drawer, a person's page, or a scanned tag.
// Each one: confirm in a short dialog → edit the inventory layer → write the
// Activity row(s) → refresh every view.
// ---------------------------------------------------------------------------

import { CONFIG } from "./config.js";
import { esc, unique } from "./shared/util.js";
import { openModal, toast } from "./shared/ui.js";
import { S, I, U, fullName, personName, userById, itemTitle, itemMakeModel, groupsFor, todayYmd, ymdToMs, regionOptions, isRetired } from "./state.js";
import { updateInventory, presetFor } from "./edits.js";
import { personPicker, rememberAssignee } from "./pickers.js";
import { logAndWarn } from "./activity.js";

const rowLine = (r) => `<div><span class="mono">${esc(r[I.tag] || "—")}</span> ${esc(itemTitle(r))} <span class="sub">${esc(itemMakeModel(r))}</span></div>`;

/** Keeps only rows this user may reassign (and, when asked, rows that are currently assigned). */
function allowedRows(rows, { needAssigned = false } = {}) {
  const ok = rows.filter((r) => groupsFor(r).assignment && !isRetired(r) && (!needAssigned || r[I.assignedTo]));
  return { ok, skipped: rows.length - ok.length };
}

export function openAssignDialog(rows, { transfer = false, person: presetPerson = null } = {}) {
  if (S.readonly) return toast("This link is view-only.", "error");
  const { ok, skipped } = allowedRows(rows);
  if (!ok.length) return toast("You can't assign these items (not owned by your section, retired, or read-only).", "error");
  const multi = ok.length > 1;
  const first = ok[0];
  const heldBy = !multi && first[I.assignedTo] ? personName(first[I.assignedTo]) : "";
  const places = unique(S.inv.map((r) => r[I.place]));
  const verb = transfer || heldBy ? "Transfer" : "Assign";
  let person = null;

  const m = openModal({
    title: multi ? `${verb === "Transfer" ? "Assign" : verb} ${ok.length} items` : `${verb}: ${itemTitle(first)}`,
    body: `
      ${multi
        ? `<div class="sel-list">${ok.map(rowLine).join("")}</div>`
        : `<p class="sub" style="margin-top:0"><span class="mono">${esc(first[I.tag] || "")}</span> · ${esc(itemMakeModel(first))}${heldBy ? ` · currently with <b>${esc(heldBy)}</b>` : ""}</p>`}
      ${skipped ? `<div class="banner banner-warn">${skipped} selected item(s) skipped — not owned by your section, retired, or read-only.</div>` : ""}
      <label>${heldBy ? "Transfer to" : "Assign to"}<div id="as-person"></div></label>
      <div id="as-card"></div>
      <div class="two-col">
        <label>Date assigned<input type="date" id="as-date" value="${todayYmd()}" /></label>
        <label>Location<select id="as-loc"><option value="keep">Keep current location</option><option value="set">Update location…</option></select></label>
      </div>
      <div id="as-locfields" hidden>
        <div class="two-col">
          <label>Region<select id="as-region"><option value="">—</option>${regionOptions().map((r) => `<option>${esc(r)}</option>`).join("")}</select></label>
          <label>Building / other location<input id="as-place" list="as-place-dl" autocomplete="off" /></label>
        </div>
        <datalist id="as-place-dl">${places.map((p) => `<option value="${esc(p)}">`).join("")}</datalist>
        <label>Room<input id="as-room" /></label>
        <p class="hint">Choosing a region also fills in its office address and map pin.</p>
      </div>
      <label>Note <span class="hint">(optional — shows in the history)</span><input id="as-note" maxlength="500" placeholder="e.g. new hire kit, loaner, field deployment" /></label>`,
    buttons: [
      { label: "Cancel" },
      {
        label: verb,
        kind: "primary",
        id: "as-ok",
        action: async () => {
          if (!person) throw new Error("Pick who it is going to.");
          const dateYmd = $v("as-date");
          const dateMs = dateYmd ? ymdToMs(dateYmd) : null;
          const note = $v("as-note").trim();
          const setLoc = $v("as-loc") === "set";
          const region = $v("as-region");
          const toId = String(person[U.edison]);
          const todo = ok.filter((r) => String(r[I.assignedTo] || "") !== toId);
          if (!todo.length) throw new Error(`${fullName(person)} already has ${multi ? "all of these" : "this item"}.`);

          const preset = setLoc && region ? presetFor(region) : null;
          const changes = todo.map((row) => {
            const attrs = { [I.assignedTo]: toId, [I.dateAssigned]: dateMs };
            let geometry;
            if (setLoc) {
              if (preset) { Object.assign(attrs, preset.attrs); geometry = preset.geometry; }
              if ($v("as-place").trim()) attrs[I.place] = $v("as-place").trim();
              attrs[I.room] = $v("as-room").trim();
            }
            return { row, attrs, geometry };
          });
          const prev = new Map(todo.map((r) => [r, r[I.assignedTo] ? String(r[I.assignedTo]) : ""]));
          await updateInventory(changes);
          rememberAssignee(toId);
          await logAndWarn(todo.map((row) => ({
            type: prev.get(row) ? "Transferred" : "Assigned",
            row, fromId: prev.get(row) || "", toId, note,
          })));
          toast(`${todo.length} item${todo.length > 1 ? "s" : ""} ${verb === "Transfer" ? "transferred" : "assigned"} to ${fullName(person)}.`, "success");
          S.actions.refresh();
        },
      },
    ],
  });
  const $v = (id) => m.el.querySelector("#" + id).value;
  const okBtn = m.el.querySelector("#as-ok");
  okBtn.disabled = true;

  const picker = personPicker(m.el.querySelector("#as-person"), {
    onPick: (u) => {
      person = u;
      okBtn.disabled = !u;
      m.el.querySelector("#as-card").innerHTML = u
        ? `<div class="card assign"><div class="who"><span class="av lg">${esc(initialsOf(fullName(u)))}</span><div><b>${esc(fullName(u))}</b>
             <div class="sub">${esc(u[U.section] || "No section")} · ${esc(u[U.edison])}</div>
             <div class="sub">Currently holds ${S.inv.filter((r) => String(r[I.assignedTo]) === String(u[U.edison])).length} item(s)</div></div></div></div>`
        : "";
    },
    onNew: (text, done) => S.actions.openAddUser?.(text, done),
  });
  m.el.querySelector("#as-loc").addEventListener("change", (e) => { m.el.querySelector("#as-locfields").hidden = e.target.value !== "set"; });
  if (presetPerson) picker.set(presetPerson);
  else m.el.querySelector("#as-person input").focus();
  return m;
}

const initialsOf = (n) => String(n || "?").split(/\s+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join("").toUpperCase();

export function openReturnDialog(rows, { reason = "" } = {}) {
  if (S.readonly) return toast("This link is view-only.", "error");
  const { ok, skipped } = allowedRows(rows, { needAssigned: true });
  if (!ok.length) return toast("Nothing to return — these items aren't assigned, or you can't change them.", "error");
  return openModal({
    title: ok.length > 1 ? `Return ${ok.length} items to stock` : `Return ${itemTitle(ok[0])} to stock`,
    body: `
      <div class="sel-list">${ok.map((r) => `${rowLine(r)}<div class="sub" style="margin:-0.1rem 0 .3rem 0">from ${esc(personName(r[I.assignedTo]))}</div>`).join("")}</div>
      ${skipped ? `<div class="banner banner-warn">${skipped} item(s) skipped — not assigned, not owned by your section, or read-only.</div>` : ""}
      <p class="sub">They become <b>unassigned</b>; their location is left as it is.</p>
      <label>Note <span class="hint">(optional)</span><input id="rt-note" maxlength="500" value="${esc(reason)}" placeholder="e.g. separated 10/24, replaced, end of project" /></label>`,
    buttons: [
      { label: "Cancel" },
      {
        label: "Return to stock",
        kind: "primary",
        action: async (m) => {
          const note = m.el.querySelector("#rt-note").value.trim();
          const prev = new Map(ok.map((r) => [r, String(r[I.assignedTo])]));
          await updateInventory(ok.map((row) => ({ row, attrs: { [I.assignedTo]: null, [I.dateAssigned]: null } })));
          await logAndWarn(ok.map((row) => ({ type: "Returned", row, fromId: prev.get(row), note })));
          toast(`${ok.length} item${ok.length > 1 ? "s" : ""} returned to stock.`, "success");
          S.actions.refresh();
        },
      },
    ],
  });
}
