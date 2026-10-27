// ---------------------------------------------------------------------------
// Role rules. Nothing here is a security boundary by itself: ArcGIS layer
// sharing is. This decides what the UI *offers*.
//
//   Inventory Administrator (Logistics Inventory Management team; stored as
//     "Property Officer") : everything.
//   Section editor   : anyone (any role) with "Section inventory access = yes" on their
//                      Users row. Assign / transfer / return / update location for items
//                      held in their own section or by a direct report, any unassigned
//                      item, AND add new inventory. Item identity stays administrator-only.
//   Manager          : VIEW ONLY on others' items: sees their section and reports, the
//                      People and Activity tabs, and who has confirmed. Edits nothing
//                      unless they are also given section access.
//   Non-Manager      : sees inventory; on items assigned to themselves can update the
//                      location, confirm, and say "I don't have this".
// ---------------------------------------------------------------------------

import { CONFIG } from "./config.js";
const U = CONFIG.USR;
const I = CONFIG.INV;

export const isActive = (u) => !!u && ["yes", "y", "true"].includes(String(u[U.active] || "").trim().toLowerCase());
export const roleOf = (u) => (u ? u[U.permissions] || null : null);
export const isPropertyOfficer = (u) => roleOf(u) === CONFIG.ROLE_PROPERTY_OFFICER;
export const roleLabel = (r) => (CONFIG.ROLE_LABELS && CONFIG.ROLE_LABELS[r]) || r || "";
export const isManager = (u) => roleOf(u) === CONFIG.ROLE_MANAGER;
export const isNonManager = (u) => roleOf(u) === CONFIG.ROLE_NON_MANAGER;

export const hasSectionAccess = (u) => !!u && ["yes", "y", "true"].includes(String(u[U.sectionAccess] || "").trim().toLowerCase());
/** Manager, or anyone granted section access: works with their section's / reports' items. */
export const isScopedEditor = (u) => isManager(u) || hasSectionAccess(u);
/** A plain Non-Manager: only their own items. */
export const isLimitedUser = (u) => isNonManager(u) && !hasSectionAccess(u);

export const canAddInventory = (me) => isPropertyOfficer(me) || hasSectionAccess(me);
/** May this person change anyone's inventory (beyond their own items)? */
export const canEditOthers = (me) => isPropertyOfficer(me) || hasSectionAccess(me);
export const canViewPeople = (me) => isPropertyOfficer(me) || isScopedEditor(me);
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
  if (hasSectionAccess(me)) {
    const mine = assignedId && me[U.edison] && String(assignedId) === String(me[U.edison]);
    const ok = inManagerScope(me, assignee) || !!mine;
    return { identity: false, assignment: ok, location: ok, problem: ok };
  }
  if (isNonManager(me) || isManager(me)) {
    const mine = assignedId && me[U.edison] && String(assignedId) === String(me[U.edison]);
    return { identity: false, assignment: false, location: !!mine, problem: !!mine };
  }
  return none;
}

export const canEditAnything = (g) => g.identity || g.assignment || g.location;
