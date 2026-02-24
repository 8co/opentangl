/**
 * Verify Runner
 * Spawns child processes to run build/test/lint commands after
 * the LLM writes files. Captures stdout/stderr for error feedback.
 */

import { spawn } from 'node:child_process';

export interface VerifyCommand {
  label: string;
  command: string;
  args: string[];
  optional?: boolean; // If true, failure doesn't block the pipeline
}

export interface VerifyResult {
  label: string;
  passed: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface VerificationSummary {
  allPassed: boolean;
  results: VerifyResult[];
  errorSummary: string; // Formatted for feeding back to LLM
}

const DEFAULT_TIMEOUT_MS = 60_000; // 60 seconds

/**
 * Run a single verification command and capture output.
 */
function runCommand(
  cmd: VerifyCommand,
  cwd: string,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<VerifyResult> {
  return new Promise((resolvePromise) => {
    const start = Date.now();
    let stdout = '';
    let stderr = '';

    const proc = spawn(cmd.command, cmd.args, {
      cwd,
      shell: true,
      env: { ...process.env, FORCE_COLOR: '0' },
      timeout: timeoutMs,
    });

    proc.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on('close', (exitCode) => {
      resolvePromise({
        label: cmd.label,
        passed: exitCode === 0,
        exitCode,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        durationMs: Date.now() - start,
      });
    });

    proc.on('error', (err) => {
      resolvePromise({
        label: cmd.label,
        passed: false,
        exitCode: null,
        stdout: '',
        stderr: err.message,
        durationMs: Date.now() - start,
      });
    });
  });
}

/**
 * Run all verification commands sequentially.
 * Stops on first required failure.
 */
export async function runVerification(
  commands: VerifyCommand[],
  cwd: string
): Promise<VerificationSummary> {
  const results: VerifyResult[] = [];
  let allPassed = true;

  for (const cmd of commands) {
    console.log(`  🔍 ${cmd.label}...`);

    const result = await runCommand(cmd, cwd);
    results.push(result);

    if (result.passed) {
      console.log(`  ✅ ${cmd.label} passed (${result.durationMs}ms)`);
    } else if (cmd.optional) {
      console.log(`  ⚠️  ${cmd.label} failed (optional, continuing)`);
    } else {
      console.log(`  ❌ ${cmd.label} failed (exit ${result.exitCode})`);
      allPassed = false;
      break; // Stop on first required failure
    }
  }

  // Build error summary for LLM feedback
  const errorSummary = buildErrorSummary(results);

  return { allPassed, results, errorSummary };
}

/**
 * Format verification errors into a string the LLM can use to fix issues.
 */
function buildErrorSummary(results: VerifyResult[]): string {
  const failed = results.filter((r) => !r.passed);
  if (failed.length === 0) return '';

  const sections = failed.map((r) => {
    const output = [r.stderr, r.stdout].filter(Boolean).join('\n');
    // Truncate to avoid token waste
    const truncated = output.length > 3000
      ? output.slice(0, 3000) + '\n... (truncated)'
      : output;

    return `## ${r.label} (exit ${r.exitCode})\n\`\`\`\n${truncated}\n\`\`\``;
  });

  return `# Verification Errors\n\nThe following commands failed. Fix ALL errors.\n\n${sections.join('\n\n')}`;
}

/**
 * Default verification commands for a TypeScript/Node.js project.
 */
export function defaultVerifyCommands(): VerifyCommand[] {
  return [
    {
      label: 'TypeScript Build',
      command: 'npx',
      args: ['tsc', '--noEmit'],
    },
  ];
}

/**
 * Resolve verification commands for a project.
 * Uses the project's configured verify commands if available,
 * otherwise falls back to default TypeScript verification.
 *
 * ProjectConfig.verify uses a compatible shape: { command, args, optional? }
 */
export function verifyCommandsForProject(
  projectVerify?: Array<{ command: string; args: string[]; optional?: boolean }>
): VerifyCommand[] {
  if (!projectVerify || projectVerify.length === 0) {
    return defaultVerifyCommands();
  }
  return projectVerify.map((v) => ({
    label: `${v.command} ${v.args.join(' ')}`,
    command: v.command,
    args: v.args,
    optional: v.optional,
  }));
}

/**
 * Full verification including tests (when tests exist).
 */
export function fullVerifyCommands(): VerifyCommand[] {
  return [
    {
      label: 'TypeScript Build',
      command: 'npx',
      args: ['tsc', '--noEmit'],
    },
    {
      label: 'Tests',
      command: 'npm',
      args: ['test'],
      optional: true, // Don't block if no tests configured yet
    },
  ];
}

/**
 * Security-enhanced verification for critical infrastructure files.
 * Used when modifying CLI, scheduler, runner, or git-ops.
 */
export function securityVerifyCommands(): VerifyCommand[] {
  return [
    {
      label: 'TypeScript Build',
      command: 'npx',
      args: ['tsc', '--noEmit'],
    },
    {
      label: 'Security Scan',
      command: 'npx',
      args: ['tsx', 'src/security-check-runner.ts'],
    },
  ];
}

