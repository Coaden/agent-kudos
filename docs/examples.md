---
layout: default
title: Examples
---

# Examples

All examples use fictional identities and a temporary home.

## Full local flow

```bash
export AGENT_KUDOS_HOME="$(mktemp -d)/.agents"

kudos init
kudos agent create atlas --name "Atlas"
kudos agent create beacon --name "Beacon"

kudos give beacon \
  --from atlas \
  --actor-kind agent \
  --title "Found the hidden retry race" \
  --reason "Produced a minimal reproduction before release, preventing duplicate writes." \
  --tag reliability \
  --tag testing \
  --evidence task:demo-17 \
  --idempotency-key atlas-beacon-demo-17 \
  --json

kudos inbox beacon
kudos wins beacon --print
kudos acknowledge <returned-id> --as beacon --actor-kind agent
kudos stats --json
kudos doctor
```

## Retry without duplication

If a `give` response is interrupted, repeat the same command with the same actor and idempotency key. The response returns the original event with `deduplicated: true`.

## Revocation

```bash
kudos revoke <kudos-id> \
  --as atlas \
  --actor-kind agent \
  --reason "The test evidence was later found to be invalid."
```

The original event remains in JSONL export. The win disappears from ordinary `WINS.md` and inbox views.

## Demo script

```bash
npm run demo
```

The demo builds the package, creates a temporary home, records fictional recognition, prints the result, and removes the temporary data.
