# Assigned Inventory Editor

A small static web app for adding and updating TEMA's assigned-inventory
records directly in the two hosted ArcGIS feature layers, gated by
ArcGIS Online sign-in and a per-user role. Built as a sibling to the
ReadyOp Contacts app and modeled on its edit workflow — same OAuth
pattern, same "load the whole roster once, edit in place" list/edit UI,
same TN/TEMA styling — but talking directly to ArcGIS feature services
instead of ReadyOp's API, and adding a role-based permission layer the
ReadyOp app didn't need (Experience Builder's own access control was
enough there, since everyone who could open that app was trusted with
full edit access).

## How it works

1. The user signs in with their ArcGIS account — OAuth 2.0
   authorization-code flow with PKCE, implemented directly against ArcGIS
   Online's REST endpoints (no ArcGIS Maps SDK needed). Standalone, it's
   a full-page redirect; embedded in an iframe (e.g. an Experience
   Builder Embed widget) it opens a popup instead. This app's own
   `index.html` doubles as its own OAuth callback page.
2. Once signed in, the app fetches the **entire Users layer** into
   memory and looks up the signed-in ArcGIS account's **email** against
   the Users layer's `email` field — there's no ArcGIS-username field on
   that layer, so email is the only identifier both systems share. If no
   row matches (or the matching row's `active` field isn't "yes"), the
   user sees a plain "no access yet" screen instead of the app — ask a
   Property Officer to add or reactivate them.
3. The matched row's `permissions` field (**Property Officer** /
   **Manager** / **Non-Manager**) drives everything the UI offers next —
   see "Permission model" below.
4. The app then fetches the **entire Inventory layer** into memory too,
   and both rosters power an in-memory, instant search/filter/edit
   experience — no round trip per keystroke. All edits go straight to
   the two feature services via `applyEdits`, using the signed-in user's
   own ArcGIS token — no separate credential, and no CORS relay needed
   (unlike ReadyOp's API, ArcGIS Online's hosted feature services send
   proper CORS headers on their own).

**Trust model, explicitly**: layer sharing in ArcGIS Online is the real
access boundary (only people you've shared the app item + both layers
with can get in at all); this app's role logic on top of that decides
what each signed-in person is *offered* to edit. Anyone determined enough
could still hand-craft a REST call with their own token — the same is
true of every ArcGIS app, including Field Maps and Survey123 — so don't
share the layers themselves any more broadly than the role model below
assumes.

## Permission model

Confirmed directly from the "TEMA Assigned Inventory Users" Survey123
form: the `permissions` field stores exactly one of three values —
**Property Officer**, **Manager**, **Non-Manager**. What each of those
should be *allowed to edit on Inventory records* is **this app's own
design choice**, not something either source form specifies — spelled
out here, and easy to change in one place (`permissions.js`,
`editableGroups()`) if it doesn't match how TEMA actually wants this to
work:

| Role | Inventory — item identity<br>(tag/serial/category/status/item/make/model/description) | Inventory — assignment<br>(who has it) | Inventory — location<br>(where it is) | Add new item | Users tab |
|---|---|---|---|---|---|
| **Property Officer** | edit any | edit any | edit any | yes | view + edit |
| **Manager** | view only | edit — items assigned within their own section or to a direct report (including unassigned items) | edit — same scope | no *(flip `ALLOW_MANAGER_ADD_INVENTORY` in config.js)* | view only |
| **Non-Manager** | view only | view only | edit — **only items currently assigned to themselves** | no | no access |

There's no in-app delete for Inventory records — a Property Officer who
needs to retire an item does that by setting its `status` (e.g. to
"Retired"/"Disposed") rather than removing the record outright, so
history and any downstream reporting against the layer stays intact.
`permissions.js` still exports `canDeleteInventory()` if you ever want to
wire a delete action back in.

A Manager's "own section or direct report" scope is computed from the
Users roster already loaded in memory: an Inventory record's `assigned_to`
(an `edison_id`) is looked up against the Users roster, and that person's
`tema_section` is compared to the Manager's own, or their `supervisor_id`
is compared to the Manager's `edison_id`. An **unassigned** item is
treated as in-scope for every Manager (not excluded) — otherwise a
Manager could never hand out a new, never-assigned piece of gear to
their own team in the first place.

