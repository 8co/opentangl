/**
 * Queue Manager
 * Reads and writes the task queue file (tasks/queue.yaml).
 * Picks the next pending task, updates status after execution.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

// --- Types ---

export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

export type MergeStatus = 'pending' | 'in_progress' | 'merged' | 'escalated';

export interface QueueTask {
  id: string;
  status: TaskStatus;
  workflow: string;
  prompt: string;
  project?: string;            // Project ID from registry (undefined = orchestrator)
  task_type?: 'feature' | 'architecture' | 'maintenance'; // Task classification from proposer
  depends_on?: string[];       // Task IDs that must be completed+merged before this task runs
  context_files?: string[];
  variables?: Record<string, string>;
  error?: string;
  started_at?: string;
  completed_at?: string;
  branch?: string;
  // Merge pipeline fields (Phase 2)
  merge_status?: MergeStatus;
  pr_number?: number;
  pr_url?: string;
  issue_url?: string;
  merge_attempts?: number;
}

interface QueueFile {
  tasks: QueueTask[];
}

// --- Dependency helpers ---

type DepCheckResult = 'met' | 'waiting' | 'failed';

/**
 * Check whether all dependencies for a task are satisfied.
 * - 'met': all deps completed+merged (or completed with no branch, e.g. orchestrator tasks)
 * - 'waiting': at least one dep is still pending/running/in-progress
 * - 'failed': at least one dep failed, was skipped, or had its merge escalated
 */
function checkDependencies(depIds: string[], allTasks: QueueTask[]): DepCheckResult {
  for (const depId of depIds) {
    const dep = allTasks.find((t) => t.id === depId);

    if (!dep) return 'waiting'; // Unknown dep — treat as unmet (orphaned ref)

    if (dep.status === 'failed' || dep.status === 'skipped') return 'failed';
    if (dep.merge_status === 'escalated') return 'failed';

    // Dep must be completed
    if (dep.status !== 'completed') return 'waiting';

    // If it has a branch, it must be merged
    if (dep.branch && dep.merge_status !== 'merged') return 'waiting';
  }

  return 'met';
}

/**
 * Detect circular dependencies via DFS.
 * Returns the cycle path if found, or null if no cycle.
 */
export function detectCycle(tasks: QueueTask[]): string[] | null {
  const graph = new Map<string, string[]>();
  for (const task of tasks) {
    graph.set(task.id, task.depends_on ?? []);
  }

  const visited = new Set<string>();
  const inStack = new Set<string>();
  const path: string[] = [];

  function dfs(nodeId: string): boolean {
    if (inStack.has(nodeId)) {
      path.push(nodeId);
      return true;
    }
    if (visited.has(nodeId)) return false;

    visited.add(nodeId);
    inStack.add(nodeId);
    path.push(nodeId);

    for (const depId of graph.get(nodeId) ?? []) {
      if (dfs(depId)) return true;
    }

    path.pop();
    inStack.delete(nodeId);
    return false;
  }

  for (const task of tasks) {
    if (!visited.has(task.id)) {
      if (dfs(task.id)) return path;
    }
  }

  return null;
}

// --- Manager ---

