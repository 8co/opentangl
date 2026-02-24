#!/usr/bin/env node

/**
 * CLI Entry Point
 * Usage:
 *   npx tsx src/cli.ts run <workflow.yaml> [--var key=value] [--agent anthropic|openai|cursor]
 *   npx tsx src/cli.ts auto <workflow.yaml> [--var key=value] [--agent openai|anthropic]
 *   npx tsx src/cli.ts list
 *   npx tsx src/cli.ts resume <executionId>
 */

import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig, validateConfig } from './config.js';
import { createWorkflowRunner } from './workflow-runner.js';
import { createPromptResolver } from './prompt-resolver.js';
import { createStateManager } from './state-manager.js';
import { createCursorAdapter } from './adapters/cursor-adapter.js';
import { createAnthropicAdapter } from './adapters/anthropic-adapter.js';
import { createOpenAIAdapter } from './adapters/openai-adapter.js';
import { createAutonomousRunner } from './autonomous-runner.js';
import { createScheduler } from './scheduler.js';
import { createTaskProposer, createMultiProjectProposer } from './task-proposer.js';
import { createProjectRegistry } from './project-registry.js';
import { createMergePipeline } from './merge-pipeline.js';
import { createQueueManager } from './queue-manager.js';
import { runWiringAudit } from './wiring-audit.js';
import { reviewAndUpdateVision } from './vision-review.js';
import { commitQueueState, commitVisionUpdate, getDirtyNonQueueFiles, syncMainFromRemote } from './git-ops.js';
import { createRunMetrics, runSanityCheck, printSanityCheck } from './sanity-check.js';
import { startRunLogger, type RunLogger } from './run-logger.js';
import type { AgentAdapter, AgentType } from './types.js';
import type { ProjectConfig } from './project-registry.js';
import type { QueueTask } from './queue-manager.js';

const basePath = process.cwd();
const LOCKFILE = resolve(basePath, '.orchestrator.lock');

// ── Process Lock ──────────────────────────────────────────────────────

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireLock(): void {
  if (existsSync(LOCKFILE)) {
    let contents: string;
    try {
      contents = readFileSync(LOCKFILE, 'utf-8');
    } catch {
      contents = '';
    }
    const pidMatch = contents.match(/^pid:\s*(\d+)/m);
    const startMatch = contents.match(/^started:\s*(.+)/m);
    if (pidMatch) {
      const existingPid = parseInt(pidMatch[1], 10);
      if (isProcessAlive(existingPid)) {
        const since = startMatch ? ` (since ${startMatch[1]})` : '';
        console.error(`\n❌ Another orchestrator instance is already running (PID ${existingPid})${since}`);
        console.error(`   If this is stale, delete ${LOCKFILE} and retry.\n`);
        process.exit(1);
      }
      console.log(`⚠️  Stale lockfile found (PID ${existingPid} is dead). Cleaning up.`);
    }
  }
  const lockContent = `pid: ${process.pid}\nstarted: ${new Date().toISOString()}\n`;
  writeFileSync(LOCKFILE, lockContent, 'utf-8');
}

function releaseLock(): void {
  try {
    if (existsSync(LOCKFILE)) {
      const contents = readFileSync(LOCKFILE, 'utf-8');
      const pidMatch = contents.match(/^pid:\s*(\d+)/m);
      if (pidMatch && parseInt(pidMatch[1], 10) === process.pid) {
        unlinkSync(LOCKFILE);
      }
    }
  } catch {
    // Best-effort cleanup
  }
}

// Track the currently running task so signal handlers can mark it failed
let currentRunningTaskId: string | null = null;
let activeRunLogger: RunLogger | null = null;

function setCurrentTask(taskId: string | null): void {
  currentRunningTaskId = taskId;
}

// Commands that require the process lock
const LOCKED_COMMANDS = new Set(['autopilot', 'schedule', 'next']);

