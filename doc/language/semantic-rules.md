# Semantic rules

## Mandatory visibility

Every class member must declare one of:

```text
public protected internal private
```

Interface methods must be public.

## Mandatory `self`

Instance attributes are accessed through `self`:

```copl
self.count = 0;
return self.count;
```

A bare instance attribute name in a method body is an error.

Static attributes may be accessed by name inside the class or through the class
type.

## No implicit primitive conversions

Primitive types do not convert implicitly. Use an explicit cast:

```copl
int(3.5)
```

Integer literals are checked against the expected integer type.

## Strict conditions

Conditions in `if`, `while`, `for`, ternary expressions, `!`, `&&`, and `||`
must be `bool`.

## Null safety

`null` is only assignable to nullable types. Accessing members or methods on a
nullable value requires narrowing:

```copl
if(box != null) {
    return box.value;
}
```

Simple and short-circuit null checks are supported. Full flow-sensitive
narrowing is limited.

## Definite initialization

All non-static attributes must be initialized before a constructor returns.

- initializers at declaration count;
- assignments to `self.field` count;
- `self = copy(other)` marks all attributes initialized;
- implicit constructors are checked as well.

Final attributes cannot be reassigned after initialization.

## Constructors and inheritance

A subclass constructor must call `super(...)` first. The superclass must provide
a matching constructor.

## Visibility and override rules

- private members are accessible only in the declaring class;
- protected members are accessible in subclasses;
- internal members are reserved for compiler/runtime/GC integration;
- overloads must have distinct parameter type lists;
- variadic methods may have at most one final `...`;
- variadic arguments are limited to primitives, pointers, `null`, and `char[]`;
- overrides cannot reduce visibility;
- final methods cannot be overridden;
- static and instance methods cannot override each other;
- interface implementations must be public instance methods.

## Generics

The checker substitutes generic type parameters for inheritance, fields,
methods, constructors, and expression types.

Final class instantiation and monomorphization belong to C11 generation.

## Worker safety

Worker/task calls currently require:

- a known accessible method;
- matching argument count and types;
- worker-safe argument types;
- no `self` capture in the worker method body;
- non-GC result types (void, primitive, or pointer).

## Failure mode

The current checker reports the first semantic error (`fail-fast`). Multiple
diagnostics and error recovery are future work.
