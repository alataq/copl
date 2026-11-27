# Contributing to COPL

Thanks for helping improve COPL.

COPL is under active v0.x development. Language rules, generated C, runtime ABI,
module APIs, CLI flags, and editor integrations may change between minor
versions.

## Development setup

Requirements:

- Linux x86_64 or aarch64
- Bun
- A C11 compiler (`cc`, `gcc`, or `clang`)

Install dependencies and run checks:

```bash
bun install
bun test
bunx tsc --noEmit
```

Or:

```bash
make check
```

## Useful commands

```bash
make build
make smoke
make dist
make vscode
```

## Project layout

```text
src/lexer/       lexer and tokens
src/parser/      parser and AST construction
src/resolver.ts  file import resolution
src/sema/        semantic analysis and type checking
src/codegen/     C11 code generation and runtime
src/lsp/         language server
src/cli.ts       command-line interface
modules/         standard modules
examples/        example projects
tests/           automated tests
doc/             language and project documentation
```

## Language changes

When changing the language, update all affected layers:

1. lexer/tokens if new syntax is required
2. AST
3. parser
4. semantic checker
5. C11 code generator and runtime
6. CLI/LSP diagnostics or completion if relevant
7. docs under `doc/`
8. tests

Prefer small, complete changes over partial syntax support.

## Code style

- TypeScript strict mode must pass.
- Match existing formatting and naming.
- Keep generated artifacts out of commits.
- Add tests for new language behavior and codegen paths.
- Do not commit `build/`, `dist/`, `node_modules/`, VSIX files, tarballs, or
  compiled binaries.
- Run `bun test` and `bunx tsc --noEmit` before opening a pull request.

## Standard modules

Module docs live under `doc/modules/` using the module path.

Example:

```text
modules/copl/string.copl -> doc/modules/copl/string.md
```

## Generated code

C output must be deterministic. If codegen changes, verify the generated output
still compiles and existing smoke/example projects still run.

## Pull requests

Include:

- what changed
- why it changed
- affected language/runtime behavior
- tests run
- documentation updates

## License

By contributing, you agree that your contributions are licensed under the
Apache License 2.0. See `LICENSE`.
