// Reusable pickers: a person combo box (with recents) and a "tick the items" list.
import { esc } from "./shared/util.js";
import { S, U, fullName, initials, isUserActive } from "./state.js";
import { canEditPeople } from "./permissions.js";

const RECENT_KEY = "aic_recent_assignees_v1";
const readRecents = () => { try { return JSON.parse(localStorage.getItem(RECENT_KEY) || "[]"); } catch { return []; } };
export function rememberAssignee(edisonId) {
  try {
    const list = [String(edisonId), ...readRecents().filter((x) => x !== String(edisonId))].slice(0, 6);
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch { /* storage unavailable: recents just won't persist */ }
}

const personRow = (u) =>
  `<li role="option" data-id="${esc(u[U.edison])}"><span class="av">${esc(initials(fullName(u)))}</span><span>${esc(fullName(u))}<br><span class="sub">${esc(u[U.section] || "No section")} · ${esc(u[U.edison])}</span></span></li>`;

/**
 * Person combo box. `box` is an empty element; returns { get(), set(user), focus() }.
 * onNew(text) (optional) is called when the user chooses "+ Add … as a new user".
 */
export function personPicker(box, { onPick, onNew = null, placeholder = "Type a name, email or Edison ID…" }) {
  box.classList.add("combo");
  box.innerHTML = `<input type="text" placeholder="${esc(placeholder)}" autocomplete="off" role="combobox" aria-expanded="false" /><ul role="listbox" hidden></ul>`;
  const inp = box.querySelector("input");
  const ul = box.querySelector("ul");
  let chosen = null;
  let hl = -1;

  const choices = () => {
    const v = inp.value.trim().toLowerCase();
    const active = S.users.filter(isUserActive);
    if (!v) return active;
    return active.filter((u) => [fullName(u), u[U.email], u[U.edison], u[U.section]].join(" ").toLowerCase().includes(v));
  };
  function draw() {
    const v = inp.value.trim();
    const list = choices();
    let html = "";
    if (!v) {
      const recents = readRecents().map((id) => S.usersByEdison.get(id)).filter((u) => u && isUserActive(u));
      if (recents.length) html += `<li class="grp">Recent</li>` + recents.map(personRow).join("") + `<li class="grp">Everyone</li>`;
      const recentIds = new Set(recents.map((u) => String(u[U.edison])));
      html += list.filter((u) => !recentIds.has(String(u[U.edison]))).sort((a, b) => fullName(a).localeCompare(fullName(b))).slice(0, 60).map(personRow).join("");
    } else {
      html += list.sort((a, b) => fullName(a).localeCompare(fullName(b))).slice(0, 30).map(personRow).join("");
    }
    if (onNew && canEditPeople(S.me) && v) html += `<li class="new" data-new="1">+ Add “${esc(v)}” as a new user…</li>`;
    if (!html) html = `<li class="grp">No matching active user</li>`;
    ul.innerHTML = html;
    ul.hidden = false;
    inp.setAttribute("aria-expanded", "true");
    hl = -1;
  }
  const close = () => { ul.hidden = true; inp.setAttribute("aria-expanded", "false"); };
  const pick = (u) => { chosen = u; inp.value = fullName(u); close(); onPick(u); };
  const moveHl = (d) => {
    const items = [...ul.querySelectorAll("li[data-id],li[data-new]")];
    if (!items.length) return;
    hl = (hl + d + items.length) % items.length;
    items.forEach((li, i) => li.classList.toggle("hl", i === hl));
    items[hl].scrollIntoView({ block: "nearest" });
  };

  inp.addEventListener("focus", draw);
  inp.addEventListener("input", () => { chosen = null; onPick(null); draw(); });
  inp.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); if (ul.hidden) draw(); moveHl(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); moveHl(-1); }
    else if (e.key === "Enter") {
      const li = ul.querySelector("li.hl") || (ul.querySelectorAll("li[data-id]").length === 1 ? ul.querySelector("li[data-id]") : null);
      if (li) { e.preventDefault(); e.stopPropagation(); li.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); }
    } else if (e.key === "Escape" && !ul.hidden) { e.stopPropagation(); close(); }
  });
  ul.addEventListener("mousedown", (e) => {
    const li = e.target.closest("li");
    if (!li) return;
    e.preventDefault();
    if (li.dataset.new) { close(); onNew && onNew(inp.value.trim(), (u) => pick(u)); return; }
    if (li.dataset.id) pick(S.usersByEdison.get(li.dataset.id));
  });
  inp.addEventListener("blur", () => setTimeout(close, 120));
  return {
    get: () => chosen,
    set: (u) => { if (u) pick(u); },
    focus: () => inp.focus(),
  };
}
