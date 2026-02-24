/**
 * Scheduler
 * Loops through the task queue, running each pending task autonomously.
 *
 * Modes:
 *   - next: Run just the next pending task, then stop.
 *   - loop: Run all pending tasks sequentially, then stop.
 *   - watch: Run all pending tasks, then poll for new ones on an interval.
 *
 * Multi-project support:
 *   - Tasks with a `project` field target an external project.
 *   - Git operations run at the target project's path.
 *   - External project branches are NOT auto-merged — left for review.
 *   - Queue state is always committed to the orchestrator repo.
 */

import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { parse as parseYaml } from 'yaml';
import { createQueueManager, type QueueTask } from './queue-manager.js';
import { createAutonomousRunner, type AutoStep, type AutoWorkflow } from './autonomous-runner.js';
import { runVerification, defaultVerifyCommands, verifyCommandsForProject } from './verify-runner.js';
import { buildFileContext, buildReferenceContext } from './file-writer.js';
import { createMergePipeline, type BranchMergeInput } from './merge-pipeline.js';
import { commitQueueState, syncMainFromRemote } from './git-ops.js';
import type { AgentAdapter, AgentRequest, AgentType } from './types.js';
import type { ProjectConfig, ProjectRegistry } from './project-registry.js';
import { getProfile, getLanguageVarsFromProfile } from './project-profiles.js';

// --- Import rules formatting ---

interface ImportRule {
  package: string;
  version: number;
  rules: string[];
}

/**
 * Format import_rules from project config into a prompt-friendly string.
 * Returns empty string if no rules are defined.
 */
