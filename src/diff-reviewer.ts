/**
 * Diff Reviewer
 * Uses an LLM to review a pull request diff before merge.
 * Catches logical issues that build/test verification won't find.
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { AgentAdapter, AgentRequest } from './types.js';

// --- Types ---

export interface DiffReview {
  approved: boolean;
  summary: string;
  concerns: string[];
  hasCriticalConcerns: boolean;
}

export interface ReviewOptions {
  diff: string;
  taskDescription?: string;
  projectName?: string;
  branchName?: string;
}

// --- Public API ---

/**
 * Review a PR diff using an LLM.
 * Returns an approval decision and any concerns.
 */
export async function reviewDiff(
  options: ReviewOptions,
  adapter: AgentAdapter,
  basePath: string,
  promptPath: string = 'prompts/merge-review-diff.md'
): Promise<DiffReview> {
  // Load prompt template
  let template: string;
  try {
    template = await readFile(resolve(basePath, promptPath), 'utf-8');
  } catch {
    console.log(`  ⚠️  Review prompt not found: ${promptPath}, using inline prompt`);
    template = DEFAULT_REVIEW_PROMPT;
  }

  // Resolve variables in the template
  const vars: Record<string, string> = {
    diff: truncateDiff(options.diff, 12_000),
    task_description: options.taskDescription ?? '(no description)',
    project_name: options.projectName ?? '(unknown)',
    branch_name: options.branchName ?? '(unknown)',
  };

  let prompt = template;
  for (const [key, value] of Object.entries(vars)) {
    prompt = prompt.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
  }

  const request: AgentRequest = { prompt };
  const response = await adapter.execute(request);

  if (!response.success || !response.output) {
    return {
      approved: true, // Default to approved if review fails (don't block on review errors)
      summary: 'Review unavailable — LLM call failed',
      concerns: [],
      hasCriticalConcerns: false,
    };
  }

  return parseReviewOutput(response.output);
}

/**
 * Format a DiffReview as a GitHub PR comment.
 */
export function formatReviewComment(review: DiffReview): string {
  const icon = review.approved ? '✅' : '⚠️';
  const verdict = review.approved ? 'Approved' : 'Changes Requested';

  const lines: string[] = [
    `## ${icon} Automated Code Review: ${verdict}`,
    '',
    `### Summary`,
    review.summary,
    '',
  ];

  if (review.concerns.length > 0) {
    lines.push('### Concerns');
    for (const concern of review.concerns) {
      const severity = review.hasCriticalConcerns ? '🔴' : '🟡';
      lines.push(`${severity} ${concern}`);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('*This review was generated automatically by the merge pipeline.*');

  return lines.join('\n');
}

// --- Internal helpers ---

/**
 * Parse the LLM's review output into a structured DiffReview.
 * Expects the LLM to output in a specific format (see prompt template).
 */
function parseReviewOutput(output: string): DiffReview {
  // Extract the verdict line specifically — don't scan the full output
  const verdictMatch = output.match(/verdict[:\s]*(approve|request changes|reject)/i);
  const verdictText = verdictMatch ? verdictMatch[1].toLowerCase() : '';

  // Extract summary — look for a "summary" section
  let summary = 'No summary provided';
  const summaryMatch = output.match(/(?:summary|overview)[:\s]*\n?([\s\S]*?)(?=\n\s*(?:concerns|issues|verdict|$))/i);
  if (summaryMatch) {
    summary = summaryMatch[1].trim().slice(0, 500);
  } else {
    // Use first paragraph as summary
    const firstPara = output.split('\n\n')[0];
    if (firstPara) {
      summary = firstPara.trim().slice(0, 500);
    }
  }

  // Extract concerns section only
  const concerns: string[] = [];
  const concernsMatch = output.match(/(?:concerns|issues)[:\s]*\n?([\s\S]*?)(?=\n\s*(?:verdict|summary|$))/i);
  if (concernsMatch) {
    const concernLines = concernsMatch[1]
      .split('\n')
      .map((line) => line.replace(/^[-*•]\s*/, '').trim())
      .filter((line) => line.length > 0 && line.toLowerCase() !== 'none');
    concerns.push(...concernLines);
  }

  // Only treat a concern as critical when the LLM explicitly prefixed it
  // with "CRITICAL:" (as instructed in the review prompt). Loose keyword
  // matching like "breaking change" caused false-positive escalations.
  const hasCriticalConcerns = concerns.some((c) =>
    /^\s*critical:/i.test(c)
  );

  // Determine approval from the explicit verdict line
  // If no verdict found, fall back to checking if there are critical concerns
  const approved = verdictText === 'approve' ||
    (verdictText === '' && !hasCriticalConcerns);

  return {
    approved,
    summary,
    concerns,
    hasCriticalConcerns,
  };
}

/**
 * Truncate a diff to fit within token limits.
 * Keeps the beginning and end of the diff.
 */
function truncateDiff(diff: string, maxChars: number): string {
  if (diff.length <= maxChars) {
    return diff;
  }

  const half = Math.floor(maxChars / 2);
  const start = diff.slice(0, half);
  const end = diff.slice(-half);

  return `${start}\n\n... (${diff.length - maxChars} characters truncated) ...\n\n${end}`;
}

/**
 * Default review prompt used when the prompt template file is not found.
 */
const DEFAULT_REVIEW_PROMPT = `You are a senior code reviewer. Review the following pull request diff.

## Context
- Project: {{project_name}}
- Branch: {{branch_name}}
- Task: {{task_description}}

## Diff
\`\`\`
{{diff}}
\`\`\`

## Instructions
Review the diff and provide:

1. **Summary**: A brief description of what the changes do (2-3 sentences).
2. **Concerns**: List any issues you see. Prefix critical issues with "CRITICAL:".
   - Look for: bugs, security vulnerabilities, breaking changes, missing error handling,
     unintended side effects, performance issues, incomplete implementations.
   - If there are no concerns, write "None".
3. **Verdict**: Either "Approve" or "Request Changes".

Format your response as:

Summary:
<your summary>

Concerns:
<your concerns>

Verdict: <Approve or Request Changes>
`;