export function createQueueManager(basePath: string, queuePath = 'tasks/queue.yaml') {
  const fullPath = resolve(basePath, queuePath);

  async function load(): Promise<QueueFile> {
    const raw = await readFile(fullPath, 'utf-8');
    return parseYaml(raw) as QueueFile;
  }

  async function save(queue: QueueFile): Promise<void> {
    const yaml = stringifyYaml(queue, {
      lineWidth: 120,
      defaultKeyType: 'PLAIN',
      defaultStringType: 'PLAIN',
    });
    await writeFile(fullPath, yaml, 'utf-8');
  }

  return {
    /**
     * Get all tasks in the queue.
     */
    async list(): Promise<QueueTask[]> {
      const queue = await load();
      return queue.tasks;
    },

    /**
     * Get the next pending task whose dependencies are all satisfied.
     * A dependency is satisfied when its task is completed+merged (or has no merge needed).
     * Tasks blocked by failed/escalated deps are auto-skipped.
     */
    async next(): Promise<QueueTask | null> {
      const queue = await load();
      let didSkip = false;

      for (const task of queue.tasks) {
        if (task.status !== 'pending') continue;
        if (!task.depends_on || task.depends_on.length === 0) return task;

        const depStatus = checkDependencies(task.depends_on, queue.tasks);

        if (depStatus === 'met') return task;

        if (depStatus === 'failed') {
          const failedDeps = task.depends_on.filter((depId) => {
            const dep = queue.tasks.find((t) => t.id === depId);
            return dep && (dep.status === 'failed' || dep.status === 'skipped' || dep.merge_status === 'escalated');
          });
          task.status = 'skipped';
          task.error = `Dependency failed: ${failedDeps.join(', ')}`;
          task.completed_at = new Date().toISOString();
          didSkip = true;
          console.log(`  ⏭  Skipping "${task.id}" — ${task.error}`);
        }
        // depStatus === 'waiting' — skip to next candidate
      }

      if (didSkip) await save(queue);
      return null;
    },

    /**
     * Get a task count summary.
     */
    async summary(): Promise<Record<TaskStatus, number>> {
      const queue = await load();
      const counts: Record<TaskStatus, number> = {
        pending: 0,
        running: 0,
        completed: 0,
        failed: 0,
        skipped: 0,
      };
      for (const task of queue.tasks) {
        counts[task.status]++;
      }
      return counts;
    },

    /**
     * Look up a single task by ID. Returns null if not found.
     */
    async getTask(taskId: string): Promise<QueueTask | null> {
      const queue = await load();
      return queue.tasks.find((t) => t.id === taskId) ?? null;
    },

    /**
     * Mark a task as running.
     */
    async markRunning(taskId: string): Promise<void> {
      const queue = await load();
      const task = queue.tasks.find((t) => t.id === taskId);
      if (!task) throw new Error(`Task not found: ${taskId}`);

      task.status = 'running';
      task.started_at = new Date().toISOString();
      await save(queue);
    },

    /**
     * Mark a task as completed.
     */
    async markCompleted(taskId: string, branch?: string): Promise<void> {
      const queue = await load();
      const task = queue.tasks.find((t) => t.id === taskId);
      if (!task) throw new Error(`Task not found: ${taskId}`);

      task.status = 'completed';
      task.completed_at = new Date().toISOString();
      if (branch) task.branch = branch;
      task.error = undefined;
      await save(queue);
    },

    /**
     * Mark a task as failed with an error message.
     */
    async markFailed(taskId: string, error: string): Promise<void> {
      const queue = await load();
      const task = queue.tasks.find((t) => t.id === taskId);
      if (!task) throw new Error(`Task not found: ${taskId}`);

      task.status = 'failed';
      task.completed_at = new Date().toISOString();
      task.error = error;
      await save(queue);
    },

    /**
     * Reset a failed task back to pending (for retry).
     */
    async resetTask(taskId: string): Promise<void> {
      const queue = await load();
      const task = queue.tasks.find((t) => t.id === taskId);
      if (!task) throw new Error(`Task not found: ${taskId}`);

      task.status = 'pending';
      task.error = undefined;
      task.started_at = undefined;
      task.completed_at = undefined;
      await save(queue);
    },

    /**
     * Get all completed tasks that have a branch but haven't been merged yet.
     * These are candidates for the merge pipeline.
     */
    async getMergePending(): Promise<QueueTask[]> {
      const queue = await load();
      return queue.tasks.filter((t) =>
        t.status === 'completed' &&
        t.branch &&
        (!t.merge_status || t.merge_status === 'pending')
      );
    },

    /**
     * Mark a task's merge as in progress.
     */
    async markMergeInProgress(taskId: string, prNumber: number, prUrl: string): Promise<void> {
      const queue = await load();
      const task = queue.tasks.find((t) => t.id === taskId);
      if (!task) throw new Error(`Task not found: ${taskId}`);

      task.merge_status = 'in_progress';
      task.pr_number = prNumber;
      task.pr_url = prUrl;
      task.merge_attempts = (task.merge_attempts ?? 0);
      await save(queue);
    },

    /**
     * Increment the merge attempt counter for a task.
     */
    async incrementMergeAttempt(taskId: string): Promise<void> {
      const queue = await load();
      const task = queue.tasks.find((t) => t.id === taskId);
      if (!task) throw new Error(`Task not found: ${taskId}`);

      task.merge_attempts = (task.merge_attempts ?? 0) + 1;
      await save(queue);
    },

    /**
     * Mark a task as successfully merged.
     */
    async markMerged(taskId: string, prUrl: string): Promise<void> {
      const queue = await load();
      const task = queue.tasks.find((t) => t.id === taskId);
      if (!task) throw new Error(`Task not found: ${taskId}`);

      task.merge_status = 'merged';
      task.pr_url = prUrl;
      await save(queue);
    },

    /**
     * Mark a task as escalated (unresolvable, GitHub Issue created).
     */
    async markEscalated(taskId: string, issueUrl: string, reason?: string): Promise<void> {
      const queue = await load();
      const task = queue.tasks.find((t) => t.id === taskId);
      if (!task) throw new Error(`Task not found: ${taskId}`);

      task.merge_status = 'escalated';
      task.issue_url = issueUrl;
      if (reason) task.error = reason;
      await save(queue);
    },

    /**
     * Get all pending tasks that depend on a given task ID.
     */
    async getDependents(taskId: string): Promise<QueueTask[]> {
      const queue = await load();
      return queue.tasks.filter((t) =>
        t.status === 'pending' && t.depends_on?.includes(taskId)
      );
    },

    /**
     * Check if any pending task depends on a given task ID.
     */
    async hasDependents(taskId: string): Promise<boolean> {
      const dependents = await this.getDependents(taskId);
      return dependents.length > 0;
    },

    /**
     * Mark a task as skipped (dependency failed or manual skip).
     */
    async markSkipped(taskId: string, reason: string): Promise<void> {
      const queue = await load();
      const task = queue.tasks.find((t) => t.id === taskId);
      if (!task) throw new Error(`Task not found: ${taskId}`);

      task.status = 'skipped';
      task.error = reason;
      task.completed_at = new Date().toISOString();
      await save(queue);
    },

    /**
     * Reset any tasks stuck in 'running' status to 'failed'.
     * Called on startup after acquiring the process lock to clean up
     * tasks left behind by a previously crashed process.
     */
    async resetStaleTasks(): Promise<number> {
      const queue = await load();
      let count = 0;
      for (const task of queue.tasks) {
        if (task.status === 'running') {
          task.status = 'failed';
          task.error = 'Process exited while task was running';
          task.completed_at = new Date().toISOString();
          count++;
        }
      }
      if (count > 0) await save(queue);
      return count;
    },

    /**
     * Detect completed tasks with a branch that the merge pipeline never processed.
     * This happens when the scheduler crashes between markCompleted and merge,
     * or when the branch is lost/deleted before pushing.
     * Marks orphaned tasks as failed so their dependents get properly skipped
     * instead of waiting forever.
     */
    async auditOrphanedTasks(): Promise<number> {
      const queue = await load();
      let count = 0;
      for (const task of queue.tasks) {
        if (
          task.status === 'completed' &&
          task.branch &&
          !task.merge_status
        ) {
          task.status = 'failed';
          task.error = 'Orphaned: completed with branch but merge pipeline never ran';
          count++;
          console.log(`  ⚠️  Orphaned task "${task.id}" — marked failed (branch: ${task.branch}, no merge_status)`);
        }
      }
      if (count > 0) await save(queue);
      return count;
    },

    /**
     * Get all tasks with terminal negative outcomes: failed, orphaned,
     * escalated, or abandoned/skipped. Used by the vision review to ensure
     * ALL problem tasks are reported, not just execution failures.
     */
    async getTerminalFailures(): Promise<{ id: string; project?: string; reason?: string }[]> {
      const queue = await load();
      const failures: { id: string; project?: string; reason?: string }[] = [];

      for (const t of queue.tasks) {
        if (t.status === 'failed') {
          failures.push({ id: t.id, project: t.project, reason: t.error ?? 'Failed (no details)' });
        } else if (t.status === 'skipped' && t.error) {
          failures.push({ id: t.id, project: t.project, reason: t.error });
        } else if (t.status === 'completed' && t.merge_status === 'escalated') {
          failures.push({ id: t.id, project: t.project, reason: t.error ?? 'Escalated by merge pipeline' });
        }
      }

      return failures;
    },

    /**
     * Get all escalated tasks that haven't been re-queued yet.
     * These are completed tasks whose merge was rejected by the reviewer
     * and whose underlying problem remains unresolved.
     */
    async getEscalated(): Promise<QueueTask[]> {
      const queue = await load();
      return queue.tasks.filter((t) =>
        t.status === 'completed' &&
        t.merge_status === 'escalated'
      );
    },

    /**
     * Re-queue escalated tasks as new pending retry tasks.
     * The original task is marked as skipped so it won't be re-queued again.
     * The retry task carries the reviewer's concerns so the agent can
     * address them in its next attempt.
     */
    async requeueEscalated(): Promise<QueueTask[]> {
      const MAX_RETRY_DEPTH = 2;
      const queue = await load();
      const escalated = queue.tasks.filter((t) =>
        t.status === 'completed' &&
        t.merge_status === 'escalated'
      );

      if (escalated.length === 0) return [];

      const existingIds = new Set(queue.tasks.map((t) => t.id));
      const retryTasks: QueueTask[] = [];

      for (const original of escalated) {
        const retryId = `retry-${original.id}`;
        if (existingIds.has(retryId)) continue;

        const retryDepth = (original.id.match(/^(retry-)+/)?.[0] ?? '').split('retry-').length - 1;
        if (retryDepth >= MAX_RETRY_DEPTH) {
          console.log(`  ⛔ Skipping re-queue for "${original.id}" — max retry depth (${MAX_RETRY_DEPTH}) reached`);
          original.status = 'skipped';
          original.error = `Abandoned after ${retryDepth} retries — requires manual intervention`;
          continue;
        }

        const reviewerFeedback = original.error ?? 'Escalated by merge pipeline';
        const retryPrompt = original.prompt;
        const retryVars = {
          ...original.variables,
          previous_escalation_reason: reviewerFeedback,
          retry_of: original.id,
        };

        const retryTask: QueueTask = {
          id: retryId,
          status: 'pending',
          workflow: original.workflow,
          prompt: retryPrompt,
          ...(original.project ? { project: original.project } : {}),
          ...(original.task_type ? { task_type: original.task_type } : {}),
          context_files: original.context_files,
          variables: retryVars,
        };

        retryTasks.push(retryTask);
        queue.tasks.push(retryTask);
        existingIds.add(retryId);

        original.status = 'skipped';
        original.error = `Re-queued as ${retryId}`;
      }

      if (retryTasks.length > 0) {
        await save(queue);
      }

      return retryTasks;
    },

    /**
     * Remove terminal tasks (completed+merged, skipped, failed, cancelled)
     * that no pending/running task depends on.
     * Keeps the dependency chain intact for any active work.
     * Returns the number of tasks removed.
     */
    async prune(): Promise<{ removed: number; kept: number; removedIds: string[] }> {
      const queue = await load();
      const tasks = queue.tasks;

      const active = tasks.filter((t) =>
        t.status === 'pending' || t.status === 'running'
      );

      // Recursively collect all task IDs that active tasks depend on
      const keepIds = new Set<string>(active.map((t) => t.id));
      const taskMap = new Map(tasks.map((t) => [t.id, t]));

      function walkDeps(taskId: string): void {
        const task = taskMap.get(taskId);
        if (!task?.depends_on) return;
        for (const depId of task.depends_on) {
          if (!keepIds.has(depId)) {
            keepIds.add(depId);
            walkDeps(depId);
          }
        }
      }

      for (const task of active) {
        walkDeps(task.id);
      }

      const removedIds: string[] = [];
      const kept: QueueTask[] = [];

      for (const task of tasks) {
        if (keepIds.has(task.id)) {
          kept.push(task);
        } else {
          removedIds.push(task.id);
        }
      }

      if (removedIds.length > 0) {
        queue.tasks = kept;
        await save(queue);
      }

      return { removed: removedIds.length, kept: kept.length, removedIds };
    },

    /**
     * Print a formatted summary of the queue.
     */
    async print(): Promise<void> {
      const queue = await load();
      const counts = await this.summary();

      console.log('\n📋 Task Queue\n');
      console.log(`   Pending: ${counts.pending} | Completed: ${counts.completed} | Failed: ${counts.failed}\n`);

      for (const task of queue.tasks) {
        const icon =
          task.status === 'completed' ? '✅' :
          task.status === 'failed' ? '❌' :
          task.status === 'running' ? '▶' :
          task.status === 'skipped' ? '⏭' : '⏳';

        console.log(`  ${icon} ${task.id} (${task.status})`);
        if (task.depends_on && task.depends_on.length > 0) {
          console.log(`     Depends on: ${task.depends_on.join(', ')}`);
        }
        if (task.error) {
          console.log(`     Error: ${task.error.slice(0, 100)}`);
        }
        if (task.branch) {
          console.log(`     Branch: ${task.branch}`);
        }
      }
      console.log('');
    },
  };
}

