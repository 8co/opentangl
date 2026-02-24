/**
 * Project Registry
 * Loads and manages multi-project configuration for the orchestrator.
 * Allows the orchestrator to work on multiple codebases.
 */

import { readFile } from 'node:fs/promises';
import { resolve, isAbsolute } from 'node:path';
import { parse as parseYaml } from 'yaml';

// --- Types ---

export interface VerifyCommand {
  command: string;
  args: string[];
  optional?: boolean;
}

export interface MergeConfig {
  target_branch: string;
  strategy: 'squash' | 'merge' | 'rebase';
  max_attempts: number;
  auto_delete_branch: boolean;
  ci_timeout_ms: number;
}

/** Default merge config applied when a project has no explicit merge settings. */
export const DEFAULT_MERGE_CONFIG: MergeConfig = {
  target_branch: 'main',
  strategy: 'squash',
  max_attempts: 3,
  auto_delete_branch: true,
  ci_timeout_ms: 300_000, // 5 minutes
};

/** Cross-project file reference for giving the LLM read-only context from another project. */
export interface ReferenceContext {
  project: string;  // Project ID from this same projects.yaml
  label: string;    // Human-readable label (e.g. "Backend API", "Shared Types")
  files: string[];  // Paths relative to the referenced project root
}

export interface ProjectConfig {
  id: string;
  name: string;
  path: string; // Relative to orchestrator root, or absolute
  type: string; // typescript-node, serverless-node, react-vite, etc.
  description?: string;
  scan_dirs: string[];
  skip_patterns?: string[];
  verify?: VerifyCommand[];
  package_manager?: 'npm' | 'yarn' | 'pnpm';
  environment?: string; // Environment name — groups projects that share a product vision (e.g. "my-product")
  sensitive_files?: string[]; // Files the proposer should avoid modifying unless explicitly instructed
  reference_context?: ReferenceContext[]; // Read-only files from other projects injected into LLM prompts
  import_rules?: Array<{ package: string; version: number; rules: string[] }>; // Version-specific import/API rules injected into prompts
  merge?: Partial<MergeConfig>; // Merge pipeline config (defaults applied at runtime)
}

export interface ProjectsConfig {
  projects: ProjectConfig[];
}

// --- Registry ---

export class ProjectRegistry {
  private projects: Map<string, ProjectConfig> = new Map<string, ProjectConfig>();
  private configPath: string;
  private orchestratorRoot: string;

  constructor(orchestratorRoot: string, configPath: string = 'projects.yaml') {
    this.orchestratorRoot = orchestratorRoot;
    this.configPath = resolve(orchestratorRoot, configPath);
  }

  /**
   * Load projects configuration from YAML file.
   */
  async load(): Promise<void> {
    try {
      const raw: string = await readFile(this.configPath, 'utf-8');
      const config: ProjectsConfig = parseYaml(raw) as ProjectsConfig;

      if (!config.projects || !Array.isArray(config.projects)) {
        throw new Error('Invalid projects.yaml: missing "projects" array');
      }

      this.projects.clear();

      for (const project of config.projects) {
        try {
          this.validateProjectConfig(project);

          // Resolve path relative to orchestrator root if not absolute
          if (!isAbsolute(project.path)) {
            project.path = resolve(this.orchestratorRoot, project.path);
          }

          // Set defaults
          project.scan_dirs = project.scan_dirs ?? ['src'];
          project.skip_patterns = project.skip_patterns ?? [];
          project.package_manager = project.package_manager ?? 'npm';

          this.projects.set(project.id, project);
        } catch (validationError: unknown) {
          console.warn(`⚠️  Skipping invalid project entry: ${JSON.stringify(project)}. Reason: ${(validationError as Error).message}`);
        }
      }

      console.log(`✅ Loaded ${this.projects.size} project(s) from ${this.configPath}`);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        // No projects.yaml — default to orchestrator working on itself
        const defaultProject: ProjectConfig = {
          id: 'orchestrator',
          name: 'opentangl',
          path: this.orchestratorRoot,
          type: 'typescript-node',
          scan_dirs: ['src'],
          skip_patterns: ['*.test.ts', '*.spec.ts'],
          package_manager: 'npm',
        };
        this.projects.set('orchestrator', defaultProject);
        console.log('ℹ️  No projects.yaml found — using default (orchestrator itself)');
      } else {
        console.error(`❌ Failed to load projects.yaml from ${this.configPath}: ${(err as Error).message}`);
      }
    }
  }

  /**
   * Validate the necessary fields in a ProjectConfig
   */
  private validateProjectConfig(project: ProjectConfig): void {
    if (!project.id || !project.name || !project.path) {
      throw new Error('Project config missing required fields: id, name, or path');
    }
  }

  /**
   * Get a project by ID.
   */
  get(projectId: string): ProjectConfig | undefined {
    return this.projects.get(projectId);
  }

  /**
   * Get all registered projects.
   */
  getAll(): ProjectConfig[] {
    return Array.from(this.projects.values());
  }

  /**
   * Get the default project (first one, or 'orchestrator' if present).
   */
  getDefault(): ProjectConfig {
    const orchestrator = this.projects.get('orchestrator');
    if (orchestrator) return orchestrator;

    const first = this.projects.values().next().value;
    if (first) return first;

    throw new Error('No projects configured');
  }

  /**
   * List all project IDs.
   */
  listIds(): string[] {
    return Array.from(this.projects.keys());
  }

  /**
   * Print a summary of registered projects.
   */
  print(): void {
    console.log('\n📁 Registered Projects:\n');
    for (const [id, project] of this.projects) {
      console.log(`  ${id.padEnd(15)} ${project.name}`);
      console.log(`  ${''.padEnd(15)} ${project.path}`);
      console.log(`  ${''.padEnd(15)} Type: ${project.type}, Scan: ${project.scan_dirs.join(', ')}`);
      console.log('');
    }
  }
}

/**
 * Resolve a project's merge config, applying defaults for any missing fields.
 */
export function resolveMergeConfig(project: ProjectConfig): MergeConfig {
  return {
    ...DEFAULT_MERGE_CONFIG,
    ...project.merge,
  };
}

/**
 * Create a project registry instance.
 */
export function createProjectRegistry(
  orchestratorRoot: string,
  configPath?: string
): ProjectRegistry {
  return new ProjectRegistry(orchestratorRoot, configPath);
}
