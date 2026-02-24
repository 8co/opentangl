/**
 * Core type definitions for the orchestration system
 */

// --- Workflow Definition Types ---

export type AgentType = 'cursor' | 'codex' | 'copilot' | 'anthropic' | 'openai';

export type StepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

export type WorkflowStatus = 'pending' | 'running' | 'completed' | 'failed' | 'paused';

export interface WorkflowStep {
  id: string;
  agent: AgentType;
  prompt: string;
  output?: string;
  depends_on?: string | string[];
  retries?: number;
  timeout_seconds?: number;
  context?: string[];
}

export interface WorkflowDefinition {
  name: string;
  description?: string;
  steps: WorkflowStep[];
  variables?: Record<string, string>;
}

// --- Execution State Types ---

export interface StepResult {
  stepId: string;
  status: StepStatus;
  output?: string;
  error?: string;
  startedAt?: string;
  completedAt?: string;
  attempts: number;
}

export interface WorkflowExecution {
  executionId: string;
  workflowName: string;
  status: WorkflowStatus;
  steps: Record<string, StepResult>;
  variables: Record<string, string>;
  startedAt: string;
  completedAt?: string;
  currentStepId?: string;
}

// --- Agent Adapter Interface ---

export interface AgentRequest {
  prompt: string;
  context?: string;
  outputPath?: string;
  /** Target project directory — enables codebase tools (search, read, list) during execution. */
  projectDir?: string;
  /** Enable agentic tool use (search_codebase, read_file, list_directory). Defaults to false. */
  enableTools?: boolean;
}

export interface AgentResponse {
  success: boolean;
  output?: string;
  error?: string;
  durationMs: number;
}

export interface AgentAdapter {
  name: AgentType;
  execute(request: AgentRequest): Promise<AgentResponse>;
}

// --- State Manager Interface ---

export interface StateManager {
  save(execution: WorkflowExecution): Promise<void>;
  load(executionId: string): Promise<WorkflowExecution | null>;
  list(): Promise<WorkflowExecution[]>;
}

// --- Prompt Resolver Interface ---

export interface PromptResolver {
  resolve(
    templatePath: string,
    variables: Record<string, string>,
    stepOutputs: Record<string, string>
  ): Promise<string>;
}

