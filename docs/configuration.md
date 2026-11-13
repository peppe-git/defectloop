# Configuration reference

`defectloop.config.json`, at the root of the audited repository (or anywhere, with `--config`). The
full JSON Schema is [schemas/config.schema.json](../schemas/config.schema.json). Unknown keys are
errors: a typo must never silently disable a cap. Relative paths are resolved against `root`, which
defaults to the directory of the configuration file.

Minimal valid configuration:

```json
{ "budget": { "perRoundUsd": 2, "dailyUsd": 10 } }
```

## Top level

| key | default | |
|---|---|---|
| `root` | `"."` | the repository the loop works in |
| `stateDir` | `".defectloop"` | state, records, transcripts (add it to `.gitignore`) |
| `catalog` | `"defectloop.catalog.json"` | the technique catalog ([schema](../schemas/catalog.schema.json)) |
| `prompt` | `null` | a prompt template; `null` uses [templates/PROMPT.md](../templates/PROMPT.md) |

Placeholders available in a prompt template: `{{ROUND}}`, `{{CONTEXT}}`, `{{OUTCOME}}`,
`{{OUTCOME_SCHEMA}}`, `{{TRAILER}}`, `{{SCRATCH}}`, `{{MAX_MINUTES}}`.

## `agent`

| key | default | |
|---|---|---|
| `adapter` | `"claude-cli"` | `"claude-cli"` or `"agent-sdk"` (experimental; install `@anthropic-ai/claude-agent-sdk` yourself) |
| `command` | `"claude"` | program, or `[program, ...args]`; on Windows use the full path of the executable |
| `auth` | `"api-key"` | `"api-key"`, `"bedrock"`, `"vertex"`, `"foundry"` — see [costs.md](costs.md) |
| `verifyAuthSource` | `true` | check `apiKeySource` in every session's init event |
| `model`, `fallbackModel`, `effort` | `null` | passed through when set |
| `permissionMode` | `"dontAsk"` | `dontAsk`, `acceptEdits`, `default`, `manual`, `auto`; `bypassPermissions` is refused |
| `allowedTools` | `Read, Glob, Grep, Edit, Write, Bash` | tools the agent may use without asking |
| `disallowedTools` | web search, questions, scheduling, plan mode, worktrees | always denied by the agent itself |
| `settingSources` | `["project"]` | which Claude Code settings files load; `null` = the agent's default |
| `mcpConfig` | `null` | an MCP configuration file; `null` = no MCP servers. Allow their tools in `guard.tools.mcpAllow` |
| `maxTurns` | `null` | passed as `--max-turns` when set |
| `extraArgs` | `[]` | more CLI arguments; `--dangerously-*`, `bypass…` and `--bare` are refused |

## `budget` (required)

| key | |
|---|---|
| `perRoundUsd` | required; the session's own cap (`--max-budget-usd`) and the charge for rounds without a reported cost |
| `dailyUsd` | local calendar day |
| `monthlyUsd` | local calendar month |

At least one of `dailyUsd`, `monthlyUsd`. See [costs.md](costs.md).

## `loop`

| key | default | |
|---|---|---|
| `maxRoundMinutes` | `60` | the session is stopped after this |
| `maxSilenceMinutes` | `20` | …or after this long without any event |
| `secondsBetweenRounds` | `20` | pause between rounds |
| `maxConsecutiveFailures` | `3` | halt after this many failed rounds in a row |
| `maxWaitHours` | `24` | a rate-limit reset further away than this is not trusted: halt |
| `keepRounds` | `300` | older per-round files in `rounds/` are deleted |
| `acceptProposedTechniques` | `false` | add techniques proposed by rounds to the catalog |
| `onBudgetExhausted` | `"wait"` | `"wait"` for the next day/month, or `"halt"` |
| `watchdogMs` | `2000` | how often the kill switch and the limits are checked during a round |

## `scoring`

| key | default | |
|---|---|---|
| `explorationWeight` | `0.5` | weight of the UCB-style exploration bonus |
| `waitWeight` | `0.3` | weight of the waiting bonus |
| `dismissedPenalty` | `0.15` | how much a dismissed finding weighs against the yield |
| `queueEvery` | `3` | the queue gets one round in this many |

See [concepts.md](concepts.md#score).

## `areas`

```json
"areas": {
  "discover": [{ "dir": "src", "kind": "code" }, { "dir": "web/pages", "kind": "ui" }],
  "list": [{ "key": "db/migrations", "kind": "schema" }],
  "priority": ["billing", "auth"]
}
```

## `capabilities`

Probes run before each round, from the repository root. Exit 0 = available.

```json
"capabilities": { "docker": ["docker", "info"], "staging": ["curl", "-sf", "http://localhost:8080/health"] }
```

Techniques that `require` a capability are skipped while it is unavailable; the context tells the
agent which capabilities are available.

## `guard`

See [security.md](security.md) for what each rule blocks. All lists extend the defaults.

```json
"guard": {
  "publish": true,
  "destructive": true,
  "network": {
    "allowHosts": ["api.example.com", "*.internal.example"],
    "allowPackageInstall": false,
    "allowGitFetch": false,
    "allowWebSearch": false,
    "readOnlySsh": ["logs-host"]
  },
  "secrets": { "allowRead": false, "paths": ["config/credentials/**"] },
  "protectedPaths": ["db/migrations/**"],
  "removableDirs": ["tmp-data"],
  "writableOutsideRepo": [],
  "deniedCommands": ["psql"],
  "allowCommands": [],
  "tools": { "allow": [], "deny": [], "mcpAllow": [], "skillDeny": [] },
  "sharedWorkingTree": { "enabled": true, "windowSeconds": 120, "ignore": [] }
}
```

## `alerts`

```json
"alerts": { "command": ["notify-send", "defectloop"] }
```

Every alert (halt, budget reached, two failures in a row, critical finding) is appended to
`.defectloop/ALERTS.md` and, if set, `command` runs with a JSON object on stdin
(`{ "title", "text", "key", "stateDir" }`), at most once an hour per kind.

## Environment variables

| variable | |
|---|---|
| `ANTHROPIC_API_KEY` | required in `api-key` mode |
| `DEFECTLOOP_CONFIG` | default for `--config` |
| `DEFECTLOOP_HOME` | directory of the global kill switch (default `~/.config/defectloop`, `%APPDATA%\defectloop` on Windows) |

The session additionally receives `DEFECTLOOP=1`, `DEFECTLOOP_ROUND`, `DEFECTLOOP_OUTCOME`,
`DEFECTLOOP_STATE`, `DEFECTLOOP_CONFIG`.
