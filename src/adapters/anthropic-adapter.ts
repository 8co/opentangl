/**
 * Anthropic Agent Adapter
 * Executes prompts via Claude API and returns structured responses.
 * Supports multi-turn tool use (search_codebase, read_file, list_directory).
 */

import Anthropic from '@anthropic-ai/sdk';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { AgentAdapter, AgentRequest, AgentResponse } from '../types.js';
import { isNetworkError } from '../utils/networkErrorUtil.js';
import { TOOL_DEFINITIONS, executeTool, type ToolName } from '../codebase-tools.js';

const MAX_TOOL_ROUNDS = 10;
const MAX_TOOL_CONTEXT_CHARS = 30_000;

interface AnthropicConfig {
  apiKey: string;
  model: string;
}

interface TextBlock {
  type: 'text';
  text: string;
}

interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, string>;
}

type ContentBlock = TextBlock | ToolUseBlock;

interface ValidAnthropicResponse {
  content: ContentBlock[];
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
  stop_reason: string;
}

function isAPILimitError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'response' in err &&
    (err as { response: { status: number } }).response.status === 429
  );
}

function isInvalidResponseError(response: unknown): response is Partial<ValidAnthropicResponse> {
  return (
    typeof response !== 'object' || response === null || !('content' in response) || !('usage' in response)
  );
}

function isUnexpectedResponseError(response: unknown): boolean {
  return (
    typeof response === 'object' &&
    response !== null &&
    'status' in response &&
    (response as { status: number }).status >= 400
  );
}

function isTimeoutError(err: unknown): boolean {
  return err instanceof Error && err.message.includes('timeout');
}

function isRateLimitError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'response' in err &&
    (err as { response: { status: number } }).response.status === 429
  );
}

async function retry<T>(fn: () => Promise<T>, retries: number, delayMs: number): Promise<T> {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      if (attempt === retries - 1) {
        throw err;
      }
      await new Promise((res) => setTimeout(res, delayMs));
    }
  }
  throw new Error('Retry attempts exhausted');
}

function logError(err: unknown, start: number): { error: string; durationMs: number } {
  let error: string = 'An unknown error occurred.';
  const durationMs: number = Date.now() - start;

  if (isNetworkError(err)) {
    error = 'Network error: Unable to reach the API. Retrying...';
  } else if (isAPILimitError(err)) {
    error = 'API limit reached: Too many requests. Please try again later.';
  } else if (isTimeoutError(err)) {
    error = 'Network error: Request timed out. Please check your connection.';
  } else if (isRateLimitError(err)) {
    error = 'Rate limit error: Too many requests in a short amount of time.';
  } else if (err instanceof Error) {
    error = `Error: ${err.message}`;
  } else if (typeof err === 'object' && err !== null) {
    try {
      error = `Unexpected error object: ${JSON.stringify(err)}`;
    } catch (jsonError) {
      error = 'Unexpected error object: [unserializable object]';
    }
  } else {
    error = `Unexpected error type: ${String(err)}`;
  }

  console.error(`│ ❌ Error: ${error}`);
  console.error(`│ ⏱  Duration: ${durationMs}ms`);
  console.log('└─────────────────────────────────────────\n');

  return { error, durationMs };
}

/**
 * Convert OpenAI-format TOOL_DEFINITIONS to Anthropic's tool format.
 * OpenAI: { type: "function", function: { name, description, parameters } }
 * Anthropic: { name, description, input_schema }
 */
const ANTHROPIC_TOOLS: Anthropic.Tool[] = TOOL_DEFINITIONS.map((t) => ({
  name: t.function.name,
  description: t.function.description,
  input_schema: t.function.parameters as Anthropic.Tool.InputSchema,
}));

