# Project manifest

A project root contains `manifest.json`.

## Example

```json
{
  "name": "fixture",
  "version": "0.1.0",
  "defaultEntry": "app",
  "entryEnvVar": "FIXTURE_ENTRY",
  "entries": {
    "app": "src/app.copl",
    "tool": "src/tool.copl"
  },
  "defaultWorkers": 2,
  "workersEnvVar": "FIXTURE_WORKERS",
  "linkerFlags": ["-lm"],
  "cc": "cc"
}
```

## Fields

| Field | Meaning |
| --- | --- |
| `name` | Optional project name |
| `version` | Optional project version |
| `defaultEntry` | Entry name used when no environment override is set |
| `entryEnvVar` | Optional environment variable selecting an entry |
| `entries` | Map of entry name to source file |
| `defaultWorkers` | Positive default worker count |
| `workersEnvVar` | Optional environment variable overriding worker count |
| `linkerFlags` | Extra linker flags |
| `cc` | C compiler executable |

## Project layout

```text
manifest.json
src/        local.* imports
modules/    project module overrides
build/      emitted C11 and compiled binaries
```

## Entry selection

1. If `entryEnvVar` is set and non-empty, its value selects an entry.
2. Otherwise `defaultEntry` is used.
3. `--entry <name>` overrides both for a CLI invocation.

If `entryEnvVar` names an unknown entry, startup fails with a clear error.

## Import roots

- `import local.*` resolves under `<project>/src/`.
- Other imports resolve under `<project>/modules/` and then roots from
  `$COPL_PATH`, which may include global module directories.
- Imports resolve by file only, never by namespace alone.
- The last import segment names a `.copl` file.

## Workers

`defaultWorkers` must be a positive integer. `workersEnvVar`, when set to a
positive integer, overrides the default. Invalid values fall back to the
default.
