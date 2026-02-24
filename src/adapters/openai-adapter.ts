/**
 * OpenAI Agent Adapter
 * Executes prompts via GPT / Codex API and returns structured responses.
 * Supports both Chat Completions (gpt-4o, gpt-4.1-*) and Responses API (gpt-5.x-codex).
 *
 * Agentic tool use:
 *   When `request.enableTools` is true and `request.projectDir` is set,
 *   the adapter enters a multi-turn loop where the LLM can call codebase
 *   tools (search_codebase, read_file, list_directory) before generating
 *   its final code output. This lets the LLM explore the project and find
 *   relevant patterns, utilities, and types before writing new code.
 */

import OpenAI from 'openai';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { AgentAdapter, AgentRequest, AgentResponse } from '../types.js';
import { TOOL_DEFINITIONS, executeTool, type ToolCall } from '../codebase-tools.js';

interface OpenAIConfig {
  apiKey: string;
  model: string;
}

function isValidOpenAIConfig(config: OpenAIConfig): boolean {
  return typeof config.apiKey === 'string' && config.apiKey.trim() !== '' &&
    typeof config.model === 'string' && config.model.trim() !== '';
}

function useResponsesAPI(model: string): boolean {
  return model.includes('codex') || model.startsWith('gpt-5');
}

function mapErrorMessage(message: string): string | undefined {
  const errorMapping: Record<string, string> = {
    'Network Error': 'Network error occurred. Please check your connection and try again.',
    'timeout': 'Request timed out. Please try again later.',
    '401': 'Unauthorized: Invalid API key or permissions issue.',
    '403': 'Forbidden: You do not have permission to access this resource.',
    '404': 'Not found: The requested resource could not be found.',
    '500': 'Internal server error. Try again after some time.',
    '502': 'Bad Gateway: Invalid response from the upstream server.',
    '503': 'Service unavailable: OpenAI temporarily unavailable. Try again after some time.',
    '504': 'Gateway timeout: Upstream server failed to send a request in time.',
    '429': 'Too many requests: You have hit the rate limit. Try again later.',
    'Malformed response': 'Received a malformed response from OpenAI. Please try again later.'
  };
  
  for (const key in errorMapping) {
    if (message.includes(key)) {
      return errorMapping[key];
    }
  }
  return undefined;
}

function generateErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return mapErrorMessage(err.message) || 'An unexpected error occurred. Please try again later.';
  }
  return 'An unknown error occurred.';
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout>;

  const timeoutPromise = new Promise<T>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error('timeout'));
    }, ms);
  });

  return Promise.race([
    promise.then((result) => {
      clearTimeout(timeoutId);
      return result;
    }),
    timeoutPromise,
  ]).catch((err) => {
    clearTimeout(timeoutId);
    if (err instanceof Error && err.message === 'timeout') {
      console.error(`⏰ Timeout Error: OpenAI call exceeded ${ms / 1000}s`);
    }
    throw err;
  });
}

const MAX_TOOL_ROUNDS = 10;
const MAX_TOOL_CONTEXT_CHARS = 25_000;
const MAX_ADAPTER_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 2_000;
const RETRYABLE_PATTERNS = ['Malformed response', 'timeout', '502', '503', '429'];

/**
 * Log the final output block for an LLM response.
 */
function logResponseBlock(
  output: string,
  durationMs: number,
  tokensIn: number | string,
  tokensOut: number | string,
  finishReason: string,
  toolRounds: number
): void {
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
  if (toolRounds > 0) {
    console.log(`│ 🔧 Tool rounds: ${toolRounds}`);
  }
  console.log(`│ 🛑 Finish: ${finishReason}`);
  console.log('└─────────────────────────────────────────\n');
}

