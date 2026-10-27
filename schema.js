// ---------------------------------------------------------------------------
// Table definitions for the NEW log service (TEMA_Assigned_Inventory_Log):
//   Activity (table 0) — one row per assign / return / transfer / add / change
//   Lists    (table 1) — editable Section / Category / Status dropdown values
// Same compact-spec → addToDefinition pattern TEMAzon's Setup page uses.
// ---------------------------------------------------------------------------

const str = (name, length, alias, extra = {}) => ({ name, type: "esriFieldTypeString", alias: alias || name, length, ...extra });
const int = (name, alias, extra = {}) => ({ name, type: "esriFieldTypeInteger", alias: alias || name, ...extra });
const date = (name, alias, extra = {}) => ({ name, type: "esriFieldTypeDate", alias: alias || name, ...extra });

export const ACTIVITY_TYPES = ["Added", "Assigned", "Transferred", "Returned", "Location updated", "Status changed", "Problem reported", "Edited", "User added", "User changed"];

export const ACTIVITY_TABLE = {
  name: "Activity",
  displayField: "item_desc",
  fields: [
    str("activity_id", 40, "Activity ID"),
    str("activity_type", 30, "Type"),
    date("activity_date", "Date"),
    str("tag_number", 255, "Tag number"),
    str("item_desc", 255, "Item"),
    str("category", 60, "Category"),
    str("from_edison_id", 40, "From (Edison ID)"),
    str("from_name", 150, "From"),
    str("to_edison_id", 40, "To (Edison ID)"),
    str("to_name", 150, "To"),
    str("to_section", 80, "Section"),
    str("region", 40, "Region"),
    str("performed_by", 150, "Performed by"),
    str("performed_by_email", 150, "Performed by email"),
    str("note", 500, "Note"),
  ],
};

export const LISTS_TABLE = {
  name: "Lists",
  displayField: "value",
  fields: [
    str("list_name", 20, "List"), // section | category | status
    str("value", 80, "Value"),
    int("sort_order", "Order"),
  ],
};

export const fieldNames = (spec) => spec.fields.map((f) => f.name);

/** Expands a compact table spec into the full JSON addToDefinition expects. */
export function toTableDefinition(spec) {
  const base = (f) => ({ sqlType: "sqlTypeOther", nullable: true, editable: true, domain: null, defaultValue: null, ...f });
  const fields = [
    { name: "OBJECTID", type: "esriFieldTypeOID", alias: "OBJECTID", sqlType: "sqlTypeOther", nullable: false, editable: false, domain: null, defaultValue: null },
    ...spec.fields.map(base),
    base({ name: "CreationDate", type: "esriFieldTypeDate", alias: "CreationDate", length: 8, editable: false }),
    base({ name: "Creator", type: "esriFieldTypeString", alias: "Creator", length: 128, editable: false }),
    base({ name: "EditDate", type: "esriFieldTypeDate", alias: "EditDate", length: 8, editable: false }),
    base({ name: "Editor", type: "esriFieldTypeString", alias: "Editor", length: 128, editable: false }),
  ];
  return {
    name: spec.name,
    type: "Table",
    displayField: spec.displayField || "",
    description: "",
    copyrightText: "",
    defaultVisibility: true,
    relationships: [],
    isDataVersioned: false,
    supportsRollbackOnFailureParameter: true,
    supportsStatistics: true,
    supportsAdvancedQueries: true,
    geometryType: "",
    minScale: 0,
    maxScale: 0,
    extent: null,
    drawingInfo: null,
    hasM: false,
    hasZ: false,
    objectIdField: "OBJECTID",
    globalIdField: "",
    types: [],
    templates: [],
    hasAttachments: false,
    capabilities: "Query,Create,Update,Delete,Editing",
    editFieldsInfo: { creationDateField: "CreationDate", creatorField: "Creator", editDateField: "EditDate", editorField: "Editor" },
    fields,
  };
}
