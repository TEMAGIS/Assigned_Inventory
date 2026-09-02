import { CONFIG } from "./config.js?v=20260902a";
import * as auth from "./arcgis-auth.js?v=20260902a";
import * as esri from "./esri-client.js?v=20260902a";
import * as perm from "./permissions.js?v=20260902a";

const $ = (sel) => document.querySelector(sel);
const escapeHtml = (str) =>
  String(str ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// --- Chrome ---
const signInScreen = $("#sign-in-screen");
const notProvisionedScreen = $("#not-provisioned-screen");
const notProvisionedMessage = $("#not-provisioned-message");
const userLabel = $("#user-label");
const roleBadge = $("#role-badge");
const statusBar = $("#status-bar");
const topbarTabs = $("#topbar-tabs");
const usersTabBtn = $("#users-tab-btn");
const loginError = $("#login-error");
const oauthFallback = $("#oauth-fallback");
const oauthSignInBtn = $("#sign-in-btn");
const inventoryScreen = $("#inventory-screen");
const usersScreen = $("#users-screen");

let me = null; // signed-in user's Users feature
let usersRoster = []; // full Users layer, in memory
let usersByEdisonId = new Map();
let inventoryRoster = []; // full Inventory layer, in memory
// Discovered from each layer's live metadata during enterApp() (see
// esri.checkFieldNames) rather than assumed — "OBJECTID" is the common
// case but isn't guaranteed on every hosted layer. These fall back to
// "OBJECTID" until that check completes.
let OID_FIELD_INV = "OBJECTID";
let OID_FIELD_USR = "OBJECTID";

// ═══════════════════════════════════════════════════════════════
// Boot / sign-in
// ═══════════════════════════════════════════════════════════════
async function boot() {
  let result;
  try {
    result = await auth.boot();
  } catch (err) {
    signInScreen.hidden = false;
    showSignInScreen();
    setLoginError(err.message);
    return;
  }
  if (result === "popup") return;
  if (auth.isSignedIn()) {
    await enterApp();
  } else {
    showSignInScreen();
  }
}

function showSignInScreen() {
  signInScreen.hidden = false;
  auth
    .prepareAuthUrl()
    .then((url) => {
      oauthFallback.href = url;
      oauthFallback.hidden = false;
    })
    .catch((err) => console.warn("Could not pre-build ArcGIS auth URL:", err));
}

function setLoginError(message) {
  loginError.textContent = message || "";
  loginError.classList.toggle("visible", !!message);
}

oauthSignInBtn.addEventListener("click", async () => {
  try {
    setLoginError("");
    oauthSignInBtn.disabled = true;
    await auth.startSignIn();
    await enterApp();
  } catch (err) {
    setLoginError(err.message);
  } finally {
    oauthSignInBtn.disabled = false;
  }
});

function signOutAndReset() {
  auth.signOut();
  me = null;
  usersRoster = [];
  usersByEdisonId = new Map();
  inventoryRoster = [];
  inventoryScreen.hidden = true;
  usersScreen.hidden = true;
  topbarTabs.hidden = true;
  notProvisionedScreen.hidden = true;
  userLabel.textContent = "";
  roleBadge.hidden = true;
  $("#sign-out-btn").hidden = true;
  setStatus("");
  showSignInScreen();
}
$("#sign-out-btn").addEventListener("click", signOutAndReset);
$("#not-provisioned-signout-btn").addEventListener("click", signOutAndReset);

function setStatus(message, isError) {
  statusBar.hidden = !message;
  statusBar.textContent = message || "";
  statusBar.classList.toggle("error", !!isError);
}

async function enterApp() {
  signInScreen.hidden = true;
  setStatus("Loading your account…");
  userLabel.textContent = auth.getUsername() || "Signed in";
  $("#sign-out-btn").hidden = false;

  let profile;
  try {
    await auth.ensureFreshToken();
    profile = await auth.fetchProfile();
    if (profile && profile.fullName) userLabel.textContent = profile.fullName;
  } catch (err) {
    setStatus(`Could not load your ArcGIS profile: ${err.message}`, true);
    return;
  }

  try {
    setStatus("Loading users roster…");
    usersRoster = await esri.queryAllFeatures(CONFIG.USERS_LAYER_URL, {
      pageSize: CONFIG.ROSTER_FETCH_PAGE_SIZE,
    });
    usersByEdisonId = new Map(
      usersRoster
        .filter((u) => u.attributes[CONFIG.USR_EDISON_ID_FIELD])
        .map((u) => [String(u.attributes[CONFIG.USR_EDISON_ID_FIELD]), u])
    );
  } catch (err) {
    setStatus(`Failed to load the Users layer: ${err.message}`, true);
    return;
  }

  const [usrSchema, invSchema] = await Promise.all([
    esri.checkFieldNames(CONFIG.USERS_LAYER_URL, "Users layer", [
      CONFIG.USR_EDISON_ID_FIELD, CONFIG.USR_FIRST_NAME_FIELD, CONFIG.USR_LAST_NAME_FIELD,
      CONFIG.USR_FULL_NAME_FIELD, CONFIG.USR_EMAIL_FIELD, CONFIG.USR_SECTION_FIELD,
      CONFIG.USR_ACTIVE_FIELD, CONFIG.USR_PERMISSIONS_FIELD, CONFIG.USR_DESCRIPTION_FIELD,
      CONFIG.USR_SUPERVISOR_ID_FIELD, CONFIG.USR_IMAGE_URL_FIELD,
    ]),
    esri.checkFieldNames(CONFIG.INVENTORY_LAYER_URL, "Inventory layer", [
      CONFIG.INV_TAG_FIELD, CONFIG.INV_SERIAL_FIELD, CONFIG.INV_CATEGORY_FIELD, CONFIG.INV_STATUS_FIELD,
      CONFIG.INV_ITEM_FIELD, CONFIG.INV_MAKE_FIELD, CONFIG.INV_MODEL_FIELD, CONFIG.INV_DESCRIPTION_FIELD,
      CONFIG.INV_ASSIGNED_TO_FIELD, CONFIG.INV_DATE_ASSIGNED_FIELD, CONFIG.INV_REGION_FIELD,
      CONFIG.INV_PLACENAME_FIELD, CONFIG.INV_ROOM_FIELD, CONFIG.INV_COUNTY_FIELD, CONFIG.INV_ADDRESS_FIELD,
      CONFIG.INV_CITY_FIELD, CONFIG.INV_STATE_FIELD, CONFIG.INV_ZIP_FIELD, CONFIG.INV_LAT_FIELD, CONFIG.INV_LONG_FIELD,
    ]),
  ]);
  OID_FIELD_USR = usrSchema.objectIdField;
  OID_FIELD_INV = invSchema.objectIdField;

  me = perm.findCurrentUserRecord(usersRoster, profile && profile.email);
  if (!me) {
    setStatus("");
    notProvisionedMessage.textContent = profile && profile.email
      ? `Signed in as ${profile.email}, but no matching row was found in the Users layer. Ask a Property Officer to add you.`
      : "Could not determine your ArcGIS account email, so no matching Users row could be found.";
    notProvisionedScreen.hidden = false;
    return;
  }
  if (!perm.isActive(me)) {
    setStatus("");
    notProvisionedMessage.textContent = `Your Users record (${me.attributes[CONFIG.USR_FULL_NAME_FIELD] || ""}) is marked inactive. Ask a Property Officer to reactivate it.`;
    notProvisionedScreen.hidden = false;
    return;
  }

  const role = perm.roleOf(me) || "Unknown role";
  roleBadge.textContent = role;
  roleBadge.hidden = false;
  topbarTabs.hidden = false;
  usersTabBtn.hidden = !perm.canViewUsers(me);
  $("#inv-add-btn").hidden = !perm.canAddInventory(me);
  $("#usr-add-btn").hidden = !perm.canEditUsers(me);

  try {
    setStatus("Loading inventory…");
    inventoryRoster = await esri.queryAllFeatures(CONFIG.INVENTORY_LAYER_URL, {
      pageSize: CONFIG.ROSTER_FETCH_PAGE_SIZE,
      onPage: (rowsSoFar) => {
        // queryAllFeatures hands back the same array it keeps accumulating
        // into — assign it now so applyInvFilters() (which reads the
        // module-level `inventoryRoster`) sees rows as they stream in,
        // rather than filtering against last load's (or an empty) roster
        // until the whole fetch finishes.
        inventoryRoster = rowsSoFar;
        applyInvFilters();
      },
    });
  } catch (err) {
    setStatus(`Failed to load the Inventory layer: ${err.message}`, true);
    return;
  }
  setStatus("");

  buildInvRegionPills();
  buildInvAssignedPills();
  buildInvRegionSelectOptions();
  refreshInvDatalists();
  applyInvFilters();

  buildUsrSectionOptions();
  buildUsrPermissionsOptions();
  applyUsrFilters();

  showTab("inventory");
}

// ═══════════════════════════════════════════════════════════════
// Tabs
// ═══════════════════════════════════════════════════════════════
function showTab(tab) {
  document.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  inventoryScreen.hidden = tab !== "inventory";
  usersScreen.hidden = tab !== "users";
}
document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => showTab(btn.dataset.tab));
});

