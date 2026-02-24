/**
 * GitHub Operations
 * Wraps the `gh` CLI for pull requests, issues, and branch management.
 * All GitHub interactions go through this module.
 */

import { spawn } from 'node:child_process';

// --- Types ---

export interface PullRequestOptions {
  branch: string;
  targetBranch: string;
  title: string;
  body: string;
}

export interface PullRequestResult {
  success: boolean;
  prNumber?: number;
  prUrl?: string;
  error?: string;
}

export interface PRStatus {
  state: 'open' | 'closed' | 'merged';
  mergeable: boolean;
  mergeableState: 'clean' | 'dirty' | 'blocked' | 'unknown';
  checksStatus: 'pass' | 'fail' | 'pending' | 'none';
  checksDetails: CheckDetail[];
  conflicting: boolean;
  reviewDecision: string;
}

export interface CheckDetail {
  name: string;
  status: string;
  conclusion: string;
}

export interface MergeOptions {
  strategy: 'squash' | 'merge' | 'rebase';
  commitTitle?: string;
}

export interface IssueOptions {
  title: string;
  body: string;
  labels?: string[];
}

export interface IssueResult {
  success: boolean;
  issueNumber?: number;
  issueUrl?: string;
  error?: string;
}

interface GhResult {
  success: boolean;
  output: string;
  error?: string;
}

// --- Internal helpers ---

/**
 * Execute a `gh` CLI command and return the result.
 */
function gh(args: string[], cwd: string): Promise<GhResult> {
  return new Promise((resolvePromise) => {
    let stdout = '';
    let stderr = '';

    const proc = spawn('gh', args, { cwd, shell: false });

    proc.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on('close', (exitCode) => {
      resolvePromise({
        success: exitCode === 0,
        output: stdout.trim(),
        error: exitCode !== 0 ? stderr.trim() : undefined,
      });
    });

    proc.on('error', (err) => {
      resolvePromise({
        success: false,
        output: '',
        error: err.message,
      });
    });
  });
}

/**
 * Execute a git command (used for push and local branch ops).
 */
function git(args: string[], cwd: string): Promise<GhResult> {
  return new Promise((resolvePromise) => {
    let stdout = '';
    let stderr = '';

    const proc = spawn('git', args, { cwd, shell: false });

    proc.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on('close', (exitCode) => {
      resolvePromise({
        success: exitCode === 0,
        output: stdout.trim(),
        error: exitCode !== 0 ? stderr.trim() : undefined,
      });
    });

    proc.on('error', (err) => {
      resolvePromise({
        success: false,
        output: '',
        error: err.message,
      });
    });
  });
}

// --- Public API ---

/**
 * Push a branch to the remote.
 * Uses -u to set upstream tracking.
 */
export async function pushBranch(
  cwd: string,
  branch: string
): Promise<{ success: boolean; error?: string }> {
  const result = await git(['push', '-u', 'origin', branch], cwd);
  return { success: result.success, error: result.error };
}

/**
 * Create a pull request via `gh pr create`.
 * Returns the PR number and URL on success.
 */
export async function createPullRequest(
  cwd: string,
  options: PullRequestOptions
): Promise<PullRequestResult> {
  const result = await gh([
    'pr', 'create',
    '--base', options.targetBranch,
    '--head', options.branch,
    '--title', options.title,
    '--body', options.body,
  ], cwd);

  if (!result.success) {
    return { success: false, error: result.error ?? result.output };
  }

  // gh pr create outputs the PR URL on success
  const prUrl = result.output.trim();
  const prNumberMatch = prUrl.match(/\/pull\/(\d+)/);
  const prNumber = prNumberMatch ? parseInt(prNumberMatch[1], 10) : undefined;

  return { success: true, prNumber, prUrl };
}

/**
 * Get the status of a pull request (checks, mergeable state, conflicts).
 */
