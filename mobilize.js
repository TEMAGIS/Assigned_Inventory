// ---------------------------------------------------------------------------
// Mobilize: send inventory out against an MCC request, track it, bring it back.
//
//   Mobilize        pick items → pick mission → pick the MCC request → (status, expected
//                   arrival, note). One Equipment deployment row per item is added to the
//                   RESL deployment layer, filled the same way the RESL board does when an
//                   inventory card is dropped on an MCC card.
//   Update / Demobilize
//                   change the deployment's status (En Route, On Scene, …, Demobilized).
//                   Demobilized stamps the demob date and days deployed; En Route / On Scene
//                   stamp the mobilization date if it is still blank (same rules as RESL).
//
// The deployment row is the source of truth. The item's `mobilization_status` (when that
// field exists) and the Activity log follow it. Console edits are also written to RESL's
// edit-history layer so the History tab on the RESL board stays complete.
// Who may do it: Inventory Administrators, and property owners for their sections' items
// (the same rule as assigning). The assignee does not change when an item is mobilized.
// ---------------------------------------------------------------------------

import { CONFIG } from "./config.js";
import { esc, matchesSearch, debounce } from "./shared/util.js";
import { openModal, toast } from "./shared/ui.js";
import { queryAll, applyEdits, sqlStr } from "./shared/esri-client.js";
import { S, I, fullName, itemTitle, itemMakeModel, groupsFor, isRetired, fmtYmd, todayYmd, regionOptions } from "./state.js";
import { updateInventory, presetFor, geometryFor } from "./edits.js";
import { logAndWarn } from "./activity.js";
import * as auth from "./shared/arcgis-auth.js";
import { lookupTnCountyByName } from "./tn-counties.js";

const M = CONFIG.MOBILIZE || {};
const D = M.DEPLOY || {};
const C = M.MCC || {};

// ---------- small helpers ----------
export const mobilizeEnabled = () => !!(M.ENABLED && M.DEPLOY_URL && M.MCC_URL);
const isClosed = (s) => /^(demobilized|cancell?ed)$/i.test(String(s || "").trim());
const isDemob = (s) => /^demobilized$/i.test(String(s || "").trim());
const isGoing = (s) => /^(en route|on scene)$/i.test(String(s || "").trim());
const tagKey = (t) => String(t ?? "").trim().toLowerCase();
const blankNum = (v) => v == null || v === "" || !Number.isFinite(Number(v));
/** "Today" as UTC midnight (RESL stores these date-only fields that way). */
const utcToday = () => { const n = new Date(); return Date.UTC(n.getFullYear(), n.getMonth(), n.getDate()); };
const ymdToUtc = (ymd) => (/^\d{4}-\d{2}-\d{2}$/.test(ymd || "") ? Date.parse(ymd + "T00:00:00Z") : null);
const daysBetween = (a, b) => (blankNum(a) || blankNum(b) ? null : Math.floor((Number(b) - Number(a)) / 86400000));
const hasMobField = () => S.inv.length > 0 && Object.prototype.hasOwnProperty.call(S.inv[0], CONFIG.INV.mobilizationStatus);

// ---------- deployments (current + past) ----------
function reindex() {
  const X = S.deploy;
  X.byTag = new Map();
  for (const r of X.rows) {
    const k = tagKey(r[D.tag]);
    if (!k) continue;
    if (!X.byTag.has(k)) X.byTag.set(k, []);
    X.byTag.get(k).push(r);
  }
  for (const list of X.byTag.values()) list.sort((a, b) => (Number(b[D.edit]) || 0) - (Number(a[D.edit]) || 0));
}

/** Loads every deployment row that has a tag number. Never throws; sets S.deploy.error instead. */
export async function loadDeployments() {
  const X = S.deploy;
  X.rows = []; X.byTag = new Map(); X.ready = false; X.error = "";
  if (!mobilizeEnabled()) return;
  try {
    X.rows = await queryAll(M.DEPLOY_URL, { where: `${D.tag} IS NOT NULL`, pageSize: CONFIG.FETCH_PAGE_SIZE, oidField: D.objectId });
    reindex();
    X.ready = true;
  } catch (err) {
    X.error = err.message;
    console.warn("[mobilize] could not read the deployment layer:", err);
  }
}

