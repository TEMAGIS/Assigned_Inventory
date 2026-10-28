// Shared in-memory state + small helpers used by every module.
import { CONFIG } from "./config.js";
import { editableGroups } from "./permissions.js";

export const I = CONFIG.INV;
export const U = CONFIG.USR;

export const S = {
  me: null, // the signed-in person's Users row (plain object)
  profile: null,
  users: [], // Users rows (plain objects with _oid)
  inv: [], // Inventory rows (plain objects with _oid, _geom)
  usersByEdison: new Map(),
  invByOid: new Map(),
  oid: { inv: "OBJECTID", usr: "OBJECTID" },
  blankHidden: 0,
  readonly: false,
  tab: "inv",
  activity: { url: "", listsUrl: "", serviceUrl: "", rows: [], ready: false, error: "" },
  viewOnly: false, // true when the data comes from the view-only copies
  usersHasOwnerField: false,
  propertyOwners: [], // [{code, name}] from the Inventory layer's property_owner domain
  ownerDomainEditable: false,
  audit: { url: "", rows: [], byTag: new Map(), ready: false, error: "" },
  problems: { url: "", confUrl: "", serviceUrl: "", rows: [], conf: [], ready: false, error: "" },
  lists: { section: [], category: [], status: [], stored: {}, regions: [] },
  render: {}, // tab -> render fn
  actions: {}, // cross-module calls (openDrawer, refresh…)
};

// ---------- people ----------
export const fullName = (u) =>
  (u && (u[U.full] || [u[U.first], u[U.last]].filter(Boolean).join(" ") || u[U.email] || u[U.edison])) || "";
export const userById = (id) => (id ? S.usersByEdison.get(String(id)) || null : null);
export const personName = (id) => (id ? fullName(userById(id)) || `Unknown (${id})` : "");
export const isUserActive = (u) => ["yes", "y", "true"].includes(String(u[U.active] || "").trim().toLowerCase());
export const initials = (name) =>
  String(name || "?").split(/\s+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join("").toUpperCase() || "?";

export function reindexUsers() {
  S.usersByEdison = new Map(S.users.filter((u) => u[U.edison]).map((u) => [String(u[U.edison]), u]));
}
export function reindexInv() {
  S.invByOid = new Map(S.inv.map((r) => [r._oid, r]));
}

// ---------- inventory ----------
const INV_BLANK_FIELDS = [I.tag, I.serial, I.item, I.make, I.model, I.category, I.description];
export const isBlankRow = (r) => INV_BLANK_FIELDS.every((f) => !String(r[f] || "").trim());
export const isRetired = (r) => new RegExp(CONFIG.STATUS_RETIRED_PATTERN, "i").test(String(r[I.status] || ""));
export const needsAttention = (r) => new RegExp(CONFIG.STATUS_ATTENTION_PATTERN, "i").test(String(r[I.status] || ""));
export const itemTitle = (r) => String(r[I.item] || r[I.category] || r[I.description] || "Item");
export const itemMakeModel = (r) => [r[I.make], r[I.model]].filter(Boolean).join(" ");
export const placeText = (r) => [r[I.place], r[I.room]].filter(Boolean).join(" · ") || r[I.region] || "";
export const groupsFor = (row) => editableGroups(row, S.me);

/** Rows that count as real inventory (placeholder blanks hidden). */
export const realInv = () => S.inv.filter((r) => !isBlankRow(r));

// ---------- dates (ArcGIS stores dates as UTC ms; the Editor stored date-only values at UTC midnight) ----------
export const ymdToMs = (ymd) => (ymd ? Date.parse(ymd + "T00:00:00Z") : null);
export const msToYmd = (ms) => (ms ? new Date(Number(ms)).toISOString().slice(0, 10) : "");
export const todayYmd = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
export const fmtYmd = (ms) => {
  if (!ms) return "";
  return new Date(Number(ms)).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
};

// ---------- dropdown suggestion lists: stored list values first, then anything seen in the data ----------
const uniqSorted = (arr) => Array.from(new Set(arr.map((v) => String(v || "").trim()).filter(Boolean)));
export function sectionOptions() {
  const stored = S.lists.section.length ? S.lists.section : CONFIG.SECTIONS;
  return uniqSorted([...stored, ...S.users.map((u) => u[U.section])]);
}
export function categoryOptions() {
  const stored = S.lists.category.length ? S.lists.category : CONFIG.CATEGORIES;
  return uniqSorted([...stored, ...S.inv.map((r) => r[I.category])]).sort((a, b) => a.localeCompare(b));
}
export function statusOptions() {
  const stored = S.lists.status.length ? S.lists.status : CONFIG.STATUS_DEFAULTS;
  return uniqSorted([...stored, ...S.inv.map((r) => r[I.status])]);
}
/** Region offices: the saved list (Settings), else the defaults in config.js. */
export const regionList = () => (S.lists.regions && S.lists.regions.length
  ? S.lists.regions
  : CONFIG.REGIONS.map((name) => ({ name, ...(CONFIG.REGION_LOCATION_PRESETS[name] || {}) })));
export const regionOptions = () => regionList().map((r) => r.name);
export const regionPreset = (name) => regionList().find((r) => r.name === name) || null;

// ---------- property owners ----------
export const ownerName = (code) => {
  const c = String(code ?? "").trim();
  if (!c) return "";
  const hit = S.propertyOwners.find((o) => String(o.code).trim().toLowerCase() === c.toLowerCase());
  return hit ? String(hit.name).trim() : c;
};
export const ownerOptions = () => {
  const have = new Set(S.propertyOwners.map((o) => String(o.code).trim().toLowerCase()));
  const extra = [...new Set(S.inv.map((r) => String(r[I.propertyOwner] || "").trim()).filter(Boolean))]
    .filter((c) => !have.has(c.toLowerCase())).map((c) => ({ code: c, name: c }));
  return [...S.propertyOwners, ...extra];
};
