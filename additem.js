// ---------------------------------------------------------------------------
// Add item — a short dialog. Only the tag and a name for the item are needed;
// serial, status, description, photo and location live under "More details".
// "Save & add another" keeps category/item/make/model so a batch of identical
// laptops is one tag number per click.
// ---------------------------------------------------------------------------

import { CONFIG } from "./config.js";
import { esc } from "./shared/util.js";
import { openModal, toast } from "./shared/ui.js";
import { addAttachment } from "./shared/esri-client.js";
import { S, I, statusOptions, ownerOptions, regionOptions, ymdToMs, todayYmd } from "./state.js";
import { addInventory, presetFor } from "./edits.js";
import { logAndWarn } from "./activity.js";
import { openAssignDialog } from "./assign.js";
import { locationFormHTML, mountLocation } from "./location.js";
import { canAddInventory } from "./permissions.js";

const tagSet = () => new Set(S.inv.map((r) => String(r[I.tag] || "").trim().toLowerCase()).filter(Boolean));

/**
 * Suggest the next free tag: find the most common "prefix + number" pattern among
 * existing tags (e.g. "T-" + 5 digits), take its highest number, add one.
 */
export function suggestTag() {
  const used = tagSet();
  const groups = new Map(); // "prefix|width" -> { n: count, max }
  for (const r of S.inv) {
    const m = String(r[I.tag] || "").trim().match(/^(.*?)(\d+)$/);
    if (!m) continue;
    const key = `${m[1]}|${m[2].length}`;
    const g = groups.get(key) || { n: 0, max: 0, prefix: m[1], width: m[2].length };
    g.n++;
    g.max = Math.max(g.max, Number(m[2]));
    groups.set(key, g);
  }
  const best = [...groups.values()].sort((a, b) => b.n - a.n)[0];
  if (!best) return "";
  let n = best.max;
  for (let i = 0; i < 5000; i++) {
    n += 1;
    const cand = best.prefix + String(n).padStart(best.width, "0");
    if (!used.has(cand.toLowerCase())) return cand;
  }
  return "";
}

