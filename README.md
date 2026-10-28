# Assigned Inventory Console

A redesign of the Assigned Inventory Editor in the style of TEMAzon: a scannable table, short dialogs for the everyday jobs, and a history log that records every change. It talks to the **same two ArcGIS layers** (Inventory and Users), uses the **same sign-in, roles and field names**, and can be hosted at the **same address** as the Editor, so nothing about your data or OAuth registration has to change.

## What's different from the Editor

| Job | Editor | Console |
|---|---|---|
| Assign an item | open the record, scroll to Assignment, search, set date, Save | **Assign** button on the row → pick a person (recents on top) → done. Date defaults to today. |
| Assign many | one at a time | tick rows → **Assign N to…** (also bulk **Return**) |
| Transfer / return | edit the assignee field | **Transfer** and **Return** buttons, each recorded in history |
| Scan a tag | – | "Scan / type tag ↵" box opens the right dialog (offers to add an unknown tag) |
| Add an item | full form | dialog matching the Survey123 form: tag, item, make, model and reception date required; category is set to Non-Consumables automatically; quantity (1), status (Active/Inactive + reason), property owner, cost and acquisition under More details; the next tag is suggested; **Save & add another** keeps make/model; optional "assign right after" |
| Add a user | five typed fields + IDs | optional ArcGIS account search fills name/email; role defaults to Non-Manager; duplicate Edison ID / email blocked |
| Who has what | filter by section | **People** tab: pick a person → everything they hold, with Return buttons; warning when an inactive person still holds items |
| History | none in the app | per-item timeline in the item drawer + **Activity** tab (filter, search, export CSV) |
| Many at once | – | **Import CSV** for items and for people, with a preview before anything is saved |
| Old history | webhook layer only | **Settings → Import legacy history**: brings the old webhook assignment history into the Activity log (preview first, safe to re-run) |
| Confirm / correct | – | **Confirm my inventory** and **I don't have this** work for everyone, including view-only people; Inventory Administrators work a **Corrections** list |
| Lists | `config.js` | **Settings** tab (sections, statuses) |
| Non-managers | read-only list | **My items** page (phone-friendly): confirm what you hold, say "I don't have this", update locations |

Kept from the Editor: photos (add / delete / full-size view), the location block (region office presets, address search, click-or-drag map pin), blank placeholder rows hidden, `?readonly=1` and `?section=` links, the Users QR-code image, notes and image URL.

## Roles