// ═══════════════════════════════════════════════════════════════
// INVENTORY — list, filters, search
// ═══════════════════════════════════════════════════════════════
const invList = $("#inv-list");
const invSearchInput = $("#inv-search-input");
const invRegionPillRow = $("#inv-region-pill-row");
const invAssignedPillRow = $("#inv-assigned-pill-row");
const invActiveFilters = $("#inv-active-filters");
const invPagerInfo = $("#inv-pager-info");
const invRegionSelect = $("#inv-region-select");
const invCategoryDatalist = $("#inv-category-datalist");
const invStatusDatalist = $("#inv-status-datalist");

let invSearchTerm = "";
let invActiveRegion = "";
let invActiveAssigned = ""; // "", "assigned", "unassigned"
let invFiltered = [];
let invRenderedCount = 0;
let selectedInvOid = null;
const RENDER_BATCH = CONFIG.RENDER_BATCH_SIZE;

function buildInvRegionPills() {
  invRegionPillRow.innerHTML = "";
  const allPill = document.createElement("button");
  allPill.type = "button"; allPill.className = "buft active"; allPill.textContent = "All";
  allPill.addEventListener("click", () => { invActiveRegion = ""; refreshInvPillStates(); applyInvFilters(); });
  invRegionPillRow.appendChild(allPill);
  for (const region of CONFIG.INV_REGION_OPTIONS) {
    const pill = document.createElement("button");
    pill.type = "button"; pill.className = "buft"; pill.dataset.region = region; pill.textContent = region;
    pill.addEventListener("click", () => { invActiveRegion = region; refreshInvPillStates(); applyInvFilters(); });
    invRegionPillRow.appendChild(pill);
  }
}
function refreshInvPillStates() {
  [...invRegionPillRow.children].forEach((el, i) => el.classList.toggle("active", i === 0 ? !invActiveRegion : el.dataset.region === invActiveRegion));
  [...invAssignedPillRow.children].forEach((el) => el.classList.toggle("active", (el.dataset.value || "") === invActiveAssigned));
}
function buildInvAssignedPills() {
  invAssignedPillRow.innerHTML = "";
  for (const [label, value] of [["All", ""], ["Assigned", "assigned"], ["Unassigned", "unassigned"]]) {
    const pill = document.createElement("button");
    pill.type = "button"; pill.className = "buft" + (value === "" ? " active" : ""); pill.dataset.value = value; pill.textContent = label;
    pill.addEventListener("click", () => { invActiveAssigned = value; refreshInvPillStates(); applyInvFilters(); });
    invAssignedPillRow.appendChild(pill);
  }
}
function buildInvRegionSelectOptions() {
  invRegionSelect.innerHTML = '<option value="">—</option>';
  for (const region of CONFIG.INV_REGION_OPTIONS) {
    const opt = document.createElement("option"); opt.value = region; opt.textContent = region;
    invRegionSelect.appendChild(opt);
  }
}
function refreshInvDatalists() {
  const categories = new Set(), statuses = new Set();
  for (const f of inventoryRoster) {
    const c = (f.attributes[CONFIG.INV_CATEGORY_FIELD] || "").trim();
    const s = (f.attributes[CONFIG.INV_STATUS_FIELD] || "").trim();
    if (c) categories.add(c);
    if (s) statuses.add(s);
  }
  invCategoryDatalist.innerHTML = [...categories].sort().map((c) => `<option value="${escapeHtml(c)}"></option>`).join("");
  invStatusDatalist.innerHTML = [...statuses].sort().map((s) => `<option value="${escapeHtml(s)}"></option>`).join("");
}

