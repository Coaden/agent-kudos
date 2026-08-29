# Agent Kudos examples

## Explicit human-to-agent kudos

Request: “Give Codex kudos for catching that continuity contradiction.”

Call `kudos_give` with recipient `codex`, a concrete title and reason, observed evidence if available, and a stable key such as `session-e17-codex-continuity`.

## Agent-to-agent kudos

When Mycroft’s investigation materially unblocks the current task, another configured agent may recognize Mycroft. State the exact blocker resolved and consequence. The acting agent must not recognize itself.

## Check and acknowledge an inbox

Call `kudos_list` with the configured recipient, `status: "unacknowledged"`, and `revoked: false`. Review the compact first page before requesting more; call `kudos_get` only for an item whose full detail is needed. After reviewing an item, call `kudos_acknowledge` with its ID and an optional factual note. For later checks, save the watermark and call `kudos_changes` with it as `after`.

## Retry after an uncertain response

Repeat the original `kudos_give` call with the same actor and same idempotency key. Report whether the original event was returned. Do not invent a new key.

## Refuse fabrication

If asked to record an accomplishment that was not observed or supported, explain that Agent Kudos requires a concrete factual contribution. Ask for the missing details instead of inventing evidence.
