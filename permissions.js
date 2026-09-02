// ---------------------------------------------------------------------------
// Role-based access control. Nothing here is a security boundary by itself
// — the real enforcement is ArcGIS Online layer sharing (who can even reach
// these two layers with a token) plus whatever the live FeatureServer
// itself allows editors to touch. This module decides what the UI *offers*
// to a signed-in user, so people aren't shown edit controls that would
// just fail (or, worse, silently succeed) against data they shouldn't be
// touching.
//
// >>> The three-role model below (Property Officer / Manager / Non-Manager)
//     is confirmed — it's the exact "Permissions" question on the Users
//     Survey123 form. How much editing power each role should have on
//     INVENTORY records is this app's own design choice, not something the
//     forms specify — documented per-role below, and easy to change in one
//     place if it doesn't match how your agency actually wants this to
//     work. <<<
// ---------------------------------------------------------------------------

import { CONFIG } from "./config.js?v=20260902a";

/**
 * Finds the signed-in user's own row in the Users roster, matching by
 * email (case-insensitive) — see MATCH_CURRENT_USER_BY in config.js for
 * why email is the join key. Returns null if no match (the person hasn't
 * been added to the Users layer yet) — callers should treat that as
 * "no access" rather than guessing a role.
 */
export function findCurrentUserRecord(usersRoster, email) {
  if (!email) return null;
  const target = email.trim().toLowerCase();
  return (
    usersRoster.find(
      (u) => (u.attributes[CONFIG.USR_EMAIL_FIELD] || "").trim().toLowerCase() === target
    ) || null
  );
}

export function isActive(userFeature) {
  if (!userFeature) return false;
  const v = (userFeature.attributes[CONFIG.USR_ACTIVE_FIELD] || "").trim().toLowerCase();
  return v === "yes" || v === "y" || v === "true";
}

export function roleOf(userFeature) {
  return userFeature ? userFeature.attributes[CONFIG.USR_PERMISSIONS_FIELD] || null : null;
}

export function isPropertyOfficer(userFeature) {
  return roleOf(userFeature) === CONFIG.USR_ROLE_PROPERTY_OFFICER;
}
export function isManager(userFeature) {
  return roleOf(userFeature) === CONFIG.USR_ROLE_MANAGER;
}
export function isNonManager(userFeature) {
  return roleOf(userFeature) === CONFIG.USR_ROLE_NON_MANAGER;
}

/**
 * Whether `me` may add brand-new Inventory records (item identity fields,
 * not just assignment/location).
 */
export function canAddInventory(me) {
  if (isPropertyOfficer(me)) return true;
  if (isManager(me)) return !!CONFIG.ALLOW_MANAGER_ADD_INVENTORY;
  return false;
}

export function canDeleteInventory(me) {
  return isPropertyOfficer(me);
}

/** Whether `me` may access the Users tab at all (view the roster). */
export function canViewUsers(me) {
  return isPropertyOfficer(me) || isManager(me);
}
/** Whether `me` may add/edit Users records — Property Officer only. */
export function canEditUsers(me) {
  return isPropertyOfficer(me);
}

/**
 * Whether inventory-record `assignee` (a Users feature, or null if
 * unassigned) falls within Manager `me`'s scope: same section, or a direct
 * report (assignee.supervisor_id === me.edison_id). An UNASSIGNED item is
 * deliberately treated as in-scope too — a Manager has to be able to edit
 * an unassigned record in the first place in order to assign it to one of
 * their own people; restricting scope to "already assigned to someone I
 * manage" would make it impossible for a Manager to ever hand out new
 * gear, only reassign already-assigned gear.
 */
function inManagerScope(me, assignee) {
  if (!assignee) return true; // unassigned — fair game for any Manager to claim for their team
  const meEdisonId = me.attributes[CONFIG.USR_EDISON_ID_FIELD];
  const meSection = me.attributes[CONFIG.USR_SECTION_FIELD];
  const assigneeSection = assignee.attributes[CONFIG.USR_SECTION_FIELD];
  const assigneeSupervisorId = assignee.attributes[CONFIG.USR_SUPERVISOR_ID_FIELD];
  if (meSection && assigneeSection && meSection === assigneeSection) return true;
  if (meEdisonId && assigneeSupervisorId && String(assigneeSupervisorId) === String(meEdisonId)) return true;
  return false;
}

/**
 * Computes which groups of fields on one Inventory record `me` may edit
 * right now:
 *   - identity: tag/serial/category/status/item/make/model/description
 *   - assignment: assigned_to / date_assigned (who has it)
 *   - location: region/placename/room/address/.../lat/long (where it is)
 *
 * `usersByEdisonId` is a Map of edison_id → Users feature, built once from
 * the full Users roster (see app.js) — used to look up who an Inventory
 * record is currently assigned to, so a Manager's "my section" scope can
 * be checked.
 *
 * Design (see file header — this is this app's own policy, not something
 * the source forms dictate):
 *   - Property Officer: everything, always.
 *   - Manager: assignment + location on records assigned within their own
 *     section or to a direct report; identity fields are read-only even
 *     for Manager (item identity is a Property Officer concern); nothing
 *     on records outside their scope.
 *   - Non-Manager: assignment + location, but ONLY on records currently
 *     assigned to themselves — matches exactly what the "Assign Inventory"
 *     Survey123 form already lets any user do today. Never identity
 *     fields, never someone else's assignment.
 */
export function editableGroups(inventoryRecord, me, usersByEdisonId) {
  const none = { identity: false, assignment: false, location: false };
  if (!me || !isActive(me)) return none;

  if (isPropertyOfficer(me)) {
    return { identity: true, assignment: true, location: true };
  }

  const assignedToId = inventoryRecord.attributes[CONFIG.INV_ASSIGNED_TO_FIELD];
  const assignee = assignedToId ? usersByEdisonId.get(String(assignedToId)) : null;

  if (isManager(me)) {
    const inScope = inManagerScope(me, assignee);
    return { identity: false, assignment: inScope, location: inScope };
  }

  if (isNonManager(me)) {
    const meEdisonId = me.attributes[CONFIG.USR_EDISON_ID_FIELD];
    const isMine = assignedToId && meEdisonId && String(assignedToId) === String(meEdisonId);
    return { identity: false, assignment: false, location: !!isMine };
    // Note: assignment (who it's assigned to) is deliberately NOT editable
    // by a Non-Manager even on their own item — reassigning inventory to a
    // different person is a Manager/Property Officer action. A
    // Non-Manager can update WHERE their own item is, not WHO has it.
  }

  return none;
}

/** True if `groups` (from editableGroups) allows touching the record at all. */
export function canEditAnything(groups) {
  return groups.identity || groups.assignment || groups.location;
}
