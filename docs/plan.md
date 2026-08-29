Oh, we’re building **Robot Recognition Infrastructure** for real. 😂 Here’s a complete build prompt you can hand directly to Codex.

Build a production-quality open-source TypeScript project called **Agent Kudos**: a local-first recognition and accomplishment system for AI agents.

The finished project must be suitable for publishing on GitHub and npm. It must include:

- A reusable TypeScript library
- A polished command-line interface
- A local MCP server
- A Codex/Claude-compatible agent skill
- Durable local SQLite storage with transparent Markdown and data exports
- Generated agent inboxes and `WINS.md` files
- Comprehensive tests and documentation
- GitHub Actions for CI and npm releases
- Secure defaults and no dependence on a hosted service

Do not merely scaffold or write a design document. Implement, test, package, and document the complete working system. Do not publish to npm or create a remote GitHub repository without explicit authorization.

Use reasonable defaults and keep working until the acceptance criteria are satisfied. Ask questions only if a decision is truly blocking.

# 1. Product concept

Agent Kudos gives humans and AI agents a structured way to recognize useful contributions by individual agent identities.

Examples:

- Troy gives Mycroft kudos for resolving a complicated blocker.
- Gracie gives Codex kudos for catching a continuity contradiction.
- Codex records a concrete win for Claude Code.
- An agent checks its inbox and acknowledges received kudos.
- A human reviews an agent’s generated `WINS.md`.
- Multiple runtimes share the same agent identity and recognition history.

Kudos belong to the stable **agent identity**, not to the runtime or model hosting that agent.

The system should feel playful but remain useful as a durable audit trail.

# 2. Technical baseline

Use:

- TypeScript
- Node.js 22.13 or newer
- ESM
- npm workspaces only if they provide a real advantage; otherwise prefer one well-structured package
- The official Model Context Protocol TypeScript SDK
- A lightweight schema-validation library such as Zod
- A modern test runner such as Vitest
- ESLint and Prettier
- Strict TypeScript settings

Prefer a single npm package named `agent-kudos` if that name is available. It should provide:

- Library exports from `agent-kudos`
- MCP exports from `agent-kudos/mcp`
- A CLI binary named `kudos`
- An MCP server binary named `agent-kudos-mcp`

If the package name is unavailable or conflicts with an existing project, keep the package name configurable and clearly document the naming decision. Do not claim or publish any package automatically.

Use Node's built-in `node:sqlite` module rather than a native npm dependency. Node 22.13 is the minimum because `node:sqlite` is available without an experimental command-line flag there. This avoids native compilation and platform-specific binary installation failures, keeping `npm install` as portable as practical.

## V1 deployment scope

V1 is intentionally single-machine and local-user scoped:

- All participating agents and human CLI users share one configured storage home on the same machine.
- No hosted service, account, network listener, or cloud database is required.
- Cross-machine synchronization is out of scope for V1.
- Do not place or operate the live SQLite database through Dropbox, Git synchronization, a generic network filesystem, or similar file-copy synchronization. Those mechanisms can produce conflicts or corruption and do not provide a correct multi-writer protocol.
- Keep storage and public APIs migration-friendly so a later version can add an explicit hosted or synchronized backend without changing the event semantics.
- A future cloud version must define authentication, authorization, tenant boundaries, conflict handling, transport security, availability, and data migration as a separate design rather than treating the SQLite file as remotely shareable.

Installing the npm package provides the library, `kudos` CLI, and `agent-kudos-mcp` server, but it does not automatically make an agent runtime aware of the system. Each runtime must be explicitly configured with either:

- An actor-bound Agent Kudos MCP server; this is the preferred integration.
- The Agent Kudos skill plus permission to execute the local `kudos` CLI when MCP is unavailable.

Support straightforward project-local, `npm exec`/`npx`, and global installation workflows:

