# Builtins

## `copy(value)`

Creates a copy with the same type as `value`.

Intended semantics:

- primitives and pointers copy by value;
- arrays copy their storage;
- class objects copy their managed object state;
- `null` remains `null`.

The current semantic checker preserves the argument type. C11 generation is
being added.

## `env(name)`

Reads an environment variable.

```copl
char[] home = env("APP_HOME");
```

`env` accepts zero or one argument and returns `char[]`.

## `syscall(number, ...)`

Invokes a system call.

```copl
syscall(1, 2, 3);
```

Arguments must be integers or pointers. The result type is `int`.

This is intentionally low-level and only valid on supported Linux targets.

## Variadic access

Inside a C-style variadic method, read the next argument with one of:

```copl
va_int()     // int
va_i32()     // i32
va_u32()     // u32
va_uint()    // uint
va_float()   // float
va_bool()    // bool
va_char()    // char
va_ptr()          // ptr
va_char_array()   // char[]
```

These builtins take no arguments and are only valid inside a variadic method.
They follow C default argument promotions.

## `$NAME = value`

Sets an environment variable only if it is not already present.

```copl
$APP_HOME = "/tmp/app";
```

The value must be `char[]`.

## Runtime/internal hooks

Names beginning with `__` are reserved for runtime support. `__cleanup` is the
GC cleanup hook: it takes no parameters, returns `void`, and is called for both
live and unreachable managed objects during collection.

Such members must be declared `internal` or `private`.
