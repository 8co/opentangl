/**
 * Prompt Resolver
 * Loads prompt templates and injects variables + step outputs
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { PromptResolver } from './types.js';

const VARIABLE_PATTERN = /\{\{(\s*[\w.]+\s*)\}\}/g;

export function createPromptResolver(basePath: string): PromptResolver {
  return {
    async resolve(
      templatePath: string,
      variables: Record<string, string>,
      stepOutputs: Record<string, string>
    ): Promise<string> {
      const fullPath = resolve(basePath, templatePath);
      let template: string;

      try {
        template = await readFile(fullPath, 'utf-8');
      } catch (err) {
        throw new Error(`Prompt template not found: ${fullPath}`);
      }

      // Build combined lookup: variables + step outputs as steps.<id>.output
      const lookup: Record<string, string> = { ...variables };
      for (const [stepId, output] of Object.entries(stepOutputs)) {
        lookup[`steps.${stepId}.output`] = output;
      }

      // Replace {{variable}} patterns
      const resolved = template.replace(VARIABLE_PATTERN, (match, key: string) => {
        const trimmed = key.trim();
        if (trimmed in lookup) {
          return lookup[trimmed];
        }
        console.warn(`⚠️  Unresolved variable: {{${trimmed}}}`);
        return match;
      });

      return resolved;
    },
  };
}