export function createOpenAIAdapter(config: OpenAIConfig, adapterName: 'openai' | 'codex' = 'openai'): AgentAdapter {
  if (!isValidOpenAIConfig(config)) {
    throw new Error('Invalid OpenAI configuration');
  }

  const client = new OpenAI({ apiKey: config.apiKey, timeout: 300_000 });
  const isResponses = useResponsesAPI(config.model);

  /**
   * Execute with agentic tool use via Chat Completions API.
   * Multi-turn loop: LLM can call tools, results are fed back, until final text output.
   */
  async function executeWithToolsChat(
    request: AgentRequest,
    systemContent: string
  ): Promise<{ output: string; tokensIn: number; tokensOut: number; finishReason: string; toolRounds: number }> {
    const projectDir = request.projectDir!;
    let totalTokensIn = 0;
    let totalTokensOut = 0;
    let toolRounds = 0;
    let toolContextChars = 0;
    let budgetExhausted = false;

    const messages: Array<any> = [
      { role: 'system', content: systemContent },
      { role: 'user', content: request.prompt },
    ];

    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const controller = new AbortController();
      const abortTimer = setTimeout(() => controller.abort(), 180_000);

      try {
        const completion = await withTimeout(
          client.chat.completions.create({
            model: config.model,
            messages,
            // Disable tools once budget is exhausted to force final output
            ...(budgetExhausted ? {} : { tools: TOOL_DEFINITIONS as any }),
            max_tokens: 16384,
          }, { signal: controller.signal }),
          180_000
        );

        totalTokensIn += completion.usage?.prompt_tokens ?? 0;
        totalTokensOut += completion.usage?.completion_tokens ?? 0;

        const choice = completion.choices[0];
        if (!choice) {
          console.error(`│ 🔍 Malformed: no choice returned (choices.length=${completion.choices?.length})`);
          throw new Error('Malformed response from OpenAI service');
        }

        const assistantMessage = choice.message;

        // Check for tool calls
        if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
          toolRounds++;
          messages.push(assistantMessage);

          for (const tc of assistantMessage.tool_calls) {
            const fn = (tc as any).function as { name: string; arguments: string };
            const toolName = fn.name;
            let toolArgs: Record<string, string>;
            try {
              toolArgs = JSON.parse(fn.arguments);
            } catch {
              toolArgs = {};
            }

            console.log(`│ 🔧 Tool: ${toolName}(${Object.values(toolArgs).join(', ').slice(0, 80)})`);

            const toolResult = await executeTool(projectDir, {
              name: toolName as any,
              arguments: toolArgs,
            });

            const resultContent = toolResult.success ? toolResult.output : `Error: ${toolResult.error}`;
            toolContextChars += resultContent.length;

            const resultPreview = toolResult.output.length > 200
              ? `${toolResult.output.slice(0, 200)}...`
              : toolResult.output;
            console.log(`│    → ${toolResult.success ? resultPreview.split('\n')[0] : `Error: ${toolResult.error}`}`);

            messages.push({
              role: 'tool',
              tool_call_id: tc.id,
              content: resultContent,
            });
          }

          // Check token budget after processing all tool results this round
          if (toolContextChars >= MAX_TOOL_CONTEXT_CHARS) {
            budgetExhausted = true;
            console.log(`│ 📊 Tool context budget reached (${Math.round(toolContextChars / 1000)}K chars). Forcing final output.`);
            messages.push({
              role: 'system',
              content: 'You have gathered enough context from the codebase. Stop exploring and produce your final code output now. Do not call any more tools.',
            });
          }

          continue;
        }

        // No tool calls — final text response
        const output = assistantMessage.content ?? '';
        return {
          output,
          tokensIn: totalTokensIn,
          tokensOut: totalTokensOut,
          finishReason: choice.finish_reason ?? 'unknown',
          toolRounds,
        };
      } finally {
        clearTimeout(abortTimer);
      }
    }

    throw new Error(`Tool loop exceeded ${MAX_TOOL_ROUNDS} rounds`);
  }

  /**
   * Execute with agentic tool use via Responses API.
   * Multi-turn loop using previous_response_id for continuation.
   */
  async function executeWithToolsResponses(
    request: AgentRequest,
    systemContent: string
  ): Promise<{ output: string; tokensIn: number; tokensOut: number; finishReason: string; toolRounds: number }> {
    const projectDir = request.projectDir!;
    let totalTokensIn = 0;
    let totalTokensOut = 0;
    let toolRounds = 0;
    let toolContextChars = 0;
    let previousResponseId: string | undefined;

    // Build tools in Responses API format
    const responsesTools = TOOL_DEFINITIONS.map((t) => ({
      type: 'function' as const,
      ...t.function,
    }));

    // First call
    const controller1 = new AbortController();
    const abortTimer1 = setTimeout(() => controller1.abort(), 300_000);
    let response: any;

    try {
      response = await withTimeout(
        (client.responses as any).create({
          model: config.model,
          instructions: systemContent,
          input: request.prompt,
          tools: responsesTools,
          max_output_tokens: 16384,
          store: true,
        }, { signal: controller1.signal }),
        300_000
      );
    } finally {
      clearTimeout(abortTimer1);
    }

    totalTokensIn += response.usage?.input_tokens ?? 0;
    totalTokensOut += response.usage?.output_tokens ?? 0;
    previousResponseId = response.id;

    // Tool loop
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const functionCalls = (response.output ?? []).filter(
        (item: any) => item.type === 'function_call'
      );

      if (functionCalls.length === 0) {
        const output = response.output_text ?? '';
        return {
          output,
          tokensIn: totalTokensIn,
          tokensOut: totalTokensOut,
          finishReason: response.status ?? 'unknown',
          toolRounds,
        };
      }

      toolRounds++;

      const toolOutputs: Array<{ type: string; call_id: string; output: string }> = [];

      for (const fc of functionCalls) {
        const toolName = fc.name;
        let toolArgs: Record<string, string>;
        try {
          toolArgs = typeof fc.arguments === 'string' ? JSON.parse(fc.arguments) : fc.arguments;
        } catch {
          toolArgs = {};
        }

        console.log(`│ 🔧 Tool: ${toolName}(${Object.values(toolArgs).join(', ').slice(0, 80)})`);

        const toolResult = await executeTool(projectDir, {
          name: toolName as any,
          arguments: toolArgs,
        });

        const resultContent = toolResult.success ? toolResult.output : `Error: ${toolResult.error}`;
        toolContextChars += resultContent.length;

        const resultPreview = toolResult.output.length > 200
          ? `${toolResult.output.slice(0, 200)}...`
          : toolResult.output;
        console.log(`│    → ${toolResult.success ? resultPreview.split('\n')[0] : `Error: ${toolResult.error}`}`);

        toolOutputs.push({
          type: 'function_call_output',
          call_id: fc.call_id,
          output: resultContent,
        });
      }

      // Check token budget
      const budgetExhausted = toolContextChars >= MAX_TOOL_CONTEXT_CHARS;
      if (budgetExhausted) {
        console.log(`│ 📊 Tool context budget reached (${Math.round(toolContextChars / 1000)}K chars). Forcing final output.`);
      }

      const controllerN = new AbortController();
      const abortTimerN = setTimeout(() => controllerN.abort(), 300_000);

      try {
        // When budget is exhausted: send tool results back (required by API)
        // but omit `tools` so the model can only produce text output.
        // Also inject a text instruction to stop exploring.
        const inputPayload: any[] = [...toolOutputs];
        if (budgetExhausted) {
          inputPayload.push({
            role: 'user',
            content: 'You have gathered enough context from the codebase. Stop exploring and produce your final code output now. Do not attempt any more tool calls.',
          });
        }

        response = await withTimeout(
          (client.responses as any).create({
            model: config.model,
            previous_response_id: previousResponseId,
            input: inputPayload,
            ...(budgetExhausted ? {} : { tools: responsesTools }),
            max_output_tokens: 16384,
            store: true,
          }, { signal: controllerN.signal }),
          300_000
        );
      } finally {
        clearTimeout(abortTimerN);
      }

      totalTokensIn += response.usage?.input_tokens ?? 0;
      totalTokensOut += response.usage?.output_tokens ?? 0;
      previousResponseId = response.id;

      // If budget was exhausted, this response should be the final text
      if (budgetExhausted) {
        const output = response.output_text ?? '';
        return {
          output,
          tokensIn: totalTokensIn,
          tokensOut: totalTokensOut,
          finishReason: 'budget_exhausted',
          toolRounds,
        };
      }
    }

    const output = response.output_text ?? '';
    return {
      output,
      tokensIn: totalTokensIn,
      tokensOut: totalTokensOut,
      finishReason: 'tool_loop_exhausted',
      toolRounds,
    };
  }

  async function executeOnce(request: AgentRequest): Promise<AgentResponse> {
      const start: number = Date.now();
      const promptPreview = request.prompt.length > 500
        ? `${request.prompt.slice(0, 500)}... [${request.prompt.length} chars total]`
        : request.prompt;
      console.log(`\n🔍 Request Details: ${JSON.stringify({ ...request, prompt: promptPreview, context: request.context ? `[${request.context.length} chars]` : undefined }, null, 2)}`);

      try {
        const useTools = request.enableTools && !!request.projectDir;
        const apiMode = isResponses ? 'Responses' : 'ChatCompletions';
        const toolLabel = useTools ? ' + Tools' : '';

        console.log('\n┌─────────────────────────────────────────');
        console.log(`│ 🤖 OpenAI (${config.model}) — ${apiMode}${toolLabel}`);
        console.log('├─────────────────────────────────────────');

        const systemContent: string = request.context
          ? `You are an expert software engineer. Follow all instructions precisely.\n\nContext:\n${request.context}`
          : 'You are an expert software engineer. Follow all instructions precisely. Return only the requested output — no preamble, no explanation unless asked.';

        let output: string;
        let tokensIn: number | string = '?';
        let tokensOut: number | string = '?';
        let finishReason: string = 'unknown';
        let toolRounds = 0;

        // --- Agentic tool-use path ---
        if (useTools) {
          const toolSystem = systemContent + `\n\nYou have access to codebase tools (search_codebase, read_file, list_directory). Use them to explore the project BEFORE writing code.

**Be surgical.** Typically 2-5 tool calls is sufficient:
1. Search for the most relevant pattern or function name first.
2. Read 1-2 key files to understand the existing conventions.
3. If needed, list a directory to find the right file paths.
4. Then produce your final code output.

Do NOT exhaustively read every file in a directory. Focus on the files most relevant to your task. Once you have enough context, stop exploring and write your code.`;

          if (isResponses) {
            const result = await executeWithToolsResponses(request, toolSystem);
            output = result.output;
            tokensIn = result.tokensIn;
            tokensOut = result.tokensOut;
            finishReason = result.finishReason;
            toolRounds = result.toolRounds;
          } else {
            const result = await executeWithToolsChat(request, toolSystem);
            output = result.output;
            tokensIn = result.tokensIn;
            tokensOut = result.tokensOut;
            finishReason = result.finishReason;
            toolRounds = result.toolRounds;
          }
        }
        // --- Standard single-shot path ---
        else if (isResponses) {
          const controller = new AbortController();
          const abortTimer = setTimeout(() => controller.abort(), 300_000);
          try {
            const response: any = await withTimeout(
              (client.responses as any).create({
                model: config.model,
                instructions: systemContent,
                input: request.prompt,
                max_output_tokens: 16384,
                store: false,
              }, { signal: controller.signal }),
              300_000
            );

            output = response.output_text ?? '';
            tokensIn = response.usage?.input_tokens ?? '?';
            tokensOut = response.usage?.output_tokens ?? '?';
            finishReason = response.status ?? 'unknown';
          } finally {
            clearTimeout(abortTimer);
          }
        } else {
          const controller = new AbortController();
          const abortTimer = setTimeout(() => controller.abort(), 180_000);
          try {
            const completion = await withTimeout(
              client.chat.completions.create({
                model: config.model,
                messages: [
                  { role: 'system', content: systemContent },
                  { role: 'user', content: request.prompt },
                ],
                max_tokens: 16384,
              }, { signal: controller.signal }),
              180_000
            );

            if (!completion || !Array.isArray(completion.choices) || completion.choices.length === 0) {
              console.error(`│ 🔍 Malformed: missing completion structure (hasCompletion=${!!completion}, choicesLength=${completion?.choices?.length})`);
              throw new Error('Malformed response from OpenAI service');
            }

            const chatMessage = completion.choices[0].message;
            if (!chatMessage?.content) {
              console.error(`│ 🔍 Malformed: empty content (finish_reason=${completion.choices[0].finish_reason}, role=${chatMessage?.role}, hasToolCalls=${!!chatMessage?.tool_calls})`);
              throw new Error('Malformed response from OpenAI service');
            }

            output = chatMessage.content ?? '';
            tokensIn = completion.usage?.prompt_tokens ?? '?';
            tokensOut = completion.usage?.completion_tokens ?? '?';
            finishReason = completion.choices[0]?.finish_reason ?? 'unknown';
          } finally {
            clearTimeout(abortTimer);
          }
        }

        if (!output) {
          throw new Error('Malformed response from OpenAI service');
        }

        const durationMs: number = Date.now() - start;

        if (request.outputPath) {
          await mkdir(dirname(request.outputPath), { recursive: true });
          await writeFile(request.outputPath, output, 'utf-8');
          console.log(`│ 📄 Output written to: ${request.outputPath}`);
        }

        logResponseBlock(output, durationMs, tokensIn, tokensOut, finishReason, toolRounds);

        return {
          success: true,
          output,
          durationMs,
        };
      } catch (err: unknown) {
        const durationMs: number = Date.now() - start;
        const errorMessage: string = generateErrorMessage(err);

        console.log(`\n❌ Error Details: ${err instanceof Error ? err.stack : String(err)}`);
        console.log(`│ ❌ Error: ${errorMessage}`);
        console.log('└─────────────────────────────────────────\n');

        return {
          success: false,
          error: errorMessage,
          durationMs,
        };
      }
  }

  return {
    name: adapterName,

    async execute(request: AgentRequest): Promise<AgentResponse> {
      for (let attempt = 0; attempt <= MAX_ADAPTER_RETRIES; attempt++) {
        const result = await executeOnce(request);

        if (result.success) return result;

        const retryable = RETRYABLE_PATTERNS.some(p => (result.error ?? '').includes(p));
        if (!retryable || attempt === MAX_ADAPTER_RETRIES) return result;

        const delayMs = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
        console.log(`\n⚠️  Retryable error on attempt ${attempt + 1}: ${result.error}`);
        console.log(`   Retrying in ${delayMs / 1000}s... (${attempt + 2}/${MAX_ADAPTER_RETRIES + 1})\n`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }

      return { success: false, error: 'Max retries exceeded', durationMs: 0 };
    },
  };
}
