/**
 * Run Logger
 * Tees all console output to a timestamped log file for each orchestrator run.
 * Each log file captures: job ID, project(s), start time, and full console output.
 */

import { mkdirSync, createWriteStream, type WriteStream } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

export interface RunLoggerConfig {
  basePath: string;
  command: string;
  projects?: string[];
}

export interface RunLogger {
  jobId: string;
  logPath: string;
  stop: () => void;
}

function generateJobId(): string {
  return randomBytes(4).toString('hex');
}

function formatTimestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '_',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('');
}

function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

export function startRunLogger(config: RunLoggerConfig): RunLogger {
  const { basePath, command, projects } = config;
  const jobId = generateJobId();
  const startTime = new Date();
  const timestamp = formatTimestamp(startTime);
  const projectLabel = projects && projects.length > 0
    ? projects.join('+')
    : 'orchestrator';

  const logsDir = resolve(basePath, 'logs');
  mkdirSync(logsDir, { recursive: true });

  const filename = `${timestamp}_${projectLabel}_${command}_${jobId}.log`;
  const logPath = resolve(logsDir, filename);

  const stream: WriteStream = createWriteStream(logPath, { flags: 'a' });

  // Write header
  const header = [
    '═'.repeat(60),
    `Job ID:    ${jobId}`,
    `Command:   ${command}`,
    `Project:   ${projectLabel}`,
    `Started:   ${startTime.toISOString()}`,
    `Log file:  ${filename}`,
    '═'.repeat(60),
    '',
  ].join('\n');
  stream.write(header + '\n');

  // Capture original console methods
  const originalLog = console.log;
  const originalError = console.error;
  const originalWarn = console.warn;

  function writeToLog(args: unknown[]): void {
    const line = args.map((a) =>
      typeof a === 'string' ? a : JSON.stringify(a)
    ).join(' ');
    stream.write(stripAnsi(line) + '\n');
  }

  // Override console methods to tee to log file
  console.log = (...args: unknown[]) => {
    originalLog.apply(console, args);
    writeToLog(args);
  };

  console.error = (...args: unknown[]) => {
    originalError.apply(console, args);
    writeToLog(['[ERROR]', ...args]);
  };

  console.warn = (...args: unknown[]) => {
    originalWarn.apply(console, args);
    writeToLog(['[WARN]', ...args]);
  };

  function stop(): void {
    const endTime = new Date();
    const durationSec = Math.round((endTime.getTime() - startTime.getTime()) / 1000);
    const footer = [
      '',
      '═'.repeat(60),
      `Finished:  ${endTime.toISOString()}`,
      `Duration:  ${durationSec}s`,
      '═'.repeat(60),
    ].join('\n');
    stream.write(footer + '\n');

    // Restore original console methods
    console.log = originalLog;
    console.error = originalError;
    console.warn = originalWarn;

    stream.end();
  }

  originalLog(`📝 Logging to ${logPath}`);

  return { jobId, logPath, stop };
}