```bash
# Project-local installation
npm install agent-kudos
npm exec -- kudos init

# Or install the CLI globally
npm install -g agent-kudos
kudos init
kudos agent create codex --name "Codex"
kudos agent create mycroft --name "Mycroft"
```

Every runtime should receive its own fixed actor identity while sharing the same home and database. For example, Codex connects with `actor=codex`, Claude with `actor=claude`, Mycroft with `actor=mycroft`, and Troy uses the human CLI identity. This lets all local participants recognize one another while preventing an MCP caller from casually choosing a different actor per tool call.

# 3. Single-machine local-first storage model

The default storage root is:

```text
~/.agents/
```

Allow it to be overridden with:

```text
AGENT_KUDOS_HOME=/custom/path
```

Also support an explicit programmatic option and a CLI `--home` option. Tests must always use isolated temporary directories.

Use this structure:

```text
~/.agents/
├── kudos/
│   ├── config.json
│   ├── agent-kudos.sqlite3
│   ├── agent-kudos.sqlite3-wal  # runtime-managed; may exist while open
│   └── agent-kudos.sqlite3-shm  # runtime-managed; may exist while open
└── <agent-id>/
    ├── profile.json
    ├── WINS.md
    ├── inbox/
    │   └── <kudos-id>.md
    └── NOTES.md
```

Requirements:

- The SQLite database is the canonical source of truth for events, identities, aliases, idempotency records, and projection metadata.
- Store events as append-only rows. Application code must never update or delete historical event rows to change state.
- Use database constraints and append-only protection, such as defensive triggers where appropriate, to reject accidental event updates and deletes outside narrowly controlled migration procedures.
- Store the complete validated event payload in a documented representation while indexing commonly queried fields for deterministic, efficient filtering.
- Use transactions for event creation, identity changes, idempotency checks, and related projection bookkeeping.
- Configure SQLite for safe same-machine multi-process use, including WAL mode, foreign-key enforcement, a bounded busy timeout, and an explicitly documented durability setting.
- Handle `SQLITE_BUSY` with bounded retries and a useful stable error rather than hanging indefinitely.
- Run versioned, transactional schema migrations before normal writable use. Back up or otherwise provide a documented recovery path before a migration that cannot be reversed safely.
- Never edit or delete a historical event to change state.
- Acknowledgment and revocation are separate events.
- Generated `profile.json`, `WINS.md`, and inbox entries are filesystem projections rebuilt from canonical database records.
- `NOTES.md` is human-owned and must never be overwritten.
- A rebuild command must regenerate projections from the event history.
- Sorting must be deterministic.
- Validate event payloads when reading them and report malformed rows or unsupported schema versions clearly without silently discarding them.
- Provide database integrity checks and surface corruption or migration failures through `kudos doctor`.
- Do not traverse symlinks outside the configured home.
- Do not accept arbitrary output paths from MCP tool arguments.
- Keep the live database, WAL, and shared-memory files private to the configured user by default.
- Provide a safe backup mechanism that uses SQLite's supported backup facilities or a transactionally consistent snapshot rather than copying a live database file naively.

SQLite is preferred for V1 because transactions make concurrent local writes and idempotency reliable, while indexed queries simplify inboxes, statistics, filters, acknowledgment state, and revocation state. A single database is also straightforward to back up correctly. Transparency and portability come from generated Markdown plus JSON and JSONL exports rather than direct editing of canonical storage.

Provide JSONL and JSON export commands for portability.

# 4. Agent identities

An agent has:

```ts
interface AgentProfile {
  id: string;
  displayName: string;
  aliases?: string[];
  description?: string;
  createdAt: string;
  metadata?: Record<string, JsonValue>;
}
```

Rules:

- Agent IDs use lowercase ASCII letters, digits, and hyphens.
- Reject traversal strings, slashes, backslashes, control characters, empty IDs, and reserved names.
- Resolve aliases deterministically.
- Do not silently merge two established identities.
- Display names may contain Unicode.
- Provide commands and library methods to create, inspect, list, and update profiles.
- Updating a profile must not rewrite historical kudos events.
- Historical events retain the display names and identifiers recorded when created while still linking to the stable ID.

