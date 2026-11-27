# CLI and build

## Commands

```text
coplc check   [project] [options]
coplc build   [project] [options]
coplc emit-c  [project] [options]
coplc run     [project] [options] [-- program args...]
coplc clean   [project] [options]
coplc init    [dir]
coplc lsp     [project]
coplc version
coplc help
```

## Common options

```text
--project <dir>
--entry <name>
--copl-path <dirs>      repeatable or ':'-separated
--json
--no-color
--quiet, -q
--verbose, -v
--help, -h
--version
```

## Build options

```text
--out-dir <dir>
--name <name>
--cc <compiler>
--cflags <flags>
--ldflags <flags>
--keep-c
```

The executable/source base name is:

1. `--name`
2. `manifest.name`
3. entry name

Output:

```text
build/<project-name>.c
build/<project-name>
```

`--keep-c` is accepted; generated C is currently always retained.

## Project discovery

1. positional project argument
2. `--project`
3. search upward from the current directory for `manifest.json`
4. clean usage error if no project is found

## `check`

Loads the manifest, resolves imports, parses, and type-checks. Supports human
and `--json` output.

## `build`

Generates C11, writes it under the build directory, invokes the configured C
compiler with `-std=c11 -pthread`, and links manifest/`clink`/CLI flags.

## `emit-c`

Writes generated C11 to standard output.

## `run`

Builds the project and executes the binary. Arguments after `--` are passed to
the program.

## `clean`

Removes the build directory. Does not require semantic analysis to succeed.

## `init`

Creates:

```text
manifest.json
src/main.copl
```

Existing directories are preserved. Existing manifests are not overwritten.

## `version`

Prints the compiler version.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | success |
| `1` | compile/check failure |
| `2` | CLI usage error |
| `3` | internal compiler error |
| `4` | C compiler/build failure |

## Diagnostics

Human diagnostics include file, line, column, code, source line, and caret.
`--json` emits structured diagnostics for tools and editors.

## LSP

See `lsp.md`. Start with:

```bash
coplc lsp --stdio
```

## Distribution

See `distribution.md` and the top-level `Makefile`.
