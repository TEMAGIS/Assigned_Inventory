// ---------------------------------------------------------------------------
// Assigned Inventory Console — startup.
//   1. Sign in with ArcGIS Online (OAuth + PKCE, shared/arcgis-auth.js).
//   2. Load the Users layer, find the signed-in person by email (same rule as the
//      Assigned Inventory Editor), then the whole Inventory layer.
//   3. Find the Activity log service (optional — everything works without it).
//   4. Show the tabs this person's role allows.
// ---------------------------------------------------------------------------

import { CONFIG } from "./config.js";
import { startSession } from "./shared/session.js";
import { queryAll, checkFieldNames } from "./shared/esri-client.js";
import { $, $$ } from "./shared/util.js";
import { setStatus, toast } from "./shared/ui.js";
import { S, I, U, reindexUsers, reindexInv, isBlankRow, fullName } from "./state.js";
import * as perm from "./permissions.js";
import { discoverLog, loadActivity, loadLists, initActivity } from "./activity.js";
import { initInventory, renderInventory, applyUrlFilters } from "./inventory.js";
import { openDrawer, refreshDrawer, closeDrawer } from "./drawer.js";
import { initPeople } from "./people.js";
import { initSettings } from "./settings.js";
import { initMine } from "./mine.js";
import "./importer.js";
import { chooseSources } from "./sources.js";
import { loadAudit } from "./audit.js";
import { initDataIssues, highIssueCount } from "./dataissues.js";
import { loadProblemsAll, initProblems, openReports } from "./problems.js";

const TABS = ["inv", "mine", "ppl", "act", "prob", "dat", "set"];

function tabAllowed(tab) {
  switch (tab) {
    case "ppl": return perm.canViewPeople(S.me);
    case "act": return perm.canSeeOversight(S.me);
    case "prob": return perm.canWorkCorrections(S.me);
    case "dat": return perm.isPropertyOfficer(S.me);
    case "set": return perm.canManageSettings(S.me);
    default: return true;
  }
}

