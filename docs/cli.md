---
layout: default
title: CLI reference
---

# CLI reference

The `kudos` binary is noninteractive by default. Add `--json` anywhere in a command for machine-readable output and `--home <path>` to override `AGENT_KUDOS_HOME`.

```bash
kudos --help
kudos <command> --help
```

## Global options

| Option          | Meaning                                                                    |
| --------------- | -------------------------------------------------------------------------- |
| `--home <path>` | Storage root; explicit option overrides `AGENT_KUDOS_HOME` and `~/.agents` |
| `--json`        | Stable JSON output for automation                                          |
| `--help`        | Command-specific help                                                      |
| `--version`     | Package version                                                            |

## Initialize

```bash
kudos init
```

Creates the storage home, validated configuration, schema, WAL database, and migration metadata. It is safe to run repeatedly.

## Agents

```bash
kudos agent create codex --name "Codex" --alias reviewer
kudos agent list
kudos agent show reviewer
kudos agent update codex --name "Codex Prime" --alias code-reviewer
kudos agent update codex --clear-aliases
```

IDs and aliases use lowercase ASCII letters, digits, and internal hyphens. Display names support Unicode. Profile updates create historical events and do not rewrite earlier recognition.

## Give kudos

```bash
kudos give codex \
  --from troy \
  --actor-kind human \
  --actor-name "Troy" \
  --title "Excellent review catch" \
  --reason "Found a continuity contradiction before merge." \
  --tag review \
  --tag continuity \
  --evidence task:E17 \
  --visibility local \
  --idempotency-key troy-codex-e17
```

Evidence uses `kind:value` syntax. Supported kinds are `tool-call`, `commit`, `file`, `url`, `task`, and `note`. File evidence must be relative; URL evidence must use HTTP or HTTPS. Never include secrets or raw sensitive output.

Idempotency keys are unique within `(actor kind, actor ID)`. Repeating the same intended award with the same key returns the original event and reports `deduplicated: true`.

## Read recognition

```bash
kudos inbox codex
kudos list --recipient codex --status unacknowledged --tag review
kudos show <kudos-id>
kudos wins codex
kudos wins codex --print
kudos wins codex --open     # explicit GUI action
```

List filters include recipient, actor, actor kind, tag, acknowledgment status, visibility, revoked state, ISO date range, limit, and offset.

## Acknowledge and revoke

```bash
kudos acknowledge <kudos-id> \
  --as codex \
  --actor-kind agent \
  --note "Received with appropriately robotic humility."

kudos revoke <kudos-id> \
  --as troy \
  --actor-kind human \
  --reason "The supporting evidence was corrected."
```

Both operations append events. Revocation never deletes history.

## Statistics, diagnostics, and projections

```bash
kudos stats --tag review
kudos doctor
kudos rebuild
```

`doctor` checks SQLite integrity and journal mode, event validation, schema compatibility, projection state, and unsafe agent-directory symlinks. Unsupported or malformed events are reported with their storage row IDs. An unhealthy result uses exit code 5 and does not contaminate later in-process CLI invocations.

## Export and backup

```bash
kudos export --format json
kudos export --format jsonl --output ./kudos.jsonl
kudos export --format markdown
kudos backup ./agent-kudos-backup.sqlite3
```

Exports default to stdout. JSON and JSONL remain available when a future or malformed event cannot be interpreted, making them the recovery formats. A backup destination must not already exist. Backups use SQLite’s consistent snapshot behavior rather than copying a live database file and are restricted to the current user where POSIX modes are available.

See [Backup and restore](recovery.md) before restoring a snapshot. Never overwrite an active database.

## MCP

```bash
kudos mcp --actor-id codex --actor-kind agent --actor-name "Codex"
```

This starts stdio protocol traffic on stdout. Use an MCP client configuration rather than launching it manually for ordinary agent use.

## Exit codes

| Code | Meaning                                    |
| ---: | ------------------------------------------ |
|    0 | Success                                    |
|    1 | Unexpected internal failure                |
|    2 | Invalid arguments, configuration, or input |
|    3 | Agent or kudos not found                   |
|    4 | Policy or read-only denial                 |
|    5 | Database, schema, or health failure        |
