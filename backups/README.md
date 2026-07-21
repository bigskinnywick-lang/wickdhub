# Onyx Blades — KV backups

Versioned snapshots of the `onyx_builds` Cloudflare KV namespace (build registry +
claims ledger + admin roster). This folder lives **outside** `docs/` so Cloudflare
Pages never serves it publicly.

## How backups get here
- **On demand:** Admin console (`/blades/admin/` → ⚙ ADMIN) → **Download backup** →
  drop the `onyx_builds_backup_*.json` file in this folder → commit + push via
  GitHub Desktop. Each push is a diffable, timestamped, offsite backup.
- **Weekly (automated):** a scheduled task fetches the export and stages a fresh
  snapshot here for you to push.

## Recovery
Admin console → **Restore** → pick a backup JSON → *merge* (safe, additive) or
*replace* (wipes the namespace first, typed confirmation required).

The claims ledger is additionally self-healing: deleting `claims_backfill.json` on
each pilot's PC rebuilds it from their local journals on next EDMC start.
