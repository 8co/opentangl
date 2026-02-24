/**
 * Cursor Agent Adapter
 * Executes prompts via Cursor's CLI/background agent mode
 *
 * Phase 1: Logs the resolved prompt to stdout and writes to output file.
 * This allows manual verification before wiring up actual Cursor API integration.
 * Future: Invoke Cursor headless or via its API to execute prompts autonomously.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { AgentAdapter, AgentRequest, AgentResponse } from '../types.js';

export function createCursorAdapter(): AgentAdapter {
  return {
    name: 'cursor',

    async execute(request: AgentRequest): Promise<AgentResponse> {
      const start: number = Date.now();

      try {
        console.log('\n┌─────────────────────────────────────────');
        console.log('│ 🤖 Cursor Agent — Executing Prompt');
        console.log('├─────────────────────────────────────────');
        console.log('│');

        // Log the prompt (truncated for readability)
        const lines: string[] = request.prompt.split('\n');
        const preview: string = lines.slice(0, 20).join('\n');
        console.log(preview.replace(/^/gm, '│  '));
        if (lines.length > 20) {
          console.log(`│  ... (${lines.length - 20} more lines)`);
        }

        console.log('│');

        // Write prompt to output path if specified
        if (request.outputPath) {
          await mkdir(dirname(request.outputPath), { recursive: true });
          await writeFile(request.outputPath, request.prompt, 'utf-8');
          console.log(`│ 📄 Output written to: ${request.outputPath}`);
        }

        const durationMs = Date.now() - start;

        console.log(`│ ⏱  Duration: ${durationMs}ms`);
        console.log('└─────────────────────────────────────────\n');

        const successResponse: AgentResponse = {
          success: true,
          output: request.outputPath ?? '[stdout]',
          durationMs,
        };
        return successResponse;
      } catch (err: unknown) {
        let errorMessage: string;

        if (err instanceof Error) {
          if ('code' in err) {
            const errnoError = err as NodeJS.ErrnoException;
            switch (errnoError.code) {
              case 'ENOENT':
                errorMessage = 'File path not found. Please ensure the directory exists.';
                break;
              case 'EACCES':
                errorMessage = 'Permission denied. Check your access rights to the output path.';
                break;
              case 'EMFILE':
                errorMessage = 'Too many open files. Please close some files and try again.';
                break;
              case 'EISDIR':
                errorMessage = 'Expected a file but found a directory. Please provide a file path.';
                break;
              case 'ENOTDIR':
                errorMessage = 'A component of the path is not a directory. Please check the path.';
                break;
              case '400':
                errorMessage = 'Bad Request. The server could not understand the request.';
                break;
              case '401':
                errorMessage = 'Unauthorized. Authentication is required and has failed.';
                break;
              case '503':
                errorMessage = 'Service Unavailable. The server is currently unable to handle the request.';
                break;
              default:
                errorMessage = `Unhandled error (code: ${errnoError.code}): ${errnoError.message}`;
            }
          } else {
            errorMessage = `Unexpected error: ${err.message}`;
          }
        } else {
          errorMessage = `Unknown error: ${String(err)}`;
        }
        console.error(`Error executing Cursor Agent: ${errorMessage}`);

        const errorResponse: AgentResponse = {
          success: false,
          error: errorMessage,
          durationMs: Date.now() - start,
        };
        return errorResponse;
      }
    },
  };
}
