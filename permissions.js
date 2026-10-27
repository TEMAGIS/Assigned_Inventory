// ---------------------------------------------------------------------------
// Role rules. Nothing here is a security boundary by itself: ArcGIS layer
// sharing is. This decides what the UI *offers*.
//
//   Inventory Administrator (Logistics Inventory Management team; stored as
//     "Property Officer") : everything.
//   Property owner   : anyone (any role) whose Users row lists property owner codes in
//                      property_owner_of. For items whose property_owner is one of those:
//                      assign, transfer, return, update location, including unassigned
//                      items in that section's pool. Cannot add items, import, edit item
//                      details or manage people.
//   Manager          : VIEW ONLY on others' items: sees People, Activity and who has
//                      confirmed. Edits nothing unless they are also a property owner.
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

/** Property owner codes this person looks after (Users.property_owner_of, separated by ";" or "|"). */
export const ownedList = (u) =>
  !u ? [] : String(u[U.propertyOwnerOf] || "").split(/[;|\n]/).map((s) => s.trim()).filter(Boolean);
export const isPropertyOwner = (u) => ownedList(u).length > 0;
export const ownsCode = (u, code) => {
  const c = String(code ?? "").trim().toLowerCase();
  return !!c && ownedList(u).some((o) => o.toLowerCase() === c);
};
export const ownsItem = (u, row) => ownsCode(u, row[I.propertyOwner]);
/** Property owners, Managers (view) : see People and Activity. */
export const canSeeOversight = (u) => isPropertyOfficer(u) || isManager(u) || isPropertyOwner(u);
/** A plain person with no oversight role: only their own items. */
export const isLimitedUser = (u) => !canSeeOversight(u);

/** Adding items stays with Logistics (Inventory Administrators), who also set the owner. */
export const canAddInventory = (me) => isPropertyOfficer(me);
/** May this person change other people's inventory? */
export const canEditOthers = (me) => isPropertyOfficer(me) || isPropertyOwner(me);
export const canViewPeople = (me) => canSeeOversight(me);
export const canEditPeople = (me) => isPropertyOfficer(me);
export const canManageSettings = (me) => isPropertyOfficer(me);
export const canBulkImport = (me) => isPropertyOfficer(me);

/** Which groups of one inventory row `me` may change right now. */
export function editableGroups(row, me) {
  const none = { identity: false, assignment: false, location: false, problem: false };
  if (!me || !isActive(me)) return none;
  if (isPropertyOfficer(me)) return { identity: true, assignment: true, location: true, problem: true };
  const assignedId = row[I.assignedTo];
  const mine = !!assignedId && !!me[U.edison] && String(assignedId) === String(me[U.edison]);
  const owns = ownsItem(me, row); // covers the section's unassigned pool too
  return { identity: false, assignment: owns, location: owns || mine, problem: owns || mine };
}

export const canEditAnything = (g) => g.identity || g.assignment || g.location;
