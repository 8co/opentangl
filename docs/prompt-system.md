# Prompt System

## Overview

Prompts are the input to AI agents. The system supports pre-generated prompt templates with dynamic variable injection.

## Prompt Template Structure

```
prompts/
├── templates/           # Reusable prompt templates
│   ├── plan-feature.md
│   ├── implement.md
│   ├── write-tests.md
│   ├── code-review.md
│   └── refactor.md
├── context/             # Project context files
│   ├── project-info.md
│   ├── conventions.md
│   └── dependencies.md
└── workflows/           # Workflow-specific prompt chains
    ├── new-feature.yaml
    ├── bug-fix.yaml
    └── refactor.yaml
```

## Variable Injection

Templates support variables resolved at runtime:

```markdown
# Task: Implement {{feature_name}}

## Context
- Project: {{project_name}}
- Target directory: {{target_dir}}
- Related files: {{related_files}}

## Requirements
{{requirements}}

## Constraints
- Follow conventions in AGENTS.MD
- Match existing patterns in {{target_dir}}
```

## Context Loading

Before each prompt is sent, the system:

1. Reads the project's AGENTS.MD
2. Loads relevant docs from the project's docs/ folder
3. Injects file contents from specified paths
4. Resolves all template variables

## Prompt Chaining

Prompts can reference output from previous steps:

```yaml
- id: plan
  prompt: prompts/plan-feature.md
  output: docs/plan.md

- id: implement
  prompt: prompts/implement.md
  context:
    - "{{steps.plan.output}}"  # Injects the plan output
```

