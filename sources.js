// ---------------------------------------------------------------------------
// Which copy of the data does this person use?
//   Editors     → the editable Inventory + Users layers (config.js).
//   Everyone    → whose account can't open those → the VIEW-ONLY copies
//   else          (CONFIG.VIEW_ITEM_IDS). The app then runs read-only (S.viewOnly),
//                 apart from sending problem reports to the Problems service.
// Decided once at start-up by trying the editable layers.
// ---------------------------------------------------------------------------

import { CONFIG } from "./config.js";
import { esriRequest, itemServiceUrl } from "./shared/esri-client.js";
import { S } from "./state.js";

const probe = (layerUrl) => esriRequest(`${layerUrl}/query`, { where: "1=0", returnCountOnly: "true" });
const layerUrl = (u) => (/\/FeatureServer$/i.test(u) ? `${u}/0` : u);

export async function chooseSources() {
  S.viewOnly = false;
  let first;
  try {
    await Promise.all([probe(CONFIG.USERS_LAYER_URL), probe(CONFIG.INVENTORY_LAYER_URL)]);
    return;
  } catch (err) { first = err; }
  const ids = CONFIG.VIEW_ITEM_IDS || {};
  if (!ids.users || !ids.inventory) throw first;
  try {
    const [u, i] = await Promise.all([itemServiceUrl(ids.users), itemServiceUrl(ids.inventory)]);
    const uu = layerUrl(u), iu = layerUrl(i);
    await Promise.all([probe(uu), probe(iu)]);
    CONFIG.USERS_LAYER_URL = uu;
    CONFIG.INVENTORY_LAYER_URL = iu;
    S.viewOnly = true;
    S.readonly = true;
    console.info("[sources] editable layers not available to this account — using the view-only copies.");
  } catch (err) {
    console.warn("[sources] view-only copies not available either:", err.message);
    throw first; // keep the original error (and its code, e.g. an expired token)
  }
}
