// ---------------------------------------------------------------------------
// Photo audit. A separate Survey123-style layer (Inventory_Photo_Audit): one row
// per audit with the person, the inspection date, the tag, and the photos as
// attachments. Read-only here: the app matches audits to items by tag number and
// shows them in the item panel and a "Last audit" column.
// ---------------------------------------------------------------------------

import { CONFIG } from "./config.js";
import { esriRequest, queryAll, tableUrl, itemServiceUrl } from "./shared/esri-client.js";
import { S } from "./state.js";

const norm = (t) => String(t ?? "").trim().toUpperCase();

export async function loadAudit() {
  const A = S.audit;
  A.url = A.error = ""; A.rows = []; A.byTag = new Map(); A.ready = false;
  if (!CONFIG.PHOTO_AUDIT_ITEM_ID) return;
  try {
    const svc = await itemServiceUrl(CONFIG.PHOTO_AUDIT_ITEM_ID);
    let url = /\/\d+$/.test(svc) ? svc : tableUrl(svc, CONFIG.PHOTO_AUDIT_LAYER_ID);
    await esriRequest(url, {}, { method: "GET" }); // does it exist / can I see it?
    A.url = url;
    const rows = await queryAll(url, { pageSize: CONFIG.FETCH_PAGE_SIZE });
    const F = CONFIG.AUDIT;
    for (const r of rows) {
      const tag = F.tag.map((f) => r[f]).find((v) => String(v ?? "").trim());
      r._tag = norm(tag);
      r._when = Number(r[F.date]) || Number(r.CreationDate) || 0;
      r._by = r[F.by] || r.Creator || "";
      if (!r._tag) continue;
      if (!A.byTag.has(r._tag)) A.byTag.set(r._tag, []);
      A.byTag.get(r._tag).push(r);
    }
    for (const list of A.byTag.values()) list.sort((a, b) => b._when - a._when);
    A.rows = rows; A.ready = true;
  } catch (err) {
    A.error = err.message;
    console.warn("[audit] photo audit layer not available:", err.message);
  }
}

export const auditsFor = (tag) => (tag ? S.audit.byTag.get(norm(tag)) || [] : []);
export const lastAudit = (row, tagField) => auditsFor(row[tagField])[0] || null;
