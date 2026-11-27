# TaskBoard

Growing COPL example project.

## Build and run

From the repository root:

```bash
bun run src/cli.ts build examples/taskboard --copl-path modules && examples/taskboard/build/taskboard
```

## Commands

```text
add <priority> <title>
list
done <id>
remove <id>
stats
worker
gc
help
exit
```

## Features covered

- classes, inheritance, interfaces
- generics and monomorphization
- `std::Vector`, `std::String`
- `io::Console`, `println`, `printf`, `readLine`
- nullable `String?`
- String parsing and formatting
- bounded arrays
- C-style variadic `Stats.sumPriorities`
- background tasks through `runBackgroundScore`
- GC stress via the `gc` command
- GC-triggered `__cleanup` on `GcProbe`
- C interop through `getpid`
- environment defaults with `$TASKBOARD_DATA`

## Example session

```text
add 5 Buy milk
add 2 Write docs
list
done 1
stats
worker
gc
help
exit
```
