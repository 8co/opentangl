import { promises as fs } from 'node:fs';
import { join } from 'node:path';

export interface TaskCost {
  taskId: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  cost: number;
  timestamp: string;
}

export const MODEL_PRICING: Record<string, { inputPer1k: number, outputPer1k: number }> = {
  'gpt-4o': { inputPer1k: 0.0025, outputPer1k: 0.01 },
  'gpt-4o-mini': { inputPer1k: 0.00015, outputPer1k: 0.0006 },
  'claude-sonnet-4-20250514': { inputPer1k: 0.003, outputPer1k: 0.015 },
  'claude-haiku': { inputPer1k: 0.00025, outputPer1k: 0.00125 },
};

export function calculateCost(model: string, tokensIn: number, tokensOut: number): number {
  const pricing = MODEL_PRICING[model];
  if (!pricing) return 0;
  
  const inputCost = (tokensIn / 1000) * pricing.inputPer1k;
  const outputCost = (tokensOut / 1000) * pricing.outputPer1k;
  return inputCost + outputCost;
}

const taskCostsFilePath = join(process.cwd(), 'task-costs.jsonl');

export async function trackTaskCost(cost: TaskCost): Promise<void> {
  const costEntry = JSON.stringify(cost);
  await fs.appendFile(taskCostsFilePath, costEntry + '\n', 'utf-8');
}

export async function getSpendingSummary(): Promise<{ totalCost: number, costByModel: Record<string, number>, taskCount: number }> {
  try {
    const data = await fs.readFile(taskCostsFilePath, 'utf-8');
    const lines = data.trim().split('\n');
    const costByModel: Record<string, number> = {};
    let totalCost = 0;

    lines.forEach(line => {
      const cost: TaskCost = JSON.parse(line);
      totalCost += cost.cost;
      if (!costByModel[cost.model]) {
        costByModel[cost.model] = 0;
      }
      costByModel[cost.model] += cost.cost;
    });

    return { totalCost, costByModel, taskCount: lines.length };
  } catch {
    return { totalCost: 0, costByModel: {}, taskCount: 0 };
  }
}
