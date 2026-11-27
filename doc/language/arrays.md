# Arrays

## Types

```copl
int[] array;
int[16] fixedSizedArray;
t[64] genericBuffer;
```

`T[]` is an array whose length is fixed when it is created. It is not a
growable container. Dynamically growing collections are implemented by the
`Vector` module.

`T[N]` carries a size expression. In local declarations the size may be
computed at runtime:

```copl
t[self.capacity * 2] data = [self.data, ...0];
```

## Allocation

```copl
int[] values = new int[16];
Vector<int> vector = new Vector<int>();
```

`new T[N]` allocates a zero-initialized, GC-managed array of `N` elements.

## Length

```copl
args.len
self.data.len
```

`.len` is a read-only integer.

## Indexing

```copl
values[index]
self.data[self.length] = value;
```

Indexes must be integers. Array indexing is bounds-checked at runtime. An
out-of-range index aborts the program with a runtime error.

## Literals

```copl
[1, 2, 3]
[...0]
[xs, ...0]
[head, ...tail]
```

### Zero fill

`...0` fills the remaining slots of a sized array with zero bytes.

```copl
t[64] data = [...0];
```

### Spread

`...expr` appends elements from another array.

```copl
int[] combined = [first, ...second];
```

### Sized-array append shorthand

In a sized-array initializer, an array value whose element type matches the
target element type is appended:

```copl
t[self.capacity * 2] data = [self.data, ...0];
```

This is equivalent to appending `self.data` and then zero-filling the remaining
capacity.

## Copy

`copy(array)` makes a fresh copy of the array storage.

```copl
return copy(self.data);
```

Array storage is GC-managed. Arrays of concrete class references and arrays of
arrays are deep-copied by generated copy helpers.

## Current limits

- Zero fill currently recognizes the literal `...0`.
- Bounds checks happen at runtime; there is no compile-time range analysis.
- Arrays do not resize. `Vector` replaces its backing array when it grows.
- Exact sized-array length is enforced by runtime filling, not a distinct
  semantic type.
