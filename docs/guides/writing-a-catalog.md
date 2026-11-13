# Writing a catalog

The catalog is the part of defectloop that knows your project. `defectloop init` copies a generic
example ([templates/catalog.example.json](../../templates/catalog.example.json)); replace it with
techniques that fit your codebase.

```json
{
  "version": 1,
  "techniques": [
    {
      "id": "api-contracts",
      "name": "API contracts against the handlers",
      "perArea": "api",
      "requires": ["local-stack"],
      "maxPerDay": 4,
      "instructions": "Start the local stack with `make up`. For the area's endpoints, compare the OpenAPI document with what the handlers accept and return: …"
    }
  ]
}
```

## Good instructions

- **Say how to prove a defect**, not only where to look: a failing test, a command and its output.
  Rounds that cannot prove things produce `unverified` noise.
- **Say what "fixed" means** in this project: which checks to run before committing, which tests to
  add.
- **Say what not to do**: commands that are slow, environments that are shared, data that is real.
  The guard enforces the dangerous part; the instructions keep rounds efficient.
- **Keep one technique one way of looking.** "Review everything" yields less than five focused
  techniques the scheduler can weigh against each other.
- Write instructions for someone smart who has never seen the project and has 60 minutes.

## Fields

| field | |
|---|---|
| `id` | lowercase, digits, dashes, 2–40 chars; stable (statistics are keyed by it) |
| `name` | short, for reports |
| `instructions` | copied into the round's context |
| `requires` | capability names from `config.capabilities`; the technique is skipped while one is missing |
| `perArea` | `false`, `"all"`, or an area kind from `config.areas`: the round gets the least covered area |
| `maxPerDay` | cap for expensive or noisy techniques |
| `internal` | never chosen by the scheduler; only `cleanup` uses it |

Validation is strict: unknown fields are errors (`maxPerdDay` would otherwise silently do nothing).

## The `cleanup` technique

When a round is interrupted with uncommitted changes, the next round is a cleanup. A catalog may
define its own `cleanup` technique (`"internal": true`) to adapt the instructions; otherwise the
built-in one is used.

## Capabilities

Techniques that need something running declare it in `requires`, and the configuration says how to
probe it:

```json
"capabilities": {
  "docker": ["docker", "info"],
  "local-stack": ["curl", "-sf", "http://localhost:8080/health"]
}
```

The probe runs before every round; a technique whose capability is down simply waits.

## Watching the catalog work

`defectloop report` has a table of rounds, yield and dismissed findings per technique. A technique
with many rounds, no `fixed`/`proposed` findings and several `dismissed` ones is producing noise:
sharpen its instructions or remove it. Statistics survive edits as long as the `id` stays the same.