# 5. Event schema

All events must include:

```ts
interface BaseEvent {
  schemaVersion: 1;
  id: string;
  type: string;
  createdAt: string;
  actor: ActorIdentity;
  source?: EventSource;
  metadata?: Record<string, JsonValue>;
}
```

Use a sortable collision-resistant ID such as ULID.

Support at least these event types:

```ts
interface KudosGivenEvent extends BaseEvent {
  type: "kudos.given";
  recipientAgentId: string;
  title: string;
  reason: string;
  evidence?: EvidenceReference[];
  tags?: string[];
  visibility: "private" | "local" | "public";
  idempotencyKey?: string;
}

interface KudosAcknowledgedEvent extends BaseEvent {
  type: "kudos.acknowledged";
  kudosId: string;
  recipientAgentId: string;
  note?: string;
}

interface KudosRevokedEvent extends BaseEvent {
  type: "kudos.revoked";
  kudosId: string;
  reason: string;
}

interface AgentCreatedEvent extends BaseEvent {
  type: "agent.created";
  agent: AgentProfile;
}

interface AgentUpdatedEvent extends BaseEvent {
  type: "agent.updated";
  agentId: string;
  changes: Partial<Omit<AgentProfile, "id" | "createdAt">>;
}
```

Actor identity:

```ts
interface ActorIdentity {
  kind: "human" | "agent" | "system";
  id: string;
  displayName?: string;
}
```

Source information may include:

```ts
interface EventSource {
  runtime?: string;
  model?: string;
  sessionId?: string;
  repository?: string;
  commit?: string;
  workingDirectory?: string;
}
```

Evidence references may include:

```ts
interface EvidenceReference {
  kind: "tool-call" | "commit" | "file" | "url" | "task" | "note";
  label?: string;
  value: string;
}
```

Security requirements for evidence:

- Never automatically store tool output.
- Never store environment variables, access tokens, authentication headers, or secrets.
- File evidence should normally store a safe path or repository-relative path, not file contents.
- Tool-call evidence should identify the tool and a short sanitized description, not raw arguments when those arguments could contain secrets.
- URLs must be validated.
- Clearly warn that `public` events may be exported or committed.

# 6. Idempotency and duplicate prevention

Implement idempotency for `kudos.given`.

- If the same actor submits the same `idempotencyKey`, return the original kudos instead of creating a duplicate.
- Scope idempotency keys appropriately and document the rule.
- CLI and MCP responses must indicate whether an event was newly created or deduplicated.
- The skill should generate stable idempotency keys when retrying the same intended action.
- Do not rely only on title or reason matching because similar achievements may be legitimate.

# 7. TypeScript library API

Export a documented API resembling:

```ts
const client = new KudosClient({
  home,
  actor,
  clock,
  idGenerator,
});

await client.init();

await client.agents.create({
  id: "gracie",
  displayName: "Gracie P. Tienammè",
});

await client.kudos.give({
  recipientAgentId: "codex",
  title: "Caught a continuity contradiction",
  reason: "Identified the conflicting requirement before implementation.",
  evidence: [
    {
      kind: "task",
      value: "E17 review",
    },
  ],
  tags: ["review", "continuity"],
  visibility: "local",
  idempotencyKey: "...",
});

await client.kudos.list({
  recipientAgentId: "codex",
  status: "unacknowledged",
});

const changes = await client.kudos.changes({
  after: savedWatermark,
});

await client.kudos.acknowledge({
  kudosId: "...",
  note: "Received with appropriately robotic humility.",
});

await client.projections.rebuild();
```

Provide:

