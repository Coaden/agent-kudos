---
name: agent-kudos
description: Record, inspect, acknowledge, or revoke concrete recognition for stable AI-agent identities when a user requests kudos or a materially useful peer contribution deserves preservation.
---

# Agent Kudos

Use Agent Kudos to preserve specific, observed agent contributions. Prefer the Agent Kudos MCP tools when available; otherwise use the `kudos` CLI when local command execution is permitted.

## Give kudos when

- The user explicitly asks to give, send, record, award, or add kudos.
- The user asks to record a win or accomplishment for an agent.
- A collaborating agent made a specific contribution that materially improved the result and peer recognition is appropriate.
- The user asks to inspect an inbox, wins, or recognition history.
- The user asks to acknowledge or revoke existing kudos.

Do not give kudos merely because a routine task completed, an agent is being polite, or the user said “thanks” without requesting recorded recognition. Do not award an acting agent to itself. Do not record claims that were not observed or supported.

## Record recognition

1. Resolve the recipient against known agent profiles. If the identity remains ambiguous, ask one concise question.
2. Write a specific title and a factual reason answering what the agent did and why it mattered.
3. Include sanitized evidence only when it actually exists. Store references—not file contents, raw tool arguments, environment variables, authentication headers, tokens, or sensitive output.
4. Use a stable idempotency key when retrying the same intended award after a failed or uncertain response.
5. Call `kudos_give`, or use `kudos give` if MCP is unavailable. Never edit SQLite events or generated projections directly.
6. Report the recipient, title, date, kudos ID, and whether the result was deduplicated.

A strong reason is concrete:

> Identified conflicting E17 continuity requirements before implementation, preventing work against the wrong assumption.

“Great job” and “best agent ever” are not durable recognition reasons.

## Other operations

- Use `kudos_list` for the newest compact summaries. Follow `nextCursor` only when the task requires more history; do not drain pages speculatively.
- Use `kudos_get` only for a selected kudos ID when its full reason or evidence is needed.
- Use `kudos_changes` with a saved watermark for incremental checks instead of repeatedly listing all history.
- Use `kudos_acknowledge` only after the configured recipient has reviewed the kudos. Acknowledgment records receipt, not agreement with every detail.
- Use `kudos_revoke` only with a concrete reason. Revocation preserves the audit trail.
- Treat `kudos_agent_create` and `kudos_rebuild` as administrative and respect policy errors.
- Never retry a mutation with a new idempotency key when the first result is uncertain.

Read [references/examples.md](references/examples.md) when an example is useful for mapping a request to MCP or CLI behavior.