function extractText(content: ContentBlock[]): string {
  return content
    .filter((b): b is TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

export function createAnthropicAdapter(config: AnthropicConfig): AgentAdapter {
  const client = new Anthropic({ apiKey: config.apiKey });

  async function executeWithTools(
    request: AgentRequest,
    systemContent: string
  ): Promise<{ output: string; tokensIn: number; tokensOut: number; finishReason: string; toolRounds: number }> {
    const projectDir = request.projectDir!;
    let totalTokensIn = 0;
    let totalTokensOut = 0;
    let toolRounds = 0;
    let toolContextChars = 0;

    const messages: Anthropic.MessageParam[] = [
      { role: 'user', content: request.prompt },
    ];

    let response = await retry(
      () => client.messages.create({
        model: config.model,
        max_tokens: 16384,
        system: systemContent,
        tools: ANTHROPIC_TOOLS,
        messages,
      }),
      3,
      1000
    ) as unknown as ValidAnthropicResponse;

    totalTokensIn += response.usage.input_tokens;
    totalTokensOut += response.usage.output_tokens;

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const toolUseBlocks = response.content.filter(
        (b): b is ToolUseBlock => b.type === 'tool_use'
      );

      if (toolUseBlocks.length === 0 || response.stop_reason !== 'tool_use') {
        return {
          output: extractText(response.content),
          tokensIn: totalTokensIn,
          tokensOut: totalTokensOut,
          finishReason: response.stop_reason ?? 'end_turn',
          toolRounds,
        };
      }

      toolRounds++;

      // Push the assistant's response (with tool_use blocks) into conversation
      messages.push({ role: 'assistant', content: response.content as Anthropic.ContentBlock[] });

      // Execute each tool and collect results
      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const block of toolUseBlocks) {
        console.log(`│ 🔧 Tool: ${block.name}(${Object.values(block.input).join(', ').slice(0, 80)})`);

        const toolResult = await executeTool(projectDir, {
          name: block.name as ToolName,
          arguments: block.input,
        });

        const resultContent = toolResult.success ? toolResult.output : `Error: ${toolResult.error}`;
        toolContextChars += resultContent.length;

        const resultPreview = toolResult.output.length > 200
          ? `${toolResult.output.slice(0, 200)}...`
          : toolResult.output;
        console.log(`│    → ${toolResult.success ? resultPreview.split('\n')[0] : `Error: ${toolResult.error}`}`);

        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: resultContent,
        });
      }

      messages.push({ role: 'user', content: toolResults });

      const budgetExhausted = toolContextChars >= MAX_TOOL_CONTEXT_CHARS;
      if (budgetExhausted) {
        console.log(`│ 📊 Tool context budget reached (${Math.round(toolContextChars / 1000)}K chars). Forcing final output.`);
        messages.push({
          role: 'user',
          content: 'You have gathered enough context from the codebase. Stop exploring and produce your final code output now. Do not attempt any more tool calls.',
        });
      }

      response = await retry(
        () => client.messages.create({
          model: config.model,
          max_tokens: 16384,
          system: systemContent,
          ...(budgetExhausted ? {} : { tools: ANTHROPIC_TOOLS }),
          messages,
        }),
        3,
        1000
      ) as unknown as ValidAnthropicResponse;

      totalTokensIn += response.usage.input_tokens;
      totalTokensOut += response.usage.output_tokens;

      if (budgetExhausted) {
        return {
          output: extractText(response.content),
          tokensIn: totalTokensIn,
          tokensOut: totalTokensOut,
          finishReason: 'budget_exhausted',
          toolRounds,
        };
      }
    }

    return {
      output: extractText(response.content),
      tokensIn: totalTokensIn,
      tokensOut: totalTokensOut,
      finishReason: 'tool_loop_exhausted',
      toolRounds,
    };
  }

  return {
    name: 'anthropic',

    async execute(request: AgentRequest): Promise<AgentResponse> {
      const start: number = Date.now();
      const maxRetries: number = 3;
      const retryDelayMs: number = 1000;

      try {
        const useTools = request.enableTools && !!request.projectDir;
        const toolLabel = useTools ? ' + Tools' : '';

        console.log('\n┌─────────────────────────────────────────');
        console.log(`│ 🧠 Anthropic (${config.model})${toolLabel}`);
        console.log('├─────────────────────────────────────────');

        const baseSystem: string = request.context
          ? `You are an expert software engineer. Follow all instructions precisely.\n\nContext:\n${request.context}`
          : 'You are an expert software engineer. Follow all instructions precisely. Return only the requested output — no preamble, no explanation unless asked.';

        let output: string;
        let tokensIn: number = 0;
        let tokensOut: number = 0;
        let finishReason: string = 'unknown';
        let toolRounds = 0;

        if (useTools) {
          const toolSystem = baseSystem + `\n\nYou have access to codebase tools (search_codebase, read_file, list_directory). Use them to explore the project BEFORE writing code.

**Be surgical.** Typically 2-5 tool calls is sufficient:
1. Search for the most relevant pattern or function name first.
2. Read 1-2 key files to understand the existing conventions.
3. If needed, list a directory to find the right file paths.
4. Then produce your final code output.

Do NOT exhaustively read every file in a directory. Focus on the files most relevant to your task. Once you have enough context, stop exploring and write your code.`;

          const result = await executeWithTools(request, toolSystem);
          output = result.output;
          tokensIn = result.tokensIn;
          tokensOut = result.tokensOut;
          finishReason = result.finishReason;
          toolRounds = result.toolRounds;
        } else {
          const message: unknown = await retry(
            (): Promise<unknown> =>
              client.messages.create({
                model: config.model,
                max_tokens: 4096,
                system: baseSystem,
                messages: [{ role: 'user', content: request.prompt }],
              }),
            maxRetries,
            retryDelayMs
          );

          if (isInvalidResponseError(message)) {
            console.error('Invalid response structure:', message);
            throw new Error('API returned unexpected data structure.');
          } else if (isUnexpectedResponseError(message)) {
            console.error('Unexpected API response status:', message);
            throw new Error('Unexpected API response status.');
          }

          const validResponse = message as ValidAnthropicResponse;
          output = extractText(validResponse.content);
          tokensIn = validResponse.usage.input_tokens;
          tokensOut = validResponse.usage.output_tokens;
          finishReason = validResponse.stop_reason;
        }

        const durationMs: number = Date.now() - start;

        if (request.outputPath) {
          await mkdir(dirname(request.outputPath), { recursive: true });
          await writeFile(request.outputPath, output, 'utf-8');
          console.log(`│ 📄 Output written to: ${request.outputPath}`);
        }

        const lines: string[] = output.split('\n');
        const preview: string = lines.slice(0, 10).join('\n');
        console.log('│');
        console.log(preview.replace(/^/gm, '│  '));
        if (lines.length > 10) {
          console.log(`│  ... (${lines.length - 10} more lines)`);
        }

        console.log('│');
        console.log(`│ ⏱  Duration: ${durationMs}ms`);
        console.log(`│ 📊 Tokens: ${tokensIn} in / ${tokensOut} out`);
        console.log(`│ 🛑 Stop: ${finishReason}${toolRounds > 0 ? ` (${toolRounds} tool rounds)` : ''}`);
        console.log('└─────────────────────────────────────────\n');

        return {
          success: true,
          output,
          durationMs,
        };
      } catch (err: unknown) {
        const { error, durationMs } = logError(err, start);
        return {
          success: false,
          error,
          durationMs,
        };
      }
    },
  };
}
