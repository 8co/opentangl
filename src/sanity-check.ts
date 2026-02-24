/**
 * Post-Run Sanity Check
 * Cross-references run metrics against queue state to detect inconsistencies.
 * Runs at the end of autopilot/scheduler loops to flag anything that doesn't add up.
 */

import { createQueueManager, type QueueTask, type TaskStatus, type MergeStatus } from './queue-manager.js';

// --- Types ---

export interface RunMetrics {
  cyclesRan: number;
  tasksProposed: number;
  tasksExecuted: number;
  tasksPassed: number;
  tasksFailed: number;
  tasksMerged: number;
  tasksEscalated: number;
  tasksSkippedByDeps: number;
  orphansDetected: number;
  tasksPruned: number;
}

export interface SanityCheckResult {
  healthy: boolean;
  score: number;            // 0-100, where 100 = everything checks out
  checks: CheckResult[];
  metrics: RunMetrics;
  queueSnapshot: QueueSnapshot;
}

interface CheckResult {
  name: string;
  passed: boolean;
  severity: 'critical' | 'warning' | 'info';
  message: string;
}

interface QueueSnapshot {
  total: number;
  byStatus: Record<TaskStatus, number>;
  pendingWithMetDeps: number;
  pendingWithBlockedDeps: number;
  orphanedCompleted: number;
  completedUnmerged: number;
  runningTasks: number;
}

// --- Snapshot builder ---

function buildQueueSnapshot(tasks: QueueTask[]): QueueSnapshot {
  const byStatus: Record<TaskStatus, number> = {
    pending: 0, running: 0, completed: 0, failed: 0, skipped: 0,
  };

  let pendingWithMetDeps = 0;
  let pendingWithBlockedDeps = 0;
  let orphanedCompleted = 0;
  let completedUnmerged = 0;
  let runningTasks = 0;

  for (const task of tasks) {
    byStatus[task.status]++;

    if (task.status === 'running') {
      runningTasks++;
    }

    if (task.status === 'completed' && task.branch && !task.merge_status) {
      orphanedCompleted++;
    }

    if (task.status === 'completed' && task.branch && task.merge_status !== 'merged') {
      completedUnmerged++;
    }

    if (task.status === 'pending') {
      if (!task.depends_on || task.depends_on.length === 0) {
        pendingWithMetDeps++;
      } else {
        const allMet = task.depends_on.every((depId) => {
          const dep = tasks.find((t) => t.id === depId);
          if (!dep) return false;
          if (dep.status !== 'completed') return false;
          if (dep.branch && dep.merge_status !== 'merged') return false;
          return true;
        });

        const anyFailed = task.depends_on.some((depId) => {
          const dep = tasks.find((t) => t.id === depId);
          return dep && (dep.status === 'failed' || dep.status === 'skipped' || dep.merge_status === 'escalated');
        });

        if (allMet) {
          pendingWithMetDeps++;
        } else if (anyFailed) {
          pendingWithBlockedDeps++;
        }
      }
    }
  }

  return {
    total: tasks.length,
    byStatus,
    pendingWithMetDeps,
    pendingWithBlockedDeps,
    orphanedCompleted,
    completedUnmerged,
    runningTasks,
  };
}

// --- Check definitions ---

