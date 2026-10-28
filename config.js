// ---------------------------------------------------------------------------
// Assigned Inventory Console — configuration.
// Nothing in this file is secret: the OAuth client ID is a *public* identifier
// (PKCE, no client secret). Real access control = ArcGIS Online sharing of the
// layers below + the role rules in permissions.js.
//
// Field names, layer URLs, the OAuth app and the redirect URI are carried over
// unchanged from the Assigned Inventory Editor, so this app can be hosted at the
// SAME address as the Editor (replacing it) without registering anything new.
// ---------------------------------------------------------------------------

export const CONFIG = {
  // --- ArcGIS OAuth (authorization-code + PKCE) ---
  ARCGIS_PORTAL_URL: "https://www.arcgis.com",
  ARCGIS_APP_ID: "hVqEqRUHOgoKwCkj",
  // Must exactly match a Redirect URI registered on that OAuth app. Leave as-is to
  // host this at the Editor's old address; blank = use this page's own folder URL.
  ARCGIS_REDIRECT_URI: "https://temagis.github.io/Assigned_Inventory/",
  ARCGIS_TOKEN_EXPIRATION_MINUTES: 20160,
  ARCGIS_REFRESH_BUFFER_MS: 5 * 60 * 1000,
  ARCGIS_TOKEN_STORAGE_KEY: "assigned_inventory_arcgis_token_v1",

  // --- ArcGIS Online item IDs of the EDITABLE data (for reference, backups, support) ---
  // Item page: https://www.arcgis.com/home/item.html?id=<id>
  // These are the editable layers. People who should only VIEW inventory are meant to
  // use separate view-only copies (see VIEW_*_LAYER_URL below, once provided).
  ITEM_IDS: {
    inventory: { id: "9c27c78273764d6abe12853cca3791dd", label: "Inventory (editable)" },
    users: { id: "72ec26c1f142418c83eba2a02ef2d2e7", label: "Users (editable)" },
    log: { id: "bbc50e820bae4d11968c49868224c9e4", label: "Assigned Inventory log (Activity + Lists, editable)" },
    legacy: { id: "09549100576746d28acd7351b1decedd", label: "Legacy assignment history (archive, read only here)" },
    photoAudit: { id: "c569bf2ba36842d6a33ee74c3bcff2f1", label: "Inventory photo audit (Survey123 layer, photos are attachments)" },
    viewInventory: { id: "0d18e914da554b6994176f8f3aa5322e", label: "Inventory (view only copy)" },
    viewUsers: { id: "d42aa37b0d8f44c9a04a24f00fd9637a", label: "Users (view only copy)" },
    viewLog: { id: "d1082eb050bf490390ab41c58bbe2ca1", label: "Assigned Inventory history (view only copy)" },
  },

  // People whose ArcGIS account cannot open the editable layers above are switched to these
  // VIEW-ONLY copies automatically (item IDs; the app looks up their service URLs).
  // They can read inventory and history, and report a problem, but change nothing else.
  VIEW_ITEM_IDS: {
    inventory: "0d18e914da554b6994176f8f3aa5322e",
    users: "d42aa37b0d8f44c9a04a24f00fd9637a",
    log: "d1082eb050bf490390ab41c58bbe2ca1",
  },

  // Inventory_Photo_Audit: one row per audit, photos as attachments. Matched to items by tag number.
  PHOTO_AUDIT_ITEM_ID: "c569bf2ba36842d6a33ee74c3bcff2f1",
  PHOTO_AUDIT_LAYER_ID: 0,
  AUDIT: { tag: ["tagnumber", "tagtxt", "barcode", "scan_enter"], date: "inspectiondate", by: "fullname" },

  // --- NEW: problem reports (separate small service everyone can ADD to) ---
  // Create it from Settings → Problem reports. Then paste its item ID or …/FeatureServer URL
  // here to skip the lookup by title (optional).
  PROBLEMS_SERVICE_TITLE: "TEMA_Assigned_Inventory_Problems",
  PROBLEMS_ITEM_ID: "",
  PROBLEMS_SERVICE_URL: "",

  // --- The two existing hosted layers (unchanged from the Editor) ---
  INVENTORY_LAYER_URL:
    "https://services1.arcgis.com/kILp9lqGUeOhnDbI/arcgis/rest/services/service_46a68401054a4b83bf84cf959c3ee7aa/FeatureServer/0",
  USERS_LAYER_URL:
    "https://services1.arcgis.com/kILp9lqGUeOhnDbI/arcgis/rest/services/service_9a64986429af4a56965e754b11fbcfba/FeatureServer/0",

  // --- NEW: the Activity log (the app's own history, like TEMAzon's Transactions) ---
  // A small separate hosted service holding two tables: Activity and Lists.
  // Create it from Settings → "Create the log service" (needs a publisher account),
  // then share it with the same group as the two layers above, editing ON.
  // Leave ACTIVITY_SERVICE_URL blank and the app finds it by title; paste the
  // …/FeatureServer URL here only if you want to skip that lookup.
  ACTIVITY_SERVICE_URL: "",
  ACTIVITY_SERVICE_TITLE: "TEMA_Assigned_Inventory_Log",

  // Where the old webhook history lives (item ID or layer URL). Pre-fills Settings → Legacy history.
  LEGACY_HISTORY_SOURCE: "09549100576746d28acd7351b1decedd",

  // --- Inventory field names (same as the Editor; see the [schema check] console line) ---
  INV: {
    tag: "tag_number",
    serial: "serial_number",
    category: "item_category",
    status: "status",
    item: "item",
    make: "make",
    model: "model",
    description: "description",
    assignedTo: "assigned_to", // holds the assignee's edison_id
    dateAssigned: "date_assigned",
    region: "region",
    place: "placename",
    room: "room",
    county: "county",
    address: "address",
    city: "city",
    state: "state",
    zip: "zip",
    lat: "latitude",
    lng: "longitude",
    statusReason: "status_reason",
    receiving: "receiving", // original reception date
    quantity: "quantity",
    cost: "cost",
    acquisition: "acquisition",
    color: "color",
    imei: "imei",
    partNumber: "part_number",
    propertyOwner: "property_owner", // coded-value domain: which section owns the item
    editDate: "EditDate", // set by editor tracking; used for "recently changed" sort
  },
  INV_HAS_GEOMETRY: true,

  // --- Users field names (same as the Editor) ---
  USR: {
    edison: "edison_id",
    first: "first_name",
    last: "last_name",
    full: "full_name",
    email: "email",
    section: "tema_section",
    active: "active", // "yes" / "no"
    permissions: "permissions",
    description: "description",
    supervisor: "supervisor_id", // another user's edison_id
    imageUrl: "image_url",
    propertyOwnerOf: "property_owner_of", // optional text: property owner codes this person looks after, separated by ";" (see Settings)
  },

  ROLE_PROPERTY_OFFICER: "Property Officer", // the VALUE stored in the Users layer (shown as "Inventory Administrator")
  ROLE_LABELS: { "Property Officer": "Inventory Administrator" }, // what people see; change the value in the data later if you wish
  ROLE_MANAGER: "Manager",
  ROLE_NON_MANAGER: "Non-Manager",
  ROLES: ["Non-Manager", "Manager", "Property Officer"],


  // --- Status wording (VERIFY against your live data) ---
  // The app does not know your exact status values, so it recognises them by
  // pattern. Change these if your layer uses different words.
  STATUS_ATTENTION_PATTERN: "repair|broken|damag|lost|missing|stolen|attention|defect",
  STATUS_RETIRED_PATTERN: "inactive|retire|dispos|surplus|sold|scrap|decommission",
  STATUS_DEFAULTS: ["Active", "Inactive"],
  // The Survey123 form's choices: an Inactive item also gets one of these reasons.
  STATUS_REASONS: ["Surplus", "Transfer", "Lost or Damaged", "Return to Vendor", "Disposed", "Recalled"],
  ACQUISITIONS: ["Purchase Order", "Purchasing Card", "Donation", "State Transfer", "Federal", "VAM Purchase", "F and A"],
  // Every item in this inventory is non-consumable; the Survey123 form stores it as the category.
  DEFAULT_CATEGORY: "Non-Consumables",

  // Default dropdown/suggestion lists. Sections, categories and statuses can be
  // edited in the Settings tab once the log service exists; these are the fallbacks.
  SECTIONS: ["Ops & Admin Support", "Executive", "Operations", "Mitigation & Recovery", "Preparedness"],
  CATEGORIES: [],
  REGIONS: ["West", "Middle", "East", "Southeast", "HQ"],

  // Choosing a Region fills County/Address/City/State/Zip and the map pin.
  REGION_LOCATION_PRESETS: {
    HQ: { county: "Davidson County", address: "3041 Sidco Drive", city: "Nashville", state: "TN", zip: "37204", lat: 36.098400, lng: -86.758089 },
    Middle: { county: "Davidson County", address: "1218 Foster Ave", city: "Nashville", state: "TN", zip: "37210", lat: 36.133493, lng: -86.736728 },
    East: { county: "Knox County", address: "803 N Concord St", city: "Knoxville", state: "TN", zip: "37919", lat: 35.960446, lng: -83.954401 },
    West: { county: "Madison County", address: "1510 Highway 70 E", city: "Jackson", state: "TN", zip: "38301", lat: 35.631075, lng: -88.785391 },
    Southeast: { county: "Hamilton County", address: "1801 South Holtzclaw Avenue", city: "Chattanooga", state: "TN", zip: "37404", lat: 35.025062, lng: -85.290342 },
  },

  // --- Loading / display ---
  FETCH_PAGE_SIZE: 1000,
  ROWS_PER_PAGE: 100,
  EDIT_CHUNK: 200, // records per applyEdits call in bulk operations
  MAP_DEFAULT_LAT: 36.0986,
  MAP_DEFAULT_LNG: -86.7584,
  MAP_DEFAULT_ZOOM: 7,
};
