# `std::String`

## Purpose

Immutable UTF-8-agnostic character sequence backed by `std::Vector<char>`.

The public API never exposes the backing vector. Operations that change content
return a new `String`.

## Import

```copl
import copl.string;
```

## Constructors

```copl
new String()
new String(char value)
new String(char[] value)
new String(String other)
```

## Queries

```copl
getLength(): int
isEmpty(): bool
charAt(int index): char
toArray(): char[]
```

`toArray()` returns exactly the logical string length, not Vector capacity.
`charAt()` is bounds-checked through the backing Vector.

## Equality

```copl
equals(char value): bool
equals(char[] value): bool
equals(String other): bool
```

Equality compares logical length and characters, not backing capacity.

## Concatenation

```copl
concat(char value): String
concat(char[] value): String
concat(String value): String
```

Each returns a new `String`.

## Slicing

```copl
substring(int start, int end): String
```

Returns characters in `[start, end)`.

## Formatting

```copl
String.format(char[] format, ...): String
```

Supported specifiers:

- `%%` literal percent
- `%d` for `int`
- `%u` for `uint`
- `%f` for `float`, six decimal places
- `%c` for `char`
- `%b` for `bool`
- `%s` for `char[]`

`%s` accepts `char[]`. Convert a `String` with `toArray()` before passing it.
Unknown specifiers are preserved literally. This is true variadic formatting;
multiple placeholders consume multiple arguments in order.

## Parsing

```copl
toInt(): int
toFloat(): float
```

- optional leading `+` or `-`
- decimal digits
- `toFloat()` also accepts one decimal point
- no whitespace trimming
- no exponent notation
- malformed input returns `0`
- overflow is not reported

## Example

```copl
String name = new String("COPL");
String message = String.format("hello %s", name);
Console.println(message);
```

## Runtime notes

- content is GC-managed through `std::Vector<char>`
- immutable after construction through the public API
- `format` helpers are private static methods