function runChecks(metrics: RunMetrics, snapshot: QueueSnapshot): CheckResult[] {
  const checks: CheckResult[] = [];

  // 1. No tasks stuck in running
  checks.push({
    name: 'no-running-tasks',
    passed: snapshot.runningTasks === 0,
    severity: 'critical',
    message: snapshot.runningTasks === 0
      ? 'No tasks stuck in running state'
      : `${snapshot.runningTasks} task(s) still in running state — possible crash during execution`,
  });

  // 2. No orphaned completions (completed + branch + no merge_status)
  checks.push({
    name: 'no-orphaned-completions',
    passed: snapshot.orphanedCompleted === 0,
    severity: 'critical',
    message: snapshot.orphanedCompleted === 0
      ? 'No orphaned completions'
      : `${snapshot.orphanedCompleted} completed task(s) have a branch but no merge_status — merge pipeline never ran`,
  });

  // 3. No pending tasks with met deps that should have been picked up
  checks.push({
    name: 'no-stuck-pending',
    passed: snapshot.pendingWithMetDeps === 0,
    severity: 'warning',
    message: snapshot.pendingWithMetDeps === 0
      ? 'No pending tasks with satisfiable deps left behind'
      : `${snapshot.pendingWithMetDeps} pending task(s) have all deps met but were not executed`,
  });

  // 4. Execution count reconciles: passed + failed = executed
  const executionSumMatch = metrics.tasksPassed + metrics.tasksFailed === metrics.tasksExecuted;
  checks.push({
    name: 'execution-sum',
    passed: executionSumMatch,
    severity: 'critical',
    message: executionSumMatch
      ? `Execution sum checks out: ${metrics.tasksPassed} passed + ${metrics.tasksFailed} failed = ${metrics.tasksExecuted}`
      : `Execution mismatch: ${metrics.tasksPassed} passed + ${metrics.tasksFailed} failed ≠ ${metrics.tasksExecuted} executed`,
  });

  // 5. Proposed >= executed (can't execute more than proposed + pre-existing pending)
  checks.push({
    name: 'proposed-vs-executed',
    passed: metrics.tasksProposed >= metrics.tasksExecuted || metrics.tasksExecuted === 0,
    severity: 'warning',
    message: metrics.tasksProposed >= metrics.tasksExecuted
      ? `Proposed (${metrics.tasksProposed}) >= executed (${metrics.tasksExecuted})`
      : `Executed ${metrics.tasksExecuted} tasks but only proposed ${metrics.tasksProposed} — pre-existing pending tasks may account for the difference`,
  });

  // 6. Merge pipeline coverage: all passed tasks should have a merge outcome
  const passedWithoutMerge = metrics.tasksPassed - metrics.tasksMerged - metrics.tasksEscalated;
  checks.push({
    name: 'merge-coverage',
    passed: passedWithoutMerge <= 0,
    severity: 'warning',
    message: passedWithoutMerge <= 0
      ? `All passed tasks have a merge outcome (${metrics.tasksMerged} merged, ${metrics.tasksEscalated} escalated)`
      : `${passedWithoutMerge} passed task(s) have no merge outcome — possible merge pipeline gap`,
  });

  // 7. Zero pass rate with tasks executed is concerning
  if (metrics.tasksExecuted > 0) {
    const passRate = metrics.tasksPassed / metrics.tasksExecuted;
    checks.push({
      name: 'pass-rate',
      passed: passRate > 0,
      severity: passRate === 0 ? 'critical' : 'info',
      message: passRate === 0
        ? `0% pass rate across ${metrics.tasksExecuted} task(s) — systemic failure likely`
        : `Pass rate: ${(passRate * 100).toFixed(0)}% (${metrics.tasksPassed}/${metrics.tasksExecuted})`,
    });
  }

  // 8. Queue should be lean after prune (not accumulating unboundedly)
  const queueBloat = snapshot.total > 50;
  checks.push({
    name: 'queue-size',
    passed: !queueBloat,
    severity: 'warning',
    message: queueBloat
      ? `Queue has ${snapshot.total} tasks — may need manual cleanup`
      : `Queue size healthy: ${snapshot.total} task(s)`,
  });

  // 9. No pending tasks blocked by permanently failed deps (should have been auto-skipped)
  checks.push({
    name: 'no-blocked-pending',
    passed: snapshot.pendingWithBlockedDeps === 0,
    severity: 'warning',
    message: snapshot.pendingWithBlockedDeps === 0
      ? 'No pending tasks blocked by failed dependencies'
      : `${snapshot.pendingWithBlockedDeps} pending task(s) blocked by failed/skipped deps — should have been auto-skipped`,
  });

  // 10. If cycles > 0 but nothing was proposed, something may be wrong with the proposer
  if (metrics.cyclesRan > 0) {
    checks.push({
      name: 'proposer-output',
      passed: metrics.tasksProposed > 0,
      severity: metrics.tasksProposed === 0 ? 'warning' : 'info',
      message: metrics.tasksProposed === 0
        ? `${metrics.cyclesRan} cycle(s) ran but 0 tasks proposed — LLM may be stuck or vision exhausted`
        : `${metrics.tasksProposed} task(s) proposed across ${metrics.cyclesRan} cycle(s)`,
    });
  }

  return checks;
}

