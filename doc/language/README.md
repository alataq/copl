# Language reference

COPL is a statically typed, class-based language with explicit visibility,
mandatory `self`, null safety, and C interop.

Programs contain namespaces with classes and interfaces. There are no free
functions, global mutable variables, or standalone structs. The official
compiler targets Linux and emits C11.

## Documents

- `lexical.md` — source text, identifiers, keywords, comments, literals
- `types.md` — primitive, class, array, pointer, nullable, and generic types
- `declarations.md` — namespaces, imports, classes, interfaces, members
- `expressions.md` — operators, calls, construction, casts, updates
- `statements.md` — variables, control flow, returns, environment defaults
- `arrays.md` — arrays, sized arrays, literals, fills, spreads, `copy`
- `tasks.md` — task spawn, completion probes, joins, worker counts
- `c-interop.md` — `cinclude`, `clink`, `cinline`, extern classes
- `builtins.md` — `copy`, `env`, `syscall`, and `$NAME` defaults
- `semantic-rules.md` — visibility, `self`, initialization, null safety,
  overrides, worker safety

## Status marking

Documents describe implemented behavior unless they explicitly say
"planned" or "current placeholder".

Code generation details and backend limitations are documented in
`../project/codegen.md`.
