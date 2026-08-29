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
│   └── agent-kudos.sqlite3-shm   # may exist while open
└── <agent-id>/
    ├── profile.json
    ├── WINS.md
    ├── inbox/<kudos-id>.md
    └── NOTES.md
```

The environment variable `AGENT_KUDOS_HOME`, an explicit API option, or CLI `--home` changes the root.

## SQLite schema

- `events`: canonical, append-only versioned JSON events with indexed query fields.
- `kudos_current`: rebuildable compact current-state index used by bounded list and change queries.
- `agents`: current validated profile query projection.
- `aliases`: unique alias-to-agent mapping.
- `projection_manifest`: generated paths eligible for constrained cleanup.
- `schema_migrations`: applied database migrations.

The database uses SQLite schema version 2. An unsupported newer version fails closed.

Events receive a monotonic ingestion sequence inside the write transaction. That sequence provides stable cursor and watermark ordering even when timestamps collide. ULIDs remain collision-resistant public identifiers. Acknowledgment and revocation reference the original kudos ID.

`kudos_current` contains only bounded summary fields and current acknowledgment/revocation state. It is updated in the same transaction as each canonical event and can be rebuilt from events during migration. `doctor` checks its record count. Full reasons, evidence, notes, source data, and metadata remain only in canonical events and are returned through an explicit one-record detail read.

Actor-scoped idempotency uses a unique index on `(actor kind, actor ID, idempotency key)` for `kudos.given` events. Similar titles or reasons are not treated as duplicates.

## Generated files

`kudos_current`, `profile.json`, `WINS.md`, and inbox entries are rebuildable views. Normal mutations update the current-state index transactionally and synchronize only the affected agent and changed inbox entries; `kudos rebuild` performs a full deterministic regeneration from canonical events. Markdown content is escaped. Revoked recognition is excluded from ordinary wins. Only active, unacknowledged items appear in inboxes.

Markdown is for people and portability. `kudos_list`, `kudos_get`, and `kudos_changes` query SQLite rather than parsing or tailing `WINS.md`.

`NOTES.md` is created once as a convenience and never overwritten or tracked in the generated manifest.

## Backups and portability

Use `kudos backup` for a consistent SQLite snapshot. Use `kudos export --format json|jsonl|markdown` for portable, inspectable records. JSON and JSONL preserve unsupported event payloads for recovery; Markdown identifies and omits rows it cannot safely render. `doctor` reports every invalid row by storage ID, and mutations fail closed until the installed version understands the entire event stream.

Follow the [safe restore procedure](recovery.md) to validate a snapshot in a new home before switching active agents.

Do not manually edit canonical tables. Do not copy the active database while writers are connected. Do not synchronize it through Git, Dropbox, or a generic network share.
