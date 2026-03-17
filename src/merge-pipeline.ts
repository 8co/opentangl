/**
 * Merge Pipeline (Phase 2)
 * Orchestrates the full PR-based merge flow for completed branches:
 *   push → create PR → LLM review → poll CI → merge (or fix/escalate)
 *
 * Runs automatically after the scheduler's implementation phase completes.
 * Also available as a standalone CLI command.
 */

import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import {
  pushBranch,
  createPullRequest,
  getPullRequestStatus,
  postPRComment,
  mergePullRequest,
  closePullRequest,
  deleteBranch,
  createIssue,
  closeIssue,
  getPRDiff,
  getFailedCheckLogs,
  findExistingPR,
  waitForChecks,
  type PRStatus,
} from './github-ops.js';
import { getMergeOrder, printBranchAnalysis } from './branch-analyzer.js';
import { reviewDiff, formatReviewComment } from './diff-reviewer.js';
import { resolveAndApply, hasBinaryConflicts, extractConflicts } from './conflict-resolver.js';
import { parseCodeBlocks, writeFiles, buildFileContext } from './file-writer.js';
import { runVerification } from './verify-runner.js';
import { createQueueManager, type QueueTask } from './queue-manager.js';
import type { ProjectConfig, ProjectRegistry, MergeConfig } from './project-registry.js';
import { resolveMergeConfig } from './project-registry.js';
import type { AgentAdapter, AgentRequest, AgentType } from './types.js';

// --- Types ---

export interface MergePipelineConfig {
  adapters: Record<string, AgentAdapter>;
  defaultAgent: AgentType;
  liteAgent?: AgentType; // Cheaper model for review/PR description (no codegen)
  registry: ProjectRegistry;
  basePath: string; // Orchestrator root (for prompt templates)
  queuePath?: string;
}

export interface BranchMergeInput {
  taskId: string;
  branch: string;
  projectId: string;
  taskDescription?: string;
}

export interface BranchMergeResult {
  taskId: string;
  branch: string;
  projectId: string;
  status: 'merged' | 'failed' | 'escalated';
  prNumber?: number;
  prUrl?: string;
  issueUrl?: string;
  attempts: number;
  error?: string;
  durationMs: number;
}

export interface MergePipelineResult {
  results: BranchMergeResult[];
  merged: number;
  failed: number;
  escalated: number;
  totalDurationMs: number;
}

// --- Pipeline ---

