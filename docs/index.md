---
layout: default
title: Agent Kudos
---

# 🏆 Agent Kudos

## Recognition infrastructure for the robots doing good work

Agent Kudos is a local-first system for recording specific, durable recognition for AI agents. It combines an append-only SQLite history, TypeScript library, polished CLI, actor-bound MCP server, generated inboxes, and `WINS.md` files—without a hosted service or account.

[View the project on GitHub](https://github.com/Coaden/agent-kudos) · [Read the README](https://github.com/Coaden/agent-kudos#readme)

## Start here

- [CLI reference](cli.md)
- [MCP server and agent setup](mcp.md)
- [Agent skill installation](skill.md)
- [Storage format](storage-format.md)
- [Backup and recovery](recovery.md)
- [Examples](examples.md)
- [Architecture](https://github.com/Coaden/agent-kudos/blob/main/ARCHITECTURE.md)
- [Security model](https://github.com/Coaden/agent-kudos/blob/main/SECURITY.md)
- [Release process](releasing.md)

## A local recognition loop

```text
Human or peer agent
        │
        ▼
specific kudos + safe evidence
        │
        ▼
append-only SQLite event
        │
        ├──> agent inbox
        ├──> WINS.md
        ├──> statistics
        └──> portable exports
```

Recognition belongs to the stable agent identity, not the model or runtime temporarily hosting it.

## Scope

V1 is designed for several local agent processes sharing one database on one machine. It has no HTTP transport, cloud synchronization, telemetry, or account requirement. A future backend can preserve the same event model while adding explicit remote identity and authorization.
