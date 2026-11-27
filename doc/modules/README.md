# Module documentation

Module docs live under `doc/modules/`.

## Convention

Use the module namespace path as the documentation path:

```text
modules/copl/vector.copl        -> doc/modules/copl/vector.md
modules/copl/string.copl        -> doc/modules/copl/string.md
modules/copl/io/console.copl    -> doc/modules/copl/io/console.md
```

## Current module docs

- `copl/string` — `copl/string.md`
- `copl/io/console` — `copl/io/console.md`

## Suggested structure

```markdown
# Module name

## Purpose

What the module provides.

## Import

```copl
import copl.module;
```

## Types

Public classes, interfaces, and generics.

## API

Public methods and attributes, with signatures and behavior.

## Internal state

Runtime/internal fields and `__` hooks.

## Notes

Limitations, ownership, GC behavior, and thread safety.
```

## Rules

- Document public behavior, not private implementation details, unless the
  module is runtime-internal.
- Mark planned or incomplete behavior explicitly.
- Keep module docs aligned with the source file's namespace and relative path.
