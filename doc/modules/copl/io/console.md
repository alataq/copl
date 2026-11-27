# `io::Console`

## Purpose

Terminal input and output.

## Import

```copl
import copl.io.console;
```

## Output

```copl
print(char value)
print(char[] text)
print(std::String text)

println()
println(char value)
println(char[] text)
println(std::String text)
```

`print` writes without an appended newline. `println` appends one.

## Formatted output

```copl
printf(char[] format, ...)
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
Multiple placeholders consume multiple arguments in order.

## Flush and clear

```copl
flush()
clear()
```

- `flush()` flushes standard output.
- `clear()` writes ANSI clear-screen and cursor-home sequences and flushes.

`clear()` is terminal-specific.

## Input

```copl
read(): int
readLine(): std::String?
```

- `read()` returns one character code, or `-1` on EOF.
- `readLine()` returns:
  - `null` if EOF occurs before any character
  - an empty `String` for a blank line
  - the line contents otherwise
- carriage returns are ignored by `readLine()`
- there is no ambiguous `readChar(): char`

## Example

```copl
Console.printf("name: %s\n", name);
String? line = Console.readLine();
if(line != null) {
    Console.println(line);
}
```

## Runtime notes

- output uses `fwrite` for arrays and `fputc` for single characters
- input uses `getchar`
- C helpers are declared in a private extern class
- no true `scanf` exists yet; use `read()`/`readLine()` plus `String.toInt()` or
  `String.toFloat()`