function invMatches(f) {
  const a = f.attributes;
  if (invSearchTerm) {
    const hay = CONFIG.INV_SEARCH_FIELDS.map((k) => a[k]).filter(Boolean).join(" ").toLowerCase();
    if (!hay.includes(invSearchTerm)) return false;
  }
  if (invActiveRegion && (a[CONFIG.INV_REGION_FIELD] || "").toLowerCase() !== invActiveRegion.toLowerCase()) return false;
  const assigned = !!a[CONFIG.INV_ASSIGNED_TO_FIELD];
  if (invActiveAssigned === "assigned" && !assigned) return false;
  if (invActiveAssigned === "unassigned" && assigned) return false;
  return true;
}
function applyInvFilters() {
  invFiltered = inventoryRoster.filter(invMatches);
  invFiltered.sort((a, b) =>
    (a.attributes[CONFIG.INV_TAG_FIELD] || "").localeCompare(b.attributes[CONFIG.INV_TAG_FIELD] || "", undefined, { numeric: true })
  );
  invRenderedCount = 0;
  invList.innerHTML = "";
  updateInvActiveFiltersBar();
  revealMoreInv();
}
function updateInvActiveFiltersBar() {
  const chips = [];
  if (invActiveRegion) chips.push(["Region", invActiveRegion, () => { invActiveRegion = ""; refreshInvPillStates(); applyInvFilters(); }]);
  if (invActiveAssigned) chips.push([invActiveAssigned === "assigned" ? "Assigned" : "Unassigned", "", () => { invActiveAssigned = ""; refreshInvPillStates(); applyInvFilters(); }]);
  invActiveFilters.innerHTML = "";
  for (const [label, value, onClear] of chips) {
    const chip = document.createElement("span"); chip.className = "filter-chip";
    chip.innerHTML = `${escapeHtml(label)}${value ? ": " + escapeHtml(value) : ""} <button type="button" aria-label="Clear">&times;</button>`;
    chip.querySelector("button").addEventListener("click", onClear);
    invActiveFilters.appendChild(chip);
  }
}
function revealMoreInv() {
  const batch = invFiltered.slice(invRenderedCount, invRenderedCount + RENDER_BATCH);
  if (batch.length === 0) {
    updateInvPager();
    if (invList.children.length === 0) invList.innerHTML = `<li class="empty">No inventory items match.</li>`;
    return;
  }
  for (const f of batch) {
    const a = f.attributes;
    const oid = a[OID_FIELD_INV];
    const li = document.createElement("li");
    li.className = "row-item"; li.dataset.oid = oid;
    const assignee = a[CONFIG.INV_ASSIGNED_TO_FIELD] ? usersByEdisonId.get(String(a[CONFIG.INV_ASSIGNED_TO_FIELD])) : null;
    const assigneeName = assignee ? (assignee.attributes[CONFIG.USR_FULL_NAME_FIELD] || "") : "";
    const badge = a[CONFIG.INV_ASSIGNED_TO_FIELD]
      ? `<span class="badge badge-assigned">Assigned</span>`
      : `<span class="badge badge-unassigned">Unassigned</span>`;
    const sub = [a[CONFIG.INV_ITEM_FIELD], a[CONFIG.INV_MAKE_FIELD], a[CONFIG.INV_MODEL_FIELD]].filter(Boolean).join(" · ");
    li.innerHTML = `<div class="name">${escapeHtml(a[CONFIG.INV_TAG_FIELD] || "(no tag)")}${badge}</div>
      <div class="sub">${escapeHtml(sub)}</div>
      <div class="sub">${assigneeName ? "Assigned to " + escapeHtml(assigneeName) : ""}</div>`;
    li.addEventListener("click", () => selectInventory(oid));
    if (String(oid) === String(selectedInvOid)) li.classList.add("selected");
    invList.appendChild(li);
  }
  invRenderedCount += batch.length;
  updateInvPager();
  if (invRenderedCount < invFiltered.length && invList.scrollHeight <= invList.clientHeight + 200) revealMoreInv();
}
function updateInvPager() {
  invPagerInfo.textContent = invFiltered.length ? `${invRenderedCount} of ${invFiltered.length} items` : "";
}
invList.addEventListener("scroll", () => {
  if (invList.scrollHeight - invList.scrollTop - invList.clientHeight < 200) revealMoreInv();
});
let invSearchDebounce = null;
invSearchInput.addEventListener("input", () => {
  clearTimeout(invSearchDebounce);
  invSearchDebounce = setTimeout(() => { invSearchTerm = invSearchInput.value.trim().toLowerCase(); applyInvFilters(); }, 150);
});

