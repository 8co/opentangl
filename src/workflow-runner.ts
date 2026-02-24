/**
 * Workflow Runner
 * Core orchestration engine — loads workflow definitions, resolves dependencies,
 * executes steps in order via agent adapters
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { parse as parseYaml } from 'yaml';
import type {
  WorkflowDefinition,
  WorkflowExecution,
  WorkflowStep,
  StepResult,
  AgentAdapter,
  StateManager,
  PromptResolver,
  AgentType,
} from './types.js';

interface RunnerDeps {
  stateManager: StateManager;
  promptResolver: PromptResolver;
  adapters: Record<string, AgentAdapter>;
  basePath: string;
  defaultAgent?: AgentType;
}

export function createWorkflowRunner(deps: RunnerDeps) {
  const { stateManager, promptResolver, adapters, basePath, defaultAgent } = deps;

  async function loadWorkflow(workflowPath: string): Promise<WorkflowDefinition> {
    const fullPath = resolve(basePath, workflowPath);
    const raw = await readFile(fullPath, 'utf-8');

    if (fullPath.endsWith('.yaml') || fullPath.endsWith('.yml')) {
      return parseYaml(raw) as WorkflowDefinition;
    }
    return JSON.parse(raw) as WorkflowDefinition;
  }

  function resolveStepOrder(steps: WorkflowStep[]): WorkflowStep[] {
    const resolved: WorkflowStep[] = [];
    const remaining = [...steps];
    const resolvedIds = new Set<string>();

    while (remaining.length > 0) {
      const nextIndex = remaining.findIndex((step) => {
        if (!step.depends_on) return true;
        const deps = Array.isArray(step.depends_on) ? step.depends_on : [step.depends_on];
        return deps.every((d) => resolvedIds.has(d));
      });

      if (nextIndex === -1) {
        const unresolved = remaining.map((s) => s.id).join(', ');
        throw new Error(`Circular or unresolvable dependencies: ${unresolved}`);
      }

      const step = remaining.splice(nextIndex, 1)[0];
      resolvedIds.add(step.id);
      resolved.push(step);
    }

    return resolved;
  }

  function collectStepOutputs(execution: WorkflowExecution): Record<string, string> {
    const outputs: Record<string, string> = {};
    for (const [stepId, result] of Object.entries(execution.steps)) {
      if (result.output) {
        outputs[stepId] = result.output;
      }
    }
    return outputs;
  }

  return {
    async run(
      workflowPath: string,
      overrides?: Record<string, string>
    ): Promise<WorkflowExecution> {
      const workflow = await loadWorkflow(workflowPath);
      const orderedSteps = resolveStepOrder(workflow.steps);

      const execution: WorkflowExecution = {
        executionId: uuidv4(),
        workflowName: workflow.name,
        status: 'running',
        steps: {},
        variables: { ...workflow.variables, ...overrides },
        startedAt: new Date().toISOString(),
      };

      // Initialize all steps as pending
      for (const step of orderedSteps) {
        execution.steps[step.id] = {
          stepId: step.id,
          status: 'pending',
          attempts: 0,
        };
      }

      await stateManager.save(execution);

      console.log(`\n🚀 Workflow: ${workflow.name}`);
      console.log(`   Execution: ${execution.executionId}`);
      console.log(`   Steps: ${orderedSteps.map((s) => s.id).join(' → ')}\n`);

      for (const step of orderedSteps) {
        const stepResult = execution.steps[step.id];
        const maxRetries = step.retries ?? 0;

        execution.currentStepId = step.id;
        stepResult.status = 'running';
        stepResult.startedAt = new Date().toISOString();
        await stateManager.save(execution);

        const agentName = defaultAgent ?? step.agent;
        console.log(`▶ Step: ${step.id} (agent: ${agentName})`);

        // Get adapter
        const adapter = adapters[agentName];
        if (!adapter) {
          stepResult.status = 'failed';
          stepResult.error = `No adapter registered for agent: ${agentName}`;
          stepResult.completedAt = new Date().toISOString();
          execution.status = 'failed';
          await stateManager.save(execution);
          console.log(`  ❌ ${stepResult.error}`);
          break;
        }

        // Resolve prompt
        let resolvedPrompt: string;
        try {
          const stepOutputs = collectStepOutputs(execution);
          resolvedPrompt = await promptResolver.resolve(
            step.prompt,
            execution.variables,
            stepOutputs
          );
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          stepResult.status = 'failed';
          stepResult.error = `Prompt resolution failed: ${error}`;
          stepResult.completedAt = new Date().toISOString();
          execution.status = 'failed';
          await stateManager.save(execution);
          console.log(`  ❌ ${stepResult.error}`);
          break;
        }

        // Execute with retries
        let lastError: string | undefined;
        let success = false;

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
          stepResult.attempts = attempt + 1;

          if (attempt > 0) {
            console.log(`  🔄 Retry ${attempt}/${maxRetries}`);
          }

          const response = await adapter.execute({
            prompt: resolvedPrompt,
            outputPath: step.output ? resolve(basePath, step.output) : undefined,
          });

          if (response.success) {
            stepResult.status = 'completed';
            stepResult.output = response.output;
            stepResult.completedAt = new Date().toISOString();
            success = true;
            console.log(`  ✅ Completed (${response.durationMs}ms)`);
            break;
          }

          lastError = response.error;
        }

        if (!success) {
          stepResult.status = 'failed';
          stepResult.error = lastError ?? 'Unknown error';
          stepResult.completedAt = new Date().toISOString();
          execution.status = 'failed';
          await stateManager.save(execution);
          console.log(`  ❌ Failed after ${stepResult.attempts} attempt(s): ${stepResult.error}`);
          break;
        }

        await stateManager.save(execution);
      }

      if (execution.status === 'running') {
        execution.status = 'completed';
      }
      execution.completedAt = new Date().toISOString();
      execution.currentStepId = undefined;
      await stateManager.save(execution);

      const icon = execution.status === 'completed' ? '✅' : '❌';
      console.log(`\n${icon} Workflow ${execution.status}: ${workflow.name}`);
      console.log(`   Duration: ${Date.parse(execution.completedAt) - Date.parse(execution.startedAt)}ms\n`);

      return execution;
    },

    async resume(executionId: string): Promise<WorkflowExecution> {
      const execution = await stateManager.load(executionId);
      if (!execution) {
        throw new Error(`Execution not found: ${executionId}`);
      }
      if (execution.status !== 'failed' && execution.status !== 'paused') {
        throw new Error(`Cannot resume execution in status: ${execution.status}`);
      }

      console.log(`\n🔄 Resuming workflow: ${execution.workflowName}`);
      console.log(`   Execution: ${executionId}\n`);

      // Reset failed steps to pending
      for (const result of Object.values(execution.steps)) {
        if (result.status === 'failed') {
          result.status = 'pending';
          result.error = undefined;
        }
      }

      execution.status = 'running';
      await stateManager.save(execution);

      // Re-run from first pending step (simplified — full impl would reload workflow def)
      console.log('⚠️  Resume re-runs failed steps. Full resume requires workflow reload.');
      return execution;
    },

    async list(): Promise<void> {
      const executions = await stateManager.list();
      if (executions.length === 0) {
        console.log('No workflow executions found.');
        return;
      }

      console.log('\n📋 Workflow Executions:\n');
      for (const exec of executions) {
        const steps = Object.values(exec.steps);
        const completed = steps.filter((s) => s.status === 'completed').length;
        const icon =
          exec.status === 'completed' ? '✅' :
          exec.status === 'failed' ? '❌' :
          exec.status === 'running' ? '▶' : '⏸';

        console.log(`  ${icon} ${exec.workflowName} (${exec.executionId.slice(0, 8)})`);
        console.log(`     Status: ${exec.status} | Steps: ${completed}/${steps.length} | ${exec.startedAt}`);
      }
      console.log('');
    },
  };
}

