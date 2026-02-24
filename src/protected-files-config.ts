import { basename } from 'node:path';

export interface ProtectedFilesConfig {
  files: Set<string>;
  patterns: string[];
}

export const ORCHESTRATOR_PROTECTED: ProtectedFilesConfig = {
  files: new Set([
    'src/types.ts',
    'src/cli.ts',
    'src/config.ts',
    'src/autonomous-runner.ts',
    'src/scheduler.ts',
    'src/queue-manager.ts',
    'src/task-proposer.ts',
    'src/file-writer.ts',
    'src/verify-runner.ts',
    'src/git-ops.ts',
    'src/workflow-runner.ts',
    'src/prompt-resolver.ts',
    'src/state-manager.ts',
    'package.json',
    'tsconfig.json',
    'AGENTS.md',
  ]),
  patterns: [],
};

export const COMMON_CONFIG_PROTECTED: ProtectedFilesConfig = {
  files: new Set(),
  patterns: [
    'package.json',
    'package-lock.json',
    'tsconfig.json',
    '*.config.ts',
    '*.config.js',
    'serverless.yml',
    'serverless.yaml',
    '.eslintrc*',
    '.prettierrc*',
    'sst.config.ts',
  ],
};

export function getProtectedFiles(projectId: string, projectType?: string): ProtectedFilesConfig {
  return projectId === 'orchestrator' ? ORCHESTRATOR_PROTECTED : COMMON_CONFIG_PROTECTED;
}

export function isProtected(filePath: string, config: ProtectedFilesConfig): boolean {
  if (config.files.has(filePath)) {
    return true;
  }

  const fileName = basename(filePath);
  return config.patterns.some((pattern) => {
    const regex = new RegExp(`^${pattern.replace(/\*/g, '.*')}$`);
    return regex.test(fileName);
  });
}
