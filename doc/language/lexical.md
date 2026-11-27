# Lexical structure

## Files

COPL source files use the `.copl` extension and UTF-8 text. The lexer and parser
retain source spans; generated C user functions include `#line` directives that
point back to their COPL source locations.

## Comments

Line comments:

```copl
// comment
```

Block comments:

```copl
/* comment */
```

## Identifiers

Identifiers start with an ASCII letter or `_`, followed by ASCII letters,
digits, or `_`.

Names beginning with `__` are reserved for runtime/internal members. Such
members must be declared `internal` or `private`.

## Keywords

```text
namespace import class interface extends implements
public protected internal private final static extern
new if else switch case default for while
return break continue null true false self super
void int uint i32 u32 byte char float bool ptr
cinclude clink syscall env copy
```

## Qualified names

Namespaces and type names use `::`:

```copl
namespace copl::io { ... }
copl::io::File file;
```

Import paths use dots:

```copl
import local.math.figures;
import copl.io;
```

## Integer literals

- decimal: `42`
- hexadecimal: `0xFF`
- binary: `0b1010`
- octal: `0o755`
- underscores are allowed: `1_000`

## Floating-point literals

```copl
3.14
1.0e-3
```

## Character and string literals

```copl
'a'
'\n'
"text"
```

Supported escapes include `\n`, `\r`, `\t`, `\b`, `\f`, `\v`, `\0`, `\\`,
`\"`, `\'`, `\xNN`, and `\uNNNN`.

## Raw C blocks

`cinline` captures a balanced C block:

```copl
cinline {
    static int add(int a, int b) { return a + b; }
}
```

Strings and comments inside the block are scanned so braces in them do not
close the block.

## Punctuation

```text
{ } ( ) [ ] < > <= >= == !=
+ - ++ -- * / % & | ^ ~ !
= += -= *= /= %=
. : :: , ; ? $ ...
```