export const deploymentsFor = (row) => S.deploy.byTag.get(tagKey(row[I.tag])) || [];
/** The item's current (not demobilized / canceled) deployment, if any. */
export const activeDeployment = (row) => deploymentsFor(row).find((d) => !isClosed(d[D.status])) || null;
export const depStatus = (dep) => String(dep[D.status] || "").trim() || "Unassigned";
export const depLabel = (dep) => `MCC #${dep[D.request] ?? "?"} · ${depStatus(dep)}`;
export const mobilizedCount = () => [...S.deploy.byTag.values()].filter((l) => l.some((d) => !isClosed(d[D.status]))).length;
const canMobilizeRow = (r) => !S.readonly && !S.viewOnly && groupsFor(r).assignment && !isRetired(r);

// ---------- MCC missions + requests ----------
let missionCache = null;
async function loadMissions() {
  if (missionCache && Date.now() - missionCache.ts < 5 * 60 * 1000) return missionCache.list;
  const rows = await queryAll(M.MCC_URL, {
    where: `${C.number} IS NOT NULL AND ${C.number} > 0`, outFields: `${C.mission},${C.entry}`, pageSize: 2000, oidField: C.objectId,
  });
  const byId = new Map();
  for (const r of rows) {
    const id = String(r[C.mission] || "").trim();
    if (!id) continue;
    const m = byId.get(id) || { id, count: 0, latest: 0 };
    m.count++;
    m.latest = Math.max(m.latest, Number(r[C.entry]) || 0);
    byId.set(id, m);
  }
  const list = [...byId.values()].sort((a, b) => b.latest - a.latest || b.id.localeCompare(a.id));
  missionCache = { ts: Date.now(), list };
  return list;
}
async function loadRequests(missionId) {
  return queryAll(M.MCC_URL, {
    where: `${C.mission} = ${sqlStr(missionId)} AND ${C.number} IS NOT NULL AND ${C.number} > 0`,
    orderByFields: `${C.number} DESC`, pageSize: 2000, oidField: C.objectId,
  });
}

