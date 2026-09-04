import { CONFIG } from "./config.js?v=20260904b";
import * as auth from "./arcgis-auth.js?v=20260904b";
import * as esri from "./esri-client.js?v=20260904b";
import * as perm from "./permissions.js?v=20260904b";

const $ = (sel) => document.querySelector(sel);
const escapeHtml = (str) =>
  String(str ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// --- Chrome ---
const signInScreen = $("#sign-in-screen");
const notProvisionedScreen = $("#not-provisioned-screen");
const notProvisionedMessage = $("#not-provisioned-message");
const userLabel = $("#user-label");
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
// URL parameters — lets a link be shared pre-configured for someone who
// doesn't need the full app: a "just let me look things up" link for
// staff who shouldn't be editing, or a link scoped to one section for
// that section's own people. Neither is a security boundary (see the
// trust-model note in README.md) — sharing/role enforcement on the two
// feature layers is what actually decides who can read or write; these
// two params only steer what the UI *offers* someone who's already
// signed in and provisioned, same spirit as permissions.js.
//
//   ?readonly=1   — hides every Save/Add control and disables every
//                   field (including photo add/delete), regardless of
//                   what the signed-in user's role would otherwise
//                   allow. Viewing (including photos) still works.
//   ?section=Xyz  — pre-selects the "Section" filter pill on BOTH tabs:
//                   Users filters on the record's own tema_section;
//                   Inventory filters on its assignee's tema_section
//                   (Inventory records have no section field of their
//                   own — see invMatches()). Matched case-insensitively
//                   against the known section list (config + anything
//                   extra seen in the live roster, same list the section
//                   pills themselves are built from — see
//                   allSectionValues()); an unrecognized value is
//                   ignored (logged to the console) rather than
//                   silently filtering everything out. The pill stays a
//                   normal, clearable filter afterward — this just sets
//                   where it starts.
// ═══════════════════════════════════════════════════════════════
const URL_PARAMS = new URLSearchParams(window.location.search);
const FORCE_READ_ONLY = /^(1|true|yes)$/i.test((URL_PARAMS.get("readonly") || "").trim());
const URL_SECTION_RAW = URL_PARAMS.get("section");
/** Resolves ?section=<raw> against the known section list. Called from
 * enterApp() once usersRoster (and therefore allSectionValues()) is
 * ready — see that function, defined further down near the Users
 * section filter it was built for. Returns null (and logs a warning) for
 * anything that doesn't match. */
function resolveUrlSection() {
  if (!URL_SECTION_RAW) return null;
  const target = URL_SECTION_RAW.trim().toLowerCase();
  const match = allSectionValues().find((s) => s.toLowerCase() === target);
  if (!match) console.warn(`[url params] ?section=${URL_SECTION_RAW} did not match any known section — ignoring.`);
  return match || null;
}
$("#readonly-badge").hidden = !FORCE_READ_ONLY;

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
      CONFIG.INV_EDIT_DATE_FIELD,
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

  topbarTabs.hidden = false;
  usersTabBtn.hidden = !perm.canViewUsers(me);
  $("#inv-add-btn").hidden = FORCE_READ_ONLY || !perm.canAddInventory(me);
  $("#usr-add-btn").hidden = FORCE_READ_ONLY || !perm.canEditUsers(me);

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
  buildInvSectionPills();
  buildInvRegionSelectOptions();
  refreshInvDatalists();

  buildUsrSectionOptions();
  buildUsrPermissionsOptions();
  buildUsrSectionPills();

  // Apply ?section=<name> (if it matches a known section) before the
  // very first render, so both lists open already scoped instead of
  // flashing "everything" and then narrowing a moment later.
  const urlSection = resolveUrlSection();
  if (urlSection) {
    invActiveSection = urlSection;
    usrActiveSection = urlSection;
    refreshInvPillStates();
    refreshUsrPillStates();
  }

  applyInvFilters();
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
const invSectionPillRow = $("#inv-section-pill-row");
const invActiveFilters = $("#inv-active-filters");
const invPagerInfo = $("#inv-pager-info");
const invRegionSelect = $("#inv-region-select");
const invCategoryDatalist = $("#inv-category-datalist");
const invStatusDatalist = $("#inv-status-datalist");
const invPlacenameDatalist = $("#inv-placename-datalist");
const invFilterBtn = $("#inv-filter-btn");
const invFilterDrawer = $("#inv-filter-drawer");
const invFilterClose = $("#inv-filter-close");
const invFilterCount = $("#inv-filter-count");

let invSearchTerm = "";
let invActiveRegion = "";
let invActiveAssigned = ""; // "", "assigned", "unassigned"
// Not an Inventory field — filters on the assignee's OWN tema_section
// (looked up via assigned_to → usersByEdisonId), same section value the
// Users tab's own section filter/pills use. See invMatches() below and
// buildInvSectionPills() near buildInvAssignedPills().
let invActiveSection = "";
let invFiltered = [];
let invRenderedCount = 0;
let selectedInvOid = null;
const RENDER_BATCH = CONFIG.RENDER_BATCH_SIZE;
// Building/other location → the rest of that location's fields, derived
// from whatever's already in the loaded roster (same "learn from live
// data" approach the category/status datalists use) — so picking an
// already-used location name prepopulates county/address/city/state/zip
// and the map point, rather than re-typing (or re-clicking a map pin for)
// a place that's already on file for some other item.
let knownLocationsByPlacename = new Map();

// --- Filter drawer: closed by default, opens OVER the list (same idea
// as the sibling PREDS mobile app's filter drawer) rather than pills
// sitting always-on in the list header. ---
function openInvFilterDrawer() {
  invFilterDrawer.hidden = false;
  requestAnimationFrame(() => invFilterDrawer.classList.add("open"));
  invFilterBtn.setAttribute("aria-expanded", "true");
}
function closeInvFilterDrawer() {
  invFilterDrawer.classList.remove("open");
  invFilterBtn.setAttribute("aria-expanded", "false");
  setTimeout(() => {
    if (!invFilterDrawer.classList.contains("open")) invFilterDrawer.hidden = true;
  }, 180);
}
invFilterBtn.addEventListener("click", () => (invFilterDrawer.hidden ? openInvFilterDrawer() : closeInvFilterDrawer()));
invFilterClose.addEventListener("click", closeInvFilterDrawer);
document.addEventListener("click", (e) => {
  if (invFilterDrawer.hidden) return;
  if (e.target.closest("#inv-filter-drawer") || e.target.closest("#inv-filter-btn")) return;
  closeInvFilterDrawer();
});
function updateInvFilterCount() {
  const count = (invActiveRegion ? 1 : 0) + (invActiveAssigned ? 1 : 0) + (invActiveSection ? 1 : 0);
  invFilterCount.hidden = count === 0;
  invFilterCount.textContent = String(count);
}

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
/**
 * "Section" pills for the Inventory filter drawer — filters by the
 * ASSIGNEE's tema_section (Inventory has no section field of its own;
 * see invMatches()). Reuses allSectionValues() (defined down in the
 * Users section, where it was first needed) so both tabs' section pills
 * always list exactly the same options, including any legacy/unlisted
 * section value actually present in the roster.
 */
function buildInvSectionPills() {
  invSectionPillRow.innerHTML = "";
  const allPill = document.createElement("button");
  allPill.type = "button"; allPill.className = "buft active"; allPill.textContent = "All";
  allPill.addEventListener("click", () => { invActiveSection = ""; refreshInvPillStates(); applyInvFilters(); });
  invSectionPillRow.appendChild(allPill);
  for (const section of allSectionValues()) {
    const pill = document.createElement("button");
    pill.type = "button"; pill.className = "buft"; pill.dataset.section = section; pill.textContent = section;
    pill.addEventListener("click", () => { invActiveSection = section; refreshInvPillStates(); applyInvFilters(); });
    invSectionPillRow.appendChild(pill);
  }
}
function refreshInvPillStates() {
  [...invRegionPillRow.children].forEach((el, i) => el.classList.toggle("active", i === 0 ? !invActiveRegion : el.dataset.region === invActiveRegion));
  [...invAssignedPillRow.children].forEach((el) => el.classList.toggle("active", (el.dataset.value || "") === invActiveAssigned));
  [...invSectionPillRow.children].forEach((el, i) => el.classList.toggle("active", i === 0 ? !invActiveSection : el.dataset.section === invActiveSection));
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
  const categories = new Set(), statuses = new Set(), placenames = new Set();
  knownLocationsByPlacename = new Map();
  for (const f of inventoryRoster) {
    const a = f.attributes;
    const c = (a[CONFIG.INV_CATEGORY_FIELD] || "").trim();
    const s = (a[CONFIG.INV_STATUS_FIELD] || "").trim();
    if (c) categories.add(c);
    if (s) statuses.add(s);

    const placename = (a[CONFIG.INV_PLACENAME_FIELD] || "").trim();
    if (!placename) continue;
    placenames.add(placename);
    let lat = a[CONFIG.INV_LAT_FIELD];
    let lng = a[CONFIG.INV_LONG_FIELD];
    if ((lat == null || lng == null) && f.geometry) {
      lat = f.geometry.y;
      lng = f.geometry.x;
    }
    knownLocationsByPlacename.set(placename.toLowerCase(), {
      region: a[CONFIG.INV_REGION_FIELD] || "",
      county: a[CONFIG.INV_COUNTY_FIELD] || "",
      address: a[CONFIG.INV_ADDRESS_FIELD] || "",
      city: a[CONFIG.INV_CITY_FIELD] || "",
      state: a[CONFIG.INV_STATE_FIELD] || "",
      zip: a[CONFIG.INV_ZIP_FIELD] || "",
      lat: lat != null ? Number(lat) : null,
      lng: lng != null ? Number(lng) : null,
    });
  }
  invCategoryDatalist.innerHTML = [...categories].sort().map((c) => `<option value="${escapeHtml(c)}"></option>`).join("");
  invStatusDatalist.innerHTML = [...statuses].sort().map((s) => `<option value="${escapeHtml(s)}"></option>`).join("");
  invPlacenameDatalist.innerHTML = [...placenames].sort().map((p) => `<option value="${escapeHtml(p)}"></option>`).join("");
}

/**
 * When the "Building / other location" field is set to a value that
 * already exists somewhere in the loaded roster, fills in the rest of
 * that location's fields (region/county/address/city/state/zip + map
 * point) from whatever was on file for it — so re-using a known location
 * doesn't mean re-typing (or re-pinning on the map) something already
 * captured on some other item. Only runs when the location group is
 * actually editable; a no-op silently returns otherwise.
 */
function applyKnownLocation(placenameRaw) {
  if (!currentInvGroups.location) return;
  const known = knownLocationsByPlacename.get((placenameRaw || "").trim().toLowerCase());
  if (!known) return;
  invEditForm.region.value = known.region;
  invEditForm.county.value = known.county;
  invEditForm.address.value = known.address;
  invEditForm.city.value = known.city;
  invEditForm.state.value = known.state;
  invEditForm.zip.value = known.zip;
  if (known.lat != null && known.lng != null) {
    ensureInvMap();
    placeInvMarker(known.lat, known.lng, false);
  }
}

// Fields checked to decide a record is "blank" — a row with none of these
// set isn't a real inventory item (no tag, no item details), just an
// empty/placeholder row somewhere in the layer (seen in testing: several
// rows with no tag and no item info at all). Hidden from the list
// entirely, regardless of search/filters — see invMatches() below.
const INV_BLANK_CHECK_FIELDS = [
  CONFIG.INV_TAG_FIELD, CONFIG.INV_SERIAL_FIELD, CONFIG.INV_ITEM_FIELD,
  CONFIG.INV_MAKE_FIELD, CONFIG.INV_MODEL_FIELD, CONFIG.INV_CATEGORY_FIELD,
  CONFIG.INV_DESCRIPTION_FIELD,
];
function isBlankInventoryRecord(a) {
  return INV_BLANK_CHECK_FIELDS.every((f) => !String(a[f] || "").trim());
}

let invBlankHiddenCount = 0;

function invMatches(f) {
  const a = f.attributes;
  if (isBlankInventoryRecord(a)) return false;
  if (invSearchTerm) {
    const hay = CONFIG.INV_SEARCH_FIELDS.map((k) => a[k]).filter(Boolean).join(" ").toLowerCase();
    if (!hay.includes(invSearchTerm)) return false;
  }
  if (invActiveRegion && (a[CONFIG.INV_REGION_FIELD] || "").toLowerCase() !== invActiveRegion.toLowerCase()) return false;
  const assignedToId = a[CONFIG.INV_ASSIGNED_TO_FIELD];
  const assigned = !!assignedToId;
  if (invActiveAssigned === "assigned" && !assigned) return false;
  if (invActiveAssigned === "unassigned" && assigned) return false;
  if (invActiveSection) {
    // Not a field on Inventory itself — look up the current assignee's
    // OWN tema_section on the Users roster. An unassigned item has no
    // section to match, so it's excluded whenever a section filter is
    // active (same as it would be under "Assigned" above).
    const assignee = assignedToId ? usersByEdisonId.get(String(assignedToId)) : null;
    const assigneeSection = assignee ? (assignee.attributes[CONFIG.USR_SECTION_FIELD] || "") : "";
    if (assigneeSection !== invActiveSection) return false;
  }
  return true;
}
/**
 * Parses an editor-tracking date value into epoch milliseconds. ArcGIS
 * returns these as a numeric epoch already (Date.parse can't handle a
 * bare number — it stringifies first, which mangles it — so numbers are
 * used as-is); a date string is also accepted just in case. Returns NaN
 * for anything missing/unparseable.
 */
function parseEditDateMs(value) {
  if (value === null || value === undefined || value === "") return NaN;
  return typeof value === "number" ? value : Date.parse(value);
}
/** Formats an editor-tracking date value as a compact date + time (e.g.
 * "9/3/26, 2:14 PM") for the list's minimal fourth line. Returns "" for
 * anything missing/unparseable, so callers can just skip the line rather
 * than printing "Invalid Date". */
function formatEditDateTime(value) {
  const ms = parseEditDateMs(value);
  if (!Number.isFinite(ms)) return "";
  return new Date(ms).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
}
function applyInvFilters() {
  invBlankHiddenCount = inventoryRoster.reduce((n, f) => n + (isBlankInventoryRecord(f.attributes) ? 1 : 0), 0);
  invFiltered = inventoryRoster.filter(invMatches);
  // Most-recently-edited first (see INV_EDIT_DATE_FIELD in config.js) —
  // more useful day-to-day than an alphabetical tag sort, since it
  // surfaces whatever people are actively touching right now. Records
  // with no usable edit date (editor tracking off, or just never
  // touched) sort to the bottom, falling back to tag-number order among
  // themselves rather than an arbitrary one.
  invFiltered.sort((a, b) => {
    const da = parseEditDateMs(a.attributes[CONFIG.INV_EDIT_DATE_FIELD]);
    const db = parseEditDateMs(b.attributes[CONFIG.INV_EDIT_DATE_FIELD]);
    const va = Number.isFinite(da) ? da : -Infinity;
    const vb = Number.isFinite(db) ? db : -Infinity;
    if (va !== vb) return vb - va;
    return (a.attributes[CONFIG.INV_TAG_FIELD] || "").localeCompare(b.attributes[CONFIG.INV_TAG_FIELD] || "", undefined, { numeric: true });
  });
  invRenderedCount = 0;
  invList.innerHTML = "";
  updateInvActiveFiltersBar();
  revealMoreInv();
}
function updateInvActiveFiltersBar() {
  const chips = [];
  if (invActiveRegion) chips.push(["Region", invActiveRegion, () => { invActiveRegion = ""; refreshInvPillStates(); applyInvFilters(); }]);
  if (invActiveAssigned) chips.push([invActiveAssigned === "assigned" ? "Assigned" : "Unassigned", "", () => { invActiveAssigned = ""; refreshInvPillStates(); applyInvFilters(); }]);
  if (invActiveSection) chips.push(["Section", invActiveSection, () => { invActiveSection = ""; refreshInvPillStates(); applyInvFilters(); }]);
  invActiveFilters.innerHTML = "";
  for (const [label, value, onClear] of chips) {
    const chip = document.createElement("span"); chip.className = "filter-chip";
    chip.innerHTML = `${escapeHtml(label)}${value ? ": " + escapeHtml(value) : ""} <button type="button" aria-label="Clear">&times;</button>`;
    chip.querySelector("button").addEventListener("click", onClear);
    invActiveFilters.appendChild(chip);
  }
  updateInvFilterCount();
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
    const assignLine = assigneeName ? "Assigned to " + assigneeName : "";
    const editedText = formatEditDateTime(a[CONFIG.INV_EDIT_DATE_FIELD]);
    li.innerHTML = `<div class="name">${escapeHtml(a[CONFIG.INV_TAG_FIELD] || "(no tag)")}${badge}</div>
      <div class="sub">${escapeHtml(sub)}</div>
      <div class="sub">${escapeHtml(assignLine)}</div>
      ${editedText ? `<div class="sub sub-faint">Edited ${escapeHtml(editedText)}</div>` : ""}`;
    li.addEventListener("click", () => selectInventory(oid));
    if (String(oid) === String(selectedInvOid)) li.classList.add("selected");
    invList.appendChild(li);
  }
  invRenderedCount += batch.length;
  updateInvPager();
  if (invRenderedCount < invFiltered.length && invList.scrollHeight <= invList.clientHeight + 200) revealMoreInv();
}
function updateInvPager() {
  const base = invFiltered.length ? `${invRenderedCount} of ${invFiltered.length} items` : "";
  const blankNote = invBlankHiddenCount
    ? `${base ? " — " : ""}${invBlankHiddenCount} blank record${invBlankHiddenCount === 1 ? "" : "s"} hidden`
    : "";
  invPagerInfo.textContent = base + blankNote;
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
const invEditSubtitle = $("#inv-edit-subtitle");
const invEditPanel = $("#inv-edit-panel");
const invEmptyState = $("#inv-empty-state");
const invAppLayout = $("#inventory-screen");
const invSaveBtn = $("#inv-save-btn");
const invIdentityFieldset = $("#inv-identity-fieldset");
const invAssignmentFieldset = $("#inv-assignment-fieldset");
const invLocationFieldset = $("#inv-location-fieldset");
const invAssigneeInput = $("#inv-assignee-input");
const invAssigneeHidden = $("#inv-assignee-hidden");
const invAssigneeClear = $("#inv-assignee-clear");
const invAssigneeListbox = $("#inv-assignee-listbox");
const invLatInput = $("#inv-lat-input");
const invLongInput = $("#inv-long-input");
const invPhotoGrid = $("#inv-photo-grid");
const invPhotoEmpty = $("#inv-photo-empty");
const invPhotoNewList = $("#inv-photo-new-list");
const invPhotoFile = $("#inv-photo-file");
const invPhotoStatus = $("#inv-photo-status");

let currentInvGroups = { identity: false, assignment: false, location: false };
let currentInvIsNew = false;
let invMap = null, invMarker = null;
// Attachments (photos) on the currently-open Inventory record — see the
// "Photos" block below, past the assignee combobox. invCurrentAttachments
// mirrors what listAttachments() returned for the open record;
// invPendingPhotoFiles holds files picked before a brand-new record has
// been saved yet (no objectId to attach to until then — same reasoning
// as the Users tab's QR upload, extended to support more than one file).
let invCurrentAttachments = [];
let invPendingPhotoFiles = [];

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

/**
 * Second line under the "Item" toolbar title — same tag + item/make/model
 * summary shown in the list row, so the record being edited is still
 * identifiable once you've scrolled down past the fields. `a` can be a
 * plain attributes object (initial load) or the live form (kept in sync
 * as those four fields are typed — see the input listeners below).
 */
function updateInvEditSubtitle(a) {
  if (currentInvIsNew && !a[CONFIG.INV_TAG_FIELD]) {
    invEditSubtitle.textContent = "";
    return;
  }
  const details = [a[CONFIG.INV_ITEM_FIELD], a[CONFIG.INV_MAKE_FIELD], a[CONFIG.INV_MODEL_FIELD]].filter(Boolean).join(" · ");
  invEditSubtitle.textContent = [a[CONFIG.INV_TAG_FIELD] || "(no tag)", details].filter(Boolean).join(" — ");
}
function subtitleFieldsFromForm() {
  return {
    [CONFIG.INV_TAG_FIELD]: invEditForm.tag_number.value,
    [CONFIG.INV_ITEM_FIELD]: invEditForm.item.value,
    [CONFIG.INV_MAKE_FIELD]: invEditForm.make.value,
    [CONFIG.INV_MODEL_FIELD]: invEditForm.model.value,
  };
}
["tag_number", "item", "make", "model"].forEach((fieldName) => {
  invEditForm[fieldName].addEventListener("input", () => updateInvEditSubtitle(subtitleFieldsFromForm()));
});

function showInventoryEditor(record) {
  currentInvIsNew = !record;
  invEmptyState.hidden = true;
  invEditPanel.hidden = false;
  invAppLayout.classList.add("showing-edit");

  // FORCE_READ_ONLY (?readonly=1) overrides whatever the signed-in
  // user's role would otherwise allow — see the URL parameters block
  // near the top of this file.
  currentInvGroups = FORCE_READ_ONLY
    ? { identity: false, assignment: false, location: false }
    : currentInvIsNew
      ? { identity: true, assignment: true, location: true }
      : perm.editableGroups(record, me, usersByEdisonId);

  setFieldsetEditable(invIdentityFieldset, currentInvGroups.identity);
  setFieldsetEditable(invAssignmentFieldset, currentInvGroups.assignment);
  setFieldsetEditable(invLocationFieldset, currentInvGroups.location);
  const canSave = !FORCE_READ_ONLY && (currentInvIsNew || perm.canEditAnything(currentInvGroups));
  invSaveBtn.hidden = !canSave;
  invEditForm.dataset.oid = record ? record.attributes[OID_FIELD_INV] : "";

  // Photos — reset whatever was queued/shown for whichever record was
  // open before this one, then load this record's real attachments (if
  // it has any yet). See permissions.js canEditPhotos() for why this is
  // gated on "can edit anything here" rather than its own role rule.
  const canEditInvPhotos = !FORCE_READ_ONLY && perm.canEditPhotos(currentInvGroups, currentInvIsNew);
  invPendingPhotoFiles.forEach((f) => URL.revokeObjectURL(f.__previewUrl));
  invPendingPhotoFiles = [];
  renderPendingPhotoList();
  invPhotoFile.value = "";
  invPhotoFile.disabled = !canEditInvPhotos;
  invPhotoStatus.textContent = "";
  invCurrentAttachments = [];
  renderInvPhotoGrid(canEditInvPhotos);
  if (record && record.attributes[OID_FIELD_INV]) {
    esri
      .listAttachments(CONFIG.INVENTORY_LAYER_URL, record.attributes[OID_FIELD_INV])
      .then((atts) => { invCurrentAttachments = atts; renderInvPhotoGrid(canEditInvPhotos); })
      .catch(() => { invPhotoStatus.textContent = "Could not load photos."; });
  }

  const a = record ? record.attributes : {};
  updateInvEditSubtitle(a);
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

/** Today's date in the local timezone, formatted for a native <input
 * type="date"> (YYYY-MM-DD) — deliberately local rather than
 * toISOString()'s UTC, which can read as yesterday/tomorrow depending on
 * the browser's timezone. */
function todayForInput() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
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

// Selecting (or typing an exact match for) an already-used "Building /
// other location" prepopulates the rest of that location's fields — see
// applyKnownLocation()/refreshInvDatalists() above.
invEditForm.placename.addEventListener("input", () => applyKnownLocation(invEditForm.placename.value));

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
  // A genuine new assignment (picking someone who isn't already the
  // assignee — not the initial form population, which sets these inputs
  // directly rather than through pickAssignee) auto-stamps today's date
  // so whoever's assigning it out doesn't have to also go pick a date —
  // the field stays a normal editable date input, so it's still there to
  // fix or backdate afterward.
  if (edisonId && edisonId !== invAssigneeHidden.value) {
    invEditForm.date_assigned.value = todayForInput();
  }
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

// --- Photos ---
// Viewing a record's photos never depends on permission — every signed-in
// user can see what's attached (matching the PREDS mobile app's read-only
// attachment viewer this was modeled on). Only the "+ Add photo" control
// and each thumbnail's delete button are gated, via the `editable` flag
// callers pass in (perm.canEditPhotos(currentInvGroups, currentInvIsNew)).
function invPhotoUrl(attachmentId) {
  const oid = invEditForm.dataset.oid;
  return oid ? esri.attachmentUrl(CONFIG.INVENTORY_LAYER_URL, Number(oid), attachmentId) : "";
}
function renderInvPhotoGrid(editable) {
  invPhotoGrid.innerHTML = invCurrentAttachments.map((att) => {
    const isImage = (att.contentType || "").startsWith("image/");
    const url = invPhotoUrl(att.id);
    const name = att.name || "photo";
    const delBtn = editable
      ? `<button type="button" class="photo-delete-btn" data-att-id="${att.id}" aria-label="Delete ${escapeHtml(name)}">&times;</button>`
      : "";
    if (isImage) {
      return `<div class="photo-tile" role="listitem" data-att-id="${att.id}"><img src="${escapeHtml(url)}" alt="${escapeHtml(name)}" loading="lazy" />${delBtn}</div>`;
    }
    // Non-image attachments (e.g. a PDF spec sheet) get a file tile that
    // opens the attachment in a new tab instead of the lightbox.
    return `<div class="photo-tile photo-tile-file" role="listitem" data-att-id="${att.id}"><a href="${escapeHtml(url)}" target="_blank" rel="noopener">📄<br>${escapeHtml(name)}</a>${delBtn}</div>`;
  }).join("");
  invPhotoEmpty.hidden = invCurrentAttachments.length > 0;
}
function renderPendingPhotoList() {
  invPhotoNewList.innerHTML = invPendingPhotoFiles.map((file, i) =>
    `<div class="photo-tile photo-tile-pending" role="listitem" data-idx="${i}" title="Will be added when you save"><img src="${escapeHtml(file.__previewUrl)}" alt="${escapeHtml(file.name)}" /><button type="button" class="photo-delete-btn" data-idx="${i}" aria-label="Remove ${escapeHtml(file.name)}">&times;</button></div>`
  ).join("");
  invPhotoNewList.hidden = invPendingPhotoFiles.length === 0;
}
invPhotoFile.addEventListener("change", async () => {
  const files = [...invPhotoFile.files];
  invPhotoFile.value = ""; // let the same file be re-picked later if removed
  if (!files.length) return;
  const oid = invEditForm.dataset.oid;
  if (!oid) {
    // Brand-new, unsaved record — there's no objectId to attach to yet.
    // Queue the files and upload them right after the record is created
    // (see the submit handler below), same idea as the Users tab's QR
    // upload but for possibly several files.
    files.forEach((f) => { f.__previewUrl = URL.createObjectURL(f); });
    invPendingPhotoFiles.push(...files);
    renderPendingPhotoList();
    return;
  }
  const editable = perm.canEditPhotos(currentInvGroups, currentInvIsNew);
  invPhotoFile.disabled = true;
  invPhotoStatus.textContent = `Uploading ${files.length} photo${files.length > 1 ? "s" : ""}…`;
  try {
    for (const file of files) {
      await esri.addAttachment(CONFIG.INVENTORY_LAYER_URL, Number(oid), file);
    }
    invCurrentAttachments = await esri.listAttachments(CONFIG.INVENTORY_LAYER_URL, Number(oid));
    renderInvPhotoGrid(editable);
    invPhotoStatus.textContent = "";
  } catch (err) {
    invPhotoStatus.textContent = `Upload failed: ${err.message}`;
  } finally {
    invPhotoFile.disabled = !editable;
  }
});
invPhotoGrid.addEventListener("click", async (e) => {
  const delBtn = e.target.closest(".photo-delete-btn[data-att-id]");
  if (delBtn) {
    e.stopPropagation();
    if (!confirm("Delete this photo? This can't be undone.")) return;
    const attId = Number(delBtn.dataset.attId);
    const oid = Number(invEditForm.dataset.oid);
    const editable = perm.canEditPhotos(currentInvGroups, currentInvIsNew);
    try {
      await esri.deleteAttachments(CONFIG.INVENTORY_LAYER_URL, oid, [attId]);
      invCurrentAttachments = invCurrentAttachments.filter((a) => a.id !== attId);
      renderInvPhotoGrid(editable);
      setStatus("Photo deleted.");
    } catch (err) {
      setStatus(`Delete failed: ${err.message}`, true);
    }
    return;
  }
  const img = e.target.closest(".photo-tile img");
  if (img) openLightbox(img.src, img.alt);
});
invPhotoNewList.addEventListener("click", (e) => {
  const btn = e.target.closest(".photo-delete-btn[data-idx]");
  if (!btn) return;
  const idx = Number(btn.dataset.idx);
  const [removed] = invPendingPhotoFiles.splice(idx, 1);
  if (removed) URL.revokeObjectURL(removed.__previewUrl);
  renderPendingPhotoList();
});

// --- Photo lightbox — shared full-size viewer for any Inventory photo,
// same read-only-viewer pattern the PREDS mobile app already uses. ---
const photoLightbox = $("#photo-lightbox");
const photoLightboxImg = $("#photo-lightbox-img");
function openLightbox(src, alt) {
  photoLightboxImg.src = src;
  photoLightboxImg.alt = alt || "";
  photoLightbox.hidden = false;
}
function closeLightbox() {
  photoLightbox.hidden = true;
  photoLightboxImg.src = "";
}
$("#photo-lightbox-close").addEventListener("click", closeLightbox);
photoLightbox.addEventListener("click", (e) => { if (e.target === photoLightbox) closeLightbox(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !photoLightbox.hidden) closeLightbox(); });

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
      // Keep the form in sync with the record it just created — without
      // this, a photo picked before the very first save (queued in
      // invPendingPhotoFiles) has no objectId to upload to yet, and a
      // second save made without leaving this panel would incorrectly
      // try to add() again instead of update().
      invEditForm.dataset.oid = String(newOid);
      currentInvIsNew = false;
      if (invPendingPhotoFiles.length) {
        setStatus("Saving photos…");
        for (const file of invPendingPhotoFiles) {
          await esri.addAttachment(CONFIG.INVENTORY_LAYER_URL, newOid, file);
          URL.revokeObjectURL(file.__previewUrl);
        }
        invPendingPhotoFiles = [];
        renderPendingPhotoList();
        const editable = perm.canEditPhotos(currentInvGroups, false);
        invCurrentAttachments = await esri.listAttachments(CONFIG.INVENTORY_LAYER_URL, newOid);
        renderInvPhotoGrid(editable);
        invPhotoFile.disabled = !editable;
      }
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
const usrFilterBtn = $("#usr-filter-btn");
const usrFilterDrawer = $("#usr-filter-drawer");
const usrFilterClose = $("#usr-filter-close");
const usrFilterCount = $("#usr-filter-count");
const usrSectionPillRow = $("#usr-section-pill-row");

let usrSearchTerm = "";
let usrActiveSection = "";
let usrFiltered = [];
let usrRenderedCount = 0;
let selectedUsrOid = null;

/**
 * The Section list to offer in both the edit form's dropdown and the
 * filter drawer's pills: CONFIG.USR_SECTION_OPTIONS (the Users Survey123
 * form's current "section" choices, in the form's own order) plus any
 * OTHER section value actually found in the live roster, appended
 * alphabetically. That second part matters because the app has no way
 * to know whether some Users record was saved under a section name that
 * predates the form's current choice list (a renamed/retired section,
 * a manual edit, old data) — without it, a record like that would show
 * an unselectable/blank Section in the edit form and would never match
 * any filter pill.
 */
function allSectionValues() {
  const known = new Set(CONFIG.USR_SECTION_OPTIONS);
  const extra = new Set();
  for (const u of usersRoster) {
    const v = (u.attributes[CONFIG.USR_SECTION_FIELD] || "").trim();
    if (v && !known.has(v)) extra.add(v);
  }
  return [...CONFIG.USR_SECTION_OPTIONS, ...[...extra].sort()];
}
function buildUsrSectionOptions() {
  usrSectionSelect.innerHTML = '<option value="">—</option>';
  for (const s of allSectionValues()) {
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

// --- Filter drawer: same closed-by-default overlay pattern as the
// Inventory tab's filter drawer. ---
function openUsrFilterDrawer() {
  usrFilterDrawer.hidden = false;
  requestAnimationFrame(() => usrFilterDrawer.classList.add("open"));
  usrFilterBtn.setAttribute("aria-expanded", "true");
}
function closeUsrFilterDrawer() {
  usrFilterDrawer.classList.remove("open");
  usrFilterBtn.setAttribute("aria-expanded", "false");
  setTimeout(() => {
    if (!usrFilterDrawer.classList.contains("open")) usrFilterDrawer.hidden = true;
  }, 180);
}
usrFilterBtn.addEventListener("click", () => (usrFilterDrawer.hidden ? openUsrFilterDrawer() : closeUsrFilterDrawer()));
usrFilterClose.addEventListener("click", closeUsrFilterDrawer);
document.addEventListener("click", (e) => {
  if (usrFilterDrawer.hidden) return;
  if (e.target.closest("#usr-filter-drawer") || e.target.closest("#usr-filter-btn")) return;
  closeUsrFilterDrawer();
});
function updateUsrFilterCount() {
  const count = usrActiveSection ? 1 : 0;
  usrFilterCount.hidden = count === 0;
  usrFilterCount.textContent = String(count);
}
function buildUsrSectionPills() {
  usrSectionPillRow.innerHTML = "";
  const allPill = document.createElement("button");
  allPill.type = "button"; allPill.className = "buft active"; allPill.textContent = "All";
  allPill.addEventListener("click", () => { usrActiveSection = ""; refreshUsrPillStates(); applyUsrFilters(); });
  usrSectionPillRow.appendChild(allPill);
  for (const section of allSectionValues()) {
    const pill = document.createElement("button");
    pill.type = "button"; pill.className = "buft"; pill.dataset.section = section; pill.textContent = section;
    pill.addEventListener("click", () => { usrActiveSection = section; refreshUsrPillStates(); applyUsrFilters(); });
    usrSectionPillRow.appendChild(pill);
  }
}
function refreshUsrPillStates() {
  [...usrSectionPillRow.children].forEach((el, i) => el.classList.toggle("active", i === 0 ? !usrActiveSection : el.dataset.section === usrActiveSection));
}

function usrMatches(u) {
  const a = u.attributes;
  if (usrActiveSection && (a[CONFIG.USR_SECTION_FIELD] || "") !== usrActiveSection) return false;
  if (!usrSearchTerm) return true;
  const hay = [a[CONFIG.USR_FULL_NAME_FIELD], a[CONFIG.USR_SECTION_FIELD], a[CONFIG.USR_EDISON_ID_FIELD], a[CONFIG.USR_EMAIL_FIELD]]
    .filter(Boolean).join(" ").toLowerCase();
  return hay.includes(usrSearchTerm);
}
function applyUsrFilters() {
  usrFiltered = usersRoster.filter(usrMatches);
  usrFiltered.sort((a, b) => (a.attributes[CONFIG.USR_LAST_NAME_FIELD] || "").localeCompare(b.attributes[CONFIG.USR_LAST_NAME_FIELD] || ""));
  usrRenderedCount = 0;
  usrList.innerHTML = "";
  updateUsrActiveFiltersBar();
  revealMoreUsr();
}
function updateUsrActiveFiltersBar() {
  usrActiveFilters.innerHTML = "";
  if (usrActiveSection) {
    const chip = document.createElement("span"); chip.className = "filter-chip";
    chip.innerHTML = `Section: ${escapeHtml(usrActiveSection)} <button type="button" aria-label="Clear">&times;</button>`;
    chip.querySelector("button").addEventListener("click", () => { usrActiveSection = ""; refreshUsrPillStates(); applyUsrFilters(); });
    usrActiveFilters.appendChild(chip);
  }
  updateUsrFilterCount();
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
const usrEditSubtitle = $("#usr-edit-subtitle");

let currentUsrIsNew = false;

$("#usr-add-btn").addEventListener("click", () => showUsrEditor(null));
$("#usr-edit-back-btn").addEventListener("click", () => usrAppLayout.classList.remove("showing-edit"));

/**
 * Live "Person" toolbar subtitle — same idea as the Inventory tab's
 * "Item" subtitle: the person's full name next to the header, so the
 * record being edited is still identifiable once you've scrolled past
 * the Person fieldset. Updates as first/last name are typed.
 */
function updateUsrEditSubtitle(a) {
  const name = [a[CONFIG.USR_FIRST_NAME_FIELD], a[CONFIG.USR_LAST_NAME_FIELD]].filter(Boolean).join(" ");
  usrEditSubtitle.textContent = name;
}
["first_name", "last_name"].forEach((fieldName) => {
  usrEditForm[fieldName].addEventListener("input", () => updateUsrEditSubtitle({
    [CONFIG.USR_FIRST_NAME_FIELD]: usrEditForm.first_name.value,
    [CONFIG.USR_LAST_NAME_FIELD]: usrEditForm.last_name.value,
  }));
});

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

  const editable = !FORCE_READ_ONLY && (currentUsrIsNew || perm.canEditUsers(me));
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
  updateUsrEditSubtitle(a);

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
