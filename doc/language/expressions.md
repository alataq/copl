# Expressions

## Literals

```copl
42
3.14
true
false
null
"text"
'a'
```

Integer literals are contextually checked against the expected integer type.
String literals have type `char[]`.

## Names and members

```copl
value
self.count
args.len
super.method()
```

`self` is available in instance methods and constructors. Static methods cannot
use `self` or `super`.

Instance attributes must be reached through `self`:

```copl
self.count = 1;
```

## Calls

Method call:

```copl
self.push(value);
vector.push(value);
Shape.area();
```

Overloaded methods are selected by argument count and argument types. A
non-variadic overload is preferred over a variadic overload when both match.

Variadic calls pass extra arguments after the fixed parameters:

```copl
self.sum(3, 10, 20, 30);
```

Extra arguments must be variadic-safe: primitives, pointers, `null`, or
`char[]`.

Static call:

```copl
C.puts(text);
```

Use the simple type name after importing its module, or a unique type name
visible from the current namespace.

Constructors are called with `new`:

```copl
Vector<int> vector = new Vector<int>();
int[] values = new int[16];
```

## Array literals

```copl
[1, 2, 3]
[...0]
[xs, ...0]
[head, ...tail]
```

- `...0` is a zero-fill marker in a sized-array initializer.
- `...expr` appends the elements of another array.
- In a sized-array initializer, an array-valued element whose element type
  matches the target may be appended directly.
- `[xs, ...0]` therefore means: append `xs`, then zero-fill the remaining
  sized-array slots.

## Unary operators

```copl
!condition
-value
+value
~bits
++counter
--counter
counter++
counter--
```

`++` and `--` require a mutable numeric target.

## Binary operators

```text
* / % + - 
< <= > >=
== !=
& ^ |
&& ||
```

Precedence follows C-like ordering:

1. `||`
2. `&&`
3. `|`
4. `^`
5. `&`
6. `==`, `!=`
7. `<`, `<=`, `>`, `>=`
8. `+`, `-`
9. `*`, `/`, `%`

Arithmetic and bitwise operands must have compatible matching types. Ordering
comparisons require numeric operands of the same type. Equality also supports
class compatibility, nullable values, arrays, and `null` comparisons.

## Ternary

```copl
condition ? a : b
```

The condition must be `bool`. Branches must have compatible types.

## Casts

```copl
int(3.5)
float(value)
ptr<void>(address)
```

Casts are explicit. Numeric-to-numeric, pointer-to-pointer, and
class-to-class casts are supported.

## Indexing

```copl
values[index]
self.data[self.length]
```

The index must be an integer. Array element types are preserved.

## Updates and assignment

```copl
value = other;
count += 1;
capacity *= 2;
items[i] = value;
```

Compound assignments require a numeric target.

## Builtin expressions

```copl
copy(value)
env("NAME")
syscall(number, args...)
```

See `builtins.md`.

## Task expressions

```copl
&work(4)        // spawn
&task           // completion probe
task            // direct use joins and returns the result
```

See `tasks.md`. Spawn expressions produce `Task<T>` handles. `&task` probes
completion without blocking, and direct value use joins. Fire-and-forget spawns
are detached.
