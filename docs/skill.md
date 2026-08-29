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

The CLI verifies and manages the known Codex and Claude Code user layouts:

```bash
kudos skill install                                      # dry-run both detected runtimes
kudos skill install --runtime codex --yes                # install one copied skill
kudos skill install --runtime claude --link --yes         # explicit package-linked install
kudos skill status
kudos skill uninstall --runtime claude                    # dry-run removal
kudos skill uninstall --runtime claude --yes
```

Bare `install` and `uninstall` commands are dry runs. The installer applies only with `--yes`, only when the runtime home already exists, and only to its `skills/agent-kudos` child. Copies carry an ownership/version stamp so `status` can report stale installations after npm updates. Existing unowned directories are conflicts and require explicit `--force`; unrelated sibling skills are never touched.

Copy mode is the stable default. `--link` points at the skill inside the installed npm package, which updates with an in-place global package upgrade but may break if that package moves. Run `status` after package updates either way.

Add identity options to print a ready-to-run actor-bound MCP command without editing runtime configuration:

```bash
kudos skill install --runtime codex --actor-id codex --actor-name "Codex"
kudos skill install --runtime claude --actor-id claude --actor-name "Claude"
```

Global skill installation changes agent configuration and is always an explicit user action. Agent Kudos has no postinstall script and never modifies those directories implicitly.

## MCP and skill roles

The skill guides agent decisions; the MCP server performs and enforces operations. Install both for the best experience:

1. Install `agent-kudos`.
2. Create stable profiles with the human CLI.
3. Register one actor-bound MCP process per runtime.
4. Install the skill where that runtime discovers skills.

When MCP is unavailable, the skill permits using the local `kudos` CLI if command execution is allowed.

## Claude and other adapters

The Codex and Claude Code layouts and CLI registration forms have been verified locally. The core `SKILL.md` format remains portable, but Cursor, Gemini, Hermes, OpenClaw, OpenCode, and other conventions are not guessed. For those runtimes, inspect authoritative documentation or a real local installation before copying the packaged skill or configuring the stdio MCP server.