// ═══════════════════════════════════════════════════════════════
// INVENTORY — edit form
// ═══════════════════════════════════════════════════════════════
const invEditForm = $("#inv-edit-form");
const invEditPanel = $("#inv-edit-panel");
const invEmptyState = $("#inv-empty-state");
const invAppLayout = $("#inventory-screen");
const invSaveBtn = $("#inv-save-btn");
const invDeleteBtn = $("#inv-delete-btn");
const invIdentityFieldset = $("#inv-identity-fieldset");
const invAssignmentFieldset = $("#inv-assignment-fieldset");
const invLocationFieldset = $("#inv-location-fieldset");
const invAssigneeInput = $("#inv-assignee-input");
const invAssigneeHidden = $("#inv-assignee-hidden");
const invAssigneeClear = $("#inv-assignee-clear");
const invAssigneeListbox = $("#inv-assignee-listbox");
const invLatInput = $("#inv-lat-input");
const invLongInput = $("#inv-long-input");

let currentInvGroups = { identity: false, assignment: false, location: false };
let currentInvIsNew = false;
let invMap = null, invMarker = null;

function setFieldsetEditable(fieldset, editable) {
  fieldset.querySelectorAll("input, select, textarea, button").forEach((el) => { el.disabled = !editable; });
  fieldset.classList.toggle("is-readonly", !editable);
}

$("#inv-add-btn").addEventListener("click", () => showInventoryEditor(null));
$("#inv-edit-back-btn").addEventListener("click", () => invAppLayout.classList.remove("showing-edit"));

function selectInventory(oid) {
  const record = inventoryRoster.find((f) => String(f.attributes[OID_FIELD_INV]) === String(oid));
  if (!record) return;
  selectedInvOid = oid;
  [...invList.children].forEach((li) => li.classList.toggle("selected", li.dataset.oid === String(oid)));
  showInventoryEditor(record);
}

function showInventoryEditor(record) {
  currentInvIsNew = !record;
  invEmptyState.hidden = true;
  invEditPanel.hidden = false;
  invAppLayout.classList.add("showing-edit");

  currentInvGroups = currentInvIsNew
    ? { identity: true, assignment: true, location: true }
    : perm.editableGroups(record, me, usersByEdisonId);

  setFieldsetEditable(invIdentityFieldset, currentInvGroups.identity);
  setFieldsetEditable(invAssignmentFieldset, currentInvGroups.assignment);
  setFieldsetEditable(invLocationFieldset, currentInvGroups.location);
  const canSave = currentInvIsNew || perm.canEditAnything(currentInvGroups);
  invSaveBtn.hidden = !canSave;
  invDeleteBtn.hidden = currentInvIsNew || !perm.canDeleteInventory(me);
  invEditForm.dataset.oid = record ? record.attributes[OID_FIELD_INV] : "";

  const a = record ? record.attributes : {};
  invEditForm.tag_number.value = a[CONFIG.INV_TAG_FIELD] || "";
  invEditForm.serial_number.value = a[CONFIG.INV_SERIAL_FIELD] || "";
  invEditForm.item_category.value = a[CONFIG.INV_CATEGORY_FIELD] || "";
  invEditForm.item.value = a[CONFIG.INV_ITEM_FIELD] || "";
  invEditForm.make.value = a[CONFIG.INV_MAKE_FIELD] || "";
  invEditForm.model.value = a[CONFIG.INV_MODEL_FIELD] || "";
  invEditForm.status.value = a[CONFIG.INV_STATUS_FIELD] || "";
  invEditForm.description.value = a[CONFIG.INV_DESCRIPTION_FIELD] || "";

  const assignedEdisonId = a[CONFIG.INV_ASSIGNED_TO_FIELD] || "";
  invAssigneeHidden.value = assignedEdisonId;
  const assignee = assignedEdisonId ? usersByEdisonId.get(String(assignedEdisonId)) : null;
  invAssigneeInput.value = assignee ? (assignee.attributes[CONFIG.USR_FULL_NAME_FIELD] || "") : "";
  invAssigneeClear.hidden = !assignedEdisonId;
  invEditForm.date_assigned.value = formatDateForInput(a[CONFIG.INV_DATE_ASSIGNED_FIELD]);

  invEditForm.region.value = a[CONFIG.INV_REGION_FIELD] || "";
  invEditForm.placename.value = a[CONFIG.INV_PLACENAME_FIELD] || "";
  invEditForm.room.value = a[CONFIG.INV_ROOM_FIELD] || "";
  invEditForm.county.value = a[CONFIG.INV_COUNTY_FIELD] || "";
  invEditForm.address.value = a[CONFIG.INV_ADDRESS_FIELD] || "";
  invEditForm.city.value = a[CONFIG.INV_CITY_FIELD] || "";
  invEditForm.state.value = a[CONFIG.INV_STATE_FIELD] || "";
  invEditForm.zip.value = a[CONFIG.INV_ZIP_FIELD] || "";

  let lat = a[CONFIG.INV_LAT_FIELD];
  let lng = a[CONFIG.INV_LONG_FIELD];
  if ((lat == null || lng == null) && record && record.geometry) {
    lat = record.geometry.y; lng = record.geometry.x;
  }
  invLatInput.value = lat != null ? lat : "";
  invLongInput.value = lng != null ? lng : "";

  ensureInvMap();
  requestAnimationFrame(() => {
    invMap.invalidateSize();
    if (lat != null && lng != null) placeInvMarker(Number(lat), Number(lng), false);
    else clearInvMarker();
  });
}

