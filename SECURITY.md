# Security policy

## Supported versions

Agent Kudos is pre-release. Security fixes currently target the latest release and `main`.

## Reporting a vulnerability

Please use GitHub’s private vulnerability reporting for `Coaden/agent-kudos`. Do not open a public issue containing exploit details, secrets, or private kudos data. Include affected versions, reproduction steps, impact, and any suggested mitigation. You should receive an initial response within seven days.

## Trust model

Agent Kudos is a local audit-friendly record, not a tamper-proof ledger.

- The local filesystem owner ultimately controls and can alter the database, configuration, binaries, and generated views.
- Actor-bound MCP processes prevent ordinary callers from overriding identity in tool arguments. They do not cryptographically prove who launched the process.
- The CLI intentionally lets the local human choose an actor. This is convenient administration inside the local-owner trust boundary, not strong authentication.
- MCP clients can request mutations available under the configured actor and should be treated as trusted local software.
- `private`, `local`, and `public` are application visibility policies. Filesystem owners can still inspect every local record.

## Filesystem and SQLite

- Agent IDs reject traversal syntax, separators, controls, and reserved names.
- Reads and writes are constrained to the configured home; existing symlink components are rejected.
- Generated cleanup is constrained by a canonical manifest and accepts only regular files.
- SQLite WAL, shared-memory, database, config, projection, export, and backup files created by Agent Kudos are restricted to the local user where the platform exposes POSIX modes.
- WAL, foreign keys, full synchronization, bounded busy waits, transactions, integrity checks, and append-only triggers reduce corruption and concurrency risks.
- Backups use SQLite `VACUUM INTO` for a consistent snapshot. Do not copy a live database naively.
- Never use Dropbox, Git synchronization, generic network filesystems, or file-copy synchronization as a multi-writer protocol for the live database.

## Evidence and secret leakage

Agent Kudos never captures tool output automatically. Evidence should identify a task, safe relative file path, commit, URL, or sanitized tool action—not its sensitive content.

Do not record:

- access tokens, passwords, private keys, cookies, or authentication headers;
- environment variable values;
- raw tool arguments or outputs that may contain secrets;
- private file contents;
- sensitive URLs or query strings.

Public events may be exported, committed, or published. Review exports before sharing. Portable exports include the data requested by the local owner and may contain private events unless filtered externally.

## MCP

V1 uses stdio only and opens no network listener. MCP tools never accept arbitrary output paths. Agent creation and projection rebuild are disabled through MCP by default. Human actors have local administrative authority. Agent actors can acknowledge only their own kudos. System actors are automation identities—not implicit agents or administrators—and receive no self-award, acknowledgment, or cross-actor revocation bypass.

## Nonrepudiation

Append-only application behavior makes ordinary history changes explicit, but an unsigned database controlled by its owner can be rewritten. Agent Kudos does not currently implement content hashes or signatures and must not be described as cryptographically tamper-proof or legally nonrepudiable.