function parseArgs(args: string[]) {
  const command = args[0];
  const positional: string[] = [];
  const vars: Record<string, string> = {};
  let agent: AgentType | undefined;
  let project: string | undefined;
  let projects: string[] | undefined;
  let featureRatio: number | undefined;
  let cycles: number | undefined;

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--var' && i + 1 < args.length) {
      const [key, ...rest] = args[i + 1].split('=');
      vars[key] = rest.join('=');
      i++;
    } else if (args[i] === '--agent' && i + 1 < args.length) {
      agent = args[i + 1] as AgentType;
      i++;
    } else if (args[i] === '--projects' && i + 1 < args.length) {
      projects = args[i + 1].split(',').map((s) => s.trim());
      i++;
    } else if (args[i] === '--project' && i + 1 < args.length) {
      project = args[i + 1];
      i++;
    } else if (args[i] === '--feature-ratio' && i + 1 < args.length) {
      featureRatio = parseFloat(args[i + 1]);
      if (Number.isNaN(featureRatio) || featureRatio < 0 || featureRatio > 1) {
        console.error('❌ --feature-ratio must be a number between 0 and 1 (e.g., 0.4 for 40%)');
        process.exit(1);
      }
      i++;
    } else if (args[i] === '--cycles' && i + 1 < args.length) {
      cycles = parseInt(args[i + 1], 10);
      if (Number.isNaN(cycles) || cycles < 1) {
        console.error('❌ --cycles must be a positive integer');
        process.exit(1);
      }
      i++;
    } else if (args[i] === '--auto-merge') {
      // Auto-merge is always enabled when scheduler.loop() runs; flag accepted for clarity
    } else {
      positional.push(args[i]);
    }
  }

  return { command, positional, vars, agent, project, projects, featureRatio, cycles };
}

