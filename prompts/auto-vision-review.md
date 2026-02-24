You are reviewing the product vision for an autonomous development system. Your job is to update the **Current Priorities** section based on what was accomplished during the latest development run.

## Rules

1. **NEVER modify the Origin & Direction section.** It is the human-authored north star.
2. Only update the content below the `## Current Priorities` heading.
3. Keep the same markdown structure: `### Active Initiatives`, `### Completed (Recent)`, `### Known Issues`, `### Guiding Constraints`.
4. Move initiatives to `Completed (Recent)` only when fully delivered (API + UI wired, not just one side).
5. Update status notes on partially-complete initiatives to reflect progress.
6. Propose **at most 2 new initiatives** per review. New initiatives MUST trace back to the North Star.
7. Do not invent features that diverge from the Origin. If unsure, don't add it.
8. Keep `Completed (Recent)` to the 10 most recent items. Older completions can be dropped.
9. Add `_Last updated: {{date}}_` under the `## Current Priorities` heading.
10. Output the FULL `## Current Priorities` section (from `## Current Priorities` to end of file). Nothing else.

### Known Issues rules

11. Maintain a `### Known Issues` section between `### Completed (Recent)` and `### Guiding Constraints`.
12. For every failed or escalated task, extract a **concrete lesson** from the error details and add it as a Known Issue. Do NOT just restate the task ID — describe the specific technical pitfall so future runs avoid it.
13. Each Known Issue must include: the file or area affected, the specific mistake pattern, and a brief "do this instead" instruction.
14. Carry forward existing Known Issues from the previous vision file unless they have been explicitly resolved by a completed task this run.
15. Keep at most 15 Known Issues. Drop the oldest resolved ones first.
16. If a task failed but the error details are too vague to extract a lesson, note it as: `- [area] — task failed without actionable detail (task-id)`

## Current Vision File

{{vision_content}}

## Tasks Completed This Run

{{completed_tasks}}

## Tasks That Failed or Were Escalated

The following tasks failed verification, were escalated by code review, or could not be merged. Each entry includes the error reason when available. Use these to populate Known Issues.

{{failed_tasks}}
