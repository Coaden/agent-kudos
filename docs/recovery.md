---
layout: default
title: Backup and recovery
---

# Backup and recovery

## Create a consistent backup

Do not copy a live WAL database directly. Ask SQLite to create a consistent snapshot:

```bash
kudos backup ./agent-kudos-backup.sqlite3
```

The destination must not exist. Agent Kudos creates the backup with owner-only permissions where POSIX file modes are available.

## Restore without risking the active home

Stop Agent Kudos writers before switching homes. Always validate a backup in a new directory; do not overwrite or delete the current database during validation.

On macOS or Linux:

```bash
RESTORE_HOME="$PWD/restored-agents"
mkdir -p "$RESTORE_HOME/kudos"
chmod 700 "$RESTORE_HOME" "$RESTORE_HOME/kudos"
install -m 600 ./agent-kudos-backup.sqlite3 "$RESTORE_HOME/kudos/agent-kudos.sqlite3"
kudos --home "$RESTORE_HOME" doctor
kudos --home "$RESTORE_HOME" rebuild
```

On Windows PowerShell:

```powershell
$RestoreRoot = Join-Path (Get-Location) "restored-agents"
New-Item -ItemType Directory -Force (Join-Path $RestoreRoot "kudos")
Copy-Item ".\agent-kudos-backup.sqlite3" (Join-Path $RestoreRoot "kudos\agent-kudos.sqlite3")
kudos --home $RestoreRoot doctor
kudos --home $RestoreRoot rebuild
```

Both commands must succeed. Inspect representative `WINS.md` and inbox files, then point `AGENT_KUDOS_HOME` at the restored directory and restart agents. Keep the previous home unchanged until the restored installation has been exercised successfully, so rollback only requires switching the configured home back.

If `doctor` reports an unsupported event, upgrade Agent Kudos before writing. JSON and JSONL export preserve raw canonical payloads even when the installed version cannot interpret them.