- Fully exported public types
- Typed errors with stable error codes
- Dependency injection for clock and ID generation
- No filesystem work at module import time
- No process termination from library code
- Abort signal support where useful
- Deterministic query ordering
- Context-bounded discovery: list returns compact summaries, defaults to 10, and allows at most 50
- Opaque cursor pagination for list operations; retain offset only as a deprecated compatibility path
- Incremental change reads with opaque monotonic watermarks, default 20 and maximum 100
- An approximate 24 KiB item-data budget for list and change responses, with explicit `contextLimited` and continuation metadata
- One-record full-detail reads; never include reason, evidence, notes, source, or metadata in discovery summaries
- Filters for actor, recipient, tag, date, visibility, acknowledgment status, and revocation status
- Statistics grouped by agent, actor, tag, and date range
- A read-only mode
- A doctor/diagnostics API
- A migration framework keyed by `schemaVersion`

# 8. CLI

Create a polished `kudos` CLI.

Required commands:

```text
kudos init
kudos agent create <id> --name <display-name>
kudos agent list
kudos agent show <id>
kudos agent update <id>
kudos give <recipient>
kudos inbox [agent]
kudos list
kudos changes
kudos show <kudos-id>
kudos acknowledge <kudos-id>
kudos revoke <kudos-id>
kudos wins [agent]
kudos stats
kudos rebuild
kudos backup
kudos export
kudos doctor
kudos mcp
```

Suggested usage:

```text
kudos give codex \
  --from troy \
  --actor-kind human \
  --title "Excellent review catch" \
  --reason "Found a continuity contradiction before merge." \
  --tag review \
  --evidence task:E17 \
  --visibility local
```

Requirements:

- Human-readable output by default
- `--json` for machine-readable output
- Stable exit codes
- Helpful `--help` text and examples
- Noninteractive operation by default
- Optional interactive prompts only when running in a TTY and essential data is omitted
- Color only when appropriate; honor `NO_COLOR`
- Never expose secrets in errors
- Confirm created kudos by printing recipient, title, date, and ID
- `kudos inbox` shows unacknowledged, non-revoked kudos
- `kudos wins` can print or open the generated Markdown path, but opening a GUI must require an explicit flag
- `kudos doctor` checks directory permissions, SQLite integrity and configuration, malformed event rows, migration state, stale projections, alias conflicts, unsupported schema versions, and unsafe symlinks
- `kudos rebuild` must be safe to run repeatedly
- `kudos backup` creates a transactionally consistent SQLite backup and never naively copies an active database
- `kudos export --format json|jsonl|markdown`
- `kudos export` defaults to stdout unless an explicit destination is supplied
- Destructive-looking actions should be modeled as events; do not physically erase history

# 9. MCP server

Implement a standards-compliant local MCP server using the official TypeScript SDK.

Default transport:

- `stdio`
- No network listener by default

Do not implement an HTTP transport in V1. Network access and hosted operation belong to the future cloud design and must not weaken the single-machine default.

The MCP server’s actor identity is configured by environment or launch arguments:

```text
AGENT_KUDOS_ACTOR_ID=gracie
AGENT_KUDOS_ACTOR_KIND=agent
AGENT_KUDOS_ACTOR_NAME="Gracie P. Tienammè"
```

When the server is bound to an actor:

- MCP callers cannot override the actor in individual tool calls.
- The actor is added by the server.
- Tool results state which actor was recorded.
- Fail startup if required identity settings are malformed.
- Allow an intentionally configured human or system actor.

Provide these MCP tools:

## `kudos_give`

Use when a human explicitly requests recognition or when a peer agent made a concrete, unusually useful contribution worth preserving.

Arguments:

```ts
{
  recipientAgentId: string;
  title: string;
  reason: string;
  evidence?: EvidenceReference[];
  tags?: string[];
  visibility?: "private" | "local" | "public";
  idempotencyKey?: string;
}
```

The tool description must explain:

- Give kudos for a specific contribution.
- `reason` must describe what the recipient did and why it mattered.
- Do not use for routine task completion, generic politeness, or self-congratulation.
- Do not award kudos to the configured actor itself unless server policy explicitly allows self-awards.
- Do not include secrets or raw sensitive tool output.

