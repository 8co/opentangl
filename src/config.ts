/**
 * Configuration
 * Loads environment variables and provides typed config access
 */

import { config as loadEnv } from 'dotenv';
import type { AgentType } from './types.js';

loadEnv();

export interface Config {
  anthropic: {
    apiKey: string;
    model: string;
  };
  openai: {
    apiKey: string;
    model: string;
  };
  defaultAgent: AgentType;
}

export function loadConfig(): Config {
  return {
    anthropic: {
      apiKey: process.env.ANTHROPIC_API_KEY ?? '',
      model: process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-20250514',
    },
    openai: {
      apiKey: process.env.OPENAI_API_KEY ?? '',
      model: process.env.OPENAI_MODEL ?? 'gpt-4o',
    },
    defaultAgent: (process.env.DEFAULT_AGENT as AgentType) ?? 'anthropic',
  };
}

export function validateConfig(config: Config, agent: AgentType): void {
  if (agent === 'anthropic' && !config.anthropic.apiKey) {
    throw new Error('ANTHROPIC_API_KEY is required. Copy .env.example to .env and set your key.');
  }
  if ((agent === 'codex' || agent === 'openai') && !config.openai.apiKey) {
    throw new Error('OPENAI_API_KEY is required. Copy .env.example to .env and set your key.');
  }
}

