/**
 * State Manager (Local File-Based)
 * Persists workflow execution state to disk as JSON
 */

import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import type { StateManager, WorkflowExecution } from './types.js';

const STATE_DIR = '.state';

export function createStateManager(basePath: string): StateManager {
  const stateDir = resolve(basePath, STATE_DIR);

  async function ensureDir(): Promise<void> {
    await mkdir(stateDir, { recursive: true });
  }

  function filePath(executionId: string): string {
    return join(stateDir, `${executionId}.json`);
  }

  return {
    async save(execution: WorkflowExecution): Promise<void> {
      await ensureDir();
      const data = JSON.stringify(execution, null, 2);
      await writeFile(filePath(execution.executionId), data, 'utf-8');
    },

    async load(executionId: string): Promise<WorkflowExecution | null> {
      try {
        const data = await readFile(filePath(executionId), 'utf-8');
        return JSON.parse(data) as WorkflowExecution;
      } catch {
        return null;
      }
    },

    async list(): Promise<WorkflowExecution[]> {
      await ensureDir();
      const files = await readdir(stateDir);
      const executions: WorkflowExecution[] = [];

      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        try {
          const data = await readFile(join(stateDir, file), 'utf-8');
          executions.push(JSON.parse(data) as WorkflowExecution);
        } catch {
          // Skip corrupt state files
        }
      }

      return executions.sort(
        (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
      );
    },
  };
}

