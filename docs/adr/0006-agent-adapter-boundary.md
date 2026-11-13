# ADR 0006 — The agent behind an adapter; Claude Code CLI first, Agent SDK experimental

- Status: accepted (v0.1)
- Date: 2026-11-12

## Context

The supervisor needs: start a session with a prompt, read its events, stop it (with its process
tree), know how it ended and what it cost. Several agents could provide that; v0.1 targets Claude.

## Decision

- An adapter returns `{ lines: AsyncIterable<string>, stderrTail(), kill(), exited }`; events are
  stream-json lines, so one monitor serves every adapter.
- `claude-cli`: `claude -p --output-format stream-json --verbose`, prompt on stdin (not argv: no
  length limits, not visible in `ps`), its own process group on POSIX (`taskkill /T` on Windows),
  guard installed through a generated `--settings` file. Not `--bare`: it disables hooks.
- `agent-sdk`: experimental; loads `@anthropic-ai/claude-agent-sdk` only if installed, runs the guard
  in-process as a `PreToolUse` callback, re-serialises messages as JSON lines. Tested only against a
  fake `query`.
- Other agents (Codex CLI, Gemini CLI, aider) are v0.2, with a translation to the same events.

## Consequences

- Zero runtime dependencies (Node 22 standard library only).
- The adapter contract is small enough to fake completely in tests (`test/fixtures/fake-agent.mjs`).
