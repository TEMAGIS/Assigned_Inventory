// ---------------------------------------------------------------------------
// Location editor (region presets, address search, click/drag map pin) — the
// same behaviour the Assigned Inventory Editor had, packaged as a small
// reusable block that lives behind "Edit details" in the item drawer / add
// dialog. Uses Leaflet (loaded in index.html) and OpenStreetMap's free
// Nominatim for address search / reverse geocoding.
// ---------------------------------------------------------------------------

import { CONFIG } from "./config.js";
import { esc, unique, debounce } from "./shared/util.js";
import { S, I, regionOptions } from "./state.js";
import { presetFor, geometryFor } from "./edits.js";

const NOM = "https://nominatim.openstreetmap.org";

export function locationFormHTML({ idp = "loc", showMap = true } = {}) {
  const places = unique(S.inv.map((r) => r[I.place]));
  return `
    <div class="two-col">
      <label>Region<select name="region"><option value="">—</option>${regionOptions().map((r) => `<option>${esc(r)}</option>`).join("")}</select></label>
      <label>Building / other location<input name="place" list="${idp}-places" autocomplete="off" /></label>
    </div>
    <datalist id="${idp}-places">${places.map((p) => `<option value="${esc(p)}">`).join("")}</datalist>
    <div class="two-col">
      <label>Room<input name="room" /></label>
      <label>County<input name="county" /></label>
    </div>
    <label>Address<input name="address" /></label>
    <div class="two-col">
      <label>City<input name="city" /></label>
      <div class="two-col"><label>State<input name="state" maxlength="2" placeholder="TN" /></label><label>Zip<input name="zip" /></label></div>
    </div>
    ${showMap ? `
    <label>Search an address <span class="hint">(moves the pin)</span>
      <div class="combo" data-geo-box><input type="text" data-geo-q placeholder="Type an address or place…" autocomplete="off" /><ul data-geo-list hidden></ul></div>
      <span class="hint" data-geo-status></span>
    </label>
    <div class="loc-map" data-map></div>
    <div class="two-col" style="margin-top:.5rem"><label>Latitude<input name="lat" type="number" step="any" /></label><label>Longitude<input name="lng" type="number" step="any" /></label></div>` : ""}
  `;
}

/**
 * Wires up a locationFormHTML block inside `root` and fills it from `row`.
 * Returns { read() → {attrs, geometry}, destroy() }.
 */