The Non-Manager row deliberately mirrors exactly what the existing
"TEMA Assign Inventory" Survey123 form already lets any user do today —
that form's only editable content, even for whoever opens it, is
assignment + location on a specific already-tagged item. This app keeps
that same boundary for Non-Managers rather than loosening it, and even
there, a Non-Manager can update *where* their own item is but not
reassign it to someone else — reassignment is treated as a
Manager/Property Officer action.

## What's VERIFIED vs. ASSUMED

Both feature layers require a token and returned `"Token Required"` when
checked from the build sandbox — there was no way to read either layer's
actual field list, domains, or sample data while building this. Instead:

- **Users layer field names** (`edison_id`, `first_name`, `last_name`,
  `full_name`, `email`, `tema_section`, `active`, `permissions`,
  `description`, `supervisor_id`, `image_url`, plus the `qr_code` image
  attachment) come directly from the "TEMA Assigned Inventory Users"
  Survey123 form's own XForm definition — high confidence, since that
  form's whole job is editing this layer.
- **Inventory layer field names** (`tag_number`, `serial_number`,
  `item_category`, `status`, `item`, `make`, `model`, `description`,
  `assigned_to`, `date_assigned`, `region`, `placename`, `room`,
  `county`, `address`, `city`, `state`, `zip`, `latitude`, `longitude`)
  come from the "TEMA Assign Inventory" Survey123 form — but that form
  itself only ever *edits* the assignment/location fields; the item
  identity fields (`item_category` through `description`) ship read-only
  there, populated some other way (most likely a prefill from a web map
  popup's "Open in Survey123" link). The field **names** are still real
  (they're declared as real, typed layer fields in that form's XForm),
  just not something this build could confirm live.
- **`OBJECTID`** (the field applyEdits/delete key off) is *not* hardcoded
  — `app.js` reads each layer's actual object-ID field name from its
  metadata on sign-in and uses whatever that turns out to be.
- The **Region options** (`West / Middle / East / Southeast / HQ`) come
  from the Assign Inventory form's own pill list — note this is a
  different 5th option (`HQ`) than the sibling ReadyOp Contacts app's
  Region list (`West / Middle / Southeast / East`, no HQ). Worth
  double-checking these are really two different lists and not a
  transcription mismatch somewhere.
- **`config.js` has a `[schema check]` built in**: right after sign-in,
  the app fetches both layers' live metadata and logs a console warning
  for every configured field name that doesn't actually exist there —
  open DevTools → Console after your first real sign-in and fix
  anything it flags, the same guardrail ReadyOp Edit's own diagnostic
  dump gives you.
- **Coded-value domains** (if `item_category`, `status`, etc. are
  constrained to a fixed list on the live layer rather than free text)
  aren't reflected in the edit form — those two fields use a `<datalist>`
  of values already seen in the loaded roster (same "derive suggestions
  from live data" pattern ReadyOp Edit's County filter uses), which
  offers existing values but doesn't block typing something new. If the
  live layer actually enforces a domain, saving a value outside it will
  fail with an error from `applyEdits` — check the console warning above
  first if that happens.
- **The Users → Inventory match key** (`edison_id` on Users ↔
  `assigned_to` on Inventory) is confirmed from `scripts/findUser.js` in
  the provided form package, which queries both layers this exact way.
- **`INV_EDIT_DATE_FIELD` (`"EditDate"`)** — the Inventory list's default
  sort is most-recently-edited-first, which needs *some* last-edited
  timestamp per record. `EditDate` is the standard field name ArcGIS
  Online maintains automatically on a hosted layer with "Track create
  and update" (editor tracking) turned on, but it isn't part of the
  Assign Inventory Survey123 form itself, so there was nothing to
  confirm it against. If the `[schema check]` console warning flags it
  as missing, editor tracking most likely isn't enabled on the Inventory
  layer — turn it on under the layer's item settings → Editing, or point
  this at whatever field your org tracks it under. Records with no
  usable value there fall back to tag-number order (see below).

## Setup

### 1. Register a new ArcGIS OAuth application

Register a **new** OAuth app in the ArcGIS Developers console / your
org's Content — don't reuse ReadyOp Contacts' or Preds Summary's client
ID. Register it as a **Native Application** (or another public-client
type) so PKCE works with no client secret. Add your deployed URL
(trailing slash included) as its only Redirect URI.

Update in `config.js`:
- `ARCGIS_APP_ID` — the new client ID.
- `ARCGIS_REDIRECT_URI` — must exactly match the Redirect URI you
  registered.

### 2. Share the app + both layers with the right people

Share the OAuth app item, the Inventory layer, and the Users layer with
whichever ArcGIS group represents everyone who should be able to sign in
at all (Property Officers, Managers, and Non-Managers alike — the role
check inside the app is what further limits what each of them can edit,
but ArcGIS sharing is what lets them reach the layers with a token in
the first place).

### 3. Verify field names and domains against the live schema

Sign in once, open DevTools → Console, and read the `[schema check]`
messages `esri-client.js` logs for both layers. Fix any field name in
`config.js` that comes back flagged. Also spot-check a real record's
`item_category`/`status` values against what the app's datalists show,
and confirm the Region list still matches what's actually in the data.

### 4. Deploy

Static site — GitHub Pages works well (same pattern as the sibling
ReadyOp Contacts / Preds Summary apps): push this folder to a repo,
enable Pages on `main`. Nothing in `config.js` is secret, so a public
repo is fine. Update `ARCGIS_REDIRECT_URI` to match wherever it actually
ends up hosted, and re-register that exact URL on the OAuth app (step 1).

### 5. Embed (optional)

Same as ReadyOp Edit: add an Embed widget in Experience Builder pointed
at the deployed URL. Sign-in happens via a popup inside the iframe, so
make sure popups aren't blocked for the Experience Builder domain.

## Cache-busting reminder

`index.html` and every JS module import each other with a `?v=...` query
string. **Bump the version string everywhere it appears** (a project-wide
find-and-replace of the old value, e.g. `20260902a`, to a new one) any
time you redeploy changed files — otherwise a browser that already
cached the old copies may keep using them. Same gotcha ReadyOp Edit's
own README documents.

## History logging keeps working automatically

The Inventory layer already has an ArcGIS Online webhook wired up
(`addData`/`editData` → a Lambda function, per the Survey123 form
package's `.info` file) that logs history independent of which client
made the edit. Saves made through this app trigger that same webhook —
nothing extra to wire up here.

## Blank records are hidden from the Inventory list

Some rows in the live layer have no tag number and no item details at
all (no serial, category, item, make, model, or description) — empty
placeholder rows rather than real inventory, seen while testing. The
Inventory list hides any record like that unconditionally, regardless of
search or filters — see `isBlankInventoryRecord()` in `app.js`. They're
still in the feature service (nothing here deletes them); the list
footer notes how many are hidden so a Property Officer can go clean them
up directly in the layer if they're not supposed to be there. If a
legitimate row somehow has every one of those fields blank, it'll be
hidden here too — widen `INV_BLANK_CHECK_FIELDS` if that ever matters.

## Inventory list sort order

The Inventory list sorts most-recently-edited first, using
`INV_EDIT_DATE_FIELD` (`"EditDate"`, see the VERIFY note above) — more
useful day-to-day than an alphabetical tag sort, since whatever's been
touched recently naturally floats to the top. Each row's second sub-line
shows that same edit date (e.g. "Assigned to Jane Doe · Edited Sep 2,
2026"). Records with no usable edit date — editor tracking off, or a row
that's simply never been touched since the layer was created — sort to
the bottom, falling back to tag-number order among themselves. The Users
list is unaffected by this and still sorts alphabetically by last name.

## What's not built yet

- **Bulk import / CSV upload** — this app edits one record at a time,
  same scope as ReadyOp Edit.
- **Map-based "click an item to select it"** — the mini-map on the
  Inventory edit form only sets/shows *that one record's* point; there's
  no map-wide browse view of the whole inventory.
- **Manager editing item identity fields** — currently read-only for
  Managers even within their own section's items (see the permission
  table above). If TEMA wants Managers to also fix a typo'd make/model
  on their own team's gear, that's a small, contained change to
  `editableGroups()` in `permissions.js`.
- **Coded-value domain enforcement in the UI** — see "What's VERIFIED
  vs. ASSUMED" above.

## Testing without touching production data

Test with a low-traffic or throwaway tag/record first — saves go
straight to the live feature services with no undo. You'll need a real
ArcGIS Online account that's been added to the Users layer (as any role)
to test sign-in end-to-end, and a Property-Officer-role account to test
the full permission surface — this couldn't be fully verified from the
build sandbox, since neither an AGOL token nor live schema access was
available there.
