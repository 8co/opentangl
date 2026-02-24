import { spawn } from 'node:child_process';
import { 
  hasChanges, 
  getHeadSha 
} from './git-ops.js';
import { appendFileSync } from 'fs';

interface RollbackRecord {
  timestamp: string;
  commitHash: string;
  reason: string;
}

/**
 * Execute a git command (internal helper).
 */
function gitCmd(args: string[], cwd: string): Promise<{ success: boolean; output: string; error?: string }> {
  return new Promise((resolvePromise) => {
    let stdout = '';
    let stderr = '';
    const proc = spawn('git', args, { cwd, shell: false });
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    proc.on('close', (code) => {
      resolvePromise({
        success: code === 0,
        output: stdout.trim(),
        error: code !== 0 ? stderr.trim() : undefined,
      });
    });
    proc.on('error', (e) => {
      resolvePromise({ success: false, output: '', error: e.message });
    });
  });
}

/**
 * Logs rollback history with the given details.
 */
function logRollbackHistory(commitHash: string, reason: string): void {
  const timestamp = new Date().toISOString();
  const record: RollbackRecord = { timestamp, commitHash, reason };

  try {
    appendFileSync('rollback-history.log', JSON.stringify(record) + '\n');
  } catch (error: unknown) {
    console.error('Failed to log rollback history:', error);
  }
}

/**
 * Create a checkpoint by getting the current HEAD SHA.
 */
export async function createCheckpoint(cwd: string): Promise<string> {
  const sha = await getHeadSha(cwd);
  if (sha === 'unknown') {
    throw new Error('Failed to get current HEAD SHA');
  }
  return sha;
}

/**
 * Determine if it's safe to rollback to the specified commit hash.
 */
export async function canSafelyRollback(cwd: string, commitHash: string): Promise<boolean> {
  const hasUncommittedChanges = await hasChanges(cwd);
  return !hasUncommittedChanges;
}

/**
 * Rollback to a specific commit hash using git reset --hard.
 */
export async function rollbackToCommit(cwd: string, commitHash: string): Promise<void> {
  if (!await canSafelyRollback(cwd, commitHash)) {
    throw new Error('Uncommitted changes present. Please commit or stash them before rollback.');
  }

  const resetResult = await gitCmd(['reset', '--hard', commitHash], cwd);
  if (!resetResult.success) {
    throw new Error(`Failed to reset to ${commitHash}: ${resetResult.error}`);
  }

  logRollbackHistory(commitHash, `Rollback to commit ${commitHash}`);
}
