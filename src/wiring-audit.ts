/**
 * Wiring Audit
 * Runs before task proposal to check that recent changes across projects
 * are fully integrated. Catches loose ends like new API endpoints that
 * the UI doesn't consume, or new components that aren't routed.
 *
 * Two-phase approach:
 *   Phase 1 (deterministic): git log inventory — zero LLM tokens.
 *   Phase 2 (single-shot):   Read key files from BOTH projects based on
 *                             Phase 1 inventory. Feed them to the LLM in
 *                             one call with full cross-project visibility.
 *                             No tools needed.
 *
 * If gaps are found, they become the highest-priority tasks for the cycle.
 */

import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import type { AgentAdapter, AgentRequest } from './types.js';
import type { ProjectConfig } from './project-registry.js';
import type { QueueTask } from './queue-manager.js';
import { parse as parseYaml } from 'yaml';

// --- Types ---

export interface ChangeInventory {
  projectId: string;
  projectName: string;
  projectPath: string;
  added: string[];
  modified: string[];
  commitSummaries: string[];
}

export interface WiringAuditResult {
  hasGaps: boolean;
  tasks: QueueTask[];
  summary: string;
}

interface ProposedWiringTask {
  id: string;
  project: string;
  prompt: string;
  context_files?: string[];
  variables?: Record<string, string>;
}

// --- Constants ---

const LOOKBACK_DAYS = 7;
const MAX_FILE_READ_CHARS = 6000;
const MAX_CROSS_PROJECT_CONTEXT_CHARS = 60_000;

// Files that are likely to contain wiring (routes, service calls, API consumers)
const WIRING_INDICATOR_PATTERNS = [
  /src\/pages\//,
  /src\/components\//,
  /src\/services\//,
  /src\/hooks\//,
  /src\/handlers\//,
  /src\/models\//,
  /App\.tsx$/,
];

// Files to skip in cross-project reads (noise)
const SKIP_PATTERNS = [
  /\.test\./,
  /\.spec\./,
  /node_modules/,
  /package-lock/,
  /\.serverless/,
  /\.webpack/,
  /dist\//,
];

// --- Phase 1: Git Inventory ---

/**
 * Run a git command and return stdout.
 */
function git(args: string[], cwd: string): Promise<{ success: boolean; output: string }> {
  return new Promise((res) => {
    let stdout = '';
    let stderr = '';
    const proc = spawn('git', args, { cwd, shell: false });
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    proc.on('close', (code) => res({ success: code === 0, output: stdout.trim() }));
    proc.on('error', (e) => res({ success: false, output: e.message }));
  });
}

/**
 * Get recent changes for a single project from git log.
 * Returns a compact inventory of added/modified files and commit messages.
 */
export async function getRecentChanges(
  projectConfig: ProjectConfig,
  sinceDays: number = LOOKBACK_DAYS
): Promise<ChangeInventory> {
  const cwd = projectConfig.path;
  const sinceArg = `${sinceDays} days ago`;

  const nameStatus = await git(
    ['log', `--since=${sinceArg}`, '--name-status', '--pretty=format:', '--diff-filter=AM', 'HEAD'],
    cwd
  );

  const added: string[] = [];
  const modified: string[] = [];

  if (nameStatus.success && nameStatus.output) {
    for (const line of nameStatus.output.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const [status, ...pathParts] = trimmed.split('\t');
      const filePath = pathParts.join('\t');
      if (!filePath) continue;
      if (SKIP_PATTERNS.some((p) => p.test(filePath))) continue;
      if (status === 'A') added.push(filePath);
      else if (status === 'M') modified.push(filePath);
    }
  }

  const logResult = await git(
    ['log', `--since=${sinceArg}`, '--oneline', '--no-merges', 'HEAD'],
    cwd
  );

  const commitSummaries = logResult.success && logResult.output
    ? logResult.output.split('\n').filter((l) => l.trim()).slice(0, 20)
    : [];

  return {
    projectId: projectConfig.id,
    projectName: projectConfig.name,
    projectPath: projectConfig.path,
    added: [...new Set(added)],
    modified: [...new Set(modified)],
    commitSummaries,
  };
}

/**
 * Build a compact text summary of changes across all projects.
 */
function buildChangeSummary(inventories: ChangeInventory[]): string {
  const sections: string[] = [];

  for (const inv of inventories) {
    if (inv.added.length === 0 && inv.modified.length === 0) {
      sections.push(`### ${inv.projectName} (${inv.projectId})\nNo recent changes.\n`);
      continue;
    }

    const lines: string[] = [`### ${inv.projectName} (${inv.projectId})`];

    if (inv.added.length > 0) {
      lines.push(`\n**New files:**`);
      for (const f of inv.added) lines.push(`  + ${f}`);
    }

    if (inv.modified.length > 0) {
      lines.push(`\n**Modified files:**`);
      for (const f of inv.modified) lines.push(`  ~ ${f}`);
    }

    if (inv.commitSummaries.length > 0) {
      lines.push(`\n**Recent commits:**`);
      for (const c of inv.commitSummaries.slice(0, 10)) lines.push(`  ${c}`);
    }

    sections.push(lines.join('\n'));
  }

  return sections.join('\n\n');
}

