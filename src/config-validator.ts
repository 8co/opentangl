import type { AgentType } from './types.js';

interface ValidationResult {
  valid: boolean;
  missing: string[];
  warnings: string[];
  errors: string[];
}

export function validateEnvConfig(): ValidationResult {
  const missing: string[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];

  try {
    const anthropicApiKey: string | undefined = process.env.ANTHROPIC_API_KEY as string | undefined;
    const openaiApiKey: string | undefined = process.env.OPENAI_API_KEY as string | undefined;
    const defaultAgent: AgentType | undefined = process.env.DEFAULT_AGENT as AgentType | undefined;

    if (!anthropicApiKey) {
      missing.push('ANTHROPIC_API_KEY');
    }

    if (!openaiApiKey) {
      missing.push('OPENAI_API_KEY');
    }

    if (defaultAgent) {
      if (defaultAgent === 'anthropic' && !anthropicApiKey) {
        warnings.push('DEFAULT_AGENT is set to "anthropic" but ANTHROPIC_API_KEY is missing.');
      } else if ((defaultAgent === 'codex' || defaultAgent === 'openai') && !openaiApiKey) {
        warnings.push(`DEFAULT_AGENT is set to "${defaultAgent}" but OPENAI_API_KEY is missing.`);
      } else if (defaultAgent !== 'anthropic' && defaultAgent !== 'codex' && defaultAgent !== 'openai') {
        errors.push(`DEFAULT_AGENT is set to an unrecognized value: "${defaultAgent}".`);
      }
    }
  } catch (e: unknown) {
    const error: string = e instanceof Error ? e.message : 'Unknown error';
    errors.push(`An error occurred during validation: ${error}`);
  }

  const valid: boolean = missing.length === 0 && errors.length === 0;
  return { valid, missing, warnings, errors };
}
