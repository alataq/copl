# COPL

COPL is a strict object-oriented language that compiles to C11 for Linux.

This repository contains the bootstrap compiler, standard modules, tests,
VSCodium integration, examples, and distribution tooling.

Current version: `0.1.0`.

> Warning: `v0.x.x` releases are expected to break often. Language rules,
> generated C, runtime ABI, module APIs, CLI flags, and tooling integration may
> change between minor versions until v1.0.

## Requirements

- Linux x86_64 or aarch64
- Bun
- A C11 compiler (`cc`, `gcc`, or `clang`)

## Quick start

```bash
bun install
bun test
bun run src/cli.ts check tests/fixtures/project
bun run src/cli.ts build examples/taskboard
examples/taskboard/build/taskboard
```

## CLI

```text
coplc check   [project] [options]
coplc build   [project] [options]
coplc emit-c  [project] [options]
coplc run     [project] [options] [-- program args...]
coplc clean   [project] [options]
coplc init    [dir]
coplc lsp     [project] [--stdio]
coplc version
coplc help
```

Common options:

```text
--project, --entry, --copl-path
--json, --no-color, --quiet, --verbose
--out-dir, --name, --cc, --cflags, --ldflags
```

## Build and distribution

```bash
make check
make build
make dist
make dist-all
make smoke
make install
make uninstall
make clean
```

Outputs:

```text
dist/coplc-v0.1.0-linux-x64.tar.gz
dist/coplc-v0.1.0-linux-arm64.tar.gz
```

Installed layout:

```text
/usr/local/bin/coplc
/usr/local/share/copl/modules/
```

Standard modules are discovered from `$COPL_HOME/modules`, `$COPL_PATH`, the
installed `share/copl/modules` path, or the repository `modules/` directory when
running through Bun.

## VSCodium

The extension lives in:

```text
editors/vscodium/
```

Build and install:

```bash
make vscode
make install-vscode
```

Installed extension ID:

```text
local.copl-vscode@0.1.3
```

Open a COPL project folder and edit `.copl` files. The extension launches the
COPL language server and provides:

- syntax highlighting
- diagnostics
- hover
- go-to-definition
- references
- rename
- completion with type-aware completion kinds
- document symbols
- workspace symbols
- formatting

Server command and arguments are configurable through:

```text
copl.server.command
copl.server.args
```

## Language server

Direct stdio invocation:

```bash
coplc lsp --stdio
```

During development:

```bash
bun run src/cli.ts lsp --stdio
```

The server can be connected to any LSP client, including Kate and Vim LSP
plugins.

## Example project

```text
examples/taskboard/
```

Build and run:

```bash
bun run src/cli.ts build examples/taskboard
examples/taskboard/build/taskboard
```

It demonstrates classes, interfaces, inheritance, generics, arrays, strings,
Console I/O, variadic methods, tasks, C interop, environment defaults, and GC
finalizers.

## Standard modules

```text
modules/copl/vector.copl
modules/copl/string.copl
modules/copl/io/console.copl
```

## Documentation

- `doc/README.md`
- `doc/language/`
- `doc/project/`
- `doc/modules/`

## Testing

```bash
bun test
bun x tsc --noEmit
make check
```

## Contributing

See `CONTRIBUTING.md`.

## License

Apache License 2.0. See `LICENSE`.