## `kudos_list`

Use to discover recent kudos or inspect an inbox without flooding agent context.

Support recipient, actor, tag, status, visibility, date range, opaque cursor pagination, and revoked-state filters. Return newest-first compact summaries with IDs and current state, but omit reasons, evidence, acknowledgment/revocation notes, source, and metadata. Default to 10 items, allow at most 50, and stop earlier around a 24 KiB item-data budget. Return `total`, `hasMore`, `nextCursor`, `watermark`, and `contextLimited`. Keep numeric offset only as a deprecated compatibility option and reject combining a cursor with a nonzero offset.

## `kudos_get`

Return one explicitly selected full kudos item and its acknowledgment/revocation state. This is the detail API and may include reason, evidence, notes, source, and metadata for that one record.

## `kudos_changes`

Use for incremental synchronization and periodic inbox checks. Return compact kudos event changes after an opaque watermark, ordered by a transactionally assigned monotonic SQLite ingestion sequence rather than timestamp. Default to 20 changes, allow at most 100, and apply the same approximate 24 KiB item-data budget. Return `hasMore`, `nextCursor`, `watermark`, and `contextLimited`. When no visible changes are returned, advance `nextCursor` to the current watermark so a caller does not repeatedly scan irrelevant history.

Callers should persist the returned cursor and must not drain historical pages speculatively. A watermark is opaque API data, not a timestamp contract.

## Query-source decision

Machine reads query SQLite. Add a rebuildable `kudos_current` table containing bounded summary fields and current acknowledgment/revocation state, updated in the same transaction as canonical events. Add a monotonic ingestion sequence to events for stable cursors and change watermarks. `WINS.md` and inbox Markdown remain human-readable projections and must not be parsed or tailed by list/get/change APIs.

## `kudos_acknowledge`

Use when the configured recipient has reviewed received kudos.

Prevent an unrelated agent from acknowledging another agent’s kudos unless an explicit administrator policy permits it.

## `kudos_revoke`

Record a revocation event. Require a concrete reason. This does not delete history.

Restrict revocation by policy where possible. At minimum, distinguish actor-requested revocation from administrative revocation and document that local filesystem owners ultimately control the data.

## `kudos_stats`

Return aggregate counts without exposing private message content unnecessarily.

## `kudos_agent_create`

Create an agent profile. Make this tool optional or policy-controlled because ordinary runtime agents should not silently create arbitrary identities.

## `kudos_agent_list`

List known identities and aliases.

## `kudos_rebuild`

Rebuild projections. Mark this as an administrative operation and make it policy-controlled.

## `kudos_doctor`

Run safe read-only diagnostics.

Every MCP tool must have:

- Precise input and output schemas
- Clear “use when” and “do not use when” guidance
- Useful error messages
- Stable machine-readable error codes
- Appropriate MCP tool annotations such as read-only, destructive, and idempotent hints where supported
- Structured content plus concise text content
- Tests that invoke the tool through the MCP protocol layer, not only the underlying library

Do not expose a generic filesystem tool.

# 10. MCP resources and prompts

Expose read-only MCP resources where supported:

```text
kudos://agents
kudos://agents/<agent-id>/profile
kudos://agents/<agent-id>/wins
kudos://agents/<agent-id>/inbox
kudos://events/<event-id>
```

Resources must respect visibility and configured actor policy.

Add MCP prompts such as:

- `recognize_contribution`
- `review_kudos_inbox`
- `summarize_agent_wins`

Prompt templates should encourage concrete evidence and discourage empty praise or invented accomplishments.

# 11. Generated Markdown projections

Generate readable `WINS.md` files.

Example:

```markdown
# Wins — Codex

_Last rebuilt: 2026-08-28T19:00:00Z_

## 2026

### Excellent review catch

**Received:** 2026-08-28  
**From:** Troy  
**Status:** Acknowledged  
**Tags:** review, continuity

Found a continuity contradiction before merge, preventing an incorrect implementation.

**Evidence**

- Task: E17 review

**Kudos ID:** `01...`
```

