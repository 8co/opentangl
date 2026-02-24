import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

export interface DiffSummary {
  filesChanged: string[];
  linesAdded: number;
  linesRemoved: number;
}

export function generateDiffPreview(basePath: string): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const results: string[] = [];
    const complete = (stdout: string) => {
      results.push(stdout);
      if (results.length === 2) {
        resolvePromise(results.join('\n'));
      }
    };

    const handleError = (error: Error) => {
      rejectPromise(error);
    };

    const cwd = resolve(basePath);

    const procStaged = spawn('git', ['diff', '--staged'], { cwd });
    const procWorking = spawn('git', ['diff'], { cwd });

    let stdoutStaged = '';
    let stdoutWorking = '';

    procStaged.stdout.on('data', (data: Buffer) => {
      stdoutStaged += data.toString();
    });

    procStaged.on('close', () => {
      complete(stdoutStaged);
    });

    procStaged.on('error', handleError);

    procWorking.stdout.on('data', (data: Buffer) => {
      stdoutWorking += data.toString();
    });

    procWorking.on('close', () => {
      complete(stdoutWorking);
    });

    procWorking.on('error', handleError);
  });
}

export function formatDiffSummary(diff: string): DiffSummary {
  const lines = diff.split('\n');
  const filesChanged = [];
  let linesAdded = 0;
  let linesRemoved = 0;

  for (const line of lines) {
    if (line.startsWith('+++ b/') || line.startsWith('--- a/')) {
      filesChanged.push(line.split(' ')[1].substr(2));
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      linesAdded++;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      linesRemoved++;
    }
  }

  return { filesChanged, linesAdded, linesRemoved };
}

export function printDiffPreview(diff: string): void {
  const summary = formatDiffSummary(diff);
  console.log('\nDiff Summary:');
  console.log(`Files Changed: ${summary.filesChanged.length}`);
  console.log(`Lines Added: \u001b[32m${summary.linesAdded}\u001b[0m`);
  console.log(`Lines Removed: \u001b[31m${summary.linesRemoved}\u001b[0m`);
  console.log('Files:');
  summary.filesChanged.forEach((file) => {
    console.log(`  - ${file}`);
  });
}
