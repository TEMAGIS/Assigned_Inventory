// ---------------------------------------------------------------------------
// Writing inventory/user rows: chunked applyEdits + keeping the in-memory
// copies in step, so every tab re-renders instantly with no reload.
// ---------------------------------------------------------------------------

import { CONFIG } from "./config.js";
import { applyEdits } from "./shared/esri-client.js";
import { S, I, U, reindexInv, reindexUsers } from "./state.js";

const chunks = (arr, n) => {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};

export const geometryFor = (lat, lng) =>
  CONFIG.INV_HAS_GEOMETRY && Number.isFinite(lat) && Number.isFinite(lng) ? { x: lng, y: lat, spatialReference: { wkid: 4326 } } : undefined;

/** The location fields (and pin) a Region preset fills in. */
export function presetFor(region) {
  const p = CONFIG.REGION_LOCATION_PRESETS[region];
  if (!p) return null;
  return {
    attrs: {
      [I.region]: region, [I.county]: p.county, [I.address]: p.address, [I.city]: p.city, [I.state]: p.state, [I.zip]: p.zip,
      [I.lat]: p.lat, [I.lng]: p.lng,
    },
    geometry: geometryFor(p.lat, p.lng),
  };
}

/**
 * Updates inventory rows.
 * @param {Array<{row:object, attrs:object, geometry?:object}>} changes
 * All-or-nothing per chunk (rollbackOnFailure). Local rows are only touched after success.
 */
export async function updateInventory(changes) {
  const list = changes.filter((c) => c && c.row);
  for (const part of chunks(list, CONFIG.EDIT_CHUNK)) {
    await applyEdits(CONFIG.INVENTORY_LAYER_URL, {
      updates: part.map((c) => ({ attributes: { [S.oid.inv]: c.row._oid, ...c.attrs }, ...(c.geometry ? { geometry: c.geometry } : {}) })),
    });
    for (const c of part) {
      Object.assign(c.row, c.attrs);
      c.row[I.editDate] = Date.now();
      if (c.geometry) c.row._geom = c.geometry;
    }
  }
}

/** Adds inventory rows; returns the created local rows (with _oid). */
export async function addInventory(items) {
  const created = [];
  for (const part of chunks(items, CONFIG.EDIT_CHUNK)) {
    const res = await applyEdits(CONFIG.INVENTORY_LAYER_URL, {
      adds: part.map((c) => ({ attributes: c.attrs, ...(c.geometry ? { geometry: c.geometry } : {}) })),
    });
    part.forEach((c, i) => {
      const row = { ...c.attrs, [I.editDate]: Date.now(), _oid: res.addResults[i].objectId, ...(c.geometry ? { _geom: c.geometry } : {}) };
      S.inv.push(row);
      created.push(row);
    });
  }
  reindexInv();
  return created;
}

export async function updateUsers(changes) {
  for (const part of chunks(changes, CONFIG.EDIT_CHUNK)) {
    await applyEdits(CONFIG.USERS_LAYER_URL, { updates: part.map((c) => ({ attributes: { [S.oid.usr]: c.row._oid, ...c.attrs } })) });
    for (const c of part) Object.assign(c.row, c.attrs);
  }
  reindexUsers();
}

export async function addUsers(attrsList) {
  const created = [];
  for (const part of chunks(attrsList, CONFIG.EDIT_CHUNK)) {
    const res = await applyEdits(CONFIG.USERS_LAYER_URL, { adds: part.map((a) => ({ attributes: a })) });
    part.forEach((a, i) => {
      const row = { ...a, _oid: res.addResults[i].objectId };
      S.users.push(row);
      created.push(row);
    });
  }
  reindexUsers();
  return created;
}

export const userAttrs = (v) => ({
  [U.edison]: String(v.edison || "").trim(),
  [U.first]: String(v.first || "").trim(),
  [U.last]: String(v.last || "").trim(),
  [U.full]: [String(v.first || "").trim(), String(v.last || "").trim()].filter(Boolean).join(" "),
  [U.email]: String(v.email || "").trim(),
  [U.section]: v.section || "",
  [U.permissions]: v.role || CONFIG.ROLE_NON_MANAGER,
  [U.active]: v.active === false ? "no" : "yes",
  [U.supervisor]: String(v.supervisor || "").trim(),
  // optional fields: only written when the caller supplies them (so imports never blank them)
  ...(v.description !== undefined ? { [U.description]: String(v.description || "") } : {}),
  ...(v.propertyOwnerOf !== undefined ? { [U.propertyOwnerOf]: (v.propertyOwnerOf || []).join("; ").slice(0, 250) } : {}),
  ...(v.imageUrl !== undefined ? { [U.imageUrl]: String(v.imageUrl || "").trim() } : {}),
});