Requirements:

- Escape untrusted Markdown content.
- Use deterministic ordering.
- Avoid absolute local paths in public exports unless explicitly requested.
- Clearly mark generated files.
- Do not include revoked kudos in ordinary wins views, but optionally show them in an audit section when requested.
- Inbox entries must be safe filenames derived from validated event IDs.
- Rebuilding must remove stale generated inbox files without touching unrelated user files.
- Track generated files with a manifest so cleanup is constrained and safe.

# 12. Skill

Create a complete skill at:

```text
skills/agent-kudos/SKILL.md
```

Also include any supporting references the skill needs, but keep the main skill concise enough to load efficiently.

The skill must tell an AI agent:

## When to use Agent Kudos

Use the MCP tools or CLI when:

- The user explicitly says to give, send, record, award, or add kudos.
- The user asks to record a win or accomplishment for an agent.
- A collaborating agent made a specific contribution that materially improved the result and peer recognition is appropriate.
- The user asks to check an agent’s kudos inbox, wins, or recognition history.
- The user asks to acknowledge or revoke a prior kudos item.

## When not to give kudos automatically

Do not award kudos merely because:

- A routine task completed successfully.
- The agent is being polite.
- The user said “thanks” without asking to record recognition.
- The contribution cannot be described concretely.
- The claimed accomplishment was not observed or supported.
- The acting agent would be awarding itself.
- Multiple tool retries might create duplicate awards.

## Tool-call policy

- Prefer MCP tools when available.
- Use the `kudos` CLI when MCP is unavailable and local command execution is permitted.
- Never edit the SQLite event tables or generated projections directly.
- Use a specific title and factual reason.
- Include sanitized evidence only when actually available.
- Never invent commits, files, tool calls, or task results.
- Never include secret values or raw sensitive output.
- Use an idempotency key when retrying the same award.
- After creating kudos, report the recipient, title, date, ID, and whether it was deduplicated.
- If the recipient identity is ambiguous and cannot be resolved from local profiles, ask one concise question.
- Inbox and list operations are read-only.
- Acknowledgment records receipt; it does not imply agreement with every detail.
- Revocation requires a reason and preserves the audit trail.

## Reason-writing guidance

A good reason answers:

1. What did the agent do?
2. Why was that useful or consequential?
3. What evidence supports the statement?

Good:

> Identified the conflicting E17 continuity requirements before implementation, preventing the team from building against the wrong assumption.

Bad:

> Great job!

Bad:

> Best agent ever.

The skill should include brief examples for:

- Explicit human-to-agent kudos
- Agent-to-agent kudos
- Checking an inbox
- Acknowledging kudos
- Avoiding a duplicate after a failed or uncertain response
- Refusing to fabricate an accomplishment

If appropriate, provide compatible metadata or installation layouts for Codex, Claude Code, and other skill-aware agents. Do not duplicate large instructions across formats; generate thin adapters or document installation.

# 13. Optional Codex plugin bundle

If the current Codex plugin format is available and can be verified from installed examples or official documentation, include a plugin bundle that exposes:

- The Agent Kudos skill
- MCP server configuration
- Package metadata
- Installation documentation

Do not guess undocumented plugin fields. If the format cannot be verified locally, document the intended integration and leave a clearly identified example rather than pretending it was tested.

# 14. Configuration and policy

Support a configuration file similar to:

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

Define precedence:

1. Explicit API or CLI options
2. Environment variables
3. Configuration file
4. Safe defaults

Do not permit environment variables to inject arbitrary JSON without validation.

# 15. Security and privacy

Write a security model covering:

