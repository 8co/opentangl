# Cross-Project Context & Future Multi-Project Writes

## Current State: Read-Only Reference Context

The orchestrator supports `reference_context` in `projects.yaml`, allowing any project to pull read-only file context from another project. The LLM sees the referenced files but cannot modify them.

### Configuration

```yaml
# projects.yaml
- id: my-frontend
  reference_context:
    - project: my-api                  # project ID from this same file
      label: "Backend API (Serverless)" # human-readable label for the LLM
      files:
        - src/handlers/users.js
        - src/models/users.js
```

### Where it's injected

- **Task proposer** — appended after the codebase summary so the LLM proposes tasks that align with the actual API contract.
- **Autonomous runner** — appended to the implementation prompt so the LLM writes code that matches real API response shapes.

### Key files

- `src/project-registry.ts` — `ReferenceContext` interface, `reference_context` field on `ProjectConfig`
- `src/file-writer.ts` — `buildReferenceContext()` resolves files from referenced projects via the registry
- `src/task-proposer.ts` — injects reference context into proposal prompts
- `src/autonomous-runner.ts` — injects reference context into implementation prompts
- `src/scheduler.ts` — builds reference context in `taskToWorkflow()`, passes it as a step variable

## Why Cross-Project Writes Don't Work Yet

If the LLM tries to write files to a referenced project, these things break:

1. **File writer safety** — `writeFiles()` rejects writes outside `target_dir`. Path traversal is blocked by design.
2. **Git is scoped to one repo** — branch, commit, revert all operate on the target project. Changes to another repo would be uncommitted dirty state.
3. **Verification is single-project** — `npm run build` only runs in the target. No validation of the other project.
4. **PRs are per-repo** — GitHub doesn't support cross-repo PRs.
5. **No deployment atomicity** — if UI depends on an API change, nothing coordinates deploy order.

## Recommended Path Forward

The read-only reference approach is the right pattern for now. The LLM sees the API contract, builds the UI to match it, and if it needs an API change, the proposer flags it as a separate task for the API project. Two independent tasks, two PRs, two deploys — ordered correctly.

### Next step: `depends_on` for task ordering

Add a `depends_on` field to tasks so the orchestrator knows "deploy API task X before UI task Y." This is a much smaller lift than full cross-project writes and gets 90% of the value.

```yaml
# Hypothetical task with dependency
- id: update-dashboard-ui
  project: my-frontend
  depends_on:
    - id: add-users-v2-endpoint
      project: my-api
```

The orchestrator would:
1. Run the API task first (branch, implement, verify, merge)
2. Deploy the API (or wait for CI/CD)
3. Then run the UI task with confidence the new endpoint exists

### Full cross-project writes (if ever needed)

Would require:
- Multi-project task type that spawns linked branches in each affected repo
- Verification across all affected projects
- Deployment coordinator (API before UI)
- Linked PRs or a monorepo migration

This is the same problem Google solved with monorepos and Meta solved with custom cross-repo tooling. Not worth building unless the number of tightly-coupled cross-project changes becomes a bottleneck.
