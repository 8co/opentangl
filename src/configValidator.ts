import type { Config } from './config.js';
import type { AgentType } from './types.js';

export class ConfigValidator {
  public static validate(config: Config, agent: AgentType): void {
    ConfigValidator.validateApiKey(config, agent);
  }

  private static validateApiKey(config: Config, agent: AgentType): void {
    if (agent === 'anthropic' && !config.anthropic.apiKey) {
      throw new Error('ANTHROPIC_API_KEY is required. Copy .env.example to .env and set your key.');
    }
    if ((agent === 'codex' || agent === 'openai') && !config.openai.apiKey) {
      throw new Error('OPENAI_API_KEY is required. Copy .env.example to .env and set your key.');
    }
  }
}