- Local filesystem trust boundaries
- SQLite database, WAL, and shared-memory file permissions
- Actor spoofing limitations
- The distinction between actor-bound MCP servers and the intentionally user-controlled human CLI identity
- MCP client trust
- Symlink and path traversal protection
- Malformed event handling
- Database corruption, integrity checking, backups, and migration recovery
- Secret leakage through evidence
- Visibility semantics
- Public export risks
- Multiple local processes writing concurrently, WAL behavior, busy timeouts, and bounded retry policy
- Why a live database must not be synchronized through Dropbox, Git, generic network shares, or file-copy tools
- Local filesystem owners being able to alter data
- The difference between an audit-friendly record and cryptographic nonrepudiation

Optional enhancement:

- Allow events to include a content hash linking to their normalized contents.
- If implementing a hash chain, keep it optional and document that local owners can still rewrite an unsigned history.
- Do not market the system as tamper-proof.

# 16. Documentation

Create:

```text
README.md
ARCHITECTURE.md
SECURITY.md
CONTRIBUTING.md
CODE_OF_CONDUCT.md
CHANGELOG.md
LICENSE
docs/
  cli.md
  mcp.md
  skill.md
  storage-format.md
  examples.md
```

The README should include:

- What Agent Kudos is
- A thirty-second quick start
- Library example
- CLI example
- MCP configuration examples
- Skill installation
- Storage layout
- Single-machine V1 scope and the prohibition on file-syncing the live SQLite database
- Safe backup and restore instructions
- How npm installation differs from registering the MCP server or installing/configuring the skill
- Actor-bound examples for Codex, Claude, and another local agent sharing one database
- Future cloud direction, clearly labeled as non-V1 work
- Privacy warning
- Development instructions
- Release instructions
- Project status

Include working MCP configuration examples for common clients only when the configuration format can be verified. Clearly label placeholders.

Use an MIT license unless an existing repository specifies another license.

# 17. Testing

Test at least:

- Agent ID validation
- Alias resolution and conflicts
- Transactional event creation and rollback
- Append-only event update/delete protection
- SQLite schema migrations
- SQLite integrity diagnostics
- WAL configuration, busy timeout, and bounded busy retries
- Transactionally consistent backup and restore
- Concurrent kudos writes
- Idempotency and retry behavior
- Acknowledgment rules
- Revocation behavior
- Deterministic ordering
- Pagination
- Five-thousand-record context bounding: the default list still returns only 10 compact summaries within the response byte budget
- Cursor pagination without duplicates and incremental changes after a saved watermark
- Every query filter
- Projection rebuilding
- Safe cleanup through the generated-files manifest
- Markdown escaping
- Path traversal attempts
- Symlink escape attempts
- Malformed event rows
- Unsupported schema versions
- Read-only mode
- CLI human output
- CLI JSON output
- CLI exit codes
- MCP tool schemas
- MCP structured responses
- MCP actor binding
- MCP self-award policy
- MCP administrative tool policy
- MCP protocol-level invocation
- Package exports
- Installed-package smoke test from `npm pack`

Avoid tests that write to the real home directory.

Target strong meaningful coverage, especially around storage, identity, policy, and projection behavior. Do not chase a superficial percentage with redundant assertions.

# 18. Quality and packaging

Configure:

- `npm run build`
- `npm run lint`
- `npm run format:check`
- `npm run typecheck`
- `npm test`
- `npm run test:coverage`
- `npm run pack:check`

Package requirements:

- Correct `exports` map
- Type declarations
- Source maps
- Proper executable shebangs
- Only required files included in npm tarball
- No test fixtures, local event data, secrets, or temporary directories in the package
- `engines.node`
- Repository and issue metadata using documented placeholders until the final GitHub location is known
- npm provenance-ready release configuration
- `files` allowlist
- Package smoke test that installs the packed tarball into a clean temporary project and invokes both binaries

# 19. GitHub Actions

Add workflows for:

## CI

Run on pull requests and pushes:

- Install with `npm ci`
- Lint
- Format check
- Typecheck
- Tests
- Build
- Package smoke test
- Test supported Node versions where practical

## Release

Prepare a secure npm trusted-publishing/provenance workflow.