// --- Phase 2: Cross-Project File Reading ---

/**
 * Determine which files from a project's inventory are most relevant
 * for cross-project wiring verification.
 */
function selectWiringRelevantFiles(inventory: ChangeInventory): string[] {
  const allChanged = [...inventory.added, ...inventory.modified];
  return allChanged.filter((f) => {
    // Only source files
    const ext = extname(f);
    if (!['.ts', '.tsx', '.js', '.jsx'].includes(ext)) return false;
    // Must match a wiring-relevant pattern
    return WIRING_INDICATOR_PATTERNS.some((p) => p.test(f));
  });
}

/**
 * Read a file safely, returning its content truncated to a limit.
 * Returns null if the file can't be read.
 */
async function safeReadFile(filePath: string, maxChars: number): Promise<string | null> {
  try {
    const stats = await stat(filePath);
    if (stats.size > maxChars * 2) {
      const content = await readFile(filePath, 'utf-8');
      return content.slice(0, maxChars) + `\n... (truncated at ${maxChars} chars)`;
    }
    const content = await readFile(filePath, 'utf-8');
    return content.length > maxChars
      ? content.slice(0, maxChars) + `\n... (truncated at ${maxChars} chars)`
      : content;
  } catch {
    return null;
  }
}

/**
 * Build cross-project file context for the LLM.
 * Reads the wiring-relevant files from each project's recent changes
 * so the LLM can see both sides of the integration.
 */
async function buildCrossProjectContext(
  inventories: ChangeInventory[],
  projectConfigs: ProjectConfig[]
): Promise<string> {
  const sections: string[] = [];
  let totalChars = 0;

  for (const inv of inventories) {
    const pc = projectConfigs.find((p) => p.id === inv.projectId);
    if (!pc) continue;

    const relevantFiles = selectWiringRelevantFiles(inv);
    if (relevantFiles.length === 0) continue;

    sections.push(`\n${'='.repeat(50)}\nFILES FROM: ${pc.name} (${pc.id})\n${'='.repeat(50)}`);

    for (const relPath of relevantFiles) {
      if (totalChars >= MAX_CROSS_PROJECT_CONTEXT_CHARS) {
        sections.push(`\n(context budget reached — ${relevantFiles.length - relevantFiles.indexOf(relPath)} files omitted)`);
        break;
      }

      const fullPath = resolve(pc.path, relPath);
      const content = await safeReadFile(fullPath, MAX_FILE_READ_CHARS);
      if (!content) continue;

      const entry = `\n--- [${pc.id}] ${relPath} ---\n${content}`;
      sections.push(entry);
      totalChars += entry.length;
    }
  }

  // Also read the UI's App.tsx / router file if a UI project is involved
  for (const pc of projectConfigs) {
    if (pc.type !== 'react-vite' && pc.type !== 'react') continue;
    const routerPath = resolve(pc.path, 'src/App.tsx');
    const content = await safeReadFile(routerPath, MAX_FILE_READ_CHARS);
    if (content && !sections.some((s) => s.includes('[' + pc.id + '] src/App.tsx'))) {
      const entry = `\n--- [${pc.id}] src/App.tsx (router) ---\n${content}`;
      sections.push(entry);
      totalChars += entry.length;
    }
  }

  // Read the API's route config if an API project is involved
  for (const pc of projectConfigs) {
    if (pc.type !== 'serverless-js' && pc.type !== 'serverless-node') continue;
    const functionsPath = resolve(pc.path, 'resources/functions.yml');
    const content = await safeReadFile(functionsPath, MAX_FILE_READ_CHARS);
    if (content) {
      const entry = `\n--- [${pc.id}] resources/functions.yml (route definitions) ---\n${content}`;
      sections.push(entry);
      totalChars += entry.length;
    }
  }

  console.log(`    📄 Cross-project context: ${Math.round(totalChars / 1000)}K chars (~${Math.round(totalChars / 4000)}K tokens)`);

  return sections.join('\n');
}

// --- Main Audit ---

/**
 * Run the wiring audit across multiple projects.
 *
 * Phase 1: Gather git inventories (zero LLM tokens).
 * Phase 2: Read relevant files from all projects, single-shot LLM call
 *          with full cross-project visibility. No tools needed.
 *
 * Returns wiring tasks if gaps are found, or empty result if all clear.
 */