function buildAdapters(config: ReturnType<typeof loadConfig>): Record<string, AgentAdapter> {
  const adapters: Record<string, AgentAdapter> = {
    cursor: createCursorAdapter(),
  };

  if (config.anthropic.apiKey) {
    adapters.anthropic = createAnthropicAdapter({
      apiKey: config.anthropic.apiKey,
      model: config.anthropic.model,
    });
  }

  if (config.openai.apiKey) {
    adapters.openai = createOpenAIAdapter({
      apiKey: config.openai.apiKey,
      model: config.openai.model,
    });
    // Codex uses the same OpenAI API
    adapters.codex = createOpenAIAdapter(
      { apiKey: config.openai.apiKey, model: config.openai.model },
      'codex'
    );
  }

  return adapters;
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    printUsage();
    process.exit(0);
  }

  const { command, positional, vars, agent, project, projects, featureRatio, cycles } = parseArgs(args);
  const config = loadConfig();

  // Load project registry
  const registry = createProjectRegistry(basePath);
  await registry.load();

  // Resolve project config
  let projectConfig: ProjectConfig;
  if (project) {
    const found = registry.get(project);
    if (!found) {
      console.error(`❌ Unknown project: ${project}`);
      console.error(`   Available projects: ${registry.listIds().join(', ')}`);
      process.exit(1);
    }
    projectConfig = found;
  } else {
    projectConfig = registry.getDefault();
  }

  // Show which project we're operating on
  if (command !== 'list' && command !== 'projects') {
    console.log(`📁 Project: ${projectConfig.name} (${projectConfig.id})`);
    console.log(`   Path: ${projectConfig.path}\n`);
  }

  // Use project path as the working directory for all operations
  const workingPath = projectConfig.path;

  const stateManager = createStateManager(workingPath);
  const promptResolver = createPromptResolver(basePath); // Prompts still live in orchestrator
  const adapters = buildAdapters(config);

  // If agent override provided via CLI, validate its config
  if (agent) {
    validateConfig(config, agent);
  }

  const runner = createWorkflowRunner({
    stateManager,
    promptResolver,
    adapters,
    basePath: workingPath,
    defaultAgent: agent ?? config.defaultAgent,
  });

  // ── Process lock + stale task cleanup for long-running commands ──
  if (LOCKED_COMMANDS.has(command)) {
    acquireLock();

    const queueManager = createQueueManager(basePath);
    const staleCount = await queueManager.resetStaleTasks();
    if (staleCount > 0) {
      console.log(`⚠️  Reset ${staleCount} stale running task(s) to failed.\n`);
    }

    // Graceful shutdown: clean lockfile + mark current task as failed
    const shutdown = async (signal: string) => {
      console.log(`\n🛑 Received ${signal}. Shutting down gracefully...`);
      if (currentRunningTaskId) {
        try {
          const qm = createQueueManager(basePath);
          await qm.markFailed(currentRunningTaskId, `Process terminated by ${signal}`);
          console.log(`   Marked task ${currentRunningTaskId} as failed.`);
        } catch {
          // Best-effort
        }
      }
      if (activeRunLogger) {
        activeRunLogger.stop();
        activeRunLogger = null;
      }
      releaseLock();
      process.exit(0);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('exit', releaseLock);
  }

  switch (command) {
    case 'projects': {
      registry.print();
      break;
    }

    case 'run': {
      const workflowPath = positional[0];
      if (!workflowPath) {
        console.error('❌ Usage: run <workflow.yaml> [--var key=value] [--agent anthropic|openai|cursor]');
        process.exit(1);
      }

      // Validate that the agents used in the workflow have API keys
      console.log(`🔧 Available agents: ${Object.keys(adapters).join(', ')}`);
      if (agent) {
        console.log(`🎯 Agent override: ${agent}`);
      }

      await runner.run(workflowPath, vars);
      break;
    }

    case 'auto': {
      const workflowPath = positional[0];
      if (!workflowPath) {
        console.error('❌ Usage: auto <workflow.yaml> [--var key=value] [--agent openai|anthropic]');
        process.exit(1);
      }

      const agentToUse = agent ?? config.defaultAgent;
      if (agentToUse === 'cursor') {
        console.error('❌ Autonomous mode requires a real LLM agent (openai, anthropic). Use --agent openai');
        process.exit(1);
      }

      validateConfig(config, agentToUse);

      console.log(`🔧 Available agents: ${Object.keys(adapters).join(', ')}`);
      console.log(`🎯 Agent: ${agentToUse}`);

      const autoRunner = createAutonomousRunner({
        adapters,
        defaultAgent: agentToUse,
      });

      const result = await autoRunner.run(workflowPath, basePath, vars);

      // Exit with error code if workflow failed
      if (result.status === 'failed') {
        process.exit(1);
      }
      break;
    }

    case 'next': {
      const agentToUse = agent ?? config.defaultAgent;
      if (agentToUse === 'cursor') {
        console.error('❌ Scheduler requires a real LLM agent. Use --agent openai');
        process.exit(1);
      }
      validateConfig(config, agentToUse);

      const nextLogger = startRunLogger({ basePath, command: 'next', projects: project ? [project] : undefined });
      activeRunLogger = nextLogger;

      const scheduler = createScheduler({
        basePath,
        adapters,
        defaultAgent: agentToUse,
        registry,
        onTaskStart: setCurrentTask,
        onTaskEnd: () => setCurrentTask(null),
      });

      const result = await scheduler.next();
      nextLogger.stop();
      if (result && !result.success) {
        process.exit(1);
      }
      break;
    }

    case 'schedule': {
      const mode = positional[0] ?? 'loop';
      const agentToUse = agent ?? config.defaultAgent;
      if (agentToUse === 'cursor') {
        console.error('❌ Scheduler requires a real LLM agent. Use --agent openai');
        process.exit(1);
      }
      validateConfig(config, agentToUse);

      const scheduleLogger = startRunLogger({ basePath, command: `schedule-${mode}`, projects: project ? [project] : undefined });
      activeRunLogger = scheduleLogger;

      const scheduler = createScheduler({
        basePath,
        adapters,
        defaultAgent: agentToUse,
        registry,
        onTaskStart: setCurrentTask,
        onTaskEnd: () => setCurrentTask(null),
      });

      if (mode === 'watch') {
        // For watch mode, stop logger on process exit
        process.on('SIGINT', () => scheduleLogger.stop());
        await scheduler.watch();
      } else {
        const loopResult = await scheduler.loop();
        scheduleLogger.stop();
        const failed = loopResult.tasks.some((r) => !r.success);
        if (failed) process.exit(1);
      }
      break;
    }

    case 'propose': {
      const mode = positional[0] ?? 'preview'; // preview | queue
      const agentToUse = agent ?? config.defaultAgent;
      if (agentToUse === 'cursor') {
        console.error('❌ Propose requires a real LLM agent. Use --agent openai');
        process.exit(1);
      }
      validateConfig(config, agentToUse);

      const proposerAdapter = adapters[agentToUse];
      if (!proposerAdapter) {
        console.error(`❌ No adapter for agent: ${agentToUse}`);
        process.exit(1);
      }

      // Multi-project mode: --projects api,ui
      if (projects && projects.length > 0) {
        const projectConfigs: ProjectConfig[] = [];
        for (const pid of projects) {
          const found = registry.get(pid);
          if (!found) {
            console.error(`❌ Unknown project in --projects: ${pid}`);
            console.error(`   Available projects: ${registry.listIds().join(', ')}`);
            process.exit(1);
          }
          projectConfigs.push(found);
        }

        const multiProposer = createMultiProjectProposer({
          adapter: proposerAdapter,
          projectConfigs,
          orchestratorRoot: basePath,
          registry,
          maxTasks: 5,
          featureRatio,
        });

        if (mode === 'queue') {
          await multiProposer.proposeAndQueue();
        } else {
          await multiProposer.preview();
        }
      } else {
        // Single-project mode (existing behavior)
        const proposer = createTaskProposer({
          basePath: workingPath,
          adapter: proposerAdapter,
          maxTasks: 5,
          projectConfig,
          orchestratorRoot: basePath,
          registry,
          featureRatio,
        });

        if (mode === 'queue') {
          await proposer.proposeAndQueue();
        } else {
          await proposer.preview();
        }
      }
      break;
    }

    case 'autopilot': {
      const agentToUse = agent ?? config.defaultAgent;
      if (agentToUse === 'cursor') {
        console.error('❌ Autopilot requires a real LLM agent. Use --agent openai');
        process.exit(1);
      }
      validateConfig(config, agentToUse);

      const proposerAdapter = adapters[agentToUse];
      if (!proposerAdapter) {
        console.error(`❌ No adapter for agent: ${agentToUse}`);
        process.exit(1);
      }

      // Safety: refuse to run if the orchestrator repo has uncommitted non-queue changes.
      // This prevents unrelated edits from being swept into queue commits.
      const dirtyFiles = await getDirtyNonQueueFiles(basePath);
      if (dirtyFiles.length > 0) {
        console.error('\n❌ Orchestrator repo has uncommitted changes outside of queue state:');
        for (const f of dirtyFiles.slice(0, 10)) {
          console.error(`   ${f}`);
        }
        if (dirtyFiles.length > 10) {
          console.error(`   ... and ${dirtyFiles.length - 10} more`);
        }
        console.error('\n   Commit or stash these changes before running autopilot.');
        console.error('   This prevents unrelated edits from being swept into queue commits.\n');
        process.exit(1);
      }

      const totalCycles = cycles ?? 1;
      const isMultiProject = projects && projects.length > 0;

      const autopilotLogger = startRunLogger({
        basePath,
        command: 'autopilot',
        projects: isMultiProject ? projects : (project ? [project] : undefined),
      });
      activeRunLogger = autopilotLogger;

      // Track outcomes across all cycles for the post-run vision review
      const allCompleted: { id: string; project?: string }[] = [];
      const allFailed: { id: string; project?: string; reason?: string }[] = [];
      const runMetrics = createRunMetrics();

      console.log('\n' + '═'.repeat(50));
      console.log(`🧠 AUTOPILOT MODE (job: ${autopilotLogger.jobId})`);
      console.log('═'.repeat(50));
      console.log('   The LLM proposes tasks, then executes them.');
      console.log(`   Cycles: ${totalCycles}`);
      if (isMultiProject) {
        console.log(`   Multi-project: ${projects!.join(', ')}`);
      }
      console.log('═'.repeat(50));

      const maxTasksOverride = parseInt(vars['max_tasks'] ?? '', 10);
      if (featureRatio !== undefined) {
        console.log(`   Feature ratio target: ${(featureRatio * 100).toFixed(0)}%`);
      }

      // Resolve multi-project configs once
      let multiProjectConfigs: ProjectConfig[] | undefined;
      if (isMultiProject) {
        multiProjectConfigs = [];
        for (const pid of projects!) {
          const found = registry.get(pid);
          if (!found) {
            console.error(`❌ Unknown project in --projects: ${pid}`);
            console.error(`   Available projects: ${registry.listIds().join(', ')}`);
            process.exit(1);
          }
          multiProjectConfigs.push(found);
        }
      }

      // Audit orphaned tasks and prune terminal tasks before the first cycle
      {
        const queueManager = createQueueManager(basePath);
        const orphanCount = await queueManager.auditOrphanedTasks();
        if (orphanCount > 0) {
          console.log(`\n⚠️  Found ${orphanCount} orphaned task(s) — marked as failed`);
        }
        runMetrics.orphansDetected = orphanCount;
        const pruneResult = await queueManager.prune();
        if (pruneResult.removed > 0 || orphanCount > 0) {
          console.log(`\n🧹 Pruned ${pruneResult.removed} terminal task(s), ${pruneResult.kept} remaining`);
          await commitQueueState(basePath, `Queue: prune ${pruneResult.removed} terminal tasks`);
        }
        runMetrics.tasksPruned = pruneResult.removed;
      }

      for (let cycle = 1; cycle <= totalCycles; cycle++) {
        if (totalCycles > 1) {
          console.log(`\n${'━'.repeat(50)}`);
          console.log(`🔄 Cycle ${cycle}/${totalCycles}`);
          console.log('━'.repeat(50));
        }

        // Step 0: Wiring audit — check that recent changes are fully integrated
        // before proposing new work. Only runs for multi-project mode.
        let newTasks: QueueTask[] = [];
        let wiringTasksQueued = false;

        if (multiProjectConfigs) {
          const auditResult = await runWiringAudit(
            multiProjectConfigs,
            proposerAdapter,
            basePath
          );

          if (auditResult.hasGaps && auditResult.tasks.length > 0) {
            // Deduplicate: skip tasks whose ID already exists in the queue
            const queueManager = createQueueManager(basePath);
            const existingTasks = await queueManager.list();
            const existingIds = new Set(existingTasks.map((t) => t.id));
            const dedupedTasks = auditResult.tasks.filter((t) => {
              if (existingIds.has(t.id)) {
                console.log(`   ⏭  Skipping duplicate wiring task: ${t.id}`);
                return false;
              }
              return true;
            });

            if (dedupedTasks.length > 0) {
              console.log(`\n🔌 Wiring audit found ${dedupedTasks.length} new gap(s). Prioritizing wiring over new features.`);

              const allTasks = [...existingTasks, ...dedupedTasks];
              const { writeFile: writeFs } = await import('node:fs/promises');
              const { stringify: stringifyYaml } = await import('yaml');
              const queuePath = resolve(basePath, 'tasks/queue.yaml');
              await writeFs(queuePath, stringifyYaml({ tasks: allTasks }, { lineWidth: 120 }), 'utf-8');

              console.log(`\n✅ Added ${dedupedTasks.length} wiring task(s) to queue:`);
              for (const t of dedupedTasks) {
                console.log(`   🔌 ${t.id} [${t.project ?? 'unknown'}]`);
              }

              newTasks = dedupedTasks;
              wiringTasksQueued = true;
            } else {
              console.log('  ✅ All wiring tasks already in queue — moving to feature proposals.');
            }
          }
        }

        // Step 1: Propose and queue (only if wiring audit didn't produce tasks)
        if (!wiringTasksQueued) {
          if (multiProjectConfigs) {
            const multiProposer = createMultiProjectProposer({
              adapter: proposerAdapter,
              projectConfigs: multiProjectConfigs,
              orchestratorRoot: basePath,
              registry,
              maxTasks: Number.isFinite(maxTasksOverride) ? maxTasksOverride : 5,
              featureRatio,
            });
            newTasks = await multiProposer.proposeAndQueue();
          } else {
            const proposer = createTaskProposer({
              basePath: workingPath,
              adapter: proposerAdapter,
              maxTasks: Number.isFinite(maxTasksOverride) ? maxTasksOverride : 5,
              projectConfig,
              orchestratorRoot: basePath,
              registry,
              featureRatio,
            });
            newTasks = await proposer.proposeAndQueue();
          }
        }

        runMetrics.tasksProposed += newTasks.length;

        if (newTasks.length === 0) {
          console.log('\n✅ Nothing to do — LLM found no new tasks.');
          if (cycle < totalCycles) {
            console.log('   Stopping early: no tasks proposed.');
          }
          break;
        }

        // Commit queue state before scheduler starts (targeted — only queue files)
        await commitQueueState(basePath, `Queue: add ${newTasks.length} proposed tasks`);

        // Step 2: Run all pending tasks
        const scheduler = createScheduler({
          basePath,
          adapters,
          defaultAgent: agentToUse,
          registry,
          onTaskStart: setCurrentTask,
          onTaskEnd: () => setCurrentTask(null),
        });

        const loopResult = await scheduler.loop();
        const results = loopResult.tasks;
        const failed = results.filter((r) => !r.success).length;
        const passed = results.filter((r) => r.success).length;

        // Accumulate metrics
        runMetrics.cyclesRan++;
        runMetrics.tasksExecuted += results.length;
        runMetrics.tasksPassed += passed;
        runMetrics.tasksFailed += failed;
        runMetrics.tasksMerged += loopResult.merged;
        runMetrics.tasksEscalated += loopResult.escalated;

        // Track outcomes for vision review
        for (const r of results) {
          if (r.success) {
            allCompleted.push({ id: r.taskId, project: r.projectId });
          } else {
            allFailed.push({ id: r.taskId, project: r.projectId, reason: r.error });
          }
        }

        if (failed > 0) {
          console.log(`\n⚠️  Cycle ${cycle}: ${failed} failure(s), ${passed} success(es). Continuing.`);
        } else {
          console.log(`\n✅ Cycle ${cycle}: ${passed} task(s) completed successfully.`);
        }
      }

      // Post-merge wiring audit — catch cross-project contract drift caused
      // by tasks that merged during this run. The pre-cycle audit (Step 0)
      // only sees changes from BEFORE the run. This catches gaps introduced
      // by the current run's merges (e.g., backend response shape changed
      // but no UI task updated the consumer). Queued tasks are picked up on
      // the next run — nothing is executed here.
      if (multiProjectConfigs && runMetrics.tasksMerged > 0) {
        console.log(`\n${'━'.repeat(50)}`);
        console.log('🔌 POST-MERGE WIRING AUDIT');
        console.log('━'.repeat(50));

        try {
          const postMergeAudit = await runWiringAudit(
            multiProjectConfigs,
            proposerAdapter,
            basePath
          );

          if (postMergeAudit.hasGaps && postMergeAudit.tasks.length > 0) {
            const qm = createQueueManager(basePath);
            const existingTasks = await qm.list();
            const existingIds = new Set(existingTasks.map((t) => t.id));
            const dedupedTasks = postMergeAudit.tasks.filter((t) => !existingIds.has(t.id));

            if (dedupedTasks.length > 0) {
              const { writeFile: writeFs } = await import('node:fs/promises');
              const { stringify: stringifyYaml } = await import('yaml');
              const queuePath = resolve(basePath, 'tasks/queue.yaml');
              const allTasks = [...existingTasks, ...dedupedTasks];
              await writeFs(queuePath, stringifyYaml({ tasks: allTasks }, { lineWidth: 120 }), 'utf-8');
              await commitQueueState(basePath, `Queue: ${dedupedTasks.length} wiring fix(es) from post-merge audit`);

              console.log(`  🔌 Queued ${dedupedTasks.length} wiring fix(es) for next run:`);
              for (const t of dedupedTasks) {
                console.log(`     → ${t.id} [${t.project ?? 'unknown'}]`);
              }
            } else {
              console.log('  ✅ No new wiring gaps (all already queued).');
            }
          } else {
            console.log('  ✅ No cross-project wiring gaps detected.');
          }
        } catch (err) {
          console.log(`  ⚠️  Post-merge wiring audit failed: ${err instanceof Error ? err.message : err}`);
        }
      }

      // Sweep queue for terminal failures the scheduler results missed
      // (escalated, orphaned, abandoned/skipped tasks). Also reclassify
      // tasks that passed execution but were escalated during merge —
      // those should be in allFailed, not allCompleted.
      {
        const qm = createQueueManager(basePath);
        const terminalFailures = await qm.getTerminalFailures();
        const failedIds = new Set(allFailed.map((t) => t.id));
        const terminalIds = new Set(terminalFailures.map((tf) => tf.id));

        for (const tf of terminalFailures) {
          if (!failedIds.has(tf.id)) {
            allFailed.push(tf);
            failedIds.add(tf.id);
          }
        }

        // Remove escalated/failed tasks from allCompleted (they passed
        // execution but the merge was rejected, so they aren't "completed")
        const completedBefore = allCompleted.length;
        const cleaned = allCompleted.filter((t) => !terminalIds.has(t.id));
        if (cleaned.length < completedBefore) {
          allCompleted.length = 0;
          allCompleted.push(...cleaned);
        }
      }

      // Post-run vision review — update priorities based on what was accomplished
      if (allCompleted.length > 0 || allFailed.length > 0) {
        console.log(`\n${'━'.repeat(50)}`);
        console.log('🔮 POST-RUN VISION REVIEW');
        console.log('━'.repeat(50));

        try {
          const runEnvironment = multiProjectConfigs?.find((pc) => pc.environment)?.environment;
          const visionResult = await reviewAndUpdateVision(basePath, proposerAdapter, {
            completedTasks: allCompleted,
            failedTasks: allFailed,
            environment: runEnvironment,
          });
          if (visionResult.updated) {
            await commitVisionUpdate(basePath, 'Vision: update priorities after autopilot run');
          } else if (visionResult.error) {
            console.log(`   ⚠️  Vision review issue: ${visionResult.error}`);
          }
        } catch (err) {
          console.log(`   ⚠️  Vision review failed: ${err instanceof Error ? err.message : err}`);
        }
      }

      // Post-run sanity check — cross-reference metrics against queue state
      {
        const sanityResult = await runSanityCheck(basePath, runMetrics);
        printSanityCheck(sanityResult);

        if (!sanityResult.healthy) {
          console.log('\n⚠️  Sanity check flagged issues. Review the checks above before the next run.');
        }
      }

      // Final cleanup: restore all external projects to main so the
      // working directories aren't left on stale feature branches.
      // Without this, manual fixes made between autopilot runs land on
      // whatever branch the last task used — and never reach main.
      if (multiProjectConfigs) {
        console.log(`\n${'━'.repeat(50)}`);
        console.log('🧹 RESTORING PROJECTS TO MAIN');
        console.log('━'.repeat(50));
        for (const pc of multiProjectConfigs) {
          const result = await syncMainFromRemote(pc.path).catch(() => ({ success: false }));
          console.log(`  ${result.success ? '✅' : '⚠️ '} ${pc.name ?? pc.path}`);
        }
      }

      autopilotLogger.stop();
      break;
    }

    case 'wire': {
      const agentToUse = agent ?? config.defaultAgent;
      if (agentToUse === 'cursor') {
        console.error('❌ Wire audit requires a real LLM agent. Use --agent openai');
        process.exit(1);
      }
      validateConfig(config, agentToUse);

      const wireAdapter = adapters[agentToUse];
      if (!wireAdapter) {
        console.error(`❌ No adapter for agent: ${agentToUse}`);
        process.exit(1);
      }

      // Require --projects
      if (!projects || projects.length === 0) {
        console.error('❌ Wire audit requires --projects flag (e.g., --projects my-api,my-frontend)');
        process.exit(1);
      }

      const wireProjectConfigs: ProjectConfig[] = [];
      for (const pid of projects) {
        const found = registry.get(pid);
        if (!found) {
          console.error(`❌ Unknown project: ${pid}`);
          console.error(`   Available projects: ${registry.listIds().join(', ')}`);
          process.exit(1);
        }
        wireProjectConfigs.push(found);
      }

      const auditResult = await runWiringAudit(
        wireProjectConfigs,
        wireAdapter,
        basePath
      );

      if (auditResult.hasGaps) {
        console.log(`\n📋 Wiring tasks that would be queued:\n`);
        for (const t of auditResult.tasks) {
          console.log(`  🔌 ${t.id}`);
          console.log(`     Project: ${t.project ?? 'unknown'}`);
          if ((t as any).variables?.modification_description) {
            console.log(`     ${(t as any).variables.modification_description.slice(0, 120)}...`);
          }
          console.log('');
        }
        console.log('ℹ️  This is read-only. Use "autopilot" to execute wiring tasks automatically.');
      } else {
        console.log('\n✅ All wired up. No integration gaps found.');
      }
      break;
    }

    case 'merge': {
      const agentToUse = agent ?? config.defaultAgent;
      if (agentToUse === 'cursor') {
        console.error('❌ Merge pipeline requires a real LLM agent. Use --agent openai');
        process.exit(1);
      }
      validateConfig(config, agentToUse);

      const mergeLogger = startRunLogger({ basePath, command: 'merge', projects: project ? [project] : undefined });
      activeRunLogger = mergeLogger;

      const mergePipeline = createMergePipeline({
        adapters,
        defaultAgent: agentToUse,
        registry,
        basePath,
      });

      const mergeResults = await mergePipeline.runFromQueue();
      mergeLogger.stop();

      if (mergeResults.escalated > 0) {
        console.log(`\n⚠️  ${mergeResults.escalated} branch(es) need manual attention — check GitHub Issues.`);
      }
      if (mergeResults.failed > 0) {
        process.exit(1);
      }
      break;
    }

    case 'prune': {
      const queueManager = createQueueManager(basePath);
      const result = await queueManager.prune();

      if (result.removed === 0) {
        console.log('\n✅ Queue is already clean — nothing to prune.');
      } else {
        console.log(`\n🧹 Pruned ${result.removed} terminal task(s), ${result.kept} remaining`);
        await commitQueueState(basePath, `Queue: prune ${result.removed} terminal tasks`);
        console.log('   Queue state committed.');
      }
      break;
    }

    case 'queue': {
      const scheduler = createScheduler({
        basePath: workingPath,
        adapters,
        defaultAgent: agent ?? config.defaultAgent,
        projectConfig,
        registry,
      });
      await scheduler.status();
      break;
    }

    case 'list': {
      await runner.list();
      break;
    }

    case 'resume': {
      const executionId = positional[0];
      if (!executionId) {
        console.error('❌ Usage: resume <executionId>');
        process.exit(1);
      }
      await runner.resume(executionId);
      break;
    }

    default:
      console.error(`❌ Unknown command: ${command}`);
      printUsage();
      process.exit(1);
  }
}

