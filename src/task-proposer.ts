/**
 * Task Proposer
 * Feeds the codebase to an LLM and asks it to propose the next development tasks.
 * Parses the YAML response and appends new tasks to the queue.
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve, join, relative, extname } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { AgentAdapter, AgentRequest } from './types.js';
import { createQueueManager, type QueueTask } from './queue-manager.js';
import type { ProjectConfig, ProjectRegistry } from './project-registry.js';
import { generateProjectContext } from './project-context.js';
import { getProfile, getLanguageVarsFromProfile } from './project-profiles.js';
import { buildReferenceContext } from './file-writer.js';

// --- Types ---

export interface ProposerConfig {
  basePath: string;
  adapter: AgentAdapter;
  promptPath?: string;
  reviewPromptPath?: string;
  maxTasks?: number;
  maxFileSize?: number;    // Skip files larger than this (bytes)
  includeGlobs?: string[]; // Only include these directories
  skipReview?: boolean;     // Skip the self-review step (default: false)
  projectConfig?: ProjectConfig; // Multi-project support
  orchestratorRoot?: string;     // Path to orchestrator (for prompts)
  registry?: ProjectRegistry;    // Project registry (for cross-project reference context)
  featureRatio?: number;   // Minimum ratio of feature/architecture tasks (0-1, default: 0)
}

export type TaskType = 'feature' | 'architecture' | 'maintenance';

interface ProposedTask {
  id: string;
  type?: TaskType;
  project?: string;              // Project ID (multi-project mode)
  prompt: string;
  depends_on?: string[];        // Task IDs that must complete+merge first
  context_files?: string[];
  variables?: Record<string, string>;
}

export interface MultiProjectProposerConfig {
  adapter: AgentAdapter;
  projectConfigs: ProjectConfig[];
  orchestratorRoot: string;
  registry: ProjectRegistry;
  promptPath?: string;
  maxTasks?: number;
  maxFileSize?: number;
  featureRatio?: number;
  skipReview?: boolean;
}

// --- Helpers ---

/**
 * Format a queue task for display in the proposer prompt.
 * Surfaces merge_status and error so the LLM knows when a "completed"
 * task was actually escalated and the underlying problem is unresolved.
 */
function formatExistingTask(t: QueueTask): string {
  const project = t.project ? ` [${t.project}]` : '';
  const merge = t.merge_status && t.merge_status !== 'merged'
    ? `, merge: ${t.merge_status}`
    : '';
  const error = t.merge_status === 'escalated' && t.error
    ? ` — "${t.error.slice(0, 120)}"`
    : '';
  return `- ${t.id}${project} (${t.status}${merge})${error}`;
}

const DEFAULT_SCAN_DIRS = ['src'];
const SKIP_EXTENSIONS = new Set(['.test.ts', '.spec.ts', '.test.js', '.spec.js', '.test.tsx']);
const MAX_FILE_SIZE = 50_000; // 50KB

/**
 * Recursively scan a directory for source files.
 */
async function scanSourceFiles(
  dir: string,
  basePath: string,
  maxSize: number,
  skipPatterns: string[] = []
): Promise<{ path: string; content: string }[]> {
  const files: { path: string; content: string }[] = [];

  async function walk(currentDir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = join(currentDir, entry.name);

      if (entry.isDirectory()) {
        // Skip node_modules, dist, .state, etc.
        if (['node_modules', 'dist', '.state', '.git', 'output', '.serverless', 'build'].includes(entry.name)) {
          continue;
        }
        await walk(fullPath);
      } else if (entry.isFile()) {
        // Check file extensions
        const ext = extname(entry.name);
        if (!['.ts', '.tsx', '.js', '.jsx', '.yaml', '.yml', '.json'].includes(ext)) {
          continue;
        }

        // Skip test files
        if (SKIP_EXTENSIONS.has(ext) || entry.name.includes('.test.')) {
          continue;
        }

        // Check skip patterns
        const relPath = relative(basePath, fullPath);
        if (skipPatterns.some(pattern => relPath.includes(pattern))) {
          continue;
        }

        try {
          const stats = await stat(fullPath);
          if (stats.size > maxSize) continue;

          const content = await readFile(fullPath, 'utf-8');
          files.push({ path: relPath, content });
        } catch {
          // Skip unreadable files
        }
      }
    }
  }

  await walk(dir);
  return files;
}

