# Statements

## Blocks and scopes

```copl
{
    int value = 1;
}
```

Locals are scoped to their block. Inner blocks may shadow outer locals.

## Variable declaration

```copl
int count = 0;
final int limit = 10;
int[] values;
t[64] data = [...0];
```

`final` locals require an initializer. Non-final locals may be declared without
one.

## Assignment

```copl
count = 1;
count += 1;
self.data[self.length] = value;
```

In a constructor, `self = copy(other)` copies all attributes into the current
instance and marks them initialized.

## If

```copl
if(condition) {
    ...
} else if(other) {
    ...
} else {
    ...
}
```

Conditions must be `bool`. Null checks narrow nullable values inside branches.

## While

```copl
while(condition) {
    ...
}
```

## For

```copl
for(int i = 0; i < values.len; i++) {
    ...
}
```

The initializer, condition, and update are optional according to the existing
parser shape.

## Switch

```copl
switch(value) {
    case 1:
        break;
    default:
        break;
}
```

Cases support integer and boolean discriminants. `break` is supported inside
switches and loops. `continue` is only valid inside loops.

## Return

```copl
return;
return value;
```

Constructors cannot return values. Non-void methods must return a value on every
path.

## Break and continue

```copl
break;
continue;
```

`break` is valid inside loops or switches. `continue` is valid inside loops.

## Environment defaults

```copl
$APP_HOME = "/tmp/app";
```

This sets the named environment variable only when it is not already set. The
value must be a `char[]`.

## Worker calls

```copl
&work(4);
&2work2(args);
```

A statement-position worker call is fire-and-forget and detaches its task handle.
Task completion probes, joins, and `Task<T>` are documented in `tasks.md`.
