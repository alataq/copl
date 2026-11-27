# Types

## Primitive types

| COPL | Meaning |
| --- | --- |
| `int` | signed 64-bit integer (`int64_t`) |
| `uint` | unsigned 64-bit integer (`uint64_t`) |
| `i32` | signed 32-bit integer (`int32_t`) |
| `u32` | unsigned 32-bit integer (`uint32_t`) |
| `byte` | unsigned 8-bit integer |
| `char` | character / byte-sized character value |
| `float` | floating point (`double`) |
| `bool` | boolean |
| `void` | no value; only valid as a return type |

Primitive conversions are explicit. There are no implicit primitive
conversions.

## Class and interface types

```copl
File file;
Shape shape;
```

A class type is a non-null reference to a class instance. Interface types are
implemented by classes. Interface method calls use generated dispatch based on
the concrete object's type ID.

## Arrays

Array:

```copl
int[] values;
```

Sized array type:

```copl
int[16] buffer;
t[64] data;
```

The size expression may be a runtime expression in a local declaration:

```copl
t[self.capacity * 2] data = [self.data, ...0];
```

Arrays have a fixed length once created. They support bounds-checked indexing and
the read-only `.len` member. There is no built-in push/pop/grow operation;
dynamic growth belongs to the `Vector` module.

See `arrays.md`.

## Nullable types

```copl
Box? maybeBox;
Shape? maybeShape;
Box[]? maybeBoxes;
```

`T?` is for nullable object references and array references. Primitive types
and raw pointers are not nullable. `null` is only assignable to nullable types.
Member access, method calls, and indexing on nullable values require a null
check.

Implemented narrowing covers simple checks such as:

```copl
if(box != null) {
    return box.value;
}
```

Short-circuit narrowing is supported:

```copl
if(box != null && box.value > 0) {
    return box.value;
}
```

## Pointer types

```copl
ptr raw;
ptr<int> intPointer;
ptr<void> opaquePointer;
```

`ptr<void>` is accepted for C interop.

## Generic types

```copl
Vector<int>
Map<char[], Box>
```

Generic classes declare type parameters:

```copl
public class Vector<t> {
    private t[] data;
}
```

The sema checker performs generic substitution. C11 generation monomorphizes
used generic instantiations.

A generic class may refer to itself with the raw class name as shorthand for
its own type parameters:

```copl
public Vector(Vector vector) { ... }
```

Other raw uses of a generic class require explicit type arguments.

## Task types

```copl
Task<int> job;
Task<void> cleanup;
```

`Task<T>` is the built-in task handle type. Using a task directly in a value
context joins it and yields `T`; `&task` probes completion and yields `bool`.

## Meta types

A class name used as an expression has a meta type for static member access:

```copl
copl::io::C.puts(text);
```