function switchTab(tab) {
  if (!tabAllowed(tab)) tab = "inv";
  S.tab = tab;
  closeDrawer();
  $$("#tabs .tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  for (const t of TABS) $(`#screen-${t}`).hidden = t !== tab;
  S.render[tab] && S.render[tab]();
}

function refresh() {
  S.blankHidden = S.inv.filter(isBlankRow).length;
  S.render[S.tab] && S.render[S.tab]();
  refreshDrawer();
  updateBadges();
}
function updateBadges() {
  const pb = $("#prob-badge");
  if (pb) { const k = openReports().length; pb.textContent = k; pb.hidden = !k; }
  const db = $("#dat-badge");
  if (db && perm.isPropertyOfficer(S.me)) { const k = highIssueCount(); db.textContent = k; db.hidden = !k; }
  const b = $("#mine-badge");
  if (!b) return;
  const n = S.inv.filter((r) => String(r[I.assignedTo] || "") === String(S.me[U.edison])).length;
  b.textContent = n; b.hidden = !n;
}

async function loadAll() {
  setStatus("Loading people…");
  S.users = await queryAll(CONFIG.USERS_LAYER_URL, { pageSize: CONFIG.FETCH_PAGE_SIZE });
  reindexUsers();
  const [uSchema, iSchema] = await Promise.all([
    checkFieldNames(CONFIG.USERS_LAYER_URL, "Users layer", Object.values(U)),
    checkFieldNames(CONFIG.INVENTORY_LAYER_URL, "Inventory layer", Object.values(I)),
  ]);
  S.oid.usr = uSchema.objectIdField;
  S.usersHasOwnerField = !!uSchema.fields.length && uSchema.fields.some((f) => f.name === U.propertyOwnerOf);
  S.oid.inv = iSchema.objectIdField;
  const ownerField = (iSchema.fields || []).find((f) => f.name === I.propertyOwner);
  const cv = ownerField && ownerField.domain && ownerField.domain.codedValues;
  S.propertyOwners = cv ? cv.map((c) => ({ code: String(c.code), name: String(c.name) })).sort((a, b) => a.name.localeCompare(b.name)) : [];
  S.ownerDomainEditable = !!cv;
  // re-key the rows now that we know the real object-id field names
  S.users.forEach((u) => (u._oid = u[S.oid.usr] ?? u._oid));
  setStatus("Loading inventory…");
  S.inv = await queryAll(CONFIG.INVENTORY_LAYER_URL, {
    pageSize: CONFIG.FETCH_PAGE_SIZE, returnGeometry: true, oidField: S.oid.inv,
    onPage: (rows) => setStatus(`Loading inventory… ${rows.length}`),
  });
  reindexInv();
  S.blankHidden = S.inv.filter(isBlankRow).length;
}

async function loadLogAndLists() {
  try {
    await discoverLog();
    await Promise.all([loadActivity(), loadLists()]);
  } catch (err) {
    console.warn("Log service not available:", err);
  }
  try { await loadProblemsAll(); } catch (err) { console.warn("Problems service not available:", err); }
  try { await loadAudit(); } catch (err) { console.warn("Photo audit not available:", err); }
}

function blocked(message) {
  setStatus("");
  $("#not-provisioned-screen").hidden = false;
  $("#not-provisioned-message").textContent = message;
}

async function onReady({ me, profile }) {
  S.profile = profile;
  const params = new URLSearchParams(window.location.search);
  S.readonly = ["1", "true", "yes"].includes((params.get("readonly") || "").toLowerCase());

  try {
    await chooseSources();
    await loadAll();
  } catch (err) {
    console.error(err);
    return setStatus(`Could not load the layers: ${err.message}`, "error");
  }

  const email = (profile.email || me.email || "").trim().toLowerCase();
  const mine = S.users.find((u) => String(u[U.email] || "").trim().toLowerCase() === email);
  if (!mine) return blocked(`Signed in as ${email}, but there is no matching person in the Users layer. Ask an Inventory Administrator to add you.`);
  if (!perm.isActive(mine)) return blocked(`Your record (${fullName(mine)}) is marked inactive. Ask an Inventory Administrator to reactivate it.`);
  S.me = mine;
  $("#user-label").textContent = `${fullName(mine)} · ${perm.roleLabel(mine[U.permissions])}`;

  Object.assign(S.actions, {
    refresh,
    openDrawer: (oid) => { switchTab("inv"); renderInventory(); openDrawer(oid); },
    openItemByTag: (tag) => {
      const row = S.inv.find((r) => String(r[I.tag] || "") === String(tag));
      if (row) S.actions.openDrawer(row._oid); else toast(`No item with tag ${tag}.`, "error");
    },
  });

  initInventory(); initMine(); initPeople(); initActivity(); initProblems(); initDataIssues(); initSettings();
  await loadLogAndLists();

  applyUrlFilters(params);
  $("#readonly-badge").hidden = !S.readonly;
  if (S.viewOnly) { $("#readonly-badge").title = "You have view-only access. You can still confirm your items, or say you don't have one."; }
  for (const b of $$("#tabs .tab-btn")) b.hidden = !tabAllowed(b.dataset.tab);
  $("#tabs").hidden = false;
  $("#reload-btn").hidden = false;
  updateBadges();
  $("#tabs").addEventListener("click", (e) => { const b = e.target.closest("[data-tab]"); if (b) switchTab(b.dataset.tab); });
  $("#reload-btn").addEventListener("click", async () => {
    try {
      await loadAll(); await loadLogAndLists();
      refresh(); setStatus(""); toast("Data refreshed.", "success");
    } catch (err) { setStatus(err.message, "error"); }
  });

  setStatus("");
  switchTab(perm.isLimitedUser(mine) ? "mine" : "inv");
  if (!S.viewOnly && !S.activity.url && perm.isPropertyOfficer(mine)) {
    toast("History isn't set up yet — open Settings → Log service to create it.", "info", 9000);
  }
}

startSession({ onReady });