function printUsage() {
  console.log(`
🤖 Agentic Workflow Orchestrator

Usage:
  npx tsx src/cli.ts projects                          List available projects
  npx tsx src/cli.ts run <workflow.yaml> [options]     Run a prompt workflow (output to files)
  npx tsx src/cli.ts auto <workflow.yaml> [options]    Run autonomous workflow (writes → verifies → commits)
  npx tsx src/cli.ts next [--agent] [--project]        Run next pending task from queue
  npx tsx src/cli.ts schedule [loop|watch] [options]   Run all pending tasks or poll continuously
  npx tsx src/cli.ts propose [preview|queue] [options] LLM analyzes codebase and proposes new tasks
  npx tsx src/cli.ts autopilot [options]               Full loop: propose tasks → execute them
  npx tsx src/cli.ts wire --projects <a,b> [--agent]   Read-only wiring audit across projects
  npx tsx src/cli.ts merge [--agent] [--project]       Merge completed branches via PR pipeline
  npx tsx src/cli.ts prune                              Remove completed/skipped/failed tasks from queue
  npx tsx src/cli.ts queue [--project]                 Show task queue status
  npx tsx src/cli.ts list                              List workflow executions
  npx tsx src/cli.ts resume <executionId>              Resume failed workflow

Options:
  --var key=value       Override workflow variable
  --agent <name>        Override agent (anthropic|openai|codex|cursor)
  --project <id>        Target project (default: orchestrator)
  --projects <a,b>      Multi-project mode — propose tasks across projects with depends_on
  --feature-ratio <n>   Min ratio of feature/architecture tasks (0-1, e.g., 0.4 = 40%)
  --cycles <n>          Number of propose→execute cycles for autopilot (default: 1)
  --auto-merge          Accepted for clarity (merge pipeline runs automatically)

Autonomous:
  propose preview       LLM proposes tasks — show them without adding to queue
  propose queue         LLM proposes tasks — add them to tasks/queue.yaml
  autopilot             Propose + execute in one shot (fully autonomous)

Scheduler:
  next                  Pick and run one pending task
  schedule loop         Run all pending tasks sequentially (auto-merges via PR pipeline)
  schedule watch        Run all pending, poll for new tasks every 5 min
  prune                 Remove terminal tasks (keeps pending + their deps)
  queue                 Print current queue status

Merge Pipeline:
  merge                 Merge all completed branches via GitHub PR pipeline
                        Creates PRs, LLM reviews diffs, handles CI failures/conflicts,
                        escalates unresolvable issues to GitHub Issues

Examples:
  npx tsx src/cli.ts projects
  npx tsx src/cli.ts auto workflows/auto-sample.yaml --agent openai
  npx tsx src/cli.ts propose preview --agent openai --project my-api
  npx tsx src/cli.ts propose preview --agent openai --projects my-api,my-frontend
  npx tsx src/cli.ts autopilot --agent openai --project my-frontend --cycles 10
  npx tsx src/cli.ts autopilot --agent openai --projects my-api,my-frontend --cycles 3
  npx tsx src/cli.ts autopilot --agent openai --project my-api --feature-ratio 0.4 --cycles 5
  npx tsx src/cli.ts wire --projects my-api,my-frontend --agent openai
  npx tsx src/cli.ts schedule loop --agent openai
  npx tsx src/cli.ts merge --agent openai
  npx tsx src/cli.ts queue
`);
}

main().catch((err) => {
  console.error('❌ Fatal error:', err.message ?? err);
  releaseLock();
  process.exit(1);
});
