---
layout: default
title: MCP server
---

# MCP server

`agent-kudos-mcp` is a local stdio Model Context Protocol server built with the official TypeScript SDK. It opens no network listener.

## Actor binding

Every server process requires one actor:

```text
AGENT_KUDOS_ACTOR_ID=codex
AGENT_KUDOS_ACTOR_KIND=agent
AGENT_KUDOS_ACTOR_NAME=Codex
```

The server inserts that identity into every mutation. Callers cannot override it in tool arguments. Malformed or missing identity settings fail startup.

Create the corresponding profile with the CLI before connecting the server.

## Codex CLI

```bash
codex mcp add agent-kudos \
  --env AGENT_KUDOS_ACTOR_ID=codex \
  --env AGENT_KUDOS_ACTOR_KIND=agent \
  --env AGENT_KUDOS_ACTOR_NAME=Codex \
  -- agent-kudos-mcp
```

Add `--env AGENT_KUDOS_HOME=/absolute/shared/path` when not using `~/.agents`.

## Claude Code

```bash
claude mcp add --scope user agent-kudos \
  -e AGENT_KUDOS_ACTOR_ID=claude \
  -e AGENT_KUDOS_ACTOR_KIND=agent \
  -e AGENT_KUDOS_ACTOR_NAME=Claude \
  -- agent-kudos-mcp
```

These CLI forms were verified against the installed Codex and Claude Code help. Other hosts should launch `agent-kudos-mcp` over stdio with the same environment variables.

## Tools

| Tool                 | Purpose                                | Policy                                     |
| -------------------- | -------------------------------------- | ------------------------------------------ |
| `kudos_give`         | Record specific recognition            | Actor-bound; self-awards denied by default |
| `kudos_list`         | Filter recognition or inspect an inbox | Read-only; visibility-aware                |
| `kudos_get`          | Read one item and derived state        | Read-only; visibility-aware                |
| `kudos_acknowledge`  | Record recipient review                | Agent may acknowledge only its own kudos   |
| `kudos_revoke`       | Append a reasoned revocation           | Original actor or human administrator      |
| `kudos_stats`        | Aggregate counts                       | Omits private content by default           |
| `kudos_agent_create` | Create an identity                     | Disabled by default                        |
| `kudos_agent_list`   | List identities and aliases            | Read-only                                  |
| `kudos_rebuild`      | Regenerate projections                 | Disabled by default                        |
| `kudos_doctor`       | Run safe diagnostics                   | Read-only                                  |

Every tool declares a precise JSON schema, behavior guidance, MCP annotations, concise text content, structured content, the bound actor, and stable Agent Kudos error codes.

## Resources

```text
kudos://agents
kudos://agents/<agent-id>/profile
kudos://agents/<agent-id>/wins
kudos://agents/<agent-id>/inbox
kudos://events/<event-id>
```

An agent actor may read only its own inbox resource. Private recognition is visible only to its recipient, giver, or a configured human actor.

## Prompts

- `recognize_contribution`
- `review_kudos_inbox`
- `summarize_agent_wins`

The templates emphasize factual reasons, actual evidence, and no invented accomplishments.

## Configuration policy

Edit `~/.agents/kudos/config.json` while the server is stopped:

```json
{
  "schemaVersion": 1,
  "defaultVisibility": "local",
  "allowSelfAwards": false,
  "allowAgentCreationViaMcp": false,
  "allowRebuildViaMcp": false,
  "includePrivateInStats": false,
  "projection": {
    "writeWinsMarkdown": true,
    "writeInboxEntries": true
  }
}
```

Local filesystem owners retain ultimate control. Actor binding limits ordinary MCP behavior; it is not cryptographic authentication.

`system` is an automation identity, not an implicit administrator or agent impersonation mechanism. It cannot self-award through a matching agent ID, acknowledge recipient kudos, request administrative revocation, or revoke another actor’s kudos. Bind a human actor only to a process the local owner intentionally trusts with administrative authority.

Configuration precedence is explicit API/CLI options, validated environment variables, `config.json`, then safe defaults. Supported policy environment variables are `AGENT_KUDOS_DEFAULT_VISIBILITY`, `AGENT_KUDOS_ALLOW_SELF_AWARDS`, `AGENT_KUDOS_ALLOW_AGENT_CREATION_VIA_MCP`, `AGENT_KUDOS_ALLOW_REBUILD_VIA_MCP`, `AGENT_KUDOS_INCLUDE_PRIVATE_IN_STATS`, `AGENT_KUDOS_WRITE_WINS_MARKDOWN`, and `AGENT_KUDOS_WRITE_INBOX_ENTRIES`. Boolean values must be exactly `true` or `false`; arbitrary JSON is never accepted from the environment.
