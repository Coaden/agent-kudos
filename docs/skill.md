---
layout: default
title: Agent skill
---

# Agent skill

The distributable skill lives at [`skills/agent-kudos`](../skills/agent-kudos/SKILL.md) and is included in the npm tarball. It teaches skill-aware agents when durable recognition is appropriate, how to use MCP or CLI, how to sanitize evidence, and how to retry safely.

## Repository-local installation

Copy or link the skill into the runtime-specific repository skill directory. This keeps setup reviewable and scoped to one project.

```text
<repository>/.codex/skills/agent-kudos/SKILL.md
<repository>/.claude/skills/agent-kudos/SKILL.md
```

## User installation

After installing the npm package, locate its `skills/agent-kudos` directory and copy or link it into the skill directory supported by your runtime. Common layouts are:

```text
~/.codex/skills/agent-kudos/
~/.claude/skills/agent-kudos/
```

Global skill installation changes agent configuration and should always be an explicit user action. Agent Kudos has no postinstall script and never modifies those directories automatically.

## MCP and skill roles

The skill guides agent decisions; the MCP server performs and enforces operations. Install both for the best experience:

1. Install `agent-kudos`.
2. Create stable profiles with the human CLI.
3. Register one actor-bound MCP process per runtime.
4. Install the skill where that runtime discovers skills.

When MCP is unavailable, the skill permits using the local `kudos` CLI if command execution is allowed.

## Claude and other adapters

The core `SKILL.md` format is intentionally portable. Thin runtime-specific placement is documented here rather than duplicating the instructions across formats. No speculative plugin manifest is shipped.
