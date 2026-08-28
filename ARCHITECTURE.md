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

Agent profile rows and aliases are transactional query indexes. Historical events keep the identifiers and display names captured when written.

## Concurrency and durability

SQLite uses WAL journaling, foreign keys, `synchronous=FULL`, a five-second busy timeout, and `BEGIN IMMEDIATE` write transactions. Actor-scoped idempotency is protected by a partial unique index. Concurrent local processes therefore serialize writes without relying on filename races.

V1 deliberately supports one machine and one filesystem owner. A later cloud backend can implement the same event semantics behind a new storage adapter, but remote access, authentication, authorization, tenancy, and conflict resolution are not present today.

## Projections

Generated files are derived from canonical events and agent profiles. A database manifest records exactly which files Agent Kudos generated. Rebuild cleanup removes only manifest-listed regular files under the configured home; it never removes unknown files or follows symlinks. `NOTES.md` is created once and is never added to the manifest or overwritten.

Projection timestamps use the newest canonical event timestamp, so repeated rebuilds are byte-for-byte deterministic when history is unchanged.

## Boundaries

- `src/storage.ts`: database ownership, migrations, transactions, integrity, backups.
- `src/client.ts`: public domain API, identity resolution, policies, queries, statistics.
- `src/projections.ts`: safe deterministic filesystem views.
- `src/cli.ts`: parsing, human/JSON output, stable exit codes.
- `src/mcp/index.ts`: actor binding, MCP tools/resources/prompts, visibility policy.
- `skills/agent-kudos`: agent decision guidance distributed with the package.

## Versioning

Database and event schemas start at version 1. Migrations are keyed by SQLite `user_version` and recorded in `schema_migrations`. A newer unsupported version fails closed. Pre-1.0 public APIs may change with release notes; persisted event semantics should remain migratable.
