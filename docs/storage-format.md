---
layout: default
title: Storage format
---

# Storage format

## Home layout

```text
~/.agents/
├── kudos/
│   ├── config.json
│   ├── agent-kudos.sqlite3
│   ├── agent-kudos.sqlite3-wal   # may exist while open
│   ├── agent-kudos.sqlite3-shm   # may exist while open
│   └── exports/
└── <agent-id>/
    ├── profile.json
    ├── WINS.md
    ├── inbox/<kudos-id>.md
    └── NOTES.md
```

The environment variable `AGENT_KUDOS_HOME`, an explicit API option, or CLI `--home` changes the root.

## SQLite schema

- `events`: canonical, append-only versioned JSON events with indexed query fields.
- `agents`: current validated profile query projection.
- `aliases`: unique alias-to-agent mapping.
- `projection_manifest`: generated paths eligible for constrained cleanup.
- `schema_migrations`: applied database migrations.

The database uses SQLite schema version 1. An unsupported newer version fails closed.

Events are ordered deterministically by `(createdAt, id)`. ULIDs provide sortable, collision-resistant identifiers. Acknowledgment and revocation reference the original kudos ID.

Actor-scoped idempotency uses a unique index on `(actor kind, actor ID, idempotency key)` for `kudos.given` events. Similar titles or reasons are not treated as duplicates.

## Generated files

`profile.json`, `WINS.md`, and inbox entries are rebuildable views. Markdown content is escaped. Revoked recognition is excluded from ordinary wins. Only active, unacknowledged items appear in inboxes.

`NOTES.md` is created once as a convenience and never overwritten or tracked in the generated manifest.

## Backups and portability

Use `kudos backup` for a consistent SQLite snapshot. Use `kudos export --format json|jsonl|markdown` for portable, inspectable records.

Do not manually edit canonical tables. Do not copy the active database while writers are connected. Do not synchronize it through Git, Dropbox, or a generic network share.