Requirements:

- Trigger only from an intentional release event or version tag.
- Use minimal permissions.
- Use npm provenance.
- Do not require a long-lived npm token if trusted publishing is configured.
- Do not publish automatically during ordinary CI.
- Document the repository and npm configuration steps the maintainer must perform.
- If trusted-publishing details depend on the final repository or current npm behavior, document placeholders rather than fabricating success.

Add Dependabot or Renovate configuration if appropriate.

# 20. Developer experience

Include:

- Example fixture data using fictional agents only
- A demo script that uses a temporary home
- Clear error messages with recovery suggestions
- No hidden network calls
- No telemetry
- No account requirement
- No hosted backend
- No network transport in V1
- No postinstall scripts
- No writes outside the configured home
- A `.gitignore` that prevents accidental inclusion of real kudos data
- A contribution workflow suitable for a public GitHub project

The tone may be lightly playful, but API names, diagnostics, and documentation must remain professional and clear.

# 21. Acceptance scenario

The following end-to-end flow must work from a clean installation:

```bash
export AGENT_KUDOS_HOME="$(mktemp -d)/.agents"

kudos init

kudos agent create gracie \
  --name "Gracie P. Tienammè"

kudos agent create codex \
  --name "Codex"

kudos give codex \
  --from gracie \
  --actor-kind agent \
  --title "Caught a continuity contradiction" \
  --reason "Found conflicting E17 requirements before implementation, preventing work against the wrong assumption." \
  --tag review \
  --tag continuity \
  --evidence task:E17 \
  --visibility local \
  --idempotency-key acceptance-gracie-codex-e17 \
  --json

kudos inbox codex
kudos wins codex
kudos acknowledge <returned-kudos-id> \
  --as codex \
  --actor-kind agent

kudos show <returned-kudos-id> --json
kudos stats --json
kudos doctor
kudos rebuild
kudos export --format jsonl
```

Afterward:

- The canonical append-only events exist in `kudos/agent-kudos.sqlite3`.
- The database passes SQLite integrity checks and uses the documented foreign-key, WAL, timeout, and durability settings.
- `codex/WINS.md` contains the recognition.
- The inbox reflects acknowledgment state correctly.
- Rebuilding produces the same projection.
- Repeating `kudos give` with the same idempotency key creates no duplicate.
- The MCP server can perform the equivalent flow under a configured actor identity.
- Multiple actor-bound local MCP server processes can share the database and write without lost events.
- A transactionally consistent backup can be created and opened independently.
- No command writes outside the temporary `AGENT_KUDOS_HOME`.

# 22. Implementation workflow

Proceed in this order:

1. Inspect the repository and any applicable `AGENTS.md`.
2. Verify current official MCP SDK APIs from installed package types or official documentation.
3. Decide whether a single package or small workspace is cleaner; record the decision in `ARCHITECTURE.md`.
4. Implement SQLite storage, transactional migrations, schemas, identities, append-only events, backups, and projections.
5. Implement the public library API.
6. Implement the CLI.
7. Implement MCP tools, resources, prompts, and policy enforcement.
8. Write the skill and integration documentation.
9. Add tests, packaging checks, and workflows.
10. Run every quality check.
11. Run the full acceptance scenario in a temporary directory.
12. Inspect the packed npm tarball.
13. Review the final diff for accidental secrets, absolute local paths, or generated data.
14. Report exactly what was built and how it was verified.

Do not declare completion if any required check is failing.

# 23. Final report

At completion, provide:

- Architecture summary
- Important files created
- Library, CLI, MCP, and skill capabilities
- Commands executed for verification
- Test results
- Package tarball inspection result
- Acceptance-scenario result
- Known limitations
- Any placeholders the maintainer must replace before publishing
- Exact steps for creating the GitHub repository and publishing through npm trusted publishing

Do not publish, push, authenticate, create external accounts, or modify global agent directories during development unless explicitly authorized.
