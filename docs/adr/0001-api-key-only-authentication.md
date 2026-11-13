# ADR 0001 — API key or cloud provider only; no subscription login

- Status: accepted (v0.1)
- Date: 2026-11-12

## Context

The loop this tool was extracted from authenticated its unattended sessions with a long-lived
subscription token (`claude setup-token`). Checked on 2026-11-12: the Agent SDK documentation says
third-party developers may not offer claude.ai login or subscription rate limits in their products
unless approved; the Consumer Terms forbid automated access except with an API key or where
explicitly permitted; subscription limits assume ordinary individual use. The `setup-token`
documentation mentions CI and scripts, which leaves personal use ambiguous, but a published
third-party tool that drives the agent for hours is outside what is clearly allowed.

## Decision

- `agent.auth` accepts `api-key`, `bedrock`, `vertex`, `foundry`. There is no subscription mode.
- The session environment never contains `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_AUTH_TOKEN`; in
  `api-key` mode the cloud provider flags are removed too.
- Every round, the `apiKeySource` of the `system/init` event is checked (`ANTHROPIC_API_KEY` or
  `apiKeyHelper` in `api-key` mode). Anything else stops the session and halts the loop.

## Consequences

- Users pay per token on their own key; costs are visible and capped (ADR 0005).
- A user with only a subscription cannot use the tool as published. That is intended.
- The check depends on a field of the stream; `agent.verifyAuthSource: false` exists for the case the
  field disappears, and is documented as a risk.