/** The deployment row for one item against one MCC request (field mapping mirrors RESL's createDeploymentFromInventory). */
export function buildDeploymentAttrs(req, row, { status = null, arrival = null, today = utcToday(), loc = null } = {}) {
  const incident = req[C.mission] || null;
  const s = incident ? String(incident) : "";
  const year = (s.match(/^(\d{4})/) || [])[1] || null;
  const num = (s.match(/#\s*(\d+)/) || [])[1] || null;
  const a = {
    [D.request]: req[C.number] ?? null,
    [D.mission]: incident,
    [D.missionYear]: year,
    [D.missionNumber]: num,
    [D.county]: req[C.county] || null,
    [D.region]: req[C.region] || null,
    [D.kind]: "Equipment",
    [D.count]: 1,
    [D.tag]: row[I.tag] ?? null,
    [D.item]: row[I.item] ?? null,
    [D.make]: row[I.make] ?? null,
    [D.serial]: row[I.model] ?? null, // RESL copies the inventory model into serial
    [D.reslNote]: row[I.description] ?? null,
    [D.status]: status || null,
  };
  if (arrival != null) a[D.arrival] = arrival;
  if (isGoing(status)) a[D.mob] = today;
  if (isDemob(status)) a[D.demob] = today;
  if (loc) Object.assign(a, loc); // where it is deployed: typed address, matched address, county, region
  return a;
}

/** The fields a status change writes (RESL rules: Demobilized stamps demob + days; En Route / On Scene stamp mob if blank). */
export function statusPartial(dep, newStatus, { demobMs = null, today = utcToday() } = {}) {
  const p = { [D.status]: newStatus };
  if (isDemob(newStatus)) {
    const d = demobMs ?? today;
    p[D.demob] = d;
    const days = daysBetween(dep[D.mob], d);
    if (days != null) p[D.days] = days;
  }
  if (isGoing(newStatus) && blankNum(dep[D.mob])) {
    p[D.mob] = today;
    const days = daysBetween(today, dep[D.demob]);
    if (days != null) p[D.days] = days;
  }
  return p;
}

// ---------- location (ArcGIS World Geocoder, same as the RESL board) ----------
const GEOCODER = "https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer";
const TN_BIAS = "-86.6,35.86";
async function suggestAddresses(text) {
  const p = new URLSearchParams({ f: "json", text, countryCode: "USA", maxSuggestions: "6", location: TN_BIAS });
  const data = await (await fetch(`${GEOCODER}/suggest?${p}`)).json();
  if (data.error) throw new Error(data.error.message || "Suggest error");
  return (data.suggestions || []).map((s) => ({ text: s.text, magicKey: s.magicKey }));
}
async function geocodeAddress(text, { magicKey } = {}) {
  let token = null;
  try { await auth.ensureFreshToken(); token = auth.getToken(); } catch { /* try anonymously */ }
  const p = new URLSearchParams({ f: "json", outFields: "Match_addr,StAddr,Place_addr,City,Subregion,Region,RegionAbbr,Postal", forStorage: "true", maxLocations: "1", location: TN_BIAS, countryCode: "USA" });
  if (magicKey) { p.set("magicKey", magicKey); p.set("singleLine", text); } else p.set("singleLine", text);
  if (token) p.set("token", token);
  const data = await (await fetch(`${GEOCODER}/findAddressCandidates?${p}`)).json();
  if (data.error) throw new Error(data.error.message || "Geocode error");
  const c = (data.candidates || [])[0];
  if (!c) return null;
  const at = c.attributes || {};
  const isTn = String(at.RegionAbbr || "").toUpperCase() === "TN" || String(at.Region || "").toLowerCase() === "tennessee";
  const tn = isTn ? lookupTnCountyByName(at.Subregion) : null;
  return { street: at.StAddr || at.Place_addr || "", city: at.City || "", stateAbbr: String(at.RegionAbbr || "").toUpperCase(), zip: at.Postal || "", rawCounty: String(at.Subregion || "").replace(/\s+county$/i, "").trim(), matchedAddress: at.Match_addr || c.address || text, lng: c.location && c.location.x, lat: c.location && c.location.y, isTn, county: tn ? tn.county : null, region: tn ? tn.region : null };
}

/**
 * Wires a "type an address" box (input[data-loc-q] + ul[data-loc-list] + [data-loc-status]) inside `root`.
 * resolve() → { empty } | { attrs, geometry?, warn? }: the deployment fields for what is typed, geocoding it if needed.
 * If the address can't be placed, the typed text is still saved (warn: true) rather than blocking the save.
 */
function locationPicker(root) {
  const q = root.querySelector("[data-loc-q]"), list = root.querySelector("[data-loc-list]"), say = root.querySelector("[data-loc-status]");
  let picked = null, match = null, suggestions = [];
  const status = (t) => { if (say) say.textContent = t || ""; };
  const run = debounce(async () => {
    const t = q.value.trim();
    if (t.length < 3) { list.hidden = true; return; }
    try {
      suggestions = await suggestAddresses(t);
      list.innerHTML = suggestions.map((s, i) => `<li data-i="${i}">${esc(s.text)}</li>`).join("") || `<li class="grp">No matches</li>`;
      list.hidden = false;
    } catch { list.hidden = true; }
  }, 300);
  async function resolve() {
    const t = q.value.trim();
    if (!t) return { empty: true };
    if (!match) {
      status("Locating…");
      try { match = await geocodeAddress(t, { magicKey: picked && picked.magicKey }); }
      catch (err) { status(`Couldn't place it on the map (${err.message}). The text will still be saved.`); return { attrs: { [D.userInput]: t }, warn: true }; }
      if (!match) { status("No map match for that address. The text will still be saved."); return { attrs: { [D.userInput]: t }, warn: true }; }
    }
    status(match.isTn ? `${match.county || "?"} County · ${match.region || "?"} Region` : "Outside Tennessee: county and region from the request are kept.");
    const attrs = { [D.userInput]: t, [D.addressGeo]: match.matchedAddress };
    if (match.isTn) { if (match.county) attrs[D.county] = match.county; if (match.region) attrs[D.region] = match.region; }
    const ok = Number.isFinite(match.lng) && Number.isFinite(match.lat);
    // The same place as inventory fields, so the item itself can be moved there (only when it could be placed on the map).
    const itemAttrs = ok ? {
      [I.address]: match.street, [I.city]: match.city, [I.state]: match.stateAbbr, [I.zip]: match.zip,
      [I.county]: (match.county || match.rawCounty) ? `${match.county || match.rawCounty} County` : "",
      [I.lat]: Number(match.lat), [I.lng]: Number(match.lng),
      ...(match.isTn && match.region ? { [I.region]: match.region } : {}),
    } : null;
    return { attrs, ...(ok ? { geometry: { x: Number(match.lng), y: Number(match.lat), spatialReference: { wkid: 4326 } } } : {}), item: itemAttrs };
  }
  q.addEventListener("input", () => { picked = null; match = null; status(""); run(); });
  list.addEventListener("mousedown", async (e) => {
    const li = e.target.closest("[data-i]");
    if (!li) return;
    e.preventDefault();
    const s = suggestions[Number(li.dataset.i)];
    list.hidden = true; q.value = s.text; picked = s; match = null;
    await resolve(); // show the county/region right away
  });
  q.addEventListener("blur", () => setTimeout(() => (list.hidden = true), 150));
  return {
    el: q, resolve,
    get text() { return q.value.trim(); },
    setText(t) { q.value = t; picked = null; match = null; status(""); },
  };
}
const locationFieldHTML = (label, hint) => `<label>${label} <span class="hint">${hint}</span>
        <div class="combo"><input data-loc-q placeholder="Type an address or place…" autocomplete="off" /><ul data-loc-list hidden></ul></div>
        <span class="hint" data-loc-status></span></label>
      <label class="check" style="margin:.1rem 0 .6rem"><input type="checkbox" data-loc-move checked /> Also move the item's location in inventory to this address</label>`;
/** What to write on the inventory row so the item sits at the deployment: the placed address, "Deployed: MCC #n" as its building, no room. */
const movedItemChange = (place, requestNo) => (place && place.item
  ? { attrs: { ...place.item, [I.place]: `Deployed: MCC #${requestNo ?? "?"}`, [I.room]: "" }, geometry: place.geometry ? geometryFor(place.item[I.lat], place.item[I.lng]) : undefined }
  : null);

// ---------- side effects shared by both dialogs ----------
async function syncInventory(rows, value, extra = () => null) {
  const changes = rows.map((row) => {
    const x = extra(row);
    const attrs = { ...(value && hasMobField() ? { [CONFIG.INV.mobilizationStatus]: value(row) } : {}), ...(x ? x.attrs : {}) };
    return { row, attrs, geometry: x && x.geometry };
  }).filter((c) => Object.keys(c.attrs).length);
  if (!changes.length) return;
  try {
    await updateInventory(changes);
  } catch (err) {
    toast(`Saved, but the item's inventory record could not be updated (${err.message}).`, "error", 9000);
  }
}

/** Fire-and-forget copy into RESL's edit-history layer. Never throws. */
async function logDeploymentHistory({ before, after, action, changed }) {
  if (!M.HISTORY_URL) return;
  try {
    const H = M.HISTORY_FIELDS;
    const skip = new Set([D.objectId, D.globalId, "OBJECTID", "ObjectID", "GlobalID", "GLOBALID", "CreationDate", "Creator", "EditDate", "Editor", "_oid"]);
    const attrs = {};
    for (const [k, v] of Object.entries(after || {})) if (!skip.has(k)) attrs[k] = v;
    Object.assign(attrs, {
      [H.parentGlobalId]: (before && before[D.globalId]) ?? (after && after[D.globalId]) ?? null,
      [H.sourceOid]: (before && before._oid) ?? (after && after._oid) ?? null,
      [H.action]: action,
      [H.changedFields]: (changed || []).join(","),
      [H.changedBy]: fullName(S.me) || null,
      [H.changeTs]: Date.now(),
      [H.prevStatus]: before ? before[D.status] ?? null : null,
      [H.newStatus]: after ? after[D.status] ?? null : null,
    });
    await applyEdits(M.HISTORY_URL, { adds: [{ attributes: attrs }] });
  } catch (err) {
    console.warn("[mobilize] RESL history log failed:", err);
  }
}

const itemLine = (r) => `<div><span class="mono">${esc(r[I.tag] || "—")}</span> ${esc(itemTitle(r))} <span class="sub">${esc(itemMakeModel(r))}</span></div>`;

// ---------- Mobilize dialog ----------
export function openMobilizeDialog(rows) {
  if (!mobilizeEnabled()) return toast("Mobilize isn't set up (config.js → MOBILIZE).", "error");
  if (S.readonly || S.viewOnly) return toast("This link is view-only.", "error");
  if (!S.deploy.ready) return toast(`Can't check current mobilizations right now${S.deploy.error ? ` (${S.deploy.error})` : ""}. Try Refresh data.`, "error", 8000);
  const allowed = rows.filter(canMobilizeRow);
  const already = allowed.filter((r) => activeDeployment(r));
  const noTag = allowed.filter((r) => !activeDeployment(r) && !String(r[I.tag] || "").trim());
  const ok = allowed.filter((r) => !activeDeployment(r) && String(r[I.tag] || "").trim());
  if (!ok.length) return toast("Nothing to mobilize — items must be active, have a tag, not already be mobilized, and be ones you can change.", "error", 7000);
  const skippedOther = rows.length - allowed.length;

  let req = null, reqs = [], mission = "";
  const m = openModal({
    title: ok.length > 1 ? `Mobilize ${ok.length} items` : `Mobilize: ${itemTitle(ok[0])}`,
    wide: true,
    body: `
      <div class="sel-list">${ok.map(itemLine).join("")}</div>
      ${skippedOther ? `<div class="banner banner-warn">${skippedOther} selected item(s) skipped: retired, or not yours to change.</div>` : ""}
      ${already.length ? `<div class="banner banner-warn">${already.length} item(s) skipped: already mobilized (${already.slice(0, 3).map((r) => esc(r[I.tag])).join(", ")}${already.length > 3 ? "…" : ""}).</div>` : ""}
      ${noTag.length ? `<div class="banner banner-warn">${noTag.length} item(s) skipped: no tag number.</div>` : ""}
      <label>Mission <span class="hint">(click, then type to filter)</span>
        <input id="mob-mission" list="mob-mission-dl" placeholder="Loading missions…" autocomplete="off" disabled /><datalist id="mob-mission-dl"></datalist></label>
      <label>Request <span class="hint">(pick the MCC request these items are for)</span>
        <input id="mob-q" type="search" placeholder="Search number, subject, county, status…" autocomplete="off" disabled /></label>
      <div id="mob-reqs" class="mob-list" role="listbox" aria-label="MCC requests"><div class="sub" style="padding:.5rem">Choose a mission first.</div></div>
      ${locationFieldHTML("Deployed to", "(address or place, optional; filled from the request when it has one)")}
      <div class="two-col">
        <label>Starting status<select id="mob-status"><option value="">Decide later (Unassigned on the RESL board)</option>${M.START_STATUSES.map((s) => `<option ${s === M.DEFAULT_START_STATUS ? "selected" : ""}>${esc(s)}</option>`).join("")}</select></label>
        <label>Expected arrival <span class="hint">(optional)</span><input type="date" id="mob-arrival" /></label>
      </div>
      <label>Note <span class="hint">(optional, shows in the item's history)</span><input id="mob-note" maxlength="400" placeholder="e.g. requested by Shelby County EMA" /></label>`,
    buttons: [
      { label: "Cancel" },
      {
        label: "Mobilize", kind: "primary", id: "mob-ok",
        action: async () => {
          if (!req) throw new Error("Pick the request these items are for.");
          const status = $v("mob-status") || null;
          const arrival = ymdToUtc($v("mob-arrival"));
          const note = $v("mob-note").trim();
          const place = await loc.resolve();
          const attrsList = ok.map((row) => buildDeploymentAttrs(req, row, { status, arrival, loc: place.attrs }));
          const res = await applyEdits(M.DEPLOY_URL, { adds: attrsList.map((attributes) => ({ attributes, ...(place.geometry ? { geometry: place.geometry } : {}) })) });
          attrsList.forEach((attrs, i) => {
            const created = { ...attrs, _oid: res.addResults[i].objectId, [D.globalId]: res.addResults[i].globalId ?? null, [D.edit]: Date.now() };
            S.deploy.rows.push(created);
            logDeploymentHistory({ before: null, after: created, action: "create", changed: Object.keys(attrs) });
          });
          reindex();
          const move = !!m.el.querySelector("[data-loc-move]").checked && !!place.item;
          await syncInventory(ok, () => status || "Unassigned", move ? () => movedItemChange(place, req[C.number]) : undefined);
          const where = `MCC #${req[C.number]}${req[C.subject] ? ` ${String(req[C.subject]).slice(0, 80)}` : ""}`;
          await logAndWarn(ok.map((row) => ({ type: "Mobilized", row, toName: `MCC #${req[C.number]}`, note: [`${where} · ${status || "status not set"}`, place.attrs && place.attrs[D.userInput] ? `at ${place.attrs[D.userInput]}${move ? " (item location moved)" : ""}` : "", note].filter(Boolean).join(" · ") })));
          toast(`${ok.length} item${ok.length > 1 ? "s" : ""} mobilized to MCC #${req[C.number]}.`, "success");
          if (place.warn) toast("The address couldn't be placed on the map, so only the text was saved and the item's location was not moved.", "info", 8000);
          S.actions.refresh();
        },
      },
    ],
  });
  const $v = (id) => m.el.querySelector("#" + id).value;
  const okBtn = m.el.querySelector("#mob-ok");
  okBtn.disabled = true;
  const sel = m.el.querySelector("#mob-mission");
  const q = m.el.querySelector("#mob-q");
  const box = m.el.querySelector("#mob-reqs");
  const loc = locationPicker(m.el);
  let locTouched = false; // the person typed their own location: don't overwrite it with the request's
  loc.el.addEventListener("input", () => { locTouched = true; });

  const paintReqs = () => {
    const term = q.value;
    const shown = reqs.map((r, i) => ({ r, i })).filter(({ r }) => matchesSearch([r[C.number], r[C.subject], r[C.type], r[C.county], r[C.status], r[C.description], r[C.poc]], term));
    box.innerHTML = shown.map(({ r, i }) => `<button type="button" class="mob-req${req === r ? " on" : ""}" role="option" aria-selected="${req === r}" data-i="${i}">
        <b>#${esc(r[C.number])}</b> ${esc(r[C.subject] || "(no subject)")}
        <span class="sub">${esc([r[C.type], r[C.county], r[C.status]].filter(Boolean).join(" · "))}</span></button>`).join("")
      || `<div class="sub" style="padding:.5rem">${reqs.length ? "No request matches." : "This mission has no numbered requests."}</div>`;
  };
  box.addEventListener("click", (e) => {
    const b = e.target.closest("[data-i]");
    if (!b) return;
    req = reqs[Number(b.dataset.i)];
    okBtn.disabled = !req;
    if (!locTouched || !loc.text) {
      const t = req && (req[C.address] || req[C.deliveryLocation]);
      if (t) { loc.setText(String(t).trim()); locTouched = false; }
    }
    paintReqs();
  });
  q.addEventListener("input", debounce(paintReqs, 120));
  let missionList = [];
  // Type-to-filter: the browser's own list narrows as you type; a request list loads once the text matches a mission exactly.
  const onMission = async () => {
    const typed = sel.value.trim().toLowerCase();
    const hit = missionList.find((x) => x.id.toLowerCase() === typed);
    const next = hit ? hit.id : "";
    if (next === mission) return;
    mission = next; req = null; okBtn.disabled = true; reqs = []; q.value = "";
    if (!mission) { q.disabled = true; box.innerHTML = `<div class="sub" style="padding:.5rem">Choose a mission first.</div>`; return; }
    box.innerHTML = `<div class="sub" style="padding:.5rem">Loading requests…</div>`;
    try { reqs = await loadRequests(mission); q.disabled = false; paintReqs(); q.focus(); }
    catch (err) { box.innerHTML = `<div class="sub" style="padding:.5rem;color:#842029">Could not load requests: ${esc(err.message)}</div>`; }
  };
  sel.addEventListener("input", onMission);
  sel.addEventListener("change", onMission);
  loadMissions().then((list) => {
    missionList = list;
    m.el.querySelector("#mob-mission-dl").innerHTML = list.map((x) => `<option value="${esc(x.id)}">${x.count} request${x.count === 1 ? "" : "s"}${x.latest ? ` · latest ${new Date(x.latest).toLocaleDateString("en-US", { month: "numeric", day: "numeric", year: "numeric" })}` : ""}</option>`).join("");
    sel.disabled = false;
    sel.placeholder = list.length ? "Start typing a mission name or number…" : "No missions with requests found";
    sel.focus();
  }).catch((err) => { sel.placeholder = "Could not load missions"; m.setError(`Could not read the MCC service: ${err.message}`); });
  return m;
}

// ---------- Update status / Demobilize dialog ----------
export function openMobilizationDialog(rows, { preset = "" } = {}) {
  if (!mobilizeEnabled()) return toast("Mobilize isn't set up (config.js → MOBILIZE).", "error");
  if (S.readonly || S.viewOnly) return toast("This link is view-only.", "error");
  const pairs = rows.filter(canMobilizeRow).map((row) => ({ row, dep: activeDeployment(row) })).filter((p) => p.dep);
  if (!pairs.length) return toast("None of these items is currently mobilized (or you can't change them).", "error");
  const multi = pairs.length > 1;
  const m = openModal({
    title: multi ? `Update ${pairs.length} mobilized items` : `Mobilization: ${itemTitle(pairs[0].row)}`,
    body: `
      <div class="sel-list">${pairs.map(({ row, dep }) => `${itemLine(row)}<div class="sub" style="margin:-.1rem 0 .3rem 0">${esc(depLabel(dep))}${dep[D.mission] ? ` · ${esc(dep[D.mission])}` : ""}${dep[D.mob] ? ` · mobilized ${esc(fmtYmd(dep[D.mob]))}` : ""}</div>`).join("")}</div>
      <div class="two-col">
        <label>New status<select id="mu-status"><option value="">(no change)</option>${M.STATUSES.map((s) => `<option ${s === preset ? "selected" : ""}>${esc(s)}</option>`).join("")}</select></label>
        <label id="mu-date-wrap" hidden>Demobilization date<input type="date" id="mu-date" value="${todayYmd()}" /></label>
      </div>
      <label id="mu-back-wrap" hidden>Move the item's location back to <span class="hint">(optional)</span>
        <select id="mu-back"><option value="">(leave its location as it is)</option>${regionOptions().map((r) => `<option>${esc(r)}</option>`).join("")}</select></label>
      <details class="more"${pairs.some((p) => !p.dep[D.userInput] && !p.dep[D.addressGeo]) ? " open" : ""}><summary>Change location</summary>
        <div style="margin-top:.6rem">${locationFieldHTML("New location", "(leave blank to keep the current one)")}</div></details>
      <label>Note <span class="hint">(optional)</span><input id="mu-note" maxlength="400" placeholder="e.g. returned to Region warehouse" /></label>
      <p class="sub" id="mu-hint"></p>`,
    buttons: [
      { label: "Cancel" },
      {
        label: "Save", kind: "primary", id: "mu-ok",
        action: async () => {
          const status = $v("mu-status"); // "" = leave the status as it is
          const note = $v("mu-note").trim();
          const demobMs = isDemob(status) ? ymdToUtc($v("mu-date")) : null;
          const place = await loc.resolve();
          const hasLoc = !place.empty;
          const plans = pairs
            .map((p) => ({ ...p, prev: depStatus(p.dep), changed: !!status && depStatus(p.dep) !== status }))
            .filter((p) => p.changed || hasLoc);
          if (!plans.length) throw new Error("Nothing to change: pick a different status, or type a new location.");
          for (const p of plans) p.partial = { ...(p.changed ? statusPartial(p.dep, status, { demobMs }) : {}), ...(hasLoc ? place.attrs : {}) };
          await applyEdits(M.DEPLOY_URL, { updates: plans.map((p) => ({ attributes: { [D.objectId]: p.dep._oid, ...p.partial }, ...(hasLoc && place.geometry ? { geometry: place.geometry } : {}) })) });
          for (const p of plans) {
            const before = { ...p.dep };
            Object.assign(p.dep, p.partial, { [D.edit]: Date.now() });
            logDeploymentHistory({ before, after: { ...p.dep }, action: p.changed ? "status_change" : "edit", changed: Object.keys(p.partial) });
          }
          reindex();
          // Item location: a new address (if "also move the item" is ticked), else the office it is returning to on demobilize/cancel.
          const moveToNew = hasLoc && !!place.item && !!m.el.querySelector("[data-loc-move]").checked;
          const back = !hasLoc && /^(demobilized|cancell?ed)$/i.test(status) ? presetFor($v("mu-back")) : null;
          const moveFor = (p) => (moveToNew ? movedItemChange(place, p.dep[D.request]) : back ? { attrs: { ...back.attrs, [I.place]: "", [I.room]: "" }, geometry: back.geometry } : null);
          const byRow = new Map(plans.map((p) => [p.row, p]));
          await syncInventory(plans.map((p) => p.row), (row) => (byRow.get(row).changed ? status : null), (row) => moveFor(byRow.get(row)));
          await logAndWarn(plans.map((p) => ({
            type: p.changed && isDemob(status) ? "Demobilized" : "Mobilization updated", row: p.row, toName: `MCC #${p.dep[D.request] ?? "?"}`,
            note: [p.changed ? `${p.prev} → ${status}` : "", hasLoc ? `location → ${place.attrs[D.userInput]}${moveToNew ? " (item location moved)" : ""}` : "", back ? `item returned to ${$v("mu-back")}` : "", note].filter(Boolean).join(" · "),
          })));
          toast(`${plans.length} item${plans.length > 1 ? "s" : ""} updated.`, "success");
          if (hasLoc && place.warn) toast("The address couldn't be placed on the map, so only the text was saved.", "info", 8000);
          S.actions.refresh();
        },
      },
    ],
  });
  const $v = (id) => m.el.querySelector("#" + id).value;
  const loc = locationPicker(m.el);
  const sync = () => {
    const s = $v("mu-status");
    m.el.querySelector("#mu-date-wrap").hidden = !isDemob(s);
    m.el.querySelector("#mu-back-wrap").hidden = !/^(demobilized|cancell?ed)$/i.test(s);
    m.el.querySelector("#mu-hint").textContent = isDemob(s)
      ? "Demobilizing stamps the demobilization date and days deployed. The item can be mobilized again afterwards."
      : /^cancell?ed$/i.test(s) ? "Canceled closes the deployment without a demobilization date. The item can be mobilized again."
      : isGoing(s) ? "Sets the mobilization date to today if it is still blank." : "";
  };
  m.el.querySelector("#mu-status").addEventListener("change", sync);
  sync();
  return m;
}

// ---------- item drawer card ----------
export function mobilizationCardHTML(row) {
  if (!mobilizeEnabled()) return "";
  const dep = activeDeployment(row);
  const past = deploymentsFor(row).filter((d) => d !== dep).slice(0, 3);
  const can = canMobilizeRow(row);
  if (!S.deploy.ready) return S.deploy.error ? `<div class="card"><div class="sub">MOBILIZATION</div><div class="sub">Mobilization data couldn't be loaded (${esc(S.deploy.error)}).</div></div>` : "";
  if (!dep && !past.length && !can) return "";
  return `<div class="card mob-card">
    <div class="sub" style="margin-bottom:.3rem">MOBILIZATION</div>
    ${dep
      ? `<div><span class="status-pill ${/^on scene$/i.test(depStatus(dep)) ? "st-ok" : "st-pending"}">${esc(depStatus(dep))}</span> <b>MCC #${esc(dep[D.request] ?? "?")}</b></div>
         <div class="sub">${esc(dep[D.mission] || "")}${dep[D.county] ? ` · ${esc(dep[D.county])}` : ""}${dep[D.mob] ? ` · mobilized ${esc(fmtYmd(dep[D.mob]))}` : ""}${dep[D.arrival] ? ` · expected ${esc(fmtYmd(dep[D.arrival]))}` : ""}</div>
         ${dep[D.userInput] || dep[D.addressGeo] ? `<div class="sub">📍 ${esc(dep[D.userInput] || dep[D.addressGeo])}</div>` : ""}`
      : `<div class="unassigned">Not mobilized</div>`}
    ${past.length ? `<div class="sub" style="margin-top:.3rem">Past: ${past.map((d) => `MCC #${esc(d[D.request] ?? "?")} (${esc(depStatus(d))}${d[D.demob] ? ` ${esc(fmtYmd(d[D.demob]))}` : ""})`).join("; ")}</div>` : ""}
    ${can ? `<div class="drawer-actions">${dep
      ? `<button type="button" class="btn-sm" data-d="mobupdate">Update status…</button><button type="button" class="btn-sm" data-d="demobilize">Demobilize</button>`
      : `<button type="button" class="btn-sm btn-primary" data-d="mobilize">Mobilize…</button>`}</div>` : ""}
  </div>`;
}