export async function runWiringAudit(
  projectConfigs: ProjectConfig[],
  adapter: AgentAdapter,
  orchestratorRoot: string
): Promise<WiringAuditResult> {
  console.log('\n' + '─'.repeat(50));
  console.log('🔌 WIRING AUDIT');
  console.log('─'.repeat(50));

  // Phase 1: Git inventory
  console.log('  Phase 1: Scanning recent changes...');
  const inventories: ChangeInventory[] = [];

  for (const pc of projectConfigs) {
    const inv = await getRecentChanges(pc);
    inventories.push(inv);
    const changeCount = inv.added.length + inv.modified.length;
    console.log(`    ${pc.id}: ${changeCount} file(s) changed, ${inv.commitSummaries.length} commit(s)`);
  }

  const totalChanges = inventories.reduce((sum, inv) => sum + inv.added.length + inv.modified.length, 0);
  if (totalChanges === 0) {
    console.log('  No recent changes found. Skipping audit.');
    console.log('─'.repeat(50) + '\n');
    return { hasGaps: false, tasks: [], summary: 'No recent changes to audit.' };
  }

  // Phase 2: Single-shot LLM verification with cross-project file context
  console.log('  Phase 2: Reading cross-project files for verification...');

  const changeSummary = buildChangeSummary(inventories);
  const crossProjectContext = await buildCrossProjectContext(inventories, projectConfigs);

  // Load the wiring audit prompt
  const promptPath = resolve(orchestratorRoot, 'prompts/auto-wiring-audit.md');
  let template: string;
  try {
    template = await readFile(promptPath, 'utf-8');
  } catch {
    console.log('  ⚠️  Wiring audit prompt not found, skipping audit');
    console.log('─'.repeat(50) + '\n');
    return { hasGaps: false, tasks: [], summary: 'Audit prompt not found.' };
  }

  const projectDescriptions = projectConfigs.map((pc) => {
    return `- **${pc.name}** (id: \`${pc.id}\`, type: ${pc.type}): ${pc.description ?? 'No description'}`;
  }).join('\n');

  const prompt = template
    .replace(/\{\{\s*project_descriptions\s*\}\}/g, projectDescriptions)
    .replace(/\{\{\s*change_summary\s*\}\}/g, changeSummary)
    .replace(/\{\{\s*cross_project_context\s*\}\}/g, crossProjectContext)
    .replace(/\{\{\s*project_ids\s*\}\}/g, projectConfigs.map((pc) => pc.id).join(', '));

  console.log('  LLM verifying cross-project wiring (single-shot)...');

  // Single-shot call — no tools, cross-project context is inline
  const request: AgentRequest = { prompt };

  const response = await adapter.execute(request);

  if (!response.success || !response.output) {
    console.log(`  ⚠️  Audit LLM call failed: ${response.error ?? 'no output'}`);
    console.log('─'.repeat(50) + '\n');
    return { hasGaps: false, tasks: [], summary: 'LLM audit call failed.' };
  }

  const tasks = parseWiringTasks(response.output, projectConfigs);

  if (tasks.length === 0) {
    console.log('  ✅ All clear — no wiring gaps detected.');
    console.log('─'.repeat(50) + '\n');
    return { hasGaps: false, tasks: [], summary: 'No wiring gaps detected.' };
  }

  console.log(`  🔌 Found ${tasks.length} wiring gap(s):`);
  for (const t of tasks) {
    console.log(`    → ${t.id} [${t.project ?? 'unknown'}]`);
  }
  console.log('─'.repeat(50) + '\n');

  return {
    hasGaps: true,
    tasks,
    summary: `Found ${tasks.length} wiring gap(s) across projects.`,
  };
}

// --- Parsing ---

/**
 * Parse the LLM's response into wiring tasks.
 * Accepts YAML block with task definitions, or "ALL_CLEAR" for no gaps.
 */
function parseWiringTasks(llmOutput: string, projectConfigs: ProjectConfig[]): QueueTask[] {
  if (llmOutput.includes('ALL_CLEAR') || llmOutput.includes('all_clear')) {
    return [];
  }

  const yamlMatch = llmOutput.match(/```(?:yaml:tasks|yaml|yml)\n([\s\S]*?)```/);
  if (!yamlMatch) {
    try {
      const parsed = parseYaml(llmOutput);
      return convertToQueueTasks(parsed, projectConfigs);
    } catch {
      return [];
    }
  }

  try {
    const parsed = parseYaml(yamlMatch[1]);
    return convertToQueueTasks(parsed, projectConfigs);
  } catch {
    return [];
  }
}

/**
 * Convert parsed YAML into QueueTask objects.
 */
function convertToQueueTasks(parsed: unknown, projectConfigs: ProjectConfig[]): QueueTask[] {
  let tasks: ProposedWiringTask[];

  if (Array.isArray(parsed)) {
    tasks = parsed as ProposedWiringTask[];
  } else if (parsed && typeof parsed === 'object' && 'tasks' in parsed) {
    const obj = parsed as { tasks: unknown };
    if (Array.isArray(obj.tasks)) {
      tasks = obj.tasks as ProposedWiringTask[];
    } else {
      return [];
    }
  } else {
    return [];
  }

  const validProjectIds = new Set(projectConfigs.map((pc) => pc.id));

  return tasks
    .filter((t) => t.id && t.project && validProjectIds.has(t.project))
    .map((t) => ({
      id: `wire-${t.id}`,
      status: 'pending' as const,
      workflow: 'auto',
      prompt: t.prompt || 'prompts/auto-implement.md',
      project: t.project,
      task_type: 'wiring' as any,
      context_files: t.context_files,
      variables: t.variables,
    }));
}
