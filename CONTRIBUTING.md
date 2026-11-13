# Contributing

Thanks for helping. defectloop is small on purpose: Node 22+, ESM, **no runtime dependencies**.

## Setup

```bash
git clone <your fork>
cd defectloop
npm test                     # node --test, no install step needed
bash scripts/scrub-check.sh  # must pass before every commit
```

### Private scrub patterns

The scrub-check has generic rules (issue ids, money amounts, e-mail addresses, home paths,
secrets). Names that are specific to a project or a person never go in the repository: keep them
in a private file **outside** the repository and point `SCRUB_PRIVATE_PATTERNS` at it.

```text
# one extended regex per line, matched without regard to case
# empty lines and lines starting with # are ignored
acme[^a-z0-9]{0,3}widget
\binternal-team-name\b
```

```bash
SCRUB_PRIVATE_PATTERNS=~/.config/scrub/private-patterns.txt bash scripts/scrub-check.sh
```

Without the variable only the generic rules run, and a warning says so (CI runs this way). If the
variable names a missing file, a file inside the repository, or a pattern that does not compile,
the check stops with exit 2.

The tests never call a model: the end-to-end tests use `test/fixtures/fake-agent.mjs`, which replays
stream-json scenarios. **Never run the loop against a real account or a real repository from the test
suite.**

## Rules of the house

- **Test first, and see it fail.** A new guard rule comes with blocked *and* allowed cases in
  `test/guard.test.mjs`, written as data (never as a shell line: a guard would rightly refuse to run
  it). Before calling a rule done, break it on purpose and watch the test go red.
- **Fail closed.** When the supervisor or the guard does not understand something, it stops or
  blocks. A change that turns a halt into a retry, or a block into an allow, needs an ADR.
- **Pure where it decides.** Scheduling, classification, budget and normalisation live in pure
  modules with no I/O; the supervisor only does I/O around them.
- **No new runtime dependencies** without an ADR.
- **Stream format changes**: add a scrubbed fixture to `test/fixtures/streams/` and a test.
- Every source file starts with `// SPDX-License-Identifier: Apache-2.0`.
- English everywhere in the repository. Commit messages: `type(scope): sentence`
  (`feat`, `fix`, `docs`, `test`, `refactor`, `chore`).

## Releases

Only the release workflow publishes to npm: see [RELEASING.md](RELEASING.md).

## Security issues

Not in public issues: see [SECURITY.md](SECURITY.md).

## License

By contributing you agree that your contributions are licensed under the Apache License 2.0.
