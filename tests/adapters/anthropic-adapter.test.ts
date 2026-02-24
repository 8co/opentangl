import { strict as assert } from 'node:assert';
import test from 'node:test';
import { createAnthropicAdapter } from '../../src/adapters/anthropic-adapter.js';
import type { AgentRequest, AgentResponse } from '../../src/types.js';

// Mocking dependent modules
import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';

// Mock functions
fs.writeFile = async () => {};
fs.mkdir = async () => {};

class MockAnthropic {
  apiKey: string;
  constructor({ apiKey }: { apiKey: string }) {
    this.apiKey = apiKey;
  }

  messages = {
    create: async ({ model, max_tokens, system, messages }: { model: string, max_tokens: number, system: string, messages: Array<{ role: string, content: string }> }) => {
      // Simulated response for testing
      return {
        content: [{ type: 'text', text: 'Response text' }],
        usage: {
          input_tokens: 10,
          output_tokens: 20
        },
        stop_reason: 'end'
      };
    }
  };
}

// Overriding the actual module with the mock
(Anthropic as unknown as { default: typeof MockAnthropic }).default = MockAnthropic;

test('createAnthropicAdapter', async (t) => {
  await t.test('should execute successfully with correct parameters', async () => {
    const config = { apiKey: 'fake-api-key', model: 'claude-v1' };
    const adapter = createAnthropicAdapter(config);

    const request: AgentRequest = {
      prompt: 'What is the weather today?',
      context: '',
      outputPath: '', // No file output
    };

    const response: AgentResponse = await adapter.execute(request);

    assert.equal(response.success, true);
    assert.match(response.output, /Response text/);
  });

  await t.test('should handle API limitation error', async () => {
    class MockRateLimit extends MockAnthropic {
      messages = {
        create: async () => {
          const error = new Error('API limit error');
          (error as any).response = { status: 429 };
          throw error;
        }
      };
    }

    (Anthropic as unknown as { default: typeof MockRateLimit }).default = MockRateLimit;

    const config = { apiKey: 'fake-api-key', model: 'claude-v1' };
    const adapter = createAnthropicAdapter(config);

    const request: AgentRequest = {
      prompt: 'What is the weather today?',
      context: '',
      outputPath: '',
    };

    const response: AgentResponse = await adapter.execute(request);

    assert.equal(response.success, false);
    assert.match(response.error, /API limit reached/);
  });

  await t.test('should handle timeout error', async () => {
    class MockTimeout extends MockAnthropic {
      messages = {
        create: async () => {
          throw new Error('Request timed out');
        }
      };
    }

    (Anthropic as unknown as { default: typeof MockTimeout }).default = MockTimeout;

    const config = { apiKey: 'fake-api-key', model: 'claude-v1' };
    const adapter = createAnthropicAdapter(config);

    const request: AgentRequest = {
      prompt: 'What is the weather today?',
      context: '',
      outputPath: '',
    };

    const response: AgentResponse = await adapter.execute(request);

    assert.equal(response.success, false);
    assert.match(response.error, /Request timed out/);
  });
});
