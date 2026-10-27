// ---------------------------------------------------------------------------
// Legacy history import (Property Officer, Settings → Legacy history).
//
// The old webhook wrote one full snapshot of the item to a history layer on
// EVERY edit, so most rows are repeats (a make was fixed, a photo added…). This
// reads those snapshots, orders them per tag, and keeps only the rows where the
// holder actually changed:
//     nobody → someone  = Assigned        someone → nobody  = Returned
//     someone → someone else = Transferred
// A tag's first row, if it already had a holder, becomes an "Opening balance"
// Assigned entry so every current holder has a starting point.
//
// Nothing is written until the preview has been seen and Apply is clicked.
// Each imported row carries "legacy #<objectid>" in its note, so running the
// import again (from the layer or from a CSV) skips what is already there.
// The legacy layer itself is only read, never changed.
// ---------------------------------------------------------------------------

import { CONFIG } from "./config.js";
import { esc, parseCSV, newTxnId, fmtDateTime, $ } from "./shared/util.js";
import { openModal, toast } from "./shared/ui.js";
import { esriRequest, queryAll, applyEdits } from "./shared/esri-client.js";
import { S, U, userById } from "./state.js";
import { canManageSettings } from "./permissions.js";
import { loadActivity } from "./activity.js";

export const LEGACY_MARK = /legacy #(\d+)/;
const LEGACY_FIELDS = ["objectid", "tag_number", "assigned_to", "username", "item_category", "item", "item_select", "make", "model", "EditDate", "CreationDate", "status"];
const WHO = "Legacy history";