export async function getPullRequestStatus(
  cwd: string,
  prNumber: number
): Promise<PRStatus> {
  const result = await gh([
    'pr', 'view', String(prNumber),
    '--json', 'state,mergeable,mergeStateStatus,statusCheckRollup,reviewDecision',
  ], cwd);

  if (!result.success) {
    return {
      state: 'open',
      mergeable: false,
      mergeableState: 'unknown',
      checksStatus: 'none',
      checksDetails: [],
      conflicting: false,
      reviewDecision: 'unknown',
    };
  }

  try {
    const data = JSON.parse(result.output);

    // Parse status check rollup
    const checks: CheckDetail[] = [];
    let checksStatus: PRStatus['checksStatus'] = 'none';

    if (data.statusCheckRollup && Array.isArray(data.statusCheckRollup)) {
      for (const check of data.statusCheckRollup) {
        checks.push({
          name: check.name ?? check.context ?? 'unknown',
          status: check.status ?? '',
          conclusion: check.conclusion ?? '',
        });
      }

      const hasPending = checks.some((c) =>
        c.status === 'IN_PROGRESS' || c.status === 'QUEUED' || c.conclusion === ''
      );
      const hasFailed = checks.some((c) =>
        c.conclusion === 'FAILURE' || c.conclusion === 'ERROR' || c.conclusion === 'CANCELLED'
      );

      if (hasPending) {
        checksStatus = 'pending';
      } else if (hasFailed) {
        checksStatus = 'fail';
      } else if (checks.length > 0) {
        checksStatus = 'pass';
      }
    }

    // Determine mergeable state
    const mergeableState = data.mergeStateStatus?.toLowerCase() ?? 'unknown';
    const conflicting = mergeableState === 'dirty' || data.mergeable === 'CONFLICTING';

    return {
      state: data.state?.toLowerCase() ?? 'open',
      mergeable: data.mergeable === 'MERGEABLE',
      mergeableState: mergeableState as PRStatus['mergeableState'],
      checksStatus,
      checksDetails: checks,
      conflicting,
      reviewDecision: data.reviewDecision ?? '',
    };
  } catch {
    return {
      state: 'open',
      mergeable: false,
      mergeableState: 'unknown',
      checksStatus: 'none',
      checksDetails: [],
      conflicting: false,
      reviewDecision: 'unknown',
    };
  }
}

/**
 * Post a comment on a pull request.
 */
export async function postPRComment(
  cwd: string,
  prNumber: number,
  body: string
): Promise<{ success: boolean; commentUrl?: string; error?: string }> {
  const result = await gh([
    'pr', 'comment', String(prNumber),
    '--body', body,
  ], cwd);

  const commentUrl = result.success && result.output ? result.output.trim() : undefined;

  return { success: result.success, commentUrl, error: result.error };
}

/**
 * Merge a pull request.
 */
export async function mergePullRequest(
  cwd: string,
  prNumber: number,
  options: MergeOptions
): Promise<{ success: boolean; error?: string }> {
  const args = ['pr', 'merge', String(prNumber), '--delete-branch'];

  switch (options.strategy) {
    case 'squash':
      args.push('--squash');
      break;
    case 'rebase':
      args.push('--rebase');
      break;
    case 'merge':
    default:
      args.push('--merge');
      break;
  }

  if (options.commitTitle) {
    args.push('--subject', options.commitTitle);
  }

  const result = await gh(args, cwd);
  return { success: result.success, error: result.error };
}

/**
 * Close a pull request without merging.
 */
export async function closePullRequest(
  cwd: string,
  prNumber: number,
  comment?: string
): Promise<{ success: boolean; error?: string }> {
  if (comment) {
    await gh(['pr', 'comment', String(prNumber), '--body', comment], cwd);
  }
  const result = await gh(['pr', 'close', String(prNumber)], cwd);
  return { success: result.success, error: result.error };
}

/**
 * Delete a remote branch.
 */
export async function deleteBranch(
  cwd: string,
  branch: string
): Promise<{ success: boolean; error?: string }> {
  const result = await git(['push', 'origin', '--delete', branch], cwd);
  return { success: result.success, error: result.error };
}

/**
 * Delete a local branch.
 */
export async function deleteLocalBranch(
  cwd: string,
  branch: string
): Promise<{ success: boolean; error?: string }> {
  const result = await git(['branch', '-D', branch], cwd);
  return { success: result.success, error: result.error };
}

/**
 * Ensure a label exists on the repo, creating it if needed.
 */