function formatDateForInput(v) {
  if (!v) return "";
  const d = typeof v === "number" ? new Date(v) : new Date(v);
  if (isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}

function ensureInvMap() {
  if (invMap) return;
  invMap = L.map("inv-map").setView([CONFIG.MAP_DEFAULT_LAT, CONFIG.MAP_DEFAULT_LONG], CONFIG.MAP_DEFAULT_ZOOM);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, attribution: "&copy; OpenStreetMap contributors",
  }).addTo(invMap);
  invMap.on("click", (e) => {
    if (!currentInvGroups.location) return;
    placeInvMarker(e.latlng.lat, e.latlng.lng, true);
  });
}
function clearInvMarker() {
  if (invMarker) { invMap.removeLayer(invMarker); invMarker = null; }
  invMap.setView([CONFIG.MAP_DEFAULT_LAT, CONFIG.MAP_DEFAULT_LONG], CONFIG.MAP_DEFAULT_ZOOM);
}
function placeInvMarker(lat, lng, fromMapInteraction) {
  invLatInput.value = lat.toFixed(6);
  invLongInput.value = lng.toFixed(6);
  if (invMarker) {
    invMarker.setLatLng([lat, lng]);
  } else {
    invMarker = L.marker([lat, lng], { draggable: currentInvGroups.location }).addTo(invMap);
    invMarker.on("dragend", () => { const p = invMarker.getLatLng(); placeInvMarker(p.lat, p.lng, true); });
  }
  invMarker.dragging[currentInvGroups.location ? "enable" : "disable"]();
  if (fromMapInteraction) invMap.panTo([lat, lng]); else invMap.setView([lat, lng], Math.max(invMap.getZoom(), 13));
}
// Manual lat/long typing also updates the marker.
function onLatLongTyped() {
  const lat = parseFloat(invLatInput.value), lng = parseFloat(invLongInput.value);
  if (!isNaN(lat) && !isNaN(lng) && currentInvGroups.location) { ensureInvMap(); placeInvMarker(lat, lng, false); }
}
invLatInput.addEventListener("change", onLatLongTyped);
invLongInput.addEventListener("change", onLatLongTyped);

// --- Assignee combobox ---
let invAssigneeHighlight = -1;
function assigneeOptions(filterText) {
  const term = (filterText || "").trim().toLowerCase();
  return usersRoster
    .filter((u) => perm.isActive(u))
    .filter((u) => !term || (u.attributes[CONFIG.USR_FULL_NAME_FIELD] || "").toLowerCase().includes(term))
    .sort((a, b) => (a.attributes[CONFIG.USR_FULL_NAME_FIELD] || "").localeCompare(b.attributes[CONFIG.USR_FULL_NAME_FIELD] || ""))
    .slice(0, 50);
}
function renderAssigneeListbox(filterText) {
  const matches = assigneeOptions(filterText);
  const rows = matches.map((u) => {
    const name = u.attributes[CONFIG.USR_FULL_NAME_FIELD] || "";
    const section = u.attributes[CONFIG.USR_SECTION_FIELD] || "";
    return `<li class="combo-option" role="option" data-edison-id="${escapeHtml(u.attributes[CONFIG.USR_EDISON_ID_FIELD])}" data-name="${escapeHtml(name)}">${escapeHtml(name)}${section ? ` <span style="color:var(--text-muted)">(${escapeHtml(section)})</span>` : ""}</li>`;
  });
  invAssigneeListbox.innerHTML = rows.length ? rows.join("") : `<li class="combo-option-empty">No users match.</li>`;
  invAssigneeListbox.hidden = false;
  invAssigneeHighlight = -1;
}
function closeAssigneeListbox() { invAssigneeListbox.hidden = true; invAssigneeHighlight = -1; }
function pickAssignee(edisonId, name) {
  invAssigneeHidden.value = edisonId; invAssigneeInput.value = name; invAssigneeClear.hidden = !edisonId;
  closeAssigneeListbox();
}
invAssigneeInput.addEventListener("focus", () => { if (!invAssigneeInput.disabled) renderAssigneeListbox(invAssigneeInput.value); });
invAssigneeInput.addEventListener("input", () => renderAssigneeListbox(invAssigneeInput.value));
invAssigneeInput.addEventListener("keydown", (e) => {
  const options = [...invAssigneeListbox.querySelectorAll(".combo-option[data-edison-id]")];
  if (e.key === "ArrowDown") { e.preventDefault(); invAssigneeHighlight = Math.min(invAssigneeHighlight + 1, options.length - 1); }
  else if (e.key === "ArrowUp") { e.preventDefault(); invAssigneeHighlight = Math.max(invAssigneeHighlight - 1, 0); }
  else if (e.key === "Enter") { e.preventDefault(); const opt = options[invAssigneeHighlight] || options[0]; if (opt) pickAssignee(opt.dataset.edisonId, opt.dataset.name); return; }
  else if (e.key === "Escape") { closeAssigneeListbox(); return; }
  else return;
  options.forEach((o, i) => o.classList.toggle("highlighted", i === invAssigneeHighlight));
});
invAssigneeListbox.addEventListener("mousedown", (e) => {
  const li = e.target.closest(".combo-option[data-edison-id]");
  if (li) pickAssignee(li.dataset.edisonId, li.dataset.name);
});
invAssigneeClear.addEventListener("click", () => pickAssignee("", ""));
document.addEventListener("click", (e) => { if (!e.target.closest("#inv-assignee-combo")) closeAssigneeListbox(); });

