# Roadmap

## Phase 1: CLI Foundation
- [ ] Core orchestration engine (workflow runner)
- [ ] Prompt template system with variable injection
- [ ] Local file-based state management
- [ ] CLI interface for manual workflow execution
- [ ] Single agent adapter (Cursor)

## Phase 2: Scheduling & State
- [ ] DynamoDB state management
- [ ] EventBridge scheduler integration
- [ ] Retry logic and failure recovery
- [ ] Execution history and logging
- [ ] Workflow resume from checkpoint

## Phase 3: Multi-Agent Support
- [ ] Codex CLI adapter
- [ ] Copilot adapter
- [ ] Agent selection strategy (per-task routing)
- [ ] Cross-agent workflow handoff

## Phase 4: AWS Deployment
- [ ] Lambda handlers for orchestration
- [ ] API Gateway for manual triggers
- [ ] S3 for prompt storage
- [ ] CloudWatch monitoring and alerts
- [ ] SST infrastructure-as-code

## Phase 5: Advanced Workflows
- [ ] Parallel step execution
- [ ] Conditional branching
- [ ] Workflow composition (nested workflows)
- [ ] Result validation and quality gates
- [ ] Notification system (Slack, email)

