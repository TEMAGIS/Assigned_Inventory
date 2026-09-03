// ---------------------------------------------------------------------------
// App configuration. Nothing in this file is secret — the ArcGIS OAuth
// client ID below is a *public* client identifier (PKCE, no client secret),
// safe to ship in a public repo. All access control happens on ArcGIS
// Online's side (who you've shared the app item + the two layers with) and
// in this app's own role logic (see permissions.js) — never trust the
// client alone for anything you wouldn't also enforce with layer sharing.
//
// >>> Everything marked VERIFY below was inferred from the two Survey123
//     forms you provided (TEMA Assign Inventory / TEMA Assigned Inventory
//     Users), not from a live read of the actual FeatureServer schemas —
//     both layers require a token and returned "Token Required" when
//     checked from the build sandbox. Sign in once, open the browser
//     console, and check the "[schema check]" messages logged by
//     esri-client.js on load — it compares every field name below against
//     the live layer and warns about anything that doesn't match, the same
//     kind of guardrail ReadyOp Edit's console diagnostic dump gives you. <<<
// ---------------------------------------------------------------------------

export const CONFIG = {
  // --- ArcGIS OAuth (authorization-code + PKCE, no ArcGIS Maps SDK needed) ---
  // "https://www.arcgis.com" works for any ArcGIS Online org; using
  // "https://<your-org>.maps.arcgis.com" skips the "choose your
  // organization" step on the sign-in screen.
  ARCGIS_PORTAL_URL: "https://www.arcgis.com",

  // >>> REPLACE with a NEW OAuth application's client ID — do not reuse
  //     ReadyOp Edit's or Preds Summary's. Register it as a "Native
  //     Application" (or another public-client type) in the ArcGIS
  //     Developers console / your org's Content, so PKCE works without a
  //     client secret. <<<
  ARCGIS_APP_ID: "hVqEqRUHOgoKwCkj",

  // >>> Must exactly match a Redirect URI registered on that OAuth app
  //     (trailing slash included). Update once you know where this is
  //     hosted — this app's own index.html doubles as its OAuth callback
  //     page (same pattern as ReadyOp Edit), so no separate callback URL
  //     is needed. <<<
  ARCGIS_REDIRECT_URI: "https://temagis.github.io/Assigned_Inventory/",

  // Refresh-token lifetime in MINUTES (ArcGIS max is 20160 = 14 days).
  ARCGIS_TOKEN_EXPIRATION_MINUTES: 20160,
  ARCGIS_REFRESH_BUFFER_MS: 5 * 60 * 1000,
  ARCGIS_TOKEN_STORAGE_KEY: "assigned_inventory_arcgis_token_v1",

  // --- The two hosted feature layers this app reads/writes ---
  INVENTORY_LAYER_URL:
    "https://services1.arcgis.com/kILp9lqGUeOhnDbI/arcgis/rest/services/service_46a68401054a4b83bf84cf959c3ee7aa/FeatureServer/0",
  USERS_LAYER_URL:
    "https://services1.arcgis.com/kILp9lqGUeOhnDbI/arcgis/rest/services/service_9a64986429af4a56965e754b11fbcfba/FeatureServer/0",

  // --- Inventory field names — VERIFY (see note at top of file) ---
  // Confirmed from the "TEMA Assign Inventory" Survey123 form (the item
  // identity fields ship read-only there — that survey only ever edits
  // assignment + location — but the field NAMES it reads/writes are real).
  INV_TAG_FIELD: "tag_number",
  INV_SERIAL_FIELD: "serial_number",
  INV_CATEGORY_FIELD: "item_category",
  INV_STATUS_FIELD: "status",
  INV_ITEM_FIELD: "item",
  INV_MAKE_FIELD: "make",
  INV_MODEL_FIELD: "model",
  INV_DESCRIPTION_FIELD: "description",
  INV_ASSIGNED_TO_FIELD: "assigned_to", // holds the assignee's edison_id
  INV_DATE_ASSIGNED_FIELD: "date_assigned",
  INV_REGION_FIELD: "region",
  INV_PLACENAME_FIELD: "placename",
  INV_ROOM_FIELD: "room",
  INV_COUNTY_FIELD: "county",
  INV_ADDRESS_FIELD: "address",
  INV_CITY_FIELD: "city",
  INV_STATE_FIELD: "state",
  INV_ZIP_FIELD: "zip",
  INV_LAT_FIELD: "latitude",
  INV_LONG_FIELD: "longitude",
  // The Survey123 form also writes an actual point geometry
  // (esriGeometryPoint, WGS84). Leave true unless your layer turns out to
  // be a table with no geometry.
  INV_HAS_GEOMETRY: true,

  // >>> VERIFY: "EditDate" is the standard field name ArcGIS Online
  //     maintains automatically on a hosted layer that has "Track create
  //     and update" (editor tracking) turned on — it's not part of the
  //     Assign Inventory Survey123 form itself, so it wasn't in the form
  //     to confirm against. The list defaults to sorting by this field
  //     (most recently edited first). If the "[schema check]" console
  //     warning flags it as missing, editor tracking probably isn't
  //     enabled on the Inventory layer — turn it on under the layer's
  //     item settings → Editing, or change this to whatever field name
  //     your org tracks it under. Records with no value here (or if the
  //     field genuinely doesn't exist) fall back to tag-number order. <<<
  INV_EDIT_DATE_FIELD: "EditDate",

  // Region pills — exactly the 5 options the Assign Inventory form ships
  // (note: "HQ" here, not "Southeast"-then-some-fifth-option — this list
  // differs slightly from the ReadyOp Contacts app's 4-region list).
  INV_REGION_OPTIONS: ["West", "Middle", "East", "Southeast", "HQ"],

  // The single search box matches (case-insensitive substring) against all
  // of these Inventory fields at once. Extend if useful.
  INV_SEARCH_FIELDS: ["tag_number", "serial_number", "item", "make", "model", "item_category", "description", "placename", "room"],

  // Whether a Manager (not just a Property Officer) may add brand-new
  // inventory records. Default false — flip to true if that matches how
  // your agency actually wants this to work.
  ALLOW_MANAGER_ADD_INVENTORY: false,

  // --- Users field names — VERIFY (see note at top of file) ---
  // Confirmed directly from the "TEMA Assigned Inventory Users" XForm.
  USR_EDISON_ID_FIELD: "edison_id",
  USR_FIRST_NAME_FIELD: "first_name",
  USR_LAST_NAME_FIELD: "last_name",
  USR_FULL_NAME_FIELD: "full_name",
  USR_EMAIL_FIELD: "email",
  USR_SECTION_FIELD: "tema_section",
  USR_ACTIVE_FIELD: "active", // stores "yes" / "no"
  USR_PERMISSIONS_FIELD: "permissions", // stores one of USR_ROLE_* below
  USR_DESCRIPTION_FIELD: "description",
  USR_SUPERVISOR_ID_FIELD: "supervisor_id", // another user's edison_id
  USR_IMAGE_URL_FIELD: "image_url",
  // qr_code ships as a Survey123 image *attachment*, not an attribute —
  // handled through the FeatureServer's /attachments endpoints, not a
  // config field.

  USR_SECTION_OPTIONS: [
    "Ops & Admin Support",
    "Executive",
    "Operations",
    "Mitigation & Recovery",
    "Preparedness",
  ],

  // --- Roles ---
  // The exact three strings the Users form's "Permissions" question
  // stores. Role logic in permissions.js keys off these constants —
  // change both here and in that likert list together if you ever rename
  // a role in the live data.
  USR_ROLE_PROPERTY_OFFICER: "Property Officer",
  USR_ROLE_MANAGER: "Manager",
  USR_ROLE_NON_MANAGER: "Non-Manager",

  // --- How the signed-in ArcGIS user is matched to a Users record ---
  // There's no "ArcGIS username" field on the Users layer — email is the
  // only identifier both systems share, so sign-in matches the ArcGIS
  // account's email (from /sharing/rest/community/self) against
  // USR_EMAIL_FIELD, case-insensitively. If your org's ArcGIS emails and
  // this roster's emails ever diverge (e.g. one uses an alias), sign-in
  // will report "no matching user record" — see permissions.js.
  MATCH_CURRENT_USER_BY: "email",

  // --- Roster loading ---
  // Both layers are fetched in full on sign-in (paginated via
  // resultOffset) and kept in memory — same reasoning as ReadyOp Edit's
  // roster load: search/filter and the permission scoping below (Manager
  // → "anyone in my section", Non-Manager → "just my own assignments")
  // all need to run against the whole roster, not a page at a time. Users
  // rosters are typically small; Inventory may not be, so it's paged in
  // batches of this size rather than requested in one shot.
  ROSTER_FETCH_PAGE_SIZE: 1000,
  RENDER_BATCH_SIZE: 100,

  // --- Map (location picker on the Inventory edit form) ---
  // Centered on Tennessee by default; ARCGIS_HOME_LAT/LONG below match
  // the home location saved in the Assign Inventory survey's own map
  // settings.
  MAP_DEFAULT_LAT: 36.0986,
  MAP_DEFAULT_LONG: -86.7584,
  MAP_DEFAULT_ZOOM: 7,
};
