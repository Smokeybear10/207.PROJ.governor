---
name: token-governor
description: Use when a user asks whether the current Codex session is token-governed or how to launch Codex with a shared weighted-token cap.
---

# Token Governor

Token Governor is activated before Codex starts. Do not claim this skill itself
creates or changes the active cap.

## Check The Session

Treat the session as governed only when all of these environment variables are
present and valid:

- `TOKEN_GOVERNOR_ACTIVE=1`
- `TOKEN_GOVERNOR_LIMIT_TOKENS`
- `TOKEN_GOVERNOR_INPUT_WEIGHT`
- `TOKEN_GOVERNOR_OUTPUT_WEIGHT`
- `TOKEN_GOVERNOR_POLICY_SHA256`

The bundled `UserPromptSubmit` hook validates the full marker and blocks a
prompt when it is absent or malformed.

## Launch Path

From the Token Governor repository:

```bash
token-governor codex --tokens 50000 --
```

Arguments after `--` go directly to Codex:

```bash
token-governor codex --tokens 50000 -- exec "Review this repository"
```

The launcher enables Codex's native shared rollout budget. User prompts still
go directly to Codex; Token Governor does not proxy or retain prompt text.

## Claims

Describe this as an experimental Codex session token cap. It uses host-reported
prefill and sampling tokens across the rollout. It is not a provider invoice
cap, and it does not expose authoritative dollar settlement.