async function ensureLabel(cwd: string, label: string): Promise<void> {
  // Check if label exists
  const check = await gh(['label', 'list', '--search', label, '--json', 'name'], cwd);
  if (check.success) {
    try {
      const labels = JSON.parse(check.output) as Array<{ name: string }>;
      if (labels.some((l) => l.name === label)) {
        return; // Label exists
      }
    } catch {
      // Parse failed, try creating
    }
  }

  // Create the label
  await gh(['label', 'create', label, '--color', 'D93F0B', '--description', 'Auto-merge pipeline escalation'], cwd);
}

/**
 * Create a GitHub Issue for merge escalation.
 * Ensures labels exist before applying them.
 */
export async function createIssue(
  cwd: string,
  options: IssueOptions
): Promise<IssueResult> {
  // Ensure labels exist on the repo before referencing them
  if (options.labels && options.labels.length > 0) {
    for (const label of options.labels) {
      await ensureLabel(cwd, label);
    }
  }

  const args = ['issue', 'create', '--title', options.title, '--body', options.body];

  if (options.labels && options.labels.length > 0) {
    args.push('--label', options.labels.join(','));
  }

  const result = await gh(args, cwd);

  if (!result.success) {
    // If it still fails (e.g., permissions), retry without labels
    if (options.labels && options.labels.length > 0) {
      console.log(`  ⚠️  Issue creation with labels failed, retrying without labels`);
      const retryArgs = ['issue', 'create', '--title', options.title, '--body', options.body];
      const retryResult = await gh(retryArgs, cwd);

      if (!retryResult.success) {
        return { success: false, error: retryResult.error ?? retryResult.output };
      }

      const issueUrl = retryResult.output.trim();
      const issueNumberMatch = issueUrl.match(/\/issues\/(\d+)/);
      const issueNumber = issueNumberMatch ? parseInt(issueNumberMatch[1], 10) : undefined;
      return { success: true, issueNumber, issueUrl };
    }

    return { success: false, error: result.error ?? result.output };
  }

  const issueUrl = result.output.trim();
  const issueNumberMatch = issueUrl.match(/\/issues\/(\d+)/);
  const issueNumber = issueNumberMatch ? parseInt(issueNumberMatch[1], 10) : undefined;

  return { success: true, issueNumber, issueUrl };
}

/**
 * Close a GitHub Issue by number, with an optional comment explaining why.
 */
export async function closeIssue(
  cwd: string,
  issueNumber: number,
  comment?: string
): Promise<{ success: boolean; error?: string }> {
  if (comment) {
    await gh(['issue', 'comment', String(issueNumber), '--body', comment], cwd);
  }
  const result = await gh(['issue', 'close', String(issueNumber)], cwd);
  return { success: result.success, error: result.error };
}

/**
 * Get the diff for a pull request.
 * Returns the unified diff string.
 */
export async function getPRDiff(
  cwd: string,
  prNumber: number
): Promise<{ success: boolean; diff: string; error?: string }> {
  const result = await gh([
    'pr', 'diff', String(prNumber),
  ], cwd);

  return {
    success: result.success,
    diff: result.output,
    error: result.error,
  };
}

/**
 * Get the list of files changed in a branch relative to a target branch.
 * Uses git diff --name-only.
 */
export async function getBranchChangedFiles(
  cwd: string,
  branch: string,
  targetBranch: string
): Promise<string[]> {
  const result = await git(
    ['diff', '--name-only', `${targetBranch}...${branch}`],
    cwd
  );

  if (!result.success || !result.output) {
    return [];
  }

  return result.output.split('\n').filter(Boolean);
}

/**
 * Get the list of files with merge conflicts when merging branch into target.
 * Performs a dry-run merge and extracts conflicting file names.
 */
export async function getConflictFiles(
  cwd: string,
  branch: string,
  targetBranch: string
): Promise<string[]> {
  // Use merge-tree to detect conflicts without modifying the working tree
  const result = await git(
    ['merge-tree', '--write-tree', '--name-only', targetBranch, branch],
    cwd
  );

  // merge-tree exits with 1 when there are conflicts
  if (result.output.includes('CONFLICT')) {
    const lines = result.output.split('\n');
    return lines
      .filter((line) => line.startsWith('CONFLICT'))
      .map((line) => {
        // Extract filename from "CONFLICT (content): Merge conflict in <file>"
        const match = line.match(/Merge conflict in (.+)$/);
        return match ? match[1].trim() : '';
      })
      .filter(Boolean);
  }

  return [];
}

