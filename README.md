# Assigned Inventory Console

A redesign of the Assigned Inventory Editor in the style of TEMAzon: a scannable table, short dialogs for the everyday jobs, and a history log that records every change. It talks to the **same two ArcGIS layers** (Inventory and Users), uses the **same sign-in, roles and field names**, and can be hosted at the **same address** as the Editor, so nothing about your data or OAuth registration has to change.

## What's different from the Editor

| Job | Editor | Console |
|---|---|---|
| Assign an item | open the record, scroll to Assignment, search, set date, Save | **Assign** button on the row → pick a person (recents on top) → done. Date defaults to today. |
| Assign many | one at a time | tick rows → **Assign N to…** (also bulk **Return**) |
| Transfer / return | edit the assignee field | **Transfer** and **Return** buttons, each recorded in history |
| Scan a tag | – | "Scan / type tag ↵" box opens the right dialog (offers to add an unknown tag) |
| Add an item | full form | dialog with tag + item/category required; the next tag is suggested; **Save & add another** keeps make/model; optional "assign right after" |
| Add a user | five typed fields + IDs | optional ArcGIS account search fills name/email; role defaults to Non-Manager; duplicate Edison ID / email blocked |
| Who has what | filter by section | **People** tab: pick a person → everything they hold, with Return buttons; warning when an inactive person still holds items |
| History | none in the app | per-item timeline in the item drawer + **Activity** tab (filter, search, export CSV) |
| Many at once | – | **Import CSV** for items and for people, with a preview before anything is saved |
| Old history | webhook layer only | **Settings → Import legacy history**: brings the old webhook assignment history into the Activity log (preview first, safe to re-run) |
| Lists | `config.js` | **Settings** tab (sections, categories, statuses) |
| Non-managers | read-only list | **My items** page (phone-friendly): update the location of what you hold, report a problem |

Kept from the Editor: photos (add / delete / full-size view), the location block (region office presets, address search, click-or-drag map pin), blank placeholder rows hidden, `?readonly=1` and `?section=` links, the Users QR-code image, notes and image URL.

## Roles (unchanged from the Editor)

| | Property Officer | Manager | Non-Manager |
|---|---|---|---|
| Tabs | Inventory, My items, People, Activity, Settings | Inventory, My items, People (view), Activity | Inventory (view), My items |
| Assign / transfer / return | any item | items assigned in their own section or to a direct report, plus any unassigned item | – |
| Edit item details | yes | no | no |
| Update location | any item | in-scope items | own items only |
| Report a problem | any item | in-scope items | own items |
| Add items / users, import, settings | yes | no (`ALLOW_MANAGER_ADD_INVENTORY` in `config.js` can allow adding items) | no |

As before, ArcGIS sharing is the real access boundary; these rules decide what the screen *offers*.

## The history log — no webhook needed

Every assign / return / transfer / add / location / status change is written by the app itself to an **Activity** table, right after the inventory edit succeeds. Nothing depends on the existing Lambda webhook, which can stay as it is (it keeps catching edits made outside this app, such as the Survey123 form). The two histories are independent.

Because the Inventory layer and the log are separate services, they can't be one transaction. If the log write fails after the edit succeeded, the edit stands and the person sees a clear warning. If the log doesn't exist yet, everything works and history is simply not recorded.

### One-time setup (about 5 minutes)

1. **Deploy** this folder (see below).
2. **Sign in as a Property Officer** whose ArcGIS account can publish content.
3. **Settings → Log service → Create the log service.** This creates a small hosted service called `TEMA_Assigned_Inventory_Log` with two tables, *Activity* and *Lists*.
4. **Share it** (the dialog reminds you): in ArcGIS Online, share that service with the same group as the Inventory and Users layers and make sure **editing is on**. Managers and Non-Managers need to add rows when they act.
5. Optional: edit the Sections / Categories / Statuses lists in **Settings**.

The app finds the log service by its title. To skip that lookup, paste its `…/FeatureServer` URL into `ACTIVITY_SERVICE_URL` in `config.js`. If you'd rather create the tables by hand, add two tables named `Activity` and `Lists` with the fields in `schema.js`.

### Importing the old webhook history (optional, once)

The old webhook layer stored a full snapshot of the item at every edit. **Settings → Legacy history → Import legacy history…** reads it (the item ID is pre-filled from `LEGACY_HISTORY_SOURCE` in `config.js`, or choose a CSV export of it) and keeps only the rows where the holder changed: *Assigned* (nobody → someone), *Transferred* (someone → someone else), *Returned* (someone → nobody). An item that already had a holder in its first snapshot gets one **Opening balance** entry. Repeat snapshots and rows with no tag are skipped, and you see counts and a sample before anything is written.

