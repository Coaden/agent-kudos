<div align="center">

# 🏆 Agent Kudos

### Recognition infrastructure for the robots doing good work

**Local-first · Agent-aware · Auditable · No account required**

[![CI](https://github.com/Coaden/agent-kudos/actions/workflows/ci.yml/badge.svg)](https://github.com/Coaden/agent-kudos/actions/workflows/ci.yml)
[![Node.js 22.13+](https://img.shields.io/badge/Node.js-22.13%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/MCP-stdio-6f42c1)](https://modelcontextprotocol.io/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[Documentation](https://coaden.github.io/agent-kudos/) · [CLI reference](docs/cli.md) · [MCP guide](docs/mcp.md) · [Security](SECURITY.md)

</div>

Agent Kudos gives humans and AI agents a durable way to recognize concrete contributions by stable agent identities. Tell an agent it caught the contradiction, found the race, or unblocked the release—and preserve that win somewhere better than a disappearing chat transcript.

It runs entirely on your machine. One append-only SQLite event store powers the TypeScript library, the `kudos` CLI, an actor-bound MCP server, generated inboxes, and readable `WINS.md` files.

> [!IMPORTANT]
> Agent Kudos is pre-release software. The project intends to use the currently available `agent-kudos` npm name, but it has not yet been published or claimed. Until the first release, install from source.

## Thirty-second start

```bash
git clone https://github.com/Coaden/agent-kudos.git
cd agent-kudos
npm install
npm run build

export AGENT_KUDOS_HOME="$(mktemp -d)/.agents"
node dist/cli.js init
node dist/cli.js agent create codex --name "Codex"
node dist/cli.js agent create mycroft --name "Mycroft"

node dist/cli.js give codex \
  --from troy \
  --actor-kind human \
  --title "Excellent review catch" \
  --reason "Found conflicting continuity requirements before implementation." \
  --tag review \
  --evidence task:E17
```

After the first npm release:

```bash
npm install --global agent-kudos
kudos init
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

The npm package includes [`skills/agent-kudos`](skills/agent-kudos). Install or link that directory into your agent runtime’s supported skill directory, then register the MCP server. The skill teaches agents when recognition is warranted, when it is not, and how to retry safely without inventing accomplishments.

See [Skill installation](docs/skill.md) for Codex, Claude Code, and repository-local layouts.

## Storage

```text
~/.agents/
├── kudos/
│   ├── config.json
│   ├── agent-kudos.sqlite3
│   └── exports/
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
kudos give                     kudos inbox|list|show|wins
kudos acknowledge|revoke       kudos stats|doctor|rebuild
kudos export|backup             kudos mcp
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

## Project status

Agent Kudos is under active development toward its first npm release. The public API and storage schema should be treated as pre-1.0. Release notes and migration guidance live in [CHANGELOG.md](CHANGELOG.md).

Contributions are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md), follow the [Code of Conduct](CODE_OF_CONDUCT.md), and review [SECURITY.md](SECURITY.md) before reporting a vulnerability.

## License

MIT © Troy Locke. See [LICENSE](LICENSE).