/** "5/4/2021 6:28:20 PM" (ArcGIS CSV export, UTC) → ms; numbers pass through. */
export function parseWhen(v) {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return v;
  const s = String(v).trim();
  if (/^\d{10,}$/.test(s)) return Number(s);
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?$/i);
  if (m) {
    let h = Number(m[4] || 0);
    if (m[7]) h = (h % 12) + (m[7].toUpperCase() === "PM" ? 12 : 0);
    return Date.UTC(Number(m[3]), Number(m[1]) - 1, Number(m[2]), h, Number(m[5] || 0), Number(m[6] || 0));
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

/** CSV text → plain row objects keyed by the layer's field names (case-insensitive header match). */
export function rowsFromCSV(text) {
  const grid = parseCSV(text);
  if (grid.length < 2) throw new Error("That file has no data rows.");
  const header = grid[0].map((h) => String(h).trim());
  const idx = {};
  for (const f of LEGACY_FIELDS) idx[f] = header.findIndex((h) => h.toLowerCase() === f.toLowerCase());
  if (idx.tag_number < 0 || idx.assigned_to < 0) throw new Error("This doesn't look like the legacy history export: it needs tag_number and assigned_to columns.");
  if (idx.EditDate < 0 && idx.CreationDate < 0) throw new Error("The file needs an EditDate (or CreationDate) column.");
  return grid.slice(1).map((r, n) => {
    const o = { _row: n + 2 };
    for (const f of LEGACY_FIELDS) o[f] = idx[f] >= 0 ? r[idx[f]] : "";
    o._oid = o.objectid ? Number(o.objectid) : null;
    return o;
  });
}

/** Reads the legacy layer straight from ArcGIS, by item id (or a layer URL). */
export async function rowsFromLayer(itemIdOrUrl, onStatus = () => {}) {
  let url = String(itemIdOrUrl || "").trim();
  if (!url) throw new Error("Enter the legacy layer's item ID or URL.");
  if (!/^https?:\/\//i.test(url)) {
    onStatus("Looking up the layer…");
    const item = await esriRequest(`${CONFIG.ARCGIS_PORTAL_URL}/sharing/rest/content/items/${encodeURIComponent(url)}`, {}, { method: "GET" });
    if (!item.url) throw new Error("That item has no service URL (is it a hosted feature layer you can see?).");
    url = String(item.url).replace(/\/+$/, "");
  }
  if (/\/FeatureServer$/i.test(url)) url += "/0";
  onStatus("Reading rows…");
  const rows = await queryAll(url, {
    pageSize: 2000,
    outFields: "*",
    onPage: (r) => onStatus(`Reading rows… ${r.length.toLocaleString()}`),
  });
  return rows.map((r) => ({ ...r, objectid: r._oid }));
}

const describe = (r) => {
  const base = String(r.item || r.item_select || r.item_category || "").trim();
  const mm = [r.make, r.model].map((x) => String(x || "").trim()).filter(Boolean).join(" ");
  return [base, mm].filter(Boolean).join(" · ").slice(0, 255);
};

/**
 * Pure planner. rows: legacy snapshots. alreadyImported: Set of legacy objectids
 * already in the Activity table. Returns {entries, stats, errors}.
 */
export function planLegacy(rows, alreadyImported = new Set()) {
  const stats = { rows: rows.length, tags: 0, noTag: 0, noDate: 0, repeats: 0, opening: 0, assigned: 0, returned: 0, transferred: 0, already: 0 };
  const errors = [];
  const byTag = new Map();
  for (const r of rows) {
    const tag = String(r.tag_number || "").trim();
    if (!tag) { stats.noTag++; continue; }
    const when = parseWhen(r.EditDate) ?? parseWhen(r.CreationDate);
    if (when === null) { stats.noDate++; errors.push({ rowNo: r._row || r._oid, id: tag, msg: "no usable date — skipped" }); continue; }
    if (!byTag.has(tag)) byTag.set(tag, []);
    byTag.get(tag).push({ r, when, to: String(r.assigned_to || "").trim(), name: String(r.username || "").trim() });
  }
  stats.tags = byTag.size;
  const entries = [];
  for (const [tag, list] of byTag) {
    list.sort((a, b) => a.when - b.when || (a.r._oid || 0) - (b.r._oid || 0));
    let prev = null; // {to, name}
    list.forEach((x, i) => {
      const oid = x.r._oid;
      const cur = { to: x.to, name: x.name || (x.to ? (userById(x.to) ? `${userById(x.to)[U.full] || ""}` : x.to) : "") };
      let type = "", opening = false;
      if (i === 0) {
        if (cur.to) { type = "Assigned"; opening = true; }
      } else if (cur.to !== prev.to) {
        type = !prev.to ? "Assigned" : !cur.to ? "Returned" : "Transferred";
      } else stats.repeats++;
      if (type) {
        const e = { type, tag, when: x.when, oid, row: x.r, opening, from: type === "Assigned" ? null : prev, to: type === "Returned" ? null : cur };
        if (oid != null && alreadyImported.has(Number(oid))) stats.already++;
        else {
          entries.push(e);
          if (opening) stats.opening++; else stats[type.toLowerCase()]++;
        }
      }
      prev = cur;
    });
  }
  entries.sort((a, b) => b.when - a.when);
  return { entries, stats, errors };
}

const toAttrs = (e) => {
  const sec = e.to && userById(e.to.to) ? String(userById(e.to.to)[U.section] || "") : "";
  return {
    activity_id: newTxnId().replace(/^TXN/, "ACT"),
    activity_type: e.type,
    activity_date: e.when,
    tag_number: e.tag.slice(0, 255),
    item_desc: describe(e.row),
    category: String(e.row.item_category || "").slice(0, 60),
    from_edison_id: e.from ? e.from.to.slice(0, 40) : "",
    from_name: e.from ? e.from.name.slice(0, 150) : "",
    to_edison_id: e.to ? e.to.to.slice(0, 40) : "",
    to_name: e.to ? e.to.name.slice(0, 150) : "",
    to_section: sec.slice(0, 80),
    region: "",
    performed_by: WHO,
    performed_by_email: "",
    note: `${e.opening ? "Opening balance — " : ""}Imported from legacy history${e.oid != null ? ` · legacy #${e.oid}` : ""}`.slice(0, 500),
  };
};

export async function writeEntries(entries, onProgress = () => {}) {
  const url = S.activity.url;
  const size = CONFIG.EDIT_CHUNK || 200;
  let done = 0;
  for (let i = 0; i < entries.length; i += size) {
    const chunk = entries.slice(i, i + size).map(toAttrs);
    await applyEdits(url, { adds: chunk.map((a) => ({ attributes: a })) });
    done += chunk.length;
    onProgress(done);
  }
  return done;
}

const importedIds = () => new Set(S.activity.rows.map((a) => (String(a.note || "").match(LEGACY_MARK) || [])[1]).filter(Boolean).map(Number));

// ---------------------------------------------------------------- dialog
export function openLegacyImport() {
  if (!canManageSettings(S.me) || S.readonly) return toast("Only a Property Officer can import history.", "error");
  if (!S.activity.url) return toast("Create the log service first (Settings → Log service).", "error");
  let plan = null;
  const m = openModal({
    title: "Import legacy assignment history",
    wide: true,
    body: `
      <div class="banner banner-info" style="margin-top:0"><span>Reads the old webhook history and brings in only the <b>assignment changes</b> (assigned, transferred, returned), plus one opening entry for each item that already had a holder. The legacy layer is not changed. Running this again skips anything already imported.</span></div>
      <label>Legacy layer (item ID or URL)<input id="lg-src" value="${esc(CONFIG.LEGACY_HISTORY_SOURCE || "")}" autocomplete="off" /></label>
      <div class="set-actions"><button type="button" id="lg-read">Read from ArcGIS</button><span class="sub">or</span>
        <label class="inline">choose a CSV export <input type="file" id="lg-file" accept=".csv,text/csv" /></label></div>
      <div id="lg-status" class="sub"></div>
      <div id="lg-preview"></div>`,
    buttons: [
      { label: "Cancel" },
      {
        label: "Import", kind: "primary", id: "lg-apply",
        action: async (mm) => {
          if (!plan || !plan.entries.length) throw new Error("Nothing to import.");
          const status = mm.el.querySelector("#lg-status");
          let done = 0;
          try {
            done = await writeEntries(plan.entries, (n) => (status.textContent = `Writing… ${n.toLocaleString()} of ${plan.entries.length.toLocaleString()}`));
          } catch (err) {
            await loadActivity();
            S.actions.refresh();
            throw new Error(`${err.message}. Some entries may already have been saved — run the import again; it skips what's there.`);
          }
          await loadActivity();
          S.actions.refresh();
          toast(`Imported ${done.toLocaleString()} history entries.`, "success", 7000);
        },
      },
    ],
  });
  const btn = m.el.querySelector("#lg-apply");
  btn.disabled = true;
  const status = m.el.querySelector("#lg-status");
  const show = (rows) => {
    plan = planLegacy(rows, importedIds());
    const s = plan.stats, n = plan.entries.length;
    const oldest = n ? fmtDateTime(plan.entries[n - 1].when) : "—", newest = n ? fmtDateTime(plan.entries[0].when) : "—";
    $("#lg-preview", m.el).innerHTML = `
      <div class="tiles" style="margin:.75rem 0"><div class="card"><b>${n.toLocaleString()}</b> <span class="sub">to import</span></div>
        <div class="card"><b>${s.opening.toLocaleString()}</b> <span class="sub">opening</span></div>
        <div class="card"><b>${s.assigned.toLocaleString()}</b> <span class="sub">assigned</span></div>
        <div class="card"><b>${s.transferred.toLocaleString()}</b> <span class="sub">transferred</span></div>
        <div class="card"><b>${s.returned.toLocaleString()}</b> <span class="sub">returned</span></div></div>
      <p class="sub">${s.rows.toLocaleString()} legacy rows across ${s.tags.toLocaleString()} tags. ${s.repeats.toLocaleString()} rows were repeats (no change of holder) and are skipped.
        ${s.already ? `${s.already.toLocaleString()} already imported earlier. ` : ""}${s.noTag ? `${s.noTag} rows without a tag skipped. ` : ""}Dates run ${esc(oldest)} to ${esc(newest)}.</p>
      ${plan.errors.length ? `<h3>Rows with problems (skipped)</h3><div class="table-wrap" style="max-height:140px"><table class="grid"><tbody>${plan.errors.slice(0, 50).map((x) => `<tr><td>${esc(x.rowNo)}</td><td>${esc(x.id)}</td><td class="neg">${esc(x.msg)}</td></tr>`).join("")}</tbody></table></div>` : ""}
      ${n ? `<h3>Newest 30</h3><div class="table-wrap" style="max-height:260px"><table class="grid"><thead><tr><th>When</th><th>Type</th><th>Tag</th><th>From</th><th>To</th></tr></thead><tbody>${plan.entries.slice(0, 30).map((e) => `<tr><td>${esc(fmtDateTime(e.when))}</td><td>${esc(e.opening ? "Opening" : e.type)}</td><td class="mono">${esc(e.tag)}</td><td>${esc(e.from?.name || e.from?.to || "")}</td><td>${esc(e.to?.name || e.to?.to || "")}</td></tr>`).join("")}</tbody></table></div>` : `<p class="empty">Nothing new to import.</p>`}`;
    btn.disabled = !n;
    btn.textContent = n ? `Import (${n.toLocaleString()})` : "Import";
    status.textContent = "";
  };
  const fail = (err) => { plan = null; btn.disabled = true; $("#lg-preview", m.el).innerHTML = `<div class="form-error">${esc(err.message)}</div>`; status.textContent = ""; };
  m.el.querySelector("#lg-read").addEventListener("click", async (e) => {
    e.target.disabled = true;
    try { show(await rowsFromLayer(m.el.querySelector("#lg-src").value, (t) => (status.textContent = t))); } catch (err) { fail(err); }
    e.target.disabled = false;
  });
  m.el.querySelector("#lg-file").addEventListener("change", async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try { status.textContent = "Reading file…"; show(rowsFromCSV(await f.text())); } catch (err) { fail(err); }
  });
}
