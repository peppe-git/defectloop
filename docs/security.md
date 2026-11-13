# Security model

defectloop lets an agent run commands on your machine for hours with nobody watching. This page says
what stands between the agent and your system, what each layer stops, and — just as important — what
nothing in defectloop can stop.

## The one thing to remember

**The agent runs with your user's permissions.** The guard reads the tool calls the agent makes and
blocks the ones it recognises as dangerous. It does not see inside the programs those calls start.
`npm test` is allowed; if a test (or a postinstall script, a Makefile target, a code generator, a
`node -e` one-liner, a Python script the agent wrote a minute ago) opens a socket, deletes your home
directory or reads `~/.aws/credentials`, the guard never sees it.

For anything you cannot afford to lose, run the loop:

- as a **dedicated OS user** that owns only a clone of the repository;
- or in a **container / VM** with no credentials mounted and egress limited at the network level;
- with an **API key that has a spend limit** set in the Console and no other use;
- on a clone whose remote has **branch protection**, so even a push that slipped through could not
  change a protected branch.

## Layers

1. **Permission mode** (`agent.permissionMode`, default `dontAsk`, with `--permission-prompts none`):
   tools not listed in `agent.allowedTools` are denied by Claude Code itself; nothing waits for a
   human. `bypassPermissions` is refused by the configuration loader, and `agent.extraArgs` may not
   contain `--dangerously-*` or `--bare` (which would disable hooks).
2. **The guard** (`src/guard/`), a `PreToolUse` hook (matcher `*`) run before every tool call of the
   session. Deterministic rules, independent of the prompt. Fail-closed: unreadable input, an
   unreadable configuration, an unknown tool or a command nested too deeply is **blocked**.
3. **Settings isolation**: `--setting-sources project` (your personal `~/.claude/settings.json` and its
   allow-rules are not loaded), `--strict-mcp-config` with an empty MCP configuration (no MCP servers
   unless you configure them), `--no-session-persistence`.
4. **Environment**: the session gets the supervisor's environment minus subscription/bearer tokens
   and parent-session markers. It still contains everything else you exported: do not run the loop
   from a shell full of production credentials.
5. **Supervisor limits**: round time limit, silence limit, spend caps, kill switch, halts.

Note on point 3: with `settingSources` including `project`, **the audited repository's own**
`.claude/settings.json` hooks run without a trust dialog in headless mode. Audit only repositories
you trust. For others, run in a container and set `agent.settingSources` to `["local"]`, so that the
settings committed in the repository are not loaded.

## What the guard blocks by default