// --- Score calculation ---

function calculateScore(checks: CheckResult[]): number {
  if (checks.length === 0) return 100;

  const weights = { critical: 25, warning: 10, info: 0 };
  let deductions = 0;

  for (const check of checks) {
    if (!check.passed) {
      deductions += weights[check.severity];
    }
  }

  return Math.max(0, 100 - deductions);
}

// --- Public API ---

export function createRunMetrics(): RunMetrics {
  return {
    cyclesRan: 0,
    tasksProposed: 0,
    tasksExecuted: 0,
    tasksPassed: 0,
    tasksFailed: 0,
    tasksMerged: 0,
    tasksEscalated: 0,
    tasksSkippedByDeps: 0,
    orphansDetected: 0,
    tasksPruned: 0,
  };
}

export async function runSanityCheck(
  basePath: string,
  metrics: RunMetrics,
  queuePath?: string
): Promise<SanityCheckResult> {
  const queue = createQueueManager(basePath, queuePath);
  const tasks = await queue.list();
  const snapshot = buildQueueSnapshot(tasks);
  const checks = runChecks(metrics, snapshot);
  const score = calculateScore(checks);

  return {
    healthy: score >= 80,
    score,
    checks,
    metrics,
    queueSnapshot: snapshot,
  };
}

export function printSanityCheck(result: SanityCheckResult): void {
  const { score, checks, metrics, queueSnapshot } = result;

  console.log('\n' + '═'.repeat(50));
  console.log(`🩺 POST-RUN SANITY CHECK — ${result.healthy ? '✅ HEALTHY' : '⚠️  ISSUES DETECTED'}`);
  console.log('═'.repeat(50));

  // Metrics summary
  console.log('\n📊 Run Metrics:');
  console.log(`   Cycles:       ${metrics.cyclesRan}`);
  console.log(`   Proposed:     ${metrics.tasksProposed}`);
  console.log(`   Executed:     ${metrics.tasksExecuted} (${metrics.tasksPassed} passed, ${metrics.tasksFailed} failed)`);
  console.log(`   Merged:       ${metrics.tasksMerged}`);
  console.log(`   Escalated:    ${metrics.tasksEscalated}`);
  if (metrics.tasksSkippedByDeps > 0) {
    console.log(`   Dep-skipped:  ${metrics.tasksSkippedByDeps}`);
  }
  if (metrics.orphansDetected > 0) {
    console.log(`   Orphans fixed:${metrics.orphansDetected}`);
  }
  if (metrics.tasksPruned > 0) {
    console.log(`   Pruned:       ${metrics.tasksPruned}`);
  }

  // Queue snapshot
  console.log('\n📋 Queue State:');
  console.log(`   Total: ${queueSnapshot.total} (pending: ${queueSnapshot.byStatus.pending}, completed: ${queueSnapshot.byStatus.completed}, failed: ${queueSnapshot.byStatus.failed}, skipped: ${queueSnapshot.byStatus.skipped})`);

  // Invariant checks
  console.log('\n🔍 Checks:');
  const failed = checks.filter((c) => !c.passed);
  const passed = checks.filter((c) => c.passed);

  for (const check of failed) {
    const icon = check.severity === 'critical' ? '🔴' : '🟡';
    console.log(`   ${icon} ${check.name}: ${check.message}`);
  }
  for (const check of passed) {
    console.log(`   ✅ ${check.name}: ${check.message}`);
  }

  // Score
  console.log(`\n   Score: ${score}/100`);
  console.log('═'.repeat(50));
}