export function openAddItem(prefill = {}) {
  if (!canAddInventory(S.me) || S.readonly) return toast("You can't add items.", "error");
  const stats = [...new Set([...CONFIG.STATUS_DEFAULTS, ...statusOptions()])].filter((x) => !/^(in service|needs repair|retired)$/i.test(x) || S.inv.some((r) => r[I.status] === x));
  const opts = (list, cur = "") => list.map((c) => `<option ${String(c) === String(cur) ? "selected" : ""}>${esc(c)}</option>`).join("");
  const m = openModal({
    title: "Add item",
    body: `
      <p class="sub" style="margin-top:0">Adds a non-consumable item, the same way the Survey123 form does.</p>
      <div class="two-col">
        <label>Tag number<input id="ai-tag" value="${esc(prefill.tag ?? suggestTag())}" maxlength="255" /><span class="hint">Next free tag suggested — change it if you like</span></label>
        <label>Item<input id="ai-item" list="ai-item-dl" value="${esc(prefill.item || "")}" placeholder="e.g. Laptop" /></label>
      </div>
      <datalist id="ai-item-dl">${[...new Set(S.inv.map((r) => String(r[I.item] || "").trim()).filter(Boolean))].sort().map((c) => `<option value="${esc(c)}">`).join("")}</datalist>
      <div class="two-col">
        <label>Make<input id="ai-make" value="${esc(prefill.make || "")}" /></label>
        <label>Model<input id="ai-model" value="${esc(prefill.model || "")}" /></label>
      </div>
      <label>Serial number<input id="ai-serial" /></label>
      <div class="two-col">
        <label>Original reception date<input type="date" id="ai-recv" value="${esc(prefill.receiving || todayYmd())}" /></label>
        <label>Quantity<input type="number" id="ai-qty" min="1" value="${esc(prefill.quantity || 1)}" /></label>
      </div>
      <label>Region<select id="ai-region"><option value="">—</option>${opts(regionOptions(), prefill.region || "")}</select><span class="hint">Fills in the office address and map pin</span></label>
      ${ownerOptions().length ? `<label>Property owner<select id="ai-owner"><option value="">(not set)</option>${ownerOptions().map((o) => `<option value="${esc(o.code)}" ${String(prefill.owner || "") === String(o.code) ? "selected" : ""}>${esc(o.name)}</option>`).join("")}</select><span class="hint">The section responsible for this item. Its property owners can assign it.</span></label>` : ""}
      <label>Photo<input type="file" id="ai-photo" accept="image/*" multiple /></label>
      <details class="more"><summary>More details (status, part number, IMEI, color, cost, acquisition, description, location)</summary>
        <label style="margin-top:.6rem">Status<select id="ai-status">${opts(stats, prefill.status || "Active")}</select></label>
        <label id="ai-reason-row" hidden>Status change details<select id="ai-reason"><option value="">—</option>${opts(CONFIG.STATUS_REASONS)}</select></label>
        <div class="two-col">
          <label>Part number<input id="ai-part" /></label>
          <label>IMEI number<input id="ai-imei" /></label>
          <label>Color<input id="ai-color" /></label>
          <label>Cost<input id="ai-cost" type="number" step="0.01" min="0" /></label>
        </div>
        <label>Acquisition type<select id="ai-acq"><option value="">—</option>${opts(CONFIG.ACQUISITIONS)}</select></label>
        <label>Description<textarea id="ai-desc" rows="2"></textarea></label>
        <div id="ai-loc">${locationFormHTML({ idp: "ai", showMap: true })}</div>
      </details>
      <label class="check"><input type="checkbox" id="ai-assign" /> Assign it to someone right after saving</label>`,
    wide: false,
    buttons: [
      { label: "Cancel" },
      { label: "Save & add another", id: "ai-again", action: (mm) => save(mm, true), close: false },
      { label: "Save", kind: "primary", id: "ai-save", action: (mm) => save(mm, false), close: false },
    ],
  });
  const syncReason = () => { m.el.querySelector("#ai-reason-row").hidden = !/inactive/i.test(m.el.querySelector("#ai-status").value); };
  m.el.querySelector("#ai-status").addEventListener("change", syncReason); syncReason();
  const loc = mountLocation(m.el.querySelector("#ai-loc"), null, { editable: true, showMap: true });
  // The region picker lives above the owner; it drives the location block's own region field.
  const locRegion = m.el.querySelector('#ai-loc [name="region"]');
  if (locRegion) {
    locRegion.closest("label").hidden = true;
    m.el.querySelector("#ai-region").addEventListener("change", (e) => { locRegion.value = e.target.value; locRegion.dispatchEvent(new Event("change", { bubbles: true })); });
    if (prefill.region) { locRegion.value = prefill.region; }
  }
  const origClose = m.close;
  m.close = () => { loc.destroy(); origClose(); };
  // The map needs a visible container to size itself once the <details> opens.
  m.el.querySelector("details.more").addEventListener("toggle", () => window.dispatchEvent(new Event("resize")));

  async function save(mm, again) {
    const v = (id) => m.el.querySelector("#" + id).value.trim();
    const tag = v("ai-tag");
    if (!tag) throw new Error("Tag number is required.");
    if (!v("ai-item")) throw new Error("Item is required.");
    if (!v("ai-make")) throw new Error("Make is required.");
    if (!v("ai-model")) throw new Error("Model is required.");
    if (!v("ai-recv")) throw new Error("Original reception date is required.");
    if (tagSet().has(tag.toLowerCase())) throw new Error(`Tag ${tag} is already in use.`);
    const attrs = {
      [I.tag]: tag, [I.category]: CONFIG.DEFAULT_CATEGORY, [I.item]: v("ai-item"), [I.make]: v("ai-make"), [I.model]: v("ai-model"),
      [I.serial]: v("ai-serial"), [I.status]: v("ai-status"), [I.description]: v("ai-desc"),
      [I.receiving]: ymdToMs(v("ai-recv")), [I.quantity]: Math.max(1, parseInt(v("ai-qty"), 10) || 1),
    };
    if (/inactive/i.test(attrs[I.status]) && v("ai-reason")) attrs[I.statusReason] = v("ai-reason");
    for (const [id, f] of [["ai-part", I.partNumber], ["ai-imei", I.imei], ["ai-color", I.color], ["ai-acq", I.acquisition]]) if (v(id)) attrs[f] = v(id);
    if (v("ai-cost")) attrs[I.cost] = Number(v("ai-cost"));
    if (m.el.querySelector("#ai-owner") && v("ai-owner")) attrs[I.propertyOwner] = v("ai-owner");
    const l = loc.read();
    // keep only location values the person actually entered
    for (const [f, val] of Object.entries(l.attrs)) if (val !== "" && val !== undefined) attrs[f] = val;
    let geometry = l.geometry;
    const region = attrs[I.region];
    if (region && !attrs[I.address]) { // region picked but fields blank → use the preset
      const p = presetFor(region);
      if (p) { Object.assign(attrs, p.attrs, Object.fromEntries(Object.entries(attrs).filter(([, x]) => x !== ""))); geometry = geometry || p.geometry; }
    }
    const [row] = await addInventory([{ attrs, geometry }]);
    const files = [...(m.el.querySelector("#ai-photo").files || [])];
    let photoErr = "";
    for (const f of files) { try { await addAttachment(CONFIG.INVENTORY_LAYER_URL, row._oid, f); } catch (e) { photoErr = e.message; } }
    await logAndWarn([{ type: "Added", row, note: "" }]);
    const assign = m.el.querySelector("#ai-assign").checked;
    toast(`Added ${tag}.${photoErr ? " (Photo failed: " + photoErr + ")" : ""}`, photoErr ? "error" : "success");
    S.actions.refresh();
    const keep = { item: v("ai-item"), make: v("ai-make"), model: v("ai-model"), status: v("ai-status"), receiving: v("ai-recv"), quantity: v("ai-qty"), owner: m.el.querySelector("#ai-owner") ? v("ai-owner") : "", region: v("ai-region") };
    m.close();
    if (assign) openAssignDialog([row]);
    else if (again) openAddItem(keep);
    return false;
  }
  return m;
}
