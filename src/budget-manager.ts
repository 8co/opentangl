import { promises as fs } from 'node:fs';
import { join } from 'node:path';

interface BudgetConfig {
  modelPricing: Record<string, number>;
  dailyLimit: number;
}

const budgetConfig: BudgetConfig = {
  modelPricing: {
    'gpt-4o': 0.0025,
    'claude': 0.003,
  },
  dailyLimit: 100, // Assuming daily limit in USD
};

let dailySpending: number = 0;
const spendFilePath = join(process.cwd(), 'daily-spending.json');

export async function trackCost(tokens: { input: number; output: number }, model: string): Promise<void> {
  const pricing = budgetConfig.modelPricing[model];
  if (pricing === undefined) throw new Error(`Model ${model} pricing not configured.`);
  
  const cost = (tokens.input + tokens.output) / 1000 * pricing;
  dailySpending += cost;

  await saveDailySpending();
}

export function getRemainingBudget(): number {
  return Math.max(0, budgetConfig.dailyLimit - dailySpending);
}

export function checkBudgetLimit(): boolean {
  return getRemainingBudget() > 0;
}

export async function resetDailyBudget(): Promise<void> {
  dailySpending = 0;
  await saveDailySpending();
}

async function saveDailySpending(): Promise<void> {
  const spendingData = { date: new Date().toISOString().split('T')[0], spending: dailySpending };
  await fs.writeFile(spendFilePath, JSON.stringify(spendingData), 'utf-8');
}

async function loadDailySpending(): Promise<void> {
  try {
    const data = await fs.readFile(spendFilePath, 'utf-8');
    const { date, spending } = JSON.parse(data);

    if (date === new Date().toISOString().split('T')[0]) {
      dailySpending = spending;
    } else {
      await resetDailyBudget();
    }
  } catch {
    await resetDailyBudget();
  }
}

// Initialize daily spending on module load
loadDailySpending().catch(err => console.error(`Failed to load daily spending: ${err.message}`));