export function createMergePipeline(config: MergePipelineConfig) {
  const {
    adapters,
    defaultAgent,
    liteAgent,
    registry,
    basePath,
    queuePath,
  } = config;

  const queue = createQueueManager(basePath, queuePath);

  /**
   * Full adapter for code-writing operations (CI fix, conflict resolution).
   */
  function getAdapter(): AgentAdapter | null {
    return adapters[defaultAgent] ?? null;
  }

  /**
   * Lite adapter for read/summarise operations (PR description, diff review).
   * Falls back to the full adapter if no lite adapter is configured.
   */
  function getLiteAdapter(): AgentAdapter | null {
    if (liteAgent && adapters[liteAgent]) {
      return adapters[liteAgent];
    }
    return adapters[defaultAgent] ?? null;
  }

  /**
   * Generate a PR title and body from the diff using the LLM.
   */
  async function generatePRDescription(
    diff: string,
    taskId: string,
    taskDescription?: string
  ): Promise<{ title: string; body: string }> {
    const adapter = getLiteAdapter();
    if (!adapter) {
      return {
        title: `Auto: ${taskId}`,
        body: taskDescription ?? `Automated changes from task ${taskId}`,
      };
    }

    // Truncate diff for prompt
    const truncatedDiff = diff.length > 8000
      ? diff.slice(0, 8000) + '\n... (truncated)'
      : diff;

    const prompt = `Generate a concise pull request title and description for the following changes.

Task: ${taskDescription ?? taskId}

Diff:
\`\`\`
${truncatedDiff}
\`\`\`

Respond in this exact format:
Title: <concise title, max 72 chars>
Body: <1-3 sentence description of what changed and why>`;

    const response = await adapter.execute({ prompt });

    if (!response.success || !response.output) {
      return {
        title: `Auto: ${taskId}`,
        body: taskDescription ?? `Automated changes from task ${taskId}`,
      };
    }

    const titleMatch = response.output.match(/Title:\s*(.+)/);
    const bodyMatch = response.output.match(/Body:\s*([\s\S]+?)(?:\n\n|$)/);

    return {
      title: titleMatch ? titleMatch[1].trim() : `Auto: ${taskId}`,
      body: bodyMatch ? bodyMatch[1].trim() : (taskDescription ?? `Automated changes from task ${taskId}`),
    };
  }

  /**
   * Attempt to fix CI failures by having the LLM analyze errors and generate fixes.
   */
  async function fixCIFailure(
    cwd: string,
    branch: string,
    prNumber: number,
    projectConfig: ProjectConfig | undefined,
    taskDescription?: string
  ): Promise<{ success: boolean; error?: string }> {
    const adapter = getAdapter();
    if (!adapter) {
      return { success: false, error: 'No LLM adapter available for CI fix' };
    }

    // Get failed check logs
    const failedChecks = await getFailedCheckLogs(cwd, prNumber);
    if (failedChecks.length === 0) {
      return { success: false, error: 'Could not retrieve CI failure details' };
    }

    const ciErrors = failedChecks.map((c) => `## ${c.name}\n${c.output}`).join('\n\n');

    // Also try to get build errors locally
    const { spawn } = await import('node:child_process');
    let localErrors = '';

    if (projectConfig?.verify) {
      const verifyResult = await runVerification(
        projectConfig.verify.map((v) => ({
          label: `${v.command} ${v.args.join(' ')}`,
          command: v.command,
          args: v.args,
          optional: v.optional,
        })),
        cwd
      );
      if (!verifyResult.allPassed) {
        localErrors = verifyResult.errorSummary;
      }
    }

    const combinedErrors = localErrors || ciErrors;

    // Load CI fix prompt
    let template: string;
    try {
      template = await readFile(resolve(basePath, 'prompts/merge-fix-ci.md'), 'utf-8');
    } catch {
      template = `Fix the following CI errors:\n\n{{ci_errors}}\n\nOutput fixed files as code blocks.`;
    }

    // Build file context from the branch
    const { getBranchChangedFiles } = await import('./github-ops.js');
    const changedFiles = await getBranchChangedFiles(cwd, branch, 'main');
    const fileContext = changedFiles.length > 0
      ? await buildFileContext(changedFiles.slice(0, 10), cwd)
      : '(no files available)';

    const vars: Record<string, string> = {
      ci_errors: combinedErrors,
      file_context: fileContext,
      project_name: projectConfig?.name ?? 'project',
      branch_name: branch,
      target_branch: 'main',
      task_description: taskDescription ?? '(no description)',
    };

    let prompt = template;
    for (const [key, value] of Object.entries(vars)) {
      prompt = prompt.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
    }

    const response = await adapter.execute({ prompt });

    if (!response.success || !response.output) {
      return { success: false, error: response.error ?? 'LLM returned no output for CI fix' };
    }

    // Parse and apply fixes
    const fixes = parseCodeBlocks(response.output);
    if (fixes.length === 0) {
      return { success: false, error: 'LLM output contained no code blocks' };
    }

    // Write fixes
    const writeResult = await writeFiles(fixes, cwd, {
      enforceProtected: false, // Allow fixing any file
    });

    if (writeResult.filesWritten.length === 0) {
      return { success: false, error: 'No files were written' };
    }

    // Commit and push
    const { commitChanges } = await import('./git-ops.js');
    const commitResult = await commitChanges(cwd, `Auto-fix: CI failure on ${branch}`);
    if (!commitResult.success) {
      return { success: false, error: `Commit failed: ${commitResult.error}` };
    }

    const pushResult = await pushBranch(cwd, branch);
    if (!pushResult.success) {
      return { success: false, error: `Push failed: ${pushResult.error}` };
    }

    console.log(`  ✅ CI fix applied and pushed (${writeResult.filesWritten.length} file(s))`);
    return { success: true };
  }

  /**
   * Build GitHub Issue body for escalation.
   */
  function buildEscalationIssueBody(
    input: BranchMergeInput,
    prNumber: number | undefined,
    prUrl: string | undefined,
    error: string,
    attempts: number,
    maxAttempts: number,
    projectName: string
  ): string {
    const lines = [
      `## Auto-Merge Failed: ${input.taskId}`,
      '',
      `**Branch:** ${input.branch}`,
    ];

    if (prNumber && prUrl) {
      lines.push(`**PR:** #${prNumber} (${prUrl})`);
    }

    lines.push(`**Project:** ${projectName}`);
    lines.push(`**Attempts:** ${attempts}/${maxAttempts}`);
    lines.push('');
    lines.push('### What Was Attempted');
    lines.push(input.taskDescription ?? `Automated task: ${input.taskId}`);
    lines.push('');
    lines.push('### Failure Reason');
    lines.push('```');
    lines.push(error.slice(0, 2000));
    lines.push('```');
    lines.push('');
    lines.push('### How to Resolve');
    lines.push(`1. Review the PR${prUrl ? `: ${prUrl}` : ''}`);
    lines.push('2. Fix the remaining issues');
    lines.push('3. Merge when ready');

    return lines.join('\n');
  }

  /**
   * Process a single branch through the merge pipeline.
   */
  async function processBranch(input: BranchMergeInput): Promise<BranchMergeResult> {
    const start = Date.now();
    let attempts = 0;

    const projectConfig = registry.get(input.projectId);
    const mergeConfig = projectConfig
      ? resolveMergeConfig(projectConfig)
      : resolveMergeConfig({ id: 'default', name: 'default', path: '.', type: 'unknown', scan_dirs: [] });
    const maxAttempts = mergeConfig.max_attempts;
    const projectName = projectConfig?.name ?? input.projectId;
    const cwd = projectConfig?.path ?? basePath;

    console.log(`\n${'─'.repeat(50)}`);
    console.log(`🔀 Merge: ${input.branch} → ${mergeConfig.target_branch}`);
    console.log(`   Project: ${projectName} | Task: ${input.taskId}`);
    console.log('─'.repeat(50));

    // Step 1: Push branch to remote
    console.log(`  📤 Pushing ${input.branch}...`);
    const pushResult = await pushBranch(cwd, input.branch);
    if (!pushResult.success) {
      return {
        ...input,
        status: 'failed',
        attempts: 0,
        error: `Push failed: ${pushResult.error}`,
        durationMs: Date.now() - start,
      };
    }

    // Step 2: Create PR (or find existing)
    let prNumber: number | undefined;
    let prUrl: string | undefined;

    const existingPR = await findExistingPR(cwd, input.branch);
    if (existingPR.exists && existingPR.prNumber) {
      console.log(`  📋 Found existing PR #${existingPR.prNumber}`);
      prNumber = existingPR.prNumber;
      prUrl = existingPR.prUrl;
    } else {
      console.log(`  📝 Creating pull request...`);
      const diff = await getPRDiff(cwd, 0); // Get diff before PR exists
      // Use git diff instead for pre-PR
      const { getBranchChangedFiles } = await import('./github-ops.js');

      const prDesc = await generatePRDescription(
        diff.success ? diff.diff : '',
        input.taskId,
        input.taskDescription
      );

      const prResult = await createPullRequest(cwd, {
        branch: input.branch,
        targetBranch: mergeConfig.target_branch,
        title: prDesc.title,
        body: prDesc.body,
      });

      if (!prResult.success || !prResult.prNumber) {
        return {
          ...input,
          status: 'failed',
          attempts: 0,
          error: `PR creation failed: ${prResult.error}`,
          durationMs: Date.now() - start,
        };
      }

      prNumber = prResult.prNumber;
      prUrl = prResult.prUrl;
      console.log(`  ✅ PR #${prNumber} created: ${prUrl}`);
    }

    // Update queue with PR info
    try {
      await queue.markMergeInProgress(input.taskId, prNumber, prUrl ?? '');
    } catch {
      // Queue update is non-critical
    }

    // Full adapter for code-writing operations (CI fix, conflict resolution)
    const adapter = getAdapter();

    // Step 3: LLM reviews the diff (uses lite model — read/summarise only)
    const liteAdapter = getLiteAdapter();
    if (liteAdapter) {
      console.log(`  🔍 LLM reviewing diff...`);
      const diffResult = await getPRDiff(cwd, prNumber);

      if (diffResult.success) {
        const review = await reviewDiff(
          {
            diff: diffResult.diff,
            taskDescription: input.taskDescription,
            projectName,
            branchName: input.branch,
          },
          liteAdapter,
          basePath
        );

        // Post review as PR comment
        const reviewComment = formatReviewComment(review);
        const commentResult = await postPRComment(cwd, prNumber, reviewComment);
        if (commentResult.commentUrl) {
          console.log(`  💬 Review posted: ${commentResult.commentUrl}`);
        }

        if (review.hasCriticalConcerns) {
          console.log(`  🔴 LLM flagged critical concerns — escalating`);

          const issueResult = await createIssue(cwd, {
            title: `Auto-merge blocked: ${input.taskId} — critical review concerns`,
            body: buildEscalationIssueBody(
              input,
              prNumber,
              prUrl,
              `LLM review flagged critical concerns:\n${review.concerns.join('\n')}`,
              0,
              maxAttempts,
              projectName
            ),
            labels: ['auto-merge-failed'],
          });

          // Close the PR and delete the branch
          await closePullRequest(cwd, prNumber, `Closing: escalated to issue ${issueResult.issueUrl ?? '(see issues)'}`);
          const delResult = await deleteBranch(cwd, input.branch);
          if (delResult.success) {
            console.log(`  🗑️  Deleted remote branch ${input.branch}`);
          }

          const concerns = `Critical review concerns: ${review.concerns.join('; ')}`;
          try {
            await queue.markEscalated(input.taskId, issueResult.issueUrl ?? '', concerns);
          } catch { /* non-critical */ }

          return {
            ...input,
            status: 'escalated',
            prNumber,
            prUrl,
            issueUrl: issueResult.issueUrl,
            attempts: 0,
            error: concerns,
            durationMs: Date.now() - start,
          };
        }

        if (!review.approved) {
          console.log(`  ⚠️  LLM review has concerns (non-critical), proceeding with merge attempt`);
        } else {
          console.log(`  ✅ LLM review approved`);
        }
      }
    }

    // Step 4-7: Merge retry loop
    while (attempts < maxAttempts) {
      attempts++;
      console.log(`\n  🔄 Merge attempt ${attempts}/${maxAttempts}`);

      try {
        await queue.incrementMergeAttempt(input.taskId);
      } catch { /* non-critical */ }

      // Wait for CI checks
      console.log(`  ⏳ Waiting for CI checks...`);
      const status = await waitForChecks(cwd, prNumber, mergeConfig.ci_timeout_ms);

      // Handle CI failures
      if (status.checksStatus === 'fail') {
        console.log(`  ❌ CI checks failed`);

        if (attempts < maxAttempts && adapter) {
          console.log(`  🤖 Attempting CI fix...`);
          const fixResult = await fixCIFailure(
            cwd,
            input.branch,
            prNumber,
            projectConfig,
            input.taskDescription
          );

          if (fixResult.success) {
            console.log(`  ✅ Fix applied, retrying...`);
            continue; // Re-enter the loop to wait for CI again
          } else {
            console.log(`  ❌ CI fix failed: ${fixResult.error}`);
          }
        }

        if (attempts >= maxAttempts) {
          break; // Exhausted — will escalate below
        }
        continue;
      }

      // Handle merge conflicts
      if (status.conflicting || status.mergeableState === 'dirty') {
        console.log(`  ⚠️  Merge conflicts detected`);

        if (attempts < maxAttempts && adapter) {
          console.log(`  🤖 Attempting conflict resolution...`);
          const resolveResult = await resolveAndApply(
            cwd,
            input.branch,
            mergeConfig.target_branch,
            adapter,
            basePath,
            {
              taskDescription: input.taskDescription,
              projectName,
            }
          );

          if (resolveResult.success) {
            console.log(`  ✅ Conflicts resolved, retrying...`);
            continue;
          } else {
            console.log(`  ❌ Conflict resolution failed: ${resolveResult.error}`);
          }
        }

        if (attempts >= maxAttempts) {
          break;
        }
        continue;
      }

      // Handle blocked state (e.g., branch protection requiring approvals)
      if (status.mergeableState === 'blocked') {
        console.log(`  🚫 Merge blocked (branch protection or required approvals)`);
        break; // Can't retry this — escalate
      }

      // All checks pass and mergeable — merge!
      if (status.checksStatus === 'pass' || status.checksStatus === 'none') {
        if (status.mergeable || status.mergeableState === 'clean') {
          console.log(`  🔀 Merging PR #${prNumber}...`);

          const mergeResult = await mergePullRequest(cwd, prNumber, {
            strategy: mergeConfig.strategy,
            commitTitle: `Auto: ${input.taskId}`,
          });

          if (mergeResult.success) {
            console.log(`  ✅ Merged successfully!`);

            try {
              await queue.markMerged(input.taskId, prUrl ?? '');
            } catch { /* non-critical */ }

            // If this was a retry of an escalated task, close the original issue
            try {
              const task = await queue.getTask(input.taskId);
              const originalId = task?.variables?.retry_of;
              if (originalId) {
                const original = await queue.getTask(originalId);
                if (original?.issue_url) {
                  const issueNum = original.issue_url.match(/\/issues\/(\d+)/)?.[1];
                  if (issueNum) {
                    const closeResult = await closeIssue(
                      cwd,
                      parseInt(issueNum, 10),
                      `Resolved by retry task \`${input.taskId}\` — merged via PR ${prUrl ?? `#${prNumber}`}`
                    );
                    if (closeResult.success) {
                      console.log(`  🔒 Closed escalation issue ${original.issue_url}`);
                    }
                  }
                }
              }
            } catch { /* non-critical — issue cleanup is best-effort */ }

            return {
              ...input,
              status: 'merged',
              prNumber,
              prUrl,
              attempts,
              durationMs: Date.now() - start,
            };
          } else {
            console.log(`  ❌ Merge command failed: ${mergeResult.error}`);
            // Could be a race condition — retry
            if (attempts >= maxAttempts) break;
            continue;
          }
        }
      }

      // Unknown state — log and retry
      console.log(`  ❓ Unexpected PR state: checks=${status.checksStatus}, mergeable=${status.mergeableState}`);
      if (attempts >= maxAttempts) break;
    }

    // All attempts exhausted — escalate
    console.log(`\n  🚨 Exhausted ${maxAttempts} attempts — creating GitHub Issue`);

    const lastStatus = await getPullRequestStatus(cwd, prNumber);
    const errorReason = lastStatus.conflicting
      ? 'Unresolved merge conflicts'
      : lastStatus.checksStatus === 'fail'
        ? 'CI checks failing'
        : lastStatus.mergeableState === 'blocked'
          ? 'Merge blocked by branch protection'
          : 'Unknown merge failure';

    const issueResult = await createIssue(cwd, {
      title: `Auto-merge failed: ${input.taskId}`,
      body: buildEscalationIssueBody(
        input,
        prNumber,
        prUrl,
        errorReason,
        attempts,
        maxAttempts,
        projectName
      ),
      labels: ['auto-merge-failed'],
    });

    // Close the PR and delete the branch
    await closePullRequest(cwd, prNumber, `Closing: escalated to issue ${issueResult.issueUrl ?? '(see issues)'} after ${attempts} failed attempt(s)`);
    const delResult = await deleteBranch(cwd, input.branch);
    if (delResult.success) {
      console.log(`  🗑️  Deleted remote branch ${input.branch}`);
    }

    try {
      await queue.markEscalated(input.taskId, issueResult.issueUrl ?? '', errorReason);
    } catch { /* non-critical */ }

    return {
      ...input,
      status: 'escalated',
      prNumber,
      prUrl,
      issueUrl: issueResult.issueUrl,
      attempts,
      error: errorReason,
      durationMs: Date.now() - start,
    };
  }

  // --- Public API ---

  return {
    /**
     * Merge a single branch through the full pipeline (push → PR → review → CI → merge).
     * Used by the scheduler for inline merging of tasks with dependents.
     */
    async mergeSingle(input: BranchMergeInput): Promise<BranchMergeResult> {
      console.log(`\n${'━'.repeat(50)}`);
      console.log(`🔀 INLINE MERGE: ${input.branch}`);
      console.log('━'.repeat(50));
      return processBranch(input);
    },

    /**
     * Run the merge pipeline for a list of branches.
     * Analyzes branch overlap, orders merges, and processes each one.
     */
    async run(inputs: BranchMergeInput[]): Promise<MergePipelineResult> {
      const pipelineStart = Date.now();

      console.log('\n' + '═'.repeat(50));
      console.log('🔀 MERGE PIPELINE — PHASE 2');
      console.log('═'.repeat(50));
      console.log(`   Branches to merge: ${inputs.length}`);
      console.log('═'.repeat(50));

      if (inputs.length === 0) {
        console.log('   No branches to merge.');
        return { results: [], merged: 0, failed: 0, escalated: 0, totalDurationMs: 0 };
      }

      // Group inputs by project
      const byProject = new Map<string, BranchMergeInput[]>();
      for (const input of inputs) {
        const existing = byProject.get(input.projectId) ?? [];
        existing.push(input);
        byProject.set(input.projectId, existing);
      }

      const allResults: BranchMergeResult[] = [];

      // Process each project's branches
      for (const [projectId, projectInputs] of Array.from(byProject.entries())) {
        const projectConfig = registry.get(projectId);
        const mergeConfig = projectConfig
          ? resolveMergeConfig(projectConfig)
          : resolveMergeConfig({ id: 'default', name: 'default', path: '.', type: 'unknown', scan_dirs: [] });
        const cwd = projectConfig?.path ?? basePath;
        const projectName = projectConfig?.name ?? projectId;

        console.log(`\n${'━'.repeat(50)}`);
        console.log(`📁 Project: ${projectName} (${projectInputs.length} branch(es))`);
        console.log('━'.repeat(50));

        // Analyze branch ordering
        const branches = projectInputs.map((i) => i.branch);

        if (branches.length > 1) {
          console.log(`  📊 Analyzing branch overlap...`);
          const orderResult = await getMergeOrder(cwd, branches, mergeConfig.target_branch);
          printBranchAnalysis(orderResult);

          const orderedBranches = [...orderResult.independent, ...orderResult.overlapping];
          const inputMap = new Map(projectInputs.map((i) => [i.branch, i]));
          const processed = new Set<string>();

          for (const branch of orderedBranches) {
            const input = inputMap.get(branch);
            if (input) {
              const result = await processBranch(input);
              allResults.push(result);
              processed.add(branch);
            }
          }

          // Safety net: process any branches the analyzer missed
          for (const input of projectInputs) {
            if (!processed.has(input.branch)) {
              console.log(`  ⚠️  Branch "${input.branch}" was not returned by branch analyzer — processing anyway`);
              const result = await processBranch(input);
              allResults.push(result);
            }
          }
        } else {
          // Single branch — just process it
          const result = await processBranch(projectInputs[0]);
          allResults.push(result);
        }

        // Post-project integration check — sync from remote first so we
        // validate main INCLUDING the PRs we just merged (they were merged
        // on the remote via the GitHub API).
        console.log(`\n  🏥 Post-merge integration check for ${projectName}...`);
        const { syncMainFromRemote } = await import('./git-ops.js');
        const syncResult = await syncMainFromRemote(cwd, mergeConfig.target_branch);

        if (syncResult.success && projectConfig?.verify) {
          const integrationCheck = await runVerification(
            projectConfig.verify.map((v) => ({
              label: `${v.command} ${v.args.join(' ')}`,
              command: v.command,
              args: v.args,
              optional: v.optional,
            })),
            cwd
          );

          if (integrationCheck.allPassed) {
            console.log(`  ✅ Integration check passed`);
          } else {
            console.log(`  ⚠️  Integration check failed — manual review needed`);
            // Create an issue for integration failure
            await createIssue(cwd, {
              title: `Integration check failed after batch merge: ${projectName}`,
              body: `## Integration Failure\n\nAfter merging ${allResults.filter((r) => r.status === 'merged').length} branch(es), the integration check failed.\n\n\`\`\`\n${integrationCheck.errorSummary.slice(0, 2000)}\n\`\`\`\n\n### Merged Branches\n${allResults.filter((r) => r.status === 'merged').map((r) => `- ${r.branch} (PR ${r.prUrl ?? ''})`).join('\n')}`,
              labels: ['auto-merge-failed', 'integration-failure'],
            });
          }
        }
      }

      // Print summary
      const merged = allResults.filter((r) => r.status === 'merged').length;
      const failed = allResults.filter((r) => r.status === 'failed').length;
      const escalated = allResults.filter((r) => r.status === 'escalated').length;
      const totalDurationMs = Date.now() - pipelineStart;

      console.log('\n' + '═'.repeat(50));
      console.log('📊 MERGE PIPELINE COMPLETE');
      console.log('═'.repeat(50));
      console.log(`   Merged:    ${merged}`);
      console.log(`   Failed:    ${failed}`);
      console.log(`   Escalated: ${escalated}`);
      console.log(`   Duration:  ${Math.round(totalDurationMs / 1000)}s`);

      if (escalated > 0) {
        console.log(`\n   ⚠️  ${escalated} branch(es) escalated — check GitHub Issues`);
        for (const r of allResults.filter((r) => r.status === 'escalated')) {
          console.log(`      ${r.branch}: ${r.issueUrl ?? r.error}`);
        }
      }

      console.log('═'.repeat(50));

      return { results: allResults, merged, failed, escalated, totalDurationMs };
    },

    /**
     * Run the merge pipeline for all pending merge tasks in the queue.
     * Reads the queue, finds completed tasks with branches, and processes them.
     */
    async runFromQueue(): Promise<MergePipelineResult> {
      const pendingTasks = await queue.getMergePending();

      if (pendingTasks.length === 0) {
        console.log('\n✅ No branches pending merge.');
        return { results: [], merged: 0, failed: 0, escalated: 0, totalDurationMs: 0 };
      }

      const inputs: BranchMergeInput[] = pendingTasks.map((task) => ({
        taskId: task.id,
        branch: task.branch!,
        projectId: task.project ?? 'orchestrator',
        taskDescription: task.variables?.task_description ?? `Task: ${task.id}`,
      }));

      return this.run(inputs);
    },
  };
}