invDeleteBtn.addEventListener("click", async () => {
  const oid = invEditForm.dataset.oid;
  if (!oid) return;
  if (!confirm("Delete this inventory item? This cannot be undone.")) return;
  try {
    setStatus("Deleting…");
    await esri.applyEdits(CONFIG.INVENTORY_LAYER_URL, { deletes: [Number(oid)] });
    inventoryRoster = inventoryRoster.filter((f) => String(f.attributes[OID_FIELD_INV]) !== String(oid));
    invEditPanel.hidden = true; invEmptyState.hidden = false;
    invAppLayout.classList.remove("showing-edit");
    applyInvFilters();
    setStatus("Deleted.");
  } catch (err) {
    setStatus(`Delete failed: ${err.message}`, true);
  }
});

invEditForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const oid = invEditForm.dataset.oid;
  const attrs = {};
  if (currentInvGroups.identity) {
    attrs[CONFIG.INV_TAG_FIELD] = invEditForm.tag_number.value || "";
    attrs[CONFIG.INV_SERIAL_FIELD] = invEditForm.serial_number.value || "";
    attrs[CONFIG.INV_CATEGORY_FIELD] = invEditForm.item_category.value || "";
    attrs[CONFIG.INV_ITEM_FIELD] = invEditForm.item.value || "";
    attrs[CONFIG.INV_MAKE_FIELD] = invEditForm.make.value || "";
    attrs[CONFIG.INV_MODEL_FIELD] = invEditForm.model.value || "";
    attrs[CONFIG.INV_STATUS_FIELD] = invEditForm.status.value || "";
    attrs[CONFIG.INV_DESCRIPTION_FIELD] = invEditForm.description.value || "";
  }
  if (currentInvGroups.assignment) {
    attrs[CONFIG.INV_ASSIGNED_TO_FIELD] = invAssigneeHidden.value || null;
    attrs[CONFIG.INV_DATE_ASSIGNED_FIELD] = invEditForm.date_assigned.value
      ? new Date(invEditForm.date_assigned.value).getTime()
      : null;
  }
  let geometry;
  if (currentInvGroups.location) {
    attrs[CONFIG.INV_REGION_FIELD] = invEditForm.region.value || "";
    attrs[CONFIG.INV_PLACENAME_FIELD] = invEditForm.placename.value || "";
    attrs[CONFIG.INV_ROOM_FIELD] = invEditForm.room.value || "";
    attrs[CONFIG.INV_COUNTY_FIELD] = invEditForm.county.value || "";
    attrs[CONFIG.INV_ADDRESS_FIELD] = invEditForm.address.value || "";
    attrs[CONFIG.INV_CITY_FIELD] = invEditForm.city.value || "";
    attrs[CONFIG.INV_STATE_FIELD] = invEditForm.state.value || "";
    attrs[CONFIG.INV_ZIP_FIELD] = invEditForm.zip.value || "";
    const lat = parseFloat(invLatInput.value), lng = parseFloat(invLongInput.value);
    if (!isNaN(lat) && !isNaN(lng)) {
      attrs[CONFIG.INV_LAT_FIELD] = lat;
      attrs[CONFIG.INV_LONG_FIELD] = lng;
      if (CONFIG.INV_HAS_GEOMETRY) geometry = { x: lng, y: lat, spatialReference: { wkid: 4326 } };
    }
  }

  invSaveBtn.disabled = true;
  const originalLabel = invSaveBtn.textContent;
  invSaveBtn.textContent = "Saving…";
  setStatus("Saving…");
  try {
    if (currentInvIsNew) {
      const newOid = await esri.addFeature(CONFIG.INVENTORY_LAYER_URL, attrs, geometry);
      const newRecord = { attributes: { [OID_FIELD_INV]: newOid, ...attrs }, geometry };
      inventoryRoster.push(newRecord);
      selectedInvOid = newOid;
    } else {
      await esri.updateFeature(CONFIG.INVENTORY_LAYER_URL, OID_FIELD_INV, Number(oid), attrs, geometry);
      const cached = inventoryRoster.find((f) => String(f.attributes[OID_FIELD_INV]) === String(oid));
      if (cached) { Object.assign(cached.attributes, attrs); if (geometry) cached.geometry = geometry; }
    }
    refreshInvDatalists();
    applyInvFilters();
    setStatus("Saved.");
    invSaveBtn.textContent = "✓ Saved";
    invSaveBtn.classList.add("save-success");
    invSaveBtn.disabled = false;
    setTimeout(() => { invSaveBtn.classList.remove("save-success"); invSaveBtn.textContent = originalLabel; }, 2200);
  } catch (err) {
    setStatus(`Save failed: ${err.message}`, true);
    invSaveBtn.textContent = originalLabel;
    invSaveBtn.disabled = false;
  }
});

