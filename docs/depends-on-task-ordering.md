# `depends_on` — Cross-Project Task Ordering

## Problem

The scheduler runs all pending tasks sequentially, then batch-merges successful branches at the end. This breaks when a UI task depends on an API change that hasn't been merged yet. The UI code compiles (reference context gives it the API contract) but deploys against a main branch missing the new endpoint.

## Solution

Add a `depends_on` field to tasks. The scheduler checks dependencies before picking the next task and interleaves merging so dependent tasks only run after their prerequisites are on main.

## Task Format

```yaml
- id: add-search-endpoint
  type: feature
  project: my-api
  prompt: prompts/auto-implement.md
  variables:
    feature_name: "search endpoint"
    feature_description: >
      Add GET /search endpoint returning paginated results by query.

- id: build-search-page
  type: feature
  project: my-frontend
  depends_on:
    - add-search-endpoint
  prompt: prompts/auto-implement.md
  variables:
    feature_name: "search page"
    feature_description: >
      Build search page calling GET /search with filters and pagination.
```

`depends_on` is an array of task IDs. All referenced tasks must reach `status: completed` + `merge_status: merged` before the dependent task is eligible for execution.

## Execution Flow

```
Proposer scans API + UI codebases
  → Proposes: add-endpoint (API), build-page (UI, depends_on: add-endpoint)
  → Both queued as pending

Scheduler loop:
  1. queue.next() → add-endpoint (build-page is blocked)
  2. Execute add-endpoint on my-api → success
  3. Detects dependents waiting → merge add-endpoint immediately
     → Push, PR, CI, merge to main
  4. queue.next() → build-page (now unblocked, API on main)
  5. Execute build-page on my-frontend → success
  6. No dependents → deferred to batch merge
  7. Batch merge remaining branches
```

## Files Changed

### 1. `src/queue-manager.ts` — Type + Dependency Check

Add `depends_on` to `QueueTask`:

```typescript
export interface QueueTask {
  // ... existing fields ...
  depends_on?: string[];  // Task IDs that must be completed+merged first
}
```

Make `next()` dependency-aware. A task is eligible only if every task in its `depends_on` array has `status: 'completed'` and `merge_status: 'merged'`. If a dependency is `failed` or `escalated`, the dependent task is auto-skipped.

New methods:
- `areDependenciesMet(taskId)` — checks if all deps are satisfied
- `skipBlockedTasks()` — marks tasks blocked by failed deps as `skipped`
- `getDependents(taskId)` — returns tasks that depend on a given task ID

### 2. `src/scheduler.ts` — Interleaved Merge

The current `loop()` flow:
```
run all tasks → batch merge all branches
```

New flow:
```
while (pending tasks exist):
  task = queue.next()          // dependency-aware
  result = runTask(task)
  if result.success:
    dependents = queue.getDependents(task.id)
    if dependents.length > 0:
      merge task immediately    // so dependents can run next iteration
    else:
      defer to batch merge
```

The batch merge at the end still handles tasks with no dependents.

### 3. `src/merge-pipeline.ts` — Expose Single-Branch Merge

The existing `processBranch()` is private. Expose it (or add a `mergeSingle()` wrapper) so the scheduler can merge one branch inline without running the full batch pipeline.

### 4. `src/task-proposer.ts` — Pass Through

Add `depends_on` to `ProposedTask`, pass it to `QueueTask` in `proposeAndQueue()`.

### 5. `prompts/auto-propose-tasks.md` — Teach the LLM

Add `depends_on` to the prompt format and instruct the LLM:
- When proposing an API task and a related UI task, the UI task must `depends_on` the API task
- Same-project tasks that must run in order should also use `depends_on`
- Only reference task IDs from the same proposal batch or existing queue

## Edge Cases

### Cascading Failure
If task A fails, all tasks with `depends_on: [A]` are auto-skipped with reason `"dependency failed: A"`. Transitive — if B depends on A and C depends on B, both B and C are skipped.

### Merge Failure / Escalation
If task A succeeds but merge is escalated (unresolvable conflicts, CI stuck), dependents are also skipped. Reason: `"dependency merge escalated: A"`.

### Circular Dependencies
Validated at queue insertion time. If adding task C with `depends_on: [B]` and B has `depends_on: [C]`, reject with error. Simple cycle detection via DFS.

### Cross-Batch Dependencies
Task proposed in batch N depends on something from batch N-1 that hasn't merged yet. Works naturally — `next()` checks `merge_status` on every call, so it waits until the earlier task is fully merged.

### Orphaned Dependencies
`depends_on` references a task ID that doesn't exist in the queue. Treated as unmet — task stays pending indefinitely. The `print()` summary should flag these as warnings.

## Not in Scope

- **Parallel execution** — tasks still run sequentially. `depends_on` is about ordering, not parallelism.
- **Cross-project writes** — still read-only reference context. The LLM proposes separate tasks per project.
- **Deploy coordination** — merging to main triggers CI/CD. Deploy ordering relies on the merge order being correct (API merged first).
