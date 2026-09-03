// ---------------------------------------------------------------------------
// Generic helper for talking to an ArcGIS hosted feature layer's REST API —
// query (paginated), add/update/delete via applyEdits, and attachments.
// Unlike the ReadyOp Contacts app, there's no CORS relay needed here: ArcGIS
// Online's hosted feature services send proper CORS headers on their own,
// so the browser can call them directly once the signed-in user's token is
// attached to each request.
// ---------------------------------------------------------------------------

import { ensureFreshToken, getToken } from "./arcgis-auth.js?v=20260903c";

async function authedFetch(url, params, { method = "GET" } = {}) {
  await ensureFreshToken();
  const token = getToken();
  const body = new URLSearchParams({ ...params, f: "json", token });
  if (method === "GET") {
    const res = await fetch(`${url}?${body.toString()}`);
    return res.json();
  }
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  return res.json();
}

function throwIfEsriError(data, context) {
  if (data && data.error) {
    const msg = data.error.message || JSON.stringify(data.error);
    throw new Error(`${context}: ${msg}`);
  }
}

/**
 * Fetches every row of a layer, paginated via resultOffset, into one array
 * — same "load the whole roster once, then work in memory" approach
 * ReadyOp Edit's contact list uses, so search/filter/permission-scoping can
 * all run instantly against the in-memory copy instead of round-tripping
 * per keystroke. `onPage(rowsSoFar, totalSoFar)` fires after each page so
 * callers can render progressively.
 *
 * @param {string} layerUrl
 * @param {{outFields?: string, where?: string, orderByFields?: string, pageSize?: number, onPage?: (all: any[]) => void}} opts
 * @returns {Promise<Array<object>>} each item is `{ attributes, geometry? }`
 */
export async function queryAllFeatures(layerUrl, opts = {}) {
  const {
    outFields = "*",
    where = "1=1",
    orderByFields = "",
    pageSize = 1000,
    onPage = null,
  } = opts;

  const all = [];
  let offset = 0;
  for (;;) {
    const data = await authedFetch(`${layerUrl}/query`, {
      where,
      outFields,
      orderByFields,
      returnGeometry: "true",
      resultOffset: String(offset),
      resultRecordCount: String(pageSize),
    });
    throwIfEsriError(data, "Query failed");
    const features = data.features || [];
    all.push(...features);
    if (onPage) onPage(all);
    const exceeded = data.exceededTransferLimit === true;
    if (!exceeded || features.length === 0) break;
    offset += features.length;
  }
  return all;
}

/**
 * Adds, updates, and/or deletes features in one applyEdits call.
 * @param {string} layerUrl
 * @param {{adds?: object[], updates?: object[], deletes?: (number|string)[]}} edits
 *   Each add/update is `{ attributes, geometry? }`.
 * @returns {Promise<{addResults, updateResults, deleteResults}>}
 */
export async function applyEdits(layerUrl, { adds = [], updates = [], deletes = [] }) {
  const data = await authedFetch(
    `${layerUrl}/applyEdits`,
    {
      adds: JSON.stringify(adds),
      updates: JSON.stringify(updates),
      deletes: JSON.stringify(deletes),
      rollbackOnFailure: "true",
    },
    { method: "POST" }
  );
  throwIfEsriError(data, "Save failed");
  for (const key of ["addResults", "updateResults", "deleteResults"]) {
    for (const r of data[key] || []) {
      if (r.success === false) {
        throw new Error(`Save failed: ${(r.error && r.error.description) || "unknown error"}`);
      }
    }
  }
  return data;
}

/** Convenience wrapper for a single add. Returns the new objectId. */
export async function addFeature(layerUrl, attributes, geometry) {
  const res = await applyEdits(layerUrl, { adds: [{ attributes, ...(geometry ? { geometry } : {}) }] });
  return res.addResults[0].objectId;
}

/** Convenience wrapper for a single update by objectId. */
export async function updateFeature(layerUrl, objectIdField, objectId, attributes, geometry) {
  const record = { attributes: { [objectIdField]: objectId, ...attributes } };
  if (geometry) record.geometry = geometry;
  await applyEdits(layerUrl, { updates: [record] });
}

/** Lists attachments (e.g. a Users record's qr_code image) for one feature. */
export async function listAttachments(layerUrl, objectId) {
  const data = await authedFetch(`${layerUrl}/${objectId}/attachments`, {});
  throwIfEsriError(data, "Could not list attachments");
  return data.attachmentInfos || [];
}

/** Returns a signed, token-bearing URL an <img> tag can load directly. */
export function attachmentUrl(layerUrl, objectId, attachmentId) {
  const token = getToken();
  return `${layerUrl}/${objectId}/attachments/${attachmentId}?token=${encodeURIComponent(token || "")}`;
}

/** Uploads a new attachment (e.g. a replacement qr_code image) for a feature. */
export async function addAttachment(layerUrl, objectId, file) {
  await ensureFreshToken();
  const form = new FormData();
  form.append("attachment", file);
  form.append("f", "json");
  form.append("token", getToken());
  const res = await fetch(`${layerUrl}/${objectId}/addAttachment`, { method: "POST", body: form });
  const data = await res.json();
  throwIfEsriError(data, "Attachment upload failed");
  if (data.addAttachmentResult && data.addAttachmentResult.success === false) {
    throw new Error("Attachment upload failed");
  }
  return data.addAttachmentResult;
}

/**
 * Fetches the layer's field list (name/type/domain/editable/nullable) and
 * logs a warning for every configured field name (from config.js) that
 * doesn't actually exist on the live layer — the same kind of guardrail
 * ReadyOp Edit's console diagnostic dump gives you, since none of this
 * app's field-name assumptions could be checked against a live, token-
 * protected layer while building it. Call once per layer, right after
 * sign-in. Never throws — schema-check failures are logged, not fatal.
 */
export async function checkFieldNames(layerUrl, label, expectedFieldNames) {
  try {
    const data = await authedFetch(layerUrl, {});
    throwIfEsriError(data, "Layer metadata request failed");
    const liveNames = new Set((data.fields || []).map((f) => f.name));
    const missing = expectedFieldNames.filter((n) => n && !liveNames.has(n));
    if (missing.length) {
      console.warn(
        `[schema check] ${label}: these configured field names were NOT found on the live layer — ` +
          `double-check config.js against the layer's actual Fields list (item page → Data tab): ${missing.join(", ")}`
      );
    } else {
      console.info(`[schema check] ${label}: all configured field names matched the live layer. ✓`);
    }
    // objectIdField is usually "OBJECTID" but isn't guaranteed — some
    // layers use "FID" or something else entirely. Callers should key off
    // this returned value rather than assuming a name.
    return { liveFields: data.fields || [], missing, objectIdField: data.objectIdField || "OBJECTID" };
  } catch (err) {
    console.warn(`[schema check] ${label}: could not verify field names — ${err.message}`);
    return { liveFields: [], missing: [], objectIdField: "OBJECTID" };
  }
}