/**
 * Build a codebase summary for the LLM.
 */
async function buildCodebaseSummary(
  basePath: string,
  maxSize: number,
  scanDirs: string[] = DEFAULT_SCAN_DIRS,
  skipPatterns: string[] = []
): Promise<string> {
  const sections: string[] = [];

  // Scan source directories
  for (const dir of scanDirs) {
    const dirPath = resolve(basePath, dir);
    const files = await scanSourceFiles(dirPath, basePath, maxSize, skipPatterns);

    for (const file of files) {
      sections.push(`--- ${file.path} ---\n${file.content}`);
    }
  }

  // Include package.json for dependency awareness
  try {
    const pkg = await readFile(resolve(basePath, 'package.json'), 'utf-8');
    sections.push(`--- package.json ---\n${pkg}`);
  } catch {
    // Skip if not found
  }

  return sections.join('\n\n');
}

/**
 * Extract a task array from parsed YAML, handling both bare arrays
 * and objects with a `tasks` key.
 */
function extractTaskArray(parsed: unknown): ProposedTask[] {
  if (Array.isArray(parsed)) return parsed as ProposedTask[];
  if (parsed && typeof parsed === 'object' && 'tasks' in parsed) {
    const obj = parsed as { tasks: unknown };
    if (Array.isArray(obj.tasks)) return obj.tasks as ProposedTask[];
  }
  return [];
}

/**
 * Parse the LLM's YAML response into task objects.
 */
function parseProposedTasks(llmOutput: string): ProposedTask[] {
  // Extract YAML block — handle ```yaml:tasks, ```yaml, and ```yml formats
  const yamlMatch = llmOutput.match(/```(?:yaml:tasks|yaml|yml)\n([\s\S]*?)```/);
  if (!yamlMatch) {
    // Try parsing the entire output as YAML
    try {
      return extractTaskArray(parseYaml(llmOutput));
    } catch {
      // Fall through
    }
    return [];
  }

  try {
    return extractTaskArray(parseYaml(yamlMatch[1]));
  } catch {
    return [];
  }
}

// --- Proposer ---

