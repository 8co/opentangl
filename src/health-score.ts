import { spawn } from 'node:child_process';
import { readdir, readFile, appendFile } from 'node:fs/promises';
import path from 'node:path';

export interface HealthReport {
  score: number;
  timestamp: string;
  metrics: {
    typeScriptErrors: number;
    totalFiles: number;
    totalLines: number;
    avgFileSize: number;
    largestFile: {
      path: string;
      lines: number;
    };
  };
}

export async function computeHealthScore(basePath: string): Promise<HealthReport> {
  const tsErrors = await countTypeScriptErrors();
  const { totalFiles, totalLines, largestFile } = await analyzeSourceFiles(basePath);
  
  const avgFileSize = totalFiles > 0 ? totalLines / totalFiles : 0;
  
  let score = 100;
  score -= tsErrors * 10;
  if (largestFile.lines > 500) score -= 5;
  if (avgFileSize > 200) score -= 5;
  score = Math.max(0, score);

  return {
    score,
    timestamp: new Date().toISOString(),
    metrics: {
      typeScriptErrors: tsErrors,
      totalFiles,
      totalLines,
      avgFileSize,
      largestFile,
    },
  };
}

async function countTypeScriptErrors(): Promise<number> {
  return new Promise((resolve, reject) => {
    const proc = spawn('npx', ['tsc', '--noEmit'], { shell: true });

    let stderr = '';
    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', () => {
      const errorLines = stderr.split('\n').filter(line => line.includes(': error TS')).length;
      resolve(errorLines);
    });

    proc.on('error', reject);
  });
}

async function analyzeSourceFiles(basePath: string) {
  const files: string[] = await getAllFiles(basePath, '.ts');
  let totalLines = 0;
  let largestFile = { path: '', lines: 0 };

  for (const filepath of files) {
    const fileContent = await readFile(filepath, 'utf-8');
    const lineCount = fileContent.split('\n').length;

    totalLines += lineCount;
    if (lineCount > largestFile.lines) {
      largestFile = { path: filepath, lines: lineCount };
    }
  }

  return { totalFiles: files.length, totalLines, largestFile };
}

async function getAllFiles(dir: string, ext: string, files: string[] = []): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const res = path.resolve(dir, entry.name);
    if (entry.isDirectory()) {
      await getAllFiles(res, ext, files);
    } else if (entry.isFile() && entry.name.endsWith(ext)) {
      files.push(res);
    }
  }

  return files;
}

export async function trackHealthScore(report: HealthReport): Promise<void> {
  const data = JSON.stringify(report);
  await appendFile('health-scores.jsonl', data + '\n');
}

export async function getHealthTrend(): Promise<HealthReport[]> {
  try {
    const content = await readFile('health-scores.jsonl', 'utf-8');
    const lines = content.trim().split('\n');
    return lines.map(line => JSON.parse(line));
  } catch {
    return [];
  }
}
