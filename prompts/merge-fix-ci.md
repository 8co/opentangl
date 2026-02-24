You are fixing CI/build failures for an automated merge pipeline.

## Context
- Project: {{project_name}}
- Branch: {{branch_name}}
- Target: {{target_branch}}
- Task: {{task_description}}

## CI Failure Output

The following checks failed when trying to merge this branch:

{{ci_errors}}

## Current File Contents

{{file_context}}

## Instructions

Fix ALL errors shown in the CI output. The code must compile and pass all checks.

Rules:
1. Fix every error — don't leave any unresolved
2. Don't change the intent of the code — only fix the specific errors
3. If a type error occurs, fix the type, don't suppress it with `any`
4. If an import is missing, add it
5. If a test is failing, fix the code (not the test) unless the test itself is wrong
6. Output only the files that need changes

## Output Format

For each file that needs to be fixed, output:

```language:path/to/file.ext
// complete fixed file content
```

Only include files that actually need changes. Output the COMPLETE file, not just the changed lines.
