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
import { S, I, categoryOptions, statusOptions } from "./state.js";
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
  const cats = categoryOptions();
  const stats = statusOptions();
  const m = openModal({
    title: "Add item",
    body: `
      <p class="sub" style="margin-top:0">Only the tag and what it is are required.</p>
      <div class="two-col">
        <label>Tag number<input id="ai-tag" value="${esc(prefill.tag ?? suggestTag())}" maxlength="255" /><span class="hint">Next free tag suggested — change it if you like</span></label>
        <label>Category<input id="ai-cat" list="ai-cat-dl" value="${esc(prefill.category || "")}" /></label>
      </div>
      <datalist id="ai-cat-dl">${cats.map((c) => `<option value="${esc(c)}">`).join("")}</datalist>
      <label>Item<input id="ai-item" value="${esc(prefill.item || "")}" placeholder="e.g. Laptop" /></label>
      <div class="two-col">
        <label>Make<input id="ai-make" value="${esc(prefill.make || "")}" /></label>
        <label>Model<input id="ai-model" value="${esc(prefill.model || "")}" /></label>
      </div>
      <details class="more"><summary>More details (serial, status, description, photo, location)</summary>
        <div class="two-col" style="margin-top:.6rem">
          <label>Serial number<input id="ai-serial" /></label>
          <label>Status<input id="ai-status" list="ai-stat-dl" value="${esc(prefill.status || stats[0] || "")}" /></label>
        </div>
        <datalist id="ai-stat-dl">${stats.map((c) => `<option value="${esc(c)}">`).join("")}</datalist>
        <label>Description<textarea id="ai-desc" rows="2"></textarea></label>
        <label>Photo<input type="file" id="ai-photo" accept="image/*" multiple /></label>
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
  const loc = mountLocation(m.el.querySelector("#ai-loc"), null, { editable: true, showMap: true });
  const origClose = m.close;
  m.close = () => { loc.destroy(); origClose(); };
  // The map needs a visible container to size itself once the <details> opens.
  m.el.querySelector("details.more").addEventListener("toggle", () => window.dispatchEvent(new Event("resize")));

  async function save(mm, again) {
    const v = (id) => m.el.querySelector("#" + id).value.trim();
    const tag = v("ai-tag");
    if (!tag) throw new Error("Tag number is required.");
    if (!v("ai-item") && !v("ai-cat")) throw new Error("Say what it is — an Item name or a Category.");
    if (tagSet().has(tag.toLowerCase())) throw new Error(`Tag ${tag} is already in use.`);
    const attrs = {
      [I.tag]: tag, [I.category]: v("ai-cat"), [I.item]: v("ai-item"), [I.make]: v("ai-make"), [I.model]: v("ai-model"),
      [I.serial]: v("ai-serial"), [I.status]: v("ai-status"), [I.description]: v("ai-desc"),
    };
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
    const keep = { category: v("ai-cat"), item: v("ai-item"), make: v("ai-make"), model: v("ai-model"), status: v("ai-status") };
    m.close();
    if (assign) openAssignDialog([row]);
    else if (again) openAddItem(keep);
    return false;
  }
  return m;
}
