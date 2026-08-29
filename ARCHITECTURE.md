# Architecture

Agent Kudos is one ESM npm package with four surfaces over the same domain model:

```text
TypeScript library ─┐
CLI                ─┼─> KudosClient ─> SQLite event store ─> projections
MCP tools          ─┤                         │                 ├─ WINS.md
MCP resources      ─┘                         │                 ├─ inbox/*.md
                                              └─ JSON/JSONL    └─ profile.json
```

A single package keeps types, validation, policy, migrations, and behavior consistent. There is no workspace because the CLI and MCP server are thin adapters over the library and gain nothing from independent versioning.

## Canonical model

`kudos/agent-kudos.sqlite3` is canonical. The `events` table stores complete validated JSON payloads plus indexed query fields. Database triggers reject updates and deletes. Recognition state is derived from the ordered event stream:

- `kudos.given` creates recognition.
- `kudos.acknowledged` records recipient review.
- `kudos.revoked` records withdrawal without deleting history.
- `agent.created` and `agent.updated` preserve identity history.

Agent profile rows, aliases, and `kudos_current` are transactional query indexes. Historical events keep the identifiers and display names captured when written. Every event receives a database ingestion sequence; that monotonic sequence—not a wall-clock timestamp—drives opaque synchronization watermarks.

## Context-bounded reads

Machine-facing discovery never reconstructs and returns the whole event history. `kudos_list` reads the indexed current state, returns 10 compact summaries by default (maximum 50), and omits unbounded detail fields. `kudos_get` reconstructs one requested kudos record. `kudos_changes` returns compact changes after an opaque sequence watermark, 20 by default (maximum 100). List and change item payloads also stop at an approximate 24 KiB byte budget and report `contextLimited` plus a continuation cursor.

This split makes context consumption proportional to the caller's explicit request even when the database contains thousands of records. `WINS.md` is a human projection and is not a machine query source.

## Concurrency and durability

SQLite uses WAL journaling, foreign keys, `synchronous=FULL`, SQLite’s bounded five-second busy handler, and `BEGIN IMMEDIATE` write transactions. Actor-scoped idempotency is protected by a partial unique index. Concurrent local processes therefore serialize writes without relying on filename races or an unbounded application retry loop.

V1 deliberately supports one machine and one filesystem owner. A later cloud backend can implement the same event semantics behind a new storage adapter, but remote access, authentication, authorization, tenancy, and conflict resolution are not present today.

## Projections

Generated files are derived from canonical events and agent profiles. Normal mutations synchronize only the affected agent, rewriting its profile and wins view while creating or removing only changed inbox entries. The explicit rebuild operation regenerates every projection. Derived writes use atomic replacement but omit durability barriers because canonical SQLite state can recreate them.

A database manifest records exactly which files Agent Kudos generated. Cleanup removes only manifest-listed regular files under the configured home; it never removes unknown files or follows symlinks. `NOTES.md` is created once and is never added to the manifest or overwritten.

Projection timestamps use the newest canonical event timestamp, so repeated rebuilds are byte-for-byte deterministic when history is unchanged.

## Boundaries

- `src/storage.ts`: database ownership, migrations, transactions, integrity, backups.
- `src/client.ts`: public domain API, identity resolution, policies, queries, statistics.
- `src/projections.ts`: safe deterministic filesystem views.
- `src/cli.ts`: parsing, human/JSON output, stable exit codes.
- `src/mcp/index.ts`: actor binding, MCP tools/resources/prompts, visibility policy.
- `skills/agent-kudos`: agent decision guidance distributed with the package.

## Versioning

Event payload schemas start at version 1. The SQLite schema is version 2; migrations are keyed by SQLite `user_version` and recorded in `schema_migrations`. A newer database schema fails closed. Unsupported or malformed event rows are identified by storage ID in diagnostics, omitted from tolerant read models, and preserved by raw JSON/JSONL export. Writes and full projection rebuilds fail closed while any event semantics are unknown, preventing an older client from deriving and persistently acting on incomplete state.

Pre-1.0 public APIs may change with release notes; persisted event semantics should remain migratable.
