/**
 * Conflict Resolver
 * Uses an LLM to resolve merge conflicts.
 * Extracts conflict markers, sends them to the LLM with context,
 * and applies the resolved files.
 *
 * The LLM outputs resolved files in the same code block format
 * that file-writer already parses (```language:path/to/file.ts).
 */

import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { parseCodeBlocks, type FileChange } from './file-writer.js';
import type { AgentAdapter, AgentRequest } from './types.js';

// --- Types ---

export interface ConflictFile {
  file: string;
  content: string; // File content with conflict markers
}

export interface ConflictResolution {
  success: boolean;
  resolvedFiles: FileChange[];
  error?: string;
}

// --- Internal helpers ---

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

// --- Public API ---

/**
 * Extract conflict markers by attempting a merge on a temporary basis.
 * Performs the merge, reads conflicted files, then aborts.
 *
 * IMPORTANT: This temporarily modifies the working tree. It aborts the merge
 * and returns to the original branch when done.
 */
export async function extractConflicts(
  cwd: string,
  branch: string,
  targetBranch: string
): Promise<ConflictFile[]> {
  // Save current branch
  const currentBranchResult = await gitCmd(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  const originalBranch = currentBranchResult.success ? currentBranchResult.output : null;

  // Checkout target branch
  const checkoutResult = await gitCmd(['checkout', targetBranch], cwd);
  if (!checkoutResult.success) {
    console.log(`  ⚠️  Could not checkout ${targetBranch}: ${checkoutResult.error}`);
    return [];
  }

  // Attempt the merge (expected to fail with conflicts)
  await gitCmd(['merge', '--no-commit', '--no-ff', branch], cwd);

  // Get list of conflicted files
  const statusResult = await gitCmd(['diff', '--name-only', '--diff-filter=U'], cwd);
  const conflicts: ConflictFile[] = [];

  if (statusResult.success && statusResult.output) {
    const files = statusResult.output.split('\n').filter(Boolean);

    for (const file of files) {
      try {
        const content = await readFile(resolve(cwd, file), 'utf-8');
        conflicts.push({ file, content });
      } catch {
        console.log(`  ⚠️  Could not read conflicted file: ${file}`);
      }
    }
  }

  // Abort the merge to restore clean state
  await gitCmd(['merge', '--abort'], cwd);

  // Return to original branch
  if (originalBranch) {
    await gitCmd(['checkout', originalBranch], cwd);
  }

  return conflicts;
}

/**
 * Detect if conflicts are in binary files (unresolvable by LLM).
 */
export function hasBinaryConflicts(conflicts: ConflictFile[]): boolean {
  for (const conflict of conflicts) {
    // Binary files don't have standard conflict markers
    if (!conflict.content.includes('<<<<<<<') && !conflict.content.includes('>>>>>>>')) {
      return true;
    }
    // Check for null bytes (binary indicator)
    if (conflict.content.includes('\0')) {
      return true;
    }
  }
  return false;
}

/**
 * Send conflicts to the LLM for resolution.
 * The LLM returns resolved file contents in code blocks.
 */
export async function resolveConflicts(
  conflicts: ConflictFile[],
  adapter: AgentAdapter,
  basePath: string,
  options?: {
    promptPath?: string;
    taskDescription?: string;
    branchName?: string;
    targetBranch?: string;
    projectName?: string;
  }
): Promise<ConflictResolution> {
  const promptPath = options?.promptPath ?? 'prompts/merge-resolve-conflict.md';

  // Load prompt template
  let template: string;
  try {
    template = await readFile(resolve(basePath, promptPath), 'utf-8');
  } catch {
    console.log(`  ⚠️  Conflict prompt not found: ${promptPath}, using inline prompt`);
    template = DEFAULT_CONFLICT_PROMPT;
  }

  // Build conflict context
  const conflictContext = conflicts.map((c) => {
    return `### ${c.file}\n\`\`\`\n${c.content}\n\`\`\``;
  }).join('\n\n');

  // Resolve template variables
  const vars: Record<string, string> = {
    conflict_files: conflictContext,
    task_description: options?.taskDescription ?? '(no description)',
    branch_name: options?.branchName ?? '(unknown)',
    target_branch: options?.targetBranch ?? 'main',
    project_name: options?.projectName ?? '(unknown)',
    file_count: String(conflicts.length),
  };

  let prompt = template;
  for (const [key, value] of Object.entries(vars)) {
    prompt = prompt.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
  }

  const request: AgentRequest = { prompt };
  const response = await adapter.execute(request);

  if (!response.success || !response.output) {
    return {
      success: false,
      resolvedFiles: [],
      error: response.error ?? 'LLM returned no output',
    };
  }

  // Parse resolved files from LLM output
  const resolvedFiles = parseCodeBlocks(response.output);

  if (resolvedFiles.length === 0) {
    return {
      success: false,
      resolvedFiles: [],
      error: 'LLM output contained no code blocks with file paths',
    };
  }

  // Verify that the LLM resolved all conflicted files
  const conflictedPaths = new Set(conflicts.map((c) => c.file));
  const resolvedPaths = new Set(resolvedFiles.map((f) => f.filePath));
  const missing = Array.from(conflictedPaths).filter((p) => !resolvedPaths.has(p));

  if (missing.length > 0) {
    console.log(`  ⚠️  LLM did not resolve all files. Missing: ${missing.join(', ')}`);
  }

  return {
    success: true,
    resolvedFiles,
  };
}

/**
 * Apply resolved files to the working tree, stage them, and commit.
 * This should be called while on the branch being merged
 * (after the conflict resolution is complete).
 */
export async function applyResolution(
  cwd: string,
  resolvedFiles: FileChange[],
  commitMessage: string
): Promise<{ success: boolean; error?: string }> {
  // Write resolved files
  for (const file of resolvedFiles) {
    const fullPath = resolve(cwd, file.filePath);
    try {
      await writeFile(fullPath, file.content, 'utf-8');
      console.log(`  📝 Resolved: ${file.filePath}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: `Failed to write ${file.filePath}: ${msg}` };
    }
  }

  // Stage all changes
  const addResult = await gitCmd(['add', '-A'], cwd);
  if (!addResult.success) {
    return { success: false, error: `git add failed: ${addResult.error}` };
  }

  // Commit
  const commitResult = await gitCmd(['commit', '-m', commitMessage], cwd);
  if (!commitResult.success) {
    return { success: false, error: `git commit failed: ${commitResult.error}` };
  }

  return { success: true };
}

/**
 * Full conflict resolution flow:
 * 1. Extract conflicts between branch and target
 * 2. Check for binary conflicts (unresolvable)
 * 3. Send to LLM for resolution
 * 4. Apply resolved files to the branch
 * 5. Push the fix
 */
export async function resolveAndApply(
  cwd: string,
  branch: string,
  targetBranch: string,
  adapter: AgentAdapter,
  basePath: string,
  options?: {
    taskDescription?: string;
    projectName?: string;
  }
): Promise<{ success: boolean; error?: string }> {
  console.log(`  🔧 Extracting conflicts between ${branch} and ${targetBranch}...`);

  const conflicts = await extractConflicts(cwd, branch, targetBranch);

  if (conflicts.length === 0) {
    return { success: false, error: 'No conflicts detected (or could not extract them)' };
  }

  console.log(`  📄 Found ${conflicts.length} conflicted file(s)`);

  // Check for binary conflicts
  if (hasBinaryConflicts(conflicts)) {
    return {
      success: false,
      error: 'Binary file conflicts detected — cannot auto-resolve',
    };
  }

  // Resolve via LLM
  console.log(`  🤖 Sending conflicts to LLM for resolution...`);
  const resolution = await resolveConflicts(conflicts, adapter, basePath, {
    taskDescription: options?.taskDescription,
    branchName: branch,
    targetBranch,
    projectName: options?.projectName,
  });

  if (!resolution.success) {
    return { success: false, error: resolution.error };
  }

  // Checkout the branch and apply
  const checkoutResult = await gitCmd(['checkout', branch], cwd);
  if (!checkoutResult.success) {
    return { success: false, error: `Could not checkout ${branch}: ${checkoutResult.error}` };
  }

  // Merge target into branch to get the conflict state, then overwrite with resolved files
  await gitCmd(['merge', '--no-commit', '--no-ff', targetBranch], cwd);

  const applyResult = await applyResolution(
    cwd,
    resolution.resolvedFiles,
    `Auto-resolve: merge conflicts with ${targetBranch}`
  );

  if (!applyResult.success) {
    // Abort the merge if apply failed
    await gitCmd(['merge', '--abort'], cwd);
    return { success: false, error: applyResult.error };
  }

  // Push the resolution
  const pushResult = await gitCmd(['push', 'origin', branch], cwd);
  if (!pushResult.success) {
    return { success: false, error: `Push failed after resolution: ${pushResult.error}` };
  }

  console.log(`  ✅ Conflicts resolved and pushed to ${branch}`);
  return { success: true };
}

// --- Default prompt ---

const DEFAULT_CONFLICT_PROMPT = `You are resolving git merge conflicts.

## Context
- Project: {{project_name}}
- Branch: {{branch_name}} merging into {{target_branch}}
- Task: {{task_description}}
- Conflicted files: {{file_count}}

## Conflicted Files

{{conflict_files}}

## Instructions

Resolve each merge conflict. The conflict markers look like:

\`\`\`
<<<<<<< HEAD
code from the target branch
=======
code from the feature branch
>>>>>>>  branch-name
\`\`\`

For each conflicted file, output the COMPLETE resolved file (not just the conflict region) as a code block:

\`\`\`language:path/to/file.ts
// full resolved file content here
\`\`\`

Rules:
- Keep functionality from BOTH sides where possible
- If both sides modify the same logic, prefer the feature branch's intent but ensure compatibility with the target branch
- Remove ALL conflict markers (<<<<<<, =======, >>>>>>>)
- The resolved file must be valid, compilable code
- Output ALL conflicted files, even if the resolution is to keep one side unchanged
`;
