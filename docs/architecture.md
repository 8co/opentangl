# Architecture

## System Overview

```
┌─────────────────────────────────────────────────────┐
│                   Scheduler Layer                    │
│          (EventBridge / Cron / Manual CLI)           │
└──────────────────────┬──────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────┐
│               Orchestration Engine                   │
│                                                     │
│  ┌──────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │ Workflow  │  │    Prompt    │  │    State      │  │
│  │ Manager  │──│  Resolver    │──│   Manager     │  │
│  └──────────┘  └──────────────┘  └──────────────┘  │
└──────────────────────┬──────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────┐
│                  Agent Adapters                      │
│                                                     │
│  ┌──────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │  Cursor  │  │   Copilot    │  │    Codex     │  │
│  │ Adapter  │  │   Adapter    │  │   Adapter    │  │
│  └──────────┘  └──────────────┘  └──────────────┘  │
└──────────────────────┬──────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────┐
│                  Storage Layer                       │
│                                                     │
│  ┌──────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │ DynamoDB │  │      S3      │  │  CloudWatch  │  │
│  │  State   │  │   Prompts    │  │    Logs      │  │
│  └──────────┘  └──────────────┘  └──────────────┘  │
└─────────────────────────────────────────────────────┘
```

## Core Components

### Scheduler Layer
Triggers workflows on a schedule or on-demand via CLI. EventBridge for production, CLI for development and testing.

### Orchestration Engine
- **Workflow Manager** — Reads workflow definitions, determines execution order, handles branching
- **Prompt Resolver** — Loads prompt templates, injects context variables, resolves dependencies
- **State Manager** — Tracks workflow progress, handles retries, manages checkpoints

### Agent Adapters
Uniform interface to different AI coding agents. Each adapter translates workflow tasks into agent-specific API calls.

### Storage Layer
- **DynamoDB** — Workflow state, execution history, task results
- **S3** — Prompt templates, generated artifacts, logs
- **CloudWatch** — Monitoring, alerting, execution metrics

## Data Flow

1. Scheduler triggers a workflow
2. Orchestration engine loads workflow definition
3. Prompt resolver builds the prompt from template + context
4. Agent adapter sends prompt to selected AI agent
5. Result is captured, validated, stored
6. State manager advances workflow to next step
7. Repeat until workflow completes or fails

## Workflow Definition

Workflows are defined as JSON/YAML configs:

```yaml
name: feature-implementation
steps:
  - id: plan
    agent: cursor
    prompt: prompts/plan-feature.md
    output: docs/plan.md
  - id: implement
    agent: cursor
    prompt: prompts/implement.md
    depends_on: plan
  - id: test
    agent: cursor
    prompt: prompts/write-tests.md
    depends_on: implement
  - id: review
    agent: codex
    prompt: prompts/code-review.md
    depends_on: test
```

## Failure Handling

- Each step supports configurable retry count and backoff
- Failed steps can be resumed from last checkpoint
- Workflow state persists across restarts
- Dead letter queue for permanently failed tasks

