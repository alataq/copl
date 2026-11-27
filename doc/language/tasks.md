# Tasks and workers

Status: task spawning, completion probes, implicit joins, fire-and-forget detach,
the general worker pool, and GC-aware task deferral are implemented.
`&NmethodName` work distribution across N threads is still a scheduling
refinement.

## Intended model

A task is an asynchronous computation started with `&`:

```copl
&work(4);
&2work2(args);
```

Spawn forms:

```text
&method(args)       // run on the general worker pool
&Nmethod(args)      // run across N dedicated worker threads
```

The general pool is sized by `defaultWorkers` or `workersEnvVar`.

## Completion probe

Applying `&` to a task handle checks completion without blocking:

```copl
&task               // bool: true when the task is complete
```

A completion probe returns `bool` and does not join the task.

## Joining

Reading the task result directly joins the main thread:

```copl
int result = task;  // blocks until the task finishes, then reads the result
```

The type model is:

```text
&method(args) -> Task<T>
&task         -> bool
use task      -> T, with an implicit join before the value is read
Task<T>       -> task handle
```

A task used only as a statement is fire-and-forget; its result is discarded and
the task handle is detached.

## Grammar distinction

The grammar distinguishes:

- `&` followed by a call: spawn a task.
- `&` followed by a task-valued expression: completion probe.

This is represented by `WorkerCallExpr` and `TaskProbeExpr`. `Task<T>` is a
built-in type. Direct value use of a task inserts an implicit join.

## Safety rules

Current checker rules for worker calls:

- the called method must exist and be accessible;
- argument count and types must match;
- arguments must be worker-safe;
- worker methods must not capture `self`.

Worker-safe values currently include primitives, pointers, arrays of safe
elements, and nullable versions of safe values. Classes are not worker-safe
arguments by default.

## Runtime direction

The current runtime provides:

- a task handle storing completion state, result storage, and the thread handle;
- a lazily initialized general worker pool sized by `defaultWorkers` or
  `workersEnvVar`;
- non-blocking completion probes through `copl_task_is_done`;
- blocking joins through `copl_task_join`;
- detached fire-and-forget execution for statement-position spawns;
- result publication synchronized through a mutex and condition variable.

GC interaction:

- task activity defers garbage collection until no tasks are active;
- task arguments therefore remain alive while the task runs;
- worker method results are restricted to non-GC values.

`&methodName` uses the general pool. `&NmethodName` currently starts one dedicated
pthread and records the requested worker count. Work distribution across N
threads is pending a concrete parallel-method model.
