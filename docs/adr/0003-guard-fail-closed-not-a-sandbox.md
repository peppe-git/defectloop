# ADR 0003 — A deterministic, fail-closed guard, documented as not a sandbox

- Status: accepted (v0.1)
- Date: 2026-11-12

## Context

Prompts are not a boundary: an agent can be confused, or steered by text in the repository it is
auditing. The original loop combined the agent's permission classifier with a deterministic
`PreToolUse` hook and a pre-push git hook. Its hook let unreadable input through ("not the hook's job
to break the session").

## Decision

- The guard is a `PreToolUse` hook with a small shell tokenizer and explicit rules (publishing,
  destructive commands, network allow-list, secrets, protected paths, tools, shared working tree).
- It is **fail-closed**: unreadable input, an invalid configuration, an unknown tool, shell nested
  deeper than three levels are blocked.
- Lists in the configuration extend the defaults; they cannot remove them. `publish` and
  `destructive` can be turned off, with a warning in `check`.
- The documentation says plainly what the guard cannot see (programs it allows, obfuscated shell,
  network from build tools) and recommends OS-level isolation.

## Consequences

- Some legitimate commands are blocked; the block message tells the agent the alternative. A block
  too many costs a rephrasing; an allow too many can cost data.
- Security reports about bypasses are expected and welcome (SECURITY.md).