export function mountLocation(root, row, { editable = true, showMap = true } = {}) {
  const f = (n) => root.querySelector(`[name="${n}"]`);
  const set = (n, v) => { const el = f(n); if (el) el.value = v ?? ""; };
  const lat0 = row && (row[I.lat] ?? row._geom?.y);
  const lng0 = row && (row[I.lng] ?? row._geom?.x);
  if (row) {
    set("region", row[I.region]); set("place", row[I.place]); set("room", row[I.room]); set("county", row[I.county]);
    set("address", row[I.address]); set("city", row[I.city]); set("state", row[I.state]); set("zip", row[I.zip]);
    set("lat", lat0); set("lng", lng0);
  }
  root.querySelectorAll("input,select").forEach((el) => { el.disabled = !editable; });

  let map = null, marker = null;
  const statusEl = root.querySelector("[data-geo-status]");
  const say = (t) => { if (statusEl) statusEl.textContent = t || ""; };

  function placePin(lat, lng, fromMap) {
    if (!map || !Number.isFinite(lat) || !Number.isFinite(lng)) return;
    if (!marker) {
      marker = L.marker([lat, lng], { draggable: editable }).addTo(map);
      marker.on("dragend", () => { const p = marker.getLatLng(); setLatLng(p.lat, p.lng); reverse(p.lat, p.lng); });
    } else marker.setLatLng([lat, lng]);
    if (!fromMap) map.setView([lat, lng], Math.max(map.getZoom(), 14));
  }
  function setLatLng(lat, lng) { set("lat", lat.toFixed(6)); set("lng", lng.toFixed(6)); }

  async function reverse(lat, lng) {
    say("Looking up the address…");
    try {
      const r = await (await fetch(`${NOM}/reverse?format=json&addressdetails=1&lat=${lat}&lon=${lng}`)).json();
      if (r && r.address) { fillAddress(r.address); say(""); } else say("No address found at that point.");
    } catch { say("Couldn't look up an address for this point (network blocked?)."); }
  }
  function fillAddress(a) {
    set("address", [a.house_number, a.road].filter(Boolean).join(" "));
    set("city", a.city || a.town || a.village || a.hamlet || "");
    set("county", a.county || "");
    const st = String(a["ISO3166-2-lvl4"] || "").split("-")[1] || "";
    if (st) set("state", st);
    set("zip", a.postcode || "");
  }

  if (showMap && root.querySelector("[data-map]") && typeof L !== "undefined") {
    map = L.map(root.querySelector("[data-map]")).setView([CONFIG.MAP_DEFAULT_LAT, CONFIG.MAP_DEFAULT_LNG], CONFIG.MAP_DEFAULT_ZOOM);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" }).addTo(map);
    if (Number.isFinite(Number(lat0)) && lat0 !== null && lat0 !== "") placePin(Number(lat0), Number(lng0));
    if (editable) map.on("click", (e) => { placePin(e.latlng.lat, e.latlng.lng, true); setLatLng(e.latlng.lat, e.latlng.lng); reverse(e.latlng.lat, e.latlng.lng); });
    setTimeout(() => map && map.invalidateSize(), 60);
    ["lat", "lng"].forEach((n) => f(n)?.addEventListener("change", () => {
      const la = parseFloat(f("lat").value), lo = parseFloat(f("lng").value);
      if (Number.isFinite(la) && Number.isFinite(lo)) placePin(la, lo);
    }));
  }

  // region preset: only on an actual change by the user
  f("region")?.addEventListener("change", (e) => {
    const p = presetFor(e.target.value);
    if (!p) return;
    set("county", p.attrs[I.county]); set("address", p.attrs[I.address]); set("city", p.attrs[I.city]);
    set("state", p.attrs[I.state]); set("zip", p.attrs[I.zip]); set("lat", p.attrs[I.lat]); set("lng", p.attrs[I.lng]);
    placePin(p.attrs[I.lat], p.attrs[I.lng]);
  });

  // address search (debounced; Nominatim asks for ~1 request/second)
  const q = root.querySelector("[data-geo-q]");
  const list = root.querySelector("[data-geo-list]");
  if (q && list && editable) {
    let results = [];
    const run = debounce(async () => {
      const t = q.value.trim();
      if (t.length < 4) { list.hidden = true; return; }
      say("Searching…");
      try {
        results = await (await fetch(`${NOM}/search?format=json&addressdetails=1&limit=5&countrycodes=us&q=${encodeURIComponent(t)}`)).json();
        list.innerHTML = results.map((r, i) => `<li data-i="${i}">${esc(r.display_name)}</li>`).join("") || `<li class="grp">No matches</li>`;
        list.hidden = false; say("");
      } catch { say("Address search failed (network blocked?)."); }
    }, 500);
    q.addEventListener("input", run);
    list.addEventListener("mousedown", (e) => {
      const li = e.target.closest("[data-i]");
      if (!li) return;
      e.preventDefault();
      const r = results[Number(li.dataset.i)];
      list.hidden = true; q.value = r.display_name;
      fillAddress(r.address || {});
      const la = parseFloat(r.lat), lo = parseFloat(r.lon);
      setLatLng(la, lo); placePin(la, lo);
    });
    q.addEventListener("blur", () => setTimeout(() => (list.hidden = true), 150));
  }

  return {
    /** Current values as layer attributes (+ point geometry when lat/lng are valid). */
    read() {
      const attrs = {
        [I.region]: f("region").value || "", [I.place]: f("place").value || "", [I.room]: f("room").value || "",
        [I.county]: f("county").value || "", [I.address]: f("address").value || "", [I.city]: f("city").value || "",
        [I.state]: f("state").value || "", [I.zip]: f("zip").value || "",
      };
      let geometry;
      const la = f("lat") ? parseFloat(f("lat").value) : NaN, lo = f("lng") ? parseFloat(f("lng").value) : NaN;
      if (Number.isFinite(la) && Number.isFinite(lo)) {
        attrs[I.lat] = la; attrs[I.lng] = lo; geometry = geometryFor(la, lo);
      }
      return { attrs, geometry };
    },
    destroy() { if (map) { map.remove(); map = null; } },
  };
}
