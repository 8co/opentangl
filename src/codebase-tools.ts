/**
 * Codebase Tools
 * Local filesystem tools the LLM can invoke during agentic execution.
 * These run against a target project directory — no external API calls.
 *
 * Tools:
 *   - search_codebase: ripgrep search with context lines
 *   - read_file: read a single file (truncated if large)
 *   - list_directory: list files/dirs at a path
 */

import { spawn } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve, relative } from 'node:path';

// --- Constants ---

const SEARCH_MAX_CHARS = 4000;
const READ_FILE_MAX_CHARS = 8000;
const SEARCH_CONTEXT_LINES = 3;
const MAX_DIR_ENTRIES = 100;

// --- Types ---

export interface ToolResult {
  success: boolean;
  output: string;
  error?: string;
}

export type ToolName = 'search_codebase' | 'read_file' | 'list_directory';

export interface ToolCall {
  name: ToolName;
  arguments: Record<string, string>;
}

// --- OpenAI tool definitions (for function calling) ---

export const TOOL_DEFINITIONS = [
  {
    type: 'function' as const,
    function: {
      name: 'search_codebase',
      description: 'Search the project codebase for a pattern using ripgrep. Returns matching lines with surrounding context. Use this to find existing utilities, patterns, types, or implementations before writing new code.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The search pattern (regex supported). Examples: "export function download", "className.*Button", "interface.*Props"',
          },
          file_glob: {
            type: 'string',
            description: 'Optional glob to filter files. Examples: "*.ts", "*.tsx", "src/utils/**"',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'read_file',
      description: 'Read the contents of a file in the project. Use this to understand existing code, check imports, or see how something is currently implemented.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Relative path to the file from the project root. Example: "src/utils/helpers.ts"',
          },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'list_directory',
      description: 'List files and directories at a path. Use this to explore the project structure and find relevant files.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Relative path to the directory. Use "." for the project root. Example: "src/components"',
          },
        },
        required: ['path'],
      },
    },
  },
];

// --- Tool implementations ---

/**
 * Search the codebase using ripgrep.
 * Returns matching lines with context, capped at SEARCH_MAX_CHARS.
 */
export async function searchCodebase(
  projectDir: string,
  query: string,
  fileGlob?: string
): Promise<ToolResult> {
  const args = [
    '--no-heading',
    '--line-number',
    '--color', 'never',
    '-C', String(SEARCH_CONTEXT_LINES),
    '--max-count', '20',
  ];

  if (fileGlob) {
    args.push('--glob', fileGlob);
  }

  // Exclude common noise directories
  args.push('--glob', '!node_modules/**');
  args.push('--glob', '!dist/**');
  args.push('--glob', '!build/**');
  args.push('--glob', '!.git/**');
  args.push('--glob', '!*.lock');
  args.push('--glob', '!package-lock.json');

  args.push(query, '.');

  return new Promise((res) => {
    let stdout = '';
    let stderr = '';

    const proc = spawn('rg', args, { cwd: projectDir, shell: false });

    proc.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
      // Early termination if output is huge
      if (stdout.length > SEARCH_MAX_CHARS * 2) {
        proc.kill();
      }
    });

    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on('close', (exitCode) => {
      if (exitCode === 1 && !stdout) {
        // rg exits 1 when no matches found
        res({ success: true, output: 'No matches found.' });
        return;
      }

      if (exitCode !== 0 && exitCode !== 1 && !stdout) {
        res({ success: false, output: '', error: stderr.trim() || `rg exited with code ${exitCode}` });
        return;
      }

      let output = stdout.trim();
      if (output.length > SEARCH_MAX_CHARS) {
        output = output.slice(0, SEARCH_MAX_CHARS) + `\n\n... (results truncated at ${SEARCH_MAX_CHARS} chars)`;
      }

      res({ success: true, output: output || 'No matches found.' });
    });

    proc.on('error', (err) => {
      res({ success: false, output: '', error: `Failed to run rg: ${err.message}` });
    });
  });
}

/**
 * Read a file from the project directory.
 * Truncates at READ_FILE_MAX_CHARS with a note.
 */
export async function readProjectFileTool(
  projectDir: string,
  filePath: string
): Promise<ToolResult> {
  try {
    const fullPath = resolve(projectDir, filePath);

    // Safety: don't read outside the project
    if (!fullPath.startsWith(resolve(projectDir))) {
      return { success: false, output: '', error: 'Path escapes project directory' };
    }

    const content = await readFile(fullPath, 'utf-8');

    if (content.length > READ_FILE_MAX_CHARS) {
      const truncated = content.slice(0, READ_FILE_MAX_CHARS);
      return {
        success: true,
        output: truncated + `\n\n... (file truncated at ${READ_FILE_MAX_CHARS} chars, total: ${content.length} chars)`,
      };
    }

    return { success: true, output: content };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('ENOENT')) {
      return { success: false, output: '', error: `File not found: ${filePath}` };
    }
    return { success: false, output: '', error: msg };
  }
}

/**
 * List files and directories at a path within the project.
 * Returns entries with type indicators (dir/ vs file).
 */
export async function listDirectoryTool(
  projectDir: string,
  dirPath: string
): Promise<ToolResult> {
  try {
    const fullPath = resolve(projectDir, dirPath);

    // Safety: don't list outside the project
    if (!fullPath.startsWith(resolve(projectDir))) {
      return { success: false, output: '', error: 'Path escapes project directory' };
    }

    const entries = await readdir(fullPath, { withFileTypes: true });

    // Filter out noise
    const filtered = entries.filter((e) =>
      !['node_modules', '.git', 'dist', 'build', '.next', '.cache'].includes(e.name)
    );

    if (filtered.length === 0) {
      return { success: true, output: '(empty directory)' };
    }

    const lines: string[] = [];
    const sorted = filtered.sort((a, b) => {
      // Directories first, then files
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });

    for (const entry of sorted.slice(0, MAX_DIR_ENTRIES)) {
      lines.push(entry.isDirectory() ? `${entry.name}/` : entry.name);
    }

    if (sorted.length > MAX_DIR_ENTRIES) {
      lines.push(`... (${sorted.length - MAX_DIR_ENTRIES} more entries)`);
    }

    return { success: true, output: lines.join('\n') };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('ENOENT')) {
      return { success: false, output: '', error: `Directory not found: ${dirPath}` };
    }
    return { success: false, output: '', error: msg };
  }
}

// --- Dispatcher ---

/**
 * Execute a tool call against a project directory.
 * Returns the tool result for feeding back to the LLM.
 */
export async function executeTool(
  projectDir: string,
  toolCall: ToolCall
): Promise<ToolResult> {
  switch (toolCall.name) {
    case 'search_codebase':
      return searchCodebase(projectDir, toolCall.arguments.query, toolCall.arguments.file_glob);
    case 'read_file':
      return readProjectFileTool(projectDir, toolCall.arguments.path);
    case 'list_directory':
      return listDirectoryTool(projectDir, toolCall.arguments.path);
    default:
      return { success: false, output: '', error: `Unknown tool: ${toolCall.name}` };
  }
}
