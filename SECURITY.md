# Security policy

defectloop runs an AI coding agent unattended on the user's machine. Its security-relevant parts are
the tool guard (`src/guard/`), the handling of credentials passed to the agent
(`src/adapters/env.mjs`), the spend caps (`src/budget.mjs`) and the kill switch.

## Supported versions

| version | supported |
|---|---|
| 0.1.x (unreleased) | yes |

## Reporting a vulnerability

Please report privately, **not** in a public issue:

- use GitHub's **private vulnerability reporting**:
  <https://github.com/peppe-git/defectloop/security/advisories/new> (or the repository's "Security"
  tab → "Report a vulnerability");
- include the defectloop version, the agent and its version, the configuration (without secrets),
  and the smallest command or payload that reproduces the problem.

You will get an acknowledgement within 7 days. Fixes are released as soon as they are ready; the
advisory is published once a fixed version exists, crediting you unless you prefer otherwise.

## What counts as a vulnerability

- A tool call or command that one of the guard's **default** rules is documented to block, but that
  passes (see [docs/security.md](docs/security.md)). Include the payload.
- A way for the agent to disable or bypass the kill switch, the halt, or the spend caps from inside
  a session.
- Credentials (API keys, subscription tokens, bearer tokens) reaching the agent's environment,
  transcripts, records or reports when the documentation says they should not.
- The guard allowing a call because its input or configuration could not be read.

## What does not

The guard is **not a sandbox**, and the documentation says so: the agent runs with the user's
permissions, and programs it is allowed to run (test suites, build tools, interpreters) are not
inspected. "A test file the agent wrote can open a socket" is expected behaviour, not a
vulnerability — unless the guard was documented to stop that specific path. Prompt injection that
makes the agent write wrong findings is a known limitation; injection that makes it get past a
documented rule is a vulnerability.

## Hardening recommendations

Run the loop as a dedicated user or in a container/VM, with an API key that has a spend limit and no
other use, on a clone whose remote has branch protection. Details in
[docs/security.md](docs/security.md).