/**
 * Get the conflict markers content from files after a failed merge attempt.
 * This does an actual merge (which will be aborted after), capturing the conflict markers.
 */
export async function extractConflictMarkers(
  cwd: string,
  branch: string,
  targetBranch: string
): Promise<{ file: string; content: string }[]> {
  // Save current branch
  const currentBranch = await git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);

  // Checkout target branch
  await git(['checkout', targetBranch], cwd);

  // Attempt the merge (will fail with conflicts)
  const mergeResult = await git(['merge', '--no-commit', '--no-ff', branch], cwd);

  const conflicts: { file: string; content: string }[] = [];

  if (!mergeResult.success) {
    // Get the list of conflicted files
    const statusResult = await git(['diff', '--name-only', '--diff-filter=U'], cwd);

    if (statusResult.success && statusResult.output) {
      const files = statusResult.output.split('\n').filter(Boolean);

      for (const file of files) {
        // Read the file content with conflict markers
        const { readFile } = await import('node:fs/promises');
        const { resolve } = await import('node:path');

        try {
          const content = await readFile(resolve(cwd, file), 'utf-8');
          conflicts.push({ file, content });
        } catch {
          // File might not be readable
        }
      }
    }
  }

  // Abort the merge to restore clean state
  await git(['merge', '--abort'], cwd);

  // Return to original branch
  if (currentBranch.success && currentBranch.output) {
    await git(['checkout', currentBranch.output], cwd);
  }

  return conflicts;
}

/**
 * Get the CI/check failure logs for a PR.
 * Extracts failed check details including output.
 */
export async function getFailedCheckLogs(
  cwd: string,
  prNumber: number
): Promise<{ name: string; output: string }[]> {
  const result = await gh([
    'pr', 'checks', String(prNumber),
    '--json', 'name,state,conclusion,detailsUrl',
  ], cwd);

  if (!result.success) {
    return [];
  }

  try {
    const checks = JSON.parse(result.output) as Array<{
      name: string;
      state: string;
      conclusion: string;
      detailsUrl: string;
    }>;

    return checks
      .filter((c) =>
        c.conclusion === 'FAILURE' || c.conclusion === 'ERROR'
      )
      .map((c) => ({
        name: c.name,
        output: `Check "${c.name}" failed (${c.conclusion}). Details: ${c.detailsUrl}`,
      }));
  } catch {
    return [];
  }
}

/**
 * Check if a PR already exists for a branch.
 */
export async function findExistingPR(
  cwd: string,
  branch: string
): Promise<{ exists: boolean; prNumber?: number; prUrl?: string }> {
  const result = await gh([
    'pr', 'list',
    '--head', branch,
    '--json', 'number,url',
    '--limit', '1',
  ], cwd);

  if (!result.success || !result.output) {
    return { exists: false };
  }

  try {
    const prs = JSON.parse(result.output) as Array<{ number: number; url: string }>;
    if (prs.length > 0) {
      return { exists: true, prNumber: prs[0].number, prUrl: prs[0].url };
    }
  } catch {
    // Parse error
  }

  return { exists: false };
}

/**
 * Wait for CI checks to complete by polling.
 * Returns the final status after all checks finish or timeout.
 */
export async function waitForChecks(
  cwd: string,
  prNumber: number,
  timeoutMs: number = 300_000,
  pollIntervalMs: number = 15_000
): Promise<PRStatus> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const status = await getPullRequestStatus(cwd, prNumber);

    if (status.checksStatus !== 'pending') {
      return status;
    }

    console.log(`  ⏳ CI checks pending... (${Math.round((Date.now() - start) / 1000)}s elapsed)`);

    // Wait before polling again
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  // Timeout — return last known status
  console.log(`  ⏰ CI check timeout after ${Math.round(timeoutMs / 1000)}s`);
  return getPullRequestStatus(cwd, prNumber);
}
