// ---------------------------------------------------------------------------
// Role rules — identical in effect to the Assigned Inventory Editor's
// permissions.js (Property Officer / Manager / Non-Manager), rewritten for the
// flat row objects this app uses. Nothing here is a security boundary by
// itself: ArcGIS layer sharing is. This decides what the UI *offers*.
//
//   Property Officer : everything.
//   Manager          : assign / transfer / return, and update location, on items
//                      assigned in their own section or to a direct report, plus
//                      any UNASSIGNED item. Item identity is view-only. Can see
//                      the People tab but not change it.
//   Non-Manager      : update the location of, and report a problem on, items
//                      assigned to themselves. Nothing else.
// ---------------------------------------------------------------------------

import { CONFIG } from "./config.js";
const U = CONFIG.USR;
const I = CONFIG.INV;

export const isActive = (u) => !!u && ["yes", "y", "true"].includes(String(u[U.active] || "").trim().toLowerCase());
export const roleOf = (u) => (u ? u[U.permissions] || null : null);
export const isPropertyOfficer = (u) => roleOf(u) === CONFIG.ROLE_PROPERTY_OFFICER;
export const isManager = (u) => roleOf(u) === CONFIG.ROLE_MANAGER;
export const isNonManager = (u) => roleOf(u) === CONFIG.ROLE_NON_MANAGER;

export const canAddInventory = (me) => isPropertyOfficer(me) || (isManager(me) && !!CONFIG.ALLOW_MANAGER_ADD_INVENTORY);
export const canViewPeople = (me) => isPropertyOfficer(me) || isManager(me);
export const canEditPeople = (me) => isPropertyOfficer(me);
export const canManageSettings = (me) => isPropertyOfficer(me);
export const canBulkImport = (me) => isPropertyOfficer(me);

function inManagerScope(me, assignee) {
  if (!assignee) return true; // unassigned: any Manager may hand it out
  const meId = me[U.edison];
  if (me[U.section] && assignee[U.section] && me[U.section] === assignee[U.section]) return true;
  if (meId && assignee[U.supervisor] && String(assignee[U.supervisor]) === String(meId)) return true;
  return false;
}

/** Which groups of one inventory row `me` may change right now. */
export function editableGroups(row, me, usersByEdison) {
  const none = { identity: false, assignment: false, location: false, problem: false };
  if (!me || !isActive(me)) return none;
  if (isPropertyOfficer(me)) return { identity: true, assignment: true, location: true, problem: true };
  const assignedId = row[I.assignedTo];
  const assignee = assignedId ? usersByEdison.get(String(assignedId)) : null;
  if (isManager(me)) {
    const ok = inManagerScope(me, assignee);
    return { identity: false, assignment: ok, location: ok, problem: ok };
  }
  if (isNonManager(me)) {
    const mine = assignedId && me[U.edison] && String(assignedId) === String(me[U.edison]);
    return { identity: false, assignment: false, location: !!mine, problem: !!mine };
  }
  return none;
}

export const canEditAnything = (g) => g.identity || g.assignment || g.location;