export function createTaskProposer(config: ProposerConfig) {
  const {
    basePath,
    adapter,
    promptPath = 'prompts/auto-propose-tasks.md',
    reviewPromptPath = 'prompts/auto-review-tasks.md',
    maxTasks = 5,
    maxFileSize = MAX_FILE_SIZE,
    skipReview = false,
    projectConfig,
    orchestratorRoot,
    registry,
    featureRatio = 0,
  } = config;

  // Use project config if provided
  const scanDirs = projectConfig?.scan_dirs ?? DEFAULT_SCAN_DIRS;
  const skipPatterns = projectConfig?.skip_patterns ?? [];
  const projectName = projectConfig?.name ?? 'opentangl';
  const projectDescription = projectConfig?.description ?? 'Autonomous AI agent system';
  const sensitiveFiles = projectConfig?.sensitive_files ?? [];

  // Build sensitive files section (injected into prompts when files are configured)
  const sensitiveFilesSection = sensitiveFiles.length > 0
    ? `## Sensitive Files (DO NOT modify unless explicitly requested)\n\n${sensitiveFiles.map((f) => `- ${f}`).join('\n')}\n\nThese files are critical to the application. Do NOT propose tasks that modify them.\nFocus on new modules, tests, utilities, and non-critical improvements.\n`
    : '';

  // Prompts always come from orchestrator root
  const promptBasePath = orchestratorRoot ?? basePath;

  // Queue always lives in the orchestrator, not in the target project
  const queueBasePath = orchestratorRoot ?? basePath;
  const queue = createQueueManager(queueBasePath);

  /**
   * Self-review: Feed proposed tasks back to the LLM to filter out
   * bad ideas before they hit the queue.
   */
  async function reviewTasks(tasks: ProposedTask[]): Promise<ProposedTask[]> {
    if (tasks.length === 0 || skipReview) return tasks;

    console.log('\n🧠 Self-review: LLM auditing its own proposals...\n');

    // Load review prompt
    const templatePath = resolve(promptBasePath, reviewPromptPath);
    let template: string;
    try {
      template = await readFile(templatePath, 'utf-8');
    } catch {
      console.log('   ⚠️  Review prompt not found, skipping review');
      return tasks;
    }

    // Format proposed tasks as YAML for the reviewer
    const { stringify: stringifyYaml } = await import('yaml');
    const tasksYaml = stringifyYaml(tasks, { lineWidth: 120 });

    // Resolve language variables for review template
    const reviewProjectType = projectConfig?.type ?? 'typescript-node';
    const reviewProfile = getProfile(reviewProjectType);
    const reviewLangVars = reviewProfile ? getLanguageVarsFromProfile(reviewProfile) : {
      language: 'TypeScript',
      code_lang: 'typescript',
      file_ext: 'ts',
      module_system: 'ES modules (import/export, .js extensions in imports)',
      language_instructions: 'TypeScript strict mode — no `any`, no implicit types.',
    };

    let prompt = template
      .replace(/\{\{\s*project_name\s*\}\}/g, projectName)
      .replace(/\{\{\s*proposed_tasks\s*\}\}/g, tasksYaml)
      .replace(/\{\{\s*sensitive_files_section\s*\}\}/g, sensitiveFilesSection);

    for (const [key, value] of Object.entries(reviewLangVars)) {
      prompt = prompt.replace(new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, 'g'), value);
    }

    const request: AgentRequest = { prompt };
    const response = await adapter.execute(request);

    if (!response.success || !response.output) {
      console.log('   ⚠️  Review call failed, proceeding with unfiltered tasks');
      return tasks;
    }

    const reviewed = parseProposedTasks(response.output);

    const kept = reviewed.length;
    const dropped = tasks.length - kept;

    if (dropped > 0) {
      console.log(`   🔍 Review result: kept ${kept}, dropped ${dropped}`);
      const droppedIds = tasks
        .filter((t) => !reviewed.some((r) => r.id === t.id))
        .map((t) => t.id);
      for (const id of droppedIds) {
        console.log(`   ❌ Dropped: ${id}`);
      }
    } else {
      console.log(`   ✅ Review result: all ${kept} tasks approved`);
    }

    return reviewed;
  }

  /**
   * Log type distribution of proposed tasks and warn if feature ratio is unmet.
   */
  function logTaskTypeDistribution(tasks: ProposedTask[]): void {
    if (tasks.length === 0) return;

    const counts: Record<string, number> = { feature: 0, architecture: 0, maintenance: 0, untagged: 0 };
    for (const t of tasks) {
      const type = t.type ?? 'untagged';
      counts[type] = (counts[type] ?? 0) + 1;
    }

    const featureCount = counts.feature + counts.architecture;
    const total = tasks.length;
    const actualRatio = featureCount / total;

    console.log(`\n📊 Task type distribution:`);
    console.log(`   Feature: ${counts.feature} | Architecture: ${counts.architecture} | Maintenance: ${counts.maintenance}${counts.untagged ? ` | Untagged: ${counts.untagged}` : ''}`);
    console.log(`   Feature+Architecture ratio: ${(actualRatio * 100).toFixed(0)}% (target: ${(featureRatio * 100).toFixed(0)}%)`);

    if (featureRatio > 0 && actualRatio < featureRatio) {
      console.log(`   ⚠️  Below target feature ratio — consider adding more feature/architecture tasks to the backlog`);
    }
  }

  return {
    /**
     * Analyze the codebase and propose new tasks.
     * Returns the proposed tasks without adding them to the queue.
     */
    async propose(): Promise<ProposedTask[]> {
      console.log('\n🔍 Scanning codebase...');
      const codebaseSummary = await buildCodebaseSummary(basePath, maxFileSize, scanDirs, skipPatterns);
      const lineCount = codebaseSummary.split('\n').length;
      console.log(`   Found ${lineCount} lines of source code`);

      // Load prompt template
      const templatePath = resolve(promptBasePath, promptPath);
      let template: string;
      try {
        template = await readFile(templatePath, 'utf-8');
      } catch {
        throw new Error(`Propose prompt not found: ${templatePath}`);
      }

      // Get existing task IDs to avoid duplicates
      const existingTasks = await queue.list();
      const existingIds = new Set(existingTasks.map((t) => t.id));

      // Resolve language variables from project profile
      const projectType = projectConfig?.type ?? 'typescript-node';
      const profile = getProfile(projectType);
      const langVars = profile ? getLanguageVarsFromProfile(profile) : {
        language: 'TypeScript',
        code_lang: 'typescript',
        file_ext: 'ts',
        module_system: 'ES modules (import/export, .js extensions in imports)',
        language_instructions: 'TypeScript strict mode — no `any`, no implicit types.',
      };

      // Inject variables (project info + language vars + sensitive files)
      let prompt = template
        .replace(/\{\{\s*project_name\s*\}\}/g, projectName)
        .replace(/\{\{\s*project_description\s*\}\}/g, projectDescription)
        .replace(/\{\{\s*max_tasks\s*\}\}/g, String(maxTasks))
        .replace(/\{\{\s*sensitive_files_section\s*\}\}/g, sensitiveFilesSection);

      // Replace language template variables
      for (const [key, value] of Object.entries(langVars)) {
        prompt = prompt.replace(new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, 'g'), value);
      }

      // Generate project context preamble (language, framework, patterns)
      let projectContextStr = '';
      try {
        projectContextStr = await generateProjectContext(basePath);
      } catch {
        // Non-fatal — proceed without context
      }

      // Build cross-project reference context (if configured)
      let referenceContextStr = '';
      if (projectConfig?.reference_context && registry) {
        referenceContextStr = await buildReferenceContext(projectConfig.reference_context, registry);
        if (referenceContextStr) {
          console.log(`   📎 Loaded reference context from ${projectConfig.reference_context.length} project(s)`);
        }
      }

      // Build the full prompt with project context, reference context, and codebase
      const fullPrompt = `${prompt}\n\n${projectContextStr}\n\n${referenceContextStr ? `${referenceContextStr}\n\n` : ''}## Current Codebase\n\n${codebaseSummary}\n\n## Existing Tasks (do NOT duplicate these)\n\n${existingTasks.map((t) => formatExistingTask(t)).join('\n') || 'None'}`;

      console.log('🤖 Asking LLM to propose tasks...\n');

      const request: AgentRequest = {
        prompt: fullPrompt,
      };

      const response = await adapter.execute(request);

      if (!response.success || !response.output) {
        throw new Error(`LLM call failed: ${response.error ?? 'no output'}`);
      }

      // Parse tasks from response
      const proposed = parseProposedTasks(response.output);

      // Filter out duplicates
      const newTasks = proposed.filter((t) => !existingIds.has(t.id));

      console.log(`\n📋 Proposed ${proposed.length} tasks, ${newTasks.length} are new`);

      // Self-review: LLM audits its own proposals
      const reviewed = await reviewTasks(newTasks);

      // Log type distribution
      logTaskTypeDistribution(reviewed);

      return reviewed;
    },

    /**
     * Propose tasks and add them to the queue.
     * Returns the tasks that were added.
     */
    async proposeAndQueue(): Promise<QueueTask[]> {
      const proposed = await this.propose();

      if (proposed.length === 0) {
        console.log('   No new tasks to add.');
        return [];
      }

      // Convert to QueueTasks and append
      const projectId = projectConfig?.id;
      const queueTasks: QueueTask[] = proposed.map((t) => ({
        id: t.id,
        status: 'pending' as const,
        workflow: 'auto',
        prompt: t.prompt,
        ...(projectId ? { project: projectId } : {}),
        ...(t.type ? { task_type: t.type } : {}),
        ...(t.depends_on && t.depends_on.length > 0 ? { depends_on: t.depends_on } : {}),
        context_files: t.context_files,
        variables: t.variables,
      }));

      // Load existing queue, append new tasks, save (queue lives in orchestrator root)
      const existing = await queue.list();
      const allTasks = [...existing, ...queueTasks];

      // Write updated queue using the yaml module
      const { writeFile: writeFs } = await import('node:fs/promises');
      const { stringify: stringifyYaml } = await import('yaml');
      const queuePath = resolve(queueBasePath, 'tasks/queue.yaml');
      await writeFs(queuePath, stringifyYaml({ tasks: allTasks }, { lineWidth: 120 }), 'utf-8');

      console.log(`\n✅ Added ${queueTasks.length} tasks to queue:`);
      for (const t of queueTasks) {
        console.log(`   ⏳ ${t.id}`);
      }

      return queueTasks;
    },

    /**
     * Preview proposed tasks without adding to queue (dry run).
     */
    async preview(): Promise<void> {
      const proposed = await this.propose();

      if (proposed.length === 0) {
        console.log('\n   LLM found nothing to propose.');
        return;
      }

      console.log('\n📋 Proposed Tasks (preview — not queued):\n');
      for (const task of proposed) {
        console.log(`  ⏳ ${task.id}`);
        console.log(`     Prompt: ${task.prompt}`);
        if (task.context_files) {
          console.log(`     Context: ${task.context_files.join(', ')}`);
        }
        if (task.variables) {
          const desc = task.variables['module_description'] ??
            task.variables['modification_description'] ??
            task.variables['test_description'] ?? '';
          if (desc) {
            console.log(`     Description: ${desc.slice(0, 100).trim()}...`);
          }
        }
        console.log('');
      }
    },
  };
}