// ═══════════════════════════════════════════════════════════════
// USERS — list, filters, search
// ═══════════════════════════════════════════════════════════════
const usrList = $("#usr-list");
const usrSearchInput = $("#usr-search-input");
const usrActiveFilters = $("#usr-active-filters");
const usrPagerInfo = $("#usr-pager-info");
const usrSectionSelect = $("#usr-section-select");
const usrPermissionsSelect = $("#usr-permissions-select");

let usrSearchTerm = "";
let usrFiltered = [];
let usrRenderedCount = 0;
let selectedUsrOid = null;

function buildUsrSectionOptions() {
  usrSectionSelect.innerHTML = '<option value="">—</option>';
  for (const s of CONFIG.USR_SECTION_OPTIONS) {
    const opt = document.createElement("option"); opt.value = s; opt.textContent = s;
    usrSectionSelect.appendChild(opt);
  }
}
function buildUsrPermissionsOptions() {
  usrPermissionsSelect.innerHTML = '<option value="">—</option>';
  for (const r of [CONFIG.USR_ROLE_PROPERTY_OFFICER, CONFIG.USR_ROLE_MANAGER, CONFIG.USR_ROLE_NON_MANAGER]) {
    const opt = document.createElement("option"); opt.value = r; opt.textContent = r;
    usrPermissionsSelect.appendChild(opt);
  }
}
function usrMatches(u) {
  if (!usrSearchTerm) return true;
  const a = u.attributes;
  const hay = [a[CONFIG.USR_FULL_NAME_FIELD], a[CONFIG.USR_SECTION_FIELD], a[CONFIG.USR_EDISON_ID_FIELD], a[CONFIG.USR_EMAIL_FIELD]]
    .filter(Boolean).join(" ").toLowerCase();
  return hay.includes(usrSearchTerm);
}
function applyUsrFilters() {
  usrFiltered = usersRoster.filter(usrMatches);
  usrFiltered.sort((a, b) => (a.attributes[CONFIG.USR_LAST_NAME_FIELD] || "").localeCompare(b.attributes[CONFIG.USR_LAST_NAME_FIELD] || ""));
  usrRenderedCount = 0;
  usrList.innerHTML = "";
  revealMoreUsr();
}
function revealMoreUsr() {
  const batch = usrFiltered.slice(usrRenderedCount, usrRenderedCount + RENDER_BATCH);
  if (batch.length === 0) {
    updateUsrPager();
    if (usrList.children.length === 0) usrList.innerHTML = `<li class="empty">No users match.</li>`;
    return;
  }
  for (const u of batch) {
    const a = u.attributes;
    const oid = a[OID_FIELD_USR];
    const li = document.createElement("li");
    li.className = "row-item"; li.dataset.oid = oid;
    const inactiveBadge = perm.isActive(u) ? "" : `<span class="badge badge-inactive">Inactive</span>`;
    li.innerHTML = `<div class="name">${escapeHtml(a[CONFIG.USR_FULL_NAME_FIELD] || "(no name)")}${inactiveBadge}</div>
      <div class="sub">${escapeHtml([a[CONFIG.USR_PERMISSIONS_FIELD], a[CONFIG.USR_SECTION_FIELD]].filter(Boolean).join(" · "))}</div>`;
    li.addEventListener("click", () => selectUsr(oid));
    if (String(oid) === String(selectedUsrOid)) li.classList.add("selected");
    usrList.appendChild(li);
  }
  usrRenderedCount += batch.length;
  updateUsrPager();
  if (usrRenderedCount < usrFiltered.length && usrList.scrollHeight <= usrList.clientHeight + 200) revealMoreUsr();
}
function updateUsrPager() { usrPagerInfo.textContent = usrFiltered.length ? `${usrRenderedCount} of ${usrFiltered.length} users` : ""; }
usrList.addEventListener("scroll", () => { if (usrList.scrollHeight - usrList.scrollTop - usrList.clientHeight < 200) revealMoreUsr(); });
let usrSearchDebounce = null;
usrSearchInput.addEventListener("input", () => {
  clearTimeout(usrSearchDebounce);
  usrSearchDebounce = setTimeout(() => { usrSearchTerm = usrSearchInput.value.trim().toLowerCase(); applyUsrFilters(); }, 150);
});

// ═══════════════════════════════════════════════════════════════
// USERS — edit form
// ═══════════════════════════════════════════════════════════════
const usrEditForm = $("#usr-edit-form");
const usrEditPanel = $("#usr-edit-panel");
const usrEmptyState = $("#usr-empty-state");
const usrAppLayout = $("#users-screen");
const usrSaveBtn = $("#usr-save-btn");
const usrQrPreview = $("#usr-qr-preview");
const usrQrFile = $("#usr-qr-file");

let currentUsrIsNew = false;

$("#usr-add-btn").addEventListener("click", () => showUsrEditor(null));
$("#usr-edit-back-btn").addEventListener("click", () => usrAppLayout.classList.remove("showing-edit"));

function selectUsr(oid) {
  const record = usersRoster.find((u) => String(u.attributes[OID_FIELD_USR]) === String(oid));
  if (!record) return;
  selectedUsrOid = oid;
  [...usrList.children].forEach((li) => li.classList.toggle("selected", li.dataset.oid === String(oid)));
  showUsrEditor(record);
}

