# Changelog

All notable changes will be documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases follow Semantic Versioning.

## [Unreleased]

### Added

- Append-only SQLite event storage with WAL concurrency and actor-scoped idempotency.
- Stable agent identities, aliases, profile history, acknowledgment, and revocation.
- TypeScript library, `kudos` CLI, and actor-bound stdio MCP server.
- MCP tools, resources, prompts, visibility rules, and administrative policy controls.
- Deterministic `WINS.md`, inbox, and profile projections with safe manifest cleanup.
- JSON, JSONL, and Markdown exports plus transactionally consistent backups.
- Agent skill, documentation site, CI, release, security, and contribution infrastructure.
- Safe restore documentation, cross-platform CI, scale tests, and recovery-aware raw exports.

### Changed

- Normal mutations now synchronize only the affected agent’s projections and avoid durability barriers for rebuildable files.
- System actors no longer receive implicit self-award, acknowledgment, or administrative revocation authority.
- Kudos titles are single-line and MCP tag declarations now match runtime validation.

### Fixed

- Unsupported event rows no longer prevent tolerant reads or raw export; diagnostics identify exact row IDs and writes fail closed.
- SQLite database, WAL, shared-memory, and backup files are restricted to the current user where POSIX modes are supported.
- CLI exit codes no longer leak between embedded invocations, and missing wins projections produce actionable errors.

[Unreleased]: https://github.com/Coaden/agent-kudos/commits/main
