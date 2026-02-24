/**
 * Vision Review
 * After all autopilot cycles complete, updates the Current Priorities section
 * of docs/product-vision.md based on what was accomplished.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { AgentAdapter } from './types.js';

const PROMPT_PATH = 'prompts/auto-vision-review.md';
const PRIORITIES_HEADING = '## Current Priorities';

export interface VisionReviewInput {
  /** Task IDs and their project + outcome from the run */
  completedTasks: { id: string; project?: string }[];
  failedTasks: { id: string; project?: string; reason?: string }[];
  /** Environment name — determines which vision file to update */
  environment?: string;
}

export async function reviewAndUpdateVision(
  orchestratorRoot: string,
  adapter: AgentAdapter,
  input: VisionReviewInput
): Promise<{ updated: boolean; error?: string }> {
  if (!input.environment) {
    console.log('   ⏭️  No environment specified — skipping vision review');
    return { updated: false };
  }

  const visionPath = resolve(orchestratorRoot, `docs/environments/${input.environment}/product-vision.md`);
  let visionContent: string;
  try {
    visionContent = await readFile(visionPath, 'utf-8');
  } catch {
    console.log(`   ⏭️  No vision file for environment "${input.environment}" — skipping vision review`);
    return { updated: false };
  }

  // Nothing happened? Skip.
  if (input.completedTasks.length === 0 && input.failedTasks.length === 0) {
    console.log('   ⏭️  No tasks to review — skipping vision update');
    return { updated: false };
  }

  // Load prompt template
  const promptPath = resolve(orchestratorRoot, PROMPT_PATH);
  let template: string;
  try {
    template = await readFile(promptPath, 'utf-8');
  } catch {
    return { updated: false, error: `Vision review prompt not found: ${promptPath}` };
  }

  // Build context
  const completedSummary = input.completedTasks.length > 0
    ? input.completedTasks.map((t) => `- ${t.id} [${t.project ?? 'unknown'}]`).join('\n')
    : 'None';

  const failedSummary = input.failedTasks.length > 0
    ? input.failedTasks.map((t) => {
        const project = t.project ?? 'unknown';
        const reason = t.reason?.trim();
        if (reason) {
          return `- **${t.id}** [${project}]\n  Error: ${reason}`;
        }
        return `- **${t.id}** [${project}] — no error details captured`;
      }).join('\n')
    : 'None';

  const today = new Date().toISOString().split('T')[0];

  const prompt = template
    .replace(/\{\{\s*vision_content\s*\}\}/g, visionContent)
    .replace(/\{\{\s*completed_tasks\s*\}\}/g, completedSummary)
    .replace(/\{\{\s*failed_tasks\s*\}\}/g, failedSummary)
    .replace(/\{\{\s*date\s*\}\}/g, today);

  console.log('🔮 Reviewing product vision based on completed work...');

  const response = await adapter.execute({ prompt });

  if (!response.success || !response.output) {
    return { updated: false, error: `Vision review LLM call failed: ${response.error ?? 'no output'}` };
  }

  // Extract the new priorities section from the LLM output
  const newPriorities = extractPrioritiesSection(response.output);
  if (!newPriorities) {
    console.log('   ⚠️  Could not parse vision review output — skipping update');
    return { updated: false, error: 'Could not extract priorities section from LLM output' };
  }

  // Replace the Current Priorities section in the vision file
  const headingIndex = visionContent.indexOf(PRIORITIES_HEADING);
  if (headingIndex === -1) {
    console.log('   ⚠️  No "## Current Priorities" heading found in vision file — skipping');
    return { updated: false, error: 'Missing priorities heading in vision file' };
  }

  const before = visionContent.slice(0, headingIndex);
  const updatedContent = `${before}${newPriorities.trim()}\n`;

  await writeFile(visionPath, updatedContent, 'utf-8');
  console.log('   ✅ Product vision updated with latest progress');
  return { updated: true };
}

/**
 * Extract the "## Current Priorities" section from LLM output.
 * The LLM is instructed to output only this section, but it may include
 * markdown fences or extra whitespace.
 */
function extractPrioritiesSection(output: string): string | null {
  // Strip markdown code fences if present
  let cleaned = output.trim();
  if (cleaned.startsWith('```')) {
    const firstNewline = cleaned.indexOf('\n');
    cleaned = cleaned.slice(firstNewline + 1);
    if (cleaned.endsWith('```')) {
      cleaned = cleaned.slice(0, -3);
    }
  }

  // Must contain the heading
  const idx = cleaned.indexOf(PRIORITIES_HEADING);
  if (idx !== -1) {
    return cleaned.slice(idx);
  }

  // If the LLM omitted the heading but the content looks right, prepend it
  if (cleaned.includes('### Active Initiatives') || cleaned.includes('### Completed')) {
    return `${PRIORITIES_HEADING}\n\n${cleaned}`;
  }

  return null;
}