function showUsrEditor(record) {
  currentUsrIsNew = !record;
  usrEmptyState.hidden = true;
  usrEditPanel.hidden = false;
  usrAppLayout.classList.add("showing-edit");
  usrEditForm.dataset.oid = record ? record.attributes[OID_FIELD_USR] : "";

  const editable = currentUsrIsNew || perm.canEditUsers(me);
  usrEditForm.querySelectorAll("input, select, textarea").forEach((el) => { el.disabled = !editable; });
  usrSaveBtn.hidden = !editable;
  usrQrFile.disabled = !editable;

  const a = record ? record.attributes : {};
  usrEditForm.edison_id.value = a[CONFIG.USR_EDISON_ID_FIELD] || "";
  usrEditForm.first_name.value = a[CONFIG.USR_FIRST_NAME_FIELD] || "";
  usrEditForm.last_name.value = a[CONFIG.USR_LAST_NAME_FIELD] || "";
  usrEditForm.email.value = a[CONFIG.USR_EMAIL_FIELD] || "";
  usrEditForm.tema_section.value = a[CONFIG.USR_SECTION_FIELD] || "";
  usrEditForm.permissions.value = a[CONFIG.USR_PERMISSIONS_FIELD] || "";
  usrEditForm.active.checked = currentUsrIsNew ? true : perm.isActive(record);
  usrEditForm.supervisor_id.value = a[CONFIG.USR_SUPERVISOR_ID_FIELD] || "";
  usrEditForm.description.value = a[CONFIG.USR_DESCRIPTION_FIELD] || "";
  usrEditForm.image_url.value = a[CONFIG.USR_IMAGE_URL_FIELD] || "";
  usrQrFile.value = "";
  usrQrPreview.hidden = true;

  if (record && record.attributes[OID_FIELD_USR]) {
    esri
      .listAttachments(CONFIG.USERS_LAYER_URL, record.attributes[OID_FIELD_USR])
      .then((atts) => {
        const qr = atts.find((x) => /qr/i.test(x.name || ""));
        if (qr) {
          usrQrPreview.src = esri.attachmentUrl(CONFIG.USERS_LAYER_URL, record.attributes[OID_FIELD_USR], qr.id);
          usrQrPreview.hidden = false;
        }
      })
      .catch(() => {});
  }
}

usrEditForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const oid = usrEditForm.dataset.oid;
  const attrs = {
    [CONFIG.USR_EDISON_ID_FIELD]: usrEditForm.edison_id.value || "",
    [CONFIG.USR_FIRST_NAME_FIELD]: usrEditForm.first_name.value || "",
    [CONFIG.USR_LAST_NAME_FIELD]: usrEditForm.last_name.value || "",
    [CONFIG.USR_FULL_NAME_FIELD]: [usrEditForm.first_name.value, usrEditForm.last_name.value].filter(Boolean).join(" "),
    [CONFIG.USR_EMAIL_FIELD]: usrEditForm.email.value || "",
    [CONFIG.USR_SECTION_FIELD]: usrEditForm.tema_section.value || "",
    [CONFIG.USR_PERMISSIONS_FIELD]: usrEditForm.permissions.value || "",
    [CONFIG.USR_ACTIVE_FIELD]: usrEditForm.active.checked ? "yes" : "no",
    [CONFIG.USR_SUPERVISOR_ID_FIELD]: usrEditForm.supervisor_id.value || "",
    [CONFIG.USR_DESCRIPTION_FIELD]: usrEditForm.description.value || "",
    [CONFIG.USR_IMAGE_URL_FIELD]: usrEditForm.image_url.value || "",
  };

  usrSaveBtn.disabled = true;
  const originalLabel = usrSaveBtn.textContent;
  usrSaveBtn.textContent = "Saving…";
  setStatus("Saving…");
  try {
    let finalOid = oid ? Number(oid) : null;
    if (currentUsrIsNew) {
      finalOid = await esri.addFeature(CONFIG.USERS_LAYER_URL, attrs);
      usersRoster.push({ attributes: { [OID_FIELD_USR]: finalOid, ...attrs } });
    } else {
      await esri.updateFeature(CONFIG.USERS_LAYER_URL, OID_FIELD_USR, finalOid, attrs);
      const cached = usersRoster.find((u) => String(u.attributes[OID_FIELD_USR]) === String(finalOid));
      if (cached) Object.assign(cached.attributes, attrs);
    }
    usersByEdisonId = new Map(
      usersRoster.filter((u) => u.attributes[CONFIG.USR_EDISON_ID_FIELD]).map((u) => [String(u.attributes[CONFIG.USR_EDISON_ID_FIELD]), u])
    );
    if (usrQrFile.files && usrQrFile.files[0] && finalOid) {
      await esri.addAttachment(CONFIG.USERS_LAYER_URL, finalOid, usrQrFile.files[0]);
    }
    applyUsrFilters();
    applyInvFilters(); // assignee names shown in the Inventory list may have changed
    setStatus("Saved.");
    usrSaveBtn.textContent = "✓ Saved";
    usrSaveBtn.classList.add("save-success");
    usrSaveBtn.disabled = false;
    setTimeout(() => { usrSaveBtn.classList.remove("save-success"); usrSaveBtn.textContent = originalLabel; }, 2200);
  } catch (err) {
    setStatus(`Save failed: ${err.message}`, true);
    usrSaveBtn.textContent = originalLabel;
    usrSaveBtn.disabled = false;
  }
});

boot();
