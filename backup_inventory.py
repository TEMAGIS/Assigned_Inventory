"""
Backup for the Assigned Inventory data (Inventory, Users, Activity log, legacy history).

For each layer/service it:
  1. exports the hosted feature service to a File Geodatabase (includes attachments/photos),
  2. downloads the zip to a dated file,
  3. deletes the temporary export item from ArcGIS Online,
  4. records row counts per table in backup_report.csv,
  5. keeps only the newest KEEP copies per service.

It only READS your data. Nothing in the source services is changed.

RUN IT
  A) ArcGIS Online Notebook (easiest; schedule it from the notebook's Tasks if your
     licence includes scheduled tasks). Leave the sign-in line as GIS("home").
  B) Any computer with Python + `pip install arcgis`. Set environment variables
     ARCGIS_USER and ARCGIS_PASSWORD (don't put the password in this file), and
     schedule it with Windows Task Scheduler / cron.

The account running it needs permission to export the services (owner/admin of
them, or Export enabled on the items).

NOT YET RUN AGAINST YOUR ORG: do one manual run, then open one zip in ArcGIS Pro
(or upload it to ArcGIS Online) and check the row counts against backup_report.csv.
"""
import csv
import datetime as dt
import os
import sys

from arcgis.gis import GIS

# ----------------------------------------------------------------- settings
# Services to back up. "match" finds the item by service name; use "item_id" if
# you prefer (the item page URL ends in ?id=<item_id>).
SERVICES = [
    {"label": "Inventory", "item_id": "9c27c78273764d6abe12853cca3791dd"},
    {"label": "Users", "item_id": "72ec26c1f142418c83eba2a02ef2d2e7"},
    {"label": "ActivityLog", "item_id": "bbc50e820bae4d11968c49868224c9e4"},
    {"label": "LegacyHistory", "item_id": "09549100576746d28acd7351b1decedd"},
    {"label": "PhotoAudit", "item_id": "c569bf2ba36842d6a33ee74c3bcff2f1"},
]

# Where backups go. In an ArcGIS Notebook /arcgis/home is persistent storage.
BACKUP_DIR = os.environ.get("BACKUP_DIR") or ("/arcgis/home/backups" if os.path.isdir("/arcgis/home") else "./backups")
KEEP = 12  # newest copies to keep per service (e.g. 12 weekly runs = ~3 months)


def connect():
    if os.path.isdir("/arcgis/home"):
        return GIS("home")  # running inside an ArcGIS Notebook
    user, pw = os.environ.get("ARCGIS_USER"), os.environ.get("ARCGIS_PASSWORD")
    if not user or not pw:
        sys.exit("Set ARCGIS_USER and ARCGIS_PASSWORD (or run this inside an ArcGIS Notebook).")
    return GIS("https://www.arcgis.com", user, pw)


def find_item(gis, spec):
    if spec.get("item_id"):
        return gis.content.get(spec["item_id"])
    hits = gis.content.search(f'name:"{spec["match"]}"', item_type="Feature Service", max_items=10)
    hits = [h for h in hits if spec["match"].lower() in (h.name or "").lower() or spec["match"].lower() in (h.title or "").lower()]
    if len(hits) > 1:
        print(f'  note: {len(hits)} items match "{spec["match"]}"; using {hits[0].id}')
    return hits[0] if hits else None


def row_counts(item):
    out = {}
    for lyr in list(item.layers) + list(item.tables):
        try:
            out[lyr.properties.name] = lyr.query(where="1=1", return_count_only=True)
        except Exception as err:  # keep going; report the problem
            out[lyr.properties.name] = f"error: {err}"
    return out


def prune(folder, label, keep):
    files = sorted(f for f in os.listdir(folder) if f.startswith(label + "_") and f.endswith(".zip"))
    for old in files[:-keep] if keep > 0 else []:
        os.remove(os.path.join(folder, old))
        print(f"  removed old copy {old}")


def main():
    gis = connect()
    os.makedirs(BACKUP_DIR, exist_ok=True)
    stamp = dt.datetime.now().strftime("%Y%m%d_%H%M%S")
    report = os.path.join(BACKUP_DIR, "backup_report.csv")
    new_report = not os.path.exists(report)
    failures = 0

    with open(report, "a", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        if new_report:
            w.writerow(["run", "service", "item_id", "table", "rows", "file", "status"])
        for spec in SERVICES:
            label = spec["label"]
            print(f"{label}…")
            try:
                item = find_item(gis, spec)
                if item is None:
                    raise RuntimeError("item not found (check the name/ID and that this account can see it)")
                counts = row_counts(item)
                export = item.export(title=f"{label}_backup_{stamp}", export_format="File Geodatabase", wait=True)
                try:
                    path = export.download(save_path=BACKUP_DIR, file_name=f"{label}_{stamp}.zip")
                finally:
                    export.delete()  # remove the temporary export item from ArcGIS Online
                size_mb = os.path.getsize(path) / 1e6
                print(f"  saved {os.path.basename(path)} ({size_mb:.1f} MB); rows: {counts}")
                for tbl, n in counts.items():
                    w.writerow([stamp, label, item.id, tbl, n, os.path.basename(path), "ok"])
                prune(BACKUP_DIR, label, KEEP)
            except Exception as err:
                failures += 1
                print(f"  FAILED: {err}")
                w.writerow([stamp, label, spec.get("item_id", ""), "", "", "", f"FAILED: {err}"])
    if failures:
        sys.exit(f"{failures} of {len(SERVICES)} backups failed — see above and backup_report.csv")
    print("All backups completed.")


if __name__ == "__main__":
    main()
