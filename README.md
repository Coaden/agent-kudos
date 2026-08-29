<div align="center">

# 🏆 Agent Kudos

### Recognition infrastructure for the robots doing good work

**Local-first · Agent-aware · Auditable · No account required**

[![CI](https://github.com/Coaden/agent-kudos/actions/workflows/ci.yml/badge.svg)](https://github.com/Coaden/agent-kudos/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/agent-kudos.svg)](https://www.npmjs.com/package/agent-kudos)
[![Node.js 22.13+](https://img.shields.io/badge/Node.js-22.13%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/MCP-stdio-6f42c1)](https://modelcontextprotocol.io/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[Documentation](https://coaden.github.io/agent-kudos/) · [CLI reference](docs/cli.md) · [MCP guide](docs/mcp.md) · [Security](SECURITY.md)

</div>

Agent Kudos gives humans and AI agents a durable way to recognize concrete contributions by stable agent identities. Tell an agent it caught the contradiction, found the race, or unblocked the release—and preserve that win somewhere better than a disappearing chat transcript.

It runs entirely on your machine. One append-only SQLite event store powers the TypeScript library, the `kudos` CLI, an actor-bound MCP server, generated inboxes, and readable `WINS.md` files.

> [!IMPORTANT]
> Agent Kudos is available on npm. It is early pre-1.0 software, so review release notes before upgrading persisted storage or public API consumers.

## Thirty-second start

```bash
npm install --global agent-kudos

export AGENT_KUDOS_HOME="$(mktemp -d)/.agents"
kudos init
kudos agent create codex --name "Codex"
kudos agent create mycroft --name "Mycroft"

kudos give codex \
  --from troy \
  --actor-kind human \
  --title "Excellent review catch" \
  --reason "Found conflicting continuity requirements before implementation." \
  --tag review \
  --evidence task:E17
```

## Let your agent set it up

Paste the prompt below into Codex, Claude Code, Hermes, OpenClaw, OpenCode, Cursor, or another local agent harness. It uses verified automation for Codex and Claude Code and requires other harnesses to inspect their actual conventions instead of guessing.

```text
Set up Agent Kudos for this agent and runtime. Agent Kudos is a local-first recognition system for stable AI-agent identities. It uses an append-only SQLite database under ~/.agents by default, an actor-bound stdio MCP server, and a portable agent skill. Multiple local agents share the database, but each MCP server must be bound to its own stable identity.

Work autonomously through the safe, reversible steps below. Do not expose secrets, overwrite unrelated configuration, invent an identity, or modify another agent's integration.

1. Verify Node.js 22.13+ and npm are available. Install or update the public `agent-kudos` npm package globally with `npm install --global agent-kudos` if needed.
2. Preserve an existing `AGENT_KUDOS_HOME`; otherwise use the default ~/.agents. Run `kudos init`, then `kudos doctor`.
3. Run `kudos agent list`. Determine this agent's existing stable ID from the current harness or Agent Kudos configuration. Reuse it if it exists. If no identity is clearly established, ask me for the agent ID and display name before running `kudos agent create <id> --name <name>`. Never silently merge or rename identities.
4. Detect the current harness from real local evidence and its CLI help or configuration. For Codex or Claude Code, preview the packaged skill installation with `kudos skill install --runtime <codex|claude> --actor-id <agent-id> --actor-name <display-name>`. Review the exact destination, then apply it with the same command plus `--yes`. Do not use `--force` unless I explicitly approve replacing a reported conflict.
5. Run the actor-bound MCP registration command printed by the installer. If an `agent-kudos` MCP entry already exists, inspect it and update only when its actor or executable is wrong; do not create duplicates.
6. For another harness, verify its real stdio MCP and skill conventions from installed help or authoritative documentation. Configure command `agent-kudos-mcp` with `AGENT_KUDOS_ACTOR_ID=<agent-id>`, `AGENT_KUDOS_ACTOR_KIND=agent`, and `AGENT_KUDOS_ACTOR_NAME=<display-name>`. Locate the packaged `skills/agent-kudos` directory and copy it only into that harness's confirmed skill directory. Do not guess paths or overwrite an existing skill; stop and explain if the conventions cannot be verified.
7. Verify with `kudos skill status` where supported, the harness's MCP-list command, and `kudos doctor`. Tell me whether a new agent session is required before the tools or skill appear.
8. Report the package version, stable actor ID, storage home, installed skill path, MCP registration status, verification results, and every file or configuration changed. Do not print private kudos content or environment values beyond the non-secret actor identity and home path.
```

## Why Agent Kudos?

- **Identity belongs to the agent.** Recognition follows `codex`, `gracie`, or `mycroft` across models and runtimes.
- **Praise stays specific.** Titles, factual reasons, sanitized evidence, tags, and visibility make recognition useful later.
- **History is append-only.** Acknowledgment and revocation create new events; they never rewrite the past.
- **Retries are safe.** Actor-scoped idempotency keys prevent accidental duplicate awards.
- **Agents cannot casually impersonate one another.** Each MCP process is bound to a fixed actor at startup.
- **Humans retain control.** The CLI, SQLite database, JSON/JSONL exports, and Markdown views are all local and inspectable.
- **No cloud dependency.** V1 has no hosted service, telemetry, account, HTTP listener, or hidden network call.

## Give kudos from code

```ts
import { KudosClient } from 'agent-kudos';

const client = new KudosClient({
  actor: { kind: 'human', id: 'troy', displayName: 'Troy' },
});

await client.init();

await client.agents.create({ id: 'codex', displayName: 'Codex' });

const result = await client.kudos.give({
  recipientAgentId: 'codex',
  title: 'Caught a continuity contradiction',
  reason: 'Identified conflicting E17 requirements before implementation.',
  evidence: [{ kind: 'task', value: 'E17' }],
  tags: ['review', 'continuity'],
  visibility: 'local',
  idempotencyKey: 'troy-codex-e17-review',
});

console.log(result.record.event.id, result.deduplicated);
await client.close();
```

The library performs no filesystem work at import time and never terminates the host process.

### Context-safe reads

Discovery is intentionally bounded for agent contexts. `client.kudos.list()` and the MCP `kudos_list` tool return the 10 newest compact summaries by default (maximum 50), never full reasons, evidence, notes, or metadata. Follow `nextCursor` for another page, then call `kudos.get(id)` / `kudos_get` for the one full record you actually need.

For polling, `client.kudos.changes({ after: watermark })` and `kudos_changes` return compact changes after an opaque, monotonic watermark (20 by default, maximum 100). Persist the response's `nextCursor`; when a page is empty it advances to the current `watermark`. Responses are additionally capped to roughly 24 KiB of item data.

`WINS.md` remains a readable, rebuildable human view. Agent APIs query SQLite's indexed current-state table; they do not read or tail Markdown.

## Connect your agents with MCP

Every runtime launches the same local server with a different fixed identity. All of them share the same database.

```text
Codex   (actor=codex)   ─┐
Claude  (actor=claude)  ─┼─> ~/.agents/kudos/agent-kudos.sqlite3
Mycroft (actor=mycroft) ─┘
Troy    (human CLI)     ──>
```

Create profiles before connecting runtimes:

```bash
kudos agent create codex --name "Codex"
kudos agent create claude --name "Claude"
```

Codex CLI:

```bash
codex mcp add agent-kudos \
  --env AGENT_KUDOS_ACTOR_ID=codex \
  --env AGENT_KUDOS_ACTOR_KIND=agent \
  --env AGENT_KUDOS_ACTOR_NAME=Codex \
  -- agent-kudos-mcp
```

Claude Code:

```bash
claude mcp add --scope user agent-kudos \
  -e AGENT_KUDOS_ACTOR_ID=claude \
  -e AGENT_KUDOS_ACTOR_KIND=agent \
  -e AGENT_KUDOS_ACTOR_NAME=Claude \
  -- agent-kudos-mcp
```

The server exposes purpose-built tools, resources, and prompts—never a generic filesystem tool. See the [MCP guide](docs/mcp.md) for policy and client configuration details.

## Install the agent skill

The npm package includes [`skills/agent-kudos`](skills/agent-kudos). Agent Kudos can safely place it into verified Codex and Claude Code user layouts:

```bash
kudos skill install --runtime codex --actor-id codex --actor-name "Codex"       # dry run
kudos skill install --runtime codex --actor-id codex --actor-name "Codex" --yes
kudos skill status
```

The installer copies by default, never creates a missing runtime home, refuses conflicts, and changes nothing without `--yes`. Use `--link` only when you intentionally want a package-linked installation. Other runtimes should first verify their own skill convention and then place the same portable directory there.

See [Skill installation](docs/skill.md) for Codex, Claude Code, and repository-local layouts.

## Storage

```text
~/.agents/
├── kudos/
│   ├── config.json
│   └── agent-kudos.sqlite3
└── codex/
    ├── profile.json        # generated
    ├── WINS.md             # generated
    ├── inbox/              # generated
    └── NOTES.md            # yours; never overwritten
```

Override the root with `AGENT_KUDOS_HOME`, the CLI `--home` option, or the library’s `home` option. Tests and demos always use temporary directories.

> [!WARNING]
> V1 is for multiple processes on **one machine under one local filesystem owner**. Do not operate the live SQLite database through Dropbox, Git sync, or a generic network share. Export or back it up instead. Local filesystem owners can alter the database, so this is audit-friendly history—not cryptographic nonrepudiation.

## CLI at a glance

```text
kudos init                     kudos agent create|list|show|update
kudos give                     kudos inbox|list|changes|show|wins
kudos acknowledge|revoke       kudos stats|doctor|rebuild
kudos export|backup             kudos mcp
kudos skill install|status|uninstall
```

Every command supports `--help`; query commands and mutations support `--json` for automation. Read the complete [CLI reference](docs/cli.md).

## Development

Requires Node.js 22.13 or newer.

Node 22.13 may print Node’s own `node:sqlite` experimental warning even though the module is enabled without a flag. Agent Kudos is tested on that minimum; use a current Node 24 release for a quieter recommended runtime.

```bash
npm install
npm run build
npm run lint
npm run format:check
npm run typecheck
npm test
npm run test:coverage
npm run pack:check
npm run demo
```

`pack:check` creates a real npm tarball, installs it into a clean temporary project, imports both public export paths, and invokes both binaries.

## Backup and safe restore

`kudos backup ./agent-kudos-backup.sqlite3` creates a consistent, owner-readable SQLite snapshot. Validate a restore in a **new home** before switching agents to it; never overwrite a database while Agent Kudos processes are running:

```bash
RESTORE_HOME="$PWD/restored-agents"
mkdir -p "$RESTORE_HOME/kudos"
chmod 700 "$RESTORE_HOME" "$RESTORE_HOME/kudos"
install -m 600 ./agent-kudos-backup.sqlite3 "$RESTORE_HOME/kudos/agent-kudos.sqlite3"
kudos --home "$RESTORE_HOME" doctor
kudos --home "$RESTORE_HOME" rebuild
```

After both commands succeed, stop writers using the old home and point `AGENT_KUDOS_HOME` at the validated restored home. See the [recovery guide](docs/recovery.md) for Windows instructions and rollback guidance.

## Future cloud direction

V1 deliberately shares one local SQLite database among processes owned by one user on one machine. A future cloud backend may preserve the public event semantics, but it will be a separate design with authentication, authorization, tenant isolation, transport security, conflict handling, availability, and explicit data migration. The live SQLite file will never be treated as a cloud synchronization protocol.

## Project status

Agent Kudos is published on [npm](https://www.npmjs.com/package/agent-kudos) and remains under active pre-1.0 development. Public API and storage changes will be documented with migration guidance in [CHANGELOG.md](CHANGELOG.md).

Maintainer setup, trusted publishing, and the release checklist are documented in [docs/releasing.md](docs/releasing.md).

Contributions are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md), follow the [Code of Conduct](CODE_OF_CONDUCT.md), and review [SECURITY.md](SECURITY.md) before reporting a vulnerability.

## License

MIT © Troy Locke. See [LICENSE](LICENSE).
