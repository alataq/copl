# COPL documentation

This directory documents the language and toolchain as implemented.

## Layout

- `language/` — language reference, organized by feature area
- `project/` — manifest, CLI, LSP, distribution, build, code generation, and checking behavior
- `modules/` — conventions and index for module documentation

## Status

| Area | Status |
| --- | --- |
| Lexer and parser | Implemented |
| Import resolution and manifest loading | Implemented |
| Semantic/type checking | Implemented for the current language surface |
| CLI | Checks, build, emit-c, run, clean, init, version, LSP |
| C11 code generation | Initial backend implemented |
| Tasks and worker runtime | General pool + spawn/probe/join; GC-aware task deferral |
| Garbage collection | Precise mark-and-sweep with finalizers |
| LSP | stdio server with diagnostics and navigation |

## Language reference

See `language/README.md` for the organized language documentation index.
