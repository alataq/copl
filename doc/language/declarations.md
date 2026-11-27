# Declarations

## Namespaces

```copl
namespace app {
    public class App { ... }
}

namespace copl::io {
    public extern class C { ... }
}
```

Namespaces use `::` separators.

Namespaces are optional. Classes and interfaces may be declared at the top level
of a file; they live in the root namespace. Use namespaces for libraries and
shared modules. Application/entry projects can stay top-level.

## Imports

```copl
import local.math.figures;
import copl.io;
```

- `local.*` resolves under the project `src/` directory.
- Other imports resolve under `modules/` and `$COPL_PATH`.
- Import paths use dots and map to `.copl` files.

File import cycles and duplicate top-level type names are rejected.

## Visibility

Class members require an explicit visibility:

```text
public protected internal private
```

- `public` — visible everywhere
- `protected` — visible to the class and subclasses
- `internal` — reserved for compiler, runtime, and GC internals; not for normal module helpers
- `private` — visible only inside the declaring class

Interface methods must be `public`.

## Classes

```copl
public final class App {
    private int count;

    public App() {
        self.count = 0;
    }

    public int run(int[] args) { ... }
}
```

Class modifiers:

- `final` — cannot be extended
- `extern` — C interop class with extern members

## Attributes

```copl
private int count;
public static int instances;
private final int id;
internal __gc_state;
```

Instance attributes must be accessed through `self`. Static attributes may be
accessed by name inside the class or through the class type.

`final` attributes must be initialized either at declaration or in every
constructor path.

## Methods

```copl
public int getCount() { return self.count; }
public void reset() { self.count = 0; }
public add(t value) { ... }       // implicit void return
public extern static int puts(char[] text);
```

Method modifiers:

- `final` — cannot be overridden
- `static` — no instance receiver
- `extern` — implemented by C; declared without a body

A method without an explicit return type and with a parameter list is an
implicit `void` method.

Methods may be overloaded by parameter types. Return types do not participate
in overload selection, and two methods with the same name and identical
parameter types are a compile-time error.

Methods may be C-style variadic:

```copl
public int sum(int count, ...) {
    int total = 0;
    for(int i = 0; i < count; i++) {
        total = total + va_int();
    }
    return total;
}
```

- `...` must be the final parameter
- at most one variadic parameter is allowed
- static variadic methods require at least one fixed parameter
- variadic constructors, interfaces, and worker methods are not supported yet
- variadic values are read with `va_*` builtins

Variadic arguments are currently restricted to primitives, pointers, `null`,
and `char[]`; other object references and arrays are not supported yet.

## Constructors

```copl
public App() { ... }
public Vector(Vector other) { self = copy(other); }
```

Constructors use the class name. They cannot be `static`, `final`, or `extern`.
All instance attributes must be definitely initialized before a constructor
returns.

If a class has no constructor, an implicit public no-argument constructor is
created.

## Interfaces

```copl
public interface Shape {
    public float area();
}
```

Interface methods are declarations only. A class that implements an interface
must provide compatible public instance methods.

## Inheritance

```copl
public class Circle extends Figure implements Shape { ... }
```

- A class extends at most one class.
- A class may implement multiple interfaces.
- Final classes cannot be extended.
- Final methods cannot be overridden.
- Overrides cannot reduce visibility or change parameter types.
- A subclass constructor must call `super(...)` as its first statement.
- An implicit no-argument constructor may call the base no-argument constructor
  internally.

## Internal names

`internal` members and `__`-prefixed runtime names are intended for compiler,
runtime, and GC support. They are not a replacement for a module's own private
helper classes. Use `private` for module implementation details and reserve
`internal` for runtime integration.

`__cleanup` is the GC finalizer hook. A class may declare:

```copl
internal void __cleanup() { ... }
```

The method must take no parameters and return `void`. The GC calls it for every
managed object that declares it during each collection, whether the object is
reachable or about to be swept. This lets live containers such as `Vector`
compact their internal state.

Cleanup methods should be idempotent and should not depend on finalization
ordering. They run outside the main GC lock, with recursive collection
suppressed.