function formatImportRules(importRules?: ImportRule[]): string {
  if (!importRules || importRules.length === 0) return '';

  const lines: string[] = [
    '=== CRITICAL: Import & API Rules (version-specific) ===',
    '',
    'These rules reflect the EXACT library versions installed in this project.',
    'Violating them causes runtime errors that may pass build checks.',
    '',
  ];

  for (const rule of importRules) {
    lines.push(`**${rule.package} (v${rule.version}):**`);
    for (const r of rule.rules) {
      lines.push(`- ${r}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Run a git command and return stdout.
 */
function gitCmd(args: string[], cwd: string): Promise<{ success: boolean; output: string }> {
  return new Promise((res) => {
    let stdout = '';
    let stderr = '';
    const proc = spawn('git', args, { cwd, shell: false });
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    proc.on('close', (code) => res({ success: code === 0, output: (stdout + stderr).trim() }));
    proc.on('error', (e) => res({ success: false, output: e.message }));
  });
}

/**
 * Extract the "### Known Issues" section from a vision file.
 * Returns the bullet-point content (without the heading), or null if not found.
 */
async function loadKnownIssues(orchestratorRoot: string, environment: string): Promise<string | null> {
  const visionPath = resolve(orchestratorRoot, `docs/environments/${environment}/product-vision.md`);
  try {
    const content = await readFile(visionPath, 'utf-8');
    const heading = '### Known Issues';
    const startIdx = content.indexOf(heading);
    if (startIdx === -1) return null;

    const afterHeading = content.slice(startIdx + heading.length);
    const nextSection = afterHeading.search(/\n###?\s/);
    const section = nextSection !== -1
      ? afterHeading.slice(0, nextSection).trim()
      : afterHeading.trim();

    return section || null;
  } catch {
    return null;
  }
}

// --- Types ---

export interface SchedulerConfig {
  basePath: string;
  adapters: Record<string, AgentAdapter>;
  defaultAgent: AgentType;
  queuePath?: string;
  pollIntervalMs?: number; // For watch mode (default: 5 minutes)
  projectConfig?: ProjectConfig; // Single project (backward compat)
  registry?: ProjectRegistry;    // Full registry for multi-project task resolution
  onTaskStart?: (taskId: string) => void;  // Called when a task begins execution
  onTaskEnd?: (taskId: string) => void;    // Called when a task finishes (success or fail)
}

interface TaskRunResult {
  taskId: string;
  projectId: string;       // Which project was targeted
  success: boolean;
  error?: string;
  durationMs: number;
  branch?: string;
}

export interface LoopResult {
  tasks: TaskRunResult[];
  merged: number;
  escalated: number;
}

// --- Language variable defaults ---

/**
 * Derive language-related template variables from project config.
 * Uses project-profiles for consistent defaults per project type.
 * Falls back to TypeScript defaults if profile not found.
 */
function getLanguageVars(projectConfig?: ProjectConfig): Record<string, string> {
  const projectType = projectConfig?.type ?? 'typescript-node';
  const profile = getProfile(projectType);

  if (profile) {
    return getLanguageVarsFromProfile(profile);
  }

  // Fallback: TypeScript defaults
  return {
    language: 'TypeScript',
    code_lang: 'typescript',
    file_ext: 'ts',
    module_system: 'ES modules (import/export, .js extensions in imports)',
    language_instructions: 'TypeScript strict mode — no `any`, no implicit types.',
  };
}

// --- Scheduler ---

export function createScheduler(config: SchedulerConfig) {
  const {
    basePath,
    adapters,
    defaultAgent,
    queuePath,
    pollIntervalMs = 5 * 60 * 1000,
    registry,
  } = config;

  const queue = createQueueManager(basePath, queuePath);
  const runner = createAutonomousRunner({ adapters, defaultAgent });

  /**
   * Resolve the project config for a task.
   * Falls back to orchestrator defaults when no project is specified.
   */
  function resolveProject(task: QueueTask): { projectConfig: ProjectConfig | undefined; projectId: string } {
    if (task.project && registry) {
      const projectConfig = registry.get(task.project);
      if (projectConfig) {
        return { projectConfig, projectId: task.project };
      }
      console.log(`  ⚠️  Unknown project "${task.project}", falling back to orchestrator`);
    }
    return { projectConfig: config.projectConfig, projectId: 'orchestrator' };
  }

  /**
   * Convert a queue task into an AutoWorkflow the runner can execute.
   * For external projects, sets target_dir to the project's absolute path
   * and injects language-specific template variables.
   */
  async function taskToWorkflow(task: QueueTask, projectConfig: ProjectConfig | undefined, projectId: string): Promise<{ workflow: AutoWorkflow; path: string }> {
    const branchName = `auto/${task.id}`;

    // Inject language variables into the task's variables
    const langVars = getLanguageVars(projectConfig);
    const mergedVars: Record<string, string> = {
      ...langVars,
      ...task.variables,  // Task-specific vars override defaults
    };

    // Inject import rules (version-specific API constraints)
    const importRulesText = formatImportRules(projectConfig?.import_rules as ImportRule[] | undefined);
    if (importRulesText) {
      mergedVars['import_rules'] = importRulesText;
    }

    // Build cross-project reference context (if configured)
    if (projectConfig?.reference_context && registry) {
      const refContext = await buildReferenceContext(projectConfig.reference_context, registry);
      if (refContext) {
        mergedVars['reference_context'] = refContext;
      }
    }

    // Inject Known Issues from the environment's vision file so the code-writing LLM avoids past mistakes
    if (projectConfig?.environment) {
      const knownIssues = await loadKnownIssues(basePath, projectConfig.environment);
      if (knownIssues) {
        mergedVars['known_issues'] = knownIssues;
      }
    }

    // Auto-include router file when task targets pages directory
    let contextFiles = task.context_files ? [...task.context_files] : undefined;
    const projectType = projectConfig?.type ?? 'typescript-node';
    const profile = getProfile(projectType);

    if (profile?.routerFile && contextFiles?.some(f => f.startsWith('src/pages/'))) {
      if (!contextFiles.includes(profile.routerFile)) {
        contextFiles.push(profile.routerFile);
        // Tell the LLM explicitly to register any new pages
        if (mergedVars['feature_description']) {
          mergedVars['feature_description'] += '\n\nIMPORTANT: If you create a new page component, you MUST also update the router file to add a <Route> for it. The router file is included in the context below.';
        }
      }
    }

    const step: AutoStep = {
      id: task.id,
      prompt: task.prompt,
      context_files: contextFiles,
      max_attempts: 3,
      commit_message: `Auto: ${task.id}`,
      variables: mergedVars,
      verify: projectConfig?.verify
        ? verifyCommandsForProject(projectConfig.verify)
        : undefined,
    };

    // For external projects, use their absolute path as target_dir
    // resolve() returns the absolute path unchanged if it's already absolute
    const targetDir = (projectConfig && projectId !== 'orchestrator')
      ? projectConfig.path
      : '.';

    const workflow: AutoWorkflow = {
      name: task.id,
      description: `Queued task: ${task.id}`,
      target_dir: targetDir,
      branch: branchName,
      steps: [step],
      projectId,
    };

    return { workflow, path: '' };
  }

  /**
   * Check if a task uses the plan workflow template.
   */
  function isPlanTask(task: QueueTask): boolean {
    return task.prompt === 'prompts/auto-plan-feature.md';
  }

  /**
   * Run a planning prompt to decompose a feature into steps,
   * then return a multi-step AutoWorkflow.
   */
  async function decomposePlanTask(
    task: QueueTask,
    projectConfig: ProjectConfig | undefined,
    projectId: string
  ): Promise<AutoWorkflow | null> {
    const agentName = defaultAgent;
    const adapter = adapters[agentName];
    if (!adapter) {
      console.log(`  ❌ No adapter for agent: ${agentName}`);
      return null;
    }

    const langVars = getLanguageVars(projectConfig);
    const mergedVars: Record<string, string> = {
      ...langVars,
      ...task.variables,
      project_name: projectConfig?.name ?? 'project',
    };

    // Load the plan prompt template
    const templatePath = resolve(basePath, task.prompt);
    let template: string;
    try {
      template = await readFile(templatePath, 'utf-8');
    } catch {
      console.log(`  ❌ Plan template not found: ${templatePath}`);
      return null;
    }

    // Resolve variables in the template
    let prompt = template.replace(/\{\{(\s*[\w.]+\s*)\}\}/g, (_match, key: string) => {
      const trimmed = key.trim();
      return mergedVars[trimmed] ?? `{{${trimmed}}}`;
    });

    // Build file context if context_files are specified
    const targetDir = (projectConfig && projectId !== 'orchestrator')
      ? projectConfig.path
      : basePath;

    if (task.context_files && task.context_files.length > 0) {
      const context = await buildFileContext(task.context_files, targetDir);
      if (context) {
        prompt = prompt.replace('{{file_context}}', context);
      } else {
        prompt = prompt.replace('{{file_context}}', '(no files provided)');
      }
    } else {
      prompt = prompt.replace('{{file_context}}', '(no files provided)');
    }

    console.log('  🧠 Running plan decomposition...');

    const request: AgentRequest = { prompt };
    const response = await adapter.execute(request);

    if (!response.success || !response.output) {
      console.log(`  ❌ Planning LLM call failed: ${response.error ?? 'no output'}`);
      return null;
    }

    // Parse the plan YAML from the LLM output
    const yamlMatch = response.output.match(/```(?:yaml:plan|yaml)\n([\s\S]*?)```/);
    if (!yamlMatch) {
      console.log('  ❌ No plan YAML block found in LLM output');
      return null;
    }

    let planSteps: Array<{
      id: string;
      prompt: string;
      context_files?: string[];
      variables?: Record<string, string>;
    }>;

    try {
      const parsed = parseYaml(yamlMatch[1]) as { steps: typeof planSteps };
      planSteps = parsed.steps;
      if (!Array.isArray(planSteps) || planSteps.length === 0) {
        console.log('  ❌ Plan contained no steps');
        return null;
      }
    } catch {
      console.log('  ❌ Failed to parse plan YAML');
      return null;
    }

    console.log(`  📋 Plan decomposed into ${planSteps.length} step(s):`);
    for (const s of planSteps) {
      console.log(`     → ${s.id} (${s.prompt})`);
    }

    // Convert plan steps into AutoSteps
    const branchName = `auto/${task.id}`;
    const autoSteps: AutoStep[] = planSteps.map((s) => ({
      id: s.id,
      prompt: s.prompt,
      context_files: s.context_files,
      max_attempts: 3,
      commit_message: `Auto: ${task.id} — ${s.id}`,
      variables: {
        ...langVars,
        ...s.variables,
      },
      verify: projectConfig?.verify
        ? verifyCommandsForProject(projectConfig.verify)
        : undefined,
    }));

    const workflow: AutoWorkflow = {
      name: task.id,
      description: `Planned feature: ${task.id}`,
      target_dir: (projectConfig && projectId !== 'orchestrator')
        ? projectConfig.path
        : '.',
      branch: branchName,
      steps: autoSteps,
      projectId,
    };

    return workflow;
  }

  /**
   * Run a single task from the queue.
   */
  async function runTask(task: QueueTask): Promise<TaskRunResult> {
    const start = Date.now();
    const { projectConfig, projectId } = resolveProject(task);

    const isExternal = projectId !== 'orchestrator';
    const targetPath = (isExternal && projectConfig)
      ? projectConfig.path
      : basePath;

    console.log('\n' + '━'.repeat(50));
    console.log(`📌 Task: ${task.id}`);
    if (isExternal) {
      console.log(`📁 Project: ${projectConfig?.name ?? projectId} (${targetPath})`);
    }
    console.log('━'.repeat(50));

    await queue.markRunning(task.id);
    config.onTaskStart?.(task.id);

    // Commit queue state in the ORCHESTRATOR repo (targeted — only queue files)
    // (so reverts in the target project don't lose queue state)
    await commitQueueState(basePath, `Queue: start ${task.id}`);

    try {
      // For external projects, ensure we start from main synced with remote
      // before creating a new branch. Without this, each task branches from
      // stale local main (missing PR merges that happened on remote).
      if (isExternal) {
        const syncResult = await syncMainFromRemote(targetPath);
        if (!syncResult.success) {
          console.log(`  ⚠️  Main sync failed for ${targetPath} — task may branch from stale main`);
        }
      }

      // For plan tasks, decompose into multi-step workflow first
      let workflow: AutoWorkflow;
      if (isPlanTask(task)) {
        const planned = await decomposePlanTask(task, projectConfig, projectId);
        if (!planned) {
          await queue.markFailed(task.id, 'Plan decomposition failed');
          config.onTaskEnd?.(task.id);
          return {
            taskId: task.id,
            projectId,
            success: false,
            error: 'Plan decomposition failed',
            durationMs: Date.now() - start,
          };
        }
        workflow = planned;
      } else {
        workflow = (await taskToWorkflow(task, projectConfig, projectId)).workflow;
      }

      // Write a temporary workflow file (always in orchestrator)
      const tempWorkflowPath = resolve(basePath, `.tmp-workflow-${task.id}.yaml`);
      const { writeFile: writeFs } = await import('node:fs/promises');
      const { stringify: stringifyYaml } = await import('yaml');
      await writeFs(tempWorkflowPath, stringifyYaml(workflow), 'utf-8');

      // Run the workflow
      // basePath is still the orchestrator root (for prompt template resolution)
      const result = await runner.run(tempWorkflowPath, basePath);

      // Clean up temp file
      const { unlink } = await import('node:fs/promises');
      await unlink(tempWorkflowPath).catch(() => {});

      if (result.status === 'completed') {
        await queue.markCompleted(task.id, result.branch);
        config.onTaskEnd?.(task.id);
        return {
          taskId: task.id,
          projectId,
          success: true,
          durationMs: Date.now() - start,
          branch: result.branch,
        };
      } else {
        const error = result.steps.find((s) => s.status === 'failed')?.error ?? 'Unknown error';
        await queue.markFailed(task.id, error);
        config.onTaskEnd?.(task.id);
        return {
          taskId: task.id,
          projectId,
          success: false,
          error,
          durationMs: Date.now() - start,
        };
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      await queue.markFailed(task.id, error);
      config.onTaskEnd?.(task.id);
      return {
        taskId: task.id,
        projectId,
        success: false,
        error,
        durationMs: Date.now() - start,
      };
    } finally {
      // Always restore external projects to main after a task finishes.
      // Without this, a failed/escalated task leaves the repo on its
      // feature branch. Manual fixes made without noticing end up on
      // that branch instead of main — and never get deployed.
      if (isExternal) {
        await syncMainFromRemote(targetPath).catch(() => {});
      }
    }
  }

  /**
   * Try to merge a single task inline (for dependency unblocking).
   * Returns the merge result status.
   */
  async function mergeInline(
    result: TaskRunResult,
    mergePipeline: ReturnType<typeof createMergePipeline>
  ): Promise<'merged' | 'escalated' | 'failed'> {
    const input: BranchMergeInput = {
      taskId: result.taskId,
      branch: result.branch as string,
      projectId: result.projectId,
      taskDescription: `Task: ${result.taskId}`,
    };

    // Commit queue state before merge (targeted — only queue files)
    await commitQueueState(basePath, `Queue: pre-merge ${result.taskId}`);

    const mergeResult = await mergePipeline.mergeSingle(input);

    // After a successful PR merge on remote, sync the project's local main
    // so subsequent branches are created from the latest state.
    if (mergeResult.status === 'merged') {
      const projectConfig = registry?.get(result.projectId);
      const projectPath = projectConfig?.path;
      if (projectPath) {
        await syncMainFromRemote(projectPath);
      }
    }

    // Commit queue state after merge (targeted — only queue files)
    await commitQueueState(basePath, `Queue: post-merge ${result.taskId} — ${mergeResult.status}`);

    return mergeResult.status;
  }

  /**
   * Core execution loop shared by loop() and watch().
   * Runs pending tasks with dependency-aware ordering and inline merging.
   * Tasks with dependents are merged immediately so blocked tasks can proceed.
   * Tasks without dependents are deferred for batch merge at the end.
   */
  async function runPendingTasks(mergePipeline: ReturnType<typeof createMergePipeline> | null): Promise<LoopResult> {
    const results: TaskRunResult[] = [];
    const inlineMerged = new Set<string>();
    let totalMerged = 0;
    let totalEscalated = 0;

    let task = await queue.next();
    while (task) {
      const result = await runTask(task);
      results.push(result);

      if (!result.success) {
        console.log(`\n⚠️  Task "${task.id}" failed. Continuing to next task.`);
      }

      // Inline merge: if this task succeeded and has dependents waiting on it,
      // merge it now so the next queue.next() can unblock those dependents.
      if (result.success && result.branch && mergePipeline) {
        const hasDeps = await queue.hasDependents(result.taskId);
        if (hasDeps) {
          console.log(`\n🔗 Task "${task.id}" has dependents — merging inline to unblock them`);
          const mergeStatus = await mergeInline(result, mergePipeline);
          inlineMerged.add(result.taskId);

          if (mergeStatus === 'merged') totalMerged++;
          else if (mergeStatus === 'escalated') totalEscalated++;

          if (mergeStatus !== 'merged') {
            console.log(`  ⚠️  Inline merge ${mergeStatus} — dependent tasks will be skipped`);
          }
        }
      }

      task = await queue.next();
    }

    // Batch merge remaining successful branches that weren't merged inline
    const deferredBranches: BranchMergeInput[] = results
      .filter((r) => r.success && r.branch && !inlineMerged.has(r.taskId))
      .map((r) => ({
        taskId: r.taskId,
        branch: r.branch as string,
        projectId: r.projectId,
        taskDescription: `Task: ${r.taskId}`,
      }));

    if (deferredBranches.length > 0 && mergePipeline) {
      const passed = results.filter((r) => r.success).length;
      const failed = results.filter((r) => !r.success).length;
      await commitQueueState(basePath, `Queue: batch complete — ${passed} passed, ${failed} failed`);

      const mergeResults = await mergePipeline.run(deferredBranches);
      totalMerged += mergeResults.merged;
      totalEscalated += mergeResults.escalated;

      // Sync each project's local main after batch merges so subsequent runs
      // (and the integration check inside the pipeline) see the latest state.
      if (mergeResults.merged > 0) {
        const projectIds = new Set(deferredBranches.map((b) => b.projectId));
        for (const pid of projectIds) {
          const projectPath = registry?.get(pid)?.path;
          if (projectPath) {
            await syncMainFromRemote(projectPath);
          }
        }
      }

      await commitQueueState(basePath, `Queue: merge pipeline — ${mergeResults.merged} merged, ${mergeResults.escalated} escalated`);
    }

    // Post-execution orphan audit: catch any tasks that completed during this
    // run but were silently missed by the merge pipeline.
    const postOrphanCount = await queue.auditOrphanedTasks();
    if (postOrphanCount > 0) {
      console.log(`\n⚠️  Post-execution audit: ${postOrphanCount} orphaned task(s) — marked as failed`);
    }

    return { tasks: results, merged: totalMerged, escalated: totalEscalated };
  }

  return {
    /**
     * Run just the next pending task, then stop.
     */
    async next(): Promise<TaskRunResult | null> {
      const task = await queue.next();
      if (!task) {
        console.log('\n✅ No pending tasks in queue.');
        return null;
      }
      return runTask(task);
    },

    /**
     * Run all pending tasks with dependency-aware ordering, then stop.
     * Tasks with dependents are merged inline to unblock downstream tasks.
     * Remaining branches are batch-merged at the end.
     */
    async loop(): Promise<LoopResult> {
      // Detect orphaned tasks (completed with branch but no merge_status)
      const orphanCount = await queue.auditOrphanedTasks();
      if (orphanCount > 0) {
        console.log(`\n⚠️  Found ${orphanCount} orphaned task(s) — marked as failed`);
      }

      // Prune terminal tasks before running to keep the queue lean
      const pruneResult = await queue.prune();
      if (pruneResult.removed > 0) {
        console.log(`\n🧹 Pruned ${pruneResult.removed} terminal task(s), ${pruneResult.kept} remaining`);
        await commitQueueState(basePath, `Queue: prune ${pruneResult.removed} terminal tasks`);
      }

      const summary = await queue.summary();

      console.log('\n' + '═'.repeat(50));
      console.log('🔄 SCHEDULER — LOOP MODE');
      console.log('═'.repeat(50));
      console.log(`   Pending tasks: ${summary.pending}`);
      console.log('═'.repeat(50));

      const mergePipeline = registry ? createMergePipeline({
        adapters,
        defaultAgent,
        registry,
        basePath,
      }) : null;

      const loopResult = await runPendingTasks(mergePipeline);
      const results = loopResult.tasks;

      // Re-queue escalated tasks so the underlying problems get re-attempted
      const requeued = await queue.requeueEscalated();
      if (requeued.length > 0) {
        console.log(`\n♻️  Re-queued ${requeued.length} escalated task(s):`);
        for (const t of requeued) {
          console.log(`   → ${t.id}`);
        }
      }

      // Post-batch health check (orchestrator only)
      console.log('\n' + '─'.repeat(50));
      console.log('🏥 POST-BATCH HEALTH CHECK');
      console.log('─'.repeat(50));

      const healthCheck = await runVerification(defaultVerifyCommands(), basePath);
      if (healthCheck.allPassed) {
        console.log('   ✅ Codebase is healthy — tsc passed');
      } else {
        console.log('   ⚠️  Codebase has issues after batch:');
        console.log(`   ${healthCheck.errorSummary?.slice(0, 200)}`);
      }

      // Print summary
      console.log('\n' + '═'.repeat(50));
      console.log('📊 BATCH COMPLETE');
      console.log('═'.repeat(50));

      const passed = results.filter((r) => r.success).length;
      const failed = results.filter((r) => !r.success).length;
      const totalMs = results.reduce((sum, r) => sum + r.durationMs, 0);

      console.log(`   Tasks run: ${results.length}`);
      console.log(`   Passed: ${passed} | Failed: ${failed}`);
      console.log(`   Merged: ${loopResult.merged} | Escalated: ${loopResult.escalated}`);
      console.log(`   Total time: ${Math.round(totalMs / 1000)}s`);
      console.log(`   Health:    ${healthCheck.allPassed ? '✅ clean' : '⚠️  issues detected'}`);
      console.log('═'.repeat(50));

      // Push queue state (targeted — only queue files)
      if (results.length > 0) {
        await commitQueueState(basePath, `Queue: loop complete — ${passed} passed, ${failed} failed`);
        const pushResult = await gitCmd(['push', 'origin', 'HEAD'], basePath);
        if (pushResult.success) {
          console.log('   🚀 Queue state pushed to origin');
        } else {
          console.log(`   ⚠️  Queue push failed: ${pushResult.output.slice(0, 100)}`);
        }
      } else {
        console.log('\n   No tasks were executed.');
      }

      await queue.print();

      return loopResult;
    },

    /**
     * Run all pending tasks, then poll for new ones on an interval.
     * Runs until interrupted (Ctrl+C).
     * Uses dependency-aware ordering with inline merging.
     */
    async watch(): Promise<void> {
      console.log('\n' + '═'.repeat(50));
      console.log('👁  SCHEDULER — WATCH MODE');
      console.log(`   Polling every ${Math.round(pollIntervalMs / 1000)}s`);
      console.log('   Press Ctrl+C to stop');
      console.log('═'.repeat(50));

      const mergePipeline = registry ? createMergePipeline({
        adapters,
        defaultAgent,
        registry,
        basePath,
      }) : null;

      // Initial run
      await runPendingTasks(mergePipeline);

      // Poll loop
      const interval = setInterval(async () => {
        const summary = await queue.summary();
        if (summary.pending > 0) {
          console.log(`\n🔔 ${summary.pending} new task(s) found`);
          await runPendingTasks(mergePipeline);
        } else {
          console.log(`⏳ ${new Date().toISOString()} — no pending tasks, waiting...`);
        }
      }, pollIntervalMs);

      // Graceful shutdown
      process.on('SIGINT', () => {
        clearInterval(interval);
        console.log('\n\n👋 Scheduler stopped.');
        process.exit(0);
      });

      // Keep alive
      await new Promise(() => {});
    },

    /**
     * Print the current queue status.
     */
    async status(): Promise<void> {
      await queue.print();
    },
  };
}
