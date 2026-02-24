import { createOpenAIAdapter } from '../../src/adapters/openai-adapter.js';
import assert from 'node:assert';
import test from 'node:test';
import type { AgentRequest, AgentResponse } from '../../src/types.js';

interface MockOpenAI {
  chat: {
    completions: {
      create: Function;
    };
  };
}

const mockClient: MockOpenAI = {
  chat: {
    completions: {
      create: async () => ({
        choices: [{
          message: {
            content: "Mocked response",
          },
        }],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 10,
          total_tokens: 20,
        },
      }),
    },
  },
};

const mockClientTimeout: MockOpenAI = {
  chat: {
    completions: {
      create: () => new Promise((_resolve, reject) => {
        setTimeout(() => reject(new Error('timeout')), 31_000);
      }),
    },
  },
};

test('createOpenAIAdapter - Valid Execution Path', async () => {
  const adapter = createOpenAIAdapter({ apiKey: 'validApiKey', model: 'gpt-3.5-turbo' });
  adapter.client = mockClient; // Override with mock client

  const request: AgentRequest = { prompt: 'Hello AI' };
  const response: AgentResponse = await adapter.execute(request);

  assert.strictEqual(response.success, true);
  assert.strictEqual(response.output, 'Mocked response');
  assert.strictEqual(response.error, undefined);
});

test('createOpenAIAdapter - Timeout Scenario', async () => {
  const adapter = createOpenAIAdapter({ apiKey: 'validApiKey', model: 'gpt-3.5-turbo' });
  adapter.client = mockClientTimeout; // Override with client that times out

  const request: AgentRequest = { prompt: 'Hello AI' };
  const response: AgentResponse = await adapter.execute(request);

  assert.strictEqual(response.success, false);
  assert.match(response.error || '', /Request timed out/);
});

test('createOpenAIAdapter - Unauthorized Access', async () => {
  const unauthorizedClient: MockOpenAI = {
    chat: {
      completions: {
        create: async () => {
          throw new Error('401');
        },
      },
    },
  };

  const adapter = createOpenAIAdapter({ apiKey: 'invalidApiKey', model: 'gpt-3.5-turbo' });
  adapter.client = unauthorizedClient; // Override with unauthorized client

  const request: AgentRequest = { prompt: 'Hello AI' };
  const response: AgentResponse = await adapter.execute(request);

  assert.strictEqual(response.success, false);
  assert.match(response.error || '', /Unauthorized: Invalid API key or permissions issue/);
});