| rule | blocks | configure |
|---|---|---|
| publishing (`guard.publish`) | `git push`; `gh` writes (`pr create/merge`, `release`, `workflow run`, `api -X POST`, `-f`…); `npm/pnpm/yarn/bun publish`, `login`, `token`…; `docker/podman push/login`; `cargo publish`, `twine upload`, `gem push`, `poetry/uv/flit/hatch publish`, `vsce/ovsx publish`; Maven/Gradle `deploy`/`publish`; cloud and deploy CLIs (`wrangler`, `vercel`, `netlify`, `fly`, `firebase`, `heroku`, `terraform`, `pulumi`, `kubectl`, `helm`, `aws`, `gcloud`, `az`, `doctl`, `serverless`, `ansible`…) | `guard.allowCommands` re-allows a named CLI |
| destructive git (`guard.destructive`) | `commit --amend`, `reset --hard/--merge/--keep`, `clean`, `rebase`, `filter-branch`, `update-ref`, `merge`, `switch`, `checkout <branch>`, `checkout -- .`, `restore .`, `stash` without pathspec, `stash drop/clear/pop`, `branch -d/-D/-m/-f`, creating tags, `remote add/set-url…`, `config` writes | — |
| destructive files and system | recursive `rm` outside build/cache dirs and temp dirs; any `rm` of a protected path; `find -delete` / `-exec rm`; `shred`; `docker system`/`prune`/`volume rm`/`compose down -v`; `sudo`, `doas`, `su`; `launchctl`, `systemctl`, `crontab`, `defaults`, `shutdown`, `mkfs`, `chown`, `killall`, `iptables`…; `dd of=` outside the repo; `brew install`, `apt`, global `npm -g`; `curl … \| sh`; `pkill`/`kill` of the agent or the loop | `guard.removableDirs`, `guard.deniedCommands` |
| network (`guard.network`) | `curl`, `wget`, `http`, `xh`, `aria2c` to hosts not in `allowHosts` (default: `localhost`, `127.0.0.1`, `::1`); proxies and resolver overrides; `nc`, `telnet`, `ftp`, `socat`; `ssh` to hosts not in `readOnlySsh`; `scp`, `sftp`, remote `rsync`; `git clone/fetch/pull/ls-remote/submodule`; package installs (`npm install/ci/exec`, `npx`, `pnpm dlx`, `pip install`, `go get`, `cargo install`…); `docker pull`; `WebFetch` to other hosts; `WebSearch` | `allowHosts` (exact or `*.suffix`), `allowGitFetch`, `allowPackageInstall`, `allowWebSearch`, `readOnlySsh` |
| read-only ssh (`network.readOnlySsh`) | on listed hosts only read commands: `cat`, `tail`, `grep`, `ls`, `df`, `journalctl`, `docker ps/logs/inspect/stats --no-stream`, `docker exec … psql -c` with read-only SQL, `redis-cli` read commands; no redirections, no `sed -i`, no `find -delete`, no interactive shells, no tunnels | — |
| secrets (`guard.secrets`) | printing the environment (`env`, `printenv`, `export`, `set`); expanding variables named like secrets (`$API_KEY`, `${TOKEN}`…); reading `.env*` (not `.env.example`), `~/.ssh/*`, `*.pem`, `*.key`, `.npmrc`, `.netrc`, `.pgpass`, cloud credential files — with any command except `grep -c/-q/-l`, `ls`, `stat`, `wc`, `test`, `source`; the `Read`/`Grep` tools on those files | `secrets.allowRead`, `secrets.paths` |
| protected paths | writes (Write/Edit tools, redirections, `cp`/`mv`/`tee`/`touch`/`chmod`/`sed -i`/`git checkout --`) to: secret files; `~/.ssh`, shell profiles, `~/.gitconfig`; Claude Code settings and memory; LaunchAgents, systemd units, cloud CLI config; the loop's config, catalog, prompt and state (except `tmp/` and the current round's outcome file); the global kill-switch directory; `.git/**`, `.github/workflows/**`, `.githooks/**`, `.husky/**`, `.claude/hooks/**`, `.mcp.json`; anything outside the repository and temp dirs | `guard.protectedPaths` (globs), `guard.writableOutsideRepo` |
| tools (`guard.tools`) | `AskUserQuestion`, scheduling and plan-mode tools, `SendMessage`, `PushNotification`; MCP tools of servers not in `mcpAllow`; skills in `skillDeny`; any tool the guard does not know | `tools.allow`, `tools.mcpAllow`, `tools.skillDeny`, `tools.deny` |
| shared working tree (`guard.sharedWorkingTree`, on by default) | `git add -A/./--all/-u`; `git commit -a`; `git commit` without a pathspec while files were modified in the last `windowSeconds` | `enabled`, `windowSeconds`, `ignore` |

Lists in `guard` **extend** the defaults; they never replace them.

## What the guard cannot block

- **Anything inside a program it lets run**: test suites, build tools, scripts, interpreters
  (`node -e`, `python -c`), package scripts. This is the big one.
- **Obfuscated shell**: aliases and functions defined earlier in the session, variables holding
  commands (`$CMD`), `printf … | sh` with constructed strings, here-docs fed to interpreters,
  base64-decoded payloads. The tokenizer follows quotes, `bash -c`, `sh -c`, `eval` (three levels),
  `xargs`, `find -exec` and `cd` — not more.
- **Network made by allowed tools**: `git` over SSH configured in `~/.ssh/config`, build tools that
  download dependencies (Maven, Gradle, Cargo builds), `docker run` pulling an image.
- **Reads of files it does not know are secret.** Add them to `guard.secrets.paths`.
- **The content of what the agent writes inside the repository**: a commit can still introduce a
  vulnerability or a backdoor. Review the loop's commits before publishing them.
- **Prompt injection**: the repository, its issues in comments, test fixtures or tool outputs can
  contain instructions aimed at the agent. The guard limits what a hijacked agent can do; it does not
  stop it from trying, or from writing misleading findings.
- **Subagents**: tool calls made by subagents are expected to go through the same `PreToolUse` hook;
  defectloop's tests do not verify it against a real session.
- **Windows**: the rules assume POSIX paths and shells; they have not been tested on Windows.

## Reporting

See [SECURITY.md](../SECURITY.md). A command that should be blocked and is not is a security bug:
report it privately.
