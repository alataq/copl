# C interop

## Includes

```copl
cinclude "stdio.h";
```

Emits an include for the named C header.

## Linker flags

```copl
clink "-lm";
```

Adds a linker flag during `build`.

## Inline C

```copl
cinline {
    static int copl_double(int x) { return x * 2; }
}
```

Inline C is emitted verbatim into the generated translation unit.

## Extern classes

```copl
namespace copl::io {
    public extern class C {
        public extern static int puts(char[] text);
        public extern static int printf(char[] format);
    }
}
```

Extern classes describe C functions. Extern methods have no COPL body.

Current rules:

- extern classes cannot declare attributes;
- extern classes cannot have constructors;
- extern classes cannot extend or implement;
- methods of an extern class must be extern;
- extern methods cannot have a body;
- non-extern classes may still declare `extern static` methods.

## C types

Current C11 mapping direction:

- `int` → `int64_t`
- `uint` → `uint64_t`
- `i32` → `int32_t`
- `u32` → `uint32_t`
- `byte` → `uint8_t`
- `char` → `char`
- `float` → `double`
- `bool` → `bool`
- `void` → `void`
- `ptr<T>` → pointer type
- `ptr<void>` → `void*`
- fixed-length arrays → runtime array struct inside COPL, with `.data` passed to C functions
- class types → pointers to generated structs

Extern C declarations should generally be provided by `cinclude`; generated
call sites use the declared C function name directly.