- Each imported entry is marked `legacy #<objectid>` in its note, so running it again (from the layer or a CSV) skips what's already in. Entries show "Legacy history" as *Performed by*.
- The legacy layer is only read, never changed, and the webhook can keep running.
- `assigned_to` in the old data also holds section/region codes (e.g. `0018`); these are imported as they are, named from the old `username` column.
- Dates come from each snapshot's `EditDate` (a CSV export is read as UTC).
- You need the log service first. On your 11,277-row export this gives about 7,700 entries (5,090 opening + about 2,600 changes).

## Deploying

It's a static site (no build step), like the Editor.

- To **replace the Editor at its current address**: put these files in that GitHub Pages repo. `config.js` already carries the Editor's OAuth client ID and redirect URI (`https://temagis.github.io/Assigned_Inventory/`), so no new registration is needed. Keep a copy of the old files in case you want to roll back.
- To host it **somewhere else**: set `ARCGIS_REDIRECT_URI` in `config.js` to that address (trailing slash included) and add it as a Redirect URI on the OAuth app.
- Browsers cache scripts for a few minutes after a deploy; a hard refresh (Ctrl+F5) picks up changes straight away.

```
index.html  app.css  app.js  config.js  schema.js
state.js  permissions.js  edits.js  pickers.js  location.js
inventory.js  drawer.js  assign.js  additem.js  people.js  mine.js
importer.js  activity.js  settings.js  legacy.js
shared/  arcgis-auth.js  esri-client.js  session.js  ui.js  util.js  common.css   (TEMAzon's shared files)
```

## CSV import

**Items** (Property Officer): matched by **Tag**. A new tag adds an item; an existing tag updates it. Columns: Tag (required), Item, Category, Make, Model, Serial, Status, Description, Assigned To (Edison ID, email or exact name), Date Assigned (YYYY-MM-DD or M/D/YYYY), Region (also fills that office's address and pin), Building, Room. A column in the file is applied to every row (a blank cell clears it); a column that isn't in the file is left alone. A change in *Assigned To* is recorded as an assign, transfer or return. **People:** matched by **Edison ID**; columns Edison ID, First/Last Name (or Name), Email, Section, Role, Supervisor, Active. Both show a preview with problem rows listed, and nothing is saved until you click Apply. Both have a downloadable template.

## What was tested, and what wasn't

Tested end to end in a headless browser against a **mock** ArcGIS service (about 80 checks): assign, transfer and return from a row, in bulk and from a person's page; scan; add item (suggested tag, add-another, assign-after, duplicate tag); drawer edits with status / location logging; photos; add user (org search, duplicate ID); Edison-ID change carrying assignments; both CSV imports; Settings lists; the Activity filters; Manager and Non-Manager scope; `?readonly=1&section=`; the no-log-service and failing-log-write cases; edit failure leaving no partial state; phone layout.

**Not verified against your live ArcGIS org** (worth a quick look on first use; open the browser console after signing in, where a `[schema check]` line reports any field name that doesn't match):

- **Creating the log service** (`createService` + `addToDefinition`) uses Esri's documented calls, exactly as TEMAzon's Setup page does, but hasn't run against your org. If it fails, the dialog shows ArcGIS's error; the manual fallback is above.
- **"Find in ArcGIS Online"** in Add user only works if your org lets ordinary members search other members (and email is only shown if your org exposes it). If not, the box stays empty and you type the details.
- **Status wording.** The tiles and "Report a problem" recognise statuses by pattern (`STATUS_ATTENTION_PATTERN`, `STATUS_RETIRED_PATTERN`) and write `STATUS_PROBLEM_VALUE` ("Needs repair"). If your layer uses a coded-value list for status, make sure that value is allowed, or change it in `config.js`.
- **`EditDate`** (used for "recently changed" ordering) needs editor tracking on the Inventory layer; without it the list falls back to tag order.
- **Photos** need attachments enabled on the Inventory layer (as before).
- **Address search / pin lookup** use OpenStreetMap's Nominatim; if your network blocks it, those two features fail quietly with a message under the search box.
- **Tag suggestion** assumes tags end in digits (e.g. `T-04412`) and continues the most common pattern; for other formats it leaves the box blank.

## Not built (ideas for later)

A yearly "confirm what you hold" sweep, a printable hand-off receipt, and a map view of all inventory.