// --- Multi-Project Proposer ---

/**
 * Propose tasks across multiple projects in a single LLM call.
 * The LLM sees all codebases and can emit tasks with `project` and `depends_on`
 * fields for cross-project dependency chains (e.g. API endpoint before UI page).
 */
export function createMultiProjectProposer(config: MultiProjectProposerConfig) {
  const {
    adapter,
    projectConfigs,
    orchestratorRoot,
    registry,
    promptPath = 'prompts/auto-propose-multi-project.md',
    maxTasks = 5,
    maxFileSize = MAX_FILE_SIZE,
    featureRatio = 0,
    skipReview = false,
  } = config;

  const queue = createQueueManager(orchestratorRoot);

  // ~4 chars per token. Reserve 30K tokens for prompt template + existing tasks + response.
  // That leaves ~98K tokens (~390K chars) for codebase content on a 128K model.
  const MAX_CONTEXT_CHARS = 380_000;

  /**
   * Build a combined codebase summary for all projects with project labels.
   * Enforces a character budget so we don't blow the context window.
   * Splits the budget equally across projects, then fills greedily.
   */
  async function buildMultiProjectSummary(): Promise<string> {
    const sections: string[] = [];
    let totalChars = 0;
    const perProjectBudget = Math.floor(MAX_CONTEXT_CHARS / projectConfigs.length);

    for (const pc of projectConfigs) {
      const scanDirs = pc.scan_dirs ?? DEFAULT_SCAN_DIRS;
      const skipPatterns = pc.skip_patterns ?? [];
      const projectPath = pc.path;
      let projectChars = 0;
      let filesIncluded = 0;
      let filesSkipped = 0;

      const header = `\n${'='.repeat(60)}\nPROJECT: ${pc.name} (id: ${pc.id})\nType: ${pc.type}\n${'='.repeat(60)}`;
      sections.push(header);
      totalChars += header.length;
      projectChars += header.length;

      // Collect all files for this project, sorted smallest first for max coverage
      const allFiles: { path: string; content: string }[] = [];
      for (const dir of scanDirs) {
        const dirPath = resolve(projectPath, dir);
        const files = await scanSourceFiles(dirPath, projectPath, maxFileSize, skipPatterns);
        allFiles.push(...files);
      }

      // Include package.json
      try {
        const pkg = await readFile(resolve(projectPath, 'package.json'), 'utf-8');
        allFiles.unshift({ path: 'package.json', content: pkg });
      } catch {
        // Skip
      }

      // Sort by size (smallest first) to maximize file count within budget
      allFiles.sort((a, b) => a.content.length - b.content.length);

      for (const file of allFiles) {
        const entry = `--- [${pc.id}] ${file.path} ---\n${file.content}`;
        if (projectChars + entry.length > perProjectBudget) {
          filesSkipped++;
          continue;
        }
        sections.push(entry);
        projectChars += entry.length;
        totalChars += entry.length;
        filesIncluded++;
      }

      if (filesSkipped > 0) {
        const note = `\n(${filesSkipped} file(s) omitted from ${pc.id} to fit context budget)`;
        sections.push(note);
        totalChars += note.length;
        console.log(`   📁 ${pc.id}: ${filesIncluded} files included, ${filesSkipped} omitted (budget: ${Math.round(perProjectBudget / 1000)}K chars)`);
      }
    }

    console.log(`   📊 Total context: ${Math.round(totalChars / 1000)}K chars (~${Math.round(totalChars / 4000)}K tokens)`);
    return sections.join('\n\n');
  }

  /**
   * Build the project descriptions section for the prompt.
   */
  function buildProjectDescriptions(): string {
    return projectConfigs.map((pc) => {
      const langProfile = getProfile(pc.type);
      const langName = langProfile ? getLanguageVarsFromProfile(langProfile).language : 'Unknown';
      const sensitive = pc.sensitive_files && pc.sensitive_files.length > 0
        ? `\n  Sensitive files (DO NOT modify): ${pc.sensitive_files.join(', ')}`
        : '';
      return `- **${pc.name}** (id: \`${pc.id}\`, type: ${pc.type}, language: ${langName})\n  ${pc.description ?? 'No description'}${sensitive}`;
    }).join('\n');
  }

  return {
    /**
     * Propose tasks across all configured projects.
     */
    async propose(): Promise<ProposedTask[]> {
      console.log(`\n🔍 Scanning ${projectConfigs.length} project(s)...`);
      for (const pc of projectConfigs) {
        console.log(`   📁 ${pc.name} (${pc.id})`);
      }

      const combinedSummary = await buildMultiProjectSummary();
      const lineCount = combinedSummary.split('\n').length;
      console.log(`   Total: ${lineCount} lines of source code across ${projectConfigs.length} project(s)`);

      // Load prompt template
      const templatePath = resolve(orchestratorRoot, promptPath);
      let template: string;
      try {
        template = await readFile(templatePath, 'utf-8');
      } catch {
        throw new Error(`Multi-project propose prompt not found: ${templatePath}`);
      }

      // Get existing task IDs
      const existingTasks = await queue.list();
      const existingIds = new Set(existingTasks.map((t) => t.id));

      // Build prompt
      const projectIds = projectConfigs.map((pc) => pc.id).join(', ');
      let prompt = template
        .replace(/\{\{\s*project_descriptions\s*\}\}/g, buildProjectDescriptions())
        .replace(/\{\{\s*project_ids\s*\}\}/g, projectIds)
        .replace(/\{\{\s*max_tasks\s*\}\}/g, String(maxTasks));

      // Inject product vision if present — drives task prioritisation toward north star
      // Derive environment from project configs (all projects in a run share an environment)
      const envName = projectConfigs.find((pc) => pc.environment)?.environment;
      let visionSection = '';
      if (envName) {
        const visionPath = resolve(orchestratorRoot, `docs/environments/${envName}/product-vision.md`);
        try {
          const visionContent = await readFile(visionPath, 'utf-8');
          visionSection = `\n\n## Product Vision\n\nThe following vision document drives prioritisation. Proposed tasks MUST align with the Current Priorities or the North Star described here. Prefer tasks that advance an active initiative over inventing new directions.\n\n${visionContent}`;
          console.log(`   📌 Product vision loaded (${envName}) — tasks will be aligned to current priorities`);
        } catch {
          console.log(`   ℹ️  No vision file for environment "${envName}" — proposing without vision guidance`);
        }
      }

      const fullPrompt = `${prompt}${visionSection}\n\n## Codebases\n\n${combinedSummary}\n\n## Existing Tasks (do NOT duplicate these)\n\n${existingTasks.map((t) => formatExistingTask(t)).join('\n') || 'None'}`;

      console.log('🤖 Asking LLM to propose cross-project tasks...\n');

      const response = await adapter.execute({ prompt: fullPrompt });

      if (!response.success || !response.output) {
        throw new Error(`LLM call failed: ${response.error ?? 'no output'}`);
      }

      const proposed = parseProposedTasks(response.output);
      const newTasks = proposed.filter((t) => !existingIds.has(t.id));

      console.log(`\n📋 Proposed ${proposed.length} tasks, ${newTasks.length} are new`);

      // Validate project IDs
      const validProjectIds = new Set(projectConfigs.map((pc) => pc.id));
      for (const task of newTasks) {
        if (task.project && !validProjectIds.has(task.project)) {
          console.log(`  ⚠️  Task "${task.id}" references unknown project "${task.project}", skipping`);
        }
      }
      const validTasks = newTasks.filter((t) => !t.project || validProjectIds.has(t.project));

      // Log dependency info
      const tasksWithDeps = validTasks.filter((t) => t.depends_on && t.depends_on.length > 0);
      if (tasksWithDeps.length > 0) {
        console.log(`\n🔗 Cross-project dependencies:`);
        for (const t of tasksWithDeps) {
          console.log(`   ${t.id} [${t.project ?? '?'}] → depends on: ${t.depends_on!.join(', ')}`);
        }
      }

      return validTasks;
    },

    /**
     * Propose and add to queue.
     */
    async proposeAndQueue(): Promise<QueueTask[]> {
      const proposed = await this.propose();

      if (proposed.length === 0) {
        console.log('   No new tasks to add.');
        return [];
      }

      const queueTasks: QueueTask[] = proposed.map((t) => ({
        id: t.id,
        status: 'pending' as const,
        workflow: 'auto',
        prompt: t.prompt,
        ...(t.project ? { project: t.project } : {}),
        ...(t.type ? { task_type: t.type } : {}),
        ...(t.depends_on && t.depends_on.length > 0 ? { depends_on: t.depends_on } : {}),
        context_files: t.context_files,
        variables: t.variables,
      }));

      const existing = await queue.list();
      const allTasks = [...existing, ...queueTasks];

      const { writeFile: writeFs } = await import('node:fs/promises');
      const { stringify: stringifyYaml } = await import('yaml');
      const queuePath = resolve(orchestratorRoot, 'tasks/queue.yaml');
      await writeFs(queuePath, stringifyYaml({ tasks: allTasks }, { lineWidth: 120 }), 'utf-8');

      console.log(`\n✅ Added ${queueTasks.length} tasks to queue:`);
      for (const t of queueTasks) {
        const depStr = t.depends_on ? ` (depends on: ${t.depends_on.join(', ')})` : '';
        console.log(`   ⏳ ${t.id} [${t.project ?? 'orchestrator'}]${depStr}`);
      }

      return queueTasks;
    },

    /**
     * Preview without queuing.
     */
    async preview(): Promise<void> {
      const proposed = await this.propose();

      if (proposed.length === 0) {
        console.log('\n   LLM found nothing to propose.');
        return;
      }

      console.log('\n📋 Proposed Tasks (preview — not queued):\n');
      for (const task of proposed) {
        const depStr = task.depends_on ? ` → depends on: ${task.depends_on.join(', ')}` : '';
        console.log(`  ⏳ ${task.id} [${task.project ?? '?'}]${depStr}`);
        console.log(`     Prompt: ${task.prompt}`);
        if (task.context_files) {
          console.log(`     Context: ${task.context_files.join(', ')}`);
        }
        if (task.variables) {
          const desc = task.variables['feature_description'] ??
            task.variables['module_description'] ??
            task.variables['modification_description'] ?? '';
          if (desc) {
            console.log(`     Description: ${desc.slice(0, 120).trim()}...`);
          }
        }
        console.log('');
      }
    },
  };
}