The top level is the **Logistics Inventory Management team**, shown in the app as **Inventory Administrator**. (The value stored in each person's Permissions field is still `Property Officer`; the app only changes the label. `CONFIG.ROLE_LABELS` controls it.) Being a **Manager** gives no edit access. Editing beyond your own items comes only from being a **property owner** of the item's section, which an Inventory Administrator grants per person (any role, see below). Adding inventory stays with Inventory Administrators.

| | Inventory Administrator | Property owner (any role) | Manager | Non-Manager |
|---|---|---|---|---|
| Tabs | Inventory, My items, People, Activity, Corrections, Settings | Inventory, My items, People (view), Activity | Inventory, My items, People (view), Activity | Inventory (view), My items |
| Assign / transfer / return | any item | items whose property owner is one of theirs, including unassigned ones | – | – |
| Add inventory, set an item's owner | yes | no | no | no |
| Edit item details | yes | no | no | no |
| Update location | any item | items of their sections, plus own items | own items only | own items only |
| Confirm / "I don't have this" | own items | own items | own items | own items |
| Add users, import, settings, corrections | yes | no | no | no |

A Manager sees inventory and who has confirmed it, but changes nothing unless they are also a property owner. ArcGIS sharing is the real access boundary; these rules decide what the screen *offers*.

## The history log — no webhook needed

Every assign / return / transfer / add / location / status change is written by the app itself to an **Activity** table, right after the inventory edit succeeds. Nothing depends on the existing Lambda webhook, which can stay as it is (it keeps catching edits made outside this app, such as the Survey123 form). The two histories are independent.

Because the Inventory layer and the log are separate services, they can't be one transaction. If the log write fails after the edit succeeded, the edit stands and the person sees a clear warning. If the log doesn't exist yet, everything works and history is simply not recorded.

### One-time setup (about 5 minutes)

1. **Deploy** this folder (see below).
2. **Sign in as an Inventory Administrator** whose ArcGIS account can publish content.
3. The log service (`TEMA_Assigned_Inventory_Log`, with two tables, *Activity* and *Lists*) already exists. Settings no longer has a card for it; if it ever has to be recreated, `createLogService()` in `activity.js` does it. It is a small hosted service called `TEMA_Assigned_Inventory_Log` with two tables, *Activity* and *Lists*.
4. **Share it** (the dialog reminds you): in ArcGIS Online, share that service with the same group as the Inventory and Users layers and make sure **editing is on**. Managers and Non-Managers need to add rows when they act.
5. Optional: edit the Sections / Statuses lists in **Settings**.

The app finds the log service by its title. To skip that lookup, paste its `…/FeatureServer` URL into `ACTIVITY_SERVICE_URL` in `config.js`. If you'd rather create the tables by hand, add two tables named `Activity` and `Lists` with the fields in `schema.js`.

### Importing the old webhook history (optional, once)

The old webhook layer stored a full snapshot of the item at every edit. **Settings → Legacy history → Import legacy history…** reads it (the item ID is pre-filled from `LEGACY_HISTORY_SOURCE` in `config.js`, or choose a CSV export of it) and keeps only the rows where the holder changed: *Assigned* (nobody → someone), *Transferred* (someone → someone else), *Returned* (someone → nobody). An item that already had a holder in its first snapshot gets one **Opening balance** entry. Repeat snapshots and rows with no tag are skipped, and you see counts and a sample before anything is written.

- Each imported entry is marked `legacy #<objectid>` in its note, so running it again (from the layer or a CSV) skips what's already in. Entries show "Legacy history" as *Performed by*.
- The legacy layer is only read, never changed, and the webhook can keep running.
- `assigned_to` in the old data also holds section/region codes (e.g. `0018`); these are imported as they are, named from the old `username` column.
- Dates come from each snapshot's `EditDate` (a CSV export is read as UTC).
- You need the log service first. On your 11,277-row export this gives about 7,700 entries (5,090 opening + about 2,600 changes).

## Photo audit

The `Inventory_Photo_Audit` layer (item `c569bf2ba36842d6a33ee74c3bcff2f1`, one row per audit, photos as attachments) is read by the app and matched to items by tag number, using the first filled of `tagnumber`, `tagtxt`, `barcode`, `scan_enter` (case and spaces ignored; change `CONFIG.AUDIT` if the field names differ). The item panel shows the latest five audits with who did them, the date and their photos (click to enlarge). Inventory Administrators and Managers also get a **Last audit** column and a **No photo audit** tile on Inventory, and the CSV export includes the last audit date. The layer is read-only here; audits are still entered with your existing survey. If it can't be read, the audit parts simply don't appear (Settings → Photo audit says why).

## Property owners

Every inventory item has a **property owner** (the coded-value field `property_owner` on the Inventory layer): the section responsible for it. Item panel, Inventory filter (with an "Owner not set" choice), Owner column and CSV export all use it. Inventory Administrators set it in Add item and Edit details.

To let a person look after a section's items, an Inventory Administrator ticks that section under **People → Edit person → Property owner of** (more than one is allowed). It is stored by code in an optional `property_owner_of` text field on the Users layer, separated by `;`. Property owners can assign, transfer, return and update the location of items owned by their sections, including unassigned items in that section's pool. They cannot add items, import, edit item details or manage people. Items with no owner can be assigned only by Inventory Administrators. A supervisor relationship no longer widens anyone's reach.

**Settings → Property owners** lists the values, adds new ones and removes them (it rewrites the field's coded-value domain, keeping the domain name; the layer owner's account is needed). Renaming existing values is done in ArcGIS Online (field Display). The same card adds the `property_owner_of` field to the Users layer. If people use a view copy of the Users layer, add the field to that view too. As always the app only chooses which buttons to show; people still need edit access to the Inventory layer in ArcGIS Online.

## Region offices

**Settings → Region office addresses** is an editable table (add, change, delete). Choosing a region on an item fills in that office's address, county and map pin; **Find pin** looks up the coordinates from the address. The list is saved in the log service's Lists table (rows `region`, `reg_addr`, `reg_geo`), so it needs the log service. Until a list has been saved, the defaults in `config.js` (`REGIONS`, `REGION_LOCATION_PRESETS`) are used. Changing a region never rewrites items already saved.

## Data problems tab

Inventory Administrators get a **Data** tab (badge = number of high-priority problems). It checks every record against simple rules (duplicate or missing tags, Inactive items still assigned, assignees not in the Users list or inactive, blank status or reason, property owner missing or not in the list, missing make/model/reception date, quantity, serial duplicates, missing assigned date, no location or map pin) and lists the records. Click a problem to filter, click a record to open and fix it; fixed records drop out immediately. **Export all problems (CSV)** downloads the full list. The tab never changes data, and empty placeholder rows are only counted (delete them in ArcGIS Online). Rules live in `dataissues.js`.

## View-only access, confirmations and corrections


**View-only copies.** People whose ArcGIS account can't open the editable Inventory/Users layers are switched automatically to the view-only copies listed in `VIEW_ITEM_IDS` (`config.js`; the app looks up their addresses from the item IDs). They see the inventory, their own items, photos and history, but every edit control is hidden and nothing is written to the inventory. The "View only" badge shows when this is the case. Editors are unaffected. The check runs at sign-in: the app tries the editable layers first.

**Confirmations and corrections.** Property staff don't handle repairs or other issues, so there are only two things a holder can do about an item on their list: confirm it is correct, or say "I don't have this". Both write to a separate small service, `TEMA_Assigned_Inventory_Problems` (two tables, *Problems* and *Confirmations*), so no one needs edit access to real inventory data.

- **Already created.** Settings no longer has a card for it (`createProblemsService()` and `addConfirmationsTable()` in `problems.js` can recreate it). If it is ever recreated, it needs a publisher account; then share it with the same group as the inventory layers and **turn editing on**, so everyone can add rows. Optionally paste its item ID into `PROBLEMS_ITEM_ID` in `config.js`; otherwise it is found by title. **Already created it earlier with only the Problems table?** Settings shows *Add the confirmations table* (owner of the service only).
- **Who can do it:** only the holder, on items assigned to them. **My items** shows "N of M still to confirm" with *Yes, I have this* on each card and *Confirm all*; *I don't have this* asks what happened and sends it to Property. An item with an open report can't be confirmed or reported twice.
- **A confirmation counts** until the item changes hands: it is tied to the holder and the date assigned, so a transferred item shows as not confirmed for its new holder. Inventory Administrators and Managers see a **Confirmed** column and a *Not confirmed by holder* tile on Inventory (and in the CSV export), and the item drawer shows who confirmed and when.
- **Nothing else changes** when someone confirms or reports; the inventory and the history log are untouched, and no status such as "Needs repair" is written.
- **Inventory Administrators** get a **Corrections** tab: reports waiting, with a count badge, and *Correct…* (what was done, plus a ticked option to remove the item from that person's inventory, i.e. return it to stock, which writes a "Returned" history entry). To give it to someone else, use Transfer afterwards.
- **No notifications.** Nothing emails the Inventory Administrators; they see the badge. Alerts would need an automation outside the app (ArcGIS Notifications or Power Automate on the new service).
- **Permissions on the service:** reports can be added and read by everyone it is shared with, and only the person who made a report can delete it. ArcGIS can't let people add reports while limiting updates to Inventory Administrators only, so in ArcGIS terms any member could change a report; the app only offers that to Inventory Administrators.

Without the service, the app behaves as before for editors (reporting marks the item), and view-only people simply don't see a Report button.

## Data sources (editable items)

| Layer | ArcGIS Online item ID |
|---|---|
| Inventory (editable) | `9c27c78273764d6abe12853cca3791dd` |
| Users (editable) | `72ec26c1f142418c83eba2a02ef2d2e7` |
| Assigned Inventory log (Activity + Lists) | `bbc50e820bae4d11968c49868224c9e4` |
| Legacy assignment history (archive) | `09549100576746d28acd7351b1decedd` |
| Inventory (view only copy) | `0d18e914da554b6994176f8f3aa5322e` |
| Users (view only copy) | `d42aa37b0d8f44c9a04a24f00fd9637a` |
| Assigned Inventory history (view only copy) | `d1082eb050bf490390ab41c58bbe2ca1` |

Item page: `https://www.arcgis.com/home/item.html?id=<id>`. The same IDs are in `config.js` (`ITEM_IDS`), shown in **Settings → Data sources**, and used by `backup_inventory.py`. The first four are the *editable* items; the three view-only copies are what people without edit access use (see above).

## Deploying

It's a static site (no build step), like the Editor.

- To **replace the Editor at its current address**: put these files in that GitHub Pages repo. `config.js` already carries the Editor's OAuth client ID and redirect URI (`https://temagis.github.io/Assigned_Inventory/`), so no new registration is needed. Keep a copy of the old files in case you want to roll back.
- To host it **somewhere else**: set `ARCGIS_REDIRECT_URI` in `config.js` to that address (trailing slash included) and add it as a Redirect URI on the OAuth app.
- Browsers cache scripts for a few minutes after a deploy; a hard refresh (Ctrl+F5) picks up changes straight away.

```
index.html  app.css  app.js  config.js  schema.js
state.js  permissions.js  edits.js  pickers.js  location.js
inventory.js  drawer.js  assign.js  additem.js  people.js  mine.js
importer.js  activity.js  settings.js  legacy.js  sources.js  problems.js
shared/  arcgis-auth.js  esri-client.js  session.js  ui.js  util.js  common.css   (TEMAzon's shared files)
```

## CSV import

**Items** (Inventory Administrator): matched by **Tag**. A new tag adds an item; an existing tag updates it. Columns: Tag (required), Item, Category, Make, Model, Serial, Status, Description, Assigned To (Edison ID, email or exact name), Date Assigned (YYYY-MM-DD or M/D/YYYY), Region (also fills that office's address and pin), Building, Room. A column in the file is applied to every row (a blank cell clears it); a column that isn't in the file is left alone. A change in *Assigned To* is recorded as an assign, transfer or return. **People:** matched by **Edison ID**; columns Edison ID, First/Last Name (or Name), Email, Section, Role, Supervisor, Active. Both show a preview with problem rows listed, and nothing is saved until you click Apply. Both have a downloadable template.

## What was tested, and what wasn't

Tested end to end in a headless browser against a **mock** ArcGIS service (about 80 checks): assign, transfer and return from a row, in bulk and from a person's page; scan; add item (suggested tag, add-another, assign-after, duplicate tag); drawer edits with status / location logging; photos; add user (org search, duplicate ID); Edison-ID change carrying assignments; both CSV imports; Settings lists; the Activity filters; Manager and Non-Manager scope; `?readonly=1&section=`; the no-log-service and failing-log-write cases; edit failure leaving no partial state; phone layout.

**Not verified against your live ArcGIS org** (worth a quick look on first use; open the browser console after signing in, where a `[schema check]` line reports any field name that doesn't match):

- **Creating the log service** (`createService` + `addToDefinition`) uses Esri's documented calls, exactly as TEMAzon's Setup page does, but hasn't run against your org. If it fails, the dialog shows ArcGIS's error; the manual fallback is above.
- **"Find in ArcGIS Online"** in Add user only works if your org lets ordinary members search other members (and email is only shown if your org exposes it). If not, the box stays empty and you type the details.
- **Status wording.** The tiles recognise statuses by pattern (`STATUS_ATTENTION_PATTERN`, `STATUS_RETIRED_PATTERN`); change them in `config.js` if your layer uses different words. The layer's statuses are Active and Inactive (an Inactive item also has a reason such as Surplus); "inactive" counts as retired, so those items can't be assigned or transferred, only returned. `DEFAULT_CATEGORY`, `STATUS_REASONS` and `ACQUISITIONS` mirror the Survey123 form.
- **`EditDate`** (used for "recently changed" ordering) needs editor tracking on the Inventory layer; without it the list falls back to tag order.
- **Photos** need attachments enabled on the Inventory layer (as before).
- **Address search / pin lookup** use OpenStreetMap's Nominatim; if your network blocks it, those two features fail quietly with a message under the search box.
- **Tag suggestion** assumes tags end in digits (e.g. `T-04412`) and continues the most common pattern; for other formats it leaves the box blank.

## Not built (ideas for later)

A yearly "confirm what you hold" sweep, a printable hand-off receipt, and a map view of all inventory.
