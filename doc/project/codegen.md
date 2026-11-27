# C11 code generation

## Output shape

`coplc emit-c` prints a single C11 translation unit. `coplc build` writes
`build/<project-name>.c`, compiles it, and writes `build/<project-name>`. If the
manifest has no `name`, the entry name is used.

Generated code contains:

1. POSIX/feature defines and standard includes
2. user `cinclude` headers
3. the COPL runtime support block
4. user `cinline` blocks
5. forward typedefs for generated classes
6. class structs
7. static field globals
8. function prototypes
9. constructors, methods, copy helpers, static initializers
10. generated `main`

## Value representation

- `int` maps to `int64_t`, `uint` to `uint64_t`, `i32`/`u32` to 32-bit types,
  `byte` to `uint8_t`, `char` to `char`, and `float` to `double`
- class values are pointers to heap-allocated structs
- nullable class values use the same pointer representation with `NULL`
- arrays are fixed-length `copl_array` structs containing GC-managed data,
  length, and element size; indexing is bounds-checked
- strings are `char[]` arrays backed by string literal storage
- pointers map to C pointers
- interface values are `void*` pointers to objects with a leading type ID
- generated interface dispatchers switch on the type ID and call the concrete
  implementation

## Generic classes

Used generic classes are monomorphized. Instances are discovered from
non-generic roots and emitted with mangled names such as:

```text
copl_app__Vector_int
```

Methods and constructors are emitted per used instantiation. Overloaded
methods are emitted with signature-mangled C names.

C-style variadic methods emit real C variadic functions:

```c
Ret method(Self* self, Fixed args..., ...);
```

The body declares `va_list` and uses `va_start`/`va_end`. COPL `va_*` builtins
map to `va_arg` with the matching promoted C type. Frozen restrictions:

- variadic constructors are not emitted yet
- variadic interfaces are not emitted yet
- variadic worker methods are not emitted yet

## Constructors and initialization

Generated constructors:

1. zero the instance
2. call the base constructor
3. write the concrete type ID
4. run attribute initializers
5. run the constructor body

`self = copy(other)` uses the generated `copy_into` helper.

## Copying

Per-class helpers are generated:

```text
Class__copy_into(dst, src)
Class__copy(src)
```

Class copy recursively copies base state, arrays, and class-valued attributes.
Arrays of concrete class references and arrays of arrays are deep-copied.

## Entry point

The generated `main` selects a class from the entry file:

1. a class with a `main` method
2. a class named `App` with a `run` method
3. the first class with a `run` method
4. the first class in the entry file

For a supported entry method, `main` constructs the entry object when the
method is not static, builds an `int[]` from `argc`/`argv` when needed, calls the
method, and returns its integer result.

## Runtime support

The initial runtime provides:

- fixed-length array allocation, copy, equality, length, and bounds checks
- object type IDs for interface dispatch
- precise mark-and-sweep GC headers, type descriptors, and trace functions
- generated GC cleanup hooks for classes with `internal void __cleanup()`
- cleanup hooks run for live and dead managed objects before sweep
- shadow-stack roots for locals, parameters, `self`, and static fields
- statement safepoints for collection
- pthread-backed task spawn, general worker pool, completion probes, joins, and detach
- string literal and C-string conversion helpers
- environment lookup and defaults
- `argc`/`argv` conversion
- array literal builders with append and zero-fill

Class objects and array storage are allocated through the GC heap. Collection
uses generated per-class and per-array trace functions, a shadow stack, and
static roots. Collection is deferred while tasks are active.

Generated user methods and constructors include C `#line` directives pointing
back to their COPL source locations.

## Linker flags

`clink` directives and manifest `linkerFlags` are passed to the C compiler.

## Current limitations

- Dedicated `&NmethodName` work distribution across N threads is not implemented.
- GC collection is deferred while any task is active.
- There are no finalizers or explicit GC control primitives.
- Task results are limited to non-GC values.
- Extern C function declarations are expected from `cinclude` headers.
- Multiple semantic diagnostics and codegen diagnostics are not aggregated.
